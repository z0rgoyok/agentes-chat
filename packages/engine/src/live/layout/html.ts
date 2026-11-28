import {
  catalogFontNamed,
  FONT_CATALOG,
  type FontRef,
  type FontWeight,
  type LiveGroup,
  newId,
  type RichDoc,
  type RichParagraph,
  type RichRun,
} from "@agenteschat/live";
import { DOMParser, type Element as XmlElement, type Node as XmlNode } from "@xmldom/xmldom";
import Yoga, {
  Align,
  BoxSizing,
  Direction,
  Edge,
  FlexDirection,
  Gutter,
  Justify,
  MeasureMode,
  PositionType,
  Wrap,
  type Node as YogaNode,
} from "yoga-layout";
import { ValidationError } from "../../errors";
import type { Face, TextMeasurer } from "../../fonts/library";
import {
  type Declarations,
  expandAll,
  type Length,
  type MatchTarget,
  matches,
  opaque,
  parseColor,
  parseDeclarations,
  parseFamilies,
  parseGradient,
  parseLength,
  parseShadow,
  parseStyleSheet,
  parseTracks,
  parseWeight,
  px,
  type RawDeclarations,
  type Rule,
  resolveVars,
  words,
} from "./css";
import type {
  BoxPiece,
  ImagePiece,
  LayoutResult,
  PictureRequest,
  PictureSize,
  Piece,
  PieceBox,
  PieceTextStyle,
  TextPiece,
} from "./types";

/**
 * `add_html` (ADR 0220 §4): a fragment of HTML and CSS laid out by the server and turned into native pieces, never a
 * picture. `parseHtml` reads the markup and the style rules and says which pictures it names; the caller resolves
 * them (stores them as the file's assets, learns their sizes); `layoutHtml` computes the cascade, lays the boxes out
 * with Yoga (CSS flexbox and block flow) and the fonts' real widths, and returns boxes, texts, pictures, lines and
 * tables at absolute positions, grouped the way the markup nests.
 */

export const HTML_LIMITS = { chars: 200_000, elements: 3000, depth: 40, pictures: 60 } as const;

const BLOCK_TAGS = new Set([
  "div",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "nav",
  "aside",
  "ul",
  "ol",
  "li",
  "blockquote",
  "figure",
  "figcaption",
  "hr",
  "pre",
  "form",
  "dl",
  "dt",
  "dd",
  "table",
  "address",
  "fieldset",
  "body",
  "html",
]);
const SKIPPED_TAGS = new Set([
  "script",
  "style",
  "head",
  "title",
  "meta",
  "link",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "video",
  "audio",
  "canvas",
  "input",
  "textarea",
  "select",
  "button",
]);

/** The UA style a browser gives each tag, the parts that change a layout. */
const UA: Record<string, string> = {
  body: "margin:8px",
  h1: "font-size:2em;font-weight:700;margin:0.67em 0",
  h2: "font-size:1.5em;font-weight:700;margin:0.83em 0",
  h3: "font-size:1.17em;font-weight:700;margin:1em 0",
  h4: "font-weight:700;margin:1.33em 0",
  h5: "font-size:0.83em;font-weight:700;margin:1.67em 0",
  h6: "font-size:0.67em;font-weight:700;margin:2.33em 0",
  p: "margin:1em 0",
  ul: "margin:1em 0;padding-left:40px",
  ol: "margin:1em 0;padding-left:40px",
  blockquote: "margin:1em 40px",
  figure: "margin:1em 40px",
  hr: "margin:0.5em 0;border-top:1px solid #808080",
  pre: "font-family:monospace;white-space:pre;margin:1em 0",
  code: "font-family:monospace",
  kbd: "font-family:monospace",
  samp: "font-family:monospace",
  b: "font-weight:bolder",
  strong: "font-weight:bolder",
  th: "font-weight:700",
  i: "font-style:italic",
  em: "font-style:italic",
  cite: "font-style:italic",
  u: "text-decoration:underline",
  ins: "text-decoration:underline",
  s: "text-decoration:line-through",
  strike: "text-decoration:line-through",
  del: "text-decoration:line-through",
  small: "font-size:0.83em",
  mark: "background-color:#ffff00",
  dd: "margin-left:40px",
};
const UA_DECLS = new Map<string, RawDeclarations>(
  Object.entries(UA).map(([tag, css]) => [tag, parseDeclarations(css)]),
);

// ── Parsing ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface HtmlElement extends MatchTarget {
  tag: string;
  attrs: Map<string, string>;
  parent: HtmlElement | null;
  children: (HtmlElement | string)[];
  inline: RawDeclarations;
  /** An `<img>` or `<svg>`: the picture it names. */
  picture?: string;
  first: boolean;
  last: boolean;
  /** Generated content (`::before`, `::after`): its declarations are its rule's, it matches no selector itself. */
  pseudo?: boolean;
}

export interface ParsedHtml {
  root: HtmlElement;
  rules: Rule[];
  /** `@font-face` names to the font files they load. */
  fontFaces: Map<string, string>;
  pictures: PictureRequest[];
  notes: string[];
}

const SVG_NS = "http://www.w3.org/2000/svg";

function escapeXml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}

/** An inline `<svg>` written out as an SVG document, for the sanitizer (ADR 0196 §8) to rebuild. */
function svgSource(el: XmlElement): string {
  const out: string[] = [];
  const walk = (node: XmlNode, root: boolean) => {
    if (node.nodeType === 3) {
      out.push(escapeXml(node.nodeValue ?? ""));
      return;
    }
    if (node.nodeType !== 1) return;
    const e = node as XmlElement;
    const name = (e.localName ?? e.nodeName).toString();
    out.push(`<${name}`);
    if (root) out.push(` xmlns="${SVG_NS}"`);
    for (let i = 0; i < e.attributes.length; i++) {
      const a = e.attributes.item(i);
      if (!a || a.name === "xmlns" || a.name.startsWith("xmlns:")) continue;
      out.push(` ${a.name}="${escapeXml(a.value)}"`);
    }
    out.push(">");
    for (let c = e.firstChild; c; c = c.nextSibling) walk(c, false);
    out.push(`</${name}>`);
  };
  walk(el, true);
  return out.join("");
}

/**
 * Reads the markup: elements with their classes, ids and inline styles, the text between them, the `<style>` rules,
 * and the pictures (`<img>`, inline `<svg>`). Refuses what is too big; skips scripts, forms and media.
 */
export function parseHtml(html: string): ParsedHtml {
  if (html.length > HTML_LIMITS.chars) {
    throw new ValidationError(
      `The HTML is over ${HTML_LIMITS.chars / 1000}k characters: split it`,
      "live.html_too_large",
    );
  }
  const notes: string[] = [];
  const styles: string[] = [];
  const pictures: PictureRequest[] = [];
  let doc: ReturnType<DOMParser["parseFromString"]>;
  // A whole page is taken as a fragment: its doctype and XML declaration say nothing here.
  const body = html.replace(/<!doctype[^>]{0,200}>/gi, "").replace(/<\?xml[^>]{0,200}\?>/gi, "");
  try {
    doc = new DOMParser({ onError: () => {} }).parseFromString(`<div data-agentes-root="">${body}</div>`, "text/html");
  } catch {
    throw new ValidationError("The HTML couldn't be read", "live.html_invalid");
  }
  // Style sheets wherever they are (a page keeps them in its head, which draws nothing).
  const sheets = doc.getElementsByTagName("style");
  for (let i = 0; i < sheets.length; i++) styles.push(sheets.item(i)?.textContent ?? "");
  let count = 0;
  const skipped = new Set<string>();
  const convert = (node: XmlElement, parent: HtmlElement | null, depth: number): HtmlElement | null => {
    const tag = (node.localName ?? node.nodeName).toString().toLowerCase();
    if (tag === "style") return null;
    if (tag === "head") return null;
    if (SKIPPED_TAGS.has(tag)) {
      skipped.add(tag);
      return null;
    }
    if (++count > HTML_LIMITS.elements) {
      throw new ValidationError(`The HTML has over ${HTML_LIMITS.elements} elements: split it`, "live.html_too_large");
    }
    if (depth > HTML_LIMITS.depth) throw new ValidationError("The HTML nests too deep", "live.html_too_large");
    const attrs = new Map<string, string>();
    for (let i = 0; i < node.attributes.length; i++) {
      const a = node.attributes.item(i);
      if (a) attrs.set(a.name.toLowerCase(), a.value);
    }
    const el: HtmlElement = {
      tag,
      id: attrs.get("id") ?? null,
      classes: (attrs.get("class") ?? "").split(/\s+/).filter(Boolean),
      hasAttr: (name) => attrs.has(name),
      attrs,
      parent,
      children: [],
      inline: parseDeclarations(attrs.get("style") ?? ""),
      first: false,
      last: false,
    };
    if (tag === "svg" || tag === "img") {
      if (pictures.length >= HTML_LIMITS.pictures) {
        skipped.add(`pictures past ${HTML_LIMITS.pictures}`);
        return null;
      }
      const key = `p${pictures.length}`;
      if (tag === "svg") pictures.push({ key, kind: "svg", svg: svgSource(node) });
      else {
        const src = (attrs.get("src") ?? "").trim();
        if (!src) return null;
        pictures.push({ key, kind: "src", src, ...(attrs.get("alt") ? { alt: attrs.get("alt") } : {}) });
      }
      el.picture = key;
      return el;
    }
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3 || c.nodeType === 4) el.children.push(c.nodeValue ?? "");
      else if (c.nodeType === 1) {
        const child = convert(c as XmlElement, el, depth + 1);
        if (child) el.children.push(child);
      }
    }
    const elements = el.children.filter((c): c is HtmlElement => typeof c !== "string");
    if (elements[0]) elements[0].first = true;
    const lastEl = elements[elements.length - 1];
    if (lastEl) lastEl.last = true;
    return el;
  };
  const top = doc.documentElement as XmlElement | null;
  // In HTML mode the parser may wrap our root in html/body: find it.
  const find = (node: XmlNode | null): XmlElement | null => {
    for (let n = node; n; n = n.nextSibling) {
      if (n.nodeType === 1) {
        const e = n as XmlElement;
        if (e.getAttribute?.("data-agentes-root") !== null && e.hasAttribute?.("data-agentes-root")) return e;
        const inner = find(e.firstChild);
        if (inner) return inner;
      }
    }
    return null;
  };
  const rootNode = top ? find(top) : null;
  if (!rootNode) throw new ValidationError("The HTML couldn't be read", "live.html_invalid");
  const root = convert(rootNode, null, 0);
  if (!root) throw new ValidationError("The HTML couldn't be read", "live.html_invalid");
  root.first = true;
  root.last = true;
  const sheet = parseStyleSheet(styles.join("\n"));
  addGeneratedContent(root, sheet.rules);
  if (skipped.size) notes.push(`left out: ${[...skipped].join(", ")}`);
  if (sheet.skipped.length) notes.push(`CSS rules not taken: ${[...new Set(sheet.skipped)].slice(0, 8).join(", ")}`);
  return { root, rules: sheet.rules.filter((r) => !r.pseudo), fontFaces: sheet.fontFaces, pictures, notes };
}

