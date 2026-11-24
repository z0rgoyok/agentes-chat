import { ditherCells, idlePose, inBody, mixHex, type Pose, toneAt } from "@agenteschat/ui/agent/engine";
import { bayerAt } from "@agenteschat/ui/sky/math";

/**
 * The launch splash: pure pieces the screen and the tests share. No React
 * Native imports. Times in seconds.
 */
export const LAUNCH = {
  /** The shortest it plays before it may leave, once its rise is under way: the sky nearly up and the name in. */
  min: 0.6,
  /**
   * Ready this soon (its first frames: the session and the workspace kept from last time), it leaves at once, with no
   * minimum to sit through: its rise had barely begun.
   */
  quick: 0.15,
  /** The sky rising and the agent lifting with it. */
  rise: 0.85,
  /** Leaving with reduced motion: a short fade. */
  reducedExit: 0.25,
  /** When the name comes in, and how long it takes: in before the shortest launch leaves. */
  nameAt: 0.2,
  nameIn: 0.3,
  /** How long it waits before one line says why it is still here. */
  lineAfter: 2.5,
  /** How high the sky rises (share of the screen's height). */
  sky: 0.5,
  /** How far the agent lifts with it (points). */
  lift: 26,
  /** Waiting on something the person can act on (a server that doesn't answer): the agent's height, as a share of the screen. */
  waitingAgent: 0.3,
  /** And the sky's level then (its top just under the name). */
  waitingSky: 0.56,
} as const;

/** The native launch image (assets/images/splash-icon.png, 512 px with the body at 56–456) is 120 pt wide. */
export const NATIVE_IMAGE = 120;
/** So the agent's body there is this wide, centered on the screen: the splash starts exactly on it. */
export const LOGO = (NATIVE_IMAGE * 400) / 512;
/** The agent in the logo (the same as the app icon). */
export const LOGO_LOOK = { color: "sky", eyes: "round" } as const;

/**
 * Leaving into the app (motion on): the agent faces front, smiles and squashes (`gather`), then comes apart into its
 * own pixels while a ring of pixel sky goes out from it to past every corner (`wave`). Outside the ring the splash is
 * still there, inside it the app, already drawn under the splash, settling from a little larger. All on the UI
 * thread; times in seconds from the moment it leaves.
 */
export const EXIT = {
  gather: 0.08,
  /** How far the agent squashes as it gathers itself (the engine's `squash`). */
  squash: 2.2,
  wave: 0.5,
  /** The ring's band of pixel sky, in points. */
  band: 72,
  /** The app's scale as the ring starts opening it. */
  appFrom: 1.03,
  /** How long the agent's pixels take to go, from the moment the ring starts. */
  burst: 0.26,
} as const;

/** From leaving until the app alone shows. */
export const EXIT_TOTAL = EXIT.gather + EXIT.wave;

const clamp01 = (x: number) => {
  "worklet";
  return x < 0 ? 0 : x > 1 ? 1 : x;
};
const smooth01 = (x: number) => {
  "worklet";
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};
/** cubic-bezier(0.65, 0, 0.35, 1): the ring starts gently and arrives gently. */
const inOutCubic = (x: number) => {
  "worklet";
  const k = clamp01(x);
  return k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
};
/** cubic-bezier(0.22, 1, 0.36, 1): fast out, long settle. */
const outQuint = (x: number) => {
  "worklet";
  return 1 - (1 - clamp01(x)) ** 5;
};

/** How far the gather is (0 → 1, smoothed) `e` seconds after leaving. */
export function gatherOf(e: number): number {
  "worklet";
  return smooth01(e / EXIT.gather);
}

/**
 * The ring's outer edge (points from the agent's center) `e` seconds after leaving: from just outside the agent's
 * body to past the farthest corner of a `width` × `height` screen, the agent standing at `cy`. 0 while it gathers.
 */
export function ringRadius(e: number, cy: number, width: number, height: number): number {
  "worklet";
  const k = e - EXIT.gather;
  if (k < 0) return 0;
  const far = Math.hypot(width / 2, Math.max(cy, height - cy)) + EXIT.band + 12;
  const from = LOGO * 0.55;
  return from + (far - from) * inOutCubic(k / EXIT.wave);
}

/**
 * What a cell `d` points from the agent's center shows with the ring's edge at `r` (`b`: the cell's Bayer threshold),
 * as the shader decides (./ring.ts): "splash" (outside the ring, or the band's palest step), "app" (inside it, or
 * dithered through on the band's inner half), or the band's tone (1 to 3).
 */
