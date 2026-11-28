import {
  type AppNotification,
  type Approval,
  type NotificationCounts,
  type NotificationFilter,
  type Routine,
  useAiStatus,
  useApprovals,
  useNotificationAction,
  useNotificationBulkPending,
  useNotifications,
  useRoutines,
} from "@agenteschat/client";
import { approvalLines } from "@agenteschat/client/lib/approval-card";
import { approvalTitle } from "@agenteschat/client/lib/approval-words";
import { computerOutageLine, isComputerOutage } from "@agenteschat/client/lib/computer-outage";
import { errorText, restrictionLine } from "@agenteschat/client/lib/errors";
import { dateFormat, timeLeft, upperFirst } from "@agenteschat/client/lib/format";
import { mediaWord } from "@agenteschat/client/lib/media";
import { latestText } from "@agenteschat/client/lib/message-body";
import { canClearAll, teamWatchOf } from "@agenteschat/client/lib/notifications";
import { usageLimitLine } from "@agenteschat/client/lib/person-usage";
import { useLocalSearchParams } from "expo-router";
import type { TFunction } from "i18next";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import Animated, {
  type EntryExitAnimationFunction,
  FadeIn,
  LayoutAnimationConfig,
  LinearTransition,
  withTiming,
} from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  Button,
  EmptyState,
  type HeaderAction,
  type HeaderMenuItem,
  type IconName,
  LargeTitleScreen,
  LIST_AVATAR,
  LIST_INSET,
  ListRow,
  motion,
  PersonAvatar,
  Refreshing,
  SectionHeader,
  SkeletonList,
  SwipeRow,
  useReducedMotion,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { ApproveAllByAgent } from "../approvals/parts";
import { dashboardWaitingCard } from "../dashboards/logic";
import { deviceNoticeOf, isDeviceNotice } from "../devices/logic";
import { DeviceNoticeActions, DeviceNoticeCard } from "../devices/notices";
import { type AppHref, notificationHref, notificationWebPath, routineHref } from "../links/logic";
import { openWebPath } from "../links/open-web";
import { ChangeRequestCard } from "../right-hand/SettingsCard";
import { chooseAction } from "../settings/parts";
import { AdminAskAdd } from "../shared/AdminAsk";
import { AgentFace, Face } from "../shared/Face";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory, useNow, useOrgId, usePullRefresh, useWhen } from "../shared/hooks";
import { Tile } from "../shared/parts";
import { useWaitingApprovals } from "../shared/queries";
import { RetryLine, TeamSkyEmpty } from "../shared/TeamSkyEmpty";
import { useTabHeader } from "../shared/tabHeader";
import { UsageLimitActions } from "../usage/people";
import {
  ACTIVITY_FILTERS,
  type ActivityFilter,
  activitySections,
  type DayGroup,
  emojisOf,
  joinRequestLine,
  nextRoutine,
  placeOf,
  type SayWords,
  subtitleOf,
  upcomingDay,
  waitingCardOf,
} from "./logic";
import { useNoticeTitle } from "./noticeTitle";

/**
 * The inbox: what waits on you on top as rows of the list (who asks, how long is left, what it is about; a request
 * and a question open on a screen of their own, where they are answered), or, with nothing waiting, the sky with
 * the team and "Nada esperando você", then the next real event (a routine's next run); then the rest by day as
 * loose rows. The filters are the bar's menu (the web's: everything, what waits, mentions, unread, the requests
 * already decided, done), with "Mark all as read" and "Clear all".
 * Swipe a row right to mark read or unread, left for "Feito" (a toast offers Desfazer). Tapping opens where it
 * happened. Loading: rows of the list's own shape; a load that failed is one gray line over what was kept.
 * A card decided or a row marked done leaves (fading, a little smaller) and what is under it moves up to its place;
 * the last thing waiting cleared brings the team in cheering.
 */
