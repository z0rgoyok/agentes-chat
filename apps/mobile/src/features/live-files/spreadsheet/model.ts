import {
  type BorderSide,
  type CellStyle,
  type CellValue,
  cellKey,
  cellsMap,
  colIds,
  colWidths,
  DEFAULT_COL_WIDTH,
  DEFAULT_FONT_PT,
  DEFAULT_FONT_PX,
  DEFAULT_ROW_HEIGHT,
  type ErrorCode,
  errorText,
  formatValue,
  frozenOf,
  isError,
  readCell,
  readMerges,
  rowHeights,
  rowIds,
  type SheetData,
  type SheetEngine,
  type SheetLocale,
  sheetIds,
  sheetName,
  type WorkbookData,
} from "@agenteschat/live/spreadsheet";
import type * as Y from "yjs";
import { axisStarts, type GridBox, mergeAt } from "./grid-view";

/**
 * What the phone's grid draws (ADR 0196, 0198), the same for a live spreadsheet and for a workbook the server read
 * from an upload (or an old table): the sheet's shape (row and column edges, frozen panes, merges) and, for the cells
 * a view shows, their text as the reader sees it with its look. The grid never reads the document itself.
 */

/** A cell as drawn: its text in the reader's language, and its look. */
export interface GridCellView {
  r: number;
  c: number;
  /** A merged block covers this many rows and columns (1 and 1 when not merged). */
  rows: number;
  cols: number;
  text: string;
  align: "l" | "c" | "r";
  valign: "t" | "m" | "b";
  color?: string;
  bg?: string;
  bold?: true;
  italic?: true;
  underline?: true;
  strike?: true;
  wrap?: true;
  /** The text's size in points at 100%. */
  size: number;
  /** Grid units the text may run over the empty cells on its right (text that doesn't fit, as spreadsheets do). */
  spill: number;
  error?: { code: ErrorCode; circular?: boolean };
  borders?: { t?: BorderSide; r?: BorderSide; b?: BorderSide; l?: BorderSide };
}

/** A sheet's shape: what the camera and the lines need. */
export interface GridLayout {
  /** Changes when the shape does (another sheet, rows or columns added, sizes changed). */
  key: string;
  rows: number;
  cols: number;
  rowStarts: number[];
  colStarts: number[];
  frozenRows: number;
  frozenCols: number;
  merges: GridBox[];
}

export interface GridSource {
  layout: GridLayout;
  /** Cells holding a value or a look in `box`, a merge's top-left cell included wherever the merge reaches into it. */
  cells(box: GridBox): GridCellView[];
  /** What the cell bar shows: a formula or a value as the person would type it. */
  input(row: number, col: number): string;
  /** A cell's value (the selection's sum and count). */
  value(row: number, col: number): CellValue;
}

/** One sheet's tab. */
export interface GridSheetTab {
  id: string;
  name: string;
}

/** How far text may run over empty cells to its right, in columns. */
const SPILL_COLS = 8;

const pxOf = (pt: number | undefined) => ((pt ?? DEFAULT_FONT_PT) * DEFAULT_FONT_PX) / DEFAULT_FONT_PT;

/** A cell's look from its style, its value's own alignment and its format's color. */
function lookOf(
  style: CellStyle | undefined,
  fallbackAlign: "l" | "c" | "r",
  color: string | undefined,
): Omit<GridCellView, "r" | "c" | "rows" | "cols" | "text" | "spill"> {
  const view: Omit<GridCellView, "r" | "c" | "rows" | "cols" | "text" | "spill"> = {
    align: style?.ha ?? fallbackAlign,
    valign: style?.va ?? "b",
    size: pxOf(style?.fs),
  };
  const ink = color ?? style?.fc;
  if (ink) view.color = ink;
  if (style?.bg) view.bg = style.bg;
  if (style?.b) view.bold = true;
  if (style?.i) view.italic = true;
  if (style?.u) view.underline = true;
  if (style?.x) view.strike = true;
  if (style?.w) view.wrap = true;
  if (style?.bd && (style.bd.t || style.bd.r || style.bd.b || style.bd.l)) view.borders = style.bd;
  return view;
}

