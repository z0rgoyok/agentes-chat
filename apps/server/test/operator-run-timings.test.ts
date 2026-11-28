import { afterAll, beforeAll, expect, test } from "bun:test";
import { rowsOf, schema, sql } from "@agenteschat/db";
import { conditionWords, issuedBy } from "@agenteschat/db/testing";
import { operatorRunTimings, recordRunBrain } from "@agenteschat/engine";
import { createLogger } from "../src/logger";
import { createOperatorApp } from "../src/operator/app";
import { createTestServer, type TestServer } from "./harness";

/**
 * Where a run's time went, for the operator API: a trace's `claims`, `GET /analytics/run-timings`, and beside them
 * an AI account's plan readings. All three read JSON the server stored (`agent_runs.profiles`,
 * `machine_accounts.usage`): each test stores it as it may be found, and reads what comes out.
 */

const TOKEN = "operator-test-token-".padEnd(48, "x");
const READ = "operator-read-token-".padEnd(48, "x");
const UNKNOWN = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";

let t: TestServer;
let get: (path: string, token?: string | null) => Promise<Response>;
let ada: string;
let lia: string;
/** Two agents of Ada Labs and one of Lia Studio. */
let ada1: string;
let ada2: string;
let lia1: string;
let adaChannel: string;
let adaBox: string;

// Each test has a UTC day of its own, so no test's runs are in another's window.
const day = (n: number) => Date.parse(`2026-10-${String(n).padStart(2, "0")}T00:00:00.000Z`);
const DAY = 86_400_000;
const windowOf = (n: number) => `from=${new Date(day(n)).toISOString()}&to=${new Date(day(n) + DAY).toISOString()}`;

type Run = Partial<typeof schema.agentRuns.$inferInsert> & { createdAt: Date };
/** A run as stored: `profiles` may hold anything, as the column does. */
async function run({ profiles, ...values }: Omit<Run, "profiles"> & { profiles?: unknown }) {
  const root = crypto.randomUUID();
  const [made] = await t.db
    .insert(schema.agentRuns)
    .values({
      orgId: ada,
      agentId: ada1,
      channelId: adaChannel,
      threadRootId: root,
      triggerMessageId: root,
      trigger: "mention",
      hop: 1,
      status: "done",
      profiles: profiles as unknown[],
      ...values,
    })
    .returning({ id: schema.agentRuns.id, orgId: schema.agentRuns.orgId, threadRootId: schema.agentRuns.threadRootId });
  if (!made) throw new Error("no run");
  return made;
}
const step = (
  of: { id: string; orgId: string },
  seq: number,
  kind: "error" | "model_call" | "context",
  data: Record<string, unknown>,
  at: Date,
) => t.db.insert(schema.agentRunSteps).values({ orgId: of.orgId, runId: of.id, seq, kind, data, createdAt: at });
const stages = (...ms: number[]) => ms.map((n, i) => ({ stage: `model#${i + 1}`, ms: n, queries: 0 }));
const claim = (list: { stage: unknown; ms: unknown; queries: unknown }[], more: Record<string, unknown> = {}) => ({
  stages: list,
  total: { ms: 0, queries: 0 },
  ...more,
});

async function ok<T = Record<string, unknown>>(res: Response) {
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}
const refusal = async (res: Response) => [res.status, ((await res.json()) as { error: { code: string } }).error.code];

type Rows = Record<string, unknown>[];
type Timings = {
  from: string;
  to: string;
  by: string;
  runs: number;
  profiled: number;
  stages: Rows;
  stagesMore: boolean;
  computerStarts: Rows;
  coldStarts: Rows;
  waits: Rows;
};
const timings = async (query: string) => ok<Timings>(await get(`/analytics/run-timings?${query}`));
type Claim = {
  endedAt: string | null;
  totalMs: number;
  queries: number;
  stages: { stage: string; ms: number; queries: number; parts?: { stage: string; ms: number; queries: number }[] }[];
  stagesCut: boolean;
  computerTurns: ({ warm: boolean } & Record<string, string | number | null | boolean>)[];
  turns: Record<string, unknown>[];
  slow: Record<string, unknown>[];
  waterfall: { span: string; startMs: number; ms: number }[];
};
// A turn's measures past the three every runner gives, none of them said.
const unsaid = {
  cold: null,
  sentMs: null,
  firstRequestMs: null,
  toolsListMs: null,
  toolsListWaitMs: null,
  warmMismatchAt: null,
  firstTokenMs: null,
  firstAssistantMs: null,
  retries: null,
  retryDelayMs: null,
  thinkingBlocks: null,
  thinkingChars: null,
};
// A window's computer starts with none of those either.
const noModelTimes = {
  firstRequestMedianMs: null,
  firstRequestP90Ms: null,
  apiWaitMedianMs: null,
  apiWaitP90Ms: null,
  firstTokenMedianMs: null,
  firstTokenP90Ms: null,
  firstAssistantMedianMs: null,
  firstAssistantP90Ms: null,
  retriedTurns: 0,
  retries: 0,
  retryDelayMs: 0,
  thinkingCharsMedian: null,
  thinkingCharsP90: null,
};
type Trace = { run: { error: string | null }; claims: Claim[] };
const trace = async (runId: string) => ok<Trace>(await get(`/runs/${runId}/trace`));
type Account = { id: string; usage: Record<string, unknown> | null };
const accounts = async () => (await ok<{ accounts: Account[] }>(await get(`/ai-accounts?orgId=${ada}`))).accounts;

