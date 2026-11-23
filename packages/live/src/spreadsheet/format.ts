/**
 * Excel number format codes (ADR 0196): `#,##0.00`, `0%`, `"R$" #,##0.00`, `0.00E+00`, `# ?/?`, `dd/mm/yyyy`,
 * `[h]:mm`, `[Red]…;…`, so a file imported from Excel keeps its look. A code is stored the way Excel stores it, with
 * "." as the decimal point and "," for thousands; the text comes out with the reader's separators and month names.
 *
 * Supported: up to four sections (positive; negative; zero; text) or conditions (`[>=1000]`), colors (`[Red]`,
 * `[Color 10]`), literals (`"text"`, `\x`, `$ - + ( ) : / space`), padding (`_x`; the fill `*x` is dropped), digit
 * placeholders `0 # ?`, thousands and scaling commas, `%`, scientific `E+ E-` (with engineering steps), fractions
 * (`?/?`, `# ??/??`, `/8`), the text placeholder `@`, `General`, currency and locale tags (`[$R$-416]`), dates and
 * times (`d dd ddd dddd m mm mmm mmmm mmmmm yy yyyy h hh m mm s ss AM/PM A/P` and fractions of a second) and elapsed
 * time (`[h]:mm:ss`, `[mm]:ss`). Numbers are rounded the way Excel shows them: to 15 significant digits, then half
 * away from zero, so 1.005 shows as 1.01.
 */
import { MAX_DATE_SERIAL, serialDate } from "./dates";
import { currencyAfter, localeNames, type SheetLocale } from "./locale";
import { booleanText, type CellValue, errorText, isError } from "./values";

export interface FormattedValue {
  text: string;
  /** The color a section asks for (`[Red]`, `[Color 10]`), as `#rrggbb`. */
  color?: string;
  /** Where the value sits when the cell sets no alignment: numbers right, text left, booleans and errors centered. */
  align?: "l" | "c" | "r";
}

type Ph = "0" | "#" | "?";
type DateChar = "y" | "m" | "mo" | "mi" | "d" | "h" | "s" | "eh" | "em" | "es";

type Tok =
  | { k: "lit"; v: string }
  | { k: "ph"; c: Ph; at: number }
  | { k: "point"; at: number }
  | { k: "comma" }
  | { k: "pct" }
  | { k: "exp"; plus: boolean; upper: boolean; at: number }
  | { k: "slash" }
  | { k: "den"; v: number }
  | { k: "at" }
  | { k: "general" }
  | { k: "date"; c: DateChar; n: number }
  | { k: "ampm"; am: string; pm: string }
  | { k: "sub"; n: number };

interface Cond {
  op: "<" | "<=" | ">" | ">=" | "=" | "<>";
  v: number;
}

type NumItem =
  | { k: "lit"; v: string }
  | { k: "int"; i: number }
  | { k: "frac"; i: number }
  | { k: "exp"; i: number }
  | { k: "e" }
  | { k: "point" }
  | { k: "whole"; i: number }
  | { k: "num"; i: number }
  | { k: "den"; i: number }
  | { k: "denfix" }
  | { k: "slash" };

interface NumberPlan {
  items: NumItem[];
  int: Ph[];
  frac: Ph[];
  exp: Ph[];
  group: boolean;
  /** Powers of ten to shift by: +2 per `%`, -3 per scaling comma. */
  shift: number;
  sci?: { plus: boolean; upper: boolean };
  fraction?: { whole: Ph[]; num: Ph[]; den: Ph[]; fixed: number | null };
}

interface Section {
  kind: "number" | "date" | "text" | "general" | "literal";
  toks: Tok[];
  color?: string;
  cond?: Cond;
  plan?: NumberPlan;
  /** Date sections: whether a time of day shows (then the value rounds to the shown second). */
  time: boolean;
  ampm: boolean;
  /** Digits of a second shown (`ss.00` → 2). */
  sub: number;
}

interface ParsedFormat {
  /** Sections for numbers (zero to three). */
  numbers: Section[];
  text?: Section;
  general: boolean;
}

/** Excel's named colors and its 56-color palette (`[Color1]`…`[Color56]`). */
const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#00ff00",
  blue: "#0000ff",
  yellow: "#ffff00",
  magenta: "#ff00ff",
  cyan: "#00ffff",
};

const PALETTE = (
  "000000 ffffff ff0000 00ff00 0000ff ffff00 ff00ff 00ffff 800000 008000 000080 808000 800080 008080 c0c0c0 808080 " +
  "9999ff 993366 ffffcc ccffff 660066 ff8080 0066cc ccccff 000080 ff00ff ffff00 00ffff 800080 800000 008080 0000ff " +
  "00ccff ccffff ccffcc ffff99 99ccff ff99cc cc99ff ffcc99 3366ff 33cccc 99cc00 ffcc00 ff9900 ff6600 666699 969696 " +
  "003366 339966 003300 333300 993300 993366 333399 333333"
)
  .split(" ")
  .map((hex) => `#${hex}`);

const COND = /^(<=|>=|<>|<|>|=)\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)$/i;

function isDigitCode(code: number): boolean {
  return code >= 48 && code <= 57;
}

function startsWithCI(src: string, i: number, word: string): boolean {
  return src.slice(i, i + word.length).toLowerCase() === word;
}

