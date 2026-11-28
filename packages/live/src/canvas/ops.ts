import * as Y from "yjs";
import type { PeerUser } from "../awareness";
import { LiveEditError } from "../errors";
import { isOrderKey, keyBetween, restack, type StackMove } from "../fractional";
import { cleanGroupName, type LiveGroup, outermostGroup, usedGroups } from "../groups";
import { newId } from "../ids";
import { LIVE_LIMITS } from "../limits";
import { isLiveOrigin } from "../origins";
import { richFromText, richLength } from "../rich/text";
import type { RichDoc } from "../rich/types";
import { writeRich } from "../rich/yjs";
import { arrowPath, type Box, center, type Point, pointsBounds, union } from "./geometry";
import { placeBoxes } from "./place";
import {
  COMMON_PROPS,
  canvasGroupsMapOf,
  canvasMapOf,
  cleanProp,
  descendantsOf,
  readCanvasGroups,
  readShapeById,
  readShapes,
  shapeBounds,
  shapeIndex,
  shapeMapOf,
  shapesMapOf,
  TEXT_TYPES,
  TYPE_PROPS,
} from "./store";
import {
  type ArrowEnd,
  CANVAS_BACKGROUNDS,
  type CanvasBackground,
  type ImageGen,
  isShapeType,
  type NewShape,
  type Placement,
  type ShapePatch,
  type ShapeType,
  type ShapeView,
} from "./types";

/**
 * Edits to a canvas (ADR 0196 §2), the same for the web, the phone, the agents' tools and the image jobs. Each runs in
 * one `doc.transact(fn, origin)` and checks what it was given before it changes anything, so a refused edit leaves
 * the canvas as it was: `LiveEditError` `not_found`, `too_many` / `too_large` past `LIVE_LIMITS`, `invalid`.
 */

const limits = LIVE_LIMITS.canvas;

/** Reads for placement and geometry leave the rich text out. */
const GEOMETRY = { text: false } as const;

/** Where an arrow's end is now: its shape's box (null when that shape is gone) or the free point. */
function endOf(doc: Y.Doc, end: ArrowEnd | undefined): Box | Point | null {
  if (!end) return null;
  if (!("shape" in end)) return end;
  const shape = readShapeById(doc, end.shape, GEOMETRY);
  return shape && shape.type !== "arrow" ? { x: shape.x, y: shape.y, w: shape.w, h: shape.h } : null;
}

function invalid(message: string): LiveEditError {
  return new LiveEditError("invalid", message);
}

/** A new canvas's content: the dotted background. Does nothing when it already has one. */
export function initCanvas(doc: Y.Doc, origin: unknown = null): void {
  const canvas = canvasMapOf(doc);
  if (canvas.has("bg")) return;
  doc.transact(() => canvas.set("bg", "dots"), origin);
}

export function setCanvasBackground(doc: Y.Doc, bg: CanvasBackground, origin: unknown): void {
  if (!(CANVAS_BACKGROUNDS as readonly string[]).includes(bg)) throw invalid(`Unknown background ${String(bg)}`);
  const canvas = canvasMapOf(doc);
  if (canvas.get("bg") === bg) return;
  doc.transact(() => canvas.set("bg", bg), origin);
}

/** The size a new shape of a type takes when none is given. */
export function defaultSize(type: ShapeType): { w: number; h: number } {
  switch (type) {
    case "note":
      return { w: 200, h: 200 };
    case "text":
      return { w: 320, h: 60 };
    case "frame":
      return { w: 800, h: 600 };
    case "shape":
      return { w: 200, h: 140 };
    case "image":
    case "pending":
      return { w: 512, h: 512 };
    case "html":
      return { w: 640, h: 480 };
    case "file":
      return { w: 320, h: 120 };
    case "arrow":
    case "draw":
      return { w: 0, h: 0 };
  }
}

/** Who a change's origin says made it: the agent, or the person (ADR 0196 §6); undefined for the app's own edits. */
function makerOf(origin: unknown): PeerUser | undefined {
  if (!isLiveOrigin(origin)) return undefined;
  const user = origin.agentId
    ? { kind: "agent", id: origin.agentId }
    : origin.userId
      ? { kind: "person", id: origin.userId }
      : undefined;
  return user ? (cleanProp("by", user) as PeerUser | undefined) : undefined;
}

