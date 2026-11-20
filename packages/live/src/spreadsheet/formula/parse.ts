/**
 * Reads a formula into its tree (ADR 0196 §2) with Excel's precedence, loosest first: comparisons, `&`, `+ -`,
 * `* /`, `^` (left to right, so `2^3^2` is 64), `%`, negation (tighter than `^`, so `-2^2` is 4) and `:` between
 * references. A formula typed in A1 has its references turned into ids by a resolver, so what is stored never
 * depends on where rows and columns happen to be.
 */
import { canonicalFromPt } from "./names-pt";
import { type A1Part, type Token, type TokenizeOptions, tokenize } from "./tokenize";
import { type Ast, type BinOp, type CellRefId, FormulaError, MAX_FORMULA_DEPTH } from "./types";

/** Turns A1 references into ids, against the document's current order. */
export interface A1Resolver {
  /** A sheet's id by its name; undefined when there is none (the reference becomes `#REF!`), or throw to refuse. */
  sheet(name: string, at: number): string | undefined;
  /**
   * The ids at an A1 part on a sheet (undefined: the formula's own); null when the grid doesn't reach it (the
   * reference becomes `#REF!`), or throw to refuse. `at` is where the reference starts in the text.
   */
  part(sheet: string | undefined, part: A1Part, at: number): { row: string | null; col: string | null } | null;
}

export interface ParseOptions extends TokenizeOptions {
  /** Portuguese function names and booleans are read too (A1 only). */
  pt?: boolean;
  /** Needed for A1. */
  resolve?: A1Resolver;
  /** Refuse a known function called with too few or too many arguments. */
  arity?: (fn: string) => { min: number; max: number } | null;
}

type A1Tok = Extract<Token, { k: "a1" }>;
type Node = Ast | { t: "a1"; tok: A1Tok };

const COMPARE = new Set(["=", "<>", "<", ">", "<=", ">="]);
const FILE_PREFIXES = ["_XLFN._XLWS.", "_XLFN.", "_XLWS.", "_XLPM."];

/** A function's canonical name: Excel's file prefixes dropped, Portuguese names turned into English ones. */
export function canonicalFunctionName(name: string, pt: boolean): string {
  let n = name;
  for (const prefix of FILE_PREFIXES) {
    if (n.toUpperCase().startsWith(prefix)) {
      n = n.slice(prefix.length);
      break;
    }
  }
  if (pt) {
    const en = canonicalFromPt(n);
    if (en) return en;
  }
  return n.toUpperCase();
}

function booleanOf(name: string, pt: boolean): boolean | null {
  const up = name.toUpperCase();
  if (up === "TRUE" || (pt && up === "VERDADEIRO")) return true;
  if (up === "FALSE" || (pt && up === "FALSO")) return false;
  return null;
}

class Parser {
  private i = 0;
  private depth = 0;

  constructor(
    private readonly toks: Token[],
    private readonly opts: ParseOptions,
  ) {}

  parse(): Ast {
    const first = this.peek();
    if (first.k === "end") throw new FormulaError({ code: "missing_operand", at: first.at });
    const ast = this.comparison();
    const t = this.peek();
    if (t.k !== "end") this.unexpected(t);
    return ast;
  }

  private peek(): Token {
    return this.toks[this.i] as Token;
  }

  private next(): Token {
    const t = this.toks[this.i] as Token;
    if (t.k !== "end") this.i++;
    return t;
  }

  private isOp(t: Token, ...ops: string[]): boolean {
    return t.k === "op" && ops.includes(t.v);
  }

  private unexpected(t: Token): never {
    if (t.k === "end") throw new FormulaError({ code: "missing_operand", at: t.at });
    if (t.k === "rparen") throw new FormulaError({ code: "unexpected", at: t.at, text: ")" });
    throw new FormulaError({ code: "unexpected", at: t.at, text: t.k === "bad" ? t.v : undefined });
  }

  private enter(at: number): void {
    this.depth++;
    if (this.depth > MAX_FORMULA_DEPTH) throw new FormulaError({ code: "too_deep", at });
  }

  private leave(): void {
    this.depth--;
  }

  private comparison(): Ast {
    let left = this.concat();
    for (let t = this.peek(); t.k === "op" && COMPARE.has(t.v); t = this.peek()) {
      this.next();
      left = { t: "bin", op: t.v as BinOp, a: left, b: this.concat() };
    }
    return left;
  }

  private concat(): Ast {
    let left = this.additive();
    while (this.isOp(this.peek(), "&")) {
      this.next();
      left = { t: "bin", op: "&", a: left, b: this.additive() };
    }
    return left;
  }

