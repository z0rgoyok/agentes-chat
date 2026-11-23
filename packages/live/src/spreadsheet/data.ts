/**
 * Workbooks as plain data (ADR 0198): the shape the server's Office readers produce (an uploaded `xlsx`, `csv`…)
 * and its writers consume (exports), and what turns one into a live spreadsheet and back. Formulas in this shape are
 * Excel's own: A1, English names, `,` between arguments, no "=", read against the workbook's sheets by name.
 */
import type * as Y from "yjs";
import { newId } from "../ids";
import type { LiveOrigin } from "../origins";
import {
  type CellData,
  type CellStyle,
  cellKey,
  cellsMap,
  cleanCellStyle,
  cleanSheetName,
  colIds,
  colWidths as colWidthList,
  DEFAULT_COL_WIDTH,
  DEFAULT_COLS,
  DEFAULT_ROW_HEIGHT,
  DEFAULT_ROWS,
  frozenOf,
  indexOf,
  isHexColor,
  MAX_COL_WIDTH,
  MAX_ROW_HEIGHT,
  type Merge,
  MIN_SIZE,
  newSheetMap,
  parseCellKey,
  readCell,
  readMerges,
  rowHeights as rowHeightList,
  rowIds,
  SheetError,
  type SheetValues,
  sheetIds,
  sheetName,
  sheetOrderArray,
  sheetParts,
  sheetsMap,
  sheetTabColor,
  uniqueSheetName,
} from "./doc";
import { toCanonical, toDisplay } from "./formula";
import { sheetLocale } from "./locale";
import { type ErrorCode, isError, isErrorCode } from "./values";
import {
  addNeeds,
  CANONICAL_FORMULA_MAX,
  checkSize,
  growSheets,
  SHEET_LIMITS,
  type SheetNeeds,
  writeCell,
} from "./write";

/** One cell of a sheet as data (0-based row and column). */
export interface SheetCellData {
  r: number;
  c: number;
  v?: number | string | boolean;
  /** Formula in A1, English, without the "=". */
  f?: string;
  s?: CellStyle;
  /** An error value (computed by the formula, or held by the cell). */
  e?: ErrorCode;
  /** What the cell shows, as the file had it (readers) or in English (writers). */
  t?: string;
}

export interface SheetData {
  name: string;
  rows: number;
  cols: number;
  cells: SheetCellData[];
  /** Widths in px by column index, only where not the default. */
  colWidths?: Record<number, number>;
  /** Heights in px by row index, only where not the default. */
  rowHeights?: Record<number, number>;
  merges?: { r1: number; c1: number; r2: number; c2: number }[];
  frozen?: { rows: number; cols: number };
  /** The tab's color, `#rrggbb`. */
  tab?: string;
}

export interface WorkbookData {
  sheets: SheetData[];
}

const EN = sheetLocale("en-US");

