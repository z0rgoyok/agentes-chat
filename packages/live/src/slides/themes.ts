import { readableOn } from "../colors";
import {
  assetFontFamily,
  catalogFont,
  catalogFontNamed,
  type FontCategory,
  type FontRef,
  fontAssetOf,
  isFontRole,
} from "../fonts";
import { type DeckFonts, type ElementStyle, type ElementType, isThemeId, type SlideRole, type ThemeId } from "./types";

/**
 * The six presentation themes (ADR 0196 §2). They use only the app's own fonts (Funnel Display for headings, Source
 * Sans 3 for the rest), and every text color reads at 4.5:1 or more on the theme's background and on its surface
 * (tests check it), so a slide stays legible on a projector, in a thumbnail and in an export.
 *
 * Sizes are in slide units: px of the 1920×1080 slide, so 40 is the body text a room can read from the back.
 */

/** A slide's size in slide units. */
export const SLIDE_W = 1920;
export const SLIDE_H = 1080;

export type HeadingFont = "Funnel Display" | "Source Sans 3";
export type BodyFont = "Source Sans 3";

export interface SlideTheme {
  id: ThemeId;
  dark: boolean;
  fonts: { heading: HeadingFont; body: BodyFont };
  colors: { bg: string; text: string; muted: string; accent: string; accent2: string; surface: string; line: string };
  sizes: { title: number; subtitle: number; body: number; caption: number; number: number };
  /** Weights the theme gives headings (titles, quotes) and big numbers. */
  weights: { heading: 400 | 600 | 700; number: 400 | 600 | 700 };
}

const SIZES: SlideTheme["sizes"] = { title: 72, subtitle: 44, body: 40, caption: 26, number: 240 };

export const THEMES: Record<ThemeId, SlideTheme> = {
  /** White with the sky blue accent: the app's own look. */
  sky: {
    id: "sky",
    dark: false,
    fonts: { heading: "Funnel Display", body: "Source Sans 3" },
    colors: {
      bg: "#ffffff",
      text: "#0e1a2b",
      muted: "#4c5a6c",
      accent: "#0063d1",
      accent2: "#0b7a6c",
      surface: "#eef5fd",
      line: "#d3e2f2",
    },
    sizes: SIZES,
    weights: { heading: 600, number: 700 },
  },
  /** Deep navy, light text. */
  night: {
    id: "night",
    dark: true,
    fonts: { heading: "Funnel Display", body: "Source Sans 3" },
    colors: {
      bg: "#0b1426",
      text: "#f1f5fb",
      muted: "#a6b4c8",
      accent: "#5aa8ff",
      accent2: "#f5b74f",
      surface: "#14223b",
      line: "#2a3b5a",
    },
    sizes: SIZES,
    weights: { heading: 600, number: 700 },
  },
  /** Warm off-white with ink text, like a printed page. */
  paper: {
    id: "paper",
    dark: false,
    fonts: { heading: "Funnel Display", body: "Source Sans 3" },
    colors: {
      bg: "#f8f4ec",
      text: "#221d17",
      muted: "#665c4f",
      accent: "#a8431c",
      accent2: "#2f5f4f",
      surface: "#efe7d9",
      line: "#dccfba",
    },
    sizes: SIZES,
    weights: { heading: 600, number: 700 },
  },
  /** Dark gray, quiet. */
  graphite: {
    id: "graphite",
    dark: true,
    fonts: { heading: "Funnel Display", body: "Source Sans 3" },
    colors: {
      bg: "#1e2024",
      text: "#f2f2f0",
      muted: "#a9abb0",
      accent: "#8ab4ff",
      accent2: "#f4b26b",
      surface: "#2a2d33",
      line: "#3c4048",
    },
    sizes: SIZES,
    weights: { heading: 600, number: 700 },
  },
  /** Black on white, bold: the most legible in a bright room. */
  contrast: {
    id: "contrast",
    dark: false,
    fonts: { heading: "Source Sans 3", body: "Source Sans 3" },
    colors: {
      bg: "#ffffff",
      text: "#000000",
      muted: "#3f3f3f",
      accent: "#d4002a",
      accent2: "#0047e0",
      surface: "#f2f2f2",
      line: "#000000",
    },
    sizes: { ...SIZES, title: 76, number: 260 },
    weights: { heading: 700, number: 700 },
  },
  /** Deep green, light text. */
  forest: {
    id: "forest",
    dark: true,
    fonts: { heading: "Funnel Display", body: "Source Sans 3" },
    colors: {
      bg: "#0e271d",
      text: "#eef6f0",
      muted: "#a5c3b0",
      accent: "#7ad7a0",
      accent2: "#f0c56e",
      surface: "#153626",
      line: "#25503b",
    },
    sizes: SIZES,
    weights: { heading: 600, number: 700 },
  },
};

export const DEFAULT_THEME: ThemeId = "sky";

/** A theme by id, the default one for anything else. */
export function themeOf(id: unknown): SlideTheme {
  return isThemeId(id) ? THEMES[id] : THEMES[DEFAULT_THEME];
}

