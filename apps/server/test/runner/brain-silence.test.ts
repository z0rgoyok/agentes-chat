import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type BrainTurnRequest, parseBrainEvent, type WireBrainEvent } from "@agenteschat/adapters/machine-protocol";
import { BrainManager, type BrainManagerOptions, ClaudeStreamParser } from "../../runner/brain";
import {
  CLAUDE_SILENCE,
  type ClaudeSilence,
  keepAliveLine,
  silenceLimit,
  stalledAgainMessage,
  stallLabel,
  stallNote,
  stallWords,
} from "../../runner/brain-silence";
import { McpBridge } from "../../runner/mcp";
import { agentWorkspace } from "../../runner/paths";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
const managers: BrainManager[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.close();
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000", handle: "dev" };
const SESSION = "0193aaaa-0000-7000-8000-000000000001";
const RUN = (n: number) => `0193bbbb-0000-7000-8000-${String(n).padStart(12, "0")}`;
const FAKE = path.join(import.meta.dir, "fake-claude.mjs");
const line = (o: unknown) => JSON.stringify(o);

/** Short limits: a quiet model or tool stalls in a few hundred milliseconds. */
const QUICK: ClaudeSilence = {
  modelMs: 300,
  openBlockMs: 1500,
  compactingMs: 3000,
  toolMs: 300,
  commandGraceMs: 100,
  subagentMs: 3000,
  ownSettingsMs: 30_000,
  checkMs: 25,
};

// ── The limits ───────────────────────────────────────────────────────────────

const tool = (name: string, input: unknown = {}) => ({ name, input });

test("silence: the model's answer, a compaction, its own tools and a command by its own timeout each have a limit", () => {
  const at = (s: Parameters<typeof silenceLimit>[0]) => silenceLimit(s, CLAUDE_SILENCE);
  expect(at({ tools: [], compacting: false, bridgeCalls: 0 })).toEqual({ phase: "model", ms: 10 * 60_000 });
  expect(at({ tools: [], compacting: true, bridgeCalls: 0 })).toEqual({ phase: "compacting", ms: 15 * 60_000 });
  expect(at({ tools: [tool("Edit", { file_path: "a.ts" })], compacting: false, bridgeCalls: 0 })).toMatchObject({
    phase: "tool",
    ms: 6 * 60_000,
    tool: { name: "Edit" },
  });
  // A command: its own timeout (else the CLI's default, 2 min, or what its env sets) plus 3 min.
  expect(at({ tools: [tool("Bash", { command: "make" })], compacting: false, bridgeCalls: 0 })?.ms).toBe(5 * 60_000);
  expect(
    at({ tools: [tool("Bash", { command: "make", timeout: 600_000 })], compacting: false, bridgeCalls: 0 })?.ms,
  ).toBe(13 * 60_000);
  expect(at({ tools: [tool("Bash")], compacting: false, bridgeCalls: 0, bashDefaultMs: 60_000 })?.ms).toBe(4 * 60_000);
  expect(
    at({ tools: [tool("PowerShell", { command: "npm test", timeout: 600_000 })], compacting: false, bridgeCalls: 0 })
      ?.ms,
  ).toBe(13 * 60_000);
  // Sent to the background it answers at once; a subagent prints its own steps.
  expect(at({ tools: [tool("Bash", { run_in_background: true })], compacting: false, bridgeCalls: 0 })?.ms).toBe(
    6 * 60_000,
  );
  expect(at({ tools: [tool("Task")], compacting: false, bridgeCalls: 0 })?.ms).toBe(20 * 60_000);
  // Several at once: the one that may run longest decides.
  expect(
    at({ tools: [tool("Read"), tool("Bash", { timeout: 300_000 })], compacting: false, bridgeCalls: 0 }),
  ).toMatchObject({ ms: 8 * 60_000, tool: { name: "Bash" } });
});

test("silence: a longer API timeout stretches the model's wait; settings of its own leave no phase under 30 minutes", () => {
  const at = (s: Parameters<typeof silenceLimit>[0]) => silenceLimit(s, CLAUDE_SILENCE);
  // Its API timeout plus the CLI's 5-minute watchdog, never under the default.
  expect(at({ tools: [], compacting: false, bridgeCalls: 0, apiTimeoutMs: 900_000 })?.ms).toBe(20 * 60_000);
  expect(at({ tools: [], compacting: true, bridgeCalls: 0, apiTimeoutMs: 900_000 })?.ms).toBe(20 * 60_000);
  expect(at({ tools: [], compacting: false, bridgeCalls: 0, apiTimeoutMs: 60_000 })?.ms).toBe(10 * 60_000);
  // Hooks and its settings' env may hold anything: a blocking TaskOutput, a tool the table doesn't know, a stop hook.
  const own = { compacting: false, bridgeCalls: 0, ownSettings: true };
  expect(at({ ...own, tools: [] })?.ms).toBe(30 * 60_000);
  expect(at({ ...own, tools: [tool("TaskOutput", { block: true, timeout: 600_000 })] })?.ms).toBe(30 * 60_000);
  expect(at({ ...own, tools: [tool("Edit")] })?.ms).toBe(30 * 60_000);
  expect(at({ ...own, tools: [tool("Bash", { timeout: 3_000_000 })] })?.ms).toBe(53 * 60_000);
});

test("silence: nothing is timed while a call of ours runs, or the model called an MCP server's tool", () => {
  const at = (s: Parameters<typeof silenceLimit>[0]) => silenceLimit(s, CLAUDE_SILENCE);
  expect(at({ tools: [], compacting: false, bridgeCalls: 1 })).toBeNull();
  expect(at({ tools: [tool("Bash")], compacting: false, bridgeCalls: 1 })).toBeNull();
  expect(at({ tools: [tool("mcp__agentes__browser_do")], compacting: false, bridgeCalls: 0 })).toBeNull();
  expect(at({ tools: [tool("Read"), tool("mcp__github__list_issues")], compacting: false, bridgeCalls: 0 })).toBeNull();
});

test("silence: a stalled call in one line, and the words for the log, the model and the conversation", () => {
  expect(stallLabel(tool("Bash", { command: "  npm run build -- --mode production\necho done" }))).toBe(
    "Bash (npm run build -- --mode production)",
  );
  expect(stallLabel(tool("Edit", { file_path: "src/app.ts" }))).toBe("Edit (src/app.ts)");
  expect(stallLabel(tool("Grep", { pattern: "TODO" }))).toBe("Grep (TODO)");
  expect(stallLabel(tool("ToolSearch"))).toBe("ToolSearch");
  expect(stallLabel(tool("Bash", { command: "x".repeat(300) }))).toHaveLength("Bash ()".length + 120);
  const inTool = { phase: "tool" as const, tool: "Bash", label: "Bash (make test)", silentMs: 6 * 60_000 + 20_000 };
  expect(stallWords(inTool)).toBe("6 minutes while it ran Bash (make test)");
  expect(stallWords({ phase: "model", silentMs: 40_000 })).toBe("1 minute while it waited for the model's answer");
  expect(stallNote(inTool)).toContain("stopped responding (nothing came from it for 6 minutes while it ran Bash");
  expect(stallNote(inTool)).toContain("Check what is already done before repeating anything");
  // The conversation reads the tool, never what it ran on.
  expect(stalledAgainMessage(inTool)).toBe("it stopped responding twice: nothing for 6 minutes while it ran Bash");
});

test("parser: calls in flight until their result, a compaction while the CLI says so, a retry's announced wait", () => {
  const p = new ClaudeStreamParser();
  p.beginTurn();
  p.push(
    line({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "make" } }] },
      parent_tool_use_id: null,
    }),
  );
  expect(p.inFlight()).toEqual([{ name: "Bash", input: { command: "make" } }]);
  p.push(
    line({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "ok" }] },
      parent_tool_use_id: null,
    }),
  );
  expect(p.inFlight()).toEqual([]);
  p.push(line({ type: "system", subtype: "status", status: "compacting", parent_tool_use_id: null }));
  expect(p.compacting).toBe(true);
  p.push(line({ type: "system", subtype: "compact_boundary", parent_tool_use_id: null }));
  expect(p.compacting).toBe(false);
  expect(p.push(line({ type: "system", subtype: "api_retry", retry_delay_ms: 4000, error: "overloaded" }))).toEqual({
    events: [],
    retryInMs: 4000,
  });
});