/** The text a `content` value gives (quoted strings, joined), or null for none (`none`, `normal`, no strings). */
function contentText(value: string | undefined): string | null {
  if (!value || value === "none" || value === "normal") return null;
  const parts = [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)].map((m) =>
    (m[1] ?? m[2] ?? "").replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    ),
  );
  return parts.length ? parts.join("") : null;
}

/**
 * `::before` and `::after` as the elements they draw: a child first or last, with the rule's declarations (most
 * specific last) and its `content`'s text, laid out and turned into pieces like any element.
 */
function addGeneratedContent(root: HtmlElement, rules: readonly Rule[]): void {
  const pseudo = rules.filter((r) => r.pseudo);
  if (!pseudo.length) return;
  const walk = (el: HtmlElement) => {
    for (const c of el.children) if (typeof c !== "string") walk(c);
    if (el.picture || el.pseudo) return;
    for (const where of ["before", "after"] as const) {
      const matched = pseudo
        .filter((r) => r.pseudo === where && matches(el, r.selector))
        .sort((a, b) => a.specificity - b.specificity || a.order - b.order);
      if (!matched.length) continue;
      const declarations = matched.flatMap((r) => r.declarations);
      const content = [...declarations].reverse().find(([k]) => k === "content")?.[1];
      const text = contentText(content);
      if (text === null) continue;
      const generated: HtmlElement = {
        tag: "x-generated",
        id: null,
        classes: [],
        hasAttr: () => false,
        attrs: new Map(),
        parent: el,
        children: text ? [text] : [],
        inline: declarations.filter(([k]) => k !== "content"),
        first: false,
        last: false,
        pseudo: true,
      };
      if (where === "before") el.children.unshift(generated);
      else el.children.push(generated);
    }
  };
  walk(root);
}

// ── Cascade ────────────────────────────────────────────────────────────────────────────────────────────────────

type LenOrAuto = Length | "auto" | null;

interface Computed {
  display: "block" | "flex" | "grid" | "inline" | "inline-block" | "none" | "list-item" | "table";
  /** An inline box laid out inside as a flex row or column (`inline-flex`). */
  flexInner: boolean;
  /** A grid's column tracks. */
  gridColumns: ({ px: number } | { fr: number })[] | null;
  /** How many columns a grid item spans (`grid-column: span 2`, `1 / -1` for all of them: Infinity). */
  gridSpan: number;
  /** The custom properties in scope (`--name`), for `var()` below. */
  custom: Map<string, string>;
  position: "static" | "relative" | "absolute";
  boxSizing: "content-box" | "border-box";
  width: LenOrAuto;
  height: LenOrAuto;
  minWidth: Length | null;
  minHeight: Length | null;
  maxWidth: Length | null;
  maxHeight: Length | null;
  margin: [LenOrAuto, LenOrAuto, LenOrAuto, LenOrAuto];
  padding: [number, number, number, number];
  border: [number, number, number, number];
  borderColor: (string | null)[];
  borderStyle: string;
  inset: [LenOrAuto, LenOrAuto, LenOrAuto, LenOrAuto];
  flexDirection: "row" | "column" | "row-reverse" | "column-reverse";
  flexWrap: boolean;
  justify: string;
  alignItems: string;
  alignSelf: string;
  grow: number;
  shrink: number;
  basis: LenOrAuto;
  rowGap: number;
  columnGap: number;
  background: string | null;
  gradient: { from: string; to: string; angle: number } | null;
  radius: number;
  shadow: { x: number; y: number; blur: number; color: string } | null;
  opacity: number;
  aspectRatio: number | null;
  /** How a picture fills its box (`object-fit`). */
  fit: "contain" | "cover";
  // Inherited.
  color: string | null;
  font: FontRef | undefined;
  size: number;
  weight: FontWeight;
  italic: boolean;
  /** A multiple of the size, or null for `normal`. */
  lineHeight: number | null;
  /** Thousandths of the size. */
  tracking: number;
  caps: boolean;
  align: "left" | "center" | "right";
  underline: boolean;
  strike: boolean;
  whiteSpace: "normal" | "nowrap" | "pre" | "pre-wrap";
  listStyle: "disc" | "decimal" | "none";
}

export interface LayoutOptions {
  width: number;
  /** A fixed height (a slide's box); left out, the content's own height. */
  height?: number;
  /** What the root inherits: the file's body font, size and color. */
  base: { font?: FontRef; size: number; color?: string };
  /** A `font-family` name to a font the file can use (a catalog font or one of the file's), or null. */
  fontNamed: (family: string) => FontRef | null;
  measurer: TextMeasurer;
  /** The pictures' natural sizes, by key; a key missing here is left out. */
  pictures: ReadonlyMap<string, PictureSize>;
  /** Tables as native tables (slides) or as rows of boxes (canvases). */
  tables: boolean;
  /** The root group's name. */
  name?: string;
}

const GENERIC: Record<string, FontRef | "base"> = {
  "sans-serif": "base",
  "system-ui": "base",
  "ui-sans-serif": "base",
  "-apple-system": "base",
  blinkmacsystemfont: "base",
  serif: "source-serif-4",
  "ui-serif": "source-serif-4",
  monospace: "jetbrains-mono",
  "ui-monospace": "jetbrains-mono",
  cursive: "caveat",
  fantasy: "base",
};

function len(value: string | undefined, em: number, rem: number): LenOrAuto {
  if (value === undefined) return null;
  if (value.trim() === "auto") return "auto";
  return parseLength(value, em, rem);
}

function pxOr(value: string | undefined, em: number, rem: number, fallback: number): number {
  return px(value, em, rem) ?? fallback;
}

/** Letters only, lowercase: how a font's file name and a family name are compared. */
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A catalog font a name stands for: its family exactly, or a family it uniquely starts ("Martian" → Martian Mono). */
function catalogByName(name: string): FontRef | null {
  const exact = catalogFontNamed(name);
  if (exact) return exact.id;
  const key = squash(name);
  if (key.length < 3) return null;
  const starts = FONT_CATALOG.filter((f) => squash(f.family).startsWith(key));
  return starts.length === 1 ? (starts[0]?.id ?? null) : null;
}

/** A catalog font a font file's name names (`fontes/FunnelDisplay-Variable.ttf` → Funnel Display), or null. */
function catalogByFile(file: string): FontRef | null {
  const base = squash(file.split("/").pop() ?? file);
  // The longest family the name holds, so "Source Sans 3" isn't read as a shorter one.
  const found = FONT_CATALOG.filter((f) => base.includes(squash(f.family))).sort(
    (a, b) => squash(b.family).length - squash(a.family).length,
  );
  return found[0]?.id ?? null;
}

class Cascade {
  readonly notes = new Set<string>();
  private readonly rules: Rule[];
  constructor(
    private readonly parsed: ParsedHtml,
    private readonly opts: Pick<LayoutOptions, "base" | "fontNamed">,
  ) {
    this.rules = parsed.rules;
  }

  /**
   * An element's declarations as the cascade orders them (the tag's own look, its rules by specificity, then its
   * `style`), its custom properties over the ones it inherits, `var()` resolved, shorthands expanded.
   */
  declarations(
    el: HtmlElement,
    inherited: ReadonlyMap<string, string>,
  ): { d: Declarations; custom: Map<string, string> } {
    const entries: RawDeclarations = [...(el.pseudo ? [] : (UA_DECLS.get(el.tag) ?? []))];
    if (!el.pseudo) {
      const matched = this.rules.filter((r) => matches(el, r.selector));
      matched.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
      for (const rule of matched) entries.push(...rule.declarations);
    }
    entries.push(...el.inline);
    const custom = new Map(inherited);
    for (const [k, v] of entries) if (k.startsWith("--")) custom.set(k, v);
    const resolved: RawDeclarations = [];
    for (const [k, v] of entries) {
      if (k.startsWith("--")) continue;
      const value = resolveVars(v, custom);
      if (value !== null) resolved.push([k, value]);
    }
    return { d: expandAll(resolved), custom };
  }

  private fontOf(families: string[], fallback: FontRef | undefined): FontRef | undefined {
    const missing: string[] = [];
    for (const family of families) {
      const generic = GENERIC[family.toLowerCase()];
      if (generic) return generic === "base" ? this.opts.base.font : generic;
      const own = this.opts.fontNamed(family);
      if (own) return own;
      // A name the sheet gave a font file (`@font-face`), matched by the file's name; else a catalog family.
      const file = this.parsed.fontFaces.get(family.toLowerCase());
      const ref = (file ? catalogByFile(file) : null) ?? catalogByName(family);
      if (ref) return ref;
      missing.push(family);
    }
    if (missing.length)
      this.notes.add(`fonts not available (used the next one or the file's): ${missing.slice(0, 4).join(", ")}`);
    return fallback;
  }

