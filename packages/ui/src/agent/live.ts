/**
 * Living agents: one shared loop draws every agent avatar on screen from the
 * agent engine (engine.js). Only what says something moves: an agent at work
 * or waiting on someone, a face playing or the gaze, about 24 times a second,
 * and an agent under the pointer, about 12 (every blink still shows; a slow
 * turn reads the same). An agent at rest or asleep stands still, drawn once
 * as with reduced motion: its blinks and turns cost a frame each for every
 * avatar on screen, with nothing to say. With nobody looking (`sight`, ADR
 * 0228) none moves, after a while with no input only one at work does, and
 * with nothing moving the loop stops. A page can set a gaze point
 * (the landing's pointer): avatars inside an element marked `data-gaze` turn
 * their heads toward it.
 */
import { onSight, type Sight, sight } from "../sight";
import { avatarSky } from "../sky/avatar";
import { PAINT_ATTRS } from "../theme";
import {
  ACCESSORY_REACH,
  bodyTones,
  type DrawAgentOptions,
  drawAccessory,
  drawAgent,
  drawSleep,
  EYE_COLOR,
  idlePose,
  type Pose,
  sleepPose,
} from "./engine.js";

export interface LiveAgent {
  canvas: HTMLCanvasElement;
  /** The avatar's box (the body), for size and gaze. */
  box: HTMLElement;
  /** Read each frame: what to draw. */
  look: () => {
    color?: DrawAgentOptions["color"];
    eyes?: DrawAgentOptions["eyes"];
    accessory?: string;
    state: "idle" | "thinking" | "writing" | "waiting" | "sleeping";
    expression?: Pose["expression"];
    seed: number;
    /** Plays the transient face started by `playAgentReaction` with this key (e.g. a message id). */
    reactionKey?: string;
    /** Stands in its tile: its own pixel sky fills the box and the agent stands inside it. */
    framed?: boolean;
  };
}

/** A person's 👍 (`up`) or 👎 (`down`) on what this agent wrote. */
export type AgentReaction = "up" | "down";
/** How long the face lasts before the agent goes back to idle. */
export const REACTION_SECONDS = 1.6;
const reactions = new Map<string, { kind: AgentReaction; t0: number }>();
const clock = () => (typeof performance === "object" ? performance.now() : Date.now());

/**
 * The face for a reaction `e` seconds in: 👍 is
 * happy, then hearts, with a small hop at the start; 👎 is surprised, then a
 * thoughtful look up and aside. With reduced motion only the expression
 * changes (no hop, no turn). `hop` is a fraction of the body's size.
 */
export function reactionPose(kind: AgentReaction, e: number, still: boolean): { pose: Pose; hop: number } {
  if (kind === "up") {
    const expression = e < 0.65 ? "happy" : "heart";
    if (still) return { pose: { expression, blink: false, turn: [0, 0], squash: 0 }, hop: 0 };
    return {
      pose: {
        expression,
        blink: false,
        turn: [0, -0.2],
        squash: Math.sin(e * 13) * 0.8 * Math.max(0, 1 - e / 1.2),
      },
      hop: e < 0.6 ? Math.abs(Math.sin((e * Math.PI) / 0.3)) * 0.07 : 0,
    };
  }
  if (e < 0.55)
    return {
      pose: { expression: "surprised", blink: false, turn: still ? [0, 0] : [0, -0.1], squash: still ? 0 : -0.6 },
      hop: 0,
    };
  return {
    pose: { expression: undefined, blink: false, look: [-0.28, -0.32], turn: still ? [0, 0] : [-0.4, -0.3], squash: 0 },
    hop: 0,
  };
}

/** The reaction playing for `key` and how far in it is (seconds), or null. */
export function agentReactionOf(key: string | undefined): { kind: AgentReaction; elapsed: number } | null {
  if (!key) return null;
  const r = reactions.get(key);
  if (!r) return null;
  const elapsed = (clock() - r.t0) / 1000;
  if (elapsed > REACTION_SECONDS) {
    reactions.delete(key);
    return null;
  }
  return { kind: r.kind, elapsed };
}

/**
 * Every avatar drawn with `reactionKey === key` makes the reaction's face for
 * ~1.6 s, then goes back to idle. With reduced motion the loop stands still,
 * so the faces are drawn at each change.
 */
