import type { KeyWrapper } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, inArray, isNull, like, schema, sql } from "@agenteschat/db";
import {
  checkOpenRouterKey,
  customModelId,
  customModelOf,
  customModelsOf,
  type EndpointStyle,
  ensureOpenRouterModels,
  isAutoModel,
  isCustomModel,
  isKnownProvider,
  isOpenRouterModel,
  listedModels,
  type ModelInfo,
  modelInfo,
  modelProvider,
  PROVIDERS,
  type ProviderId,
  parseCustomModel,
} from "@agenteschat/providers";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { openSecret, SealedValueError, sealSecret } from "./crypto";
import {
  cleanEndpointModels,
  ENDPOINT_NO_KEY,
  type EndpointModel,
  type EndpointNet,
  endpointAddress,
  loadEndpointModels,
  type StoredEndpoint,
} from "./endpoints";
import {
  ConflictError,
  ForbiddenError,
  MissingCredentialError,
  NotFoundError,
  UNREADABLE_KEY,
  ValidationError,
} from "./errors";
import type { KeyCheck, ModelGateway } from "./gateway";
import { requirePermission } from "./organizations";
import { orgModelProvider } from "./router";
import { billingHold } from "./standing";

const { providerCredentials } = schema;

/** Associated data binding a sealed key to its organization and row. */
const aadFor = (orgId: string, credentialId: string) => `provider-credential|${orgId}|${credentialId}`;

/** Public view of a credential. The key itself is never returned by any API. */
export interface CredentialSummary {
  id: string;
  provider: ProviderId;
  label: string;
  keyHint: string;
  /** Last characters of the workspace id the key is scoped to, if one is set. */
  workspaceIdHint: string | null;
  /** The workspace's default key (used by agents without their own key, router, summaries). */
  isDefault?: boolean;
  /** A workspace endpoint's address, API style and models (`custom`, ADR 0146). Not secret. */
  endpoint?: StoredEndpoint;
  /** The agents that think with it (`listCredentials`): what removing it would change. */
  usedBy?: { id: string; name: string }[];
  /** On a key just saved: `ok` a real call passed, `unchecked` the provider gave no answer about the key. */
  check?: KeyCheckState;
  /** On a key just saved: the workspace already had this key, so the saved one was updated instead of adding a copy. */
  reused?: boolean;
  /** In a list of keys: how many other saved keys are this very key (`sameKey`), which "Remover cópias" folds into it. */
  copies?: number;
  /** In a list of keys: the key this one is a copy of, the row the list shows for both. */
  copyOf?: string;
  createdAt: Date;
  revokedAt: Date | null;
}

/** What a test call could say of a key that was kept. */
export type KeyCheckState = "ok" | "unchecked";

const summary = (row: typeof providerCredentials.$inferSelect): CredentialSummary => ({
  id: row.id,
  provider: row.provider as ProviderId,
  label: row.label,
  keyHint: row.keyHint,
  workspaceIdHint: row.workspaceId ? row.workspaceId.slice(-6) : null,
  ...(row.options?.endpoint ? { endpoint: row.options.endpoint } : {}),
  createdAt: row.createdAt,
  revokedAt: row.revokedAt,
});

function cleanWorkspaceId(id: string | null | undefined) {
  const v = id?.trim();
  if (!v) return null;
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(v)) throw new ValidationError("workspaceId looks invalid");
  return v;
}

/** A key's change in the audit log: the provider, its name and last four characters, never the key. */
function auditCredential(
  db: Executor,
  orgId: string,
  actorId: string,
  action: string,
  row: { id: string; provider: string; label: string; keyHint: string | null },
) {
  return recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action,
    target: { type: "credential", id: row.id },
    details: { provider: row.provider, label: row.label, ...(row.keyHint ? { keyHint: row.keyHint } : {}) },
  });
}

/** The cache key of `openRouterInUse`: about the whole server, no org's. */
const OPENROUTER_IN_USE = "*:openrouter-in-use";

/**
 * Whether any workspace on this server has an OpenRouter key that isn't revoked: OpenRouter's model list is read
 * only then (ADR 0087). Cached like credential rows.
 */
export async function openRouterInUse(db: Executor): Promise<boolean> {
  return (await caches.credentials.getOrLoad(OPENROUTER_IN_USE, async () => {
    const [row] = await db
      .select({ id: providerCredentials.id })
      .from(providerCredentials)
      .where(and(eq(providerCredentials.provider, "openrouter"), isNull(providerCredentials.revokedAt)))
      .limit(1);
    return row !== undefined;
  })) as boolean;
}

