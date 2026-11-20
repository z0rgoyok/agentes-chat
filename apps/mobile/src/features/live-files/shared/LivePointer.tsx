import {
  AGENT_ARROW,
  CURSOR_IDLE_MS,
  CURSOR_REST_OPACITY,
  type CursorSpot,
  glideMs,
  glidePoint,
  type PointerView,
  pointerInView,
} from "@agenteschat/client";
import { readableOn } from "@agenteschat/live";
import type { PeerUser } from "@agenteschat/live/awareness";
import { memo, useEffect, useRef } from "react";
import { Text as RNText, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, {
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { G, Path, Rect } from "react-native-svg";
import { motion, useReducedMotion } from "@/ui";
import { AgentFace } from "../../shared/Face";

/**
 * Someone's pointer in a live file (ADR 0196 §5), over a canvas or a slide: generalized from the agent's cursor on its
 * computer (`AgentPointer`, ADR 0040 §7.2). A person's is a classic arrow in their color with their name on a tag of
 * that color; an agent's is its pixel arrow in its deep tone with its face and name on a light tag. It glides to each
 * new point on a slight arc, rests dimmed after a quiet while, and its name fades out until it moves again; with
 * reduced motion it jumps. Decoration only: never touched, skipped by screen readers (the faces' list says who is
 * here).
 *
 * `at` is in the screen's own units (canvas world or slide units); `view` maps them to the box, a shared value the
 * screen's camera keeps: `{ s: zoom, x, y: the unit point at the box's top left, width: 1, height: 1 }`.
 */
export interface LivePointerProps {
  user: PeerUser;
  name: string;
  /** Their color: a person's `peerColor`, an agent's deep tone (`peerTint`). */
  tint: string;
  /** Where the pointer is now; null hides it. */
  at: CursorSpot | null;
  view: Readonly<SharedValue<PointerView>>;
}

/** After this long without moving, the name fades away until the pointer moves again. */
const TAG_IDLE_MS = 3000;
const FADE_MS = 600;
const PAPER = "#ffffff";
const INK = "#111111";
const SHADOW = "#0a1428";
/** Points per pixel of an agent's arrow, and its hard shadow's offset in pixels. */
const CELL = 2;
const DROP = 0.75;
const PIXELS = AGENT_ARROW.flatMap((row, y) =>
  [...row].flatMap((c, x) => (c === "." ? [] : [{ x, y, edge: c === "X" }])),
);

export const LivePointer = memo(function LivePointer({ user, name, tint, at, view }: LivePointerProps) {
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  const from = useSharedValue<CursorSpot>(at ?? { x: 0, y: 0 });
  const to = useSharedValue<CursorSpot>(at ?? { x: 0, y: 0 });
  const t = useSharedValue(1);
  const seen = useSharedValue(0);
  const named = useSharedValue(1);
  const placed = useRef(false);

  const point = useDerivedValue(() => glidePoint(from.value, to.value, t.value, 1));
  const cursor = useAnimatedStyle(() => {
    const p = pointerInView(point.value, view.value);
    return { opacity: seen.value, transform: [{ translateX: p.x }, { translateY: p.y }] };
  });
  const tag = useAnimatedStyle(() => ({ opacity: named.value }));

  // biome-ignore lint/correctness/useExhaustiveDependencies: one run per point, reading the camera as it is then.
  useEffect(() => {
    if (!at) {
      placed.current = false;
      seen.value = 0;
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    const settle = () => {
      timers.push(
        setTimeout(() => {
          named.value = reduced ? 0 : withTiming(0, { duration: FADE_MS, easing: motion.easeOut });
        }, TAG_IDLE_MS),
        setTimeout(() => {
          seen.value = reduced
            ? CURSOR_REST_OPACITY
            : withTiming(CURSOR_REST_OPACITY, { duration: FADE_MS, easing: motion.easeOut });
        }, CURSOR_IDLE_MS),
      );
    };
    named.value = 1;
    if (!placed.current || reduced) {
      placed.current = true;
      from.value = at;
      to.value = at;
      t.value = 1;
      seen.value = reduced ? 1 : withTiming(1, { duration: motion.base, easing: motion.easeOut });
      settle();
    } else {
      const start = glidePoint(from.value, to.value, t.value, 1);
      from.value = start;
      to.value = at;
      t.value = 0;
      // The glide's length on screen, as a share of the screen's width (what `glideMs` reads).
      const dist = (Math.hypot(at.x - start.x, at.y - start.y) * view.value.s) / Math.max(1, width);
      const ms = glideMs(Math.min(1, dist));
      t.value = withTiming(1, { duration: ms, easing: Easing.linear });
      seen.value = 1;
      timers.push(setTimeout(settle, ms));
    }
    return () => {
      for (const id of timers) clearTimeout(id);
    };
  }, [at?.x, at?.y, reduced]);

  if (!at) return null;
  const agent = user.kind === "agent";
  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View style={[styles.cursor, cursor]}>
        {agent ? <PixelArrow deep={tint} /> : <PersonArrow tint={tint} />}
        <Animated.View style={[agent ? styles.agentTag : styles.personTag, !agent && { backgroundColor: tint }, tag]}>
          {agent ? (
            <>
              <AgentFace agentId={user.id} size={18} live={false} />
              <RNText allowFontScaling={false} numberOfLines={1} style={[styles.name, { color: INK }]}>
                {name}
              </RNText>
            </>
          ) : (
            <RNText
              allowFontScaling={false}
              numberOfLines={1}
              style={[styles.name, { color: readableOn(tint, [PAPER, INK]) }]}
            >
              {name}
            </RNText>
          )}
        </Animated.View>
      </Animated.View>
    </View>
  );
});

/** A person's pointer: the classic arrow in their color, edged in white so it reads on anything. */
const PersonArrow = memo(function PersonArrow({ tint }: { tint: string }) {
  return (
    <Svg width={16} height={18} viewBox="0 0 16 18">
      <Path
        d="M1.5 1.5v13.2l3.6-3.3 2.5 5.4 2.4-1.1-2.5-5.3h4.9Z"
        fill={tint}
        stroke={PAPER}
        strokeWidth={1.4}
        strokeLinejoin="round"
      />
    </Svg>
  );
});

/** An agent's pointer: its pixel arrow in its deep tone with a hard shadow, as on its computer. */
const PixelArrow = memo(function PixelArrow({ deep }: { deep: string }) {
  return (
    <Svg width={(8 + DROP) * CELL} height={(12 + DROP) * CELL} viewBox={`0 0 ${8 + DROP} ${12 + DROP}`}>
      <G opacity={0.38}>
        {PIXELS.map((c) => (
          <Rect key={`s${c.x}-${c.y}`} x={c.x + DROP} y={c.y + DROP} width={1.02} height={1.02} fill={SHADOW} />
        ))}
      </G>
      {PIXELS.map((c) => (
        <Rect key={`${c.x}-${c.y}`} x={c.x} y={c.y} width={1.02} height={1.02} fill={c.edge ? PAPER : deep} />
      ))}
    </Svg>
  );
});

const styles = StyleSheet.create({
  cursor: { position: "absolute", left: 0, top: 0 },
  personTag: {
    position: "absolute",
    left: 12,
    top: 16,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 6,
  },
  agentTag: {
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
  name: { maxWidth: 140, paddingHorizontal: 2, fontSize: 12, fontWeight: "600" },
});
