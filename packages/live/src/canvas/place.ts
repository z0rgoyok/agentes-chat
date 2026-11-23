import type * as Y from "yjs";
import { LiveEditError } from "../errors";
import { type Box, containsPoint, type Point, rectsIntersect, union } from "./geometry";
import { ancestorsOf, descendantsOf, readShapes, shapeBounds, shapeIndex } from "./store";
import type { Placement, PlaceOptions, ShapeView } from "./types";

/**
 * Where things go on a canvas (ADR 0196 §2, ADR 0197): the bounds of what's there, the frame under a point, and free
 * room for new shapes (a batch of generated images, an agent's notes) that never lands on anything already there.
 */

/** The box around everything on the canvas, or null when it is empty. */
export function contentBounds(doc: Y.Doc): Box | null {
  const shapes = readShapes(doc, { text: false });
  const byId = shapeIndex(shapes);
  return union(shapes.map((shape) => shapeBounds(shape, byId)));
}

/**
 * The innermost frame holding the point (the deepest, then the topmost), or null. Frames in `exclude` and the frames
 * inside them are skipped (a frame being dragged can't be dropped into itself).
 */
export function frameAt(doc: Y.Doc, x: number, y: number, exclude: readonly string[] = []): string | null {
  const shapes = readShapes(doc, { text: false });
  const byId = shapeIndex(shapes);
  const skip = new Set([...exclude, ...descendantsOf(exclude, shapes)]);
  let best: string | null = null;
  let bestDepth = -1;
  for (const shape of shapes) {
    if (shape.type !== "frame" || skip.has(shape.id) || !containsPoint(shape, { x, y })) continue;
    // Shapes come in drawing order, so a later frame of the same depth is the one on top.
    const depth = ancestorsOf(shape.id, byId).length;
    if (depth >= bestDepth) {
      best = shape.id;
      bestDepth = depth;
    }
  }
  return best;
}

/** Room left above a frame for its name label (drawn above its top-left corner). */
export const FRAME_LABEL = 32;
/** A row of things placed one after another wraps past this width. */
const MAX_ROW_WIDTH = 7200;
/** How many spots a search tries before it falls back to room that is free for sure. */
const MAX_TRIES = 2500;

interface Grid {
  width: number;
  height: number;
  cells: Point[];
}

interface Size {
  w: number;
  h: number;
}

/** `count` boxes in rows (up to four in a row for a few, a squarish block for many), with `gap` between them. */
function gridOf(count: number, w: number, h: number, gap: number): Grid {
  const cols = Math.min(count, Math.max(4, Math.ceil(Math.sqrt(count))));
  const rows = Math.ceil(count / cols);
  const cells: Point[] = [];
  for (let i = 0; i < count; i++) {
    cells.push({ x: (i % cols) * (w + gap), y: Math.floor(i / cols) * (h + gap) });
  }
  return { width: cols * w + (cols - 1) * gap, height: rows * h + (rows - 1) * gap, cells };
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Whether a box at (x, y) of `need` keeps `gap` away from every obstacle (with `top` more room above it). */
function freeAt(at: Point, need: Size, top: number, gap: number, obstacles: readonly Box[]): boolean {
  const box = { x: at.x, y: at.y - top, w: need.w, h: need.h + top };
  for (const other of obstacles) if (rectsIntersect(box, other, gap / 2)) return false;
  return true;
}

/** The cells of the square ring `ring` steps around the center, as step offsets. */
function ringCells(ring: number): [number, number][] {
  const cells: [number, number][] = [];
  for (let i = -ring; i <= ring; i++) cells.push([i, -ring], [i, ring]);
  for (let j = -ring + 1; j < ring; j++) cells.push([-ring, j], [ring, j]);
  return cells;
}

/** The free spot nearest to `target` (a top-left corner) on rings around it, or null when none is near. */
function nearestFree(target: Point, need: Size, top: number, gap: number, obstacles: readonly Box[]): Point | null {
  if (freeAt(target, need, top, gap, obstacles)) return target;
  const step = Math.max(16, gap, Math.min(need.w, need.h) / 3);
  let tries = 1;
  for (let ring = 1; tries < MAX_TRIES; ring++) {
    let best: Point | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [i, j] of ringCells(ring)) {
      tries++;
      const distance = Math.hypot(i, j);
      if (distance >= bestDistance) continue;
      const spot = { x: target.x + i * step, y: target.y + j * step };
      if (freeAt(spot, need, top, gap, obstacles)) {
        best = spot;
        bestDistance = distance;
      }
    }
    if (best) return best;
  }
  return null;
}

/** The top-level shape added last (the highest stacking key), whose right side the next things go to. */
function lastTopLevel(shapes: readonly ShapeView[]): ShapeView | null {
  let last: ShapeView | null = null;
  for (const shape of shapes) {
    if (shape.parent || shape.type === "arrow") continue;
    if (!last || shape.z > last.z) last = shape;
  }
  return last;
}

/**
 * Free room for `count` boxes of `w`×`h` (`gap` apart, and `gap` away from everything): around `near` when given,
 * else to the right of what was added last (a new row under everything once a row is past 7200 units wide), the
 * nearest spot that is free. With `frame`, inside a new frame (its box comes back too, with `gap` of padding and room
 * for its name above it); with `within`, inside that existing frame, which grows when it has no room left. The boxes
 * never overlap anything on the canvas, nor each other.
 */
