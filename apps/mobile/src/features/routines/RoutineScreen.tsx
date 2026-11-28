import {
  type Routine,
  type RoutineAhead,
  type RoutineRun,
  useRoutineRunCalls,
  useRoutineRuns,
  useRoutines,
  useRuleDescribe,
} from "@agenteschat/client";
import { ownActionName, routineVaultKey, splitOwnActions } from "@agenteschat/client/lib/approval-words";
import { managesAgent } from "@agenteschat/client/lib/audience";
import { formatBytes } from "@agenteschat/client/lib/files";
import { formatTokensShort, formatUsd, whenAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import {
  busyOnComputer,
  eventWebhook,
  healthWords,
  isRunAtWork,
  isStoppable,
  routineChannelOf,
  routineStateTime,
  routineStateWords,
  runMessageLink,
  runOutcome,
  runPixelStatus,
  runsPerDay,
  stopWordsKey,
  usageContinueBlock,
  usageContinueOffered,
  usageParts,
  whereItRuns,
} from "@agenteschat/client/lib/routine-view";
import { runCallText } from "@agenteschat/client/lib/routine-webhooks";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  GROUPED_ROW,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  type IconName,
  LineIcon,
  SCREEN_X,
  SkeletonList,
  Text,
  useReducedMotion,
} from "@/ui";
import { router } from "@/ui/navigation";
import { approvalTitleText, useCancelAhead } from "../approvals/parts";
import { FoldedBody } from "../chat/FoldedBody";
import { MissingScreen } from "../dashboards/parts";
import { chatHref, widgetHref } from "../links/logic";
import { openSwitchComputer } from "../outages/OutageNotice";
import { useMachineOutages } from "../outages/queries";
import { CommandBlock } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { LoadFailed } from "../shared/FirstUse";
import {
  useColors,
  useDirectory,
  useEdition,
  useNamesComputers,
  useNow,
  useOrgId,
  usePullRefresh,
} from "../shared/hooks";
import { FocusLive, goBack, PushedHeader } from "../shared/parts";
import { EventWebhookSetup } from "./EventWebhookSetup";
import {
  editRoutineHref,
  useNextText,
  useRoutineControls,
  useRoutineMenu,
  useRunWords,
  useSay,
  useTargetLabel,
  useWhenText,
} from "./hooks";
import {
  FIX_ICON,
  fixFor,
  hasFired,
  isDoneOnce,
  isPaused,
  isReminder,
  isRunning,
  mailTrouble,
  routineTitle,
  targetIcon,
} from "./logic";
import { RoutineRunBars } from "./parts";
import { nextLabel } from "./rule";
import { WebhookCard } from "./WebhookCard";

/** At most this many runs on the screen (the web's details show as many). */
const RUNS_SHOWN = 30;
/** A run's mark on the timeline, and the height of the outcome's line beside it. */
const NODE = 18;
const SUBHEAD_LINE = 20;

/**
 * One routine (`/routines/<id>`), the web's details on a screen of its own: the agent, the title and its state;
 * Editar, Rodar agora or Parar, Pausar or Retomar (and the one-tap fix, "Trocar computador" while its run waits
 * for an offline computer on a self-host) for whoever may change it; then the week, what it does, when, where it
 * delivers, where it runs (only where the workspace has more than one computer, by its name), what it may do on its
 * own, when it posts, and its runs, each opening the agent's message
 * (or the approval it waits for); a webhook routine's address card for who manages it. "…" in the bar: Editar,
 * Duplicar, Copiar URL do webhook, Apagar. The routine comes
 * from the list (there is no single-routine endpoint).
 */
export function RoutineScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const routines = useRoutines(useOrgId());
  const r = routines.data?.find((x) => x.id === id);
  if (r) return <Details routine={r} refetch={routines.refetch} />;
  return (
    <MissingScreen
      title={t("routines.panel.eyebrow")}
      state={routines.isLoading ? "loading" : routines.isError && !routines.data ? "failed" : "gone"}
      onRetry={() => void routines.refetch()}
      gone={t("routines.notFound")}
    />
  );
}