export function ActivityScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  // `?filter=waiting`: opened from Conversas' "Esperando você" (selects Esperando; each visit with it does).
  const params = useLocalSearchParams<{ filter?: string; at?: string }>();
  const [filter, setFilter] = useState<ActivityFilter>(params.filter === "waiting" ? "waiting" : "all");
  const asked = params.filter === "waiting" ? (params.at ?? "link") : null;
  useEffect(() => {
    if (asked) setFilter("waiting");
  }, [asked]);
  // The decided requests are the approvals' own list: the notifications behind them stay as they are.
  const listFilter = filter === "requests" ? "all" : filter;
  const list = useNotifications(orgId, listFilter);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = list.data?.pages[0]?.counts;
  const { waiting, days } = activitySections(items, filter);
  const toast = useToast();
  const waitingCount = Math.max(waiting.length, counts?.waiting ?? waiting.length);
  const pull = usePullRefresh(list.refetch);
  const tabHeader = useTabHeader();
  // What every row reads alike, read once here and handed down as plain values: a row's read, done and their undo
  // (one function), whether "Clear all" or its undo is under way, and the AIs a "computer ready" row opens by.
  const { mutate: act } = useNotificationAction(orgId);
  const busy = useNotificationBulkPending(orgId);
  const ai = useAiStatus(
    orgId,
    items.some((n) => n.kind === "computer_ready"),
  ).data;
  const clearAll = useClearAll(listFilter, counts, items, busy);
  // The filters, then what acts on the whole list: one menu in the bar (the system's on iOS, a sheet on Android).
  const menu: HeaderMenuItem[] = [
    ...ACTIVITY_FILTERS.map((f) => ({
      icon: f === filter ? ("check" as const) : FILTER_ICON[f].icon,
      sf: f === filter ? ("checkmark" as const) : FILTER_ICON[f].sf,
      label: f === "requests" ? t("notifications.filter.requests") : t(`notifications.filter.${f}`),
      onPress: () => setFilter(f),
    })),
    ...(filter !== "requests" && filter !== "done" && (counts?.unread ?? 0) > 0
      ? [
          {
            icon: "checks" as const,
            sf: "envelope.open" as const,
            label: t("notifications.readAll"),
            onPress: () =>
              act(
                { type: "readAll", filter: listFilter },
                { onError: (e) => toast({ title: errorText(t, e), icon: "x" }) },
              ),
          },
        ]
      : []),
    ...(clearAll && filter !== "requests"
      ? [{ icon: "archive" as const, sf: "archivebox" as const, label: clearAll.label, onPress: clearAll.onPress }]
      : []),
  ];
  const filters: HeaderAction = {
    icon: "list",
    sf: "line.3.horizontal.decrease",
    label: t("notifications.filters"),
    menu,
    onPress: () =>
      chooseAction(
        t("notifications.filters"),
        menu.map((m) => ({ label: m.label, icon: m.icon, onPress: m.onPress })),
        t("mobile.common.cancel"),
      ),
  };
  const header = { ...tabHeader, actions: [filters, ...tabHeader.actions] };
  const reduced = useReducedMotion();
  // A card decided while the page shows leaves and the rest close up; a new one fades in. Rows and the days under
  // them likewise, so nothing on the page jumps.
  const cardMotion = reduced ? {} : { entering: CARD_IN, exiting: LEAVE, layout: MOVE };
  const rowMotion = reduced ? {} : { exiting: LEAVE, layout: MOVE };
  // The clear page cheers only when the person saw something waiting here and it is gone now, not when the tab
  // opens with nothing waiting.
  const clear =
    waiting.length === 0 &&
    !list.isLoading &&
    !(list.isError && !list.data) &&
    (filter === "all" || filter === "waiting") &&
    !reduced;
  const hadWaiting = useRef(false);
  if (waiting.length > 0) hadWaiting.current = true;
  const cheer = clear && hadWaiting.current;
  useEffect(() => {
    if (clear) hadWaiting.current = false;
  }, [clear]);
  if (filter === "requests")
    return (
      <LargeTitleScreen title={t("mobile.activity.title")} {...header} pull={pull}>
        <SectionHeader title={t("notifications.filter.requests")} />
        <DecidedRequests />
      </LargeTitleScreen>
    );
  return (
    <LargeTitleScreen title={t("mobile.activity.title")} {...header} pull={pull}>
      {/* Which filter the list is on, when it isn't everything: the menu's own word, once, over the list. */}
      {filter !== "all" && filter !== "waiting" ? <SectionHeader title={t(`notifications.filter.${filter}`)} /> : null}
      <Refreshing busy={list.isPlaceholderData} label={t("common.loading")}>
        {waiting.length > 0 ? (
          <>
            <SectionHeader title={t("mobile.home.waiting")} count={waitingCount} />
            <ApproveAllByAgent />
            <LayoutAnimationConfig skipEntering skipExiting>
              {waiting.map((n, i) => (
                <Animated.View key={n.id} {...cardMotion}>
                  {isDeviceNotice(n.kind) ? (
                    // A device's notice is decided on its own card (allow once, always, no): it keeps it.
                    <View style={styles.cards}>
                      <DeviceNoticeCard item={n} first={i === 0} />
                    </View>
                  ) : (
                    <WaitingRow item={n} divider={i > 0 && !isDeviceNotice(waiting[i - 1]?.kind ?? "")} />
                  )}
                </Animated.View>
              ))}
            </LayoutAnimationConfig>
          </>
        ) : list.isLoading ? (
          <>
            <SectionHeader title={t("mobile.activity.day.today")} />
            <SkeletonList rows={3} />
            <SectionHeader title={t("mobile.activity.day.yesterday")} />
            <SkeletonList rows={1} />
          </>
        ) : list.isError && !list.data ? (
          // Nothing kept to read: the list's error, with the way to ask again.
          <LoadFailed onRetry={() => void list.refetch()} />
        ) : filter === "all" || filter === "waiting" ? (
          <AllClear cheer={cheer} />
        ) : days.length === 0 ? (
          <EmptyState
            size="inline"
            title={filter === "done" ? t("mobile.activity.noneDone") : t("notifications.noneHere")}
          />
        ) : null}
        {/* Kept rows under a load that failed: the line says so, what loaded stays readable. */}
        {list.isError && list.data && !list.isLoading ? <RetryLine onRetry={() => void list.refetch()} /> : null}
        {/* Another filter is another list: it comes whole, with no row of the last one leaving through it. */}
        <LayoutAnimationConfig key={filter} skipEntering skipExiting>
          {days.map(([group, groupItems]) => (
            <Animated.View key={group} {...rowMotion}>
              <SectionHeader title={t(`mobile.activity.day.${group satisfies DayGroup}`)} />
              {/* Loose rows on the page, as Conversas' (no card around them). */}
              {groupItems.map((n, i) => (
                <Animated.View key={n.id} {...rowMotion}>
                  <ActivityRow item={n} divider={i > 0} href={notificationHref(n, ai)} busy={busy} act={act} />
                </Animated.View>
              ))}
            </Animated.View>
          ))}
        </LayoutAnimationConfig>
      </Refreshing>
      {/* The next page, as Drive's "Mostrar mais": the kit's button, centered, its wheel while the page comes. */}
      {list.hasNextPage ? (
        <Animated.View layout={reduced ? undefined : MOVE} style={styles.more}>
          <Button
            variant="secondary"
            size="sm"
            label={t("mobile.activity.more")}
            loading={list.isFetchingNextPage}
            onPress={() => {
              if (!list.isFetchingNextPage) void list.fetchNextPage();
            }}
          />
        </Animated.View>
      ) : null}
    </LargeTitleScreen>
  );
}

