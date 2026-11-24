import { type CodeDiffScope, useCodeDiff, useCodeSession } from "@agenteschat/client";
import { parsePatch } from "@agenteschat/client/lib/artifacts";
import type { DiffLine } from "@agenteschat/ui/diff";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import {
  DiffView,
  GROUPED_ROW,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  SCREEN_X,
  SkeletonList,
  Text,
  useTheme,
} from "@/ui";
import { LoadFailed } from "../shared/FirstUse";
import { useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedHeader } from "../shared/parts";
import { splitPath } from "./logic";

/** A unified patch as the app's diff lines: its hunks run on (the view folds what stays the same). */
function patchLines(patch: string): DiffLine[] {
  return parsePatch(patch).flatMap((l) => (l.kind === "hunk" ? [] : [{ kind: l.kind, text: l.text }]));
}

/**
 * A diff in a session (ADR 0215), pushed from Git: the whole change since its base, one change not committed, or one
 * commit, read in the worktree. Its name in the bar and its size under it; each file under its path, as the app's diff
 * draws a change (added lines green, removed ones red and struck). Too large to send: the files that changed, each with
 * its counts.
 */
export function DiffScreen({
  sessionId,
  scope,
  path,
  sha,
}: {
  sessionId: string;
  scope: CodeDiffScope;
  path: string | null;
  sha: string | null;
}) {
  const { t } = useTranslation();
  const c = useTheme().colors;
  const orgId = useOrgId();
  const session = useCodeSession(orgId, sessionId).data;
  const diff = useCodeDiff(orgId, sessionId, scope, scope !== "commit" || Boolean(sha), sha ?? undefined);
  const pull = usePullRefresh(diff.refetch);
  // One change not committed: that file of the worktree's uncommitted diff.
  const files = useMemo(
    () => (diff.data?.files ?? []).filter((f) => scope !== "uncommitted" || !path || f.path === path),
    [diff.data, scope, path],
  );
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const title =
    scope === "commit"
      ? t("mobile.coding.commit", { short: (sha ?? "").slice(0, 7) })
      : scope === "uncommitted" && path
        ? splitPath(path).name
        : t("codeSessions.gitTab.all", { base: session?.baseBranch ?? "main" });
  return (
    <>
      <PushedHeader title={title} {...(diff.data ? { subtitle: `+${added} −${removed}` } : {})} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: c.grouped }}
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      >
        {diff.isLoading ? (
          <SkeletonList rows={6} />
        ) : diff.isError || !diff.data ? (
          <LoadFailed onRetry={() => void diff.refetch()} />
        ) : files.length === 0 ? (
          <Text variant="callout" tone="muted" style={styles.note}>
            {t("codeSessions.gitTab.none")}
          </Text>
        ) : diff.data.truncated ? (
          <>
            <Text variant="callout" tone="muted" style={styles.note}>
              {t("codeSessions.gitTab.tooLarge")}
            </Text>
            <GroupedList>
              {files.map((f) => (
                <GroupedRow key={f.path} icon="file" label={f.path} value={`+${f.added} −${f.removed}`} />
              ))}
            </GroupedList>
          </>
        ) : (
          files.map((f) => (
            <View key={f.path}>
              <GroupedHeader>{`${f.path}  +${f.added} −${f.removed}`}</GroupedHeader>
              <DiffView lines={patchLines(f.patch)} />
            </View>
          ))
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: SCREEN_X, paddingTop: 4, paddingBottom: 40 },
  note: { paddingHorizontal: GROUPED_ROW.padX, paddingTop: 16, paddingBottom: 12 },
});
