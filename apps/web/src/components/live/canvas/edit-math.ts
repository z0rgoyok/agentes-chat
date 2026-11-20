import {
  type ArrowRoute,
  type Box,
  center,
  containsPoint,
  descendantsOf,
  type ImageCrop,
  type Point,
  rectsIntersect,
  resolveEnd,
  routeArrow,
  type ShapeView,
  shapeBounds,
  union,
} from "@agenteschat/live/canvas";

/**
 * The canvas editor's geometry (ADR 0196 §2), apart from React so it is tested on its own: what a press lands on,
 * what a marquee takes, how a box follows a resize handle (turned shapes too), the angle a rotation handle gives, and
 * where an arrow's line runs.
 */

/** A resize handle: the corners and the middles of the sides. */
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
export const CORNERS: readonly Handle[] = ["nw", "ne", "se", "sw"];

/** Which way each handle pulls: -1 the left or top side, 1 the right or bottom one, 0 neither. */
export const HANDLE_DIR: Record<Handle, readonly [number, number]> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

/** The smallest a shape gets by its handles, in world units. */
export const MIN_SIDE = 16;

const rad = (deg: number) => (deg * Math.PI) / 180;

function rotate(p: Point, deg: number): Point {
  if (!deg) return { x: p.x, y: p.y };
  const a = rad(deg);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
}

/** Where a handle sits on a (turned) box, in world units. */
export function handlePoint(box: Box, rot: number, handle: Handle): Point {
  const [hx, hy] = HANDLE_DIR[handle];
  const c = center(box);
  const off = rotate({ x: (hx * box.w) / 2, y: (hy * box.h) / 2 }, rot);
  return { x: c.x + off.x, y: c.y + off.y };
}

/**
 * A box dragged by one of its handles by `delta` (world units): the opposite side or corner stays where it is, also
 * on a turned box. `ratio` keeps its proportions (pictures always; Shift for the rest); no side goes under `min`.
 */
export function resizeBox(
  box: Box,
  rot: number,
  handle: Handle,
  delta: Point,
  opts: { ratio?: boolean; min?: number } = {},
): Box {
  const min = opts.min ?? MIN_SIDE;
  const [hx, hy] = HANDLE_DIR[handle];
  const local = rotate(delta, -rot);
  let w = box.w + hx * local.x;
  let h = box.h + hy * local.y;
  if (opts.ratio && box.w > 0 && box.h > 0) {
    const r = box.w / box.h;
    if (hx !== 0 && hy !== 0) {
      // A corner: the side pulled further leads.
      if (Math.abs(w / box.w) > Math.abs(h / box.h)) h = w / r;
      else w = h * r;
    } else if (hx !== 0) h = w / r;
    else w = h * r;
    if (w < min || h < min) {
      const k = Math.max(min / Math.max(w, 1e-9), min / Math.max(h, 1e-9));
      w *= k;
      h *= k;
    }
  } else {
    w = Math.max(min, w);
    h = Math.max(min, h);
  }
  // The fixed point: the side or corner opposite the handle (its middle, along a side that doesn't move).
  const c = center(box);
  const anchorLocal = { x: (-hx * box.w) / 2, y: (-hy * box.h) / 2 };
  const anchor = rotate(anchorLocal, rot);
  const anchorWorld = { x: c.x + anchor.x, y: c.y + anchor.y };
  const nextLocal = rotate({ x: (-hx * w) / 2, y: (-hy * h) / 2 }, rot);
  const nc = { x: anchorWorld.x - nextLocal.x, y: anchorWorld.y - nextLocal.y };
  return { x: nc.x - w / 2, y: nc.y - h / 2, w, h };
}

/**
 * Several shapes resized together by a corner of the box around them: each one keeps its place and size relative
 * to that box (`ratio` keeps the group's proportions).
 */
export function scaleGroup(
  bounds: Box,
  handle: Handle,
  delta: Point,
  boxes: readonly Box[],
  opts: { ratio?: boolean } = {},
): { bounds: Box; boxes: Box[] } {
  const next = resizeBox(bounds, 0, handle, delta, { ratio: opts.ratio, min: MIN_SIDE });
  const kx = bounds.w > 0 ? next.w / bounds.w : 1;
  const ky = bounds.h > 0 ? next.h / bounds.h : 1;
  return {
    bounds: next,
    boxes: boxes.map((b) => ({
      x: next.x + (b.x - bounds.x) * kx,
      y: next.y + (b.y - bounds.y) * ky,
      w: Math.max(1, b.w * kx),
      h: Math.max(1, b.h * ky),
    })),
  };
}

