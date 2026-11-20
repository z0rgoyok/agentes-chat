import { describe, expect, test } from "bun:test";
import type { ChannelEvent } from "../src/index";
import { applyChannelEvent, emptyStreams, expectReply, retargetProvisional, runsInChannel } from "../src/index";

/**
 * A message to an agent DM shows "pensando…" right away. Steered into a run that waits with no row here (browser help,
 * another agent, its device), the run resumes right after the send: dropping the guess on the steered event made the
 * line go and come back a moment later.
 */
const ev = (e: Record<string, unknown>) => e as unknown as ChannelEvent;
const guessed = () =>
  retargetProvisional(
    expectReply(emptyStreams, { channelId: "dm", threadId: "local-1", agentId: "ada" }),
    "local-1",
    "m2",
  );
const steered = (extra: Record<string, unknown> = {}) =>
  ev({ type: "agent.run.steered", channelId: "dm", runId: "r1", agentId: "ada", messageId: "m2", ...extra });
const ids = (s: ReturnType<typeof guessed>) => runsInChannel(s, "dm").map((r) => r.runId);

describe("the guessed 'pensando…' of a message steered into a waiting run", () => {
  test("stays when the run has no row here, and the resumed run takes its place", () => {
    let s = applyChannelEvent(guessed(), steered());
    expect(ids(s)).toEqual(["pending:ada:m2"]);
    s = applyChannelEvent(
      s,
      ev({ type: "agent.run", channelId: "dm", threadId: null, runId: "r1", agentId: "ada", status: "running" }),
    );
    expect(ids(s)).toEqual(["r1"]);
  });

  test("goes when the run has its own row here (no second reply comes)", () => {
    let s = applyChannelEvent(
      guessed(),
      ev({ type: "agent.run", channelId: "dm", threadId: "m1", runId: "r1", agentId: "ada", status: "running" }),
    );
    s = applyChannelEvent(s, steered());
    expect(ids(s)).toEqual(["r1"]);
  });

  test("goes when the run stays parked on its computer or its plan, or is told to stop", () => {
    for (const extra of [{ computer: "queued" }, { usage: "plan" }, { stop: true }]) {
      expect({ extra, ids: ids(applyChannelEvent(guessed(), steered(extra))) }).toEqual({ extra, ids: [] });
    }
  });
});
