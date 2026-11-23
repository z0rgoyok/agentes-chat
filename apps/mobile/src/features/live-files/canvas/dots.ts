/**
 * The canvas's dotted plane on the phone (ADR 0196 §2): one runtime shader, so a pan or a pinch redraws it on the UI
 * thread for every frame at no cost however many dots there are. A dot sits on every whole multiple of the spacing
 * from `off` (points), `r` points across half, in `color` (straight RGBA, 0..1).
 */
export const DOTS_SHADER = `
uniform float2 off;
uniform float spacing;
uniform float r;
uniform float4 color;

half4 main(float2 p) {
  float2 m = mod(p - off, spacing);
  float2 d = min(m, spacing - m);
  float a = clamp(r + 0.5 - length(d), 0.0, 1.0) * color.a;
  return half4(color.rgb * a, a);
}
`;

/** A theme color ("#rrggbb", "#rgb" or "rgba(r, g, b, a)") as straight RGBA in 0..1; black when unreadable. */
export function colorFloats(css: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim());
  if (hex) {
    const h = hex[1] ?? "000";
    const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
    const n = Number.parseInt(full, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(css.trim());
  if (fn) {
    const parts = (fn[1] ?? "").split(",").map((p) => Number.parseFloat(p.trim()));
    const [r = 0, g = 0, b = 0, a = 1] = parts;
    return [r / 255, g / 255, b / 255, Number.isFinite(a) ? a : 1];
  }
  return [0, 0, 0, 1];
}
