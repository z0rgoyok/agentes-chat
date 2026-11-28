import * as Y from "yjs";
import type { PeerUser } from "../awareness";
import { cleanGradient, cleanLineHeight, cleanPadding, cleanShadow, cleanTracking, isDash } from "../effects";
import { isFontRef, isFontWeight } from "../fonts";
import { compareStack } from "../fractional";
import { type LiveGroup, readGroupMap } from "../groups";
import { LIVE_LIMITS } from "../limits";
import { readRich } from "../rich/yjs";
import { type Box, center, isBoxEnd, isPoint, type Point, rotatedBounds, union } from "./geometry";
import {
  ARROW_ROUTES,
  type ArrowEnd,
  type ArrowHeads,
  CANVAS_BACKGROUNDS,
  CANVAS_SHAPE_KINDS,
  type CanvasBackground,
  type CanvasShapeKind,
  type CanvasTextStyle,
  CORNER_RADIUS,
  DRAW_TOOLS,
  type ImageCrop,
  type ImageGen,
  isShapeType,
  NOTE_COLORS,
  type NoteColor,
  type PendingStatus,
  type ShapeType,
  type ShapeView,
  STROKE_WIDTH,
} from "./types";

/**
 * Where a canvas lives in its document and how its values are read and checked (ADR 0196 §2):
 * `canvas` (a map: `bg`) and `shapes` (a map of shape id to a `Y.Map` per shape). Reading is lenient (a value an app
 * doesn't know is left out, never a crash); writing goes through `cleanProp`, so nothing off-shape gets in.
 */

export function canvasMapOf(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>("canvas");
}

export function shapesMapOf(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>("shapes");
}

export function shapeMapOf(doc: Y.Doc, id: string): Y.Map<unknown> | null {
  const value: unknown = shapesMapOf(doc).get(id);
  return value instanceof Y.Map ? (value as Y.Map<unknown>) : null;
}

export function canvasBackground(doc: Y.Doc): CanvasBackground {
  const bg = canvasMapOf(doc).get("bg");
  return typeof bg === "string" && (CANVAS_BACKGROUNDS as readonly string[]).includes(bg)
    ? (bg as CanvasBackground)
    : "dots";
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const SHAPE_KINDS: readonly string[] = CANVAS_SHAPE_KINDS;
const STATUSES: readonly string[] = ["queued", "running", "failed"];
/** Coordinates past this are a broken shape, not a big canvas. */
export const CANVAS_COORD_MAX = 1e7;

export function isShapeId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

export function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= CANVAS_COORD_MAX ? value : undefined;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function colorOf(value: unknown, allowNone = false): string | undefined {
  if (typeof value !== "string") return undefined;
  if (allowNone && (value === "none" || value === "transparent")) return "none";
  return COLOR.test(value) ? value : undefined;
}

/** A number within [min, max], or undefined. */
function within(value: unknown, min: number, max: number): number | undefined {
  const n = finite(value);
  return n !== undefined && n >= min && n <= max ? n : undefined;
}

function headsOf(value: unknown): ArrowHeads | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  const heads: ArrowHeads = {};
  for (const key of ["start", "end"] as const) {
    const head = o[key];
    if (head === undefined) continue;
    if (head !== "none" && head !== "arrow") return undefined;
    heads[key] = head;
  }
  return heads;
}

/** A pen stroke's points: an even count of finite numbers, at least one point, at most `drawPoints` numbers. */
function pointsOf(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length % 2 !== 0) return undefined;
  if (value.length > LIVE_LIMITS.canvas.drawPoints) return undefined;
  const out: number[] = [];
  for (const v of value) {
    const n = finite(v);
    if (n === undefined) return undefined;
    out.push(n);
  }
  return out;
}

