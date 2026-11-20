/**
 * Statistics (ADR 0196 §2), counting the way Excel does: in ranges only numbers count (the "A" variants also count
 * TRUE as 1 and text as 0), values typed as arguments are coerced, the *IF and *IFS functions read criteria, and the
 * sample measures need two numbers (`#DIV/0!` otherwise).
 */
import type { CellError, CellValue } from "../../values";
import { type ArrValue, type Env, ERR, isArr, isErr, isRef, makeArr, textToNumber, type Val } from "../runtime";
import {
  arrayNumbers,
  cleanTrunc,
  criteriaGrid,
  type FnSpec,
  gridOf,
  matchPositions,
  num,
  numArg,
  numbersOf,
  oneOf,
  optNum,
  perCriteria,
  VARIADIC,
  valuesOf,
} from "./spec";

const VALUES = ["value1", "value2"] as const;
const NUMBERS = ["number1", "number2"] as const;

function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

function mean(xs: readonly number[]): number {
  return sum(xs) / xs.length;
}

/** Sum of squared deviations from the mean, in two passes for accuracy. */
function devsq(xs: readonly number[]): number {
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s;
}

function variance(xs: readonly number[], sample: boolean): CellValue {
  const n = xs.length;
  if (n === 0 || (sample && n < 2)) return ERR["#DIV/0!"];
  return num(devsq(xs) / (sample ? n - 1 : n));
}

function stdev(xs: readonly number[], sample: boolean): CellValue {
  const v = variance(xs, sample);
  return typeof v === "number" ? num(Math.sqrt(v)) : v;
}