function whole(n: unknown): number | null {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * A sheet's grid size: what its cells and merges reach, its declared size (within the limits) and at least a new
 * sheet's 100 × 26. Throws `limit` when its cells reach past the limits.
 */
function gridOf(sheet: SheetData): { rows: number; cols: number } {
  let rows = 0;
  let cols = 0;
  for (const cell of sheet.cells) {
    const r = whole(cell.r);
    const c = whole(cell.c);
    if (r === null || c === null) continue;
    rows = Math.max(rows, r + 1);
    cols = Math.max(cols, c + 1);
  }
  for (const m of sheet.merges ?? []) {
    rows = Math.max(rows, (whole(m.r2) ?? 0) + 1, (whole(m.r1) ?? 0) + 1);
    cols = Math.max(cols, (whole(m.c2) ?? 0) + 1, (whole(m.c1) ?? 0) + 1);
  }
  checkSize(rows, cols);
  return {
    rows: Math.max(rows, DEFAULT_ROWS, Math.min(whole(sheet.rows) ?? 0, SHEET_LIMITS.rows)),
    cols: Math.max(cols, DEFAULT_COLS, Math.min(whole(sheet.cols) ?? 0, SHEET_LIMITS.cols)),
  };
}

function cellValue(cell: SheetCellData): CellData["v"] | undefined {
  const v = cell.v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") return v.length > 0 ? v.slice(0, SHEET_LIMITS.cellChars) : undefined;
  return typeof v === "boolean" ? v : undefined;
}

function sizeOf(px: unknown, max: number, fallback: number): number | null {
  if (typeof px !== "number" || !Number.isFinite(px) || px <= 0) return null;
  const size = Math.round(Math.max(MIN_SIZE, Math.min(max, px)));
  return size === fallback ? null : size;
}

/**
 * Replaces the document's spreadsheet with a workbook (an upload made editable, or an agent's new file), in one
 * transaction: sheets with fresh ids and clean, distinct names, values, formats, merges, sizes, frozen panes and tab
 * colors, and formulas read in English against the new sheets (a formula that can't be read keeps the value the
 * file had for it). Sheets are at least 100 × 26 and grow to what their formulas point at. Throws `limit` past
 * `LIVE_LIMITS`, before changing anything.
 */
export function spreadsheetFromData(doc: Y.Doc, data: WorkbookData, origin: LiveOrigin): void {
  const sheets: SheetData[] =
    data.sheets.length > 0 ? data.sheets : [{ name: "Sheet 1", rows: DEFAULT_ROWS, cols: DEFAULT_COLS, cells: [] }];
  if (sheets.length > SHEET_LIMITS.sheets) {
    throw new SheetError("limit", `A spreadsheet holds at most ${SHEET_LIMITS.sheets} sheets`, [
      { max: SHEET_LIMITS.sheets },
    ]);
  }
  const grids = sheets.map(gridOf);
  const total = sheets.reduce((n, sheet) => n + sheet.cells.length, 0);
  if (total > SHEET_LIMITS.cells) {
    throw new SheetError("limit", `A spreadsheet holds at most ${SHEET_LIMITS.cells} cells`, [
      { max: SHEET_LIMITS.cells },
    ]);
  }
  doc.transact(() => {
    const order = sheetOrderArray(doc);
    if (order.length > 0) order.delete(0, order.length);
    const map = sheetsMap(doc);
    for (const key of [...map.keys()]) map.delete(key);
    const ids = sheets.map((sheet, i) => {
      const id = newId();
      const grid = grids[i] as { rows: number; cols: number };
      const name = uniqueSheetName(doc, cleanSheetName(sheet.name ?? "") || `Sheet ${i + 1}`);
      map.set(id, newSheetMap(name, grid.rows, grid.cols));
      order.push([id]);
      return id;
    });
    // Values and formats first, on every sheet, so formulas can name any of them.
    const formulas: { sheet: string; row: number; col: number; cell: SheetCellData }[] = [];
    sheets.forEach((sheet, i) => {
      const id = ids[i] as string;
      const parts = sheetParts(doc, id);
      const rows = parts.rows.toArray();
      const cols = parts.cols.toArray();
      for (const cell of sheet.cells) {
        const r = whole(cell.r);
        const c = whole(cell.c);
        if (r === null || c === null) continue;
        const key = cellKey(rows[r] as string, cols[c] as string);
        const s = cleanCellStyle(cell.s);
        if (typeof cell.f === "string" && cell.f.trim().length > 0) {
          formulas.push({ sheet: id, row: r, col: c, cell });
          if (s) writeCell(parts.cells, key, { s });
          continue;
        }
        if (cell.e && isErrorCode(cell.e)) writeCell(parts.cells, key, s ? { f: cell.e, s } : { f: cell.e });
        else {
          const v = cellValue(cell);
          writeCell(parts.cells, key, v === undefined ? (s ? { s } : undefined) : s ? { v, s } : { v });
        }
      }
      for (const m of sheet.merges ?? []) {
        const [r1, r2] = [whole(m.r1), whole(m.r2)];
        const [c1, c2] = [whole(m.c1), whole(m.c2)];
        if (r1 === null || r2 === null || c1 === null || c2 === null) continue;
        const top = Math.min(r1, r2);
        const left = Math.min(c1, c2);
        const bottom = Math.max(r1, r2);
        const right = Math.max(c1, c2);
        if (top === bottom && left === right) continue;
        const merge: Merge = {
          r1: rows[top] as string,
          c1: cols[left] as string,
          r2: rows[bottom] as string,
          c2: cols[right] as string,
        };
        parts.merges.set(cellKey(merge.r1, merge.c1), merge);
      }
      for (const [index, px] of Object.entries(sheet.colWidths ?? {})) {
        const col = cols[Number(index)];
        const size = sizeOf(px, MAX_COL_WIDTH, DEFAULT_COL_WIDTH);
        if (col !== undefined && size !== null) parts.colWidths.set(col, size);
      }
      for (const [index, px] of Object.entries(sheet.rowHeights ?? {})) {
        const row = rows[Number(index)];
        const size = sizeOf(px, MAX_ROW_HEIGHT, DEFAULT_ROW_HEIGHT);
        if (row !== undefined && size !== null) parts.rowHeights.set(row, size);
      }
      const frozenRows = Math.min(whole(sheet.frozen?.rows) ?? 0, rows.length);
      const frozenCols = Math.min(whole(sheet.frozen?.cols) ?? 0, cols.length);
      if (frozenRows > 0 || frozenCols > 0) parts.sheet.set("frozen", { rows: frozenRows, cols: frozenCols });
      if (isHexColor(sheet.tab)) parts.sheet.set("tab", sheet.tab);
    });
    // Formulas, read in English; a reference past a sheet's end grows it (within the limits) and is read again.
    const bySheet = new Map<string, typeof formulas>();
    for (const item of formulas) {
      const list = bySheet.get(item.sheet);
      if (list) list.push(item);
      else bySheet.set(item.sheet, [item]);
    }
    for (const [sheet, list] of bySheet) {
      const parts = sheetParts(doc, sheet);
      let rows = parts.rows.toArray();
      let cols = parts.cols.toArray();
      for (const { row, col, cell } of list) {
        const typed = (cell.f as string).trim();
        const text = typed.startsWith("=") ? typed : `=${typed}`;
        const key = cellKey(rows[row] as string, cols[col] as string);
        const s = cleanCellStyle(cell.s);
        let f: string | null = null;
        if (text.length <= SHEET_LIMITS.formulaChars) {
          let result = toCanonical(text, { doc, sheetId: sheet, locale: EN });
          if (result.ok && (result.needs || result.needsSheets)) {
            const needs: SheetNeeds = new Map();
            addNeeds(needs, sheet, result);
            if (growSheets(doc, needs)) {
              rows = parts.rows.toArray();
              cols = parts.cols.toArray();
              result = toCanonical(text, { doc, sheetId: sheet, locale: EN });
            }
          }
          if (result.ok && result.f.length <= CANONICAL_FORMULA_MAX) f = result.f;
        }
        if (f !== null) {
          writeCell(parts.cells, key, s ? { f, s } : { f });
          continue;
        }
        // The value the file had for it, so the sheet still looks as it did.
        const v = cellValue(cell);
        if (v !== undefined) writeCell(parts.cells, key, s ? { v, s } : { v });
        else if (cell.e && isErrorCode(cell.e)) writeCell(parts.cells, key, s ? { f: cell.e, s } : { f: cell.e });
        else {
          const shown = text.slice(0, SHEET_LIMITS.cellChars);
          writeCell(parts.cells, key, s ? { v: shown, s } : { v: shown });
        }
      }
    }
  }, origin);
}

/**
 * A sheet of the document as data: its non-empty cells (and formatted empty ones) in row order, formulas back in
 * English A1, values as computed, what each cell shows in English, and the sizes, merges, frozen panes and tab color
 * that differ from a new sheet's.
 */
export function sheetToData(doc: Y.Doc, sheetId: string, engine: SheetValues): SheetData {
  const rows = rowIds(doc, sheetId);
  const cols = colIds(doc, sheetId);
  const rowAt = indexOf(rows);
  const colAt = indexOf(cols);
  const cells: SheetCellData[] = [];
  for (const [key, raw] of cellsMap(doc, sheetId)?.entries() ?? []) {
    const ids = parseCellKey(key);
    if (!ids) continue;
    const r = rowAt.get(ids[0]);
    const c = colAt.get(ids[1]);
    if (r === undefined || c === undefined) continue;
    const cell = readCell(raw);
    if (!cell) continue;
    const out: SheetCellData = { r, c };
    if (cell.f !== undefined) {
      if (isErrorCode(cell.f)) out.e = cell.f;
      else {
        out.f = toDisplay(cell.f, { doc, sheetId, locale: EN }).replace(/^=/, "");
        const value = engine.value(sheetId, ids[0], ids[1]);
        if (isError(value)) out.e = value.error;
        else if (value !== null) out.v = value;
      }
    } else if (cell.v !== undefined) out.v = cell.v;
    if (cell.s) out.s = cell.s;
    if (out.v !== undefined || out.f !== undefined || out.e !== undefined) {
      out.t = engine.display(sheetId, ids[0], ids[1], EN);
    }
    cells.push(out);
  }
  cells.sort((a, b) => a.r - b.r || a.c - b.c);
  const data: SheetData = { name: sheetName(doc, sheetId), rows: rows.length, cols: cols.length, cells };
  const widths: Record<number, number> = {};
  colWidthList(doc, sheetId).forEach((w, i) => {
    if (w !== DEFAULT_COL_WIDTH) widths[i] = w;
  });
  if (Object.keys(widths).length > 0) data.colWidths = widths;
  const heights: Record<number, number> = {};
  rowHeightList(doc, sheetId).forEach((h, i) => {
    if (h !== DEFAULT_ROW_HEIGHT) heights[i] = h;
  });
  if (Object.keys(heights).length > 0) data.rowHeights = heights;
  const merges = readMerges(doc, sheetId).map(({ r1, c1, r2, c2 }) => ({ r1, c1, r2, c2 }));
  if (merges.length > 0) data.merges = merges;
  const frozen = frozenOf(doc, sheetId);
  if (frozen.rows > 0 || frozen.cols > 0) data.frozen = frozen;
  const tab = sheetTabColor(doc, sheetId);
  if (tab) data.tab = tab;
  return data;
}

/** The whole spreadsheet as data (exports): every sheet in order, formulas in English A1 with computed values. */
export function spreadsheetToData(doc: Y.Doc, engine: SheetValues): WorkbookData {
  return { sheets: sheetIds(doc).map((id) => sheetToData(doc, id, engine)) };
}
