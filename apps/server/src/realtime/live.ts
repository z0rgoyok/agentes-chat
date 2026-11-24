import {
  channelTopic,
  fullResync,
  listenResumedTopic,
  orgTopic,
  type PubSub,
  type RateLimiter,
  type Unsubscribe,
} from "@agenteschat/adapters";
import type { Config } from "@agenteschat/config";
import { and, type Database, eq, inArray, schema } from "@agenteschat/db";
import {
  type ArtifactDeps,
  closesWorkspace,
  ForbiddenError,
  getMembership,
  type LiveDocs,
  type LiveSession,
  liveFileAccess,
  NotFoundError,
  type OrgEvent,
  readRefusal,
} from "@agenteschat/engine";
import { LIVE_LIMITS } from "@agenteschat/live";
import { isLivePing, LIVE_CLOSE, LIVE_PONG, LIVE_PONG_UNSAVED, type LiveMode } from "@agenteschat/live/protocol";
import type { Auth } from "../auth";
import type { Logger } from "../logger";
import { allowedOrigins } from "../routes/app/context";
import { personUpgrade, UUID } from "./ws";

/**
 * Live files' sockets (ADR 0196 §3): `GET /api/live?orgId=<uuid>&fileId=<uuid>[&text=1]` carries one spreadsheet,
 * presentation or canvas between a person's app and the document this process hosts for it (`LiveDocs.join`).
 *
 * - Refused before the upgrade like every person socket (`personUpgrade`: 403 for a foreign Origin or a non-member, 401
 *   without a session, 400 for bad parameters), then 429 past `opensPerMinute` opens or `perPerson` open sockets, and
 *   404 for a file the person can't read (`liveFileAccess`, which also says whether they may change it).
 * - Binary frames in y-websocket's framing both ways (sync, awareness). `text=1` carries the same bytes as base64 text
 *   frames: the phone's React Native hands binary frames to JavaScript as base64 anyway. JSON text frames are control:
 *   the server's (`live.ready`, `live.mode`, `live.saved`, `live.versions`, `live.error`, `pong`) and the app's
 *   `{"type":"ping"}`, nothing else. A ping waits in line behind the frames sent before it, so its pong says the
 *   document got every one of them, and whether what they brought is stored yet (`unsaved` when not); pongs go at
 *   most once a second. `live.saved` goes only once no frame of the socket waits in its line.
 * - A frame is at most `frameBytes` (bigger: `live.error` `too_large`, dropped). A socket sends `bytesPerSecond` on
 *   average: frames past it wait their turn, in order (past `frameBytes` waiting the app hears `live.error` `rate`
 *   and slows down), up to `waitingBytes` (then 4429). One that falls `behindBytes` behind on what it is sent closes
 *   1013; the app catches up from its state vector when it reconnects.
 * - The session is read again every `sessionRecheckMs` and before frames at most every `sessionFrameRecheckMs`, access
 *   every `accessRecheckMs` and soon after the person leaves the workspace or the file's conversation, the file is
 *   shared differently, moves, goes to the trash or comes back, or the workspace closes: the mode changes in place
 *   (`live.mode`) or the socket closes 4403 / 4404.
 * - The server pings every `pingMs` (proxies drop idle sockets). Close codes are `LIVE_CLOSE`'s: the apps reconnect
 *   after any but 4403 and 4404.
 */
export const LIVE_PATH = "/api/live";

/** The sockets' limits (ADR 0196 §3); tests make the waits shorter. */
export const LIVE_SOCKET_LIMITS = {
  opensPerMinute: 30,
  perPerson: 12,
  frameBytes: LIVE_LIMITS.updateBytes,
  bytesPerSecond: 512 * 1024,
  waitingBytes: 4 * 1024 * 1024,
  behindBytes: 8 * 1024 * 1024,
  pingMs: 30_000,
  sessionRecheckMs: 15_000,
  sessionFrameRecheckMs: 2_000,
  accessRecheckMs: 30_000,
  /** After an event that may change access: one check this soon, shared by every event meanwhile. */
  eventRecheckMs: 300,
  /** After the Drive changed (`artifacts.changed`): this process's sockets of that workspace look at their files' rows. */
  filesChangedMs: 1_000,
};

export type LiveSocketLimits = { [K in keyof typeof LIVE_SOCKET_LIMITS]: number };

