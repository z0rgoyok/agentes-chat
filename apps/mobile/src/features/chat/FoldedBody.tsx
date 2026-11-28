import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { Icon, Text, useReducedMotion, useTheme } from "@/ui";
import { REVEAL } from "./ClippedMessage";
import { keepOpen, keepSize, keptOpen, keptSize, PAST_RULE } from "./kept-sizes";
import { useLayoutKey } from "./look";
import { MessageText } from "./MessageText";

const FOLDED = 114;

/**
 * A long text an agent wrote, on a page rather than in a conversation (the web's `FoldedBody`): folded until "Ver mais"
 * opens it in place, for good. `plain`: words from outside (a server's own instructions) as they are written, nothing in
 * them made a mention, a link or a chart.
 */
export function FoldedBody({ body, muted = false, plain = false }: { body: string; muted?: boolean; plain?: boolean }) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const { colors } = useTheme();
  // Kept as a conversation's rows keep theirs (`kept-sizes.ts`): on a card in a conversation, a row coming back into
  // view showed the text with no "Ver mais" for a frame, then grew by its line, and folded what had been opened.
  const sizeKey = `folded:${useLayoutKey()}:${body}`;
  const [open, setOpen] = useState(() => keptOpen(`open:${sizeKey}`));
  const [height, setHeight] = useState(() => keptSize(sizeKey) ?? 0);
  // Only what this width really cuts: the same text may fit whole on a tablet and not on a phone. The fold stands a
  // point past its rule (`PAST_RULE`): a long paragraph under it reads no taller than the fold, and folded exactly at the
  // rule it read "not over it", cut with no "Ver mais" to open the rest.
  const long = height > FOLDED;
  return (
    <View>
      <Animated.View layout={open && !reduced ? REVEAL : undefined} style={open ? styles.clip : styles.folded}>
        <View
          onLayout={(e) => {
            const measured = e.nativeEvent.layout.height;
            keepSize(sizeKey, measured);
            setHeight(measured);
          }}
        >
          {plain ? (
            <Text variant="footnote" tone={muted ? "muted" : "ink"} selectable={false}>
              {body}
            </Text>
          ) : (
            <MessageText body={body} muted={muted} small selectable={false} />
          )}
        </View>
      </Animated.View>
      {long && !open ? (
        // An 18-point line: 13 of slop around it gives the 44-point target.
        <Pressable
          accessibilityRole="button"
          hitSlop={13}
          onPress={() => {
            keepOpen(`open:${sizeKey}`, true);
            setOpen(true);
          }}
          style={({ pressed }) => [styles.more, pressed && styles.pressed]}
        >
          <Text variant="label" tone="ink2">
            {t("channel.long.more")}
          </Text>
          <Icon name="chev" size={14} color={colors.ink2} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
  folded: { maxHeight: FOLDED + PAST_RULE, overflow: "hidden" },
  more: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 2, marginTop: 2 },
  pressed: { opacity: 0.6 },
});
