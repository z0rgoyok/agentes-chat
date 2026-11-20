import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { SCREEN_X } from "./rhythm";
import { SectionHeader, type SectionHeaderProps } from "./SectionHeader";

export interface SectionProps extends SectionHeaderProps {
  children?: ReactNode;
}

/**
 * A titled block of the screen. Its title is a `SectionHeader` (15 semibold ink, the count after it, a way on at its
 * right), so a section's title reads the same on every screen; what the block holds sits under it at the screen's
 * sides.
 */
export function Section({ title, count, action, children }: SectionProps) {
  return (
    <View>
      <SectionHeader title={title} {...(count !== undefined ? { count } : {})} {...(action ? { action } : {})} />
      <View style={styles.body}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({ body: { paddingHorizontal: SCREEN_X } });
