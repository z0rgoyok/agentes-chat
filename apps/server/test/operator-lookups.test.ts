import { afterAll, beforeAll, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { createLogger } from "../src/logger";
import { createOperatorApp } from "../src/operator/app";
import { createTestServer, type TestServer } from "./harness";

/** ADR 0056, the lookups: accounts, what a reference names, and a workspace's people, channels and agents. */

const TOKEN = "operator-test-token-".padEnd(48, "x");
const READ = "operator-read-token-".padEnd(48, "x");
const DAY = 86_400_000;

const uid = (start: string, n: number) => `${start}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADA = uid("11111111", 1);
const LIA = uid("22222222", 1);
// An agent and a channel whose ids start alike: the start of an id can name both.
const DEV = uid("c0ffee00", 1);
const GENERAL = uid("c0ffee00", 2);
const PLANS = uid("33333333", 1);
const DM = uid("33333333", 2);
const TASK_TALK = uid("33333333", 3);
const LIA_GENERAL = uid("33333333", 4);
const OLD = uid("44444444", 1);
const GONE = uid("44444444", 2);
const LIA_DEV = uid("44444444", 3);
const BOX = uid("55555555", 1);
const ACCOUNT = uid("55555555", 2);
const CREDENTIAL = uid("55555555", 3);
const RUN = uid("55555555", 4);
const ROOT = uid("55555555", 5);
const REPLY = uid("55555555", 6);
const TASK = uid("55555555", 7);
const FILE = uid("55555555", 8);
const day = (n: number) => new Date(Date.UTC(2026, 0, n));

/** Stored where no lookup may read from: a credential, a hash, or text someone wrote. */
const HIDDEN = [
  "fake-session",
  "fake-password-hash",
  "fake-access",
  "fake-invite-hash",
  "fake-claim-hash",
  "fake-machine-hash",
  "v1.fake.fake.fake",
  "fake-wrapped",
  "zq9x",
  "zq8y",
  "plan@example.com",
  "Work plan",
  "canary",
];

let t: TestServer;
/** A GET with this token (null: none); the read-only one unless said. */
let get: (path: string, token?: string | null) => Promise<Response>;
let lastSeen: Date;

beforeAll(async () => {
  t = await createTestServer({ env: { OPERATOR_API_TOKEN: TOKEN } });
  const deps = { db: t.db, config: t.config, version: "test", log: createLogger("error") };
  const app = createOperatorApp(deps, TOKEN, READ);
  get = async (path, token = READ) =>
    app.request(`/api/operator/v1${path}`, { headers: token === null ? {} : { authorization: `Bearer ${token}` } });
  const db = t.db;

  await db.insert(schema.organizations).values([
    { id: ADA, name: "Ada Labs" },
    { id: LIA, name: "Lia Studio" },
  ]);
  await db.insert(schema.users).values([
    { id: "u-ada", name: "Ada Lovelace", email: "ada@example.com", createdAt: day(1) },
    { id: "u-bob", name: "Bob Stone", email: "bob@example.com", createdAt: day(2) },
    { id: "u-cy", name: "Cy Adams", email: "cy@example.net", createdAt: day(3) },
    {
      id: "u-gone",
      name: "Gone Person",
      email: "gone@example.com",
      createdAt: day(4),
      blockedAt: day(10),
      blockedReason: "fraud",
      deletionDueAt: day(20),
    },
    { id: "u-lia", name: "Lia", email: "lia@example.org", createdAt: day(5) },
  ]);
  await db.insert(schema.organizationMembers).values([
    { orgId: ADA, userId: "u-ada", role: "owner", handle: "ada", createdAt: day(1) },
    { orgId: ADA, userId: "u-bob", role: "member", handle: "bob", createdAt: day(2), lastSeenAt: day(9) },
    { orgId: ADA, userId: "u-cy", role: "member", createdAt: day(3) },
    { orgId: ADA, userId: "u-gone", role: "member", handle: "gone", createdAt: day(4) },
    { orgId: LIA, userId: "u-lia", role: "owner", handle: "lia", createdAt: day(5) },
    { orgId: LIA, userId: "u-ada", role: "member", handle: "ada", createdAt: day(6) },
  ]);
  const [admins] = await db
    .insert(schema.orgRoles)
    .values({ orgId: ADA, name: "Admins", permissions: ["administrator"] })
    .returning({ id: schema.orgRoles.id });
  await db.insert(schema.organizationMemberRoles).values({ orgId: ADA, userId: "u-bob", roleId: admins?.id ?? "" });
  await db.insert(schema.sessions).values(
    [1, 2].map((n) => ({
      id: `s-${n}`,
      token: `fake-session-${n}`,
      userId: "u-ada",
      expiresAt: new Date(Date.now() + DAY),
      createdAt: day(30 + n),
    })),
  );
  await db.insert(schema.accounts).values({
    id: "a-ada",
    accountId: "u-ada",
    providerId: "credential",
    userId: "u-ada",
    password: "fake-password-hash",
    accessToken: "fake-access",
  });

  const invitation = (email: string, n: number, over: { expiresAt?: Date; acceptedAt?: Date } = {}) => ({
    orgId: ADA,
    email,
    role: "member" as const,
    tokenHash: `fake-invite-hash-${n}`,
    invitedByUserId: "u-ada",
    note: "canary invitation note",
    expiresAt: new Date(Date.now() + DAY),
    createdAt: day(10 + n),
    ...over,
  });
  await db
    .insert(schema.organizationInvitations)
    .values([
      invitation("new@example.com", 1),
      invitation("late@example.com", 2, { expiresAt: day(15) }),
      invitation("done@example.com", 3, { acceptedAt: day(14) }),
    ]);
  await db.insert(schema.organizationJoinRequests).values([
    {
      orgId: ADA,
      email: "ask@example.com",
      name: "Asker",
      note: "canary request note",
      passwordHash: "fake-password-hash-2",
      claimHash: "fake-claim-hash",
      verifiedAt: day(16),
      expiresAt: new Date(Date.now() + DAY),
      createdAt: day(16),
    },
    {
      orgId: ADA,
      email: "no@example.com",
      name: "Denied",
      status: "denied",
      reason: "canary denial reason",
      decidedByUserId: "u-ada",
      decidedAt: day(18),
      expiresAt: day(40),
      createdAt: day(17),
    },
  ]);

  await db.insert(schema.channels).values([
    { id: GENERAL, orgId: ADA, name: "general", topic: "canary topic", createdAt: day(1) },
    { id: PLANS, orgId: ADA, name: "plans", visibility: "private", createdAt: day(2), archivedAt: day(8) },
    { id: DM, orgId: ADA, name: "dm-0123abcd", kind: "dm", dmKey: `a:${DEV}|u:u-ada`, createdAt: day(3) },
    { id: TASK_TALK, orgId: ADA, name: "task-0123abcd", kind: "task", createdAt: day(4) },
    { id: LIA_GENERAL, orgId: LIA, name: "general", createdAt: day(5) },
  ]);
  lastSeen = new Date();
  await db
    .insert(schema.machines)
    .values({ id: BOX, orgId: ADA, name: "Box", tokenHash: "fake-machine-hash", online: true, lastSeenAt: lastSeen });
  await db.insert(schema.providerCredentials).values({
    id: CREDENTIAL,
    orgId: ADA,
    provider: "openai",
    label: "canary label",
    secretCiphertext: "v1.fake.fake.fake",
    wrappedDataKey: "fake-wrapped",
    kekId: "local:v1",
    keyHint: "zq9x",
  });
  await db.insert(schema.machineAccounts).values({
    id: ACCOUNT,
    orgId: ADA,
    machineId: BOX,
    kind: "claude_code",
    label: "Work plan",
    email: "plan@example.com",
    keyHint: "zq8y",
    plan: "max",
    status: "signed_out",
    authMethod: "setup_token",
    lastFailureCause: "auth_rejected",
    lastFailureAt: day(21),
  });
  const agent = { orgId: ADA, model: "claude-sonnet-5-5", instructions: "canary instructions" };
  await db.insert(schema.agents).values([
    {
      ...agent,
      id: DEV,
      name: "Dev",
      handle: "dev",
      previousHandles: ["coder"],
      ownerUserId: "u-ada",
      credentialId: CREDENTIAL,
      brain: "claude_code",
      brainModel: "opus",
      brainAccountId: ACCOUNT,
      machineId: BOX,
      approvalsLevel: "never",
      audienceMode: "owner",
      operatorHoldAt: day(22),
      operatorHoldReason: "spam",
      createdAt: day(1),
    },
    { ...agent, id: OLD, name: "Old", handle: "old", createdAt: day(2), archivedAt: day(7) },
    {
      ...agent,
      id: GONE,
      name: "Gone",
      handle: `deleted-${GONE}`,
      createdAt: day(3),
      archivedAt: day(7),
      deletedAt: day(7),
    },
    { ...agent, id: LIA_DEV, orgId: LIA, name: "Dev too", handle: "dev", createdAt: day(5) },
  ]);
  await db.insert(schema.channelMembers).values([
    { orgId: ADA, channelId: GENERAL, userId: "u-ada" },
    { orgId: ADA, channelId: GENERAL, userId: "u-bob" },
    { orgId: ADA, channelId: GENERAL, agentId: DEV, autoReply: false },
    { orgId: ADA, channelId: PLANS, userId: "u-ada" },
    { orgId: ADA, channelId: PLANS, agentId: DEV },
    { orgId: ADA, channelId: DM, userId: "u-ada" },
    { orgId: ADA, channelId: DM, agentId: DEV },
  ]);

  const skill = (slug: string, deletedAt: Date | null = null) => ({
    orgId: ADA,
    slug,
    name: slug,
    description: "canary skill description",
    body: "canary skill body",
    source: "manual",
    deletedAt,
  });
  const made = await db
    .insert(schema.skills)
    .values([skill("deploys"), skill("reviews"), skill("retired", day(6))])
    .returning({ id: schema.skills.id });
  await db
    .insert(schema.agentSkills)
    .values(made.map((s, i) => ({ orgId: ADA, agentId: DEV, skillId: s.id, enabled: i !== 1 })));
  const routine = (name: string, deletedAt: Date | null = null) => ({
    orgId: ADA,
    agentId: DEV,
    name,
    prompt: "canary routine prompt",
    target: { type: "dm" },
    triggerType: "schedule",
    deletedAt,
  });
  await db.insert(schema.routines).values([routine("canary daily"), routine("canary weekly", day(6))]);
  const memory = (status: "active" | "archived") => ({
    orgId: ADA,
    agentId: DEV,
    kind: "note" as const,
    scopeType: "agent",
    title: "canary memory title",
    content: "canary memory",
    status,
  });
  await db.insert(schema.contextItems).values([memory("active"), memory("active"), memory("archived")]);

  await db.insert(schema.messages).values([
    { id: ROOT, orgId: ADA, channelId: GENERAL, authorType: "person", authorUserId: "u-ada", body: "canary question" },
    {
      id: REPLY,
      orgId: ADA,
      channelId: GENERAL,
      threadId: ROOT,
      authorType: "agent",
      authorAgentId: DEV,
      agentRunId: RUN,
      body: "canary answer",
    },
  ]);
  await db.insert(schema.agentRuns).values({
    id: RUN,
    orgId: ADA,
    agentId: DEV,
    channelId: GENERAL,
    threadRootId: ROOT,
    triggerMessageId: ROOT,
    trigger: "mention",
    hop: 1,
    transcript: { system: "canary prompt" },
  });
  await db.insert(schema.issues).values({
    id: TASK,
    orgId: ADA,
    number: 7,
    title: "canary task title",
    description: "canary task description",
    conversationChannelId: TASK_TALK,
    createdByType: "person",
    createdById: "u-ada",
  });
  await db.insert(schema.artifacts).values({
    id: FILE,
    orgId: ADA,
    kind: "document",
    title: "canary file title",
    excerpt: "canary excerpt",
    channelId: GENERAL,
    currentVersion: 3,
    createdByType: "person",
    createdById: "u-ada",
    updatedByType: "person",
    updatedById: "u-ada",
  });
});

afterAll(() => t.close());

async function ok<T = Record<string, unknown>>(res: Response) {
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}
const refusal = async (res: Response) => [res.status, ((await res.json()) as { error: { code: string } }).error.code];
const ref = (text: string, orgId?: string) =>
  `/resolve?ref=${encodeURIComponent(text)}${orgId ? `&orgId=${orgId}` : ""}`;

type Match = Record<string, unknown> & { kind: string; id: string };
type Resolved = { form: string; matches: Match[] };
const NOTHING = {
  orgId: null,
  name: null,
  handle: null,
  email: null,
  channelId: null,
  threadRootId: null,
  agentId: null,
  runId: null,
  number: null,
  version: null,
  createdAt: expect.any(String),
};

/** One call of every lookup, in every form `ref` is read. */
const everyRead = () => [
  "/users?q=example&limit=200",
  "/users?email=ada@example.com",
  `/orgs/${ADA}/members?limit=200`,
  `/orgs/${ADA}/channels?limit=200`,
  `/orgs/${ADA}/agents?limit=200`,
  `/agents/${DEV}`,
  `/agents/${GONE}`,
  ref(`/org/${ADA}/threads/${ROOT}?m=${REPLY}`),
  ref(`/org/${ADA}/drive?artifact=${FILE}`),
  ref("@dev", ADA),
  ref("@ada", ADA),
  ref("#general", ADA),
  ref("#7", ADA),
  ref("c0ffee00", ADA),
  ref("55555555", ADA),
  ref("33333333", ADA),
  ref(ADA),
  ref("u-ada"),
];

test("every lookup answers the read-only token as it does the full one, and nothing without a token", async () => {
  for (const path of everyRead()) {
    const [read, full, none] = await Promise.all([get(path), get(path, TOKEN), get(path, null)]);
    expect({ path, read: read.status, full: full.status }).toEqual({ path, read: 200, full: 200 });
    expect(await read.json()).toEqual(await full.json());
    expect({ path, answer: await refusal(none) }).toEqual({ path, answer: [401, "unauthorized"] });
  }
});

test("no lookup carries a credential, a hash, what anyone wrote, or a field named like a secret", async () => {
  for (const path of everyRead()) {
    const text = await (await get(path)).text();
    for (const hidden of HIDDEN) expect({ path, leaked: text.includes(hidden) }).toEqual({ path, leaked: false });
    expect(text).not.toMatch(/"[^"]*(token|password|secret|hash|cipher|key)[^"]*":/i);
  }
});

type UserPage = { users: (Record<string, unknown> & { id: string; orgs: unknown[] })[]; next: string | null };

test("accounts: by the whole address or part of an address or a name, with their workspaces", async () => {
  const one = await ok<UserPage>(await get("/users?email=ADA%40Example.com"));
  expect(one).toEqual({
    users: [
      {
        id: "u-ada",
        email: "ada@example.com",
        name: "Ada Lovelace",
        emailVerified: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        blockedAt: null,
        blockedReason: null,
        deletionDueAt: null,
        lastSignInAt: "2026-02-01T00:00:00.000Z",
        orgs: [
          { orgId: ADA, name: "Ada Labs", role: "owner" },
          { orgId: LIA, name: "Lia Studio", role: "member" },
        ],
        orgCount: 2,
      },
    ],
    next: null,
  });

  const ids = async (query: string) => (await ok<UserPage>(await get(`/users?${query}`))).users.map((u) => u.id);
  // Newest first: Cy by name, Ada by both.
  expect(await ids("q=ADA")).toEqual(["u-cy", "u-ada"]);
  expect(await ids("q=example.com")).toEqual(["u-gone", "u-bob", "u-ada"]);
  expect(await ids("q=ada&email=cy@example.net")).toEqual(["u-cy"]);
  expect(await ids("email=ada@example")).toEqual([]);
  expect(await ids("q=%25")).toEqual([]);
  expect(await ids("q=_")).toEqual([]);

  const { users: found } = await ok<UserPage>(await get("/users?q=stone"));
  expect(found[0]).toMatchObject({ id: "u-bob", orgs: [{ orgId: ADA, name: "Ada Labs", role: "admin" }] });
  const [gone] = (await ok<UserPage>(await get("/users?q=gone@"))).users;
  expect(gone).toMatchObject({
    blockedAt: "2026-01-10T00:00:00.000Z",
    blockedReason: "fraud",
    deletionDueAt: "2026-01-20T00:00:00.000Z",
    lastSignInAt: null,
    orgCount: 1,
  });

  const all = await ids("q=example&limit=200");
  expect(all).toEqual(["u-lia", "u-gone", "u-cy", "u-bob", "u-ada"]);
  for (const limit of [1, 2]) {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: UserPage = await ok<UserPage>(
        await get(`/users?q=example&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`),
      );
      expect(page.users.length).toBeLessThanOrEqual(limit);
      seen.push(...page.users.map((u) => u.id));
      cursor = page.next;
    } while (cursor);
    expect(seen).toEqual(all);
  }

  for (const query of ["", "limit=5", "q=", "email=", "q=a%00", "q=a&limit=0", "q=a&limit=201"]) {
    expect({ query, answer: await refusal(await get(`/users?${query}`)) }).toEqual({
      query,
      answer: [400, "invalid_request"],
    });
  }
  expect(await refusal(await get("/users?q=a&cursor=nope"))).toEqual([400, "invalid_cursor"]);
});

test("accounts: one in many workspaces lists its first 20 and says how many", async () => {
  const orgs = await t.db
    .insert(schema.organizations)
    .values(Array.from({ length: 22 }, (_, i) => ({ name: `Many ${String(i).padStart(2, "0")}` })))
    .returning({ id: schema.organizations.id, name: schema.organizations.name });
  await t.db.insert(schema.users).values({ id: "u-many", name: "Many", email: "many@example.io", createdAt: day(6) });
  await t.db
    .insert(schema.organizationMembers)
    .values(orgs.map((o, i) => ({ orgId: o.id, userId: "u-many", role: "owner" as const, createdAt: day(1 + i) })));

  const { users } = await ok<UserPage>(await get("/users?email=many@example.io"));
  expect(users[0]?.orgCount).toBe(22);
  expect(users[0]?.orgs).toEqual(
    [...orgs]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 20)
      .map((o) => ({ orgId: o.id, name: o.name, role: "owner" })),
  );
});

test("resolve: a message's and a file's link, whatever its address", async () => {
  const root = await ok<Resolved>(await get(ref(`/org/${ADA}/c/${GENERAL}?m=${ROOT}`)));
  expect(root).toEqual({
    form: "message_link",
    matches: [{ ...NOTHING, kind: "message", id: ROOT, orgId: ADA, channelId: GENERAL }],
  });
  const reply = await ok<Resolved>(await get(ref(`https://app.example.com/org/${ADA}/threads/${ROOT}?m=${REPLY}`)));
  expect(reply.matches).toEqual([
    {
      ...NOTHING,
      kind: "message",
      id: REPLY,
      orgId: ADA,
      channelId: GENERAL,
      threadRootId: ROOT,
      agentId: DEV,
      runId: RUN,
    },
  ]);
  // A link names its own workspace: asked for in another, or of a message that isn't there, it names nothing.
  expect(await ok(await get(ref(`/org/${ADA}/c/${GENERAL}?m=${ROOT}`, LIA)))).toEqual({
    form: "message_link",
    matches: [],
  });
  expect(await ok(await get(ref(`/org/${LIA}/c/${GENERAL}?m=${ROOT}`)))).toEqual({
    form: "message_link",
    matches: [],
  });

  const file = { ...NOTHING, kind: "file", id: FILE, orgId: ADA, channelId: GENERAL };
  expect(await ok(await get(ref(`/org/${ADA}/drive?artifact=${FILE}&v=2`)))).toEqual({
    form: "file_link",
    matches: [{ ...file, version: 2 }],
  });
  const latest = await ok<Resolved>(await get(ref(`https://app.example.com/org/${ADA}/drive?artifact=${FILE}`)));
  expect(latest.matches).toEqual([{ ...file, version: 3 }]);
});

