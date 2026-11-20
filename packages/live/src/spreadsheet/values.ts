/**
 * What a spreadsheet cell holds or computes (ADR 0196): numbers, text, booleans, Excel's errors and empty. Values are
 * never stored for formulas: every app computes them, and shows errors and booleans in the reader's language.
 */
import type { SheetLocale } from "./locale";

export type ErrorCode =
  | "#NULL!"
  | "#DIV/0!"
  | "#VALUE!"
  | "#REF!"
  | "#NAME?"
  | "#NUM!"
  | "#N/A"
  | "#CALC!"
  | "#SPILL!"
  | "#CYCLE!";

export const ERROR_CODES: readonly ErrorCode[] = [
  "#NULL!",
  "#DIV/0!",
  "#VALUE!",
  "#REF!",
  "#NAME?",
  "#NUM!",
  "#N/A",
  "#CALC!",
  "#SPILL!",
  "#CYCLE!",
];

export interface CellError {
  error: ErrorCode;
}

/** A computed value: `null` is an empty cell. */
export type CellValue = number | string | boolean | CellError | null;

export function isError(v: unknown): v is CellError {
  return (
    typeof v === "object" && v !== null && typeof (v as { error?: unknown }).error === "string" && !Array.isArray(v)
  );
}

const CODES = new Set<string>(ERROR_CODES);

export function isErrorCode(text: string): text is ErrorCode {
  return CODES.has(text);
}

/**
 * Excel's Brazilian names for its errors. A circular reference shows as `#REF!` (with the explanation in the cell's
 * tip, `errorKey`), as Excel does.
 */
const PT_ERRORS: Record<ErrorCode, string> = {
  "#NULL!": "#NULO!",
  "#DIV/0!": "#DIV/0!",
  "#VALUE!": "#VALOR!",
  "#REF!": "#REF!",
  "#NAME?": "#NOME?",
  "#NUM!": "#NÚM!",
  "#N/A": "#N/D",
  "#CALC!": "#CALC!",
  "#SPILL!": "#DESPEJAR!",
  "#CYCLE!": "#REF!",
};

/** An error as the reader sees it in a cell: `#N/D` in Portuguese, `#N/A` in English. */
export function errorText(code: ErrorCode, locale: Pick<SheetLocale, "fnNames">): string {
  if (locale.fnNames === "pt") return PT_ERRORS[code];
  return code === "#CYCLE!" ? "#REF!" : code;
}

const FROM_TEXT = new Map<string, ErrorCode>();
for (const code of ERROR_CODES) {
  if (code === "#CYCLE!") continue;
  FROM_TEXT.set(code, code);
  FROM_TEXT.set(PT_ERRORS[code], code);
}

/** Reads an error typed or pasted in either language ("#N/D" or "#N/A"), case-insensitively. */
export function errorFromText(text: string): ErrorCode | null {
  return FROM_TEXT.get(text.trim().toUpperCase()) ?? null;
}

const ERROR_KEYS: Record<ErrorCode, string> = {
  "#NULL!": "null",
  "#DIV/0!": "div0",
  "#VALUE!": "value",
  "#REF!": "ref",
  "#NAME?": "name",
  "#NUM!": "num",
  "#N/A": "na",
  "#CALC!": "calc",
  "#SPILL!": "spill",
  "#CYCLE!": "circular",
};

/**
 * The i18n key (under `live.sheet.errors`) that explains an error in a cell's tip; a circular reference has its own
 * ("Referência circular") although the cell shows `#REF!`.
 */
export function errorKey(code: ErrorCode, circular?: boolean): string {
  return `live.sheet.errors.${circular ? "circular" : ERROR_KEYS[code]}`;
}

/** TRUE and FALSE in the reader's language (VERDADEIRO and FALSO in Portuguese). */
export function booleanText(value: boolean, locale: Pick<SheetLocale, "fnNames">): string {
  if (locale.fnNames === "pt") return value ? "VERDADEIRO" : "FALSO";
  return value ? "TRUE" : "FALSE";
}

/** Reads TRUE/FALSE in either language, case-insensitively. */
export function booleanFromText(text: string): boolean | null {
  const t = text.trim().toUpperCase();
  if (t === "TRUE" || t === "VERDADEIRO") return true;
  if (t === "FALSE" || t === "FALSO") return false;
  return null;
}