  compute(el: HtmlElement, parent: Computed | null): Computed {
    const { d, custom } = this.declarations(el, parent?.custom ?? new Map());
    const rem = this.opts.base.size;
    const inheritedSize = parent?.size ?? this.opts.base.size;
    const fontSize = (() => {
      const v = d.get("font-size");
      if (!v) return inheritedSize;
      const l = parseLength(v, inheritedSize, rem);
      if (l && "px" in l) return Math.max(4, Math.min(1000, l.px));
      if (l && "percent" in l) return (inheritedSize * l.percent) / 100;
      const named: Record<string, number> = { small: 0.83, medium: 1, large: 1.2, "x-large": 1.5, "xx-large": 2 };
      return named[v] ? named[v] * rem : inheritedSize;
    })();
    const em = fontSize;
    const displayValue = d.get("display");
    const display = (() => {
      const v = displayValue;
      if (v === "none") return "none";
      if (v === "flex") return "flex";
      if (v === "grid") return "grid";
      // An inline box with its own layout inside (a number in a circle, a chip): a box in the line.
      if (v === "inline-flex" || v === "inline-grid") return "inline-block";
      if (v === "inline-block" || v === "inline-table") return "inline-block";
      if (v === "inline") return "inline";
      if (v === "block" || v === "flow-root") return "block";
      if (v === "list-item" || el.tag === "li") return "list-item";
      if (v === "table" || el.tag === "table") return "table";
      if (el.picture) return "inline";
      if (el.pseudo) return "inline";
      return BLOCK_TAGS.has(el.tag) || !parent ? "block" : "inline";
    })() as Computed["display"];
    const position = (() => {
      const v = d.get("position");
      if (v === "absolute" || v === "fixed") return "absolute";
      if (v === "relative") return "relative";
      if (v === "sticky") return "relative";
      return "static";
    })() as Computed["position"];
    const side = (
      prefix: string,
      suffix = "",
    ): [string | undefined, string | undefined, string | undefined, string | undefined] => [
      d.get(`${prefix}top${suffix}`),
      d.get(`${prefix}right${suffix}`),
      d.get(`${prefix}bottom${suffix}`),
      d.get(`${prefix}left${suffix}`),
    ];
    const margin = side("margin-").map((v) => len(v, em, rem)) as Computed["margin"];
    const padding = side("padding-").map((v) => Math.max(0, pxOr(v, em, rem, 0))) as Computed["padding"];
    const borderStyles = side("border-", "-style");
    const border = side("border-", "-width").map((v, i) =>
      borderStyles[i] === "none" || borderStyles[i] === "hidden" ? 0 : Math.max(0, pxOr(v, em, rem, 0)),
    ) as Computed["border"];
    const borderColor = side("border-", "-color").map((v) => (v ? parseColor(v) : null));
    const borderStyle = borderStyles.find((s) => s && s !== "none") ?? "solid";
    const inset = side("").map((v) => len(v, em, rem)) as Computed["inset"];
    const flexDirection = (d.get("flex-direction") ?? "row") as Computed["flexDirection"];
    const weight = (parseWeight(d.get("font-weight"), parent?.weight ?? 400) ?? parent?.weight ?? 400) as FontWeight;
    const lineHeight = (() => {
      const v = d.get("line-height");
      if (!v) return parent?.lineHeight ?? null;
      if (v === "normal") return null;
      if (/^\d*\.?\d+$/.test(v)) return Math.max(0.8, Math.min(3, Number.parseFloat(v)));
      const l = parseLength(v, em, rem);
      if (l && "px" in l) return Math.max(0.8, Math.min(3, l.px / fontSize));
      if (l && "percent" in l) return Math.max(0.8, Math.min(3, l.percent / 100));
      return parent?.lineHeight ?? null;
    })();
    const tracking = (() => {
      const v = d.get("letter-spacing");
      if (!v) return parent?.tracking ?? 0;
      if (v === "normal") return 0;
      const n = px(v, em, rem);
      return n === null ? (parent?.tracking ?? 0) : Math.round((n / fontSize) * 1000);
    })();
    const decoration = d.get("text-decoration") ?? "";
    const textAlign = d.get("text-align");
    const align = (
      textAlign === "center" || textAlign === "right" || textAlign === "left"
        ? textAlign
        : textAlign === "end"
          ? "right"
          : textAlign === "start" || textAlign === "justify"
            ? "left"
            : (parent?.align ?? "left")
    ) as Computed["align"];
    const whiteSpace = (() => {
      const v = d.get("white-space");
      if (v === "nowrap" || v === "pre" || v === "pre-wrap" || v === "normal") return v;
      if (v === "pre-line" || v === "break-spaces") return "pre-wrap";
      return parent?.whiteSpace ?? "normal";
    })();
    const listStyleValue = d.get("list-style-type") ?? d.get("list-style");
    const listStyle = (() => {
      if (listStyleValue) {
        if (/none/.test(listStyleValue)) return "none";
        if (/decimal|alpha|roman|latin/.test(listStyleValue)) return "decimal";
        return "disc";
      }
      if (el.tag === "ol") return "decimal";
      if (el.tag === "ul") return "disc";
      return parent?.listStyle ?? "disc";
    })();
    const background = parseColor(d.get("background-color"));
    const families = parseFamilies(d.get("font-family"));
    const opacity = Number.parseFloat(d.get("opacity") ?? "1");
    const aspect = (() => {
      const v = d.get("aspect-ratio");
      if (!v) return null;
      const [a, b] = v.split("/").map((x) => Number.parseFloat(x));
      return a && b ? a / b : a && Number.isFinite(a) ? a : null;
    })();
    for (const unsupported of ["transform", "filter", "animation", "float", "clip-path", "mask"]) {
      if (d.has(unsupported) && d.get(unsupported) !== "none") this.notes.add(`${unsupported} isn't taken`);
    }
    if (d.get("background-image") && !/linear-gradient/i.test(d.get("background-image") ?? "")) {
      this.notes.add("background images aren't taken: use an <img>");
    }
    const gridSpan = (() => {
      const v = d.get("grid-column") ?? d.get("grid-area");
      if (!v) return 1;
      if (/^1\s*\/\s*-1$/.test(v.trim()) || /^-?1\s*\/\s*span\s+99/.test(v)) return Number.POSITIVE_INFINITY;
      const span = /span\s+(\d+)/.exec(v);
      if (span) return Math.max(1, Number(span[1]));
      const range = /^(\d+)\s*\/\s*(\d+)$/.exec(v.trim());
      return range ? Math.max(1, Number(range[2]) - Number(range[1])) : 1;
    })();
    return {
      display,
      flexInner: displayValue === "inline-flex" || displayValue === "inline-grid",
      gridColumns: display === "grid" ? parseTracks(d.get("grid-template-columns"), em, rem) : null,
      gridSpan,
      custom,
      position,
      boxSizing: d.get("box-sizing") === "border-box" ? "border-box" : "content-box",
      width: len(d.get("width"), em, rem),
      height: len(d.get("height"), em, rem),
      minWidth: parseLength(d.get("min-width"), em, rem),
      minHeight: parseLength(d.get("min-height"), em, rem),
      maxWidth: parseLength(d.get("max-width"), em, rem),
      maxHeight: parseLength(d.get("max-height"), em, rem),
      margin,
      padding,
      border,
      borderColor,
      borderStyle,
      inset,
      flexDirection: ["row", "column", "row-reverse", "column-reverse"].includes(flexDirection) ? flexDirection : "row",
      flexWrap: /^wrap/.test(d.get("flex-wrap") ?? ""),
      justify: d.get("justify-content") ?? "flex-start",
      alignItems: d.get("align-items") ?? "stretch",
      alignSelf: d.get("align-self") ?? "auto",
      grow: Number.parseFloat(d.get("flex-grow") ?? "0") || 0,
      shrink: d.has("flex-shrink") ? Number.parseFloat(d.get("flex-shrink") ?? "1") || 0 : 1,
      basis: len(d.get("flex-basis"), em, rem),
      rowGap: pxOr(d.get("row-gap"), em, rem, 0),
      columnGap: pxOr(d.get("column-gap"), em, rem, 0),
      background: background && background !== "none" ? background : null,
      gradient: parseGradient(d.get("background-image")),
      radius: (() => {
        const v = d.get("border-radius");
        if (!v) return 0;
        const l = parseLength(v, em, rem);
        return l && "px" in l ? Math.max(0, l.px) : l && "percent" in l && l.percent >= 50 ? 10_000 : 0;
      })(),
      shadow: parseShadow(d.get("box-shadow"), em, rem),
      opacity: Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1,
      aspectRatio: aspect && aspect > 0 ? aspect : null,
      fit: /contain|scale-down/.test(d.get("object-fit") ?? "") ? "contain" : "cover",
      color: (() => {
        const c = parseColor(d.get("color"));
        return c && c !== "none" ? opaque(c) : (parent?.color ?? this.opts.base.color ?? null);
      })(),
      font: families.length
        ? this.fontOf(families, parent?.font ?? this.opts.base.font)
        : (parent?.font ?? this.opts.base.font),
      size: fontSize,
      weight,
      italic: d.has("font-style") ? /italic|oblique/.test(d.get("font-style") ?? "") : (parent?.italic ?? false),
      lineHeight,
      tracking,
      caps: d.has("text-transform") ? d.get("text-transform") === "uppercase" : (parent?.caps ?? false),
      align,
      underline: /underline/.test(decoration) || (parent?.underline ?? false),
      strike: /line-through/.test(decoration) || (parent?.strike ?? false),
      whiteSpace,
      listStyle,
    };
  }
}

// ── Layout tree ────────────────────────────────────────────────────────────────────────────────────────────────

interface Paragraph {
  runs: RichRun[];
  /** The block style the paragraph's runs are measured against. */
  style: Computed;
  list?: "bullet" | "ordered";
  level?: number;
  spaceAfter?: number;
}

/** A node of the layout and what it becomes. */
interface LNode {
  yoga: YogaNode;
  el: HtmlElement | null;
  style: Computed;
  kind: "box" | "text" | "picture" | "line" | "table";
  paragraphs?: Paragraph[];
  picture?: string;
  rows?: string[][];
  header?: boolean;
  children: LNode[];
}

