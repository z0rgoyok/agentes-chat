import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { ICON_BUTTON_SIZE, IconButton } from "./IconButton";
import { SHEET_BAR, SHEET_X } from "./rhythm";
import { Text } from "./Text";
import { useTheme } from "./theme";

export interface SheetBarProps {
  /** Centered between the two sides. Left out, the bar holds only its buttons (a long title on a row under it). */
  title?: string;
  /** The close plate: × closes the sheet, ‹ (`icon="back"`) goes back to the page before inside it. */
  onClose: () => void;
  icon?: "x" | "back";
  /** An action at the right end (copy); the title stays centered while it is no wider than the close plate. */
  trailing?: ReactNode;
  /**
   * Inside a sheet's padded body (`SheetScreen`, a sheet's steps): the body brings the sides and the room under the
   * grabber, and the bar draws only its row. By default the bar sits at the sheet's top edge with that room and those
   * sides of its own, on the sheet's color, so a list pinned under it passes under it and never shows above it.
   */
  inset?: boolean;
}

/**
 * The bar of a task sheet (the code or the chart opened whole, Novo, Compartilhar, a picker): the close plate at the
 * left, the title centered, an optional action at the right; one height and one padding on every sheet. A menu of
 * actions has no bar: its title leads its list (`SheetTitle`), and the scrim or a flick down closes it.
 */
export function SheetBar({ title, onClose, icon = "x", trailing, inset = false }: SheetBarProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <View style={inset ? null : [styles.edge, { backgroundColor: colors.grouped }]}>
      <View style={styles.row}>
        <IconButton
          icon={icon}
          plate
          label={icon === "x" ? t("mobile.common.close") : t("mobile.common.back")}
          onPress={onClose}
        />
        {title ? (
          <Text variant="title" style={styles.title} accessibilityRole="header" numberOfLines={1}>
            {title}
          </Text>
        ) : (
          <View style={styles.grow} />
        )}
        {/* As wide as the plate at least, so the title sits in the bar's middle. */}
        <View style={styles.side}>{trailing}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  edge: { paddingTop: SHEET_BAR.top, paddingHorizontal: SHEET_X },
  row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: SHEET_BAR.height },
  title: { flex: 1, textAlign: "center" },
  grow: { flex: 1 },
  side: { minWidth: ICON_BUTTON_SIZE, alignItems: "flex-end" },
});
