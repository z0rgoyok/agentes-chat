import type { Timers } from "../realtime/connection";
import type { LiveRoom } from "./room";

/**
 * The live files open in this app, shared by every screen that shows one (the file's page, a card's preview, the
 * phone's screens of one file): one room per file, kept while anyone holds it and for `LIVE_ROOM_RELEASE_MS` after
 * (a screen remounting, React's strict mode, going back and forth), so nothing reconnects or loads twice.
 */

/** How long a room stays after its last holder let go. */
export const LIVE_ROOM_RELEASE_MS = 1500;

type ReleaseTimers = Pick<Timers, "setTimeout" | "clearTimeout">;

interface Entry {
  room: LiveRoom;
  refs: number;
  timer: unknown;
  timers: ReleaseTimers | null;
}

const realTimers: ReleaseTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

const entries = new Map<string, Entry>();
const keyOfRoom = new WeakMap<LiveRoom, string>();

/** A room's key: the server (an app may hold several workspaces' servers), the workspace and the file. */
export function liveRoomKey(orgId: string, fileId: string, server = ""): string {
  return `${server}|${orgId}|${fileId}`;
}

function cancelRelease(entry: Entry) {
  if (entry.timer === null) return;
  (entry.timers ?? realTimers).clearTimeout(entry.timer);
  entry.timer = null;
  entry.timers = null;
}

/**
 * The room for `key`, made with `make` the first time (or when the one there was destroyed, or closed for good with
 * nobody holding it: the file may be readable again). Each call holds it once: let go with `releaseLiveRoom`.
 */
export function acquireLiveRoom(key: string, make: () => LiveRoom): LiveRoom {
  let entry = entries.get(key);
  if (entry && (entry.room.destroyed || (entry.refs === 0 && entry.room.state.status === "closed"))) {
    cancelRelease(entry);
    entries.delete(key);
    entry.room.destroy();
    entry = undefined;
  }
  if (!entry) {
    const room = make();
    entry = { room, refs: 0, timer: null, timers: null };
    entries.set(key, entry);
    keyOfRoom.set(room, key);
  }
  cancelRelease(entry);
  entry.refs++;
  return entry.room;
}

/**
 * Lets go of a room once (each `acquireLiveRoom` once). Nobody holding it any more, it is destroyed `delayMs` later
 * (`LIVE_ROOM_RELEASE_MS`) unless someone takes it again meanwhile; 0 destroys it at once.
 */
export function releaseLiveRoom(room: LiveRoom, options: { delayMs?: number; timers?: ReleaseTimers } = {}) {
  const key = keyOfRoom.get(room);
  const entry = key === undefined ? undefined : entries.get(key);
  if (!entry || entry.room !== room || key === undefined) {
    // Not one of ours (made by hand): it ends with its only holder.
    if (!entry) room.destroy();
    return;
  }
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs > 0) return;
  const close = () => {
    if (entries.get(key) !== entry || entry.refs > 0) return;
    entry.timer = null;
    entry.timers = null;
    entries.delete(key);
    room.destroy();
  };
  const delay = options.delayMs ?? LIVE_ROOM_RELEASE_MS;
  cancelRelease(entry);
  if (delay <= 0) return close();
  const timers = options.timers ?? realTimers;
  entry.timers = timers;
  entry.timer = timers.setTimeout(close, delay);
}

/** The room open for `key`, if any (without holding it). */
export function peekLiveRoom(key: string): LiveRoom | null {
  const room = entries.get(key)?.room;
  return room && !room.destroyed ? room : null;
}

/** How many rooms are open now (tests, diagnostics). */
export function liveRoomsOpen(): number {
  return entries.size;
}

/** Destroys every open room at once (signing out, switching servers, tests). */
export function closeAllLiveRooms() {
  for (const [key, entry] of [...entries]) {
    cancelRelease(entry);
    entries.delete(key);
    entry.room.destroy();
  }
}
