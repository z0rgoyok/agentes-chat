import {
  useAskWidgetChange,
  useBuildOnceAi,
  useDesktopStatus,
  useRefreshWidget,
  useRemoveWidget,
  useUpdateWidget,
  useWidget,
  useWidgetLacksAi,
  type WidgetDetail,
  type WidgetSchedule,
  type WidgetUpdate,
  type WidgetWait,
  widgetCardStatus,
  widgetWaitFix,
  widgetWaiting,
} from "@agenteschat/client";
import { managesAgent } from "@agenteschat/client/lib/audience";
import { upcomingAt, whenAt } from "@agenteschat/client/lib/format";
import { plainInline } from "@agenteschat/client/lib/markdown";
import { WIDGET_SCHEDULES } from "@agenteschat/ui/widgets/spec";
import { LinearGradient } from "expo-linear-gradient";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, RefreshControl, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  Button,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  LineIcon,
  Locked,
  PressScale,
  padPastFold,
  systemText,
  Text,
  useFoldRoom,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { openAgentEdit } from "../agents/AgentEditScreen";
import { openAgentAi } from "../ai/AgentAiScreen";
import { openComputer } from "../computer/AgentComputerRow";
import { boardHref, routineHref } from "../links/logic";
import { useFailed } from "../routines/hooks";
import { useDirectory, useOrgId, useOwnsAgent, usePullRefresh } from "../shared/hooks";
import { FocusLive, goBack, PushedHeader, successHaptic } from "../shared/parts";
import { useAgentLook, useWidgetAiWay, useWidgetWords } from "./hooks";
import { HOME, shownWidgetTitle } from "./logic";
import { usePickMenu } from "./menu";
import { MissingScreen } from "./parts";
import { widgetEditHref } from "./WidgetEditScreen";
import { WidgetCard } from "./WidgetView";

/** Rows of the history shown (the server keeps the latest 20). */
const HISTORY_SHOWN = 10;

/**
 * A widget, pushed from its board (ADR 0135), its name in the compact bar (a detail, not a list: no large title) and
 * not again in its card, which draws just its data: the widget big, why it didn't update (with Resolve) or what its refresh
 * waits for (with Continue now on a pause), its title (renamed on a screen of its own; a person's title is kept: the
 * agent no longer changes it), how it updates (its schedule, picked in the app's picker; the alert and its condition,
 * on a screen of its own; what the agent reads; its routine), the latest updates, "Update now" and the remove; at the
 * bottom, "Ask <agent> for a change" goes to the agent, who redoes it in place.
 */
export function WidgetScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const q = useWidget(orgId, id);
  const w = q.data;
  if (!w)
    return (
      <MissingScreen
        title=""
        state={q.isLoading ? "loading" : q.isError ? "failed" : "gone"}
        onRetry={() => void q.refetch()}
        gone={t("dashboards.errors.widgetNotFound")}
      />
    );
  return <Detail key={w.id} widget={w} refetch={q.refetch} />;
}