/** Fractions of the natural image, inside it, never empty. */
function cropOf(value: unknown): ImageCrop | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const x = within(o.x, 0, 1);
  const y = within(o.y, 0, 1);
  const w = within(o.w, 0, 1);
  const h = within(o.h, 0, 1);
  if (x === undefined || y === undefined || w === undefined || h === undefined || w <= 0 || h <= 0) return undefined;
  // A hair past the edge is rounding, not a crop outside the picture.
  if (x + w > 1 + 1e-6 || y + h > 1 + 1e-6) return undefined;
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
}

function userOf(value: unknown): PeerUser | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  if ((o.kind !== "person" && o.kind !== "agent") || typeof o.id !== "string" || !o.id || o.id.length > 64) {
    return undefined;
  }
  return { kind: o.kind, id: o.id };
}

function endOf(value: unknown): ArrowEnd | undefined {
  if (!value || typeof value !== "object") return undefined;
  const shape = (value as { shape?: unknown }).shape;
  if (isShapeId(shape)) return { shape };
  if (isPoint(value)) {
    const x = finite(value.x);
    const y = finite(value.y);
    return x !== undefined && y !== undefined ? { x, y } : undefined;
  }
  return undefined;
}

function genOf(value: unknown): ImageGen | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const by = userOf(o.by);
  if (typeof o.prompt !== "string" || typeof o.model !== "string" || !by || typeof o.at !== "string") return undefined;
  const gen: ImageGen = { prompt: o.prompt.slice(0, 4000), model: o.model.slice(0, 200), by, at: o.at.slice(0, 64) };
  if (Array.isArray(o.from)) {
    const from = o.from.filter(isShapeOrAssetId).slice(0, 16);
    if (from.length) gen.from = from;
  }
  if (typeof o.request === "string" && o.request.length <= 64) gen.request = o.request;
  return gen;
}

/** Asset and file ids are uuids; shape ids are ours. */
function isShapeOrAssetId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function styleOf(value: unknown): CanvasTextStyle | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const style: CanvasTextStyle = {};
  const size = finite(o.size);
  if (size !== undefined && size >= 4 && size <= 1000) style.size = size;
  const color = colorOf(o.color);
  if (color) style.color = color;
  if (o.align === "left" || o.align === "center" || o.align === "right") style.align = o.align;
  if (o.valign === "top" || o.valign === "middle" || o.valign === "bottom") style.valign = o.valign;
  if (isFontWeight(o.weight)) style.weight = o.weight;
  if (isFontRef(o.font) && o.font !== "heading" && o.font !== "body") style.font = o.font;
  const lineHeight = cleanLineHeight(o.lineHeight);
  if (lineHeight !== undefined) style.lineHeight = lineHeight;
  const tracking = cleanTracking(o.tracking);
  if (tracking !== undefined) style.tracking = tracking;
  if (o.caps === true) style.caps = true;
  const padding = cleanPadding(o.padding);
  if (padding !== undefined) style.padding = padding;
  return Object.keys(style).length ? style : undefined;
}

/** Keys every shape may hold besides its box and stacking key: turn, frame, lock, who made it, hidden, group. */
export const COMMON_PROPS: readonly string[] = ["rot", "parent", "locked", "by", "hidden", "group"];

/** Keys each type holds besides the common ones. */
export const TYPE_PROPS: Record<ShapeType, readonly string[]> = {
  image: ["asset", "nw", "nh", "alt", "gen", "crop", "radius", "shadow"],
  note: ["color", "style"],
  text: ["style"],
  frame: ["name", "fill"],
  shape: ["kind", "fill", "gradient", "stroke", "strokeWidth", "dash", "radius", "shadow", "style"],
  arrow: ["from", "to", "label", "dashed", "route", "heads", "stroke", "strokeWidth"],
  draw: ["points", "stroke", "strokeWidth", "tool"],
  html: ["artifact"],
  file: ["artifact"],
  pending: ["request", "index", "status", "error", "prompt"],
};

/** Types whose shape carries rich text (`text`). */
export const TEXT_TYPES: readonly ShapeType[] = ["note", "text", "shape"];

