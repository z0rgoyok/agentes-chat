/**
 * Information about values (ADR 0196 §2): the IS functions take errors as values and answer for each item of a range,
 * ISBLANK is true only for a cell with nothing in it (not for "" a formula returned), and TYPE and ERROR.TYPE give
 * Excel's codes.
 */
import type { CellValue, ErrorCode } from "../../values";
import { ERR, isArr, isErr, isRef, textToNumber, type Val } from "../runtime";
import { cleanTrunc, type FnSpec, oneOf } from "./spec";

function is(f: (v: CellValue) => boolean): FnSpec {
  return { min: 1, max: 1, lift: "all", takesErrors: true, args: ["value"], fn: ([v]) => f((v ?? null) as CellValue) };
}

function parity(odd: boolean): FnSpec {
  return {
    min: 1,
    max: 1,
    lift: "all",
    args: ["number"],
    fn: ([v], env) => {
      const x = (v ?? null) as CellValue;
      if (typeof x === "boolean") return ERR["#VALUE!"];
      const n = typeof x === "string" ? textToNumber(x, env.calc) : x === null ? 0 : (x as number);
      if (n === null) return ERR["#VALUE!"];
      const even = Math.abs(cleanTrunc(n)) % 2 === 0;
      return odd ? !even : even;
    },
  };
}

const ERROR_TYPES: Partial<Record<ErrorCode, number>> = {
  "#NULL!": 1,
  "#DIV/0!": 2,
  "#VALUE!": 3,
  "#REF!": 4,
  "#NAME?": 5,
  "#NUM!": 6,
  "#N/A": 7,
  "#SPILL!": 9,
  "#CALC!": 14,
  "#CYCLE!": 4,
};

function typeOf(v: Val | undefined): number {
  if (v === undefined) return 1;
  if (isRef(v)) return v.r1 === v.r2 && v.c1 === v.c2 ? 0 : 64;
  if (isArr(v)) return 64;
  if (v === null || typeof v === "number") return 1;
  if (typeof v === "string") return 2;
  if (typeof v === "boolean") return 4;
  return 16;
}

export const INFO: Record<string, FnSpec> = {
  ISBLANK: is((v) => v === null),
  ISNUMBER: is((v) => typeof v === "number"),
  ISTEXT: is((v) => typeof v === "string"),
  ISNONTEXT: is((v) => typeof v !== "string"),
  ISLOGICAL: is((v) => typeof v === "boolean"),
  ISERROR: is((v) => isErr(v)),
  ISERR: is((v) => isErr(v) && v.error !== "#N/A"),
  ISNA: is((v) => isErr(v) && v.error === "#N/A"),
  ISEVEN: parity(false),
  ISODD: parity(true),
  ISREF: { min: 1, max: 1, args: ["value"], fn: ([v]) => v !== undefined && isRef(v) },
  ISFORMULA: {
    min: 1,
    max: 1,
    args: ["reference"],
    fn: ([v], env) => {
      if (v !== undefined && isErr(v)) return v;
      if (v === undefined || !isRef(v)) return ERR["#VALUE!"];
      return env.host.formula(v.sheet, v.r1, v.c1) !== undefined;
    },
  },
  NA: { min: 0, max: 0, args: [], fn: () => ERR["#N/A"] },
  TYPE: {
    min: 1,
    max: 1,
    args: ["value"],
    fn: ([v], env) => {
      const t = typeOf(v);
      return t === 0 ? typeOf(oneOf(v, env)) : t;
    },
  },
  "ERROR.TYPE": {
    min: 1,
    max: 1,
    args: ["error_val"],
    fn: ([v], env) => {
      const x = oneOf(v, env);
      return isErr(x) ? (ERROR_TYPES[x.error] ?? ERR["#N/A"]) : ERR["#N/A"];
    },
  },
};