  private additive(): Ast {
    let left = this.multiplicative();
    for (let t = this.peek(); this.isOp(t, "+", "-"); t = this.peek()) {
      this.next();
      left = { t: "bin", op: (t as { v: BinOp }).v, a: left, b: this.multiplicative() };
    }
    return left;
  }

  private multiplicative(): Ast {
    let left = this.power();
    for (let t = this.peek(); this.isOp(t, "*", "/"); t = this.peek()) {
      this.next();
      left = { t: "bin", op: (t as { v: BinOp }).v, a: left, b: this.power() };
    }
    return left;
  }

  private power(): Ast {
    let left = this.percent();
    while (this.isOp(this.peek(), "^")) {
      this.next();
      left = { t: "bin", op: "^", a: left, b: this.percent() };
    }
    return left;
  }

  private percent(): Ast {
    let a = this.unary();
    while (this.isOp(this.peek(), "%")) {
      this.next();
      a = { t: "un", op: "%", a };
    }
    return a;
  }

  private unary(): Ast {
    const t = this.peek();
    if (this.isOp(t, "-", "+")) {
      this.next();
      this.enter(t.at);
      const a = this.unary();
      this.leave();
      return { t: "un", op: (t as { v: "-" | "+" }).v, a };
    }
    return this.range();
  }

  private range(): Ast {
    let left = this.primary();
    while (this.isOp(this.peek(), ":")) {
      const colon = this.next();
      const right = this.primary();
      left = this.join(left, right, colon.at);
    }
    return this.finish(left);
  }

  /** `A1:B9`, `Sheet2!A1:B9`, `{r1,c1}:{r9,c2}`; anything else joined by `:` (like `A1:INDEX(…)`) is an operation. */
  private join(a: Node, b: Node, at: number): Node {
    if (a.t === "a1" && b.t === "a1" && !a.tok.b && !b.tok.b) {
      const sa = a.tok.sheet;
      const sb = b.tok.sheet;
      if (sb !== undefined && (sa === undefined || sa.toLowerCase() !== sb.toLowerCase())) {
        throw new FormulaError({ code: "bad_range", at });
      }
      const tok: A1Tok = { k: "a1", a: a.tok.a, b: b.tok.a, at: a.tok.at, end: b.tok.end };
      if (sa !== undefined) tok.sheet = sa;
      return { t: "a1", tok };
    }
    if (a.t === "ref" && b.t === "ref") {
      const fa = a.ref;
      const fb = b.ref;
      const sameKind = (fa.row === null) === (fb.row === null) && (fa.col === null) === (fb.col === null);
      if (sameKind && (fb.sheet === undefined || fb.sheet === fa.sheet)) {
        const to: CellRefId = { ...fb };
        if (fa.sheet !== undefined) to.sheet = fa.sheet;
        return { t: "range", from: fa, to };
      }
    }
    return { t: "bin", op: ":", a: this.finish(a), b: this.finish(b) };
  }

  private finish(node: Node): Ast {
    if (node.t === "a1") return this.resolveA1(node.tok);
    if (node.t === "ref" && (node.ref.row === null || node.ref.col === null)) {
      return { t: "range", from: node.ref, to: { ...node.ref } };
    }
    return node;
  }

  private resolveA1(tok: A1Tok): Ast {
    const resolver = this.opts.resolve;
    if (!resolver) throw new Error("An A1 formula needs a resolver");
    let sheet: string | undefined;
    if (tok.sheet !== undefined) {
      sheet = resolver.sheet(tok.sheet, tok.at);
      if (sheet === undefined) return { t: "err", v: "#REF!" };
    }
    let a = tok.a;
    let b = tok.b;
    if (b) {
      // Typed corners in any order read as the same range (`B5:A1` is `A1:B5`), each `$` staying with its row or column.
      const rows = a.row !== null && b.row !== null && a.row > b.row;
      const cols = a.col !== null && b.col !== null && a.col > b.col;
      if (rows || cols) {
        const na: A1Part = {
          row: rows ? b.row : a.row,
          absRow: rows ? b.absRow : a.absRow,
          col: cols ? b.col : a.col,
          absCol: cols ? b.absCol : a.absCol,
        };
        const nb: A1Part = {
          row: rows ? a.row : b.row,
          absRow: rows ? a.absRow : b.absRow,
          col: cols ? a.col : b.col,
          absCol: cols ? a.absCol : b.absCol,
        };
        a = na;
        b = nb;
      }
    }
    const ia = resolver.part(sheet, a, tok.at);
    const ib = b ? resolver.part(sheet, b, tok.at) : null;
    if (!ia || (b && !ib)) return { t: "err", v: "#REF!" };
    const from = refId(ia, a, sheet);
    if (!b || !ib) return { t: "ref", ref: from };
    return { t: "range", from, to: refId(ib, b, sheet) };
  }

