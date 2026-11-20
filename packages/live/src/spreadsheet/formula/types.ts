/**
 * The formula language's shapes (ADR 0196 §2). A formula is stored canonically, by row and column ids, and parsed
 * into this tree; A1 is only how people type and read it.
 */
import type { ErrorCode } from "../values";

/**
 * One end of a reference, by ids: a cell (`row` and `col`), a whole column (`row` null) or a whole row (`col` null).
 * `sheet` is set only when the formula names a sheet. `absRow`/`absCol` are Excel's `$`, which copying keeps.
 */
export interface CellRefId {
  sheet?: string;
  row: string | null;
  col: string | null;
  absRow?: boolean;
  absCol?: boolean;
}

export type BinOp = "+" | "-" | "*" | "/" | "^" | "&" | "=" | "<>" | "<" | ">" | "<=" | ">=" | ":";

/**
 * A parsed formula. Besides the planned nodes there are two that keep what was typed: `paren` (the person's own
 * parentheses, so `=(A1+B1)*2` reads back the same) and `missing` (an empty argument, as in `=IF(A1,,"x")` or
 * `=OFFSET(A1,,1)`, which Excel files hold).
 */
export type Ast =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "err"; v: ErrorCode }
  | { t: "ref"; ref: CellRefId }
  | { t: "range"; from: CellRefId; to: CellRefId }
  | { t: "un"; op: "-" | "+" | "%"; a: Ast }
  | { t: "bin"; op: BinOp; a: Ast; b: Ast }
  | { t: "call"; fn: string; args: Ast[] }
  | { t: "arr"; rows: Ast[][] }
  | { t: "name"; name: string }
  | { t: "paren"; a: Ast }
  | { t: "missing" };

/**
 * Why a typed formula can't be read, as an i18n key under `live.sheet.problem.*` and the place in the text (0-based
 * offset into what was typed, "=" included): `empty` (just "="), `unexpected` (a character or word that doesn't
 * belong, in `text`), `unclosed_paren`, `unclosed_string`, `unclosed_sheet` (a quoted sheet name without its closing
 * quote or "!"), `missing_operand` (an operator with nothing after it), `bad_array` (a `{…}` constant), `bad_range`
 * (a range across two sheets), `bad_sheet` (no sheet has the name in `text`), `args` (`fn` takes `min` to `max`
 * arguments), `too_long`, `too_deep` (nested past 100 levels) and `too_far` (a reference past the last row or column
 * a sheet can have).
 */
export type FormulaProblemCode =
  | "empty"
  | "unexpected"
  | "unclosed_paren"
  | "unclosed_string"
  | "unclosed_sheet"
  | "missing_operand"
  | "bad_array"
  | "bad_range"
  | "bad_sheet"
  | "args"
  | "too_long"
  | "too_deep"
  | "too_far";

export interface FormulaProblem {
  code: FormulaProblemCode;
  at: number;
  /** The text at fault (an unexpected character, a sheet name). */
  text?: string;
  /** For `args`: the function as typed and how many arguments it takes. */
  fn?: string;
  min?: number;
  max?: number;
}

export class FormulaError extends Error {
  override name = "FormulaError";
  readonly problem: FormulaProblem;
  constructor(problem: FormulaProblem) {
    super(`Formula problem "${problem.code}" at ${problem.at}${problem.text ? `: ${problem.text}` : ""}`);
    this.problem = problem;
  }
}

/** How deep a formula may nest (Excel allows 64 levels of functions). */
export const MAX_FORMULA_DEPTH = 100;
