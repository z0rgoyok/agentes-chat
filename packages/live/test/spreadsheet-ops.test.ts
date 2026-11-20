import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { LIVE_LIMITS } from "../src/limits";
import { agentOrigin, LOCAL } from "../src/origins";
import {
  cellCount,
  colWidths,
  frozenOf,
  getCell,
  nextSheetName,
  readMerges,
  rowHeights,
  rowIds,
  SheetError,
  sheetIds,
  sheetName,
  sheetSize,
  sheetTabColor,
  sizeMap,
} from "../src/spreadsheet/doc";
import { SheetEngine } from "../src/spreadsheet/engine";
import {
  addSheet,
  borderRange,
  clearRange,
  compareCells,
  deleteCols,
  deleteRows,
  deleteSheet,
  duplicateSheet,
  ensureSize,
  formatRange,
  insertCols,
  insertRows,
  mergeRange,
  moveSheet,
  renameSheet,
  setColWidth,
  setFrozen,
  setInput,
  setRowHeight,
  setSheetTab,
  setValues,
  sortRange,
  unmergeRange,
} from "../src/spreadsheet/ops";
import { cell, cells, EN, PT, range, sheetDoc, storedValues } from "./spreadsheet-fixtures";

function reason(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof SheetError) return e.reason;
    throw e;
  }
}

describe("sheets", () => {
  test("add, rename, move, color and delete", () => {
    const { doc, sheet } = sheetDoc();
    const sales = addSheet(doc, "  Vendas: 2026?  ", LOCAL);
    expect(sheetName(doc, sales)).toBe("Vendas 2026");
    expect(sheetSize(doc, sales)).toEqual({ rows: 100, cols: 26 });
    const small = addSheet(doc, "Small", LOCAL, { rows: 5, cols: 3, at: 0 });
    expect(sheetIds(doc)).toEqual([small, sheet, sales]);
    expect(sheetSize(doc, small)).toEqual({ rows: 5, cols: 3 });
    expect(reason(() => addSheet(doc, "sheet 1", LOCAL))).toBe("sheet_name_taken");
    expect(reason(() => addSheet(doc, " :? ", LOCAL))).toBe("sheet_name");
    expect(reason(() => addSheet(doc, "Huge", LOCAL, { rows: 20001 }))).toBe("limit");
    renameSheet(doc, sales, "Receita", LOCAL);
    expect(sheetName(doc, sales)).toBe("Receita");
    expect(reason(() => renameSheet(doc, sales, "SMALL", LOCAL))).toBe("sheet_name_taken");
    renameSheet(doc, sales, "receita", LOCAL);
    expect(sheetName(doc, sales)).toBe("receita");
    moveSheet(doc, sales, 0, LOCAL);
    expect(sheetIds(doc)).toEqual([sales, small, sheet]);
    moveSheet(doc, sales, 99, LOCAL);
    expect(sheetIds(doc)).toEqual([small, sheet, sales]);
    setSheetTab(doc, sales, "#1a7f37", LOCAL);
    expect(sheetTabColor(doc, sales)).toBe("#1a7f37");
    expect(reason(() => setSheetTab(doc, sales, "red", LOCAL))).toBe("value");
    setSheetTab(doc, sales, null, LOCAL);
    expect(sheetTabColor(doc, sales)).toBeUndefined();
    expect(nextSheetName(doc, "Planilha")).toBe("Planilha 4");
    deleteSheet(doc, small, LOCAL);
    deleteSheet(doc, sales, LOCAL);
    expect(sheetIds(doc)).toEqual([sheet]);
    expect(reason(() => deleteSheet(doc, sheet, LOCAL))).toBe("last_sheet");
    expect(reason(() => renameSheet(doc, "nope", "x", LOCAL))).toBe("no_sheet");
  });

  test("a spreadsheet holds at most 50 sheets", () => {
    const { doc } = sheetDoc();
    for (let i = 2; i <= 50; i++) addSheet(doc, `S${i}`, LOCAL, { rows: 1, cols: 1 });
    expect(sheetIds(doc)).toHaveLength(50);
    expect(reason(() => addSheet(doc, "One more", LOCAL))).toBe("limit");
  });

  test("a copy's formulas point at its own cells", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 0, col: 0 }, [[5, "=A1*2", "='Sheet 1'!A1+1"]], EN, LOCAL);
    mergeRange(doc, range(sheet, "A3:B3"), LOCAL);
    setColWidth(doc, sheet, 1, 150, LOCAL);
    setFrozen(doc, sheet, 1, 0, LOCAL);
    const copy = duplicateSheet(doc, sheet, "Copy", LOCAL);
    expect(sheetIds(doc)).toEqual([sheet, copy]);
    expect(cells(doc, copy, "A1:C1")).toEqual([["5", "=A1*2", "=Copy!A1+1"]]);
    expect(cells(doc, sheet, "A1:C1")).toEqual([["5", "=A1*2", "='Sheet 1'!A1+1"]]);
    expect(readMerges(doc, copy).map(({ r1, c1, r2, c2 }) => [r1, c1, r2, c2])).toEqual([[2, 0, 2, 1]]);
    expect(frozenOf(doc, copy)).toEqual({ rows: 1, cols: 0 });
    setInput(doc, { sheet: copy, row: 0, col: 0 }, "7", EN, LOCAL);
    expect(cell(doc, sheet, "A1")).toBe("5");
    expect(cell(doc, copy, "A1")).toBe("7");
    const again = duplicateSheet(doc, sheet, "", LOCAL);
    expect(sheetName(doc, again)).toBe("Sheet 1 (2)");
    expect(reason(() => duplicateSheet(doc, sheet, "copy", LOCAL))).toBe("sheet_name_taken");
  });
});

