import { describe, expect, test } from "bun:test";
import { addShape, initLiveDoc, LOCAL, readShapes, SYSTEM } from "@agenteschat/live";
import { type Box, center, type ShapeView, shapeIndex } from "@agenteschat/live/canvas";
import type { TFunction } from "i18next";
import * as Y from "yjs";
import {
  CAMERA_MAX,
  CAMERA_MIN,
  centerOn,
  dotSpacing,
  fitCamera,
  followCamera,
  peerViewOf,
  stepCameraZoom,
  toScreen,
  toWorld,
  visibleWorld,
  zoomCameraAt,
} from "@/components/live/canvas/camera";
import {
  assetsToCopy,
  clipBounds,
  clipPayload,
  copyShapes,
  pasteClip,
  readClip,
  withAssets,
} from "@/components/live/canvas/clipboard";
import {
  arrowLine,
  boxFrom,
  cropFrom,
  dragCrop,
  fullImageBox,
  handlePoint,
  hitShape,
  marqueeHits,
  resizeBox,
  rotationAt,
  routePoints,
  scaleGroup,
  thinStroke,
  topLevelOf,
} from "@/components/live/canvas/edit-math";
import { selectionOf } from "@/components/live/canvas/selection";
import { canvasShortcuts, headsFor, headsOf, PEN_WIDTHS, penSizeOf } from "@/components/live/canvas/tools";

/**
 * The canvas editor's own math, apart from the screen (ADR 0196 §2): the camera (zoom at a point, fit, follow someone
 * else's view), what a press or a marquee takes, how a box follows its handles (turned boxes too), copying and pasting
 * shapes with what they carry, and the selection's words for Ask an agent.
 */

const near = (a: number, b: number, digits = 6) => expect(a).toBeCloseTo(b, digits);

function canvasDoc() {
  const doc = new Y.Doc();
  initLiveDoc(doc, "canvas");
  return doc;
}

function snapshot(doc: Y.Doc) {
  const list = readShapes(doc);
  return { list, byId: shapeIndex(list) as ReadonlyMap<string, ShapeView> };
}

describe("the camera", () => {
  test("screen and world points turn into each other", () => {
    const cam = { x: 120, y: -40, z: 2.5 };
    const p = { x: 33, y: -7 };
    const back = toWorld(cam, toScreen(cam, p));
    near(back.x, p.x);
    near(back.y, p.y);
  });

  test("zooming at a point keeps what is under it there, inside the zoom's range", () => {
    const cam = { x: 300, y: 200, z: 1 };
    const at = { x: 640, y: 410 };
    const before = toWorld(cam, at);
    const zoomed = zoomCameraAt(cam, 3, at);
    expect(zoomed.z).toBe(3);
    const after = toWorld(zoomed, at);
    near(after.x, before.x);
    near(after.y, before.y);
    expect(zoomCameraAt(cam, 1000, at).z).toBe(CAMERA_MAX);
    expect(zoomCameraAt(cam, 0.0001, at).z).toBe(CAMERA_MIN);
  });

  test("− and + stop at the picture viewer's steps, and come back", () => {
    const up = stepCameraZoom(1, 1);
    expect(up).toBeGreaterThan(1);
    expect(stepCameraZoom(up, -1)).toBe(1);
    expect(stepCameraZoom(CAMERA_MAX, 1)).toBe(CAMERA_MAX);
    expect(stepCameraZoom(CAMERA_MIN, -1)).toBe(CAMERA_MIN);
    // Between two steps, + goes to the next one up and − to the one below.
    expect(stepCameraZoom(1.2, 1)).toBeGreaterThan(1.2);
    expect(stepCameraZoom(1.2, -1)).toBe(1);
  });

  test("a fit shows the box whole in the middle, never closer than asked", () => {
    const stage = { w: 1200, h: 800 };
    const box = { x: -500, y: 100, w: 2000, h: 400 };
    const cam = fitCamera(box, stage, 64, 1);
    const seen = visibleWorld(cam, stage);
    expect(seen.x).toBeLessThanOrEqual(box.x);
    expect(seen.x + seen.w).toBeGreaterThanOrEqual(box.x + box.w);
    const mid = toScreen(cam, center(box));
    near(mid.x, 600);
    near(mid.y, 400);
    // A small note isn't blown up to fill the screen.
    expect(fitCamera({ x: 0, y: 0, w: 200, h: 200 }, stage, 64, 1).z).toBe(1);
  });

  test("following someone shows what they see, on a screen of another size", () => {
    const theirs = { x: -340, y: 120, z: 0.75 };
    const view = peerViewOf(theirs, { w: 1440, h: 900 });
    const stage = { w: 800, h: 800 };
    const mine = followCamera(view, stage);
    const seen = visibleWorld(mine, stage);
    // Their whole view fits in mine, centered on the same point.
    expect(seen.x).toBeLessThanOrEqual(view.x + 0.01);
    expect(seen.y).toBeLessThanOrEqual(view.y + 0.01);
    expect(seen.x + seen.w).toBeGreaterThanOrEqual(view.x + view.w - 0.01);
    expect(seen.y + seen.h).toBeGreaterThanOrEqual(view.y + view.h - 0.01);
    near(seen.x + seen.w / 2, view.x + view.w / 2, 1);
    near(seen.y + seen.h / 2, view.y + view.h / 2, 1);
    // A view with no size (an agent's pointer only): centered on it at its zoom.
    const point = followCamera({ x: 50, y: 60, w: 0, h: 0, zoom: 2 }, stage);
    expect(point).toEqual(centerOn({ x: 50, y: 60 }, stage, 2));
  });

  test("the dots never crowd closer than 12 pixels", () => {
    for (const z of [0.1, 0.25, 0.4, 0.5, 1, 2, 8]) expect(dotSpacing(z)).toBeGreaterThanOrEqual(12);
    expect(dotSpacing(1)).toBe(24);
  });
});

