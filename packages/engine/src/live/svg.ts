import { DOMParser, type Element, type Node } from "@xmldom/xmldom";
import { sniffModelImage } from "../avatars";
import { ValidationError } from "../errors";
import { xmlAttr, xmlText } from "../office/xml";

/**
 * SVG pictures in live files (ADR 0196 §8): an icon, a logo, a diagram or an illustration an agent writes, or an SVG
 * found on the web. What is stored is never the text that came in: it is parsed, rebuilt from an allowlist of SVG's
 * static drawing elements and attributes, and written out again, so only shapes, paths, text, gradients, patterns,
 * masks, clips, markers and filters remain. Gone are scripts, event handlers, `foreignObject`, embedded or linked
 * pictures, animations, links, every address that isn't a reference inside the picture (`#id`), at-rules and outside
 * references in CSS; a document type with declarations (entities) is refused before parsing. Sizes are capped: the
 * text, its elements, their depth, one attribute (a path), and what `<use>` multiplies once expanded.
 *
 * The apps only ever show it as a picture (`<img>`, an SVG `<image>`, the phone's image view), where a browser runs
 * nothing and loads nothing anyway, and the server sends it with a CSP that allows neither. It is written with
 * explicit `width`, `height` and `viewBox`: its natural size, which canvases and slides read like a photo's.
 */

export const SVG_TYPE = "image/svg+xml";

export const SVG_LIMITS = {
  /** The text, in bytes (an SVG from the web may be a big illustration). */
  bytes: 1_000_000,
  /** What one tool call may write for one picture. */
  chars: 300_000,
  elements: 10_000,
  depth: 48,
  attributes: 64,
  /** One attribute's value (a path's `d`, a polygon's points). */
  valueChars: 300_000,
  /** All the text it shows, together. */
  textChars: 50_000,
  /** `<use>` elements, and the elements drawn once each one is expanded. */
  uses: 1_000,
  drawn: 50_000,
  /** The natural size's longer side: a small icon is scaled up to the least, a huge drawing down to the most. */
  minSide: 512,
  maxSide: 4096,
} as const;

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_NODE = 4;

/** SVG's static drawing elements, by their exact (case-sensitive) names. */
const ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "title",
  "desc",
  "style",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textPath",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
  "pattern",
  "marker",
  "filter",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
]);

/** Elements left out but their content kept: a link around shapes, a `switch` between them. */
const UNWRAP = new Set(["a", "switch"]);

/** What a removed element was, in a few words for the agent (anything else unknown is named as it is). */
const REMOVED_AS: Record<string, string> = {
  script: "scripts",
  foreignObject: "embedded HTML (foreignObject)",
  image: "embedded or linked pictures",
  feImage: "embedded or linked pictures",
  animate: "animations",
  animateMotion: "animations",
  animateTransform: "animations",
  animateColor: "animations",
  set: "animations",
  mpath: "animations",
  discard: "animations",
  iframe: "embedded content",
  embed: "embedded content",
  object: "embedded content",
  video: "embedded content",
  audio: "embedded content",
  canvas: "embedded content",
  font: "fonts",
  "font-face": "fonts",
  cursor: "cursors",
};

/** Dropped without a word: editors' metadata. */
const SILENT = new Set(["metadata", "namedview", "sodipodi:namedview", "view"]);

/** Where text is kept (elsewhere whitespace between tags is all there is). */
const TEXT_HOLDERS = new Set(["text", "tspan", "textPath", "title", "desc", "style"]);

/** Elements that may refer to another element of the picture (`href="#id"`). */
const REFERRERS = new Set(["use", "textPath", "linearGradient", "radialGradient", "pattern", "filter"]);

/** Presentation properties: attributes, and what a `style` attribute may set. */
const PRESENTATION = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "color",
  "display",
  "visibility",
  "overflow",
  "clip-path",
  "clip-rule",
  "mask",
  "filter",
  "vector-effect",
  "shape-rendering",
  "text-rendering",
  "color-interpolation",
  "color-interpolation-filters",
  "paint-order",
  "mix-blend-mode",
  "isolation",
  "marker-start",
  "marker-mid",
  "marker-end",
  "font",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "font-stretch",
  "text-anchor",
  "dominant-baseline",
  "alignment-baseline",
  "baseline-shift",
  "letter-spacing",
  "word-spacing",
  "text-decoration",
  "writing-mode",
  "direction",
  "unicode-bidi",
  "white-space",
  "stop-color",
  "stop-opacity",
  "flood-color",
  "flood-opacity",
  "lighting-color",
  "transform",
  "transform-origin",
  "transform-box",
];