/**
 * A pen stroke's points made to start at its box's corner: the box moves to where they are and takes their extent, so
 * `points` are always from the box's top-left (`base` is where they were measured from).
 */
function strokeBox(points: readonly number[], base: Point): { box: Box; points: number[] } {
  const b = pointsBounds(points) ?? { x: 0, y: 0, w: 0, h: 0 };
  const shifted = points.map((v, i) => (i % 2 === 0 ? v - b.x : v - b.y));
  return { box: { x: base.x + b.x, y: base.y + b.y, w: b.w, h: b.h }, points: shifted };
}

/** The longest side an image takes when it lands on the canvas at its natural size. */
const IMAGE_MAX_SIDE = 640;

function richOf(text: string | RichDoc): RichDoc {
  return typeof text === "string" ? richFromText(text) : text;
}

/** The key that puts a shape on top of the others of its layer (frames under everything else). */
function topKey(doc: Y.Doc, frame: boolean): string {
  let top: string | null = null;
  for (const shape of readShapes(doc, GEOMETRY)) {
    if ((shape.type === "frame") !== frame || !isOrderKey(shape.z)) continue;
    if (top === null || shape.z > top) top = shape.z;
  }
  return keyBetween(top, null);
}

/**
 * Checked values for a new shape's keys (all but its id, `z` and `text`). Who made it is the one given, else the
 * origin's person or agent.
 */
function checkedShape(doc: Y.Doc, shape: NewShape, origin: unknown): { values: Map<string, unknown>; text?: RichDoc } {
  if (!isShapeType(shape.type)) throw invalid(`Unknown shape type ${String(shape.type)}`);
  const type = shape.type;
  const values = new Map<string, unknown>([["type", type]]);
  const raw = shape as unknown as Record<string, unknown>;
  for (const key of [...COMMON_PROPS, ...TYPE_PROPS[type]]) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const value = cleanProp(key, raw[key]);
    if (value === undefined) throw invalid(`Bad ${key}`);
    values.set(key, value);
  }
  if (!values.has("by")) {
    const maker = makerOf(origin);
    if (maker) values.set("by", maker);
  }
  if (type === "draw" && !values.has("points")) throw invalid("A pen stroke needs its points");
  if (type === "arrow") {
    const from = values.get("from") as ArrowEnd | undefined;
    const to = values.get("to") as ArrowEnd | undefined;
    if (!from || !to) throw invalid("An arrow needs both ends");
    for (const end of [from, to]) {
      if ("shape" in end && !readShapeById(doc, end.shape, GEOMETRY)) {
        throw new LiveEditError("not_found", `No shape ${end.shape}`);
      }
    }
  }
  if (values.has("parent")) {
    const parent = readShapeById(doc, values.get("parent") as string, GEOMETRY);
    if (parent?.type !== "frame") throw new LiveEditError("not_found", "No such frame");
  }
  let text: RichDoc | undefined;
  if (shape.text !== undefined) {
    if (!TEXT_TYPES.includes(type)) throw invalid("Only notes, text and shapes hold text");
    text = richOf(shape.text);
    if (richLength(text) > limits.textChars) {
      throw new LiveEditError("too_large", `The text is over ${limits.textChars} characters`);
    }
  } else if (TEXT_TYPES.includes(type)) text = [];
  if (type === "note" && !values.has("color")) values.set("color", "yellow");
  if (type === "shape" && !values.has("kind")) values.set("kind", "rect");
  if (type === "pending" && !values.has("status")) values.set("status", "queued");
  return text ? { values, text } : { values };
}

/**
 * A new shape's box: the one given, else its natural size (images scaled down) in free room: around the point when
 * only one coordinate is given, inside its frame when it has one (the frame then may have to grow).
 */
