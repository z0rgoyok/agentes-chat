/**
 * Test fixtures for the formula language and the engine (ADR 0196 §2): a spreadsheet document built directly in the
 * stored shape (sheets in order, rows and columns as ids, cells keyed `rowId:colId`), cells written in A1 the way a
 * person types them, and values read back through a `SheetEngine`.
 */
import { expect } from "bun:test";
import * as Y from "yjs";
import { parseA1 } from "../src/spreadsheet/a1";
import { SheetEngine } from "../src/spreadsheet/engine";
import { toCanonical } from "../src/spreadsheet/formula";
import { type SheetLocale, sheetLocale } from "../src/spreadsheet/locale";
import type { CellError, CellValue, ErrorCode } from "../src/spreadsheet/values";

export const EN: SheetLocale = sheetLocale("en-US");
export const PT: SheetLocale = sheetLocale("pt-BR");

export interface Book {
  doc: Y.Doc;
  /** Sheet ids by name. */
  ids: Record<string, string>;
  engine: SheetEngine;
  /** The first sheet's id. */
  first: string;
}

export interface BookOptions {
  rows?: number;
  cols?: number;
  now?: () => Date;
  locale?: string;
  seed?: string;
}

/** A sheet's map with `rows` × `cols` ids (`r0`…, `c0`…, prefixed so sheets don't share them unless asked). */
export function sheetMap(name: string, rows: number, cols: number, prefix = ""): Y.Map<unknown> {
  const sheet = new Y.Map<unknown>();
  sheet.set("name", name);
  const r = new Y.Array<string>();
  r.push(Array.from({ length: rows }, (_, i) => `${prefix}r${i}`));
  const c = new Y.Array<string>();
  c.push(Array.from({ length: cols }, (_, i) => `${prefix}c${i}`));
  sheet.set("rows", r);
  sheet.set("cols", c);
  sheet.set("cells", new Y.Map());
  sheet.set("colWidths", new Y.Map());
  sheet.set("rowHeights", new Y.Map());
  sheet.set("merges", new Y.Map());
  sheet.set("frozen", { rows: 0, cols: 0 });
  return sheet;
}

/** A spreadsheet document with the named sheets (ids `s0`, `s1`…) and an engine on it. */
export function book(names: string[] = ["Sheet1"], opts: BookOptions = {}): Book {
  const doc = new Y.Doc();
  const ids: Record<string, string> = {};
  doc.transact(() => {
    const meta = doc.getMap("meta");
    meta.set("kind", "spreadsheet");
    meta.set("v", 1);
    meta.set("seed", opts.seed ?? "seed-1");
    const sheets = doc.getMap<Y.Map<unknown>>("sheets");
    const order = doc.getArray<string>("sheetOrder");
    names.forEach((name, i) => {
      const id = `s${i}`;
      ids[name] = id;
      sheets.set(id, sheetMap(name, opts.rows ?? 40, opts.cols ?? 12, i === 0 ? "" : `${id}`));
      order.push([id]);
    });
  });
  const engineOpts: { now?: () => Date; locale?: string } = {};
  if (opts.now) engineOpts.now = opts.now;
  if (opts.locale) engineOpts.locale = opts.locale;
  const engine = new SheetEngine(doc, engineOpts);
  return { doc, ids, engine, first: ids[names[0] as string] as string };
}

function sheetOf(b: Book, sheet?: string): string {
  if (sheet === undefined) return b.first;
  return b.ids[sheet] ?? sheet;
}

export function rowsOf(b: Book, sheet?: string): Y.Array<string> {
  return (b.doc.getMap<Y.Map<unknown>>("sheets").get(sheetOf(b, sheet)) as Y.Map<unknown>).get(
    "rows",
  ) as Y.Array<string>;
}

export function colsOf(b: Book, sheet?: string): Y.Array<string> {
  return (b.doc.getMap<Y.Map<unknown>>("sheets").get(sheetOf(b, sheet)) as Y.Map<unknown>).get(
    "cols",
  ) as Y.Array<string>;
}

export function cellsOf(b: Book, sheet?: string): Y.Map<unknown> {
  return (b.doc.getMap<Y.Map<unknown>>("sheets").get(sheetOf(b, sheet)) as Y.Map<unknown>).get(
    "cells",
  ) as Y.Map<unknown>;
}

/** The `rowId:colId` key of an A1 address on a sheet. */
export function keyAt(b: Book, a1: string, sheet?: string): string {
  const at = parseA1(a1);
  if (!at) throw new Error(`Not an address: ${a1}`);
  const rowId = rowsOf(b, sheet).get(at.row);
  const colId = colsOf(b, sheet).get(at.col);
  if (rowId === undefined || colId === undefined) throw new Error(`Outside the grid: ${a1}`);
  return `${rowId}:${colId}`;
}

