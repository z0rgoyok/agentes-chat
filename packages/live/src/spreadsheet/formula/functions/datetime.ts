/**
 * Dates and times (ADR 0196 §2) as Excel's serials: days since 1899-12-30, with Excel's fake 1900-02-29 (serial 60)
 * kept so every imported file and every formula agrees with Excel. TODAY and NOW read the engine's clock, which the
 * apps refresh every minute (`tick`); the date is the device's own, as in any spreadsheet app.
 */
import { addMonths, dateSerial, daysInMonth, isLeapYear, MAX_DATE_SERIAL, serialDate, timeSerial } from "../../dates";
import type { CellError, CellValue } from "../../values";
import {
  type Env,
  ERR,
  isArr,
  isErr,
  isRef,
  parseDateTimeText,
  spend,
  textToNumber,
  toText,
  type Val,
  VOLATILE_DAY,
  VOLATILE_TIME,
} from "../runtime";
import { cleanTrunc, type FnSpec, num, numArg, oneOf, optBool, valuesOf } from "./spec";

const DAY_SECONDS = 86_400;

/** A serial argument: a number (or date text) from 0 to 9999-12-31. */
function serialArg(v: Val | undefined, env: Env): number | CellError {
  const n = numArg(v, env);
  if (isErr(n)) return n;
  if (n < 0 || n >= MAX_DATE_SERIAL + 1) return ERR["#NUM!"];
  return n;
}

function dayArg(v: Val | undefined, env: Env): number | CellError {
  const n = serialArg(v, env);
  return isErr(n) ? n : Math.floor(n);
}

function intArg(v: Val | undefined, env: Env, fallback?: number): number | CellError {
  if (v === undefined && fallback !== undefined) return fallback;
  const n = numArg(v, env);
  return isErr(n) ? n : cleanTrunc(n);
}

/** Excel's DATE: years 0–1899 count from 1900, months and days past their ends roll over. */
export function excelDate(year: number, month: number, day: number): number | CellError {
  let y = Math.trunc(year);
  if (y < 0 || y >= 10_000) return ERR["#NUM!"];
  if (y < 1900) y += 1900;
  const index = y * 12 + Math.trunc(month) - 1;
  const yy = Math.floor(index / 12);
  const mm = index - yy * 12 + 1;
  // From the month's first day, so Excel's 1900-02-29 counts as it does there: DATE(1900,3,0) is serial 60.
  const serial = dateSerial(yy, mm, 1) + Math.trunc(day) - 1;
  if (serial < 0 || serial > MAX_DATE_SERIAL) return ERR["#NUM!"];
  return serial;
}

/** Whole seconds of a serial's time of day, rounded as Excel shows them. */
function secondsOf(serial: number): number {
  const s = Math.round((serial - Math.floor(serial)) * DAY_SECONDS);
  return s >= DAY_SECONDS ? 0 : s;
}

/** Which weekdays (0 Sunday … 6 Saturday) are the weekend: Excel's codes 1–7 and 11–17 or a "0000011" mask. */
function weekendOf(v: Val | undefined, env: Env): boolean[] | CellError {
  const days = [false, false, false, false, false, false, false];
  if (v === undefined) {
    days[0] = true;
    days[6] = true;
    return days;
  }
  const x = oneOf(v, env);
  if (isErr(x)) return x;
  if (typeof x === "string" && /^[01]{7}$/.test(x)) {
    if (x === "1111111") return ERR["#VALUE!"];
    // Monday first in the mask.
    for (let i = 0; i < 7; i++) days[(i + 1) % 7] = x.charAt(i) === "1";
    return days;
  }
  const n = numArg(x, env);
  if (isErr(n)) return ERR["#VALUE!"];
  const code = cleanTrunc(n);
  if (code >= 1 && code <= 7) {
    // 1 is Saturday and Sunday, 2 Sunday and Monday, … 7 Friday and Saturday.
    days[(code + 5) % 7] = true;
    days[(code + 6) % 7] = true;
    return days;
  }
  if (code >= 11 && code <= 17) {
    days[(code - 11) % 7] = true;
    return days;
  }
  return ERR["#NUM!"];
}

