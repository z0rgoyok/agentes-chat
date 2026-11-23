/*
 * The camera over a canvas on the phone (ADR 0196 §2): `x`, `y` the world point at the plane's top left, `s` points
 * per world unit, so a world point `p` is on screen at `(p - (x, y)) * s`, as the agents' screens and the spreadsheet's
 * grid count it (and as `LivePointer` reads a view). The plane is endless: only the zoom is bounded. Worklets, run on
 * the UI thread by the gestures, and plain functions in the tests.
 */

export interface Cam {
  x: number;
  y: number;
  s: number;
}

export interface Frame {
  width: number;
  height: number;
}

export interface WBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pt {
  x: number;
  y: number;
}

/** The farthest out and in a canvas zooms (the web's first and last step past which nothing reads). */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
/** Room kept around what a fit shows, in points. */
export const FIT_PAD = 40;

export const clampZoom = (s: number) => {
  "worklet";
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, s));
};

export const toWorld = (p: Pt, cam: Cam): Pt => {
  "worklet";
  return { x: cam.x + p.x / cam.s, y: cam.y + p.y / cam.s };
};

export const toScreen = (p: Pt, cam: Cam): Pt => {
  "worklet";
  return { x: (p.x - cam.x) * cam.s, y: (p.y - cam.y) * cam.s };
};

/** A world box on screen. */
export const boxOnScreen = (b: WBox, cam: Cam): WBox => {
  "worklet";
  return { x: (b.x - cam.x) * cam.s, y: (b.y - cam.y) * cam.s, w: b.w * cam.s, h: b.h * cam.s };
};

/** What the plane shows now, in world units. */
export const viewBox = (cam: Cam, frame: Frame): WBox => {
  "worklet";
  return { x: cam.x, y: cam.y, w: frame.width / cam.s, h: frame.height / cam.s };
};

/** The zoom changed to `next` (kept in range) with the world point under `focal` (points) staying under it. */
export const zoomAt = (cam: Cam, next: number, focal: Pt): Cam => {
  "worklet";
  const s = clampZoom(next);
  const wx = cam.x + focal.x / cam.s;
  const wy = cam.y + focal.y / cam.s;
  return { x: wx - focal.x / s, y: wy - focal.y / s, s };
};

/** The plane dragged by a finger (`dx`, `dy` in points): the world goes along with it. */
export const panBy = (cam: Cam, dx: number, dy: number): Cam => {
  "worklet";
  return { x: cam.x - dx / cam.s, y: cam.y - dy / cam.s, s: cam.s };
};

/** The camera that shows `box` whole in the middle of the plane, `pad` around it, never closer than `maxZoom`. */
export const fitCam = (box: WBox, frame: Frame, pad = FIT_PAD, maxZoom = 1): Cam => {
  "worklet";
  const roomW = Math.max(1, frame.width - 2 * pad);
  const roomH = Math.max(1, frame.height - 2 * pad);
  const s = clampZoom(Math.min(maxZoom, roomW / Math.max(box.w, 1), roomH / Math.max(box.h, 1)));
  return { x: box.x + box.w / 2 - frame.width / 2 / s, y: box.y + box.h / 2 - frame.height / 2 / s, s };
};

/** The camera centered on a world point at zoom `s`. */
export const centerOn = (p: Pt, frame: Frame, s: number): Cam => {
  "worklet";
  const z = clampZoom(s);
  return { x: p.x - frame.width / 2 / z, y: p.y - frame.height / 2 / z, s: z };
};

/** The world point in the middle of the plane. */
export const viewCenter = (cam: Cam, frame: Frame): Pt => {
  "worklet";
  return { x: cam.x + frame.width / 2 / cam.s, y: cam.y + frame.height / 2 / cam.s };
};

/**
 * What someone sees, as their presence says it (`PeerState.view`, the web's `PeerView`): the world box their plane
 * shows and their zoom.
 */