test("resolve: a handle, a channel and a task's number, in one workspace", async () => {
  const dev = { ...NOTHING, kind: "agent", id: DEV, orgId: ADA, name: "Dev", handle: "dev" };
  expect(await ok(await get(ref("@dev", ADA)))).toEqual({ form: "handle", matches: [dev] });
  // A handle it had before, and any case.
  expect((await ok<Resolved>(await get(ref("@Coder", ADA)))).matches).toEqual([dev]);
  expect((await ok<Resolved>(await get(ref("@dev", LIA)))).matches).toMatchObject([{ id: LIA_DEV, orgId: LIA }]);
  expect((await ok<Resolved>(await get(ref("@bob", ADA)))).matches).toEqual([
    { ...NOTHING, kind: "user", id: "u-bob", orgId: ADA, name: "Bob Stone", handle: "bob", email: "bob@example.com" },
  ]);
  expect(await ok(await get(ref("@nobody", ADA)))).toEqual({ form: "handle", matches: [] });

  expect(await ok(await get(ref("#General", ADA)))).toEqual({
    form: "channel_name",
    matches: [{ ...NOTHING, kind: "channel", id: GENERAL, orgId: ADA, name: "general" }],
  });
  // Only channels have names people use.
  expect((await ok<Resolved>(await get(ref("#dm-0123abcd", ADA)))).matches).toEqual([]);

  const task = { ...NOTHING, kind: "task", id: TASK, orgId: ADA, number: 7, channelId: TASK_TALK };
  expect(await ok(await get(ref("#7", ADA)))).toEqual({ form: "task_number", matches: [task] });
  expect(await ok(await get(ref("7", ADA)))).toEqual({ form: "task_number", matches: [task] });
  expect((await ok<Resolved>(await get(ref("8", ADA)))).matches).toEqual([]);
  expect((await ok<Resolved>(await get(ref("7", LIA)))).matches).toEqual([]);

  for (const text of ["@dev", "#general", "#7", "7", "c0ffee00"]) {
    expect({ text, answer: await refusal(await get(ref(text))) }).toEqual({ text, answer: [400, "invalid_request"] });
  }
});

