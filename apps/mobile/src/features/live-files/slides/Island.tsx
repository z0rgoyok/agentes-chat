import type { PeerUser } from "@agenteschat/live/awareness";
import { StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { Button, motion, Text, useReducedMotion } from "@/ui";
import { Face } from "../../shared/Face";
import { useSurface } from "../../shared/parts";

/** Built once: the island comes in and goes on the theme's durations. */
const ISLAND_IN = FadeIn.duration(motion.fast).easing(motion.easeOut);
const ISLAND_OUT = FadeOut.duration(motion.fast).easing(motion.easeOut);

/**
 * A small island at the top of a live file's screen about someone else in it (ADR 0196 §5), the spreadsheet's look:
 * their face, what they do ("Seguindo Ada", "Ada está apresentando") and one action ("Parar", "Seguir"). It comes and
 * goes with a fade (still with reduced motion: it only appears).
 */
export function HereIsland({
  who,
  words,
  action,
  onAction,
  top = 16,
}: {
  who: PeerUser;
  words: string;
  action: string;
  onAction: () => void;
  /** Its distance from the top of the area it floats over. */
  top?: number;
}) {
  const surface = useSurface("e2");
  const reduced = useReducedMotion();
  return (
    <Animated.View
      entering={reduced ? undefined : ISLAND_IN}
      exiting={reduced ? undefined : ISLAND_OUT}
      style={[styles.at, { top }]}
      pointerEvents="box-none"
    >
      <View style={[styles.island, surface]} accessibilityLiveRegion="polite">
        <Face who={{ type: who.kind === "agent" ? "agent" : "person", id: who.id }} size={18} live={false} />
        <Text variant="footnote" numberOfLines={1} style={styles.words}>
          {words}
        </Text>
        <Button variant="text" size="sm" label={action} onPress={onAction} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  at: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  island: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    maxWidth: "90%",
    paddingLeft: 8,
    paddingRight: 4,
    minHeight: 36,
    borderRadius: 18,
  },
  words: { flexShrink: 1, fontWeight: "600" },
});
