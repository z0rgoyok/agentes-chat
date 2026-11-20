import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { type SheetChange, SheetEngine } from "../src/spreadsheet/engine";
import { toCanonical } from "../src/spreadsheet/formula";
import {
  book,
  cellsOf,
  colsOf,
  EN,
  err,
  keyAt,
  PT,
  put,
  putAll,
  rowsOf,
  sheetMap,
  shown,
  val,
} from "./formula-helpers";

function listen(b: ReturnType<typeof book>): SheetChange[] {
  const seen: SheetChange[] = [];
  b.engine.onChange((c) => seen.push({ ...c, ...(c.cells ? { cells: new Set(c.cells) } : {}) }));
  return seen;
}

describe("recomputing only what changed", () => {
  test("an edit recomputes its dependents, transitively, and nothing else", () => {
    const b = book(["Sheet1"], { rows: 10, cols: 8 });
    putAll(b, { A1: 1, B1: "=A1*2", C1: "=B1+1", E1: "=A1+100", F1: "=G1*2", G1: 5 });
    expect([val(b, "B1"), val(b, "C1"), val(b, "E1"), val(b, "F1")]).toEqual([2, 3, 101, 10]);
    expect(b.engine.computations()).toBe(4);
    // Reading again costs nothing.
    val(b, "C1");
    expect(b.engine.computations()).toBe(4);
    const seen = listen(b);
    put(b, "A1", 10);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cells).toEqual(new Set([keyAt(b, "A1"), keyAt(b, "B1"), keyAt(b, "C1"), keyAt(b, "E1")]));
    expect([val(b, "B1"), val(b, "C1"), val(b, "E1"), val(b, "F1")]).toEqual([20, 21, 110, 10]);
    expect(b.engine.computations()).toBe(7);
  });

  test("ranges, whole columns and other sheets", () => {
    const b = book(["Sheet1", "Sheet2"], { rows: 30, cols: 8 });
    putAll(b, { A1: 1, A2: 2, A20: 7, B1: "=SUM(A1:A10)", B2: "=SUM(A:A)", B3: "=COUNT(A1:A3)" });
    put(b, "A1", "=Sheet1!B1*10", { sheet: "Sheet2" });
    expect([val(b, "B1"), val(b, "B2"), val(b, "B3"), val(b, "A1", "Sheet2")]).toEqual([3, 10, 2, 30]);
    const before = b.engine.computations();
    put(b, "A5", 5);
    expect([val(b, "B1"), val(b, "B2"), val(b, "B3"), val(b, "A1", "Sheet2")]).toEqual([8, 15, 2, 80]);
    // B1, B2 and the other sheet's formula; COUNT(A1:A3) never saw A5.
    expect(b.engine.computations() - before).toBe(3);
    put(b, "A25", 1);
    expect(val(b, "B1")).toBe(8);
    expect(val(b, "B2")).toBe(16);
  });

  test("a change to how a cell looks recomputes nothing", () => {
    const b = book(["Sheet1"], { rows: 5, cols: 4 });
    putAll(b, { A1: 0.25, B1: "=A1*2", C1: "=B1+1" });
    expect(val(b, "C1")).toBe(1.5);
    const before = b.engine.computations();
    const seen = listen(b);
    b.doc.transact(() => {
      const cells = cellsOf(b);
      const key = keyAt(b, "B1");
      cells.set(key, { ...(cells.get(key) as object), s: { nf: "0%" } });
    });
    expect(seen[0]?.cells).toEqual(new Set([keyAt(b, "B1")]));
    expect(val(b, "C1")).toBe(1.5);
    expect(shown(b, "B1")).toBe("50%");
    expect(b.engine.computations()).toBe(before);
  });

  test("many changes at once take the sweep and still reach every dependent", () => {
    const b = book(["Sheet1"], { rows: 600, cols: 4 });
    const values: Record<string, number | string> = {};
    for (let i = 1; i <= 500; i++) values[`A${i}`] = i;
    putAll(b, values);
    putAll(b, { B1: "=SUM(A1:A500)", B2: "=SUM(A250:A260)", B3: "=A600" });
    expect([val(b, "B1"), val(b, "B2"), val(b, "B3")]).toEqual([125250, 2805, 0]);
    const next: Record<string, number> = {};
    for (let i = 1; i <= 400; i++) next[`A${i}`] = 1;
    putAll(b, next);
    expect([val(b, "B1"), val(b, "B2"), val(b, "B3")]).toEqual([400 + (125250 - 80200), 11, 0]);
  });

  test("changes from another copy of the document arrive like local ones", () => {
    const b = book(["Sheet1"], { rows: 5, cols: 4 });
    putAll(b, { A1: 2, B1: "=A1^2" });
    expect(val(b, "B1")).toBe(4);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(b.doc));
    const key = keyAt(b, "A1");
    remote.transact(() => {
      ((remote.getMap<Y.Map<unknown>>("sheets").get("s0") as Y.Map<unknown>).get("cells") as Y.Map<unknown>).set(key, {
        v: 9,
      });
    });
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(b.doc)));
    expect(val(b, "B1")).toBe(81);
  });

  test("destroy stops listening", () => {
    const b = book(["Sheet1"], { rows: 5, cols: 4 });
    putAll(b, { A1: 1, B1: "=A1" });
    const seen = listen(b);
    b.engine.destroy();
    put(b, "A1", 2);
    expect(seen).toHaveLength(0);
  });
});