function Detail({ widget: w, refetch }: { widget: WidgetDetail; refetch: () => Promise<unknown> }) {
  const { t, i18n } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const words = useWidgetWords();
  const look = useAgentLook(w.agentId);
  const pull = usePullRefresh(refetch);
  const refresh = useRefreshWidget(orgId);
  const update = useUpdateWidget(orgId);
  const remove = useRemoveWidget(orgId);
  useBuildOnceAi(orgId, w, w.canEdit);
  const needsAi = useWidgetLacksAi(orgId, w);
  const aiWay = useWidgetAiWay(needsAi ? w.agentId : null, w.failure?.detail);
  const pick = usePickMenu();
  const home = w.dashboard.kind === "home";
  // A refresh that waits stands still: Update now on it goes on now, or says why it can't.
  const waiting = widgetWaiting(w, words.now);
  const status = widgetCardStatus(w, words.now);
  const busy = status === "building" || status === "updating";
  const shown = shownWidgetTitle(w.title, w.kind, (k) => t(k));

  const updateNow = () =>
    refresh.mutate(w.id, {
      onSuccess: () => toast({ title: t("mobile.dashboards.widget.refreshing", { name: look.name }) }),
      onError: failed,
    });
  const setSchedule = (schedule: WidgetSchedule) => {
    if (schedule === w.schedule) return;
    update.mutate(
      { widgetId: w.id, schedule },
      {
        onSuccess: () => {
          successHaptic();
          const when = t(`widgets.schedulesInline.${schedule}`);
          toast({ title: t("mobile.dashboards.widget.scheduleSaved", { schedule: when }) });
        },
        onError: failed,
      },
    );
  };
  // How often: five schedules, the app's picker (as New widget's), the one in use checked.
  const pickSchedule = () =>
    pick(
      t("dashboards.newWidget.updates"),
      WIDGET_SCHEDULES.map((s) => ({ key: s, label: t(`widgets.schedules.${s}`) })),
      w.schedule,
      setSchedule,
    );
  // The same words as the web's confirmation (ADR 0135): its routine stops and its history goes.
  const confirmRemove = () =>
    Alert.alert(
      t("widgets.removeConfirm.title", { title: shown }),
      w.schedule === "manual"
        ? t("widgets.removeConfirm.textManual")
        : t("widgets.removeConfirm.textRoutine", { name: look.name || t("channel.unknownAgent") }),
      [
        { text: t("mobile.common.cancel"), style: "cancel" },
        {
          text: t("widgets.removeConfirm.confirm"),
          style: "destructive",
          onPress: () =>
            remove.mutate(w.id, {
              onSuccess: () => {
                successHaptic();
                toast({ title: t("mobile.dashboards.widget.removed") });
                goBack();
              },
              onError: failed,
            }),
        },
      ],
    );

  const alertLine = w.alert.enabled
    ? w.alert.condition
      ? t("widgets.alert.line", { condition: w.alert.condition })
      : t("widgets.alert.lineAny")
    : t("widgets.alert.none");
  const next = w.nextRunAt
    ? t("widgets.panel.next", { name: look.name, when: upcomingAt(t, i18n.language, w.nextRunAt) })
    : t("widgets.panel.noRoutine");
  const history = w.history.slice(0, HISTORY_SHOWN);
  const historyLabel = (u: WidgetUpdate) =>
    u.status === "ok" ? plainInline(u.summary ?? "") || t("widgets.panel.updated") : t("widgets.status.failed");
  const historyNote = (u: WidgetUpdate) => {
    const notes = [
      u.alert ? t("widgets.panel.alerted", { text: u.alert }) : null,
      u.change ? t("widgets.panel.changed", { text: u.change }) : null,
    ];
    return notes.filter(Boolean).join(" · ");
  };
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={shown}
        solid={false}
        grouped
        {...(w.canEdit
          ? {
              actions: [
                {
                  icon: "play" as const,
                  sf: "arrow.clockwise" as const,
                  label: t("widgets.menu.refresh"),
                  disabled: busy,
                  onPress: updateNow,
                },
              ],
            }
          : {})}
      />
      <FocusLive>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
          // The ask at the bottom: the keyboard drags away with the page, and the page's end clears it.
          keyboardDismissMode="interactive"
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: insets.bottom + (w.canEdit ? 96 : 28) }}
        >
          <View style={styles.in}>
            {/* Who looks after it, first under the bar (as a board's line), not as a subtitle in the bar. */}
            <Text variant="footnote" tone="muted" style={styles.cares}>
              {t("mobile.dashboards.widget.caresFor", { name: look.name })}
            </Text>
            <WidgetCard
              big
              // Its name is the bar's: the card under it draws the data alone.
              head={null}
              widget={{
                title: w.title,
                kind: w.kind,
                spec: w.spec,
                status: w.status,
                agentId: w.agentId,
                refreshedAt: w.refreshedAt,
                schedule: w.schedule,
                w: 2,
                needsAi,
                wait: w.wait,
              }}
            />
            {waiting?.code === "usage_pause" && w.canEdit ? (
              <View style={styles.failure}>
                <Text variant="footnote" tone="muted" style={styles.grow}>
                  {t(
                    !waiting.canContinue
                      ? "usageCard.forbidden"
                      : waiting.source === "budget"
                        ? "usageCard.hintBudget"
                        : "usageCard.hint",
                  )}
                </Text>
                <Button
                  size="sm"
                  variant="secondary"
                  label={t("usageCard.continue")}
                  loading={refresh.isPending}
                  disabled={!waiting.canContinue}
                  onPress={updateNow}
                />
              </View>
            ) : waiting ? (
              <WaitFix agentId={w.agentId} wait={waiting} />
            ) : null}
            {w.status === "failed" && w.failure ? (
              <View style={styles.failure}>
                <View style={styles.failureLine}>
                  <LineIcon name={needsAi ? "bolt" : "info"} size={13} color={c.warn} variant="footnote" />
                  <View style={styles.grow}>
                    <Text variant="footnote" style={{ color: c.warn }}>
                      {words.failure(w)}
                    </Text>
                    {aiWay && "locked" in aiWay ? (
                      <Text variant="footnote" tone="muted">
                        {aiWay.locked}
                      </Text>
                    ) : null}
                  </View>
                </View>
                {/* No AI to build with: Connect (or who can), never Resolve, which comes back once one is there. */}
                {needsAi ? (
                  aiWay && "connect" in aiWay ? (
                    <Button size="sm" variant="secondary" label={t("noAi.action")} onPress={aiWay.connect} />
                  ) : null
                ) : w.canEdit ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    label={t("widgets.failure.resolve")}
                    loading={refresh.isPending}
                    onPress={updateNow}
                  />
                ) : null}
              </View>
            ) : null}

            {w.canEdit ? (
              <>
                <View style={styles.gap} />
                <GroupedList>
                  <GroupedRow
                    icon="pen"
                    label={t("mobile.dashboards.widget.title")}
                    value={shown}
                    chevron
                    onPress={() => router.push(widgetEditHref(w.id, "title"))}
                  />
                </GroupedList>
              </>
            ) : null}

            <GroupedHeader>{t("widgets.panel.how")}</GroupedHeader>
            <GroupedList>
              <GroupedRow
                icon="clock"
                label={t(`widgets.schedules.${w.schedule}`)}
                sub={next}
                subLines={2}
                menu={w.canEdit}
                {...(w.canEdit ? { onPress: pickSchedule } : {})}
              />
              <GroupedRow
                icon="bell"
                label={alertLine}
                labelLines={2}
                sub={t("widgets.alert.where")}
                chevron={w.canEdit}
                {...(w.canEdit ? { onPress: () => router.push(widgetEditHref(w.id, "alert")) } : {})}
              />
              {w.sources.length > 0 ? (
                <GroupedRow
                  icon="server"
                  label={w.sources.join(" · ")}
                  labelLines={2}
                  sub={t("widgets.panel.reads", { name: look.name })}
                />
              ) : null}
              {w.routineId && w.schedule !== "manual" ? (
                <GroupedRow
                  icon="list"
                  label={t("mobile.dashboards.widget.routine")}
                  chevron
                  onPress={() => router.push(routineHref(w.routineId))}
                />
              ) : null}
              <GroupedRow
                icon="chart"
                label={home ? t("dashboards.home") : w.dashboard.title}
                sub={t("mobile.dashboards.widget.onBoard")}
                chevron
                onPress={() => router.push(boardHref(home ? HOME : w.dashboard.id))}
              />
            </GroupedList>

            <GroupedHeader>{t("widgets.panel.history")}</GroupedHeader>
            <GroupedList>
              {history.length === 0 ? (
                <GroupedRow label={t("widgets.panel.noHistory")} faint />
              ) : (
                history.map((u) => (
                  <GroupedRow
                    key={u.id}
                    label={historyLabel(u)}
                    labelLines={2}
                    sub={whenAt(t, i18n.language, u.at)}
                    belowText={historyNote(u)}
                  />
                ))
              )}
            </GroupedList>

            {w.canEdit ? (
              <>
                <View style={styles.gap} />
                <GroupedList>
                  <GroupedRow
                    icon="trash"
                    label={home ? t("widgets.menu.removeHome") : t("widgets.menu.removeBoard")}
                    danger
                    disabled={remove.isPending}
                    onPress={confirmRemove}
                  />
                </GroupedList>
              </>
            ) : null}
          </View>
        </ScrollView>
      </FocusLive>
      {w.canEdit ? <AskChange widget={w} name={look.name} /> : null}
    </View>
  );
}

