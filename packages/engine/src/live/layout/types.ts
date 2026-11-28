import type { Dash, FontRef, FontWeight, Gradient, LiveGroup, RichDoc, Shadow } from "@agenteschat/live";

/**
 * What `add_html` lays out (ADR 0220 §4), before it becomes a kind's own pieces: boxes, texts, pictures, lines and
 * tables at absolute positions from the layout's top-left corner, each in the innermost group that holds it.
 */

export interface PieceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How a text is drawn as a whole; its runs carry marks only where they differ. */
export interface PieceTextStyle {
  font?: FontRef;
  size: number;
  weight: FontWeight;
  color?: string;
  align: "left" | "center" | "right";
  valign: "top" | "middle" | "bottom";
  /** A multiple of the size. */
  lineHeight: number;
  tracking?: number;
  caps?: boolean;
}

interface PieceBase {
  box: PieceBox;
  group?: string;
}

/** A box with a look; `text` when its only content is one text (a badge, a card with a single paragraph). */
export interface BoxPiece extends PieceBase {
  kind: "box";
  fill?: string;
  gradient?: Gradient;
  stroke?: string;
  strokeWidth?: number;
  dash?: Dash;
  radius?: number;
  shadow?: Shadow;
  opacity?: number;
  text?: RichDoc;
  textStyle?: PieceTextStyle;
  padding?: number;
}

export interface TextPiece extends PieceBase {
  kind: "text";
  text: RichDoc;
  style: PieceTextStyle;
}

export interface ImagePiece extends PieceBase {
  kind: "image";
  /** The key of a picture `parseHtml` asked for (`PictureRequest`). */
  picture: string;
  fit: "cover" | "contain";
  alt?: string;
  radius?: number;
  shadow?: Shadow;
  opacity?: number;
}

/** A line from (x, y) to (x + w, y + h). */
export interface LinePiece extends PieceBase {
  kind: "line";
  stroke: string;
  width: number;
  dash?: Dash;
}

export interface TablePiece extends PieceBase {
  kind: "table";
  rows: string[][];
  header: boolean;
}

export type Piece = BoxPiece | TextPiece | ImagePiece | LinePiece | TablePiece;

/** A picture the HTML names: an address or id (`<img src>`), or an inline `<svg>`. */
export type PictureRequest =
  | { key: string; kind: "src"; src: string; alt?: string }
  | { key: string; kind: "svg"; svg: string };

/** A picture resolved by the caller: its natural size (to keep its proportions). */
export interface PictureSize {
  w: number;
  h: number;
}

/** An arrow the markup asks for between two of its pieces (`data-arrow-to`), by their place in `pieces`. */
export interface LayoutArrow {
  from: number;
  to: number;
  label?: string;
  color?: string;
}

export interface LayoutResult {
  pieces: Piece[];
  groups: LiveGroup[];
  /** Arrows between pieces: native connectors on a canvas, lines on a slide. */
  arrows: LayoutArrow[];
  /** The laid-out size. */
  width: number;
  height: number;
  /** What was left out or changed, a few words each, for the agent. */
  notes: string[];
}