/** A person's socket on one live file. */
export interface LiveSocketData {
  kind: "live";
  orgId: string;
  fileId: string;
  userId: string;
  sessionToken: string;
  /** Bytes go as base64 text frames (`text=1`, the phone). */
  text: boolean;
  /** What the last access check allows: change the file, or only read it (trash, a workspace closing). */
  mode: LiveMode;
  /** Where the file lives: its conversation's events say when it was shared differently or went to the trash. */
  channelId: string | null;
  /** In the trash at the last check: the Drive's changes say when that flips. */
  trashed: boolean;
  /**
   * Who it was shared with at the last check (`sharingKey`): the Drive's changes say when that changes, the only word
   * of it for a file of the Drive itself, which has no conversation (ADR 0157, amendment 2026-11-17).
   */
  sharing: string;
  /** The document's side, once joined. */
  session: LiveSession | null;
  /** Frames and pings in the order they came, waiting for the session or their turn under the rate. */
  queue: (Uint8Array | "ping")[];
  /** Bytes in `queue`; `pinged`: a ping is in it; `slowed`: the app heard `rate` since the queue last emptied. */
  waiting: number;
  pinged: boolean;
  slowed: boolean;
  /** Bytes the socket may send now (a bucket of `frameBytes` that fills at `bytesPerSecond`) and when it was counted. */
  credit: number;
  creditAt: number;
  pumping: boolean;
  /** When the next frame's (or pong's) turn comes. */
  wake: ReturnType<typeof setTimeout> | null;
  /** When the last pong went. */
  lastPong: number;
  sessionValidatedAt: number;
  sessionCheck: Promise<boolean> | null;
  sessionCheckStartedAt: number;
  /** Access is being read now (since `checkStartedAt`); `checkAgain`: an event came meanwhile, so read it once more. */
  checking: boolean;
  checkStartedAt: number;
  checkAgain: boolean;
  /** An access check due soon (`eventRecheckMs`). */
  soon: ReturnType<typeof setTimeout> | null;
  timers: ReturnType<typeof setInterval>[];
  /** The workspace's events, and the file's conversation's (`channelOff`). */
  listeners: Unsubscribe[];
  channelOff: Unsubscribe | null;
  /** Counted among the person's open sockets. */
  counted: boolean;
  /** Closing or closed: nothing more is read or sent. */
  ended: boolean;
  cleaned: boolean;
}

type Socket = Bun.ServerWebSocket<LiveSocketData>;

export interface LiveSocketDeps {
  db: Database;
  auth: Auth;
  config: Config;
  pubsub: PubSub;
  rateLimiter: RateLimiter;
  /** The documents this process hosts. */
  docs: LiveDocs;
  /** Who reads which file (`liveFileAccess`). */
  artifacts: ArtifactDeps;
  log?: Pick<Logger, "warn" | "error">;
  /** Tests: shorter waits, smaller caps. */
  limits?: Partial<LiveSocketLimits>;
}

/** Who a file is shared with, as one string to compare (`LiveSocketData.sharing`). */
/** Who sees and who edits it (ADR 0157, 0202): a change to either checks the sockets' access again. */
const sharingKey = (a: {
  share: string;
  shareUserIds: string[];
  shareRoleIds: string[];
  editorsLimited: boolean;
  editorUserIds: string[];
  editorRoleIds: string[];
  conversationEdits: boolean;
}) =>
  [
    a.share,
    a.shareUserIds.join(","),
    a.shareRoleIds.join(","),
    a.editorsLimited,
    a.editorUserIds.join(","),
    a.editorRoleIds.join(","),
    a.conversationEdits,
  ].join(":");

/** A ping in line with the frames (`LiveSocketData.queue`). */
const PING = "ping";
/** The least time between two pongs (the apps wait as long between pings). */
const PONG_GAP_MS = 1000;

