import type { ManagedTask } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  agentCardLine,
  helpersOf,
  hiddenCount,
  taskPlace,
  taskTime,
  taskTitle,
} from "@agenteschat/client/lib/task-manager";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, LinearTransition } from "react-native-reanimated";
import { EmptyState, haptics, Icon, SCREEN_X, SkeletonList, Text, useReducedMotion } from "@/ui";
import { router } from "@/ui/navigation";
import { AgentFace, OpensAgent } from "../shared/Face";
import { useColors, useDirectory, useNow, usePullRefresh } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { SheetHostProvider } from "../shared/SheetHost";
import { RetryLine } from "../shared/TeamSkyEmpty";
import { useAgentTasks, useStopper } from "./hooks";
import { type Place, type RowState, rowState, taskStateWords } from "./logic";
import { TaskMark, useAgentColor, WaitLines } from "./parts";

/**
 * An agent's tasks (ADR 0128), pushed from its DM's header the way a thread opens, in the task manager's language: one
 * line under the title says how its work stands ("6 trabalhando · 1 espera você · 2 feitas hoje"); a reason several
 * tasks share (a plan at its limit until Wednesday) is said once, under it; then one line per task with its state's
 * mark, its title and place and a chevron, since a task opens its own screen, where it is said whole, its computer's
 * line opens ("Ver fila") and it is stopped. At the end, "Abrir no gerenciador" and, with more than one to stop,
 * "Parar todas" in red, which asks with the system's alert.
 */
export function AgentTasksScreen({ agentId, from }: { agentId: string; from: Place | null }) {
  return (
    <SheetHostProvider>
      <AgentTasks agentId={agentId} from={from} />
    </SheetHostProvider>
  );
}

function AgentTasks({ agentId, from }: { agentId: string; from: Place | null }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const now = useNow(10_000);
  const { stopping, stop } = useStopper();
  const { view, doneToday, query } = useAgentTasks(agentId, { here: from, stopping });
  const pull = usePullRefresh(query.refetch);
  // Tasks that start or end while the person watches fade, and the rest slide into place; nothing moves with reduced
  // motion.
  const reduced = useReducedMotion();
  const fade = reduced ? {} : { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) };
  const layout = reduced ? undefined : LinearTransition.duration(220);
  const name = dir.nameOf({ type: "agent", id: agentId }) || t("channel.unknownAgent");
  const rows = view?.rows ?? [];
  const hidden = hiddenCount(query.data?.hidden, agentId);
  const stoppable = view?.stoppable ?? [];
  const helpers = helpersOf(rows.map((r) => r.task).filter((task) => stoppable.includes(task.runId)));
  const summary =
    [
      view && view.working > 0 ? t("taskManager.working", { count: view.working }) : null,
      view && view.waiting > 0 ? t("taskManager.waiting", { count: view.waiting }) : null,
      doneToday > 0 ? t("mobile.taskManager.doneToday", { count: doneToday }) : null,
    ]
      .filter(Boolean)
      .join(" · ") || t("mobile.taskManager.quiet");
  // One alert, the system's: how many stop, and that what was done stays; helpers stop with them.
  const askStopAll = () =>
    Alert.alert(
      helpers > 0
        ? t("taskManager.confirm.chainTitle", { name, count: helpers })
        : t("taskManager.confirm.title", { name, count: stoppable.length }),
      helpers > 0 ? t("taskManager.confirm.chainBody") : t("taskManager.confirm.body", agentGrammar(name)),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("taskManager.confirm.stop", { count: stoppable.length }),
          style: "destructive",
          onPress: () => {
            haptics.medium();
            stop(stoppable, undefined, helpers > 0);
          },
        },
      ],
    );
  return (
    <PushedLargeTitle
      title={t("taskManager.agentTasks", { name })}
      right={
        <OpensAgent agentId={agentId}>
          <AgentFace agentId={agentId} size={28} mode={view && view.working > 0 ? "run" : "idle"} />
        </OpensAgent>
      }
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {query.isLoading ? (
        <SkeletonList rows={4} />
      ) : query.isError && !query.data ? (
        <RetryLine onRetry={() => void query.refetch()} />
      ) : (
        // Loaded, the list fades in over the skeleton; the rows it starts with don't each fade again.
        <Animated.View {...fade}>
          <LayoutAnimationConfig skipEntering>
            <Text variant="subhead" tone="muted" style={styles.summary}>
              {summary}
            </Text>
            {view ? (
              <>
                <WaitLines tasks={rows.map((r) => r.task)} now={now} />
                {rows.map(({ task, here }, i) => (
                  <Animated.View key={task.runId} {...fade} layout={layout}>
                    <TaskRow task={task} here={here} state={rowState(task, stopping)} now={now} divider={i > 0} />
                  </Animated.View>
                ))}
              </>
            ) : (
              <EmptyState
                size="panel"
                agent={agentLook(dir.anyAgent(agentId))}
                mood="deal"
                title={hidden > 0 ? agentCardLine(t, 0, hidden) : t("taskManager.agentPanel.none", { name })}
              />
            )}
            <View style={styles.actions}>
              <ActionRow label={t("taskManager.actions.openManager")} onPress={() => router.push("/task-manager")} />
              {stoppable.length > 1 ? (
                <ActionRow label={t("taskManager.actions.stopAll")} danger divider onPress={askStopAll} />
              ) : null}
            </View>
          </LayoutAnimationConfig>
        </Animated.View>
      )}
    </PushedLargeTitle>
  );
}

