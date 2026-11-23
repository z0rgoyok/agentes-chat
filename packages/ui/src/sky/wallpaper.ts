/**
 * How a conversation's background (packages/client/src/lib/wallpaper.ts) is painted, DOM-free, so the web
 * (a canvas, `ChatWallpaper`) and the phone (Skia) paint the same thing from the same numbers. Every family sits behind
 * the messages at a strength the words can be read on: the sky is strong only at the top (behind the bar) and at the
 * horizon (behind the composer), the drawings are tone on tone, and the styles with no bubbles take it at half.
 */
import { bodyPath, eyeShapes, gradientOf } from "../agent/engine.js";
import { bayerAt, mix } from "./math";

type Hue = "sky" | "indigo" | "violet" | "rose" | "amber" | "green" | "teal" | "graphite";
type Neutral = "paper" | "mist" | "sand";

/** The conversation's page under a background, as the apps paint it (white, and the dark theme's page). */
export const WALLPAPER_PAGE = { light: "#ffffff", dark: "#0f0f0e" } as const;
const pageOf = (dark: boolean) => (dark ? WALLPAPER_PAGE.dark : WALLPAPER_PAGE.light);

/** The quiet colors of Drawings and Cor, light and dark. */
export const WALLPAPER_NEUTRAL_TONES: Record<Neutral, { light: string; dark: string }> = {
  paper: { light: "#f4f2ed", dark: "#181816" },
  mist: { light: "#eef1f4", dark: "#141618" },
  sand: { light: "#f4ecde", dark: "#1c1914" },
};
const isNeutral = (c: string): c is Neutral => c in WALLPAPER_NEUTRAL_TONES;

/**
 * Over a background, someone else's bubble is lifted: white in light, a step over the page in dark, with the cards'
 * light shadow (mine keeps its color, and the shadow).
 */
export const WALLPAPER_LIFT = { light: "#ffffff", dark: "#232322" } as const;
/** The styles with no bubbles (the words straight on the background) take it at this strength. */
export const WALLPAPER_NO_BUBBLES_STRENGTH = 0.5;
export const wallpaperStrength = (bubbles: boolean) => (bubbles ? 1 : WALLPAPER_NO_BUBBLES_STRENGTH);

/* ---------- Sky: dithered ---------- */

/** Points per sky pixel on screen. */
export const WALLPAPER_SKY_PIXEL = 3;

/** The sky's tones for a color, the page first, toward the color (light) or toward its deep end, a night (dark). */
export function wallpaperSkyTones(color: Hue, dark: boolean): string[] {
  const [top, deep] = gradientOf(color);
  const p = pageOf(dark);
  return dark
    ? [p, mix(p, deep, 0.09), mix(p, deep, 0.19), mix(p, deep, 0.31), mix(p, top, 0.26), mix(p, top, 0.55)]
    : [p, mix(p, top, 0.12), mix(p, top, 0.26), mix(p, top, 0.42), mix(p, top, 0.62), top];
}

/** Clouds as the sky's blobs: [x, y, rx, ry, strength], in fractions of the screen. */
export const WALLPAPER_CLOUDS: readonly (readonly [number, number, number, number, number])[] = [
  [0.2, 0.15, 0.27, 0.045, 0.9],
  [0.8, 0.255, 0.22, 0.04, 0.75],
  [0.42, 0.37, 0.17, 0.026, 0.5],
  [0.85, 0.82, 0.26, 0.045, 0.55],
  [0.17, 0.9, 0.3, 0.05, 0.8],
];

