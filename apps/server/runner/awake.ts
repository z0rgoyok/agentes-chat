/** How often `AwakeClock` looks at the time. */
export const AWAKE_TICK_MS = 10_000;
/** A gap this much longer than a tick between two looks is a sleep, not time the computer spent awake. */
const SLEPT_AFTER_TICKS = 6;

/**
 * Time the computer spent awake, for "idle for N minutes": a computer whose whole VM was saved to disk and restored
 * (snapshot sleep), or a laptop that slept, wakes to a clock that jumped over the pause (wall time, and monotonic time
 * where the clock source counts it), so every idle timer would fire at once. A gap between two looks of more than
 * `SLEPT_AFTER_TICKS` ticks counts as one tick. A timer that fires counts as a look.
 */
export class AwakeClock {
  private awake = 0;
  private last: number;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly tickMs = AWAKE_TICK_MS,
  ) {
    this.last = now();
    this.timer = setInterval(() => this.read(), tickMs);
    this.timer.unref?.();
  }

  /** Milliseconds awake since the clock started. */
  read(): number {
    const t = this.now();
    const gap = t - this.last;
    this.last = t;
    if (gap > 0) this.awake += gap > SLEPT_AFTER_TICKS * this.tickMs ? this.tickMs : gap;
    return this.awake;
  }

  stop() {
    clearInterval(this.timer);
  }
}

/** One per process: every idle timer of the runner reads the same awake time. */
export const awakeClock = new AwakeClock();
