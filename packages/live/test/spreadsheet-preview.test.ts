import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { LOCAL } from "../src/origins";
import { SheetEngine } from "../src/spreadsheet/engine";
import { addSheet, formatRange, setColWidth, setValues } from "../src/spreadsheet/ops";
import { SPREADSHEET_TEXT_MAX, spreadsheetPreview, spreadsheetText } from "../src/spreadsheet/preview";
import { EN, PT, range, sheetDoc } from "./spreadsheet-fixtures";

describe("the card's preview", () => {
  test("the first sheet's top-left 12 rows by 8 columns, as they show", () => {
    const { doc, sheet } = sheetDoc("Vendas");
    addSheet(doc, "Outra", LOCAL);
    setValues(
      doc,
      { sheet, row: 0, col: 0 },
      [
        ["Item", "Qtd", "Preço", "Total"],
        ["Caneta", 3, 2.5, "=B2*C2"],
        ["Lápis", 10, "R$ 0,75", "=B3*C3"],
        [true, "=1/0", null, '=1+"x"'],
      ],
      PT,
      LOCAL,
    );
    setValues(doc, { sheet, row: 20, col: 20 }, [["far away"]], PT, LOCAL);
    formatRange(doc, range(sheet, "A1:E1"), { b: 1 }, LOCAL);
    formatRange(doc, range(sheet, "A2"), { ha: "c" }, LOCAL);
    setColWidth(doc, sheet, 0, 180, LOCAL);
    const engine = new SheetEngine(doc, { locale: PT });
    const preview = spreadsheetPreview(doc, engine, PT);
    expect(preview.sheet).toBe("Vendas");
    expect(preview.sheets).toBe(2);
    expect(preview.rows).toHaveLength(12);
    expect(preview.rows[0]).toHaveLength(8);
    expect(preview.rows.slice(0, 4).map((row) => row.slice(0, 4))).toEqual([
      ["Item", "Qtd", "Preço", "Total"],
      ["Caneta", "3", "2,5", "7,5"],
      ["Lápis", "10", "R$ 0,75", "7,5"],
      ["VERDADEIRO", "#DIV/0!", "", "#VALOR!"],
    ]);
    expect(preview.rows.flat().join("")).not.toContain("far away");
    expect(preview.widths).toEqual([180, 100, 100, 100, 100, 100, 100, 100]);
    expect(preview.bold[0]?.slice(0, 6)).toEqual([true, true, true, true, true, false]);
    expect(preview.bold[1]?.[0]).toBe(false);
    expect(preview.align?.[1]?.slice(0, 4)).toEqual(["c", "r", "r", "r"]);
    expect(preview.align?.[3]?.slice(0, 2)).toEqual(["c", "c"]);
    expect(preview.align?.[0]?.[0]).toBe("l");
    engine.destroy();
  });

  test("a small sheet gives what it has; a document without sheets an empty preview", () => {
    const { doc } = sheetDoc();
    addSheet(doc, "Tiny", LOCAL, { rows: 2, cols: 3, at: 0 });
    const engine = new SheetEngine(doc);
    const preview = spreadsheetPreview(doc, engine, EN);
    expect(preview.sheet).toBe("Tiny");
    expect(preview.rows).toEqual([
      ["", "", ""],
      ["", "", ""],
    ]);
    expect(preview.widths).toEqual([100, 100, 100]);
    engine.destroy();
    const empty = new Y.Doc();
    const none = new SheetEngine(empty);
    expect(spreadsheetPreview(empty, none, EN)).toEqual({
      sheet: "",
      sheets: 0,
      rows: [],
      widths: [],
      bold: [],
      align: [],
    });
    none.destroy();
  });

  test("long text is cut", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 0, col: 0 }, [["y".repeat(500)]], EN, LOCAL);
    const engine = new SheetEngine(doc);
    expect(spreadsheetPreview(doc, engine, EN).rows[0]?.[0]).toHaveLength(64);
    engine.destroy();
  });
});

describe("the search text", () => {
  test("sheet names, then each row's cells as they show", () => {
    const { doc, sheet } = sheetDoc("Sales");
    const rates = addSheet(doc, "Rates", LOCAL);
    setValues(
      doc,
      { sheet, row: 0, col: 0 },
      [
        ["Item", "Qty"],
        ["Pen", 3, "=B2*2"],
      ],
      EN,
      LOCAL,
    );
    setValues(doc, { sheet, row: 5, col: 1 }, [["later"]], EN, LOCAL);
    formatRange(doc, range(sheet, "E9"), { b: 1 }, LOCAL);
    setValues(doc, { sheet: rates, row: 0, col: 0 }, [[2.5]], EN, LOCAL);
    const engine = new SheetEngine(doc);
    expect(spreadsheetText(doc, engine)).toBe("Sales\nItem\tQty\nPen\t3\t6\nlater\nRates\n2.5");
    engine.destroy();
  });

  test("stops at 20,000 characters", () => {
    const { doc, sheet } = sheetDoc();
    setValues(
      doc,
      { sheet, row: 0, col: 0 },
      Array.from({ length: 100 }, (_, r) => Array.from({ length: 5 }, (_, c) => `cell ${r}-${c} ${"z".repeat(40)}`)),
      EN,
      LOCAL,
    );
    const engine = new SheetEngine(doc);
    const text = spreadsheetText(doc, engine);
    expect(text.length).toBeLessThanOrEqual(SPREADSHEET_TEXT_MAX);
    expect(text.length).toBeGreaterThan(SPREADSHEET_TEXT_MAX - 300);
    expect(text.startsWith("Sheet 1\ncell 0-0 ")).toBe(true);
    engine.destroy();
  });
});
