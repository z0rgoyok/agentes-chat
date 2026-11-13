import type { ComputerSummary, EndedTask, ManagedTask } from "@agenteschat/client";
import {
  type AgentTasks,
  agentSummary,
  endedState,
  groupLead,
  groupTasks,
  hiddenCount,
  taskPlace,
  taskState,
  taskTime,
  taskTitle,
  taskWaitWords,
} from "@agenteschat/client/lib/task-manager";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  LinearTransition,
  useAnimatedStyle,
  withTiming,
} from "react-native-reanimated";
import { ComputerIcon, useComputerKind } from "@/computer/ComputerPortrait";
import {
  Button,
  Count,
  EmptyState,
  Icon,
  PixelDone,
  PixelFail,
  PixelStopped,
  SCREEN_X,
  SectionHeader,
  SkeletonList,
  Text,
  type TextVariant,
  useReducedMotion,
  weights,
} from "@/ui";
import { router } from "@/ui/navigation";
import { CollapsibleSection } from "../chats/HomeSection";
import { useOpenQueue } from "../queue/QueueSheet";
import { AgentFace, OpensAgent } from "../shared/Face";
import { useEmptyLook } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId, useNow, useOrgId, usePullRefresh, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { Tile } from "../shared/parts";
import { SheetHostProvider } from "../shared/SheetHost";
import { useStopper, useTasksToday } from "./hooks";
import {
  computerLine,
  endedLatestFirst,
  endedText,
  groupLine,
  type RowState,
  rowState,
  taskStateWords,
  taskSubline,
} from "./logic";
import { TaskMark, useAgentColor, WaitLines } from "./parts";

/** Rows whose agent moves (a long list stays light). */
const LIVE_ROWS = 8;

/** A task's own screen. */
const taskHref = (runId: string) => `/task-manager/${runId}` as const;

/**
 * Rows that come and go while the person watches (a task stopped, one that ended, a group folded) fade, and what
 * stays slides into place; nothing moves with reduced motion.
 */
function useRowMotion() {
  const reduced = useReducedMotion();
  return reduced
    ? { fade: {}, layout: undefined }
    : {
        fade: { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) },
        layout: LinearTransition.duration(220),
      };
}

/**
 * The task manager (ADR 0128), pushed from Agentes: what the agents are doing now, under a line that counts it
 * ("2 trabalhando · 1 espera você"). The tasks people asked for, by agent (its row says how its tasks stand and is
 * one tap: folded until opened), each a row with its state as a mark (the orbit while it runs, amber while it waits on
 * you), its time and a chevron: stopping is done on the task's own screen, never from a button in the list. Then the
 * routines' work in the background and what ended today. Above them, the computers with work, each opening its line
 * in a sheet. Every row is one line that ends in "…": a task's own screen says it whole.
 */
export function TaskManagerScreen() {
  return (
    <SheetHostProvider>
      <TaskManager />
    </SheetHostProvider>
  );
}

