import { attr, dig, type Element, kids, nameOf } from "./xml";

/**
 * Colors in Office files (ADR 0198): SpreadsheetML's ARGB, theme and indexed colors with Excel's tint, and
 * DrawingML's color elements (sRGB, scheme, system and preset colors) with their modifiers (luminance, tint, shade,
 * saturation, alpha). Everything comes out as `#rrggbb`.
 */

/** The names of a theme's color scheme, in the order SpreadsheetML numbers them (light 1 and dark 1 swapped). */
export const SHEET_THEME_ORDER = [
  "lt1",
  "dk1",
  "lt2",
  "dk2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
] as const;

/** The theme every new Office file starts with: what a part that names theme colors means when the file has none. */
export const OFFICE_THEME: Record<string, string> = {
  dk1: "#000000",
  lt1: "#ffffff",
  dk2: "#0e2841",
  lt2: "#e8e8e8",
  accent1: "#156082",
  accent2: "#e97132",
  accent3: "#196b24",
  accent4: "#0f9ed5",
  accent5: "#a02b93",
  accent6: "#4ea72e",
  hlink: "#467886",
  folHlink: "#96607d",
};

/** Excel's legacy palette (`indexed` colors 0–63; 64 is the system's text color, 65 its background). */
const INDEXED = [
  "000000",
  "ffffff",
  "ff0000",
  "00ff00",
  "0000ff",
  "ffff00",
  "ff00ff",
  "00ffff",
  "000000",
  "ffffff",
  "ff0000",
  "00ff00",
  "0000ff",
  "ffff00",
  "ff00ff",
  "00ffff",
  "800000",
  "008000",
  "000080",
  "808000",
  "800080",
  "008080",
  "c0c0c0",
  "808080",
  "9999ff",
  "993366",
  "ffffcc",
  "ccffff",
  "660066",
  "ff8080",
  "0066cc",
  "ccccff",
  "000080",
  "ff00ff",
  "ffff00",
  "00ffff",
  "800080",
  "800000",
  "008080",
  "0000ff",
  "00ccff",
  "ccffff",
  "ccffcc",
  "ffff99",
  "99ccff",
  "ff99cc",
  "cc99ff",
  "ffcc99",
  "3366ff",
  "33cccc",
  "99cc00",
  "ffcc00",
  "ff9900",
  "ff6600",
  "666699",
  "969696",
  "003366",
  "339966",
  "003300",
  "333300",
  "993300",
  "993366",
  "333399",
  "333333",
];

/** `#rrggbb` from `RRGGBB`, `AARRGGBB` or `#rrggbb`; null for anything else. */
export function hexOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{8}$/.test(v)) return `#${v.slice(2).toLowerCase()}`;
  if (/^[0-9a-fA-F]{6}$/.test(v)) return `#${v.toLowerCase()}`;
  return null;
}

/** An indexed color (`indexedColors` overrides the default palette when the file has its own). */
export function indexedColor(index: number, custom?: readonly string[]): string | null {
  if (index === 64) return "#000000";
  if (index === 65) return "#ffffff";
  const own = custom?.[index];
  if (own) return own;
  const base = INDEXED[index];
  return base ? `#${base}` : null;
}

function rgbOf(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function toHex(r: number, g: number, b: number): string {
  const c = (n: number) =>
    Math.round(clamp01(n) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];
}

/** A color in HSL (0..1 each) and back, through a change. */
function throughHsl(hex: string, change: (hsl: [number, number, number]) => [number, number, number]): string {
  const [r, g, b] = rgbOf(hex);
  const [h, s, l] = change(rgbToHsl(r / 255, g / 255, b / 255));
  return toHex(...hslToRgb(h, clamp01(s), clamp01(l)));
}

/** SpreadsheetML's tint (−1..1): darker toward black, lighter toward white, on the color's luminance. */
export function excelTint(hex: string, tint: number): string {
  if (!Number.isFinite(tint) || tint === 0) return hex;
  return throughHsl(hex, ([h, s, l]) => [h, s, tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint]);
}

/** A SpreadsheetML color element (`rgb`, `theme`, `indexed`, with `tint`); null for none or "automatic". */
export function sheetColor(
  el: Element | null | undefined,
  theme: Record<string, string>,
  indexed?: readonly string[],
): string | null {
  return el ? sheetColorFrom((name) => attr(el, name), theme, indexed) : null;
}

/** `sheetColor` from a color's attributes however they were read (the scanner of large parts has no elements). */
export function sheetColorFrom(
  get: (name: string) => string | null | undefined,
  theme: Record<string, string>,
  indexed?: readonly string[],
): string | null {
  const auto = get("auto");
  if (auto === "1" || auto === "true") return null;
  let hex: string | null = null;
  const rgb = get("rgb");
  const themeIndex = get("theme");
  const index = get("indexed");
  if (rgb) hex = hexOf(rgb);
  else if (themeIndex !== null && themeIndex !== undefined) {
    const name = SHEET_THEME_ORDER[Number(themeIndex)];
    hex = name ? (theme[name] ?? OFFICE_THEME[name] ?? null) : null;
  } else if (index !== null && index !== undefined) hex = indexedColor(Number(index), indexed);
  if (!hex) return null;
  const tint = Number(get("tint") ?? 0);
  return excelTint(hex, tint);
}

/** A theme part's color scheme (`dk1`…`folHlink`); system colors by their last known value. */
export function themeColors(theme: Element | null): Record<string, string> {
  const scheme = dig(theme, "themeElements", "clrScheme");
  const out: Record<string, string> = {};
  for (const slot of kids(scheme)) {
    const value = kids(slot)[0];
    if (!value) continue;
    const hex =
      nameOf(value) === "sysClr" ? hexOf(attr(value, "lastClr") ?? "") : hexOf(attr(value, "val") ?? undefined);
    if (hex) out[nameOf(slot)] = hex;
  }
  return out;
}

/** A theme's heading and body fonts (Latin). */
export function themeFonts(theme: Element | null): { major: string | null; minor: string | null } {
  const fonts = dig(theme, "themeElements", "fontScheme");
  const face = (which: string) => attr(dig(fonts, which, "latin"), "typeface") || null;
  return { major: face("majorFont"), minor: face("minorFont") };
}

/** Named colors DrawingML may use (`prstClr`), the common ones. */
const PRESET: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  orange: "#ffa500",
  purple: "#800080",
  gray: "#808080",
  grey: "#808080",
  darkGray: "#a9a9a9",
  lightGray: "#d3d3d3",
  navy: "#000080",
  teal: "#008080",
  maroon: "#800000",
  silver: "#c0c0c0",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  lime: "#00ff00",
  olive: "#808000",
  brown: "#a52a2a",
  pink: "#ffc0cb",
};