function Details({ routine: r, refetch }: { routine: Routine; refetch: () => Promise<unknown> }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const orgId = useOrgId();
  const { org } = useOrg();
  const dir = useDirectory();
  const say = useSay();
  const controls = useRoutineControls(r);
  const menu = useRoutineMenu(r, goBack);
  const runs = useRoutineRuns(orgId, r.id);
  const targetLabel = useTargetLabel();
  const whenText = useWhenText();
  const nextText = useNextText();
  const words = useRunWords();
  const at = new Date(useNow(60_000));
  const outages = useMachineOutages();
  const pull = usePullRefresh(() => Promise.all([refetch(), runs.refetch()]));
  const agentName = dir.nameOf({ type: "agent", id: r.agentId });
  const title = routineTitle(r);
  const own = splitOwnActions(r.ownActions ?? []);
  const done = isDoneOnce(r);
  const fired = hasFired(r);
  const running = isRunning(r);
  const stoppable = isStoppable(r);
  const reminder = isReminder(r);
  const trouble = mailTrouble(r);
  const described = useRuleDescribe(
    orgId,
    r.active && r.trigger.type === "schedule" && r.trigger.rule ? r.trigger.rule : null,
  );
  const nexts = described.data?.ok ? described.data.nextRuns.slice(0, 4) : r.nextRunAt ? [r.nextRunAt] : [];
  // Its one-tap fix, "Take over" only for who may make a routine for its agent (`fixFor`).
  const fix = fixFor(r, dir.agentById.get(r.agentId));
  // "Trocar computador": the outage its run waits on, for whoever manages its agent (the server's `canManage`), where
  // people connect their own computers (a Cloud workspace has one).
  const selfHost = useEdition() === "selfhost";
  const outage =
    selfHost && r.state === "waiting_computer" && r.waitingFor && managesAgent(dir.agentById.get(r.agentId))
      ? outages.outages.find((o) => o.machineId === r.waitingFor?.machineId)
      : undefined;
  const health = healthWords(r.health);
  const usage = usageParts(r.usage, can(org, "view_usage"));
  const usageText = usage
    ? [
        t("routines.usage.runs", { count: usage.runs }),
        usage.tokens !== null
          ? t("routines.usage.tokens", { tokens: formatTokensShort(t, i18n.language, usage.tokens) })
          : null,
        usage.costUsd !== null ? t("routines.usage.cost", { cost: formatUsd(i18n.language, usage.costUsd) }) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  const namesComputer = useNamesComputers();
  const runsOn = whereItRuns(r.brain, namesComputer);
  const perDay = r.trigger.type === "schedule" ? runsPerDay(r.trigger.rule ?? null, r.trigger.cron) : 0;
  const busy = r.active ? busyOnComputer(r.brain, perDay, { selfHost, namesComputer }) : null;
  const whereHint =
    r.target.type === "conversation"
      ? r.target.threadId
        ? "thread"
        : "channel"
      : r.target.type === "dm"
        ? "dm"
        : r.target.type;
  // Where it delivers opens when it is a conversation the phone has (a channel, a thread), or its widget (ADR 0135).
  const whereChannel = routineChannelOf(r.target);
  const widget = r.target.type === "widget" ? r.target : null;
  const whereHref = widget
    ? widgetHref(widget.widgetId, widget.dashboardId)
    : whereChannel
      ? chatHref(whereChannel, r.target.type === "conversation" ? r.target.threadId : null)
      : null;
  const list = runs.data ?? r.recentRuns;
  const next = done ? "" : nextText(r, at);
  // A run that starts while the person watches fades in; the runs under it slide into place.
  const reduced = useReducedMotion();
  const fade = reduced ? {} : { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) };
  const layout = reduced ? undefined : LinearTransition.duration(220);
  // Its state in words, in the waiting color when it needs a look (never a pill: the words carry it).
  const state = routineStateWords(r, routineStateTime(t, i18n.language, r), namesComputer);
  const stateLine = [done ? t("routines.panel.state.done") : say(state), reminder ? t("routines.reminder") : null]
    .filter(Boolean)
    .join(" · ");
  const stateColor = !done && state.tone === "waiting" ? c.amberInk : c.muted;
  const usageBlock = r.state === "usage_paused" ? usageContinueBlock(r) : null;
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("routines.panel.eyebrow")} solid={false} grouped {...(menu ? { actions: [menu] } : {})} />
      <FocusLive>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
          contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 32 }]}
        >
          {/* Whose it is and how it stands: the agent's face, the routine's name, the agent and its state. */}
          <View style={styles.head}>
            <AgentFace agentId={r.agentId} size={36} mode={running ? "run" : isPaused(r) ? "rest" : "idle"} />
            <View style={styles.grow}>
              <Text variant="title" accessibilityRole="header">
                {title}
              </Text>
              <Text variant="subhead" tone="muted" numberOfLines={1}>
                {agentName}
              </Text>
              <Text variant="footnote" style={{ color: stateColor }} accessibilityLiveRegion="polite">
                {stateLine}
              </Text>
            </View>
          </View>
          {r.canManage ? (
            <>
              <View style={styles.gap} />
              <GroupedList>
                {/* The one-tap fix of what keeps it from running, first. */}
                {fix && fix !== "resume" ? (
                  <GroupedRow
                    key="fix"
                    icon={FIX_ICON[fix]}
                    label={t(`routines.fix.${fix}`)}
                    disabled={controls.action.isPending}
                    onPress={() => controls.fix(fix)}
                  />
                ) : null}
                {outage ? (
                  <GroupedRow
                    key="outage"
                    icon="laptop"
                    label={t("outage.switch")}
                    chevron
                    onPress={() => openSwitchComputer(outage.machineId)}
                  />
                ) : null}
                {/* Parar for a run at work (a paused routine's too); "Rodar agora" while it may run. */}
                {(stoppable || !fired) && !reminder ? (
                  stoppable ? (
                    <GroupedRow
                      key="stop"
                      icon="stop"
                      label={t(stopWordsKey(r))}
                      disabled={controls.action.isPending}
                      onPress={controls.stop}
                    />
                  ) : (
                    <GroupedRow
                      key="run"
                      icon="play"
                      label={t("routines.runNow")}
                      disabled={controls.action.isPending}
                      onPress={controls.run}
                    />
                  )
                ) : null}
                {fired ? null : (
                  <GroupedRow
                    key="active"
                    icon={r.active ? "pause" : "play"}
                    label={r.active ? t("routines.panel.pause") : t("routines.resume")}
                    disabled={controls.action.isPending}
                    onPress={() => controls.setActive(!r.active)}
                  />
                )}
                {/* A widget's routine is changed from its widget. */}
                {widget ? (
                  <GroupedRow
                    key="widget"
                    icon="chart"
                    label={t("widgets.notice.openWidget")}
                    chevron
                    onPress={() => router.push(widgetHref(widget.widgetId, widget.dashboardId))}
                  />
                ) : (
                  <GroupedRow
                    key="edit"
                    icon="pen"
                    label={t("routines.edit")}
                    chevron
                    onPress={() => router.push(editRoutineHref(r.id))}
                  />
                )}
              </GroupedList>
            </>
          ) : null}

          {/* Waiting on its plan's or budget's limit: it picks up by itself; near the limit it may go on now. */}
          {r.state === "usage_paused" ? (
            usageContinueOffered(r) ? (
              <>
                <View style={styles.gap} />
                <GroupedList>
                  <GroupedRow
                    icon="play"
                    label={t("usageCard.continue")}
                    {...(usageBlock ? { sub: t(`routines.usagePause.${usageBlock}`), subLines: 0 } : {})}
                    disabled={usageBlock !== null || controls.action.isPending}
                    onPress={controls.continueUsage}
                  />
                </GroupedList>
                <GroupedFooter>{t("routines.usagePause.line")}</GroupedFooter>
              </>
            ) : (
              <GroupedFooter>{t("routines.usagePause.lineLimit")}</GroupedFooter>
            )
          ) : null}

          <Section title={t("routines.panel.week")}>
            <Block>
              <Text variant="body">{health ? health.map(say).join(" · ") : t("routines.health.none")}</Text>
              {usageText ? (
                <Text variant="footnote" tone="muted">
                  {`${t("routines.panel.usage")}: ${usageText}`}
                </Text>
              ) : null}
              <View style={styles.strip}>
                <RoutineRunBars routine={r} running={running} />
                <Text variant="caption" tone="faint" style={styles.shrink}>
                  {words.caption(r, at)}
                </Text>
              </View>
            </Block>
          </Section>

          <Section title={t("routines.panel.what", agentGrammar(agentName))}>
            {r.canSeeDetails && r.prompt !== null ? (
              <Block>
                <Text variant="body" selectable>
                  {r.prompt}
                </Text>
              </Block>
            ) : null}
          </Section>
          {r.canSeeDetails && r.prompt !== null ? null : <GroupedFooter>{t("routines.detailsHidden")}</GroupedFooter>}

          <Section title={t("routines.panel.when")}>
            <Block>
              <Text variant="body">{whenText(r)}</Text>
              {trouble ? (
                <Text variant="footnote" style={{ color: c.amberInk }}>
                  {trouble === "error" ? t("mail.routine.error") : t("mail.routine.needsReconnect")}
                </Text>
              ) : null}
              {r.trigger.type === "email" ? (
                <Text variant="footnote" tone="muted">
                  {t("mail.routine.every")}
                </Text>
              ) : r.trigger.type === "webhook" ? (
                <Text variant="footnote" tone="muted">
                  {t("common.joinSentences", {
                    a: t("routines.webhook.every"),
                    b: t("routines.webhook.methodsLine", { methods: (r.trigger.methods ?? ["POST"]).join(", ") }),
                  })}
                </Text>
              ) : r.trigger.type === "event" ? (
                <Text variant="footnote" tone="muted">
                  {t("routines.panel.eventEvery")}
                </Text>
              ) : nexts.length > 0 && !done ? (
                <Text variant="footnote" tone="ink2">
                  {`${t("routines.form.next")}: ${nexts.map((iso) => nextLabel(i18n.language, iso)).join(" · ")}`}
                </Text>
              ) : null}
              {next ? (
                <Text variant="footnote" tone={running ? "ink2" : "muted"}>
                  {next}
                </Text>
              ) : null}
              {busy ? (
                <View style={styles.note}>
                  {/* On the note's first line, not above its letters at the row's top. */}
                  <LineIcon variant="footnote" name="laptop" size={14} color={c.muted} />
                  <Text variant="footnote" tone="muted" style={styles.shrink}>
                    {say(busy)}
                  </Text>
                </View>
              ) : null}
            </Block>
          </Section>

          {r.trigger.type === "event" && eventWebhook(r.trigger.event) && !done ? (
            <EventWebhookSetup provider={eventWebhook(r.trigger.event) ?? "github"} />
          ) : null}
          {r.trigger.type === "webhook" ? (
            r.canManage ? (
              <WebhookCard routine={r} runs={list} />
            ) : (
              <>
                <GroupedHeader>{t("routines.form.kind.webhook")}</GroupedHeader>
                <GroupedFooter>{t("routines.webhook.hidden")}</GroupedFooter>
              </>
            )
          ) : null}

          {r.ahead && r.ahead.length > 0 ? (
            <>
              <Section title={t("routines.panel.ahead")}>
                {r.ahead.map((a) => (
                  <AheadItem key={a.id} action={a} />
                ))}
              </Section>
              <GroupedFooter>{t("routines.ahead.hint")}</GroupedFooter>
            </>
          ) : null}

          {r.canSeeDetails ? (
            <>
              <Section title={t("routines.panel.ownActions")}>
                {own.apps.map((name) => (
                  <GroupedRow
                    key={name}
                    label={ownActionName(t, name)}
                    {...(r.canManage
                      ? {
                          toggle: true,
                          disabled: controls.action.isPending,
                          onPress: () =>
                            controls.action.mutate({
                              type: "update",
                              id: r.id,
                              patch: { ownActions: (r.ownActions ?? []).filter((a) => a !== name) },
                            }),
                        }
                      : {})}
                  />
                ))}
              </Section>
              <GroupedFooter
                hint={{
                  name: t("common.about", { label: t("routines.panel.ownActions") }),
                  text: t(own.apps.length ? "routines.ownActions.hint" : "routines.ownActions.none"),
                }}
              >
                {t(own.apps.length ? "routines.ownActions.hintShort" : "routines.ownActions.noneShort")}
              </GroupedFooter>
            </>
          ) : null}

          {r.canSeeDetails && own.keys.length > 0 ? (
            <>
              <Section title={t("routines.vaultKeys.title")}>
                {own.keys.map((key) => (
                  <GroupedRow
                    key={key}
                    icon="key"
                    label={key}
                    {...(r.canManage
                      ? {
                          toggle: true,
                          disabled: controls.action.isPending,
                          onPress: () =>
                            controls.action.mutate({
                              type: "update",
                              id: r.id,
                              patch: { ownActions: (r.ownActions ?? []).filter((a) => routineVaultKey(a) !== key) },
                            }),
                        }
                      : {})}
                  />
                ))}
              </Section>
              <GroupedFooter>{t("routines.vaultKeys.hint")}</GroupedFooter>
            </>
          ) : null}

          <Section title={t("routines.panel.where")}>
            <GroupedRow
              icon={targetIcon(r.target)}
              label={r.widget?.title ?? targetLabel(r.target)}
              sub={t(`routines.panel.whereHint.${whereHint}`)}
              subLines={2}
              media
              chevron={Boolean(whereHref)}
              {...(whereHref ? { onPress: () => router.push(whereHref) } : {})}
            />
          </Section>

          {runsOn ? (
            <Section title={t("routines.panel.runsOn")}>
              <GroupedRow icon="laptop" label={runsOn} labelLines={2} />
            </Section>
          ) : null}

          <Section title={t("routines.panel.report")}>
            <GroupedRow
              label={t(`routines.report.${r.report}`)}
              labelLines={2}
              hint={{ name: t("common.about", { label: t("routines.panel.report") }), text: t("routines.report.hint") }}
            />
          </Section>

          <Section title={t("routines.panel.runs")}>
            {runs.isLoading && list.length === 0 ? (
              // Loading: the rows' own shape, never a spinner.
              <SkeletonList rows={2} />
            ) : list.length > 0 ? (
              // The runs fade in over the skeleton; the ones there when they load don't each fade again.
              <Animated.View {...fade} style={styles.runs}>
                <LayoutAnimationConfig skipEntering>
                  {list.slice(0, RUNS_SHOWN).map((x, i, shown) => (
                    <Animated.View key={x.id} {...fade} layout={layout}>
                      <RunItem run={x} routine={r} last={i === shown.length - 1} />
                    </Animated.View>
                  ))}
                </LayoutAnimationConfig>
              </Animated.View>
            ) : null}
          </Section>
          {list.length === 0 && !runs.isLoading ? (
            <GroupedFooter>
              {nexts[0] && !done
                ? t("common.joinSentences", {
                    a: t("routines.noRuns"),
                    b: t("routines.panel.firstRun", { when: nextLabel(i18n.language, nexts[0]) }),
                  })
                : t("routines.noRuns")}
            </GroupedFooter>
          ) : null}
        </ScrollView>
      </FocusLive>
    </View>
  );
}

