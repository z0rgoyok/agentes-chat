/**
 * Runs a formula's tree (ADR 0196 §2) with Excel's rules: references resolve by id to where their rows and columns
 * are now (a deleted one is `#REF!`), operators work item by item over arrays and ranges, functions take their
 * arguments evaluated (or unevaluated, for IF and the others that run one branch), and the first error wins.
 */
import type { CellValue } from "../values";
import { FUNCTIONS } from "./functions";
import type { FnSpec } from "./functions/spec";
import {
  arrAt,
  broadcast,
  compareValues,
  deref,
  type Env,
  ERR,
  isArr,
  isErr,
  isRef,
  MAX_ARRAY,
  MAX_TEXT,
  makeArr,
  mapArr,
  type RefValue,
  spend,
  toNumber,
  toText,
  type Val,
} from "./runtime";
import type { Ast, BinOp, CellRefId } from "./types";

/** A reference by ids to the rectangle it covers now; `#REF!` when a row, column or sheet it names is gone. */
export function resolveRef(from: CellRefId, to: CellRefId, env: Env): RefValue | CellValue {
  const sheet = from.sheet ?? env.sheet;
  const size = env.host.size(sheet);
  if (!size) return ERR["#REF!"];
  let r1: number;
  let r2: number;
  let c1: number;
  let c2: number;
  if (from.row === null || to.row === null) {
    if (size.rows === 0) return ERR["#REF!"];
    r1 = 0;
    r2 = size.rows - 1;
  } else {
    const a = env.host.rowPos(sheet, from.row);
    const b = from.row === to.row ? a : env.host.rowPos(sheet, to.row);
    if (a < 0 || b < 0) return ERR["#REF!"];
    r1 = Math.min(a, b);
    r2 = Math.max(a, b);
  }
  if (from.col === null || to.col === null) {
    if (size.cols === 0) return ERR["#REF!"];
    c1 = 0;
    c2 = size.cols - 1;
  } else {
    const a = env.host.colPos(sheet, from.col);
    const b = from.col === to.col ? a : env.host.colPos(sheet, to.col);
    if (a < 0 || b < 0) return ERR["#REF!"];
    c1 = Math.min(a, b);
    c2 = Math.max(a, b);
  }
  return { k: "ref", sheet, r1, c1, r2, c2 };
}

/** A finite number, `#NUM!` past what a double holds, and never -0. */
function finite(n: number): CellValue {
  if (!Number.isFinite(n)) return ERR["#NUM!"];
  return n === 0 ? 0 : n;
}

function power(x: number, y: number): CellValue {
  if (x === 0 && y === 0) return ERR["#NUM!"];
  if (x === 0 && y < 0) return ERR["#DIV/0!"];
  const r = x ** y;
  if (Number.isNaN(r)) return ERR["#NUM!"];
  return finite(r);
}

function arith(op: BinOp, a: CellValue, b: CellValue, env: Env): CellValue {
  const x = toNumber(a, env.calc);
  if (isErr(x)) return x;
  const y = toNumber(b, env.calc);
  if (isErr(y)) return y;
  switch (op) {
    case "+":
      return finite(x + y);
    case "-":
      return finite(x - y);
    case "*":
      return finite(x * y);
    case "/":
      return y === 0 ? ERR["#DIV/0!"] : finite(x / y);
    default:
      return power(x, y);
  }
}

function concat(a: CellValue, b: CellValue, env: Env): CellValue {
  const x = toText(a, env.calc);
  if (isErr(x)) return x;
  const y = toText(b, env.calc);
  if (isErr(y)) return y;
  return x.length + y.length > MAX_TEXT ? ERR["#VALUE!"] : x + y;
}

function compare(op: BinOp, a: CellValue, b: CellValue): CellValue {
  if (isErr(a)) return a;
  if (isErr(b)) return b;
  const c = compareValues(a, b);
  switch (op) {
    case "=":
      return c === 0;
    case "<>":
      return c !== 0;
    case "<":
      return c < 0;
    case ">":
      return c > 0;
    case "<=":
      return c <= 0;
    default:
      return c >= 0;
  }
}

function scalarOp(op: BinOp, a: CellValue, b: CellValue, env: Env): CellValue {
  switch (op) {
    case "&":
      return concat(a, b, env);
    case "=":
    case "<>":
    case "<":
    case ">":
    case "<=":
    case ">=":
      return compare(op, a, b);
    default:
      return arith(op, a, b, env);
  }
}

/** `A1:INDEX(…)`, `OFFSET(…):C9`: the rectangle spanning two references on one sheet. */
function rangeOp(a: Val, b: Val): Val {
  if (isErr(a)) return a;
  if (isErr(b)) return b;
  if (!isRef(a) || !isRef(b)) return ERR["#VALUE!"];
  if (a.sheet !== b.sheet) return ERR["#REF!"];
  return {
    k: "ref",
    sheet: a.sheet,
    r1: Math.min(a.r1, b.r1),
    c1: Math.min(a.c1, b.c1),
    r2: Math.max(a.r2, b.r2),
    c2: Math.max(a.c2, b.c2),
  };
}

function binary(ast: Extract<Ast, { t: "bin" }>, env: Env): Val {
  const left = evaluate(ast.a, env);
  const right = evaluate(ast.b, env);
  if (ast.op === ":") return rangeOp(left, right);
  const a = deref(left, env);
  const b = deref(right, env);
  if (isArr(a) || isArr(b)) return broadcast(a, b, env, (x, y) => scalarOp(ast.op, x, y, env));
  return scalarOp(ast.op, a, b, env);
}

function unaryScalar(op: "-" | "+" | "%", v: CellValue, env: Env): CellValue {
  if (op === "+") return v;
  const x = toNumber(v, env.calc);
  if (isErr(x)) return x;
  return finite(op === "-" ? -x : x / 100);
}

