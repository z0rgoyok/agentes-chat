import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { enableOperatorEvents, sweepSupportRequests } from "@agenteschat/engine";
import { createLogger } from "../src/logger";
import { createOperatorApp } from "../src/operator/app";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/**
 * Support requests (ADR 0160, ADR 0056): the record that a member asked whoever runs the server for help. Only the
 * member's own act writes one, or the operator recording a request that came another way; what they wrote is kept
 * only on a server whose operator set the reveal token.
 */

const TOKEN = "operator-test-token-".padEnd(48, "x");
const READ = "operator-read-token-".padEnd(48, "x");
const REVEAL = "operator-reveal-token-".padEnd(48, "x");
const UNKNOWN = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const ENV = { OPERATOR_API_TOKEN: TOKEN, OPERATOR_API_READ_TOKEN: READ, FEEDBACK_EMAIL: "feedback@example.com" };

type Listed = {
  id: string;
  userId: string;
  source: string | null;
  aboutKind: string | null;
  messageId: string | null;
  hasWords: boolean;
  createdAt: string;
};

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});
beforeAll(() => enableOperatorEvents());
afterAll(() => enableOperatorEvents(false));

/** A server, its owner in a workspace, and the operator API as each token calls it. */
async function world(env: Record<string, string> = {}) {
  t = await createTestServer({ env: { ...ENV, ALLOW_SIGNUP: "true", ...env } });
  const app = createOperatorApp(
    { db: t.db, config: t.config, version: "test", log: createLogger("error") },
    TOKEN,
    READ,
    t.config.OPERATOR_API_REVEAL_TOKEN,
  );
  const as = (token: string) => (path: string, json?: unknown) =>
    app.request(`/api/operator/v1${path}`, {
      method: json === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(json === undefined ? {} : { "content-type": "application/json" }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const org = await seedOrg(owner);
  const [user] = await t.db.select({ id: schema.users.id }).from(schema.users);
  if (!user) throw new Error("no user");
  const stored = () => t.db.select().from(schema.supportRequests).orderBy(schema.supportRequests.createdAt);
  const listed = async () => {
    const res = await as(READ)(`/orgs/${org.orgId}/support-requests`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { requests: Listed[] }).requests;
  };
  return { ...org, ownerId: user.id, owner, full: as(TOKEN), read: as(READ), reveal: as(REVEAL), stored, listed };
}

const id = (n: number) => `7b0c2c0e-5a51-4a3f-9d0e-0d6f6a4f1a${String(n).padStart(2, "0")}`;
const feedback = (b: Browser, json: Record<string, unknown>) => b("/api/app/feedback", { json });

async function post(w: { owner: Browser; orgId: string; channelId: string }, body: string) {
  const res = await w.owner(`/api/app/organizations/${w.orgId}/channels/${w.channelId}/messages`, { json: { body } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

test("the form records a member's request: who, where, what kind of thing and which message, and their words", async () => {
  const w = await world({ OPERATOR_API_REVEAL_TOKEN: REVEAL });
  const messageId = await post(w, "The export never finished");
  const sent = await feedback(w.owner, {
    id: id(1),
    text: "  The export button does nothing  ",
    orgId: w.orgId,
    about: { kind: "agent message", label: "Dev", text: "I exported it for you." },
    facts: [
      ["Screen", "chat"],
      ["Message id", messageId],
    ],
  });
  expect(sent.status).toBe(204);
  // The same form sent again (a retry of the request) is the same request.
  expect((await feedback(w.owner, { id: id(1), text: "The export button does nothing", orgId: w.orgId })).status).toBe(
    204,
  );

  expect(await w.stored()).toEqual([
    {
      id: expect.any(String),
      orgId: w.orgId,
      userId: w.ownerId,
      source: "form",
      ref: id(1),
      aboutKind: "agent_message",
      messageId,
      text: "The export button does nothing",
      about: "I exported it for you.",
      createdAt: expect.any(Date),
    },
  ]);
  const [request] = await w.listed();
  expect(request).toEqual({
    id: expect.any(String),
    userId: w.ownerId,
    source: "form",
    aboutKind: "agent_message",
    messageId,
    hasWords: true,
    createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
  });

  // The feed says that it was asked, never what.
  const events = await t.db
    .select()
    .from(schema.operatorEvents)
    .where(eq(schema.operatorEvents.type, "support.requested"));
  expect(events.map((e) => [e.orgId, e.userId, e.data])).toEqual([
    [w.orgId, w.ownerId, { requestId: request?.id, source: "form" }],
  ]);
  // The mail still goes as it always did.
  await t.drain();
  expect(t.email.sent.filter((m) => m.to.includes("feedback@example.com"))).toHaveLength(1);
});

test("the two facts: the form's own kinds, any other word as `other`, and a message id only when it is this workspace's", async () => {
  const w = await world({ OPERATOR_API_REVEAL_TOKEN: REVEAL });
  const mine = await post(w, "A message of this workspace");
  // Another workspace, with a message of its own.
  const other = browser(t);
  await signUp(other, "other@example.com");
  const theirs = await seedOrg(other);
  const foreign = await post({ owner: other, ...theirs }, "A message of another workspace");

  const cases: [
    about: Record<string, string> | undefined,
    facts: [string, string][],
    kind: string | null,
    message: string | null,
  ][] = [
    [{ kind: "message" }, [["Message id", mine]], "message", mine],
    [{ kind: "card" }, [], "card", null],
    [{ kind: "button-canary-word" }, [["Element", "main > button"]], "other", null],
    [{ kind: "constructor" }, [], "other", null],
    [{ kind: "message" }, [["Message id", foreign]], "message", null],
    [{ kind: "message" }, [["Message id", "not-an-id"]], "message", null],
    [{ kind: "message" }, [["Message id", UNKNOWN]], "message", null],
    [undefined, [["Message id", mine]], null, mine],
    [undefined, [], null, null],
  ];
  for (const [n, [about, facts]] of cases.entries()) {
    const sent = await feedback(w.owner, { id: id(n), text: `Report ${n}`, orgId: w.orgId, about, facts });
    expect({ n, status: sent.status }).toEqual({ n, status: 204 });
  }
  const rows = await w.stored();
  expect(rows.map((r) => [r.aboutKind, r.messageId])).toEqual(cases.map(([, , kind, message]) => [kind, message]));
  // The word the browser sent is in no column.
  expect(JSON.stringify(rows)).not.toContain("canary");
});

test("nobody's request: a person who is no member of the workspace they named, and a form that names none", async () => {
  const w = await world({ OPERATOR_API_REVEAL_TOKEN: REVEAL });
  const bia = browser(t);
  await signUp(bia, "bia@example.com");
  expect((await feedback(bia, { id: id(1), text: "From outside", orgId: w.orgId })).status).toBe(204);
  expect((await feedback(w.owner, { id: id(2), text: "From nowhere" })).status).toBe(204);
  expect(await w.stored()).toEqual([]);
  expect(await w.listed()).toEqual([]);
});

test("without the reveal token the row holds ids alone, whoever writes it", async () => {
  const w = await world();
  const messageId = await post(w, "The export never finished");
  const sent = await feedback(w.owner, {
    id: id(1),
    text: "The export button does nothing",
    orgId: w.orgId,
    about: { kind: "message", text: "The export never finished" },
    facts: [["Message id", messageId]],
  });
  expect(sent.status).toBe(204);
  const recorded = await w.full(`/orgs/${w.orgId}/support-requests`, {
    userId: w.ownerId,
    source: "email",
    ref: "mail-1",
    text: "It still does nothing",
  });
  expect(recorded.status).toBe(200);
  expect((await w.stored()).map((r) => [r.source, r.aboutKind, r.messageId, r.text, r.about])).toEqual([
    ["form", "message", messageId, null, null],
    ["email", null, null, null, null],
  ]);
  expect((await w.listed()).map((r) => r.hasWords)).toEqual([false, false]);
  // The door the words would leave through is closed there.
  expect((await w.reveal(`/reveal/orgs/${w.orgId}`, {})).status).toBe(403);
});

test("a person's own send of a report an agent offered is their request; putting it away is none", async () => {
  const w = await world({ OPERATOR_API_REVEAL_TOKEN: REVEAL });
  const offer = (n: number) => ({
    id: id(n),
    forUserId: w.ownerId,
    summary: "the browser closed",
    text: `The agent's browser closed twice (${n}).`,
    state: "offered",
  });
  const reply = async (n: number) => {
    const [message] = await t.db
      .insert(schema.messages)
      .values({
        orgId: w.orgId,
        channelId: w.channelId,
        authorType: "agent",
        authorAgentId: w.agentId,
        body: "I couldn't open the page.",
        meta: { feedbackOffer: offer(n) },
      })
      .returning({ id: schema.messages.id });
    return message?.id ?? "";
  };
  const decide = (messageId: string, decision: "send" | "dismiss") =>
    w.owner(`/api/app/feedback/offers/${messageId}`, { json: { orgId: w.orgId, decision } });

  const dismissed = await reply(1);
  expect((await decide(dismissed, "dismiss")).status).toBe(200);
  expect(await w.stored()).toEqual([]);

  const sent = await reply(2);
  expect((await decide(sent, "send")).status).toBe(200);
  // Decided again from another device: nothing more is written.
  expect((await decide(sent, "send")).status).toBe(200);
  expect((await w.stored()).map(({ id: _, createdAt: __, ...row }) => row)).toEqual([
    {
      orgId: w.orgId,
      userId: w.ownerId,
      source: "offer",
      ref: id(2),
      aboutKind: "agent_message",
      messageId: sent,
      text: "The agent's browser closed twice (2).",
      about: null,
    },
  ]);
});

test("the operator records a request that came another way: an open member's, once per ref, with no fact of the thing reported", async () => {
  const w = await world({ OPERATOR_API_REVEAL_TOKEN: REVEAL });
  const path = `/orgs/${w.orgId}/support-requests`;
  const mail = { userId: w.ownerId, source: "email", ref: "mail-1", text: "My agent stopped answering" };
  const first = await w.full(path, mail);
  expect(first.status).toBe(200);
  const recorded = (await first.json()) as Listed;
  expect(recorded).toEqual({
    id: expect.any(String),
    userId: w.ownerId,
    source: "email",
    aboutKind: null,
    messageId: null,
    hasWords: true,
    createdAt: expect.any(String),
  });
  // The same mail read twice is one request, whatever it says the second time.
  const again = await w.full(path, { ...mail, text: "Other words" });
  expect(((await again.json()) as Listed).id).toBe(recorded.id);
  // Recorded by hand, with no words.
  expect((await w.full(path, { userId: w.ownerId, source: "operator", ref: "record-7" })).status).toBe(200);
  expect((await w.stored()).map((r) => [r.source, r.ref, r.text])).toEqual([
    ["email", "mail-1", "My agent stopped answering"],
    ["operator", "record-7", null],
  ]);
  expect((await w.listed()).map((r) => [r.source, r.hasWords])).toEqual([
    ["operator", false],
    ["email", true],
  ]);

  // Someone who is no member, someone the app no longer lets in, and a workspace nobody has.
  const bia = browser(t);
  await signUp(bia, "bia@example.com");
  const [outsider] = await t.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, "bia@example.com"));
  await joinByInvitation(t, w.owner, w.orgId, "caio@example.com");
  const [blocked] = await t.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, "caio@example.com"));
  await t.db
    .update(schema.users)
    .set({ blockedAt: new Date() })
    .where(eq(schema.users.id, blocked?.id ?? ""));
  for (const [where, json] of [
    [path, { ...mail, ref: "mail-2", userId: outsider?.id }],
    [path, { ...mail, ref: "mail-3", userId: blocked?.id }],
    [path, { ...mail, ref: "mail-4", userId: "nobody" }],
    [`/orgs/${UNKNOWN}/support-requests`, { ...mail, ref: "mail-5" }],
  ] as const) {
    const res = await w.full(where, json);
    expect({ json, status: res.status }).toEqual({ json, status: 404 });
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  }
  // Only the two ways a request reaches an operator outside the app, each with its own id for it.
  for (const json of [
    { ...mail, source: "form" },
    { ...mail, source: "offer" },
    { ...mail, ref: "" },
    { ...mail, ref: "r".repeat(201) },
    { userId: w.ownerId, source: "email" },
    { ...mail, ref: "mail-6", text: "x".repeat(4001) },
    { ...mail, ref: "mail-7", messageId: UNKNOWN, extra: ["a", "list"] },
  ]) {
    const res = await w.full(path, json);
    expect({ json, status: res.status }).toEqual({ json, status: "extra" in json ? 200 : 400 });
  }
  // A field the route doesn't know is dropped, never stored.
  expect((await w.stored()).find((r) => r.ref === "mail-7")?.messageId).toBeNull();
  expect(await w.stored()).toHaveLength(3);
});

test("the write takes the full token alone; the read takes the read token", async () => {
  const w = await world({ OPERATOR_API_REVEAL_TOKEN: REVEAL });
  const path = `/orgs/${w.orgId}/support-requests`;
  const json = { userId: w.ownerId, source: "operator", ref: "record-1" };
  expect((await w.read(path, json)).status).toBe(403);
  expect((await w.reveal(path, json)).status).toBe(403);
  expect((await w.reveal(path)).status).toBe(403);
  expect(await w.stored()).toEqual([]);
  expect((await w.full(path, json)).status).toBe(200);
  expect((await w.read(path)).status).toBe(200);
  expect((await w.full(path)).status).toBe(200);
  expect((await w.read(`/orgs/${UNKNOWN}/support-requests`)).status).toBe(404);
  expect((await w.read(`${path}?limit=201`)).status).toBe(400);
});

test("the read pages, newest first", async () => {
  const w = await world();
  for (let n = 0; n < 5; n++) {
    await w.full(`/orgs/${w.orgId}/support-requests`, { userId: w.ownerId, source: "operator", ref: `record-${n}` });
  }
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const res = await w.read(`/orgs/${w.orgId}/support-requests?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
    const page = (await res.json()) as { requests: Listed[]; next: string | null };
    expect(page.requests.length).toBeLessThanOrEqual(2);
    seen.push(...page.requests.map((r) => r.id));
    cursor = page.next;
  } while (cursor);
  const stored = (await w.stored()).map((r) => r.id);
  expect(seen).toEqual(stored.reverse());
});

test("kept: the words go at 90 days and the row at 365; an account's and a workspace's go with them", async () => {
  const w = await world({ OPERATOR_API_REVEAL_TOKEN: REVEAL });
  const day = 86_400_000;
  const aged = (days: number) => ({
    orgId: w.orgId,
    userId: w.ownerId,
    source: "form",
    ref: `aged-${days}`,
    text: "what they wrote",
    about: "what it said",
    createdAt: new Date(Date.now() - days * day),
  });
  await t.db.insert(schema.supportRequests).values([aged(89), aged(91), aged(364), aged(366)]);
  expect(await sweepSupportRequests(t.db)).toEqual({ blanked: 2, deleted: 1 });
  expect((await w.stored()).map((r) => [r.ref, r.text, r.about])).toEqual([
    ["aged-364", null, null],
    ["aged-91", null, null],
    ["aged-89", "what they wrote", "what it said"],
  ]);
  expect(await sweepSupportRequests(t.db)).toEqual({ blanked: 0, deleted: 0 });

  // A member's requests go with their account, the rest with the workspace.
  await joinByInvitation(t, w.owner, w.orgId, "caio@example.com");
  const [caio] = await t.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, "caio@example.com"));
  await w.full(`/orgs/${w.orgId}/support-requests`, { userId: caio?.id, source: "operator", ref: "record-1" });
  expect(await w.stored()).toHaveLength(4);
  await t.db.delete(schema.users).where(eq(schema.users.id, caio?.id ?? ""));
  expect(await w.stored()).toHaveLength(3);
  await t.db.delete(schema.organizations).where(eq(schema.organizations.id, w.orgId));
  expect(await w.stored()).toEqual([]);
});