function boxFor(doc: Y.Doc, shape: NewShape, values: Map<string, unknown>): { box: Box; grow?: Placement["grow"] } {
  const type = shape.type;
  if (type === "draw") {
    // Its points from (x, y) when given, else where they are on the canvas.
    const at = (key: "x" | "y") => (cleanProp(key, shape[key]) as number | undefined) ?? 0;
    const base = { x: at("x"), y: at("y") };
    const stroke = strokeBox(values.get("points") as number[], base);
    values.set("points", stroke.points);
    return { box: stroke.box };
  }
  if (type === "arrow") {
    const a = endOf(doc, values.get("from") as ArrowEnd);
    const b = endOf(doc, values.get("to") as ArrowEnd);
    if (!a || !b) return { box: { x: 0, y: 0, w: 0, h: 0 } };
    const path = arrowPath(a, b);
    const box = union([
      { x: path.x1, y: path.y1, w: 0, h: 0 },
      { x: path.x2, y: path.y2, w: 0, h: 0 },
    ]);
    return { box: box ?? { x: 0, y: 0, w: 0, h: 0 } };
  }
  let { w, h } = defaultSize(type);
  const nw = values.get("nw");
  const nh = values.get("nh");
  if (type === "image" && typeof nw === "number" && typeof nh === "number") {
    const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(nw, nh));
    w = nw * scale;
    h = nh * scale;
  }
  const given = (key: "x" | "y" | "w" | "h"): number | undefined => {
    const value = shape[key];
    if (value === undefined || value === null) return undefined;
    const clean = cleanProp(key, value);
    if (clean === undefined) throw invalid(`Bad ${key}`);
    return clean as number;
  };
  w = given("w") ?? w;
  h = given("h") ?? h;
  const x = given("x");
  const y = given("y");
  if (x !== undefined && y !== undefined) return { box: { x, y, w, h } };
  const near = x !== undefined || y !== undefined ? { x: (x ?? 0) + w / 2, y: (y ?? 0) + h / 2 } : undefined;
  const parent = values.get("parent") as string | undefined;
  const placed = placeBoxes(doc, { count: 1, w, h, ...(near ? { near } : {}), ...(parent ? { within: parent } : {}) });
  const box = placed.boxes[0] ?? { x: 0, y: 0, w, h };
  return placed.grow ? { box, grow: placed.grow } : { box };
}

/**
 * Adds a shape on top of the others (a frame on top of the frames, under everything else). Without `x` and `y` it
 * goes to free room (inside its `parent` frame when it has one, which grows when full); an image without a size takes
 * its natural size, scaled down to 640 on its longest side. Returns its id.
 */
export function addShape(doc: Y.Doc, shape: NewShape, origin: unknown): string {
  if (shapesMapOf(doc).size >= limits.shapes) {
    throw new LiveEditError("too_many", `A canvas holds at most ${limits.shapes} shapes`);
  }
  const { values, text } = checkedShape(doc, shape, origin);
  const { box, grow } = boxFor(doc, shape, values);
  const id = newId();
  doc.transact(() => {
    if (grow) {
      const frame = shapeMapOf(doc, grow.id);
      frame?.set("w", grow.box.w);
      frame?.set("h", grow.box.h);
    }
    const map = new Y.Map<unknown>();
    for (const [key, value] of values) map.set(key, value);
    map.set("x", box.x);
    map.set("y", box.y);
    map.set("w", box.w);
    map.set("h", box.h);
    map.set("z", topKey(doc, shape.type === "frame"));
    if (text) {
      const fragment = new Y.XmlFragment();
      writeRich(fragment, text);
      map.set("text", fragment);
    }
    shapesMapOf(doc).set(id, map);
  }, origin);
  return id;
}

/**
 * Changes a shape: keys given change, `null` takes an optional one away, `text` replaces the text (light Markdown or
 * rich text). Its type stays (a placeholder becomes an image through `fillPending`).
 */