function unary(ast: Extract<Ast, { t: "un" }>, env: Env): Val {
  const v = evaluate(ast.a, env);
  if (ast.op === "+") return v;
  const d = deref(v, env);
  if (isArr(d)) return mapArr(d, env, (x) => unaryScalar(ast.op, x, env));
  return unaryScalar(ast.op, d, env);
}

function arrayLiteral(ast: Extract<Ast, { t: "arr" }>, env: Env): Val {
  const rows = ast.rows.length;
  const cols = rows > 0 ? (ast.rows[0] as Ast[]).length : 0;
  if (rows === 0 || cols === 0) return ERR["#VALUE!"];
  const out: CellValue[] = [];
  for (const row of ast.rows) {
    for (const item of row) {
      const v = deref(evaluate(item, env), env);
      out.push(isArr(v) ? (v.v[0] ?? ERR["#VALUE!"]) : v);
    }
  }
  return makeArr(rows, cols, out);
}

/** A lifted argument's value at one item of the result. */
function itemOf(v: Val | undefined, r: number, c: number): Val | undefined {
  return v !== undefined && isArr(v) ? arrAt(v, r, c) : v;
}

/** One value out of whatever a function returned for one item. */
function oneValue(v: Val, env: Env): CellValue {
  const d = deref(v, env);
  return isArr(d) ? (d.v[0] ?? ERR["#VALUE!"]) : d;
}

const LIFTED = new WeakMap<FnSpec, ReadonlySet<number>>();

/** The lifted parameters of a function, null when all are. */
function liftedSet(spec: FnSpec): ReadonlySet<number> | null {
  if (spec.lift === "all" || spec.lift === undefined) return null;
  let set = LIFTED.get(spec);
  if (!set) {
    set = new Set(spec.lift);
    LIFTED.set(spec, set);
  }
  return set;
}

/**
 * Runs a function whose parameters take one value each over arrays and ranges given there, item by item (Excel's
 * lifting: `=LEN(A1:A9)` is nine lengths), broadcasting a single row or column.
 */
function lifted(spec: FnSpec, args: (Val | undefined)[], env: Env): Val {
  const fn = spec.fn as (args: Val[], env: Env) => Val;
  const which = liftedSet(spec);
  const vals = args.slice();
  let rows = 1;
  let cols = 1;
  let any = false;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v === undefined || (which && !which.has(i))) continue;
    const d = deref(v, env);
    vals[i] = d;
    if (isArr(d)) {
      any = true;
      rows = Math.max(rows, d.rows);
      cols = Math.max(cols, d.cols);
    }
  }
  const firstError = (list: (Val | undefined)[]): CellValue | null => {
    if (spec.takesErrors) return null;
    for (let i = 0; i < list.length; i++) {
      if (which && !which.has(i)) continue;
      const v = list[i];
      if (v !== undefined && isErr(v)) return v;
    }
    return null;
  };
  if (!any) {
    const err = firstError(vals);
    return err ?? fn(vals as Val[], env);
  }
  if (rows * cols > MAX_ARRAY) return ERR["#NUM!"];
  spend(env, rows * cols);
  const out = new Array<CellValue>(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const item = vals.map((v, i) => (which && !which.has(i) ? v : itemOf(v, r, c)));
      const err = firstError(item);
      out[r * cols + c] = err ?? oneValue(fn(item as Val[], env), env);
    }
  }
  return makeArr(rows, cols, out);
}

function call(ast: Extract<Ast, { t: "call" }>, env: Env): Val {
  const spec = FUNCTIONS[ast.fn];
  if (!spec) return ERR["#NAME?"];
  const n = ast.args.length;
  if (n < spec.min || n > spec.max) return ERR["#VALUE!"];
  if (spec.lazy) return spec.lazy(ast.args, env);
  const args = new Array<Val | undefined>(n);
  for (let i = 0; i < n; i++) {
    const a = ast.args[i] as Ast;
    args[i] = a.t === "missing" ? (spec.omit ? undefined : null) : evaluate(a, env);
  }
  if (spec.lift) return lifted(spec, args, env);
  return (spec.fn as (args: (Val | undefined)[], env: Env) => Val)(args, env);
}

/** Evaluates a tree to a value, a reference or an array. */
export function evaluate(ast: Ast, env: Env): Val {
  spend(env, 1);
  switch (ast.t) {
    case "num":
      return ast.v;
    case "str":
      return ast.v;
    case "bool":
      return ast.v;
    case "err":
      return ERR[ast.v];
    case "missing":
      return null;
    case "paren":
      return evaluate(ast.a, env);
    case "name":
      return ERR["#NAME?"];
    case "ref":
      return resolveRef(ast.ref, ast.ref, env);
    case "range":
      return resolveRef(ast.from, ast.to, env);
    case "arr":
      return arrayLiteral(ast, env);
    case "un":
      return unary(ast, env);
    case "bin":
      return binary(ast, env);
    case "call":
      return call(ast, env);
  }
}

/**
 * What a cell shows for its formula's result: a reference or an array shows its top-left value (no spilling), a
 * reference to an empty cell shows 0 as in Excel, and numbers past a double's range are `#NUM!`.
 */
export function cellResult(v: Val, env: Env): CellValue {
  let out: CellValue;
  if (isRef(v)) out = env.host.cell(v.sheet, v.r1, v.c1);
  else if (isArr(v)) out = v.v.length > 0 ? (v.v[0] as CellValue) : ERR["#VALUE!"];
  else out = v;
  if (out === null) return 0;
  if (typeof out === "number") return finite(out);
  if (typeof out === "string" && out.length > MAX_TEXT) return ERR["#VALUE!"];
  return out;
}
