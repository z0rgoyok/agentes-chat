/**
 * Plane geometry for canvases and slides (ADR 0196 §2): boxes in world (or slide) units, y down, rotation in degrees
 * clockwise around a box's center.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A snapping guide: for axis "x" a vertical line at x = `at` from y = `from` to `to`; for "y" a horizontal one. */
export interface Guide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
}

export function isBox(value: unknown): value is Box {
  if (!value || typeof value !== "object") return false;
  const b = value as Record<string, unknown>;
  return [b.x, b.y, b.w, b.h].every((n) => typeof n === "number" && Number.isFinite(n));
}

/** Whether an end (of an arrow, a path) is a box rather than a bare point. */
export function isBoxEnd(end: Box | Point): end is Box {
  return typeof (end as Partial<Box>).w === "number" && typeof (end as Partial<Box>).h === "number";
}

export function isPoint(value: unknown): value is Point {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return typeof p.x === "number" && Number.isFinite(p.x) && typeof p.y === "number" && Number.isFinite(p.y);
}

/** Whether two boxes overlap (touching edges don't), each grown by `margin` on every side first. */
export function rectsIntersect(a: Box, b: Box, margin = 0): boolean {
  return (
    a.x - margin < b.x + b.w + margin &&
    b.x - margin < a.x + a.w + margin &&
    a.y - margin < b.y + b.h + margin &&
    b.y - margin < a.y + a.h + margin
  );
}

/** The smallest box around all of them, or null for none. */
export function union(boxes: readonly Box[]): Box | null {
  let x1 = Number.POSITIVE_INFINITY;
  let y1 = Number.POSITIVE_INFINITY;
  let x2 = Number.NEGATIVE_INFINITY;
  let y2 = Number.NEGATIVE_INFINITY;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x, b.x + b.w);
    y1 = Math.min(y1, b.y, b.y + b.h);
    x2 = Math.max(x2, b.x, b.x + b.w);
    y2 = Math.max(y2, b.y, b.y + b.h);
  }
  return Number.isFinite(x1) ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
}

