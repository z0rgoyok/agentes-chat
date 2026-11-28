import * as live from "@agenteschat/live";
import { iconShapes } from "@agenteschat/ui/icons/data";
import { ValidationError } from "../errors";
import type { JsonSchema } from "../tools/json-schema";

/**
 * The looks agents set on slides and canvases (ADR 0220 §3–4): one `style` input both edit tools take, checked and
 * turned into each kind's own style, and the words a read gives back so the agent knows what is there.
 */

type Json = Record<string, unknown>;

const HEX = { type: "string", maxLength: 9 } as const;

/** What `style` takes (snake_case, as the tools' other inputs); `null` on a key takes it away. */
export const STYLE_INPUT: JsonSchema = {
  type: "object",
  properties: {
    font: { type: ["string", "null"], maxLength: 80 },
    size: { type: ["number", "null"], minimum: 4, maximum: 1000 },
    weight: { enum: [...live.FONT_WEIGHTS, null] },
    color: { type: ["string", "null"], maxLength: 9 },
    align: { enum: ["left", "center", "right", null] },
    valign: { enum: ["top", "middle", "bottom", null] },
    line_height: { type: ["number", "null"], minimum: 0.8, maximum: 3 },
    tracking: { type: ["number", "null"], minimum: -200, maximum: 1000 },
    caps: { type: ["boolean", "null"] },
    padding: { type: ["number", "null"], minimum: 0, maximum: 500 },
    fill: { type: ["string", "null"], maxLength: 9 },
    gradient: {
      type: ["object", "null"],
      properties: { from: HEX, to: HEX, angle: { type: "number" } },
      required: ["from", "to"],
      additionalProperties: false,
    },
    stroke: { type: ["string", "null"], maxLength: 9 },
    stroke_width: { type: ["number", "null"], minimum: 0, maximum: 200 },
    dash: { enum: [...live.DASHES, null] },
    radius: { type: ["number", "null"], minimum: 0, maximum: 2000 },
    shadow: {
      type: ["object", "null"],
      properties: { x: { type: "number" }, y: { type: "number" }, blur: { type: "number" }, color: HEX },
      required: ["x", "y", "blur", "color"],
      additionalProperties: false,
    },
    opacity: { type: ["number", "null"], minimum: 0, maximum: 1 },
  },
  additionalProperties: false,
};

/** The words the tools say about `style` and fonts. */
export const STYLE_WORDS = [
  "`style` {font, size, weight (100–900), color, align, valign, line_height (× size), tracking (thousandths of the size), caps, padding, fill, gradient {from, to, angle}, stroke, stroke_width, dash (solid|dashed|dotted), radius, shadow {x, y, blur, color #rrggbbaa}, opacity}; null takes a key away.",
  `Fonts: a catalog family by name or id (${live.FONT_CATALOG.map((f) => f.family).join(", ")}), one of the file's own fonts by its family or \`asset:<id>\` (add_font {font_file: a Drive file id} brings a .ttf, .otf or .woff into the file first), or heading/body (the theme's).`,
].join(" ");

/** What `add_html` reads (ADR 0220 §4), said once for slides, canvases and documents. */
export const HTML_WORDS = [
  "The markup may be a fragment or a whole page as written for a browser: <style> anywhere (its head too), classes, ids, descendant and child selectors, :root and custom properties with var(), ::before/::after content, flexbox, grid (grid-template-columns in px, fr, repeat(), minmax(); gap; grid-column: span n), inline-flex, block flow, padding, margins, borders, radius, box-shadow, linear-gradient, opacity, fonts (font-family from the catalog or the file's own, also behind an @font-face name), weights, letter-spacing, text-transform: uppercase, line-height.",
  "Pictures: <img src> with file:<id> (a Drive picture), asset:<id> (the file's own), an https address, icon:<name> (our icon set, drawn in the CSS color around it), and inline <svg> (a logo or drawing written out).",
  'An element with data-arrow-to="<id of another element>" (and data-arrow-label, data-arrow-color) gets an arrow from its box to that one; on a canvas it is a connector that follows the shapes.',
  "Position, transforms, filters, animations and web fonts by address are left out, and the result says what it left out.",
  `Icons: ${Object.keys(iconShapes).join(", ")}.`,
].join(" ");