describe("handles", () => {
  const box: Box = { x: 100, y: 50, w: 200, h: 100 };

  test("a corner pulls its own sides, the opposite corner stays", () => {
    expect(resizeBox(box, 0, "se", { x: 50, y: 20 })).toEqual({ x: 100, y: 50, w: 250, h: 120 });
    expect(resizeBox(box, 0, "nw", { x: 50, y: 20 })).toEqual({ x: 150, y: 70, w: 150, h: 80 });
    // A side handle moves one side only.
    expect(resizeBox(box, 0, "e", { x: 30, y: 999 })).toEqual({ x: 100, y: 50, w: 230, h: 100 });
  });

  test("pictures keep their proportions; nothing goes under the smallest side", () => {
    const grown = resizeBox(box, 0, "se", { x: 100, y: 0 }, { ratio: true });
    expect(grown.w / grown.h).toBeCloseTo(2, 6);
    expect(grown.w).toBeCloseTo(300, 6);
    const tiny = resizeBox(box, 0, "se", { x: -500, y: -500 }, { min: 16 });
    expect(tiny.w).toBe(16);
    expect(tiny.h).toBe(16);
  });

  test("on a turned box, the corner opposite the handle stays where it is in the world", () => {
    for (const rot of [30, 90, 200]) {
      const before = handlePoint(box, rot, "nw");
      const next = resizeBox(box, rot, "se", { x: 40, y: -25 });
      const after = handlePoint(next, rot, "nw");
      near(after.x, before.x);
      near(after.y, before.y);
    }
  });

  test("the rotation knob: up is 0°, right 90°, Shift snaps to 15°", () => {
    const c = { x: 0, y: 0 };
    near(rotationAt(c, { x: 0, y: -10 }), 0);
    near(rotationAt(c, { x: 10, y: 0 }), 90);
    near(rotationAt(c, { x: -10, y: 0 }), 270);
    expect(rotationAt(c, { x: 10, y: -9 }, true) % 15).toBe(0);
  });

  test("several shapes resize together, each keeping its place in the group", () => {
    const bounds = { x: 0, y: 0, w: 100, h: 100 };
    const { boxes } = scaleGroup(bounds, "se", { x: 100, y: 100 }, [
      { x: 0, y: 0, w: 50, h: 50 },
      { x: 50, y: 50, w: 50, h: 50 },
    ]);
    expect(boxes).toEqual([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 100, y: 100, w: 100, h: 100 },
    ]);
  });

  test("a drag in any direction makes a box", () => {
    expect(boxFrom({ x: 10, y: 50 }, { x: -20, y: 30 })).toEqual({ x: -20, y: 30, w: 30, h: 20 });
  });
});

