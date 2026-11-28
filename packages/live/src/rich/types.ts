import type { FontRef, FontWeight } from "../fonts";

/**
 * Rich text in slides and on the canvas (ADR 0196 §2), as plain data: paragraphs with alignment, a level and a list
 * kind, holding runs of text with their marks. A "\n" inside a run's text is a line break within the paragraph.
 * Fonts, sizes, weights, highlights, letter spacing and capitals per run, and paragraph spacing, are ADR 0220 §3.
 */

export type RichAlign = "left" | "center" | "right";
export type RichList = "bullet" | "ordered";

export interface RichRun {
  text: string;
  bold?: true;
  italic?: true;
  underline?: true;
  strike?: true;
  /** "#rgb" or "#rrggbb". */
  color?: string;
  /** An https, http or mailto address. */
  link?: string;
  /** The words' font: a catalog id, `asset:<id>` or a theme role (`FontRef`). */
  font?: FontRef;
  /** The words' size, in the units of the file's kind (slide units, canvas units, a document's pixels). */
  size?: number;
  /** 100 to 900; over `bold` when both are there. */
  weight?: FontWeight;
  /** A color behind the words: "#rgb" or "#rrggbb". */
  highlight?: string;
  /** Letter spacing in thousandths of the size (-200 to 1000), as office files keep it. */
  tracking?: number;
  /** Drawn in capitals; the words keep their own case. */
  caps?: true;
}

export interface RichParagraph {
  align?: RichAlign;
  /** Indent level, 0..4 (`RICH_MAX_LEVEL`). */
  level?: number;
  list?: RichList;
  /** Line height as a multiple of the size (0.8 to 3); the look's own when left out. */
  lineHeight?: number;
  /** Room after the paragraph, in the units of the file's kind (0 to 1000). */
  spaceAfter?: number;
  runs: RichRun[];
}

export type RichDoc = RichParagraph[];