export function ringCell(d: number, r: number, b: number): "splash" | "app" | 1 | 2 | 3 {
  if (d > r) return "splash";
  const k = (r - d) / EXIT.band;
  if (k >= 1 || (k > 0.5 && b < (k - 0.5) / 0.5)) return "app";
  const f = 3 * (1 - Math.abs(2 * k - 1));
  const base = Math.floor(f);
  const idx = Math.min(3, f - base > b ? base + 1 : base);
  return idx === 0 ? "splash" : (idx as 1 | 2 | 3);
}

/** The ring's tones: the screen's background, then its sky from soft to bright (dusk: the lilac one). */
export function ringTones(bg: string, dark: boolean, dusk = false): [string, string, string, string] {
  if (dusk)
    return dark
      ? [bg, mixHex(bg, "#4a40a8", 0.35), mixHex(bg, "#7b6fe0", 0.66), "#7b6fe0"]
      : [bg, mixHex(bg, "#c9c0ff", 0.55), "#c9c0ff", "#aaa6f5"];
  return dark
    ? [bg, mixHex(bg, "#2b74e6", 0.35), mixHex(bg, "#4b93ff", 0.66), "#4b93ff"]
    : [bg, mixHex(bg, "#a6cfff", 0.55), "#a6cfff", "#78b4ff"];
}

/** Where the name starts below the agent's center (its top), and how far it reaches past that. */
const NAME_NEAR = LOGO / 2 + 18;
const NAME_SPAN = 46;

/** The name (and what is under it) as the ring passes over it, ring edge at `r`: there, then gone under the band. */
export function nameUnderRing(r: number): number {
  "worklet";
  return 1 - smooth01((r - EXIT.band * 0.5 - NAME_NEAR) / NAME_SPAN);
}

/** What waits at the bottom (a server that doesn't answer) goes first, as the agent gathers itself. */
export function panelOut(e: number): number {
  "worklet";
  return 1 - smooth01(e / 0.12);
}

/** One of the agent's pixels as it comes apart: where it sits from the center, its tone, how far it drifts, when it goes. */
export interface BurstCell {
  dx: number;
  dy: number;
  tone: number;
  drift: number;
  gone: number;
}

/**
 * The logo agent's body cells (the engine's dither grid, facing front): each drifts out a little and goes out on its
 * own, from the middle first in the dither's order, between 0.02 and 0.26 s after the ring starts.
 */
export function burstCells(): BurstCell[] {
  const n = ditherCells(LOGO);
  const p = LOGO / n;
  const cells: BurstCell[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n;
      const v = (j + 0.5) / n;
      if (!inBody(u, v)) continue;
      const b = bayerAt(i, j);
      cells.push({
        dx: (i + 0.5) * p - LOGO / 2,
        dy: (j + 0.5) * p - LOGO / 2,
        tone: toneAt(i, j, n, [0, 0]),
        drift: 0.2 + 0.45 * ((((i * 73 + j * 151) % 97) + 0.5) / 97),
        gone: 0.02 + 0.14 * (1 - Math.hypot(u - 0.5, v - 0.5) / 0.71) + 0.1 * b,
      });
    }
  return cells;
}

/** How far out a cell has drifted (1 = where it sat) `k` seconds after the ring started; null once it has gone. */
export function burstDrift(cell: BurstCell, k: number): number | null {
  "worklet";
  if (k > cell.gone) return null;
  return 1 + cell.drift * outQuint(k / EXIT.burst);
}

/**
 * The agent's opening, drawn ahead (`OPENING_FPS` frames a second up to `OPENING_END`) and shown by the UI thread:
 * the app loads on the JS thread under it, and an agent drawn there stuttered.
 */
export const OPENING_FPS = 30;
/** Where its choreography ends (`launchPose`): past it the agent idles, drawn as it goes. */
export const OPENING_END = 0.9;
export const OPENING_FRAMES = Math.round(OPENING_END * OPENING_FPS) + 1;

/** The frame for `a` seconds into the opening, of the `count` drawn so far; -1 past the opening. */
export function openingFrame(a: number, count: number): number {
  "worklet";
  if (a >= OPENING_END) return -1;
  return Math.max(0, Math.min(count - 1, Math.floor(a * OPENING_FPS)));
}

/** The gather's frames: the pose it left in, turned to face front, smiling and squashing. */
export const GATHER_FRAMES = 4;
export function gatherPose(held: Pose, j: number): Pose {
  const g = smooth01((j + 1) / GATHER_FRAMES);
  const [tx, ty] = held.turn ?? [0, 0];
  return { turn: [tx * (1 - g), ty * (1 - g)], expression: "happy", squash: EXIT.squash * g };
}

