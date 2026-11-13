import { afterAll, beforeAll, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { createLogger } from "../src/logger";
import { createOperatorApp } from "../src/operator/app";
import { createTestServer, type TestServer } from "./harness";

/**
 * ADR 0056, one person's side of a workspace and what went unanswered: their notifications, whether they reach an
 * agent, a channel, a task, a file or a computer, people's messages no run answered, and the emails queued to an
 * address. Everything a person or a model wrote here says "canary" and every secret starts with "fake-": no answer
 * may carry either, nor an address an email went to.
 */

const TOKEN = "operator-test-token-".padEnd(48, "x");
const READ = "operator-read-token-".padEnd(48, "x");

const uid = (start: string, n: number) => `${start}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADA = uid("11111111", 1);
const LIA = uid("11111111", 2);
const SHUT = uid("11111111", 3);
const role = (n: number) => uid("22222222", n);
const [EVERYONE, SUPPORT, ADMINS] = [role(1), role(2), role(3)];
const agent = (n: number) => uid("33333333", n);
const [DEV, OPS, SOLO, OLD, LIA_DEV, SHUT_DEV] = [1, 2, 3, 4, 5, 6].map(agent) as [
  string,
  string,
  string,
  string,
  string,
  string,
];
const channel = (n: number) => uid("44444444", n);
const [GENERAL, SECRET, DM, ARCHIVED, TASK_TALK, LIA_GENERAL, SHUT_GENERAL] = [1, 2, 3, 4, 5, 6, 7].map(channel) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];
const task = (n: number) => uid("55555555", n);
const file = (n: number) => uid("66666666", n);
const box = (n: number) => uid("77777777", n);
const note = (n: number) => uid("88888888", n);
const message = (n: number) => uid("99999999", n);
const run = (n: number) => uid("aaaaaaaa", n);
const job = (n: number) => uid("bbbbbbbb", n);
const QUESTION = uid("cccccccc", 1);
const UNKNOWN = uid("0b0b0b0b", 1);

const now = Date.now();
const HOUR = 3600_000;
const ago = (hours: number) => new Date(now - hours * HOUR);
const soon = new Date(now + HOUR);
// Messages are kept by month: these are all written in the last half minute.
const at = (n: number) => new Date(now - n * 1000);

/** Stored beside what the reads return, and never theirs to say. */
const HIDDEN = ["canary", "fake-", "ana@example.com", "other@example.com"];

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
    { id: SHUT, name: "Shut Co", standing: "suspended", standingReason: "abuse" },
  ]);
  await db.insert(schema.users).values([
    { id: "u-ada", name: "Ada", email: "ada@example.com" },
    { id: "u-bob", name: "Bob", email: "bob@example.com" },
    { id: "u-cy", name: "Cy", email: "cy@example.com" },
    { id: "u-dee", name: "Dee", email: "dee@example.com" },
    { id: "u-eve", name: "Eve", email: "eve@example.com", blockedAt: ago(1), blockedReason: "spam" },
    { id: "u-fay", name: "Fay", email: "fay@example.com" },
  ]);
  await db.insert(schema.organizationMembers).values([
    { orgId: ADA, userId: "u-ada", role: "owner" },
    { orgId: ADA, userId: "u-bob", role: "member" },
    { orgId: ADA, userId: "u-cy", role: "member" },
    { orgId: ADA, userId: "u-eve", role: "member" },
    { orgId: ADA, userId: "u-fay", role: "member" },
    { orgId: LIA, userId: "u-dee", role: "member" },
    { orgId: LIA, userId: "u-ada", role: "member" },
    { orgId: SHUT, userId: "u-ada", role: "owner" },
  ]);
  await db.insert(schema.orgRoles).values([
    { id: EVERYONE, orgId: ADA, kind: "everyone", name: "Everyone", permissions: ["post", "talk_to_agents"] },
    { id: SUPPORT, orgId: ADA, name: "Support" },
    { id: ADMINS, orgId: ADA, name: "Admins", permissions: ["administrator"] },
    // Nobody here talks to agents but an owner.
    { id: role(4), orgId: LIA, kind: "everyone", name: "Everyone", permissions: ["post"] },
  ]);
  await db.insert(schema.organizationMemberRoles).values([
    { orgId: ADA, userId: "u-bob", roleId: SUPPORT },
    { orgId: ADA, userId: "u-fay", roleId: ADMINS },
  ]);
  const made = { model: "claude-sonnet-5-5", instructions: "canary instructions" };
  await db.insert(schema.agents).values([
    {
      ...made,
      id: DEV,
      orgId: ADA,
      name: "Dev",
      handle: "dev",
      ownerUserId: "u-ada",
      audienceMode: "people",
      audienceUserIds: ["u-cy"],
      audienceRoleIds: [SUPPORT],
    },
    { ...made, id: OPS, orgId: ADA, name: "Ops", handle: "ops" },
    { ...made, id: SOLO, orgId: ADA, name: "Solo", handle: "solo", ownerUserId: "u-ada", audienceMode: "owner" },
    { ...made, id: OLD, orgId: ADA, name: "Old", handle: "old", ownerUserId: "u-ada", archivedAt: ago(1) },
    { ...made, id: LIA_DEV, orgId: LIA, name: "Dev", handle: "dev" },
    { ...made, id: SHUT_DEV, orgId: SHUT, name: "Dev", handle: "dev" },
  ]);
  await db.insert(schema.channels).values([
    { id: GENERAL, orgId: ADA, name: "general" },
    { id: SECRET, orgId: ADA, name: "secret", visibility: "private" },
    { id: DM, orgId: ADA, name: "dm-ada-dev", kind: "dm", visibility: "private" },
    { id: ARCHIVED, orgId: ADA, name: "old-news", archivedAt: ago(1) },
    { id: TASK_TALK, orgId: ADA, name: "task-2", kind: "task", visibility: "private" },
    { id: LIA_GENERAL, orgId: LIA, name: "general" },
    { id: SHUT_GENERAL, orgId: SHUT, name: "general" },
  ]);
  await db.insert(schema.channelMembers).values([
    { orgId: ADA, channelId: GENERAL, userId: "u-ada" },
    { orgId: ADA, channelId: GENERAL, userId: "u-bob" },
    { orgId: ADA, channelId: GENERAL, agentId: OPS },
    { orgId: ADA, channelId: SECRET, userId: "u-ada" },
    { orgId: ADA, channelId: DM, userId: "u-ada" },
    { orgId: ADA, channelId: DM, agentId: DEV },
    { orgId: ADA, channelId: ARCHIVED, userId: "u-ada" },
  ]);

  // ── What access is asked about ──
  const written = { createdByType: "person", createdById: "u-ada", title: "canary title" };
  await db.insert(schema.issues).values([
    { ...written, id: task(1), orgId: ADA, number: 1, restricted: true, audienceUserIds: ["u-cy"] },
    { ...written, id: task(2), orgId: ADA, number: 2, channelId: SECRET, conversationChannelId: TASK_TALK },
    { ...written, id: task(3), orgId: ADA, number: 3 },
    { ...written, id: task(4), orgId: ADA, number: 4, channelId: GENERAL },
    { ...written, id: task(9), orgId: LIA, number: 1 },
  ]);
  const drawn = { ...written, orgId: ADA, kind: "document" as const, updatedByType: "person", updatedById: "u-ada" };
  await db.insert(schema.artifacts).values([
    { ...drawn, id: file(1) },
    { ...drawn, id: file(2), channelId: SECRET },
    { ...drawn, id: file(3), channelId: SECRET, share: "people", shareUserIds: ["u-cy"], shareRoleIds: [SUPPORT] },
    { ...drawn, id: file(4), channelId: SECRET, share: "everyone" },
    { ...drawn, id: file(5), channelId: GENERAL },
    { ...drawn, id: file(6), channelId: DM },
    { ...drawn, id: file(7), deletedAt: ago(1) },
    { ...drawn, id: file(8), channelId: TASK_TALK },
  ]);
  const listed = { audienceMode: "people" as const, audienceUserIds: ["u-cy"], audienceRoleIds: [SUPPORT] };
  const computer = (n: number, name: string) => ({ id: box(n), orgId: ADA, name, tokenHash: `fake-machine-hash-${n}` });
  await db.insert(schema.machines).values([
    { ...computer(1, "Box"), ...listed, pairedByUserId: "u-ada" },
    { ...computer(2, "Box two"), ...listed, pairedByUserId: "u-ada" },
    { ...computer(3, "Shared"), belongsToWorkspace: true },
    { ...computer(4, "Mine"), pairedByUserId: "u-ada" },
    { ...computer(5, "Open"), pairedByUserId: "u-ada", audienceMode: "everyone" },
    { ...computer(6, "Gone"), pairedByUserId: "u-ada", deletedAt: ago(1) },
  ]);
  const asked = { orgId: ADA, requesterUserId: "u-fay", reason: "canary reason", status: "once" };
  await db.insert(schema.deviceAccessRequests).values([
    { ...asked, machineId: box(1), expiresAt: soon },
    // Its hour is over.
    { ...asked, machineId: box(2), expiresAt: ago(1) },
  ]);

  // ── Notifications ──
  const told = { orgId: ADA, userId: "u-ada", latest: { text: "canary snippet", title: "canary title" } };
  await db.insert(schema.notifications).values([
    {
      ...told,
      id: note(1),
      kind: "mention",
      groupKey: `mention:${message(6)}`,
      actors: [{ type: "user", id: "u-bob" }],
      source: { channelId: GENERAL, messageId: message(6), label: "canary channel" },
      createdAt: ago(1),
      updatedAt: ago(1),
    },
    {
      ...told,
      id: note(2),
      kind: "approval",
      waiting: true,
      groupKey: `approval:${uid("dddddddd", 1)}`,
      actors: [{ type: "agent", id: DEV }],
      source: { approvalId: uid("dddddddd", 1), agentId: DEV, runId: run(1), channelId: GENERAL },
      readAt: ago(2),
      doneAt: ago(2),
      doneByUser: true,
      createdAt: ago(3),
      updatedAt: ago(2),
    },
    {
      ...told,
      id: note(3),
      // Words where the server's own names belong: none is returned.
      kind: "canary kind in words",
      groupKey: "canary group in words",
      actors: [
        { type: "robot" as "agent", id: "u-bob" },
        { type: "agent", id: OPS },
        { type: "user", id: "canary words, not an id" },
      ],
      source: { userId: "u-bob", issueNumber: 7, screen: "canary-screen", noteId: "canary words, not an id" },
      createdAt: ago(4),
      updatedAt: ago(4),
    },
    {
      ...told,
      id: note(4),
      kind: "thread_reply",
      groupKey: `thread:${message(1)}`,
      count: 3,
      actors: [
        { type: "user", id: "u-cy" },
        { type: "user", id: "u-bob" },
      ],
      source: { channelId: GENERAL, threadId: message(1), messageId: message(2) },
      snoozedUntil: soon,
      createdAt: ago(6),
      updatedAt: ago(5),
    },
    { ...told, id: note(8), userId: "u-bob", kind: "mention", groupKey: "mention:bob" },
    { ...told, id: note(9), orgId: LIA, kind: "mention", groupKey: "mention:lia" },
  ]);
  await db.insert(schema.pushDevices).values([
    {
      userId: "u-ada",
      token: "fake-push-token",
      platform: "ios",
      locale: "en",
      createdAt: ago(48),
      lastSeenAt: ago(2),
    },
    {
      userId: "u-ada",
      token: "https://push.example.com/fake-endpoint",
      platform: "web",
      webKeys: { p256dh: "fake-p256dh", auth: "fake-auth" },
      locale: "pt-BR",
      createdAt: ago(24),
      lastSeenAt: ago(1),
    },
    { userId: "u-bob", token: "fake-push-token-bob", platform: "android", locale: "en" },
  ]);
  const push = { orgId: ADA, kind: "push.send", maxAttempts: 4 };
  await db.insert(schema.outbox).values([
    {
      ...push,
      id: job(1),
      payload: { notificationId: note(1) },
      dedupeKey: `push.send:${note(1)}`,
      status: "done",
      attempts: 1,
      createdAt: ago(1),
      completedAt: ago(1),
    },
    {
      ...push,
      id: job(2),
      payload: { notificationId: note(1), held: true },
      dedupeKey: `push.send:${note(1)}:held`,
      status: "failed",
      attempts: 4,
      lastError: "push not delivered: 503",
      createdAt: new Date(ago(1).getTime() + 1000),
    },
    // A snooze's wake, named by its time: not among a notification's own.
    { ...push, id: job(3), payload: { notificationId: note(4) }, dedupeKey: `push.send:${note(4)}:woke:1` },
    { ...push, id: job(4), payload: { notificationId: note(8) }, dedupeKey: `push.send:${note(8)}` },
  ]);

  // ── People's messages, answered or not ──
  const started = { orgId: ADA, agentId: OPS, channelId: GENERAL, trigger: "mention" as const, hop: 1 };
  await db.insert(schema.agentRuns).values([
    { ...started, id: run(1), threadRootId: message(1), triggerMessageId: message(1), createdAt: at(1) },
    // At work before the messages it took were written.
    {
      ...started,
      id: run(2),
      threadRootId: message(90),
      triggerMessageId: message(90),
      status: "running",
      pendingMessageIds: [message(4)],
      createdAt: at(60),
    },
  ]);
  await db.insert(schema.agentRunSteps).values({
    orgId: ADA,
    runId: run(2),
    seq: 1,
    kind: "context",
    data: { steeredMessageIds: [message(5)] },
  });
  await db.insert(schema.agentQuestions).values({
    id: QUESTION,
    orgId: ADA,
    runId: run(2),
    agentId: OPS,
    channelId: GENERAL,
    toolUseId: "call-1",
    text: "canary question?",
    expiresAt: soon,
  });
  const said = (n: number, over: Partial<typeof schema.messages.$inferInsert> = {}) => ({
    id: message(n),
    orgId: ADA,
    channelId: GENERAL,
    authorType: "person" as const,
    authorUserId: "u-bob",
    body: `canary words ${n}`,
    createdAt: at(n),
    ...over,
  });
  await db
    .insert(schema.messages)
    .values([
      said(1),
      said(2, { meta: { steeredRunIds: [run(2)] } }),
      said(3, { meta: { answersQuestionId: QUESTION } }),
      said(4),
      said(5),
      said(6),
      said(7),
      said(8),
      said(9),
      said(10),
      said(11, { mentionedAgentIds: [SOLO] }),
      said(12, { mentionedAgentIds: [OPS], meta: { referencedAgentIds: [OPS] } }),
      said(13),
      said(14),
      said(15),
      said(16, { meta: { missionSuggestion: { status: "pending", text: "canary suggestion" } } }),
      said(17, { authorType: "agent", authorUserId: null, authorAgentId: OPS }),
      said(18, { deletedAt: at(1) }),
      said(20, { channelId: SECRET, authorUserId: "u-ada" }),
      said(29, { orgId: LIA, channelId: LIA_GENERAL, authorUserId: "u-dee" }),
    ]);
  const decided = (n: number, over: Partial<typeof schema.routingDecisions.$inferInsert> = {}) => ({
    orgId: ADA,
    channelId: GENERAL,
    messageId: message(n),
    strategy: "llm:test",
    candidates: [{ agentId: OPS, score: 0.2 }],
    reason: "canary words of a model",
    ...over,
  });
  await db
    .insert(schema.routingDecisions)
    .values([
      decided(6),
      decided(7, { selectedAgentIds: [OPS] }),
      decided(8, { strategy: "plan_hold", candidates: [] }),
      decided(9, { strategy: "no_ai", candidates: [], error: "no_ai" }),
      decided(10, { error: "platform_cap" }),
    ]);
  const posted = (n: number, status: "pending" | "failed") => ({
    orgId: ADA,
    kind: "message.posted",
    payload: { messageId: message(n) },
    dedupeKey: `message.posted:${message(n)}`,
    status,
  });
  await db.insert(schema.outbox).values([posted(13, "pending"), posted(14, "failed")]);

  // ── Emails ──
  const invitation = { kind: "invitation", orgName: "canary org", inviterName: "canary inviter" };
  const email = (n: number, to: unknown, over: Partial<typeof schema.outbox.$inferInsert> = {}) => ({
    id: job(10 + n),
    kind: "email.send",
    payload: { key: `fake-key-${n}`, to, template: { ...invitation, url: "https://example.com/invite/fake-link" } },
    dedupeKey: `email:fake-key-${n}`,
    maxAttempts: 6,
    createdAt: ago(n),
    ...over,
  });
  await db.insert(schema.outbox).values([
    email(1, ["Ana@Example.com"], { orgId: ADA, status: "done", attempts: 1, completedAt: ago(1) }),
    email(2, ["other@example.com", "ana@example.com"], {
      payload: { to: ["other@example.com", "ana@example.com"], template: { kind: "password_reset", url: "fake-link" } },
      status: "failed",
      attempts: 6,
      lastError: "MillionSend refused the email (422 validation_error): the address is on a list",
    }),
    email(3, ["ana@example.com"], { attempts: 2, lastError: "MillionSend refused the email (429):" }),
    email(4, ["ana@example.com"], { attempts: 1, lastError: "could not reach MillionSend: timeout" }),
    email(5, ["other@example.com"]),
    // Not what the server writes, or no longer there: none is found.
    email(6, "ana@example.com"),
    email(7, [], { payload: {}, status: "done" }),
    email(8, ["ana@example.com"], { kind: "plan.waiting" }),
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

test("notifications: what each tells of and points at, its pushes and the person's devices, never its words", async () => {
  type Notified = Page<"notifications"> & { devices: unknown[] };
  const mine = `/orgs/${ADA}/notifications?userId=u-ada`;
  const { notifications, devices, next } = await ok<Notified>(await get(mine));
  expect(next).toBeNull();
  const fresh = {
    waiting: false,
    count: 1,
    readAt: null,
    doneAt: null,
    doneByUser: false,
    snoozedUntil: null,
    push: [],
  };
  const sent = {
    orgId: ADA,
    kind: "push.send",
    maxAttempts: 4,
    lockedUntil: null,
    lockedBy: null,
    lastError: null,
    runId: null,
    cause: null,
    completedAt: null,
  };
  expect(notifications).toEqual([
    {
      ...fresh,
      id: note(1),
      kind: "mention",
      group: `mention:${message(6)}`,
      actors: [{ type: "user", id: "u-bob" }],
      source: { channelId: GENERAL, messageId: message(6) },
      createdAt: ago(1).toISOString(),
      updatedAt: ago(1).toISOString(),
      // Its first push, then the one held back while the person was looking.
      push: [
        {
          ...sent,
          id: job(1),
          status: "done",
          attempts: 1,
          nextAttemptAt: expect.any(String),
          createdAt: ago(1).toISOString(),
          completedAt: ago(1).toISOString(),
        },
        {
          ...sent,
          id: job(2),
          status: "failed",
          attempts: 4,
          lastError: "push not delivered: 503",
          nextAttemptAt: expect.any(String),
          createdAt: new Date(ago(1).getTime() + 1000).toISOString(),
        },
      ],
    },
    {
      ...fresh,
      id: note(2),
      kind: "approval",
      waiting: true,
      group: `approval:${uid("dddddddd", 1)}`,
      actors: [{ type: "agent", id: DEV }],
      source: { approvalId: uid("dddddddd", 1), agentId: DEV, runId: run(1), channelId: GENERAL },
      readAt: ago(2).toISOString(),
      doneAt: ago(2).toISOString(),
      doneByUser: true,
      createdAt: ago(3).toISOString(),
      updatedAt: ago(2).toISOString(),
    },
    {
      ...fresh,
      id: note(3),
      kind: null,
      group: null,
      actors: [{ type: "agent", id: OPS }],
      // An id by its name, when it is one word.
      source: { userId: "u-bob" },
      createdAt: ago(4).toISOString(),
      updatedAt: ago(4).toISOString(),
    },
    {
      ...fresh,
      id: note(4),
      kind: "thread_reply",
      group: `thread:${message(1)}`,
      count: 3,
      actors: [
        { type: "user", id: "u-cy" },
        { type: "user", id: "u-bob" },
      ],
      source: { channelId: GENERAL, threadId: message(1), messageId: message(2) },
      snoozedUntil: soon.toISOString(),
      createdAt: ago(6).toISOString(),
      updatedAt: ago(5).toISOString(),
    },
  ]);
  // Where pushes go now, latest seen first: a platform and two times.
  expect(devices).toEqual([
    { platform: "web", createdAt: ago(24).toISOString(), lastSeenAt: ago(1).toISOString() },
    { platform: "ios", createdAt: ago(48).toISOString(), lastSeenAt: ago(2).toISOString() },
  ]);

  const found = async (query: string) => ids((await ok<Notified>(await get(`${mine}&${query}`))).notifications);
  expect(await found("kind=mention")).toEqual([note(1)]);
  expect(await found("kind=nope")).toEqual([]);
  expect(await found(`from=${ago(4).toISOString()}&to=${ago(2).toISOString()}`)).toEqual([note(2), note(3)]);
  for (const limit of [1, 3]) {
    expect(ids(await paged(mine, "notifications", limit))).toEqual([1, 2, 3, 4].map((n) => note(n)));
  }
  // Someone else's, and the same person's in another workspace.
  const bob = await ok<Notified>(await get(`/orgs/${ADA}/notifications?userId=u-bob`));
  expect(bob).toMatchObject({
    notifications: [{ id: note(8), push: [{ id: job(4) }] }],
    devices: [{ platform: "android" }],
  });
  expect(ids((await ok<Notified>(await get(`/orgs/${LIA}/notifications?userId=u-ada`))).notifications)).toEqual([
    note(9),
  ]);
  expect((await ok<Notified>(await get(`/orgs/${ADA}/notifications?userId=u-dee`))).notifications).toEqual([]);

  expect(await refusal(await get(`/orgs/${UNKNOWN}/notifications?userId=u-ada`))).toEqual([404, "not_found"]);
  expect(await refusal(await get(`/orgs/${ADA}/notifications?userId=nobody`))).toEqual([404, "not_found"]);
  expect(await refusal(await get(`/orgs/${ADA}/notifications`))).toEqual([400, "invalid_request"]);
  expect(await refusal(await get(`${mine}&from=yesterday`))).toEqual([400, "invalid_request"]);
  expect(await refusal(await get(`${mine}&cursor=nope`))).toEqual([400, "invalid_cursor"]);
});

test("access: whether a person reaches an agent, a channel, a task, a file or a computer, and the rule that decides", async () => {
  type Access = { userId: string; targetKind: string; targetId: string; allowed: boolean; rule: string };
  const asked = (orgId: string, userId: string, kind: string, id: string) =>
    get(`/orgs/${orgId}/access?userId=${userId}&targetKind=${kind}&targetId=${id}`);
  const cases: [kind: string, user: string, id: string, allowed: boolean, rule: string][] = [
    ["agent", "u-ada", DEV, true, "owner"],
    ["agent", "u-cy", DEV, true, "audience_person"],
    ["agent", "u-bob", DEV, true, "audience_role"],
    // Whoever administers the workspace talks to no agent for it.
    ["agent", "u-fay", DEV, false, "not_in_audience"],
    ["agent", "u-cy", OPS, true, "audience_everyone"],
    ["agent", "u-cy", SOLO, false, "owner_only"],
    ["agent", "u-ada", OLD, false, "gone"],
    // Whatever the thing's own rule says.
    ["agent", "u-dee", OPS, false, "not_a_member"],
    ["agent", "u-eve", OPS, false, "account_closed"],

    ["channel", "u-bob", GENERAL, true, "channel_member"],
    ["channel", "u-cy", GENERAL, false, "not_joined"],
    ["channel", "u-cy", SECRET, false, "not_channel_member"],
    ["channel", "u-fay", SECRET, true, "administrator"],
    ["channel", "u-ada", DM, true, "channel_member"],
    // Nobody reads someone else's direct conversation.
    ["channel", "u-fay", DM, false, "not_channel_member"],
    ["channel", "u-ada", ARCHIVED, false, "gone"],
    ["channel", "u-ada", TASK_TALK, true, "task_reader"],
    ["channel", "u-cy", TASK_TALK, false, "not_task_reader"],

    ["task", "u-cy", task(1), true, "audience_person"],
    ["task", "u-bob", task(1), false, "not_in_audience"],
    ["task", "u-fay", task(1), true, "administrator"],
    ["task", "u-cy", task(2), false, "not_channel_member"],
    ["task", "u-fay", task(2), true, "administrator"],
    ["task", "u-cy", task(3), true, "workspace"],
    ["task", "u-bob", task(4), true, "channel_member"],
    ["task", "u-cy", task(4), true, "public_channel"],

    ["file", "u-cy", file(1), true, "workspace"],
    ["file", "u-ada", file(2), true, "channel_member"],
    ["file", "u-cy", file(2), false, "not_shared"],
    ["file", "u-fay", file(2), true, "administrator"],
    ["file", "u-cy", file(3), true, "shared_person"],
    ["file", "u-bob", file(3), true, "shared_role"],
    ["file", "u-cy", file(4), true, "shared_everyone"],
    ["file", "u-cy", file(5), true, "public_channel"],
    ["file", "u-fay", file(6), false, "not_shared"],
    ["file", "u-ada", file(7), false, "gone"],
    ["file", "u-ada", file(8), true, "task_reader"],
    ["file", "u-cy", file(8), false, "not_shared"],

    ["computer", "u-ada", box(1), true, "owner"],
    ["computer", "u-cy", box(1), true, "audience_person"],
    ["computer", "u-bob", box(1), true, "audience_role"],
    // Let in for now by a person's answer to an agent's request; on the other computer that hour is over.
    ["computer", "u-fay", box(1), true, "granted_once"],
    ["computer", "u-fay", box(2), false, "not_in_audience"],
    ["computer", "u-cy", box(3), true, "workspace"],
    ["computer", "u-cy", box(4), false, "owner_only"],
    ["computer", "u-cy", box(5), true, "audience_everyone"],
    ["computer", "u-ada", box(6), false, "gone"],
  ];
  for (const [targetKind, userId, targetId, allowed, rule] of cases) {
    expect(await ok<Access>(await asked(ADA, userId, targetKind, targetId))).toEqual({
      userId,
      targetKind,
      targetId,
      allowed,
      rule,
    });
  }
  // A workspace whose roles let nobody talk to agents, and one that is suspended.
  expect(await ok<Access>(await asked(LIA, "u-dee", "agent", LIA_DEV))).toMatchObject({
    allowed: false,
    rule: "no_permission",
  });
  expect(await ok<Access>(await asked(SHUT, "u-ada", "agent", SHUT_DEV))).toMatchObject({
    allowed: false,
    rule: "workspace_suspended",
  });

  // Nobody by that id, nothing by that id, a thing of another kind, of another workspace, and no such workspace.
  for (const [orgId, userId, kind, id] of [
    [ADA, "nobody", "agent", DEV],
    [ADA, "u-ada", "agent", UNKNOWN],
    [ADA, "u-ada", "channel", DEV],
    [ADA, "u-ada", "agent", LIA_DEV],
    [ADA, "u-ada", "task", task(9)],
    [UNKNOWN, "u-ada", "agent", DEV],
  ] as const) {
    expect(await refusal(await asked(orgId, userId, kind, id))).toEqual([404, "not_found"]);
  }
  expect(await refusal(await asked(ADA, "u-ada", "wiki", DEV))).toEqual([400, "invalid_request"]);
  expect(await refusal(await asked(ADA, "u-ada", "agent", "nope"))).toEqual([400, "invalid_request"]);
  expect(await refusal(await get(`/orgs/${ADA}/access?targetKind=agent&targetId=${DEV}`))).toEqual([
    400,
    "invalid_request",
  ]);
});

test("unanswered: people's messages no run answered, each with why as its explanation tells it, never what it says", async () => {
  type Unanswered = { from: string; to: string; messages: Row[]; next: string | null };
  const path = `/orgs/${ADA}/unanswered`;
  const { messages, next, from, to } = await ok<Unanswered>(await get(path));
  expect(next).toBeNull();
  expect(new Date(to).getTime() - new Date(from).getTime()).toBe(24 * HOUR);
  const row = (n: number, outcome: string, strategy: string | null = null, over: Record<string, unknown> = {}) => ({
    id: message(n),
    at: at(n).toISOString(),
    channelId: GENERAL,
    threadRootId: null,
    authorUserId: "u-bob",
    outcome,
    strategy,
    ...over,
  });
  const expected = [
    row(6, "nobody_picked", "llm:test"),
    row(7, "picked_not_started", "llm:test"),
    row(8, "kept_on_hold", "plan_hold"),
    row(9, "no_ai", "no_ai"),
    row(10, "platform_cap", "llm:test"),
    row(11, "blocked"),
    row(12, "referenced_only"),
    row(13, "job_pending"),
    row(14, "job_failed"),
    row(15, "not_routed"),
    row(16, "mission_suggestion"),
    row(20, "not_routed", null, { channelId: SECRET, authorUserId: "u-ada" }),
  ];
  expect(messages).toEqual(expected);

  // The same verdict an explanation gives, one message at a time: the answered ones name a run, the others never do.
  const answered = ["run", "joined", "answered_question"];
  const listed = new Map(messages.map((m) => [m.id, m.outcome]));
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 20]) {
    const { verdict } = await ok<{ verdict: string }>(await get(`/messages/${message(n)}/explain`));
    expect({ n, verdict, listed: listed.get(message(n)) }).toEqual({
      n,
      verdict,
      listed: answered.includes(verdict) ? undefined : verdict,
    });
  }
  expect(listed.size).toBe(12);

  // Most messages first; every other reason once.
  type Counts = { counts: { outcome: string; messages: number }[] };
  const { counts } = await ok<Counts>(await get(`${path}?summary=true`));
  expect(counts[0]).toEqual({ outcome: "not_routed", messages: 2 });
  expect(counts.slice(1).every((c) => c.messages === 1)).toBe(true);
  expect(counts.map((c) => c.outcome).sort()).toEqual([...new Set(expected.map((m) => m.outcome))].sort());

  const found = async (query: string) => ids((await ok<Unanswered>(await get(`${path}?${query}`))).messages);
  expect(await found("outcome=not_routed")).toEqual([message(15), message(20)]);
  expect(await found(`channelId=${SECRET}`)).toEqual([message(20)]);
  expect(await found(`channelId=${LIA_GENERAL}`)).toEqual([]);
  // `from` at or after, `to` before.
  expect(await found(`from=${at(10).toISOString()}&to=${at(7).toISOString()}`)).toEqual([8, 9, 10].map(message));
  expect((await ok<Counts>(await get(`${path}?summary=true&channelId=${SECRET}`))).counts).toEqual([
    { outcome: "not_routed", messages: 1 },
  ]);
  for (const limit of [1, 5]) expect(ids(await paged(path, "messages", limit))).toEqual(ids(expected));
  expect(ids((await ok<Unanswered>(await get(`/orgs/${LIA}/unanswered`))).messages)).toEqual([message(29)]);

  expect(await refusal(await get(`/orgs/${UNKNOWN}/unanswered`))).toEqual([404, "not_found"]);
  expect(await refusal(await get(`${path}?outcome=run`))).toEqual([400, "invalid_request"]);
  expect(await refusal(await get(`${path}?from=${ago(8 * 24 + 1).toISOString()}`))).toEqual([400, "invalid_request"]);
  expect(await refusal(await get(`${path}?from=${ago(1).toISOString()}&to=${ago(2).toISOString()}`))).toEqual([
    400,
    "invalid_request",
  ]);
  expect(await refusal(await get(`${path}?cursor=nope`))).toEqual([400, "invalid_cursor"]);
});

test("email jobs: the emails queued to one address, found by it and never saying it", async () => {
  const sent = {
    kind: "email.send",
    maxAttempts: 6,
    lockedUntil: null,
    lockedBy: null,
    runId: null,
    cause: null,
    completedAt: null,
    nextAttemptAt: expect.any(String),
    template: "invitation",
    errorCode: null,
    lastError: null,
    orgId: null,
    status: "pending",
  };
  // Any case of the whole address, among the ones a job is to.
  for (const to of ["ana@example.com", "ANA@Example.COM"]) {
    const { jobs, next } = await ok<Page<"jobs">>(await get(`/email-jobs?to=${encodeURIComponent(to)}`));
    expect(next).toBeNull();
    expect(jobs).toEqual([
      {
        ...sent,
        id: job(11),
        orgId: ADA,
        status: "done",
        attempts: 1,
        createdAt: ago(1).toISOString(),
        completedAt: ago(1).toISOString(),
      },
      {
        ...sent,
        id: job(12),
        status: "failed",
        attempts: 6,
        template: "password_reset",
        // The provider's own name for its refusal; without one, its status.
        errorCode: "validation_error",
        lastError: "MillionSend refused the email (422 validation_error): the address is on a list",
        createdAt: ago(2).toISOString(),
      },
      {
        ...sent,
        id: job(13),
        attempts: 2,
        errorCode: "429",
        lastError: "MillionSend refused the email (429):",
        createdAt: ago(3).toISOString(),
      },
      {
        ...sent,
        id: job(14),
        attempts: 1,
        lastError: "could not reach MillionSend: timeout",
        createdAt: ago(4).toISOString(),
      },
    ]);
  }
  const to = async (address: string) =>
    ids((await ok<Page<"jobs">>(await get(`/email-jobs?to=${encodeURIComponent(address)}`))).jobs);
  expect(await to("other@example.com")).toEqual([job(12), job(15)]);
  // The whole address, matched literally.
  expect(await to("ana@example")).toEqual([]);
  expect(await to("%@example.com")).toEqual([]);
  expect(await to("nobody@example.com")).toEqual([]);
  for (const limit of [1, 3]) {
    expect(ids(await paged("/email-jobs?to=ana%40example.com", "jobs", limit))).toEqual([11, 12, 13, 14].map(job));
  }

  expect(await refusal(await get("/email-jobs"))).toEqual([400, "invalid_request"]);
  expect(await refusal(await get("/email-jobs?to=ana%40example.com&cursor=nope"))).toEqual([400, "invalid_cursor"]);
});

test("these reads need a token, the read-only one is enough, and none says what is hidden", async () => {
  for (const path of [
    `/orgs/${ADA}/notifications?userId=u-ada`,
    `/orgs/${ADA}/access?userId=u-ada&targetKind=agent&targetId=${DEV}`,
    `/orgs/${ADA}/unanswered`,
    "/email-jobs?to=ana%40example.com",
  ]) {
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
  expect(answers.length).toBeGreaterThan(100);
  for (const text of answers) {
    const said = text.toLowerCase();
    for (const hidden of HIDDEN) expect({ text, has: said.includes(hidden) }).toEqual({ text, has: false });
    const named = [...keysOf(JSON.parse(text))].filter((key) => /token|password|secret|hash|cipher|key/i.test(key));
    expect(named).toEqual([]);
  }
});
