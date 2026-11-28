import { and, eq, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { sealSecret } from "../crypto";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertPublicHttpsUrl } from "../net-guard";
import { requirePermission } from "../organizations";
import { oauthRedirectUri } from "./connections";
import { authServerMetadata, clientAad, discoveryFailed, type McpOAuthDeps, probeMcpServer } from "./oauth-mcp";

const { oauthClients, connectorConnections } = schema;

/**
 * An admin's own OAuth client for an MCP server that takes only clients it approved (Meta Ads): their app at the
 * provider, one per issuer for the workspace, used by every sign-in there instead of a registration of ours. Its
 * secret is sealed and never returned.
 */
export interface OwnOAuthClient {
  /** The redirect URI to register in that app: our one OAuth callback. */
  redirectUri: string;
  /** The authorization server the server named. */
  issuer: string;
  client: { clientId: string; hasSecret: boolean; scopes: string | null } | null;
}

/** The server's authorization server and its metadata; refused when it doesn't sign in with OAuth. */
async function issuerOf(deps: McpOAuthDeps, serverUrl: string) {
  const url = await assertPublicHttpsUrl(serverUrl.trim(), deps.resolveHost);
  const probe = await probeMcpServer(deps, url.toString());
  if (probe.kind !== "oauth") throw new ValidationError("This server doesn't sign in with OAuth", "connector.no_oauth");
  const meta = await authServerMetadata(deps, probe.issuer);
  if (!meta) throw discoveryFailed(probe.issuer);
  return { issuer: probe.issuer, meta };
}

async function rowOf(deps: McpOAuthDeps, orgId: string, issuer: string) {
  const [row] = await deps.db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.orgId, orgId), eq(oauthClients.issuer, issuer)));
  return row ?? null;
}

async function inUse(deps: McpOAuthDeps, id: string) {
  const [used] = await deps.db
    .select({ id: connectorConnections.id })
    .from(connectorConnections)
    .where(and(eq(connectorConnections.oauthClientId, id), isNull(connectorConnections.revokedAt)))
    .limit(1);
  return Boolean(used);
}

const view = (deps: McpOAuthDeps, issuer: string, row: typeof oauthClients.$inferSelect | null): OwnOAuthClient => ({
  redirectUri: oauthRedirectUri(deps.publicUrl),
  issuer,
  client: row?.providedByPerson
    ? { clientId: row.clientId, hasSecret: Boolean(row.secretCiphertext), scopes: row.scope }
    : null,
});

/** The workspace's own client for the server at this address, if it has one, and the redirect URI (admins). */
export async function ownOAuthClient(deps: McpOAuthDeps, actorId: string, orgId: string, serverUrl: string) {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const { issuer } = await issuerOf(deps, serverUrl);
  return view(deps, issuer, await rowOf(deps, orgId, issuer));
}

/** Printable ASCII without spaces: what a client id is everywhere we know of. */
const CLIENT_ID = /^[\x21-\x7e]{1,500}$/;

/**
 * Saves an admin's own client for the server's issuer (admins). The same client id again keeps its secret unless a
 * new one is typed; another client id while accounts sign in with the old one is refused, since their refresh tokens
 * belong to it. Replaces a registration of ours in place.
 */
export async function setOwnOAuthClient(
  deps: McpOAuthDeps,
  actorId: string,
  orgId: string,
  input: { serverUrl: string; clientId: string; clientSecret?: string; scopes?: string },
) {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const clientId = input.clientId.trim();
  if (!CLIENT_ID.test(clientId)) throw new ValidationError("Check the client ID", "connector.oauth_client_id");
  const typedSecret = input.clientSecret?.trim() || null;
  const scopes =
    input.scopes
      ?.split(/[\s,]+/)
      .filter(Boolean)
      .join(" ") || null;
  const { issuer, meta } = await issuerOf(deps, input.serverUrl);
  const existing = await rowOf(deps, orgId, issuer);
  if (existing && existing.clientId !== clientId && (await inUse(deps, existing.id))) {
    throw new ConflictError("Accounts still sign in with the client saved before", "connector.oauth_client_in_use");
  }
  const id = existing?.id ?? crypto.randomUUID();
  const kept =
    existing?.providedByPerson && existing.clientId === clientId && existing.secretCiphertext
      ? { ciphertext: existing.secretCiphertext, wrappedDataKey: existing.wrappedDataKey, kekId: existing.kekId }
      : null;
  const wrapper = deps.keyWrappers[0];
  if (!wrapper) throw new Error("no key wrapper");
  const sealed = typedSecret ? await sealSecret(wrapper, typedSecret, clientAad(orgId, id)) : kept;
  // A secret goes the way the server lists; one that lists only `none` (Meta) still takes it in the form.
  const listed = meta.token_endpoint_auth_methods_supported ?? [];
  const tokenAuthMethod = !sealed
    ? "none"
    : !listed.includes("client_secret_post") && listed.includes("client_secret_basic")
      ? "client_secret_basic"
      : "client_secret_post";
  const values = {
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    clientId,
    secretCiphertext: sealed?.ciphertext ?? null,
    wrappedDataKey: sealed?.wrappedDataKey ?? null,
    kekId: sealed?.kekId ?? null,
    scope: scopes,
    tokenAuthMethod,
    providedByPerson: true,
  };
  const row = await deps.db.transaction(async (tx) => {
    const [saved] = existing
      ? await tx.update(oauthClients).set(values).where(eq(oauthClients.id, id)).returning()
      : await tx
          .insert(oauthClients)
          .values({ id, orgId, issuer, ...values })
          .onConflictDoNothing()
          .returning();
    if (!saved) throw new ConflictError("Someone saved a client for it meanwhile: try again");
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "connector.oauth_client_set",
      target: { type: "oauth_client", id },
      details: { issuer, clientId, hasSecret: Boolean(sealed), scopes, replaced: Boolean(existing) },
    });
    return saved;
  });
  return view(deps, issuer, row);
}

/** Removes the workspace's own client for an issuer (admins), once no account signs in with it. */
export async function removeOwnOAuthClient(deps: McpOAuthDeps, actorId: string, orgId: string, issuer: string) {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const row = await rowOf(deps, orgId, issuer);
  if (!row?.providedByPerson) throw new NotFoundError("No client of yours for it");
  if (await inUse(deps, row.id)) {
    throw new ConflictError("Accounts still sign in with this client", "connector.oauth_client_in_use");
  }
  await deps.db.transaction(async (tx) => {
    await tx.delete(oauthClients).where(eq(oauthClients.id, row.id));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "connector.oauth_client_removed",
      target: { type: "oauth_client", id: row.id },
      details: { issuer, clientId: row.clientId },
    });
  });
}
