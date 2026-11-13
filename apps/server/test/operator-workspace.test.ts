import { afterAll, beforeAll, expect, test } from "bun:test";
import { rowsOf, schema, sql, tracingLogger } from "@agenteschat/db";
import { createLogger } from "../src/logger";
import { createOperatorApp } from "../src/operator/app";
import { createTestServer, type TestServer } from "./harness";

/**
 * ADR 0056, what a workspace connected, recorded, asked and scheduled: its connections, its audit log without the
 * details, what its agents asked and its routines. Everything a person or a model wrote here says "canary" and every
 * secret starts with "fake-": no answer may carry either.
 */

const TOKEN = "operator-test-token-".padEnd(48, "x");
const READ = "operator-read-token-".padEnd(48, "x");
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const uid = (start: string, n: number) => `${start}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADA = uid("11111111", 1);
const LIA = uid("22222222", 1);
const DEV = uid("33333333", 1);
const OPS = uid("33333333", 2);
const LIA_DEV = uid("33333333", 3);
const GENERAL = uid("44444444", 1);
const TALK = uid("44444444", 2);
const LIA_GENERAL = uid("44444444", 3);
const BOX = uid("55555555", 1);
const RUN = uid("55555555", 2);
const OTHER_RUN = uid("55555555", 3);
const LIA_RUN = uid("55555555", 4);
const ROOT = uid("55555555", 5);
const connection = (n: number) => uid("66666666", n);
const entry = (n: number) => uid("77777777", n);
const ask = (n: number) => uid("88888888", n);
const routine = (n: number) => uid("99999999", n);
const firing = (n: number) => uid("aaaaaaaa", n);
const UNKNOWN = uid("0b0b0b0b", 1);
const day = (n: number) => new Date(Date.UTC(2026, 0, n));
const now = Date.now();
const ago = (hours: number) => new Date(now - hours * HOUR);
const soon = new Date(now + DAY);

/** Stored beside what the reads return, and never theirs to say. */
const HIDDEN = ["canary", "fake-", "box@example.com", "db.example.com", "/sse"];
const SEALED = { secretCiphertext: "fake-ciphertext", wrappedDataKey: "fake-wrapped", kekId: "local:v1" };

let t: TestServer;
/** A GET with this token (null: none); the read-only one unless said. */
let get: (path: string, token?: string | null) => Promise<Response>;
/** Every answer read, to be searched for what is hidden. */
const answers: string[] = [];

beforeAll(async () => {
  t = await createTestServer({ env: { OPERATOR_API_TOKEN: TOKEN } });
  const app = createOperatorApp(
    { db: t.db, config: t.config, version: "test", log: createLogger("error") },
    TOKEN,
    READ,
  );
  get = async (path, token = READ) =>
    app.request(`/api/operator/v1${path}`, { headers: token === null ? {} : { authorization: `Bearer ${token}` } });
  const db = t.db;

  await db.insert(schema.organizations).values([
    { id: ADA, name: "Ada Labs" },
    { id: LIA, name: "Lia Studio" },
  ]);
  await db.insert(schema.users).values([
    { id: "u-ada", name: "Ada", email: "ada@example.com" },
    { id: "u-bob", name: "Bob", email: "bob@example.com" },
  ]);
  const agent = { model: "claude-sonnet-5-5", instructions: "canary instructions" };
  await db.insert(schema.agents).values([
    { ...agent, id: DEV, orgId: ADA, name: "Dev", handle: "dev", ownerUserId: "u-ada" },
    { ...agent, id: OPS, orgId: ADA, name: "Ops", handle: "ops" },
    { ...agent, id: LIA_DEV, orgId: LIA, name: "Dev", handle: "dev" },
  ]);
  await db.insert(schema.channels).values([
    { id: GENERAL, orgId: ADA, name: "general" },
    { id: TALK, orgId: ADA, name: "dm-agents", kind: "dm" },
    { id: LIA_GENERAL, orgId: LIA, name: "general" },
  ]);
  await db.insert(schema.machines).values({ id: BOX, orgId: ADA, name: "Box", tokenHash: "fake-machine-hash" });
  const run = { threadRootId: ROOT, triggerMessageId: ROOT, trigger: "mention" as const, hop: 1 };
  await db.insert(schema.agentRuns).values([
    { ...run, id: RUN, orgId: ADA, agentId: DEV, channelId: GENERAL },
    { ...run, id: OTHER_RUN, orgId: ADA, agentId: OPS, channelId: GENERAL },
    { ...run, id: LIA_RUN, orgId: LIA, agentId: LIA_DEV, channelId: LIA_GENERAL },
  ]);

  // ── Connections ──
  const connector = { ...SEALED, orgId: ADA, authType: "oauth", accountLabel: "canary account", accountId: "fake-id" };
  await db.insert(schema.connectorConnections).values([
    {
      ...connector,
      id: connection(1),
      connector: "github",
      label: "GitHub",
      serverUrl: "https://api.example.com/mcp",
      toolPrefix: "github",
      createdByUserId: "u-ada",
      createdAt: day(2),
    },
    // The sign-in the one above replaced.
    {
      ...connector,
      id: connection(2),
      connector: "github",
      label: "GitHub",
      serverUrl: "https://api.example.com/mcp",
      toolPrefix: "github_old",
      createdAt: day(1),
      revokedAt: day(2),
    },
    {
      ...connector,
      id: connection(3),
      connector: "custom:billing",
      label: "Billing server",
      serverUrl: "https://mcp.example.net/sse?key=fake-key",
      authType: "api_key",
      toolPrefix: "billing",
      status: "needs_reconnect",
      lastError: "refused by https://app:fake-pass@mcp.example.net/v1",
      createdByUserId: "u-bob",
      createdAt: day(3),
    },
    {
      ...connector,
      id: connection(9),
      orgId: LIA,
      connector: "github",
      label: "Lia's",
      serverUrl: "https://api.example.com/mcp",
      toolPrefix: "github",
    },
  ]);
  const tool = (name: string, access: string | null, removedAt: Date | null = null) => ({
    orgId: ADA,
    connectionId: connection(3),
    name: `canary_${name}`,
    description: "canary tool description",
    label: "canary tool label",
    access,
    removedAt,
  });
  await db
    .insert(schema.customTools)
    .values([
      tool("list", "read"),
      tool("get", "read"),
      tool("create", "write"),
      tool("pay", "approval"),
      tool("purge", "off"),
      tool("new", null),
      tool("odd", "whatever"),
      tool("gone", "read", day(4)),
    ]);
  await db.insert(schema.mailAccounts).values([
    {
      ...SEALED,
      id: connection(4),
      orgId: ADA,
      provider: "gmail",
      via: "composio",
      address: "box@example.com",
      label: "Support",
      status: "needs_reconnect",
      lastError: "account_removed",
      externalAccountId: "fake-account",
      createdByUserId: "u-ada",
      createdAt: day(4),
    },
    {
      ...SEALED,
      id: connection(5),
      orgId: ADA,
      provider: "imap",
      via: "imap",
      preset: "icloud",
      address: "other-box@example.com",
      label: "Bob's",
      status: "active",
      username: "fake-user",
      createdAt: day(5),
    },
    // Nobody named it: the server calls a mailbox by its address.
    {
      ...SEALED,
      id: connection(7),
      orgId: ADA,
      provider: "imap",
      via: "imap",
      address: "ana@example.org",
      label: "ana@example.org",
      status: "active",
      username: "fake-user",
      createdAt: day(7),
    },
  ]);
  const database = { ...SEALED, orgId: ADA, database: "canary_db", username: "fake-user" };
  await db.insert(schema.dbConnections).values([
    {
      ...database,
      id: connection(6),
      label: "Production",
      host: "db.example.com",
      createdByUserId: "u-ada",
      createdAt: day(6),
    },
    // Nobody named it: the server calls a whole server by its host.
    {
      ...database,
      id: connection(8),
      label: "pg.example.org",
      host: "pg.example.org",
      wholeServer: true,
      createdAt: day(8),
    },
  ]);
  const used = { via: "mcp" as const, orgId: ADA, agentId: DEV, tool: "get_issue" };
  await db.insert(schema.connectorUsageDays).values([
    { ...used, day: "2026-01-03", connector: "github", calls: 1 },
    { ...used, day: "2026-01-05", connector: "github", calls: 3 },
    // An approval asked and no call made: not a use.
    { ...used, day: "2026-01-07", connector: "github", calls: 0, approvalsAsked: 1 },
    { ...used, day: "2026-01-04", connector: "gmail", via: "composio", calls: 2 },
    { ...used, day: "2026-01-09", connector: "github", orgId: LIA, agentId: LIA_DEV, calls: 5 },
  ]);

  // ── The audit log ──
  const details = { input: { q: "canary audit input" }, label: "canary label", title: "canary title" };
  await db.insert(schema.auditLog).values([
    {
      id: entry(1),
      orgId: ADA,
      actorType: "person",
      actorId: "u-ada",
      action: "connector.connected",
      targetType: "connector",
      targetId: connection(1),
      details,
      createdAt: ago(5),
    },
    {
      id: entry(2),
      orgId: ADA,
      actorType: "agent",
      actorId: DEV,
      action: "tool.call",
      targetType: "tool",
      targetId: "lookup",
      details,
      runId: RUN,
      channelId: GENERAL,
      onBehalfOfUserId: "u-ada",
      outcome: "done",
      createdAt: ago(4),
    },
    {
      id: entry(3),
      orgId: ADA,
      actorType: "agent",
      actorId: DEV,
      action: "tool.call",
      targetType: "tool",
      targetId: "ship",
      details,
      runId: RUN,
      outcome: "refused",
      createdAt: ago(3),
    },
    {
      id: entry(4),
      orgId: ADA,
      actorType: "system",
      action: "connector.disconnected",
      targetType: "connector",
      // Words where a name belongs: never returned.
      targetId: "canary words, not a name",
      details,
      createdAt: ago(2),
    },
    {
      id: entry(5),
      orgId: ADA,
      actorType: "person",
      actorId: "u-bob",
      action: "routine.created",
      targetType: "routine",
      targetId: routine(1),
      details,
      createdAt: new Date(now - 40 * DAY),
    },
    {
      id: entry(9),
      orgId: LIA,
      actorType: "agent",
      actorId: LIA_DEV,
      action: "tool.call",
      targetType: "tool",
      targetId: "lookup",
      details,
      createdAt: ago(1),
    },
  ]);

  // ── What agents asked ──
  const asked = { orgId: ADA, agentId: DEV, channelId: GENERAL, expiresAt: soon };
  const approval = {
    ...asked,
    runId: RUN,
    threadRootId: ROOT,
    tool: "ship",
    scope: "test:write",
    params: { what: "canary params" },
    title: "canary approval title",
    detail: "canary detail",
    why: "canary why",
    ownerUserId: "u-ada",
  };
  await db.insert(schema.approvals).values([
    { ...approval, id: ask(1), toolUseId: "call-1", actionHash: "fake-hash-1", messageId: ROOT, createdAt: ago(9) },
    {
      ...approval,
      id: ask(2),
      toolUseId: "call-2",
      actionHash: "fake-hash-2",
      status: "refused",
      reason: "canary refusal reason",
      approvers: { userIds: ["u-bob"], label: "canary approvers", requestedBy: "u-ada", requesterDecides: false },
      decidedByUserId: "u-bob",
      decidedAt: ago(7),
      createdAt: ago(8),
    },
    {
      ...approval,
      id: ask(9),
      orgId: LIA,
      agentId: LIA_DEV,
      channelId: LIA_GENERAL,
      runId: LIA_RUN,
      toolUseId: "call-9",
      actionHash: "fake-hash-9",
    },
  ]);
  const question = { ...asked, runId: RUN, text: "canary question?", choices: ["canary yes", "canary no"] };
  await db.insert(schema.agentQuestions).values([
    { ...question, id: ask(3), toolUseId: "call-3", threadId: ROOT, createdAt: ago(7) },
    {
      ...question,
      id: ask(4),
      agentId: OPS,
      runId: OTHER_RUN,
      toolUseId: "call-4",
      requestedForUserId: "u-bob",
      status: "answered",
      answer: "canary answer",
      answeredByUserId: "u-bob",
      answeredAt: ago(5),
      createdAt: ago(6),
    },
  ]);
  await db.insert(schema.secretRequests).values({
    ...asked,
    id: ask(5),
    runId: RUN,
    toolUseId: "call-5",
    requestedForUserId: "u-ada",
    name: "CANARY_NAME",
    label: "canary secret label",
    purpose: "canary purpose",
    targetKind: "env",
    publicKey: "fake-public-key",
    createdAt: ago(5),
  });
  const handoff = { orgId: ADA, agentId: DEV, machineId: BOX, instructions: "canary instructions", expiresAt: soon };
  await db.insert(schema.browserHandoffs).values([
    { ...handoff, id: ask(6), runId: RUN, kind: "ask", requestedForUserId: "u-ada", createdAt: ago(4) },
    {
      ...handoff,
      id: ask(7),
      kind: "takeover",
      status: "done",
      controllerUserId: "u-bob",
      note: "canary note",
      resolvedAt: ago(2),
      createdAt: ago(3),
    },
  ]);
  await db.insert(schema.agentConsultations).values({
    id: ask(8),
    orgId: ADA,
    askerRunId: RUN,
    askerAgentId: DEV,
    targetAgentId: OPS,
    channelId: TALK,
    messageId: uid("55555555", 6),
    targetRunId: OTHER_RUN,
    waitId: "fake-wait",
    question: "canary consultation",
    chain: [DEV],
    answer: "canary so far",
    expiresAt: soon,
    createdAt: ago(2),
  });

  // ── Routines ──
  // Named as the server names one nobody did: by its instructions' first line.
  const routineOf = {
    orgId: ADA,
    agentId: DEV,
    name: "canary routine prompt",
    prompt: "canary routine prompt",
    description: "canary schedule",
  };
  await db.insert(schema.routines).values([
    {
      ...routineOf,
      id: routine(1),
      target: { type: "channel", channelId: GENERAL },
      triggerType: "schedule",
      phrase: "canary every weekday at nine",
      cron: "0 9 * * 1-5",
      timezone: "America/Sao_Paulo",
      rule: { freq: "weekly", byWeekday: ["MO"], timezone: "America/Sao_Paulo", note: "canary rule" },
      nextRunAt: soon,
      lastRunAt: ago(20),
      createdByUserId: "u-ada",
      createdAt: day(1),
    },
    {
      ...routineOf,
      id: routine(2),
      target: { type: "conversation", channelId: GENERAL, threadId: ROOT, forUserId: "u-ada", note: "canary target" },
      triggerType: "event",
      event: "webhook.received",
      active: false,
      pausedReason: "creator_no_access",
      createdAt: day(2),
    },
    {
      ...routineOf,
      id: routine(3),
      agentId: OPS,
      target: { type: "dm" },
      triggerType: "schedule",
      // Words where a schedule belongs, and a reason that is no code: neither is returned.
      cron: "canary: not a schedule",
      timezone: "not a zone",
      pausedReason: "canary reason in words",
      createdAt: day(3),
      deletedAt: day(4),
    },
    {
      ...routineOf,
      id: routine(9),
      orgId: LIA,
      agentId: LIA_DEV,
      target: { type: "dm" },
      triggerType: "schedule",
    },
  ]);
  const fired = (n: number, over: Partial<typeof schema.routineRuns.$inferInsert> = {}) => ({
    id: firing(n),
    orgId: ADA,
    routineId: routine(1),
    at: day(10 + n),
    trigger: "schedule",
    status: "reported",
    summary: "canary summary",
    event: { body: "canary event" },
    finishedAt: day(10 + n),
    ...over,
  });
  await db
    .insert(schema.routineRuns)
    .values([
      fired(1),
      fired(2),
      fired(3, { status: "skipped", code: "creator_no_access", finishedAt: null }),
      fired(4, { status: "silent" }),
      fired(5, { status: "failed", code: "error", agentRunId: OTHER_RUN }),
      fired(6, { trigger: "manual", agentRunId: RUN, messageId: ROOT, brain: "model" }),
      fired(7, { status: "started", code: "canary code in words", finishedAt: null }),
      fired(8, { routineId: routine(2), trigger: "event", dedupeKey: "fake-delivery" }),
    ]);
});

afterAll(() => t.close());

async function ok<T = Record<string, unknown>>(res: Response) {
  const text = await res.text();
  if (res.status !== 200) throw new Error(`${res.status} ${text}`);
  answers.push(text);
  return JSON.parse(text) as T;
}
const refusal = async (res: Response) => [res.status, ((await res.json()) as { error: { code: string } }).error.code];

type Row = Record<string, unknown> & { id: string };
type Page<K extends string> = { [key in K]: Row[] } & { next: string | null };

/** Every row of a list, read `limit` at a time. */
async function paged<K extends string>(path: string, key: K, limit: number) {
  const rows: Row[] = [];
  let cursor: string | null = null;
  do {
    const more = `${path}${path.includes("?") ? "&" : "?"}limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`;
    const page: Page<K> = await ok<Page<K>>(await get(more));
    expect(page[key].length).toBeLessThanOrEqual(limit);
    rows.push(...page[key]);
    cursor = page.next;
  } while (cursor);
  return rows;
}
const ids = (rows: Row[]) => rows.map((r) => r.id);

test("connections: apps and servers, mailboxes and databases in one list, never a credential, and where one is only as the label of one nobody named", async () => {
  const { connections, next } = await ok<Page<"connections">>(await get(`/orgs/${ADA}/connections`));
  expect(next).toBeNull();
  const none = { lastErrorCode: null, lastError: null, revokedAt: null, lastUsedDay: null, tools: null };
  const unnamed = { ...none, authType: null, status: "active", createdByUserId: null };
  expect(connections).toEqual([
    // One nobody named is called by where it is: the label says it, and no other field does.
    {
      ...unnamed,
      kind: "database",
      id: connection(8),
      connector: "postgres",
      label: "pg.example.org",
      createdAt: day(8).toISOString(),
    },
    {
      ...unnamed,
      kind: "mailbox",
      id: connection(7),
      connector: "imap",
      label: "ana@example.org",
      authType: "imap",
      createdAt: day(7).toISOString(),
    },
    {
      ...none,
      kind: "database",
      id: connection(6),
      connector: "postgres",
      label: "Production",
      authType: null,
      status: "active",
      createdAt: day(6).toISOString(),
      createdByUserId: "u-ada",
    },
    {
      ...none,
      kind: "mailbox",
      id: connection(5),
      connector: "icloud",
      label: "Bob's",
      authType: "imap",
      status: "active",
      createdAt: day(5).toISOString(),
      createdByUserId: null,
    },
    {
      ...none,
      kind: "mailbox",
      id: connection(4),
      connector: "gmail",
      label: "Support",
      authType: "composio",
      status: "needs_reconnect",
      // A stored error of one word is its own code.
      lastErrorCode: "account_removed",
      lastError: "account_removed",
      createdAt: day(4).toISOString(),
      createdByUserId: "u-ada",
      lastUsedDay: "2026-01-04",
    },
    {
      ...none,
      kind: "connector",
      id: connection(3),
      // A server connected by address is told by its host alone.
      connector: "mcp.example.net",
      label: "Billing server",
      authType: "api_key",
      status: "needs_reconnect",
      lastError: "refused by https://***@mcp.example.net/v1",
      createdAt: day(3).toISOString(),
      createdByUserId: "u-bob",
      // The tools it lists now, by the level its workspace gave each: a level nobody knows counts as none given.
      tools: { read: 2, write: 1, approval: 1, off: 1, undecided: 2 },
    },
    {
      ...none,
      kind: "connector",
      id: connection(1),
      connector: "github",
      label: "GitHub",
      authType: "oauth",
      status: "active",
      createdAt: day(2).toISOString(),
      createdByUserId: "u-ada",
      // The last day with a call, the workspace's own: an approval asked without one is no use.
      lastUsedDay: "2026-01-05",
    },
    {
      ...none,
      kind: "connector",
      id: connection(2),
      connector: "github",
      label: "GitHub",
      authType: "oauth",
      status: "active",
      createdAt: day(1).toISOString(),
      createdByUserId: null,
      revokedAt: day(2).toISOString(),
      lastUsedDay: "2026-01-05",
    },
  ]);

  // Three tables, one order: pages of any size hold each row once.
  for (const limit of [1, 2, 4]) {
    expect(ids(await paged(`/orgs/${ADA}/connections`, "connections", limit))).toEqual(ids(connections));
  }
  expect(ids((await ok<Page<"connections">>(await get(`/orgs/${LIA}/connections`))).connections)).toEqual([
    connection(9),
  ]);
  expect(await refusal(await get(`/orgs/${UNKNOWN}/connections`))).toEqual([404, "not_found"]);
  expect(await refusal(await get(`/orgs/${ADA}/connections?cursor=nope`))).toEqual([400, "invalid_cursor"]);
});

test("audit: who did what to what in a range of dates, never an entry's details", async () => {
  type Audit = Page<"events"> & { from: string; to: string };
  const all = await ok<Audit>(await get(`/orgs/${ADA}/audit`));
  // The last 30 days unless said.
  expect(new Date(all.to).getTime() - new Date(all.from).getTime()).toBe(30 * DAY);
  expect(all.next).toBeNull();
  expect(all.events).toEqual([
    {
      id: entry(4),
      at: ago(2).toISOString(),
      actorType: "system",
      actorId: null,
      action: "connector.disconnected",
      targetType: "connector",
      targetId: null,
      outcome: null,
      runId: null,
      onBehalfOfUserId: null,
    },
    {
      id: entry(3),
      at: ago(3).toISOString(),
      actorType: "agent",
      actorId: DEV,
      action: "tool.call",
      targetType: "tool",
      targetId: "ship",
      outcome: "refused",
      runId: RUN,
      onBehalfOfUserId: null,
    },
    {
      id: entry(2),
      at: ago(4).toISOString(),
      actorType: "agent",
      actorId: DEV,
      action: "tool.call",
      targetType: "tool",
      targetId: "lookup",
      outcome: "done",
      runId: RUN,
      onBehalfOfUserId: "u-ada",
    },
    {
      id: entry(1),
      at: ago(5).toISOString(),
      actorType: "person",
      actorId: "u-ada",
      action: "connector.connected",
      targetType: "connector",
      targetId: connection(1),
      outcome: null,
      runId: null,
      onBehalfOfUserId: null,
    },
  ]);

  const found = async (query: string) => ids((await ok<Audit>(await get(`/orgs/${ADA}/audit?${query}`))).events);
  expect(await found("action=connector.")).toEqual([entry(4), entry(1)]);
  expect(await found("action=tool.call")).toEqual([entry(3), entry(2)]);
  // The start of a name, matched literally.
  expect(await found("action=%25")).toEqual([]);
  expect(await found("action=call")).toEqual([]);
  expect(await found("actorType=person")).toEqual([entry(1)]);
  expect(await found(`actorType=agent&actorId=${DEV}`)).toEqual([entry(3), entry(2)]);
  expect(await found("actorId=u-bob")).toEqual([]);
  expect(await found("targetType=tool&targetId=ship")).toEqual([entry(3)]);
  expect(await found(`targetId=${connection(1)}`)).toEqual([entry(1)]);
  expect(await found(`runId=${RUN}`)).toEqual([entry(3), entry(2)]);
  // Older entries are found by their dates: `from` at or after, `to` before.
  const old = new Date(now - 41 * DAY).toISOString();
  expect(await found(`from=${old}`)).toEqual([entry(4), entry(3), entry(2), entry(1), entry(5)]);
  expect(await found(`from=${old}&actorId=u-bob`)).toEqual([entry(5)]);
  expect(await found(`from=${ago(4).toISOString()}&to=${ago(2).toISOString()}`)).toEqual([entry(3), entry(2)]);
  expect(ids(await paged(`/orgs/${ADA}/audit?from=${old}`, "events", 2))).toEqual([4, 3, 2, 1, 5].map((n) => entry(n)));
  expect(ids((await ok<Audit>(await get(`/orgs/${LIA}/audit`))).events)).toEqual([entry(9)]);

  expect(await refusal(await get(`/orgs/${UNKNOWN}/audit`))).toEqual([404, "not_found"]);
  expect(
    await refusal(await get(`/orgs/${ADA}/audit?from=${ago(1).toISOString()}&to=${ago(2).toISOString()}`)),
  ).toEqual([400, "invalid_request"]);
  expect(await refusal(await get(`/orgs/${ADA}/audit?actorType=robot`))).toEqual([400, "invalid_request"]);
  expect(await refusal(await get(`/orgs/${ADA}/audit?runId=nope`))).toEqual([400, "invalid_request"]);
  expect(await refusal(await get(`/orgs/${ADA}/audit?cursor=nope`))).toEqual([400, "invalid_cursor"]);
});

test("audit: a target with no id of its own goes by its name, and the contract says which kinds do", async () => {
  // As the server records a tool call, a merge, a push through the Git proxy and a wiki folder restricted.
  const named: [targetType: string, targetId: string][] = [
    ["tool", "billing_list_invoices"],
    ["repository", "acme/site"],
    ["git_repo", "acme/private-site"],
    ["wiki_folder", "clients/renewals"],
  ];
  await t.db.insert(schema.auditLog).values(
    named.map(([targetType, targetId], n) => ({
      orgId: ADA,
      actorType: "agent" as const,
      actorId: DEV,
      action: "test.named",
      targetType,
      targetId,
      createdAt: new Date(Date.UTC(2026, 0, 21, 0, n)),
    })),
  );
  const { events } = await ok<Page<"events">>(
    await get(`/orgs/${ADA}/audit?action=test.named&from=2026-01-21T00:00:00Z&to=2026-01-22T00:00:00Z`),
  );
  expect(events.map((e) => [e.targetType, e.targetId])).toEqual([...named].reverse());
  // A caller masks by kind: every kind whose target is a name is one the contract names.
  type Doc = { components: { schemas: Record<string, { properties: Record<string, unknown> }> } };
  const doc = (await (await get("/openapi.json")).json()) as Doc;
  const said = JSON.stringify(doc.components.schemas.OperatorAuditPage?.properties.events);
  for (const [targetType] of named) expect(said).toContain(`\`${targetType}\``);
});

