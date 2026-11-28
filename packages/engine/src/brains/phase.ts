import type { BrainIO, BrainPhase } from "./types";

/** A step quicker than this says nothing: the bar keeps "Pensando…" rather than flashing a line. */
export const PHASE_AFTER_MS = 2_000;
/** A line that showed stays at least this long, so it reads as a step and not a flicker. */
export const PHASE_MIN_MS = 1_000;

/** `work` as `phase` of the turn (`BrainIO.phase`): told when it starts, and its end when it settles. */
export async function inPhase<T>(io: Pick<BrainIO, "phase">, phase: BrainPhase, work: Promise<T>): Promise<T> {
  io.phase?.(phase);
  try {
    return await work;
  } finally {
    io.phase?.(null);
  }
}

/**
 * What `BrainIO.phase` does for a run: a phase still on after `PHASE_AFTER_MS` goes out (`publish`), and its end
 * goes out only if it did, held until it showed `PHASE_MIN_MS`.
 */
export function phaseTeller(
  publish: (phase: BrainPhase | null) => void,
  { afterMs = PHASE_AFTER_MS, minMs = PHASE_MIN_MS } = {},
): (phase: BrainPhase | null) => void {
  let pending: ReturnType<typeof setTimeout> | null = null;
  let shown: { phase: BrainPhase; at: number } | null = null;
  return (phase) => {
    if (pending) clearTimeout(pending);
    pending = null;
    if (phase === null) {
      if (!shown) return;
      const wait = shown.at + minMs - Date.now();
      const over = () => {
        pending = null;
        shown = null;
        publish(null);
      };
      if (wait <= 0) over();
      else pending = setTimeout(over, wait);
      return;
    }
    // Still on screen (its end was being held): it stays, and the next end is held again.
    if (shown?.phase === phase) return;
    pending = setTimeout(() => {
      pending = null;
      shown = { phase, at: Date.now() };
      publish(phase);
    }, afterMs);
  };
}
