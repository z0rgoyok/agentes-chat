import { type ReactNode, useEffect, useRef } from "react";
import { type LayoutChangeEvent, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { haptics } from "./haptics";
import { Icon } from "./Icon";
import { reorderTarget, shiftOf } from "./reorder";
import { GROUPED_ROW } from "./rhythm";
import { motion, useTheme } from "./theme";

interface Drag {
  from: SharedValue<number>;
  to: SharedValue<number>;
  dy: SharedValue<number>;
  heights: SharedValue<number[]>;
}

/**
 * A list reordered by its handles, as the system's own reorder control: the handle (≡ at the row's end) picks the row
 * up, the others step aside as it passes their middles, and it drops where it is let go (`onMove(from, to)`; the
 * caller shows the new order at once). Rows of any height. Rows with no `handle` stay put and are never passed.
 * Moving up and down by VoiceOver or a menu is the caller's (each row's own actions).
 */
export function ReorderList<T>({
  items,
  keyOf,
  movable,
  canMove,
  onMove,
  disabled = false,
  handleLabel,
  renderItem,
}: {
  items: readonly T[];
  keyOf: (item: T) => string;
  /** The first rows that move; the rest (a skipped account at the end) never do. */
  movable: number;
  /** A row the viewer may move (its own account, or any for an admin); every one when left out. */
  canMove?: (item: T) => boolean;
  onMove: (from: number, to: number) => void;
  disabled?: boolean;
  /** What VoiceOver says the handle is for that row ("Mover Trabalho"). */
  handleLabel: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
}) {
  const drag: Drag = {
    from: useSharedValue(-1),
    to: useSharedValue(-1),
    dy: useSharedValue(0),
    heights: useSharedValue<number[]>([]),
  };
  // A new order is drawn where the rows now are: nothing stays shifted from the drag that made it.
  const order = items.map(keyOf).join("\n");
  const shown = useRef(order);
  shown.current = order;
  const reset = () => {
    drag.from.set(-1);
    drag.to.set(-1);
    drag.dy.set(0);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a new order only
  useEffect(reset, [order]);
  const move = (from: number, to: number) => {
    if (from === to) return reset();
    const before = order;
    onMove(from, to);
    // A drop the caller didn't take (the order stays): the row goes back to its place.
    setTimeout(() => {
      if (shown.current === before) reset();
    }, 300);
  };
  return (
    <View>
      {items.map((item, i) => (
        <ReorderRow
          key={keyOf(item)}
          index={i}
          drag={drag}
          count={movable}
          handle={i < movable && movable > 1 && (canMove?.(item) ?? true)}
          disabled={disabled}
          label={handleLabel(item)}
          onDrop={move}
          divider={i > 0}
        >
          {renderItem(item, i)}
        </ReorderRow>
      ))}
    </View>
  );
}

function ReorderRow({
  index,
  drag,
  count,
  handle,
  disabled,
  label,
  onDrop,
  divider,
  children,
}: {
  index: number;
  drag: Drag;
  count: number;
  handle: boolean;
  disabled: boolean;
  label: string;
  onDrop: (from: number, to: number) => void;
  /** The hairline above it, as a grouped list's rows have, from where the words start. */
  divider: boolean;
  children: ReactNode;
}) {
  const { colors, shadows } = useTheme();
  const onLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    drag.heights.modify((all) => {
      "worklet";
      all[index] = h;
      return all;
    });
  };
  const pan = Gesture.Pan()
    .enabled(handle && !disabled)
    .minDistance(0)
    .onStart(() => {
      drag.from.set(index);
      drag.to.set(index);
      scheduleOnRN(haptics.selection);
    })
    .onUpdate((e) => {
      const heights = drag.heights.get().slice(0, count);
      drag.dy.set(e.translationY);
      const to = reorderTarget(heights, index, e.translationY);
      if (to !== drag.to.get()) {
        drag.to.set(to);
        scheduleOnRN(haptics.selection);
      }
    })
    .onFinalize(() => {
      if (drag.from.get() !== index) return;
      const to = drag.to.get();
      const heights = drag.heights.get();
      // Settles in its new place before the list redraws in the new order there.
      let at = 0;
      for (let i = Math.min(index, to); i < Math.max(index, to); i++) at += heights[i + (to > index ? 1 : 0)] ?? 0;
      drag.dy.set(withTiming(to > index ? at : -at, { duration: 120 }, () => scheduleOnRN(onDrop, index, to)));
    });
  const style = useAnimatedStyle(() => {
    const from = drag.from.get();
    const held = from === index;
    const shift = shiftOf(index, from, drag.to.get(), drag.heights.get()[from] ?? 0);
    return {
      zIndex: held ? 2 : 0,
      transform: [{ translateY: held ? drag.dy.get() : withSpring(shift, motion.sheet) }],
      boxShadow: held ? shadows.e2 : "none",
    };
  });
  return (
    <Animated.View onLayout={onLayout} style={[style, { backgroundColor: colors.raised }]}>
      {divider ? <View style={[styles.divider, { backgroundColor: colors.separator }]} /> : null}
      <View style={styles.row}>
        <View style={styles.grow}>{children}</View>
        {handle ? (
          <GestureDetector gesture={pan}>
            <View
              style={styles.handle}
              accessible
              accessibilityLabel={label}
              accessibilityState={{ disabled }}
              hitSlop={8}
            >
              <Icon name="grip" size={20} color={colors.faint} />
            </View>
          </GestureDetector>
        ) : null}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  // A row with a leading column (its number): the hairline starts at the words, as `GroupedList` draws it.
  divider: { height: StyleSheet.hairlineWidth, marginLeft: GROUPED_ROW.padX + GROUPED_ROW.lead + 12 },
  grow: { flex: 1, minWidth: 0 },
  // The system's reorder control: a 44-point column at the row's end.
  handle: { width: 44, alignSelf: "stretch", alignItems: "center", justifyContent: "center" },
});
