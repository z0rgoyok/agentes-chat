import { afterAll, beforeAll, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { coldCauses, preTurnSyncs, type SpeedRun, speedClassOf, speedRuns, speedSummary, speedTable } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterAll(() => f?.close());

const now = Date.now();
const ago = (s: number) => new Date(now - s * 1000);
let greetingId = "";
let taskId = "";

beforeAll(async () => {
  f = await setup();
  const { db, org, agent, owner, general } = f;
  const say = async (body: string, at: Date) => {
    const [m] = await db
      .insert(schema.messages)
      .values({
        orgId: org.id,
        channelId: general.id,
        authorType: "person",
        authorUserId: owner.id,
        body,
        createdAt: at,
      })
      .returning();
    return m as { id: string };
  };
  const run = async (trigger: { id: string }, at: Date, finished: Date, profile: Record<string, unknown>) => {
    const [r] = await db
      .insert(schema.agentRuns)
      .values({
        orgId: org.id,
        agentId: agent.id,
        channelId: general.id,
        threadRootId: trigger.id,
        triggerMessageId: trigger.id,
        trigger: "dm",
        hop: 1,
        brain: "claude_code",
        status: "done",
        createdAt: at,
        finishedAt: finished,
        profiles: [profile],
      })
      .returning();
    return (r as { id: string }).id;
  };
  // An "oi" answered in 58 s: a cold start, and most of the model stage outside the computer's turn.
  const oi = await say("oi", ago(60));
  greetingId = await run(oi, ago(60), ago(2), {
    total: { ms: 58_000, queries: 270 },
    stages: [
      { stage: "context", ms: 1_900, queries: 160 },
      { stage: "model#1", ms: 56_000, queries: 78 },
    ],
    brain: [{ warm: false, cold: "new_session", initMs: 8_900, firstTokenMs: 28_000, firstAssistantMs: 28_400 }],
  });
  await db.insert(schema.usageRecords).values({
    orgId: org.id,
    agentId: agent.id,
    runId: greetingId,
    provider: "claude_code",
    model: "claude-opus-5-5",
    requestedModel: "claude-opus-5-5",
    inputTokens: 2,
    outputTokens: 78,
    cacheReadTokens: 0,
    cacheWriteTokens: 47_000,
    costNanoUsd: 0,
    billedTo: "plan",
  });
  // A task: five tool calls on a warm process.
  const ask = await say("Abra o PR com a correção do login e rode os testes", ago(300));
  taskId = await run(ask, ago(300), ago(180), {
    total: { ms: 119_000, queries: 900 },
    stages: [
      { stage: "context", ms: 500, queries: 100 },
      { stage: "model#1", ms: 118_000, queries: 700 },
    ],
    brain: [{ warm: true, firstTokenMs: 1_500, firstAssistantMs: 4_000 }],
  });
  for (let seq = 1; seq <= 5; seq++)
    await db.insert(schema.agentRunSteps).values({ orgId: org.id, runId: taskId, seq, kind: "tool_call", data: {} });
});

test("reads each run's stages, first computer turn, plan tokens and trigger", async () => {
  const runs = await speedRuns(f.db, { from: ago(3600).toISOString(), to: new Date(now + 1000).toISOString() });
  const oi = runs.find((r) => r.id === greetingId);
  expect(oi).toMatchObject({
    brain: "claude_code",
    model: "claude-opus-5-5",
    triggerChars: 2,
    tools: 0,
    contextMs: 1_900,
    modelMs: 56_000,
    warm: false,
    cold: "new_session",
    initMs: 8_900,
    firstAssistantMs: 28_400,
    cacheRead: 0,
    cacheWrite: 47_000,
    output: 78,
  });
  expect(oi?.feltMs).toBe(58_000);
  expect(speedClassOf(oi as SpeedRun)).toBe("greeting");
  expect(speedClassOf(runs.find((r) => r.id === taskId) as SpeedRun)).toBe("task");
  // Another brain's runs, or another workspace's, are left out when asked.
  expect(
    await speedRuns(f.db, { from: ago(3600).toISOString(), to: new Date().toISOString(), brain: "codex" }),
  ).toEqual([]);
});

test("sorts runs by what they did and says where a greeting's time went", async () => {
  const runs = await speedRuns(f.db, { from: ago(3600).toISOString(), to: new Date(now + 1000).toISOString() });
  const summary = speedSummary(runs);
  expect(summary.map((s) => s.kind)).toEqual(["greeting", "task"]);
  const greeting = summary[0];
  expect(greeting).toMatchObject({ runs: 1, coldShare: 1, initP50: 8_900, cacheHitP50: 0, outputTokensP50: 78 });
  // 27.6 s of the model stage happened before the computer started the turn, or after it answered.
  expect(greeting?.outsideTurnP50).toBe(27_600);
  expect(summary[1]).toMatchObject({ runs: 1, coldShare: 0, toolsP50: 5, outsideTurnP50: null });
  expect(coldCauses(runs)).toEqual([{ cause: "new_session", turns: 1 }]);
  const table = speedTable("Speed", summary, coldCauses(runs));
  expect(table).toContain("greeting");
  expect(table).toContain("27.6/27.6");
});

test("a quick answer is a no-tool message longer than a greeting; one to three calls is a lookup", () => {
  expect(speedClassOf({ tools: 0, triggerChars: 40 })).toBe("quick");
  expect(speedClassOf({ tools: 0, triggerChars: null })).toBe("quick");
  expect(speedClassOf({ tools: 3, triggerChars: 2 })).toBe("lookup");
  expect(speedClassOf({ tools: 4, triggerChars: 2 })).toBe("task");
});

test("counts the turns that waited on a checkouts' sync right before them, and the failed ones' seconds", async () => {
  const machineId = crypto.randomUUID();
  const rpc = (op: string, at: number, took: number, repos?: { status: string }[]) =>
    f.db.insert(schema.machineRpc).values({
      orgId: f.org.id,
      machineId,
      request: { op },
      reply: { ok: true, data: repos ? { repos } : {} },
      status: "done",
      createdAt: ago(at),
      repliedAt: ago(at - took),
    });
  // A sync that timed out on one repository (20 s), then the turn; later a quick sync, then another turn.
  await rpc("git.sync", 100, 20, [{ status: "failed" }, { status: "updated" }]);
  await rpc("brain.turn", 80, 30);
  await rpc("git.sync", 40, 0.2, [{ status: "updated" }]);
  await rpc("brain.turn", 39.8, 5);
  // A turn with no sync before it.
  await rpc("brain.turn", 10, 5);
  const sync = await preTurnSyncs(f.db);
  expect(sync).toEqual({ turns: 3, synced: 2, over5s: 1, over15s: 1, waitedSec: 20, waitedOnFailedSec: 20 });
  expect(speedTable("Speed", [], [], sync)).toContain("1 waited 5 s or more, 1 15 s or more; 20 s waited, 20 s");
});