test("a page of the audit log continues from the stored time itself, in an order its index serves", async () => {
  // Recorded within one millisecond: a cursor cut to milliseconds would repeat or skip one of them.
  const close = [11, 12, 13].map((n) => entry(n));
  await t.db.execute(sql`insert into audit_log (id, org_id, actor_type, action, target_type, created_at) values
    (${close[0]}, ${ADA}, 'system', 'test.close', 'test', '2026-01-20T00:00:00.000100Z'),
    (${close[1]}, ${ADA}, 'system', 'test.close', 'test', '2026-01-20T00:00:00.000200Z'),
    (${close[2]}, ${ADA}, 'system', 'test.close', 'test', '2026-01-20T00:00:00.000300Z')`);
  const seen: [string, unknown[]][] = [];
  const counts = tracingLogger.logQuery;
  tracingLogger.logQuery = (query = "", params: unknown[] = []) => {
    seen.push([query, params]);
    counts();
  };
  let read: string[];
  try {
    read = ids(await paged(`/orgs/${ADA}/audit?action=test.close&from=2026-01-01T00:00:00Z`, "events", 1));
  } finally {
    tracingLogger.logQuery = counts;
  }
  expect(read).toEqual([...close].reverse());

  // The plan, not a time: the page after a cursor walks the log's index by time and sorts no more than one instant.
  const [statement = "", params = []] = seen.filter(([query]) => query.includes('from "audit_log"')).at(-1) ?? [];
  const page = statement.replace(/\$(\d+)/g, (_, n) => `'${params[Number(n) - 1]}'`);
  const plan = await t.db.transaction(async (tx) => {
    // Nothing here is big enough for the planner to prefer an index on its own.
    await tx.execute(sql`set local enable_seqscan = off`);
    await tx.execute(sql`set local enable_sort = off`);
    await tx.execute(sql`set local enable_bitmapscan = off`);
    return rowsOf<{ "QUERY PLAN": string }>(await tx.execute(sql.raw(`explain (costs off) ${page}`)))
      .map((row) => row["QUERY PLAN"])
      .join("\n");
  });
  expect(plan).toMatch(
    /^Limit\s+->\s+Incremental Sort\s+Sort Key: created_at DESC, id DESC\s+Presorted Key: created_at\s+->\s+Index Scan Backward using audit_log_org_id_created_at_index on audit_log/,
  );
});

