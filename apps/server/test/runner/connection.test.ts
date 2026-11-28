import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type BrowserTraffic,
  MACHINE_PROTOCOL_VERSION,
  type MachineLoad,
  type MachineRequest,
  RUNNER_STOPPED_CLOSE,
  type RunnerInfo,
  type ServerFrame,
} from "@agenteschat/adapters/machine-protocol";
import { connectUrl } from "../../runner/config";
import {
  backoffDelay,
  type ConnectionOptions,
  type Dial,
  RunnerConnection,
  SERVER_STOP_SPREAD_MS,
  type Socket,
  type SocketHandlers,
  serverStopDelay,
} from "../../runner/connection";
import { MIN_FREE_BYTES } from "../../runner/desktop-session";
import { RunnerError } from "../../runner/errors";
import {
  BRAIN_PRESSURE_USED,
  closeIdleUnderPressure,
  LOCKED_TURN_MIN_FREE_BYTES,
  MAX_IN_FLIGHT,
  PAST_FLOOR_NOTE,
  PERSON_TURN_MIN_FREE_BYTES,
  RequestRunner,
  ROOM_WAIT_MAX_MS,
  TURN_BYTES,
  TURN_SETTLE_MS,
  TURNS_WITHOUT_MEMORY,
} from "../../runner/handlers";
import { removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

class FakeSocket implements Socket {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  closeCode: number | undefined;
  bufferedAmount = 0;
  constructor(readonly handlers: SocketHandlers) {}
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number) {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    queueMicrotask(() => this.handlers.onClose(1000, ""));
  }
  /** The server sends a frame. */
  frame(f: ServerFrame) {
    this.handlers.onMessage(JSON.stringify(f));
  }
}

function setup(over: Partial<ConnectionOptions> = {}) {
  const ws = tempDir();
  dirs.push(ws);
  const sockets: FakeSocket[] = [];
  const dial: Dial = (_url, handlers) => {
    const s = new FakeSocket(handlers);
    sockets.push(s);
    return s;
  };
  const info: RunnerInfo = {
    version: "0.1.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    os: "linux",
    arch: "x64",
    hostname: "box",
    workspace: ws,
    exec: false,
  };
  const lines: string[] = [];
  const connection = new RunnerConnection({
    url: "wss://agentes.test/api/machines/connect",
    token: "agm_token",
    info,
    context: { workspaceReal: ws, exec: false, token: "agm_token" },
    dial,
    random: () => 0,
    log: (l) => lines.push(l),
    ...over,
  });
  return { ws, sockets, connection, lines };
}

const sock = (sockets: FakeSocket[], i: number) => sockets[i] as FakeSocket;

test("the connect URL comes from the server URL", () => {
  expect(connectUrl("https://agentes.chat")).toBe("wss://agentes.chat/api/machines/connect");
  expect(connectUrl("http://localhost:3000")).toBe("ws://localhost:3000/api/machines/connect");
});

test("backoff: 1 s doubling to 60 s, with jitter", () => {
  expect(backoffDelay(0, () => 0.5)).toBe(1000);
  expect(backoffDelay(1, () => 0.5)).toBe(2000);
  expect(backoffDelay(3, () => 0)).toBe(6400);
  expect(backoffDelay(20, () => 1)).toBe(60_000);
  expect(backoffDelay(0, () => 0)).toBe(800);
});

test("hello first, ping → pong, request → result, refused → stops with exit 2", async () => {
  const { ws, sockets, connection, lines } = setup();
  writeFileSync(path.join(ws, "hello.txt"), "hi there");
  const done = connection.run();
  await waitFor(() => sockets.length === 1);
  const s = sock(sockets, 0);
  s.handlers.onOpen();
  await waitFor(() => s.sent.length === 1);
  expect(s.sent[0]).toEqual({
    type: "hello",
    token: "agm_token",
    version: "0.1.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    os: "linux",
    arch: "x64",
    hostname: "box",
    workspace: ws,
    exec: false,
  });

  s.frame({ type: "welcome", machineId: "m1", name: "My box", heartbeatMs: 25_000 });
  expect(lines).toContain("connected as My box");

  s.frame({ type: "ping", at: 42 });
  expect(s.sent[1]).toEqual({ type: "pong", at: 42 });

  s.frame({ type: "request", id: "r1", op: "read", path: "hello.txt", maxBytes: 1000 });
  await waitFor(() => s.sent.some((f) => f.id === "r1"));
  expect(s.sent.find((f) => f.id === "r1")).toEqual({
    type: "result",
    id: "r1",
    ok: true,
    data: { base64: Buffer.from("hi there").toString("base64"), size: 8 },
  });
  expect(lines).toContain("read hello.txt");

  s.frame({ type: "request", id: "r2", op: "exec", command: "echo hi", timeoutSeconds: 5, stream: false });
  await waitFor(() => s.sent.some((f) => f.id === "r2"));
  expect(s.sent.find((f) => f.id === "r2")).toMatchObject({ ok: false, error: { code: "exec_disabled" } });

  s.frame({ type: "refused", reason: "revoked", message: "This computer was removed" });
  expect(await done).toEqual({ exitCode: 2, reason: "revoked", message: "This computer was removed" });
  expect(s.closed).toBe(true);
  expect(sockets.length).toBe(1);
});

test("protocol 22: a new load summary rides on the next pong, once, and again on a new session", async () => {
  let load: MachineLoad | null = null;
  const { sockets, connection } = setup({ load: () => load });
  const done = connection.run();
  const open = async (i: number) => {
    await waitFor(() => sockets.length === i + 1);
    const s = sock(sockets, i);
    s.handlers.onOpen();
    await waitFor(() => s.sent.length === 1);
    s.frame({ type: "welcome", machineId: "m1", name: "Box", heartbeatMs: 25_000 });
    return s;
  };
  const s = await open(0);
  s.frame({ type: "ping", at: 1 });
  expect(s.sent.at(-1)).toEqual({ type: "pong", at: 1 });
  load = { loadAvg: 0.2, loadPeak: 0.9, memoryAvg: 0.4, memoryPeak: 0.6, hours: 1 };
  s.frame({ type: "ping", at: 2 });
  expect(s.sent.at(-1)).toEqual({ type: "pong", at: 2, load });
  s.frame({ type: "ping", at: 3 });
  expect(s.sent.at(-1)).toEqual({ type: "pong", at: 3 });

  connection.reconnect();
  const again = await open(1);
  again.frame({ type: "ping", at: 4 });
  expect(again.sent.at(-1)).toEqual({ type: "pong", at: 4, load });
  connection.stop();
  await done;
});

test("a reconnect closes with no code; stopping closes with RUNNER_STOPPED_CLOSE, so the server tells it from a lost link", async () => {
  const { sockets, connection } = setup();
  const done = connection.run();
  const open = async (i: number) => {
    await waitFor(() => sockets.length === i + 1);
    const s = sock(sockets, i);
    s.handlers.onOpen();
    await waitFor(() => s.sent.length === 1);
    s.frame({ type: "welcome", machineId: "m1", name: "Box", heartbeatMs: 25_000 });
    return s;
  };
  const first = await open(0);
  connection.reconnect();
  const second = await open(1);
  expect(first.closeCode).toBeUndefined();
  connection.stop();
  await done;
  expect(second.closeCode).toBe(RUNNER_STOPPED_CLOSE);
});

