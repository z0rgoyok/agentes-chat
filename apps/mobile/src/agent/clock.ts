/**
 * One shared frame clock for every living agent and pixel orbit (~25 fps). It runs only while someone
 * listens and the app is in the foreground; listeners get the time in seconds. Pure: timers come in, so
 * tests drive it by hand.
 */
export interface ClockTimers {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

export type FrameListener = (t: number) => void;

export interface FrameClock {
  subscribe(listener: FrameListener): () => void;
  setPaused(paused: boolean): void;
  /**
   * Holds every living thing still while something more important moves (a list being scrolled, a screen sliding in):
   * the clock stops until each hold is released. Returns the release (calling it twice releases once).
   */
  hold(): () => void;
  /** Seconds since the clock was made. */
  time(): number;
  readonly running: boolean;
}

const defaultTimers: ClockTimers = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};

export function createFrameClock(fps = 25, timers: ClockTimers = defaultTimers): FrameClock {
  const listeners = new Set<FrameListener>();
  const t0 = timers.now();
  let paused = false;
  let holds = 0;
  let id: unknown = null;
  const time = () => (timers.now() - t0) / 1000;
  const tick = () => {
    const t = time();
    for (const l of [...listeners]) l(t);
  };
  const sync = () => {
    const want = listeners.size > 0 && !paused && holds === 0;
    if (want && id === null) id = timers.setInterval(tick, Math.round(1000 / fps));
    else if (!want && id !== null) {
      timers.clearInterval(id);
      id = null;
    }
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      sync();
      return () => {
        listeners.delete(listener);
        sync();
      };
    },
    setPaused(next) {
      paused = next;
      sync();
    },
    hold() {
      holds += 1;
      sync();
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        holds -= 1;
        sync();
      };
    },
    time,
    get running() {
      return id !== null;
    },
  };
}

/** The app's clock (AppProviders pauses it in the background). */
export const frameClock = createFrameClock(25);
