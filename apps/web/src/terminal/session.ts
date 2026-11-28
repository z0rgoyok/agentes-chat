import {
  type TerminalEnd,
  terminalCloseState,
  terminalFrame,
  terminalSize,
  terminalSocketUrl,
} from "@agenteschat/client";

/** What the terminal shows: its shell opening or live, or why it closed (`dropped`: it was live, then its socket broke). */
export type TerminalState = "opening" | "live" | "dropped" | "moved" | TerminalEnd;

/** What the page tells the phone app; the app's side is `apps/mobile/src/features/coding/terminal-page.ts`. */
export type TerminalEvent =
  | { type: "ready" }
  | { type: "state"; state: TerminalState }
  /** Its computer, too old for the session's folder, started the shell in the agent's folder. */
  | { type: "folder" };

/** The keys a phone keyboard lacks, as the bytes a terminal sends for them (the app's key row). */
export const TERMINAL_KEYS = {
  Escape: "\x1b",
  Tab: "\t",
  CtrlC: "\x03",
  CtrlD: "\x04",
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
} as const;
export type TerminalKey = keyof typeof TERMINAL_KEYS;

/** The app's ground and ink, and whether it is dark (the sixteen colors programs ask for by number follow it). */
export type TerminalLook = { dark: boolean; background: string; foreground: string };

/** The sixteen colors (black, red, green, yellow, blue, magenta, cyan, white, then their bright ones), as the web's. */
const ANSI = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;
/** The web terminal's sets (`code-terminal.css`), each readable on its ground. */
const LIGHT = [
  "#24292f",
  "#c5221f",
  "#116329",
  "#8a5a00",
  "#0b5fd0",
  "#7a3fd1",
  "#1b7c83",
  "#6e7781",
  "#57606a",
  "#a40e26",
  "#1a7f37",
  "#6b4500",
  "#1a6fe0",
  "#8b5cf0",
  "#2a8d99",
  "#3d444d",
];
const DARK = [
  "#484f58",
  "#ff7b72",
  "#3fb950",
  "#d29922",
  "#58a6ff",
  "#bc8cff",
  "#39c5cf",
  "#b1bac4",
  "#6e7681",
  "#ffa198",
  "#56d364",
  "#e3b341",
  "#79c0ff",
  "#d2a8ff",
  "#56d4dd",
  "#f0f6fc",
];

/** Only a color as the app writes one reaches the terminal's theme. */
const COLOR = /^#[0-9a-f]{6}$/i;

/** xterm's theme for the app's look. */
export function terminalTheme(look: TerminalLook) {
  const background = COLOR.test(look.background) ? look.background : look.dark ? "#000000" : "#ffffff";
  const foreground = COLOR.test(look.foreground) ? look.foreground : look.dark ? "#f0f6fc" : "#24292f";
  const set = look.dark ? DARK : LIGHT;
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: look.dark ? "rgba(120, 165, 255, 0.3)" : "rgba(60, 110, 220, 0.24)",
    ...Object.fromEntries(ANSI.map((name, n) => [name, set[n]])),
  };
}

/** What the session uses of xterm's `Terminal` (a fake in tests). */
export interface Shell {
  readonly cols: number;
  readonly rows: number;
  readonly modes: { readonly applicationCursorKeysMode: boolean };
  options: { theme?: object; disableStdin?: boolean; cursorBlink?: boolean };
  write(data: Uint8Array | string): void;
  resize(cols: number, rows: number): void;
  onData(fn: (data: string) => void): unknown;
  onBinary(fn: (data: string) => void): unknown;
  onResize(fn: () => void): unknown;
  focus(): void;
  blur(): void;
  clear(): void;
  reset(): void;
}

/** The socket as the session uses it (the browser's, or a test's). */
export interface TerminalSocket {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array<ArrayBuffer> | string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
}

export interface TerminalDeps {
  createSocket: (url: string) => TerminalSocket;
  post: (event: TerminalEvent) => void;
  /** The page's room in cells, or null when it can't be read (xterm's fit). */
  room: () => { cols: number; rows: number } | null;
}

/** A binary frame's bytes (an ArrayBuffer from the browser's socket, a view from a test's); null for anything else. */
function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/**
 * A code session's terminal on a page of its own, for the phone app's WebView (ADR 0215): what the web's
 * `TerminalPane` does with its socket, without its pane around it. The page fills the WebView; the phone's keyboard
 * types into xterm itself, and the app's key row sends the keys it lacks (`key`) and a paste (`type`). The app opens
 * the shell (`open`) once it set the session's cookie, and again for "Open again"; it draws why a shell closed
 * itself, from `state`. `keep`: the terminal's name, so its shell stays on the computer while the app is away.
 */
