/**
 * Text (ADR 0196 §2). Numbers become text the way Excel writes them (15 significant digits, the document's decimal
 * separator); FIND and EXACT match case, SEARCH ignores it and takes wildcards; TEXT reads Excel's format codes (in a
 * Portuguese document as Brazilian Excel writes them: "0,00", "dd/mm/aaaa"); CHAR and CODE use Windows-1252, as Excel
 * on Windows does, so files agree.
 */
import { currencyFormat, formatValue } from "../../format";
import type { SheetLocale } from "../../locale";
import type { CellError, CellValue } from "../../values";
import { type Env, ERR, isArr, isErr, isRef, MAX_TEXT, textToNumber, toText, type Val } from "../runtime";
import { cleanTrunc, type FnSpec, numArg, oneOf, optBool, roundTo, textArg, VARIADIC, valuesOf } from "./spec";

/** Windows-1252's characters for 128–159 (the rest of 1–255 is Latin-1). */
const CP1252 = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];
const FROM_CP1252 = new Map<number, number>(CP1252.map((u, i) => [u, 128 + i]));

function capped(s: string): CellValue {
  return s.length > MAX_TEXT ? ERR["#VALUE!"] : s;
}

/** A text function of lifted arguments: each reads as text, number or boolean as asked. */
function textFn(
  args: readonly string[],
  min: number,
  f: (vals: readonly (Val | undefined)[], env: Env) => CellValue,
): FnSpec {
  return { min, max: args.length, lift: "all", args, fn: (vals, env) => f(vals, env) };
}

function str(v: Val | undefined, env: Env): string | CellError {
  return textArg(v, env);
}

function int(v: Val | undefined, env: Env, fallback?: number): number | CellError {
  if (v === undefined && fallback !== undefined) return fallback;
  const n = numArg(v, env);
  return isErr(n) ? n : cleanTrunc(n);
}

/** Excel's wildcards inside a text (not anchored), case-insensitive. */
function wildcardSearch(pattern: string): RegExp {
  let src = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c === "~" && i + 1 < pattern.length && "*?~".includes(pattern.charAt(i + 1))) {
      src += pattern.charAt(i + 1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i++;
    } else if (c === "*") src += "[\\s\\S]*?";
    else if (c === "?") src += "[\\s\\S]";
    else src += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(src, "gi");
}

/**
 * A format code as the document's language writes it, in Excel's own form: where the decimal is a comma, "0,00" means
 * two decimals and "#.##0" groups thousands; in Portuguese "aaaa" is the year.
 */
export function localFormatCode(code: string, calc: SheetLocale): string {
  if (calc.decimal !== "," && calc.fnNames !== "pt") return code;
  let out = "";
  let i = 0;
  while (i < code.length) {
    const c = code.charAt(i);
    if (c === '"') {
      const end = code.indexOf('"', i + 1);
      const stop = end < 0 ? code.length : end + 1;
      out += code.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "\\" || c === "_" || c === "*") {
      out += code.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "[") {
      const end = code.indexOf("]", i);
      const stop = end < 0 ? code.length : end + 1;
      out += code.slice(i, stop);
      i = stop;
      continue;
    }
    const rest = code.slice(i, i + 5).toUpperCase();
    if (rest.startsWith("AM/PM")) {
      out += code.slice(i, i + 5);
      i += 5;
      continue;
    }
    if (rest.startsWith("A/P")) {
      out += code.slice(i, i + 3);
      i += 3;
      continue;
    }
    if (calc.decimal === "," && c === ",") out += ".";
    else if (calc.decimal === "," && c === ".") out += ",";
    else if (calc.fnNames === "pt" && (c === "a" || c === "A")) out += "y";
    else out += c;
    i++;
  }
  return out;
}

/** Occurrences of any of the delimiters, left to right without overlapping. */
function occurrences(text: string, delims: readonly string[], ignoreCase: boolean): { start: number; end: number }[] {
  const hay = ignoreCase ? text.toLowerCase() : text;
  const needles = delims.map((d) => (ignoreCase ? d.toLowerCase() : d));
  const out: { start: number; end: number }[] = [];
  let i = 0;
  while (i <= hay.length) {
    let best = -1;
    let len = 0;
    for (const n of needles) {
      if (n.length === 0) continue;
      const at = hay.indexOf(n, i);
      if (at >= 0 && (best < 0 || at < best || (at === best && n.length > len))) {
        best = at;
        len = n.length;
      }
    }
    if (best < 0) break;
    out.push({ start: best, end: best + len });
    i = best + len;
  }
  return out;
}

