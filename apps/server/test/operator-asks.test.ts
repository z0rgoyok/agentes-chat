import { afterAll, beforeAll, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { createLogger } from "../src/logger";
import { createOperatorApp } from "../src/operator/app";
import { createTestServer, type TestServer } from "./harness";

/** Time per task for the operator (`GET /analytics/asks`, ADR 0254): asks as stored, read back through the API. */

const TOKEN = "operator-test-token-".padEnd(48, "x");
const READ = "operator-read-token-".padEnd(48, "x");

let t: TestServer;
let get: (path: string, token?: string | null) => Promise<Response>;
let ada: string;
let lia: string;
let ada1: string;
let ada2: string;
let channel: string;

const from = Date.parse("2026-10-05T00:00:00.000Z");
const DAY = 86_400_000;
const at = (ms: number) => new Date(from + ms);
const q = (query: Record<string, string>) => `/analytics/asks?${new URLSearchParams(query)}`;
const window = { from: at(0).toISOString(), to: at(DAY).toISOString() };

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
  [ada, lia] = orgs.map((o) => o.id) as [string, string];
  const agents = await t.db
    .insert(schema.agents)
    .values([
      { orgId: ada, name: "One", handle: "one", model: "x" },
      { orgId: ada, name: "Two", handle: "two", model: "x" },
    ])
    .returning({ id: schema.agents.id });
  [ada1, ada2] = agents.map((a) => a.id) as [string, string];
  const [made] = await t.db
    .insert(schema.channels)
    .values({ orgId: ada, name: "general" })
    .returning({ id: schema.channels.id });
  channel = made?.id ?? "";
});

afterAll(() => t.close());

async function message(createdAt: Date, by: { runId: string; agentId: string; stretchId: string } | null, body = "x") {
  const [m] = await t.db
    .insert(schema.messages)
    .values({
      orgId: ada,
      channelId: channel,
      body,
      createdAt,
      ...(by
        ? { authorType: "agent", authorAgentId: by.agentId, agentRunId: by.runId, hop: 1, stretchId: by.stretchId }
        : { authorType: "person" }),
    })
    .returning({ id: schema.messages.id });
  return m?.id as string;
}

async function run(trigger: string, stretchId: string, values: Partial<typeof schema.agentRuns.$inferInsert>) {
  const [r] = await t.db
    .insert(schema.agentRuns)
    .values({
      orgId: ada,
      agentId: ada1,
      channelId: channel,
      threadRootId: trigger,
      triggerMessageId: trigger,
      trigger: "mention",
      hop: 1,
      stretchId,
      status: "done",
      brain: "claude_code",
      ...values,
    })
    .returning({ id: schema.agentRuns.id });
  return r?.id as string;
}

test("asks: each kind's times and speed index, a hand-off timed with its ask, the workspace cut", async () => {
  // "oi", read by Jev as chat, answered in 4 s (within 5 s).
  const hi = await message(at(0), null, "oi");
  await t.db.insert(schema.askKinds).values({ messageId: hi, orgId: ada, kind: "chat", p: 0.97 });
  const hiRun = await run(hi, hi, { createdAt: at(10), finishedAt: at(4_500) });
  await message(at(4_000), { runId: hiRun, agentId: ada1, stretchId: hi });
  // A task, unread by Jev, that the first agent handed to a second: a tool at 8 s, the reply at 50 s, done at 3 min.
  const ask = await message(at(60_000), null, "monta o relatório de outubro e manda pro time");
  const first = await run(ask, ask, { createdAt: at(60_010), finishedAt: at(120_000) });
  for (const seq of [1, 2, 3, 4])
    await t.db.insert(schema.agentRunSteps).values({
      orgId: ada,
      runId: first,
      seq,
      kind: "tool_call",
      data: {},
      createdAt: at(60_000 + seq * 8_000),
    });
  await message(at(110_000), { runId: first, agentId: ada1, stretchId: ask });
  const handed = await message(at(115_000), { runId: first, agentId: ada1, stretchId: ask });
  await run(handed, ask, { agentId: ada2, hop: 2, createdAt: at(115_100), finishedAt: at(240_000) });
  // No AI: a setup, not a wait.
  const lost = await message(at(300_000), null, "oi?");
  await run(lost, lost, { createdAt: at(300_010), status: "failed", error: "no_ai", finishedAt: at(300_100) });

  expect((await get(q(window), null)).status).toBe(401);
  const res = await get(q({ ...window, bucket: "hour" }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    totals: Record<string, unknown>;
    kinds: ({ kind: string } & Record<string, unknown>)[];
    brains: Record<string, unknown>[];
    series: { at: string; kind: string; asks: number }[];
  };
  expect(body.totals).toMatchObject({
    asks: 3,
    judged: 1,
    index: 100,
    satisfied: 2,
    multiAgent: 1,
    outcomes: { done: 2, setup: 1 },
  });
  expect(body.kinds.map((k) => k.kind)).toEqual(["chat", "question", "lookup", "action", "task", "project"]);
  expect(body.kinds.find((k) => k.kind === "chat")).toMatchObject({
    asks: 2,
    judged: 1,
    targetMs: 5_000,
    firstReply: { p50Ms: 4_000, p90Ms: 4_000 },
  });
  expect(body.kinds.find((k) => k.kind === "task")).toMatchObject({
    asks: 1,
    runsPerAsk: 2,
    toolsP50: 4,
    firstActivity: { p50Ms: 8_000 },
    firstReply: { p50Ms: 50_000 },
    done: { p50Ms: 180_000 },
  });
  expect(body.brains).toMatchObject([{ brain: "claude_code", asks: 3 }]);
  expect(body.series).toMatchObject([
    { at: "2026-10-05T00:00:00Z", kind: "all", asks: 3 },
    { at: "2026-10-05T00:00:00Z", kind: "chat", asks: 2 },
    { at: "2026-10-05T00:00:00Z", kind: "task", asks: 1 },
  ]);
  const elsewhere = (await (await get(q({ ...window, orgId: lia }))).json()) as { totals: { asks: number } };
  expect(elsewhere.totals.asks).toBe(0);
});

test("asks: the window, the bucket and the workspace's id are checked", async () => {
  const refusal = async (res: Response) => [res.status, ((await res.json()) as { error: { code: string } }).error.code];
  expect(await refusal(await get(q({ from: window.from, to: at(32 * DAY).toISOString() })))).toEqual([
    400,
    "analytics.range",
  ]);
  expect(await refusal(await get(q({ ...window, bucket: "week" })))).toEqual([400, "invalid_request"]);
  expect(await refusal(await get(q({ ...window, orgId: "nope" })))).toEqual([400, "invalid_request"]);
});
