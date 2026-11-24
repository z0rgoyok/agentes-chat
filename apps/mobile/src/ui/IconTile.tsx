import { Platform, StyleSheet, View } from "react-native";
import { Icon, type IconName } from "./Icon";
import { MATERIAL_NAMES } from "./icons.material.names";
import { TILE_TINTS, type TileTint } from "./icons.sf";
import { MarkIcon } from "./MarkIcon";
import { useTheme } from "./theme";

const IOS = Platform.OS === "ios";
const ON_TILE = "#ffffff";
/** How much of the tile the symbol takes: Apple's and Google's filled symbols, or our line icon. */
const glyphShare = (icon: IconName) => (IOS ? 0.73 : MATERIAL_NAMES[icon] ? 0.66 : 0.6);

/**
 * An icon's tile, the system Settings' own: the subject's color (`TILE_TINTS`, the system's gray where it has none,
 * red for a destructive row), a continuous corner of 23% (7 on the 30-point tile of a list row) and the symbol in white,
 * filled: Apple's on iOS (22 points on a 30 tile), Google's on Android (20), our line icon a size smaller (18) where
 * Google has none.
 */
export function IconTile({
  icon,
  size = 30,
  danger = false,
  mark = null,
  tint,
}: {
  icon: IconName;
  size?: number;
  danger?: boolean;
  /** Its color when the subject's isn't the icon's own (what always asks for approval: orange). */
  tint?: TileTint;
  /** A one-color brand logo's address, drawn in the symbol's box and color: `icon` while it has none or fails to load. */
  mark?: string | null;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.23),
          backgroundColor: colors.tiles[danger ? "red" : (tint ?? TILE_TINTS[icon] ?? "gray")],
        },
      ]}
    >
      {mark ? (
        <MarkIcon uri={mark} fallback={icon} size={Math.round(size * glyphShare(icon))} color={ON_TILE} />
      ) : (
        <Icon name={icon} size={Math.round(size * glyphShare(icon))} color={ON_TILE} filled />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: "center", justifyContent: "center", borderCurve: "continuous" },
});
