import { and, asc, type Database, eq, inArray, isNull, schema } from "@agenteschat/db";
import { type CredentialSummary, defaultCredentials, isDefaultOf, listCredentials } from "../credentials";
import {
  type AccountOrderGroup,
  LISTED_ACCOUNT_STATUSES,
  listAccountOrder,
  listMachineAccounts,
  type MachineAccountView,
} from "../machine-accounts";
import { can, getMembership } from "../organizations";
import { planKeyFallbackOn } from "./fallback";
import { type AccountRights, accountRights } from "./permissions";
import { type AccountPermissions, accountPermissionsOf, accountPersonOf } from "./serves";

const { machineAccounts, machines, organizationMembers, providerCredentials } = schema;

/** A plan account in the hub, with its computer, its permissions and what the viewer may do with it. */
export interface AiHubAccount extends MachineAccountView {
  machineId: string;
  computer: string;
  permissions: AccountPermissions;
  rights: AccountRights;
}

/** A workspace API key in the hub: that it exists, for everyone; its users and copies only for who manages keys. */
export type AiHubKey = Pick<CredentialSummary, "id" | "provider" | "label" | "keyHint"> &
  Partial<Pick<CredentialSummary, "usedBy" | "endpoint">> & { isDefault: boolean };

/**
 * "Contas de IA" as one view (`GET …/ai-accounts`, `hub`): every plan account on the workspace's computers, whoever
 * connected it, with the viewer's rights; the workspace's live API keys; the order of use; and the API-key switch.
 */
export interface AiHub {
  accounts: AiHubAccount[];
  keys: AiHubKey[];
  order: AccountOrderGroup[];
  /** "Continuar com a chave de API quando todos os planos estiverem no limite" (`planKeyFallback`). */
  keyFallback: boolean;
  /** The viewer adds, renames and removes keys (`manage_credentials`). */
  canManageKeys: boolean;
  /** The viewer turns the API-key switch on or off and moves anyone's account in the order (`configure`). */
  canConfigure: boolean;
}

/** `GET …/ai-accounts`'s `hub` for `userId` (any member). Emails and key ends stay their owner's. */
export async function aiHubView(db: Database, userId: string, orgId: string): Promise<AiHub> {
  const membership = await getMembership(db, userId, orgId);
  if (!membership)
    return { accounts: [], keys: [], order: [], keyFallback: false, canManageKeys: false, canConfigure: false };
  const viewer = accountPersonOf(userId, membership);
  const canManageKeys = can(membership, "manage_credentials");
  const [computers, rows, members, order, keyFallback, keys] = await Promise.all([
    db
      .select({ id: machines.id, name: machines.name })
      .from(machines)
      .where(and(eq(machines.orgId, orgId), isNull(machines.deletedAt)))
      .orderBy(asc(machines.createdAt), asc(machines.id)),
    db
      .select()
      .from(machineAccounts)
      .where(and(eq(machineAccounts.orgId, orgId), inArray(machineAccounts.status, LISTED_ACCOUNT_STATUSES))),
    db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId)),
    listAccountOrder({ db }, userId, orgId),
    planKeyFallbackOn(db, orgId),
    canManageKeys ? listCredentials(db, userId, orgId) : liveKeys(db, orgId),
  ]);
  const inWorkspace = new Set(members.map((m) => m.userId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const accounts: AiHubAccount[] = [];
  for (const m of computers) {
    for (const v of await listMachineAccounts({ db }, orgId, m.id, userId)) {
      const row = byId.get(v.id);
      if (!row) continue;
      accounts.push({
        ...v,
        machineId: m.id,
        computer: m.name,
        permissions: accountPermissionsOf(row),
        rights: accountRights(row, viewer, row.createdBy !== null && inWorkspace.has(row.createdBy)),
      });
    }
  }
  return {
    accounts,
    keys: keys
      .filter((k) => !k.revokedAt)
      .map((k) => ({
        id: k.id,
        provider: k.provider,
        label: k.label,
        keyHint: canManageKeys ? k.keyHint : "",
        isDefault: k.isDefault ?? false,
        ...(canManageKeys && k.usedBy ? { usedBy: k.usedBy } : {}),
        ...(k.endpoint ? { endpoint: k.endpoint } : {}),
      })),
    order,
    keyFallback,
    canManageKeys,
    canConfigure: can(membership, "configure"),
  };
}

/** The live keys as anyone may see them: provider, name, and which is each provider's default (key ends go to key managers only). */
async function liveKeys(db: Database, orgId: string): Promise<(CredentialSummary & { revokedAt: Date | null })[]> {
  const [rows, defaults] = await Promise.all([
    db
      .select()
      .from(providerCredentials)
      .where(and(eq(providerCredentials.orgId, orgId), isNull(providerCredentials.revokedAt)))
      .orderBy(asc(providerCredentials.createdAt)),
    defaultCredentials(db, orgId),
  ]);
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider as CredentialSummary["provider"],
    label: r.label,
    keyHint: r.keyHint,
    workspaceIdHint: null,
    isDefault: isDefaultOf(defaults, r),
    createdAt: r.createdAt,
    revokedAt: r.revokedAt,
  }));
}
