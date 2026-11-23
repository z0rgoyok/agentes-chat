/**
 * A conversation's background (packages/client/src/lib/wallpaper.ts) painted on a canvas, from the numbers the phone
 * paints it with (packages/ui/src/sky/wallpaper.ts): the sky in square pixels of `WALLPAPER_SKY_PIXEL` points, the
 * drawings and the agents as paths at up to twice the screen's pixels, a color in one pixel the box stretches. A photo
 * is not painted here: `ChatWallpaper` shows it as the box's cover image.
 */
import type { Wallpaper, WallpaperHue, WallpaperNeutral } from "@agenteschat/client/lib/wallpaper";
import { parseColor } from "@agenteschat/ui/sky/math";
import {
  CROWD,
  CROWD_TILE,
  crowdAgents,
  crowdShape,
  crowdTones,
  DRAWING_ICONS,
  DRAWINGS,
  DRAWINGS_TILE,
  drawingsColors,
  WALLPAPER_GLINTS,
  WALLPAPER_LIFT,
  WALLPAPER_PAGE,
  WALLPAPER_SKY_PIXEL,
  WALLPAPER_STARS,
  wallpaperFill,
  wallpaperGlintTone,
  wallpaperGrid,
  wallpaperSkyIndex,
  wallpaperSkyTones,
} from "@agenteschat/ui/sky/wallpaper";
import type { CSSProperties } from "react";

export interface PaintOptions {
  dark: boolean;
  /** A picker's tile or a row's thumbnail: one point per sky pixel, the small drawings, no glints or stars. */
  small?: boolean;
  /** "auto" still in the background (the DMs' picker): each of these colors in a band, side by side. */
  bands?: readonly WallpaperHue[];
  /** The screen's pixels per point (`devicePixelRatio`): the drawings take up to 2 of them. */
  ratio?: number;
}

type Ctx = CanvasRenderingContext2D;
type Rgb = [number, number, number];
const BLACK: Rgb = [0, 0, 0];

/** What sits over a background reads these: someone else's bubble lifted, and the page a veil is made of. */
export const wallpaperVars = (dark: boolean) =>
  ({
    "--wallpaper-lift": WALLPAPER_LIFT[dark ? "dark" : "light"],
    "--wallpaper-page": WALLPAPER_PAGE[dark ? "dark" : "light"],
  }) as CSSProperties;

/** The same stars every time: a small seeded generator. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The sky, one canvas pixel per sky pixel: its dithered field, then (full size) a night's stars and the glints. */
function paintSky(ctx: Ctx, w: number, h: number, colors: readonly WallpaperHue[], dark: boolean, small: boolean) {
  const sets = colors.map((c) => wallpaperSkyTones(c, dark));
  const rgb = sets.map((set) => set.map(parseColor));
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const n = rgb.length;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const band: Rgb[] = rgb[Math.min(n - 1, Math.floor((x / w) * n))] ?? rgb[0] ?? [];
      const [r, g, b] = band[wallpaperSkyIndex(x, y, w, h, dark, band.length)] ?? BLACK;
      const o = (y * w + x) * 4;
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      d[o + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  const tones = sets[0];
  if (small || !tones) return;
  if (dark) {
    const next = seeded(7);
    for (let k = 0; k < WALLPAPER_STARS; k++) {
      ctx.fillStyle = (next() < 0.35 ? tones[5] : tones[4]) ?? "transparent";
      ctx.fillRect(Math.floor(next() * w), Math.floor(next() * h * 0.66), 1, 1);
    }
  }
  ctx.fillStyle = tones[wallpaperGlintTone(dark)] ?? "transparent";
  for (const [u, v, big] of WALLPAPER_GLINTS) {
    const cx = Math.round(u * w);
    const cy = Math.round(v * h);
    const arm = big ? 2 : 1;
    ctx.fillRect(cx - arm, cy, 2 * arm + 1, 1);
    ctx.fillRect(cx, cy - arm, 1, 2 * arm + 1);
  }
}

let icons: Path2D[] | null = null;
const drawingsIcons = () => {
  icons ??= DRAWING_ICONS.map((d) => new Path2D(d));
  return icons;
};

/** The drawings, tone on tone, in points (the context is already scaled); one band per color. */
function paintDrawings(
  ctx: Ctx,
  w: number,
  h: number,
  colors: readonly (WallpaperNeutral | WallpaperHue)[],
  dark: boolean,
  small: boolean,
) {
  const spec = small ? DRAWINGS_TILE : DRAWINGS;
  const paths = drawingsIcons();
  const cells = wallpaperGrid(w, h, spec.cell, paths.length);
  const s = spec.size / 24;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  colors.forEach((color, i) => {
    const x0 = Math.round((i * w) / colors.length);
    const x1 = Math.round(((i + 1) * w) / colors.length);
    const { bg, ink } = drawingsColors(color, dark);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, x1 - x0, h);
    ctx.clip();
    ctx.fillStyle = bg;
    ctx.fillRect(x0, 0, x1 - x0, h);
    ctx.strokeStyle = ink;
    ctx.lineWidth = spec.stroke / s;
    for (const cell of cells) {
      const path = paths[cell.index];
      if (!path || cell.x + spec.size < x0 || cell.x - spec.size > x1) continue;
      ctx.save();
      ctx.translate(cell.x - 12 * s, cell.y - 12 * s);
      ctx.scale(s, s);
      ctx.stroke(path);
      ctx.restore();
    }
    ctx.restore();
  });
}

