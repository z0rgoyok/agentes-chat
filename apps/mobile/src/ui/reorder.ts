/* A reorder list's math (worklets: they run on the UI thread during the drag). */

/** Where a dragged row lands: how many rows' middles it passed, up or down (rows of any height). */
export function reorderTarget(heights: readonly number[], from: number, dy: number): number {
  "worklet";
  let to = from;
  if (dy > 0) {
    let moved = dy;
    for (let i = from + 1; i < heights.length; i++) {
      const h = heights[i] ?? 0;
      if (moved < h / 2) break;
      moved -= h;
      to = i;
    }
  } else {
    let moved = -dy;
    for (let i = from - 1; i >= 0; i--) {
      const h = heights[i] ?? 0;
      if (moved < h / 2) break;
      moved -= h;
      to = i;
    }
  }
  return to;
}

/** How far row `i` steps aside while the row at `from` is held over `to`: the held row's height, up or down. */
export function shiftOf(i: number, from: number, to: number, held: number): number {
  "worklet";
  if (from < 0 || i === from) return 0;
  if (from < to && i > from && i <= to) return -held;
  if (to < from && i >= to && i < from) return held;
  return 0;
}
