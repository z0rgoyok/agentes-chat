import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { memo, type ReactNode, useEffect, useState } from "react";
import { type LayoutChangeEvent, Platform, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  type EntryExitAnimationFunction,
  LayoutAnimationConfig,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { LivePause } from "@/agent/live";
import { needsHeaderBlur } from "@/lib/nav";
import { Dither } from "@/sky/Dither";
import { softTones } from "@/sky/math";
import { Glass, haptics, motion, PressScale, Text, useReducedMotion, useTheme } from "@/ui";
import { usePane } from "@/ui/pane";
import { panePillRoom, pillRoom } from "./pill-room";

/** iOS 26's bar, whose buttons are the system's glass ones; elsewhere our own 44-point buttons side by side. */
const LIQUID = Platform.OS === "ios" && !needsHeaderBlur(Platform.OS, Platform.Version);
/** The pill's own padding, the face's box and the gaps: the face sits in the capsule's curve. */
const PAD_LEFT = 6;
const PAD_RIGHT = 16;
const LEAD = 32;
const GAP = 9;
const TRAILING_GAP = 2;
const HEIGHT = 44;
const BORDER = StyleSheet.hairlineWidth;
const MIN_WIDTH = 120;
/*
 * No finger drives any of these, so they are timed, not sprung (springs carry a finger's velocity; there is none):
 * the width morphs on screen (ease-in-out), a line enters and leaves (ease-out), the sky turns on and off (ease-in-out).
 */
const WIDTH = { duration: 260, easing: motion.easeInOut };
const LINE_IN = { duration: 220, easing: motion.easeOut };
const LINE_OUT = { duration: 140, easing: motion.easeOut };
const SKY = { duration: 400, easing: motion.easeInOut };
/** How far a line rolls in and out. */
const ROLL = 15;

const rollIn: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ translateY: ROLL }] },
    animations: {
      opacity: withTiming(1, LINE_IN),
      transform: [{ translateY: withTiming(0, LINE_IN) }],
    },
  };
};

const rollOut: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ translateY: 0 }] },
    animations: {
      opacity: withTiming(0, LINE_OUT),
      transform: [{ translateY: withTiming(-ROLL, LINE_OUT) }],
    },
  };
};

/**
 * The conversation's title as a glass pill in the header: who or where on the left, the name and a quiet line
 * under it. It moves instead of jumping: a new line rolls in over the old one, the width follows the words and an
 * agent's sky turns into the pixel sweep that crosses the pill while it works (the sidebar's trail).
 * In a DM the face wears its presence badge and the quiet line says how the other side is: an agent's presence
 * and line, a person's status (ADR 0084). A channel shows who is in on the right. Held (`onHold`), it opens the
 * conversation switcher.
 *
 * The bar lays its title out once: the slot keeps the width of the room beside the buttons, and only the pill
 * inside it changes, on the UI thread, so the native bar never lays out again while it moves.
 *
 * Reading up the conversation (`collapsed`), the pill closes to its lead alone, a glass circle: the screen is only
 * messages. While an agent works its quiet line says each step, many a minute: the pill then holds the room's width
 * (any step fits, cut with "…"), so a step only rolls its line in and never springs the width, and the line never
 * slides to show its end; only a new title or closing moves the width. The sky sweeps meanwhile.
 *
 * Memoized: the bar draws it outside the screen, and a screen that redraws often (a conversation while agents work)
 * hands it the same props most of the time.
 */
