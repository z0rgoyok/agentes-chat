/**
 * The rich text schema (ADR 0196 §2) as plain data: the web turns it into a ProseMirror `Schema` (adding only how
 * nodes and marks look in the DOM), and the phone and the server read and write the same encoding without
 * ProseMirror (`readRich`/`writeRich`). Changing a name or an attribute here changes what is stored in every file.
 *
 * Every mark keeps ProseMirror's default `excludes` (a mark excludes itself), so y-prosemirror stores it under its
 * plain name (`bold`, `link`), never with the hash suffix it gives marks that may overlap. No attribute has a
 * `validate`: y-prosemirror deletes a node it can't build, so a value one app didn't expect must never fail another.
 */

export const RICH_MAX_LEVEL = 4;

export const RICH_MARKS = [
  "bold",
  "italic",
  "underline",
  "strike",
  "color",
  "link",
  "font",
  "size",
  "weight",
  "highlight",
  "tracking",
  "caps",
] as const;
export type RichMarkName = (typeof RICH_MARKS)[number];

export interface RichAttrSpec {
  default?: string | number | null;
}

export interface RichNodeSpec {
  content?: string;
  group?: string;
  inline?: boolean;
  selectable?: boolean;
  attrs?: Record<string, RichAttrSpec>;
}

export interface RichMarkSpec {
  attrs?: Record<string, RichAttrSpec>;
  inclusive?: boolean;
}

export interface RichSchemaSpec {
  nodes: {
    doc: RichNodeSpec;
    paragraph: RichNodeSpec;
    text: RichNodeSpec;
    hard_break: RichNodeSpec;
  };
  marks: Record<RichMarkName, RichMarkSpec>;
}

export const RICH_SCHEMA_SPEC: RichSchemaSpec = {
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: {
      content: "inline*",
      group: "block",
      attrs: {
        align: { default: null },
        level: { default: 0 },
        list: { default: null },
        lineHeight: { default: null },
        spaceAfter: { default: null },
      },
    },
    text: { group: "inline" },
    hard_break: { inline: true, group: "inline", selectable: false },
  },
  marks: {
    bold: {},
    italic: {},
    underline: {},
    strike: {},
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
