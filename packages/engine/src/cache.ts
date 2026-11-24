import { fullResync, listenResumedTopic, type PubSub } from "@agenteschat/adapters";
import { inTransaction } from "@agenteschat/db";

/**
 * Per-process caches for data read on every run but rarely changed (agent
 * config, org settings, channel rows and members, scopes, connections,
 * credential rows). A write invalidates at once in this process and, through
 * `shareCacheInvalidations`, in every other one on the database (the app and
 * its workers); the short TTL covers an invalidation lost on the way.
 * Decrypted secrets are never cached, only database rows.
 */
let enabled = false;

/**
 * Caching is off unless the server turns it on (`enableCaches()`): tests write
 * the database directly and expect every read to see it.
 */
export function enableCaches(on = true) {
  enabled = on;
  if (!on) clearCaches();
}

export const cachesEnabled = () => enabled;

export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();
  /** Loads under way by key: a miss while one runs waits for it instead of reading the database again. */
  private readonly loading = new Map<string, { generation: number; value: Promise<V> }>();
  /** Bumped by every invalidation, so a load that began before one never stores what it read. */
  private generation = 0;
  constructor(
    private readonly ttlMs: number,
    private readonly max = 5000,
  ) {}

  get(key: string): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expires < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V) {
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  /** Told of each invalidation made in this process (`shareCacheInvalidations`). */
  onInvalidate?: (op: CacheOp, key: string) => void;

  delete(key: string) {
    this.apply("delete", key);
    this.onInvalidate?.("delete", key);
  }

  /** Drops every key starting with `prefix` (e.g. everything of one org). */
  deletePrefix(prefix: string) {
    this.apply("deletePrefix", prefix);
    this.onInvalidate?.("deletePrefix", prefix);
  }

  clear() {
    this.apply("clear", "");
    this.onInvalidate?.("clear", "");
  }

  /** Run with every invalidation applied here, this process's or another's: caches built from this one's rows forget too. */
  readonly followers: ((op: CacheOp, key: string) => void)[] = [];

  /** An invalidation, here only: another process's, which it already told everyone. */
  apply(op: CacheOp, key: string) {
    this.generation++;
    if (op === "clear") this.entries.clear();
    else if (op === "delete") this.entries.delete(key);
    else for (const k of this.entries.keys()) if (k.startsWith(key)) this.entries.delete(k);
    for (const follow of this.followers) follow(op, key);
  }

  /** Every entry expires within `ms`, each at a random point: their reloads spread out instead of all coming at once. */
  stale(ms: number) {
    const now = Date.now();
    for (const e of this.entries.values()) e.expires = Math.min(e.expires, now + Math.random() * ms);
  }

  /**
   * Returns the cached value or loads, caches and returns it (`undefined`/null results are cached too, unless `keep`
   * refuses them). A load an invalidation overtook (here or from another process) is returned but not kept: its read
   * may predate the write. Misses while a load of the key runs share it, unless an invalidation came after it began;
   * a value `keep` refuses isn't shared either (each of them loads again), as it wouldn't be cached.
   * Inside a transaction a miss loads on its own and shares nothing: the transaction holds a connection (the built-in
   * database's only one) that a load outside it may be waiting for, and what it reads may never commit.
   */
  async getOrLoad(key: string, load: () => Promise<V>, keep?: (value: V) => boolean): Promise<V> {
    if (!enabled) return load();
    const hit = this.entries.get(key);
    if (hit && hit.expires >= Date.now()) return hit.value;
    const shared = !inTransaction();
    const running = shared ? this.loading.get(key) : undefined;
    if (running && running.generation === this.generation) {
      const value = await running.value;
      return (keep?.(value) ?? true) ? value : load();
    }
    const started = this.generation;
    const mine = { generation: started, value: load() };
    if (shared) this.loading.set(key, mine);
    try {
      const value = await mine.value;
      if (this.generation === started && (keep?.(value) ?? true)) this.set(key, value);
      return value;
    } finally {
      if (this.loading.get(key) === mine) this.loading.delete(key);
    }
  }
}

