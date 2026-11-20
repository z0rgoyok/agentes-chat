import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { initLiveDoc, LOCAL } from "@agenteschat/live";
import type { Peer, PeerState } from "@agenteschat/live/awareness";
import { addShape, arrowPath, readShapes, rectsIntersect, type ShapeView, shapeIndex } from "@agenteschat/live/canvas";
import * as Y from "yjs";
import {
  arrowLineW,
  boxOnScreen,
  type Cam,
  centerOn,
  clampZoom,
  dotOffset,
  dotSpacing,
  fitCam,
  followCam,
  inside,
  laidOutBox,
  lerpCam,
  MAX_ZOOM,
  MIN_SIDE,
  MIN_ZOOM,
  onAnyBox,
  onHandle,
  overlaps,
  panBy,
  peerViewOf,
  stretchBox,
  toScreen,
  toWorld,
  viewBox,
  viewCenter,
  zoomAt,
} from "../../src/features/live-files/canvas/camera";
import { colorFloats } from "../../src/features/live-files/canvas/dots";
import {
  arrowDraws,
  arrowHead,
  chosenPictures,
  failureKey,
  keepsRatio,
  movingIds,
  peerPicks,
  peerPointers,
  pendingWords,
  pictureSize,
  placeNear,
  retryable,
  segmentDistance,
  selectionBox,
  shapeAt,
  shapesIn,
  stretchable,
} from "../../src/features/live-files/canvas/logic";
import { MAIN, ownOptionsOf } from "../main-stack";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const b0 = { x: 0, y: 0, w: 0, h: 0 };

const frame = { width: 390, height: 700 };

const shape = (s: Partial<ShapeView> & { id: string; type: ShapeView["type"] }): ShapeView => ({
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  z: "a0",
  ...s,
});