function textSplit(before: boolean): FnSpec {
  return {
    min: 2,
    max: 6,
    omit: true,
    args: ["text", "delimiter", "instance_num", "match_mode", "match_end", "if_not_found"],
    fn: ([textValue, delimArg, instArg, modeArg, endArg, notFound], env) => {
      const text = textArg(oneOf(textValue, env), env);
      if (isErr(text)) return text;
      const delims: string[] = [];
      for (const d of delimArg === undefined ? [""] : valuesOf(delimArg, env)) {
        const t = isErr(d) ? d : textArg(d, env);
        if (isErr(t)) return t;
        delims.push(t);
      }
      const inst = int(instArg, env, 1);
      if (isErr(inst)) return inst;
      const mode = int(modeArg, env, 0);
      if (isErr(mode)) return mode;
      const matchEnd = optBool(endArg, env, false);
      if (isErr(matchEnd)) return matchEnd;
      if (inst === 0 || Math.abs(inst) > text.length + 1) return ERR["#VALUE!"];
      const fail = (): Val => (notFound === undefined ? ERR["#N/A"] : oneOf(notFound, env));
      if (delims.every((d) => d === "")) {
        const at = inst > 0 ? inst - 1 : text.length + inst + 1;
        if (at < 0 || at > text.length) return fail();
        return before ? text.slice(0, at) : text.slice(at);
      }
      let found = occurrences(text, delims, mode === 1);
      if (matchEnd) {
        found = inst > 0 ? [...found, { start: text.length, end: text.length }] : [{ start: 0, end: 0 }, ...found];
      }
      const occ = inst > 0 ? found[inst - 1] : found[found.length + inst];
      if (!occ) return fail();
      return before ? text.slice(0, occ.start) : text.slice(occ.end);
    },
  };
}

/** Every value of the arguments as text, ranges row by row, for CONCAT and TEXTJOIN. */
function texts(args: readonly (Val | undefined)[], env: Env, skipEmpty: boolean): string[] | CellError {
  const out: string[] = [];
  for (const a of args) {
    if (a === undefined) continue;
    const list = isRef(a) || isArr(a) ? valuesOf(a, env) : [a as CellValue];
    for (const v of list) {
      if (isErr(v)) return v;
      if (skipEmpty && (v === null || v === "")) continue;
      const t = toText(v, env.calc);
      if (isErr(t)) return t;
      out.push(t);
    }
  }
  return out;
}