test("resolve: an id, the start of one, and an account's id", async () => {
  const kinds = async (text: string, orgId?: string) =>
    (await ok<Resolved>(await get(ref(text, orgId)))).matches.map((m) => [m.kind, m.id]);
  expect(await ok(await get(ref(ADA)))).toEqual({
    form: "id",
    matches: [{ ...NOTHING, kind: "workspace", id: ADA, orgId: ADA, name: "Ada Labs" }],
  });
  expect(await ok(await get(ref(RUN.toUpperCase())))).toEqual({
    form: "id",
    matches: [{ ...NOTHING, kind: "run", id: RUN, orgId: ADA, agentId: DEV, channelId: GENERAL, threadRootId: ROOT }],
  });
  expect(await kinds(DEV)).toEqual([["agent", DEV]]);
  expect(await kinds(GENERAL)).toEqual([["channel", GENERAL]]);
  expect(await kinds(ROOT)).toEqual([["message", ROOT]]);
  expect(await kinds(TASK)).toEqual([["task", TASK]]);
  expect(await kinds(FILE)).toEqual([["file", FILE]]);
  expect(await kinds(ACCOUNT)).toEqual([["ai_account", ACCOUNT]]);
  expect((await ok<Resolved>(await get(ref(BOX)))).matches).toEqual([
    { ...NOTHING, kind: "computer", id: BOX, orgId: ADA, name: "Box" },
  ]);
  // A direct conversation and a task's are told apart from a channel, and their made-up names are left out.
  expect((await ok<Resolved>(await get(ref(DM)))).matches).toEqual([{ ...NOTHING, kind: "dm", id: DM, orgId: ADA }]);
  expect(await kinds(TASK_TALK)).toEqual([["task_conversation", TASK_TALK]]);
  // In another workspace it is nothing; so is an id nobody has.
  expect(await kinds(DEV, LIA)).toEqual([]);
  expect(await kinds(ADA, LIA)).toEqual([]);
  expect(await kinds(uid("99999999", 9))).toEqual([]);

  const alike = await ok<Resolved>(await get(ref("C0FFEE00", ADA)));
  expect(alike.form).toBe("id_prefix");
  expect(alike.matches.map((m) => [m.kind, m.id])).toEqual([
    ["agent", DEV],
    ["channel", GENERAL],
  ]);
  expect(await kinds("55555555", ADA)).toEqual([
    ["message", ROOT],
    ["message", REPLY],
    ["run", RUN],
    ["task", TASK],
    ["file", FILE],
    ["computer", BOX],
    ["ai_account", ACCOUNT],
  ]);
  expect(await kinds("c0ffee00", LIA)).toEqual([]);
  // Never a workspace by the start of its id: the start of an id is looked up inside one.
  expect(await kinds("11111111", ADA)).toEqual([]);

  expect(await ok(await get(ref("u-bob")))).toEqual({
    form: "user_id",
    matches: [{ ...NOTHING, kind: "user", id: "u-bob", name: "Bob Stone", email: "bob@example.com" }],
  });
  expect(await ok(await get(ref("nobody")))).toEqual({ form: "user_id", matches: [] });

  for (const query of [
    "",
    "ref=",
    "ref=two%20words",
    "ref=bob@example.com",
    "ref=@a.b",
    "ref=%23a%00",
    "ref=x&orgId=y",
  ]) {
    expect({ query, answer: await refusal(await get(`/resolve?${query}`)) }).toEqual({
      query,
      answer: [400, "invalid_request"],
    });
  }
});

