/**
 * Splits a formula into tokens (ADR 0196 §2), in either of its two forms: as a person types it, with A1 references
 * and the separators of their language (`SOMA(B2:B9;C1)`, `1,5`), or canonical, as the document stores it, with
 * references by ids (`SUM({r1,c2}:{r9,c2},{r1,c3})`, `1.5`).
 */
import { ERROR_CODES, type ErrorCode, errorText } from "../values";
import { type CellRefId, FormulaError } from "./types";

/** One end of an A1 reference: 0-based row and column, null for a whole column or row. */
export interface A1Part {
  row: number | null;
  col: number | null;
  absRow: boolean;
  absCol: boolean;
}

export type Op = "+" | "-" | "*" | "/" | "^" | "&" | "=" | "<>" | "<" | ">" | "<=" | ">=" | "%" | ":";

export type Token =
  | { k: "num"; v: number; at: number; end: number }
  | { k: "str"; v: string; at: number; end: number }
  | { k: "err"; v: ErrorCode; at: number; end: number }
  | { k: "id"; v: string; at: number; end: number }
  /** An A1 reference: one cell, or a whole-column ("A:C") or whole-row ("2:5") range when `b` is set. */
  | { k: "a1"; sheet?: string; a: A1Part; b?: A1Part; at: number; end: number }
  /** A canonical reference by ids. */
  | { k: "cref"; ref: CellRefId; at: number; end: number }
  | { k: "op"; v: Op; at: number; end: number }
  | { k: "sep" | "colsep" | "rowsep" | "lbrace" | "rbrace" | "lparen" | "rparen" | "space"; at: number; end: number }
  | { k: "bad"; v: string; at: number; end: number }
  | { k: "end"; at: number; end: number };

export interface TokenizeOptions {
  /** The stored form (references by ids, English punctuation) instead of what a person types. */
  canonical: boolean;
  decimal: "." | ",";
  argSep: "," | ";";
  /** Keep spaces and turn what can't be read into `bad` tokens instead of throwing (to color a formula being typed). */
  loose?: boolean;
}

/** Letters that may start a name: Latin with accents, Greek, Cyrillic, Hebrew, Arabic, kana, CJK and Hangul. */
const L =
  "A-Za-z_\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F\\u0370-\\u03FF\\u0400-\\u04FF\\u0590-\\u06FF\\u3040-\\u30FF\\u3400-\\u9FFF\\uAC00-\\uD7AF";
const AFTER_REF = `(?![${L}0-9.(!$])`;
const IDENT = new RegExp(`[${L}][${L}0-9.]*`, "y");
const SHEET_PREFIX = new RegExp(`([${L}][${L}0-9.]*)!`, "y");
const CELL = new RegExp(`(\\$?)([A-Za-z]{1,3})(\\$?)([1-9][0-9]{0,6})${AFTER_REF}`, "y");
const COLS = new RegExp(`(\\$?)([A-Za-z]{1,3}):(\\$?)([A-Za-z]{1,3})${AFTER_REF}`, "y");
const ROWS = new RegExp(`(\\$?)([1-9][0-9]{0,6}):(\\$?)([1-9][0-9]{0,6})${AFTER_REF}`, "y");
const CREF = /\{(?:([A-Za-z0-9_-]+)!)?(\$?)([A-Za-z0-9_-]*),(\$?)([A-Za-z0-9_-]*)\}/y;
const NUM_DOT = /(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/y;
const NUM_COMMA = /(?:[0-9]+(?:,[0-9]*)?|,[0-9]+)(?:[eE][+-]?[0-9]+)?/y;
const IDENT_START = new RegExp(`[${L}]`);

/** Error literals as typed in either language, longest first. */
const ERROR_TEXTS: readonly [string, ErrorCode][] = (() => {
  const list: [string, ErrorCode][] = [];
  for (const code of ERROR_CODES) {
    if (code === "#CYCLE!") continue;
    list.push([code, code]);
    const pt = errorText(code, { fnNames: "pt" });
    if (pt !== code) list.push([pt, code]);
  }
  return list.sort((a, b) => b[0].length - a[0].length);
})();

/** "AA" → 26: column letters (already matched as 1 to 3 letters) to a 0-based index. */
export function lettersToCol(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + ((letters.charCodeAt(i) & ~32) - 64);
  return n - 1;
}

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === " ";
}

function matchAt(re: RegExp, src: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(src);
}

const OPEN_QUOTES = "“”„";
const CLOSE_QUOTES = "“”";
const SINGLE_CURLY = "‘’";

/** ASCII letters, digits, `_` and `-` (what an id is made of), by char code. */
function isIdChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45;
}

function isNameChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46;
}