function sorted(xs: readonly number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

function median(xs: readonly number[]): CellValue {
  if (xs.length === 0) return ERR["#NUM!"];
  const s = sorted(xs);
  const mid = s.length >> 1;
  return num(s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

function mode(xs: readonly number[]): CellValue {
  const counts = new Map<number, number>();
  let best: number | null = null;
  let bestCount = 1;
  for (const x of xs) {
    const c = (counts.get(x) ?? 0) + 1;
    counts.set(x, c);
  }
  // The first value, in the data's order, among the most frequent ones.
  for (const x of xs) {
    const c = counts.get(x) ?? 0;
    if (c > bestCount) {
      best = x;
      bestCount = c;
    }
  }
  return best === null ? ERR["#N/A"] : best;
}

function percentileInc(xs: readonly number[], k: number): CellValue {
  if (xs.length === 0 || k < 0 || k > 1) return ERR["#NUM!"];
  const s = sorted(xs);
  const pos = k * (s.length - 1);
  const lo = Math.floor(pos);
  const frac = pos - lo;
  const a = s[lo] as number;
  const b = s[Math.min(lo + 1, s.length - 1)] as number;
  return num(a + frac * (b - a));
}

function percentileExc(xs: readonly number[], k: number): CellValue {
  const n = xs.length;
  if (n === 0 || k <= 0 || k >= 1) return ERR["#NUM!"];
  const pos = k * (n + 1) - 1;
  if (pos < 0 || pos > n - 1) return ERR["#NUM!"];
  const s = sorted(xs);
  const lo = Math.floor(pos);
  const frac = pos - lo;
  const a = s[lo] as number;
  const b = s[Math.min(lo + 1, n - 1)] as number;
  return num(a + frac * (b - a));
}

function count(args: readonly (Val | undefined)[], env: Env): number {
  let n = 0;
  for (const a of args) {
    if (a === undefined) continue;
    if (isRef(a) || isArr(a)) {
      for (const v of valuesOf(a, env)) if (typeof v === "number") n++;
      continue;
    }
    const v = a as CellValue;
    if (typeof v === "number" || typeof v === "boolean") n++;
    else if (typeof v === "string" && textToNumber(v, env.calc) !== null) n++;
  }
  return n;
}

function counta(args: readonly (Val | undefined)[], env: Env): number {
  let n = 0;
  for (const a of args) {
    if (a === undefined) continue;
    if (isRef(a) || isArr(a)) {
      for (const v of valuesOf(a, env)) if (v !== null) n++;
      continue;
    }
    n++;
  }
  return n;
}

function numbersSpec(f: (xs: number[]) => CellValue, opts?: { a?: boolean }): FnSpec {
  return {
    min: 1,
    max: VARIADIC,
    args: opts?.a ? VALUES : NUMBERS,
    repeat: 1,
    fn: (args, env) => {
      const xs = numbersOf(args, env, opts);
      return isErr(xs) ? xs : f(xs);
    },
  };
}

/** Number pairs of two equally sized arguments where both items are numbers; `#N/A` when the sizes differ. */
function pairs(ys: Val | undefined, xs: Val | undefined, env: Env): { y: number[]; x: number[] } | CellError {
  const gy = gridOf(ys, env);
  const gx = gridOf(xs, env);
  if (gy.v.length !== gx.v.length) return ERR["#N/A"];
  const y: number[] = [];
  const x: number[] = [];
  for (let i = 0; i < gy.v.length; i++) {
    const a = gy.v[i] as CellValue;
    const b = gx.v[i] as CellValue;
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    if (typeof a === "number" && typeof b === "number") {
      y.push(a);
      x.push(b);
    }
  }
  return { y, x };
}

interface Fit {
  slope: number;
  intercept: number;
  r: number | null;
}

function fit(p: { y: number[]; x: number[] }): Fit | CellError {
  const n = p.x.length;
  if (n === 0) return ERR["#DIV/0!"];
  const mx = mean(p.x);
  const my = mean(p.y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (p.x[i] as number) - mx;
    const dy = (p.y[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0) return ERR["#DIV/0!"];
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r: syy === 0 ? null : sxy / Math.sqrt(sxx * syy) };
}

function covariance(p: { y: number[]; x: number[] }, sample: boolean): CellValue {
  const n = p.x.length;
  if (n === 0 || (sample && n < 2)) return ERR["#DIV/0!"];
  const mx = mean(p.x);
  const my = mean(p.y);
  let s = 0;
  for (let i = 0; i < n; i++) s += ((p.x[i] as number) - mx) * ((p.y[i] as number) - my);
  return num(s / (sample ? n - 1 : n));
}

function correl(ys: Val | undefined, xs: Val | undefined, env: Env): CellValue {
  const p = pairs(ys, xs, env);
  if (isErr(p)) return p;
  if (p.x.length < 2) return ERR["#DIV/0!"];
  const f = fit(p);
  if (isErr(f)) return f;
  return f.r === null ? ERR["#DIV/0!"] : num(f.r);
}

function largeSmall(large: boolean): FnSpec {
  return {
    min: 2,
    max: 2,
    lift: [1],
    args: ["array", "k"],
    fn: ([array, kArg], env) => {
      const xs = arrayNumbers(array, env);
      if (isErr(xs)) return xs;
      const kv = numArg(kArg, env);
      if (isErr(kv)) return kv;
      const k = Math.ceil(Number(kv.toPrecision(15)));
      if (k < 1 || k > xs.length) return ERR["#NUM!"];
      const s = sorted(xs);
      return (large ? s[s.length - k] : s[k - 1]) as number;
    },
  };
}

function rank(avg: boolean): FnSpec {
  return {
    min: 2,
    max: 3,
    lift: [0],
    args: ["number", "ref", "order"],
    fn: ([numberArg, ref, orderArg], env) => {
      const x = numArg(numberArg, env);
      if (isErr(x)) return x;
      const xs = arrayNumbers(ref, env);
      if (isErr(xs)) return xs;
      const order = optNum(orderArg, env, 0);
      if (isErr(order)) return order;
      const target = Number(x.toPrecision(15));
      let before = 0;
      let same = 0;
      for (const v of xs) {
        const c = Number(v.toPrecision(15));
        if (c === target) same++;
        else if (order === 0 ? c > target : c < target) before++;
      }
      if (same === 0) return ERR["#N/A"];
      return avg ? before + (same + 1) / 2 : before + 1;
    },
  };
}

function quartile(exc: boolean): FnSpec {
  return {
    min: 2,
    max: 2,
    lift: [1],
    args: ["array", "quart"],
    fn: ([array, q], env) => {
      const xs = arrayNumbers(array, env);
      if (isErr(xs)) return xs;
      const qv = numArg(q, env);
      if (isErr(qv)) return qv;
      const quart = cleanTrunc(qv);
      if (exc ? quart < 1 || quart > 3 : quart < 0 || quart > 4) return ERR["#NUM!"];
      return exc ? percentileExc(xs, quart / 4) : percentileInc(xs, quart / 4);
    },
  };
}

function percentile(exc: boolean): FnSpec {
  return {
    min: 2,
    max: 2,
    lift: [1],
    args: ["array", "k"],
    fn: ([array, k], env) => {
      const xs = arrayNumbers(array, env);
      if (isErr(xs)) return xs;
      const kv = numArg(k, env);
      if (isErr(kv)) return kv;
      return exc ? percentileExc(xs, kv) : percentileInc(xs, kv);
    },
  };
}

function percentRank(): FnSpec {
  return {
    min: 2,
    max: 3,
    lift: [1, 2],
    args: ["array", "x", "significance"],
    fn: ([array, xArg, sigArg], env) => {
      const xs = arrayNumbers(array, env);
      if (isErr(xs)) return xs;
      const x = numArg(xArg, env);
      if (isErr(x)) return x;
      const sig = optNum(sigArg, env, 3);
      if (isErr(sig)) return sig;
      const digits = cleanTrunc(sig);
      if (digits < 1) return ERR["#NUM!"];
      if (xs.length === 0) return ERR["#NUM!"];
      const s = sorted(xs);
      const n = s.length;
      if (x < (s[0] as number) || x > (s[n - 1] as number)) return ERR["#N/A"];
      if (n === 1) return 1;
      let below = 0;
      while (below < n && (s[below] as number) < x) below++;
      let r: number;
      if (below < n && s[below] === x) r = below / (n - 1);
      else {
        const lo = s[below - 1] as number;
        const hi = s[below] as number;
        r = (below - 1 + (x - lo) / (hi - lo)) / (n - 1);
      }
      const f = 10 ** digits;
      return Math.floor(Number((r * f).toPrecision(15))) / f;
    },
  };
}

/** The *IFS family's ranges and criteria, from `start` on in pairs. */
function criteriaPairs(
  args: readonly (Val | undefined)[],
  start: number,
  env: Env,
): { ranges: ArrValue[]; criteria: (Val | undefined)[] } | CellError {
  if ((args.length - start) % 2 !== 0 || args.length <= start) return ERR["#VALUE!"];
  const ranges: ArrValue[] = [];
  const criteria: (Val | undefined)[] = [];
  for (let i = start; i < args.length; i += 2) {
    ranges.push(criteriaGrid(args[i], env));
    criteria.push(args[i + 1]);
  }
  return { ranges, criteria };
}

/** Numbers of `values` at the positions where every criterion holds, for AVERAGEIFS, MINIFS and MAXIFS. */
function ifsNumbers(
  values: ArrValue,
  ranges: readonly ArrValue[],
  tests: readonly ((v: CellValue) => boolean)[],
  env: Env,
): number[] | CellError {
  const first = ranges[0];
  if (first && (values.rows !== first.rows || values.cols !== first.cols)) return ERR["#VALUE!"];
  const at = matchPositions(
    ranges.map((range, i) => ({ range, test: tests[i] as (v: CellValue) => boolean })),
    env,
  );
  if (isErr(at)) return at;
  const out: number[] = [];
  for (const i of at) {
    const v = values.v[i] as CellValue;
    if (typeof v === "number") out.push(v);
    else if (isErr(v)) return v;
  }
  return out;
}

function ifsSpec(name: string, f: (xs: number[]) => CellValue): FnSpec {
  return {
    min: 3,
    max: VARIADIC,
    args: [name, "criteria_range1", "criteria1", "criteria_range2", "criteria2"],
    repeat: 2,
    fn: (args, env) => {
      const values = criteriaGrid(args[0], env);
      const p = criteriaPairs(args, 1, env);
      if (isErr(p)) return p;
      return perCriteria(p.criteria, env, (tests) => {
        const xs = ifsNumbers(values, p.ranges, tests, env);
        return isErr(xs) ? xs : f(xs);
      });
    },
  };
}

/** SUBTOTAL's codes (1–11, and 101–111 that also skip hidden rows, which a live sheet doesn't have). */
const SUBTOTALS: Record<number, (xs: number[], args: readonly (Val | undefined)[], env: Env) => CellValue> = {
  1: (xs) => (xs.length === 0 ? ERR["#DIV/0!"] : num(mean(xs))),
  2: (_xs, args, env) => count(args, env),
  3: (_xs, args, env) => counta(args, env),
  4: (xs) => minMax(xs, true),
  5: (xs) => minMax(xs, false),
  6: (xs) => (xs.length === 0 ? 0 : num(xs.reduce((p, x) => p * x, 1))),
  7: (xs) => stdev(xs, true),
  8: (xs) => stdev(xs, false),
  9: (xs) => num(sum(xs)),
  10: (xs) => variance(xs, true),
  11: (xs) => variance(xs, false),
};

/** A reference's values with the cells that are themselves subtotals left out, so totals don't count twice. */
function withoutSubtotals(v: Val | undefined, env: Env): Val | undefined {
  if (v === undefined || !isRef(v)) return v;
  const grid = gridOf(v, env);
  const out = grid.v.slice();
  let i = 0;
  for (let r = v.r1; r <= v.r2; r++) {
    for (let c = v.c1; c <= v.c2; c++, i++) {
      const f = env.host.formula(v.sheet, r, c);
      if (f !== undefined && /(^|[^A-Z0-9_.])(SUBTOTAL|AGGREGATE)\(/i.test(f)) out[i] = null;
    }
  }
  return makeArr(grid.rows, grid.cols, out);
}

function minMax(xs: readonly number[], max: boolean): number {
  if (xs.length === 0) return 0;
  let m = xs[0] as number;
  for (const x of xs) if (max ? x > m : x < m) m = x;
  return m;
}

export const STATS: Record<string, FnSpec> = {
  AVERAGE: numbersSpec((xs) => (xs.length === 0 ? ERR["#DIV/0!"] : num(mean(xs)))),
  AVERAGEA: numbersSpec((xs) => (xs.length === 0 ? ERR["#DIV/0!"] : num(mean(xs))), { a: true }),
  AVERAGEIF: {
    min: 2,
    max: 3,
    args: ["range", "criteria", "average_range"],
    fn: ([range, criteria, avgRange], env) => {
      const where = criteriaGrid(range, env);
      const values = avgRange === undefined ? where : criteriaGrid(avgRange, env, where);
      return perCriteria([criteria], env, ([test]) => {
        const xs = ifsNumbers(values, [where], [test as (v: CellValue) => boolean], env);
        if (isErr(xs)) return xs;
        return xs.length === 0 ? ERR["#DIV/0!"] : num(mean(xs));
      });
    },
  },
  AVERAGEIFS: ifsSpec("average_range", (xs) => (xs.length === 0 ? ERR["#DIV/0!"] : num(mean(xs)))),
  MINIFS: ifsSpec("min_range", (xs) => minMax(xs, false)),
  MAXIFS: ifsSpec("max_range", (xs) => minMax(xs, true)),
  COUNT: { min: 1, max: VARIADIC, args: VALUES, repeat: 1, fn: (args, env) => count(args, env) },
  COUNTA: { min: 1, max: VARIADIC, args: VALUES, repeat: 1, fn: (args, env) => counta(args, env) },
  COUNTBLANK: {
    min: 1,
    max: 1,
    args: ["range"],
    fn: ([range], env) => {
      if (range !== undefined && !isRef(range) && !isArr(range)) return ERR["#VALUE!"];
      let n = 0;
      for (const v of valuesOf(range, env)) if (v === null || v === "") n++;
      return n;
    },
  },
  COUNTIF: {
    min: 2,
    max: 2,
    args: ["range", "criteria"],
    fn: ([range, criteria], env) => {
      const where = criteriaGrid(range, env);
      return perCriteria([criteria], env, ([test]) => {
        const at = matchPositions([{ range: where, test: test as (v: CellValue) => boolean }], env);
        return isErr(at) ? at : at.length;
      });
    },
  },
  COUNTIFS: {
    min: 2,
    max: VARIADIC,
    args: ["criteria_range1", "criteria1", "criteria_range2", "criteria2"],
    repeat: 2,
    fn: (args, env) => {
      const p = criteriaPairs(args, 0, env);
      if (isErr(p)) return p;
      return perCriteria(p.criteria, env, (tests) => {
        const at = matchPositions(
          p.ranges.map((range, i) => ({ range, test: tests[i] as (v: CellValue) => boolean })),
          env,
        );
        return isErr(at) ? at : at.length;
      });
    },
  },
  MIN: numbersSpec((xs) => minMax(xs, false)),
  MAX: numbersSpec((xs) => minMax(xs, true)),
  MINA: numbersSpec((xs) => minMax(xs, false), { a: true }),
  MAXA: numbersSpec((xs) => minMax(xs, true), { a: true }),
  MEDIAN: numbersSpec(median),
  MODE: numbersSpec(mode),
  "MODE.SNGL": numbersSpec(mode),
  STDEV: numbersSpec((xs) => stdev(xs, true)),
  "STDEV.S": numbersSpec((xs) => stdev(xs, true)),
  "STDEV.P": numbersSpec((xs) => stdev(xs, false)),
  STDEVP: numbersSpec((xs) => stdev(xs, false)),
  STDEVA: numbersSpec((xs) => stdev(xs, true), { a: true }),
  VAR: numbersSpec((xs) => variance(xs, true)),
  "VAR.S": numbersSpec((xs) => variance(xs, true)),
  "VAR.P": numbersSpec((xs) => variance(xs, false)),
  VARP: numbersSpec((xs) => variance(xs, false)),
  VARA: numbersSpec((xs) => variance(xs, true), { a: true }),
  DEVSQ: numbersSpec((xs) => (xs.length === 0 ? ERR["#NUM!"] : num(devsq(xs)))),
  AVEDEV: numbersSpec((xs) => {
    if (xs.length === 0) return ERR["#NUM!"];
    const m = mean(xs);
    let s = 0;
    for (const x of xs) s += Math.abs(x - m);
    return num(s / xs.length);
  }),
  GEOMEAN: numbersSpec((xs) => {
    if (xs.length === 0 || xs.some((x) => x <= 0)) return ERR["#NUM!"];
    let s = 0;
    for (const x of xs) s += Math.log(x);
    return num(Math.exp(s / xs.length));
  }),
  HARMEAN: numbersSpec((xs) => {
    if (xs.length === 0 || xs.some((x) => x <= 0)) return ERR["#NUM!"];
    let s = 0;
    for (const x of xs) s += 1 / x;
    return num(xs.length / s);
  }),
  TRIMMEAN: {
    min: 2,
    max: 2,
    args: ["array", "percent"],
    fn: ([array, p], env) => {
      const xs = arrayNumbers(array, env);
      if (isErr(xs)) return xs;
      const pct = numArg(p, env);
      if (isErr(pct)) return pct;
      if (pct < 0 || pct >= 1 || xs.length === 0) return ERR["#NUM!"];
      const cut = Math.floor((xs.length * pct) / 2);
      const kept = sorted(xs).slice(cut, xs.length - cut);
      return kept.length === 0 ? ERR["#NUM!"] : num(mean(kept));
    },
  },
  STANDARDIZE: {
    min: 3,
    max: 3,
    lift: "all",
    args: ["x", "mean", "standard_dev"],
    fn: ([x, m, sd], env) => {
      const a = numArg(x, env);
      if (isErr(a)) return a;
      const b = numArg(m, env);
      if (isErr(b)) return b;
      const c = numArg(sd, env);
      if (isErr(c)) return c;
      return c <= 0 ? ERR["#NUM!"] : num((a - b) / c);
    },
  },
  LARGE: largeSmall(true),
  SMALL: largeSmall(false),
  RANK: rank(false),
  "RANK.EQ": rank(false),
  "RANK.AVG": rank(true),
  PERCENTILE: percentile(false),
  "PERCENTILE.INC": percentile(false),
  "PERCENTILE.EXC": percentile(true),
  QUARTILE: quartile(false),
  "QUARTILE.INC": quartile(false),
  "QUARTILE.EXC": quartile(true),
  PERCENTRANK: percentRank(),
  "PERCENTRANK.INC": percentRank(),
  CORREL: { min: 2, max: 2, args: ["array1", "array2"], fn: ([a, b], env) => correl(a, b, env) },
  PEARSON: { min: 2, max: 2, args: ["array1", "array2"], fn: ([a, b], env) => correl(a, b, env) },
  RSQ: {
    min: 2,
    max: 2,
    args: ["known_ys", "known_xs"],
    fn: ([a, b], env) => {
      const r = correl(a, b, env);
      return typeof r === "number" ? num(r * r) : r;
    },
  },
  SLOPE: {
    min: 2,
    max: 2,
    args: ["known_ys", "known_xs"],
    fn: ([ys, xs], env) => {
      const p = pairs(ys, xs, env);
      if (isErr(p)) return p;
      const f = fit(p);
      return isErr(f) ? f : num(f.slope);
    },
  },
  INTERCEPT: {
    min: 2,
    max: 2,
    args: ["known_ys", "known_xs"],
    fn: ([ys, xs], env) => {
      const p = pairs(ys, xs, env);
      if (isErr(p)) return p;
      const f = fit(p);
      return isErr(f) ? f : num(f.intercept);
    },
  },
  FORECAST: forecastSpec(),
  "FORECAST.LINEAR": forecastSpec(),
  "COVARIANCE.P": {
    min: 2,
    max: 2,
    args: ["array1", "array2"],
    fn: ([a, b], env) => {
      const p = pairs(a, b, env);
      return isErr(p) ? p : covariance(p, false);
    },
  },
  "COVARIANCE.S": {
    min: 2,
    max: 2,
    args: ["array1", "array2"],
    fn: ([a, b], env) => {
      const p = pairs(a, b, env);
      return isErr(p) ? p : covariance(p, true);
    },
  },
  SUBTOTAL: {
    min: 2,
    max: VARIADIC,
    args: ["function_num", "ref1", "ref2"],
    repeat: 1,
    fn: ([codeArg, ...refs], env) => {
      const codeValue = numArg(oneOf(codeArg, env), env);
      if (isErr(codeValue)) return codeValue;
      const code = cleanTrunc(codeValue);
      const f = SUBTOTALS[code > 100 ? code - 100 : code];
      if (!f || code < 1 || (code > 11 && code < 101) || code > 111) return ERR["#VALUE!"];
      const args = refs.map((r) => withoutSubtotals(r, env));
      const xs = numbersOf(args, env);
      if (isErr(xs)) return xs;
      return f(xs, args, env);
    },
  },
};

function forecastSpec(): FnSpec {
  return {
    min: 3,
    max: 3,
    lift: [0],
    args: ["x", "known_ys", "known_xs"],
    fn: ([x, ys, xs], env) => {
      const at = numArg(x, env);
      if (isErr(at)) return at;
      const p = pairs(ys, xs, env);
      if (isErr(p)) return p;
      const f = fit(p);
      return isErr(f) ? f : num(f.intercept + f.slope * at);
    },
  };
}
