import type { CanceledReturn, ComputerSummary, EndedTask, ManagedTask, PendingReturn } from "@agenteschat/client";
import { useCancelFollowUp, useTaskManager } from "@agenteschat/client";
import { returnClock, returnWhen } from "@agenteschat/client/lib/agent-work";
import { listsAgent } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatLineTime } from "@agenteschat/client/lib/format";
import {
  type AgentTasks,
  agentCardLine,
  agentSummary,
  causeWords,
  computerRoomText,
  computersBesides,
  delegationText,
  endedState,
  endedText,
  groupLead,
  groupTasks,
  helpersOf,
  hiddenCount,
  opensInChat,
  returnCanceledText,
  returnPlace,
  shownCauses,
  taskHelping,
  taskPlace,
  taskState,
  tasksOf,
  taskTime,
  taskTitle,
  taskWhere,
  todayStart,
  type WaitCause,
} from "@agenteschat/client/lib/task-manager";
import { formatDuration } from "@agenteschat/client/lib/work";
import {
  Button,
  Carousel,
  Chip,
  CountChip,
  cx,
  EmptyState,
  GroupHeading,
  Icon,
  type IconName,
  Menu,
  MenuItem,
  PageHeader,
  PixelSpinner,
  PixelStop,
  ProviderLogo,
  SearchField,
  Tip,
} from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { QueueDialog } from "@/components/ComputerQueue";
import { ErrorState, LoadingList } from "@/components/Loading";
import { OpensAgent } from "@/components/OpensAgent";
import { useOrg } from "@/components/org-context";
import { WaitMark } from "@/components/RequestCard";
import {
  heatOf,
  ProgramStack,
  RowName,
  rowTip,
  StopAllConfirm,
  TaskMark,
  TaskStateChip,
  TaskWaitLines,
  taskAge,
  taskSub,
  UsingNow,
  useOpenTask,
  useProgramText,
  useTaskStatus,
  useTaskStop,
} from "@/components/tasks/TaskBits";
import { TaskPanel } from "@/components/tasks/TaskPanel";
import { useDirectory } from "@/hooks/useDirectory";
import { useNow } from "@/hooks/useNow";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { useToast } from "@/lib/toast";
import "./task-manager.css";

/*
 * The task manager (ADR 0128), one page: what holds the work (only while something waits), the agents as filter
 * chips (one chosen shows only its tasks), the tasks now (asked by people, grouped by agent and folded until opened, then the routines' background
 * runs, then the returns agents set, ADR 0037) with their state, what each uses, its time and ⋯, and what ended
 * today at the end. Every row is one line
 * that ends in "…" when it doesn't fit, its words whole in its tip. No cost anywhere: here people stop work. A row or
 * an agent's card chosen gives the toolbar "Ver passos" and "Parar tarefa" / "Parar tudo de Dev".
 */

/** The stop in a row's ⋯: its words, and, for one that asks first, its card under the ⋯ (`StopAllConfirm`). */
type RowStop = { label: string; onSelect: () => void; confirm?: (trigger: ReactNode) => ReactNode };

/**
 * `agent`: that agent's card chosen as the page opens (`?agent=`, from its tasks' panel in a DM); `task`: that task's
 * panel open (`?task=`, from a row of a computer's line).
 */
