import { and, type Executor, eq, isNull, schema } from "@agenteschat/db";
import { decidesAgentApprovals, MAX_OWN_ACTIONS } from "./approval-rules";
import { UUID } from "./authority";
import { approvalsLevelOf } from "./tools/run-policy";

const { agents, routines } = schema;

/**
 * Vault keys a routine's own run may put in a command (ADR 0144 §2, amended 2026-11-12): the ones its creator listed
 * for it, kept with its own actions as `vault:NAME` (`routines.own_actions`), or approved once with "Sempre nesta
 * rotina". A run that routine's work or report woke (its agent's or a teammate's) gets only the listed ones
 * (`routineKeysLent`, amended 2026-11-16).
 */
export const VAULT_ACTION_PREFIX = "vault:";

/** The command tool whose `keys` take Vault keys (sandbox-tools). */
export const RUN_CODE_TOOL = "run_code";

export const vaultAction = (name: string) => `${VAULT_ACTION_PREFIX}${name}`;

/** The Vault keys a command asks for (`run_code`'s `keys`), as sent: its own checks refuse a bad name later. */
export const keysOfCall = (input: Record<string, unknown>): string[] =>
  Array.isArray(input.keys)
    ? [...new Set(input.keys.filter((k): k is string => typeof k === "string" && k.trim() !== "").map((k) => k.trim()))]
    : [];

/** The key's name of a `vault:NAME` own action; null for any other action. */
export const vaultKeyOf = (action: string) =>
  action.startsWith(VAULT_ACTION_PREFIX) ? action.slice(VAULT_ACTION_PREFIX.length) || null : null;

/**
 * Whether a routine's own run may use these Vault keys in a command without asking: its agent never asks ("Nunca
 * perguntar"), or every key is one of the routine's own (`vault:NAME`) while its creator still decides the agent's
 * approvals and the agent doesn't always ask. Read fresh: a removed key asks at once.
 */
export async function routineKeysAllowed(
  db: Executor,
  at: { orgId: string; agentId: string; routineId: string },
  names: readonly string[],
): Promise<boolean> {
  const level = await approvalsLevelOf(db, at.orgId, at.agentId);
  if (level === "never") return true;
  if (level === "always" || names.length === 0) return false;
  const [row] = await db
    .select({ ownActions: routines.ownActions, creator: routines.createdByUserId, owner: agents.ownerUserId })
    .from(routines)
    .innerJoin(agents, and(eq(agents.id, routines.agentId), eq(agents.orgId, routines.orgId)))
    .where(
      and(
        eq(routines.id, at.routineId),
        eq(routines.orgId, at.orgId),
        eq(routines.agentId, at.agentId),
        isNull(routines.deletedAt),
      ),
    );
  if (!row?.creator) return false;
  const own = new Set(row.ownActions);
  if (!names.every((n) => own.has(vaultAction(n)))) return false;
  return decidesAgentApprovals(db, at.orgId, row.creator, row.owner);
}

/**
 * Whether a run that a routine's work or report woke may use these Vault keys in a command (ADR 0144 §2, amended
 * 2026-11-16): every key is one that routine's creator listed for it (`vault:NAME`), while that creator still decides
 * its agent's approvals. The routine's agent and the command's may differ (a teammate the routine's work reached): the
 * Vault still releases a key only to an agent it is shared with, for the routine's creator. "Nunca perguntar" opens
 * no other key here: what woke the run may carry text from outside. Read fresh: a key taken off the routine is refused
 * at once.
 */
export async function routineKeysLent(
  db: Executor,
  at: { orgId: string; routineId: string },
  names: readonly string[],
): Promise<boolean> {
  if (names.length === 0 || !UUID.test(at.routineId)) return false;
  const [row] = await db
    .select({ ownActions: routines.ownActions, creator: routines.createdByUserId, owner: agents.ownerUserId })
    .from(routines)
    .innerJoin(agents, and(eq(agents.id, routines.agentId), eq(agents.orgId, routines.orgId)))
    .where(and(eq(routines.id, at.routineId), eq(routines.orgId, at.orgId), isNull(routines.deletedAt)));
  if (!row?.creator) return false;
  const own = new Set(row.ownActions);
  if (!names.every((n) => own.has(vaultAction(n)))) return false;
  return decidesAgentApprovals(db, at.orgId, row.creator, row.owner);
}

/**
 * What "Sempre nesta rotina" keeps for a routine run's command that asks for these keys, or null where keeping them
 * would change nothing (`routineKeysAllowed` would still ask: its creator no longer decides the agent's approvals) or
 * there's no room left among its own actions.
 */
export async function routineKeysKind(
  db: Executor,
  at: { orgId: string; routineId: string },
  tool: string,
  names: readonly string[],
) {
  const [row] = await db
    .select({ ownActions: routines.ownActions, creator: routines.createdByUserId, owner: agents.ownerUserId })
    .from(routines)
    .innerJoin(agents, and(eq(agents.id, routines.agentId), eq(agents.orgId, routines.orgId)))
    .where(and(eq(routines.id, at.routineId), eq(routines.orgId, at.orgId), isNull(routines.deletedAt)));
  if (!row?.creator) return null;
  const actions = names.map(vaultAction);
  if (new Set([...row.ownActions, ...actions]).size > MAX_OWN_ACTIONS) return null;
  if (!(await decidesAgentApprovals(db, at.orgId, row.creator, row.owner))) return null;
  return { tool, actions, routineId: at.routineId };
}