export interface PeerView {
  x: number;
  y: number;
  w: number;
  h: number;
  zoom: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** This phone's view, for its presence. */
export function peerViewOf(cam: Cam, frame: Frame): PeerView {
  const box = viewBox(cam, frame);
  const zoom = Math.round(cam.s * 1000) / 1000;
  return { x: round2(box.x), y: round2(box.y), w: round2(box.w), h: round2(box.h), zoom };
}

/** The camera that shows what someone else sees: their world box fitted into this plane. */
export const followCam = (view: PeerView, frame: Frame): Cam => {
  "worklet";
  if (!(view.w > 0 && view.h > 0)) return centerOn({ x: view.x, y: view.y }, frame, view.zoom > 0 ? view.zoom : 1);
  return fitCam({ x: view.x, y: view.y, w: view.w, h: view.h }, frame, 0, MAX_ZOOM);
};

/** `centerOn` without the zoom's bounds (a step between two bounded zooms is bounded already). */
const centerOnRaw = (p: Pt, frame: Frame, s: number): Cam => {
  "worklet";
  return { x: p.x - frame.width / 2 / s, y: p.y - frame.height / 2 / s, s };
};

/** A step of the way between two cameras (`t` 0..1): the zoom moves in its log, so it feels even. */
export const lerpCam = (a: Cam, b: Cam, t: number, frame: Frame): Cam => {
  "worklet";
  const s = Math.exp(Math.log(a.s) + (Math.log(b.s) - Math.log(a.s)) * t);
  // The world point in the middle of the plane goes straight from one to the other.
  const ca = viewCenter(a, frame);
  const cb = viewCenter(b, frame);
  return centerOnRaw({ x: ca.x + (cb.x - ca.x) * t, y: ca.y + (cb.y - ca.y) * t }, frame, s);
};

/** Whether two cameras show nearly the same. */
export const sameCam = (a: Cam, b: Cam) => {
  "worklet";
  return Math.abs(a.x - b.x) * a.s < 0.5 && Math.abs(a.y - b.y) * a.s < 0.5 && Math.abs(a.s - b.s) < 1e-4;
};

// ── The dotted plane ──────────────────────────────────────────────────────────────────────────────────────────────

/** World units between two dots. */
export const DOT_STEP = 24;

/** The dots' spacing on screen at this zoom, doubling while they would crowd (the web's `dotSpacing`). */
export const dotSpacing = (s: number) => {
  "worklet";
  let step = DOT_STEP * s;
  while (step < 12) step *= 2;
  return step;
};

/** Where the first dot is on screen, on each axis (0..spacing): dots sit on whole multiples of the world's step. */
export const dotOffset = (cam: Cam, spacing: number): Pt => {
  "worklet";
  const mod = (a: number, b: number) => a - b * Math.floor(a / b);
  return { x: mod(-cam.x * cam.s, spacing), y: mod(-cam.y * cam.s, spacing) };
};

/** How strong the dots are: whole at 40% and closer, fading out to a quarter as the plane zooms far out. */
export const dotAlpha = (s: number) => {
  "worklet";
  return s >= 0.4 ? 1 : Math.max(0.25, s / 0.4);
};

// ── What is laid out ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The world box the screen lays shapes out for: what it shows and one more screen's width and height around it, so a
 * pan finds them already there; laid out again whenever the view leaves it (`inside`).
 */
export const laidOutBox = (cam: Cam, frame: Frame, margin = 1): WBox => {
  "worklet";
  const v = viewBox(cam, frame);
  return { x: v.x - v.w * margin, y: v.y - v.h * margin, w: v.w * (1 + 2 * margin), h: v.h * (1 + 2 * margin) };
};

/** Whether `inner` is wholly inside `outer`. */
export const inside = (inner: WBox, outer: WBox) => {
  "worklet";
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
};

/** Whether two boxes overlap (touching counts). */
export const overlaps = (a: WBox, b: WBox) => {
  "worklet";
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
};

// ── Touch ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Points the selection's corner handle answers to around it. */
export const HANDLE_REACH = 28;

/** Whether a finger at `p` (points) is on the corner handle of `box` (world). */
export const onHandle = (p: Pt, box: WBox | null, cam: Cam, reach = HANDLE_REACH) => {
  "worklet";
  if (!box) return false;
  const r = boxOnScreen(box, cam);
  return Math.hypot(p.x - (r.x + r.w), p.y - (r.y + r.h)) <= reach;
};

/** Whether a finger at `p` (points) is inside any of the boxes (world), each grown to a finger's reach on screen. */
export const onAnyBox = (p: Pt, boxes: readonly WBox[], cam: Cam, reach = 8) => {
  "worklet";
  for (const b of boxes) {
    const r = boxOnScreen(b, cam);
    if (p.x >= r.x - reach && p.x <= r.x + r.w + reach && p.y >= r.y - reach && p.y <= r.y + r.h + reach) return true;
  }
  return false;
};

/** The smallest a shape gets from the handle, in points on screen (and never under 8 world units). */
export const MIN_SIDE = 24;

/**
 * A box stretched from its bottom-right corner by (`dx`, `dy`) world units: a picture keeps its proportions (by the
 * longer pull), anything else follows the finger; never smaller than `MIN_SIDE` points.
 */
export const stretchBox = (box: WBox, dx: number, dy: number, keepRatio: boolean, s: number): WBox => {
  "worklet";
  const min = Math.max(8, MIN_SIDE / Math.max(s, 1e-6));
  let w = Math.max(min, box.w + dx);
  let h = Math.max(min, box.h + dy);
  if (keepRatio && box.w > 0 && box.h > 0) {
    const ratio = box.w / box.h;
    if (Math.abs(dx) * box.h >= Math.abs(dy) * box.w) h = w / ratio;
    else w = h * ratio;
    if (w < min) {
      w = min;
      h = w / ratio;
    }
    if (h < min) {
      h = min;
      w = h * ratio;
    }
  }
  return { x: box.x, y: box.y, w, h };
};

// ── Arrows on the UI thread ───────────────────────────────────────────────────────────────────────────────────────

/** An arrow's end as the UI thread draws it: a shape's box (the arrow leaves from its border) or a free point. */
export interface ArrowEndW {
  x: number;
  y: number;
  w: number;
  h: number;
  box: boolean;
}

/** An arrow from border to border along the line between its ends' middles (`arrowPath` of `@agenteschat/live`). */
export const arrowLineW = (from: ArrowEndW, to: ArrowEndW) => {
  "worklet";
  const ca = from.box ? { x: from.x + from.w / 2, y: from.y + from.h / 2 } : { x: from.x, y: from.y };
  const cb = to.box ? { x: to.x + to.w / 2, y: to.y + to.h / 2 } : { x: to.x, y: to.y };
  const anchor = (end: ArrowEndW, c: Pt, toward: Pt): Pt => {
    if (!end.box) return { x: end.x, y: end.y };
    const dx = toward.x - c.x;
    const dy = toward.y - c.y;
    if (dx === 0 && dy === 0) return c;
    const tx = dx === 0 ? Number.POSITIVE_INFINITY : Math.abs(end.w / 2 / dx);
    const ty = dy === 0 ? Number.POSITIVE_INFINITY : Math.abs(end.h / 2 / dy);
    const t = Math.min(tx, ty, 1);
    return { x: c.x + dx * t, y: c.y + dy * t };
  };
  const a = anchor(from, ca, cb);
  const b = anchor(to, cb, ca);
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
};
