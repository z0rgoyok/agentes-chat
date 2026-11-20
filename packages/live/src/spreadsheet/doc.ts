/**
 * The spreadsheet document (ADR 0196 §2): sheets in order (`sheetOrder`, `sheets`), each with its rows and columns as
 * arrays of ids and its cells in a map keyed `rowId:colId`. A cell is one plain object replaced whole, so the last
 * writer wins per cell; rows and columns are ids, so a row inserted by one person while another types below it moves
 * the second one's cell with its row. Column widths, row heights and merges are kept by id too; frozen panes are
 * counts of leading rows and columns.
 *
 * Readers here never assume a well-formed document: a document is shared state, so what a buggy or hostile client
 * wrote reads as empty instead of throwing, and the ids two people's concurrent moves can repeat are read once.
 */
import * as Y from "yjs";
import { type LiveEditCode, LiveEditError } from "../errors";
import { newId } from "../ids";
import type { SheetLocale } from "./locale";
import type { CellValue } from "./values";

export interface BorderSide {
  w: 1 | 2 | 3;
  c?: string;
}

export interface CellStyle {
  /** Bold, italic, underline, strikethrough (`x`). */
  b?: 1;
  i?: 1;
  u?: 1;
  x?: 1;
  /** Font and fill colors, `#rrggbb`. */
  fc?: string;
  bg?: string;
  ha?: "l" | "c" | "r";
  va?: "t" | "m" | "b";
  /** Wrap text. */
  w?: 1;
  /** Excel number format code; absent is General. */
  nf?: string;
  /** Font size in points. */
  fs?: number;
  bd?: { t?: BorderSide; r?: BorderSide; b?: BorderSide; l?: BorderSide };
}

export interface CellData {
  v?: number | string | boolean;
  /** Canonical formula (references by id, English names), without the "=". */
  f?: string;
  s?: CellStyle;
}

/** A merged block by its corner ids, kept under the key of its top-left cell. */
export interface Merge {
  r1: string;
  c1: string;
  r2: string;
  c2: string;
}

export const DEFAULT_COL_WIDTH = 100;
export const DEFAULT_ROW_HEIGHT = 24;
/** The default font: 10 points, drawn at 13 px. */
export const DEFAULT_FONT_PT = 10;
export const DEFAULT_FONT_PX = 13;
/** A new sheet's grid. */
export const DEFAULT_ROWS = 100;
export const DEFAULT_COLS = 26;
/** Excel refuses sheet names longer than this, so exports stay valid. */
export const SHEET_NAME_MAX = 31;
/** The sizes a column or row can be set to, in px. */
export const MIN_SIZE = 4;
export const MAX_COL_WIDTH = 2000;
export const MAX_ROW_HEIGHT = 1000;
/** Font sizes a cell can take, in points. */
export const MIN_FONT_PT = 6;
export const MAX_FONT_PT = 96;

export type SheetErrorCode =
  | "no_sheet"
  | "broken"
  | "limit"
  | "last_sheet"
  | "last_row"
  | "last_col"
  | "sheet_name"
  | "sheet_name_taken"
  | "merged"
  | "formula"
  | "text_too_long"
  | "formula_too_long"
  | "range"
  | "value";

const LIVE_CODES: Record<SheetErrorCode, LiveEditCode> = {
  no_sheet: "not_found",
  broken: "invalid",
  limit: "too_many",
  last_sheet: "invalid",
  last_row: "invalid",
  last_col: "invalid",
  sheet_name: "invalid",
  sheet_name_taken: "invalid",
  merged: "invalid",
  formula: "invalid",
  text_too_long: "too_large",
  formula_too_long: "too_large",
  range: "invalid",
  value: "invalid",
};

export interface SheetErrorDetail {
  /** The cell at fault, in A1 ("B2"). */
  cell?: string;
  /** Why a formula can't be read (`FormulaProblem`). */
  problem?: unknown;
  /** The limit that was passed. */
  max?: number;
}

/**
 * An edit the document can't take. It is a `LiveEditError` (its `code` is the package's generic one, so one catch
 * covers every kind of live file); `reason` says exactly why, and `details` where.
 */
export class SheetError extends LiveEditError {
  readonly reason: SheetErrorCode;
  readonly details?: SheetErrorDetail[];

  constructor(reason: SheetErrorCode, message: string, details?: SheetErrorDetail[]) {
    super(LIVE_CODES[reason], message);
    this.name = "SheetError";
    this.reason = reason;
    if (details) this.details = details;
  }
}

