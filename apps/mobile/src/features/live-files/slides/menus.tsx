import { THEME_IDS, type ThemeId, themeOf } from "@agenteschat/live/slides";
import type { TFunction } from "i18next";
import { Alert, StyleSheet, View } from "react-native";
import { type IconName, useTheme } from "@/ui";
import { pickOne, showActionSheet } from "../../shared/PickerSheet";

/**
 * A presentation's menus on the phone (ADR 0196 §9), in the app's own sheets: a slide's or an element's actions, the
 * question before a slide goes, and the six themes.
 */

/** A short menu of a slide's (or an element's) actions in the app's own sheet; nothing when it has none. */
export function chooseSlideAction(
  title: string,
  actions: { label: string; icon: IconName; destructive?: boolean; onPress: () => void }[],
) {
  if (actions.length > 0) showActionSheet(title, actions);
}

/** Before a slide goes: it goes for everyone in the file (Desfazer brings it back). */
export function confirmDelete(t: TFunction, n: number, go: () => void) {
  Alert.alert(t("mobile.live.slides.deleteTitle", { n }), t("mobile.live.slides.deleteText"), [
    { text: t("mobile.common.cancel"), style: "cancel" },
    { text: t("live.slides.rail.delete"), style: "destructive", onPress: go },
  ]);
}

/** "Tema": the six themes, the one in use checked, each with its colors as a small slide. */
export async function pickTheme(t: TFunction, current: ThemeId, set: (theme: ThemeId) => void): Promise<void> {
  const picked = await pickOne({
    title: t("live.slides.theme.label"),
    value: current,
    options: THEME_IDS.map((id) => ({
      key: id,
      label: t(`live.slides.themes.${id}`),
      leading: { kind: "node" as const, node: <ThemeSwatch id={id} /> },
    })),
  });
  if (picked && picked !== current) set(picked as ThemeId);
}

/** A theme as a tiny slide: its ground, a title line in its text color and an accent line. */
function ThemeSwatch({ id }: { id: ThemeId }) {
  const { colors: c } = useTheme();
  const theme = themeOf(id);
  return (
    <View style={[styles.swatch, { backgroundColor: theme.colors.bg, borderColor: c.line2 }]}>
      <View style={[styles.swatchTitle, { backgroundColor: theme.colors.text }]} />
      <View style={[styles.swatchLine, { backgroundColor: theme.colors.accent }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  swatch: { width: 36, height: 22, borderRadius: 4, borderWidth: StyleSheet.hairlineWidth, padding: 4, gap: 3 },
  swatchTitle: { width: "70%", height: 4, borderRadius: 2 },
  swatchLine: { width: "40%", height: 3, borderRadius: 2 },
});
