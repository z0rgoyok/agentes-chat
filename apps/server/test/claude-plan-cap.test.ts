import { expect, test } from "bun:test";
import { testConfig } from "@agenteschat/config";

test("a Claude plan sign-in has no cap on its runs at once unless the server sets one", () => {
  expect(testConfig().CLAUDE_PLAN_CONCURRENCY).toBeUndefined();
  expect(testConfig({ CLAUDE_PLAN_CONCURRENCY: "8" }).CLAUDE_PLAN_CONCURRENCY).toBe(8);
  expect(testConfig({ CLAUDE_PLAN_CONCURRENCY: "0" }).CLAUDE_PLAN_CONCURRENCY).toBe(0);
});
