import { fromBase64, LIVE_LIMITS, type LiveKind, REMOTE, toBase64 } from "@agenteschat/live";
import {
  awarenessMessage,
  isLivePong,
  LIVE_CLOSE,
  LIVE_PING,
  type LiveErrorCode,
  type LiveMode,
  MSG_AWARENESS,
  MSG_QUERY_AWARENESS,
  MSG_SYNC,
  parseControl,
  pongUnsaved,
  readMessage,
  SYNC_STEP1,
  SYNC_STEP2,
  syncStep1,
  updateMessage,
} from "@agenteschat/live/protocol";
import * as decoding from "lib0/decoding";
import { type Awareness, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";
import { ApiError } from "../api/http";
import { type SocketBase, type SocketFactory, type SocketLike, socketUrl, type Timers } from "../realtime/connection";
import type { LiveLoadedState } from "./api";
import type { LiveFileStatus, LiveRoomError } from "./types";

/**
 * One live file's connection (ADR 0196 §3), the same in the browser, the desktop app and the phone:
 *
 * - The document comes first over HTTP (`loadState`, applied as `REMOTE`), so a large file never waits behind the
 *   socket, which then only catches up from its state vector: on `live.ready` this side sends its sync step 1 and its
 *   presence, answers the server's step 1 with what the server lacks (changes made offline included), and is `live`
 *   once the server's step 2 came.
 * - Every change made here (any origin but `REMOTE`) goes out, merged over `sendDelayMs`, in frames under the
 *   server's cap and at a pace under its rate, in order. Nothing is sent in `view` mode: changes wait for `edit`.
 * - Changes stay counted as unsent (`unsent`, `unsentUpdate()`) until the server has them stored, as far as this side
 *   can tell: a `live.saved` ("everything this socket sent up to now is stored", said only once none of its frames
 *   waits in the server's line) covers what the server had received when it said so, which a pong proves for what was
 *   sent before its ping, or the round trip for what was sent long enough before it came; a pong without `unsaved`
 *   says what came before its ping is stored (or held nothing new), one with it says to wait for `live.saved`. A
 *   change the server refused (`live.error`) stays unsent until a new socket offers it again.
 * - It reconnects with backoff after any close but 4403 and 4404 (`closed` with `forbidden` / `not_found`); when
 *   sockets keep failing before they open (the upgrade's own 401/403/404 look like a dropped connection), the HTTP
 *   state is asked again now and then, which says why. It pings (at most one in flight, never within a second of the
 *   last answer: the server answers no faster), and a socket that hears nothing back in time is replaced.
 * - Presence (awareness) goes out throttled (`awarenessMs`); others' presence is dropped while the socket is down.
 * - `stop()` sends what can still go, says goodbye (the room clears this side's presence first) and removes every
 *   listener and timer it set.
 */

/** A live file's socket. */
export const LIVE_SOCKET_PATH = "/api/live";

/** `wss://…/api/live?orgId=…&fileId=…`; `textFrames` (the phone): bytes as base64 text frames (`text=1`). */
export function liveSocketUrl(base: SocketBase, orgId: string, fileId: string, options: { textFrames?: boolean } = {}) {
  return socketUrl(base, LIVE_SOCKET_PATH, { orgId, fileId, ...(options.textFrames ? { text: 1 } : {}) });
}

/** The waits before opening a socket again; a socket that caught up starts them over. */
export const LIVE_BACKOFF_MS = [500, 1000, 2000, 5000, 10_000, 20_000];

/**
 * How much of each wait is left to chance (up to this share shorter), so the apps a restarting server dropped at once
 * don't all come back at the same moment.
 */
export const LIVE_BACKOFF_JITTER = 0.25;

/** The connection's timing (tests pass shorter ones). */
export const LIVE_TIMING = {
  /** A socket that opened and heard no `live.ready` in this long is replaced (the server joins in well under it). */
  readyTimeoutMs: 20_000,
  /** How often an idle socket pings. */
  pingMs: 30_000,
  /** How long after a ping with nothing heard back the socket counts as dead. */
  pongTimeoutMs: 10_000,
  /** The least time between pings, from the last ping or its answer: the server answers at most one a second. */
  pingGapMs: 1050,
  /** Presence goes at most this often (a pointer moves many times a second). */
  awarenessMs: 60,
  /** Changes made within this window go as one frame. */
  sendDelayMs: 20,
  /** After a pong or a `live.saved`, when to look again at what they proved stored (never silence alone). */
  savedSettleMs: 1000,
};

export type LiveTiming = typeof LIVE_TIMING;

/** Bytes this side sends a second at most (the server takes 512 KiB a second, then makes frames wait). */
export const LIVE_SEND_RATE = 448 * 1024;
const SEND_BURST = 512 * 1024;
/** Changes merged into one frame up to about this size; past it they go in more frames. */
const FRAME_TARGET = 256 * 1024;
/** The server refuses a frame past this (`live.error` `too_large`). */
export const LIVE_MAX_FRAME_BYTES = LIVE_LIMITS.updateBytes;
/** Waiting changes merged into one past this many, so a long time offline keeps a short list. */
const MERGE_PAST = 64;
/** Our own close for a socket that went silent or sent what can't be read. */
const CLOSE_STALE = 4000;
/** Sockets that failed to open in a row before the HTTP state is asked why, and how often after that. */
const PROBE_AFTER = 2;
const PROBE_EVERY = 4;
/** Sockets the server closed as a bad request in a row before the file is closed as unreadable. */
const BAD_CLOSES = 3;
const OPEN = 1;

/** Changes put back from the phone's storage (`restore`): sent like the person's own, never undone by them. */
export const LIVE_RESTORED: { readonly kind: "restored" } = Object.freeze({ kind: "restored" as const });

/** Where the connection is, as the room and the screens read it (a new object on every change). */
export interface LiveConnectionState {
  status: LiveFileStatus;
  mode: LiveMode;
  /** Changes made here the server hasn't stored yet, as far as this side knows. */
  unsent: boolean;
  /** Why it closed for good, or the last thing the server refused (cleared once that no longer holds). */
  error: LiveRoomError | null;
  /** The document has the server's content (from HTTP or the socket). */
  loaded: boolean;
  /** The newest change of the server's this app knows of. */
  seq: number;
  /** The kind, once given or the state said it. */
  kind: LiveKind | null;
}

export interface LiveConnectionOptions {
  /** The socket's address (`liveSocketUrl`). */
  url: string;
  createSocket: SocketFactory;
  doc: Y.Doc;
  awareness: Awareness;
  /** The document over HTTP (`loadLiveState`): first, and now and then when sockets keep failing to open. */
  loadState?: () => Promise<LiveLoadedState>;
  /** Bytes as base64 text frames (the phone: React Native hands binary frames to JavaScript as base64 anyway). */
  textFrames?: boolean;
  /** The mode until the server says (`view`, the default, sends nothing). */
  mode?: LiveMode;
  kind?: LiveKind | null;
  timers?: Timers;
  /** Milliseconds, for the round trip, the pace and the settle (tests pass their clock). */
  now?: () => number;
  backoffMs?: number[];
  /** `LIVE_BACKOFF_JITTER` unless given (tests pass 0); `random` in [0, 1), `Math.random` by default. */
  backoffJitter?: number;
  random?: () => number;
  timing?: Partial<LiveTiming>;
  /** Bytes a second at most (`LIVE_SEND_RATE`). */
  sendRate?: number;
}

/** A change made here, until the server has it. */
interface Pending {
  update: Uint8Array;
  /** The frame of this socket that carried it (counted from 1); 0: not sent on this socket yet. */
  frame: number;
  /** When that frame left (this side's clock); null until it did. */
  sentAt: number | null;
  /** The server refused something sent with it: kept as unsent until a new socket offers it again. */
  refused: boolean;
}

/** Something waiting its turn to go out, in order. */
interface OutItem {
  data: string | Uint8Array;
  /** As it goes on the wire (base64 on a text socket), made once. */
  wire?: string | Uint8Array;
  /** The changes this frame carries: they count from when it actually left. */
  entries?: Pending[];
  /** A ping: the change frames sent before it. */
  ping?: number;
}

type TimerName = "retry" | "ready" | "ping" | "pong" | "flush" | "awareness" | "settle" | "drain" | "pingWait";

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};

