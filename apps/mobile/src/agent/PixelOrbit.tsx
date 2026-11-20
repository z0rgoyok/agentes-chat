import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { useMemo } from "react";
import { View } from "react-native";
import Animated, { type CSSKeyframesRule, css } from "react-native-reanimated";
import { useReducedMotion, useTheme } from "@/ui/theme";
import { useLivePaused } from "./live";
import { loopStyle } from "./loop";
import { ORBIT_ROUND_MS, orbitCells, orbitDelay, orbitRound, orbitTones } from "./orbit";

export interface PixelOrbitProps {
  color: AgentColorName;
  /** Side in points (default 12). */
  size?: number;
  /** Held on its first frame (a pull not yet let go): it turns once the work starts. */
  still?: boolean;
}

/** One round per agent tone and surface, shared by every orbit drawn in it. */
const rounds = new Map<string, CSSKeyframesRule>();
function roundOf(color: AgentColorName, surface: string): CSSKeyframesRule {
  const key = `${color}|${surface}`;
  let round = rounds.get(key);
  if (!round) {
    const { lead, faint } = orbitTones(color, surface);
    round = css.keyframes(orbitRound(lead, faint));
    rounds.set(key, round);
  }
  return round;
}

/**
 * The 3×3 pixel orbit (working, loading) in the agent's tones: the head walks the ring a cell every 110 ms, two cells
 * trailing it. It turns on the UI thread (each cell a CSS animation a step behind the one before), in step with every
 * other orbit on screen; it holds its first frame while `still` and with reduced motion, and stops where it is on a
 * screen that isn't showing (`LivePause`).
 */
export function PixelOrbit({ color, size = 12, still = false }: PixelOrbitProps) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const paused = useLivePaused();
  const turning = !reduced && !still;
  // When it starts turning: where the round is then, so it turns in step with the orbits already turning.
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again each time it starts turning
  const startedAt = useMemo(() => Date.now(), [turning]);
  const round = turning ? roundOf(color, colors.bg) : null;
  const cell = size / 3;
  const gap = Math.max(0.5, cell * 0.14);
  return (
    <View
      style={{ width: size, height: size }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {orbitCells(color, colors.bg, 0).map((c, k) => (
        <Animated.View
          key={`${c.x}-${c.y}`}
          style={[
            {
              position: "absolute",
              left: c.x * cell + gap / 2,
              top: c.y * cell + gap / 2,
              width: cell - gap,
              height: cell - gap,
              backgroundColor: c.color,
              opacity: c.opacity,
            },
            round ? loopStyle(round, ORBIT_ROUND_MS, "step-end", orbitDelay(k, startedAt), paused) : null,
          ]}
        />
      ))}
    </View>
  );
}
