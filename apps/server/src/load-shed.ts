import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Logger } from "./logger";

/** How long each reading of the load covers. */
export const LOAD_SAMPLE_MS = 5_000;
/** Open sockets of one person (all their tabs and workspaces) in one process; past it a new one is refused. */
export const MAX_SOCKETS_PER_PERSON = 50;

/** Past any of these the process is overloaded; 0 turns that one off. */
export interface LoadLimits {
  /** The event loop's p99 delay over the last reading. */
  eventLoopMs: number;
  /** A `select 1`, waiting for a pool connection included. */
  dbWaitMs: number;
  /** The app's open sockets in this process. */
  sockets: number;
}

export type Overload = "event_loop" | "database" | "sockets";

/**
 * Whether this process is overloaded now, so it turns new work away (`busyResponse`) instead of queueing everyone
 * behind it. The event loop and the database are read every `sampleMs`, the sockets at each call. A `select 1`
 * still unanswered counts for as long as it has waited.
 */
export function watchLoad(
  deps: { ping: () => Promise<unknown>; sockets: () => number; limits: LoadLimits; log: Pick<Logger, "warn"> },
  sampleMs = LOAD_SAMPLE_MS,
) {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let lagMs = 0;
  let dbMs = 0;
  let pingSince: number | null = null;
  let was: Overload | null = null;
  const dbWait = () => Math.max(dbMs, pingSince === null ? 0 : performance.now() - pingSince);
  const overloaded = (): Overload | null => {
    const { eventLoopMs, dbWaitMs, sockets } = deps.limits;
    if (eventLoopMs > 0 && lagMs > eventLoopMs) return "event_loop";
    if (dbWaitMs > 0 && dbWait() > dbWaitMs) return "database";
    if (sockets > 0 && deps.sockets() >= sockets) return "sockets";
    return null;
  };
  const timer = setInterval(() => {
    lagMs = histogram.count > 0 ? histogram.percentile(99) / 1e6 : 0;
    histogram.reset();
    if (pingSince === null) {
      const since = performance.now();
      pingSince = since;
      void deps
        .ping()
        .catch(() => {})
        .finally(() => {
          dbMs = performance.now() - since;
          pingSince = null;
        });
    }
    const now = overloaded();
    if (now !== was) {
      deps.log.warn(now ? "overloaded: turning new sockets and reads away" : "no longer overloaded", {
        because: now ?? was,
        eventLoopP99Ms: Math.round(lagMs),
        dbWaitMs: Math.round(dbWait()),
        sockets: deps.sockets(),
      });
      was = now;
    }
  }, sampleMs);
  timer.unref();
  return {
    overloaded,
    stop() {
      clearInterval(timer);
      histogram.disable();
    },
  };
}

/** 5 to 15 seconds: clients turned away together don't all come back in the same second. */
export const retryAfterSeconds = (random = Math.random) => 5 + Math.floor(random() * 11);

/** The answer of an overloaded process: try again later, here or (behind a proxy) at another process. */
export const busyResponse = () =>
  Response.json(
    { error: { code: "server_busy", message: "The server is busy. Trying again in a few seconds." } },
    { status: 503, headers: { "retry-after": String(retryAfterSeconds()), "cache-control": "no-store" } },
  );
