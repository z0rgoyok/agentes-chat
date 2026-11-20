/**
 * What a formula works with while it runs (ADR 0196 §2): plain values, references (a rectangle of a sheet, read only
 * when needed) and arrays, with Excel's rules for turning one kind into another: text in arithmetic is `#VALUE!`
 * unless it reads as a number, `TRUE` is 1, an empty cell is 0 or "" depending on what wants it, and the first error
 * wins. Text made from numbers and numbers read from text (`=1,5&""`, VALUE, TEXT's codes) follow the engine's
 * calculation language (`calc`): the person's own in the apps, so what they type in their language works, and
 * English on the server, as each copy of Excel reads them by its own settings.
 */
import type { SheetLocale } from "../locale";
import type { CellError, CellValue, ErrorCode } from "../values";
import type { Ast } from "./types";

/** A rectangle of a sheet, 0-based and inclusive. */
export interface RefValue {
  k: "ref";
  sheet: string;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** Values row by row. */
export interface ArrValue {
  k: "arr";
  rows: number;
  cols: number;
  v: CellValue[];
}

export type Val = CellValue | RefValue | ArrValue;

/** What the engine gives a running formula. */
export interface EvalHost {
  /** A cell's value (its formula computed), recorded as read by the running formula. */
  cell(sheet: string, row: number, col: number): CellValue;
  /** A rectangle's values, row by row, recorded as one read. */
  range(ref: RefValue): ArrValue;
  /** The position of a row or column id now; -1 when it was deleted. */
  rowPos(sheet: string, rowId: string): number;
  colPos(sheet: string, colId: string): number;
  /**
   * A sheet's rows and columns now; null when the sheet is gone. Every reference resolves through it, so it is also
   * where the engine notes that the running formula reads that sheet (its rows moving changes the formula's value).
   */
  size(sheet: string): { rows: number; cols: number } | null;
  sheetByName(name: string): string | null;
  /** The canonical formula in a cell, if it holds one. */
  formula(sheet: string, row: number, col: number): string | undefined;
  /** The clock, read once per recalculation. */
  now(): Date;
  /** The `n`th random number of the running formula, in [0, 1), the same on every device. */
  random(env: Env, n: number): number;
}

export interface Env {
  host: EvalHost;
  /** The formula's own cell, by position now and by ids. */
  sheet: string;
  row: number;
  col: number;
  rowId: string;
  colId: string;
  /** Work done, against `MAX_STEPS`. */
  steps: number;
  /** Random numbers drawn so far. */
  rand: number;
  /** How the formula reads the clock: 0 not at all, `VOLATILE_DAY` (TODAY), `VOLATILE_TIME` (NOW). */
  volatile: number;
  /** The engine's calculation language, for text formulas make and read (TEXT, VALUE, `&` with a number). */
  calc: SheetLocale;
  evaluate(ast: Ast, env: Env): Val;
}

/** The formula changes with the date (TODAY) or with the time (NOW): `tick` recomputes it. */
export const VOLATILE_DAY = 1;
export const VOLATILE_TIME = 2;

/** Work one formula may do (nodes evaluated, cells read, items made) before it gives up with `#CALC!`. */
export const MAX_STEPS = 2_000_000;
/** The most items an array made by a formula may hold. */
export const MAX_ARRAY = 1_000_000;
/** The longest text a cell may hold, as in Excel. */
export const MAX_TEXT = 32_767;

export class BudgetExceeded extends Error {
  override name = "BudgetExceeded";
}

function freeze(code: ErrorCode): CellError {
  return Object.freeze({ error: code });
}

/** One shared object per error, so passing an error along keeps its identity. */
export const ERR: Readonly<Record<ErrorCode, CellError>> = {
  "#NULL!": freeze("#NULL!"),
  "#DIV/0!": freeze("#DIV/0!"),
  "#VALUE!": freeze("#VALUE!"),
  "#REF!": freeze("#REF!"),
  "#NAME?": freeze("#NAME?"),
  "#NUM!": freeze("#NUM!"),
  "#N/A": freeze("#N/A"),
  "#CALC!": freeze("#CALC!"),
  "#SPILL!": freeze("#SPILL!"),
  "#CYCLE!": freeze("#CYCLE!"),
};

/** The value of a cell in a circular reference: `#REF!`, told apart by identity to explain it. */
export const CIRCULAR: CellError = Object.freeze({ error: "#REF!" as ErrorCode });

export function isErr(v: unknown): v is CellError {
  return typeof v === "object" && v !== null && typeof (v as CellError).error === "string";
}

export function isRef(v: Val): v is RefValue {
  return typeof v === "object" && v !== null && (v as RefValue).k === "ref";
}

export function isArr(v: Val): v is ArrValue {
  return typeof v === "object" && v !== null && (v as ArrValue).k === "arr";
}

export function spend(env: Env, steps: number): void {
  env.steps += steps;
  if (env.steps > MAX_STEPS) throw new BudgetExceeded("A formula did too much work");
}

export function makeArr(rows: number, cols: number, v: CellValue[]): ArrValue {
  return { k: "arr", rows, cols, v };
}

/** A reference read: one cell as its value, a rectangle as an array. Arrays and values stay as they are. */
export function deref(v: Val, env: Env): CellValue | ArrValue {
  if (!isRef(v)) return v;
  if (v.r1 === v.r2 && v.c1 === v.c2) return env.host.cell(v.sheet, v.r1, v.c1);
  spend(env, (v.r2 - v.r1 + 1) * (v.c2 - v.c1 + 1));
  return env.host.range(v);
}

/** A value where one is wanted: an array or range gives its top-left item. */
export function scalar(v: Val, env: Env): CellValue {
  const d = deref(v, env);
  if (isArr(d)) return d.v.length > 0 ? (d.v[0] as CellValue) : ERR["#VALUE!"];
  return d;
}

/** Any value as an array (a single value is 1×1). */
export function asArr(v: Val, env: Env): ArrValue {
  const d = deref(v, env);
  return isArr(d) ? d : makeArr(1, 1, [d]);
}

export function arrAt(a: ArrValue, r: number, c: number): CellValue {
  const rr = a.rows === 1 ? 0 : r;
  const cc = a.cols === 1 ? 0 : c;
  if (rr >= a.rows || cc >= a.cols) return ERR["#N/A"];
  return a.v[rr * a.cols + cc] as CellValue;
}

/** Item by item over one or two arrays, Excel's broadcasting: a single row or column repeats, a missing item is `#N/A`. */
export function broadcast(
  x: CellValue | ArrValue,
  y: CellValue | ArrValue,
  env: Env,
  fn: (a: CellValue, b: CellValue) => CellValue,
): ArrValue {
  const rows = Math.max(isArr(x) ? x.rows : 1, isArr(y) ? y.rows : 1);
  const cols = Math.max(isArr(x) ? x.cols : 1, isArr(y) ? y.cols : 1);
  if (rows * cols > MAX_ARRAY) return makeArr(1, 1, [ERR["#NUM!"]]);
  spend(env, rows * cols);
  const out = new Array<CellValue>(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out[r * cols + c] = fn(isArr(x) ? arrAt(x, r, c) : x, isArr(y) ? arrAt(y, r, c) : y);
    }
  }
  return makeArr(rows, cols, out);
}