export class TerminalSession {
  private socket: TerminalSocket | null = null;
  private state: TerminalState | null = null;
  /** The size the shell has: a new one goes once the socket is open (frames before it would be lost). */
  private shellSize = { cols: 0, rows: 0 };
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly shell: Shell,
    private readonly place: {
      orgId: string;
      agentId: string;
      sessionId: string;
      keep?: string;
      base: Parameters<typeof terminalSocketUrl>[0];
    },
    private readonly deps: TerminalDeps,
  ) {
    // Keys and pastes as UTF-8; text frames from here are only `resize` (the server closes on any other).
    shell.onData((data) => this.send(this.encoder.encode(data)));
    // Some mouse reports are bytes past 127, one per character.
    shell.onBinary((data) => this.send(Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff)));
    shell.onResize(() => this.sendSize());
  }

  /** A new socket, and so the shell again (the kept one, with a name): the first open and every "Open again". */
  open() {
    this.drop();
    this.shell.reset();
    this.shell.options.disableStdin = false;
    this.shell.options.cursorBlink = true;
    const first = this.fitted();
    this.shell.resize(first.cols, first.rows);
    this.say("opening");
    const ws = this.deps.createSocket(
      terminalSocketUrl(this.place.base, {
        orgId: this.place.orgId,
        agentId: this.place.agentId,
        cols: first.cols,
        rows: first.rows,
        session: this.place.sessionId,
        ...(this.place.keep ? { keep: this.place.keep } : {}),
      }),
    );
    this.socket = ws;
    this.shellSize = first;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => this.sendSize();
    ws.onmessage = (ev) => {
      if (this.socket !== ws) return;
      if (typeof ev.data === "string") {
        const said = terminalFrame(ev.data);
        if (said === "exit") this.say("ended");
        // Another window took this terminal: its shell goes on there, and "Open again" takes it back.
        else if (said === "moved") this.say("moved");
        else if (said === "cwd_ignored") this.deps.post({ type: "folder" });
        return;
      }
      const bytes = bytesOf(ev.data);
      if (!bytes) return;
      this.shell.write(bytes);
      if (this.state === "opening") this.say("live");
    };
    ws.onclose = (ev) => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.shell.options.disableStdin = true;
      this.shell.options.cursorBlink = false;
      const end = terminalCloseState(ev.code, ev.reason ?? "");
      // Its shell's `exit` came first: it ended, however its socket closed after.
      if (this.state === "ended" || this.state === "moved") return;
      this.say(this.state === "live" && end === "failed" ? "dropped" : end);
    };
  }

  /** One of the keys the phone keyboard lacks; an arrow as the shell asked for them (a full-screen program's way). */
  key(name: TerminalKey) {
    if (!(name in TERMINAL_KEYS)) return;
    const bytes = TERMINAL_KEYS[name];
    const arrow = name.startsWith("Arrow");
    this.send(
      this.encoder.encode(arrow ? `\x1b${this.shell.modes.applicationCursorKeysMode ? "O" : "["}${bytes}` : bytes),
    );
  }

  /** Text the app pastes, as typed. */
  type(text: string) {
    if (typeof text === "string" && text) this.send(this.encoder.encode(text));
  }

  /** The app's theme changed. */
  look(look: TerminalLook) {
    this.shell.options.theme = terminalTheme(look);
  }

  /** The keyboard, for the app's "Keyboard" button; `blur` puts it away. */
  focus() {
    this.shell.focus();
  }
  blur() {
    this.shell.blur();
  }

  /** The page's room changed (the keyboard came or went, the phone turned): the shell takes its new size. */
  fit() {
    const next = this.fitted();
    if (next.cols !== this.shell.cols || next.rows !== this.shell.rows) this.shell.resize(next.cols, next.rows);
  }

  /** The page goes: its socket with it (a kept shell stays on the computer for whoever comes back with its name). */
  end() {
    this.drop();
  }

  private sendSize() {
    const ws = this.socket;
    if (ws?.readyState !== 1) return;
    if (this.shellSize.cols === this.shell.cols && this.shellSize.rows === this.shell.rows) return;
    this.shellSize = { cols: this.shell.cols, rows: this.shell.rows };
    ws.send(JSON.stringify({ type: "resize", ...this.shellSize }));
  }

  private send(bytes: Uint8Array<ArrayBuffer>) {
    if (this.socket?.readyState === 1) this.socket.send(bytes);
  }

  /** The page's room in cells, within the sizes the server takes; a room it can't read keeps the shell's own. */
  private fitted() {
    const room = this.deps.room();
    const read = room && Number.isFinite(room.cols) && Number.isFinite(room.rows) ? room : this.shell;
    return terminalSize(read.cols, read.rows);
  }

  private drop() {
    const ws = this.socket;
    this.socket = null;
    if (!ws) return;
    ws.onclose = null;
    ws.onmessage = null;
    ws.close(1000);
  }

  private say(state: TerminalState) {
    this.state = state;
    this.deps.post({ type: "state", state });
  }
}
