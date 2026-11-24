import { type BrandLook, brandRandom } from "@agenteschat/client/lib/brand-look";
import { mixHex } from "@agenteschat/ui/agent/engine";
import {
  BlendMode,
  Canvas,
  Image,
  type SkCanvas,
  type SkImage,
  Skia,
  type SkSVG,
  TileMode,
  vec,
} from "@shopify/react-native-skia";
import { useEffect, useState } from "react";
import { type LayoutChangeEvent, PixelRatio, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { serverUrl } from "@/lib/server";

/** Marks fetched once per address, as Skia's SVG with a size (a bare viewBox draws at none). */
const marks = new Map<string, Promise<SkSVG | null>>();
function loadMark(uri: string) {
  let hit = marks.get(uri);
  if (!hit) {
    hit = fetch(uri)
      .then((r) => (r.ok ? r.text() : null))
      .then((svg) => (svg ? Skia.SVG.MakeFromString(svg.replace("<svg", '<svg width="256" height="256"')) : null))
      .catch(() => null);
    marks.set(uri, hit);
  }
  return hit;
}

const color = (hex: string, alpha = 1) => {
  const c = Skia.Color(hex);
  c[3] = alpha;
  return c;
};

/** The mark at `px`, in `tint` (a one-color mark) or in its maker's colors. */
function markImage(svg: SkSVG, px: number, tint: string | null): SkImage | null {
  const surface = Skia.Surface.Make(px, px);
  if (!surface) return null;
  const canvas = surface.getCanvas();
  canvas.drawSvg(svg, px, px);
  if (tint) {
    const paint = Skia.Paint();
    paint.setColor(color(tint));
    paint.setBlendMode(BlendMode.SrcIn);
    canvas.drawRect(Skia.XYWHRect(0, 0, px, px), paint);
  }
  surface.flush();
  return surface.makeImageSnapshot();
}

function drawMark(canvas: SkCanvas, img: SkImage, x: number, y: number, size: number, alpha: number) {
  const paint = Skia.Paint();
  paint.setAlphaf(alpha);
  canvas.drawImageRect(img, Skia.XYWHRect(0, 0, img.width(), img.height()), Skia.XYWHRect(x, y, size, size), paint);
}

function rect(canvas: SkCanvas, w: number, h: number, set: (paint: ReturnType<typeof Skia.Paint>) => void) {
  const paint = Skia.Paint();
  set(paint);
  canvas.drawRect(Skia.XYWHRect(0, 0, w, h), paint);
}

/**
 * The art as one image, drawn as the web's (`BrandArt` there): `glow`, the brand's colors as soft light with its mark
 * huge, tilted and cut by the edge; `pattern`, the mark in tilted rows, a brand color each. The words' side
 * (`words`) fades into `surface`.
 */
function paint(
  W: number,
  H: number,
  look: BrandLook,
  svg: SkSVG | null,
  template: "glow" | "pattern",
  surface: string,
  dark: boolean,
  words: "bottom" | "down",
): SkImage | null {
  const scale = Math.min(PixelRatio.get(), 3);
  const surfaceGpu = Skia.Surface.Make(Math.round(W * scale), Math.round(H * scale));
  if (!surfaceGpu) return null;
  const canvas = surfaceGpu.getCanvas();
  canvas.scale(scale, scale);
  const pal = look.colors.length > 0 ? look.colors : ["#2B74E6"];
  const lead = pal[0] as string;
  const r = brandRandom(look.mark ?? pal.join());

  // The ground: the surface, toward the brand's leading color on the art's side.
  const deep = dark ? mixHex(lead, "#0a0a0e", 0.72) : mixHex(lead, "#ffffff", 0.86);
  rect(canvas, W, H, (p) =>
    p.setShader(
      Skia.Shader.MakeLinearGradient(
        vec(0, 0),
        vec(W, H),
        [color(mixHex(surface, deep, 0.35)), color(deep)],
        null,
        TileMode.Clamp,
      ),
    ),
  );

  if (template === "glow") {
    for (const [i, c] of pal.slice(0, 3).entries()) {
      const cx = W * (0.55 + 0.3 * r());
      const cy = H * (i === 0 ? 0.2 : 0.4 + 0.6 * r());
      const rad = Math.max(W, H) * (0.45 + 0.25 * r());
      const inner = dark ? mixHex(c, "#000000", 0.2) : mixHex(c, "#ffffff", 0.6);
      rect(canvas, W, H, (p) => {
        p.setBlendMode(dark ? BlendMode.Screen : BlendMode.Multiply);
        p.setShader(
          Skia.Shader.MakeRadialGradient(
            vec(cx, cy),
            rad,
            [color(inner, dark ? 0.6 : 0.8), color(c, 0)],
            null,
            TileMode.Clamp,
          ),
        );
      });
    }
    if (svg) {
      const size = H * 1.9;
      const tint = look.own ? null : dark ? "#ffffff" : mixHex(lead, "#000000", 0.2);
      const img = markImage(svg, 512, tint);
      if (img) {
        canvas.save();
        canvas.translate(W - size * 0.34, H * 0.42);
        canvas.rotate(-12.6, 0, 0);
        drawMark(canvas, img, -size / 2, -size / 2, size, look.own ? (dark ? 0.32 : 0.28) : dark ? 0.2 : 0.16);
        canvas.restore();
      }
    }
    // Grain, so the light isn't flat.
    rect(canvas, W, H, (p) => {
      p.setShader(Skia.Shader.MakeFractalNoise(0.9, 0.9, 2, 7, 0, 0));
      p.setBlendMode(BlendMode.Overlay);
      p.setAlphaf(dark ? 0.08 : 0.06);
    });
  } else if (svg) {
    const tiles = look.own
      ? [markImage(svg, 96, null)]
      : pal.map((c) => markImage(svg, 96, dark ? c : mixHex(c, "#000000", 0.1)));
    const step = 46;
    const size = 22;
    const turn = -0.21;
    const span = Math.ceil(Math.hypot(W, H) / step);
    canvas.save();
    canvas.translate(W / 2, H / 2);
    canvas.rotate((turn * 180) / Math.PI, 0, 0);
    for (let row = -span; row <= span; row++) {
      for (let col = -span; col <= span; col++) {
        const px = col * step + (row % 2 ? step / 2 : 0);
        const py = row * step * 0.82;
        // Fading toward the page under it, by where the mark lands once turned.
        const uy = px * Math.sin(turn) + py * Math.cos(turn) + H / 2;
        const fade = Math.min(1, Math.max(0, 1 - uy / (H * 0.85)));
        const tile = tiles[(((row * 3 + col) % tiles.length) + tiles.length) % tiles.length];
        if (fade <= 0 || !tile) continue;
        drawMark(canvas, tile, px - size / 2, py - size / 2, size, fade * (dark ? 0.55 : 0.6));
      }
    }
    canvas.restore();
  }

  // The words' side stays the surface, so a name reads the same on every brand.
  rect(canvas, W, H, (p) =>
    p.setShader(
      Skia.Shader.MakeLinearGradient(
        vec(0, H),
        vec(0, words === "bottom" ? H * 0.35 : H * 0.5),
        [color(surface, words === "bottom" ? (dark ? 0.85 : 0.88) : 1), color(surface, 0)],
        null,
        TileMode.Clamp,
      ),
    ),
  );
  surfaceGpu.flush();
  return surfaceGpu.makeImageSnapshot();
}

/**
 * A service's brand art, the web's (`BrandArt` there) drawn with Skia: `glow` behind a featured card (its words at the
 * `bottom`), `pattern` on top of a service's page (the page goes on `down` under it). `surface` is the "#rrggbb" under
 * it, which the words' side fades into. It fills its parent.
 */
export function BrandArt({
  look,
  template,
  surface,
  dark,
  words,
  style,
}: {
  look: BrandLook;
  template: "glow" | "pattern";
  surface: string;
  dark: boolean;
  words: "bottom" | "down";
  style?: StyleProp<ViewStyle>;
}) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [art, setArt] = useState<SkImage | null>(null);
  const key = `${look.mark}|${look.colors.join()}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the look's contents.
  useEffect(() => {
    if (!size) return;
    let alive = true;
    (look.mark ? loadMark(`${serverUrl()}${look.mark}`) : Promise.resolve(null)).then((svg) => {
      if (alive) setArt(paint(size.w, size.h, look, svg, template, surface, dark, words));
    });
    return () => {
      alive = false;
    };
  }, [key, size, template, surface, dark, words]);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0 && (width !== size?.w || height !== size?.h)) setSize({ w: width, h: height });
  };
  return (
    <View style={[StyleSheet.absoluteFill, style]} onLayout={onLayout} pointerEvents="none">
      {art && size ? (
        <Canvas style={StyleSheet.absoluteFill}>
          <Image image={art} x={0} y={0} width={size.w} height={size.h} fit="fill" />
        </Canvas>
      ) : null}
    </View>
  );
}
