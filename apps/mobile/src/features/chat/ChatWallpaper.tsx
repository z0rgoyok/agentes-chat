import { type Wallpaper, type WallpaperHue, wallpaperName } from "@agenteschat/client/lib/wallpaper";
import { drawnKey, rgbOf } from "@agenteschat/ui/agent/engine";
import {
  CROWD,
  CROWD_EYES,
  CROWD_TILE,
  crowdAgents,
  crowdShape,
  crowdTones,
  DRAWING_ICONS,
  DRAWINGS,
  DRAWINGS_TILE,
  drawingsColors,
  WALLPAPER_PAGE,
  WALLPAPER_SKY_PIXEL,
  wallpaperFill,
  wallpaperGrid,
} from "@agenteschat/ui/sky/wallpaper";
import {
  AlphaType,
  Canvas,
  ClipOp,
  ColorType,
  createPicture,
  Fill,
  FilterMode,
  Group,
  LinearGradient,
  Mask,
  MipmapMode,
  PaintStyle,
  Picture,
  Rect,
  type SkCanvas,
  type SkImage,
  Skia,
  type SkPaint,
  type SkPath,
  type SkPicture,
  StrokeCap,
  StrokeJoin,
  vec,
} from "@shopify/react-native-skia";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type LayoutChangeEvent, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { type SharedValue, useDerivedValue } from "react-native-reanimated";
import { useTheme } from "@/ui";
import { AUTO_BANDS, photoCover, skyPixels, wallpaperKey } from "./wallpaper-logic";
import { useWallpaperPhoto } from "./wallpaper-photo";

/**
 * A conversation's background, painted with Skia from the shared numbers (packages/ui/src/sky/wallpaper.ts):
 * the sky as an image of sky pixels drawn nearest-neighbour, the drawings and the agents recorded once as a picture, a
 * flat color, or the person's photo covering the box with its point of interest on screen (darkened at night). Static:
 * it is recorded once per size, theme and choice and never redrawn while the conversation scrolls over it. `strength`
 * under 1 lays the page over it (the styles with no bubbles take it at half).
 */

/** Keeps at most `max` entries, the oldest going first. */
function remember<T>(cache: Map<string, T>, key: string, value: T, max: number) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

const rect = (x: number, y: number, w: number, h: number) => Skia.XYWHRect(x, y, w, h);
const pageOf = (dark: boolean) => (dark ? WALLPAPER_PAGE.dark : WALLPAPER_PAGE.light);

/* ---------- the sky: one pixel per sky pixel ---------- */

const skies = new Map<string, SkImage | null>();

function skyImage(hues: readonly WallpaperHue[], w: number, h: number, dark: boolean, details: boolean) {
  const key = `${hues.map(drawnKey).join(";")}|${w}x${h}|${dark ? 1 : 0}|${details ? 1 : 0}`;
  const hit = skies.get(key);
  if (hit !== undefined) return hit;
  const image = Skia.Image.MakeImage(
    { width: w, height: h, alphaType: AlphaType.Opaque, colorType: ColorType.RGBA_8888 },
    Skia.Data.fromBytes(skyPixels(hues, w, h, dark, details)),
    w * 4,
  );
  remember(skies, key, image, 40);
  return image;
}

function paintSky(canvas: SkCanvas, hues: readonly WallpaperHue[], W: number, H: number, dark: boolean, tile: boolean) {
  const px = tile ? 1 : WALLPAPER_SKY_PIXEL;
  const w = Math.max(1, Math.ceil(W / px));
  const h = Math.max(1, Math.ceil(H / px));
  const image = skyImage(hues, w, h, dark, !tile);
  if (!image) return;
  // Hard pixel edges, as the web's `image-rendering: pixelated`.
  canvas.drawImageRectOptions(
    image,
    rect(0, 0, w, h),
    rect(0, 0, w * px, h * px),
    FilterMode.Nearest,
    MipmapMode.None,
    null,
  );
}

/* ---------- the drawings ---------- */

let drawingsPaths: (SkPath | null)[] | null = null;
const drawingsPathsOf = () => {
  drawingsPaths ??= DRAWING_ICONS.map((d) => Skia.Path.MakeFromSVGString(d));
  return drawingsPaths;
};

type DrawingsColor = Exclude<Extract<Wallpaper, { kind: "drawings" }>["color"], "auto">;

