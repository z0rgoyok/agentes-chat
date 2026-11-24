import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, isNull, type SQL, schema, sql } from "@agenteschat/db";
import { type Agent, getAgent } from "./agents";
import { replyAllowsSql } from "./ai-accounts/reply";
import { recordAudit } from "./audit";
import { isComputerBrain } from "./brains/types";
import { caches } from "./cache";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishUserEvent } from "./events";
import { can, getMembership, type Membership, requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { channelMaySql, maySql } from "./permissions";
import { dropForeignMailGrants, type ForeignMailbox, foreignMailboxes } from "./tools/scopes";

const { agents, users, organizationMembers, organizationMemberRoles, orgRoles } = schema;

/** Who can talk to an agent. */
export type AudienceMode = "everyone" | "people" | "owner";
export const AUDIENCE_MODES: readonly AudienceMode[] = ["everyone", "people", "owner"];

export interface AgentAudience {
  mode: AudienceMode;
  /**
   * For `people`; the owner can always talk to the agent. Under `owner`, the
   * people a plan kept out (ADR 0059 §5), who come back when it is let out.
   */
  userIds: string[];
  /** For `people`: whoever holds one of these roles at the time (not `everyone`); kept under `owner` like `userIds`. */
  roleIds: string[];
  /** Other agents may consult it for people outside it (ADR 0085 addendum); absent (older apps) = keep. */
  consultable?: boolean;
}

/** An audience as a save takes it: an older app sends no roles, and a change then keeps the ones picked. */
export type AudienceInput = Omit<AgentAudience, "roleIds"> & { roleIds?: string[] };

type AudienceFields = Pick<
  Agent,
  "audienceMode" | "audienceUserIds" | "audienceRoleIds" | "ownerUserId" | "ownerRoleId" | "consultable" | "brain"
>;

/** Who answers for an agent: a person, a role (whoever holds it at the time) or nobody (ADR 0085, addendum of 2026-11-21). */
export type AgentOwnerFields = Pick<Agent, "ownerUserId" | "ownerRoleId">;

/** The `agents` columns that say who answers for it (`AgentOwnerFields`), for a partial select to spread. */
export const OWNER_COLUMNS = { ownerUserId: agents.ownerUserId, ownerRoleId: agents.ownerRoleId };

/** Nobody answers for it (an agent not found, a run with no agent). */
export const NO_OWNER: AgentOwnerFields = { ownerUserId: null, ownerRoleId: null };

/** It has someone accountable: a person or a role. Without either, the admins are (`approverIds`, `keysReach`). */
export const hasOwner = (a: AgentOwnerFields) => !!a.ownerUserId || !!a.ownerRoleId;

/**
 * Whether this person answers for the agent: its owner, or holding its owner role now (ADR 0085, addendum of
 * 2026-11-21). Every "its owner may" and "its owner is asked" rule reads this. What needs one person (whose personal
 * plan thinks for it, whose name signs its commits, whose devices it reaches) reads `ownerUserId` alone, so an agent a
 * role answers for works there as one with no owner. `ownsAgentSql` is the same rule in SQL.
 */
export const ownsAgent = (a: AgentOwnerFields, userId: string | null | undefined, roleIds: readonly string[]) =>
  !!userId && (a.ownerUserId === userId || (!!a.ownerRoleId && roleIds.includes(a.ownerRoleId)));

/** `ownsAgent` in SQL, for a row aliased `alias` with `org_id`, `owner_user_id` and `owner_role_id` (an agent or an approval). */
export function ownsAgentSql(alias: string, userId: SQL): SQL<boolean> {
  const a = sql.raw(alias);
  return sql<boolean>`(${a}.owner_user_id = ${userId} or (${a}.owner_role_id is not null
    and exists (select 1 from organization_member_roles owr where owr.org_id = ${a}.org_id
      and owr.user_id = ${userId} and owr.role_id = ${a}.owner_role_id)))`;
}

/**
 * Who answers for the agent now, as member ids: its owner, or whoever holds its owner role (`ownsAgent`). Empty with
 * neither, or a role nobody holds: the callers then turn to the admins, as for an agent with no owner.
 */
export async function agentOwnerIds(db: Executor, orgId: string, a: AgentOwnerFields): Promise<string[]> {
  if (a.ownerUserId) return [a.ownerUserId];
  if (!a.ownerRoleId) return [];
  const rows = await db
    .select({ userId: organizationMemberRoles.userId })
    .from(organizationMemberRoles)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.orgId, organizationMemberRoles.orgId),
        eq(organizationMembers.userId, organizationMemberRoles.userId),
      ),
    )
    .where(and(eq(organizationMemberRoles.orgId, orgId), eq(organizationMemberRoles.roleId, a.ownerRoleId)));
  return rows.map((r) => r.userId);
}

/** The agent's owner role, by name, for what a person or a model reads ("Tecnologia"); null without one or once gone. */
export async function ownerRoleName(db: Executor, orgId: string, a: Pick<Agent, "ownerRoleId">) {
  if (!a.ownerRoleId) return null;
  const [row] = await db
    .select({ name: orgRoles.name })
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.id, a.ownerRoleId)));
  return row?.name ?? null;
}

export const OWNER_ONLY: AgentAudience = { mode: "owner", userIds: [], roleIds: [] };

/** Who the agent answers: what the gate reads, what a change starts from and what the audit records. */
export const audienceOf = (a: AudienceFields): AgentAudience => ({
  mode: a.audienceMode,
  userIds: a.audienceMode === "everyone" ? [] : a.audienceUserIds,
  roleIds: a.audienceMode === "everyone" ? [] : a.audienceRoleIds,
  consultable: a.consultable,
});

