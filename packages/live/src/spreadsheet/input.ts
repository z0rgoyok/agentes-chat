/**
 * What a person types into a cell (ADR 0196), read in their language: "1.234,5" and "R$ 10" in Brazil, "1,234.5" and
 * "$10" in the US, "12%", dates in the locale's order ("17/11/2026", "11/17/2026") or ISO ("2026-11-17"), times
 * ("10:30", "10:30 PM", "25:30"), TRUE/FALSE or VERDADEIRO/FALSO in either language, "=" for a formula and a leading
 * apostrophe to keep anything as text. Agents' literals go through the same reading with an English locale.
 */
import { dateSerial, daysInMonth, MAX_DATE_SERIAL, serialDate, serialTime } from "./dates";
import { currencyFormat, formatKind, formatPlain, NUMBER_FORMATS } from "./format";
import { ENGLISH_NAMES, localeNames, type SheetLocale } from "./locale";
import { booleanFromText, booleanText } from "./values";

export interface ParsedInput {
  v?: number | string | boolean;
  /** A formula as typed ("=SOMA(A1;B1)"), for `toCanonical`. */
  f?: string;
  /** The number format the input implies: "10%" → `0%`, "R$ 5" → `"R$" #,##0.00`, "17/11/2026" → `dd/mm/yyyy`. */
  nf?: string;
}

/** Above this many significant digits a number can't be kept exactly, so it stays text (card and ID numbers). */
const MAX_DIGITS = 15;

const CURRENCIES = ["US$", "R$", "CHF", "zł", "Rp", "kr", "$", "€", "£", "¥", "₩", "₹", "₺", "₽"];

function normalizeSpaces(text: string): string {
  return text.replace(/[   ]/g, " ").replace(/−/g, "-");
}

interface NumberRead {
  value: number;
  decimals: number;
  grouped: boolean;
  percent: boolean;
  currency: string | null;
  /** The currency sign came after the number ("10 €"). */
  after: boolean;
  sci: boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CORES = new Map<string, RegExp>();

/** Digits with the locale's grouping and decimal separators, and an optional exponent. */
function coreFor(locale: SheetLocale): RegExp {
  const key = `${locale.decimal}${locale.group}`;
  let re = CORES.get(key);
  if (!re) {
    const d = escapeRegExp(locale.decimal);
    const g = locale.group === " " ? " " : escapeRegExp(locale.group);
    re = new RegExp(`^(?:(\\d{1,3}(?:${g}\\d{3})+)|(\\d+))?(?:${d}(\\d*))?(?:[eE]([+-]?\\d{1,3}))?$`);
    CORES.set(key, re);
  }
  return re;
}

function readNumber(raw: string, locale: SheetLocale): NumberRead | null {
  let s = normalizeSpaces(raw).trim();
  if (s.length === 0 || s.length > 64) return null;
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  let currency: string | null = null;
  let after = false;
  let percent = false;
  const signs = [locale.currency, ...CURRENCIES];
  const takeSign = () => {
    if (s.startsWith("-") || s.startsWith("+")) {
      if (s.startsWith("-")) negative = !negative;
      s = s.slice(1).trim();
      return true;
    }
    return false;
  };
  const takeCurrency = () => {
    if (currency) return false;
    for (const sign of signs) {
      if (s.startsWith(sign)) {
        currency = sign;
        s = s.slice(sign.length).trim();
        return true;
      }
      if (s.endsWith(sign)) {
        currency = sign;
        after = true;
        s = s.slice(0, -sign.length).trim();
        return true;
      }
    }
    return false;
  };
  takeSign();
  takeCurrency();
  takeSign();
  if (s.endsWith("%")) {
    percent = true;
    s = s.slice(0, -1).trim();
  }
  if (!currency) takeCurrency();
  if (percent && currency) return null;
  const m = coreFor(locale).exec(s);
  if (!m || s.length === 0) return null;
  const grouped = m[1] !== undefined;
  const intPart = (m[1] ?? m[2] ?? "").split(locale.group).join("");
  const fracPart = m[3] ?? "";
  if (intPart === "" && fracPart === "") return null;
  const digits = `${intPart}${fracPart}`.replace(/^0+/, "").replace(/0+$/, "");
  if (digits.length > MAX_DIGITS) return null;
  const text = `${intPart || "0"}.${fracPart || "0"}${m[4] !== undefined ? `e${m[4]}` : ""}`;
  let value = Number(text);
  if (!Number.isFinite(value)) return null;
  if (negative) value = -value;
  if (percent) value = Number((value / 100).toPrecision(15));
  return { value, decimals: fracPart.length, grouped, percent, currency, after, sci: m[4] !== undefined };
}

/** A plain number typed in the locale ("1.234,5" in pt-BR), without currency or percent; null when it isn't one. */
export function parseNumber(text: string, locale: SheetLocale): number | null {
  const n = readNumber(text, locale);
  return n && !n.percent && !n.currency ? n.value : null;
}

function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[áàâãä]/g, "a")
    .replace(/[éèêë]/g, "e")
    .replace(/[íìîï]/g, "i")
    .replace(/[óòôõö]/g, "o")
    .replace(/[úùûü]/g, "u")
    .replace(/ç/g, "c")
    .replace(/\.$/, "");
}