function paintDrawings(canvas: SkCanvas, color: DrawingsColor, W: number, H: number, dark: boolean, tile: boolean) {
  const { bg, ink } = drawingsColors(color, dark);
  const spec = tile ? DRAWINGS_TILE : DRAWINGS;
  const s = spec.size / 24;
  canvas.drawColor(Skia.Color(bg));
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  paint.setStyle(PaintStyle.Stroke);
  paint.setStrokeCap(StrokeCap.Round);
  paint.setStrokeJoin(StrokeJoin.Round);
  // Drawn in the icons' 24-point box, scaled: the line is the drawing's own width once scaled.
  paint.setStrokeWidth(spec.stroke / s);
  paint.setColor(Skia.Color(ink));
  const paths = drawingsPathsOf();
  for (const cell of wallpaperGrid(W, H, spec.cell, paths.length)) {
    const path = paths[cell.index];
    if (!path) continue;
    canvas.save();
    canvas.translate(cell.x - 12 * s, cell.y - 12 * s);
    canvas.scale(s, s);
    canvas.drawPath(path, paint);
    canvas.restore();
  }
}

/* ---------- the agents ---------- */

function paintCrowd(canvas: SkCanvas, W: number, H: number, dark: boolean, tile: boolean) {
  const spec = tile ? CROWD_TILE : CROWD;
  canvas.drawColor(Skia.Color(pageOf(dark)));
  const body = Skia.Path.MakeFromSVGString(crowdShape(0, 0, spec.size, "round").body);
  const eyes = new Map<string, ReturnType<typeof crowdShape>["eyes"]>();
  for (const style of CROWD_EYES) eyes.set(style, crowdShape(0, 0, spec.size, style).eyes);
  const fills = new Map<string, SkPaint>();
  const fill = (color: string) => {
    let p = fills.get(color);
    if (!p) {
      p = Skia.Paint();
      p.setAntiAlias(true);
      p.setStyle(PaintStyle.Fill);
      p.setColor(Skia.Color(color));
      fills.set(color, p);
    }
    return p;
  };
  for (const agent of crowdAgents(W, H, spec.cell, spec.size)) {
    const tones = crowdTones(agent.color, dark);
    canvas.save();
    canvas.translate(agent.x, agent.y);
    if (body) canvas.drawPath(body, fill(tones.body));
    for (const e of eyes.get(agent.eyes) ?? []) {
      const r = Math.min(e.w, e.h) / 2;
      canvas.drawRRect(Skia.RRectXY(rect(e.x, e.y, e.w, e.h), r, r), fill(tones.eye));
    }
    canvas.restore();
  }
}

/* ---------- a background ---------- */

interface Painting {
  wallpaper: Wallpaper;
  width: number;
  height: number;
  dark: boolean;
  strength: number;
  tile: boolean;
  bands: readonly WallpaperHue[];
  photo: SkImage | null;
}

function paint(canvas: SkCanvas, p: Painting) {
  const { wallpaper: w, width: W, height: H, dark, tile } = p;
  switch (w.kind) {
    case "none":
      return;
    case "sky":
      paintSky(canvas, w.color === "auto" ? p.bands : [w.color], W, H, dark, tile);
      break;
    case "drawings": {
      // "auto" with no one conversation to follow: a band of each color, side by side.
      const colors: readonly DrawingsColor[] = w.color === "auto" ? p.bands : [w.color];
      for (let i = 0; i < colors.length; i++) {
        const color = colors[i];
        if (!color) continue;
        const x0 = Math.round((i * W) / colors.length);
        const x1 = Math.round(((i + 1) * W) / colors.length);
        canvas.save();
        canvas.clipRect(rect(x0, 0, x1 - x0, H), ClipOp.Intersect, false);
        paintDrawings(canvas, color, W, H, dark, tile);
        canvas.restore();
      }
      break;
    }
    case "agents":
      paintCrowd(canvas, W, H, dark, tile);
      break;
    case "color":
      canvas.drawColor(Skia.Color(wallpaperFill(w.color, dark)));
      break;
    case "photo": {
      const photo = p.photo;
      if (!photo) return;
      const at = photoCover(photo.width(), photo.height(), W, H, w.x, w.y);
      canvas.drawImageRectOptions(
        photo,
        rect(0, 0, photo.width(), photo.height()),
        rect(at.x, at.y, at.width, at.height),
        FilterMode.Linear,
        MipmapMode.Linear,
        null,
      );
      if (dark && w.dim > 0) canvas.drawColor(Skia.Color(`rgba(0,0,0,${w.dim})`));
      break;
    }
  }
  if (p.strength < 1) {
    const [r, g, b] = rgbOf(pageOf(dark));
    canvas.drawColor(Skia.Color(`rgba(${r},${g},${b},${1 - p.strength})`));
  }
}

const pictures = new Map<string, SkPicture>();

