import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/ui";
import { PickList } from "../shared/PickList";
import { goBack, PushedHeader } from "../shared/parts";
import { chooseBrain, useBrainPick } from "./brain-pick";

/**
 * The web's "Quem pensa" on a new agent's last step, pushed from its row (ADR 0135: screens, never sheets): every model
 * and plan the agent's page offers (`brainPickOptions`), searched by name, maker, plan or "free", in their groups, the
 * chosen one checked. A choice goes back at once.
 */
export function BrainPickScreen() {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const pick = useBrainPick();
  // Opened with no form under it (its address on its own): nothing to choose for.
  useEffect(() => {
    if (!pick) goBack();
  }, [pick]);
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("brain.title")} solid={false} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={[styles.in, { paddingBottom: 24 + insets.bottom }]}
      >
        {pick ? (
          <PickList
            options={pick.options}
            value={pick.value}
            onPick={(o) => {
              chooseBrain(o);
              goBack();
            }}
            placeholder={t("newAgent.brainPick.searchPlaceholder")}
            searchLabel={t("models.search")}
            noResults={t("models.noResults")}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 4 },
});