/** A month's number (1–12) from its name or abbreviation in the locale's language or English. */
function monthOf(name: string, locale: SheetLocale): number | null {
  const wanted = fold(name);
  if (wanted.length < 3) return null;
  for (const names of [localeNames(locale), ENGLISH_NAMES]) {
    for (let i = 0; i < 12; i++) {
      if (fold(names.months[i] ?? "") === wanted || fold(names.monthsShort[i] ?? "") === wanted) return i + 1;
    }
  }
  return null;
}

function fullYear(text: string): number | null {
  if (text.length === 2) {
    const y = Number(text);
    return y < 30 ? 2000 + y : 1900 + y;
  }
  if (text.length === 4) return Number(text);
  return null;
}

function validDate(year: number, month: number, day: number): number | null {
  if (!(year >= 1900 && year <= 9999 && month >= 1 && month <= 12 && day >= 1)) return null;
  if (year === 1900 && month === 2 && day === 29) return 60;
  if (day > daysInMonth(year, month)) return null;
  const serial = dateSerial(year, month, day);
  return serial >= 1 && serial <= MAX_DATE_SERIAL ? serial : null;
}

interface TimeRead {
  value: number;
  seconds: boolean;
  ampm: boolean;
  elapsed: boolean;
}

const TIME = /^(\d{1,4}):(\d{1,2})(?::(\d{1,2})(?:[.,](\d{1,3}))?)?\s*([ap]\.?\s*m\.?|[ap])?$/i;
const HOUR_AMPM = /^(\d{1,2})\s*([ap]\.?\s*m\.?)$/i;

function readTime(text: string): TimeRead | null {
  const s = text.trim();
  let m = TIME.exec(s);
  let hour: number;
  let minute = 0;
  let second = 0;
  let ms = 0;
  let marker: string | undefined;
  let seconds = false;
  if (m) {
    hour = Number(m[1]);
    minute = Number(m[2]);
    if (m[3] !== undefined) {
      seconds = true;
      second = Number(m[3]);
    }
    if (m[4] !== undefined) ms = Math.round(Number(`0.${m[4]}`) * 1000);
    marker = m[5];
  } else {
    m = HOUR_AMPM.exec(s);
    if (!m) return null;
    hour = Number(m[1]);
    marker = m[2];
  }
  if (minute > 59 || second > 59) return null;
  const pm = marker ? marker.toLowerCase().startsWith("p") : false;
  if (marker) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (pm ? 12 : 0);
  }
  if (hour > 9999) return null;
  const value = (hour * 3600 + minute * 60 + second + ms / 1000) / 86_400;
  return { value, seconds, ampm: marker !== undefined, elapsed: hour >= 24 };
}

function timeCode(t: TimeRead): string {
  if (t.elapsed) return t.seconds ? "[h]:mm:ss" : "[h]:mm";
  if (t.ampm) return t.seconds ? "h:mm:ss AM/PM" : "h:mm AM/PM";
  return t.seconds ? "hh:mm:ss" : "hh:mm";
}

