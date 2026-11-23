import { richText } from "@agenteschat/live";
import type { PeerUser } from "@agenteschat/live/awareness";
import {
  type ArrowEnd,
  addShape,
  ancestorsOf,
  descendantsOf,
  frameAt,
  type NewShape,
  type Point,
  readShapes,
  type ShapeView,
  shapeIndex,
  union,
} from "@agenteschat/live/canvas";
import type * as Y from "yjs";
import { arrowLine } from "./edit-math";

/**
 * Copying shapes between canvases and within one (ADR 0196 §2): the shapes as plain data, with what they need to come
 * back whole somewhere else (what's inside a copied frame, the arrows between copied shapes, where an arrow's ends
 * were in case what they were tied to stays behind). Pictures belong to their file (ADR 0196 §8): pasted into another
 * canvas they are copied into it first (`assetsToCopy`, then `withAssets`).
 */

/** The clipboard type our shapes travel under (besides HTML and plain text, for other apps and browsers). */
export const CLIP_TYPE = "application/x-agentes-canvas";
/** Where the same data hides in the HTML copy (browsers that drop custom types keep the HTML). */
const HTML_ATTR = "data-agentes-canvas";

export interface ClipShape extends ShapeView {
  /** An arrow's ends where they were, for an end whose shape wasn't copied. */
  ends?: { from: Point; to: Point };
}

export interface CanvasClip {
  v: 1;
  /** The canvas they came from (its pictures are its own). */
  file: string;
  shapes: ClipShape[];
}

/**
 * The shapes to copy for a selection: the chosen ones, everything inside chosen frames, and the arrows whose two ends
 * are among them; never a placeholder (it belongs to its request). In drawing order.
 */
export function copyShapes(doc: Y.Doc, fileId: string, ids: readonly string[]): CanvasClip | null {
  const shapes = readShapes(doc);
  const byId = shapeIndex(shapes);
  const chosen = new Set(ids.filter((id) => byId.has(id)));
  for (const id of descendantsOf(chosen, shapes)) chosen.add(id);
  for (const s of shapes) {
    if (s.type !== "arrow" || chosen.has(s.id)) continue;
    const tied = (end: ArrowEnd | undefined) => !!end && "shape" in end && chosen.has(end.shape);
    if (tied(s.from) && tied(s.to)) chosen.add(s.id);
  }
  const out: ClipShape[] = [];
  for (const s of shapes) {
    if (!chosen.has(s.id) || s.type === "pending") continue;
    const clip: ClipShape = { ...s };
    if (s.type === "arrow") {
      const line = arrowLine(s, byId);
      if (line) clip.ends = { from: { x: line.x1, y: line.y1 }, to: { x: line.x2, y: line.y2 } };
    }
    out.push(clip);
  }
  return out.length ? { v: 1, file: fileId, shapes: out } : null;
}

/** The words of copied shapes, for apps that take plain text. */
export function clipText(clip: CanvasClip): string {
  const words: string[] = [];
  for (const s of clip.shapes) {
    const text = s.text ? richText(s.text).trim() : (s.name ?? s.label ?? s.gen?.prompt ?? s.alt ?? "").trim();
    if (text) words.push(text);
  }
  return words.join("\n\n");
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));