/** The sky's field at (u, v), fractions of the screen: strong at the top, almost the page in the middle, a horizon. */
export function wallpaperSkyField(u: number, v: number, dark: boolean): number {
  let f = (dark ? 2.7 : 2.45) * Math.max(0, 1 - v / 0.46) ** 1.25;
  const t = (v - 0.72) / 0.28;
  f += 1.7 * (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  for (const [cx, cy, rx, ry, a] of WALLPAPER_CLOUDS) {
    const d = ((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2;
    if (d < 1) f += a * (1 - d) ** 1.2;
  }
  return Math.min(f, dark ? 3.7 : 3.4);
}

/** The tone index of sky pixel (x, y) in a `w`×`h` sky, dithered with the sky's Bayer 4×4. */
export function wallpaperSkyIndex(x: number, y: number, w: number, h: number, dark: boolean, levels = 6): number {
  const f = wallpaperSkyField(x / w, y / h, dark);
  const lo = Math.floor(f);
  const i = f - lo > bayerAt(x, y) ? lo + 1 : lo;
  return Math.max(0, Math.min(levels - 1, i));
}

/** Glints, a sky pixel cross each: [u, v, big] (big: arms of 2), away from the bar's buttons. */
export const WALLPAPER_GLINTS: readonly (readonly [number, number, boolean])[] = [
  [0.1, 0.165, true],
  [0.5, 0.19, false],
  [0.86, 0.2, false],
  [0.31, 0.27, false],
  [0.7, 0.36, false],
  [0.06, 0.47, false],
];
/** The glints' tone index in the sky's tones; a night also has a few stars (single pixels) in its upper two thirds. */
export const wallpaperGlintTone = (dark: boolean) => (dark ? 4 : 3);
export const WALLPAPER_STARS = 46;

/* ---------- Drawings: line drawings in the app's icon style ---------- */

/** The drawings, path data in a 24-point box, stroked (round caps and joins). */
export const DRAWING_ICONS = [
  "M8.5 4h7A4.5 4.5 0 0 1 20 8.5v7a4.5 4.5 0 0 1-4.5 4.5H6.8L4 17.2V8.5A4.5 4.5 0 0 1 8.5 4zM10 10v3M14 10v3", // an agent
  "M12 4c.7 4.6 2.4 6.3 7 7-4.6.7-6.3 2.4-7 7-.7-4.6-2.4-6.3-7-7 4.6-.7 6.3-2.4 7-7z", // a glint
  "M7.5 18h9.5a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.6-1.2A4.1 4.1 0 0 0 7.5 18z", // a cloud
  "M7.5 4.5h9A2.5 2.5 0 0 1 19 7v6a2.5 2.5 0 0 1-2.5 2.5H11L7 19v-3.5A2.5 2.5 0 0 1 5 13V7a2.5 2.5 0 0 1 2.5-2.5z", // a speech bubble
  "M4.5 6.5h15v11h-15zM4.5 7l7.5 6 7.5-6", // an envelope
  "M12 19s-7-4.3-7-9.2A3.8 3.8 0 0 1 12 7.6a3.8 3.8 0 0 1 7 2.2C19 14.7 12 19 12 19z", // a heart
  "M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z", // a folder
  "M5 19.5h14M7.5 16.5v-4M12 16.5v-9M16.5 16.5v-6", // a chart
  "M12 4.5a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15zM12 8v4l2.5 2", // a clock
  "M5.5 9h10v5a4 4 0 0 1-4 4h-2a4 4 0 0 1-4-4zM15.5 10.5H17a2 2 0 0 1 0 4h-1.5M8.5 4.5v2M11.5 4.5v2", // a cup
  "M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6", // the sun
  "M18.5 14.5A7 7 0 0 1 9.5 5.5a7 7 0 1 0 9 9z", // the moon
  "M10.5 5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM15 15l4.5 4.5", // a magnifier
  "M5 6.5h14V19H5zM5 10.5h14M9 4.5v3M15 4.5v3", // a calendar
  "M4.5 10.5 12 4.5l7.5 6v8a1.5 1.5 0 0 1-1.5 1.5h-3.5v-5.5h-5V20H6a1.5 1.5 0 0 1-1.5-1.5z", // a house
  "M20 4.5 3.5 11l6.5 2.5L12.5 20zM10 13.5l10-9", // a paper plane
  "M9.5 17V6l9-2v11M9.5 17a2.5 2.5 0 1 1-2.5-2.5A2.5 2.5 0 0 1 9.5 17zM18.5 15a2.5 2.5 0 1 1-2.5-2.5 2.5 2.5 0 0 1 2.5 2.5z", // a note
  "M5 19c0-8 5-13 14-13 0 9-5 13-11 13M5 19l7-7", // a leaf
  "M5 12.5l4.5 4.5L19 7.5", // a check
] as const;

/** The drawings's grid on a screen, and in a picker's tile. */
export const DRAWINGS = { cell: 50, size: 21, stroke: 1.35 } as const;
export const DRAWINGS_TILE = { cell: 22, size: 11, stroke: 1 } as const;

/** The drawings's page and its drawings' ink, tone on tone. */
export function drawingsColors(color: Neutral | Hue, dark: boolean): { bg: string; ink: string } {
  if (isNeutral(color)) {
    const bg = WALLPAPER_NEUTRAL_TONES[color][dark ? "dark" : "light"];
    return { bg, ink: mix(bg, dark ? "#ffffff" : "#000000", 0.1) };
  }
  const [top, deep] = gradientOf(color);
  const bg = dark ? mix(pageOf(true), deep, 0.2) : mix(pageOf(false), top, 0.14);
  return { bg, ink: dark ? mix(bg, top, 0.2) : mix(bg, deep, 0.2) };
}

/**
 * The cells of a half-drop grid over `w`×`h`: every other row moved half a cell, all upright, none skipped, each with
 * the index of what it holds, walking the set by row and column so no two neighbours repeat. `(x, y)` is the center.
 */
export function wallpaperGrid(w: number, h: number, cell: number, count: number, rise = 0.2) {
  const out: { x: number; y: number; index: number; row: number; col: number }[] = [];
  const rowH = cell * 0.866;
  for (let r = 0; r * rowH < h + cell; r++)
    for (let c = -1; c * cell < w + cell; c++) {
      out.push({
        x: c * cell + (r & 1 ? cell / 2 : 0) + cell / 2,
        y: r * rowH + cell / 2 - cell * rise,
        index: (((r * 7 + c * 3) % count) + count) % count,
        row: r,
        col: c,
      });
    }
  return out;
}

/* ---------- Crowd: many agents, faint ---------- */

/** The agents of the crowd: every color, a few eye styles; all faint (a texture, never a crowd). */
export const CROWD_HUES: readonly Hue[] = ["sky", "indigo", "violet", "rose", "amber", "green", "teal", "graphite"];
export const CROWD_EYES = ["round", "dots", "wide"] as const;
export const CROWD = { cell: 64, size: 26 } as const;
export const CROWD_TILE = { cell: 26, size: 12 } as const;

/** One agent of the crowd: its body's tone (a faint tint of its color) and its eyes'. */
export function crowdTones(color: Hue, dark: boolean): { body: string; eye: string } {
  const [top, deep] = gradientOf(color);
  const p = pageOf(dark);
  return dark ? { body: mix(p, deep, 0.13), eye: mix(p, "#ffffff", 0.07) } : { body: mix(p, top, 0.075), eye: p };
}

/** The crowd's agents on a `w`×`h` screen: the top-left of each body, its side, color and eyes. */
export function crowdAgents(w: number, h: number, cell: number, size: number) {
  return wallpaperGrid(w, h, cell, CROWD_HUES.length, 0).map((g) => ({
    x: Math.round(g.x - size / 2),
    y: Math.round(g.y - size / 2),
    size,
    color: CROWD_HUES[(((g.row * 3 + g.col * 5) % CROWD_HUES.length) + CROWD_HUES.length) % CROWD_HUES.length] as Hue,
    eyes: CROWD_EYES[(((g.row + g.col * 2) % CROWD_EYES.length) + CROWD_EYES.length) % CROWD_EYES.length] as string,
  }));
}

/** The body's outline and the eyes' boxes of an agent at (x, y), side `s` (the agent engine's shape). */
export const crowdShape = (x: number, y: number, s: number, eyes: string) => ({
  body: bodyPath(x, y, s),
  eyes: eyeShapes(eyes).map((e) => ({ x: x + e.x * s, y: y + e.y * s, w: e.w * s, h: e.h * s })),
});

/* ---------- Color ---------- */

/** One flat color: a neutral as it is, an agent's color as a light tint (light) or a deep one (dark). */
export function wallpaperFill(color: Neutral | Hue, dark: boolean): string {
  if (isNeutral(color)) return WALLPAPER_NEUTRAL_TONES[color][dark ? "dark" : "light"];
  const [top, deep] = gradientOf(color);
  return dark ? mix(pageOf(true), deep, 0.26) : mix(pageOf(false), top, 0.2);
}

/** A tile's look before its picture paints, and what a background "is" at a glance (the sky's middle tone). */
export function wallpaperSwatch(w: { kind: string; color?: string }, dark: boolean): string {
  if (w.kind === "sky") return wallpaperSkyTones((w.color as Hue) ?? "sky", dark)[1] as string;
  if (w.kind === "drawings") return drawingsColors((w.color as Neutral | Hue) ?? "paper", dark).bg;
  if (w.kind === "color") return wallpaperFill((w.color as Neutral | Hue) ?? "paper", dark);
  return pageOf(dark);
}