/** The gather frame for `e` seconds after leaving. */
export function gatherFrame(e: number): number {
  "worklet";
  return Math.max(0, Math.min(GATHER_FRAMES - 1, Math.floor((e / EXIT.gather) * GATHER_FRAMES)));
}

/** Whether the app, ready `readyMs` after the splash came up, skips its minimum (`LAUNCH.quick`). */
export const launchesAtOnce = (readyMs: number) => readyMs <= LAUNCH.quick * 1000;

/** The line under the name while it waits: none at first, then why (no network, or just slow). */
export function waitLine(late: boolean, offline: boolean): "offline" | "slow" | null {
  if (!late) return null;
  return offline ? "offline" : "slow";
}

const ease = (x: number) => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};

/**
 * The logo agent `a` seconds in: it looks down at the sky coming up, back up, smiles, then idles. Without a
 * network, after a while, it closes its eyes; leaving, it smiles.
 */
export function launchPose(a: number, opts: { offline?: boolean; leaving?: boolean } = {}): Pose {
  let pose: Pose;
  if (a < 0.5) pose = { turn: [0, 0.75 * ease(a / 0.3)], blink: a > 0.08 && a < 0.16 };
  else if (a < 0.9) pose = { turn: [0, 0.75 - 0.95 * ease((a - 0.5) / 0.4)] };
  else {
    pose = { ...idlePose(a, 1.4, { every: 4.5, expressions: ["happy"] }), turn: [Math.sin(a * 0.9) * 0.35, -0.2] };
    if (a < 1.5) pose.expression = "happy";
  }
  if (opts.leaving) return { ...pose, expression: "happy", blink: false };
  if (opts.offline && a > LAUNCH.lineAfter) return { ...pose, expression: "closed" };
  return pose;
}

/** The little pixel agents going up through the sky: a column each, their own pace and start. */
export const SPRITES = [
  { x: 0.08, speed: 0.05, phase: 0.1, blink: 0.4 },
  { x: 0.25, speed: 0.072, phase: 0.55, blink: 2.1 },
  { x: 0.41, speed: 0.04, phase: 0.3, blink: 1.2 },
  { x: 0.58, speed: 0.065, phase: 0.8, blink: 3.0 },
  { x: 0.74, speed: 0.045, phase: 0.05, blink: 0.9 },
  { x: 0.9, speed: 0.06, phase: 0.62, blink: 2.6 },
] as const;

/**
 * Where a sprite is (share of the height from the top) with the sky at `level`: it rises from `bottom` (near the
 * screen's bottom, or above what the splash shows there) to a little under the sky's top and starts again; null
 * while the sky is too low to hold it.
 */
export function spriteY(sprite: (typeof SPRITES)[number], t: number, level: number, bottom = 0.95): number | null {
  "worklet";
  const travel = bottom - (1 - level) - 0.06;
  if (travel <= 0.04) return null;
  const k = t * sprite.speed + sprite.phase * travel;
  return bottom - (k - travel * Math.floor(k / travel));
}

/** A sprite blinks for a moment every 3.6 s. */
export function spriteBlinks(sprite: (typeof SPRITES)[number], t: number): boolean {
  "worklet";
  return (t + sprite.blink) % 3.6 < 0.12;
}

/** The sprites' body color (deep navy, white eyes: the sky's agents). */
export const SPRITE_BODY = "#04203f";

/**
 * The sky's tones, deep to light from the screen's background. `dusk`: the sky of a team's own server (lilac, as
 * the workspace's sky at dusk), so the splash that waits on that server says which one fell silent.
 */
export function launchSkyTones(bg: string, dark: boolean, dusk = false): string[] {
  if (dusk) {
    const [deep, light] = dark ? ["#4a40a8", "#7b6fe0"] : ["#c9c0ff", "#aaa6f5"];
    return dark
      ? [bg, mixHex(bg, deep, 0.14), mixHex(bg, deep, 0.3), mixHex(bg, deep, 0.48), mixHex(bg, light, 0.66)]
      : [bg, mixHex(bg, deep, 0.22), mixHex(bg, deep, 0.48), mixHex(bg, deep, 0.78), deep, light];
  }
  if (dark)
    return [
      bg,
      mixHex(bg, "#2b74e6", 0.14),
      mixHex(bg, "#2b74e6", 0.3),
      mixHex(bg, "#2b74e6", 0.48),
      mixHex(bg, "#4b93ff", 0.66),
    ];
  return [
    bg,
    mixHex(bg, "#a6cfff", 0.22),
    mixHex(bg, "#a6cfff", 0.48),
    mixHex(bg, "#a6cfff", 0.78),
    "#a6cfff",
    "#78b4ff",
  ];
}
