import { ZOOM_STEPS } from "@agenteschat/client/lib/zoom";
import type { Box, Point } from "@agenteschat/live/canvas";

/**
 * Where a canvas is looked at from (ADR 0196 §2): the world (shapes in world units) drawn at `z` screen pixels per
 * world unit, its origin at (`x`, `y`) in the plane's own pixels. A world point `p` is on screen at `p * z + (x, y)`.
 * The plane is endless: unlike a picture's zoom (`lib/zoom.ts`), nothing keeps the view inside bounds, only the zoom
 * between `CAMERA_MIN` and `CAMERA_MAX`; − and + stop at the same steps as the picture viewer's.
 */
export interface Camera {
  x: number;
  y: number;
  z: number;
}

export interface Size {
  w: number;
  h: number;
}

/** The farthest out and in a canvas zooms (the picture viewer's first and last step). */
export const CAMERA_MIN = ZOOM_STEPS[0] ?? 0.1;
export const CAMERA_MAX = ZOOM_STEPS.at(-1) ?? 8;
/** Room kept around what a fit shows, in screen pixels. */
export const FIT_PADDING = 64;
const EPS = 1e-3;

export const clampZoom = (z: number) => Math.min(CAMERA_MAX, Math.max(CAMERA_MIN, z));

export const HOME: Camera = { x: 0, y: 0, z: 1 };

export function toWorld(cam: Camera, p: Point): Point {
  return { x: (p.x - cam.x) / cam.z, y: (p.y - cam.y) / cam.z };
}

export function toScreen(cam: Camera, p: Point): Point {
  return { x: p.x * cam.z + cam.x, y: p.y * cam.z + cam.y };
}

/** A world box on screen. */
export function boxToScreen(cam: Camera, b: Box): Box {
  return { x: b.x * cam.z + cam.x, y: b.y * cam.z + cam.y, w: b.w * cam.z, h: b.h * cam.z };
}

/** A screen box in the world. */
export function boxToWorld(cam: Camera, b: Box): Box {
  return { x: (b.x - cam.x) / cam.z, y: (b.y - cam.y) / cam.z, w: b.w / cam.z, h: b.h / cam.z };
}

/** What the plane shows now, in world units. */
export function visibleWorld(cam: Camera, stage: Size): Box {
  return boxToWorld(cam, { x: 0, y: 0, w: stage.w, h: stage.h });
}

/** Zooms to `z` (kept in range) with the world point under `at` (plane pixels) staying under it. */
export function zoomCameraAt(cam: Camera, z: number, at: Point): Camera {
  const next = clampZoom(z);
  const k = next / cam.z;
  return { z: next, x: at.x - (at.x - cam.x) * k, y: at.y - (at.y - cam.y) * k };
}

export const panCamera = (cam: Camera, dx: number, dy: number): Camera => ({ z: cam.z, x: cam.x + dx, y: cam.y + dy });

/** The next of − (`-1`) or + (`1`) from `z`. */
export function stepCameraZoom(z: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z + EPS) ?? CAMERA_MAX;
  return ZOOM_STEPS.findLast((s) => s < z - EPS) ?? CAMERA_MIN;
}

/**
 * The camera that shows `box` whole in the middle of the plane with `padding` around it, never closer than `maxZoom`
 * (a fit on one small note doesn't blow it up to fill the screen).
 */
export function fitCamera(box: Box, stage: Size, padding = FIT_PADDING, maxZoom = 1): Camera {
  const roomW = Math.max(1, stage.w - 2 * padding);
  const roomH = Math.max(1, stage.h - 2 * padding);
  const z = clampZoom(Math.min(maxZoom, roomW / Math.max(box.w, 1), roomH / Math.max(box.h, 1)));
  return {
    z,
    x: stage.w / 2 - (box.x + box.w / 2) * z,
    y: stage.h / 2 - (box.y + box.h / 2) * z,
  };
}

/** The camera centered on a world point at zoom `z`. */
export function centerOn(p: Point, stage: Size, z: number): Camera {
  const zz = clampZoom(z);
  return { z: zz, x: stage.w / 2 - p.x * zz, y: stage.h / 2 - p.y * zz };
}

/**
 * What a person sees, as their presence says it (`PeerState.view`): the world box their plane shows (`x`, `y`, `w`,
 * `h` in world units) and their zoom. The phone and the web read it the same way to follow someone.
 */
export interface PeerView {
  x: number;
  y: number;
  w: number;
  h: number;
  zoom: number;
}

export function peerViewOf(cam: Camera, stage: Size): PeerView {
  const box = visibleWorld(cam, stage);
  const round = (n: number) => Math.round(n * 100) / 100;
  return { x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h), zoom: round(cam.z * 1000) / 1000 };
}

/** The camera that shows what someone else sees: their world box fitted into this plane (no padding). */
export function followCamera(view: PeerView, stage: Size): Camera {
  if (!(view.w > 0 && view.h > 0)) {
    return centerOn({ x: view.x, y: view.y }, stage, view.zoom > 0 ? view.zoom : 1);
  }
  return fitCamera({ x: view.x, y: view.y, w: view.w, h: view.h }, stage, 0, CAMERA_MAX);
}

/** Whether two cameras show nearly the same (no redraw, no presence update). */
export function sameCamera(a: Camera, b: Camera): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.z - b.z) < 1e-4;
}

/** The step between moving cameras, eased (the follow glide, the fit). */
export function lerpCamera(a: Camera, b: Camera, t: number): Camera {
  // Zoom moves in log space so it feels even; x and y follow the zoom's point of view.
  const z = Math.exp(Math.log(a.z) + (Math.log(b.z) - Math.log(a.z)) * t);
  return { z, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** The dotted background's spacing on screen at this zoom (world 24 units), doubling when dots would crowd. */
export function dotSpacing(z: number): number {
  let step = 24 * z;
  while (step < 12) step *= 2;
  return step;
}