/** Whether `to` lets someone talk to the agent whom `from` didn't (its owner always can), or consult it for them. */
export function widensAudience(from: AgentAudience, to: AgentAudience, ownerUserId: string | null): boolean {
  if (to.mode === "owner" || from.mode === "everyone") return false;
  if (to.mode === "everyone" || (to.consultable && from.consultable === false)) return true;
  const people = new Set(from.mode === "people" ? from.userIds : []);
  const roles = new Set(from.mode === "people" ? from.roleIds : []);
  return to.userIds.some((id) => id !== ownerUserId && !people.has(id)) || to.roleIds.some((id) => !roles.has(id));
}

/**
 * An agent's audience changed from `before` to `after`: if someone new can talk to it, it loses the mailboxes others
 * gave it (`dropForeignMailGrants`), `actorId`'s own aside. Consultations never reach someone else's mailbox (the mail
 * tools check the person), so only people count here.
 */
export async function dropMailIfWidened(
  db: Executor,
  orgId: string,
  agentId: string,
  ownerUserId: string | null,
  before: AgentAudience,
  after: AgentAudience,
  actorId: string,
) {
  if (widensReach(before, after, ownerUserId)) await dropForeignMailGrants(db, orgId, agentId, actorId, actorId);
}

const widensReach = (before: AgentAudience, after: AgentAudience, ownerUserId: string | null) =>
  widensAudience({ ...before, consultable: true }, { ...after, consultable: true }, ownerUserId);

/**
 * The mailboxes saving `audience` would take from the agent (`dropMailIfWidened`), taking nothing: the apps ask the
 * person first. Empty when it lets nobody new in, or every mailbox it holds is the actor's own.
 */
export async function audienceMailLoss(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  audience: AudienceInput,
): Promise<ForeignMailbox[]> {
  const agent = await audienceEditable(db, actorId, orgId, agentId);
  const people = audience.mode === "people";
  const to: AgentAudience = {
    mode: audience.mode,
    userIds: people ? audience.userIds : [],
    roleIds: people ? (audience.roleIds ?? agent.audienceRoleIds) : [],
  };
  if (!widensReach(audienceOf(agent), to, agent.ownerUserId)) return [];
  return foreignMailboxes(db, orgId, agentId, actorId);
}

/**
 * What a save of who talks to the agent, or who edits it, reads of it (never its instructions), when `actorId` may make
 * it (`ownsOrManagesAgent`). `checked`: the caller already decided that against the agent as it was (`editAgent`,
 * `createAgent`), and a part saved before this one in the same change may have taken them out of its reach.
 */
async function audienceEditable(db: Database, actorId: string, orgId: string, agentId: string, checked = false) {
  const membership = checked ? null : await requirePermission(db, actorId, orgId, "read");
  const [agent] = await db
    .select({ archivedAt: agents.archivedAt, builtin: agents.builtin, ...ACCESS_COLUMNS })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.deletedAt)));
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  if (!checked && !ownsOrManagesAgent(agent, actorId, membership)) {
    throw new ForbiddenError("Only the agent's owner or an admin can change who talks to it");
  }
  return agent;
}

/** The agents `added` roles newly let `userId` talk to: their audience lists one, and `rolesBefore` didn't let them. */
async function agentsOpenedBy(
  db: Executor,
  orgId: string,
  userId: string,
  rolesBefore: readonly string[],
  added: readonly string[],
) {
  if (added.length === 0) return [];
  const rows = await db
    .select({ id: agents.id, name: agents.name, ...REACH_COLUMNS })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.audienceMode, "people")));
  const speaker: Speaker = { talks: true, roleIds: [...rolesBefore] };
  return rows.filter((a) => a.audienceRoleIds.some((id) => added.includes(id)) && !canTalkTo(a, userId, speaker));
}

/**
 * `userId` now holds `added` roles: every agent those roles newly let them talk to loses the mailboxes others gave it
 * (theirs aside), as if its audience had widened to them. A mailbox's owner gave it for the people it answered then.
 */
export async function dropMailForNewRoleMember(
  db: Executor,
  orgId: string,
  userId: string,
  rolesBefore: readonly string[],
  added: readonly string[],
  actorId: string,
) {
  for (const agent of await agentsOpenedBy(db, orgId, userId, rolesBefore, added))
    await dropForeignMailGrants(db, orgId, agent.id, userId, actorId);
}

/** A mailbox an agent would lose (`ForeignMailbox`), with the agent. */
export type AgentMailLoss = ForeignMailbox & { agentId: string; agentName: string };

/** What `dropMailForNewRoleMember` would take, taking nothing: the apps ask the person first. */
export async function newRoleMemberMailLoss(
  db: Executor,
  orgId: string,
  userId: string,
  rolesBefore: readonly string[],
  added: readonly string[],
): Promise<AgentMailLoss[]> {
  const out: AgentMailLoss[] = [];
  for (const agent of await agentsOpenedBy(db, orgId, userId, rolesBefore, added))
    for (const m of await foreignMailboxes(db, orgId, agent.id, userId))
      out.push({ ...m, agentId: agent.id, agentName: agent.name });
  return out;
}

/** Someone besides its owner can talk to the agent. */
export const answersOthers = (a: AgentAudience, ownerUserId: string | null) =>
  widensAudience(OWNER_ONLY, a, ownerUserId);

