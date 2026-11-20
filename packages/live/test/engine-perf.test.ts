import { describe, expect, test } from "bun:test";
import { book, cellsOf, keyAt, put, rowsOf } from "./formula-helpers";

const ROWS = 10_000;

/** 10,000 rows: a number in A and five formulas per row (B, C, E, F, G), 50,000 formulas in all. */
function bigBook() {
  const b = book(["Sheet1"], { rows: ROWS, cols: 8 });
  const cells = cellsOf(b);
  b.doc.transact(() => {
    for (let i = 0; i < ROWS; i++) {
      const r = `r${i}`;
      cells.set(`${r}:c0`, { v: i });
      cells.set(`${r}:c1`, { f: `{${r},c0}*2` });
      cells.set(`${r}:c2`, { f: `{${r},c1}+{${r},c0}` });
      cells.set(`${r}:c4`, { f: `SUM({${r},c0}:{${r},c2})` });
      cells.set(`${r}:c5`, { f: `IF({${r},c4}>100,{${r},c4},0)` });
      cells.set(`${r}:c6`, { f: `{${r},c5}+{${r},c1}` });
    }
  });
  return b;
}

function readAll(b: ReturnType<typeof book>): number {
  let sum = 0;
  for (let i = 0; i < ROWS; i++) {
    for (const c of [1, 2, 4, 5, 6]) sum += b.engine.valueAt(b.first, i, c) as number;
  }
  return sum;
}

describe("performance", () => {
  test("50,000 formulas compute well under a second, and one edit recomputes only its row", () => {
    const b = bigBook();
    const t0 = performance.now();
    const total = readAll(b);
    const cold = performance.now() - t0;
    expect(b.engine.computations()).toBe(ROWS * 5);
    // Row i: B 2i, C 3i, E 6i, F 6i when 6i > 100, G F + 2i.
    let expected = 0;
    for (let i = 0; i < ROWS; i++)
      expected += 2 * i + 3 * i + 6 * i + (6 * i > 100 ? 6 * i : 0) + (6 * i > 100 ? 6 * i : 0) + 2 * i;
    expect(total).toBe(expected);
    expect(cold).toBeLessThan(1000);

    const before = b.engine.computations();
    put(b, "A5001", -1);
    const t1 = performance.now();
    readAll(b);
    const warm = performance.now() - t1;
    expect(b.engine.computations() - before).toBe(5);
    expect(b.engine.valueAt(b.first, 5000, 6)).toBe(-2);

    // A row inserted at the top moves every row: the sheet recomputes as a whole.
    b.doc.transact(() => rowsOf(b).insert(0, ["top"]));
    const t2 = performance.now();
    let n = 0;
    for (let i = 1; i <= ROWS; i++) for (const c of [1, 2, 4, 5, 6]) if (b.engine.valueAt(b.first, i, c) !== null) n++;
    const structural = performance.now() - t2;
    expect(n).toBe(ROWS * 5);
    expect(structural).toBeLessThan(1000);
    console.log(
      `[engine] 50k formulas: cold ${cold.toFixed(0)} ms, after one edit ${warm.toFixed(0)} ms (5 recomputed), after a row insert ${structural.toFixed(0)} ms`,
    );
  });

  test("many formulas over one large range share its values", () => {
    const b = book(["Sheet1"], { rows: ROWS, cols: 3 });
    const cells = cellsOf(b);
    b.doc.transact(() => {
      for (let i = 0; i < ROWS; i++) cells.set(`r${i}:c0`, { v: 1 });
      for (let i = 0; i < 2000; i++) cells.set(`r${i}:c1`, { f: `SUM({$r0,c0}:{$r${ROWS - 1},c0})*{r${i},c0}` });
    });
    const t0 = performance.now();
    let s = 0;
    for (let i = 0; i < 2000; i++) s += b.engine.valueAt(b.first, i, 1) as number;
    const took = performance.now() - t0;
    expect(s).toBe(2000 * ROWS);
    expect(took).toBeLessThan(1000);
    put(b, "A9000", 2);
    expect(b.engine.valueAt(b.first, 0, 1)).toBe(ROWS + 1);
    expect(b.engine.valueAt(b.first, 1999, 1)).toBe(ROWS + 1);
    console.log(`[engine] 2,000 sums over 10,000 rows: ${took.toFixed(0)} ms`);
  });

  test("a 20,000-row running total", () => {
    const n = 20_000;
    const b = book(["Sheet1"], { rows: n, cols: 3 });
    const cells = cellsOf(b);
    b.doc.transact(() => {
      for (let i = 0; i < n; i++) {
        cells.set(`r${i}:c0`, { v: 1 });
        cells.set(`r${i}:c1`, { f: i === 0 ? "{r0,c0}" : `{r${i - 1},c1}+{r${i},c0}` });
      }
    });
    const t0 = performance.now();
    expect(b.engine.valueAt(b.first, n - 1, 1)).toBe(n);
    const took = performance.now() - t0;
    expect(took).toBeLessThan(1000);
    put(b, "A1", 5);
    expect(b.engine.valueAt(b.first, n - 1, 1)).toBe(n + 4);
    expect(keyAt(b, "B1")).toBe("r0:c1");
    console.log(`[engine] 20,000-deep chain: ${took.toFixed(0)} ms`);
  });
});