/**
 * What ends a widget's wait sooner, under it, for who may do it (`widgetWaitFix`): the agent's budget or AI on its
 * screens, or its computer for whoever may watch it.
 */
function WaitFix({ agentId, wait }: { agentId: string; wait: WidgetWait }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const dir = useDirectory();
  // Its owner, or one who holds the role that answers for it (ADR 0085, addendum of 2026-11-21).
  const owns = useOwnsAgent();
  const owner = owns(dir.anyAgent(agentId));
  // Its budget for who manages the agent (the server's `canManage`); its AI for them and its owner.
  const fix = widgetWaitFix(wait, { admin: managesAgent(dir.agentById.get(agentId)), owner });
  const watches = useDesktopStatus(orgId, agentId, { enabled: fix === "openComputer" }).isSuccess;
  if (!fix || (fix === "openComputer" && !watches)) return null;
  const go = fix === "openComputer" ? openComputer : fix === "raiseBudget" ? openAgentEdit : openAgentAi;
  return (
    <View style={styles.failure}>
      <Button
        size="sm"
        variant="secondary"
        label={t(fix === "openComputer" ? "queue.openComputer" : `usageCard.${fix}`)}
        onPress={() => go(agentId)}
      />
    </View>
  );
}

/**
 * "Ask Theo for a change": a field at the bottom; what is sent goes to the agent, who redoes the widget in place. While
 * the workspace is being deleted it says why it takes none, as a conversation does (ADR 0088 §7). Folded like a book,
 * the field keeps to the half past the fold, never across it (ADR 0212); its fade still spans the screen.
 */