export function updateShape(doc: Y.Doc, id: string, patch: ShapePatch, origin: unknown): void {
  const map = shapeMapOf(doc, id);
  const view = readShapeById(doc, id);
  if (!map || !view) throw new LiveEditError("not_found", `No shape ${id}`);
  const sets: [string, unknown][] = [];
  const deletes: string[] = [];
  const allowed = new Set(["x", "y", "w", "h", "z", ...COMMON_PROPS, ...TYPE_PROPS[view.type]]);
  for (const [key, value] of Object.entries(patch)) {
    if (key === "text" || value === undefined) continue;
    if (!allowed.has(key)) throw invalid(`A ${view.type} has no ${key}`);
    if (value === null) {
      if (["x", "y", "w", "h", "z"].includes(key)) throw invalid(`${key} can't be removed`);
      deletes.push(key);
      continue;
    }
    if (key === "z") {
      if (!isOrderKey(value)) throw invalid("Bad stacking key");
      sets.push([key, value]);
      continue;
    }
    const clean = cleanProp(key, value);
    if (clean === undefined) {
      // `false` for a flag is its absence.
      if ((key === "locked" || key === "dashed" || key === "hidden") && value === false) deletes.push(key);
      else throw invalid(`Bad ${key}`);
      continue;
    }
    sets.push([key, clean]);
  }
  const parent = sets.find(([key]) => key === "parent")?.[1];
  if (typeof parent === "string") checkParent(doc, [id], parent);
  const points = sets.find(([key]) => key === "points")?.[1] as number[] | undefined;
  if (points) {
    // New points are from the box's corner (where it is after this change): the box takes their extent.
    const given = (key: "x" | "y") => sets.find(([k]) => k === key)?.[1] as number | undefined;
    const stroke = strokeBox(points, { x: given("x") ?? view.x, y: given("y") ?? view.y });
    const box: [string, unknown][] = [
      ["points", stroke.points],
      ["x", stroke.box.x],
      ["y", stroke.box.y],
      ["w", stroke.box.w],
      ["h", stroke.box.h],
    ];
    for (const [key, value] of box) {
      const at = sets.findIndex(([k]) => k === key);
      if (at >= 0) sets[at] = [key, value];
      else sets.push([key, value]);
    }
  }
  for (const [key, value] of sets) {
    if ((key === "from" || key === "to") && "shape" in (value as ArrowEnd)) {
      const target = (value as { shape: string }).shape;
      if (target === id || !shapeMapOf(doc, target)) throw new LiveEditError("not_found", `No shape ${target}`);
    }
  }
  let text: RichDoc | undefined;
  if (patch.text !== undefined) {
    if (!TEXT_TYPES.includes(view.type)) throw invalid("Only notes, text and shapes hold text");
    text = richOf(patch.text);
    if (richLength(text) > limits.textChars) {
      throw new LiveEditError("too_large", `The text is over ${limits.textChars} characters`);
    }
  }
  if (!sets.length && !deletes.length && text === undefined) return;
  doc.transact(() => {
    for (const [key, value] of sets) map.set(key, value);
    for (const key of deletes) if (map.has(key)) map.delete(key);
    if (text !== undefined) {
      const fragment = map.get("text");
      if (fragment instanceof Y.XmlFragment) writeRich(fragment, text);
      else {
        const fresh = new Y.XmlFragment();
        writeRich(fresh, text);
        map.set("text", fresh);
      }
    }
  }, origin);
}

/**
 * Deletes shapes; a frame takes everything in it. Arrows tied to a deleted shape keep their other end: the tied end
 * stays where the shape was, and an arrow with both ends gone goes too.
 */
export function deleteShapes(doc: Y.Doc, ids: readonly string[], origin: unknown): void {
  const shapes = readShapes(doc, GEOMETRY);
  const byId = shapeIndex(shapes);
  const gone = new Set(ids.filter((id) => byId.has(id)));
  for (const id of descendantsOf(gone, shapes)) gone.add(id);
  if (!gone.size) return;
  doc.transact(() => {
    const map = shapesMapOf(doc);
    for (const arrow of shapes) {
      if (arrow.type !== "arrow" || gone.has(arrow.id)) continue;
      const ends = (["from", "to"] as const).filter((key) => {
        const end = arrow[key];
        return !!end && "shape" in end && gone.has(end.shape);
      });
      if (!ends.length) continue;
      const other = arrow[ends[0] === "from" ? "to" : "from"];
      const otherGone = !other || ("shape" in other && gone.has(other.shape));
      if (ends.length === 2 || otherGone) {
        gone.add(arrow.id);
        continue;
      }
      const arrowMap = shapeMapOf(doc, arrow.id);
      for (const key of ends) {
        const end = arrow[key];
        const shape = end && "shape" in end ? byId.get(end.shape) : undefined;
        if (arrowMap && shape) arrowMap.set(key, center(shape));
      }
    }
    for (const id of gone) map.delete(id);
    pruneCanvasGroups(doc);
  }, origin);
}