/** What the audience rule needs of a person: whether their roles let them talk to agents, and which roles they hold. */
export interface Speaker {
  talks: boolean;
  roleIds: readonly string[];
  /**
   * Another agent asks for them (ask_agent, tell_agent, a mention or a hand-off between agents): an agent that
   * takes consultations answers it even outside its audience (`consultable`, ADR 0085 addendum).
   */
  viaAgent?: true;
  /** An owner or administrator of the workspace (`findsAgent`). */
  admin?: boolean;
}

/** No person (a routine's run): talks, holds no role. */
export const NO_PERSON: Speaker = { talks: true, roleIds: [] };

export const speakerOf = (membership: Pick<Membership, "permissions" | "roleIds"> | null): Speaker => ({
  talks: can(membership, "talk_to_agents"),
  roleIds: membership?.roleIds ?? [],
  admin: can(membership, "administrator"),
});

/** The same person, as another agent asking for them. */
export const viaAgent = (s: Speaker): Speaker => ({ ...s, viaAgent: true });

/**
 * Whether other agents may consult it for people outside its audience: its switch, unless it thinks with a plan
 * that answers nobody but its owner, `owner` or `people` with nobody else picked (ADR 0059 §5): answering for
 * someone else is answering others.
 */
export const takesConsultations = (a: AudienceFields) =>
  a.consultable &&
  !(isComputerBrain(a.brain) && !answersOthers({ ...audienceOf(a), consultable: false }, a.ownerUserId));

/** The `Speaker` for a person in a workspace (`NO_PERSON` for none). */
export async function speakerFor(db: Database, orgId: string, userId: string | null): Promise<Speaker> {
  return userId ? speakerOf(await getMembership(db, userId, orgId)) : NO_PERSON;
}

/**
 * Can this person's message start a run of the agent? (`null` = no person: routines and webhooks check their
 * creator.) Its owner always can; anyone else needs the agent's audience (named, or holding one of its roles now)
 * and, through their roles, to talk to agents at all (`talk_to_agents`, ADR 0085). Asked by another agent
 * (`viaAgent`) for a person, one that takes consultations is enough (with nobody behind it, nobody's reach widens). `audienceSql` is the same rule for a person (mentions
 * between agents never dispatch in SQL: their agents' DM wakes nobody, `settleReach` asks the rest by note).
 */
export function canTalkTo(a: AudienceFields, userId: string | null, person: Speaker): boolean {
  if (ownsAgent(a, userId, person.roleIds)) return true;
  if (!person.talks) return false;
  if (person.viaAgent && userId && takesConsultations(a)) return true;
  if (a.audienceMode === "everyone") return true;
  if (!userId || a.audienceMode !== "people") return false;
  return a.audienceUserIds.includes(userId) || a.audienceRoleIds.some((id) => person.roleIds.includes(id));
}

/** What the editing rules need of an agent: its audience and its "Quem pode editar". */
export type AgentAccessFields = AudienceFields & Pick<Agent, "editorUserIds" | "editorRoleIds">;

/**
 * The `agents` columns the reach rules read (`keysReach`, `managesAgent`, `canTalkTo`): a partial select spreads these
 * instead of its own copy, so a rule that starts reading another column reaches every caller at once.
 */
export const REACH_COLUMNS = {
  ownerUserId: agents.ownerUserId,
  ownerRoleId: agents.ownerRoleId,
  audienceMode: agents.audienceMode,
  audienceUserIds: agents.audienceUserIds,
  audienceRoleIds: agents.audienceRoleIds,
  consultable: agents.consultable,
  brain: agents.brain,
};

/** `REACH_COLUMNS` and the "Quem pode editar" lists: what `editsAgent`, `managesRoutinesOf` and `seesAgentDetails` read. */
export const ACCESS_COLUMNS = {
  ...REACH_COLUMNS,
  editorUserIds: agents.editorUserIds,
  editorRoleIds: agents.editorRoleIds,
};

/** A person's membership, as the agent rules read it (null: not a member). */
type Viewer = Pick<Membership, "permissions" | "roleIds"> | null | undefined;

/**
 * Whether a person's workspace keys over agents ("Editar qualquer agente", "Criar rotinas") reach this agent (ADR
 * 0085, addendum of 2026-11-17). Owners and administrators reach every agent. Anyone else reaches the agents whose
 * audience takes them (whether their roles talk to agents aside: the audience is what makes an agent private) and the
 * ones nobody is responsible for, so an agent whose person left stays someone's to look after. A private agent is out
 * of reach of who merely holds the key: only its own "Quem pode editar" lets them in.
 */
export function keysReach(a: AudienceFields, userId: string, membership: Viewer): boolean {
  if (!membership) return false;
  if (can(membership, "administrator")) return true;
  return !hasOwner(a) || canTalkTo(a, userId, { talks: true, roleIds: membership.roleIds });
}

/** "Editar qualquer agente" on this agent: `manage_agents` where it reaches (`keysReach`). */
export const managesAgent = (a: AudienceFields, userId: string, membership: Viewer) =>
  can(membership, "manage_agents") && keysReach(a, userId, membership);

/**
 * Who changes who talks to the agent, who edits it and its look: its owner or who manages it (`managesAgent`; with no
 * owner, who manages it alone). ADR 0085, addendum of 2026-11-17.
 */
export const ownsOrManagesAgent = (a: AudienceFields, userId: string, membership: Viewer) =>
  !!membership && (ownsAgent(a, userId, membership.roleIds) || managesAgent(a, userId, membership));

