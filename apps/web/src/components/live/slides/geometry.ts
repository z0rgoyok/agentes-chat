import { type Box, type Guide, type Point, rectsIntersect, rotatedBounds, snapLines, union } from "@agenteschat/live";
import type { ElementView } from "@agenteschat/live/slides";

/**
 * The stage's geometry (ADR 0196 §2), in slide units with y down and rotation in degrees clockwise around a box's
 * middle: fitting a slide in its room, where a selection's edges are, moving with snapping guides, resizing from any
 * handle of a turned box, turning, and picking with a marquee. Pure, so it is tested without a page.
 */

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** The smallest an element gets by resizing, in slide units. */
export const MIN_SIZE = 16;

/** The scale that fits a `w`×`h` slide in a `roomW`×`roomH` room with `margin` page pixels around it. */
export function fitScale(roomW: number, roomH: number, w: number, h: number, margin: number): number {
  const sx = (roomW - margin * 2) / w;
  const sy = (roomH - margin * 2) / h;
  const s = Math.min(sx, sy);
  return Number.isFinite(s) && s > 0 ? s : 0.1;
}

/** An element's box as drawn: a line's from both its ends (its `w`/`h` may be negative). */
export function elementBox(el: Pick<ElementView, "type" | "x" | "y" | "w" | "h">): Box {
  if (el.type !== "line") return { x: el.x, y: el.y, w: el.w, h: el.h };
  return { x: Math.min(el.x, el.x + el.w), y: Math.min(el.y, el.y + el.h), w: Math.abs(el.w), h: Math.abs(el.h) };
}

/** The upright box around an element, turned or not. */
export function elementBounds(el: Pick<ElementView, "type" | "x" | "y" | "w" | "h" | "rot">): Box {
  const box = elementBox(el);
  return el.type === "line" || !el.rot ? box : rotatedBounds(box, el.rot);
}

/** The upright box around several elements. */
export function boundsOf(els: readonly Pick<ElementView, "type" | "x" | "y" | "w" | "h" | "rot">[]): Box | null {
  return union(els.map(elementBounds));
}

/**
 * Where a moved selection snaps: its edges and middle to the slide's edges and middle and to the other elements'
 * edges and middles, within `tolerance`. Returns the nudge and the guides to draw.
 */
export function snapMove(
  moving: Box,
  others: readonly Box[],
  slide: { w: number; h: number },
  tolerance: number,
): { dx: number; dy: number; guides: Guide[] } {
  const page: Box = { x: 0, y: 0, w: slide.w, h: slide.h };
  const result = snapLines(moving, [page, ...others], tolerance);
  // A guide along the slide's own edge or middle spans the whole slide, as the eye expects.
  const guides = result.guides.map((g) => {
    const onPage = g.axis === "x" ? [0, slide.w / 2, slide.w] : [0, slide.h / 2, slide.h];
    if (!onPage.some((v) => Math.abs(v - g.at) < 0.5)) return g;
    return { ...g, from: 0, to: g.axis === "x" ? slide.h : slide.w };
  });
  return { dx: result.dx, dy: result.dy, guides };
}

function rotate(p: Point, deg: number): Point {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
}

/**
 * A box resized from `handle` by a pointer that moved `delta` (slide units, the page's axes), the box turned by `rot`:
 * the opposite edge or corner stays where it is on the slide. `keepRatio` keeps the proportions (the corners; on an
 * edge, the other side grows around the middle).
 */
