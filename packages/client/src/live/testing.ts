import { fromBase64, initLiveDoc, type LiveKind, toBase64 } from "@agenteschat/live";
import {
  type AwarenessEntry,
  awarenessUpdateMessage,
  isLivePing,
  LIVE_PONG,
  LIVE_PONG_UNSAVED,
  type LiveControl,
  type LiveErrorCode,
  type LiveMode,
  MSG_AWARENESS,
  MSG_QUERY_AWARENESS,
  MSG_SYNC,
  readAwarenessUpdate,
  SYNC_STEP1,
  SYNC_STEP2,
  SYNC_UPDATE,
  syncStep1,
  syncStep2,
  updateMessage,
  writeAwarenessUpdate,
} from "@agenteschat/live/protocol";
import * as decoding from "lib0/decoding";
import * as Y from "yjs";
import type { SocketFactory, SocketLike, Timers } from "../realtime/connection";
import type { LiveLoadedState } from "./api";
import { LIVE_SOCKET_PATH } from "./connection";
import type { LiveFileState } from "./types";

/**
 * A live files server in memory, for the apps' tests (`@agenteschat/client/live/testing`). It speaks the socket's
 * protocol as `apps/server/src/realtime/live.ts` does (ADR 0196 §3): `live.ready`, its sync step 1 and who else is in
 * when a socket opens; a step 2 for each step 1; changes applied, numbered, sent to everyone else in the file and
 * answered with `live.saved`; presence relayed, and taken back when a socket goes; `{"type":"ping"}` answered; base64
 * text frames for `text=1`. Nothing is stored: a file is a `Y.Doc` here. Frames reach the apps a microtask later (or
 * on `flush()`, with `deliver: "manual"`), in order, like a network that never reorders.
 */

/** The server's own changes (another person, an agent, a restore), as one origin. */
export const FAKE_SERVER_ORIGIN = Object.freeze({ kind: "fake-server" as const });

export interface FakeLiveFile {
  id: string;
  kind: LiveKind | null;
  doc: Y.Doc;
  /** The newest change's number. */
  seq: number;
  mode: LiveMode;
  /** Who is in, by awareness client id, with the socket that said so (null: the server's own entry). */
  peers: Map<number, { clock: number; state: unknown; socket: FakeLiveSocket | null }>;
}

export interface FakeLiveServerOptions {
  /** `microtask` (the default): frames reach the apps a microtask later; `manual`: only on `flush()`. */
  deliver?: "microtask" | "manual";
  /** Answers pings (default true). */
  pong?: boolean;
  /** Answers each change with `live.saved` (default true), also one that held nothing new (default true). */
  saved?: boolean;
  savedForNoop?: boolean;
  /**
   * How long storing takes before `live.saved` goes (the real server gathers a socket's changes for 40 ms): changes
   * that come meanwhile are stored with them. Needs `timers` (the test's clock); 0, the default, answers at once.
   */
  savedDelayMs?: number;
  timers?: Pick<Timers, "setTimeout" | "clearTimeout">;
}

/** What an app sent on its socket, read (for tests to look at). */
export type FakeLiveFrame =
  | { type: "step1" }
  | { type: "step2" | "update"; update: Uint8Array }
  | { type: "awareness"; entries: AwarenessEntry[] }
  | { type: "query" }
  | { type: "ping" }
  | { type: "text"; text: string }
  | { type: "unreadable" };

type Outgoing =
  | { kind: "data"; socket: FakeLiveSocket; data: string | Uint8Array }
  | { kind: "close"; socket: FakeLiveSocket; code: number }
  | { kind: "run"; run: () => void };

/** One app's socket: the app holds it as a `SocketLike`; the server's side is the fake's. */
export class FakeLiveSocket implements SocketLike {
  readyState = 0;
  binaryType = "blob";
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  /** What the app sent, read. */
  readonly frames: FakeLiveFrame[] = [];
  /** How the app closed it, if it did. */
  closedWith: number | null = null;
  readonly fileId: string;
  readonly text: boolean;

  constructor(
    readonly url: string,
    private readonly server: FakeLiveServer,
  ) {
    const params = new Map<string, string>();
    for (const part of (url.split("?")[1] ?? "").split("&")) {
      if (!part) continue;
      const [k = "", v = ""] = part.split("=");
      params.set(decodeURIComponent(k), decodeURIComponent(v));
    }
    this.fileId = params.get("fileId") ?? "";
    this.text = params.get("text") === "1";
  }

