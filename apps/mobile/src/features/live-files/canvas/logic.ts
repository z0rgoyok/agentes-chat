import type { Peer } from "@agenteschat/live/awareness";
import {
  type ArrowRoute,
  arrowPath,
  type Box,
  containsPoint,
  descendantsOf,
  type NoteColor,
  placeBoxes,
  pointsBounds,
  resolveEnd,
  type ShapeType,
  type ShapeView,
  shapeBounds,
  union,
} from "@agenteschat/live/canvas";
import type * as Y from "yjs";
import type { ArrowEndW, WBox } from "./camera";

/**
 * A canvas on the phone (ADR 0196 §2, 0197): which shapes are laid out, what a finger lands on, what moves with what,
 * where something new goes, how arrows are drawn and what a picture being made says. Pure: the screen draws it and
 * the tests read it.
 */

/** The shapes laid out for a world box: those that reach into it, and those that must stay (selected, being moved). */
export function shapesIn(
  shapes: readonly ShapeView[],
  byId: ReadonlyMap<string, ShapeView>,
  box: WBox,
  keep: ReadonlySet<string> = new Set(),
): ShapeView[] {
  return shapes.filter((s) => {
    // Hidden from view (the layers' eye, ADR 0196 §2): never drawn here.
    if (s.hidden) return false;
    if (keep.has(s.id)) return true;
    const b = shapeBounds(s, byId);
    return b.x <= box.x + box.w && box.x <= b.x + b.w && b.y <= box.y + box.h && box.y <= b.y + b.h;
  });
}

/** How tall a frame's name is over its top edge, in points on screen (tapping it picks the frame). */
export const FRAME_NAME_H = 24;
/** The least a finger needs: a shape smaller than this on screen answers to a box this big around its middle. */
export const MIN_TARGET = 32;

/** Distance from a point to a segment. */
export function segmentDistance(p: { x: number; y: number }, l: { x1: number; y1: number; x2: number; y2: number }) {
  const dx = l.x2 - l.x1;
  const dy = l.y2 - l.y1;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((p.x - l.x1) * dx + (p.y - l.y1) * dy) / len)) : 0;
  return Math.hypot(p.x - (l.x1 + t * dx), p.y - (l.y1 + t * dy));
}

/** A shape's box grown around its middle to at least `MIN_TARGET` points on screen at zoom `s`. */
function targetBox(box: Box, s: number): Box {
  const min = MIN_TARGET / Math.max(s, 1e-6);
  const w = Math.max(box.w, min);
  const h = Math.max(box.h, min);
  return { x: box.x - (w - box.w) / 2, y: box.y - (h - box.h) / 2, w, h };
}

/**
 * What a finger at world point `p` lands on at zoom `s`: the topmost shape there (a line within a finger's reach of an
 * arrow, a small shape by a finger-sized box around it), else a frame by its name over its top edge or its inside; null
 * on the bare plane. `shapes` in drawing order (frames first).
 */
export function shapeAt(
  shapes: readonly ShapeView[],
  byId: ReadonlyMap<string, ShapeView>,
  p: { x: number; y: number },
  s: number,
  reach = 12,
): string | null {
  const r = reach / Math.max(s, 1e-6);
  for (let i = shapes.length - 1; i >= 0; i--) {
    const shape = shapes[i];
    if (!shape || shape.type === "frame") continue;
    if (shape.type === "arrow") {
      const line = arrowLine(shape, byId);
      if (line && segmentDistance(p, line) <= r) return shape.id;
      continue;
    }
    if (containsPoint(targetBox(shape, s), p, shape.rot ?? 0)) return shape.id;
  }
  const label = FRAME_NAME_H / Math.max(s, 1e-6);
  for (let i = shapes.length - 1; i >= 0; i--) {
    const frame = shapes[i];
    if (frame?.type !== "frame") continue;
    const onName = p.x >= frame.x && p.x <= frame.x + frame.w && p.y >= frame.y - label && p.y < frame.y;
    if (onName || containsPoint(frame, p)) return frame.id;
  }
  return null;
}

/** The box around the chosen shapes (world), or null. */
export function selectionBox(ids: readonly string[], byId: ReadonlyMap<string, ShapeView>): WBox | null {
  const boxes = ids.flatMap((id) => {
    const s = byId.get(id);
    return s ? [shapeBounds(s, byId)] : [];
  });
  return union(boxes);
}

/** What moves when the chosen shapes move: them, and everything in a chosen frame. */
export function movingIds(ids: readonly string[], shapes: readonly ShapeView[]): Set<string> {
  const set = new Set(ids);
  for (const id of descendantsOf(ids, shapes)) set.add(id);
  return set;
}

