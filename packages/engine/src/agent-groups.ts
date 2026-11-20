import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, inArray, isNotNull, isNull, schema, sql } from "@agenteschat/db";
import { listsAgentSql, listsAllAgents, managesAgent, REACH_COLUMNS } from "./audience";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import { getMembership, type Membership, requirePermission } from "./organizations";
import { ROLE_COLORS, ROLE_ICONS } from "./permissions";
import { forgetTeam } from "./team";

const { agentGroups, agents } = schema;

/**
 * A group of agents as every app reads it (ADR 0083): the groups in the workspace's order, each with its agents in
 * theirs. Shown as a setor (ADR 0148): its mark, who leads it and who covers for them.
 */
export interface AgentGroupView {
  id: string;
  name: string;
  agentIds: string[];
  color: string;
  icon: string;
  leadUserId: string | null;
  backupUserId: string | null;
}

/** What a group's look and people may change to; null clears a person. */
export interface AgentGroupPatch {
  name?: string;
  index?: number;
  color?: string;
  icon?: string;
  leadUserId?: string | null;
  backupUserId?: string | null;
}

export interface AgentGroupDeps {
  db: Database;
  pubsub?: PubSub;
}

const MAX_GROUPS = 50;

const groupNotFound = () => new NotFoundError("Group not found", "agent_group.not_found");

const cleanName = (name: string) => {
  const n = name.trim().slice(0, 80);
  if (!n) throw new ValidationError("name is required");
  return n;
};

/** `item` at `index` among `others` (clamped to the ends). */
const placeAt = <T>(others: T[], item: T, index: number) => {
  const at = Math.max(0, Math.min(others.length, Math.trunc(index)));
  return [...others.slice(0, at), item, ...others.slice(at)];
};

const groupRows = (db: Executor, orgId: string) =>
  db
    .select()
    .from(agentGroups)
    .where(eq(agentGroups.orgId, orgId))
    .orderBy(asc(agentGroups.position), asc(agentGroups.createdAt));

/** The workspace's groups with their agents (archived ones left out). No permission check. */
export async function agentGroupViews(db: Executor, orgId: string): Promise<AgentGroupView[]> {
  const groups = await groupRows(db, orgId);
  const members = await db
    .select({ id: agents.id, groupId: agents.groupId })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNotNull(agents.groupId), isNull(agents.archivedAt)))
    .orderBy(asc(agents.groupPosition), asc(agents.createdAt));
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    agentIds: members.filter((m) => m.groupId === g.id).map((m) => m.id),
    color: g.color,
    icon: g.icon,
    leadUserId: g.leadUserId,
    backupUserId: g.backupUserId,
  }));
}

/**
 * Tells every open app of the workspace to read the groups again (an org broadcast), and gives them as they are now to
 * `userId` (`listAgentGroups`). The event carries no list: it grows with the agents, and Postgres NOTIFY refuses
 * payloads near 8000 bytes.
 */
async function announce(deps: AgentGroupDeps, userId: string, orgId: string) {
  // Team rows carry their department's name (`loadTeam`): a move or a rename changes them too.
  forgetTeam(orgId);
  await publishOrgEvent(deps.pubsub, { type: "org.broadcast", orgId, event: { type: "agent.groups" } });
  return listAgentGroups(deps.db, userId, orgId);
}

/**
 * `ids`, each an agent here not archived and one `by` manages (`managesAgent`, ADR 0085 addendum of 2026-11-17): who
 * merely holds "Editar qualquer agente" doesn't arrange a private agent.
 */
async function requireAgents(
  db: Executor,
  orgId: string,
  ids: string[],
  by: { userId: string; membership: Membership },
) {
  const found = await db
    .select({ id: agents.id, ...REACH_COLUMNS })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), inArray(agents.id, ids), isNull(agents.archivedAt)));
  if (found.length !== ids.length) throw new NotFoundError("Agent not found");
  if (found.some((a) => !managesAgent(a, by.userId, by.membership))) throw new ForbiddenError();
}

