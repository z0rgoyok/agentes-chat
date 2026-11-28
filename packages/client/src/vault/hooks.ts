import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "../api/client";
import { useApi } from "../api/context";
import { keys } from "../api/keys";
import { type CacheEdit, edit, optimistic } from "../lib/optimistic";
import type {
  SecretToVaultInput,
  VaultAccess,
  VaultConnectInput,
  VaultConnection,
  VaultConnectionPatch,
  VaultImportInput,
  VaultItem,
  VaultItemDetail,
  VaultItemInput,
  VaultItemPatch,
  VaultKeysImportInput,
  VaultOverview,
  VaultScope,
} from "./types";

/*
 * The Vault in the apps (ADR 0144). What a person types here (a password, a key, a passwords file, a password
 * manager's credentials) never goes into the query cache, and every mutation that carries one is forgotten as soon
 * as nothing watches it (`gcTime: 0`). Nothing here ever brings a saved value back: no answer has one (§2).
 */

/** The client's Vault, or an error on a client without one (an older fake). */
function vaultOf(api: ApiClient): NonNullable<ApiClient["vault"]> {
  if (!api.vault) throw new Error("This server has no Vault");
  return api.vault;
}

/** After a change: everything of the Vault this person may see refetches (the overview and the open item). */
function useVaultRefresh(orgId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: keys.vault(orgId) });
}

/**
 * A change to an item shown before the server answers, in the overview and on its open page. Only what is on screen
 * already: never a value typed into a form (`patch` is built from the item's own fields).
 */
function itemEdits(orgId: string, itemId: string, patch: (item: VaultItem) => Partial<VaultItem> | null): CacheEdit[] {
  return [
    edit<VaultOverview>(keys.vaultOverview(orgId), (overview) => ({
      ...overview,
      items: overview.items.flatMap((item) => {
        if (item.id !== itemId) return [item];
        const next = patch(item);
        return next ? [{ ...item, ...next }] : [];
      }),
    })),
    edit<VaultItemDetail>(keys.vaultItem(orgId, itemId), (open) => {
      const next = patch(open);
      return next ? { ...open, ...next } : open;
    }),
  ];
}

/** The same for a connection (its default access), or null to take it out of the overview. */
function connectionEdits(
  orgId: string,
  connectionId: string,
  patch: (connection: VaultConnection) => Partial<VaultConnection> | null,
): CacheEdit[] {
  return [
    edit<VaultOverview>(keys.vaultOverview(orgId), (overview) => ({
      ...overview,
      connections: overview.connections.flatMap((c) => {
        if (c.id !== connectionId) return [c];
        const next = patch(c);
        return next ? [{ ...c, ...next }] : [];
      }),
    })),
  ];
}

/** The Vault as this person sees it: their personal items, the team ones shared with them, the connections. */
export function useVault(orgId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.vaultOverview(orgId),
    queryFn: () => vaultOf(api).overview(orgId),
    enabled: enabled && Boolean(orgId) && Boolean(api.vault),
  });
}

/** One item with its recent uses; none while `itemId` is empty. */
export function useVaultItem(orgId: string, itemId: string | null | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.vaultItem(orgId, itemId ?? ""),
    queryFn: () => vaultOf(api).item(orgId, itemId ?? ""),
    enabled: Boolean(orgId) && Boolean(itemId) && Boolean(api.vault),
  });
}

export function useCreateVaultItem(orgId: string) {
  const api = useApi();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: (input: VaultItemInput) => vaultOf(api).create(orgId, input),
    meta: { silent: true },
    gcTime: 0,
    onSuccess: () => void refresh(),
  });
}

export function useUpdateVaultItem(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: ({ itemId, ...patch }: VaultItemPatch & { itemId: string }) =>
      vaultOf(api).update(orgId, itemId, patch),
    meta: { silent: true },
    gcTime: 0,
    // Its name, notes, username, key name and access show at once. Never its secret or a contact's fields, and not a
    // website (the server writes it its own way).
    ...optimistic(qc, ({ itemId, ...patch }: VaultItemPatch & { itemId: string }) =>
      itemEdits(orgId, itemId, () => ({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.username !== undefined ? { username: patch.username } : {}),
        ...(patch.keyName !== undefined ? { keyName: patch.keyName } : {}),
        ...(patch.match !== undefined ? { match: patch.match } : {}),
        ...(patch.access !== undefined ? { access: patch.access, accessFromConnection: false } : {}),
        ...(patch.accessFromConnection ? { accessFromConnection: true } : {}),
      })),
    ),
    onSuccess: (item) => {
      // The open item shows the change at once; its uses come with the refetch.
      qc.setQueryData<VaultItemDetail>(keys.vaultItem(orgId, item.id), (open) => (open ? { ...open, ...item } : open));
      void refresh();
    },
  });
}