const CANONICAL_ERRORS: readonly ErrorCode[] = [...ERROR_CODES]
  .filter((c) => c !== "#CYCLE!")
  .sort((a, b) => b.length - a.length);

/**
 * The stored form, scanned by hand: what the engine parses for every formula it computes, so it is the hot path.
 * Returns null on anything a stored formula written by this code wouldn't hold (non-ASCII names, stray characters),
 * and the general tokenizer reads (or refuses) those.
 */
function tokenizeStored(src: string): Token[] | null {
  const out: Token[] = [];
  const n = src.length;
  let inArray = false;
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    const start = i;
    if (c === 32) {
      i++;
      continue;
    }
    if (c === 34) {
      // "text" with "" for a quote
      let text = "";
      let j = i + 1;
      let from = j;
      for (;;) {
        if (j >= n) return null;
        if (src.charCodeAt(j) === 34) {
          text += src.slice(from, j);
          if (src.charCodeAt(j + 1) === 34) {
            text += '"';
            j += 2;
            from = j;
            continue;
          }
          break;
        }
        j++;
      }
      i = j + 1;
      out.push({ k: "str", v: text, at: start, end: i });
      continue;
    }
    if (c === 123) {
      if (src.charCodeAt(i + 1) === 32) {
        inArray = true;
        i++;
        out.push({ k: "lbrace", at: start, end: i });
        continue;
      }
      // {[sheet!][$]row,[$]col}
      let j = i + 1;
      let sheet: string | undefined;
      let k = j;
      while (k < n && isIdChar(src.charCodeAt(k))) k++;
      if (src.charCodeAt(k) === 33) {
        if (k === j) return null;
        sheet = src.slice(j, k);
        j = k + 1;
      }
      const absRow = src.charCodeAt(j) === 36;
      if (absRow) j++;
      k = j;
      while (k < n && isIdChar(src.charCodeAt(k))) k++;
      const row = src.slice(j, k);
      if (src.charCodeAt(k) !== 44) return null;
      j = k + 1;
      const absCol = src.charCodeAt(j) === 36;
      if (absCol) j++;
      k = j;
      while (k < n && isIdChar(src.charCodeAt(k))) k++;
      const col = src.slice(j, k);
      if (src.charCodeAt(k) !== 125 || (row.length === 0 && col.length === 0)) return null;
      const ref: CellRefId = { row: row || null, col: col || null };
      if (sheet !== undefined) ref.sheet = sheet;
      if (absRow && ref.row !== null) ref.absRow = true;
      if (absCol && ref.col !== null) ref.absCol = true;
      i = k + 1;
      out.push({ k: "cref", ref, at: start, end: i });
      continue;
    }
    if (c === 125) {
      inArray = false;
      i++;
      out.push({ k: "rbrace", at: start, end: i });
      continue;
    }
    if ((c >= 48 && c <= 57) || (c === 46 && src.charCodeAt(i + 1) >= 48 && src.charCodeAt(i + 1) <= 57)) {
      let j = i;
      while (j < n && src.charCodeAt(j) >= 48 && src.charCodeAt(j) <= 57) j++;
      if (src.charCodeAt(j) === 46) {
        j++;
        while (j < n && src.charCodeAt(j) >= 48 && src.charCodeAt(j) <= 57) j++;
      }
      const e = src.charCodeAt(j);
      if (e === 69 || e === 101) {
        let k = j + 1;
        const sign = src.charCodeAt(k);
        if (sign === 43 || sign === 45) k++;
        const digits = k;
        while (k < n && src.charCodeAt(k) >= 48 && src.charCodeAt(k) <= 57) k++;
        if (k > digits) j = k;
      }
      const v = Number(src.slice(i, j));
      if (!Number.isFinite(v)) return null;
      i = j;
      out.push({ k: "num", v, at: start, end: i });
      continue;
    }
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) {
      let j = i + 1;
      while (j < n && isNameChar(src.charCodeAt(j))) j++;
      if (j < n && src.charCodeAt(j) > 127) return null;
      i = j;
      out.push({ k: "id", v: src.slice(start, j), at: start, end: i });
      continue;
    }
    if (c === 35) {
      const hit = CANONICAL_ERRORS.find((code) => src.startsWith(code, i));
      if (!hit) return null;
      i += hit.length;
      out.push({ k: "err", v: hit, at: start, end: i });
      continue;
    }
    if (c === 44) {
      i++;
      out.push({ k: inArray ? "colsep" : "sep", at: start, end: i });
      continue;
    }
    if (c === 59) {
      i++;
      out.push({ k: inArray ? "rowsep" : "sep", at: start, end: i });
      continue;
    }
    if (c === 40 || c === 41) {
      i++;
      out.push({ k: c === 40 ? "lparen" : "rparen", at: start, end: i });
      continue;
    }
    if (c === 60 || c === 62) {
      const d = src.charCodeAt(i + 1);
      if (d === 61 || (c === 60 && d === 62)) {
        i += 2;
        out.push({ k: "op", v: (c === 60 ? (d === 61 ? "<=" : "<>") : ">=") as Op, at: start, end: i });
        continue;
      }
      i++;
      out.push({ k: "op", v: c === 60 ? "<" : ">", at: start, end: i });
      continue;
    }
    switch (c) {
      case 43:
      case 45:
      case 42:
      case 47:
      case 94:
      case 38:
      case 61:
      case 37:
      case 58:
        i++;
        out.push({ k: "op", v: String.fromCharCode(c) as Op, at: start, end: i });
        continue;
      default:
        return null;
    }
  }
  out.push({ k: "end", at: n, end: n });
  return out;
}

