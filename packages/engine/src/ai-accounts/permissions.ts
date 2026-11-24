import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, isNull, not, schema, sql } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import {
  forgetAgents,
  LISTED_ACCOUNT_STATUSES,
  type MachineAccountRow,
  publishAccountsChanged,
  releaseAgents,
  sameLogins,
} from "../machine-accounts";
import { publishMachineAgentsChanged } from "../machines";
import { requirePermission } from "../organizations";
import { enqueue } from "../outbox";
import { agentsMovedOnto, wakeAgentsBrainWaits } from "../usage-pause";
import {
  ACCOUNT_OPENED_JOB,
  ACCOUNT_RIGHTS,
  type AccountAudience,
  type AccountPermissions,
  type AccountPerson,
  type AccountRight,
  accountAudienceAllows,
  accountPermissionsOf,
  accountPersonOf,
  accountServesSql,
  isAccountAudienceMode,
  managesAccount,
  permissionColumns,
  widensAccountAudience,
} from "./serves";

const { agents, machineAccounts, organizationMembers, orgRoles, rightHandBrains } = schema;

/** Why the viewer's agents can't think with an account (`AccountRights.useReason`). */
export type AccountUseReason = "signed_out" | "owner_left" | "owner_only" | "not_allowed";

/** What one viewer may do with an account. */
export interface AccountRights {
  /** Rename it, remove it and choose "Usar em agentes": its owner, or whom "Gerenciar" names. */
  canManage: boolean;
  /** Choose "Gerenciar" itself: its owner (an administrator when it has none). */
  canSetManage: boolean;
  /** Their agents and their right hand may think with it (`accountServesSql`); else `useReason`. */
  canUse: boolean;
  useReason?: AccountUseReason;
  /** Choose "Atender todos": its owner or an administrator. */
  canReplyAll: boolean;
}

/** The viewer's rights over an account row (`ownerIsMember`: its owner is still in the workspace). */
export function accountRights(
  row: Pick<MachineAccountRow, "createdBy" | "status"> & Parameters<typeof accountPermissionsOf>[0],
  viewer: AccountPerson,
  ownerIsMember: boolean,
): AccountRights {
  const p = accountPermissionsOf(row);
  const owner = row.createdBy !== null && row.createdBy === viewer.userId;
  const nobodys = row.createdBy === null;
  const serves = ownerIsMember && (owner || accountAudienceAllows(p.use, viewer));
  const useReason: AccountUseReason | undefined =
    row.status !== "active"
      ? "signed_out"
      : !ownerIsMember
        ? "owner_left"
        : serves
          ? undefined
          : p.use.mode === "owner"
            ? "owner_only"
            : "not_allowed";
  return {
    canManage: managesAccount(row, viewer),
    canSetManage: owner || (nobodys && viewer.admin),
    canUse: useReason === undefined,
    ...(useReason ? { useReason } : {}),
    canReplyAll: owner || viewer.admin,
  };
}

/** A change of permissions as the API takes it: only the ones given change. */
export type AccountPermissionsInput = Partial<Record<AccountRight, unknown>>;

/**
 * A permission as people may send it, checked against the workspace: people still in it, its own roles (an unknown
 * role is refused). `people` or `roles` left with nobody is its owner alone.
 */
async function cleanAudience(db: Executor, orgId: string, input: unknown): Promise<AccountAudience> {
  const a = (input ?? {}) as Partial<AccountAudience>;
  if (!isAccountAudienceMode(a.mode)) {
    throw new ValidationError("Choose owner, admins, roles, people or everyone", "account.invalid_permission");
  }
  if (a.mode !== "people" && a.mode !== "roles") return { mode: a.mode, userIds: [], roleIds: [] };
  const list = a.mode === "people" ? a.userIds : a.roleIds;
  if (!Array.isArray(list) || list.some((id) => typeof id !== "string")) {
    throw new ValidationError("A list of ids", "account.invalid_permission");
  }
  const requested = [...new Set(list as string[])];
  if (requested.length > 500) throw new ValidationError("At most 500", "account.invalid_permission");
  if (a.mode === "people") {
    const userIds = requested.length
      ? (
          await db
            .select({ userId: organizationMembers.userId })
            .from(organizationMembers)
            .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, requested)))
        ).map((m) => m.userId)
      : [];
    return userIds.length ? { mode: "people", userIds, roleIds: [] } : { mode: "owner", userIds: [], roleIds: [] };
  }
  const roleIds = requested.length
    ? (
        await db
          .select({ id: orgRoles.id })
          .from(orgRoles)
          .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom"), inArray(orgRoles.id, requested)))
      ).map((r) => r.id)
    : [];
  if (roleIds.length !== requested.length) {
    throw new ValidationError("Every role must be one of the workspace's", "account.invalid_permission");
  }
  return roleIds.length ? { mode: "roles", userIds: [], roleIds } : { mode: "owner", userIds: [], roleIds: [] };
}

/**
 * `PUT …/ai-accounts/{id}/permissions`: changes an account's "Gerenciar", "Usar em agentes" and "Atender todos", for
 * every login of the account. "Gerenciar" is its owner's to choose, "Usar em agentes" whoever manages it, "Atender
 * todos" its owner or an administrator (`account.permission_forbidden`). Fewer people using it moves the agents and
 * the right hand of those it no longer serves off it, as when a plan is taken back (`releaseAgents`). Audited
 * (`account.permissions`); when someone other than its owner lets more people use it or be answered on it, its
 * owner gets one email (`ACCOUNT_OPENED_JOB`).
 */
