import type { Box } from "../canvas/geometry";
import type { RichDoc } from "../rich/types";

/**
 * Presentations (ADR 0196 §2): a deck (theme, 1920×1080 units), slides in order, each with a layout, a background,
 * speaker notes and elements placed in slide units.
 */

export type SlideLayout =
  | "title"
  | "title-body"
  | "section"
  | "two-columns"
  | "image-left"
  | "image-right"
  | "big-number"
  | "quote"
  | "title-only"
  | "blank";

export const SLIDE_LAYOUTS: readonly SlideLayout[] = [
  "title",
  "title-body",
  "section",
  "two-columns",
  "image-left",
  "image-right",
  "big-number",
  "quote",
  "title-only",
  "blank",
];

export function isSlideLayout(value: unknown): value is SlideLayout {
  return typeof value === "string" && (SLIDE_LAYOUTS as readonly string[]).includes(value);
}

export type ThemeId = "sky" | "night" | "paper" | "graphite" | "contrast" | "forest";

export const THEME_IDS: readonly ThemeId[] = ["sky", "night", "paper", "graphite", "contrast", "forest"];

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

/** A placeholder's role: how the theme styles a text box (and how agents name it: "the title", "the body"). */
export type SlideRole = "title" | "subtitle" | "body" | "body2" | "caption" | "number" | "quote";

export const SLIDE_ROLES: readonly SlideRole[] = ["title", "subtitle", "body", "body2", "caption", "number", "quote"];

export function isSlideRole(value: unknown): value is SlideRole {
  return typeof value === "string" && (SLIDE_ROLES as readonly string[]).includes(value);
}

export type ElementType = "text" | "shape" | "image" | "chart" | "table" | "line";

export const ELEMENT_TYPES: readonly ElementType[] = ["text", "shape", "image", "chart", "table", "line"];

export function isElementType(value: unknown): value is ElementType {
  return typeof value === "string" && (ELEMENT_TYPES as readonly string[]).includes(value);
}

export type ShapeKind = "rect" | "ellipse" | "triangle" | "diamond" | "arrow";

export interface ElementStyle {
  /** Font size in slide units (px of the 1920×1080 slide). */
  size?: number;
  /** "#rgb", "#rrggbb" or "#rrggbbaa". */
  color?: string;
  font?: "heading" | "body";
  weight?: 400 | 600 | 700;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  /** A hex color or "none". */
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  /** Corner radius in slide units. */
  radius?: number;
  shape?: ShapeKind;
  /** 0..1. */
  opacity?: number;
  lineEnd?: "none" | "arrow";
}

/** A chart on a slide: the same shape as the chat's chart blocks (`ChartSpec` in the client). */
export interface SlideChart {
  type: "bar" | "line" | "pie" | "number";
  title: string;
  subtitle?: string;
  unit?: string;
  labels: string[];
  series: { name: string; values: number[] }[];
  value?: number;
  delta?: string;
}

export interface SlideTable {
  rows: string[][];
  /** The first row is a header. */
  header: boolean;
}

/** A slide's background: a color, or an image of the file. */
export type SlideBackground = string | { asset: string };

/**
 * An element as plain data. `x`, `y`, `w`, `h` are slide units; a `line` goes from (x, y) to (x + w, y + h), so its
 * `w` or `h` may be negative or zero. Elements stack by `z` (then id).
 */
export interface ElementView {
  id: string;
  type: ElementType;
  x: number;
  y: number;
  w: number;
  h: number;
  rot?: number;
  z: string;
  role?: SlideRole;
  /** Text boxes and shapes (a shape's label). */
  text?: RichDoc;
  style?: ElementStyle;
  /** Images: the file's asset id (none on an empty image placeholder). */
  asset?: string;
  fit?: "cover" | "contain";
  alt?: string;
  chart?: SlideChart;
  table?: SlideTable;
}

export interface SlideView {
  id: string;
  /** 0-based position in the deck. */
  index: number;
  layout: SlideLayout;
  bg?: SlideBackground;
  hidden?: boolean;
  notes: string;
  /** Bottom to top. */
  elements: ElementView[];
}

export interface DeckView {
  theme: ThemeId;
  w: number;
  h: number;
  slides: SlideView[];
}

/** What a new element may start with (missing parts get defaults; text as light Markdown or rich text). */
export interface NewElement {
  type: ElementType;
  box?: Box;
  rot?: number;
  role?: SlideRole;
  text?: string | RichDoc;
  style?: ElementStyle;
  asset?: string;
  fit?: "cover" | "contain";
  alt?: string;
  chart?: SlideChart;
  table?: SlideTable;
}

/** A change to an element: given keys change, `null` removes an optional one; `style` merges key by key. */
export interface ElementPatch {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rot?: number | null;
  z?: string;
  role?: SlideRole | null;
  text?: string | RichDoc;
  style?: { [K in keyof ElementStyle]?: ElementStyle[K] | null } | null;
  asset?: string | null;
  fit?: "cover" | "contain" | null;
  alt?: string | null;
  chart?: SlideChart | null;
  table?: SlideTable | null;
}

export interface AddSlideOptions {
  /** 0-based position (the end when left out). */
  at?: number;
  layout?: SlideLayout;
  /** The title (or the big number, or the quote), light Markdown. */
  title?: string;
  /** The body (or the subtitle, or the caption), light Markdown. */
  body?: string;
  notes?: string;
  image?: { asset: string };
}

export interface SlidesPreview {
  theme: ThemeId;
  count: number;
  first: SlideView | null;
}

/** An element of an office deck (ADR 0198), in the deck's own units (`DeckData.w`×`h`). */
export interface DeckElementData {
  type: "text" | "shape" | "image" | "table" | "line" | "chart";
  x: number;
  y: number;
  w: number;
  h: number;
  rot?: number;
  role?: SlideRole;
  text?: RichDoc;
  style?: ElementStyle;
  /** Images: a name in `DeckData.media`. */
  media?: string;
  fit?: "cover" | "contain";
  alt?: string;
  table?: SlideTable;
  chart?: SlideChart;
}

export interface DeckSlideData {
  layout?: SlideLayout;
  /** A color, or a picture by its name in `DeckData.media`. */
  bg?: string | { media: string };
  notes?: string;
  hidden?: boolean;
  /** Bottom to top. */
  elements: DeckElementData[];
}

/**
 * A picture of a deck: its bytes or address as an office reader found it, and once stored as an asset of a live
 * file, the asset's id (what `slidesFromData` needs).
 */
export interface DeckMedia {
  type: string;
  bytes?: Uint8Array;
  url?: string;
  asset?: string;
}

/** A deck as plain data: what the office readers produce and the writers consume (ADR 0198). */
export interface DeckData {
  w: number;
  h: number;
  theme?: ThemeId;
  slides: DeckSlideData[];
  media: Record<string, DeckMedia>;
}