export function useDeleteVaultItem(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: (itemId: string) => vaultOf(api).remove(orgId, itemId),
    meta: { silent: true },
    ...optimistic(qc, (itemId: string) => itemEdits(orgId, itemId, () => null)),
    onSuccess: (_done, itemId) => {
      // Gone: never asked again (it would answer 404).
      qc.removeQueries({ queryKey: keys.vaultItem(orgId, itemId) });
      void refresh();
    },
  });
}

/** Many items chosen at once: who has access to them, or deleting them. `count`: how many changed. */
export function useVaultBulk(orgId: string) {
  const api = useApi();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: async (
      action: { type: "access"; ids: string[]; access: VaultAccess } | { type: "delete"; ids: string[] },
    ) => {
      if (action.type === "access") {
        const r = await vaultOf(api).setAccessMany(orgId, action.ids, action.access);
        return { count: r.changed, kept: r.kept };
      }
      const r = await vaultOf(api).removeMany(orgId, action.ids);
      return { count: r.deleted, kept: r.kept };
    },
    meta: { silent: true },
    onSuccess: () => void refresh(),
  });
}

/** A passwords file: `dryRun` counts what would happen, then the same call without it imports. */
export function useImportVault(orgId: string) {
  const api = useApi();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: (input: VaultImportInput) => vaultOf(api).importCsv(orgId, input),
    meta: { silent: true },
    gcTime: 0,
    onSuccess: (_result, { dryRun }) => {
      if (!dryRun) void refresh();
    },
  });
}

/** Several keys in one save (an imported .env): the values go once and are forgotten with the mutation. */
export function useImportVaultKeys(orgId: string) {
  const api = useApi();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: (input: VaultKeysImportInput) => vaultOf(api).importKeys(orgId, input),
    meta: { silent: true },
    gcTime: 0,
    onSuccess: () => void refresh(),
  });
}

export function useMoveVaultItem(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: ({ itemId, scope }: { itemId: string; scope: VaultScope }) => vaultOf(api).move(orgId, itemId, scope),
    meta: { silent: true },
    // Under its new place at once; who has access there comes with the answer.
    ...optimistic(qc, ({ itemId, scope }: { itemId: string; scope: VaultScope }) =>
      itemEdits(orgId, itemId, () => ({ scope })),
    ),
    onSuccess: (item) => {
      qc.setQueryData<VaultItemDetail>(keys.vaultItem(orgId, item.id), (open) => (open ? { ...open, ...item } : open));
      void refresh();
    },
  });
}

export function useConnectVault(orgId: string) {
  const api = useApi();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: (input: VaultConnectInput) => vaultOf(api).connect(orgId, input),
    meta: { silent: true },
    gcTime: 0,
    onSuccess: () => void refresh(),
  });
}

/** Default access, or new credentials (reconnect). */
export function useUpdateVaultConnection(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: ({ connectionId, ...patch }: VaultConnectionPatch & { connectionId: string }) =>
      vaultOf(api).updateConnection(orgId, connectionId, patch),
    meta: { silent: true },
    gcTime: 0,
    // Its default access shows at once; new credentials only ever go to the server.
    ...optimistic(qc, ({ connectionId, access }: VaultConnectionPatch & { connectionId: string }) =>
      access ? connectionEdits(orgId, connectionId, () => ({ access })) : [],
    ),
    onSuccess: () => void refresh(),
  });
}

/** "Sync now". */
export function useSyncVaultConnection(orgId: string) {
  const api = useApi();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: (connectionId: string) => vaultOf(api).syncConnection(orgId, connectionId),
    meta: { silent: true },
    onSuccess: () => void refresh(),
  });
}

export function useDeleteVaultConnection(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: (connectionId: string) => vaultOf(api).removeConnection(orgId, connectionId),
    meta: { silent: true },
    // Out of the list at once; its items leave with the refetch.
    ...optimistic(qc, (connectionId: string) => connectionEdits(orgId, connectionId, () => null)),
    onSuccess: () => void refresh(),
  });
}

/** "Save to the Vault" on a secret request's card, after the value was delivered. */
export function useSaveSecretToVault(orgId: string) {
  const api = useApi();
  const refresh = useVaultRefresh(orgId);
  return useMutation({
    mutationFn: ({ requestId, ...input }: SecretToVaultInput & { requestId: string }) => {
      if (!api.secrets.saveToVault) throw new Error("This server has no Vault");
      return api.secrets.saveToVault(orgId, requestId, input);
    },
    meta: { silent: true },
    gcTime: 0,
    onSuccess: () => void refresh(),
  });
}
