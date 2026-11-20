/**
 * Lookup, references and arrays (ADR 0196 §2). Exact matches ignore case and take Excel's wildcards where Excel does
 * (MATCH 0, VLOOKUP FALSE, XLOOKUP 2); approximate ones are Excel's binary search over sorted data. INDEX, OFFSET,
 * INDIRECT and XLOOKUP return references, so `=SUM(INDEX(A:A,2):A9)` works; INDIRECT reads A1 (or R1C1) text in
 * this document only. UNIQUE, SORT, FILTER, SEQUENCE and TRANSPOSE make arrays, whose top-left value a cell shows.
 */
import { LIVE_LIMITS } from "../../../limits";
import { parseA1Range } from "../../a1";
import type { CellError, CellValue } from "../../values";
import {
  type ArrValue,
  approxEqual,
  arrAt,
  compareValues,
  deref,
  type Env,
  ERR,
  hasWildcards,
  isArr,
  isErr,
  isRef,
  MAX_ARRAY,
  makeArr,
  type RefValue,
  spend,
  toBool,
  toNumber,
  type Val,
  wildcardRegExp,
} from "../runtime";
import type { Ast } from "../types";
import {
  cleanTrunc,
  criteriaGrid,
  type FnSpec,
  gridOf,
  numArg,
  oneOf,
  optBool,
  optNum,
  shapeOf,
  textArg,
  VARIADIC,
} from "./spec";

const MAX_ROWS = LIVE_LIMITS.spreadsheet.rows;
const MAX_COLS = LIVE_LIMITS.spreadsheet.cols;

function intArg(v: Val | undefined, env: Env): number | CellError {
  const n = numArg(v, env);
  return isErr(n) ? n : cleanTrunc(n);
}

function optInt(v: Val | undefined, env: Env, fallback: number): number | CellError {
  return v === undefined ? fallback : intArg(v, env);
}

/** Exact equality as lookups read it: numbers within rounding, text ignoring case, an empty lookup never matches. */
function same(lookup: CellValue, item: CellValue): boolean {
  if (lookup === null || item === null || isErr(item)) return false;
  if (typeof lookup !== typeof item) return false;
  if (typeof lookup === "number") return approxEqual(lookup, item as number);
  if (typeof lookup === "string") return lookup.toLowerCase() === (item as string).toLowerCase();
  return lookup === item;
}

/** The first (or last) exact match, with wildcards in text when asked; -1 when none. */
function exactIndex(lookup: CellValue, items: readonly CellValue[], wildcards: boolean, fromEnd = false): number {
  const n = items.length;
  if (typeof lookup === "string" && wildcards && hasWildcards(lookup)) {
    const re = wildcardRegExp(lookup);
    for (let k = 0; k < n; k++) {
      const i = fromEnd ? n - 1 - k : k;
      const v = items[i];
      if (typeof v === "string" && re.test(v)) return i;
    }
    return -1;
  }
  for (let k = 0; k < n; k++) {
    const i = fromEnd ? n - 1 - k : k;
    if (same(lookup, items[i] as CellValue)) return i;
  }
  return -1;
}

/**
 * Binary search over data sorted ascending (or descending): the last item ≤ the lookup (≥ when descending), skipping
 * empty cells as Excel does; -1 when none.
 */
function sortedIndex(lookup: CellValue, items: readonly CellValue[], descending: boolean): number {
  const at: number[] = [];
  for (let i = 0; i < items.length; i++) if (items[i] !== null && !isErr(items[i])) at.push(i);
  let lo = 0;
  let hi = at.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = compareValues(items[at[mid] as number] as CellValue, lookup);
    if (descending ? c >= 0 : c <= 0) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? -1 : (at[found] as number);
}

