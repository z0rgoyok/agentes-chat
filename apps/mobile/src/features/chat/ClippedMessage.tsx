import { clippedHeight } from "@agenteschat/client/lib/message-length";
import { LinearGradient } from "expo-linear-gradient";
import { type ComponentRef, createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, Pressable, StyleSheet, View } from "react-native";
import Animated, { Easing, LinearTransition } from "react-native-reanimated";
import { motion, Text, useReducedMotion } from "@/ui";
import { withOpacity } from "./turn";

/** How much of the clipped words fades out at their end. */
const FADE = 96;

/** Folded words growing down to their whole height once "Ver mais" opens them: what is above them stays still. */
export const REVEAL = LinearTransition.duration(motion.base).easing(Easing.bezier(...motion.out));

/**
 * The messages opened in place on a conversation's screen, kept above the rows: its list unmounts a row that leaves
 * the screen, and the row's own state would fold the message again when it comes back. `open` also stops the list
 * from following its end, so the reader stays on the words.
 */
export interface OpenedMessages {
  has: (id: string) => boolean;
  open: (id: string) => void;
}
export const OpenedMessagesContext = createContext<OpenedMessages | null>(null);

/**
 * A message's words in a conversation (the web's `ClippedBody`, the same heights): one taller than the shared rule
 * shows its start, fading into what is behind it, with "Ver mais", and so does an agent's long message to another
 * agent, folded to its `lead` (ADR 0034). "Ver mais" opens the words in place, for good: they grow down from the fold.
 * `behind`: the colours painted behind the words, bottom layer first (a tint over the screen's colour is two), so the
 * fade ends on exactly what is there.
 */
export function ClippedMessage({
  id,
  behind,
  ink,
  lead,
  children,
}: {
  /** The message's id: the screen keeps it open by that. */
  id: string;
  behind: readonly string[];
  /** The words' colour on a solid bubble. */
  ink?: string | undefined;
  /** The words folded to their start, shown until "Ver mais". */
  lead?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const screen = useContext(OpenedMessagesContext);
  // Opened from this row: it grows. One the screen kept open comes back open, still.
  const [tapped, setTapped] = useState(false);
  const open = tapped || Boolean(screen?.has(id));
  const [height, setHeight] = useState(0);
  const cut = clippedHeight(height);
  const foldable = cut !== null || lead != null;
  const shows = open ? null : cut;
  const words = useRef<ComponentRef<typeof View>>(null);
  useEffect(() => {
    if (tapped && words.current) AccessibilityInfo.sendAccessibilityEvent(words.current, "focus");
  }, [tapped]);
  return (
    // One tree whether it clips or not: the words never remount when their height is first known.
    <View>
      <Animated.View
        layout={tapped && !reduced ? REVEAL : undefined}
        style={foldable ? [styles.clip, shows === null ? undefined : { maxHeight: shows }] : undefined}
      >
        <View ref={words} onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
          {open || lead == null ? children : lead}
        </View>
        {(shows === null ? [] : behind).map((color, i) => (
          <LinearGradient
            // biome-ignore lint/suspicious/noArrayIndexKey: the layers behind one text, in order
            key={i}
            pointerEvents="none"
            colors={[withOpacity(color, 0), color]}
            style={styles.fade}
          />
        ))}
      </Animated.View>
      {foldable && !open ? (
        // A 20-point line: 12 of slop around it gives the 44-point target.
        <Pressable
          accessibilityRole="button"
          hitSlop={12}
          onPress={() => {
            setTapped(true);
            screen?.open(id);
          }}
          style={({ pressed }) => [styles.more, pressed && styles.pressed]}
        >
          <Text variant="subhead" style={[styles.moreText, ink ? { color: ink } : undefined]}>
            {t("channel.long.more")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: FADE },
  more: { alignSelf: "flex-start", marginTop: 4 },
  moreText: { fontWeight: "600", textDecorationLine: "underline" },
  pressed: { opacity: 0.6 },
});