describe("the canvas's camera (ADR 0196 §2)", () => {
  test("world and screen points go back and forth", () => {
    const cam: Cam = { x: -120, y: 40, s: 0.75 };
    const p = { x: 333, y: -47 };
    const back = toWorld(toScreen(p, cam), cam);
    expect(near(back.x, p.x) && near(back.y, p.y)).toBe(true);
    expect(boxOnScreen({ x: 0, y: 40, w: 100, h: 10 }, cam)).toEqual({ x: 90, y: 0, w: 75, h: 7.5 });
    expect(viewBox(cam, frame)).toEqual({ x: -120, y: 40, w: 520, h: 700 / 0.75 });
  });

  test("a pinch keeps the world point under the fingers, between 10% and 400%", () => {
    const cam: Cam = { x: 10, y: 20, s: 1 };
    const focal = { x: 200, y: 300 };
    const under = toWorld(focal, cam);
    const zoomed = zoomAt(cam, 2.5, focal);
    expect(zoomed.s).toBe(2.5);
    const still = toWorld(focal, zoomed);
    expect(near(still.x, under.x) && near(still.y, under.y)).toBe(true);
    expect(zoomAt(cam, 99, focal).s).toBe(MAX_ZOOM);
    expect(zoomAt(cam, 0.001, focal).s).toBe(MIN_ZOOM);
    expect(clampZoom(1)).toBe(1);
  });

  test("a finger drags the world with it", () => {
    const moved = panBy({ x: 0, y: 0, s: 2 }, 40, -20);
    expect(moved).toEqual({ x: -20, y: 10, s: 2 });
  });

  test("a fit shows the box whole in the middle, never closer than asked", () => {
    const box = { x: 100, y: 100, w: 1000, h: 500 };
    const cam = fitCam(box, frame, 40, 1);
    const view = viewBox(cam, frame);
    expect(inside(box, view)).toBe(true);
    const c = viewCenter(cam, frame);
    expect(near(c.x, 600) && near(c.y, 350)).toBe(true);
    // One small note is shown at its real size, not blown up.
    expect(fitCam({ x: 0, y: 0, w: 200, h: 200 }, frame, 40, 1).s).toBe(1);
    expect(centerOn({ x: 0, y: 0 }, frame, 1)).toEqual({ x: -195, y: -350, s: 1 });
  });

  test("following someone shows the world box they see, in this phone's own frame", () => {
    const theirs = peerViewOf({ x: 50, y: 60, s: 0.5 }, { width: 1280, height: 800 });
    expect(theirs).toEqual({ x: 50, y: 60, w: 2560, h: 1600, zoom: 0.5 });
    const seen = viewBox(followCam(theirs, frame), frame);
    // Their box fits across this narrower frame exactly, centered on theirs.
    expect(seen.w).toBeCloseTo(2560, 6);
    expect(seen.x).toBeCloseTo(50, 6);
    expect(seen.y + seen.h / 2).toBeCloseTo(60 + 800, 6);
    // A view without a size: their middle at their zoom.
    expect(followCam({ x: 10, y: 10, w: 0, h: 0, zoom: 2 }, frame).s).toBe(2);
  });

  test("a glide goes from one camera to the other, its middle in a straight line", () => {
    const a: Cam = { x: 0, y: 0, s: 1 };
    const b: Cam = { x: 400, y: 100, s: 0.25 };
    const start = lerpCam(a, b, 0, frame);
    const end = lerpCam(a, b, 1, frame);
    expect(near(start.x, a.x) && near(start.s, a.s)).toBe(true);
    expect(near(end.x, b.x) && near(end.y, b.y) && near(end.s, b.s)).toBe(true);
    const mid = lerpCam(a, b, 0.5, frame);
    expect(near(mid.s, 0.5)).toBe(true);
  });

  test("the dots double their spacing as the plane zooms out, and sit on the world's grid", () => {
    expect(dotSpacing(1)).toBe(24);
    expect(dotSpacing(0.25)).toBe(12);
    expect(dotSpacing(0.1)).toBeCloseTo(19.2, 6);
    expect(dotSpacing(4)).toBe(96);
    const off = dotOffset({ x: 10, y: -30, s: 1 }, 24);
    expect(off).toEqual({ x: 14, y: 6 });
  });

  test("shapes are laid out for a screen around the view, again once the view leaves it", () => {
    const cam: Cam = { x: 0, y: 0, s: 1 };
    const box = laidOutBox(cam, frame);
    expect(inside(viewBox(cam, frame), box)).toBe(true);
    expect(box).toEqual({ x: -390, y: -700, w: 1170, h: 2100 });
    expect(inside(viewBox({ x: 500, y: 0, s: 1 }, frame), box)).toBe(false);
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 10, w: 5, h: 5 })).toBe(true);
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 11, y: 0, w: 5, h: 5 })).toBe(false);
  });

  test("the corner handle and the chosen shapes answer to a finger around them", () => {
    const cam: Cam = { x: 0, y: 0, s: 0.5 };
    const box = { x: 100, y: 100, w: 200, h: 100 };
    // Its corner on screen: (150, 100).
    expect(onHandle({ x: 160, y: 110 }, box, cam)).toBe(true);
    expect(onHandle({ x: 100, y: 100 }, box, cam)).toBe(false);
    expect(onHandle({ x: 150, y: 100 }, null, cam)).toBe(false);
    expect(onAnyBox({ x: 46, y: 60 }, [box], cam)).toBe(true);
    expect(onAnyBox({ x: 30, y: 60 }, [box], cam)).toBe(false);
  });

  test("stretching: a picture keeps its shape, nothing gets smaller than a finger's mark", () => {
    const box = { x: 0, y: 0, w: 400, h: 200 };
    expect(stretchBox(box, 100, 0, true, 1)).toEqual({ x: 0, y: 0, w: 500, h: 250 });
    expect(stretchBox(box, 0, 100, true, 1)).toEqual({ x: 0, y: 0, w: 600, h: 300 });
    expect(stretchBox(box, 100, -50, false, 1)).toEqual({ x: 0, y: 0, w: 500, h: 150 });
    const tiny = stretchBox(box, -1000, -1000, false, 2);
    expect(tiny.w).toBe(Math.max(8, MIN_SIDE / 2));
    const tinyPicture = stretchBox(box, -1000, -1000, true, 1);
    expect(tinyPicture.h).toBe(MIN_SIDE);
    expect(tinyPicture.w).toBe(MIN_SIDE * 2);
  });

  test("an arrow on the UI thread is the same line the file's arrows are", () => {
    const a = { x: 0, y: 0, w: 100, h: 50 };
    const b = { x: 300, y: 200, w: 80, h: 80 };
    expect(arrowLineW({ ...a, box: true }, { ...b, box: true })).toEqual(arrowPath(a, b));
    expect(arrowLineW({ ...a, box: true }, { x: 500, y: 20, w: 0, h: 0, box: false })).toEqual(
      arrowPath(a, { x: 500, y: 20 }),
    );
  });
});

