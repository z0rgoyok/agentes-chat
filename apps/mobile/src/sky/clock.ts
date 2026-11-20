import { useCallback, useEffect } from "react";
import { type FrameInfo, type SharedValue, useFrameCallback, useSharedValue } from "react-native-reanimated";
import type { DitherKind } from "./shaders";

/** A late frame moves a drawing on by this much at most: a hitch (or a return from the background) never jumps it. */
const MAX_STEP_MS = 100;

/**
 * Drawings whose time steps 20 times a second instead of every display frame. Their cells are 4 points and what moves
 * in them is slow (the sky's glow and its stars' twinkle, the workspace sky's clouds at under 2 cells a second, the
 * computer sky's field), so a 50 ms step moves well under a cell and most display frames would draw the same pixels.
 * The fuse's flicker, the sweeps, the plan track's breathing, the splash's wave and the forming picture keep every
 * frame.
 */
const PACED: Partial<Record<DitherKind, number>> = { sky: 20, workspace: 20, computer: 20 };

/** The steps a second a drawing's clock needs (`useDrawingClock`'s `fps`); 0: every frame. */
export const drawingFps = (kind: DitherKind): number => PACED[kind] ?? 0;

/**
 * A drawing's time in ms, on the UI thread, that runs only while `moving`. Skia's `useClock` runs a frame callback on
 * every frame for as long as its drawing is mounted, moving or not, and each tick draws it again: a sky under a pushed
 * screen kept redrawing. Here a still drawing has no callback at all, and one that moves again carries on from where
 * it stopped instead of jumping. With `fps`, the time moves in whole steps of that rate, so what reads it (and Skia's
 * redraw) changes only that often.
 */
export function useDrawingClock(moving: boolean, fps = 0): SharedValue<number> {
  const clock = useSharedValue(0);
  // The time to the frame; a paced clock shows it only in whole steps.
  const exact = useSharedValue(0);
  const step = fps > 0 ? 1000 / fps : 0;
  const tick = useCallback(
    (frame: FrameInfo) => {
      "worklet";
      exact.value += Math.min(frame.timeSincePreviousFrame ?? 0, MAX_STEP_MS);
      const next = step > 0 ? Math.floor(exact.value / step) * step : exact.value;
      // Written only when it moves: every write draws again what reads it.
      if (next > clock.value) clock.value = next;
    },
    [clock, exact, step],
  );
  const frames = useFrameCallback(tick, false);
  useEffect(() => {
    frames.setActive(moving);
  }, [frames, moving]);
  return clock;
}
