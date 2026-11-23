import { useEffect, useMemo } from "react";
import { View } from "react-native";
import Animated, {
  css,
  cubicBezier,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useReducedMotion, useTheme } from "@/ui/theme";
import { useLivePaused } from "./live";
import { loopStyle } from "./loop";
import {
  BREATH_MS,
  breathDelay,
  breathRound,
  inkOrbitCells,
  inkOrbitRound,
  ORBIT_ROUND_MS,
  orbitDelay,
  RING,
} from "./orbit";

/**
 * The pixel marks next to the agent's orbit: the neutral orbit ("enviando", "lê na próxima
 * pausa"), a finished step's one green pixel, a failed step's red exclamation, a stopped step's dim block
 * and the composer's rounded stop square. Same grid and gaps as `PixelOrbit`; what moves does on the UI thread, held
 * on a screen that isn't showing, and nothing moves with reduced motion.
 */

const cellBox = (size: number, n: number, x: number, y: number) => {
  const cell = size / n;
  const gap = Math.max(0.5, cell * 0.14);
  return {
    position: "absolute" as const,
    left: x * cell + gap / 2,
    top: y * cell + gap / 2,
    width: cell - gap,
    height: cell - gap,
  };
};

const hidden = { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" as const };

/** The neutral orbit's round, the same for every ink. */
const INK_ROUND = css.keyframes(inkOrbitRound());
/** The stop square's breath, each half on a sine's ease. */
const BREATH = css.keyframes(breathRound());
const SINE = cubicBezier(0.37, 0, 0.63, 1);

/** The 3×3 orbit in ink (no agent color): something on its way that isn't an agent's work. */
export function InkOrbit({ size = 12, color }: { size?: number; color?: string }) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const paused = useLivePaused();
  const turning = !reduced;
  // When it starts turning: where the round is then, so it turns in step with the orbits already turning.
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again each time it starts turning
  const startedAt = useMemo(() => Date.now(), [turning]);
  const ink = color ?? colors.muted;
  return (
    <View style={{ width: size, height: size }} {...hidden}>
      {inkOrbitCells(0).map((c, k) => (
        <Animated.View
          key={`${c.x}-${c.y}`}
          style={[
            cellBox(size, 3, c.x, c.y),
            { backgroundColor: ink, opacity: c.opacity },
            turning ? loopStyle(INK_ROUND, ORBIT_ROUND_MS, "step-end", orbitDelay(k, startedAt), paused) : null,
          ]}
        />
      ))}
    </View>
  );
}

/** A finished step: one green pixel, the size of the grid's center cell, popping in (~160 ms). */
export function PixelDone({ size = 14 }: { size?: number }) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const k = useSharedValue(reduced ? 1 : 0);
  const pop = useSharedValue(reduced ? 1 : 0.6);
  useEffect(() => {
    if (reduced) return;
    k.value = withTiming(1, { duration: 160 });
    pop.value = withSequence(withTiming(1.15, { duration: 100 }), withTiming(1, { duration: 60 }));
  }, [reduced, k, pop]);
  const style = useAnimatedStyle(() => ({ opacity: k.value, transform: [{ scale: pop.value }] }));
  return (
    <View style={{ width: size, height: size }} {...hidden}>
      <Animated.View style={[cellBox(size, 3, 1, 1), { backgroundColor: colors.ok }, style]} />
    </View>
  );
}

/** A failed step: an exclamation of two pixels in the danger color (a tall one over the center column's last cell). */
export function PixelFail({ size = 14 }: { size?: number }) {
  const { colors } = useTheme();
  const top = cellBox(size, 3, 1, 0);
  return (
    <View style={{ width: size, height: size }} {...hidden}>
      <View style={[top, { height: top.height + size / 3, backgroundColor: colors.danger }]} />
      <View style={[cellBox(size, 3, 1, 2), { backgroundColor: colors.danger }]} />
    </View>
  );
}

/** A step cut short by a stop: the 3×3 block, dim. */
export function PixelStopped({ size = 14 }: { size?: number }) {
  const { colors } = useTheme();
  return (
    <View style={{ width: size, height: size }} {...hidden}>
      {[...RING, [1, 1] as const].map(([x, y]) => (
        <View key={`${x}-${y}`} style={[cellBox(size, 3, x, y), { backgroundColor: colors.muted, opacity: 0.55 }]} />
      ))}
    </View>
  );
}

/** "Parar": one rounded square (reads as stop, ~3/4 of the box); it breathes while the agent works (`moving`). */
export function PixelStop({ size = 13, color, moving = true }: { size?: number; color: string; moving?: boolean }) {
  const reduced = useReducedMotion();
  const paused = useLivePaused();
  const breathing = !reduced && moving;
  // When it starts breathing: where the breath is then, so every stop square breathes in step.
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again each time it starts breathing
  const startedAt = useMemo(() => Date.now(), [breathing]);
  const side = Math.round(size * 0.76);
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }} {...hidden}>
      <Animated.View
        style={[
          {
            width: side,
            height: side,
            borderRadius: Math.max(2, Math.round(side * 0.24)),
            backgroundColor: color,
            opacity: 1,
          },
          breathing ? loopStyle(BREATH, BREATH_MS, SINE, breathDelay(startedAt), paused) : null,
        ]}
      />
    </View>
  );
}
