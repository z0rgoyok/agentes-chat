/**
 * Math and trigonometry (ADR 0196 §2), with Excel's results: rounding half away from zero without binary noise
 * (`ROUND(2.675,2)` is 2.68), CEILING and FLOOR by the signs of both arguments, MOD with the divisor's sign, and
 * RAND seeded per cell from the document so every device shows the same numbers.
 */
import type { CellError, CellValue } from "../../values";
import { type ArrValue, type Env, ERR, isArr, isErr, isRef, type Val } from "../runtime";
import {
  cleanFloor,
  cleanTrunc,
  criteriaGrid,
  type FnSpec,
  gridOf,
  matchPositions,
  math1,
  mathN,
  num,
  numArg,
  numbersOf,
  perCriteria,
  roundTo,
  VARIADIC,
  valuesOf,
} from "./spec";

const NUMBERS = ["number1", "number2"] as const;

/** Removes the binary noise of a quotient before taking its floor or ceiling (2.1/0.1 is 21, not 21.000000000000004). */
function clean(q: number): number {
  return Number(q.toPrecision(15));
}

function power(x: number, y: number): number | CellError {
  if (x === 0 && y === 0) return ERR["#NUM!"];
  if (x === 0 && y < 0) return ERR["#DIV/0!"];
  const r = x ** y;
  return Number.isNaN(r) ? ERR["#NUM!"] : r;
}

/** SUMIF's and SUMIFS's sum: numbers at the matched positions; an error there is the result. */
function sumAt(values: ArrValue, positions: readonly number[]): CellValue {
  let s = 0;
  for (const i of positions) {
    const v = values.v[i] as CellValue;
    if (typeof v === "number") s += v;
    else if (isErr(v)) return v;
  }
  return num(s);
}

function integers(args: readonly (Val | undefined)[], env: Env): number[] | CellError {
  const xs = numbersOf(args, env);
  if (isErr(xs)) return xs;
  const out: number[] = [];
  for (const x of xs) {
    const n = cleanTrunc(x);
    if (n < 0 || n > 2 ** 53) return ERR["#NUM!"];
    out.push(n);
  }
  return out;
}