function hasLook(s: Computed): boolean {
  return (
    !!s.background ||
    !!s.gradient ||
    !!s.shadow ||
    s.border.some((b, i) => b > 0 && (s.borderColor[i] ?? s.color) !== "none")
  );
}

function isInline(s: Computed): boolean {
  return s.display === "inline";
}

/** Whether an inline element draws a box of its own in the line (a badge, a chip). */
function isBoxyInline(el: HtmlElement, s: Computed): boolean {
  if (el.picture) return true;
  if (s.display === "inline-block" || s.display === "flex") return true;
  return hasLook(s) && (s.padding.some((p) => p > 0) || s.radius > 0 || s.border.some((b) => b > 0));
}

class Builder {
  readonly notes: Set<string>;
  private readonly cascade: Cascade;
  private readonly computed = new Map<HtmlElement, Computed>();

  constructor(
    parsed: ParsedHtml,
    private readonly opts: LayoutOptions,
  ) {
    this.cascade = new Cascade(parsed, opts);
    this.notes = this.cascade.notes;
  }

  /** Gives an anonymous holder of some of an element's content that element's look. */
  computedFor(holder: HtmlElement, style: Computed): void {
    this.computed.set(holder, style);
  }

  styleOf(el: HtmlElement): Computed {
    const hit = this.computed.get(el);
    if (hit) return hit;
    const s = this.cascade.compute(el, el.parent ? this.styleOf(el.parent) : null);
    this.computed.set(el, s);
    return s;
  }

  face(s: Computed): Face {
    return { ref: s.font ?? "source-sans-3", weight: s.weight, italic: s.italic };
  }

  /** `normal` line height for a style: the font's own extent, kept between 1 and 1.6. */
  lineHeightOf(s: Computed): number {
    if (s.lineHeight !== null) return s.lineHeight;
    const e = this.opts.measurer.extent(this.face(s));
    return Math.max(1, Math.min(1.6, Math.round((e.ascent + e.descent) * 100) / 100));
  }

  private applyBox(node: YogaNode, s: Computed, isRoot: boolean): void {
    const set = (v: LenOrAuto, fn: (x: number | "auto" | `${number}%`) => void) => {
      if (!v) return;
      if (v === "auto") fn("auto");
      else if ("px" in v) fn(v.px);
      else fn(`${v.percent}%`);
    };
    const setMin = (v: Length | null, fn: (x: number | `${number}%`) => void) => {
      if (!v) return;
      if ("px" in v) fn(v.px);
      else fn(`${v.percent}%`);
    };
    if (typeof node.setBoxSizing === "function") {
      node.setBoxSizing(s.boxSizing === "border-box" ? BoxSizing.BorderBox : BoxSizing.ContentBox);
    }
    if (!isRoot) {
      set(s.width, (v) => node.setWidth(v));
      set(s.height, (v) => node.setHeight(v));
    }
    setMin(s.minWidth, (v) => node.setMinWidth(v));
    setMin(s.minHeight, (v) => node.setMinHeight(v));
    setMin(s.maxWidth, (v) => node.setMaxWidth(v));
    setMin(s.maxHeight, (v) => node.setMaxHeight(v));
    const edges = [Edge.Top, Edge.Right, Edge.Bottom, Edge.Left];
    edges.forEach((edge, i) => {
      const m = s.margin[i];
      if (m === "auto") node.setMargin(edge, "auto");
      else if (m && "px" in m) node.setMargin(edge, m.px);
      else if (m && "percent" in m) node.setMargin(edge, `${m.percent}%`);
      node.setPadding(edge, s.padding[i] ?? 0);
      node.setBorder(edge, s.border[i] ?? 0);
      if (s.position === "absolute") {
        const p = s.inset[i];
        if (p && p !== "auto") node.setPosition(edge, "px" in p ? p.px : `${p.percent}%`);
      }
    });
    if (s.position === "absolute") node.setPositionType(PositionType.Absolute);
    node.setFlexGrow(s.grow);
    node.setFlexShrink(s.shrink);
    if (s.basis && s.basis !== "auto") node.setFlexBasis("px" in s.basis ? s.basis.px : `${s.basis.percent}%`);
    const self = ALIGN[s.alignSelf];
    if (self !== undefined) node.setAlignSelf(self);
    if (s.aspectRatio) node.setAspectRatio(s.aspectRatio);
  }

  private flexContainer(node: YogaNode, s: Computed): void {
    node.setFlexDirection(
      s.flexDirection === "column"
        ? FlexDirection.Column
        : s.flexDirection === "column-reverse"
          ? FlexDirection.ColumnReverse
          : s.flexDirection === "row-reverse"
            ? FlexDirection.RowReverse
            : FlexDirection.Row,
    );
    node.setFlexWrap(s.flexWrap ? Wrap.Wrap : Wrap.NoWrap);
    node.setJustifyContent(JUSTIFY[s.justify] ?? Justify.FlexStart);
    node.setAlignItems(ALIGN[s.alignItems] ?? Align.Stretch);
    node.setAlignContent(Align.FlexStart);
    node.setGap(Gutter.Row, s.rowGap);
    node.setGap(Gutter.Column, s.columnGap);
  }

  private blockContainer(node: YogaNode): void {
    node.setFlexDirection(FlexDirection.Column);
    node.setAlignItems(Align.Stretch);
  }

  /** An element and what it holds. */
  build(el: HtmlElement, isRoot = false): LNode | null {
    const s = this.styleOf(el);
    if (s.display === "none") return null;
    const yoga = Yoga.Node.create();
    this.applyBox(yoga, s, isRoot);
    if (el.picture) return this.pictureNode(el, s, yoga);
    if (el.tag === "hr") {
      yoga.setHeight(0);
      return { yoga, el, style: s, kind: "line", children: [] };
    }
    if (s.display === "table") {
      if (this.opts.tables) return this.tableNode(el, s, yoga);
      this.tableAsRows(el);
    }
    const node: LNode = { yoga, el, style: s, kind: "box", children: [] };
    if (s.display === "grid") {
      this.gridContainer(node, el, s);
      return node;
    }
    if (s.display === "flex" || s.flexInner) this.flexContainer(yoga, s);
    else this.blockContainer(yoga);
    // One text box for a list or a run of plain paragraphs (a person would write it as one).
    const merged = this.plainParagraphs(el, s);
    if (merged) {
      // Native bullets draw their own indent: the list's own padding is theirs.
      if (merged.some((p) => p.list)) yoga.setPadding(Edge.Left, 0);
      this.addChild(node, this.textNode(merged, s));
      return node;
    }
    if (s.display === "flex" || s.flexInner) {
      for (const part of this.flexItems(el, s)) this.addChild(node, part);
    } else {
      for (const part of this.blockItems(el, s)) this.addChild(node, part);
    }
    return node;
  }

  /**
   * A grid as rows of its column tracks (ADR 0220 §4): items fill the columns in order, a span takes several, each row
   * as tall as its tallest item (CSS grid's stretch), the tracks' fixed widths and shares of what is left kept on every
   * row, the last one too.
   */
  private gridContainer(node: LNode, el: HtmlElement, s: Computed): void {
    const yoga = node.yoga;
    yoga.setFlexDirection(FlexDirection.Column);
    yoga.setAlignItems(Align.Stretch);
    yoga.setGap(Gutter.Row, s.rowGap);
    const tracks = s.gridColumns ?? [{ fr: 1 }];
    const n = tracks.length;
    const gap = s.columnGap;
    const size = (from: number, span: number) => {
      const slice = tracks.slice(from, from + span);
      const fixed = slice.reduce((t, k) => t + ("px" in k ? k.px : 0), 0) + (span - 1) * gap;
      const share = slice.reduce((t, k) => t + ("fr" in k ? k.fr : 0), 0);
      return { fixed, share };
    };
    const fit = (item: YogaNode, from: number, span: number, explicit: boolean) => {
      if (explicit) return;
      const { fixed, share } = size(from, span);
      if (share > 0) {
        item.setFlexGrow(share);
        item.setFlexShrink(1);
        item.setFlexBasis(fixed);
      } else {
        item.setFlexGrow(0);
        item.setFlexShrink(0);
        item.setWidth(fixed);
      }
    };
    let row: LNode | null = null;
    let col = 0;
    const close = () => {
      if (!row) return;
      // Empty columns keep their room, so a short last row lines up with the others.
      while (col < n) {
        const spacer = Yoga.Node.create();
        fit(spacer, col, 1, false);
        row.yoga.insertChild(spacer, row.yoga.getChildCount());
        row.children.push({ yoga: spacer, el: null, style: s, kind: "box", children: [] });
        col++;
      }
      row = null;
      col = 0;
    };
    const open = () => {
      const r = Yoga.Node.create();
      r.setFlexDirection(FlexDirection.Row);
      r.setAlignItems(ALIGN[s.alignItems] ?? Align.Stretch);
      r.setGap(Gutter.Column, gap);
      row = { yoga: r, el: null, style: s, kind: "box", children: [] };
      this.addChild(node, row);
    };
    for (const item of this.flexItems(el, s)) {
      // An absolutely placed item takes no cell (as in CSS): it sits on the grid itself.
      if (item.style.position === "absolute" && item.style !== s) {
        this.addChild(node, item);
        continue;
      }
      const span = Math.min(n, Number.isFinite(item.style.gridSpan) ? item.style.gridSpan : n);
      if (!row || col + span > n) {
        close();
        open();
      }
      const current = row as LNode | null;
      if (!current) continue;
      fit(item.yoga, col, span, !!item.style.width && item.el !== null && item.style !== s);
      this.addChild(current, item);
      col += span;
      if (col >= n) close();
    }
    close();
  }

  private addChild(parent: LNode, child: LNode | null): void {
    if (!child) return;
    parent.yoga.insertChild(child.yoga, parent.yoga.getChildCount());
    parent.children.push(child);
  }

