/**
 * The CSS `add_html` reads (ADR 0220 §4): style rules with simple selectors (tags, classes, ids, attribute presence,
 * `*`, `:root`, descendant and child combinators, `:first-child` / `:last-child`, and `::before` / `::after`),
 * declarations with their shorthands and custom properties (`--name`, read with `var()`), `@font-face` names, and
 * values (lengths, colors, gradients, shadows). What it doesn't take is skipped and named, never an error: the agent is
 * told what was left out.
 */

/** Longhand properties and their values, after `var()` and shorthands. */
export type Declarations = Map<string, string>;

/** Declarations as written, in order: shorthands and `var()` are resolved once the cascade knows the element. */
export type RawDeclarations = [string, string][];

export interface Rule {
  selector: Selector;
  specificity: number;
  /** Source order, for ties. */
  order: number;
  declarations: RawDeclarations;
  /** A rule for an element's generated content (`::before`, `::after`). */
  pseudo?: "before" | "after";
}

interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: string[];
  first?: boolean;
  last?: boolean;
  root?: boolean;
}

/** Compounds right to left, each with the combinator that joins it to the next one on its left. */
export type Selector = { compound: Compound; combinator: " " | ">" | null }[];

/** What a selector checks of an element. */
export interface MatchTarget {
  tag: string;
  id: string | null;
  classes: readonly string[];
  hasAttr(name: string): boolean;
  parent: MatchTarget | null;
  first: boolean;
  last: boolean;
}

const UNSUPPORTED_PSEUDO = /:(?!first-child|last-child|root\b)[a-z-]+(\([^)]*\))?/i;

