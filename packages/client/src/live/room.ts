import { type LiveKind, LOCAL, liveKindOf, SheetEngine } from "@agenteschat/live";
import { type Peer, type PeerState, type PeerUser, peersOf } from "@agenteschat/live/awareness";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { SocketFactory, Timers } from "../realtime/connection";
import type { LiveLoadedState } from "./api";
import { LiveConnection, type LiveConnectionState, type LiveTiming } from "./connection";
import type { Signal } from "./signals";
import type { LiveFileStatus, LiveMode, LiveRoomError } from "./types";

/**
 * One open live file in an app (ADR 0196): its document, everyone's presence in it, the person's own undo, and the
 * connection that keeps them in step with the server. The web, the desktop app and the phone open it the same way
 * (`useLiveRoom`, or `acquireLiveRoom` with `new LiveRoom`), and their editors read and write `doc` with
 * `@agenteschat/live`'s functions, always with the `LOCAL` origin, which is what `undo` takes back.
 */

/** The top-level types each kind keeps its content in (ADR 0196 §2): what the person's undo covers. */
const ROOTS: Record<LiveKind, (doc: Y.Doc) => (Y.Map<unknown> | Y.Array<unknown> | Y.XmlFragment)[]> = {
  spreadsheet: (doc) => [doc.getArray("sheetOrder"), doc.getMap("sheets")],
  slides: (doc) => [doc.getMap("deck"), doc.getArray("slideOrder"), doc.getMap("slides")],
  canvas: (doc) => [doc.getMap("canvas"), doc.getMap("shapes")],
  // A document's body (ADR 0200).
  document: (doc) => [doc.getXmlFragment("body")],
};

/** How long the person's undo merges changes into one step. */
export const LIVE_UNDO_CAPTURE_MS = 500;

export interface LiveRoomOptions {
  orgId: string;
  fileId: string;
  /** Who this app's person is: their presence says so (the server writes it over anyway). */
  me: PeerUser;
  /** When the screen knows it already (the Drive's file); otherwise the state or the document says. */
  kind?: LiveKind | null;
  /** The socket's address (`liveSocketUrl`). */
  url: string;
  createSocket: SocketFactory;
  /** The document over HTTP first (`loadLiveState`). */
  loadState?: () => Promise<LiveLoadedState>;
  /** The phone: bytes as base64 text frames. */
  textFrames?: boolean;
  timers?: Timers;
  now?: () => number;
  backoffMs?: number[];
  backoffJitter?: number;
  random?: () => number;
  timing?: Partial<LiveTiming>;
  sendRate?: number;
  /** Connects at once (the default); false waits for `start()`. */
  start?: boolean;
}

/** Fields of a presence that only the room sets. */
type OwnFields = "user" | "mode";

export class LiveRoom {
  readonly orgId: string;
  readonly fileId: string;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  /** The person's own changes only (`LOCAL`): never an agent's, another person's or the server's. */
  readonly undo: Y.UndoManager;
  readonly connection: LiveConnection;
  private user: PeerUser;
  /** What the screen says the person is doing; `viewing` while the file is read-only whatever it says. */
  private wantedMode: PeerState["mode"] = "viewing";
  private peerCache: Peer[] | null = null;
  private docVersion = 0;
  private sheetEngine: SheetEngine | null = null;
  private dead = false;
  private readonly peerListeners = new Set<() => void>();
  private readonly docListeners = new Set<() => void>();
  private readonly offConnection: () => void;

  constructor(options: LiveRoomOptions) {
    this.orgId = options.orgId;
    this.fileId = options.fileId;
    this.user = { kind: options.me.kind, id: options.me.id };
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
    this.awareness.setLocalState({ user: this.user, mode: "viewing" } satisfies PeerState);
    const kind = options.kind ?? null;
    const roots = kind ? ROOTS[kind](this.doc) : Object.values(ROOTS).flatMap((of) => of(this.doc));
    this.undo = new Y.UndoManager(roots, {
      trackedOrigins: new Set<unknown>([LOCAL]),
      captureTimeout: LIVE_UNDO_CAPTURE_MS,
    });
    this.connection = new LiveConnection({
      url: options.url,
      createSocket: options.createSocket,
      doc: this.doc,
      awareness: this.awareness,
      ...(options.loadState ? { loadState: options.loadState } : {}),
      ...(options.textFrames ? { textFrames: true } : {}),
      kind,
      ...(options.timers ? { timers: options.timers } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.backoffMs ? { backoffMs: options.backoffMs } : {}),
      ...(options.backoffJitter !== undefined ? { backoffJitter: options.backoffJitter } : {}),
      ...(options.random ? { random: options.random } : {}),
      ...(options.timing ? { timing: options.timing } : {}),
      ...(options.sendRate ? { sendRate: options.sendRate } : {}),
    });
    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("change", this.onAwarenessChange);
    // The file turning read-only makes the person `viewing` at once (the server would say so for them anyway).
    let mode = this.connection.state.mode;
    this.offConnection = this.connection.subscribe((state) => {
      if (state.mode === mode) return;
      mode = state.mode;
      this.applyLocal({});
    });
    if (options.start !== false) this.connection.start();
  }

  /** Connects (when made with `start: false`). */
  start() {
    if (!this.dead) this.connection.start();
  }

  // ── State ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Where the connection stands: status, mode, unsent changes, error. A new object on every change. */
  get state(): LiveConnectionState {
    return this.connection.state;
  }

