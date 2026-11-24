/**
 * Real-time fan-out between server instances (docs/adr/0010-realtime.md).
 * Core: in-memory (one process) or Postgres LISTEN/NOTIFY (several replicas).
 * Cloud may register Redis pub/sub. Postgres stays the source of truth: only
 * already-committed facts and ephemeral stream deltas travel here.
 */
export interface RealtimeEvent {
  type: string;
  [key: string]: unknown;
}

export type Unsubscribe = () => void;

export interface PubSub {
  publish(topic: string, event: RealtimeEvent): Promise<void>;
  /** Handlers run for events published by any instance, including this one. */
  subscribe(topic: string, handler: (event: RealtimeEvent) => void): Unsubscribe;
  close?(): Promise<void>;
}

/**
 * For a transaction: `pubsub` keeps what its steps publish, and `flush` sends it after the commit, each event once.
 * An app told earlier would read the rows before they exist, and one told of a rollback would read rows that never do.
 */
export function holdEvents<T extends PubSub | undefined>(target: T) {
  const held = new Map<string, [string, RealtimeEvent]>();
  const holding: PubSub | undefined = target && {
    publish: async (topic, event) => void held.set(`${topic} ${JSON.stringify(event)}`, [topic, event]),
    subscribe: (topic, handler) => target.subscribe(topic, handler),
  };
  const pubsub = holding as T;
  const flush = async () => {
    for (const [topic, event] of held.values()) await target?.publish(topic, event).catch(() => {});
    held.clear();
  };
  return { pubsub, flush };
}

/** Topic of everything happening in one channel. */
export const channelTopic = (channelId: string) => `channel:${channelId}`;

/** Server-side: every `user.typing`, also published on its channel's topic (an agent's quiet window, ADR 0112). */
export const typingTopic = "typing";

/** Server-side organization events (membership changes). Never forwarded to clients as is. */
export const orgTopic = (orgId: string) => `org:${orgId}`;

/** Events for one person in one organization (approvals waiting for them, DMs). */
export const userTopic = (orgId: string, userId: string) => `user:${orgId}:${userId}`;

/** Server-side: each new message's channel, for the unread marks of its members' sockets. Never forwarded as is. */
export const chatActivityTopic = "chat-activity";

/** Server-side signal that one upload to the Drive finished (`upload_file`, ADR 0025). Never forwarded to clients. */
export const uploadTopic = (uploadId: string) => `upload:${uploadId}`;

/** Server-side: a request (`machine_rpc` row) for a machine whose socket this replica holds (ADR 0025). */
export const machineRpcTopic = (replicaId: string) => `machine-rpc:${replicaId}`;

/** Server-side: the reply to one `machine_rpc` row is written. */
export const machineRpcReplyTopic = (rpcId: string) => `machine-rpc-reply:${rpcId}`;

/** Server-side: the `brain.event` frames of one run's brain turn on a connected computer (ADR 0032). */
export const brainTopic = (runId: string) => `brain:${runId}`;

/**
 * Server-side: one live file's stored changes and presence, between the processes that hold it (ADR 0196 §4): each
 * change's number (and the change itself when it fits), presence updates. Never forwarded to clients as is.
 */
export const liveTopic = (fileId: string) => `live:${fileId}`;

/**
 * Server-side: who is in each live file, as each process sees it (ADR 0196 §5), every workspace's on one topic, since
 * the process asked who is in a file may hold none of it. Ids only. Never forwarded.
 */
export const livePresenceTopic = "live-presence";

function deliver(handlers: Set<(event: RealtimeEvent) => void> | undefined, event: RealtimeEvent) {
  for (const handler of handlers ?? []) {
    try {
      handler(event);
    } catch {
      // One broken subscriber must not stop the others.
    }
  }
}

class Registry {
  readonly topics = new Map<string, Set<(event: RealtimeEvent) => void>>();
  add(topic: string, handler: (event: RealtimeEvent) => void): Unsubscribe {
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.topics.delete(topic);
    };
  }
}

/** Single-process pub/sub. Default for tests and single-instance self-host. */
export function createMemoryPubSub(): PubSub {
  const registry = new Registry();
  return {
    async publish(topic, event) {
      deliver(registry.topics.get(topic), structuredClone(event));
    },
    subscribe: (topic, handler) => registry.add(topic, handler),
  };
}

