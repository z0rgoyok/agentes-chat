import { Text as RNText, StyleSheet, View } from "react-native";
import { RADIUS } from "./radius";
import { systemText } from "./Text";
import { useTheme } from "./theme";
import { weights } from "./type-scale";

/** The words: the caption's size at medium weight, on an 18-point line (the web's `.ac-tag`: 11.5 / 18, 500). */
const WORDS = systemText("caption", weights.medium);

/**
 * A short fact beside a name, as the web's `.ac-tag` (an agent's role, "Ops"): its words in muted on a soft plate as
 * wide as they are, the scale's small corner, one line that ends in "…" when the row is short of room.
 */
export function Tag({ label }: { label: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.plate, { backgroundColor: colors.plateSoft }]}>
      <RNText
        numberOfLines={1}
        maxFontSizeMultiplier={1.4}
        style={[WORDS, styles.words, { color: colors.muted }]}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        {label}
      </RNText>
    </View>
  );
}

const styles = StyleSheet.create({
  plate: { flexShrink: 1, minWidth: 0, paddingHorizontal: 6, borderRadius: RADIUS.sm },
  words: { lineHeight: 18 },
});
