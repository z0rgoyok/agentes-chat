/**
 * What the formula bar and the cell's editor work out while a person types (ADR 0196 §2): which functions to offer
 * for the name being typed, the signature line with the current argument, where a reference can be pointed at with
 * the mouse or the arrows, and the colors references take (the same on the text and on the grid).
 */
import { PEER_COLORS } from "@agenteschat/live";
import type { FunctionHelp, SheetLocale } from "@agenteschat/live/spreadsheet";

export interface FnOption {
  /** As the reader types it ("SOMA"). */
  name: string;
  /** The engine's own name ("SUM"). */
  canonical: string;
}

/** A function's description key (`live.sheet.fn.STDEV_S`): the dots of its name would read as nesting. */
export const fnKey = (canonical: string) => `live.sheet.fn.${canonical.replace(/\./g, "_")}`;

/** Upper case without accents, so "media" finds MÉDIA. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

/**
 * The functions a name being typed may be: those whose name in the reader's language (or in English, which every
 * language accepts) starts with it, the reader's own first, shorter names first.
 */
export function matchFunctions(word: string, options: readonly FnOption[], limit = 8): FnOption[] {
  const w = fold(word);
  if (!w) return [];
  const own: FnOption[] = [];
  const english: FnOption[] = [];
  for (const option of options) {
    if (fold(option.name).startsWith(w)) own.push(option);
    else if (option.canonical.startsWith(w)) english.push(option);
  }
  const order = (a: FnOption, b: FnOption) => a.name.length - b.name.length || (a.name < b.name ? -1 : 1);
  return [...own.sort(order), ...english.sort(order)].slice(0, limit);
}

/** One piece of the signature line: the function's name and punctuation, or an argument (the current one stands out). */
export interface SignaturePart {
  text: string;
  arg?: boolean;
  current?: boolean;
}

/**
 * "SOMA(núm1; [núm2]; …)" as parts: optional arguments in brackets, a repeating tail ending in "…", and the argument
 * the cursor is on marked (an argument past the listed ones maps onto the repeating tail).
 */
export function signatureParts(
  help: FunctionHelp,
  arg: number,
  locale: Pick<SheetLocale, "argSep">,
  label: (key: string) => string,
): SignaturePart[] {
  const sep = `${locale.argSep} `;
  const n = help.args.length;
  let current = arg;
  if (arg >= n && help.repeat > 0) current = n - help.repeat + ((arg - (n - help.repeat)) % help.repeat);
  const parts: SignaturePart[] = [{ text: `${help.name}(` }];
  help.args.forEach((key, i) => {
    if (i > 0) parts.push({ text: sep });
    const words = label(key);
    parts.push({ text: i >= help.min ? `[${words}]` : words, arg: true, current: i === current });
  });
  if (help.repeat > 0) parts.push({ text: `${n > 0 ? sep : ""}…` });
  parts.push({ text: ")" });
  return parts;
}

/** Characters after which a formula expects a value, so a click or an arrow puts a reference there. */
const OPENERS = new Set(["=", "(", "+", "-", "*", "/", "^", "&", "<", ">", ":"]);

/**
 * Whether a reference can go at the cursor: the text is a formula and the cursor follows "=", "(", an operator or the
 * argument separator (a "," in Portuguese is the decimal mark, so only ";" separates there).
 */
export function canPoint(text: string, caret: number, locale: Pick<SheetLocale, "argSep">): boolean {
  if (!text.startsWith("=")) return false;
  let i = caret - 1;
  while (i > 0 && text[i] === " ") i--;
  if (i < 0) return false;
  const ch = text[i] as string;
  return OPENERS.has(ch) || ch === locale.argSep;
}

/** Puts a reference at the cursor, or over the one being pointed (`span`), and returns the text and where it went. */
export function placeRef(
  text: string,
  caret: number,
  ref: string,
  span?: { start: number; end: number } | null,
): { text: string; caret: number; span: { start: number; end: number } } {
  const start = span ? span.start : caret;
  const end = span ? span.end : caret;
  const next = text.slice(0, start) + ref + text.slice(end);
  return { text: next, caret: start + ref.length, span: { start, end: start + ref.length } };
}

/** Puts a function's name with its opening parenthesis over the name being typed. */
export function placeFunction(
  text: string,
  word: { start: number; end: number },
  name: string,
): { text: string; caret: number } {
  const after = text.slice(word.end);
  const opened = after.startsWith("(");
  const inserted = opened ? name : `${name}(`;
  const next = text.slice(0, word.start) + inserted + after;
  return { text: next, caret: word.start + inserted.length + (opened ? 1 : 0) };
}

/** A reference's color by its index in the formula: the same on the text and on its outline. */
export function refColor(index: number, dark: boolean): string {
  const pick = PEER_COLORS[index % PEER_COLORS.length];
  return pick ? (dark ? pick.dark : pick.light) : "currentColor";
}