function TaskManager() {
  const { t } = useTranslation();
  const look = useEmptyLook();
  const meId = useMeId();
  const tasks = useTasksToday();
  const pull = usePullRefresh(tasks.refetch);
  const now = useNow(1000);
  // Tasks being stopped from their screens read "Parando…" here too.
  const { stopping } = useStopper();
  const { fade, layout } = useRowMotion();
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [endedOpen, setEndedOpen] = useState(false);
  const view = tasks.data;
  const { groups, delegated, background } = useMemo(
    () => groupTasks(view?.tasks ?? [], stopping),
    [view?.tasks, stopping],
  );
  const ended = useMemo(() => endedLatestFirst(view?.ended ?? []), [view?.ended]);
  const all = view?.tasks ?? [];
  const sum = agentSummary(all);
  // Everyone's work counts here, as on the computers' rows; what the viewer may not see only counts.
  const working = sum.working + (view?.hidden?.working ?? 0);
  const hidden = hiddenCount(view?.hidden, null);
  // The line under the title: how many work and how many wait on you, else that nothing is on.
  const summary =
    [
      working > 0 ? t("taskManager.working", { count: working }) : null,
      sum.waiting > 0 ? t("taskManager.waiting", { count: sum.waiting }) : null,
    ]
      .filter(Boolean)
      .join(" · ") || t("mobile.taskManager.quiet");
  const toggle = (agentId: string) =>
    setOpened((was) => {
      const next = new Set(was);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  const askedCount = groups.reduce((n, g) => n + g.tasks.length, 0);
  const delegatedCount = delegated.reduce((n, g) => n + g.tasks.length, 0);
  const computers = view?.computers ?? [];
  return (
    <PushedLargeTitle
      title={t("taskManager.title")}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {tasks.isLoading ? (
        // Loading: the rows' own shape, never a spinner.
        <SkeletonList rows={4} />
      ) : tasks.isError && !view ? (
        <View style={styles.center}>
          <Text tone="muted" style={styles.centerText}>
            {t("mobile.taskManager.loadFailed")}
          </Text>
          <Button variant="secondary" size="sm" label={t("mobile.common.retry")} onPress={() => void tasks.refetch()} />
        </View>
      ) : (
        // Loaded, the list fades in over the spinner; the rows it starts with don't each fade again.
        <Animated.View {...fade}>
          <LayoutAnimationConfig skipEntering>
            <Text variant="subhead" tone="muted" style={styles.summary}>
              {summary}
            </Text>
            {sum.tasks + hidden > 0 ? null : (
              <EmptyState
                size="panel"
                agent={look}
                mood="deal"
                title={t("taskManager.empty.title")}
                subtitle={t("taskManager.empty.body")}
              />
            )}
            {hidden > 0 ? (
              <Text variant="footnote" tone="faint" style={styles.none}>
                {t("taskManager.hiddenLine", { count: hidden })}
              </Text>
            ) : null}
            {computers.length > 0 ? (
              <Animated.View {...fade} layout={layout}>
                <SectionHeader title={t("taskManager.queue.computers")} count={computers.length} />
                {computers.map((m, i) => (
                  <Animated.View key={m.id} {...fade} layout={layout}>
                    <ComputerRow computer={m} divider={i > 0} />
                  </Animated.View>
                ))}
              </Animated.View>
            ) : null}
            {groups.length > 0 ? (
              <Animated.View {...fade} layout={layout}>
                <SectionHeader title={t("taskManager.sections.asked")} count={askedCount} />
                <WaitLines tasks={groups.flatMap((g) => g.tasks)} now={now} />
                {groups.map((g, i) => (
                  <AgentGroup
                    key={g.agentId}
                    group={g}
                    open={opened.has(g.agentId)}
                    onToggle={() => toggle(g.agentId)}
                    divider={i > 0}
                    live={i < LIVE_ROWS}
                    stopping={stopping}
                    now={now}
                    meId={meId}
                  />
                ))}
              </Animated.View>
            ) : null}
            {delegated.length > 0 ? (
              <Animated.View {...fade} layout={layout}>
                <SectionHeader title={t("taskManager.sections.delegated")} count={delegatedCount} />
                <WaitLines tasks={delegated.flatMap((g) => g.tasks)} now={now} />
                {delegated.map((g, i) => (
                  <AgentGroup
                    key={g.agentId}
                    group={g}
                    flat
                    open={opened.has(`by:${g.agentId}`)}
                    onToggle={() => toggle(`by:${g.agentId}`)}
                    divider={i > 0}
                    live={i < LIVE_ROWS}
                    stopping={stopping}
                    now={now}
                    meId={meId}
                  />
                ))}
              </Animated.View>
            ) : null}
            {background.length > 0 ? (
              <Animated.View {...fade} layout={layout}>
                <SectionHeader title={t("taskManager.sections.background")} count={background.length} />
                <WaitLines tasks={background} now={now} />
                {background.map((task, i) => (
                  <Animated.View key={task.runId} {...fade} layout={layout}>
                    <TaskRow task={task} state={rowState(task, stopping)} flat divider={i > 0} now={now} meId={meId} />
                  </Animated.View>
                ))}
              </Animated.View>
            ) : null}
            {/* The same folding header as the other lists' sections (title, count, the chevron at the right). */}
            <Animated.View layout={layout}>
              <CollapsibleSection
                title={t("taskManager.ended.title")}
                count={ended.length}
                collapsed={!endedOpen}
                onToggle={() => setEndedOpen((o) => !o)}
              >
                {ended.length > 0 ? (
                  ended.map((e, i) => (
                    <Animated.View key={e.runId} {...fade} layout={layout}>
                      <EndedRow task={e} divider={i > 0} meId={meId} />
                    </Animated.View>
                  ))
                ) : (
                  <Animated.View {...fade}>
                    <Text variant="footnote" tone="faint" style={styles.none}>
                      {t("taskManager.ended.none")}
                    </Text>
                  </Animated.View>
                )}
              </CollapsibleSection>
            </Animated.View>
          </LayoutAnimationConfig>
        </Animated.View>
      )}
    </PushedLargeTitle>
  );
}

/**
 * An agent's row and, open, its tasks under it, one line: its face (running while it works), its name with the count
 * beside it (unless its words say it), how its tasks stand ("1 trabalhando · 1 espera você") cut at the end, the mark
 * and time of the task that says it, and the chevron that folds them. One tap, the whole row.
 */
function AgentGroup({
  group,
  flat = false,
  open,
  onToggle,
  divider,
  live,
  stopping,
  now,
  meId,
}: {
  group: AgentTasks;
  /** The group of an agent that asked: its rows are other agents' tasks, each with its face. */
  flat?: boolean;
  open: boolean;
  onToggle: () => void;
  divider: boolean;
  live: boolean;
  stopping: ReadonlySet<string>;
  now: number;
  meId: string | null;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const name = dir.nameOf({ type: "agent", id: group.agentId }) || t("channel.unknownAgent");
  const color = agentLook(dir.anyAgent(group.agentId)).color;
  const heldTask = group.tasks.find((task) => taskState(task) === "waiting");
  const line = groupLine(t, group, heldTask ? taskWaitWords(t, i18n.language, heldTask, now)?.state : null);
  const mark: RowState = line.mark === "working" ? "working" : line.mark === "waiting" ? "ok" : "queued";
  const time = taskTime(t, groupLead(group), now);
  const chevron = useAnimatedStyle(() => ({
    transform: [{ rotate: withTiming(open ? "0deg" : "-90deg", { duration: 200 }) }],
  }));
  const { fade, layout } = useRowMotion();
  // All working or all waiting on you: its words already say how many ("2 working").
  const counted = group.tasks.length === group.working || group.tasks.length === group.waiting;
  return (
    <Animated.View {...fade} layout={layout}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${name}, ${line.text}, ${time}`}
        style={({ pressed }) => [styles.agent, pressed && { backgroundColor: c.sunken }]}
      >
        {divider ? <View style={[styles.divider, styles.agentDivider, { backgroundColor: c.line2 }]} /> : null}
        <OpensAgent agentId={group.agentId}>
          <AgentFace agentId={group.agentId} size={LEAD} mode={line.mark === "working" ? "run" : "idle"} live={live} />
        </OpensAgent>
        <Text variant="title" numberOfLines={1} style={styles.grow}>
          {name}
          {counted ? null : (
            <>
              {" "}
              <Count value={group.tasks.length} size={13} weight={weights.regular} color={c.faint} />
            </>
          )}
          <Text variant="footnote" style={{ color: line.mark === "waiting" ? c.amber : c.muted }}>
            {`${GAP}${line.text}`}
          </Text>
        </Text>
        <TaskMark state={mark} color={color} />
        <Text variant="caption" tone="faint" style={styles.num}>
          {time}
        </Text>
        <Animated.View style={chevron}>
          <Icon name="down" size={CHEVRON} color={c.faint} />
        </Animated.View>
      </Pressable>
      {open
        ? group.tasks.map((task, i) => (
            <Animated.View key={task.runId} {...fade} layout={layout}>
              <TaskRow task={task} state={rowState(task, stopping)} flat={flat} divider={i > 0} now={now} meId={meId} />
            </Animated.View>
          ))
        : null}
    </Animated.View>
  );
}

/**
 * A task, one line: its state's mark (the orbit while it runs, amber while it waits on you) under its agent's face, its
 * title and what it is about in quiet type, cut at the end, its time and a chevron, since it opens its own screen,
 * where it is said whole and where it is stopped. A routine's or another agent's (`flat`) says whose it is first.
 */
function TaskRow({
  task,
  state,
  flat = false,
  divider,
  now,
  meId,
}: {
  task: ManagedTask;
  state: RowState;
  flat?: boolean;
  divider: boolean;
  now: number;
  meId: string | null;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const color = useAgentColor(task.agentId);
  const title = taskTitle(t, task);
  const sub = taskSubline(t, task, meId, title, (id) => dir.anyAgent(id)?.name);
  const words = taskStateWords(t, i18n.language, task, state, now);
  const agent = dir.nameOf({ type: "agent", id: task.agentId });
  const line = flat ? [agent, sub].filter(Boolean).join(" · ") : sub;
  return (
    <Pressable
      onPress={() => router.push(taskHref(task.runId))}
      accessibilityRole="button"
      accessibilityLabel={[title, line, words.state, words.next].filter(Boolean).join(", ")}
      style={({ pressed }) => [styles.task, pressed && { backgroundColor: c.sunken }]}
    >
      {divider ? <View style={[styles.divider, styles.textDivider, { backgroundColor: c.line2 }]} /> : null}
      <View style={styles.lead}>
        <TaskMark state={state} color={color} />
      </View>
      <OneLine title={title} line={line} />
      {state === "stopping" ? null : (
        <Text variant="caption" tone="faint" style={styles.num}>
          {taskTime(t, task, now)}
        </Text>
      )}
      <Icon name="right" size={15} color={c.faint} />
    </Pressable>
  );
}

/** A row's words on one line: the title, then what it is about in quiet type, cut at the end ("…"). */
function OneLine({ title, line, variant = "body" }: { title: string; line?: string | null; variant?: TextVariant }) {
  return (
    <Text variant={variant} numberOfLines={1} style={styles.grow}>
      {title}
      {line ? <Text variant="footnote" tone="muted">{`${GAP}${line}`}</Text> : null}
    </Text>
  );
}

/**
 * A computer with work (ADR 0128): its name, whether it has room or how many wait for it, how many run there now. It
 * opens its line (`QueueSheet`).
 */
function ComputerRow({ computer, divider }: { computer: ComputerSummary; divider: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const kind = useComputerKind(useOrgId(), computer.id);
  const openQueue = useOpenQueue();
  const line = computerLine(t, computer);
  return (
    <Pressable
      onPress={() => openQueue(computer.id)}
      accessibilityRole="button"
      accessibilityLabel={`${computer.name}, ${line}`}
      style={({ pressed }) => [styles.task, pressed && { backgroundColor: c.sunken }]}
    >
      {divider ? <View style={[styles.divider, styles.textDivider, { backgroundColor: c.line2 }]} /> : null}
      <Tile size={LEAD}>
        <ComputerIcon kind={kind} size={16} color={c.muted} />
      </Tile>
      <OneLine title={computer.name} line={line} variant="subhead" />
      <Icon name="right" size={15} color={c.faint} />
    </Pressable>
  );
}

/**
 * One that ended today, one line: its agent's face, its title and where, how it ended as a mark (in words on its
 * screen) and when. It opens its screen too.
 */
function EndedRow({ task, divider, meId }: { task: EndedTask; divider: boolean; meId: string | null }) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const when = useWhen();
  const title = taskTitle(t, task);
  const agentName = dir.nameOf({ type: "agent", id: task.agentId });
  const line = [agentName, taskPlace(t, task)].filter(Boolean).join(" · ");
  const how = endedText(t, task, meId);
  const state = endedState(task);
  return (
    <Pressable
      onPress={() => router.push(taskHref(task.runId))}
      accessibilityRole="button"
      accessibilityLabel={[title, line, how, when.time(task.finishedAt)].filter(Boolean).join(", ")}
      style={({ pressed }) => [styles.task, pressed && { backgroundColor: c.sunken }]}
    >
      {divider ? <View style={[styles.divider, styles.textDivider, { backgroundColor: c.line2 }]} /> : null}
      <OpensAgent agentId={task.agentId}>
        <AgentFace agentId={task.agentId} size={LEAD} live={false} />
      </OpensAgent>
      <OneLine title={title} line={line} />
      {state === "done" ? (
        <PixelDone size={12} />
      ) : state === "failed" ? (
        <PixelFail size={12} />
      ) : (
        <PixelStopped size={10} />
      )}
      <Text variant="caption" tone="faint" style={styles.num}>
        {when.time(task.finishedAt)}
      </Text>
    </Pressable>
  );
}

/** An agent row's folding chevron (at its right). */
const CHEVRON = 16;
/**
 * What leads a row: an agent's face, a computer's tile, or a task's mark centred in as wide a box, so a task's mark
 * sits under its agent's face and every row's words start on one column (16 + 28 + 12).
 */
const LEAD = 28;
/** Between a row's title and what it is about, on its one line. */
const GAP = "  ";

const styles = StyleSheet.create({
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  centerText: { textAlign: "center" },
  // Under the large title's words, as Equipe's line.
  summary: { paddingHorizontal: SCREEN_X, marginTop: -4, paddingBottom: 4 },
  // One line each: the touch rows' 12 above and below it, the lead (28) at most as tall as that.
  agent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 52,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  task: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 52,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  lead: { width: LEAD, alignItems: "center" },
  grow: { flex: 1, minWidth: 0 },
  num: { fontVariant: ["tabular-nums"] },
  divider: { position: "absolute", top: 0, right: 0, height: StyleSheet.hairlineWidth },
  agentDivider: { left: 16 },
  // Under the words, past the lead: the rows under an agent read as its own.
  textDivider: { left: 16 + LEAD + 12 },
  none: { paddingHorizontal: SCREEN_X, paddingBottom: 12 },
});
