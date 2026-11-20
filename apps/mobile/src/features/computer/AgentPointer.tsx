import {
  AGENT_ARROW,
  type CountedPointer,
  CURSOR_IDLE_MS,
  CURSOR_REST_OPACITY,
  type CursorSpot,
  desktopPointerOf,
  glideMs,
  glidePoint,
  glideStart,
  nextPointer,
  pointerInView,
} from "@agenteschat/client";
import { useSeat } from "@agenteschat/client/lib/seat-context";
import { gradientOf } from "@agenteschat/ui/agent/engine";
import { memo, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import Svg, { G, Rect } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";
import { Text, useReducedMotion } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useConnection } from "../shared/hooks";
import { type PointerBox, pointerStep } from "./agent-pointer";

/** A site is a light page in both themes, so the arrow's edge and the name's tag are light on it too. */
const PAPER = "#ffffff";
const INK = "#111111";
const SHADOW = "#0a1428";
/** Points per arrow pixel, and the hard shadow's offset in pixels (the web's 1.5 px). */
const CELL = 2;
const DROP = 0.75;
const ARROW_CELLS = AGENT_ARROW.flatMap((row, y) =>
  [...row].flatMap((c, x) => (c === "." ? [] : [{ x, y, edge: c === "X" }])),
);
const RING = 30;
const RING_MS = 500;
const FADE_MS = 600;

/**
 * Where the agent's pointer last went on its desktop (ADR 0062): the server sends it to whoever has the screen open,
 * and its last one as the screen's stream opens, before the picture shows, so this listens from the start. `n`
 * counts its gestures.
 */
function useDesktopPointer(agentId: string): CountedPointer | null {
  const connection = useConnection();
  const shared = useSeat(agentId) !== undefined;
  const [pointer, setPointer] = useState<CountedPointer | null>(null);
  useEffect(() => {
    setPointer(null);
    if (!connection) return;
    return connection.onUserEvent((event) => {
      const to = desktopPointerOf(event, agentId, shared);
      if (to) setPointer((was) => nextPointer(was, to));
    });
  }, [connection, agentId, shared]);
  return pointer;
}

/** A ring around the point a click landed on, `k` of the way out: it grows and fades, gone at 1. */
function ringLook(k: number, at: CursorSpot) {
  "worklet";
  return {
    opacity: k >= 1 ? 0 : 1 - k,
    transform: [{ translateX: at.x }, { translateY: at.y }, { scale: 0.35 + k }],
  };
}

/** The pixel arrow and its hard shadow, the same between gestures. */
const Arrow = memo(function Arrow({ deep }: { deep: string }) {
  return (
    <Svg width={(8 + DROP) * CELL} height={(12 + DROP) * CELL} viewBox={`0 0 ${8 + DROP} ${12 + DROP}`}>
      <G opacity={0.38}>
        {ARROW_CELLS.map((c) => (
          <Rect key={`s${c.x}-${c.y}`} x={c.x + DROP} y={c.y + DROP} width={1.02} height={1.02} fill={SHADOW} />
        ))}
      </G>
      {ARROW_CELLS.map((c) => (
        <Rect key={`${c.x}-${c.y}`} x={c.x} y={c.y} width={1.02} height={1.02} fill={c.edge ? PAPER : deep} />
      ))}
    </Svg>
  );
});

type PointerProps = {
  agentId: string;
  name: string;
  color: string | undefined;
  view: Readonly<SharedValue<PointerBox>>;
};

/**
 * The agent's cursor over the picture of its page or its desktop (ADR 0040 §7.2), as the web's `AgentCursor`: the
 * pixel arrow in the agent's deep color with its face and name, gliding on an arc to each point its computer says as
 * the gesture starts, a ring on a click (two on a double), only the face while it types, dimmed where it rests after a
 * quiet while.
 * `view` is how the box shows the picture (a desktop's camera, which a pinch or a pan moves, or a letterboxed page),
 * so the arrow follows the picture at its own fixed size. Null `pointer` draws nothing. Decoration: never touched,
 * skipped by screen readers, the steps under the picture already say what the agent does.
 */
