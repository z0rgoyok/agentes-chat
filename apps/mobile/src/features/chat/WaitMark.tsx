import { useEffect } from "react";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useReducedMotion } from "@/ui";
import { useColors } from "../shared/hooks";

/**
 * The small amber square that breathes while a request waits on the person; `still` in lists and chips (ADR 0084
 * addendum: it moves only inside the conversation).
 */
export function WaitMark({ size = 8, still = false }: { size?: number; still?: boolean }) {
  const c = useColors();
  const reduced = useReducedMotion();
  const fade = useSharedValue(1);
  useEffect(() => {
    if (reduced || still) return;
    fade.value = withRepeat(withSequence(withTiming(0.55, { duration: 800 }), withTiming(1, { duration: 800 })), -1);
  }, [reduced, still, fade]);
  const style = useAnimatedStyle(() => ({ opacity: fade.value }));
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width: size, height: size, borderRadius: 2, backgroundColor: c.amber }, style]}
    />
  );
}
