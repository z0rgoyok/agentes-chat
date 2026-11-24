import { afterEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import {
  type ConnectorDeps,
  completeOAuth,
  connectorListing,
  createFileArtifact,
  createNativeConnectorToolSource,
  orgLimitsView,
  revokeAtProvider,
  setOrgLimits,
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

const APP = { clientId: "fake-x-client", clientSecret: "fake-x-secret" };
const BASIC = `Basic ${Buffer.from(`${APP.clientId}:${APP.clientSecret}`).toString("base64")}`;

/** X's API, in memory. `answers` by "METHOD /path" (no query). */
function fakeX(answers: Record<string, (req: { body: unknown; headers: Headers }) => Response> = {}) {
  const calls: { key: string; url: string; headers: Headers; body: unknown }[] = [];
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    const body =
      raw instanceof URLSearchParams || typeof raw === "string"
        ? (() => {
            try {
              return JSON.parse(String(raw));
            } catch {
              return Object.fromEntries(new URLSearchParams(String(raw)));
            }
          })()
        : raw instanceof FormData
          ? Object.fromEntries([...(raw as unknown as Iterable<[string, unknown]>)].map(([k, v]) => [k, typeof v]))
          : null;
    calls.push({ key, url: String(url), headers, body });
    const answer = answers[key];
    if (answer) return answer({ body, headers });
    if (key === "POST /2/oauth2/token") {
      return Response.json({
        access_token: "fake-access",
        refresh_token: "fake-refresh",
        expires_in: 7200,
        scope: "tweet.read tweet.write users.read media.write offline.access",
      });
    }
    if (key === "GET /2/users/me") return Response.json({ data: { id: "1234", username: "acme", name: "Acme" } });
    if (key === "POST /2/media/upload") return Response.json({ data: { id: "555" } });
    if (key === "POST /2/tweets") return Response.json({ data: { id: "9876", text: "x" } });
    if (key === "GET /2/users/1234/mentions") return Response.json({ data: [{ id: "1", text: "@acme oi" }] });
    if (key === "POST /2/oauth2/revoke") return Response.json({ revoked: true });
    return Response.json({ title: "Not Found" }, { status: 404 });
  }) as typeof fetch;
  return { http, calls };
}

const deps = (http: typeof fetch): ConnectorDeps => ({
  db: f.db,
  keyWrappers: [f.keyWrapper],
  publicUrl: "https://chat.example.com",
  oauthApps: { x: APP },
  http,
});

async function world(http: typeof fetch, caps?: Record<string, number>) {
  f = await setup({
    toolSources: [
      {
        name: "native",
        tools: (ctx) =>
          createNativeConnectorToolSource({
            ...deps(http),
            artifacts: f.artifactDeps,
            ...(caps ? { monthlyCaps: caps } : {}),
          }).tools(ctx),
      },
    ],
  });
  return runContext(f);
}

async function connectX(http: typeof fetch) {
  const { authorizeUrl, state } = await startOAuth(deps(http), f.owner.id, f.org.id, "x");
  const { connection } = await completeOAuth(deps(http), { id: f.owner.id }, { state, code: "fake-code" });
  return { authorizeUrl: new URL(authorizeUrl), connection };
}

async function call(ctx: ToolContext, name: string, input: Record<string, unknown>) {
  const r = await f.tools?.invoke(ctx, { toolUseId: `tu_${Math.random()}`, name, input });
  if (r?.type !== "result") throw new Error(`expected a result, got ${r?.type}`);
  return r.output;
}

test("X signs in with PKCE, its client in HTTP Basic only, and the row names the account", async () => {
  const x = fakeX();
  await world(x.http);
  const { authorizeUrl, connection } = await connectX(x.http);
  expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://x.com/i/oauth2/authorize");
  expect(authorizeUrl.searchParams.get("client_id")).toBe(APP.clientId);
  expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorizeUrl.searchParams.get("scope")).toContain("offline.access");
  const token = x.calls.find((c) => c.key === "POST /2/oauth2/token");
  expect(token?.headers.get("authorization")).toBe(BASIC);
  expect(token?.body).not.toHaveProperty("client_secret");
  expect(token?.body).not.toHaveProperty("client_id");
  expect(token?.body).toHaveProperty("code_verifier");
  expect(connection).toMatchObject({ accountLabel: "@acme", accountId: "1234", authType: "oauth" });
  expect(await revokeAtProvider(deps(x.http), f.org.id, connection.id)).toBe(true);
  expect(x.calls.at(-1)).toMatchObject({ key: "POST /2/oauth2/revoke", body: { token: "fake-refresh" } });
});