/** Splits a code on `;` outside quotes, escapes and brackets. */
function splitSections(code: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < code.length) {
    const c = code.charAt(i);
    if (c === '"') {
      const end = code.indexOf('"', i + 1);
      i = end < 0 ? code.length : end + 1;
      continue;
    }
    if (c === "\\" || c === "_" || c === "*") {
      i += 2;
      continue;
    }
    if (c === "[") {
      const end = code.indexOf("]", i + 1);
      i = end < 0 ? code.length : end + 1;
      continue;
    }
    if (c === ";") {
      out.push(code.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  out.push(code.slice(start));
  return out;
}

function tokenize(src: string): { toks: Tok[]; color?: string; cond?: Cond } {
  const toks: Tok[] = [];
  let color: string | undefined;
  let cond: Cond | undefined;
  const lit = (v: string) => {
    if (v.length === 0) return;
    const last = toks[toks.length - 1];
    if (last?.k === "lit") last.v += v;
    else toks.push({ k: "lit", v });
  };
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    switch (c) {
      case '"': {
        const end = src.indexOf('"', i + 1);
        const stop = end < 0 ? src.length : end;
        lit(src.slice(i + 1, stop));
        i = stop + 1;
        break;
      }
      case "\\":
        lit(src.charAt(i + 1));
        i += 2;
        break;
      case "_":
        lit(" ");
        i += 2;
        break;
      case "*":
        // Repeats a character to fill the cell's width; there is no width here, so it is dropped.
        i += 2;
        break;
      case "[": {
        const end = src.indexOf("]", i + 1);
        if (end < 0) {
          lit(src.slice(i));
          i = src.length;
          break;
        }
        const body = src.slice(i + 1, end).trim();
        const lower = body.toLowerCase();
        const named = NAMED_COLORS[lower];
        const indexed = /^color\s*(\d{1,2})$/.exec(lower);
        const condition = COND.exec(body);
        if (named) color = named;
        else if (indexed) color = PALETTE[Number(indexed[1]) - 1] ?? color;
        else if (condition) cond = { op: condition[1] as Cond["op"], v: Number(condition[2]) };
        else if (body.startsWith("$")) {
          const dash = body.indexOf("-", 1);
          lit(dash < 0 ? body.slice(1) : body.slice(1, dash));
        } else if (/^(h+|m+|s+)$/.test(lower)) {
          toks.push({
            k: "date",
            c: lower.startsWith("h") ? "eh" : lower.startsWith("m") ? "em" : "es",
            n: body.length,
          });
        }
        i = end + 1;
        break;
      }
      case "0":
      case "#":
      case "?":
        toks.push({ k: "ph", c, at: i });
        i++;
        break;
      case ".":
        toks.push({ k: "point", at: i });
        i++;
        break;
      case ",":
        toks.push({ k: "comma" });
        i++;
        break;
      case "%":
        toks.push({ k: "pct" });
        i++;
        break;
      case "@":
        toks.push({ k: "at" });
        i++;
        break;
      case "/": {
        let j = i + 1;
        while (j < src.length && isDigitCode(src.charCodeAt(j))) j++;
        toks.push({ k: "slash" });
        if (j > i + 1 && src.charAt(i + 1) !== "0") {
          toks.push({ k: "den", v: Number(src.slice(i + 1, j)) });
          i = j;
        } else i++;
        break;
      }
      case "E":
      case "e": {
        const next = src.charAt(i + 1);
        if (next === "+" || next === "-") {
          toks.push({ k: "exp", plus: next === "+", upper: c === "E", at: i });
          i += 2;
        } else {
          lit(c);
          i++;
        }
        break;
      }
      default: {
        if (startsWithCI(src, i, "general")) {
          toks.push({ k: "general" });
          i += 7;
          break;
        }
        if (startsWithCI(src, i, "am/pm")) {
          toks.push({ k: "ampm", am: src.slice(i, i + 2), pm: src.slice(i + 3, i + 5) });
          i += 5;
          break;
        }
        if (startsWithCI(src, i, "a/p")) {
          toks.push({ k: "ampm", am: src.charAt(i), pm: src.charAt(i + 2) });
          i += 3;
          break;
        }
        const lower = c.toLowerCase();
        if (lower === "y" || lower === "m" || lower === "d" || lower === "h" || lower === "s") {
          let j = i + 1;
          while (j < src.length && src.charAt(j).toLowerCase() === lower) j++;
          toks.push({ k: "date", c: lower, n: j - i });
          i = j;
          break;
        }
        lit(c);
        i++;
      }
    }
  }
  return { toks, ...(color ? { color } : {}), ...(cond ? { cond } : {}) };
}

function tokText(t: Tok): string {
  switch (t.k) {
    case "lit":
      return t.v;
    case "ph":
      return t.c;
    case "point":
      return ".";
    case "comma":
      return ",";
    case "pct":
      return "%";
    case "slash":
      return "/";
    case "den":
      return String(t.v);
    case "at":
      return "";
    case "exp":
      return `${t.upper ? "E" : "e"}${t.plus ? "+" : "-"}`;
    default:
      return "";
  }
}

/** Date sections: `m`/`mm` right after hours or right before seconds are minutes; `.0`… after seconds are fractions. */
function planDate(toks: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as Tok;
    if (t.k === "point") {
      let n = 0;
      while (toks[i + 1 + n]?.k === "ph" && (toks[i + 1 + n] as { c: Ph }).c === "0") n++;
      if (n > 0) {
        out.push({ k: "sub", n: Math.min(n, 3) });
        i += n;
        continue;
      }
    }
    if (t.k === "date" || t.k === "ampm" || t.k === "lit" || t.k === "general") out.push(t);
    else {
      const text = tokText(t);
      if (text) out.push({ k: "lit", v: text });
    }
  }
  const dates = out.filter((t): t is Extract<Tok, { k: "date" }> => t.k === "date");
  for (let i = 0; i < dates.length; i++) {
    const t = dates[i] as Extract<Tok, { k: "date" }>;
    if (t.c !== "m") continue;
    if (t.n > 2) {
      t.c = "mo";
      continue;
    }
    const prev = dates[i - 1]?.c;
    const next = dates[i + 1]?.c;
    t.c = prev === "h" || prev === "eh" || next === "s" || next === "es" ? "mi" : "mo";
  }
  // Merge neighboring literals left by the steps above.
  const merged: Tok[] = [];
  for (const t of out) {
    const last = merged[merged.length - 1];
    if (t.k === "lit" && last?.k === "lit") last.v += t.v;
    else merged.push(t.k === "lit" ? { k: "lit", v: t.v } : t);
  }
  return merged;
}