/** A section of the screen: its header over a grouped card (none when it holds nothing). */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <GroupedHeader>{title}</GroupedHeader>
      <GroupedList>{children}</GroupedList>
    </>
  );
}

/** Text inside a section's card, on a grouped row's sides. */
function Block({ children }: { children: ReactNode }) {
  return <View style={styles.block}>{children}</View>;
}

/**
 * An action prepared for one of its runs (`schedule_action`): what it does and when, opening its request; the "×"
 * withdraws it (it won't run) for whoever may.
 */
function AheadItem({ action: a }: { action: RoutineAhead }) {
  const { t, i18n } = useTranslation();
  const cancel = useCancelAhead();
  const title = approvalTitleText(t, { ...a, email: null });
  return (
    <GroupedRow
      icon={a.status === "approved" ? "clock" : "wait"}
      label={title}
      labelLines={2}
      sub={t(a.status === "approved" ? "routines.ahead.approved" : "routines.ahead.pending", {
        when: nextLabel(i18n.language, a.runAt),
      })}
      onPress={() => router.push(`/approval/${a.id}`)}
      {...(a.canCancel && !cancel.pending
        ? { remove: { label: `${t("approval.ahead.cancel")}: ${title}`, onPress: () => cancel.cancel(a.id) } }
        : {})}
    />
  );
}