/** Each filter's mark in the bar's menu (the chosen one shows the check instead). */
const FILTER_ICON: Record<ActivityFilter, { icon: IconName; sf: HeaderMenuItem["sf"] }> = {
  all: { icon: "list", sf: "tray" },
  waiting: { icon: "wait", sf: "hourglass" },
  mentions: { icon: "message", sf: "at" },
  unread: { icon: "bell", sf: "circle.fill" },
  requests: { icon: "shield", sf: "checkmark.shield" },
  done: { icon: "archive", sf: "archivebox" },
};

/** An approval this close to expiring is urgent: its time left takes the waiting color. */
const URGENT_MS = 3 * 3_600_000;

/**
 * One thing waiting on you, as a row of the list (no card, no buttons): who asks, how long is left to decide (or
 * when it came), and what it is about in up to two lines. A request and a question open on a screen of their own,
 * where they are answered; anything else opens where it happened.
 */
function WaitingRow({ item: n, divider }: { item: AppNotification; divider: boolean }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const when = useWhen();
  const now = useNow();
  const c = useColors();
  const act = useNotificationAction(orgId);
  const card = waitingCardOf(n);
  // A widget's alert, or an agent asking to publish a dashboard (ADR 0135): its own line.
  const dash = dashboardWaitingCard(n, t as unknown as (key: string, values?: Record<string, unknown>) => string);
  // A request's title in words, from the request itself (the notification keeps the tool's raw title).
  const waitingApprovals = useWaitingApprovals();
  const request = waitingApprovals.find((a) => a.id === n.source.approvalId);
  // One notification per approval card: how many on it still wait for you.
  const onCard = request?.messageId ? waitingApprovals.filter((a) => a.messageId === request.messageId).length : 0;
  // Someone asking to join: who asked (the first names, how many in all), with their faces.
  const join = card.kind === "join" ? joinRequestLine(t, n) : null;
  const notice = useNoticeTitle(n);
  // What the right hand found (ADR 0177 §1): the problem in the reader's language.
  const found = teamWatchOf(n);
  const title =
    card.kind === "approval" && request
      ? [approvalTitle(t, request), onCard > 1 ? t("approval.all.waitingCount", { count: onCard }) : null]
          .filter(Boolean)
          .join(" · ")
      : join
        ? join.text
        : card.kind === "limit" || found
          ? notice.title
          : (dash?.title ?? card.title);
  // A routine's trouble opens the routine; the computer being ready, Connect an AI while no agent has one.
  const ai = useAiStatus(orgId, n.kind === "computer_ready").data;
  // A question is answered on its own screen; a card of several requests opens where they are.
  const href: AppHref | null =
    card.kind === "question" && n.source.questionId ? (`/question/${n.id}` as AppHref) : notificationHref(n, ai);
  // No screen of its own in the app (the workspace's billing hold): its page on the web, so a tap is never a dead end.
  const web = href ? null : notificationWebPath(n, orgId);
  const actor = n.actors[0];
  const who = actor ? { type: actor.type === "agent" ? "agent" : "person", id: actor.id } : null;
  const name = dir.nameOf(who);
  const left = card.expiresAt ? timeLeft(t, card.expiresAt, new Date(now)) : null;
  const urgent = Boolean(left && card.expiresAt && new Date(card.expiresAt).getTime() - now <= URGENT_MS);
  const unread = n.readAt === null;
  const sub = [title, placeOf(n)].filter(Boolean).join(" · ");
  const open = () => {
    if (unread) act.mutate({ type: "read", item: n, read: true });
    if (href) router.push(href);
    else if (web) openWebPath(web);
  };
  const leading = who ? (
    <Face who={who} size={who.type === "agent" ? LIST_AVATAR - 2 : LIST_AVATAR} mode="idle" live={false} />
  ) : join ? (
    <View style={styles.faces}>
      {join.faces.map((face, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: two names at most, and two people can share one
        <View key={`${i}-${face}`} style={i > 0 ? styles.overlap : undefined}>
          <PersonAvatar name={face} size={30} />
        </View>
      ))}
    </View>
  ) : (
    <Tile icon="bell" size={LIST_AVATAR} />
  );
  return (
    <View>
      <ListRow
        onPress={href || web ? open : undefined}
        accessibilityRole="button"
        accessibilityLabel={[name, sub, left].filter(Boolean).join(", ")}
        unread={unread}
        leading={leading}
        title={name || title}
        time={left ?? when.short(n.updatedAt)}
        timeWaiting={urgent}
        sub={name ? sub || null : placeOf(n) || null}
      />
      {/* A person asks for more (ADR 0141): raised or refused right here, under the row. */}
      {card.kind === "limit" ? (
        <View style={styles.change}>
          <UsageLimitActions n={n} />
        </View>
      ) : null}
      {divider ? <View style={[styles.divider, { backgroundColor: c.line2 }]} /> : null}
    </View>
  );
}