/** An eye's box as a pill. */
function pill(ctx: Ctx, x: number, y: number, w: number, h: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, Math.min(w, h) / 2);
  else ctx.rect(x, y, w, h);
  ctx.fill();
}

/** Many agents, faint, on the page. */
function paintCrowd(ctx: Ctx, w: number, h: number, dark: boolean, small: boolean) {
  const spec = small ? CROWD_TILE : CROWD;
  ctx.fillStyle = WALLPAPER_PAGE[dark ? "dark" : "light"];
  ctx.fillRect(0, 0, w, h);
  for (const agent of crowdAgents(w, h, spec.cell, spec.size)) {
    const tones = crowdTones(agent.color, dark);
    const shape = crowdShape(agent.x, agent.y, agent.size, agent.eyes);
    ctx.fillStyle = tones.body;
    ctx.fill(new Path2D(shape.body));
    ctx.fillStyle = tones.eye;
    for (const eye of shape.eyes) pill(ctx, eye.x, eye.y, eye.w, eye.h);
  }
}

/** One flat color in one pixel, which the box stretches. */
function paintFlat(canvas: HTMLCanvasElement, ctx: Ctx, color: string) {
  canvas.width = 1;
  canvas.height = 1;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
}

/**
 * Paints `wallpaper` for a `width`×`height` box (in points) on `canvas`, sizing the canvas for it. "none" (a picker's
 * tile) is the page. Nothing happens where there is no 2D canvas (a test's DOM).
 */
export function paintWallpaper(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  wallpaper: Wallpaper,
  o: PaintOptions,
): void {
  const ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  if (!ctx || width <= 0 || height <= 0) return;
  const small = Boolean(o.small);
  const page = WALLPAPER_PAGE[o.dark ? "dark" : "light"];
  try {
    switch (wallpaper.kind) {
      case "sky": {
        const px = small ? 1 : WALLPAPER_SKY_PIXEL;
        const w = Math.max(1, Math.ceil(width / px));
        const h = Math.max(1, Math.ceil(height / px));
        canvas.width = w;
        canvas.height = h;
        paintSky(ctx, w, h, wallpaper.color === "auto" ? (o.bands ?? ["sky"]) : [wallpaper.color], o.dark, small);
        return;
      }
      case "drawings":
      case "agents": {
        if (typeof Path2D === "undefined") {
          paintFlat(canvas, ctx, page);
          return;
        }
        const ratio = small ? 2 : Math.min(2, Math.max(1, o.ratio ?? 1));
        canvas.width = Math.max(1, Math.round(width * ratio));
        canvas.height = Math.max(1, Math.round(height * ratio));
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        if (wallpaper.kind === "agents") paintCrowd(ctx, width, height, o.dark, small);
        else {
          const colors = wallpaper.color === "auto" ? (o.bands ?? ["sky"]) : [wallpaper.color];
          paintDrawings(ctx, width, height, colors, o.dark, small);
        }
        return;
      }
      case "color":
        paintFlat(canvas, ctx, wallpaperFill(wallpaper.color, o.dark));
        return;
      default:
        paintFlat(canvas, ctx, page);
    }
  } catch {
    // A canvas that can't draw this keeps the page under it.
  }
}
