import {
  runningAgents,
  useAgentStatuses,
  useCancelFollowUp,
  useContinueTasks,
  useNotificationCount,
  useTaskManager,
  useWaitingOnMe,
} from "@agenteschat/client";
import { returnWhen, WORK_TICK_MS } from "@agenteschat/client/lib/agent-work";
import {
  type AgoraItem,
  type AgoraSection,
  agoraContext,
  agoraGlyph,
  agoraPhrase,
  agoraSections,
  agoraTime,
  helpsWhom,
  SHORT_NAME,
  waitsOnSomeone,
} from "@agenteschat/client/lib/agora";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatLineTime } from "@agenteschat/client/lib/format";
import { linePlace, taskWaitWords, todayStart } from "@agenteschat/client/lib/task-manager";
import {
  Button,
  cx,
  GroupHeading,
  Icon,
  Menu,
  MenuItem,
  MenuSeparator,
  PixelSpinner,
  Popover,
  Spinner,
} from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, withAgentFace } from "@/components/AgentAvatar";
import { QueueDialog } from "@/components/ComputerQueue";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { WaitMark } from "@/components/RequestCard";
import { colorOf } from "@/components/Sky";
import { RowName, StopAllInline, useOpenTask, useProgramText, useTaskStop } from "@/components/tasks/TaskBits";
import { useDirectory } from "@/hooks/useDirectory";
import { useNow } from "@/hooks/useNow";
import { useToast } from "@/lib/toast";
import { useStreams } from "@/realtime/context";
import "./agora.css";

/*
 * Agora (ADR 0128 addendum of 2026-11-14): the whole workspace's work in one place. A 32px button beside "Ir para…" (a
 * 40px tile under ⌘K in the rail, the end of the Mac app's title bar) whose glyph is the state: the task manager's icon
 * at rest, the orbit in the longest-running agent's tones while work runs, the amber wait mark when something waits on
 * you. No count: the bell and "Esperando você" count. Its popover reads the task manager's list only while open (every
 * 3 s): what waits on you, who works, what waits on someone or something else, one line a row, whole in its tip.
 */

const SECTIONS: AgoraSection[] = ["you", "working", "waiting"];

/**
 * `below`: its list opens under it (the Mac app's title bar, a phone's drawer), else on its right, clear of the
 * sidebar's agents. `size`: the title bar's buttons'; the sidebar's sizes it as the collapse beside it.
 */