const KEYS: Record<string, keyof live.ElementStyle> = {
  font: "font",
  size: "size",
  weight: "weight",
  color: "color",
  align: "align",
  valign: "valign",
  line_height: "lineHeight",
  tracking: "tracking",
  caps: "caps",
  padding: "padding",
  fill: "fill",
  gradient: "gradient",
  stroke: "stroke",
  stroke_width: "strokeWidth",
  dash: "dash",
  radius: "radius",
  shadow: "shadow",
  opacity: "opacity",
};

/**
 * A font an agent names (a catalog family or id, one of the file's own fonts by its family, `asset:<id>`, heading or
 * body) as a ref the files store, or a refusal. `files`: the file's fonts by lowercase family.
 */
export function fontRefOf(value: unknown, files?: ReadonlyMap<string, string>): live.FontRef {
  const text: string = typeof value === "string" ? value.trim().replace(/^["']|["']$/g, "") : "";
  const own = files?.get(text.toLowerCase());
  if (own) return live.fontAssetRef(own);
  const known: boolean = live.isFontRef(text);
  if (known) return text;
  const named = live.catalogFontNamed(text);
  if (named) return named.id;
  throw new ValidationError(
    `There is no font "${text.slice(0, 60)}": name one of the catalog's (${live.FONT_CATALOG.slice(0, 8)
      .map((f) => f.family)
      .join(", ")}…), one of the file's own (asset:<id>), or heading/body`,
  );
}

/** An agent's `style` as a slide element's style patch (each key checked; null takes it away). */
export function slideStylePatch(
  input: unknown,
  files?: ReadonlyMap<string, string>,
): { [K in keyof live.ElementStyle]?: live.ElementStyle[K] | null } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("style must be an object");
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input as Json)) {
    const name = KEYS[key];
    if (!name) throw new ValidationError(`Unknown style key ${key}`);
    if (raw === null) {
      out[name] = null;
      continue;
    }
    const value = name === "font" ? fontRefOf(raw, files) : name === "caps" ? raw === true || undefined : raw;
    if (value === undefined) {
      out[name] = null;
      continue;
    }
    if (live.cleanStyleValue(name, value) === undefined)
      throw new ValidationError(`Bad style ${key}: ${JSON.stringify(raw).slice(0, 60)}`);
    out[name] = value;
  }
  return out;
}

/**
 * An agent's `style` as a canvas shape's patch: the text keys into `style` (text boxes, notes, shapes' labels), the
 * rest onto the shape where its type has them.
 */
export function canvasStylePatch(
  shape: live.ShapeView,
  input: unknown,
  files?: ReadonlyMap<string, string>,
): live.ShapePatch {
  const slide = slideStylePatch(input, files);
  const patch: live.ShapePatch = {};
  const text: Record<string, unknown> = { ...(shape.style ?? {}) };
  let textChanged = false;
  const setText = (key: keyof live.CanvasTextStyle, value: unknown) => {
    textChanged = true;
    if (value === null) delete text[key];
    else text[key] = value;
  };
  for (const [key, value] of Object.entries(slide)) {
    switch (key) {
      case "font":
        if (value !== null && live.isFontRole(value))
          throw new ValidationError("A canvas has no heading or body font: name the font");
        setText("font", value);
        break;
      case "size":
      case "weight":
      case "color":
      case "align":
      case "valign":
      case "lineHeight":
      case "tracking":
      case "caps":
      case "padding":
        setText(key as keyof live.CanvasTextStyle, value);
        break;
      case "fill":
      case "stroke":
      case "radius":
      case "gradient":
      case "dash":
      case "shadow":
        (patch as Record<string, unknown>)[key] = value;
        break;
      case "strokeWidth":
        patch.strokeWidth = value === null ? null : Math.max(1, Math.min(24, value as number));
        break;
      case "opacity":
        throw new ValidationError("Canvas shapes have no opacity: use a color with alpha (#rrggbbaa)");
    }
  }
  if (textChanged) patch.style = Object.keys(text).length ? (text as live.CanvasTextStyle) : null;
  return patch;
}