test("protocol 23: the browsers' traffic rides on the next pong once per new summary, beside the load", async () => {
  let load: MachineLoad | null = null;
  let traffic: BrowserTraffic | null = null;
  const { sockets, connection } = setup({ load: () => load, browserTraffic: () => traffic });
  const done = connection.run();
  await waitFor(() => sockets.length === 1);
  const s = sock(sockets, 0);
  s.handlers.onOpen();
  await waitFor(() => s.sent.length === 1);
  s.frame({ type: "welcome", machineId: "m1", name: "Box", heartbeatMs: 25_000 });
  s.frame({ type: "ping", at: 1 });
  expect(s.sent.at(-1)).toEqual({ type: "pong", at: 1 });
  traffic = { up: 2000, down: 90_000, hours: 0.1 };
  s.frame({ type: "ping", at: 2 });
  expect(s.sent.at(-1)).toEqual({ type: "pong", at: 2, browserTraffic: traffic });
  s.frame({ type: "ping", at: 3 });
  expect(s.sent.at(-1)).toEqual({ type: "pong", at: 3 });
  // A new sample with the same bytes is a new summary: it goes too, and the load beside it.
  traffic = { ...traffic };
  load = { loadAvg: 0.2, loadPeak: 0.9, memoryAvg: 0.4, memoryPeak: 0.6, hours: 0.1 };
  s.frame({ type: "ping", at: 4 });
  expect(s.sent.at(-1)).toEqual({ type: "pong", at: 4, load, browserTraffic: traffic });
  connection.stop();
  await done;
});

test("the welcome says whether the server runs a task's call once: the MCP side hears it before the tasks", async () => {
  const heard: string[] = [];
  const { sockets, connection } = setup({
    mcp: { attach: (_send, server) => heard.push(`mcp ${server?.mcpOnce}`), detach() {}, result() {} },
    tasks: { list: () => [], attach: () => heard.push("tasks"), detach() {}, ack() {} },
  });
  const done = connection.run();
  const open = async (i: number, welcome: Partial<Extract<ServerFrame, { type: "welcome" }>>) => {
    await waitFor(() => sockets.length === i + 1);
    const s = sock(sockets, i);
    s.handlers.onOpen();
    await waitFor(() => s.sent.length === 1);
    s.frame({ type: "welcome", machineId: "m1", name: "Box", heartbeatMs: 25_000, ...welcome });
  };
  await open(0, { mcpOnce: true });
  expect(heard).toEqual(["mcp true", "tasks"]);
  // An older server says nothing: a call cut by a drop isn't sent to it again.
  connection.reconnect();
  await open(1, {});
  expect(heard.slice(2)).toEqual(["mcp false", "tasks"]);
  connection.stop();
  await done;
});

test("tasks: hello carries the journal, each welcome re-sends unacknowledged task.done, task.ack marks it", async () => {
  const done = { taskId: "t1", exitCode: 0, seconds: 3 };
  let delivered = false;
  const acks: string[] = [];
  const attached: ((f: unknown) => void)[] = [];
  const { sockets, connection } = setup({
    tasks: {
      list: () => [{ taskId: "t1", agentId: "a1", status: "done", startedAt: "2026-10-16T10:00:00.000Z" }],
      attach: (send) => {
        attached.push(send as (f: unknown) => void);
        if (!delivered) send({ type: "task.done", ...done });
      },
      detach: () => {},
      ack: (taskId) => {
        acks.push(taskId);
        delivered = true;
      },
    },
  });
  const run = connection.run();
  await waitFor(() => sockets.length === 1);
  const s = sock(sockets, 0);
  s.handlers.onOpen();
  await waitFor(() => s.sent.length === 1);
  expect(s.sent[0]).toMatchObject({ type: "hello", tasks: [{ taskId: "t1", status: "done" }] });
  s.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
  expect(s.sent[1]).toEqual({ type: "task.done", taskId: "t1", exitCode: 0, seconds: 3 });
  s.frame({ type: "task.ack", taskId: "t1" });
  expect(acks).toEqual(["t1"]);
  expect(attached).toHaveLength(1);
  connection.stop();
  await run;
});

test("refused: outdated exits 3, replaced exits 0", async () => {
  for (const [reason, exitCode] of [
    ["outdated", 3],
    ["replaced", 0],
    ["invalid_token", 2],
  ] as const) {
    const { sockets, connection } = setup();
    const done = connection.run();
    await waitFor(() => sockets.length === 1);
    sock(sockets, 0).handlers.onOpen();
    sock(sockets, 0).frame({ type: "refused", reason, message: reason });
    expect((await done).exitCode).toBe(exitCode);
  }
});

test("reconnects when the socket closes, and when no ping arrives for two heartbeats", async () => {
  const { sockets, connection, lines } = setup();
  const done = connection.run();
  await waitFor(() => sockets.length === 1);
  const first = sock(sockets, 0);
  first.handlers.onOpen();
  first.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 30 });
  // No ping: the watchdog closes it after 60 ms, then backoff (at once with random 0) dials again.
  await waitFor(() => sockets.length === 2, 4000);
  expect(first.closed).toBe(true);
  expect(lines).toContain("no ping from the server; reconnecting");

  const second = sock(sockets, 1);
  second.handlers.onOpen();
  await waitFor(() => second.sent.length === 1);
  expect(second.sent[0]?.type).toBe("hello");
  // The server drops it: dial again.
  second.handlers.onClose(1006, "");
  await waitFor(() => sockets.length === 3, 4000);

  connection.stop();
  expect((await done).reason).toBe("stopped");
}, 15_000);

test("any frame from the server keeps the link; silence for two heartbeats still drops it", async () => {
  const { sockets, connection, lines } = setup();
  const done = connection.run();
  await waitFor(() => sockets.length === 1);
  const first = sock(sockets, 0);
  first.handlers.onOpen();
  first.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 30 });
  // No ping for five heartbeats, but the server keeps talking (a busy server's pings come late).
  for (let i = 0; i < 10; i++) {
    await Bun.sleep(15);
    first.frame({ type: "task.ack", taskId: "t1" });
  }
  expect(first.closed).toBe(false);
  await waitFor(() => first.closed, 1000);
  expect(lines).toContain("no ping from the server; reconnecting");
  connection.stop();
  expect((await done).reason).toBe("stopped");
});