test("asks: approvals, questions, secrets, screens and consultations in one list, never what was asked", async () => {
  const { asks, next } = await ok<Page<"asks">>(await get(`/orgs/${ADA}/asks`));
  expect(next).toBeNull();
  const none = {
    runId: null,
    channelId: null,
    threadRootId: null,
    messageId: null,
    tool: null,
    variant: null,
    forUserIds: [],
    forAgentId: null,
    answerRunId: null,
    byUserId: null,
    resolvedAt: null,
    expiresAt: soon.toISOString(),
  };
  expect(asks).toEqual([
    {
      ...none,
      kind: "consultation",
      id: ask(8),
      status: "open",
      agentId: DEV,
      runId: RUN,
      channelId: TALK,
      messageId: uid("55555555", 6),
      variant: "question",
      forAgentId: OPS,
      answerRunId: OTHER_RUN,
      createdAt: ago(2).toISOString(),
    },
    {
      ...none,
      kind: "handoff",
      id: ask(7),
      status: "done",
      agentId: DEV,
      variant: "takeover",
      byUserId: "u-bob",
      createdAt: ago(3).toISOString(),
      resolvedAt: ago(2).toISOString(),
    },
    {
      ...none,
      kind: "handoff",
      id: ask(6),
      status: "pending",
      agentId: DEV,
      runId: RUN,
      variant: "ask",
      forUserIds: ["u-ada"],
      createdAt: ago(4).toISOString(),
    },
    {
      ...none,
      kind: "secret",
      id: ask(5),
      status: "pending",
      agentId: DEV,
      runId: RUN,
      channelId: GENERAL,
      forUserIds: ["u-ada"],
      createdAt: ago(5).toISOString(),
    },
    {
      ...none,
      kind: "question",
      id: ask(4),
      status: "answered",
      agentId: OPS,
      runId: OTHER_RUN,
      channelId: GENERAL,
      forUserIds: ["u-bob"],
      byUserId: "u-bob",
      createdAt: ago(6).toISOString(),
      resolvedAt: ago(5).toISOString(),
    },
    {
      ...none,
      kind: "question",
      id: ask(3),
      status: "open",
      agentId: DEV,
      runId: RUN,
      channelId: GENERAL,
      threadRootId: ROOT,
      // Anyone in its conversation may answer it.
      forUserIds: [],
      createdAt: ago(7).toISOString(),
    },
    {
      ...none,
      kind: "approval",
      id: ask(2),
      status: "refused",
      agentId: DEV,
      runId: RUN,
      channelId: GENERAL,
      threadRootId: ROOT,
      tool: "ship",
      // The people it names, not its agent's owner.
      forUserIds: ["u-bob"],
      byUserId: "u-bob",
      createdAt: ago(8).toISOString(),
      resolvedAt: ago(7).toISOString(),
    },
    {
      ...none,
      kind: "approval",
      id: ask(1),
      status: "pending",
      agentId: DEV,
      runId: RUN,
      channelId: GENERAL,
      threadRootId: ROOT,
      messageId: ROOT,
      tool: "ship",
      forUserIds: ["u-ada"],
      createdAt: ago(9).toISOString(),
    },
  ]);

  const found = async (query: string) => ids((await ok<Page<"asks">>(await get(`/orgs/${ADA}/asks?${query}`))).asks);
  const all = [8, 7, 6, 5, 4, 3, 2, 1].map((n) => ask(n));
  expect(await found("kind=approval")).toEqual([ask(2), ask(1)]);
  expect(await found("kind=handoff")).toEqual([ask(7), ask(6)]);
  expect(await found("open=true")).toEqual([8, 6, 5, 3, 1].map((n) => ask(n)));
  expect(await found("open=false")).toEqual([7, 4, 2].map((n) => ask(n)));
  expect(await found("kind=question&open=true")).toEqual([ask(3)]);
  expect(await found(`agentId=${OPS}`)).toEqual([ask(4)]);
  // The run that asked: a person's unasked turn on a screen is no run's.
  expect(await found(`runId=${RUN}`)).toEqual([8, 6, 5, 3, 2, 1].map((n) => ask(n)));
  expect(await found(`from=${ago(6).toISOString()}&to=${ago(3).toISOString()}`)).toEqual([6, 5, 4].map((n) => ask(n)));
  for (const limit of [1, 3, 5]) expect(ids(await paged(`/orgs/${ADA}/asks`, "asks", limit))).toEqual(all);
  expect(ids(await paged(`/orgs/${ADA}/asks?open=true`, "asks", 2))).toEqual([8, 6, 5, 3, 1].map((n) => ask(n)));
  expect(await found(`runId=${LIA_RUN}`)).toEqual([]);
  expect(ids((await ok<Page<"asks">>(await get(`/orgs/${LIA}/asks`))).asks)).toEqual([ask(9)]);

  expect(await refusal(await get(`/orgs/${UNKNOWN}/asks`))).toEqual([404, "not_found"]);
  expect(await refusal(await get(`/orgs/${ADA}/asks?kind=wish`))).toEqual([400, "invalid_request"]);
  expect(await refusal(await get(`/orgs/${ADA}/asks?open=maybe`))).toEqual([400, "invalid_request"]);
  expect(await refusal(await get(`/orgs/${ADA}/asks?cursor=nope`))).toEqual([400, "invalid_cursor"]);
});

