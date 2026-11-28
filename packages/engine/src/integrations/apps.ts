import { randomBytes } from "node:crypto";
import type { KeyWrapper } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, inArray, isNull, lt, or, schema, sql } from "@agenteschat/db";
import { randomBase62 } from "../apps/urls";
import { recordAudit } from "../audit";
import { openSecret, type SealedSecret, sealSecret, sha256 } from "../crypto";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertPublicHttpsUrl, type ResolveHost } from "../net-guard";
import { requireChangePermission, requirePermission } from "../organizations";
import { ROLE_COLORS } from "../permissions";

const { channels, integrationApps, integrationAppChannels } = schema;

/**
 * Integration apps (ADR 0251): programs an admin connects that post in chosen channels as themselves. They are never
 * members, never a person: what they post is outside text the agents answer (`fedByRoutine`), never their rules, and
 * they decide no approval. Managed by whoever may `manage_connectors`.
 */
export const INTEGRATION_TOKEN_PREFIX = "agi_";

export const INTEGRATION_LIMITS = {
  appsPerOrg: 25,
  channelsPerApp: 50,
  name: 64,
  /** The outside sender's name an app passes with a message. */
  sender: 80,
  text: 8000,
  webhookUrl: 2048,
} as const;

export type IntegrationColor = (typeof ROLE_COLORS)[number];

export interface IntegrationAppView {
  id: string;
  name: string;
  color: string;
  channels: { channelId: string; canPost: boolean }[];
  /** The live token's last four characters; null once revoked. */
  tokenHint: string | null;
  tokenCreatedAt: string | null;
  webhookUrl: string | null;
  webhookLastAt: string | null;
  /** Why the last delivery failed (status or network), null when it went through. */
  webhookLastError: string | null;
  createdByUserId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface IntegrationDeps {
  db: Database;
  keyWrappers: KeyWrapper[];
  /** Tests: DNS for the webhook address check. */
  resolveHost?: ResolveHost;
}

export interface IntegrationInput {
  name: string;
  color?: string;
  channels: { channelId: string; canPost: boolean }[];
  /** An https address that gets agents' replies; null or absent: the app polls. */
  webhookUrl?: string | null;
}

type AppRow = typeof integrationApps.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const viewOf = (row: AppRow, list: { channelId: string; canPost: boolean }[]): IntegrationAppView => ({
  id: row.id,
  name: row.name,
  color: row.color,
  channels: list,
  tokenHint: row.tokenHash ? row.tokenHint : null,
  tokenCreatedAt: row.tokenHash ? iso(row.tokenCreatedAt) : null,
  webhookUrl: row.webhookUrl,
  webhookLastAt: iso(row.webhookLastAt),
  webhookLastError: row.webhookLastError,
  createdByUserId: row.createdByUserId,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: iso(row.lastUsedAt),
});

const HIDDEN = /[\p{Cc}\p{Cf}]/gu;

/** A name as it is stored and shown: hidden characters out, spaces collapsed. */
export const cleanName = (value: string, max: number) =>
  value.replace(HIDDEN, "").replace(/\s+/g, " ").trim().slice(0, max);

const aadFor = (orgId: string, appId: string) => `integration-webhook|${orgId}|${appId}`;

/** A Standard Webhooks signing secret: `whsec_` and 32 random bytes in base64. */
const newWebhookSecret = () => `whsec_${randomBytes(32).toString("base64")}`;

const newToken = () => `${INTEGRATION_TOKEN_PREFIX}${randomBase62(43)}`;

async function sealed(deps: IntegrationDeps, orgId: string, appId: string, secret: string) {
  const wrapper = deps.keyWrappers[0];
  if (!wrapper) throw new Error("no key wrapper");
  const s = await sealSecret(wrapper, secret, aadFor(orgId, appId));
  return { webhookSecretCiphertext: s.ciphertext, webhookWrappedDataKey: s.wrappedDataKey, webhookKekId: s.kekId };
}

/** The app's webhook signing secret, opened; null without one. */
export async function webhookSecretOf(keyWrappers: KeyWrapper[], row: AppRow): Promise<string | null> {
  if (!row.webhookSecretCiphertext || !row.webhookWrappedDataKey || !row.webhookKekId) return null;
  const s: SealedSecret = {
    ciphertext: row.webhookSecretCiphertext,
    wrappedDataKey: row.webhookWrappedDataKey,
    kekId: row.webhookKekId,
  };
  return openSecret(keyWrappers, s, aadFor(row.orgId, row.id));
}

async function channelsOf(db: Database, appIds: string[]) {
  const rows = appIds.length
    ? await db
        .select({
          appId: integrationAppChannels.appId,
          channelId: integrationAppChannels.channelId,
          canPost: integrationAppChannels.canPost,
        })
        .from(integrationAppChannels)
        .innerJoin(channels, eq(channels.id, integrationAppChannels.channelId))
        .where(and(inArray(integrationAppChannels.appId, appIds), isNull(channels.archivedAt)))
        .orderBy(channels.name)
    : [];
  const out = new Map<string, { channelId: string; canPost: boolean }[]>();
  for (const r of rows) out.set(r.appId, [...(out.get(r.appId) ?? []), { channelId: r.channelId, canPost: r.canPost }]);
  return out;
}

async function appRow(db: Database, orgId: string, appId: string) {
  const [row] = await db
    .select()
    .from(integrationApps)
    .where(and(eq(integrationApps.orgId, orgId), eq(integrationApps.id, appId)));
  if (!row) throw new NotFoundError("App not found", "integration.not_found");
  return row;
}

async function viewById(db: Database, orgId: string, appId: string) {
  const row = await appRow(db, orgId, appId);
  return viewOf(row, (await channelsOf(db, [row.id])).get(row.id) ?? []);
}

/** The workspace's integration apps, newest first. */
export async function listIntegrationApps(db: Database, actorId: string, orgId: string): Promise<IntegrationAppView[]> {
  await requirePermission(db, actorId, orgId, "manage_connectors");
  const rows = await db
    .select()
    .from(integrationApps)
    .where(eq(integrationApps.orgId, orgId))
    .orderBy(desc(integrationApps.createdAt));
  const lists = await channelsOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => viewOf(r, lists.get(r.id) ?? []));
}

