import { type ReactNode, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { GestureDetector, type PanGestureConfig, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  Easing,
  interpolate,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { haptics, Icon, useTheme } from "@/ui";
import { rubberband } from "./pull";

/** How far the row follows the finger freely; past it the pull resists. */
const TRAVEL = 72;
/** Dragged this far the reply is armed (one light tap); back under `UNARM` it is off again, so a wobble at the line never flickers it. */
const COMMIT = 52;
const UNARM = 40;
/**
 * How far a release's speed carries the row (seconds of travel at that speed): a quick flick that would have crossed the
 * line answers too (900 points a second from the 20 it takes to start). Short on purpose, so a slow pull let go early
 * stays a pull.
 */
const FLICK_S = 0.08;
/** The reply mark: a plate at the row's left edge, under where the row slides from. */
const MARK = 28;
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

/**
 * Swipe a message to the right to answer it in the conversation (the quote above the field). The row follows the
 * finger one to one on the UI thread and resists past `TRAVEL`; crossing `COMMIT` arms the reply with one light tap
 * (pulled back under `UNARM` it disarms), and the reply happens on letting go: armed, or flicked hard enough to have
 * crossed the line. Letting go springs the row back with the finger's speed. A vertical move fails the gesture at once,
 * so the list scrolls as before.
 *
 * Off (`enabled` false, a message still on its way) the same views stand around the row with the gesture disabled:
 * a message turning from sending to sent keeps its row mounted instead of being drawn again.
 *
 * The mark under the row mounts the first time a finger lands on the row, ahead of a pull (which only starts 20 points
 * in): the rows nobody touches, most of the ones a scroll mounts, never pay for it or its animated style.
 */
export function SwipeReply({
  enabled,
  onReply,
  children,
}: {
  enabled: boolean;
  onReply: () => void;
  children: ReactNode;
}) {
  const { reducedMotion } = useTheme();
  const x = useSharedValue(0);
  const armed = useSharedValue(false);
  const [marked, setMarked] = useState(false);
  // One config for the row's life: a new one on each render sent the gesture's settings to the native side and its
  // callbacks to the UI thread again, the render a touch makes (the mark) included.
  const config = useMemo((): PanGestureConfig => {
    const showMark = () => setMarked(true);
    const tap = () => haptics.light();
    const reply = (tapped: boolean) => {
      // A flick commits without having crossed the line: its tap comes with the reply.
      if (!tapped) tap();
      onReply();
    };
    return {
      enabled,
      // Offsets are [start, end]: the pan activates past `end` to the right (or before `start` to the left, never
      // here), so only a rightward move of 20 takes the row. A move left, or 8 up or down before that, fails it at once
      // and the list keeps the scroll: vertical motion is always the list's.
      activeOffsetX: [-1e6, 20],
      failOffsetX: [-8, 1e6],
      failOffsetY: [-8, 8],
      // Not from the screen's left edge: that swipe is the system's way back.
      hitSlop: { left: -24 },
      onBegin: () => {
        "worklet";
        scheduleOnRN(showMark);
      },
      onUpdate: (e) => {
        "worklet";
        const tx = Math.max(0, e.translationX);
        x.value = tx <= TRAVEL ? tx : TRAVEL + rubberband(tx - TRAVEL, TRAVEL);
        // On the frame the line is crossed, the tap lands with the mark filling in; nothing else leaves the UI thread.
        if (!armed.value && tx >= COMMIT) {
          armed.value = true;
          scheduleOnRN(tap);
        } else if (armed.value && tx < UNARM) {
          armed.value = false;
        }
      },
      onDeactivate: (e) => {
        "worklet";
        const tx = Math.max(0, e.translationX);
        const flicked = tx + Math.max(0, e.velocityX) * FLICK_S >= COMMIT;
        const wasArmed = armed.value;
        armed.value = false;
        if (!e.canceled && (wasArmed || flicked)) scheduleOnRN(reply, wasArmed);
        x.value = reducedMotion
          ? withTiming(0, { duration: 150, easing: EASE_OUT })
          : withSpring(0, { duration: 400, dampingRatio: 0.8, velocity: e.velocityX });
      },
    };
  }, [enabled, onReply, reducedMotion, x, armed]);
  const pan = usePanGesture(config);
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <GestureDetector gesture={pan}>
      <View>
        {marked ? <ReplyMark x={x} armed={armed} /> : null}
        <Animated.View style={slide}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
}

/**
 * The reply mark at the row's left edge, under where the row slides from: it grows in with the pull and settles whole
 * once the reply is armed.
 */
function ReplyMark({ x, armed }: { x: SharedValue<number>; armed: SharedValue<boolean> }) {
  const { colors } = useTheme();
  const mark = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [0, COMMIT * 0.6], [0, 1], "clamp"),
    transform: [{ scale: armed.value ? 1 : interpolate(x.value, [0, COMMIT], [0.95, 1], "clamp") }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.mark, { backgroundColor: colors.sunken }, mark]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Icon name="reply" size={15} color={colors.ink2} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  mark: {
    position: "absolute",
    left: 16,
    top: "50%",
    marginTop: -MARK / 2,
    width: MARK,
    height: MARK,
    borderRadius: MARK / 2,
    alignItems: "center",
    justifyContent: "center",
  },
});
