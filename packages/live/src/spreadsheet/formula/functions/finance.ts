/**
 * Finance (ADR 0196 §2) with Excel's sign conventions: money paid out is negative, so `=PMT(1%,12,1000)` is -88.85.
 * IRR, RATE and XIRR solve by Newton's method from the guess, falling back to bisection over a bracketing interval
 * when Newton wanders off, so they find the root Excel finds and also converge where Excel's 20 iterations give up.
 */
import type { CellError } from "../../values";
import { type Env, ERR, isErr, type Val } from "../runtime";
import { arrayNumbers, cleanTrunc, type FnSpec, num, numArg, numbersOf, VARIADIC } from "./spec";

function pmt(rate: number, nper: number, pv: number, fv: number, type: number): number {
  if (rate === 0) return -(pv + fv) / nper;
  const f = (1 + rate) ** nper;
  return -(rate * (pv * f + fv)) / ((1 + rate * type) * (f - 1));
}

function fv(rate: number, nper: number, payment: number, pv: number, type: number): number {
  if (rate === 0) return -(pv + payment * nper);
  const f = (1 + rate) ** nper;
  return -(pv * f + (payment * (1 + rate * type) * (f - 1)) / rate);
}

function pv(rate: number, nper: number, payment: number, future: number, type: number): number {
  if (rate === 0) return -(future + payment * nper);
  const f = (1 + rate) ** nper;
  return -(future + (payment * (1 + rate * type) * (f - 1)) / rate) / f;
}

function ipmt(rate: number, per: number, nper: number, present: number, future: number, type: number): number {
  const payment = pmt(rate, nper, present, future, type);
  let interest: number;
  if (per === 1) interest = type === 1 ? 0 : -present;
  else
    interest = type === 1 ? fv(rate, per - 2, payment, present, 1) - payment : fv(rate, per - 1, payment, present, 0);
  return interest * rate;
}

/** Numbers from lifted arguments, with defaults for the ones left out. */
function finance(
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
        const v = vals[i];
        if (v === undefined) {
          xs.push(defaults[i - min] ?? 0);
          continue;
        }
        const x = numArg(v, env);
        if (isErr(x)) return x;
        xs.push(x);
      }
      const r = f(xs);
      return isErr(r) ? r : num(r);
    },
  };
}

const typeOf = (t: number | undefined) => (t ? 1 : 0);

/**
 * A root of `f` near `guess`: Newton's method first, then bisection over the interval nearest the guess where `f`
 * changes sign (rates above -100%). `scale` is the size of the amounts involved (the sum of the cash flows'
 * magnitudes), so the tolerance holds for billions as for tens. `#NUM!` when there is no root.
 */
export function solveRate(f: (r: number) => number, guess: number, scale = 1): number | CellError {
  const size = Number.isFinite(scale) ? Math.max(1, Math.abs(scale)) : 1;
  const deriv = (r: number) => {
    const h = Math.max(1e-7, Math.abs(r) * 1e-7);
    return (f(r + h) - f(r - h)) / (2 * h);
  };
  let r = guess;
  for (let i = 0; i < 100; i++) {
    const y = f(r);
    if (!Number.isFinite(y)) break;
    if (Math.abs(y) < 1e-10 * size) return r;
    const d = deriv(r);
    if (!Number.isFinite(d) || d === 0) break;
    const next = r - y / d;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - r) < 1e-12 * Math.max(1, Math.abs(r))) {
      // Newton settled: on a root, or stuck on a flat stretch, where bisection takes over.
      if (Math.abs(f(next)) < 1e-6 * size) return next;
      break;
    }
    r = next;
  }
  const points = [
    guess,
    0,
    0.01,
    0.05,
    0.1,
    0.2,
    0.5,
    1,
    2,
    5,
    10,
    100,
    1000,
    -0.01,
    -0.05,
    -0.1,
    -0.2,
    -0.5,
    -0.9,
    -0.99,
  ];
  const xs = [...new Set(points.filter((p) => p > -1))].sort((a, b) => a - b);
  let lo = Number.NaN;
  let hi = Number.NaN;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i] as number;
    const b = xs[i + 1] as number;
    const fa = f(a);
    const fb = f(b);
    if (!Number.isFinite(fa) || !Number.isFinite(fb) || Math.sign(fa) === Math.sign(fb)) continue;
    const dist = Math.min(Math.abs(a - guess), Math.abs(b - guess));
    if (dist < best) {
      best = dist;
      lo = a;
      hi = b;
    }
  }
  if (Number.isNaN(lo)) return ERR["#NUM!"];
  let flo = f(lo);
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (Math.abs(fm) < 1e-12 * size || (hi - lo) / 2 < 1e-15) return mid;
    if (Math.sign(fm) === Math.sign(flo)) {
      lo = mid;
      flo = fm;
    } else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The sum of the amounts' sizes, the scale a cash flow's root is measured against. */