/**
 * "Pedidos decididos": the requests already approved, refused or expired, newest first, each opening the request
 * with how it ended.
 */
function DecidedRequests() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const when = useWhen();
  const approvals = useApprovals(orgId);
  const decided = useMemo(
    () =>
      (approvals.data ?? [])
        .filter((a) => a.status !== "pending")
        .sort((a, b) => (b.decidedAt ?? b.expiresAt).localeCompare(a.decidedAt ?? a.expiresAt)),
    [approvals.data],
  );
  // Approved and waiting for a request asked before it: "Na fila", as the web's rows say.
  const lines = useMemo(() => approvalLines(approvals.data ?? []), [approvals.data]);
  const stateOf = (a: Approval) =>
    lines.get(a.id)?.waitsOn ? "queued" : a.status === "pending" ? "expired" : a.status;
  if (approvals.isPending) return <SkeletonList rows={3} />;
  if (approvals.isError && !approvals.data) return <LoadFailed onRetry={() => void approvals.refetch()} />;
  if (decided.length === 0) return <EmptyState size="inline" title={t("notifications.noneRequests")} />;
  return (
    <>
      {decided.map((a, i) => (
        <ListRow
          key={a.id}
          onPress={() => router.push(`/approval/${a.id}`)}
          accessibilityRole="button"
          divider={i > 0}
          leading={<AgentFace agentId={a.agentId} size={LIST_AVATAR - 2} live={false} />}
          title={dir.agentById.get(a.agentId)?.name ?? t("channel.unknownAgent")}
          time={when.short(a.decidedAt ?? a.expiresAt)}
          // How it ended, in one word after what it was.
          sub={[approvalTitle(t, a), t(`approvals.status.${stateOf(a)}`)].join(" · ")}
        />
      ))}
    </>
  );
}