beforeAll(async () => {
  t = await createTestServer({ env: { OPERATOR_API_TOKEN: TOKEN } });
  const app = createOperatorApp(
    { db: t.db, config: t.config, version: "test", log: createLogger("error") },
    TOKEN,
    READ,
  );
  get = async (path, token = READ) =>
    app.request(`/api/operator/v1${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const orgs = await t.db
    .insert(schema.organizations)
    .values([{ name: "Ada Labs" }, { name: "Lia Studio" }])
    .returning({ id: schema.organizations.id });
  ada = orgs[0]?.id ?? "";
  lia = orgs[1]?.id ?? "";
  const agents = await t.db
    .insert(schema.agents)
    .values([
      { orgId: ada, name: "One", handle: "one", model: "x" },
      { orgId: ada, name: "Two", handle: "two", model: "x" },
      { orgId: lia, name: "One", handle: "one", model: "x" },
    ])
    .returning({ id: schema.agents.id });
  [ada1, ada2, lia1] = agents.map((a) => a.id) as [string, string, string];
  const [channel] = await t.db
    .insert(schema.channels)
    .values({ orgId: ada, name: "general" })
    .returning({ id: schema.channels.id });
  adaChannel = channel?.id ?? "";
  const [box] = await t.db
    .insert(schema.machines)
    .values({ orgId: ada, name: "Box", protocol: 50 })
    .returning({ id: schema.machines.id });
  adaBox = box?.id ?? "";
});

afterAll(() => t.close());

/** An AI account whose stored `usage` is exactly `usage`. */
async function account(usage: unknown) {
  const id = crypto.randomUUID();
  await t.db
    .insert(schema.machineAccounts)
    .values({ id, orgId: ada, machineId: adaBox, kind: "claude_code", label: "Claude" });
  await t.db.execute(
    sql`update machine_accounts set usage = ${JSON.stringify(usage)}::jsonb where id = ${id} and org_id = ${ada}`,
  );
  return id;
}

test("stages: percentiles per brain, the window's two edges, and what orgId, agentId and by=model each cut", async () => {
  const from = day(1);
  const at = (ms: number) => new Date(from + ms);
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  const sonnet = await run({ createdAt: at(0), brain: "claude_code", profiles: [claim(stages(...hundred))] });
  await step(sonnet, 1, "model_call", { model: "claude-sonnet-5-5" }, at(1));
  const opus = await run({
    createdAt: at(1000),
    agentId: ada2,
    brain: "claude_code",
    profiles: [claim([{ stage: "context", ms: 40, queries: 3 }])],
  });
  await step(opus, 1, "model_call", { model: "claude-haiku-5" }, at(1001));
  await step(opus, 2, "model_call", { model: "claude-opus-5" }, at(1002));
  // The window's last millisecond.
  await run({ createdAt: at(DAY - 1), agentId: ada2, brain: "codex", profiles: [claim(stages(1000, 3000))] });
  await run({ createdAt: at(2000), orgId: lia, agentId: lia1, brain: "model", profiles: [claim(stages(5000))] });
  // No turn yet, nothing kept.
  await run({ createdAt: at(3000) });
  // A millisecond outside each edge: neither is counted.
  for (const outside of [at(-1), at(DAY)]) {
    await run({ createdAt: outside, brain: "claude_code", profiles: [claim(stages(9_000_000))] });
  }

  const row = (brain: string, stage: string, count: number, ...ms: number[]) => ({
    brain,
    model: null as string | null,
    stage,
    count,
    medianMs: ms[0],
    p90Ms: ms[1],
    p99Ms: ms[2],
    maxMs: ms[3],
  });
  const all = await timings(windowOf(1));
  expect({ from: all.from, to: all.to, by: all.by, runs: all.runs, profiled: all.profiled }).toEqual({
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-10-02T00:00:00.000Z",
    by: "brain",
    runs: 5,
    profiled: 4,
  });
  // 1..100: the median is between 50 and 51, and each brain keeps its own. Within a brain the slowest median first.
  expect(all.stages).toEqual([
    row("claude_code", "model", 100, 51, 90, 99, 100),
    row("claude_code", "context", 1, 40, 40, 40, 40),
    row("codex", "model", 2, 2000, 2800, 2980, 3000),
    row("model", "model", 1, 5000, 5000, 5000, 5000),
  ]);
  expect(all.stagesMore).toBe(false);

  const ofAda = await timings(`${windowOf(1)}&orgId=${ada}`);
  expect([ofAda.runs, ofAda.profiled, ofAda.stages.map((s) => s.brain)]).toEqual([
    4,
    3,
    ["claude_code", "claude_code", "codex"],
  ]);
  const ofOne = await timings(`${windowOf(1)}&orgId=${ada}&agentId=${ada1}`);
  expect([ofOne.runs, ofOne.profiled, ofOne.stages]).toEqual([
    2,
    1,
    [row("claude_code", "model", 100, 51, 90, 99, 100)],
  ]);
  expect((await timings(`${windowOf(1)}&orgId=${UNKNOWN}`)).runs).toBe(0);

  // Per model: the run's latest turn's, null for a run with none.
  const byModel = await timings(`${windowOf(1)}&by=model`);
  expect(byModel.by).toBe("model");
  expect(byModel.stages.map((s) => [s.brain, s.model, s.stage, s.count])).toEqual([
    ["claude_code", "claude-opus-5", "context", 1],
    ["claude_code", "claude-sonnet-5-5", "model", 100],
    ["codex", null, "model", 2],
    ["model", null, "model", 1],
  ]);
});

test("computer starts and waits: per brain, each wait until the run's next step, its end, or the window's", async () => {
  const from = day(2);
  const at = (sec: number) => new Date(from + sec * 1000);
  const busy = { reason: "brain_unavailable", code: "busy" };
  const waited = await run({
    createdAt: at(0),
    brain: "claude_code",
    profiles: [
      claim(stages(10), {
        brain: [
          {
            warm: false,
            cold: "new_session",
            initMs: 4000,
            firstEventMs: 6000,
            firstRequestMs: 4200,
            firstTokenMs: 5000,
            firstAssistantMs: 9000,
            retries: 2,
            retryDelayMs: 1500,
            thinkingBlocks: 1,
            thinkingChars: 300,
          },
          // The API answered 2.9 s after the CLI asked: the wait is the API's and the network's, not the CLI's.
          {
            warm: true,
            firstEventMs: 800,
            firstRequestMs: 100,
            firstTokenMs: 3000,
            retries: 0,
            thinkingBlocks: 1,
            thinkingChars: 100,
          },
          { warm: true, firstEventMs: 200 },
        ],
      }),
    ],
  });
  await step(waited, 1, "error", busy, at(10));
  await step(waited, 2, "context", { roomFound: true }, at(70));
  await step(waited, 3, "error", busy, at(100));
  await step(waited, 4, "model_call", { model: "claude-sonnet-5-5" }, at(130));
  // No next step: until the run's end.
  const ended = await run({ createdAt: at(0), brain: "claude_code", finishedAt: at(210) });
  await step(ended, 1, "error", { reason: "brain_unavailable", code: "machine_paused" }, at(200));
  // A provider's outage is no wait for a computer: in no row.
  const outage = await run({ createdAt: at(0), brain: "model", finishedAt: at(400) });
  await step(outage, 1, "error", { reason: "provider_outage", message: "x" }, at(300));
  // Neither: until the window's end, which is before now.
  const open = await run({ createdAt: at(0), brain: "codex", status: "waiting_input" });
  await step(open, 1, "error", { reason: "brain_unavailable", code: "machine_offline" }, new Date(from + DAY - 45_000));
  // Another error is no wait.
  await step(open, 2, "error", { reason: "transient", code: "run.provider_rate_limit" }, new Date(from + DAY - 1000));

  const found = await timings(windowOf(2));
  expect(found.computerStarts).toEqual([
    {
      brain: "claude_code",
      model: null,
      turns: 3,
      warm: 2,
      initMedianMs: 4000,
      initP90Ms: 4000,
      initP99Ms: 4000,
      warmFirstEventMedianMs: 500,
      warmFirstEventP90Ms: 740,
      warmFirstEventP99Ms: 794,
      coldFirstEventMedianMs: 6000,
      coldFirstEventP90Ms: 6000,
      coldFirstEventP99Ms: 6000,
      firstRequestMedianMs: 2150,
      firstRequestP90Ms: 3790,
      apiWaitMedianMs: 1850,
      apiWaitP90Ms: 2690,
      firstTokenMedianMs: 4000,
      firstTokenP90Ms: 4800,
      firstAssistantMedianMs: 9000,
      firstAssistantP90Ms: 9000,
      retriedTurns: 1,
      retries: 2,
      retryDelayMs: 1500,
      thinkingCharsMedian: 200,
      thinkingCharsP90: 280,
    },
  ]);
  // Why the cold one started its process.
  expect(found.coldStarts).toEqual([{ brain: "claude_code", model: null, cause: "new_session", turns: 1 }]);
  const wait = (brain: string, cause: string, waits: number, runs: number, ...sec: number[]) => ({
    cause,
    brain,
    model: null as string | null,
    waits,
    runs,
    medianSec: sec[0],
    p90Sec: sec[1],
    p99Sec: sec[2],
    totalSec: sec[3],
  });
  expect(found.waits).toEqual([
    wait("claude_code", "brain_unavailable:busy", 2, 1, 45, 57, 60, 90),
    wait("claude_code", "brain_unavailable:machine_paused", 1, 1, 10, 10, 10, 10),
    // Its second step came a second before the window's end: the wait ended there.
    wait("codex", "brain_unavailable:machine_offline", 1, 1, 44, 44, 44, 44),
  ]);
  expect((await timings(`${windowOf(2)}&by=model`)).waits.map((w) => [w.cause, w.brain, w.model])).toEqual([
    ["brain_unavailable:busy", "claude_code", "claude-sonnet-5-5"],
    ["brain_unavailable:machine_paused", "claude_code", null],
    ["brain_unavailable:machine_offline", "codex", null],
  ]);

  // A wait still open is counted to now while the window is not over, and never as less than nothing.
  const later = day(3);
  const still = await run({ createdAt: new Date(later), brain: "grok", status: "waiting_input" });
  await step(still, 1, "error", busy, new Date(later + 60_000));
  const read = (now: number) =>
    operatorRunTimings(
      t.db,
      { from: new Date(later).toISOString(), to: new Date(later + DAY).toISOString() },
      new Date(now),
    );
  expect((await read(later + 100_000)).waits.map((w) => w.totalSec)).toEqual([40]);
  expect((await read(later + 2 * DAY)).waits.map((w) => w.totalSec)).toEqual([DAY / 1000 - 60]);
  expect((await read(later + 1000)).waits.map((w) => w.totalSec)).toEqual([0]);
});

test("nothing anyone wrote comes out as words: a stage, a brain, a cause, a model and a window's kind", async () => {
  const from = day(5);
  const written = await run({
    createdAt: new Date(from),
    brain: "a brain nobody listed",
    profiles: [
      claim([
        { stage: "Write to ada@example.com about the invoice", ms: 7, queries: 1 },
        { stage: "claim", ms: 3, queries: 1 },
        // Shaped almost like the server's own.
        { stage: "Claim", ms: 1, queries: 0 },
        { stage: "model#123456", ms: 1, queries: 0 },
        { stage: `a${"z".repeat(40)}`, ms: 1, queries: 0 },
      ]),
    ],
  });
  await step(written, 1, "error", { reason: "brain_unavailable", code: "ask ada@example.com" }, new Date(from + 1000));
  await step(written, 2, "model_call", { model: "the model ada@example.com likes" }, new Date(from + 2000));
  const accountId = await account({
    windows: [{ kind: "The window of ada@example.com", label: "ada@example.com", usedPercent: 40 }],
    source: "turn",
    at: new Date(from).toISOString(),
  });

  const traced = await get(`/runs/${written.id}/trace`);
  const timed = await get(`/analytics/run-timings?${windowOf(5)}&by=model`);
  const listed = await get(`/ai-accounts?orgId=${ada}`);
  const texts = await Promise.all([traced, timed, listed].map((res) => res.clone().text()));
  for (const text of texts) {
    for (const word of ["example.com", "invoice", "likes", "window of", "Claim", "#123456", "zzzz"]) {
      expect(text).not.toContain(word);
    }
  }
  // A run's own row says its brain as stored, which only the server writes: the timings group by it, so they check it.
  expect(texts[1]).not.toContain("nobody listed");

  expect((await ok<Trace>(traced)).claims[0]?.stages).toEqual([
    { stage: "other", ms: 7, queries: 1 },
    { stage: "claim", ms: 3, queries: 1 },
    { stage: "other", ms: 1, queries: 0 },
    { stage: "other", ms: 1, queries: 0 },
    { stage: "other", ms: 1, queries: 0 },
  ]);
  const { stages: timedStages, waits } = await ok<Timings>(timed);
  expect(timedStages.map((s) => [s.brain, s.model, s.stage, s.count])).toEqual([
    ["other", null, "claim", 1],
    ["other", null, "other", 4],
  ]);
  expect(waits.map((w) => [w.cause, w.brain, w.model, w.waits])).toEqual([["other", "other", null, 1]]);
  const { accounts: rows } = await ok<{ accounts: Account[] }>(listed);
  expect(rows.find((a) => a.id === accountId)?.usage).toEqual({
    limited: false,
    checkedAt: null,
    windows: [{ kind: "other", usedPercent: 40, resetsAt: null, at: null }],
  });
});

test("a stored row of the wrong shape breaks no answer: what can't be read is skipped", async () => {
  const from = day(7);
  const at = new Date(from);
  const odd = { createdAt: at, brain: "grok" };
  const text = await run({ ...odd, profiles: "words where a list belongs" });
  const object = await run({ ...odd, profiles: { stages: [{ stage: "claim", ms: 5, queries: 0 }] } });
  const noClaims = await run({ ...odd, profiles: ["text", 7, null, [{ stages: [] }]] });
  const mixed = await run({
    ...odd,
    profiles: [
      { stages: "nope" },
      { stages: { stage: "claim", ms: 5 }, total: 7 },
      { brain: "nope", endedAt: "yesterday" },
      {
        endedAt: 12,
        total: { ms: "x", queries: -1 },
        stages: [
          { stage: "claim", ms: "12", queries: 1 },
          { stage: "claim", ms: -5, queries: 1 },
          { stage: "claim", ms: 86_400_001, queries: 1 },
          { stage: "claim", ms: 1e300, queries: 1 },
          { stage: "claim", ms: null, queries: 1 },
          { stage: "claim", queries: 1 },
          "text",
          null,
          7,
          [{ stage: "claim", ms: 5, queries: 0 }],
          { stage: 7, ms: 20, queries: "many" },
          // A whole day is the most a stage is believed to last.
          { stage: "claim", ms: 86_400_000, queries: -1 },
          { stage: "claim", ms: 10.4, queries: 1e300 },
          { stage: "claim", ms: 0, queries: 2 },
        ],
        brain: [
          { warm: "yes", initMs: 5, firstEventMs: 5 },
          7,
          null,
          "text",
          [{ warm: true }],
          { warm: false, initMs: "5", firstEventMs: -1 },
          { warm: false, initMs: 1e300, firstEventMs: 900 },
          { warm: true, initMs: 86_400_001, firstEventMs: 100 },
        ],
      },
    ],
  });
  // Numbers JSON can hold and a float can't.
  const huge = await run({ ...odd });
  await t.db.execute(
    sql`update agent_runs set profiles = ${'[{"stages":[{"stage":"claim","ms":1e400,"queries":1e400}],"total":{"ms":1e400,"queries":1e400},"brain":[{"warm":false,"initMs":1e400,"firstEventMs":-1e400}]}]'}::jsonb where id = ${huge.id}`,
  );

  const found = await timings(windowOf(7));
  expect([found.runs, found.profiled]).toEqual([5, 2]);
  expect(found.stages).toEqual([
    { brain: "grok", model: null, stage: "other", count: 1, medianMs: 20, p90Ms: 20, p99Ms: 20, maxMs: 20 },
    {
      brain: "grok",
      model: null,
      stage: "claim",
      count: 3,
      medianMs: 10,
      p90Ms: 69120002,
      p99Ms: 84672000,
      maxMs: 86400000,
    },
  ]);
  expect(found.computerStarts).toEqual([
    {
      brain: "grok",
      model: null,
      turns: 4,
      warm: 1,
      initMedianMs: null,
      initP90Ms: null,
      initP99Ms: null,
      warmFirstEventMedianMs: 100,
      warmFirstEventP90Ms: 100,
      warmFirstEventP99Ms: 100,
      coldFirstEventMedianMs: 900,
      coldFirstEventP90Ms: 900,
      coldFirstEventP99Ms: 900,
      ...noModelTimes,
    },
  ]);

  const traced = { turns: [], slow: [], waterfall: expect.any(Array) };
  const none = { endedAt: null, totalMs: 0, queries: 0, stages: [], stagesCut: false, computerTurns: [], ...traced };
  for (const empty of [text, object, noClaims]) expect((await trace(empty.id)).claims).toEqual([]);
  expect((await trace(mixed.id)).claims).toEqual([
    none,
    none,
    none,
    {
      endedAt: null,
      // Its own total can't be read: its stages' are added up.
      totalMs: 86_400_030,
      queries: 2,
      stages: [
        { stage: "other", ms: 20, queries: 0 },
        { stage: "claim", ms: 86_400_000, queries: 0 },
        { stage: "claim", ms: 10, queries: 0 },
        { stage: "claim", ms: 0, queries: 2 },
      ],
      stagesCut: false,
      computerTurns: [
        { warm: false, initMs: null, firstEventMs: null, ...unsaid },
        { warm: false, initMs: null, firstEventMs: 900, ...unsaid },
        { warm: true, initMs: null, firstEventMs: 100, ...unsaid },
      ],
      ...traced,
    },
  ]);
  expect((await trace(huge.id)).claims).toEqual([
    { ...none, computerTurns: [{ warm: false, initMs: null, firstEventMs: null, ...unsaid }] },
  ]);

  const window = (n: number) => ({ kind: "five_hour", usedPercent: n });
  const ids = [
    await account("words where a record belongs"),
    await account([{ windows: [window(1)] }]),
    await account({ windows: "no", limited: "yes", checkedAt: "soon" }),
    await account({
      limited: true,
      checkedAt: "2026-10-05T12:00:00+02:00",
      windows: [
        "text",
        null,
        7,
        [window(1)],
        { kind: 5, usedPercent: "40" },
        { kind: "five_hour", usedPercent: -1 },
        { kind: "five_hour", usedPercent: 100.5 },
        { kind: "five_hour", usedPercent: 1e300 },
        { kind: "five_hour" },
        { kind: 5, usedPercent: 40.5, resetsAt: 12, at: "last week" },
        { kind: "monthly", usedPercent: 100, resetsAt: "2026-11-01T00:00:00Z", at: "2026-10-04T12:00:00+02:00" },
        { kind: "seven_day_opus", usedPercent: 0, resetsAt: "next week" },
        ...Array.from({ length: 9 }, (_, n) => window(n + 1)),
      ],
    }),
    await account(null),
  ];
  const usage = new Map((await accounts()).map((a) => [a.id, a.usage]));
  expect(ids.map((id) => usage.get(id))).toEqual([
    null,
    null,
    { limited: false, checkedAt: null, windows: [] },
    {
      limited: true,
      checkedAt: "2026-10-05T10:00:00.000Z",
      // The first 10 it could read.
      windows: [
        { kind: "other", usedPercent: 40.5, resetsAt: null, at: null },
        { kind: "monthly", usedPercent: 100, resetsAt: "2026-11-01T00:00:00.000Z", at: "2026-10-04T10:00:00.000Z" },
        { kind: "seven_day_opus", usedPercent: 0, resetsAt: null, at: null },
        ...Array.from({ length: 7 }, (_, n) => ({ kind: "five_hour", usedPercent: n + 1, resetsAt: null, at: null })),
      ],
    },
    null,
  ]);
});

test("a claim's end and a stage no code here names come through; a claim kept without its end says null", async () => {
  const from = day(9);
  const kept = await run({
    createdAt: new Date(from),
    brain: "claude_code",
    profiles: [
      {
        stages: [
          { stage: "router", ms: 12, queries: 2 },
          { stage: "room_wait", ms: 3400, queries: 0 },
          { stage: "claim", ms: 5, queries: 1 },
          { stage: "turn_end#1", ms: 8, queries: 4 },
        ],
        total: { ms: 3425, queries: 7 },
        endedAt: "2026-10-09T12:00:05.123+02:00",
      },
      { stages: [{ stage: "claim", ms: 4.6, queries: 1 }], total: { ms: 4.6, queries: 1 } },
    ],
  });
  expect((await trace(kept.id)).claims).toEqual([
    {
      endedAt: "2026-10-09T10:00:05.123Z",
      totalMs: 3425,
      queries: 7,
      stages: [
        { stage: "router", ms: 12, queries: 2 },
        { stage: "room_wait", ms: 3400, queries: 0 },
        { stage: "claim", ms: 5, queries: 1 },
        { stage: "turn_end#1", ms: 8, queries: 4 },
      ],
      stagesCut: false,
      computerTurns: [],
      turns: [],
      slow: [],
      // The stages back to back from the claim's start.
      waterfall: [
        { span: "router", startMs: 0, ms: 12 },
        { span: "room_wait", startMs: 12, ms: 3400 },
        { span: "claim", startMs: 3412, ms: 5 },
        { span: "turn_end#1", startMs: 3417, ms: 8 },
      ],
    },
    {
      endedAt: null,
      totalMs: 5,
      queries: 1,
      stages: [{ stage: "claim", ms: 5, queries: 1 }],
      stagesCut: false,
      computerTurns: [],
      turns: [],
      slow: [],
      waterfall: [{ span: "claim", startMs: 0, ms: 5 }],
    },
  ]);
  expect((await timings(windowOf(9))).stages.map((s) => [s.stage, s.count, s.medianMs])).toEqual([
    ["room_wait", 1, 3400],
    ["router", 1, 12],
    ["turn_end", 1, 8],
    ["claim", 2, 5],
  ]);
});

test("a stage's steps come with it in the trace, and count in the timings as the stage's, by name", async () => {
  const from = day(21);
  const parts = [
    { stage: "tools_granted", ms: 30, queries: 12 },
    { stage: "build", ms: 200, queries: 40 },
  ];
  const kept = await run({
    createdAt: new Date(from),
    brain: "claude_code",
    profiles: [{ stages: [{ stage: "context", ms: 260, queries: 55, parts }], total: { ms: 260, queries: 55 } }],
  });
  expect((await trace(kept.id)).claims[0]?.stages).toEqual([{ stage: "context", ms: 260, queries: 55, parts }]);
  expect((await timings(windowOf(21))).stages.map((s) => [s.stage, s.count, s.medianMs])).toEqual([
    ["context", 1, 260],
    ["context.build", 1, 200],
    ["context.tools_granted", 1, 30],
  ]);
});

test("a run of a confidential thread: its claims and its part in the timings are as any other run's", async () => {
  const from = day(11);
  const profiles = [
    claim([{ stage: "claim", ms: 5, queries: 1 }, ...stages(700)], { brain: [{ warm: true, firstEventMs: 300 }] }),
  ];
  const twin = () =>
    run({ createdAt: new Date(from), brain: "codex", status: "failed", error: "it read words", profiles });
  const [open, closed] = [await twin(), await twin()];
  await t.db
    .insert(schema.confidentialThreads)
    .values({ orgId: ada, channelId: adaChannel, rootMessageId: closed.threadRootId });

  const [seen, sealed] = [await trace(open.id), await trace(closed.id)];
  // The thread is confidential to these reads: its run's error is not told.
  expect([seen.run.error, sealed.run.error]).toEqual(["it read words", null]);
  expect(sealed.claims).toEqual(seen.claims);
  expect(sealed.claims).toEqual([
    {
      endedAt: null,
      totalMs: 0,
      queries: 0,
      stages: [
        { stage: "claim", ms: 5, queries: 1 },
        { stage: "model#1", ms: 700, queries: 0 },
      ],
      stagesCut: false,
      computerTurns: [{ warm: true, initMs: null, firstEventMs: 300, ...unsaid }],
      turns: [],
      slow: [],
      waterfall: expect.any(Array),
    },
  ]);
  const found = await timings(windowOf(11));
  expect([found.runs, found.profiled]).toEqual([2, 2]);
  expect(found.stages.map((s) => [s.stage, s.count])).toEqual([
    ["model", 2],
    ["claim", 2],
  ]);
  expect(found.computerStarts.map((s) => s.turns)).toEqual([2]);
});

test("what an answer holds at most: claims, a claim's stages and turns, and the window's rows", async () => {
  const from = day(13);
  const many = await run({
    createdAt: new Date(from),
    brain: "claude_code",
    profiles: [
      // Eleven kept (a server that keeps more than it does today): the last ten are given, oldest first.
      ...Array.from({ length: 10 }, (_, n) => ({ stages: [], total: { ms: n + 1, queries: 0 } })),
      {
        stages: Array.from({ length: 201 }, (_, n) => ({ stage: `model#${n + 1}`, ms: 1, queries: 1 })),
        total: { ms: 201, queries: 201 },
        brain: Array.from({ length: 51 }, () => ({ warm: true, firstEventMs: 1 })),
      },
    ],
  });
  const { claims } = await trace(many.id);
  expect(claims.map((c) => c.totalMs)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 201]);
  const last = claims.at(-1);
  expect([last?.stages.length, last?.stages.at(-1)?.stage, last?.stagesCut, last?.computerTurns.length]).toEqual([
    200,
    "model#200",
    true,
    50,
  ]);
  expect(claims[0]?.stagesCut).toBe(false);

  // 301 different stages in a window: the 300 most measured are given.
  const names = Array.from({ length: 300 }, (_, n) => `s${n}`);
  await run({
    createdAt: new Date(day(15)),
    brain: "codex",
    profiles: [claim([...names, ...names, "rare"].map((stage) => ({ stage, ms: 1, queries: 0 })))],
  });
  const wide = await timings(windowOf(15));
  expect([wide.stages.length, wide.stagesMore, wide.stages.some((s) => s.stage === "rare")]).toEqual([
    300,
    true,
    false,
  ]);
  expect((await timings(windowOf(13))).stagesMore).toBe(false);
});