export function tokenize(src: string, opts: TokenizeOptions): Token[] {
  if (opts.canonical && !opts.loose) {
    const fast = tokenizeStored(src);
    if (fast) return fast;
  }
  const out: Token[] = [];
  const pt = opts.argSep === ";";
  let inArray = false;
  let i = 0;
  const fail = (code: "unexpected" | "unclosed_string" | "unclosed_sheet", at: number, end: number): void => {
    if (opts.loose) {
      out.push({ k: "bad", v: src.slice(at, end), at, end });
      i = end;
      return;
    }
    throw new FormulaError({ code, at, text: src.slice(at, Math.max(end, at + 1)) });
  };

  /** A reference part after an optional sheet prefix: a cell, whole columns or whole rows. */
  const refPart = (start: number, sheet: string | undefined): boolean => {
    let m = matchAt(COLS, src, i);
    if (m) {
      const a: A1Part = { row: null, col: lettersToCol(m[2] as string), absRow: false, absCol: m[1] === "$" };
      const b: A1Part = { row: null, col: lettersToCol(m[4] as string), absRow: false, absCol: m[3] === "$" };
      i += m[0].length;
      out.push(
        sheet === undefined ? { k: "a1", a, b, at: start, end: i } : { k: "a1", sheet, a, b, at: start, end: i },
      );
      return true;
    }
    m = matchAt(ROWS, src, i);
    if (m) {
      const a: A1Part = { row: Number(m[2]) - 1, col: null, absRow: m[1] === "$", absCol: false };
      const b: A1Part = { row: Number(m[4]) - 1, col: null, absRow: m[3] === "$", absCol: false };
      i += m[0].length;
      out.push(
        sheet === undefined ? { k: "a1", a, b, at: start, end: i } : { k: "a1", sheet, a, b, at: start, end: i },
      );
      return true;
    }
    m = matchAt(CELL, src, i);
    if (m) {
      const a: A1Part = {
        row: Number(m[4]) - 1,
        col: lettersToCol(m[2] as string),
        absRow: m[3] === "$",
        absCol: m[1] === "$",
      };
      i += m[0].length;
      out.push(sheet === undefined ? { k: "a1", a, at: start, end: i } : { k: "a1", sheet, a, at: start, end: i });
      return true;
    }
    return false;
  };

  /** `#REF!`, and what Excel writes for a reference that lost its sheet (`#REF!A1`, `Sheet1!#REF!`). */
  const refError = (start: number): boolean => {
    if (src.slice(i, i + 5).toUpperCase() !== "#REF!") return false;
    i += 5;
    const save = out.length;
    if (!opts.canonical && refPart(i, undefined)) out.length = save;
    out.push({ k: "err", v: "#REF!", at: start, end: i });
    return true;
  };

  while (i < src.length) {
    const c = src.charAt(i);
    const start = i;
    if (isSpace(c)) {
      while (i < src.length && isSpace(src.charAt(i))) i++;
      if (opts.loose) out.push({ k: "space", at: start, end: i });
      continue;
    }
    // Text: straight quotes with "" inside, or the curly quotes phones and Macs type.
    if (c === '"' || OPEN_QUOTES.includes(c)) {
      let text = "";
      let j = i + 1;
      let closed = false;
      if (c === '"') {
        while (j < src.length) {
          const d = src.charAt(j);
          if (d === '"') {
            if (src.charAt(j + 1) === '"') {
              text += '"';
              j += 2;
              continue;
            }
            closed = true;
            break;
          }
          text += d;
          j++;
        }
      } else {
        while (j < src.length) {
          const d = src.charAt(j);
          if (CLOSE_QUOTES.includes(d)) {
            closed = true;
            break;
          }
          text += d;
          j++;
        }
      }
      if (!closed) {
        fail("unclosed_string", start, src.length);
        continue;
      }
      i = j + 1;
      out.push({ k: "str", v: text, at: start, end: i });
      continue;
    }
    if (c === "#") {
      if (refError(start)) continue;
      const rest = src.slice(i, i + 12).toUpperCase();
      const hit = ERROR_TEXTS.find(([text]) => rest.startsWith(text));
      if (hit) {
        i += hit[0].length;
        out.push({ k: "err", v: hit[1], at: start, end: i });
        continue;
      }
      fail("unexpected", start, start + 1);
      continue;
    }
    if (c === "{") {
      if (opts.canonical && !isSpace(src.charAt(i + 1))) {
        const m = matchAt(CREF, src, i);
        if (m && ((m[3] as string).length > 0 || (m[5] as string).length > 0)) {
          const ref: CellRefId = { row: m[3] || null, col: m[5] || null };
          if (m[1]) ref.sheet = m[1];
          if (m[2] === "$" && ref.row !== null) ref.absRow = true;
          if (m[4] === "$" && ref.col !== null) ref.absCol = true;
          i += m[0].length;
          out.push({ k: "cref", ref, at: start, end: i });
          continue;
        }
        fail("unexpected", start, start + 1);
        continue;
      }
      inArray = true;
      i++;
      out.push({ k: "lbrace", at: start, end: i });
      continue;
    }
    if (c === "}") {
      inArray = false;
      i++;
      out.push({ k: "rbrace", at: start, end: i });
      continue;
    }
    if (!opts.canonical && (c === "'" || SINGLE_CURLY.includes(c))) {
      // A quoted sheet name: 'Sheet 2'!A1, with '' for a quote inside.
      let name = "";
      let j = i + 1;
      let closed = false;
      while (j < src.length) {
        const d = src.charAt(j);
        if (c === "'" ? d === "'" : SINGLE_CURLY.includes(d)) {
          if (c === "'" && src.charAt(j + 1) === "'") {
            name += "'";
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        name += d;
        j++;
      }
      if (!closed || src.charAt(j + 1) !== "!") {
        fail("unclosed_sheet", start, closed ? j + 1 : src.length);
        continue;
      }
      i = j + 2;
      if (refError(start)) continue;
      if (refPart(start, name)) continue;
      fail("unexpected", i, i + 1);
      continue;
    }
    if (!opts.canonical && (c === "$" || IDENT_START.test(c) || (c >= "0" && c <= "9"))) {
      const sheet = c === "$" || (c >= "0" && c <= "9") ? null : matchAt(SHEET_PREFIX, src, i);
      if (sheet) {
        i += sheet[0].length;
        if (refError(start)) continue;
        if (refPart(start, sheet[1])) continue;
        fail("unexpected", i, i + 1);
        continue;
      }
      if (refPart(start, undefined)) continue;
      if (c === "$") {
        fail("unexpected", start, start + 1);
        continue;
      }
    }
    if ((c >= "0" && c <= "9") || (c === opts.decimal && src.charAt(i + 1) >= "0" && src.charAt(i + 1) <= "9")) {
      const m = matchAt(opts.decimal === "," ? NUM_COMMA : NUM_DOT, src, i);
      const text = m ? m[0] : c;
      const v = Number(opts.decimal === "," ? text.replace(",", ".") : text);
      if (!Number.isFinite(v)) {
        fail("unexpected", start, start + text.length);
        continue;
      }
      i += text.length;
      out.push({ k: "num", v, at: start, end: i });
      continue;
    }
    if (IDENT_START.test(c)) {
      const m = matchAt(IDENT, src, i);
      const text = m ? m[0] : c;
      i += text.length;
      out.push({ k: "id", v: text, at: start, end: i });
      continue;
    }
    if (inArray) {
      if (c === ";") {
        i++;
        out.push({ k: "rowsep", at: start, end: i });
        continue;
      }
      if (pt ? c === "\\" || c === "." : c === ",") {
        i++;
        out.push({ k: "colsep", at: start, end: i });
        continue;
      }
    }
    if (c === opts.argSep || (!pt && c === ";")) {
      i++;
      out.push({ k: "sep", at: start, end: i });
      continue;
    }
    if (c === "(" || c === ")") {
      i++;
      out.push({ k: c === "(" ? "lparen" : "rparen", at: start, end: i });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<>" || two === "<=" || two === ">=") {
      i += 2;
      out.push({ k: "op", v: two, at: start, end: i });
      continue;
    }
    if ("+-*/^&=<>%:".includes(c)) {
      i++;
      out.push({ k: "op", v: c as Op, at: start, end: i });
      continue;
    }
    if (c === "−") {
      i++;
      out.push({ k: "op", v: "-", at: start, end: i });
      continue;
    }
    fail("unexpected", start, start + 1);
  }
  out.push({ k: "end", at: src.length, end: src.length });
  return out;
}