const STYLE_PROPERTIES = new Set(PRESENTATION);

const ATTRIBUTES = new Set([
  ...PRESENTATION,
  "id",
  "class",
  "style",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "fr",
  "width",
  "height",
  "d",
  "points",
  "pathLength",
  "viewBox",
  "preserveAspectRatio",
  "markerWidth",
  "markerHeight",
  "markerUnits",
  "refX",
  "refY",
  "orient",
  "dx",
  "dy",
  "rotate",
  "textLength",
  "lengthAdjust",
  "startOffset",
  "method",
  "spacing",
  "side",
  "offset",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "patternUnits",
  "patternContentUnits",
  "patternTransform",
  "clipPathUnits",
  "maskUnits",
  "maskContentUnits",
  "filterUnits",
  "primitiveUnits",
  "in",
  "in2",
  "result",
  "stdDeviation",
  "mode",
  "operator",
  "k1",
  "k2",
  "k3",
  "k4",
  "values",
  "type",
  "tableValues",
  "slope",
  "intercept",
  "amplitude",
  "exponent",
  "baseFrequency",
  "numOctaves",
  "seed",
  "stitchTiles",
  "scale",
  "xChannelSelector",
  "yChannelSelector",
  "radius",
  "order",
  "kernelMatrix",
  "divisor",
  "bias",
  "targetX",
  "targetY",
  "edgeMode",
  "kernelUnitLength",
  "preserveAlpha",
  "surfaceScale",
  "diffuseConstant",
  "specularConstant",
  "specularExponent",
  "azimuth",
  "elevation",
  "z",
  "pointsAtX",
  "pointsAtY",
  "pointsAtZ",
  "limitingConeAngle",
  "role",
  "aria-label",
  "aria-hidden",
  "focusable",
]);

