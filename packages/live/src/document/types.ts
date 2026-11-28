import type { FileFonts } from "../fonts";
import type { RichAlign, RichList, RichRun } from "../rich/types";

/**
 * Documents (ADR 0200) as plain data: the blocks of the body in order, each top-level block with its id. What the
 * server, the agents' tools, the phone and Markdown read and write; the web edits the same content in ProseMirror
 * (`DOC_SCHEMA_SPEC`).
 */

/** A run of text with its marks. A "\n" inside a run's text is a line break (`hard_break`). */
export interface DocRun extends RichRun {
  code?: true;
}

export interface DocParagraph {
  type: "paragraph";
  id?: string;
  align?: RichAlign;
  /** A list item: its kind, and its depth in `level` (0..4). */
  list?: RichList;
  /** Indent level, 0..4. */
  level?: number;
  runs: DocRun[];
}

export type DocHeadingLevel = 1 | 2 | 3;

export interface DocHeading {
  type: "heading";
  id?: string;
  level: DocHeadingLevel;
  align?: RichAlign;
  runs: DocRun[];
}

export interface DocQuote {
  type: "blockquote";
  id?: string;
  /** What is quoted (blocks inside carry no ids). */
  blocks: DocBlock[];
}

export interface DocCode {
  type: "code_block";
  id?: string;
  /** A word naming the language ("ts", "sql"), or none. */
  language?: string;
  /** The code, lines joined by "\n", no marks. */
  text: string;
}

export interface DocRule {
  type: "horizontal_rule";
  id?: string;
}

export interface DocImage {
  type: "image";
  id?: string;
  /** A picture of this file (`live_assets`, ADR 0196 §8). */
  asset: string;
  alt?: string;
  /** A fraction of the page's width, 0.1..1; none: its natural size up to the page's width. */
  width?: number;
}

/** A table's cell: its paragraphs (at least one). */
export interface DocCell {
  blocks: DocParagraph[];
}

export interface DocTable {
  type: "table";
  id?: string;
  /** Its first row is a header row. */
  header?: true;
  rows: DocCell[][];
}

export type DocBlock = DocParagraph | DocHeading | DocQuote | DocCode | DocRule | DocImage | DocTable;

/** Where a document came from, when it wasn't made here (an uploaded `.docx` opened to edit, ADR 0198). */
export interface DocumentSource {
  /** The uploaded file's name ("Plano.docx"). */
  name: string;
  /** The upload's artifact id. */
  file?: string;
}

/**
 * What a document's card and the Drive draw (ADR 0196 §7): its first blocks (clipped: a few hundred words, the first
 * rows of a table), how many blocks and characters it holds, and where it came from. Titles are the file's own.
 */
export interface DocumentPreview {
  blocks: DocBlock[];
  /** Top-level blocks in the whole document. */
  count: number;
  /** Characters of text in the whole document. */
  chars: number;
  source?: DocumentSource;
  /** The document's own fonts for headings and body (ADR 0220 §3). */
  fonts?: FileFonts;
}
