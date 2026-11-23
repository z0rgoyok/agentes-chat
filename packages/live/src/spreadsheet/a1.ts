/**
 * A1 addresses (ADR 0196): how people and agents name cells and ranges ("B2", "A1:C9", "'Sheet 2'!B:B"). The document
 * itself keeps rows and columns by id; A1 is worked out from their current order. Rows and columns here are 0-based
 * indexes.
 */
import { LIVE_LIMITS } from "../limits";

/** Excel's own grid, the largest address A1 can spell. */
export const MAX_A1_ROWS = 1_048_576;
export const MAX_A1_COLS = 16_384;

/** 0 → "A", 25 → "Z", 26 → "AA", 701 → "ZZ", 702 → "AAA". */
export function colName(index: number): string {
  let n = Math.floor(index);
  if (!(n >= 0)) return "";
  let name = "";
  n += 1;
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** "A" → 0, "AA" → 26, case-insensitive; -1 when the text isn't a column name within Excel's 16,384 columns. */
export function colIndexOf(name: string): number {
  if (name.length === 0 || name.length > 3) return -1;
  let n = 0;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i) & ~32;
    if (c < 65 || c > 90) return -1;
    n = n * 26 + (c - 64);
  }
  return n <= MAX_A1_COLS ? n - 1 : -1;
}

export interface A1Ref {
  row: number;
  col: number;
  absRow: boolean;
  absCol: boolean;
}

const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9][0-9]{0,6})$/;

/** "B2", "$B$2", "b2" → row 1, col 1; null when it isn't one cell's address. */
export function parseA1(ref: string): A1Ref | null {
  const m = CELL.exec(ref.trim());
  if (!m) return null;
  const col = colIndexOf(m[2] ?? "");
  const row = Number(m[4]) - 1;
  if (col < 0 || row >= MAX_A1_ROWS) return null;
  return { row, col, absRow: m[3] === "$", absCol: m[1] === "$" };
}

export interface A1Range {
  /** The sheet's name when the text named one ("Sheet 2!A1", "'My sheet'!B2:C3"). */
  sheet?: string;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  /**
   * Whole columns ("B:C": every row, `r2` is the last row a sheet can have) or whole rows ("3:5": every column);
   * callers clamp to the sheet's size.
   */
  whole?: "rows" | "cols";
}

const COLS = /^\$?([A-Za-z]{1,3})$/;
const ROWS = /^\$?([1-9][0-9]{0,6})$/;

function splitSheet(text: string): { sheet?: string; rest: string } | null {
  if (text.startsWith("'")) {
    let name = "";
    let i = 1;
    for (; i < text.length; i++) {
      const c = text.charAt(i);
      if (c === "'") {
        if (text.charAt(i + 1) === "'") {
          name += "'";
          i++;
          continue;
        }
        break;
      }
      name += c;
    }
    if (i >= text.length || text.charAt(i + 1) !== "!" || name.length === 0) return null;
    return { sheet: name, rest: text.slice(i + 2) };
  }
  const bang = text.lastIndexOf("!");
  if (bang < 0) return { rest: text };
  const sheet = text.slice(0, bang).trim();
  if (sheet.length === 0) return null;
  return { sheet, rest: text.slice(bang + 1) };
}

/**
 * "B2", "B2:C9", "A:A", "3:3", "Sheet 2!A1", "'My sheet'!B2:C3" → a range with r1 ≤ r2 and c1 ≤ c2; null when the
 * text isn't an address.
 */
export function parseA1Range(text: string): A1Range | null {
  const split = splitSheet(text.trim());
  if (!split) return null;
  const body = split.rest.trim();
  const sheet = split.sheet === undefined ? {} : { sheet: split.sheet };
  const colon = body.indexOf(":");
  if (colon < 0) {
    const one = parseA1(body);
    return one ? { ...sheet, r1: one.row, c1: one.col, r2: one.row, c2: one.col } : null;
  }
  const left = body.slice(0, colon).trim();
  const right = body.slice(colon + 1).trim();
  const a = parseA1(left);
  const b = parseA1(right);
  if (a && b) {
    return {
      ...sheet,
      r1: Math.min(a.row, b.row),
      c1: Math.min(a.col, b.col),
      r2: Math.max(a.row, b.row),
      c2: Math.max(a.col, b.col),
    };
  }
  const limits = LIVE_LIMITS.spreadsheet;
  const ca = COLS.exec(left);
  const cb = COLS.exec(right);
  if (ca && cb) {
    const x = colIndexOf(ca[1] ?? "");
    const y = colIndexOf(cb[1] ?? "");
    if (x < 0 || y < 0) return null;
    return { ...sheet, r1: 0, c1: Math.min(x, y), r2: limits.rows - 1, c2: Math.max(x, y), whole: "cols" };
  }
  const ra = ROWS.exec(left);
  const rb = ROWS.exec(right);
  if (ra && rb) {
    const x = Number(ra[1]) - 1;
    const y = Number(rb[1]) - 1;
    if (x >= MAX_A1_ROWS || y >= MAX_A1_ROWS) return null;
    return { ...sheet, r1: Math.min(x, y), c1: 0, r2: Math.max(x, y), c2: limits.cols - 1, whole: "rows" };
  }
  return null;
}