function holidaysOf(v: Val | undefined, env: Env): Set<number> | CellError {
  const out = new Set<number>();
  if (v === undefined) return out;
  const list = isRef(v) || isArr(v) ? valuesOf(v, env) : [v as CellValue];
  for (const h of list) {
    if (h === null) continue;
    if (isErr(h)) return h;
    const n = typeof h === "number" ? h : typeof h === "string" ? textToNumber(h, env.calc) : null;
    if (n === null) return ERR["#VALUE!"];
    out.add(Math.floor(n));
  }
  return out;
}

function workdays(start: number, end: number, weekend: boolean[], holidays: Set<number>, env: Env): number {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  spend(env, hi - lo + 1);
  let n = 0;
  for (let d = lo; d <= hi; d++) {
    if (!weekend[serialDate(d).weekday] && !holidays.has(d)) n++;
  }
  return start <= end ? n : -n;
}

function addWorkdays(start: number, days: number, weekend: boolean[], holidays: Set<number>, env: Env): CellValue {
  let d = start;
  let left = Math.abs(days);
  const step = days < 0 ? -1 : 1;
  while (left > 0) {
    d += step;
    spend(env, 1);
    if (d < 1 || d > MAX_DATE_SERIAL) return ERR["#NUM!"];
    if (!weekend[serialDate(d).weekday] && !holidays.has(d)) left--;
  }
  return d;
}

function isoWeek(serial: number): number {
  const { year, month, day, weekday } = serialDate(serial);
  const monday0 = (weekday + 6) % 7;
  const thursday = Date.UTC(year, month - 1, day) + (3 - monday0) * 86_400_000;
  const yearStart = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1);
  return 1 + Math.floor((thursday - yearStart) / (7 * 86_400_000));
}

function lastOfFebruary(d: { year: number; month: number; day: number }): boolean {
  return d.month === 2 && d.day === daysInMonth(d.year, 2);
}

function yearFrac(a: number, b: number, basis: number): number | CellError {
  const s = Math.min(a, b);
  const e = Math.max(a, b);
  const x = serialDate(s);
  const y = serialDate(e);
  switch (basis) {
    case 0: {
      let d1 = x.day;
      let d2 = y.day;
      if (lastOfFebruary(x) && lastOfFebruary(y)) d2 = 30;
      if (lastOfFebruary(x)) d1 = 30;
      if (d2 === 31 && d1 >= 30) d2 = 30;
      if (d1 === 31) d1 = 30;
      return ((y.year - x.year) * 360 + (y.month - x.month) * 30 + (d2 - d1)) / 360;
    }
    case 1: {
      const days = e - s;
      const withinYear =
        x.year === y.year || (y.year === x.year + 1 && (x.month > y.month || (x.month === y.month && x.day >= y.day)));
      if (withinYear) {
        let leap = x.year === y.year && isLeapYear(x.year);
        for (let yr = x.year; !leap && yr <= y.year; yr++) {
          if (!isLeapYear(yr)) continue;
          const feb29 = dateSerial(yr, 2, 29);
          if (feb29 >= s && feb29 <= e) leap = true;
        }
        return days / (leap ? 366 : 365);
      }
      let total = 0;
      for (let yr = x.year; yr <= y.year; yr++) total += isLeapYear(yr) ? 366 : 365;
      return days / (total / (y.year - x.year + 1));
    }
    case 2:
      return (e - s) / 360;
    case 3:
      return (e - s) / 365;
    case 4: {
      const d1 = Math.min(x.day, 30);
      const d2 = Math.min(y.day, 30);
      return ((y.year - x.year) * 360 + (y.month - x.month) * 30 + (d2 - d1)) / 360;
    }
    default:
      return ERR["#NUM!"];
  }
}

