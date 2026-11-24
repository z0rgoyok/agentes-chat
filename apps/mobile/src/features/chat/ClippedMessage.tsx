import { clippedHeight, LONG_MESSAGE, shownWhole } from "@agenteschat/client/lib/message-length";
import { File, Paths } from "expo-file-system";
import { LinearGradient } from "expo-linear-gradient";
import { type ComponentRef, createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, AppState, Pressable, StyleSheet, View } from "react-native";
import { Easing, LinearTransition } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import { Icon, motion, Text, useTheme } from "@/ui";
import { keepSize, keptHeightAfter, keptSize, keptWordHeights, PAST_RULE, restoreWordHeights } from "./kept-sizes";
import { useLayoutKey } from "./look";
import { withOpacity } from "./turn";

/** How much of the clipped words fades out at their end (the web's `.msg-clip--cut` mask). */
const FADE = 128;
/** The fade's clear end, where "Ver mais" sits: the words show continuing right above it. */
const CLEAR = 20;

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

/**
 * Folded words growing down to their whole height once "Ver mais" opens them, on a page (`FoldedBody`): what is above
 * them stays still. Never in a conversation's list, where the words open at once (`ClippedMessage`).
 */
export const REVEAL = LinearTransition.duration(motion.base).easing(Easing.bezier(...motion.out));

/**
 * The messages opened in place on a conversation's screen, kept above the rows: its list unmounts a row that leaves
 * the screen, and the row's own state would fold the message again when it comes back. `open` also stops the list
 * from following its end, so the reader stays on the words.
 */
export interface OpenedMessages {
  has: (id: string) => boolean;
  open: (id: string) => void;
  /** The newest message, the reader's answer (`answerIds`) and the ones that mention them: whole however long. */
  answer: (id: string) => boolean;
}
export const OpenedMessagesContext = createContext<OpenedMessages | null>(null);

/** The message whose "See more" was just tapped: its words take the screen reader's focus once they show open. */
let focusOnOpen: string | null = null;

/**
 * A message's words in a conversation (the web's `ClippedBody`, the same heights and answers): one taller than the
 * shared rule shows its start, fading into what is behind it, with "Ver mais", and so does an agent's long message to
 * another agent, folded to its `lead` (ADR 0034). "Ver mais" opens the words in place, at once and for good.
 * `behind`: the colours painted behind the words, bottom layer first (a tint over the screen's colour is two), so the
 * fade ends on exactly what is there.
 */
export function ClippedMessage({
  id,
  behind,
  ink,
  lead,
  onEnd,
  children,
}: {
  /** Where the words end in what holds them (their top plus their height), after each layout (`useBubbleCap`). */
  onEnd?: ((end: number) => void) | undefined;
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
  const { colors } = useTheme();
  const screen = useContext(OpenedMessagesContext);
  readSavedHeights(i18n.language);
  // Opened from this row, or one the screen kept open coming back, or shown whole before this session (an answer,
  // never cut under the reader as newer messages arrive): open, whole. An agent's message to another folded to its
  // lead is not the reader's answer: only "Ver mais" opens it.
  const [tapped, setTapped] = useState(false);
  const fullMessages = useOrg().org?.chatPrefs?.fullMessages === true;
  if (lead == null && screen?.answer(id)) shownWhole.add(id);
  const open = fullMessages || tapped || Boolean(screen?.has(id)) || shownWhole.has(id);
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
  // The screen reader goes to the words "See more" opened, here or in the row drawn anew for them (`MessageRow`).
  useEffect(() => {
    if (!open || focusOnOpen !== id || !words.current) return;
    focusOnOpen = null;
    AccessibilityInfo.sendAccessibilityEvent(words.current, "focus");
  }, [open, id]);
  return (
    // One tree whether it clips or not: the words never remount when their height is first known.
    <View onLayout={onEnd ? (e) => onEnd(e.nativeEvent.layout.y + e.nativeEvent.layout.height) : undefined}>
      {/* Opened at once, never with a layout transition: inside the conversation's list an animated height left the
          words' frame at the fold while the bubble already took their whole height, an empty bubble under the cut
          words (seen on a phone). */}
      <View
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
            colors={[withOpacity(color, 0), color, color]}
            locations={[0, 1 - CLEAR / FADE, 1]}
            style={styles.fade}
          />
        ))}
      </View>
      {foldable && !open ? (
        // A 20-point line: 12 of slop around it gives the 44-point target.
        <Pressable
          accessibilityRole="button"
          hitSlop={12}
          onPress={() => {
            focusOnOpen = id;
            setTapped(true);
            screen?.open(id);
          }}
          style={({ pressed }) => [styles.more, shows !== null && styles.overFade, pressed && styles.pressed]}
        >
          <Text variant="label" tone="ink2" style={ink ? { color: ink } : undefined}>
            {t("channel.long.more")}
          </Text>
          <Icon name="chev" size={14} color={ink ?? colors.ink2} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
  unmeasured: { maxHeight: LONG_MESSAGE.over + PAST_RULE, overflow: "hidden" },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: FADE },
  more: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  overFade: { marginTop: -CLEAR },
  pressed: { opacity: 0.6 },
});
