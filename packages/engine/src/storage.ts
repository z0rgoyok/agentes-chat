import {
  type BlobLocation,
  type BlobStore,
  type BlobStoreResolver,
  createS3BlobStore,
  type KeyWrapper,
  type S3Fetch,
  type S3Settings,
  StorageError,
} from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  desc,
  type Executor,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  ne,
  or,
  rowsOf,
  schema,
  sql,
} from "@agenteschat/db";
import { recordAudit } from "./audit";
import { openSecret, randomToken, sealSecret, sha256 } from "./crypto";
import { NotFoundError, ValidationError } from "./errors";
import { transcriptKey } from "./file-reader";
import { assertStorageRoom } from "./limits";
import { assertPublicHttpsUrl, outboundFetch, type ResolveHost } from "./net-guard";
import { heavyRead } from "./operator-paging";
import { requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { withoutTrailingSlashes } from "./url-text";

const { storageConfigs, storageMigrations, artifacts, artifactVersions, skillFiles, voiceClips, liveAssets, liveDocs } =
  schema;

type StorageConfigRow = typeof storageConfigs.$inferSelect;
type MigrationRow = typeof storageMigrations.$inferSelect;

/**
 * Where the bucket is, as the admin picked it when connecting: it only says which steps the app shows and how it names
 * the bucket in use, never how the server reaches it.
 */
export const STORAGE_PROVIDERS = ["r2", "s3", "b2", "other"] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

/** What an admin types for "Your own storage". Keys empty = keep the stored ones. */
export interface S3Input {
  /** The service picked in the app; absent from an older app. */
  provider?: StorageProvider | null;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string | null;
  pathStyle: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface StorageMigrationView {
  status: "running" | "failed" | "done";
  copied: number;
  total: number;
  error: string | null;
  /** Stable code of the failure (`storage.auth`, `url.internal`…), for the app to translate. */
  code?: string | null;
}

/** The org's storage as the app shows it (`agentes` = platform storage). Keys only as hints. */
export interface StorageView {
  kind: "agentes" | "s3";
  s3: {
    /** Null for settings saved before the app said it. */
    provider: StorageProvider | null;
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string | null;
    pathStyle: boolean;
    accessKeyIdHint: string;
    secretHint: string;
  } | null;
  migration: StorageMigrationView | null;
}

export type StorageStep = "write" | "read" | "list" | "delete";
export interface StorageTestResult {
  ok: boolean;
  steps: { step: StorageStep; ok: boolean; error: string | null; code?: string | null }[];
}

export interface StorageDeps {
  db: Database;
  keyWrappers: KeyWrapper[];
  /** Platform storage (our bucket, or Postgres). */
  platform: BlobStore;
  /** Tests: fake S3 transport and DNS. */
  fetch?: S3Fetch;
  resolveHost?: ResolveHost;
}

/** A passing test is valid for switching on for this long. */
const TEST_VALID_MS = 30 * 60_000;
const aadFor = (orgId: string, id: string) => `storage:${orgId}:${id}`;
const hint = (s: string) => (s.length <= 4 ? "••••" : `••••${s.slice(-4)}`);
const keyPrefix = (prefix: string | null | undefined) => {
  const typed = (prefix ?? "").trim();
  // Slashes out from both ends by index, not by `/^\/+|\/+$/g`, which rescans each inner run of them.
  let start = 0;
  while (typed.charAt(start) === "/") start++;
  const p = withoutTrailingSlashes(typed.slice(start));
  return p ? `${p}/` : "";
};

interface StoredOptions {
  provider: StorageProvider | null;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string | null;
  pathStyle: boolean;
  accessKeyId: string;
}

function optionsOf(row: StorageConfigRow): StoredOptions {
  const o = row.options as Partial<StoredOptions>;
  return {
    provider: STORAGE_PROVIDERS.find((p) => p === o.provider) ?? null,
    endpoint: String(o.endpoint ?? ""),
    region: String(o.region ?? "auto"),
    bucket: String(o.bucket ?? ""),
    prefix: typeof o.prefix === "string" && o.prefix ? o.prefix : null,
    pathStyle: o.pathStyle === true,
    accessKeyId: String(o.accessKeyId ?? ""),
  };
}

async function secretOf(deps: StorageDeps, row: StorageConfigRow) {
  if (!row.secretCiphertext || !row.wrappedDataKey || !row.kekId) throw new Error("storage config without a secret");
  const sealed = { ciphertext: row.secretCiphertext, wrappedDataKey: row.wrappedDataKey, kekId: row.kekId };
  return openSecret(deps.keyWrappers, sealed, aadFor(row.orgId, row.id));
}

/** A workspace's own bucket: every request's host is checked as it connects, the bucket's own name included. */
function s3Store(deps: StorageDeps, settings: S3Settings) {
  return createS3BlobStore(settings, { fetch: deps.fetch ?? outboundFetch({ resolveHost: deps.resolveHost }) });
}

async function storeOf(deps: StorageDeps, row: StorageConfigRow): Promise<BlobStore> {
  const { provider: _, ...o } = optionsOf(row);
  const secretAccessKey = await secretOf(deps, row);
  return s3Store(deps, { ...o, secretAccessKey });
}

async function activeConfig(db: Database, orgId: string) {
  const [row] = await db
    .select()
    .from(storageConfigs)
    .where(and(eq(storageConfigs.orgId, orgId), eq(storageConfigs.status, "active")));
  return row ?? null;
}

/** New files go to the workspace's own bucket. */
export const usesOwnBucket = async (db: Database, orgId: string) => (await activeConfig(db, orgId)) !== null;

/**
 * Every blob read and write goes through this (like `SearchIndexResolver`):
 * new objects go to the org's active storage (its own bucket, or platform
 * storage under `orgs/{orgId}/`), and an existing object is read from the
 * storage it was written to.
 */
export function createBlobStoreResolver(deps: StorageDeps): BlobStoreResolver {
  return {
    async forOrg(orgId): Promise<BlobLocation> {
      const row = await activeConfig(deps.db, orgId);
      if (!row) return { storageConfigId: null, store: deps.platform, prefix: `orgs/${orgId}/` };
      return { storageConfigId: row.id, store: await storeOf(deps, row), prefix: keyPrefix(optionsOf(row).prefix) };
    },
    async forConfig(orgId, storageConfigId) {
      if (!storageConfigId) return deps.platform;
      const [row] = await deps.db
        .select()
        .from(storageConfigs)
        .where(and(eq(storageConfigs.id, storageConfigId), eq(storageConfigs.orgId, orgId)));
      if (!row) throw new NotFoundError("Storage settings not found");
      return storeOf(deps, row);
    },
  };
}

/** A stable code for a failed storage step (the app translates it). */
export function storageErrorCode(error: unknown): string {
  if (error instanceof ValidationError) return error.code;
  if (!(error instanceof StorageError)) return "storage.unexpected";
  return `storage.${error.code}`;
}

/** The English reason for a failed storage step (fallback of `storageErrorCode`). */
export function storageErrorText(error: unknown): string {
  if (error instanceof ValidationError) return error.message;
  if (!(error instanceof StorageError)) return "Unexpected failure talking to the storage.";
  switch (error.code) {
    case "auth":
      return "The access key or secret was not accepted.";
    case "bucket_missing":
      return "This bucket doesn't exist at this endpoint.";
    case "region":
      return "The region doesn't match the bucket's.";
    case "permission":
      return "The key has no permission for this operation.";
    case "network":
      return "Couldn't reach the endpoint.";
    case "invalid_endpoint":
      return "The endpoint isn't a valid address.";
    case "not_found":
      return "The test file didn't come back on read.";
    default:
      return `The storage answered with an error (${error.message.slice(0, 200)}).`;
  }
}

/** Settings plus keys (the stored ones when the input leaves them empty). */
async function resolveInput(deps: StorageDeps, orgId: string, input: S3Input) {
  const endpoint = withoutTrailingSlashes(input.endpoint.trim());
  const bucket = input.bucket.trim();
  const region = input.region.trim() || "auto";
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,62}$/.test(bucket))
    throw new ValidationError("Invalid bucket name", "storage.invalid_bucket");
  await assertPublicHttpsUrl(endpoint, deps.resolveHost);
  let accessKeyId = input.accessKeyId?.trim() ?? "";
  let secretAccessKey = input.secretAccessKey?.trim() ?? "";
  if (!accessKeyId || !secretAccessKey) {
    const active = await activeConfig(deps.db, orgId);
    if (!active) throw new ValidationError("Give the access key and secret", "storage.credentials_required");
    accessKeyId ||= optionsOf(active).accessKeyId;
    secretAccessKey ||= await secretOf(deps, active);
  }
  const prefix = keyPrefix(input.prefix).replace(/\/$/, "") || null;
  const settings: S3Settings = { endpoint, region, bucket, pathStyle: input.pathStyle, accessKeyId, secretAccessKey };
  const fingerprint = sha256(JSON.stringify({ ...settings, prefix }));
  return { settings, prefix, fingerprint };
}

