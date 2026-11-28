import type {
  Agent,
  AppNotification,
  Approval,
  Member,
  NotificationActor,
  NotificationFilter,
} from "@agenteschat/client";
import {
  dropNotification,
  keys,
  useAiStatus,
  useApi,
  useApproval,
  useApprovals,
  useChannels,
  useNotificationAction,
  useNotificationBulkPending,
  useNotificationCount,
  useNotificationReply,
  useNotifications,
  useTaskConversation,
  useThreadMessages,
} from "@agenteschat/client";
import { approvalCardItems } from "@agenteschat/client/lib/approval-card";
import { approvalOriginWords } from "@agenteschat/client/lib/approval-origin";
import { appCreatedLine } from "@agenteschat/client/lib/apps";
import { computerOutageLine, isComputerOutage } from "@agenteschat/client/lib/computer-outage";
import { deviceNoticeOf } from "@agenteschat/client/lib/devices";
import { errorText, restrictionLine } from "@agenteschat/client/lib/errors";
import { daysBetween, formatShortDate, formatTime, namesText, timeLeft } from "@agenteschat/client/lib/format";
import { agentGrammar, isFeminineName } from "@agenteschat/client/lib/grammar";
import { plainLine } from "@agenteschat/client/lib/markdown";
import { mediaKindOf, mediaWord, messageMediaOf, textOrMedia } from "@agenteschat/client/lib/media";
import { latestText } from "@agenteschat/client/lib/message-body";
import {
  allItems,
  askersOf,
  canClearAll,
  channelOf,
  groupByDay,
  headlineNames,
  isExpandable,
  MENTION_RE,
  NOTIFICATION_FILTERS,
  opensConnectAi,
  replyTarget,
  restrictionOf,
  runFailedGroupOf,
  snoozeTimes,
  sortWaiting,
  stepCells,
  teamWatchOf,
  WIDGET_NOTICES,
  widgetNoticeOf,
  workspaceHeadline,
} from "@agenteschat/client/lib/notifications";
import { usageLimitLine } from "@agenteschat/client/lib/person-usage";
import { routineNotificationWords } from "@agenteschat/client/lib/routine-view";
import { secretNoticeLine } from "@agenteschat/client/lib/secret-requests";
import {
  Button,
  cx,
  EmptyState,
  GroupHeading,
  Icon,
  type IconName,
  Kbd,
  Locked,
  Mention,
  Menu,
  MenuHeading,
  MenuItem,
  MenuRadioGroup,
  MenuSeparator,
  modKey,
  PageHeader,
  PlanStrip,
  prefersReducedMotion,
  Refreshing,
  Spinner,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { Fragment, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AdminAskActions } from "@/components/AdminAsk";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ApprovalAsk, ApprovalGroupAsk } from "@/components/ApprovalAsk";
import { useConnectAi } from "@/components/connect-ai-context";
import { DeviceNoticeActions, deviceNoticeLine } from "@/components/devices/DeviceNotice";
import { ErrorState, LoadingCards } from "@/components/Loading";
import { useNotificationHref, useNotificationOpener } from "@/components/NotificationOpen";
import { type Dir, Face, Headline, joinerOf, nameOf, SystemFace, sayWords } from "@/components/NotificationParts";
import { useOrg } from "@/components/org-context";
import { UsageLimitActions } from "@/components/PeopleUsage";
import { AllowTalkButton } from "@/components/ReachLines";
import { RequestCard, RequestChoices, RequestKeys } from "@/components/RequestCard";
import { ChangeRequestCard } from "@/components/RightHandCards";
import { CardSky, colorOf, prepareBurst } from "@/components/Sky";
import { WidgetNoticeActions, widgetNoticeLine } from "@/components/widgets/WidgetNotice";
import { useDirectory } from "@/hooks/useDirectory";
import { useInboxWaiting } from "@/hooks/useInboxWaiting";
import { matchesNow } from "@/hooks/useMatchMedia";
import { lookOf } from "@/lib/look";
import { useToast } from "@/lib/toast";
import {
  ApprovalLinesProvider,
  ApprovalRow,
  ApproveAllByAgent,
  approvalDecidedAt,
  decidedGroups,
} from "@/pages/ApprovalsPage";
import { useLiveStore } from "@/realtime/context";
import "./notifications.css";

/** Where the screen shows the list or the open item, one at a time (notifications.css). */
const NARROW = "(max-width: 900px)";

/** An agent stopped this long on my answer is late (the chip turns to attention). */
const LATE_MS = 20 * 60_000;
/** An approval this close to expiring is urgent. */
const URGENT_MS = 3 * 3_600_000;
/** The exit: slide out, then fold the space (approvals use the same timing). */
const LEAVE_MS = 450;

type SnoozeChoice = "hour" | "tomorrow" | "nextWeek";

/** "agora", "há 25 min", "há 2 h", "ontem 18:02", "sex 14:20", "12 out". */
function whenText(t: TFunction, locale: string, iso: string, now = new Date()) {
  const diff = now.getTime() - new Date(iso).getTime();
  if (diff < 60_000) return t("common.now");
  if (diff < 3_600_000) return t("format.minutesAgo", { count: Math.floor(diff / 60_000) });
  const days = daysBetween(iso, now);
  if (days <= 0) return t("format.hoursAgo", { count: Math.floor(diff / 3_600_000) });
  if (days === 1) return t("format.yesterdayAt", { time: formatTime(locale, iso) });
  if (days < 7)
    return `${new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(iso))} ${formatTime(locale, iso)}`;
  return formatShortDate(locale, iso);
}

/** "25 min", "2 h" (how long something has waited). */
function durationText(t: TFunction, ms: number) {
  if (ms < 3_600_000) return t("format.inMinutes", { count: Math.max(1, Math.floor(ms / 60_000)) });
  if (ms < 2 * 86_400_000) return t("format.inHours", { count: Math.floor(ms / 3_600_000) });
  return t("format.inDays", { count: Math.floor(ms / 86_400_000) });
}

/** A snippet with @mentions: mine highlighted, the workspace's others in bold, anyone else's as typed. */
function Snippet({ text, mine }: { text: string; mine: string | null }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const parts = text.split(MENTION_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          mine && p.slice(1).toLowerCase() === mine.toLowerCase() ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional pieces of one text
            <Mention key={i}>{p}</Mention>
          ) : dir.mentionName(p.slice(1)) ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional pieces of one text
            <b key={i}>{p}</b>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional pieces of one text
            <Fragment key={i}>{p}</Fragment>
          )
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional pieces of one text
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

/** Where it happened, its icon and words, unless the headline says it. */
function sourceOf(t: TFunction, n: AppNotification, channelName: (id: string) => string): [IconName, string] | null {
  const s = n.source;
  const channel = channelOf(n);
  // Agents failing in many conversations: each says its own when the row opens. Several skipped catch-ups open
  // the agent's queue, which lists where each was.
  if (runFailedGroupOf(n) || (n.kind === "catch_up_closed" && n.count > 1)) return null;
  let icon: IconName = "channel";
  let label = "";
  const device = deviceNoticeOf(n);
  if (device) [icon, label] = [device.phoneId ? "phone" : "computer", t("devices.notice.source")];
  else if (WIDGET_NOTICES.has(n.kind)) [icon, label] = ["grid", t("notifications.source.dashboard")];
  else if (n.kind === "approval") [icon, label] = ["shield", t("notifications.source.approval")];
  else if (n.kind === "approval_cover" || n.kind === "right_hand_paused")
    [icon, label] = ["approve", t("settings.section.approvals")];
  // A request opens People › Convites, where it is answered (ADR 0184); someone who joined, Members.
  else if (n.kind === "join_request") [icon, label] = ["mail", t("settings.section.invites")];
  else if (n.kind === "invitation_accepted") [icon, label] = ["members", t("notifications.source.members")];
  else if (n.kind === "composio_limit") [icon, label] = ["wallet", t("notifications.source.usage")];
  else if (n.kind === "skill_update") [icon, label] = ["book", t("skills.title")];
  // What agents applied themselves (ADR 0219): their history is Agent improvements.
  else if (n.kind === "proposal_applied") [icon, label] = ["bulb", t("shell.proposals")];
  else if (
    n.kind === "machine_connected" ||
    n.kind === "computer_ready" ||
    n.kind === "computer_disk_full" ||
    n.kind === "computer_no_chrome" ||
    isComputerOutage(n) ||
    n.kind === "desktop_taken" ||
    (n.kind === "browser_handoff" && s.screen === "desktop")
  )
    [icon, label] = ["computer", t("notifications.source.machine")];
  else if (n.kind === "team_watch") {
    // Where it is fixed: the plans, the agent's budget, the computers, the connections.
    const cause = teamWatchOf(n)?.cause;
    if (cause === "sign_in" || cause === "budget_out" || cause === "budget_low")
      [icon, label] = ["bulb", t("settings.section.usage")];
    else if (cause === "computer") [icon, label] = ["computer", t("notifications.source.machine")];
    else if (cause) [icon, label] = ["plug", t("settings.section.connectors")];
  } else if (n.kind === "plan_lent" || n.kind === "plan_serves" || n.kind === "budget_paused")
    [icon, label] = ["bulb", t("settings.section.usage")];
  else if (n.kind === "plan_model_dropped") [icon, label] = ["bulb", t("brain.title")];
  else if (n.kind === "browser_handoff") [icon, label] = ["globe", t("notifications.source.browser")];
  else if (s.issueNumber != null)
    [icon, label] = ["issues", t("notifications.source.issue", { number: s.issueNumber })];
  else if (n.kind === "mission_finished" || n.kind === "mission_stopped")
    [icon, label] = ["flag", t("notifications.source.mission")];
  else if (n.kind.startsWith("routine_")) [icon, label] = ["routines", t("notifications.source.routine")];
  else if (n.kind === "dm" || s.dmId) [icon, label] = ["person", t("notifications.source.dm")];
  else if (s.threadId) {
    const name = channel ? channelName(channel) : "";
    [icon, label] = [
      "thread",
      name && !headlineNames(n, name)
        ? t("notifications.source.thread", { channel: name })
        : t("notifications.source.threadOnly"),
    ];
  } else if (channel && !headlineNames(n, channelName(channel)))
    [icon, label] = ["channel", t("notifications.source.channel", { name: channelName(channel) })];
  return label ? [icon, label] : null;
}