/** Named in the agent's "Quem pode editar": picked, or holding one of its roles now. */
export const namedEditor = (a: Pick<Agent, "editorUserIds" | "editorRoleIds">, userId: string, membership: Viewer) =>
  !!membership && (a.editorUserIds.includes(userId) || a.editorRoleIds.some((id) => membership.roleIds.includes(id)));

/**
 * Who edits how the agent works: its instructions, role, skills and routines (ADR 0085, addendum of 2026-11-17). Its
 * owner, who manages it (`managesAgent`) and the people its "Quem pode editar" names. What gives it more (its apps and
 * their levels, its budget, how much it asks, its brakes, who owns it) stays with who manages it.
 */
export const editsAgent = (a: AgentAccessFields, userId: string, membership: Viewer) =>
  !!membership &&
  (ownsAgent(a, userId, membership.roleIds) ||
    managesAgent(a, userId, membership) ||
    namedEditor(a, userId, membership));

/**
 * Whether someone besides `userId` and who manages agents may have written the agent's instructions: another owner
 * or a "Quem pode editar" entry. Such text read into a run is others' words, never a reason to act at once.
 */
export const othersEditAgent = (
  a: Pick<Agent, "ownerUserId" | "ownerRoleId" | "editorUserIds" | "editorRoleIds">,
  userId: string,
) =>
  (!!a.ownerUserId && a.ownerUserId !== userId) ||
  !!a.ownerRoleId ||
  a.editorUserIds.some((id) => id !== userId) ||
  a.editorRoleIds.length > 0;

/** Who sets up and changes the agent's routines: who edits it, and "Criar rotinas" where it reaches (`keysReach`). */
export const managesRoutinesOf = (a: AgentAccessFields, userId: string, membership: Viewer) =>
  editsAgent(a, userId, membership) || (can(membership, "manage_routines") && keysReach(a, userId, membership));

/**
 * Whether a person sees how an agent works (its instructions, tools and access, memory, usage and activity): who
 * edits it (`editsAgent`: its owner, who manages it, its "Quem pode editar") and whoever it answers. Everyone else sees
 * its public card: face, name, role, owner, where it works and who it answers.
 */
export const seesAgentDetails = (a: AgentAccessFields, userId: string, membership: Viewer) =>
  editsAgent(a, userId, membership) || canTalkTo(a, userId, speakerOf(membership ?? null));

/** What a person may do with an agent, as the apps read it beside `canTalk`. */
export const agentRights = (a: AgentAccessFields, userId: string, membership: Viewer) => ({
  canManage: managesAgent(a, userId, membership),
  canEdit: editsAgent(a, userId, membership),
  canManageRoutines: managesRoutinesOf(a, userId, membership),
});

/**
 * Whether the workspace's lists of agents (Equipe, its sectors, the counts) name every agent for this person, private
 * ones (`isPrivateAgent`) aside.
 */
export const listsAllAgents = (membership: Pick<Membership, "permissions"> | null) =>
  can(membership, "view_all_agents") || can(membership, "manage_agents");

/** It answers nobody but its owner: "private means unlisted", so only who sees how it works lists it. */
export const isPrivateAgent = (a: AudienceFields) => !answersOthers(audienceOf(a), a.ownerUserId);

/**
 * Whether those lists name the agent for this person: every agent but a private one (`isPrivateAgent`) with
 * `listsAllAgents`, and the ones whose workings they see (`seesAgentDetails`: its owner, administrators, its "Quem pode
 * editar"). It narrows lists only: the agent's public card and its messages in shared channels still show.
 * `listsAgentSql` is the same rule as SQL.
 */
export const listsAgentTo = (a: AgentAccessFields, userId: string, membership: Viewer) =>
  (listsAllAgents(membership ?? null) && !isPrivateAgent(a)) || seesAgentDetails(a, userId, membership);

/**
 * Whether a run for `person` finds the agent among its teammates (`find_agent`, "# Your team", the handles it is
 * offered): one it may ask for them (`canTalkTo` with `speaker`), and a private one (`isPrivateAgent`) only for its
 * owner, an administrator or who its "Quem pode editar" names, so a teammate's agent doesn't discover it either.
 */
export const findsAgent = (a: AgentAccessFields, person: string | null, speaker: Speaker) =>
  canTalkTo(a, person, speaker) &&
  (!isPrivateAgent(a) ||
    (!!person &&
      (ownsAgent(a, person, speaker.roleIds) ||
        speaker.admin === true ||
        a.editorUserIds.includes(person) ||
        a.editorRoleIds.some((id) => speaker.roleIds.includes(id)))));

