/**
 * How a spreadsheet function is described (ADR 0196 §2) and the helpers the categories share: reading numbers the way
 * SUM does, arguments that take one value each, criteria (">=10", "maçã*") over ranges, and results that must be
 * finite.
 */
import type { CellError, CellValue } from "../../values";
import {
  type ArrValue,
  arrAt,
  type Criterion,
  deref,
  type Env,
  ERR,
  isArr,
  isErr,
  isRef,
  MAX_ARRAY,
  makeArr,
  makeCriterion,
  type RefValue,
  spend,
  textToNumber,
  toBool,
  toNumber,
  toText,
  type Val,
} from "../runtime";
import type { Ast } from "../types";

export interface FnSpec {
  min: number;
  /** `VARIADIC` for Excel's up-to-255 arguments. */
  max: number;
  /**
   * Parameters that take one value: an array or a range there runs the function once per item and makes an array
   * (Excel's lifting, as in `=LEN(A1:A9)`). They arrive as plain values, with an error among them returned at once
   * unless `takesErrors`.
   */
  lift?: "all" | readonly number[];
  takesErrors?: boolean;
  /**
   * An empty argument (`=SEQUENCE(3,,5)`) arrives as `undefined`, the same as one left out, so it takes its default;
   * without this it arrives as an empty value (0, "" or FALSE), as Excel's older functions read it.
   */
  omit?: boolean;
  /** Arguments evaluated; an argument left out is `undefined`. */
  fn?: (args: Val[], env: Env) => Val;
  /** Arguments arrive unevaluated (IF, IFERROR, CHOOSE…), so only the branch taken runs. */
  lazy?: (args: readonly Ast[], env: Env) => Val;
  /** i18n keys, under `live.sheet.args`, of the arguments shown while typing. */
  args: readonly string[];
  /** How many of the last arguments repeat (1 for SUM's number, 2 for SUMIFS's range and criteria). */
  repeat?: number;
}

export const VARIADIC = 255;

/** A finite number, or `#NUM!`; never -0. */
export function num(n: number): CellValue {
  if (!Number.isFinite(n)) return ERR["#NUM!"];
  return n === 0 ? 0 : n;
}

export function numArg(v: Val | undefined, env: Env): number | CellError {
  if (v === undefined) return 0;
  const d = deref(v, env);
  return toNumber(isArr(d) ? (d.v[0] ?? null) : d, env.calc);
}

export function textArg(v: Val | undefined, env: Env): string | CellError {
  if (v === undefined) return "";
  const d = deref(v, env);
  return toText(isArr(d) ? (d.v[0] ?? null) : d, env.calc);
}

export function boolArg(v: Val | undefined, env: Env): boolean | CellError {
  if (v === undefined) return false;
  const d = deref(v, env);
  return toBool(isArr(d) ? (d.v[0] ?? null) : d);
}

/** An optional number: `fallback` when left out. */
export function optNum(v: Val | undefined, env: Env, fallback: number): number | CellError {
  return v === undefined ? fallback : numArg(v, env);
}

/** An optional boolean: `fallback` when left out. */
export function optBool(v: Val | undefined, env: Env, fallback: boolean): boolean | CellError {
  return v === undefined ? fallback : boolArg(v, env);
}

/** One value of an argument (a range's or array's top-left). */
export function oneOf(v: Val | undefined, env: Env): CellValue {
  if (v === undefined) return null;
  const d = deref(v, env);
  return isArr(d) ? (d.v[0] ?? null) : d;
}

/** A function of one number, lifted over arrays. */
export function math1(arg: string, f: (x: number) => number | CellError): FnSpec {
  return {
    min: 1,
    max: 1,
    lift: "all",
    args: [arg],
    fn: ([a], env) => {
      const x = numArg(a, env);
      if (isErr(x)) return x;
      const r = f(x);
      return isErr(r) ? r : num(r);
    },
  };
}

