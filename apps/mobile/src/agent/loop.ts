import type { ViewStyle } from "react-native";
import type { CSSAnimationProperties, CSSAnimationTimingFunction, CSSKeyframesRule } from "react-native-reanimated";

/**
 * A mark that loops on the UI thread (a Reanimated CSS animation, nothing on the JS thread per frame): `round` over
 * `duration` ms, starting `delay` ms into it (negative: partway through, so marks started at different moments still
 * move in step), held where it is while its screen isn't showing (`paused`, from `LivePause`).
 */
export function loopStyle(
  round: CSSKeyframesRule,
  duration: number,
  timing: CSSAnimationTimingFunction,
  delay: number,
  paused: boolean,
): CSSAnimationProperties<ViewStyle> {
  return {
    animationName: round,
    animationDuration: duration,
    animationTimingFunction: timing,
    animationIterationCount: "infinite",
    animationDelay: delay,
    animationPlayState: paused ? "paused" : "running",
  };
}
