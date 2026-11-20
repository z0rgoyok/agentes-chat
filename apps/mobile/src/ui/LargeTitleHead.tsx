import { useCallback } from "react";
import { type ScrollEvent, StyleSheet } from "react-native";
import Animated, {
  FadeIn,
  FadeOutUp,
  LayoutAnimationConfig,
  type SharedValue,
  useAnimatedRef,
} from "react-native-reanimated";
import { useCoverScroll, useScrollFade } from "./cover";
import { SCREEN_X } from "./rhythm";
import { Text } from "./Text";
import { motion } from "./theme";
import { TITLE_GONE, titleSnap } from "./title-snap";

/** The title coming back after a search fades in; folding away for one, it leaves upward, a little faster. */
const TITLE_IN = FadeIn.duration(motion.base).easing(motion.easeOut);
const TITLE_OUT = FadeOutUp.duration(motion.fast).easing(motion.easeOut);

/**
 * The scroll of a screen with a large title (`LargeTitleScreen`, `PushedLargeTitle`): `y` from rest (`useCoverScroll`;
 * `rest` is the header height where iOS insets the list by the bar, else 0), and a scroll that comes to rest with the
 * title half faded goes on to the nearer of the title whole and the title gone (`titleSnap`). The scroll view takes
 * `ref`, `onScroll` and the two end handlers.
 *
 * The scroll view's own `snapToOffsets` can't do it: a fling that starts above its last offset stops there instead of
 * running down the list, and iOS clamps its targets at 0 while these lists rest at minus the bar's height. So the snap
 * runs once the scroll has stopped, as the system's large titles settle after the finger lifts.
 */
export function useLargeTitleScroll(rest: number, { snap = true }: { snap?: boolean } = {}) {
  const { y, onScroll } = useCoverScroll(rest);
  // An animated ref: the screen can also read the list's own scroll events on the UI thread (`LargeTitleScreen`'s
  // `pastEnd`).
  const ref = useAnimatedRef<Animated.ScrollView>();
  const settle = useCallback(
    (e: ScrollEvent) => {
      if (!snap) return;
      const { contentOffset, contentSize, contentInset, layoutMeasurement } = e.nativeEvent;
      const end = contentSize.height + (contentInset?.bottom ?? 0) - layoutMeasurement.height + rest;
      const to = titleSnap(contentOffset.y + rest, end);
      if (to !== null) ref.current?.scrollTo({ y: to - rest, animated: true });
    },
    [rest, snap, ref],
  );
  // iOS says where a released scroll will stop: one that won't glide on (no momentum event follows) settles at once.
  // Android follows every release with the end of its momentum.
  const onScrollEndDrag = useCallback(
    (e: ScrollEvent) => {
      const target = e.nativeEvent.targetContentOffset;
      if (target && Math.abs(target.y - e.nativeEvent.contentOffset.y) < 1) settle(e);
    },
    [settle],
  );
  return { y, onScroll, ref, onScrollEndDrag, onMomentumScrollEnd: settle };
}

/**
 * The large title at the top of the content, in Funnel Display at the screen's sides (and a line under it): it fades as
 * it scrolls under the bar. It shows at once when the screen opens; folded away (`collapsed`: a search field under it
 * took the focus) it leaves, and fades back when the search ends. `tight`: content of the screen's own follows close
 * under it (Conversas' greeting).
 */
export function LargeTitleHead({
  y,
  title,
  subtitle,
  collapsed = false,
  tight = false,
}: {
  y: SharedValue<number>;
  title: string;
  subtitle?: string | undefined;
  collapsed?: boolean;
  tight?: boolean;
}) {
  const fade = useScrollFade(y, 0, TITLE_GONE);
  return (
    <LayoutAnimationConfig skipEntering>
      {collapsed ? null : (
        <Animated.View entering={TITLE_IN} exiting={TITLE_OUT}>
          <Animated.View style={[styles.head, tight ? styles.tight : null, fade]}>
            <Text variant="display" accessibilityRole="header" numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text variant="small" tone="muted" style={styles.subtitle}>
                {subtitle}
              </Text>
            ) : null}
          </Animated.View>
        </Animated.View>
      )}
    </LayoutAnimationConfig>
  );
}

const styles = StyleSheet.create({
  // At the screen's sides (SCREEN_X), as the lists and cards under it.
  head: { paddingHorizontal: SCREEN_X, paddingTop: 2, paddingBottom: 10 },
  tight: { paddingBottom: 4 },
  subtitle: { marginTop: 2 },
});
