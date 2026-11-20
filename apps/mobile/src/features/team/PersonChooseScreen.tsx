import { PEOPLE_SEARCH_FROM } from "@agenteschat/client/lib/roles";
import { matchesWords } from "@agenteschat/ui/search";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupedFooter, GroupedList, GroupedRow, SearchField, useTheme } from "@/ui";
import { Face } from "../shared/Face";
import { goBack, PushedHeader, tapHaptic } from "../shared/parts";
import { choosePerson, usePersonChoose } from "./person-choose";

/**
 * A person to choose, pushed from a form (ADR 0135: screens, never sheets), drawn as the agent picker: "Ninguém" first
 * when the form offers it, then each person with their photo and a quieter line, the one chosen checked, a search past
 * a handful. A choice goes back at once.
 */
export function PersonChooseScreen() {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const pick = usePersonChoose();
  const [query, setQuery] = useState("");
  // Opened with no form under it (its address on its own): nothing to choose for.
  useEffect(() => {
    if (!pick) goBack();
  }, [pick]);
  const people = pick?.people ?? [];
  const searching = query.trim() !== "";
  const shown = searching ? people.filter((p) => matchesWords(`${p.name} ${p.sub ?? ""}`, query)) : people;
  const choose = (userId: string | null) => {
    tapHaptic();
    choosePerson(userId);
    goBack();
  };
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={pick?.title ?? ""} solid={false} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={[styles.in, { paddingBottom: 24 + insets.bottom }]}
      >
        {people.length > PEOPLE_SEARCH_FROM ? (
          <View style={styles.search}>
            <SearchField
              value={query}
              onChangeText={setQuery}
              placeholder={t("rolesPage.searchPeople")}
              accessibilityLabel={t("rolesPage.searchPeople")}
            />
          </View>
        ) : null}
        {pick && (shown.length > 0 || (pick.none && !searching)) ? (
          <GroupedList>
            {pick.none && !searching ? (
              <GroupedRow
                key="none"
                icon="x"
                label={pick.none}
                checked={pick.picked === null}
                onPress={() => choose(null)}
              />
            ) : null}
            {shown.map((p) => (
              <GroupedRow
                key={p.userId}
                leading={<Face who={{ type: "person", id: p.userId }} size={36} live={false} />}
                label={p.name}
                {...(p.sub ? { sub: p.sub } : {})}
                checked={p.userId === pick.picked}
                onPress={() => choose(p.userId)}
              />
            ))}
          </GroupedList>
        ) : null}
        {pick && searching && shown.length === 0 ? (
          // A search that names nobody says so, and offers to clear it.
          <>
            <GroupedFooter>{t("rolesPage.holders.noMatch", { q: query.trim() })}</GroupedFooter>
            <GroupedList>
              <GroupedRow icon="x" label={t("filters.clearSearch")} onPress={() => setQuery("")} />
            </GroupedList>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 4 },
  search: { paddingBottom: 12 },
});
