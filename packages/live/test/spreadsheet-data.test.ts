import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { LOCAL, SYSTEM } from "../src/origins";
import { sheetToData, spreadsheetFromData, spreadsheetToData, type WorkbookData } from "../src/spreadsheet/data";
import {
  colWidths,
  frozenOf,
  readMerges,
  rowHeights,
  SheetError,
  sheetIds,
  sheetName,
  sheetSize,
  sheetTabColor,
} from "../src/spreadsheet/doc";
import { SheetEngine } from "../src/spreadsheet/engine";
import { formatRange, mergeRange, setColWidth, setFrozen, setSheetTab, setValues } from "../src/spreadsheet/ops";
import { cell, cells, EN, range, sheetDoc } from "./spreadsheet-fixtures";

const WORKBOOK: WorkbookData = {
  sheets: [
    {
      name: "Sales",
      rows: 5,
      cols: 3,
      cells: [
        { r: 0, c: 0, v: "Item", s: { b: 1 } },
        { r: 0, c: 1, v: "Qty" },
        { r: 1, c: 0, v: "Pen" },
        { r: 1, c: 1, v: 3 },
        { r: 1, c: 2, f: "B2*Rates!A1", v: 7.5, t: "7.50" },
        { r: 2, c: 1, f: "SUM(B2:B2)", v: 3 },
        { r: 2, c: 2, e: "#N/A" },
        { r: 2, c: 0, f: "Table1[Qty]", v: 99 },
        { r: 3, c: 0, f: "=Unknown!A1", e: "#REF!" },
        { r: 3, c: 1, v: "x".repeat(40_000) },
        { r: 3, c: 2, s: { bg: "#fff2cc" } },
      ],
      colWidths: { 0: 160, 1: 100 },
      rowHeights: { 0: 32 },
      merges: [{ r1: 4, c1: 0, r2: 4, c2: 2 }],
      frozen: { rows: 1, cols: 0 },
      tab: "#1a7f37",
    },
    { name: "Rates", rows: 1, cols: 1, cells: [{ r: 0, c: 0, v: 2.5 }] },
    { name: "rates", rows: 1, cols: 1, cells: [] },
    { name: "  ", rows: 1, cols: 1, cells: [] },
  ],
};

describe("a workbook into a spreadsheet", () => {
  test("sheets, values, formulas, formats and layout", () => {
    const { doc } = sheetDoc("Old");
    spreadsheetFromData(doc, WORKBOOK, SYSTEM);
    const ids = sheetIds(doc);
    expect(ids.map((id) => sheetName(doc, id))).toEqual(["Sales", "Rates", "rates (2)", "Sheet 4"]);
    const sales = ids[0] as string;
    expect(sheetSize(doc, sales)).toEqual({ rows: 100, cols: 26 });
    expect(cells(doc, sales, "A1:C3")).toEqual([
      ["Item", "Qty", ""],
      ["Pen", "3", "=B2*Rates!A1"],
      ["99", "=SUM(B2:B2)", "=#N/A"],
    ]);
    expect(cell(doc, sales, "A4")).toBe("=#REF!");
    expect(cell(doc, sales, "B4")).toHaveLength(32_000);
    const engine = new SheetEngine(doc);
    expect(engine.valueAt(sales, 1, 2)).toBe(7.5);
    expect(engine.valueAt(sales, 2, 1)).toBe(3);
    expect(engine.valueAt(sales, 2, 2)).toEqual({ error: "#N/A" });
    engine.destroy();
    expect(colWidths(doc, sales).slice(0, 2)).toEqual([160, 100]);
    expect(rowHeights(doc, sales)[0]).toBe(32);
    expect(readMerges(doc, sales).map(({ r1, c1, r2, c2 }) => [r1, c1, r2, c2])).toEqual([[4, 0, 4, 2]]);
    expect(frozenOf(doc, sales)).toEqual({ rows: 1, cols: 0 });
    expect(sheetTabColor(doc, sales)).toBe("#1a7f37");
  });

  test("formulas pointing past a sheet's end grow it", () => {
    const { doc } = sheetDoc();
    spreadsheetFromData(
      doc,
      { sheets: [{ name: "S", rows: 2, cols: 2, cells: [{ r: 0, c: 0, f: "A500+AB1" }] }] },
      SYSTEM,
    );
    const sheet = sheetIds(doc)[0] as string;
    expect(sheetSize(doc, sheet)).toEqual({ rows: 500, cols: 28 });
    expect(cell(doc, sheet, "A1")).toBe("=A500+AB1");
  });

  test("an empty workbook gives one empty sheet", () => {
    const { doc } = sheetDoc();
    spreadsheetFromData(doc, { sheets: [] }, SYSTEM);
    expect(sheetIds(doc).map((id) => sheetName(doc, id))).toEqual(["Sheet 1"]);
  });

  test("a workbook past the limits changes nothing", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 0, col: 0 }, [["keep"]], EN, LOCAL);
    const many: WorkbookData = {
      sheets: Array.from({ length: 51 }, (_, i) => ({ name: `S${i}`, rows: 1, cols: 1, cells: [] })),
    };
    const far: WorkbookData = { sheets: [{ name: "Far", rows: 1, cols: 1, cells: [{ r: 20_000, c: 0, v: 1 }] }] };
    for (const data of [many, far]) {
      let error: unknown;
      try {
        spreadsheetFromData(doc, data, SYSTEM);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(SheetError);
      expect((error as SheetError).reason).toBe("limit");
      expect(sheetIds(doc)).toEqual([sheet]);
      expect(cell(doc, sheet, "A1")).toBe("keep");
    }
  });
});