function parseCompound(text: string): Compound | null {
  const c: Compound = { classes: [], attrs: [] };
  let rest = text;
  const tag = /^([a-z][a-z0-9-]*|\*)/i.exec(rest);
  if (tag) {
    if (tag[1] !== "*") c.tag = tag[1]?.toLowerCase();
    rest = rest.slice(tag[0].length);
  }
  // Each part of a compound, in turn: what it matches and what it sets.
  const parts: [RegExp, (m: RegExpExecArray) => void][] = [
    [/^\.([a-z0-9_-]+)/i, (m) => c.classes.push(m[1] ?? "")],
    [/^#([a-z0-9_-]+)/i, (m) => (c.id = m[1])],
    [/^\[([a-z0-9_-]+)(?:[~|^$*]?=(?:"[^"]*"|'[^']*'|[^\]]*))?\]/i, (m) => c.attrs.push(m[1]?.toLowerCase() ?? "")],
    [/^:first-child/i, () => (c.first = true)],
    [/^:last-child/i, () => (c.last = true)],
    [/^:root/i, () => (c.root = true)],
  ];
  while (rest) {
    let matched: RegExpExecArray | null = null;
    for (const [pattern, apply] of parts) {
      matched = pattern.exec(rest);
      if (matched) {
        apply(matched);
        break;
      }
    }
    if (!matched) return null;
    rest = rest.slice(matched[0].length);
  }
  return c;
}

/** A selector's generated content, and the selector without it (`.card::after` → after, `.card`). */
export function pseudoOf(text: string): { selector: string; pseudo?: "before" | "after" } {
  const m = /::?(before|after)\s*$/i.exec(text.trim());
  if (!m) return { selector: text };
  return { selector: text.trim().slice(0, m.index), pseudo: (m[1] ?? "").toLowerCase() as "before" | "after" };
}

/** One selector of a list, or null when it uses what isn't taken (`:hover`, `+`, `~`, other pseudo-elements). */
export function parseSelector(text: string): Selector | null {
  const s = text.trim();
  if (!s || UNSUPPORTED_PSEUDO.test(s) || /::|[+~]/.test(s)) return null;
  const tokens = s
    .replace(/\s*>\s*/g, " > ")
    .split(/\s+/)
    .filter(Boolean);
  const parts: Selector = [];
  let combinator: " " | ">" | null = null;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i] ?? "";
    if (token === ">") {
      combinator = ">";
      continue;
    }
    const compound = parseCompound(token);
    if (!compound) return null;
    if (parts.length) {
      const last = parts[parts.length - 1];
      if (last) last.combinator = combinator ?? " ";
    }
    parts.push({ compound, combinator: null });
    combinator = null;
  }
  return parts.length ? parts : null;
}

export function specificityOf(selector: Selector): number {
  let ids = 0;
  let classes = 0;
  let tags = 0;
  for (const { compound } of selector) {
    if (compound.id) ids++;
    classes +=
      compound.classes.length +
      compound.attrs.length +
      (compound.first ? 1 : 0) +
      (compound.last ? 1 : 0) +
      (compound.root ? 1 : 0);
    if (compound.tag) tags++;
  }
  return ids * 10_000 + classes * 100 + tags;
}

function matchesCompound(el: MatchTarget, c: Compound): boolean {
  if (c.tag && c.tag !== el.tag) return false;
  if (c.id && c.id !== el.id) return false;
  for (const cls of c.classes) if (!el.classes.includes(cls)) return false;
  for (const attr of c.attrs) if (!el.hasAttr(attr)) return false;
  if (c.first && !el.first) return false;
  if (c.last && !el.last) return false;
  // `:root` is the document's root: its `html`, or the top of a fragment.
  if (c.root && !(el.tag === "html" || el.parent === null)) return false;
  return true;
}

export function matches(el: MatchTarget, selector: Selector): boolean {
  const [head, ...rest] = selector;
  if (!head || !matchesCompound(el, head.compound)) return false;
  let at: MatchTarget | null = el;
  let combinator = head.combinator;
  for (const part of rest) {
    if (combinator === ">") {
      at = at?.parent ?? null;
      if (!at || !matchesCompound(at, part.compound)) return false;
    } else {
      at = at?.parent ?? null;
      while (at && !matchesCompound(at, part.compound)) at = at.parent;
      if (!at) return false;
    }
    combinator = part.combinator;
  }
  return true;
}

/** `prop: value; …` in order, as written (`!important` dropped, property names lowercased, custom ones kept). */
export function parseDeclarations(text: string): RawDeclarations {
  const out: RawDeclarations = [];
  for (const part of splitTop(text, ";")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const prop = name.startsWith("--") ? name : name.toLowerCase();
    const value = part
      .slice(i + 1)
      .replace(/!\s*important\s*$/i, "")
      .trim();
    if (prop && value && value.length <= VALUE_MAX) out.push([prop, value]);
  }
  return out;
}

/**
 * `var(--name, fallback)` in a value, from the custom properties in scope (read by index, nested up to a few levels;
 * a name with no value and no fallback leaves the declaration out).
 */
export function resolveVars(value: string, custom: ReadonlyMap<string, string>, depth = 0): string | null {
  if (!value.includes("var(")) return value;
  if (depth > 5) return null;
  let out = "";
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf("var(", i);
    if (at < 0) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, at);
    let depthParen = 1;
    let j = at + 4;
    while (j < value.length && depthParen > 0) {
      if (value[j] === "(") depthParen++;
      else if (value[j] === ")") depthParen--;
      j++;
    }
    const inner = value.slice(at + 4, j - 1);
    const comma = inner.indexOf(",");
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? null : inner.slice(comma + 1).trim();
    const found = custom.get(name) ?? fallback;
    if (found === null || found === undefined) return null;
    const resolved = resolveVars(found, custom, depth + 1);
    if (resolved === null) return null;
    out += resolved;
    i = j;
  }
  return out;
}

/** Declarations in order into longhands: each shorthand expanded where it stands, later ones winning. */
export function expandAll(entries: RawDeclarations): Declarations {
  const out: Declarations = new Map();
  for (const [prop, value] of entries) if (!prop.startsWith("--")) expand(prop, value, out);
  return out;
}

/** Splits at `sep` outside parentheses and quotes. */
export function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Splits a value at spaces outside parentheses. */
export function words(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value.trim()) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const SIDES = ["top", "right", "bottom", "left"] as const;

function boxSides(value: string): [string, string, string, string] {
  const w = words(value);
  const [a = "0", b = a, c = a, d = b] = w;
  return [a, b, c, d];
}

