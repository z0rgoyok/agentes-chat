import { pickGroups } from "@agenteschat/client/lib/brain-picker";
import { matchesWords } from "@agenteschat/ui/search";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, SCREEN_X, SearchField, useTheme } from "@/ui";
import { Gap } from "../settings/parts";
import { goBack, PushedHeader } from "../shared/parts";
import { chooseOption, PICK_SEARCH_FROM, pickText, useOptionPick } from "./option-pick";

/**
 * One of many, pushed from a form (screens, never a list opened in place): the options in their groups, each with
 * its tile or logo and its quieter line, the one in use checked, a search past a handful of them. Choosing one goes
 * back to the form at once; in a pick of several each tap checks or unchecks it, the form follows, and "Pronto" in
 * the bar goes back. A search that finds nothing says so, with a way to clear it. Built as `AgentPickScreen`.
 */
export function OptionPickScreen() {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const pick = useOptionPick();
  const [query, setQuery] = useState("");
  // Opened with no form under it (its address on its own): nothing to pick for.
  useEffect(() => {
    if (!pick) goBack();
  }, [pick]);
  const options = pick?.options ?? [];
  const searchable = Boolean(pick) && (pick?.search ?? options.length >= PICK_SEARCH_FROM);
  const typed = query.trim();
  const groups = useMemo(
    () => pickGroups(typed ? options.filter((o) => matchesWords(pickText(o), typed)) : options),
    [options, typed],
  );
  const many = pick?.many === true;
  const checked = (key: string) => (pick?.many ? pick.values.includes(key) : key === pick?.value);
  const choose = (key: string) => {
    chooseOption(key);
    if (!many) goBack();
  };
  const searchLabel = pick?.searchLabel ?? t("mobile.search.placeholder");
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={pick?.title ?? ""}
        solid={false}
        grouped
        {...(many ? { action: { label: t("mobile.common.done"), onPress: goBack } } : {})}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={[styles.in, { paddingBottom: 24 + insets.bottom }]}
      >
        {searchable ? (
          <View style={styles.search}>
            <SearchField
              value={query}
              onChangeText={setQuery}
              placeholder={searchLabel}
              accessibilityLabel={searchLabel}
              autoCorrect={false}
              returnKeyType="search"
            />
          </View>
        ) : null}
        {pick
          ? groups.map((g, i) => (
              // The first group without a title sits under the search; the next ones keep a gap between cards.
              <View key={g.group ?? `~${i}`}>
                {g.group ? <GroupedHeader>{g.group}</GroupedHeader> : i > 0 ? <Gap /> : null}
                <GroupedList>
                  {g.options.map((o) => (
                    <GroupedRow
                      key={o.key}
                      label={o.label}
                      labelLines={2}
                      {...(o.sub ? { sub: o.sub, subLines: o.subLines ?? 2 } : {})}
                      {...(o.leading ? { leading: o.leading } : o.icon ? { icon: o.icon } : {})}
                      checked={checked(o.key)}
                      onPress={() => choose(o.key)}
                    />
                  ))}
                </GroupedList>
              </View>
            ))
          : null}
        {pick && typed && groups.length === 0 ? (
          <>
            <GroupedFooter>{t("mobile.picker.none", { text: typed })}</GroupedFooter>
            <Gap />
            <GroupedList>
              <GroupedRow icon="x" label={t("filters.clearSearch")} onPress={() => setQuery("")} />
            </GroupedList>
          </>
        ) : null}
        {pick?.note && groups.length > 0 ? <GroupedFooter>{pick.note}</GroupedFooter> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: SCREEN_X, paddingTop: 4 },
  search: { paddingBottom: 12 },
});
