import { useAuthConfig } from "@agenteschat/client";
import { showsAbout } from "@agenteschat/client/lib/about";
import { markTerms, searchTerms } from "@agenteschat/client/lib/search-filters";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { EmptyState, GroupedHeader, GroupedList, GroupedRow, SearchField, useTheme } from "@/ui";
import { router } from "@/ui/navigation";
import { useAppIcon } from "../me/app-icon";
import { useMePickers } from "../me/pickers";
import { PushedHeader } from "../shared/parts";
import { usePersonalView } from "./hooks";
import { type FoundSetting, findSettings, type SettingEntry, settingsIndex } from "./settings-search";

/** Between the parts of where a setting lives ("Você › Preferências"). */
export const PATH_SEPARATOR = " › ";

/** The settings this person has here, found by `q` (`findSettings`), in their language. */
export function useFoundSettings(q: string): FoundSetting[] {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { others } = usePersonalView();
  const icon = useAppIcon();
  const about = showsAbout(useAuthConfig().data);
  const appIcon = icon.supported && icon.icon !== null;
  const index = useMemo(() => settingsIndex({ org, others, appIcon, about }), [org, others, appIcon, about]);
  return useMemo(() => findSettings(q, index, (key) => t(key)), [q, index, t]);
}

/**
 * Where a found setting goes: its screen pushed, or the menu it changes in (Sons, Aparência). The same function every
 * render (the menus read the latest choice), so the rows that hold it are not drawn again.
 */
export function useOpenSetting() {
  const pickers = useMePickers();
  const latest = useRef(pickers);
  latest.current = pickers;
  return useCallback((entry: SettingEntry) => {
    if (entry.pick === "sounds") latest.current.pickSound();
    else if (entry.pick === "appearance") latest.current.pickTheme();
    else if (entry.href) router.push(entry.href as never);
  }, []);
}

/**
 * Settings found by name, pushed from Você's magnifier: the field up top with the keyboard (the screen opens to type
 * in it), then what it finds in two groups, the person's own (Você) and the workspace's, each row with its tile, its
 * name with the words looked for lit, and where it lives ("Configurações › Pessoas"). A tap opens it, as its row does
 * where it lives; Sons and Aparência open their menu in place. Only what this person has here: the workspace's as its
 * settings list them for them (ADR 0085).
 */
export function SettingsSearchScreen() {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState("");
  const found = useFoundSettings(q);
  const openSetting = useOpenSetting();
  const terms = useMemo(() => searchTerms(q), [q]);
  const groups = [
    { scope: "me", title: t("mobile.me.title"), rows: found.filter((f) => f.entry.scope === "me") },
    {
      scope: "workspace",
      title: t("mobile.settingsSearch.workspace"),
      rows: found.filter((f) => f.entry.scope === "workspace"),
    },
  ];
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("mobile.settingsSearch.title")} solid={false} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={[styles.in, { paddingBottom: 24 + insets.bottom }]}
      >
        <View style={styles.search}>
          <SearchField
            value={q}
            onChangeText={setQ}
            placeholder={t("mobile.settingsSearch.placeholder")}
            accessibilityLabel={t("mobile.settingsSearch.placeholder")}
            autoFocus
            autoCorrect={false}
            autoCapitalize="none"
          />
        </View>
        {groups.map((g) =>
          g.rows.length > 0 ? (
            <View key={g.scope}>
              <GroupedHeader>{g.title}</GroupedHeader>
              <GroupedList>
                {g.rows.map((f) => (
                  <GroupedRow
                    key={f.entry.id}
                    icon={f.entry.icon}
                    label={f.name}
                    labelParts={markTerms(f.name, terms)}
                    sub={f.where.join(PATH_SEPARATOR)}
                    {...(f.entry.pick ? { menu: true } : { chevron: true })}
                    onPress={() => openSetting(f.entry)}
                  />
                ))}
              </GroupedList>
            </View>
          ) : null,
        )}
        {q.trim() && found.length === 0 ? (
          <EmptyState size="inline" title={t("mobile.find.nothing", { q: q.trim() })} />
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