/** Shorthands into their longhands (the ones the layout reads). */
function expand(prop: string, value: string, out: Declarations): void {
  switch (prop) {
    case "margin":
    case "padding": {
      for (const [i, v] of boxSides(value).entries()) out.set(`${prop}-${SIDES[i]}`, v);
      return;
    }
    case "inset": {
      for (const [i, v] of boxSides(value).entries()) out.set(SIDES[i] as string, v);
      return;
    }
    case "border":
    case "border-top":
    case "border-right":
    case "border-bottom":
    case "border-left": {
      const sides = prop === "border" ? SIDES : [prop.slice(7) as (typeof SIDES)[number]];
      const parsed = parseBorder(value);
      for (const side of sides) {
        out.set(`border-${side}-width`, `${parsed.width}px`);
        if (parsed.color) out.set(`border-${side}-color`, parsed.color);
        if (parsed.style) out.set(`border-${side}-style`, parsed.style);
      }
      return;
    }
    case "border-width":
    case "border-color":
    case "border-style": {
      const kind = prop.slice(7);
      for (const [i, v] of boxSides(value).entries()) out.set(`border-${SIDES[i]}-${kind}`, v);
      return;
    }
    case "border-radius": {
      // One radius for the box: the first corner's (a pill stays a pill).
      out.set("border-radius", words(value.split("/")[0] ?? value)[0] ?? "0");
      return;
    }
    case "background": {
      const gradient = /linear-gradient\(/i.test(value) ? value.slice(value.search(/linear-gradient\(/i)) : null;
      if (gradient) out.set("background-image", gradient);
      const at = value.search(/linear-gradient\(/i);
      const plain = at < 0 ? value : value.slice(0, at);
      const color = words(plain).find((w) => parseColor(w) !== null);
      if (color) out.set("background-color", color);
      return;
    }
    case "flex": {
      const w = words(value);
      if (w[0] === "none") {
        out.set("flex-grow", "0");
        out.set("flex-shrink", "0");
        out.set("flex-basis", "auto");
      } else if (w[0] === "auto") {
        out.set("flex-grow", "1");
        out.set("flex-shrink", "1");
        out.set("flex-basis", "auto");
      } else {
        out.set("flex-grow", w[0] ?? "0");
        if (w[1] !== undefined && /^\d*\.?\d+$/.test(w[1])) {
          out.set("flex-shrink", w[1]);
          if (w[2]) out.set("flex-basis", w[2]);
        } else if (w[1]) out.set("flex-basis", w[1]);
        else out.set("flex-basis", "0%");
      }
      return;
    }
    case "flex-flow": {
      for (const w of words(value)) {
        if (/wrap/.test(w)) out.set("flex-wrap", w);
        else out.set("flex-direction", w);
      }
      return;
    }
    case "gap":
    case "grid-gap": {
      const [row = "0", column = row] = words(value);
      out.set("row-gap", row);
      out.set("column-gap", column);
      return;
    }
    case "grid-row-gap":
    case "grid-column-gap":
      out.set(prop.slice(5), value);
      return;
    case "font": {
      // [style] [weight] size[/line-height] family…
      const m = /^(.*?)(\d*\.?\d+(?:px|em|rem|%|pt))(?:\s*\/\s*([^\s]+))?\s+(.+)$/i.exec(value.trim());
      if (!m) return;
      for (const w of words(m[1] ?? "")) {
        if (w === "italic") out.set("font-style", "italic");
        else if (/^(bold|bolder|lighter|normal|\d{3})$/.test(w)) out.set("font-weight", w);
      }
      out.set("font-size", m[2] ?? "");
      if (m[3]) out.set("line-height", m[3]);
      out.set("font-family", m[4] ?? "");
      return;
    }
    case "text-decoration-line":
      out.set("text-decoration", value);
      return;
    case "place-items": {
      const [align = "stretch", justify = align] = words(value);
      out.set("align-items", align);
      out.set("justify-items", justify);
      return;
    }
    default:
      out.set(prop, value);
  }
}

function parseBorder(value: string): { width: number; style?: string; color?: string } {
  let width = 1;
  let style: string | undefined;
  let color: string | undefined;
  for (const w of words(value)) {
    if (/^(none|hidden)$/.test(w)) {
      width = 0;
      style = "none";
    } else if (/^(solid|dashed|dotted|double|groove|ridge|inset|outset)$/.test(w)) style = w;
    else if (/^(thin|medium|thick)$/.test(w)) width = w === "thin" ? 1 : w === "medium" ? 3 : 5;
    else if (/^-?\d*\.?\d+(px)?$/.test(w)) width = Number.parseFloat(w);
    else if (parseColor(w) !== null) color = w;
  }
  return { width, ...(style ? { style } : {}), ...(color ? { color } : {}) };
}

/** The text without its comments, read by index (a regex would be quadratic on an unclosed one). */
function stripComments(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("/*", i);
    if (open < 0) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, open);
    const close = css.indexOf("*/", open + 2);
    if (close < 0) break;
    i = close + 2;
  }
  return out;
}

/** The most a declaration's value may hold (longer ones are someone's mistake, never a style). */
const VALUE_MAX = 2000;

/**
 * A style sheet's rules in cascade order. `@` blocks (media queries, font faces, keyframes) are skipped and counted in
 * `skipped`, as are selectors that aren't taken.
 */
export function parseStyleSheet(css: string): {
  rules: Rule[];
  skipped: string[];
  /** `@font-face` names to the font files they load (`Funnel` → `fontes/FunnelDisplay-Variable.ttf`). */
  fontFaces: Map<string, string>;
} {
  const rules: Rule[] = [];
  const skipped: string[] = [];
  const fontFaces = new Map<string, string>();
  const text = stripComments(css);
  let i = 0;
  let order = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const prelude = text.slice(i, open).trim();
    // Find the matching brace (an @media block holds rules inside).
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      j++;
    }
    const body = text.slice(open + 1, j - 1);
    i = j;
    if (/^@font-face$/i.test(prelude)) {
      // The name a sheet gives a font file: matched to the catalog by the file's name.
      const decls = parseDeclarations(body);
      const family = decls.find(([k]) => k === "font-family")?.[1];
      const src = decls.find(([k]) => k === "src")?.[1];
      const file = src ? /url\(\s*["']?([^"')]+)/i.exec(src)?.[1] : undefined;
      if (family && file)
        fontFaces.set(
          family
            .replace(/^["']|["']$/g, "")
            .trim()
            .toLowerCase(),
          file,
        );
      continue;
    }
    if (prelude.startsWith("@")) {
      skipped.push(prelude.split(/\s/)[0] ?? prelude);
      continue;
    }
    const declarations = parseDeclarations(body);
    for (const part of splitTop(prelude, ",")) {
      const { selector: text, pseudo } = pseudoOf(part);
      const selector = parseSelector(text);
      if (!selector) {
        skipped.push(part);
        continue;
      }
      rules.push({
        selector,
        specificity: specificityOf(selector),
        order: order++,
        declarations,
        ...(pseudo ? { pseudo } : {}),
      });
    }
  }
  return { rules, skipped, fontFaces };
}

/**
 * A grid's column tracks (`430px 1fr 470px`, `repeat(4, 1fr)`, `minmax(200px, 1fr)`): each a fixed width or a share
 * of what is left. Null when it isn't a list of tracks (auto-fill and named lines aren't taken).
 */
export function parseTracks(
  value: string | undefined,
  em: number,
  rem: number,
): ({ px: number } | { fr: number })[] | null {
  if (!value || value === "none") return null;
  const out: ({ px: number } | { fr: number })[] = [];
  for (const w of words(value)) {
    const repeat = /^repeat\(\s*(\d+)\s*,\s*(.+)\)$/i.exec(w);
    if (repeat) {
      const inner = parseTracks(repeat[2], em, rem);
      if (!inner) return null;
      for (let k = 0; k < Math.min(24, Number(repeat[1])); k++) out.push(...inner);
      continue;
    }
    const minmax = /^minmax\(\s*[^,]+,\s*(.+)\)$/i.exec(w);
    const track = minmax ? (minmax[1] ?? "").trim() : w;
    const fr = /^(\d*\.?\d+)fr$/i.exec(track);
    if (fr) out.push({ fr: Number.parseFloat(fr[1] ?? "1") });
    else if (track === "auto" || /^(min|max|fit)-content/.test(track)) out.push({ fr: 1 });
    else {
      const l = parseLength(track, em, rem);
      if (!l || !("px" in l)) return null;
      out.push({ px: l.px });
    }
  }
  return out.length ? out : null;
}

// ── Values ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A length as px, or a percentage, or null. `em` is the element's font size, `rem` the root's. */
export type Length = { px: number } | { percent: number };

export function parseLength(value: string | undefined, em: number, rem: number): Length | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "0") return { px: 0 };
  const m = /^(-?\d*\.?\d+)(px|em|rem|%|pt|vw|vh)?$/.exec(v);
  if (!m) return null;
  const n = Number.parseFloat(m[1] ?? "");
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case "em":
      return { px: n * em };
    case "rem":
      return { px: n * rem };
    case "%":
      return { percent: n };
    case "pt":
      return { px: (n * 4) / 3 };
    case "vw":
    case "vh":
      return { percent: n };
    default:
      return m[2] === undefined && n !== 0 ? null : { px: n };
  }
}