/** A reference inside the picture: `#id`. */
const LOCAL_REF = /^#[A-Za-z_][\w.:-]{0,200}$/;
const LOCAL_URL = /^\s*(['"]?)#[A-Za-z_][\w.:-]{0,200}\1\s*$/;
/** Schemes that run or carry something, whatever the spacing. */
const SCHEME = /(?:java\s*script|vb\s*script|data|livescript)\s*:/i;

/** What an SVG became: the clean text and its natural size, its title, and what was taken out. */
export interface CleanSvg {
  svg: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  /** The picture's own `<title>`, a good alt text. */
  title: string | null;
  /** What was removed, in a few words each (scripts, event handlers, outside references…). */
  removed: string[];
}

const refuse = (why: string) => new ValidationError(`This SVG can't be used: ${why}`, "live.svg_invalid");

// The text an agent or a web page wrote is read below by index, never by a regex that can try the rest of the text
// again from each `<!--`, `<!DOCTYPE`, `/*` or `url(` left open: that is quadratic (or exponential, for repeated
// comments) in the text's length, and the text is up to `SVG_LIMITS.bytes` long.

const isSpace = (ch: string) => ch !== "" && /\s/.test(ch);

function skipSpaces(text: string, i: number): number {
  let j = i;
  while (isSpace(text.charAt(j))) j++;
  return j;
}

/** Whether `text` has `word` (lowercase ASCII) at `i`, in any case: what a regex's `i` flag matches for ASCII. */
function wordAt(text: string, i: number, word: string): boolean {
  if (i < 0 || i + word.length > text.length) return false;
  for (let k = 0; k < word.length; k++) {
    const c = text.charCodeAt(i + k);
    const w = word.charCodeAt(k);
    if (c !== w && !(w >= 97 && w <= 122 && c === w - 32)) return false;
  }
  return true;
}

/** Where `word` (lowercase ASCII, starting with `<`) next is in `text` from `from`, in any case; -1 when nowhere. */
function indexOfWord(text: string, word: string, from: number): number {
  for (let at = text.indexOf("<", from); at >= 0; at = text.indexOf("<", at + 1)) {
    if (wordAt(text, at, word)) return at;
  }
  return -1;
}

/**
 * Whether a text starts as an SVG's does: an XML declaration, comments and a document type (with declarations too, so
 * the sanitizer says why it refuses one) at most before `<svg`. A comment ends at its first `-->`, as XML reads it.
 */
function startsAsSvg(text: string): boolean {
  let i = skipSpaces(text, 0);
  if (wordAt(text, i, "<?xml")) {
    // `<?xml … ?>`: the declaration ends at its first `>`, which must follow a `?` of its own.
    const close = text.indexOf(">", i + 5);
    if (close < i + 6 || text.charAt(close - 1) !== "?") return false;
    i = skipSpaces(text, close + 1);
  }
  const comments = (): boolean => {
    while (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end < 0) return false;
      i = skipSpaces(text, end + 3);
    }
    return true;
  };
  if (!comments()) return false;
  if (wordAt(text, i, "<!doctype")) {
    let j = i + 9;
    while (j < text.length && text.charAt(j) !== ">" && text.charAt(j) !== "[") j++;
    if (text.charAt(j) === "[") {
      // Its declarations: they end at the first `]` that only spaces separate from a `>`.
      let close = text.indexOf("]", j + 1);
      while (close >= 0 && text.charAt(skipSpaces(text, close + 1)) !== ">") close = text.indexOf("]", close + 1);
      if (close < 0) return false;
      j = skipSpaces(text, close + 1);
    }
    if (text.charAt(j) !== ">") return false;
    i = skipSpaces(text, j + 1);
    if (!comments()) return false;
  }
  const after = text.charAt(i + 4);
  return wordAt(text, i, "<svg") && (isSpace(after) || after === ">" || after === "/" || after === ":");
}

/** Whether bytes are an SVG's text by how they start (the sanitizer is what decides). */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  return startsAsSvg(new TextDecoder().decode(bytes.subarray(0, 4096)).replace(/^\uFEFF/, ""));
}

/**
 * The text without its bare document types (`<!DOCTYPE svg PUBLIC …>`, as editors write), refused when one declares
 * things (`<!DOCTYPE x [ … ]>`): entities are how a few bytes become gigabytes, and how outside files get in. One left
 * open stays, and the parser refuses the text.
 */
function withoutDoctypes(text: string): string {
  let out = "";
  let from = 0;
  for (let at = indexOfWord(text, "<!doctype", 0); at >= 0; at = indexOfWord(text, "<!doctype", from)) {
    let end = at + 9;
    while (end < text.length && text.charAt(end) !== ">" && text.charAt(end) !== "[") end++;
    if (text.charAt(end) === "[") throw refuse("its document type declares things");
    if (end >= text.length) break;
    out += text.slice(from, at);
    from = end + 1;
  }
  return out + text.slice(from);
}

/** CSS without its comments, each from a slash-star to the first star-slash after it; one left open stays. */
function withoutCssComments(css: string): string {
  let out = "";
  let from = 0;
  for (let at = css.indexOf("/*"); at >= 0; at = css.indexOf("/*", from)) {
    const end = css.indexOf("*/", at + 2);
    if (end < 0) break;
    out += css.slice(from, at);
    from = end + 2;
  }
  return out + css.slice(from);
}

/**
 * What every `url(…)` in a value holds, each up to its first `)` (each must be `url(#id)`). One left open holds the
 * rest of the value: CSS reads an unclosed `url(` at the end as an address too.
 */