test("the query is checked, the token is needed, and the read is bounded in time", async () => {
  const from = new Date(day(17)).toISOString();
  const plus = (ms: number) => new Date(day(17) + ms).toISOString();
  const q = (query: Record<string, string>) => `/analytics/run-timings?${new URLSearchParams(query)}`;

  expect((await get(q({ from, to: plus(DAY) }), null)).status).toBe(401);
  expect((await get(q({ from, to: plus(DAY) }), "wrong")).status).toBe(401);
  expect((await get(q({ from, to: plus(DAY) }), TOKEN)).status).toBe(200);
  // The longest window across workspaces and in one, and an instant written with an offset.
  expect((await get(q({ from, to: plus(2 * DAY) }))).status).toBe(200);
  expect((await get(q({ from, to: plus(31 * DAY), orgId: ada }))).status).toBe(200);
  expect((await timings(new URLSearchParams({ from: "2026-10-17T02:00:00+02:00", to: plus(1) }).toString())).from).toBe(
    from,
  );

  for (const range of [
    { from, to: from },
    { from, to: plus(-1) },
    { from, to: plus(2 * DAY + 1) },
    { from, to: plus(3 * DAY) },
    { from, to: plus(31 * DAY + 1), orgId: ada },
    { from, to: plus(32 * DAY), orgId: ada },
    { from: "2026-10-17", to: plus(DAY) },
    { from, to: "tomorrow" },
    { from: "2026-02-30T00:00:00Z", to: "2026-03-02T00:00:00Z" },
  ] as Record<string, string>[]) {
    expect(await refusal(await get(q(range)))).toEqual([400, "analytics.range"]);
  }
  const { error } = (await (await get(q({ from, to: plus(3 * DAY) }))).json()) as { error: { message: string } };
  expect(error.message).toMatch(/\b2 days .*\b31 with orgId/);
  for (const shape of [
    { from },
    { to: plus(DAY) },
    { from, to: plus(DAY), agentId: ada1 },
    { from, to: plus(DAY), orgId: "nope" },
    { from, to: plus(DAY), orgId: ada, agentId: "nope" },
    { from, to: plus(DAY), by: "agent" },
  ] as Record<string, string>[]) {
    expect(await refusal(await get(q(shape)))).toEqual([400, "invalid_request"]);
  }

  // Both statements run with the planner's compiler off and a limit on how long they may run.
  const issued = await issuedBy(() => timings(windowOf(17)));
  const settings = issued.filter((statement) => statement.startsWith("set local"));
  expect(settings.sort()).toEqual([
    "set local jit = off",
    "set local jit = off",
    "set local statement_timeout = '20s'",
    "set local statement_timeout = '20s'",
  ]);
});