/** Issue statuses in the app's words (the raw value when unknown). */
const ISSUE_STATUSES = ["todo", "in_progress", "in_review", "done", "canceled"] as const;
function statusName(t: TFunction, value: string | undefined) {
  if (!value) return "";
  const known = ISSUE_STATUSES.find((s) => s === value);
  return known ? t(`issues.status.${known}`) : value;
}

/** The composer's placeholder: who or where the answer goes. */
function placeholderFor(t: TFunction, n: AppNotification, dir: Dir, channelName: (id: string) => string) {
  const target = replyTarget(n);
  if (!target) return t("notifications.composer.reply");
  if (target.kind === "issue")
    return n.source.issueNumber != null
      ? t("notifications.composer.issue", { number: n.source.issueNumber })
      : t("notifications.composer.issueNoNumber");
  if (target.kind === "question" || n.kind === "dm") {
    const name = nameOf(t, dir, n.actors[0]);
    return t("notifications.composer.replyTo", { context: agentGrammar(name).context, name });
  }
  if (target.threadId) return t("notifications.composer.thread");
  const channel = channelName(target.channelId);
  return channel ? t("notifications.composer.channel", { channel }) : t("notifications.composer.reply");
}

/**
 * The mini composer, opened in place (⌘↵ sends, esc closes). While the workspace is being deleted it says why it takes
 * nothing, with Cancel (ADR 0088 §7).
 */
