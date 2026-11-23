import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Icon, type IconName, PressScale, Text, useTheme } from "@/ui";

/**
 * The tools under a file's content (a slide's, a deck's): a row on the page's color under a hairline, each tool its
 * icon over its word. One bar for every slides screen, so the deck and the slide in it act alike.
 */
export function ToolBar({ children }: { children: ReactNode }) {
  const { colors: c } = useTheme();
  return <View style={[styles.tools, { borderTopColor: c.line2, backgroundColor: c.bg }]}>{children}</View>;
}

/** A tool: its icon over its word, centred, a finger's size. */
export function Tool({
  icon,
  label,
  onPress,
  disabled = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { colors: c } = useTheme();
  return (
    <PressScale
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={[styles.tool, disabled && styles.off]}
      contentStyle={styles.toolIn}
    >
      <Icon name={icon} size={22} color={c.ink} />
      <Text variant="caption" tone="ink2" numberOfLines={1}>
        {label}
      </Text>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  tools: {
    flexDirection: "row",
    justifyContent: "space-around",
    paddingHorizontal: 8,
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tool: { minWidth: 72, minHeight: 52, paddingHorizontal: 8 },
  // The icon centred over its word (`contentStyle`: in `style` it stood at the word's left).
  toolIn: { alignItems: "center", justifyContent: "center", gap: 2 },
  off: { opacity: 0.4 },
});