test("parser: a block of the main answer is open from its start to its stop; a subagent's never counts", () => {
  const p = new ClaudeStreamParser();
  p.beginTurn();
  const ev = (event: unknown, parent: string | null = null) =>
    p.push(line({ type: "stream_event", event, parent_tool_use_id: parent }));
  ev({ type: "message_start", message: { id: "m1" } });
  ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
  expect(p.openBlocks).toBe(1);
  ev({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }, "task1");
  expect(p.openBlocks).toBe(1);
  ev({ type: "content_block_stop", index: 0 });
  expect(p.openBlocks).toBe(0);
  ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Write" } });
  ev({ type: "message_stop" });
  expect(p.openBlocks).toBe(0);
});

test("silence: the API's pings and a keep-alive say nothing of the turn moving; a text that says ping does", () => {
  const sid = { session_id: "s", parent_tool_use_id: null, uuid: "u" };
  expect(keepAliveLine(line({ type: "stream_event", event: { type: "ping" }, ...sid }))).toBe(true);
  expect(keepAliveLine(line({ type: "keep_alive" }))).toBe(true);
  const delta = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '"ping"' } };
  expect(keepAliveLine(line({ type: "stream_event", event: delta, ...sid }))).toBe(false);
  expect(keepAliveLine(line({ type: "stream_event", event: { type: "message_start" }, ...sid }))).toBe(false);
  expect(keepAliveLine('not json "ping"')).toBe(false);
});