function planNumber(toks: Tok[]): NumberPlan {
  const plan: NumberPlan = { items: [], int: [], frac: [], exp: [], group: false, shift: 0 };
  const expAt = toks.findIndex((t) => t.k === "exp");
  const phIndexes = toks.flatMap((t, i) => (t.k === "ph" ? [i] : []));
  const firstPh = phIndexes[0] ?? -1;
  const slashAt = toks.findIndex((t, i) => t.k === "slash" && i > firstPh && firstPh >= 0);
  const pointAt = toks.findIndex((t) => t.k === "point");
  const isFraction =
    expAt < 0 &&
    pointAt < 0 &&
    slashAt > 0 &&
    toks[slashAt - 1]?.k === "ph" &&
    (toks[slashAt + 1]?.k === "ph" || toks[slashAt + 1]?.k === "den");
  if (isFraction) return planFraction(toks, slashAt, plan);

  const end = expAt >= 0 ? expAt : toks.length;
  const intEnd = pointAt >= 0 && pointAt < end ? pointAt : end;
  const lastIntPh = phIndexes.filter((i) => i < intEnd).pop() ?? -1;
  const lastPh = phIndexes.filter((i) => i < end).pop() ?? -1;
  let pointSeen = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as Tok;
    switch (t.k) {
      case "ph":
        if (i < intEnd) plan.items.push({ k: "int", i: plan.int.push(t.c) - 1 });
        else if (i < end) plan.items.push({ k: "frac", i: plan.frac.push(t.c) - 1 });
        else plan.items.push({ k: "exp", i: plan.exp.push(t.c) - 1 });
        break;
      case "point":
        if (!pointSeen && i < end) {
          pointSeen = true;
          // ".00" still shows the integer digits a number has: they go before the point.
          if (plan.int.length === 0 && expAt < 0) plan.items.push({ k: "int", i: plan.int.push("#") - 1 });
          plan.items.push({ k: "point" });
        } else plan.items.push({ k: "lit", v: "." });
        break;
      case "comma":
        if (firstPh < 0 || i < firstPh) plan.items.push({ k: "lit", v: "," });
        else if (i < lastIntPh) plan.group = true;
        else if (i > lastPh || (i > lastIntPh && i < intEnd)) plan.shift -= 3;
        break;
      case "pct":
        plan.shift += 2;
        plan.items.push({ k: "lit", v: "%" });
        break;
      case "exp":
        if (i === expAt) {
          plan.sci = { plus: t.plus, upper: t.upper };
          plan.items.push({ k: "e" });
        } else plan.items.push({ k: "lit", v: tokText(t) });
        break;
      case "lit":
        plan.items.push({ k: "lit", v: t.v });
        break;
      default: {
        const text = tokText(t);
        if (text) plan.items.push({ k: "lit", v: text });
      }
    }
  }
  return plan;
}

function planFraction(toks: Tok[], slashAt: number, plan: NumberPlan): NumberPlan {
  // The numerator is the run of placeholders right before the slash; placeholders before it (past a literal) are the
  // whole part; after the slash, placeholders or a fixed number are the denominator.
  let numStart = slashAt;
  while (numStart > 0 && toks[numStart - 1]?.k === "ph") numStart--;
  let denEnd = slashAt + 1;
  let fixed: number | null = null;
  if (toks[denEnd]?.k === "den") {
    fixed = (toks[denEnd] as { v: number }).v;
    denEnd++;
  } else while (toks[denEnd]?.k === "ph") denEnd++;
  const fraction = { whole: [] as Ph[], num: [] as Ph[], den: [] as Ph[], fixed };
  const wholePhs = toks.slice(0, numStart).flatMap((t, i) => (t.k === "ph" ? [i] : []));
  const lastWhole = wholePhs[wholePhs.length - 1] ?? -1;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as Tok;
    if (t.k === "ph") {
      if (i < numStart) plan.items.push({ k: "whole", i: fraction.whole.push(t.c) - 1 });
      else if (i < slashAt) plan.items.push({ k: "num", i: fraction.num.push(t.c) - 1 });
      else if (i < denEnd) plan.items.push({ k: "den", i: fraction.den.push(t.c) - 1 });
      else plan.items.push({ k: "lit", v: t.c });
    } else if (i === slashAt) plan.items.push({ k: "slash" });
    else if (t.k === "den" && i < denEnd) plan.items.push({ k: "denfix" });
    else if (t.k === "comma" && i < lastWhole) plan.group = true;
    else if (t.k === "lit") plan.items.push({ k: "lit", v: t.v });
    else {
      const text = tokText(t);
      if (text) plan.items.push({ k: "lit", v: text });
    }
  }
  plan.fraction = fraction;
  return plan;
}

