import { type LiveKind, type LiveRoom, type LiveRoomView, useLiveRoom } from "@agenteschat/client";
import type { PeerUser } from "@agenteschat/live/awareness";
import { useIsFocused } from "expo-router";
import { useEffect, useMemo, useRef } from "react";
import { AppState } from "react-native";
import { lastCookie, readCookie } from "@/lib/auth";
import { useServer } from "@/lib/server";
import { createSocketFactory } from "@/lib/socket";
import { INACTIVE_GRACE_MS, useAppActive } from "@/lib/useAppActive";
import { useMeId, useOrgId } from "../../shared/hooks";
import { keptChangesFor } from "./kept";

/**
 * A live file open on the phone (ADR 0196): its document over HTTP, then its own socket (`/api/live`, bytes as base64
 * text, since React Native hands binary frames to JavaScript as base64 anyway), with the session cookie and the app's
 * header on the upgrade. Every screen showing the file shares one room (`useLiveRoom`), connected while any of them is
 * on screen with the app in front: a screen pushed over it, or the app in the background, lets it go after a moment
 * (the person leaves the faces of everyone else in the file), and coming back catches up from where it was.
 *
 * Changes made here the server hasn't stored yet are kept on the phone per server (`keptChangesFor`): the app closed
 * offline, they go back into the file next time it opens and are sent once it caught up.
 *
 * The slides and canvas screens use it the same way: `room.doc` with `@agenteschat/live`'s edits in the `LOCAL`
 * origin, `room.setLocal(...)` for presence, `useLivePeers(room)` for everyone else.
 */
export interface LiveDoc extends LiveRoomView {
  orgId: string;
  /** This person, as the file's presence names them (null while the account loads). */
  me: PeerUser | null;
}

/** How long a screen out of sight keeps the file open (a quick look at another screen keeps it). */
export const LIVE_AWAY_MS = 4000;
/** Changes are written to the phone this long after the last one (and at once when the app leaves the front). */
const KEEP_AFTER_MS = 400;

/** The screens that want each room connected now: it pauses only when none does. */
const wanting = new WeakMap<LiveRoom, Set<symbol>>();
const pauses = new WeakMap<LiveRoom, ReturnType<typeof setTimeout>>();

function want(room: LiveRoom, who: symbol, on: boolean, awayMs: number) {
  const set = wanting.get(room) ?? new Set<symbol>();
  wanting.set(room, set);
  if (on) set.add(who);
  else set.delete(who);
  const pending = pauses.get(room);
  if (pending) clearTimeout(pending);
  pauses.delete(room);
  if (set.size > 0) {
    room.resume();
    room.checkAlive();
    return;
  }
  if (awayMs <= 0) {
    room.pause();
    return;
  }
  pauses.set(
    room,
    setTimeout(() => {
      pauses.delete(room);
      if ((wanting.get(room)?.size ?? 0) === 0) room.pause();
    }, awayMs),
  );
}

/** Rooms whose kept changes were put back already (a room is shared by the screens showing its file). */
const restored = new WeakSet<LiveRoom>();

/** Keeps the room's unsent changes on the phone while it has any, and puts back what an earlier run kept. */
function useKeptChanges(room: LiveRoom | null, server: string) {
  useEffect(() => {
    if (!room) return;
    const store = keptChangesFor(server);
    if (!restored.has(room)) {
      restored.add(room);
      const kept = store.read(room.fileId);
      if (kept) room.restoreUnsent(kept);
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const save = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (room.destroyed) return;
      store.write(room.fileId, room.unsent ? room.unsentUpdate() : null);
    };
    const later = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(save, KEEP_AFTER_MS);
    };
    let was = room.unsent;
    const offState = room.subscribe(() => {
      if (room.unsent === was) return;
      was = room.unsent;
      // Stored by the server: nothing to keep. New ones: kept a moment later, with whatever follows them.
      if (!room.unsent) save();
      else later();
    });
    const offDoc = room.onDocChange(() => {
      if (room.unsent) later();
    });
    const offApp = AppState.addEventListener("change", (s) => {
      if (s !== "active" && room.unsent) save();
    });
    return () => {
      offState();
      offDoc();
      offApp.remove();
      if (timer) save();
    };
  }, [room, server]);
}

/** Opens a live file for this screen (see `LiveDoc`). `kind` when the screen knows it (it sets the person's undo). */
export function useLiveDoc(fileId: string, options: { kind?: LiveKind | null; awayMs?: number } = {}): LiveDoc {
  const orgId = useOrgId();
  const meId = useMeId();
  const server = useServer();
  const me = useMemo<PeerUser | null>(() => (meId ? { kind: "person", id: meId } : null), [meId]);
  // The cookie is read again at every (re)connect.
  const socketFactory = useMemo(() => createSocketFactory(lastCookie), []);
  useEffect(() => {
    void readCookie();
  }, []);
  const view = useLiveRoom(orgId, fileId, {
    socketFactory,
    baseUrl: server,
    textFrames: true,
    me,
    kind: options.kind ?? null,
  });
  const room = view.room;

  // On screen: on top (its conversation pushed over it lets the room go after `awayMs`, as any screen over it).
  const focused = useIsFocused();
  const active = useAppActive(INACTIVE_GRACE_MS);
  const who = useRef(Symbol("live-screen")).current;
  const awayMs = options.awayMs ?? LIVE_AWAY_MS;
  useEffect(() => {
    if (!room) return;
    // In the background the system suspends the app: the socket goes at once, and the file catches up on return.
    want(room, who, focused && active, active ? awayMs : 0);
  }, [room, who, focused, active, awayMs]);
  useEffect(() => {
    if (!room) return;
    return () => want(room, who, false, LIVE_AWAY_MS);
  }, [room, who]);

  useKeptChanges(room, server);
  return { ...view, orgId, me };
}
