import { expect, test } from "bun:test";
import {
  brainTopic,
  CODEX_FOLDER_PROTOCOL,
  CODEX_WINDOWS_PROTOCOL,
  CONTEXT_LIMIT_PROTOCOL,
  createMemoryPubSub,
  GROK_WINDOWS_PROTOCOL,
  HELD_TURN_PROTOCOL,
  MACHINE_PROTOCOL_VERSION,
  type MachineRequest,
  OPENCODE_ACP_PROTOCOL,
  type WireBrainEvent,
} from "@agenteschat/adapters";
import {
  type BrainTurnRequest,
  CodexBrain,
  type ComputerBrainLink,
  GrokBrain,
  hubBrainLink,
  OpencodeBrain,
} from "../src/brains/codex";
import { computerPrompt } from "../src/brains/prompt";
import type { BrainEvent, BrainTurn } from "../src/brains/types";
import { MachineRequestError } from "../src/machine-hub";
import { MachineDroppedError } from "../src/machines";

const SESSION = "0193aaaa-0000-7000-8000-00000000c0de";

function turn(over: Partial<BrainTurn> = {}): BrainTurn {
  return {
    runId: "0193aaaa-0000-7000-8000-000000000001",
    orgId: "org",
    agentId: "agent",
    channelId: "channel",
    threadRootId: null,
    system: "You are Dev.",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "run the tests" },
    ],
    tools: [],
    trigger: "run the tests",
    session: { id: SESSION, resume: false, machineId: "m1", cwd: "app" },
    ...over,
  };
}

