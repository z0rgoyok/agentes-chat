/**
 * What a spreadsheet looks like from outside (ADR 0196 §7): the small preview cards, the Drive and message cards draw
 * (the first sheet's top-left cells as they show), and the text search finds the file by. Both read computed values
 * through the engine, since values are never stored.
 */
import type * as Y from "yjs";
import {
  cellKey,
  cellsMap,
  colIds,
  colWidth,
  indexOf,
  parseCellKey,
  readCell,
  rowIds,
  type SheetValues,
  sheetIds,
  sheetName,
} from "./doc";
import { type SheetLocale, sheetLocale } from "./locale";
import { isError } from "./values";

/** The first sheet's top-left cells as they show: what a file's card draws. */
export interface SheetPreview {
  /** The first sheet's name. */
  sheet: string;
  /** How many sheets the file has. */
  sheets: number;
  /** What each cell shows, top-left 12 rows by 8 columns (fewer when the sheet is smaller). */
  rows: string[][];
  /** The widths of those columns, in px. */
  widths: number[];
  bold: boolean[][];
  /** Where each cell's text sits: its own alignment, else numbers right, booleans and errors centered, text left. */
  align?: ("l" | "c" | "r")[][];
}

export const PREVIEW_ROWS = 12;
export const PREVIEW_COLS = 8;
/** The most of a cell's text a preview keeps. */
const PREVIEW_CHARS = 64;
/** The most search text a spreadsheet gives. */
export const SPREADSHEET_TEXT_MAX = 20_000;

/** The preview of a spreadsheet's first sheet in a reader's locale. */
export function spreadsheetPreview(doc: Y.Doc, engine: SheetValues, locale: SheetLocale): SheetPreview {
  const ids = sheetIds(doc);
  const first = ids[0];
  if (first === undefined) return { sheet: "", sheets: 0, rows: [], widths: [], bold: [], align: [] };
  const rows = rowIds(doc, first).slice(0, PREVIEW_ROWS);
  const cols = colIds(doc, first).slice(0, PREVIEW_COLS);
  const map = cellsMap(doc, first);
  const text: string[][] = [];
  const bold: boolean[][] = [];
  const align: ("l" | "c" | "r")[][] = [];
  for (const rowId of rows) {
    const line: string[] = [];
    const strong: boolean[] = [];
    const sides: ("l" | "c" | "r")[] = [];
    for (const colId of cols) {
      const cell = readCell(map?.get(cellKey(rowId, colId)));
      let shown = "";
      let side: "l" | "c" | "r" = "l";
      if (cell && (cell.v !== undefined || cell.f !== undefined)) {
        shown = engine.display(first, rowId, colId, locale).slice(0, PREVIEW_CHARS);
        const value = engine.value(first, rowId, colId);
        side = typeof value === "number" ? "r" : typeof value === "boolean" || isError(value) ? "c" : "l";
      }
      line.push(shown);
      strong.push(cell?.s?.b === 1);
      sides.push(cell?.s?.ha ?? side);
    }
    text.push(line);
    bold.push(strong);
    align.push(sides);
  }
  return {
    sheet: sheetName(doc, first),
    sheets: ids.length,
    rows: text,
    widths: cols.map((id) => colWidth(doc, first, id)),
    bold,
    align,
  };
}

/**
 * The text search finds a spreadsheet by: each sheet's name, then its cells as they show (in English unless a locale
 * is given), a row per line with cells apart by tabs, up to 20,000 characters.
 */
export function spreadsheetText(doc: Y.Doc, engine: SheetValues, locale: SheetLocale = sheetLocale("en-US")): string {
  let out = "";
  for (const sheet of sheetIds(doc)) {
    out += `${sheetName(doc, sheet)}\n`;
    if (out.length >= SPREADSHEET_TEXT_MAX) break;
    const map = cellsMap(doc, sheet);
    if (!map || map.size === 0) continue;
    const rows = rowIds(doc, sheet);
    const rowAt = indexOf(rows);
    const colAt = indexOf(colIds(doc, sheet));
    const byRow = new Map<number, { col: number; rowId: string; colId: string }[]>();
    for (const [key, raw] of map.entries()) {
      const ids = parseCellKey(key);
      if (!ids) continue;
      const r = rowAt.get(ids[0]);
      const c = colAt.get(ids[1]);
      const cell = readCell(raw);
      if (r === undefined || c === undefined || !cell || (cell.v === undefined && cell.f === undefined)) continue;
      const list = byRow.get(r);
      const entry = { col: c, rowId: ids[0], colId: ids[1] };
      if (list) list.push(entry);
      else byRow.set(r, [entry]);
    }
    for (const r of [...byRow.keys()].sort((a, b) => a - b)) {
      const line = (byRow.get(r) ?? [])
        .sort((a, b) => a.col - b.col)
        .map((e) => engine.display(sheet, e.rowId, e.colId, locale))
        .filter((t) => t.length > 0)
        .join("\t");
      if (line.length === 0) continue;
      out += `${line}\n`;
      if (out.length >= SPREADSHEET_TEXT_MAX) break;
    }
    if (out.length >= SPREADSHEET_TEXT_MAX) break;
  }
  return out.slice(0, SPREADSHEET_TEXT_MAX).trimEnd();
}