function failedAtFirstStep(error: string, code: string): StorageTestResult {
  const steps = (["write", "read", "list", "delete"] as const).map((step, i) => ({
    step,
    ok: false,
    error: i === 0 ? error : null,
    code: i === 0 ? code : null,
  }));
  return { ok: false, steps };
}

/** Write, read, list and delete a small probe object. */
async function probe(store: BlobStore, prefix: string): Promise<StorageTestResult> {
  const key = `${keyPrefix(prefix)}.agentes-probe/${randomToken(9)}`;
  const body = new TextEncoder().encode(`agentes.chat storage check ${new Date().toISOString()}`);
  const steps: StorageTestResult["steps"] = [];
  const step = async (name: StorageStep, run: () => Promise<void>) => {
    if (steps.some((s) => !s.ok)) {
      steps.push({ step: name, ok: false, error: null });
      return;
    }
    try {
      await run();
      steps.push({ step: name, ok: true, error: null });
    } catch (error) {
      steps.push({ step: name, ok: false, error: storageErrorText(error), code: storageErrorCode(error) });
    }
  };
  await step("write", () => store.put(key, body, { contentType: "text/plain" }));
  await step("read", async () => {
    const got = await store.get(key);
    if (!got) throw new StorageError("not_found", "probe missing");
    const same = Buffer.compare(Buffer.from(got.body), Buffer.from(body)) === 0;
    if (!same) throw new StorageError("other", "probe differs");
  });
  await step("list", async () => {
    const keys = await store.list(key);
    if (!keys.includes(key)) throw new StorageError("other", "the probe object is missing from the listing");
  });
  await step("delete", () => store.delete(key));
  return { ok: steps.every((s) => s.ok), steps };
}

