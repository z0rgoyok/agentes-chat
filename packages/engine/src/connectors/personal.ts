import { and, type Database, type Executor, eq, inArray, isNull, or, type SQL, schema, sql } from "@agenteschat/db";
import { getAgent } from "../agents";
import { managesAgent } from "../audience";
import { recordAudit } from "../audit";
import { runAuthorityById } from "../authority";
import { caches } from "../cache";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { can, type Membership, requirePermission } from "../organizations";
import { ownerApprovers, personalUseCheck } from "../personal-use";
import { ALL_TOOLS, grantedScopeKeys, grantKey, isAllowed, listAgentScopes, toolAccess } from "../tools/scopes";
import type { ToolContext, ToolDefinition } from "../tools/types";

const { connectorConnections } = schema;
type ConnectorConnection = typeof connectorConnections.$inferSelect;

/**
 * What a person may do with a connection (the Vault's split, ADR 0144; ADR 0099 addendum). A personal connection is
 * its person's: only they see its details, rename, reconnect, classify its tools or give it to agents. Who manages
 * connectors sees that it exists and may remove it or take it off an agent (`remove`), never read it. Moving it to the
 * team is its person's, when they also manage connectors. A team connection: every member sees it, who manages
 * connectors changes and removes it.
 */
export type ConnectionAct = "read" | "change" | "remove" | "move";

export function mayConnection(
  c: Pick<ConnectorConnection, "ownerUserId">,
  actorId: string,
  membership: Membership,
  act: ConnectionAct,
) {
  const manages = can(membership, "manage_connectors");
  if (c.ownerUserId) {
    if (c.ownerUserId === actorId) return act !== "move" || manages;
    return act === "remove" && manages;
  }
  return act === "read" || (act !== "move" && manages);
}

/** The connections of one owner: the team's (`null`), or one person's. */
export const connectionsOf = (owner: string | null): SQL =>
  owner ? eq(connectorConnections.ownerUserId, owner) : isNull(connectorConnections.ownerUserId);

/** The connections `actorId` sees in full: the team's and their own. */
export const seenBy = (actorId: string): SQL =>
  or(isNull(connectorConnections.ownerUserId), eq(connectorConnections.ownerUserId, actorId)) as SQL;

/** Whether a connection is someone other than `actorId`'s personal one. */
export const othersPersonal = (c: Pick<ConnectorConnection, "ownerUserId">, actorId: string) =>
  c.ownerUserId !== null && c.ownerUserId !== actorId;

/**
 * Someone else's own connection's name as others read it: once its sign-in reached an account, a name in the default
 * form, the service and that account ("CRM (walter@example.com)"), goes by the service alone, as a mailbox's name that
 * holds its address does. Whatever the brackets hold is dropped, as an account's name may hold brackets of its own
 * ("Stripe (Example Ltd (Brazil))") and the provider may have renamed the account since. A number `freeLabel` added
 * stays ("CRM (walter@example.com) 2" reads "CRM 2"), so two rows stay apart.
 */
export function othersLabel(label: string, account: string | null | undefined) {
  if (!account) return label;
  // Read by position, not by a pattern: a person types this name, and a pattern with two open-ended parts backtracks.
  const open = label.indexOf(" (", 1);
  const close = label.lastIndexOf(")");
  if (open < 0 || close < open + 3) return label;
  const number = label.slice(close + 1);
  return number === "" || /^ \d+$/.test(number) ? `${label.slice(0, open)}${number}` : label;
}

/**
 * A connection's name as anyone but its person reads it, so the name everything outside its own rows carries: audit
 * lines, and its tools' name, which every step, chip, status and card of a run copies. Its person's own rows and card
 * read the whole name from the connection itself.
 */
export const auditLabel = (c: Pick<ConnectorConnection, "label" | "accountLabel" | "ownerUserId">) =>
  c.ownerUserId ? othersLabel(c.label, c.accountLabel) : c.label;

/**
 * Whether `actorId` sees that someone else's personal connection is on this agent (and may take it off): who manages
 * connectors, who manages this agent (`managesAgent`: "Editar agentes" where it reaches, ADR 0085 addendum of
 * 2026-11-17), and the agent's owner. Never its details.
 */