/** A function of numbers (optional ones default as given), lifted over arrays. */
export function mathN(
  args: readonly string[],
  min: number,
  defaults: readonly number[],
  f: (xs: number[]) => number | CellError,
): FnSpec {
  return {
    min,
    max: args.length,
    lift: "all",
    args,
    fn: (vals, env) => {
      const xs: number[] = [];
      for (let i = 0; i < args.length; i++) {
        if (i >= vals.length || vals[i] === undefined) {
          xs.push(defaults[i - min] ?? 0);
          continue;
        }
        const x = numArg(vals[i], env);
        if (isErr(x)) return x;
        xs.push(x);
      }
      const r = f(xs);
      return isErr(r) ? r : num(r);
    },
  };
}

/** Every value of an argument: a reference's or array's items (row by row), or the value itself. */
export function valuesOf(v: Val | undefined, env: Env): CellValue[] {
  if (v === undefined) return [];
  if (isRef(v)) {
    spend(env, (v.r2 - v.r1 + 1) * (v.c2 - v.c1 + 1));
    return env.host.range(v).v;
  }
  if (isArr(v)) return v.v;
  return [v];
}

/**
 * Numbers as SUM, AVERAGE and the statistics read them. In references and arrays only numbers count (with `a`, as
 * AVERAGEA does, TRUE is 1 and text 0); values typed as arguments are coerced (TRUE is 1, "3" is 3, other text is
 * `#VALUE!`). The first error stops it, unless `skipErrors`.
 */
export function numbersOf(
  args: readonly (Val | undefined)[],
  env: Env,
  opts?: { a?: boolean; skipErrors?: boolean },
): number[] | CellError {
  const out: number[] = [];
  for (const arg of args) {
    if (arg === undefined) continue;
    if (isRef(arg) || isArr(arg)) {
      for (const v of valuesOf(arg, env)) {
        if (typeof v === "number") out.push(v);
        else if (v === null) continue;
        else if (isErr(v)) {
          if (!opts?.skipErrors) return v;
        } else if (opts?.a) out.push(typeof v === "boolean" ? (v ? 1 : 0) : 0);
      }
      continue;
    }
    const v = arg as CellValue;
    if (typeof v === "number") out.push(v);
    else if (v === null) out.push(0);
    else if (typeof v === "boolean") out.push(v ? 1 : 0);
    else if (isErr(v)) {
      if (!opts?.skipErrors) return v;
    } else {
      const n = textToNumber(v, env.calc);
      if (n === null) {
        if (!opts?.skipErrors) return ERR["#VALUE!"];
      } else out.push(n);
    }
  }
  return out;
}

/** An array argument's numbers only (LARGE's array, PERCENTILE's array…): errors stop it, the rest is skipped. */
export function arrayNumbers(arg: Val | undefined, env: Env): number[] | CellError {
  if (arg === undefined) return [];
  if (!isRef(arg) && !isArr(arg)) {
    const n = numArg(arg, env);
    return isErr(n) ? n : [n];
  }
  const out: number[] = [];
  for (const v of valuesOf(arg, env)) {
    if (typeof v === "number") out.push(v);
    else if (isErr(v)) return v;
  }
  return out;
}

/** The dimensions of an argument (a reference, an array or one value). */
export function shapeOf(v: Val | undefined): { rows: number; cols: number } {
  if (v !== undefined && isRef(v)) return { rows: v.r2 - v.r1 + 1, cols: v.c2 - v.c1 + 1 };
  if (v !== undefined && isArr(v)) return { rows: v.rows, cols: v.cols };
  return { rows: 1, cols: 1 };
}

/** Values of an argument row by row with its shape. */
export function gridOf(v: Val | undefined, env: Env): ArrValue {
  if (v === undefined) return makeArr(1, 1, [null]);
  if (isArr(v)) return v;
  if (isRef(v)) {
    spend(env, (v.r2 - v.r1 + 1) * (v.c2 - v.c1 + 1));
    return env.host.range(v);
  }
  return makeArr(1, 1, [v]);
}