function gcd2(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

export const MATH: Record<string, FnSpec> = {
  SUM: {
    min: 1,
    max: VARIADIC,
    args: NUMBERS,
    repeat: 1,
    // The most used function, summed in place: ranges and arrays add their numbers (an error among them is the
    // result), values typed as arguments are coerced as numbersOf reads them.
    fn: (args, env) => {
      let s = 0;
      for (const a of args) {
        if (a === undefined) continue;
        if (isRef(a) || isArr(a)) {
          const values = valuesOf(a, env);
          for (let i = 0; i < values.length; i++) {
            const v = values[i];
            if (typeof v === "number") s += v;
            else if (typeof v === "object" && v !== null) return v;
          }
          continue;
        }
        const xs = numbersOf([a], env);
        if (isErr(xs)) return xs;
        for (const x of xs) s += x;
      }
      return num(s);
    },
  },
  PRODUCT: {
    min: 1,
    max: VARIADIC,
    args: NUMBERS,
    repeat: 1,
    fn: (args, env) => {
      const xs = numbersOf(args, env);
      if (isErr(xs)) return xs;
      if (xs.length === 0) return 0;
      let p = 1;
      for (const x of xs) p *= x;
      return num(p);
    },
  },
  SUMSQ: {
    min: 1,
    max: VARIADIC,
    args: NUMBERS,
    repeat: 1,
    fn: (args, env) => {
      const xs = numbersOf(args, env);
      if (isErr(xs)) return xs;
      let s = 0;
      for (const x of xs) s += x * x;
      return num(s);
    },
  },
  SUMPRODUCT: {
    min: 1,
    max: VARIADIC,
    args: ["array1", "array2"],
    repeat: 1,
    fn: (args, env) => {
      const grids = args.map((a) => gridOf(a, env));
      const first = grids[0] as ArrValue;
      for (const g of grids) if (g.rows !== first.rows || g.cols !== first.cols) return ERR["#VALUE!"];
      let s = 0;
      for (let i = 0; i < first.v.length; i++) {
        let p = 1;
        for (const g of grids) {
          const v = g.v[i] as CellValue;
          if (isErr(v)) return v;
          p *= typeof v === "number" ? v : 0;
        }
        s += p;
      }
      return num(s);
    },
  },
  SUMIF: {
    min: 2,
    max: 3,
    args: ["range", "criteria", "sum_range"],
    fn: ([range, criteria, sumRange], env) => {
      const where = criteriaGrid(range, env);
      const values = sumRange === undefined ? where : criteriaGrid(sumRange, env, where);
      if (values.rows !== where.rows || values.cols !== where.cols) return ERR["#VALUE!"];
      return perCriteria([criteria], env, ([test]) => {
        const at = matchPositions([{ range: where, test: test as (v: CellValue) => boolean }], env);
        return isErr(at) ? at : sumAt(values, at);
      });
    },
  },
  SUMIFS: {
    min: 3,
    max: VARIADIC,
    args: ["sum_range", "criteria_range1", "criteria1", "criteria_range2", "criteria2"],
    repeat: 2,
    fn: (args, env) => {
      if ((args.length - 1) % 2 !== 0) return ERR["#VALUE!"];
      const values = criteriaGrid(args[0], env);
      const ranges: ArrValue[] = [];
      const criteria: (Val | undefined)[] = [];
      for (let i = 1; i < args.length; i += 2) {
        ranges.push(criteriaGrid(args[i], env));
        criteria.push(args[i + 1]);
      }
      return perCriteria(criteria, env, (tests) => {
        const at = matchPositions(
          ranges.map((range, i) => ({ range, test: tests[i] as (v: CellValue) => boolean })),
          env,
        );
        if (isErr(at)) return at;
        if (values.rows !== (ranges[0] as ArrValue).rows || values.cols !== (ranges[0] as ArrValue).cols) {
          return ERR["#VALUE!"];
        }
        return sumAt(values, at);
      });
    },
  },
  ROUND: mathN(["number", "num_digits"], 2, [], ([x, d]) => roundTo(x as number, d as number)),
  ROUNDUP: mathN(["number", "num_digits"], 2, [], ([x, d]) => roundTo(x as number, d as number, "up")),
  ROUNDDOWN: mathN(["number", "num_digits"], 2, [], ([x, d]) => roundTo(x as number, d as number, "down")),
  TRUNC: mathN(["number", "num_digits"], 1, [0], ([x, d]) => roundTo(x as number, d as number, "down")),
  INT: math1("number", (x) => cleanFloor(x)),
  MROUND: mathN(["number", "multiple"], 2, [], ([x, m]) => {
    const n = x as number;
    const step = m as number;
    if (step === 0 || n === 0) return 0;
    if (Math.sign(n) !== Math.sign(step)) return ERR["#NUM!"];
    return roundTo(clean(n / step), 0) * step;
  }),
  CEILING: mathN(["number", "significance"], 2, [], ([x, s]) => {
    const n = x as number;
    const sig = s as number;
    if (sig === 0 || n === 0) return 0;
    if (n > 0 && sig < 0) return ERR["#NUM!"];
    return Math.ceil(clean(n / sig)) * sig;
  }),
  "CEILING.MATH": mathN(["number", "significance", "mode"], 1, [1, 0], ([x, s, mode]) => {
    const n = x as number;
    const sig = Math.abs(s as number);
    if (sig === 0 || n === 0) return 0;
    if (n < 0 && mode !== 0) return -Math.ceil(clean(-n / sig)) * sig;
    return Math.ceil(clean(n / sig)) * sig;
  }),
  "CEILING.PRECISE": mathN(["number", "significance"], 1, [1], ([x, s]) => {
    const sig = Math.abs(s as number);
    if (sig === 0) return 0;
    return Math.ceil(clean((x as number) / sig)) * sig;
  }),
  FLOOR: mathN(["number", "significance"], 2, [], ([x, s]) => {
    const n = x as number;
    const sig = s as number;
    if (n === 0) return 0;
    if (sig === 0) return ERR["#DIV/0!"];
    if (n > 0 && sig < 0) return ERR["#NUM!"];
    return Math.floor(clean(n / sig)) * sig;
  }),
  "FLOOR.MATH": mathN(["number", "significance", "mode"], 1, [1, 0], ([x, s, mode]) => {
    const n = x as number;
    const sig = Math.abs(s as number);
    if (sig === 0 || n === 0) return 0;
    if (n < 0 && mode !== 0) return -Math.floor(clean(-n / sig)) * sig;
    return Math.floor(clean(n / sig)) * sig;
  }),
  "FLOOR.PRECISE": mathN(["number", "significance"], 1, [1], ([x, s]) => {
    const sig = Math.abs(s as number);
    if (sig === 0) return 0;
    return Math.floor(clean((x as number) / sig)) * sig;
  }),
  MOD: mathN(["number", "divisor"], 2, [], ([x, d]) => {
    const n = x as number;
    const div = d as number;
    if (div === 0) return ERR["#DIV/0!"];
    const r = n - div * Math.floor(clean(n / div));
    return Math.abs(r) < Math.abs(div) * 1e-15 ? 0 : r;
  }),
  QUOTIENT: mathN(["numerator", "denominator"], 2, [], ([x, d]) => {
    if (d === 0) return ERR["#DIV/0!"];
    return cleanTrunc((x as number) / (d as number));
  }),
  ABS: math1("number", Math.abs),
  SIGN: math1("number", (x) => (x > 0 ? 1 : x < 0 ? -1 : 0)),
  POWER: mathN(["number", "power"], 2, [], ([x, y]) => power(x as number, y as number)),
  SQRT: math1("number", (x) => (x < 0 ? ERR["#NUM!"] : Math.sqrt(x))),
  SQRTPI: math1("number", (x) => (x < 0 ? ERR["#NUM!"] : Math.sqrt(x * Math.PI))),
  EXP: math1("number", Math.exp),
  LN: math1("number", (x) => (x <= 0 ? ERR["#NUM!"] : Math.log(x))),
  LOG10: math1("number", (x) => (x <= 0 ? ERR["#NUM!"] : Math.log10(x))),
  LOG: mathN(["number", "base"], 1, [10], ([x, b]) => {
    const n = x as number;
    const base = b as number;
    if (n <= 0 || base <= 0) return ERR["#NUM!"];
    if (base === 1) return ERR["#DIV/0!"];
    return base === 10 ? Math.log10(n) : Math.log(n) / Math.log(base);
  }),
  PI: { min: 0, max: 0, args: [], fn: () => Math.PI },
  RAND: {
    min: 0,
    max: 0,
    args: [],
    fn: (_args, env) => env.host.random(env, env.rand++),
  },
  RANDBETWEEN: {
    min: 2,
    max: 2,
    lift: "all",
    args: ["bottom", "top"],
    fn: ([a, b], env) => {
      const x = numArg(a, env);
      if (isErr(x)) return x;
      const y = numArg(b, env);
      if (isErr(y)) return y;
      const bottom = Math.ceil(clean(x));
      const top = Math.floor(clean(y));
      if (bottom > top) return ERR["#NUM!"];
      return bottom + Math.floor(env.host.random(env, env.rand++) * (top - bottom + 1));
    },
  },
  GCD: {
    min: 1,
    max: VARIADIC,
    args: NUMBERS,
    repeat: 1,
    fn: (args, env) => {
      const xs = integers(args, env);
      if (isErr(xs)) return xs;
      let g = 0;
      for (const x of xs) g = gcd2(g, x);
      return g;
    },
  },
  LCM: {
    min: 1,
    max: VARIADIC,
    args: NUMBERS,
    repeat: 1,
    fn: (args, env) => {
      const xs = integers(args, env);
      if (isErr(xs)) return xs;
      let l = 1;
      for (const x of xs) {
        if (x === 0) return 0;
        l = (l / gcd2(l, x)) * x;
        if (!Number.isFinite(l) || l > 2 ** 53) return ERR["#NUM!"];
      }
      return l;
    },
  },
  FACT: math1("number", (x) => {
    const n = cleanTrunc(x);
    if (n < 0) return ERR["#NUM!"];
    if (n > 170) return ERR["#NUM!"];
    let f = 1;
    for (let i = 2; i <= n; i++) f *= i;
    return f;
  }),
  COMBIN: mathN(["number", "number_chosen"], 2, [], ([x, y]) => {
    const n = cleanTrunc(x as number);
    const k = cleanTrunc(y as number);
    if (n < 0 || k < 0 || n < k) return ERR["#NUM!"];
    const m = Math.min(k, n - k);
    let c = 1;
    for (let i = 1; i <= m; i++) c = (c * (n - m + i)) / i;
    return Math.round(c);
  }),
  DEGREES: math1("angle", (x) => (x * 180) / Math.PI),
  RADIANS: math1("angle", (x) => (x * Math.PI) / 180),
  SIN: math1("number", Math.sin),
  COS: math1("number", Math.cos),
  TAN: math1("number", Math.tan),
  ASIN: math1("number", (x) => (x < -1 || x > 1 ? ERR["#NUM!"] : Math.asin(x))),
  ACOS: math1("number", (x) => (x < -1 || x > 1 ? ERR["#NUM!"] : Math.acos(x))),
  ATAN: math1("number", Math.atan),
  ATAN2: mathN(["x_num", "y_num"], 2, [], ([x, y]) => {
    if (x === 0 && y === 0) return ERR["#DIV/0!"];
    return Math.atan2(y as number, x as number);
  }),
  SINH: math1("number", Math.sinh),
  COSH: math1("number", Math.cosh),
  TANH: math1("number", Math.tanh),
  ASINH: math1("number", Math.asinh),
  ACOSH: math1("number", (x) => (x < 1 ? ERR["#NUM!"] : Math.acosh(x))),
  ATANH: math1("number", (x) => (x <= -1 || x >= 1 ? ERR["#NUM!"] : Math.atanh(x))),
  EVEN: math1("number", (x) => {
    const n = Math.ceil(clean(Math.abs(x)) / 2) * 2;
    return x < 0 ? -n : n;
  }),
  ODD: math1("number", (x) => {
    const a = Math.ceil(clean(Math.abs(x)));
    const n = a % 2 === 1 ? a : a + 1;
    return x < 0 ? -n : n;
  }),
};
