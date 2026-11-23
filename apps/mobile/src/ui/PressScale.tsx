import type { ReactNode } from "react";
import { Pressable, type PressableProps, type StyleProp, StyleSheet, type ViewStyle } from "react-native";
import Animated, { type AnimatedStyle, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { haptics } from "./haptics";
import { motion, useTheme } from "./theme";

export interface PressScaleProps extends Omit<PressableProps, "style" | "children"> {
  /** Scale while pressed (default 0.97). */
  to?: number;
  /** Also sink half a point (buttons). */
  sink?: boolean;
  /** A light haptic when the press lands (default true); never when the finger only starts a scroll. */
  haptic?: boolean;
  /**
   * The press area fills the view (default true: a sized circle or tile centers its content). Off for
   * content-sized controls: a growing press area takes whatever height Yoga offers when it measures a row
   * to fit, so a button stood as tall as the screen.
   */
  fill?: boolean;
  /**
   * How the content sits in the press area. `style` is the button from the outside (size, color, shadow): alignment
   * set there moves the press area, not what is inside it, so a sized circle's icon stayed in its top corner.
   */
  contentStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<AnimatedStyle<ViewStyle>>;
  children?: ReactNode;
}

/** Press feedback: down fast as the finger lands, back a little slower, both ease-out, no overshoot. */
export const PRESS_IN = { duration: 120, easing: motion.easeOut };
export const PRESS_OUT = { duration: 180, easing: motion.easeOut };
/**
 * A press shows after this long (ms): a finger that only starts a scroll on a control never shrinks it or flashes a
 * row (React Native's scroll views don't hold touches back as the system's own do). Too short to feel as a delay.
 */
export const PRESS_DELAY = 60;
/** A full-width row lights a beat later than a button: a list is mostly scrolled, and a flash on every scroll reads as noise. */
export const ROW_PRESS_DELAY = 80;

/**
 * The design system's tactile press: the control eases down as the finger lands and back on release (instant with
 * reduced motion), and a light haptic when the press lands on it. Everything pressable in src/ui uses it.
 */
export function PressScale({
  to = 0.97,
  sink = false,
  haptic = true,
  fill = true,
  contentStyle,
  style,
  children,
  onPress,
  onPressIn,
  onPressOut,
  disabled,
  ...rest
}: PressScaleProps) {
  const { reducedMotion } = useTheme();
  const k = useSharedValue(0);
  const animated = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - (1 - to) * k.value }, { translateY: sink ? 0.5 * k.value : 0 }],
  }));
  return (
    <Animated.View style={[style, animated]}>
      <Pressable
        unstable_pressDelay={PRESS_DELAY}
        {...rest}
        disabled={disabled}
        style={[fill ? styles.fill : undefined, contentStyle]}
        onPressIn={(e) => {
          k.value = reducedMotion ? 1 : withTiming(1, PRESS_IN);
          onPressIn?.(e);
        }}
        onPressOut={(e) => {
          k.value = reducedMotion ? 0 : withTiming(0, PRESS_OUT);
          onPressOut?.(e);
        }}
        {...(onPress
          ? {
              onPress: (e: Parameters<NonNullable<PressableProps["onPress"]>>[0]) => {
                if (haptic && !disabled) haptics.light();
                onPress(e);
              },
            }
          : {})}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({ fill: { flexGrow: 1 } });