function magnitude(values: readonly number[]): number {
  let s = 0;
  for (const v of values) s += Math.abs(v);
  return s;
}

function npvOf(rate: number, values: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += (values[i] as number) / (1 + rate) ** (i + 1);
  return s;
}

function dated(values: Val | undefined, dates: Val | undefined, env: Env): { v: number[]; d: number[] } | CellError {
  const v = arrayNumbers(values, env);
  if (isErr(v)) return v;
  const d = arrayNumbers(dates, env);
  if (isErr(d)) return d;
  if (v.length !== d.length || v.length === 0) return ERR["#NUM!"];
  const days = d.map((x) => Math.floor(x));
  const first = days[0] as number;
  if (days.some((x) => x < first)) return ERR["#NUM!"];
  return { v, d: days };
}

function xnpv(rate: number, p: { v: number[]; d: number[] }): number {
  const first = p.d[0] as number;
  let s = 0;
  for (let i = 0; i < p.v.length; i++) s += (p.v[i] as number) / (1 + rate) ** (((p.d[i] as number) - first) / 365);
  return s;
}

export const FINANCE: Record<string, FnSpec> = {
  PMT: finance(["rate", "nper", "pv", "fv", "type"], 3, [0, 0], ([r, n, p, f, t]) => {
    if (n === 0) return ERR["#NUM!"];
    return pmt(r as number, n as number, p as number, f as number, typeOf(t));
  }),
  FV: finance(["rate", "nper", "pmt", "pv", "type"], 3, [0, 0], ([r, n, m, p, t]) =>
    fv(r as number, n as number, m as number, p as number, typeOf(t)),
  ),
  PV: finance(["rate", "nper", "pmt", "fv", "type"], 3, [0, 0], ([r, n, m, f, t]) =>
    pv(r as number, n as number, m as number, f as number, typeOf(t)),
  ),
  NPER: finance(["rate", "pmt", "pv", "fv", "type"], 3, [0, 0], ([r, m, p, f, t]) => {
    const rate = r as number;
    const payment = m as number;
    const present = p as number;
    const future = f as number;
    if (rate === 0) return payment === 0 ? ERR["#NUM!"] : -(present + future) / payment;
    const k = payment * (1 + rate * typeOf(t));
    const ratio = (k - future * rate) / (k + present * rate);
    if (!(ratio > 0) || rate <= -1) return ERR["#NUM!"];
    return Math.log(ratio) / Math.log(1 + rate);
  }),
  IPMT: finance(["rate", "per", "nper", "pv", "fv", "type"], 4, [0, 0], ([r, per, n, p, f, t]) => {
    if ((per as number) < 1 || (per as number) > (n as number)) return ERR["#NUM!"];
    return ipmt(r as number, per as number, n as number, p as number, f as number, typeOf(t));
  }),
  PPMT: finance(["rate", "per", "nper", "pv", "fv", "type"], 4, [0, 0], ([r, per, n, p, f, t]) => {
    if ((per as number) < 1 || (per as number) > (n as number)) return ERR["#NUM!"];
    const type = typeOf(t);
    return (
      pmt(r as number, n as number, p as number, f as number, type) -
      ipmt(r as number, per as number, n as number, p as number, f as number, type)
    );
  }),
  CUMIPMT: finance(["rate", "nper", "pv", "start_period", "end_period", "type"], 6, [], ([r, n, p, s, e, t]) => {
    const rate = r as number;
    const nper = cleanTrunc(n as number);
    const start = cleanTrunc(s as number);
    const end = cleanTrunc(e as number);
    if (rate <= 0 || nper <= 0 || (p as number) <= 0 || start < 1 || end < start || end > nper) return ERR["#NUM!"];
    if (t !== 0 && t !== 1) return ERR["#NUM!"];
    let sum = 0;
    for (let per = start; per <= end; per++) sum += ipmt(rate, per, nper, p as number, 0, t);
    return sum;
  }),
  CUMPRINC: finance(["rate", "nper", "pv", "start_period", "end_period", "type"], 6, [], ([r, n, p, s, e, t]) => {
    const rate = r as number;
    const nper = cleanTrunc(n as number);
    const start = cleanTrunc(s as number);
    const end = cleanTrunc(e as number);
    if (rate <= 0 || nper <= 0 || (p as number) <= 0 || start < 1 || end < start || end > nper) return ERR["#NUM!"];
    if (t !== 0 && t !== 1) return ERR["#NUM!"];
    const payment = pmt(rate, nper, p as number, 0, t);
    let sum = 0;
    for (let per = start; per <= end; per++) sum += payment - ipmt(rate, per, nper, p as number, 0, t);
    return sum;
  }),
  EFFECT: finance(["nominal_rate", "npery"], 2, [], ([r, n]) => {
    const periods = cleanTrunc(n as number);
    if ((r as number) <= 0 || periods < 1) return ERR["#NUM!"];
    return (1 + (r as number) / periods) ** periods - 1;
  }),
  NOMINAL: finance(["effect_rate", "npery"], 2, [], ([r, n]) => {
    const periods = cleanTrunc(n as number);
    if ((r as number) <= 0 || periods < 1) return ERR["#NUM!"];
    return ((1 + (r as number)) ** (1 / periods) - 1) * periods;
  }),
  SLN: finance(["cost", "salvage", "life"], 3, [], ([c, s, l]) =>
    l === 0 ? ERR["#DIV/0!"] : ((c as number) - (s as number)) / (l as number),
  ),
  NPV: {
    min: 2,
    max: VARIADIC,
    args: ["rate", "value1", "value2"],
    repeat: 1,
    fn: ([rateArg, ...rest], env) => {
      const rate = numArg(rateArg, env);
      if (isErr(rate)) return rate;
      if (rate === -1) return ERR["#DIV/0!"];
      const values = numbersOf(rest, env);
      if (isErr(values)) return values;
      return num(npvOf(rate, values));
    },
  },
  IRR: {
    min: 1,
    max: 2,
    args: ["values", "guess"],
    fn: ([valuesArg, guessArg], env) => {
      const values = arrayNumbers(valuesArg, env);
      if (isErr(values)) return values;
      const guess = guessArg === undefined ? 0.1 : numArg(guessArg, env);
      if (isErr(guess)) return guess;
      if (!values.some((v) => v > 0) || !values.some((v) => v < 0)) return ERR["#NUM!"];
      const r = solveRate(
        (rate) => {
          let s = 0;
          for (let i = 0; i < values.length; i++) s += (values[i] as number) / (1 + rate) ** i;
          return s;
        },
        guess,
        magnitude(values),
      );
      return isErr(r) ? r : num(r);
    },
  },
  RATE: finance(["nper", "pmt", "pv", "fv", "type", "guess"], 3, [0, 0, 0.1], ([n, m, p, f, t, g]) => {
    const nper = n as number;
    if (nper <= 0) return ERR["#NUM!"];
    const type = typeOf(t);
    return solveRate(
      (r) => {
        if (Math.abs(r) < 1e-12) return (p as number) + (m as number) * nper + (f as number);
        const k = (1 + r) ** nper;
        return (p as number) * k + ((m as number) * (1 + r * type) * (k - 1)) / r + (f as number);
      },
      g as number,
      Math.abs(p as number) + Math.abs((m as number) * nper) + Math.abs(f as number),
    );
  }),
  XNPV: {
    min: 3,
    max: 3,
    args: ["rate", "values", "dates"],
    fn: ([rateArg, values, dates], env) => {
      const rate = numArg(rateArg, env);
      if (isErr(rate)) return rate;
      if (rate <= -1) return ERR["#NUM!"];
      const p = dated(values, dates, env);
      return isErr(p) ? p : num(xnpv(rate, p));
    },
  },
  XIRR: {
    min: 2,
    max: 3,
    args: ["values", "dates", "guess"],
    fn: ([values, dates, guessArg], env) => {
      const p = dated(values, dates, env);
      if (isErr(p)) return p;
      const guess = guessArg === undefined ? 0.1 : numArg(guessArg, env);
      if (isErr(guess)) return guess;
      if (!p.v.some((v) => v > 0) || !p.v.some((v) => v < 0)) return ERR["#NUM!"];
      const r = solveRate((rate) => xnpv(rate, p), guess, magnitude(p.v));
      return isErr(r) ? r : num(r);
    },
  },
};