export const TEXT: Record<string, FnSpec> = {
  CONCAT: {
    min: 1,
    max: VARIADIC,
    args: ["text1", "text2"],
    repeat: 1,
    fn: (args, env) => {
      const list = texts(args, env, false);
      return isErr(list) ? list : capped(list.join(""));
    },
  },
  CONCATENATE: {
    min: 1,
    max: VARIADIC,
    lift: "all",
    args: ["text1", "text2"],
    repeat: 1,
    fn: (args, env) => {
      let s = "";
      for (const a of args) {
        const t = str(a, env);
        if (isErr(t)) return t;
        s += t;
      }
      return capped(s);
    },
  },
  TEXTJOIN: {
    min: 3,
    max: VARIADIC,
    args: ["delimiter", "ignore_empty", "text1", "text2"],
    repeat: 1,
    fn: ([delimArg, ignoreArg, ...rest], env) => {
      const delims: string[] = [];
      for (const d of delimArg === undefined ? [] : valuesOf(delimArg, env)) {
        const t = toText(d, env.calc);
        if (isErr(t)) return t;
        delims.push(t);
      }
      const ignore = optBool(ignoreArg, env, true);
      if (isErr(ignore)) return ignore;
      const list = texts(rest, env, ignore);
      if (isErr(list)) return list;
      let s = "";
      list.forEach((t, i) => {
        if (i > 0) s += delims.length === 0 ? "" : (delims[(i - 1) % delims.length] as string);
        s += t;
      });
      return capped(s);
    },
  },
  LEFT: textFn(["text", "num_chars"], 1, ([t, n], env) => {
    const s = str(t, env);
    if (isErr(s)) return s;
    const k = int(n, env, 1);
    if (isErr(k)) return k;
    return k < 0 ? ERR["#VALUE!"] : s.slice(0, k);
  }),
  RIGHT: textFn(["text", "num_chars"], 1, ([t, n], env) => {
    const s = str(t, env);
    if (isErr(s)) return s;
    const k = int(n, env, 1);
    if (isErr(k)) return k;
    if (k < 0) return ERR["#VALUE!"];
    return k === 0 ? "" : s.slice(Math.max(0, s.length - k));
  }),
  MID: textFn(["text", "start_num", "num_chars"], 3, ([t, a, n], env) => {
    const s = str(t, env);
    if (isErr(s)) return s;
    const start = int(a, env);
    if (isErr(start)) return start;
    const k = int(n, env);
    if (isErr(k)) return k;
    if (start < 1 || k < 0) return ERR["#VALUE!"];
    return s.slice(start - 1, start - 1 + k);
  }),
  LEN: textFn(["text"], 1, ([t], env) => {
    const s = str(t, env);
    return isErr(s) ? s : s.length;
  }),
  UPPER: textFn(["text"], 1, ([t], env) => {
    const s = str(t, env);
    return isErr(s) ? s : s.toUpperCase();
  }),
  LOWER: textFn(["text"], 1, ([t], env) => {
    const s = str(t, env);
    return isErr(s) ? s : s.toLowerCase();
  }),
  PROPER: textFn(["text"], 1, ([t], env) => {
    const s = str(t, env);
    if (isErr(s)) return s;
    let out = "";
    let after = false;
    for (const ch of s) {
      const letter = ch.toLowerCase() !== ch.toUpperCase();
      out += letter ? (after ? ch.toLowerCase() : ch.toUpperCase()) : ch;
      after = letter;
    }
    return out;
  }),
  TRIM: textFn(["text"], 1, ([t], env) => {
    const s = str(t, env);
    return isErr(s) ? s : s.replace(/^ +| +$/g, "").replace(/ {2,}/g, " ");
  }),
  CLEAN: textFn(["text"], 1, ([t], env) => {
    const s = str(t, env);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: CLEAN removes exactly these characters.
    return isErr(s) ? s : s.replace(/[\u0000-\u001f]/g, "");
  }),
  SUBSTITUTE: textFn(["text", "old_text", "new_text", "instance_num"], 3, ([t, o, n, k], env) => {
    const s = str(t, env);
    if (isErr(s)) return s;
    const from = str(o, env);
    if (isErr(from)) return from;
    const to = str(n, env);
    if (isErr(to)) return to;
    if (from === "") return s;
    if (k === undefined) return capped(s.split(from).join(to));
    const which = int(k, env);
    if (isErr(which)) return which;
    if (which < 1) return ERR["#VALUE!"];
    let at = -1;
    for (let i = 0; i < which; i++) {
      at = s.indexOf(from, at + 1);
      if (at < 0) return s;
      if (i < which - 1) at += from.length - 1;
    }
    return capped(s.slice(0, at) + to + s.slice(at + from.length));
  }),
  REPLACE: textFn(["old_text", "start_num", "num_chars", "new_text"], 4, ([t, a, n, r], env) => {
    const s = str(t, env);
    if (isErr(s)) return s;
    const start = int(a, env);
    if (isErr(start)) return start;
    const k = int(n, env);
    if (isErr(k)) return k;
    const with_ = str(r, env);
    if (isErr(with_)) return with_;
    if (start < 1 || k < 0) return ERR["#VALUE!"];
    return capped(s.slice(0, start - 1) + with_ + s.slice(start - 1 + k));
  }),
  FIND: textFn(["find_text", "within_text", "start_num"], 2, ([f, w, a], env) => {
    const find = str(f, env);
    if (isErr(find)) return find;
    const within = str(w, env);
    if (isErr(within)) return within;
    const start = int(a, env, 1);
    if (isErr(start)) return start;
    if (start < 1 || start > within.length + 1) return ERR["#VALUE!"];
    const at = within.indexOf(find, start - 1);
    return at < 0 ? ERR["#VALUE!"] : at + 1;
  }),
  SEARCH: textFn(["find_text", "within_text", "start_num"], 2, ([f, w, a], env) => {
    const find = str(f, env);
    if (isErr(find)) return find;
    const within = str(w, env);
    if (isErr(within)) return within;
    const start = int(a, env, 1);
    if (isErr(start)) return start;
    if (start < 1 || start > within.length + 1) return ERR["#VALUE!"];
    if (!/[*?~]/.test(find)) {
      const at = within.toLowerCase().indexOf(find.toLowerCase(), start - 1);
      return at < 0 ? ERR["#VALUE!"] : at + 1;
    }
    const re = wildcardSearch(find);
    re.lastIndex = start - 1;
    const m = re.exec(within);
    return m ? m.index + 1 : ERR["#VALUE!"];
  }),
  TEXT: textFn(["value", "format_text"], 2, ([v, f], env) => {
    const fmt = str(f, env);
    if (isErr(fmt)) return fmt;
    if (fmt === "") return "";
    let x = (v ?? null) as CellValue;
    if (typeof x === "string") {
      const n = textToNumber(x, env.calc);
      if (n !== null) x = n;
    }
    return formatValue(x, localFormatCode(fmt, env.calc), env.calc).text;
  }),
  VALUE: textFn(["text"], 1, ([t], env) => {
    const v = (t ?? null) as CellValue;
    if (v === null) return 0;
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return ERR["#VALUE!"];
    const n = textToNumber(v as string, env.calc);
    return n === null ? ERR["#VALUE!"] : n;
  }),
  NUMBERVALUE: {
    min: 1,
    max: 3,
    lift: "all",
    args: ["text", "decimal_separator", "group_separator"],
    fn: ([t, d, g], env) => {
      const s = str(t, env);
      if (isErr(s)) return s;
      const decimal = d === undefined ? env.calc.decimal : str(d, env);
      if (isErr(decimal)) return decimal;
      const group = g === undefined ? env.calc.group : str(g, env);
      if (isErr(group)) return group;
      const dec = decimal.charAt(0);
      const grp = group.charAt(0);
      if (dec === "" || dec === grp) return ERR["#VALUE!"];
      let body = s.replace(/\s+/g, "");
      if (body === "") return 0;
      let percents = 0;
      while (body.endsWith("%")) {
        percents++;
        body = body.slice(0, -1);
      }
      if (grp !== "") body = body.split(grp).join("");
      const parts = body.split(dec);
      if (parts.length > 2) return ERR["#VALUE!"];
      const text = parts.join(".");
      if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return ERR["#VALUE!"];
      return Number(text) / 100 ** percents;
    },
  },
  REPT: textFn(["text", "number_times"], 2, ([t, n], env) => {
    const s = str(t, env);
    if (isErr(s)) return s;
    const k = int(n, env);
    if (isErr(k)) return k;
    if (k < 0 || s.length * k > MAX_TEXT) return ERR["#VALUE!"];
    return s.repeat(k);
  }),
  EXACT: textFn(["text1", "text2"], 2, ([a, b], env) => {
    const x = str(a, env);
    if (isErr(x)) return x;
    const y = str(b, env);
    if (isErr(y)) return y;
    return x === y;
  }),
  CHAR: textFn(["number"], 1, ([n], env) => {
    const k = int(n, env);
    if (isErr(k)) return k;
    if (k < 1 || k > 255) return ERR["#VALUE!"];
    return String.fromCharCode(k >= 128 && k < 160 ? (CP1252[k - 128] as number) : k);
  }),
  CODE: textFn(["text"], 1, ([t], env) => {
    const s = str(t, env);
    if (isErr(s)) return s;
    if (s === "") return ERR["#VALUE!"];
    const u = s.charCodeAt(0);
    if (u < 128 || (u >= 160 && u < 256)) return u;
    return FROM_CP1252.get(u) ?? 63;
  }),
  UNICHAR: textFn(["number"], 1, ([n], env) => {
    const k = int(n, env);
    if (isErr(k)) return k;
    if (k < 1 || k > 0x10ffff || (k >= 0xd800 && k <= 0xdfff)) return ERR["#VALUE!"];
    return String.fromCodePoint(k);
  }),
  UNICODE: textFn(["text"], 1, ([t], env) => {
    const s = str(t, env);
    if (isErr(s)) return s;
    if (s === "") return ERR["#VALUE!"];
    return s.codePointAt(0) as number;
  }),
  T: {
    min: 1,
    max: 1,
    args: ["value"],
    fn: ([v], env) => {
      const x = oneOf(v, env);
      if (isErr(x)) return x;
      return typeof x === "string" ? x : "";
    },
  },
  N: {
    min: 1,
    max: 1,
    args: ["value"],
    fn: ([v], env) => {
      const x = oneOf(v, env);
      if (isErr(x)) return x;
      if (typeof x === "number") return x;
      if (typeof x === "boolean") return x ? 1 : 0;
      return 0;
    },
  },
  TEXTBEFORE: textSplit(true),
  TEXTAFTER: textSplit(false),
  FIXED: textFn(["number", "decimals", "no_commas"], 1, ([n, d, c], env) => {
    const x = numArg(n, env);
    if (isErr(x)) return x;
    const digits = int(d, env, 2);
    if (isErr(digits)) return digits;
    const plain = optBool(c, env, false);
    if (isErr(plain)) return plain;
    if (digits > 127) return ERR["#VALUE!"];
    const shown = Math.max(0, digits);
    const code = `${plain ? "0" : "#,##0"}${shown > 0 ? `.${"0".repeat(shown)}` : ""}`;
    return formatValue(roundTo(x, digits), code, env.calc).text;
  }),
  DOLLAR: textFn(["number", "decimals"], 1, ([n, d], env) => {
    const x = numArg(n, env);
    if (isErr(x)) return x;
    const digits = int(d, env, 2);
    if (isErr(digits)) return digits;
    if (digits > 127) return ERR["#VALUE!"];
    const code = currencyFormat(env.calc.currency, env.calc, Math.max(0, Math.min(digits, 30)));
    return formatValue(roundTo(x, digits), code, env.calc).text;
  }),
};