export function mapArr(a: ArrValue, env: Env, fn: (v: CellValue) => CellValue): ArrValue {
  spend(env, a.v.length);
  const out = new Array<CellValue>(a.v.length);
  for (let i = 0; i < a.v.length; i++) out[i] = fn(a.v[i] as CellValue);
  return makeArr(a.rows, a.cols, out);
}

// Numbers as text -------------------------------------------------------------------------------------------------

function trimZeros(s: string): string {
  if (!s.includes(".")) return s;
  const t = s.replace(/0+$/, "");
  return t.endsWith(".") ? t.slice(0, -1) : t;
}

/**
 * A number as Excel turns it into text (`=A1&""`): up to 15 significant digits, scientific past them
 * ("1.23456789012346E+17", "1E-10"), with the document's decimal separator.
 */
export function generalText(n: number, decimal: "." | "," = "."): string {
  if (n === 0 || !Number.isFinite(n)) return "0";
  const p = Number(n.toPrecision(15));
  const abs = Math.abs(p);
  let s: string;
  if (abs >= 1e15 || abs < 1e-9) {
    const [m = "0", e = "0"] = p.toExponential(14).split("e");
    const exp = Number(e);
    s = `${trimZeros(m)}E${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  } else if (Number.isInteger(p)) {
    s = String(p);
  } else {
    const digits = Math.min(100, Math.max(0, 15 - (Math.floor(Math.log10(abs)) + 1)));
    s = trimZeros(p.toFixed(digits));
  }
  return decimal === "," ? s.replace(".", ",") : s;
}

// Text as numbers -------------------------------------------------------------------------------------------------

const MONTHS_EN = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTHS_PT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function monthOf(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3) return -1;
  const head = w.slice(0, 3);
  let i = MONTHS_EN.indexOf(head);
  if (i < 0) i = MONTHS_PT.indexOf(head);
  if (i < 0 && (w.startsWith("fevereiro") || w === "fev")) i = 1;
  return i;
}

/** Days in a month, Excel's way (1900 counts as a leap year). */
function monthDays(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0 || year === 1900) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Days since 1899-12-30 for a valid date, Excel's serial (1900-02-29 is 60). */
export function excelSerial(year: number, month: number, day: number): number {
  // Days from civil (proleptic Gregorian), then Excel's shift for its fake 1900-02-29.
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days = era * 146097 + doe - 693899;
  if (year === 1900 && month === 2 && day === 29) return 60;
  return days < 61 ? days - 1 : days;
}

function validDate(year: number, month: number, day: number): boolean {
  return year >= 1900 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= monthDays(year, month);
}

function fullYear(y: string): number {
  const n = Number(y);
  if (y.length <= 2) return n < 30 ? 2000 + n : 1900 + n;
  return n;
}

const TIME_RE = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:[.,]\d+)?))?\s*([AaPp][Mm]?)?$/;

/** "13:45", "1:30 PM", "8:05:30" → the fraction of a day; null when it isn't a time. */
export function parseTimeText(text: string): number | null {
  const m = TIME_RE.exec(text.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] ? Number(m[3].replace(",", ".")) : 0;
  const ampm = m[4]?.toLowerCase();
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm.startsWith("p") && h < 12) h += 12;
    if (ampm.startsWith("a") && h === 12) h = 0;
  }
  if (min > 59 || sec >= 60) return null;
  return (h * 3600 + min * 60 + sec) / 86400;
}

/**
 * Date text → serial: ISO `2026-11-17`, the document's order (`17/11/2026` day first, `11/17/2026` month first, the
 * other order when only it fits), and month names in English or Portuguese (`17 nov 2026`, `Nov 17, 2026`,
 * `17 de novembro de 2026`). Null when it isn't a date.
 */
export function parseDateText(text: string, order: "dmy" | "mdy" | "ymd" = "mdy"): number | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/\s+de\s+/g, " ");
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validDate(y, mo, d) ? excelSerial(y, mo, d) : null;
  }
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(t);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = fullYear(m[3] as string);
    const dayFirst = order !== "mdy";
    const tries: [number, number][] = dayFirst
      ? [
          [b, a],
          [a, b],
        ]
      : [
          [a, b],
          [b, a],
        ];
    for (const [mo, d] of tries) if (validDate(y, mo, d)) return excelSerial(y, mo, d);
    return null;
  }
  m = /^(\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m) {
    // Day and month without a year: this year is not known here, so it isn't read as a date.
    return null;
  }
  m = /^(\d{1,2})[\s-]+([a-zç.]+)[\s-]+(\d{2}|\d{4})$/.exec(t);
  if (m) {
    const mo = monthOf(m[2] as string) + 1;
    const d = Number(m[1]);
    const y = fullYear(m[3] as string);
    return mo > 0 && validDate(y, mo, d) ? excelSerial(y, mo, d) : null;
  }
  m = /^([a-zç.]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(t);
  if (m) {
    const mo = monthOf(m[1] as string) + 1;
    const d = Number(m[2]);
    const y = Number(m[3]);
    return mo > 0 && validDate(y, mo, d) ? excelSerial(y, mo, d) : null;
  }
  return null;
}

/** Date and time text ("2026-11-17 13:45", "17/11/2026 8:00") → serial with its time; null when it isn't one. */
export function parseDateTimeText(text: string, order: "dmy" | "mdy" | "ymd" = "mdy"): number | null {
  const t = text.trim();
  const date = parseDateText(t, order);
  if (date !== null) return date;
  const time = parseTimeText(t);
  if (time !== null) return time;
  const m = /^(.+?)[\sT]+(\d{1,2}:\d{1,2}(?::\d{1,2}(?:[.,]\d+)?)?(?:\s*[AaPp][Mm]?)?)$/.exec(t);
  if (!m) return null;
  const d = parseDateText(m[1] as string, order);
  const tm = parseTimeText(m[2] as string);
  return d !== null && tm !== null ? d + tm : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const numberRes = new Map<string, RegExp>();

function numberRe(decimal: string, group: string): RegExp {
  const key = decimal + group;
  let re = numberRes.get(key);
  if (!re) {
    const d = escapeRe(decimal);
    const g = group === " " ? "[ \\u00a0]" : escapeRe(group);
    re = new RegExp(`^([+-]?)(\\d{1,3}(?:${g}\\d{3})+|\\d+)?(?:${d}(\\d*))?(?:[eE]([+-]?\\d+))?$`);
    numberRes.set(key, re);
  }
  return re;
}

/**
 * Text that reads as a number, as Excel coerces it ("12", " 1,234.5 ", "50%", "$10", "(12)", "1E3", or a date or a
 * time): the document's separators first, then the plain one. Null when it isn't a number.
 */
export function textToNumber(
  text: string,
  calc: Pick<SheetLocale, "decimal" | "group" | "currency" | "dateOrder">,
): number | null {
  let t = text.trim();
  if (!t) return null;
  let sign = 1;
  if (t.startsWith("(") && t.endsWith(")")) {
    sign = -1;
    t = t.slice(1, -1).trim();
  }
  let percent = false;
  if (t.endsWith("%")) {
    percent = true;
    t = t.slice(0, -1).trim();
  }
  for (const symbol of [calc.currency, "$"]) {
    if (symbol && t.startsWith(symbol)) t = t.slice(symbol.length).trim();
    else if (symbol && t.endsWith(symbol)) t = t.slice(0, -symbol.length).trim();
    if (symbol && (t.startsWith(`-${symbol}`) || t.startsWith(`+${symbol}`))) {
      t = t.charAt(0) + t.slice(symbol.length + 1).trim();
    }
  }
  const attempts: [string, string][] = [[calc.decimal, calc.group]];
  if (calc.decimal !== ".") attempts.push([".", ","]);
  for (const [decimal, group] of attempts) {
    const m = numberRe(decimal, group).exec(t);
    if (!m || (m[2] === undefined && (m[3] === undefined || m[3] === ""))) continue;
    const int = (m[2] ?? "0").replace(/[^0-9]/g, "");
    const n = Number(`${m[1] ?? ""}${int}.${m[3] || "0"}e${m[4] ?? "0"}`);
    if (!Number.isFinite(n)) return null;
    const v = sign * (percent ? n / 100 : n);
    return v === 0 ? 0 : v;
  }
  if (sign === 1 && !percent) {
    const d = parseDateTimeText(t, calc.dateOrder);
    if (d !== null) return d;
  }
  return null;
}

// Coercion --------------------------------------------------------------------------------------------------------

export function toNumber(v: CellValue, calc: SheetLocale): number | CellError {
  if (typeof v === "number") return v;
  if (v === null) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = textToNumber(v, calc);
    return n === null ? ERR["#VALUE!"] : n;
  }
  return v;
}

export function toText(v: CellValue, calc: SheetLocale): string | CellError {
  if (typeof v === "string") return v;
  if (v === null) return "";
  if (typeof v === "number") return generalText(v, calc.decimal);
  if (typeof v === "boolean") {
    if (calc.fnNames === "pt") return v ? "VERDADEIRO" : "FALSO";
    return v ? "TRUE" : "FALSE";
  }
  return v;
}

export function toBool(v: CellValue): boolean | CellError {
  if (typeof v === "boolean") return v;
  if (v === null) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const t = v.trim().toUpperCase();
    if (t === "TRUE" || t === "VERDADEIRO") return true;
    if (t === "FALSE" || t === "FALSO") return false;
    return ERR["#VALUE!"];
  }
  return v;
}

/** An integer argument, truncated toward zero as Excel does. */
export function toInt(v: CellValue, calc: SheetLocale): number | CellError {
  const n = toNumber(v, calc);
  if (isErr(n)) return n;
  return Math.trunc(n);
}

// Comparison ------------------------------------------------------------------------------------------------------

/** Equal within the last bits, as Excel and other spreadsheets compare, so `0.1+0.2=0.3` is TRUE. */
export function approxEqual(a: number, b: number): boolean {
  if (a === b) return true;
  const d = Math.abs(a - b);
  return d <= Math.max(Math.abs(a), Math.abs(b)) * 2 ** -48;
}

const FOLD: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {};
  const groups: [string, string][] = [
    ["a", "àáâãäåāăą"],
    ["c", "çćĉċč"],
    ["d", "ďđ"],
    ["e", "èéêëēĕėęě"],
    ["g", "ĝğġģ"],
    ["h", "ĥħ"],
    ["i", "ìíîïĩīĭįı"],
    ["j", "ĵ"],
    ["k", "ķ"],
    ["l", "ĺļľŀł"],
    ["n", "ñńņňŉ"],
    ["o", "òóôõöøōŏő"],
    ["r", "ŕŗř"],
    ["s", "śŝşšß"],
    ["t", "ţťŧ"],
    ["u", "ùúûüũūŭůűų"],
    ["w", "ŵ"],
    ["y", "ýÿŷ"],
    ["z", "źżž"],
  ];
  for (const [base, chars] of groups) for (const c of chars) map[c] = base;
  return map;
})();

function foldText(s: string): string {
  let out = "";
  for (const c of s) out += FOLD[c] ?? c;
  return out;
}

/**
 * Text order: ignoring case, accented letters next to their plain ones ("Ágata" before "Bruno"), then by the
 * characters themselves; the same on every device (no locale data involved).
 */
export function compareText(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return 0;
  const fa = foldText(la);
  const fb = foldText(lb);
  if (fa !== fb) return fa < fb ? -1 : 1;
  return la < lb ? -1 : 1;
}

function typeRank(v: number | string | boolean): number {
  return typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2;
}

/**
 * Excel's comparison of two values (no errors): numbers before text before booleans; an empty cell is 0, "" or
 * FALSE depending on the other side.
 */
export function compareValues(x: CellValue, y: CellValue): number {
  let a = x as number | string | boolean | null;
  let b = y as number | string | boolean | null;
  if (a === null && b === null) return 0;
  if (a === null) a = typeof b === "string" ? "" : typeof b === "boolean" ? false : 0;
  if (b === null) b = typeof a === "string" ? "" : typeof a === "boolean" ? false : 0;
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === "number") {
    const nb = b as number;
    if (approxEqual(a, nb)) return 0;
    return a < nb ? -1 : 1;
  }
  if (typeof a === "string") return compareText(a, b as string);
  if (a === b) return 0;
  return a ? 1 : -1;
}

/** Same value for lookups and `=`: case-insensitive text, numbers within rounding. */
export function sameValue(x: CellValue, y: CellValue): boolean {
  if (isErr(x) || isErr(y)) return isErr(x) && isErr(y) && x.error === y.error;
  return compareValues(x, y) === 0;
}

// Wildcards and criteria ------------------------------------------------------------------------------------------

const wildcardRes = new Map<string, RegExp>();

/** Excel's wildcards: `*` any text, `?` one character, `~` before either (or itself) for the character. */
export function wildcardRegExp(pattern: string): RegExp {
  const hit = wildcardRes.get(pattern);
  if (hit) return hit;
  let src = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c === "~" && i + 1 < pattern.length && "*?~".includes(pattern.charAt(i + 1))) {
      src += escapeRe(pattern.charAt(i + 1));
      i++;
    } else if (c === "*") src += "[\\s\\S]*";
    else if (c === "?") src += "[\\s\\S]";
    else src += escapeRe(c);
  }
  const re = new RegExp(`^${src}$`, "i");
  if (wildcardRes.size > 500) wildcardRes.clear();
  wildcardRes.set(pattern, re);
  return re;
}

export function hasWildcards(pattern: string): boolean {
  return /[*?~]/.test(pattern);
}

export type Criterion = (v: CellValue) => boolean;

/**
 * A criterion as COUNTIF, SUMIFS and the rest read it: a value (`5`, `TRUE`, `"maçã"` with wildcards) or text with
 * an operator (`">=10"`, `"<>x"`, `"="` for empty cells, `"<>"` for filled ones). An empty cell as the criterion
 * means 0.
 */
export function makeCriterion(c: CellValue, calc: SheetLocale): Criterion {
  if (c === null) return (v) => typeof v === "number" && v === 0;
  if (typeof c === "number") {
    return (v) => {
      if (typeof v === "number") return approxEqual(v, c);
      if (typeof v === "string") {
        const n = textToNumber(v, calc);
        return n !== null && approxEqual(n, c);
      }
      return false;
    };
  }
  if (typeof c === "boolean") return (v) => v === c;
  if (isErr(c)) return (v) => isErr(v) && v.error === c.error;
  const m = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/.exec(c) as RegExpExecArray;
  const op = m[1] ?? "=";
  const rest = m[2] as string;
  if (rest === "") {
    if (op === "=") return m[1] ? (v) => v === null : (v) => v === null || v === "";
    if (op === "<>") return (v) => v !== null && v !== "";
    return () => false;
  }
  const num = textToNumber(rest, calc);
  const upper = rest.trim().toUpperCase();
  const bool =
    upper === "TRUE" || upper === "VERDADEIRO" ? true : upper === "FALSE" || upper === "FALSO" ? false : null;
  const errCode = rest.trim().toUpperCase();
  const isErrorText = errCode.startsWith("#");
  if (op === "=" || op === "<>") {
    let test: Criterion;
    if (num !== null) {
      test = (v) => {
        if (typeof v === "number") return approxEqual(v, num);
        if (typeof v === "string") {
          const n = textToNumber(v, calc);
          return n !== null && approxEqual(n, num);
        }
        return false;
      };
    } else if (bool !== null) {
      test = (v) => v === bool;
    } else if (isErrorText) {
      test = (v) => isErr(v) && (v.error === errCode || ptError(v.error) === errCode);
    } else if (hasWildcards(rest)) {
      const re = wildcardRegExp(rest);
      test = (v) => typeof v === "string" && re.test(v);
    } else {
      const lower = rest.toLowerCase();
      test = (v) => typeof v === "string" && v.toLowerCase() === lower;
    }
    return op === "=" ? test : (v) => !test(v);
  }
  if (num !== null) {
    return (v) => {
      if (typeof v !== "number") return false;
      const cmp = approxEqual(v, num) ? 0 : v < num ? -1 : 1;
      return op === "<" ? cmp < 0 : op === ">" ? cmp > 0 : op === "<=" ? cmp <= 0 : cmp >= 0;
    };
  }
  return (v) => {
    if (typeof v !== "string") return false;
    const cmp = compareText(v, rest);
    return op === "<" ? cmp < 0 : op === ">" ? cmp > 0 : op === "<=" ? cmp <= 0 : cmp >= 0;
  };
}

const PT_ERROR: Partial<Record<ErrorCode, string>> = {
  "#NULL!": "#NULO!",
  "#VALUE!": "#VALOR!",
  "#NAME?": "#NOME?",
  "#NUM!": "#NÚM!",
  "#N/A": "#N/D",
  "#SPILL!": "#DESPEJAR!",
};

function ptError(code: ErrorCode): string {
  return PT_ERROR[code] ?? code;
}
