import { describe, expect, test } from "bun:test";
import {
  axisStarts,
  boxOnScreen,
  clampCamera,
  drawnBox,
  type GridAxes,
  gridSegments,
  HEADER_H,
  hitCell,
  indexAt,
  MAX_ZOOM,
  MIN_ZOOM,
  ROW_BLOCK,
  revealCamera,
  rowHeaderWidth,
  spanBox,
  visibleBox,
  withMerges,
  zoomCamera,
} from "../../src/features/live-files/spreadsheet/grid-view";

/** A sheet of `rows` × `cols` at the default sizes (rows 24, columns 100), `frozen` rows and columns kept on screen. */
function axes(rows = 100, cols = 26, frozen = { rows: 0, cols: 0 }): GridAxes {
  return {
    rowStarts: axisStarts(Array.from({ length: rows }, () => 24)),
    colStarts: axisStarts(Array.from({ length: cols }, () => 100)),
    frozenRows: frozen.rows,
    frozenCols: frozen.cols,
    headerW: rowHeaderWidth(rows),
  };
}

const PHONE = { width: 390, height: 600 };

describe("live spreadsheet on the phone: the grid's axes (ADR 0196)", () => {
  test("where rows start, and the row under a point, clamped to the sheet", () => {
    const starts = axisStarts([24, 30, 24]);
    expect(starts).toEqual([0, 24, 54, 78]);
    expect(indexAt(starts, -5)).toBe(0);
    expect(indexAt(starts, 23.9)).toBe(0);
    expect(indexAt(starts, 24)).toBe(1);
    expect(indexAt(starts, 53)).toBe(1);
    expect(indexAt(starts, 54)).toBe(2);
    expect(indexAt(starts, 1000)).toBe(2);
    expect(indexAt([0], 10)).toBe(-1);
    // A size that can't be (negative) takes no room.
    expect(axisStarts([10, -4, 10])).toEqual([0, 10, 10, 20]);
  });

  test("the row numbers' strip grows with the last row's number", () => {
    expect(rowHeaderWidth(9)).toBe(36);
    expect(rowHeaderWidth(100)).toBe(38);
    expect(rowHeaderWidth(20000)).toBe(54);
  });
});

describe("the camera", () => {
  test("never shows past the sheet's first or last row and column", () => {
    const a = axes(100, 26);
    expect(clampCamera(-50, -50, 1, PHONE, a)).toEqual({ x: 0, y: 0 });
    const end = clampCamera(1e9, 1e9, 1, PHONE, a);
    // The last column's right edge meets the screen's right edge, the last row's bottom its bottom.
    expect(end.x + (PHONE.width - a.headerW)).toBeCloseTo(2600);
    expect(end.y + (PHONE.height - HEADER_H)).toBeCloseTo(2400);
    // A sheet smaller than the screen stays at its start.
    expect(clampCamera(500, 500, 1, PHONE, axes(3, 2))).toEqual({ x: 0, y: 0 });
  });

  test("frozen rows and columns: the scrolling part starts after them", () => {
    const a = axes(100, 26, { rows: 1, cols: 1 });
    expect(clampCamera(0, 0, 1, PHONE, a)).toEqual({ x: 100, y: 24 });
  });

  test("a pinch keeps the cell under the fingers where it was, between half and twice the size", () => {
    const a = axes(200, 40);
    const camera = { x: 300, y: 480, s: 1 };
    const focal = { x: 200, y: 300 };
    const before = hitCell(focal, camera, a);
    const zoomed = zoomCamera(camera, 1.7, focal, PHONE, a);
    expect(zoomed.s).toBe(1.7);
    expect(hitCell(focal, zoomed, a)).toEqual(before);
    expect(zoomCamera(camera, 10, focal, PHONE, a).s).toBe(MAX_ZOOM);
    expect(zoomCamera(camera, 0.01, focal, PHONE, a).s).toBe(MIN_ZOOM);
  });

  test("bringing a cell into view moves as little as it takes", () => {
    const a = axes(100, 26);
    const camera = { x: 0, y: 0, s: 1 };
    // Already in view: nothing moves.
    expect(revealCamera(camera, { r1: 2, c1: 1, r2: 2, c2: 1 }, PHONE, a)).toEqual({ x: 0, y: 0 });
    // Below the view: its bottom edge comes to the screen's bottom.
    const below = revealCamera(camera, { r1: 60, c1: 0, r2: 60, c2: 0 }, PHONE, a);
    expect(below.y + (PHONE.height - HEADER_H)).toBeCloseTo(61 * 24);
    expect(below.x).toBe(0);
    // Left of the view: its left edge comes to the pane's left.
    expect(revealCamera({ x: 900, y: 0, s: 1 }, { r1: 0, c1: 3, r2: 0, c2: 3 }, PHONE, a).x).toBe(300);
  });
});