/**
 * Nothing waits on you, right on the page: the sky with the team on its horizon, "Nada esperando você" and one calm
 * line (no card, no button), then the next real event as one line (a routine's next run: its agent, its name and
 * when), which opens the routine; the history follows within the first thumb. `cheer`: the person just cleared the
 * last thing waiting, and the team comes in happy (`TeamSkyEmpty`).
 */
function AllClear({ cheer }: { cheer: boolean }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const deleting = Boolean(useOrg().org?.deletion);
  const dir = useDirectory();
  const routines = useRoutines(orgId);
  // Being deleted, its routines' slots pass: none is next (the server says so too, once the list is read again).
  const next = useMemo(() => (deleting ? null : nextRoutine<Routine>(routines.data ?? [])), [deleting, routines.data]);
  const nextAgent = next ? dir.agentById.get(next.agentId) : undefined;
  const when = useWhen();
  const date = next?.nextRunAt ? nextRunWords(t, when, next.nextRunAt) : null;
  const reduced = useReducedMotion();
  // The last card decided: the clear page fades in where the cards were.
  return (
    <Animated.View entering={reduced ? undefined : FadeIn.duration(160)}>
      <TeamSkyEmpty
        title={t("mobile.activityNow.clear.title")}
        text={t("mobile.activityNow.clear.text")}
        celebrate={cheer}
      />
      {/* The next run as a row of the list below it: who, the routine's name on one line, and when. */}
      {next ? (
        <>
          <SectionHeader title={t("routines.panel.nexts")} />
          <ListRow
            onPress={() => router.push(routineHref(next.id))}
            accessibilityRole="button"
            leading={
              nextAgent ? (
                <AgentFace agentId={nextAgent.id} size={LIST_AVATAR - 2} live={false} />
              ) : (
                <Tile icon="clock" size={LIST_AVATAR} />
              )
            }
            title={next.name}
            sub={
              date
                ? nextAgent
                  ? t("mobile.activityNow.next.routineOf", { agent: nextAgent.name, when: date })
                  : t("mobile.activityNow.next.routine", { when: date })
                : null
            }
            subLines={1}
          />
        </>
      ) : null}
    </Animated.View>
  );
}