/** Minimal LISTEN/NOTIFY surface, implemented by postgres.js (prod) and PGlite (tests). */
export interface PgNotifier {
  /** `onListen`: each time the LISTEN is in place (postgres.js: at first, and whenever its connection came back). */
  listen(channel: string, onPayload: (payload: string) => void, onListen?: () => void): Promise<() => Promise<void>>;
  notify(channel: string, payload: string): Promise<void>;
  /** Several notifications in one statement (one round trip), in order. Optional. */
  notifyMany?(channel: string, payloads: string[]): Promise<void>;
  /**
   * Drops the LISTEN's connection without waiting on it, its subscriptions with it: the next `listen` opens a new one.
   * Optional; without it, a LISTEN made again leaves the old one to its driver.
   */
  restart?(): Promise<void>;
  /** Releases what `listen` opened, at shutdown. Optional. */
  close?(): Promise<void>;
}

/**
 * Local to each replica, never sent to Postgres: events published meanwhile never reached its subscribers (its LISTEN
 * was deaf, or some NOTIFY failed), so the apps on its sockets must read again.
 */
export const listenResumedTopic = "pubsub.resumed";

/**
 * How often at most a replica's missed events have its subscribers start over (close every browser socket, forget
 * every cache): each `listenResumedTopic` event says whether it is that one (`full`) or a gentler resync between two.
 * Starting over makes every app read its workspace again; a burst of marks doing it each time keeps the database
 * busy enough to miss the next NOTIFY too.
 */
export const FULL_RESYNC_MS = 60_000;

/** Whether a `listenResumedTopic` event asks to start over; one without `full` (a test's, an older publisher's) does. */
export const fullResync = (event: RealtimeEvent): boolean => event.full !== false;

/**
 * How often a replica checks that its events still go out and come back: its own heartbeat goes through the same
 * queue, NOTIFY and LISTEN as every event, and must be heard again.
 */
export const LISTEN_HEARTBEAT_MS = 15_000;

/** How long one NOTIFY statement may take before the queue goes on without it (it may still go through, late). */
export const NOTIFY_TIMEOUT_MS = 5_000;

/**
 * How long a NOTIFY statement may stay unanswered before its events count as missed. Far above `NOTIFY_TIMEOUT_MS`: a
 * NOTIFY waiting for a free pool connection on a busy server (the minutes after a restart) still goes out, and calling
 * it missed tells every replica's subscribers to read again: every browser socket closed and every app reading its
 * whole workspace again, which keeps the database busy enough for the next NOTIFY to be slow too.
 */
export const NOTIFY_LOST_MS = 60_000;

/** How long making the LISTEN again may take; past it, the next heartbeat tries again. */
export const LISTEN_TIMEOUT_MS = 10_000;

/** The most payloads one NOTIFY statement carries. */
const MAX_BATCH = 200;

/** Payloads waiting while NOTIFY fails: past this the oldest are dropped, counted as missed. */
const MAX_QUEUED = 10_000;

/** What breaks, and its end (`resumed`), for the server's log: `createPostgresPubSub`'s `onTrouble`. */
export type PubSubTrouble = "notify_failed" | "notify_timeout" | "queue_full" | "deaf" | "relisten_failed" | "resumed";

/** Postgres rejects NOTIFY payloads of 8000 bytes or more. */
export const MAX_NOTIFY_BYTES = 7900;

export class PayloadTooLargeError extends Error {
  constructor(bytes: number) {
    super(`pub/sub payload is ${bytes} bytes; the limit is ${MAX_NOTIFY_BYTES}. Publish ids, not documents.`);
    this.name = "PayloadTooLargeError";
  }
}

const PG_CHANNEL = "agenteschat_events";
/** A replica's own heartbeat, heard back on its LISTEN. Never delivered to subscribers. */
const HEARTBEAT_TOPIC = "pubsub.heartbeat";
/** Some events never went out (a NOTIFY failed or timed out): every replica that hears it tells its subscribers. */
const MISSED_TOPIC = "pubsub.missed";