test("a server that says it is stopping is dialed again at a random point within the spread, not at once", async () => {
  expect(serverStopDelay(() => 0)).toBe(1000);
  expect(serverStopDelay(() => 1)).toBe(SERVER_STOP_SPREAD_MS);
  const { sockets, connection, lines } = setup({ random: () => 0.5 });
  const done = connection.run();
  await waitFor(() => sockets.length === 1);
  const first = sock(sockets, 0);
  first.handlers.onOpen();
  first.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
  first.handlers.onClose(1001, "server stopping");
  await waitFor(() => lines.some((l) => l.startsWith("disconnected; reconnecting in")));
  expect(lines).toContain("disconnected; reconnecting in 15.5 s");
  connection.reconnect();
  await waitFor(() => sockets.length === 2, 300);
  const second = sock(sockets, 1);
  second.handlers.onOpen();
  second.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
  // Any other drop: the usual backoff, a random point within the step (the second: that session was brief).
  second.handlers.onClose(1006, "");
  await waitFor(() => lines.includes("disconnected; reconnecting in 1.0 s"));
  connection.stop();
  expect((await done).reason).toBe("stopped");
});

test("a session dropped soon after its welcome doesn't start the waits over; a retry-after in the close is waited out", async () => {
  const { sockets, connection, lines } = setup({ random: () => 0.5 });
  const done = connection.run();
  await waitFor(() => sockets.length === 1);
  // Welcomed, then dropped at once (an overloaded server): the waits keep growing, 0.5 s, then 1 s.
  const first = sock(sockets, 0);
  first.handlers.onOpen();
  first.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
  first.handlers.onClose(1006, "");
  await waitFor(() => lines.includes("disconnected; reconnecting in 0.5 s"));
  await waitFor(() => sockets.length === 2, 2000);
  const second = sock(sockets, 1);
  second.handlers.onOpen();
  second.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
  second.handlers.onClose(1006, "");
  await waitFor(() => lines.includes("disconnected; reconnecting in 1.0 s"));
  await waitFor(() => sockets.length === 3, 3000);
  // The server asks for 5 s: at least that, spread over as long again (random 0.5 → 7.5 s).
  sock(sockets, 2).handlers.onClose(1011, "try again; retry-after=5");
  await waitFor(() => lines.includes("disconnected; reconnecting in 7.5 s"));
  connection.stop();
  expect((await done).reason).toBe("stopped");
}, 10_000);

test("reconnect(): drops the welcomed socket and dials again without backoff; while backing off, dials now", async () => {
  const { sockets, connection, lines } = setup({ random: () => 0.99 });
  const done = connection.run();
  await waitFor(() => sockets.length === 1);
  const first = sock(sockets, 0);
  first.handlers.onOpen();
  first.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
  connection.reconnect();
  await waitFor(() => sockets.length === 2, 300);
  expect(first.closed).toBe(true);
  expect(lines).toContain("reconnecting now (asked by the app)");

  // The server drops it before welcome: a backoff starts; reconnect() cuts it short.
  sock(sockets, 1).handlers.onClose(1006, "");
  await waitFor(() => lines.some((l) => l.startsWith("disconnected; reconnecting in")));
  connection.reconnect();
  await waitFor(() => sockets.length === 3, 300);

  connection.stop();
  expect((await done).reason).toBe("stopped");
});

test("a browser command is logged when it ends, with how long it took and what it waited on first", async () => {
  const lines: string[] = [];
  const ws = tempDir();
  dirs.push(ws);
  const setup = { launch: 1400, worker: 1200, install: 28_140, bogus: 7 };
  const runner = new RequestRunner(
    { workspaceReal: ws, exec: true, token: "agm_x" },
    () => {},
    (l) => lines.push(l),
    async (_ctx, req) => {
      if (req.op === "browser.warm") return { started: true, setup: { desktop: 2300, launch: 1400 } };
      if (req.op === "browser.batch") return { answers: [], setup };
      return req.op === "browser.act" && req.command === "click" ? { success: false, setup } : { success: true };
    },
  );
  const agent = { id: "01a142cb-489d-7000-87a3-efb5adb382ca", handle: "dev" };
  await runner.start("a", { op: "browser.act", agent, command: "snapshot", args: [], timeoutSeconds: 30 });
  await runner.start("b", { op: "browser.act", agent, command: "click", args: ["@e1"], timeoutSeconds: 30 });
  await runner.start("c", { op: "list", path: "", depth: 1 });
  const open = { command: "open", args: ["https://a.example/"], timeoutSeconds: 60 };
  await runner.start("d", { op: "browser.batch", agent, commands: [open] });
  await runner.start("e", { op: "browser.warm", agent, desktop: true });
  expect(lines[0]).toMatch(/^\[dev\] browser\.act snapshot \d+ms$/);
  expect(lines[1]).toMatch(
    /^\[dev\] browser\.act click \d+ms \(failed, worker 1\.2 s, install 28\.1 s, launch 1\.4 s\)$/,
  );
  expect(lines[2]).toBe("list .");
  expect(lines[3]).toMatch(/^\[dev\] browser\.batch open \d+ms \(worker 1\.2 s, install 28\.1 s, launch 1\.4 s\)$/);
  expect(lines[4]).toMatch(/^\[dev\] browser\.warm \(desktop\) \d+ms \(desktop 2\.3 s, launch 1\.4 s\)$/);
});

test("a refused brain turn is logged with its code and words, whatever the code; a canceled one and another op's expected refusal aren't", async () => {
  const lines: string[] = [];
  const ws = tempDir();
  dirs.push(ws);
  const runner = new RequestRunner(
    { workspaceReal: ws, exec: true, token: "agm_x" },
    () => {},
    (l) => lines.push(l),
    async (_ctx, req) => {
      if (req.op === "brain.turn" && req.runId === "c") throw new RunnerError("internal", "Canceled");
      throw new RunnerError("not_found", "No such file or folder");
    },
    { memAvailable: () => null },
  );
  const agent = { id: "01a142cb-489d-7000-87a3-efb5adb382ca", handle: "dev" };
  await runner.start("t", { op: "brain.turn", runId: "t", agent } as unknown as MachineRequest);
  await runner.start("c", { op: "brain.turn", runId: "c", agent } as unknown as MachineRequest);
  await runner.start("l", { op: "list", path: "", depth: 1 });
  expect(lines.filter((l) => l.includes("failed"))).toEqual(["brain.turn failed (not_found): No such file or folder"]);
});