type Members = {
  members: Record<string, unknown>[];
  next: string | null;
  invitations: Record<string, unknown>[];
  joinRequests: Record<string, unknown>[];
};

test("a workspace's people: members as they joined, invitations not accepted, join requests", async () => {
  const people = await ok<Members>(await get(`/orgs/${ADA}/members`));
  const member = { lastSeenAt: null, blockedAt: null, deletionDueAt: null };
  expect(people.members).toEqual([
    {
      ...member,
      userId: "u-ada",
      email: "ada@example.com",
      name: "Ada Lovelace",
      handle: "ada",
      role: "owner",
      joinedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      ...member,
      userId: "u-bob",
      email: "bob@example.com",
      name: "Bob Stone",
      handle: "bob",
      role: "admin",
      joinedAt: "2026-01-02T00:00:00.000Z",
      lastSeenAt: "2026-01-09T00:00:00.000Z",
    },
    {
      ...member,
      userId: "u-cy",
      email: "cy@example.net",
      name: "Cy Adams",
      handle: null,
      role: "member",
      joinedAt: "2026-01-03T00:00:00.000Z",
    },
    {
      userId: "u-gone",
      email: "gone@example.com",
      name: "Gone Person",
      handle: "gone",
      role: "member",
      joinedAt: "2026-01-04T00:00:00.000Z",
      lastSeenAt: null,
      blockedAt: "2026-01-10T00:00:00.000Z",
      deletionDueAt: "2026-01-20T00:00:00.000Z",
    },
  ]);
  expect(people.next).toBeNull();
  expect(people.invitations).toEqual([
    {
      id: expect.any(String),
      email: "late@example.com",
      role: "member",
      invitedByUserId: "u-ada",
      createdAt: "2026-01-12T00:00:00.000Z",
      expiresAt: "2026-01-15T00:00:00.000Z",
    },
    {
      id: expect.any(String),
      email: "new@example.com",
      role: "member",
      invitedByUserId: "u-ada",
      createdAt: "2026-01-11T00:00:00.000Z",
      expiresAt: expect.any(String),
    },
  ]);
  expect(people.joinRequests).toEqual([
    {
      id: expect.any(String),
      email: "no@example.com",
      name: "Denied",
      userId: null,
      status: "denied",
      verifiedAt: null,
      createdAt: "2026-01-17T00:00:00.000Z",
      expiresAt: "2026-02-09T00:00:00.000Z",
      decidedAt: "2026-01-18T00:00:00.000Z",
      decidedByUserId: "u-ada",
      invitationId: null,
    },
    {
      id: expect.any(String),
      email: "ask@example.com",
      name: "Asker",
      userId: null,
      status: "pending",
      verifiedAt: "2026-01-16T00:00:00.000Z",
      createdAt: "2026-01-16T00:00:00.000Z",
      expiresAt: expect.any(String),
      decidedAt: null,
      decidedByUserId: null,
      invitationId: null,
    },
  ]);

  const first = await ok<Members>(await get(`/orgs/${ADA}/members?limit=3`));
  expect(first.members.map((m) => m.userId)).toEqual(["u-ada", "u-bob", "u-cy"]);
  const rest = await ok<Members>(await get(`/orgs/${ADA}/members?limit=3&cursor=${first.next}`));
  expect([rest.members.map((m) => m.userId), rest.next, rest.invitations.length]).toEqual([["u-gone"], null, 2]);

  // Each workspace's own, and its own handle for someone in both.
  const lia = await ok<Members>(await get(`/orgs/${LIA}/members`));
  expect(lia.members.map((m) => [m.userId, m.role])).toEqual([
    ["u-lia", "owner"],
    ["u-ada", "member"],
  ]);
  expect([lia.invitations, lia.joinRequests]).toEqual([[], []]);
});

