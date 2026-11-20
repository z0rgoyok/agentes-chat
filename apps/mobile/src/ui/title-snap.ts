/**
 * A large title that scrolls away (`LargeTitleScreen`, `PushedLargeTitle`): it fades out over the first `TITLE_GONE`
 * points of scroll while the bar's own title fades in, and it never rests half faded, as the system's large titles
 * don't. Pure, so the tests read the rule.
 */

/** Scroll (from rest) by which the large title has faded out under the bar. */
export const TITLE_GONE = 40;
/** The bar's title fades in over this stretch, as the large title leaves. */
export const BAR_TITLE_FROM = 28;
export const BAR_TITLE_TO = 48;

/**
 * Where a scroll that came to rest at `at` (points from rest, as `useCoverScroll`'s `y`) goes on: the nearer of the
 * title whole (0) and the title gone (`TITLE_GONE`) when it stopped with the title half faded, else null (it stays).
 * `end` is how far from rest the list can scroll at all: one too short to fold the title away stays where it ends.
 */
export function titleSnap(at: number, end: number): number | null {
  if (!(at > 0.5 && at < TITLE_GONE - 0.5)) return null;
  if (!(end >= TITLE_GONE)) return null;
  return at < TITLE_GONE / 2 ? 0 : TITLE_GONE;
}
