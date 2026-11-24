import { expect, test } from "bun:test";
import { TURN_END_CASES, type TurnEndCase, turnEndOf } from "../eval/turn-end-cases";
import type { Judge } from "../src/judge";

// The turn-end eval's cases and harness, with a fake judge (no network). The eval itself is manual:
// `bun run eval:turn-end`.

const byId = (id: string) => TURN_END_CASES.find((c) => c.id === id) as TurnEndCase;
const judgeSaying = (choice: string): Judge => ({
  name: "fake",
  ask: async () => ({ verdict: { choice, probabilities: { [choice]: 0.9 } } }),
});

test("every case is well formed, and both kinds are there", () => {
  expect(new Set(TURN_END_CASES.map((c) => c.id)).size).toBe(TURN_END_CASES.length);
  expect(TURN_END_CASES.some((c) => c.want === "answered")).toBe(true);
  expect(TURN_END_CASES.some((c) => c.want === "nudged")).toBe(true);
});

test("the harness reads the controller's decision: a done verdict answers, a give-up or a promise is sent on", async () => {
  expect(await turnEndOf(judgeSaying("done"), byId("greeting-back"))).toEqual({ got: "answered", rule: "judged" });
  expect(await turnEndOf(judgeSaying("continue"), byId("promise-nothing-done"))).toEqual({
    got: "nudged",
    rule: "promise",
  });
  expect(await turnEndOf(judgeSaying("untried"), byId("one-empty-search"))).toEqual({ got: "nudged", rule: "untried" });
});

test("the controller's own rules: a cut call list, a routine's record and a result's notice are never unbacked", async () => {
  const unbacked = judgeSaying("unbacked");
  expect((await turnEndOf(unbacked, byId("unbacked-long-run-cut"))).got).toBe("answered");
  expect((await turnEndOf(unbacked, byId("unbacked-accepted-card-notice"))).got).toBe("answered");
  expect((await turnEndOf(unbacked, byId("untried-routine-nothing-new"))).got).toBe("answered");
  expect(await turnEndOf(unbacked, byId("unbacked-claimed-read-none-ran"))).toEqual({
    got: "nudged",
    rule: "unbacked",
  });
});

test("an untried verdict ends on a question back after calls that worked, or on a rule's refusal", async () => {
  const untried = judgeSaying("untried");
  expect(await turnEndOf(untried, byId("untried-question-back"))).toEqual({ got: "answered", rule: "asked" });
  expect((await turnEndOf(untried, byId("untried-platform-refusal"))).got).toBe("answered");
  // A question back after a failed call is still sent on.
  expect(await turnEndOf(untried, byId("untried-giveup-ends-asking"))).toEqual({ got: "nudged", rule: "untried" });
  expect(await turnEndOf(untried, byId("untried-401-other-way"))).toEqual({ got: "nudged", rule: "untried" });
});

test("a routine's judge reads its last record", async () => {
  const asked: unknown[] = [];
  const judge: Judge = {
    name: "fake",
    ask: async (request) => {
      asked.push(request.state);
      return { verdict: { choice: "done", probabilities: { done: 0.9 } } };
    },
  };
  await turnEndOf(judge, byId("untried-routine-same-blocker"));
  expect(asked[0]).toMatchObject({ runKind: "routine", previous_record: expect.stringContaining("Sentry") });
});
