/**
 * The custom color sheet's math, run on the UI thread while a thumb moves (`ColorSheet`): the color under the finger
 * and the tile it makes. The same steps as the agents' engine (`hsvToHex`, `gradientOf` of a custom color), rounded
 * where it rounds, so the tile drawn during a drag is the one the color gets once it is chosen (a test compares them
 * over the whole picker). Every function is a worklet, callable from either thread.
 */

/** A color's red, green and blue, 0 to 255. */
export type Rgb = [number, number, number];

/** [hue 0..360, saturation 0..1, value 0..1] → its channels, rounded as `hsvToHex` rounds them. */
export function hsvRgb(h: number, s: number, v: number): Rgb {
  "worklet";
  const k5 = (5 + h / 60) % 6;
  const k3 = (3 + h / 60) % 6;
  const k1 = (1 + h / 60) % 6;
  return [
    Math.round((v - v * s * Math.max(0, Math.min(k5, 4 - k5, 1))) * 255),
    Math.round((v - v * s * Math.max(0, Math.min(k3, 4 - k3, 1))) * 255),
    Math.round((v - v * s * Math.max(0, Math.min(k1, 4 - k1, 1))) * 255),
  ];
}

/** "#rrggbb" of a color's channels. */
export function rgbHex(c: Rgb): string {
  "worklet";
  return `#${c[0].toString(16).padStart(2, "0")}${c[1].toString(16).padStart(2, "0")}${c[2].toString(16).padStart(2, "0")}`;
}

/** Channels → [hue 0..360, saturation 0..1, value 0..1], as the engine's `hexToHsv`. */
function rgbHsv(c: Rgb): [number, number, number] {
  "worklet";
  const r = c[0] / 255;
  const g = c[1] / 255;
  const b = c[2] / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max : 0, max];
}

/** Channels → [hue, saturation, lightness], as the engine's `hexToHsl`. */
function rgbHsl(c: Rgb): [number, number, number] {
  "worklet";
  const [h, s, v] = rgbHsv(c);
  const l = v * (1 - s / 2);
  return [h, l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l), l];
}

/** [hue, saturation, lightness] → channels, as the engine's `hslToHex`. */
function hslRgb(h: number, s: number, l: number): Rgb {
  "worklet";
  const v = l + s * Math.min(l, 1 - l);
  return hsvRgb(h, v ? 2 * (1 - l / v) : 0, v);
}

/** One channel in linear light, as WCAG's luminance takes it. */
function linear(n: number): number {
  "worklet";
  const x = n / 255;
  return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0 black to 1 white), as the engine's `luminance`. */
function luminance(c: Rgb): number {
  "worklet";
  return 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
}

/** `a` toward `b` by `k` (0..1), rounded per channel, as the engine's `mixHex`. */
function mix(a: Rgb, b: Rgb, k: number): Rgb {
  "worklet";
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

/**
 * The tile a picked color makes, [top, bottom] as "#rrggbb": `gradientOf(hsvToHex(h, s, v))`, the engine's
 * `customGradient` (the bottom's lightness held where white eyes still read, the top lighter and capped).
 */
export function tileOf(h: number, s: number, v: number): [string, string] {
  "worklet";
  const [hue, sat, l0] = rgbHsl(hsvRgb(h, s, v));
  let l = Math.max(0.28, Math.min(0.55, l0));
  let bottom = hslRgb(hue, sat, l);
  while (luminance(bottom) > 0.28 && l > 0.2) {
    l -= 0.01;
    bottom = hslRgb(hue, sat, l);
  }
  let lt = Math.min(0.78, l + 0.26);
  let top = hslRgb(hue, sat, lt);
  while ((luminance(top) > 0.59 || luminance(mix(bottom, top, 0.5)) > 0.405) && lt > l) {
    lt -= 0.01;
    top = hslRgb(hue, sat, lt);
  }
  return [rgbHex(top), rgbHex(bottom)];
}