/** The server's closes that end the connection for good (the apps never reconnect after them). */
const CLOSES_FOR_GOOD: Record<number, LiveRoomError> = {
  [LIVE_CLOSE.forbidden]: "forbidden",
  [LIVE_CLOSE.notFound]: "not_found",
};

/**
 * Refusals that hold for one socket's changes (`read_only` holds until the mode is `edit` again; a `rate` refusal also
 * ends with the next `live.saved`).
 */
const SOCKET_REFUSALS: readonly LiveRoomError[] = ["too_large", "invalid", "rate"];

/** Why loading the state failed for good: no session, no access, no such file. Anything else is tried again. */
function refusalOf(error: unknown): LiveRoomError | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 401) return "unauthorized";
  if (error.status === 403) return "forbidden";
  if (error.status === 404 || error.status === 410) return "not_found";
  return null;
}

/** A frame's message type (and sync step), or null when it can't even be read that far. */
function headOf(bytes: Uint8Array): { type: number; sync: number } | null {
  try {
    const decoder = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(decoder);
    return { type, sync: type === MSG_SYNC ? decoding.readVarUint(decoder) : -1 };
  } catch {
    return null;
  }
}

/** A binary message as bytes (an `ArrayBuffer` once `binaryType` is "arraybuffer"); null for anything else. */
function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

const sameState = (a: LiveConnectionState, b: LiveConnectionState) =>
  a.status === b.status &&
  a.mode === b.mode &&
  a.unsent === b.unsent &&
  a.error === b.error &&
  a.loaded === b.loaded &&
  a.seq === b.seq &&
  a.kind === b.kind;