test("the waits are asked for in the words of the index that finds them", async () => {
  // The planner reads a run's waits through the partial index only when the statement holds the index's condition.
  const [index] = rowsOf<{ condition: string }>(
    await t.db.execute(
      sql`select pg_get_expr(indpred, indrelid) as condition from pg_index
        where indexrelid = 'agent_run_steps_run_id_index'::regclass`,
    ),
  );
  expect(index?.condition).toContain("brain_unavailable");
  const issued = await issuedBy(() => timings(`${windowOf(19)}&by=model`));
  const waits = issued.filter((statement) => statement.includes("agent_run_steps s "));
  expect(waits.length).toBe(1);
  expect(conditionWords(waits[0] ?? "")).toContain(conditionWords(index?.condition ?? "none"));
});

type ReplyTimes = {
  from: string;
  to: string;
  bucket: string;
  replies: (Record<string, unknown> & { at: string; brain: string; trigger: string })[];
  computerStarts: Rows;
  waits: Rows;
};
const replyTimes = async (query: string) => ok<ReplyTimes>(await get(`/analytics/reply-times?${query}`));
/** A message in Ada's channel: a person's, or an agent's in `runId`. */
async function message(body: string, createdAt: Date, runId?: string, meta: Record<string, unknown> = {}) {
  const [made] = await t.db
    .insert(schema.messages)
    .values({
      orgId: ada,
      channelId: adaChannel,
      body,
      createdAt,
      meta,
      ...(runId ? { authorType: "agent", authorAgentId: ada1, agentRunId: runId, hop: 1 } : { authorType: "person" }),
    })
    .returning({ id: schema.messages.id });
  if (!made) throw new Error("no message");
  return made.id;
}