const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](.+))?$/;
// The time after a date starts at its first non-space: `\s+(.+)` could split a run of spaces many ways (quadratic).
const NUMERIC_DATE = /^(\d{1,4})([/.-])(\d{1,2})\2(\d{1,4})(?:\s+(\S.*))?$/;
const SHORT_DATE = /^(\d{1,2})\/(\d{1,2})(?:\s+(\S.*))?$/;
const DAY_NAME =
  /^(\d{1,2})(?:\s+de\s+|[\s./-]+)([^\d\s./,-]{3,}\.?)(?:(?:\s+de\s+|[\s./,-]+)(\d{2}|\d{4}))?(?:\s+(\d.*))?$/i;
const NAME_DAY = /^([^\d\s./,-]{3,}\.?)[\s./-]+(\d{1,2})(?:,?\s+(\d{4}))?(?:\s+(\d.*))?$/i;

function withTime(
  serial: number | null,
  timeText: string | undefined,
  dateNf: string,
  locale: SheetLocale,
): ParsedInput | null {
  if (serial === null) return null;
  if (timeText === undefined) return { v: serial, nf: dateNf };
  const t = readTime(timeText.replace(/(?:Z|[+-]\d{2}:?\d{2})$/, ""));
  if (!t || t.elapsed) return null;
  const nf = dateNf === "yyyy-mm-dd" ? "yyyy-mm-dd hh:mm" : NUMBER_FORMATS.datetime(locale);
  return { v: serial + t.value, nf: t.seconds ? `${nf}:ss` : nf };
}

function readDate(text: string, locale: SheetLocale, now: Date): ParsedInput | null {
  const s = normalizeSpaces(text).trim();
  const dateNf = NUMBER_FORMATS.date(locale);
  let m = ISO.exec(s);
  if (m) return withTime(validDate(Number(m[1]), Number(m[2]), Number(m[3])), m[4], "yyyy-mm-dd", locale);
  m = NUMERIC_DATE.exec(s);
  if (m) {
    const a = m[1] ?? "";
    const b = m[3] ?? "";
    const c = m[4] ?? "";
    let serial: number | null = null;
    if (a.length === 4) serial = validDate(Number(a), Number(b), Number(c));
    else if (a.length <= 2 && (c.length === 2 || c.length === 4)) {
      const year = fullYear(c);
      if (year === null) return null;
      if (locale.dateOrder === "mdy") serial = validDate(year, Number(a), Number(b));
      else serial = validDate(year, Number(b), Number(a));
    }
    return withTime(serial, m[5], dateNf, locale);
  }
  m = SHORT_DATE.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = now.getFullYear();
    const serial = locale.dateOrder === "dmy" ? validDate(year, b, a) : validDate(year, a, b);
    return withTime(serial, m[3], dateNf, locale);
  }
  m = DAY_NAME.exec(s);
  if (m) {
    const month = monthOf(m[2] ?? "", locale);
    const year = m[3] === undefined ? now.getFullYear() : fullYear(m[3]);
    if (month === null || year === null) return null;
    return withTime(validDate(year, month, Number(m[1])), m[4], dateNf, locale);
  }
  m = NAME_DAY.exec(s);
  if (m) {
    const month = monthOf(m[1] ?? "", locale);
    const year = m[3] === undefined ? now.getFullYear() : Number(m[3]);
    if (month === null) return null;
    return withTime(validDate(year, month, Number(m[2])), m[4], dateNf, locale);
  }
  return null;
}

const MIXED_FRACTION = /^([+-]?)(\d{1,9})\s+(\d{1,4})\/(\d{1,4})$/;

/**
 * Reads typed text: `{ f }` for a formula, `{ v }` for a value with the `nf` it implies, `{}` for nothing (an empty
 * cell). `now` gives the year for dates typed without one ("17/11").
 */
