import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { LIVE_LIMITS } from "../src/limits";
import { LOCAL } from "../src/origins";
import { cellKey, colIds, newSheetMap, rowIds, sheetMap } from "../src/spreadsheet/doc";
import {
  addSheet,
  borderRange,
  deleteRows,
  duplicateSheet,
  formatRange,
  mergeRange,
  setColWidth,
  setFrozen,
  setSheetTab,
  setValues,
} from "../src/spreadsheet/ops";
import { validateSpreadsheet } from "../src/spreadsheet/validate";
import { EN, PT, range, sheetDoc } from "./spreadsheet-fixtures";

function has(problems: string[], words: string): boolean {
  return problems.some((p) => p.includes(words));
}

describe("validateSpreadsheet", () => {
  test("what the app writes is in shape", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 0, col: 0 }, [[1, "x", true, "=SUM(A1:A3)", "12,5%"]], PT, LOCAL);
    formatRange(doc, range(sheet, "A1:C3"), { b: 1, fc: "#cf222e", nf: "0.00", fs: 12, ha: "c", va: "m", w: 1 }, LOCAL);
    borderRange(doc, range(sheet, "A1:C3"), "outer", { w: 2, c: "#333333" }, LOCAL);
    mergeRange(doc, range(sheet, "E5:F6"), LOCAL);
    setColWidth(doc, sheet, 2, 180, LOCAL);
    setFrozen(doc, sheet, 1, 1, LOCAL);
    setSheetTab(doc, sheet, "#1a7f37", LOCAL);
    duplicateSheet(doc, sheet, "Copy", LOCAL);
    addSheet(doc, "Other", LOCAL);
    deleteRows(doc, sheet, 0, 1, LOCAL);
    expect(validateSpreadsheet(doc)).toEqual([]);
  });

  test("a document without sheets", () => {
    expect(validateSpreadsheet(new Y.Doc())).toEqual(["The spreadsheet has no sheets"]);
  });

  test("parts out of shape are named", () => {
    const { doc, sheet } = sheetDoc();
    const map = sheetMap(doc, sheet) as Y.Map<unknown>;
    const cells = map.get("cells") as Y.Map<unknown>;
    const rows = rowIds(doc, sheet);
    const cols = colIds(doc, sheet);
    doc.transact(() => {
      doc.getMap("sheets").set("junk", "not a sheet");
      doc.getArray<unknown>("sheetOrder").push([42]);
      cells.set("not-a-key", { v: 1 });
      cells.set(cellKey(rows[0] as string, cols[0] as string), { v: 1, extra: true });
      cells.set(cellKey(rows[1] as string, cols[0] as string), { s: { b: 2 } });
      map.set("frozen", { rows: -1, cols: 0 });
      map.set("tab", "green");
      (map.get("merges") as Y.Map<unknown>).set("m", { r1: 1 });
      (map.get("colWidths") as Y.Map<unknown>).set(cols[0] as string, "wide");
      (map.get("rows") as Y.Array<string>).push([rows[0] as string]);
      map.set("cols", new Y.Array());
    });
    const problems = validateSpreadsheet(doc);
    expect(has(problems, "The sheet order holds something that isn't a sheet id")).toBe(true);
    expect(has(problems, "Sheet junk isn't a map")).toBe(true);
    expect(has(problems, 'Sheet "Sheet 1": its rows repeat an id')).toBe(true);
    expect(has(problems, 'Sheet "Sheet 1": it has no columns')).toBe(true);
    expect(has(problems, 'Sheet "Sheet 1": 3 cells out of shape')).toBe(true);
    expect(has(problems, "its column widths hold something that isn't a size")).toBe(true);
    expect(has(problems, "a merge isn't four ids")).toBe(true);
    expect(has(problems, "its frozen panes aren't two counts")).toBe(true);
    expect(has(problems, "its tab color isn't a color")).toBe(true);
  });

  test("cells out of shape, one by one", () => {
    const cases: [unknown, string][] = [
      ["text", "isn't an object"],
      [{ v: Number.POSITIVE_INFINITY }, "isn't finite"],
      [{ v: "x".repeat(LIVE_LIMITS.spreadsheet.cellChars + 1) }, "text past the limit"],
      [{ v: [1] }, "a value of no kind"],
      [{ f: "" }, "a formula that isn't text"],
      [{ f: "x".repeat(LIVE_LIMITS.spreadsheet.formulaChars + 1) }, "a formula past the limit"],
      [{ s: "bold" }, "a style that isn't an object"],
      [{ s: { glow: 1 } }, 'an unknown style "glow"'],
      [{ s: { fc: "red" } }, 'a style "fc" out of shape'],
      [{ s: { nf: "0".repeat(300) } }, "a number format past the limit"],
    ];
    for (const [raw, words] of cases) {
      const { doc, sheet } = sheetDoc();
      const cells = sheetMap(doc, sheet)?.get("cells") as Y.Map<unknown>;
      cells.set(cellKey(rowIds(doc, sheet)[0] as string, colIds(doc, sheet)[0] as string), raw);
      const problems = validateSpreadsheet(doc);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(words);
    }
  });

  test("limits", () => {
    const { doc, sheet } = sheetDoc();
    const rows = sheetMap(doc, sheet)?.get("rows") as Y.Array<string>;
    rows.push(Array.from({ length: LIVE_LIMITS.spreadsheet.rows }, (_, i) => `extra${i}`));
    doc.transact(() => {
      for (let i = 0; i < 50; i++) {
        doc.getMap("sheets").set(`s${i}`, newSheetMap(`S${i}`, 1, 1));
        doc.getArray<string>("sheetOrder").push([`s${i}`]);
      }
    });
    const problems = validateSpreadsheet(doc);
    expect(has(problems, `it has ${LIVE_LIMITS.spreadsheet.rows + 100} rows (at most 20000)`)).toBe(true);
    expect(has(problems, "The spreadsheet has 51 sheets (at most 50)")).toBe(true);
    const limits = LIVE_LIMITS.spreadsheet as { cells: number };
    const before = limits.cells;
    limits.cells = 2;
    try {
      const small = sheetDoc();
      setValues(small.doc, { sheet: small.sheet, row: 0, col: 0 }, [[1, 2]], EN, LOCAL);
      ((sheetMap(small.doc, small.sheet) as Y.Map<unknown>).get("cells") as Y.Map<unknown>).set("a:b", { v: 3 });
      expect(validateSpreadsheet(small.doc)).toEqual(["The spreadsheet has 3 cells (at most 2)"]);
    } finally {
      limits.cells = before;
    }
  });
});
