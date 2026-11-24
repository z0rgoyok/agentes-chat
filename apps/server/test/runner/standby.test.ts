import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, type ServerFrame } from "@agenteschat/adapters/machine-protocol";
import { type Dial, RunnerConnection, type Socket, type SocketHandlers } from "../../runner/connection";
import { bootId } from "../../runner/lock";
import {
  ackStandby,
  askStandby,
  readStandby,
  STANDBY_POLL_MS,
  standbyAcked,
  standbyOn,
  watchStandby,
} from "../../runner/standby";
import { removeDirs, tempDir, waitFor } from "./helpers";

/** An operator's standby (ADR 0176): no link to the server, everything else runs, and it ends by itself. */

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

class FakeSocket implements Socket {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  constructor(readonly handlers: SocketHandlers) {}
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.handlers.onClose(1000, ""));
  }
  frame(f: ServerFrame) {
    this.handlers.onMessage(JSON.stringify(f));
  }
}

function connection() {
  const ws = tempDir();
  dirs.push(ws);
  const sockets: FakeSocket[] = [];
  const dial: Dial = (_url, handlers) => {
    const s = new FakeSocket(handlers);
    sockets.push(s);
    return s;
  };
  const states: string[] = [];
  const c = new RunnerConnection({
    url: "wss://agentes.test/api/machines/connect",
    token: "agm_token",
    info: {
      version: "0.1.0",
      protocol: MACHINE_PROTOCOL_VERSION,
      os: "linux",
      arch: "x64",
      hostname: "box",
      workspace: ws,
      exec: false,
    },
    context: { workspaceReal: ws, exec: false, token: "agm_token" },
    dial,
    // The longest point of each wait (a random point within the step): the first dial again waits about 1 s.
    random: () => 0.99,
    onState: (s) => states.push(s),
  });
  return { c, sockets, states };
}

test("standby closes the socket and dials nothing until resume, which dials at once", async () => {
  const { c, sockets, states } = connection();
  const done = c.run();
  await waitFor(() => sockets.length === 1);
  const first = sockets[0] as FakeSocket;
  first.handlers.onOpen();
  first.frame({ type: "welcome", machineId: "m1", name: "Box", heartbeatMs: 25_000 });
  expect(c.online).toBe(true);
  c.standby();
  expect(first.closed).toBe(true);
  expect(c.online).toBe(false);
  expect(c.inStandby).toBe(true);
  expect(states.at(-1)).toBe("offline");
  // Well past the first backoff: still no new socket.
  await Bun.sleep(1500);
  expect(sockets).toHaveLength(1);
  c.resume();
  await waitFor(() => sockets.length === 2, 500);
  c.stop();
  expect((await done).reason).toBe("stopped");
});

test("standby asked while it waits to dial again holds the next dial too", async () => {
  const { c, sockets } = connection();
  const done = c.run();
  await waitFor(() => sockets.length === 1);
  // The server went away: it waits out a backoff, and standby comes meanwhile.
  (sockets[0] as FakeSocket).close();
  await Bun.sleep(20);
  c.standby();
  await Bun.sleep(1500);
  expect(sockets).toHaveLength(1);
  c.stop();
  await done;
});

test("the ask: in force in this boot until its running minutes pass; resume and another boot's ask aren't", () => {
  const home = tempDir();
  dirs.push(home);
  const ask = askStandby(home, 5, 1000);
  expect(readStandby(home)).toEqual(ask);
  expect(ask.until).toBe(1300);
  expect(standbyOn(ask, 1299, bootId())).toBe(true);
  // Running time, not the wall clock: a paused computer doesn't count it.
  expect(standbyOn(ask, 1300, bootId())).toBe(false);
  expect(standbyOn(ask, 1100, "another-boot")).toBe(false);
  expect(standbyOn(askStandby(home, 0, 1000), 1001)).toBe(false);
  expect(standbyAcked(home, ask.id)).toBe(false);
  ackStandby(home, ask.id);
  expect(standbyAcked(home, ask.id)).toBe(true);
});

test("a written ask is seen at once, well before the next poll; the runner's own answer isn't an ask", async () => {
  const home = tempDir();
  dirs.push(home);
  let seen = 0;
  const stop = watchStandby(home, () => seen++);
  try {
    ackStandby(home, "a1");
    await Bun.sleep(50);
    expect(seen).toBe(0);
    const started = Date.now();
    askStandby(home, 0);
    await waitFor(() => seen > 0, STANDBY_POLL_MS / 2);
    expect(Date.now() - started).toBeLessThan(STANDBY_POLL_MS / 2);
  } finally {
    stop();
  }
  const after = seen;
  askStandby(home, 0);
  await Bun.sleep(50);
  expect(seen).toBe(after);
});

test("a folder that can't be watched leaves the poll alone", () => {
  expect(() => watchStandby("/nonexistent/agentes-runner-home", () => {})()).not.toThrow();
});
