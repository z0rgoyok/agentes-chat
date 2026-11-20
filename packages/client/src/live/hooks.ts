import type { Peer, PeerUser } from "@agenteschat/live/awareness";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { useApi } from "../api/context";
import { withoutTrailingSlashes } from "../lib/server";
import type { SocketBase, SocketFactory } from "../realtime/connection";
import { loadLiveState } from "./api";
import { type LiveConnectionState, liveSocketUrl } from "./connection";
import { LiveRoom, type LiveRoomOptions } from "./room";
import { acquireLiveRoom, liveRoomKey, releaseLiveRoom } from "./rooms";
import { type LiveSchedule, scheduleSignal, throttleSignal } from "./signals";
import type { LiveFileStatus, LiveKind, LiveMode, LiveRoomError } from "./types";

/**
 * React hooks over a live file's room (ADR 0196), the same in React DOM and React Native: no DOM here, the platform's
 * pieces (its socket, its server's address, animation frames) come in as options.
 */

/** How often the faces of who is in a file redraw at most. */
export const LIVE_PEERS_THROTTLE_MS = 100;

export interface UseLiveRoomOptions {
  /** The platform's WebSocket (the web's `SocketFactoryContext`; the phone's, with its session cookie). */
  socketFactory: SocketFactory;
  /** Where the server is: the page's location on the web, the server's address on the phone. */
  baseUrl: SocketBase;
  /** The phone: bytes as base64 text frames. */
  textFrames?: boolean;
  /** This app's person; nothing opens until it is known. */
  me: PeerUser | null | undefined;
  /** When the screen knows it already. */
  kind?: LiveKind | null;
  /** False keeps the file closed (a card that isn't on screen). */
  enabled?: boolean;
  /** Tests: the connection's clock and waits. */
  connection?: Pick<
    LiveRoomOptions,
    "timers" | "now" | "backoffMs" | "backoffJitter" | "random" | "timing" | "sendRate"
  >;
}

export interface LiveRoomView {
  /** Null until it opened (and when not `enabled`). */
  room: LiveRoom | null;
  status: LiveFileStatus;
  mode: LiveMode;
  error: LiveRoomError | null;
  /** Changes not stored yet ("Salvando…"). */
  unsent: boolean;
  /** The document has the file's content. */
  loaded: boolean;
}

const IDLE: LiveConnectionState = Object.freeze({
  status: "connecting",
  mode: "view",
  unsent: false,
  error: null,
  loaded: false,
  seq: 0,
  kind: null,
});
const NO_PEERS: Peer[] = [];
const noSignal = () => () => {};
const idleState = () => IDLE;
const noPeers = () => NO_PEERS;
const zero = () => 0;

/** The server part of a room's key: the same file on another server is another room. */
function serverOf(base: SocketBase): string {
  if (typeof base !== "string") return `${base.protocol}//${base.host}`;
  return withoutTrailingSlashes(base);
}

/**
 * Opens a live file while the screen shows it: its document loads over HTTP, then the socket keeps it in step. Rooms
 * are shared and kept a moment after the last screen lets go (`acquireLiveRoom`), so going back and forth or React's
 * strict mode never reopens one. The options are read when the room opens; `me` follows changes.
 */
export function useLiveRoom(orgId: string, fileId: string, options: UseLiveRoomOptions): LiveRoomView {
  const api = useApi();
  const { me, enabled = true } = options;
  const server = serverOf(options.baseUrl);
  // `peekLiveRoom(liveRoomKey(...))` finds it (text frames or bytes is the platform's, the same for all its rooms).
  const key = enabled && orgId && fileId && me ? liveRoomKey(orgId, fileId, server) : null;
  // The latest options, read when a room is made (a new factory or base after it opened doesn't reopen it).
  const latest = useRef({ api, options });
  useEffect(() => {
    latest.current = { api, options };
  });
  const [room, setRoom] = useState<LiveRoom | null>(null);

  useEffect(() => {
    if (!key) {
      setRoom(null);
      return;
    }
    const made = acquireLiveRoom(key, () => {
      const { api: client, options: o } = latest.current;
      return new LiveRoom({
        orgId,
        fileId,
        me: o.me as PeerUser,
        kind: o.kind ?? null,
        url: liveSocketUrl(o.baseUrl, orgId, fileId, { textFrames: o.textFrames }),
        createSocket: o.socketFactory,
        loadState: () => loadLiveState(client.live, orgId, fileId),
        ...(o.textFrames ? { textFrames: true } : {}),
        ...o.connection,
      });
    });
    setRoom(made);
    return () => {
      releaseLiveRoom(made);
    };
  }, [key, orgId, fileId]);

  const meKind = me?.kind;
  const meId = me?.id;
  useEffect(() => {
    if (room && meKind && meId) room.setUser({ kind: meKind, id: meId });
  }, [room, meKind, meId]);

  // This file's room only: for the one render after the file changed, the room kept is still the previous file's.
  const current = room && key && !room.destroyed && room.orgId === orgId && room.fileId === fileId ? room : null;
  const state = useSyncExternalStore(
    current ? current.subscribe : noSignal,
    current ? current.getState : idleState,
    current ? current.getState : idleState,
  );
  return {
    room: current,
    status: state.status,
    mode: state.mode,
    error: state.error,
    unsent: state.unsent,
    loaded: state.loaded,
  };
}

/** Who is in the file (this person first), redrawn at most every `throttleMs`. */
export function useLivePeers(room: LiveRoom | null, throttleMs = LIVE_PEERS_THROTTLE_MS): Peer[] {
  const subscribe = useMemo(() => (room ? throttleSignal(room.onPeers, throttleMs) : noSignal), [room, throttleMs]);
  return useSyncExternalStore(subscribe, room ? room.peers : noPeers, room ? room.peers : noPeers);
}

/**
 * A number that goes up whenever the document changed, to redraw from it. `schedule` (stable: defined once) groups the
 * changes until it runs: the web and the phone pass one that runs on the next animation frame, so a burst of changes
 * (an agent filling a sheet) redraws once a frame.
 */
export function useLiveDocVersion(room: LiveRoom | null, schedule?: LiveSchedule): number {
  const subscribe = useMemo(() => (room ? scheduleSignal(room.onDocChange, schedule) : noSignal), [room, schedule]);
  return useSyncExternalStore(subscribe, room ? room.getVersion : zero, room ? room.getVersion : zero);
}

/**
 * What `select` reads from the document, read again after each change and redrawn only when it differs (`isEqual`,
 * `Object.is` by default: return primitives, or pass a comparison for objects). Undefined without a room.
 */
export function useLiveSelector<T>(
  room: LiveRoom | null,
  select: (doc: Y.Doc) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
  schedule?: LiveSchedule,
): T | undefined {
  const memo = useRef<{ room: LiveRoom; version: number; select: (doc: Y.Doc) => T; value: T } | null>(null);
  const subscribe = useMemo(() => (room ? scheduleSignal(room.onDocChange, schedule) : noSignal), [room, schedule]);
  const read = (): T | undefined => {
    if (!room || room.destroyed) return undefined;
    const m = memo.current;
    const version = room.version;
    if (m && m.room === room && m.version === version && m.select === select) return m.value;
    const next = select(room.doc);
    const value = m && m.room === room && isEqual(m.value, next) ? m.value : next;
    memo.current = { room, version, select, value };
    return value;
  };
  return useSyncExternalStore(subscribe, read, read);
}
