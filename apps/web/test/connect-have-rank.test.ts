import { expect, test } from "bun:test";
import type { PlanUsage } from "@agenteschat/client";
import { sortHave } from "@/components/arrival/ConnectHave";

const usage = (used: number): PlanUsage => ({
  windows: [{ kind: "five_hour", usedPercent: used, resetsAt: new Date(Date.now() + 3600_000).toISOString() }],
  source: "probe",
  at: new Date().toISOString(),
});

test("a free tier ranks after the plans with room and before sign-ins, keys and plans at their limit", () => {
  const rows = [
    { id: "key", usage: null, isKey: true },
    { id: "free", usage: null, free: true },
    { id: "full", usage: usage(100) },
    { id: "signIn", usage: usage(0), signIn: true },
    { id: "busy", usage: usage(90) },
    { id: "unsaid", usage: null },
    { id: "calm", usage: usage(5) },
  ];
  expect(sortHave(rows).map((r) => r.id)).toEqual(["calm", "unsaid", "busy", "free", "signIn", "key", "full"]);
});
