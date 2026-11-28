import { describe, expect, test } from "bun:test";
import {
  type Shell,
  type TerminalEvent,
  TerminalSession,
  type TerminalSocket,
  terminalTheme,
} from "../src/terminal/session";

/** A shell that keeps what it was told. */
function fakeShell() {
  const on: { data?: (d: string) => void; binary?: (d: string) => void; resize?: () => void } = {};
  const shell = {
    cols: 80,
    rows: 24,
    modes: { applicationCursorKeysMode: false },
    options: {} as Shell["options"],
    written: [] as (Uint8Array | string)[],
    write(data: Uint8Array | string) {
      this.written.push(data);
    },
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      on.resize?.();
    },
    onData: (fn: (d: string) => void) => {
      on.data = fn;
    },
    onBinary: (fn: (d: string) => void) => {
      on.binary = fn;
    },
    onResize: (fn: () => void) => {
      on.resize = fn;
    },
    focus() {},
    blur() {},
    clear() {},
    reset() {},
  };
  return { shell, on };
}

/** A socket that keeps what was sent, opened and closed by the test. */
function fakeSocket(url: string) {
  const sent: (Uint8Array | string)[] = [];
  const ws: TerminalSocket & { url: string; sent: typeof sent; closedWith?: number } = {
    url,
    sent,
    binaryType: "blob",
    readyState: 0,
    send: (data) => void sent.push(data),
    close(code) {
      this.closedWith = code;
      this.readyState = 3;
    },
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  return ws;
}

function setUp(room: { cols: number; rows: number } | null = { cols: 100, rows: 30 }) {
  const { shell, on } = fakeShell();
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const events: TerminalEvent[] = [];
  const session = new TerminalSession(
    shell,
    { orgId: "org_1", agentId: "ag_1", sessionId: "cs_1", keep: "phone-cs_1", base: "https://app.example.test" },
    {
      createSocket: (url) => {
        const ws = fakeSocket(url);
        sockets.push(ws);
        return ws;
      },
      post: (e) => void events.push(e),
      room: () => room,
    },
  );
  const live = () => {
    const ws = sockets.at(-1);
    if (!ws) throw new Error("no socket");
    ws.readyState = 1;
    ws.onopen?.();
    return ws;
  };
  const states = () => events.flatMap((e) => (e.type === "state" ? [e.state] : []));
  return { shell, on, session, sockets, events, live, states };
}

const text = (data: Uint8Array | string | undefined) =>
  typeof data === "string" ? data : new TextDecoder().decode(data);

describe("a code session's terminal page for the phone (ADR 0215)", () => {
  test("opening asks for the session's shell by its name, at the page's size", () => {
    const { session, sockets, shell, states } = setUp();
    session.open();
    const url = new URL(sockets[0]?.url ?? "");
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/api/terminal");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      orgId: "org_1",
      agentId: "ag_1",
      session: "cs_1",
      keep: "phone-cs_1",
      cols: "100",
      rows: "30",
    });
    expect([shell.cols, shell.rows]).toEqual([100, 30]);
    expect(sockets[0]?.binaryType).toBe("arraybuffer");
    expect(states()).toEqual(["opening"]);
  });

  test("the shell's first bytes make it live; typing goes out as bytes", () => {
    const { session, on, live, shell, states } = setUp();
    session.open();
    const ws = live();
    ws.onmessage?.({ data: new TextEncoder().encode("$ ").buffer });
    expect(text(shell.written[0])).toBe("$ ");
    expect(states()).toEqual(["opening", "live"]);
    on.data?.("ls\r");
    expect(text(ws.sent.at(-1))).toBe("ls\r");
  });

  test("the key row's keys, arrows as the shell asked for them", () => {
    const { session, live, shell } = setUp();
    session.open();
    const ws = live();
    session.key("CtrlC");
    session.key("ArrowUp");
    shell.modes.applicationCursorKeysMode = true;
    session.key("ArrowUp");
    session.type("echo hi");
    expect(ws.sent.map(text)).toEqual(["\x03", "\x1b[A", "\x1bOA", "echo hi"]);
  });

  test("a new size goes out once the socket is open, and only when it changed", () => {
    const room = { cols: 100, rows: 30 };
    const { session, live } = setUp(room);
    session.open();
    const ws = live();
    expect(ws.sent).toEqual([]);
    room.rows = 18;
    session.fit();
    session.fit();
    expect(ws.sent).toEqual([JSON.stringify({ type: "resize", cols: 100, rows: 18 })]);
  });

  test("why it closed: its shell's exit, another window, or a broken connection once live", () => {
    const ended = setUp();
    ended.session.open();
    const a = ended.live();
    a.onmessage?.({ data: '{"type":"exit"}' });
    a.onclose?.({ code: 1006 });
    expect(ended.states()).toEqual(["opening", "ended"]);

    const moved = setUp();
    moved.session.open();
    moved.live().onmessage?.({ data: '{"type":"moved"}' });
    expect(moved.states().at(-1)).toBe("moved");

    const dropped = setUp();
    dropped.session.open();
    const c = dropped.live();
    c.onmessage?.({ data: new Uint8Array([36]) });
    c.onclose?.({ code: 1006 });
    expect(dropped.states().at(-1)).toBe("dropped");
    expect(dropped.shell.options.disableStdin).toBe(true);

    const refused = setUp();
    refused.session.open();
    refused.sockets[0]?.onclose?.({ code: 4502, reason: "runner_outdated" });
    expect(refused.states().at(-1)).toBe("outdated");
  });

  test("a computer too old for the session's folder is told to the app", () => {
    const { session, live, events } = setUp();
    session.open();
    live().onmessage?.({ data: '{"type":"cwd_ignored"}' });
    expect(events).toContainEqual({ type: "folder" });
  });

  test("opening again drops the old socket quietly; the page going closes it", () => {
    const { session, sockets, states } = setUp();
    session.open();
    session.open();
    expect(sockets[0]?.closedWith).toBe(1000);
    expect(sockets[0]?.onclose).toBeNull();
    expect(states()).toEqual(["opening", "opening"]);
    session.end();
    expect(sockets[1]?.closedWith).toBe(1000);
  });

  test("the theme takes only colors as the app writes them", () => {
    const dark = terminalTheme({ dark: true, background: "#101010", foreground: "url(x)" });
    expect(dark.background).toBe("#101010");
    expect(dark.foreground).toBe("#f0f6fc");
    expect(terminalTheme({ dark: false, background: "", foreground: "#222222" }).background).toBe("#ffffff");
  });
});
