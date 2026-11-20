import {
  type LiveKind,
  LiveRoom,
  type LiveRoomView,
  loadLiveState,
  type SocketLike,
  useLiveRoom,
} from "@agenteschat/client";
import type { PeerUser } from "@agenteschat/live/awareness";
import { useQuery } from "@tanstack/react-query";
import { useContext, useEffect, useMemo, useState } from "react";
import { useApi } from "@/api/context";
import { useOrg } from "@/components/org-context";
import { SocketFactoryContext } from "@/realtime/context";

/**
 * A live file's room on the web and in the desktop app (ADR 0196 §3): the app's own sockets (`SocketFactoryContext`,
 * a test's fake server), this page's server, and the signed-in person. A page that comes back into view or a network
 * that comes back pings the socket at once, so a laptop that slept doesn't sit on a dead connection until the next
 * ping.
 */
export function useLiveRoomWeb(
  orgId: string,
  fileId: string,
  options: { kind?: LiveKind | null; enabled?: boolean } = {},
): LiveRoomView {
  const socketFactory = useContext(SocketFactoryContext);
  const { me } = useOrg();
  const userId = me.user.id;
  const person = useMemo<PeerUser>(() => ({ kind: "person", id: userId }), [userId]);
  const view = useLiveRoom(orgId, fileId, {
    socketFactory,
    baseUrl: { protocol: window.location.protocol, host: window.location.host },
    me: person,
    kind: options.kind ?? null,
    enabled: options.enabled ?? true,
  });
  const room = view.room;
  useEffect(() => {
    if (!room) return;
    const alive = () => {
      if (document.visibilityState === "visible") room.checkAlive();
    };
    document.addEventListener("visibilitychange", alive);
    window.addEventListener("online", alive);
    window.addEventListener("focus", alive);
    return () => {
      document.removeEventListener("visibilitychange", alive);
      window.removeEventListener("online", alive);
      window.removeEventListener("focus", alive);
    };
  }, [room]);
  return view;
}

/** A socket that never opens: a saved version is read once over HTTP and never kept in step. */
function stillSocket(): SocketLike {
  return {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send() {},
    close() {},
  };
}

/**
 * A saved version of the file as a room of its own, read-only (the history's look at it, ADR 0196 §7): the editors
 * draw it as they draw the file, with nothing to send and no one else in it. Null until it loaded, or without
 * `version`.
 */
export function useLiveVersionRoom(
  orgId: string,
  fileId: string,
  version: number | undefined,
  kind: LiveKind | null,
): { room: LiveRoom | null; failed: boolean; retry: () => void } {
  const api = useApi();
  const { me } = useOrg();
  const userId = me.user.id;
  const query = useQuery({
    queryKey: ["org", orgId, "live", "version-state", fileId, version ?? 0],
    queryFn: () => loadLiveState(api.live, orgId, fileId, version),
    enabled: Boolean(version && kind),
    // A version never changes.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 60_000,
  });
  const [room, setRoom] = useState<LiveRoom | null>(null);
  const loaded = query.data;
  useEffect(() => {
    if (!loaded || !kind) {
      setRoom(null);
      return;
    }
    const made = new LiveRoom({
      orgId,
      fileId,
      me: { kind: "person", id: userId },
      kind,
      url: "about:blank",
      createSocket: stillSocket,
      loadState: async () => loaded,
    });
    setRoom(made);
    return () => made.destroy();
  }, [loaded, kind, orgId, fileId, userId]);
  return { room, failed: query.isError, retry: () => void query.refetch() };
}