function urlArguments(value: string): string[] {
  const out: string[] = [];
  const open = /url\s*\(/gi;
  for (let m = open.exec(value); m; m = open.exec(value)) {
    const start = m.index + m[0].length;
    const close = value.indexOf(")", start);
    out.push(value.slice(start, close < 0 ? value.length : close));
    if (close < 0) break;
    open.lastIndex = close + 1;
  }
  return out;
}

interface SvgNode {
  name: string;
  attrs: [string, string][];
  kids: (SvgNode | string)[];
}

/** What is wrong with a CSS text (a `style` attribute or element), or null. */
function cssProblem(css: string): string | null {
  if (css.includes("@")) return "CSS at-rules (@import, @font-face…)";
  if (css.includes("\\")) return "escaped CSS";
  if (css.includes("<")) return "markup in CSS";
  if (/expression\s*\(|-moz-binding|behavior\s*:|image-set\s*\(|\bsrc\s*\(/i.test(css)) return "CSS that loads or runs";
  if (SCHEME.test(css)) return "addresses in CSS";
  for (const arg of urlArguments(css)) if (!LOCAL_URL.test(arg)) return "outside references in CSS";
  return null;
}

/** What is wrong with an attribute's value, or null. */
function valueProblem(value: string): string | null {
  if (SCHEME.test(value)) return "script or data addresses";
  if (/expression\s*\(/i.test(value)) return "CSS that runs";
  for (const arg of urlArguments(value)) if (!LOCAL_URL.test(arg)) return "outside references";
  return null;
}

/** A `style` attribute with only presentation properties whose values are safe; null when nothing is left. */
function cleanStyleAttr(style: string, removed: Set<string>): string | null {
  const problem = cssProblem(style);
  if (problem) {
    removed.add(problem);
    return null;
  }
  const kept: string[] = [];
  for (const declaration of withoutCssComments(style).split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const prop = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (!prop || !value) continue;
    if (!STYLE_PROPERTIES.has(prop)) continue;
    kept.push(`${prop}:${value}`);
  }
  return kept.length > 0 ? kept.join(";") : null;
}

/** A length as user units (px), when it is absolute: `24`, `24px`, `10mm`; null for `%`, `em` and the like. */
function lengthPx(raw: string | null): number | null {
  if (raw === null) return null;
  // Each part reads one way only: `\d+\.?\d*` or `\s*(px)?\s*` could split a long run many ways (quadratic).
  const m = /^\s*([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(?:(px|pt|pc|mm|cm|in)\s*)?$/i.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "px").toLowerCase();
  const scale = { px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 }[unit] ?? 1;
  const px = n * scale;
  return Number.isFinite(px) && px > 0 ? px : null;
}

function viewBoxOf(raw: string | null): [number, number, number, number] | null {
  if (raw === null) return null;
  const parts = raw
    .trim()
    .split(/[\s,]+/)
    .map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) return null;
  const [x, y, w, h] = parts as [number, number, number, number];
  return w > 0 && h > 0 ? [x, y, w, h] : null;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * An SVG's text made safe to store and show (see the file's comment): refused with `live.svg_invalid` saying why when
 * it can't be read, is too big, declares entities, isn't an `<svg>` or has no size (no `viewBox`, no `width` and
 * `height`).
 */
export function sanitizeSvg(input: string | Uint8Array): CleanSvg {
  let text: string;
  if (typeof input === "string") text = input;
  else {
    if (input.byteLength > SVG_LIMITS.bytes) throw refuse(`it is over ${SVG_LIMITS.bytes / 1000} KB`);
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      throw refuse("it isn't UTF-8 text");
    }
  }
  text = text.replace(/^\uFEFF/, "");
  if (new TextEncoder().encode(text).byteLength > SVG_LIMITS.bytes) {
    throw refuse(`it is over ${SVG_LIMITS.bytes / 1000} KB`);
  }
  // Entities are how a few bytes become gigabytes (and how outside files get in): a document type with declarations
  // is refused; a bare one (`<!DOCTYPE svg PUBLIC …>`, as editors write) is only dropped.
  if (/<!ENTITY/i.test(text)) throw refuse("it declares entities");
  text = withoutDoctypes(text);
  const entity = /&(?!(?:lt|gt|amp|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});)[^\s;]{0,32};?/.exec(text);
  if (entity) throw refuse(`it uses an undefined entity (${entity[0].slice(0, 20)})`);
  let tags = 0;
  for (let i = text.indexOf("<"); i !== -1; i = text.indexOf("<", i + 1)) {
    if (++tags > SVG_LIMITS.elements * 2 + 64) throw refuse(`it has over ${SVG_LIMITS.elements} elements`);
  }

  let root: Element | null = null;
  try {
    const parser = new DOMParser({
      locator: false,
      onError: (level, message) => {
        if (level !== "warning") throw new Error(message);
      },
    });
    root = parser.parseFromString(declarePrefixes(text), "image/svg+xml").documentElement as Element | null;
  } catch (error) {
    throw refuse(`it isn't well-formed XML (${String(error instanceof Error ? error.message : error).slice(0, 120)})`);
  }
  if (!root || nameOf(root) !== "svg" || !inSvg(root)) throw refuse("its root isn't an <svg> element");

  const removed = new Set<string>();
  const ids = new Map<string, SvgNode>();
  let elements = 0;
  let textChars = 0;
  let uses = 0;

  const cleanAttrs = (el: Element, name: string): [string, string][] => {
    const out: [string, string][] = [];
    const attrs = el.attributes;
    if (attrs.length > SVG_LIMITS.attributes * 4)
      throw refuse(`an element has over ${SVG_LIMITS.attributes} attributes`);
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs.item(i);
      if (!a) continue;
      const qname = a.nodeName;
      const local = a.localName ?? qname.slice(qname.indexOf(":") + 1);
      const ns = a.namespaceURI ?? null;
      const value = a.value;
      if (qname === "xmlns" || qname.startsWith("xmlns:")) continue;
      if (value.length > SVG_LIMITS.valueChars) throw refuse(`the ${local} of a <${name}> is too long`);
      if (/^on/i.test(local)) {
        removed.add("event handlers");
        continue;
      }
      if (local === "href" && (ns === XLINK_NS || ns === null)) {
        if (REFERRERS.has(name) && LOCAL_REF.test(value.trim())) out.push(["xlink:href", value.trim()]);
        else removed.add("links and outside references");
        continue;
      }
      if (ns === XML_NS) {
        if (local === "space" && (value === "preserve" || value === "default")) out.push(["xml:space", value]);
        continue;
      }
      // Editors' own attributes (inkscape:…, sodipodi:…) and anything else outside SVG's own names.
      if (ns !== null || !ATTRIBUTES.has(local)) continue;
      if (local === "style") {
        const style = cleanStyleAttr(value, removed);
        if (style) out.push(["style", style]);
        continue;
      }
      const problem = valueProblem(value);
      if (problem) {
        removed.add(problem);
        continue;
      }
      if (local === "numOctaves") {
        const n = Number(value);
        out.push([local, Number.isFinite(n) ? String(Math.max(0, Math.min(8, Math.round(n)))) : "1"]);
        continue;
      }
      out.push([local, value]);
    }
    if (out.length > SVG_LIMITS.attributes) throw refuse(`an element has over ${SVG_LIMITS.attributes} attributes`);
    return out;
  };

  const walk = (el: Element, depth: number, into: (SvgNode | string)[], parent: string) => {
    if (depth > SVG_LIMITS.depth) throw refuse(`its elements nest over ${SVG_LIMITS.depth} deep`);
    const name = nameOf(el);
    if (!inSvg(el)) return; // another vocabulary (an editor's metadata, XHTML): never drawn
    if (UNWRAP.has(name)) {
      if (name === "a") removed.add("links and outside references");
      // Its content goes where it was, as its parent's (a link's words inside a <text> stay text).
      for (let n = el.firstChild; n; n = n.nextSibling) visit(n, depth + 1, into, parent);
      return;
    }
    if (!ELEMENTS.has(name)) {
      if (!SILENT.has(name)) removed.add(REMOVED_AS[name] ?? `<${name.slice(0, 40)}>`);
      return;
    }
    if (++elements > SVG_LIMITS.elements) throw refuse(`it has over ${SVG_LIMITS.elements} elements`);
    if (name === "use" && ++uses > SVG_LIMITS.uses) throw refuse(`it has over ${SVG_LIMITS.uses} <use> elements`);
    const node: SvgNode = { name, attrs: cleanAttrs(el, name), kids: [] };
    if (name === "style") {
      let css = "";
      for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === TEXT_NODE || n.nodeType === CDATA_NODE) css += (n as unknown as { data: string }).data;
      }
      const problem = cssProblem(css);
      if (problem) {
        removed.add(problem);
        return;
      }
      textChars += css.length;
      if (textChars > SVG_LIMITS.textChars) throw refuse(`it holds over ${SVG_LIMITS.textChars} characters of text`);
      if (css.trim()) node.kids.push(css);
      into.push(node);
      return;
    }
    const id = node.attrs.find(([k]) => k === "id")?.[1];
    if (id && !ids.has(id)) ids.set(id, node);
    for (let n = el.firstChild; n; n = n.nextSibling) visit(n, depth + 1, node.kids, name);
    into.push(node);
  };

  const visit = (n: Node, depth: number, into: (SvgNode | string)[], parent: string) => {
    if (n.nodeType === ELEMENT_NODE) walk(n as Element, depth, into, parent);
    else if ((n.nodeType === TEXT_NODE || n.nodeType === CDATA_NODE) && TEXT_HOLDERS.has(parent)) {
      const data = (n as unknown as { data: string }).data;
      textChars += data.length;
      if (textChars > SVG_LIMITS.textChars) throw refuse(`it holds over ${SVG_LIMITS.textChars} characters of text`);
      into.push(data);
    }
    // Comments and processing instructions go.
  };

  const top: (SvgNode | string)[] = [];
  walk(root, 0, top, "");
  const svg = top[0];
  if (!svg || typeof svg === "string") throw refuse("its root isn't an <svg> element");

  // `<use>` draws what it names again: a few of them nested can ask for billions of shapes, or for themselves.
  const weight = new Map<SvgNode, number>();
  const weighing = new Set<SvgNode>();
  const weigh = (node: SvgNode, depth: number): number => {
    const known = weight.get(node);
    if (known !== undefined) return known;
    if (weighing.has(node)) throw refuse("a <use> draws an element that holds it");
    if (depth > SVG_LIMITS.depth + SVG_LIMITS.uses) throw refuse("its <use> elements nest too deep");
    weighing.add(node);
    let total = 1;
    for (const kid of node.kids) if (typeof kid !== "string") total += weigh(kid, depth + 1);
    if (node.name === "use") {
      const ref = node.attrs.find(([k]) => k === "xlink:href")?.[1];
      const target = ref ? ids.get(ref.slice(1)) : undefined;
      if (target) total += weigh(target, depth + 1);
    }
    if (total > SVG_LIMITS.drawn)
      throw refuse(`it draws over ${SVG_LIMITS.drawn} elements once its <use>s are expanded`);
    weighing.delete(node);
    weight.set(node, total);
    return total;
  };
  weigh(svg, 0);

  // Its natural size: width and height when absolute, else the viewBox's; always written out with a viewBox.
  const attr = (name: string) => svg.attrs.find(([k]) => k === name)?.[1] ?? null;
  const box = viewBoxOf(attr("viewBox"));
  let w = lengthPx(attr("width"));
  let h = lengthPx(attr("height"));
  if (box) {
    if (w === null && h === null) [w, h] = [box[2], box[3]];
    else if (w === null && h !== null) w = (h * box[2]) / box[3];
    else if (h === null && w !== null) h = (w * box[3]) / box[2];
  }
  if (w === null || h === null) throw refuse("it has no size: give the <svg> a viewBox (or a width and a height)");
  const viewBox = box ?? [0, 0, w, h];
  const long = Math.max(w, h);
  const scale =
    long < SVG_LIMITS.minSide ? SVG_LIMITS.minSide / long : long > SVG_LIMITS.maxSide ? SVG_LIMITS.maxSide / long : 1;
  const width = Math.max(1, Math.round(w * scale));
  const height = Math.max(1, Math.round(h * scale));
  const rest = svg.attrs.filter(([k]) => k !== "width" && k !== "height" && k !== "viewBox" && k !== "x" && k !== "y");
  svg.attrs = [
    ["width", String(width)],
    ["height", String(height)],
    ["viewBox", viewBox.map(round).join(" ")],
    ...rest,
  ];

  const xlink = [...weight.keys()].some((n) => n.attrs.some(([k]) => k === "xlink:href"));
  const out: string[] = [];
  const write = (node: SvgNode, isRoot: boolean) => {
    out.push(`<${node.name}`);
    if (isRoot) out.push(` xmlns="${SVG_NS}"${xlink ? ` xmlns:xlink="${XLINK_NS}"` : ""}`);
    for (const [k, v] of node.attrs) out.push(` ${k}="${xmlAttr(v)}"`);
    if (node.kids.length === 0) {
      out.push("/>");
      return;
    }
    out.push(">");
    for (const kid of node.kids) {
      if (typeof kid === "string") out.push(xmlText(kid));
      else write(kid, false);
    }
    out.push(`</${node.name}>`);
  };
  write(svg, true);
  const clean = out.join("");
  const titleNode = svg.kids.find((k): k is SvgNode => typeof k !== "string" && k.name === "title");
  const title = titleNode
    ? titleNode.kids
        .filter((k): k is string => typeof k === "string")
        .join("")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300) || null
    : null;
  return {
    svg: clean,
    bytes: new TextEncoder().encode(clean),
    width,
    height,
    title,
    removed: [...removed],
  };
}

