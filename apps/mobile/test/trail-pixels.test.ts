import { describe, expect, test } from "bun:test";
import { markCells, STRIP_ROWS, stripCells, stripWidth } from "../src/features/browser/trail-pixels";

const tones = { raised: "#ffffff", danger: "#b42a20" };
const count = (runs: { cells: number[] }[]) => runs.reduce((n, r) => n + r.cells.length / 2, 0);
const inside = (runs: { cells: number[] }[], w: number, h: number) =>
  runs.every((r) => r.cells.every((v, i) => v >= 0 && v < (i % 2 === 0 ? w : h)));

describe("the steps' band pixels on the phone (the web's drawings as cells)", () => {
  test("the strip: one 3-cell column per step on the 7-row line, an open taller than an action", () => {
    expect(stripWidth(3)).toBe(11);
    const open = count(stripCells(["open"], "sky", tones));
    const act = count(stripCells(["act"], "sky", tones));
    const shot = count(stripCells(["shot"], "sky", tones));
    expect(open).toBe(3 * STRIP_ROWS);
    expect(act).toBe(3 * 3);
    expect(shot).toBe(3 * 2);
    const runs = stripCells(["open", "read", "act", "shot", "failed"], "violet", tones);
    expect(inside(runs, stripWidth(5), STRIP_ROWS)).toBe(true);
  });

  test("a failure is drawn in the danger tones, never the agent's", () => {
    const colors = markCells("failed", "green", tones).map((r) => r.color);
    expect(colors).toContain("#b42a20");
    expect(colors.every((c) => c === "#b42a20" || c.startsWith("#"))).toBe(true);
    expect(markCells("open", "green", tones).some((r) => r.color === "#b42a20")).toBe(false);
  });
});