describe("rows, columns and sheets moving", () => {
  test("inserting and deleting rows keeps references and recomputes the sheet", () => {
    const b = book(["Sheet1", "Sheet2"], { rows: 10, cols: 6 });
    putAll(b, { A1: 1, A2: 2, A3: 3, B1: "=SUM(A1:A3)", B2: "=ROW()", B5: "=A3*10", C1: "=ROWS(A1:A3)" });
    put(b, "A1", "=Sheet1!A3+1", { sheet: "Sheet2" });
    expect([val(b, "B1"), val(b, "B2"), val(b, "B5"), val(b, "C1"), val(b, "A1", "Sheet2")]).toEqual([6, 2, 30, 3, 4]);
    const seen = listen(b);
    b.doc.transact(() => rowsOf(b).insert(1, ["x1"]));
    expect(seen.find((c) => c.sheetId === b.first)?.all).toBe(true);
    expect(seen.find((c) => c.sheetId === b.ids.Sheet2)?.cells?.has(keyAt(b, "A1", "Sheet2"))).toBe(true);
    // The range grew around the new row; ROW() moved with its cell.
    expect(val(b, "C1")).toBe(4);
    expect(b.engine.rowIndex(b.first, "r1")).toBe(2);
    expect(b.engine.valueAt(b.first, 2, 1)).toBe(3);
    put(b, "A2", 100);
    expect(val(b, "B1")).toBe(106);
    // Deleting the row a reference points at (ops pull a range's edge in first; here it is deleted outright).
    b.doc.transact(() => rowsOf(b).delete(3, 1));
    expect(val(b, "B5")).toEqual(err("#REF!"));
    expect(val(b, "A1", "Sheet2")).toEqual(err("#REF!"));
    expect(val(b, "B1")).toEqual(err("#REF!"));
  });

  test("inserting columns moves formulas with their columns", () => {
    const b = book(["Sheet1"], { rows: 5, cols: 6 });
    putAll(b, { A1: 4, B1: "=A1*2", E1: "=COLUMN()" });
    expect(val(b, "E1")).toBe(5);
    b.doc.transact(() => colsOf(b).insert(0, ["k0"]));
    expect(val(b, "B1")).toBe(4);
    expect(val(b, "C1")).toBe(8);
    expect(val(b, "F1")).toBe(6);
    expect(b.engine.size(b.first)).toEqual({ rows: 5, cols: 7 });
    expect(b.engine.colIdAt(b.first, 0)).toBe("k0");
  });

  test("renaming, adding and deleting sheets", () => {
    const b = book(["Sheet1", "Data"], { rows: 5, cols: 4 });
    put(b, "A1", 42, { sheet: "Data" });
    putAll(b, { A1: '=INDIRECT("Data!A1")', A2: '=INDIRECT("Base!A1")', A3: "=Data!A1" });
    expect([val(b, "A1"), val(b, "A2"), val(b, "A3")]).toEqual([42, err("#REF!"), 42]);
    b.doc.transact(() =>
      (b.doc.getMap<Y.Map<unknown>>("sheets").get(b.ids.Data as string) as Y.Map<unknown>).set("name", "Base"),
    );
    expect([val(b, "A1"), val(b, "A2"), val(b, "A3")]).toEqual([err("#REF!"), 42, 42]);
    b.doc.transact(() => {
      b.doc.getMap<Y.Map<unknown>>("sheets").set("s9", sheetMap("Data", 3, 3, "s9"));
      b.doc.getArray<string>("sheetOrder").push(["s9"]);
    });
    expect(val(b, "A1")).toBe(0);
    b.doc.transact(() => b.doc.getMap<Y.Map<unknown>>("sheets").delete(b.ids.Data as string));
    expect(val(b, "A3")).toEqual(err("#REF!"));
    expect(val(b, "A2")).toEqual(err("#REF!"));
  });

  test("an id repeated by two concurrent moves counts at its first place", () => {
    const b = book(["Sheet1"], { rows: 5, cols: 3 });
    putAll(b, { A1: 1, A2: 2, A3: 3, B1: "=ROW(A3)" });
    b.doc.transact(() => rowsOf(b).insert(0, ["r2"]));
    expect(b.engine.rowIndex(b.first, "r2")).toBe(0);
    expect(b.engine.rowIndex(b.first, "r0")).toBe(1);
    expect(b.engine.size(b.first).rows).toBe(5);
    expect(b.engine.value(b.first, "r0", "c1")).toBe(1);
  });
});

