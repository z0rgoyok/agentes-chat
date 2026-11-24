import { and, type Executor, eq, inArray, type SQL, schema, sql } from "@agenteschat/db";
import { can, type Membership } from "../organizations";
import { maySql } from "../permissions";

const { machineAccounts, organizationMemberRoles } = schema;

/**
 * Who besides its owner holds one of an account's permissions: nobody (`owner`), administrators (`admins`), the
 * holders of some roles (`roles`), some people (`people`) or everyone in the workspace.
 */
export type AccountAudienceMode = "owner" | "admins" | "roles" | "people" | "everyone";
export const ACCOUNT_AUDIENCE_MODES: readonly AccountAudienceMode[] = [
  "owner",
  "admins",
  "roles",
  "people",
  "everyone",
];

export interface AccountAudience {
  mode: AccountAudienceMode;
  /** With `people`. */
  userIds: string[];
  /** With `roles`. */
  roleIds: string[];
}

/**
 * An account's permissions. `manage` ("Gerenciar"): rename it, remove it, choose `use`. `use` ("Usar em agentes"):
 * whose agents (by the agent's owner) and whose right hand may think with it. `reply` ("Atender todos"): whom an agent
 * on it answers besides the agent's own owner (`owner`: nobody else). Its owner always manages and uses it.
 */
export interface AccountPermissions {
  manage: AccountAudience;
  use: AccountAudience;
  reply: AccountAudience;
}

export type AccountRight = keyof AccountPermissions;

/** The outbox job telling an account's owner that someone else let more people use it (`queueAccountOpenedEmail`). */
export const ACCOUNT_OPENED_JOB = "account.opened";
export const ACCOUNT_RIGHTS: readonly AccountRight[] = ["manage", "use", "reply"];

const audience = (mode: AccountAudienceMode): AccountAudience => ({ mode, userIds: [], roleIds: [] });

/** What a new account starts with: whoever added it and the administrators manage it, everyone uses it, agents on it answer their own owner. */
export const DEFAULT_ACCOUNT_PERMISSIONS: AccountPermissions = {
  manage: audience("admins"),
  use: audience("everyone"),
  reply: audience("owner"),
};

export const isAccountAudienceMode = (v: unknown): v is AccountAudienceMode =>
  typeof v === "string" && (ACCOUNT_AUDIENCE_MODES as readonly string[]).includes(v);

type PermissionColumns = Pick<
  typeof machineAccounts.$inferSelect,
  | "manageMode"
  | "manageUserIds"
  | "manageRoleIds"
  | "useMode"
  | "useUserIds"
  | "useRoleIds"
  | "replyMode"
  | "replyUserIds"
  | "replyRoleIds"
>;

const audienceOf = (mode: string, userIds: string[], roleIds: string[]): AccountAudience => {
  const m = isAccountAudienceMode(mode) ? mode : "owner";
  return { mode: m, userIds: m === "people" ? userIds : [], roleIds: m === "roles" ? roleIds : [] };
};

/** An account row's permissions, each list kept only under the mode that reads it. */
export const accountPermissionsOf = (row: PermissionColumns): AccountPermissions => ({
  manage: audienceOf(row.manageMode, row.manageUserIds, row.manageRoleIds),
  use: audienceOf(row.useMode, row.useUserIds, row.useRoleIds),
  reply: audienceOf(row.replyMode, row.replyUserIds, row.replyRoleIds),
});

/** A permission as the columns that store it (`machine_accounts.{right}_mode`, `_user_ids`, `_role_ids`). */
export function permissionColumns(right: AccountRight, a: AccountAudience): Partial<PermissionColumns> {
  const lists = {
    mode: a.mode,
    userIds: a.mode === "people" ? a.userIds : [],
    roleIds: a.mode === "roles" ? a.roleIds : [],
  };
  if (right === "manage") return { manageMode: lists.mode, manageUserIds: lists.userIds, manageRoleIds: lists.roleIds };
  if (right === "use") return { useMode: lists.mode, useUserIds: lists.userIds, useRoleIds: lists.roleIds };
  return { replyMode: lists.mode, replyUserIds: lists.userIds, replyRoleIds: lists.roleIds };
}

/** The permissions a new login of an account takes from another login of it (`sameLogins`), `serves` included. */
export const loginPermissions = (row: PermissionColumns & Pick<typeof machineAccounts.$inferSelect, "serves">) => ({
  serves: row.serves,
  manageMode: row.manageMode,
  manageUserIds: row.manageUserIds,
  manageRoleIds: row.manageRoleIds,
  useMode: row.useMode,
  useUserIds: row.useUserIds,
  useRoleIds: row.useRoleIds,
  replyMode: row.replyMode,
  replyUserIds: row.replyUserIds,
  replyRoleIds: row.replyRoleIds,
});

/** A person as the rules read them: their roles, and whether they are an administrator (or the workspace's owner). */
export interface AccountPerson {
  userId: string;
  roleIds: readonly string[];
  admin: boolean;
}

/** A member as the account rules read them, from their membership. */
export const accountPersonOf = (
  userId: string,
  membership: Pick<Membership, "roleIds" | "permissions">,
): AccountPerson => ({ userId, roleIds: membership.roleIds, admin: can(membership, "administrator") });

