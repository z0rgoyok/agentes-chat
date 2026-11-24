/**
 * The bar a pane draws for the screen in it (ADR 0212), in numbers: pure, so the pane (`pane.tsx`), the
 * conversation's pill (`panePillRoom`) and the tests share them.
 */

/** The bar's height under the pane's top inset: the conversation's 44-point pill with 4 points over and under it. */
export const PANE_BAR_HEIGHT = 52;
/** From the pane's edges to what stands at the bar's ends. */
export const PANE_BAR_SIDE = 16;
/** Between the title and what stands beside it. */
export const PANE_BAR_GAP = 8;
/** A button in the bar's capsule (`IconButton`'s 40 points). */
export const PANE_BUTTON = 40;
/** The capsule's padding around its buttons: 44 points tall, as the system's bar buttons are. */
export const PANE_CAPSULE_PAD = 2;

/** The capsule holding `buttons` icon buttons after `lead` points of the screen's own views; 0 when it holds nothing. */
export function paneCapsuleWidth(buttons: number, lead: number): number {
  if (buttons <= 0 && lead <= 0) return 0;
  return 2 * PANE_CAPSULE_PAD + Math.max(0, buttons) * PANE_BUTTON + Math.max(0, lead);
}

/**
 * The title's room in a pane's bar, centred on the pane as the conversation's pill is: what is left once the wider
 * side (`side`, what stands at that end) is kept clear of on both sides. Never below zero.
 */
export function paneTitleRoom(width: number, side: number): number {
  return Math.max(0, width - 2 * (PANE_BAR_SIDE + Math.max(0, side) + PANE_BAR_GAP));
}
