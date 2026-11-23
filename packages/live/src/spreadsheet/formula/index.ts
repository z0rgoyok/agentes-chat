/**
 * The spreadsheet formula language (ADR 0196 §2). A formula is stored canonically, with English names, `,` between
 * arguments, `.` for decimals and references by row and column ids (`SUM({r8k2,c3xa}:{r9b1,c3xa})`), so inserting or
 * moving rows never rewrites it and a deleted row turns its references into `#REF!`. People type and read it in A1
 * and their language (`=SOMA(B2:B9;C1)` in Portuguese, `=SUM(B2:B9,C1)` in English), worked out from the sheet's
 * current order.
 */
import type * as Y from "yjs";
import { LIVE_LIMITS } from "../../limits";
import type { SheetLocale } from "../locale";
import { FUNCTIONS } from "./functions";
import { colAxis, rowAxis, sheetIdByName } from "./grid";
import { ptNameOf } from "./names-pt";
import { type A1Resolver, canonicalFunctionName, parseCanonical, parseFormula } from "./parse";
import { printCanonical, printDisplay } from "./print";
import { type A1Part, type Token, tokenize } from "./tokenize";
import { type Ast, type CellRefId, FormulaError, type FormulaProblem } from "./types";

export { canonicalFunctionName, parseCanonical } from "./parse";
export { printCanonical, printDisplay } from "./print";
export type { Ast, BinOp, CellRefId, FormulaProblem, FormulaProblemCode } from "./types";
export { FormulaError, MAX_FORMULA_DEPTH } from "./types";

export interface FormulaContext {
  doc: Y.Doc;
  sheetId: string;
  locale: SheetLocale;
}

export type CanonicalResult =
  | {
      ok: true;
      f: string;
      /**
       * The formula's own sheet must grow to this many rows and columns for every reference to land: the caller grows
       * it and calls again (until then those references read `#REF!` in `f`).
       */
      needs?: { rows: number; cols: number };
      /** The same for other sheets the formula names, by sheet id. */
      needsSheets?: Record<string, { rows: number; cols: number }>;
    }
  | { ok: false; error: FormulaProblem };

const PARSED_MAX = 100_000;
const parsed = new Map<string, Ast | FormulaError>();

/** A stored formula's tree, cached (trees are never changed in place); throws `FormulaError` for a malformed one. */
export function parseStored(f: string): Ast {
  let hit = parsed.get(f);
  if (hit === undefined) {
    try {
      hit = parseCanonical(f);
    } catch (e) {
      if (!(e instanceof FormulaError)) throw e;
      hit = e;
    }
    if (parsed.size >= PARSED_MAX) parsed.clear();
    parsed.set(f, hit);
  }
  if (hit instanceof FormulaError) throw hit;
  return hit;
}

function arity(fn: string): { min: number; max: number } | null {
  const spec = FUNCTIONS[fn];
  return spec ? { min: spec.min, max: spec.max } : null;
}

/** Where the formula's body starts in what was typed: after leading spaces and the "=". */
function bodyStart(input: string): number {
  let i = 0;
  while (i < input.length && /\s/.test(input.charAt(i))) i++;
  return input.charAt(i) === "=" ? i + 1 : i;
}

/**
 * A formula typed by a person (or an agent, with an English locale) into its canonical form, resolving A1 against the
 * sheet's current rows and columns. Names in the person's language and in English are both read.
 */