/** Whether the corner handle can stretch a shape: one at a time, not an arrow (its ends move it), not locked. */
export const stretchable = (s: Pick<ShapeView, "type" | "locked"> | undefined) =>
  !!s && !s.locked && s.type !== "arrow";

/** Pictures (and pictures being made) keep their proportions when stretched. */
export const keepsRatio = (s: Pick<ShapeView, "type">) => s.type === "image" || s.type === "pending";

/** Shapes whose words the phone edits. */
export const holdsWords = (s: Pick<ShapeView, "type">) => s.type === "note" || s.type === "text" || s.type === "shape";

// ── Arrows ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** An arrow's line now (bound ends follow their shapes), or null when an end's shape is gone. */
export function arrowLine(
  arrow: ShapeView,
  byId: ReadonlyMap<string, ShapeView>,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const from = resolveEnd(arrow.from, byId);
  const to = resolveEnd(arrow.to, byId);
  return from && to ? arrowPath(from, to) : null;
}

/** An arrow as the UI thread draws it: its ends (each a shape's box, by id, or a free point), dashes and heads. */
export interface ArrowDraw {
  id: string;
  from: ArrowEndW & { shape: string | null };
  to: ArrowEndW & { shape: string | null };
  dashed: boolean;
  /** Heads at its start and end (a line has none). */
  startHead: boolean;
  endHead: boolean;
  /** How it runs: straight, curved or with right angles (a moving one is drawn straight until it lands). */
  route: ArrowRoute;
}

/** The arrows to draw, their ends where their shapes are now; an arrow whose shape is gone isn't drawn. */
export function arrowDraws(shapes: readonly ShapeView[], byId: ReadonlyMap<string, ShapeView>): ArrowDraw[] {
  const out: ArrowDraw[] = [];
  for (const arrow of shapes) {
    if (arrow.type !== "arrow") continue;
    const ends = [arrow.from, arrow.to].map((end) => {
      const at = resolveEnd(end, byId);
      if (!at) return null;
      const shape = end && "shape" in end ? end.shape : null;
      return "w" in at
        ? { x: at.x, y: at.y, w: at.w, h: at.h, box: true, shape }
        : { x: at.x, y: at.y, w: 0, h: 0, box: false, shape };
    });
    const [from, to] = ends;
    if (from && to) {
      out.push({
        id: arrow.id,
        from,
        to,
        dashed: arrow.dashed === true,
        startHead: arrow.heads?.start === "arrow",
        endHead: (arrow.heads?.end ?? "arrow") === "arrow",
        route: arrow.route ?? "straight",
      });
    }
  }
  return out;
}

/** The filled head at an arrow's end: its three corners, `size` long along the line. */
export function arrowHead(
  line: { x1: number; y1: number; x2: number; y2: number },
  size: number,
): [number, number, number, number, number, number] {
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const bx = line.x2 - ux * size;
  const by = line.y2 - uy * size;
  const half = size * 0.55;
  return [line.x2, line.y2, bx - uy * half, by + ux * half, bx + uy * half, by - ux * half];
}

// ── New things ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The size a new thing starts at (the web's: a note 200 square, a text line 320 by 60). */
export function newSize(type: "note" | "text"): { w: number; h: number } {
  return type === "note" ? { w: 200, h: 200 } : { w: 320, h: 60 };
}

/** The longest side a picture takes when it lands (as `addShape` does with a natural size). */
export const PICTURE_SIDE = 640;

/** A picture's size on the canvas from its pixels: as it is, its longest side at most `PICTURE_SIDE`. */
export function pictureSize(width: number | null, height: number | null): { w: number; h: number } {
  const w = width && width > 0 ? width : PICTURE_SIDE;
  const h = height && height > 0 ? height : PICTURE_SIDE;
  const k = Math.min(1, PICTURE_SIDE / Math.max(w, h));
  return { w: w * k, h: h * k };
}

/** Where new things go: free room nearest the middle of what the person looks at, one box each, never overlapping. */
export function placeNear(
  doc: Y.Doc,
  near: { x: number; y: number },
  sizes: readonly { w: number; h: number }[],
): Box[] {
  if (sizes.length === 0) return [];
  // Each one placed before the next looks for room, so several land side by side.
  const w = Math.max(...sizes.map((b) => b.w));
  const h = Math.max(...sizes.map((b) => b.h));
  const placed = placeBoxes(doc, { count: sizes.length, w, h, near, gap: 32 });
  return sizes.map((size, i) => {
    const slot = placed.boxes[i] ?? { x: near.x - size.w / 2, y: near.y - size.h / 2, w, h };
    return { x: slot.x + (w - size.w) / 2, y: slot.y + (h - size.h) / 2, w: size.w, h: size.h };
  });
}