describe("what a press and a marquee take", () => {
  function scene() {
    const doc = canvasDoc();
    const frame = addShape(doc, { type: "frame", x: 0, y: 0, w: 600, h: 400, name: "Ideas" }, LOCAL);
    const note = addShape(doc, { type: "note", x: 40, y: 40, w: 200, h: 200, parent: frame }, LOCAL);
    const other = addShape(doc, { type: "note", x: 900, y: 40, w: 200, h: 200 }, LOCAL);
    const arrow = addShape(doc, { type: "arrow", from: { shape: note }, to: { shape: other } }, LOCAL);
    return { doc, frame, note, other, arrow, ...snapshot(doc) };
  }

  test("the topmost shape under the pointer; a frame's inside is room unless nothing else is there", () => {
    const { list, byId, frame, note, other } = scene();
    expect(hitShape(list, byId, { x: 100, y: 100 }, 1)).toEqual({ id: note, part: "body" });
    expect(hitShape(list, byId, { x: 400, y: 300 }, 1)).toEqual({ id: frame, part: "frameInside" });
    expect(hitShape(list, byId, { x: 1, y: 200 }, 1)).toEqual({ id: frame, part: "frameEdge" });
    expect(hitShape(list, byId, { x: 1000, y: 100 }, 1)).toEqual({ id: other, part: "body" });
    expect(hitShape(list, byId, { x: 2000, y: 2000 }, 1)).toBeNull();
  });

  test("an arrow is taken near its line, a few screen pixels whatever the zoom", () => {
    const { list, byId, arrow } = scene();
    const line = arrowLine(byId.get(arrow) as ShapeView, byId);
    if (!line) throw new Error("the arrow has no line");
    const mid = { x: (line.x1 + line.x2) / 2, y: (line.y1 + line.y2) / 2 };
    expect(hitShape(list, byId, { x: mid.x, y: mid.y + 4 }, 1)?.id).toBe(arrow);
    expect(hitShape(list, byId, { x: mid.x, y: mid.y + 4 }, 4)?.id).not.toBe(arrow);
    // Bound ends leave their shapes' borders, a little outside them.
    expect(line.x1).toBeGreaterThan(240);
    expect(line.x2).toBeLessThan(900);
  });

  test("a marquee takes what it touches, frames only whole, and nothing inside a frame it takes", () => {
    const { list, byId, frame, note, other } = scene();
    expect(marqueeHits(list, byId, { x: 30, y: 30, w: 50, h: 50 })).toEqual([note]);
    const all = marqueeHits(list, byId, { x: -10, y: -10, w: 1200, h: 500 });
    expect(all).toContain(frame);
    expect(all).toContain(other);
    expect(all).not.toContain(note);
    expect(topLevelOf([frame, note, other], list)).toEqual([frame, other]);
  });
});