/** What edits read from a spreadsheet engine: computed values and their text. Any `SheetEngine` is one. */
export interface SheetValues {
  value(sheetId: string, rowId: string, colId: string): CellValue;
  display(sheetId: string, rowId: string, colId: string, locale: SheetLocale): string;
}

export function sheetsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>("sheets");
}

export function sheetOrderArray(doc: Y.Doc): Y.Array<string> {
  return doc.getArray<string>("sheetOrder");
}

export function cellKey(rowId: string, colId: string): string {
  return `${rowId}:${colId}`;
}

/** `rowId:colId` → its two ids; null for a malformed key. */
export function parseCellKey(key: string): [string, string] | null {
  const colon = key.indexOf(":");
  if (colon <= 0 || colon === key.length - 1 || key.indexOf(":", colon + 1) >= 0) return null;
  return [key.slice(0, colon), key.slice(colon + 1)];
}

/** A sheet's map, or null when there is no such sheet. */
export function sheetMap(doc: Y.Doc, sheetId: string): Y.Map<unknown> | null {
  const sheet = sheetsMap(doc).get(sheetId);
  return sheet instanceof Y.Map ? sheet : null;
}

function idList(value: unknown): string[] {
  if (!(value instanceof Y.Array)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of value.toArray()) {
    if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** The sheet's row ids, top to bottom. */
export function rowIds(doc: Y.Doc, sheetId: string): string[] {
  return idList(sheetMap(doc, sheetId)?.get("rows"));
}

/** The sheet's column ids, left to right. */
export function colIds(doc: Y.Doc, sheetId: string): string[] {
  return idList(sheetMap(doc, sheetId)?.get("cols"));
}

export function cellsMap(doc: Y.Doc, sheetId: string): Y.Map<CellData> | null {
  const cells = sheetMap(doc, sheetId)?.get("cells");
  return cells instanceof Y.Map ? (cells as Y.Map<CellData>) : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Whether `value` is a color a cell can hold: `#rgb` or `#rrggbb`. */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

function borderSideOf(value: unknown): BorderSide | undefined {
  if (!isPlainObject(value)) return undefined;
  const w = value.w;
  if (w !== 1 && w !== 2 && w !== 3) return undefined;
  return isHexColor(value.c) ? { w, c: value.c } : { w };
}

const ALIGN_H: readonly string[] = ["l", "c", "r"];
const ALIGN_V: readonly string[] = ["t", "m", "b"];
/** Longer than any format code Excel writes; a longer one is noise. */
export const NUMBER_FORMAT_MAX = 255;

/**
 * A style as the document may hold it: unknown keys and values out of shape are dropped, a General format is no
 * format, and an empty style is `undefined`. Always a fresh object, so changing it never touches the document.
 */
export function cleanCellStyle(raw: unknown): CellStyle | undefined {
  if (!isPlainObject(raw)) return undefined;
  const s: CellStyle = {};
  if (raw.b === 1 || raw.b === true) s.b = 1;
  if (raw.i === 1 || raw.i === true) s.i = 1;
  if (raw.u === 1 || raw.u === true) s.u = 1;
  if (raw.x === 1 || raw.x === true) s.x = 1;
  if (raw.w === 1 || raw.w === true) s.w = 1;
  if (isHexColor(raw.fc)) s.fc = raw.fc;
  if (isHexColor(raw.bg)) s.bg = raw.bg;
  if (typeof raw.ha === "string" && ALIGN_H.includes(raw.ha)) s.ha = raw.ha as CellStyle["ha"];
  if (typeof raw.va === "string" && ALIGN_V.includes(raw.va)) s.va = raw.va as CellStyle["va"];
  if (
    typeof raw.nf === "string" &&
    raw.nf.length > 0 &&
    raw.nf.length <= NUMBER_FORMAT_MAX &&
    raw.nf.toLowerCase() !== "general"
  ) {
    s.nf = raw.nf;
  }
  if (typeof raw.fs === "number" && Number.isFinite(raw.fs) && raw.fs >= MIN_FONT_PT && raw.fs <= MAX_FONT_PT) {
    s.fs = raw.fs;
  }
  if (isPlainObject(raw.bd)) {
    const bd: NonNullable<CellStyle["bd"]> = {};
    for (const side of ["t", "r", "b", "l"] as const) {
      const value = borderSideOf(raw.bd[side]);
      if (value) bd[side] = value;
    }
    if (bd.t || bd.r || bd.b || bd.l) s.bd = bd;
  }
  return Object.keys(s).length > 0 ? s : undefined;
}

/** A stored cell as data, or undefined when it is missing, malformed or empty. Always a fresh object. */
export function readCell(raw: unknown): CellData | undefined {
  if (!isPlainObject(raw)) return undefined;
  const cell: CellData = {};
  const v = raw.v;
  if (typeof raw.f === "string" && raw.f.length > 0) cell.f = raw.f;
  else if (typeof v === "number") {
    if (Number.isFinite(v)) cell.v = v;
  } else if ((typeof v === "string" && v.length > 0) || typeof v === "boolean") cell.v = v;
  const s = cleanCellStyle(raw.s);
  if (s) cell.s = s;
  return cell.v !== undefined || cell.f !== undefined || cell.s ? cell : undefined;
}

/** Whether a cell holds nothing: no value, no formula, no style. */
export function isEmptyCell(cell: CellData | undefined): boolean {
  return !cell || (cell.v === undefined && cell.f === undefined && !cell.s);
}

/** Deep equality of plain JSON values (cells and styles), whatever order their keys were written in. */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameData(x, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => sameData(ra[k], rb[k]));
}

/** The cell at row and column ids, or undefined when empty. */
export function cellAt(doc: Y.Doc, sheetId: string, rowId: string, colId: string): CellData | undefined {
  return readCell(cellsMap(doc, sheetId)?.get(cellKey(rowId, colId)));
}

/** The cell at row and column indexes, or undefined when empty or outside the grid. */
export function getCell(doc: Y.Doc, sheetId: string, row: number, col: number): CellData | undefined {
  const r = rowIds(doc, sheetId)[row];
  const c = colIds(doc, sheetId)[col];
  return r !== undefined && c !== undefined ? cellAt(doc, sheetId, r, c) : undefined;
}

/**
 * The sheets in order. Ids repeated by two people moving the same sheet at once are read once, ids whose sheet is gone
 * are skipped, and a sheet missing from the order (it can't be reached otherwise) is read at the end.
 */
export function sheetIds(doc: Y.Doc): string[] {
  const sheets = sheetsMap(doc);
  const ids = idList(sheetOrderArray(doc)).filter((id) => sheets.get(id) instanceof Y.Map);
  if (ids.length < sheets.size) {
    const listed = new Set(ids);
    const missing = [...sheets.keys()].filter((id) => !listed.has(id) && sheets.get(id) instanceof Y.Map).sort();
    ids.push(...missing);
  }
  return ids;
}

/** A sheet's name ("" when there is no such sheet). */
export function sheetName(doc: Y.Doc, sheetId: string): string {
  const name = sheetMap(doc, sheetId)?.get("name");
  return typeof name === "string" ? name : "";
}

/** The first sheet with this name, compared case-insensitively as Excel does; null when none. */
export function sheetByName(doc: Y.Doc, name: string): string | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  for (const id of sheetIds(doc)) if (sheetName(doc, id).trim().toLowerCase() === wanted) return id;
  return null;
}

/** A sheet tab's color, if it has one. */
export function sheetTabColor(doc: Y.Doc, sheetId: string): string | undefined {
  const tab = sheetMap(doc, sheetId)?.get("tab");
  return isHexColor(tab) ? tab : undefined;
}

export function sheetSize(doc: Y.Doc, sheetId: string): { rows: number; cols: number } {
  return { rows: rowIds(doc, sheetId).length, cols: colIds(doc, sheetId).length };
}

/** Frozen leading rows and columns, within the sheet's size. */
export function frozenOf(doc: Y.Doc, sheetId: string): { rows: number; cols: number } {
  const raw = sheetMap(doc, sheetId)?.get("frozen");
  const size = sheetSize(doc, sheetId);
  const count = (v: unknown, max: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(Math.floor(v), max)) : 0;
  if (!isPlainObject(raw)) return { rows: 0, cols: 0 };
  return { rows: count(raw.rows, size.rows), cols: count(raw.cols, size.cols) };
}

/** A sheet's `colWidths` or `rowHeights` map, or null when missing. */
export function sizeMap(doc: Y.Doc, sheetId: string, key: "colWidths" | "rowHeights"): Y.Map<number> | null {
  const map = sheetMap(doc, sheetId)?.get(key);
  return map instanceof Y.Map ? (map as Y.Map<number>) : null;
}

function readSize(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A column's width in px (the default when unset). */
export function colWidth(doc: Y.Doc, sheetId: string, colId: string): number {
  return readSize(sizeMap(doc, sheetId, "colWidths")?.get(colId), DEFAULT_COL_WIDTH);
}

/** A row's height in px (the default when unset). */
export function rowHeight(doc: Y.Doc, sheetId: string, rowId: string): number {
  return readSize(sizeMap(doc, sheetId, "rowHeights")?.get(rowId), DEFAULT_ROW_HEIGHT);
}

/** Every column's width in order. */
export function colWidths(doc: Y.Doc, sheetId: string): number[] {
  const map = sizeMap(doc, sheetId, "colWidths");
  return colIds(doc, sheetId).map((id) => readSize(map?.get(id), DEFAULT_COL_WIDTH));
}

/** Every row's height in order. */
export function rowHeights(doc: Y.Doc, sheetId: string): number[] {
  const map = sizeMap(doc, sheetId, "rowHeights");
  return rowIds(doc, sheetId).map((id) => readSize(map?.get(id), DEFAULT_ROW_HEIGHT));
}

export interface MergeRange {
  /** The merge's key in the document (its top-left cell's key when written here). */
  key: string;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** Index lookups for a sheet's rows and columns. */
export function indexOf(ids: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) map.set(ids[i] as string, i);
  return map;
}

export function mergesMap(doc: Y.Doc, sheetId: string): Y.Map<Merge> | null {
  const merges = sheetMap(doc, sheetId)?.get("merges");
  return merges instanceof Y.Map ? (merges as Y.Map<Merge>) : null;
}

/** A stored merge's corner ids, or null when malformed. */
export function readMerge(raw: unknown): Merge | null {
  if (!isPlainObject(raw)) return null;
  const { r1, c1, r2, c2 } = raw;
  if (typeof r1 !== "string" || typeof c1 !== "string" || typeof r2 !== "string" || typeof c2 !== "string") {
    return null;
  }
  return { r1, c1, r2, c2 };
}

/**
 * The sheet's merged blocks in index space. Merges whose rows or columns are gone, single cells and blocks overlapping
 * an earlier one (by key, so every device keeps the same) are left out.
 */
export function readMerges(doc: Y.Doc, sheetId: string): MergeRange[] {
  const raw = mergesMap(doc, sheetId);
  if (!raw) return [];
  const rows = indexOf(rowIds(doc, sheetId));
  const cols = indexOf(colIds(doc, sheetId));
  const found: MergeRange[] = [];
  for (const key of [...raw.keys()].sort()) {
    const m = readMerge(raw.get(key));
    if (!m) continue;
    const a = rows.get(m.r1);
    const b = rows.get(m.r2);
    const c = cols.get(m.c1);
    const d = cols.get(m.c2);
    if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
    const range = { key, r1: Math.min(a, b), r2: Math.max(a, b), c1: Math.min(c, d), c2: Math.max(c, d) };
    if (range.r1 === range.r2 && range.c1 === range.c2) continue;
    if (found.some((f) => f.r1 <= range.r2 && range.r1 <= f.r2 && f.c1 <= range.c2 && range.c1 <= f.c2)) continue;
    found.push(range);
  }
  return found;
}

const FORBIDDEN_IN_NAMES = new Set(["[", "]", ":", "*", "?", "/", "\\"]);

/**
 * Removes what Excel forbids in sheet names (`[]:*?/\` and control characters), outer apostrophes and extra spaces;
 * at most 31 characters.
 */
export function cleanSheetName(name: string): string {
  let spaced = "";
  for (const c of name) spaced += FORBIDDEN_IN_NAMES.has(c) || c.charCodeAt(0) < 32 ? " " : c;
  return withoutOuterApostrophes(spaced.replace(/\s+/g, " ").trim()).trim().slice(0, SHEET_NAME_MAX).trim();
}

/** `text` without the apostrophes it starts and ends with, by index (`/'+$/` rescans each run of them: quadratic). */
function withoutOuterApostrophes(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charAt(start) === "'") start++;
  while (end > start && text.charAt(end - 1) === "'") end--;
  return text.slice(start, end);
}

/** `name`, or `name (2)`, `name (3)`… when another sheet has it (case-insensitively). */
export function uniqueSheetName(doc: Y.Doc, name: string, except?: string): string {
  const taken = new Set(
    sheetIds(doc)
      .filter((id) => id !== except)
      .map((id) => sheetName(doc, id).trim().toLowerCase()),
  );
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = `${name.slice(0, SHEET_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * The name the next new sheet gets: `base` and the first number no sheet uses ("Planilha 2" when "Planilha 1" is
 * there). `base` is the word in the person's language ("Planilha", "Sheet").
 */
export function nextSheetName(doc: Y.Doc, base: string): string {
  const word =
    cleanSheetName(base)
      .slice(0, SHEET_NAME_MAX - 4)
      .trim() || "Sheet";
  const ids = sheetIds(doc);
  const taken = new Set(ids.map((id) => sheetName(doc, id).trim().toLowerCase()));
  for (let n = ids.length + 1; ; n++) {
    const candidate = `${word} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** A new sheet's map, ready to set into `sheets`: rows and columns with the given ids, or fresh ones. */
export function newSheetMap(
  name: string,
  rows: number | readonly string[],
  cols: number | readonly string[],
): Y.Map<unknown> {
  const sheet = new Y.Map<unknown>();
  sheet.set("name", name);
  const rowArray = new Y.Array<string>();
  rowArray.push(typeof rows === "number" ? Array.from({ length: rows }, () => newId()) : [...rows]);
  const colArray = new Y.Array<string>();
  colArray.push(typeof cols === "number" ? Array.from({ length: cols }, () => newId()) : [...cols]);
  sheet.set("rows", rowArray);
  sheet.set("cols", colArray);
  sheet.set("cells", new Y.Map<CellData>());
  sheet.set("colWidths", new Y.Map<number>());
  sheet.set("rowHeights", new Y.Map<number>());
  sheet.set("merges", new Y.Map<Merge>());
  sheet.set("frozen", { rows: 0, cols: 0 });
  return sheet;
}

/** The writable parts of a sheet. */
export interface SheetParts {
  sheet: Y.Map<unknown>;
  rows: Y.Array<string>;
  cols: Y.Array<string>;
  cells: Y.Map<CellData>;
  colWidths: Y.Map<number>;
  rowHeights: Y.Map<number>;
  merges: Y.Map<Merge>;
}

function partOf<T>(sheet: Y.Map<unknown>, key: string, make: () => T, ok: (v: unknown) => boolean): T {
  const value = sheet.get(key);
  if (ok(value)) return value as T;
  const made = make();
  sheet.set(key, made);
  return made;
}

/**
 * A sheet's parts for writing. A part a broken client left missing or of the wrong type is set up again (empty), and
 * an id array holding repeated or foreign entries is rewritten to the order readers see, so indexes in edits always
 * match `rowIds`/`colIds`. Call inside a transaction. Throws `no_sheet` for a sheet that isn't there.
 */
export function sheetParts(doc: Y.Doc, sheetId: string): SheetParts {
  const sheet = sheetMap(doc, sheetId);
  if (!sheet) throw new SheetError("no_sheet", `There is no sheet ${sheetId}`);
  const isArray = (v: unknown) => v instanceof Y.Array;
  const isMap = (v: unknown) => v instanceof Y.Map;
  const rows = partOf(sheet, "rows", () => new Y.Array<string>(), isArray);
  const cols = partOf(sheet, "cols", () => new Y.Array<string>(), isArray);
  for (const array of [rows, cols]) {
    const clean = idList(array);
    if (clean.length !== array.length) {
      array.delete(0, array.length);
      array.push(clean);
    }
  }
  return {
    sheet,
    rows,
    cols,
    cells: partOf(sheet, "cells", () => new Y.Map<CellData>(), isMap),
    colWidths: partOf(sheet, "colWidths", () => new Y.Map<number>(), isMap),
    rowHeights: partOf(sheet, "rowHeights", () => new Y.Map<number>(), isMap),
    merges: partOf(sheet, "merges", () => new Y.Map<Merge>(), isMap),
  };
}

/** Every cell the document holds, across its sheets (what `LIVE_LIMITS.spreadsheet.cells` counts). */
export function cellCount(doc: Y.Doc): number {
  let n = 0;
  for (const sheet of sheetsMap(doc).values()) {
    const cells = sheet instanceof Y.Map ? sheet.get("cells") : null;
    if (cells instanceof Y.Map) n += cells.size;
  }
  return n;
}

/**
 * A new spreadsheet's content: one sheet (named by the caller in the person's language, "Planilha 1" or "Sheet 1")
 * of 100 rows by 26 columns with fresh ids. Does nothing when the document already has sheets. `initLiveDoc` sets the
 * meta.
 */
export function initSpreadsheet(doc: Y.Doc, sheetName = "Sheet 1", origin: unknown = null): void {
  doc.transact(() => {
    if (sheetIds(doc).length > 0) return;
    const id = newId();
    sheetsMap(doc).set(id, newSheetMap(cleanSheetName(sheetName) || "Sheet 1", DEFAULT_ROWS, DEFAULT_COLS));
    sheetOrderArray(doc).push([id]);
  }, origin);
}