/** When the next run is: "hoje às 18:00", "amanhã às 9:00", "qua, 12 nov às 9:00". */
function nextRunWords(t: TFunction, when: ReturnType<typeof useWhen>, iso: string): string {
  const day = upcomingDay(iso);
  const time = when.time(iso);
  const date =
    day === "today"
      ? t("mobile.activityNow.next.today", { time })
      : day === "tomorrow"
        ? t("mobile.activityNow.next.tomorrow", { time })
        : t("mobile.activityNow.next.later", {
            day: dateFormat(when.locale, { weekday: "short", day: "numeric", month: "short" })
              .format(new Date(iso))
              .replace(/\./g, ""),
            time,
          });
  return date;
}

/**
 * "Clear all" in the bar, as the web's: everything listed goes to Feitas but what waits on you, and the toast offers
 * Desfazer. Only in Tudo, and only with something to move.
 */
function useClearAll(
  filter: NotificationFilter,
  counts: NotificationCounts | undefined,
  items: AppNotification[],
  busy: boolean,
): HeaderAction | null {
  const { t } = useTranslation();
  const orgId = useOrgId();
  // Its own: the toast's undo follows this call's answer, which a row's action (the rows share one) would replace.
  const act = useNotificationAction(orgId);
  const toast = useToast();
  if (!canClearAll(filter, counts, items)) return null;
  const run = () =>
    act.mutate(
      { type: "doneAll", filter: "all" },
      {
        onSuccess: (res) => {
          if (!res.ids.length) return;
          toast({
            title: t("mobile.activity.doneAllToast", { count: res.ids.length }),
            action: {
              label: t("mobile.activity.undo"),
              onPress: () =>
                act.mutate(
                  { type: "undoneMany", ids: res.ids },
                  { onError: (e) => toast({ title: errorText(t, e), icon: "x" }) },
                ),
            },
          });
        },
        onError: (e) => toast({ title: errorText(t, e), icon: "x" }),
      },
    );
  return { icon: "check", sf: "checkmark.circle", label: t("notifications.doneAll"), disabled: busy, onPress: run };
}

/**
 * One item, in Conversas' row: the faces, who did what (the names bold)
 * and when, the snippet and where; a red dot on the right while unread. Swipe right to mark read or unread,
 * left for "Feito"; tapping opens where it happened.
 */