describe("typing into cells", () => {
  test("values in the person's locale, with the formats they imply", () => {
    const { doc, sheet } = sheetDoc();
    expect(setInput(doc, { sheet, row: 0, col: 0 }, "1.234,5", PT, LOCAL)).toEqual({ ok: true });
    expect(getCell(doc, sheet, 0, 0)).toEqual({ v: 1234.5, s: { nf: "#,##0.00" } });
    setInput(doc, { sheet, row: 1, col: 0 }, "12,5%", PT, LOCAL);
    expect(getCell(doc, sheet, 1, 0)).toEqual({ v: 0.125, s: { nf: "0.00%" } });
    setInput(doc, { sheet, row: 2, col: 0 }, "17/11/2026", PT, LOCAL);
    expect(getCell(doc, sheet, 2, 0)).toEqual({ v: 46343, s: { nf: "dd/mm/yyyy" } });
    setInput(doc, { sheet, row: 3, col: 0 }, "VERDADEIRO", PT, LOCAL);
    expect(getCell(doc, sheet, 3, 0)).toEqual({ v: true });
    setInput(doc, { sheet, row: 4, col: 0 }, "'00123", PT, LOCAL);
    expect(getCell(doc, sheet, 4, 0)).toEqual({ v: "00123" });
    setInput(doc, { sheet, row: 4, col: 0 }, "", PT, LOCAL);
    expect(getCell(doc, sheet, 4, 0)).toBeUndefined();
  });

  test("a number typed into a formatted cell keeps the format", () => {
    const { doc, sheet } = sheetDoc();
    formatRange(doc, range(sheet, "A1"), { nf: '"R$" #,##0.00', b: 1 }, LOCAL);
    setInput(doc, { sheet, row: 0, col: 0 }, "10", PT, LOCAL);
    expect(getCell(doc, sheet, 0, 0)).toEqual({ v: 10, s: { nf: '"R$" #,##0.00', b: 1 } });
    setInput(doc, { sheet, row: 0, col: 0 }, "15%", PT, LOCAL);
    expect(getCell(doc, sheet, 0, 0)).toEqual({ v: 0.15, s: { nf: "0%", b: 1 } });
  });

  test("in a cell formatted as a percentage, a person's 10 is 10%, as in Excel", () => {
    const { doc, sheet } = sheetDoc();
    formatRange(doc, range(sheet, "A1:A5"), { nf: "0.00%" }, LOCAL);
    setInput(doc, { sheet, row: 0, col: 0 }, "10", PT, LOCAL);
    setInput(doc, { sheet, row: 1, col: 0 }, "0,25", PT, LOCAL);
    setInput(doc, { sheet, row: 2, col: 0 }, "-150", EN, LOCAL);
    setInput(doc, { sheet, row: 3, col: 0 }, "7%", EN, LOCAL);
    expect(cells(doc, sheet, "A1:A4").map((r) => r[0])).toEqual(["0.1", "0.25", "-1.5", "0.07"]);
    expect(getCell(doc, sheet, 0, 0)).toEqual({ v: 0.1, s: { nf: "0.00%" } });
    // An agent's block keeps its numbers as given.
    setValues(doc, { sheet, row: 4, col: 0 }, [["10"]], EN, LOCAL);
    expect(getCell(doc, sheet, 4, 0)).toEqual({ v: 10, s: { nf: "0.00%" } });
  });

  test("a cell formatted as text keeps what is typed as text", () => {
    const { doc, sheet } = sheetDoc();
    formatRange(doc, range(sheet, "A1"), { nf: "@" }, LOCAL);
    setInput(doc, { sheet, row: 0, col: 0 }, "00123", EN, LOCAL);
    expect(getCell(doc, sheet, 0, 0)).toEqual({ v: "00123", s: { nf: "@" } });
    setInput(doc, { sheet, row: 0, col: 0 }, "=1+1", EN, LOCAL);
    expect(getCell(doc, sheet, 0, 0)).toEqual({ v: "=1+1", s: { nf: "@" } });
  });

  test("formulas in Portuguese are stored by ids and read in any language", () => {
    const { doc, sheet } = sheetDoc();
    setInput(doc, { sheet, row: 0, col: 0 }, "1", PT, LOCAL);
    setInput(doc, { sheet, row: 1, col: 0 }, "2,5", PT, LOCAL);
    expect(setInput(doc, { sheet, row: 2, col: 0 }, "=SOMA(A1:A2;10)", PT, LOCAL)).toEqual({ ok: true });
    const stored = getCell(doc, sheet, 2, 0)?.f ?? "";
    expect(stored.startsWith("SUM({")).toBe(true);
    expect(stored).not.toContain("A1");
    expect(cell(doc, sheet, "A3")).toBe("=SUM(A1:A2,10)");
    expect(setInput(doc, { sheet, row: 3, col: 0 }, "=SUM(A1,A2)", EN, LOCAL)).toEqual({ ok: true });
    expect(cell(doc, sheet, "A4")).toBe("=SUM(A1,A2)");
  });

  test("a formula that can't be read changes nothing and says why", () => {
    const { doc, sheet } = sheetDoc();
    setInput(doc, { sheet, row: 0, col: 0 }, "5", EN, LOCAL);
    const result = setInput(doc, { sheet, row: 0, col: 0 }, "=SUM(A1", EN, LOCAL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unclosed_paren");
    expect(getCell(doc, sheet, 0, 0)).toEqual({ v: 5 });
  });

  test("dates from formulas get a date format", () => {
    const { doc, sheet } = sheetDoc();
    setInput(doc, { sheet, row: 0, col: 0 }, "=HOJE()", PT, LOCAL);
    expect(getCell(doc, sheet, 0, 0)?.s).toEqual({ nf: "dd/mm/yyyy" });
    setInput(doc, { sheet, row: 1, col: 0 }, "=NOW()", EN, LOCAL);
    expect(getCell(doc, sheet, 1, 0)?.s).toEqual({ nf: "m/d/yyyy h:mm" });
    setInput(doc, { sheet, row: 2, col: 0 }, "=SUM(1,2)", EN, LOCAL);
    expect(getCell(doc, sheet, 2, 0)?.s).toBeUndefined();
  });

  test("the sheet grows to the cell and to what a formula points at", () => {
    const { doc, sheet } = sheetDoc();
    setInput(doc, { sheet, row: 149, col: 0 }, "x", EN, LOCAL);
    expect(sheetSize(doc, sheet).rows).toBe(150);
    setInput(doc, { sheet, row: 0, col: 1 }, "=A500+AB1", EN, LOCAL);
    expect(sheetSize(doc, sheet)).toEqual({ rows: 500, cols: 28 });
    expect(cell(doc, sheet, "B1")).toBe("=A500+AB1");
    expect(reason(() => setInput(doc, { sheet, row: 20000, col: 0 }, "x", EN, LOCAL))).toBe("limit");
  });

  test("text past the limit is refused", () => {
    const { doc, sheet } = sheetDoc();
    const long = "x".repeat(LIVE_LIMITS.spreadsheet.cellChars + 1);
    expect(reason(() => setInput(doc, { sheet, row: 0, col: 0 }, long, EN, LOCAL))).toBe("text_too_long");
    expect(getCell(doc, sheet, 0, 0)).toBeUndefined();
  });

  test("an agent's block of values, formulas in English", () => {
    const { doc, sheet } = sheetDoc();
    setValues(
      doc,
      { sheet, row: 0, col: 0 },
      [
        ["Fruit", "Qty", "Price", null, "Total"],
        ["Apple", 3, "$1.50", null, "=B2*C2"],
        ["Pear", "2", "1,234.5", true, "=SUM(B2:B3)"],
      ],
      EN,
      agentOrigin("ag1", "run1"),
    );
    expect(cells(doc, sheet, "A1:C3")).toEqual([
      ["Fruit", "Qty", "Price"],
      ["Apple", "3", "1.5"],
      ["Pear", "2", "1234.5"],
    ]);
    expect(cells(doc, sheet, "E2:E3")).toEqual([["=B2*C2"], ["=SUM(B2:B3)"]]);
    expect(getCell(doc, sheet, 1, 2)).toEqual({ v: 1.5, s: { nf: "$#,##0.00" } });
    expect(getCell(doc, sheet, 2, 3)).toEqual({ v: true });
    expect(getCell(doc, sheet, 1, 3)).toBeUndefined();
  });

  test("null empties a cell but keeps its format; short rows leave the rest alone", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 0, col: 0 }, [[1, 2, 3]], EN, LOCAL);
    formatRange(doc, range(sheet, "A1"), { b: 1 }, LOCAL);
    setValues(doc, { sheet, row: 0, col: 0 }, [[null, 9]], EN, LOCAL);
    expect(getCell(doc, sheet, 0, 0)).toEqual({ s: { b: 1 } });
    expect(cells(doc, sheet, "A1:C1")).toEqual([["", "9", "3"]]);
  });

  test("a block with formulas that can't be read writes nothing and names the cells", () => {
    const { doc, sheet } = sheetDoc();
    let error: unknown;
    try {
      setValues(
        doc,
        { sheet, row: 1, col: 1 },
        [
          ["ok", "=SUM("],
          ["=1+", 5],
        ],
        EN,
        LOCAL,
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SheetError);
    const sheetError = error as SheetError;
    expect(sheetError.reason).toBe("formula");
    expect(sheetError.code).toBe("invalid");
    expect(sheetError.details?.map((d) => d.cell)).toEqual(["C2", "B3"]);
    expect(cellCount(doc)).toBe(0);
    expect(reason(() => setValues(doc, { sheet, row: 0, col: 0 }, [[Number.NaN]], EN, LOCAL))).toBe("value");
  });
});

