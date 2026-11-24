import { type CodeSession, useCodeFiles, useCodeGitLog, useCodeSession } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import {
  GROUPED_ROW,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  SCREEN_X,
  SearchField,
  Segmented,
  SkeletonList,
  Text,
  useTheme,
} from "@/ui";
import { router } from "@/ui/navigation";
import { LoadFailed } from "../shared/FirstUse";
import { useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedHeader } from "../shared/parts";
import { folderEntries, sessionDiffHref, sessionFileHref, sessionFolderHref, splitPath } from "./logic";
import { useSessionMenu } from "./menu";
import { ChangeTile } from "./parts";

type Pane = "git" | "files";

/**
 * A session's code (ADR 0215), pushed from its conversation's bar: the web panel's Git and Files as the two views of
 * one screen (the app's segmented control), its name and branch in the bar. Git: the whole change since the base,
 * what isn't committed (as `git status` lists it) and the branch's commits, each opening its diff; Files: the
 * worktree's folders and files, a search over every path, each opening read-only. The next git step leads the Git view
 * (the web header's button); its "…" holds the rest of what the web's header holds: every git step (each asked of the
 * agent in words in the conversation, which the screen goes back to), who is in the session, its pull request and
 * closing it.
 */
export function SessionCodeScreen({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const c = useTheme().colors;
  const orgId = useOrgId();
  const session = useCodeSession(orgId, sessionId);
  const s = session.data;
  const more = useSessionMenu(s ?? null);
  const [pane, setPane] = useState<Pane>("git");
  return (
    <>
      <PushedHeader
        title={s?.title ?? t("codeSessions.title")}
        {...(s?.branch ? { subtitle: s.branch } : {})}
        grouped
        {...(more ? { actions: [more] } : {})}
      />
      {session.isLoading ? (
        <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: c.grouped }}>
          <SkeletonList rows={5} />
        </ScrollView>
      ) : !s ? (
        <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: c.grouped }}>
          {session.isError ? (
            <LoadFailed onRetry={() => void session.refetch()} />
          ) : (
            <Text variant="callout" tone="muted" style={styles.note}>
              {t("codeSessions.view.gone")}
            </Text>
          )}
        </ScrollView>
      ) : s.worktree.state !== "ready" ? (
        <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: c.grouped }}>
          <Text variant="callout" tone="muted" style={styles.note}>
            {s.worktree.state === "failed" ? t("codeSessions.view.failed") : t("codeSessions.panel.notReady")}
          </Text>
        </ScrollView>
      ) : (
        <SessionPanes session={s} pane={pane} onPane={setPane} />
      )}
    </>
  );
}

/** The two views under the segmented control, the screen scrolling as one. */
function SessionPanes({ session, pane, onPane }: { session: CodeSession; pane: Pane; onPane: (p: Pane) => void }) {
  const { t } = useTranslation();
  const c = useTheme().colors;
  const orgId = useOrgId();
  const working = session.work === "working";
  const log = useCodeGitLog(orgId, session.id, pane === "git", working);
  const files = useCodeFiles(orgId, session.id, pane === "files", working);
  const pull = usePullRefresh(pane === "git" ? log.refetch : files.refetch);
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: c.grouped }}
      contentContainerStyle={styles.body}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      <View style={styles.views}>
        <Segmented
          wide
          items={[
            { key: "git", label: t("codeSessions.gitTab.label") },
            { key: "files", label: t("codeSessions.files.label") },
          ]}
          value={pane}
          onChange={(k) => onPane(k as Pane)}
        />
      </View>
      {pane === "git" ? <GitPane session={session} log={log} /> : <FilesPane session={session} files={files} dir="" />}
    </ScrollView>
  );
}

