import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { Text, useReducedMotion } from "@/ui";
import { REVEAL } from "./ClippedMessage";
import { MessageText } from "./MessageText";

const FOLDED = 114;

/**
 * A long text an agent wrote, on a page rather than in a conversation (the web's `FoldedBody`): folded until "Ver mais"
 * opens it in place, for good.
 */
export function FoldedBody({ body, muted = false }: { body: string; muted?: boolean }) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(0);
  // Only what this width really cuts: the same text may fit whole on a tablet and not on a phone.
  const long = height > FOLDED;
  return (
    <View>
      <Animated.View layout={open && !reduced ? REVEAL : undefined} style={open ? styles.clip : styles.folded}>
        <View onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
          <MessageText body={body} muted={muted} small selectable={false} />
        </View>
      </Animated.View>
      {long && !open ? (
        // An 18-point line: 13 of slop around it gives the 44-point target.
        <Pressable
          accessibilityRole="button"
          hitSlop={13}
          onPress={() => setOpen(true)}
          style={({ pressed }) => (pressed ? styles.pressed : null)}
        >
          <Text variant="footnote" tone="ink2" style={styles.more}>
            {t("channel.long.more")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
  folded: { maxHeight: FOLDED, overflow: "hidden" },
  more: { marginTop: 2, textDecorationLine: "underline" },
  pressed: { opacity: 0.6 },
});