/**
 * A payload's topic, read without parsing it: `publish` writes `{"t":"<topic>","e":…}`, the topic first. Null for
 * anything else, or a topic JSON had to escape, which the caller parses whole.
 */
export function topicOf(payload: string): string | null {
  if (!payload.startsWith('{"t":"')) return null;
  const end = payload.indexOf('"', 6);
  if (end < 0) return null;
  const topic = payload.slice(6, end);
  return topic.includes("\\") ? null : topic;
}

class TimedOut extends Error {
  constructor(what: string, ms: number) {
    super(`${what} took longer than ${ms} ms`);
    this.name = "TimedOut";
  }
}

/** `work`, or a rejection once `ms` pass: a statement on a connection that died without closing never settles. */
function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimedOut(what, ms)), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Pub/sub over Postgres LISTEN/NOTIFY: one NOTIFY channel, topic inside the
 * payload. Works across replicas with no extra infrastructure. Payloads must
 * stay small (ids and short deltas), see `MAX_NOTIFY_BYTES`.
 *
 * Delivery never stops in silence (ADR 0010, amended 2026-11-16). One NOTIFY that is slow or hangs (a connection that
 * died without closing) gets `notifyTimeoutMs` and holds nothing behind it. Its events count as missed only once it
 * fails or stays unanswered for `notifyLostMs`; then, once NOTIFY works again, a mark tells every replica, whose
 * subscribers learn events were missed (`listenResumedTopic`). The replica's heartbeat goes through the
 * same queue, NOTIFY and LISTEN as every event: one that went out and isn't heard back within an interval means a deaf
 * LISTEN, made again on a new connection (`PgNotifier.restart`) without ever waiting on the old one. `onTrouble` says
 * when delivery breaks and when it is back, for the logs.
 */