describe("copy and paste", () => {
  test("a frame comes with what is inside it; arrows come when both their ends do; placeholders never", () => {
    const doc = canvasDoc();
    const frame = addShape(doc, { type: "frame", x: 0, y: 0, w: 600, h: 400, name: "Ideas" }, LOCAL);
    const note = addShape(doc, { type: "note", x: 40, y: 40, w: 200, h: 200, parent: frame, text: "Olá" }, LOCAL);
    const text = addShape(doc, { type: "text", x: 300, y: 40, w: 200, h: 40, parent: frame, text: "Ideia" }, LOCAL);
    const outside = addShape(doc, { type: "note", x: 900, y: 40, w: 200, h: 200 }, LOCAL);
    addShape(doc, { type: "arrow", from: { shape: note }, to: { shape: text } }, LOCAL);
    addShape(doc, { type: "arrow", from: { shape: note }, to: { shape: outside } }, LOCAL);
    addShape(doc, { type: "pending", x: 40, y: 260, w: 100, h: 100, parent: frame, prompt: "a fox" }, SYSTEM);

    const clip = copyShapes(doc, "file-a", [frame]);
    if (!clip) throw new Error("nothing copied");
    expect(clip.shapes.map((s) => s.type).sort()).toEqual(["arrow", "frame", "note", "text"]);
    expect(clipBounds(clip)).toEqual({ x: 0, y: 0, w: 600, h: 400 });

    const undo = new Y.UndoManager([doc.getMap("shapes")], { trackedOrigins: new Set([LOCAL]) });
    const before = readShapes(doc).length;
    const top = pasteClip(doc, clip, 1000, 0, LOCAL);
    const after = snapshot(doc);
    expect(after.list.length).toBe(before + 4);
    expect(top).toHaveLength(1);
    const copy = after.byId.get(top[0] as string);
    expect(copy).toMatchObject({ type: "frame", x: 1000, name: "Ideas" });
    // The copies sit in the new frame and the arrow joins the new note and text.
    const inside = after.list.filter((s) => s.parent === copy?.id);
    expect(inside.map((s) => s.type).sort()).toEqual(["note", "text"]);
    const ids = new Set(inside.map((s) => s.id));
    const tied = (end: ShapeView["from"]) => !!end && "shape" in end && ids.has(end.shape);
    expect(after.list.some((s) => s.type === "arrow" && tied(s.from) && tied(s.to))).toBe(true);
    expect(inside.find((s) => s.type === "note")?.text?.[0]?.runs[0]?.text).toBe("Olá");
    // One step of undo takes the whole paste back.
    undo.stopCapturing();
    undo.undo();
    expect(readShapes(doc).length).toBe(before);
  });

  test("shapes travel in the HTML copy too, and pictures from another canvas are copied in first", () => {
    const doc = canvasDoc();
    const image = addShape(
      doc,
      { type: "image", asset: "asset-1", nw: 800, nh: 600, x: 0, y: 0, w: 400, h: 300 },
      LOCAL,
    );
    const note = addShape(doc, { type: "note", x: 500, y: 0, w: 200, h: 200, text: "Ação & reação" }, LOCAL);
    const clip = copyShapes(doc, "file-a", [image, note]);
    if (!clip) throw new Error("nothing copied");
    const { html, text, json } = clipPayload(clip);
    expect(text).toBe("Ação & reação");
    expect(html).toContain("Ação &amp; reação");
    expect(readClip({ html })).toEqual(clip);
    expect(readClip({ json })).toEqual(clip);
    expect(readClip({ html: "<p>just words</p>" })).toBeNull();
    expect(readClip({ json: "{not json" })).toBeNull();

    // Pasted here: nothing to copy. Elsewhere: the picture first, then it points at the copy.
    expect(assetsToCopy(clip, "file-a")).toEqual([]);
    expect(assetsToCopy(clip, "file-b")).toEqual(["asset-1"]);
    const moved = withAssets(clip, "file-b", new Map([["asset-1", "asset-9"]]));
    expect(moved.file).toBe("file-b");
    expect(moved.shapes.find((s) => s.type === "image")?.asset).toBe("asset-9");
    // A picture that couldn't be copied stays behind; the rest still come.
    expect(withAssets(clip, "file-b", new Map()).shapes.map((s) => s.type)).toEqual(["note"]);
  });
});

describe("the selection in words", () => {
  const t = ((key: string, options?: { count?: number }) => `${key}:${options?.count}`) as unknown as TFunction;
  const shape = (id: string, type: ShapeView["type"]): ShapeView => ({ id, type, x: 0, y: 0, w: 1, h: 1, z: "a" });

  test("one kind is counted by name (a picture on its way is a picture); a mix is items", () => {
    expect(selectionOf(t, [])).toBeNull();
    expect(selectionOf(t, [shape("a", "image"), shape("b", "pending")])).toEqual({
      label: "live.canvas.count.image:2",
      shapes: ["a", "b"],
    });
    expect(selectionOf(t, [shape("a", "note")])?.label).toBe("live.canvas.count.note:1");
    expect(selectionOf(t, [shape("a", "note"), shape("b", "image"), shape("c", "frame")])?.label).toBe(
      "live.canvas.count.items:3",
    );
  });
});