const TTL_MS = 30_000;

/** The engine's caches, keyed `orgId:id`. Invalidated by the functions that write them. */
export const caches = {
  agents: new TtlCache<unknown>(TTL_MS),
  orgs: new TtlCache<unknown>(TTL_MS),
  channels: new TtlCache<unknown>(TTL_MS),
  channelMembers: new TtlCache<unknown>(TTL_MS),
  scopes: new TtlCache<unknown>(TTL_MS),
  connections: new TtlCache<unknown>(TTL_MS),
  credentials: new TtlCache<unknown>(TTL_MS),
  /** Whether an org has any active context item (skips memory retrieval for empty orgs). */
  contextPresence: new TtlCache<unknown>(TTL_MS),
  /** Whether a thread's context range from another channel is still visible to everyone in the thread. */
  rangeVisible: new TtlCache<unknown>(TTL_MS),
  /** A person's time zone in an org, else the org's (`orgId:userId`): the "Now" block of every run. */
  zones: new TtlCache<unknown>(TTL_MS),
  /**
   * A person's membership (`getMembership`, `orgId:userId`), read by nearly every request and socket check. Only a
   * membership is kept, never its absence, so someone who just joined is let in at once.
   */
  membership: new TtlCache<unknown>(5_000),
  /**
   * A signed-in request's session and person, by its signed session cookie (the server's `sessionOf`): a tab's polls
   * and lists read them once every few seconds instead of a session and a user row each. A session that ends or
   * changes is forgotten here and in every process at once: by its token (`${token}.`) from Better Auth's hooks, all
   * of them when the engine ends a person's sessions itself, or a person changes.
   */
  sessions: new TtlCache<unknown>(5_000, 50_000),
  /** An org's standing (`standing.ts`), read before every model and computer call: a hold bites within 5 s everywhere. */
  standing: new TtlCache<unknown>(5_000),
  /** Whether an org spent its platform AI for the month (`limits.ts`), read before every Jev call and route. */
  platformSpend: new TtlCache<unknown>(60_000),
  /**
   * What a message's chain roots in (`messageRoot`). Its links never change, so it is kept a day: a wake after a wait
   * (a follow-up, CI, an approval) walks only its newest links, never the whole chain again (2 queries a link).
   */
  messageRoots: new TtlCache<unknown>(24 * 3600_000, 20_000),
  /** Runs that read outside content (`runReadOutside`): only `true` is kept, since it never turns false. */
  readOutsideRuns: new TtlCache<true>(3600_000, 20_000),
  /** The workspace's devices by name (`deviceRoster`): a run's prompt and its tool lists read it once. */
  deviceRoster: new TtlCache<unknown>(5_000),
  /** A week of usage per routine (`orgId:routineIds`), summed for the routines list. */
  routineWeekUsage: new TtlCache<unknown>(60_000, 1000),
  /** Registered hosts by name (`hostLook`, ADR 0194), read by the origin check of every write. */
  hosts: new TtlCache<unknown>(TTL_MS),
  /** Whether any phone shows a Live Activity (`liveActivitiesInUse`, ADR 0210), read on every run's start and end. */
  liveActivities: new TtlCache<boolean>(TTL_MS),
  /**
   * Jev's answers to a text-only request sent the same way before (`orgId:hash`): a routine whose conversation hasn't
   * moved, or a retry, asks again within minutes. Never an image's: a screen changes under the same words.
   */
  jevAnswers: new TtlCache<unknown>(15 * 60_000, 2000),
  /** The working line's first words for a message and agent (`orgId:messageId:agentId`, `announceIntent`), none too. */
  intents: new TtlCache<unknown>(3600_000, 5000),
  /** Automático's choice for a routine's prompt (`orgId:agentId:routineId:hash`): the same work every firing. */
  routineAutoModel: new TtlCache<unknown>(24 * 3600_000, 5000),
  /**
   * The whole workspace's part of what its members poll (`orgId:what`): its agents' statuses and work, its returns
   * still to come, the task manager's asks and computers. What each person may see of it is read apart, per request
   * (`viewerFacts`). Forgotten when an agent's status is announced (`forgetOrgReads`) and with any change to an agent
   * or a channel.
   */
  orgReads: new TtlCache<unknown>(3_000, 20_000),
};

