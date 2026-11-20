import { useMemo } from "react";
import Animated, { css, cubicBezier } from "react-native-reanimated";
import { useLivePaused } from "@/agent/live";
import { loopStyle } from "@/agent/loop";
import { BREATH_MS, breathDelay, breathRound } from "@/agent/orbit";
import { useReducedMotion } from "@/ui";
import { useColors } from "../shared/hooks";

/** The app's breath (the stop square's): every mark that breathes does so in step. */
const BREATH = css.keyframes(breathRound());
const SINE = cubicBezier(0.37, 0, 0.63, 1);

/**
 * The small amber square that breathes while a request waits on the person; `still` in lists and chips (ADR 0084
 * addendum: it moves only inside the conversation). The breath loops on the UI thread, in step with the app's other
 * breathing marks, holds while its screen isn't showing (`LivePause`) and stops with Reduce Motion.
 */
export function WaitMark({ size = 8, still = false }: { size?: number; still?: boolean }) {
  const c = useColors();
  const reduced = useReducedMotion();
  const paused = useLivePaused();
  const breathing = !reduced && !still;
  // When it starts breathing: where the shared breath is then.
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again each time it starts breathing
  const startedAt = useMemo(() => Date.now(), [breathing]);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        { width: size, height: size, borderRadius: 2, backgroundColor: c.amber },
        breathing ? loopStyle(BREATH, BREATH_MS, SINE, breathDelay(startedAt), paused) : null,
      ]}
    />
  );
}
