import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  FadeIn,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { motion, useTheme } from "@/ui";

/*
 * A thread opened from its message, as on the web: the message stays marked in its conversation while its thread's
 * screen is open, and the mark fades once back. Never a mark on its edge: a bubble is the plate (it goes a step deeper,
 * `ThreadBubbleVeil`), and a row with no bubble takes a soft plate. On the thread's screen, the rows of its first load
 * fade in 35ms apart.
 */

const open = new Map<string, number>();
const listeners = new Set<() => void>();
const changed = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** This thread's screen is on the stack: its message in the conversation under it shows marked. */
export function useMarkThreadOpen(threadId: string | null) {
  useEffect(() => {
    if (!threadId) return;
    open.set(threadId, (open.get(threadId) ?? 0) + 1);
    changed();
    return () => {
      const n = (open.get(threadId) ?? 1) - 1;
      if (n > 0) open.set(threadId, n);
      else open.delete(threadId);
      changed();
    };
  }, [threadId]);
}

/** After its thread's screen closes, the mark stays this long before it fades (the web's 700ms, fade included). */
const LINGER_MS = 520;

/** The open thread's mark, for the bubbles of its row that take it (`ThreadBubbleVeil`). */
const MarkContext = createContext<{ opacity: SharedValue<number>; claim: () => () => void } | null>(null);

/** The root message of a thread, marked while that thread's screen is open. */
export function ThreadRootMark({ threadId, children }: { threadId: string; children: ReactNode }) {
  const { colors: c } = useTheme();
  const shown = useSyncExternalStore(subscribe, () => open.has(threadId));
  const opacity = useSharedValue(shown ? 1 : 0);
  useEffect(() => {
    opacity.set(
      shown ? withTiming(1, { duration: motion.base }) : withDelay(LINGER_MS, withTiming(0, { duration: motion.base })),
    );
  }, [shown, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  // A bubble in the row takes the mark itself: then no plate around the row (no box around the bubble).
  const [bubbles, setBubbles] = useState(0);
  const mark = useMemo(
    () => ({
      opacity,
      claim: () => {
        setBubbles((n) => n + 1);
        return () => setBubbles((n) => n - 1);
      },
    }),
    [opacity],
  );
  return (
    <MarkContext.Provider value={mark}>
      <View>
        {bubbles === 0 ? (
          <Animated.View pointerEvents="none" style={[styles.mark, { backgroundColor: c.plateSoft }, style]} />
        ) : null}
        {children}
      </View>
    </MarkContext.Provider>
  );
}

/** How much ink a marked bubble takes over its own color: a step deeper, the web's 7%. */
const VEIL = 0.07;

/**
 * The first child of a bubble in a thread's root row (under its words): the bubble goes a step deeper while the thread
 * is open, whatever its color, in place of a plate around the row. `corners`: the bubble's own radii. Outside a
 * thread's root row, nothing.
 */
export function ThreadBubbleVeil({ corners }: { corners: ViewStyle }) {
  const mark = useContext(MarkContext);
  const { colors: c } = useTheme();
  useLayoutEffect(() => mark?.claim(), [mark]);
  const opacity = mark?.opacity;
  const style = useAnimatedStyle(() => ({ opacity: opacity ? opacity.get() * VEIL : 0 }));
  if (!mark) return null;
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, corners, { backgroundColor: c.ink }, style]} />
  );
}

/** Rows fade in for this long after a thread's screen opens; the ones of its first load, 35ms apart. */
const LANDING_MS = 1200;
const ROW_STEP_MS = 35;
const ROW_STEPS = 8;
const RowIn = FadeIn.duration(160);

const Landing = createContext<{ at: number; rows: number } | null>(null);

/** Around a thread's screen: its first rows fade in, in turn. */
export function ThreadLanding({ on, children }: { on: boolean; children: ReactNode }) {
  const [value] = useState(() => (on ? { at: Date.now(), rows: 0 } : null));
  return <Landing.Provider value={value}>{children}</Landing.Provider>;
}

/** The entrance of a row mounting while its thread's screen lands, else none. Decided once, as the row mounts. */
export function useLandingEntrance(reduced: boolean) {
  const landing = useContext(Landing);
  const [entering] = useState(() => {
    if (!landing || reduced || Date.now() - landing.at > LANDING_MS) return undefined;
    const step = Math.min(landing.rows++, ROW_STEPS);
    return RowIn.delay(step * ROW_STEP_MS);
  });
  return entering;
}

const styles = StyleSheet.create({
  mark: { ...StyleSheet.absoluteFill, borderRadius: 14 },
});
