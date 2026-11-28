import { useEffect } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, {
  interpolate,
  runOnJS,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { AgentAvatar } from "@/agent/AgentAvatar";
import { motion, SCREEN_X, useReducedMotion } from "@/ui";
import { fullLook } from "../agents/edit";
import { type TeamFlight as Flight, teamArrivals, useTeamFlight } from "./team-arrivals";

const FACE = 28;
const FLY_MS = 900;
const FACE_GAP_MS = 70;

/**
 * A new team's faces rise from the conversation and drop into the back button to Conversas, one after another, about
 * a second in all: where the team went. Over the conversation, never taking a touch. Reduced motion: no flight.
 */
export function TeamFlight({ barHeight }: { barHeight: number }) {
  const flight = useTeamFlight();
  const reduced = useReducedMotion();
  useEffect(() => {
    if (flight && reduced) teamArrivals.landed();
  }, [flight, reduced]);
  if (!flight || reduced) return null;
  return <Faces key={flight.n} flight={flight} barHeight={barHeight} />;
}

function Faces({ flight, barHeight }: { flight: Flight; barHeight: number }) {
  const { width, height } = useWindowDimensions();
  const from = { x: width / 2 - FACE / 2, y: height * 0.7 };
  const to = { x: SCREEN_X + 22 - FACE / 2, y: Math.max(0, barHeight - 22 - FACE / 2) };
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" accessibilityElementsHidden>
      {flight.faces.map((f, i) => (
        <Face
          key={f.key}
          appearance={f.appearance}
          name={f.name}
          from={{ x: from.x + (i - (flight.faces.length - 1) / 2) * (FACE + 4), y: from.y }}
          to={to}
          delay={i * FACE_GAP_MS}
          last={i === flight.faces.length - 1}
        />
      ))}
    </View>
  );
}

function Face({
  appearance,
  name,
  from,
  to,
  delay,
  last,
}: {
  appearance: unknown;
  name: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  delay: number;
  last: boolean;
}) {
  const p: SharedValue<number> = useSharedValue(0);
  useEffect(() => {
    p.set(
      withDelay(
        delay,
        withTiming(1, { duration: FLY_MS, easing: motion.easeInOut }, (done) => {
          if (done && last) runOnJS(teamArrivals.landed)();
        }),
      ),
    );
  }, [delay, last, p]);
  const look = useAnimatedStyle(() => {
    const k = p.get();
    // A slight arc up and over, as the web's cursor glides.
    const lift = Math.sin(Math.PI * k) * 40;
    return {
      opacity: interpolate(k, [0, 0.1, 0.8, 1], [0, 1, 1, 0]),
      transform: [
        { translateX: from.x + (to.x - from.x) * k },
        { translateY: from.y + (to.y - from.y) * k - lift },
        { scale: interpolate(k, [0, 1], [1, 0.5]) },
      ],
    };
  });
  return (
    <Animated.View style={[styles.face, look]}>
      <AgentAvatar agent={fullLook(appearance)} size={FACE} name={name} live={false} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  face: { position: "absolute", left: 0, top: 0 },
});
