import { expect, test } from "bun:test";
import { DEVIN_PROTOCOL } from "@agenteschat/adapters";
import { CLI_PINS } from "@agenteschat/providers/cli-pins";
import { devinVariantOf } from "@agenteschat/providers/plans";
import { type BrainTurnRequest, type ComputerBrainLink, DevinBrain } from "../src/brains/codex";
import { type BrainEvent, type BrainTurn, brainRunsOn, SYSTEM_REFUSED } from "../src/brains/types";

const SESSION = "0193aaaa-0000-7000-8000-00000000f0d1";
const ACCOUNT = { id: "0193eeee-0000-7000-8000-000000000003", label: "Devin", status: "active" as const };

const turn = (): BrainTurn => ({
  runId: "0193aaaa-0000-7000-8000-000000000003",
  orgId: "org",
  agentId: "agent",
  channelId: "channel",
  threadRootId: null,
  system: "You are Dev.",
  messages: [{ role: "user", content: "run the tests" }],
  tools: [],
  trigger: "run the tests",
  session: { id: SESSION, resume: false, machineId: "m1", cwd: "" },
  account: ACCOUNT,
});

function link(os: string): ComputerBrainLink & { sent: BrainTurnRequest[] } {
  const sent: BrainTurnRequest[] = [];
  return {
    sent,
    async status() {
      return {
        online: true,
        execAllowed: true,
        os,
        protocol: DEVIN_PROTOCOL,
        executors: { devin: { version: "devin 3000.15.14 (a09cd7f323ee)" } },
      };
    },
    async turn(_machineId, request, { onEvent }) {
      sent.push(request);
      onEvent({ type: "done", text: "ok" });
    },
  };
}

const io = () => ({
  signal: new AbortController().signal,
  executeTool: async () => {
    throw new Error("computer brains don't execute tools in the engine");
  },
});

async function collect(it: AsyncIterable<BrainEvent>) {
  const out: BrainEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const brain = (l: ComputerBrainLink) => new DevinBrain({ link: l, mcp: async () => ({ token: "tok" }) });

test("Devin is pinned for macOS and Linux only, so a Windows computer refuses its turn and says why", async () => {
  expect(Object.keys(CLI_PINS.devin.builds).some((p) => p.startsWith("win32"))).toBe(false);
  expect([brainRunsOn("devin", "windows"), brainRunsOn("devin", "linux"), brainRunsOn("devin", "darwin")]).toEqual([
    false,
    true,
    true,
  ]);
  const windows = link("windows");
  const [refused] = await collect(brain(windows).run(turn(), io()));
  expect(refused).toMatchObject({ type: "error", code: SYSTEM_REFUSED });
  expect(refused?.type === "error" && refused.message).toContain("can't keep each account's sign-in apart");
  expect(windows.sent).toEqual([]);

  const linux = link("linux");
  await collect(brain(linux).run(turn(), io()));
  expect(linux.sent[0]).toMatchObject({ kind: "devin", account: ACCOUNT.id });
});

test("a Fusion variant reads as its main model, however its helper is named", () => {
  expect(devinVariantOf("fusion-gpt-6-sol-high-priority-sidekick-swe-2-medium")).toEqual({ level: "high", fast: true });
  expect(devinVariantOf(`fusion-claude-opus-5-5-max${"-sidekick-".repeat(500)}x`)).toEqual({
    level: "max",
    fast: false,
  });
  expect(devinVariantOf("claude-opus-4-6-thinking")).toEqual({ fast: false });
});