export function playAgentReaction(key: string, kind: AgentReaction) {
  reactions.set(key, { kind, t0: clock() });
  const redraw = () => {
    for (const a of agents) if (a.look().reactionKey === key) drawLive(a, clock() / 1000);
  };
  redraw();
  if (reduced()) {
    for (const ms of [600, 700, (REACTION_SECONDS + 0.05) * 1000]) setTimeout(redraw, ms);
  } else wakeLiveAgents();
}

const agents = new Set<LiveAgent>();
const visible = new WeakSet<HTMLElement>();
/** Boxes under the pointer: their agent moves, whatever it is doing. */
const hovered = new WeakSet<HTMLElement>();
/** Moving on the last frame drawn: one that stops gets its still frame, once. */
const moving = new Set<LiveAgent>();
let raf = 0;
/** An agent on screen moved on the last frame drawn: the loop asks for the next one. */
let wanted = false;
let last = 0;
let lastRest = 0;
let gaze: { x: number; y: number } | null = null;
let observer: IntersectionObserver | null = null;
/** Frame gaps (ms): an agent at work, and one at rest. */
const ACTIVE_MS = 40;
const REST_MS = 80;

// Read every frame for every avatar: kept here instead of asking the page (a layout read, a media query).
const sizes = new WeakMap<HTMLElement, number>();
let resizes: ResizeObserver | null = null;
let darkCache = new WeakMap<Element, boolean>();
let motionQuery: MediaQueryList | null | undefined;
const reduced = () => {
  if (motionQuery === undefined) {
    motionQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    // Motion allowed again: the loop starts moving.
    motionQuery?.addEventListener?.("change", () => {
      if (!motionQuery?.matches) wakeLiveAgents();
    });
  }
  return motionQuery?.matches === true;
};

// From the ResizeObserver, which reads it while the layout is fresh. Read here, right after another avatar's canvas
// changed size, it would lay the whole page out again for each avatar: a conversation opens with a hundred of them.
const sizeOf = (box: HTMLElement) => sizes.get(box) ?? (typeof ResizeObserver === "function" ? 0 : box.clientWidth);

/** How many agents the loop is drawing (tests). */
export function liveAgentCount() {
  return agents.size;
}

/** The current gaze point (client coordinates), if a page set one. */
export function getGaze() {
  return gaze;
}

/** Where avatars inside `[data-gaze]` look (client coordinates), or null to let them wander. */
export function setGaze(point: { x: number; y: number } | null) {
  gaze = point;
  if (point) wakeLiveAgents();
}

/**
 * In the app expressions are rare (one every ~18 s per agent); thinking speeds the head up. `still`: the one pose an
 * agent holds while it doesn't move (reduced motion's).
 */
function poseFor(a: ReturnType<LiveAgent["look"]>, t: number, box: HTMLElement, gazing: boolean, still: boolean): Pose {
  if (a.state === "sleeping") return sleepPose(still ? undefined : t, a.seed);
  if (a.state === "writing") return { writing: true, turn: [Math.sin(t * 1.3 + a.seed) * 0.15, 0.1] };
  // Waiting on you: looking up out of its card, blinking, now and then a glance aside.
  if (a.state === "waiting") {
    const pose: Pose = idlePose(t, a.seed, { every: 99, expressions: [] });
    const g = Math.sin(t * 0.35 + a.seed * 2);
    pose.expression = undefined;
    pose.turn = [g > 0.85 ? 0.45 : g < -0.9 ? -0.4 : 0.05, -0.32];
    pose.look = [0, -0.12];
    return pose;
  }
  const pose: Pose = idlePose(t, a.seed, { active: a.state === "thinking", every: 18 });
  if (a.state === "thinking") pose.expression = undefined;
  if (a.expression) pose.expression = a.expression;
  if (gazing && gaze && a.state !== "thinking") {
    const r = box.getBoundingClientRect();
    const k = (v: number) => Math.max(-1, Math.min(1, v));
    pose.turn = [k((gaze.x - (r.left + r.width / 2)) / 380), k((gaze.y - (r.top + r.height / 2)) / 300)];
  }
  return pose;
}

const isDark = (el: Element) => {
  let dark = darkCache.get(el);
  if (dark === undefined) {
    dark = el.closest("[data-theme]")?.getAttribute("data-theme") === "dark";
    darkCache.set(el, dark);
  }
  return dark;
};

/**
 * Draws one agent now: at `t` if it moves (`agentMotion`), else in its still pose. Framed: the canvas is the tile (the
 * agent's sky, then the agent standing in it). Unframed: the canvas is a bit larger than the box, with room for
 * accessories.
 */