describe("hit testing", () => {
  const a = axes(100, 26, { rows: 1, cols: 1 });
  const camera = { x: 500, y: 240, s: 1 };

  test("a tap on the cells reads through the camera; on the headers it says which strip", () => {
    const pane = { x: a.headerW + 100, y: HEADER_H + 24 };
    expect(hitCell({ x: pane.x + 5, y: pane.y + 5 }, camera, a)).toEqual({ row: 10, col: 5 });
    expect(hitCell({ x: pane.x + 5, y: 4 }, camera, a)).toEqual({ row: -1, col: 5 });
    expect(hitCell({ x: 4, y: pane.y + 5 }, camera, a)).toEqual({ row: 10, col: -1 });
    expect(hitCell({ x: 4, y: 4 }, camera, a)).toEqual({ row: -1, col: -1 });
  });

  test("a tap on the frozen row or column is on it, whatever the camera", () => {
    expect(hitCell({ x: a.headerW + 50, y: HEADER_H + 10 }, camera, a)).toEqual({ row: 0, col: 0 });
    expect(hitCell({ x: a.headerW + 150, y: HEADER_H + 10 }, camera, a)).toEqual({ row: 0, col: 5 });
  });

  test("at another zoom the same cell is under its scaled place", () => {
    const zoomed = { x: 500, y: 240, s: 2 };
    const origin = { x: a.headerW + 100 * 2, y: HEADER_H + 24 * 2 };
    expect(hitCell({ x: origin.x + 150, y: origin.y + 30 }, zoomed, a)).toEqual({ row: 10, col: 5 });
  });

  test("a block on screen is cut where the frozen part covers it", () => {
    const r = boxOnScreen({ r1: 10, c1: 5, r2: 10, c2: 5 }, camera, a);
    expect(r).toEqual({ x: a.headerW + 100, y: HEADER_H + 24, w: 100, h: 24 });
    // Scrolled under the frozen column: no width left.
    const under = boxOnScreen({ r1: 10, c1: 2, r2: 10, c2: 2 }, camera, a);
    expect(under?.w).toBe(0);
    expect(boxOnScreen({ r1: 0, c1: 0, r2: 200, c2: 0 }, camera, a)).toBeNull();
  });
});

describe("windowing: only what the screen shows is laid out", () => {
  test("the visible rows and columns, after the frozen ones", () => {
    const a = axes(1000, 50, { rows: 1, cols: 0 });
    const v = visibleBox({ x: 0, y: 24 + 24 * 100, s: 1 }, PHONE, a);
    expect(v.r1).toBe(101);
    expect(v.c1).toBe(0);
    expect(v.c2).toBe(3);
    expect(v.r2 - v.r1).toBeLessThan(30);
  });

  test("the drawn block rounds out to whole blocks with one to spare, so a pan redraws rarely", () => {
    const d = drawnBox({ r1: 40, c1: 5, r2: 60, c2: 8 }, 1000, 50);
    expect(d.r1 % ROW_BLOCK).toBe(0);
    expect(d.r1).toBeLessThan(40);
    expect(d.r2).toBeGreaterThan(60);
    expect(d.c1).toBeLessThanOrEqual(5);
    expect(d.c2).toBeGreaterThanOrEqual(8);
    // Moving within a block draws the same cells.
    expect(drawnBox({ r1: 41, c1: 5, r2: 61, c2: 8 }, 1000, 50)).toEqual(d);
    // Never past the sheet, never over the frozen part.
    expect(drawnBox({ r1: 0, c1: 0, r2: 5, c2: 2 }, 6, 3, 1, 1)).toEqual({ r1: 1, c1: 1, r2: 5, c2: 2 });
    expect(drawnBox({ r1: 1, c1: 0, r2: 0, c2: 0 }, 6, 3)).toEqual({ r1: 0, c1: 0, r2: -1, c2: -1 });
  });

  test("a large sheet draws a bounded number of lines whatever its size", () => {
    const big = axes(20000, 500);
    const seg = gridSegments({ x: 25_000, y: 240_000, s: 0.5 }, PHONE, big);
    expect(seg.length % 4).toBe(0);
    expect(seg.length / 4).toBeLessThan(120);
    for (let i = 0; i < seg.length; i++) expect(Number.isFinite(seg[i])).toBe(true);
  });
});

describe("selections", () => {
  test("a drag selects from where it started to where it is, in order", () => {
    expect(spanBox({ row: 9, col: 4 }, { row: 2, col: 1 })).toEqual({ r1: 2, c1: 1, r2: 9, c2: 4 });
  });

  test("a merge touched is selected whole, and merges chained by it too", () => {
    const merges = [
      { r1: 2, c1: 2, r2: 3, c2: 4 },
      { r1: 4, c1: 4, r2: 6, c2: 5 },
    ];
    expect(withMerges({ r1: 3, c1: 3, r2: 3, c2: 3 }, merges)).toEqual({ r1: 2, c1: 2, r2: 3, c2: 4 });
    expect(withMerges({ r1: 3, c1: 4, r2: 4, c2: 4 }, merges)).toEqual({ r1: 2, c1: 2, r2: 6, c2: 5 });
    expect(withMerges({ r1: 0, c1: 0, r2: 0, c2: 0 }, merges)).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 });
  });
});
