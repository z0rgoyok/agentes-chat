import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFrameClock } from "../src/agent/clock";

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  return {
    timers: {
      now: () => now,
      setInterval: (fn: () => void, ms: number) => {
        const id = nextId++;
        intervals.set(id, { fn, ms });
        return id;
      },
      clearInterval: (id: unknown) => {
        intervals.delete(id as number);
      },
    },
    advance(ms: number) {
      now += ms;
      for (const i of [...intervals.values()]) i.fn();
    },
    get count() {
      return intervals.size;
    },
    get ms() {
      return [...intervals.values()][0]?.ms;
    },
  };
}

test("the clock runs only while someone listens and the app is active", () => {
  const f = fakeTimers();
  const clock = createFrameClock(25, f.timers);
  expect(clock.running).toBe(false);
  const seen: number[] = [];
  const off = clock.subscribe((t) => seen.push(t));
  expect(clock.running).toBe(true);
  expect(f.ms).toBe(40);
  f.advance(1000);
  expect(seen).toEqual([1]);
  clock.setPaused(true);
  expect(f.count).toBe(0);
  clock.setPaused(false);
  expect(f.count).toBe(1);
  off();
  expect(clock.running).toBe(false);
  expect(f.count).toBe(0);
});

test("one timer for many listeners", () => {
  const f = fakeTimers();
  const clock = createFrameClock(25, f.timers);
  const a = clock.subscribe(() => {});
  const b = clock.subscribe(() => {});
  expect(f.count).toBe(1);
  a();
  expect(f.count).toBe(1);
  b();
  expect(f.count).toBe(0);
});

test("a hold stops the clock until every hold is released (a list scrolling, a screen sliding in)", () => {
  const f = fakeTimers();
  const clock = createFrameClock(25, f.timers);
  clock.subscribe(() => {});
  const scrolling = clock.hold();
  const sliding = clock.hold();
  expect(f.count).toBe(0);
  scrolling();
  // Released twice counts once: the slide still holds it.
  scrolling();
  expect(f.count).toBe(0);
  sliding();
  expect(f.count).toBe(1);
  // The app's own pause still wins over no holds.
  clock.setPaused(true);
  expect(f.count).toBe(0);
});

test("a face's sky is drawn once and every still face is kept, not recorded again on the next mount", () => {
  const src = readFileSync(join(import.meta.dir, "../src/agent/AgentAvatar.tsx"), "utf8");
  expect(src).toContain("return kept(skies, ");
  expect(src).toContain("{ gaze, bodyless, sky: false },");
  expect(src).toContain('return kept(stills, key.join("|"), draw);');
});
