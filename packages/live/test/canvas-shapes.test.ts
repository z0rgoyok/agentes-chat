import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  addShape,
  arrowHeadPoints,
  canvasPreview,
  fillPending,
  initCanvas,
  pointsBounds,
  readShapeById,
  readShapes,
  resizeShape,
  routeArrow,
  strokePath,
  updateShape,
  validateCanvas,
} from "../src/canvas";
import { shapesMapOf } from "../src/canvas/store";
import { LiveEditError } from "../src/errors";
import { LIVE_LIMITS } from "../src/limits";
import { agentOrigin, LOCAL, SYSTEM } from "../src/origins";

/**
 * The canvas's shapes beyond the first ones (ADR 0196 §2): triangles and stars, borders and corners, arrows that curve
 * or bend and lines without heads, pen strokes, a picture's crop, who made each shape and the layers' eye.
 */

function canvas(): Y.Doc {
  const doc = new Y.Doc();
  initCanvas(doc, SYSTEM);
  return doc;
}

/** A shape's map as some client wrote it, past `addShape` (at the origin, 1 × 1 unless given). */
function rawShape(values: Record<string, unknown>): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries({ x: 0, y: 0, w: 1, h: 1, ...values })) map.set(key, value);
  return map;
}

function expectRefused(doc: Y.Doc, code: LiveEditError["code"], edit: () => void): void {
  const before = Y.encodeStateVector(doc);
  let error: unknown;
  try {
    edit();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(LiveEditError);
  expect((error as LiveEditError).code).toBe(code);
  expect(Y.encodeStateVector(doc)).toEqual(before);
}

describe("shapes: forms, borders and corners", () => {
  test("triangles and stars, a border's color and width, a rectangle's corners", () => {
    const doc = canvas();
    const star = addShape(doc, { type: "shape", kind: "star", x: 0, y: 0, stroke: "#e5484d", strokeWidth: 4 }, LOCAL);
    const tri = addShape(doc, { type: "shape", kind: "triangle", x: 300, y: 0, fill: "none" }, LOCAL);
    const rect = addShape(doc, { type: "shape", x: 600, y: 0, radius: 24 }, LOCAL);
    expect(readShapeById(doc, star)).toMatchObject({ kind: "star", stroke: "#e5484d", strokeWidth: 4 });
    expect(readShapeById(doc, tri)).toMatchObject({ kind: "triangle", fill: "none" });
    expect(readShapeById(doc, rect)).toMatchObject({ kind: "rect", radius: 24 });
    updateShape(doc, rect, { kind: "ellipse", strokeWidth: 12, radius: null }, LOCAL);
    expect(readShapeById(doc, rect)).toMatchObject({ kind: "ellipse", strokeWidth: 12 });
    expect(readShapeById(doc, rect)?.radius).toBeUndefined();
  });

  test("past the limits, refused whole", () => {
    const doc = canvas();
    const shape = addShape(doc, { type: "shape", x: 0, y: 0 }, LOCAL);
    expectRefused(doc, "invalid", () => addShape(doc, { type: "shape", kind: "hexagon" as never }, LOCAL));
    expectRefused(doc, "invalid", () => addShape(doc, { type: "shape", strokeWidth: 0 }, LOCAL));
    expectRefused(doc, "invalid", () => addShape(doc, { type: "shape", strokeWidth: 25 }, LOCAL));
    expectRefused(doc, "invalid", () => addShape(doc, { type: "shape", radius: 201 }, LOCAL));
    expectRefused(doc, "invalid", () => updateShape(doc, shape, { radius: -1 }, LOCAL));
    // A note has no border.
    const note = addShape(doc, { type: "note", x: 0, y: 400 }, LOCAL);
    expectRefused(doc, "invalid", () => updateShape(doc, note, { strokeWidth: 2 }, LOCAL));
  });
});

describe("arrows and lines", () => {
  test("a route, heads, a color and a width; a line is an arrow without heads", () => {
    const doc = canvas();
    const a = addShape(doc, { type: "note", x: 0, y: 0 }, LOCAL);
    const b = addShape(doc, { type: "note", x: 600, y: 300 }, LOCAL);
    const arrow = addShape(
      doc,
      { type: "arrow", from: { shape: a }, to: { shape: b }, route: "elbow", stroke: "#0063d1", strokeWidth: 3 },
      LOCAL,
    );
    const line = addShape(
      doc,
      { type: "arrow", from: { x: 0, y: 800 }, to: { x: 500, y: 800 }, heads: { start: "none", end: "none" } },
      LOCAL,
    );
    expect(readShapeById(doc, arrow)).toMatchObject({ route: "elbow", stroke: "#0063d1", strokeWidth: 3 });
    expect(readShapeById(doc, arrow)?.heads).toBeUndefined();
    expect(readShapeById(doc, line)?.heads).toEqual({ start: "none", end: "none" });
    updateShape(doc, arrow, { route: "curve", heads: { start: "arrow", end: "arrow" }, dashed: true }, LOCAL);
    expect(readShapeById(doc, arrow)).toMatchObject({
      route: "curve",
      heads: { start: "arrow", end: "arrow" },
      dashed: true,
    });
    updateShape(doc, arrow, { route: null, heads: null }, LOCAL);
    expect(readShapeById(doc, arrow)?.route).toBeUndefined();
    expect(readShapeById(doc, arrow)?.heads).toBeUndefined();
    expectRefused(doc, "invalid", () => updateShape(doc, arrow, { route: "zigzag" as never }, LOCAL));
    expectRefused(doc, "invalid", () => updateShape(doc, arrow, { heads: { end: "dot" as never } }, LOCAL));
  });

  test("the preview carries the route and the heads", () => {
    const doc = canvas();
    const a = addShape(doc, { type: "note", x: 0, y: 0 }, LOCAL);
    const b = addShape(doc, { type: "note", x: 600, y: 0 }, LOCAL);
    const arrow = addShape(
      doc,
      { type: "arrow", from: { shape: a }, to: { shape: b }, route: "curve", heads: { end: "none" } },
      LOCAL,
    );
    const item = canvasPreview(doc).shapes.find((s) => s.id === arrow);
    // Arrows have no area: they are the last a preview keeps, and there's room for them here.
    expect(item).toMatchObject({ type: "arrow", route: "curve", heads: { end: "none" } });
    expect(item?.line).toEqual({ x1: 200, y1: 100, x2: 600, y2: 100 });
  });
});

describe("pen strokes", () => {
  test("points from (x, y): the box moves to where they are and takes their extent", () => {
    const doc = canvas();
    const id = addShape(
      doc,
      { type: "draw", x: 100, y: 100, points: [10, 10, 50, 30, 90, 10], stroke: "#e5484d", strokeWidth: 4 },
      agentOrigin("atlas", "run-1"),
    );
    expect(readShapeById(doc, id)).toMatchObject({
      type: "draw",
      x: 110,
      y: 110,
      w: 80,
      h: 20,
      points: [0, 0, 40, 20, 80, 0],
      stroke: "#e5484d",
      strokeWidth: 4,
    });
    // Without (x, y) the points are where they are on the canvas; the marker is kept.
    const marker = addShape(doc, { type: "draw", points: [-50, -20, -10, -40], tool: "marker" }, LOCAL);
    expect(readShapeById(doc, marker)).toMatchObject({ x: -50, y: -40, w: 40, h: 20, tool: "marker" });
    expect(readShapeById(doc, marker)?.points).toEqual([0, 20, 40, 0]);
  });

  test("stretching the box stretches the stroke; new points take a new box", () => {
    const doc = canvas();
    const id = addShape(doc, { type: "draw", x: 0, y: 0, points: [0, 0, 100, 50] }, LOCAL);
    resizeShape(doc, id, { x: 0, y: 0, w: 200, h: 25 }, LOCAL);
    expect(readShapeById(doc, id)?.points).toEqual([0, 0, 200, 25]);
    updateShape(doc, id, { points: [10, 10, 30, 70] }, LOCAL);
    expect(readShapeById(doc, id)).toMatchObject({ x: 10, y: 10, w: 20, h: 60, points: [0, 0, 20, 60] });
  });

  test("refused: no points, an odd count, past the limit, text on a stroke", () => {
    const doc = canvas();
    expectRefused(doc, "invalid", () => addShape(doc, { type: "draw", x: 0, y: 0 }, LOCAL));
    expectRefused(doc, "invalid", () => addShape(doc, { type: "draw", points: [1, 2, 3] }, LOCAL));
    expectRefused(doc, "invalid", () => addShape(doc, { type: "draw", points: [1, Number.NaN] }, LOCAL));
    const many = Array.from({ length: LIVE_LIMITS.canvas.drawPoints + 2 }, (_, i) => i);
    expectRefused(doc, "invalid", () => addShape(doc, { type: "draw", points: many }, LOCAL));
    expectRefused(doc, "invalid", () => addShape(doc, { type: "draw", points: [0, 0, 1, 1], text: "hi" }, LOCAL));
    expectRefused(doc, "invalid", () =>
      addShape(doc, { type: "draw", points: [0, 0, 1, 1], tool: "brush" as never }, LOCAL),
    );
  });

  test("a preview keeps a few of its points, first and last", () => {
    const doc = canvas();
    const points = Array.from({ length: 1000 }, (_, i) => (i % 2 === 0 ? i : (i * 7) % 300));
    const id = addShape(doc, { type: "draw", x: 0, y: 0, points, tool: "marker" }, LOCAL);
    const item = canvasPreview(doc).shapes.find((s) => s.id === id);
    const kept = item?.points ?? [];
    const stored = readShapeById(doc, id)?.points ?? [];
    expect(kept.length).toBeLessThanOrEqual(120);
    expect(kept.length % 2).toBe(0);
    expect(kept.slice(0, 2)).toEqual(stored.slice(0, 2).map(Math.round));
    expect(kept.slice(-2)).toEqual(stored.slice(-2).map(Math.round));
    expect(item?.tool).toBe("marker");
  });

  test("a stroke written past the rules by a client is a problem the server refuses", () => {
    const doc = canvas();
    addShape(doc, { type: "draw", points: [0, 0, 10, 10] }, LOCAL);
    expect(validateCanvas(doc)).toEqual([]);
    shapesMapOf(doc).set(
      "big",
      rawShape({ type: "draw", z: "a0", points: Array.from({ length: LIVE_LIMITS.canvas.drawPoints + 2 }, () => 1) }),
    );
    shapesMapOf(doc).set("odd", rawShape({ type: "draw", z: "a1", points: [1, 2, "x"] }));
    const problems = validateCanvas(doc);
    expect(problems.some((p) => p.includes("big") && p.includes("over"))).toBe(true);
    expect(problems.some((p) => p.includes("odd") && p.includes("broken"))).toBe(true);
    // Read leniently all the same: a stroke without points, never a crash.
    expect(readShapes(doc).find((s) => s.id === "odd")?.points).toBeUndefined();
  });
});

describe("pictures: the part shown", () => {
  test("a crop in fractions of the picture, inside it", () => {
    const doc = canvas();
    const id = addShape(doc, { type: "image", asset: "asset-1", nw: 1000, nh: 500, x: 0, y: 0 }, LOCAL);
    updateShape(doc, id, { crop: { x: 0.25, y: 0, w: 0.5, h: 1 } }, LOCAL);
    expect(readShapeById(doc, id)?.crop).toEqual({ x: 0.25, y: 0, w: 0.5, h: 1 });
    expect(canvasPreview(doc).shapes[0]?.crop).toEqual({ x: 0.25, y: 0, w: 0.5, h: 1 });
    expectRefused(doc, "invalid", () => updateShape(doc, id, { crop: { x: 0.6, y: 0, w: 0.5, h: 1 } }, LOCAL));
    expectRefused(doc, "invalid", () => updateShape(doc, id, { crop: { x: 0, y: 0, w: 0, h: 1 } }, LOCAL));
    expectRefused(doc, "invalid", () => updateShape(doc, id, { crop: { x: -0.1, y: 0, w: 0.5, h: 1 } }, LOCAL));
    updateShape(doc, id, { crop: null }, LOCAL);
    expect(readShapeById(doc, id)?.crop).toBeUndefined();
  });
});

describe("who made it, and the layers' eye", () => {
  test("set from the change's origin, unless given; the app's own edits name no one", () => {
    const doc = canvas();
    const byAgent = addShape(doc, { type: "note", x: 0, y: 0 }, agentOrigin("atlas", "run-1"));
    const byPerson = addShape(doc, { type: "note", x: 300, y: 0 }, { kind: "system", userId: "ada" });
    const given = addShape(doc, { type: "note", x: 600, y: 0, by: { kind: "person", id: "ada" } }, LOCAL);
    const local = addShape(doc, { type: "note", x: 900, y: 0 }, LOCAL);
    expect(readShapeById(doc, byAgent)?.by).toEqual({ kind: "agent", id: "atlas" });
    expect(readShapeById(doc, byPerson)?.by).toEqual({ kind: "person", id: "ada" });
    expect(readShapeById(doc, given)?.by).toEqual({ kind: "person", id: "ada" });
    expect(readShapeById(doc, local)?.by).toBeUndefined();
    expectRefused(doc, "invalid", () =>
      addShape(doc, { type: "note", by: { kind: "robot", id: "x" } as never }, LOCAL),
    );
  });

  test("a picture keeps who asked for it when it replaces its placeholder", () => {
    const doc = canvas();
    const ada = { kind: "person" as const, id: "ada" };
    const pending = addShape(
      doc,
      { type: "pending", x: 0, y: 0, w: 100, h: 100, prompt: "a cat", request: "req-1", index: 0, by: ada },
      SYSTEM,
    );
    expect(readShapeById(doc, pending)?.by).toEqual(ada);
    fillPending(doc, pending, { asset: "asset-1", nw: 100, nh: 100 }, SYSTEM);
    expect(readShapeById(doc, pending)).toMatchObject({ type: "image", by: ada });
  });

  test("hidden shapes are kept, read, and left out of the preview and its bounds", () => {
    const doc = canvas();
    const shown = addShape(doc, { type: "note", x: 0, y: 0, w: 100, h: 100 }, LOCAL);
    const hidden = addShape(doc, { type: "note", x: 5000, y: 5000, w: 100, h: 100, hidden: true }, LOCAL);
    expect(readShapeById(doc, hidden)?.hidden).toBe(true);
    const preview = canvasPreview(doc);
    expect(preview.count).toBe(2);
    expect(preview.shapes.map((s) => s.id)).toEqual([shown]);
    expect(preview.bounds).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    updateShape(doc, hidden, { hidden: false }, LOCAL);
    expect(readShapeById(doc, hidden)?.hidden).toBeUndefined();
    expect(canvasPreview(doc).shapes).toHaveLength(2);
  });

  test("a canvas written before these fields reads as it did", () => {
    const doc = canvas();
    const atlas = { kind: "agent", id: "atlas" };
    shapesMapOf(doc).set(
      "old",
      rawShape({ type: "pending", w: 512, h: 512, z: "a0", request: "req-1", prompt: "a fox", by: atlas }),
    );
    shapesMapOf(doc).set("arrow", rawShape({ type: "arrow", z: "a1", from: { x: 0, y: 0 }, to: { x: 100, y: 0 } }));
    expect(validateCanvas(doc)).toEqual([]);
    expect(readShapeById(doc, "old")).toMatchObject({ type: "pending", status: "queued", by: atlas });
    const view = readShapeById(doc, "arrow");
    expect(view?.route).toBeUndefined();
    expect(view?.heads).toBeUndefined();
    expect(view?.hidden).toBeUndefined();
  });
});

describe("geometry of the new shapes", () => {
  test("routes: straight, a curve bowing to the left of its way, right angles on the longer axis", () => {
    const line = { x1: 0, y1: 0, x2: 200, y2: 0 };
    const straight = routeArrow(line);
    expect(straight.d).toBe("M0 0 L200 0");
    expect(straight.endDir).toEqual({ x: 1, y: 0 });
    const curve = routeArrow(line, "curve");
    expect(curve.d).toBe("M0 0 Q100 -50 200 0");
    expect(curve.mid).toEqual({ x: 100, y: -25 });
    expect(curve.endDir.y).toBeGreaterThan(0);
    const elbow = routeArrow({ x1: 0, y1: 0, x2: 200, y2: 100 }, "elbow");
    expect(elbow.d).toBe("M0 0 L100 0 L100 100 L200 100");
    expect(elbow.endDir).toEqual({ x: 1, y: 0 });
    const tall = routeArrow({ x1: 0, y1: 0, x2: 50, y2: 300 }, "elbow");
    expect(tall.d).toBe("M0 0 L0 150 L50 150 L50 300");
    expect(tall.startDir).toEqual({ x: 0, y: 1 });
    // On one line, an elbow is that line.
    expect(routeArrow(line, "elbow").d).toBe("M0 0 L200 0");
  });

  test("trimmed ends stop short of the heads' tips; heads point along the way", () => {
    const routed = routeArrow({ x1: 0, y1: 0, x2: 100, y2: 0 }, "straight", { start: 10, end: 20 });
    expect(routed.d).toBe("M10 0 L80 0");
    expect(routed.end).toEqual({ x: 100, y: 0 });
    const [tip, left, right] = arrowHeadPoints({ x: 100, y: 0 }, { x: 1, y: 0 }, 10);
    expect(tip).toEqual({ x: 100, y: 0 });
    expect(left.x).toBeCloseTo(90, 6);
    expect(right.x).toBeCloseTo(90, 6);
    expect(Math.abs(left.y)).toBeCloseTo(4.5, 6);
    expect(left.y).toBeCloseTo(-right.y, 6);
  });

  test("a stroke's path and box", () => {
    expect(strokePath([])).toBe("");
    expect(strokePath([5, 5])).toBe("M5 5 L5.01 5");
    expect(strokePath([0, 0, 10, 10])).toBe("M0 0 L10 10");
    expect(strokePath([0, 0, 10, 0, 10, 10])).toBe("M0 0 Q10 0 10 5 L10 10");
    expect(pointsBounds([3, 4, -1, 9])).toEqual({ x: -1, y: 4, w: 4, h: 5 });
    expect(pointsBounds([])).toBeNull();
  });
});
