import {
  isRichColor,
  isRichHref,
  RICH_MAX_LEVEL,
  RICH_SCHEMA_SPEC,
  type RichAlign,
  type RichList,
} from "@agenteschat/live/rich";
import { type DOMOutputSpec, type Mark, type Node as PMNode, Schema } from "prosemirror-model";

/**
 * The rich text schema as ProseMirror's (ADR 0196 §2): node and mark names and attributes come from
 * `RICH_SCHEMA_SPEC` of `@agenteschat/live` (what is stored, shared with the phone and the server); only how they look
 * in the page and how pasted HTML maps onto them is added here. What a document says is checked again on the way to
 * the page (a color that isn't a hex color, a link that isn't https, http or mailto never reach the DOM), since other
 * apps and agents write the same documents.
 */

const spec = RICH_SCHEMA_SPEC;

/** The CSS of a paragraph's alignment, and the data attributes its list and level draw from (rich.css). */
export function paragraphDomAttrs(attrs: {
  align?: unknown;
  level?: unknown;
  list?: unknown;
  n?: number;
}): Record<string, string> {
  const out: Record<string, string> = { class: "rt-p" };
  if (attrs.align === "left" || attrs.align === "center" || attrs.align === "right") {
    out.style = `text-align: ${attrs.align}`;
  }
  const level = typeof attrs.level === "number" ? Math.min(RICH_MAX_LEVEL, Math.max(0, Math.floor(attrs.level))) : 0;
  if (level > 0) out["data-level"] = String(level);
  if (attrs.list === "bullet" || attrs.list === "ordered") out["data-list"] = attrs.list;
  if (attrs.n !== undefined) out["data-n"] = String(attrs.n);
  return out;
}

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

/** A pasted list item: its list from the list around it, its level from how deep that list sits. */
function listItemAttrs(el: HTMLElement): { list: RichList; level: number; align: RichAlign | null } {
  let depth = 0;
  let list: RichList = "bullet";
  let first = true;
  for (let up = el.parentElement; up; up = up.parentElement) {
    if (up.tagName === "UL" || up.tagName === "OL") {
      if (first) list = up.tagName === "OL" ? "ordered" : "bullet";
      first = false;
      depth++;
    }
  }
  return { list, level: Math.min(RICH_MAX_LEVEL, Math.max(0, depth - 1)), align: alignOf(el) };
}

/** `rgb(…)` or `#…` as "#rrggbb", or null (what a pasted color span may carry). */
export function cssColorHex(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (isRichColor(text)) return text;
  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(text);
  if (!rgb) return null;
  const alpha = rgb[4];
  if (alpha !== undefined && Number.parseFloat(alpha) === 0) return null;
  const hex = [rgb[1], rgb[2], rgb[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("");
  return `#${hex}`;
}

/** Black and near black are the text's own color, not a mark: pasted text keeps the theme's color. */
function meaningfulColor(value: string): string | null {
  const hex = cssColorHex(value);
  if (!hex) return null;
  return hex === "#000000" || hex === "#000" || hex === "#ffffff" || hex === "#fff" ? null : hex;
}

export const richSchema = new Schema({
  nodes: {
    doc: { ...spec.nodes.doc },
    paragraph: {
      ...spec.nodes.paragraph,
      parseDOM: [
        { tag: "li", getAttrs: (el) => listItemAttrs(el as HTMLElement) },
        { tag: "p", getAttrs: (el) => ({ align: alignOf(el as HTMLElement) }) },
        { tag: "h1,h2,h3,h4,h5,h6,blockquote,div", getAttrs: (el) => ({ align: alignOf(el as HTMLElement) }) },
      ],
      toDOM: (node: PMNode): DOMOutputSpec => ["p", paragraphDomAttrs(node.attrs), 0],
    },
    text: { ...spec.nodes.text },
    hard_break: {
      ...spec.nodes.hard_break,
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

/**
 * The number each ordered item shows, by paragraph (null for others): items of one list count up at their level,
 * deeper items between them don't break the count, and anything else at that level or above starts it again.
 */
export function listNumbers(paragraphs: readonly { list?: unknown; level?: unknown }[]): (number | null)[] {
  const counts: number[] = [];
  return paragraphs.map((p) => {
    const level = typeof p.level === "number" ? Math.max(0, Math.floor(p.level)) : 0;
    // Everything deeper than this paragraph restarts.
    counts.length = Math.min(counts.length, level + 1);
    if (p.list !== "ordered") {
      counts.length = Math.min(counts.length, level);
      return null;
    }
    while (counts.length <= level) counts.push(0);
    counts[level] = (counts[level] ?? 0) + 1;
    return counts[level] ?? 1;
  });
}
