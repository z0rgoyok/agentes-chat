import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { LiveEditError } from "../src/errors";
import {
  cellAt,
  cellKey,
  cleanCellStyle,
  cleanSheetName,
  colIds,
  colWidth,
  frozenOf,
  initSpreadsheet,
  isHexColor,
  newSheetMap,
  nextSheetName,
  parseCellKey,
  readCell,
  readMerges,
  rowIds,
  SheetError,
  sameData,
  sheetByName,
  sheetIds,
  sheetMap,
  sheetName,
  sheetParts,
  sheetSize,
  uniqueSheetName,
} from "../src/spreadsheet/doc";

describe("a new spreadsheet", () => {
  test("one sheet of 100 rows by 26 columns with fresh ids, made once", () => {
    const doc = new Y.Doc();
    initSpreadsheet(doc, "  Planilha:1 ");
    initSpreadsheet(doc, "Other");
    const ids = sheetIds(doc);
    expect(ids).toHaveLength(1);
    const sheet = ids[0] as string;
    expect(sheetName(doc, sheet)).toBe("Planilha 1");
    expect(sheetSize(doc, sheet)).toEqual({ rows: 100, cols: 26 });
    expect(new Set(rowIds(doc, sheet)).size).toBe(100);
    expect(new Set(colIds(doc, sheet)).size).toBe(26);
    expect(rowIds(doc, sheet).every((id) => /^[0-9a-z]{10}$/.test(id))).toBe(true);
    expect(frozenOf(doc, sheet)).toEqual({ rows: 0, cols: 0 });
    const blank = new Y.Doc();
    initSpreadsheet(blank, ":?");
    expect(sheetName(blank, sheetIds(blank)[0] as string)).toBe("Sheet 1");
  });
});

describe("reading what is out of shape", () => {
  test("sheets in order, once each, the missing ones at the end", () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const sheets = doc.getMap<unknown>("sheets");
      sheets.set("s1", newSheetMap("One", 1, 1));
      sheets.set("s2", newSheetMap("Two", 1, 1));
      sheets.set("s0", newSheetMap("Zero", 1, 1));
      sheets.set("junk", "not a sheet");
      doc.getArray<unknown>("sheetOrder").push(["s1", "s1", "ghost", 7, "s2"]);
    });
    expect(sheetIds(doc)).toEqual(["s1", "s2", "s0"]);
    expect(sheetByName(doc, " two ")).toBe("s2");
    expect(sheetByName(doc, "nope")).toBeNull();
    expect(sheetName(doc, "junk")).toBe("");
  });

  test("rows and columns once each, ids only", () => {
    const doc = new Y.Doc();
    const sheet = newSheetMap("S", ["r1", "r2"], ["c1"]);
    doc.getMap("sheets").set("s", sheet);
    const stored = sheetMap(doc, "s") as Y.Map<unknown>;
    (stored.get("rows") as Y.Array<unknown>).push(["r1", 5, "", "r3"]);
    expect(rowIds(doc, "s")).toEqual(["r1", "r2", "r3"]);
    doc.transact(() => sheetParts(doc, "s"));
    expect((stored.get("rows") as Y.Array<unknown>).toArray()).toEqual(["r1", "r2", "r3"]);
    expect(() => sheetParts(doc, "missing")).toThrow(SheetError);
  });

  test("cells: values, formulas and styles kept only in shape, always as fresh objects", () => {
    expect(readCell({ v: Number.NaN })).toBeUndefined();
    expect(readCell("text")).toBeUndefined();
    expect(readCell({ v: {} })).toBeUndefined();
    expect(readCell({ v: "", s: { b: 1 } })).toEqual({ s: { b: 1 } });
    expect(readCell({ f: "SUM(1)", v: 3 })).toEqual({ f: "SUM(1)" });
    expect(
      readCell({
        v: 1,
        s: {
          b: 2,
          i: true,
          fc: "red",
          bg: "#FFF",
          ha: "x",
          va: "m",
          nf: "General",
          fs: 500,
          bd: { t: { w: 5 }, b: { w: 2, c: "#000" } },
        },
      }),
    ).toEqual({ v: 1, s: { i: 1, bg: "#FFF", va: "m", bd: { b: { w: 2, c: "#000" } } } });
    const stored = { v: 1, s: { b: 1 } };
    const read = readCell(stored);
    if (read?.s) read.s.b = undefined;
    expect(stored.s.b).toBe(1);
    expect(cleanCellStyle({})).toBeUndefined();
    expect(cleanCellStyle({ nf: "0.00", fs: 6, w: 1 })).toEqual({ nf: "0.00", fs: 6, w: 1 });
  });

  test("cell keys, sizes and frozen panes", () => {
    expect(cellKey("r1", "c1")).toBe("r1:c1");
    expect(parseCellKey("r1:c1")).toEqual(["r1", "c1"]);
    for (const bad of ["r1:", ":c1", "a:b:c", "ab"]) expect(parseCellKey(bad)).toBeNull();
    const doc = new Y.Doc();
    doc.getMap("sheets").set("s", newSheetMap("S", ["r1", "r2", "r3"], ["c1", "c2"]));
    const sheet = sheetMap(doc, "s") as Y.Map<unknown>;
    (sheet.get("colWidths") as Y.Map<unknown>).set("c1", -5);
    (sheet.get("colWidths") as Y.Map<unknown>).set("c2", 140);
    expect(colWidth(doc, "s", "c1")).toBe(100);
    expect(colWidth(doc, "s", "c2")).toBe(140);
    sheet.set("frozen", { rows: 5.7, cols: -3 });
    expect(frozenOf(doc, "s")).toEqual({ rows: 3, cols: 0 });
    sheet.set("frozen", "both");
    expect(frozenOf(doc, "s")).toEqual({ rows: 0, cols: 0 });
    (sheet.get("cells") as Y.Map<unknown>).set("r2:c2", { v: 7 });
    expect(cellAt(doc, "s", "r2", "c2")).toEqual({ v: 7 });
  });

  test("merges: the first by key wins an overlap; gone or single-cell ones are skipped", () => {
    const doc = new Y.Doc();
    doc.getMap("sheets").set("s", newSheetMap("S", ["r1", "r2", "r3", "r4"], ["c1", "c2", "c3"]));
    const merges = sheetMap(doc, "s")?.get("merges") as Y.Map<unknown>;
    merges.set("a", { r1: "r1", c1: "c1", r2: "r2", c2: "c2" });
    merges.set("b", { r1: "r2", c1: "c2", r2: "r3", c2: "c3" });
    merges.set("c", { r1: "r4", c1: "c1", r2: "r4", c2: "c1" });
    merges.set("d", { r1: "gone", c1: "c1", r2: "r4", c2: "c3" });
    merges.set("e", { r1: "r4", c1: "c3", r2: "r3", c2: "c3" });
    merges.set("f", "junk");
    expect(readMerges(doc, "s")).toEqual([
      { key: "a", r1: 0, c1: 0, r2: 1, c2: 1 },
      { key: "e", r1: 2, c1: 2, r2: 3, c2: 2 },
    ]);
  });
});

