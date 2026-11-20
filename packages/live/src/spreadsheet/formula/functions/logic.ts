/**
 * Logic (ADR 0196 §2). IF, IFS, IFERROR, IFNA and SWITCH run only the branch they take, so `=IF(A1=0,0,1/A1)` never
 * divides by zero and an expensive branch not taken costs nothing; given an array as the condition they decide item
 * by item. AND, OR and XOR read booleans and numbers in ranges and skip text, as Excel does.
 */
import type { CellError, CellValue } from "../../values";
import {
  type ArrValue,
  arrAt,
  deref,
  type Env,
  ERR,
  isArr,
  isErr,
  isRef,
  MAX_ARRAY,
  makeArr,
  sameValue,
  spend,
  toBool,
  type Val,
} from "../runtime";
import type { Ast } from "../types";
import { type FnSpec, oneOf, VARIADIC, valuesOf } from "./spec";

/** An argument's value; an empty one (`=IF(A1,,"x")`) is 0, as in Excel. */
function arg(args: readonly Ast[], i: number, env: Env, fallback: Val): Val {
  const a = args[i];
  if (a === undefined) return fallback;
  if (a.t === "missing") return 0;
  return env.evaluate(a, env);
}

/** Item by item over several values and arrays, broadcasting single rows and columns. */
function each(values: readonly (CellValue | ArrValue)[], env: Env, f: (items: CellValue[]) => CellValue): Val {
  let rows = 1;
  let cols = 1;
  for (const v of values) {
    if (isArr(v)) {
      rows = Math.max(rows, v.rows);
      cols = Math.max(cols, v.cols);
    }
  }
  if (rows * cols > MAX_ARRAY) return ERR["#NUM!"];
  spend(env, rows * cols);
  const out = new Array<CellValue>(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out[r * cols + c] = f(values.map((v) => (isArr(v) ? arrAt(v, r, c) : v)));
    }
  }
  return makeArr(rows, cols, out);
}

function decide(cond: CellValue): boolean | CellError {
  if (isErr(cond)) return cond;
  return toBool(cond);
}

/** Booleans as AND, OR and XOR read them; `#VALUE!` when there is none. */
function logicals(args: readonly (Val | undefined)[], env: Env): boolean[] | CellError {
  const out: boolean[] = [];
  for (const a of args) {
    if (a === undefined) continue;
    if (isRef(a) || isArr(a)) {
      for (const v of valuesOf(a, env)) {
        if (isErr(v)) return v;
        if (typeof v === "boolean") out.push(v);
        else if (typeof v === "number") out.push(v !== 0);
      }
      continue;
    }
    const b = toBool(a as CellValue);
    if (isErr(b)) return b;
    out.push(b);
  }
  return out.length === 0 ? ERR["#VALUE!"] : out;
}

function catching(only: "#N/A" | null): FnSpec {
  return {
    min: 2,
    max: 2,
    args: ["value", only ? "value_if_na" : "value_if_error"],
    lazy: (args, env) => {
      const caught = (v: CellValue) => isErr(v) && (only === null || v.error === only);
      const v = deref(env.evaluate(args[0] as Ast, env), env);
      if (isArr(v)) {
        if (!v.v.some((x) => caught(x as CellValue))) return v;
        const alt = deref(arg(args, 1, env, 0), env);
        return each([v, alt], env, ([x, y]) => (caught(x as CellValue) ? (y as CellValue) : (x as CellValue)));
      }
      return caught(v) ? arg(args, 1, env, 0) : v;
    },
  };
}

export const LOGIC: Record<string, FnSpec> = {
  IF: {
    min: 1,
    max: 3,
    args: ["logical_test", "value_if_true", "value_if_false"],
    lazy: (args, env) => {
      const cond = deref(env.evaluate(args[0] as Ast, env), env);
      if (isArr(cond)) {
        const yes = deref(arg(args, 1, env, true), env);
        const no = deref(arg(args, 2, env, false), env);
        return each([cond, yes, no], env, ([c, y, n]) => {
          const b = decide(c as CellValue);
          return isErr(b) ? b : b ? (y as CellValue) : (n as CellValue);
        });
      }
      const b = decide(cond);
      if (isErr(b)) return b;
      return b ? arg(args, 1, env, true) : arg(args, 2, env, false);
    },
  },
  IFS: {
    min: 2,
    max: VARIADIC,
    args: ["logical_test1", "value_if_true1", "logical_test2", "value_if_true2"],
    repeat: 2,
    lazy: (args, env) => {
      if (args.length % 2 !== 0) return ERR["#N/A"];
      for (let i = 0; i < args.length; i += 2) {
        const b = decide(oneOf(env.evaluate(args[i] as Ast, env), env));
        if (isErr(b)) return b;
        if (b) return arg(args, i + 1, env, 0);
      }
      return ERR["#N/A"];
    },
  },
  IFERROR: catching(null),
  IFNA: catching("#N/A"),
  AND: {
    min: 1,
    max: VARIADIC,
    args: ["logical1", "logical2"],
    repeat: 1,
    fn: (args, env) => {
      const bs = logicals(args, env);
      return isErr(bs) ? bs : bs.every(Boolean);
    },
  },
  OR: {
    min: 1,
    max: VARIADIC,
    args: ["logical1", "logical2"],
    repeat: 1,
    fn: (args, env) => {
      const bs = logicals(args, env);
      return isErr(bs) ? bs : bs.some(Boolean);
    },
  },
  XOR: {
    min: 1,
    max: VARIADIC,
    args: ["logical1", "logical2"],
    repeat: 1,
    fn: (args, env) => {
      const bs = logicals(args, env);
      return isErr(bs) ? bs : bs.filter(Boolean).length % 2 === 1;
    },
  },
  NOT: {
    min: 1,
    max: 1,
    lift: "all",
    args: ["logical"],
    fn: ([v]) => {
      const b = toBool((v ?? null) as CellValue);
      return isErr(b) ? b : !b;
    },
  },
  SWITCH: {
    min: 3,
    max: VARIADIC,
    args: ["expression", "value1", "result1", "default_or_value2", "result2"],
    repeat: 2,
    lazy: (args, env) => {
      const expr = oneOf(env.evaluate(args[0] as Ast, env), env);
      if (isErr(expr)) return expr;
      const rest = args.length - 1;
      const pairs = Math.floor(rest / 2);
      for (let i = 0; i < pairs; i++) {
        const value = oneOf(arg(args, 1 + 2 * i, env, null), env);
        if (isErr(value)) return value;
        if (sameValue(expr, value)) return arg(args, 2 + 2 * i, env, 0);
      }
      return rest % 2 === 1 ? arg(args, args.length - 1, env, 0) : ERR["#N/A"];
    },
  },
  TRUE: { min: 0, max: 0, args: [], fn: () => true },
  FALSE: { min: 0, max: 0, args: [], fn: () => false },
};
