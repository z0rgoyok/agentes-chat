import type { PubSub } from "@agenteschat/adapters";
import { and, count, type Database, type Executor, eq, isNull, schema } from "@agenteschat/db";
import { releaseUnasked } from "./approvals";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { ValidationError } from "./errors";
import { publishAgentsChanged } from "./events";
import { requirePermission } from "./organizations";
import { APPROVALS_LEVELS, type ApprovalsLevel, DEFAULT_APPROVALS_LEVEL } from "./tools/run-policy";

const { agents, organizationSettings } = schema;

/** The level every agent without its own choice follows (ADR 0173, addendum 2026-11-15). */
export async function workspaceApprovalsLevel(db: Executor, orgId: string): Promise<ApprovalsLevel> {
  const [row] = await db
    .select({ level: organizationSettings.approvalsLevel })
    .from(organizationSettings)
    .where(eq(organizationSettings.orgId, orgId));
  return row?.level ?? DEFAULT_APPROVALS_LEVEL;
}

/** How many of the workspace's agents hold their own level, so a workspace change leaves them alone. */
export async function agentsWithOwnApprovalsLevel(db: Executor, orgId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.approvalsLevelOwn, true), isNull(agents.deletedAt)));
  return row?.n ?? 0;
}

/**
 * Sets the workspace's level and gives it to every agent that follows it. `everyAgent` also clears every agent's own
 * choice, so all of them follow it from now on. Owners and administrators only (`administrator`): the level lands on
 * every agent, a private one too, and only they manage every agent; `manage_agents` alone doesn't reach someone's
 * private agent (`keysReach`, ADR 0085 addendum of 2026-11-17).
 */
export async function setWorkspaceApprovalsLevel(
  db: Database,
  actorId: string,
  orgId: string,
  level: ApprovalsLevel,
  options: { everyAgent?: boolean; pubsub?: PubSub } = {},
): Promise<{ level: ApprovalsLevel; ownAgents: number }> {
  await requirePermission(db, actorId, orgId, "administrator");
  if (!APPROVALS_LEVELS.includes(level)) {
    throw new ValidationError(`approvalsLevel must be one of: ${APPROVALS_LEVELS.join(", ")}`);
  }
  const everyAgent = options.everyAgent === true;
  const changed = await db.transaction(async (tx) => {
    await tx
      .insert(organizationSettings)
      .values({ orgId, approvalsLevel: level })
      .onConflictDoUpdate({
        target: organizationSettings.orgId,
        set: { approvalsLevel: level, updatedAt: new Date() },
      });
    const rows = await tx
      .update(agents)
      .set({ approvalsLevel: level, approvalsLevelOwn: false, updatedAt: new Date() })
      .where(
        and(
          eq(agents.orgId, orgId),
          isNull(agents.deletedAt),
          everyAgent ? undefined : eq(agents.approvalsLevelOwn, false),
        ),
      )
      .returning({ id: agents.id });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "organization.approvals_level",
      target: { type: "organization", id: orgId },
      details: { approvalsLevel: level, everyAgent, agents: rows.length },
    });
    return rows;
  });
  for (const { id } of changed) caches.agents.delete(`${orgId}:${id}`);
  caches.agents.delete(`${orgId}:team`);
  if (level === "never") {
    await releaseUnasked({ db, pubsub: options.pubsub }, actorId, orgId, { agentIds: changed.map((a) => a.id) });
  }
  await publishAgentsChanged(options.pubsub, orgId);
  return { level, ownAgents: everyAgent ? 0 : await agentsWithOwnApprovalsLevel(db, orgId) };
}