/** Drops the groups that hold nothing any more, inside the caller's transaction (ADR 0220 §3). */
function pruneCanvasGroups(doc: Y.Doc): void {
  const map = canvasGroupsMapOf(doc);
  if (map.size === 0) return;
  const named: string[] = [];
  shapesMapOf(doc).forEach((shape) => {
    const group = shape instanceof Y.Map ? shape.get("group") : undefined;
    if (typeof group === "string") named.push(group);
  });
  const groups = readCanvasGroups(doc);
  const used = usedGroups(groups, named);
  for (const g of groups) if (!used.has(g.id)) map.delete(g.id);
}

/** Moves shapes by (dx, dy); a frame carries what's in it, and an arrow's free ends move with it. */
export function moveShapes(doc: Y.Doc, ids: readonly string[], dx: number, dy: number, origin: unknown): void {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw invalid("Bad offset");
  if (dx === 0 && dy === 0) return;
  const shapes = readShapes(doc, GEOMETRY);
  const byId = shapeIndex(shapes);
  const moving = new Set(ids.filter((id) => byId.has(id)));
  for (const id of descendantsOf(moving, shapes)) moving.add(id);
  if (!moving.size) return;
  doc.transact(() => {
    for (const id of moving) {
      const shape = byId.get(id);
      const map = shapeMapOf(doc, id);
      if (!shape || !map) continue;
      map.set("x", shape.x + dx);
      map.set("y", shape.y + dy);
      if (shape.type !== "arrow") continue;
      for (const key of ["from", "to"] as const) {
        const end = shape[key];
        if (end && !("shape" in end)) map.set(key, { x: end.x + dx, y: end.y + dy });
      }
    }
  }, origin);
}

/**
 * Sets a shape's box (an arrow's free ends follow its box, a pen stroke's points stretch with it). What's in a frame
 * stays where it is.
 */
export function resizeShape(doc: Y.Doc, id: string, box: Box, origin: unknown): void {
  const map = shapeMapOf(doc, id);
  const shape = readShapeById(doc, id);
  if (!map || !shape) throw new LiveEditError("not_found", `No shape ${id}`);
  const x = cleanProp("x", box.x) as number | undefined;
  const y = cleanProp("y", box.y) as number | undefined;
  const w = cleanProp("w", box.w) as number | undefined;
  const h = cleanProp("h", box.h) as number | undefined;
  if (x === undefined || y === undefined || w === undefined || h === undefined) throw invalid("Bad box");
  doc.transact(() => {
    map.set("x", x);
    map.set("y", y);
    map.set("w", w);
    map.set("h", h);
    if (shape.type === "draw" && shape.points) {
      const fx = shape.w ? w / shape.w : 1;
      const fy = shape.h ? h / shape.h : 1;
      if (fx !== 1 || fy !== 1)
        map.set(
          "points",
          shape.points.map((v, i) => (i % 2 === 0 ? v * fx : v * fy)),
        );
      return;
    }
    if (shape.type !== "arrow") return;
    const old = shapeBounds(shape, shapeIndex([shape]));
    const fx = old.w ? w / old.w : 1;
    const fy = old.h ? h / old.h : 1;
    for (const key of ["from", "to"] as const) {
      const end = shape[key];
      if (end && !("shape" in end)) map.set(key, { x: x + (end.x - old.x) * fx, y: y + (end.y - old.y) * fy });
    }
  }, origin);
}

/** Brings shapes to the front or the back, or one step forward or backward (frames among frames). */
export function arrange(doc: Y.Doc, ids: readonly string[], how: StackMove, origin: unknown): void {
  const shapes = readShapes(doc, GEOMETRY);
  const chosen = new Set(ids);
  const keys = new Map<string, string>();
  for (const frames of [true, false]) {
    const layer = shapes.filter((s) => (s.type === "frame") === frames).map((s) => ({ id: s.id, z: s.z }));
    for (const [id, z] of restack(
      layer,
      [...chosen].filter((id) => layer.some((s) => s.id === id)),
      how,
    )) {
      keys.set(id, z);
    }
  }
  if (!keys.size) return;
  doc.transact(() => {
    for (const [id, z] of keys) shapeMapOf(doc, id)?.set("z", z);
  }, origin);
}

