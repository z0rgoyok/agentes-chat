import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, schema } from "@agenteschat/db";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ConflictError,
  type CustomDeps,
  completeOAuth,
  connectCustomServer,
  ForbiddenError,
  type McpConnect,
  mcpSessionOver,
  ownOAuthClient,
  removeOwnOAuthClient,
  revokeConnection,
  setOwnOAuthClient,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const SERVER = "https://ads.example.com/mcp";
const ISSUER = "https://auth.example.com";
const REDIRECT = "https://chat.example.com/api/app/connectors/oauth/callback";

/**
 * An MCP server whose authorization server lists registration (`register` answers it) and only `none` for the token
 * endpoint, as Meta's does; the token endpoint checks PKCE and keeps what each exchange sent.
 */
function adsServer(register: () => Response) {
  const seen = { registrations: 0, challenge: "", tokenForms: [] as URLSearchParams[] };
  const http = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.toString() === SERVER && init?.method === "POST") {
      return new Response("unauthorized", {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="https://ads.example.com/.well-known/oauth-protected-resource/mcp"`,
        },
      });
    }
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({ resource: SERVER, authorization_servers: [ISSUER], scopes_supported: ["ads_read"] });
    }
    if (url.toString() === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`,
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.toString() === `${ISSUER}/register`) {
      seen.registrations++;
      return register();
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(String(init?.body));
      seen.tokenForms.push(form);
      const verifier = createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");
      if (verifier !== seen.challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { http, seen };
}

const refused = () =>
  Response.json(
    { error: "invalid_client_metadata", error_description: "Dynamic registration is not available for this client." },
    { status: 400 },
  );

const connect: McpConnect = async () => {
  const server = new McpServer({ name: "ads", version: "1" });
  server.registerTool(
    "list_campaigns",
    { description: "List campaigns", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: "text", text: "none" }] }),
  );
  const [client, transport] = InMemoryTransport.createLinkedPair();
  await server.connect(transport);
  return mcpSessionOver(client);
};

const depsOf = (fx: Fixture, http: typeof fetch): CustomDeps => ({
  db: fx.db,
  keyWrappers: [fx.keyWrapper],
  publicUrl: "https://chat.example.com",
  resolveHost: async () => ["93.184.216.34"],
  connect,
  http,
});

/** Starts a sign-in at SERVER and finishes it: the authorize URL it went through and the connection. */
async function signIn(deps: CustomDeps, seen: { challenge: string }) {
  const started = await connectCustomServer(deps, f.owner.id, f.org.id, { serverUrl: SERVER });
  if (started.status !== "oauth") throw new Error(`expected oauth, got ${JSON.stringify(started)}`);
  const url = new URL(started.authorizeUrl);
  seen.challenge = url.searchParams.get("code_challenge") ?? "";
  const { connection } = await completeOAuth(
    deps,
    { id: f.owner.id },
    { state: url.searchParams.get("state") ?? "", code: "c" },
  );
  return { url, connection };
}