/** One cell's address: "B2", or "$B$2" with `abs`. */
export function formatA1(row: number, col: number, abs?: { row?: boolean; col?: boolean }): string {
  return `${abs?.col ? "$" : ""}${colName(col)}${abs?.row ? "$" : ""}${row + 1}`;
}

/**
 * "B2" for one cell, "B2:C9" for a range. Given the sheet's size, a range over every row reads "B:C" and one over every
 * column "2:5", as the name box shows a whole column or row.
 */
export function formatA1Range(
  r1: number,
  c1: number,
  r2: number,
  c2: number,
  size?: { rows: number; cols: number },
): string {
  const top = Math.min(r1, r2);
  const bottom = Math.max(r1, r2);
  const left = Math.min(c1, c2);
  const right = Math.max(c1, c2);
  if (size) {
    if (top === 0 && bottom >= size.rows - 1 && size.rows > 1) return `${colName(left)}:${colName(right)}`;
    if (left === 0 && right >= size.cols - 1 && size.cols > 1) return `${top + 1}:${bottom + 1}`;
  }
  if (top === bottom && left === right) return formatA1(top, left);
  return `${formatA1(top, left)}:${formatA1(bottom, right)}`;
}

const PLAIN_SHEET = /^[A-Za-z_À-￿][A-Za-z0-9_.À-￿]*$/;