/**
 * A task, one line on the 16 margin: its state's mark (the orbit while it runs, amber while it waits on you), its
 * title and where it comes from in quiet type (the conversation, a channel, a routine that isn't its title), cut at
 * the end, its time and a chevron, since it opens the task's screen, where it is said whole, its computer's line
 * opens and it is stopped.
 */
function TaskRow({
  task,
  here,
  state,
  now,
  divider,
}: {
  task: ManagedTask;
  here: boolean;
  state: RowState;
  now: number;
  divider: boolean;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const color = useAgentColor(task.agentId);
  const title = taskTitle(t, task);
  const place = here ? t("taskManager.where.here") : taskPlace(t, task);
  const words = taskStateWords(t, i18n.language, task, state, now);
  return (
    <Pressable
      onPress={() => router.push(`/task-manager/${task.runId}`)}
      accessibilityRole="button"
      accessibilityLabel={[title, place, words.state, words.next].filter(Boolean).join(", ")}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      {divider ? <View style={[styles.divider, { backgroundColor: c.line2 }]} /> : null}
      <TaskMark state={state} color={color} />
      <Text variant="body" numberOfLines={1} style={styles.grow}>
        {title}
        {place ? <Text variant="footnote" tone="muted">{`  ${place}`}</Text> : null}
      </Text>
      {state === "stopping" ? null : (
        <Text variant="caption" tone="faint" style={styles.num}>
          {taskTime(t, task, now)}
        </Text>
      )}
      <Icon name="right" size={15} color={c.faint} />
    </Pressable>
  );
}

/** One of the list's last rows: a way out to the whole manager (chevron), or "Parar todas" in red (no icon). */
function ActionRow({
  label,
  danger = false,
  divider = false,
  onPress,
}: {
  label: string;
  danger?: boolean;
  divider?: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.action, pressed && { backgroundColor: c.sunken }]}
    >
      {divider ? <View style={[styles.divider, { backgroundColor: c.line2 }]} /> : null}
      <Text variant="body" style={[styles.grow, danger ? { color: c.danger } : null]} numberOfLines={1}>
        {label}
      </Text>
      {danger ? null : <Icon name="right" size={15} color={c.faint} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Under the large title's words, as the manager's line.
  summary: { paddingHorizontal: SCREEN_X, marginTop: -4, paddingBottom: 8 },
  // One line: the touch rows' 12 above and below it.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 48,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  divider: { position: "absolute", top: 0, left: 16, right: 0, height: StyleSheet.hairlineWidth },
  grow: { flex: 1, minWidth: 0 },
  num: { fontVariant: ["tabular-nums"] },
  // The way out and Parar todas: a section of their own, 24 under the tasks.
  actions: { marginTop: 24 },
  action: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52, paddingHorizontal: 16 },
});