export function drawLive(agent: LiveAgent, t: number) {
  const { canvas, box } = agent;
  const size = sizeOf(box);
  if (!size) return;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    return;
  }
  if (!ctx) return;
  const still = motionOf(agent) === "still";
  const dpr = Math.min(2, typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
  if (agent.look().framed) {
    drawFramed(agent, ctx, size, dpr, t, still);
    return;
  }
  const R = ACCESSORY_REACH;
  const w = Math.round(size * (1 + R.left + R.right) * dpr);
  const h = Math.round(size * (1 + R.top + R.bottom) * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.clearRect(0, 0, w, h);
  const look = agent.look();
  const s = size * dpr;
  const { pose, hop: lift } = livePose(agent, t, still);
  const hop = lift * s;
  drawAgent(ctx, R.left * s, R.top * s - hop, s, {
    color: look.color,
    eyes: look.eyes,
    pose,
    cells: size <= 28 ? 8 : 16,
    after: decorate(agent, t, still),
  });
}

/** The pose for this frame, with a playing reaction's face and hop (a fraction of the body). */
function livePose(agent: LiveAgent, t: number, still: boolean): { pose: Pose; hop: number } {
  const look = agent.look();
  const gazing = !!gaze && !!agent.box.closest("[data-gaze]");
  const pose = poseFor(look, still ? 0 : t, agent.box, gazing, still);
  const playing = agentReactionOf(look.reactionKey);
  if (!playing) return { pose, hop: 0 };
  const face = reactionPose(playing.kind, playing.elapsed, still);
  return { pose: { ...pose, ...face.pose }, hop: face.hop };
}

/**
 * The tile: the agent's pixel sky fills the
 * canvas; the agent stands centered, feet near the bottom edge, smaller with
 * an accessory so it has room above (at every size: the agent is always itself).
 */
function drawFramed(
  agent: LiveAgent,
  ctx: CanvasRenderingContext2D,
  size: number,
  dpr: number,
  t: number,
  still: boolean,
) {
  const { canvas, box } = agent;
  const s = Math.round(size * dpr);
  if (canvas.width !== s || canvas.height !== s) {
    canvas.width = s;
    canvas.height = s;
  }
  ctx.clearRect(0, 0, s, s);
  const look = agent.look();
  const sky = avatarSky(look.color, s, isDark(box));
  if (sky) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sky, 0, 0, s, s);
  }
  const inner = s * (look.accessory ? 0.6 : 0.66);
  const x = (s - inner) / 2;
  const y = s - inner - s * (look.accessory ? 0.1 : 0.14);
  const { pose, hop } = livePose(agent, t, still);
  drawAgent(ctx, x, y - hop * inner, inner, {
    color: look.color,
    eyes: look.eyes,
    pose,
    cells: size <= 32 ? 12 : undefined,
    after: decorate(agent, t, still),
  });
}

/** What sits on the body: its accessory, then a sleeping agent's zz (the body's darkest tone on a light page). */
function decorate(agent: LiveAgent, t: number, still: boolean): DrawAgentOptions["after"] {
  const look = agent.look();
  const accessory = look.accessory;
  const sleeping = look.state === "sleeping";
  if (!accessory && !sleeping) return undefined;
  const ink = sleeping ? (isDark(agent.box) ? EYE_COLOR : (bodyTones(look.color)[0] ?? EYE_COLOR)) : "";
  return (g, side, frame) => {
    if (accessory) drawAccessory(g, side, accessory, frame, still ? 0 : t, look.state === "thinking");
    if (sleeping) drawSleep(g, side, frame, ink, still ? undefined : t);
  };
}

/** Redraws every agent at once (a new theme changes their skies; the loop may be standing still). */
function redrawAll() {
  darkCache = new WeakMap();
  const t = clock() / 1000;
  for (const a of agents) drawLive(a, t);
}

let themeWatch: MutationObserver | null = null;
function watchTheme() {
  if (themeWatch || typeof MutationObserver === "undefined" || typeof document === "undefined") return;
  themeWatch = new MutationObserver(redrawAll);
  // Subtree: a page can theme its own part (the landing's `data-theme`).
  themeWatch.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: PAINT_ATTRS });
}

/** How an agent moves in a frame: at the full rate, at rest's, or not at all. */
export type AgentMotion = "full" | "rest" | "still";

/**
 * How an agent moves now. Busy (at work, waiting on someone, making a face, following the gaze): the full rate; at
 * rest or asleep under the pointer: rest's rate; else still. With no input for a while (`idle`) only an agent at work
 * moves: one waiting on someone who isn't there would move for hours. Never with reduced motion, nor with nobody
 * looking.
 */