/** The agent, for someone who sees how it works (`seesAgentDetails`); 403 `agent.details_hidden` for anyone else. */
export async function requireAgentDetails(db: Database, userId: string, orgId: string, agentId: string) {
  const membership = await requirePermission(db, userId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  if (!seesAgentDetails(agent, userId, membership)) {
    throw new ForbiddenError(`Only who talks to ${agent.name} sees how it works`, "agent.details_hidden", {
      agentName: agent.name,
    });
  }
  return agent;
}

/**
 * The agent's playbook (ADR 0120 addendum): how-tos, lessons and notes it wrote for its own work. Quiet in the chat
 * (no receipt), never a proposal for a person to confirm, its technical text only for the agent's owner and admins.
 */
export const isPlaybook = (i: { kind: string; agentId: string | null; scopeType: string; createdByKind: string }) =>
  !!i.agentId && i.scopeType === "agent" && i.createdByKind === "agent" && (i.kind === "note" || i.kind === "lesson");

/** Who reads an agent's playbook (`isPlaybook`, ADR 0120 addendum): who edits it (`editsAgent`). */
export const readsPlaybook = (a: AgentAccessFields, userId: string, membership: Viewer) =>
  editsAgent(a, userId, membership);

/** The ids of the workspace's agents whose details this person sees (`seesAgentDetails`). */
export async function agentIdsWithDetails(db: Database, userId: string, orgId: string) {
  return (await agentIdsSeen(db, userId, orgId)).details;
}

/** `agentIdsWithDetails`, plus the agents whose playbook this person reads (`readsPlaybook`). */
export async function agentIdsSeen(db: Database, userId: string, orgId: string) {
  const [membership, rows] = await Promise.all([
    getMembership(db, userId, orgId),
    db
      .select({ id: agents.id, ...ACCESS_COLUMNS })
      .from(agents)
      .where(eq(agents.orgId, orgId)),
  ]);
  return {
    details: new Set(rows.filter((a) => seesAgentDetails(a, userId, membership)).map((a) => a.id)),
    playbook: new Set(rows.filter((a) => readsPlaybook(a, userId, membership)).map((a) => a.id)),
  };
}

/**
 * The same rule in SQL, for an `agents` row aliased `alias` and a person id expression, plus the "Atender todos" of a
 * plan account it thinks with (`replyAllowsSql`, which `canTalkTo` leaves to the run's start, `replyRefusal`). An agent
 * with no owner compares to null: `coalesce` makes that a no, so `not allowed` holds for it too (the blocked person's
 * notice).
 * In a channel (`channelId`), `talk_to_agents` is the person's in that channel, with its exceptions (ADR 0134).
 */
export function audienceSql(alias: string, userId: SQL, options: { channelId?: SQL } = {}): SQL {
  const a = sql.raw(alias);
  const talks = options.channelId
    ? channelMaySql(sql`${a}.org_id`, options.channelId, userId, "talk_to_agents")
    : maySql(sql`${a}.org_id`, userId, "talk_to_agents");
  return sql`coalesce((${userId} is not null and ${ownsAgentSql(alias, userId)})
    or ((${a}.audience_mode = 'everyone'
        or (${userId} is not null and ${a}.audience_mode = 'people' and (${userId} = any(${a}.audience_user_ids)
          or exists (select 1 from organization_member_roles amr where amr.org_id = ${a}.org_id
            and amr.user_id = ${userId} and amr.role_id = any(${a}.audience_role_ids)))))
      and (${userId} is null or (${talks} and ${replyAllowsSql(alias, userId)}))), false)`;
}

/** `audienceSql` for one agent and person: who may start its runs, its plan's "Atender todos" included. */
export async function reachesAgent(db: Executor, orgId: string, agentId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ ok: audienceSql("agents", sql`${userId}::text`) })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
  return row?.ok === true;
}

/**
 * `keysReach` in SQL, for an `agents` row aliased `alias` and a person id expression: an owner or administrator of the
 * workspace, an agent with no owner, or one whose audience takes the person (whether they talk to agents aside).
 */
export function keysReachSql(alias: string, userId: SQL): SQL<boolean> {
  const a = sql.raw(alias);
  return sql<boolean>`(${maySql(sql`${a}.org_id`, userId, "administrator")}
    or (${a}.owner_user_id is null and ${a}.owner_role_id is null) or ${ownsAgentSql(alias, userId)}
    or ${a}.audience_mode = 'everyone'
    or (${a}.audience_mode = 'people' and (${userId} = any(${a}.audience_user_ids)
      or exists (select 1 from organization_member_roles kr where kr.org_id = ${a}.org_id
        and kr.user_id = ${userId} and kr.role_id = any(${a}.audience_role_ids)))))`;
}

/** `managesAgent` in SQL: `manage_agents` where it reaches (`keysReachSql`). */
export const managesAgentSql = (alias: string, userId: SQL): SQL<boolean> =>
  sql<boolean>`(${maySql(sql`${sql.raw(alias)}.org_id`, userId, "manage_agents")} and ${keysReachSql(alias, userId)})`;

/** `editsAgent` in SQL: its owner, who manages it, or who its "Quem pode editar" names (a member, by name or role). */
export function editsAgentSql(alias: string, userId: SQL): SQL<boolean> {
  const a = sql.raw(alias);
  return sql<boolean>`(${managesAgentSql(alias, userId)}
    or (exists (select 1 from organization_members em where em.org_id = ${a}.org_id and em.user_id = ${userId})
      and (${ownsAgentSql(alias, userId)} or ${userId} = any(${a}.editor_user_ids)
        or exists (select 1 from organization_member_roles er where er.org_id = ${a}.org_id
          and er.user_id = ${userId} and er.role_id = any(${a}.editor_role_ids)))))`;
}

/** `seesAgentDetails` in SQL: who edits it (`editsAgentSql`) or whom it answers (`audienceSql`). */
export const seesAgentDetailsSql = (alias: string, userId: SQL): SQL<boolean> =>
  sql<boolean>`(${editsAgentSql(alias, userId)} or ${audienceSql(alias, userId)})`;

/** `isPrivateAgent` in SQL: neither everyone nor anyone but its owner, by name or role. */
export function privateAgentSql(alias: string): SQL<boolean> {
  const a = sql.raw(alias);
  return sql<boolean>`not (${a}.audience_mode = 'everyone' or (${a}.audience_mode = 'people'
    and (cardinality(${a}.audience_role_ids) > 0 or not (${a}.audience_user_ids <@ array[${a}.owner_user_id]))))`;
}

