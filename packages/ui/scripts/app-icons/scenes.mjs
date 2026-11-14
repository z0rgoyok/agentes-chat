/**
 * The app icons a person can pick (ADR 0179), drawn from the agent engine: the same body, dither and eyes as the
 * avatar and the logo. Each icon is a 1024 scene on a grid of 32 cells (one dither cell of the agent = one cell of
 * its sky), in light and dark, plus its favicon drawn pixel by pixel at 16 and 32 px (a 1024 drawing scaled down
 * blurs there). Layers: `mask`/`color` (see raster.mjs), `bg` for what Android puts on the icon's back layer, and
 * `part` ("agent", "eyes", "moon") for the one-color icon.
 */
import { bodyTones, EYE_STYLES, EYE_X, eyeShapes, inBody, toneAt } from "../../src/agent/engine.js";

/** The ids, in the order the pickers show them; the first is the icon the apps ship with. */
export const APP_ICON_IDS = ["night", "moon", "sky", "peekNight", "peekSky"];

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const by = (x, y) => BAYER[(x & 3) + (y & 3) * 4];
const pick = (list, i) => list[Math.max(0, Math.min(list.length - 1, i))];

const SKY_T = bodyTones("sky");
/** The sky's small agents are navy (`spriteBody`); this is that navy in five tones, deep to light. */
const NAVY_T = ["#010b17", "#04203f", "#0a3263", "#124585", "#1d5aa5"];
const NIGHT = ["#03101f", "#061a31", "#0a2645", "#0f345c"];
const DAY = ["#4693e8", "#8cc3ff", "#c6e1ff", "#e8f2ff"];
const NAVY_TILE = "#06192f";
const SPRITE_NAVY = "#06264a";
const BLACK_NIGHT = "#03070d";
const WHITE = "#ffffff";

/* ---------- Layers in the 1024 scene ---------- */

const always = () => true;
const fill = (hex) => ({ bg: true, mask: always, color: () => hex });
function grid(cols, colorAt) {
  const c = 1024 / cols;
  return { bg: true, mask: always, color: (x, y) => colorAt(Math.floor(x / c), Math.floor(y / c), cols) };
}
function cells(cols, list, extra = {}) {
  const c = 1024 / cols;
  const at = new Map(list.map(([i, j, col]) => [i * 4096 + j, col]));
  const color = (x, y) => at.get(Math.floor(x / c) * 4096 + Math.floor(y / c));
  return { bg: true, mask: (x, y) => color(x, y) !== undefined, color, ...extra };
}
/** Pixel art from rows of "X". */
function shape(cols, rows, ox, oy, col) {
  const list = [];
  for (const [j, row] of rows.entries())
    for (const [i, ch] of [...row].entries()) if (ch === "X") list.push([ox + i, oy + j, col]);
  return cells(cols, list);
}
/** A crescent: the cells inside one circle and outside another (in cells). */
function moon(cols, [cx, cy, r], [cx2, cy2, r2], col) {
  const list = [];
  for (let j = 0; j < cols; j++)
    for (let i = 0; i < cols; i++) {
      const x = i + 0.5;
      const y = j + 0.5;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r && (x - cx2) ** 2 + (y - cy2) ** 2 > r2 * r2) list.push([i, j, col]);
    }
  return cells(cols, list, { bg: false, part: "moon" });
}
export function inRound(x, y, x0, y0, w, h, r) {
  if (x < x0 || y < y0 || x > x0 + w || y > y0 + h) return false;
  const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
  const cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
/** The agent: its body (the engine's shape, dithered in `tones` or one `solid` color) and its white eyes. */
function agent({ x, y, s, n, tones, solid, style = "round", pose = {} }) {
  const c = s / n;
  const eyes = eyeShapes(style, pose).map((e) => ({ x: x + e.x * s, y: y + e.y * s, w: e.w * s, h: e.h * s }));
  return [
    {
      part: "agent",
      mask: (X, Y) => inBody((X - x) / s, (Y - y) / s),
      color: solid ? () => solid : (X, Y) => tones[toneAt(Math.floor((X - x) / c), Math.floor((Y - y) / c), n)],
    },
    {
      part: "eyes",
      mask: (X, Y) => eyes.some((e) => inRound(X, Y, e.x, e.y, e.w, e.h, Math.min(e.w, e.h) / 2)),
      color: () => WHITE,
    },
  ];
}

function nightAt(halo) {
  return (i, j, cols) => {
    const u = (i + 0.5) / cols;
    const v = (j + 0.5) / cols;
    let val = 0.18 + 0.28 * v;
    if (halo) val += 2.4 * Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.47) / 0.6) ** 1.6;
    return pick(NIGHT, Math.floor(val + by(i, j)));
  };
}
const dayAt = (i, j, cols) => pick(DAY, Math.floor(((j + 0.5) / cols) * 2.7 + by(i, j)));