export function placeBoxes(doc: Y.Doc, opts: PlaceOptions): Placement {
  const count = Math.min(500, Math.max(1, Math.floor(positive(opts.count, 1))));
  const w = positive(opts.w, 200);
  const h = positive(opts.h, 200);
  const gap = typeof opts.gap === "number" && Number.isFinite(opts.gap) && opts.gap >= 0 ? opts.gap : 40;
  const shapes = readShapes(doc, { text: false });
  const byId = shapeIndex(shapes);
  const grid = gridOf(count, w, h, gap);
  const at = (origin: Point, pad: number): Box[] =>
    grid.cells.map((cell) => ({ x: origin.x + pad + cell.x, y: origin.y + pad + cell.y, w, h }));
  if (opts.within) return placeWithin(shapes, byId, opts.within, grid, gap, (origin) => at(origin, 0));
  const pad = opts.frame ? gap : 0;
  const need = { w: grid.width + 2 * pad, h: grid.height + 2 * pad };
  const top = opts.frame ? FRAME_LABEL : 0;
  const obstacles = shapes.map((shape) => shapeBounds(shape, byId));
  const bounds = union(obstacles);
  const near = opts.near && Number.isFinite(opts.near.x) && Number.isFinite(opts.near.y) ? opts.near : null;
  let origin: Point;
  if (!bounds) {
    origin = near ? { x: near.x - need.w / 2, y: near.y - need.h / 2 } : { x: 0, y: top };
  } else {
    // Below everything is free for sure: where things go when nothing near the target is.
    const below = { x: bounds.x, y: bounds.y + bounds.h + 2 * gap + top };
    let target: Point;
    if (near) target = { x: near.x - need.w / 2, y: near.y - need.h / 2 };
    else {
      const last = lastTopLevel(shapes);
      const anchor = last ? shapeBounds(last, byId) : bounds;
      const right = anchor.x + anchor.w + 2 * gap;
      target = right + need.w - bounds.x <= MAX_ROW_WIDTH ? { x: right, y: anchor.y + top } : below;
    }
    origin = nearestFree(target, need, top, gap, obstacles) ?? below;
  }
  const boxes = at(origin, pad);
  return opts.frame ? { frame: { x: origin.x, y: origin.y, w: need.w, h: need.h }, boxes } : { boxes };
}

/** Whether `other`, outside the frame's current box, would end up inside it once it grows to `next`. */
function swallows(other: Box, current: Box, next: Box): boolean {
  return !rectsIntersect(other, current) && rectsIntersect(other, next);
}

function placeWithin(
  shapes: readonly ShapeView[],
  byId: ReadonlyMap<string, ShapeView>,
  frameId: string,
  grid: Grid,
  gap: number,
  at: (origin: Point) => Box[],
): Placement {
  const frame = byId.get(frameId);
  if (frame?.type !== "frame") throw new LiveEditError("not_found", `No frame ${frameId}`);
  const box: Box = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
  const outer = new Set([frameId, ...ancestorsOf(frameId, byId)]);
  const obstacles = shapes.filter((s) => !outer.has(s.id)).map((s) => shapeBounds(s, byId));
  const need = { w: grid.width, h: grid.height };
  // Inside, row by row from the top left.
  const step = Math.max(8, gap / 2);
  let tries = 0;
  for (let y = box.y + gap; y + need.h <= box.y + box.h - gap && tries < MAX_TRIES; y += step) {
    for (let x = box.x + gap; x + need.w <= box.x + box.w - gap && tries < MAX_TRIES; x += step) {
      tries++;
      if (freeAt({ x, y }, need, 0, gap, obstacles)) return { boxes: at({ x, y }) };
    }
  }
  const grown = (origin: Point): Placement => {
    const right = Math.max(box.x + box.w, origin.x + need.w + gap);
    const bottom = Math.max(box.y + box.h, origin.y + need.h + gap);
    const next = { x: box.x, y: box.y, w: right - box.x, h: bottom - box.y };
    return { boxes: at(origin), grow: { id: frameId, box: next } };
  };
  const fits = (origin: Point): boolean => {
    if (!freeAt(origin, need, 0, gap, obstacles)) return false;
    const next = grown(origin).grow?.box ?? box;
    return !obstacles.some((other) => swallows(other, box, next));
  };
  const inside = obstacles.filter((other) => rectsIntersect(other, box));
  // Under what's in it (the frame growing down), else beside it (the frame growing right).
  const under = { x: box.x + gap, y: Math.max(box.y, ...inside.map((o) => o.y + o.h)) + gap };
  if (fits(under)) return grown(under);
  const beside = { x: Math.max(box.x, ...inside.map((o) => o.x + o.w)) + gap, y: box.y + gap };
  if (fits(beside)) return grown(beside);
  // Below everything in the boxes' column: free for sure, the frame growing down to it.
  const left = box.x;
  const right = box.x + need.w + 2 * gap;
  const column = obstacles.filter((o) => o.x < right && o.x + o.w > left);
  const lowest = Math.max(box.y + box.h, ...column.map((o) => o.y + o.h));
  return grown({ x: box.x + gap, y: lowest + gap });
}