test("protocol: a stalled event travels with where it was; an unknown phase is dropped", () => {
  expect(
    parseBrainEvent({ type: "stalled", phase: "tool", tool: "Bash", label: "Bash (make)", silentMs: 12.6, resumed: 1 }),
  ).toEqual({ type: "stalled", phase: "tool", tool: "Bash", label: "Bash (make)", silentMs: 13, resumed: false });
  expect(parseBrainEvent({ type: "stalled", phase: "sleeping", silentMs: 5, resumed: true })).toBeNull();
});

// ── Turns on the fake CLI ────────────────────────────────────────────────────

function setup(over: Partial<BrainManagerOptions> = {}) {
  const ws = tempDir("silence-ws-");
  const home = tempDir("silence-home-");
  dirs.push(ws, home);
  const logFile = path.join(home, "spawns.log");
  process.env.FAKE_CLAUDE_LOG = logFile;
  const m = new BrainManager({
    root: path.join(home, "brains"),
    claudeCommand: [process.execPath, FAKE],
    claudeHome: path.join(home, "no-claude-home"),
    mcp: { socketPath: path.join(home, "mcp.sock"), command: ["node", "runner.mjs"] },
    deltaMs: 5,
    silence: QUICK,
    ...over,
  });
  managers.push(m);
  const spawns = () => {
    try {
      return readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { args: string[] });
    } catch {
      return [];
    }
  };
  const turn = async (n: number, prompt: string, extra: Partial<BrainTurnRequest> = {}) => {
    const folder = await agentWorkspace(ws, AGENT);
    const events: WireBrainEvent[] = [];
    const final = await m.turn(
      {
        runId: RUN(n),
        kind: "claude_code",
        session: { id: SESSION, resume: false },
        cwd: "",
        system: "You are dev.",
        prompt,
        mcp: { token: `agr_${"t".repeat(24)}${n}` },
        ...extra,
      },
      { agent: AGENT, folder, emit: (e) => events.push(e) },
    );
    return { final, events };
  };
  return { m, spawns, turn, home };
}

const stalls = (events: WireBrainEvent[]) => events.filter((e) => e.type === "stalled");

