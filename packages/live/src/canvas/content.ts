import * as Y from "yjs";
import { LIVE_LIMITS } from "../limits";
import { overwriteMap } from "../restore";
import { richLength, richText } from "../rich/text";
import { readRich } from "../rich/yjs";
import { arrowPath, union } from "./geometry";
import {
  canvasBackground,
  canvasMapOf,
  cleanProp,
  finite,
  readShapes,
  resolveEnd,
  shapeBounds,
  shapeIndex,
  shapesMapOf,
  TEXT_TYPES,
} from "./store";
import { type CanvasPreview, type CanvasPreviewShape, isShapeType, type ShapeView } from "./types";

/**
 * A canvas as a whole (ADR 0196 §2, §7): its preview (what cards and the Drive draw), its text (what search finds it
 * by), its rules of shape (what the server checks) and a version's content written over it.
 */

/** The most shapes a preview draws. */
const PREVIEW_SHAPES = 40;
const PREVIEW_TEXT = 80;
/** The most numbers of a pen stroke a preview keeps (enough to draw it small). */
const PREVIEW_POINTS = 120;

/** A pen stroke's points thinned to at most `max` numbers, its first and last point kept. */
function thinPoints(points: readonly number[], max: number): number[] {
  const n = points.length / 2;
  if (points.length <= max) return points.map((v) => Math.round(v));
  const keep = Math.max(2, Math.floor(max / 2));
  const out: number[] = [];
  for (let i = 0; i < keep; i++) {
    const at = Math.round((i * (n - 1)) / (keep - 1));
    out.push(Math.round(points[2 * at] as number), Math.round(points[2 * at + 1] as number));
  }
  return out;
}

/** The words a shape shows: its text, a frame's name, an arrow's label, an image's description or prompt. */
function wordsOf(shape: ShapeView): string {
  if (shape.text) return richText(shape.text);
  return shape.name ?? shape.label ?? shape.alt ?? shape.gen?.prompt ?? shape.prompt ?? "";
}

/**
 * What a canvas card draws: the bounds of what is shown, the shape count, and up to 40 shapes (frames first, then the
 * biggest; hidden ones left out), in drawing order, each with its box, its colors, its form, its picture and its first
 * words; an arrow its line, route and heads; a pen stroke a few of its points.
 */
export function canvasPreview(doc: Y.Doc): CanvasPreview {
  const all = readShapes(doc);
  const byId = shapeIndex(all);
  const shapes = all.filter((shape) => !shape.hidden);
  const bounds = union(shapes.map((shape) => shapeBounds(shape, byId)));
  const area = new Map(
    shapes.map((shape) => {
      const box = shapeBounds(shape, byId);
      return [shape.id, box.w * box.h] as const;
    }),
  );
  const chosen = new Set(
    [...shapes]
      .sort(
        (a, b) =>
          Number(b.type === "frame") - Number(a.type === "frame") || (area.get(b.id) ?? 0) - (area.get(a.id) ?? 0),
      )
      .slice(0, PREVIEW_SHAPES)
      .map((shape) => shape.id),
  );
  const out: CanvasPreviewShape[] = [];
  for (const shape of shapes) {
    if (!chosen.has(shape.id)) continue;
    const item: CanvasPreviewShape = { id: shape.id, type: shape.type, x: shape.x, y: shape.y, w: shape.w, h: shape.h };
    if (shape.rot) item.rot = shape.rot;
    const color = shape.color ?? shape.fill;
    if (color) item.color = color;
    if (shape.stroke) item.stroke = shape.stroke;
    if (shape.strokeWidth) item.strokeWidth = shape.strokeWidth;
    if (shape.kind) item.kind = shape.kind;
    if (shape.asset) item.asset = shape.asset;
    if (shape.crop) item.crop = shape.crop;
    const words = wordsOf(shape).replace(/\s+/g, " ").trim();
    if (words) item.text = words.slice(0, PREVIEW_TEXT);
    if (shape.type === "arrow") {
      const from = resolveEnd(shape.from, byId);
      const to = resolveEnd(shape.to, byId);
      if (from && to) item.line = arrowPath(from, to);
      if (shape.route && shape.route !== "straight") item.route = shape.route;
      if (shape.heads) item.heads = shape.heads;
    }
    if (shape.type === "draw" && shape.points) {
      item.points = thinPoints(shape.points, PREVIEW_POINTS);
      if (shape.tool) item.tool = shape.tool;
    }
    out.push(item);
  }
  return { bg: canvasBackground(doc), bounds, count: all.length, shapes: out };
}

