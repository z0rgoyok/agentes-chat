import { expect, test } from "bun:test";
import { watchEventLoopLag } from "../src/event-loop-lag";

test("a window's reading catches a block that held the event loop, and is logged", async () => {
  const logged: Record<string, unknown>[] = [];
  const last = watchEventLoopLag({ info: (_message, attrs) => void logged.push(attrs ?? {}) }, 500);
  expect(last()).toBeNull();
  await Bun.sleep(50);
  const until = performance.now() + 150;
  while (performance.now() < until) {}
  await Bun.sleep(500);
  // The window that held the block ended at 500 ms and is the last one read.
  expect(last()?.maxMs).toBeGreaterThanOrEqual(100);
  expect(last()?.p50Ms).toBeLessThan(100);
  expect(logged).toEqual([expect.objectContaining({ windowMs: 500, maxMs: last()?.maxMs })]);
});