const USED_PREFIX = /<\/?([A-Za-z_][\w.-]*):[A-Za-z_]|\s([A-Za-z_][\w.-]*):[A-Za-z_][\w.-]*\s*=/g;
const DECLARED_PREFIX = /\sxmlns:([A-Za-z_][\w.-]*)\s*=/g;

/**
 * The text with a declaration for every prefix it uses but never declares (`xlink:href` written without
 * `xmlns:xlink`, as people and models often do): the parser refuses such a text otherwise. `xlink` gets its own
 * namespace; any other prefix one nobody draws, so what it marks is left out.
 */
function declarePrefixes(text: string): string {
  const declared = new Set<string>(["xml", "xmlns"]);
  for (const m of text.matchAll(DECLARED_PREFIX)) declared.add(m[1] as string);
  const missing = new Set<string>();
  for (const m of text.matchAll(USED_PREFIX)) {
    const prefix = (m[1] ?? m[2]) as string;
    if (!declared.has(prefix)) missing.add(prefix);
    if (missing.size > 32) break;
  }
  if (missing.size === 0) return text;
  const root = /<[A-Za-z_][\w.:-]*/.exec(text);
  if (!root) return text;
  const at = root.index + root[0].length;
  const declarations = [...missing]
    .map((p) => ` xmlns:${p}="${p === "xlink" ? XLINK_NS : `urn:agentes:unbound:${p}`}"`)
    .join("");
  return text.slice(0, at) + declarations + text.slice(at);
}

