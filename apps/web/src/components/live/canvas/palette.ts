import { readableOn } from "@agenteschat/live";
import type { NoteColor } from "@agenteschat/live/canvas";
import type { CSSProperties } from "react";

/**
 * The canvas's soft colors (ADR 0196 §2): notes keep a color's name (`yellow`), drawn by the theme's own tone; shapes
 * and frames keep a hex fill (any app or agent may write one), so the light tones of this palette are what they store,
 * and the dark theme swaps each for its own deep tone. A fill from outside the palette shows as it is, with whichever
 * ink reads on it.
 */
export const SOFT: Record<NoteColor, { light: string; dark: string }> = {
  yellow: { light: "#fdf0b0", dark: "#4a4020" },
  pink: { light: "#fbd8e3", dark: "#4d2633" },
  blue: { light: "#d5e7fb", dark: "#1e3449" },
  green: { light: "#d4efd7", dark: "#1f3d27" },
  purple: { light: "#e5dbfa", dark: "#33294d" },
  gray: { light: "#ebebe8", dark: "#2e2e2c" },
};

const DARK_OF = new Map(Object.values(SOFT).map((c) => [c.light.toLowerCase(), c.dark]));

/** The palette's name for a stored fill, if it is one of ours. */
export function softName(fill: string | undefined): NoteColor | null {
  if (!fill) return null;
  const key = fill.toLowerCase();
  for (const [name, c] of Object.entries(SOFT) as [NoteColor, (typeof SOFT)[NoteColor]][]) {
    if (c.light === key) return name;
  }
  return null;
}

const INKS = ["#151514", "#ffffff"] as const;
const DARK_INKS = ["#efefec", "#151514"] as const;

/** The style a stored fill draws with: its light and dark tones and the ink that reads on each. */
export function fillStyle(fill: string): CSSProperties {
  const light = fill;
  const dark = DARK_OF.get(fill.toLowerCase()) ?? fill;
  return {
    "--fill-light": light,
    "--fill-dark": dark,
    "--fill-ink-light": readableOn(light, INKS),
    "--fill-ink-dark": readableOn(dark, DARK_INKS),
  } as CSSProperties;
}

/** Whether a color is near black (the ink people draw with), which the dark theme draws light. */
export function isInk(color: string): boolean {
  const hex = color.replace("#", "");
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex.slice(0, 6);
  const n = Number.parseInt(full, 16);
  if (!/^[0-9a-f]{6}$/i.test(full) || !Number.isFinite(n)) return false;
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) < 48;
}

/** The ink's tone on the dark canvas. */
export const DARK_INK = "#efefec";

/**
 * A border's, a line's or a pen stroke's color and width as CSS variables (`--stroke-light`, `--stroke-dark`,
 * `--stroke-width`, read by canvas.css): the ink drawn light on the dark canvas, any other color as it is.
 */
export function strokeStyle(stroke: string | undefined, width?: number): CSSProperties | undefined {
  if (!stroke && !width) return undefined;
  const style: Record<string, string> = {};
  if (stroke && stroke !== "none") {
    style["--stroke-light"] = stroke;
    style["--stroke-dark"] = isInk(stroke) ? DARK_INK : stroke;
  }
  if (width) style["--stroke-width"] = String(width);
  return style as CSSProperties;
}
