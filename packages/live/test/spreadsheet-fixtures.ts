/**
 * Helpers for the spreadsheet tests: a document with one sheet, a stand-in for the engine that computes nothing (it
 * reads stored values, enough for edits that move or show literals), and a way to read a block of cells as text.
 */
import * as Y from "yjs";
import { parseA1Range } from "../src/spreadsheet/a1";
import { cellAt, colIds, initSpreadsheet, rowIds, type SheetValues, sheetIds } from "../src/spreadsheet/doc";
import { formatValue } from "../src/spreadsheet/format";
import { toDisplay } from "../src/spreadsheet/formula";
import { sheetLocale } from "../src/spreadsheet/locale";
import type { RangeIds } from "../src/spreadsheet/write";

export const EN = sheetLocale("en-US");
export const PT = sheetLocale("pt-BR");

/** A new spreadsheet document (100 × 26) and its sheet's id. */
export function sheetDoc(name = "Sheet 1"): { doc: Y.Doc; sheet: string } {
  const doc = new Y.Doc();
  initSpreadsheet(doc, name);
  return { doc, sheet: sheetIds(doc)[0] as string };
}

/** Reads stored values only: a formula computes to nothing. */
export function storedValues(doc: Y.Doc): SheetValues {
  return {
    value(sheetId, rowId, colId) {
      const cell = cellAt(doc, sheetId, rowId, colId);
      return cell?.v ?? null;
    },
    display(sheetId, rowId, colId, locale) {
      const cell = cellAt(doc, sheetId, rowId, colId);
      return formatValue(cell?.v ?? null, cell?.s?.nf, locale).text;
    },
  };
}

/** A range in A1 on a sheet, as edits take it. */
export function range(sheet: string, a1: string): RangeIds {
  const r = parseA1Range(a1);
  if (!r) throw new Error(`Not a range: ${a1}`);
  return { sheet, r1: r.r1, c1: r.c1, r2: r.r2, c2: r.c2 };
}

/** What each cell of a block holds, as text: values as stored, formulas as English A1 ("=SUM(A1:A3)"), "" empty. */
export function cells(doc: Y.Doc, sheet: string, a1: string): string[][] {
  const r = parseA1Range(a1);
  if (!r) throw new Error(`Not a range: ${a1}`);
  const rows = rowIds(doc, sheet);
  const cols = colIds(doc, sheet);
  const out: string[][] = [];
  for (let i = r.r1; i <= r.r2; i++) {
    const line: string[] = [];
    for (let j = r.c1; j <= r.c2; j++) {
      const rowId = rows[i];
      const colId = cols[j];
      const cell = rowId && colId ? cellAt(doc, sheet, rowId, colId) : undefined;
      if (cell?.f !== undefined) line.push(toDisplay(cell.f, { doc, sheetId: sheet, locale: EN }));
      else line.push(cell?.v === undefined ? "" : String(cell.v));
    }
    out.push(line);
  }
  return out;
}

/** One cell's text, as `cells` gives it. */
export function cell(doc: Y.Doc, sheet: string, a1: string): string {
  return cells(doc, sheet, a1)[0]?.[0] ?? "";
}

/** Copies one document into a new one, as a second device would hold it. */
export function twin(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

/** Sends each document what the other has, both ways. */
export function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}