/** A length as px only (percentages and `auto` are null). */
export function px(value: string | undefined, em: number, rem: number): number | null {
  const l = parseLength(value, em, rem);
  return l && "px" in l ? l.px : null;
}

const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  maroon: "#800000",
  purple: "#800080",
  fuchsia: "#ff00ff",
  magenta: "#ff00ff",
  lime: "#00ff00",
  olive: "#808000",
  yellow: "#ffff00",
  navy: "#000080",
  teal: "#008080",
  aqua: "#00ffff",
  cyan: "#00ffff",
  orange: "#ffa500",
  whitesmoke: "#f5f5f5",
  gainsboro: "#dcdcdc",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
  dimgray: "#696969",
  slategray: "#708090",
  aliceblue: "#f0f8ff",
  ghostwhite: "#f8f8ff",
  ivory: "#fffff0",
  beige: "#f5f5dc",
  gold: "#ffd700",
  pink: "#ffc0cb",
  coral: "#ff7f50",
  tomato: "#ff6347",
  crimson: "#dc143c",
  indigo: "#4b0082",
  violet: "#ee82ee",
  skyblue: "#87ceeb",
  steelblue: "#4682b4",
  royalblue: "#4169e1",
  dodgerblue: "#1e90ff",
  cornflowerblue: "#6495ed",
  midnightblue: "#191970",
  darkblue: "#00008b",
  lightblue: "#add8e6",
  seagreen: "#2e8b57",
  forestgreen: "#228b22",
  darkgreen: "#006400",
  limegreen: "#32cd32",
  salmon: "#fa8072",
  chocolate: "#d2691e",
  brown: "#a52a2a",
  tan: "#d2b48c",
  khaki: "#f0e68c",
  lavender: "#e6e6fa",
  plum: "#dda0dd",
  orchid: "#da70d6",
  turquoise: "#40e0d0",
};

