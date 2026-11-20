import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import { type LayoutChangeEvent, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { GestureDetector, type PanGestureConfig, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  Easing,
  makeMutable,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { giveWay, pullOf, timeShown } from "./pull";

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

/** The conversation's pull to the left (0 at rest), on the UI thread: rows read it to slide and show their times. */
export const SwipeTimeContext = createContext<SharedValue<number>>(makeMutable(0));

/**
 * The way to the times in a conversation of bubbles or compact rows, which hold none (`timesOnPull`): pulled to the
 * left, anywhere on it, my own bubbles and every compact row slide over and every message's time (with what became of
 * mine, in bubbles) comes in at the screen's right edge, one to one with the finger on the UI thread, resisting past
 * `TIME_REVEAL`; let go, it springs back with the finger's speed (a short ease with Reduce Motion). Leftward only and
 * failed by 8 points to the right or up or down first: a reply's swipe (to the right) and the scroll (up and down)
 * keep theirs.
 */
export function useSwipeTimePan(pull: SharedValue<number>, enabled: boolean, reduced: boolean) {
  // One config for the screen's life: a new one each render sent the gesture's settings to the native side again.
  const config = useMemo(
    (): PanGestureConfig => ({
      enabled,
      // Offsets are [start, end]: it takes the conversation 20 points to the left, never to the right.
      activeOffsetX: [-20, 1e6],
      failOffsetX: [-1e6, 8],
      failOffsetY: [-8, 8],
      onUpdate: (e) => {
        "worklet";
        pull.value = pullOf(-e.translationX);
      },
      onDeactivate: (e) => {
        "worklet";
        pull.value = reduced
          ? withTiming(0, { duration: 150, easing: EASE_OUT })
          : withSpring(0, { duration: 400, dampingRatio: 0.9, velocity: -e.velocityX });
      },
    }),
    [enabled, reduced, pull],
  );
  return usePanGesture(config);
}

/** The conversation under the pull: the pan takes it anywhere on the list, its rows read it (`SwipeTimeContext`). */
export function SwipeTimeFrame({
  pull,
  gesture,
  children,
}: {
  pull: SharedValue<number>;
  gesture: ReturnType<typeof usePanGesture>;
  children: ReactNode;
}) {
  return (
    <SwipeTimeContext.Provider value={pull}>
      <GestureDetector gesture={gesture}>
        <View style={styles.frame} collapsable={false}>
          {children}
        </View>
      </GestureDetector>
    </SwipeTimeContext.Provider>
  );
}

/** My own message, at the screen's right edge: it slides over with the pull, so its time has room. */
export function SwipeSlide({
  on,
  style,
  children,
}: {
  on: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const pull = useContext(SwipeTimeContext);
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: on ? -pull.value : 0 }] }));
  return <Animated.View style={[style, slide]}>{children}</Animated.View>;
}

/**
 * A compact row's face and words: they run to the screen's edge, so they slide over with the pull as my bubbles do,
 * and the time comes in where they were.
 */
export function useSwipeSlide(on: boolean) {
  const pull = useContext(SwipeTimeContext);
  return useAnimatedStyle(() => ({ transform: [{ translateX: on ? -pull.value : 0 }] }));
}

/**
 * Someone else's message in a bubble: it stays where it is while the times come in, unless its bubble is too wide
 * for them; then the row gives way, only as far as they need. `onArea` measures the width the bubble may take and
 * `onBubble` its own: the difference (and `spare`, see `giveWay`) is the room at its right, which the pull fills first.
 */
export function useGiveWay(spare: number) {
  const pull = useContext(SwipeTimeContext);
  const area = useSharedValue(0);
  const bubble = useSharedValue(0);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: -giveWay(pull.value, area.value, bubble.value, spare) }],
  }));
  const onArea = useCallback(
    (e: LayoutChangeEvent) => {
      area.value = e.nativeEvent.layout.width;
    },
    [area],
  );
  const onBubble = useCallback(
    (e: LayoutChangeEvent) => {
      bubble.value = e.nativeEvent.layout.width;
    },
    [bubble],
  );
  return { style, onArea, onBubble };
}

/**
 * A message's time (and what became of mine) at the screen's right edge, on its row's middle: out of sight at rest,
 * coming in with the pull and fully there at `TIME_REVEAL`. Takes no touch.
 */
export function SwipeTime({ children }: { children: ReactNode }) {
  const pull = useContext(SwipeTimeContext);
  const shown = useAnimatedStyle(() => {
    const { opacity, shift } = timeShown(pull.value);
    return { opacity, transform: [{ translateX: shift }] };
  });
  return (
    <Animated.View pointerEvents="none" style={[styles.time, shown]}>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1 },
  // In the row's gutter at the right (12 from the screen's edge), on its middle.
  time: { position: "absolute", top: 0, bottom: 0, right: 12, flexDirection: "row", alignItems: "center", gap: 4 },
});
