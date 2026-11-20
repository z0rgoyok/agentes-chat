import { memo, useContext, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  type AnimatedRef,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { haptics, TabFoot, useReducedMotion } from "@/ui";
import { usePullPastEnd } from "../chat/ChatPeek";
import { armedAfter, PEEK_SIZE } from "../chat/peek";
import { AgentFace } from "../shared/Face";
import { TEAM_PEEK_GAP, teamFacePose, teamRow } from "./team-peek";

/** The tap as the last face arrives: once per pull, from the UI thread. */
const tap = () => haptics.light();

/**
 * The end of Conversas (iOS, `LargeTitleScreen`'s `pastEnd`): pulled past its last row, the team peeks up from behind
 * the tab bar, the right hand in the middle first, the others out from it, looking up at the person; the phone taps
 * once as the last one arrives, and they go back down with the bounce. The conversation's peek (`ChatPeek`) with a row
 * of faces: the same pull read on the UI thread, the same numbers, transform and opacity only, still frames, no touch.
 *
 * `agents`: who peeks (`teamPeekers`), their ids joined by spaces, so the row is drawn again only for another team.
 */
export const TeamPeek = memo(function TeamPeek({
  scroll,
  agents,
}: {
  scroll: AnimatedRef<Animated.ScrollView>;
  agents: string;
}) {
  const row = useMemo(() => teamRow(agents ? agents.split(" ") : []), [agents]);
  const pull = usePullPastEnd(scroll, row.length > 0);
  const reduced = useReducedMotion();
  const safe = useSafeAreaInsets();
  const foot = useContext(TabFoot);
  const armed = useSharedValue(false);
  // On the frame the pull crosses the line, nothing else leaves the UI thread.
  useAnimatedReaction(
    () => pull.get(),
    (now) => {
      const was = armed.get();
      const next = armedAfter(was, now);
      if (next === was) return;
      armed.set(next);
      if (next) scheduleOnRN(tap);
    },
  );
  if (row.length === 0) return null;
  const lastRank = Math.max(...row.map((f) => f.rank));
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      // Its bottom edge is the tab bar's top (over the work-along strip when one stands there): below it, cut. Inside a
      // tab the system's bottom safe area already ends there (it holds the bar), so nothing is added for the bar.
      style={[styles.box, { bottom: safe.bottom + (foot?.height ?? 0) }]}
    >
      {row.map((f) => (
        <TeamFace key={f.id} agentId={f.id} pull={pull} rank={f.rank} lastRank={lastRank} reduced={reduced} />
      ))}
    </View>
  );
});

function TeamFace({
  agentId,
  pull,
  rank,
  lastRank,
  reduced,
}: {
  agentId: string;
  pull: SharedValue<number>;
  rank: number;
  lastRank: number;
  reduced: boolean;
}) {
  const style = useAnimatedStyle(() => {
    const pose = teamFacePose(pull.get(), rank, lastRank, reduced);
    return { opacity: pose.opacity, transform: [{ translateY: pose.y }] };
  }, [rank, lastRank, reduced]);
  return (
    <Animated.View style={style}>
      <AgentFace agentId={agentId} size={PEEK_SIZE} live={false} framed={false} gaze="up" />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // A row across the screen, centered, as tall as a face; what is below its bottom edge is cut, so the faces come up
  // from behind the bar.
  box: {
    position: "absolute",
    left: 0,
    right: 0,
    height: PEEK_SIZE,
    flexDirection: "row",
    justifyContent: "center",
    gap: TEAM_PEEK_GAP,
    overflow: "hidden",
  },
});
