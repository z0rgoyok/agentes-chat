import { useCodeFile } from "@agenteschat/client";
import { codeLangOfPath, highlightCode } from "@agenteschat/client/lib/code";
import { formatBytes } from "@agenteschat/client/lib/files";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { EmptyState, SkeletonList, useTheme } from "@/ui";
import { CodeText } from "../chat/CodeCard";
import { LoadFailed } from "../shared/FirstUse";
import { useOrgId } from "../shared/hooks";
import { PushedHeader } from "../shared/parts";
import { splitPath } from "./logic";

/**
 * A file of a session's worktree, read-only (ADR 0215), pushed from Files or a search: its name in the bar and its
 * folder under it, its lines numbered and in the code's colors (the app's highlighter, as a message's code in full),
 * across the screen's width with long lines scrolling sideways, or wrapped from the bar. Why it doesn't show, in words,
 * when it can't (a binary, a `.env`, ignored by git, a link out, gone); only its start when it is large.
 */
export function FileScreen({ sessionId, path }: { sessionId: string; path: string }) {
  const { t, i18n } = useTranslation();
  const c = useTheme().colors;
  const orgId = useOrgId();
  const file = useCodeFile(orgId, sessionId, path);
  const [wrap, setWrap] = useState(false);
  const { name, dir } = splitPath(path);
  const data = file.data;
  const lines = data?.state === "ok" ? highlightCode(data.content, codeLangOfPath(path)) : [];
  return (
    <>
      <PushedHeader
        title={name}
        {...(dir ? { subtitle: dir } : {})}
        actions={[
          {
            icon: "text",
            sf: wrap ? "arrow.left.and.right.text.vertical" : "text.alignleft",
            label: t("mobile.code.wrap"),
            onPress: () => setWrap((w) => !w),
          },
        ]}
      />
      <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: c.bg }}>
        {file.isLoading ? (
          <SkeletonList rows={8} />
        ) : file.isError || !data ? (
          <LoadFailed onRetry={() => void file.refetch()} />
        ) : data.state !== "ok" ? (
          <View style={styles.why}>
            <EmptyState size="panel" icon="file" title={t(`codeSessions.files.state.${data.state}`)} />
          </View>
        ) : (
          <>
            {wrap ? (
              <View style={styles.code}>
                <CodeText lines={lines} numbered wrap />
              </View>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.code}>
                <CodeText lines={lines} numbered />
              </ScrollView>
            )}
            {data.truncated ? (
              <View style={styles.cut}>
                <EmptyState
                  size="inline"
                  title={t("codeSessions.files.cut", { size: formatBytes(i18n.language, data.content.length) })}
                />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  code: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 },
  why: { paddingTop: 48 },
  cut: { paddingBottom: 32 },
});