describe("cycles", () => {
  test("every cell on a cycle shows #REF! as circular, in any order", () => {
    for (const first of ["A1", "B1"]) {
      const b = book(["Sheet1"], { rows: 5, cols: 6 });
      putAll(b, { A1: "=IFERROR(B1,5)", B1: "=A1", C1: "=A1+1", E1: "=IFERROR(A1,7)" });
      val(b, first);
      expect(val(b, "A1")).toEqual(err("#REF!"));
      expect(val(b, "B1")).toEqual(err("#REF!"));
      expect(val(b, "C1")).toEqual(err("#REF!"));
      expect(val(b, "E1")).toBe(7);
      const [rowId, colId] = keyAt(b, "A1").split(":") as [string, string];
      expect(b.engine.errorInfo(b.first, rowId, colId)).toEqual({ code: "#REF!", circular: true });
    }
  });

  test("a formula reading itself, directly or through its range", () => {
    const b = book(["Sheet1"], { rows: 5, cols: 4 });
    putAll(b, { A1: "=A1+1", A2: 1, A3: "=SUM(A2:A4)", B1: "=SUM(B2:B3)", B2: 2 });
    expect(val(b, "A1")).toEqual(err("#REF!"));
    expect(val(b, "A3")).toEqual(err("#REF!"));
    expect(val(b, "B1")).toBe(2);
  });

  test("breaking a cycle brings the values back", () => {
    const b = book(["Sheet1"], { rows: 5, cols: 4 });
    putAll(b, { A1: "=B1+1", B1: "=A1+1" });
    expect(val(b, "A1")).toEqual(err("#REF!"));
    put(b, "B1", 3);
    expect(val(b, "A1")).toBe(4);
    const [rowId, colId] = keyAt(b, "A1").split(":") as [string, string];
    expect(b.engine.errorInfo(b.first, rowId, colId)).toBeNull();
  });
});