/** Writes a cell: "=…" a formula typed in `locale` (English by default), anything else as the value; null clears. */
export function put(
  b: Book,
  a1: string,
  value: string | number | boolean | null,
  opts: { sheet?: string; locale?: SheetLocale; nf?: string } = {},
): void {
  const sheetId = sheetOf(b, opts.sheet);
  const key = keyAt(b, a1, opts.sheet);
  b.doc.transact(() => {
    const cells = cellsOf(b, opts.sheet);
    if (value === null) {
      cells.delete(key);
      return;
    }
    const s = opts.nf ? { s: { nf: opts.nf } } : {};
    if (typeof value === "string" && value.startsWith("=")) {
      const r = toCanonical(value, { doc: b.doc, sheetId, locale: opts.locale ?? EN });
      if (!r.ok) throw new Error(`Formula ${value}: ${JSON.stringify(r.error)}`);
      if (r.needs || r.needsSheets) throw new Error(`Formula ${value} points past the grid`);
      cells.set(key, { f: r.f, ...s });
    } else cells.set(key, { v: value, ...s });
  });
}

/** Writes several cells, `{ A1: 10, B2: "=A1*2" }`. */
export function putAll(b: Book, values: Record<string, string | number | boolean | null>, sheet?: string): void {
  b.doc.transact(() => {
    for (const [a1, v] of Object.entries(values)) put(b, a1, v, sheet === undefined ? {} : { sheet });
  });
}

/** A cell's computed value. */
export function val(b: Book, a1: string, sheet?: string): CellValue {
  const at = parseA1(a1);
  if (!at) throw new Error(`Not an address: ${a1}`);
  return b.engine.valueAt(sheetOf(b, sheet), at.row, at.col);
}

/** A cell's text as shown in `locale`. */
export function shown(b: Book, a1: string, locale: SheetLocale = EN, sheet?: string): string {
  const [rowId, colId] = keyAt(b, a1, sheet).split(":") as [string, string];
  return b.engine.display(sheetOf(b, sheet), rowId, colId, locale);
}

/** The stored (canonical) formula of a cell. */
export function stored(b: Book, a1: string, sheet?: string): string | undefined {
  const raw = cellsOf(b, sheet).get(keyAt(b, a1, sheet)) as { f?: string } | undefined;
  return raw?.f;
}

/** An error value, as the engine returns it. */
export function err(code: ErrorCode): CellError {
  return { error: code };
}

/**
 * Evaluates one formula against a shared data sheet: column A numbers, B text, C mixed, E dates, F booleans (see
 * `DATA`), written once per book. The formula goes in L1.
 */
export const DATA: Record<string, string | number | boolean> = {
  A1: 10,
  A2: 20,
  A3: 30,
  A4: 40,
  A5: 50,
  B1: "apple",
  B2: "Banana",
  B3: "cherry",
  B4: "apple pie",
  B5: "date",
  C1: 1,
  C2: "two",
  C3: true,
  C4: 4,
  C6: "6",
  E1: 46343,
  E2: 46344,
  E3: 46350,
  F1: true,
  F2: false,
  F3: true,
  G1: -2,
  G2: 3.5,
  G3: 0,
  G4: 7,
  G5: -1.25,
};

let shared: Book | null = null;

export function dataBook(): Book {
  if (!shared) {
    shared = book(["Data", "Other"]);
    putAll(shared, DATA);
    putAll(shared, { A1: 100, A2: 200, B1: "x" }, "Other");
  }
  return shared;
}

/** The value of `formula` typed into L1 of the shared data sheet (in `locale`). */
export function ev(formula: string, locale: SheetLocale = EN): CellValue {
  const b = dataBook();
  put(b, "L1", formula, { locale });
  return val(b, "L1");
}

/** Checks a computed value: numbers within 1e-9 (relative past 1), anything else exactly. */
export function same(actual: CellValue, expected: CellValue): void {
  if (typeof expected === "number" && typeof actual === "number") {
    const tolerance = 1e-9 * Math.max(1, Math.abs(expected));
    if (Math.abs(actual - expected) <= tolerance) return;
  }
  expect(actual).toEqual(expected);
}

export type Case = [string, CellValue];

/** Runs `[formula, expected]` cases against the shared data sheet. */
export function cases(list: readonly Case[], locale: SheetLocale = EN): void {
  for (const [formula, expected] of list) {
    const actual = ev(formula, locale);
    try {
      same(actual, expected);
    } catch (e) {
      throw new Error(`${formula}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`, { cause: e });
    }
  }
}
