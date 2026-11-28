import { expect, test } from "bun:test";
import { computerTurnParts, createProfiler, spanUnionMs } from "../src/profile";

const busy = (ms: number) => {
  const until = performance.now() + ms;
  while (performance.now() < until) {}
};

test("steps go with the stage the next mark closes, and the time after the last mark is an end stage", () => {
  const prof = createProfiler();
  busy(2);
  prof.mark("claim");
  busy(3);
  prof.part("tools_granted");
  busy(3);
  prof.part("build");
  busy(2);
  prof.mark("context");
  busy(2);
  prof.end();

  expect(prof.stages.map((s) => [s.stage, s.parts?.map((p) => p.stage)])).toEqual([
    ["claim", undefined],
    ["context", ["tools_granted", "build"]],
    ["end", undefined],
  ]);
  const context = prof.stages[1];
  const parts = context?.parts ?? [];
  expect(parts.every((p) => p.ms >= 3)).toBe(true);
  expect(context?.ms ?? 0).toBeGreaterThanOrEqual(parts.reduce((n, p) => n + p.ms, 0));

  // Before any mark there is nothing to end.
  const unused = createProfiler();
  unused.end();
  expect(unused.stages).toEqual([]);
});

test("a stage's steps can be worked out at its mark, from the stage's time", () => {
  const prof = createProfiler();
  prof.part("dropped");
  busy(2);
  prof.mark("model#1", (ms) => [{ stage: "model_write", ms, queries: 0 }]);
  const [model] = prof.stages;
  expect(model?.parts).toEqual([{ stage: "model_write", ms: model?.ms ?? -1, queries: 0 }]);
});

test("tools at the same time count once", () => {
  expect(spanUnionMs([])).toBe(0);
  expect(
    spanUnionMs([
      { from: 10, to: 20 },
      { from: 0, to: 5 },
      { from: 15, to: 30 },
      { from: 16, to: 18 },
    ]),
  ).toBe(25);
});

test("a computer turn's steps are shares of its stage, the model's writing the rest", () => {
  const cold = { warm: false, initMs: 1_200, firstTokenMs: 4_200, firstEventMs: 1_500 };
  expect(computerTurnParts(20_000, { syncMs: 3_000, timings: cold, toolsMs: 5_000 })).toEqual([
    { stage: "pre_turn_sync", ms: 3_000, queries: 0 },
    { stage: "cli_init", ms: 1_200, queries: 0 },
    { stage: "cli_first_byte", ms: 3_000, queries: 0 },
    { stage: "tools", ms: 5_000, queries: 0 },
    { stage: "model_write", ms: 7_800, queries: 0 },
  ]);
  // A warm process started nothing: its first byte counts from the turn's start, from its first event without a token.
  expect(
    computerTurnParts(2_000, { syncMs: 0, timings: { warm: true, initMs: 900, firstEventMs: 700 }, toolsMs: 0 }),
  ).toEqual([
    { stage: "cli_first_byte", ms: 700, queries: 0 },
    { stage: "model_write", ms: 1_300, queries: 0 },
  ]);
  // A warm process its runner waited on (its turn of its own) before handing it the turn: that wait is the CLI's
  // getting ready, never the API's first byte.
  expect(
    computerTurnParts(40_000, {
      syncMs: 0,
      timings: { warm: true, sentMs: 30_000, firstTokenMs: 31_000 },
      toolsMs: 0,
    }),
  ).toEqual([
    { stage: "cli_init", ms: 30_000, queries: 0 },
    { stage: "cli_first_byte", ms: 1_000, queries: 0 },
    { stage: "model_write", ms: 9_000, queries: 0 },
  ]);
  // Never more than the stage: what the runner said past it is cut, in the order a turn reaches it.
  expect(computerTurnParts(1_000, { syncMs: 800, timings: cold, toolsMs: 0 })).toEqual([
    { stage: "pre_turn_sync", ms: 800, queries: 0 },
    { stage: "cli_init", ms: 200, queries: 0 },
    { stage: "model_write", ms: 0, queries: 0 },
  ]);
  // An older runner said nothing: the turn is the model's.
  expect(computerTurnParts(500, { syncMs: 0, timings: undefined, toolsMs: 0 })).toEqual([
    { stage: "model_write", ms: 500, queries: 0 },
  ]);
});
