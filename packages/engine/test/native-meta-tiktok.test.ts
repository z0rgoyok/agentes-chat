import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq, schema } from "@agenteschat/db";
import {
  type ConnectorDeps,
  completeOAuth,
  connectorMediaLinks,
  createFileArtifact,
  createNativeConnectorToolSource,
  handleMetaCallback,
  openConnectorMedia,
  refreshNativeTokens,
  startOAuth,
  type ToolContext,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { runContext } from "./mail-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

const APPS = {
  threads: { clientId: "fake-threads-app", clientSecret: "fake-threads-secret" },
  "meta-ads": { clientId: "fake-meta-app", clientSecret: "fake-meta-secret", configId: "fake-config" },
  tiktok: { clientId: "fake-tiktok-key", clientSecret: "fake-tiktok-secret" },
};
const SECRET = "fake-fixture-agentes-secret-0123456789";
const DAY = 24 * 3600;

type Answer = (req: { url: URL; body: Record<string, string> }) => Response | undefined;

/** Meta's and TikTok's APIs, in memory: every call kept, an answer by "METHOD host/path". */
function fakeVendors(extra: Record<string, Answer> = {}) {
  const calls: { key: string; url: URL; body: Record<string, string>; headers: Headers }[] = [];
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.host}${url.pathname}`;
    const raw = init?.body;
    const body: Record<string, string> =
      raw instanceof URLSearchParams
        ? Object.fromEntries(raw)
        : typeof raw === "string"
          ? (() => {
              try {
                return JSON.parse(raw);
              } catch {
                return Object.fromEntries(new URLSearchParams(raw));
              }
            })()
          : {};
    calls.push({ key, url, body, headers: new Headers(init?.headers) });
    const own = extra[key]?.({ url, body });
    if (own) return own;
    switch (key) {
      case "POST graph.threads.com/oauth/access_token":
        return Response.json({ access_token: "short-threads", user_id: 77 });
      case "GET graph.threads.com/access_token":
        return Response.json({ access_token: "long-threads", expires_in: 60 * DAY });
      case "GET graph.threads.com/refresh_access_token":
        return Response.json({ access_token: "renewed-threads", expires_in: 60 * DAY });
      case "GET graph.threads.com/v1.0/me":
        return Response.json({ id: "77", username: "acme" });
      case "POST graph.threads.com/v1.0/me/threads":
        return Response.json({ id: "c1" });
      case "POST graph.threads.com/v1.0/me/threads_publish":
        return Response.json({ id: "p1" });
      case "GET graph.threads.com/v1.0/p1":
        return Response.json({ permalink: "https://www.threads.com/@acme/post/p1" });
      case "POST graph.facebook.com/v27.0/oauth/access_token":
        return Response.json({ access_token: "meta-system-user" });
      case "GET graph.facebook.com/v27.0/me":
        return Response.json({ id: "88", name: "Acme Ltd" });
      case "POST graph.facebook.com/v27.0/act_1/campaigns":
        return Response.json({ id: "123" });
      case "POST open.tiktokapis.com/v2/oauth/token/":
        return Response.json({ access_token: "tt", refresh_token: "tt-r", expires_in: 7200, open_id: "o1" });
      case "GET open.tiktokapis.com/v2/user/info/":
        return Response.json({ data: { user: { open_id: "o1", username: "acme" } }, error: { code: "ok" } });
    }
    return Response.json({ error: { message: `no fake for ${key}`, code: 100 } }, { status: 400 });
  }) as typeof fetch;
  return { http, calls };
}

const deps = (http: typeof fetch): ConnectorDeps => ({
  db: f.db,
  keyWrappers: [f.keyWrapper],
  publicUrl: "https://chat.example.com",
  oauthApps: APPS,
  http,
  resolveHost: async () => ["93.184.216.34"],
});

async function world(http: typeof fetch, reachable = true) {
  f = await setup({
    toolSources: [
      {
        name: "native",
        tools: (ctx) =>
          createNativeConnectorToolSource({
            ...deps(http),
            artifacts: f.artifactDeps,
            media: connectorMediaLinks({
              secret: SECRET,
              publicUrl: reachable ? "https://chat.example.com" : "http://localhost:3000",
              resolveHost: async () => ["93.184.216.34"],
            }),
          }).tools(ctx),
      },
    ],
  });
  return runContext(f);
}

async function connect(http: typeof fetch, connector: string) {
  const { authorizeUrl, state } = await startOAuth(deps(http), f.owner.id, f.org.id, connector);
  const { connection } = await completeOAuth(deps(http), { id: f.owner.id }, { state, code: "fake-code" });
  return { authorizeUrl: new URL(authorizeUrl), connection };
}

async function call(ctx: ToolContext, name: string, input: Record<string, unknown>) {
  const r = await f.tools?.invoke(ctx, { toolUseId: `tu_${Math.random()}`, name, input });
  if (!r) throw new Error("no answer");
  return r;
}
const result = async (ctx: ToolContext, name: string, input: Record<string, unknown>) => {
  const r = await call(ctx, name, input);
  if (r.type !== "result") throw new Error(`expected a result, got ${r.type}`);
  return r.output;
};

const picture = () =>
  createFileArtifact(f.artifactDeps, { type: "person", userId: f.owner.id }, f.org.id, {
    title: "launch.png",
    name: "launch.png",
    bytes: new Uint8Array([137, 80, 78, 71]),
    contentType: "image/png",
    channelId: f.general.id,
  });

test("Threads: no PKCE, the code's token swapped for the 60-day one, renewed a week before it ends", async () => {
  const v = fakeVendors();
  await world(v.http);
  const { authorizeUrl, connection } = await connect(v.http, "threads");
  expect(authorizeUrl.searchParams.get("code_challenge")).toBeNull();
  expect(authorizeUrl.searchParams.get("scope")).toContain("threads_basic,threads_content_publish");
  expect(v.calls.find((c) => c.key === "GET graph.threads.com/access_token")?.url.searchParams.get("grant_type")).toBe(
    "th_exchange_token",
  );
  expect(connection).toMatchObject({ accountLabel: "@acme", accountId: "77" });
  const days = ((connection.tokenExpiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000;
  expect(Math.round(days)).toBe(60);
  // 53 days on, the sweep renews it.
  expect(await refreshNativeTokens(deps(v.http), new Date(Date.now() + 54 * DAY * 1000))).toBe(1);
  expect(v.calls.at(-1)?.key).toBe("GET graph.threads.com/refresh_access_token");
});

test("Threads: a post is a container, then a publish; a picture goes by our link, which works for an hour", async () => {
  const v = fakeVendors();
  const ctx = await world(v.http);
  await connect(v.http, "threads");
  const text = await result(ctx, "threads_create_post", { text: "Novidade!" });
  expect(text.content).toBe("Posted on Threads: https://www.threads.com/@acme/post/p1.");
  const file = await picture();
  await result(ctx, "threads_create_post", { text: "Com foto", media: [file.id] });
  const container = v.calls.filter((c) => c.key === "POST graph.threads.com/v1.0/me/threads").at(-1);
  expect(container?.body.media_type).toBe("IMAGE");
  const link = container?.body.image_url ?? "";
  expect(link).toStartWith("https://chat.example.com/api/connector-media/");
  const token = link.split("/").at(-1) ?? "";
  expect((await openConnectorMedia({ ...f.artifactDeps, secret: SECRET }, token))?.filename).toBe("launch.png");
  expect(await openConnectorMedia({ ...f.artifactDeps, secret: SECRET }, token, Date.now() + 2 * 3600_000)).toBeNull();
  expect(await openConnectorMedia({ ...f.artifactDeps, secret: SECRET }, `${token}x`)).toBeNull();
});

test("Threads on a server the internet doesn't reach: text goes, a picture says why it can't", async () => {
  const v = fakeVendors();
  const ctx = await world(v.http, false);
  await connect(v.http, "threads");
  const file = await picture();
  const out = await result(ctx, "threads_create_post", { text: "Com foto", media: [file.id] });
  expect(out).toMatchObject({ isError: true, data: { code: "connector.refused" } });
  expect(out.content).toContain("the internet can't reach this server");
});

test("Meta Ads: Login for Business by its configuration; created paused; spend always asks, archive may be remembered", async () => {
  const v = fakeVendors();
  const ctx = await world(v.http);
  const { authorizeUrl, connection } = await connect(v.http, "meta-ads");
  expect(authorizeUrl.searchParams.get("config_id")).toBe("fake-config");
  expect(authorizeUrl.searchParams.get("scope")).toBeNull();
  expect(connection).toMatchObject({ accountLabel: "Acme Ltd", accountId: "88", tokenExpiresAt: null });
  const made = await result(ctx, "meta_ads_create_campaign", {
    account: "1",
    name: "Black Friday",
    objective: "OUTCOME_SALES",
  });
  expect(made.content).toContain("paused");
  expect(v.calls.find((c) => c.key === "POST graph.facebook.com/v27.0/act_1/campaigns")?.body).toMatchObject({
    status: "PAUSED",
    special_ad_categories: "[]",
  });
  const sneaky = await result(ctx, "meta_ads_update", { id: "123", fields: { status: "ACTIVE" } });
  expect(sneaky).toMatchObject({ isError: true });
  const why = "The person asked to start the Black Friday campaign today at the budget they approved.";
  expect((await call(ctx, "meta_ads_activate", { id: "123", why })).type).toBe("approval");
  const tools = await createNativeConnectorToolSource(deps(v.http)).tools(ctx);
  const byName = new Map(tools.map((t) => [t.name, t]));
  expect(byName.get("meta_ads_activate")?.rememberAs).toBeUndefined();
  expect(byName.get("meta_ads_set_budget")?.rememberAs).toBeUndefined();
  expect(byName.get("meta_ads_archive")?.rememberAs).toBe("archive");
});

test("Meta's deauthorize callback drops that account's connections; an unsigned one is nobody", async () => {
  const v = fakeVendors();
  await world(v.http);
  const { connection } = await connect(v.http, "threads");
  const payload = Buffer.from(JSON.stringify({ user_id: "77", algorithm: "HMAC-SHA256" })).toString("base64url");
  const sign = (secret: string) => `${createHmac("sha256", secret).update(payload).digest("base64url")}.${payload}`;
  await expect(handleMetaCallback(deps(v.http), sign("someone-else"))).rejects.toThrow("Not a request");
  expect((await handleMetaCallback(deps(v.http), sign(APPS.threads.clientSecret))).removed).toBe(1);
  const [row] = await f.db
    .select()
    .from(schema.connectorConnections)
    .where(eq(schema.connectorConnections.id, connection.id));
  expect(row?.revokedAt).not.toBeNull();
});

test("TikTok: its client is client_key, no PKCE on the web; each draft upload asks", async () => {
  const v = fakeVendors();
  const ctx = await world(v.http);
  const { authorizeUrl, connection } = await connect(v.http, "tiktok");
  expect(authorizeUrl.searchParams.get("client_key")).toBe("fake-tiktok-key");
  expect(authorizeUrl.searchParams.get("client_id")).toBeNull();
  expect(authorizeUrl.searchParams.get("code_challenge")).toBeNull();
  expect(v.calls.find((c) => c.key === "POST open.tiktokapis.com/v2/oauth/token/")?.body).toMatchObject({
    client_key: "fake-tiktok-key",
    client_secret: "fake-tiktok-secret",
  });
  expect(connection).toMatchObject({ accountLabel: "@acme", accountId: "o1" });
  const why = "The person asked to send the launch video to their TikTok drafts to post tonight.";
  expect((await call(ctx, "tiktok_upload_draft", { file: crypto.randomUUID(), why })).type).toBe("approval");
});