export const HeaderPill = memo(function HeaderPill({
  lead,
  title,
  subtitle,
  color,
  working = false,
  trailing,
  onPress,
  label,
  extraActions = 0,
  leadRoom = 0,
  onHold,
  holdHint,
  collapsed = false,
  inView = true,
}: {
  lead?: ReactNode;
  title: string;
  subtitle?: string | undefined;
  /** An agent's color: its sky lives in the pill. */
  color?: AgentColorName | undefined;
  working?: boolean;
  /** Only the lead, in a circle (reading far up the conversation); the words fade and come back with the width. */
  collapsed?: boolean;
  /** Faces of who is in (channels). */
  trailing?: ReactNode;
  onPress?: () => void;
  /** What a screen reader says (name, state and what a tap does). */
  label: string;
  /** The system's bar buttons beside "…" (an agent's computer, search): the pill makes room for each (`pillRoom`). */
  extraActions?: number;
  /** The width of our own counted views first in the buttons' group (an agent's tasks, a computer's line), measured. */
  leadRoom?: number;
  onHold?: () => void;
  /** What a screen reader says the hold does. */
  holdHint?: string;
  /**
   * Whether its screen shows: the bar draws the pill outside the screen's own pause (`FocusLive`), so its sky stops
   * here while a screen is pushed over the conversation.
   */
  inView?: boolean;
}) {
  const { colors, shadows } = useTheme();
  const reduced = useReducedMotion();
  const { width: screen } = useWindowDimensions();
  // In a pane (ADR 0212) the bar is the pane's: as wide as the pane, with no back button.
  const pane = usePane();
  const room = pane
    ? panePillRoom(pane.width, extraActions, leadRoom)
    : pillRoom(screen, extraActions, leadRoom, LIQUID);

  const [nameWidth, setNameWidth] = useState<number | null>(null);
  const [lineWidth, setLineWidth] = useState(0);
  const [trailingWidth, setTrailingWidth] = useState(0);
  // The hairline border is inside the pill's width too: without it a name sized to fit loses its last letters to "…".
  const chrome =
    PAD_LEFT + PAD_RIGHT + 2 * BORDER + (lead ? LEAD + GAP : 0) + (trailing ? trailingWidth + GAP + TRAILING_GAP : 0);
  const words = Math.max(nameWidth ?? 0, subtitle ? lineWidth : 0);
  // Closed, the pill is a circle around its lead (no lead to close around: it stays open).
  const closed = collapsed && Boolean(lead);
  // While an agent works, the room's width whatever its step says: the steps never move it.
  const target =
    nameWidth === null ? null : closed ? HEIGHT : working ? room : Math.min(room, Math.max(MIN_WIDTH, chrome + words));

  // -1 until the words are measured: the first width is set, not sprung.
  const pillWidth = useSharedValue(-1);
  const work = useSharedValue(working ? 1 : 0);
  // The words' presence: they fade before the width closes on them and come back as it opens.
  const open = useSharedValue(closed ? 0 : 1);
  useEffect(() => {
    if (target === null) return;
    pillWidth.value = reduced || pillWidth.value < 0 ? target : withTiming(target, WIDTH);
  }, [target, reduced, pillWidth]);
  useEffect(() => {
    work.value = reduced ? (working ? 1 : 0) : withTiming(working ? 1 : 0, SKY);
  }, [working, reduced, work]);
  useEffect(() => {
    open.value = withTiming(closed ? 0 : 1, { duration: closed ? 120 : 200, easing: motion.easeOut });
  }, [closed, open]);

  const sized = useAnimatedStyle(() => ({
    width: pillWidth.value < 0 ? room : pillWidth.value,
    opacity: pillWidth.value < 0 ? 0 : 1,
  }));
  const wordsShown = useAnimatedStyle(() => ({ opacity: open.value }));

  const measured = (set: (width: number) => void) => (e: LayoutChangeEvent) =>
    set(Math.ceil(e.nativeEvent.layout.width));

  return (
    <View style={[styles.slot, { width: room }, pane && styles.centred]} pointerEvents="box-none">
      {/* What the words measure, whole, with no room limit. */}
      <View
        style={styles.measure}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text variant="callout" numberOfLines={1} style={styles.title} onLayout={measured(setNameWidth)}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" numberOfLines={1} onLayout={measured(setLineWidth)}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <PressScale
        to={0.97}
        onPress={onPress}
        disabled={!onPress && !onHold}
        // One buzz per gesture: a tap gets PressScale's light one (it fires on `onPress`, which a hold never reaches),
        // a hold only its own firmer one.
        {...(onHold
          ? {
              delayLongPress: 300,
              onLongPress: () => {
                haptics.medium();
                onHold();
              },
            }
          : {})}
        accessibilityRole={onPress ? "button" : "header"}
        accessibilityLabel={label}
        accessibilityHint={holdHint}
        style={[
          sized,
          // Android's pill is opaque: a short shadow floats it over the conversation, as the glass does on iOS.
          Platform.OS === "android" && { borderRadius: HEIGHT / 2, boxShadow: shadows.e1 },
        ]}
      >
        {/* The same Liquid Glass as the bar's own buttons beside it (iOS 26); the blur and a hairline before. */}
        <Glass liquid intensity={70} style={[styles.pill, closed && styles.pillClosed, { borderColor: colors.line2 }]}>
          {color ? (
            <LivePause paused={!inView}>
              <Dither
                kind="pill"
                tones={softTones(color, colors.glassSolid)}
                pixel={3}
                clear
                liveWidth={pillWidth}
                liveWork={work}
                style={[styles.sky, { width: room }]}
              />
            </LivePause>
          ) : null}
          {lead ? <View style={styles.lead}>{lead}</View> : null}
          <Animated.View
            style={[styles.text, wordsShown]}
            importantForAccessibility="no-hide-descendants"
            pointerEvents="none"
          >
            <Text variant="callout" numberOfLines={1} style={styles.title}>
              {title}
            </Text>
            {subtitle ? (
              <StatusLine
                text={subtitle}
                natural={lineWidth}
                // Closed, the line is faded out: no sliding to read it.
                box={(closed ? room : (target ?? room)) - chrome}
                reduced={reduced}
                // A step lasts a moment: it rests with "…", never sliding to show its end.
                still={working}
              />
            ) : null}
          </Animated.View>
          {trailing ? (
            <Animated.View style={[styles.trailing, wordsShown]} onLayout={measured(setTrailingWidth)}>
              {trailing}
            </Animated.View>
          ) : null}
        </Glass>
      </PressScale>
    </View>
  );
});

