import { playedBars, resamplePeaks, VOICE_BAR, VOICE_BAR_GAP } from "@agenteschat/ui/voice/bars";
import {
  Canvas,
  Circle,
  Group,
  LinearGradient,
  Path,
  Rect,
  rect,
  rrect,
  Skia,
  type SkPath,
  vec,
} from "@shopify/react-native-skia";
import { useState } from "react";
import { type LayoutChangeEvent, StyleSheet, type ViewStyle } from "react-native";
import { type SharedValue, useDerivedValue } from "react-native-reanimated";
import {
  BAR_HANDLE,
  WAVE_CELL as CELL,
  columnsIn,
  WAVE_HANDLE as HANDLE,
  handleAt,
  WAVE_PITCH as PITCH,
  playedColumns,
} from "./logic";

/** How much of the left end fades into the field while a recording grows from the right. */
const FADE = 0.35;

/** A column's cells, split so each can take its own tone: the first and last cell (`edge`) and the rest (`inner`). */
export interface WavePaths {
  inner: SkPath;
  edge: SkPath;
}

/**
 * `peaks` as columns of cells, each centered on the middle row. `tail`: the newest columns at the right end, the way a
 * live recording looks (the rest of the width stays empty); otherwise spread over the width, clear of the handle's
 * room at both ends (`playedColumns`).
 */
export function wavePaths(peaks: readonly number[], width: number, height: number, tail = false): WavePaths {
  const inner = Skia.PathBuilder.Make();
  const edge = Skia.PathBuilder.Make();
  const rows = Math.max(1, Math.floor(height / CELL));
  const spread = tail ? null : playedColumns(width);
  const n = spread ? spread.count : columnsIn(width);
  const shown = tail ? peaks.slice(-n) : stretched(peaks, n);
  // Right-aligned when live: the last column ends at the right edge.
  const startAt = spread ? spread.start : width - shown.length * PITCH + (PITCH - CELL);
  shown.forEach((level, i) => {
    const cells = Math.max(1, Math.min(rows, Math.round(level * rows)));
    const top = Math.round((rows - cells) / 2);
    const x = startAt + i * PITCH;
    for (let c = 0; c < cells; c++) {
      const r = rect(x, (top + c) * CELL, CELL, CELL);
      if (c === 0 || c === cells - 1) edge.addRect(r);
      else inner.addRect(r);
    }
  });
  return { inner: inner.build(), edge: edge.build() };
}

export const emptyWave = (): WavePaths => ({ inner: Skia.Path.Make(), edge: Skia.Path.Make() });

function stretched(peaks: readonly number[], n: number): number[] {
  if (peaks.length === 0) return Array.from({ length: n }, () => 0.06);
  return Array.from({ length: n }, (_, i) => peaks[Math.floor((i * peaks.length) / n)] ?? 0.06);
}

/**
 * A wave drawn by Skia on the UI thread: the paths and `progress` change without a render of anything around it, so a
 * playing or recording wave never touches React. Two tones, as the agent's sky has: `tones[0]` fills a column, `tones[1]`
 * its two ends; both the same for a wave in ink. What `progress` has passed is in the tones, the rest in `off`.
 */
export function PixelWave({
  inner,
  edge,
  progress,
  tones,
  off,
  onWidth,
  height,
  handle = false,
  fade,
  style,
}: {
  inner: SharedValue<SkPath>;
  edge: SharedValue<SkPath>;
  progress: SharedValue<number>;
  tones: readonly [string, string];
  off: string;
  onWidth?: (width: number) => void;
  height: number;
  /** A square at `progress`, to grab and drag, on a spread wave (`wavePaths` without `tail`). */
  handle?: boolean;
  /** The field's color: the left end of a growing recording fades into it. */
  fade?: string;
  style?: ViewStyle;
}) {
  const [width, setWidth] = useState(0);
  const layout = (e: LayoutChangeEvent) => {
    const next = e.nativeEvent.layout.width;
    setWidth(next);
    onWidth?.(next);
  };
  // Where the audio is: the handle's middle, and how far the played tones reach.
  const at = useDerivedValue(() => (handle ? handleAt(progress.value, width) + HANDLE / 2 : width * progress.value));
  const clip = useDerivedValue(() => rect(0, 0, at.value, height));
  const handleX = useDerivedValue(() => at.value - HANDLE / 2);
  return (
    <Canvas onLayout={layout} style={[styles.canvas, { height }, style]}>
      <Path path={inner} color={off} />
      <Path path={edge} color={off} />
      <Group clip={clip}>
        <Path path={inner} color={tones[0]} />
        <Path path={edge} color={tones[1]} />
      </Group>
      {fade ? (
        <Rect x={0} y={0} width={width * FADE} height={height}>
          <LinearGradient start={vec(0, 0)} end={vec(width * FADE, 0)} colors={[fade, transparent(fade)]} />
        </Rect>
      ) : null}
      {handle ? <Rect x={handleX} y={height / 2 - HANDLE / 2} width={HANDLE} height={HANDLE} color={tones[0]} /> : null}
    </Canvas>
  );
}

/** A voice message's wave as the web's rounded bars (`playedBars`), each as tall as its peak, 3 at the least. */
export function barWave(peaks: readonly number[], width: number, height: number): SkPath {
  const path = Skia.PathBuilder.Make();
  const { count, start } = playedBars(width);
  resamplePeaks(peaks, count).forEach((level, i) => {
    const bar = Math.max(3, Math.min(height, level * height));
    const x = start + i * (VOICE_BAR + VOICE_BAR_GAP);
    path.addRRect(rrect(rect(x, (height - bar) / 2, VOICE_BAR, bar), VOICE_BAR / 2, VOICE_BAR / 2));
  });
  return path.build();
}

/**
 * A voice message's wave as the web draws it: the bars in `off`, those `progress` has passed in `on`, and the round
 * handle at `progress` to grab and drag. Drawn by Skia on the UI thread, as `PixelWave`.
 */
export function BarWave({
  path,
  progress,
  on,
  off,
  onWidth,
  height,
  handle = true,
}: {
  path: SharedValue<SkPath>;
  progress: SharedValue<number>;
  on: string;
  off: string;
  onWidth?: (width: number) => void;
  height: number;
  handle?: boolean;
}) {
  const [width, setWidth] = useState(0);
  const layout = (e: LayoutChangeEvent) => {
    const next = e.nativeEvent.layout.width;
    setWidth(next);
    onWidth?.(next);
  };
  const at = useDerivedValue(() => handleAt(progress.value, width, BAR_HANDLE) + BAR_HANDLE / 2);
  const clip = useDerivedValue(() => rect(0, 0, at.value, height));
  return (
    <Canvas onLayout={layout} style={[styles.canvas, { height }]}>
      <Path path={path} color={off} />
      <Group clip={clip}>
        <Path path={path} color={on} />
      </Group>
      {handle ? <Circle cx={at} cy={height / 2} r={BAR_HANDLE / 2} color={on} /> : null}
    </Canvas>
  );
}

/** The same color with no alpha, for a gradient's far end ("#rrggbb" or "rgb(a)(…)"). */
function transparent(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return `${color}00`;
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(color);
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, 0)` : "transparent";
}

const styles = StyleSheet.create({ canvas: { flex: 1, minWidth: 0 } });