export function parseInput(text: string, locale: SheetLocale, opts?: { now?: Date }): ParsedInput {
  if (text.length === 0) return {};
  if (text.startsWith("'")) return text.length > 1 ? { v: text.slice(1) } : {};
  if (text.startsWith("=") && text.trim().length > 1) return { f: text.trim() };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { v: text };
  const bool = booleanFromText(trimmed);
  if (bool !== null) return { v: bool };
  const n = readNumber(trimmed, locale);
  if (n) {
    if (n.currency) {
      const zero = n.currency === "¥" || n.currency === "₩";
      return { v: n.value, nf: currencyFormat(n.currency, locale, zero ? 0 : 2, n.after) };
    }
    if (n.percent) return { v: n.value, nf: n.decimals > 0 ? "0.00%" : "0%" };
    if (n.sci) return { v: n.value, nf: "0.00E+00" };
    if (n.grouped) return { v: n.value, nf: n.decimals > 0 ? "#,##0.00" : "#,##0" };
    return { v: n.value };
  }
  const frac = MIXED_FRACTION.exec(trimmed);
  if (frac) {
    const den = Number(frac[4]);
    if (den > 0) {
      const value = (Number(frac[2]) + Number(frac[3]) / den) * (frac[1] === "-" ? -1 : 1);
      const width = String(den).length;
      return { v: value, nf: `# ${"?".repeat(width)}/${"?".repeat(width)}` };
    }
  }
  const date = readDate(trimmed, locale, opts?.now ?? new Date());
  if (date) return date;
  const time = readTime(normalizeSpaces(trimmed));
  if (time) return { v: time.value, nf: timeCode(time) };
  return { v: text };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function dateText(serial: number, locale: SheetLocale, iso: boolean): string {
  const { year, month, day } = serialDate(serial);
  const y = String(year).padStart(4, "0");
  if (iso || locale.dateOrder === "ymd") return `${y}-${pad2(month)}-${pad2(day)}`;
  if (locale.dateOrder === "mdy") return `${month}/${day}/${y}`;
  return `${pad2(day)}/${pad2(month)}/${y}`;
}

function clockText(serial: number, elapsed: boolean): string {
  if (elapsed) {
    const total = Math.round(serial * 86_400);
    const h = Math.floor(total / 3600);
    return `${h}:${pad2(Math.floor((total % 3600) / 60))}:${pad2(total % 60)}`;
  }
  const t = serialTime(serial);
  const second = t.ms >= 500 ? t.second + 1 : t.second;
  if (second === 60) return clockText(Math.floor(serial) + (t.hour * 3600 + t.minute * 60 + 60) / 86_400, false);
  return `${pad2(t.hour)}:${pad2(t.minute)}:${pad2(second)}`;
}

/**
 * What the cell editor shows for a stored value, so typing it back gives the same cell: dates in the locale's order,
 * times as "10:30:00", percentages as "12,5%", numbers in full with the locale's decimal, and an apostrophe before text
 * that would otherwise read as something else ("'00123", "'TRUE").
 */
export function valueInput(
  v: number | string | boolean | null | undefined,
  nf: string | undefined,
  locale: SheetLocale,
): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "boolean") return booleanText(v, locale);
  if (typeof v === "string") {
    if (v === "") return "";
    const back = parseInput(v, locale, { now: new Date(Date.UTC(2000, 0, 1)) });
    return back.f === undefined && back.v === v ? v : `'${v}`;
  }
  const kind = formatKind(nf);
  if ((kind === "date" || kind === "datetime" || kind === "time") && v >= 0 && v < MAX_DATE_SERIAL + 1) {
    const elapsed = /\[[hms]+\]/i.test(nf ?? "");
    const iso = /yyyy-mm-dd/i.test(nf ?? "");
    const days = Math.floor(v);
    const fraction = v - days;
    if (elapsed || (kind === "time" && days === 0)) return clockText(v, elapsed);
    if (kind === "date" && fraction === 0) return dateText(days, locale, iso);
    return `${dateText(days, locale, iso)} ${clockText(fraction, false)}`;
  }
  if (kind === "percent") return `${formatPlain(Number((v * 100).toPrecision(15)), locale)}%`;
  return formatPlain(v, locale);
}