const oneOf = (list: readonly string[], value: string, what: string) => {
  if (!list.includes(value)) throw new ValidationError(`Unknown ${what}`, `agent_group.bad_${what}`);
  return value;
};

/** The color, icon and people a patch sets, checked: a person must be in the workspace. */
async function lookOf(db: Executor, orgId: string, patch: AgentGroupPatch) {
  const set: Partial<typeof agentGroups.$inferInsert> = {};
  if (patch.color !== undefined) set.color = oneOf(ROLE_COLORS, patch.color, "color");
  if (patch.icon !== undefined) set.icon = oneOf(ROLE_ICONS, patch.icon, "icon");
  for (const key of ["leadUserId", "backupUserId"] as const) {
    const id = patch[key];
    if (id === undefined) continue;
    if (id !== null && !(await getMembership(db, id, orgId)))
      throw new ValidationError("That person isn't in the workspace", "agent_group.not_member");
    set[key] = id;
  }
  return set;
}

/** `ids` in this order inside `groupId` (null: in no group). */
async function placeAgents(tx: Executor, orgId: string, groupId: string | null, ids: string[]) {
  for (const [i, id] of ids.entries()) {
    await tx
      .update(agents)
      .set({ groupId, groupPosition: i })
      .where(and(eq(agents.id, id), eq(agents.orgId, orgId)));
  }
}

/**
 * Anyone in the workspace reads them, with only the agents their lists name (`listsAgentSql`). Who doesn't list every
 * agent (`listsAllAgents`) gets no group left without one: they don't arrange the groups. Who does keeps the empty
 * ones, but not one that only private agents (`isPrivateAgent`) filled.
 */
export async function listAgentGroups(db: Database, userId: string, orgId: string): Promise<AgentGroupView[]> {
  const membership = await requirePermission(db, userId, orgId, "read");
  const [groups, rows] = await Promise.all([
    agentGroupViews(db, orgId),
    db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.orgId, orgId),
          isNull(agents.archivedAt),
          listsAgentSql("agents", sql`${userId}::text`, membership),
        ),
      ),
  ]);
  const listed = new Set(rows.map((r) => r.id));
  const all = listsAllAgents(membership);
  return groups
    .map((g) => ({ ...g, agentIds: g.agentIds.filter((id) => listed.has(id)) }))
    .filter((g, i) => g.agentIds.length > 0 || (all && groups[i]?.agentIds.length === 0));
}

/**
 * Adds a group after the others, with `agentIds` in it in that order (out of any group they were in). Owners and
 * admins, with agents they manage (`requireAgents`). An import brings its sections of agents in through this too, one
 * call per section.
 */
export async function createAgentGroup(
  deps: AgentGroupDeps,
  userId: string,
  orgId: string,
  input: { name: string; agentIds?: string[]; color?: string; icon?: string },
): Promise<AgentGroupView[]> {
  const membership = await requirePermission(deps.db, userId, orgId, "manage_agents");
  const name = cleanName(input.name);
  const ids = [...new Set(input.agentIds ?? [])];
  const look = await lookOf(deps.db, orgId, { color: input.color, icon: input.icon });
  await deps.db.transaction(async (tx) => {
    const groups = await groupRows(tx, orgId);
    if (groups.length >= MAX_GROUPS) {
      throw new ValidationError(`A workspace holds at most ${MAX_GROUPS} groups`, "agent_group.too_many", {
        max: MAX_GROUPS,
      });
    }
    if (ids.length) await requireAgents(tx, orgId, ids, { userId, membership });
    const [group] = await tx
      .insert(agentGroups)
      .values({ orgId, name, position: (groups.at(-1)?.position ?? -1) + 1, ...look })
      .returning({ id: agentGroups.id });
    if (group) await placeAgents(tx, orgId, group.id, ids);
  });
  return announce(deps, userId, orgId);
}