/** An element's local name (`svg:path` → `path`). */
function nameOf(el: Element): string {
  return el.localName ?? el.nodeName.slice(el.nodeName.indexOf(":") + 1);
}

/** Whether an element is SVG's: its namespace, or none (a fragment written without `xmlns`). */
function inSvg(el: Element): boolean {
  const ns = el.namespaceURI ?? null;
  return ns === SVG_NS || ns === null;
}

/**
 * Draws an SVG as a PNG, for what can't show an SVG: a model looking at a picture, a pptx, a PDF, references sent to
 * an image AI. None by default (the server needs a rasterizer for it); without one those leave SVG pictures out.
 */
export type SvgRasterizer = (svg: Uint8Array) => Promise<Uint8Array | null>;

let rasterizer: SvgRasterizer | null = null;

/** Sets (or, with null, unsets) how this process draws SVGs as PNGs. */
export function setSvgRasterizer(fn: SvgRasterizer | null) {
  rasterizer = fn;
}

/**
 * A picture as a PNG, JPEG, WebP or GIF: itself when it is one, a PNG drawn from an SVG when this process can draw
 * one, else null (the caller leaves it out).
 */
export async function rasterPicture(picture: {
  bytes: Uint8Array;
  contentType: string;
}): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const raster = sniffModelImage(picture.bytes);
  if (raster) return { bytes: picture.bytes, contentType: raster };
  if (picture.contentType !== SVG_TYPE || !rasterizer) return null;
  const png = await rasterizer(picture.bytes).catch(() => null);
  return png && sniffModelImage(png) === "image/png" ? { bytes: png, contentType: "image/png" } : null;
}