/** The angle (degrees, 0..360) a rotation handle above the box gives with the pointer at `p`; Shift snaps to 15°. */
export function rotationAt(c: Point, p: Point, snap = false): number {
  let deg = (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI + 90;
  if (snap) deg = Math.round(deg / 15) * 15;
  return ((deg % 360) + 360) % 360;
}

/** How far `p` is from the segment `a`–`b`. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** How far `p` is from a line through `points` (one point: from it; none: endless). */
export function distanceToPolyline(p: Point, points: readonly Point[]): number {
  if (points.length === 1) {
    const only = points[0] as Point;
    return Math.hypot(p.x - only.x, p.y - only.y);
  }
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < points.length; i++) {
    best = Math.min(best, distanceToSegment(p, points[i] as Point, points[i + 1] as Point));
  }
  return best;
}

/** A point in a turned shape's own (unturned) frame. */
function unturned(s: Box & { rot?: number }, p: Point): Point {
  if (!s.rot) return p;
  const c = center(s);
  const q = rotate({ x: p.x - c.x, y: p.y - c.y }, -s.rot);
  return { x: c.x + q.x, y: c.y + q.y };
}

/** A pen stroke's points in the world (they are kept from its box's corner). */
export function strokePoints(s: Pick<ShapeView, "x" | "y" | "points">): Point[] {
  const pts = s.points ?? [];
  const out: Point[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    out.push({ x: s.x + (pts[i] as number), y: s.y + (pts[i + 1] as number) });
  }
  return out;
}

/** Points a curve is drawn through, to take and outline it (`routeArrow`'s path, which every app draws). */
const CURVE_STEPS = 16;