/** `listsAgentTo` in SQL, for the person `userId` whose membership is `membership`. */
export const listsAgentSql = (alias: string, userId: SQL, membership: Pick<Membership, "permissions"> | null) =>
  listsAllAgents(membership)
    ? sql<boolean>`(not ${privateAgentSql(alias)} or ${seesAgentDetailsSql(alias, userId)})`
    : seesAgentDetailsSql(alias, userId);

/** `managesRoutinesOf` in SQL: who edits it, or `manage_routines` where it reaches. */
export const managesRoutinesSql = (alias: string, userId: SQL): SQL<boolean> =>
  sql<boolean>`(${editsAgentSql(alias, userId)} or (${maySql(sql`${sql.raw(alias)}.org_id`, userId, "manage_routines")}
    and ${keysReachSql(alias, userId)}))`;

/**
 * Who manages the agent (`managesAgent`), as member ids: whom what needs an admin's eye on it is told. A private
 * agent's news never reaches who merely holds "Editar qualquer agente".
 */
export async function agentManagerIds(db: Executor, orgId: string, agentId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .innerJoin(agents, and(eq(agents.orgId, organizationMembers.orgId), eq(agents.id, agentId)))
    .where(and(eq(organizationMembers.orgId, orgId), managesAgentSql("agents", sql`${organizationMembers.userId}`)));
  return rows.map((r) => r.userId);
}

/**
 * Who edits the agent (`editsAgent`: its owner, who manages it and the people its editors name), as member ids: whom a
 * change to how it works (its instructions, role or skills) is sent to for a decision.
 */
export async function agentEditorIds(db: Executor, orgId: string, agentId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .innerJoin(agents, and(eq(agents.orgId, organizationMembers.orgId), eq(agents.id, agentId)))
    .where(and(eq(organizationMembers.orgId, orgId), editsAgentSql("agents", sql`${organizationMembers.userId}`)));
  return rows.map((r) => r.userId);
}

/**
 * Who looks after the agent, as member ids: its owner (`ownsAgent`) and the people its "Quem pode editar" names
 * (`namedEditor`), never who merely manages agents. They talk to it and know what it was told, so a change to its
 * instructions waits on them (ADR 0085, addendum of 2026-11-24). Empty: the callers turn to who reviews memory.
 */
export async function agentKeeperIds(db: Executor, orgId: string, agentId: string): Promise<string[]> {
  const userId = sql`${organizationMembers.userId}`;
  const rows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .innerJoin(agents, and(eq(agents.orgId, organizationMembers.orgId), eq(agents.id, agentId)))
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        sql<boolean>`(${ownsAgentSql("agents", userId)} or ${userId} = any(agents.editor_user_ids)
          or exists (select 1 from organization_member_roles kr where kr.org_id = agents.org_id
            and kr.user_id = ${userId} and kr.role_id = any(agents.editor_role_ids)))`,
      ),
    );
  return rows.map((r) => r.userId);
}

/**
 * Whom it answers by name: its roles first (its owner role leading), then its owner and the people of its audience
 * (only what still exists).
 */
async function answered(db: Database, a: Agent) {
  const { mode, userIds, roleIds } = audienceOf(a);
  const ids = [...new Set([...(a.ownerUserId ? [a.ownerUserId] : []), ...(mode === "people" ? userIds : [])])];
  const picked = [...new Set([...(a.ownerRoleId ? [a.ownerRoleId] : []), ...(mode === "people" ? roleIds : [])])];
  const [people, roles] = await Promise.all([
    ids.length ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [],
    picked.length
      ? db
          .select({ id: orgRoles.id, name: orgRoles.name })
          .from(orgRoles)
          .where(and(eq(orgRoles.orgId, a.orgId), inArray(orgRoles.id, picked)))
      : [],
  ]);
  const inOrder = <T extends { id: string }>(order: string[], rows: T[]) =>
    order.flatMap((id) => rows.filter((r) => r.id === id));
  return { roles: inOrder(picked, roles), people: inOrder(ids, people) };
}

/** Who the agent answers, as a stable code and params (the app says it in the person's language). */
export async function audienceDetail(db: Database, a: Agent) {
  const { roles, people } = await answered(db, a);
  const names = [...roles, ...people].map((r) => r.name);
  const code = names.length === 0 ? "audience.nobody" : "audience.only";
  const params = {
    agentId: a.id,
    agentName: a.name,
    userIds: people.map((p) => p.id),
    roleIds: roles.map((r) => r.id),
    names,
  };
  return { code, params, english: englishNotice(a.name, names) };
}