function Composer({
  id,
  placeholder,
  draft,
  sending,
  onDraft,
  onSend,
  onCancel,
}: {
  id: string;
  placeholder: string;
  draft: string;
  sending: boolean;
  onDraft: (text: string) => void;
  onSend: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const deleting = Boolean(useOrg().org.deletion);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);
  // Grows with the text up to 180px.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure when the text changes
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(180, ta.scrollHeight)}px`;
  }, [draft]);
  if (deleting)
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: clicks inside the composer stay out of the row
      <div className="nt-cmp" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <p className="nt-cmp__readonly ac-iconline" role="status">
          <Icon name="lock" size={16} />
          <span>{t("deleting.composer")}</span>
        </p>
        <div className="nt-cmp__row">
          <span className="nt-grow" />
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("notifications.composer.cancel")}
          </Button>
        </div>
      </div>
    );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicks inside the composer stay out of the row
    <div className="nt-cmp" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <Locked when={sending}>
        <textarea
          id={`nt-ta-${id}`}
          ref={ref}
          rows={2}
          value={draft}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSend();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        <div className="nt-cmp__row">
          <span className="nt-cmp__hint">
            <Kbd>{modKey()}</Kbd>
            <Kbd>↵</Kbd> {t("notifications.composer.sends")} · <Kbd>{t("notifications.composer.escKey")}</Kbd>{" "}
            {t("notifications.composer.closes")}
          </span>
          <span className="nt-grow" />
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("notifications.composer.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon="arrowUp"
            loading={sending}
            disabled={!draft.trim()}
            onClick={onSend}
          >
            {t("notifications.composer.send")}
          </Button>
        </div>
      </Locked>
    </div>
  );
}

/** The replies of a grouped thread item (from the thread itself, or `at`: another thread). */
function ThreadReplies({
  n,
  dir,
  mine,
  at,
}: {
  n: AppNotification;
  dir: Dir;
  mine: string | null;
  at?: { channelId: string; rootId: string };
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const rootId = at ? at.rootId : (n.source.threadId ?? "");
  const thread = useThreadMessages(org.id, at ? at.channelId : (channelOf(n) ?? undefined), rootId);
  // The root the channel holds stands in until the replies are read: they are what this shows.
  if (thread.isPending || thread.isPlaceholderData) return <LoadingCards count={1} className="nt-reps" />;
  // Replies with words or a GIF or a sticker (cards like an approval or a question have none of their own).
  const replies = (thread.data ?? [])
    .filter((m) => m.id !== rootId && !m.local && (m.body.trim() || messageMediaOf(m.meta)))
    .slice(-n.count);
  return (
    <div className="nt-reps">
      {replies.map((m) => {
        const actor: NotificationActor = { type: m.author.type === "agent" ? "agent" : "user", id: m.author.id ?? "" };
        return (
          <div key={m.id} className="nt-rep">
            <Face actor={actor} dir={dir} size="sm" className="nt-av22" />
            <div>
              <div className="nt-rep__head">
                <b>{dir.authorName(m.author, m.meta)}</b>
                <small>{whenText(t, i18n.language, m.createdAt)}</small>
              </div>
              <p>
                <Snippet text={plainLine(textOrMedia(t, m.body, m.meta))} mine={mine} />
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The agents of a shared failure row, each opening the conversation where it couldn't go on. */
function RunFailures({ n, dir, channelName }: { n: AppNotification; dir: Dir; channelName: (id: string) => string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const openNotification = useNotificationOpener();
  return (
    <ul className="nt-reps nt-fails">
      {(runFailedGroupOf(n)?.failures ?? []).map(({ key, ...source }) => {
        const place = channelName(source.channelId) || source.label;
        return (
          <li key={key}>
            <button
              type="button"
              className="nt-rep"
              onClick={(e) => {
                e.stopPropagation();
                openNotification({ ...n, source, latest: {} }, org.id);
              }}
            >
              <Face actor={{ type: "agent", id: source.agentId }} dir={dir} size="sm" className="nt-av22" />
              <span className="nt-rep__head">
                <b>{nameOf(t, dir, { type: "agent", id: source.agentId })}</b>
                {place && <small>{t("notifications.source.channel", { name: place })}</small>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The comments of a grouped issue item: the replies in the task's conversation (ADR 0145). */
function IssueComments({ n, dir, mine }: { n: AppNotification; dir: Dir; mine: string | null }) {
  const { org } = useOrg();
  const issueId = n.source.issueId ?? "";
  const at = useTaskConversation(org.id, { id: issueId, conversation: null }, Boolean(issueId));
  if (!at) return <LoadingCards count={1} className="nt-reps" />;
  return <ThreadReplies n={n} dir={dir} mine={mine} at={at} />;
}

interface RowHandlers {
  onSelect: (n: AppNotification) => void;
  onReply: (n: AppNotification) => void;
  onDone: (n: AppNotification) => void;
  onSnooze: (n: AppNotification, choice: SnoozeChoice) => void;
  onOpen: (n: AppNotification) => void;
  /** In a new tab (Cmd/Ctrl-click, a middle click, Cmd/Ctrl+Enter). */
  onOpenNew: (n: AppNotification) => void;
  onToggle: (n: AppNotification) => void;
  onSend: (n: AppNotification, text: string, choice?: boolean) => void;
  onCancel: () => void;
  onDraft: (n: AppNotification, text: string) => void;
}

interface RowState {
  cur: boolean;
  open: boolean;
  replying: boolean;
  sending: boolean;
  draft: string;
  replied?: string;
  fresh: boolean;
  pulse: boolean;
  leaving: boolean;
  /** "Concluir todas" or its undo is under way: the row's own actions wait for it. */
  busy: boolean;
}

/** `agent_unreached`: let the routine's creator talk to the agent, from the inbox (its report may be out of reach). */
function UnreachedAllow({ agentId, userId }: { agentId: string; userId: string }) {
  const { org } = useOrg();
  const agent = useDirectory(org.id).agentById.get(agentId);
  if (!agent) return null;
  return (
    <div className="nt-steprow">
      <AllowTalkButton agent={agent} userId={userId} className="ag-rc__btn" />
    </div>
  );
}

/** "Mudar para Só eu" on `plan_serves`: the person's plan serves only them again (ADR 0059 §3). */
function PlanOnlyMe({ n }: { n: AppNotification }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const accountId = n.source.accountId;
  if (!accountId || n.doneAt) return null;
  const onlyMe = async () => {
    setBusy(true);
    try {
      await api.machines.setAccountServes(org.id, accountId, "owner");
      toast.show(t("notifications.planServes.done"), "success");
      for (const key of [keys.aiAccounts(org.id), keys.planUsage(org.id), keys.agents(org.id), keys.aiStatus(org.id)])
        void qc.invalidateQueries({ queryKey: key });
    } catch (error) {
      toast.show(errorText(t, error), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="nt-steprow">
      <Button size="sm" loading={busy} onClick={() => void onlyMe()}>
        {t("notifications.planServes.onlyMe")}
      </Button>
    </div>
  );
}

/** "Tirar de volta" on `plan_lent`: the person's plan leaves that agent, or every agent someone else gave it to. */
function PlanTakeBack({ n }: { n: AppNotification }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const accountId = n.source.accountId;
  if (!accountId || n.doneAt) return null;
  const take = async (agentId?: string) => {
    setBusy(true);
    try {
      await api.machines.takeBackPlan(org.id, accountId, agentId);
      toast.show(t("notifications.planLent.done"), "success");
      for (const key of [keys.aiAccounts(org.id), keys.agents(org.id), keys.aiStatus(org.id)])
        void qc.invalidateQueries({ queryKey: key });
    } catch (error) {
      toast.show(errorText(t, error), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="nt-steprow">
      <Button size="sm" loading={busy} onClick={() => void take(n.source.agentId)}>
        {t("notifications.planLent.takeBack")}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void take()}>
        {t("notifications.planLent.takeBackAll")}
      </Button>
    </div>
  );
}

/** What an item says under its headline: where it happened, what leads the line, and its words. */
function itemWords(t: TFunction, n: AppNotification, dir: Dir, channelName: (id: string) => string, locale: string) {
  const l = n.latest;
  // Asked while nobody watched (ADR 0053 §8): who asked leads an approval's line, its why follows.
  const origin = n.kind === "approval" ? approvalOriginWords({ origin: l.origin }) : null;
  const lead =
    n.source.issueNumber != null && l.title && (n.kind === "issue_assigned" || n.kind === "issue_status")
      ? `#${n.source.issueNumber} ${l.title}`
      : (n.kind === "mission_finished" ||
            n.kind === "mission_stopped" ||
            n.kind.startsWith("routine_") ||
            n.kind === "agent_unreached") &&
          n.source.label
        ? n.source.label
        : origin
          ? sayWords(t, origin)
          : null;
  // A routine's trouble says why in the person's language (`latest.reason`): a pause its reason, a failed
  // run what went wrong (never the server's English).
  const why = routineNotificationWords(n);
  const restriction = restrictionOf(n);
  // A board's notice says what the agent saw, why the widget stopped, or whom it would show the board to (ADR 0135).
  const widgetLine = widgetNoticeLine(t, n, dir);
  // A GIF or a sticker has no words: its word stands for it (ADR 0091).
  const media = mediaKindOf(l.media);
  const text = restriction
    ? restrictionLine(t, restriction.code, restriction.facts)
    : isComputerOutage(n)
      ? computerOutageLine(t, n, locale)
      : n.kind === "usage_limit"
        ? usageLimitLine(t, n)
        : n.kind === "device.internet_shared"
          ? deviceNoticeLine(t, n)
          : widgetLine
            ? widgetLine
            : // What the right hand found is the headline itself: nothing under it says it again.
              n.kind === "team_watch" || n.kind === "budget_paused"
              ? null
              : // What an agent applied (ADR 0219): the newest change, in a line.
                n.kind === "proposal_applied"
                ? (l.title ?? null)
                : why
                  ? sayWords(t, why, l.text ?? "")
                  : media === "voice"
                    ? mediaWord(t, media)
                    : latestText(t, l) || (media ? mediaWord(t, media) : l.text);
  const statusMove = n.kind === "issue_status" && (l.statusFrom || l.statusTo);
  // Where it happened and a task's move, in plain words.
  const where =
    n.kind === "reaction"
      ? ""
      : [
          sourceOf(t, n, channelName)?.[1],
          statusMove
            ? t("notifications.status", { from: statusName(t, l.statusFrom), to: statusName(t, l.statusTo) })
            : "",
        ]
          .filter(Boolean)
          .join(" · ");
  return { lead, text: text ?? null, where, whole: Boolean(restriction) };
}

/**
 * What a waiting item that only points somewhere is about: a secret its name and what it is for, a device's notice its
 * line; a request to join and what the right hand found say it all in their headline.
 */
function waitingWords(t: TFunction, n: AppNotification, dir: Dir) {
  if (n.kind === "join_request" || teamWatchOf(n)) return null;
  if (n.kind === "secret_request") return secretNoticeLine(n);
  if (n.kind === "usage_limit") return usageLimitLine(t, n);
  if (deviceNoticeOf(n)) return deviceNoticeLine(t, n);
  return widgetNoticeLine(t, n, dir) ?? n.latest.title ?? n.latest.text ?? null;
}

/** Who an item is from: a reaction's emojis, two faces for several people, one face, or the workspace's own mark. */
function ItemFace({
  n,
  dir,
  state,
  className = "nt-av24",
}: {
  n: AppNotification;
  dir: Dir;
  state?: "idle" | "waiting" | "writing";
  className?: string;
}) {
  const { t } = useTranslation();
  const first = n.actors[0];
  if (n.kind === "reaction")
    return (
      <span className="nt-emo" aria-hidden="true">
        {(n.latest.emojis ?? []).slice(-2).map((e) => (
          <span key={e}>{e}</span>
        ))}
      </span>
    );
  const other = n.actors.find((a, i) => i > 0 && (a.id !== first?.id || a.type !== first?.type));
  if (n.actors.length > 1 && other)
    return (
      <span className="nt-stk">
        <Face actor={first} dir={dir} size="sm" className="nt-av20" />
        <Face actor={other} dir={dir} size="sm" className="nt-av17" />
      </span>
    );
  if (!first) return <SystemFace n={n} className={className} />;
  // Someone who just joined may not be in the members list yet: the notice names them (ADR 0090).
  const joiner = n.kind === "invitation_accepted" ? joinerOf(t, dir, n) : undefined;
  return <Face actor={first} dir={dir} state={state} className={className} name={joiner} />;
}

/**
 * One item in the inbox's list: who, what they want in one line, what it is about under it, and when (how long is left
 * to decide, for an approval). No buttons: a click opens it beside the list, where it is answered.
 */
