/**
 * The document schema (ADR 0200) as plain data: the web turns it into a ProseMirror `Schema` (adding only how nodes
 * and marks look in the DOM, and its own editing rules), and the phone and the server read and write the same
 * encoding without ProseMirror (`readDocument`/`writeDocument`). Changing a name or an attribute here changes what is
 * stored in every document.
 *
 * As in the rich text schema (ADR 0196 §2): every mark keeps ProseMirror's default `excludes` (a mark excludes itself),
 * so y-prosemirror stores it under its plain name, and no node attribute is required and none has a `validate`, since
 * y-prosemirror deletes a node it can't build and a value one app didn't expect must never fail another.
 *
 * Top-level blocks carry an `id` (a `newId`), so agents and a message's quote (`liveRef.selection.block`) can name a
 * block. Paragraphs keep the rich text's list model (`list` + `level` on the paragraph, no list nodes), so the list
 * machinery of slides and canvases works here too.
 */

/** The `Y.XmlFragment` a document's content lives in (beside `meta`). */
export const DOC_BODY = "body";

/** Headings go from 1 to 3 (a Word or Markdown heading past 3 reads as a 3). */
export const DOC_MAX_HEADING = 3;

export const DOC_MARKS = [
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "color",
  "link",
  "font",
  "size",
  "weight",
  "highlight",
  "tracking",
  "caps",
] as const;
export type DocMarkName = (typeof DOC_MARKS)[number];

/** The block nodes a document's body may hold at its top level (each with an `id`). */
export const DOC_BLOCKS = [
  "paragraph",
  "heading",
  "blockquote",
  "code_block",
  "horizontal_rule",
  "image",
  "table",
] as const;
export type DocBlockName = (typeof DOC_BLOCKS)[number];

export interface DocAttrSpec {
  default?: string | number | boolean | null;
}

/** A node as ProseMirror's `NodeSpec` takes it, without the DOM parts the web adds. */
export interface DocNodeSpec {
  content?: string;
  group?: string;
  inline?: boolean;
  atom?: boolean;
  selectable?: boolean;
  draggable?: boolean;
  code?: boolean;
  defining?: boolean;
  isolating?: boolean;
  /** Marks allowed inside ("" none). */
  marks?: string;
  /** What prosemirror-tables would call it, for an editor that uses it. */
  tableRole?: "table" | "row" | "cell";
  attrs?: Record<string, DocAttrSpec>;
}

export interface DocMarkSpec {
  attrs?: Record<string, DocAttrSpec>;
  inclusive?: boolean;
}

export interface DocSchemaSpec {
  nodes: {
    doc: DocNodeSpec;
    paragraph: DocNodeSpec;
    heading: DocNodeSpec;
    blockquote: DocNodeSpec;
    code_block: DocNodeSpec;
    horizontal_rule: DocNodeSpec;
    image: DocNodeSpec;
    table: DocNodeSpec;
    table_row: DocNodeSpec;
    table_cell: DocNodeSpec;
    text: DocNodeSpec;
    hard_break: DocNodeSpec;
  };
  marks: Record<DocMarkName, DocMarkSpec>;
}

const id = { default: null };

/**
 * The spec, in ProseMirror's order (the first block, `paragraph`, is what an empty document and a new line start as).
 * Attributes:
 * - `id` (top-level blocks): the block's id, a `newId`; null on blocks inside a quote or a table.
 * - paragraph `align` (left, center, right), `level` (indent 0..4) and `list` (bullet, ordered), as rich text;
 *   heading `level` (1..3) and `align`.
 * - code_block `language` (a word, or null).
 * - image `asset` (the id of a picture of this file, ADR 0196 §8), `alt`, `width` (a fraction of the page's width,
 *   0.1..1; null: its natural size up to the page).
 * - table `header`: true when its first row is a header row.
 */
export const DOC_SCHEMA_SPEC: DocSchemaSpec = {
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      attrs: { id, align: { default: null }, level: { default: 0 }, list: { default: null } },
    },
    heading: {
      content: "inline*",
      group: "block",
      defining: true,
      attrs: { id, align: { default: null }, level: { default: 1 } },
    },
    blockquote: { content: "block+", group: "block", defining: true, attrs: { id } },
    code_block: {
      content: "text*",
      group: "block",
      code: true,
      defining: true,
      marks: "",
      attrs: { id, language: { default: null } },
    },
    horizontal_rule: { group: "block", attrs: { id } },
    image: {
      group: "block",
      atom: true,
      draggable: true,
      attrs: { id, asset: { default: null }, alt: { default: null }, width: { default: null } },
    },
    table: {
      content: "table_row+",
      group: "block",
      isolating: true,
      tableRole: "table",
      attrs: { id, header: { default: null } },
    },
    table_row: { content: "table_cell+", tableRole: "row" },
    table_cell: { content: "paragraph+", isolating: true, tableRole: "cell" },
    text: { group: "inline" },
    hard_break: { inline: true, group: "inline", selectable: false },
  },
  marks: {
    bold: {},
    italic: {},
    underline: {},
    strike: {},
    code: {},
    color: { attrs: { color: {} } },
    link: { attrs: { href: {} }, inclusive: false },
    font: { attrs: { font: {} } },
    size: { attrs: { size: {} } },
    weight: { attrs: { weight: {} } },
    highlight: { attrs: { color: {} } },
    tracking: { attrs: { tracking: {} } },
    caps: {},
  },
};

/** Whether a node name is one of the top-level blocks. */
export function isDocBlockName(name: unknown): name is DocBlockName {
  return typeof name === "string" && (DOC_BLOCKS as readonly string[]).includes(name);
}
