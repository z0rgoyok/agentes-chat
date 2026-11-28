import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { callTool, mcp } from "./ai-apps";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/** Integration apps (ADR 0251): Settings › Integrations, the public API and `/mcp`, as the app itself. */

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({
    reply: () => ({ chunks: ["It ships tomorrow."] }),
    resolveHost: async () => ["93.184.215.14"],
  });
});
afterEach(() => t.close());

type Made = { app: { id: string; tokenHint: string | null }; token: string; webhookSecret: string | null };

async function setup() {
  const b = browser(t);
  await signUp(b, "owner@example.com");
  const seeded = await seedOrg(b);
  const res = await b(`/api/app/organizations/${seeded.orgId}/integration-apps`, {
    json: { name: "Support bot", color: "teal", channels: [{ channelId: seeded.channelId, canPost: true }] },
  });
  expect(res.status).toBe(201);
  const made = (await res.json()) as Made;
  return { b, ...seeded, made };
}

const api = (path: string, token: string | null, init: { method?: string; json?: unknown } = {}) =>
  t.app.request(`/api/v1${path}`, {
    method: init.method ?? (init.json ? "POST" : "GET"),
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.json ? { "content-type": "application/json" } : {}),
    },
    ...(init.json ? { body: JSON.stringify(init.json) } : {}),
  });

describe("Settings › Integrations", () => {
  test("an admin makes an app and sees its token once; the list never shows it again", async () => {
    const { b, orgId, made } = await setup();
    expect(made.token).toMatch(/^agi_/);
    const list = (await (await b(`/api/app/organizations/${orgId}/integration-apps`)).json()) as { apps: unknown[] };
    expect(JSON.stringify(list)).not.toContain(made.token);
    expect(list.apps).toHaveLength(1);
  });

  test("a member without manage_connectors can't make or see one", async () => {
    const { b, orgId, channelId } = await setup();
    const other = await joinByInvitation(t, b, orgId, "bia@example.com");
    expect((await other(`/api/app/organizations/${orgId}/integration-apps`)).status).toBe(403);
    const made = await other(`/api/app/organizations/${orgId}/integration-apps`, {
      json: { name: "Mine", channels: [{ channelId, canPost: true }] },
    });
    expect(made.status).toBe(403);
  });

  test("revoking the token stops the app at once", async () => {
    const { b, orgId, made } = await setup();
    expect((await api("/channels", made.token)).status).toBe(200);
    const res = await b(`/api/app/organizations/${orgId}/integration-apps/${made.app.id}/token`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await api("/channels", made.token)).status).toBe(401);
  });
});

describe("the public API, as the app", () => {
  test("no token, a person's session or a personal token: 401; the app's token: its channels", async () => {
    const { b, made, channelId } = await setup();
    expect((await api("/channels", null)).status).toBe(401);
    const withCookie = await t.app.request("/api/v1/channels", { headers: { cookie: b.cookie() } });
    expect(withCookie.status).toBe(401);
    expect((await api("/channels", "agp_notanapptoken")).status).toBe(401);
    const res = await api("/channels", made.token);
    expect(await res.json()).toMatchObject({ channels: [{ id: channelId, can_post: true }] });
  });

  test("it posts as itself, an agent answers, and the reply comes back by polling", async () => {
    const { made, channelId } = await setup();
    const res = await api("/messages", made.token, {
      json: { channel_id: channelId, text: "@dev where is my order?", sender: "Maria" },
    });
    expect(res.status).toBe(201);
    const posted = (await res.json()) as { message: { id: string; author: { type: string } } };
    expect(posted.message.author.type).toBe("app");
    await t.drain();
    const read = (await (await api(`/messages?after=${posted.message.id}`, made.token)).json()) as {
      messages: { text: string; in_reply_to: string | null; author: { type: string } }[];
    };
    const reply = read.messages.find((m) => m.author.type === "agent");
    expect(reply).toMatchObject({ text: "It ships tomorrow.", in_reply_to: posted.message.id });
    const [stored] = await t.db.select().from(schema.messages).where(eq(schema.messages.id, posted.message.id));
    expect(stored).toMatchObject({ authorType: "app", authorUserId: null, origin: "integration" });
  });

  test("bodies are bounded and unknown fields refused", async () => {
    const { made, channelId } = await setup();
    const long = await api("/messages", made.token, { json: { channel_id: channelId, text: "x".repeat(8001) } });
    expect(long.status).toBe(400);
    const extra = await api("/messages", made.token, { json: { channel_id: channelId, text: "hi", author: "owner" } });
    expect(extra.status).toBe(400);
    const huge = await t.app.request("/api/v1/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${made.token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel_id: channelId, text: "y".repeat(70_000) }),
    });
    expect(huge.status).toBe(413);
  });

  test("calls with a token that names no app are limited per address", async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await api("/channels", "agi_doesnotexist")).status;
    expect(last).toBe(429);
  });
});

describe("/mcp, as the app", () => {
  test("its own three tools, never a person's; post_message posts as the app", async () => {
    const { made, channelId } = await setup();
    const list = (await (await mcp(t, made.token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as {
      result: { tools: { name: string }[] };
    };
    expect(list.result.tools.map((x) => x.name).sort()).toEqual(["list_channels", "post_message", "read_messages"]);
    const out = await callTool(t, made.token, "post_message", { channel_id: channelId, text: "hello from Discord" });
    expect(out.isError).toBeFalsy();
    const [row] = await t.db.select().from(schema.messages).where(eq(schema.messages.authorType, "app"));
    expect(row?.body).toBe("hello from Discord");
  });

  test("an unknown app token is refused with a 401", async () => {
    await setup();
    const res = await mcp(t, "agi_doesnotexist", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
  });
});