/** A prop's value as stored, or undefined when it isn't one this key may hold. */
export function cleanProp(key: string, value: unknown): unknown {
  switch (key) {
    case "x":
    case "y":
      return finite(value);
    case "w":
    case "h": {
      const n = finite(value);
      return n !== undefined && n >= 0 ? n : undefined;
    }
    case "rot": {
      const n = finite(value);
      return n === undefined ? undefined : ((n % 360) + 360) % 360;
    }
    case "parent":
    case "asset":
    case "artifact":
    case "request":
    case "group":
      return isShapeOrAssetId(value) ? value : undefined;
    case "gradient":
      return cleanGradient(value);
    case "dash":
      return isDash(value) ? value : undefined;
    case "shadow":
      return cleanShadow(value);
    case "locked":
    case "dashed":
    case "hidden":
      return value === true ? true : undefined;
    case "nw":
    case "nh": {
      const n = finite(value);
      return n !== undefined && n > 0 ? n : undefined;
    }
    case "alt":
      return text(value, 1000);
    case "gen":
      return genOf(value);
    case "color":
      return typeof value === "string" && (NOTE_COLORS as readonly string[]).includes(value) ? value : undefined;
    case "style":
      return styleOf(value);
    case "name":
      return text(value, 200);
    case "fill":
      return colorOf(value, true);
    case "stroke":
      return colorOf(value, true);
    case "strokeWidth":
      return within(value, STROKE_WIDTH.min, STROKE_WIDTH.max);
    case "radius":
      return within(value, CORNER_RADIUS.min, CORNER_RADIUS.max);
    case "kind":
      return typeof value === "string" && SHAPE_KINDS.includes(value) ? value : undefined;
    case "route":
      return typeof value === "string" && (ARROW_ROUTES as readonly string[]).includes(value) ? value : undefined;
    case "heads":
      return headsOf(value);
    case "points":
      return pointsOf(value);
    case "tool":
      return typeof value === "string" && (DRAW_TOOLS as readonly string[]).includes(value) ? value : undefined;
    case "crop":
      return cropOf(value);
    case "from":
    case "to":
      return endOf(value);
    case "label":
      return text(value, 500);
    case "index": {
      const n = finite(value);
      return n !== undefined && Number.isInteger(n) && n >= 0 && n < 100 ? n : undefined;
    }
    case "status":
      return typeof value === "string" && STATUSES.includes(value) ? value : undefined;
    case "error":
      return text(value, 64);
    case "prompt":
      return text(value, 4000);
    case "by":
      return userOf(value);
    default:
      return undefined;
  }
}

/** What a read takes: `text: false` leaves the rich text out (placement and geometry never need it, and it costs). */
export interface ReadShapesOptions {
  text?: boolean;
}

/** A shape's map as plain data, or null when it isn't a shape any app can draw. */
export function readShape(id: string, map: Y.Map<unknown>, opts: ReadShapesOptions = {}): ShapeView | null {
  const type = map.get("type");
  if (!isShapeType(type)) return null;
  const z = map.get("z");
  const view: ShapeView = {
    id,
    type,
    x: finite(map.get("x")) ?? 0,
    y: finite(map.get("y")) ?? 0,
    w: Math.max(0, finite(map.get("w")) ?? 0),
    h: Math.max(0, finite(map.get("h")) ?? 0),
    z: typeof z === "string" ? z : "",
  };
  const rot = cleanProp("rot", map.get("rot"));
  if (typeof rot === "number" && rot !== 0) view.rot = rot;
  const parent = cleanProp("parent", map.get("parent"));
  if (typeof parent === "string" && parent !== id) view.parent = parent;
  if (map.get("locked") === true) view.locked = true;
  const by = cleanProp("by", map.get("by"));
  if (by) view.by = by as PeerUser;
  if (map.get("hidden") === true) view.hidden = true;
  const group = cleanProp("group", map.get("group"));
  if (typeof group === "string") view.group = group;
  const fragment = opts.text === false ? undefined : map.get("text");
  if (fragment instanceof Y.XmlFragment) view.text = readRich(fragment);
  const props = view as unknown as Record<string, unknown>;
  for (const key of TYPE_PROPS[type]) {
    const value = cleanProp(key, map.get(key));
    if (value !== undefined) props[key] = value;
  }
  if (type === "note" && !view.color) view.color = "yellow" satisfies NoteColor;
  if (type === "shape" && !view.kind) view.kind = "rect" satisfies CanvasShapeKind;
  if (type === "pending" && !view.status) view.status = "queued" satisfies PendingStatus;
  return view;
}

