import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { LOCAL, SYSTEM } from "../src/origins";
import { colIds, rowIds, sheetIds, sheetMap } from "../src/spreadsheet/doc";
import {
  addSheet,
  deleteSheet,
  formatRange,
  insertRows,
  mergeRange,
  renameSheet,
  setColWidth,
  setFrozen,
  setSheetTab,
  setValues,
} from "../src/spreadsheet/ops";
import { replaceSpreadsheet } from "../src/spreadsheet/replace";
import { cell, EN, range, sheetDoc, sync, twin } from "./spreadsheet-fixtures";

/** Everything a spreadsheet holds, as plain data. */
function dump(doc: Y.Doc): unknown[] {
  return sheetIds(doc).map((id) => {
    const sheet = sheetMap(doc, id) as Y.Map<unknown>;
    const json = (key: string) => (sheet.get(key) as Y.Map<unknown>).toJSON();
    return {
      id,
      name: sheet.get("name"),
      tab: sheet.get("tab"),
      frozen: sheet.get("frozen"),
      rows: rowIds(doc, id),
      cols: colIds(doc, id),
      cells: json("cells"),
      colWidths: json("colWidths"),
      rowHeights: json("rowHeights"),
      merges: json("merges"),
    };
  });
}

function version(doc: Y.Doc): Y.Doc {
  const old = new Y.Doc();
  Y.applyUpdate(old, Y.encodeStateAsUpdate(doc));
  return old;
}

describe("replaceSpreadsheet", () => {
  test("writes an old version over the head, by the same ids", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 0, col: 0 }, [[1, 2], ["=A1+B1"]], EN, LOCAL);
    formatRange(doc, range(sheet, "A1"), { b: 1 }, LOCAL);
    mergeRange(doc, range(sheet, "C1:E1"), LOCAL);
    setColWidth(doc, sheet, 0, 150, LOCAL);
    const second = addSheet(doc, "Second", LOCAL);
    setValues(doc, { sheet: second, row: 0, col: 0 }, [["kept"]], EN, LOCAL);
    const old = version(doc);
    const rowsThen = rowIds(doc, sheet);

    setValues(doc, { sheet, row: 0, col: 0 }, [[10, null]], EN, LOCAL);
    formatRange(doc, range(sheet, "A1"), { b: undefined, i: 1 }, LOCAL);
    insertRows(doc, sheet, 0, 2, LOCAL);
    renameSheet(doc, sheet, "Renamed", LOCAL);
    setFrozen(doc, sheet, 1, 0, LOCAL);
    setSheetTab(doc, sheet, "#0b6bcb", LOCAL);
    deleteSheet(doc, second, LOCAL);
    addSheet(doc, "Newer", LOCAL);
    setColWidth(doc, sheet, 1, 300, LOCAL);

    replaceSpreadsheet(doc, old, SYSTEM);
    expect(dump(doc)).toEqual(dump(old));
    expect(rowIds(doc, sheet)).toEqual(rowsThen);
    expect(cell(doc, sheet, "A2")).toBe("=A1+B1");
    expect(sheetIds(doc)).toEqual([sheet, second]);
    expect(cell(doc, second, "A1")).toBe("kept");
  });

  test("only what differs is written", () => {
    const { doc, sheet } = sheetDoc();
    setValues(
      doc,
      { sheet, row: 0, col: 0 },
      Array.from({ length: 100 }, (_, r) => Array.from({ length: 20 }, (_, c) => r * 100 + c)),
      EN,
      LOCAL,
    );
    const old = version(doc);
    setValues(doc, { sheet, row: 50, col: 5 }, [["changed"]], EN, LOCAL);
    let bytes = 0;
    const count = (update: Uint8Array) => {
      bytes += update.length;
    };
    doc.on("update", count);
    replaceSpreadsheet(doc, old, SYSTEM);
    doc.off("update", count);
    expect(dump(doc)).toEqual(dump(old));
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(200);
    let none = 0;
    const nothing = (update: Uint8Array) => {
      none += update.length;
    };
    doc.on("update", nothing);
    replaceSpreadsheet(doc, old, SYSTEM);
    doc.off("update", nothing);
    expect(none).toBe(0);
  });

  test("an edit someone makes at the same moment still lands", () => {
    const { doc: a, sheet } = sheetDoc();
    setValues(a, { sheet, row: 0, col: 0 }, [["v1"]], EN, LOCAL);
    const b = twin(a);
    const old = version(a);
    setValues(a, { sheet, row: 0, col: 0 }, [["v2"]], EN, LOCAL);
    sync(a, b);
    replaceSpreadsheet(a, old, SYSTEM);
    setValues(b, { sheet, row: 2, col: 4 }, [["typed meanwhile"]], EN, LOCAL);
    sync(a, b);
    for (const doc of [a, b]) {
      expect(cell(doc, sheet, "A1")).toBe("v1");
      expect(cell(doc, sheet, "E3")).toBe("typed meanwhile");
      expect(rowIds(doc, sheet)).toHaveLength(100);
    }
    expect(dump(a)).toEqual(dump(b));
  });

  test("a sheet broken in the head is set up again", () => {
    const { doc, sheet } = sheetDoc();
    setValues(doc, { sheet, row: 0, col: 0 }, [["x"]], EN, LOCAL);
    const old = version(doc);
    doc.transact(() => {
      const map = sheetMap(doc, sheet) as Y.Map<unknown>;
      map.set("cells", "broken");
      map.delete("rows");
    });
    replaceSpreadsheet(doc, old, SYSTEM);
    expect(dump(doc)).toEqual(dump(old));
  });
});