function hex2(n: number): string {
  return Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, "0");
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** A color as "#rrggbb" or "#rrggbbaa" (alpha under 1), "none" for transparent, or null when it isn't one. */
export function parseColor(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "transparent") return "none";
  if (NAMED[v]) return NAMED[v];
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (m) {
    const h = m[1] ?? "";
    if (h.length <= 4) {
      const full = [...h].map((c) => c + c).join("");
      return full.length === 8 && full.endsWith("ff") ? `#${full.slice(0, 6)}` : `#${full}`;
    }
    return h.length === 8 && h.endsWith("ff") ? `#${h.slice(0, 6)}` : `#${h}`;
  }
  m = /^rgba?\(([^)]*)\)$/.exec(v);
  if (m) {
    const parts = (m[1] ?? "").split(/[\s,/]+/).filter(Boolean);
    const n = parts.map((p, i) =>
      p.endsWith("%") ? (Number.parseFloat(p) / 100) * (i < 3 ? 255 : 1) : Number.parseFloat(p),
    );
    if (n.length < 3 || n.slice(0, 3).some((x) => !Number.isFinite(x))) return null;
    const alpha = n[3] !== undefined && Number.isFinite(n[3]) ? n[3] : 1;
    if (alpha <= 0) return "none";
    return `#${hex2(n[0] ?? 0)}${hex2(n[1] ?? 0)}${hex2(n[2] ?? 0)}${alpha < 1 ? hex2(alpha * 255) : ""}`;
  }
  m = /^hsla?\(([^)]*)\)$/.exec(v);
  if (m) {
    const parts = (m[1] ?? "").split(/[\s,/]+/).filter(Boolean);
    const h = Number.parseFloat(parts[0] ?? "");
    const s = Number.parseFloat(parts[1] ?? "") / 100;
    const l = Number.parseFloat(parts[2] ?? "") / 100;
    if (![h, s, l].every(Number.isFinite)) return null;
    const a = parts[3] ? (parts[3].endsWith("%") ? Number.parseFloat(parts[3]) / 100 : Number.parseFloat(parts[3])) : 1;
    if (a <= 0) return "none";
    const [r, g, b] = hslToRgb(((h % 360) + 360) % 360, s, l);
    return `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a * 255) : ""}`;
  }
  return null;
}

