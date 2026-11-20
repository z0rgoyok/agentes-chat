import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  addShape,
  arrange,
  arrowPath,
  type Box,
  canvasPreview,
  canvasText,
  containsPoint,
  contentBounds,
  deleteShapes,
  fillPending,
  frameAt,
  hitTest,
  initCanvas,
  moveShapes,
  placeBoxes,
  readShapeById,
  readShapes,
  rectsIntersect,
  replaceCanvas,
  resizeShape,
  rotatedBounds,
  setCanvasBackground,
  setParent,
  shapeBounds,
  shapeIndex,
  snapLines,
  union,
  updateShape,
  validateCanvas,
} from "../src/canvas";
import { shapesMapOf } from "../src/canvas/store";
import { LiveEditError } from "../src/errors";
import { agentOrigin, LOCAL, SYSTEM } from "../src/origins";
import { richText } from "../src/rich/text";

function canvas(): Y.Doc {
  const doc = new Y.Doc();
  initCanvas(doc, SYSTEM);
  return doc;
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

function boundsOf(doc: Y.Doc): Box[] {
  const shapes = readShapes(doc);
  const byId = shapeIndex(shapes);
  return shapes.map((shape) => shapeBounds(shape, byId));
}

/** A seeded random number generator, so a failure can be replayed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("a new canvas and its shapes", () => {
  test("starts empty, on dots", () => {
    const doc = canvas();
    expect(readShapes(doc)).toEqual([]);
    expect(contentBounds(doc)).toBeNull();
    expect(canvasPreview(doc)).toEqual({ bg: "dots", bounds: null, count: 0, shapes: [] });
    setCanvasBackground(doc, "grid", LOCAL);
    expect(canvasPreview(doc).bg).toBe("grid");
    expectRefused(doc, "invalid", () => setCanvasBackground(doc, "stars" as never, LOCAL));
  });

  test("each type with its defaults", () => {
    const doc = canvas();
    const note = addShape(doc, { type: "note", text: "**Idea**" }, LOCAL);
    const frame = addShape(doc, { type: "frame", name: "Ideas", x: 0, y: 1000 }, LOCAL);
    const image = addShape(doc, { type: "image", asset: "asset-1", nw: 2048, nh: 1024, x: 0, y: 2000 }, LOCAL);
    const shape = addShape(doc, { type: "shape", text: "Box", x: 900, y: 0 }, LOCAL);
    const arrow = addShape(doc, { type: "arrow", from: { shape: note }, to: { shape: shape } }, LOCAL);
    const pending = addShape(
      doc,
      { type: "pending", prompt: "a cat", request: "req-1", index: 0, by: { kind: "person", id: "ada" } },
      LOCAL,
    );
    const view = (id: string) => readShapeById(doc, id);
    expect(view(note)).toMatchObject({ type: "note", w: 200, h: 200, color: "yellow" });
    expect(view(note)?.text).toEqual([{ runs: [{ text: "Idea", bold: true }] }]);
    expect(view(frame)).toMatchObject({ type: "frame", name: "Ideas", x: 0, y: 1000, w: 800, h: 600 });
    expect(view(image)).toMatchObject({ w: 640, h: 320, nw: 2048, nh: 1024 });
    expect(view(shape)).toMatchObject({ kind: "rect", text: [{ runs: [{ text: "Box" }] }] });
    expect(view(arrow)?.from).toEqual({ shape: note });
    expect(view(pending)).toMatchObject({ status: "queued", w: 512, h: 512, prompt: "a cat" });
    // Frames are drawn under everything else.
    expect(readShapes(doc)[0]?.id).toBe(frame);
  });

  test("refused shapes change nothing", () => {
    const doc = canvas();
    const note = addShape(doc, { type: "note", x: 0, y: 0 }, LOCAL);
    expectRefused(doc, "invalid", () => addShape(doc, { type: "sticker" as never }, LOCAL));
    expectRefused(doc, "invalid", () => addShape(doc, { type: "image", text: "no text on images" }, LOCAL));
    expectRefused(doc, "invalid", () => addShape(doc, { type: "note", color: "orange" as never }, LOCAL));
    expectRefused(doc, "invalid", () => addShape(doc, { type: "arrow", from: { shape: note } }, LOCAL));
    expectRefused(doc, "not_found", () =>
      addShape(doc, { type: "arrow", from: { shape: note }, to: { shape: "gone" } }, LOCAL),
    );
    expectRefused(doc, "not_found", () => addShape(doc, { type: "note", parent: note }, LOCAL));
    expectRefused(doc, "too_large", () => addShape(doc, { type: "text", text: "x".repeat(20_001) }, LOCAL));
    expectRefused(doc, "invalid", () => updateShape(doc, note, { asset: "x" }, LOCAL));
    expectRefused(doc, "invalid", () => updateShape(doc, note, { x: null }, LOCAL));
    expectRefused(doc, "not_found", () => updateShape(doc, "gone", { x: 1 }, LOCAL));
  });

  test("updates change only what they name", () => {
    const doc = canvas();
    const note = addShape(doc, { type: "note", x: 0, y: 0, text: "a" }, LOCAL);
    updateShape(doc, note, { color: "pink", locked: true, rot: 370, text: "b" }, LOCAL);
    expect(readShapeById(doc, note)).toMatchObject({ color: "pink", locked: true, rot: 10 });
    expect(richText(readShapeById(doc, note)?.text ?? [])).toBe("b");
    updateShape(doc, note, { locked: false, rot: null }, LOCAL);
    const after = readShapeById(doc, note);
    expect(after?.locked).toBeUndefined();
    expect(after?.rot).toBeUndefined();
  });
});

describe("free room", () => {
  test("an empty canvas starts at the origin; then to the right of the last thing; a long row wraps below", () => {
    const doc = canvas();
    const first = placeBoxes(doc, { count: 2, w: 300, h: 200 });
    expect(first.boxes).toEqual([
      { x: 0, y: 0, w: 300, h: 200 },
      { x: 340, y: 0, w: 300, h: 200 },
    ]);
    addShape(doc, { type: "note", x: 0, y: 0, w: 600, h: 400 }, LOCAL);
    const next = placeBoxes(doc, { count: 1, w: 200, h: 200 });
    expect(next.boxes[0]).toEqual({ x: 680, y: 0, w: 200, h: 200 });
    addShape(doc, { type: "note", x: 6000, y: 0, w: 600, h: 400 }, LOCAL);
    const wrapped = placeBoxes(doc, { count: 1, w: 800, h: 200 });
    expect(wrapped.boxes[0]?.x).toBe(0);
    expect(wrapped.boxes[0]?.y).toBeGreaterThanOrEqual(400 + 40);
  });

  test("a batch in a new frame: padding inside, room for the frame's name above", () => {
    const doc = canvas();
    addShape(doc, { type: "note", x: 0, y: 0, w: 200, h: 200 }, LOCAL);
    const placed = placeBoxes(doc, { count: 4, w: 256, h: 256, gap: 40, frame: { name: "Cats" } });
    const frame = placed.frame as Box;
    expect(frame.w).toBe(4 * 256 + 3 * 40 + 2 * 40);
    expect(frame.h).toBe(256 + 2 * 40);
    for (const box of placed.boxes) {
      expect(box.x).toBeGreaterThanOrEqual(frame.x + 40);
      expect(box.y).toBeGreaterThanOrEqual(frame.y + 40);
      expect(box.x + box.w).toBeLessThanOrEqual(frame.x + frame.w - 40);
    }
    expect(rectsIntersect(frame, { x: 0, y: 0, w: 200, h: 200 }, 20)).toBe(false);
  });

  test("near a point when given, around what's there", () => {
    const doc = canvas();
    addShape(doc, { type: "note", x: -100, y: -100, w: 200, h: 200 }, LOCAL);
    const placed = placeBoxes(doc, { count: 1, w: 100, h: 100, near: { x: 0, y: 0 } });
    const box = placed.boxes[0] as Box;
    expect(rectsIntersect(box, { x: -100, y: -100, w: 200, h: 200 })).toBe(false);
    expect(Math.hypot(box.x + 50, box.y + 50)).toBeLessThan(400);
  });

  test("never on anything already there, nor on each other (random canvases)", () => {
    const rand = seeded(20261117);
    for (let round = 0; round < 250; round++) {
      const doc = canvas();
      const count = Math.floor(rand() * 40);
      doc.transact(() => {
        for (let i = 0; i < count; i++) {
          const w = 40 + rand() * 600;
          const h = 40 + rand() * 600;
          addShape(
            doc,
            {
              type: rand() < 0.2 ? "frame" : "note",
              x: Math.round(rand() * 4000 - 1000),
              y: Math.round(rand() * 3000 - 800),
              w,
              h,
              ...(rand() < 0.2 ? { rot: Math.round(rand() * 90) } : {}),
            },
            LOCAL,
          );
        }
      });
      const existing = boundsOf(doc);
      const opts = {
        count: 1 + Math.floor(rand() * 6),
        w: 60 + rand() * 500,
        h: 60 + rand() * 500,
        gap: Math.round(rand() * 60),
        ...(rand() < 0.5 ? { near: { x: rand() * 3000 - 500, y: rand() * 2000 - 500 } } : {}),
        ...(rand() < 0.5 ? { frame: { name: "Batch" } } : {}),
      };
      const placed = placeBoxes(doc, opts);
      expect(placed.boxes).toHaveLength(opts.count);
      const mine = placed.frame ? [placed.frame] : placed.boxes;
      for (const box of mine) {
        for (const other of existing) expect(rectsIntersect(box, other)).toBe(false);
      }
      for (let i = 0; i < placed.boxes.length; i++) {
        for (let j = i + 1; j < placed.boxes.length; j++) {
          expect(rectsIntersect(placed.boxes[i] as Box, placed.boxes[j] as Box)).toBe(false);
        }
      }
    }
  });

  test("inside an existing frame, which grows when full, still on nothing", () => {
    const rand = seeded(7);
    for (let round = 0; round < 120; round++) {
      const doc = canvas();
      const frame = addShape(
        doc,
        { type: "frame", name: "F", x: 0, y: 0, w: 400 + rand() * 600, h: 300 + rand() * 400 },
        LOCAL,
      );
      const kids = Math.floor(rand() * 8);
      for (let i = 0; i < kids; i++) {
        addShape(doc, { type: "note", parent: frame, x: rand() * 600, y: rand() * 500, w: 100, h: 100 }, LOCAL);
      }
      // Neighbors around the frame.
      for (let i = 0; i < 6; i++) {
        addShape(doc, { type: "note", x: rand() * 2400 - 600, y: rand() * 2000 - 400, w: 150, h: 150 }, LOCAL);
      }
      const existing = boundsOf(doc).filter((_, i) => readShapes(doc)[i]?.id !== frame);
      const placed = placeBoxes(doc, { count: 1 + Math.floor(rand() * 3), w: 120, h: 120, within: frame });
      const frameBox = placed.grow?.box ?? (readShapeById(doc, frame) as Box);
      for (const box of placed.boxes) {
        for (const other of existing) expect(rectsIntersect(box, other)).toBe(false);
        expect(box.x).toBeGreaterThanOrEqual(frameBox.x);
        expect(box.y).toBeGreaterThanOrEqual(frameBox.y);
        expect(box.x + box.w).toBeLessThanOrEqual(frameBox.x + frameBox.w);
        expect(box.y + box.h).toBeLessThanOrEqual(frameBox.y + frameBox.h);
      }
    }
  });

  test("a shape added without a position lands in free room (in its frame when it has one)", () => {
    const doc = canvas();
    const frame = addShape(doc, { type: "frame", name: "Board", x: 0, y: 0, w: 300, h: 300 }, LOCAL);
    const notes = [0, 1, 2].map(() => addShape(doc, { type: "note", parent: frame }, LOCAL));
    const all = readShapes(doc).filter((shape) => shape.type === "note");
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        expect(rectsIntersect(all[i] as Box, all[j] as Box)).toBe(false);
      }
    }
    const board = readShapeById(doc, frame) as Box;
    for (const id of notes) {
      const note = readShapeById(doc, id) as Box;
      expect(note.x >= board.x && note.y >= board.y).toBe(true);
      expect(note.x + note.w <= board.x + board.w && note.y + note.h <= board.y + board.h).toBe(true);
    }
  });
});

describe("moving, resizing, deleting, stacking", () => {
  test("a frame carries what's in it; an arrow's free end moves with it, a bound one follows its shape", () => {
    const doc = canvas();
    const frame = addShape(doc, { type: "frame", name: "F", x: 0, y: 0, w: 500, h: 500 }, LOCAL);
    const inner = addShape(doc, { type: "frame", name: "G", parent: frame, x: 10, y: 10, w: 200, h: 200 }, LOCAL);
    const note = addShape(doc, { type: "note", parent: inner, x: 20, y: 20, w: 50, h: 50 }, LOCAL);
    const outside = addShape(doc, { type: "note", x: 900, y: 900, w: 50, h: 50 }, LOCAL);
    const arrow = addShape(doc, { type: "arrow", from: { x: 600, y: 600 }, to: { shape: outside } }, LOCAL);
    moveShapes(doc, [frame, note], 100, 50, LOCAL);
    expect(readShapeById(doc, frame)).toMatchObject({ x: 100, y: 50 });
    expect(readShapeById(doc, inner)).toMatchObject({ x: 110, y: 60 });
    expect(readShapeById(doc, note)).toMatchObject({ x: 120, y: 70 });
    moveShapes(doc, [arrow], 10, 10, LOCAL);
    expect(readShapeById(doc, arrow)?.from).toEqual({ x: 610, y: 610 });
    expect(readShapeById(doc, arrow)?.to).toEqual({ shape: outside });
    resizeShape(doc, outside, { x: 900, y: 900, w: 80, h: 90 }, LOCAL);
    expect(readShapeById(doc, outside)).toMatchObject({ w: 80, h: 90 });
    expectRefused(doc, "invalid", () => resizeShape(doc, outside, { x: 0, y: 0, w: -1, h: 1 }, LOCAL));
  });

  test("deleting a frame takes what's in it; arrows keep their free end where the shape was", () => {
    const doc = canvas();
    const frame = addShape(doc, { type: "frame", name: "F", x: 0, y: 0, w: 500, h: 500 }, LOCAL);
    const inside = addShape(doc, { type: "note", parent: frame, x: 10, y: 10, w: 100, h: 100 }, LOCAL);
    const a = addShape(doc, { type: "note", x: 900, y: 0, w: 100, h: 100 }, LOCAL);
    const half = addShape(doc, { type: "arrow", from: { shape: inside }, to: { shape: a } }, LOCAL);
    const both = addShape(doc, { type: "arrow", from: { shape: inside }, to: { shape: frame } }, LOCAL);
    deleteShapes(doc, [frame], LOCAL);
    const ids = readShapes(doc).map((shape) => shape.id);
    expect(ids).not.toContain(frame);
    expect(ids).not.toContain(inside);
    expect(ids).not.toContain(both);
    expect(readShapeById(doc, half)?.from).toEqual({ x: 60, y: 60 });
    expect(readShapeById(doc, half)?.to).toEqual({ shape: a });
  });

  test("stacking within layers, frames under everything", () => {
    const doc = canvas();
    const a = addShape(doc, { type: "note", x: 0, y: 0 }, LOCAL);
    const b = addShape(doc, { type: "note", x: 0, y: 0 }, LOCAL);
    const f = addShape(doc, { type: "frame", name: "F", x: 0, y: 0 }, LOCAL);
    arrange(doc, [a], "front", LOCAL);
    expect(readShapes(doc).map((s) => s.id)).toEqual([f, b, a]);
    arrange(doc, [a, f], "back", LOCAL);
    expect(readShapes(doc).map((s) => s.id)).toEqual([f, a, b]);
  });

  test("frames: putting shapes in and out, the innermost under a point, no loops", () => {
    const doc = canvas();
    const outer = addShape(doc, { type: "frame", name: "O", x: 0, y: 0, w: 1000, h: 1000 }, LOCAL);
    const inner = addShape(doc, { type: "frame", name: "I", x: 100, y: 100, w: 300, h: 300 }, LOCAL);
    setParent(doc, [inner], outer, LOCAL);
    expect(frameAt(doc, 150, 150)).toBe(inner);
    expect(frameAt(doc, 900, 900)).toBe(outer);
    expect(frameAt(doc, 150, 150, [inner])).toBe(outer);
    expect(frameAt(doc, 150, 150, [outer])).toBeNull();
    expect(frameAt(doc, 5000, 5000)).toBeNull();
    expectRefused(doc, "invalid", () => setParent(doc, [outer], inner, LOCAL));
    expectRefused(doc, "invalid", () => setParent(doc, [outer], outer, LOCAL));
    const note = addShape(doc, { type: "note", x: 120, y: 120 }, LOCAL);
    expectRefused(doc, "not_found", () => setParent(doc, [inner], note, LOCAL));
    setParent(doc, [note], inner, LOCAL);
    expect(readShapeById(doc, note)?.parent).toBe(inner);
    setParent(doc, [note], null, LOCAL);
    expect(readShapeById(doc, note)?.parent).toBeUndefined();
  });

  test("a placeholder becomes its image, same id, same place in the stack, the image's proportions", () => {
    const doc = canvas();
    const frame = addShape(doc, { type: "frame", name: "a cat", x: 0, y: 0, w: 700, h: 700 }, LOCAL);
    const pending = addShape(
      doc,
      { type: "pending", parent: frame, x: 50, y: 50, w: 512, h: 512, prompt: "a cat", request: "req-1", index: 0 },
      LOCAL,
    );
    const z = readShapeById(doc, pending)?.z;
    const by = { kind: "person" as const, id: "ada" };
    const done = fillPending(
      doc,
      pending,
      { asset: "asset-9", nw: 1536, nh: 1024, gen: { prompt: "a cat", model: "fake", by, at: "2026-11-17T10:00:00Z" } },
      SYSTEM,
    );
    expect(done).toBe(true);
    const image = readShapeById(doc, pending);
    expect(image).toMatchObject({ type: "image", asset: "asset-9", parent: frame, z, w: 512, x: 50 });
    expect(image?.h).toBeCloseTo((512 * 1024) / 1536, 6);
    expect(image?.y).toBeCloseTo(50 + (512 - (512 * 1024) / 1536) / 2, 6);
    expect(image?.prompt).toBeUndefined();
    expect(image?.gen?.by).toEqual(by);
    expect(fillPending(doc, pending, { asset: "asset-9", nw: 1, nh: 1 }, SYSTEM)).toBe(false);
    expect(fillPending(doc, "gone", { asset: "asset-9", nw: 1, nh: 1 }, SYSTEM)).toBe(false);
  });

  test("two people moving different shapes at once both land", () => {
    const one = canvas();
    const a = addShape(one, { type: "note", x: 0, y: 0 }, LOCAL);
    const b = addShape(one, { type: "note", x: 500, y: 0 }, LOCAL);
    const two = new Y.Doc();
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    moveShapes(one, [a], 10, 0, LOCAL);
    moveShapes(two, [b], 0, 10, agentOrigin("atlas", "run-1"));
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two));
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    expect(readShapes(one)).toEqual(readShapes(two));
    expect(readShapeById(one, a)?.x).toBe(10);
    expect(readShapeById(one, b)?.y).toBe(10);
  });
});

describe("preview, text and rules of shape", () => {
  test("frames first, then the biggest, at most 40, in drawing order", () => {
    const doc = canvas();
    doc.transact(() => {
      for (let i = 0; i < 60; i++) addShape(doc, { type: "note", x: i * 300, y: 0, w: 10 + i, h: 10 + i }, LOCAL);
    });
    const frame = addShape(doc, { type: "frame", name: "Small frame", x: -500, y: -500, w: 5, h: 5 }, LOCAL);
    const source = addShape(doc, { type: "note", x: 0, y: 500, w: 100, h: 100, text: "start" }, LOCAL);
    const arrow = addShape(doc, { type: "arrow", from: { shape: source }, to: { x: 400, y: 550 }, label: "go" }, LOCAL);
    const preview = canvasPreview(doc);
    expect(preview.count).toBe(63);
    expect(preview.shapes).toHaveLength(40);
    expect(preview.shapes[0]).toMatchObject({ id: frame, type: "frame", text: "Small frame" });
    const sizes = preview.shapes.filter((s) => s.type === "note").map((s) => s.w);
    expect(Math.min(...sizes)).toBeGreaterThan(25);
    expect(preview.bounds).toEqual(contentBounds(doc));
    expect(preview.shapes.find((s) => s.id === source)?.text).toBe("start");
    expect(preview.shapes.some((s) => s.id === arrow)).toBe(false);
  });

  test("text: frames with what's in them, top to bottom", () => {
    const doc = canvas();
    const frame = addShape(doc, { type: "frame", name: "Ideas", x: 0, y: 0, w: 800, h: 800 }, LOCAL);
    addShape(doc, { type: "note", parent: frame, x: 10, y: 400, text: "second" }, LOCAL);
    addShape(doc, { type: "note", parent: frame, x: 10, y: 10, text: "first" }, LOCAL);
    addShape(doc, { type: "text", x: 0, y: 2000, text: "loose" }, LOCAL);
    addShape(doc, { type: "image", asset: "a1", x: 0, y: 3000, gen: undefined, alt: "a red bike" }, LOCAL);
    expect(canvasText(doc)).toBe("Ideas\nfirst\nsecond\nloose\na red bike");
  });

  test("a sound canvas has no problems; a broken one says what", () => {
    const doc = canvas();
    addShape(doc, { type: "note", x: 0, y: 0, text: "ok" }, LOCAL);
    expect(validateCanvas(doc)).toEqual([]);
    const broken = new Y.Map<unknown>();
    broken.set("type", "note");
    broken.set("x", "far");
    shapesMapOf(doc).set("bad", broken);
    const problems = validateCanvas(doc);
    expect(problems.some((p) => p.includes("bad") && p.includes("box"))).toBe(true);
    expect(readShapes(doc).find((s) => s.id === "bad")?.x).toBe(0);
  });
});

describe("restoring a version", () => {
  test("old content back in one change; unchanged shapes keep their identity", () => {
    const doc = canvas();
    const keep = addShape(doc, { type: "note", x: 0, y: 0, text: "keep" }, LOCAL);
    const edit = addShape(doc, { type: "note", x: 300, y: 0, text: "before" }, LOCAL);
    const snapshot = Y.encodeStateAsUpdate(doc);
    const kept = shapesMapOf(doc).get(keep);
    updateShape(doc, edit, { text: "after", color: "blue" }, LOCAL);
    addShape(doc, { type: "frame", name: "new", x: 0, y: 900 }, LOCAL);
    const old = new Y.Doc();
    Y.applyUpdate(old, snapshot);
    let changes = 0;
    doc.on("afterTransaction", () => changes++);
    replaceCanvas(doc, old, SYSTEM);
    expect(changes).toBe(1);
    expect(readShapes(doc)).toEqual(readShapes(old));
    expect(shapesMapOf(doc).get(keep)).toBe(kept);
  });
});

describe("geometry", () => {
  test("boxes, points, rotation", () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }, 1)).toBe(true);
    expect(union([])).toBeNull();
    expect(
      union([
        { x: 0, y: 0, w: 1, h: 1 },
        { x: 5, y: -5, w: 1, h: 1 },
      ]),
    ).toEqual({ x: 0, y: -5, w: 6, h: 6 });
    const bounds = rotatedBounds({ x: 0, y: 0, w: 100, h: 0 }, 90);
    expect(bounds.w).toBeCloseTo(0, 6);
    expect(bounds.h).toBeCloseTo(100, 6);
    expect(containsPoint({ x: 0, y: 0, w: 100, h: 10 }, { x: 50, y: 40 }, 90)).toBe(true);
    expect(containsPoint({ x: 0, y: 0, w: 100, h: 10 }, { x: 95, y: 5 }, 90)).toBe(false);
    const shapes = [
      { id: "under", x: 0, y: 0, w: 100, h: 100 },
      { id: "over", x: 50, y: 50, w: 100, h: 100 },
    ];
    expect(hitTest(shapes, 75, 75)).toBe("over");
    expect(hitTest(shapes, 10, 10)).toBe("under");
    expect(hitTest(shapes, 500, 500)).toBeNull();
  });

  test("snapping lines up edges and centers within the tolerance", () => {
    const snap = snapLines({ x: 103, y: 0, w: 50, h: 50 }, [{ x: 0, y: 200, w: 100, h: 20 }], 5);
    expect(snap.dx).toBe(-3);
    expect(snap.dy).toBe(0);
    expect(snap.guides).toEqual([{ axis: "x", at: 100, from: 0, to: 220 }]);
    expect(snapLines({ x: 300, y: 300, w: 10, h: 10 }, [{ x: 0, y: 0, w: 10, h: 10 }], 5)).toEqual({
      dx: 0,
      dy: 0,
      guides: [],
    });
  });

  test("arrows run border to border", () => {
    expect(arrowPath({ x: 0, y: 0, w: 100, h: 100 }, { x: 300, y: 0, w: 100, h: 100 })).toEqual({
      x1: 100,
      y1: 50,
      x2: 300,
      y2: 50,
    });
    expect(arrowPath({ x: 0, y: 0 }, { x: 0, y: 200, w: 100, h: 100 })).toEqual({ x1: 0, y1: 0, x2: 40, y2: 200 });
  });
});