test("routines: when each runs, where it delivers and how its latest firings ended, never its name or instructions", async () => {
  type Routine = Row & { runs: Row[] };
  const { routines, next } = await ok<{ routines: Routine[]; next: string | null }>(await get(`/orgs/${ADA}/routines`));
  expect(next).toBeNull();
  const fired = (n: number, over: Record<string, unknown> = {}) => ({
    id: firing(n),
    at: day(10 + n).toISOString(),
    trigger: "schedule",
    status: "reported",
    code: null,
    runId: null,
    messageId: null,
    finishedAt: day(10 + n).toISOString(),
    ...over,
  });
  expect(routines).toEqual([
    {
      id: routine(3),
      agentId: OPS,
      triggerType: "schedule",
      cron: null,
      timezone: null,
      event: null,
      active: true,
      pausedReason: null,
      target: { type: "dm", channelId: null, threadRootId: null },
      nextRunAt: null,
      lastRunAt: null,
      createdByUserId: null,
      createdAt: day(3).toISOString(),
      deletedAt: day(4).toISOString(),
      runs: [],
    },
    {
      id: routine(2),
      agentId: DEV,
      triggerType: "event",
      cron: null,
      timezone: null,
      event: "webhook.received",
      active: false,
      pausedReason: "creator_no_access",
      // Where it delivers, not whom it reminds.
      target: { type: "conversation", channelId: GENERAL, threadRootId: ROOT },
      nextRunAt: null,
      lastRunAt: null,
      createdByUserId: null,
      createdAt: day(2).toISOString(),
      deletedAt: null,
      runs: [fired(8, { trigger: "event" })],
    },
    {
      id: routine(1),
      agentId: DEV,
      triggerType: "schedule",
      cron: "0 9 * * 1-5",
      timezone: "America/Sao_Paulo",
      event: null,
      active: true,
      pausedReason: null,
      target: { type: "channel", channelId: GENERAL, threadRootId: null },
      nextRunAt: soon.toISOString(),
      lastRunAt: ago(20).toISOString(),
      createdByUserId: "u-ada",
      createdAt: day(1).toISOString(),
      deletedAt: null,
      // The latest five of seven, newest first.
      runs: [
        fired(7, { status: "started", finishedAt: null }),
        fired(6, { trigger: "manual", runId: RUN, messageId: ROOT }),
        fired(5, { status: "failed", code: "error", runId: OTHER_RUN }),
        fired(4, { status: "silent" }),
        fired(3, { status: "skipped", code: "creator_no_access", finishedAt: null }),
      ],
    },
  ]);

  const found = async (query: string) =>
    ids((await ok<Page<"routines">>(await get(`/orgs/${ADA}/routines?${query}`))).routines);
  expect(await found(`agentId=${OPS}`)).toEqual([routine(3)]);
  expect(await found(`agentId=${LIA_DEV}`)).toEqual([]);
  for (const limit of [1, 2]) {
    expect(ids(await paged(`/orgs/${ADA}/routines`, "routines", limit))).toEqual([3, 2, 1].map((n) => routine(n)));
  }
  expect(ids((await ok<Page<"routines">>(await get(`/orgs/${LIA}/routines`))).routines)).toEqual([routine(9)]);

  expect(await refusal(await get(`/orgs/${UNKNOWN}/routines`))).toEqual([404, "not_found"]);
  expect(await refusal(await get(`/orgs/${ADA}/routines?agentId=nope`))).toEqual([400, "invalid_request"]);
  expect(await refusal(await get(`/orgs/${ADA}/routines?limit=201`))).toEqual([400, "invalid_request"]);
});

test("these reads need a token, the read-only one is enough, and none says what is hidden", async () => {
  const paths = ["connections", "audit", "asks", "routines"].map((name) => `/orgs/${ADA}/${name}`);
  for (const path of paths) {
    expect(await refusal(await get(path, null))).toEqual([401, "unauthorized"]);
    await ok(await get(path, TOKEN));
  }
  function* keysOf(value: unknown): Generator<string> {
    if (!value || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value)) {
      if (!Array.isArray(value)) yield key;
      yield* keysOf(inner);
    }
  }
  expect(answers.length).toBeGreaterThan(50);
  for (const text of answers) {
    for (const hidden of HIDDEN) expect({ text, has: text.includes(hidden) }).toEqual({ text, has: false });
    const named = [...keysOf(JSON.parse(text))].filter((key) => /token|password|secret|hash|cipher|key/i.test(key));
    expect(named).toEqual([]);
  }
});