/** A color DrawingML resolved: `#rrggbb` and its opacity (1 = opaque). */
export interface DrawnColor {
  hex: string;
  alpha: number;
}

/**
 * How DrawingML scheme colors resolve in a part: the theme's scheme, the color map that renames `bg1`/`tx1`… to
 * `lt1`/`dk1`…, and what `phClr` stands for where a style reference gave one.
 */
export interface ColorContext {
  scheme: Record<string, string>;
  map: Record<string, string>;
  placeholder?: DrawnColor | null;
}

const DEFAULT_MAP: Record<string, string> = {
  bg1: "lt1",
  tx1: "dk1",
  bg2: "lt2",
  tx2: "dk2",
  accent1: "accent1",
  accent2: "accent2",
  accent3: "accent3",
  accent4: "accent4",
  accent5: "accent5",
  accent6: "accent6",
  hlink: "hlink",
  folHlink: "folHlink",
};

/** A slide master's (or a slide's override) color map. */
export function colorMap(el: Element | null | undefined): Record<string, string> {
  const map = { ...DEFAULT_MAP };
  if (!el) return map;
  for (const key of Object.keys(DEFAULT_MAP)) {
    const v = attr(el, key);
    if (v) map[key] = v;
  }
  return map;
}

const COLOR_ELEMENTS = new Set(["srgbClr", "schemeClr", "sysClr", "prstClr", "scrgbClr", "hslClr"]);

/** The first color element among `el`'s children (or `el` itself when it is one). */
export function colorElementOf(el: Element | null | undefined): Element | null {
  if (!el) return null;
  if (COLOR_ELEMENTS.has(nameOf(el))) return el;
  return kids(el).find((k) => COLOR_ELEMENTS.has(nameOf(k))) ?? null;
}

/** A DrawingML color element with its modifiers applied, or null when it names nothing known. */
export function drawingColor(el: Element | null | undefined, ctx: ColorContext): DrawnColor | null {
  const color = colorElementOf(el);
  if (!color) return null;
  let hex: string | null = null;
  let alpha = 1;
  const val = attr(color, "val");
  switch (nameOf(color)) {
    case "srgbClr":
      hex = hexOf(val);
      break;
    case "sysClr":
      hex = hexOf(attr(color, "lastClr")) ?? (val === "window" ? "#ffffff" : "#000000");
      break;
    case "prstClr":
      hex = val ? (PRESET[val] ?? null) : null;
      break;
    case "scrgbClr": {
      const pct = (name: string) => Number(attr(color, name) ?? 0) / 100_000;
      hex = toHex(pct("r") ** (1 / 2.2), pct("g") ** (1 / 2.2), pct("b") ** (1 / 2.2));
      break;
    }
    case "hslClr": {
      const h = Number(attr(color, "hue") ?? 0) / 21_600_000;
      const s = Number(attr(color, "sat") ?? 0) / 100_000;
      const l = Number(attr(color, "lum") ?? 0) / 100_000;
      hex = toHex(...hslToRgb(h, s, l));
      break;
    }
    case "schemeClr": {
      if (val === "phClr") {
        if (ctx.placeholder) {
          hex = ctx.placeholder.hex;
          alpha = ctx.placeholder.alpha;
        }
        break;
      }
      const name = val ? (ctx.map[val] ?? val) : null;
      hex = name ? (ctx.scheme[name] ?? OFFICE_THEME[name] ?? null) : null;
      break;
    }
  }
  if (!hex) return null;
  for (const mod of kids(color)) {
    const n = Number(attr(mod, "val") ?? Number.NaN) / 100_000;
    if (!Number.isFinite(n)) continue;
    switch (nameOf(mod)) {
      case "lumMod":
        hex = throughHsl(hex, ([h, s, l]) => [h, s, l * n]);
        break;
      case "lumOff":
        hex = throughHsl(hex, ([h, s, l]) => [h, s, l + n]);
        break;
      case "satMod":
        hex = throughHsl(hex, ([h, s, l]) => [h, s * n, l]);
        break;
      case "tint": {
        const [r, g, b] = rgbOf(hex);
        hex = toHex(...([r, g, b].map((c) => 1 - (1 - c / 255) * n) as [number, number, number]));
        break;
      }
      case "shade": {
        const [r, g, b] = rgbOf(hex);
        hex = toHex(...([r, g, b].map((c) => (c / 255) * n) as [number, number, number]));
        break;
      }
      case "alpha":
        alpha = clamp01(n);
        break;
    }
  }
  return { hex, alpha };
}

/** The relative luminance of a color (0 black … 1 white). */
export function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