/** Refuses a parent that isn't a frame, or that is one of the shapes or inside them (a frame can't hold itself). */
function checkParent(doc: Y.Doc, ids: readonly string[], frameId: string): void {
  const shapes = readShapes(doc, GEOMETRY);
  const frame = shapes.find((s) => s.id === frameId);
  if (frame?.type !== "frame") throw new LiveEditError("not_found", `No frame ${frameId}`);
  const inside = descendantsOf(ids, shapes);
  if (ids.includes(frameId) || inside.has(frameId)) throw invalid("A frame can't go inside itself");
}

/** Puts shapes in a frame (`null`: out of any). Where they are doesn't change. */
export function setParent(doc: Y.Doc, ids: readonly string[], frameId: string | null, origin: unknown): void {
  if (frameId !== null) checkParent(doc, ids, frameId);
  const maps = ids.map((id) => shapeMapOf(doc, id)).filter((map): map is Y.Map<unknown> => map !== null);
  if (!maps.length) return;
  doc.transact(() => {
    for (const map of maps) {
      if (frameId === null) {
        if (map.has("parent")) map.delete("parent");
      } else if (map.get("parent") !== frameId) map.set("parent", frameId);
    }
  }, origin);
}

/**
 * Turns a placeholder into the image it was waiting for (ADR 0197), keeping its id, its place in the stack and its
 * frame; the box keeps its width and center and takes the image's proportions. False when there is no such
 * placeholder (someone deleted it): the image then has nowhere to go.
 */
export function fillPending(
  doc: Y.Doc,
  id: string,
  image: { asset: string; nw: number; nh: number; gen?: ImageGen; alt?: string },
  origin: unknown,
): boolean {
  const map = shapeMapOf(doc, id);
  const shape = readShapeById(doc, id);
  if (!map || !shape || shape.type !== "pending") return false;
  const asset = cleanProp("asset", image.asset);
  const nw = cleanProp("nw", image.nw) as number | undefined;
  const nh = cleanProp("nh", image.nh) as number | undefined;
  if (asset === undefined || nw === undefined || nh === undefined) throw invalid("Bad image");
  const gen = image.gen === undefined ? undefined : cleanProp("gen", image.gen);
  if (image.gen !== undefined && gen === undefined) throw invalid("Bad image origin");
  const h = shape.w * (nh / nw);
  doc.transact(() => {
    for (const key of TYPE_PROPS.pending) if (map.has(key)) map.delete(key);
    map.set("type", "image");
    map.set("asset", asset);
    map.set("nw", nw);
    map.set("nh", nh);
    if (gen) map.set("gen", gen);
    if (image.alt) map.set("alt", image.alt.slice(0, 1000));
    map.set("y", shape.y + (shape.h - h) / 2);
    map.set("h", h);
  }, origin);
  return true;
}

/** A shape's text, to bind an editor to it, or null. */
export function shapeTextFragment(doc: Y.Doc, id: string): Y.XmlFragment | null {
  const value = shapeMapOf(doc, id)?.get("text");
  return value instanceof Y.XmlFragment ? value : null;
}

/** Shapes as plain data by id (the shapes that exist). */
export function shapesById(doc: Y.Doc, ids: readonly string[]): ShapeView[] {
  const byId = shapeIndex(readShapes(doc));
  return ids.map((id) => byId.get(id)).filter((shape): shape is ShapeView => !!shape);
}

/** Where an arrow's ends are now (bound ends follow their shapes) and its line, or null when an end's shape is gone. */
export function arrowEnds(
  doc: Y.Doc,
  arrow: ShapeView,
): { from: Box | Point; to: Box | Point; path: ReturnType<typeof arrowPath> } | null {
  const from = endOf(doc, arrow.from);
  const to = endOf(doc, arrow.to);
  return from && to ? { from, to, path: arrowPath(from, to) } : null;
}

