/**
 * Writes a formula's tree back out (ADR 0196 §2): canonically, as the document stores it (English names, `,` and
 * `.`, references by ids), or for a person, in A1 with the names and separators of their language
 * (`=SOMA(B2:B9;C1)`). Parentheses come from the tree's own `paren` nodes and, for trees built by code, wherever
 * precedence needs them.
 */
import type * as Y from "yjs";
import { colName, quoteSheetName } from "../a1";
import type { SheetLocale } from "../locale";
import { booleanText, type ErrorCode, errorText } from "../values";
import { colAxis, rowAxis, sheetName } from "./grid";
import { ptNameOf } from "./names-pt";
import type { Ast, BinOp, CellRefId } from "./types";

interface Style {
  num(v: number): string;
  bool(v: boolean): string;
  err(code: ErrorCode): string;
  fn(name: string): string;
  sep: string;
  colSep: string;
  rowSep: string;
  arrOpen: string;
  arrClose: string;
  ref(ref: CellRefId): string;
  range(from: CellRefId, to: CellRefId): string;
}

const BIN_LEVEL: Record<BinOp, number> = {
  "=": 1,
  "<>": 1,
  "<": 1,
  ">": 1,
  "<=": 1,
  ">=": 1,
  "&": 2,
  "+": 3,
  "-": 3,
  "*": 4,
  "/": 4,
  "^": 5,
  ":": 8,
};

function level(ast: Ast): number {
  switch (ast.t) {
    case "bin":
      return BIN_LEVEL[ast.op];
    case "un":
      return ast.op === "%" ? 6 : 7;
    case "num":
      return ast.v < 0 || Object.is(ast.v, -0) ? 7 : 9;
    default:
      return 9;
  }
}

function wrap(text: string, child: Ast, min: number): string {
  return level(child) < min ? `(${text})` : text;
}

function print(ast: Ast, s: Style): string {
  switch (ast.t) {
    case "num":
      return s.num(ast.v);
    case "str":
      return `"${ast.v.replace(/"/g, '""')}"`;
    case "bool":
      return s.bool(ast.v);
    case "err":
      return s.err(ast.v);
    case "ref":
      return s.ref(ast.ref);
    case "range":
      return s.range(ast.from, ast.to);
    case "name":
      return ast.name;
    case "missing":
      return "";
    case "paren":
      return `(${print(ast.a, s)})`;
    case "un":
      if (ast.op === "%") return `${wrap(print(ast.a, s), ast.a, 6)}%`;
      return `${ast.op}${wrap(print(ast.a, s), ast.a, 7)}`;
    case "bin": {
      const p = BIN_LEVEL[ast.op];
      const left = wrap(print(ast.a, s), ast.a, p);
      const right = wrap(print(ast.b, s), ast.b, p + 1);
      return `${left}${ast.op}${right}`;
    }
    case "call":
      return `${s.fn(ast.fn)}(${ast.args.map((a) => print(a, s)).join(s.sep)})`;
    case "arr":
      return `${s.arrOpen}${ast.rows.map((row) => row.map((a) => print(a, s)).join(s.colSep)).join(s.rowSep)}${s.arrClose}`;
  }
}

/** A number as the canonical form writes it: shortest round-trip digits, `E` for exponents. */
export function canonicalNumber(v: number): string {
  if (Object.is(v, -0)) return "0";
  return String(v).replace("e", "E");
}

function canonicalRef(ref: CellRefId): string {
  const sheet = ref.sheet === undefined ? "" : `${ref.sheet}!`;
  const row = ref.row === null ? "" : `${ref.absRow ? "$" : ""}${ref.row}`;
  const col = ref.col === null ? "" : `${ref.absCol ? "$" : ""}${ref.col}`;
  return `{${sheet}${row},${col}}`;
}

