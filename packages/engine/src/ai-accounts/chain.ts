import { and, eq, inArray, isNull, type SQL, schema, sql } from "@agenteschat/db";
import { NEXT_ACCOUNT_KINDS } from "@agenteschat/providers/plans";
import { accountServesSql, audienceAllowsSql } from "./serves";

const { machineAccounts } = schema;

/**
 * THE order of use (ADR 0041 §6), for every chooser of "which account next": `person`'s own accounts first (an agent's
 * owner, or whom the right hand answers), then by `use_order`, the unplaced after, oldest first. Room left and being
 * online are filters of the caller's, never a re-sort. `compareInOrder` (`@agenteschat/providers/plans`) is its JS twin.
 */
export function accountOrderSql(person: string | null): SQL[] {
  return [
    ...(person ? [sql`(${machineAccounts.createdBy} = ${person}) desc`] : []),
    sql`${machineAccounts.useOrder} asc nulls last`,
    sql`${machineAccounts.createdAt} asc`,
    sql`${machineAccounts.id} asc`,
  ];
}

/** A run may move onto it at a plan's limit: Claude Code's or Codex's own sign-in (never a key, paid by the token). */
export const movableKindSql = and(
  inArray(machineAccounts.kind, [...NEXT_ACCOUNT_KINDS]),
  isNull(machineAccounts.provider),
  sql`${machineAccounts.authMethod} is distinct from 'api_key'`,
) as SQL;

/**
 * The accounts of `kind` on `machineId` a run thinking for `person` may go on with at its plan's limit: a movable sign-in
 * (`movableKindSql`) that serves `person` (`accountServesSql`) and thinks for every agent of its owner there (`shared`; a
 * login made for one agent is that agent's only), or one of `keep` (the run's own) whatever its sharing. `ownOnly`:
 * `person`'s own accounts alone (the right hand never goes on with a plan someone else gave it). `asker`: someone
 * besides the agent's owner the run answers (`runAsker`), whom the account's "Atender todos" must take.
 */
export function chainWhereSql(
  orgId: string,
  machineId: string,
  kind: string,
  person: string | null,
  keep: readonly string[],
  ownOnly = false,
  asker: string | null = null,
): SQL {
  return and(
    asker ? audienceAllowsSql("reply", asker) : undefined,
    eq(machineAccounts.orgId, orgId),
    eq(machineAccounts.machineId, machineId),
    eq(machineAccounts.kind, kind),
    movableKindSql,
    ownOnly ? (person ? eq(machineAccounts.createdBy, person) : sql`false`) : accountServesSql(person),
    keep.length > 0
      ? sql`(${inArray(machineAccounts.id, [...keep])} or ${machineAccounts.shared})`
      : eq(machineAccounts.shared, true),
  ) as SQL;
}
