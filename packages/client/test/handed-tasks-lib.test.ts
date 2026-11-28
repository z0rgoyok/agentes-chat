import { expect, test } from "bun:test";
import type { Issue } from "../src/api/types";
import { handedFinished, handedTasksOf } from "../src/lib/issues";

test("the tasks a right hand's reply handed on, as its chips read them (ADR 0137 §13)", () => {
  const task = { issueId: "i1", number: 42, title: "Campanha de Natal", agentId: "a1", channelId: "c1", rootId: "r1" };
  expect(handedTasksOf({ tasks: [task] })).toEqual([task]);
  // Without where its conversation is, there is no chip to open.
  expect(handedTasksOf({ tasks: [{ ...task, rootId: undefined }] })).toEqual([]);
  expect(handedTasksOf({ tasks: "nope" })).toEqual([]);
  expect(handedTasksOf(null)).toEqual([]);
});

test("a handed task reads finished only when its work ended done with every criterion met", () => {
  const work = { how: "handed", status: "done" } as Issue["backgroundWork"];
  const criteria = (...done: boolean[]) => done.map((d, n) => ({ id: `c${n}`, text: "Totals match", done: d }));
  expect(handedFinished({ backgroundWork: work, criteria: criteria(true, true) })).toBe(true);
  expect(handedFinished({ backgroundWork: work, criteria: [] })).toBe(true);
  // The turn ended with a criterion open: it ended, it didn't finish.
  expect(handedFinished({ backgroundWork: work, criteria: criteria(true, false) })).toBe(false);
  expect(handedFinished({ backgroundWork: { ...work, status: "live" } as Issue["backgroundWork"], criteria: [] })).toBe(
    false,
  );
});