export class LiveConnection {
  private readonly doc: Y.Doc;
  private readonly awareness: Awareness;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly timing: LiveTiming;
  private readonly backoff: number[];
  private readonly jitter: number;
  private readonly random: () => number;
  private socket: SocketLike | null = null;
  /** Each socket's number: events of one that was replaced are ignored. */
  private generation = 0;
  /** The current socket opened; heard `live.ready`; answered (or let go) the server's step 1; got the server's step 2. */
  private isOpen = false;
  private ready = false;
  private replied = false;
  private synced = false;
  /** The server's step 1 when it came before `live.ready` (answered once the mode is known). */
  private heldStep1: Uint8Array | null = null;
  private attempt = 0;
  /** Sockets that closed before they opened, in a row. */
  private failedOpens = 0;
  /** Sockets the server closed as a bad request, in a row. */
  private badCloses = 0;
  /** The next connect asks the HTTP state first (sockets keep failing to open). */
  private probe = false;
  private started = false;
  private stopped = false;
  private paused = false;
  /** Closed for good (no access, no file): nothing reconnects. */
  private ended = false;
  private loadedOnce = false;
  /** Bumped to forget an HTTP load still on its way. */
  private loadToken = 0;
  private pending: Pending[] = [];
  /** Change frames sent on this socket. */
  private frames = 0;
  /** The ping on its way (one at a time), whether one waits in the queue, and whether another is wanted after. */
  private ping: { frame: number; at: number } | null = null;
  private pingQueued = false;
  private wantPing = false;
  private lastPingAt = Number.NEGATIVE_INFINITY;
  private lastPongAt = Number.NEGATIVE_INFINITY;
  private lastHeardAt = Number.NEGATIVE_INFINITY;
  /** Change frames up to this one reached the server (a pong after them came). */
  private receivedThrough = 0;
  /** Change frames up to this one are stored (a pong after them said nothing of ours waited to be stored). */
  private storedThrough = 0;
  private lastSavedAt = Number.NEGATIVE_INFINITY;
  /** The round trip, measured by pings (smoothed). */
  private rtt: number | null = null;
  private outbox: OutItem[] = [];
  private credit = SEND_BURST;
  private creditAt = 0;
  private rate: number;
  private awarenessDirty = false;
  /** Changes put back before the document loaded: applied once it did. */
  private restored: Uint8Array[] = [];
  private snapshot: LiveConnectionState;
  private readonly listeners = new Set<(state: LiveConnectionState) => void>();
  private readonly versionListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(code: LiveRoomError) => void>();
  private readonly timer: Record<TimerName, unknown> = {
    retry: null,
    ready: null,
    ping: null,
    pong: null,
    flush: null,
    awareness: null,
    settle: null,
    drain: null,
    pingWait: null,
  };

  constructor(private readonly options: LiveConnectionOptions) {
    this.doc = options.doc;
    this.awareness = options.awareness;
    this.timers = options.timers ?? defaultTimers;
    this.now = options.now ?? (() => Date.now());
    this.timing = { ...LIVE_TIMING, ...options.timing };
    this.backoff = options.backoffMs?.length ? options.backoffMs : LIVE_BACKOFF_MS;
    this.jitter = Math.min(1, Math.max(0, options.backoffJitter ?? LIVE_BACKOFF_JITTER));
    this.random = options.random ?? Math.random;
    this.rate = options.sendRate ?? LIVE_SEND_RATE;
    this.snapshot = {
      status: "connecting",
      mode: options.mode ?? "view",
      unsent: false,
      error: null,
      loaded: false,
      seq: 0,
      kind: options.kind ?? null,
    };
  }

  /** Where it stands now (the same object until something changes). */
  get state(): LiveConnectionState {
    return this.snapshot;
  }

  /** Changes made here the server hasn't stored yet (`unsent`). */
  hasUnsent(): boolean {
    return this.pending.length > 0 || this.restored.length > 0;
  }

  /** Every change not known to be stored, as one update (the phone keeps it across restarts); null when none. */
  unsentUpdate(): Uint8Array | null {
    const updates = [...this.pending.map((e) => e.update), ...this.restored];
    if (updates.length === 0) return null;
    return updates.length === 1 ? (updates[0] as Uint8Array) : Y.mergeUpdates(updates);
  }

  /** Puts back changes kept from an earlier session (`unsentUpdate`): they go like new ones, once the file loaded. */
  restore(update: Uint8Array) {
    if (this.stopped || update.byteLength === 0) return;
    if (!this.snapshot.loaded) {
      this.restored.push(update);
      this.syncUnsent();
      return;
    }
    try {
      Y.applyUpdate(this.doc, update, LIVE_RESTORED);
    } catch {
      // A stored change this build can't read is dropped rather than kept failing.
    }
  }