  send(data: string | ArrayBufferLike | Uint8Array) {
    if (this.readyState !== 1) throw new Error("The socket isn't open");
    this.server.receive(this, data);
  }

  close(code = 1000) {
    if (this.readyState === 3) return;
    this.closedWith = code;
    this.readyState = 3;
    this.server.left(this);
    this.server.closeLater(this, code);
  }

  /** The changes this app sent (step 2 and updates), whether the server took them or not. */
  get updates(): Uint8Array[] {
    return this.frames.flatMap((f) => (f.type === "step2" || f.type === "update" ? [f.update] : []));
  }
}

export class FakeLiveServer {
  readonly files = new Map<string, FakeLiveFile>();
  /** Every socket made, in order. */
  readonly sockets: FakeLiveSocket[] = [];
  /** New sockets fail before opening (as a refused upgrade or no network does) while true. */
  offline = false;
  /** Sockets of these files fail before opening. */
  readonly refusing = new Set<string>();
  /** New sockets open but are never joined to their file (no `live.ready`, nothing sent) while true. */
  holdReady = false;
  /**
   * Changes are refused with this code while set (the file past its limits: `too_large`), as the real server does:
   * not applied, and the socket hears `live.error`. `askForMissing` then asks the apps for them again.
   */
  rejecting: LiveErrorCode | null = null;
  private readonly options: Required<Omit<FakeLiveServerOptions, "timers">> & Pick<FakeLiveServerOptions, "timers">;
  private outbox: Outgoing[] = [];
  private scheduled = false;
  /** Sockets whose changes are being stored (`savedDelayMs`): their `live.saved` goes when the timer ends. */
  private readonly storing = new Map<FakeLiveSocket, unknown>();

  constructor(options: FakeLiveServerOptions = {}) {
    this.options = {
      deliver: options.deliver ?? "microtask",
      pong: options.pong ?? true,
      saved: options.saved ?? true,
      savedForNoop: options.savedForNoop ?? true,
      savedDelayMs: options.savedDelayMs ?? 0,
      ...(options.timers ? { timers: options.timers } : {}),
    };
  }

  // ── Files ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * A file to serve: `init` fills it (by default a new file of `kind`, `initLiveDoc`), or `state` starts it from an
   * encoded document.
   */
  addFile(
    id: string,
    options: { kind?: LiveKind; mode?: LiveMode; init?: (doc: Y.Doc) => void; state?: Uint8Array } = {},
  ): FakeLiveFile {
    const doc = new Y.Doc();
    const { kind, init, state } = options;
    if (state) Y.applyUpdate(doc, state, FAKE_SERVER_ORIGIN);
    else if (init) doc.transact(() => init(doc), FAKE_SERVER_ORIGIN);
    else if (kind) doc.transact(() => initLiveDoc(doc, kind, { sheetName: "Sheet 1" }), FAKE_SERVER_ORIGIN);
    const file: FakeLiveFile = { id, kind: kind ?? null, doc, seq: 1, mode: options.mode ?? "edit", peers: new Map() };
    this.files.set(id, file);
    return file;
  }

  file(id: string): FakeLiveFile {
    const file = this.files.get(id);
    if (!file) throw new Error(`No live file ${id}`);
    return file;
  }

  /** `GET …/live` as the route answers it. */
  state(id: string): LiveFileState {
    const file = this.file(id);
    return {
      state: toBase64(Y.encodeStateAsUpdate(file.doc)),
      seq: file.seq,
      mode: file.mode,
      kind: file.kind ?? "spreadsheet",
    };
  }

  /** The state as `loadLiveState` reads it (a connection made by hand loads with it). */
  loadState(id: string): LiveLoadedState {
    const file = this.file(id);
    return { state: Y.encodeStateAsUpdate(file.doc), seq: file.seq, mode: file.mode, kind: file.kind };
  }

  /** A change made on the server (another person, an agent): numbered and sent to every app in the file. */
  edit(id: string, change: (doc: Y.Doc) => void) {
    const file = this.file(id);
    const update = captureUpdate(file.doc, FAKE_SERVER_ORIGIN, () =>
      file.doc.transact(() => change(file.doc), FAKE_SERVER_ORIGIN),
    );
    if (!update) return;
    file.seq++;
    for (const socket of this.openSockets(id)) this.sendBytes(socket, updateMessage(update));
  }