describe("what a finger lands on", () => {
  const shapes = [
    shape({ id: "frame", type: "frame", x: 0, y: 0, w: 1000, h: 800, z: "a0", name: "Ideias" }),
    shape({ id: "under", type: "note", x: 100, y: 100, w: 200, h: 200, z: "a1" }),
    shape({ id: "over", type: "image", x: 150, y: 150, w: 200, h: 200, z: "a2" }),
    shape({ id: "dot", type: "text", x: 600, y: 600, w: 4, h: 4, z: "a3" }),
    shape({ id: "arrow", type: "arrow", z: "a4", from: { x: 2000, y: 0 }, to: { x: 2400, y: 0 } }),
  ];
  const byId = shapeIndex(shapes);

  test("the topmost shape there; a frame only where nothing else is", () => {
    expect(shapeAt(shapes, byId, { x: 200, y: 200 }, 1)).toBe("over");
    expect(shapeAt(shapes, byId, { x: 120, y: 120 }, 1)).toBe("under");
    expect(shapeAt(shapes, byId, { x: 900, y: 700 }, 1)).toBe("frame");
    // Its name over its top edge picks it too.
    expect(shapeAt(shapes, byId, { x: 20, y: -10 }, 1)).toBe("frame");
    expect(shapeAt(shapes, byId, { x: 1500, y: 1500 }, 1)).toBeNull();
  });

  test("a small shape answers to a finger-sized box; an arrow to its line", () => {
    expect(shapeAt(shapes, byId, { x: 615, y: 602 }, 1)).toBe("dot");
    expect(shapeAt(shapes, byId, { x: 2200, y: 8 }, 1)).toBe("arrow");
    expect(shapeAt(shapes, byId, { x: 2200, y: 40 }, 1)).toBeNull();
    // Zoomed out, the reach covers more of the world.
    expect(shapeAt(shapes, byId, { x: 2200, y: 40 }, 0.25)).toBe("arrow");
    expect(segmentDistance({ x: 5, y: 5 }, { x1: 0, y1: 0, x2: 10, y2: 0 })).toBe(5);
  });

  test("shapes laid out are those around the view, and the chosen ones wherever they are", () => {
    const view = { x: 0, y: 0, w: 500, h: 500 };
    expect(shapesIn(shapes, byId, view).map((s) => s.id)).toEqual(["frame", "under", "over"]);
    expect(shapesIn(shapes, byId, view, new Set(["arrow"])).map((s) => s.id)).toEqual([
      "frame",
      "under",
      "over",
      "arrow",
    ]);
  });

  test("what moves with what; what stretches and how", () => {
    const nested = [
      shape({ id: "outer", type: "frame" }),
      shape({ id: "inner", type: "frame", parent: "outer" }),
      shape({ id: "deep", type: "note", parent: "inner" }),
      shape({ id: "alone", type: "note" }),
    ];
    expect([...movingIds(["outer"], nested)].sort()).toEqual(["deep", "inner", "outer"]);
    expect([...movingIds(["alone"], nested)]).toEqual(["alone"]);
    expect(selectionBox(["under", "over"], byId)).toEqual({ x: 100, y: 100, w: 250, h: 250 });
    expect(selectionBox([], byId)).toBeNull();
    expect(stretchable(byId.get("over"))).toBe(true);
    expect(stretchable(byId.get("arrow"))).toBe(false);
    expect(stretchable({ type: "note", locked: true })).toBe(false);
    expect(keepsRatio({ type: "image" })).toBe(true);
    expect(keepsRatio({ type: "note" })).toBe(false);
    expect(chosenPictures(["under", "over", "gone"], byId)).toEqual([]);
    const withAsset = shapeIndex([shape({ id: "p", type: "image", asset: "a1" })]);
    expect(chosenPictures(["p"], withAsset)).toEqual(["p"]);
  });
});