export function AgoraButton({ below = false, size, className }: { below?: boolean; size?: "sm"; className?: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const statuses = useAgentStatuses(org.id).data;
  const waitingOnMe = useNotificationCount(org.id).data?.waiting ?? 0;
  // A run this tab hears at work, before the agents' list says so.
  const liveKey = useStreams((st) => [...runningAgents(st)].sort().join());
  const glyph = useMemo(
    () => agoraGlyph(statuses, waitingOnMe, new Set(liveKey ? liveKey.split(",") : [])),
    [statuses, waitingOnMe, liveKey],
  );
  const [open, setOpen] = useState(false);
  // Beside the sidebar it opens past the sidebar's edge, so it covers none of the agents' rows (their counts at the end).
  const button = useRef<HTMLButtonElement>(null);
  const [offset, setOffset] = useState(6);
  const toggle = (next: boolean) => {
    const at = button.current;
    const edge = at?.closest(".sidebar")?.getBoundingClientRect().right;
    if (next && at && edge && !below) setOffset(Math.max(6, edge - at.getBoundingClientRect().right + 6));
    setOpen(next);
  };
  // The computer whose line a row opened ("Ver fila"), as the task manager opens it.
  const [queue, setQueue] = useState<string | null>(null);
  const tip =
    glyph.mark === "idle"
      ? t("taskManager.empty.title")
      : [
          glyph.working > 0 ? t("agora.working", { count: glyph.working }) : null,
          glyph.waiting > 0 ? t("agora.waiting", { count: glyph.waiting }) : null,
        ]
          .filter(Boolean)
          .join("\n");
  return (
    <>
      <Popover
        open={open}
        onOpenChange={toggle}
        side={below ? "bottom" : "right"}
        align={below ? "end" : "start"}
        sideOffset={offset}
        label={t("agora.label")}
        className="agora"
        trigger={
          <Button
            ref={button}
            variant="ghost"
            size={size}
            iconOnly
            className={cx("agora-btn", className)}
            data-mark={glyph.mark}
            aria-label={t("agora.label")}
            // Its state for screen readers off the keys' focus too (the tip says it on hover and focus).
            aria-description={tip.replaceAll("\n", ". ")}
            title={tip}
          >
            {glyph.mark === "you" ? (
              <WaitMark />
            ) : glyph.mark === "working" ? (
              <PixelSpinner size={16} color={glyph.agentId ? colorOf(dir.anyAgent(glyph.agentId)) : undefined} />
            ) : (
              <Icon name="stageProgress" size={16} />
            )}
          </Button>
        }
      >
        <AgoraList
          onLeave={() => setOpen(false)}
          onQueue={(machineId) => {
            setOpen(false);
            setQueue(machineId);
          }}
        />
      </Popover>
      {queue && (
        <QueueDialog
          machineId={queue}
          open
          onOpenChange={(shown) => {
            if (!shown) setQueue(null);
          }}
        />
      )}
    </>
  );
}

/**
 * The popover's list: its sections (the first closes with what else waits on the reader), then the work the reader
 * may not see, then the task manager.
 */
function AgoraList({ onLeave, onQueue }: { onLeave: () => void; onQueue: (machineId: string) => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const view = useTaskManager(org.id, { since: todayStart() });
  const now = useNow(WORK_TICK_MS / 4);
  const sections = useMemo(() => agoraSections(view.data), [view.data]);
  const openTask = useOpenTask();
  const { stop, stopping } = useTaskStop();
  const goOn = useContinueTasks(org.id);
  const cancelReturn = useCancelFollowUp(org.id);
  // What this list set going: a row asking whether to stop, returns being canceled, waits going on.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const mark = (key: string, on: boolean) =>
    setBusy((was) => {
      const next = new Set(was);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const hidden = view.data?.hidden?.total ?? 0;
  // The sidebar's "Esperando você" count: join requests, proposals… too. Past this list's rows, a line leads there.
  // Not by count: an admin decides approvals whose inbox item only the agent's responsável gets, so the rows can
  // outnumber the inbox while a request to join still waits. The line shows while the inbox holds anything that
  // isn't one of these rows' cards.
  const waitingOnMe = useNotificationCount(org.id).data?.waiting ?? 0;
  const cards = new Set(
    sections.you.flatMap((i) => (i.kind === "task" && i.task.work?.card ? [i.task.work.card] : [])),
  );
  const elsewhere = (useWaitingOnMe(org.id).data?.items ?? []).some(
    (w) => !w.source.messageId || !cards.has(w.source.messageId),
  );
  const allWaiting = elsewhere ? waitingOnMe : 0;
  // Nothing on only when nothing is hidden from the reader either: the button orbits for work they can't list.
  const empty = SECTIONS.every((s) => sections[s].length === 0) && hidden === 0 && allWaiting === 0;

  const open = (item: AgoraItem) => {
    if (item.kind === "return") {
      onLeave();
      openTask({ ...item.ret, messageId: item.ret.replyMessageId });
      return;
    }
    const line = linePlace(item.task);
    if (line) return onQueue(line.machineId);
    onLeave();
    // A wait on a person opens at its card, lit; work at where it is (handed off: at the reply that handed it).
    openTask({ ...item.task, messageId: waitsOnSomeone(item.state) ? (item.task.work?.card ?? null) : null });
  };
  const actions = (item: AgoraItem): RowAction[] => {
    if (item.kind === "return")
      return item.ret.canCancel
        ? [
            {
              key: "cancel",
              icon: "close",
              label: t("followUps.cancel"),
              danger: true,
              run: () => {
                mark(item.key, true);
                cancelReturn.mutate(
                  { channelId: item.ret.channelId, messageId: item.ret.messageId },
                  {
                    onError: (error) => toast.show(errorText(t, error), "error"),
                    onSettled: () => mark(item.key, false),
                  },
                );
              },
            },
          ]
        : [];
    const task = item.task;
    return [
      {
        key: "steps",
        icon: "list",
        label: t("taskManager.actions.steps"),
        run: () => {
          onLeave();
          void navigate({ to: "/org/$orgId/task-manager", params: { orgId: org.id }, search: { task: task.runId } });
        },
      },
      ...(task.wait?.canContinue
        ? [
            {
              key: "continue",
              icon: "play" as const,
              label: t("usageCard.continue"),
              run: () => {
                mark(item.key, true);
                goOn.mutate([task.runId], { onSettled: () => mark(item.key, false) });
              },
            },
          ]
        : []),
      ...(task.canStop
        ? [
            {
              key: "stop",
              icon: "stop" as const,
              label: t("taskManager.actions.stop"),
              danger: true,
              apart: true,
              run: () => setConfirming(item.key),
            },
          ]
        : []),
    ];
  };

  return (
    <>
      <div className="agora__list">
        {view.isLoading ? (
          <LoadingList count={3} />
        ) : view.isError && !view.data ? (
          <ErrorState error={view.error} onRetry={() => void view.refetch()} />
        ) : empty ? (
          <p className="agora__none">{t("home.working.none")}</p>
        ) : (
          SECTIONS.map((s) =>
            sections[s].length > 0 || (s === "you" && allWaiting > 0) ? (
              <section key={s} className="agora__section" aria-label={t(`agora.sections.${s}`)}>
                {sections[s].length > 0 && (
                  <GroupHeading level={3} title={t(`agora.sections.${s}`)} count={sections[s].length} />
                )}
                <ul className="agora__rows">
                  {sections[s].map((item) =>
                    confirming === item.key && item.kind === "task" ? (
                      <li key={item.key} className="agora-row agora-row--confirm">
                        <StopRow
                          item={item}
                          onCancel={() => setConfirming(null)}
                          onStop={(reason) => {
                            setConfirming(null);
                            stop([item.task.runId], reason, Boolean(item.task.helpers));
                          }}
                        />
                      </li>
                    ) : (
                      <AgoraRow
                        key={item.key}
                        item={item}
                        now={now}
                        stopping={item.kind === "task" && stopping.has(item.task.runId)}
                        busy={busy.has(item.key)}
                        actions={actions(item)}
                        onOpen={() => open(item)}
                      />
                    ),
                  )}
                  {s === "you" && allWaiting > 0 && (
                    <li className="agora-row agora-row--all">
                      <WaitMark still />
                      <Link to="/org/$orgId/waiting" params={{ orgId: org.id }} onClick={onLeave}>
                        {t("agora.allWaiting", { count: allWaiting })}
                      </Link>
                      <Icon name="chevronRight" size={16} />
                    </li>
                  )}
                </ul>
              </section>
            ) : null,
          )
        )}
        {hidden > 0 && <p className="agora__none">{t("taskManager.hiddenLine", { count: hidden })}</p>}
      </div>
      <div className="agora__foot">
        <Button size="sm" asChild>
          <Link to="/org/$orgId/task-manager" params={{ orgId: org.id }} onClick={onLeave}>
            {t("agora.openManager")}
            <Icon name="chevronRight" size={16} />
          </Link>
        </Button>
      </div>
    </>
  );
}

interface RowAction {
  key: string;
  icon: "close" | "list" | "play" | "stop";
  label: string;
  danger?: boolean;
  /** After a separator. */
  apart?: boolean;
  run: () => void;
}

/**
 * One row, one line: the agent's face (its halo at work, looking up while it waits on a person), its name and what it
 * does in an agent's line's words ("ajudando a Ada", "esperando você" in amber), where and on what in quiet type, cut
 * with "…", its time, and ⋯. Whole in its tip. The row opens its place; while it stops it says so and does nothing.
 */
function AgoraRow({
  item,
  now,
  stopping,
  busy,
  actions,
  onOpen,
}: {
  item: AgoraItem;
  now: number;
  stopping: boolean;
  /** A cancel or a Continuar agora going: its spinner, nothing to press. */
  busy: boolean;
  actions: RowAction[];
  onOpen: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const programText = useProgramText();
  const name = dir.anyAgent(item.agentId)?.name ?? t("channel.unknownAgent");
  const forId = helpsWhom(item);
  const forName = forId ? dir.anyAgent(forId)?.name : undefined;
  const phrase = stopping ? t("agentWork.stopping") : agoraPhrase(t, i18n.language, item, forName, now);
  const context = agoraContext(t, item);
  const time = agoraTime(i18n.language, item, now);
  // The rest of what the row knows, for its tip: what it uses now, or what comes next of its wait.
  const more =
    item.kind === "return"
      ? item.ret.held
        ? null
        : `${returnWhen(t, i18n.language, item.ret.at, now, true)} · ${t("followUps.inTime", {
            time: formatLineTime(i18n.language, Math.max(1000, Date.parse(item.ret.at) - now)),
          })}`
      : item.state === "working"
        ? [programText(item.task)?.name, programText(item.task)?.detail].filter(Boolean).join(" · ")
        : (taskWaitWords(t, i18n.language, item.task, now)?.next ?? null);
  const title = `${name} ${phrase}`;
  const held = stopping || busy;
  return (
    <li className="agora-row" data-state={item.state} data-held={held || undefined}>
      <AgentAvatar
        agentId={item.agentId}
        name={name}
        size="xs"
        state={item.state === "working" && !held ? "thinking" : waitsOnSomeone(item.state) ? "waiting" : "idle"}
      />
      <RowName
        title={title}
        sub={context}
        tip={[context, more, time].filter((line): line is string => Boolean(line))}
        disabled={held}
        onClick={onOpen}
      >
        <span className="agora-row__who">
          {/* A long name keeps 2.5em on a short line, a short one stays whole (agora.css). */}
          <b data-long={name.length > SHORT_NAME || undefined}>{name}</b>{" "}
          <span className="agora-row__phrase">
            {forName ? withAgentFace(phrase, forName, forId ?? undefined) : phrase}
          </span>
        </span>
      </RowName>
      <span className="agora-row__time ac-num">{held ? <Spinner size={14} /> : time}</span>
      {actions.length > 0 ? (
        <Menu
          align="end"
          label={title}
          trigger={
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="more"
              className="agora-row__more"
              disabled={held}
              aria-label={`${t("agora.actions")}: ${title}`}
            />
          }
        >
          {actions.flatMap((a) => [
            ...(a.apart ? [<MenuSeparator key={`${a.key}-apart`} />] : []),
            <MenuItem key={a.key} icon={a.icon} danger={a.danger} onSelect={a.run}>
              {a.label}
            </MenuItem>,
          ])}
        </Menu>
      ) : (
        <span aria-hidden="true" />
      )}
    </li>
  );
}

/**
 * "Parar" asked in the row: the task manager's confirmation (its words, an optional reason), with what else the stop
 * does for work another agent handed it (that agent is told and won't ask again on its own).
 */
function StopRow({
  item,
  onCancel,
  onStop,
}: {
  item: Extract<AgoraItem, { kind: "task" }>;
  onCancel: () => void;
  onStop: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const asker = item.task.delegation ? dir.anyAgent(item.task.delegation.agentId)?.name : undefined;
  return (
    <StopAllInline
      agentId={item.agentId}
      runIds={[item.task.runId]}
      helpers={item.task.helpers ?? 0}
      note={item.task.delegation ? t("taskManager.delegated.stopNote", { name: asker ?? "" }) : null}
      className="agora-row__confirm"
      onCancel={onCancel}
      onStop={(_runIds, reason) => onStop(reason)}
    />
  );
}