// ── Pictures being made (ADR 0197) ───────────────────────────────────────────────────────────────────────────────

/** What a placeholder says, as a key: waiting, being made, or why it failed (`live.images.*`). */
export function pendingWords(s: Pick<ShapeView, "status" | "error">): string {
  if (s.status === "queued") return "live.images.queued";
  if (s.status === "running") return "live.images.making";
  return `live.images.failed.${failureKey(s.error)}`;
}

/** A failure's code ("no_key") as its words' key ("noKey"); "other" for a code this build doesn't know. */
export function failureKey(code: string | undefined): string {
  switch (code) {
    case "no_key":
      return "noKey";
    case "too_many":
      return "tooMany";
    case "budget":
    case "limit":
    case "blocked":
    case "provider":
      return code;
    default:
      return "other";
  }
}

/** Whether "Tentar de novo" can bring a failed placeholder back (its request is known, and it is the person's turn). */
export const retryable = (s: Pick<ShapeView, "type" | "status" | "request">) =>
  s.type === "pending" && s.status === "failed" && !!s.request;

// ── Notes ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The note colors in the web's order. */
export const NOTE_ORDER: readonly NoteColor[] = ["yellow", "pink", "blue", "green", "purple", "gray"];

/** A note's words' size on the canvas (world units). */
export const NOTE_TEXT = 16;
/** A note's inner padding (world units). */
export const NOTE_PAD = 14;

// ── Presence ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Everyone else's chosen shapes (that still exist), with who: their outline on the plane. */
export function peerPicks<P extends Pick<Peer, "self" | "state" | "clientId">>(
  peers: readonly P[],
  byId: ReadonlyMap<string, ShapeView>,
): { peer: P; ids: string[] }[] {
  return peers.flatMap((p) => {
    if (p.self) return [];
    const ids = (p.state.sel?.canvas ?? []).filter((id) => byId.has(id));
    return ids.length ? [{ peer: p, ids }] : [];
  });
}

/** Everyone else's pointer on the plane (world units), with who. */
export function peerPointers<P extends Pick<Peer, "self" | "state" | "clientId">>(peers: readonly P[]) {
  return peers.flatMap((p) => {
    const c = p.state.cursor;
    return !p.self && c && c.space === "canvas" ? [{ peer: p, at: { x: c.x, y: c.y } }] : [];
  });
}

/** Image shapes among the chosen ones (the pictures "Gerar" starts from). */
export function chosenPictures(ids: readonly string[], byId: ReadonlyMap<string, ShapeView>): string[] {
  return ids.filter((id) => {
    const s = byId.get(id);
    return s?.type === "image" && !!s.asset;
  });
}

/** The types the bottom bar adds. */
export type AddKind = Extract<ShapeType, "note" | "text">;

// ── Drawing with a finger (ADR 0196 §2) ──────────────────────────────────────────────────────────────────────────

/** The most numbers (x, y, x, y…) one pen stroke keeps: the canvas's limit. */
export const STROKE_MAX = 4000;

/**
 * A finger's stroke (world x, y pairs, as the screen heard it) as few points as draw it: a point closer than `min` to
 * the last one kept goes (the last always stays, so the line ends where the finger lifted); while it is still over
 * `max` numbers, the spacing doubles.
 */
export function thinPoints(points: readonly number[], min: number, max = STROKE_MAX): number[] {
  const n = Math.floor(points.length / 2) * 2;
  if (n === 0) return [];
  let step = Math.max(0, min);
  for (let round = 0; round < 24; round++) {
    const kept: number[] = [points[0] as number, points[1] as number];
    for (let i = 2; i < n; i += 2) {
      const x = points[i] as number;
      const y = points[i + 1] as number;
      const lx = kept[kept.length - 2] as number;
      const ly = kept[kept.length - 1] as number;
      const last = i === n - 2;
      if (Math.hypot(x - lx, y - ly) >= step) kept.push(x, y);
      else if (last && (x !== lx || y !== ly)) {
        // The finger's last place replaces the last one kept (too close to keep both).
        if (kept.length > 2) kept.splice(kept.length - 2, 2, x, y);
        else kept.push(x, y);
      }
    }
    if (kept.length <= max) return kept;
    step = Math.max(step * 2, 1);
  }
  return points.slice(0, Math.min(max, n));
}

