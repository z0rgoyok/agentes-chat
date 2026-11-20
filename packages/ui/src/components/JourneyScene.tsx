import { type CSSProperties, useEffect, useRef, useState } from "react";
import { HOSTING_CAST } from "../sky/team";
import { Avatar } from "./Avatar";

/**
 * A move drawn as a crossing (ADR 0055, addendum 2026-11-16): the team leaves a desert (where it was) for a green
 * land (here). `wait`: at the start, in the sand. `go`: walking across, over and over while the scene shows.
 * `here`: arrived, happy. Pixels on a small canvas, dithered between the two skies; the agents are the engine's
 * own, standing on the ground line. With reduced motion `go` rests on the far side. Decorative: the words under it
 * say the same. `at` (0 to 1, with `go`): how far along steps the person takes one at a time; the team walks there
 * from where it stood and waits (with reduced motion it is just there).
 */
export type Journey = "wait" | "go" | "here";

/** The land in cells; each cell is `CELL` CSS pixels tall, and as wide as the scene makes it. */
const W = 110;
const H = 37;
const CELL = 4;
/** The crossing, in seconds: a beat, the walk, a beat on the far side, then again. */
const LOOP = 9;
/** A step's walk with `at`, in seconds. */
const STEP_FOR = 1.4;
const WALK_FROM = 1;
const WALK_FOR = 4.6;
/**
 * Where the first agent starts and how far the team walks, in cells; the agents stand `GAP` apart. The team starts
 * past the laptop left in the sand, so no agent stands on it.
 */
const START = 10;
const GAP = 11;
const REACH = 46;

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bay = (x: number, y: number) => BAYER[((y & 3) << 2) | (x & 3)] as number;
const hash = (x: number, y: number) => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
};
/** `#rrggbb` as the little-endian RGBA an ImageData's Uint32 view takes. */
const rgba = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return ((255 << 24) | ((n & 255) << 16) | (((n >> 8) & 255) << 8) | (n >> 16)) >>> 0;
};
const tones = (list: string[]) => list.map(rgba);
const smooth = (from: number, to: number, x: number) => {
  const k = Math.max(0, Math.min(1, (x - from) / (to - from)));
  return k * k * (3 - 2 * k);
};
const pick = (list: number[], v: number, x: number, y: number) => {
  const k = Math.max(0, Math.min(1, v)) * (list.length - 1);
  const lo = Math.floor(k);
  return list[Math.min(list.length - 1, k - lo > bay(x, y) ? lo + 1 : lo)] as number;
};

const DESERT_SKY = tones(["#c9703f", "#d9824a", "#e7955a", "#f0aa6a", "#f6c07e", "#f9d496", "#fbe3b0"]);
const HOME_SKY = tones(["#2468dc", "#2b74e6", "#3f88f5", "#5a9dff", "#78b4ff", "#a6cfff", "#cfe6ff"]);
const SAND = tones(["#f4d595", "#e7bb73", "#d9a35c", "#c48946"]);
const GRASS = tones(["#9be38a", "#66c463", "#46a352", "#337f40"]);
const SUN = rgba("#fff3cc");
const SUN_RING = rgba("#ffe08f");
const CACTUS = rgba("#4f8a3a");
const CACTUS_DARK = rgba("#3a6d2b");
const PC = rgba("#5b5f6b");
const PC_SCREEN = rgba("#2a2d36");
const PC_BASE = rgba("#7d8290");
const PUFF = rgba("#ffffff");
const PUFF_DARK = rgba("#dcebff");
const TRUNK = rgba("#7a4b2a");
const LEAF = rgba("#2f8a49");
const LEAF_LIGHT = rgba("#5fbf5f");
const FLOWERS = [rgba("#ffd1e8"), rgba("#fff3a0"), rgba("#ffffff")];
const HEAT = rgba("#fde7b8");
const PUFFS: [number, number, number][] = [
  [0, 0, 3.2],
  [4.2, 0.6, 2.4],
  [-4, 0.8, 2.2],
  [1.6, -1.8, 2.4],
  [7.4, 1.4, 1.5],
  [-6.8, 1.5, 1.4],
];

