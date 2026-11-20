/**
 * Excel's date serials (ADR 0196): a date is the number of days since 1899-12-30 in the 1900 system and a time is the
 * fraction of a day. Excel's fake 1900-02-29 (serial 60) is kept, so serials agree with every imported file and with
 * Excel's own formulas: serial 1 is 1900-01-01, 61 is 1900-03-01.
 */

const DAY_MS = 86_400_000;
/** 1899-12-30, from which serials from 61 on are counted; earlier ones count from 1899-12-31. */
const EPOCH = Date.UTC(1899, 11, 30);

/** 9999-12-31, the last date Excel shows. */
export const MAX_DATE_SERIAL = 2_958_465;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Days in a month (1–12) of a year. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return MONTH_DAYS[month - 1] ?? 30;
}

function utcDays(year: number, month: number, day: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(0, 0, 0, 0);
  return Math.round((d.getTime() - EPOCH) / DAY_MS);
}

/**
 * The serial of a date. Months and days out of range roll over like JavaScript's Date (month 13 is January of the
 * next year, day 0 the last day of the month before), which is also what Excel's DATE does with them.
 */
export function dateSerial(year: number, month: number, day: number): number {
  if (year === 1900 && month === 2 && day === 29) return 60;
  const days = utcDays(year, month, day);
  return days < 61 ? days - 1 : days;
}

export interface SerialDate {
  year: number;
  month: number;
  day: number;
  /** 0 is Sunday, by Excel's count (so serials before 1900-03-01 keep Excel's weekdays too). */
  weekday: number;
}

/** The date part of a serial: day 0 is Excel's "1900-01-00", and 60 its 1900-02-29. */
export function serialDate(serial: number): SerialDate {
  const days = Math.floor(serial);
  const weekday = (((days + 6) % 7) + 7) % 7;
  if (days === 60) return { year: 1900, month: 2, day: 29, weekday };
  if (days === 0) return { year: 1900, month: 1, day: 0, weekday };
  const d = new Date(EPOCH + (days < 60 ? days + 1 : days) * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday };
}

/** A time of day as the fraction of a day. */
export function timeSerial(hour: number, minute: number, second: number, ms = 0): number {
  return (hour * 3_600_000 + minute * 60_000 + second * 1000 + ms) / DAY_MS;
}

export interface SerialTime {
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

/** The time of day of a serial, to the nearest millisecond. */
export function serialTime(serial: number): SerialTime {
  const days = Math.floor(serial);
  let ms = Math.round((serial - days) * DAY_MS);
  if (ms >= DAY_MS) ms = DAY_MS - 1;
  const hour = Math.floor(ms / 3_600_000);
  ms -= hour * 3_600_000;
  const minute = Math.floor(ms / 60_000);
  ms -= minute * 60_000;
  const second = Math.floor(ms / 1000);
  return { hour, minute, second, ms: ms - second * 1000 };
}

/**
 * The same day `months` later (or earlier), on the month's last day when it is shorter (31 Jan + 1 month = 28 or 29
 * Feb), as Excel's EDATE and the fill handle do. The time of day is kept.
 */
export function addMonths(serial: number, months: number): number {
  const { year, month, day } = serialDate(serial);
  const index = year * 12 + (month - 1) + months;
  const y = Math.floor(index / 12);
  const m = index - y * 12 + 1;
  const time = serial - Math.floor(serial);
  return dateSerial(y, m, Math.min(Math.max(day, 1), daysInMonth(y, m))) + time;
}
