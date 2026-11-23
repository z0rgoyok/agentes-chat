import {
  type CanceledReturn,
  type ComputerSummary,
  type EndedTask,
  type ManagedTask,
  type PendingReturn,
  useCancelFollowUp,
} from "@agenteschat/client";
import { returnClock, returnWhen } from "@agenteschat/client/lib/agent-work";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatLineTime } from "@agenteschat/client/lib/format";
import {
  type AgentTasks,
  agentSummary,
  causeWords,
  computerRoomText,
  computersBesides,
  endedState,
  endedText,
  groupLead,
  groupTasks,
  hiddenCount,
  returnCanceledText,
  returnPlace,
  shownCauses,
  taskPlace,
  taskSince,
  taskState,
  taskTime,
  taskTitle,
  taskWaitWords,
  type WaitCause,
} from "@agenteschat/client/lib/task-manager";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, RefreshControl, StyleSheet, View } from "react-native";
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
  Count,
  Disclosure,
  EmptyState,
  Icon,
  PixelDone,
  PixelFail,
  PixelStopped,
  ProviderLogo,
  RowPressable,
  SCREEN_X,
  SectionHeader,
  SkeletonList,
  Text,
  type TextVariant,
  useReducedMotion,
  useToast,
  weights,
} from "@/ui";
import { router } from "@/ui/navigation";
import { CollapsibleSection } from "../chats/HomeSection";
import { chatHref } from "../links/logic";
import { useOpenQueue } from "../queue/QueueSheet";
import { AgentFace, OpensAgent } from "../shared/Face";
import { LoadFailed, useEmptyLook } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId, useNow, useOrgId, usePullRefresh, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { SheetTitle } from "../shared/PromptForm";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { type ActionItem, ActionList, Tile } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { useStopper, useTasksToday } from "./hooks";
import { endedLatestFirst, groupLine, type RowState, rowState, taskStateWords, taskSubline } from "./logic";
import { TaskMark, useAgentColor, WaitLines } from "./parts";

/** Rows whose agent moves (a long list stays light). */
const LIVE_ROWS = 8;

/** A task's own screen. */
const taskHref = (runId: string) => `/task-manager/${runId}` as const;

const MINUTE = 60_000;

/**
 * Whether a task's time shows seconds (`taskTime`): its clock while it works or waits its turn ("6:12"), or a wait
 * under a minute ("12 s"); a longer wait says minutes or more ("25 min").
 */