/** Git: the whole change since the base, then what isn't committed, then the branch's commits. */
function GitPane({ session, log }: { session: CodeSession; log: ReturnType<typeof useCodeGitLog> }) {
  const { t, i18n } = useTranslation();
  const base = session.baseBranch ?? "main";
  if (log.isLoading) return <SkeletonList rows={4} />;
  if (log.isError || !log.data) return <LoadFailed onRetry={() => void log.refetch()} />;
  const data = log.data;
  const all = session.stat.at ? `+${session.stat.added} −${session.stat.removed}` : null;
  return (
    <>
      <GroupedList>
        <GroupedRow
          icon="list"
          label={t("codeSessions.gitTab.all", { base })}
          {...(all ? { value: all } : {})}
          chevron
          onPress={() => router.push(sessionDiffHref(session.id, { scope: "base" }) as never)}
        />
      </GroupedList>
      <GroupedHeader>{t("codeSessions.gitTab.uncommitted")}</GroupedHeader>
      {data.changes.length === 0 ? (
        <GroupedList>
          <GroupedRow icon="check" label={t("codeSessions.gitTab.clean")} faint />
        </GroupedList>
      ) : (
        <GroupedList>
          {data.changes.map((ch) => {
            const { name, dir } = splitPath(ch.path);
            const counts = ch.added === null && ch.removed === null ? null : `+${ch.added ?? 0} −${ch.removed ?? 0}`;
            return (
              <GroupedRow
                key={ch.path}
                leading={<ChangeTile status={ch.status} />}
                label={name}
                {...(dir ? { sub: dir } : {})}
                {...(counts ? { value: counts } : {})}
                chevron
                onPress={() =>
                  router.push(sessionDiffHref(session.id, { scope: "uncommitted", path: ch.path }) as never)
                }
              />
            );
          })}
        </GroupedList>
      )}
      <GroupedHeader>{t("codeSessions.gitTab.commits")}</GroupedHeader>
      {data.commits.length === 0 ? (
        <GroupedList>
          <GroupedRow icon="gitPull" label={t("codeSessions.gitTab.noCommits", { base })} faint />
        </GroupedList>
      ) : (
        <GroupedList>
          {data.commits.map((cm) => (
            <GroupedRow
              key={cm.sha}
              icon="gitPull"
              label={cm.subject}
              labelLines={2}
              sub={`${cm.short} · ${relativeTime(t, i18n.language, cm.at)}`}
              value={`+${cm.added} −${cm.removed}`}
              chevron
              onPress={() => router.push(sessionDiffHref(session.id, { scope: "commit", sha: cm.sha }) as never)}
            />
          ))}
        </GroupedList>
      )}
      {data.more ? <GroupedFooter>{t("codeSessions.gitTab.more")}</GroupedFooter> : null}
    </>
  );
}

/**
 * Files: one folder of the worktree (its folders, then its files; a changed file marked with its letter), or, while
 * searching, every path that matches. Used by the session's screen ("" is the top) and by a folder's own screen.
 */
export function FilesPane({
  session,
  files,
  dir,
}: {
  session: CodeSession;
  files: ReturnType<typeof useCodeFiles>;
  dir: string;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  if (files.isLoading) return <SkeletonList rows={6} />;
  if (files.isError || !files.data) return <LoadFailed onRetry={() => void files.refetch()} />;
  const changed = new Map(files.data.changes.map((ch) => [ch.path, ch.status]));
  const query = q.trim().toLowerCase();
  const found = query ? files.data.paths.filter((p) => p.toLowerCase().includes(query)).slice(0, 200) : null;
  const here = folderEntries(files.data.paths, dir);
  const fileRow = (path: string, withDir: boolean) => {
    const { name, dir: folder } = splitPath(path);
    const status = changed.get(path);
    return (
      <GroupedRow
        key={path}
        {...(status ? { leading: <ChangeTile status={status} /> } : { icon: "file" as const })}
        label={name}
        {...(withDir && folder ? { sub: folder } : {})}
        chevron
        onPress={() => router.push(sessionFileHref(session.id, path) as never)}
      />
    );
  };
  return (
    <>
      <View style={styles.search}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder={t("codeSessions.files.search")}
          accessibilityLabel={t("codeSessions.files.search")}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
      </View>
      {found ? (
        found.length === 0 ? (
          <Text variant="callout" tone="muted" style={styles.note}>
            {t("codeSessions.files.noMatch", { query: q.trim() })}
          </Text>
        ) : (
          <GroupedList>{found.map((p) => fileRow(p, true))}</GroupedList>
        )
      ) : here.folders.length + here.files.length === 0 ? (
        <Text variant="callout" tone="muted" style={styles.note}>
          {t("codeSessions.files.empty")}
        </Text>
      ) : (
        <GroupedList>
          {here.folders.map((f) => (
            <GroupedRow
              key={f.path}
              icon="drive"
              label={f.name}
              value={String(f.count)}
              chevron
              onPress={() => router.push(sessionFolderHref(session.id, f.path) as never)}
            />
          ))}
          {here.files.map((p) => fileRow(p, false))}
        </GroupedList>
      )}
      {files.data.truncated ? (
        <GroupedFooter>
          {t("codeSessions.files.truncated", {
            count: files.data.paths.length,
            formatted: String(files.data.paths.length),
          })}
        </GroupedFooter>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: SCREEN_X, paddingTop: 8, paddingBottom: 40 },
  views: { paddingBottom: 12 },
  search: { paddingBottom: 12 },
  note: { paddingHorizontal: GROUPED_ROW.padX, paddingTop: 16 },
  // The step's button and its words, on the grouped gray above the first group, at the groups' inset.
});
