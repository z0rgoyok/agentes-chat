/**
 * What every spreadsheet edit shares (ADR 0196 §2): ranges in index space, growing a sheet within `LIVE_LIMITS`,
 * writing a cell only when it changes, and reading what a person typed into the cell it makes (formulas turned into
 * their canonical form by ids). Edits check everything before they write: a Yjs transaction can't be rolled back, so
 * a refused edit must leave the document as it was.
 */
import type * as Y from "yjs";
import { newId } from "../ids";
import { LIVE_LIMITS } from "../limits";
import { formatA1 } from "./a1";
import {
  type CellData,
  type CellStyle,
  cellCount,
  cleanCellStyle,
  SheetError,
  type SheetParts,
  sameData,
  sheetParts,
  sheetSize,
} from "./doc";
import { formatKind, NUMBER_FORMATS } from "./format";
import { type Ast, type FormulaProblem, parseStored, toCanonical } from "./formula";
import { parseInput } from "./input";
import type { SheetLocale } from "./locale";

export const SHEET_LIMITS = LIVE_LIMITS.spreadsheet;

/**
 * The longest formula a cell keeps, as stored (`LIVE_LIMITS.spreadsheet.formulaChars`, Excel's 8,192): the formula
 * engine refuses a typed formula whose canonical form is longer, and the rules of shape a stored one.
 */
export const CANONICAL_FORMULA_MAX = SHEET_LIMITS.formulaChars;

/** One cell by its sheet and 0-based row and column. */
export interface CellAt {
  sheet: string;
  row: number;
  col: number;
}

