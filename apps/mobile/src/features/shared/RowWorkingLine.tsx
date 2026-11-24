import type { ComponentProps } from "react";
import { StyleSheet, View } from "react-native";
import { PixelOrbit, Text } from "@/ui";

/**
 * What a working agent does, under a row's label: in words with its orbit, never a label (You's agents, Code's
 * sessions).
 */
export function RowWorkingLine({ color, text }: { color: ComponentProps<typeof PixelOrbit>["color"]; text: string }) {
  return (
    <View style={styles.working}>
      <PixelOrbit color={color} size={11} />
      <Text variant="footnote" tone="ink2" numberOfLines={1} style={styles.shrink}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  working: { flexDirection: "row", alignItems: "center", gap: 4 },
  shrink: { flexShrink: 1, minWidth: 0 },
});