test("a post with a picture from the Drive: uploaded, then posted with its media id; mentions read as data", async () => {
  const x = fakeX();
  const ctx = await world(x.http);
  await connectX(x.http);
  const picture = await createFileArtifact(f.artifactDeps, { type: "person", userId: f.owner.id }, f.org.id, {
    title: "launch.png",
    name: "launch.png",
    bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    contentType: "image/png",
    channelId: f.general.id,
  });
  const out = await call(ctx, "x_create_post", { text: "Lançamos hoje!", media: [picture.id] });
  expect(out.content).toBe("Posted on X: https://x.com/acme/status/9876.");
  expect(x.calls.find((c) => c.key === "POST /2/tweets")?.body).toEqual({
    text: "Lançamos hoje!",
    media: { media_ids: ["555"] },
  });
  const mentions = await call(ctx, "x_get_mentions", {});
  expect(mentions.content).toContain("@acme oi");
  expect(x.calls.find((c) => c.key === "GET /2/users/1234/mentions")?.url).toContain("max_results=10");
});

test("X's limits and refusals in words, the workspace's monthly cap, deleting asks", async () => {
  const reset = Math.floor(Date.UTC(2030, 0, 1, 14, 32) / 1000);
  const x = fakeX({
    "POST /2/tweets": () =>
      Response.json({ title: "Too Many Requests" }, { status: 429, headers: { "x-rate-limit-reset": String(reset) } }),
  });
  const ctx = await world(x.http, { x: 2 });
  const { connection } = await connectX(x.http);
  const limited = await call(ctx, "x_create_post", { text: "oi" });
  expect(limited).toMatchObject({ isError: true, data: { code: "connector.rate_limited" } });
  expect(limited.content).toBe("X takes no more of this from the account until 14:32 UTC. Nothing was posted.");
  const ask = await f.tools?.invoke(ctx, {
    toolUseId: "tu_delete",
    name: "x_delete_post",
    input: { id: "9876", why: "The person asked to take down the post with the wrong launch date." },
  });
  expect(ask?.type).toBe("approval");
  await f.db.insert(schema.connectorUsageDays).values({
    day: new Date().toISOString().slice(0, 10),
    connector: "x",
    via: "native",
    orgId: f.org.id,
    agentId: f.agent.id,
    tool: "search_recent",
    calls: 2,
  });
  const capped = await call(ctx, "x_get_my_posts", {});
  expect(capped).toMatchObject({ isError: true, data: { code: "connector.capped" } });
  void connection;
});

test("X calls priced by what X answered, and refused before a call that could pass the month's budget", async () => {
  const x = fakeX();
  const ctx = await world(x.http);
  await connectX(x.http);
  const none = { members: null, membersMax: null, payerUserId: null, storageBytes: null, uploadBytesPerDay: null };
  await setOrgLimits(f.db, f.org.id, { ...none, platformUsdPerMonth: null, connectorUsdPerMonth: 0.2 });
  expect((await call(ctx, "x_create_post", { text: "Lançamos hoje!" })).isError).toBeUndefined();
  expect((await call(ctx, "x_get_mentions", {})).isError).toBeUndefined();
  expect((await call(ctx, "x_get_post", { id: "404" })).isError).toBe(true);
  const posts = x.calls.filter((c) => c.key === "POST /2/tweets").length;
  const link = await call(ctx, "x_create_post", { text: "Read it at example.com" });
  expect(link).toMatchObject({ isError: true, data: { code: "connector.capped" } });
  expect(link.content).toStartWith("X budget for this month used:");
  expect(link.content).toContain("US$ 0.02 of its US$ 0.20");
  expect(x.calls.filter((c) => c.key === "POST /2/tweets").length).toBe(posts);
  const rows = await f.db.select().from(schema.connectorUsageDays);
  // A post (US$ 0.015), one mention returned (US$ 0.005), a failed read and a refused post: nothing.
  expect(rows.reduce((sum, r) => sum + r.costNanoUsd, 0)).toBe(20_000_000);
  expect((await orgLimitsView(f.db, f.owner.id, f.org.id)).connectors).toEqual({ usedUsd: 0.02, limitUsd: 0.2 });
});

test("without its app a self-hosted server says what's missing; the Cloud keeps it unavailable", () => {
  const x = (cloud: boolean) => connectorListing({ oauthApps: {}, cloud }).find((e) => e.id === "x");
  expect(x(false)).toMatchObject({ available: false, needsApp: true });
  expect(x(true)).toMatchObject({ available: false });
  expect(x(true)?.needsApp).toBeUndefined();
  expect(connectorListing({ oauthApps: { x: APP } }).find((e) => e.id === "x")).toMatchObject({ available: true });
});