/** The quiet line: each new one rolls in over the last. `still`: it never slides to show its end. */
function StatusLine({
  text,
  natural,
  box,
  reduced,
  still,
}: {
  text: string;
  natural: number;
  box: number;
  reduced: boolean;
  still: boolean;
}) {
  return (
    <View style={styles.lineBox}>
      <LayoutAnimationConfig skipEntering>
        <Animated.View key={text} {...(reduced ? {} : { entering: rollIn, exiting: rollOut })} style={styles.line}>
          <SlidingText text={text} natural={natural} box={box} still={reduced || still} />
        </Animated.View>
      </LayoutAnimationConfig>
    </View>
  );
}

/**
 * A line longer than the pill slides once to its end and back, so all of it gets read; it rests with "…". `still`
 * (reduced motion, an agent's passing step): it only rests.
 */
function SlidingText({ text, natural, box, still }: { text: string; natural: number; box: number; still: boolean }) {
  const x = useSharedValue(0);
  const [free, setFree] = useState(false);
  const over = natural - box;
  const long = over > 1;
  useEffect(() => {
    if (!long || still) return;
    // A marquee is constant motion: linear, so the words read at one pace.
    const ease = Easing.linear;
    const timer = setTimeout(() => {
      setFree(true);
      const out = Math.max(1400, over * 32);
      x.value = withSequence(
        withTiming(-over - 4, { duration: out, easing: ease }),
        withDelay(
          800,
          withTiming(0, { duration: out * 0.6, easing: ease }, (done) => {
            if (done) scheduleOnRN(setFree, false);
          }),
        ),
      );
    }, 1100);
    return () => {
      clearTimeout(timer);
      cancelAnimation(x);
      x.value = 0;
      setFree(false);
    };
  }, [long, over, still, x]);
  const moved = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <Animated.View style={[free && { width: natural + 2 }, moved]}>
      <Text variant="caption" tone="muted" numberOfLines={1}>
        {text}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  slot: { alignItems: Platform.OS === "ios" ? "center" : "flex-start" },
  // In a pane (ADR 0212) the pill stands in the middle of the bar on every platform: there is no back button beside it.
  centred: { alignItems: "center" },
  measure: { position: "absolute", top: 0, left: 0, width: 1000, alignItems: "flex-start", opacity: 0 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: GAP,
    height: HEIGHT,
    paddingLeft: PAD_LEFT,
    paddingRight: PAD_RIGHT,
    borderRadius: HEIGHT / 2,
    borderWidth: BORDER,
    overflow: "hidden",
  },
  // A circle: the lead's box centered in the pill's height (the words, clipped, sit outside it).
  pillClosed: { paddingRight: PAD_LEFT },
  // The drawing keeps the room's width and reads the pill's as a uniform: no canvas resize during a spring.
  sky: { position: "absolute", top: 0, left: 0, height: HEIGHT },
  lead: { alignItems: "center", justifyContent: "center", width: LEAD },
  text: { flex: 1, minWidth: 0 },
  title: { fontWeight: "600", lineHeight: 20 },
  lineBox: { height: 16, overflow: "hidden" },
  line: { position: "absolute", top: 0, left: 0, right: 0 },
  trailing: { flexDirection: "row", alignItems: "center", marginLeft: TRAILING_GAP },
});
