import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { asc, eq, schema } from "@agenteschat/db";
import {
  type Brain,
  createJobHandlers,
  drainOutbox,
  type MachineStatus,
  operatorRunTrace,
  postPersonMessage,
} from "../src";
import { type Fixture, SECRET, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * The computer stopping a brain's CLI for its silence, on the run's trail as a `brain_stalled` error step the
 * operator's trace reads; the calls the CLI ran itself are not written there, one row each.
 */

let f: Fixture;
afterEach(() => f?.close());

const onComputer = async (brain: Brain) => {
  f = await setup({ contextTools: true });
  const deps = { db: f.db, pubsub: f.pubsub, publicUrl: "https://agentes.chat" };
  const paired = await pairMachine(deps, f.owner.id, f.org.id, {
    name: "MacBook",
    hostname: "mac",
    os: "darwin",
    arch: "arm64",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/Users/w/agentes",
    exec: true,
  });
  await f.db
    .update(schema.agents)
    .set({ machineId: paired.machineId, brain: "claude_code" })
    .where(eq(schema.agents.id, f.agent.id));
  return createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: {
      status: async (id): Promise<MachineStatus> => ({
        id,
        orgId: f.org.id,
        name: "MacBook",
        online: true,
        execAllowed: true,
        os: "darwin",
        protocol: 8,
        executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
      }),
    },
  });
};

test("a stall the computer recovered from is kept on the trail; its own calls are not", async () => {
  const brain: Brain = {
    kind: "claude_code",
    async *run(_turn, io) {
      yield { type: "tool_started", id: "b1", name: "Bash" };
      await new Promise((r) => setTimeout(r, 30));
      yield {
        type: "tool_call",
        id: "b1",
        name: "Bash",
        input: { command: "npm run build -- --mode production" },
        executed: { content: "exit 1", isError: true },
      };
      // The computer stopped its quiet CLI and sent the turn again on the resumed session.
      yield {
        type: "stalled",
        phase: "tool",
        tool: "Bash",
        label: "Bash (npm run build -- --mode production)",
        silentMs: 420_000,
        resumed: true,
      };
      const input = { query: "release notes" };
      const result = await io.executeTool({ id: "s1", name: "search_context", input });
      yield { type: "tool_call", id: "s1", name: "search_context", input, executed: result };
      // A brain that tells its call only once it ended: no time of its own.
      yield {
        type: "tool_call",
        id: "w1",
        name: "Write",
        input: { file_path: "notes.md" },
        executed: { content: "ok" },
      };
      yield { type: "text_delta", text: "Notas da versão prontas." };
      yield { type: "done", text: "Notas da versão prontas." };
    },
  };
  const handlers = await onComputer(brain);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev prepara as notas da versão?",
  });
  await drainOutbox(f.db, handlers);

  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  expect(run.status).toBe("done");
  const steps = await f.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, run.id))
    .orderBy(asc(schema.agentRunSteps.seq));
  // Its own calls write nothing; ours are the bridge's tool steps.
  expect(steps.filter((s) => s.kind === "context" && JSON.stringify(s.data).includes("Bash"))).toEqual([]);
  expect(steps.some((s) => s.kind === "tool_call" && s.data.name === "search_context")).toBe(true);
  const stalled = steps.filter((s) => s.kind === "error" && s.data.reason === "brain_stalled");
  expect(stalled.map((s) => s.data)).toEqual([
    {
      reason: "brain_stalled",
      code: "tool",
      tool: "Bash",
      label: "Bash (npm run build -- --mode production)",
      silentMs: 420_000,
      resumed: true,
    },
  ]);

  // The operator reads which tool and how long; never what it ran on.
  const trail = (await operatorRunTrace(f.db, run.id, { limit: 200, secret: SECRET }))?.steps ?? [];
  const stall = trail.find((s) => s.kind === "error" && s.reason === "brain_stalled");
  expect(stall).toMatchObject({ code: "tool", tool: "Bash", durationMs: 420_000 });
  expect(JSON.stringify(trail)).not.toContain("npm run build");
});