/**
 * Makes a group of shapes (ADR 0220 §3): they hold together from now on (frames still contain; a group only holds).
 * Shapes already in a group bring their outermost group along, inside the new one. Returns the group's id.
 */
export function groupShapes(
  doc: Y.Doc,
  ids: readonly string[],
  opts: { name?: string; id?: string },
  origin: unknown,
): string {
  const present = ids.filter((id) => shapeMapOf(doc, id));
  if (!present.length) throw invalid("Name the shapes to group");
  const groups = readCanvasGroups(doc);
  if (groups.length >= LIVE_LIMITS.canvas.shapes) throw new LiveEditError("too_many", "Too many groups");
  const known = new Set(groups.map((g) => g.id));
  const id = opts.id && /^[A-Za-z0-9_-]{1,64}$/.test(opts.id) ? opts.id : newId();
  const name = cleanGroupName(opts.name);
  doc.transact(() => {
    const map = canvasGroupsMapOf(doc);
    map.set(id, name ? { name } : {});
    const moved = new Set<string>();
    for (const shapeId of present) {
      const shape = shapeMapOf(doc, shapeId);
      if (!shape) continue;
      const current = shape.get("group");
      const outer = typeof current === "string" && known.has(current) ? outermostGroup(groups, current) : undefined;
      if (outer && outer !== id) {
        if (!moved.has(outer)) {
          const g = map.get(outer);
          map.set(outer, { ...(g && typeof g === "object" ? (g as object) : {}), parent: id });
          moved.add(outer);
        }
      } else shape.set("group", id);
    }
  }, origin);
  return id;
}

/** Undoes a group: what it held goes to the group it sat in (or to none). */
export function ungroupShapes(doc: Y.Doc, groupId: string, origin: unknown): void {
  const group = readCanvasGroups(doc).find((g) => g.id === groupId);
  if (!group) throw new LiveEditError("not_found", `No group ${groupId}`);
  doc.transact(() => {
    const map = canvasGroupsMapOf(doc);
    shapesMapOf(doc).forEach((shape) => {
      if (!(shape instanceof Y.Map) || shape.get("group") !== groupId) return;
      if (group.parent) shape.set("group", group.parent);
      else shape.delete("group");
    });
    map.forEach((value, id) => {
      if (!value || typeof value !== "object" || (value as { parent?: unknown }).parent !== groupId) return;
      const { parent: _gone, ...rest } = value as { parent?: string; name?: string };
      map.set(id, group.parent ? { ...rest, parent: group.parent } : rest);
    });
    map.delete(groupId);
  }, origin);
}

/** Names a canvas group ("" or null takes the name away). */
export function renameShapeGroup(doc: Y.Doc, groupId: string, name: string | null, origin: unknown): void {
  const map = canvasGroupsMapOf(doc);
  const value = map.get(groupId);
  if (!value || typeof value !== "object") throw new LiveEditError("not_found", `No group ${groupId}`);
  const clean = cleanGroupName(name);
  const { name: _old, ...rest } = value as { name?: string; parent?: string };
  doc.transact(() => map.set(groupId, clean ? { ...rest, name: clean } : rest), origin);
}

/** Writes canvas groups as they are given (ids, names, parents), as `putGroups` does for a slide (ADR 0220 §4). */
export function putShapeGroups(doc: Y.Doc, groups: readonly LiveGroup[], origin: unknown): void {
  if (!groups.length) return;
  const existing = new Set(readCanvasGroups(doc).map((g) => g.id));
  if (existing.size + groups.length > LIVE_LIMITS.canvas.shapes) throw new LiveEditError("too_many", "Too many groups");
  const ids = new Set(groups.map((g) => g.id));
  doc.transact(() => {
    const map = canvasGroupsMapOf(doc);
    for (const g of groups) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(g.id)) throw invalid("Bad group");
      const name = cleanGroupName(g.name);
      const parent =
        g.parent && (ids.has(g.parent) || existing.has(g.parent)) && g.parent !== g.id ? g.parent : undefined;
      map.set(g.id, { ...(name ? { name } : {}), ...(parent ? { parent } : {}) });
    }
  }, origin);
}