/**
 * A model's entry, for a setting someone picks: OpenRouter's list is read first only while it is in use. A workspace
 * endpoint's model (ADR 0146) is found only for its own organization.
 */
export async function modelInfoFor(db: Executor, model: string, orgId?: string): Promise<ModelInfo | undefined> {
  if (isCustomModel(model)) {
    if (!orgId) return undefined;
    await loadEndpointModels(db, orgId);
    return customModelOf(orgId, model);
  }
  if (isOpenRouterModel(model) && (await openRouterInUse(db))) await ensureOpenRouterModels(model);
  return modelInfo(model);
}

/**
 * Every model for the pickers: the catalog's, then OpenRouter's (its list read first only while it is in use), then
 * the endpoint models of `orgIds` (ADR 0146).
 */
export async function pickerModels(db: Executor, orgIds: readonly string[] = []): Promise<[string, ModelInfo][]> {
  if (await openRouterInUse(db)) await ensureOpenRouterModels();
  for (const orgId of orgIds) await loadEndpointModels(db, orgId);
  return [...listedModels(), ...orgIds.flatMap((orgId) => customModelsOf(orgId))];
}

/**
 * An OpenRouter key is checked with OpenRouter before it is stored (no model call): a refused key or one that only
 * manages keys is never kept. A check that gets no answer either way lets it be saved.
 */
async function checkKey(provider: string, apiKey: string, http?: typeof fetch) {
  if (provider !== "openrouter") return;
  const state = await checkOpenRouterKey(apiKey, http);
  if (state === "invalid") throw new ValidationError("The provider didn't accept this key.", "provider_key_invalid");
  if (state === "management")
    throw new ValidationError("This is a management key. Create a regular API key.", "provider_key_management");
}

/** The test call a key goes through (the gateway's `verifyKey`), absent on a server with no model gateway. */
export type KeyVerifier = ModelGateway["verifyKey"];

/**
 * What a test call means for a key. A refusal (no such key, no credit, no permission) is never kept: it comes back with
 * the provider's name and words. A provider that gives no answer about the key doesn't stop anything.
 */
function passedCheck(providerId: string, result: KeyCheck | undefined) {
  if (result?.state === "refused") {
    const provider = PROVIDERS[providerId as ProviderId]?.label ?? providerId;
    throw new ValidationError(`${provider} refused this key.`, `provider_key_${result.refusal}`, {
      provider,
      said: result.said,
    });
  }
  return result?.state === "ok" ? result : null;
}

/** A key is no way around a billing hold: it would only sit there reading as ready. */
async function assertKeysOpen(db: Database, orgId: string) {
  if (await billingHold(db, orgId)) {
    throw new ForbiddenError("API keys open with the workspace's agentes.chat plan", "credentials.plan_hold");
  }
}