/** A run's mark on the timeline, as the web's: done, nothing new (a dash), failed, skipped, at work. */
function useNode(run: RoutineRun): { bg: string; ink: string; icon: IconName | null } {
  const c = useColors();
  const pixel = runPixelStatus(run.status);
  if (pixel === "ok") return { bg: c.ink, ink: c.bg, icon: "check" };
  // Each fill's own ink: white stood on dark's light red, amber and blue with too little contrast.
  if (pixel === "failed") return { bg: c.danger, ink: c.bg, icon: "x" };
  if (pixel === "skipped") return { bg: c.warn, ink: c.onWarn, icon: "pause" };
  if (pixel === null && isRunAtWork(run.status)) return { bg: c.agent, ink: c.onAgent, icon: "play" };
  return { bg: c.sunken, ink: c.ink2, icon: null };
}

/**
 * One run: its outcome in plain words ("Contou o que achou", "Pulada: a anterior ainda estava rodando", "Parada
 * por Ana"), the agent's words when the viewer may read them, and where it goes: the approval it waits for, or
 * the agent's message ("Abrir na conversa").
 */
function RunItem({ run: x, routine: r, last }: { run: RoutineRun; routine: Routine; last: boolean }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const say = useSay();
  const node = useNode(x);
  const outcome = say(runOutcome(x, (id) => dir.memberById.get(id)?.name ?? null));
  const link = runMessageLink(x);
  const words = r.canSeeDetails && (x.status === "reported" || x.status === "silent") ? x.summary.trim() : "";
  const approval = x.status === "waiting" && x.approvalId ? x.approvalId : null;
  const href = approval ? `/approval/${approval}` : link ? chatHref(link.channelId, link.threadId) : null;
  const when = whenAt(t, i18n.language, x.at);
  const go = href ? () => router.push(href) : undefined;
  return (
    <View style={styles.run}>
      <View style={styles.rail}>
        <View style={[styles.node, { backgroundColor: node.bg }]}>
          {node.icon ? (
            <Icon name={node.icon} size={12} color={node.ink} />
          ) : (
            <View style={[styles.dash, { backgroundColor: node.ink }]} />
          )}
        </View>
        {last ? null : <View style={[styles.stem, { backgroundColor: c.line2 }]} />}
      </View>
      <View style={styles.grow}>
        {/* Its parts apart, not one button: the agent's words hold links and their own "Mostrar mais". */}
        <Pressable
          onPress={go}
          disabled={!go}
          accessibilityRole={go ? "button" : undefined}
          accessibilityLabel={`${outcome}, ${when}`}
          style={({ pressed }) => (pressed && go ? styles.pressed : null)}
        >
          <Text variant="subhead" style={[styles.bold, approval ? styles.underline : null]}>
            {outcome}
          </Text>
        </Pressable>
        {words ? <FoldedBody body={words} muted /> : null}
        {link && !approval ? (
          // Nothing added above: that is where its words' "Mostrar mais" is.
          <Pressable onPress={go} accessibilityRole="button" hitSlop={{ bottom: 13, left: 13, right: 13 }}>
            <Text variant="footnote" tone="muted" style={styles.open}>
              {t("routines.openInChat")}
            </Text>
          </Pressable>
        ) : null}
        {r.canManage && x.calls ? <RunCalls routine={r} run={x} count={x.calls} /> : null}
      </View>
      <Text variant="caption" tone="faint" style={styles.when}>
        {when}
      </Text>
    </View>
  );
}

