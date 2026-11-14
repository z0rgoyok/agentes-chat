import { CHAT_RHYTHM } from "@agenteschat/client/lib/chat-look";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { usePulse, useReducedMotion, useTheme } from "@/ui";
import { MSG_AVATAR, MSG_GAP, MSG_INSET, rowBodyInset } from "./logic";
import type { RowLook } from "./look";

/** A conversation that is ready sooner than this never shows its skeleton (no flash on one already loaded). */
export const SKELETON_AFTER_MS = 150;

/**
 * A conversation while its messages load: the shape of its last messages, sitting at the end as they will, in this
 * conversation's own look (bubbles on both sides, or a face with a name and lines), pulsing softly together. It
 * stays until the list is placed at its end and leaves as the messages fade in, so the screen never goes blank
 * between the two. Only past `SKELETON_AFTER_MS`: a conversation the app already holds opens straight on its messages.
 */
export function ChatSkeleton({ look, top, bottom }: { look: RowLook; top: number; bottom: number }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const pulse = usePulse();
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), SKELETON_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!late) return null;
  const bone = { backgroundColor: colors.sunken };
  const rhythm = CHAT_RHYTHM[look.style];
  const inset = rowBodyInset(look);
  return (
    <Animated.View
      entering={reduced ? undefined : FadeIn.duration(160)}
      exiting={reduced ? undefined : FadeOut.duration(140)}
      pointerEvents="none"
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("mobile.common.loading")}
      style={[StyleSheet.absoluteFill, styles.frame, { paddingTop: top, paddingBottom: bottom + 8 }]}
    >
      <Animated.View style={[{ gap: rhythm.turn }, pulse]}>
        {look.style === "bubbles"
          ? BUBBLES.map((b, i) => (
              <View
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed shapes, never reordered
                key={i}
                style={[
                  styles.bubble,
                  bone,
                  { width: `${b.width}%`, height: b.lines * LINE + (b.mine ? 20 : 14) },
                  b.mine
                    ? { alignSelf: "flex-end", marginRight: 16, borderRadius: 20 }
                    : { alignSelf: "flex-start", marginLeft: inset.left },
                ]}
              />
            ))
          : TURNS.map((turn, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed shapes, never reordered
              <View key={i} style={[styles.turn, { paddingLeft: look.faces ? MSG_INSET : inset.left }]}>
                {look.faces ? <View style={[styles.face, bone]} /> : null}
                <View style={styles.body}>
                  <View style={[styles.name, bone, { width: `${turn.name}%` }]} />
                  {turn.lines.map((width, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed shapes, never reordered
                    <View key={j} style={[styles.line, bone, { width: `${width}%` }]} />
                  ))}
                </View>
              </View>
            ))}
      </Animated.View>
    </Animated.View>
  );
}

/** A line of the default text size. */
const LINE = 24;

/** The bubbles' shapes, oldest first: whose it is, its width in percent of the screen and how many lines it holds. */
const BUBBLES: { mine: boolean; width: number; lines: number }[] = [
  { mine: false, width: 58, lines: 2 },
  { mine: true, width: 42, lines: 1 },
  { mine: false, width: 66, lines: 3 },
  { mine: true, width: 54, lines: 1 },
  { mine: false, width: 46, lines: 1 },
];

/** The turns' shapes, oldest first: the name's width and each line's, in percent of the text column. */
const TURNS: { name: number; lines: number[] }[] = [
  { name: 26, lines: [88, 62] },
  { name: 34, lines: [70] },
  { name: 22, lines: [92, 84, 48] },
  { name: 30, lines: [76, 40] },
];

const styles = StyleSheet.create({
  // At the end, as the messages sit; what doesn't fit is cut at the top, under the bar.
  frame: { justifyContent: "flex-end", overflow: "hidden" },
  bubble: { borderRadius: 18 },
  turn: { flexDirection: "row", gap: MSG_GAP, paddingRight: 16 },
  face: { width: MSG_AVATAR, height: MSG_AVATAR, borderRadius: Math.round(MSG_AVATAR * 0.3) },
  body: { flex: 1, minWidth: 0, gap: 10, paddingTop: 3 },
  name: { height: 12, borderRadius: 6 },
  line: { height: 12, borderRadius: 6 },
});
