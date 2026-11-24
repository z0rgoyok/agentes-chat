import { isDarkSurface, mix, PixelSky, SKY_TONES, type SkyOptions, softTones, spriteTone } from "@agenteschat/ui";
import { useMemo } from "react";

/*
 * The Code page's skies (ADR 0215), the agent page's fine sky (`agentCoverOptions`): 2 px pixels, only the light tones
 * of the agents' blue in light, the surface rising into it in dark, a few faint pixel agents drifting. Decorative, as
 * every sky is: what it says is said in words beside it.
 */

const S = Math.sin;

/** Light: the agents' blue from mid to near white, then the surface itself (so the sky ends with no seam). */
function fineTones(surface: string) {
  if (isDarkSurface(surface)) return { dark: true, tones: softTones("sky", surface) };
  const light = SKY_TONES.slice(3);
  return { dark: false, tones: [...light, mix(light[light.length - 1] ?? surface, surface, 0.6), surface] };
}

const smooth = (from: number, v: number) => {
  const s = Math.max(0, Math.min(1, (v - from) / (1 - from)));
  return s * s * (3 - 2 * s);
};

function fineSky(field: (u: number, v: number, t: number, dark: boolean) => number, extra: Partial<SkyOptions> = {}) {
  // Read with the tones on each frame (the theme can change), before the field is drawn.
  let dark = false;
  const options: SkyOptions = {
    pixel: 2,
    surface: "--pane",
    palette: (surface) => {
      const fine = fineTones(surface);
      dark = fine.dark;
      return fine.tones;
    },
    body: spriteTone("sky"),
    near: 0,
    faint: 1,
    light: 0,
    sprites: { area: 10_560, max: 8 },
    base: (u, v, t) => field(u, v, t, dark),
    ...extra,
  };
  return options;
}

/** The home's sky, the whole stage: the color high up in dark, lighter toward the floor in light. */
export function CodeHomeSky() {
  const options = useMemo(
    () =>
      fineSky((u, v, t, dark) =>
        dark
          ? 0.86 - 0.12 * u - 0.78 * v + 0.05 * S(u * 4 + t * 0.5)
          : 0.2 + 0.22 * u + 0.66 * v * v + 0.05 * S(u * 4 + t * 0.5),
      ),
    [],
  );
  return <PixelSky options={options} />;
}

/**
 * The foot of a session's conversation: a light sky rising from its floor behind the composer, which stands on it as
 * the home's does on its sky. Lower and quieter than the panel's horizon, with no pixel agents: someone types there.
 */
export function CodeDockSky() {
  const options = useMemo(
    () =>
      fineSky(
        (u, v, t, dark) => {
          const top = 0.32 + 0.08 * S(u * 3.1 + t * 0.15) + 0.04 * S(u * 7.7 - t * 0.1);
          const e = smooth(top, v) ** 1.6;
          const wave = 0.03 * S(u * 4 + t * 0.5) * e * e;
          return dark ? Math.max(0, 0.44 * e + wave) : Math.min(1, 1 - 0.62 * e + wave);
        },
        // Where it has no pixel, what is behind shows: no band of the surface's color over the conversation.
        { sprites: 0, seeThrough: true },
      ),
    [],
  );
  return (
    <div className="code-dock-sky" aria-hidden="true">
      <PixelSky options={options} />
    </div>
  );
}

/**
 * The foot of a session's side panel: the sky rises from the bottom with no edge, behind what the panel shows. Its top
 * third is the bare surface; the contour moves like slow hills (never a straight line where it starts), and a pool of
 * light sits behind whoever stands on it (bottom left).
 */
export function CodeHorizon() {
  const options = useMemo(
    () =>
      fineSky(
        (u, v, t, dark) => {
          const top = 0.3 + 0.1 * S(u * 3.1 + t * 0.15) + 0.05 * S(u * 7.7 - t * 0.1);
          const e = smooth(top, v) ** 1.5;
          const wave = 0.04 * S(u * 4 + t * 0.5) * e * e;
          const pool = Math.exp(-(((u - 0.08) * 1.4) ** 2 + (v - 0.9) ** 2) / 0.06) * e;
          return dark ? Math.max(0, 0.58 * e + wave + 0.14 * pool) : Math.min(1, 1 - 0.82 * e + wave + 0.7 * pool);
        },
        { sprites: { area: 9_000, max: 4 }, ceil: 0.55 },
      ),
    [],
  );
  return <PixelSky options={options} />;
}

/**
 * The screen's stage: the bare surface at the top, under its bar, and the sky rising toward the foot behind the screen
 * (its contour moves like slow hills, never a straight line where it starts).
 */
export function CodeScreenSky() {
  const options = useMemo(
    () =>
      fineSky(
        (u, v, t, dark) => {
          const top = 0.14 + 0.08 * S(u * 2.7 + t * 0.12) + 0.04 * S(u * 6.1 - t * 0.09);
          const e = smooth(top, v) ** 1.3;
          const wave = 0.04 * S(u * 4 + t * 0.5) * e;
          return dark ? Math.max(0, 0.6 * e + wave) : Math.min(1, 1 - 0.8 * e + wave);
        },
        // No agents drifting here: the screen is what to look at, and the line under it is read over the sky.
        { sprites: { area: 12_000, max: 0 }, ceil: 0.55 },
      ),
    [],
  );
  return <PixelSky options={options} />;
}
