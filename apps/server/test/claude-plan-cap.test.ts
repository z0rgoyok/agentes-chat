import { expect, test } from "bun:test";
import { testConfig } from "@agenteschat/config";
import { SIGN_IN_CONCURRENCY } from "@agenteschat/engine";

test("one Claude plan sign-in works on 6 runs at once by default, and the engine's own default agrees", () => {
  expect(testConfig().CLAUDE_PLAN_CONCURRENCY).toBe(6);
  expect(SIGN_IN_CONCURRENCY).toBe(6);
  expect(testConfig({ CLAUDE_PLAN_CONCURRENCY: "0" }).CLAUDE_PLAN_CONCURRENCY).toBe(0);
});