/**
 * `POST …/storage/test` (admins): probes the bucket and remembers the result.
 * Only settings that passed can be switched on (`saveStorage`).
 */
export async function testStorage(
  deps: StorageDeps,
  actorId: string,
  orgId: string,
  input: S3Input,
): Promise<StorageTestResult> {
  await requirePermission(deps.db, actorId, orgId, "configure");
  const resolved = await resolveInput(deps, orgId, input).catch((error: unknown) => {
    if (error instanceof ValidationError) return error;
    throw error;
  });
  if (resolved instanceof ValidationError) return failedAtFirstStep(resolved.message, storageErrorCode(resolved));
  const result = await probe(s3Store(deps, resolved.settings), resolved.prefix ?? "").catch((error: unknown) =>
    failedAtFirstStep(storageErrorText(error), storageErrorCode(error)),
  );
  const id = Bun.randomUUIDv7();
  const { settings } = resolved;
  const sealed = await sealSecret(deps.keyWrappers[0] as KeyWrapper, settings.secretAccessKey, aadFor(orgId, id));
  await deps.db.transaction(async (tx) => {
    await tx.insert(storageConfigs).values({
      id,
      orgId,
      kind: "s3",
      options: {
        // Not part of the fingerprint: the same bucket picked under another name is still the same bucket.
        provider: STORAGE_PROVIDERS.find((p) => p === input.provider) ?? null,
        endpoint: settings.endpoint,
        region: settings.region,
        bucket: settings.bucket,
        prefix: resolved.prefix,
        pathStyle: settings.pathStyle,
        accessKeyId: settings.accessKeyId,
      },
      secretCiphertext: sealed.ciphertext,
      wrappedDataKey: sealed.wrappedDataKey,
      kekId: sealed.kekId,
      accessKeyHint: hint(settings.accessKeyId),
      secretHint: hint(settings.secretAccessKey),
      fingerprint: resolved.fingerprint,
      status: result.ok ? "tested" : "failed",
      lastError: result.steps.find((s) => s.error)?.error ?? null,
      verifiedAt: result.ok ? new Date() : null,
      createdByUserId: actorId,
    });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: result.ok ? "storage.test_passed" : "storage.test_failed",
      target: { type: "storage_config", id },
      details: { endpoint: settings.endpoint, bucket: settings.bucket, region: settings.region },
    });
  });
  return result;
}

/**
 * `PUT …/storage` (admins). `agentes` switches back to platform storage;
 * `s3` switches on settings that passed `testStorage` (same settings and
 * keys, in the last 30 minutes). Files already stored keep reading from
 * where they were written; new ones go to the new storage.
 */