function parseSection(src: string): Section {
  const { toks, color, cond } = tokenize(src);
  const has = (k: Tok["k"]) => toks.some((t) => t.k === k);
  const base = { ...(color ? { color } : {}), ...(cond ? { cond } : {}), time: false, ampm: false, sub: 0 };
  if (has("date") || has("ampm")) {
    const planned = planDate(toks);
    const time = planned.some(
      (t) => (t.k === "date" && ["h", "mi", "s", "eh", "em", "es"].includes(t.c)) || t.k === "ampm" || t.k === "sub",
    );
    const sub = planned.reduce((n, t) => (t.k === "sub" ? Math.max(n, t.n) : n), 0);
    return { ...base, kind: "date", toks: planned, time, ampm: planned.some((t) => t.k === "ampm"), sub };
  }
  if (has("at")) return { ...base, kind: "text", toks };
  if (has("ph")) return { ...base, kind: "number", toks, plan: planNumber(toks) };
  if (has("general")) return { ...base, kind: "general", toks };
  return { ...base, kind: "literal", toks };
}

const CACHE = new Map<string, ParsedFormat>();
const GENERAL: ParsedFormat = { numbers: [], general: true };

function parseFormat(code: string | undefined): ParsedFormat {
  if (code === undefined || code === "" || code.toLowerCase() === "general") return GENERAL;
  const cached = CACHE.get(code);
  if (cached) return cached;
  const sections = splitSections(code).slice(0, 4).map(parseSection);
  let numbers = sections;
  let text: Section | undefined;
  if (sections.length === 4) {
    numbers = sections.slice(0, 3);
    text = sections[3];
  } else if (sections[sections.length - 1]?.kind === "text") {
    numbers = sections.slice(0, -1);
    text = sections[sections.length - 1];
  }
  const parsed: ParsedFormat = { numbers, ...(text ? { text } : {}), general: false };
  if (CACHE.size >= 1000) CACHE.clear();
  CACHE.set(code, parsed);
  return parsed;
}

// ---------------------------------------------------------------------------------------------------------------------
// Decimal arithmetic on digit strings, so rounding matches what Excel shows.

interface Decimal {
  /** Significant digits without leading or trailing zeros ("" for zero). */
  d: string;
  /** Digits before the decimal point: the value is 0.d × 10^e. */
  e: number;
}

function decimalOf(x: number): Decimal {
  if (x === 0 || !Number.isFinite(x)) return { d: "", e: 0 };
  const s = Math.abs(x).toPrecision(15);
  const ei = s.indexOf("e");
  const mant = ei >= 0 ? s.slice(0, ei) : s;
  const exp = ei >= 0 ? Number(s.slice(ei + 1)) : 0;
  const dot = mant.indexOf(".");
  let digits = dot >= 0 ? mant.slice(0, dot) + mant.slice(dot + 1) : mant;
  let e = (dot >= 0 ? dot : mant.length) + exp;
  let lead = 0;
  while (lead < digits.length && digits.charCodeAt(lead) === 48) lead++;
  digits = digits.slice(lead);
  e -= lead;
  let end = digits.length;
  while (end > 0 && digits.charCodeAt(end - 1) === 48) end--;
  digits = digits.slice(0, end);
  return digits === "" ? { d: "", e: 0 } : { d: digits, e };
}

/** Rounds half away from zero to `decimals` places: the integer digits ("" for 0) and exactly `decimals` digits. */
function roundTo(dec: Decimal, decimals: number): { int: string; frac: string } {
  let { d, e } = dec;
  const keep = e + decimals;
  if (d === "" || keep < 0) return { int: "", frac: "0".repeat(decimals) };
  if (keep < d.length) {
    const up = d.charCodeAt(keep) >= 53;
    d = d.slice(0, keep);
    if (up) {
      const digits = d.split("");
      let i = digits.length - 1;
      while (i >= 0 && digits[i] === "9") {
        digits[i] = "0";
        i--;
      }
      if (i < 0) {
        digits.unshift("1");
        e += 1;
      } else digits[i] = String(Number(digits[i]) + 1);
      d = digits.join("");
    }
  }
  if (e > 0) {
    const int = d.slice(0, e).padEnd(e, "0");
    const frac = d.slice(e).padEnd(decimals, "0").slice(0, decimals);
    return { int: int.replace(/^0+/, ""), frac };
  }
  const frac = ("0".repeat(-e) + d).padEnd(decimals, "0").slice(0, decimals);
  return { int: "", frac };
}

function isZeroDigits(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) !== 48) return false;
  return true;
}

/** Fills integer placeholders right to left; the leftmost one takes every extra digit. */
function fillInt(digits: string, slots: Ph[], sep: string | null): string[] {
  const out = new Array<string>(slots.length).fill("");
  let di = digits.length - 1;
  let pos = 0;
  const put = (digit: string) => {
    const text = sep && pos > 0 && pos % 3 === 0 ? digit + sep : digit;
    pos++;
    return text;
  };
  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i] as Ph;
    let s = "";
    if (di >= 0) {
      s = put(digits.charAt(di));
      di--;
      if (i === 0) {
        while (di >= 0) {
          s = put(digits.charAt(di)) + s;
          di--;
        }
      }
    } else if (slot === "0") s = put("0");
    else if (slot === "?") s = " ";
    out[i] = s;
  }
  return out;
}