test("requests run concurrently up to the ceiling; beyond it the runner answers busy (never to a person's view); cancel aborts", async () => {
  const ws = tempDir();
  dirs.push(ws);
  const sent: Record<string, unknown>[] = [];
  const release: (() => void)[] = [];
  const runner = new RequestRunner(
    { workspaceReal: ws, exec: true, token: "agm_x" },
    (f) => sent.push(f as unknown as Record<string, unknown>),
    () => {},
    (_ctx, _req, scope) =>
      new Promise((resolve, reject) => {
        release.push(() => resolve({ done: true }));
        scope.signal.addEventListener("abort", () => reject(new RunnerError("internal", "Canceled")));
      }),
  );
  const started = Array.from({ length: MAX_IN_FLIGHT }, (_, i) =>
    runner.start(`r${i}`, { op: "list", path: "", depth: 1 }),
  );
  expect(runner.size).toBe(MAX_IN_FLIGHT);
  await runner.start("over", { op: "list", path: "", depth: 1 });
  expect(sent).toEqual([{ type: "result", id: "over", ok: false, error: { code: "internal", message: "busy" } }]);
  // A person's view of an agent still opens on a computer full of agents' work.
  const agent = { id: "01a142cb-489d-7000-87a3-efb5adb382ca", handle: "dev" };
  const view = runner.start("v", {
    op: "stream.open",
    streamId: "s".repeat(43),
    kind: "desktop",
    mode: "watch",
    agent,
  });
  expect(runner.size).toBe(MAX_IN_FLIGHT + 1);
  expect(sent).toHaveLength(1);

  runner.cancel("r0");
  await started[0];
  expect(sent[1]).toEqual({ type: "result", id: "r0", ok: false, error: { code: "internal", message: "Canceled" } });

  release[1]?.();
  await started[1];
  expect(sent[2]).toEqual({ type: "result", id: "r1", ok: true, data: { done: true } });

  runner.close();
  await Promise.all([...started, view]);
  expect(sent.length).toBe(3);
  expect(runner.size).toBe(0);
});

test("a locked-down turn goes past the room check down to its own floor, and a little past the count where memory isn't known", async () => {
  const ws = tempDir();
  dirs.push(ws);
  const sent: { id: string; ok: boolean; error?: { code: string } }[] = [];
  const pending: Promise<void>[] = [];
  let free: number | null = MIN_FREE_BYTES - 1;
  const runner = new RequestRunner(
    { workspaceReal: ws, exec: true, token: "agm_x" },
    (f) => sent.push(f as unknown as (typeof sent)[number]),
    () => {},
    (_ctx, _req, scope) =>
      new Promise((_, reject) => {
        scope.signal.addEventListener("abort", () => reject(new RunnerError("internal", "Canceled")));
      }),
    { memAvailable: () => free, now: () => 1_000_000 },
  );
  const turn = (id: string, locked: boolean) => {
    const req = { op: "brain.turn", runId: id, ...(locked ? { permissions: { mode: "chat" } } : {}) };
    pending.push(runner.start(id, req as unknown as MachineRequest));
  };
  const refused = () => sent.filter((f) => f.id && !f.ok).map((f) => f.id);

  // Below the floor everyone else keeps: past the one turn always let in, the agents' turn waits, the locked-down one runs.
  turn("first", false);
  turn("work", false);
  turn("lodi", true);
  expect(refused()).toEqual(["work"]);
  expect(runner.size).toBe(2);

  // A computer about to run out turns it away too, and what it just admitted counts.
  free = LOCKED_TURN_MIN_FREE_BYTES + TURN_BYTES - 1;
  turn("lodi2", true);
  expect(refused()).toEqual(["work", "lodi2"]);

  // Where memory isn't known room is a count of turns: it doesn't count against it.
  free = null;
  for (let i = 0; i < TURNS_WITHOUT_MEMORY - 2; i++) turn(`c${i}`, false);
  turn("over", false);
  turn("lodi3", true);
  expect(refused()).toEqual(["work", "lodi2", "over"]);
  // A bound still: a turn it can't measure is no reason to run any number of them.
  turn("lodi4", true);
  turn("lodi5", true);
  expect(refused()).toEqual(["work", "lodi2", "over", "lodi5"]);
  runner.close();
  await Promise.allSettled(pending);
});

test("on Windows and macOS turns are admitted by the memory the computer reads, not 8 at once", async () => {
  const ws = tempDir();
  dirs.push(ws);
  const sent: { id: string; ok: boolean; error?: { code: string } }[] = [];
  const pending: Promise<void>[] = [];
  const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  Object.defineProperty(process, "platform", { value: "win32" });
  let free = 64e9;
  const freemem = spyOn(os, "freemem").mockImplementation(() => free);
  try {
    const runner = new RequestRunner(
      { workspaceReal: ws, exec: true, token: "agm_x" },
      (f) => sent.push(f as unknown as (typeof sent)[number]),
      () => {},
      (_ctx, _req, scope) =>
        new Promise((_, reject) => {
          scope.signal.addEventListener("abort", () => reject(new RunnerError("internal", "Canceled")));
        }),
      { now: () => 1_000_000 },
    );
    const turn = (id: string) =>
      pending.push(runner.start(id, { op: "brain.turn", runId: id } as unknown as MachineRequest));
    // A 64 GB PC with most of it free runs more than the old count.
    for (let i = 0; i < TURNS_WITHOUT_MEMORY + 4; i++) turn(`t${i}`);
    expect(sent.filter((f) => !f.ok)).toEqual([]);
    expect(runner.size).toBe(TURNS_WITHOUT_MEMORY + 4);
    // Short of memory, the next one waits for room, as on Linux.
    free = MIN_FREE_BYTES - 1;
    turn("over");
    expect(sent.filter((f) => !f.ok).map((f) => [f.id, f.error?.code])).toEqual([["over", "no_slot"]]);
    runner.close();
    await Promise.allSettled(pending);
  } finally {
    freemem.mockRestore();
    Object.defineProperty(process, "platform", platform);
  }
});

