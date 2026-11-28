import { expect, test } from "bun:test";
import { createToolGateway, SLOW_TOOL_SOURCE_MS, type ToolContext } from "../src";
import { claimWaterfall } from "../src/run-timings";
import { slowMarks, type TurnTrace } from "../src/turn-trace";
import { setup } from "./fixtures";

const turn = (over: Partial<TurnTrace>): TurnTrace => ({ brain: "claude_code", at: 0, ms: 3000, end: "done", ...over });
const stage = (name: string, ms: number, parts?: { stage: string; ms: number }[]) => ({
  stage: name,
  ms,
  queries: 0,
  ...(parts ? { parts: parts.map((p) => ({ ...p, queries: 0 })) } : {}),
});

test("a claim within every budget breaks none", () => {
  expect(slowMarks([stage("context", 400), stage("model#1", 3000)], [turn({ firstTextMs: 2000 })])).toEqual([]);
});

test("a slow context names its slowest step; slow work before the turn names the checkouts", () => {
  const stages = [stage("context", 2400, [stage("tools_granted", 1900), stage("build", 300)]), stage("model#1", 3000)];
  expect(slowMarks(stages, [turn({ preTurnMs: 2600, firstTextMs: 3000 })])).toEqual([
    { stage: "context", ms: 2400, budgetMs: 1500, cause: "tools_granted" },
    { stage: "pre_turn", ms: 2600, budgetMs: 2000, cause: "checkouts", turn: 1 },
  ]);
});

test("the first token is timed from when the CLI was ready, else from the server's first text after the work before", () => {
  const retried = turn({ runner: { warm: true, firstTokenMs: 7200, retries: 1 } });
  const waited = turn({ brain: "codex", preTurnMs: 500, firstTextMs: 7000 });
  const warmFast = turn({ runner: { warm: false, initMs: 5000, firstTokenMs: 9000 } });
  expect(slowMarks([stage("model#1", 9000)], [retried, waited, warmFast])).toEqual([
    { stage: "first_byte", ms: 7200, budgetMs: 6000, cause: "api_retry", turn: 1 },
    { stage: "first_byte", ms: 6500, budgetMs: 6000, cause: "wait", turn: 2 },
  ]);
});

test("a warm turn's wait on its runner before its CLI had it is the runner's, never the API's", () => {
  const waitedOnItsOwn = turn({ runner: { warm: true, sentMs: 30_000, firstTokenMs: 31_500 } });
  expect(slowMarks([stage("model#1", 32_000)], [waitedOnItsOwn])).toEqual([
    { stage: "pre_turn", ms: 30_000, budgetMs: 2000, cause: "runner_wait", turn: 1 },
    { stage: "reply", ms: 32_000, budgetMs: 10_000, cause: "model" },
  ]);
});

test("a turn's marks sit after what was timed before its claim (the router, a wait for room)", () => {
  const stages = [stage("router", 100), stage("room_wait", 5000), stage("claim", 20), stage("model#1", 3000)];
  const t = {
    brain: "claude_code",
    model: null,
    atMs: 20,
    ms: 3000,
    end: "done",
    preTurnMs: null,
    firstEventMs: null,
    firstTextMs: 2000,
    tools: null,
    runner: null,
    evidence: [],
    system: {},
  };
  const spans = claimWaterfall(stages, [t]);
  expect(spans.find((s) => s.span === "turn#1")).toEqual({ span: "turn#1", startMs: 5120, ms: 3000 });
  expect(spans.find((s) => s.span === "turn#1.first_text")?.startMs).toBe(7120);
});

test("a turn that failed before any first token says its code; a quick reply of one turn past 10 s names its stage", () => {
  expect(slowMarks([stage("model#1", 8000)], [turn({ end: "claude_failed", ms: 8000 })])).toEqual([
    { stage: "first_byte", ms: 8000, budgetMs: 6000, cause: "claude_failed", turn: 1 },
  ]);
  expect(
    slowMarks([stage("room_wait", 7000), stage("context", 900), stage("model#1", 4000)], [turn({ firstTextMs: 3000 })]),
  ).toEqual([{ stage: "reply", ms: 11_900, budgetMs: 10_000, cause: "room_wait" }]);
});

test("a slow listing of the tools names the source it waited on", () => {
  const stages = [stage("context", 3100, [stage("tools_granted", 2900)])];
  expect(
    slowMarks(
      stages,
      [],
      [
        { source: "skills", ms: 600 },
        { source: "connectors", ms: 2850 },
      ],
    ),
  ).toEqual([{ stage: "context", ms: 3100, budgetMs: 1500, cause: "tools_granted.connectors" }]);
});

test("the tool gateway tells which source was slow to list its tools", async () => {
  const f = await setup();
  try {
    const gateway = createToolGateway({
      sources: [
        { name: "quick", tools: async () => [] },
        { name: "connectors", tools: () => Bun.sleep(SLOW_TOOL_SOURCE_MS + 50).then(() => []) },
      ],
    });
    const slow: { source: string; ms: number }[] = [];
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
      slowSource: (source: string, ms: number) => slow.push({ source, ms }),
    } as unknown as ToolContext;
    await gateway.granted(ctx);
    expect(slow.map((s) => s.source)).toEqual(["connectors"]);
    expect(slow[0]?.ms).toBeGreaterThan(SLOW_TOOL_SOURCE_MS);
  } finally {
    await f.close();
  }
});