/** Fills placeholders left to right (decimals, denominators): what's missing at the end follows the placeholder. */
function fillLeft(digits: string, slots: Ph[], trimZeros: boolean): string[] {
  let last = digits.length - 1;
  if (trimZeros) while (last >= 0 && digits.charCodeAt(last) === 48) last--;
  return slots.map((slot, j) => {
    if (j <= last && j < digits.length) return digits.charAt(j);
    return slot === "0" ? "0" : slot === "?" ? " " : "";
  });
}

function renderNumber(plan: NumberPlan, v: number, locale: SheetLocale): { text: string; zero: boolean } {
  if (plan.fraction) return renderFraction(plan, v, locale);
  let dec = decimalOf(v);
  if (dec.d !== "") dec = { d: dec.d, e: dec.e + plan.shift };
  let int: string;
  let frac: string;
  let expText = "";
  let expNegative = false;
  if (plan.sci) {
    // As many integer digits as placeholders; with "##0" (engineering) the exponent steps by the placeholders' count.
    const ni = plan.int.length;
    const engineering = ni > 1 && plan.int[0] === "#";
    let exponent = 0;
    let rounded = { int: "", frac: "0".repeat(plan.frac.length) };
    if (dec.d !== "") {
      exponent = engineering ? Math.floor((dec.e - 1) / ni) * ni : dec.e - ni;
      rounded = roundTo({ d: dec.d, e: dec.e - exponent }, plan.frac.length);
      if (rounded.int.length > ni) {
        exponent += engineering ? ni : 1;
        rounded = roundTo({ d: dec.d, e: dec.e - exponent }, plan.frac.length);
      }
    }
    int = rounded.int;
    frac = rounded.frac;
    expNegative = exponent < 0;
    expText = String(Math.abs(exponent));
  } else {
    const rounded = roundTo(dec, plan.frac.length);
    int = rounded.int;
    frac = rounded.frac;
  }
  const ints = fillInt(int, plan.int, plan.group ? locale.group : null);
  const fracs = fillLeft(frac, plan.frac, true);
  const exps = fillInt(expText, plan.exp, null);
  let text = "";
  for (const item of plan.items) {
    switch (item.k) {
      case "lit":
        text += item.v;
        break;
      case "int":
        text += ints[item.i] ?? "";
        break;
      case "frac":
        text += fracs[item.i] ?? "";
        break;
      case "point":
        text += locale.decimal;
        break;
      case "e":
        text += (plan.sci?.upper ? "E" : "e") + (expNegative ? "-" : plan.sci?.plus ? "+" : "");
        break;
      case "exp":
        text += exps[item.i] ?? "";
        break;
    }
  }
  return { text, zero: int === "" && isZeroDigits(frac) };
}

/** The closest fraction with a denominator up to `maxDen` (continued fractions, with the best semiconvergent). */
function closestFraction(x: number, maxDen: number): [number, number] {
  let p0 = 0;
  let q0 = 1;
  let p1 = 1;
  let q1 = 0;
  let r = x;
  for (let i = 0; i < 64; i++) {
    const a = Math.floor(r);
    const p2 = a * p1 + p0;
    const q2 = a * q1 + q0;
    if (q2 > maxDen) {
      if (q1 === 0) return [Math.round(x), 1];
      const k = Math.floor((maxDen - q0) / q1);
      const pk = k * p1 + p0;
      const qk = k * q1 + q0;
      return qk > 0 && Math.abs(x - pk / qk) < Math.abs(x - p1 / q1) ? [pk, qk] : [p1, q1];
    }
    p0 = p1;
    q0 = q1;
    p1 = p2;
    q1 = q2;
    const rest = r - a;
    if (rest < 1e-10) break;
    r = 1 / rest;
  }
  return [p1, q1 || 1];
}

