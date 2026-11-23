import { expect, test } from "bun:test";
import { createProfiler } from "../src/profile";

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