const englishNotice = (agentName: string, names: string[]) => {
  if (names.length === 0) return `${agentName} isn't replying to anyone right now.`;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${agentName} only replies to ${list}.`;
};

/** The ForbiddenError for someone the agent doesn't answer, with code and params. */
export async function audienceError(db: Database, a: Agent) {
  const d = await audienceDetail(db, a);
  return new ForbiddenError(d.english, d.code, d.params);
}

/** "Theo only replies to Suporte, Walter and Ana." (English text for agents' context and old clients; the app uses `audienceDetail`). */
export async function audienceNotice(db: Database, a: Agent): Promise<string> {
  return (await audienceDetail(db, a)).english;
}

/**
 * Tells only that person that the agent won't answer them (ephemeral: their
 * own topic, never stored as a message).
 */
export async function notifyBlocked(
  deps: { db: Database; pubsub: PubSub },
  orgId: string,
  userId: string,
  input: {
    agentIds: string[];
    channelId: string;
    threadId: string | null;
    messageId: string;
    /** The channel's exceptions took `talk_to_agents` from them (ADR 0134), not the agents' audience. */
    deniedHere?: boolean;
  },
) {
  const out: { agentId: string; text: string; code: string; params: Record<string, unknown> }[] = [];
  for (const agentId of input.agentIds) {
    const agent = await getAgent(deps.db, orgId, agentId);
    if (!agent) continue;
    const detail = input.deniedHere
      ? {
          code: "channel.agents_denied",
          params: { agentId, agentName: agent.name },
          english: "You don't call agents in this channel.",
        }
      : await audienceDetail(deps.db, agent);
    const text = detail.english;
    out.push({ agentId, text, code: detail.code, params: detail.params });
    await publishUserEvent(deps.pubsub, orgId, userId, {
      type: "agent.unavailable",
      agentId,
      channelId: input.channelId,
      threadId: input.threadId,
      messageId: input.messageId,
      text,
      code: detail.code,
      params: detail.params,
    });
  }
  return out;
}

type PlanAgent = Pick<Agent, "id" | "brain" | "ownerUserId"> &
  Partial<Pick<Agent, "brainAccountId" | "brainAccountLentBy">>;

/**
 * Whose plan an agent on a computer brain thinks with: its owner's, or the owner of the plan someone else gave it
 * (`brainAccountLentBy`, ADR 0059 §3). Null on the API.
 */
async function planOwnerOf(db: Executor, orgId: string, agent: PlanAgent): Promise<string | null> {
  if (!isComputerBrain(agent.brain)) return null;
  if (!agent.brainAccountLentBy || !agent.brainAccountId) return agent.ownerUserId;
  const [row] = await db
    .select({ ownerId: schema.machineAccounts.createdBy })
    .from(schema.machineAccounts)
    .where(and(eq(schema.machineAccounts.orgId, orgId), eq(schema.machineAccounts.id, agent.brainAccountId)));
  return row?.ownerId ?? null;
}

/** The outbox job telling a plan's owner that someone else let more people talk to their agent (`queuePlanOpenedEmail`). */
export const PLAN_OPENED_JOB = "agent.plan_opened";

/**
 * Who may talk to the agent changed from `from` to `to`, saved as `after`. Audited, naming whose plan it is when it
 * thinks with its owner's (ADR 0059 §5), and told to that owner (`planOpened`, from `planFrom`: who its plan answered).
 * `via`: what made the change other than a save of it (`invitation`, ADR 0184).
 */
export async function audienceChanged(
  db: Executor,
  orgId: string,
  actorId: string,
  after: PlanAgent,
  from: AgentAudience,
  to: AgentAudience,
  planFrom = from,
  via?: string,
): Promise<boolean> {
  const planOwner = await planOwnerOf(db, orgId, after);
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "agent.audience_changed",
    target: { type: "agent", id: after.id },
    details: { from, to, ...(planOwner ? { planOwner } : {}), ...(via ? { via } : {}) },
  });
  return planOpened(db, orgId, actorId, after, planFrom, to);
}

/**
 * Someone other than its owner let more people talk to an agent that thinks with its owner's plan (ADR 0059 §5): that
 * owner hears it by email, once per change, since their plan pays for those conversations.
 */
export async function planOpened(
  db: Executor,
  orgId: string,
  actorId: string,
  after: PlanAgent,
  from: AgentAudience,
  to: AgentAudience,
): Promise<boolean> {
  const planOwner = await planOwnerOf(db, orgId, after);
  if (!planOwner || planOwner === actorId || !widensAudience(from, to, planOwner)) return false;
  await enqueue(db, {
    orgId,
    kind: PLAN_OPENED_JOB,
    payload: { agentId: after.id, actorId, from, to },
    dedupeKey: `plan-opened:${crypto.randomUUID()}`,
  });
  return true;
}

/**
 * Changes who can talk to the agent: its owner or admins (with no owner,
 * admins only), on a plan too (ADR 0059 §5): its owner hears by email when someone else lets more people in.
 * `mailLossSeen`: the mailboxes the person agreed it loses (`audienceMailLoss`); losing any other refuses the save
 * (409 `agent.mail_loss_changed`), so a mailbox given after they were asked is never taken unasked.
 * `checked`: the caller already decided who may (`audienceEditable`). Audited.
 */
export async function setAgentAudience(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  audience: AudienceInput,
  mailLossSeen?: readonly string[],
  options: { checked?: boolean } = {},
): Promise<Agent> {
  const agent = await audienceEditable(db, actorId, orgId, agentId, options.checked);
  if (!AUDIENCE_MODES.includes(audience.mode)) throw new ValidationError("Unknown audience mode");
  const requested = audience.mode === "people" ? [...new Set(audience.userIds)] : [];
  if (requested.length > 500) throw new ValidationError("At most 500 people");
  // Older apps don't send roles: adding a person there keeps the roles picked.
  const requestedRoles = audience.mode === "people" ? [...new Set(audience.roleIds ?? agent.audienceRoleIds)] : [];
  if (requestedRoles.length > 100) throw new ValidationError("At most 100 roles");
  // One transaction holding FOR SHARE on the member rows it read: a removeMember (which deletes the member row,
  // then takes the id off agents' lists) either waits for this save or is seen by it, never overwritten by it.
  const updated = await db.transaction(async (tx) => {
    let userIds = requested;
    if (userIds.length > 0) {
      const members = await tx
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, userIds)))
        .for("share");
      // Someone no longer in the workspace drops out rather than failing the save: the apps' list may still hold them.
      const known = new Set(members.map((m) => m.userId));
      userIds = userIds.filter((id) => known.has(id));
    }
    let roleIds = requestedRoles;
    if (roleIds.length > 0) {
      // `everyone` is the "everyone" mode, not a role to pick.
      const known = new Set(
        (
          await tx
            .select({ id: orgRoles.id })
            .from(orgRoles)
            .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom"), inArray(orgRoles.id, roleIds)))
        ).map((r) => r.id),
      );
      if (audience.roleIds && roleIds.some((id) => !known.has(id)))
        throw new ValidationError("Every role must be one of the workspace's");
      roleIds = roleIds.filter((id) => known.has(id));
    }
    if (audience.mode === "people" && userIds.length === 0 && roleIds.length === 0 && !hasOwner(agent)) {
      throw new ValidationError("Pick at least one person or role");
    }
    // Under "owner" the lists are who a plan kept out (ADR 0059 §5), back once it is let out: staying "owner" keeps them.
    if (audience.mode === "owner" && agent.audienceMode === "owner") {
      userIds = agent.audienceUserIds;
      roleIds = agent.audienceRoleIds;
    }
    const consultable = audience.consultable ?? agent.consultable;
    const [updated] = await tx
      .update(agents)
      .set({
        audienceMode: audience.mode,
        audienceUserIds: userIds,
        audienceRoleIds: roleIds,
        consultable,
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
      .returning();
    if (updated) {
      if (mailLossSeen && widensReach(audienceOf(agent), audienceOf(updated), agent.ownerUserId)) {
        const lost = await foreignMailboxes(tx, orgId, agentId, actorId);
        if (lost.some((m) => !mailLossSeen.includes(m.accountId))) {
          throw new ConflictError("It holds a mailbox you weren't asked about", "agent.mail_loss_changed");
        }
      }
      await dropMailIfWidened(tx, orgId, agentId, agent.ownerUserId, audienceOf(agent), audienceOf(updated), actorId);
      await audienceChanged(tx, orgId, actorId, updated, audienceOf(agent), audienceOf(updated));
    }
    return updated;
  });
  if (!updated) throw new NotFoundError("Agent not found");
  caches.agents.delete(`${orgId}:${agentId}`);
  caches.agents.delete(`${orgId}:team`);
  return updated;
}

/** "Quem pode editar" as the apps read and save it: who it names besides the agent's owner and who manages it. */
export interface AgentEditors {
  userIds: string[];
  roleIds: string[];
}

export const editorsOf = (a: Pick<Agent, "editorUserIds" | "editorRoleIds">): AgentEditors => ({
  userIds: a.editorUserIds,
  roleIds: a.editorRoleIds,
});

/**
 * Changes who edits the agent's instructions, role, skills and routines ("Quem pode editar", ADR 0085, addendum of
 * 2026-11-17): its owner or who manages it, as who talks to it. Its owner always edits, so naming them adds nothing;
 * someone no longer in the workspace drops out, and every role must be one of the workspace's own. The team's right
 * hand is the product's (ADR 0137): nobody edits how it works. `checked`: the caller already decided who may
 * (`audienceEditable`). Audited as `agent.editors_changed`.
 */
export async function setAgentEditors(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  editors: AgentEditors,
  options: { checked?: boolean } = {},
): Promise<Agent> {
  const agent = await audienceEditable(db, actorId, orgId, agentId, options.checked);
  if (agent.builtin)
    throw new ForbiddenError("The team's right hand can't be edited this way", "agent.right_hand_permanent");
  const requested = [...new Set(editors.userIds)].filter((id) => id !== agent.ownerUserId);
  if (requested.length > 500) throw new ValidationError("At most 500 people");
  // Whoever holds its owner role edits it already (`editsAgent`).
  const requestedRoles = [...new Set(editors.roleIds)].filter((id) => id !== agent.ownerRoleId);
  if (requestedRoles.length > 100) throw new ValidationError("At most 100 roles");
  // FOR SHARE on the member rows read, as the audience's save: a removeMember either waits for it or is seen by it.
  const updated = await db.transaction(async (tx) => {
    let userIds = requested;
    if (userIds.length > 0) {
      const members = await tx
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, userIds)))
        .for("share");
      const known = new Set(members.map((m) => m.userId));
      userIds = userIds.filter((id) => known.has(id));
    }
    if (requestedRoles.length > 0) {
      const known = await tx
        .select({ id: orgRoles.id })
        .from(orgRoles)
        .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom"), inArray(orgRoles.id, requestedRoles)));
      if (known.length !== requestedRoles.length)
        throw new ValidationError("Every role must be one of the workspace's");
    }
    const [row] = await tx
      .update(agents)
      .set({ editorUserIds: userIds, editorRoleIds: requestedRoles, updatedAt: new Date() })
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
      .returning();
    if (row) {
      await recordAudit(tx, {
        orgId,
        actor: { type: "person", id: actorId },
        action: "agent.editors_changed",
        target: { type: "agent", id: agentId },
        details: { from: editorsOf(agent), to: editorsOf(row) },
      });
    }
    return row;
  });
  if (!updated) throw new NotFoundError("Agent not found");
  caches.agents.delete(`${orgId}:${agentId}`);
  caches.agents.delete(`${orgId}:team`);
  return updated;
}