function renderFraction(plan: NumberPlan, v: number, locale: SheetLocale): { text: string; zero: boolean } {
  const f = plan.fraction as NonNullable<NumberPlan["fraction"]>;
  let whole = 0;
  let rest = v;
  if (f.whole.length > 0) {
    whole = Math.floor(v);
    rest = v - whole;
  }
  let num: number;
  let den: number;
  if (f.fixed !== null) {
    den = f.fixed;
    num = Math.round(rest * den);
  } else {
    [num, den] = closestFraction(rest, Math.max(1, 10 ** Math.max(1, f.den.length) - 1));
  }
  if (f.whole.length > 0 && num >= den && den > 0) {
    whole += Math.floor(num / den);
    num %= den;
  }
  const blank = num === 0 && f.whole.length > 0;
  const wholeText = fillInt(whole > 0 || blank ? String(whole) : "", f.whole, plan.group ? locale.group : null);
  const nums = blank ? f.num.map(() => " ") : fillInt(String(num), f.num, null);
  const dens = blank ? f.den.map(() => " ") : fillLeft(String(den), f.den, false);
  let text = "";
  for (const item of plan.items) {
    switch (item.k) {
      case "lit":
        text += item.v;
        break;
      case "whole":
        text += wholeText[item.i] ?? "";
        break;
      case "num":
        text += nums[item.i] ?? "";
        break;
      case "den":
        text += dens[item.i] ?? "";
        break;
      case "denfix":
        text += blank ? " ".repeat(String(den).length) : String(den);
        break;
      case "slash":
        text += blank ? " " : "/";
        break;
    }
  }
  return { text, zero: whole === 0 && num === 0 };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function renderDate(sec: Section, v: number, locale: SheetLocale): string {
  if (!(v >= 0) || v >= MAX_DATE_SERIAL + 1) return "#####";
  const unit = 10 ** sec.sub;
  const perDay = 86_400 * unit;
  let days: number;
  let units: number;
  if (sec.time) {
    const total = Math.round(v * perDay);
    days = Math.floor(total / perDay);
    units = total - days * perDay;
  } else {
    days = Math.floor(v);
    units = 0;
  }
  const date = serialDate(days);
  const secondsOfDay = Math.floor(units / unit);
  const hour = Math.floor(secondsOfDay / 3600);
  const minute = Math.floor((secondsOfDay % 3600) / 60);
  const second = secondsOfDay % 60;
  const totalSeconds = days * 86_400 + secondsOfDay;
  const elapsedHours = sec.toks.some((t) => t.k === "date" && t.c === "eh");
  const elapsedMinutes = sec.toks.some((t) => t.k === "date" && t.c === "em");
  const names = localeNames(locale);
  let text = "";
  for (const t of sec.toks) {
    if (t.k === "lit") text += t.v;
    else if (t.k === "ampm") text += hour < 12 ? t.am : t.pm;
    else if (t.k === "sub")
      text +=
        locale.decimal +
        String(units % unit)
          .padStart(sec.sub, "0")
          .slice(0, t.n);
    else if (t.k === "date") {
      switch (t.c) {
        case "y":
          text += t.n <= 2 ? pad2(date.year % 100) : String(date.year).padStart(4, "0");
          break;
        case "mo":
        case "m":
          if (t.n === 1) text += String(date.month);
          else if (t.n === 2) text += pad2(date.month);
          else if (t.n === 3) text += names.monthsShort[date.month - 1] ?? "";
          else if (t.n === 5) text += (names.months[date.month - 1] ?? "").charAt(0);
          else text += names.months[date.month - 1] ?? "";
          break;
        case "d":
          if (t.n === 1) text += String(date.day);
          else if (t.n === 2) text += pad2(date.day);
          else if (t.n === 3) text += names.daysShort[date.weekday] ?? "";
          else text += names.days[date.weekday] ?? "";
          break;
        case "h": {
          const h = sec.ampm ? hour % 12 || 12 : hour;
          text += t.n >= 2 ? pad2(h) : String(h);
          break;
        }
        case "mi": {
          const m = elapsedHours ? Math.floor(totalSeconds / 60) % 60 : minute;
          text += t.n >= 2 ? pad2(m) : String(m);
          break;
        }
        case "s": {
          const s = elapsedHours || elapsedMinutes ? totalSeconds % 60 : second;
          text += t.n >= 2 ? pad2(s) : String(s);
          break;
        }
        case "eh":
          text += String(Math.floor(totalSeconds / 3600)).padStart(t.n, "0");
          break;
        case "em":
          text += String(Math.floor(totalSeconds / 60)).padStart(t.n, "0");
          break;
        case "es":
          text += String(totalSeconds).padStart(t.n, "0");
          break;
      }
    }
  }
  return text;
}

function stripZeros(s: string): string {
  const e = s.search(/e/i);
  const mant = e >= 0 ? s.slice(0, e) : s;
  const exp = e >= 0 ? s.slice(e) : "";
  const trimmed = mant.includes(".") ? mant.replace(/0+$/, "").replace(/\.$/, "") : mant;
  return trimmed + exp;
}

function exponential(a: number): string {
  const s = stripZeros(a.toExponential(5));
  const m = /^(.*)e([+-])(\d+)$/.exec(s);
  if (!m) return s;
  return `${m[1]}E${m[2]}${(m[3] ?? "").padStart(2, "0")}`;
}

/**
 * Excel's General: up to 11 characters, the decimals that fit, then scientific ("1.23457E+11", "1.5E-09"), with the
 * reader's decimal separator and no thousands.
 */
export function formatGeneral(x: number, locale: Pick<SheetLocale, "decimal">): string {
  if (x === 0) return "0";
  if (!Number.isFinite(x)) return "#NUM!";
  const a = Math.abs(x);
  const dec = decimalOf(a);
  const magnitude = dec.e - 1;
  let s: string;
  if (magnitude >= -4 && magnitude <= -1) s = stripZeros(a.toPrecision(10 + magnitude));
  else if (Math.abs(magnitude) <= 9) {
    const fixed = stripZeros(a.toFixed(12));
    if (fixed.length <= 11) s = fixed;
    else {
      const precise = stripZeros(a.toPrecision(10));
      s = precise.length <= 11 && !/e/i.test(precise) ? precise : exponential(a);
    }
  } else if (magnitude === 10) s = String(Math.round(a));
  else s = exponential(a);
  if (s.length > 11 && !s.includes("E")) s = exponential(a);
  if (locale.decimal !== ".") s = s.replace(".", locale.decimal);
  return x < 0 ? `-${s}` : s;
}

/**
 * A number in full, as the formula bar shows it: up to 15 significant digits, no thousands, the reader's decimal
 * separator, scientific only past 21 digits or below 1E-9 ("1234.5", "0.1", "1.5E+22").
 */
export function formatPlain(x: number, locale: Pick<SheetLocale, "decimal">): string {
  if (x === 0) return "0";
  if (!Number.isFinite(x)) return "#NUM!";
  const { d, e } = decimalOf(x);
  let s: string;
  if (e > 21 || e < -8) {
    const mant = d.length > 1 ? `${d.charAt(0)}.${d.slice(1)}` : d;
    const exp = e - 1;
    s = `${mant}E${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  } else if (e <= 0) s = `0.${"0".repeat(-e)}${d}`;
  else if (d.length <= e) s = d.padEnd(e, "0");
  else s = `${d.slice(0, e)}.${d.slice(e)}`;
  if (locale.decimal !== ".") s = s.replace(".", locale.decimal);
  return x < 0 ? `-${s}` : s;
}

function test(cond: Cond, x: number): boolean {
  switch (cond.op) {
    case "<":
      return x < cond.v;
    case "<=":
      return x <= cond.v;
    case ">":
      return x > cond.v;
    case ">=":
      return x >= cond.v;
    case "=":
      return x === cond.v;
    case "<>":
      return x !== cond.v;
  }
}

/** A condition only negative numbers meet: such a section shows them without the minus sign, as a negative section. */
function onlyNegatives(cond: Cond): boolean {
  return (cond.op === "<" && cond.v <= 0) || (cond.op === "<=" && cond.v < 0) || (cond.op === "=" && cond.v < 0);
}

function renderSection(sec: Section, v: number, locale: SheetLocale): { text: string; zero: boolean } {
  switch (sec.kind) {
    case "number":
      return renderNumber(sec.plan as NumberPlan, v, locale);
    case "date":
      return { text: renderDate(sec, v, locale), zero: true };
    case "general": {
      const general = formatGeneral(v, locale);
      return {
        text: sec.toks.map((t) => (t.k === "general" ? general : t.k === "lit" ? t.v : tokText(t))).join(""),
        zero: v === 0,
      };
    }
    default:
      return { text: sec.toks.map((t) => (t.k === "lit" ? t.v : tokText(t))).join(""), zero: false };
  }
}

function formatNumber(p: ParsedFormat, x: number, locale: SheetLocale): FormattedValue {
  const secs = p.numbers;
  if (secs.length === 0) return { text: formatGeneral(x, locale), align: "r" };
  let index = 0;
  const conditional = secs[0]?.cond !== undefined || secs[1]?.cond !== undefined;
  if (secs.length > 1) {
    if (!conditional) index = x < 0 ? 1 : x === 0 && secs.length >= 3 ? 2 : 0;
    else {
      const first = secs[0] as Section;
      const c0 = first.cond ?? { op: secs.length >= 3 ? ">" : ">=", v: 0 };
      const second = secs[1];
      if (test(c0, x)) index = 0;
      else if (second && (!second.cond || test(second.cond, x))) index = 1;
      else if (secs[2]) index = 2;
      else return { text: formatGeneral(x, locale), align: "r" };
    }
  }
  const sec = secs[index] as Section;
  let v = x;
  let minus = false;
  if (x < 0) {
    v = -x;
    if (secs.length === 1) minus = !(sec.cond && onlyNegatives(sec.cond));
    else if (index === 0) minus = !(sec.cond && onlyNegatives(sec.cond));
    else if (index === 2) minus = true;
  }
  if (sec.kind === "date" && x < 0) return { text: "#####", align: "r", ...(sec.color ? { color: sec.color } : {}) };
  const out = renderSection(sec, v, locale);
  const text = minus && !out.zero ? `-${out.text}` : out.text;
  return { text, align: "r", ...(sec.color ? { color: sec.color } : {}) };
}

/**
 * A value as the reader sees it in a cell with number format `nf` (Excel's code; undefined is General). Booleans
 * and errors ignore the format and show in the reader's language.
 */
export function formatValue(value: CellValue | undefined, nf: string | undefined, locale: SheetLocale): FormattedValue {
  if (value === null || value === undefined) return { text: "" };
  if (typeof value === "boolean") return { text: booleanText(value, locale), align: "c" };
  if (isError(value)) return { text: errorText(value.error, locale), align: "c" };
  if (typeof value === "string") {
    if (value === "") return { text: "" };
    const p = parseFormat(nf);
    if (p.text) {
      const sec = p.text;
      const text = sec.toks.map((t) => (t.k === "at" ? value : t.k === "lit" ? t.v : "")).join("");
      return { text, align: "l", ...(sec.color ? { color: sec.color } : {}) };
    }
    return { text: value, align: "l" };
  }
  if (!Number.isFinite(value)) return { text: errorText("#NUM!", locale), align: "c" };
  return formatNumber(parseFormat(nf), value, locale);
}

// ---------------------------------------------------------------------------------------------------------------------
// Presets and what a format is.

export type NumberFormatPreset =
  | "general"
  | "number"
  | "integer"
  | "percent"
  | "percent2"
  | "currency"
  | "date"
  | "datetime"
  | "time"
  | "text"
  | "scientific";

/**
 * The format code for a currency sign in a locale: `"R$" #,##0.00`, `$#,##0.00`, `#,##0.00 "€"`. The sign goes where
 * the locale puts it, unless `after` says otherwise (where it was typed).
 */
export function currencyFormat(
  symbol: string,
  locale: SheetLocale,
  decimals = 2,
  after: boolean = currencyAfter(locale),
): string {
  const num = decimals > 0 ? `#,##0.${"0".repeat(decimals)}` : "#,##0";
  if (symbol === "$") return after ? `${num} $` : `$${num}`;
  const quoted = `"${symbol.replace(/"/g, "")}"`;
  return after ? `${num} ${quoted}` : `${quoted} ${num}`;
}

function dateCode(locale: SheetLocale): string {
  return locale.dateOrder === "dmy" ? "dd/mm/yyyy" : locale.dateOrder === "mdy" ? "m/d/yyyy" : "yyyy-mm-dd";
}

/**
 * The presets the toolbar and the agents' tools offer, each as its code for a locale (currency and dates follow it):
 * `NUMBER_FORMATS.currency(sheetLocale("pt-BR"))` is `"R$" #,##0.00`.
 */
export const NUMBER_FORMATS: Readonly<Record<NumberFormatPreset, (locale: SheetLocale) => string>> = {
  general: () => "General",
  number: () => "#,##0.00",
  integer: () => "#,##0",
  percent: () => "0%",
  percent2: () => "0.00%",
  currency: (locale) =>
    currencyFormat(locale.currency, locale, locale.currency === "¥" || locale.currency === "₩" ? 0 : 2),
  date: dateCode,
  datetime: (locale) => (locale.dateOrder === "mdy" ? "m/d/yyyy h:mm" : `${dateCode(locale)} hh:mm`),
  time: () => "hh:mm",
  text: () => "@",
  scientific: () => "0.00E+00",
};

const PRESET_NAMES = new Set<string>(Object.keys(NUMBER_FORMATS));

export function isNumberFormatPreset(name: string): name is NumberFormatPreset {
  return PRESET_NAMES.has(name);
}

/** A preset's code in a locale. */
export function numberFormatCode(preset: NumberFormatPreset, locale: SheetLocale): string {
  return NUMBER_FORMATS[preset](locale);
}

/** Which preset a cell's code is (for the toolbar's checked item); "general" for no code, null for a custom one. */
export function numberFormatPreset(nf: string | undefined, locale: SheetLocale): NumberFormatPreset | null {
  if (nf === undefined || nf === "" || nf.toLowerCase() === "general") return "general";
  for (const preset of Object.keys(NUMBER_FORMATS) as NumberFormatPreset[]) {
    if (preset !== "general" && NUMBER_FORMATS[preset](locale) === nf) return preset;
  }
  return null;
}

export type FormatKind =
  | "general"
  | "number"
  | "percent"
  | "currency"
  | "scientific"
  | "fraction"
  | "date"
  | "time"
  | "datetime"
  | "text";

const CURRENCY_SIGNS = /[$€£¥₩₹₺₽¢]|R\$|zł|Rp|kr|CHF/;

/** What kind of value a code shows, by its first section (the text section for `@`). */
export function formatKind(nf: string | undefined): FormatKind {
  const p = parseFormat(nf);
  if (p.general) return "general";
  const sec = p.numbers[0];
  if (!sec) return p.text ? "text" : "general";
  if (sec.kind === "date") {
    const dates = sec.toks.filter((t): t is Extract<Tok, { k: "date" }> => t.k === "date");
    const day = dates.some((t) => t.c === "y" || t.c === "mo" || t.c === "d");
    return day && sec.time ? "datetime" : day ? "date" : "time";
  }
  if (sec.kind !== "number" || !sec.plan) return "general";
  if (sec.plan.sci) return "scientific";
  if (sec.plan.fraction) return "fraction";
  if (sec.toks.some((t) => t.k === "pct")) return "percent";
  const literal = sec.toks.map((t) => (t.k === "lit" ? t.v : "")).join("");
  if (CURRENCY_SIGNS.test(literal)) return "currency";
  return "number";
}

/** Whether a code shows dates or times (so a number in the cell is a serial). */
export function isDateFormat(nf: string | undefined): boolean {
  const kind = formatKind(nf);
  return kind === "date" || kind === "time" || kind === "datetime";
}

/** Shown decimals of a number in General ("1234.5" → 1). */
function generalDecimals(x: number): number {
  const s = formatGeneral(x, { decimal: "." });
  if (s.includes("E")) return 0;
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

function changeSection(src: string, delta: number): string {
  const sec = parseSection(src);
  const plan = sec.plan;
  if (sec.kind !== "number" || !plan || plan.fraction) return src;
  const toks = tokenize(src).toks;
  const end = toks.findIndex((t) => t.k === "exp");
  const scope = end >= 0 ? toks.slice(0, end) : toks;
  const point = scope.find((t): t is Extract<Tok, { k: "point" }> => t.k === "point");
  const phs = scope.filter((t): t is Extract<Tok, { k: "ph" }> => t.k === "ph");
  if (delta > 0) {
    if (point) {
      const after = phs.filter((t) => t.at > point.at).pop();
      const at = (after ?? point).at + 1;
      return `${src.slice(0, at)}0${src.slice(at)}`;
    }
    const last = phs.pop();
    if (!last) return src;
    return `${src.slice(0, last.at + 1)}.0${src.slice(last.at + 1)}`;
  }
  if (!point) return src;
  const decimals = phs.filter((t) => t.at > point.at);
  const last = decimals.pop();
  if (!last) return `${src.slice(0, point.at)}${src.slice(point.at + 1)}`;
  const without = `${src.slice(0, last.at)}${src.slice(last.at + 1)}`;
  return decimals.length === 0 ? `${without.slice(0, point.at)}${without.slice(point.at + 1)}` : without;
}

/**
 * The toolbar's "more decimals" / "fewer decimals": the code with one decimal place more or less in each number
 * section (`#,##0` → `#,##0.0`, `0.00%` → `0.0%`). General starts from the decimals the value shows.
 */
export function changeDecimals(nf: string | undefined, delta: 1 | -1, value?: CellValue): string | undefined {
  const p = parseFormat(nf);
  if (p.general) {
    const shown = typeof value === "number" ? generalDecimals(value) : 0;
    const decimals = Math.max(0, shown + delta);
    if (delta < 0 && shown === 0) return nf;
    return decimals > 0 ? `0.${"0".repeat(decimals)}` : "0";
  }
  const sections = splitSections(nf ?? "");
  return sections.map((src) => changeSection(src, delta)).join(";");
}