export function toCanonical(input: string, ctx: FormulaContext): CanonicalResult {
  const start = bodyStart(input);
  const body = input.slice(start);
  const limits = LIVE_LIMITS.spreadsheet;
  if (body.trim().length === 0) return { ok: false, error: { code: "empty", at: start } };
  if (body.length > limits.formulaChars) return { ok: false, error: { code: "too_long", at: start } };
  const grow = new Map<string, { rows: number; cols: number }>();
  const resolve: A1Resolver = {
    sheet(name, at) {
      const id = sheetIdByName(ctx.doc, name);
      if (id === null) throw new FormulaError({ code: "bad_sheet", at, text: name });
      return id;
    },
    part(sheet, part, at) {
      const id = sheet ?? ctx.sheetId;
      const rows = rowAxis(ctx.doc, id);
      const cols = colAxis(ctx.doc, id);
      if (!rows || !cols) return null;
      if ((part.row !== null && part.row >= limits.rows) || (part.col !== null && part.col >= limits.cols)) {
        throw new FormulaError({ code: "too_far", at });
      }
      const row = part.row === null ? null : (rows.ids[part.row] ?? null);
      const col = part.col === null ? null : (cols.ids[part.col] ?? null);
      const missRow = part.row !== null && row === null;
      const missCol = part.col !== null && col === null;
      if (missRow || missCol) {
        const need = grow.get(id) ?? { rows: rows.ids.length, cols: cols.ids.length };
        if (missRow) need.rows = Math.max(need.rows, (part.row as number) + 1);
        if (missCol) need.cols = Math.max(need.cols, (part.col as number) + 1);
        grow.set(id, need);
        return null;
      }
      return { row, col };
    },
  };
  let ast: Ast;
  try {
    ast = parseFormula(body, {
      canonical: false,
      decimal: ctx.locale.decimal,
      argSep: ctx.locale.argSep,
      pt: ctx.locale.fnNames === "pt",
      resolve,
      arity,
    });
  } catch (e) {
    if (!(e instanceof FormulaError)) throw e;
    return { ok: false, error: { ...e.problem, at: e.problem.at + start } };
  }
  const f = printCanonical(ast);
  if (f.length > limits.formulaChars) return { ok: false, error: { code: "too_long", at: start } };
  if (grow.size === 0) return { ok: true, f };
  const out: CanonicalResult & { ok: true } = { ok: true, f };
  const own = grow.get(ctx.sheetId);
  if (own) out.needs = own;
  const others = [...grow].filter(([id]) => id !== ctx.sheetId);
  if (others.length > 0) out.needsSheets = Object.fromEntries(others);
  return out;
}

/** A stored formula as a person reads it, with its "=": `=SOMA(B2:B9;C1)` in Portuguese. */
export function toDisplay(f: string, ctx: FormulaContext): string {
  try {
    return `=${printDisplay(parseStored(f), ctx)}`;
  } catch (e) {
    if (e instanceof FormulaError) return `=${f}`;
    throw e;
  }
}

/** A new tree with every reference (and range) mapped; a mapping to null becomes `#REF!`. */
function mapRefs(
  ast: Ast,
  ref: (r: CellRefId) => CellRefId | null,
  range?: (from: CellRefId, to: CellRefId) => [CellRefId, CellRefId] | null,
): Ast {
  switch (ast.t) {
    case "ref": {
      const r = ref(ast.ref);
      return r ? { t: "ref", ref: r } : { t: "err", v: "#REF!" };
    }
    case "range": {
      const pair = range ? range(ast.from, ast.to) : [ref(ast.from), ref(ast.to)];
      const [a, b] = pair ?? [null, null];
      return a && b ? { t: "range", from: a, to: b } : { t: "err", v: "#REF!" };
    }
    case "un":
      return { t: "un", op: ast.op, a: mapRefs(ast.a, ref, range) };
    case "bin":
      return { t: "bin", op: ast.op, a: mapRefs(ast.a, ref, range), b: mapRefs(ast.b, ref, range) };
    case "paren":
      return { t: "paren", a: mapRefs(ast.a, ref, range) };
    case "call":
      return { t: "call", fn: ast.fn, args: ast.args.map((a) => mapRefs(a, ref, range)) };
    case "arr":
      return { t: "arr", rows: ast.rows.map((row) => row.map((a) => mapRefs(a, ref, range))) };
    default:
      return ast;
  }
}

export interface ShiftContext {
  doc: Y.Doc;
  /** The sheet the formula is copied from. */
  sheetId: string;
  /** The sheet it is pasted on, when another: references without a sheet then land on that sheet's rows. */
  toSheet?: string;
}

/**
 * Copy and fill: moves the relative parts of every reference by `dr` rows and `dc` columns in index space (absolute
 * `$` parts stay), as pasting a formula elsewhere does. A reference pushed off the grid becomes `#REF!`.
 */
export function shiftFormula(f: string, dr: number, dc: number, ctx: ShiftContext): string {
  let ast: Ast;
  try {
    ast = parseStored(f);
  } catch (e) {
    if (e instanceof FormulaError) return f;
    throw e;
  }
  const target = ctx.toSheet ?? ctx.sheetId;
  if (dr === 0 && dc === 0 && target === ctx.sheetId) return f;
  const shifted = mapRefs(ast, (ref) => {
    const from = ref.sheet ?? ctx.sheetId;
    const to = ref.sheet ?? target;
    const rowsFrom = rowAxis(ctx.doc, from);
    const colsFrom = colAxis(ctx.doc, from);
    const rowsTo = rowAxis(ctx.doc, to);
    const colsTo = colAxis(ctx.doc, to);
    if (!rowsFrom || !colsFrom || !rowsTo || !colsTo) return ref;
    const out: CellRefId = { ...ref };
    if (ref.row !== null) {
      const r = rowsFrom.pos.get(ref.row);
      if (r === undefined) return ref;
      const id = rowsTo.ids[ref.absRow ? r : r + dr];
      if (id === undefined) return null;
      out.row = id;
    }
    if (ref.col !== null) {
      const c = colsFrom.pos.get(ref.col);
      if (c === undefined) return ref;
      const id = colsTo.ids[ref.absCol ? c : c + dc];
      if (id === undefined) return null;
      out.col = id;
    }
    return out;
  });
  return printCanonical(shifted);
}