function toBase64Text(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64Text(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** What a copy writes: our type, an HTML copy carrying the same data, and the words. */
export function clipPayload(clip: CanvasClip): { json: string; html: string; text: string } {
  const json = JSON.stringify(clip);
  const text = clipText(clip);
  const html = `<span ${HTML_ATTR}="${toBase64Text(json)}">${escapeHtml(text).replace(/\n/g, "<br>")}</span>`;
  return { json, html, text };
}

/** Our shapes in what was pasted (our type, or the HTML copy), or null. */
export function readClip(data: { json?: string | null; html?: string | null }): CanvasClip | null {
  const parse = (text: string): CanvasClip | null => {
    try {
      const value = JSON.parse(text) as Partial<CanvasClip>;
      if (value?.v !== 1 || typeof value.file !== "string" || !Array.isArray(value.shapes)) return null;
      return { v: 1, file: value.file, shapes: value.shapes.filter((s) => s && typeof s.id === "string") };
    } catch {
      return null;
    }
  };
  if (data.json) {
    const clip = parse(data.json);
    if (clip) return clip;
  }
  const match = data.html ? new RegExp(`${HTML_ATTR}="([A-Za-z0-9+/=]+)"`).exec(data.html) : null;
  if (match?.[1]) {
    try {
      return parse(fromBase64Text(match[1]));
    } catch {
      return null;
    }
  }
  return null;
}

/** The pictures a paste into `fileId` has to copy in first (the clip came from another canvas). */
export function assetsToCopy(clip: CanvasClip, fileId: string): string[] {
  if (clip.file === fileId) return [];
  return [...new Set(clip.shapes.flatMap((s) => (s.type === "image" && s.asset ? [s.asset] : [])))];
}

/** The clip with its pictures' ids swapped for their copies here (pictures that couldn't be copied are left out). */
export function withAssets(clip: CanvasClip, fileId: string, copies: ReadonlyMap<string, string>): CanvasClip {
  if (clip.file === fileId) return clip;
  const shapes: ClipShape[] = [];
  for (const s of clip.shapes) {
    if (s.type !== "image") {
      shapes.push(s);
      continue;
    }
    const asset = s.asset ? copies.get(s.asset) : undefined;
    if (!asset) continue;
    // Its references were the other canvas's pictures: they don't travel.
    const gen = s.gen ? { ...s.gen, from: undefined } : undefined;
    shapes.push({ ...s, asset, ...(gen ? { gen } : {}) });
  }
  return { v: 1, file: fileId, shapes };
}

/** The box around a clip's shapes. */
export function clipBounds(clip: CanvasClip) {
  return union(
    clip.shapes.flatMap((s) => {
      if (s.type === "arrow") {
        return s.ends
          ? [
              { x: s.ends.from.x, y: s.ends.from.y, w: 0, h: 0 },
              { x: s.ends.to.x, y: s.ends.to.y, w: 0, h: 0 },
            ]
          : [];
      }
      return [{ x: s.x, y: s.y, w: s.w, h: s.h }];
    }),
  );
}

const DROPPED_KEYS = ["id", "z", "ends", "parent", "text", "type"] as const;

/**
 * Puts a clip's shapes on the canvas, moved by (`dx`, `dy`), as new shapes with new ids: frames before what's inside
 * them, arrows last and tied to the new copies of their shapes (an end whose shape didn't come stays where it was).
 * A shape whose frame didn't come goes into the frame under it, if any. One transaction, so one undo step. Returns
 * the new ids of the top-level shapes (what to select): not the arrows tied at both ends to pasted shapes, which go
 * wherever those go. `by`: who pastes, whom the copies say made them (the apps' own edits carry no author).
 */
export function pasteClip(
  doc: Y.Doc,
  clip: CanvasClip,
  dx: number,
  dy: number,
  origin: unknown,
  by?: PeerUser,
): string[] {
  const byOld = new Map(clip.shapes.map((s) => [s.id, s]));
  const depth = (s: ClipShape) => ancestorsOf(s.id, byOld).length;
  const ordered = [
    ...clip.shapes.filter((s) => s.type === "frame").sort((a, b) => depth(a) - depth(b)),
    ...clip.shapes.filter((s) => s.type !== "frame" && s.type !== "arrow"),
    ...clip.shapes.filter((s) => s.type === "arrow"),
  ];
  const made = new Map<string, string>();
  const top: string[] = [];
  doc.transact(() => {
    for (const s of ordered) {
      if (s.type === "pending") continue;
      const rest: Record<string, unknown> = { ...s };
      for (const key of DROPPED_KEYS) delete rest[key];
      const shape = { type: s.type, ...rest } as NewShape;
      if (s.text) shape.text = s.text;
      if (by) shape.by = by;
      const parent = s.parent ? made.get(s.parent) : undefined;
      let follows = false;
      if (s.type === "arrow") {
        const end = (e: ArrowEnd | undefined, fallback: Point | undefined): ArrowEnd | null => {
          if (e && "shape" in e && made.has(e.shape)) return { shape: made.get(e.shape) as string };
          const p = e && !("shape" in e) ? e : fallback;
          return p ? { x: p.x + dx, y: p.y + dy } : null;
        };
        const from = end(s.from, s.ends?.from);
        const to = end(s.to, s.ends?.to);
        if (!from || !to) continue;
        follows = "shape" in from && "shape" in to;
        shape.from = from;
        shape.to = to;
        delete shape.x;
        delete shape.y;
        delete shape.w;
        delete shape.h;
      } else {
        shape.x = s.x + dx;
        shape.y = s.y + dy;
        if (parent) shape.parent = parent;
        else {
          const under = frameAt(doc, s.x + dx + s.w / 2, s.y + dy + s.h / 2);
          if (under) shape.parent = under;
        }
      }
      try {
        const id = addShape(doc, shape, origin);
        made.set(s.id, id);
        if (!parent && !follows) top.push(id);
      } catch {
        // A shape this canvas can't hold (past its limits): the rest still come.
      }
    }
  }, origin);
  return top;
}
