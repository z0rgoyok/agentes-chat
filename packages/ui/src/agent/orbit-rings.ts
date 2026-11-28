import { type AgentColorName, gradientOf, mixHex } from "./engine.js";

/**
 * The rings an agent at work wears (web `OrbitGlyph`, phone `OrbitFace`): radius in halves of the glyph's side,
 * flatness (ry / rx), tilt in degrees, one turn's seconds, where its light starts (degrees) and whether it turns the
 * other way. Two rings at different speeds, one the other way round, so they never line up into one shape; tight
 * enough that they reach a few pixels past the face, never into the name beside it.
 *
 * `spin` is one slow turn of the ring itself around the face, in seconds (negative: counter-clockwise), with its light
 * riding it: the ring's tilt is where it starts and where it rests with reduced motion. Each ring at its own pace and
 * the other way from the other, so they keep crossing and read as two orbits in depth.
 */
export const ORBIT_RINGS = [
  { r: 1.36, flat: 0.3, tilt: -17, turn: 2.6, start: 30, back: false, spin: 16 },
  { r: 1.24, flat: 0.38, tilt: 21, turn: 3.9, start: 210, back: true, spin: -23 },
] as const;

/** The rings' box, in glyph sides: the wider ring and its light fit. */
export const ORBIT_SPAN = 2.2;

/**
 * The light that rides each ring: an arc of `arc` degrees that fades from its head in `steps` pieces, a small dot at
 * the head (`dot`, its radius in hundredths of the glyph's side). The ring itself stays behind the face; the light
 * passes over the face on the near half and behind it on the far one.
 */
export const ORBIT_LIGHT = { arc: 110, steps: 8, dot: 5.6 } as const;

/** How much of the light each piece keeps, head first: it fades out along the arc. */
export const orbitFade = (step: number) => (1 - step / ORBIT_LIGHT.steps) ** 1.3;

/** How wide each piece is, as a share of the head's width: the arc thins out behind its head. */
export const orbitTaper = (step: number) => 1 - (0.65 * step) / ORBIT_LIGHT.steps;

/**
 * The orbit's colours, all the agent's own: each ring's (the first in its deep tone, the second between its tones) and
 * the light's head. On a dark ground the light tones lead, so the rings still read.
 */
export function orbitColors(
  color?: AgentColorName | string,
  dark = false,
): { rings: readonly [string, string]; head: string } {
  const [top, bottom] = gradientOf(color);
  return dark
    ? { rings: [top, mixHex(top, "#ffffff", 0.5)], head: mixHex(top, "#ffffff", 0.78) }
    : { rings: [bottom, mixHex(bottom, top, 0.5)], head: bottom };
}