export async function setAccountPermissions(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  orgId: string,
  accountId: string,
  input: AccountPermissionsInput,
): Promise<{ permissions: AccountPermissions; agentIds: string[] }> {
  const membership = await requirePermission(deps.db, userId, orgId, "read");
  const [row] = await deps.db
    .select()
    .from(machineAccounts)
    .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, accountId)));
  if (!row || !LISTED_ACCOUNT_STATUSES.includes(row.status)) {
    throw new NotFoundError("Account not found", "account.not_found");
  }
  const before = accountPermissionsOf(row);
  const rights = accountRights(row, accountPersonOf(userId, membership), true);
  const next: AccountPermissions = { ...before };
  for (const right of ACCOUNT_RIGHTS) {
    if (input[right] === undefined) continue;
    const allowed = right === "manage" ? rights.canSetManage : right === "use" ? rights.canManage : rights.canReplyAll;
    if (!allowed) {
      throw new ForbiddenError(
        right === "manage"
          ? "Only the person who connected this account chooses who manages it"
          : right === "use"
            ? "Only whoever manages this account chooses whose agents use it"
            : "Only the account's owner or an administrator chooses whom its agents answer",
        "account.permission_forbidden",
        { right },
      );
    }
    next[right] = await cleanAudience(deps.db, orgId, input[right]);
  }
  const changed = ACCOUNT_RIGHTS.filter((r) => JSON.stringify(before[r]) !== JSON.stringify(next[r]));
  if (changed.length === 0) return { permissions: before, agentIds: [] };
  const logins = (await sameLogins(deps.db, row)).map((l) => l.id);
  const set = {
    ...permissionColumns("manage", next.manage),
    ...permissionColumns("use", next.use),
    ...permissionColumns("reply", next.reply),
    // Older apps read "Quem usa" from `serves`.
    serves: next.use.mode === "everyone" ? "everyone" : "owner",
    updatedAt: new Date(),
  };
  const released = await deps.db.transaction(async (tx) => {
    await tx
      .update(machineAccounts)
      .set(set)
      .where(and(eq(machineAccounts.orgId, orgId), inArray(machineAccounts.id, logins)));
    if (!changed.includes("use")) return { agentIds: [], people: 0 };
    const off = await tx
      .select({ id: agents.id })
      .from(agents)
      .innerJoin(
        machineAccounts,
        and(eq(machineAccounts.orgId, agents.orgId), eq(machineAccounts.id, agents.brainAccountId)),
      )
      .where(
        and(
          eq(agents.orgId, orgId),
          inArray(agents.brainAccountId, logins),
          isNull(agents.builtin),
          not(accountServesSql(sql`${agents.ownerUserId}`)),
        ),
      );
    const agentIds = await releaseAgents(
      tx,
      orgId,
      logins,
      new Date(),
      off.map((a) => a.id),
    );
    const gone = await tx
      .select({ userId: rightHandBrains.userId })
      .from(rightHandBrains)
      .innerJoin(
        machineAccounts,
        and(eq(machineAccounts.orgId, rightHandBrains.orgId), eq(machineAccounts.id, rightHandBrains.brainAccountId)),
      )
      .where(
        and(
          eq(rightHandBrains.orgId, orgId),
          inArray(rightHandBrains.brainAccountId, logins),
          not(accountServesSql(sql`${rightHandBrains.userId}`)),
        ),
      );
    if (gone.length > 0) {
      await tx.delete(rightHandBrains).where(
        and(
          eq(rightHandBrains.orgId, orgId),
          inArray(
            rightHandBrains.userId,
            gone.map((g) => g.userId),
          ),
          inArray(rightHandBrains.brainAccountId, logins),
        ),
      );
    }
    return { agentIds, people: gone.length };
  });
  forgetAgents(orgId, released.agentIds);
  const moved = changed.includes("use") ? await agentsMovedOnto(deps.db, orgId, logins) : [];
  await wakeAgentsBrainWaits(deps, orgId, [...released.agentIds, ...moved]);
  if (released.people > 0) await publishMachineAgentsChanged(deps.pubsub, orgId);
  const opened = (["use", "reply"] as const).filter((r) => widensAccountAudience(before[r], next[r]));
  for (const id of logins) {
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: userId },
      action: "account.permissions",
      target: { type: "machine_account", id },
      details: {
        ...Object.fromEntries(changed.map((r) => [r, { from: before[r], to: next[r] }])),
        agents: released.agentIds,
      },
    });
  }
  if (row.createdBy && row.createdBy !== userId) {
    for (const right of opened) {
      await enqueue(deps.db, {
        orgId,
        kind: ACCOUNT_OPENED_JOB,
        payload: { accountId: row.id, actorId: userId, right, from: before[right], to: next[right] },
        dedupeKey: `account-opened:${crypto.randomUUID()}`,
      });
    }
  }
  await publishAccountsChanged(deps.pubsub, orgId, row.machineId);
  return { permissions: next, agentIds: released.agentIds };
}

/**
 * Older apps' "Atende outras pessoas" turned on for an agent on this account: its "Atender todos" becomes everyone, when
 * the caller may choose it (its owner or an administrator) and it isn't already. True when that opened someone else's
 * account (its owner gets the email).
 */
export async function openAccountReplies(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  orgId: string,
  accountId: string,
): Promise<boolean> {
  const membership = await requirePermission(deps.db, userId, orgId, "read");
  const [row] = await deps.db
    .select()
    .from(machineAccounts)
    .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, accountId)));
  if (!row || row.replyMode === "everyone") return false;
  if (!accountRights(row, accountPersonOf(userId, membership), true).canReplyAll) return false;
  await setAccountPermissions(deps, userId, orgId, accountId, {
    reply: { mode: "everyone", userIds: [], roleIds: [] },
  });
  return row.createdBy !== null && row.createdBy !== userId;
}