const ActivityRow = memo(function ActivityRow({
  item: n,
  divider,
  href,
  busy,
  act,
}: {
  item: AppNotification;
  divider: boolean;
  /**
   * Where a tap opens (`notificationHref`): a routine's trouble opens the routine; the computer being ready, Connect an
   * AI while no agent has one.
   */
  href: AppHref | null;
  /** "Clear all" or its undo is under way: the row doesn't swipe. */
  busy: boolean;
  /** The screen's read and done (`useNotificationAction`). */
  act: NotificationAct;
}) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const when = useWhen();
  const toast = useToast();
  // No screen of its own in the app (the workspace's billing hold): its page on the web, so a tap is never a dead end.
  const web = href ? null : notificationWebPath(n, orgId);
  const unread = n.readAt === null;

  // Who did what, as the island says it too; a restriction or several agents' failures go under it.
  const { parts, names, title, restriction, failed } = useNoticeTitle(n);
  // Coded words in the person's language: why a routine paused or failed, who asked for an approval.
  const say: SayWords = (w, otherwise = "") => {
    const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
    return tt(w.key, { ...w.values, defaultValue: w.fallback ? tt(w.fallback) : otherwise });
  };
  // A GIF or a sticker with no words says which (ADR 0091).
  const line = subtitleOf(
    n,
    say,
    (kind) => mediaWord(t, kind),
    (l) => latestText(t, l),
  );
  const sub = restriction
    ? restrictionLine(t, restriction.code, restriction.facts)
    : isComputerOutage(n)
      ? [placeOf(n), computerOutageLine(t, n, i18n.language)].filter(Boolean).join(" · ")
      : n.kind === "usage_limit"
        ? usageLimitLine(t, n)
        : // What the right hand found (ADR 0177 §1) is the title itself: nothing under it says it again.
          n.kind === "team_watch" || n.kind === "budget_paused"
          ? ""
          : failed
            ? failed.sub
            : // Where first, then the words, as the web inbox ("#canal · snippet"). A widget's or routine's name is
              // often its line too: said once ("Assinaturas hoje", not twice).
              [emojisOf(n).join(" "), [...new Set([placeOf(n), line].filter(Boolean))].join(" · ")]
                .filter(Boolean)
                .join(" ");
  const time = when.short(n.updatedAt);
  // As Conversas' rows: line 1 who (the names alone, one line, the time on their baseline), line 2 what they did and
  // where. A sentence that doesn't open with the names (or has none) is line 1 itself, on one line too.
  const [lead = "", did = ""] = parts;
  const byNames = !failed && !restriction && parts.length === 2 && lead.trim() === "" && Boolean(names);
  const action = byNames ? upperFirst(did.trim(), i18n.language) : "";
  const second = byNames ? [action, sub].filter(Boolean).join(" · ") : sub;

  // The swipe taps on its own (SwipeRow); VoiceOver's actions call these too.
  const toggleRead = () => {
    if (!busy) act({ type: "read", item: n, read: unread });
  };
  // In "Feitas" the same swipe moves it back to the inbox. Marked done, a toast offers the way back for a moment.
  const isDone = Boolean(n.doneAt);
  const done = () => {
    if (busy) return;
    act({ type: "done", item: n, done: !isDone });
    if (!isDone)
      toast({
        title: t("mobile.activity.doneToast"),
        subtitle: title,
        action: { label: t("mobile.activity.undo"), onPress: () => act({ type: "done", item: n, done: false }) },
      });
  };
  const doneLabel = isDone ? t("mobile.activity.restore") : t("mobile.activity.done");
  const open = () => {
    if (unread) act({ type: "read", item: n, read: true });
    if (href) router.push(href);
    else if (web) openWebPath(web);
  };
  const faces = n.actors.slice(0, n.count > 1 ? 2 : 1);
  const leading =
    faces.length === 0 ? (
      <Tile icon="bell" size={LIST_AVATAR} />
    ) : faces.length === 1 ? (
      <Face who={faceOf(faces[0])} size={faces[0]?.type === "agent" ? LIST_AVATAR - 2 : LIST_AVATAR} live={false} />
    ) : (
      <View style={styles.stack}>
        <View style={styles.back}>
          <Face who={faceOf(faces[0])} size={STACKED} live={false} />
        </View>
        <View style={[styles.front, { backgroundColor: c.bg, borderRadius: STACKED * 0.3 + 2 }]}>
          <Face who={faceOf(faces[1])} size={STACKED} live={false} />
        </View>
      </View>
    );
  const a11y = [title, sub, time, unread ? t("mobile.activity.unread") : null].filter(Boolean).join(", ");
  return (
    <View>
      <SwipeRow
        // While "Clear all" or its undo is under way, a row doesn't swipe.
        left={
          busy
            ? undefined
            : {
                label: unread ? t("mobile.activity.markRead") : t("mobile.activity.markUnread"),
                icon: unread ? "check" : "bell",
                color: c.agent,
                ink: c.onAgent,
                onAction: toggleRead,
              }
        }
        // On the green, the page's color reads in both themes (white in light, near black on dark's light green).
        right={
          busy
            ? undefined
            : { label: doneLabel, icon: isDone ? "undo" : "archive", color: c.ok, ink: c.bg, onAction: done }
        }
      >
        <View style={{ backgroundColor: c.bg }}>
          <ListRow
            onPress={open}
            accessibilityRole="button"
            accessibilityLabel={a11y}
            accessibilityActions={[
              { name: "read", label: unread ? t("mobile.activity.markRead") : t("mobile.activity.markUnread") },
              { name: "done", label: doneLabel },
            ]}
            onAccessibilityAction={(e) => (e.nativeEvent.actionName === "read" ? toggleRead() : done())}
            dot={unread}
            unread={unread}
            leading={leading}
            title={byNames ? names : title}
            time={time}
            sub={second || null}
            subLines={restriction ? 0 : undefined}
          />
        </View>
      </SwipeRow>
      {/* A change someone sent with "Pedir a um admin" (ADR 0137): decided on its card, here. */}
      {n.kind === "change_request" ? (
        <View style={styles.change}>
          <ChangeRequestCard n={n} />
        </View>
      ) : null}
      {/* The agent's model left its plan's list: another one chosen from here. */}
      {n.kind === "plan_model_dropped" && href && !n.doneAt ? (
        <View style={styles.change}>
          <Button variant="secondary" size="sm" label={t("mobile.activity.chooseModel")} onPress={open} />
        </View>
      ) : null}
      {/* An agent holds the person's phone: Stop; a computer lends its internet: Turn off. Right here (nothing, and no
          room for it, once it's done). */}
      {deviceActionable(n) ? (
        <View style={styles.change}>
          <DeviceNoticeActions item={n} />
        </View>
      ) : null}
      {/* Someone asks to add an agent to a channel: added right here. */}
      {n.kind === "admin_ask" && n.latest.reason === "channel_agent" && !n.doneAt ? (
        <View style={styles.change}>
          <AdminAskAdd n={n} />
        </View>
      ) : null}
      {/* A person asks for more (ADR 0141): raised or refused right here. */}
      {n.kind === "usage_limit" && n.latest.statusTo === "request" && !n.doneAt ? (
        <View style={styles.change}>
          <UsageLimitActions n={n} />
        </View>
      ) : null}
      {divider ? <View style={[styles.divider, { backgroundColor: c.line2 }]} /> : null}
    </View>
  );
});