/** XLOOKUP's and XMATCH's search: `mode` 0 exact, -1 or next smaller, 1 or next larger, 2 wildcards. */
function xIndex(lookup: CellValue, items: readonly CellValue[], mode: number, search: number): number | CellError {
  if (![0, -1, 1, 2].includes(mode)) return ERR["#VALUE!"];
  if (![1, -1, 2, -2].includes(search)) return ERR["#VALUE!"];
  if (search === 2 || search === -2) {
    const i = sortedIndex(lookup, items, search === -2);
    if (i >= 0 && same(lookup, items[i] as CellValue)) return i;
    if (mode === 0 || mode === 2) return -1;
    if (mode === -1) return search === 2 ? i : nextIndex(lookup, items, -1, 1);
    return nextIndex(lookup, items, 1, 1);
  }
  const exact = exactIndex(lookup, items, mode === 2, search === -1);
  if (exact >= 0 || mode === 0 || mode === 2) return exact;
  return nextIndex(lookup, items, mode, search);
}

/** The closest item below (`dir` -1) or above (1) the lookup, of the lookup's own type. */
function nextIndex(lookup: CellValue, items: readonly CellValue[], dir: number, search: number): number {
  let best = -1;
  const n = items.length;
  for (let k = 0; k < n; k++) {
    const i = search === -1 ? n - 1 - k : k;
    const v = items[i] as CellValue;
    if (v === null || isErr(v) || typeof v !== typeof lookup) continue;
    const c = compareValues(v, lookup);
    if (dir < 0 ? c >= 0 : c <= 0) continue;
    if (best < 0) best = i;
    else {
      const d = compareValues(v, items[best] as CellValue);
      if (dir < 0 ? d > 0 : d < 0) best = i;
    }
  }
  return best;
}

/** A row (index `i`) or column of a reference or array, as a reference when it was one. */
function slice(v: Val | undefined, env: Env, i: number, row: boolean): Val {
  if (v !== undefined && isRef(v)) {
    return row
      ? { k: "ref", sheet: v.sheet, r1: v.r1 + i, c1: v.c1, r2: v.r1 + i, c2: v.c2 }
      : { k: "ref", sheet: v.sheet, r1: v.r1, c1: v.c1 + i, r2: v.r2, c2: v.c1 + i };
  }
  const g = gridOf(v, env);
  const out: CellValue[] = [];
  if (row) for (let c = 0; c < g.cols; c++) out.push(g.v[i * g.cols + c] as CellValue);
  else for (let r = 0; r < g.rows; r++) out.push(g.v[r * g.cols + i] as CellValue);
  return row ? makeArr(1, g.cols, out) : makeArr(g.rows, 1, out);
}

/** The items of a one-row or one-column argument; null when it has both several rows and several columns. */
function vectorOf(v: Val | undefined, env: Env): CellValue[] | null {
  const { rows, cols } = shapeOf(v);
  if (rows > 1 && cols > 1) return null;
  return gridOf(v, env).v;
}

/** VLOOKUP and HLOOKUP: search the first column (row) of the table, read from the `index`th. */
function tableLookup(vertical: boolean): FnSpec {
  return {
    min: 3,
    max: 4,
    lift: [0],
    args: vertical
      ? ["lookup_value", "table_array", "col_index_num", "range_lookup"]
      : ["lookup_value", "table_array", "row_index_num", "range_lookup"],
    fn: ([lookupArg, table, indexArg, approxArg], env) => {
      const lookup = oneOf(lookupArg, env);
      if (isErr(lookup)) return lookup;
      const index = intArg(indexArg, env);
      if (isErr(index)) return index;
      const approx = optBool(approxArg, env, true);
      if (isErr(approx)) return approx;
      if (index < 1) return ERR["#VALUE!"];
      const { rows, cols } = shapeOf(table);
      if (index > (vertical ? cols : rows)) return ERR["#REF!"];
      const keys = gridOf(slice(table, env, 0, !vertical), env).v;
      const i = approx ? sortedIndex(lookup, keys, false) : exactIndex(lookup, keys, true);
      if (i < 0) return ERR["#N/A"];
      if (table !== undefined && isRef(table)) {
        return vertical
          ? env.host.cell(table.sheet, table.r1 + i, table.c1 + index - 1)
          : env.host.cell(table.sheet, table.r1 + index - 1, table.c1 + i);
      }
      const g = gridOf(table, env);
      return (vertical ? g.v[i * g.cols + index - 1] : g.v[(index - 1) * g.cols + i]) as CellValue;
    },
  };
}