function link(opts: {
  version?: string | null;
  online?: boolean;
  events?: BrainEvent[];
  fail?: Error;
  protocol?: number;
  os?: string;
}): ComputerBrainLink & { sent: BrainTurnRequest[] } {
  const sent: BrainTurnRequest[] = [];
  return {
    sent,
    async status() {
      return {
        online: opts.online ?? true,
        execAllowed: true,
        ...(opts.protocol !== undefined ? { protocol: opts.protocol } : {}),
        ...(opts.os ? { os: opts.os } : {}),
        executors: opts.version === null ? {} : { codex: { version: opts.version ?? "codex-cli 0.170.0" } },
      };
    },
    async turn(_machineId, request, { onEvent }) {
      sent.push(request);
      for (const e of opts.events ?? []) onEvent(e);
      if (opts.fail) throw opts.fail;
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

test("on Windows a runner before CODEX_WINDOWS_PROTOCOL refuses every Codex turn: too old there, nothing sent", async () => {
  const brain = (l: ComputerBrainLink) => new CodexBrain({ link: l, mcp: async () => ({ token: "t" }) });
  const done: BrainEvent[] = [{ type: "done", text: "ok" }];
  const old = link({ os: "windows", protocol: CODEX_WINDOWS_PROTOCOL - 1 });
  expect(await collect(brain(old).run(turn(), io()))).toMatchObject([
    { type: "error", code: "runner_outdated", retryable: true },
  ]);
  expect(old.sent).toEqual([]);
  // A Windows runner that didn't say its protocol: too old as well.
  const unknown = link({ os: "windows" });
  expect(await collect(brain(unknown).run(turn(), io()))).toMatchObject([{ type: "error", code: "runner_outdated" }]);
  expect(unknown.sent).toEqual([]);
  const current = link({ os: "windows", protocol: CODEX_WINDOWS_PROTOCOL, events: done });
  await collect(brain(current).run(turn(), io()));
  expect(current.sent).toHaveLength(1);
  // Elsewhere that runner is new enough.
  const mac = link({ os: "darwin", protocol: CODEX_WINDOWS_PROTOCOL - 1, events: done });
  await collect(brain(mac).run(turn(), io()));
  expect(mac.sent).toHaveLength(1);
});

test("on Windows a runner before OPENCODE_ACP_PROTOCOL refuses every OpenCode turn: too old there, nothing sent", async () => {
  const opencodeLink = (os: string, protocol: number) => {
    const l = link({ os, protocol, events: [{ type: "done", text: "ok" }] });
    l.status = async () => ({
      online: true,
      execAllowed: true,
      protocol,
      os,
      executors: { opencode: { version: "1.19.5" } },
    });
    return l;
  };
  const brain = (l: ComputerBrainLink) => new OpencodeBrain({ link: l, mcp: async () => ({ token: "t" }) });
  const old = opencodeLink("windows", OPENCODE_ACP_PROTOCOL - 1);
  expect(await collect(brain(old).run(turn(), io()))).toMatchObject([
    { type: "error", code: "runner_outdated", message: expect.stringContaining("OpenCode on Windows") },
  ]);
  expect(old.sent).toEqual([]);
  const current = opencodeLink("windows", OPENCODE_ACP_PROTOCOL);
  await collect(brain(current).run(turn(), io()));
  expect(current.sent).toHaveLength(1);
  expect(current.sent[0]).toMatchObject({ kind: "opencode" });
  const mac = opencodeLink("darwin", OPENCODE_ACP_PROTOCOL - 1);
  await collect(brain(mac).run(turn(), io()));
  expect(mac.sent).toHaveLength(1);
});

test("Grok runs on Windows from GROK_WINDOWS_PROTOCOL; an older Windows runner is too old there, nothing sent", async () => {
  const grokLink = (os: string, protocol: number) => {
    const l = link({ os, protocol, events: [{ type: "done", text: "ok" }] });
    l.status = async () => ({
      online: true,
      execAllowed: true,
      protocol,
      os,
      executors: { grok: { version: "1.0.45" } },
    });
    return l;
  };
  const brain = (l: ComputerBrainLink) => new GrokBrain({ link: l, mcp: async () => ({ token: "t" }) });
  const old = grokLink("windows", GROK_WINDOWS_PROTOCOL - 1);
  expect(await collect(brain(old).run(turn(), io()))).toMatchObject([
    { type: "error", code: "runner_outdated", message: expect.stringContaining("Grok Build on Windows") },
  ]);
  expect(old.sent).toEqual([]);
  const current = grokLink("windows", GROK_WINDOWS_PROTOCOL);
  await collect(brain(current).run(turn(), io()));
  expect(current.sent).toHaveLength(1);
  expect(current.sent[0]).toMatchObject({ kind: "grok" });
  const mac = grokLink("darwin", GROK_WINDOWS_PROTOCOL - 1);
  await collect(brain(mac).run(turn(), io()));
  expect(mac.sent).toHaveLength(1);
});

test("a first turn sends the context and the conversation; events pass through; done carries our session", async () => {
  const l = link({
    events: [
      { type: "tool_call", id: "i1", name: "shell", input: { command: "npm test" }, executed: { content: "ok" } },
      { type: "usage", input: 100, output: 5, source: "plan" },
      { type: "text_delta", text: "Tests pass." },
      { type: "done", text: "Tests pass.", session: { id: "whatever" } },
    ],
  });
  const brain = new CodexBrain({
    link: l,
    mcp: async () => ({ token: "tok" }),
    agent: async () => ({ id: "agent", handle: "dev" }),
  });
  expect(brain.kind).toBe("codex");
  const events = await collect(brain.run(turn({ model: "gpt-5.5" }), io()));
  expect(events.map((e) => e.type)).toEqual(["tool_call", "usage", "text_delta", "done"]);
  expect(events[3]).toEqual({ type: "done", text: "Tests pass.", session: { id: SESSION } });
  expect(l.sent[0]).toMatchObject({
    kind: "codex",
    session: { id: SESSION, resume: false },
    cwd: "app",
    model: "gpt-5.5",
    system: "You are Dev.",
    mcp: { token: "tok" },
    agent: { id: "agent", handle: "dev" },
    // Each answer it finishes before it goes on is its own message (ADR 0112).
    answers: "each",
  });
  expect(l.sent[0]?.prompt).toBe(
    "The conversation so far:\n\nUser: hi\n\nYou: hello\n\nNow answer this:\n\nrun the tests",
  );
});

test("an answer posted on its own is never the turn's text again, even when the runner ends without a done", async () => {
  const l = link({
    events: [
      { type: "text_delta", text: "Oi!" },
      { type: "answer", text: "Oi!" },
      { type: "text_delta", text: "Já olho o deploy." },
    ],
  });
  const brain = new CodexBrain({ link: l, mcp: async () => ({ token: "tok" }) });
  const events = await collect(brain.run(turn(), io()));
  expect(events.filter((e) => e.type === "answer")).toEqual([{ type: "answer", text: "Oi!" }]);
  expect(events.at(-1)).toEqual({ type: "done", text: "Já olho o deploy.", session: { id: SESSION } });
});

test("each turn sends its tool names, sorted: a kept-alive Codex starts again when one is new", async () => {
  const l = link({ events: [{ type: "done", text: "ok" }] });
  const brain = new CodexBrain({ link: l, mcp: async () => ({ token: "tok" }) });
  const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object" } });
  for (const tools of [
    [tool("find_tools"), tool("use_tool")],
    [tool("use_tool"), tool("find_tools")],
    [tool("find_tools"), tool("use_tool"), tool("vega_crm_find_tools")],
  ]) {
    await collect(brain.run(turn({ tools }), io()));
  }
  const keys = l.sent.map((r) => r.mcp.tools);
  expect(keys[0]).toBe("find_tools use_tool");
  // The same names in another order are the same tools; one more is another list.
  expect(keys[1]).toBe(keys[0] as string);
  expect(keys[2]).toBe("find_tools use_tool vega_crm_find_tools");
  expect(l.sent[0]?.mcp.token).toBe("tok");
});

test("a resumed turn sends only what came after the brain's last reply", () => {
  const t = turn({
    session: { id: SESSION, resume: true, machineId: "m1", cwd: "" },
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "also check lint" },
      { role: "user", content: "run the tests" },
    ],
  });
  expect(computerPrompt(t)).toBe(
    "New messages since your last reply:\n\nUser: also check lint\n\nNow answer this:\n\nrun the tests",
  );
  expect(computerPrompt({ ...t, messages: t.messages.filter((m) => m.content !== "also check lint") })).toBe(
    "run the tests",
  );
});

test("a model the ChatGPT sign-in refused stays out of that sign-in's later turns; other brains and sign-ins keep it", async () => {
  const refusal = "The 'gpt-6.2-sol' model is not supported when using Codex with a ChatGPT account.";
  const l = link({});
  l.turn = async (_machineId, request, { onEvent }) => {
    l.sent.push(request);
    onEvent(
      request.model
        ? { type: "error", code: "codex_failed", message: refusal }
        : { type: "done", text: "Feito.", session: { id: SESSION } },
    );
  };
  const brain = new CodexBrain({ link: l, mcp: async () => ({ token: "t" }) });
  const on = (machineId: string) =>
    turn({ model: "gpt-6.2-sol", session: { id: SESSION, resume: false, machineId, cwd: "app" } });
  // The refusal is the turn's error: the executor takes it again in a fresh session.
  expect(await collect(brain.run(on("m-refused"), io()))).toMatchObject([{ type: "error", message: refusal }]);
  expect(await collect(brain.run(on("m-refused"), io()))).toMatchObject([{ type: "done", text: "Feito." }]);
  expect(await collect(brain.run(on("m-other"), io()))).toMatchObject([{ type: "error" }]);
  expect(l.sent.map((r) => r.model)).toEqual(["gpt-6.2-sol", undefined, "gpt-6.2-sol"]);
});

test("refuses before sending: offline, no Codex, no session, a Codex below its floor; any other version goes", async () => {
  const run = async (l: ComputerBrainLink, t = turn()) =>
    collect(new CodexBrain({ link: l, mcp: async () => ({ token: "t" }) }).run(t, io()));
  const offline = link({ online: false });
  expect(await run(offline)).toMatchObject([{ type: "error", code: "machine_offline", retryable: true }]);
  expect(await run(link({ version: null }))).toMatchObject([{ type: "error", code: "codex_missing" }]);
  // Older than `CLI_FLOORS.codex`: the turn waits for an update there, never sent to fail.
  const old = link({ version: "codex-cli 0.100.0" });
  expect(await run(old)).toMatchObject([{ type: "error", code: "cli_outdated", retryable: true }]);
  expect(old.sent).toHaveLength(0);
  // A line with no version in it is never held back on a guess.
  for (const version of ["codex-cli 0.170.0", "WARNING: proceeding\ncodex-cli 0.170.0", ""]) {
    const any = link({ version });
    await run(any);
    expect(any.sent).toHaveLength(1);
  }
  expect(await run(link({}), turn({ session: undefined }))).toMatchObject([{ type: "error", code: "no_session" }]);
});

test("the turn always ends once: a runner failure is an error, a silent end is done with the streamed text", async () => {
  const brain = (l: ComputerBrainLink) => new CodexBrain({ link: l, mcp: async () => ({ token: "t" }) });
  const failed = await collect(brain(link({ fail: new Error("socket closed") })).run(turn(), io()));
  expect(failed).toMatchObject([{ type: "error", code: "runner_failed", message: "socket closed" }]);
  // No room for the turn (or an older runner's ceiling): busy, so the engine waits for room.
  for (const refusal of [
    new MachineRequestError("no_slot", "short of memory"),
    new MachineRequestError("internal", "busy"),
  ]) {
    const refused = await collect(brain(link({ fail: refusal })).run(turn(), io()));
    expect(refused).toMatchObject([{ type: "error", code: "busy", retryable: true }]);
  }
  // Cut by the link dropping (or the agent's worker stopping) waits for the computer; our own stop says so.
  const dropped = await collect(brain(link({ fail: new MachineDroppedError("mac") })).run(turn(), io()));
  expect(dropped).toEqual([expect.objectContaining({ type: "error", code: "machine_offline", retryable: true })]);
  expect("serverStop" in (dropped[0] ?? {})).toBe(false);
  const ours = await collect(
    brain(link({ fail: new MachineDroppedError("mac", { serverStop: true }) })).run(turn(), io()),
  );
  expect(ours).toMatchObject([{ type: "error", code: "machine_offline", serverStop: true }]);
  const silent = await collect(brain(link({ events: [{ type: "text_delta", text: "Hi" }] })).run(turn(), io()));
  expect(silent.at(-1)).toEqual({ type: "done", text: "Hi", session: { id: SESSION } });
  const errored = await collect(
    brain(
      link({
        events: [
          { type: "limit" },
          { type: "error", code: "plan_limit", message: "You’ve hit your usage limit." },
          { type: "done", text: "ignored" },
        ],
      }),
    ).run(turn(), io()),
  );
  expect(errored.map((e) => e.type)).toEqual(["limit", "error"]);
});

test("accounts (ADR 0041): account and effort go to a runner that knows them; a signed-out account is refused", async () => {
  const ACCOUNT = "0193dddd-0000-4000-8000-000000000002";
  const account = { id: ACCOUNT, label: "Pessoal", status: "active" as const };
  const run = async (l: ComputerBrainLink, t: BrainTurn) =>
    collect(new CodexBrain({ link: l, mcp: async () => ({ token: "t" }) }).run(t, io()));

  const current = link({ protocol: 13, events: [{ type: "done", text: "ok" }] });
  await run(current, turn({ account, effort: "max" }));
  expect(current.sent[0]).toMatchObject({ kind: "codex", account: ACCOUNT, effort: "max" });

  // An older runner: the effort is dropped, an account can't run there.
  const old = link({ protocol: 12, events: [{ type: "done", text: "ok" }] });
  await run(old, turn({ effort: "max" }));
  expect("effort" in (old.sent[0] ?? {})).toBe(false);
  expect(await run(old, turn({ account }))).toMatchObject([{ type: "error", code: "runner_outdated" }]);
  expect(old.sent).toHaveLength(1);

  const out = link({ protocol: 13 });
  const refused = await run(out, turn({ account: { ...account, status: "signed_out" } }));
  expect(refused).toMatchObject([{ type: "error", code: "not_logged_in", retryable: true }]);
  expect((refused[0] as { message: string }).message).toContain('"Pessoal"');
  expect(out.sent).toHaveLength(0);
});

test("context: Automático sends Codex 200K, a chosen limit wins, an older runner gets none", async () => {
  const sent = async (protocol: number, t: BrainTurn) => {
    const l = link({ protocol, events: [{ type: "done", text: "ok" }] });
    await collect(new CodexBrain({ link: l, mcp: async () => ({ token: "t" }) }).run(t, io()));
    return l.sent[0] as { contextTokens?: number };
  };
  expect((await sent(CONTEXT_LIMIT_PROTOCOL, turn())).contextTokens).toBe(200_000);
  expect((await sent(CONTEXT_LIMIT_PROTOCOL, turn({ contextTokens: 400_000 }))).contextTokens).toBe(400_000);
  expect("contextTokens" in (await sent(CONTEXT_LIMIT_PROTOCOL - 1, turn()))).toBe(false);
});

test("live steering (protocol 15): the turn on its way takes messages through brain.steer; steer_read passes; null at the end", async () => {
  const steered: unknown[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const l: ComputerBrainLink = {
    ...link({ protocol: 15 }),
    async turn(_machineId, _request, { onEvent }) {
      onEvent({ type: "text_delta", text: "Working" });
      await gate;
      onEvent({ type: "steer_read", uuids: ["u1"] });
      onEvent({ type: "done", text: "Got it", session: { id: "x" } });
    },
    async steer(machineId, target, messages) {
      steered.push({ machineId, target, messages });
      return { status: "accepted", accepted: messages.map((m) => m.uuid) };
    },
  };
  const brain = new CodexBrain({
    link: l,
    mcp: async () => ({ token: "tok" }),
    agent: async () => ({ id: "agent", handle: "dev" }),
  });
  const handed: Array<((m: { uuid: string; text: string }[]) => Promise<unknown>) | null> = [];
  const events: BrainEvent[] = [];
  const running = (async () => {
    for await (const e of brain.run(turn(), { ...io(), steerable: (s) => handed.push(s) })) {
      events.push(e);
      if (e.type === "text_delta") {
        expect(await handed[0]?.([{ uuid: "u1", text: "also bye" }])).toEqual({ status: "accepted", accepted: ["u1"] });
        release();
      }
    }
  })();
  await running;
  expect(steered).toEqual([
    {
      machineId: "m1",
      target: { runId: turn().runId, session: SESSION, agent: { id: "agent", handle: "dev" } },
      messages: [{ uuid: "u1", text: "also bye" }],
    },
  ]);
  expect(events.map((e) => e.type)).toEqual(["text_delta", "steer_read", "done"]);
  expect(handed.at(-1)).toBeNull();
  expect(handed).toHaveLength(2);

  // An older runner (protocol 14) is never asked.
  const old: Array<unknown> = [];
  await collect(
    new CodexBrain({
      link: { ...l, ...link({ protocol: 14, events: [{ type: "done", text: "ok" }] }) },
      mcp: async () => ({ token: "t" }),
      agent: async () => ({ id: "agent", handle: "dev" }),
    }).run(turn(), { ...io(), steerable: (s) => old.push(s) }),
  );
  expect(old).toEqual([]);
});

test("an agent that always asks: Codex's own tools can't each ask, so its turn only reads", async () => {
  const sent = async (asks: "always" | "never") => {
    const l = link({ protocol: MACHINE_PROTOCOL_VERSION, events: [{ type: "done", text: "ok" }] });
    const brain = new CodexBrain({
      link: l,
      mcp: async () => ({ token: "t" }),
      permissions: async () => ({ mode: "work", asks }),
    });
    await collect(brain.run(turn(), io()));
    return (l.sent[0] as { permissions?: unknown } | undefined)?.permissions;
  };
  expect(await sent("always")).toEqual({ mode: "plan", asks: "always" });
  expect(await sent("never")).toEqual({ mode: "work", asks: "never" });
});

test("a runner before CODEX_FOLDER_PROTOCOL: the turn stays in the agent's folder and its session, no checkout", async () => {
  const code = { cwd: "repos/acme/app", prompt: "# Your code\nacme/app is checked out." };
  const run = async (protocol: number) => {
    const l = link({ protocol, events: [{ type: "done", text: "ok" }] });
    let prepared = 0;
    const brain = new CodexBrain({
      link: l,
      mcp: async () => ({ token: "t" }),
      prepare: async () => {
        prepared++;
        return code;
      },
    });
    await collect(brain.run(turn({ session: { id: SESSION, resume: true, machineId: "m1", cwd: "" } }), io()));
    return { sent: l.sent[0], prepared };
  };
  // Such a runner reads a checkout in a folder nested in the agent's own, where it isn't: refused every turn.
  expect(await run(CODEX_FOLDER_PROTOCOL - 1)).toMatchObject({
    sent: { cwd: "", system: "You are Dev.", session: { id: SESSION, resume: true } },
    prepared: 0,
  });
  expect(await run(CODEX_FOLDER_PROTOCOL)).toMatchObject({
    sent: { cwd: "repos/acme/app", system: `You are Dev.\n\n${code.prompt}` },
    prepared: 1,
  });
});

test("Codex, Antigravity and the rest: a turn the link cut mid-way is taken over on the computer, not failed", async () => {
  const pubsub = createMemoryPubSub();
  const runId = turn().runId;
  const calls: MachineRequest[] = [];
  let online = true;
  const hub = {
    status: async () => ({ online, protocol: HELD_TURN_PROTOCOL, lastSeenAt: new Date().toISOString() }) as never,
    call: async (_machineId: string, request: MachineRequest) => {
      calls.push(request);
      const say = (event: WireBrainEvent) =>
        pubsub.publish(brainTopic(runId), { type: "brain.event", machineId: "m1", event });
      if (calls.length === 1) {
        await say({ type: "text_delta", text: "On it" });
        online = false;
        setTimeout(() => (online = true), 200);
        throw new MachineDroppedError("mac");
      }
      await say({ type: "done", text: "On it: done." });
      await pubsub.publish(brainTopic(runId), { type: "brain.done", machineId: "m1" });
      return { runId, final: { type: "done", text: "On it: done." } } as never;
    },
  };
  const events: unknown[] = [];
  await hubBrainLink({ hub, pubsub, finalGraceMs: 20, heldTurnWaitMs: 2_000 }).turn(
    "m1",
    {
      runId,
      kind: "codex",
      session: { id: SESSION, resume: true },
      cwd: "",
      system: "",
      prompt: "hi",
      mcp: { token: "t" },
    },
    { signal: new AbortController().signal, onEvent: (e) => events.push(e) },
  );
  expect(events.at(-1)).toEqual(expect.objectContaining({ type: "done", text: "On it: done." }));
  expect(calls.map((r) => (r as { reattach?: boolean }).reattach === true)).toEqual([false, true]);
});