export async function saveStorage(
  deps: StorageDeps,
  actorId: string,
  orgId: string,
  input: { kind: "agentes" | "platform" } | { kind: "s3"; s3: S3Input },
): Promise<StorageView> {
  await requirePermission(deps.db, actorId, orgId, "configure");
  if (input.kind !== "s3") {
    await deps.db.transaction(async (tx) => {
      const off = await tx
        .update(storageConfigs)
        .set({ status: "inactive", updatedAt: new Date() })
        .where(and(eq(storageConfigs.orgId, orgId), eq(storageConfigs.status, "active")))
        .returning({ id: storageConfigs.id });
      if (off.length > 0) {
        await recordAudit(tx, {
          orgId,
          actor: { type: "person", id: actorId },
          action: "storage.reverted_to_platform",
          target: { type: "storage_config", id: off[0]?.id ?? null },
        });
      }
    });
    return getStorage(deps.db, actorId, orgId);
  }
  const { fingerprint } = await resolveInput(deps, orgId, input.s3);
  const current = await activeConfig(deps.db, orgId);
  if (current?.fingerprint === fingerprint) return getStorage(deps.db, actorId, orgId);
  const [tested] = await deps.db
    .select()
    .from(storageConfigs)
    .where(
      and(
        eq(storageConfigs.orgId, orgId),
        eq(storageConfigs.fingerprint, fingerprint),
        eq(storageConfigs.status, "tested"),
        gte(storageConfigs.createdAt, new Date(Date.now() - TEST_VALID_MS)),
      ),
    )
    .orderBy(desc(storageConfigs.createdAt))
    .limit(1);
  if (!tested)
    throw new ValidationError("Test the connection with these settings before turning it on", "storage.test_first");
  await deps.db.transaction(async (tx) => {
    await tx
      .update(storageConfigs)
      .set({ status: "inactive", updatedAt: new Date() })
      .where(and(eq(storageConfigs.orgId, orgId), eq(storageConfigs.status, "active")));
    await tx
      .update(storageConfigs)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(storageConfigs.id, tested.id));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "storage.activated",
      target: { type: "storage_config", id: tested.id },
      details: { endpoint: optionsOf(tested).endpoint, bucket: optionsOf(tested).bucket },
    });
  });
  return getStorage(deps.db, actorId, orgId);
}

function migrationView(m: MigrationRow | undefined | null): StorageMigrationView | null {
  if (!m) return null;
  return { status: m.status, copied: m.copied, total: m.total, error: m.error };
}

/**
 * Whether a `running` migration has no job behind it any more (its worker died on its last attempt), so asking again
 * starts it over instead of answering "running" forever. `runMigration` writes `updatedAt` after every file it copies.
 */
function migrationStalled(m: MigrationRow, now: Date): boolean {
  // ponytail: one file that takes longer than this to copy reads as stalled, and asking again then starts a second
  // job beside the first (as every second ask did before). A beat written while a file copies, if files get that large.
  return now.getTime() - m.updatedAt.getTime() > 10 * 60_000;
}

async function latestMigration(db: Database, orgId: string) {
  const [m] = await db
    .select()
    .from(storageMigrations)
    .where(eq(storageMigrations.orgId, orgId))
    .orderBy(desc(storageMigrations.createdAt))
    .limit(1);
  return m ?? null;
}

/** `GET …/storage` (admins): settings with hints only, never keys. */
export async function getStorage(db: Database, actorId: string, orgId: string): Promise<StorageView> {
  await requirePermission(db, actorId, orgId, "configure");
  const [active, migration] = await Promise.all([activeConfig(db, orgId), latestMigration(db, orgId)]);
  if (!active) return { kind: "agentes", s3: null, migration: migrationView(migration) };
  const o = optionsOf(active);
  return {
    kind: "s3",
    s3: {
      provider: o.provider,
      endpoint: o.endpoint,
      region: o.region,
      bucket: o.bucket,
      prefix: o.prefix,
      pathStyle: o.pathStyle,
      accessKeyIdHint: active.accessKeyHint,
      secretHint: active.secretHint,
    },
    migration: migrationView(migration),
  };
}

/** What a workspace's files take, in bytes (`storedBytes`). */
export interface StoredBytes {
  /**
   * On this server's storage (its folder, its database or the Cloud's storage), files in the trash and the
   * workspace's own bucket left out: what a storage limit counts.
   */
  platformBytes: number;
  /** In the workspace's own buckets (the one in use and any it used before), the trash left out too. */
  ownBucketBytes: number;
}

/**
 * The statements `storedBytes` runs, the Drive's and the skills', exported for the test that reads their plans.
 * `instanceStoredBytes` sums the same rows for every workspace at once: what changes here changes there.
 */
