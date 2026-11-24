import type { CodeChangeStatus } from "@agenteschat/client";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { fonts, useTheme } from "@/ui";
import { CHANGE_LETTER } from "./logic";

/** The row tile's size and corner, as every icon tile of a grouped row (`IconTile`). */
const TILE = 30;

/**
 * A change's letter (`git status`: M, A, D, R, U) in a grouped row's tile, in the tile's place and shape as the rows'
 * icons are: amber for a change, green for a new file, red for a removed one, the agents' blue for a move. VoiceOver
 * reads its kind in words.
 */
export function ChangeTile({ status }: { status: CodeChangeStatus }) {
  const { t } = useTranslation();
  const c = useTheme().colors;
  const tint =
    status === "added" || status === "untracked"
      ? c.ok
      : status === "deleted"
        ? c.danger
        : status === "renamed"
          ? c.agent
          : c.warn;
  return (
    <View
      style={[styles.tile, { backgroundColor: tint }]}
      accessible
      accessibilityLabel={t(`codeSessions.gitTab.status.${status}`)}
    >
      <Text allowFontScaling={false} style={styles.letter}>
        {CHANGE_LETTER[status]}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: Math.round(TILE * 0.23),
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  letter: { color: "#ffffff", fontFamily: fonts.mono, fontSize: 14, fontWeight: "700" },
});