describe("the slot held for a person's turn", () => {
  const room = (
    over: {
      free?: number | null;
      reclaimBrains?: () => Promise<boolean>;
      warmBrain?: (spare: string) => Promise<boolean>;
    } = {},
  ) => {
    const ws = tempDir();
    dirs.push(ws);
    const sent: { type: string; id: string; ok: boolean; error?: { code: string } }[] = [];
    const release = new Map<string, () => void>();
    const s = { free: "free" in over ? over.free : MIN_FREE_BYTES - 1, now: 1_000_000 };
    const runner = new RequestRunner(
      { workspaceReal: ws, exec: true, token: "agm_x", reclaimBrains: over.reclaimBrains, warmBrain: over.warmBrain },
      (f) => sent.push(f as unknown as (typeof sent)[number]),
      () => {},
      (_ctx, req) =>
        new Promise((resolve) => {
          release.set((req as { runId?: string }).runId ?? "", () => resolve({}));
        }),
      { memAvailable: () => s.free ?? null, now: () => s.now, roomPollMs: 5 },
    );
    const turn = (id: string, flags: Record<string, unknown> = {}) =>
      runner.start(id, { op: "brain.turn", runId: id, ...flags } as unknown as MachineRequest);
    const person = (id: string) => turn(id, { personWaiting: true });
    const refused = () => sent.filter((f) => f.type === "result" && !f.ok).map((f) => f.id);
    const freed = () => sent.filter((f) => f.type === "room.freed").length;
    const end = async (id: string) => {
      release.get(id)?.();
      await waitFor(() => sent.some((f) => f.id === id));
    };
    const started = (id: string) => release.has(id);
    const slowNotes = () =>
      sent.flatMap((f) => {
        const e = f as unknown as { type: string; runId: string; event?: { type: string; text: string } };
        return e.type === "brain.event" && e.event?.type === "note" && e.event.text === PAST_FLOOR_NOTE
          ? [e.runId]
          : [];
      });
    return { s, runner, turn, person, refused, freed, end, started, slowNotes };
  };

  test("a computer that always reads short still runs turns: one while none runs, whatever the reading, told it may be slow", async () => {
    const r = room({ free: 0.1e9 });
    void r.turn("agent");
    expect(r.started("agent")).toBe(true);
    expect(r.slowNotes()).toEqual(["agent"]);
    // One at a time: the rest wait, a person's turn too.
    await r.turn("agent2");
    await r.person("ana");
    expect(r.refused()).toEqual(["agent2", "ana"]);
    await r.end("agent");
    void r.person("ana");
    expect(r.started("ana")).toBe(true);
    expect(r.slowNotes()).toEqual(["agent", "ana"]);
    r.runner.close();
  });

  test("a turn refused for room for ROOM_WAIT_MAX_MS runs under the floor, one such turn at a time", async () => {
    const r = room({ free: MIN_FREE_BYTES + 1 });
    void r.turn("ok");
    expect(r.slowNotes()).toEqual([]);
    r.s.free = 0.1e9;
    await r.turn("late");
    await r.turn("later");
    r.s.now += ROOM_WAIT_MAX_MS - 1;
    await r.turn("late");
    expect(r.refused()).toEqual(["late", "later", "late"]);
    r.s.now += 1;
    void r.turn("late");
    expect(r.started("late")).toBe(true);
    expect(r.slowNotes()).toEqual(["late"]);
    // "later" waited as long, but one turn already runs under the floor.
    await r.turn("later");
    expect(r.refused()).toEqual(["late", "later", "late", "later"]);
    await r.end("late");
    await waitFor(() => r.runner.size === 1);
    void r.turn("later");
    expect(r.started("later")).toBe(true);
    // A run that stopped asking starts its wait over.
    await r.turn("gone");
    r.s.now += ROOM_WAIT_MAX_MS + 1;
    await r.turn("fresh");
    await r.end("later");
    await waitFor(() => r.runner.size === 1);
    await r.turn("gone");
    expect(r.refused().slice(-3)).toEqual(["gone", "fresh", "gone"]);
    r.runner.close();
  });

  test("below the floor a person's turn goes ahead and an agent's waits; an old server's turn has no flag and waits", async () => {
    const { s, runner, turn, person, refused } = room();
    // The one turn always let in.
    void turn("first");
    s.now += TURN_SETTLE_MS;
    await turn("agent");
    expect(refused()).toEqual(["agent"]);
    void person("ana");
    expect(refused()).toEqual(["agent"]);
    expect(runner.size).toBe(2);
    runner.close();
  });

  test("one at a time: a second person waits while the slot is taken, whatever the time", async () => {
    const { s, runner, person, refused, end } = room({ free: MIN_FREE_BYTES - 1 });
    void person("ana");
    s.now += TURN_SETTLE_MS;
    await person("bia");
    expect(refused()).toEqual(["bia"]);
    await end("ana");
    void person("bia2");
    expect(refused()).toEqual(["bia"]);
    expect(runner.size).toBe(1);
    runner.close();
  });

  test("used only when no person's turn was admitted in the last TURN_SETTLE_MS, by the floor or by the slot", async () => {
    const { s, runner, person, refused, end } = room({ free: MIN_FREE_BYTES + 1 });
    // Over the floor: an ordinary admission, and it still counts.
    void person("floor");
    s.free = MIN_FREE_BYTES - 1;
    await person("soon");
    expect(refused()).toEqual(["soon"]);
    s.now += TURN_SETTLE_MS;
    void person("slot");
    await end("slot");
    // The slot is free again, but its turn isn't in the reading yet.
    s.now += TURN_SETTLE_MS - 1;
    await person("soon2");
    expect(refused()).toEqual(["soon", "soon2"]);
    s.now += 1;
    void person("later");
    expect(refused()).toEqual(["soon", "soon2"]);
    runner.close();
  });

  test("its own hard floor: under it the turn waits as ever, and a turn still settling counts", async () => {
    const { s, runner, turn, person, refused } = room({ free: PERSON_TURN_MIN_FREE_BYTES - 1 });
    void turn("first");
    s.now += TURN_SETTLE_MS;
    await person("low");
    expect(refused()).toEqual(["low"]);
    s.free = PERSON_TURN_MIN_FREE_BYTES;
    void person("fits");
    expect(refused()).toEqual(["low"]);
    expect(LOCKED_TURN_MIN_FREE_BYTES).toBeLessThan(PERSON_TURN_MIN_FREE_BYTES);
    runner.close();

    const other = room({ free: MIN_FREE_BYTES + 1 });
    void other.turn("agent");
    other.s.free = PERSON_TURN_MIN_FREE_BYTES + TURN_BYTES - 1;
    await other.person("settling");
    expect(other.refused()).toEqual(["settling"]);
    other.runner.close();
  });

  test("what it takes counts against the agents' floor", async () => {
    const { s, runner, turn, person, refused } = room();
    void person("ana");
    s.free = MIN_FREE_BYTES + TURN_BYTES - 1;
    await turn("agent");
    expect(refused()).toEqual(["agent"]);
    runner.close();
  });

  test("a burst of people's turns, all closing idle CLIs at once, gets one slot", async () => {
    const { runner, person, refused } = room({ reclaimBrains: async () => false });
    for (const id of ["a", "b", "c", "d"]) void person(id);
    await waitFor(() => refused().length === 3);
    expect(refused()).toEqual(["b", "c", "d"]);
    expect(runner.size).toBe(1);
    runner.close();
  });

  test("not where memory isn't known: there is no floor to keep", async () => {
    const { runner, turn, person, refused } = room({ free: null });
    for (let i = 0; i < TURNS_WITHOUT_MEMORY; i++) void turn(`t${i}`);
    await person("ana");
    expect(refused()).toEqual(["ana"]);
    runner.close();
  });

  test("a turn on its session's open CLI isn't counted as a new one: it goes ahead down to the person's floor", async () => {
    let closes = 0;
    const r = room({
      free: MIN_FREE_BYTES + TURN_BYTES,
      reclaimBrains: async () => {
        closes++;
        return false;
      },
      warmBrain: async (spare) => spare.endsWith(":warm"),
    });
    const turn = (id: string, session: string) => r.turn(id, { agent: { id: "ada" }, session: { id: session } });
    // One cold turn takes the room the reading shows; the next ones on open CLIs still go ahead.
    void turn("cold", "c1");
    void turn("w1", "warm");
    void turn("w2", "warm");
    await waitFor(() => r.runner.size === 3);
    expect(closes).toBe(0);
    // A cold one waits, after trying to close an idle CLI.
    await turn("cold2", "c2");
    expect(r.refused()).toEqual(["cold2"]);
    expect(closes).toBe(1);
    // Under the agents' floor it starts no process, so it still goes ahead; under the person's floor it waits.
    r.s.free = MIN_FREE_BYTES - 1;
    void turn("w3", "warm");
    await waitFor(() => r.started("w3"));
    r.s.free = PERSON_TURN_MIN_FREE_BYTES - 1;
    await turn("w4", "warm");
    expect(r.refused()).toEqual(["cold2", "w4"]);
    r.runner.close();
  });

  test("room.freed: after a refusal, once a turn ends or the memory is back over the agents' floor, once each", async () => {
    const r = room();
    void r.turn("first");
    r.s.now += TURN_SETTLE_MS;
    void r.person("ana");
    await r.turn("agent");
    expect(r.refused()).toEqual(["agent"]);
    // Nothing changed: nothing said.
    await Bun.sleep(30);
    expect(r.freed()).toBe(0);
    // Ana's turn ends: its CLI can close for the next ask.
    await r.end("ana");
    expect(r.freed()).toBe(1);
    await r.turn("agent2");
    expect(r.refused()).toEqual(["agent", "agent2"]);
    r.s.now += TURN_SETTLE_MS;
    r.s.free = MIN_FREE_BYTES;
    await waitFor(() => r.freed() === 2);
    await Bun.sleep(30);
    expect(r.freed()).toBe(2);
    r.runner.close();
  });

  test("idle CLIs close first: the slot is only for what they couldn't free", async () => {
    let idle = 1;
    let closes = 0;
    const r = room({
      reclaimBrains: async () => {
        closes++;
        if (idle === 0) return false;
        idle--;
        r.s.free = MIN_FREE_BYTES;
        return true;
      },
    });
    // Enough came back: an ordinary admission, the slot stays free for the next person.
    void r.person("floor");
    await waitFor(() => r.runner.size === 1 && closes === 1);
    r.s.free = MIN_FREE_BYTES - 1;
    r.s.now += TURN_SETTLE_MS;
    void r.person("slot");
    await waitFor(() => r.runner.size === 2);
    expect(closes).toBe(2);
    expect(r.refused()).toEqual([]);
    r.runner.close();
  });
});