export const seesOthersOnAgent = (membership: Membership, agent: Parameters<typeof managesAgent>[0], actorId: string) =>
  can(membership, "manage_connectors") || managesAgent(agent, actorId, membership) || agent.ownerUserId === actorId;

/**
 * Who may connect for whom: a personal connection (`personal`) any member makes, a team one who manages connectors.
 * GitHub stays the team's: its git proxy, repository lists and webhooks read the workspace's one GitHub connection.
 */
export async function requireConnect(db: Executor, actorId: string, orgId: string, personal: boolean, connector = "") {
  if (personal && connector === "github") {
    // The apps offer GitHub for the team only, so only an API client meets this.
    throw new ValidationError("GitHub connects for the whole team only");
  }
  return requirePermission(db as Database, actorId, orgId, personal ? "read" : "manage_connectors");
}

/**
 * A live connection of the workspace, refused as `mayConnection` says: someone else's personal connection reads as
 * missing, so even its name isn't told, unless the act is one they may do.
 */
export async function connectionFor(db: Database, actorId: string, orgId: string, id: string, act: ConnectionAct) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const [c] = await db
    .select()
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.id, id),
        eq(connectorConnections.orgId, orgId),
        isNull(connectorConnections.revokedAt),
      ),
    );
  if (!c) throw new NotFoundError("Connection not found");
  if (mayConnection(c, actorId, membership, act)) return c;
  if (othersPersonal(c, actorId) && !(act === "remove" && can(membership, "manage_connectors")))
    throw new NotFoundError("Connection not found");
  if (c.ownerUserId === actorId && act === "move")
    throw new ForbiddenError("Only people who manage connectors move a connection to the team");
  throw new ForbiddenError("Only people who manage connectors can change the team's connections");
}

/**
 * Of a workspace's connections, those a run may use (ADR 0099 addendum): the team's, and a personal one only on an
 * agent with a grant of its own on it ("all tools" never covers someone's personal connection) and only when its
 * person is behind the run (`personalUseCheck` with `ownerOnly`): anyone else, or nobody, gets nothing of it. The
 * person and grants are read only when a personal connection is among them, so the usual run pays nothing.
 */
export async function usableConnections(ctx: ToolContext, connections: ConnectorConnection[]) {
  if (!connections.some((c) => c.ownerUserId)) return { connections, ownGrants: null };
  const authority = ctx.runId ? await runAuthorityById(ctx.db, ctx.orgId, ctx.runId) : null;
  const [check, keys] = await Promise.all([
    personalUseCheck(ctx, authority, { ownerOnly: true }),
    grantedScopeKeys(ctx.db, ctx.orgId, ctx.agentId),
  ]);
  const ownGrants = new Set([...keys].filter((k) => k !== grantKey(null, ALL_TOOLS)));
  const held = (id: string) => [...ownGrants].some((k) => k.startsWith(`${id}|`) && !k.includes("|deny:"));
  return {
    connections: connections.filter((c) => !c.ownerUserId || (held(c.id) && check(c.ownerUserId))),
    ownGrants,
  };
}

/**
 * A personal connection's tool as its person's run holds it: only what the agent's own grants on it allow. A card it
 * opens is its person's alone to decide and to list (`ownerApprovers` with `personal`), never the agent's owner's or
 * admins'. What it reads is marked as from outside, as a mailbox's is. `ownerUserId` lets the gateway refuse it to
 * any other run. A team connection's tool comes back as it is. Null: not allowed.
 */
export function personalTool(
  tool: ToolDefinition,
  connection: Pick<ConnectorConnection, "ownerUserId">,
  run: { ownGrants: Set<string> | null },
  reads: boolean,
): ToolDefinition | null {
  const owner = connection.ownerUserId;
  if (!owner) return tool;
  if (!run.ownGrants || !isAllowed(toolAccess(run.ownGrants, tool))) return null;
  return {
    ...tool,
    ownerUserId: owner,
    approvers: (_input, ctx, requestedBy) => ownerApprovers(ctx.db, ctx.orgId, owner, requestedBy, true),
    ...(reads ? { readsOutside: true as const } : {}),
  };
}