function InboxRow({
  n,
  s,
  h,
  dir,
  channelName,
}: {
  n: AppNotification;
  s: RowState;
  h: RowHandlers;
  dir: Dir;
  channelName: (id: string) => string;
}) {
  const { t, i18n } = useTranslation();
  const unread = n.readAt === null;
  const name = nameOf(t, dir, n.actors[0]);
  const own = workspaceHeadline(n);
  // What a screen reader hears for the row: the workspace's own headline, who asks to join (someone asking is no
  // member yet, and a notice that someone joined names them itself, ADR 0090), else who it is from.
  const asked = n.kind === "join_request" ? askersOf(n) : null;
  const label = own
    ? t(own, { name: n.source.label })
    : n.kind === "app_created"
      ? appCreatedLine(t, n)
      : asked
        ? asked.total > 1
          ? t("notifications.wait.joinRequestNames", { names: namesText(t, asked.names, 2, asked.total) })
          : t("notifications.wait.joinRequest", { count: 1, name: asked.names[0] })
        : ((n.kind === "invitation_accepted" ? joinerOf(t, dir, n) : undefined) ?? name);
  const words = itemWords(t, n, dir, channelName, i18n.language);
  const sub = n.waiting
    ? [words.where, waitingWords(t, n, dir)].filter(Boolean).join(" · ")
    : [words.where, words.lead, words.text].filter(Boolean).join(" · ");
  // What waits with a deadline (an approval, a secret, a hand in the browser) says how long is left; anything else
  // when it came.
  const expires = n.waiting ? n.latest.expiresAt : undefined;
  const left = expires ? timeLeft(t, expires) : null;
  const urgent = Boolean(expires && left && new Date(expires).getTime() - Date.now() <= URGENT_MS);
  return (
    <button
      type="button"
      className={cx(
        "ib-row",
        unread && "is-unread",
        s.cur && "is-on",
        s.fresh && "is-new",
        s.pulse && "is-pulse",
        s.leaving && "is-leaving",
      )}
      data-n={n.id}
      aria-current={s.cur || undefined}
      aria-label={unread ? t("notifications.unreadItem", { name: label }) : label}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) h.onOpenNew(n);
        else h.onSelect(n);
      }}
      onDoubleClick={() => h.onOpen(n)}
      // A middle click opens where it happened in a new tab, as Cmd/Ctrl-click does.
      onAuxClick={(e) => {
        if (e.button === 1) h.onOpenNew(n);
      }}
    >
      <span className="ib-row__face">
        <ItemFace n={n} dir={dir} state={n.waiting ? "waiting" : undefined} />
      </span>
      <span className="ib-row__text">
        <span className="ib-row__line nt-what">
          <Headline n={n} dir={dir} channelName={channelName} />
        </span>
        {sub && <span className="ib-row__sub">{plainLine(sub)}</span>}
      </span>
      <span className={cx("ib-row__end", urgent && "is-urgent")}>
        {left ?? whenText(t, i18n.language, n.updatedAt)}
      </span>
    </button>
  );
}

/**
 * One inbox item as Não lidas lists it (ADR 0260): the inbox's face, headline and line, and when (or how long is
 * left); a click opens it (`onOpen`), where it is answered.
 */