test.if(posix)(
  "a turn quiet while it waits for the model: stopped, then the same turn on the resumed session, told why",
  async () => {
    const { m, spawns, turn } = setup();
    const r = await turn(1, "HANGMODEL please");
    expect(stalls(r.events)).toEqual([
      { type: "stalled", phase: "model", silentMs: expect.any(Number), resumed: true },
    ]);
    const silent = stalls(r.events)[0];
    expect(silent?.type === "stalled" && silent.silentMs).toBeGreaterThanOrEqual(QUICK.modelMs);
    // The resumed process read the note first, then the same request.
    expect(r.final).toMatchObject({ type: "done" });
    const text = r.final.type === "done" ? r.final.text : "";
    expect(text).toContain("Your previous attempt at this request stopped responding");
    expect(text).toContain("while it waited for the model's answer");
    expect(text).toContain("HANGMODEL please");
    const all = spawns();
    expect(all).toHaveLength(2);
    expect(all[1]?.args.slice(-2)).toEqual(["--resume", SESSION]);
    expect(m.size).toBe(0);
  },
);

test.if(posix)("an answer that stopped coming while the API's pings go on: stalled all the same", async () => {
  const { spawns, turn } = setup();
  const r = await turn(1, "HANGPING please");
  expect(stalls(r.events)).toEqual([{ type: "stalled", phase: "model", silentMs: expect.any(Number), resumed: true }]);
  expect(r.final).toMatchObject({ type: "done" });
  expect(r.final.type === "done" && r.final.text).toContain("while it waited for the model's answer");
  expect(spawns()).toHaveLength(2);
});

test.if(posix)("a long think with only pings inside its open block is no silence", async () => {
  const { spawns, turn } = setup();
  // Three times the model's limit, as a 30-minute think is three times its 10.
  const r = await turn(1, "LONGTHINK please");
  expect(stalls(r.events)).toEqual([]);
  expect(r.final).toMatchObject({ type: "done", text: "echo 1: LONGTHINK please" });
  expect(spawns()).toHaveLength(1);
});

test.if(posix)(
  "a think whose block never ends, pinging on: stalled once nothing but pings came past its limit",
  async () => {
    const { turn } = setup();
    const r = await turn(1, "HANGTHINK please");
    const stall = stalls(r.events)[0];
    expect(stalls(r.events)).toHaveLength(1);
    expect(stall?.type === "stalled" && stall.phase).toBe("model");
    expect(stall?.type === "stalled" && stall.silentMs).toBeGreaterThanOrEqual(QUICK.openBlockMs);
    expect(r.final).toMatchObject({ type: "done" });
  },
);

test.if(posix)("a command that outlives its own timeout: the turn says which, and goes on resumed", async () => {
  const { turn } = setup();
  const r = await turn(1, "HANGTOOL please");
  expect(stalls(r.events)).toEqual([
    {
      type: "stalled",
      phase: "tool",
      tool: "Bash",
      label: "Bash (sleep 999)",
      silentMs: expect.any(Number),
      resumed: true,
    },
  ]);
  const silent = stalls(r.events)[0];
  // Its 50 ms timeout plus the grace, not the model's limit.
  expect(silent?.type === "stalled" && silent.silentMs).toBeGreaterThanOrEqual(50 + QUICK.commandGraceMs);
  expect(silent?.type === "stalled" && silent.silentMs).toBeLessThan(QUICK.modelMs);
  expect(r.final).toMatchObject({ type: "done" });
  expect(r.final.type === "done" && r.final.text).toContain("while it ran Bash (sleep 999)");
});

test.if(posix)("a stalled command in a process group of its own is stopped with the CLI", async () => {
  const { home, turn } = setup();
  let pid = 0;
  try {
    const r = await turn(1, "HANGTOOL please");
    expect(stalls(r.events)).toHaveLength(1);
    pid = Number(readFileSync(path.join(home, "crashed-child"), "utf8"));
    expect(pid).toBeGreaterThan(0);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 40 && alive(); i++) await Bun.sleep(50);
    expect(alive()).toBe(false);
  } finally {
    try {
      if (pid) process.kill(pid, "SIGKILL");
    } catch {}
  }
});

test.if(posix)("a command quiet past the open-block bound but within its own timeout is no stall", async () => {
  const { spawns, turn } = setup();
  const r = await turn(1, "LONGTOOL please");
  expect(stalls(r.events)).toEqual([]);
  expect(r.final).toMatchObject({ type: "done", text: "echo 1: LONGTOOL please" });
  expect(spawns()).toHaveLength(1);
});