describe("a spreadsheet as a workbook", () => {
  test("formulas in English A1, computed values, what each cell shows, and the layout", () => {
    const { doc, sheet } = sheetDoc("Vendas");
    setValues(
      doc,
      { sheet, row: 0, col: 0 },
      [
        [1234.5, "=A1*2", "=1/0", "=#N/A"],
        ["text", true, null, '=IF(B2,"yes","no")'],
      ],
      EN,
      LOCAL,
    );
    formatRange(doc, range(sheet, "A1"), { nf: "#,##0.00" }, LOCAL);
    formatRange(doc, range(sheet, "C2"), { b: 1 }, LOCAL);
    mergeRange(doc, range(sheet, "A3:B3"), LOCAL);
    setColWidth(doc, sheet, 1, 140, LOCAL);
    setFrozen(doc, sheet, 1, 1, LOCAL);
    setSheetTab(doc, sheet, "#0b6bcb", LOCAL);
    const engine = new SheetEngine(doc);
    const data = sheetToData(doc, sheet, engine);
    expect(data.name).toBe("Vendas");
    expect(data.rows).toBe(100);
    expect(data.cols).toBe(26);
    expect(data.cells).toEqual([
      { r: 0, c: 0, v: 1234.5, s: { nf: "#,##0.00" }, t: "1,234.50" },
      { r: 0, c: 1, f: "A1*2", v: 2469, t: "2469" },
      { r: 0, c: 2, f: "1/0", e: "#DIV/0!", t: "#DIV/0!" },
      { r: 0, c: 3, e: "#N/A", t: "#N/A" },
      { r: 1, c: 0, v: "text", t: "text" },
      { r: 1, c: 1, v: true, t: "TRUE" },
      { r: 1, c: 2, s: { b: 1 } },
      { r: 1, c: 3, f: 'IF(B2,"yes","no")', v: "yes", t: "yes" },
    ]);
    expect(data.colWidths).toEqual({ 1: 140 });
    expect(data.rowHeights).toBeUndefined();
    expect(data.merges).toEqual([{ r1: 2, c1: 0, r2: 2, c2: 1 }]);
    expect(data.frozen).toEqual({ rows: 1, cols: 1 });
    expect(data.tab).toBe("#0b6bcb");
    engine.destroy();
  });

  test("a round trip keeps what every cell shows", () => {
    const first = new Y.Doc();
    spreadsheetFromData(first, WORKBOOK, SYSTEM);
    const engine = new SheetEngine(first);
    const data = spreadsheetToData(first, engine);
    expect(data.sheets.map((s) => s.name)).toEqual(["Sales", "Rates", "rates (2)", "Sheet 4"]);
    const second = new Y.Doc();
    spreadsheetFromData(second, data, SYSTEM);
    const again = new SheetEngine(second);
    const shown = (doc: Y.Doc, e: SheetEngine) =>
      sheetIds(doc).map((id) =>
        Array.from({ length: 5 }, (_, r) =>
          Array.from({ length: 3 }, (_, c) => {
            const rowId = e.rowIdAt(id, r);
            const colId = e.colIdAt(id, c);
            return rowId && colId ? e.display(id, rowId, colId, EN) : "";
          }),
        ),
      );
    expect(shown(second, again)).toEqual(shown(first, engine));
    expect(spreadsheetToData(second, again)).toEqual(data);
    engine.destroy();
    again.destroy();
  });
});
