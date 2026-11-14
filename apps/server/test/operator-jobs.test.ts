import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, schema, sql } from "@agenteschat/db";
import { createLogger } from "../src/logger";
import { createOperatorApp } from "../src/operator/app";
import { createTestServer, planOfLast, type TestServer } from "./harness";

/** ADR 0056, jobs, usage and computers: the queue without its payloads, what model calls spent, what is on a computer. */

const TOKEN = "operator-test-token-".padEnd(48, "x");
const READ = "operator-read-token-".padEnd(48, "x");
const UNKNOWN = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const TIME = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

const uid = (start: string, n: number) => `${start}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADA = uid("11111111", 1);
const LIA = uid("22222222", 1);
const DEV = uid("33333333", 1);
const LIA_DEV = uid("33333333", 2);
const RUN = uid("44444444", 1);
const RUN_WAITING = uid("44444444", 2);
const RUN_WORKING = uid("44444444", 3);
const LIA_RUN = uid("44444444", 4);
const APPROVAL = uid("44444444", 5);
const BOX = uid("55555555", 1);
const MAC = uid("55555555", 2);
const REMOVED = uid("55555555", 3);
const ACCOUNT = uid("55555555", 4);
const SHARED = uid("55555555", 5);
const job = (n: number) => uid("66666666", n);
const [J_POSTED, J_RUN, J_WOKE, J_EMAIL, J_PUSH, J_LATER, J_FRESH, J_BUSY] = [1, 2, 3, 4, 5, 6, 7, 8].map(job) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];
const day = (n: number, hour = 0, minute = 0) => new Date(Date.UTC(2026, 0, n, hour, minute));
const JANUARY = "from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z";

/** Stored where none of these reads may read from: a payload, a credential, or text someone wrote. */
const HIDDEN = [
  "canary",
  "fake-pass",
  "fake-machine-hash",
  "fake-host-mark",
  "203.0.113.7",
  "plan@example.com",
  "Work plan",
  "zq8y",
];

let t: TestServer;
/** A GET with this token (null: none); the read-only one unless said. */
let get: (path: string, token?: string | null) => Promise<Response>;
let fresh: Date;

beforeAll(async () => {
  t = await createTestServer({ env: { OPERATOR_API_TOKEN: TOKEN } });
  const deps = { db: t.db, config: t.config, version: "test", log: createLogger("error") };
  const app = createOperatorApp(deps, TOKEN, READ);
  get = async (path, token = READ) =>
    app.request(`/api/operator/v1${path}`, { headers: token === null ? {} : { authorization: `Bearer ${token}` } });
  const db = t.db;
  const now = Date.now();
  fresh = new Date(now - 5_000);

  await db.insert(schema.organizations).values([
    { id: ADA, name: "Ada Labs", createdAt: day(1) },
    { id: LIA, name: "Lia Studio", createdAt: day(1) },
  ]);
  const agent = { model: "claude-sonnet-5-5", instructions: "canary instructions" };
  await db.insert(schema.agents).values([
    { ...agent, id: DEV, orgId: ADA, name: "Dev", handle: "dev" },
    { ...agent, id: LIA_DEV, orgId: LIA, name: "Dev too", handle: "dev" },
  ]);

  // Computers: the workspace's own with everything on it, one a person connected, and one removed.
  await db.insert(schema.machines).values([
    {
      id: BOX,
      orgId: ADA,
      kind: "managed",
      name: "Box",
      tokenHash: "fake-machine-hash",
      hostname: "canary-host",
      workspace: "/home/canary/agents",
      runnerVersion: "1.2.3",
      protocol: 50,
      online: true,
      lastSeenAt: new Date(now),
      executors: {
        claude: { version: "2.0.31 (Claude Code)", loggedIn: true, authMethod: "canary-auth", plan: "canary-plan" },
        codex: { version: "codex-cli 0.46.0" },
        cursor: { version: "<b>9.9</b>", models: [{ id: "canary-model", label: "canary label" }] },
        browser: { available: true, version: "0.9.1", chrome: "141.0", reason: "canary reason" },
        desktop: { available: false, reason: "canary desktop reason", code: "no_display" },
        mode: "system",
        toolchains: { xcode: "canary-toolchain" },
        claudeLoginBlocked: "canary blocked",
        detectedAt: day(1).toISOString(),
      },
      access: {
        folders: [{ path: "/canary/folder", agents: [] }],
        tools: { claude: true, codex: true, commands: true },
      },
      egress: { ip: "203.0.113.7", at: day(1).toISOString() },
      createdAt: day(1),
    },
    { id: MAC, orgId: ADA, name: "Mac", hostname: "fake-host-mark", createdAt: day(2) },
    { id: REMOVED, orgId: ADA, name: "Old laptop", createdAt: day(3), deletedAt: day(9) },
  ]);
  await db.insert(schema.machineProvisioning).values({
    orgId: ADA,
    state: "ready",
    since: day(2),
    specs: { cpus: 4, memoryGb: 8, diskGb: 100 },
  });
  const account = { orgId: ADA, machineId: BOX, kind: "claude_code", email: "plan@example.com", keyHint: "zq8y" };
  await db.insert(schema.machineAccounts).values([
    {
      ...account,
      id: ACCOUNT,
      label: "Work plan",
      orgName: "canary org",
      plan: "max",
      status: "signed_out",
      authMethod: "setup_token",
      lastFailureCause: "auth_rejected",
      lastFailureAt: day(21),
    },
    { ...account, id: SHARED, label: "canary shared", shared: true, lastUsedAt: day(20), lastSuccessAt: day(20) },
  ]);
  const task = {
    orgId: ADA,
    agentId: DEV,
    machineId: BOX,
    channelId: UNKNOWN,
    title: "canary task",
    executor: "claude",
    command: "canary command",
    prompt: "canary prompt",
    lastLine: "canary line",
  };
  await db.insert(schema.machineTasks).values([
    { ...task, status: "queued" },
    { ...task, status: "running" },
    { ...task, status: "interrupted" },
    { ...task, status: "interrupted", endedAt: day(5) },
    { ...task, status: "done", endedAt: day(5) },
  ]);
  const hold = { orgId: ADA, agentId: DEV, machineId: BOX, what: "canary hold", why: "canary why" };
  await db
    .insert(schema.machineHolds)
    .values([
      hold,
      { ...hold, until: new Date(now + 3600_000) },
      { ...hold, until: day(5) },
      { ...hold, endedAt: day(5), endReason: "exited" },
    ]);
  const run = { orgId: ADA, agentId: DEV, channelId: UNKNOWN, trigger: "mention" as const, hop: 1 };
  await db.insert(schema.agentRuns).values([
    { ...run, id: RUN, threadRootId: uid("77777777", 1), triggerMessageId: uid("77777777", 1), createdAt: day(10, 10) },
    {
      ...run,
      id: RUN_WAITING,
      threadRootId: uid("77777777", 2),
      triggerMessageId: uid("77777777", 2),
      status: "waiting_input",
      waitingMachineId: BOX,
    },
    // Back at work on the computer it waited for: no longer in its line.
    {
      ...run,
      id: RUN_WORKING,
      threadRootId: uid("77777777", 3),
      triggerMessageId: uid("77777777", 3),
      status: "running",
      waitingMachineId: BOX,
    },
    {
      ...run,
      id: LIA_RUN,
      orgId: LIA,
      agentId: LIA_DEV,
      threadRootId: uid("77777777", 4),
      triggerMessageId: uid("77777777", 4),
      createdAt: day(12),
    },
  ]);

  // Jobs: every payload says "canary", and one error holds a password.
  const payload = { note: "canary payload", to: "canary@example.com", url: "https://example.com/r?access=canary" };
  await db.insert(schema.outbox).values([
    {
      id: J_POSTED,
      orgId: ADA,
      kind: "message.posted",
      payload,
      status: "done",
      attempts: 1,
      lockedBy: "worker-1",
      dedupeKey: `message.posted:${uid("77777777", 1)}`,
      nextAttemptAt: day(1),
      createdAt: day(1),
      completedAt: day(1, 0, 1),
    },
    {
      id: J_RUN,
      orgId: ADA,
      kind: "agent_run.execute",
      payload: { ...payload, runId: RUN },
      status: "done",
      attempts: 1,
      maxAttempts: 4,
      lockedBy: "worker-1",
      dedupeKey: `agent_run.execute:${RUN}`,
      nextAttemptAt: day(2),
      createdAt: day(2),
      completedAt: day(2, 0, 1),
    },
    {
      id: J_WOKE,
      orgId: ADA,
      kind: "agent_run.execute",
      payload: { ...payload, runId: RUN },
      status: "failed",
      attempts: 4,
      maxAttempts: 4,
      lockedBy: "worker-2",
      lastError: `connect failed: postgres://app:fake-pass@db.example.com/main${" and again".repeat(40)}`,
      dedupeKey: `agent_run.execute:${RUN}:approval:${APPROVAL}`,
      nextAttemptAt: day(3),
      createdAt: day(3),
    },
    // Due since January and never taken; and one whose worker's lease ran out.
    {
      id: J_EMAIL,
      orgId: null,
      kind: "email.send",
      payload,
      dedupeKey: "email:canary-address",
      nextAttemptAt: day(4),
      createdAt: day(4),
    },
    {
      id: J_PUSH,
      orgId: LIA,
      kind: "push.send",
      payload,
      status: "processing",
      attempts: 1,
      lockedBy: "worker-3",
      lockedUntil: day(5, 0, 2),
      nextAttemptAt: day(5),
      createdAt: day(5),
    },
    // Not due yet; due a moment ago; and in a worker's hands.
    {
      id: J_LATER,
      orgId: ADA,
      kind: "routine.run",
      payload,
      nextAttemptAt: new Date(now + 3600_000),
      createdAt: day(6),
    },
    { id: J_FRESH, orgId: ADA, kind: "message.posted", payload, nextAttemptAt: fresh, createdAt: day(7) },
    {
      id: J_BUSY,
      orgId: LIA,
      kind: "agent_run.execute",
      payload,
      status: "processing",
      attempts: 1,
      lockedBy: "worker-3",
      lockedUntil: new Date(now + 3600_000),
      dedupeKey: `agent_run.execute:${LIA_RUN}`,
      nextAttemptAt: day(8),
      createdAt: day(8),
    },
  ]);

  // Usage: two API calls of one run, a plan's turn, a call for the workspace, and another workspace's.
  const call = { provider: "anthropic", model: "claude-sonnet-5-5", requestedModel: "claude-sonnet-5-5" };
  await db.insert(schema.usageRecords).values([
    {
      ...call,
      orgId: ADA,
      agentId: DEV,
      runId: RUN,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 1000,
      cacheWriteTokens: 50,
      costNanoUsd: 1_500_000,
      createdAt: day(10, 10, 15),
    },
    {
      ...call,
      orgId: ADA,
      agentId: DEV,
      runId: RUN,
      inputTokens: 200,
      outputTokens: 40,
      costNanoUsd: 2_500_000,
      createdAt: day(10, 10, 45),
    },
    {
      orgId: ADA,
      agentId: DEV,
      provider: "claude_code",
      model: "claude-opus-5",
      requestedModel: "claude-opus-5",
      inputTokens: 5000,
      outputTokens: 700,
      costNanoUsd: 0,
      billedTo: "plan",
      machineId: BOX,
      createdAt: day(11, 9),
    },
    {
      orgId: ADA,
      kind: "router",
      provider: "typesafe",
      model: "jev-1",
      requestedModel: "jev-1",
      inputTokens: 30,
      outputTokens: 0,
      costNanoUsd: 300,
      billedTo: "platform",
      createdAt: day(11, 12),
    },
    {
      ...call,
      orgId: LIA,
      agentId: LIA_DEV,
      runId: LIA_RUN,
      inputTokens: 7,
      outputTokens: 3,
      costNanoUsd: 100_000,
      createdAt: day(12, 1),
    },
  ]);
});