/** Checks a form's fields; the channels must be the workspace's own conversations of kind `channel`, not archived. */
async function checkInput(deps: IntegrationDeps, orgId: string, input: Partial<IntegrationInput>) {
  const name = input.name === undefined ? undefined : cleanName(input.name, INTEGRATION_LIMITS.name);
  if (name !== undefined && !name) throw new ValidationError("Give the app a name", "integration.name_required");
  if (input.color !== undefined && !(ROLE_COLORS as readonly string[]).includes(input.color)) {
    throw new ValidationError("Unknown color", "integration.color");
  }
  let list: { channelId: string; canPost: boolean }[] | undefined;
  if (input.channels !== undefined) {
    const byId = new Map(input.channels.map((c) => [c.channelId, c.canPost]));
    if (byId.size > INTEGRATION_LIMITS.channelsPerApp) {
      throw new ValidationError(
        `At most ${INTEGRATION_LIMITS.channelsPerApp} channels`,
        "integration.too_many_channels",
      );
    }
    const ids = [...byId.keys()];
    const found = ids.length
      ? await deps.db
          .select({ id: channels.id })
          .from(channels)
          .where(
            and(
              eq(channels.orgId, orgId),
              inArray(channels.id, ids),
              eq(channels.kind, "channel"),
              isNull(channels.archivedAt),
            ),
          )
      : [];
    if (found.length !== ids.length) {
      throw new ValidationError("An app reads and posts only in the workspace's channels", "integration.channel");
    }
    list = ids.map((channelId) => ({ channelId, canPost: byId.get(channelId) === true }));
  }
  let webhookUrl: string | null | undefined = input.webhookUrl === undefined ? undefined : null;
  if (input.webhookUrl) {
    if (input.webhookUrl.length > INTEGRATION_LIMITS.webhookUrl)
      throw new ValidationError("Address too long", "url.invalid");
    webhookUrl = (await assertPublicHttpsUrl(input.webhookUrl.trim(), deps.resolveHost)).toString();
  }
  return { name, list, webhookUrl };
}

async function replaceChannels(
  db: Executor,
  orgId: string,
  appId: string,
  list: { channelId: string; canPost: boolean }[],
) {
  await db.delete(integrationAppChannels).where(eq(integrationAppChannels.appId, appId));
  if (list.length) await db.insert(integrationAppChannels).values(list.map((c) => ({ orgId, appId, ...c })));
}