/** How a text (or a shape's label) is drawn: the theme's look for its role, under what the element sets itself. */
export interface TextLook {
  /** The theme role its font comes from, or the role it would have (headings draw a little tighter). */
  font: "heading" | "body";
  /** The font drawn (ADR 0220): a catalog id or one of the file's fonts, never a role. */
  fontRef: FontRef;
  /** The family name to draw it with: a catalog family, or a file's font under its `assetFontFamily` name. */
  fontFamily: string;
  /** Its kind, for what to fall back to while it loads. */
  category: FontCategory;
  size: number;
  weight: number;
  color: string;
  align: "left" | "center" | "right";
  valign: "top" | "middle" | "bottom";
  /** Line height as a multiple of the size. */
  lineHeight: number;
  /** Letter spacing in thousandths of the size (0: none). */
  tracking: number;
  caps: boolean;
  /** Room between the box's edge and the text, in slide units. */
  padding: number;
}

type RoleLook = Pick<TextLook, "font" | "weight" | "align" | "valign" | "lineHeight"> & {
  size: keyof SlideTheme["sizes"] | number;
  color: keyof SlideTheme["colors"];
};

/** A font ref as drawn: its family name and kind. A ref nothing knows draws as the theme's body font. */
export function fontFace(
  ref: FontRef,
  fallback: FontRef = "source-sans-3",
): {
  ref: FontRef;
  family: string;
  category: FontCategory;
} {
  const asset = fontAssetOf(ref);
  if (asset) return { ref, family: assetFontFamily(asset), category: "sans" };
  const font = catalogFont(ref) ?? catalogFont(fallback) ?? catalogFont("source-sans-3");
  return font
    ? { ref: font.id, family: font.family, category: font.category }
    : { ref: "source-sans-3", family: "Source Sans 3", category: "sans" };
}

/** The fonts a deck draws its roles with: its own over its theme's (ADR 0220 §3), as catalog ids or file fonts. */
export function roleFonts(theme: SlideTheme, fonts?: DeckFonts): Record<"heading" | "body", FontRef> {
  return {
    heading: fonts?.heading ?? catalogFontNamed(theme.fonts.heading)?.id ?? "funnel-display",
    body: fonts?.body ?? catalogFontNamed(theme.fonts.body)?.id ?? "source-sans-3",
  };
}

function roleLook(theme: SlideTheme, role: SlideRole | undefined): RoleLook {
  const heading = theme.weights.heading;
  switch (role) {
    case "title":
      return {
        font: "heading",
        size: "title",
        weight: heading,
        color: "text",
        align: "left",
        valign: "bottom",
        lineHeight: 1.1,
      };
    case "subtitle":
      return {
        font: "body",
        size: "subtitle",
        weight: 400,
        color: "muted",
        align: "left",
        valign: "top",
        lineHeight: 1.25,
      };
    case "caption":
      return {
        font: "body",
        size: "caption",
        weight: 400,
        color: "muted",
        align: "left",
        valign: "top",
        lineHeight: 1.3,
      };
    case "number":
      return {
        font: "heading",
        size: "number",
        weight: theme.weights.number,
        color: "accent",
        align: "left",
        valign: "bottom",
        lineHeight: 1,
      };
    case "quote":
      return {
        font: "heading",
        size: Math.round(theme.sizes.title * 0.9),
        weight: heading === 700 ? 700 : 400,
        color: "text",
        align: "left",
        valign: "bottom",
        lineHeight: 1.2,
      };
    default:
      return {
        font: "body",
        size: "body",
        weight: 400,
        color: "text",
        align: "left",
        valign: "top",
        lineHeight: 1.35,
      };
  }
}

/** Shapes without a fill of their own take the accent. */
export function shapeFill(theme: SlideTheme, style: ElementStyle | undefined): string {
  return style?.fill ?? theme.colors.accent;
}

/**
 * The look of an element's text: its role's look in the theme, then the element's own style over it. `fonts`: the
 * deck's own fonts (ADR 0220 §3), over the theme's.
 */
export function textLook(
  theme: SlideTheme,
  el: { type: ElementType; role?: SlideRole; style?: ElementStyle },
  fonts?: DeckFonts,
): TextLook {
  const base = roleLook(theme, el.role);
  const style = el.style ?? {};
  const roles = roleFonts(theme, fonts);
  const font = isFontRole(style.font) ? style.font : base.font;
  const face = fontFace(style.font && !isFontRole(style.font) ? style.font : roles[font], roles.body);
  let color = style.color ?? theme.colors[base.color];
  let align = base.align;
  let valign = base.valign;
  let weight: number = base.weight;
  if (el.type === "shape") {
    // A shape's label sits in its middle, in the color that reads best on its fill.
    align = "center";
    valign = "middle";
    weight = 600;
    const fill = shapeFill(theme, el.style);
    if (!style.color && fill !== "none") color = readableOn(fill, [theme.colors.bg, theme.colors.text]);
  }
  return {
    font,
    fontRef: face.ref,
    fontFamily: face.family,
    category: face.category,
    size: style.size ?? (typeof base.size === "number" ? base.size : theme.sizes[base.size]),
    weight: style.weight ?? weight,
    color,
    align: style.align ?? align,
    valign: style.valign ?? valign,
    lineHeight: style.lineHeight ?? base.lineHeight,
    tracking: style.tracking ?? 0,
    caps: style.caps === true,
    padding: style.padding ?? 0,
  };
}

/** The colors a chart's series take, in order. */
export function chartColors(theme: SlideTheme): string[] {
  return [theme.colors.accent, theme.colors.accent2, theme.colors.muted];
}
