import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Icon, type IconName } from "./Icon";
import { Text } from "./Text";
import { useTheme } from "./theme";

export interface Fact {
  key: string;
  /** An icon name, or a node in its place (a connector's logo, 16 points). */
  icon: IconName | ReactNode;
  label: string;
  value: string;
  /** `waiting` (amber) for what calls for care, `done` (green) for a result. */
  tone?: "waiting" | "done";
}

/**
 * The web's `FactStrip` ("Onde · Efeito · Prazo"): each fact a small label with its icon over its value. Each is as
 * wide as its words; one that doesn't fit moves whole to the next line, and only a value wider than the screen wraps.
 */
export function FactStrip({ facts }: { facts: Fact[] }) {
  const { colors } = useTheme();
  return (
    <View style={styles.strip}>
      {facts.map((f) => (
        <View key={f.key} style={styles.fact} accessible accessibilityLabel={`${f.label}: ${f.value}`}>
          <View style={styles.head}>
            {typeof f.icon === "string" ? <Icon name={f.icon as IconName} size={14} color={colors.faint} /> : f.icon}
            <Text variant="caption" tone="muted">
              {f.label}
            </Text>
          </View>
          <Text
            variant="subhead"
            tone={f.tone === "done" ? "ok" : undefined}
            style={f.tone === "waiting" ? { color: colors.amberInk } : undefined}
          >
            {f.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { flexDirection: "row", flexWrap: "wrap", columnGap: 24, rowGap: 12 },
  fact: { flexShrink: 1, gap: 4 },
  head: { flexDirection: "row", alignItems: "center", gap: 4 },
});