export function InboxItemRow({ n, onOpen }: { n: AppNotification; onOpen: (n: AppNotification) => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const channels = useChannels(org.id);
  const channelName = (id: string) => channels.data?.find((c) => c.id === id)?.name ?? "";
  const words = itemWords(t, n, dir, channelName, i18n.language);
  const sub = n.waiting
    ? [words.where, waitingWords(t, n, dir)].filter(Boolean).join(" · ")
    : [words.where, words.lead, words.text].filter(Boolean).join(" · ");
  const expires = n.waiting ? n.latest.expiresAt : undefined;
  const left = expires ? timeLeft(t, expires) : null;
  return (
    <button type="button" className={cx("ib-row", n.readAt === null && "is-unread")} onClick={() => onOpen(n)}>
      <span className="ib-row__face">
        <ItemFace n={n} dir={dir} state={n.waiting ? "waiting" : undefined} />
      </span>
      <span className="ib-row__text">
        <span className="ib-row__line nt-what">
          <Headline n={n} dir={dir} channelName={channelName} />
        </span>
        {sub && <span className="ib-row__sub">{plainLine(sub)}</span>}
      </span>
      <span className="ib-row__end">{left ?? whenText(t, i18n.language, n.updatedAt)}</span>
    </button>
  );
}

/**
 * An approval, decided right here as in its conversation: its own card, or its card's group while others on it still
 * wait (decided together, or one by one in the conversation). In the inbox the card is drawn flat (notifications.css).
 */
function WaitApproval({
  approvalId,
  agent,
  members,
  fallback,
  who,
}: {
  approvalId: string;
  agent: Agent | undefined;
  members: Map<string, Member>;
  /** Its words before the request loads. */
  fallback: string;
  /** Who asks, before the kind. */
  who?: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const approvals = useApprovals(org.id);
  const listed = approvals.data?.find((a) => a.id === approvalId);
  const one = useApproval(org.id, approvalId, !listed && approvals.isSuccess);
  const a = listed ?? one.data;
  if (!a)
    return (
      <RequestCard
        id={approvalId}
        kind="approval"
        agent={agent}
        label={t("approval.group")}
        who={who}
        mine
        lead={fallback}
        what={fallback}
      />
    );
  const items = a.messageId ? approvalCardItems(approvals.data, a.messageId, a) : [a];
  if (items.filter((x) => x.status === "pending").length > 1)
    return <ApprovalGroupAsk items={items} agent={agent} members={members} who={who} />;
  return <ApprovalAsk approval={a} agent={agent} members={members} who={who} />;
}

/** "Mais" on the open item: open where it happened, done (or back to the inbox), and remind me later. */
function ItemMenu({ n, h, busy }: { n: AppNotification; h: RowHandlers; busy: boolean }) {
  const { t, i18n } = useTranslation();
  const times = snoozeTimes();
  const day = (d: Date) => new Intl.DateTimeFormat(i18n.language, { weekday: "short" }).format(d);
  return (
    <Menu
      align="end"
      label={t("notifications.actions")}
      trigger={
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="more"
          className="ib-read__more"
          aria-label={t("notifications.actions")}
          title={t("notifications.actions")}
        />
      }
    >
      <MenuItem icon="external" hint="↵" onSelect={() => h.onOpen(n)}>
        {t("notifications.open")}
      </MenuItem>
      <MenuItem icon={n.doneAt ? "undo" : "check"} hint="E" disabled={busy} onSelect={() => h.onDone(n)}>
        {n.doneAt ? t("notifications.restore") : t("notifications.done")}
      </MenuItem>
      {!n.doneAt && (
        <>
          <MenuSeparator />
          <MenuHeading>{t("notifications.snoozeMenu.heading")}</MenuHeading>
          <MenuItem
            icon="clock"
            hint={formatTime(i18n.language, times.hour.toISOString())}
            disabled={busy}
            onSelect={() => h.onSnooze(n, "hour")}
          >
            {t("notifications.snoozeMenu.hour")}
          </MenuItem>
          <MenuItem
            icon="calendar"
            hint={day(times.tomorrow)}
            disabled={busy}
            onSelect={() => h.onSnooze(n, "tomorrow")}
          >
            {t("notifications.snoozeMenu.tomorrow")}
          </MenuItem>
          <MenuItem
            icon="calendar"
            hint={`${day(times.nextWeek)} ${formatTime(i18n.language, times.nextWeek.toISOString())}`}
            disabled={busy}
            onSelect={() => h.onSnooze(n, "nextWeek")}
          >
            {t("notifications.snoozeMenu.nextWeek")}
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

/**
 * The open item, beside the list: the agent on its own sky, then what it asks and the way to answer. An approval and a
 * question are the conversation's own cards, drawn flat; anything else says who, where and what, shows the replies it
 * groups, and answers or opens from here.
 */
function InboxRead({
  n,
  s,
  h,
  dir,
  mine,
  resolving,
  channelName,
  onBack,
}: {
  n: AppNotification;
  s: RowState;
  h: RowHandlers;
  dir: Dir;
  mine: string | null;
  resolving: boolean;
  channelName: (id: string) => string;
  /** Back to the list, where the screen shows one of the two. */
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const first = n.actors[0];
  const name = nameOf(t, dir, first);
  const agent = first?.type === "agent" ? dir.anyAgent(first.id) : undefined;
  const l = n.latest;
  const approvalId = n.kind === "approval" ? n.source.approvalId : undefined;
  const source = sourceOf(t, n, channelName);
  const words = itemWords(t, n, dir, channelName, i18n.language);
  const found = teamWatchOf(n);
  const steps = l.steps && l.steps.total > 0 ? l.steps : null;
  const failed =
    n.kind === "mission_stopped" || n.kind === "routine_failed" || n.kind === "run_failed" || l.steps?.failedAt != null;
  const stopStep = steps ? (steps.failedAt ?? steps.done + 1) : 0;
  const stepWords = steps
    ? t("notifications.stoppedAt", { step: Math.min(stopStep, steps.total), total: steps.total })
    : "";
  const speaker = n.count > 1 && (n.kind === "thread_reply" || n.kind === "issue_comment") ? name : null;
  const canReply = Boolean(replyTarget(n));
  let body: ReactNode;
  if (approvalId) {
    body = (
      <WaitApproval
        approvalId={approvalId}
        agent={agent}
        members={dir.memberById}
        fallback={l.title ?? l.text ?? name}
        who={first ? name : undefined}
      />
    );
  } else if (n.kind === "agent_question") {
    const title = l.title ?? l.text ?? "";
    const suggestions = l.suggestions ?? [];
    const waitedMs = Date.now() - new Date(n.createdAt).getTime();
    const g = agentGrammar(name);
    body = (
      <RequestCard
        id={n.id}
        kind="question"
        agent={agent}
        label={[name, title].filter(Boolean).join(": ")}
        who={first ? name : undefined}
        mine
        source={source?.[1]}
        lead={title}
        body={
          <>
            {l.title && l.text && (
              <p className="nt-ctx">
                <Snippet text={l.text} mine={mine} />
              </p>
            )}
            {resolving ? (
              <div className="nt-resolved ac-iconline">
                <Spinner size={14} />
                {t("notifications.wait.resolved", { context: g.context, name })}
              </div>
            ) : (
              <>
                {/* The agent's suggested answers: one a line with its key; a pick answers. */}
                {suggestions.length > 0 && (
                  <RequestChoices
                    choices={suggestions.map((label) => ({ label, busy: s.sending && s.draft === label }))}
                    onPick={(i) => {
                      const sug = suggestions[i];
                      if (sug === undefined) return;
                      h.onDraft(n, sug);
                      h.onSend(n, sug, true);
                    }}
                    disabled={s.sending}
                    other={s.replying ? undefined : { label: t("ask.otherAnswer"), onClick: () => h.onReply(n) }}
                  />
                )}
                {s.replying && (
                  <Composer
                    id={n.id}
                    placeholder={placeholderFor(t, n, dir, channelName)}
                    draft={s.draft}
                    sending={s.sending}
                    onDraft={(text) => h.onDraft(n, text)}
                    onSend={() => h.onSend(n, s.draft, suggestions.includes(s.draft.trim()))}
                    onCancel={h.onCancel}
                  />
                )}
              </>
            )}
          </>
        }
        actions={
          resolving || s.replying ? undefined : suggestions.length > 0 ? (
            <RequestKeys count={suggestions.length} />
          ) : (
            <Button variant="primary" size="sm" icon="reply" onClick={() => h.onReply(n)}>
              {t("notifications.reply")}
            </Button>
          )
        }
        end={
          // Its agent stopped until I answer, in attention once it has waited a while.
          <span className={cx(waitedMs >= LATE_MS && "nt-late")}>
            {t(isFeminineName(name) ? "notifications.wait.stoppedForF" : "notifications.wait.stoppedForM", {
              time: durationText(t, waitedMs),
            })}
          </span>
        }
        what={title}
      />
    );
  } else {
    const say = n.waiting ? waitingWords(t, n, dir) : words.text;
    body = (
      <div className="ib-item">
        <p className="ib-read__who">
          {[first ? name : "", source?.[1] ?? "", whenText(t, i18n.language, n.updatedAt)].filter(Boolean).join(" · ")}
        </p>
        <h2 className="ib-read__title nt-what">
          <Headline n={n} dir={dir} channelName={channelName} />
        </h2>
        {n.kind === "reaction"
          ? l.quote && <p className="ib-read__say">{t("notifications.quote", { text: l.quote })}</p>
          : (say || words.lead) && (
              <p className="ib-read__say">
                {words.lead && <b>{t("notifications.lead", { text: words.lead })} </b>}
                {speaker && <b>{t("notifications.speaker", { name: speaker })} </b>}
                {say && <Snippet text={say} mine={mine} />}
              </p>
            )}
        {/* A finished run says nothing extra: only a stopped one shows where it stopped. */}
        {steps && failed && (
          <div className="nt-steprow">
            <PlanStrip
              cells={stepCells({ ...steps, failedAt: failed ? stopStep : undefined })}
              color={agent ? colorOf(agent) : undefined}
              label={stepWords}
            />
            <span className="ib-read__warn">{stepWords}</span>
          </div>
        )}
        {n.kind === "change_request" && <ChangeRequestCard n={n} />}
        {n.kind === "usage_limit" && <UsageLimitActions n={n} />}
        <DeviceNoticeActions n={n} />
        <AdminAskActions n={n} />
        {n.kind === "agent_unreached" && n.source.agentId && n.source.userId && (
          <UnreachedAllow agentId={n.source.agentId} userId={n.source.userId} />
        )}
        {n.kind === "plan_lent" && <PlanTakeBack n={n} />}
        {n.kind === "plan_serves" && <PlanOnlyMe n={n} />}
        {widgetNoticeOf(n) && !n.doneAt && (
          <div className="nt-steprow">
            <WidgetNoticeActions n={n} onOpen={() => h.onOpen(n)} open={false} />
          </div>
        )}
        {/* What it groups, read right here: a thread's replies, a task's comments, each agent that failed. */}
        {isExpandable(n) &&
          (n.kind === "issue_comment" ? (
            <IssueComments n={n} dir={dir} mine={mine} />
          ) : n.kind === "run_failed" ? (
            <RunFailures n={n} dir={dir} channelName={channelName} />
          ) : (
            <ThreadReplies n={n} dir={dir} mine={mine} />
          ))}
        {s.replied && (
          <div className="nt-replied ac-iconline">
            <Icon name="check" size={14} />
            <span>{t("notifications.youReplied", { text: s.replied })}</span>
          </div>
        )}
        {s.replying ? (
          <Composer
            id={n.id}
            placeholder={placeholderFor(t, n, dir, channelName)}
            draft={s.draft}
            sending={s.sending}
            onDraft={(text) => h.onDraft(n, text)}
            onSend={() => h.onSend(n, s.draft)}
            onCancel={h.onCancel}
          />
        ) : (
          <div className="ib-decide">
            {canReply && (
              <Button variant="primary" icon="reply" onClick={() => h.onReply(n)}>
                {t("notifications.reply")}
              </Button>
            )}
            {/* What the right hand found names its way out on the button; anything else only opens. */}
            <Button
              variant={canReply ? "default" : "primary"}
              title={t("notifications.openTip")}
              onClick={() => h.onOpen(n)}
            >
              {n.kind === "plan_model_dropped"
                ? t("notifications.planModelDropped.choose")
                : found?.act
                  ? (t as unknown as (key: string) => string)(found.act)
                  : t("notifications.open")}
            </Button>
          </div>
        )}
      </div>
    );
  }
  return (
    <section
      className={cx("ib-read", s.leaving && "is-leaving")}
      data-scroll-restoration-id="inbox-item"
      aria-label={[first ? name : "", l.title ?? l.text].filter(Boolean).join(": ") || t("notifications.title")}
      data-burst=""
    >
      {agent && <CardSky color={colorOf(agent)} />}
      <div className="ib-read__in">
        <header className="ib-read__top">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon="chevronLeft"
            className="ib-read__back"
            aria-label={t("common.back")}
            onClick={onBack}
          />
          <span className="ib-read__face">
            {agent ? (
              <AgentAvatar
                agentId={agent.id}
                name={name}
                size="lg"
                framed={false}
                state={resolving ? "writing" : n.waiting ? "waiting" : undefined}
              />
            ) : (
              <ItemFace n={n} dir={dir} className="nt-av40" />
            )}
          </span>
          <ItemMenu n={n} h={h} busy={s.busy} />
        </header>
        {body}
      </div>
    </section>
  );
}

/** A decided request, open beside the list: the same card, saying who decided and when. */
function RequestRead({ approval, dir, onBack }: { approval: Approval; dir: Dir; onBack: () => void }) {
  const { t } = useTranslation();
  const agent = dir.anyAgent(approval.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  return (
    <section className="ib-read" data-scroll-restoration-id="inbox-item" aria-label={name}>
      {agent && <CardSky color={colorOf(agent)} />}
      <div className="ib-read__in">
        <header className="ib-read__top">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon="chevronLeft"
            className="ib-read__back"
            aria-label={t("common.back")}
            onClick={onBack}
          />
          <span className="ib-read__face">
            <AgentAvatar agentId={approval.agentId} name={name} size="lg" framed={false} />
          </span>
        </header>
        <ApprovalAsk approval={approval} agent={agent} members={dir.memberById} who={name} />
      </div>
    </section>
  );
}

/** An item's row or card on screen. */
const element = (id: string) => document.querySelector<HTMLElement>(`.ib-list [data-n="${CSS.escape(id)}"]`);

/** `setTimeout` that is cleared when the component unmounts (a late state update after leaving the page). */
function useLater() {
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);
  return useCallback((fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      fn();
    }, ms);
    timers.current.add(timer);
  }, []);
}

/** Items that just arrived (or came back) glow in; merged ones pulse. Nothing on the first load. */
function useArrivals(items: AppNotification[], filter: NotificationFilter, ready: boolean) {
  const prev = useRef<Map<string, string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [pulse, setPulse] = useState<Set<string>>(new Set());
  const later = useLater();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new filter starts over
  useEffect(() => {
    prev.current = null;
  }, [filter]);
  useEffect(() => {
    if (!ready) return;
    const now = new Map(items.map((n) => [n.id, n.updatedAt]));
    const before = prev.current;
    prev.current = now;
    if (!before) return;
    const added = items.filter((n) => !before.has(n.id)).map((n) => n.id);
    const bumped = items.filter((n) => before.has(n.id) && before.get(n.id) !== n.updatedAt).map((n) => n.id);
    if (added.length) {
      setFresh((s) => new Set([...s, ...added]));
      later(() => setFresh((s) => new Set([...s].filter((id) => !added.includes(id)))), 2400);
    }
    if (bumped.length) {
      setPulse((s) => new Set([...s, ...bumped]));
      later(() => setPulse((s) => new Set([...s].filter((id) => !bumped.includes(id)))), 800);
    }
  }, [items, ready, later]);
  return { fresh, pulse };
}

/** The inbox's filters: the notifications' own, and the requests already decided (the approvals' history). */
export type InboxFilter = NotificationFilter | "requests";
const INBOX_FILTERS: readonly InboxFilter[] = [...NOTIFICATION_FILTERS, "requests", "done"];
export const isInboxFilter = (value: unknown): value is InboxFilter =>
  typeof value === "string" && (INBOX_FILTERS as readonly string[]).includes(value);

/**
 * The inbox: one list of everything that involves me (what waits on me on top, the rest by day) and the open item
 * beside it, where it is answered: an approval decided, a question answered, a mention replied to. `filter`: the
 * filter it starts on; `approvalId`: the request to open (a decided one opens among the decided requests).
 */
export function NotificationsPage({
  filter: startFilter = "all",
  approvalId,
}: {
  filter?: InboxFilter;
  approvalId?: string;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const channels = useChannels(org.id);
  const toast = useToast();
  const qc = useQueryClient();
  const live = useLiveStore();
  const [filter, setFilter] = useState<InboxFilter>(startFilter);
  // The decided requests are the approvals' own list: the notifications behind them stay as they are.
  const requestsView = filter === "requests";
  const listFilter: NotificationFilter = requestsView ? "all" : filter;
  const list = useNotifications(org.id, listFilter);
  const approvals = useApprovals(org.id);
  const [req, setReq] = useState<string | null>(null);
  // The decided ones, and a request a link asked for that still waits but has no notice in the list (done, snoozed,
  // or not this person's to decide): it reads here too, instead of another request taking its place.
  const decided = requestsView
    ? (approvals.data ?? [])
        .filter((a) => a.status !== "pending" || a.id === req)
        .sort((a, b) => approvalDecidedAt(b).localeCompare(approvalDecidedAt(a)))
    : [];
  const title = t("notifications.title");
  const badge = useNotificationCount(org.id);
  const action = useNotificationAction(org.id);
  const reply = useNotificationReply(org.id);
  const [cur, setCur] = useState<string | null>(null);
  const [replying, setReplying] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [replied, setReplied] = useState<Record<string, string>>({});
  const [resolving, setResolving] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const later = useLater();

  const items = allItems(list.data);
  const counts = list.data?.pages[0]?.counts;
  const { fresh, pulse } = useArrivals(items, listFilter, list.isSuccess && !list.isPlaceholderData);
  const mine = dir.memberById.get(me.user.id)?.handle ?? null;
  const channelName = (id: string) => channels.data?.find((c) => c.id === id)?.name ?? "";
  // "Concluídas": by when each was marked done, waiting or not.
  const doneView = filter === "done";
  // An older notice that proposals wait on me: agents apply their improvements themselves now (ADR 0219).
  const waiting = doneView ? [] : sortWaiting(items.filter((n) => n.waiting && n.kind !== "proposal_waiting"));
  const rest = doneView ? items : items.filter((n) => !n.waiting);
  const days = groupByDay(rest, undefined, doneView ? (n) => n.doneAt ?? n.updatedAt : undefined);
  const unreadTotal = counts?.unread ?? badge.data?.unread ?? 0;
  const waitingTotal = useInboxWaiting(org.id);
  const nothing = list.isSuccess && (counts?.all ?? 0) === 0 && items.length === 0;

  // The tab says how many are unread.
  useEffect(() => {
    const previous = document.title;
    document.title = unreadTotal ? t("notifications.docTitleUnread", { count: unreadTotal }) : title;
    return () => {
      document.title = previous;
    };
  }, [unreadTotal, t, title]);

  // The first item opens by itself beside the list: what waits on me first. Where the screen shows one of the two,
  // the list stays until the person picks.
  const firstId = waiting[0]?.id ?? days[0]?.[1][0]?.id ?? null;
  const curShown = cur !== null && items.some((x) => x.id === cur);
  useEffect(() => {
    if (requestsView || curShown || !firstId || matchesNow(NARROW)) return;
    setCur(firstId);
  }, [requestsView, curShown, firstId]);
  const firstRequest = decided[0]?.id ?? null;
  const reqShown = req !== null && decided.some((a) => a.id === req);
  useEffect(() => {
    if (!requestsView || reqShown || !firstRequest || matchesNow(NARROW)) return;
    setReq(firstRequest);
  }, [requestsView, reqShown, firstRequest]);

  // A request asked for by its id (a link, a push): its item among what waits, else among the decided ones.
  const asked = useRef(approvalId ?? null);
  useEffect(() => {
    const id = asked.current;
    if (!id || !list.isSuccess || !approvals.isSuccess) return;
    asked.current = null;
    const item = items.find((n) => n.source.approvalId === id && !n.doneAt);
    if (item) return setCur(item.id);
    if (!approvals.data?.some((a) => a.id === id)) return;
    setFilter("requests");
    setReq(id);
  }, [items, list.isSuccess, approvals.isSuccess, approvals.data]);

  const markRead = (n: AppNotification) => {
    if (n.readAt === null) action.mutate({ type: "read", item: n, read: true });
  };

  /** Slide out, fold the space, then change the lists (the next item takes the cursor). */
  const leave = (n: AppNotification, then: () => void) => {
    if (replying === n.id) setReplying(null);
    const rows = [...document.querySelectorAll<HTMLElement>(".ib-list [data-n]")];
    const i = rows.findIndex((r) => r.dataset.n === n.id);
    const next = rows[i + 1]?.dataset.n ?? rows[i - 1]?.dataset.n ?? null;
    const finish = () => {
      then();
      setLeaving((s) => {
        const copy = new Set(s);
        copy.delete(n.id);
        return copy;
      });
      if (cur === n.id || cur === null) {
        setCur(next);
        if (next) requestAnimationFrame(() => element(next)?.focus({ preventScroll: true }));
      }
    };
    const el = element(n.id);
    if (!el || prefersReducedMotion()) return finish();
    el.style.height = `${el.offsetHeight}px`;
    setLeaving((s) => new Set(s).add(n.id));
    // Inline (React doesn't own these rows' style): fold the space so the list closes up.
    later(() => {
      el.style.transition = "height .26s var(--out), padding .26s var(--out), border-color .26s";
      el.style.overflow = "hidden";
      el.style.borderTopColor = "transparent";
      el.style.height = "0px";
      el.style.paddingTop = "0px";
      el.style.paddingBottom = "0px";
    }, 180);
    later(finish, LEAVE_MS);
  };

  // Its own observer: a row's read or Feito on the page's `action` must not take over the clear's toast and Desfazer.
  const bulkAction = useNotificationAction(org.id);
  const bulk = useNotificationBulkPending(org.id);

  const done = (n: AppNotification) => {
    if (bulk) return;
    if (n.doneAt) {
      leave(n, () => action.mutate({ type: "done", item: n, done: false }));
      toast.show(t("notifications.toast.restored"), "info", {
        label: t("notifications.toast.undo"),
        run: () => action.mutate({ type: "done", item: { ...n, doneAt: null }, done: true }),
      });
      return;
    }
    const name = nameOf(t, dir, n.actors[0]);
    leave(n, () => action.mutate({ type: "done", item: n, done: true }));
    toast.show(
      t("notifications.toast.done"),
      "info",
      { label: t("notifications.toast.undo"), run: () => action.mutate({ type: "done", item: n, done: false }) },
      n.kind === "agent_question"
        ? t("notifications.toast.doneQuestion", { name })
        : n.kind === "approval"
          ? t("notifications.toast.doneApproval")
          : undefined,
    );
  };

  const snooze = (n: AppNotification, choice: SnoozeChoice) => {
    if (bulk) return;
    const until = snoozeTimes()[choice].toISOString();
    leave(n, () => action.mutate({ type: "snooze", item: n, until }));
    const title =
      choice === "hour"
        ? t("notifications.snoozeMenu.toastHour")
        : choice === "tomorrow"
          ? t("notifications.snoozeMenu.toastTomorrow")
          : t("notifications.snoozeMenu.toastNextWeek");
    toast.show(
      title,
      "info",
      { label: t("notifications.toast.undo"), run: () => action.mutate({ type: "snooze", item: n, until: null }) },
      n.latest.title ?? latestText(t, n.latest) ?? n.latest.quote ?? "",
    );
  };

  const connect = useConnectAi();
  const aiStatus = useAiStatus(org.id);
  const openNotification = useNotificationOpener();
  const notificationHref = useNotificationHref();
  // Its computer is ready and its agents have no AI yet: what comes next is connecting one.
  const connectsAi = (n: AppNotification) => connect !== null && opensConnectAi(n, aiStatus.data);
  /** "Abrir": the same place a click on its browser notification goes (`useNotificationOpener`). */
  const openItem = (n: AppNotification) => {
    markRead(n);
    openNotification(n, org.id, { ai: aiStatus.data });
  };

  const startReply = (n: AppNotification) => {
    if (!replyTarget(n)) {
      if (n.kind === "approval") toast.show(t("notifications.toast.decideThere"), "info");
      return;
    }
    setReplying(n.id);
    setCur(n.id);
    markRead(n);
  };

  const cancelReply = () => {
    const id = replying;
    setReplying(null);
    if (id) requestAnimationFrame(() => element(id)?.focus({ preventScroll: true }));
  };

  /** An agent got unblocked: its pixels burst, a line says so, then the card leaves. */
  const resolve = (n: AppNotification) => {
    setResolving(n.id);
    const face = document.querySelector<HTMLElement>(".ib-read__face .ac-avatar");
    if (face) prepareBurst(face)();
    later(() => {
      leave(n, () => dropNotification(qc, org.id, n.id));
      setResolving(null);
    }, 1700);
  };

  const send = (n: AppNotification, text: string, choice?: boolean) => {
    const target = replyTarget(n);
    const body = text.trim();
    if (!target || !body) return;
    setSending(n.id);
    reply.mutate(
      { target, text: body, choice },
      {
        onSuccess: (res) => {
          setReplying(null);
          setDrafts((d) => {
            const { [n.id]: _, ...others } = d;
            return others;
          });
          markRead(n);
          const name = nameOf(t, dir, n.actors[0]);
          if (res.kind === "question") {
            live.answered({ ...res.question, answer: res.question.answer ?? body });
            toast.show(t("notifications.toast.answered", { name }), "info", undefined, body);
            resolve(n);
          } else {
            setReplied((r) => ({ ...r, [n.id]: body }));
            toast.show(
              t("notifications.toast.sent"),
              "info",
              { label: t("notifications.toast.see"), run: () => openItem(n) },
              body,
            );
          }
        },
        onSettled: () => setSending(null),
      },
    );
  };

  const readAll = () => {
    const count = counts?.unread ?? 0;
    if (!count) return;
    action.mutate(
      { type: "readAll", filter: listFilter },
      {
        onSuccess: (res) =>
          toast.show(t("notifications.toast.readAll", { count: res.ids.length || count }), "info", {
            label: t("notifications.toast.undo"),
            run: () => action.mutate({ type: "unreadMany", ids: res.ids }),
          }),
      },
    );
  };

  const doneAll = () =>
    bulkAction.mutate(
      { type: "doneAll", filter: listFilter },
      {
        onSuccess: (res) => {
          setCur(null);
          if (res.ids.length)
            toast.show(t("notifications.toast.doneAll", { count: res.ids.length }), "info", {
              label: t("notifications.toast.undo"),
              run: () =>
                bulkAction.mutate(
                  { type: "undoneMany", ids: res.ids },
                  { onError: (e) => toast.show(errorText(t, e), "error") },
                ),
            });
        },
        onError: (e) => toast.show(errorText(t, e), "error"),
      },
    );

  const toggle = (n: AppNotification) => {
    setOpen((s) => {
      const copy = new Set(s);
      if (copy.has(n.id)) copy.delete(n.id);
      else copy.add(n.id);
      return copy;
    });
    setCur(n.id);
    markRead(n);
  };

  /** A click on an item opens it beside the list, read; connecting an AI, the one next step there is, opens at once. */
  const select = (n: AppNotification) => {
    if (cur !== n.id) setReplying(null);
    setCur(n.id);
    // Opening where it happened marks it read itself.
    if (connectsAi(n)) openItem(n);
    else markRead(n);
  };

  const handlers: RowHandlers = {
    onSelect: select,
    onReply: startReply,
    onDone: done,
    onSnooze: snooze,
    onOpen: openItem,
    onOpenNew: (n) => {
      markRead(n);
      window.open(notificationHref(n, org.id), "_blank", "noopener");
    },
    onToggle: toggle,
    onSend: send,
    onCancel: cancelReply,
    onDraft: (n, text) => setDrafts((d) => ({ ...d, [n.id]: text })),
  };

  // J/K (and arrows) move, E done, R reply, Enter opens, Escape closes the composer; Atalhos' rows press the same keys.
  const keyState = useRef({ items, cur, replying, handlers });
  keyState.current = { items, cur, replying, handlers };
  /** A key on `here` (or the current item); false when it means nothing there. */
  const pressKey = useCallback((key: string, here: HTMLElement | null, newTab = false) => {
    const { items: all, cur: current, handlers: h } = keyState.current;
    const at = here ?? (current ? element(current) : null);
    if (key === "j" || key === "k" || key === "arrowdown" || key === "arrowup") {
      const rows = [...document.querySelectorAll<HTMLElement>(".ib-list [data-n]")];
      const i = at ? rows.indexOf(at) : -1;
      const down = key === "j" || key === "arrowdown";
      const next = rows[i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + (down ? 1 : -1)))];
      if (next?.dataset.n) {
        const item = all.find((x) => x.id === next.dataset.n);
        if (item) h.onSelect(item);
        else setCur(next.dataset.n);
        next.focus({ preventScroll: true });
        next.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      }
      return true;
    }
    const n = all.find((x) => x.id === at?.dataset.n);
    if (!n) return false;
    if (key === "e") h.onDone(n);
    else if (key === "r") h.onReply(n);
    else if (key === "enter") {
      if (newTab) h.onOpenNew(n);
      else h.onOpen(n);
    } else return false;
    return true;
  }, []);
  // Atalhos' Mover moved the cursor: the row takes the focus the closing menu would give back to its button.
  const movedByMenu = useRef(false);
  const menuPress = (key: string) => {
    movedByMenu.current = key === "j";
    pressKey(key, null);
  };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const { cur: current, replying: open, handlers: h } = keyState.current;
      const target = e.target instanceof Element ? e.target : null;
      if (e.key === "Escape" && open) {
        h.onCancel();
        return;
      }
      if (target?.closest("input, textarea, [contenteditable], [role=dialog], [role=menu], [role=listbox]")) return;
      // Cmd/Ctrl+Enter opens in a new tab; any other key with a modifier is the browser's.
      const newTab = e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey;
      if ((e.metaKey || e.ctrlKey || e.altKey) && !newTab) return;
      // A button's own Enter and Space are its click, but a row's Enter opens where it happened.
      if (target?.closest("button:not(.ib-row)") && (e.key === "Enter" || e.key === " ")) return;
      if (target?.closest(".ib-row") && e.key === " ") return;
      const here = target?.closest<HTMLElement>(".ib-list [data-n]") ?? (current ? element(current) : null);
      const key = e.key.toLowerCase();
      // Arrows move only from an item; J and K from anywhere on the page.
      if ((key === "arrowdown" || key === "arrowup") && !here) return;
      if (pressKey(key, here, newTab)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pressKey]);

  const stateOf = (n: AppNotification): RowState => ({
    cur: cur === n.id,
    open: open.has(n.id),
    replying: replying === n.id,
    sending: sending === n.id,
    draft: drafts[n.id] ?? "",
    replied: replied[n.id],
    fresh: fresh.has(n.id),
    pulse: pulse.has(n.id),
    leaving: leaving.has(n.id),
    busy: bulk,
  });

  const calmLook = lookOf(dir.agents[0]) ?? true;
  // What the keys act on: the open item.
  const curItem = requestsView ? undefined : items.find((x) => x.id === cur);
  const curRequest = requestsView ? decided.find((a) => a.id === req) : undefined;
  const filterWords = (f: InboxFilter) =>
    f === "requests" ? t("notifications.filter.requests") : t(`notifications.filter.${f}`);
  const summary = [
    waitingTotal ? t("notifications.summaryWaiting", { count: waitingTotal }) : "",
    unreadTotal ? t("notifications.summaryUnread", { count: unreadTotal }) : "",
  ]
    .filter(Boolean)
    // Tied to the part before it: a line that wraps beside the filter never starts with the dot.
    .join("\u00a0· ");
  const back = () => {
    setReplying(null);
    setCur(null);
    setReq(null);
  };

  // Nothing at all: one calm screen, no list and nothing to open.
  if (nothing && filter === "all")
    return (
      <div className="page page--list nt ib-calm">
        <EmptyState size="page" agent={calmLook} mood="deal" title={t("notifications.calmTitle")}>
          {t("notifications.calmText")}
        </EmptyState>
      </div>
    );

  return (
    <div className={cx("nt ib", (curItem || curRequest) && "ib--open")}>
      <aside className="ib-list" data-scroll-restoration-id="inbox-list" aria-label={title}>
        {/* The page's own header, as every page's; it stays while the list scrolls under it. */}
        <PageHeader
          className="ib-head"
          title={title}
          meta={summary || undefined}
          // In sight while something is unread: the menu keeps it too, with the other whole-list actions.
          actions={
            !requestsView &&
            !doneView &&
            Boolean(counts?.unread) && (
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon="checks"
                className="ib-readall"
                aria-label={t("notifications.readAll")}
                title={t("notifications.readAll")}
                disabled={action.isPending || bulk}
                onClick={readAll}
              />
            )
          }
          // At the end of the count's line: beside the title, a filter's name would squeeze it in the narrow list column.
          metaActions={
            <Menu
              align="end"
              label={t("notifications.filters")}
              onClosed={() => {
                const moved = movedByMenu.current ? keyState.current.cur : null;
                if (moved) element(moved)?.focus({ preventScroll: true });
                movedByMenu.current = false;
              }}
              trigger={
                <Button variant="ghost" size="sm" className="ib-filter" aria-label={t("notifications.filters")}>
                  {filterWords(filter)}
                  <Icon name="chevronDown" size={14} />
                </Button>
              }
            >
              <MenuRadioGroup
                label={t("notifications.filters")}
                value={filter}
                onValueChange={(f) => {
                  setFilter(f as InboxFilter);
                  setCur(null);
                  setReq(null);
                }}
                options={INBOX_FILTERS.map((f) => ({
                  value: f,
                  label:
                    f !== "requests" && f !== "done" && counts?.[f] ? (
                      <span className="ib-menu__opt">
                        {filterWords(f)}
                        <span className="ib-menu__n">{counts[f]}</span>
                      </span>
                    ) : (
                      filterWords(f)
                    ),
                }))}
              />
              {!requestsView && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    icon="check"
                    disabled={doneView || !counts?.unread || action.isPending || bulk}
                    onSelect={readAll}
                  >
                    {t("notifications.readAll")}
                  </MenuItem>
                  <MenuItem
                    icon="archive"
                    disabled={!canClearAll(listFilter, counts, items) || action.isPending || bulk}
                    onSelect={doneAll}
                  >
                    {t("notifications.doneAll")}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuHeading>{t("notifications.keys.title")}</MenuHeading>
                  <MenuItem hint="J · K" disabled={items.length === 0} onSelect={() => menuPress("j")}>
                    {t("notifications.keys.move")}
                  </MenuItem>
                  <MenuItem hint="E" disabled={!curItem} onSelect={() => menuPress("e")}>
                    {t("notifications.keys.done")}
                  </MenuItem>
                  <MenuItem hint="R" disabled={!curItem} onSelect={() => menuPress("r")}>
                    {t("notifications.keys.reply")}
                  </MenuItem>
                  <MenuItem hint="↵" disabled={!curItem} onSelect={() => menuPress("enter")}>
                    {t("notifications.keys.open")}
                  </MenuItem>
                </>
              )}
            </Menu>
          }
        />

        {requestsView ? (
          <>
            {approvals.isPending && <LoadingCards count={3} />}
            {approvals.isSuccess && decided.length === 0 && (
              <EmptyState size="panel">{t("notifications.noneRequests")}</EmptyState>
            )}
            <ApprovalLinesProvider list={approvals.data ?? []}>
              {decidedGroups(decided).map(([day, rows]) => (
                <section key={day} className="ib-group" aria-label={t(`approvals.groups.${day}`)}>
                  <GroupHeading title={t(`approvals.groups.${day}`)} />
                  <div className="ap-list__rows">
                    {rows.map((a) => (
                      <ApprovalRow key={a.id} approval={a} selected={req === a.id} onOpen={() => setReq(a.id)} />
                    ))}
                  </div>
                </section>
              ))}
            </ApprovalLinesProvider>
          </>
        ) : (
          <Refreshing busy={list.isPlaceholderData} label={t("common.loading")}>
            {list.isPending && <LoadingCards count={3} />}
            {list.isError && !list.data && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
            {list.isSuccess && items.length === 0 && (
              <EmptyState
                size="panel"
                // Nobody waiting and all read are wins: the others are only a filter with nothing in it.
                agent={filter === "waiting" || filter === "unread" ? calmLook : undefined}
                mood="deal"
                actions={
                  filter !== "waiting" && filter !== "unread" && !doneView ? (
                    <Button
                      onClick={() => {
                        setFilter("all");
                        setCur(null);
                      }}
                    >
                      {t("notifications.filter.all")}
                    </Button>
                  ) : undefined
                }
              >
                {filter === "waiting"
                  ? t("notifications.noneWaiting")
                  : filter === "unread"
                    ? t("notifications.noneUnread")
                    : doneView
                      ? t("notifications.noneDone")
                      : t("notifications.noneHere")}
              </EmptyState>
            )}
            {waiting.length > 0 && (
              <section className="ib-group nt-wait" aria-label={t("notifications.wait.title")}>
                <GroupHeading title={t("notifications.wait.title")} count={waiting.length} />
                <ApproveAllByAgent list={approvals.data ?? []} />
                {waiting.map((n) => (
                  <InboxRow key={n.id} n={n} s={stateOf(n)} h={handlers} dir={dir} channelName={channelName} />
                ))}
              </section>
            )}
            {days.map(([day, rows]) => {
              const unread = rows.filter((n) => n.readAt === null).length;
              return (
                <section key={day} className="ib-group nt-day" aria-label={t(`notifications.day.${day}`)}>
                  <GroupHeading
                    title={t(`notifications.day.${day}`)}
                    count={unread ? t("notifications.dayUnread", { count: unread }) : undefined}
                  />
                  {rows.map((n) => (
                    <InboxRow key={n.id} n={n} s={stateOf(n)} h={handlers} dir={dir} channelName={channelName} />
                  ))}
                </section>
              );
            })}
            {list.hasNextPage && (
              <div className="nt-more-pages">
                <Button
                  variant="ghost"
                  size="sm"
                  loading={list.isFetchingNextPage}
                  onClick={() => void list.fetchNextPage()}
                >
                  {t("notifications.more")}
                </Button>
              </div>
            )}
          </Refreshing>
        )}
      </aside>

      {curItem ? (
        <InboxRead
          key={curItem.id}
          n={curItem}
          s={stateOf(curItem)}
          h={handlers}
          dir={dir}
          mine={mine}
          resolving={resolving === curItem.id}
          channelName={channelName}
          onBack={back}
        />
      ) : curRequest ? (
        <RequestRead key={curRequest.id} approval={curRequest} dir={dir} onBack={back} />
      ) : (
        <div className="ib-read ib-read--none" aria-hidden="true" />
      )}
    </div>
  );
}