describe("names", () => {
  test("sheet names as Excel allows them", () => {
    expect(cleanSheetName("  [Q1]: Sales/2026?  ")).toBe("Q1 Sales 2026");
    expect(cleanSheetName("'quoted'")).toBe("quoted");
    expect(cleanSheetName("x".repeat(40))).toHaveLength(31);
    expect(cleanSheetName("tab\there")).toBe("tab here");
  });

  test("unique and next names", () => {
    const doc = new Y.Doc();
    initSpreadsheet(doc, "Planilha 1");
    const sheets = doc.getMap<unknown>("sheets");
    doc.transact(() => {
      sheets.set("b", newSheetMap("Planilha 2", 1, 1));
      doc.getArray<string>("sheetOrder").push(["b"]);
    });
    expect(uniqueSheetName(doc, "planilha 1")).toBe("planilha 1 (2)");
    expect(uniqueSheetName(doc, "Vendas")).toBe("Vendas");
    expect(uniqueSheetName(doc, "Planilha 1", sheetIds(doc)[0])).toBe("Planilha 1");
    expect(nextSheetName(doc, "Planilha")).toBe("Planilha 3");
    expect(nextSheetName(doc, "")).toBe("Sheet 3");
    expect(uniqueSheetName(doc, "y".repeat(31))).toBe("y".repeat(31));
  });
});

describe("helpers", () => {
  test("errors are the package's own", () => {
    const error = new SheetError("limit", "Too many");
    expect(error).toBeInstanceOf(LiveEditError);
    expect(error.code).toBe("too_many");
    expect(error.reason).toBe("limit");
    expect(new SheetError("no_sheet", "x").code).toBe("not_found");
    expect(new SheetError("text_too_long", "x").code).toBe("too_large");
  });

  test("colors and plain data", () => {
    expect(isHexColor("#1a7f37")).toBe(true);
    expect(isHexColor("#abc")).toBe(true);
    expect(isHexColor("red")).toBe(false);
    expect(isHexColor("#12345")).toBe(false);
    expect(sameData({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(sameData({ a: 1, x: undefined }, { a: 1 })).toBe(true);
    expect(sameData({ a: [1] }, { a: [2] })).toBe(false);
    expect(sameData(null, {})).toBe(false);
  });
});
