import { LOCAL } from "@agenteschat/live";
import {
  colName,
  type FormulaProblem,
  formatA1Range,
  SheetError,
  type SheetLocale,
  setInput,
} from "@agenteschat/live/spreadsheet";
import type * as Y from "yjs";
import type { GridBox } from "./grid-view";

/**
 * Typing into a spreadsheet on the phone (ADR 0196): what the person typed goes in as they would type it in their
 * language (`setInput`: "=SOMA(B2:B9;C1)", "12,5", "17/11/2026" in Portuguese), as one change of theirs that their
 * undo takes back. A formula that can't be read is not written: the bar says why, in words.
 */

/** Why a cell wasn't written: an i18n key under `mobile.live.sheet.problem` and its words. */
export interface CellProblem {
  key: string;
  params?: Record<string, string | number>;
}

const PROBLEM_KEYS: Record<FormulaProblem["code"], string> = {
  empty: "empty",
  unexpected: "unexpected",
  unclosed_paren: "paren",
  unclosed_string: "quote",
  unclosed_sheet: "sheetQuote",
  missing_operand: "operand",
  bad_array: "array",
  bad_range: "range",
  bad_sheet: "sheet",
  args: "args",
  too_long: "tooLong",
  too_deep: "tooDeep",
  too_far: "tooFar",
};

/** A formula's problem in words the bar shows ("Falta fechar um parêntese"). */
export function formulaProblem(problem: FormulaProblem): CellProblem {
  const key = PROBLEM_KEYS[problem.code] ?? "unexpected";
  if (problem.code === "args")
    return { key, params: { fn: problem.fn ?? "", min: problem.min ?? 0, max: problem.max ?? problem.min ?? 0 } };
  if (problem.code === "unexpected" || problem.code === "bad_sheet")
    return { key, params: { text: problem.text ?? "" } };
  return { key };
}

/** An edit the sheet refused (too much text, past the limits…), in words. */
export function sheetProblem(error: unknown): CellProblem {
  if (error instanceof SheetError) {
    if (error.reason === "text_too_long" || error.reason === "formula_too_long") return { key: "tooLong" };
    if (error.reason === "limit") return { key: "limit" };
    if (error.reason === "merged") return { key: "merged" };
  }
  return { key: "failed" };
}

/** Writes what the person typed into a cell; the problem when it couldn't. */
export function commitCell(
  doc: Y.Doc,
  at: { sheet: string; row: number; col: number },
  text: string,
  locale: SheetLocale,
  now?: Date,
): { ok: true } | { ok: false; problem: CellProblem } {
  try {
    const result = setInput(doc, at, text, locale, LOCAL, now ? { now } : {});
    return result.ok ? result : { ok: false, problem: formulaProblem(result.error) };
  } catch (error) {
    return { ok: false, problem: sheetProblem(error) };
  }
}

/** "B4", "B2:E9", "B:B", "3:3": a block as the bar and the person's selection say it. */
export function boxLabel(box: GridBox, size: { rows: number; cols: number }): string {
  return formatA1Range(box.r1, box.c1, box.r2, box.c2, size);
}

/** A cell's address ("B4"). */
export const cellLabel = (row: number, col: number) => `${colName(col)}${row + 1}`;

/** Where a formula being typed takes a cell reference now: after "=", "(", an operator or the argument separator. */
export function takesReference(text: string, caret: number, locale: Pick<SheetLocale, "argSep">): boolean {
  if (!text.startsWith("=")) return false;
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length))).trimEnd();
  const last = before.charAt(before.length - 1);
  return last === "=" || last === "(" || last === locale.argSep || "+-*/^&<>:".includes(last);
}

/**
 * A reference tapped while typing a formula, put where the caret is: the text and where the caret goes after it. A
 * reference just put there (the caret right after it) is swapped for the new one, so tapping around picks a cell.
 */
export function insertReference(
  text: string,
  caret: number,
  ref: string,
  lastInserted: { start: number; end: number } | null,
): { text: string; caret: number; inserted: { start: number; end: number } } {
  const at = Math.max(0, Math.min(caret, text.length));
  const start = lastInserted && lastInserted.end === at ? lastInserted.start : at;
  const next = text.slice(0, start) + ref + text.slice(at);
  const end = start + ref.length;
  return { text: next, caret: end, inserted: { start, end } };
}

/** The keys over the keyboard while a formula is typed, in the person's language (`;` between arguments in pt-BR). */
export function formulaKeys(locale: Pick<SheetLocale, "argSep">): string[] {
  return ["=", "(", ")", locale.argSep, ":", "$", "+", "-", "*", "/"];
}