  /** `state` as a function (for `useSyncExternalStore`). */
  readonly getState = (): LiveConnectionState => this.connection.state;

  /** Listens to `state` (status, mode, unsent, error…). */
  readonly subscribe = (listener: () => void): (() => void) => this.connection.subscribe(() => listener());

  get status(): LiveFileStatus {
    return this.connection.state.status;
  }

  get mode(): LiveMode {
    return this.connection.state.mode;
  }

  get unsent(): boolean {
    return this.connection.state.unsent;
  }

  get error(): LiveRoomError | null {
    return this.connection.state.error;
  }

  /** The kind, once anything said it (the screen, the state, or the document's own meta). */
  get kind(): LiveKind | null {
    return this.connection.state.kind ?? liveKindOf(this.doc);
  }

  /** True once `destroy` ran: nothing works any more. */
  get destroyed(): boolean {
    return this.dead;
  }

  /** A version was written (`live.versions`): the history refetches. */
  onVersions(listener: () => void): () => void {
    return this.connection.onVersions(listener);
  }

  /** The server refused something, or the file closed for good: once per event (a toast, say). */
  onError(listener: (code: LiveRoomError) => void): () => void {
    return this.connection.onError(listener);
  }

  // ── The document ────────────────────────────────────────────────────────────────────────────────────────────────

  /** Goes up on every change to the document, from anyone. */
  get version(): number {
    return this.docVersion;
  }

  /** `version` as a function (for `useSyncExternalStore`). */
  readonly getVersion = (): number => this.docVersion;

  /** Every change to the document, from anyone (after it applied). */
  readonly onDocChange: Signal = (listener) => {
    this.docListeners.add(listener);
    return () => {
      this.docListeners.delete(listener);
    };
  };

  /** A spreadsheet's computed values (made on first use, kept in step with the document, gone with the room). */
  engine(): SheetEngine {
    if (this.dead) throw new Error("This live file was closed");
    const kind = this.kind;
    if (kind && kind !== "spreadsheet") throw new Error(`A ${kind} has no spreadsheet engine`);
    this.sheetEngine ??= new SheetEngine(this.doc);
    return this.sheetEngine;
  }

  // ── Presence ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Who is in the file now, this person first (one entry per person or agent: see `peersOf`). */
  readonly peers = (): Peer[] => {
    this.peerCache ??= peersOf(this.awareness);
    return this.peerCache;
  };

  /** Someone came, left, or moved (pointer, selection, slide…). */
  readonly onPeers: Signal = (listener) => {
    this.peerListeners.add(listener);
    return () => {
      this.peerListeners.delete(listener);
    };
  };

  /**
   * Changes this person's presence: where they are, what they selected, their pointer, whom they follow. A key set to
   * `undefined` is taken out. Who they are is the room's (`me`), and `editing` reads `viewing` while the file is
   * read-only. The connection sends it at most every `awarenessMs`.
   */
  setLocal(patch: Partial<PeerState>) {
    if (this.dead) return;
    if (patch.mode) this.wantedMode = patch.mode;
    this.applyLocal(patch);
  }

  /** Who this app's person is (after the account changed under the screen). */
  setUser(user: PeerUser) {
    if (this.dead || (user.kind === this.user.kind && user.id === this.user.id)) return;
    this.user = { kind: user.kind, id: user.id };
    this.applyLocal({});
  }

  private applyLocal(patch: Partial<PeerState>) {
    if (this.dead) return;
    const current = (this.awareness.getLocalState() ?? {}) as Partial<PeerState>;
    const next: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if ((key as keyof PeerState) === "user" || (key as keyof PeerState) === "mode") continue;
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    const own: Pick<PeerState, OwnFields> = {
      user: this.user,
      mode: this.connection.state.mode === "edit" ? this.wantedMode : "viewing",
    };
    this.awareness.setLocalState({ ...next, ...own });
  }

  // ── Connection ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** Pings now (the app came back to the front or the network changed); reconnects at once if waiting to. */
  checkAlive() {
    if (!this.dead) this.connection.checkAlive();
  }

  /** The app went to the background (the phone): the socket closes, changes wait. */
  pause() {
    if (!this.dead) this.connection.pause();
  }

  resume() {
    if (!this.dead) this.connection.resume();
  }

  /** Changes not known to be stored, as one update: the phone keeps them across restarts. */
  unsentUpdate(): Uint8Array | null {
    return this.connection.unsentUpdate();
  }

  /** Puts back changes an earlier session kept (`unsentUpdate`): they go once the file loaded. */
  restoreUnsent(update: Uint8Array) {
    if (!this.dead) this.connection.restore(update);
  }

  /**
   * Leaves the file: this person's presence goes (others see them leave at once), what can still be sent goes, and
   * every listener, timer and observer is removed. The document is gone after this.
   */
  destroy() {
    if (this.dead) return;
    this.dead = true;
    this.awareness.setLocalState(null);
    this.connection.stop();
    this.offConnection();
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("change", this.onAwarenessChange);
    this.peerListeners.clear();
    this.docListeners.clear();
    this.sheetEngine?.destroy();
    this.sheetEngine = null;
    this.undo.destroy();
    this.awareness.destroy();
    this.doc.destroy();
  }

  private readonly onDocUpdate = () => {
    this.docVersion++;
    for (const l of [...this.docListeners]) l();
  };

  private readonly onAwarenessChange = () => {
    this.peerCache = null;
    for (const l of [...this.peerListeners]) l();
  };
}
