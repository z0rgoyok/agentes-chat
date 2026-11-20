/**
 * How far past what shows the list draws rows while it opens (pt): the rows it draws first are the ones the person
 * sees. Once placed and once the push has ended it grows to a screen's height, a step at a time (`reachOf`).
 */
export const OPEN_DRAW_DISTANCE = 250;
/** The list's last reach step (`reachOf`): a screen's height. */
export const REACH_LAST = 2;
/** A step started from `whenIdle` waits at least this long (a few frames), then for an idle moment (ms). */
const IDLE_GAP_MS = 50;
/** How long that idle moment is waited for before the step runs anyway (ms). */
const IDLE_MAX_MS = 500;

/** The list's reach at a step: `OPEN_DRAW_DISTANCE`, then half a screen's height, then a screen's height. */
export const reachOf = (step: number, windowHeight: number) =>
  step <= 0
    ? OPEN_DRAW_DISTANCE
    : step < REACH_LAST
      ? Math.max(OPEN_DRAW_DISTANCE, Math.round(windowHeight / 2))
      : Math.round(windowHeight);

/**
 * `run` at an idle moment, at least `IDLE_GAP_MS` from now (`requestIdleCallback` where the platform has one, else
 * right after the gap). Returns what cancels it.
 */
export function whenIdle(run: () => void): () => void {
  const idle = globalThis as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  let handle: number | undefined;
  const timer = setTimeout(() => {
    if (idle.requestIdleCallback) handle = idle.requestIdleCallback(run, { timeout: IDLE_MAX_MS });
    else run();
  }, IDLE_GAP_MS);
  return () => {
    clearTimeout(timer);
    if (handle !== undefined) idle.cancelIdleCallback?.(handle);
  };
}