function rowsOrCols(isRow: boolean): FnSpec {
  return {
    min: 0,
    max: 1,
    args: ["reference"],
    fn: ([ref], env) => {
      if (ref === undefined) return (isRow ? env.row : env.col) + 1;
      if (!isRef(ref)) return isErr(ref) ? ref : ERR["#VALUE!"];
      const a = isRow ? ref.r1 : ref.c1;
      const b = isRow ? ref.r2 : ref.c2;
      if (a === b) return a + 1;
      const out: CellValue[] = [];
      for (let i = a; i <= b; i++) out.push(i + 1);
      return isRow ? makeArr(out.length, 1, out) : makeArr(1, out.length, out);
    },
  };
}

/** Sort order for SORT: numbers, then text, then booleans, then errors; empty cells always last. */
function sortCompare(a: CellValue, b: CellValue): number {
  const rank = (v: CellValue) =>
    typeof v === "number" ? 0 : typeof v === "string" ? 1 : typeof v === "boolean" ? 2 : 3;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 3) return 0;
  return compareValues(a, b);
}

function uniqueKey(v: CellValue): string {
  if (v === null) return "e";
  if (typeof v === "number") return `n${Number(v.toPrecision(15))}`;
  if (typeof v === "string") return `s${v.toLowerCase()}`;
  if (typeof v === "boolean") return v ? "bt" : "bf";
  return `x${v.error}`;
}

/** Rows (or columns) of a grid as lists of values. */
function lines(g: ArrValue, byCol: boolean): CellValue[][] {
  const out: CellValue[][] = [];
  if (byCol) {
    for (let c = 0; c < g.cols; c++) {
      const line: CellValue[] = [];
      for (let r = 0; r < g.rows; r++) line.push(g.v[r * g.cols + c] as CellValue);
      out.push(line);
    }
  } else {
    for (let r = 0; r < g.rows; r++) out.push(g.v.slice(r * g.cols, (r + 1) * g.cols) as CellValue[]);
  }
  return out;
}

function fromLines(list: readonly CellValue[][], byCol: boolean): ArrValue {
  const n = list.length;
  const m = list[0]?.length ?? 0;
  if (!byCol) return makeArr(n, m, list.flat());
  const out = new Array<CellValue>(n * m);
  for (let c = 0; c < n; c++) for (let r = 0; r < m; r++) out[r * n + c] = (list[c] as CellValue[])[r] as CellValue;
  return makeArr(m, n, out);
}

/** A1 or R1C1 text to the reference it names in this document; `#REF!` when it names nothing. */
function indirect(text: string, a1: boolean, env: Env): Val {
  let sheetName: string | undefined;
  let r1: number;
  let c1: number;
  let r2: number;
  let c2: number;
  let whole: "rows" | "cols" | undefined;
  if (a1) {
    const range = parseA1Range(text);
    if (!range) return ERR["#REF!"];
    sheetName = range.sheet;
    ({ r1, c1, r2, c2 } = range);
    whole = range.whole;
  } else {
    const parsed = parseR1C1(text, env);
    if (!parsed) return ERR["#REF!"];
    ({ sheet: sheetName, r1, c1, r2, c2 } = parsed);
  }
  const sheet = sheetName === undefined ? env.sheet : env.host.sheetByName(sheetName);
  if (sheet === null) return ERR["#REF!"];
  const size = env.host.size(sheet);
  if (!size) return ERR["#REF!"];
  if (whole === "cols") {
    if (size.rows === 0) return ERR["#REF!"];
    r1 = 0;
    r2 = size.rows - 1;
  } else if (whole === "rows") {
    if (size.cols === 0) return ERR["#REF!"];
    c1 = 0;
    c2 = size.cols - 1;
  }
  if (r1 < 0 || c1 < 0 || r2 >= MAX_ROWS || c2 >= MAX_COLS) return ERR["#REF!"];
  return { k: "ref", sheet, r1, c1, r2, c2 };
}