export const storedBytesQueries = (db: Executor, orgId: string) =>
  [
    db
      .select({
        platform: sql<string>`coalesce(sum(${artifactVersions.size}) filter (where ${artifactVersions.storageConfigId} is null), 0)`,
        own: sql<string>`coalesce(sum(${artifactVersions.size}) filter (where ${artifactVersions.storageConfigId} is not null), 0)`,
      })
      .from(artifactVersions)
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      // The workspace on both sides, so each is read through its index, whatever else the server holds.
      .where(and(eq(artifactVersions.orgId, orgId), eq(artifacts.orgId, orgId), isNull(artifacts.deletedAt))),
    db
      .select({
        platform: sql<string>`coalesce(sum(${skillFiles.size}) filter (where ${skillFiles.storageConfigId} is null), 0)`,
        own: sql<string>`coalesce(sum(${skillFiles.size}) filter (where ${skillFiles.storageConfigId} is not null), 0)`,
      })
      .from(skillFiles)
      .where(and(eq(skillFiles.orgId, orgId), isNotNull(skillFiles.blobKey))),
    db
      .select({
        platform: sql<string>`coalesce(sum(${voiceClips.size}) filter (where ${voiceClips.storageConfigId} is null), 0)`,
        own: sql<string>`coalesce(sum(${voiceClips.size}) filter (where ${voiceClips.storageConfigId} is not null), 0)`,
      })
      .from(voiceClips)
      .where(and(eq(voiceClips.orgId, orgId), isNull(voiceClips.audioDeletedAt))),
    // Live files' pictures (ADR 0196 §8), out of the trash like the versions.
    db
      .select({
        platform: sql<string>`coalesce(sum(${liveAssets.size}) filter (where ${liveAssets.storageConfigId} is null), 0)`,
        own: sql<string>`coalesce(sum(${liveAssets.size}) filter (where ${liveAssets.storageConfigId} is not null), 0)`,
      })
      .from(liveAssets)
      .innerJoin(artifacts, eq(artifacts.id, liveAssets.artifactId))
      .where(and(eq(liveAssets.orgId, orgId), eq(artifacts.orgId, orgId), isNull(artifacts.deletedAt))),
    // Live files' documents, kept in this server's database whatever storage the workspace uses (ADR 0196 §4).
    db
      .select({ platform: sql<string>`coalesce(sum(${liveDocs.stateBytes}), 0)`, own: sql<string>`0` })
      .from(liveDocs)
      .innerJoin(artifacts, eq(artifacts.id, liveDocs.artifactId))
      .where(and(eq(liveDocs.orgId, orgId), eq(artifacts.orgId, orgId), isNull(artifacts.deletedAt))),
  ] as const;

/**
 * What a workspace's files take, summed from the size each one recorded when it was written: no bucket is listed and
 * no folder walked. It counts every version kept of the Drive's files (uploads, what agents make or bring from their
 * computers, files attached to messages, issues and wiki pages) and every stored file of its skills, deleted skills'
 * included, as their files stay, the voice recordings still kept, and live files' pictures and documents (ADR 0196).
 * Left out: the Drive's trash, which goes for good after 30 days; the workspace's
 * logo, connectors' icons and people's photos, small and with no size on record; the old copies a copy between
 * storages (`runMigration`) leaves where the files were.
 */
export async function storedBytes(db: Executor, orgId: string): Promise<StoredBytes> {
  const sums = await Promise.all(storedBytesQueries(db, orgId));
  let platformBytes = 0;
  let ownBucketBytes = 0;
  for (const [sum] of sums) {
    platformBytes += Number(sum?.platform ?? 0);
    ownBucketBytes += Number(sum?.own ?? 0);
  }
  return { platformBytes, ownBucketBytes };
}

/** What the files of every workspace on this server's storage take together (`instanceStoredBytes`). */
export interface InstanceStoredBytes {
  /** `storedBytes`' platform bytes, summed over the workspaces whose new files go to this server's storage. */
  storageBytes: number;
  /** How many workspaces that sum is of: each has at least one byte counted. */
  workspaces: number;
  /** How many workspaces send new files to a bucket of their own: left out whole. */
  ownStorageWorkspaces: number;
}

/**
 * `storedBytes`' platform bytes for the whole instance: the rows `storedBytesQueries` sums for one workspace, summed
 * for all of them at once, so a change to what one counts is a change to the other. A workspace with a bucket of its
 * own is left out with whatever it still keeps here (files written before the bucket and not copied to it, live
 * files' documents). No index holds a file's size, so every row of the five tables is read: it runs as a `heavyRead`.
 */