function AskChange({ widget: w, name }: { widget: WidgetDetail; name: string }) {
  const { t } = useTranslation();
  const { colors: c, shadows } = useTheme();
  const insets = useSafeAreaInsets();
  const foldSide = useFoldRoom();
  const { orgId, org } = useOrg();
  const toast = useToast();
  const failed = useFailed();
  const ask = useAskWidgetChange(orgId);
  const [text, setText] = useState("");
  const send = () => {
    const words = text.trim();
    if (!words || ask.isPending) return;
    ask.mutate(
      { widgetId: w.id, text: words },
      {
        onSuccess: () => {
          successHaptic();
          setText("");
          toast({ title: t("widgets.panel.sent", { name }), agentId: w.agentId });
        },
        onError: failed,
      },
    );
  };
  const ready = text.trim().length > 0 && !ask.isPending;
  return (
    <KeyboardStickyView offset={{ opened: insets.bottom }} style={styles.dock}>
      <View style={[styles.box, { paddingBottom: insets.bottom + 8 }, foldSide && padPastFold(foldSide, 12)]}>
        <LinearGradient
          pointerEvents="none"
          colors={[`${c.grouped}00`, c.grouped]}
          locations={[0, 0.3]}
          style={StyleSheet.absoluteFill}
        />
        {org?.deletion ? (
          <Text variant="footnote" tone="muted" style={styles.readOnly}>
            {t("deleting.composer")}
          </Text>
        ) : (
          <Locked when={ask.isPending}>
            <View style={[styles.field, { backgroundColor: c.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder={t("widgets.menu.change", { name })}
                placeholderTextColor={c.faint}
                accessibilityLabel={t("widgets.panel.ask")}
                multiline
                maxLength={1000}
                style={[styles.input, systemText("body"), { color: c.ink }]}
              />
              <PressScale
                to={0.9}
                onPress={send}
                disabled={!ready}
                accessibilityRole="button"
                accessibilityLabel={t("widgets.panel.send")}
                style={[styles.send, { backgroundColor: ready ? c.ink : c.plate }]}
                contentStyle={styles.sendIn}
              >
                <Icon name="send" size={18} color={ready ? c.bg : c.faint} />
              </PressScale>
            </View>
          </Locked>
        )}
      </View>
    </KeyboardStickyView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16 },
  cares: { paddingHorizontal: 4, paddingTop: 8, marginBottom: 10 },
  grow: { flex: 1, minWidth: 0 },
  failure: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4, paddingTop: 10 },
  // The icon on the reason's first line when it wraps (the button stays centered beside the reason).
  failureLine: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "flex-start", gap: 8 },
  gap: { height: 20 },
  dock: { position: "absolute", left: 0, right: 0, bottom: 0 },
  box: { paddingHorizontal: 12, paddingTop: 16 },
  field: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
    minHeight: 48,
    borderRadius: 24,
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 6,
  },
  input: { flex: 1, maxHeight: 120, paddingTop: 6, paddingBottom: 6 },
  // As a conversation's line in place of its composer.
  readOnly: { textAlign: "center", paddingHorizontal: 16, paddingVertical: 12 },
  send: { width: 36, height: 36, borderRadius: 18 },
  sendIn: { alignItems: "center", justifyContent: "center" },
});