/** The points along an arrow's route: its two ends, the corners of an elbow, or a curve's points. */
export function routePoints(
  line: { x1: number; y1: number; x2: number; y2: number },
  route: ArrowRoute | undefined,
): Point[] {
  const a = { x: line.x1, y: line.y1 };
  const b = { x: line.x2, y: line.y2 };
  if (!route || route === "straight") return [a, b];
  const d = routeArrow(line, route).d;
  const n = (d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  if (d.includes("Q")) {
    const [sx = a.x, sy = a.y, cx = a.x, cy = a.y, ex = b.x, ey = b.y] = n;
    const out: Point[] = [];
    for (let i = 0; i <= CURVE_STEPS; i++) {
      const t = i / CURVE_STEPS;
      const u = 1 - t;
      out.push({ x: u * u * sx + 2 * u * t * cx + t * t * ex, y: u * u * sy + 2 * u * t * cy + t * t * ey });
    }
    return out;
  }
  const out: Point[] = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push({ x: n[i] as number, y: n[i + 1] as number });
  return out.length >= 2 ? out : [a, b];
}

/**
 * A pen stroke's points (x, y pairs) made lighter to keep: points nearer than `tolerance` to the line between the
 * ones kept around them go (Ramer-Douglas-Peucker), at most `max` numbers are left (every so many kept past that),
 * each rounded to a hundredth. The stroke still reads the same: its path is smoothed when drawn (`strokePath`).
 */
export function thinStroke(points: readonly number[], tolerance: number, max = 4000): number[] {
  const n = Math.floor(points.length / 2);
  const at = (i: number): Point => ({ x: points[2 * i] as number, y: points[2 * i + 1] as number });
  const r = (v: number) => Math.round(v * 100) / 100;
  let kept: number[];
  if (n <= 2) kept = Array.from({ length: n }, (_, i) => i);
  else {
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    const spans: [number, number][] = [[0, n - 1]];
    while (spans.length) {
      const [i, j] = spans.pop() as [number, number];
      let far = tolerance;
      let pick = -1;
      for (let k = i + 1; k < j; k++) {
        const d = distanceToSegment(at(k), at(i), at(j));
        if (d > far) {
          far = d;
          pick = k;
        }
      }
      if (pick >= 0) {
        keep[pick] = 1;
        spans.push([i, pick], [pick, j]);
      }
    }
    kept = [];
    for (let i = 0; i < n; i++) if (keep[i]) kept.push(i);
  }
  const most = Math.max(2, Math.floor(max / 2));
  if (kept.length > most) {
    const step = (kept.length - 1) / (most - 1);
    const all = kept;
    kept = Array.from({ length: most }, (_, i) => all[Math.round(i * step)] as number);
  }
  return kept.flatMap((i) => [r(points[2 * i] as number), r(points[2 * i + 1] as number)]);
}

/** A picture's whole extent in the world, of which its box shows the part its crop says (ADR 0196 §2). */
export function fullImageBox(shape: Box & { crop?: ImageCrop }): Box {
  const c = shape.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const w = shape.w / c.w;
  const h = shape.h / c.h;
  return { x: shape.x - c.x * w, y: shape.y - c.y * h, w, h };
}

/**
 * The crop window dragged by `delta` (world units): by a handle, the opposite side staying put, or moved whole, always
 * inside the picture and never smaller than `min` on a side.
 */
export function dragCrop(rect: Box, full: Box, handle: Handle | "move", delta: Point, min = MIN_SIDE): Box {
  const right = full.x + full.w;
  const bottom = full.y + full.h;
  if (handle === "move") {
    const x = Math.min(Math.max(rect.x + delta.x, full.x), right - rect.w);
    const y = Math.min(Math.max(rect.y + delta.y, full.y), bottom - rect.h);
    return { x, y, w: rect.w, h: rect.h };
  }
  const side = Math.min(min, full.w, full.h);
  const [hx, hy] = HANDLE_DIR[handle];
  let x1 = rect.x;
  let y1 = rect.y;
  let x2 = rect.x + rect.w;
  let y2 = rect.y + rect.h;
  if (hx < 0) x1 = Math.min(Math.max(x1 + delta.x, full.x), x2 - side);
  if (hx > 0) x2 = Math.max(Math.min(x2 + delta.x, right), x1 + side);
  if (hy < 0) y1 = Math.min(Math.max(y1 + delta.y, full.y), y2 - side);
  if (hy > 0) y2 = Math.max(Math.min(y2 + delta.y, bottom), y1 + side);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** What a crop window makes of a picture: its new box (the window) and the part shown (null: the whole picture). */
export function cropFrom(rect: Box, full: Box): { box: Box; crop: ImageCrop | null } {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const x = clamp((rect.x - full.x) / full.w);
  const y = clamp((rect.y - full.y) / full.h);
  const w = Math.min(clamp(rect.w / full.w), 1 - x);
  const h = Math.min(clamp(rect.h / full.h), 1 - y);
  const whole = x < 1e-3 && y < 1e-3 && w > 1 - 2e-3 && h > 1 - 2e-3;
  return { box: { x: rect.x, y: rect.y, w: rect.w, h: rect.h }, crop: whole ? null : { x, y, w, h } };
}

/** An arrow's line now: its ends' boxes from border to border (bound ends follow their shapes), or null. */
export function arrowLine(
  arrow: ShapeView,
  byId: ReadonlyMap<string, ShapeView>,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const from = resolveEnd(arrow.from, byId);
  const to = resolveEnd(arrow.to, byId);
  if (!from || !to) return null;
  const a = "w" in from ? center(from) : from;
  const b = "w" in to ? center(to) : to;
  const start = "w" in from ? exitPoint(from, b) : a;
  const end = "w" in to ? exitPoint(to, a) : b;
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

/** Where the line from a box's center towards `toward` leaves the box, a little outside it. */
function exitPoint(box: Box, toward: Point): Point {
  const c = center(box);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const tx = dx === 0 ? Number.POSITIVE_INFINITY : Math.abs(box.w / 2 / dx);
  const ty = dy === 0 ? Number.POSITIVE_INFINITY : Math.abs(box.h / 2 / dy);
  const t = Math.min(tx, ty, 1);
  const len = Math.hypot(dx, dy);
  // A few units of air between the shape and the arrow's end.
  const gap = t < 1 ? 6 / len : 0;
  return { x: c.x + dx * (t + gap), y: c.y + dy * (t + gap) };
}

/** The filled head of an arrow ending at (x2, y2), as polygon points, `size` world units long. */
export function arrowHead(line: { x1: number; y1: number; x2: number; y2: number }, size = 14): string {
  const angle = Math.atan2(line.y2 - line.y1, line.x2 - line.x1);
  const spread = Math.PI / 7;
  const p = (a: number) => `${line.x2 - size * Math.cos(a)},${line.y2 - size * Math.sin(a)}`;
  return `${line.x2},${line.y2} ${p(angle - spread)} ${p(angle + spread)}`;
}

/** How near (screen pixels) a press must be to an arrow or a frame's edge to take it. */
export const HIT_SLOP = 6;

/** What a press on a shape's body takes: a frame's inside is room for a marquee unless the frame is chosen. */
export type HitPart = "body" | "frameInside" | "frameEdge";

/**
 * The topmost shape under the world point `p` (`z`: the zoom, for slop in screen pixels): arrows near their line,
 * frames on their edge or (as `frameInside`) anywhere inside, the rest inside their turned box. Locked shapes are
 * taken too (they still select; they don't move).
 */
export function hitShape(
  shapes: readonly ShapeView[],
  byId: ReadonlyMap<string, ShapeView>,
  p: Point,
  z: number,
): { id: string; part: HitPart } | null {
  const slop = HIT_SLOP / z;
  let inside: string | null = null;
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (!s) continue;
    if (s.type === "arrow") {
      const line = arrowLine(s, byId);
      const reach = slop + (s.strokeWidth ?? 2) / 2;
      if (line && distanceToPolyline(p, routePoints(line, s.route)) <= reach) return { id: s.id, part: "body" };
      continue;
    }
    if (s.type === "draw") {
      // A pen stroke is taken near its line, not anywhere in its box (a circle drawn round a picture leaves it free).
      const reach = slop + (s.strokeWidth ?? (s.tool === "marker" ? 16 : 4)) / 2;
      if (distanceToPolyline(unturned(s, p), strokePoints(s)) <= reach) return { id: s.id, part: "body" };
      continue;
    }
    if (s.type === "frame") {
      const grown = { x: s.x - slop, y: s.y - slop, w: s.w + 2 * slop, h: s.h + 2 * slop };
      if (!containsPoint(grown, p, s.rot ?? 0)) continue;
      const shrunk = { x: s.x + slop, y: s.y + slop, w: s.w - 2 * slop, h: s.h - 2 * slop };
      if (shrunk.w <= 0 || shrunk.h <= 0 || !containsPoint(shrunk, p, s.rot ?? 0))
        return { id: s.id, part: "frameEdge" };
      // Frames are drawn first: anything else over this point wins, so keep looking and fall back to the frame.
      inside ??= s.id;
      continue;
    }
    if (containsPoint(s, p, s.rot ?? 0)) return { id: s.id, part: "body" };
  }
  return inside ? { id: inside, part: "frameInside" } : null;
}

/**
 * What a marquee over the world box `rect` takes: shapes it touches, frames only when it holds them whole (a marquee
 * started inside a frame never takes the frame), and nothing inside a frame it takes (the frame carries them).
 */
export function marqueeHits(shapes: readonly ShapeView[], byId: ReadonlyMap<string, ShapeView>, rect: Box): string[] {
  const hits: string[] = [];
  for (const s of shapes) {
    const b = shapeBounds(s, byId);
    if (s.type === "frame") {
      if (b.x >= rect.x && b.y >= rect.y && b.x + b.w <= rect.x + rect.w && b.y + b.h <= rect.y + rect.h) {
        hits.push(s.id);
      }
      continue;
    }
    if (rectsIntersect(b, rect) || (b.w === 0 && b.h === 0 && containsPoint(rect, b))) hits.push(s.id);
  }
  return topLevelOf(hits, shapes);
}

/** The ids without the ones inside a frame that is among them. */
export function topLevelOf(ids: readonly string[], shapes: readonly ShapeView[]): string[] {
  const frames = ids.filter((id) => shapes.some((s) => s.id === id && s.type === "frame"));
  if (!frames.length) return [...ids];
  const inside = descendantsOf(frames, shapes);
  return ids.filter((id) => !inside.has(id));
}

/** The box around shapes (their turned bounds), or null. */
export function boundsOf(ids: readonly string[], byId: ReadonlyMap<string, ShapeView>): Box | null {
  const boxes: Box[] = [];
  for (const id of ids) {
    const s = byId.get(id);
    if (s) boxes.push(shapeBounds(s, byId));
  }
  return union(boxes);
}

/**
 * The boxes a moving selection snaps to: every shape on screen that isn't moving (nor inside a moving frame), and
 * isn't an arrow.
 */
export function snapTargets(
  shapes: readonly ShapeView[],
  byId: ReadonlyMap<string, ShapeView>,
  moving: ReadonlySet<string>,
  visible: Box,
): Box[] {
  const inside = descendantsOf(moving, shapes);
  const out: Box[] = [];
  for (const s of shapes) {
    if (s.type === "arrow" || moving.has(s.id) || inside.has(s.id)) continue;
    const b = shapeBounds(s, byId);
    if (rectsIntersect(b, visible, 200)) out.push(b);
  }
  return out;
}

/** A box from two corners (a drag in any direction). */
export function boxFrom(a: Point, b: Point): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}
