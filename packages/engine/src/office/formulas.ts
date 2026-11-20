import { colIndexOf, colName, MAX_A1_COLS, MAX_A1_ROWS } from "@agenteschat/live";

/**
 * Excel's formulas as files hold them (ADR 0198): A1 references, English names, `,` between arguments, no "=". A
 * shared formula is written once and reused down a range, each copy moved by its offset (`shiftA1`); functions newer
 * than Excel 2007 carry a `_xlfn.` prefix in the file (`stripFunctionPrefixes` when reading, `addFunctionPrefixes`
 * when writing, or Excel shows `#NAME?`).
 */

/** Functions Excel stores as `_xlfn.NAME` (newer than the file format), and the two it stores as `_xlfn._xlws.NAME`. */
const XLFN = new Set([
  "AGGREGATE",
  "BITAND",
  "BITOR",
  "BITXOR",
  "CEILING.MATH",
  "CEILING.PRECISE",
  "CONCAT",
  "COVARIANCE.P",
  "COVARIANCE.S",
  "DAYS",
  "FLOOR.MATH",
  "FLOOR.PRECISE",
  "FORECAST.LINEAR",
  "IFNA",
  "IFS",
  "ISFORMULA",
  "ISOWEEKNUM",
  "LET",
  "MAXIFS",
  "MINIFS",
  "MODE.MULT",
  "MODE.SNGL",
  "NORM.DIST",
  "NORM.INV",
  "NORM.S.DIST",
  "NUMBERVALUE",
  "PERCENTILE.EXC",
  "PERCENTILE.INC",
  "QUARTILE.EXC",
  "QUARTILE.INC",
  "RANDARRAY",
  "RANK.AVG",
  "RANK.EQ",
  "SEQUENCE",
  "SHEET",
  "SHEETS",
  "SORTBY",
  "STDEV.P",
  "STDEV.S",
  "SWITCH",
  "TEXTAFTER",
  "TEXTBEFORE",
  "TEXTJOIN",
  "TEXTSPLIT",
  "UNIQUE",
  "VAR.P",
  "VAR.S",
  "XLOOKUP",
  "XMATCH",
  "XOR",
]);
const XLWS = new Set(["FILTER", "SORT"]);

const PREFIX = /^(?:_xlfn\.|_xlws\.|_xlpm\.)+/i;

/** A formula as written in a file, as the apps read it: no leading "=", no `_xlfn.`-style prefixes. */
export function stripFunctionPrefixes(formula: string): string {
  const text = formula.trim().replace(/^=/, "");
  if (!/_xl(?:fn|ws|pm)\./i.test(text)) return text;
  return mapWords(text, (word) => word.replace(PREFIX, ""));
}

/** A formula as Excel wants it in a file: newer functions with their prefix. */
export function addFunctionPrefixes(formula: string): string {
  return mapWords(formula, (word, call) => {
    if (!call) return word;
    const name = word.toUpperCase();
    if (XLWS.has(name)) return `_xlfn._xlws.${word}`;
    return XLFN.has(name) ? `_xlfn.${word}` : word;
  });
}

const REF = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/;
const COL_ONLY = /^(\$?)([A-Za-z]{1,3})$/;
const ROWS = /^(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![\w.(])/;

/**
 * Walks a formula's tokens, handing each word (a name, a reference, a function) to `map` with whether a call follows
 * it, and copying everything else (strings, quoted sheet names, structured references, errors, numbers) untouched.
 */
function mapWords(
  formula: string,
  map: (word: string, call: boolean, rest: string) => string,
  rows?: (match: RegExpExecArray) => string,
): string {
  let out = "";
  let i = 0;
  const n = formula.length;
  while (i < n) {
    const ch = formula.charAt(i);
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (formula.charAt(j) === '"') {
          if (formula.charAt(j + 1) === '"') j += 2;
          else break;
        } else j++;
      }
      out += formula.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (formula.charAt(j) === "'") {
          if (formula.charAt(j + 1) === "'") j += 2;
          else break;
        } else j++;
      }
      out += formula.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "[") {
      let depth = 0;
      let j = i;
      for (; j < n; j++) {
        const c = formula.charAt(j);
        if (c === "[") depth++;
        else if (c === "]" && --depth === 0) break;
      }
      out += formula.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "#") {
      const m = /^#[A-Za-z0-9/]+[!?]?/.exec(formula.slice(i));
      const token = m ? m[0] : ch;
      out += token;
      i += token.length;
      continue;
    }
    if (/[0-9$]/.test(ch) && rows) {
      const m = ROWS.exec(formula.slice(i));
      const before = out.charAt(out.length - 1);
      if (m && !/[\w.]/.test(before)) {
        out += rows(m);
        i += m[0].length;
        continue;
      }
    }
    if (/[0-9.]/.test(ch) && !/[A-Za-z_$]/.test(out.charAt(out.length - 1))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(formula.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_\\$]/.test(ch)) {
      const m = /^[A-Za-z_\\$][\w.$]*/.exec(formula.slice(i)) as RegExpExecArray;
      const word = m[0];
      let j = i + word.length;
      while (j < n && formula.charAt(j) === " ") j++;
      const call = formula.charAt(j) === "(";
      out += map(word, call, formula.slice(i + word.length));
      i += word.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * A formula moved `dr` rows and `dc` columns, as Excel moves a shared formula to each cell of its range: relative
 * parts of references move, `$` parts stay; a reference moved off the sheet becomes `#REF!`.
 */
export function shiftA1(formula: string, dr: number, dc: number): string {
  if (dr === 0 && dc === 0) return formula;
  const col = (abs: string, letters: string): string | null => {
    const index = colIndexOf(letters.toUpperCase());
    const moved = abs ? index : index + dc;
    return moved < 0 || moved >= MAX_A1_COLS ? null : `${abs}${colName(moved)}`;
  };
  const row = (abs: string, digits: string): string | null => {
    const index = Number(digits) - 1;
    const moved = abs ? index : index + dr;
    return moved < 0 || moved >= MAX_A1_ROWS ? null : `${abs}${moved + 1}`;
  };
  let pendingColumn = false;
  return mapWords(
    formula,
    (word, call, rest) => {
      if (call || rest.startsWith("!")) return word;
      const ref = REF.exec(word);
      if (ref) {
        const c = col(ref[1] as string, ref[2] as string);
        const r = row(ref[3] as string, ref[4] as string);
        return c === null || r === null ? "#REF!" : c + r;
      }
      // A whole-column range (`A:C`): both sides are bare column letters around a colon.
      const only = COL_ONLY.exec(word);
      if (only && (rest.startsWith(":") || pendingColumn)) {
        pendingColumn = rest.startsWith(":");
        const c = col(only[1] as string, only[2] as string);
        return c ?? "#REF!";
      }
      pendingColumn = false;
      return word;
    },
    (m) => {
      const a = row(m[1] as string, m[2] as string);
      const b = row(m[3] as string, m[4] as string);
      return a === null || b === null ? "#REF!" : `${a}:${b}`;
    },
  );
}