  private pictureNode(el: HtmlElement, s: Computed, yoga: YogaNode): LNode | null {
    const key = el.picture as string;
    const natural = this.opts.pictures.get(key);
    if (!natural) {
      this.notes.add("a picture couldn't be used");
      yoga.free();
      return null;
    }
    const attrW = Number.parseFloat(el.attrs.get("width") ?? "");
    const attrH = Number.parseFloat(el.attrs.get("height") ?? "");
    if (!s.width && Number.isFinite(attrW)) yoga.setWidth(attrW);
    if (!s.height && Number.isFinite(attrH)) yoga.setHeight(attrH);
    const hasW = !!s.width || Number.isFinite(attrW);
    const hasH = !!s.height || Number.isFinite(attrH);
    if (!hasW && !hasH) {
      yoga.setWidth(natural.w);
      yoga.setHeight(natural.h);
    } else if (!(hasW && hasH)) yoga.setAspectRatio(natural.w / natural.h);
    yoga.setFlexShrink(0);
    return { yoga, el, style: s, kind: "picture", picture: key, children: [] };
  }

  private tableNode(el: HtmlElement, s: Computed, yoga: YogaNode): LNode {
    const rows: string[][] = [];
    const walk = (e: HtmlElement) => {
      for (const c of e.children) {
        if (typeof c === "string") continue;
        if (c.tag === "tr")
          rows.push(
            c.children
              .filter((x): x is HtmlElement => typeof x !== "string" && (x.tag === "td" || x.tag === "th"))
              .map((cell) => this.plainText(cell)),
          );
        else walk(c);
      }
    };
    walk(el);
    const header = el.children.some(
      (c) =>
        typeof c !== "string" &&
        (c.tag === "thead" ||
          c.children.some(
            (r) =>
              typeof r !== "string" &&
              r.tag === "tr" &&
              r.children.some((x) => typeof x !== "string" && x.tag === "th"),
          )),
    );
    const rowHeight = s.size * 1.4 + 24;
    if (!s.height) yoga.setHeight(Math.max(1, rows.length) * rowHeight);
    if (!s.width) yoga.setWidthPercent(100);
    return { yoga, el, style: s, kind: "table", rows, header, children: [] };
  }

  /** A table on a canvas: its rows as flex rows of cells, laid out like any boxes. */
  private tableAsRows(el: HtmlElement): void {
    const s = this.styleOf(el);
    s.display = "flex";
    s.flexDirection = "column";
    const rows: HtmlElement[] = [];
    const walk = (e: HtmlElement) => {
      for (const c of e.children) if (typeof c !== "string") c.tag === "tr" ? rows.push(c) : walk(c);
    };
    walk(el);
    el.children = rows;
    for (const row of rows) {
      const rs = this.styleOf(row);
      rs.display = "flex";
      rs.flexDirection = "row";
      for (const cell of row.children) {
        if (typeof cell === "string") continue;
        const cs = this.styleOf(cell);
        cs.display = "block";
        cs.grow = 1;
        cs.basis = { px: 0 };
        if (!cs.padding.some((p) => p > 0)) cs.padding = [8, 12, 8, 12];
      }
    }
  }