export const AgentPointer = memo(function AgentPointer({
  agentId,
  name,
  color,
  pointer,
  view,
}: PointerProps & { pointer: CountedPointer | null }) {
  const reduced = useReducedMotion();
  const from = useSharedValue<CursorSpot>({ x: 0, y: 0 });
  const to = useSharedValue<CursorSpot>({ x: 0, y: 0 });
  const t = useSharedValue(1);
  const ratio = useSharedValue(1);
  const seen = useSharedValue(0);
  const squash = useSharedValue(1);
  // Each ring's way out, 0 to 1 (at rest: gone).
  const ringA = useSharedValue(1);
  const ringB = useSharedValue(1);
  const placed = useRef(false);
  const [look, setLook] = useState({ quiet: false, flip: false, lift: false });
  const latest = useRef(pointer);
  latest.current = pointer;

  // A view's last pointer comes with its first picture, before the box is laid out: the name's side and height are
  // worked out again for each size the box takes, as a resting pointer stays until the next gesture.
  const relook = () => {
    const p = latest.current;
    if (!p) return;
    const { flip, lift } = pointerStep(p, view.value, Date.now());
    setLook((l) => (l.flip === flip && l.lift === lift ? l : { ...l, flip, lift }));
  };
  useAnimatedReaction(
    () => ({ w: view.value.boxWidth, h: view.value.boxHeight }),
    (box, was) => {
      if (was && box.w === was.w && box.h === was.h) return;
      scheduleOnRN(relook);
    },
  );

  const share = useDerivedValue(() => glidePoint(from.value, to.value, t.value, ratio.value));
  const cursor = useAnimatedStyle(() => {
    const at = pointerInView(share.value, view.value);
    return { opacity: seen.value, transform: [{ translateX: at.x }, { translateY: at.y }] };
  });
  const arrow = useAnimatedStyle(() => ({ transform: [{ scale: squash.value }] }));
  const ring0 = useAnimatedStyle(() => ringLook(ringA.value, pointerInView(to.value, view.value)));
  const ring1 = useAnimatedStyle(() => ringLook(ringB.value, pointerInView(to.value, view.value)));

  // biome-ignore lint/correctness/useExhaustiveDependencies: one run per gesture (`n`), reading the newest point.
  useEffect(() => {
    if (!pointer) {
      // Shown again later, it comes in from a little off its next point, as on its first gesture.
      placed.current = false;
      seen.value = 0;
      return;
    }
    const step = pointerStep(pointer, view.value, Date.now());
    const shape = pointer.height / pointer.width;
    if (step.rest) {
      placed.current = true;
      ratio.value = shape;
      from.value = step.to;
      to.value = step.to;
      t.value = 1;
      setLook({ quiet: step.quiet, flip: step.flip, lift: step.lift });
      seen.value = CURSOR_REST_OPACITY;
      return;
    }
    const start = glideStart(placed.current ? glidePoint(from.value, to.value, t.value, ratio.value) : null, step.to);
    const timers: ReturnType<typeof setTimeout>[] = [];
    ratio.value = shape;
    setLook({ quiet: false, flip: step.flip, lift: step.lift });
    const fadeIn = placed.current && !reduced;
    placed.current = true;
    const arrived = () => {
      if (step.presses > 0 && !reduced) {
        squash.value = withSequence(withTiming(0.84, { duration: 90 }), withDelay(50, withTiming(1, { duration: 90 })));
        const ring = (k: SharedValue<number>, delay: number) => {
          k.value = withDelay(
            delay,
            withSequence(
              withTiming(0, { duration: 0 }),
              withTiming(1, { duration: RING_MS, easing: Easing.steps(5, false) }),
            ),
          );
        };
        ring(ringA, 0);
        if (step.presses === 2) ring(ringB, 150);
      }
      if (step.quiet) setLook((l) => ({ ...l, quiet: true }));
      timers.push(
        setTimeout(() => {
          seen.value = reduced ? CURSOR_REST_OPACITY : withTiming(CURSOR_REST_OPACITY, { duration: FADE_MS });
        }, CURSOR_IDLE_MS),
      );
    };
    if (reduced) {
      from.value = step.to;
      to.value = step.to;
      t.value = 1;
      arrived();
    } else {
      from.value = start;
      t.value = 0;
      to.value = step.to;
      const ms = glideMs(Math.hypot(step.to.x - start.x, (step.to.y - start.y) * shape));
      t.value = withTiming(1, { duration: ms, easing: Easing.linear });
      timers.push(setTimeout(arrived, ms));
    }
    seen.value = fadeIn ? withTiming(1, { duration: FADE_MS }) : 1;
    return () => {
      for (const id of timers) clearTimeout(id);
    };
  }, [pointer?.n, reduced]);

  if (!pointer) return null;
  const [, deep] = gradientOf(color);
  return (
    <View
      pointerEvents="none"
      style={styles.layer}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View style={[styles.ring, { borderColor: deep }, ring0]} />
      <Animated.View style={[styles.ring, { borderColor: deep }, ring1]} />
      <Animated.View style={[styles.cursor, cursor]}>
        <Animated.View style={[styles.arrow, arrow]}>
          <Arrow deep={deep} />
        </Animated.View>
        <View style={[styles.who, whoAt(look.flip, look.lift)]}>
          <AgentFace agentId={agentId} size={18} live={false} />
          {look.quiet ? null : (
            <Text variant="caption" numberOfLines={1} style={styles.name}>
              {name}
            </Text>
          )}
        </View>
      </Animated.View>
    </View>
  );
});

