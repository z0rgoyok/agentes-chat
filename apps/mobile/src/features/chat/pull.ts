/**
 * The math of the conversation's sideways pulls, run on the UI thread (worklets) and testable without a phone: the
 * rubber band past an edge, and the pull to the left that shows the times (`swipe-time.tsx`).
 */

/** How far the conversation follows a pull to the left freely: the times' column; past it the pull resists. */
export const TIME_REVEAL = 64;

/** The further past the edge, the less the row follows (Apple's rubber band). */
export function rubberband(over: number, dimension: number, constant = 0.55) {
  "worklet";
  return (over * dimension * constant) / (dimension + constant * Math.abs(over));
}

/** The pull for a finger `tx` points to the left: one to one up to `TIME_REVEAL`, resisting past it. */
export function pullOf(tx: number) {
  "worklet";
  const x = Math.max(0, tx);
  return x <= TIME_REVEAL ? x : TIME_REVEAL + rubberband(x - TIME_REVEAL, TIME_REVEAL);
}

/** A time at a pull: out of sight at rest, coming in from the screen's edge, fully there at `TIME_REVEAL`. */
export function timeShown(pull: number) {
  "worklet";
  const at = Math.min(Math.max(0, pull), TIME_REVEAL);
  return { opacity: at / TIME_REVEAL, shift: TIME_REVEAL - at };
}

/**
 * How far someone else's row gives way at a pull: not at all while the room at its bubble's right holds the pull;
 * past that, point for point. The room is the width the bubble may take (`area`) less its own, plus `spare`: how much
 * sooner than mine its bubbles end at the screen's edge, so at the full pull it stands where mine do.
 */
export function giveWay(pull: number, area: number, bubble: number, spare = 0) {
  "worklet";
  return Math.max(0, pull - Math.max(0, area - bubble) - spare);
}