const R1C1_PART = /^R(\[-?\d+\]|\d+)?C(\[-?\d+\]|\d+)?$/i;

function parseR1C1(text: string, env: Env): { sheet?: string; r1: number; c1: number; r2: number; c2: number } | null {
  let body = text.trim();
  let sheet: string | undefined;
  const bang = body.lastIndexOf("!");
  if (bang >= 0) {
    sheet = body.slice(0, bang).trim();
    if (sheet.startsWith("'") && sheet.endsWith("'") && sheet.length >= 2)
      sheet = sheet.slice(1, -1).replace(/''/g, "'");
    body = body.slice(bang + 1).trim();
  }
  const part = (p: string): { r: number; c: number } | null => {
    const m = R1C1_PART.exec(p.trim());
    if (!m) return null;
    const read = (s: string | undefined, here: number) => {
      if (s === undefined) return here;
      if (s.startsWith("[")) return here + Number(s.slice(1, -1));
      return Number(s) - 1;
    };
    return { r: read(m[1], env.row), c: read(m[2], env.col) };
  };
  const [a, b] = body.split(":");
  const pa = part(a ?? "");
  const pb = b === undefined ? pa : part(b);
  if (!pa || !pb) return null;
  const out = {
    r1: Math.min(pa.r, pb.r),
    c1: Math.min(pa.c, pb.c),
    r2: Math.max(pa.r, pb.r),
    c2: Math.max(pa.c, pb.c),
  };
  return sheet === undefined ? out : { sheet, ...out };
}