  private primary(): Node {
    const t = this.next();
    switch (t.k) {
      case "num":
        return { t: "num", v: t.v };
      case "str":
        return { t: "str", v: t.v };
      case "err":
        return { t: "err", v: t.v };
      case "a1":
        return { t: "a1", tok: t };
      case "cref":
        return { t: "ref", ref: t.ref };
      case "lparen": {
        this.enter(t.at);
        const a = this.comparison();
        const close = this.next();
        if (close.k !== "rparen") {
          if (close.k === "end") throw new FormulaError({ code: "unclosed_paren", at: t.at });
          this.unexpected(close);
        }
        this.leave();
        return { t: "paren", a };
      }
      case "lbrace":
        return this.array(t.at);
      case "id":
        return this.identifier(t);
      default:
        return this.unexpected(t);
    }
  }

  private identifier(t: Extract<Token, { k: "id" }>): Node {
    const pt = this.opts.pt === true;
    if (this.peek().k !== "lparen") {
      const bool = booleanOf(t.v, pt);
      if (bool !== null) return { t: "bool", v: bool };
      return { t: "name", name: t.v };
    }
    const open = this.next();
    this.enter(open.at);
    const fn = canonicalFunctionName(t.v, pt);
    const args: Ast[] = [];
    if (this.peek().k === "rparen") {
      this.next();
    } else {
      for (;;) {
        const p = this.peek();
        args.push(p.k === "sep" || p.k === "rparen" ? { t: "missing" } : this.comparison());
        const u = this.next();
        if (u.k === "sep") continue;
        if (u.k === "rparen") break;
        if (u.k === "end") throw new FormulaError({ code: "unclosed_paren", at: open.at });
        this.unexpected(u);
      }
    }
    this.leave();
    const arity = this.opts.arity?.(fn);
    if (arity && (args.length < arity.min || args.length > arity.max)) {
      throw new FormulaError({ code: "args", at: t.at, fn: t.v, min: arity.min, max: arity.max });
    }
    return { t: "call", fn, args };
  }

  private array(at: number): Ast {
    const rows: Ast[][] = [[]];
    for (;;) {
      (rows[rows.length - 1] as Ast[]).push(this.arrayItem());
      const t = this.next();
      if (t.k === "colsep") continue;
      if (t.k === "rowsep") {
        rows.push([]);
        continue;
      }
      if (t.k === "rbrace") break;
      if (t.k === "end") throw new FormulaError({ code: "bad_array", at });
      throw new FormulaError({ code: "bad_array", at: t.at });
    }
    const width = (rows[0] as Ast[]).length;
    if (rows.some((r) => r.length !== width)) throw new FormulaError({ code: "bad_array", at });
    return { t: "arr", rows };
  }

  /** A constant inside `{…}`: a number (signed), text, a boolean or an error. */
  private arrayItem(): Ast {
    let sign = 1;
    let t = this.next();
    while (this.isOp(t, "-", "+")) {
      if ((t as { v: string }).v === "-") sign = -sign;
      t = this.next();
    }
    if (t.k === "num") return { t: "num", v: sign * t.v };
    if (sign === 1) {
      if (t.k === "str") return { t: "str", v: t.v };
      if (t.k === "err") return { t: "err", v: t.v };
      if (t.k === "id") {
        const bool = booleanOf(t.v, this.opts.pt === true);
        if (bool !== null) return { t: "bool", v: bool };
      }
    }
    throw new FormulaError({ code: "bad_array", at: t.at });
  }
}

function refId(ids: { row: string | null; col: string | null }, part: A1Part, sheet: string | undefined): CellRefId {
  const ref: CellRefId = { row: ids.row, col: ids.col };
  if (sheet !== undefined) ref.sheet = sheet;
  if (part.absRow && ids.row !== null) ref.absRow = true;
  if (part.absCol && ids.col !== null) ref.absCol = true;
  return ref;
}

/** Parses tokens or text into a tree; throws `FormulaError`. */
export function parseTokens(tokens: Token[], opts: ParseOptions): Ast {
  return new Parser(tokens, opts).parse();
}

export function parseFormula(src: string, opts: ParseOptions): Ast {
  return parseTokens(tokenize(src, opts), opts);
}

const CANONICAL: ParseOptions = { canonical: true, decimal: ".", argSep: "," };

/** A stored formula (no "=") into its tree; throws `FormulaError` when it isn't one. */
export function parseCanonical(f: string): Ast {
  return parseFormula(f, CANONICAL);
}
