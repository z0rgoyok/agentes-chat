import { expect, test } from "bun:test";
import type { AgentBrain, AgentBrainInput } from "../src/api/types";
import { giveBackLogin, loginHolders } from "../src/lib/ai-choice";

test("a login taken from other agents: who loses it, and Desfazer gives each back what it thought with", async () => {
  expect(loginHolders({ usedByIds: ["ada", "theo", "bia"] }, "ada")).toEqual(["theo", "bia"]);
  // A shared login thinks for several agents: taking it takes it from nobody.
  expect(loginHolders({ shared: true, usedByIds: ["theo"] }, "ada")).toEqual([]);
  expect(loginHolders({}, "ada")).toEqual([]);

  const brains: Record<string, Partial<AgentBrain>> = {
    theo: { brain: "claude_code", account: "acc-1", model: "claude-opus" },
  };
  const saved: [string, AgentBrainInput][] = [];
  const agents = {
    brain: async (_org: string, id: string) => {
      const b = brains[id];
      // Bia's AI isn't this person's to read: she is left as the move left her.
      if (!b) throw new Error("forbidden");
      return b as AgentBrain;
    },
    setBrain: async (_org: string, id: string, input: AgentBrainInput) => {
      saved.push([id, input]);
      return {} as AgentBrain;
    },
  };
  const giveBack = await giveBackLogin(agents, "org", ["theo", "bia"]);
  // Read before the move: what the move changes afterwards doesn't matter.
  brains.theo = { brain: "model", account: null, model: null };
  expect(saved).toEqual([]);
  await giveBack();
  expect(saved).toEqual([["theo", { brain: "claude_code", account: "acc-1", model: "claude-opus" }]]);
});