const audit = (db: Executor, orgId: string, actorId: string, action: string, appId: string, details = {}) =>
  recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action,
    target: { type: "integration_app", id: appId },
    details,
  });

/**
 * A new app with its token (`agi_…`, shown once: only its sha256 is kept) and, with a webhook address, the webhook's
 * signing secret (shown once too, kept sealed to sign deliveries).
 */
export async function createIntegrationApp(
  deps: IntegrationDeps,
  actorId: string,
  orgId: string,
  input: IntegrationInput,
) {
  await requireChangePermission(deps.db, actorId, orgId, "manage_connectors");
  const checked = await checkInput(deps, orgId, input);
  const [{ count } = { count: 0 }] = await deps.db
    .select({ count: sql<number>`count(*)::int` })
    .from(integrationApps)
    .where(eq(integrationApps.orgId, orgId));
  if (count >= INTEGRATION_LIMITS.appsPerOrg) {
    throw new ConflictError(`At most ${INTEGRATION_LIMITS.appsPerOrg} apps in a workspace`, "integration.too_many");
  }
  const id = Bun.randomUUIDv7();
  const token = newToken();
  const webhookSecret = checked.webhookUrl ? newWebhookSecret() : null;
  await deps.db.transaction(async (tx) => {
    await tx.insert(integrationApps).values({
      id,
      orgId,
      name: checked.name as string,
      color: input.color ?? "graphite",
      tokenHash: sha256(token),
      tokenHint: token.slice(-4),
      tokenCreatedAt: new Date(),
      webhookUrl: checked.webhookUrl ?? null,
      ...(webhookSecret ? await sealed(deps, orgId, id, webhookSecret) : {}),
      createdByUserId: actorId,
    });
    await replaceChannels(tx, orgId, id, checked.list ?? []);
    await audit(tx, orgId, actorId, "integration_app.created", id, {
      name: checked.name,
      channels: (checked.list ?? []).length,
      webhook: checked.webhookUrl !== null && checked.webhookUrl !== undefined,
    });
  });
  return { app: await viewById(deps.db, orgId, id), token, webhookSecret };
}

/**
 * Changes an app's name, color, channels or webhook. A webhook address set where there was none gets a new signing
 * secret (returned once); clearing it drops the secret.
 */