export function resizeBox(
  start: Box,
  rot: number,
  handle: Handle,
  delta: Point,
  keepRatio: boolean,
  min = MIN_SIZE,
): Box {
  const d = rotate(delta, -rot);
  let left = -start.w / 2;
  let right = start.w / 2;
  let top = -start.h / 2;
  let bottom = start.h / 2;
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.startsWith("n");
  const south = handle.startsWith("s");
  if (west) left = Math.min(left + d.x, right - min);
  if (east) right = Math.max(right + d.x, left + min);
  if (north) top = Math.min(top + d.y, bottom - min);
  if (south) bottom = Math.max(bottom + d.y, top + min);
  if (keepRatio && start.w > 0 && start.h > 0) {
    const ratio = start.w / start.h;
    const corner = (west || east) && (north || south);
    if (corner) {
      const w = right - left;
      const h = bottom - top;
      // The side the pointer moved more along leads.
      if (w / ratio >= h) {
        const nh = w / ratio;
        if (north) top = bottom - nh;
        else bottom = top + nh;
      } else {
        const nw = h * ratio;
        if (west) left = right - nw;
        else right = left + nw;
      }
    } else if (west || east) {
      const nh = (right - left) / ratio;
      top = -nh / 2;
      bottom = nh / 2;
    } else {
      const nw = (bottom - top) * ratio;
      left = -nw / 2;
      right = nw / 2;
    }
  }
  const w = right - left;
  const h = bottom - top;
  // The new middle, back on the slide's axes.
  const shift = rotate({ x: (left + right) / 2, y: (top + bottom) / 2 }, rot);
  const cx = start.x + start.w / 2 + shift.x;
  const cy = start.y + start.h / 2 + shift.y;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Several boxes resized together inside their bounds (the bounds resized like one box, each kept in its place). */
export function resizeAll(boxes: readonly Box[], from: Box, to: Box): Box[] {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  return boxes.map((b) => ({
    x: to.x + (b.x - from.x) * sx,
    y: to.y + (b.y - from.y) * sy,
    w: b.w * sx,
    h: b.h * sy,
  }));
}

/**
 * The turn that points a box's top at `pointer` (degrees in [0, 360)): with `step` it moves in 15° steps; without, it
 * still holds at a right angle when within 4° of one.
 */
export function rotationAt(center: Point, pointer: Point, step: boolean): number {
  const raw = (Math.atan2(pointer.y - center.y, pointer.x - center.x) * 180) / Math.PI + 90;
  let deg = ((raw % 360) + 360) % 360;
  if (step) deg = Math.round(deg / 15) * 15;
  else {
    const right = Math.round(deg / 90) * 90;
    if (Math.abs(deg - right) <= 4) deg = right;
  }
  deg = ((deg % 360) + 360) % 360;
  return Math.round(deg * 10) / 10;
}

/** The ids of the elements a marquee touches. */
export function marqueeHits(
  els: readonly Pick<ElementView, "id" | "type" | "x" | "y" | "w" | "h" | "rot">[],
  rect: Box,
): string[] {
  return els.filter((el) => rectsIntersect(elementBounds(el), rect)).map((el) => el.id);
}

/** The rectangle from where a drag started to where it is now. */
export function rectFrom(a: Point, b: Point): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** A line's two ends. */
export function lineEnds(el: Pick<ElementView, "x" | "y" | "w" | "h">): [Point, Point] {
  return [
    { x: el.x, y: el.y },
    { x: el.x + el.w, y: el.y + el.h },
  ];
}

/**
 * A line with one end moved to `to` (the other stays). With `straight` the line holds at the nearest 45°, as a ruler
 * would.
 */
export function moveLineEnd(
  el: Pick<ElementView, "x" | "y" | "w" | "h">,
  end: 0 | 1,
  to: Point,
  straight: boolean,
): { x: number; y: number; w: number; h: number } {
  const [a, b] = lineEnds(el);
  const fixed = end === 0 ? b : a;
  let p = to;
  if (straight) {
    const dx = to.x - fixed.x;
    const dy = to.y - fixed.y;
    const len = Math.hypot(dx, dy);
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    p = { x: fixed.x + Math.cos(angle) * len, y: fixed.y + Math.sin(angle) * len };
  }
  const round = (n: number) => Math.round(n * 10) / 10;
  if (end === 0) return { x: round(p.x), y: round(p.y), w: round(fixed.x - p.x), h: round(fixed.y - p.y) };
  return { x: round(fixed.x), y: round(fixed.y), w: round(p.x - fixed.x), h: round(p.y - fixed.y) };
}

/** Rounds a box to tenths of a unit (what gets stored: no long fractions in the document). */
export function roundBox(box: Box): Box {
  const r = (n: number) => Math.round(n * 10) / 10;
  return { x: r(box.x), y: r(box.y), w: r(box.w), h: r(box.h) };
}

/** Where the 8 handles of a box are, in its own (unturned) frame relative to its middle. */
export function handleOffset(handle: Handle, w: number, h: number): Point {
  const x = handle.includes("w") ? -w / 2 : handle.includes("e") ? w / 2 : 0;
  const y = handle.startsWith("n") ? -h / 2 : handle.startsWith("s") ? h / 2 : 0;
  return { x, y };
}

/** The cursor a handle shows, turned with its box (the nearest of the four resize cursors). */
export function handleCursor(handle: Handle, rot: number): string {
  const base: Record<Handle, number> = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 };
  const angle = (((base[handle] + rot) % 180) + 180) % 180;
  const step = Math.round(angle / 45) % 4;
  return ["ns-resize", "nesw-resize", "ew-resize", "nwse-resize"][step] ?? "move";
}