export async function createPostgresPubSub(
  notifier: PgNotifier,
  {
    heartbeatMs = LISTEN_HEARTBEAT_MS,
    notifyTimeoutMs = NOTIFY_TIMEOUT_MS,
    notifyLostMs = NOTIFY_LOST_MS,
    listenTimeoutMs = LISTEN_TIMEOUT_MS,
    fullResyncMs = FULL_RESYNC_MS,
    onTrouble,
  }: {
    heartbeatMs?: number;
    notifyTimeoutMs?: number;
    notifyLostMs?: number;
    listenTimeoutMs?: number;
    fullResyncMs?: number;
    onTrouble?: (kind: PubSubTrouble, detail: Record<string, unknown>) => void;
  } = {},
): Promise<PubSub> {
  const registry = new Registry();
  /** This process, in its heartbeats: another replica's heartbeat proves nothing about this one's queue or LISTEN. */
  const replica = crypto.randomUUID();
  let started = false;
  /** This replica's LISTEN missed events: the next payload heard proves it back, and the subscribers hear so then. */
  let gap = false;
  /** Since when delivery is broken (null: it works); what failed meanwhile, said once it is back. */
  let brokenSince: number | null = null;
  let failedStatements = 0;
  let failedRelistens = 0;
  let lastFullResync = Number.NEGATIVE_INFINITY;
  const report = (kind: PubSubTrouble, detail: Record<string, unknown> = {}) => {
    try {
      onTrouble?.(kind, detail);
    } catch {
      // A logger that throws must not stop delivery.
    }
  };
  /** The first sign of a break is reported; the rest are counted until it ends. */
  const broke = (kind: PubSubTrouble, detail: Record<string, unknown> = {}) => {
    if (brokenSince !== null) return;
    brokenSince = Date.now();
    report(kind, detail);
  };
  const resumed = () => {
    gap = false;
    if (brokenSince !== null) {
      report("resumed", { brokenMs: Date.now() - brokenSince, failedStatements, failedRelistens });
    }
    brokenSince = null;
    failedStatements = 0;
    failedRelistens = 0;
    const full = Date.now() - lastFullResync >= fullResyncMs;
    if (full) lastFullResync = Date.now();
    deliver(registry.topics.get(listenResumedTopic), { type: "pubsub.resumed", full });
  };
  // The heartbeat's numbers: the last one queued, the last one that went out (and when), the last one heard back.
  let beatSeq = 0;
  let pendingBeat: number | null = null;
  let beatOut = 0;
  let beatOutAt = 0;
  let beatHeard = 0;
  // Only the newest LISTEN made here delivers: postgres.js makes an older one again with its connection, and two
  // would deliver every event twice.
  let generation = 0;
  const listen = () => {
    const mine = ++generation;
    return notifier.listen(
      PG_CHANNEL,
      (payload) => {
        if (mine !== generation) return;
        // Every replica hears every event: one whose topic nobody here listens to isn't parsed at all.
        const peeked = topicOf(payload);
        if (peeked !== null && !registry.topics.has(peeked) && peeked !== HEARTBEAT_TOPIC && peeked !== MISSED_TOPIC) {
          if (gap) resumed();
          return;
        }
        let topic = "";
        try {
          const { t, e } = JSON.parse(payload) as { t: string; e: RealtimeEvent };
          topic = t;
          if (t === HEARTBEAT_TOPIC) {
            if (e.replica === replica && typeof e.n === "number") beatHeard = Math.max(beatHeard, e.n);
          } else if (t !== MISSED_TOPIC) deliver(registry.topics.get(t), e);
        } catch {
          // Ignore malformed payloads from other software on the same channel.
        }
        if (gap || topic === MISSED_TOPIC) resumed();
      },
      () => {
        // postgres.js listening again once its connection came back: whatever was said meanwhile never came.
        if (!started || mine !== generation) return;
        gap = true;
        broke("deaf", { reason: "listen_reconnected" });
      },
    );
  };
  let unlisten = await listen();
  started = true;

  // Publishing doesn't wait for the database: events queue in order and go out together in one statement per tick (a
  // remote database costs one round trip per batch, not per event), one statement at a time, each within
  // `notifyTimeoutMs`. Delivery stays best effort, but a break is never silent.
  const queue: string[] = [];
  let scheduled = false;
  let pumping: Promise<void> | null = null;
  /** Events that never went out: the next statement carries the mark that has every replica's subscribers read again. */
  let missed = false;
  const missedMark = JSON.stringify({ t: MISSED_TOPIC, e: { type: "missed", replica } });
  const statement = async (batch: string[]) => {
    if (notifier.notifyMany && batch.length > 1) await notifier.notifyMany(PG_CHANNEL, batch);
    else for (const payload of batch) await notifier.notify(PG_CHANNEL, payload);
  };
  /** Its events are lost to every replica: the mark goes with the next statement that works. */
  const lost = (events: number, error: unknown) => {
    missed = true;
    failedStatements++;
    broke(error instanceof TimedOut ? "notify_timeout" : "notify_failed", { events, error: String(error) });
  };
  const pump = async () => {
    while (queue.length > 0 || pendingBeat !== null) {
      const batch = queue.splice(0, MAX_BATCH);
      const beat = pendingBeat;
      pendingBeat = null;
      if (beat !== null) batch.push(JSON.stringify({ t: HEARTBEAT_TOPIC, e: { type: "heartbeat", replica, n: beat } }));
      const marked = missed;
      if (marked) batch.push(missedMark);
      const answered = within(statement(batch), notifyLostMs, "NOTIFY");
      try {
        await within(answered, notifyTimeoutMs, "NOTIFY");
        if (marked) missed = false;
        if (beat !== null) {
          beatOut = beat;
          beatOutAt = Date.now();
        }
      } catch (error) {
        // Slow: the queue goes on, and its events are missed only if it fails or never answers.
        if (error instanceof TimedOut) answered.catch((late: unknown) => lost(batch.length, late));
        else lost(batch.length, error);
      }
    }
  };
  const flush = () => {
    scheduled = false;
    if (pumping) return; // the statement on its way takes what was queued meanwhile next
    pumping = pump().finally(() => {
      pumping = null;
      if (queue.length > 0 || pendingBeat !== null) flush();
    });
  };
  const kick = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(flush, 0); // after awaited publishes of this tick have queued too
  };

  // The heartbeat: it must come back through the queue, NOTIFY and LISTEN like any event. postgres.js listens again
  // by itself when its connection closes, but not when the connection died without closing (a dropped network path),
  // and then every LISTEN or UNLISTEN sent on it hangs until the OS gives up, minutes later: the replica would hear
  // nothing, its sockets open and silent. A heartbeat that went out (NOTIFY works) and isn't heard back means a deaf
  // LISTEN: it is made again on a new connection, never waiting on the old one. One that couldn't go out says
  // nothing about the LISTEN: NOTIFY's own failures are counted above.
  let relistening: Promise<void> | null = null;
  let closed = false;
  const beat = () => {
    if (closed) return;
    pendingBeat = ++beatSeq;
    kick();
  };
  const relisten = () => {
    relistening = (async () => {
      const old = unlisten;
      if (notifier.restart) await within(notifier.restart(), listenTimeoutMs, "dropping the LISTEN").catch(() => {});
      else void within(old(), listenTimeoutMs, "UNLISTEN").catch(() => {});
      unlisten = await within(listen(), listenTimeoutMs, "LISTEN");
      // Heard at once when it works: the subscribers read again now, not an interval later.
      beat();
    })()
      .catch((error: unknown) => {
        failedRelistens++;
        if (failedRelistens === 1) report("relisten_failed", { error: String(error) });
      })
      .finally(() => {
        relistening = null;
      });
  };
  const ticker = setInterval(() => {
    if (closed || relistening) return;
    // Out long enough to have come back (half an interval: the statement may have waited in the queue).
    if (beatOut > beatHeard && Date.now() - beatOutAt >= heartbeatMs / 2) {
      gap = true;
      broke("deaf", { reason: "heartbeat_not_heard" });
      relisten();
      return;
    }
    beat();
  }, heartbeatMs);
  (ticker as { unref?: () => void }).unref?.();

  return {
    async publish(topic, event) {
      const payload = JSON.stringify({ t: topic, e: event });
      const bytes = Buffer.byteLength(payload);
      if (bytes > MAX_NOTIFY_BYTES) throw new PayloadTooLargeError(bytes);
      queue.push(payload);
      if (queue.length > MAX_QUEUED) {
        const dropped = queue.splice(0, queue.length - MAX_QUEUED).length;
        missed = true;
        broke("queue_full", { dropped });
      }
      kick();
    },
    subscribe: (topic, handler) => registry.add(topic, handler),
    close: async () => {
      closed = true;
      clearInterval(ticker);
      pendingBeat = null;
      // What was queued still goes out (each statement within its time).
      flush();
      await pumping;
      // A LISTEN being made again may finish after close starts: that one is removed too.
      await relistening;
      await within(unlisten(), listenTimeoutMs, "UNLISTEN").catch(() => {});
      await notifier.close?.().catch(() => {});
    },
  };
}