test("reply times: from a person's message to the run's first message, per bucket, brain, trigger and short ask", async () => {
  const from = day(25);
  const at = (ms: number) => new Date(from + ms);
  // A short mention answered in 3 s (its second message later counts nothing).
  const hi = await message("hi", at(0));
  const quick = await run({ createdAt: at(0), triggerMessageId: hi, brain: "claude_code" });
  await message("on it", at(3000), quick.id);
  await message("done", at(9000), quick.id);
  // A long ask the router gave out 2 s later, answered 10 s after the person wrote.
  const long = await message("please look at the failing deploy and tell me what went wrong there", at(10_000));
  const routed = await run({ createdAt: at(12_000), triggerMessageId: long, trigger: "router", brain: "model" });
  await message("found it", at(20_000), routed.id);
  // A direct message no reply came to yet, a routine's run and an agent's answer to an agent: only the first counts.
  const dm = await message("ok?", at(30_000));
  await run({ createdAt: at(30_000), triggerMessageId: dm, trigger: "dm", status: "failed" });
  const routine = await run({ createdAt: at(31_000), background: true, brain: "model" });
  await message("report", at(32_000), routine.id);
  const relay = await run({ createdAt: at(33_000), hop: 2, brain: "model" });
  await message("relay", at(34_000), relay.id);
  // An hour later, a mention whose trigger is out of reach counts from its run's start.
  const late = await run({ createdAt: at(3_600_000), brain: "codex" });
  await message("later", at(3_605_000), late.id);

  const daily = await replyTimes(windowOf(25));
  expect(daily.bucket).toBe("day");
  const row = (rows: ReplyTimes["replies"], brain: string, trigger: string) =>
    rows.find((r) => r.brain === brain && r.trigger === trigger);
  const dayAt = "2026-10-25T00:00:00Z";
  expect(row(daily.replies, "all", "all")).toEqual({
    at: dayAt,
    brain: "all",
    trigger: "all",
    runs: 4,
    replied: 3,
    p50Ms: 5000,
    p90Ms: 9000,
    p99Ms: 9900,
    short: { runs: 2, replied: 1, p50Ms: 3000, p90Ms: 3000, p99Ms: 3000 },
  });
  expect(daily.replies.map((r) => [r.brain, r.trigger, r.runs, r.replied, r.p50Ms])).toEqual([
    ["all", "all", 4, 3, 5000],
    ["all", "dm", 1, 0, null],
    ["all", "mention", 2, 2, 4000],
    ["all", "router", 1, 1, 10_000],
    ["claude_code", "all", 1, 1, 3000],
    ["codex", "all", 1, 1, 5000],
    ["model", "all", 1, 1, 10_000],
    ["other", "all", 1, 0, null],
  ]);

  const hourly = await replyTimes(`${windowOf(25)}&bucket=hour`);
  expect(hourly.bucket).toBe("hour");
  expect(
    hourly.replies.filter((r) => r.brain === "all" && r.trigger === "all").map((r) => [r.at, r.runs, r.p50Ms]),
  ).toEqual([
    ["2026-10-25T00:00:00Z", 3, 6500],
    ["2026-10-25T01:00:00Z", 1, 5000],
  ]);
  // A window with nothing in it lists nothing.
  expect(await replyTimes(windowOf(26))).toMatchObject({ replies: [], computerStarts: [], waits: [] });
});