describe("deep chains", () => {
  test("a chain of thousands of formulas computes without a deep stack", () => {
    const n = 5000;
    const b = book(["Sheet1"], { rows: n, cols: 3 });
    const cells = cellsOf(b);
    b.doc.transact(() => {
      cells.set("r0:c0", { v: 1 });
      for (let i = 1; i < n; i++) cells.set(`r${i}:c0`, { f: `{r${i - 1},c0}+1` });
      cells.set("r0:c1", { f: `{r${n - 1},c0}*2` });
    });
    expect(val(b, "B1")).toBe(n * 2);
    expect(b.engine.valueAt(b.first, n - 1, 0)).toBe(n);
    // One edit at the top flows to the bottom.
    put(b, "A1", 10);
    expect(val(b, "B1")).toBe((n + 9) * 2);
  });

  test("a cycle longer than one stage is found, and every cell on it is circular in any order", () => {
    const n = 450;
    for (const start of [0, n - 1, 200]) {
      const b = book(["Sheet1"], { rows: n, cols: 2 });
      const cells = cellsOf(b);
      b.doc.transact(() => {
        cells.set("r0:c0", { f: `{r${n - 1},c0}+1` });
        for (let i = 1; i < n; i++)
          cells.set(`r${i}:c0`, { f: i === 300 ? `IFERROR({r${i - 1},c0},0)+1` : `{r${i - 1},c0}+1` });
      });
      b.engine.valueAt(b.first, start, 0);
      for (let i = 0; i < n; i++) expect(b.engine.valueAt(b.first, i, 0)).toEqual(err("#REF!"));
    }
  });

  test("a long running total", () => {
    const n = 3000;
    const b = book(["Sheet1"], { rows: n, cols: 3 });
    const cells = cellsOf(b);
    b.doc.transact(() => {
      for (let i = 0; i < n; i++) {
        cells.set(`r${i}:c0`, { v: i + 1 });
        cells.set(`r${i}:c1`, { f: `SUM({$r0,c0}:{r${i},c0})` });
      }
    });
    expect(b.engine.valueAt(b.first, n - 1, 1)).toBe((n * (n + 1)) / 2);
    put(b, "A1", 1001);
    expect(b.engine.valueAt(b.first, n - 1, 1)).toBe((n * (n + 1)) / 2 + 1000);
    expect(b.engine.valueAt(b.first, 0, 1)).toBe(1001);
  });
});

describe("limits and determinism", () => {
  test("a formula past its step budget is #CALC!", () => {
    const b = book(["Sheet1"], { rows: 3, cols: 3 });
    put(b, "A1", "=SUM(SEQUENCE(1000,1000)*SEQUENCE(1000,1000))");
    put(b, "A2", "=IFERROR(A1,-1)");
    expect(val(b, "A1")).toEqual(err("#CALC!"));
    expect(val(b, "A2")).toBe(-1);
  });

  test("RAND is the same on every device and stable across edits", () => {
    const b = book(["Sheet1"], { rows: 5, cols: 3, seed: "abc" });
    putAll(b, { A1: "=RAND()", A2: "=RAND()", B1: 1 });
    const a1 = val(b, "A1");
    const a2 = val(b, "A2");
    expect(a1).not.toBe(a2);
    const other = new SheetEngine(b.doc);
    expect(other.valueAt(b.first, 0, 0)).toBe(a1);
    put(b, "B1", 2);
    expect(val(b, "A1")).toBe(a1);
    const reseeded = book(["Sheet1"], { rows: 5, cols: 3, seed: "xyz" });
    putAll(reseeded, { A1: "=RAND()" });
    expect(val(reseeded, "A1")).not.toBe(a1);
  });

  test("tick refreshes NOW every time and TODAY only on a new day", () => {
    let now = new Date(2026, 10, 17, 10, 0, 0);
    const b = book(["Sheet1"], { rows: 5, cols: 3, now: () => now });
    putAll(b, { A1: "=TODAY()", A2: "=NOW()", A3: 5, B1: "=A3+1" });
    val(b, "A1");
    val(b, "A2");
    val(b, "B1");
    const seen = listen(b);
    now = new Date(2026, 10, 17, 10, 1, 0);
    b.engine.tick();
    expect(seen[0]?.cells).toEqual(new Set([keyAt(b, "A2")]));
    val(b, "A2");
    now = new Date(2026, 10, 18, 10, 1, 0);
    b.engine.tick();
    expect(seen[1]?.cells).toEqual(new Set([keyAt(b, "A1"), keyAt(b, "A2")]));
    b.engine.tick();
    expect(seen).toHaveLength(2);
  });
});

describe("reading while a transaction is open", () => {
  test("values reflect the writes made so far in the transaction", () => {
    const b = book(["Sheet1"], { rows: 5, cols: 3 });
    putAll(b, { A1: 1, B1: "=A1*2" });
    expect(val(b, "B1")).toBe(2);
    const inside: unknown[] = [];
    b.doc.transact(() => {
      put(b, "A1", 5);
      inside.push(val(b, "B1"));
      rowsOf(b).insert(0, ["n0"]);
      inside.push(b.engine.valueAt(b.first, 1, 1));
      put(b, "A2", 7);
      inside.push(b.engine.valueAt(b.first, 1, 1));
    });
    expect(inside).toEqual([10, 10, 14]);
    expect(b.engine.valueAt(b.first, 1, 1)).toBe(14);
  });
});