  /**
   * The file becomes editable or read-only for everyone in it (`live.mode`); editable again, the server asks each app
   * for what it lacks (its sync step 1), as the real one does.
   */
  setMode(id: string, mode: LiveMode) {
    const file = this.file(id);
    const was = file.mode;
    file.mode = mode;
    for (const socket of this.openSockets(id)) this.control(socket, { type: "live.mode", mode });
    if (was === "view" && mode === "edit") this.askForMissing(id);
  }

  /** The server's sync step 1 to every app in the file: each answers with what the server lacks. */
  askForMissing(id: string) {
    const file = this.file(id);
    for (const socket of this.openSockets(id)) this.sendBytes(socket, syncStep1(file.doc));
  }

  /** A version was written (`live.versions`). */
  versionsChanged(id: string) {
    for (const socket of this.openSockets(id)) this.control(socket, { type: "live.versions" });
  }

  /** Refuses something to every app in the file (`live.error`). */
  refuse(id: string, code: LiveErrorCode) {
    for (const socket of this.openSockets(id)) this.control(socket, { type: "live.error", code });
  }

  /**
   * Someone else's presence as the server's own entry (an agent at work, from another process): `null` takes it away.
   * The client id is the caller's (`agentClientId` for an agent).
   */
  setPeer(id: string, clientId: number, state: unknown | null) {
    const file = this.file(id);
    const clock = (file.peers.get(clientId)?.clock ?? 0) + 1;
    if (state === null) file.peers.delete(clientId);
    else file.peers.set(clientId, { clock, state, socket: null });
    const message = awarenessUpdateMessage(writeAwarenessUpdate([{ clientId, clock, state }]));
    for (const socket of this.openSockets(id)) this.sendBytes(socket, message);
  }

