import { Platform, StyleSheet, View } from "react-native";
import { Icon, type IconName } from "./Icon";
import { TILE_TINTS } from "./icons.sf";
import { MarkIcon } from "./MarkIcon";
import { useTheme } from "./theme";

const IOS = Platform.OS === "ios";
const ON_TILE = "#ffffff";

/**
 * An icon's tile, the system Settings' own: the subject's color (`TILE_TINTS`, the system's gray where it has none,
 * red for a destructive row), a continuous corner of 23% (7 on the 30-point tile of a list row) and the symbol in white,
 * filled on iOS (16 points on a 30 tile), our line icon a size smaller on Android.
 */
export function IconTile({
  icon,
  size = 30,
  danger = false,
  mark = null,
}: {
  icon: IconName;
  size?: number;
  danger?: boolean;
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
          backgroundColor: colors.tiles[danger ? "red" : (TILE_TINTS[icon] ?? "gray")],
        },
      ]}
    >
      {mark ? (
        <MarkIcon uri={mark} fallback={icon} size={Math.round(size * (IOS ? 0.73 : 0.6))} color={ON_TILE} />
      ) : (
        <Icon name={icon} size={Math.round(size * (IOS ? 0.73 : 0.6))} color={ON_TILE} filled />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: "center", justifyContent: "center", borderCurve: "continuous" },
});