describe("what the apps show", () => {
  test("display per number format, with formats a formula takes from its inputs", () => {
    const b = book(["Sheet1"], { rows: 5, cols: 6, now: () => new Date(2026, 10, 17, 12) });
    put(b, "A1", 1234.5, { nf: '"R$" #,##0.00' });
    put(b, "A2", 0.125, { nf: "0.0%" });
    putAll(b, { B1: "=A1", B2: "=A2*2", B3: "=TODAY()", B4: "=SUM(A1:A1)", B5: "=1/0", C1: "=TRUE" });
    expect(shown(b, "B1", PT)).toBe("R$ 1.234,50");
    expect(shown(b, "B2", PT)).toBe("0,25");
    expect(shown(b, "B3", PT)).toBe("17/11/2026");
    expect(shown(b, "B3", EN)).toBe("11/17/2026");
    expect(shown(b, "B4", EN)).toBe("R$ 1,234.50");
    expect(shown(b, "B5", PT)).toBe("#DIV/0!");
    expect(shown(b, "C1", PT)).toBe("VERDADEIRO");
    expect(shown(b, "E5", EN)).toBe("");
  });

  test("input shows the formula in the person's language and values as they'd type them", () => {
    const b = book(["Sheet1"], { rows: 5, cols: 6 });
    putAll(b, { A1: 1234.5, A2: "=SUM(A1:A1,2.5)" });
    const [r1, c1] = keyAt(b, "A1").split(":") as [string, string];
    const [r2, c2] = keyAt(b, "A2").split(":") as [string, string];
    expect(b.engine.input(b.first, r1, c1, PT)).toBe("1234,5");
    expect(b.engine.input(b.first, r2, c2, PT)).toBe("=SOMA(A1:A1;2,5)");
    expect(b.engine.input(b.first, r2, c2, EN)).toBe("=SUM(A1:A1,2.5)");
    expect(b.engine.input(b.first, "nope", c2, EN)).toBe("");
  });

  test("errors in the reader's language, and their explanation", () => {
    const b = book(["Sheet1"], { rows: 5, cols: 6 });
    putAll(b, { A1: "=NA()", A2: '=1+"x"' });
    expect(shown(b, "A1", PT)).toBe("#N/D");
    expect(shown(b, "A2", PT)).toBe("#VALOR!");
    const [rowId, colId] = keyAt(b, "A2").split(":") as [string, string];
    expect(b.engine.errorInfo(b.first, rowId, colId)).toEqual({ code: "#VALUE!" });
  });

  test("a stored formula that doesn't parse reads as #NAME? instead of failing", () => {
    const b = book(["Sheet1"], { rows: 5, cols: 6 });
    b.doc.transact(() => cellsOf(b).set(keyAt(b, "A1"), { f: "SUM(" }));
    expect(val(b, "A1")).toEqual(err("#NAME?"));
  });

  test("the calculation language can change", () => {
    const b = book(["Sheet1"], { rows: 5, cols: 6 });
    putAll(b, { A1: 1.5, B1: '=A1&""' });
    expect(val(b, "B1")).toBe("1.5");
    const seen = listen(b);
    b.engine.setLocale("pt-BR");
    expect(seen.some((c) => c.all)).toBe(true);
    expect(val(b, "B1")).toBe("1,5");
  });

  test("an engine made before the document arrives catches up", () => {
    const source = book(["Sheet1"], { rows: 5, cols: 3 });
    putAll(source, { A1: 3, B1: "=A1*3" });
    const doc = new Y.Doc();
    const engine = new SheetEngine(doc);
    expect(engine.valueAt("s0", 0, 1)).toBeNull();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(source.doc));
    expect(engine.valueAt("s0", 0, 1)).toBe(9);
    const f = toCanonical("=A1+B1", { doc, sheetId: "s0", locale: EN });
    expect(f.ok).toBe(true);
  });
});