function showsSeconds(task: ManagedTask, now: number): boolean {
  if (taskState(task) !== "waiting") return true;
  const since = task.wait?.since ? Date.parse(task.wait.since) : taskSince(task);
  return now - since < MINUTE;
}

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
 * routines' work in the background and what ended today. Above them, while something waits, what holds it (a full
 * computer opens its line in a sheet). Every row is one line that ends in "…": a task's own screen says it whole, a return's sheet its words.
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
  // Tasks being stopped from their screens read "Parando…" here too.
  const { stopping } = useStopper();
  const { fade, layout } = useRowMotion();
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [endedOpen, setEndedOpen] = useState(false);
  const view = tasks.data;
  // Each second only while a row shows seconds; otherwise the minute pace.
  const ticking = (view?.tasks ?? []).some((task) => showsSeconds(task, Date.now()));
  const now = useNow(ticking ? 1000 : MINUTE);
  // What says minutes or a time of day moves once a minute beside a ticking clock: its rows (memoized) skip the rest.
  const minuteNow = ticking ? now - (now % MINUTE) : now;
  const { groups, delegated, background } = useMemo(
    () => groupTasks(view?.tasks ?? [], stopping),
    [view?.tasks, stopping],
  );
  const ended = useMemo(() => endedLatestFirst(view?.ended ?? []), [view?.ended]);
  // The returns agents set ("Retornos", ADR 0037), and those canceled today among what ended.
  const followUps = view?.followUps ?? [];
  const endedRows = useMemo(
    () =>
      [
        ...ended.map((e) => ({ at: e.finishedAt, key: e.runId, task: e, canceled: null })),
        ...(view?.canceledFollowUps ?? []).map((r) => ({
          at: r.canceledAt,
          key: r.messageId,
          task: null,
          canceled: r,
        })),
      ].sort((a, b) => b.at.localeCompare(a.at)),
    [ended, view?.canceledFollowUps],
  );
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
  const toggle = useCallback(
    (agentId: string) =>
      setOpened((was) => {
        const next = new Set(was);
        if (next.has(agentId)) next.delete(agentId);
        else next.add(agentId);
        return next;
      }),
    [],
  );
  // A row's time: to the second where it shows seconds, else the minute's.
  const rowNow = (list: readonly ManagedTask[]) => (list.some((task) => showsSeconds(task, now)) ? now : minuteNow);
  const askedCount = groups.reduce((n, g) => n + g.tasks.length, 0);
  const delegatedCount = delegated.reduce((n, g) => n + g.tasks.length, 0);
  const computers = view?.computers ?? [];
  const causes = shownCauses(all);
  // A computer with a line holds work too (each turn waits its place): a row of the same block, opening its line.
  const lined = computersBesides(computers, causes).filter((m) => m.inLine > 0);
  return (
    <PushedLargeTitle
      title={t("taskManager.title")}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {tasks.isLoading ? (
        // Loading: the rows' own shape, never a spinner.
        <SkeletonList rows={4} />
      ) : tasks.isError && !view ? (
        <LoadFailed onRetry={() => void tasks.refetch()} />
      ) : (
        // Loaded, the list fades in over the spinner; the rows it starts with don't each fade again.
        <Animated.View {...fade}>
          <LayoutAnimationConfig skipEntering>
            <Text variant="subhead" tone="muted" style={styles.summary}>
              {summary}
            </Text>
            {causes.length + lined.length > 0 ? (
              <Animated.View {...fade} layout={layout}>
                <SectionHeader title={t("taskManager.capacity.label")} count={causes.length + lined.length} />
                {causes.map((cause, i) => (
                  <CauseRow key={cause.key} cause={cause} computers={computers} divider={i > 0} />
                ))}
                {lined.map((m, i) => (
                  <ComputerRow key={m.id} computer={m} divider={causes.length + i > 0} />
                ))}
              </Animated.View>
            ) : null}
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
            {groups.length > 0 ? (
              <Animated.View {...fade} layout={layout}>
                <SectionHeader title={t("taskManager.sections.asked")} count={askedCount} />
                <WaitLines tasks={groups.flatMap((g) => g.tasks)} now={minuteNow} />
                {groups.map((g, i) => (
                  <AgentGroup
                    key={g.agentId}
                    id={g.agentId}
                    group={g}
                    open={opened.has(g.agentId)}
                    onToggle={toggle}
                    divider={i > 0}
                    live={i < LIVE_ROWS}
                    stopping={stopping}
                    now={rowNow(g.tasks)}
                    minuteNow={minuteNow}
                    meId={meId}
                  />
                ))}
              </Animated.View>
            ) : null}
            {delegated.length > 0 ? (
              <Animated.View {...fade} layout={layout}>
                <SectionHeader title={t("taskManager.sections.delegated")} count={delegatedCount} />
                <WaitLines tasks={delegated.flatMap((g) => g.tasks)} now={minuteNow} />
                {delegated.map((g, i) => (
                  <AgentGroup
                    key={g.agentId}
                    id={`by:${g.agentId}`}
                    group={g}
                    flat
                    open={opened.has(`by:${g.agentId}`)}
                    onToggle={toggle}
                    divider={i > 0}
                    live={i < LIVE_ROWS}
                    stopping={stopping}
                    now={rowNow(g.tasks)}
                    minuteNow={minuteNow}
                    meId={meId}
                  />
                ))}
              </Animated.View>
            ) : null}
            {background.length > 0 ? (
              <Animated.View {...fade} layout={layout}>
                <SectionHeader title={t("taskManager.sections.background")} count={background.length} />
                <WaitLines tasks={background} now={minuteNow} />
                {background.map((task, i) => (
                  <Animated.View key={task.runId} {...fade} layout={layout}>
                    <TaskRow
                      task={task}
                      state={rowState(task, stopping)}
                      flat
                      divider={i > 0}
                      now={rowNow([task])}
                      meId={meId}
                    />
                  </Animated.View>
                ))}
              </Animated.View>
            ) : null}
            {followUps.length > 0 ? (
              <Animated.View {...fade} layout={layout}>
                <SectionHeader title={t("taskManager.sections.returns")} count={followUps.length} />
                {followUps.map((r, i) => (
                  <Animated.View key={r.messageId} {...fade} layout={layout}>
                    <ReturnRow item={r} divider={i > 0} now={minuteNow} />
                  </Animated.View>
                ))}
              </Animated.View>
            ) : null}
            {/* The same folding header as the other lists' sections (title, count, the chevron at the right). */}
            <Animated.View layout={layout}>
              <CollapsibleSection
                title={t("taskManager.ended.title")}
                count={endedRows.length}
                collapsed={!endedOpen}
                onToggle={() => setEndedOpen((o) => !o)}
              >
                {endedRows.length > 0 ? (
                  endedRows.map((e, i) => (
                    <Animated.View key={e.key} {...fade} layout={layout}>
                      {e.task ? (
                        <EndedRow task={e.task} divider={i > 0} meId={meId} />
                      ) : e.canceled ? (
                        <CanceledReturnRow item={e.canceled} divider={i > 0} meId={meId} />
                      ) : null}
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
const AgentGroup = memo(function AgentGroup({
  id,
  group,
  flat = false,
  open,
  onToggle,
  divider,
  live,
  stopping,
  now,
  minuteNow,
  meId,
}: {
  /** What `onToggle` is called with: the key of its fold. */
  id: string;
  group: AgentTasks;
  /** The group of an agent that asked: its rows are other agents' tasks, each with its face. */
  flat?: boolean;
  open: boolean;
  onToggle: (id: string) => void;
  divider: boolean;
  live: boolean;
  stopping: ReadonlySet<string>;
  /** To the second while one of its tasks shows seconds, else `minuteNow`. */
  now: number;
  minuteNow: number;
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
      <RowPressable
        onPress={() => onToggle(id)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${name}, ${line.text}, ${time}`}
        style={styles.agent}
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
      </RowPressable>
      {open
        ? group.tasks.map((task, i) => (
            <Animated.View key={task.runId} {...fade} layout={layout}>
              <TaskRow
                task={task}
                state={rowState(task, stopping)}
                flat={flat}
                divider={i > 0}
                now={showsSeconds(task, now) ? now : minuteNow}
                meId={meId}
              />
            </Animated.View>
          ))
        : null}
    </Animated.View>
  );
});

/**
 * A task, one line: its state's mark (the orbit while it runs, amber while it waits on you) under its agent's face, its
 * title and what it is about in quiet type, cut at the end, its time and a chevron, since it opens its own screen,
 * where it is said whole and where it is stopped. A routine's or another agent's (`flat`) says whose it is first.
 */
const TaskRow = memo(function TaskRow({
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
    <RowPressable
      hold
      onPress={() => router.push(taskHref(task.runId))}
      accessibilityRole="button"
      accessibilityLabel={[title, line, words.state, words.next].filter(Boolean).join(", ")}
      style={styles.task}
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
      <Disclosure />
    </RowPressable>
  );
});

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
 * What holds waiting work (`waitCauses`), one line with its count, as the web's strip: a plan at its limit opens IA e
 * uso, one away the computers, people's oks and answers the first such task's screen.
 */
function CauseRow({ cause, computers, divider }: { cause: WaitCause; computers: ComputerSummary[]; divider: boolean }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const first = cause.tasks[0] as ManagedTask;
  const { name: title, fact: line } = causeWords(t, i18n.language, cause, computers);
  const brain = first.brain && first.brain !== "model" ? first.brain : null;
  const kind = useComputerKind(useOrgId(), cause.kind === "computer" ? cause.machineId : null);
  const row =
    cause.kind === "limit"
      ? {
          lead: brain ? <ProviderLogo id={brain} size="xs" /> : <Icon name="clock" size={16} color={c.muted} />,
          onPress: () => router.push("/usage"),
        }
      : cause.kind === "computer"
        ? {
            lead: <ComputerIcon kind={kind} size={16} color={c.muted} />,
            onPress: () => router.push("/settings/devices"),
          }
        : {
            lead: <Icon name="clock" size={16} color={c.muted} />,
            onPress: () => router.push(taskHref(first.runId)),
          };
  return (
    <RowPressable
      hold
      onPress={row.onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${line}`}
      style={styles.task}
    >
      {divider ? <View style={[styles.divider, styles.textDivider, { backgroundColor: c.line2 }]} /> : null}
      <Tile size={LEAD}>{row.lead}</Tile>
      <OneLine title={title} line={line} variant="subhead" />
      <Disclosure />
    </RowPressable>
  );
}

/** A computer with a line (ADR 0128): its name, how many wait and run there. It opens its line (`QueueSheet`). */
function ComputerRow({ computer, divider }: { computer: ComputerSummary; divider: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const kind = useComputerKind(useOrgId(), computer.id);
  const openQueue = useOpenQueue();
  const line = computerRoomText(t, computer);
  return (
    <RowPressable
      hold
      onPress={() => openQueue(computer.id)}
      accessibilityRole="button"
      accessibilityLabel={`${computer.name}, ${line}`}
      style={styles.task}
    >
      {divider ? <View style={[styles.divider, styles.textDivider, { backgroundColor: c.line2 }]} /> : null}
      <Tile size={LEAD}>
        <ComputerIcon kind={kind} size={16} color={c.muted} />
      </Tile>
      <OneLine title={computer.name} line={line} variant="subhead" />
      <Disclosure />
    </RowPressable>
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
  const how = endedText(t, task, meId, (id) => dir.nameOf({ type: "agent", id }) || undefined);
  const state = endedState(task);
  return (
    <RowPressable
      hold
      onPress={() => router.push(taskHref(task.runId))}
      accessibilityRole="button"
      accessibilityLabel={[title, line, how, when.time(task.finishedAt)].filter(Boolean).join(", ")}
      style={styles.task}
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
    </RowPressable>
  );
}

/**
 * A return an agent set (ADR 0037), one line: the clock, her words and where (the agent, the conversation), when it
 * comes. A tap or a long press opens its sheet (`ReturnSheet`): the row's words cut at the end, and a return has no
 * screen of its own.
 */
const ReturnRow = memo(function ReturnRow({
  item,
  divider,
  now,
}: {
  item: PendingReturn;
  divider: boolean;
  /** The minute's time: the row says a time of day. */
  now: number;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const sheet = useSheet();
  const agent = dir.nameOf({ type: "agent", id: item.agentId });
  const line = [agent, returnPlace(t, item)].filter(Boolean).join(" · ");
  const whenAt = (at: number) =>
    item.held ? t("threads.status.input") : returnWhen(t, i18n.language, item.at, at, true);
  const soonAt = (at: number) =>
    item.held
      ? null
      : t("followUps.inTime", { time: formatLineTime(i18n.language, Math.max(1000, Date.parse(item.at) - at)) });
  const when = whenAt(now);
  const soon = soonAt(now);
  const open = () => {
    // The sheet says how long is left from the moment it opens: the row's time moves once a minute.
    const at = Date.now();
    sheet.open(
      <ReturnSheet
        item={item}
        line={line}
        when={[whenAt(at), soonAt(at)].filter(Boolean).join(" · ")}
        onOpen={() => router.push(chatHref(item.channelId, item.threadId, item.replyMessageId))}
      />,
    );
  };
  return (
    <RowPressable
      hold
      onPress={open}
      onLongPress={open}
      accessibilityRole="button"
      accessibilityLabel={[item.about, line, when, soon].filter(Boolean).join(", ")}
      style={styles.task}
    >
      {divider ? <View style={[styles.divider, styles.textDivider, { backgroundColor: c.line2 }]} /> : null}
      <View style={styles.lead}>
        <Icon name="clock" size={16} color={c.faint} />
      </View>
      <OneLine title={item.about} line={line} />
      <Text variant="caption" tone="faint" style={styles.num}>
        {item.held ? when : returnClock(t, i18n.language, item.at, now)}
      </Text>
      <Disclosure />
    </RowPressable>
  );
});

/** A return that won't come, among what ended today: who canceled it (nobody: its time found it couldn't). */
function CanceledReturnRow({ item, divider, meId }: { item: CanceledReturn; divider: boolean; meId: string | null }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const sheet = useSheet();
  const agent = dir.nameOf({ type: "agent", id: item.agentId });
  const how = returnCanceledText(t, item, meId, agent);
  const at = returnClock(t, i18n.language, item.at, Date.parse(item.canceledAt));
  // How it ended in words, after whose it was: no screen of its own says it.
  const line = [agent, how].filter(Boolean).join(" · ");
  const open = () =>
    sheet.open(
      <ReturnSheet
        item={item}
        line={[agent, returnPlace(t, item)].filter(Boolean).join(" · ")}
        when={`${how} · ${at}`}
        onOpen={() => router.push(chatHref(item.channelId, item.threadId))}
      />,
    );
  return (
    <RowPressable
      onPress={open}
      onLongPress={open}
      accessibilityRole="button"
      accessibilityLabel={[item.about, line, returnPlace(t, item), at].filter(Boolean).join(", ")}
      style={styles.task}
    >
      {divider ? <View style={[styles.divider, styles.textDivider, { backgroundColor: c.line2 }]} /> : null}
      <OpensAgent agentId={item.agentId}>
        <AgentFace agentId={item.agentId} size={LEAD} live={false} />
      </OpensAgent>
      <OneLine title={item.about} line={line} />
      <Icon name="clock" size={14} color={c.faint} />
      <Text variant="caption" tone="faint" style={styles.num}>
        {at}
      </Text>
    </RowPressable>
  );
}

/**
 * A return's sheet, where its row's words are whole (note A: rows are one line): her words, whose and where, when it
 * comes or how it ended, then "Abrir na conversa" and, for who may, "Cancelar retorno". While that goes its spinner
 * shows and the rest waits. Done, the sheet closes.
 */
function ReturnSheet({
  item,
  line,
  when,
  onOpen,
}: {
  item: PendingReturn | CanceledReturn;
  /** "Ada · #vendas". */
  line: string;
  /** "Às 00:32 · em 33 min", "Esperando uma resposta", "Retorno cancelado por Ana · 00:32". */
  when: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const sheet = useSheet();
  const cancel = useCancelFollowUp(useOrgId());
  const going = cancel.isPending;
  const items: ActionItem[] = [
    {
      key: "open",
      icon: "chat",
      label: t("taskManager.actions.open"),
      disabled: going,
      onPress: () => {
        sheet.close();
        onOpen();
      },
    },
    ...("canCancel" in item && item.canCancel
      ? [
          {
            key: "cancel",
            icon: "x" as const,
            label: t("followUps.cancel"),
            danger: true,
            ...(going
              ? { trailing: <ActivityIndicator size="small" color={c.muted} /> }
              : {
                  onPress: () =>
                    cancel.mutate(
                      { channelId: item.channelId, messageId: item.messageId },
                      {
                        onSuccess: () => sheet.close(),
                        onError: (error) => toast({ title: errorText(t, error), icon: "x" }),
                      },
                    ),
                }),
          },
        ]
      : []),
  ];
  return (
    <>
      {/* No leading face: her words take the sheet's width (her name is under them). */}
      <SheetTitle title={item.about} subtitle={`${line}\n${when}`} />
      <ActionList items={items} />
    </>
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