/** Whether `a` takes `person` (the JS twin of `audienceAllowsSql`). The owner's own place is the caller's. */
export function accountAudienceAllows(a: AccountAudience, person: AccountPerson | null): boolean {
  if (a.mode === "everyone") return true;
  if (!person) return false;
  if (a.mode === "admins") return person.admin;
  if (a.mode === "people") return a.userIds.includes(person.userId);
  if (a.mode === "roles") return a.roleIds.some((id) => person.roleIds.includes(id));
  return false;
}

/** "Gerenciar": rename, remove and choose "Usar em agentes": its owner, whom `manage` takes, an admin when nobody owns it. */
export function managesAccount(
  row: Pick<typeof machineAccounts.$inferSelect, "createdBy"> & PermissionColumns,
  person: AccountPerson,
): boolean {
  if (row.createdBy === null) return person.admin;
  return row.createdBy === person.userId || accountAudienceAllows(accountPermissionsOf(row).manage, person);
}

/** Whether the audience `to` lets in someone `from` didn't (the account's owner aside). */
export function widensAccountAudience(from: AccountAudience, to: AccountAudience): boolean {
  if (from.mode === to.mode && from.mode !== "people" && from.mode !== "roles") return false;
  if (to.mode === "owner" || from.mode === "everyone") return false;
  if (to.mode === "everyone") return true;
  if (to.mode === "admins") return from.mode !== "admins";
  if (to.mode === "people") return from.mode !== "people" || to.userIds.some((id) => !from.userIds.includes(id));
  return from.mode !== "roles" || to.roleIds.some((id) => !from.roleIds.includes(id));
}

/** A right's columns, of the query's `machine_accounts` or of a row aliased `alias`. */
function columns(right: AccountRight, alias?: string) {
  if (alias) {
    const r = (c: string) => sql.raw(`${alias}.${right}_${c}`);
    return { mode: r("mode"), users: r("user_ids"), roles: r("role_ids"), orgId: sql.raw(`${alias}.org_id`) };
  }
  const orgId = machineAccounts.orgId;
  if (right === "manage")
    return {
      mode: machineAccounts.manageMode,
      users: machineAccounts.manageUserIds,
      roles: machineAccounts.manageRoleIds,
      orgId,
    };
  if (right === "use")
    return {
      mode: machineAccounts.useMode,
      users: machineAccounts.useUserIds,
      roles: machineAccounts.useRoleIds,
      orgId,
    };
  return {
    mode: machineAccounts.replyMode,
    users: machineAccounts.replyUserIds,
    roles: machineAccounts.replyRoleIds,
    orgId,
  };
}

const personOf = (person: string | SQL) => (typeof person === "string" ? sql`${person}::text` : person);

/**
 * `accountAudienceAllows` in SQL, for the `machine_accounts` row of the query (or one aliased `alias`) and a person id (null:
 * nobody, which only `everyone` takes).
 */
export function audienceAllowsSql(right: AccountRight, person: string | SQL | null, alias?: string): SQL<boolean> {
  const c = columns(right, alias);
  if (person === null) return sql<boolean>`(${c.mode} = 'everyone')`;
  const p = personOf(person);
  return sql<boolean>`coalesce(${c.mode} = 'everyone'
    or (${c.mode} = 'admins' and ${maySql(c.orgId, p, "administrator")})
    or (${c.mode} = 'people' and ${p} = any(${c.users}))
    or (${c.mode} = 'roles' and exists (select 1 from ${organizationMemberRoles} acct_role
      where acct_role.org_id = ${c.orgId} and acct_role.user_id = ${p} and acct_role.role_id = any(${c.roles}))), false)`;
}

/** The account's owner is still in the workspace: a plan of someone who left serves nobody (ADR 0059 §3). */
export const ownerIsMemberSql = sql<boolean>`exists (select 1 from organization_members acct_om
  where acct_om.org_id = ${machineAccounts.orgId} and acct_om.user_id = ${machineAccounts.createdBy})`;

/**
 * THE rule of who may think with an account (ADR 0059 §3, "Usar em agentes"), for the `machine_accounts` row of the
 * query: `person` (an agent's owner, or whom the right hand answers) is its owner or is in its `use` audience, and its
 * owner is still in the workspace. `person` null (an agent nobody owns, work nobody is behind): only an account that
 * everyone uses.
 */
export function accountServesSql(person: string | SQL | null): SQL<boolean> {
  if (person === null) return sql<boolean>`(${ownerIsMemberSql} and ${audienceAllowsSql("use", null)})`;
  const p = personOf(person);
  return sql<boolean>`(${ownerIsMemberSql}
    and (coalesce(${machineAccounts.createdBy} = ${p}, false) or ${audienceAllowsSql("use", p)}))`;
}

/** Of `accountIds`, those that serve `person` (`accountServesSql`). */
export async function accountsServing(
  db: Executor,
  orgId: string,
  person: string | null,
  accountIds: readonly string[],
): Promise<Set<string>> {
  if (accountIds.length === 0) return new Set();
  const rows = await db
    .select({ id: machineAccounts.id })
    .from(machineAccounts)
    .where(
      and(
        eq(machineAccounts.orgId, orgId),
        inArray(machineAccounts.id, [...new Set(accountIds)]),
        accountServesSql(person),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/** Whether one account serves `person` (`accountServesSql`). */
export const accountServes = async (db: Executor, orgId: string, accountId: string, person: string | null) =>
  (await accountsServing(db, orgId, person, [accountId])).has(accountId);