/** A webhook run's calls as they were kept, the web's for the phone, for who manages the routine: read when opened. */
function RunCalls({ routine: r, run: x, count }: { routine: Routine; run: RoutineRun; count: number }) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const [open, setOpen] = useState(false);
  const calls = useRoutineRunCalls(orgId, r.id, open ? x.id : null);
  return (
    <View>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={{ bottom: 13, left: 13, right: 13 }}
      >
        <Text variant="footnote" tone="muted" style={styles.open}>
          {t(open ? "routines.runCalls.hide" : "routines.runCalls.show", { n: count })}
        </Text>
      </Pressable>
      {open ? (
        calls.isError ? (
          <LoadFailed onRetry={() => void calls.refetch()} />
        ) : !calls.data ? (
          <SkeletonList rows={1} />
        ) : (
          calls.data.map((c) => {
            const text = runCallText(c);
            return (
              <View key={c.n} style={styles.call}>
                <Text variant="footnote" tone="muted">
                  {[
                    `${c.method} ${whenAt(t, i18n.language, c.at)}`,
                    formatBytes(i18n.language, c.bytes),
                    ...(c.test ? [t("routines.webhook.callTest")] : []),
                    ...(c.cut ? [t("routines.runCalls.cut")] : []),
                    ...(c.binary ? [t("routines.runCalls.binary")] : []),
                  ].join(" · ")}
                </Text>
                {text ? <CommandBlock command={text} copiedTitle={t("routines.runCalls.copied")} /> : null}
              </View>
            );
          })
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  call: { gap: 4, marginTop: 8 },
  in: { paddingHorizontal: SCREEN_X, paddingTop: 4 },
  bold: { fontWeight: "600" },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1, minWidth: 0 },
  // On the cards' content column (their rows' 16 in from their side).
  head: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingTop: 8, paddingHorizontal: GROUPED_ROW.padX },
  gap: { height: 20 },
  block: { paddingHorizontal: GROUPED_ROW.padX, paddingVertical: 12, gap: 8 },
  strip: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 2 },
  note: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  runs: { paddingVertical: 6 },
  run: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingHorizontal: GROUPED_ROW.padX,
    paddingVertical: 8,
  },
  rail: { alignSelf: "stretch", alignItems: "center", width: NODE },
  // Centered on the outcome's first line (subhead, 20 tall).
  node: {
    width: NODE,
    height: NODE,
    borderRadius: 6,
    marginTop: (SUBHEAD_LINE - NODE) / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  dash: { width: 8, height: 1.7, borderRadius: 999 },
  stem: { flex: 1, width: 1.5, marginTop: 4, marginBottom: -12 },
  underline: { textDecorationLine: "underline" },
  pressed: { opacity: 0.6 },
  open: { marginTop: 2 },
  when: { paddingTop: 2 },
});
