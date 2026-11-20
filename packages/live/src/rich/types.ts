/**
 * Rich text in slides and on the canvas (ADR 0196 §2), as plain data: paragraphs with alignment, a level and a list
 * kind, holding runs of text with their marks. A "\n" inside a run's text is a line break within the paragraph.
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
}

export interface RichParagraph {
  align?: RichAlign;
  /** Indent level, 0..4 (`RICH_MAX_LEVEL`). */
  level?: number;
  list?: RichList;
  runs: RichRun[];
}

export type RichDoc = RichParagraph[];