describe("clearing and formatting", () => {
  test("clear all, contents or formats", () => {
    const { doc, sheet } = sheetDoc();
    setValues(
      doc,
      { sheet, row: 0, col: 0 },
      [
        [1, 2],
        [3, 4],
      ],
      EN,
      LOCAL,
    );
    formatRange(doc, range(sheet, "A1:B2"), { b: 1, fc: "#cf222e" }, LOCAL);
    mergeRange(doc, range(sheet, "A1:B1"), LOCAL);
    clearRange(doc, range(sheet, "A2"), "contents", LOCAL);
    expect(getCell(doc, sheet, 1, 0)).toEqual({ s: { b: 1, fc: "#cf222e" } });
    clearRange(doc, range(sheet, "B2"), "formats", LOCAL);
    expect(getCell(doc, sheet, 1, 1)).toEqual({ v: 4 });
    clearRange(doc, range(sheet, "A1:B1"), "all", LOCAL);
    expect(getCell(doc, sheet, 0, 0)).toBeUndefined();
    expect(readMerges(doc, sheet)).toEqual([]);
  });

  test("a style patch adds and removes, and whole columns stop at the sheet's end", () => {
    const { doc, sheet } = sheetDoc();
    formatRange(doc, range(sheet, "B:B"), { b: 1, ha: "c" }, LOCAL);
    expect(cellCount(doc)).toBe(100);
    formatRange(doc, range(sheet, "B1:B2"), { b: undefined, i: 1 }, LOCAL);
    expect(getCell(doc, sheet, 0, 1)).toEqual({ s: { ha: "c", i: 1 } });
    formatRange(doc, range(sheet, "B1"), { nf: "General", fs: 14 }, LOCAL);
    expect(getCell(doc, sheet, 0, 1)).toEqual({ s: { ha: "c", i: 1, fs: 14 } });
    formatRange(doc, range(sheet, "B:B"), { clear: true }, LOCAL);
    expect(cellCount(doc)).toBe(0);
    expect(reason(() => formatRange(doc, range(sheet, "A1"), { fc: "red" }, LOCAL))).toBe("value");
    expect(reason(() => formatRange(doc, range(sheet, "A1"), { fs: 200 }, LOCAL))).toBe("value");
    expect(reason(() => formatRange(doc, range(sheet, "A1"), { ha: "x" as "l" }, LOCAL))).toBe("value");
    expect(cellCount(doc)).toBe(0);
  });

  test("borders: the outline, the inside, and none", () => {
    const { doc, sheet } = sheetDoc();
    borderRange(doc, range(sheet, "B2:C3"), "outer", { w: 2 }, LOCAL);
    expect(getCell(doc, sheet, 1, 1)?.s?.bd).toEqual({ t: { w: 2 }, l: { w: 2 } });
    expect(getCell(doc, sheet, 2, 2)?.s?.bd).toEqual({ b: { w: 2 }, r: { w: 2 } });
    borderRange(doc, range(sheet, "B2:C3"), "inner", { w: 1, c: "#888888" }, LOCAL);
    const thin = { w: 1 as const, c: "#888888" };
    expect(getCell(doc, sheet, 1, 1)?.s?.bd).toEqual({ t: { w: 2 }, l: { w: 2 }, b: thin, r: thin });
    borderRange(doc, range(sheet, "B2:C3"), "outer", null, LOCAL);
    expect(getCell(doc, sheet, 1, 1)?.s?.bd).toEqual({ b: thin, r: thin });
    borderRange(doc, range(sheet, "A1:E5"), "all", { w: 1 }, LOCAL);
    borderRange(doc, range(sheet, "B2:C3"), "none", null, LOCAL);
    expect(getCell(doc, sheet, 1, 1)?.s).toBeUndefined();
    expect(getCell(doc, sheet, 0, 1)?.s?.bd).toEqual({ t: { w: 1 }, r: { w: 1 }, l: { w: 1 } });
    expect(getCell(doc, sheet, 1, 0)?.s?.bd).toEqual({ t: { w: 1 }, b: { w: 1 }, l: { w: 1 } });
  });
});