  private plainText(el: HtmlElement): string {
    return el.children
      .map((c) => (typeof c === "string" ? c : this.plainText(c)))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Whether an element's content is only inline text (no boxes, pictures or blocks inside). */
  inlineOnly(el: HtmlElement): boolean {
    return el.children.every((c) => {
      if (typeof c === "string") return true;
      const s = this.styleOf(c);
      if (s.display === "none") return true;
      return isInline(s) && !isBoxyInline(c, s) && c.tag !== "br" ? this.inlineOnly(c) : c.tag === "br";
    });
  }

  /** A block that is only text and holds nothing that needs a box of its own: a paragraph to merge. */
  private plainBlock(el: HtmlElement): boolean {
    const s = this.styleOf(el);
    if (s.display !== "block" && s.display !== "list-item") return false;
    if (hasLook(s) || s.width || s.height || s.position === "absolute" || el.id || el.attrs.has("data-name"))
      return false;
    if (s.padding.some((p) => p > 0)) return false;
    return this.inlineOnly(el);
  }

  /**
   * A list, or a block holding only plain paragraphs, as one text box's paragraphs: its runs and each paragraph's
   * room after (margins collapsed as browsers do). Null when it holds anything else.
   */
  private plainParagraphs(el: HtmlElement, s: Computed): Paragraph[] | null {
    const elements = el.children.filter(
      (c): c is HtmlElement => typeof c !== "string" && this.styleOf(c).display !== "none",
    );
    const stray = el.children.some((c) => typeof c === "string" && c.trim());
    if (stray || elements.length < 2 || s.display === "flex") return null;
    if (!elements.every((c) => this.plainBlock(c))) return null;
    // A list's items each become a list paragraph; nested lists aren't merged.
    const list =
      el.tag === "ul" || el.tag === "ol"
        ? s.listStyle === "none"
          ? undefined
          : s.listStyle === "decimal"
            ? "ordered"
            : "bullet"
        : undefined;
    const out: Paragraph[] = [];
    elements.forEach((child, i) => {
      const cs = this.styleOf(child);
      const runs = this.runsOf(child, cs);
      const next = elements[i + 1];
      const below = Math.max(marginPx(cs.margin[2]), next ? marginPx(this.styleOf(next).margin[0]) : 0);
      out.push({
        runs,
        style: cs,
        ...(list ? { list } : {}),
        ...(next && below > 0 ? { spaceAfter: below } : {}),
      });
    });
    return out;
  }

  /** The runs of an element's inline content, marks relative to `base` (the block the text box takes its look from). */
  runsOf(el: HtmlElement, base: Computed): RichRun[] {
    const runs: RichRun[] = [];
    const walk = (node: HtmlElement, s: Computed, link: string | undefined) => {
      for (const c of node.children) {
        if (typeof c === "string") {
          const text = s.whiteSpace === "pre" || s.whiteSpace === "pre-wrap" ? c : c.replace(/\s+/g, " ");
          if (text) runs.push({ text, ...marksOf(s, base, link) });
        } else {
          const cs = this.styleOf(c);
          if (cs.display === "none") continue;
          if (c.tag === "br") {
            runs.push({ text: "\n" });
            continue;
          }
          const href = c.tag === "a" ? c.attrs.get("href") : undefined;
          walk(c, cs, href && /^(https?:|mailto:)/i.test(href) ? href : link);
        }
      }
    };
    // The element's own look for its own words; the marks say where they differ from `base`.
    walk(el, this.styleOf(el), undefined);
    return trimRuns(runs);
  }

  private textNode(paragraphs: Paragraph[], s: Computed): LNode {
    const yoga = Yoga.Node.create();
    const node: LNode = { yoga, el: null, style: s, kind: "text", paragraphs, children: [] };
    const nowrap = s.whiteSpace === "nowrap" || s.whiteSpace === "pre";
    yoga.setFlexShrink(1);
    yoga.setMeasureFunc((width, widthMode) => {
      const max = widthMode === MeasureMode.Undefined || nowrap ? Number.POSITIVE_INFINITY : width;
      const m = this.measure(paragraphs, max);
      return {
        width:
          widthMode === MeasureMode.Exactly
            ? width
            : Math.min(Math.ceil(m.width), widthMode === MeasureMode.AtMost ? width : Number.POSITIVE_INFINITY),
        height: Math.ceil(m.height),
      };
    });
    return node;
  }

  /** Lays out paragraphs in `max` width: the widest line and the total height. */
  measure(paragraphs: Paragraph[], max: number): { width: number; height: number } {
    let width = 0;
    let height = 0;
    paragraphs.forEach((p, i) => {
      const lines = this.lines(p, max);
      for (const line of lines) {
        width = Math.max(width, line.width);
        height += line.height;
      }
      if (i < paragraphs.length - 1) height += p.spaceAfter ?? 0;
    });
    return { width, height };
  }

  private lines(p: Paragraph, max: number): { width: number; height: number }[] {
    const lh = this.lineHeightOf(p.style);
    const indent = p.list ? p.style.size * 1.2 : 0;
    type Token = { text: string; width: number; space: number; size: number; brk?: boolean };
    const tokens: Token[] = [];
    for (const run of p.runs) {
      const size = run.size ?? p.style.size;
      const face: Face = {
        ref: run.font ?? p.style.font ?? "source-sans-3",
        weight: run.weight ?? (run.bold ? 700 : p.style.weight),
        italic: run.italic ?? p.style.italic,
      };
      const tracking = run.tracking ?? p.style.tracking;
      const caps = run.caps ?? p.style.caps;
      const parts = run.text.split("\n");
      parts.forEach((part, k) => {
        if (k > 0) tokens.push({ text: "", width: 0, space: 0, size, brk: true });
        for (const word of part.match(/[^\s]+\s*|\s+/g) ?? []) {
          const body = word.trimEnd();
          const shown = caps ? body.toUpperCase() : body;
          const space = word.length > body.length ? this.opts.measurer.width(" ", face, size, tracking) : 0;
          tokens.push({ text: body, width: this.opts.measurer.width(shown, face, size, tracking), space, size });
        }
      });
    }
    const lines: { width: number; height: number }[] = [];
    let w = indent;
    let biggest = p.style.size;
    let pendingSpace = 0;
    let empty = true;
    const flush = () => {
      lines.push({ width: w, height: biggest * lh });
      w = indent;
      biggest = p.style.size;
      pendingSpace = 0;
      empty = true;
    };
    for (const t of tokens) {
      if (t.brk) {
        flush();
        continue;
      }
      if (!t.text) {
        pendingSpace += t.space;
        continue;
      }
      if (!empty && w + pendingSpace + t.width > max + 0.5) flush();
      w += (empty ? 0 : pendingSpace) + t.width;
      pendingSpace = t.space;
      biggest = Math.max(biggest, t.size);
      empty = false;
    }
    flush();
    return lines;
  }

  /** The children of a block: blocks as they are, runs of inline content as text (or as a row when it holds boxes). */
  private blockItems(el: HtmlElement, s: Computed): LNode[] {
    const out: LNode[] = [];
    let inline: (HtmlElement | string)[] = [];
    const flushInline = () => {
      if (inline.some((c) => typeof c !== "string" || c.trim())) out.push(...this.inlineContent(inline, s));
      inline = [];
    };
    for (const c of el.children) {
      if (typeof c === "string") {
        inline.push(c);
        continue;
      }
      const cs = this.styleOf(c);
      if (cs.display === "none") continue;
      if (cs.position === "absolute") {
        const n = this.build(c);
        if (n) out.push(n);
        continue;
      }
      if (isInline(cs) || (cs.display === "inline-block" && !BLOCK_TAGS.has(c.tag)) || c.picture) inline.push(c);
      else {
        flushInline();
        const n = this.build(c);
        if (n) out.push(n);
      }
    }
    flushInline();
    return out;
  }

  /** The items of a flex container: each element is an item; loose text between them is a text item. */
  private flexItems(el: HtmlElement, s: Computed): LNode[] {
    const out: LNode[] = [];
    for (const c of el.children) {
      if (typeof c === "string") {
        if (c.trim())
          out.push(
            this.textNode(
              [{ runs: trimRuns([{ text: c.replace(/\s+/g, " "), ...marksOf(s, s, undefined) }]), style: s }],
              s,
            ),
          );
        continue;
      }
      const cs = this.styleOf(c);
      if (cs.display === "none") continue;
      if (isInline(cs) && !isBoxyInline(c, cs) && !c.picture) {
        // A plain span as a flex item is blockified, as in CSS: its own look, laid out as a block.
        const clone: HtmlElement = { ...c };
        this.computed.set(clone, { ...cs, display: "block" });
        const holder = this.build(clone);
        if (holder) out.push(holder);
        continue;
      }
      const n = this.build(c);
      if (n) out.push(n);
    }
    return out;
  }

  /**
   * Inline content: one text when it is only text; a wrapping row of texts and boxes when it holds boxes (an icon
   * before a title, a badge after it), a space's width between items where the markup had one.
   */
  private inlineContent(items: (HtmlElement | string)[], s: Computed): LNode[] {
    const holder: HtmlElement = {
      tag: "span",
      id: null,
      classes: [],
      hasAttr: () => false,
      attrs: new Map(),
      parent: null,
      children: items,
      inline: [],
      first: false,
      last: false,
    };
    const boxy = items.some((c) => typeof c !== "string" && isBoxyInline(c, this.styleOf(c)));
    if (!boxy) {
      // Reuse the parent's computed look for the anonymous holder.
      this.computed.set(holder, s);
      const runs = this.runsOf(holder, s);
      return runs.some((r) => r.text.trim()) ? [this.textNode([{ runs, style: s }], s)] : [];
    }
    const row = Yoga.Node.create();
    row.setFlexDirection(FlexDirection.Row);
    row.setFlexWrap(Wrap.Wrap);
    row.setAlignItems(Align.Center);
    const rowNode: LNode = { yoga: row, el: null, style: s, kind: "box", children: [] };
    let text: (HtmlElement | string)[] = [];
    let gapBefore = false;
    const space = this.opts.measurer.width(" ", this.face(s), s.size, s.tracking);
    const flushText = () => {
      if (!text.length) return;
      const part: HtmlElement = { ...holder, children: text };
      this.computed.set(part, s);
      const runs = this.runsOf(part, s);
      if (runs.some((r) => r.text.trim())) {
        const n = this.textNode([{ runs, style: s }], s);
        n.yoga.setFlexShrink(1);
        if (gapBefore && rowNode.children.length) n.yoga.setMargin(Edge.Left, space);
        this.addChild(rowNode, n);
      }
      gapBefore = /\s$/.test(text.map((t) => (typeof t === "string" ? t : "")).join(""));
      text = [];
    };
    for (const c of items) {
      if (typeof c === "string") {
        if (!c.trim()) gapBefore = true;
        text.push(c);
        continue;
      }
      const cs = this.styleOf(c);
      if (!isBoxyInline(c, cs)) {
        text.push(c);
        continue;
      }
      const leadingSpace = text.length > 0 && /\s$/.test(String(text[text.length - 1] ?? ""));
      flushText();
      const n = this.build(c);
      if (!n) continue;
      if ((gapBefore || leadingSpace) && rowNode.children.length)
        n.yoga.setMargin(Edge.Left, marginPx(cs.margin[3]) + space);
      gapBefore = false;
      this.addChild(rowNode, n);
    }
    flushText();
    return rowNode.children.length ? [rowNode] : [];
  }
}

const ALIGN: Record<string, Align> = {
  auto: Align.Auto,
  "flex-start": Align.FlexStart,
  start: Align.FlexStart,
  "self-start": Align.FlexStart,
  left: Align.FlexStart,
  center: Align.Center,
  "flex-end": Align.FlexEnd,
  end: Align.FlexEnd,
  "self-end": Align.FlexEnd,
  right: Align.FlexEnd,
  stretch: Align.Stretch,
  baseline: Align.Baseline,
  normal: Align.Stretch,
};

const JUSTIFY: Record<string, Justify> = {
  "flex-start": Justify.FlexStart,
  start: Justify.FlexStart,
  left: Justify.FlexStart,
  normal: Justify.FlexStart,
  center: Justify.Center,
  "flex-end": Justify.FlexEnd,
  end: Justify.FlexEnd,
  right: Justify.FlexEnd,
  "space-between": Justify.SpaceBetween,
  "space-around": Justify.SpaceAround,
  "space-evenly": Justify.SpaceEvenly,
};

function marginPx(m: LenOrAuto): number {
  return m && m !== "auto" && "px" in m ? Math.max(0, m.px) : 0;
}

/** A run's marks where its look differs from the block's. */
function marksOf(s: Computed, base: Computed, link: string | undefined): Partial<RichRun> {
  const out: Partial<RichRun> = {};
  if (s.font && s.font !== base.font) out.font = s.font;
  if (Math.abs(s.size - base.size) > 0.01) out.size = Math.round(s.size * 100) / 100;
  if (s.weight !== base.weight) out.weight = s.weight;
  if (s.color && s.color !== base.color) out.color = opaque(s.color);
  if (s.italic && !base.italic) out.italic = true;
  if (s.underline && !base.underline) out.underline = true;
  if (s.strike && !base.strike) out.strike = true;
  if (s.background && s !== base) out.highlight = opaque(s.background);
  if (s.tracking !== base.tracking && s.tracking !== 0) out.tracking = s.tracking;
  if (s.caps && !base.caps) out.caps = true;
  if (link) out.link = link;
  return out;
}

/** Runs with the paragraph's leading and trailing spaces taken off. */
function trimRuns(runs: RichRun[]): RichRun[] {
  const out = runs.map((r) => ({ ...r }));
  while (out.length && !(out[0] as RichRun).text.replace(/^ +/, "")) out.shift();
  if (out[0]) out[0].text = out[0].text.replace(/^ +/, "");
  while (out.length && !(out[out.length - 1] as RichRun).text.replace(/ +$/, "")) out.pop();
  const last = out[out.length - 1];
  if (last) last.text = last.text.replace(/ +$/, "");
  // A space right after a line break is the markup's indent, not text.
  for (let i = 1; i < out.length; i++) {
    if ((out[i - 1] as RichRun).text.endsWith("\n"))
      (out[i] as RichRun).text = (out[i] as RichRun).text.replace(/^ +/, "");
  }
  return out.filter((r) => r.text);
}

// ── Pieces ─────────────────────────────────────────────────────────────────────────────────────────────────────

function round(n: number): number {
  return Math.round(n * 2) / 2;
}

function textStyleOf(s: Computed, lineHeight: number, valign: PieceTextStyle["valign"]): PieceTextStyle {
  return {
    ...(s.font ? { font: s.font } : {}),
    size: Math.round(s.size * 100) / 100,
    weight: s.weight,
    ...(s.color ? { color: s.color } : {}),
    align: s.align,
    valign,
    lineHeight,
    ...(s.tracking ? { tracking: s.tracking } : {}),
    ...(s.caps ? { caps: true } : {}),
  };
}

function richOf(paragraphs: Paragraph[], builder: Builder, base: Computed): RichDoc {
  return paragraphs.map((p): RichParagraph => {
    const lh = builder.lineHeightOf(p.style);
    const baseLh = builder.lineHeightOf(base);
    // A paragraph's own look goes on its runs (its size, weight, font) when it differs from the text box's.
    const own = marksOf(p.style, base, undefined);
    delete own.highlight;
    return {
      ...(p.style.align !== base.align ? { align: p.style.align } : {}),
      ...(p.list ? { list: p.list } : {}),
      ...(Math.abs(lh - baseLh) > 0.01 ? { lineHeight: lh } : {}),
      ...(p.spaceAfter ? { spaceAfter: Math.round(p.spaceAfter) } : {}),
      runs: p.runs.map((r) => ({ ...own, ...r })),
    };
  });
}

/** The name a group takes: the markup's `data-name`, its id, its label, or the first words of its heading. */
function groupName(el: HtmlElement, fallbackText: string): string | undefined {
  const named = el.attrs.get("data-name") ?? el.attrs.get("aria-label") ?? el.id ?? undefined;
  if (named?.trim()) return named.trim().slice(0, 200);
  const text = fallbackText.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 60) : undefined;
}

/**
 * Lays the parsed HTML out at `opts.width` and returns its pieces at positions from the layout's top-left corner,
 * with the groups the markup's containers make (a card: its box, icon, title and text hold together).
 */
