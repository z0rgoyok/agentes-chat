import { Canvas, Fill, Shader, Skia, type SkRuntimeEffect } from "@shopify/react-native-skia";
import { useMemo, useState } from "react";
import { type LayoutChangeEvent, type StyleProp, View, type ViewStyle } from "react-native";
import { type SharedValue, useDerivedValue } from "react-native-reanimated";
import { useLivePaused } from "@/agent/live";
import { useReducedMotion } from "@/ui/theme";
import { drawingFps, useDrawingClock } from "./clock";
import { paletteUniform } from "./math";
import { type DitherKind, shaderSource } from "./shaders";

const effects = new Map<DitherKind, SkRuntimeEffect | null>();

/** The compiled shader for a drawing (compiled once; null if the device refuses it). */
export function effectOf(kind: DitherKind): SkRuntimeEffect | null {
  if (!effects.has(kind)) {
    let effect: SkRuntimeEffect | null = null;
    try {
      effect = Skia.RuntimeEffect.Make(shaderSource(kind));
    } catch {
      effect = null;
    }
    if (!effect) console.warn(`dither shader "${kind}" did not compile`);
    effects.set(kind, effect);
  }
  return effects.get(kind) ?? null;
}

export interface DitherProps {
  kind: DitherKind;
  /** Tones, deep to light (up to 8). */
  tones: readonly string[];
  /** Points per dither cell. */
  pixel: number;
  /** Drawing-specific uniforms (`remaining`, `value`, `count` + `states`). */
  extra?: Record<string, number | number[]>;
  /** Moves with time (sky, fuse, plan track); the spend bar stays still. */
  animated?: boolean;
  /** Fade out to the bottom from this height share (2 = none). */
  fade?: number;
  /** Come in from nothing, in dither steps, down to this height share (0 = none): a band that doesn't start at the top. */
  fadeTop?: number;
  /** The first tone is see-through (a drawing over glass). */
  clear?: boolean;
  /** The drawing's width, from the UI thread, when it changes faster than a layout should (the canvas stays). */
  liveWidth?: SharedValue<number>;
  /** The `pill` drawing's `work` uniform, from the UI thread: 0 at rest, 1 working. */
  liveWork?: SharedValue<number>;
  style?: StyleProp<ViewStyle>;
}

/**
 * A pixel/dither drawing on a Skia shader. Time runs on the UI thread (`useDrawingClock`), so it costs the JS
 * thread nothing, and only while the drawing moves: a still one (paused off screen, or `animated={false}`) has no frame
 * callback and is not drawn again. With reduced motion it is drawn once at t = 0. If the shader can't compile, the
 * first tone fills the box.
 */
export function Dither({
  kind,
  tones,
  pixel,
  extra,
  animated = true,
  fade = 2,
  fadeTop = 0,
  clear = false,
  liveWidth,
  liveWork,
  style,
}: DitherProps) {
  const reduced = useReducedMotion();
  // Off screen (LivePause): its clock stops where it was, so Skia stops redrawing and it comes back without a jump.
  const paused = useLivePaused();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width !== size.width || height !== size.height) setSize({ width, height });
  };
  const effect = effectOf(kind);
  // The uniforms by what they say, not by the objects handed in: a parent drawn again hands new arrays of the same
  // tones (`softTones(…)`, `[...tones, …]`) and a new `extra`. Made anew, they rebuilt the drawing's mapper on the UI
  // thread (Reanimated starts it again when what its worklet captures changes) and parsed the eight tones again, on
  // every draw of the home's header, of a conversation's pill and of each card with a sky.
  const tonesKey = tones.join("|");
  const extraKey = extra ? JSON.stringify(extra) : "";
  const { pal, last } = useMemo(() => paletteUniform(tonesKey ? tonesKey.split("|") : []), [tonesKey]);
  const extraUniforms = useMemo<Record<string, number | number[]>>(
    () => (extraKey ? JSON.parse(extraKey) : {}),
    [extraKey],
  );
  const timed = animated && !reduced;
  const clock = useDrawingClock(timed && !paused, drawingFps(kind));
  const base = useMemo(
    () => ({
      size: [size.width, size.height],
      px: pixel,
      last,
      fade,
      fadeTop,
      clear: clear ? 1 : 0,
      pal,
      ...extraUniforms,
    }),
    [size.width, size.height, pixel, last, fade, fadeTop, clear, pal, extraUniforms],
  );
  const uniforms = useDerivedValue(() => ({
    ...base,
    ...(liveWidth ? { size: [Math.max(1, liveWidth.value), size.height] } : {}),
    ...(liveWork ? { work: liveWork.value } : {}),
    t: timed ? clock.value / 1000 : 0,
  }));

  if (!effect)
    return (
      <View
        style={[{ backgroundColor: clear ? "transparent" : (tones[0] ?? "transparent") }, style]}
        onLayout={onLayout}
      />
    );
  return (
    <View
      style={style}
      onLayout={onLayout}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {size.width > 0 && size.height > 0 ? (
        <Canvas style={{ width: size.width, height: size.height }}>
          <Fill>
            <Shader source={effect} uniforms={uniforms} />
          </Fill>
        </Canvas>
      ) : null}
    </View>
  );
}