describe("merges and frozen panes", () => {
  test("merging keeps the top-left value and takes in overlapping merges", () => {
    const { doc, sheet } = sheetDoc();
    setValues(
      doc,
      { sheet, row: 0, col: 0 },
      [
        ["a", "b"],
        ["c", "x"],
      ],
      EN,
      LOCAL,
    );
    formatRange(doc, range(sheet, "B1"), { b: 1 }, LOCAL);
    mergeRange(doc, range(sheet, "A1:B2"), LOCAL);
    expect(cells(doc, sheet, "A1:B2")).toEqual([
      ["a", ""],
      ["", ""],
    ]);
    expect(getCell(doc, sheet, 0, 1)).toEqual({ s: { b: 1 } });
    mergeRange(doc, range(sheet, "B2:C3"), LOCAL);
    expect(readMerges(doc, sheet).map(({ r1, c1, r2, c2 }) => [r1, c1, r2, c2])).toEqual([[1, 1, 2, 2]]);
    unmergeRange(doc, range(sheet, "C3"), LOCAL);
    expect(readMerges(doc, sheet)).toEqual([]);
  });

  test("frozen panes stay within the sheet", () => {
    const { doc, sheet } = sheetDoc();
    setFrozen(doc, sheet, 2, 1, LOCAL);
    expect(frozenOf(doc, sheet)).toEqual({ rows: 2, cols: 1 });
    setFrozen(doc, sheet, 500, 0, LOCAL);
    expect(frozenOf(doc, sheet)).toEqual({ rows: 100, cols: 0 });
    expect(reason(() => setFrozen(doc, sheet, -1, 0, LOCAL))).toBe("range");
  });
});