/** The most text `canvasText` gives (search reads the first 20,000 characters). */
const TEXT_CHARS = 20_000;

/** The canvas's words: frame by frame (each frame's name, then what's in it, top to bottom), then the rest. */
export function canvasText(doc: Y.Doc): string {
  const shapes = readShapes(doc);
  const children = new Map<string, ShapeView[]>();
  for (const shape of shapes) {
    const key = shape.parent ?? "";
    const list = children.get(key) ?? [];
    list.push(shape);
    children.set(key, list);
  }
  const lines: string[] = [];
  let length = 0;
  const seen = new Set<string>();
  const visit = (shape: ShapeView) => {
    if (seen.has(shape.id) || length >= TEXT_CHARS) return;
    seen.add(shape.id);
    const words = wordsOf(shape).trim();
    if (words) {
      lines.push(words);
      length += words.length + 1;
    }
    const inside = [...(children.get(shape.id) ?? [])].sort((a, b) => a.y - b.y || a.x - b.x);
    for (const child of inside) visit(child);
  };
  const top = shapes.filter((shape) => !shape.parent || !shapes.some((s) => s.id === shape.parent));
  for (const shape of top.sort((a, b) => a.y - b.y || a.x - b.x)) visit(shape);
  for (const shape of shapes) visit(shape);
  return lines.join("\n").slice(0, TEXT_CHARS);
}

/** What breaks the canvas's rules of shape or `LIVE_LIMITS` (sentences for the logs; empty when nothing does). */
export function validateCanvas(doc: Y.Doc): string[] {
  const limits = LIVE_LIMITS.canvas;
  const problems: string[] = [];
  const bg = canvasMapOf(doc).get("bg");
  if (bg !== undefined && canvasBackground(doc) !== bg) problems.push("The canvas has an unknown background");
  const map = shapesMapOf(doc);
  if (map.size > limits.shapes) problems.push(`The canvas has ${map.size} shapes (at most ${limits.shapes})`);
  map.forEach((shape, id) => {
    const where = `Shape ${id}`;
    if (!(shape instanceof Y.Map)) {
      problems.push(`${where} isn't a map`);
      return;
    }
    const type = shape.get("type");
    if (!isShapeType(type)) {
      problems.push(`${where} has no known type`);
      return;
    }
    if (["x", "y", "w", "h"].some((key) => finite(shape.get(key)) === undefined)) {
      problems.push(`${where} has no valid box`);
    }
    if (typeof shape.get("z") !== "string") problems.push(`${where} has no stacking key`);
    const text = shape.get("text");
    if (text !== undefined) {
      if (!(text instanceof Y.XmlFragment) || !TEXT_TYPES.includes(type)) problems.push(`${where} has a broken text`);
      else if (richLength(readRich(text)) > limits.textChars) problems.push(`${where}'s text is over the limit`);
    }
    if (type === "arrow") {
      for (const key of ["from", "to"]) {
        const end = shape.get(key);
        if (!end || typeof end !== "object") problems.push(`${where} has no ${key} end`);
      }
    }
    // A pen stroke's points are its only content, and the one value that can grow: checked as written.
    if (type === "draw") {
      const points = shape.get("points");
      if (!Array.isArray(points)) problems.push(`${where} has no points`);
      else if (points.length > limits.drawPoints) problems.push(`${where} has over ${limits.drawPoints} points`);
      else if (cleanProp("points", points) === undefined) problems.push(`${where} has broken points`);
    }
  });
  return problems;
}

/** Writes `from`'s canvas over `doc`'s in one transaction with `origin`, changing only what differs. */
export function replaceCanvas(doc: Y.Doc, from: Y.Doc, origin: unknown): void {
  doc.transact(() => {
    overwriteMap(canvasMapOf(doc), canvasMapOf(from));
    overwriteMap(shapesMapOf(doc), shapesMapOf(from));
  }, origin);
}