describe("the tools' own math (ADR 0196 §2)", () => {
  const shape = (over: Partial<ShapeView>): ShapeView => ({
    id: "s",
    type: "note",
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    z: "a",
    ...over,
  });

  test("a pen stroke keeps its corners and drops the points on a straight run, at most so many numbers", () => {
    // A straight run with a corner: the middle points of each run go.
    const points = [0, 0, 10, 0.1, 20, 0, 30, 0, 30, 10, 30, 20];
    expect(thinStroke(points, 0.5)).toEqual([0, 0, 30, 0, 30, 20]);
    // One point stays a dot.
    expect(thinStroke([5.123, 6.456], 0.5)).toEqual([5.12, 6.46]);
    // A long zigzag past the cap keeps its ends and the cap.
    const zig = Array.from({ length: 5000 }, (_, i) => [i, i % 2 ? 10 : 0]).flat();
    const kept = thinStroke(zig, 0.5, 400);
    expect(kept.length).toBe(400);
    expect(kept.slice(0, 2)).toEqual([0, 0]);
    expect(kept.slice(-2)).toEqual([4999, 10]);
  });

  test("a pen stroke is taken near its line, not anywhere in its box", () => {
    const ring = shape({ id: "ring", type: "draw", points: [0, 0, 100, 0, 100, 100, 0, 100, 0, 0] });
    const list = [ring];
    const byId = shapeIndex(list) as ReadonlyMap<string, ShapeView>;
    expect(hitShape(list, byId, { x: 50, y: 1 }, 1)?.id).toBe("ring");
    expect(hitShape(list, byId, { x: 50, y: 50 }, 1)).toBeNull();
  });

  test("a curved arrow runs through its bow; an elbow through its corners", () => {
    const line = { x1: 0, y1: 0, x2: 100, y2: 0 };
    expect(routePoints(line, undefined)).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    const curve = routePoints(line, "curve");
    expect(curve.length).toBeGreaterThan(8);
    // It bows a quarter of its length off the line at its control point: half that at its middle.
    const mid = curve[Math.floor(curve.length / 2)] as { x: number; y: number };
    near(Math.abs(mid.y), 12.5, 3);
    const elbow = routePoints({ x1: 0, y1: 0, x2: 100, y2: 40 }, "elbow");
    expect(elbow).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 40 },
      { x: 100, y: 40 },
    ]);
  });

  test("a crop's window moves and resizes inside the whole picture; applied, it is the box and the part shown", () => {
    const picture = { x: 100, y: 100, w: 200, h: 100, crop: { x: 0.5, y: 0, w: 0.5, h: 1 } };
    const full = fullImageBox(picture);
    expect(full).toEqual({ x: -100, y: 100, w: 400, h: 100 });
    const rect = { x: 100, y: 100, w: 200, h: 100 };
    // Moved whole: never past the picture's edge.
    expect(dragCrop(rect, full, "move", { x: 500, y: 0 })).toEqual({ x: 100, y: 100, w: 200, h: 100 });
    expect(dragCrop(rect, full, "move", { x: -50, y: 30 })).toEqual({ x: 50, y: 100, w: 200, h: 100 });
    // A side's handle: the other side stays; it never goes under the smallest side or past the edge.
    expect(dragCrop(rect, full, "w", { x: -400, y: 0 })).toEqual({ x: -100, y: 100, w: 400, h: 100 });
    expect(dragCrop(rect, full, "e", { x: -500, y: 0 })).toEqual({ x: 100, y: 100, w: 16, h: 100 });
    const kept = cropFrom({ x: 0, y: 100, w: 100, h: 50 }, full);
    expect(kept.box).toEqual({ x: 0, y: 100, w: 100, h: 50 });
    expect(kept.crop).toEqual({ x: 0.25, y: 0, w: 0.25, h: 0.5 });
    // The whole picture again: no crop.
    expect(cropFrom(full, full).crop).toBeNull();
  });

  test("an arrow's heads in one word and back; pen sizes by their nearest width", () => {
    expect(headsOf({})).toBe("end");
    expect(headsOf({ heads: { start: "arrow", end: "arrow" } })).toBe("both");
    expect(headsOf({ heads: { start: "arrow", end: "none" } })).toBe("start");
    expect(headsOf({ heads: { start: "none", end: "none" } })).toBe("none");
    for (const h of ["none", "end", "start", "both"] as const) {
      expect(headsOf({ heads: headsFor(h) ?? undefined })).toBe(h);
    }
    expect(penSizeOf("pen", PEN_WIDTHS.pen.l)).toBe("l");
    expect(penSizeOf("marker", 15)).toBe("m");
    expect(penSizeOf("pen", undefined)).toBe("m");
  });

  test("the shortcuts list names every tool with the key the plane reads", () => {
    const t = ((key: string) => key) as unknown as TFunction;
    const keys = new Map(canvasShortcuts(t, "⌘"));
    expect(keys.get("live.canvas.tools.select")).toEqual(["V"]);
    expect(keys.get("live.canvas.shapeKinds.triangle")).toEqual(["⇧", "T"]);
    expect(keys.get("live.canvas.shapeKinds.line")).toEqual(["L"]);
    expect(keys.get("live.canvas.tools.pen")).toEqual(["P"]);
    expect(keys.get("live.canvas.tools.comment")).toEqual(["C"]);
    expect(keys.get("live.shell.shortcuts.duplicate")).toEqual(["⌘", "D"]);
  });
});