export async function instanceStoredBytes(db: Database): Promise<InstanceStoredBytes> {
  // Out of the Drive's trash, the workspace matched on both sides as for one workspace.
  const kept = (orgId: unknown, artifactId: unknown) =>
    sql`join ${artifacts} on ${artifacts.id} = ${artifactId} and ${artifacts.orgId} = ${orgId}
      and ${artifacts.deletedAt} is null`;
  const [total] = rowsOf<{ storageBytes: number | null; workspaces: number; ownStorageWorkspaces: number }>(
    await heavyRead(
      db,
      sql`
      with own as (
        select ${storageConfigs.orgId} as org_id from ${storageConfigs} where ${storageConfigs.status} = 'active'
      ), files as (
        select ${artifactVersions.orgId} as org_id, ${artifactVersions.size} as bytes from ${artifactVersions}
          ${kept(artifactVersions.orgId, artifactVersions.artifactId)}
          where ${artifactVersions.storageConfigId} is null
        union all
        select ${skillFiles.orgId}, ${skillFiles.size} from ${skillFiles}
          where ${skillFiles.storageConfigId} is null and ${skillFiles.blobKey} is not null
        union all
        select ${voiceClips.orgId}, ${voiceClips.size} from ${voiceClips}
          where ${voiceClips.storageConfigId} is null and ${voiceClips.audioDeletedAt} is null
        union all
        select ${liveAssets.orgId}, ${liveAssets.size} from ${liveAssets}
          ${kept(liveAssets.orgId, liveAssets.artifactId)}
          where ${liveAssets.storageConfigId} is null
        union all
        select ${liveDocs.orgId}, ${liveDocs.stateBytes} from ${liveDocs}
          ${kept(liveDocs.orgId, liveDocs.artifactId)}
      ), per_org as (
        select org_id, sum(bytes) as bytes from files
        where org_id not in (select org_id from own)
        group by org_id having sum(bytes) > 0
      )
      select sum(bytes)::float8 as "storageBytes", count(*)::int as workspaces,
        (select count(*)::int from own) as "ownStorageWorkspaces"
      from per_org`,
    ),
  );
  return {
    // No workspace with a byte counted sums to null.
    storageBytes: total?.storageBytes ?? 0,
    workspaces: total?.workspaces ?? 0,
    ownStorageWorkspaces: total?.ownStorageWorkspaces ?? 0,
  };
}

export async function getMigration(db: Database, actorId: string, orgId: string) {
  await requirePermission(db, actorId, orgId, "configure");
  return migrationView(await latestMigration(db, orgId));
}

/** Versions not yet stored where new files go (`target` null = platform). */
const notAt = (orgId: string, target: string | null) =>
  and(
    eq(artifactVersions.orgId, orgId),
    // Only a live artifact's versions: a trashed one's copies aren't counted or moved (matching storedBytes),
    // so cycling storages doesn't drag dead files along.
    sql`exists (select 1 from ${artifacts} where ${artifacts.id} = ${artifactVersions.artifactId} and ${artifacts.deletedAt} is null)`,
    target ? or(isNull(artifactVersions.storageConfigId), ne(artifactVersions.storageConfigId, target)) : undefined,
    target ? undefined : sql`${artifactVersions.storageConfigId} is not null`,
  );

/** Live files' pictures not yet where new files go, those of files out of the trash (ADR 0196 §8). */
const assetsNotAt = (orgId: string, target: string | null) =>
  and(
    eq(liveAssets.orgId, orgId),
    sql`exists (select 1 from ${artifacts} where ${artifacts.id} = ${liveAssets.artifactId} and ${artifacts.deletedAt} is null)`,
    target ? or(isNull(liveAssets.storageConfigId), ne(liveAssets.storageConfigId, target)) : undefined,
    target ? undefined : sql`${liveAssets.storageConfigId} is not null`,
  );

/** Voice recordings not yet where new files go; those already swept have nothing to copy (ADR 0100). */
const clipsNotAt = (orgId: string, target: string | null) =>
  and(
    eq(voiceClips.orgId, orgId),
    isNull(voiceClips.audioDeletedAt),
    target ? or(isNull(voiceClips.storageConfigId), ne(voiceClips.storageConfigId, target)) : undefined,
    target ? undefined : sql`${voiceClips.storageConfigId} is not null`,
  );

/**
 * `POST …/storage/migrate` (admins): copies existing files to the current
 * storage and repoints them (job `storage.migrate`). A failed or interrupted
 * migration resumes where it stopped; a running one is returned as is.
 */