test("a brain turn starts only while the computer has room; recent ones count until they grow; elsewhere a count", async () => {
  const ws = tempDir();
  dirs.push(ws);
  const sent: { id: string; ok: boolean; error?: { code: string } }[] = [];
  const release = new Map<string, () => void>();
  let free: number | null = MIN_FREE_BYTES + 2 * TURN_BYTES + 1;
  let now = 1_000_000;
  let paused = false;
  const runner = new RequestRunner(
    { workspaceReal: ws, exec: true, token: "agm_x", paused: () => paused },
    (f) => sent.push(f as unknown as (typeof sent)[number]),
    () => {},
    (_ctx, req, scope) =>
      new Promise((resolve, reject) => {
        if (paused) return reject(new RunnerError("paused", "Paused by its owner"));
        release.set((req as { runId?: string }).runId ?? req.op, () => resolve({}));
        scope.signal.addEventListener("abort", () => reject(new RunnerError("internal", "Canceled")));
      }),
    { memAvailable: () => free, now: () => now },
  );
  const running: Promise<void>[] = [];
  const start = (id: string, op = "brain.turn") => {
    const started = runner.start(id, { op, runId: id } as unknown as MachineRequest);
    running.push(started);
    return started;
  };
  const refused = () => sent.filter((f) => f.id && !f.ok).map((f) => `${f.id}:${f.error?.code}`);

  // Room for three: each one admitted counts for what it will take until the reading shows it.
  for (const id of ["t1", "t2", "t3", "t4"]) start(id);
  expect(refused()).toEqual(["t4:no_slot"]);
  // Other requests (a turn's own tool calls, a background task with its own count) never wait for room.
  start("task", "task.start");
  running.push(runner.start("list", { op: "list", path: "", depth: 1 }));
  expect(runner.size).toBe(5);

  // Grown since: the reading shows them, so they no longer count on top of it.
  now += TURN_SETTLE_MS;
  free = MIN_FREE_BYTES + TURN_BYTES / 2;
  start("t5");
  start("t6");
  expect(refused()).toEqual(["t4:no_slot", "t6:no_slot"]);

  // A paused computer says so, never that it is full.
  paused = true;
  await start("t7");
  expect(refused().at(-1)).toBe("t7:paused");
  paused = false;

  // Where the memory isn't known (not Linux), a count of the ones running.
  free = null;
  for (let i = 0; i < TURNS_WITHOUT_MEMORY - 4; i++) start(`c${i}`);
  start("c-over");
  expect(refused().at(-1)).toBe("c-over:no_slot");
  release.get("t1")?.();
  await running[0];
  start("c-next");
  expect(refused().at(-1)).toBe("c-over:no_slot");
  expect(runner.size).toBe(TURNS_WITHOUT_MEMORY + 2);

  runner.close();
  await Promise.all(running);
});

test("no room for a turn: idle warm CLIs close first, one at a time, before no_slot; never where memory isn't known", async () => {
  const ws = tempDir();
  dirs.push(ws);
  const sent: { id: string; ok: boolean; error?: { code: string; message: string } }[] = [];
  let free: number | null = MIN_FREE_BYTES - 1;
  /** Idle CLIs left, and what closing one gives back. */
  let idle = 2;
  let closes = 0;
  const spares: string[] = [];
  let release = () => {};
  const held = new Promise<unknown>((r) => {
    release = () => r({});
  });
  let slowClose: Promise<void> | null = null;
  const runner = new RequestRunner(
    {
      workspaceReal: ws,
      exec: true,
      token: "agm_x",
      reclaimBrains: async (spare) => {
        closes++;
        spares.push(spare);
        if (slowClose) await slowClose;
        if (idle === 0) return false;
        idle--;
        if (free !== null) free += 0.2e9;
        return true;
      },
    },
    (f) => sent.push(f as unknown as (typeof sent)[number]),
    () => {},
    async (_ctx, req) => ((req as unknown as { runId: string }).runId.startsWith("hold") ? held : {}),
    { memAvailable: () => free, now: () => 1_000_000 },
  );
  const turn = (id: string) =>
    runner.start(id, {
      op: "brain.turn",
      runId: id,
      agent: { id: "a1", handle: "nova" },
      session: { id: "s1" },
    } as unknown as MachineRequest);
  const outcome = (id: string) => {
    const f = sent.find((x) => x.id === id);
    return f?.ok ? "ok" : f?.error?.code;
  };

  // One closed CLI is enough: the turn runs. The turn's own session is the one spared last.
  await turn("t1");
  expect(outcome("t1")).toBe("ok");
  expect(closes).toBe(1);
  expect(spares[0]).toBe("a1:s1");
  // Not enough left to close, with a turn running: refused once nothing more can close.
  free = 10e9;
  const busy = turn("hold-busy");
  free = MIN_FREE_BYTES - 1e9;
  await turn("t2");
  expect(outcome("t2")).toBe("no_slot");
  expect(closes).toBe(3);

  // Canceled while it waits: nothing more closes for it, and it ends as canceled.
  idle = 5;
  closes = 0;
  let opened = () => {};
  slowClose = new Promise<void>((r) => {
    opened = r;
  });
  const waiting = turn("t3");
  await waitFor(() => closes === 1);
  await turn("t3");
  expect(sent.filter((f) => f.id === "t3").map((f) => f.error?.message)).toEqual(["Duplicate request id"]);
  runner.cancel("t3");
  opened();
  await waiting;
  slowClose = null;
  expect(closes).toBe(1);
  expect(sent.filter((f) => f.id === "t3").at(-1)?.error).toEqual({ code: "internal", message: "Canceled" });

  // Memory not known: room is a count of turns, so at the count nothing is closed for one more.
  free = null;
  closes = 0;
  const holding = Array.from({ length: TURNS_WITHOUT_MEMORY - 1 }, (_, i) => turn(`hold${i}`));
  await turn("t4");
  expect(outcome("t4")).toBe("no_slot");
  expect(closes).toBe(0);
  release();
  await Promise.all([busy, ...holding]);
  runner.close();
});