test.if(posix)("the time a computer slept is no silence", async () => {
  const { turn } = setup();
  const realNow = Date.now;
  let slept = 0;
  Date.now = () => realNow() + slept;
  const jump = setTimeout(() => {
    slept = 10 * 60_000;
  }, 100);
  try {
    const r = await turn(1, "HANGMODEL please");
    const stall = stalls(r.events)[0];
    expect(stall?.type === "stalled" && stall.silentMs).toBeGreaterThanOrEqual(QUICK.modelMs);
    expect(stall?.type === "stalled" && stall.silentMs).toBeLessThan(slept);
  } finally {
    clearTimeout(jump);
    Date.now = realNow;
  }
});

test.if(posix)("quiet again on the resumed session: the turn ends as brain_stalled", async () => {
  const { spawns, turn } = setup();
  const r = await turn(1, "HANGEVER please");
  expect(stalls(r.events).map((e) => e.type === "stalled" && e.resumed)).toEqual([true, false]);
  expect(r.final).toEqual({
    type: "error",
    code: "brain_stalled",
    message: "it stopped responding twice: nothing for 1 minute",
    retryable: false,
  });
  expect(spawns()).toHaveLength(2);
});

test.if(posix)("stalled, its session not there to resume: one fresh try, still told it stalled", async () => {
  process.env.FAKE_CLAUDE_NO_SESSION = "1";
  try {
    const { spawns, turn } = setup();
    const r = await turn(1, "HANGEVER please");
    expect(r.final).toMatchObject({ type: "error", code: "brain_stalled" });
    expect(spawns().map((s) => s.args.at(-2))).toEqual(["--session-id", "--resume", "--session-id"]);
  } finally {
    delete process.env.FAKE_CLAUDE_NO_SESSION;
  }
});

test.if(posix)(
  "a long call of ours, a retry the CLI announced and a call the bridge relays are no silence",
  async () => {
    const { m, spawns, turn } = setup();
    for (const [n, prompt] of [
      [1, "OURTOOLWAIT please"],
      [2, "RETRYWAIT please"],
    ] as const) {
      const r = await turn(n, prompt);
      expect(stalls(r.events)).toEqual([]);
      expect(r.final).toMatchObject({ type: "done" });
    }
    // Quiet longer than the model's limit while the bridge relays a call of the process (a permission prompt).
    const pending = turn(3, "QUIETWAIT please");
    // The process's bridge id is its folder's name, where its MCP config lives.
    const args = spawns()[0]?.args ?? [];
    const id = path.basename(path.dirname(args[args.indexOf("--mcp-config") + 1] ?? ""));
    expect(id).not.toBe("");
    m.bridgeCall(id, 1);
    const r = await pending;
    m.bridgeCall(id, -1);
    expect(stalls(r.events)).toEqual([]);
    expect(r.final).toMatchObject({ type: "done", text: "echo 3: QUIETWAIT please" });
    expect(spawns()).toHaveLength(1);
  },
);

test("the bridge says when it relays a call of a process, and when its answer came", async () => {
  const home = tempDir("silence-bridge-");
  dirs.push(home);
  const calls: string[] = [];
  const bridge = new McpBridge({
    socketPath: path.join(home, "mcp.sock"),
    task: () => ({ token: "tok", missionId: "", running: true, runId: RUN(1), serverToken: `agr_${"t".repeat(25)}` }),
    onCall: (taskId, delta) => calls.push(`${taskId}:${delta}`),
  });
  bridge.attach((frame) => {
    if (frame.type === "mcp.call") {
      expect(calls).toEqual(["p1:1"]);
      setTimeout(() => bridge.result({ type: "mcp.result", callId: frame.callId, ok: true, text: "ok" }), 10);
    }
  });
  const reply = await bridge.handle({ kind: "call", taskId: "p1", token: "tok", tool: "search_context", args: {} });
  expect(reply).toMatchObject({ ok: true, text: "ok" });
  expect(calls).toEqual(["p1:1", "p1:-1"]);
});
