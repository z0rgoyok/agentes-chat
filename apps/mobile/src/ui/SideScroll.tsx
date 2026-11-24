import { LinearGradient } from "expo-linear-gradient";
import type { ReactNode } from "react";
import {
  type LayoutChangeEvent,
  type ScrollViewProps,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import Animated, { useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { withAlpha } from "./palette";
import { useTheme } from "./theme";

/** How wide each edge's fade is, and how far a scroll takes it from nothing to whole. */
const FADE = 28;

export interface SideScrollProps
  extends Omit<ScrollViewProps, "horizontal" | "onScroll" | "onLayout" | "onContentSizeChange" | "style"> {
  children: ReactNode;
  /** The color behind the strip, which its edges fade into: the page's own by default. */
  fade?: string;
  /** The strip's box (its place in the page); the fades lie at its edges. */
  style?: StyleProp<ViewStyle>;
}

/**
 * A strip that scrolls sideways (a shelf, the facts under a title, chips, pinned faces): the system's horizontal scroll
 * view, with a fade at each edge where more of it waits past that edge, so it reads as scrollable without a scroll bar.
 * The right fade shows while there is more to the right and goes at the end; the left one comes in once it has moved
 * from its start. Both follow the scroll on the UI thread; a strip that fits shows none.
 */
export function SideScroll({ children, fade, style, ...props }: SideScrollProps) {
  const { colors } = useTheme();
  const tone = fade ?? colors.bg;
  const x = useSharedValue(0);
  const room = useSharedValue(0);
  const width = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      x.value = e.contentOffset.x;
      room.value = e.contentSize.width;
      width.value = e.layoutMeasurement.width;
    },
  });
  const left = useAnimatedStyle(() => ({ opacity: Math.min(1, Math.max(0, x.value / FADE)) }));
  const right = useAnimatedStyle(() => {
    const past = room.value - width.value - x.value;
    return { opacity: Math.min(1, Math.max(0, past / FADE)) };
  });
  return (
    <View style={[styles.box, style]}>
      <Animated.ScrollView
        {...props}
        horizontal
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onLayout={(e: LayoutChangeEvent) => {
          width.value = e.nativeEvent.layout.width;
        }}
        onContentSizeChange={(w) => {
          room.value = w;
        }}
      >
        {children}
      </Animated.ScrollView>
      <Animated.View pointerEvents="none" style={[styles.left, left]}>
        <LinearGradient
          colors={[tone, withAlpha(tone, 0)]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
      <Animated.View pointerEvents="none" style={[styles.right, right]}>
        <LinearGradient
          colors={[withAlpha(tone, 0), tone]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flexGrow: 0 },
  left: { position: "absolute", top: 0, bottom: 0, left: 0, width: FADE },
  right: { position: "absolute", top: 0, bottom: 0, right: 0, width: FADE },
});
