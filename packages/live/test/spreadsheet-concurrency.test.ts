import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { agentOrigin, LOCAL } from "../src/origins";
import { spreadsheetToData } from "../src/spreadsheet/data";
import {
  cellAt,
  cellCount,
  colIds,
  frozenOf,
  readMerges,
  rowIds,
  SheetError,
  sheetIds,
  sheetMap,
  sheetName,
  sheetSize,
} from "../src/spreadsheet/doc";
import { fillRange } from "../src/spreadsheet/fill";
import {
  addSheet,
  clearRange,
  deleteCols,
  deleteRows,
  formatRange,
  insertCols,
  insertRows,
  mergeRange,
  moveSheet,
  setColWidth,
  setFrozen,
  setInput,
  setValues,
  sortRange,
} from "../src/spreadsheet/ops";
import { spreadsheetPreview, spreadsheetText } from "../src/spreadsheet/preview";
import { validateSpreadsheet } from "../src/spreadsheet/validate";
import { cell, cells, EN, range, sheetDoc, storedValues, sync, twin } from "./spreadsheet-fixtures";

/** The two documents hold exactly the same content. */
function same(a: Y.Doc, b: Y.Doc): void {
  expect(Y.encodeStateVector(a)).toEqual(Y.encodeStateVector(b));
  expect(a.getMap("sheets").toJSON()).toEqual(b.getMap("sheets").toJSON());
  expect(sheetIds(a)).toEqual(sheetIds(b));
}

describe("two people in one sheet at once", () => {
  test("rows inserted on one device while cells are typed on the other: cells stay with their rows", () => {
    const { doc: a, sheet } = sheetDoc();
    const b = twin(a);
    insertRows(a, sheet, 1, 2, LOCAL);
    setValues(b, { sheet, row: 0, col: 0 }, [["first"], ["second"], ["third"]], EN, LOCAL);
    sync(a, b);
    same(a, b);
    for (const doc of [a, b]) {
      expect(cells(doc, sheet, "A1:A5").map((r) => r[0])).toEqual(["first", "", "", "second", "third"]);
      expect(rowIds(doc, sheet)).toHaveLength(102);
    }
  });

  test("a formula typed on one device keeps its cells when the other inserts rows above them", () => {
    const { doc: a, sheet } = sheetDoc();
    setValues(a, { sheet, row: 0, col: 0 }, [[1], [2], [3]], EN, LOCAL);
    const b = twin(a);
    setInput(b, { sheet, row: 4, col: 0 }, "=SUM(A1:A3)", EN, LOCAL);
    insertRows(a, sheet, 0, 1, LOCAL);
    sync(a, b);
    same(a, b);
    expect(cell(a, sheet, "A6")).toBe("=SUM(A2:A4)");
    expect(cell(b, sheet, "A2")).toBe("1");
  });

  test("a row deleted on one device while the other types in it", () => {
    const { doc: a, sheet } = sheetDoc();
    setValues(a, { sheet, row: 0, col: 0 }, [["keep"], ["goes"], ["keep too"]], EN, LOCAL);
    const b = twin(a);
    deleteRows(a, sheet, 1, 1, LOCAL);
    setValues(b, { sheet, row: 1, col: 1 }, [["typed in the row that went"]], EN, LOCAL);
    sync(a, b);
    same(a, b);
    for (const doc of [a, b]) {
      expect(cells(doc, sheet, "A1:B2")).toEqual([
        ["keep", ""],
        ["keep too", ""],
      ]);
      expect(validateSpreadsheet(doc)).toEqual([]);
    }
  });

  test("the same cell typed on two devices: one whole cell wins everywhere", () => {
    const { doc: a, sheet } = sheetDoc();
    const b = twin(a);
    setValues(a, { sheet, row: 0, col: 0 }, [["from a"]], EN, LOCAL);
    formatRange(a, range(sheet, "A1"), { b: 1 }, LOCAL);
    setValues(b, { sheet, row: 0, col: 0 }, [["from b"]], EN, LOCAL);
    sync(a, b);
    same(a, b);
    const winner = cellAt(a, sheet, rowIds(a, sheet)[0] as string, colIds(a, sheet)[0] as string);
    expect([JSON.stringify({ v: "from a", s: { b: 1 } }), JSON.stringify({ v: "from b" })]).toContain(
      JSON.stringify(winner),
    );
  });

  test("an agent's edit and a person's at once both land", () => {
    const { doc: a, sheet } = sheetDoc();
    const b = twin(a);
    setValues(a, { sheet, row: 0, col: 0 }, [["agent", "=A2*2"]], EN, agentOrigin("ag1", "run1"));
    setValues(b, { sheet, row: 1, col: 0 }, [[21]], EN, LOCAL);
    formatRange(b, range(sheet, "C1"), { nf: "0.00" }, LOCAL);
    sync(a, b);
    same(a, b);
    expect(cells(a, sheet, "A1:B2")).toEqual([
      ["agent", "=A2*2"],
      ["21", ""],
    ]);
  });

  test("a merge made while rows are inserted inside it grows with them", () => {
    const { doc: a, sheet } = sheetDoc();
    const b = twin(a);
    mergeRange(a, range(sheet, "A2:B4"), LOCAL);
    insertRows(b, sheet, 2, 3, LOCAL);
    sync(a, b);
    same(a, b);
    expect(readMerges(a, sheet).map(({ r1, c1, r2, c2 }) => [r1, c1, r2, c2])).toEqual([[1, 0, 6, 1]]);
  });
});

