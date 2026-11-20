/**
 * The spreadsheet editor's pure parts (ADR 0196): where rows and columns sit, the selection and how keys move it, the
 * labels the name box and "Ask an agent" show, what the fill handle reaches, and the status line's sum. No DOM, so
 * they are tested on their own and drawn by `draw.ts`.
 */
import { formatA1Range } from "@agenteschat/live/spreadsheet";

export interface CellPos {
  r: number;
  c: number;
}

/** A block of cells by index, inclusive and normalized (`r1 <= r2`, `c1 <= c2`). */
export interface GridRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface GridSize {
  rows: number;
  cols: number;
}

/** Whole rows, whole columns or the whole sheet: the selection keeps its kind as rows and columns come and go. */
export type Whole = "rows" | "cols" | "all";

/**
 * The person's selection on one sheet: the cells from `anchor` to `corner` (Shift moves the corner), the active cell
 * where typing goes (the anchor, until Enter or Tab walk it through the range), and whether it holds whole rows or
 * columns.
 */
export interface SheetSelection {
  active: CellPos;
  anchor: CellPos;
  corner: CellPos;
  whole?: Whole;
}

/**
 * What the grid's field holds while nothing is typed, selected: with a selection the browser (and the Mac app's Edit
 * menu, on WebKit) sends copy and cut to it, and the first key typed replaces it.
 */
export const IDLE_TEXT = "\u200b";

/** Row header width and column header height, in CSS px. */
export const HEADER_W = 48;
export const HEADER_H = 24;

export const clampIndex = (n: number, count: number) => Math.max(0, Math.min(Math.max(0, count - 1), n));

export function normalize(a: CellPos, b: CellPos): GridRange {
  return { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) };
}

export const sameRange = (a: GridRange | null | undefined, b: GridRange | null | undefined) =>
  a === b || (!!a && !!b && a.r1 === b.r1 && a.c1 === b.c1 && a.r2 === b.r2 && a.c2 === b.c2);

export const inRange = (range: GridRange, r: number, c: number) =>
  r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2;

export const rangesMeet = (a: GridRange, b: GridRange) => a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;

export const cellCount = (range: GridRange) => (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);

export const collapsed = (pos: CellPos): SheetSelection => ({ active: pos, anchor: pos, corner: pos });

// ── Positions ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Rows or columns laid end to end: where each starts, and which one a position falls in (a binary search, so a sheet
 * of 20,000 rows finds its visible window at once).
 */
export class Axis {
  /** `starts[i]` is where item `i` begins; `starts[count]` is the total. */
  private readonly starts: Float64Array;

  constructor(sizes: readonly number[]) {
    this.starts = new Float64Array(sizes.length + 1);
    let at = 0;
    for (let i = 0; i < sizes.length; i++) {
      this.starts[i] = at;
      at += sizes[i] ?? 0;
    }
    this.starts[sizes.length] = at;
  }

  get count(): number {
    return this.starts.length - 1;
  }

  get total(): number {
    return this.starts[this.count] ?? 0;
  }

  start(i: number): number {
    return this.starts[Math.max(0, Math.min(i, this.count))] ?? 0;
  }

  end(i: number): number {
    return this.start(i + 1);
  }

  size(i: number): number {
    return this.end(i) - this.start(i);
  }

  /** The item at a position (clamped to the first and last). */
  indexAt(pos: number): number {
    const n = this.count;
    if (n === 0 || pos <= 0) return 0;
    if (pos >= this.total) return n - 1;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] ?? 0) <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** The boundary (an item's end) within `slop` of a position, for resizing: the item it ends, or -1. */
  edgeNear(pos: number, slop: number): number {
    const n = this.count;
    if (n === 0) return -1;
    const i = this.indexAt(pos);
    const end = this.end(i);
    if (Math.abs(end - pos) <= slop) return i;
    const begin = this.start(i);
    if (i > 0 && Math.abs(pos - begin) <= slop) return i - 1;
    return -1;
  }
}

// ── Merges ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The sheet's merged blocks, found by any cell they cover. */
export class MergeIndex {
  private readonly byRow = new Map<number, GridRange[]>();

  constructor(readonly list: readonly GridRange[]) {
    for (const m of list) {
      for (let r = m.r1; r <= m.r2; r++) {
        const row = this.byRow.get(r);
        if (row) row.push(m);
        else this.byRow.set(r, [m]);
      }
    }
  }

  /** The merge covering a cell, if any. */
  at(r: number, c: number): GridRange | undefined {
    const row = this.byRow.get(r);
    if (!row) return undefined;
    for (const m of row) if (c >= m.c1 && c <= m.c2) return m;
    return undefined;
  }