describe("rows and columns", () => {
  test("inserted rows move cells, merges and formulas with their rows", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 0, col: 0 }, [[1], [2], [3]], EN, LOCAL);
    setInput(doc, { sheet, row: 0, col: 2 }, "=SUM(A1:A3)", EN, LOCAL);
    mergeRange(doc, range(sheet, "E2:F3"), LOCAL);
    setFrozen(doc, sheet, 2, 0, LOCAL);
    insertRows(doc, sheet, 1, 2, LOCAL);
    expect(cells(doc, sheet, "A1:A5")).toEqual([["1"], [""], [""], ["2"], ["3"]]);
    expect(cell(doc, sheet, "C1")).toBe("=SUM(A1:A5)");
    expect(readMerges(doc, sheet).map(({ r1, c1, r2, c2 }) => [r1, c1, r2, c2])).toEqual([[3, 4, 4, 5]]);
    expect(frozenOf(doc, sheet)).toEqual({ rows: 4, cols: 0 });
    expect(sheetSize(doc, sheet).rows).toBe(102);
    insertRows(doc, sheet, 102, 1, LOCAL);
    expect(sheetSize(doc, sheet).rows).toBe(103);
    expect(reason(() => insertRows(doc, sheet, 104, 1, LOCAL))).toBe("range");
    expect(reason(() => insertRows(doc, sheet, 0, 20000, LOCAL))).toBe("limit");
    expect(sheetSize(doc, sheet).rows).toBe(103);
  });

  test("a merge grows with rows inserted inside it", () => {
    const { doc, sheet } = sheetDoc();
    mergeRange(doc, range(sheet, "A2:B4"), LOCAL);
    insertRows(doc, sheet, 2, 1, LOCAL);
    expect(readMerges(doc, sheet).map(({ r1, r2 }) => [r1, r2])).toEqual([[1, 4]]);
  });

  test("deleted rows take their cells, sizes and merge edges, and pull range edges in", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 0, col: 0 }, [[1], [2], [3], [4], [5]], EN, LOCAL);
    setInput(doc, { sheet, row: 9, col: 2 }, "=SUM(A1:A5)", EN, LOCAL);
    setInput(doc, { sheet, row: 10, col: 2 }, "=A1*2", EN, LOCAL);
    setInput(doc, { sheet, row: 11, col: 2 }, "=SUM(A2:A3)", EN, LOCAL);
    setRowHeight(doc, sheet, 0, 40, LOCAL);
    mergeRange(doc, range(sheet, "E1:F3"), LOCAL);
    setFrozen(doc, sheet, 3, 0, LOCAL);
    const firstRow = rowIds(doc, sheet)[0] as string;
    deleteRows(doc, sheet, 0, 1, LOCAL);
    expect(cells(doc, sheet, "A1:A4")).toEqual([["2"], ["3"], ["4"], ["5"]]);
    expect(cell(doc, sheet, "C9")).toBe("=SUM(A1:A4)");
    expect(cell(doc, sheet, "C10")).toBe("=#REF!*2");
    expect(cell(doc, sheet, "C11")).toBe("=SUM(A1:A2)");
    expect(sizeMap(doc, sheet, "rowHeights")?.has(firstRow)).toBe(false);
    expect(rowHeights(doc, sheet)[0]).toBe(24);
    expect(readMerges(doc, sheet).map(({ r1, c1, r2, c2 }) => [r1, c1, r2, c2])).toEqual([[0, 4, 1, 5]]);
    expect(frozenOf(doc, sheet)).toEqual({ rows: 2, cols: 0 });
    deleteRows(doc, sheet, 0, 2, LOCAL);
    expect(readMerges(doc, sheet)).toEqual([]);
    expect(cells(doc, sheet, "C7:C9")).toEqual([["=SUM(A1:A2)"], ["=#REF!*2"], ["=SUM(#REF!)"]]);
    expect(sheetSize(doc, sheet).rows).toBe(97);
  });

  test("a sheet keeps at least one row and one column", () => {
    const { doc, sheet } = sheetDoc();
    expect(reason(() => deleteRows(doc, sheet, 0, 100, LOCAL))).toBe("last_row");
    expect(reason(() => deleteRows(doc, sheet, 0, 500, LOCAL))).toBe("last_row");
    expect(reason(() => deleteCols(doc, sheet, 0, 26, LOCAL))).toBe("last_col");
    deleteRows(doc, sheet, 0, 99, LOCAL);
    expect(sheetSize(doc, sheet).rows).toBe(1);
  });

  test("columns: insert and delete, with widths and references", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 0, col: 4 }, [[1, 2, 3, "=SUM(E1:G1)"]], EN, LOCAL);
    setColWidth(doc, sheet, 5, 160, LOCAL);
    insertCols(doc, sheet, 5, 1, LOCAL);
    expect(cells(doc, sheet, "E1:I1")).toEqual([["1", "", "2", "3", "=SUM(E1:H1)"]]);
    expect(colWidths(doc, sheet)[6]).toBe(160);
    deleteCols(doc, sheet, 4, 1, LOCAL);
    expect(cells(doc, sheet, "E1:H1")).toEqual([["", "2", "3", "=SUM(E1:G1)"]]);
    expect(colWidths(doc, sheet)[5]).toBe(160);
    expect(sheetSize(doc, sheet).cols).toBe(26);
  });

  test("widths and heights", () => {
    const { doc, sheet } = sheetDoc();
    setColWidth(doc, sheet, [0, 2], 1, LOCAL);
    setRowHeight(doc, sheet, 0, 5000, LOCAL);
    expect(colWidths(doc, sheet).slice(0, 3)).toEqual([4, 100, 4]);
    expect(rowHeights(doc, sheet)[0]).toBe(1000);
    setColWidth(doc, sheet, 0, 100, LOCAL);
    expect(sizeMap(doc, sheet, "colWidths")?.size).toBe(1);
    expect(reason(() => setColWidth(doc, sheet, 0, Number.NaN, LOCAL))).toBe("value");
  });

  test("growing a sheet", () => {
    const { doc, sheet } = sheetDoc();
    ensureSize(doc, sheet, 50, 10, LOCAL);
    expect(sheetSize(doc, sheet)).toEqual({ rows: 100, cols: 26 });
    ensureSize(doc, sheet, 300, 40, LOCAL);
    expect(sheetSize(doc, sheet)).toEqual({ rows: 300, cols: 40 });
    expect(reason(() => ensureSize(doc, sheet, 10, 501, LOCAL))).toBe("limit");
  });
});