/**
 * Renames a group, moves it among the groups (`index`: its place among the others), or changes its color, icon, lead
 * or substitute. Owners and admins.
 */
export async function updateAgentGroup(
  deps: AgentGroupDeps,
  userId: string,
  orgId: string,
  groupId: string,
  patch: AgentGroupPatch,
): Promise<AgentGroupView[]> {
  await requirePermission(deps.db, userId, orgId, "manage_agents");
  const groups = await groupRows(deps.db, orgId);
  const group = groups.find((g) => g.id === groupId);
  if (!group) throw groupNotFound();
  const name = patch.name === undefined ? undefined : cleanName(patch.name);
  const set = { ...(await lookOf(deps.db, orgId, patch)), ...(name === undefined ? {} : { name }) };
  const index = patch.index;
  await deps.db.transaction(async (tx) => {
    if (Object.keys(set).length > 0) await tx.update(agentGroups).set(set).where(eq(agentGroups.id, group.id));
    if (index === undefined) return;
    const order = placeAt(
      groups.filter((g) => g.id !== group.id),
      group,
      index,
    );
    for (const [i, g] of order.entries()) {
      if (g.position !== i) await tx.update(agentGroups).set({ position: i }).where(eq(agentGroups.id, g.id));
    }
  });
  return announce(deps, userId, orgId);
}

/**
 * Deletes a group; its agents go back to no group (the foreign key clears theirs, archived ones too). Owners and
 * admins who manage every agent in it (`managesAgent`, ADR 0085 addendum of 2026-11-17): deleting it takes each one out
 * of its department, which who merely holds `manage_agents` doesn't do to a private agent (`requireAgents`).
 */
export async function deleteAgentGroup(
  deps: AgentGroupDeps,
  userId: string,
  orgId: string,
  groupId: string,
): Promise<AgentGroupView[]> {
  const membership = await requirePermission(deps.db, userId, orgId, "manage_agents");
  await deps.db.transaction(async (tx) => {
    // Locked, so no agent joins it between the check and the delete.
    const [group] = await tx
      .select({ id: agentGroups.id })
      .from(agentGroups)
      .where(and(eq(agentGroups.id, groupId), eq(agentGroups.orgId, orgId)))
      .for("update");
    if (!group) throw groupNotFound();
    const inIt = await tx
      .select(REACH_COLUMNS)
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.groupId, group.id)));
    if (inIt.some((a) => !managesAgent(a, userId, membership)))
      throw new ForbiddenError("Only who manages every agent in a group deletes it");
    await tx.delete(agentGroups).where(eq(agentGroups.id, group.id));
  });
  return announce(deps, userId, orgId);
}

/**
 * Moves an agent into a group, at `index` among its other agents (the end without one), or out of any group
 * (`groupId` null: back with the agents in none, in the workspace's order). Who manages the agent (`requireAgents`).
 */
export async function moveAgentToGroup(
  deps: AgentGroupDeps,
  userId: string,
  orgId: string,
  agentId: string,
  input: { groupId: string | null; index?: number },
): Promise<AgentGroupView[]> {
  const membership = await requirePermission(deps.db, userId, orgId, "manage_agents");
  await requireAgents(deps.db, orgId, [agentId], { userId, membership });
  const { groupId, index } = input;
  await deps.db.transaction(async (tx) => {
    if (groupId === null) return placeAgents(tx, orgId, null, [agentId]);
    const [group] = await tx
      .select({ id: agentGroups.id })
      .from(agentGroups)
      .where(and(eq(agentGroups.id, groupId), eq(agentGroups.orgId, orgId)));
    if (!group) throw groupNotFound();
    const others = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.groupId, group.id), isNull(agents.archivedAt)))
      .orderBy(asc(agents.groupPosition), asc(agents.createdAt));
    const ids = others.map((a) => a.id).filter((id) => id !== agentId);
    await placeAgents(tx, orgId, group.id, placeAt(ids, agentId, index ?? ids.length));
  });
  return announce(deps, userId, orgId);
}