/** A notification's read, done and their undo, as the screen hands it to its rows. */
type NotificationAct = ReturnType<typeof useNotificationAction>["mutate"];

/** Whether a device notice still has its button under the row (`DeviceNoticeActions` draws it only then). */
function deviceActionable(n: AppNotification): boolean {
  if (!isDeviceNotice(n.kind) || n.doneAt) return false;
  const d = deviceNoticeOf(n);
  return (
    (d?.kind === "device.in_use" && Boolean(d.phoneId)) ||
    (d?.kind === "device.internet_shared" && Boolean(d.machineId))
  );
}

/** Two faces share the avatar box (grouped items: reactions, replies). */
const STACKED = 36;
const faceOf = (a: AppNotification["actors"][number] | undefined) =>
  a ? { type: a.type === "agent" ? "agent" : "person", id: a.id } : null;

const styles = StyleSheet.create({
  // A device's card among the rows, at the screen's margin.
  cards: { paddingHorizontal: 16, paddingVertical: 6 },
  // What is decided right under a row starts at the row's words (the text column at 80), not under its face.
  change: { paddingLeft: LIST_INSET, paddingRight: 16, paddingBottom: 12 },
  faces: { flexDirection: "row" },
  overlap: { marginLeft: -6 },
  stack: { width: LIST_AVATAR, height: LIST_AVATAR },
  back: { position: "absolute", top: 0, left: 0 },
  front: { position: "absolute", right: -2, bottom: -2, padding: 2 },
  divider: { position: "absolute", top: 0, left: LIST_INSET, right: 0, height: StyleSheet.hairlineWidth },
  more: { alignItems: "center", paddingTop: 20, paddingBottom: 8 },
});

const CARD_IN = FadeIn.duration(160);
/** What was decided or done leaves: fading, a little smaller, never to nothing. */
const LEAVE: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ scale: 1 }] },
    animations: {
      opacity: withTiming(0, { duration: 240, easing: motion.easeOut }),
      transform: [{ scale: withTiming(0.94, { duration: 240, easing: motion.easeOut }) }],
    },
  };
};
/** What stays moves to its new place on the `nav` spring: no overshoot. */
const MOVE = LinearTransition.springify().damping(motion.nav.damping).stiffness(motion.nav.stiffness);