/**
 * Before rows or columns are deleted: ranges whose first or last row (column) goes are pulled in to the nearest one
 * that stays, so `SUM(A1:A9)` becomes `SUM(A1:A8)` when row 9 goes, as in Excel; single references to what goes are
 * left to become `#REF!`. Call it with the order as it is before the deletion.
 */
export function adjustForDeletion(
  f: string,
  ctx: { doc: Y.Doc; sheetId: string },
  gone: { sheet: string; rows?: ReadonlySet<string>; cols?: ReadonlySet<string> },
): string {
  let ast: Ast;
  try {
    ast = parseStored(f);
  } catch (e) {
    if (e instanceof FormulaError) return f;
    throw e;
  }
  const rows = rowAxis(ctx.doc, gone.sheet);
  const cols = colAxis(ctx.doc, gone.sheet);
  if (!rows || !cols) return f;
  let changed = false;
  const pull = (
    a: string | null,
    b: string | null,
    axis: { ids: readonly string[]; pos: ReadonlyMap<string, number> },
    set: ReadonlySet<string> | undefined,
  ): [string | null, string | null] => {
    if (a === null || b === null || !set || set.size === 0 || (!set.has(a) && !set.has(b))) return [a, b];
    const pa = axis.pos.get(a);
    const pb = axis.pos.get(b);
    if (pa === undefined || pb === undefined) return [a, b];
    let lo = Math.min(pa, pb);
    let hi = Math.max(pa, pb);
    while (lo <= hi && set.has(axis.ids[lo] as string)) lo++;
    while (hi >= lo && set.has(axis.ids[hi] as string)) hi--;
    if (lo > hi) return [a, b];
    changed = true;
    const first = axis.ids[lo] as string;
    const last = axis.ids[hi] as string;
    return pa <= pb ? [first, last] : [last, first];
  };
  const out = mapRefs(
    ast,
    (ref) => ref,
    (from, to) => {
      if ((from.sheet ?? ctx.sheetId) !== gone.sheet) return [from, to];
      const [r1, r2] = pull(from.row, to.row, rows, gone.rows);
      const [c1, c2] = pull(from.col, to.col, cols, gone.cols);
      return [
        { ...from, row: r1, col: c1 },
        { ...to, row: r2, col: c2 },
      ];
    },
  );
  return changed ? printCanonical(out) : f;
}

/** The references of a stored formula in order: `[ref]` for a cell, `[from, to]` for a range. */
export function referencedRanges(f: string): CellRefId[][] {
  let ast: Ast;
  try {
    ast = parseStored(f);
  } catch (e) {
    if (e instanceof FormulaError) return [];
    throw e;
  }
  const out: CellRefId[][] = [];
  const walk = (a: Ast): void => {
    switch (a.t) {
      case "ref":
        out.push([a.ref]);
        return;
      case "range":
        out.push([a.from, a.to]);
        return;
      case "un":
      case "paren":
        walk(a.a);
        return;
      case "bin":
        walk(a.a);
        walk(a.b);
        return;
      case "call":
        for (const x of a.args) walk(x);
        return;
      case "arr":
        for (const row of a.rows) for (const x of row) walk(x);
        return;
      default:
        return;
    }
  };
  walk(ast);
  return out;
}

/** Every function the engine knows, by canonical name, sorted. */
export const FUNCTION_NAMES: readonly string[] = Object.freeze(Object.keys(FUNCTIONS).sort());

export interface FunctionHelp {
  /** The name in the reader's language ("SOMA"). */
  name: string;
  /** The arguments, as i18n keys under `live.sheet.args`. */
  args: string[];
  /** How many arguments are required (the rest are optional). */
  min: number;
  /** How many of the last arguments repeat ("…"), 0 when none. */
  repeat: number;
}

/** A function's signature for the formula bar's hint, from its name in either language. */
export function functionHelp(name: string, locale: SheetLocale): FunctionHelp | null {
  const canonical = canonicalFunctionName(name, locale.fnNames === "pt");
  const spec = FUNCTIONS[canonical];
  if (!spec) return null;
  return {
    name: locale.fnNames === "pt" ? ptNameOf(canonical) : canonical,
    args: spec.args.map((a) => `live.sheet.args.${a}`),
    min: spec.min,
    repeat: spec.repeat ?? 0,
  };
}

