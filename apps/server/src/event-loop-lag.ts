import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Logger } from "./logger";

/** How long each reading of the event loop's delay covers. */
export const EVENT_LOOP_LAG_WINDOW_MS = 60_000;

export interface EventLoopLag {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  /** When the window ended. */
  at: string;
}

/**
 * How late this thread's event loop runs what is due, a window at a time: logged at `info` and kept for the operator's
 * `/health`. Sampled by the runtime's own histogram, so watching costs no work on this thread between readings.
 */
export function watchEventLoopLag(log: Pick<Logger, "info">, windowMs = EVENT_LOOP_LAG_WINDOW_MS) {
  const histogram = monitorEventLoopDelay();
  histogram.enable();
  let last: EventLoopLag | null = null;
  const ms = (ns: number) => Math.round(ns / 100_000) / 10;
  const timer = setInterval(() => {
    if (histogram.count === 0) return;
    last = {
      p50Ms: ms(histogram.percentile(50)),
      p99Ms: ms(histogram.percentile(99)),
      maxMs: ms(histogram.max),
      at: new Date().toISOString(),
    };
    histogram.reset();
    log.info("event loop lag", { ...last, windowMs });
  }, windowMs);
  timer.unref();
  /** The last window's reading; null before the first one ends. */
  return () => last;
}