type ChannelPage = { channels: (Record<string, unknown> & { id: string })[]; next: string | null };

test("a workspace's channels: every kind with how many are in it, newest first", async () => {
  const all = await ok<ChannelPage>(await get(`/orgs/${ADA}/channels`));
  const channel = { visibility: "public", people: 0, agents: 0, archivedAt: null, deletedAt: null };
  expect(all).toEqual({
    channels: [
      { ...channel, id: TASK_TALK, name: "task-0123abcd", kind: "task", createdAt: "2026-01-04T00:00:00.000Z" },
      {
        ...channel,
        id: DM,
        name: "dm-0123abcd",
        kind: "dm",
        people: 1,
        agents: 1,
        createdAt: "2026-01-03T00:00:00.000Z",
      },
      {
        ...channel,
        id: PLANS,
        name: "plans",
        kind: "channel",
        visibility: "private",
        people: 1,
        agents: 1,
        createdAt: "2026-01-02T00:00:00.000Z",
        archivedAt: "2026-01-08T00:00:00.000Z",
      },
      {
        ...channel,
        id: GENERAL,
        name: "general",
        kind: "channel",
        people: 2,
        agents: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    next: null,
  });

  const ids = async (query: string) =>
    (await ok<ChannelPage>(await get(`/orgs/${ADA}/channels?${query}`))).channels.map((c) => c.id);
  expect(await ids("kind=channel")).toEqual([PLANS, GENERAL]);
  expect(await ids("kind=dm")).toEqual([DM]);
  expect(await ids("kind=task")).toEqual([TASK_TALK]);
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page: ChannelPage = await ok<ChannelPage>(
      await get(`/orgs/${ADA}/channels?limit=3${cursor ? `&cursor=${cursor}` : ""}`),
    );
    seen.push(...page.channels.map((c) => c.id));
    cursor = page.next;
  } while (cursor);
  expect(seen).toEqual(all.channels.map((c) => c.id));
  expect(await refusal(await get(`/orgs/${ADA}/channels?kind=forum`))).toEqual([400, "invalid_request"]);
});

type AgentPage = { agents: (Record<string, unknown> & { id: string })[]; next: string | null };

test("a workspace's agents, and one agent: who thinks for it, its computer, its channels, how much it has", async () => {
  const summary = {
    id: DEV,
    orgId: ADA,
    name: "Dev",
    handle: "dev",
    builtin: null,
    ownerUserId: "u-ada",
    brain: "claude_code",
    model: "claude-sonnet-5-5",
    brainModel: "opus",
    credentialId: CREDENTIAL,
    accountId: ACCOUNT,
    machineId: BOX,
    approvalsLevel: "never",
    audienceMode: "owner",
    hold: { heldAt: "2026-01-22T00:00:00.000Z", reason: "spam" },
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
  };
  const listed = await ok<AgentPage>(await get(`/orgs/${ADA}/agents`));
  expect(listed.agents.map((a) => a.id)).toEqual([GONE, OLD, DEV]);
  expect(listed.next).toBeNull();
  expect(listed.agents[2]).toEqual(summary);
  expect(listed.agents[0]).toMatchObject({
    handle: `deleted-${GONE}`,
    brain: "model",
    hold: null,
    archivedAt: "2026-01-07T00:00:00.000Z",
    deletedAt: "2026-01-07T00:00:00.000Z",
  });
  const first = await ok<AgentPage>(await get(`/orgs/${ADA}/agents?limit=2`));
  const rest = await ok<AgentPage>(await get(`/orgs/${ADA}/agents?limit=2&cursor=${first.next}`));
  expect([...first.agents, ...rest.agents].map((a) => a.id)).toEqual([GONE, OLD, DEV]);
  expect(rest.next).toBeNull();
  expect((await ok<AgentPage>(await get(`/orgs/${LIA}/agents`))).agents.map((a) => a.id)).toEqual([LIA_DEV]);

  expect(await ok(await get(`/agents/${DEV}`))).toEqual({
    ...summary,
    previousHandles: ["coder"],
    fallback: true,
    provider: "openai",
    credential: { id: CREDENTIAL, provider: "openai", revokedAt: null },
    account: {
      id: ACCOUNT,
      kind: "claude_code",
      provider: null,
      authMethod: "setup_token",
      plan: "max",
      status: "signed_out",
      statusUnknown: false,
      lastSuccessAt: null,
      lastFailureCause: "auth_rejected",
      lastFailureAt: "2026-01-21T00:00:00.000Z",
    },
    machine: { id: BOX, name: "Box", kind: "connected", online: true, lastSeenAt: lastSeen.toISOString() },
    // By name, with whether it answers there unasked; never its direct conversations.
    channels: [
      { id: GENERAL, name: "general", autoReply: false },
      { id: PLANS, name: "plans", autoReply: true },
    ],
    // Not the skill turned off for it, the deleted one, the deleted routine or the archived memory.
    counts: { skills: 1, routines: 1, memories: 2 },
  });
  // With no credential of its own, the provider is its model's.
  expect(await ok(await get(`/agents/${LIA_DEV}`))).toMatchObject({
    id: LIA_DEV,
    orgId: LIA,
    brain: "model",
    provider: "anthropic",
    credential: null,
    account: null,
    machine: null,
    channels: [],
    counts: { skills: 0, routines: 0, memories: 0 },
  });
});

test("404 for a workspace or an agent that isn't there, 400 for an id or a cursor that isn't one", async () => {
  const nobody = uid("99999999", 9);
  for (const path of [
    `/orgs/${nobody}/members`,
    `/orgs/${nobody}/channels`,
    `/orgs/${nobody}/agents`,
    `/agents/${nobody}`,
  ]) {
    expect({ path, answer: await refusal(await get(path)) }).toEqual({ path, answer: [404, "not_found"] });
  }
  for (const path of [
    "/orgs/nope/members",
    "/orgs/nope/channels",
    "/orgs/nope/agents",
    "/agents/nope",
    `/orgs/${ADA}/members?limit=201`,
    `/orgs/${ADA}/channels?limit=0`,
    `/orgs/${ADA}/agents?limit=x`,
  ]) {
    expect({ path, answer: await refusal(await get(path)) }).toEqual({ path, answer: [400, "invalid_request"] });
  }
  // A cursor of another list (an account's id where a uuid goes) is refused, not passed to the database.
  const users = await ok<{ next: string }>(await get("/users?q=example&limit=1"));
  for (const path of [`/orgs/${ADA}/members`, `/orgs/${ADA}/channels`, `/orgs/${ADA}/agents`]) {
    expect({ path, answer: await refusal(await get(`${path}?cursor=nope`)) }).toEqual({
      path,
      answer: [400, "invalid_cursor"],
    });
  }
  expect(await refusal(await get(`/orgs/${ADA}/channels?cursor=${users.next}`))).toEqual([400, "invalid_cursor"]);
});