test("backpressure drops only browser pictures and observations are resent after reconnect", async () => {
  const egress = { ip: "8.8.8.8", country: "US" };
  const { sockets, connection } = setup({ egress: () => egress });
  const done = connection.run();
  await waitFor(() => sockets.length === 1);
  const s = sock(sockets, 0);
  s.handlers.onOpen();
  s.frame({ type: "welcome", machineId: "m1", name: "Box", heartbeatMs: 25000, observeEgress: true });
  s.frame({ type: "ping", at: 1 });
  s.frame({ type: "ping", at: 2 });
  expect(s.sent.filter((f) => f.type === "pong")).toEqual([
    { type: "pong", at: 1, egress },
    { type: "pong", at: 2 },
  ]);
  s.bufferedAmount = 3 * 1024 * 1024;
  connection.send({
    type: "browser.frame",
    agentId: "a",
    seq: 1,
    data: "eA==",
    metadata: { deviceWidth: 1, deviceHeight: 1 },
  });
  expect(s.sent.some((f) => f.type === "browser.frame")).toBe(false);
  s.frame({ type: "ping", at: 3 });
  expect(s.sent.at(-1)).toEqual({ type: "pong", at: 3 });
  s.bufferedAmount = 0;
  connection.send({
    type: "browser.frame",
    agentId: "a",
    seq: 2,
    data: "eA==",
    metadata: { deviceWidth: 1, deviceHeight: 1 },
  });
  expect(s.sent.at(-1)?.type).toBe("browser.frame");
  connection.reconnect();
  await waitFor(() => sockets.length === 2);
  const next = sock(sockets, 1);
  next.handlers.onOpen();
  next.frame({ type: "welcome", machineId: "m1", name: "Box", heartbeatMs: 25000, observeEgress: true });
  next.frame({ type: "ping", at: 4 });
  expect(next.sent.at(-1)).toEqual({ type: "pong", at: 4, egress });
  connection.stop();
  await done;
});

test("personal computers never read or emit egress, including direct out-of-band frames", async () => {
  let samples = 0;
  const { sockets, connection } = setup({
    egress: () => {
      samples++;
      return { ip: "8.8.8.8" };
    },
  });
  const done = connection.run();
  await waitFor(() => sockets.length === 1);
  const s = sock(sockets, 0);
  s.handlers.onOpen();
  s.frame({ type: "welcome", machineId: "m1", name: "Personal", heartbeatMs: 25000 });
  s.frame({ type: "ping", at: 1 });
  connection.send({ type: "pong", at: 2, egress: { ip: "8.8.8.8", country: "US" } });
  expect(samples).toBe(0);
  expect(s.sent.filter((f) => f.type === "pong")).toEqual([
    { type: "pong", at: 1 },
    { type: "pong", at: 2 },
  ]);
  connection.stop();
  await done;
});

test("a warm start runs only with room for its CLI, or on a session already open, and never closes anything", async () => {
  const ws = tempDir();
  dirs.push(ws);
  const sent: { type: string; id: string; ok: boolean; data?: unknown }[] = [];
  const ran: string[] = [];
  let free: number | null = MIN_FREE_BYTES - 1;
  let reclaimed = 0;
  const open = new Set<string>();
  const runner = new RequestRunner(
    {
      workspaceReal: ws,
      exec: true,
      token: "agm_x",
      reclaimBrains: async () => {
        reclaimed++;
        return true;
      },
      warmBrain: async (key) => open.has(key),
    },
    (f) => sent.push(f as unknown as (typeof sent)[number]),
    () => {},
    async (_ctx, req) => {
      ran.push(String((req as { session?: { id?: string } }).session?.id));
      return { open: true, started: true };
    },
    { memAvailable: () => free, now: () => 1_000_000 },
  );
  const warm = (id: string, session: string) =>
    runner.start(id, {
      op: "brain.warm",
      kind: "claude_code",
      session: { id: session, resume: false },
      cwd: "",
      agent: { id: "a1", handle: "dev" },
    } as MachineRequest);
  await warm("w1", "s1");
  expect(sent.at(-1)).toEqual({ type: "result", id: "w1", ok: true, data: { open: false, started: false } });
  open.add("a1:s2");
  await warm("w2", "s2");
  free = MIN_FREE_BYTES + TURN_BYTES;
  await warm("w3", "s3");
  expect(ran).toEqual(["s2", "s3"]);
  expect(reclaimed).toBe(0);
  runner.close();
});

test("while memory is short, one idle CLI closes per look; with room, none", async () => {
  let free: number | null = 0.2e9;
  let closes = 0;
  const timer = closeIdleUnderPressure(
    async () => {
      closes++;
      return true;
    },
    { memAvailable: () => free, totalBytes: 1e9, everyMs: 5 },
  );
  try {
    await waitFor(() => closes >= 2, 2000);
    free = (1 - BRAIN_PRESSURE_USED) * 1e9;
    const seen = closes;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closes).toBe(seen);
    free = null;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(closes).toBe(seen);
  } finally {
    clearInterval(timer);
  }
});

test("a warm start that started nothing gives its room back to the next turn", async () => {
  const ws = tempDir();
  dirs.push(ws);
  const sent: { type: string; id: string; ok: boolean; data?: unknown }[] = [];
  const ran: string[] = [];
  // Room for one more CLI, not two.
  const runner = new RequestRunner(
    { workspaceReal: ws, exec: true, token: "agm_x", warmBrain: async () => false },
    (f) => sent.push(f as unknown as (typeof sent)[number]),
    () => {},
    async (_ctx, req) => {
      ran.push(String((req as { session?: { id?: string } }).session?.id));
      return { open: false, started: false };
    },
    { memAvailable: () => MIN_FREE_BYTES + TURN_BYTES - 1, now: () => 1_000_000 },
  );
  const warm = (id: string, session: string) =>
    runner.start(id, {
      op: "brain.warm",
      kind: "claude_code",
      session: { id: session, resume: false },
      cwd: "",
      agent: { id: "a1", handle: "dev" },
    } as MachineRequest);
  await warm("w1", "s1");
  await warm("w2", "s2");
  expect(ran).toEqual(["s1", "s2"]);
  runner.close();
});