export async function startMigration(deps: StorageDeps, actorId: string, orgId: string) {
  await requirePermission(deps.db, actorId, orgId, "configure");
  const target = (await activeConfig(deps.db, orgId))?.id ?? null;
  const last = await latestMigration(deps.db, orgId);
  // A running one is returned as is (asked twice, two jobs would copy the same files and count each twice), unless
  // nothing is behind it any more.
  if (last?.status === "running" && !migrationStalled(last, new Date())) {
    return migrationView(last) as StorageMigrationView;
  }
  const [counted] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(artifactVersions)
    .where(notAt(orgId, target));
  const [countedClips] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(voiceClips)
    .where(clipsNotAt(orgId, target));
  const [countedAssets] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(liveAssets)
    .where(assetsNotAt(orgId, target));
  const remaining = (counted?.n ?? 0) + (countedClips?.n ?? 0) + (countedAssets?.n ?? 0);
  // Back onto this server's storage, the files it copies count against its limit.
  if (target === null) {
    const [moving] = await deps.db
      .select({ bytes: sql<string>`coalesce(sum(${artifactVersions.size}), 0)` })
      .from(artifactVersions)
      .where(notAt(orgId, null));
    const [movingClips] = await deps.db
      .select({ bytes: sql<string>`coalesce(sum(${voiceClips.size}), 0)` })
      .from(voiceClips)
      .where(clipsNotAt(orgId, null));
    const [movingAssets] = await deps.db
      .select({ bytes: sql<string>`coalesce(sum(${liveAssets.size}), 0)` })
      .from(liveAssets)
      .where(assetsNotAt(orgId, null));
    const bytes = Number(moving?.bytes ?? 0) + Number(movingClips?.bytes ?? 0) + Number(movingAssets?.bytes ?? 0);
    if (bytes > 0) await assertStorageRoom(deps.db, orgId, bytes, { daily: false });
  }
  const resume = last && last.status !== "done" && last.toStorageConfigId === target ? last : null;
  const migration = await deps.db.transaction(async (tx) => {
    let row: MigrationRow | undefined;
    if (resume) {
      [row] = await tx
        .update(storageMigrations)
        .set({ status: "running", error: null, total: resume.copied + remaining, updatedAt: new Date() })
        .where(eq(storageMigrations.id, resume.id))
        .returning();
    } else {
      [row] = await tx
        .insert(storageMigrations)
        .values({ orgId, toStorageConfigId: target, total: remaining, startedByUserId: actorId })
        .returning();
    }
    if (!row) throw new Error("storage migration write returned nothing");
    await enqueue(tx, {
      orgId,
      kind: "storage.migrate",
      payload: { migrationId: row.id },
      dedupeKey: `storage.migrate:${row.id}:${Date.now()}`,
      maxAttempts: 3,
    });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: resume ? "storage.migration_resumed" : "storage.migration_started",
      target: { type: "storage_migration", id: row.id },
      details: { toStorageConfigId: target, total: row.total },
    });
    return row;
  });
  return migrationView(migration) as StorageMigrationView;
}

/**
 * Job `org.files.purge` (ADR 0019): a deleted workspace's files leave platform storage, its Drive, skills and
 * connector icons (`orgs/{orgId}/`) and its logo (`org-logos/{orgId}/`), each folder at once where the store can
 * (`FILES_DIR`), else up to `limit` keys of each per run. True when a page came back full, so more may be left. A
 * bucket the workspace brought is its own and stays as it is.
 */
export async function purgeOrgFiles(deps: StorageDeps, orgId: string, limit = 1000): Promise<boolean> {
  // Irreversible: never for a workspace that still exists.
  const [alive] = await deps.db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  if (alive) return false;
  return purgePrefixes(deps.platform, [`orgs/${orgId}/`, `org-logos/${orgId}/`], limit);
}

/**
 * Job `user.files.purge`: a deleted account's photos (`avatars/{userId}/`) leave platform storage. A new photo replaces
 * the last one, so one page holds them all.
 */
export async function purgeUserFiles(deps: StorageDeps, userId: string) {
  // Irreversible: never for an account that still exists.
  const [alive] = await deps.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId));
  if (!alive) await purgePrefixes(deps.platform, [`avatars/${userId}/`], 1000);
}

/** Deletes what is under each prefix, a page of `limit` keys each where the store can't take a folder at once. */
async function purgePrefixes(platform: BlobStore, prefixes: string[], limit: number) {
  if (platform.deletePrefix) {
    for (const prefix of prefixes) await platform.deletePrefix(prefix);
    return false;
  }
  let full = false;
  for (const prefix of prefixes) {
    const keys = await platform.list(prefix, limit);
    for (const key of keys) await platform.delete(key);
    full ||= keys.length >= limit;
  }
  return full;
}

