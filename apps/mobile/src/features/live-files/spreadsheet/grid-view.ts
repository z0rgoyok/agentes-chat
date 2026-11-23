/*
 * The spreadsheet's camera on the phone (ADR 0196): where rows and columns start, which of them the screen shows, the
 * cell under a finger, and the camera kept on the sheet while it pans and pinches. Grid units are points at 100%; the
 * column letters and row numbers keep their size at any zoom, and frozen rows and columns stay put while the rest
 * moves under them. Worklets (the gestures run them on the UI thread) and plain functions in the tests.
 */

/** The farthest out and the closest in a pinch goes. */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2;
/** The column letters' strip, in points (it keeps its height at any zoom). */
export const HEADER_H = 24;
/** The row numbers' strip is at least this wide (wider for rows past 999). */
export const ROW_HEADER_MIN = 36;
/** Rows and columns are drawn in whole blocks, so the cells redraw only when the view crosses one. */
export const ROW_BLOCK = 16;
export const COL_BLOCK = 4;

export interface Point {
  x: number;
  y: number;
}

/** The grid's box on screen, its headers included. */
export interface Frame {
  width: number;
  height: number;
}

/** A block of cells, in index space, inclusive. */
export interface GridBox {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** What the camera needs of a sheet: where its rows and columns start (n + 1 numbers) and what is frozen. */
export interface GridAxes {
  rowStarts: readonly number[];
  colStarts: readonly number[];
  frozenRows: number;
  frozenCols: number;
  /** The row numbers' strip, in points. */
  headerW: number;
}

/** The camera: the grid point at the scrolling part's top left, and the zoom. */
export interface Camera {
  x: number;
  y: number;
  s: number;
}

export const clamp = (v: number, min: number, max: number) => {
  "worklet";
  return Math.max(min, Math.min(max, v));
};

/** Where each row (or column) starts, its end last: n + 1 numbers from 0. */
export function axisStarts(sizes: readonly number[]): number[] {
  const out = new Array<number>(sizes.length + 1);
  let at = 0;
  out[0] = 0;
  for (let i = 0; i < sizes.length; i++) {
    at += Math.max(0, sizes[i] ?? 0);
    out[i + 1] = at;
  }
  return out;
}

/** The row (or column) at `pos` along its axis, clamped to the sheet; -1 for an empty axis. */
export function indexAt(starts: readonly number[], pos: number): number {
  "worklet";
  const n = starts.length - 1;
  if (n <= 0) return -1;
  if (pos <= 0) return 0;
  if (pos >= (starts[n] ?? 0)) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The row numbers' strip: as wide as the last row's number needs, never under `ROW_HEADER_MIN`. */
export function rowHeaderWidth(rows: number): number {
  return Math.max(ROW_HEADER_MIN, 14 + String(Math.max(1, Math.floor(rows))).length * 8);
}

/** The frozen part's size in grid units. */
export function frozenSize(axes: GridAxes): { w: number; h: number } {
  "worklet";
  return { w: axes.colStarts[axes.frozenCols] ?? 0, h: axes.rowStarts[axes.frozenRows] ?? 0 };
}

/** Where the scrolling part starts on screen, past the headers and the frozen rows and columns. */
export function paneOrigin(axes: GridAxes, s: number): Point {
  "worklet";
  const f = frozenSize(axes);
  return { x: axes.headerW + f.w * s, y: HEADER_H + f.h * s };
}

/**
 * The camera kept on the sheet: the scrolling part never shows past its first or last row or column (a sheet smaller
 * than the screen stays at its start).
 */
export function clampCamera(x: number, y: number, s: number, frame: Frame, axes: GridAxes): Point {
  "worklet";
  const f = frozenSize(axes);
  const totalW = axes.colStarts[axes.colStarts.length - 1] ?? 0;
  const totalH = axes.rowStarts[axes.rowStarts.length - 1] ?? 0;
  const seenW = Math.max(0, (frame.width - axes.headerW) / s - f.w);
  const seenH = Math.max(0, (frame.height - HEADER_H) / s - f.h);
  return {
    x: clamp(x, f.w, Math.max(f.w, totalW - seenW)),
    y: clamp(y, f.h, Math.max(f.h, totalH - seenH)),
  };
}

/** The zoom changed to `next` with the grid point under `focal` (a point on the grid's box) staying under it. */
export function zoomCamera(camera: Camera, next: number, focal: Point, frame: Frame, axes: GridAxes): Camera {
  "worklet";
  const s = clamp(next, MIN_ZOOM, MAX_ZOOM);
  const from = paneOrigin(axes, camera.s);
  const to = paneOrigin(axes, s);
  const gx = camera.x + (focal.x - from.x) / camera.s;
  const gy = camera.y + (focal.y - from.y) / camera.s;
  const at = clampCamera(gx - (focal.x - to.x) / s, gy - (focal.y - to.y) / s, s, frame, axes);
  return { x: at.x, y: at.y, s };
}

/** A column edge's x on screen: frozen columns stay where they are, the rest move with the camera. */
export function edgeX(gx: number, frozen: boolean, camera: Camera, axes: GridAxes): number {
  "worklet";
  if (frozen) return axes.headerW + gx * camera.s;
  return paneOrigin(axes, camera.s).x + (gx - camera.x) * camera.s;
}

/** A row edge's y on screen. */
export function edgeY(gy: number, frozen: boolean, camera: Camera, axes: GridAxes): number {
  "worklet";
  if (frozen) return HEADER_H + gy * camera.s;
  return paneOrigin(axes, camera.s).y + (gy - camera.y) * camera.s;
}

/**
 * The cell under a point on the grid's box: `row` -1 on the column letters, `col` -1 on the row numbers (both on the
 * corner). Past the sheet's end it is the last row or column.
 */
export function hitCell(p: Point, camera: Camera, axes: GridAxes): { row: number; col: number } {
  "worklet";
  const f = frozenSize(axes);
  const origin = paneOrigin(axes, camera.s);
  let col = -1;
  if (p.x >= axes.headerW) {
    // On the frozen columns the point never reaches past them; on the rest it reads through the camera.
    const gx =
      p.x < origin.x ? Math.min((p.x - axes.headerW) / camera.s, f.w - 0.001) : camera.x + (p.x - origin.x) / camera.s;
    col = indexAt(axes.colStarts, gx);
  }
  let row = -1;
  if (p.y >= HEADER_H) {
    const gy =
      p.y < origin.y ? Math.min((p.y - HEADER_H) / camera.s, f.h - 0.001) : camera.y + (p.y - origin.y) / camera.s;
    row = indexAt(axes.rowStarts, gy);
  }
  return { row, col };
}

/**
 * A block of cells on screen, cut where the frozen part or the headers cover it (a block wholly under them has no
 * width or height). Null for a block outside the sheet.
 */
export function boxOnScreen(
  box: GridBox,
  camera: Camera,
  axes: GridAxes,
): { x: number; y: number; w: number; h: number } | null {
  "worklet";
  const rows = axes.rowStarts.length - 1;
  const cols = axes.colStarts.length - 1;
  if (box.r1 < 0 || box.c1 < 0 || box.r2 >= rows || box.c2 >= cols || box.r1 > box.r2 || box.c1 > box.c2) return null;
  const origin = paneOrigin(axes, camera.s);
  const x1 = edgeX(axes.colStarts[box.c1] ?? 0, box.c1 < axes.frozenCols, camera, axes);
  const x2 = edgeX(axes.colStarts[box.c2 + 1] ?? 0, box.c2 < axes.frozenCols, camera, axes);
  const y1 = edgeY(axes.rowStarts[box.r1] ?? 0, box.r1 < axes.frozenRows, camera, axes);
  const y2 = edgeY(axes.rowStarts[box.r2 + 1] ?? 0, box.r2 < axes.frozenRows, camera, axes);
  // What scrolls hides under the frozen part; nothing goes over the headers.
  const left = box.c1 < axes.frozenCols ? axes.headerW : origin.x;
  const top = box.r1 < axes.frozenRows ? HEADER_H : origin.y;
  const x = Math.max(x1, left);
  const y = Math.max(y1, top);
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

/** The rows and columns of the scrolling part on screen now (inclusive; empty as r2 < r1). */
export function visibleBox(camera: Camera, frame: Frame, axes: GridAxes): GridBox {
  "worklet";
  const f = frozenSize(axes);
  const seenW = Math.max(0, (frame.width - axes.headerW) / camera.s - f.w);
  const seenH = Math.max(0, (frame.height - HEADER_H) / camera.s - f.h);
  const rows = axes.rowStarts.length - 1;
  const cols = axes.colStarts.length - 1;
  if (rows <= 0 || cols <= 0) return { r1: 0, c1: 0, r2: -1, c2: -1 };
  return {
    r1: Math.max(axes.frozenRows, indexAt(axes.rowStarts, camera.y)),
    r2: indexAt(axes.rowStarts, camera.y + seenH),
    c1: Math.max(axes.frozenCols, indexAt(axes.colStarts, camera.x)),
    c2: indexAt(axes.colStarts, camera.x + seenW),
  };
}

/**
 * The cells to draw: what is on screen rounded out to whole blocks, one block more on every side, within the sheet.
 * It changes only when the view crosses a block, so a pan redraws the cells a few times a second at most.
 */
export function drawnBox(visible: GridBox, rows: number, cols: number, frozenRows = 0, frozenCols = 0): GridBox {
  "worklet";
  if (visible.r2 < visible.r1 || visible.c2 < visible.c1) return { r1: 0, c1: 0, r2: -1, c2: -1 };
  const r1 = Math.max(frozenRows, (Math.floor(visible.r1 / ROW_BLOCK) - 1) * ROW_BLOCK);
  const r2 = Math.min(rows - 1, (Math.floor(visible.r2 / ROW_BLOCK) + 2) * ROW_BLOCK - 1);
  const c1 = Math.max(frozenCols, (Math.floor(visible.c1 / COL_BLOCK) - 1) * COL_BLOCK);
  const c2 = Math.min(cols - 1, (Math.floor(visible.c2 / COL_BLOCK) + 2) * COL_BLOCK - 1);
  return { r1, c1, r2, c2 };
}

export const sameBox = (a: GridBox | null | undefined, b: GridBox | null | undefined) => {
  "worklet";
  return !!a && !!b && a.r1 === b.r1 && a.c1 === b.c1 && a.r2 === b.r2 && a.c2 === b.c2;
};

/**
 * The camera moved as little as it takes for a block to be in view (the cell being edited, someone followed): a block
 * larger than the view shows its top left. Frozen rows and columns are always in view.
 */
export function revealCamera(camera: Camera, box: GridBox, frame: Frame, axes: GridAxes): Point {
  "worklet";
  const f = frozenSize(axes);
  const seenW = Math.max(0, (frame.width - axes.headerW) / camera.s - f.w);
  const seenH = Math.max(0, (frame.height - HEADER_H) / camera.s - f.h);
  let x = camera.x;
  let y = camera.y;
  if (box.c1 >= axes.frozenCols) {
    const left = axes.colStarts[box.c1] ?? 0;
    const right = axes.colStarts[Math.min(box.c2, axes.colStarts.length - 2) + 1] ?? left;
    if (right - left >= seenW || left < x) x = left;
    else if (right > x + seenW) x = right - seenW;
  }
  if (box.r1 >= axes.frozenRows) {
    const top = axes.rowStarts[box.r1] ?? 0;
    const bottom = axes.rowStarts[Math.min(box.r2, axes.rowStarts.length - 2) + 1] ?? top;
    if (bottom - top >= seenH || top < y) y = top;
    else if (bottom > y + seenH) y = bottom - seenH;
  }
  return clampCamera(x, y, camera.s, frame, axes);
}

/**
 * The grid's lines on screen as segments (x1, y1, x2, y2, …): every row and column edge the view shows, across the
 * cells and their headers, as far as the sheet goes. Drawn on the UI thread for every frame of a pan.
 */
export function gridSegments(camera: Camera, frame: Frame, axes: GridAxes): number[] {
  "worklet";
  const out: number[] = [];
  const rows = axes.rowStarts.length - 1;
  const cols = axes.colStarts.length - 1;
  if (rows <= 0 || cols <= 0) return out;
  const v = visibleBox(camera, frame, axes);
  const right = Math.min(frame.width, edgeX(axes.colStarts[cols] ?? 0, cols <= axes.frozenCols, camera, axes));
  const bottom = Math.min(frame.height, edgeY(axes.rowStarts[rows] ?? 0, rows <= axes.frozenRows, camera, axes));
  const origin = paneOrigin(axes, camera.s);
  // Columns: the frozen ones, then the scrolling ones on screen.
  for (let c = 1; c <= axes.frozenCols; c++) {
    const x = edgeX(axes.colStarts[c] ?? 0, true, camera, axes);
    out.push(x, 0, x, bottom);
  }
  for (let c = Math.max(v.c1, axes.frozenCols) + 1; c <= Math.min(v.c2 + 1, cols); c++) {
    const x = edgeX(axes.colStarts[c] ?? 0, false, camera, axes);
    if (x > origin.x && x <= frame.width) out.push(x, 0, x, bottom);
  }
  for (let r = 1; r <= axes.frozenRows; r++) {
    const y = edgeY(axes.rowStarts[r] ?? 0, true, camera, axes);
    out.push(0, y, right, y);
  }
  for (let r = Math.max(v.r1, axes.frozenRows) + 1; r <= Math.min(v.r2 + 1, rows); r++) {
    const y = edgeY(axes.rowStarts[r] ?? 0, false, camera, axes);
    if (y > origin.y && y <= frame.height) out.push(0, y, right, y);
  }
  return out;
}

/** A range from where a drag started to the cell it is over now, in order. */
export function spanBox(a: { row: number; col: number }, b: { row: number; col: number }): GridBox {
  "worklet";
  return {
    r1: Math.min(a.row, b.row),
    c1: Math.min(a.col, b.col),
    r2: Math.max(a.row, b.row),
    c2: Math.max(a.col, b.col),
  };
}

/** A block grown to cover every merge it touches (a merged block is selected whole). */
export function withMerges(box: GridBox, merges: readonly GridBox[]): GridBox {
  let out = box;
  for (let pass = 0; pass < 4; pass++) {
    let grew = false;
    for (const m of merges) {
      if (m.r1 > out.r2 || m.r2 < out.r1 || m.c1 > out.c2 || m.c2 < out.c1) continue;
      const next = {
        r1: Math.min(out.r1, m.r1),
        c1: Math.min(out.c1, m.c1),
        r2: Math.max(out.r2, m.r2),
        c2: Math.max(out.c2, m.c2),
      };
      if (!sameBox(next, out)) {
        out = next;
        grew = true;
      }
    }
    if (!grew) break;
  }
  return out;
}

/** The merge whose top-left cell this is, or that covers it. */
export function mergeAt(row: number, col: number, merges: readonly GridBox[]): GridBox | null {
  return merges.find((m) => row >= m.r1 && row <= m.r2 && col >= m.c1 && col <= m.c2) ?? null;
}