export function tooBig(rows: number, cols: number): boolean {
  return rows < 1 || cols < 1 || rows * cols > MAX_ARRAY;
}

/** Rounds to `digits` decimals (negative: tens, hundreds…), half away from zero, without binary noise (2.675 → 2.68). */
export function roundTo(x: number, digits: number, mode: "half" | "up" | "down" = "half"): number {
  const d = Math.trunc(digits);
  if (d > 15) return x;
  if (d < -308) return 0;
  const f = 10 ** Math.abs(d);
  const scaled = d >= 0 ? x * f : x / f;
  const clean = Number(Math.abs(scaled).toPrecision(15));
  let r: number;
  if (mode === "half") r = Math.floor(clean + 0.5);
  else if (mode === "up") r = Math.ceil(clean);
  else r = Math.floor(clean);
  const signed = scaled < 0 ? -r : r;
  const out = d >= 0 ? signed / f : signed * f;
  return out === 0 ? 0 : out;
}

/** Floor after removing binary noise, as INT and TRUNC see their argument. */
export function cleanFloor(x: number): number {
  return Math.floor(Number(x.toPrecision(15)));
}

/** Truncation toward zero after removing binary noise. */
export function cleanTrunc(x: number): number {
  return Math.trunc(Number(x.toPrecision(15)));
}

/** A criteria range's values with its shape; a range resized from its top-left to `shape` when given (SUMIF's sum). */
export function criteriaGrid(v: Val | undefined, env: Env, shape?: { rows: number; cols: number }): ArrValue {
  if (shape && v !== undefined && isRef(v)) {
    const ref: RefValue = {
      k: "ref",
      sheet: v.sheet,
      r1: v.r1,
      c1: v.c1,
      r2: v.r1 + shape.rows - 1,
      c2: v.c1 + shape.cols - 1,
    };
    return gridOf(ref, env);
  }
  return gridOf(v, env);
}

/**
 * The positions (row-major, in the first range's shape) where every (range, criterion) pair holds, for COUNTIFS,
 * SUMIFS and the rest; `#VALUE!` when the ranges differ in shape.
 */
export function matchPositions(pairs: readonly { range: ArrValue; test: Criterion }[], env: Env): number[] | CellError {
  const first = pairs[0];
  if (!first) return [];
  const { rows, cols } = first.range;
  for (const p of pairs) if (p.range.rows !== rows || p.range.cols !== cols) return ERR["#VALUE!"];
  const n = rows * cols;
  spend(env, n * pairs.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let ok = true;
    for (const p of pairs) {
      if (!p.test(p.range.v[i] as CellValue)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * Runs `f` once per criterion, or once per item when criteria are arrays or ranges (`=COUNTIF(A:A,C1:C3)` is three
 * counts), broadcasting them together.
 */
export function perCriteria(
  criteria: readonly (Val | undefined)[],
  env: Env,
  f: (tests: Criterion[]) => CellValue,
): Val {
  const vals = criteria.map((c) => (c === undefined ? null : deref(c, env)));
  let rows = 1;
  let cols = 1;
  let any = false;
  for (const v of vals) {
    if (isArr(v)) {
      any = true;
      rows = Math.max(rows, v.rows);
      cols = Math.max(cols, v.cols);
    }
  }
  if (!any) return f(vals.map((v) => makeCriterion(v as CellValue, env.calc)));
  if (rows * cols > MAX_ARRAY) return ERR["#NUM!"];
  const out: CellValue[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push(f(vals.map((v) => makeCriterion(isArr(v) ? arrAt(v, r, c) : (v as CellValue), env.calc))));
    }
  }
  return makeArr(rows, cols, out);
}

/** The first error among values, if any. */
export function firstError(values: readonly CellValue[]): CellError | null {
  for (const v of values) if (isErr(v)) return v;
  return null;
}