export function layoutHtml(parsed: ParsedHtml, opts: LayoutOptions): LayoutResult {
  const builder = new Builder(parsed, opts);
  const root = builder.build(parsed.root, true);
  if (!root) return { pieces: [], groups: [], arrows: [], width: opts.width, height: 0, notes: [...builder.notes] };
  root.yoga.setWidth(opts.width);
  if (opts.height !== undefined) root.yoga.setHeight(opts.height);
  root.yoga.calculateLayout(opts.width, opts.height, Direction.LTR);

  const pieces: Piece[] = [];
  const groups: LiveGroup[] = [];
  const notes = new Set(builder.notes);

  /** Walks the layout: each node's pieces, and the group it makes. Returns how many pieces it made. */
  /** The pieces each element made, its own and its children's: where an arrow to it lands. */
  const made = new Map<HtmlElement, { start: number; end: number }>();
  const walk = (node: LNode, ox: number, oy: number, group: string | undefined): number => {
    const l = node.yoga.getComputedLayout();
    const x = ox + l.left;
    const y = oy + l.top;
    const box: PieceBox = { x: round(x), y: round(y), w: round(l.width), h: round(l.height) };
    const s = node.style;
    const start = pieces.length;
    // An element that draws a box, or that the markup names, groups what it holds (a card, a column).
    const el = node.el;
    const named = !!el && (el.attrs.has("data-name") || !!el.id);
    const look = node.kind === "box" && !!el && hasLook(s);
    const groupId = (look || named) && node.children.length > 0 ? newId() : undefined;
    const inner = groupId ?? group;

    if (node.kind === "box" && look) {
      const piece: BoxPiece = {
        kind: "box",
        box,
        ...(s.background ? { fill: s.background } : { fill: "none" }),
        ...(s.gradient ? { gradient: s.gradient } : {}),
        ...(s.radius ? { radius: Math.min(s.radius, Math.min(box.w, box.h) / 2) } : {}),
        ...(s.shadow ? { shadow: s.shadow } : {}),
        ...(s.opacity < 1 ? { opacity: s.opacity } : {}),
        ...(inner ? { group: inner } : {}),
      };
      const bw = Math.max(...s.border);
      if (bw > 0) {
        const color = s.borderColor.find((c) => c && c !== "none") ?? s.color ?? "#000000";
        piece.stroke = color;
        piece.strokeWidth = bw;
        if (s.borderStyle === "dashed" || s.borderStyle === "dotted") piece.dash = s.borderStyle;
        if (!s.border.every((b) => b === bw)) notes.add("borders on some sides only are drawn on every side");
      } else piece.stroke = "none";
      // A box whose only content is one text, with even padding, is one native piece: the shape and its label.
      const only = node.children.length === 1 ? node.children[0] : undefined;
      const pads = s.padding;
      const even = Math.max(...pads) - Math.min(...pads) <= 2;
      const tl = only?.yoga.getComputedLayout();
      const contentWidth = l.width - s.border[1] - s.border[3] - pads[1] - pads[3];
      // Uneven padding still makes one piece when it is symmetric and the text fills its line (a badge, a pill):
      // centered in the shape, it lands where it was.
      const symmetric = Math.abs(pads[1] - pads[3]) <= 2 && Math.abs(pads[0] - pads[2]) <= 2;
      const fills = !!tl && tl.width >= contentWidth - 2;
      const centered = !even && symmetric && (fills || only?.style.align === "center");
      if (
        only &&
        tl &&
        only.kind === "text" &&
        only.paragraphs &&
        (even || centered) &&
        !(el && (el.attrs.has("data-name") || el.id))
      ) {
        const contentTop = s.border[0] + pads[0];
        const contentBottom = l.height - s.border[2] - pads[2];
        const above = tl.top - contentTop;
        const below = contentBottom - (tl.top + tl.height);
        const valign = Math.abs(above - below) <= 2 && above > 1 ? "middle" : below < above ? "bottom" : "top";
        const lh = builder.lineHeightOf(only.style);
        piece.text = richOf(only.paragraphs, builder, only.style);
        piece.textStyle = textStyleOf(only.style, lh, valign);
        // Where the text sits across the box says its alignment (a number centered in a circle by flex).
        const left = tl.left - (s.border[3] + pads[3]);
        const right = contentWidth - (left + tl.width);
        const across = Math.abs(left - right) <= 2 && left > 1 ? "center" : right + 1 < left ? "right" : null;
        if (centered || across === "center") piece.textStyle.align = "center";
        else if (across === "right") piece.textStyle.align = "right";
        piece.padding = Math.round(Math.min(...pads) + Math.min(...s.border));
        if (group) piece.group = group;
        else delete piece.group;
        pieces.push(piece);
        return pieces.length - start;
      }
      pieces.push(piece);
    }

    if (node.kind === "text" && node.paragraphs) {
      const lh = builder.lineHeightOf(s);
      const textBox = { ...box };
      // Room for the apps' own text widths: a line laid out here must never wrap there.
      const slack = Math.min(24, Math.max(2, textBox.w * 0.03));
      if (s.align === "center") {
        textBox.x = round(textBox.x - slack / 2);
        textBox.w = round(textBox.w + slack);
      } else if (s.align === "right") {
        textBox.x = round(textBox.x - slack);
        textBox.w = round(textBox.w + slack);
      } else textBox.w = round(textBox.w + slack);
      const piece: TextPiece = {
        kind: "text",
        box: textBox,
        text: richOf(node.paragraphs, builder, s),
        style: textStyleOf(s, lh, "top"),
        ...(inner ? { group: inner } : {}),
      };
      pieces.push(piece);
    } else if (node.kind === "picture" && node.picture) {
      const piece: ImagePiece = {
        kind: "image",
        box,
        picture: node.picture,
        fit: s.fit,
        ...(el?.attrs.get("alt") ? { alt: el.attrs.get("alt") } : {}),
        ...(s.radius ? { radius: Math.min(s.radius, Math.min(box.w, box.h) / 2) } : {}),
        ...(s.shadow ? { shadow: s.shadow } : {}),
        ...(s.opacity < 1 ? { opacity: s.opacity } : {}),
        ...(inner ? { group: inner } : {}),
      };
      pieces.push(piece);
    } else if (node.kind === "line") {
      const width = Math.max(1, ...s.border.filter((b) => b > 0));
      const color = s.borderColor.find((c) => c && c !== "none") ?? s.color ?? "#808080";
      pieces.push({
        kind: "line",
        box: { x: box.x, y: box.y, w: box.w, h: 0 },
        stroke: color,
        width,
        ...(s.borderStyle === "dashed" || s.borderStyle === "dotted" ? { dash: s.borderStyle } : {}),
        ...(inner ? { group: inner } : {}),
      });
    } else if (node.kind === "table" && node.rows) {
      pieces.push({
        kind: "table",
        box,
        rows: node.rows,
        header: node.header === true,
        ...(inner ? { group: inner } : {}),
      });
    }

    let count = pieces.length - start;
    for (const child of node.children) count += walk(child, x, y, inner);
    if (el) made.set(el, { start, end: pieces.length });
    if (groupId) {
      if (count >= 2) {
        const text =
          pieces
            .slice(start)
            .map((p) => (p.kind === "text" ? p.text.map((pp) => pp.runs.map((r) => r.text).join("")).join(" ") : ""))
            .find((t) => t.trim()) ?? "";
        const name = el ? groupName(el, text) : undefined;
        groups.push({ id: groupId, ...(name ? { name } : {}), ...(group ? { parent: group } : {}) });
      } else {
        // A group of one piece is no group: its piece belongs to the group outside.
        for (const p of pieces.slice(start)) {
          if (p.group === groupId) {
            if (group) p.group = group;
            else delete p.group;
          }
        }
      }
    }
    return count;
  };

  const rootGroup = newId();
  const total = walk(root, 0, 0, rootGroup);
  const layout = root.yoga.getComputedLayout();
  root.yoga.freeRecursive();
  const direct = pieces.filter((p) => p.group === rootGroup).length;
  const childGroups = groups.filter((g) => g.parent === rootGroup);
  if (total >= 2 && !(direct === 0 && childGroups.length === 1)) {
    const name = opts.name ?? groupName(parsed.root, "") ?? undefined;
    groups.push({ id: rootGroup, ...(name ? { name } : {}) });
  } else {
    // A root that only wraps one group is that group.
    for (const p of pieces) if (p.group === rootGroup) delete p.group;
    for (const g of childGroups) {
      delete g.parent;
      if (opts.name && !g.name) g.name = opts.name;
    }
  }
  if (opts.height !== undefined && layout.height > opts.height + 1) {
    notes.add(`the content is ${Math.round(layout.height - opts.height)} units taller than its box`);
  }
  for (const n of parsed.notes) notes.add(n);
  const arrows = layoutArrows(parsed.root, made, pieces, notes);
  return { pieces, groups, arrows, width: layout.width, height: layout.height, notes: [...notes] };
}

/**
 * The arrows the markup asks for: an element's `data-arrow-to` (an id, or several with commas) joins its piece to each
 * named element's, with `data-arrow-label` and `data-arrow-color`. An element's piece is its own box when it has one,
 * else the biggest piece it made.
 */
