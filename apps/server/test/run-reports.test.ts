import { expect, test } from "bun:test";
import { createFakeErrorReporter } from "@agenteschat/adapters/error-reports";
import type { RunProfileReport } from "@agenteschat/engine";
import { reportRunProfile } from "../src/run-reports";

const RUN = "5b3c1f2e-8d4a-4c6b-9e7f-0a1b2c3d4e5f";
const MACHINE = "7c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

const profile = (over: Partial<RunProfileReport>): RunProfileReport => ({
  runId: RUN,
  orgId: "0b0e5b55-7e6c-4b51-9c3c-2f1d8f5a7c01",
  agentId: "1c1e5b55-7e6c-4b51-9c3c-2f1d8f5a7c02",
  machineId: MACHINE,
  stages: [],
  total: { ms: 0, queries: 0 },
  turns: [],
  slow: [],
  ...over,
});

test("a claim within its budgets with turns that answered reports nothing", async () => {
  const errors = createFakeErrorReporter();
  await reportRunProfile(errors, profile({ turns: [{ brain: "codex", at: 0, ms: 900, end: "done" }] }));
  await reportRunProfile(errors, profile({ turns: [{ brain: "codex", at: 0, ms: 900, end: "canceled" }] }));
  expect(errors.reports).toEqual([]);
});

test("a slow turn and a failed one are reports grouped by what they are, with the turn's timings and its CLI's log", async () => {
  const errors = createFakeErrorReporter();
  const slowTurn = {
    brain: "claude_code",
    model: "sonnet",
    at: 40,
    ms: 12_000,
    end: "done",
    runner: { warm: false, cold: "warm_mismatch" as const, initMs: 9100, evidence: ["+9ms [DEBUG] [MCP] x"] },
  };
  const failed = { brain: "claude_code", at: 12_100, ms: 300, end: "claude_failed" };
  await reportRunProfile(
    errors,
    profile({
      turns: [slowTurn, failed],
      slow: [{ stage: "init", ms: 9100, budgetMs: 8000, cause: "warm_mismatch", turn: 1 }],
    }),
    async (id) => (id === MACHINE ? 90 : undefined),
  );
  expect(errors.reports).toHaveLength(2);
  const [slow, broke] = errors.reports;
  expect(slow?.error).toMatchObject({
    name: "SlowTurn",
    message: "Slow init: warm_mismatch (claude_code)",
    level: "warning",
    fingerprint: ["slow_turn", "init", "warm_mismatch", "claude_code"],
    contexts: {
      slow: { ms: 9100, budget_ms: 8000, turn: 1 },
      turn: { ms: 12_000, initMs: 9100, cold: "warm_mismatch" },
      cli_log: { lines: ["+9ms [DEBUG] [MCP] x"] },
    },
  });
  expect(slow?.tags).toMatchObject({
    run_id: RUN,
    machine_id: MACHINE,
    runner_protocol: 90,
    brain: "claude_code",
    model: "sonnet",
    warm: false,
    cold: "warm_mismatch",
    stage: "init",
    cause: "warm_mismatch",
  });
  expect(broke?.error).toMatchObject({
    name: "BrainTurnFailed",
    level: "error",
    fingerprint: ["brain_turn_failed", "claude_code", "claude_failed"],
  });
  expect(broke?.tags).toMatchObject({ code: "claude_failed", brain: "claude_code" });
});

test("a CLI log line as a runner sent it is scrubbed again before it is reported", async () => {
  const errors = createFakeErrorReporter();
  const line = '+5ms [ERROR] MCP server "agentes" failed for ana@example.com with sk-ant-oat01-FAKEFAKEFAKEFAKEFAKE';
  await reportRunProfile(
    errors,
    profile({
      turns: [{ brain: "claude_code", at: 0, ms: 300, end: "claude_failed", runner: { warm: true, evidence: [line] } }],
    }),
  );
  expect(errors.reports[0]?.error).toMatchObject({ contexts: { cli_log: { lines: [expect.any(String)] } } });
  const sent = JSON.stringify(errors.reports[0]?.error);
  expect(sent).not.toContain("ana@example.com");
  expect(sent).not.toContain("FAKEFAKEFAKE");
});
