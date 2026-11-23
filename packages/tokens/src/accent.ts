/**
 * A workspace's accent (ADR 0193): the agent color family (`--agent`, `--agent2`, `--agent-soft`, `--on-agent`)
 * derived from one picked "#rrggbb", for the light and the dark theme. Shared by the web and the phone.
 */
import { dark, light } from "./index";

export interface AccentTokens {
  agent: string;
  agent2: string;
  agentSoft: string;
  onAgent: string;
}

export interface AccentPalette {
  light: AccentTokens;
  dark: AccentTokens;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Whether `v` is a "#rrggbb" (mirrors `isHexColor` in packages/ui/src/agent/engine.js). */
export const isAccentHex = (v: unknown): v is string => typeof v === "string" && HEX.test(v);

const pick = (t: AccentTokens): AccentTokens => ({
  agent: t.agent,
  agent2: t.agent2,
  agentSoft: t.agentSoft,
  onAgent: t.onAgent,
});

/** The design system's own blue: what a workspace without an accent shows. */
export const DEFAULT_ACCENT = light.agent;
export const DEFAULT_ACCENT_PALETTE: AccentPalette = { light: pick(light), dark: pick(dark) };

// WCAG math; mirrors `luminance` and `contrastOf` in packages/ui/src/agent/engine.js, which @agenteschat/ui builds on
// this package, so it can't be imported from here.
const channels = (hex: string) => {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
};

function luminance(hex: string) {
  const [r, g, b] = channels(hex).map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two "#rrggbb" (1 to 21). */
export function contrastRatio(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function fromHsl(h: number, s: number, l: number) {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return `#${[f(0), f(8), f(4)]
    .map((c) =>
      Math.round(Math.max(0, Math.min(1, c)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

const AA = 4.5;

function tokensFor(hex: string, theme: typeof light): AccentTokens {
  const isDark = theme === dark;
  const [h, s, l0] = toHsl(hex);
  const ons = isDark ? [dark.onAgent, light.onAgent] : [light.onAgent, dark.onAgent];
  const agentSoft = isDark ? fromHsl(h, Math.min(s, 0.58), 0.16) : fromHsl(h, Math.min(s, 0.88), 0.94);
  const readable = (c: string) =>
    contrastRatio(c, theme.bg) >= AA &&
    contrastRatio(c, agentSoft) >= AA &&
    ons.some((on) => contrastRatio(c, on) >= AA);
  // The default palette's quiet surface in this hue; then `agent` moves in lightness only, as little as needed to
  // read on the page and on that surface: toward white in the dark theme, toward black in the light one.
  let l = l0;
  let agent = hex;
  while (!readable(agent) && (isDark ? l < 1 : l > 0)) {
    l = isDark ? Math.min(1, l + 0.005) : Math.max(0, l - 0.005);
    agent = fromHsl(h, s, l);
  }
  const onAgent = ons.find((on) => contrastRatio(agent, on) >= AA) ?? (ons[0] as string);
  return {
    agent,
    // The default palette's lighter step, same hue.
    agent2: fromHsl(h, s, l + (1 - l) * (isDark ? 0.3 : 0.35)),
    agentSoft,
    onAgent,
  };
}

/**
 * The four agent tokens for each theme from a picked "#rrggbb". `agent` reaches 4.5:1 on the theme's page and on
 * `agentSoft`, and carries
 * one of the two default on-colors at 4.5:1 (`onAgent`); the design system's blue gives back its own tokens exactly.
 */
export function accentPalette(hex: string): AccentPalette {
  const color = hex.toLowerCase();
  if (!isAccentHex(color) || color === DEFAULT_ACCENT) return DEFAULT_ACCENT_PALETTE;
  return { light: tokensFor(color, light), dark: tokensFor(color, dark) };
}

/**
 * The accent as the agents' engine draws it (`sky`, ADR 0193): [top, bottom], the light theme's `agent2` and `agent`
 * in both themes, as the landing's sky is one pair in both. That `agent` carries white at 4.5:1, which keeps agents'
 * white eyes readable on it whatever was picked.
 */
export function accentSky(hex: string): [string, string] {
  const { agent, agent2 } = accentPalette(hex).light;
  return [agent2, agent];
}