/**
 * Every shape as plain data, in drawing order: frames first (they sit under what's in them), then everything else,
 * each group by stacking key, then id.
 */
export function readShapes(doc: Y.Doc, opts: ReadShapesOptions = {}): ShapeView[] {
  const shapes: ShapeView[] = [];
  shapesMapOf(doc).forEach((value, id) => {
    if (!(value instanceof Y.Map)) return;
    const view = readShape(id, value as Y.Map<unknown>, opts);
    if (view) shapes.push(view);
  });
  return shapes.sort((a, b) => Number(b.type === "frame") - Number(a.type === "frame") || compareStack(a, b));
}

export function readShapeById(doc: Y.Doc, id: string, opts: ReadShapesOptions = {}): ShapeView | null {
  const map = shapeMapOf(doc, id);
  return map ? readShape(id, map, opts) : null;
}

/** Where an arrow's end is: a bound shape's box (null when that shape is gone) or the free point. */
export function resolveEnd(end: ArrowEnd | undefined, byId: ReadonlyMap<string, ShapeView>): Box | Point | null {
  if (!end) return null;
  if ("shape" in end) {
    const shape = byId.get(end.shape);
    return shape && shape.type !== "arrow" ? { x: shape.x, y: shape.y, w: shape.w, h: shape.h } : null;
  }
  return end;
}

/** The axis-aligned box a shape covers (rotation included; an arrow's from its ends when they resolve). */
export function shapeBounds(shape: ShapeView, byId: ReadonlyMap<string, ShapeView>): Box {
  if (shape.type === "arrow") {
    const from = resolveEnd(shape.from, byId);
    const to = resolveEnd(shape.to, byId);
    if (from && to) {
      const points = [from, to].map((end) => (isBoxEnd(end) ? center(end) : end));
      return union(points.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 }))) ?? { x: shape.x, y: shape.y, w: 0, h: 0 };
    }
  }
  return rotatedBounds(shape, shape.rot ?? 0);
}

/** Shapes by id. */
export function shapeIndex(shapes: readonly ShapeView[]): Map<string, ShapeView> {
  return new Map(shapes.map((s) => [s.id, s]));
}

/** The frames a shape sits in, innermost first (stops at a loop people made by moving frames at once). */
export function ancestorsOf(id: string, byId: ReadonlyMap<string, ShapeView>): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let parent = byId.get(id)?.parent;
  while (parent && !seen.has(parent)) {
    const frame = byId.get(parent);
    if (frame?.type !== "frame") break;
    out.push(parent);
    seen.add(parent);
    parent = frame.parent;
  }
  return out;
}

/** A frame's whole contents: its children, theirs, and so on. */
export function descendantsOf(ids: Iterable<string>, shapes: readonly ShapeView[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const s of shapes) {
    if (!s.parent) continue;
    const list = children.get(s.parent) ?? [];
    list.push(s.id);
    children.set(s.parent, list);
  }
  const out = new Set<string>();
  const queue = [...ids];
  while (queue.length) {
    const id = queue.pop() as string;
    for (const child of children.get(id) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

/** The canvas's groups map (ADR 0220 §3): group id to `{ name?, parent? }`. */
export function canvasGroupsMapOf(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>("groups");
}

/** The canvas's groups, each once and loop-free. */
export function readCanvasGroups(doc: Y.Doc): LiveGroup[] {
  return readGroupMap(canvasGroupsMapOf(doc));
}
