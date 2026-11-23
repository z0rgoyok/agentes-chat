import type { Timers } from "../realtime/connection";

/** Something that changes: listen, get the undo. */
export type Signal = (listener: () => void) => () => void;

/** Runs `run` later (the next animation frame, say); returns the cancel. */
export type LiveSchedule = (run: () => void) => () => void;

const realTimers: Pick<Timers, "setTimeout" | "clearTimeout"> = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** What the browser and React Native both have (this package has no DOM types). */
type FrameGlobals = {
  requestAnimationFrame?: (run: () => void) => number;
  cancelAnimationFrame?: (id: number) => void;
};

/**
 * Runs on the next animation frame (the browser's and React Native's both have one), or after 16 ms where there is
 * none: the `schedule` to give `useLiveDocVersion` and `useLiveSelector` so a burst of changes redraws once a frame.
 */
export const nextFrame: LiveSchedule = (run) => {
  const frames = globalThis as FrameGlobals;
  if (frames.requestAnimationFrame && frames.cancelAnimationFrame) {
    // Called on the global itself: a browser refuses its own functions called on anything else.
    const id = frames.requestAnimationFrame(() => run());
    return () => frames.cancelAnimationFrame?.(id);
  }
  const id = setTimeout(run, 16);
  return () => clearTimeout(id);
};

/**
 * `signal`, at most once every `ms`: the first change at once, the changes after it in one call when the window ends
 * (so the last state is always heard). A screen redrawing who is in a file needs no more than that while people move
 * their pointers many times a second.
 */
export function throttleSignal(
  signal: Signal,
  ms: number,
  timers: Pick<Timers, "setTimeout" | "clearTimeout"> = realTimers,
  now: () => number = () => Date.now(),
): Signal {
  return (listener) => {
    let last = Number.NEGATIVE_INFINITY;
    let timer: unknown = null;
    let done = false;
    const fire = () => {
      last = now();
      listener();
    };
    const off = signal(() => {
      if (done || timer !== null) return;
      const wait = last + ms - now();
      if (wait <= 0) return fire();
      timer = timers.setTimeout(() => {
        timer = null;
        if (!done) fire();
      }, wait);
    });
    return () => {
      done = true;
      off();
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    };
  };
}

/**
 * `signal` through `schedule`: changes until the scheduled run are heard once (one redraw per animation frame, when the
 * caller schedules on frames). Without `schedule`, every change is heard at once.
 */
export function scheduleSignal(signal: Signal, schedule?: LiveSchedule): Signal {
  if (!schedule) return signal;
  return (listener) => {
    let cancel: (() => void) | null = null;
    let done = false;
    const off = signal(() => {
      if (done || cancel) return;
      cancel = schedule(() => {
        cancel = null;
        if (!done) listener();
      });
    });
    return () => {
      done = true;
      off();
      cancel?.();
      cancel = null;
    };
  };
}