export const LOOKUP: Record<string, FnSpec> = {
  VLOOKUP: tableLookup(true),
  HLOOKUP: tableLookup(false),
  LOOKUP: {
    min: 2,
    max: 3,
    lift: [0],
    args: ["lookup_value", "lookup_vector", "result_vector"],
    fn: ([lookupArg, where, result], env) => {
      const lookup = oneOf(lookupArg, env);
      if (isErr(lookup)) return lookup;
      let keys: CellValue[];
      let values: CellValue[];
      if (result === undefined) {
        const { rows, cols } = shapeOf(where);
        const byRow = cols > rows;
        keys = gridOf(slice(where, env, 0, byRow), env).v;
        values = gridOf(slice(where, env, byRow ? rows - 1 : cols - 1, byRow), env).v;
      } else {
        keys = vectorOf(where, env) ?? gridOf(where, env).v;
        // A result range shorter than the lookup range reads on past its end, in its own direction, as in Excel.
        const rs = shapeOf(result);
        const across = rs.rows === 1 && rs.cols > 1;
        values =
          isRef(result) && (rs.rows === 1 || rs.cols === 1)
            ? criteriaGrid(result, env, across ? { rows: 1, cols: keys.length } : { rows: keys.length, cols: 1 }).v
            : gridOf(result, env).v;
      }
      const i = sortedIndex(lookup, keys, false);
      if (i < 0) return ERR["#N/A"];
      return i < values.length ? (values[i] as CellValue) : ERR["#N/A"];
    },
  },
  MATCH: {
    min: 2,
    max: 3,
    lift: [0],
    args: ["lookup_value", "lookup_array", "match_type"],
    fn: ([lookupArg, where, typeArg], env) => {
      const lookup = oneOf(lookupArg, env);
      if (isErr(lookup)) return lookup;
      const type = optNum(typeArg, env, 1);
      if (isErr(type)) return type;
      const items = vectorOf(where, env);
      if (!items) return ERR["#N/A"];
      const i = type === 0 ? exactIndex(lookup, items, true) : sortedIndex(lookup, items, type < 0);
      return i < 0 ? ERR["#N/A"] : i + 1;
    },
  },
  XMATCH: {
    min: 2,
    max: 4,
    lift: [0],
    omit: true,
    args: ["lookup_value", "lookup_array", "match_mode", "search_mode"],
    fn: ([lookupArg, where, modeArg, searchArg], env) => {
      const lookup = oneOf(lookupArg, env);
      if (isErr(lookup)) return lookup;
      const mode = optInt(modeArg, env, 0);
      if (isErr(mode)) return mode;
      const search = optInt(searchArg, env, 1);
      if (isErr(search)) return search;
      const items = vectorOf(where, env);
      if (!items) return ERR["#VALUE!"];
      const i = xIndex(lookup, items, mode, search);
      if (isErr(i)) return i;
      return i < 0 ? ERR["#N/A"] : i + 1;
    },
  },
  XLOOKUP: {
    min: 3,
    max: 6,
    lift: [0],
    omit: true,
    args: ["lookup_value", "lookup_array", "return_array", "if_not_found", "match_mode", "search_mode"],
    fn: ([lookupArg, where, result, notFound, modeArg, searchArg], env) => {
      const lookup = oneOf(lookupArg, env);
      if (isErr(lookup)) return lookup;
      const mode = optInt(modeArg, env, 0);
      if (isErr(mode)) return mode;
      const search = optInt(searchArg, env, 1);
      if (isErr(search)) return search;
      const shape = shapeOf(where);
      if (shape.rows > 1 && shape.cols > 1) return ERR["#VALUE!"];
      const vertical = shape.cols === 1 && shape.rows >= 1 && !(shape.rows === 1 && shapeOf(result).rows > 1);
      const rs = shapeOf(result);
      const len = vertical ? shape.rows : shape.cols;
      if ((vertical ? rs.rows : rs.cols) !== len) return ERR["#VALUE!"];
      const items = gridOf(where, env).v;
      const i = xIndex(lookup, items, mode, search);
      if (isErr(i)) return i;
      if (i < 0) return notFound === undefined ? ERR["#N/A"] : deref(notFound, env);
      return slice(result, env, i, vertical);
    },
  },
  INDEX: {
    min: 2,
    max: 4,
    args: ["array", "row_num", "column_num", "area_num"],
    fn: ([array, rowArg, colArg, areaArg], env) => {
      if (array !== undefined && isErr(array)) return array;
      if (areaArg !== undefined) {
        const area = intArg(areaArg, env);
        if (isErr(area)) return area;
        if (area !== 1) return ERR["#REF!"];
      }
      let r = intArg(rowArg, env);
      if (isErr(r)) return r;
      let c: number;
      const { rows, cols } = shapeOf(array);
      if (colArg === undefined) {
        if (rows === 1 && cols > 1) {
          c = r;
          r = 1;
        } else c = cols === 1 ? 1 : 0;
      } else {
        const cv = intArg(colArg, env);
        if (isErr(cv)) return cv;
        c = cv;
      }
      if (r < 0 || c < 0) return ERR["#VALUE!"];
      if (r > rows || c > cols) return ERR["#REF!"];
      if (array !== undefined && isRef(array)) {
        return {
          k: "ref",
          sheet: array.sheet,
          r1: r === 0 ? array.r1 : array.r1 + r - 1,
          r2: r === 0 ? array.r2 : array.r1 + r - 1,
          c1: c === 0 ? array.c1 : array.c1 + c - 1,
          c2: c === 0 ? array.c2 : array.c1 + c - 1,
        } satisfies RefValue;
      }
      const g = gridOf(array, env);
      if (r > 0 && c > 0) return g.v[(r - 1) * g.cols + c - 1] as CellValue;
      if (r > 0) return slice(g, env, r - 1, true);
      if (c > 0) return slice(g, env, c - 1, false);
      return g;
    },
  },
  CHOOSE: {
    min: 2,
    max: VARIADIC,
    args: ["index_num", "value1", "value2"],
    repeat: 1,
    lazy: (args, env) => {
      const pick = (i: number): Val => {
        const a = args[i] as Ast;
        return a.t === "missing" ? 0 : env.evaluate(a, env);
      };
      const index = deref(env.evaluate(args[0] as Ast, env), env);
      const one = (v: CellValue): number | CellError => {
        if (isErr(v)) return v;
        const n = toNumber(v, env.calc);
        if (isErr(n)) return n;
        const k = cleanTrunc(n);
        return k < 1 || k >= args.length ? ERR["#VALUE!"] : k;
      };
      if (!isArr(index)) {
        const k = one(index);
        return isErr(k) ? k : pick(k);
      }
      const values = new Map<number, CellValue | ArrValue>();
      const out: CellValue[] = [];
      spend(env, index.v.length);
      for (let r = 0; r < index.rows; r++) {
        for (let c = 0; c < index.cols; c++) {
          const k = one(arrAt(index, r, c));
          if (isErr(k)) {
            out.push(k);
            continue;
          }
          let v = values.get(k);
          if (v === undefined) {
            v = deref(pick(k), env);
            values.set(k, v);
          }
          out.push(isArr(v) ? arrAt(v, r, c) : v);
        }
      }
      return makeArr(index.rows, index.cols, out);
    },
  },
  ROW: rowsOrCols(true),
  COLUMN: rowsOrCols(false),
  ROWS: {
    min: 1,
    max: 1,
    args: ["array"],
    fn: ([v]) => (v !== undefined && isErr(v) ? v : shapeOf(v).rows),
  },
  COLUMNS: {
    min: 1,
    max: 1,
    args: ["array"],
    fn: ([v]) => (v !== undefined && isErr(v) ? v : shapeOf(v).cols),
  },
  OFFSET: {
    min: 3,
    max: 5,
    omit: true,
    args: ["reference", "rows", "cols", "height", "width"],
    fn: ([ref, rowsArg, colsArg, hArg, wArg], env) => {
      if (ref === undefined || !isRef(ref)) return ref !== undefined && isErr(ref) ? ref : ERR["#VALUE!"];
      const dr = intArg(rowsArg, env);
      if (isErr(dr)) return dr;
      const dc = intArg(colsArg, env);
      if (isErr(dc)) return dc;
      const h = optInt(hArg, env, ref.r2 - ref.r1 + 1);
      if (isErr(h)) return h;
      const w = optInt(wArg, env, ref.c2 - ref.c1 + 1);
      if (isErr(w)) return w;
      if (h < 1 || w < 1) return ERR["#REF!"];
      const r1 = ref.r1 + dr;
      const c1 = ref.c1 + dc;
      const r2 = r1 + h - 1;
      const c2 = c1 + w - 1;
      if (r1 < 0 || c1 < 0 || r2 >= MAX_ROWS || c2 >= MAX_COLS) return ERR["#REF!"];
      if (!env.host.size(ref.sheet)) return ERR["#REF!"];
      return { k: "ref", sheet: ref.sheet, r1, c1, r2, c2 };
    },
  },
  INDIRECT: {
    min: 1,
    max: 2,
    args: ["ref_text", "a1"],
    fn: ([textValue, a1Arg], env) => {
      const text = textArg(textValue, env);
      if (isErr(text)) return text;
      const a1 = optBool(a1Arg, env, true);
      if (isErr(a1)) return a1;
      return indirect(text, a1, env);
    },
  },
  TRANSPOSE: {
    min: 1,
    max: 1,
    args: ["array"],
    fn: ([v], env) => {
      const g = gridOf(v, env);
      spend(env, g.v.length);
      const out = new Array<CellValue>(g.v.length);
      for (let r = 0; r < g.rows; r++)
        for (let c = 0; c < g.cols; c++) out[c * g.rows + r] = g.v[r * g.cols + c] as CellValue;
      return makeArr(g.cols, g.rows, out);
    },
  },
  UNIQUE: {
    min: 1,
    max: 3,
    omit: true,
    args: ["array", "by_col", "exactly_once"],
    fn: ([v, byColArg, onceArg], env) => {
      const byCol = optBool(byColArg, env, false);
      if (isErr(byCol)) return byCol;
      const once = optBool(onceArg, env, false);
      if (isErr(once)) return once;
      const all = lines(gridOf(v, env), byCol);
      spend(env, all.length);
      const counts = new Map<string, number>();
      const keys = all.map((line) => line.map(uniqueKey).join("\u0000"));
      for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
      const seen = new Set<string>();
      const kept: CellValue[][] = [];
      all.forEach((line, i) => {
        const k = keys[i] as string;
        if (seen.has(k)) return;
        seen.add(k);
        if (!once || counts.get(k) === 1) kept.push(line);
      });
      return kept.length === 0 ? ERR["#CALC!"] : fromLines(kept, byCol);
    },
  },
  SORT: {
    min: 1,
    max: 4,
    omit: true,
    args: ["array", "sort_index", "sort_order", "by_col"],
    fn: ([v, indexArg, orderArg, byColArg], env) => {
      const index = optInt(indexArg, env, 1);
      if (isErr(index)) return index;
      const order = optInt(orderArg, env, 1);
      if (isErr(order)) return order;
      const byCol = optBool(byColArg, env, false);
      if (isErr(byCol)) return byCol;
      if (order !== 1 && order !== -1) return ERR["#VALUE!"];
      const all = lines(gridOf(v, env), byCol);
      const width = all[0]?.length ?? 0;
      if (index < 1 || index > width) return ERR["#VALUE!"];
      spend(env, all.length * Math.max(1, Math.ceil(Math.log2(all.length + 1))));
      const sortedLines = all
        .map((line, i) => ({ line, i }))
        .sort((a, b) => {
          const x = a.line[index - 1] as CellValue;
          const y = b.line[index - 1] as CellValue;
          if (x === null || y === null) return x === y ? a.i - b.i : x === null ? 1 : -1;
          return order * sortCompare(x, y) || a.i - b.i;
        })
        .map((e) => e.line);
      return fromLines(sortedLines, byCol);
    },
  },
  FILTER: {
    min: 2,
    max: 3,
    omit: true,
    args: ["array", "include", "if_empty"],
    fn: ([v, includeArg, ifEmpty], env) => {
      const g = gridOf(v, env);
      const inc = gridOf(includeArg, env);
      let byRow: boolean;
      if (inc.cols === 1 && inc.rows === g.rows) byRow = true;
      else if (inc.rows === 1 && inc.cols === g.cols) byRow = false;
      else return ERR["#VALUE!"];
      const all = lines(g, !byRow);
      const kept: CellValue[][] = [];
      for (let i = 0; i < all.length; i++) {
        const flag = inc.v[i] as CellValue;
        if (isErr(flag)) return flag;
        const b = flag === null ? false : toBool(flag);
        if (isErr(b)) return b;
        if (b) kept.push(all[i] as CellValue[]);
      }
      if (kept.length === 0) return ifEmpty === undefined ? ERR["#CALC!"] : deref(ifEmpty, env);
      return fromLines(kept, !byRow);
    },
  },
  SEQUENCE: {
    min: 1,
    max: 4,
    omit: true,
    args: ["rows", "columns", "start", "step"],
    fn: ([rowsArg, colsArg, startArg, stepArg], env) => {
      const rows = optInt(rowsArg, env, 1);
      if (isErr(rows)) return rows;
      const cols = optInt(colsArg, env, 1);
      if (isErr(cols)) return cols;
      const start = optNum(startArg, env, 1);
      if (isErr(start)) return start;
      const step = optNum(stepArg, env, 1);
      if (isErr(step)) return step;
      if (rows < 1 || cols < 1) return ERR["#CALC!"];
      if (rows * cols > MAX_ARRAY) return ERR["#NUM!"];
      spend(env, rows * cols);
      const out = new Array<CellValue>(rows * cols);
      for (let i = 0; i < rows * cols; i++) out[i] = start + step * i;
      return makeArr(rows, cols, out);
    },
  },
};
