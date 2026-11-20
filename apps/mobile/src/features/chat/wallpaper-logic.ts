import type { Wallpaper, WallpaperHue } from "@agenteschat/client/lib/wallpaper";
import { rgbOf } from "@agenteschat/ui/agent/engine";
import {
  WALLPAPER_GLINTS,
  WALLPAPER_STARS,
  wallpaperGlintTone,
  wallpaperSkyIndex,
  wallpaperSkyTones,
} from "@agenteschat/ui/sky/wallpaper";

/**
 * A conversation's background on the phone, the parts with no React Native in them (`ChatWallpaper` draws them with
 * Skia): the sky's pixels, where a photo sits, how a drag moves it, and the screens that choose one. The numbers are
 * the shared painting's (packages/ui/src/sky/wallpaper.ts), so the phone and the web paint the same background.
 */

/** What "auto" paints on a tile for the DMs as a whole: no one agent's color, three side by side (as the design). */
export const AUTO_BANDS: readonly WallpaperHue[] = ["green", "sky", "rose"];

/** The longest side a photo is sent at (a phone screen at 3×, without sending the camera's 12 megapixels). */
export const PHOTO_MAX_SIDE = 1440;

/** A small seeded random (the night's stars land in the same places on every device). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The sky as `w`×`h` RGBA pixels (one per sky pixel, drawn 3 points wide on a screen, 1 on a tile): the tones of
 * `hues[0]`, or side by side bands of each (what "auto" means on the DMs' tile), dithered as the web dithers them.
 * `details`: the glints, and at night the stars (a tile is too small for them).
 */
export function skyPixels(
  hues: readonly WallpaperHue[],
  w: number,
  h: number,
  dark: boolean,
  details: boolean,
): Uint8Array {
  const sets = (hues.length > 0 ? hues : (["sky"] as const)).map((c) => wallpaperSkyTones(c, dark).map(rgbOf));
  const out = new Uint8Array(w * h * 4);
  const put = (x: number, y: number, rgb: readonly number[] | undefined) => {
    if (!rgb || x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 4;
    out[o] = rgb[0] ?? 0;
    out[o + 1] = rgb[1] ?? 0;
    out[o + 2] = rgb[2] ?? 0;
    out[o + 3] = 255;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const tones = sets[Math.min(sets.length - 1, Math.floor((x / w) * sets.length))] ?? sets[0] ?? [];
      put(x, y, tones[wallpaperSkyIndex(x, y, w, h, dark, tones.length)]);
    }
  if (!details) return out;
  const tones = sets[0] ?? [];
  if (dark) {
    const r = seeded(7);
    for (let k = 0; k < WALLPAPER_STARS; k++) {
      const tone = r() < 0.35 ? 5 : 4;
      put(Math.floor(r() * w), Math.floor(r() * h * 0.66), tones[tone]);
    }
  }
  const glint = tones[wallpaperGlintTone(dark)];
  for (const [u, v, big] of WALLPAPER_GLINTS) {
    const cx = Math.round(u * w);
    const cy = Math.round(v * h);
    const arm = big ? 2 : 1;
    for (let d = -arm; d <= arm; d++) {
      put(cx + d, cy, glint);
      put(cx, cy + d, glint);
    }
  }
  return out;
}

/** How far a photo covering a `boxW`×`boxH` box runs past it on each side, in points (0 where it fits exactly). */
export function photoOverflow(imageW: number, imageH: number, boxW: number, boxH: number) {
  if (imageW <= 0 || imageH <= 0 || boxW <= 0 || boxH <= 0) return { x: 0, y: 0, width: boxW, height: boxH };
  const k = Math.max(boxW / imageW, boxH / imageH);
  const width = imageW * k;
  const height = imageH * k;
  return { x: Math.max(0, width - boxW), y: Math.max(0, height - boxH), width, height };
}

/**
 * Where a photo is drawn to cover a box with its point of interest (`fx`, `fy`, 0–1) kept on screen, as the web's
 * `object-position: fx% fy%`: that point of the photo sits at that point of the box, so it never leaves it.
 */
export function photoCover(imageW: number, imageH: number, boxW: number, boxH: number, fx: number, fy: number) {
  const o = photoOverflow(imageW, imageH, boxW, boxH);
  return { x: 0 - o.x * clamp01(fx), y: 0 - o.y * clamp01(fy), width: o.width, height: o.height };
}

/** The point of interest after a drag of `moved` points from `from`, on a side running `over` points past the box. */
export function dragFocus(from: number, moved: number, over: number): number {
  "worklet";
  if (over <= 0) return from;
  const next = from - moved / over;
  return next < 0 ? 0 : next > 1 ? 1 : next;
}

/** A photo's size once its longest side is at most `max` (never made bigger). */
export function shrunkSize(width: number, height: number, max = PHOTO_MAX_SIDE) {
  const k = Math.min(1, max / Math.max(1, width, height));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);

/** Whose background the Background screens change: the one behind every conversation, or one conversation's. */
export type WallpaperTarget = { all: true } | { channelId: string };

/** The target from a screen's params: a conversation's id, else every conversation. */
export function wallpaperTargetOf(params: { channelId?: string }): WallpaperTarget {
  return params.channelId ? { channelId: params.channelId } : { all: true };
}

const query = (target: WallpaperTarget) =>
  "channelId" in target ? `?channelId=${encodeURIComponent(target.channelId)}` : "";

/** The pushed screens: Background, and a photo's preview over it (the photo, picked on Background, says whose it is). */
export const wallpaperHrefs = {
  choose: (target: WallpaperTarget) => `/me/chat-wallpaper${query(target)}` as const,
  photo: "/me/chat-wallpaper-photo" as const,
};

/** A background as a cache key: what changes its painting. */
export function wallpaperKey(w: Wallpaper): string {
  switch (w.kind) {
    case "none":
    case "agents":
      return w.kind;
    case "photo":
      return `photo:${w.url}:${w.x.toFixed(3)}:${w.y.toFixed(3)}:${w.dim.toFixed(3)}`;
    default:
      return `${w.kind}:${w.color}`;
  }
}
