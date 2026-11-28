/**
 * Looks a slide element and a canvas shape share (ADR 0220 §3): a shadow, a two-color gradient, a dashed border and
 * padding. Plain data with their checks, so every app and the server's rules of shape agree on what may be stored.
 */

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A drop shadow: offset and blur in the kind's units, a color with its alpha ("#rrggbbaa"). */
export interface Shadow {
  x: number;
  y: number;
  blur: number;
  color: string;
}

/** A linear gradient from one color to another; the angle in degrees as CSS says it (180 = top to bottom). */
export interface Gradient {
  from: string;
  to: string;
  angle: number;
}

export type Dash = "solid" | "dashed" | "dotted";

export const DASHES: readonly Dash[] = ["solid", "dashed", "dotted"];

export function isDash(value: unknown): value is Dash {
  return typeof value === "string" && (DASHES as readonly string[]).includes(value);
}

/** A shadow as stored, or undefined when it isn't one. */
export function cleanShadow(value: unknown): Shadow | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (!inRange(v.x, -500, 500) || !inRange(v.y, -500, 500) || !inRange(v.blur, 0, 500)) return undefined;
  if (typeof v.color !== "string" || !COLOR.test(v.color)) return undefined;
  return { x: round2(v.x), y: round2(v.y), blur: round2(v.blur), color: v.color };
}

/** A gradient as stored, or undefined when it isn't one. */
export function cleanGradient(value: unknown): Gradient | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.from !== "string" || !COLOR.test(v.from) || typeof v.to !== "string" || !COLOR.test(v.to))
    return undefined;
  const angle = inRange(v.angle, -360, 360) ? ((Math.round(v.angle) % 360) + 360) % 360 : 180;
  return { from: v.from, to: v.to, angle };
}

/** Padding inside a box, in the kind's units: one number for every side. */
export function cleanPadding(value: unknown): number | undefined {
  return inRange(value, 0, 500) ? round2(value) : undefined;
}

/** Line height as a multiple of the size. */
export function cleanLineHeight(value: unknown): number | undefined {
  return inRange(value, 0.8, 3) ? round2(value) : undefined;
}

/** Letter spacing in thousandths of the size (0 is none, so it isn't kept). */
export function cleanTracking(value: unknown): number | undefined {
  return inRange(value, -200, 1000) && Math.round(value) !== 0 ? Math.round(value) : undefined;
}

/** A shadow as CSS draws it. */
export function shadowCss(shadow: Shadow, scale = 1): string {
  return `${shadow.x * scale}px ${shadow.y * scale}px ${shadow.blur * scale}px ${shadow.color}`;
}

/** A gradient as CSS draws it. */
export function gradientCss(gradient: Gradient): string {
  return `linear-gradient(${gradient.angle}deg, ${gradient.from}, ${gradient.to})`;
}