function datedif(start: number, end: number, unit: string): number | CellError {
  if (start > end) return ERR["#NUM!"];
  const a = serialDate(start);
  const b = serialDate(end);
  const months = (b.year - a.year) * 12 + (b.month - a.month) - (b.day < a.day ? 1 : 0);
  switch (unit.toUpperCase()) {
    case "Y":
      return Math.floor(months / 12);
    case "M":
      return months;
    case "D":
      return end - start;
    case "MD": {
      let d = b.day - a.day;
      if (d < 0) {
        const prevMonth = b.month === 1 ? 12 : b.month - 1;
        const prevYear = b.month === 1 ? b.year - 1 : b.year;
        d += daysInMonth(prevYear, prevMonth);
      }
      return d;
    }
    case "YM":
      return ((months % 12) + 12) % 12;
    case "YD": {
      const clampDay = (yr: number) => Math.min(a.day, daysInMonth(yr, a.month));
      let from = dateSerial(b.year, a.month, clampDay(b.year));
      if (from > end) from = dateSerial(b.year - 1, a.month, clampDay(b.year - 1));
      return end - from;
    }
    default:
      return ERR["#NUM!"];
  }
}

function dateFn(
  args: readonly string[],
  min: number,
  f: (vals: readonly (Val | undefined)[], env: Env) => CellValue,
): FnSpec {
  return { min, max: args.length, lift: "all", args, fn: (vals, env) => f(vals, env) };
}

