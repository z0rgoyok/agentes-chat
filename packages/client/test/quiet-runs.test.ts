import { describe, expect, test } from "bun:test";
import type { ActiveRun, ChannelEvent } from "../src/index";
import {
  applyChannelEvent,
  emptyStreams,
  isQuiet,
  QUIET_AFTER_MS,
  quietRunsByChannel,
  recheckRuns,
} from "../src/index";

const delta = (runId: string, channelId: string): ChannelEvent => ({
  type: "agent.delta",
  channelId,
  threadId: "t",
  agentId: "ada",
  runId,
  seq: 0,
  text: "…",
});
const active = (runId: string): ActiveRun => ({
  runId,
  agentId: "ada",
  channelId: "c1",
  threadId: "t",
  status: "running",
  startedAt: null,
});

describe("runs gone quiet are checked with the server, unseen", () => {
  let s = applyChannelEvent(emptyStreams, delta("ended", "c1"), 1_000);
  s = applyChannelEvent(s, delta("busy", "c1"), 1_000);
  s = applyChannelEvent(s, delta("elsewhere", "c2"), 1_000);
  s = applyChannelEvent(s, delta("fresh", "c1"), 1_000 + QUIET_AFTER_MS - 1);
  const at = 1_000 + QUIET_AFTER_MS;

  test("quiet within two minutes, by channel, leaving out the ones already asked about", () => {
    expect(QUIET_AFTER_MS).toBeLessThan(2 * 60_000);
    expect(quietRunsByChannel(s, at)).toEqual(
      new Map([
        ["c1", ["ended", "busy"]],
        ["c2", ["elsewhere"]],
      ]),
    );
    expect(quietRunsByChannel(s, at, new Set(["ended", "elsewhere"]))).toEqual(new Map([["c1", ["busy"]]]));
  });

  test("a run the server no longer lists goes; one it still runs is quiet again for another while", () => {
    const next = recheckRuns(s, ["ended", "busy"], [active("busy")], at);
    expect(next.runs.ended).toBeUndefined();
    expect(next.finished.ended).toBeTruthy();
    const busy = next.runs.busy;
    if (!busy) throw new Error("busy run dropped");
    expect(isQuiet(busy, at)).toBe(false);
    expect(isQuiet(busy, at + QUIET_AFTER_MS)).toBe(true);
    // Runs it wasn't asked about stay as they were.
    expect(next.runs.elsewhere).toBe(s.runs.elsewhere);
  });

  test("a check that failed asks again after another while, not on every sweep, and drops nothing", () => {
    const next = recheckRuns(s, ["ended", "busy"], undefined, at);
    expect(Object.keys(next.runs).sort()).toEqual(Object.keys(s.runs).sort());
    expect(quietRunsByChannel(next, at + 5_000).get("c1")).toBeUndefined();
    expect(quietRunsByChannel(next, at + QUIET_AFTER_MS).get("c1")).toEqual(["ended", "busy", "fresh"]);
  });
});
