import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { type ModelRequest, systemText, textOf } from "@agenteschat/providers";
import {
  createLlmJudge,
  drainOutbox,
  type Judge,
  JudgeBudgetError,
  postPersonMessage,
  type ToolSource,
  TURN_END_CHECK_BUDGET_MS,
  withJudgeBudget,
} from "../src";
import { continuationVerdict } from "../src/continuation";
import { type Fixture, setup } from "./fixtures";

/**
 * What a simple request costs (model round trips, judgments, stage times), with the model and the judge slowed to a
 * fixed wait each: a request done in one step is two round trips and one judgment; a turn told to go on that only
 * re-runs what it already did earns no second nudge; the small model judging without Jev reads the questions as a
 * cached prefix and never holds a reply past its timeout. `RUN_SPEED_REPORT=1` prints the stages.
 */

setDefaultTimeout(60_000);

const MODEL_MS = 150;
const JUDGE_MS = 50;

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

function workTools(): ToolSource {
  const input = { type: "object", properties: { path: { type: "string" }, text: { type: "string" } } };
  return {
    name: "work",
    tools: async () => [
      {
        name: "save_file",
        description: "Save a file",
        scope: "context:read",
        inputSchema: input,
        execute: async (args) => ({ content: `Saved ${String(args.path)}.` }),
      },
      {
        name: "check_build",
        description: "Check a build",
        scope: "context:read",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
        execute: async () => ({ content: "Build 812: running" }),
      },
    ],
  };
}

/** The model and the judge each take their wait, as a provider and a judge over the network do. */
function slowDown(fx: Fixture) {
  const stream = fx.provider.stream.bind(fx.provider);
  fx.provider.stream = async (request, options) => {
    await Bun.sleep(MODEL_MS);
    return stream(request, options);
  };
  const judge = fx.context.judge;
  if (!judge) return;
  const ask = judge.ask.bind(judge);
  judge.ask = async (request) => {
    await Bun.sleep(JUDGE_MS);
    return ask(request);
  };
}

const judgments = (fx: Fixture) => (fx.context.judge as unknown as { calls: { kind: string }[] }).calls;

async function measured(fx: Fixture, body: string) {
  const started = performance.now();
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body });
  await drainOutbox(fx.db, fx.handlers);
  const ms = Math.round(performance.now() - started);
  const [run] = await fx.db.select().from(schema.agentRuns);
  const profiles = (run?.profiles ?? []) as { stages: { stage: string; ms: number }[] }[];
  const stages = profiles.flatMap((p) => p.stages).map((s) => `${s.stage} ${Math.round(s.ms)}ms`);
  const report = {
    request: body,
    wallMs: ms,
    modelCalls: fx.provider.calls.length,
    judgments: judgments(fx).map((j) => j.kind),
    stages,
  };
  if (process.env.RUN_SPEED_REPORT) console.log(JSON.stringify(report, null, 2));
  return { run, report };
}

test("a request done in one step: two model round trips and one turn-end judgment, nothing else in its way", async () => {
  f = await setup({
    toolSources: [workTools()],
    judge: (kind) => (kind === "follow_through" ? "done" : undefined),
    reply: (_request, call) =>
      call === 1
        ? { chunks: [], toolUses: [{ name: "save_file", input: { path: "notes.txt", text: "18 bytes of notes" } }] }
        : { chunks: ["Salvei notes.txt."] },
  });
  slowDown(f);
  const { run, report } = await measured(f, "@dev salva notes.txt com '18 bytes of notes'");

  expect(run?.status).toBe("done");
  expect(report.modelCalls).toBe(2);
  expect(report.judgments.filter((k) => k === "follow_through")).toHaveLength(1);
  // The turn's end waits for its one judgment alone.
  expect(report.stages.some((s) => s.startsWith("turn_end#2"))).toBe(true);
});

test("told to go on, a turn that only re-runs the same call earns no second nudge", async () => {
  f = await setup({
    toolSources: [workTools()],
    judge: (kind) => (kind === "follow_through" ? "continue" : undefined),
    reply: (_request, call) =>
      call % 2 === 1
        ? { chunks: [], toolUses: [{ name: "check_build", input: { id: "812" } }] }
        : { chunks: ["O build 812 ainda está rodando. Vou checar de novo e te aviso."] },
  });
  slowDown(f);
  const { run, report } = await measured(f, "@dev o build 812 passou?");

  expect(run?.status).toBe("done");
  const steps = await f.db.select().from(schema.agentRunSteps);
  const nudged = steps.map((s) => s.data.nudged).filter(Boolean);
  // Once to keep its promise; the same check again is no progress, so it is asked to ask (never a second promise).
  expect(nudged).toEqual(["promise", "ask"]);
  expect(report.modelCalls).toBe(6);
});