/** A background recorded for a size and theme (cached: the same one again is the same picture). */
function useWallpaperPicture(
  wallpaper: Wallpaper,
  width: number,
  height: number,
  dark: boolean,
  strength: number,
  tile: boolean,
  bands: readonly WallpaperHue[],
): SkPicture | null {
  const photo = useWallpaperPhoto(wallpaper.kind === "photo" ? wallpaper.url : null);
  const W = Math.round(width);
  const H = Math.round(height);
  // The sky as drawn now: the crowd and "auto" draw `sky`, which follows the workspace's accent.
  const key = `${wallpaperKey(wallpaper)}|${bands.join(",")}|${drawnKey("sky")}|${W}x${H}|${dark ? 1 : 0}|${strength}|${tile ? 1 : 0}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key holds everything the picture is painted from
  return useMemo(() => {
    if (W <= 0 || H <= 0 || wallpaper.kind === "none") return null;
    if (wallpaper.kind === "photo" && !photo) return null;
    const cached = photo ? undefined : pictures.get(key);
    if (cached) return cached;
    const picture = createPicture(
      (canvas) => paint(canvas, { wallpaper, width: W, height: H, dark, strength, tile, bands, photo }),
      { width: W, height: H },
    );
    if (!photo) remember(pictures, key, picture, 48);
    return picture;
  }, [key, photo]);
}

export interface ChatWallpaperProps {
  /** The background, "auto" already made this conversation's color (`resolveWallpaper`), or left for `bands`. */
  wallpaper: Wallpaper;
  /** Its size; without one it fills its box and measures it. */
  width?: number;
  height?: number;
  /** 1 behind bubbles; the styles with no bubbles take it at half (`wallpaperStrength`). */
  strength?: number;
  /** A picker's tile: the drawings at their small size, one point per sky pixel, no glints or stars. */
  tile?: boolean;
  /** What "auto" paints when no one conversation says its color (the DMs' tile): side by side bands. */
  bands?: readonly WallpaperHue[];
  style?: StyleProp<ViewStyle>;
}

function ChatWallpaperView({
  wallpaper,
  width,
  height,
  strength = 1,
  tile = false,
  bands = AUTO_BANDS,
  style,
}: ChatWallpaperProps) {
  const { scheme } = useTheme();
  const [box, setBox] = useState({ width: 0, height: 0 });
  const sized = width !== undefined && height !== undefined;
  const W = sized ? width : box.width;
  const H = sized ? height : box.height;
  const picture = useWallpaperPicture(wallpaper, W, H, scheme === "dark", strength, tile, bands);
  const onLayout = (e: LayoutChangeEvent) => {
    const next = e.nativeEvent.layout;
    if (next.width !== box.width || next.height !== box.height) setBox({ width: next.width, height: next.height });
  };
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[sized ? { width: W, height: H } : null, style]}
      onLayout={sized ? undefined : onLayout}
    >
      {picture ? (
        <Canvas style={{ width: W, height: H }}>
          <Picture picture={picture} />
        </Canvas>
      ) : null}
    </View>
  );
}

const sameProps = (a: ChatWallpaperProps, b: ChatWallpaperProps) =>
  wallpaperKey(a.wallpaper) === wallpaperKey(b.wallpaper) &&
  a.width === b.width &&
  a.height === b.height &&
  a.strength === b.strength &&
  a.tile === b.tile &&
  a.bands === b.bands &&
  a.style === b.style;

/** A background behind a conversation, a preview or a tile (see the module's note). Never redraws for its parent. */
export const ChatWallpaper = memo(ChatWallpaperView, sameProps);

/** From solid to clear under the bar, as the conversation's own fade (alpha only: the colors are the background's). */
const BAND_ALPHA = ["rgba(0,0,0,1)", "rgba(0,0,0,1)", "rgba(0,0,0,0)"];

/**
 * How tall the conversation's fade is above the composer's box (points): above it the conversation shows, below it the
 * box is solid. The box's first line (who is working, the reply bar) sits right under it, never over the words of a
 * message passing behind (a fade down the box's top third ran right through that line).
 */
export const DOCK_FADE = 16;

function WallpaperBandView({
  wallpaper,
  width,
  height,
  band,
  solid,
  strength = 1,
}: {
  wallpaper: Wallpaper;
  /** The screen's size: the band is the top of the same picture, so it lines up with the background under it. */
  width: number;
  height: number;
  /** How tall the band is (the bar and a little under it). */
  band: number;
  /** How far down it stays solid, as a share of `band` (the status bar and the bar's own height). */
  solid: number;
  strength?: number;
}) {
  const { scheme, colors } = useTheme();
  const picture = useWallpaperPicture(wallpaper, width, height, scheme === "dark", strength, false, AUTO_BANDS);
  if (band <= 0) return null;
  const from = Math.min(1, Math.max(0, solid));
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.band, { height: band }]}
    >
      <Canvas style={{ width, height: band }}>
        <Mask
          mode="alpha"
          mask={
            <Rect x={0} y={0} width={width} height={band}>
              <LinearGradient start={vec(0, 0)} end={vec(0, band)} colors={BAND_ALPHA} positions={[0, from, 1]} />
            </Rect>
          }
        >
          {/* A photo still on its way: the page's own fade until it is here. */}
          {picture ? <Picture picture={picture} /> : <Fill color={colors.bg} />}
        </Mask>
      </Canvas>
    </View>
  );
}

/**
 * The top of a conversation over its background: the background itself again, solid behind the status bar and the bar
 * and fading out under it, so a message scrolled up there never shows through the clock or the bar's pill (the
 * conversation's fade, in the background's own colors instead of the page's).
 */
export const WallpaperBand = memo(WallpaperBandView);

/** From clear to solid in the composer's box's first `DOCK_FADE` points, as the conversation's own fade under it. */
const UNDER_ALPHA = ["rgba(0,0,0,0)", "rgba(0,0,0,1)", "rgba(0,0,0,1)"];

function WallpaperUnderView({
  wallpaper,
  width,
  height,
  strength = 1,
  box,
  keyboard,
  lift,
}: {
  wallpaper: Wallpaper;
  /** The screen's size: what shows under the box is the same picture, cut where the box is. */
  width: number;
  height: number;
  strength?: number;
  /** The box's height, as the conversation measures it. */
  box: SharedValue<number>;
  /** The keyboard as the box's sticky view follows it (negative height while it is up, its progress 0 to 1). */
  keyboard: { height: SharedValue<number>; progress: SharedValue<number> };
  /** How much of the box's bottom padding hides behind the open keyboard (the sticky view's offset). */
  lift: number;
}) {
  const { scheme, colors } = useTheme();
  const picture = useWallpaperPicture(wallpaper, width, height, scheme === "dark", strength, false, AUTO_BANDS);
  const [tall, setTall] = useState(0);
  // Where the box's top is on the screen, frame by frame as the keyboard moves it (the sticky view's own math), so
  // the background under it is drawn from that height and lines up with the one behind.
  const shift = useDerivedValue(
    () => [{ translateY: -(height - box.get() + keyboard.height.get() + keyboard.progress.get() * lift) }],
    [height, lift],
  );
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
      onLayout={(e) => setTall(e.nativeEvent.layout.height)}
    >
      {tall > 0 ? (
        <Canvas style={{ width, height: tall }}>
          <Mask
            mode="alpha"
            mask={
              <Rect x={0} y={0} width={width} height={tall}>
                <LinearGradient
                  start={vec(0, 0)}
                  end={vec(0, tall)}
                  colors={UNDER_ALPHA}
                  positions={[0, Math.min(1, DOCK_FADE / tall), 1]}
                />
              </Rect>
            }
          >
            {picture ? (
              <Group transform={shift}>
                <Picture picture={picture} />
              </Group>
            ) : (
              <Fill color={colors.bg} />
            )}
          </Mask>
        </Canvas>
      ) : null}
    </View>
  );
}

/**
 * Under the composer over a background: the background itself again, fading in down the box as the page's color does
 * without one, so a message passing under the box fades out there (the conversation's fade, in the background's
 * colors), lined up with the background behind as the keyboard moves the box.
 */
export const WallpaperUnder = memo(WallpaperUnderView);

/** A background in small, before a row's value (20 × 30, as the design): the page itself for "No background". */
export function WallpaperThumb({ wallpaper, bands }: { wallpaper: Wallpaper; bands?: readonly WallpaperHue[] }) {
  const { colors, scheme } = useTheme();
  return (
    <View style={[styles.thumb, { backgroundColor: pageOf(scheme === "dark") }]}>
      <ChatWallpaper
        wallpaper={wallpaper}
        width={THUMB.width}
        height={THUMB.height}
        tile
        {...(bands ? { bands } : {})}
      />
      <View pointerEvents="none" style={[styles.thumbEdge, { borderColor: colors.line2 }]} />
    </View>
  );
}

const THUMB = { width: 20, height: 30 } as const;

const styles = StyleSheet.create({
  band: { position: "absolute", top: 0, left: 0, right: 0 },
  thumb: { width: THUMB.width, height: THUMB.height, borderRadius: 5, overflow: "hidden" },
  thumbEdge: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: 5,
    borderWidth: StyleSheet.hairlineWidth,
  },
});

type Say = Parameters<typeof wallpaperName>[0];

/** A background's name in the person's language, for a row's value ("Agent's sky", "Color · Sand"). */
export function useWallpaperName() {
  const { t } = useTranslation();
  return useCallback((w: Wallpaper, dm: boolean | null) => wallpaperName(t as unknown as Say, w, dm), [t]);
}
