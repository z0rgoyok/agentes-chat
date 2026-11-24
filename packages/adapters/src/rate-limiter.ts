import { isIPv6 } from "node:net";
import { type Database, lt, schema, sql } from "@agenteschat/db";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

/**
 * Throttling for our own endpoints (posting messages, WebSocket frames, password tries). Better Auth keeps its own
 * limiter per IP. A fixed window per key: in memory for one process (`createMemoryRateLimiter`), in Postgres where
 * several processes answer (`createPostgresRateLimiter`).
 */
export interface RateLimiter {
  consume(key: string, rule: { limit: number; windowMs: number }): Promise<RateLimitResult>;
  /** Gives back one take of `key` in its current window, never below none. */
  release(key: string): Promise<void>;
}

/** Seconds until a rate limit's window opens again, at least 1. */
export const retryInSeconds = (resetAt: Date) => Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));

/** Past this many keys, the in-memory limiter sweeps its ended windows, at most every `SWEEP_EVERY_MS`. */
const SWEEP_PAST = 50_000;
const SWEEP_EVERY_MS = 30_000;

export function createMemoryRateLimiter(now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  let sweptAt = Number.NEGATIVE_INFINITY;
  return {
    async consume(key, rule) {
      const t = now();
      let w = windows.get(key);
      if (!w || w.resetAt <= t) {
        w = { count: 0, resetAt: t + rule.windowMs };
        windows.set(key, w);
      }
      w.count++;
      // Not at every take: while that many windows are still open, each sweep would scan them all for nothing.
      if (windows.size > SWEEP_PAST && t - sweptAt >= SWEEP_EVERY_MS) {
        sweptAt = t;
        for (const [k, v] of windows) if (v.resetAt <= t) windows.delete(k);
      }
      return {
        allowed: w.count <= rule.limit,
        remaining: Math.max(0, rule.limit - w.count),
        resetAt: new Date(w.resetAt),
      };
    },
    async release(key) {
      const w = windows.get(key);
      if (w && w.resetAt > now() && w.count > 0) w.count--;
    },
  };
}

/** Keys of one socket's own frames: the socket lives in one process, which counts them alone, in memory. */
const SOCKET_KEY = /^(?:ws|ws-browser|typing):/;
/** How often expired windows are swept from `rate_limits`. */
const RATE_SWEEP_MS = 5 * 60_000;

/**
 * Limits counted in Postgres (`rate_limits`), one window per key across every server process: a limit stays the limit
 * however many processes answer. A socket's own frames (`SOCKET_KEY`) stay in `local`, never a write each. `stop` ends
 * the sweep (shutdown).
 */
export function createPostgresRateLimiter(
  db: Database,
  local: RateLimiter = createMemoryRateLimiter(),
): RateLimiter & { stop(): void } {
  const { rateLimits: rows } = schema;
  const sweep = setInterval(
    () =>
      void db
        .delete(rows)
        .where(lt(rows.resetAt, new Date()))
        .catch(() => {}),
    RATE_SWEEP_MS,
  );
  sweep.unref?.();
  return {
    async consume(key, rule) {
      if (SOCKET_KEY.test(key)) return local.consume(key, rule);
      const fresh = sql`${rows.resetAt} <= now()`;
      const [row] = await db
        .insert(rows)
        .values({ key, count: 1, resetAt: sql`now() + ${rule.windowMs} * interval '1 millisecond'` })
        .onConflictDoUpdate({
          target: rows.key,
          set: {
            count: sql`case when ${fresh} then 1 else ${rows.count} + 1 end`,
            resetAt: sql`case when ${fresh} then excluded.reset_at else ${rows.resetAt} end`,
          },
        })
        .returning({ count: rows.count, resetAt: rows.resetAt });
      const count = row?.count ?? 1;
      const resetAt = row?.resetAt ?? new Date(Date.now() + rule.windowMs);
      return { allowed: count <= rule.limit, remaining: Math.max(0, rule.limit - count), resetAt };
    },
    async release(key) {
      if (SOCKET_KEY.test(key)) return local.release(key);
      await db
        .update(rows)
        .set({ count: sql`${rows.count} - 1` })
        .where(sql`${rows.key} = ${key} and ${rows.resetAt} > now() and ${rows.count} > 0`);
    },
    stop: () => clearInterval(sweep),
  };
}

/**
 * The part of an address a rate limit counts: an IPv4 address whole, an IPv6 one by its /64, which one customer
 * usually holds whole (each of its 2^64 addresses would get a fresh count otherwise), as Better Auth counts its own.
 */
export function limitIp(ip: string): string {
  const address = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  if (!isIPv6(address)) return address;
  const [head = "", tail] = (address.split("%")[0] ?? "").toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  // An IPv4 tail (`64:ff9b::192.0.2.1`) takes two groups' room.
  const room = 8 - left.length - right.reduce((n, group) => n + (group.includes(".") ? 2 : 1), 0);
  const groups = tail === undefined ? left : [...left, ...Array<string>(room).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}