type PostgresJsClient = {
  listen(channel: string, fn: (payload: string) => void, onlisten?: () => void): Promise<{ unlisten(): Promise<void> }>;
  notify(channel: string, payload: string): Promise<unknown>;
  unsafe?(query: string, params: string[]): Promise<unknown>;
};

/**
 * Adapts a postgres.js client (`createDatabase().client`). With `listenClient` (`createDatabase().listenClient`) the
 * LISTEN runs on a client of its own, which `restart` ends at once, without waiting for an UNLISTEN a dead connection
 * would never answer, so the next LISTEN opens a new connection.
 */
export function postgresJsNotifier(
  client: PostgresJsClient,
  listenClient?: (() => PostgresJsClient & { end(options?: { timeout?: number }): Promise<void> }) | null,
): PgNotifier {
  let own: ReturnType<NonNullable<typeof listenClient>> | null = null;
  const drop = async () => {
    const old = own;
    own = null;
    await old?.end({ timeout: 0 });
  };
  return {
    async listen(channel, onPayload, onListen) {
      if (listenClient && !own) own = listenClient();
      const sub = await (own ?? client).listen(channel, onPayload, onListen);
      return () => sub.unlisten();
    },
    ...(listenClient ? { restart: drop, close: drop } : {}),
    async notify(channel, payload) {
      await client.notify(channel, payload);
    },
    async notifyMany(channel, payloads) {
      if (!client.unsafe) {
        for (const p of payloads) await client.notify(channel, p);
        return;
      }
      const calls = payloads.map((_, i) => `pg_notify($1, $${i + 2})`).join(", ");
      await client.unsafe(`select ${calls}`, [channel, ...payloads]);
    },
  };
}