  /** Listens to every change of `state`. */
  subscribe(listener: (state: LiveConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** A version was written (`live.versions`): the history refetches. */
  onVersions(listener: () => void): () => void {
    this.versionListeners.add(listener);
    return () => {
      this.versionListeners.delete(listener);
    };
  }

  /** The server refused something (`live.error`), or the connection closed for good: once per event. */
  onError(listener: (code: LiveRoomError) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
    void this.connect();
  }

  /**
   * For good: what can still go is sent (the last changes, this side's presence: the room clears it first), the
   * socket closes, and every listener and timer goes.
   */
  stop() {
    if (this.stopped) return;
    if (this.started && !this.paused && !this.ended) {
      this.flush();
      if (this.awarenessDirty) this.sendAwareness();
      this.drain(true);
    }
    this.stopped = true;
    this.loadToken++;
    if (this.started) {
      this.doc.off("update", this.onDocUpdate);
      this.awareness.off("update", this.onAwarenessUpdate);
    }
    this.dropSocket(1000, "closed");
    this.clearTimers();
    this.set({ status: "closed" });
    this.listeners.clear();
    this.versionListeners.clear();
    this.errorListeners.clear();
  }

  /** The app went to the background (the phone): the socket closes, changes keep waiting; `resume` reconnects. */
  pause() {
    if (this.stopped || this.ended || this.paused) return;
    if (this.started) {
      this.flush();
      if (this.awarenessDirty) this.sendAwareness();
      this.drain(true);
    }
    this.paused = true;
    this.loadToken++;
    this.dropSocket(1000, "paused");
    this.clearTimers();
    if (this.started) this.set({ status: "offline" });
  }

  resume() {
    if (!this.paused || this.stopped) return;
    this.paused = false;
    this.attempt = 0;
    if (this.started) void this.connect();
  }

  /**
   * Pings now and replaces the socket if nothing comes back in time; while waiting to reconnect, reconnects now.
   * Call it when the app may have slept or changed networks (visible again, back online).
   */
  checkAlive() {
    if (!this.started || this.stopped || this.paused || this.ended) return;
    if (this.socket && this.isOpen) {
      this.sendPing();
      return;
    }
    if (this.timer.retry !== null) {
      this.clear("retry");
      void this.connect();
    }
  }

  // ── Opening ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private get halted() {
    return this.stopped || this.paused || this.ended;
  }

  private async connect() {
    if (this.halted) return;
    const load = this.options.loadState;
    if (load && (!this.loadedOnce || this.probe)) {
      const token = ++this.loadToken;
      let loaded: LiveLoadedState;
      try {
        loaded = await load();
      } catch (error) {
        if (token !== this.loadToken || this.halted) return;
        const refusal = refusalOf(error);
        if (refusal) return this.closeForGood(refusal);
        this.set({ status: "offline" });
        this.retryLater();
        return;
      }
      if (token !== this.loadToken || this.halted) return;
      try {
        if (loaded.state.byteLength > 0) Y.applyUpdate(this.doc, loaded.state, REMOTE);
      } catch {
        // A state this build can't read: the socket brings the document instead.
      }
      this.probe = false;
      this.loadedOnce = true;
      this.set({
        loaded: true,
        mode: loaded.mode,
        seq: Math.max(this.snapshot.seq, loaded.seq),
        kind: this.snapshot.kind ?? loaded.kind ?? null,
        status: this.snapshot.status === "connecting" ? "syncing" : this.snapshot.status,
      });
      this.applyRestored();
      if (this.halted) return;
    }
    this.open();
  }

  private open() {
    if (this.halted || this.socket) return;
    const generation = ++this.generation;
    let socket: SocketLike;
    try {
      socket = this.options.createSocket(this.options.url);
    } catch {
      this.failedOpen();
      return;
    }
    try {
      socket.binaryType = "arraybuffer";
    } catch {
      // A socket that only takes its own (binary frames then come as it gives them; `bytesOf` reads both).
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.generation === generation) this.opened();
    };
    socket.onmessage = (ev) => {
      if (this.generation !== generation) return;
      this.lastHeardAt = this.now();
      this.receive(ev?.data);
    };
    socket.onerror = () => {
      // `onclose` follows.
    };
    socket.onclose = (ev) => {
      if (this.generation === generation) this.lost(typeof ev?.code === "number" ? ev.code : 1006);
    };
  }

  private opened() {
    this.isOpen = true;
    this.credit = SEND_BURST;
    this.creditAt = this.now();
    this.lastHeardAt = this.now();
    if (this.snapshot.status !== "live") this.set({ status: this.snapshot.loaded ? "syncing" : "connecting" });
    this.timer.ping = this.timers.setInterval(() => this.sendPing(), this.timing.pingMs);
    // A server that took the socket but never joined it to the file: another socket starts over.
    this.timer.ready = this.timers.setTimeout(() => {
      this.timer.ready = null;
      if (!this.ready) this.resync();
    }, this.timing.readyTimeoutMs);
  }

  /** The socket closed (not by us). */
  private lost(code: number) {
    const wasOpen = this.isOpen;
    this.dropSocket();
    if (this.halted) return;
    const refusal = CLOSES_FOR_GOOD[code];
    if (refusal) return this.closeForGood(refusal);
    if (code === LIVE_CLOSE.badRequest && ++this.badCloses >= BAD_CLOSES) return this.closeForGood("invalid");
    if (!wasOpen) return this.failedOpen();
    this.set({ status: "offline" });
    this.retryLater(code === LIVE_CLOSE.tooMany ? 2 : 0);
  }

