/**
 * Two panes on a wide window (ADR 0212): a list on the left, its detail on the right, as on the web. Pure (no React
 * Native import), so it is unit-tested; `TwoPane` draws it.
 */

/**
 * The window width, in points, from which two panes show when no size class is known: the shortest side of a large
 * screen (`LARGE_SCREEN` in lib/orientation.ts), so every phone screen, the iPhone Duo's outer one included, stays one.
 */
export const WIDE_MIN = 600;
/** The list's narrowest and widest, in points. */
export const LIST_MIN = 300;
export const LIST_MAX = 380;
/** The list's share of the width between those two. */
export const LIST_SHARE = 0.4;

/** The width between the panes when no fold divides them: the hairline divider. */
const DIVIDER = 1;

/** An active vertical division region (the iPhone Duo folded like a book), in the container's points. */
export interface Fold {
  x: number;
  width: number;
}

/** A pane's place in the container, in points. */
export interface Pane {
  x: number;
  width: number;
}

/**
 * What modules/duo-layout's `DuoRegionsView` reports (`onRegions`): whether the window is regular width, and the first
 * division region taller than wide that crosses the view, in its own points, active or not (null: none).
 */
export interface DuoRegions {
  wide: boolean;
  fold: { x: number; y: number; width: number; height: number; active: boolean } | null;
}

/**
 * The fold the panes make room for: the reported one only while it is active (opened flat, it is inactive and
 * divides nothing).
 */
export function activeFold(fold: DuoRegions["fold"] | undefined): Fold | null {
  return fold?.active ? { x: fold.x, width: fold.width } : null;
}

/** Whether the panes split at this fold: one strictly inside the width (at an edge or past it, it divides nothing). */
export function foldInside(width: number, fold: Fold | null): fold is Fold {
  return fold !== null && fold.width >= 0 && fold.x > 0 && fold.x + fold.width < width;
}

/**
 * Where the list, the space between and the detail go in a container this wide. With a fold inside it, the list ends
 * where the fold starts and the detail starts where it ends, so nothing sits in the curve. Otherwise the list takes
 * its share of the width (between `LIST_MIN` and `LIST_MAX`, never wider than the container), then the hairline
 * divider, then the detail the rest. No width is ever negative.
 */
export function paneFrames(width: number, fold: Fold | null): { list: Pane; detail: Pane; gap: number } {
  const total = Math.max(0, width);
  if (foldInside(total, fold)) {
    const detailX = fold.x + fold.width;
    return { list: { x: 0, width: fold.x }, gap: fold.width, detail: { x: detailX, width: total - detailX } };
  }
  const list = Math.min(total, LIST_MAX, Math.max(LIST_MIN, Math.round(total * LIST_SHARE)));
  const detailX = list + DIVIDER;
  return { list: { x: 0, width: list }, gap: DIVIDER, detail: { x: detailX, width: Math.max(0, total - detailX) } };
}