  // ── Sockets ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The apps' socket factory: addresses on `/api/live` reach this server (`fileId` and `text` from the query); others
   * go to `fallback` (the app's other sockets) or are refused.
   */
  socketFactory(fallback?: SocketFactory): SocketFactory {
    return (url) => {
      const path = /^[a-z]+:\/\/[^/?#]*([^?#]*)/i.exec(url)?.[1] ?? url.split("?")[0] ?? "";
      if (path !== LIVE_SOCKET_PATH) {
        if (fallback) return fallback(url);
        throw new Error(`No socket at ${url}`);
      }
      const socket = new FakeLiveSocket(url, this);
      this.sockets.push(socket);
      const refused = this.offline || this.refusing.has(socket.fileId) || !this.files.has(socket.fileId);
      this.push({ kind: "run", run: () => (refused ? this.fail(socket) : this.opened(socket)) });
      return socket;
    };
  }

  /** The sockets open now (of one file, or all). */
  openSockets(id?: string): FakeLiveSocket[] {
    return this.sockets.filter((s) => s.readyState === 1 && (id === undefined || s.fileId === id));
  }

  /** The last socket made. */
  last(): FakeLiveSocket | undefined {
    return this.sockets.at(-1);
  }

  /** Closes the open sockets (of one file, or all) with `code`: 1006 is a dropped network, 4403/4404 the server's. */
  closeSockets(id?: string, code = 1006) {
    for (const socket of this.openSockets(id)) this.closeSocket(socket, code);
  }

  /** Closes one socket with `code`, as the server or the network would. */
  closeSocket(socket: FakeLiveSocket, code = 1006) {
    if (socket.readyState !== 1 && socket.readyState !== 0) return;
    socket.readyState = 3;
    this.left(socket);
    this.closeLater(socket, code);
  }

  /** Delivers every frame waiting, and what delivering them made the apps send back (any delivery mode). */
  flush() {
    for (let round = 0; round < 1000 && this.outbox.length > 0; round++) {
      const batch = this.outbox;
      this.outbox = [];
      for (const item of batch) this.deliver(item);
    }
  }

  /**
   * Lets everything on its way arrive, the apps' answers to it included (and their own promises, like a state loading
   * over HTTP, a few turns long): microtasks only, so a test's fake timers don't hold it.
   */
  async settle(rounds = 400) {
    let quiet = 0;
    for (let i = 0; i < rounds && quiet < 12; i++) {
      if (this.options.deliver === "manual") this.flush();
      await Promise.resolve();
      quiet = this.outbox.length === 0 && !this.scheduled ? quiet + 1 : 0;
    }
  }

  /** Forgets everything (the end of a test). */
  destroy() {
    for (const socket of this.sockets) {
      socket.readyState = 3;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
    }
    this.outbox = [];
    for (const timer of this.storing.values()) this.options.timers?.clearTimeout(timer);
    this.storing.clear();
    for (const file of this.files.values()) file.doc.destroy();
    this.files.clear();
  }

  // ── The server's side ───────────────────────────────────────────────────────────────────────────────────────────

  /** What an app sent (its socket calls this). */
  receive(socket: FakeLiveSocket, data: string | ArrayBufferLike | Uint8Array) {
    const file = this.files.get(socket.fileId);
    if (!file) return;
    if (typeof data === "string") {
      if (data.charCodeAt(0) === 123) {
        const ping = isLivePing(data);
        socket.frames.push(ping ? { type: "ping" } : { type: "text", text: data });
        // Still storing what came before it (`savedDelayMs`): the pong says so, as the real server's does.
        if (ping && this.options.pong) this.queue(socket, this.storing.has(socket) ? LIVE_PONG_UNSAVED : LIVE_PONG);
        return;
      }
      if (!socket.text) return this.control(socket, { type: "live.error", code: "invalid" });
      let bytes: Uint8Array;
      try {
        bytes = fromBase64(data);
      } catch {
        socket.frames.push({ type: "unreadable" });
        return this.control(socket, { type: "live.error", code: "invalid" });
      }
      return this.binary(socket, file, bytes);
    }
    const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data as ArrayBuffer).slice();
    this.binary(socket, file, bytes);
  }

  private binary(socket: FakeLiveSocket, file: FakeLiveFile, bytes: Uint8Array) {
    try {
      this.read(socket, file, bytes);
    } catch {
      socket.frames.push({ type: "unreadable" });
      this.control(socket, { type: "live.error", code: "invalid" });
    }
  }

  private read(socket: FakeLiveSocket, file: FakeLiveFile, bytes: Uint8Array) {
    const decoder = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(decoder);
    if (type === MSG_SYNC) {
      const step = decoding.readVarUint(decoder);
      const payload = decoding.readVarUint8Array(decoder);
      if (step === SYNC_STEP1) {
        socket.frames.push({ type: "step1" });
        return this.sendBytes(socket, syncStep2(file.doc, payload));
      }
      if (step !== SYNC_STEP2 && step !== SYNC_UPDATE) throw new Error(`Unknown sync step ${step}`);
      socket.frames.push({ type: step === SYNC_STEP2 ? "step2" : "update", update: payload });
      if (file.mode !== "edit") return this.control(socket, { type: "live.error", code: "read_only" });
      if (this.rejecting) return this.control(socket, { type: "live.error", code: this.rejecting });
      const update = captureUpdate(file.doc, socket, () => Y.applyUpdate(file.doc, payload, socket));
      if (update) {
        file.seq++;
        const message = updateMessage(update);
        for (const other of this.openSockets(file.id)) if (other !== socket) this.sendBytes(other, message);
      }
      if (this.options.saved && (update || this.options.savedForNoop)) this.stored(socket, file);
      return;
    }
    if (type === MSG_AWARENESS) {
      const entries = readAwarenessUpdate(decoding.readVarUint8Array(decoder));
      socket.frames.push({ type: "awareness", entries });
      const taken: AwarenessEntry[] = [];
      for (const entry of entries) {
        const known = file.peers.get(entry.clientId);
        if (known && known.clock >= entry.clock) continue;
        if (entry.state === null) file.peers.delete(entry.clientId);
        else file.peers.set(entry.clientId, { clock: entry.clock, state: entry.state, socket });
        taken.push(entry);
      }
      if (taken.length === 0) return;
      const message = awarenessUpdateMessage(writeAwarenessUpdate(taken));
      for (const other of this.openSockets(file.id)) if (other !== socket) this.sendBytes(other, message);
      return;
    }
    if (type === MSG_QUERY_AWARENESS) {
      socket.frames.push({ type: "query" });
      const everyone = this.presenceOf(file);
      if (everyone.length) this.sendBytes(socket, awarenessUpdateMessage(writeAwarenessUpdate(everyone)));
      return;
    }
    throw new Error(`Unknown message ${type}`);
  }

  /** `live.saved` for what the socket sent: at once, or once storing it took `savedDelayMs` (later changes join). */
  private stored(socket: FakeLiveSocket, file: FakeLiveFile) {
    const { savedDelayMs, timers } = this.options;
    if (!(savedDelayMs > 0 && timers)) return this.control(socket, { type: "live.saved", seq: file.seq });
    if (this.storing.has(socket)) return;
    this.storing.set(
      socket,
      timers.setTimeout(() => {
        this.storing.delete(socket);
        if (socket.readyState === 1) this.control(socket, { type: "live.saved", seq: file.seq });
      }, savedDelayMs),
    );
  }

  private presenceOf(file: FakeLiveFile, except?: FakeLiveSocket): AwarenessEntry[] {
    const out: AwarenessEntry[] = [];
    for (const [clientId, p] of file.peers) {
      if (except && p.socket === except) continue;
      out.push({ clientId, clock: p.clock, state: p.state });
    }
    return out;
  }

  private opened(socket: FakeLiveSocket) {
    if (socket.readyState !== 0) return;
    const file = this.files.get(socket.fileId);
    if (!file) return this.fail(socket);
    socket.readyState = 1;
    socket.onopen?.({});
    if (socket.readyState !== 1 || this.holdReady) return;
    this.control(socket, { type: "live.ready", mode: file.mode, seq: file.seq });
    this.sendBytes(socket, syncStep1(file.doc));
    const others = this.presenceOf(file, socket);
    if (others.length) this.sendBytes(socket, awarenessUpdateMessage(writeAwarenessUpdate(others)));
  }

  /** A socket that never opens (a refused upgrade, no network): its close comes, 1006. */
  private fail(socket: FakeLiveSocket) {
    if (socket.readyState === 3) return;
    socket.readyState = 3;
    socket.onclose?.({ code: 1006 });
  }

  /**
   * A socket went (its socket calls this): its presence goes for everyone else, at the clock it last had, as the real
   * server removes it (y-protocols' `removeAwarenessStates` keeps a remote client's clock).
   */
  left(socket: FakeLiveSocket) {
    const file = this.files.get(socket.fileId);
    if (!file) return;
    const gone: AwarenessEntry[] = [];
    for (const [clientId, p] of [...file.peers]) {
      if (p.socket !== socket) continue;
      file.peers.delete(clientId);
      gone.push({ clientId, clock: p.clock, state: null });
    }
    if (gone.length === 0) return;
    const message = awarenessUpdateMessage(writeAwarenessUpdate(gone));
    for (const other of this.openSockets(file.id)) if (other !== socket) this.sendBytes(other, message);
  }

  /** The close event a socket's app hears, after what was on its way (its socket calls this too). */
  closeLater(socket: FakeLiveSocket, code: number) {
    this.push({ kind: "close", socket, code });
  }

  private control(socket: FakeLiveSocket, control: LiveControl) {
    this.queue(socket, JSON.stringify(control));
  }

  private sendBytes(socket: FakeLiveSocket, bytes: Uint8Array) {
    this.queue(socket, socket.text ? toBase64(bytes) : bytes);
  }

  private queue(socket: FakeLiveSocket, data: string | Uint8Array) {
    this.push({ kind: "data", socket, data });
  }

  private push(item: Outgoing) {
    this.outbox.push(item);
    if (this.options.deliver === "manual" || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const batch = this.outbox;
      this.outbox = [];
      for (const each of batch) this.deliver(each);
    });
  }

  private deliver(item: Outgoing) {
    if (item.kind === "run") return item.run();
    const { socket } = item;
    if (item.kind === "close") return socket.onclose?.({ code: item.code });
    if (socket.readyState !== 1) return;
    const data = item.data;
    socket.onmessage?.({ data: typeof data === "string" ? data : copyBuffer(data) });
  }
}

/** The bytes in an `ArrayBuffer` of their own (what a socket with `binaryType` "arraybuffer" hands over). */
function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/** What `run` changed in `doc` with `origin`, as one update (null when nothing). */
function captureUpdate(doc: Y.Doc, origin: unknown, run: () => void): Uint8Array | null {
  const parts: Uint8Array[] = [];
  const listen = (update: Uint8Array, from: unknown) => {
    if (from === origin) parts.push(update);
  };
  doc.on("update", listen);
  try {
    run();
  } finally {
    doc.off("update", listen);
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? (parts[0] as Uint8Array) : Y.mergeUpdates(parts);
}