export function agentMotion(
  state: ReturnType<LiveAgent["look"]>["state"],
  on: { sight: Sight; reduced: boolean; reacting: boolean; gazing: boolean; hovered: boolean },
): AgentMotion {
  if (on.reduced) return "still";
  if (on.sight === "idle") return state === "thinking" || state === "writing" ? "full" : "still";
  if (on.sight !== "present") return "still";
  if ((state !== "idle" && state !== "sleeping") || on.reacting || on.gazing) return "full";
  return on.hovered ? "rest" : "still";
}

const motionOf = (a: LiveAgent): AgentMotion => {
  const look = a.look();
  return agentMotion(look.state, {
    sight: sight(),
    reduced: reduced(),
    reacting: Boolean(look.reactionKey && reactions.has(look.reactionKey)),
    gazing: Boolean(gaze && a.box.closest("[data-gaze]")),
    hovered: hovered.has(a.box),
  });
};

function tick(now: number) {
  raf = 0;
  if (now - last >= ACTIVE_MS) {
    last = now;
    wanted = false;
    const rest = now - lastRest >= REST_MS;
    if (rest) lastRest = now;
    const t = now / 1000;
    // A full-screen menu is open (MenuOverlay): the app behind is blurred, so its avatars hold still
    // (each frame there would blur the whole screen again); the ones in the menu keep moving.
    const covered = typeof document !== "undefined" && document.documentElement.dataset.menuOverlay !== undefined;
    for (const a of agents) {
      if (!visible.has(a.box)) continue;
      const motion = motionOf(a);
      if (motion === "still") {
        // It just stopped (back at rest, the pointer gone, nobody looking): its still frame.
        if (moving.delete(a)) drawLive(a, t);
        continue;
      }
      moving.add(a);
      wanted = true;
      if (covered && !a.box.closest(".ac-mo")) continue;
      if (rest || motion === "full") drawLive(a, t);
    }
  }
  if (wanted) raf = requestAnimationFrame(tick);
}

/**
 * Starts the loop if it stands still: something may move now (an agent's state changed, the pointer came over one,
 * someone looks again). The first frame finds out; with nothing moving the loop stops again.
 */
export function wakeLiveAgents() {
  if (raf || !agents.size || typeof requestAnimationFrame !== "function") return;
  wanted = true;
  raf = requestAnimationFrame(tick);
}

let followsSight = false;

/** Starts drawing an agent; returns the cleanup. */
export function addLiveAgent(agent: LiveAgent): () => void {
  agents.add(agent);
  watchTheme();
  // Seen again: the loop starts (busy agents move); unseen, the next frame stills them and the loop stops.
  if (!followsSight) {
    followsSight = true;
    onSight(wakeLiveAgents);
  }
  if (typeof IntersectionObserver === "function") {
    observer ??= new IntersectionObserver((entries) => {
      let shown = false;
      for (const e of entries) {
        if (e.isIntersecting) {
          visible.add(e.target as HTMLElement);
          shown = true;
        } else visible.delete(e.target as HTMLElement);
      }
      if (shown) wakeLiveAgents();
    });
    observer.observe(agent.box);
  } else visible.add(agent.box);
  const enter = () => {
    hovered.add(agent.box);
    wakeLiveAgents();
  };
  const leave = () => hovered.delete(agent.box);
  agent.box.addEventListener("pointerenter", enter);
  agent.box.addEventListener("pointerleave", leave);
  if (typeof ResizeObserver === "function") {
    resizes ??= new ResizeObserver((entries) => {
      const t = clock() / 1000;
      // Every size first, while the layout is fresh, then the drawing: a canvas that changes size makes it stale.
      const boxes = entries.map((e) => e.target as HTMLElement);
      for (const box of boxes) sizes.set(box, box.clientWidth);
      for (const box of boxes) for (const a of agents) if (a.box === box) drawLive(a, t);
    });
    resizes.observe(agent.box);
  }
  drawLive(agent, typeof performance === "object" ? performance.now() / 1000 : 0);
  wakeLiveAgents();
  return () => {
    agents.delete(agent);
    moving.delete(agent);
    observer?.unobserve(agent.box);
    resizes?.unobserve(agent.box);
    agent.box.removeEventListener("pointerenter", enter);
    agent.box.removeEventListener("pointerleave", leave);
    sizes.delete(agent.box);
    visible.delete(agent.box);
    hovered.delete(agent.box);
  };
}