/** A sheet's name as a reference spells it: bare when it can be ("Sales"), else quoted ("'Sheet 2'", "'It''s'"). */
export function quoteSheetName(name: string): string {
  if (PLAIN_SHEET.test(name) && !CELL.test(name) && !/^R\d*C\d*$/i.test(name)) return name;
  return `'${name.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------------------------------------------------
// References inside formula text. Pasting a formula onto another sheet or into another document can't move it by
// ids (rows and columns are a sheet's own), so it travels as English A1 text and moves there, as Excel's copy does.

/** A character that continues a name or a number: a reference must not touch one on either side. */
const WORD_CHAR = /[A-Za-z0-9_.À-￿]/;
const SHEET_START = /[A-Za-z_À-￿]/;
const A1_REF = /(\$?)([A-Za-z]{1,3})(\$?)([1-9][0-9]{0,6})(?::(\$?)([A-Za-z]{1,3})(\$?)([1-9][0-9]{0,6}))?/y;
const A1_COLS = /(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})/y;
const A1_ROWS = /(\$?)([1-9][0-9]{0,6}):(\$?)([1-9][0-9]{0,6})/y;

function at(re: RegExp, text: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(text);
}

/**
 * The length of an unquoted sheet name and its `!` at `i` (`Sales!`), or 0. Read by index rather than with a sticky
 * regex, which code scanning reads as trying a long word again from each of its letters (quadratic).
 */
function unquotedSheetAt(text: string, i: number): number {
  if (!SHEET_START.test(text.charAt(i))) return 0;
  let j = i + 1;
  while (j < text.length && WORD_CHAR.test(text.charAt(j))) j++;
  return text.charAt(j) === "!" ? j + 1 - i : 0;
}

/** The end of a quoted run (`"…"` or `'…'`, doubled quotes inside) starting at `i`: the index after its closing quote. */
function quotedEnd(text: string, i: number): number {
  const quote = text.charAt(i);
  let j = i + 1;
  while (j < text.length) {
    if (text.charAt(j) === quote) {
      if (text.charAt(j + 1) === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return text.length;
}

interface RefMatch {
  /** Where the reference ends in the text. */
  end: number;
  /** The moved reference, or null when it fell off the grid. */
  out: string | null;
}

function shiftCol(abs: boolean, letters: string, dc: number): string | null {
  const col = colIndexOf(letters);
  const next = abs ? col : col + dc;
  if (col < 0 || next < 0 || next >= MAX_A1_COLS) return null;
  return `${abs ? "$" : ""}${colName(next)}`;
}

function shiftRow(abs: boolean, digits: string, dr: number): string | null {
  const row = Number(digits) - 1;
  const next = abs ? row : row + dr;
  if (next < 0 || next >= MAX_A1_ROWS) return null;
  return `${abs ? "$" : ""}${next + 1}`;
}

/** A reference at `i` (no sheet), moved by `dr`/`dc`; `out` null when it falls off the grid. */
function matchRef(text: string, i: number, dr: number, dc: number): RefMatch | null {
  const done = (m: RegExpExecArray, out: string | null): RefMatch | null => {
    const end = i + m[0].length;
    const next = text.charAt(end);
    if (next !== "" && (WORD_CHAR.test(next) || next === "(" || next === "!" || next === "$")) return null;
    return { end, out };
  };
  const cell = at(A1_REF, text, i);
  if (cell) {
    const c1 = shiftCol(cell[1] === "$", cell[2] ?? "", dc);
    const r1 = shiftRow(cell[3] === "$", cell[4] ?? "", dr);
    if (cell[6] === undefined) return done(cell, c1 && r1 ? c1 + r1 : null);
    const c2 = shiftCol(cell[5] === "$", cell[6] ?? "", dc);
    const r2 = shiftRow(cell[7] === "$", cell[8] ?? "", dr);
    return done(cell, c1 && r1 && c2 && r2 ? `${c1}${r1}:${c2}${r2}` : null);
  }
  const cols = at(A1_COLS, text, i);
  if (cols) {
    const a = shiftCol(cols[1] === "$", cols[2] ?? "", dc);
    const b = shiftCol(cols[3] === "$", cols[4] ?? "", dc);
    return done(cols, a && b ? `${a}:${b}` : null);
  }
  const rows = at(A1_ROWS, text, i);
  if (rows) {
    const a = shiftRow(rows[1] === "$", rows[2] ?? "", dr);
    const b = shiftRow(rows[3] === "$", rows[4] ?? "", dr);
    return done(rows, a && b ? `${a}:${b}` : null);
  }
  return null;
}

/**
 * Moves every relative reference of an A1 formula in English (`=SUM(B2:B9,Sheet2!$C$1)`) by `dr` rows and `dc`
 * columns, as copying it that far does; `$` parts stay. A reference pushed off the grid becomes `#REF!`. Text in
 * quotes, function names and other names are left alone.
 */
export function shiftA1Formula(formula: string, dr: number, dc: number): string {
  let out = "";
  let i = 0;
  const text = formula;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === '"') {
      const end = quotedEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    const boundary = i === 0 || !WORD_CHAR.test(text.charAt(i - 1));
    if (c === "'" && boundary) {
      const end = quotedEnd(text, i);
      if (text.charAt(end) === "!") {
        const ref = matchRef(text, end + 1, dr, dc);
        if (ref) {
          out += ref.out === null ? "#REF!" : `${text.slice(i, end + 1)}${ref.out}`;
          i = ref.end;
          continue;
        }
      }
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (boundary && (WORD_CHAR.test(c) || c === "$")) {
      const start = c === "$" ? i : i + unquotedSheetAt(text, i);
      const ref = matchRef(text, start, dr, dc);
      if (ref) {
        out += ref.out === null ? "#REF!" : `${text.slice(i, start)}${ref.out}`;
        i = ref.end;
        continue;
      }
      // Not a reference: copy the whole word, so nothing inside it is read as one.
      let j = i + 1;
      while (j < text.length && (WORD_CHAR.test(text.charAt(j)) || text.charAt(j) === "$")) j++;
      out += text.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const R1C1_CELL = /R(?:\[(-?\d+)\]|(\d+))?C(?:\[(-?\d+)\]|(\d+))?/y;
const R1C1_ROW = /R(?:\[(-?\d+)\]|(\d+))/y;
const R1C1_COL = /C(?:\[(-?\d+)\]|(\d+))/y;

/** One end of an R1C1 reference: rows and columns as 0-based indexes, or `$` and the 1-based number when absolute. */
type R1C1End = { kind: "cell"; row: string; col: string } | { kind: "row"; row: string } | { kind: "col"; col: string };

function r1c1Part(rel: string | undefined, abs: string | undefined, base: number): string | null {
  if (abs !== undefined) return Number(abs) >= 1 ? `$${Number(abs)}` : null;
  const n = base + Number(rel ?? 0);
  return n >= 0 ? String(n) : null;
}

/** One end of an R1C1 reference at `i`, read against the cell at `row`/`col` (0-based). */
function r1c1End(text: string, i: number, row: number, col: number): { end: number; v: R1C1End | null } | null {
  const cell = at(R1C1_CELL, text, i);
  if (cell) {
    const r = r1c1Part(cell[1], cell[2], row);
    const c = r1c1Part(cell[3], cell[4], col);
    return { end: i + cell[0].length, v: r !== null && c !== null ? { kind: "cell", row: r, col: c } : null };
  }
  const r = at(R1C1_ROW, text, i);
  if (r) {
    const part = r1c1Part(r[1], r[2], row);
    return { end: i + r[0].length, v: part !== null ? { kind: "row", row: part } : null };
  }
  const c = at(R1C1_COL, text, i);
  if (c) {
    const part = r1c1Part(c[1], c[2], col);
    return { end: i + c[0].length, v: part !== null ? { kind: "col", col: part } : null };
  }
  return null;
}

function a1Row(part: string): string | null {
  const abs = part.startsWith("$");
  const n = Number(abs ? part.slice(1) : part) + (abs ? 0 : 1);
  return n >= 1 && n <= MAX_A1_ROWS ? `${abs ? "$" : ""}${n}` : null;
}

function a1Col(part: string): string | null {
  const abs = part.startsWith("$");
  const n = Number(abs ? part.slice(1) : part) - (abs ? 1 : 0);
  return n >= 0 && n < MAX_A1_COLS ? `${abs ? "$" : ""}${colName(n)}` : null;
}

function a1End(end: R1C1End): string | null {
  if (end.kind === "row") return a1Row(end.row);
  if (end.kind === "col") return a1Col(end.col);
  const c = a1Col(end.col);
  const r = a1Row(end.row);
  return c && r ? c + r : null;
}

/**
 * An R1C1 formula (`=R[0]C[-1]*2`, `=SUM(R[-3]C:R[-1]C)`, as Google Sheets puts formulas on the clipboard) in A1 for
 * the cell at `row`/`col` (0-based): `=A1*2` in B1. A reference off the grid becomes `#REF!`.
 */
export function r1c1ToA1(formula: string, row: number, col: number): string {
  let out = "";
  let i = 0;
  const text = formula;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === '"') {
      const end = quotedEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    const boundary = i === 0 || !WORD_CHAR.test(text.charAt(i - 1));
    if (!boundary || !(WORD_CHAR.test(c) || c === "'")) {
      out += c;
      i++;
      continue;
    }
    let start = i;
    if (c === "'") {
      const end = quotedEnd(text, i);
      start = text.charAt(end) === "!" ? end + 1 : -1;
      if (start < 0) {
        out += text.slice(i, end);
        i = end;
        continue;
      }
    } else {
      start = i + unquotedSheetAt(text, i);
    }
    const first = r1c1End(text, start, row, col);
    let ref: { end: number; text: string | null } | null = null;
    if (first) {
      let end = first.end;
      let a1 = first.v ? a1End(first.v) : null;
      const second = text.charAt(end) === ":" ? r1c1End(text, end + 1, row, col) : null;
      if (second) {
        const b = second.v ? a1End(second.v) : null;
        a1 = a1 && b ? `${a1}:${b}` : null;
        end = second.end;
      } else if (a1 !== null && first.v && first.v.kind !== "cell") {
        // A whole row or column alone ("R5", "C[1]") is that row or column from end to end in A1 ("5:5").
        a1 = `${a1}:${a1}`;
      }
      const next = text.charAt(end);
      if (next === "" || !(WORD_CHAR.test(next) || next === "(" || next === "!")) ref = { end, text: a1 };
    }
    if (ref) {
      out += ref.text === null ? "#REF!" : `${text.slice(i, start)}${ref.text}`;
      i = ref.end;
      continue;
    }
    let j = i + 1;
    if (c === "'") j = quotedEnd(text, i);
    else while (j < text.length && WORD_CHAR.test(text.charAt(j))) j++;
    out += text.slice(i, j);
    i = j;
  }
  return out;
}