describe("sorting", () => {
  test("whole records move, ties keep their order, the header stays", () => {
    const { doc, sheet } = sheetDoc();
    setValues(
      doc,
      { sheet, row: 0, col: 0 },
      [
        ["Name", "Score"],
        ["b", 3],
        ["A", 1],
        ["c", 2],
        ["a", 1],
      ],
      EN,
      LOCAL,
    );
    formatRange(doc, range(sheet, "A3"), { b: 1 }, LOCAL);
    sortRange(doc, range(sheet, "A1:B5"), 1, false, storedValues(doc), LOCAL, { header: true });
    expect(cells(doc, sheet, "A1:B5")).toEqual([
      ["Name", "Score"],
      ["A", "1"],
      ["a", "1"],
      ["c", "2"],
      ["b", "3"],
    ]);
    expect(getCell(doc, sheet, 1, 0)).toEqual({ v: "A", s: { b: 1 } });
    sortRange(doc, range(sheet, "A2:B5"), 1, true, storedValues(doc), LOCAL);
    expect(cells(doc, sheet, "A2:A5").map((r) => r[0])).toEqual(["b", "c", "A", "a"]);
    sortRange(doc, range(sheet, "A2:B5"), 0, false, storedValues(doc), LOCAL);
    expect(cells(doc, sheet, "A2:A5").map((r) => r[0])).toEqual(["A", "a", "b", "c"]);
  });

  test("formulas move as copies do", () => {
    const { doc, sheet } = sheetDoc();
    setValues(
      doc,
      { sheet, row: 0, col: 0 },
      [
        ["x", 3, 10, null, "=B1*C1"],
        ["y", 1, 20, null, "=B2*C2"],
        ["z", 2, 30, null, "=B3*C3+$F$1"],
      ],
      EN,
      LOCAL,
    );
    sortRange(doc, range(sheet, "A1:E3"), 1, false, storedValues(doc), LOCAL);
    expect(cells(doc, sheet, "A1:A3").map((r) => r[0])).toEqual(["y", "z", "x"]);
    expect(cells(doc, sheet, "E1:E3").map((r) => r[0])).toEqual(["=B1*C1", "=B2*C2+$F$1", "=B3*C3"]);
  });

  test("Excel's order: numbers, text, booleans, errors, then empty cells", () => {
    const values = [true, "b", { error: "#N/A" as const }, null, 2, "A", 1, false, ""];
    const asc = [...values].sort((a, b) => compareCells(a, b));
    expect(asc).toEqual([1, 2, "A", "b", false, true, { error: "#N/A" }, null, ""]);
    const desc = [...values].sort((a, b) => compareCells(a, b, true));
    expect(desc).toEqual([{ error: "#N/A" }, true, false, "b", "A", 2, 1, null, ""]);
    expect(compareCells("é", "E")).toBe(0);
  });

  test("merged cells and a column outside the range are refused", () => {
    const { doc, sheet } = sheetDoc();
    mergeRange(doc, range(sheet, "A2:B2"), LOCAL);
    expect(reason(() => sortRange(doc, range(sheet, "A1:B5"), 0, false, storedValues(doc), LOCAL))).toBe("merged");
    expect(reason(() => sortRange(doc, range(sheet, "A3:B5"), 5, false, storedValues(doc), LOCAL))).toBe("range");
  });

  test("by what formulas compute, with the engine", () => {
    const { doc, sheet } = sheetDoc();
    setValues(
      doc,
      { sheet, row: 0, col: 0 },
      [
        [2, "=A1*-1"],
        [1, "=A2*-1"],
        [3, "=A3*-1"],
      ],
      EN,
      LOCAL,
    );
    const engine = new SheetEngine(doc);
    sortRange(doc, range(sheet, "A1:B3"), 1, false, engine, LOCAL);
    expect(cells(doc, sheet, "A1:B3")).toEqual([
      ["3", "=A1*-1"],
      ["2", "=A2*-1"],
      ["1", "=A3*-1"],
    ]);
    expect([0, 1, 2].map((r) => engine.valueAt(sheet, r, 1))).toEqual([-3, -2, -1]);
    engine.destroy();
  });
});

