import type { PeerUser } from "../awareness";
import type { RichDoc } from "../rich/types";
import type { Box, Point } from "./geometry";

/**
 * Canvases (ADR 0196 §2): shapes in a map, each with a box in world units, a stacking key and the frame it sits in.
 * One shape type per kind of thing: images (generated or dropped), notes, text, frames that group, shapes, arrows and
 * lines (between shapes or points), pen strokes, an agent's page (an `html` file drawn isolated), any Drive file as a
 * card, and a placeholder for an image being generated (ADR 0197). Every shape may say who made it (`by`) and be
 * hidden from view (the layers' eye).
 */

export type ShapeType = "image" | "note" | "text" | "frame" | "shape" | "arrow" | "draw" | "html" | "file" | "pending";

export const SHAPE_TYPES: readonly ShapeType[] = [
  "image",
  "note",
  "text",
  "frame",
  "shape",
  "arrow",
  "draw",
  "html",
  "file",
  "pending",
];

export function isShapeType(value: unknown): value is ShapeType {
  return typeof value === "string" && (SHAPE_TYPES as readonly string[]).includes(value);
}

export type CanvasBackground = "dots" | "grid" | "plain";

export const CANVAS_BACKGROUNDS: readonly CanvasBackground[] = ["dots", "grid", "plain"];

export type NoteColor = "yellow" | "pink" | "blue" | "green" | "purple" | "gray";

export const NOTE_COLORS: readonly NoteColor[] = ["yellow", "pink", "blue", "green", "purple", "gray"];

export type CanvasShapeKind = "rect" | "ellipse" | "diamond" | "triangle" | "star";

export const CANVAS_SHAPE_KINDS: readonly CanvasShapeKind[] = ["rect", "ellipse", "diamond", "triangle", "star"];

export type PendingStatus = "queued" | "running" | "failed";

/** An arrow's end: bound to a shape (it follows it) or a free point. */
export type ArrowEnd = { shape: string } | Point;

/** How an arrow runs from end to end: a straight line, a curve, or right angles. */
export type ArrowRoute = "straight" | "curve" | "elbow";

export const ARROW_ROUTES: readonly ArrowRoute[] = ["straight", "curve", "elbow"];

export type ArrowHead = "none" | "arrow";

/** An arrow's heads; left out, the start has none and the end has one. A line is an arrow with both `none`. */
export interface ArrowHeads {
  start?: ArrowHead;
  end?: ArrowHead;
}

/** A pen stroke's tool: the pen, or the marker (drawn wide at 40% opacity). */
export type DrawTool = "pen" | "marker";

export const DRAW_TOOLS: readonly DrawTool[] = ["pen", "marker"];

/** The part of an image shown, as fractions (0 to 1) of its natural size. */
export interface ImageCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A border's width, in world units. */
export const STROKE_WIDTH = { min: 1, max: 24 } as const;
/** A rectangle's corner radius, in world units. */
export const CORNER_RADIUS = { min: 0, max: 200 } as const;

export interface CanvasTextStyle {
  size?: number;
  color?: string;
  align?: "left" | "center" | "right";
  weight?: 400 | 600 | 700;
}

/** How a generated image came to be (ADR 0197). */
export interface ImageGen {
  prompt: string;
  model: string;
  by: PeerUser;
  /** ISO time. */
  at: string;
  /** Asset ids of the images it started from (variations, edits). */
  from?: string[];
  /** The generation request's id. */
  request?: string;
}

/**
 * A shape as plain data. Common fields first (`by` and `hidden` included); the rest belong to some types only:
 * image `asset`, `nw`, `nh` (natural size), `alt`, `gen`, `crop`; note `color` and `text`; text `style` and `text`;
 * frame `name`, `fill`; shape `kind`, `fill`, `stroke`, `strokeWidth`, `radius` (drawn on rectangles) and `text` (its
 * label); arrow `from`, `to`, `label`, `dashed`, `route`, `heads`, `stroke`, `strokeWidth`; draw `points`, `stroke`,
 * `strokeWidth`, `tool`; html and file `artifact` (a Drive file id); pending `request`, `index`, `status`, `error`,
 * `prompt` (its `by` is who asked).
 */
export interface ShapeView {
  id: string;
  type: ShapeType;
  x: number;
  y: number;
  w: number;
  h: number;
  rot?: number;
  z: string;
  /** The frame it sits in. */
  parent?: string;
  locked?: boolean;
  /** Who made it (set when it is made, from the change's origin); a picture being made: who asked. */
  by?: PeerUser;
  /** Hidden from view (the layers' eye): kept, never drawn. */
  hidden?: boolean;
  text?: RichDoc;
  asset?: string;
  nw?: number;
  nh?: number;
  alt?: string;
  gen?: ImageGen;
  color?: NoteColor;
  style?: CanvasTextStyle;
  name?: string;
  fill?: string;
  kind?: CanvasShapeKind;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  from?: ArrowEnd;
  to?: ArrowEnd;
  label?: string;
  dashed?: boolean;
  route?: ArrowRoute;
  heads?: ArrowHeads;
  /** A pen stroke's points: x, y pairs in world units from its box's top-left corner. */
  points?: number[];
  tool?: DrawTool;
  crop?: ImageCrop;
  artifact?: string;
  request?: string;
  index?: number;
  status?: PendingStatus;
  error?: string;
  prompt?: string;
}

/** A new shape: its type and whatever it starts with; a box left out gets the type's size in free room. */
export type NewShape = { type: ShapeType; text?: string | RichDoc } & Partial<
  Omit<ShapeView, "id" | "type" | "z" | "text">
>;

/** A change to a shape: given keys change, `null` removes an optional one. */
export type ShapePatch = {
  [K in Exclude<keyof ShapeView, "id" | "type" | "text">]?: ShapeView[K] | null;
} & { text?: string | RichDoc };

/** What a canvas card draws: the bounds, and up to 40 of the biggest shapes (hidden ones left out). */
export interface CanvasPreviewShape {
  id: string;
  type: ShapeType;
  x: number;
  y: number;
  w: number;
  h: number;
  rot?: number;
  /** A note's color, or a frame's or shape's fill. */
  color?: string;
  /** A shape's, an arrow's or a pen stroke's line color, and its width. */
  stroke?: string;
  strokeWidth?: number;
  /** A shape's form. */
  kind?: CanvasShapeKind;
  asset?: string;
  /** An image's part shown. */
  crop?: ImageCrop;
  /** The first words of its text (a frame's name). */
  text?: string;
  /** Arrows: where they start and end, how they run and their heads (a line has none). */
  line?: { x1: number; y1: number; x2: number; y2: number };
  route?: ArrowRoute;
  heads?: ArrowHeads;
  /** Pen strokes: their points (fewer than the stroke's own, enough to draw it small) and the marker. */
  points?: number[];
  tool?: DrawTool;
}

export interface CanvasPreview {
  bg: CanvasBackground;
  bounds: Box | null;
  count: number;
  shapes: CanvasPreviewShape[];
}

export interface PlaceOptions {
  count: number;
  w: number;
  h: number;
  /** Space between the boxes, and around them (default 40). */
  gap?: number;
  /** Try to place them around this point (else to the right of what's there). */
  near?: Point;
  /** Put them in a new frame with this name. */
  frame?: { name: string };
  /** Put them inside this existing frame (growing it when there's no room left). */
  within?: string;
}

export interface Placement {
  /** The new frame's box (with `frame`). */
  frame?: Box;
  boxes: Box[];
  /** The existing frame's new box, when it has to grow to hold them (with `within`). */
  grow?: { id: string; box: Box };
}
