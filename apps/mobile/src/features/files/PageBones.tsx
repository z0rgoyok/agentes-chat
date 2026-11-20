import { StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { SCREEN_X, usePulse } from "@/ui";
import { useColors } from "../shared/hooks";

/** Widths of the text's lines while it loads, so it reads as a page of text, not a pattern. */
const BONES = [92, 84, 96, 71, 88, 64, 90, 78];

/**
 * A page while it loads (a file, a page an agent made, a block opened whole): lines where its text goes, pulsing as
 * the app's lists do while they load, never a spinner. `cover`: over a web view still drawing its page, on the
 * screen's own color.
 */
export function PageBones({ cover = false }: { cover?: boolean }) {
  const c = useColors();
  const pulse = usePulse();
  const bones = (
    <Animated.View
      style={[styles.bones, pulse]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {BONES.map((w) => (
        <View key={w} style={[styles.bone, { width: `${w}%`, backgroundColor: c.plate }]} />
      ))}
    </Animated.View>
  );
  if (!cover) return bones;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: c.bg }]}>
      {bones}
    </View>
  );
}

const styles = StyleSheet.create({
  bones: { gap: 12, paddingHorizontal: SCREEN_X, paddingTop: 20 },
  bone: { height: 12, borderRadius: 6 },
});
