import { useCodeFiles, useCodeSession } from "@agenteschat/client";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, StyleSheet } from "react-native";
import { SCREEN_X, SkeletonList, useTheme } from "@/ui";
import { useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedHeader } from "../shared/parts";
import { splitPath } from "./logic";
import { FilesPane } from "./SessionCodeScreen";

/**
 * A folder of a session's worktree (ADR 0215), pushed from Files as the system's Files app goes into a folder: its
 * name in the bar and where it is under it, its folders and files, and the search over the whole worktree.
 */
export function FolderScreen({ sessionId, dir }: { sessionId: string; dir: string }) {
  const { t } = useTranslation();
  const c = useTheme().colors;
  const orgId = useOrgId();
  const session = useCodeSession(orgId, sessionId).data;
  const files = useCodeFiles(orgId, sessionId, true, session?.work === "working");
  const pull = usePullRefresh(files.refetch);
  const { name, dir: parent } = splitPath(dir);
  return (
    <>
      <PushedHeader title={name || t("codeSessions.files.label")} {...(parent ? { subtitle: parent } : {})} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        style={{ backgroundColor: c.grouped }}
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      >
        {session ? <FilesPane session={session} files={files} dir={dir} /> : <SkeletonList rows={6} />}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: SCREEN_X, paddingTop: 8, paddingBottom: 40 },
});
