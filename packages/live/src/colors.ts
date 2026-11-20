/**
 * People's colors in a live file (ADR 0196 §5): each person gets a stable color for their face's ring, their cursor,
 * their selection and the words "editing B4:C10". Ten hues, each with a `light` variant that reads on white (text
 * contrast at least 4.5:1) and a `dark` one that reads on the dark theme's surfaces, chosen to stand apart from each
 * other and from the agents' own colors (an agent is drawn in its own look, never in one of these).
 */
export const PEER_COLORS: readonly { light: string; dark: string }[] = [
  { light: "#cf222e", dark: "#ff8a80" }, // red
  { light: "#007a5e", dark: "#3fdcae" }, // emerald
  { light: "#b0289a", dark: "#f59ae6" }, // magenta
  { light: "#b8500a", dark: "#ffa45c" }, // orange
  { light: "#00708f", dark: "#62d3f0" }, // cyan
  { light: "#6f6a00", dark: "#d6cf52" }, // olive
  { light: "#7d3c5c", dark: "#e8a3bf" }, // plum
  { light: "#3f7d1a", dark: "#9ad66b" }, // lime
  { light: "#4a5d72", dark: "#aab8c8" }, // slate
  { light: "#8a5a35", dark: "#d9a77c" }, // brown
];

/** FNV-1a over the UTF-16 code units: the same number on every platform. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The color of a person (or anyone with an id), the same in every app and every session. */
export function peerColor(id: string, dark = false): string {
  const pair = PEER_COLORS[fnv1a(id) % PEER_COLORS.length] ?? PEER_COLORS[0];
  return pair ? (dark ? pair.dark : pair.light) : "#4a5d72";
}

/** "#rgb", "#rrggbb" or "#rrggbbaa" (alpha ignored) as [r, g, b] in 0..255, or null. */
export function hexRgb(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (!m?.[1]) return null;
  let hex = m[1];
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
  const n = Number.parseInt(hex.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance of a hex color (0 black .. 1 white); null when it isn't a hex color. */
export function relativeLuminance(color: string): number | null {
  const rgb = hexRgb(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colors (1..21); 1 when either isn't a hex color. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return 1;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Of `inks`, the one that reads best on `fill` (text on a colored shape or a name tag). */
export function readableOn(fill: string, inks: readonly string[]): string {
  let best = inks[0] ?? "#000000";
  let bestRatio = 0;
  for (const ink of inks) {
    const ratio = contrastRatio(ink, fill);
    if (ratio > bestRatio) {
      best = ink;
      bestRatio = ratio;
    }
  }
  return best;
}
