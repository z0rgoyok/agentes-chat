import { DOC_MAX_HEADING, DOC_SCHEMA_SPEC } from "@agenteschat/live/document";
import { isRichColor, isRichHref, RICH_MAX_LEVEL, type RichAlign, type RichList } from "@agenteschat/live/rich";
import {
  type DOMOutputSpec,
  type Mark,
  type MarkType,
  type NodeType,
  type Node as PMNode,
  Schema,
  type TagParseRule,
} from "prosemirror-model";
import { cssColorHex } from "../rich/schema";

/**
 * The document schema as ProseMirror's (ADR 0200): node and mark names and attributes come from `DOC_SCHEMA_SPEC` of
 * `@agenteschat/live` (what is stored, read and written the same way by the phone and the server); only how they
 * look on the page and how pasted HTML maps onto them is added here. A block's `id` never goes to the page nor comes
 * back from a paste: pasted blocks are new blocks and get their own (`blockIds`). What a document says is checked again
 * on the way to the page (a color that isn't a hex color, a link that isn't https, http or mailto never reach the DOM),
 * since agents and other apps write the same documents.
 */

const spec = DOC_SCHEMA_SPEC;

const ALIGN_OF: Record<string, RichAlign> = {
  left: "left",
  center: "center",
  right: "right",
  start: "left",
  end: "right",
};

function alignOf(el: HTMLElement): RichAlign | null {
  return ALIGN_OF[el.style.textAlign] ?? null;
}

const levelOf = (value: unknown) =>
  typeof value === "number" ? Math.min(RICH_MAX_LEVEL, Math.max(0, Math.floor(value))) : 0;

/** A paragraph's alignment as CSS, its list and level as the data attributes `document.css` draws them from. */
export function docParagraphAttrs(attrs: { align?: unknown; level?: unknown; list?: unknown }): Record<string, string> {
  const out: Record<string, string> = {};
  if (attrs.align === "left" || attrs.align === "center" || attrs.align === "right") {
    out.style = `text-align: ${attrs.align}`;
  }
  const level = levelOf(attrs.level);
  if (level > 0) out["data-level"] = String(level);
  if (attrs.list === "bullet" || attrs.list === "ordered") out["data-list"] = attrs.list;
  return out;
}

/** A pasted list item: its list from the list around it, its level from how deep that list sits. */
function listItemAttrs(el: HTMLElement): { list: RichList; level: number; align: RichAlign | null } {
  let depth = 0;
  let list: RichList = "bullet";
  let first = true;
  for (let up: HTMLElement | null = el; up; up = up.parentElement) {
    if (up.tagName === "UL" || up.tagName === "OL") {
      if (first) list = up.tagName === "OL" ? "ordered" : "bullet";
      first = false;
      depth++;
    }
  }
  return { list, level: Math.min(RICH_MAX_LEVEL, Math.max(0, depth - 1)), align: alignOf(el) };
}

/**
 * An element holds blocks of its own (a pasted `<li><p>…</p></li>`): it isn't one paragraph. A list inside an item
 * doesn't count: ProseMirror closes the item's paragraph there and the inner items follow at their own level.
 */
const holdsBlocks = (el: HTMLElement) =>
  [...el.children].some((c) => /^(P|DIV|H[1-6]|BLOCKQUOTE|PRE|TABLE|FIGURE)$/.test(c.tagName));

/** Black, white and their near kin are the text's own color, not a mark: pasted text keeps the theme's color. */
function meaningfulColor(value: string): string | null {
  const hex = cssColorHex(value);
  if (!hex) return null;
  return hex === "#000000" || hex === "#ffffff" ? null : hex;
}

/** A heading's level on the page: the document's title is the page's `h1`, so a level 1 heading is an `h2`. */
export const headingTag = (level: unknown) =>
  `h${Math.min(DOC_MAX_HEADING, Math.max(1, typeof level === "number" ? Math.floor(level) : 1)) + 1}`;