  /** A socket that never opened: the upgrade's refusal looks the same as a network that's down. */
  private failedOpen() {
    this.failedOpens++;
    const n = this.failedOpens - PROBE_AFTER;
    if (this.options.loadState && n >= 0 && n % PROBE_EVERY === 0) this.probe = true;
    this.set({ status: "offline" });
    this.retryLater();
  }

  private retryLater(extraSteps = 0) {
    if (this.halted || this.timer.retry !== null) return;
    const wait = this.backoff[Math.min(this.attempt + extraSteps, this.backoff.length - 1)] ?? 10_000;
    const delay = Math.round(wait * (1 - this.jitter * this.random()));
    this.attempt++;
    this.timer.retry = this.timers.setTimeout(() => {
      this.timer.retry = null;
      void this.connect();
    }, delay);
  }

  /** No access, no file, no session, or a file the server can't read from us: nothing reconnects. */
  private closeForGood(code: LiveRoomError) {
    this.ended = true;
    this.loadToken++;
    this.dropSocket();
    this.clearTimers();
    this.set({ status: "closed", error: code });
    this.emitError(code);
  }

  /** Forgets the socket (closing it with `code` when given) and everything that was only true on it. */
  private dropSocket(code?: number, reason?: string) {
    const socket = this.socket;
    this.socket = null;
    this.generation++;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (code !== undefined) {
        try {
          socket.close(code, reason);
        } catch {}
      }
    }
    this.isOpen = false;
    this.ready = false;
    this.replied = false;
    this.synced = false;
    this.heldStep1 = null;
    this.outbox = [];
    this.frames = 0;
    this.ping = null;
    this.pingQueued = false;
    this.wantPing = false;
    this.receivedThrough = 0;
    this.storedThrough = 0;
    this.lastSavedAt = Number.NEGATIVE_INFINITY;
    // What wasn't confirmed goes again on the next socket (its step 2 carries it).
    for (const e of this.pending) {
      e.frame = 0;
      e.sentAt = null;
      e.refused = false;
    }
    for (const name of ["ready", "ping", "pong", "flush", "awareness", "settle", "drain", "pingWait"] as const) {
      this.clear(name);
    }
    // What this socket refused is offered again on the next one, which says so again if it still holds.
    if (!this.ended && this.snapshot.error && SOCKET_REFUSALS.includes(this.snapshot.error)) this.set({ error: null });
    // Who else is here is unknown until the next socket says. Their clocks go too: the next socket announces them
    // with the clocks they still have, which y-protocols ignores for a client whose clock it already knows.
    const me = this.awareness.clientID;
    const others = [...this.awareness.getStates().keys()].filter((id) => id !== me);
    if (others.length) removeAwarenessStates(this.awareness, others, REMOTE);
    for (const id of [...this.awareness.meta.keys()]) if (id !== me) this.awareness.meta.delete(id);
  }

  // ── Reading ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private receive(data: unknown) {
    if (typeof data === "string") {
      // `{`: control; anything else on a text socket is base64 bytes.
      if (data.charCodeAt(0) === 123) return this.control(data);
      if (!this.options.textFrames) return;
      let bytes: Uint8Array;
      try {
        bytes = fromBase64(data);
      } catch {
        return this.resync();
      }
      return this.binary(bytes);
    }
    const bytes = bytesOf(data);
    if (bytes) this.binary(bytes);
  }

  private control(text: string) {
    if (isLivePong(text)) return this.pong(pongUnsaved(text));
    const control = parseControl(text);
    if (!control) return;
    switch (control.type) {
      case "live.ready":
        return this.onReady(control.mode, control.seq);
      case "live.mode":
        return this.setMode(control.mode);
      case "live.saved":
        return this.saved(control.seq);
      case "live.versions":
        for (const l of [...this.versionListeners]) l();
        return;
      case "live.error":
        return this.refused(control.code);
    }
  }

  private onReady(mode: LiveMode, seq: number) {
    // Who we are goes below at a newer clock than the last one sent: when an earlier socket of ours went, the server
    // and the apps in the file removed our state at that clock, and y-protocols takes a state only at a newer one, so
    // the same clock again would leave us out until we next moved. Bumped before `ready`, so nothing is sent yet.
    const local = this.awareness.getLocalState();
    if (local !== null) this.awareness.setLocalState(local);
    this.ready = true;
    this.clear("ready");
    this.set({ mode, seq: Math.max(this.snapshot.seq, seq), ...this.clearedRefusal(mode) });
    // What we lack, from our state vector; then who we are.
    this.enqueue({ data: syncStep1(this.doc) });
    this.awarenessDirty = true;
    this.sendAwareness();
    const held = this.heldStep1;
    this.heldStep1 = null;
    if (held) this.binary(held);
  }

  private binary(bytes: Uint8Array) {
    const head = headOf(bytes);
    if (!head) return this.resync();
    // A message this build doesn't know (a newer server's): left alone.
    if (head.type !== MSG_SYNC && head.type !== MSG_AWARENESS && head.type !== MSG_QUERY_AWARENESS) return;
    if (head.type === MSG_SYNC && head.sync === SYNC_STEP1) {
      if (!this.ready) {
        this.heldStep1 = bytes;
        return;
      }
      return this.answerStep1(bytes);
    }
    let result: ReturnType<typeof readMessage>;
    try {
      result = readMessage(bytes, { doc: this.doc, awareness: this.awareness, origin: REMOTE, allowWrite: true });
    } catch {
      return this.resync();
    }
    // Asked who we are: our own state only (the server knows the others).
    if (result.type === "query") {
      this.awarenessDirty = true;
      this.sendAwareness();
      return;
    }
    if (head.type === MSG_SYNC && head.sync === SYNC_STEP2) this.caughtUp();
  }

  /** The server's step 1: what it lacks goes back (in `edit` mode), every change waiting with it. */
  private answerStep1(bytes: Uint8Array) {
    if (this.snapshot.mode !== "edit") {
      // Nothing of ours is taken in `view`: changes wait for `edit` (`setMode`).
      this.replied = true;
      return;
    }
    let reply: Uint8Array | undefined;
    try {
      reply = readMessage(bytes, { doc: this.doc, awareness: this.awareness, origin: REMOTE, allowWrite: true }).reply;
    } catch {
      return this.resync();
    }
    this.replied = true;
    this.clear("flush");
    // The server asks for everything it lacks (on a new socket, or after it refused some): all of it is offered again,
    // and a file that was too large takes changes again (a change too large for any frame says so again below).
    for (const e of this.pending) e.refused = false;
    if (this.snapshot.error === "too_large") this.set({ error: null });
    if (reply && reply.byteLength <= LIVE_MAX_FRAME_BYTES) {
      // Everything waiting is in it (the server's state vector says what it lacks; ours holds it all).
      this.sendChange(reply, [...this.pending]);
      return;
    }
    // Too much for one frame (a long time offline): what we made goes as updates, in frames that fit.
    for (const e of this.pending) {
      e.frame = 0;
      e.sentAt = null;
    }
    this.flush();
  }

  /** The server's step 2: in step with everyone. */
  private caughtUp() {
    if (this.synced) return;
    this.synced = true;
    this.attempt = 0;
    this.failedOpens = 0;
    this.badCloses = 0;
    // A server that sent no step 1 of its own still gets what we made.
    if (!this.replied) {
      this.replied = true;
      this.flush();
    }
    const firstLoad = !this.snapshot.loaded;
    this.set({ status: "live", loaded: true });
    if (firstLoad) this.applyRestored();
  }

  private setMode(mode: LiveMode) {
    const before = this.snapshot.mode;
    this.set({ mode, ...this.clearedRefusal(mode) });
    if (mode !== "edit" || !this.ready) return;
    const heldBack = this.pending.some((e) => e.refused);
    if (before === "edit" && !heldBack) return;
    // What waited, or was refused while the file was read-only, goes now, as updates.
    this.replied = true;
    for (const e of this.pending) {
      if (!e.refused) continue;
      e.refused = false;
      e.frame = 0;
      e.sentAt = null;
    }
    this.flush();
  }

  /** A `read_only` refusal no longer holds once the mode is `edit` again. */
  private clearedRefusal(mode: LiveMode): Partial<LiveConnectionState> {
    return mode === "edit" && this.snapshot.error === "read_only" ? { error: null } : {};
  }

  private refused(code: LiveErrorCode) {
    if (code === "rate") this.rate = Math.max(32 * 1024, Math.floor(this.rate / 2));
    // Which frame it was isn't said: every change on its way is held back until a new socket offers it again.
    else for (const e of this.pending) if (e.frame > 0) e.refused = true;
    this.set({ error: code });
    this.emitError(code);
  }

  /** A frame that couldn't be read, or a socket that went silent: a new socket starts the sync over. */
  private resync() {
    this.dropSocket(CLOSE_STALE, "resync");
    if (this.halted) return;
    this.set({ status: "offline" });
    this.retryLater();
  }

  // ── Sending ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE || this.stopped) return;
    this.pending.push({ update, frame: 0, sentAt: null, refused: false });
    this.mergeWaiting();
    this.syncUnsent();
    if (this.timer.flush === null) {
      this.timer.flush = this.timers.setTimeout(() => {
        this.timer.flush = null;
        this.flush();
      }, this.timing.sendDelayMs);
    }
  };

  /** Many changes waiting (offline for long): merged into one, so the list stays short. */
  private mergeWaiting() {
    const waiting = this.pending.filter((e) => e.frame === 0 && !e.refused);
    if (waiting.length <= MERGE_PAST) return;
    const merged: Pending = {
      update: Y.mergeUpdates(waiting.map((e) => e.update)),
      frame: 0,
      sentAt: null,
      refused: false,
    };
    this.pending = [...this.pending.filter((e) => e.frame !== 0 || e.refused), merged];
  }

  private canSend() {
    return this.socket !== null && this.isOpen && this.ready && this.replied && this.snapshot.mode === "edit";
  }

  /** Every change not sent on this socket yet goes, merged into frames that fit. */
  private flush() {
    this.clear("flush");
    if (!this.canSend()) return;
    const fresh = this.pending.filter((e) => e.frame === 0 && !e.refused);
    if (fresh.length === 0) return;
    const groups: Pending[][] = [];
    let group: Pending[] = [];
    let size = 0;
    for (const e of fresh) {
      if (group.length > 0 && size + e.update.byteLength > FRAME_TARGET) {
        groups.push(group);
        group = [];
        size = 0;
      }
      group.push(e);
      size += e.update.byteLength;
    }
    if (group.length > 0) groups.push(group);
    const sent = new Set<Pending>();
    const merged: Pending[] = [];
    let tooLarge = false;
    for (const g of groups) {
      const update = g.length === 1 ? (g[0] as Pending).update : Y.mergeUpdates(g.map((e) => e.update));
      const message = updateMessage(update);
      if (message.byteLength > LIVE_MAX_FRAME_BYTES) {
        // One change too big for any frame: the server can't take it; it stays unsent and the screen says why.
        for (const e of g) e.refused = true;
        tooLarge = true;
        continue;
      }
      const entry: Pending = { update, frame: 0, sentAt: null, refused: false };
      for (const e of g) sent.add(e);
      merged.push(entry);
      this.sendChange(message, [entry]);
    }
    // The sent ones as one entry per frame, after the rest.
    this.pending = [...this.pending.filter((e) => !sent.has(e)), ...merged];
    if (tooLarge) {
      this.set({ error: "too_large" });
      this.emitError("too_large");
    }
  }

  /** A frame of changes: numbered, queued, and covered by the next ping. */
  private sendChange(message: Uint8Array, entries: Pending[]) {
    this.frames++;
    for (const e of entries) {
      e.frame = this.frames;
      e.sentAt = null;
    }
    this.enqueue({ data: message, entries });
    this.sendPing();
  }

  /** Presence goes on a socket the server joined to the file; otherwise it waits (`live.ready` sends it). */
  private presenceOpen() {
    return this.socket !== null && this.isOpen && this.ready;
  }

  private sendAwareness() {
    if (!this.presenceOpen()) return;
    this.awarenessDirty = false;
    this.enqueue({ data: awarenessMessage(this.awareness, [this.awareness.clientID]) });
  }

  private readonly onAwarenessUpdate = (change: { added: number[]; updated: number[]; removed: number[] }) => {
    const me = this.awareness.clientID;
    // Ours only; a remote one naming us is the server saying we were dropped: we say we're here.
    if (!change.added.includes(me) && !change.updated.includes(me) && !change.removed.includes(me)) return;
    this.awarenessDirty = true;
    if (this.timer.awareness !== null || !this.presenceOpen()) return;
    this.sendAwareness();
    this.timer.awareness = this.timers.setTimeout(this.awarenessTick, this.timing.awarenessMs);
  };

  /** The end of a throttle window: what changed during it goes, and another window starts. */
  private readonly awarenessTick = () => {
    this.timer.awareness = null;
    if (!this.awarenessDirty || !this.presenceOpen()) return;
    this.sendAwareness();
    this.timer.awareness = this.timers.setTimeout(this.awarenessTick, this.timing.awarenessMs);
  };

  /**
   * Pings after what was sent (at most one on its way, never sooner than `pingGapMs` after the last one or its answer:
   * the server answers one a second) and on the interval. Its pong says the server got every frame before it.
   */
  private sendPing() {
    if (!this.socket || !this.isOpen) return;
    if (this.ping !== null || this.pingQueued) {
      this.wantPing = true;
      return;
    }
    const wait = Math.max(this.lastPingAt, this.lastPongAt) + this.timing.pingGapMs - this.now();
    if (wait > 0) {
      this.wantPing = true;
      if (this.timer.pingWait === null) {
        this.timer.pingWait = this.timers.setTimeout(() => {
          this.timer.pingWait = null;
          this.sendPing();
        }, wait);
      }
      return;
    }
    this.wantPing = false;
    this.pingQueued = true;
    this.enqueue({ data: LIVE_PING, ping: this.frames });
  }

  private enqueue(item: OutItem) {
    this.outbox.push(item);
    this.drain();
  }

  /** Sends what waits, in order, at the pace the server takes (`force`: all of it now, when leaving). */
  private drain(force = false) {
    this.clear("drain");
    const socket = this.socket;
    if (!socket || !this.isOpen) return;
    while (this.outbox.length > 0) {
      const item = this.outbox[0] as OutItem;
      item.wire ??=
        typeof item.data === "string" ? item.data : this.options.textFrames ? toBase64(item.data) : item.data;
      const size = typeof item.wire === "string" ? item.wire.length : item.wire.byteLength;
      const now = this.now();
      this.credit = Math.min(SEND_BURST, this.credit + ((now - this.creditAt) * this.rate) / 1000);
      this.creditAt = now;
      const needed = Math.min(size, SEND_BURST);
      if (!force && this.credit < needed) {
        const wait = Math.ceil(((needed - this.credit) * 1000) / this.rate);
        this.timer.drain = this.timers.setTimeout(
          () => {
            this.timer.drain = null;
            this.drain();
          },
          Math.max(1, wait),
        );
        return;
      }
      if (socket.readyState !== OPEN) return;
      this.outbox.shift();
      this.credit -= size;
      try {
        socket.send(item.wire);
      } catch {
        // The close event follows; what it carried goes again on the next socket.
        return;
      }
      this.wrote(item);
    }
  }

  private wrote(item: OutItem) {
    const at = this.now();
    if (item.entries) for (const e of item.entries) e.sentAt = at;
    if (item.ping !== undefined) {
      this.pingQueued = false;
      this.ping = { frame: item.ping, at };
      this.lastPingAt = at;
      this.armPongWait(at);
    }
  }

  // ── Acknowledgements ────────────────────────────────────────────────────────────────────────────────────────────

  /** Nothing heard at all `pongTimeoutMs` after a ping: the socket is dead. Heard, but no pong: the ping is let go. */
  private armPongWait(sentAt: number) {
    this.clear("pong");
    this.timer.pong = this.timers.setTimeout(() => {
      this.timer.pong = null;
      if (this.lastHeardAt < sentAt) return this.resync();
      this.ping = null;
      if (this.wantPing) this.sendPing();
    }, this.timing.pongTimeoutMs);
  }

  private pong(unsaved: boolean) {
    const p = this.ping;
    if (!p) return;
    this.ping = null;
    this.clear("pong");
    const now = this.now();
    this.lastPongAt = now;
    const sample = Math.max(0, now - p.at);
    this.rtt = this.rtt === null ? sample : Math.round(this.rtt * 0.75 + sample * 0.25);
    if (p.frame > this.receivedThrough) this.receivedThrough = p.frame;
    if (!unsaved && p.frame > this.storedThrough) this.storedThrough = p.frame;
    this.acknowledge("pong");
    if (this.wantPing) this.sendPing();
  }

  private saved(seq: number) {
    this.lastSavedAt = this.now();
    this.set({ seq: Math.max(this.snapshot.seq, seq), ...(this.snapshot.error === "rate" ? { error: null } : {}) });
    this.acknowledge("saved");
  }

  /**
   * Drops the changes the server has stored, by what it just said:
   * - `saved`: a `live.saved` covers what reached the server before it (a pong proved it) and what was sent at least
   *   a round trip before it came;
   * - `pong`: what came before a pong that says nothing waits to be stored; and what this pong proves reached the
   *   server is covered by the last `live.saved` if that came at least a round trip after it was sent;
   * - `settle`, `savedSettleMs` after: only what a pong said was stored. Silence alone proves nothing: the server may
   *   still be storing it (a slow database, frames waiting in its line), and says so with `unsaved`.
   * Anything any of them says was stored counts at the others too.
   */
  private acknowledge(cause: "saved" | "pong" | "settle") {
    const now = this.now();
    const margin = this.rtt === null ? null : this.rtt + Math.max(15, this.rtt / 4);
    const before = this.pending.length;
    this.pending = this.pending.filter((e) => {
      if (e.frame === 0 || e.sentAt === null || e.refused) return true;
      const stored = e.frame <= this.storedThrough;
      const received = e.frame <= this.receivedThrough;
      if (cause === "saved") return !(stored || received || (margin !== null && e.sentAt + margin <= now));
      if (cause === "pong") return !(stored || (received && margin !== null && e.sentAt + margin <= this.lastSavedAt));
      return !stored;
    });
    if (this.pending.length !== before) this.syncUnsent();
    if (cause === "settle") return;
    if (this.pending.some((e) => e.frame > 0 && e.sentAt !== null && !e.refused)) this.armSettle();
    else this.clear("settle");
  }

  private armSettle() {
    this.clear("settle");
    this.timer.settle = this.timers.setTimeout(() => {
      this.timer.settle = null;
      this.acknowledge("settle");
    }, this.timing.savedSettleMs);
  }

  // ── Restored changes ────────────────────────────────────────────────────────────────────────────────────────────

  private applyRestored() {
    const restored = this.restored;
    if (restored.length === 0) return;
    this.restored = [];
    for (const update of restored) {
      try {
        Y.applyUpdate(this.doc, update, LIVE_RESTORED);
      } catch {
        // A stored change this build can't read is dropped rather than kept failing.
      }
    }
    this.syncUnsent();
  }

  // ── Plumbing ────────────────────────────────────────────────────────────────────────────────────────────────────

  private syncUnsent() {
    const unsent = this.hasUnsent();
    if (unsent !== this.snapshot.unsent) this.set({ unsent });
  }

  private emitError(code: LiveRoomError) {
    for (const l of [...this.errorListeners]) l(code);
  }

  private set(patch: Partial<LiveConnectionState>) {
    const next = { ...this.snapshot, ...patch };
    if (sameState(next, this.snapshot)) return;
    this.snapshot = next;
    for (const l of [...this.listeners]) l(next);
  }

  private clear(name: TimerName) {
    const id = this.timer[name];
    if (id === null) return;
    if (name === "ping") this.timers.clearInterval(id);
    else this.timers.clearTimeout(id);
    this.timer[name] = null;
  }

  private clearTimers() {
    for (const name of Object.keys(this.timer) as TimerName[]) this.clear(name);
  }
}
