import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  applyLiveEvent,
  LIVE_PRESENCE,
  liveKeys,
  nextFrame,
  type Signal,
  scheduleSignal,
  throttleSignal,
} from "../src/index";
import { fakeClock } from "./live-helpers";

/** What the live hooks are built on: throttled and scheduled signals, and the presence event. */

function source() {
  const listeners = new Set<() => void>();
  const signal: Signal = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const fire = () => {
    for (const l of [...listeners]) l();
  };
  return { signal, fire, count: () => listeners.size };
}

describe("signals", () => {
  test("throttleSignal: the first change at once, the rest once per window, the last one always heard", () => {
    const clock = fakeClock();
    const s = source();
    let heard = 0;
    const off = throttleSignal(s.signal, 100, clock.timers, clock.now)(() => heard++);
    s.fire();
    expect(heard).toBe(1);
    for (let i = 0; i < 10; i++) s.fire();
    expect(heard).toBe(1);
    clock.advance(99);
    expect(heard).toBe(1);
    clock.advance(1);
    expect(heard).toBe(2);
    // Quiet for a while: the next change is heard at once again.
    clock.advance(500);
    s.fire();
    expect(heard).toBe(3);
    // Unsubscribing drops a call on its way, and the source's listener.
    s.fire();
    off();
    clock.advance(1000);
    expect(heard).toBe(3);
    expect(s.count()).toBe(0);
    expect(clock.pending()).toBe(0);
  });

  test("scheduleSignal: changes until the scheduled run are heard once", () => {
    const s = source();
    const runs: (() => void)[] = [];
    const schedule = (run: () => void) => {
      runs.push(run);
      return () => {
        const i = runs.indexOf(run);
        if (i >= 0) runs.splice(i, 1);
      };
    };
    let heard = 0;
    const off = scheduleSignal(s.signal, schedule)(() => heard++);
    s.fire();
    s.fire();
    s.fire();
    expect(heard).toBe(0);
    expect(runs).toHaveLength(1);
    runs.shift()?.();
    expect(heard).toBe(1);
    s.fire();
    off();
    expect(runs).toHaveLength(0);
    expect(s.count()).toBe(0);
    // Without a schedule, every change is heard.
    let direct = 0;
    scheduleSignal(s.signal)(() => direct++);
    s.fire();
    s.fire();
    expect(direct).toBe(2);
  });

  test("nextFrame: the platform's animation frame, or a short timer where there is none", async () => {
    const frames = globalThis as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
    const had = { request: frames.requestAnimationFrame, cancel: frames.cancelAnimationFrame };
    try {
      const asked: (() => void)[] = [];
      const canceled: number[] = [];
      frames.requestAnimationFrame = function (this: unknown, run: () => void) {
        // As a browser: only when called on the global.
        if (this !== globalThis) throw new TypeError("Illegal invocation");
        asked.push(run);
        return asked.length;
      };
      frames.cancelAnimationFrame = (id: number) => canceled.push(id);
      let ran = 0;
      nextFrame(() => ran++);
      const cancel = nextFrame(() => ran++);
      cancel();
      for (const run of asked) run();
      expect(asked).toHaveLength(2);
      expect(canceled).toEqual([2]);
      expect(ran).toBe(2);
      delete frames.requestAnimationFrame;
      delete frames.cancelAnimationFrame;
      let later = 0;
      nextFrame(() => later++);
      expect(later).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(later).toBe(1);
      const stopped = nextFrame(() => later++);
      stopped();
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(later).toBe(1);
    } finally {
      frames.requestAnimationFrame = had.request;
      frames.cancelAnimationFrame = had.cancel;
    }
  });
});

describe("applyLiveEvent", () => {
  test("`live.presence` asks again only the cards that show that file", async () => {
    const qc = new QueryClient();
    const withFile = liveKeys.presence("o1", ["f2", "f1"]);
    const without = liveKeys.presence("o1", ["f3"]);
    const otherOrg = liveKeys.presence("o2", ["f1"]);
    expect(withFile).toEqual(liveKeys.presence("o1", ["f1", "f2", "f1"]));
    for (const key of [withFile, without, otherOrg]) qc.setQueryData(key, {});
    expect(applyLiveEvent(qc, "o1", { type: LIVE_PRESENCE, artifactId: "f1" } as { type: string })).toBe(true);
    expect(qc.getQueryState(withFile)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(without)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(otherOrg)?.isInvalidated).toBe(false);
    // An event that names no file: every presence of the workspace.
    applyLiveEvent(qc, "o1", { type: LIVE_PRESENCE });
    expect(qc.getQueryState(without)?.isInvalidated).toBe(true);
    expect(applyLiveEvent(qc, "o1", { type: "artifact.updated" })).toBe(false);
    qc.clear();
  });
});