test("reply times: every brain under its own name, none yet under other", async () => {
  const at = (ms: number) => new Date(day(4) + ms);
  for (const [i, brain] of ["antigravity", "cursor", "opencode", "grok", null].entries()) {
    const asked = await message("hi", at(i * 10_000));
    const made = await run({ createdAt: at(i * 10_000), triggerMessageId: asked, brain });
    await message("hello", at(i * 10_000 + 1000 * (i + 1)), made.id);
  }
  const { replies } = await replyTimes(windowOf(4));
  expect(replies.filter((r) => r.trigger === "all" && r.brain !== "all").map((r) => [r.brain, r.p50Ms])).toEqual([
    ["antigravity", 1000],
    ["cursor", 2000],
    ["grok", 4000],
    ["opencode", 3000],
    ["other", 5000],
  ]);
});

test("reply times: the server's notices are no reply, and an agent's message nobody waits on starts no count", async () => {
  const from = day(28);
  const at = (ms: number) => new Date(from + ms);
  // No AI to think with: its notice comes at once, yet nothing answered.
  const ask = await message("hello?", at(0));
  const noAi = await run({ createdAt: at(0), triggerMessageId: ask, status: "failed" });
  await message("No AI is set up", at(50), noAi.id, { bodyCode: "no_ai", noAi: true });
  // A plan at its limit: the wait's notice at once, the answer 60 s after the person wrote.
  const later = await message("and now?", at(1000));
  const waited = await run({ createdAt: at(1000), triggerMessageId: later, brain: "claude_code" });
  await message("The plan hit its limit", at(1500), waited.id, { bodyCode: "plan_limit_wait" });
  await message("here it is", at(61_000), waited.id, { bodyCode: "approval_request" });
  // A routine's report that names another agent: a hop-1 run nobody is waiting for.
  const report = await message("weekly report", at(2000), (await run({ createdAt: at(1900), background: true })).id);
  const relay = await run({ createdAt: at(2000), triggerMessageId: report, brain: "model" });
  await message("noted", at(2100), relay.id);

  const all = (await replyTimes(windowOf(28))).replies.find((r) => r.brain === "all" && r.trigger === "all");
  expect(all).toMatchObject({ runs: 2, replied: 1, p50Ms: 60_000 });
});