export function center(box: Box): Point {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/** Whether the point is inside the box (edges included), turned by `rot` degrees around its center. */
export function containsPoint(box: Box, point: Point, rot = 0): boolean {
  let { x, y } = point;
  if (rot) {
    const c = center(box);
    const a = (-rot * Math.PI) / 180;
    const dx = x - c.x;
    const dy = y - c.y;
    x = c.x + dx * Math.cos(a) - dy * Math.sin(a);
    y = c.y + dx * Math.sin(a) + dy * Math.cos(a);
  }
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

/** The axis-aligned box around a box turned by `rot` degrees around its center. */
export function rotatedBounds(box: Box, rot = 0): Box {
  if (!rot) return { x: box.x, y: box.y, w: box.w, h: box.h };
  const a = (rot * Math.PI) / 180;
  const cos = Math.abs(Math.cos(a));
  const sin = Math.abs(Math.sin(a));
  const w = box.w * cos + box.h * sin;
  const h = box.w * sin + box.h * cos;
  const c = center(box);
  return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

/** The id of the topmost shape at the point (the last one in drawing order that holds it), or null. */
export function hitTest(shapes: readonly (Box & { id: string; rot?: number })[], x: number, y: number): string | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const shape = shapes[i];
    if (shape && containsPoint(shape, { x, y }, shape.rot ?? 0)) return shape.id;
  }
  return null;
}

/**
 * How far to nudge a box being moved so one of its edges or its center lines up with another box's (within
 * `tolerance`), and the guides to draw for what lined up.
 */
export function snapLines(
  moving: Box,
  others: readonly Box[],
  tolerance: number,
): { dx: number; dy: number; guides: Guide[] } {
  const xsOf = (b: Box) => [b.x, b.x + b.w / 2, b.x + b.w];
  const ysOf = (b: Box) => [b.y, b.y + b.h / 2, b.y + b.h];
  const best = (mine: number[], pick: (b: Box) => number[]): number | null => {
    let found: number | null = null;
    for (const other of others) {
      for (const theirs of pick(other)) {
        for (const at of mine) {
          const delta = theirs - at;
          if (Math.abs(delta) <= tolerance && (found === null || Math.abs(delta) < Math.abs(found))) found = delta;
        }
      }
    }
    return found;
  };
  const dx = best(xsOf(moving), xsOf) ?? 0;
  const dy = best(ysOf(moving), ysOf) ?? 0;
  const moved: Box = { x: moving.x + dx, y: moving.y + dy, w: moving.w, h: moving.h };
  const guides: Guide[] = [];
  const seen = new Set<string>();
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  for (const other of others) {
    for (const at of xsOf(moved)) {
      if (!xsOf(other).some((v) => near(v, at))) continue;
      const key = `x:${Math.round(at * 2)}`;
      const from = Math.min(moved.y, other.y);
      const to = Math.max(moved.y + moved.h, other.y + other.h);
      if (!seen.has(key)) {
        seen.add(key);
        guides.push({ axis: "x", at, from, to });
      } else {
        const g = guides.find((guide) => guide.axis === "x" && near(guide.at, at));
        if (g) {
          g.from = Math.min(g.from, from);
          g.to = Math.max(g.to, to);
        }
      }
    }
    for (const at of ysOf(moved)) {
      if (!ysOf(other).some((v) => near(v, at))) continue;
      const key = `y:${Math.round(at * 2)}`;
      const from = Math.min(moved.x, other.x);
      const to = Math.max(moved.x + moved.w, other.x + other.w);
      if (!seen.has(key)) {
        seen.add(key);
        guides.push({ axis: "y", at, from, to });
      } else {
        const g = guides.find((guide) => guide.axis === "y" && near(guide.at, at));
        if (g) {
          g.from = Math.min(g.from, from);
          g.to = Math.max(g.to, to);
        }
      }
    }
  }
  return { dx, dy, guides };
}

/** Where the line from a box's center towards `toward` leaves the box (the point itself for a point). */
function anchor(end: Box | Point, toward: Point): Point {
  if (!isBoxEnd(end)) return { x: end.x, y: end.y };
  const c = center(end);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const tx = dx === 0 ? Number.POSITIVE_INFINITY : Math.abs(end.w / 2 / dx);
  const ty = dy === 0 ? Number.POSITIVE_INFINITY : Math.abs(end.h / 2 / dy);
  const t = Math.min(tx, ty, 1);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** An arrow between two boxes (or points): from border to border along the line between their centers. */
export function arrowPath(from: Box | Point, to: Box | Point): { x1: number; y1: number; x2: number; y2: number } {
  const a = isBoxEnd(from) ? center(from) : from;
  const b = isBoxEnd(to) ? center(to) : to;
  const start = anchor(from, b);
  const end = anchor(to, a);
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

/** A line from one end to the other. */
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** How an arrow runs (`ArrowRoute` in types.ts, repeated here so geometry imports nothing). */
type Route = "straight" | "curve" | "elbow";

/** An arrow's path between its ends, as every app draws it (ADR 0196 §2). */
export interface RoutedArrow {
  /** SVG path data, in the same units as the line. */
  d: string;
  /** Where its label sits: the middle of the path. */
  mid: Point;
  /** Unit vectors: the way it leaves its start, and the way it arrives at its end (for the heads). */
  startDir: Point;
  endDir: Point;
  /** Its ends before trimming (where the heads' tips go). */
  start: Point;
  end: Point;
}

/** How far a curved arrow bows out from the straight line between its ends, as a share of that line's length. */
const CURVE_BOW = 0.25;

const round2 = (v: number) => Math.round(v * 100) / 100;
const pt = (p: Point) => `${round2(p.x)} ${round2(p.y)}`;

function unit(dx: number, dy: number): Point {
  const len = Math.hypot(dx, dy);
  return len > 1e-9 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
}

/**
 * The path of an arrow along `line`: straight; a curve bowing to the left of its way (a quadratic through a point a
 * quarter of its length off the middle); or an elbow of right angles (across, then along, then across, on its longer
 * axis). `trim` pulls each end in along the path (by a head's length, so a thick stroke never shows past its tip).
 */
export function routeArrow(
  line: Segment,
  route: Route = "straight",
  trim: { start?: number; end?: number } = {},
): RoutedArrow {
  const s = { x: line.x1, y: line.y1 };
  const e = { x: line.x2, y: line.y2 };
  const dx = e.x - s.x;
  const dy = e.y - s.y;
  const len = Math.hypot(dx, dy);
  const ts = trim.start ?? 0;
  const te = trim.end ?? 0;
  const along = (p: Point, dir: Point, by: number): Point => ({ x: p.x + dir.x * by, y: p.y + dir.y * by });
  if (route === "curve" && len > 1e-9) {
    const c = { x: (s.x + e.x) / 2 + dy * CURVE_BOW, y: (s.y + e.y) / 2 - dx * CURVE_BOW };
    const startDir = unit(c.x - s.x, c.y - s.y);
    const endDir = unit(e.x - c.x, e.y - c.y);
    const a = along(s, startDir, ts);
    const b = along(e, endDir, -te);
    return {
      d: `M${pt(a)} Q${pt(c)} ${pt(b)}`,
      mid: { x: 0.25 * s.x + 0.5 * c.x + 0.25 * e.x, y: 0.25 * s.y + 0.5 * c.y + 0.25 * e.y },
      startDir,
      endDir,
      start: s,
      end: e,
    };
  }
  // An elbow between ends on one line is that line.
  if (route === "elbow" && Math.abs(dx) > 1e-9 && Math.abs(dy) > 1e-9) {
    const across = Math.abs(dx) >= Math.abs(dy);
    const p1 = across ? { x: s.x + dx / 2, y: s.y } : { x: s.x, y: s.y + dy / 2 };
    const p2 = across ? { x: s.x + dx / 2, y: e.y } : { x: e.x, y: s.y + dy / 2 };
    const dir = across ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) };
    const a = along(s, dir, Math.min(ts, Math.abs(across ? dx : dy) / 2));
    const b = along(e, dir, -Math.min(te, Math.abs(across ? dx : dy) / 2));
    return {
      d: `M${pt(a)} L${pt(p1)} L${pt(p2)} L${pt(b)}`,
      mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
      startDir: dir,
      endDir: dir,
      start: s,
      end: e,
    };
  }
  const dir = unit(dx, dy);
  const room = Math.max(0, len - 1);
  const a = along(s, dir, Math.min(ts, room / 2));
  const b = along(e, dir, -Math.min(te, room / 2));
  return {
    d: `M${pt(a)} L${pt(b)}`,
    mid: { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 },
    startDir: dir,
    endDir: dir,
    start: s,
    end: e,
  };
}

/** An arrow head's three corners: its tip, pointing along `dir` (a unit vector), `size` long. */
export function arrowHeadPoints(tip: Point, dir: Point, size: number): [Point, Point, Point] {
  const base = { x: tip.x - dir.x * size, y: tip.y - dir.y * size };
  const half = size * 0.45;
  return [
    tip,
    { x: base.x - dir.y * half, y: base.y + dir.x * half },
    { x: base.x + dir.y * half, y: base.y - dir.x * half },
  ];
}

/** The box around a pen stroke's points (x, y pairs), or null for none. */
export function pointsBounds(points: readonly number[]): Box | null {
  let x1 = Number.POSITIVE_INFINITY;
  let y1 = Number.POSITIVE_INFINITY;
  let x2 = Number.NEGATIVE_INFINITY;
  let y2 = Number.NEGATIVE_INFINITY;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i] as number;
    const y = points[i + 1] as number;
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x);
    y2 = Math.max(y2, y);
  }
  return Number.isFinite(x1) ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
}

/**
 * A pen stroke as SVG path data (its points as they are, in its box's units): smoothed through the middles of its
 * segments, so a hand-drawn line has no corners; one point is a dot (drawn by the round cap).
 */
export function strokePath(points: readonly number[]): string {
  const n = Math.floor(points.length / 2);
  const at = (i: number): Point => ({ x: points[2 * i] as number, y: points[2 * i + 1] as number });
  if (n === 0) return "";
  const first = at(0);
  if (n === 1) return `M${pt(first)} L${pt({ x: first.x + 0.01, y: first.y })}`;
  if (n === 2) return `M${pt(first)} L${pt(at(1))}`;
  const parts = [`M${pt(first)}`];
  for (let i = 1; i < n - 1; i++) {
    const p = at(i);
    const q = at(i + 1);
    parts.push(`Q${pt(p)} ${pt({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 })}`);
  }
  parts.push(`L${pt(at(n - 1))}`);
  return parts.join(" ");
}
