import { type CodeSession, useCodeSessions } from "@agenteschat/client";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet, View } from "react-native";
import Animated, { FadeIn, LayoutAnimationConfig } from "react-native-reanimated";
import { GroupedHeader, GroupedList, GroupedRow, MEDIA_ROW, SCREEN_X, SkeletonList, useReducedMotion } from "@/ui";
import { router } from "@/ui/navigation";
import { AgentFace } from "../shared/Face";
import { FirstUse, LoadFailed } from "../shared/FirstUse";
import { useDirectory, useOrgId, usePullRefresh } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { RowWorkingLine } from "../shared/RowWorkingLine";
import { usePresenceOf } from "../status/hooks";
import { CODING_NEW_HREF, sessionChatHref, sessionStateKey, sessionsByRepo, statWords } from "./logic";

/** Sessions whose agent's face moves (a long list stays light). */
const LIVE_ROWS = 8;

type Presence = ReturnType<typeof usePresenceOf>;

/**
 * Code, pushed from You (ADR 0215, the web's Code page on the phone): the large title, "New session" as the bar's
 * "+" (with none yet, the empty state's own button). What waits on me comes first, in a group of its own (each with its
 * project), then the rest by project, the newest first, as the web's list reads them: the project, and "on the computer"
 * for one only on the agent's computer, as the group's head. Each session: its agent's face (working while it works),
 * its name, then what the agent does there right now in words with its orbit (the agents' line, while that work is
 * this session's), else its state in words; the change's size at the end. A row opens the session's conversation.
 */
export function CodingScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const sessions = useCodeSessions(orgId);
  const presence = usePresenceOf();
  const pull = usePullRefresh(sessions.refetch);
  const reduced = useReducedMotion();
  const { waiting, groups } = useMemo(() => {
    const list = sessions.data ?? [];
    return {
      waiting: list.filter((s) => s.work === "waiting").sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt)),
      groups: sessionsByRepo(list.filter((s) => s.work !== "waiting")),
    };
  }, [sessions.data]);
  const openNew = () => router.push(CODING_NEW_HREF as never);
  let row = 0;
  return (
    <PushedLargeTitle
      title={t("codeSessions.title")}
      grouped
      actions={[{ icon: "plus", sf: "plus", label: t("codeSessions.list.new"), onPress: openNew }]}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {sessions.isLoading ? (
        // Loading: the rows' own shape, never a spinner.
        <SkeletonList rows={4} />
      ) : sessions.isError && !sessions.data ? (
        <LoadFailed onRetry={() => void sessions.refetch()} />
      ) : waiting.length + groups.length === 0 ? (
        <FirstUse place="coding" acts label={t("codeSessions.list.new")} onPress={openNew} />
      ) : (
        <Animated.View entering={reduced ? undefined : FadeIn.duration(160)}>
          <LayoutAnimationConfig skipEntering>
            <View style={styles.in}>
              {waiting.length > 0 ? (
                <View>
                  <GroupedHeader>{t("mobile.coding.waiting")}</GroupedHeader>
                  <GroupedList>
                    {waiting.map((s) => (
                      <SessionRow key={s.id} session={s} live={row++ < LIVE_ROWS} presence={presence} withProject />
                    ))}
                  </GroupedList>
                </View>
              ) : null}
              {groups.map((g) => (
                <View key={g.repo}>
                  <GroupedHeader>{g.local ? `${g.repo} · ${t("codeSessions.list.local")}` : g.repo}</GroupedHeader>
                  <GroupedList>
                    {g.sessions.map((s) => (
                      <SessionRow key={s.id} session={s} live={row++ < LIVE_ROWS} presence={presence} />
                    ))}
                  </GroupedList>
                </View>
              ))}
            </View>
          </LayoutAnimationConfig>
        </Animated.View>
      )}
    </PushedLargeTitle>
  );
}

/**
 * One session: its agent's face, its name, then what its agent does there now (or its state in words; in the
 * waiting group, its project) and the change's size.
 */
function SessionRow({
  session,
  live,
  presence,
  withProject = false,
}: {
  session: CodeSession;
  live: boolean;
  presence: Presence;
  withProject?: boolean;
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const state = sessionStateKey(session);
  const stat = statWords(session);
  const working = session.work === "working" || session.work === "preparing";
  // The agents' line says what it does now; only this session's work is told here (it may work elsewhere too).
  const shown = presence.agent(session.agentId);
  const doing =
    session.work === "working" && shown?.work?.channelId === session.channelId && shown.line ? shown.line.text : null;
  const project = session.local ? `${session.repo} · ${t("codeSessions.list.local")}` : session.repo;
  return (
    <GroupedRow
      leading={
        <AgentFace agentId={session.agentId} size={MEDIA_ROW.row.face} live={live} mode={working ? "run" : "idle"} />
      }
      label={session.title}
      labelLines={2}
      {...(doing
        ? { below: <RowWorkingLine color={agentLook(dir.agentById.get(session.agentId)).color} text={doing} /> }
        : withProject
          ? { sub: project }
          : {
              sub: state.pr !== null ? t(state.key, { number: state.pr }) : t(state.key),
              ...(state.waiting ? { subTone: "amber" as const } : {}),
            })}
      {...(stat ? { value: stat } : {})}
      chevron
      onPress={() => router.push(sessionChatHref(session) as never)}
    />
  );
}

const styles = StyleSheet.create({
  // The groups in the grouped list's column, at the screen's sides (as Rotinas').
  in: { paddingHorizontal: SCREEN_X, paddingTop: 8, paddingBottom: 24 },
});