/** Job `storage.migrate`: copies in batches, saving progress after each object. */
export async function runMigration(deps: StorageDeps, migrationId: string, options: { batch?: number } = {}) {
  const { db } = deps;
  const [m] = await db.select().from(storageMigrations).where(eq(storageMigrations.id, migrationId));
  if (m?.status !== "running") return;
  const resolver = createBlobStoreResolver(deps);
  const target = await resolver.forOrg(m.orgId);
  if (target.storageConfigId !== m.toStorageConfigId) {
    const error = "The storage settings changed during the copy.";
    await db
      .update(storageMigrations)
      .set({ status: "failed", error, updatedAt: new Date() })
      .where(eq(storageMigrations.id, m.id));
    return;
  }
  let copied = m.copied;
  let cursor = m.cursor;
  for (;;) {
    const batch = await db
      .select()
      .from(artifactVersions)
      .where(and(notAt(m.orgId, m.toStorageConfigId), cursor ? gt(artifactVersions.id, cursor) : undefined))
      .orderBy(asc(artifactVersions.id))
      .limit(options.batch ?? 50);
    if (batch.length === 0) break;
    for (const v of batch) {
      try {
        const source = await resolver.forConfig(m.orgId, v.storageConfigId);
        const object = await source.get(v.blobKey);
        if (!object) throw new StorageError("not_found", `missing object ${v.blobKey}`);
        const key = `${target.prefix}artifacts/${v.artifactId}/v${v.version}`;
        await target.store.put(key, object.body, { contentType: object.contentType });
        await db
          .update(artifactVersions)
          .set({ storageConfigId: target.storageConfigId, blobKey: key })
          .where(eq(artifactVersions.id, v.id));
        // The row now points at the target copy. Drop the old object only when it was on our platform store,
        // so cycling off the platform frees our disk; a workspace's own bucket is theirs (and may be a backup),
        // so its copies stay. Never delete the key the row now holds (a store that overwrote in place).
        if (v.storageConfigId === null && v.blobKey !== key) {
          await source.delete(v.blobKey).catch(() => undefined);
          await source.delete(transcriptKey(v.blobKey)).catch(() => undefined);
        }
      } catch (error) {
        await db
          .update(storageMigrations)
          .set({ status: "failed", error: storageErrorText(error), copied, cursor, updatedAt: new Date() })
          .where(eq(storageMigrations.id, m.id));
        return;
      }
      copied++;
      cursor = v.id;
      await db
        .update(storageMigrations)
        .set({ copied, cursor, updatedAt: new Date() })
        .where(eq(storageMigrations.id, m.id));
    }
  }
  // Voice recordings after the Drive: each one copied stops matching, so a resumed copy needs no cursor.
  for (;;) {
    const batch = await db
      .select()
      .from(voiceClips)
      .where(clipsNotAt(m.orgId, m.toStorageConfigId))
      .limit(options.batch ?? 50);
    if (batch.length === 0) break;
    for (const clip of batch) {
      try {
        const source = await resolver.forConfig(m.orgId, clip.storageConfigId);
        const object = await source.get(clip.blobKey);
        if (!object) throw new StorageError("not_found", `missing object ${clip.blobKey}`);
        const key = `${target.prefix}voice/${clip.id}`;
        await target.store.put(key, object.body, { contentType: object.contentType });
        await db
          .update(voiceClips)
          .set({ storageConfigId: target.storageConfigId, blobKey: key })
          .where(eq(voiceClips.id, clip.id));
        // As for the Drive's files: only our own store frees the old copy.
        if (clip.storageConfigId === null && clip.blobKey !== key)
          await source.delete(clip.blobKey).catch(() => undefined);
      } catch (error) {
        await db
          .update(storageMigrations)
          .set({ status: "failed", error: storageErrorText(error), copied, cursor, updatedAt: new Date() })
          .where(eq(storageMigrations.id, m.id));
        return;
      }
      copied++;
      await db.update(storageMigrations).set({ copied, updatedAt: new Date() }).where(eq(storageMigrations.id, m.id));
    }
  }
  // Live files' pictures last, the same way: each one copied stops matching.
  for (;;) {
    const batch = await db
      .select()
      .from(liveAssets)
      .where(assetsNotAt(m.orgId, m.toStorageConfigId))
      .limit(options.batch ?? 50);
    if (batch.length === 0) break;
    for (const asset of batch) {
      try {
        const source = await resolver.forConfig(m.orgId, asset.storageConfigId);
        const object = await source.get(asset.blobKey);
        if (!object) throw new StorageError("not_found", `missing object ${asset.blobKey}`);
        const key = `${target.prefix}artifacts/${asset.artifactId}/assets/${asset.id}`;
        await target.store.put(key, object.body, { contentType: object.contentType });
        await db
          .update(liveAssets)
          .set({ storageConfigId: target.storageConfigId, blobKey: key })
          .where(and(eq(liveAssets.artifactId, asset.artifactId), eq(liveAssets.id, asset.id)));
        if (asset.storageConfigId === null && asset.blobKey !== key) {
          await source.delete(asset.blobKey).catch(() => undefined);
        }
      } catch (error) {
        await db
          .update(storageMigrations)
          .set({ status: "failed", error: storageErrorText(error), copied, cursor, updatedAt: new Date() })
          .where(eq(storageMigrations.id, m.id));
        return;
      }
      copied++;
      await db.update(storageMigrations).set({ copied, updatedAt: new Date() }).where(eq(storageMigrations.id, m.id));
    }
  }
  await db
    .update(storageMigrations)
    .set({ status: "done", copied, total: Math.max(m.total, copied), updatedAt: new Date(), finishedAt: new Date() })
    .where(eq(storageMigrations.id, m.id));
}