test("reply times: computer turns' starts and the waits for a computer, per bucket", async () => {
  const from = day(27);
  const at = (ms: number) => new Date(from + ms);
  const turns = [
    { warm: true, firstEventMs: 100 },
    { warm: true, firstEventMs: 300 },
    { warm: false, firstEventMs: 5000 },
    { warm: "yes", firstEventMs: 1 },
  ];
  await run({ createdAt: at(0), brain: "claude_code", profiles: [claim([], { brain: turns }), "junk"] });
  await run({
    createdAt: at(1),
    background: true,
    profiles: [claim([], { brain: [{ warm: false, firstEventMs: 9 }] })],
  });
  const waited = await run({ createdAt: at(1000), brain: "codex", finishedAt: at(60_000) });
  const unavailable = (code: string) => ({ reason: "brain_unavailable", code });
  await step(waited, 1, "error", unavailable("busy"), at(2000));
  await step(waited, 2, "context", {}, at(6000));
  await step(waited, 3, "error", unavailable("machine_offline"), at(10_000));
  await step(waited, 4, "error", unavailable("not_logged_in"), at(50_000));

  const read = await replyTimes(windowOf(27));
  expect(read.computerStarts).toEqual([
    {
      at: "2026-10-27T00:00:00Z",
      turns: 3,
      warm: 2,
      warmFirstEventP50Ms: 200,
      warmFirstEventP90Ms: 280,
      coldFirstEventP50Ms: 5000,
      coldFirstEventP90Ms: 5000,
    },
  ]);
  expect(read.waits).toEqual([
    { at: "2026-10-27T00:00:00Z", cause: "offline", waits: 1, runs: 1, p50Ms: 40_000, p90Ms: 40_000 },
    { at: "2026-10-27T00:00:00Z", cause: "other", waits: 1, runs: 1, p50Ms: 10_000, p90Ms: 10_000 },
    { at: "2026-10-27T00:00:00Z", cause: "room", waits: 1, runs: 1, p50Ms: 4000, p90Ms: 4000 },
  ]);
});

test("reply times: the window and the bucket are checked, and the token is needed", async () => {
  const from = new Date(day(29)).toISOString();
  const plus = (ms: number) => new Date(day(29) + ms).toISOString();
  const q = (query: Record<string, string>) => `/analytics/reply-times?${new URLSearchParams(query)}`;
  expect((await get(q({ from, to: plus(DAY) }), null)).status).toBe(401);
  expect((await get(q({ from, to: plus(31 * DAY), bucket: "hour" }))).status).toBe(200);
  for (const range of [
    { from, to: from },
    { from, to: plus(31 * DAY + 1) },
    { from, to: "soon" },
  ]) {
    expect(await refusal(await get(q(range)))).toEqual([400, "analytics.range"]);
  }
  expect(await refusal(await get(q({ from, to: plus(DAY), bucket: "week" })))).toEqual([400, "invalid_request"]);
  const issued = await issuedBy(() => replyTimes(windowOf(29)));
  expect(issued.filter((statement) => statement === "set local jit = off").length).toBe(3);
});

test("CLI runs: each run stamped with its computer's CLI version, counted by build with its failures, the window checked", async () => {
  const at = (ms: number) => new Date(day(30) + ms);
  await t.db
    .update(schema.machines)
    .set({
      executors: {
        claude: { version: "2.1.308 (Claude Code)" },
        codex: { version: "codex-cli 0.171.0" },
        grok: { version: "a line of its own words" },
      },
    })
    .where(sql`${schema.machines.id} = ${adaBox}`);
  const stamped = async (kind: "claude_code" | "codex" | "grok" | "model", status: "done" | "failed" | "running") => {
    const made = await run({ createdAt: at(1000), status });
    await recordRunBrain(t.db, made.id, kind, kind === "model" ? undefined : adaBox);
    return made.id;
  };
  const first = await stamped("claude_code", "done");
  await stamped("claude_code", "done");
  await stamped("claude_code", "failed");
  await stamped("codex", "failed");
  // Still running, on the model brain, and a version line with no version in it: none is counted.
  await stamped("claude_code", "running");
  await stamped("model", "failed");
  await stamped("grok", "failed");
  const [row] = await t.db
    .select({ cli: schema.agentRuns.cli })
    .from(schema.agentRuns)
    .where(sql`${schema.agentRuns.id} = ${first}`);
  // The version alone, never the computer's line.
  expect(row?.cli).toBe("claude 2.1.308");

  const read = await ok<{ clis: unknown[] }>(await get(`/cli-runs?${windowOf(30)}`));
  expect(read.clis).toEqual([
    { cli: "claude", version: "2.1.308", runs: 3, failed: 1 },
    { cli: "codex", version: "0.171.0", runs: 1, failed: 1 },
  ]);
  const from = new Date(day(30)).toISOString();
  for (const to of [from, new Date(day(30) + 7 * DAY + 1).toISOString(), "soon"]) {
    expect(await refusal(await get(`/cli-runs?from=${from}&to=${encodeURIComponent(to)}`))).toEqual([
      400,
      "analytics.range",
    ]);
  }
  expect((await get(`/cli-runs?${windowOf(30)}`, null)).status).toBe(401);
});

test("a claim's turn traces as stored: what can't be read is skipped or reads other, never a word it didn't write", async () => {
  const kept = await run({
    createdAt: new Date(day(23)),
    brain: "claude_code",
    profiles: [
      claim([{ stage: "model#1", ms: 900, queries: 0 }], {
        turns: [
          "text",
          { at: -1, ms: 5 },
          {
            at: 4,
            ms: 800,
            brain: "<b>evil</b>",
            model: "a model; drop table",
            end: "Ana's code",
            preTurnMs: "soon",
            tools: { count: 2, ms: 300, maxMs: 200 },
            runner: { warm: false, cold: "new_session", initMs: 600, evidence: ["+1ms [DEBUG] [API REQUEST]", 7] },
            system: { how_to_reply: "0123abcd", "Ana Souza": "0123abcd", block2: "not a hash" },
          },
        ],
        slow: [
          { stage: "init", ms: 9100, budgetMs: 8000, cause: "new_session", turn: 1 },
          { stage: "lunch", ms: 1 },
          { stage: "reply", ms: 12_000, budgetMs: 10_000, cause: "Ana waited" },
        ],
      }),
    ],
  });
  const [read] = (await trace(kept.id)).claims;
  expect(read?.turns).toEqual([
    {
      brain: "other",
      model: null,
      atMs: 4,
      ms: 800,
      end: "other",
      preTurnMs: null,
      firstEventMs: null,
      firstTextMs: null,
      tools: { count: 2, ms: 300, maxMs: 200 },
      runner: { ...unsaid, warm: false, cold: "new_session", initMs: 600, firstEventMs: null },
      evidence: ["+1ms [DEBUG] [API REQUEST]"],
      system: { how_to_reply: "0123abcd" },
    },
  ]);
  expect(read?.slow).toEqual([
    { stage: "init", ms: 9100, budgetMs: 8000, cause: "new_session", turn: 1 },
    { stage: "reply", ms: 12_000, budgetMs: 10_000, cause: "other", turn: null },
  ]);
  expect(read?.waterfall).toEqual([
    { span: "model#1", startMs: 0, ms: 900 },
    { span: "turn#1", startMs: 4, ms: 800 },
    { span: "turn#1.init", startMs: 4, ms: 600 },
    { span: "turn#1.own_tools", startMs: 4, ms: 300 },
  ]);
});