/**
 * Text that doesn't fit runs over the empty cells on its right, as in other spreadsheets: left-aligned text that
 * doesn't wrap, until the next cell holding anything or a merge.
 */
function spill(views: GridCellView[], box: GridBox, merges: readonly GridBox[], colStarts: readonly number[]) {
  const taken = new Set<string>();
  for (const v of views) taken.add(`${v.r}:${v.c}`);
  for (const v of views) {
    if (v.wrap || v.align !== "l" || !v.text || v.cols > 1 || v.rows > 1 || v.error) continue;
    let end = v.c + 1;
    const last = Math.min(box.c2 + SPILL_COLS, colStarts.length - 2);
    while (end <= last && !taken.has(`${v.r}:${end}`) && !mergeAt(v.r, end, merges)) end++;
    v.spill = (colStarts[end] ?? 0) - (colStarts[v.c + 1] ?? 0);
  }
  return views;
}

/** An empty merged block still covers the lines inside it. */
function emptyMerge(r: number, c: number, merge: GridBox): GridCellView {
  return {
    r,
    c,
    rows: merge.r2 - merge.r1 + 1,
    cols: merge.c2 - merge.c1 + 1,
    text: "",
    spill: 0,
    ...lookOf(undefined, "l", undefined),
  };
}

/** The cells to read for `box`: its own, and the top-left cells of merges that reach into it from outside. */
function cellsToRead(box: GridBox, merges: readonly GridBox[]): { r: number; c: number; merge: GridBox | null }[] {
  const out: { r: number; c: number; merge: GridBox | null }[] = [];
  for (const m of merges) {
    if (m.r1 > box.r2 || m.r2 < box.r1 || m.c1 > box.c2 || m.c2 < box.c1) continue;
    if (m.r1 < box.r1 || m.c1 < box.c1) out.push({ r: m.r1, c: m.c1, merge: m });
  }
  for (let r = box.r1; r <= box.r2; r++)
    for (let c = box.c1; c <= box.c2; c++) {
      const m = mergeAt(r, c, merges);
      if (m && (m.r1 !== r || m.c1 !== c)) continue;
      out.push({ r, c, merge: m });
    }
  return out;
}

// ── A live spreadsheet ──────────────────────────────────────────────────────────────────────────────────────────

/** The sheets of a live spreadsheet, in order. */
export function liveSheetTabs(doc: Y.Doc): GridSheetTab[] {
  return sheetIds(doc).map((id) => ({ id, name: sheetName(doc, id) }));
}

/** A live sheet's shape and its row and column ids (read once per change to its shape). */
export interface LiveLayout extends GridLayout {
  rowIds: string[];
  colIds: string[];
}

export function liveGridLayout(doc: Y.Doc, sheetId: string): LiveLayout {
  const rows = rowIds(doc, sheetId);
  const cols = colIds(doc, sheetId);
  const frozen = frozenOf(doc, sheetId);
  const rowStarts = axisStarts(rowHeights(doc, sheetId));
  const colStarts = axisStarts(colWidths(doc, sheetId));
  const merges = readMerges(doc, sheetId).map(({ r1, c1, r2, c2 }) => ({ r1, c1, r2, c2 }));
  return {
    key: sheetId,
    rows: rows.length,
    cols: cols.length,
    rowStarts,
    colStarts,
    frozenRows: frozen.rows,
    frozenCols: frozen.cols,
    merges,
    rowIds: rows,
    colIds: cols,
  };
}