test("the small model judging without Jev: the questions lead as a cached prefix, and a slow answer ends the wait", async () => {
  const judgeRequests: ModelRequest[] = [];
  f = await setup({
    reply: (request) => {
      if (!request.outputSchema) return { chunks: ["Pronto: está salvo."] };
      judgeRequests.push(request);
      // Longer than the judge waits, and cut by its signal as a real request is: the turn goes on without the verdict.
      const slow = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        request.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      return { chunks: ["{"], hold: slow };
    },
  });
  f.context.judge = createLlmJudge({
    gateway: f.gateway,
    resolveModel: async () => "claude-haiku-5-5",
    timeoutMs: 100,
  });
  const started = performance.now();
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev salva isso",
  });
  await drainOutbox(f.db, f.handlers);

  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  const posted = (await f.db.select().from(schema.messages)).filter((m) => m.authorType === "agent");
  expect(posted.map((m) => m.body)).toContain("Pronto: está salvo.");
  // Every judgment gave up at its timeout, far before the model's 2 s.
  expect(performance.now() - started).toBeLessThan(2_000);
  const followThrough = judgeRequests.find((r) => systemText(r.system).includes('"verdict"'));
  expect(followThrough).toBeDefined();
  expect(systemText(followThrough?.system ?? "")).toContain("The questions:");
  const user = textOf(followThrough?.messages[0]?.content ?? "");
  expect(JSON.parse(user)).toEqual({ state: expect.any(Object) });
  const steps = await f.db.select().from(schema.agentRunSteps);
  expect(steps.some((s) => (s.data.continuation as { rule?: string } | undefined)?.rule === "judge_error")).toBe(true);
});

test("a turn end's checks share one wait: a checker that never answers holds the reply TURN_END_CHECK_BUDGET_MS, not its own timeout", async () => {
  f = await setup({ reply: () => ({ chunks: ["Pronto: está salvo."] }) });
  const base = f.context.judge;
  if (!base) throw new Error("the fixture has a judge");
  f.context.judge = {
    name: base.name,
    ask: (request) => (request.kind === "follow_through" ? new Promise(() => {}) : base.ask(request)),
  };
  const started = performance.now();
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev salva isso",
  });
  await drainOutbox(f.db, f.handlers);
  const elapsed = performance.now() - started;

  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  const posted = (await f.db.select().from(schema.messages)).filter((m) => m.authorType === "agent");
  expect(posted.map((m) => m.body)).toContain("Pronto: está salvo.");
  expect(elapsed).toBeGreaterThanOrEqual(TURN_END_CHECK_BUDGET_MS - 50);
  expect(elapsed).toBeLessThan(TURN_END_CHECK_BUDGET_MS + 3_000);
  const steps = await f.db.select().from(schema.agentRunSteps);
  expect(steps.some((s) => (s.data.continuation as { rule?: string } | undefined)?.rule === "judge_error")).toBe(true);
});

test("withJudgeBudget: one wait for all of a turn end's checks; after a timeout the run's later checks fail at once", async () => {
  const asked: string[] = [];
  const judge: Judge = {
    name: "fake",
    ask: async (request) => {
      asked.push(request.kind);
      await Bun.sleep(request.kind === "slow" ? 1_000 : 40);
      return { verdict: { choice: "done", probabilities: { done: 1 } } };
    },
  };
  const ask = (j: Judge, kind: string) => j.ask({ orgId: "o", kind, state: {}, questions: {} });
  const slow = { timedOut: false };

  // In the wait: answered as the judge answers.
  expect(await ask(withJudgeBudget(judge, 500, slow), "quick")).toEqual({
    verdict: { choice: "done", probabilities: { done: 1 } },
  });
  expect(slow.timedOut).toBe(false);

  // Two checks of one turn end share its wait: the second gets only what the first left.
  const turnEnd = withJudgeBudget(judge, 100, slow);
  await ask(turnEnd, "quick");
  const started = performance.now();
  await expect(ask(turnEnd, "slow")).rejects.toBeInstanceOf(JudgeBudgetError);
  expect(performance.now() - started).toBeLessThan(150);
  expect(slow.timedOut).toBe(true);

  // The run's next turn end doesn't wait again, nor asks.
  asked.length = 0;
  await expect(ask(withJudgeBudget(judge, 500, slow), "quick")).rejects.toBeInstanceOf(JudgeBudgetError);
  expect(asked).toEqual([]);
});

test("continuationVerdict: past the turn end's wait it neither asks again without the learn question nor reports it", async () => {
  let asks = 0;
  const slow = { timedOut: true };
  const judge = withJudgeBudget(
    {
      name: "fake",
      ask: async () => {
        asks++;
        return {};
      },
    },
    1_000,
    slow,
  );
  const failed: unknown[] = [];
  await expect(
    continuationVerdict(judge, {
      orgId: "o",
      agentId: "a",
      runId: "r",
      request: "salva isso",
      reply: "Pronto.",
      means: [],
      tried: [],
      runKind: "conversation",
      onLearn: () => {},
      onLearnFailed: (error) => failed.push(error),
    }),
  ).rejects.toBeInstanceOf(JudgeBudgetError);
  expect(asks).toBe(0);
  expect(failed).toEqual([]);
});