test("where the time goes: each run's time by group, per day, kind, brain and model, the slowest first, and a run's waterfall", async () => {
  const from = day(19);
  const at = (ms: number) => new Date(from + ms);
  const computer = [
    { stage: "room_wait", ms: 1000, queries: 0 },
    { stage: "claim", ms: 10, queries: 1 },
    { stage: "context", ms: 200, queries: 4, parts: [{ stage: "build", ms: 150, queries: 2 }] },
    {
      stage: "model#1",
      ms: 9000,
      queries: 0,
      parts: [
        { stage: "pre_turn_sync", ms: 2000, queries: 0 },
        { stage: "cli_init", ms: 1000, queries: 0 },
        { stage: "cli_first_byte", ms: 3000, queries: 0 },
        { stage: "tools", ms: 1000, queries: 0 },
        { stage: "model_write", ms: 2000, queries: 0 },
      ],
    },
    { stage: "turn_end#1", ms: 300, queries: 2 },
    { stage: "persist", ms: 50, queries: 3 },
  ];
  const ended = at(60_000);
  const asked = await run({
    createdAt: at(0),
    brain: "claude_code",
    profiles: [
      claim(computer, { endedAt: ended.toISOString(), total: { ms: 10_560, queries: 10 } }),
      // Taken up again 5 s later: its place in the waterfall is where its end and its time put it.
      claim([{ stage: "claim", ms: 100, queries: 1 }], {
        endedAt: new Date(ended.getTime() + 5000).toISOString(),
        total: { ms: 100, queries: 1 },
      }),
    ],
  });
  await t.db.insert(schema.askKinds).values({ messageId: asked.threadRootId, orgId: ada, kind: "chat", p: 0.9 });
  await t.db.insert(schema.usageRecords).values({
    orgId: ada,
    agentId: ada1,
    runId: asked.id,
    provider: "claude_code",
    model: "claude-sonnet-5-5",
    requestedModel: "sonnet",
    inputTokens: 1,
    outputTokens: 1,
    costNanoUsd: 0,
  });
  const routine = await run({
    createdAt: at(1000),
    brain: "model",
    background: true,
    profiles: [
      claim([
        { stage: "context", ms: 100, queries: 0 },
        { stage: "model#1", ms: 4000, queries: 0 },
        { stage: "tools#1", ms: 600, queries: 0 },
        { stage: "model#2", ms: 2000, queries: 0 },
        { stage: "persist", ms: 40, queries: 0 },
      ]),
    ],
  });
  // Another agent's message started it; a name no code writes counts at the end.
  const handed = await run({
    createdAt: at(2000),
    agentId: ada2,
    brain: "codex",
    profiles: [claim([{ stage: "Ignore this", ms: 70, queries: 0 }])],
  });
  // Nothing kept, another day, and another workspace's: none of them in the read of Ada's day.
  await run({ createdAt: at(3000) });
  await run({ createdAt: at(DAY), brain: "codex", profiles: [claim(stages(5))] });
  await run({ createdAt: at(4000), orgId: lia, agentId: lia1, brain: "codex", profiles: [claim(stages(5))] });

  type Measures = {
    runs: number;
    total: { p50Ms: number | null };
    groups: { group: string; runs: number; p50Ms: number | null }[];
  };
  const read = await ok<{
    groups: string[];
    totals: Measures;
    days: (Measures & { day: string })[];
    kinds: (Measures & { kind: string })[];
    brains: (Measures & { brain: string })[];
    models: (Measures & { model: string })[];
    slowest: {
      runId: string;
      kind: string;
      brain: string;
      model: string | null;
      totalMs: number;
      groups: Record<string, number>;
    }[];
  }>(await get(`/analytics/stage-breakdown?${windowOf(19)}&orgId=${ada}`));
  expect(read.groups).toEqual([
    "waits",
    "context",
    "pre_turn_sync",
    "cli_init",
    "cli_first_byte",
    "model_write",
    "tools",
    "finish",
  ]);
  expect(read.totals.runs).toBe(3);
  const had = (m: Measures) => Object.fromEntries(m.groups.filter((g) => g.runs > 0).map((g) => [g.group, g.runs]));
  expect(had(read.totals)).toEqual({
    waits: 1,
    context: 2,
    pre_turn_sync: 1,
    cli_init: 1,
    cli_first_byte: 1,
    model_write: 2,
    tools: 2,
    finish: 3,
  });
  expect(read.days.map((d) => [d.day, d.runs])).toEqual([["2026-10-19", 3]]);
  expect(read.kinds.map((k) => [k.kind, k.runs])).toEqual([
    ["chat", 1],
    ["agent", 1],
    ["background", 1],
  ]);
  expect(read.brains.map((b) => b.brain)).toEqual(["claude_code", "codex", "model"]);
  expect(read.models.map((m) => [m.model, m.runs])).toEqual([
    ["none", 2],
    ["claude-sonnet-5-5", 1],
  ]);
  expect(read.slowest.map((r) => [r.runId, r.kind, r.totalMs])).toEqual([
    [asked.id, "chat", 10_660],
    [routine.id, "background", 6740],
    [handed.id, "agent", 70],
  ]);
  expect(read.slowest[0]).toMatchObject({
    brain: "claude_code",
    model: "claude-sonnet-5-5",
    groups: {
      waits: 1000,
      context: 310,
      pre_turn_sync: 2000,
      cli_init: 1000,
      cli_first_byte: 3000,
      model_write: 2000,
      tools: 1000,
      finish: 350,
    },
  });
  expect(read.slowest[1]?.groups).toMatchObject({ context: 100, model_write: 6000, tools: 600, finish: 40 });

  // The same run in its trace, as one timeline.
  const traced = await ok<{ waterfall: { segments: Record<string, unknown>[]; cut: boolean } }>(
    await get(`/runs/${asked.id}/trace`),
  );
  expect(traced.waterfall.cut).toBe(false);
  expect(traced.waterfall.segments.map((s) => [s.claim, s.stage, s.turn, s.part, s.group, s.startMs, s.ms])).toEqual([
    [0, "room_wait", null, null, "waits", 0, 1000],
    [0, "claim", null, null, "context", 1000, 10],
    [0, "context", null, null, "context", 1010, 200],
    [0, "model", 1, "pre_turn_sync", "pre_turn_sync", 1210, 2000],
    [0, "model", 1, "cli_init", "cli_init", 3210, 1000],
    [0, "model", 1, "cli_first_byte", "cli_first_byte", 4210, 3000],
    [0, "model", 1, "tools", "tools", 7210, 1000],
    [0, "model", 1, "model_write", "model_write", 8210, 2000],
    [0, "turn_end", 1, null, "finish", 10_210, 300],
    [0, "persist", null, null, "finish", 10_510, 50],
    [1, "claim", null, null, "context", 15_460, 100],
  ]);

  // Across workspaces, two days at most; in one, a month.
  const start = new Date(day(19)).toISOString();
  const past = (days: number) => new Date(day(19) + days * DAY + 1).toISOString();
  expect(await refusal(await get(`/analytics/stage-breakdown?from=${start}&to=${past(2)}`))).toEqual([
    400,
    "analytics.range",
  ]);
  expect((await get(`/analytics/stage-breakdown?from=${start}&to=${past(30)}&orgId=${ada}`)).status).toBe(200);
  expect((await get(`/analytics/stage-breakdown?${windowOf(19)}`, null)).status).toBe(401);
  const fleet = await ok<{ totals: Measures }>(await get(`/analytics/stage-breakdown?${windowOf(19)}`));
  expect(fleet.totals.runs).toBe(4);
});