export async function updateIntegrationApp(
  deps: IntegrationDeps,
  actorId: string,
  orgId: string,
  appId: string,
  input: Partial<IntegrationInput>,
) {
  await requireChangePermission(deps.db, actorId, orgId, "manage_connectors");
  const row = await appRow(deps.db, orgId, appId);
  const checked = await checkInput(deps, orgId, input);
  const webhookSecret = checked.webhookUrl && !row.webhookSecretCiphertext ? newWebhookSecret() : null;
  const clearing = checked.webhookUrl === null && input.webhookUrl !== undefined;
  await deps.db.transaction(async (tx) => {
    await tx
      .update(integrationApps)
      .set({
        ...(checked.name ? { name: checked.name } : {}),
        ...(input.color ? { color: input.color } : {}),
        ...(checked.webhookUrl !== undefined ? { webhookUrl: checked.webhookUrl } : {}),
        ...(webhookSecret ? await sealed(deps, orgId, appId, webhookSecret) : {}),
        ...(clearing
          ? {
              webhookSecretCiphertext: null,
              webhookWrappedDataKey: null,
              webhookKekId: null,
              webhookLastAt: null,
              webhookLastError: null,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(integrationApps.id, appId));
    if (checked.list) await replaceChannels(tx, orgId, appId, checked.list);
    await audit(tx, orgId, actorId, "integration_app.updated", appId, {
      fields: Object.keys(input).filter((k) => input[k as keyof IntegrationInput] !== undefined),
    });
  });
  return { app: await viewById(deps.db, orgId, appId), webhookSecret };
}

/** A new token for the app: the old one stops working at once. Shown once. */
export async function rotateIntegrationToken(deps: IntegrationDeps, actorId: string, orgId: string, appId: string) {
  await requireChangePermission(deps.db, actorId, orgId, "manage_connectors");
  await appRow(deps.db, orgId, appId);
  const token = newToken();
  await deps.db
    .update(integrationApps)
    .set({ tokenHash: sha256(token), tokenHint: token.slice(-4), tokenCreatedAt: new Date(), updatedAt: new Date() })
    .where(eq(integrationApps.id, appId));
  await audit(deps.db, orgId, actorId, "integration_app.token_created", appId, { hint: token.slice(-4) });
  return { app: await viewById(deps.db, orgId, appId), token };
}

/** Revokes the app's token: it can neither post nor read until a new one is made, and its webhook stops. */
export async function revokeIntegrationToken(deps: IntegrationDeps, actorId: string, orgId: string, appId: string) {
  await requireChangePermission(deps.db, actorId, orgId, "manage_connectors");
  const row = await appRow(deps.db, orgId, appId);
  await deps.db
    .update(integrationApps)
    .set({ tokenHash: null, tokenHint: null, tokenCreatedAt: null, updatedAt: new Date() })
    .where(eq(integrationApps.id, appId));
  await audit(deps.db, orgId, actorId, "integration_app.token_revoked", appId, { hint: row.tokenHint });
  return viewById(deps.db, orgId, appId);
}

/** A new webhook signing secret (the address stays). Shown once. */
export async function rotateWebhookSecret(deps: IntegrationDeps, actorId: string, orgId: string, appId: string) {
  await requireChangePermission(deps.db, actorId, orgId, "manage_connectors");
  const row = await appRow(deps.db, orgId, appId);
  if (!row.webhookUrl) throw new ValidationError("This app has no webhook", "integration.no_webhook");
  const webhookSecret = newWebhookSecret();
  await deps.db
    .update(integrationApps)
    .set({ ...(await sealed(deps, orgId, appId, webhookSecret)), updatedAt: new Date() })
    .where(eq(integrationApps.id, appId));
  await audit(deps.db, orgId, actorId, "integration_app.webhook_secret_created", appId);
  return { app: await viewById(deps.db, orgId, appId), webhookSecret };
}

/** Removes the app. Its messages stay, under the name they were posted with. */
export async function deleteIntegrationApp(deps: IntegrationDeps, actorId: string, orgId: string, appId: string) {
  await requireChangePermission(deps.db, actorId, orgId, "manage_connectors");
  const row = await appRow(deps.db, orgId, appId);
  await deps.db.delete(integrationApps).where(eq(integrationApps.id, appId));
  await audit(deps.db, orgId, actorId, "integration_app.deleted", appId, { name: row.name });
}

// ── The app's own calls ──────────────────────────────────────────────────────

/** Who a public API or `/mcp` call acts as, once its `agi_` token checked out. */
export interface IntegrationPrincipal {
  kind: "integration";
  appId: string;
  orgId: string;
  name: string;
  color: string;
  /** Its channels: `canPost` where it may post, else it only reads there. */
  channels: Map<string, { canPost: boolean }>;
}

export const isIntegrationPrincipal = (p: object): p is IntegrationPrincipal =>
  (p as { kind?: unknown }).kind === "integration";

/** The bearer is an integration app's token (`agi_`): checked by `authenticateIntegrationApp`, never as a person's. */
export const isIntegrationBearer = (header: string | undefined | null) =>
  /^Bearer\s+agi_\S+$/i.test(header?.trim() ?? "");

/**
 * The app a bearer token names, alive (not revoked), with its channels; null for anything else (a 401). Never reads
 * cookies. Its use is recorded at most once a minute.
 */
export async function authenticateIntegrationApp(
  db: Database,
  header: string | undefined | null,
): Promise<IntegrationPrincipal | null> {
  const raw = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "")?.[1] ?? "";
  if (!raw.startsWith(INTEGRATION_TOKEN_PREFIX) || raw.length > 128) return null;
  const [row] = await db
    .select()
    .from(integrationApps)
    .where(eq(integrationApps.tokenHash, sha256(raw)));
  if (!row) return null;
  await db
    .update(integrationApps)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(integrationApps.id, row.id),
        or(isNull(integrationApps.lastUsedAt), lt(integrationApps.lastUsedAt, new Date(Date.now() - 60_000))),
      ),
    );
  const list = (await channelsOf(db, [row.id])).get(row.id) ?? [];
  return {
    kind: "integration",
    appId: row.id,
    orgId: row.orgId,
    name: row.name,
    color: row.color,
    channels: new Map(list.map((c) => [c.channelId, { canPost: c.canPost }])),
  };
}