export function TaskManagerPage({
  agent,
  task: openRun,
  onTaskClosed,
}: {
  agent?: string;
  task?: string;
  /** `task`'s panel closed: the address forgets it, so a row of the line opens it again. */
  onTaskClosed?: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const look = useRightHandLook();
  const view = useTaskManager(org.id, { since: todayStart() });
  const now = useNow(1_000);
  const programText = useProgramText();
  const { stop, stopping, said } = useTaskStop();
  const [q, setQ] = useState("");
  // The agent card chosen (null: Todos), the task row chosen (a run id), the agents opened in the table.
  const [card, setCard] = useState<string | null>(agent ?? null);
  useEffect(() => {
    if (agent) setCard(agent);
  }, [agent]);
  const [selected, setSelected] = useState<string | null>(null);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [shut, setShut] = useState<ReadonlySet<string>>(() => new Set());
  const [endedOpen, setEndedOpen] = useState(false);
  // Which "Parar tudo" confirmation is open: the toolbar's, or an agent row's (`row:<id>`).
  const [confirm, setConfirm] = useState<string | null>(null);
  // The task whose steps are open in the panel ("Ver passos"); it stays open after the task ends.
  const [panel, setPanel] = useState<string | null>(openRun ?? null);
  useEffect(() => {
    if (openRun) setPanel(openRun);
  }, [openRun]);
  // The computer whose line is open ("Ver fila"): the line's own dialog, as a conversation's header opens it.
  const [queueOf, setQueueOf] = useState<string | null>(null);
  const openTask = useOpenTask();
  const toast = useToast();
  const cancelReturn = useCancelFollowUp(org.id);
  // The returns being canceled: their ⋯ waits on its spinner, then the row leaves.
  const [canceling, setCanceling] = useState<ReadonlySet<string>>(() => new Set());

  const all = view.data?.tasks ?? [];
  const activity = view.data?.activity;
  // The computers with turns running or waiting for room (ADR 0128).
  const computers = view.data?.computers ?? [];
  const causes = shownCauses(all);
  // A computer with a line holds work too (each turn waits its place): a row of the same block, with Ver fila.
  const lined = computersBesides(computers, causes).filter((c) => c.inLine > 0);
  const nameOf = (id: string) => dir.anyAgent(id)?.name ?? t("channel.unknownAgent");
  const query = q.trim().toLocaleLowerCase();
  const matches = (task: ManagedTask) => {
    if (!query) return true;
    const using = programText(task);
    return [taskTitle(t, task), taskWhere(t, task), nameOf(task.agentId), using?.name, using?.detail]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .includes(query);
  };
  const shown = all.filter(matches);
  const grouped = groupTasks(shown, stopping);
  const summary = agentSummary(all);
  const hidden = view.data?.hidden;

  // The cards: who has tasks, in the table's order, then who worked in the last hour; the chosen one stays.
  const cardIds: string[] = [];
  const addCard = (id: string) => {
    if (!cardIds.includes(id) && listsAgent(org, dir.anyAgent(id))) cardIds.push(id);
  };
  for (const g of groupTasks(all).groups) addCard(g.agentId);
  for (const task of all) addCard(task.agentId);
  for (const id of Object.keys(hidden?.byAgent ?? {})) addCard(id);
  const worked = Object.entries(activity ?? {})
    .filter(([, line]) => line.some((n) => n > 0))
    .map(([id]) => id)
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  for (const id of worked) addCard(id);
  if (card) addCard(card);

  const selTask = all.find((task) => task.runId === selected);
  const stoppableOf = (agentId: string) =>
    tasksOf(all, agentId)
      .filter((task) => task.canStop && !stopping.has(task.runId))
      .map((task) => task.runId);
  const pick = (id: string) => {
    setConfirm(null);
    setSelected((s) => (s === id ? null : id));
  };
  // A search opens every agent, so what it found shows; one folded during it stays folded until the search ends.
  const searching = query !== "";
  useEffect(() => {
    if (!searching) setShut(new Set());
  }, [searching]);
  const isOpen = (key: string) => (searching ? !shut.has(key) : opened.has(key));
  const toggle = (key: string) =>
    (searching ? setShut : setOpened)((was) => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const stopOne = (task: ManagedTask) => stop([task.runId]);
  /** The stop of a task that asked other agents: it and they, after a confirmation. */
  const stopChain = (task: ManagedTask, trigger: ReactNode, anchor = false) => (
    <StopAllConfirm
      anchor={anchor}
      agentId={task.agentId}
      runIds={[task.runId]}
      helpers={task.helpers}
      open={confirm === `chain:${task.runId}`}
      onOpenChange={(open) => setConfirm(open ? `chain:${task.runId}` : null)}
      onStop={(runIds, reason) => stop(runIds, reason, true)}
      trigger={trigger}
    />
  );

  const row = (task: ManagedTask, look: "grouped" | "flat" | "agent") => (
    <TaskRow
      key={task.runId}
      task={task}
      now={now}
      look={look}
      meId={me.user.id}
      agentName={nameOf(task.agentId)}
      chain={delegationText(t, task, (id) => dir.anyAgent(id)?.name, me.user.id)}
      helping={task.delegation?.from ? taskHelping(t, task, (id) => dir.anyAgent(id)?.name) : null}
      stopAll={
        task.helpers
          ? {
              label: t("taskManager.actions.stopAll"),
              onSelect: () => setConfirm(`chain:${task.runId}`),
              confirm: (trigger) => stopChain(task, trigger, true),
            }
          : null
      }
      selected={selected === task.runId}
      stopping={stopping.has(task.runId)}
      onSelect={() => pick(task.runId)}
      onSteps={() => setPanel(task.runId)}
      onOpen={() => openTask(task)}
      onStop={() => stopOne(task)}
    />
  );

  // Everyone's work counts here, as on the computers' rows; what the viewer may not see only counts.
  const working = summary.working + (hidden?.working ?? 0);
  const heading = card ? t("taskManager.agentTasks", { name: nameOf(card) }) : t("taskManager.now");
  const barRunIds = card ? stoppableOf(card) : [];
  const barHelpers = helpersOf(all.filter((task) => barRunIds.includes(task.runId)));
  const stopTool =
    selTask?.canStop && !stopping.has(selTask.runId) && selTask.helpers ? (
      stopChain(
        selTask,
        <Button size="sm" variant="ghost" className="tm-tool-stop">
          <PixelStop size={12} />
          {t("taskManager.actions.stopAll")}
        </Button>,
      )
    ) : selTask?.canStop && !stopping.has(selTask.runId) ? (
      <Button size="sm" variant="ghost" className="tm-tool-stop" onClick={() => stopOne(selTask)}>
        <PixelStop size={12} />
        {t("taskManager.actions.stopTask")}
      </Button>
    ) : !selTask && card && barRunIds.length > 0 ? (
      <StopAllConfirm
        agentId={card}
        runIds={barRunIds}
        helpers={barHelpers}
        open={confirm === "bar"}
        onOpenChange={(open) => setConfirm(open ? "bar" : null)}
        onStop={(runIds, reason) => stop(runIds, reason, barHelpers > 0)}
        trigger={
          <Button size="sm" variant="ghost" className="tm-tool-stop">
            <PixelStop size={12} />
            {t("taskManager.actions.stopAllOf", { name: nameOf(card) })}
          </Button>
        }
      />
    ) : (
      <Button size="sm" variant="ghost" disabled>
        <PixelStop size={12} />
        {t("taskManager.actions.stopTask")}
      </Button>
    );

  const endedShown = (e: EndedTask) =>
    (!card || e.agentId === card) &&
    (!query || `${taskTitle(t, e)} ${nameOf(e.agentId)}`.toLocaleLowerCase().includes(query));
  const ended = (view.data?.ended ?? []).filter(endedShown);
  // The returns agents set ("Retornos"), and those canceled today, by the same card and search.
  const returnShown = (r: Pick<PendingReturn, "agentId" | "about" | "channelName">) =>
    (!card || r.agentId === card) &&
    (!query || `${r.about} ${nameOf(r.agentId)} ${r.channelName ?? ""}`.toLocaleLowerCase().includes(query));
  const followUps = (view.data?.followUps ?? []).filter(returnShown);
  const canceledReturns = (view.data?.canceledFollowUps ?? []).filter(returnShown);
  const openReturn = (r: PendingReturn | CanceledReturn) =>
    openTask({ ...r, messageId: "replyMessageId" in r ? r.replyMessageId : null });
  const cancel = (r: PendingReturn) => {
    const mark = (on: boolean) =>
      setCanceling((was) => {
        const next = new Set(was);
        if (on) next.add(r.messageId);
        else next.delete(r.messageId);
        return next;
      });
    mark(true);
    cancelReturn.mutate(
      { channelId: r.channelId, messageId: r.messageId },
      { onError: (error) => toast.show(errorText(t, error), "error"), onSettled: () => mark(false) },
    );
  };
  const returnsSection =
    followUps.length > 0 ? (
      <TaskSection title={t("taskManager.sections.returns")} count={followUps.length} tasks={[]}>
        {followUps.map((r) => (
          <ReturnRow
            key={r.messageId}
            item={r}
            agentName={nameOf(r.agentId)}
            now={now}
            canceling={canceling.has(r.messageId)}
            onOpen={() => openReturn(r)}
            onCancel={() => cancel(r)}
          />
        ))}
      </TaskSection>
    ) : null;
  // What ended today, the latest first: tasks and the returns that won't come.
  const endedRows = [
    ...ended.map((e) => ({
      at: e.finishedAt,
      node: (
        <EndedRow
          key={e.runId}
          task={e}
          agentName={nameOf(e.agentId)}
          nameOf={(id) => dir.anyAgent(id)?.name}
          meId={me.user.id}
          selected={panel === e.runId}
          onOpen={() => setPanel(e.runId)}
        />
      ),
    })),
    ...canceledReturns.map((r) => ({
      at: r.canceledAt,
      node: (
        <CanceledReturnRow
          key={r.messageId}
          item={r}
          agentName={nameOf(r.agentId)}
          meId={me.user.id}
          onOpen={() => openReturn(r)}
        />
      ),
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <div className="page page--list tm">
      <PageHeader
        title={t("taskManager.title")}
        count={
          (working > 0 || summary.waiting > 0) && (
            <span className="tm-sum">
              {working > 0 && (
                <span className="tm-sum__item">
                  <PixelSpinner size={14} />
                  {t("taskManager.working", { count: working })}
                </span>
              )}
              {summary.waiting > 0 && (
                <span className="tm-sum__item tm-sum__item--wait">
                  <WaitMark />
                  {t("taskManager.waiting", { count: summary.waiting })}
                </span>
              )}
            </span>
          )
        }
        actions={
          <div className="tm-search">
            <SearchField
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onClear={() => setQ("")}
              clearLabel={t("filters.clearSearch")}
              placeholder={t("taskManager.search")}
              aria-label={t("taskManager.search")}
            />
          </div>
        }
      />

      {view.data && <CapacityStrip causes={causes} lined={lined} computers={computers} onQueue={setQueueOf} />}

      {view.isLoading && <LoadingList count={4} avatar={false} />}
      {view.isError && !view.data && <ErrorState error={view.error} onRetry={() => void view.refetch()} />}

      {view.data && cardIds.length > 0 && (
        <Carousel
          label={t("taskManager.cards.label")}
          previousLabel={t("taskManager.cards.previous")}
          nextLabel={t("taskManager.cards.next")}
          className="tm-cards"
        >
          <AgentCard
            agentId={null}
            name={t("taskManager.all")}
            tasks={all}
            hidden={hiddenCount(hidden, null)}
            pressed={card === null}
            onPress={() => {
              setCard(null);
              setSelected(null);
              setConfirm(null);
            }}
          />
          {cardIds.map((id) => (
            <AgentCard
              key={id}
              agentId={id}
              name={nameOf(id)}
              tasks={tasksOf(all, id)}
              hidden={hiddenCount(hidden, id)}
              pressed={card === id}
              onPress={() => {
                setCard((c) => (c === id ? null : id));
                setSelected(null);
                setConfirm(null);
              }}
            />
          ))}
        </Carousel>
      )}

      {view.data && all.length === 0 && !hidden?.total && (
        <EmptyState size="page" agent={look} mood="deal" title={t("taskManager.empty.title")}>
          {t("taskManager.empty.body")}
        </EmptyState>
      )}
      {hidden?.total ? <p className="tm-none">{t("taskManager.hiddenLine", { count: hidden.total })}</p> : null}

      {/* No task on: the returns still list, in the same table (and its width's rules). */}
      {view.data && all.length === 0 && returnsSection && (
        <section className="tm-now" aria-label={t("taskManager.sections.returns")}>
          <TaskTable>{returnsSection}</TaskTable>
        </section>
      )}

      {view.data && all.length > 0 && (
        <section className="tm-now" aria-label={heading}>
          <div className="tm-tools">
            <h2>{heading}</h2>
            <span className="tm-tools__acts">
              <Button
                size="sm"
                variant="ghost"
                icon="list"
                disabled={!selTask}
                onClick={() => selTask && setPanel(selTask.runId)}
              >
                {t("taskManager.actions.steps")}
              </Button>
              {stopTool}
            </span>
          </div>
          {shown.length === 0 ? (
            <EmptyState size="panel" actions={<Button onClick={() => setQ("")}>{t("filters.clearSearch")}</Button>}>
              {t("taskManager.noResults")}
            </EmptyState>
          ) : card ? (
            <TaskTable>
              {tasksOf(shown, card).length > 0 ? (
                <>
                  <TaskWaitLines tasks={tasksOf(shown, card)} />
                  <ul className="tm-list">{tasksOf(shown, card).map((task) => row(task, "agent"))}</ul>
                </>
              ) : (
                <p className="tm-none">{agentCardLine(t, 0, hiddenCount(hidden, card))}</p>
              )}
              {returnsSection}
            </TaskTable>
          ) : (
            <TaskTable>
              {grouped.groups.length > 0 && (
                <TaskSection
                  title={t("taskManager.sections.asked")}
                  count={grouped.groups.reduce((n, g) => n + g.tasks.length, 0)}
                  tasks={grouped.groups.flatMap((g) => g.tasks)}
                >
                  {grouped.groups.map((g) => (
                    <Fragment key={g.agentId}>
                      <AgentRow
                        group={g}
                        name={nameOf(g.agentId)}
                        now={now}
                        open={isOpen(g.agentId)}
                        onToggle={() => toggle(g.agentId)}
                        stopAll={
                          g.stoppable.length > 0
                            ? {
                                label: t("taskManager.actions.stopAllOf", { name: nameOf(g.agentId) }),
                                onSelect: () => setConfirm(`row:${g.agentId}`),
                                confirm: (trigger) => (
                                  <StopAllConfirm
                                    anchor
                                    agentId={g.agentId}
                                    runIds={g.stoppable}
                                    helpers={g.helpers}
                                    open={confirm === `row:${g.agentId}`}
                                    onOpenChange={(open) => setConfirm(open ? `row:${g.agentId}` : null)}
                                    onStop={(runIds, reason) => stop(runIds, reason, g.helpers > 0)}
                                    trigger={trigger}
                                  />
                                ),
                              }
                            : null
                        }
                      />
                      {isOpen(g.agentId) && g.tasks.map((task) => row(task, "grouped"))}
                    </Fragment>
                  ))}
                </TaskSection>
              )}
              {grouped.delegated.length > 0 && (
                <TaskSection
                  title={t("taskManager.sections.delegated")}
                  count={grouped.delegated.reduce((n, g) => n + g.tasks.length, 0)}
                  tasks={grouped.delegated.flatMap((g) => g.tasks)}
                >
                  {grouped.delegated.map((g) => (
                    <Fragment key={g.agentId}>
                      <AgentRow
                        group={g}
                        name={nameOf(g.agentId)}
                        now={now}
                        open={isOpen(`by:${g.agentId}`)}
                        onToggle={() => toggle(`by:${g.agentId}`)}
                        stopAll={
                          g.stoppable.length > 0
                            ? {
                                label: t("taskManager.actions.stopAllOf", { name: nameOf(g.agentId) }),
                                onSelect: () => setConfirm(`by:${g.agentId}`),
                                confirm: (trigger) => (
                                  <StopAllConfirm
                                    anchor
                                    agentId={g.agentId}
                                    runIds={g.stoppable}
                                    open={confirm === `by:${g.agentId}`}
                                    onOpenChange={(open) => setConfirm(open ? `by:${g.agentId}` : null)}
                                    onStop={(runIds, reason) => stop(runIds, reason, true)}
                                    trigger={trigger}
                                  />
                                ),
                              }
                            : null
                        }
                      />
                      {isOpen(`by:${g.agentId}`) && g.tasks.map((task) => row(task, "flat"))}
                    </Fragment>
                  ))}
                </TaskSection>
              )}
              {grouped.background.length > 0 && (
                <TaskSection
                  title={t("taskManager.sections.background")}
                  count={grouped.background.length}
                  tasks={grouped.background}
                >
                  {grouped.background.map((task) => row(task, "flat"))}
                </TaskSection>
              )}
              {returnsSection}
            </TaskTable>
          )}
        </section>
      )}

      {view.data && (
        <section className="tm-ended" aria-label={t("taskManager.ended.title")}>
          <button type="button" className="tm-more" aria-expanded={endedOpen} onClick={() => setEndedOpen((o) => !o)}>
            <Icon name="chevronRight" size={16} className="tm-more__chevron" />
            {t("taskManager.ended.title")}
            <CountChip size="sm">{endedRows.length}</CountChip>
          </button>
          {endedOpen &&
            (endedRows.length > 0 ? (
              <ul className="tm-list tm-list--ended ac-card">{endedRows.map((r) => r.node)}</ul>
            ) : (
              <p className="tm-none">{t("taskManager.ended.none")}</p>
            ))}
        </section>
      )}

      {/* Hung from the shell, like a thread's panel beside its channel: inside the page it would scroll away with the
          list (the page is a containing block, layout.css `.shell__main`). */}
      {panel &&
        createPortal(
          <TaskPanel
            key={panel}
            runId={panel}
            task={all.find((task) => task.runId === panel)}
            ended={view.data?.ended.find((e) => e.runId === panel)}
            stopping={stopping.has(panel)}
            said={said.get(panel)}
            now={now}
            onStop={() => stop([panel], undefined, Boolean(all.find((task) => task.runId === panel)?.helpers))}
            onClose={() => {
              setPanel(null);
              onTaskClosed?.();
            }}
          />,
          document.querySelector(".shell") ?? document.body,
        )}
      {queueOf && (
        <QueueDialog
          machineId={queueOf}
          open
          onOpenChange={(shown) => {
            if (!shown) setQueueOf(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Over the cards, while work waits: what got done today and how much waits, then what holds it, one row a cause
 * (`causeWords`) with its count and its one way out. Hidden when nothing waits.
 */
function CapacityStrip({
  causes,
  lined,
  computers,
  onQueue,
}: {
  causes: WaitCause[];
  /** Computers with a line that aren't a cause already. */
  lined: ComputerSummary[];
  computers: ComputerSummary[];
  onQueue: (machineId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const openTask = useOpenTask();
  if (causes.length + lined.length === 0) return null;
  const row = (cause: WaitCause) => {
    const first = cause.tasks[0] as ManagedTask;
    const words = causeWords(t, i18n.language, cause, computers);
    if (cause.kind === "limit") {
      const brain = first.brain && first.brain !== "model" ? first.brain : null;
      return {
        ...words,
        lead: brain ? <ProviderLogo id={brain} size="xs" /> : <Icon name="clock" size={18} />,
        act: t("taskManager.capacity.usage"),
        onAct: () =>
          void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section: "usage" } }),
      };
    }
    if (cause.kind === "computer")
      return {
        ...words,
        lead: <Icon name="computer" size={18} />,
        act: t("taskManager.capacity.computers"),
        onAct: () =>
          void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section: "computers" } }),
      };
    return { ...words, lead: <WaitMark />, act: t("taskManager.actions.open"), onAct: () => openTask(first) };
  };
  return (
    <section className="tm-causes" aria-label={t("taskManager.capacity.label")}>
      <GroupHeading title={t("taskManager.capacity.label")} count={causes.length + lined.length} />
      <ul className="tm-computers__list ac-card">
        {[
          ...causes.map((cause) => ({ key: cause.key, ...row(cause) })),
          ...lined.map((c) => ({
            key: c.id,
            name: c.name,
            fact: computerRoomText(t, c),
            lead: <Icon name="computer" size={18} />,
            act: t("queue.see"),
            onAct: () => onQueue(c.id),
          })),
        ].map((r) => {
          return (
            <li key={r.key} className="tm-computer tm-cause">
              <span className="tm-computer__icon" aria-hidden="true">
                {r.lead}
              </span>
              <Tip className="tm-computer__text" tip={rowTip(r.name, [r.fact])} look="ac-msg__tip tm-tip">
                <b>{r.name}</b>
                <small>{r.fact}</small>
              </Tip>
              <Tip button look="ac-msg__tip tm-tip" tip={rowTip(r.name, [r.fact])}>
                <Button variant="link" aria-label={`${r.act}: ${r.name}`} onClick={r.onAct}>
                  {r.act}
                </Button>
              </Tip>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The table: the columns' names (for the eye; each cell says what it is), then its sections. */
function TaskTable({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="tm-table ac-card">
      <div className="tm-row tm-row--head" aria-hidden="true">
        <span>{t("taskManager.columns.task")}</span>
        <span>{t("taskManager.columns.state")}</span>
        <span>{t("taskManager.columns.using")}</span>
        <span className="tm-cell--time">{t("taskManager.columns.time")}</span>
      </div>
      {children}
    </div>
  );
}

/** "Pedidas por pessoas 6", "Rotinas em segundo plano 2": a section of the table, what its rows wait on over them. */
function TaskSection({
  title,
  count,
  tasks,
  children,
}: {
  title: string;
  count: number;
  tasks: ManagedTask[];
  children: ReactNode;
}) {
  return (
    <section className="tm-section" aria-label={title}>
      <h3 className="tm-sec">
        {title}
        <span className="tm-sec__count">{count}</span>
      </h3>
      <TaskWaitLines tasks={tasks} />
      <ul className="tm-list">{children}</ul>
    </section>
  );
}

/**
 * One task, one line: what it is (the whole row picks it) and what it is about, its state, what it uses now, its time
 * (shaded as it grows, but not on a wait with a known reason: that isn't stuck), and ⋯ with Abrir na conversa, Ver
 * passos and Parar tarefa. What comes next of a wait and what it does in its program are in its tip. `grouped` sits under its agent's
 * row; `flat` (a routine's background run, work agents asked) shows its agent's face, and its state as a mark when the
 * columns don't fit; `agent` is the list of one agent's tasks (its card chosen).
 */
function TaskRow({
  task,
  now,
  look,
  meId,
  agentName,
  chain,
  helping,
  stopAll,
  selected,
  stopping,
  onSelect,
  onSteps,
  onOpen,
  onStop,
}: {
  task: ManagedTask;
  now: number;
  look: "grouped" | "flat" | "agent";
  meId: string;
  agentName: string;
  /** Who asked it among agents, and what started the chain. */
  chain: string | null;
  /** Work another agent handed it, where the reader sees where: "ajudando a Ada". */
  helping: string | null;
  /** A task that asked other agents stops with them: this stop, in place of its own. */
  stopAll: RowStop | null;
  selected: boolean;
  stopping: boolean;
  onSelect: () => void;
  /** "Ver passos": its panel. */
  onSteps: () => void;
  /** "Abrir na conversa", where it has one. */
  onOpen: () => void;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  const status = useTaskStatus();
  const title = taskTitle(t, task);
  const where = taskPlace(t, task);
  const asked = task.requester
    ? task.requester.userId === meId
      ? t("taskManager.askedByYou")
      : t("taskManager.askedBy", { name: task.requester.name })
    : null;
  const helpers = task.helpers ? t("taskManager.helpers", { count: task.helpers }) : null;
  // Work another agent handed it, where its reader can see it: "ajudando a Ada · #vendas" (ADR 0084 addendum).
  const sub = [
    look === "flat"
      ? [agentName, helping ?? chain ?? where, helping ? where : null].filter(Boolean).join(" · ")
      : taskSub(t, task, [where, task.background ? null : (chain ?? asked)].filter(Boolean).join(" · ")),
    helpers,
  ]
    .filter(Boolean)
    .join(" · ");
  // A routine's run shows its agent's face (its section has no agent rows); a person's task, its state's mark.
  const face = (
    <OpensAgent agentId={task.agentId}>
      <AgentAvatar agentId={task.agentId} name={agentName} size="xs" />
    </OpensAgent>
  );
  return (
    <li className="tm-row" data-look={look} data-selected={selected || undefined}>
      <span className="tm-cell tm-cell--name">
        {look === "flat" ? face : <TaskMark task={task} />}
        <RowName
          title={title}
          sub={sub}
          tip={[sub, ...status(task, stopping)].filter(Boolean)}
          aria-pressed={selected}
          onClick={onSelect}
        />
      </span>
      <span className="tm-cell tm-cell--state">
        <TaskStateChip task={task} stopping={stopping} line />
        {/* Its face leads the row: with no room for the columns, how it stands is this mark. */}
        {look === "flat" && <TaskMark task={task} />}
      </span>
      <span className="tm-cell tm-cell--use">
        <UsingNow task={task} line />
      </span>
      <TaskTime task={task} now={now} />
      <span className="tm-cell tm-cell--act">
        <RowMenu
          label={title}
          stop={
            task.canStop && !stopping
              ? (stopAll ?? { label: t("taskManager.actions.stopTask"), onSelect: onStop })
              : null
          }
        >
          {opensInChat(task) && (
            <MenuItem icon="message" onSelect={onOpen}>
              {t("taskManager.actions.open")}
            </MenuItem>
          )}
          <MenuItem icon="list" onSelect={onSteps}>
            {t("taskManager.actions.steps")}
          </MenuItem>
        </RowMenu>
      </span>
    </li>
  );
}

/**
 * A row's ⋯: its actions as a menu, named for screen readers by the row (`label`), its stop last in the danger tint.
 * A stop that asks first opens its card under the ⋯ once the menu has closed, so the focus lands in the card.
 */
function RowMenu({ label, stop, children }: { label: string; stop?: RowStop | null; children?: ReactNode }) {
  const { t } = useTranslation();
  const after = useRef<(() => void) | null>(null);
  const more = t("taskManager.actions.more");
  const menu = (
    <Menu
      align="end"
      label={label}
      onClosed={() => {
        after.current?.();
        after.current = null;
      }}
      trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={`${more}: ${label}`} title={more} />}
    >
      {children}
      {stop && (
        <MenuItem
          icon="stop"
          danger
          onSelect={
            stop.confirm
              ? () => {
                  after.current = stop.onSelect;
                }
              : stop.onSelect
          }
        >
          {stop.label}
        </MenuItem>
      )}
    </Menu>
  );
  return stop?.confirm ? stop.confirm(menu) : menu;
}

/** "Tempo": the task's time (`taskTime`), warming as its work goes on; a wait never warms, it isn't stuck. */
function TaskTime({ task, now }: { task: ManagedTask; now: number }) {
  const { t } = useTranslation();
  return (
    <span
      className="tm-cell tm-cell--time ac-num"
      style={{ "--h": taskState(task) === "waiting" ? 0 : heatOf(taskAge(task, now)) } as CSSProperties}
    >
      {taskTime(t, task, now)}
    </span>
  );
}

/**
 * An agent's row over its tasks, one line, folded until opened (the whole row opens it): its face and count, how it
 * stands, the apps it uses now, the time of the task its state is about (`groupLead`), and ⋯ with its stop for all of
 * them.
 * With no room for the columns, how it stands is that task's mark.
 */
function AgentRow({
  group,
  name,
  now,
  open,
  onToggle,
  stopAll,
}: {
  group: AgentTasks;
  name: string;
  now: number;
  open: boolean;
  onToggle: () => void;
  stopAll: RowStop | null;
}) {
  const { t } = useTranslation();
  const status = useTaskStatus();
  const lead = groupLead(group);
  // Waiting beats queued, working beats both (someone waits on it while it works on something else).
  const working = group.tasks.find((task) => taskState(task) === "working");
  const held = group.tasks.find((task) => taskState(task) === "waiting");
  const state = working ? (
    <TaskStateChip task={working} line />
  ) : group.waiting > 0 ? (
    <Chip tone="waiting" lead={<WaitMark />}>
      {t("taskManager.waiting", { count: group.waiting })}
    </Chip>
  ) : held ? (
    <TaskStateChip task={held} line />
  ) : (
    <Chip icon="clock">{t("taskManager.state.queued")}</Chip>
  );
  const count = t("taskManager.tasks", { count: group.tasks.length });
  return (
    <li className="tm-row tm-row--agent" data-open={open || undefined}>
      <span className="tm-cell tm-cell--name">
        <span className="tm-twist" aria-hidden="true">
          <Icon name="chevronDown" size={14} />
        </span>
        <OpensAgent agentId={group.agentId}>
          <AgentAvatar agentId={group.agentId} name={name} size="xs" />
        </OpensAgent>
        <RowName
          title={name}
          tip={[count, ...status(lead)]}
          aria-expanded={open}
          aria-label={t("taskManager.toggleAgent", { name })}
          onClick={onToggle}
        />
        <CountChip size="sm" aria-label={count}>
          {group.tasks.length}
        </CountChip>
      </span>
      <span className="tm-cell tm-cell--state">
        {state}
        <TaskMark task={lead} />
      </span>
      <span className="tm-cell tm-cell--use">
        <ProgramStack tasks={group.tasks} />
      </span>
      <TaskTime task={lead} now={now} />
      <span className="tm-cell tm-cell--act">{stopAll && <RowMenu label={name} stop={stopAll} />}</span>
    </li>
  );
}

/** One agent on a card: its face, name and tasks, who waits on it, and its last half hour edge to edge. */
function AgentCard({
  agentId,
  name,
  tasks,
  hidden,
  pressed,
  onPress,
}: {
  /** Null: "Todos", every task. */
  agentId: string | null;
  name: string;
  tasks: ManagedTask[];
  /** Its tasks the viewer may not see. */
  hidden: number;
  pressed: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const { waiting } = agentSummary(tasks);
  const count = tasks.length + hidden;
  const label = [
    name,
    agentCardLine(t, tasks.length, hidden),
    waiting > 0 ? t("taskManager.waiting", { count: waiting }) : "",
  ]
    .filter(Boolean)
    .join(", ");
  // A filter chip: the face, the name and how many tasks, the waiting mark when one waits on a person.
  return (
    <span className={cx("ac-filter tm-chip", pressed && "ac-filter--active")}>
      <button
        type="button"
        className="ac-filter__trigger"
        aria-pressed={pressed}
        aria-label={label}
        title={name}
        onClick={onPress}
      >
        {agentId && <AgentAvatar agentId={agentId} name={name} size="xs" />}
        <span className="ac-filter__text">{name}</span>
        <span className="tm-chip__n ac-num">{count}</span>
        {waiting > 0 && <WaitMark />}
      </button>
    </span>
  );
}

const ENDED_ICON: Record<"done" | "stopped" | "failed", IconName> = {
  done: "check",
  stopped: "stop",
  failed: "alert",
};

/**
 * What ended today, one line: the task, its agent and where, how it ended (and who stopped it), how long it took. The
 * row opens its panel, as a task still on does: its steps and "Abrir na conversa". With no room for the columns, how
 * it ended is its mark.
 */
function EndedRow({
  task,
  agentName,
  nameOf,
  meId,
  selected,
  onOpen,
}: {
  task: EndedTask;
  agentName: string;
  /** An agent's name: the right hand that stopped the task at someone's word. */
  nameOf: (agentId: string) => string | undefined;
  meId: string;
  selected: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const state = endedState(task);
  const word = endedText(t, task, meId, nameOf);
  const took = formatDuration(
    t,
    Math.max(0, Date.parse(task.finishedAt) - Date.parse(task.startedAt ?? task.finishedAt)),
  );
  const sub = [agentName, taskPlace(t, task)].filter(Boolean).join(" · ");
  return (
    <li className="tm-row tm-row--ended" data-selected={selected || undefined}>
      <span className="tm-cell tm-cell--name">
        <OpensAgent agentId={task.agentId}>
          <AgentAvatar agentId={task.agentId} name={agentName} size="xs" />
        </OpensAgent>
        <RowName
          title={taskTitle(t, task)}
          sub={sub}
          tip={[sub, `${word} · ${took}`]}
          aria-pressed={selected}
          onClick={onOpen}
        />
      </span>
      <span className="tm-cell tm-cell--state">
        <Chip icon={ENDED_ICON[state]}>{word}</Chip>
        <span className="tm-mark" aria-hidden="true">
          <Icon name={ENDED_ICON[state]} size={14} />
        </span>
      </span>
      <span className="tm-cell tm-cell--time ac-num">{took}</span>
    </li>
  );
}

/**
 * A return an agent set (ADR 0037), one line: the clock, her words and where (the agent, the conversation), when it
 * comes ("Às 00:32"; once its time passed waiting on an answer, that), how soon, and ⋯ with "Abrir na conversa" and,
 * for who may, "Cancelar retorno". The row opens the conversation at the reply that set it.
 */
function ReturnRow({
  item,
  agentName,
  now,
  canceling,
  onOpen,
  onCancel,
}: {
  item: PendingReturn;
  agentName: string;
  now: number;
  canceling: boolean;
  onOpen: () => void;
  onCancel: () => void;
}) {
  const { t, i18n } = useTranslation();
  const sub = [agentName, returnPlace(t, item)].filter(Boolean).join(" · ");
  const state = item.held ? t("threads.status.input") : returnWhen(t, i18n.language, item.at, now, true);
  const soon = item.held
    ? null
    : t("followUps.inTime", { time: formatLineTime(i18n.language, Math.max(1000, Date.parse(item.at) - now)) });
  return (
    <li className="tm-row" data-look="return">
      <span className="tm-cell tm-cell--name">
        <span className="tm-mark" aria-hidden="true">
          <Icon name="clock" size={14} />
        </span>
        <RowName title={item.about} sub={sub} tip={[sub, state, soon ?? ""].filter(Boolean)} onClick={onOpen} />
      </span>
      <span className="tm-cell tm-cell--state">
        <Chip icon="clock">{state}</Chip>
      </span>
      <span className="tm-cell tm-cell--use">
        <span className="tm-use tm-use--none">—</span>
      </span>
      <span className="tm-cell tm-cell--time ac-num">{soon}</span>
      <span className="tm-cell tm-cell--act">
        <Menu
          align="end"
          label={item.about}
          trigger={
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="more"
              loading={canceling}
              aria-label={`${t("taskManager.actions.more")}: ${item.about}`}
              title={t("taskManager.actions.more")}
            />
          }
        >
          <MenuItem icon="message" onSelect={onOpen}>
            {t("taskManager.actions.open")}
          </MenuItem>
          {item.canCancel && (
            <MenuItem icon="close" danger onSelect={onCancel}>
              {t("followUps.cancel")}
            </MenuItem>
          )}
        </Menu>
      </span>
    </li>
  );
}

/** A return that won't come, among what ended today: who canceled it (nobody: its time found it couldn't). */
function CanceledReturnRow({
  item,
  agentName,
  meId,
  onOpen,
}: {
  item: CanceledReturn;
  agentName: string;
  meId: string;
  onOpen: () => void;
}) {
  const { t, i18n } = useTranslation();
  const word = returnCanceledText(t, item, meId, agentName);
  const sub = [agentName, returnPlace(t, item)].filter(Boolean).join(" · ");
  const at = returnClock(t, i18n.language, item.at, Date.parse(item.canceledAt));
  return (
    <li className="tm-row tm-row--ended">
      <span className="tm-cell tm-cell--name">
        <OpensAgent agentId={item.agentId}>
          <AgentAvatar agentId={item.agentId} name={agentName} size="xs" />
        </OpensAgent>
        <RowName title={item.about} sub={sub} tip={[sub, `${word} · ${at}`]} onClick={onOpen} />
      </span>
      <span className="tm-cell tm-cell--state">
        <Chip icon="clock">{word}</Chip>
        <span className="tm-mark" aria-hidden="true">
          <Icon name="clock" size={14} />
        </span>
      </span>
      <span className="tm-cell tm-cell--time ac-num">{at}</span>
    </li>
  );
}