  /** A range grown until no merge sticks out of it, as a selection over part of a merge takes all of it. */
  grow(range: GridRange): GridRange {
    if (this.list.length === 0) return range;
    const out = { ...range };
    for (let changed = true, guard = 0; changed && guard < 64; guard++) {
      changed = false;
      for (const m of this.list) {
        if (!rangesMeet(m, out)) continue;
        if (m.r1 < out.r1 || m.c1 < out.c1 || m.r2 > out.r2 || m.c2 > out.c2) {
          out.r1 = Math.min(out.r1, m.r1);
          out.c1 = Math.min(out.c1, m.c1);
          out.r2 = Math.max(out.r2, m.r2);
          out.c2 = Math.max(out.c2, m.c2);
          changed = true;
        }
      }
    }
    return out;
  }
}

export const NO_MERGES = new MergeIndex([]);

// ── Selection ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The cells a selection covers on a sheet of `size`, merges taken whole. */
export function selectionRange(sel: SheetSelection, size: GridSize, merges: MergeIndex = NO_MERGES): GridRange {
  const lastRow = Math.max(0, size.rows - 1);
  const lastCol = Math.max(0, size.cols - 1);
  if (sel.whole === "all") return { r1: 0, c1: 0, r2: lastRow, c2: lastCol };
  const base = normalize(sel.anchor, sel.corner);
  if (sel.whole === "rows") {
    return { r1: clampIndex(base.r1, size.rows), c1: 0, r2: clampIndex(base.r2, size.rows), c2: lastCol };
  }
  if (sel.whole === "cols") {
    return { r1: 0, c1: clampIndex(base.c1, size.cols), r2: lastRow, c2: clampIndex(base.c2, size.cols) };
  }
  const clamped = {
    r1: clampIndex(base.r1, size.rows),
    c1: clampIndex(base.c1, size.cols),
    r2: clampIndex(base.r2, size.rows),
    c2: clampIndex(base.c2, size.cols),
  };
  return merges.grow(clamped);
}

/** A cell, or the top-left of the merge it is in. */
export function anchorOf(pos: CellPos, merges: MergeIndex): CellPos {
  const m = merges.at(pos.r, pos.c);
  return m ? { r: m.r1, c: m.c1 } : pos;
}

/** One step from a cell (across a merge it is in), within the sheet. */
export function stepFrom(pos: CellPos, dr: number, dc: number, size: GridSize, merges: MergeIndex): CellPos {
  const m = merges.at(pos.r, pos.c);
  let r = pos.r;
  let c = pos.c;
  if (dr > 0) r = (m ? m.r2 : r) + dr;
  else if (dr < 0) r = (m ? m.r1 : r) + dr;
  if (dc > 0) c = (m ? m.c2 : c) + dc;
  else if (dc < 0) c = (m ? m.c1 : c) + dc;
  return { r: clampIndex(r, size.rows), c: clampIndex(c, size.cols) };
}

/**
 * Ctrl/⌘ with an arrow: to the edge of the block of filled cells the cell is in, or to the next filled cell past
 * empty ones, or to the sheet's edge, as in Excel.
 */
export function jumpFrom(
  pos: CellPos,
  dr: number,
  dc: number,
  size: GridSize,
  filled: (r: number, c: number) => boolean,
): CellPos {
  const inside = (r: number, c: number) => r >= 0 && c >= 0 && r < size.rows && c < size.cols;
  let r = pos.r;
  let c = pos.c;
  if (!inside(r + dr, c + dc)) return pos;
  if (filled(r, c) && filled(r + dr, c + dc)) {
    while (inside(r + dr, c + dc) && filled(r + dr, c + dc)) {
      r += dr;
      c += dc;
    }
    return { r, c };
  }
  r += dr;
  c += dc;
  while (inside(r + dr, c + dc) && !filled(r, c)) {
    r += dr;
    c += dc;
  }
  return { r, c };
}

/**
 * Enter and Tab inside a selection of several cells: the active cell walks through it (down then across for Enter,
 * across then down for Tab; backwards with Shift), wrapping, and the selection stays.
 */
export function cycleWithin(range: GridRange, pos: CellPos, by: "row" | "col", back: boolean): CellPos {
  const rows = range.r2 - range.r1 + 1;
  const cols = range.c2 - range.c1 + 1;
  const total = rows * cols;
  const index =
    by === "row" ? (pos.c - range.c1) * rows + (pos.r - range.r1) : (pos.r - range.r1) * cols + (pos.c - range.c1);
  const next = (((index + (back ? -1 : 1)) % total) + total) % total;
  return by === "row"
    ? { r: range.r1 + (next % rows), c: range.c1 + Math.floor(next / rows) }
    : { r: range.r1 + Math.floor(next / cols), c: range.c1 + (next % cols) };
}

/** Where the fill handle dragged to `to` fills: the selection grown along the axis the pointer went farther on. */
export function fillTarget(range: GridRange, to: CellPos): GridRange | null {
  const down = to.r - range.r2;
  const up = range.r1 - to.r;
  const right = to.c - range.c2;
  const left = range.c1 - to.c;
  const vertical = Math.max(down, up);
  const horizontal = Math.max(right, left);
  if (vertical <= 0 && horizontal <= 0) return null;
  if (vertical >= horizontal) return down > 0 ? { ...range, r2: to.r } : { ...range, r1: to.r };
  return right > 0 ? { ...range, c2: to.c } : { ...range, c1: to.c };
}

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** "B4", "B2:E9", "C:C" (a whole column), "3:5" (whole rows): what the name box shows. */
export function rangeA1(range: GridRange, size?: GridSize): string {
  return formatA1Range(range.r1, range.c1, range.r2, range.c2, size);
}