type Buf = Uint32Array;
const dot = (buf: Buf, x: number, y: number, c: number) => {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px >= 0 && px < W && py >= 0 && py < H) buf[py * W + px] = c;
};
function disc(buf: Buf, cx: number, cy: number, r: number, c: number) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) dot(buf, x, y, c);
  }
}
function cloud(buf: Buf, ax: number, ay: number, k: number) {
  for (const [px, py, r] of PUFFS) disc(buf, ax + px * k, ay + py * k, r * k, PUFF);
  for (let x = Math.floor(ax - 8 * k); x <= ax + 9 * k; x++) {
    for (let y = Math.floor(ay + 0.9 * k); y <= ay + 2.6 * k; y++) {
      const i = Math.round(y) * W + Math.round(x);
      if (i >= 0 && i < buf.length && buf[i] === PUFF && bay(x, y) < 0.5) buf[i] = PUFF_DARK;
    }
  }
}
function sun(buf: Buf, cx: number, cy: number, t: number) {
  disc(buf, cx, cy, 5.2, SUN_RING);
  disc(buf, cx, cy, 3.8, SUN);
  for (let a = 0; a < 8; a++) {
    const r = 7 + (Math.sin(t * 3 + a) > 0 ? 1 : 0);
    dot(buf, cx + Math.cos((a * Math.PI) / 4) * r, cy + Math.sin((a * Math.PI) / 4) * r, SUN_RING);
  }
}
function cactus(buf: Buf, x: number, gy: number) {
  for (let y = gy - 6; y < gy; y++) {
    dot(buf, x, y, CACTUS);
    dot(buf, x + 1, y, CACTUS_DARK);
  }
  dot(buf, x - 1, gy - 4, CACTUS);
  dot(buf, x - 2, gy - 4, CACTUS);
  dot(buf, x - 2, gy - 5, CACTUS);
  dot(buf, x + 2, gy - 3, CACTUS_DARK);
  dot(buf, x + 3, gy - 3, CACTUS_DARK);
  dot(buf, x + 3, gy - 4, CACTUS_DARK);
}
/** A laptop half buried in the sand: what was left behind. */
function laptop(buf: Buf, x: number, gy: number) {
  for (let y = gy - 5; y < gy - 1; y++) {
    for (let i = 0; i < 6; i++) {
      dot(buf, x + i + (y - gy + 5) * 0.4, y, i === 0 || i === 5 || y === gy - 5 ? PC : PC_SCREEN);
    }
  }
  for (let i = -1; i < 7; i++) dot(buf, x + i + 1.6, gy - 1, PC_BASE);
}
function tree(buf: Buf, x: number, gy: number) {
  for (let y = gy - 3; y < gy; y++) dot(buf, x, y, TRUNK);
  disc(buf, x, gy - 5, 2.6, LEAF);
  disc(buf, x - 0.6, gy - 5.8, 1.4, LEAF_LIGHT);
}
/** The ground line at a column: dunes on the left, a gentler hill on the right. */
const groundAt = (x: number) => {
  const g = smooth(38, 66, x);
  return (
    (27 + 2.2 * Math.sin(x * 0.16) + 1.2 * Math.sin(x * 0.41 + 1)) * (1 - g) +
    (25.5 + 1.8 * Math.sin(x * 0.11 + 2) + 0.8 * Math.sin(x * 0.29)) * g
  );
};

function drawLand(buf: Buf, t: number) {
  for (let x = 0; x < W; x++) {
    const g = smooth(38, 66, x);
    for (let y = 0; y < H; y++) {
      const v = y / (H * 0.78);
      buf[y * W + x] =
        bay(x, y) < g ? pick(HOME_SKY, v, x, y) : pick(DESERT_SKY, v + 0.03 * Math.sin(x * 0.4 + t * 2), x, y);
    }
  }
  sun(buf, 14, 9, t);
  cloud(buf, 82, 8, 0.9);
  cloud(buf, 101, 15, 0.6);
  for (let x = 0; x < W; x++) {
    const g = smooth(38, 66, x);
    const gy = groundAt(x);
    for (let y = Math.max(0, Math.floor(gy)); y < H; y++) {
      const d = y - gy;
      const green = bay(x, y) < g;
      let c = green
        ? d < 1
          ? (GRASS[0] as number)
          : pick(GRASS.slice(1), d / 10, x, y)
        : d < 1
          ? (SAND[0] as number)
          : (y + Math.floor(x / 5)) % 6 === 0
            ? (SAND[3] as number)
            : pick(SAND.slice(1, 3), d / 9, x, y);
      if (green && d >= 1 && d < 2 && hash(x, 3) < 0.18) c = FLOWERS[Math.floor(hash(x, 7) * 3)] as number;
      dot(buf, x, y, c);
    }
  }
  // At the edge, out from under the team; the cactus past the last agent, where it isn't hidden.
  laptop(buf, 1, Math.round(groundAt(4)) + 1);
  cactus(buf, 44, Math.round(groundAt(44)));
  tree(buf, 95, Math.round(groundAt(95)));
  for (let i = 0; i < 5; i++) {
    if (Math.sin(t * 4 + i) > 0.7) dot(buf, 18 + i * 4, groundAt(18 + i * 4) - 3 - (i % 2), HEAT);
  }
}