/** Stores an org's provider API key, encrypted (envelope encryption). */
export async function createCredential(
  db: Database,
  keyWrapper: KeyWrapper,
  actorId: string,
  orgId: string,
  input: {
    provider: ProviderId;
    label: string;
    apiKey: string;
    workspaceId?: string | null;
    /** OpenAI organization and project ids, when the key needs them. */
    organization?: string | null;
    project?: string | null;
    /** Make it the workspace's default key (onboarding does this in the same call). */
    makeDefault?: boolean;
    /** `custom` only, and required there: the endpoint's address, API style and models (ADR 0146). */
    endpoint?: { style: EndpointStyle; baseURL: string; models: EndpointModel[] };
  },
  /**
   * Outbound HTTP for the provider's key check (tests: a fake); `net`: how endpoints may be reached; `keyWrappers`:
   * every wrapper saved keys may be sealed with, to find this key among them (default: `keyWrapper` alone).
   */
  opts: { fetch?: typeof fetch; net?: EndpointNet; verify?: KeyVerifier; keyWrappers?: KeyWrapper[] } = {},
): Promise<CredentialSummary> {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  await assertKeysOpen(db, orgId);
  if (!isKnownProvider(input.provider)) throw new ValidationError(`Unknown provider ${input.provider}`);
  const custom = input.provider === "custom";
  if (custom !== Boolean(input.endpoint))
    throw new ValidationError(custom ? "An endpoint needs its address and models" : "Only an endpoint has an address");
  // A key-less server (a local Ollama) gets a word the SDKs accept.
  const apiKey = input.apiKey.trim() || (custom ? ENDPOINT_NO_KEY : "");
  if (apiKey.length < (custom ? 1 : 8)) throw new ValidationError("apiKey looks too short");
  const endpoint: StoredEndpoint | undefined = input.endpoint && {
    style: input.endpoint.style,
    baseURL: await endpointAddress(input.endpoint.baseURL, input.endpoint.style, opts.net ?? { allowPrivate: false }),
    models: cleanEndpointModels(input.endpoint.models),
  };
  await checkKey(input.provider, apiKey, opts.fetch);
  const options = cleanOptions(input);
  const workspaceId = cleanWorkspaceId(input.workspaceId);
  const passed = custom
    ? null
    : passedCheck(
        input.provider,
        await opts.verify?.({
          orgId,
          provider: input.provider,
          key: { apiKey, ...(workspaceId ? { workspaceId } : {}), ...options },
        }),
      );
  const keyHint = apiKey === ENDPOINT_NO_KEY ? "" : apiKey.slice(-4);
  const fresh = {
    provider: input.provider,
    keyHint,
    workspaceId,
    options: { ...options, ...(endpoint ? { endpoint } : {}) },
  };
  const [same] = await savedCopies(db, opts.keyWrappers ?? [keyWrapper], orgId, fresh, apiKey);
  const row = same
    ? await resave(db, actorId, orgId, same, { ...input, endpoint })
    : await db.transaction(async (tx) => {
        const id = crypto.randomUUID();
        const sealed = await sealSecret(keyWrapper, apiKey, aadFor(orgId, id));
        const [r] = await tx
          .insert(providerCredentials)
          .values({
            id,
            orgId,
            label: input.label,
            secretCiphertext: sealed.ciphertext,
            wrappedDataKey: sealed.wrappedDataKey,
            kekId: sealed.kekId,
            ...fresh,
            createdByUserId: actorId,
          })
          .returning();
        if (input.makeDefault) await setDefault(tx, orgId, input.provider, id);
        if (r) await auditCredential(tx, orgId, actorId, "credential.added", r);
        return r;
      });
  if (!row) throw new Error("credential insert returned nothing");
  invalidateDefaults(orgId);
  if (input.provider === "openrouter") {
    caches.credentials.delete(OPENROUTER_IN_USE);
    // Its models, ready for the pickers.
    void ensureOpenRouterModels();
  }
  await passed?.record(row.id);
  return {
    ...summary(row),
    isDefault:
      input.makeDefault === true || (same !== undefined && isDefaultOf(await defaultCredentials(db, orgId), row)),
    ...(custom ? {} : { check: passed ? ("ok" as const) : ("unchecked" as const) }),
    ...(same ? { reused: true } : {}),
  };
}

type CredentialRow = typeof providerCredentials.$inferSelect;
type KeyShape = Pick<CredentialRow, "provider" | "keyHint" | "workspaceId" | "options">;

/**
 * What must match, besides the secret, for two saved keys to be the same key: the provider, its last characters, the
 * workspace it is scoped to, an OpenAI organization and project, and an endpoint's address. One secret set up two ways
 * is two keys.
 */
const shapeOf = (r: KeyShape) =>
  JSON.stringify([
    r.provider,
    r.keyHint,
    r.workspaceId ?? null,
    r.options?.organization ?? null,
    r.options?.project ?? null,
    r.options?.endpoint?.baseURL ?? null,
  ]);

/** A saved key's secret, or null when no wrapper here opens it (then it is never taken for a copy). */
async function secretOf(keyWrappers: KeyWrapper[], row: CredentialRow) {
  try {
    return await openSecret(
      keyWrappers,
      { ciphertext: row.secretCiphertext, wrappedDataKey: row.wrappedDataKey, kekId: row.kekId },
      aadFor(row.orgId, row.id),
    );
  } catch {
    return null;
  }
}

/**
 * The workspace's live keys that are `key` with this `secret`, oldest first. Only rows of the same shape are opened,
 * so a list with no look-alikes opens none.
 */
async function savedCopies(db: Executor, keyWrappers: KeyWrapper[], orgId: string, key: KeyShape, secret: string) {
  const rows = await db
    .select()
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.orgId, orgId),
        eq(providerCredentials.provider, key.provider),
        eq(providerCredentials.keyHint, key.keyHint),
        isNull(providerCredentials.revokedAt),
      ),
    )
    .orderBy(asc(providerCredentials.createdAt));
  const shape = shapeOf(key);
  const out: CredentialRow[] = [];
  for (const r of rows) if (shapeOf(r) === shape && (await secretOf(keyWrappers, r)) === secret) out.push(r);
  return out;
}

/**
 * Saving a key the workspace already has: the saved one takes the new details (its name, unless the new one is just
 * the provider's; an endpoint's API and models, keeping a model's last test while its API stays) and keeps its id, so
 * its agents, default and spend stay on it.
 */