/** A cell range in index space (0-based, inclusive) on a sheet. */
export interface RangeIds {
  sheet: string;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

function isIndex(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/** Throws `range` unless `n` is a 0-based index. */
export function checkIndex(n: number, what: string): void {
  if (!isIndex(n)) throw new SheetError("range", `${what} must be a whole number from 0, not ${n}`);
}

/** A range with its corners in order (r1 ≤ r2, c1 ≤ c2); throws `range` for indexes that aren't whole numbers. */
export function normalizeRange(range: RangeIds): RangeIds {
  for (const [what, n] of [
    ["r1", range.r1],
    ["c1", range.c1],
    ["r2", range.r2],
    ["c2", range.c2],
  ] as const) {
    checkIndex(n, what);
  }
  return {
    sheet: range.sheet,
    r1: Math.min(range.r1, range.r2),
    c1: Math.min(range.c1, range.c2),
    r2: Math.max(range.r1, range.r2),
    c2: Math.max(range.c1, range.c2),
  };
}

/** A range cut to the sheet's grid (whole columns read as far as the sheet goes); null when it lies outside it. */
export function clampRange(doc: Y.Doc, range: RangeIds): RangeIds | null {
  const r = normalizeRange(range);
  const size = sheetSize(doc, r.sheet);
  if (r.r1 >= size.rows || r.c1 >= size.cols) return null;
  return { ...r, r2: Math.min(r.r2, size.rows - 1), c2: Math.min(r.c2, size.cols - 1) };
}

/** Whether two ranges share a cell. */
export function overlaps(
  a: { r1: number; c1: number; r2: number; c2: number },
  b: { r1: number; c1: number; r2: number; c2: number },
): boolean {
  return a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;
}

/** Grows a sheet to at least `rows` × `cols` with fresh ids; throws `limit` past `LIVE_LIMITS`. Inside a transaction. */
export function growTo(parts: SheetParts, rows: number, cols: number): void {
  checkSize(rows, cols);
  if (parts.rows.length < rows) parts.rows.push(Array.from({ length: rows - parts.rows.length }, () => newId()));
  if (parts.cols.length < cols) parts.cols.push(Array.from({ length: cols - parts.cols.length }, () => newId()));
}

/** Throws `limit` when a sheet of `rows` × `cols` would pass `LIVE_LIMITS`. */
export function checkSize(rows: number, cols: number): void {
  if (rows > SHEET_LIMITS.rows) {
    throw new SheetError("limit", `A sheet holds at most ${SHEET_LIMITS.rows} rows`, [{ max: SHEET_LIMITS.rows }]);
  }
  if (cols > SHEET_LIMITS.cols) {
    throw new SheetError("limit", `A sheet holds at most ${SHEET_LIMITS.cols} columns`, [{ max: SHEET_LIMITS.cols }]);
  }
}

/** Throws `limit` when `extra` new cells would take the document past `LIVE_LIMITS.spreadsheet.cells`. */
export function checkCellRoom(doc: Y.Doc, extra: number): void {
  if (extra <= 0) return;
  if (cellCount(doc) + extra > SHEET_LIMITS.cells) {
    throw new SheetError("limit", `A spreadsheet holds at most ${SHEET_LIMITS.cells} cells`, [
      { max: SHEET_LIMITS.cells },
    ]);
  }
}

/** A cell as it should be stored: no empty parts, a formula never with a value, `undefined` when nothing is left. */
export function tidyCell(cell: CellData | undefined): CellData | undefined {
  if (!cell) return undefined;
  const out: CellData = {};
  if (typeof cell.f === "string" && cell.f.length > 0) out.f = cell.f;
  else if (typeof cell.v === "number") {
    if (Number.isFinite(cell.v)) out.v = Object.is(cell.v, -0) ? 0 : cell.v;
  } else if ((typeof cell.v === "string" && cell.v.length > 0) || typeof cell.v === "boolean") out.v = cell.v;
  const s = cleanCellStyle(cell.s);
  if (s) out.s = s;
  return out.v !== undefined || out.f !== undefined || out.s ? out : undefined;
}

/** Writes a cell (or removes it when empty) unless it already holds exactly that; returns whether it changed. */
export function writeCell(cells: Y.Map<CellData>, key: string, cell: CellData | undefined): boolean {
  const next = tidyCell(cell);
  if (!next) {
    if (!cells.has(key)) return false;
    cells.delete(key);
    return true;
  }
  if (sameData(cells.get(key), next)) return false;
  cells.set(key, next);
  return true;
}

/** A cell's style after typing a value that implies a format: General takes it, so does a format of another kind. */
export function styleAfterInput(style: CellStyle | undefined, implied: string | undefined): CellStyle | undefined {
  if (!implied) return style;
  const current = style?.nf;
  if (current && formatKind(current) === formatKind(implied)) return style;
  return { ...style, nf: implied };
}

/** Formulas whose result is a date or a time get its format, as in Excel (`=TODAY()` shows a date, not 46343). */
const DATE_FUNCTIONS = new Set(["TODAY", "DATE", "EDATE", "EOMONTH", "DATEVALUE", "WORKDAY", "WORKDAY.INTL"]);
const TIME_FUNCTIONS = new Set(["TIME", "TIMEVALUE"]);

/** The number format a formula's result implies (`=TODAY()` → a date), if any. */
export function formulaFormat(f: string, locale: SheetLocale): string | undefined {
  let ast: Ast;
  try {
    ast = parseStored(f);
  } catch {
    return undefined;
  }
  while (ast.t === "paren") ast = ast.a;
  if (ast.t !== "call") return undefined;
  if (DATE_FUNCTIONS.has(ast.fn)) return NUMBER_FORMATS.date(locale);
  if (ast.fn === "NOW") return NUMBER_FORMATS.datetime(locale);
  if (TIME_FUNCTIONS.has(ast.fn)) return NUMBER_FORMATS.time(locale);
  return undefined;
}

/** A grid size a sheet must grow to, so the references of a formula land. */
export interface Needs {
  rows: number;
  cols: number;
}

/** What formulas being written need, by sheet id. */
export type SheetNeeds = Map<string, Needs>;

/** Adds what a formula needs (its own sheet's `needs`, other sheets' `needsSheets`) to `into`. */
export function addNeeds(
  into: SheetNeeds,
  sheetId: string,
  plan: { needs?: Needs; needsSheets?: Record<string, Needs> },
): void {
  const add = (id: string, n: Needs) => {
    const had = into.get(id);
    into.set(id, { rows: Math.max(had?.rows ?? 0, n.rows), cols: Math.max(had?.cols ?? 0, n.cols) });
  };
  if (plan.needs) add(sheetId, plan.needs);
  for (const [id, n] of Object.entries(plan.needsSheets ?? {})) add(id, n);
}

/**
 * Grows each sheet to what formulas need, within `LIVE_LIMITS` (a reference past them stays `#REF!`). Inside a
 * transaction; returns whether any sheet grew (then the formulas are read again).
 */
export function growSheets(doc: Y.Doc, needs: SheetNeeds): boolean {
  let grew = false;
  for (const [id, n] of needs) {
    const size = sheetSize(doc, id);
    const rows = Math.max(size.rows, Math.min(n.rows, SHEET_LIMITS.rows));
    const cols = Math.max(size.cols, Math.min(n.cols, SHEET_LIMITS.cols));
    if (rows === size.rows && cols === size.cols) continue;
    let parts: SheetParts;
    try {
      parts = sheetParts(doc, id);
    } catch {
      continue;
    }
    growTo(parts, rows, cols);
    grew = true;
  }
  return grew;
}

export type TypedFormula =
  | { ok: true; f: string; needs?: Needs; needsSheets?: Record<string, Needs> }
  | { ok: false; error: FormulaProblem };

/**
 * A formula as typed ("=SOMA(B2:B9;C1)") in its canonical form, refused past the length limits. `needs` (and
 * `needsSheets` for other sheets) is the grid size its references reach past a sheet's end: the caller grows the
 * sheets and reads the formula again.
 */
export function canonicalFormula(doc: Y.Doc, sheetId: string, typed: string, locale: SheetLocale): TypedFormula {
  if (typed.length > SHEET_LIMITS.formulaChars + 64) return { ok: false, error: { code: "too_long", at: 0 } };
  const result = toCanonical(typed, { doc, sheetId, locale });
  if (!result.ok) return { ok: false, error: result.error };
  if (result.f.length > CANONICAL_FORMULA_MAX) return { ok: false, error: { code: "too_long", at: 0 } };
  const out: TypedFormula = { ok: true, f: result.f };
  if (result.needs) out.needs = result.needs;
  if (result.needsSheets) out.needsSheets = result.needsSheets;
  return out;
}

export type InputPlan =
  | { ok: true; cell: CellData | undefined; needs?: Needs; needsSheets?: Record<string, Needs> }
  | { ok: false; error: FormulaProblem };

export interface InputOptions {
  /** The year for dates typed without one. */
  now?: Date;
  /** Cut text past `LIVE_LIMITS.spreadsheet.cellChars` instead of refusing it (pastes and imports). */
  truncate?: boolean;
  /** Keep the cell's style exactly (no format implied by the input). */
  keepStyle?: boolean;
  /**
   * Excel's automatic percent entry, for a person typing into a cell formatted as a percentage: a plain number of 1 or
   * more is that many percent ("10" is 10%), a smaller one is read as it is ("0.1" is also 10%).
   */
  percentEntry?: boolean;
}

/**
 * The cell that typing `text` into a cell holding `current` makes (ADR 0196 §2): a formula in the person's language,
 * a number, percent, currency or date read in their locale (with the format it implies), TRUE/FALSE in either
 * language, text (a leading apostrophe keeps anything as text), or nothing for "". A cell formatted as text (`@`)
 * keeps what was typed as text, as in Excel. The cell's style is kept. Throws `text_too_long` past the limit.
 */
export function planInput(
  doc: Y.Doc,
  sheetId: string,
  text: string,
  locale: SheetLocale,
  current: CellData | undefined,
  opts: InputOptions = {},
): InputPlan {
  const style = current?.s;
  const keep = (cell: CellData): CellData => (style ? { ...cell, s: style } : cell);
  if (text.length === 0) return { ok: true, cell: style ? { s: style } : undefined };
  const value = (v: string): string => {
    if (v.length <= SHEET_LIMITS.cellChars) return v;
    if (opts.truncate) return v.slice(0, SHEET_LIMITS.cellChars);
    throw new SheetError("text_too_long", `A cell holds at most ${SHEET_LIMITS.cellChars} characters`, [
      { max: SHEET_LIMITS.cellChars },
    ]);
  };
  if (style?.nf === "@") {
    const v = value(text.startsWith("'") ? text.slice(1) : text);
    return { ok: true, cell: v ? keep({ v }) : style ? { s: style } : undefined };
  }
  const parsed = parseInput(text, locale, opts.now ? { now: opts.now } : undefined);
  if (parsed.f !== undefined) {
    const result = canonicalFormula(doc, sheetId, parsed.f, locale);
    if (!result.ok) return result;
    const implied = opts.keepStyle || style?.nf ? undefined : formulaFormat(result.f, locale);
    const s = implied ? { ...style, nf: implied } : style;
    const plan: InputPlan = { ok: true, cell: s ? { f: result.f, s } : { f: result.f } };
    if (result.needs) plan.needs = result.needs;
    if (result.needsSheets) plan.needsSheets = result.needsSheets;
    return plan;
  }
  if (parsed.v === undefined) return { ok: true, cell: style ? { s: style } : undefined };
  let v = typeof parsed.v === "string" ? value(parsed.v) : parsed.v;
  if (
    opts.percentEntry &&
    typeof v === "number" &&
    parsed.nf === undefined &&
    Math.abs(v) >= 1 &&
    formatKind(style?.nf) === "percent"
  ) {
    v = Number((v / 100).toPrecision(15));
  }
  const s = opts.keepStyle ? style : styleAfterInput(style, parsed.nf);
  return { ok: true, cell: s ? { v, s } : { v } };
}

/** A cell's A1 name for messages ("B2"). */
export function cellName(row: number, col: number): string {
  return formatA1(row, col);
}
