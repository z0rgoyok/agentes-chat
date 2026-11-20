import { useEffect } from "react";
import { Pressable, StyleSheet } from "react-native";
import Animated, { interpolateColor, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { haptics } from "./haptics";
import { Text } from "./Text";
import { motion, useTheme } from "./theme";

export interface ToggleProps {
  value: boolean;
  onChange: (value: boolean) => void;
  /** Shown on the left of the switch (and read by screen readers). */
  label: string;
}

/** A custom switch (never the native one) in a row with its label. */
export function Toggle({ value, onChange, label }: ToggleProps) {
  return (
    <Pressable
      onPress={() => {
        haptics.selection();
        onChange(!value);
      }}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value }}
      // The switch answers on its own (its flip and a tick), as the system's: the row doesn't light.
      style={styles.row}
    >
      <Text variant="body" style={{ flex: 1 }}>
        {label}
      </Text>
      <ToggleSwitch value={value} />
    </Pressable>
  );
}

/** A switch's flip: short, ease-out, no overshoot. */
const SWITCH = { duration: 160, easing: motion.easeOut };

/**
 * Only the switch (track and knob), for rows that bring their own press and
 * label (a sheet action with an icon and a hint). The row carries
 * `accessibilityRole="switch"` and the checked state.
 */
export function ToggleSwitch({ value }: { value: boolean }) {
  const { colors, reducedMotion } = useTheme();
  const k = useSharedValue(value ? 1 : 0);
  // A short ease-out: a switch flipped all day never wobbles past its stop.
  useEffect(() => {
    k.value = reducedMotion ? (value ? 1 : 0) : withTiming(value ? 1 : 0, SWITCH);
  }, [value, reducedMotion, k]);
  // The track fills and the knob turns with the knob's own travel, never a step ahead of it.
  const { ink, sunken, bg, raised } = colors;
  const knob = useAnimatedStyle(() => ({
    transform: [{ translateX: 18 * k.value }],
    backgroundColor: interpolateColor(k.value, [0, 1], [raised, bg]),
  }));
  const track = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(k.value, [0, 1], [sunken, ink]) }));
  return (
    <Animated.View
      style={[
        {
          width: 46,
          height: 28,
          borderRadius: 999,
          boxShadow: "inset 0px 1px 2px 0px rgba(0, 0, 0, 0.1)",
        },
        track,
      ]}
    >
      <Animated.View
        style={[
          {
            position: "absolute",
            top: 3,
            left: 3,
            width: 22,
            height: 22,
            borderRadius: 11,
            boxShadow: "0px 1px 3px 0px rgba(0, 0, 0, 0.25)",
          },
          knob,
        ]}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // A grouped row's 50 pt: 22 of text and 14 above and under it.
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, paddingHorizontal: 14 },
});
