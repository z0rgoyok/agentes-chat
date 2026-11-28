import { type ReactNode, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useLivePaused } from "@/agent/live";
import { useDrawingClock } from "@/sky/clock";
import { LIST_AVATAR } from "./ListRow";
import { SCREEN_X } from "./rhythm";
import { useReducedMotion, useTheme } from "./theme";

/**
 * The shape of a list while it loads: rows with the avatar's square and two bars where the name and the preview
 * go, pulsing softly together. A list that loads this way changes nothing when the data lands (the rows are the
 * same height), where a spinner or the word "Loading" left a blank page. With reduced motion the bars stay still.
 */
export function SkeletonRow({ name = 42, preview = 80 }: { name?: number; preview?: number }) {
  const { colors } = useTheme();
  const pulse = usePulse();
  const bone = { backgroundColor: colors.plate };
  return (
    <Animated.View
      style={[styles.row, pulse]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={[styles.avatar, bone]} />
      <View style={styles.tx}>
        <View style={[styles.line, styles.name, bone, { width: `${name}%` }]} />
        <View style={[styles.line, styles.preview, bone, { width: `${preview}%` }]} />
      </View>
    </Animated.View>
  );
}

/** A few rows of a list, as `SkeletonRow`, each a little different so it reads as a list and not a pattern. */
export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <View>
      {SHAPES.slice(0, rows).map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed shapes, never reordered
        <SkeletonRow key={i} name={s[0]} preview={s[1]} />
      ))}
    </View>
  );
}

/** How long the stand-in rows take to fade away once the real ones are in. */
const SKELETON_OUT = 220;

/**
 * A list's first load, so its rows can arrive over the stand-ins instead of replacing them at once. `skeleton`: the
 * stand-ins still show (loading, or fading away over the rows); `landing`: the data just came, for as long as the
 * stand-ins fade, which is when the rows mounting play their arrival. A refetch never loads again, so it plays
 * nothing; a screen that opens with its data, or a phone asked for less motion, has no arrival at all.
 */
export function useFirstLoad(loading: boolean): { skeleton: boolean; landing: boolean } {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<"loading" | "landing" | "done">(loading ? "loading" : "done");
  // Told while rendering, so the rows' very first render already knows they arrive.
  let now = phase;
  if (loading) now = "loading";
  else if (phase === "loading") now = reduced ? "done" : "landing";
  if (now !== phase) setPhase(now);
  useEffect(() => {
    if (phase !== "landing") return;
    const timer = setTimeout(() => setPhase("done"), SKELETON_OUT);
    return () => clearTimeout(timer);
  }, [phase]);
  return { skeleton: now !== "done", landing: now === "landing" };
}

/**
 * The stand-ins of a list around its first load: in the list's place while it loads, then (`leaving`) lifted over
 * the rows that took that place and faded away, so the rows come in under them and nothing is swapped. Put it first
 * in the box that holds the rows, and take it out when `useFirstLoad` says the stand-ins are gone.
 */
export function SkeletonOver({ leaving, children }: { leaving: boolean; children: ReactNode }) {
  const k = useSharedValue(1);
  useEffect(() => {
    if (leaving) k.set(withTiming(0, { duration: SKELETON_OUT }));
  }, [k, leaving]);
  const look = useAnimatedStyle(() => ({ opacity: k.get() }));
  return (
    <Animated.View
      pointerEvents={leaving ? "none" : "auto"}
      style={[leaving && styles.over, look]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {children}
    </Animated.View>
  );
}

/** A kept list shows it is loading after this long: a quick switch never blinks. As the web's skeletons wait. */
const REFRESH_DELAY_MS = 150;

/**
 * A list kept on screen while its next tab or filter loads (`busy`: the query's `isPlaceholderData`): after 150 ms
 * what it held dims and a thin bar pulses along its top, so the switch answers at once and nothing moves when the rows
 * land. Every tabbed or filtered list loads this way, as on the web; its first load is `SkeletonList`.
 */
export function Refreshing({ busy, label, children }: { busy: boolean; label: string; children: ReactNode }) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!busy) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), REFRESH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [busy]);
  const dim = useSharedValue(1);
  useEffect(() => {
    const to = shown ? 0.5 : 1;
    dim.set(reduced ? to : withTiming(to, { duration: 150 }));
  }, [dim, shown, reduced]);
  const look = useAnimatedStyle(() => ({ opacity: dim.get() }));
  return (
    <View accessibilityState={{ busy }}>
      <Animated.View style={look}>{children}</Animated.View>
      {shown ? <RefreshBar color={colors.ink} label={label} /> : null}
    </View>
  );
}

function RefreshBar({ color, label }: { color: string; label: string }) {
  const pulse = usePulse();
  return (
    <Animated.View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      style={[styles.bar, { backgroundColor: color }, pulse]}
    />
  );
}

/** Row shapes: the name's and the preview's widths, in percent of the text column. */
const SHAPES: [number, number][] = [
  [42, 80],
  [55, 70],
  [38, 86],
  [60, 64],
  [48, 75],
  [34, 78],
];

/** Half a pulse: down to its low in this long, back up in as long. */
const PULSE_HALF_MS = 700;
const PULSE_EASE = Easing.inOut(Easing.quad);

/**
 * The soft pulse every bone shares: 1 → 0.55 → 1 over 1.4 s, still with reduced motion. Off screen (`LivePause`) its
 * time stops where it was, and it carries on from there when it shows again.
 */
export function usePulse() {
  const reduced = useReducedMotion();
  const paused = useLivePaused();
  const clock = useDrawingClock(!reduced && !paused);
  return useAnimatedStyle(() => {
    if (reduced) return { opacity: 0.8 };
    const at = clock.get() % (2 * PULSE_HALF_MS);
    const down = at < PULSE_HALF_MS;
    const e = PULSE_EASE((down ? at : at - PULSE_HALF_MS) / PULSE_HALF_MS);
    return { opacity: down ? 1 - 0.45 * e : 0.55 + 0.45 * e };
  });
}

const styles = StyleSheet.create({
  // Over the rows, from the top of their box: the stand-ins take no room while they fade.
  over: { position: "absolute", top: 0, left: 0, right: 0 },
  // Over the kept list's top edge, taking no room: the list doesn't move when it comes or goes.
  bar: { position: "absolute", top: 0, left: SCREEN_X, right: SCREEN_X, height: 2, borderRadius: 1 },
  // The same box as `ListRow`: 16 at the sides, the 52 avatar, 12 to the text, 76 tall.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    minHeight: 76,
  },
  avatar: { width: LIST_AVATAR, height: LIST_AVATAR, borderRadius: Math.round(LIST_AVATAR * 0.3) },
  tx: { flex: 1, minWidth: 0, gap: 8 },
  line: { borderRadius: 6 },
  // Where the 17-point name and the 15-point preview sit.
  name: { height: 14 },
  preview: { height: 12 },
});
