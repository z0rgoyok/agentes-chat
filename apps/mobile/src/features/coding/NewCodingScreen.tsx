import { useCodeSessions, useCodeStart, useCreateCodeSession } from "@agenteschat/client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import {
  fieldText,
  GROUPED_ROW,
  GroupedField,
  GroupedFooter,
  GroupedList,
  Icon,
  Locked,
  MEDIA_ROW,
  SCREEN_X,
  Text,
  useTheme,
} from "@/ui";
import { router } from "@/ui/navigation";
import { AgentFace } from "../shared/Face";
import { useDirectory, useErrorToast, useOrgId } from "../shared/hooks";
import { pickOne } from "../shared/PickerSheet";
import { PushedHeader } from "../shared/parts";
import { codeDraft } from "./draft";
import { CODING_WHERE_HREF, isLocalRepo, sessionChatHref } from "./logic";

/**
 * New session (ADR 0215), pushed from Code: the web home's field and its two choices as a grouped form. What to do,
 * then the agent (the app's own picker, faces as the web's select) and where it works ("Where to work", its own
 * pushed screen: the agent's repositories, the projects only on its computer, or a new one); "Start" in the bar.
 * The last pick comes back as on the web: the first agent and its first repository otherwise. Starting it replaces
 * this screen with the session's conversation, so back goes to the list.
 */
export function NewCodingScreen() {
  const { t } = useTranslation();
  const c = useTheme().colors;
  const orgId = useOrgId();
  const dir = useDirectory();
  const start = useCodeStart(orgId);
  const sessions = useCodeSessions(orgId).data ?? [];
  const create = useCreateCodeSession(orgId);
  const failed = useErrorToast();
  const [text, setText] = useState("");
  const agents = start.data?.agents ?? [];
  const draft = useSyncExternalStore(codeDraft.subscribe, codeDraft.now, codeDraft.now);
  // The draft lives while this form does: open with the first agent and its first repository, closed when it goes.
  useEffect(() => {
    if (codeDraft.now() || agents.length === 0) return;
    const first = agents[0];
    if (!first) return;
    codeDraft.open({
      agentId: first.agentId,
      repo: first.repos[0] ?? "",
      repos: first.repos,
      locals: [],
      any: first.any,
    });
  }, [agents]);
  useEffect(() => () => codeDraft.close(), []);
  const picked = agents.find((a) => a.agentId === draft?.agentId) ?? null;
  // The projects only on this agent's computer that my sessions used, offered beside its repositories.
  const locals = useMemo(
    () => [...new Set(sessions.filter((s) => s.local && s.agentId === picked?.agentId).map((s) => s.repo))],
    [sessions, picked?.agentId],
  );
  useEffect(() => {
    if (picked) codeDraft.update((d) => ({ ...d, repos: picked.repos, locals, any: picked.any }));
  }, [picked, locals]);
  const repo = draft?.repo.trim() ?? "";
  const ready = Boolean(picked && repo && text.trim()) && !create.isPending;
  const name = (agentId: string) => dir.nameOf({ type: "agent", id: agentId }) || agentId;

  const pickAgent = () =>
    void pickOne({
      title: t("codeSessions.home.agent"),
      value: draft?.agentId ?? null,
      options: agents.map((a) => ({
        key: a.agentId,
        label: name(a.agentId),
        leading: { kind: "agent", agentId: a.agentId },
      })),
    }).then((key) => {
      const next = agents.find((a) => a.agentId === key);
      if (!next) return;
      codeDraft.update((d) => ({
        ...d,
        agentId: next.agentId,
        // Another agent's list may not have this repository: its first, unless a name of a local project was typed.
        repo: next.repos.includes(d.repo) || isLocalRepo(d.repo) ? d.repo : (next.repos[0] ?? ""),
        repos: next.repos,
        any: next.any,
      }));
    });

  const submit = () => {
    if (!ready || !picked) return;
    create.mutate(
      { agentId: picked.agentId, repo, text: text.trim() },
      {
        onSuccess: (session) => router.replace(sessionChatHref(session) as never),
        onError: failed,
      },
    );
  };

  return (
    <>
      <PushedHeader
        title={t("codeSessions.list.new")}
        grouped
        action={{ label: t("codeSessions.home.start"), onPress: submit, disabled: !ready }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        style={{ backgroundColor: c.grouped }}
        contentContainerStyle={styles.body}
      >
        <Locked when={create.isPending}>
          {agents.length === 0 && start.isSuccess ? (
            <Text variant="callout" tone="muted" style={styles.none}>
              {t("codeSessions.home.noAgents")}
            </Text>
          ) : (
            <>
              <GroupedList>
                <View style={styles.field}>
                  <TextInput
                    value={text}
                    onChangeText={setText}
                    placeholder={t("codeSessions.home.placeholder")}
                    placeholderTextColor={c.faint}
                    accessibilityLabel={t("codeSessions.home.label")}
                    multiline
                    autoFocus
                    textAlignVertical="top"
                    style={[styles.input, { color: c.ink }]}
                  />
                </View>
              </GroupedList>
              <GroupedFooter>{t("codeSessions.home.hint")}</GroupedFooter>
              <GroupedList>
                <GroupedField label={t("codeSessions.home.agent")} onPress={pickAgent}>
                  {picked ? (
                    <View style={styles.value}>
                      <AgentFace agentId={picked.agentId} size={MEDIA_ROW.row.face} live={false} />
                      <Text variant="body" numberOfLines={1} style={styles.grow}>
                        {name(picked.agentId)}
                      </Text>
                    </View>
                  ) : null}
                </GroupedField>
                {/* "Project": the web's "Where to work" wrapped in the field's 96-point label column on a phone. */}
                <GroupedField
                  label={t("mobile.coding.project")}
                  onPress={() => router.push(CODING_WHERE_HREF as never)}
                >
                  <View style={styles.value}>
                    <Icon name={isLocalRepo(repo) ? "laptop" : "gitPull"} size={18} color={c.muted} />
                    <Text variant="body" tone={repo ? "ink" : "faint"} numberOfLines={1} style={styles.grow}>
                      {repo || t("codeSessions.home.repoPlaceholder")}
                    </Text>
                  </View>
                </GroupedField>
              </GroupedList>
              <GroupedFooter>{t("codeSessions.home.repoNote")}</GroupedFooter>
            </>
          )}
        </Locked>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: SCREEN_X, paddingTop: 12, paddingBottom: 32 },
  field: { minHeight: GROUPED_ROW.minHeight * 2, paddingHorizontal: GROUPED_ROW.padX, paddingVertical: 10 },
  input: { flex: 1, minHeight: 72, ...fieldText("body") },
  value: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
  grow: { flex: 1, minWidth: 0 },
  none: { paddingHorizontal: 4, paddingTop: 16 },
});
