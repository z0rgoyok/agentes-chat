import { clippedHeight, LONG_MESSAGE } from "@agenteschat/client/lib/message-length";
import { File, Paths } from "expo-file-system";
import { LinearGradient } from "expo-linear-gradient";
import { type ComponentRef, createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, AppState, Pressable, StyleSheet, View } from "react-native";
import Animated, { Easing, LinearTransition } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import { motion, Text, useReducedMotion } from "@/ui";
import { keepSize, keptHeightAfter, keptSize, keptWordHeights, PAST_RULE, restoreWordHeights } from "./kept-sizes";
import { useLayoutKey } from "./look";
import { withOpacity } from "./turn";

/** How much of the clipped words fades out at their end. */
const FADE = 96;

/** How many of the words' heights outlive the app (`readSavedHeights`): the latest measured. */
const HEIGHTS_SAVED = 1000;
/** The language the words show in; null until a message's words first show (and the file is read). */
let heightsLang: string | null = null;
const heightsFile = (lang: string) => new File(Paths.cache, `chat-word-heights-${lang}.json`);

/**
 * The words' heights an earlier launch measured, read the first time a message's words show, and kept for the next
 * launch each time the app goes to the background: after a launch a conversation draws its long messages cut from their
 * first frame, and its short ones without a second layout. In the app's cache folder (the system may clear it: then
 * they are measured again), a file per language (a server's line reads longer in some): ids and heights, no content.
 */
function readSavedHeights(lang: string) {
  const first = heightsLang === null;
  heightsLang = lang;
  if (!first) return;
  try {
    const file = heightsFile(lang);
    if (file.exists) restoreWordHeights(JSON.parse(file.textSync()));
  } catch {
    // Unreadable: the heights are measured again.
  }
  AppState.addEventListener("change", (state) => {
    if (state !== "background" || heightsLang === null) return;
    try {
      const file = heightsFile(heightsLang);
      file.write(JSON.stringify(keptWordHeights(HEIGHTS_SAVED))).catch(() => {});
    } catch {
      // Not saved: the next launch measures them again.
    }
  });
}

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
  const { t, i18n } = useTranslation();
  const reduced = useReducedMotion();
  const screen = useContext(OpenedMessagesContext);
  readSavedHeights(i18n.language);
  // Opened from this row: it grows. One the screen kept open comes back open, still.
  const [tapped, setTapped] = useState(false);
  const fullMessages = useOrg().org?.chatPrefs?.fullMessages === true;
  const open = fullMessages || tapped || Boolean(screen?.has(id));
  // How tall the words are whole, kept across the list's unmounts (`kept-sizes.ts`): a row coming back is cut from its
  // first frame. Never measured yet, they show no taller than a whole message may, a point past it (`PAST_RULE`: a long
  // paragraph under the cap reads the cap): a long one drew whole for a frame and then shrank, moving every row under
  // it as the person scrolled. Kept by what it shows: an agent's long message to another agent shows its start
  // (`lead`) in the conversation and whole on its thread's screen, and one size kept for both drew it whole for a frame
  // there, or faded its short start out here.
  const sizeKey = `words:${id}:${open || lead == null ? "whole" : "lead"}:${useLayoutKey()}`;
  const [height, setHeight] = useState(() => keptSize(sizeKey) ?? 0);
  const cut = clippedHeight(height);
  const foldable = cut !== null || lead != null;
  const shows = open ? null : cut;
  const unmeasured = height === 0 && !open && lead == null;
  // Folded, a measure only ever raises the kept height (`keptHeightAfter`): a message near the rule flipped between
  // folded and whole on every layout, covering the next message each time it opened (seen on a phone).
  const folded = shows !== null || unmeasured;
  const words = useRef<ComponentRef<typeof View>>(null);
  useEffect(() => {
    if (tapped && words.current) AccessibilityInfo.sendAccessibilityEvent(words.current, "focus");
  }, [tapped]);
  return (
    // One tree whether it clips or not: the words never remount when their height is first known.
    <View>
      <Animated.View
        layout={tapped && !reduced ? REVEAL : undefined}
        style={
          foldable
            ? [styles.clip, shows === null ? undefined : { maxHeight: shows }]
            : unmeasured
              ? styles.unmeasured
              : undefined
        }
      >
        <View
          ref={words}
          onLayout={(e) => {
            const next = keptHeightAfter(height, e.nativeEvent.layout.height, folded);
            if (next === null) return;
            keepSize(sizeKey, next);
            // Under the fold before and after, the words look the same at either height (the first frame's cap stands
            // past the rule, so it cuts nothing): no second render for them, which is most messages.
            if (cut === null && clippedHeight(next) === null) return;
            setHeight(next);
          }}
        >
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
  unmeasured: { maxHeight: LONG_MESSAGE.over + PAST_RULE, overflow: "hidden" },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: FADE },
  more: { alignSelf: "flex-start", marginTop: 4 },
  moreText: { fontWeight: "600", textDecorationLine: "underline" },
  pressed: { opacity: 0.6 },
});