/** The agent on the 32-cell grid: cells 7..24 × 6..23, one dither cell = one cell of the sky. */
const AG = { x: 224, y: 192, s: 576, n: 18 };
/** Smaller and to the left, so the moon fits: cells 6..22 × 8..24. */
const AG_MOON = { x: 192, y: 256, s: 544, n: 17 };
/** Big, coming up from the bottom edge and looking up: cells 2..29 × 9.. */
const PEEK = { x: 64, y: 288, s: 896, n: 28, pose: { look: [-0.035, -0.045] } };
const LOOK_UP_RIGHT = { look: [0.035, -0.05] };

const STARS = [
  [4, 4, "#c6e1ff"],
  [27, 5, "#8cc3ff"],
  [16, 2, "#4693e8"],
  [3, 18, "#4693e8"],
  [28, 25, "#c6e1ff"],
  [9, 28, "#8cc3ff"],
  [22, 28, "#4693e8"],
];
const STARS_MOON = [
  [4, 4, "#c6e1ff"],
  [11, 3, "#8cc3ff"],
  [16, 5, "#4693e8"],
  [3, 14, "#4693e8"],
  [28, 17, "#8cc3ff"],
  [27, 26, "#c6e1ff"],
  [4, 27, "#8cc3ff"],
  [26, 12, "#4693e8"],
];
const STARS_TOP = [
  [4, 3, "#c6e1ff"],
  [27, 4, "#8cc3ff"],
  [16, 2, "#4693e8"],
  [9, 6, "#4693e8"],
  [23, 7, "#c6e1ff"],
];
const CLOUD_A = ["..XX...", ".XXXXX.", "XXXXXXX"];
const CLOUD_B = [".XXX.", "XXXXX"];
const MOON = [
  [25, 5.2, 3.3],
  [26.6, 4.2, 2.7],
];

/* ---------- Favicons, in pixels ---------- */

const tile = (N, r, color) => ({
  mask: (x, y) => inRound(x, y, 0, 0, N, N, r),
  color: typeof color === "function" ? color : () => color,
});
const body = (bx, by_, bs, color) => ({
  mask: (x, y) => inBody((x - bx) / bs, (y - by_) / bs),
  color: typeof color === "function" ? color : () => color,
});
const clipped = (N, r, layer) => ({ ...layer, mask: (x, y) => inRound(x, y, 0, 0, N, N, r) && layer.mask(x, y) });
/** The body dithered in cells of `cell` pixels. */
const dith = (bx, by_, bs, cell, tones) => (x, y) =>
  tones[toneAt(Math.floor((x - bx) / cell), Math.floor((y - by_) / cell), bs / cell)];