/**
 * Takes a connection off one agent ("Tirar de um agente"): its person, who manages connectors or agents, or the
 * agent's owner (taking access away is anyone's who may change the agent). Its grants on that agent go, every one of
 * them; the connection stays. Someone else's personal connection reads as missing to anyone else.
 */
export async function takeConnectionOffAgent(
  db: Database,
  actorId: string,
  orgId: string,
  connectionId: string,
  agentId: string,
) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const [c] = await db
    .select()
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.id, connectionId),
        eq(connectorConnections.orgId, orgId),
        isNull(connectorConnections.revokedAt),
      ),
    );
  const agent = await getAgent(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  const may = c && (c.ownerUserId === actorId || seesOthersOnAgent(membership, agent, actorId));
  if (!c || (!may && othersPersonal(c, actorId))) throw new NotFoundError("Connection not found");
  if (!may) throw new ForbiddenError("Only an admin or the agent's owner can change its access");
  const gone = await db.transaction(async (tx) => {
    const rows = await tx
      .delete(schema.agentScopes)
      .where(
        and(
          eq(schema.agentScopes.orgId, orgId),
          eq(schema.agentScopes.agentId, agentId),
          eq(schema.agentScopes.connectionId, c.id),
        ),
      )
      .returning({ scope: schema.agentScopes.scope });
    if (rows.length > 0)
      await recordAudit(tx, {
        orgId,
        actor: { type: "person", id: actorId },
        action: "agent.access_changed",
        target: { type: "agent", id: agentId },
        details: { connectionId: c.id, label: auditLabel(c), level: "none" },
      });
    return rows.length;
  });
  caches.scopes.deletePrefix(`${orgId}:${agentId}`);
  return { removed: gone };
}

/**
 * The agents each personal connection is on (a grant of their own on it, denials aside), for its row's "which agents".
 * Team connections aren't read: "all tools" reaches them too, so their grants alone don't say it.
 */
export async function personalAgents(
  db: Database,
  orgId: string,
  rows: Pick<ConnectorConnection, "id" | "ownerUserId">[],
) {
  const ids = rows.filter((r) => r.ownerUserId).map((r) => r.id);
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const grants = await db
    .selectDistinct({ connectionId: schema.agentScopes.connectionId, agentId: schema.agentScopes.agentId })
    .from(schema.agentScopes)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.agentScopes.agentId))
    .where(
      and(
        eq(schema.agentScopes.orgId, orgId),
        inArray(schema.agentScopes.connectionId, ids),
        sql`${schema.agentScopes.scope} not like 'deny:%'`,
        isNull(schema.agents.archivedAt),
        isNull(schema.agents.deletedAt),
      ),
    );
  for (const g of grants) {
    if (!g.connectionId) continue;
    out.set(g.connectionId, [...(out.get(g.connectionId) ?? []), g.agentId]);
  }
  return out;
}

/**
 * `GET …/agents/{id}/scopes` as `actorId` may read it: grants on someone else's own connection or mailbox only for
 * who may take them off (`seesOthersOnAgent`).
 */
export async function agentScopesFor(db: Database, actorId: string, orgId: string, agentId: string) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  const rows = await listAgentScopes(db, orgId, agentId);
  if (seesOthersOnAgent(membership, agent, actorId)) return rows;
  const ids = [...new Set(rows.flatMap((r) => (r.connectionId ? [r.connectionId] : [])))];
  if (ids.length === 0) return rows;
  const [connections, mailboxes] = await Promise.all([
    db
      .select({ id: connectorConnections.id, owner: connectorConnections.ownerUserId })
      .from(connectorConnections)
      .where(and(eq(connectorConnections.orgId, orgId), inArray(connectorConnections.id, ids))),
    db
      .select({ id: schema.mailAccounts.id, owner: schema.mailAccounts.createdByUserId })
      .from(schema.mailAccounts)
      .where(and(eq(schema.mailAccounts.orgId, orgId), inArray(schema.mailAccounts.id, ids))),
  ]);
  const theirs = new Set(
    [...connections, ...mailboxes].filter((r) => r.owner !== null && r.owner !== actorId).map((r) => r.id),
  );
  return rows.filter((r) => !r.connectionId || !theirs.has(r.connectionId));
}