export const DATETIME: Record<string, FnSpec> = {
  TODAY: {
    min: 0,
    max: 0,
    args: [],
    fn: (_args, env) => {
      if (env.volatile < VOLATILE_DAY) env.volatile = VOLATILE_DAY;
      const now = env.host.now();
      return dateSerial(now.getFullYear(), now.getMonth() + 1, now.getDate());
    },
  },
  NOW: {
    min: 0,
    max: 0,
    args: [],
    fn: (_args, env) => {
      env.volatile = VOLATILE_TIME;
      const now = env.host.now();
      return (
        dateSerial(now.getFullYear(), now.getMonth() + 1, now.getDate()) +
        timeSerial(now.getHours(), now.getMinutes(), now.getSeconds())
      );
    },
  },
  DATE: dateFn(["year", "month", "day"], 3, ([y, m, d], env) => {
    const year = numArg(y, env);
    if (isErr(year)) return year;
    const month = numArg(m, env);
    if (isErr(month)) return month;
    const day = numArg(d, env);
    if (isErr(day)) return day;
    return excelDate(year, month, day);
  }),
  TIME: dateFn(["hour", "minute", "second"], 3, ([h, m, s], env) => {
    const hour = intArg(h, env);
    if (isErr(hour)) return hour;
    const minute = intArg(m, env);
    if (isErr(minute)) return minute;
    const second = intArg(s, env);
    if (isErr(second)) return second;
    if (hour > 32_767 || minute > 32_767 || second > 32_767) return ERR["#NUM!"];
    const total = hour * 3600 + minute * 60 + second;
    if (total < 0) return ERR["#NUM!"];
    return (total % DAY_SECONDS) / DAY_SECONDS;
  }),
  YEAR: dateFn(["serial_number"], 1, ([v], env) => {
    const d = dayArg(v, env);
    return isErr(d) ? d : serialDate(d).year;
  }),
  MONTH: dateFn(["serial_number"], 1, ([v], env) => {
    const d = dayArg(v, env);
    return isErr(d) ? d : serialDate(d).month;
  }),
  DAY: dateFn(["serial_number"], 1, ([v], env) => {
    const d = dayArg(v, env);
    return isErr(d) ? d : serialDate(d).day;
  }),
  HOUR: dateFn(["serial_number"], 1, ([v], env) => {
    const s = serialArg(v, env);
    return isErr(s) ? s : Math.floor(secondsOf(s) / 3600);
  }),
  MINUTE: dateFn(["serial_number"], 1, ([v], env) => {
    const s = serialArg(v, env);
    return isErr(s) ? s : Math.floor((secondsOf(s) % 3600) / 60);
  }),
  SECOND: dateFn(["serial_number"], 1, ([v], env) => {
    const s = serialArg(v, env);
    return isErr(s) ? s : secondsOf(s) % 60;
  }),
  WEEKDAY: dateFn(["serial_number", "return_type"], 1, ([v, t], env) => {
    const d = dayArg(v, env);
    if (isErr(d)) return d;
    const type = intArg(t, env, 1);
    if (isErr(type)) return type;
    const w = serialDate(d).weekday;
    if (type === 1 || type === 17) return w + 1;
    if (type === 2 || type === 11) return ((w + 6) % 7) + 1;
    if (type === 3) return (w + 6) % 7;
    if (type >= 12 && type <= 16) return ((w - (type - 10) + 7) % 7) + 1;
    return ERR["#NUM!"];
  }),
  WEEKNUM: dateFn(["serial_number", "return_type"], 1, ([v, t], env) => {
    const d = dayArg(v, env);
    if (isErr(d)) return d;
    const type = intArg(t, env, 1);
    if (isErr(type)) return type;
    if (type === 21) return isoWeek(d);
    let first: number;
    if (type === 1 || type === 17) first = 0;
    else if (type === 2 || type === 11) first = 1;
    else if (type >= 12 && type <= 16) first = type - 10;
    else return ERR["#NUM!"];
    const jan1 = dateSerial(serialDate(d).year, 1, 1);
    const offset = (serialDate(jan1).weekday - first + 7) % 7;
    return Math.floor((d - jan1 + offset) / 7) + 1;
  }),
  ISOWEEKNUM: dateFn(["date"], 1, ([v], env) => {
    const d = dayArg(v, env);
    return isErr(d) ? d : isoWeek(d);
  }),
  EDATE: dateFn(["start_date", "months"], 2, ([s, m], env) => {
    const d = dayArg(s, env);
    if (isErr(d)) return d;
    const months = intArg(m, env);
    if (isErr(months)) return months;
    const r = Math.floor(addMonths(d, months));
    return r < 0 || r > MAX_DATE_SERIAL ? ERR["#NUM!"] : r;
  }),
  EOMONTH: dateFn(["start_date", "months"], 2, ([s, m], env) => {
    const d = dayArg(s, env);
    if (isErr(d)) return d;
    const months = intArg(m, env);
    if (isErr(months)) return months;
    const { year, month } = serialDate(d);
    const r = excelDate(year, month + months + 1, 0);
    return isErr(r) || r < 0 || r > MAX_DATE_SERIAL ? ERR["#NUM!"] : r;
  }),
  DATEDIF: dateFn(["start_date", "end_date", "unit"], 3, ([s, e, u], env) => {
    const a = dayArg(s, env);
    if (isErr(a)) return a;
    const b = dayArg(e, env);
    if (isErr(b)) return b;
    const unit = toText((u ?? null) as CellValue, env.calc);
    return isErr(unit) ? unit : datedif(a, b, unit);
  }),
  DAYS: dateFn(["end_date", "start_date"], 2, ([e, s], env) => {
    const b = dayArg(e, env);
    if (isErr(b)) return b;
    const a = dayArg(s, env);
    return isErr(a) ? a : b - a;
  }),
  DAYS360: dateFn(["start_date", "end_date", "method"], 2, ([s, e, m], env) => {
    const a = dayArg(s, env);
    if (isErr(a)) return a;
    const b = dayArg(e, env);
    if (isErr(b)) return b;
    const european = optBool(m, env, false);
    if (isErr(european)) return european;
    const x = serialDate(a);
    const y = serialDate(b);
    let d1 = x.day;
    let d2 = y.day;
    let m2 = y.month;
    let y2 = y.year;
    if (european) {
      d1 = Math.min(d1, 30);
      d2 = Math.min(d2, 30);
    } else {
      if (d1 === 31 || lastOfFebruary(x)) d1 = 30;
      if (d2 === 31) {
        if (d1 < 30) {
          d2 = 1;
          m2++;
          if (m2 > 12) {
            m2 = 1;
            y2++;
          }
        } else d2 = 30;
      }
    }
    return (y2 - x.year) * 360 + (m2 - x.month) * 30 + (d2 - d1);
  }),
  NETWORKDAYS: {
    min: 2,
    max: 3,
    lift: [0, 1],
    args: ["start_date", "end_date", "holidays"],
    fn: ([s, e, h], env) => {
      const a = dayArg(s, env);
      if (isErr(a)) return a;
      const b = dayArg(e, env);
      if (isErr(b)) return b;
      const holidays = holidaysOf(h, env);
      if (isErr(holidays)) return holidays;
      return workdays(a, b, [true, false, false, false, false, false, true], holidays, env);
    },
  },
  "NETWORKDAYS.INTL": {
    min: 2,
    max: 4,
    lift: [0, 1],
    args: ["start_date", "end_date", "weekend", "holidays"],
    fn: ([s, e, w, h], env) => {
      const a = dayArg(s, env);
      if (isErr(a)) return a;
      const b = dayArg(e, env);
      if (isErr(b)) return b;
      const weekend = weekendOf(w, env);
      if (isErr(weekend)) return weekend;
      const holidays = holidaysOf(h, env);
      if (isErr(holidays)) return holidays;
      return workdays(a, b, weekend, holidays, env);
    },
  },
  WORKDAY: {
    min: 2,
    max: 3,
    lift: [0, 1],
    args: ["start_date", "days", "holidays"],
    fn: ([s, n, h], env) => {
      const a = dayArg(s, env);
      if (isErr(a)) return a;
      const days = intArg(n, env);
      if (isErr(days)) return days;
      const holidays = holidaysOf(h, env);
      if (isErr(holidays)) return holidays;
      return addWorkdays(a, days, [true, false, false, false, false, false, true], holidays, env);
    },
  },
  "WORKDAY.INTL": {
    min: 2,
    max: 4,
    lift: [0, 1],
    args: ["start_date", "days", "weekend", "holidays"],
    fn: ([s, n, w, h], env) => {
      const a = dayArg(s, env);
      if (isErr(a)) return a;
      const days = intArg(n, env);
      if (isErr(days)) return days;
      const weekend = weekendOf(w, env);
      if (isErr(weekend)) return weekend;
      const holidays = holidaysOf(h, env);
      if (isErr(holidays)) return holidays;
      return addWorkdays(a, days, weekend, holidays, env);
    },
  },
  DATEVALUE: dateFn(["date_text"], 1, ([t], env) => {
    const v = (t ?? null) as CellValue;
    if (typeof v !== "string") return ERR["#VALUE!"];
    const n = parseDateTimeText(v, env.calc.dateOrder);
    if (n === null || n < 0 || n >= MAX_DATE_SERIAL + 1) return ERR["#VALUE!"];
    return Math.floor(n);
  }),
  TIMEVALUE: dateFn(["time_text"], 1, ([t], env) => {
    const v = (t ?? null) as CellValue;
    if (typeof v !== "string") return ERR["#VALUE!"];
    const n = parseDateTimeText(v, env.calc.dateOrder);
    if (n === null || n < 0) return ERR["#VALUE!"];
    return n - Math.floor(n);
  }),
  YEARFRAC: dateFn(["start_date", "end_date", "basis"], 2, ([s, e, b], env) => {
    const a = dayArg(s, env);
    if (isErr(a)) return a;
    const z = dayArg(e, env);
    if (isErr(z)) return z;
    const basis = intArg(b, env, 0);
    if (isErr(basis)) return basis;
    const r = yearFrac(a, z, basis);
    return isErr(r) ? r : num(r);
  }),
};