/** A stroke as a pen shape: its box (world units) and its points from the box's top-left corner; null for none. */
export function strokeShape(
  points: readonly number[],
): { x: number; y: number; w: number; h: number; points: number[] } | null {
  const box = pointsBounds(points);
  if (!box) return null;
  const rel: number[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    rel.push(round2((points[i] as number) - box.x), round2((points[i + 1] as number) - box.y));
  }
  return { x: box.x, y: box.y, w: Math.max(1, box.w), h: Math.max(1, box.h), points: rel };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Kinds as a selection's words count them (`live.canvas.count.*`): a picture on its way counts as a picture. */
const COUNTED: Record<ShapeType, string> = {
  image: "image",
  pending: "image",
  note: "note",
  text: "text",
  frame: "frame",
  shape: "shape",
  arrow: "arrow",
  draw: "draw",
  html: "html",
  file: "file",
};

/**
 * What a person has chosen on a canvas, in words for the conversation's quote and the agent (ADR 0199): "1 imagem",
 * "2 notas", "3 elementos" for a mix, with the shapes' ids; null for nothing chosen.
 */
export function canvasSelection(
  t: (key: string, options?: Record<string, unknown>) => string,
  shapes: readonly Pick<ShapeView, "id" | "type">[],
): { label: string; shapes: string[] } | null {
  if (shapes.length === 0) return null;
  const kinds = new Set(shapes.map((s) => COUNTED[s.type]));
  const count = shapes.length;
  const [only] = kinds;
  const label =
    kinds.size === 1 && only ? t(`live.canvas.count.${only}`, { count }) : t("live.canvas.count.items", { count });
  return { label, shapes: shapes.map((s) => s.id) };
}

// ── The pen's bar (ADR 0196 §2, the web's own choices) ───────────────────────────────────────────────────────────

/** The colors people draw with, in the pen bar's order. */
export const PEN_INKS = [
  { key: "red", color: "#e5484d" },
  { key: "ink", color: "#151514" },
  { key: "blue", color: "#0063d1" },
  { key: "green", color: "#2f9e44" },
  { key: "orange", color: "#f2a33a" },
] as const;

export type PenSize = "s" | "m" | "l";
export const PEN_SIZES: readonly PenSize[] = ["s", "m", "l"];

/** Each size's width in world units: the pen's lines, the highlighter's wide bands. */
export const PEN_WIDTHS: Record<"pen" | "marker", Record<PenSize, number>> = {
  pen: { s: 2, m: 4, l: 8 },
  marker: { s: 8, m: 16, l: 24 },
};

/** The pen as the person set it: pen or highlighter, a color, a size. */
export interface PenStyle {
  tool: "pen" | "marker";
  color: string;
  size: PenSize;
}

export const DEFAULT_PEN: PenStyle = { tool: "pen", color: "#151514", size: "m" };

/** What a stroke stores for a pen: its color, its width, and the highlighter (the pen is the default tool). */
export const strokeOf = (pen: PenStyle) => ({
  stroke: pen.color,
  strokeWidth: PEN_WIDTHS[pen.tool][pen.size],
  ...(pen.tool === "marker" ? { tool: "marker" as const } : {}),
});

/** Whether a color is near black (the ink people draw with), which the dark theme draws light. */
export function isInk(color: string): boolean {
  const hex = color.replace("#", "");
  const full = hex.length === 3 ? [...hex].map((ch) => ch + ch).join("") : hex.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(full)) return false;
  const n = Number.parseInt(full, 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) < 48;
}

// ── Cropping a picture ──────────────────────────────────────────────────────────────────────────────────────────

/** A part of a picture, as fractions (0 to 1) of what it shows. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The least a crop's frame keeps on screen, in points (a finger's mark). */
export const MIN_CROP = 32;

const unit = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

/** A part kept inside the picture, never empty. */
export function clampCrop(part: CropRect): CropRect {
  const x = unit(part.x);
  const y = unit(part.y);
  return { x, y, w: Math.max(0.01, Math.min(1 - x, unit(part.w))), h: Math.max(0.01, Math.min(1 - y, unit(part.h))) };
}

/**
 * A picture cropped to `part` of what it shows: its crop (fractions of the whole picture, inside the crop it had) and
 * its box (the part kept stays where it was on the canvas, at the same size).
 */
export function croppedPicture(
  shape: Pick<ShapeView, "x" | "y" | "w" | "h" | "crop">,
  part: CropRect,
): { crop: CropRect; x: number; y: number; w: number; h: number } {
  const p = clampCrop(part);
  const c = shape.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  return {
    crop: { x: round4(c.x + p.x * c.w), y: round4(c.y + p.y * c.h), w: round4(p.w * c.w), h: round4(p.h * c.h) },
    x: shape.x + p.x * shape.w,
    y: shape.y + p.y * shape.h,
    w: p.w * shape.w,
    h: p.h * shape.h,
  };
}