afterAll(() => t.close());

async function ok<T = Record<string, unknown>>(res: Response) {
  if (res.status !== 200) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
const refusal = async (res: Response) => [res.status, ((await res.json()) as { error: { code: string } }).error.code];

type Job = Record<string, unknown> & { id: string };
type JobPage = { jobs: Job[]; next: string | null };
type Spent = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
type Usage = {
  from: string;
  to: string;
  total: Spent;
  groups: (Spent & { group: string | null; billedTo: string })[];
  more: boolean;
};
type Summary = Record<string, unknown> & { oldestDueSeconds: number };

const jobs = async (query = "") => (await ok<JobPage>(await get(`/jobs${query}`))).jobs.map((j) => j.id);
const usage = async (query: string) => ok<Usage>(await get(`/usage?${query}`));
const spent = (calls: number, input: number, output: number, cacheRead = 0, cacheWrite = 0, costUsd = 0) => ({
  calls,
  input,
  output,
  cacheRead,
  cacheWrite,
  costUsd,
});

/** One call of every read here, in each of its forms. Dates are given: a window that ends "now" differs between calls. */
const EVERY_READ = [
  "/jobs?limit=200",
  "/jobs?stuck=true",
  `/jobs?runId=${RUN}`,
  `/jobs?summary=true&${JANUARY}`,
  `/usage?${JANUARY}`,
  ...["agent", "day", "hour", "model", "provider", "payer"].map((by) => `/usage?groupBy=${by}&${JANUARY}`),
  `/usage?orgId=${ADA}&groupBy=agent&${JANUARY}`,
  `/usage?agentId=${DEV}&groupBy=model&${JANUARY}`,
  `/usage?runId=${RUN}&groupBy=hour&to=2026-02-01T00:00:00Z`,
  `/orgs/${ADA}/machines`,
  `/orgs/${LIA}/machines`,
  `/machines/${BOX}`,
  `/machines/${MAC}`,
  `/machines/${REMOVED}`,
];

test("every read answers the read-only token as it does the full one, and nothing without a token", async () => {
  // A count says when it was taken, which differs between two calls.
  const steady = async (res: Response) => {
    const { at: _at, oldestDueSeconds: _age, ...rest } = (await res.json()) as Record<string, unknown>;
    return rest;
  };
  for (const path of EVERY_READ) {
    const [read, full, none] = await Promise.all([get(path), get(path, TOKEN), get(path, null)]);
    expect({ path, read: read.status, full: full.status }).toEqual({ path, read: 200, full: 200 });
    expect(await steady(read)).toEqual(await steady(full));
    expect({ path, answer: await refusal(none) }).toEqual({ path, answer: [401, "unauthorized"] });
  }
});

test("no read carries a job's payload, a password, a computer's secrets, or a field named like a secret", async () => {
  // What is stored, so the check below means something.
  const stored = JSON.stringify([
    await t.db.select().from(schema.outbox),
    await t.db.select().from(schema.machines),
    await t.db.select().from(schema.machineAccounts),
    await t.db.select().from(schema.machineTasks),
    await t.db.select().from(schema.machineHolds),
  ]);
  for (const hidden of HIDDEN) expect({ hidden, stored: stored.includes(hidden) }).toEqual({ hidden, stored: true });
  for (const path of EVERY_READ) {
    const text = await (await get(path)).text();
    for (const hidden of [...HIDDEN, t.config.AGENTES_SECRET]) {
      expect({ path, hidden, leaked: text.includes(hidden) }).toEqual({ path, hidden, leaked: false });
    }
    expect(text).not.toMatch(/"[^"]*(token|password|secret|hash|cipher|key)[^"]*":/i);
  }
});

test("jobs: newest first without their payloads; by workspace, kind, status, run, dates and stuck; in pages", async () => {
  const page = await ok<JobPage>(await get("/jobs"));
  expect(page.next).toBeNull();
  expect(page.jobs.map((j) => j.id)).toEqual([J_BUSY, J_FRESH, J_LATER, J_PUSH, J_EMAIL, J_WOKE, J_RUN, J_POSTED]);
  const woke = page.jobs.find((j) => j.id === J_WOKE);
  expect(String(woke?.lastError)).toHaveLength(300);
  expect(woke).toEqual({
    id: J_WOKE,
    orgId: ADA,
    kind: "agent_run.execute",
    status: "failed",
    attempts: 4,
    maxAttempts: 4,
    nextAttemptAt: day(3).toISOString(),
    lockedUntil: null,
    lockedBy: "worker-2",
    // Cut, with the address's password masked.
    lastError: expect.stringMatching(/^connect failed: postgres:\/\/\*\*\*@db\.example\.com\/main( and again)+/),
    runId: RUN,
    cause: "approval",
    createdAt: day(3).toISOString(),
    completedAt: null,
  });
  expect(page.jobs.map((j) => [j.kind, j.orgId, j.runId, j.cause])).toEqual([
    ["agent_run.execute", LIA, LIA_RUN, null],
    ["message.posted", ADA, null, null],
    ["routine.run", ADA, null, null],
    ["push.send", LIA, null, null],
    ["email.send", null, null, null],
    ["agent_run.execute", ADA, RUN, "approval"],
    ["agent_run.execute", ADA, RUN, null],
    ["message.posted", ADA, null, null],
  ]);
  expect(page.jobs.find((j) => j.id === J_PUSH)).toMatchObject({
    status: "processing",
    lockedUntil: day(5, 0, 2).toISOString(),
    completedAt: null,
  });
  expect(page.jobs.at(-1)).toMatchObject({ status: "done", completedAt: day(1, 0, 1).toISOString() });

  expect(await jobs(`?orgId=${ADA}`)).toEqual([J_FRESH, J_LATER, J_WOKE, J_RUN, J_POSTED]);
  expect(await jobs(`?orgId=${UNKNOWN}`)).toEqual([]);
  expect(await jobs("?kind=agent_run.execute")).toEqual([J_BUSY, J_WOKE, J_RUN]);
  expect(await jobs("?kind=nothing.queues.this")).toEqual([]);
  expect(await jobs("?status=pending")).toEqual([J_FRESH, J_LATER, J_EMAIL]);
  expect(await jobs(`?status=failed&orgId=${ADA}`)).toEqual([J_WOKE]);
  expect(await jobs(`?runId=${RUN}`)).toEqual([J_WOKE, J_RUN]);
  expect(await jobs(`?runId=${UNKNOWN}`)).toEqual([]);
  // Due for months and never taken, and a lease that ran out; not the one due a moment ago, the one not due yet,
  // nor the one a worker holds.
  expect(await jobs("?stuck=true")).toEqual([J_PUSH, J_EMAIL]);
  expect(await jobs(`?stuck=true&orgId=${LIA}`)).toEqual([J_PUSH]);
  expect(await jobs("?stuck=false")).toHaveLength(8);
  expect(await jobs(`?from=${day(5).toISOString()}&to=${day(7).toISOString()}`)).toEqual([J_LATER, J_PUSH]);

  // Every job exactly once, three at a time.
  const paged: string[] = [];
  let cursor: string | null = null;
  do {
    const part: JobPage = await ok<JobPage>(await get(`/jobs?limit=3${cursor ? `&cursor=${cursor}` : ""}`));
    expect(part.jobs.length).toBeLessThanOrEqual(3);
    paged.push(...part.jobs.map((j) => j.id));
    cursor = part.next;
  } while (cursor);
  expect(paged).toEqual(page.jobs.map((j) => j.id));

  expect(await refusal(await get("/jobs?cursor=nope"))).toEqual([400, "invalid_cursor"]);
  for (const bad of ["status=asleep", "limit=0", "limit=201", "orgId=7", "runId=7", "stuck=maybe", "from=yesterday"]) {
    expect({ bad, status: (await get(`/jobs?${bad}`)).status }).toEqual({ bad, status: 400 });
  }
});

test("a page of jobs continues from the stored time itself, in an order an index on it serves", async () => {
  // Queued within one millisecond: a cursor cut to milliseconds would repeat or skip one of them.
  const close = [9, 10, 11].map(job);
  await t.db.execute(sql`insert into outbox (id, kind, payload, created_at) values
    (${close[0]}, 'test.close', '{}', '2026-01-20T00:00:00.000100Z'),
    (${close[1]}, 'test.close', '{}', '2026-01-20T00:00:00.000200Z'),
    (${close[2]}, 'test.close', '{}', '2026-01-20T00:00:00.000300Z')`);
  const paged: string[] = [];
  // The plan, not a time: the page after a cursor walks the index on `(created_at, id)` and sorts nothing.
  const plan = await planOfLast(
    t,
    "outbox",
    async () => {
      let cursor: string | null = null;
      do {
        const path = `/jobs?kind=test.close&limit=1${cursor ? `&cursor=${cursor}` : ""}`;
        const part: JobPage = await ok<JobPage>(await get(path));
        paged.push(...part.jobs.map((j) => j.id));
        cursor = part.next;
      } while (cursor);
    },
    ["enable_sort"],
  );
  await t.db.delete(schema.outbox).where(eq(schema.outbox.kind, "test.close"));

  expect(paged).toEqual([...close].reverse());
  expect(plan).toMatch(
    /Index Scan Backward using outbox_created_idx on outbox\s+Index Cond: \(ROW\(created_at, id\) < /,
  );
  expect(plan).not.toContain("Sort");
});

test("a run's jobs are found by how their name starts, through the index of run jobs alone", async () => {
  const plan = await planOfLast(t, "outbox", () => get(`/jobs?runId=${RUN}`));
  // `~>=~` and `~<~` compare bytes: the range holds in a database of any collation.
  expect(plan).toMatch(
    /Index Scan using outbox_run_jobs_idx on outbox\s+Index Cond: \(\(dedupe_key ~>=~ .+ AND \(dedupe_key ~<~ /,
  );
});

test("jobs in counts: by kind and status, with since when the oldest one due has waited", async () => {
  const count = (kind: string, status: string, oldestDueAt: string | null = null) => ({
    kind,
    status,
    jobs: 1,
    oldestDueAt,
  });
  const all = await ok<Summary>(await get("/jobs?summary=true"));
  expect(all.oldestDueSeconds).toBeGreaterThan(86_400);
  expect(all).toEqual({
    at: TIME,
    counts: [
      count("agent_run.execute", "processing"),
      count("agent_run.execute", "done"),
      count("agent_run.execute", "failed"),
      count("email.send", "pending", day(4).toISOString()),
      count("message.posted", "pending", fresh.toISOString()),
      count("message.posted", "done"),
      count("push.send", "processing"),
      // Not due yet: it waits for its time, not for a worker.
      count("routine.run", "pending"),
    ],
    more: false,
    oldestDueAt: day(4).toISOString(),
    oldestDueSeconds: expect.any(Number),
  });

  const ada = await ok<Summary>(await get(`/jobs?summary=true&orgId=${ADA}&status=pending`));
  expect(ada.oldestDueSeconds).toBeLessThan(600);
  expect(ada).toMatchObject({
    counts: [count("message.posted", "pending", fresh.toISOString()), count("routine.run", "pending")],
    oldestDueAt: fresh.toISOString(),
  });
  expect(await ok(await get("/jobs?summary=true&stuck=true"))).toMatchObject({
    counts: [count("email.send", "pending", day(4).toISOString()), count("push.send", "processing")],
  });
  expect(await ok(await get(`/jobs?summary=true&orgId=${UNKNOWN}`))).toEqual({
    at: TIME,
    counts: [],
    more: false,
    oldestDueAt: null,
    oldestDueSeconds: null,
  });
  expect((await get("/jobs?summary=perhaps")).status).toBe(400);
});

test("usage: in all and by group, of the instance, a workspace, an agent or a run", async () => {
  expect(await usage(JANUARY)).toEqual({
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-02-01T00:00:00.000Z",
    total: spent(5, 5337, 763, 1000, 50, 0.0041),
    groups: [],
    more: false,
  });
  // The last 7 days unless said: nothing of January.
  expect(await usage("")).toEqual({ from: TIME, to: TIME, total: spent(0, 0, 0), groups: [], more: false });

  const ada = await usage(`orgId=${ADA}&groupBy=agent&${JANUARY}`);
  expect(ada.total).toEqual(spent(4, 5330, 760, 1000, 50, 0.004));
  // Most tokens first; an agent on a plan and on an API is two rows; the router's call is nobody's.
  expect(ada.groups).toEqual([
    { group: DEV, billedTo: "plan", ...spent(1, 5000, 700) },
    { group: DEV, billedTo: "org", ...spent(2, 300, 60, 1000, 50, 0.004) },
    { group: null, billedTo: "platform", ...spent(1, 30, 0) },
  ]);
  const groups = async (query: string) => (await usage(`${query}&${JANUARY}`)).groups.map((g) => [g.group, g.calls]);
  expect(await groups(`orgId=${ADA}&groupBy=day`)).toEqual([
    ["2026-01-10", 2],
    ["2026-01-11", 1],
    ["2026-01-11", 1],
  ]);
  expect(await groups("groupBy=hour")).toEqual([
    ["2026-01-10T10:00:00.000Z", 2],
    ["2026-01-11T09:00:00.000Z", 1],
    ["2026-01-11T12:00:00.000Z", 1],
    ["2026-01-12T01:00:00.000Z", 1],
  ]);
  expect(await groups("groupBy=model")).toEqual([
    ["claude-opus-5", 1],
    ["claude-sonnet-5-5", 3],
    ["jev-1", 1],
  ]);
  expect(await groups("groupBy=provider")).toEqual([
    ["claude_code", 1],
    ["anthropic", 3],
    ["typesafe", 1],
  ]);
  expect(await groups("groupBy=payer")).toEqual([
    ["plan", 1],
    ["org", 3],
    ["platform", 1],
  ]);
  expect(await groups(`agentId=${DEV}&groupBy=payer`)).toEqual([
    ["plan", 1],
    ["org", 2],
  ]);
  expect(await usage(`groupBy=agent&limit=1&${JANUARY}`)).toMatchObject({
    groups: [{ group: DEV, billedTo: "plan" }],
    more: true,
  });

  // One run's, from when it began.
  expect(await usage(`runId=${RUN}&groupBy=model&to=2026-02-01T00:00:00Z`)).toEqual({
    from: day(10, 10).toISOString(),
    to: "2026-02-01T00:00:00.000Z",
    total: spent(2, 300, 60, 1000, 50, 0.004),
    groups: [{ group: "claude-sonnet-5-5", billedTo: "org", ...spent(2, 300, 60, 1000, 50, 0.004) }],
    more: false,
  });
  expect((await usage(`runId=${RUN}&orgId=${ADA}&agentId=${DEV}`)).total.calls).toBe(2);
  expect((await usage(`runId=${RUN}&from=${day(10, 10, 30).toISOString()}`)).total.calls).toBe(1);

  for (const none of [
    `orgId=${UNKNOWN}`,
    `agentId=${UNKNOWN}`,
    `runId=${UNKNOWN}`,
    `agentId=${DEV}&orgId=${LIA}`,
    `runId=${RUN}&orgId=${LIA}`,
    `runId=${RUN}&agentId=${LIA_DEV}`,
  ]) {
    expect({ none, answer: await refusal(await get(`/usage?${none}`)) }).toEqual({
      none,
      answer: [404, "not_found"],
    });
  }
  for (const bad of [
    "from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z",
    "from=2026-01-01T00:00:00Z&to=2026-04-02T00:00:00Z",
    "from=2026-01-01T00:00:00Z",
    "groupBy=week",
    "limit=0",
    "limit=201",
    "orgId=7",
    "to=tomorrow",
  ]) {
    expect({ bad, status: (await get(`/usage?${bad}`)).status }).toEqual({ bad, status: 400 });
  }
});

test("computers: what its runner found, its AI accounts, and how much is open on it, kept running and waiting", async () => {
  const box = {
    id: BOX,
    orgId: ADA,
    kind: "managed",
    managed: true,
    name: "Box",
    online: true,
    lastSeenAt: TIME,
    runnerVersion: "1.2.3",
    protocol: 50,
    standby: false,
    // A run of the workspace is queued.
    busy: true,
    lastUsedAt: TIME,
    executors: [
      { name: "browser", version: "0.9.1" },
      { name: "claude", version: "2.0.31 (Claude Code)" },
      { name: "codex", version: "codex-cli 0.46.0" },
      // Not a plain version line.
      { name: "cursor", version: null },
    ],
    // Most recently used first.
    accounts: [
      {
        id: SHARED,
        kind: "claude_code",
        provider: null,
        authMethod: null,
        plan: null,
        status: "active",
        statusUnknown: false,
        shared: true,
        lastSuccessAt: day(20).toISOString(),
        lastFailureCause: null,
        lastFailureAt: null,
      },
      {
        id: ACCOUNT,
        kind: "claude_code",
        provider: null,
        authMethod: "setup_token",
        plan: "max",
        status: "signed_out",
        statusUnknown: false,
        shared: false,
        lastSuccessAt: null,
        lastFailureCause: "auth_rejected",
        lastFailureAt: day(21).toISOString(),
      },
    ],
    accountCount: 2,
    // Queued, running, and interrupted without an end; live with no end time and with one ahead; in its line.
    openTasks: 3,
    holds: 2,
    waitingRuns: 1,
    deletedAt: null,
  };
  const mac = {
    id: MAC,
    orgId: ADA,
    kind: "connected",
    managed: false,
    name: "Mac",
    online: false,
    lastSeenAt: null,
    runnerVersion: "",
    protocol: 1,
    standby: false,
    busy: false,
    lastUsedAt: null,
    executors: [],
    accounts: [],
    accountCount: 0,
    openTasks: 0,
    holds: 0,
    waitingRuns: 0,
    deletedAt: null,
  };
  expect(await ok(await get(`/orgs/${ADA}/machines`))).toEqual({
    machines: [box, mac],
    provisioning: {
      state: "ready",
      step: null,
      stage: null,
      reason: null,
      since: day(2).toISOString(),
      requestedAt: day(1).toISOString(),
      expectedReadyAt: null,
      specs: { cpus: 4, memoryGb: 8, diskGb: 100 },
    },
  });
  expect(await ok(await get(`/orgs/${LIA}/machines`))).toEqual({ machines: [], provisioning: null });

  expect(await ok(await get(`/machines/${BOX}`))).toEqual(box);
  expect(await ok(await get(`/machines/${MAC}`))).toEqual(mac);
  // A removed one is in no list, and still answers by its id.
  expect(await ok(await get(`/machines/${REMOVED}`))).toEqual({
    ...mac,
    id: REMOVED,
    name: "Old laptop",
    deletedAt: day(9).toISOString(),
  });

  expect(await refusal(await get(`/orgs/${UNKNOWN}/machines`))).toEqual([404, "not_found"]);
  expect(await refusal(await get(`/machines/${UNKNOWN}`))).toEqual([404, "not_found"]);
  expect((await get("/machines/7")).status).toBe(400);
});

test("the OpenAPI document lists the reads", async () => {
  const doc = await ok<{ paths: Record<string, Record<string, unknown>> }>(await get("/openapi.json"));
  for (const path of ["/jobs", "/usage", "/machines/{machineId}", "/orgs/{orgId}/machines"]) {
    expect({ path, get: Boolean(doc.paths[path]?.get) }).toEqual({ path, get: true });
  }
});
