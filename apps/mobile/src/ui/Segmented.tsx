import { useEffect, useRef, useState } from "react";
import { Pressable, Text as RNText, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { Count } from "./Count";
import type { FiltersProps } from "./Filters";
import { haptics } from "./haptics";
import { Icon } from "./Icon";
import { RADIUS } from "./radius";
import { TOUCH } from "./rhythm";
import { systemText } from "./Text";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

export type SegmentedProps = FiltersProps & {
  /**
   * As wide as its box, the segments sharing it evenly (a screen's views, as the tasks' List · Board).
   * `fit`: each as wide as its words first, so long labels stay on one line (a form's choice).
   */
  wide?: boolean | "fit";
  /** `page`: the views of a whole screen (a proposal's or a document's views): 44 tall, a finger's target whole. */
  size?: "page";
};

/** The track's inset around the segments. */
const PAD = 3;
/** A segment's height inside the track: 34 (40 with the track), a screen's views 38 (44, a finger's target whole). */
const SEGMENT_H = 34;
const PAGE_SEGMENT_H = 38;

/**
 * A segmented control, touch first: a capsule track in the tonal fill a finger presses (`tonal`), the chosen segment a
 * raised capsule that slides to a new choice; 40 tall (a screen's views 44), each segment's target grown to 44.
 */
export function Segmented({ items, value, onChange, wide = false, size }: SegmentedProps) {
  const page = size === "page";
  const segment = page ? PAGE_SEGMENT_H : SEGMENT_H;
  const height = segment + 2 * PAD;
  const radius = RADIUS.full;
  const { colors, shadows, motion, reducedMotion } = useTheme();
  const [boxes, setBoxes] = useState<Record<string, { x: number; width: number }>>({});
  const at = boxes[value];
  const x = useSharedValue(0);
  const width = useSharedValue(0);
  // The first place is taken at once; only a change of choice slides.
  const placed = useRef(false);
  useEffect(() => {
    if (!at) return;
    const timing = { duration: reducedMotion || !placed.current ? 0 : motion.base, easing: motion.easeOut };
    x.value = withTiming(at.x, timing);
    width.value = withTiming(at.width, timing);
    placed.current = true;
  }, [at, x, width, reducedMotion, motion]);
  const plate = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }], width: width.value }));
  const raised = { backgroundColor: colors.raised, boxShadow: `${shadows.e1}, ${shadows.top}` };
  return (
    <View
      style={{
        flexDirection: "row",
        padding: PAD,
        borderRadius: radius,
        backgroundColor: colors.tonal,
        alignSelf: wide ? "stretch" : "flex-start",
      }}
      accessibilityRole="tablist"
    >
      {at ? (
        <Animated.View
          pointerEvents="none"
          style={[{ position: "absolute", left: 0, top: PAD, bottom: PAD, borderRadius: radius }, raised, plate]}
        />
      ) : null}
      {items.map((item) => {
        const on = item.key === value;
        const off = item.disabled === true && !on;
        return (
          <Pressable
            key={item.key}
            disabled={off}
            onPress={() => {
              if (!on) haptics.selection();
              onChange(item.key);
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: on, disabled: off }}
            accessibilityLabel={item.accessibilityLabel}
            onLayout={(e) => {
              const { x: left, width: w } = e.nativeEvent.layout;
              setBoxes((b) =>
                b[item.key]?.x === left && b[item.key]?.width === w ? b : { ...b, [item.key]: { x: left, width: w } },
              );
            }}
            style={({ pressed }) => [
              wide === "fit" ? { flexGrow: 1 } : wide ? { flex: 1 } : null,
              pressed && !on ? { opacity: 0.6 } : null,
              off ? { opacity: 0.45 } : null,
            ]}
            // The slop gives a segment the 44 a finger needs, past the track's own padding.
            hitSlop={{
              top: Math.max(0, (TOUCH - height) / 2) + PAD,
              bottom: Math.max(0, (TOUCH - height) / 2) + PAD,
            }}
          >
            <View
              style={[
                {
                  minHeight: segment,
                  paddingHorizontal: 14,
                  borderRadius: radius,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                },
                on && !at ? raised : null,
              ]}
            >
              {item.icon ? <Icon name={item.icon} size={13} color={on ? colors.ink : colors.muted} /> : null}
              <RNText
                maxFontSizeMultiplier={CHROME_MAX_SCALE}
                style={[systemText("subhead", weights.semibold), { color: on ? colors.ink : colors.muted }]}
              >
                {item.label}
              </RNText>
              {item.count !== undefined ? <Count value={item.count} size={15} color={colors.faint} /> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