/** Strict base64 (the alphabet, whole quads, padding only at the end): a text frame's bytes, or null. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
function fromBase64(text: string): Uint8Array | null {
  if (text.length === 0 || text.length % 4 !== 0 || !BASE64.test(text)) return null;
  return new Uint8Array(Buffer.from(text, "base64"));
}
const toBase64 = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

export function createLiveSockets(deps: LiveSocketDeps) {
  const origins = allowedOrigins(deps.config);
  const limits: LiveSocketLimits = { ...LIVE_SOCKET_LIMITS, ...deps.limits };
  /** Base64 of a whole frame. */
  const textFrameChars = Math.ceil(limits.frameBytes / 3) * 4;
  const sockets = new Set<Socket>();
  /** Each person's open sockets on this process. */
  const perPerson = new Map<string, number>();
  /** Workspaces whose Drive changed, with their check due (`filesChangedMs`). */
  const drives = new Map<string, ReturnType<typeof setTimeout>>();
  let stopping = false;
  // Pub/sub was deaf for a while (ADR 0010): an event that changed someone's access may have been missed, so every
  // socket reads its access again now instead of at its next period. The documents catch up on their own (`LiveDocs`).
  // Within a minute of that (`fullResync`), the period (`accessRecheckMs`) is soon enough.
  const resumed = deps.pubsub.subscribe(listenResumedTopic, (event) => {
    if (fullResync(event)) for (const ws of sockets) soon(ws);
  });

  /** Closes the socket (once): nothing more is read or sent; `close` cleans up. */
  function shut(ws: Socket, code: number, reason: string) {
    const d = ws.data;
    if (d.ended) return;
    d.ended = true;
    if (d.wake) clearTimeout(d.wake);
    d.wake = null;
    d.queue = [];
    d.waiting = 0;
    d.pinged = false;
    if (ws.readyState === 0 || ws.readyState === 1) ws.close(code, reason);
  }

  /** Something to the person's app: bytes (as base64 on a text socket) or a control frame. */
  function send(ws: Socket, data: Uint8Array | string) {
    const d = ws.data;
    if (d.ended || ws.readyState !== 1) return;
    const out = typeof data === "string" ? data : d.text ? toBase64(data) : data;
    // 0: Bun dropped it (past its own limit); past `behindBytes`: this app won't keep up from here. Either way it would
    // never learn what it missed: closed, it reconnects and catches up from its state vector.
    if (ws.send(out) === 0 || ws.getBufferedAmount() > limits.behindBytes) {
      shut(ws, LIVE_CLOSE.behind, "too far behind");
    }
  }

  const sendError = (ws: Socket, code: "too_large" | "invalid" | "rate") =>
    send(ws, JSON.stringify({ type: "live.error", code }));

  /** The socket as the document sees it (`LiveConn`), with who it is and what it may do. */
  function connOf(ws: Socket) {
    const d = ws.data;
    return {
      text: d.text,
      user: { kind: "person" as const, id: d.userId },
      userId: d.userId,
      get mode() {
        return d.mode;
      },
      send: (data: Uint8Array | string) => send(ws, data),
      close: (code: number, reason?: string) => shut(ws, code, reason ?? ""),
      buffered: () => ws.getBufferedAmount(),
      idle: () => d.waiting === 0,
    };
  }

  /** The session the socket was opened with is still there (the database, never a cached cookie). */
  async function liveSession(ws: Socket, force = false): Promise<boolean> {
    const d = ws.data;
    if (d.ended || ws.readyState !== 1) return false;
    if (!force && Date.now() - d.sessionValidatedAt < limits.sessionFrameRecheckMs) return true;
    if (d.sessionCheck) {
      // Still reading it when the next periodic check comes: the store doesn't answer.
      if (force && Date.now() - d.sessionCheckStartedAt >= limits.sessionRecheckMs) {
        shut(ws, LIVE_CLOSE.internal, "session unavailable");
        return false;
      }
      return d.sessionCheck;
    }
    d.sessionCheckStartedAt = Date.now();
    const check = (async () => {
      try {
        const { internalAdapter } = await deps.auth.$context;
        const found = await internalAdapter.findSession(d.sessionToken);
        if (!found || found.session.userId !== d.userId || found.session.expiresAt <= new Date()) {
          shut(ws, LIVE_CLOSE.forbidden, "session revoked");
          return false;
        }
        d.sessionValidatedAt = Date.now();
        return !d.ended;
      } catch {
        shut(ws, LIVE_CLOSE.internal, "session unavailable");
        return false;
      }
    })();
    d.sessionCheck = check;
    try {
      return await check;
    } finally {
      d.sessionCheck = null;
      d.sessionCheckStartedAt = 0;
    }
  }

  /** The mode access allows now: the document applies it, and the app hears it (`live.mode`). */
  function setMode(ws: Socket, mode: LiveMode) {
    const d = ws.data;
    if (d.mode === mode) return;
    d.mode = mode;
    // Not joined yet: `open` applies it to the session it gets.
    if (!d.session) return;
    modeTo(ws, d.session, mode);
  }

  /**
   * The app hears `live.mode` before the document applies it: back to `edit`, the document asks the app what it lacks
   * (its sync step 1), and an app answers that only once it knows it may change the file (ADR 0196 §3).
   */
  function modeTo(ws: Socket, session: LiveSession, mode: LiveMode) {
    send(ws, JSON.stringify({ type: "live.mode", mode }));
    session.setMode(mode);
  }

  /** The file's conversation, whose events say when the file was shared differently or went to the trash. */
  function watchChannel(ws: Socket, channelId: string | null) {
    const d = ws.data;
    if (d.ended || (d.channelId === channelId && (d.channelOff !== null) === (channelId !== null))) return;
    d.channelOff?.();
    d.channelOff = null;
    d.channelId = channelId;
    if (!channelId) return;
    d.channelOff = deps.pubsub.subscribe(channelTopic(channelId), (event) => {
      const id =
        event.type === "artifact.updated"
          ? (event.artifact as { id?: unknown } | undefined)?.id
          : event.type === "artifact.deleted"
            ? event.artifactId
            : undefined;
      if (id === d.fileId) soon(ws);
    });
  }

  /** Access read again soon: what came meanwhile shares one check. */
  function soon(ws: Socket) {
    const d = ws.data;
    if (d.ended || d.soon) return;
    d.soon = setTimeout(() => {
      d.soon = null;
      void recheck(ws, false);
    }, limits.eventRecheckMs);
  }

  /**
   * Whether the person may still have the file, and how: still a member of a workspace they can read, still reading
   * the file (`liveFileAccess`). The mode changes in place; anything else closes the socket.
   */
  async function recheck(ws: Socket, periodic: boolean) {
    const d = ws.data;
    if (d.ended) return;
    if (d.checking) {
      // One still running a whole period later: the database doesn't answer, and nothing private stays open unchecked.
      if (periodic && Date.now() - d.checkStartedAt >= limits.accessRecheckMs) {
        shut(ws, LIVE_CLOSE.internal, "access unavailable");
      } else d.checkAgain = true;
      return;
    }
    d.checking = true;
    d.checkStartedAt = Date.now();
    try {
      // `liveFileAccess` reads the membership too: only a refusal needs it again, to say which one it is.
      const access = await liveFileAccess(deps.artifacts, { type: "person", userId: d.userId }, d.orgId, d.fileId);
      if (d.ended) return;
      if (!access) {
        const member = await getMembership(deps.db, d.userId, d.orgId);
        if (d.ended) return;
        if (!member || readRefusal(member.standing)) return shut(ws, LIVE_CLOSE.forbidden, "membership revoked");
        return shut(ws, LIVE_CLOSE.notFound, "file not found");
      }
      d.trashed = Boolean(access.artifact.deletedAt);
      d.sharing = sharingKey(access.artifact);
      watchChannel(ws, access.artifact.channelId ?? null);
      setMode(ws, access.mode);
    } catch (error) {
      deps.log?.warn("live file access check failed", {
        orgId: d.orgId,
        fileId: d.fileId,
        userId: d.userId,
        error: String(error),
      });
      shut(ws, LIVE_CLOSE.internal, "access unavailable");
    } finally {
      d.checking = false;
      if (d.checkAgain) {
        d.checkAgain = false;
        soon(ws);
      }
    }
  }

  /**
   * The Drive changed somewhere in `orgId` (ids aren't said): once a `filesChangedMs`, this process's sockets of that
   * workspace look at their files' rows, and those whose file went to the trash, came back, moved, was shared
   * differently or is gone read their access again. One query for all of them, however many changes came.
   */
  function filesChanged(orgId: string) {
    if (drives.has(orgId)) return;
    const timer = setTimeout(() => {
      drives.delete(orgId);
      void lookAtFiles(orgId).catch((error: unknown) =>
        deps.log?.warn("live files check failed", { orgId, error: String(error) }),
      );
    }, limits.filesChangedMs);
    drives.set(orgId, timer);
  }

  async function lookAtFiles(orgId: string) {
    const open = [...sockets].filter((ws) => ws.data.orgId === orgId && !ws.data.ended);
    if (open.length === 0) return;
    const ids = [...new Set(open.map((ws) => ws.data.fileId))];
    const rows = await deps.db
      .select({
        id: schema.artifacts.id,
        channelId: schema.artifacts.channelId,
        deletedAt: schema.artifacts.deletedAt,
        share: schema.artifacts.share,
        shareUserIds: schema.artifacts.shareUserIds,
        shareRoleIds: schema.artifacts.shareRoleIds,
        editorsLimited: schema.artifacts.editorsLimited,
        editorUserIds: schema.artifacts.editorUserIds,
        editorRoleIds: schema.artifacts.editorRoleIds,
        conversationEdits: schema.artifacts.conversationEdits,
      })
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.orgId, orgId), inArray(schema.artifacts.id, ids)));
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const ws of open) {
      const d = ws.data;
      const row = byId.get(d.fileId);
      const same =
        row && row.channelId === d.channelId && (row.deletedAt !== null) === d.trashed && sharingKey(row) === d.sharing;
      if (!same) soon(ws);
    }
  }

  /** The workspace's events that may change what the person may do in the file. */
  function listen(ws: Socket) {
    const d = ws.data;
    d.listeners.push(
      deps.pubsub.subscribe(orgTopic(d.orgId), (raw) => {
        if (d.ended) return;
        const event = raw as unknown as OrgEvent;
        if (event.type === "membership.revoked") {
          if (event.userId !== d.userId) return;
          // Out of the workspace: closed at once, outside the publisher's call stack (in-memory pub/sub delivers
          // synchronously). Out of a conversation: the file may still be theirs to read some other way.
          if (!event.channelId) return queueMicrotask(() => shut(ws, LIVE_CLOSE.forbidden, "membership revoked"));
          if (event.channelId === d.channelId) soon(ws);
          return;
        }
        if (event.type === "channel.archived") {
          if (event.channelId === d.channelId) soon(ws);
          return;
        }
        if (event.type !== "org.broadcast") return;
        const inner = event.event;
        if (closesWorkspace(inner)) return queueMicrotask(() => shut(ws, LIVE_CLOSE.forbidden, "organization closed"));
        // Being deleted (read-only from now on), or its standing changed some other way.
        if (inner.type === "org.deleting" || inner.type === "org.standing") return soon(ws);
        if (inner.type === "artifacts.changed") filesChanged(d.orgId);
      }),
    );
    watchChannel(ws, d.channelId);
  }

  /** Bytes the socket may send now: 0 when `size` fits (and is taken), else how long until it does. */
  function take(d: LiveSocketData, size: number): number {
    const now = Date.now();
    d.credit = Math.min(limits.frameBytes, d.credit + ((now - d.creditAt) * limits.bytesPerSecond) / 1000);
    d.creditAt = now;
    if (d.credit >= size) {
      d.credit -= size;
      return 0;
    }
    return Math.max(1, Math.ceil(((size - d.credit) * 1000) / limits.bytesPerSecond));
  }

  /** Runs `pump` again in `ms`, unless it is due sooner already. */
  function later(ws: Socket, ms: number) {
    const d = ws.data;
    d.wake ??= setTimeout(() => {
      d.wake = null;
      void pump(ws);
    }, ms);
  }

  /**
   * The frames that came, to the document, one at a time in the order they came: the session read again first when
   * it is due, each frame when the rate gives it its turn, each ping's pong once those before it are in. Never two at
   * once, so nothing that awaits reorders them.
   */
  async function pump(ws: Socket) {
    const d = ws.data;
    if (d.pumping) return;
    d.pumping = true;
    try {
      while (!d.ended && d.session && d.queue.length > 0) {
        if (Date.now() - d.sessionValidatedAt >= limits.sessionFrameRecheckMs) {
          if (!(await liveSession(ws))) return;
          continue;
        }
        const item = d.queue[0] as Uint8Array | "ping";
        if (item === PING) {
          const wait = d.lastPong + PONG_GAP_MS - Date.now();
          if (wait > 0) return later(ws, wait);
          d.queue.shift();
          d.pinged = false;
          d.lastPong = Date.now();
          // Whether every change the frames before it brought is stored: the app counts them stored only then.
          send(ws, d.session.allStored() ? LIVE_PONG : LIVE_PONG_UNSAVED);
          continue;
        }
        const wait = take(d, item.byteLength);
        if (wait > 0) return later(ws, wait);
        d.queue.shift();
        d.waiting -= item.byteLength;
        try {
          d.session.message(item);
        } catch (error) {
          // What the document couldn't read is the app's to fix: it hears so, and the socket goes on.
          deps.log?.warn("live frame refused", { orgId: d.orgId, fileId: d.fileId, error: String(error) });
          sendError(ws, "invalid");
        }
        // Its last frame in: a `live.saved` held back while frames waited goes now.
        if (d.waiting === 0) d.session?.drained();
      }
      if (d.queue.length === 0) d.slowed = false;
    } finally {
      d.pumping = false;
    }
  }

  /** A frame of bytes for the document: it waits its turn behind those before it. */
  function enqueue(ws: Socket, frame: Uint8Array) {
    const d = ws.data;
    if (d.waiting + frame.byteLength > limits.waitingBytes) return shut(ws, LIVE_CLOSE.tooMany, "too much input");
    d.queue.push(frame);
    d.waiting += frame.byteLength;
    // More waits than a second's worth: the app halves its pace when it hears so.
    if (d.waiting > limits.frameBytes && !d.slowed) {
      d.slowed = true;
      sendError(ws, "rate");
    }
    void pump(ws);
  }

  /**
   * The app's control frames: only `ping`, in line behind the frames before it (its pong says the document got them)
   * and answered at most once a second; one more while one waits shares its pong. The rest is ignored.
   */
  function control(ws: Socket, raw: string) {
    const d = ws.data;
    if (!isLivePing(raw) || d.pinged) return;
    d.pinged = true;
    d.queue.push(PING);
    void pump(ws);
  }

  /** Why joining failed, as the socket's close: no such file, not theirs, or our side. */
  function refusedJoin(ws: Socket, error: unknown) {
    const d = ws.data;
    if (error instanceof NotFoundError) return shut(ws, LIVE_CLOSE.notFound, "file not found");
    if (error instanceof ForbiddenError) return shut(ws, LIVE_CLOSE.forbidden, "forbidden");
    deps.log?.error("live file join failed", {
      orgId: d.orgId,
      fileId: d.fileId,
      userId: d.userId,
      error,
      stack: (error as Error | null)?.stack,
    });
    shut(ws, LIVE_CLOSE.internal, "unavailable");
  }

  return {
    paths: new Set<string>([LIVE_PATH]),

    /** The checks before the socket opens, else the refusal (see above). */
    async upgrade(req: Request, server: Bun.Server<LiveSocketData>): Promise<Response | undefined> {
      if (stopping) return new Response("The server is restarting", { status: 503 });
      const q = new URL(req.url).searchParams;
      const orgId = q.get("orgId") ?? "";
      const user = await personUpgrade(deps, origins, req, orgId);
      if (user instanceof Response) return user;
      const fileId = q.get("fileId") ?? "";
      if (!UUID.test(fileId)) return new Response("fileId is required", { status: 400 });
      const rate = await deps.rateLimiter.consume(`live-open:${user.id}`, {
        limit: limits.opensPerMinute,
        windowMs: 60_000,
      });
      if (!rate.allowed) return new Response("Too many files opened: try again in a minute", { status: 429 });
      if ((perPerson.get(user.id) ?? 0) >= limits.perPerson) {
        return new Response("Too many files open at once: close one first", { status: 429 });
      }
      const access = await liveFileAccess(deps.artifacts, { type: "person", userId: user.id }, orgId, fileId);
      if (!access) return new Response("File not found", { status: 404 });
      const now = Date.now();
      const data: LiveSocketData = {
        kind: "live",
        orgId,
        fileId,
        userId: user.id,
        sessionToken: user.sessionToken,
        text: q.get("text") === "1",
        mode: access.mode,
        channelId: access.artifact.channelId ?? null,
        trashed: Boolean(access.artifact.deletedAt),
        sharing: sharingKey(access.artifact),
        session: null,
        queue: [],
        waiting: 0,
        pinged: false,
        slowed: false,
        credit: limits.frameBytes,
        creditAt: now,
        pumping: false,
        wake: null,
        lastPong: 0,
        sessionValidatedAt: 0,
        sessionCheck: null,
        sessionCheckStartedAt: 0,
        checking: false,
        checkStartedAt: 0,
        checkAgain: false,
        soon: null,
        timers: [],
        listeners: [],
        channelOff: null,
        counted: false,
        ended: false,
        cleaned: false,
      };
      return server.upgrade(req, { data }) ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    },

    /**
     * Opened: the session read again, the workspace's events heard, then the document joined (it sends `live.ready`,
     * its sync step 1 and who else is in). The mode access gave wins over the document's own idea of it, before any
     * frame the app sent meanwhile is read.
     */
    async open(ws: Socket) {
      const d = ws.data;
      sockets.add(ws);
      const open = (perPerson.get(d.userId) ?? 0) + 1;
      perPerson.set(d.userId, open);
      d.counted = true;
      if (stopping) return shut(ws, LIVE_CLOSE.goingAway, "server restarting");
      // Two upgrades raced past the count.
      if (open > limits.perPerson) return shut(ws, LIVE_CLOSE.tooMany, "too many files open");
      try {
        if (!(await liveSession(ws, true))) return;
        listen(ws);
        const session: LiveSession = await deps.docs.join(d.orgId, d.fileId, connOf(ws));
        if (d.ended) {
          // Closed while it joined: `close` found no session to leave.
          session.leave();
          return;
        }
        d.session = session;
        if (session.mode !== d.mode) modeTo(ws, session, d.mode);
      } catch (error) {
        // Nothing half open stays: the app hears why (or that it was our side) and opens it again if it may.
        if (!d.ended) refusedJoin(ws, error);
        return;
      }
      d.timers.push(
        setInterval(() => void liveSession(ws, true), limits.sessionRecheckMs),
        setInterval(() => void recheck(ws, true), limits.accessRecheckMs),
        setInterval(() => {
          if (ws.readyState === 1) ws.ping();
        }, limits.pingMs),
      );
      void pump(ws);
    },

    message(ws: Socket, raw: string | Buffer) {
      const d = ws.data;
      if (d.ended) return;
      if (typeof raw === "string") {
        // `{`: control (base64 never starts with it).
        if (raw.charCodeAt(0) === 123) return control(ws, raw);
        if (!d.text) return sendError(ws, "invalid");
        if (raw.length > textFrameChars) return sendError(ws, "too_large");
        const bytes = fromBase64(raw);
        return bytes ? enqueue(ws, bytes) : sendError(ws, "invalid");
      }
      if (raw.byteLength > limits.frameBytes) return sendError(ws, "too_large");
      if (raw.byteLength === 0) return sendError(ws, "invalid");
      // A copy: the document may keep the bytes past this call.
      enqueue(ws, new Uint8Array(raw));
    },

    close(ws: Socket) {
      const d = ws.data;
      d.ended = true;
      if (d.cleaned) return;
      d.cleaned = true;
      sockets.delete(ws);
      if (d.counted) {
        const left = (perPerson.get(d.userId) ?? 1) - 1;
        if (left > 0) perPerson.set(d.userId, left);
        else perPerson.delete(d.userId);
      }
      for (const timer of d.timers) clearInterval(timer);
      d.timers = [];
      if (d.wake) clearTimeout(d.wake);
      if (d.soon) clearTimeout(d.soon);
      d.wake = null;
      d.soon = null;
      for (const off of d.listeners) off();
      d.listeners = [];
      d.channelOff?.();
      d.channelOff = null;
      d.queue = [];
      d.waiting = 0;
      d.pinged = false;
      const session = d.session;
      d.session = null;
      if (!session) return;
      try {
        session.leave();
      } catch (error) {
        deps.log?.warn("live file leave failed", { orgId: d.orgId, fileId: d.fileId, error: String(error) });
      }
    },

    /**
     * Shutdown: no more sockets, and the open ones close 1001 (the apps reconnect to the next instance, and their
     * changes not yet stored go again from their state vectors). The documents keep serving agents' tools until
     * `LiveDocs.stop` stores what they hold.
     */
    stop() {
      if (stopping) return;
      stopping = true;
      resumed();
      for (const timer of drives.values()) clearTimeout(timer);
      drives.clear();
      for (const ws of sockets) shut(ws, LIVE_CLOSE.goingAway, "server restarting");
    },

    /** Sockets open now on this process (tests, the shutdown's log). */
    count: () => sockets.size,
  };
}

export type LiveSockets = ReturnType<typeof createLiveSockets>;