type Phase = "start" | "walking" | "arrived";

export function JourneyScene({ journey, at }: { journey: Journey; at?: number }) {
  const host = useRef<HTMLDivElement>(null);
  // Where the team stands now, so the next step's walk starts there.
  const stood = useRef(journey === "wait" ? 0 : 1);
  const target = journey === "go" && at !== undefined ? Math.max(0, Math.min(1, at)) : null;
  const canvas = useRef<HTMLCanvasElement>(null);
  const walkers = useRef<(HTMLSpanElement | null)[]>([]);
  // The agents' faces follow the walk: eyes closed in the sand, open on the way, happy on arrival.
  const [phase, setPhase] = useState<Phase>(journey === "wait" ? "start" : "arrived");
  const [hop, setHop] = useState(false);

  useEffect(() => {
    const el = host.current;
    const ctx = canvas.current?.getContext("2d");
    if (!el || !ctx) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const image = ctx.createImageData(W, H);
    const buf = new Uint32Array(image.data.buffer);
    let raf = 0;
    let visible = true;
    let t0 = performance.now();
    let last: Phase | null = null;
    let hopping = false;
    const begun = t0;
    const from = stood.current;
    const frame = (now: number) => {
      let t = (now - t0) / 1000;
      if (t > LOOP) {
        t0 = now;
        t = 0;
      }
      drawLand(buf, reduced ? 0 : t);
      ctx.putImageData(image, 0, 0);
      let k = journey === "wait" ? 0 : 1;
      let walking = false;
      if (target !== null) {
        const w = reduced ? 1 : Math.min(1, (now - begun) / 1000 / STEP_FOR);
        k = from + (target - from) * w * w * (3 - 2 * w);
        walking = w < 1 && from !== target;
        stood.current = k;
      } else if (journey === "go" && !reduced) {
        const w = Math.max(0, Math.min(1, (t - WALK_FROM) / WALK_FOR));
        k = w * w * (3 - 2 * w);
        walking = k > 0 && k < 1;
      }
      const cell = el.clientWidth / W;
      walkers.current.forEach((w, i) => {
        if (!w) return;
        const x = START + i * GAP + k * REACH;
        const bob = walking ? -Math.abs(Math.sin(t * 9 + i)) * 4 : 0;
        const feet = groundAt(Math.round(x + w.offsetWidth / cell / 2)) * CELL;
        w.style.transform = `translate(${x * cell}px, ${feet - w.offsetHeight + 2 + bob}px)`;
      });
      // On the way through steps, the team is awake from the first one.
      const next: Phase = target !== null ? "walking" : k < 0.45 ? "start" : k < 1 ? "walking" : "arrived";
      if (next !== last) {
        last = next;
        setPhase(next);
      }
      const hops = target === null && journey === "go" && !reduced && k >= 1 && t < WALK_FROM + WALK_FOR + 2;
      if (hops !== hopping) {
        hopping = hops;
        setHop(hops);
      }
      if (visible && !reduced && journey !== "here") raf = requestAnimationFrame(frame);
    };
    const watch = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      cancelAnimationFrame(raf);
      if (visible) raf = requestAnimationFrame(frame);
    });
    watch.observe(el);
    // The scene's width sets where the agents stand: drawn again when it changes.
    const sized = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    });
    sized.observe(el);
    frame(t0);
    return () => {
      cancelAnimationFrame(raf);
      watch.disconnect();
      sized.disconnect();
    };
  }, [journey, target]);

  return (
    <div ref={host} className="ac-journey" data-journey={journey} aria-hidden="true">
      <canvas ref={canvas} className="ac-journey__land" width={W} height={H} />
      {HOSTING_CAST.map((a, i) => (
        <span
          key={a.name}
          ref={(el) => {
            walkers.current[i] = el;
          }}
          className="ac-journey__walker"
          data-hop={hop ? "" : undefined}
          style={{ "--i": i } as CSSProperties}
        >
          <Avatar
            kind="agent"
            name={a.name}
            appearance={a.look}
            size="lg"
            framed={false}
            state="idle"
            expression={phase === "arrived" ? "happy" : phase === "start" ? "closed" : undefined}
          />
        </span>
      ))}
    </div>
  );
}
