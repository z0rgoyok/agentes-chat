import { Skia, type SkRuntimeEffect } from "@shopify/react-native-skia";

/**
 * The launch's ring (`EXIT` in ./logic.ts) as one SkSL pass on the sky's own cells (`px`): outside the edge `r`
 * nothing, on the band the sky's tones Bayer-dithered (brightest mid-band), its inner half dithering through to the
 * app, and inside it the app. `mode` 0 draws only what is cleared (opaque), for the splash to be cut with `dstOut`;
 * 1 draws the band's tones. `ringCell` in ./logic.ts mirrors it.
 */
const SOURCE = `
uniform float2 center;
uniform float r;
uniform float band;
uniform float px;
uniform float mode;
uniform float4 pal[4];

float b2(float a, float b) {
  return a < 0.5 ? (b < 0.5 ? 0.0 : 3.0) : (b < 0.5 ? 2.0 : 1.0);
}

float bayer(float x, float y) {
  float x0 = mod(x, 2.0);
  float y0 = mod(y, 2.0);
  float x1 = mod(floor(x / 2.0), 2.0);
  float y1 = mod(floor(y / 2.0), 2.0);
  return (4.0 * b2(x0, y0) + b2(x1, y1) + 0.5) / 16.0;
}

float4 tone(float idx) {
  float4 c = pal[0];
  for (int i = 1; i < 4; i++) {
    if (abs(float(i) - idx) < 0.5) c = pal[i];
  }
  return c;
}

half4 main(float2 pos) {
  float x = floor(pos.x / px);
  float y = floor(pos.y / px);
  float d = distance(float2(x * px + px * 0.5, y * px + px * 0.5), center);
  if (d > r) return half4(0.0);
  float k = (r - d) / band;
  float b = bayer(x, y);
  bool cleared = k >= 1.0 || (k > 0.5 && b < (k - 0.5) / 0.5);
  if (mode < 0.5) return cleared ? half4(1.0) : half4(0.0);
  if (cleared) return half4(0.0);
  float f = 3.0 * (1.0 - abs(2.0 * k - 1.0));
  float base = floor(f);
  float idx = min(3.0, (f - base > b) ? base + 1.0 : base);
  if (idx < 0.5) return half4(0.0);
  return half4(tone(idx));
}
`;

let effect: SkRuntimeEffect | null | undefined;

/** The ring's shader, made once (null where the platform can't compile it: the splash then leaves with a fade). */
export function ringEffect(): SkRuntimeEffect | null {
  if (effect === undefined) {
    try {
      effect = Skia.RuntimeEffect.Make(SOURCE);
    } catch {
      effect = null;
    }
  }
  return effect;
}