describe("two people with the sheets at once", () => {
  test("both add a sheet with the same name: both are kept", () => {
    const { doc: a } = sheetDoc();
    const b = twin(a);
    const fromA = addSheet(a, "Plan 2", LOCAL);
    const fromB = addSheet(b, "Plan 2", LOCAL);
    sync(a, b);
    same(a, b);
    expect(sheetIds(a)).toHaveLength(3);
    expect(sheetIds(a)).toContain(fromA);
    expect(sheetIds(a)).toContain(fromB);
    expect(sheetName(a, fromA)).toBe("Plan 2");
  });

  test("both move the same sheet: it is listed once, in the same place for both", () => {
    const { doc: a } = sheetDoc();
    const s2 = addSheet(a, "Two", LOCAL);
    addSheet(a, "Three", LOCAL);
    const b = twin(a);
    moveSheet(a, s2, 0, LOCAL);
    moveSheet(b, s2, 2, LOCAL);
    sync(a, b);
    same(a, b);
    expect(sheetIds(a)).toHaveLength(3);
    expect(new Set(sheetIds(a)).size).toBe(3);
    expect(validateSpreadsheet(a)).toEqual([]);
  });
});

describe("many edits at once", () => {
  /** A seeded random number generator, so a failure can be replayed. */
  function seeded(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  test("three devices editing at random agree once synced, and the document stays in shape", () => {
    const rand = seeded(20261117);
    const int = (n: number) => Math.floor(rand() * n);
    const { doc: first, sheet } = sheetDoc();
    const docs = [first, twin(first), twin(first)] as const;
    const edits: ((doc: Y.Doc) => unknown)[] = [
      (doc) =>
        setValues(
          doc,
          { sheet, row: int(sheetSize(doc, sheet).rows), col: int(6) },
          [
            [int(100), `=A${1 + int(20)}*2`],
            [`Item ${int(9)}`, rand() < 0.5],
          ],
          EN,
          LOCAL,
        ),
      (doc) => insertRows(doc, sheet, int(sheetSize(doc, sheet).rows), 1 + int(3), LOCAL),
      (doc) => deleteRows(doc, sheet, int(sheetSize(doc, sheet).rows), 1 + int(2), LOCAL),
      (doc) => insertCols(doc, sheet, int(sheetSize(doc, sheet).cols), 1 + int(2), LOCAL),
      (doc) => deleteCols(doc, sheet, int(sheetSize(doc, sheet).cols), 1, LOCAL),
      (doc) => {
        const r = int(30);
        const c = int(6);
        mergeRange(doc, { sheet, r1: r, c1: c, r2: r + int(3), c2: c + int(2) }, LOCAL);
      },
      (doc) => formatRange(doc, { sheet, r1: int(30), c1: int(6), r2: 30 + int(10), c2: 6 + int(3) }, { b: 1 }, LOCAL),
      (doc) => setFrozen(doc, sheet, int(4), int(3), LOCAL),
      (doc) => setColWidth(doc, sheet, int(sheetSize(doc, sheet).cols), 40 + int(200), LOCAL),
      (doc) => sortRange(doc, { sheet, r1: 0, c1: 0, r2: 20, c2: 3 }, int(4), rand() < 0.5, storedValues(doc), LOCAL),
      (doc) =>
        fillRange(
          doc,
          { sheet, r1: 0, c1: 0, r2: 1, c2: 1 },
          { sheet, r1: 0, c1: 0, r2: 6 + int(10), c2: 1 },
          null,
          LOCAL,
        ),
      (doc) => clearRange(doc, { sheet, r1: int(40), c1: 0, r2: 45, c2: 3 }, rand() < 0.5 ? "all" : "contents", LOCAL),
      (doc) => addSheet(doc, `Extra ${int(1000)}`, LOCAL),
      (doc) => {
        const ids = sheetIds(doc);
        moveSheet(doc, ids[int(ids.length)] as string, int(ids.length), LOCAL);
      },
    ];
    const refused = new Set<string>();
    for (let round = 0; round < 80; round++) {
      for (const doc of docs) {
        for (let k = 1 + int(3); k > 0; k--) {
          try {
            edits[int(edits.length)]?.(doc);
          } catch (e) {
            if (!(e instanceof SheetError)) throw e;
            refused.add(e.reason);
          }
        }
      }
      // Updates reach devices in any order: some rounds only two of them talk.
      if (round % 4 === 3) {
        sync(docs[0], docs[1]);
        sync(docs[1], docs[2]);
      } else sync(docs[int(3)] as Y.Doc, docs[int(3)] as Y.Doc);
    }
    sync(docs[0], docs[1]);
    sync(docs[1], docs[2]);
    sync(docs[0], docs[1]);
    same(docs[0], docs[1]);
    same(docs[1], docs[2]);
    for (const doc of docs) {
      expect(validateSpreadsheet(doc)).toEqual([]);
      const size = sheetSize(doc, sheet);
      const raw = sheetMap(doc, sheet)?.get("rows") as Y.Array<string>;
      expect(new Set(raw.toArray()).size).toBe(raw.length);
      for (const m of readMerges(doc, sheet)) expect(m.r2 < size.rows && m.c2 < size.cols).toBe(true);
      const frozen = frozenOf(doc, sheet);
      expect(frozen.rows <= size.rows && frozen.cols <= size.cols).toBe(true);
      // Every reader takes the result.
      expect(spreadsheetToData(doc, storedValues(doc)).sheets.length).toBe(sheetIds(doc).length);
      expect(spreadsheetPreview(doc, storedValues(doc), EN).sheets).toBe(sheetIds(doc).length);
      expect(typeof spreadsheetText(doc, storedValues(doc))).toBe("string");
    }
    expect(spreadsheetToData(docs[0], storedValues(docs[0]))).toEqual(
      spreadsheetToData(docs[2], storedValues(docs[2])),
    );
    // The run did real work: cells, merges and sheets made by all three.
    expect(cellCount(docs[0])).toBeGreaterThan(100);
    expect(readMerges(docs[0], sheet).length).toBeGreaterThan(0);
    expect(sheetIds(docs[0]).length).toBeGreaterThan(3);
  });
});