const followOrgReads = (op: CacheOp, key: string) =>
  caches.orgReads.apply(op === "clear" ? "clear" : "deletePrefix", key.slice(0, key.indexOf(":") + 1));
caches.agents.followers.push(followOrgReads);
caches.channels.followers.push(followOrgReads);

/**
 * Forgets an org's reads (`caches.orgReads`) here at once, and in every process through `pubsub` ahead of what is
 * published after it: an app reading again on the event that follows never gets what was kept before the change. Sent
 * through the caller's pubsub, so a transaction's held events carry it after their commit, not before.
 */
export async function forgetOrgReads(pubsub: Pick<PubSub, "publish"> | undefined, orgId: string) {
  const key = `${orgId}:`;
  caches.orgReads.apply("deletePrefix", key);
  await pubsub
    ?.publish(CACHE_TOPIC, { type: "cache.invalidate", cache: "orgReads", op: "deletePrefix", key })
    .catch(() => {});
}

/** `caches.contextPresence`'s key for whether an agent holds a rule people gave (`rulesForRun`). */
export const rulesPresenceKey = (orgId: string, agentId: string) => `${orgId}:rules:${agentId}`;

/** Forgets everything about an org (used after broad changes and in tests). */
export function invalidateOrg(orgId: string) {
  for (const c of Object.values(caches)) c.deletePrefix(`${orgId}:`);
}

export function clearCaches() {
  for (const c of Object.values(caches)) c.clear();
}

export type CacheOp = "delete" | "deletePrefix" | "clear";

/** Over how long a gentle resync lets every cached entry expire. */
export const STALE_SPREAD_MS = 10_000;

/** Pub/sub topic that carries every process's cache invalidations to the others (Postgres LISTEN/NOTIFY). */
export const CACHE_TOPIC = "system:cache-invalidate";

/**
 * Every process forgets what any process changed (ADR 0163): an invalidation of `caches` made here is published,
 * and one received is applied here without being published again. Without it, a worker would go on reading a revoked
 * scope, a removed member or a changed credential until its entry's TTL ran out. A process whose LISTEN came back after
 * a gap (`listenResumedTopic`) missed the invalidations sent meanwhile: it forgets everything, or, within a minute of
 * that (`fullResync`), lets every entry expire over `STALE_SPREAD_MS`. Returns the way to stop.
 */
export function shareCacheInvalidations(pubsub: Pick<PubSub, "publish" | "subscribe">) {
  const named: Record<string, TtlCache<unknown>> = caches;
  for (const [cache, c] of Object.entries(named))
    c.onInvalidate = (op, key) =>
      void pubsub.publish(CACHE_TOPIC, { type: "cache.invalidate", cache, op, key }).catch(() => {});
  const off = pubsub.subscribe(CACHE_TOPIC, (event) => {
    const target = typeof event.cache === "string" ? named[event.cache] : undefined;
    const op = event.op;
    if (target && typeof event.key === "string" && (op === "delete" || op === "deletePrefix" || op === "clear"))
      target.apply(op, event.key);
  });
  const offResumed = pubsub.subscribe(listenResumedTopic, (event) => {
    const full = fullResync(event);
    for (const c of Object.values(named)) {
      if (full) c.apply("clear", "");
      else c.stale(STALE_SPREAD_MS);
    }
  });
  return () => {
    off();
    offResumed();
    for (const c of Object.values(named)) c.onInvalidate = undefined;
  };
}
