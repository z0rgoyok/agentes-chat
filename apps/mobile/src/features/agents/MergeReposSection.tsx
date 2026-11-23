import { useAgentMergeRepos, useAgentRepos, useGitHubRepos, useSetAgentMergeRepos } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { mergeChoices } from "@agenteschat/client/lib/repos";
import { matchesWords } from "@agenteschat/ui/search";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { EmptyState, GroupedFooter, GroupedHeader, GroupedList, GroupedRow, SearchField, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { RowBones } from "../roles/parts";
import { SettingsPage } from "../settings/parts";
import { LoadFailed } from "../shared/FirstUse";
import { useDirectory, useOrgId } from "../shared/hooks";

/** Opens where an agent merges with no approval card, on its own screen. */
const openMergeRepos = (agentId: string) => router.push(`/agent-merge/${agentId}` as never);

/**
 * "Pode fazer merge sem perguntar", as under GitHub on the web's Ferramentas e acesso: where the agent merges with no
 * approval card. Its owner or an admin chooses on a screen of its own (`MergeReposScreen`). Shown only when there is
 * something chosen, or something to choose. A grouped list with its header and footer, as the profile's Access view.
 */
export function MergeReposSection({ agentId, mayEdit }: { agentId: string; mayEdit: boolean }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const merge = useAgentMergeRepos(orgId, agentId);
  const reach = useAgentRepos(orgId, agentId, mayEdit);
  const listing = useGitHubRepos(orgId, mayEdit);
  const list = merge.data ?? [];
  const choices = mergeChoices(listing.data, reach.data ?? []);
  if (!merge.data || (list.length === 0 && !(mayEdit && choices.length > 0))) return null;
  return (
    <>
      <GroupedHeader>{t("repos.merge.label")}</GroupedHeader>
      <GroupedList>
        {list.map((repo) => (
          <GroupedRow key={repo} label={repo} icon="code" />
        ))}
        {mayEdit ? (
          <GroupedRow
            label={list.length === 0 ? t("repos.choose") : t("repos.change")}
            chevron
            onPress={() => openMergeRepos(agentId)}
          />
        ) : null}
      </GroupedList>
      {list.length === 0 ? (
        <GroupedFooter>{t("repos.merge.none")}</GroupedFooter>
      ) : (
        <GroupedFooter
          hint={{ name: t("common.about", { label: t("repos.merge.label") }), text: t("repos.merge.help") }}
        >
          {t("repos.merge.short")}
        </GroupedFooter>
      )}
    </>
  );
}

/**
 * Where the agent merges without asking, pushed from its row (ADR 0135: screens, never sheets): the repositories it
 * already uses, searchable (the search first under the title, what the switches do under them), each a switch saved
 * at once. A switch flips on the tap and only its own row waits for its save; a refused save goes back to what is
 * saved.
 */
export function MergeReposScreen({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const name = useDirectory().anyAgent(agentId)?.name ?? "";
  const merge = useAgentMergeRepos(orgId, agentId);
  const save = useSetAgentMergeRepos(orgId, agentId);
  const reach = useAgentRepos(orgId, agentId);
  const listing = useGitHubRepos(orgId);
  const [q, setQ] = useState("");
  // The repositories whose switch was flipped and whose save is on its way: each waits for its own.
  const [flipping, setFlipping] = useState<ReadonlySet<string>>(() => new Set());
  // The list as the last save sends it, while it is on its way (each save sends the whole list): a switch flips on
  // the tap, and a refused save goes back to what is saved.
  const list = (save.isPending ? save.variables : undefined) ?? merge.data ?? [];
  const choices = mergeChoices(listing.data, reach.data ?? []);
  const shown = choices.filter((repo) => !q.trim() || matchesWords(repo, q));
  const toggle = (repo: string) => {
    if (flipping.has(repo)) return;
    setFlipping((now) => new Set(now).add(repo));
    void save
      .mutateAsync(list.includes(repo) ? list.filter((r) => r !== repo) : [...list, repo])
      .catch(() => toast({ title: t("mobile.app.failed"), icon: "x" }))
      .finally(() =>
        setFlipping((now) => {
          const left = new Set(now);
          left.delete(repo);
          return left;
        }),
      );
  };
  const failed = (merge.isError && !merge.data) || (reach.isError && !reach.data);
  const loading = !merge.data || !reach.data || listing.isPending;
  return (
    <SettingsPage title={t("repos.merge.dialogTitle", agentGrammar(name))}>
      {failed ? (
        // What didn't load is never an empty list: what happened, and the way to ask again.
        <LoadFailed
          onRetry={() => {
            void merge.refetch();
            void reach.refetch();
            void listing.refetch();
          }}
        />
      ) : loading ? (
        // The rows' own shape while they load, never a spinner.
        <GroupedList>
          <RowBones />
          <RowBones name={56} />
          <RowBones name={34} />
        </GroupedList>
      ) : (
        <>
          {choices.length > 0 ? (
            <View style={styles.search}>
              <SearchField
                value={q}
                onChangeText={setQ}
                placeholder={t("repos.search")}
                accessibilityLabel={t("repos.search")}
                autoCorrect={false}
                autoCapitalize="none"
              />
            </View>
          ) : null}
          <GroupedList>
            {shown.map((repo) => (
              <GroupedRow
                key={repo}
                icon="code"
                label={repo}
                toggle={list.includes(repo)}
                onPress={() => toggle(repo)}
              />
            ))}
          </GroupedList>
          {/* What the switches do, under them: the search stays first under the title. With nothing it uses yet, the
              same words say why the page is empty. */}
          {choices.length === 0 ? (
            <EmptyState icon="code" title={t("repos.none")} subtitle={t("repos.merge.dialogDesc")} />
          ) : shown.length > 0 ? (
            <GroupedFooter>{t("repos.merge.dialogDesc")}</GroupedFooter>
          ) : null}
          {q.trim() && shown.length === 0 ? (
            // A search that names nothing says so, and offers to clear it.
            <>
              <GroupedFooter>{t("repos.noMatch", { q: q.trim() })}</GroupedFooter>
              <GroupedList>
                <GroupedRow icon="x" label={t("filters.clearSearch")} onPress={() => setQ("")} />
              </GroupedList>
            </>
          ) : null}
        </>
      )}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  search: { paddingTop: 10, paddingBottom: 14 },
});