/** A live sheet's cells, computed by the room's engine and shown in the reader's language. */
export function liveGridSource(
  doc: Y.Doc,
  engine: SheetEngine,
  sheetId: string,
  layout: LiveLayout,
  locale: SheetLocale,
): GridSource {
  const map = cellsMap(doc, sheetId);
  const idsAt = (row: number, col: number) => {
    const rowId = layout.rowIds[row];
    const colId = layout.colIds[col];
    return rowId !== undefined && colId !== undefined ? { rowId, colId } : null;
  };
  return {
    layout,
    cells(box) {
      const views: GridCellView[] = [];
      if (!map) return views;
      for (const { r, c, merge } of cellsToRead(box, layout.merges)) {
        const ids = idsAt(r, c);
        if (!ids) continue;
        const raw = readCell(map.get(cellKey(ids.rowId, ids.colId)));
        if (!raw) {
          if (merge) views.push(emptyMerge(r, c, merge));
          continue;
        }
        const filled = raw.v !== undefined || raw.f !== undefined;
        let text = "";
        let align: "l" | "c" | "r" = "l";
        let color: string | undefined;
        let error: GridCellView["error"];
        if (filled) {
          const value = engine.value(sheetId, ids.rowId, ids.colId);
          text = engine.display(sheetId, ids.rowId, ids.colId, locale);
          const shown = formatValue(value, raw.s?.nf, locale);
          align = shown.align ?? "l";
          color = shown.color;
          if (isError(value)) {
            const info = engine.errorInfo(sheetId, ids.rowId, ids.colId);
            error = info ? { code: info.code, ...(info.circular ? { circular: true } : {}) } : { code: value.error };
          }
        }
        if (!text && !raw.s?.bg && !raw.s?.bd && !merge) continue;
        views.push({
          r,
          c,
          rows: merge ? merge.r2 - merge.r1 + 1 : 1,
          cols: merge ? merge.c2 - merge.c1 + 1 : 1,
          text,
          spill: 0,
          ...lookOf(raw.s, align, color),
          ...(error ? { error } : {}),
        });
      }
      return spill(views, box, layout.merges, layout.colStarts);
    },
    input(row, col) {
      const ids = idsAt(row, col);
      return ids ? engine.input(sheetId, ids.rowId, ids.colId, locale) : "";
    },
    value(row, col) {
      const ids = idsAt(row, col);
      return ids ? engine.value(sheetId, ids.rowId, ids.colId) : null;
    },
  };
}

// ── A workbook read from a file ─────────────────────────────────────────────────────────────────────────────────

/** A workbook's sheets as tabs (their index is their id). */
export function workbookTabs(data: WorkbookData): GridSheetTab[] {
  return data.sheets.map((s, i) => ({ id: String(i), name: s.name }));
}

/**
 * A sheet of a workbook the server read (an uploaded `xlsx`, `csv`…), read-only: values shown with the file's number
 * formats in the reader's language, formulas as the file wrote them.
 */