describe("arrows, new things and pictures being made", () => {
  test("arrows are drawn between their shapes; one whose shape is gone isn't", () => {
    const list = [
      shape({ id: "a", type: "note", x: 0, y: 0, w: 100, h: 100 }),
      shape({ id: "b", type: "note", x: 400, y: 0, w: 100, h: 100 }),
      shape({ id: "ab", type: "arrow", from: { shape: "a" }, to: { shape: "b" }, dashed: true }),
      shape({ id: "ax", type: "arrow", from: { shape: "a" }, to: { x: 0, y: 500 } }),
      shape({ id: "gone", type: "arrow", from: { shape: "zz" }, to: { x: 0, y: 0 } }),
    ];
    const draws = arrowDraws(list, shapeIndex(list));
    expect(draws.map((d) => d.id)).toEqual(["ab", "ax"]);
    expect(draws[0]).toMatchObject({ dashed: true, from: { shape: "a", box: true }, to: { shape: "b", box: true } });
    expect(draws[1]?.to).toEqual({ x: 0, y: 500, w: 0, h: 0, box: false, shape: null });
    const [tipX, tipY, lx, ly, rx, ry] = arrowHead({ x1: 0, y1: 0, x2: 100, y2: 0 }, 10);
    expect([tipX, tipY]).toEqual([100, 0]);
    expect(near(lx, 90) && near(rx, 90) && near(ly, 5.5) && near(ry, -5.5)).toBe(true);
  });

  test("a photo lands at its proportions, its longest side 640 at most", () => {
    const photo = pictureSize(4032, 3024);
    expect(photo.w).toBeCloseTo(640, 6);
    expect(photo.h).toBeCloseTo(480, 6);
    expect(pictureSize(300, 200)).toEqual({ w: 300, h: 200 });
    expect(pictureSize(null, null)).toEqual({ w: 640, h: 640 });
  });

  test("new things go to free room near the middle of the view, never over what is there", () => {
    const doc = new Y.Doc();
    initLiveDoc(doc, "canvas");
    addShape(doc, { type: "note", x: -100, y: -100, w: 200, h: 200 }, LOCAL);
    const boxes = placeNear(doc, { x: 0, y: 0 }, [
      { w: 640, h: 480 },
      { w: 300, h: 200 },
    ]);
    expect(boxes).toHaveLength(2);
    const existing = readShapes(doc);
    for (const b of boxes) for (const s of existing) expect(rectsIntersect(b, s)).toBe(false);
    expect(rectsIntersect(boxes[0] ?? b0, boxes[1] ?? b0)).toBe(false);
    expect(boxes[1]).toMatchObject({ w: 300, h: 200 });
    expect(placeNear(doc, { x: 0, y: 0 }, [])).toEqual([]);
  });

  test("a placeholder says it waits, it is being made, or why it failed", () => {
    expect(pendingWords({ status: "queued" })).toBe("live.images.queued");
    expect(pendingWords({ status: "running" })).toBe("live.images.making");
    expect(pendingWords({ status: "failed", error: "no_key" })).toBe("live.images.failed.noKey");
    expect(pendingWords({ status: "failed", error: "too_many" })).toBe("live.images.failed.tooMany");
    expect(failureKey("blocked")).toBe("blocked");
    expect(failureKey("weird")).toBe("other");
    expect(failureKey(undefined)).toBe("other");
    expect(retryable({ type: "pending", status: "failed", request: "r1" })).toBe(true);
    expect(retryable({ type: "pending", status: "running", request: "r1" })).toBe(false);
    expect(retryable({ type: "pending", status: "failed" })).toBe(false);
  });
});