const CANONICAL_STYLE: Style = {
  num: canonicalNumber,
  bool: (v) => (v ? "TRUE" : "FALSE"),
  err: (code) => code,
  fn: (name) => name,
  sep: ",",
  colSep: ",",
  rowSep: ";",
  arrOpen: "{ ",
  arrClose: " }",
  ref: canonicalRef,
  range: (from, to) => `${canonicalRef(from)}:${canonicalRef(to)}`,
};

/** The canonical text of a tree (no "="): `SUM({r1,c2}:{r9,c2})`. */
export function printCanonical(ast: Ast): string {
  return print(ast, CANONICAL_STYLE);
}

export interface DisplayContext {
  doc: Y.Doc;
  sheetId: string;
  locale: SheetLocale;
}

interface Located {
  row: number | null;
  col: number | null;
}

function locate(ref: CellRefId, ctx: DisplayContext): Located | null {
  const sheet = ref.sheet ?? ctx.sheetId;
  const rows = rowAxis(ctx.doc, sheet);
  const cols = colAxis(ctx.doc, sheet);
  if (!rows || !cols) return null;
  const row = ref.row === null ? null : rows.pos.get(ref.row);
  const col = ref.col === null ? null : cols.pos.get(ref.col);
  if (row === undefined || col === undefined) return null;
  return { row, col };
}

function a1Part(at: Located, ref: CellRefId): string {
  const col = at.col === null ? "" : `${ref.absCol ? "$" : ""}${colName(at.col)}`;
  const row = at.row === null ? "" : `${ref.absRow ? "$" : ""}${at.row + 1}`;
  return col + row;
}

function sheetPrefix(ref: CellRefId, ctx: DisplayContext): string | null {
  if (ref.sheet === undefined) return "";
  const name = sheetName(ctx.doc, ref.sheet);
  return name === null ? null : `${quoteSheetName(name)}!`;
}

/** The style that writes A1 in a person's language; references that no longer resolve read `#REF!`. */
function displayStyle(ctx: DisplayContext): Style {
  const { locale } = ctx;
  const pt = locale.fnNames === "pt";
  const refError = errorText("#REF!", locale);
  return {
    num: (v) => {
      const text = canonicalNumber(v);
      return locale.decimal === "," ? text.replace(".", ",") : text;
    },
    bool: (v) => booleanText(v, locale),
    err: (code) => errorText(code, locale),
    fn: (name) => (pt ? ptNameOf(name) : name),
    sep: locale.argSep,
    colSep: locale.argSep === ";" ? "\\" : ",",
    rowSep: ";",
    arrOpen: "{",
    arrClose: "}",
    ref: (ref) => {
      const prefix = sheetPrefix(ref, ctx);
      const at = locate(ref, ctx);
      return prefix === null || !at ? refError : prefix + a1Part(at, ref);
    },
    range: (from, to) => {
      const prefix = sheetPrefix(from, ctx);
      const a = locate(from, ctx);
      const b = locate({ ...to, sheet: to.sheet ?? from.sheet }, ctx);
      if (prefix === null || !a || !b) return refError;
      // Rows or columns moved past each other still read top-left to bottom-right, each `$` with its own edge.
      let fa = from;
      let fb = to;
      let pa = a;
      let pb = b;
      const rows = a.row !== null && b.row !== null && a.row > b.row;
      const cols = a.col !== null && b.col !== null && a.col > b.col;
      if (rows || cols) {
        pa = { row: rows ? b.row : a.row, col: cols ? b.col : a.col };
        pb = { row: rows ? a.row : b.row, col: cols ? a.col : b.col };
        fa = { ...from, absRow: rows ? to.absRow : from.absRow, absCol: cols ? to.absCol : from.absCol };
        fb = { ...to, absRow: rows ? from.absRow : to.absRow, absCol: cols ? from.absCol : to.absCol };
      }
      return `${prefix}${a1Part(pa, fa)}:${a1Part(pb, fb)}`;
    },
  };
}

/** A tree as a person reads it, in A1 and their language (no "="). */
export function printDisplay(ast: Ast, ctx: DisplayContext): string {
  return print(ast, displayStyle(ctx));
}
