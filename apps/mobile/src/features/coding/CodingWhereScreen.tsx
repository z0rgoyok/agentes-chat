import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, SCREEN_X, SearchField, useTheme } from "@/ui";
import { router } from "@/ui/navigation";
import { PushedHeader } from "../shared/parts";
import { codeDraft } from "./draft";

/** The shapes the server takes (ADR 0215 §1): a GitHub repository, or a local project's name (no owner). */
const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/;
const LOCAL_NAME = /^(?!\.)[A-Za-z0-9._-]{1,64}$/;

/**
 * Where to work (ADR 0215), pushed from a new session's form: the web's repository picker as its own screen. The
 * search, the agent's repositories and the projects only on its computer used before (the chosen one checked), and a
 * name typed that isn't listed offered as a new one: a new project on the computer, or `owner/name` where the agent's
 * list allows any. A pick goes back to the form. Opened on its own (after a restart, nothing to pick for), it goes back.
 */
export function CodingWhereScreen() {
  const { t } = useTranslation();
  const c = useTheme().colors;
  const draft = useSyncExternalStore(codeDraft.subscribe, codeDraft.now, codeDraft.now);
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!codeDraft.now()) router.back();
  }, []);
  if (!draft) return null;
  const query = q.trim().replace(/\/+$/, "");
  const all = [
    ...draft.repos.map((value) => ({ value, local: false })),
    ...draft.locals.filter((l) => !draft.repos.includes(l)).map((value) => ({ value, local: true })),
  ];
  const shown = all.filter((r) => !query || r.value.toLowerCase().includes(query.toLowerCase()));
  const listed = all.some((r) => r.value.toLowerCase() === query.toLowerCase());
  const creates =
    !query || listed ? null : LOCAL_NAME.test(query) ? "local" : draft.any && GITHUB_REPO.test(query) ? "repo" : null;
  const pick = (repo: string) => {
    codeDraft.update((d) => ({ ...d, repo }));
    router.back();
  };
  return (
    <>
      <PushedHeader title={t("codeSessions.home.repo")} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        style={{ backgroundColor: c.grouped }}
        contentContainerStyle={styles.body}
      >
        <View style={styles.search}>
          <SearchField
            value={q}
            onChangeText={setQ}
            // One line on the phone: the web's "Search, or type owner/name or a new name" was cut; the note below says
            // the rest.
            placeholder={t("mobile.coding.whereSearch")}
            accessibilityLabel={t("codeSessions.home.repoSearch")}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => {
              const first = shown[0]?.value ?? (creates ? query : null);
              if (first) pick(first);
            }}
          />
        </View>
        {creates ? (
          <GroupedList>
            <GroupedRow
              icon="plus"
              label={
                creates === "local"
                  ? t("codeSessions.home.newLocal", { name: query })
                  : t("codeSessions.home.useRepo", { repo: query })
              }
              onPress={() => pick(query)}
            />
          </GroupedList>
        ) : null}
        {shown.length > 0 ? (
          <>
            {creates ? <GroupedHeader>{t("mobile.coding.listed")}</GroupedHeader> : null}
            <GroupedList>
              {shown.map((r) => (
                <GroupedRow
                  key={r.value}
                  icon={r.local ? "laptop" : "gitPull"}
                  label={r.value}
                  {...(r.local ? { sub: t("codeSessions.list.local") } : {})}
                  checked={r.value === draft.repo}
                  onPress={() => pick(r.value)}
                />
              ))}
            </GroupedList>
          </>
        ) : null}
        <GroupedFooter>{t("codeSessions.home.repoNote")}</GroupedFooter>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: SCREEN_X, paddingTop: 8, paddingBottom: 32 },
  search: { paddingBottom: 12 },
});