async function resave(
  db: Database,
  actorId: string,
  orgId: string,
  row: CredentialRow,
  input: { provider: ProviderId; label: string; makeDefault?: boolean; endpoint?: StoredEndpoint | undefined },
) {
  const before = row.options.endpoint;
  const endpoint = input.endpoint && {
    ...input.endpoint,
    models: cleanEndpointModels(input.endpoint.models, before?.style === input.endpoint.style ? before.models : []),
  };
  const label = input.label === PROVIDERS[input.provider].label ? row.label : input.label;
  return db.transaction(async (tx) => {
    const [r] = await tx
      .update(providerCredentials)
      .set({ label, ...(endpoint ? { options: { ...row.options, endpoint } } : {}) })
      .where(and(eq(providerCredentials.id, row.id), eq(providerCredentials.orgId, orgId)))
      .returning();
    if (input.makeDefault) await setDefault(tx, orgId, input.provider, row.id);
    if (r) await auditCredential(tx, orgId, actorId, "credential.resaved", r);
    caches.credentials.delete(`${orgId}:${row.id}`);
    return r;
  });
}

/** Whether a key is the one its provider's calls take by default: its provider's default, else the single default. */
export const isDefaultOf = (
  defaults: Awaited<ReturnType<typeof defaultCredentials>>,
  r: { id: string; provider: string },
) => (defaults.perProvider[r.provider] ? defaults.perProvider[r.provider] === r.id : defaults.legacy === r.id);

/**
 * Tries a stored key again (admins), before an agent is pointed at it: a key kept before this check, or one whose
 * credit ran out since, gets the same answer as on save.
 */
export async function checkCredential(
  db: Database,
  gateway: Pick<ModelGateway, "verifyStoredKey">,
  actorId: string,
  orgId: string,
  credentialId: string,
): Promise<KeyCheckState> {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  const stored = await gateway.verifyStoredKey(orgId, credentialId);
  if (!stored) throw new NotFoundError("Credential not found");
  const passed = passedCheck(stored.provider, stored.result);
  await passed?.record(credentialId);
  return passed ? "ok" : "unchecked";
}

function cleanOptions(input: { organization?: string | null; project?: string | null }) {
  const out: { organization?: string; project?: string } = {};
  for (const key of ["organization", "project"] as const) {
    const v = input[key]?.trim();
    if (!v) continue;
    if (!/^[A-Za-z0-9_-]{3,128}$/.test(v)) throw new ValidationError(`${key} looks invalid`);
    out[key] = v;
  }
  return out;
}

/** Forgets which credential is each provider's default for an org, and its endpoints (after any key or settings change). */
export function invalidateDefaults(orgId: string) {
  caches.credentials.deletePrefix(`${orgId}:default:`);
  caches.credentials.delete(`${orgId}:endpoints`);
}

/** Makes a key its provider's default (and the legacy single default), in the caller's transaction. */
async function setDefault(tx: Executor, orgId: string, provider: string, credentialId: string) {
  const patch = sql`coalesce(${schema.organizationSettings.defaultCredentialIds}, '{}'::jsonb) || jsonb_build_object(${provider}::text, ${credentialId}::text)`;
  await tx
    .insert(schema.organizationSettings)
    .values({ orgId, defaultCredentialId: credentialId, defaultCredentialIds: { [provider]: credentialId } })
    .onConflictDoUpdate({
      target: schema.organizationSettings.orgId,
      set: { defaultCredentialId: credentialId, defaultCredentialIds: patch, updatedAt: new Date() },
    });
}

/** "Make default": a key becomes its provider's default for the workspace (admins). */
export async function makeDefaultCredential(db: Database, actorId: string, orgId: string, credentialId: string) {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  const [row] = await db
    .select()
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.id, credentialId),
        eq(providerCredentials.orgId, orgId),
        isNull(providerCredentials.revokedAt),
      ),
    );
  if (!row) throw new NotFoundError("Credential not found");
  await setDefault(db, orgId, row.provider, credentialId);
  await auditCredential(db, orgId, actorId, "credential.default_changed", row);
  invalidateDefaults(orgId);
  return { ...summary(row), isDefault: true };
}

/** The workspace's default keys: per provider, plus the legacy single default. */
export async function defaultCredentials(db: Database, orgId: string) {
  const [row] = await db
    .select({
      id: schema.organizationSettings.defaultCredentialId,
      ids: schema.organizationSettings.defaultCredentialIds,
    })
    .from(schema.organizationSettings)
    .where(eq(schema.organizationSettings.orgId, orgId));
  return { legacy: row?.id ?? null, perProvider: (row?.ids ?? {}) as Partial<Record<string, string>> };
}

/** The workspace's default credential id (legacy single default), if one is set. */
export async function defaultCredentialId(db: Database, orgId: string) {
  return (await defaultCredentials(db, orgId)).legacy;
}