test("a server that takes only apps it approved signs in with the admin's own app, kept with no connection, its secret never returned", async () => {
  f = await setup();
  const ads = adsServer(refused);
  const deps = depsOf(f, ads.http);
  // Refused registration: the apps offer the admin's own app.
  expect(await connectCustomServer(deps, f.owner.id, f.org.id, { serverUrl: SERVER })).toMatchObject({
    status: "needs_key",
    reason: "not_approved",
  });
  expect(await ownOAuthClient(deps, f.owner.id, f.org.id, SERVER)).toEqual({
    redirectUri: REDIRECT,
    issuer: ISSUER,
    client: null,
  });

  const saved = await setOwnOAuthClient(deps, f.owner.id, f.org.id, {
    serverUrl: SERVER,
    clientId: "1234567890",
    clientSecret: "fake-app-secret",
    scopes: "ads_read, ads_management",
  });
  expect(saved).toEqual({
    redirectUri: REDIRECT,
    issuer: ISSUER,
    client: { clientId: "1234567890", hasSecret: true, scopes: "ads_read ads_management" },
  });
  expect(JSON.stringify(saved)).not.toContain("fake-app-secret");
  const [row] = await f.db.select().from(schema.oauthClients);
  expect(row).toMatchObject({ providedByPerson: true, tokenAuthMethod: "client_secret_post" });
  expect(row?.secretCiphertext).not.toContain("fake-app-secret");

  const { url, connection } = await signIn(deps, ads.seen);
  expect(url.searchParams.get("client_id")).toBe("1234567890");
  expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
  expect(url.searchParams.get("scope")).toBe("ads_read ads_management");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(ads.seen.tokenForms[0]?.get("client_id")).toBe("1234567890");
  expect(ads.seen.tokenForms[0]?.get("client_secret")).toBe("fake-app-secret");
  expect(connection.oauthClientId).toBe(row?.id ?? "");

  // The last connection gone, the app stays: no registration is tried again.
  await revokeConnection(f.db, f.owner.id, f.org.id, connection.id);
  const again = await signIn(deps, ads.seen);
  expect(again.url.searchParams.get("client_id")).toBe("1234567890");
  expect(ads.seen.registrations).toBe(1);
  expect(await f.db.select().from(schema.oauthClients)).toHaveLength(1);

  // The same client id again keeps the secret; another one while an account signs in with it is refused.
  expect(
    (await setOwnOAuthClient(deps, f.owner.id, f.org.id, { serverUrl: SERVER, clientId: "1234567890" })).client,
  ).toEqual({ clientId: "1234567890", hasSecret: true, scopes: null });
  await expect(
    setOwnOAuthClient(deps, f.owner.id, f.org.id, { serverUrl: SERVER, clientId: "other" }),
  ).rejects.toBeInstanceOf(ConflictError);
  await expect(removeOwnOAuthClient(deps, f.owner.id, f.org.id, ISSUER)).rejects.toBeInstanceOf(ConflictError);
  await revokeConnection(f.db, f.owner.id, f.org.id, again.connection.id);
  await removeOwnOAuthClient(deps, f.owner.id, f.org.id, ISSUER);
  expect(await f.db.select().from(schema.oauthClients)).toHaveLength(0);

  const audit = await f.db
    .select({ action: schema.auditLog.action, details: schema.auditLog.details })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.targetType, "oauth_client"));
  expect(audit.map((a) => a.action)).toEqual([
    "connector.oauth_client_set",
    "connector.oauth_client_set",
    "connector.oauth_client_removed",
  ]);
  expect(JSON.stringify(audit)).not.toContain("fake-app-secret");
});

test("a registration of ours never replaces the admin's own app, which replaces ours in place", async () => {
  f = await setup();
  const ads = adsServer(() => Response.json({ client_id: "dcr-client-1" }, { status: 201 }));
  const deps = depsOf(f, ads.http);
  const first = await signIn(deps, ads.seen);
  expect(first.url.searchParams.get("client_id")).toBe("dcr-client-1");
  const [ours] = await f.db.select().from(schema.oauthClients);
  await revokeConnection(f.db, f.owner.id, f.org.id, first.connection.id);

  await setOwnOAuthClient(deps, f.owner.id, f.org.id, { serverUrl: SERVER, clientId: "mine" });
  const [own] = await f.db.select().from(schema.oauthClients);
  expect(own).toMatchObject({ id: ours?.id, clientId: "mine", providedByPerson: true, tokenAuthMethod: "none" });
  const second = await signIn(deps, ads.seen);
  expect(second.url.searchParams.get("client_id")).toBe("mine");
  // A public client: the exchange carries its id and no secret.
  expect(ads.seen.tokenForms.at(-1)?.get("client_secret")).toBeNull();
  await revokeConnection(f.db, f.owner.id, f.org.id, second.connection.id);
  // Nothing uses it now, and it still isn't registered over.
  expect((await signIn(deps, ads.seen)).url.searchParams.get("client_id")).toBe("mine");
  expect(ads.seen.registrations).toBe(1);
});

test("only who manages connectors reads, saves or removes the workspace's own app", async () => {
  f = await setup();
  const deps = depsOf(f, adsServer(refused).http);
  const member = await addMember(f.db, f.org.id, "member", "Ada");
  await expect(ownOAuthClient(deps, member.id, f.org.id, SERVER)).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    setOwnOAuthClient(deps, member.id, f.org.id, { serverUrl: SERVER, clientId: "1234567890" }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(removeOwnOAuthClient(deps, member.id, f.org.id, ISSUER)).rejects.toBeInstanceOf(ForbiddenError);
  expect(await f.db.select().from(schema.oauthClients)).toHaveLength(0);
  const admin = await addMember(f.db, f.org.id, "admin", "Walter");
  expect(
    (await setOwnOAuthClient(deps, admin.id, f.org.id, { serverUrl: SERVER, clientId: "1234567890" })).client,
  ).toMatchObject({ clientId: "1234567890", hasSecret: false });
  // A client id is one printable word.
  await expect(
    setOwnOAuthClient(deps, admin.id, f.org.id, { serverUrl: SERVER, clientId: "two words" }),
  ).rejects.toMatchObject({ code: "connector.oauth_client_id" });
});
