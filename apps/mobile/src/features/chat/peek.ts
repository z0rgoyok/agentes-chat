/**
 * The agent peeking from under the conversation's end (`ChatPeek`): how far the list is pulled past its last message,
 * what the face does with it and when the phone taps. Pure, so it runs on the UI thread (each number function is a
 * worklet) and in tests.
 */

/** The face's box in points: a little bigger than a message's face, small enough to stay a peek. */
export const PEEK_SIZE = 44;
/** Pulled this far past the end (points), the face is all the way up and the phone taps once. */
export const PEEK_AT = 56;
/** Back under this, the tap is ready for the same pull again: a wobble at the line never taps twice. */
export const PEEK_REARM = 40;
/** How much of the face's box shows over the dock's edge all the way up: its head and eyes, never the whole body. */
export const PEEK_RISE = 32;

/**
 * How far a scroll view is pulled past its end, in points, from one scroll event's own numbers: its offset, the
 * content's height, its own height and its insets (the keyboard and the dock's room are the bottom inset). The end is
 * where the last row rests over the bottom inset; a conversation shorter than the screen ends at its top. Never
 * negative: above the end it is 0.
 */
export function pastEnd(
  offsetY: number,
  contentHeight: number,
  viewportHeight: number,
  insetTop: number,
  insetBottom: number,
): number {
  "worklet";
  const end = Math.max(-insetTop, contentHeight + insetBottom - viewportHeight);
  return Math.max(0, offsetY - end);
}

/**
 * The keyboard isn't moving under the finger: shut or all the way open. Dragged down with the conversation (closing as
 * the finger goes), it is in between, and the list's end moves with it: no peek then.
 */
export function keyboardAtRest(progress: number): boolean {
  "worklet";
  return progress <= 0.01 || progress >= 0.99;
}

/**
 * What the face follows: the pull past the end while the finger is on the list; once it lets go, only less of it (the
 * list bouncing back takes the face down with it), so a fling that bounces at the end never raises it. Nothing while
 * the keyboard moves.
 */
export function nextPull(shown: number, past: number, dragging: boolean, keyboardStill: boolean): number {
  "worklet";
  if (!keyboardStill) return 0;
  return dragging ? past : Math.min(shown, past);
}

/** Armed once the pull reaches `PEEK_AT`; disarmed back under `PEEK_REARM`. The tap is the step from off to on. */
export function armedAfter(armed: boolean, pull: number): boolean {
  "worklet";
  return armed ? pull >= PEEK_REARM : pull >= PEEK_AT;
}

/**
 * Where the face stands in its box for a pull: `y` is how far down it is (`PEEK_SIZE`: under the dock's edge, out of
 * sight; `PEEK_SIZE - PEEK_RISE`: all the way up) and its opacity. It rises with the pull, straight from it (no spring,
 * so it moves with the finger), and arrives as the pull reaches `PEEK_AT`, the moment the phone taps; past it, it stays.
 * Reduced motion: it never moves, it only fades in where it would arrive.
 */
export function peekPose(pull: number, reduced: boolean): { y: number; opacity: number } {
  "worklet";
  const t = Math.min(1, Math.max(0, pull / PEEK_AT));
  if (reduced) return { y: PEEK_SIZE - PEEK_RISE, opacity: t };
  return { y: PEEK_SIZE - PEEK_RISE * t, opacity: Math.min(1, t * 2) };
}

interface Authored {
  author: { type: string; id: string | null };
}

/**
 * Who peeks: a DM's agent; elsewhere the agent who spoke last in what is loaded here; nobody where only people talk.
 */
export function peekAgentOf(dmAgentId: string | null, messages: readonly Authored[]): string | null {
  if (dmAgentId) return dmAgentId;
  for (let i = messages.length - 1; i >= 0; i--) {
    const author = messages[i]?.author;
    if (author?.type === "agent" && author.id) return author.id;
  }
  return null;
}