const headingRules: TagParseRule[] = [
  // Copied from a document: its own level, kept.
  {
    tag: "h2[data-level], h3[data-level], h4[data-level]",
    priority: 60,
    getAttrs: (el) => {
      const level = Number((el as HTMLElement).dataset.level);
      return level >= 1 && level <= DOC_MAX_HEADING ? { level, align: alignOf(el as HTMLElement) } : false;
    },
  },
  ...[1, 2, 3, 4, 5, 6].map(
    (n): TagParseRule => ({
      tag: `h${n}`,
      getAttrs: (el) => ({ level: Math.min(DOC_MAX_HEADING, n), align: alignOf(el as HTMLElement) }),
    }),
  ),
];

/** A code block's language, from what the page or the pasted HTML says ("language-ts", `data-language`). */
function languageOf(el: HTMLElement): string | null {
  const code = el.querySelector("code");
  const named =
    el.dataset.language ?? code?.dataset.language ?? /(?:^|\s)language-([\w+#.-]+)/.exec(code?.className ?? "")?.[1];
  return named && /^[a-z0-9_+#.-]{1,40}$/i.test(named) ? named : null;
}

/** A picture's width as a fraction of the page (0.1..1), or null for its natural size. */
export function widthFraction(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(1, Math.max(0.1, n)) : null;
}

export const docSchema = new Schema({
  nodes: {
    doc: { ...spec.nodes.doc },
    paragraph: {
      ...spec.nodes.paragraph,
      parseDOM: [
        { tag: "li", getAttrs: (el) => (holdsBlocks(el as HTMLElement) ? false : listItemAttrs(el as HTMLElement)) },
        {
          tag: "li > p, li > div",
          priority: 60,
          getAttrs: (el) => listItemAttrs((el as HTMLElement).parentElement ?? (el as HTMLElement)),
        },
        { tag: "p", getAttrs: (el) => ({ align: alignOf(el as HTMLElement) }) },
        {
          tag: "div",
          getAttrs: (el) => (holdsBlocks(el as HTMLElement) ? false : { align: alignOf(el as HTMLElement) }),
        },
      ],
      toDOM: (node: PMNode): DOMOutputSpec => ["p", docParagraphAttrs(node.attrs), 0],
    },
    heading: {
      ...spec.nodes.heading,
      parseDOM: headingRules,
      toDOM: (node: PMNode): DOMOutputSpec => {
        const attrs: Record<string, string> = { "data-level": String(node.attrs.level ?? 1) };
        const align = docParagraphAttrs({ align: node.attrs.align }).style;
        if (align) attrs.style = align;
        return [headingTag(node.attrs.level), attrs, 0];
      },
    },
    blockquote: {
      ...spec.nodes.blockquote,
      parseDOM: [{ tag: "blockquote" }],
      toDOM: (): DOMOutputSpec => ["blockquote", 0],
    },
    code_block: {
      ...spec.nodes.code_block,
      parseDOM: [
        { tag: "pre", preserveWhitespace: "full", getAttrs: (el) => ({ language: languageOf(el as HTMLElement) }) },
      ],
      toDOM: (node: PMNode): DOMOutputSpec => {
        const language = typeof node.attrs.language === "string" ? node.attrs.language : null;
        return [
          "pre",
          { class: "md__code lf-doc__code", ...(language ? { "data-language": language } : {}) },
          ["code", 0],
        ];
      },
    },
    horizontal_rule: {
      ...spec.nodes.horizontal_rule,
      parseDOM: [{ tag: "hr" }],
      toDOM: (): DOMOutputSpec => ["hr"],
    },
    image: {
      ...spec.nodes.image,
      // Only a picture copied from a document: its picture is one of a file's (`data-asset`); a picture from a web
      // page has no place to live here (an image file pasted or dropped is uploaded instead).
      parseDOM: [
        {
          tag: "img[data-asset]",
          getAttrs: (el) => {
            const img = el as HTMLElement;
            const asset = img.dataset.asset;
            if (!asset || !/^[0-9a-z_-]{1,64}$/i.test(asset)) return false;
            return { asset, alt: img.getAttribute("alt") || null, width: widthFraction(img.dataset.width) };
          },
        },
      ],
      // What a copy carries (the page draws a picture with its own view, `ImageView`).
      toDOM: (node: PMNode): DOMOutputSpec => [
        "img",
        {
          "data-asset": String(node.attrs.asset ?? ""),
          ...(node.attrs.alt ? { alt: String(node.attrs.alt) } : {}),
          ...(widthFraction(node.attrs.width) ? { "data-width": String(widthFraction(node.attrs.width)) } : {}),
        },
      ],
    },
    table: {
      ...spec.nodes.table,
      parseDOM: [
        {
          tag: "table",
          getAttrs: (el) => {
            const table = el as HTMLTableElement;
            const first = table.rows[0];
            const header = !!table.tHead || (!!first && [...first.cells].every((c) => c.tagName === "TH"));
            return { header: header || null };
          },
        },
      ],
      toDOM: (node: PMNode): DOMOutputSpec => [
        "div",
        { class: "md__table lf-doc__table" },
        ["table", node.attrs.header ? { "data-header": "true" } : {}, ["tbody", 0]],
      ],
    },
    table_row: {
      ...spec.nodes.table_row,
      parseDOM: [{ tag: "tr" }],
      toDOM: (): DOMOutputSpec => ["tr", 0],
    },
    table_cell: {
      ...spec.nodes.table_cell,
      parseDOM: [{ tag: "td" }, { tag: "th" }],
      toDOM: (): DOMOutputSpec => ["td", 0],
    },
    text: { ...spec.nodes.text },
    hard_break: {
      ...spec.nodes.hard_break,
      // A line break becomes a new line in code and back (ProseMirror's `setBlockType`).
      linebreakReplacement: true,
      parseDOM: [{ tag: "br" }],
      toDOM: (): DOMOutputSpec => ["br"],
    },
  },
  marks: {
    bold: {
      ...spec.marks.bold,
      parseDOM: [
        { tag: "strong" },
        // Google Docs wraps everything in <b style="font-weight:normal">.
        { tag: "b", getAttrs: (el) => (el as HTMLElement).style.fontWeight !== "normal" && null },
        { style: "font-weight", getAttrs: (value) => /^(bold(er)?|[6-9]\d\d)$/.test(value) && null },
      ],
      toDOM: (): DOMOutputSpec => ["strong", 0],
    },
    italic: {
      ...spec.marks.italic,
      parseDOM: [{ tag: "em" }, { tag: "i" }, { style: "font-style=italic" }],
      toDOM: (): DOMOutputSpec => ["em", 0],
    },
    underline: {
      ...spec.marks.underline,
      parseDOM: [{ tag: "u" }, { style: "text-decoration", getAttrs: (v) => v.includes("underline") && null }],
      toDOM: (): DOMOutputSpec => ["u", 0],
    },
    strike: {
      ...spec.marks.strike,
      parseDOM: [
        { tag: "s" },
        { tag: "del" },
        { tag: "strike" },
        { style: "text-decoration", getAttrs: (v) => v.includes("line-through") && null },
      ],
      toDOM: (): DOMOutputSpec => ["s", 0],
    },
    code: {
      ...spec.marks.code,
      parseDOM: [{ tag: "code" }],
      toDOM: (): DOMOutputSpec => ["code", 0],
    },
    color: {
      ...spec.marks.color,
      parseDOM: [
        {
          style: "color",
          getAttrs: (value) => {
            const color = meaningfulColor(value);
            return color ? { color } : false;
          },
        },
      ],
      toDOM: (mark: Mark): DOMOutputSpec =>
        isRichColor(mark.attrs.color) ? ["span", { style: `color: ${mark.attrs.color}` }, 0] : ["span", 0],
    },
    link: {
      ...spec.marks.link,
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (el) => {
            const href = (el as HTMLElement).getAttribute("href");
            return isRichHref(href) ? { href } : false;
          },
        },
      ],
      toDOM: (mark: Mark): DOMOutputSpec =>
        isRichHref(mark.attrs.href)
          ? ["a", { href: mark.attrs.href, rel: "noopener noreferrer nofollow", target: "_blank" }, 0]
          : ["span", 0],
    },
  },
});

/** The schema's node types, typed (every one exists: they come from `DOC_SCHEMA_SPEC`). */
export const N = docSchema.nodes as Record<keyof typeof spec.nodes, NodeType>;
/** The schema's mark types. */
export const M = docSchema.marks as Record<keyof typeof spec.marks, MarkType>;