describe("one edit, one undo, only the person's own", () => {
  test("undo takes back a whole edit and never an agent's", () => {
    const { doc, sheet } = sheetDoc();
    const undo = new Y.UndoManager([doc.getMap("sheets"), doc.getArray("sheetOrder")], {
      trackedOrigins: new Set([LOCAL]),
      captureTimeout: 0,
    });
    setValues(doc, { sheet, row: 0, col: 0 }, [[1, 2, 3]], EN, LOCAL);
    setValues(doc, { sheet, row: 1, col: 0 }, [["agent"]], EN, agentOrigin("ag1"));
    insertRows(doc, sheet, 0, 1, LOCAL);
    expect(cell(doc, sheet, "A2")).toBe("1");
    undo.undo();
    expect(cell(doc, sheet, "A1")).toBe("1");
    expect(sheetSize(doc, sheet).rows).toBe(100);
    undo.undo();
    expect(cells(doc, sheet, "A1:C1")).toEqual([["", "", ""]]);
    expect(cell(doc, sheet, "A2")).toBe("agent");
    undo.destroy();
  });
});

describe("limits", () => {
  test("edits past the cell limit are refused before they write", () => {
    const limits = LIVE_LIMITS.spreadsheet as { cells: number };
    const before = limits.cells;
    limits.cells = 5;
    try {
      const { doc, sheet } = sheetDoc();
      setValues(doc, { sheet, row: 0, col: 0 }, [[1, 2, 3, 4]], EN, LOCAL);
      expect(reason(() => setValues(doc, { sheet, row: 1, col: 0 }, [[1, 2]], EN, LOCAL))).toBe("limit");
      expect(reason(() => formatRange(doc, range(sheet, "A3:C3"), { b: 1 }, LOCAL))).toBe("limit");
      expect(cellCount(doc)).toBe(4);
      setValues(doc, { sheet, row: 0, col: 0 }, [[9]], EN, LOCAL);
      expect(cell(doc, sheet, "A1")).toBe("9");
    } finally {
      limits.cells = before;
    }
  });
});