/** A color without its alpha ("#rrggbb"), for what can't be translucent (text in rich runs). */
export function opaque(color: string): string {
  return color.length === 9 ? color.slice(0, 7) : color;
}

/** The first and last stops of a `linear-gradient(…)` and its angle, or null. */
export function parseGradient(value: string | undefined): { from: string; to: string; angle: number } | null {
  if (!value) return null;
  const m = /linear-gradient\((.*)\)\s*$/i.exec(value.trim());
  if (!m) return null;
  const parts = splitTop(m[1] ?? "", ",");
  let angle = 180;
  const first = parts[0]?.trim().toLowerCase() ?? "";
  const deg = /^(-?\d*\.?\d+)deg$/.exec(first);
  const to = /^to\s+(.+)$/.exec(first);
  if (deg || to) {
    parts.shift();
    if (deg) angle = Number.parseFloat(deg[1] ?? "180");
    else {
      const dir = to?.[1] ?? "";
      const table: Record<string, number> = {
        top: 0,
        right: 90,
        bottom: 180,
        left: 270,
        "top right": 45,
        "right top": 45,
        "bottom right": 135,
        "right bottom": 135,
        "bottom left": 225,
        "left bottom": 225,
        "top left": 315,
        "left top": 315,
      };
      angle = table[dir] ?? 180;
    }
  }
  const colors = parts.map((p) => parseColor(words(p)[0])).filter((c): c is string => !!c && c !== "none");
  if (colors.length < 2) return null;
  return { from: colors[0] as string, to: colors[colors.length - 1] as string, angle };
}

/** The first shadow of a `box-shadow`, or null (`inset` shadows aren't drawn). */
export function parseShadow(
  value: string | undefined,
  em: number,
  rem: number,
): { x: number; y: number; blur: number; color: string } | null {
  if (!value || value.trim() === "none") return null;
  const first = splitTop(value, ",")[0] ?? "";
  if (/\binset\b/.test(first)) return null;
  const nums: number[] = [];
  let color = "#00000040";
  for (const w of words(first)) {
    const c = parseColor(w);
    if (c && c !== "none" && !/^-?\d/.test(w)) {
      color = c.length === 7 ? `${c}ff` : c;
      continue;
    }
    const n = px(w, em, rem);
    if (n !== null) nums.push(n);
  }
  if (nums.length < 2) return null;
  return { x: nums[0] ?? 0, y: nums[1] ?? 0, blur: Math.max(0, nums[2] ?? 0), color };
}

/** A `font-weight` as 100..900, or null. */
export function parseWeight(value: string | undefined, inherited: number): number | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "normal") return 400;
  if (v === "bold") return 700;
  if (v === "bolder") return Math.min(900, inherited + 300);
  if (v === "lighter") return Math.max(100, inherited - 300);
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 && n <= 1000 ? Math.min(900, Math.max(100, Math.round(n / 100) * 100)) : null;
}

/** A `font-family` list's names, quotes taken off. */
export function parseFamilies(value: string | undefined): string[] {
  if (!value) return [];
  return splitTop(value, ",")
    .map((f) => f.replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);
}