/** The body in three flat bands, light to deep (at 16 px a dither is noise). */
function bands(bx, by_, bs, tones) {
  const set = [tones[1], tones[2], tones[3]];
  return (x, y) => {
    const u = (x - bx) / bs;
    const v = (y - by_) / bs;
    return pick(set, Math.floor((0.92 - 0.75 * v - 0.12 * u) * set.length));
  };
}
/** Eyes on whole pixels and mirrored around the body's middle, so both are the same. */
function snapEyes(bx, by_, bs, { style = "round", look = [0, 0] } = {}) {
  const base = EYE_STYLES[style];
  const W = Math.max(1, Math.round(base.w * bs));
  const H = Math.max(2, Math.round(base.h * bs));
  const xL = Math.round(bx + EYE_X[0] * bs - W / 2);
  const xR = Math.round(2 * bx + bs - xL - W);
  const y = Math.round(by_ + base.cy * bs - H / 2);
  const dx = Math.round(look[0] * bs);
  const dy = Math.round(look[1] * bs);
  const rects = [
    [xL + dx, y + dy],
    [xR + dx, y + dy],
  ];
  return {
    mask: (px, py) => rects.some(([ex, ey]) => px >= ex && px < ex + W && py >= ey && py < ey + H),
    color: () => WHITE,
  };
}
const pixels = (list, color) => ({
  mask: (x, y) => list.some(([i, j]) => Math.floor(x) === i && Math.floor(y) === j),
  color: () => color,
});
const crescent = ([cx, cy, r], [cx2, cy2, r2], color) => ({
  mask: (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r && (x - cx2) ** 2 + (y - cy2) ** 2 > r2 * r2,
  color: () => color,
});
/** The day sky at 32 px: dithered in 2-pixel cells. */
const skyTile32 = (x, y) => pick(DAY, Math.floor(((Math.floor(y) + 0.5) / 32) * 2.2 + by(x >> 1, y >> 1)));

/* ---------- The icons ---------- */

export const SCENES = {
  /** Noite: the night sky, a glow in dither around the agent (the landing's giant), loose stars. */
  night: {
    light: () => [grid(32, nightAt(true)), cells(32, STARS), ...agent({ ...AG, tones: SKY_T })],
    dark: () => [fill(BLACK_NIGHT), cells(32, STARS), ...agent({ ...AG, tones: SKY_T })],
    favicon: (N) =>
      N === 32
        ? [tile(32, 7, NAVY_TILE), body(5, 5, 22, dith(5, 5, 22, 2, SKY_T)), snapEyes(5, 5, 22)]
        : [tile(16, 3.5, NAVY_TILE), body(2, 2, 12, bands(2, 2, 12, SKY_T)), snapEyes(2, 2, 12, { style: "wide" })],
  },
  /** Lua: a pixel moon in the corner and the agent looking up at it. */
  moon: {
    light: () => [
      grid(32, nightAt(false)),
      cells(32, STARS_MOON),
      moon(32, MOON[0], MOON[1], "#e8f2ff"),
      ...agent({ ...AG_MOON, tones: SKY_T, pose: LOOK_UP_RIGHT }),
    ],
    dark: () => [
      fill(BLACK_NIGHT),
      cells(32, STARS_MOON),
      moon(32, MOON[0], MOON[1], "#c6e1ff"),
      ...agent({ ...AG_MOON, tones: SKY_T, pose: LOOK_UP_RIGHT }),
    ],
    favicon: (N) =>
      N === 32
        ? [
            tile(32, 7, NAVY_TILE),
            crescent([26.5, 5.5, 3.6], [28, 4.3, 3], "#e8f2ff"),
            body(3, 7, 22, dith(3, 7, 22, 2, SKY_T)),
            snapEyes(3, 7, 22, LOOK_UP_RIGHT),
          ]
        : [
            tile(16, 3.5, NAVY_TILE),
            pixels(
              [
                [12, 1],
                [13, 1],
                [12, 2],
                [13, 2],
              ],
              "#e8f2ff",
            ),
            body(2, 3, 12, bands(2, 3, 12, SKY_T)),
            snapEyes(2, 3, 12, { style: "wide", ...LOOK_UP_RIGHT }),
          ],
  },
  /** Céu: the landing's sky by day, two pixel clouds and the navy agent of the sky's sprites; at night, the night. */
  sky: {
    light: () => [
      grid(32, dayAt),
      shape(32, CLOUD_A, 3, 2, WHITE),
      shape(32, CLOUD_B, 26, 12, WHITE),
      ...agent({ ...AG, tones: NAVY_T }),
    ],
    dark: () => [grid(32, nightAt(false)), cells(32, STARS), ...agent({ ...AG, tones: SKY_T })],
    favicon: (N) =>
      N === 32
        ? [tile(32, 7, skyTile32), body(5, 6, 22, dith(5, 6, 22, 2, NAVY_T)), snapEyes(5, 6, 22)]
        : [tile(16, 3.5, "#8cc3ff"), body(2, 3, 12, SPRITE_NAVY), snapEyes(2, 3, 12, { style: "wide" })],
  },
  /** Espiando à noite: the agent big, coming up from the bottom edge and looking up, under the night's stars. */
  peekNight: {
    light: () => [grid(32, nightAt(false)), cells(32, STARS_TOP), ...agent({ ...PEEK, tones: SKY_T })],
    dark: () => [fill(BLACK_NIGHT), cells(32, STARS_TOP), ...agent({ ...PEEK, tones: SKY_T })],
    favicon: (N) =>
      N === 32
        ? [
            tile(32, 7, NAVY_TILE),
            clipped(32, 7, body(-2, 9, 36, dith(-2, 9, 36, 2, SKY_T))),
            snapEyes(-2, 9, 36, PEEK.pose),
          ]
        : [
            tile(16, 3.5, NAVY_TILE),
            clipped(16, 3.5, body(-1, 5, 18, bands(-1, 5, 18, SKY_T))),
            snapEyes(-1, 5, 18, PEEK.pose),
          ],
  },
  /** Espiando no céu: the same, in the day sky with clouds, the agent navy. */
  peekSky: {
    light: () => [
      grid(32, dayAt),
      shape(32, CLOUD_A, 3, 2, WHITE),
      shape(32, CLOUD_B, 22, 4, WHITE),
      ...agent({ ...PEEK, tones: NAVY_T }),
    ],
    dark: () => [grid(32, nightAt(false)), cells(32, STARS_TOP), ...agent({ ...PEEK, tones: SKY_T })],
    favicon: (N) =>
      N === 32
        ? [
            tile(32, 7, skyTile32),
            clipped(32, 7, body(-2, 9, 36, dith(-2, 9, 36, 2, NAVY_T))),
            snapEyes(-2, 9, 36, PEEK.pose),
          ]
        : [tile(16, 3.5, "#8cc3ff"), clipped(16, 3.5, body(-1, 5, 18, SPRITE_NAVY)), snapEyes(-1, 5, 18, PEEK.pose)],
  },
};

/* ---------- The same scene for each place ---------- */

/** Android's back layer: what is drawn behind the agent. */
export const backLayers = (layers) => layers.filter((l) => l.bg);
/** Android's front layer: the agent (and the moon), on nothing. */
export const frontLayers = (layers) => layers.filter((l) => !l.bg);
/** Android 13's one-color icon: the agent's shape (and the moon) with the eyes cut out. */
export const monoLayers = (layers) =>
  layers
    .filter((l) => l.part)
    .map((l) => (l.part === "eyes" ? { mask: l.mask, erase: true } : { mask: l.mask, color: () => WHITE }));

/** The scene cut to a rounded square (r in the scene's units): the browser's and Windows' icons. */
export const tiled = (layers, r = 225) =>
  layers.map((l) => ({ ...l, mask: (x, y) => inRound(x, y, 0, 0, 1024, 1024, r) && l.mask(x, y) }));

/** macOS's shape: a superellipse of 824 in the 1024 canvas (Apple's grid), with a soft shadow under it. */
const MAC = { at: 100, size: 824, n: 5 };
function squircleF(x, y, dy = 0) {
  const a = MAC.size / 2;
  const c = MAC.at + a;
  return (Math.abs((x - c) / a) ** MAC.n + Math.abs((y - c - dy) / a) ** MAC.n) ** (1 / MAC.n);
}
export function macLayers(layers) {
  const a = MAC.size / 2;
  const k = 1024 / MAC.size;
  const shadow = {
    mask: always,
    alpha: (x, y) => {
      const d = (squircleF(x, y, 10) - 1) * a;
      return d <= 0 ? 0.3 : 0.3 * Math.max(0, 1 - d / 26) ** 2;
    },
    color: () => "#000000",
  };
  const inside = (x, y) => squircleF(x, y) <= 1;
  const toScene = (f) => (x, y) => f((x - MAC.at) * k, (y - MAC.at) * k);
  return [
    shadow,
    ...layers.map((l) => ({
      ...l,
      mask: (x, y) => inside(x, y) && toScene(l.mask)(x, y),
      color: toScene(l.color),
      ...(l.alpha ? { alpha: toScene(l.alpha) } : {}),
    })),
  ];
}