function layoutArrows(
  root: HtmlElement,
  made: ReadonlyMap<HtmlElement, { start: number; end: number }>,
  pieces: readonly Piece[],
  notes: Set<string>,
): LayoutResult["arrows"] {
  const byId = new Map<string, HtmlElement>();
  const asking: HtmlElement[] = [];
  const walk = (el: HtmlElement) => {
    if (el.id) byId.set(el.id, el);
    if (el.attrs.has("data-arrow-to")) asking.push(el);
    for (const c of el.children) if (typeof c !== "string") walk(c);
  };
  walk(root);
  const pieceOf = (el: HtmlElement): number | null => {
    const range = made.get(el);
    if (!range || range.end <= range.start) return null;
    let best = range.start;
    let area = -1;
    for (let i = range.start; i < range.end; i++) {
      const p = pieces[i];
      if (!p) continue;
      if (p.kind === "box" && i === range.start) return i;
      const a = p.box.w * p.box.h;
      if (a > area) {
        area = a;
        best = i;
      }
    }
    return best;
  };
  const out: LayoutResult["arrows"] = [];
  for (const el of asking) {
    const from = pieceOf(el);
    for (const raw of (el.attrs.get("data-arrow-to") ?? "").split(",")) {
      const id = raw.trim().replace(/^#/, "");
      if (!id) continue;
      const target = byId.get(id);
      const to = target ? pieceOf(target) : null;
      if (from === null || to === null) {
        notes.add(`an arrow to "${id.slice(0, 40)}" has no element to land on`);
        continue;
      }
      const color = parseColor(el.attrs.get("data-arrow-color"));
      const label = el.attrs.get("data-arrow-label")?.trim();
      out.push({
        from,
        to,
        ...(label ? { label: label.slice(0, 200) } : {}),
        ...(color && color !== "none" ? { color: opaque(color) } : {}),
      });
    }
  }
  return out;
}

/** Words of an `add_html` result for the agent: what it made, and what it left out. */
/**
 * The color each picture is drawn in where the markup names one of our icons (`icon:<name>`): the text color its
 * element computes, as a browser draws an SVG in `currentColor`; the root inherits `base`.
 */
export function pictureInks(parsed: ParsedHtml, base: LayoutOptions["base"]): Map<string, string> {
  const cascade = new Cascade(parsed, { base, fontNamed: () => null });
  const out = new Map<string, string>();
  const walk = (el: HtmlElement, parent: Computed | null) => {
    const s = cascade.compute(el, parent);
    if (el.picture) {
      if (s.color) out.set(el.picture, s.color);
      return;
    }
    for (const c of el.children) if (typeof c !== "string") walk(c, s);
  };
  walk(parsed.root, null);
  return out;
}

export function layoutSummary(result: LayoutResult): string {
  const counts = new Map<string, number>();
  for (const p of result.pieces) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
  const made = [...counts].map(([k, n]) => `${n} ${k}${n === 1 ? "" : k === "box" ? "es" : "s"}`).join(", ");
  const groups = result.groups.length ? `; ${result.groups.length} group${result.groups.length === 1 ? "" : "s"}` : "";
  const arrows = result.arrows.length ? `; ${result.arrows.length} arrow${result.arrows.length === 1 ? "" : "s"}` : "";
  const notes = result.notes.length ? ` Left out or changed: ${result.notes.join("; ")}.` : "";
  return `${made || "nothing"}${groups}${arrows}, ${Math.round(result.width)}×${Math.round(result.height)}.${notes}`;
}

export { words };

/**
 * Markup as rich text, no layout (what `set_text` takes as `html`): each block a paragraph (list items as list
 * paragraphs, nested lists a level deeper), inline styles as marks relative to `base`, the text box's own look.
 */
export function htmlToRich(parsed: ParsedHtml, base: LayoutOptions["base"]): RichDoc {
  const builder = new Builder(parsed, {
    width: 1000,
    base,
    fontNamed: () => null,
    measurer: { width: () => 0, extent: () => ({ ascent: 0.9, descent: 0.25 }) } as unknown as TextMeasurer,
    pictures: new Map(),
    tables: false,
  });
  const rootStyle = builder.styleOf(parsed.root);
  const out: RichParagraph[] = [];
  const inlineGroup = (items: (HtmlElement | string)[], list?: "bullet" | "ordered", level = 0) => {
    const holder: HtmlElement = { ...parsed.root, children: items, parent: parsed.root };
    const runs = builder.runsOf(holder, rootStyle);
    if (runs.some((r) => r.text.trim())) out.push({ ...(list ? { list } : {}), ...(level ? { level } : {}), runs });
  };
  const walk = (el: HtmlElement, list: "bullet" | "ordered" | undefined, level: number) => {
    let pending: (HtmlElement | string)[] = [];
    const flush = () => {
      if (pending.length) inlineGroup(pending, el.tag === "li" ? list : undefined, el.tag === "li" ? level : 0);
      pending = [];
    };
    for (const c of el.children) {
      if (typeof c === "string") {
        pending.push(c);
        continue;
      }
      const cs = builder.styleOf(c);
      if (cs.display === "none" || c.picture) continue;
      if (cs.display === "inline" || cs.display === "inline-block") {
        pending.push(c);
        continue;
      }
      flush();
      const nested = c.tag === "ul" || c.tag === "ol";
      const kind = nested
        ? cs.listStyle === "none"
          ? undefined
          : cs.listStyle === "decimal"
            ? "ordered"
            : "bullet"
        : list;
      walk(c, kind, nested && list ? level + 1 : level);
    }
    flush();
  };
  walk(parsed.root, undefined, 0);
  return out;
}

/** The pictures a document's markup names, by their key, as the file's asset ids (resolved by the caller). */
export type BlockPictures = ReadonlyMap<string, { asset: string; w: number }>;

/** The page width a document's pictures are sized against (a CSS width in px becomes a fraction of it). */
const DOC_PAGE = 720;

/**
 * Markup as a document's blocks (ADR 0220 §4): headings, paragraphs with their marks, lists by level, quotes, code,
 * rules, pictures and tables. A heading keeps the document's own heading size; a font, a color, a weight, letter
 * spacing or capitals the markup gives it become marks on its words.
 */
export function htmlToBlocks(parsed: ParsedHtml, pictures: BlockPictures): import("@agenteschat/live").DocBlock[] {
  type DocBlock = import("@agenteschat/live").DocBlock;
  type DocParagraph = import("@agenteschat/live").DocParagraph;
  const builder = new Builder(parsed, {
    width: DOC_PAGE,
    base: { size: 16 },
    fontNamed: () => null,
    measurer: { width: () => 0, extent: () => ({ ascent: 0.9, descent: 0.25 }) } as unknown as TextMeasurer,
    pictures: new Map(),
    tables: false,
  });
  const root = builder.styleOf(parsed.root);
  /** What a block's words are measured against: its own size, the document's font, color and the tag's weight. */
  const baseOf = (s: Computed, weight: FontWeight): Computed => ({
    ...s,
    font: root.font,
    color: root.color,
    weight,
    tracking: 0,
    caps: false,
    italic: false,
    underline: false,
    strike: false,
  });
  const runsOf = (el: HtmlElement, weight: FontWeight) => {
    const s = builder.styleOf(el);
    return builder.runsOf(el, baseOf(s, weight));
  };
  const alignOf = (s: Computed) => (s.align !== "left" ? { align: s.align } : {});
  const holder = (items: (HtmlElement | string)[], parent: HtmlElement): HtmlElement => {
    const h: HtmlElement = { ...parent, children: items };
    return h;
  };
  const out: DocBlock[] = [];
  const paragraph = (
    el: HtmlElement,
    items: (HtmlElement | string)[],
    extra: Partial<DocParagraph>,
    into: DocBlock[],
  ) => {
    const h = holder(items, el);
    builder.computedFor(h, builder.styleOf(el));
    const runs = runsOf(h, 400);
    if (runs.some((r) => r.text.trim()))
      into.push({ type: "paragraph", ...alignOf(builder.styleOf(el)), ...extra, runs });
  };
  const walk = (el: HtmlElement, list: "bullet" | "ordered" | undefined, level: number, into: DocBlock[]) => {
    let pending: (HtmlElement | string)[] = [];
    const flush = () => {
      if (pending.some((p) => typeof p !== "string" || p.trim())) {
        paragraph(el, pending, el.tag === "li" && list ? { list, ...(level ? { level } : {}) } : {}, into);
      }
      pending = [];
    };
    for (const c of el.children) {
      if (typeof c === "string") {
        pending.push(c);
        continue;
      }
      const s = builder.styleOf(c);
      if (s.display === "none") continue;
      if (c.picture) {
        flush();
        const picture = pictures.get(c.picture);
        if (picture) {
          const css = s.width && s.width !== "auto" ? s.width : null;
          const width = css ? ("percent" in css ? css.percent / 100 : css.px / DOC_PAGE) : picture.w / DOC_PAGE;
          into.push({
            type: "image",
            asset: picture.asset,
            ...(c.attrs.get("alt") ? { alt: (c.attrs.get("alt") ?? "").slice(0, 500) } : {}),
            ...(width < 1 ? { width: Math.max(0.1, Math.round(width * 100) / 100) } : {}),
          });
        }
        continue;
      }
      if (s.display === "inline" || s.display === "inline-block") {
        pending.push(c);
        continue;
      }
      flush();
      const heading = /^h([1-6])$/.exec(c.tag);
      if (heading) {
        const level = Math.min(3, Number(heading[1])) as 1 | 2 | 3;
        const runs = runsOf(c, 700);
        if (runs.some((r) => r.text.trim())) into.push({ type: "heading", level, ...alignOf(s), runs });
      } else if (c.tag === "hr") into.push({ type: "horizontal_rule" });
      else if (c.tag === "pre") {
        const code = c.children.find((x): x is HtmlElement => typeof x !== "string" && x.tag === "code");
        const language = /language-([a-z0-9_+#.-]+)/i.exec((code ?? c).classes.join(" "))?.[1];
        const text = (function plain(e: HtmlElement): string {
          return e.children.map((x) => (typeof x === "string" ? x : x.tag === "br" ? "\n" : plain(x))).join("");
        })(c);
        into.push({ type: "code_block", ...(language ? { language } : {}), text: text.replace(/\n$/, "") });
      } else if (c.tag === "blockquote") {
        const inner: DocBlock[] = [];
        walk(c, undefined, 0, inner);
        if (inner.length) into.push({ type: "blockquote", blocks: inner });
      } else if (c.tag === "table") {
        const rows: HtmlElement[] = [];
        (function collect(e: HtmlElement) {
          for (const x of e.children) if (typeof x !== "string") x.tag === "tr" ? rows.push(x) : collect(x);
        })(c);
        const cells = rows.map((r) =>
          r.children
            .filter((x): x is HtmlElement => typeof x !== "string" && (x.tag === "td" || x.tag === "th"))
            .map((cell) => {
              const h = holder(cell.children, cell);
              builder.computedFor(h, builder.styleOf(cell));
              const runs = runsOf(h, 400);
              return { blocks: [{ type: "paragraph" as const, runs: runs.length ? runs : [{ text: "" }] }] };
            }),
        );
        const header = rows[0]?.children.some((x) => typeof x !== "string" && x.tag === "th");
        if (cells.length) into.push({ type: "table", ...(header ? { header: true as const } : {}), rows: cells });
      } else if (c.tag === "ul" || c.tag === "ol") {
        const kind = s.listStyle === "none" ? undefined : s.listStyle === "decimal" ? "ordered" : "bullet";
        walk(c, kind, list ? level + 1 : level, into);
      } else walk(c, list, level, into);
    }
    flush();
  };
  walk(parsed.root, undefined, 0, out);
  return out;
}