/** Removing a default key would leave its provider without one: refused unless the person said to go on (`release`). */
async function refuseIfDefault(db: Database, orgId: string, credentialId: string) {
  const d = await defaultCredentials(db, orgId);
  if (d.legacy === credentialId || Object.values(d.perProvider).includes(credentialId)) {
    throw new ConflictError(
      "This is the workspace's default key. Make another key the default first.",
      "credential.default",
    );
  }
}

/** The key stops being a default: its provider's next call takes the newest key left, as with no default set. */
async function dropDefault(tx: Executor, orgId: string, credentialId: string) {
  await tx
    .update(schema.organizationSettings)
    .set({
      defaultCredentialId: sql`nullif(${schema.organizationSettings.defaultCredentialId}, ${credentialId}::uuid)`,
      defaultCredentialIds: sql`coalesce((select jsonb_object_agg(key, value) from jsonb_each(${schema.organizationSettings.defaultCredentialIds}) where value <> to_jsonb(${credentialId}::text)), '{}'::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(schema.organizationSettings.orgId, orgId));
}

/**
 * The key a provider's calls take with no key of their own, of an org's keys oldest first: its default, the single
 * default of old when it is of that provider, else its newest (`resolveKey`'s order).
 */
export function providerKeyOf<K extends { id: string; provider: string; revokedAt: Date | null }>(
  rows: readonly K[],
  defaults: Awaited<ReturnType<typeof defaultCredentials>>,
  provider: string | undefined,
) {
  const live = rows.filter((r) => r.provider === provider && !r.revokedAt);
  const chosen = provider ? defaults.perProvider[provider] : undefined;
  return live.find((r) => r.id === chosen) ?? live.find((r) => r.id === defaults.legacy) ?? live.at(-1) ?? null;
}

/**
 * The workspace's keys, oldest first. With `keyWrappers`, the same key saved more than once is told (`copies` on the
 * row a list shows, `copyOf` on the others): the default first, else the one most agents use, else the oldest.
 */
export async function listCredentials(
  db: Database,
  actorId: string,
  orgId: string,
  keyWrappers?: KeyWrapper[],
): Promise<CredentialSummary[]> {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  const [rows, defaults, agents, autoProvider] = await Promise.all([
    db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.orgId, orgId))
      .orderBy(asc(providerCredentials.createdAt)),
    defaultCredentials(db, orgId),
    db
      .select({
        id: schema.agents.id,
        name: schema.agents.name,
        credentialId: schema.agents.credentialId,
        model: schema.agents.model,
        brain: schema.agents.brain,
      })
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, orgId), isNull(schema.agents.archivedAt))),
    orgModelProvider(db, orgId),
  ]);
  // An agent with no key of its own thinks with its provider's key all the same: removing that one changes it too.
  const keyOf = (a: (typeof agents)[number]) => {
    const own = parseCustomModel(a.model)?.credentialId ?? a.credentialId;
    if (own || a.brain !== "model") return own;
    return providerKeyOf(rows, defaults, isAutoModel(a.model) ? autoProvider : modelProvider(a.model))?.id;
  };
  const usedBy = (id: string) => agents.filter((a) => keyOf(a) === id).map((a) => ({ id: a.id, name: a.name }));
  const out = rows.map((r) => ({ ...summary(r), isDefault: isDefaultOf(defaults, r), usedBy: usedBy(r.id) }));
  if (!keyWrappers) return out;
  const byId = new Map(out.map((k) => [k.id, k]));
  const rank = (k: CredentialSummary) => (k.isDefault ? 1_000_000 : 0) + (k.usedBy?.length ?? 0);
  for (const group of await copyGroups(keyWrappers, rows)) {
    const keys = group.flatMap((r) => byId.get(r.id) ?? []);
    const kept = keys.reduce((best, k) => (rank(k) > rank(best) ? k : best));
    kept.copies = keys.length - 1;
    for (const k of keys) if (k !== kept) k.copyOf = kept.id;
  }
  return out;
}

/** The live keys saved more than once, each group the rows of one key. Only rows of a shared shape are opened. */
async function copyGroups(keyWrappers: KeyWrapper[], rows: readonly CredentialRow[]) {
  const shapes = new Map<string, CredentialRow[]>();
  for (const r of rows) if (!r.revokedAt) shapes.set(shapeOf(r), [...(shapes.get(shapeOf(r)) ?? []), r]);
  const groups: CredentialRow[][] = [];
  for (const alike of shapes.values()) {
    if (alike.length < 2) continue;
    const bySecret = new Map<string, CredentialRow[]>();
    for (const r of alike) {
      const secret = await secretOf(keyWrappers, r);
      if (secret !== null) bySecret.set(secret, [...(bySecret.get(secret) ?? []), r]);
    }
    groups.push(...[...bySecret.values()].filter((g) => g.length > 1));
  }
  return groups;
}

/** Revoked keys stay stored (usage records point at them) but can no longer be decrypted for calls. */
export async function revokeCredential(db: Database, actorId: string, orgId: string, credentialId: string) {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  await refuseIfDefault(db, orgId, credentialId);
  const [row] = await db
    .update(providerCredentials)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(providerCredentials.id, credentialId),
        eq(providerCredentials.orgId, orgId),
        isNull(providerCredentials.revokedAt),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError("Credential not found");
  await auditCredential(db, orgId, actorId, "credential.revoked", row);
  caches.credentials.delete(`${orgId}:${credentialId}`);
  invalidateDefaults(orgId);
}

/**
 * A credential that isn't revoked, as stored (its key still sealed). Org-scoped. The row is cached;
 * the key is decrypted per call and never cached.
 */
export async function usableCredentialRow(db: Executor, orgId: string, credentialId: string) {
  return (await caches.credentials.getOrLoad(`${orgId}:${credentialId}`, async () => {
    const [r] = await db
      .select()
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.id, credentialId),
          eq(providerCredentials.orgId, orgId),
          isNull(providerCredentials.revokedAt),
        ),
      );
    return r ?? null;
  })) as typeof providerCredentials.$inferSelect | null;
}

/**
 * Decrypts a credential for a model call. Backend-only: the Model Gateway, and
 * Jev's key route when a server's owner hands Jev the workspace's OpenRouter key
 * (ADR 0073 §9). Org-scoped: a credential id from another org is not found.
 */
export async function decryptCredential(
  db: Database,
  keyWrappers: KeyWrapper[],
  orgId: string,
  credentialId: string,
): Promise<{
  provider: ProviderId;
  apiKey: string;
  workspaceId?: string;
  options?: { organization?: string; project?: string; endpoint?: StoredEndpoint };
} | null> {
  const row = await usableCredentialRow(db, orgId, credentialId);
  if (!row) return null;
  const apiKey = await openSecret(
    keyWrappers,
    { ciphertext: row.secretCiphertext, wrappedDataKey: row.wrappedDataKey, kekId: row.kekId },
    aadFor(orgId, row.id),
  ).catch((error) => {
    // Permanent: a retry opens it no better, so the run fails at once saying what to do.
    if (error instanceof SealedValueError) throw new MissingCredentialError(UNREADABLE_KEY);
    throw error;
  });
  return {
    provider: row.provider as ProviderId,
    apiKey,
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    options: row.options ?? {},
  };
}

/**
 * Replaces the key of a credential, keeping its id (agents keep pointing at
 * it). The old ciphertext is overwritten; usage history is untouched.
 */
export async function rotateCredential(
  db: Database,
  keyWrapper: KeyWrapper,
  actorId: string,
  orgId: string,
  credentialId: string,
  input: {
    apiKey: string;
    label?: string;
    workspaceId?: string | null;
    organization?: string | null;
    project?: string | null;
  },
  /** Outbound HTTP for the provider's key check (tests: a fake). */
  opts: { fetch?: typeof fetch; verify?: KeyVerifier } = {},
): Promise<CredentialSummary> {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  await assertKeysOpen(db, orgId);
  const apiKey = input.apiKey.trim();
  if (apiKey.length < 8) throw new ValidationError("apiKey looks too short");
  // The values are checked before the credential is read: a bad one is refused whatever the credential.
  const values = {
    ...(input.label ? { label: input.label } : {}),
    ...(input.workspaceId !== undefined ? { workspaceId: cleanWorkspaceId(input.workspaceId) } : {}),
    ...(input.organization !== undefined || input.project !== undefined ? { options: cleanOptions(input) } : {}),
  };
  const current = await usableCredentialRow(db, orgId, credentialId);
  if (!current) throw new NotFoundError("Credential not found");
  await checkKey(current.provider, apiKey, opts.fetch);
  const custom = current.provider === "custom";
  const scoped = values.workspaceId ?? current.workspaceId;
  const passed = custom
    ? null
    : passedCheck(
        current.provider,
        await opts.verify?.({
          orgId,
          provider: current.provider,
          key: {
            apiKey,
            ...(scoped ? { workspaceId: scoped } : {}),
            ...cleanOptions(values.options ?? current.options),
          },
        }),
      );
  const sealed = await sealSecret(keyWrapper, apiKey, aadFor(orgId, credentialId));
  const endpoint = current.options.endpoint;
  const [row] = await db
    .update(providerCredentials)
    .set({
      secretCiphertext: sealed.ciphertext,
      wrappedDataKey: sealed.wrappedDataKey,
      kekId: sealed.kekId,
      keyHint: apiKey.slice(-4),
      ...values,
      // An endpoint's address and models stay as they are. Their test calls were made with the old key, and an endpoint
      // key's check is read from them (`verifyStoredKey`), so they are cleared until the models are tested again.
      ...(endpoint
        ? {
            options: {
              ...(values.options ?? current.options),
              endpoint: { ...endpoint, models: endpoint.models.map(({ check: _check, ...m }) => m) },
            },
          }
        : {}),
    })
    .where(
      and(
        eq(providerCredentials.id, credentialId),
        eq(providerCredentials.orgId, orgId),
        isNull(providerCredentials.revokedAt),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError("Credential not found");
  await auditCredential(db, orgId, actorId, "credential.key_changed", row);
  caches.credentials.delete(`${orgId}:${credentialId}`);
  invalidateDefaults(orgId);
  await passed?.record(row.id);
  return { ...summary(row), ...(custom ? {} : { check: passed ? ("ok" as const) : ("unchecked" as const) }) };
}

/**
 * Deletes a credential for good (the sealed key is gone). Refused while it is a default or agents use it, with what
 * stands in the way, since they would move to another key without anyone choosing. `release`: the person read what
 * happens and goes on: those agents lose their pin and resolve as any agent with no key of its own (the provider's
 * default, its newest key, the platform's), or say they have no AI.
 */
export async function deleteCredential(
  db: Database,
  actorId: string,
  orgId: string,
  credentialId: string,
  options: { release?: boolean } = {},
) {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  const users = await db
    .select({ id: schema.agents.id, handle: schema.agents.handle, name: schema.agents.name })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.orgId, orgId),
        eq(schema.agents.credentialId, credentialId),
        isNull(schema.agents.archivedAt),
      ),
    );
  if (!options.release) {
    await refuseIfDefault(db, orgId, credentialId);
    if (users.length > 0) {
      throw new ConflictError(
        `In use by ${users.map((u) => `@${u.handle}`).join(", ")}. Point them at another key first.`,
        "credential.in_use",
        { agents: users.map((u) => u.name).join(", ") },
      );
    }
  }
  const deleted = await db.transaction(async (tx) => {
    if (options.release) await dropDefault(tx, orgId, credentialId);
    return tx
      .delete(providerCredentials)
      .where(and(eq(providerCredentials.id, credentialId), eq(providerCredentials.orgId, orgId)))
      .returning({
        id: providerCredentials.id,
        provider: providerCredentials.provider,
        label: providerCredentials.label,
        keyHint: providerCredentials.keyHint,
      });
  });
  if (!deleted[0]) throw new NotFoundError("Credential not found");
  await auditCredential(db, orgId, actorId, "credential.deleted", deleted[0]);
  caches.credentials.delete(`${orgId}:${credentialId}`);
  for (const u of users) caches.agents.delete(`${orgId}:${u.id}`);
  invalidateDefaults(orgId);
}

/**
 * "Remover cópias": the other saved copies of this key fold into it, in one step the person confirmed. Everything that
 * names a copy moves to the kept key first (agents, the model id of an agent on an endpoint, the workspace's defaults,
 * router and summary models, the new-agent setup, past spend, an endpoint's models), so no agent loses its AI and the
 * spend history keeps which key paid. Then the copies are deleted.
 */
export async function removeCredentialCopies(
  db: Database,
  keyWrappers: KeyWrapper[],
  actorId: string,
  orgId: string,
  credentialId: string,
): Promise<{ removed: number }> {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  const [kept] = await db
    .select()
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.id, credentialId),
        eq(providerCredentials.orgId, orgId),
        isNull(providerCredentials.revokedAt),
      ),
    );
  if (!kept) throw new NotFoundError("Credential not found");
  const secret = await secretOf(keyWrappers, kept);
  const copies =
    secret === null ? [] : (await savedCopies(db, keyWrappers, orgId, kept, secret)).filter((r) => r.id !== kept.id);
  if (copies.length === 0) return { removed: 0 };
  const ids = copies.map((r) => r.id);
  const { agents, usageRecords, organizationSettings } = schema;
  const renamed = (model: string | null) => {
    const parsed = model ? parseCustomModel(model) : null;
    return parsed && ids.includes(parsed.credentialId) ? customModelId(kept.id, parsed.model) : model;
  };
  const moved = await db.transaction(async (tx) => {
    const movedAgents = await tx
      .update(agents)
      .set({ credentialId: kept.id })
      .where(and(eq(agents.orgId, orgId), inArray(agents.credentialId, ids)))
      .returning({ id: agents.id });
    for (const id of ids) {
      const from = customModelId(id, "");
      const to = customModelId(kept.id, "");
      const swap = (col: typeof agents.model | typeof usageRecords.model | typeof usageRecords.requestedModel) =>
        sql`${to} || substr(${col}, ${from.length + 1})`;
      movedAgents.push(
        ...(await tx
          .update(agents)
          .set({ model: swap(agents.model) })
          .where(and(eq(agents.orgId, orgId), like(agents.model, `${from}%`)))
          .returning({ id: agents.id })),
      );
      await tx
        .update(usageRecords)
        .set({ credentialId: kept.id })
        .where(and(eq(usageRecords.orgId, orgId), eq(usageRecords.credentialId, id)));
      await tx
        .update(usageRecords)
        .set({ model: swap(usageRecords.model) })
        .where(and(eq(usageRecords.orgId, orgId), like(usageRecords.model, `${from}%`)));
      await tx
        .update(usageRecords)
        .set({ requestedModel: swap(usageRecords.requestedModel) })
        .where(and(eq(usageRecords.orgId, orgId), like(usageRecords.requestedModel, `${from}%`)));
    }
    const [settings] = await tx.select().from(organizationSettings).where(eq(organizationSettings.orgId, orgId));
    if (settings) {
      const swapId = (id: string) => (ids.includes(id) ? kept.id : id);
      const perProvider: Record<string, string> = {};
      for (const [provider, id] of Object.entries(settings.defaultCredentialIds))
        if (id) perProvider[provider] = swapId(id);
      const setup = settings.agentSetup;
      await tx
        .update(organizationSettings)
        .set({
          defaultCredentialId: settings.defaultCredentialId && swapId(settings.defaultCredentialId),
          defaultCredentialIds: perProvider,
          routerModel: renamed(settings.routerModel),
          summaryModel: renamed(settings.summaryModel),
          agentSetup: setup && {
            ...setup,
            model: renamed(setup.model),
            ...(setup.key ? { key: swapId(setup.key) } : {}),
          },
          updatedAt: new Date(),
        })
        .where(eq(organizationSettings.orgId, orgId));
    }
    // A model an agent picked on a copy stays offered on the kept key.
    const endpoint = kept.options.endpoint;
    if (endpoint) {
      const models = [...endpoint.models];
      for (const m of copies.flatMap((r) => r.options.endpoint?.models ?? []))
        if (!models.some((o) => o.id === m.id)) models.push(m);
      await tx
        .update(providerCredentials)
        .set({ options: { ...kept.options, endpoint: { ...endpoint, models } } })
        .where(eq(providerCredentials.id, kept.id));
    }
    await tx
      .delete(providerCredentials)
      .where(and(eq(providerCredentials.orgId, orgId), inArray(providerCredentials.id, ids)));
    for (const r of copies) await auditCredential(tx, orgId, actorId, "credential.copy_removed", r);
    return movedAgents;
  });
  for (const id of [kept.id, ...ids]) caches.credentials.delete(`${orgId}:${id}`);
  for (const a of moved) caches.agents.delete(`${orgId}:${a.id}`);
  invalidateDefaults(orgId);
  return { removed: ids.length };
}

/** How many active agents use each credential. */
export async function credentialUsage(db: Database, orgId: string) {
  const rows = await db
    .select({ credentialId: schema.agents.credentialId })
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, orgId), isNull(schema.agents.archivedAt)));
  const counts = new Map<string, number>();
  for (const r of rows) if (r.credentialId) counts.set(r.credentialId, (counts.get(r.credentialId) ?? 0) + 1);
  return counts;
}

/** Providers this org can call: it has an active key of its own, or the platform offers one. */
export async function availableProviders(
  db: Database,
  orgId: string,
  platform: {
    available?(orgId: string, provider: string): Promise<boolean>;
    resolve(orgId: string, provider: string): Promise<unknown>;
  },
  providers: string[],
) {
  const rows = await db
    .select({ provider: providerCredentials.provider })
    .from(providerCredentials)
    .where(and(eq(providerCredentials.orgId, orgId), isNull(providerCredentials.revokedAt)));
  const own = new Set(rows.map((r) => r.provider));
  const out = new Map<string, { own: boolean; platform: boolean }>();
  for (const p of providers) {
    const viaPlatform = platform.available
      ? await platform.available(orgId, p)
      : (await platform.resolve(orgId, p)) !== null;
    out.set(p, { own: own.has(p), platform: viaPlatform });
  }
  return out;
}