/** "Planilha 1!B2:E9": the selection as "Ask an agent" and the page's header say it. */
export function selectionLabel(sheetName: string, range: GridRange, size?: GridSize): string {
  return `${sheetName}!${rangeA1(range, size)}`;
}

// ── The status line ───────────────────────────────────────────────────────────────────────────────────────────────

export interface SelectionStats {
  /** Cells holding anything. */
  count: number;
  /** Cells holding a number. */
  numbers: number;
  sum: number;
  /** The first number's format, to show the sum and average in it. */
  nf?: string;
}

/** Sums what a selection holds, as the status line shows it (numbers only; text and errors are counted, not summed). */
export function statsOf(values: Iterable<{ value: unknown; nf?: string }>): SelectionStats {
  const out: SelectionStats = { count: 0, numbers: 0, sum: 0 };
  for (const { value, nf } of values) {
    if (value === null || value === undefined || value === "") continue;
    out.count++;
    if (typeof value === "number" && Number.isFinite(value)) {
      out.numbers++;
      out.sum += value;
      if (out.nf === undefined && nf) out.nf = nf;
    }
  }
  return out;
}

// ── Viewport ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the grid shows: its size and scroll, and the sheet's frozen panes. */
export interface Viewport {
  /** The visible area, headers included (CSS px). */
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  frozenRows: number;
  frozenCols: number;
}

/** A cell's or range's box on screen (CSS px from the grid's top-left), before clipping to its pane. */
export interface ScreenBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a column starts on screen: frozen ones stay put, the rest move with the scroll. */
export function screenX(cols: Axis, c: number, view: Viewport): number {
  return HEADER_W + cols.start(c) - (c < view.frozenCols ? 0 : view.scrollX);
}

export function screenY(rows: Axis, r: number, view: Viewport): number {
  return HEADER_H + rows.start(r) - (r < view.frozenRows ? 0 : view.scrollY);
}

export function rangeBox(range: GridRange, rows: Axis, cols: Axis, view: Viewport): ScreenBox {
  const x = screenX(cols, range.c1, view);
  const y = screenY(rows, range.r1, view);
  // A range crossing the frozen edge spans from the frozen part to where its scrolled part ends.
  const right = screenX(cols, range.c2, view) + cols.size(range.c2);
  const bottom = screenY(rows, range.r2, view) + rows.size(range.r2);
  return { x, y, w: right - x, h: bottom - y };
}

/** The cell under a point on screen (CSS px from the grid's top-left); headers answer -1 on their axis. */
export function cellAtPoint(px: number, py: number, rows: Axis, cols: Axis, view: Viewport): CellPos {
  const frozenW = cols.start(view.frozenCols);
  const frozenH = rows.start(view.frozenRows);
  const x = px - HEADER_W;
  const y = py - HEADER_H;
  const c = x < 0 ? -1 : cols.indexAt(x < frozenW ? x : x + view.scrollX);
  const r = y < 0 ? -1 : rows.indexAt(y < frozenH ? y : y + view.scrollY);
  return { r, c };
}

/** The scroll that brings a range into view (its top-left first when it doesn't fit), or the same scroll. */
export function scrollToShow(range: GridRange, rows: Axis, cols: Axis, view: Viewport): { x: number; y: number } {
  const frozenW = cols.start(view.frozenCols);
  const frozenH = rows.start(view.frozenRows);
  const paneW = Math.max(0, view.width - HEADER_W - frozenW);
  const paneH = Math.max(0, view.height - HEADER_H - frozenH);
  let { scrollX: x, scrollY: y } = view;
  if (range.c1 >= view.frozenCols) {
    const left = cols.start(range.c1) - frozenW;
    const right = cols.end(range.c2) - frozenW;
    if (right - x > paneW) x = Math.min(left, right - paneW);
    if (left < x) x = left;
  }
  if (range.r1 >= view.frozenRows) {
    const top = rows.start(range.r1) - frozenH;
    const bottom = rows.end(range.r2) - frozenH;
    if (bottom - y > paneH) y = Math.min(top, bottom - paneH);
    if (top < y) y = top;
  }
  return { x: Math.max(0, x), y: Math.max(0, y) };
}

/** The rows (or columns) a scrolled pane shows: from the first visible to the last, inclusive. */
export function visibleSpan(axis: Axis, from: number, scroll: number, length: number): [number, number] {
  if (axis.count === 0 || from >= axis.count) return [0, -1];
  const offset = axis.start(from);
  const first = Math.max(from, axis.indexAt(offset + scroll));
  const last = axis.indexAt(offset + scroll + Math.max(0, length - 1));
  return [first, Math.max(first, last)];
}