describe("everyone else on the plane", () => {
  const peer = (clientId: number, state: Partial<PeerState>, self = false): Peer => ({
    clientId,
    self,
    user: { kind: "person", id: `u${clientId}` },
    state: { user: { kind: "person", id: `u${clientId}` }, mode: "editing", ...state },
  });

  test("their chosen shapes that still exist, and their pointers on the canvas", () => {
    const byId = shapeIndex([shape({ id: "s1", type: "note" })]);
    const peers = [
      peer(1, { sel: { canvas: ["s1"] } }, true),
      peer(2, { sel: { canvas: ["s1", "gone"] }, cursor: { x: 5, y: 6, space: "canvas" } }),
      peer(3, { sel: { canvas: ["gone"] }, cursor: { x: 1, y: 1, space: "slide" } }),
    ];
    expect(peerPicks(peers, byId).map((p) => [p.peer.clientId, p.ids])).toEqual([[2, ["s1"]]]);
    expect(peerPointers(peers).map((p) => [p.peer.clientId, p.at])).toEqual([[2, { x: 5, y: 6 }]]);
  });
});

describe("the plane's dots", () => {
  test("the dots' color reads every way a theme writes one", () => {
    expect(colorFloats("#ffffff")).toEqual([1, 1, 1, 1]);
    expect(colorFloats("#000")).toEqual([0, 0, 0, 1]);
    const line = colorFloats("rgba(60, 60, 67, 0.14)");
    expect(line[3]).toBe(0.14);
    expect(near(line[0], 60 / 255)).toBe(true);
    expect(colorFloats("nonsense")).toEqual([0, 0, 0, 1]);
  });
});

describe("the canvas's screens", () => {
  test("each is its own push; the plane lays out below an opaque bar", () => {
    const file = join(MAIN, "canvas/[id].tsx");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("isSafeId(id)");
    expect(ownOptionsOf("canvas/[id]")).toBe("solid,");
    // Pictures come from the agents in the file's conversation now (ADR 0199): no screen of its own to make them.
    expect(existsSync(join(MAIN, "generate/[id].tsx"))).toBe(false);
  });

  test("the plane moves on the UI thread and writes the file once a finger lifts", () => {
    const plane = src("features/live-files/canvas/CanvasPlane.tsx");
    // A drag never calls back to React per frame: only when it starts and ends.
    const update = plane.slice(plane.indexOf("onUpdate: (e) => {"), plane.indexOf("onDeactivate: (e) => {"));
    expect(update).not.toContain("scheduleOnRN");
    expect(plane).toContain("moveShapes(doc, selected, dx, dy, LOCAL)");
    expect(plane).toContain("resizeShape(doc, id, box, LOCAL)");
    // The camera's glides take the theme's motion.
    expect(plane).toContain("const GLIDE = { duration: motion.panel, easing: motion.easeInOut };");
    const screen = src("features/live-files/canvas/CanvasScreen.tsx");
    expect(screen).toContain("usePhotoPick(room.orgId, fileId)");
    expect(screen).not.toContain("generateRoute");
  });
});