export function dataGridSource(sheet: SheetData, locale: SheetLocale, key: string): GridSource {
  const rows = Math.max(1, Math.floor(sheet.rows));
  const cols = Math.max(1, Math.floor(sheet.cols));
  const sizes = (n: number, record: Record<number, number> | undefined, fallback: number) =>
    Array.from({ length: n }, (_, i) => {
      const v = record?.[i];
      return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
    });
  const byKey = new Map<string, SheetData["cells"][number]>();
  for (const cell of sheet.cells) byKey.set(`${cell.r}:${cell.c}`, cell);
  const merges = (sheet.merges ?? []).map(({ r1, c1, r2, c2 }) => ({ r1, c1, r2, c2 }));
  const layout: GridLayout = {
    key,
    rows,
    cols,
    rowStarts: axisStarts(sizes(rows, sheet.rowHeights, DEFAULT_ROW_HEIGHT)),
    colStarts: axisStarts(sizes(cols, sheet.colWidths, DEFAULT_COL_WIDTH)),
    frozenRows: Math.min(rows, Math.max(0, sheet.frozen?.rows ?? 0)),
    frozenCols: Math.min(cols, Math.max(0, sheet.frozen?.cols ?? 0)),
    merges,
  };
  const cellValue = (cell: SheetData["cells"][number] | undefined): CellValue => {
    if (!cell) return null;
    if (cell.e) return { error: cell.e };
    return cell.v ?? null;
  };
  return {
    layout,
    cells(box) {
      const views: GridCellView[] = [];
      for (const { r, c, merge } of cellsToRead(box, merges)) {
        const cell = byKey.get(`${r}:${c}`);
        if (!cell) {
          if (merge) views.push(emptyMerge(r, c, merge));
          continue;
        }
        const value = cellValue(cell);
        // The value in the reader's language; what the file showed only when it kept no value (a formula's text).
        const shown = value !== null ? formatValue(value, cell.s?.nf, locale) : null;
        const text = cell.e ? errorText(cell.e, locale) : (shown?.text ?? cell.t ?? "");
        if (!text && !cell.s?.bg && !cell.s?.bd && !merge) continue;
        views.push({
          r,
          c,
          rows: merge ? merge.r2 - merge.r1 + 1 : 1,
          cols: merge ? merge.c2 - merge.c1 + 1 : 1,
          text,
          spill: 0,
          ...lookOf(cell.s, shown?.align ?? "l", shown?.color),
          ...(cell.e ? { error: { code: cell.e } } : {}),
        });
      }
      return spill(views, box, merges, layout.colStarts);
    },
    input(row, col) {
      const cell = byKey.get(`${row}:${col}`);
      if (!cell) return "";
      if (cell.f) return `=${cell.f}`;
      const value = cellValue(cell);
      return value === null ? (cell.t ?? "") : formatValue(value, cell.s?.nf, locale).text;
    },
    value: (row, col) => cellValue(byKey.get(`${row}:${col}`)),
  };
}

/** A column of numbers, amounts or percentages lines up on the right. */
const NUMERIC = /^[+\-−]?\s?(?:[A-Z]{0,3}\$|€|£)?\s?\d[\d.,\s]*%?$/;

/** An old table (columns and rows of text) as a one-sheet workbook: its header bold, numbers on the right. */
export function tableWorkbook(
  title: string,
  columns: readonly string[],
  rows: readonly (readonly string[])[],
): WorkbookData {
  const width = Math.max(1, columns.length, ...rows.map((r) => r.length));
  const cells: SheetData["cells"] = [];
  columns.forEach((text, c) => {
    if (text) cells.push({ r: 0, c, v: text, s: { b: 1 } });
  });
  rows.forEach((row, i) => {
    row.forEach((text, c) => {
      const value = text.trim();
      if (value) cells.push({ r: i + 1, c, v: text, ...(NUMERIC.test(value) ? { s: { ha: "r" as const } } : {}) });
    });
  });
  return {
    sheets: [
      {
        name: title,
        rows: rows.length + 1,
        cols: width,
        cells,
        frozen: { rows: columns.length > 0 ? 1 : 0, cols: 0 },
      },
    ],
  };
}

// ── The selection's numbers ─────────────────────────────────────────────────────────────────────────────────────

/** Past this many cells a selection's sum isn't worked out (a whole large sheet). */
export const STATS_MAX_CELLS = 50_000;

/** The selection's sum and average of its numbers, and how many cells hold anything; null for one cell or too many. */
export function selectionStats(
  source: Pick<GridSource, "value">,
  box: GridBox,
): { sum: number; average: number | null; count: number; numbers: number } | null {
  const area = (box.r2 - box.r1 + 1) * (box.c2 - box.c1 + 1);
  if (area <= 1 || area > STATS_MAX_CELLS) return null;
  let sum = 0;
  let numbers = 0;
  let count = 0;
  for (let r = box.r1; r <= box.r2; r++)
    for (let c = box.c1; c <= box.c2; c++) {
      const v = source.value(r, c);
      if (v === null || v === "") continue;
      count++;
      if (typeof v === "number" && Number.isFinite(v)) {
        sum += v;
        numbers++;
      }
    }
  return { sum, average: numbers > 0 ? sum / numbers : null, count, numbers };
}
