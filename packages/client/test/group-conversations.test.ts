import { expect, test } from "bun:test";
import { groupFaceOf, takesGroupNames } from "../src/lib/group-conversations";

/* A personal workspace's group conversations (ADR 0159, amendment of 2026-11-26), told apart from a server of any age. */

test("a channel's face: its first agents and how many in all; none from an older server", () => {
  expect(groupFaceOf({ agentIds: ["a1", "a2", "a3", "a4"], agentCount: 6 })).toEqual({
    agentIds: ["a1", "a2", "a3", "a4"],
    count: 6,
  });
  // A count missing or short of the ids listed never shows fewer than them.
  expect(groupFaceOf({ agentIds: ["a1", "a2"] })).toEqual({ agentIds: ["a1", "a2"], count: 2 });
  expect(groupFaceOf({})).toBeNull();
});

test("a server keeps names as written when it lists the channels' agents", () => {
  expect(takesGroupNames([{ agentIds: [] }])).toBe(true);
  expect(takesGroupNames([{}, {}])).toBe(false);
  expect(takesGroupNames(undefined)).toBe(false);
});
