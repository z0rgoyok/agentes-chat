import { describe, expect, test } from "bun:test";
import { type ShapeView, shapeIndex } from "@agenteschat/live/canvas";
import { arrowDraws, shapesIn } from "../../src/features/live-files/canvas/logic";

/**
 * The phone on a canvas's newer shapes (ADR 0196 §2), until it gets their tools: hidden shapes aren't drawn, a line has
 * no heads, an arrow may have one at each end.
 */

const shape = (s: Partial<ShapeView> & Pick<ShapeView, "id" | "type">): ShapeView => ({
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  z: "a0",
  ...s,
});

describe("newer shapes on the phone", () => {
  test("a hidden shape isn't laid out, even when chosen", () => {
    const list = [
      shape({ id: "seen", type: "note", w: 100, h: 100 }),
      shape({ id: "hidden", type: "note", w: 100, h: 100, hidden: true }),
    ];
    const box = { x: -500, y: -500, w: 1000, h: 1000 };
    expect(shapesIn(list, shapeIndex(list), box, new Set(["hidden"])).map((s) => s.id)).toEqual(["seen"]);
  });

  test("heads: an arrow's end by default, none on a line, both when asked", () => {
    const list = [
      shape({ id: "arrow", type: "arrow", from: { x: 0, y: 0 }, to: { x: 100, y: 0 } }),
      shape({
        id: "line",
        type: "arrow",
        from: { x: 0, y: 50 },
        to: { x: 100, y: 50 },
        heads: { start: "none", end: "none" },
      }),
      shape({
        id: "both",
        type: "arrow",
        from: { x: 0, y: 90 },
        to: { x: 100, y: 90 },
        heads: { start: "arrow", end: "arrow" },
        route: "curve",
      }),
    ];
    const draws = arrowDraws(list, shapeIndex(list));
    expect(draws.map((d) => [d.id, d.startHead, d.endHead])).toEqual([
      ["arrow", false, true],
      ["line", false, false],
      ["both", true, true],
    ]);
  });
});