/** Function names as the reader types them, for autocomplete: `{ name: "SOMA", canonical: "SUM" }`, sorted. */
export function functionNames(locale: SheetLocale): { name: string; canonical: string }[] {
  const pt = locale.fnNames === "pt";
  return FUNCTION_NAMES.map((canonical) => ({ name: pt ? ptNameOf(canonical) : canonical, canonical })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

export interface FormulaRefSpan {
  /** Where the reference is in the typed text (offsets, end exclusive). */
  start: number;
  end: number;
  /** The sheet it points to (by id) and the cells it covers there, 0-based and inclusive. */
  sheet: string;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  /** The same reference typed twice gets the same index; the apps pick a color by it. */
  color: number;
}

export interface FormulaInspection {
  refs: FormulaRefSpan[];
  /** The function call the cursor is inside (canonical name) and which argument (0-based) it is on. */
  fn?: { name: string; arg: number };
  /** The name being typed right before the cursor, for autocomplete. */
  word?: { start: number; end: number; text: string };
}

/**
 * What the formula bar needs while a person types (`input` with its "="): the references in it, with the cells each
 * covers, to color both; the function and argument the cursor is in, for the hint; and the name being typed. Reads
 * what can be read of an unfinished formula and never throws.
 */
export function inspectFormula(input: string, cursor: number, ctx: FormulaContext): FormulaInspection {
  const start = bodyStart(input);
  const body = input.slice(start);
  let toks: Token[];
  try {
    toks = tokenize(body, { canonical: false, decimal: ctx.locale.decimal, argSep: ctx.locale.argSep, loose: true });
  } catch {
    return { refs: [] };
  }
  const refs: FormulaRefSpan[] = [];
  const colors = new Map<string, number>();
  const sheetOf = (name: string | undefined): string | null =>
    name === undefined ? ctx.sheetId : sheetIdByName(ctx.doc, name);
  const span = (sheetName: string | undefined, a: A1Part, b: A1Part | undefined, s: number, e: number) => {
    const sheet = sheetOf(sheetName);
    if (sheet === null) return;
    const rows = rowAxis(ctx.doc, sheet)?.ids.length ?? 0;
    const cols = colAxis(ctx.doc, sheet)?.ids.length ?? 0;
    const end = b ?? a;
    const r1 = a.row ?? 0;
    const r2 = end.row ?? Math.max(0, rows - 1);
    const c1 = a.col ?? 0;
    const c2 = end.col ?? Math.max(0, cols - 1);
    const key = `${sheet}|${Math.min(r1, r2)}|${Math.min(c1, c2)}|${Math.max(r1, r2)}|${Math.max(c1, c2)}`;
    let color = colors.get(key);
    if (color === undefined) {
      color = colors.size;
      colors.set(key, color);
    }
    refs.push({
      start: s + start,
      end: e + start,
      sheet,
      r1: Math.min(r1, r2),
      c1: Math.min(c1, c2),
      r2: Math.max(r1, r2),
      c2: Math.max(c1, c2),
      color,
    });
  };
  const calls: { name: string; arg: number; open: number }[] = [];
  let fn: FormulaInspection["fn"];
  const pos = cursor - start;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as Token;
    if (t.at >= pos && fn === undefined) {
      const top = calls[calls.length - 1];
      if (top) fn = { name: top.name, arg: top.arg };
    }
    if (t.k === "a1") {
      const next = toks[i + 1];
      const after = toks[i + 2];
      if (
        !t.b &&
        next?.k === "op" &&
        next.v === ":" &&
        after?.k === "a1" &&
        !after.b &&
        (after.sheet === undefined || after.sheet.toLowerCase() === (t.sheet ?? "").toLowerCase())
      ) {
        span(t.sheet, t.a, after.a, t.at, after.end);
        i += 2;
        continue;
      }
      span(t.sheet, t.a, t.b, t.at, t.end);
      continue;
    }
    if (t.k === "id" && toks[i + 1]?.k === "lparen") {
      const open = toks[i + 1] as Token;
      calls.push({ name: canonicalFunctionName(t.v, ctx.locale.fnNames === "pt"), arg: 0, open: open.at });
      i++;
      continue;
    }
    if (t.k === "sep") {
      const top = calls[calls.length - 1];
      if (top) top.arg++;
      continue;
    }
    if (t.k === "rparen") calls.pop();
  }
  const out: FormulaInspection = { refs };
  if (fn) out.fn = fn;
  const before = toks.filter((t) => t.k !== "end" && t.end === pos);
  const word = before[before.length - 1];
  if (word && word.k === "id") out.word = { start: word.at + start, end: word.end + start, text: word.v };
  return out;
}