/**
 * The agent's cursor over its desktop, listening for its gestures itself: each one re-renders only this. Drawn while
 * the view shows that screen live (`enabled`).
 */
export function DesktopAgentPointer({ enabled, ...props }: PointerProps & { enabled: boolean }) {
  const pointer = useDesktopPointer(props.agentId);
  return <AgentPointer {...props} pointer={enabled ? pointer : null} />;
}

/** The tag turned left past the box's right side, lifted over the arrow near its bottom (`pointerStep`). */
function whoAt(flip: boolean, lift: boolean) {
  if (!flip && !lift) return null;
  return [
    flip ? styles.whoFlip : null,
    lift ? (flip ? styles.whoLiftFlip : styles.whoLift) : null,
    { transform: [{ translateX: flip ? "-100%" : 0 }, { translateY: lift ? "-100%" : 0 }] },
  ];
}

const styles = StyleSheet.create({
  layer: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0, overflow: "hidden" },
  // As large as the box, its top left corner on the tip: the tag lays out against that room, never against none.
  cursor: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0 },
  arrow: { position: "absolute", left: 0, top: 0, transformOrigin: "left top" },
  ring: {
    position: "absolute",
    left: -RING / 2,
    top: -RING / 2,
    width: RING,
    height: RING,
    borderWidth: 2,
    opacity: 0,
  },
  who: {
    position: "absolute",
    left: 11,
    top: 21,
    flexDirection: "row",
    alignItems: "center",
    minHeight: 24,
    padding: 3,
    borderRadius: 9,
    borderTopLeftRadius: 3,
    backgroundColor: PAPER,
    boxShadow: "0px 0px 0px 1px rgba(20, 20, 20, 0.16), 1.5px 1.5px 0px 1px rgba(10, 20, 40, 0.38)",
  },
  // Its right edge 4 pt left of the tip, at any width of the name.
  whoFlip: { left: -4, borderTopLeftRadius: 9, borderTopRightRadius: 3 },
  // Its bottom edge 4 pt above the tip, the arrow under it.
  whoLift: { top: -4, borderTopLeftRadius: 9, borderBottomLeftRadius: 3 },
  whoLiftFlip: { top: -4, borderTopRightRadius: 9, borderBottomRightRadius: 3 },
  name: { maxWidth: 120, paddingHorizontal: 6, color: INK, fontWeight: "600" },
});