describe("a brain turn outlives a dropped link (HELD_TURN_PROTOCOL)", () => {
  const turnRequest = (id: string, runId: string, reattach: boolean | "stop" = false) =>
    ({
      type: "request",
      id,
      op: "brain.turn",
      runId,
      kind: "claude_code",
      session: { id: "s1", resume: true },
      cwd: "",
      system: "",
      prompt: "hi",
      mcp: { token: "t" },
      ...(reattach ? { reattach } : {}),
    }) as unknown as ServerFrame;

  /** A turn that says "a" at once, whatever it is handed to `say`, and ends on `end()`. */
  function turnHandler() {
    const t = { starts: 0, aborted: 0, say: (_text: string) => {}, end: () => {} };
    const handler: ConnectionOptions["handler"] = (_ctx, req, scope) => {
      if (req.op !== "brain.turn") return Promise.resolve({});
      t.starts++;
      const say = (text: string) =>
        scope.emit?.({ type: "brain.event", runId: req.runId, event: { type: "text_delta", text } });
      say("a");
      t.say = say;
      return new Promise((resolve, reject) => {
        t.end = () => resolve({ runId: req.runId, final: { type: "done", text: "all of it" } });
        scope.signal.addEventListener("abort", () => {
          t.aborted++;
          reject(new RunnerError("internal", "Canceled"));
        });
      });
    };
    return { t, handler };
  }
  const deltas = (s: FakeSocket) =>
    s.sent.filter((f) => f.type === "brain.event").map((f) => (f.event as { text: string }).text);

  test("before: the drop aborted the turn and the server's next ask started it again; now the next link takes it over", async () => {
    const { t, handler } = turnHandler();
    const { sockets, connection } = setup({ handler });
    const done = connection.run();
    await waitFor(() => sockets.length === 1);
    const first = sock(sockets, 0);
    first.handlers.onOpen();
    first.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
    first.frame(turnRequest("t1", "run1"));
    await waitFor(() => t.starts === 1);
    expect(deltas(first)).toEqual(["a"]);

    // The link drops (a network blip, our deploy, the replica the socket was on): the turn runs on.
    first.handlers.onClose(1006, "");
    t.say("while away");
    expect(t.aborted).toBe(0);
    expect(connection.turns).toBe(1);

    await waitFor(() => sockets.length === 2, 4000);
    const second = sock(sockets, 1);
    second.handlers.onOpen();
    second.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
    second.frame(turnRequest("t2", "run1", true));
    await waitFor(() => deltas(second).length === 1);
    expect(deltas(second)).toEqual(["while away"]);
    t.say("after");
    t.end();
    await waitFor(() => second.sent.some((f) => f.type === "result"));
    expect(second.sent.find((f) => f.type === "result")).toEqual({
      type: "result",
      id: "t2",
      ok: true,
      data: { runId: "run1", final: { type: "done", text: "all of it" } },
    });
    expect(deltas(second)).toEqual(["while away", "after"]);
    expect(first.sent.some((f) => f.type === "result")).toBe(false);
    // One CLI turn, never aborted, never run twice.
    expect([t.starts, t.aborted, connection.turns]).toEqual([1, 0, 0]);

    // Nothing of that run held here (the runner restarted): a reattach is answered, never started.
    second.frame(turnRequest("t3", "run2", true));
    await waitFor(() => second.sent.some((f) => f.id === "t3"));
    expect(second.sent.find((f) => f.id === "t3")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(t.starts).toBe(1);

    connection.stop();
    await done;
  }, 15_000);

  test("one no link takes ends after the hold; one that ended meanwhile gives its result to the next link", async () => {
    const { t, handler } = turnHandler();
    const { sockets, connection } = setup({ handler, heldTurnMs: 300 });
    const done = connection.run();
    await waitFor(() => sockets.length === 1);
    const first = sock(sockets, 0);
    first.handlers.onOpen();
    first.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
    first.frame(turnRequest("t1", "run1"));
    await waitFor(() => t.starts === 1);
    first.handlers.onClose(1006, "");
    t.end();
    await waitFor(() => sockets.length === 2, 4000);
    const second = sock(sockets, 1);
    second.handlers.onOpen();
    second.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
    second.frame(turnRequest("t2", "run1", true));
    await waitFor(() => second.sent.some((f) => f.id === "t2"));
    expect(second.sent.find((f) => f.id === "t2")).toMatchObject({ ok: true, data: { runId: "run1" } });

    second.frame(turnRequest("t3", "run3"));
    await waitFor(() => t.starts === 2);
    second.handlers.onClose(1006, "");
    await waitFor(() => t.aborted === 1, 2000);
    expect(connection.turns).toBe(0);

    connection.stop();
    await done;
  }, 15_000);

  test("before: a held turn ran on after its run was canceled, beside the next run's on its CLI; now both end it", async () => {
    const { t, handler } = turnHandler();
    const { sockets, connection } = setup({ handler });
    const done = connection.run();
    await waitFor(() => sockets.length === 1);
    const first = sock(sockets, 0);
    first.handlers.onOpen();
    first.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
    first.frame(turnRequest("t1", "run1"));
    await waitFor(() => t.starts === 1);
    first.handlers.onClose(1006, "");
    await waitFor(() => sockets.length === 2, 4000);
    const second = sock(sockets, 1);
    second.handlers.onOpen();
    second.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });

    // Its run was canceled while the link was down: the server's stop ends it, and the ask gets how it ended.
    second.frame(turnRequest("t2", "run1", "stop"));
    await waitFor(() => second.sent.some((f) => f.id === "t2"));
    expect(t.aborted).toBe(1);
    expect(second.sent.find((f) => f.id === "t2")).toMatchObject({ ok: false });

    // Held again, and the next run of that conversation comes (no stop reached it): the held one ends first.
    second.frame(turnRequest("t3", "run2"));
    await waitFor(() => t.starts === 2);
    second.handlers.onClose(1006, "");
    await waitFor(() => sockets.length === 3, 4000);
    const third = sock(sockets, 2);
    third.handlers.onOpen();
    third.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
    third.frame(turnRequest("t4", "run3"));
    await waitFor(() => t.starts === 3);
    expect(t.aborted).toBe(2);
    expect(connection.turns).toBe(1);

    // A turn canceled on its live link and asked again before it unwound starts anew, never takes the canceled one.
    third.frame({ type: "cancel", id: "t4" });
    third.frame(turnRequest("t5", "run3"));
    await waitFor(() => t.starts === 4);
    expect(third.sent.find((f) => f.id === "t5")).toBeUndefined();

    connection.stop();
    await done;
  }, 20_000);

  test("stopping for good aborts a held turn at once", async () => {
    const { t, handler } = turnHandler();
    const { sockets, connection } = setup({ handler });
    const done = connection.run();
    await waitFor(() => sockets.length === 1);
    const first = sock(sockets, 0);
    first.handlers.onOpen();
    first.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
    first.frame(turnRequest("t1", "run1"));
    await waitFor(() => t.starts === 1);
    connection.stop();
    await done;
    expect(t.aborted).toBe(1);
  });
});