const fontWord = (ref: string | undefined) => {
  if (!ref) return "";
  const asset = live.fontAssetOf(ref);
  return asset ? `asset:${asset}` : (live.catalogFont(ref)?.family ?? ref);
};

/** A style in words, for a read: what the agent can set back. */
export function styleWords(style: Partial<live.ElementStyle & live.CanvasTextStyle> | undefined): string {
  if (!style) return "";
  const parts: string[] = [];
  const type = [fontWord(style.font), style.weight, style.size].filter(Boolean).join(" ");
  if (type) parts.push(`text ${type}`);
  if (style.color) parts.push(`color ${style.color}`);
  if (style.align) parts.push(style.align);
  if (style.valign) parts.push(`valign ${style.valign}`);
  if (style.lineHeight) parts.push(`line ${style.lineHeight}`);
  if (style.tracking) parts.push(`tracking ${style.tracking}`);
  if (style.caps) parts.push("caps");
  if (style.padding) parts.push(`padding ${style.padding}`);
  if (style.fill) parts.push(`fill ${style.fill}`);
  if (style.gradient) parts.push(`gradient ${style.gradient.from}→${style.gradient.to} ${style.gradient.angle}°`);
  if (style.stroke)
    parts.push(
      `border ${style.stroke}${style.strokeWidth ? ` ${style.strokeWidth}` : ""}${style.dash && style.dash !== "solid" ? ` ${style.dash}` : ""}`,
    );
  if (style.radius) parts.push(`radius ${style.radius}`);
  if (style.shadow) parts.push(`shadow ${style.shadow.x} ${style.shadow.y} ${style.shadow.blur} ${style.shadow.color}`);
  if (style.opacity !== undefined && style.opacity < 1) parts.push(`opacity ${style.opacity}`);
  return parts.join(", ");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

/** A run with marks Markdown can't say, as an inline HTML span the agent can write back with `html`. */
function runHtml(run: live.RichRun): string {
  const css: string[] = [];
  if (run.font) css.push(`font-family:${fontWord(run.font)}`);
  if (run.size) css.push(`font-size:${run.size}px`);
  if (run.weight) css.push(`font-weight:${run.weight}`);
  else if (run.bold) css.push("font-weight:700");
  if (run.italic) css.push("font-style:italic");
  if (run.color) css.push(`color:${run.color}`);
  if (run.highlight) css.push(`background:${run.highlight}`);
  if (run.tracking) css.push(`letter-spacing:${run.tracking / 1000}em`);
  if (run.caps) css.push("text-transform:uppercase");
  const deco = [run.underline ? "underline" : "", run.strike ? "line-through" : ""].filter(Boolean).join(" ");
  if (deco) css.push(`text-decoration:${deco}`);
  const text = escapeHtml(run.text).replace(/\n/g, "<br>");
  const span = css.length ? `<span style="${css.join(";")}">${text}</span>` : text;
  return run.link ? `<a href="${escapeHtml(run.link)}">${span}</a>` : span;
}

/**
 * Rich text for a read: light Markdown when its runs need nothing more (as before), else inline HTML spans for the
 * runs with type marks (ADR 0220 §3), which `set_text` takes back as `html`.
 */
export function richForRead(rich: live.RichDoc): string {
  const typed = rich.some((p) =>
    p.runs.some((r) => r.font || r.size || r.weight || r.highlight || r.tracking || r.caps || r.color || r.underline),
  );
  if (!typed) return live.richToMarkdown(rich).trim();
  return rich
    .map((p) => {
      const marker = p.list === "bullet" ? "- " : p.list === "ordered" ? "1. " : "";
      return `${"  ".repeat(p.level ?? 0)}${marker}${p.runs.map(runHtml).join("")}`;
    })
    .join("\n");
}
