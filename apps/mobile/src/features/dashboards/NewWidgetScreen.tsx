import {
  useAiStatusSince,
  useConfirmWidget,
  useDashboards,
  useHomeDashboard,
  useRemoveWidget,
  useTestWidget,
  useWidgetDraft,
  useWidgetSuggestions,
  WIDGET_STILL_MS,
  type Widget,
  type WidgetFormat,
  type WidgetSchedule,
  type WidgetSuggestion,
  widgetAiReady,
  widgetNeedsAi,
  widgetStepWords,
} from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import { taskClock } from "@agenteschat/client/lib/task-manager";
import {
  sizeToLayout,
  WIDGET_FORMATS,
  WIDGET_LIMITS,
  WIDGET_SCHEDULES,
  WIDGET_SIZES,
  type WidgetSize,
} from "@agenteschat/ui/widgets/spec";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import {
  Button,
  fieldText,
  GROUPED_ROW,
  GroupedField,
  GroupedFooter,
  GroupedList,
  GroupedRow,
  Icon,
  LIST_TIME,
  LineIcon,
  Locked,
  PressScale,
  Segmented,
  systemText,
  Text,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { boardHref } from "../links/logic";
import { useFailed } from "../routines/hooks";
import { SettingsPage, useUnsavedGuard } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { useDirectory, useNow, useOrgId } from "../shared/hooks";
import { goBack, successHaptic } from "../shared/parts";
import { closeAgentPick, openAgentPick } from "./agent-pick";
import { useAgentLook, useWidgetAiWay, useWidgetWords } from "./hooks";
import {
  asksInCard,
  confirmTitle,
  destinationsOf,
  HOME,
  newWidgetBarLabel as newWidgetAction,
  previewKind,
  realBoardId,
  sizeFor,
  testKeyOf,
  testPhase,
} from "./logic";
import { type PickItem, usePickMenu } from "./menu";
import { closeOptionPick, openOptionPick } from "./option-pick";
import { KindGlyph } from "./parts";
import { BuildingSweep, WidgetBody, WidgetCard } from "./WidgetView";

/** The longest ask and alert condition the server takes (ADR 0135). */
const PROMPT_MAX = 2000;
const CONDITION_MAX = 200;
/** The size's P · M · G at the end of its row: room for three finger-wide segments. */
const SIZE_CHOICE = 156;

/**
 * "New widget", pushed (never a sheet; ADR 0135). The card is the preview and holds only what it shows: its title and
 * the ask, typed inside it with the agent's suggestions under it while it is empty. Everything else is a row of the
 * list under the card, each a finger's target: who looks after it (a pushed screen), the format and how often it
 * updates (pick menus), the size (P · M · G), the alert (a switch, and its condition when on) and where it goes (when
 * there is a choice). The action sits at the screen's foot, over the keyboard: "Test with real data" has the
 * agent build a draft with real data in the card; then the ask folds into one line that opens it again, and "Add to
 * Home" (or "Add to <board>") confirms the draft. While it builds the card says the step its agent is in
 * and for how long, and Stop ends the build with the ask as it was typed. Changing the ask, the agent or the format
 * after a test marks it stale (Test again); a failed test says why, with Try again. Testing again or leaving deletes
 * the draft; leaving with an ask typed asks first. No field takes the focus as it opens (the ask does when its folded
 * line is tapped). `dashboardId`: the board it starts on (`home` for My Home).
 */
export function NewWidgetScreen({ dashboardId }: { dashboardId: string }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const dir = useDirectory();
  const widgetWords = useWidgetWords();
  const pick = usePickMenu();
  const list = useDashboards(orgId);
  const test = useTestWidget(orgId);
  const confirm = useConfirmWidget(orgId);
  const remove = useRemoveWidget(orgId);
  const agents = useMemo(() => dir.agents.filter((a) => canTalk(a)), [dir.agents]);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<WidgetSuggestion | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [format, setFormat] = useState<WidgetFormat>("auto");
  // Null until the person picks one: the size follows the kind (S for a number or a goal, M otherwise).
  const [size, setSize] = useState<WidgetSize | null>(null);
  const [schedule, setSchedule] = useState<WidgetSchedule>("hour");
  const [alert, setAlert] = useState(false);
  const [condition, setCondition] = useState("");
  const [dest, setDest] = useState(dashboardId);
  // The test: the draft it made (as it came back, until its live view loads), and what it was asked with.
  const [tested, setTested] = useState<{ widget: Widget; key: string } | null>(null);
  // The person's title; null keeps the agent's (it names the draft when the test is done).
  const [title, setTitle] = useState<string | null>(null);
  // The ask opened again after a test (its folded line tapped).
  const [editing, setEditing] = useState(false);
  // A test being sent, and when the build under way started.
  const [sending, setSending] = useState(false);
  const [since, setSince] = useState(0);
  // An ask typed and not on a board yet: a back swipe asks before it (and its draft) go.
  const leave = useUnsavedGuard(text.trim() !== "");
  // The first agent until the person picks one.
  useEffect(() => {
    const first = agents[0];
    if (!agentId && first) setAgentId(first.id);
  }, [agentId, agents]);

  // A draft nobody confirmed goes away with the screen (the server also sweeps old ones).
  const removeDraft = useRef(remove.mutate);
  useLayoutEffect(() => {
    removeDraft.current = remove.mutate;
  });
  // `run`: which test the screen waits for (one stopped before its draft came back is dropped when it does).
  const live = useRef({ draftId: null as string | null, confirmed: false, gone: false, run: 0 });
  useEffect(() => {
    live.current.gone = false;
    return () => {
      live.current.gone = true;
      closeAgentPick();
      closeOptionPick();
      const id = live.current.draftId;
      if (id && !live.current.confirmed) {
        live.current.draftId = null;
        removeDraft.current(id);
      }
    };
  }, []);

  const look = useAgentLook(agentId);
  const suggestions = useWidgetSuggestions(orgId, agentId);
  const destinations = destinationsOf(list.data);
  // A board asked for is only known once the list is: never fall back to My Home before it is.
  const destination = destinations.find((d) => d.id === dest) ?? (list.data ? destinations[0] : undefined);
  const home = useHomeDashboard(orgId, destination?.id === HOME);
  const target = destination ? realBoardId(destination.id, home.data?.id) : null;
  const where = destination?.home ? t("dashboards.home") : (destination?.title ?? "");

  const draftQ = useWidgetDraft(orgId, tested?.widget.id ?? null);
  // A draft that is gone (swept, or removed elsewhere) is no test any more.
  const draft: Widget | null = tested && !draftQ.isError ? (draftQ.data ?? tested.widget) : null;
  // Its agent has no AI: the test waits for one (no build started), and runs again once one is connected.
  const needsAi = Boolean(draft && widgetNeedsAi(draft));
  const aiWay = useWidgetAiWay(needsAi ? draft?.agentId : null, draft?.failure?.detail);
  const aiStatus = useAiStatusSince(orgId, needsAi);
  const aiBack = Boolean(draft && widgetAiReady(draft, aiStatus));
  const retested = useRef(false);
  const currentKey = testKeyOf(text, agentId, format);
  const phase = testPhase({ pending: sending, draft, testedKey: tested?.key ?? null, currentKey });
  const action = newWidgetAction(phase);
  const asking = asksInCard(phase, editing);
  // Once tested, the size follows what the agent built (unless one was picked).
  const kind = phase === "ok" && draft?.kind ? draft.kind : previewKind(format, picked?.kind ?? null);
  const sized = sizeFor(kind, size);
  const layout = sizeToLayout(sized);
  const asked = Boolean(text.trim() && agentId && target);
  const busy = sending || confirm.isPending;
  const ready = asked && !busy && phase !== "testing";

  const pickAgent = (id: string) => {
    if (id === agentId) return;
    setAgentId(id);
    setPicked(null);
  };
  // The agent's screen sends its choice back through this (the latest closure).
  const applyAgent = useRef(pickAgent);
  useLayoutEffect(() => {
    applyAgent.current = pickAgent;
  });
  const suggest = (s: WidgetSuggestion) => {
    setText(s.prompt || s.title);
    setPicked(s);
    setFormat("auto");
    if (s.alert) {
      setAlert(true);
      setCondition(s.alert);
    }
  };
  const type = (next: string) => {
    setText(next);
    if (picked && next !== (picked.prompt || picked.title)) setPicked(null);
  };
  const alertInput = { enabled: alert, condition: alert ? condition.trim() : "" };

  /** Test (and Test again, Try again): the previous draft goes, a new one is built with real data in the card. */
  const runTest = () => {
    if (!asked || !agentId || !target || busy) return;
    const previous = live.current.draftId;
    if (previous) removeDraft.current(previous);
    live.current.draftId = null;
    setTested(null);
    setEditing(false);
    const key = currentKey;
    live.current.run += 1;
    const mine = live.current.run;
    setSending(true);
    setSince(Date.now());
    test
      .mutateAsync({
        dashboardId: target,
        agentId,
        prompt: text.trim(),
        format,
        schedule,
        alert: alertInput,
        size: sized,
      })
      .then((widget) => {
        // Left or stopped while it was starting: nobody will confirm it.
        if (live.current.gone || live.current.run !== mine) {
          removeDraft.current(widget.id);
          return;
        }
        live.current.draftId = widget.id;
        setTested({ widget, key });
        setSending(false);
      })
      .catch((error: unknown) => {
        if (live.current.gone || live.current.run !== mine) return;
        setSending(false);
        failed(error);
      });
  };

  // Once per screen: a status the server still disagrees with can't test again and again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `runTest` changes each render; once its agent has an AI
  useEffect(() => {
    if (!aiBack || retested.current) return;
    retested.current = true;
    runTest();
  }, [aiBack]);

  /** Stop: the build ends (its draft goes, and its run with it) and the ask is back as it was typed. */
  const stop = () => {
    live.current.run += 1;
    const building = live.current.draftId;
    live.current.draftId = null;
    if (building) removeDraft.current(building);
    setSending(false);
    setTested(null);
  };

  /** Create: the tested draft goes on the board with the size, schedule, alert and title picked now. */
  const create = () => {
    if (phase !== "ok" || !draft || !target || busy) return;
    const name = confirmTitle(title, draft.title);
    live.current.confirmed = true;
    confirm.mutate(
      {
        widgetId: draft.id,
        dashboardId: target,
        size: sized,
        schedule,
        alert: alertInput,
        ...(name ? { title: name } : {}),
      },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("dashboards.newWidget.created", { where }), agentId: draft.agentId });
          leave();
          // From the board it goes on: back to it; else to that board.
          if (destination && destination.id === dashboardId) goBack();
          else router.replace(boardHref(destination?.id));
        },
        onError: (error) => {
          live.current.confirmed = false;
          failed(error);
        },
      },
    );
  };

  /** Where it goes: the boards, pushed (the choice comes back through `option-pick`). */
  const openDestinations = () => {
    openOptionPick({
      title: t("dashboards.newWidget.destination"),
      value: destination?.id ?? null,
      options: destinations.map((d) => ({
        key: d.id,
        icon: d.home ? "home" : "chart",
        label: d.home ? t("dashboards.home") : (d.title ?? ""),
      })),
      apply: setDest,
    });
    router.push("/option-pick");
  };
  /** "Who looks after it": its own screen, pushed (the choice comes back through `agent-pick`). */
  const openAgents = () => {
    if (agents.length === 0) return;
    openAgentPick({ agentId, apply: (id) => applyAgent.current(id) });
    router.push("/agent-pick");
  };
  const openFormats = () =>
    pick(
      t("dashboards.newWidget.format"),
      WIDGET_FORMATS.map(
        (f): PickItem<WidgetFormat> => ({
          key: f,
          label: t(`widgets.kinds.${f}`),
          hint:
            f === "auto"
              ? t("mobile.dashboards.formatAuto", { name: look.name })
              : t(`dashboards.newWidget.formatHints.${f}`),
          leading: <KindGlyph kind={f} size={20} color={c.muted} />,
        }),
      ),
      format,
      setFormat,
    );
  // How often: the schedules' words only (what it spends is not this menu's business).
  const openSchedules = () =>
    pick(
      t("dashboards.newWidget.updates"),
      WIDGET_SCHEDULES.map(
        (s): PickItem<WidgetSchedule> => ({
          key: s,
          label: t(`widgets.schedules.${s}`),
          leading: <Icon name="clock" size={18} color={c.muted} />,
        }),
      ),
      schedule,
      setSchedule,
    );

  const suggestionList = suggestions.data?.suggestions ?? [];

  // ── The card's header: the agent's face, the title, the check of a good test.
  const titleValue = title ?? draft?.title ?? "";
  const head = (
    <Locked when={busy} style={styles.head}>
      {agentId ? <AgentFace agentId={agentId} size={16} live={false} /> : null}
      <TextInput
        value={titleValue}
        onChangeText={setTitle}
        placeholder={t("dashboards.newWidget.titleField")}
        placeholderTextColor={c.faint}
        accessibilityLabel={t("mobile.dashboards.widget.title")}
        maxLength={WIDGET_LIMITS.title}
        returnKeyType="done"
        style={[styles.titleInput, { color: c.ink2 }]}
      />
      {phase === "ok" ? (
        <View
          style={[styles.okBadge, { backgroundColor: c.plate }]}
          accessible
          accessibilityLabel={t("mobile.dashboards.newWidget.realData")}
        >
          <Icon name="check" size={13} color={c.ink2} />
        </View>
      ) : null}
    </Locked>
  );

  // ── Between the header and the data, after a test: the ask folded into a line that opens it again.
  const above = asking ? null : (
    <Locked when={busy} style={styles.gap8}>
      <Pressable
        onPress={() => setEditing(true)}
        accessibilityRole="button"
        accessibilityLabel={t("mobile.dashboards.newWidget.editAsk")}
        accessibilityHint={text.trim()}
        disabled={phase === "testing"}
        style={({ pressed }) => [styles.asked, pressed && styles.pressed]}
      >
        <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
          {t("mobile.dashboards.newWidget.asked", { ask: text.trim() })}
        </Text>
        <Icon name="pen" size={13} color={c.muted} />
      </Pressable>
      {phase === "stale" ? (
        <Text variant="caption" style={[styles.semibold, { color: c.warn }]}>
          {t("dashboards.newWidget.stale")}
        </Text>
      ) : null}
    </Locked>
  );

  // ── The data's place: the ask while typing it, the build, the failure, or the draft (the card's own drawing).
  let body: ReactNode;
  if (asking) {
    body = (
      <Locked when={busy} style={styles.gap10}>
        <TextInput
          value={text}
          onChangeText={type}
          multiline
          textAlignVertical="top"
          placeholder={t("dashboards.newWidget.what")}
          placeholderTextColor={c.faint}
          accessibilityLabel={t("dashboards.newWidget.what")}
          accessibilityHint={t("dashboards.newWidget.whatPlaceholder")}
          maxLength={PROMPT_MAX}
          autoFocus={editing}
          style={[styles.ask, { color: c.ink }]}
        />
        {!text.trim() && phase === "untested" && suggestionList.length > 0 ? (
          <View style={styles.suggestions}>
            {suggestionList.map((s) => (
              <PressScale
                key={s.title}
                onPress={() => suggest(s)}
                accessibilityRole="button"
                fill={false}
                style={styles.suggestionWrap}
                contentStyle={[styles.suggestion, { backgroundColor: c.chip }]}
              >
                <KindGlyph kind={s.kind} size={13} color={c.muted} />
                <Text variant="footnote" numberOfLines={1} style={[styles.semibold, { color: c.ink2 }]}>
                  {s.title}
                </Text>
              </PressScale>
            ))}
          </View>
        ) : null}
        {editing && draft?.spec ? (
          <View style={phase === "stale" ? styles.staleData : null}>
            <WidgetBody spec={draft.spec} status={draft.status} agentId={draft.agentId} big={sized === "l"} />
          </View>
        ) : null}
      </Locked>
    );
  } else if (phase === "testing") {
    // The test's run waits (its plan, its budget, its computer): what for, in place of the step it is in.
    const waits = draft ? widgetWords.wait(draft) : "";
    body = (
      <View style={styles.gap10}>
        <BuildingSweep
          color={look.color}
          text={waits || widgetStepWords(t, draftQ.data?.step)}
          height={44}
          still={Boolean(waits)}
        />
        <BuildClock since={since} onStop={stop} waiting={Boolean(waits)} />
      </View>
    );
  } else if (phase === "failed" && draft && needsAi) {
    body = (
      <View style={styles.failed}>
        {/* No icon before it: it wraps, and would start in from the lines under it. */}
        <Text variant="footnote" style={{ color: c.warn }}>
          {widgetWords.failure(draft)}
        </Text>
        <Text variant="footnote" tone="muted">
          {t("widgets.needsAi.body", { name: look.name })}
        </Text>
        {aiWay && "locked" in aiWay ? (
          <Text variant="footnote" tone="muted">
            {aiWay.locked}
          </Text>
        ) : null}
        {aiWay && "connect" in aiWay ? (
          <Button size="sm" variant="secondary" label={t("noAi.action")} onPress={aiWay.connect} />
        ) : null}
      </View>
    );
  } else if (phase === "failed" && draft) {
    body = (
      <View style={styles.failed}>
        <View style={styles.failedLine}>
          {/* On the reason's first line (at the row's top it sat above the letters). */}
          <LineIcon variant="footnote" name="info" size={16} color={c.warn} />
          <Text variant="footnote" style={[styles.grow, { color: c.warn }]}>
            {t("dashboards.newWidget.testFailed", { reason: widgetWords.failure(draft) })}
          </Text>
        </View>
        <Button size="sm" variant="secondary" label={t("dashboards.newWidget.tryAgain")} onPress={runTest} />
      </View>
    );
  } else if (phase === "stale" && draft?.spec) {
    body = (
      <View style={styles.staleData}>
        <WidgetBody spec={draft.spec} status={draft.status} agentId={draft.agentId} big={sized === "l"} />
      </View>
    );
  }
  // Else (a good test): undefined, so the card draws the draft itself (its trend edge to edge).

  // ── At the foot, over the keyboard: test with real data, test again, or add the tested draft where it goes.
  const adding = action === "create";
  const actionLabel = adding
    ? destination?.home
      ? t("mobile.dashboards.newWidget.addHome")
      : t("mobile.dashboards.newWidget.addTo", { where })
    : phase === "testing"
      ? t("dashboards.newWidget.testingShort")
      : action === "test"
        ? t("mobile.dashboards.newWidget.testReal")
        : t("dashboards.newWidget.testAgain");
  const bottom = (
    <Button
      variant="primary"
      wide
      label={actionLabel}
      loading={confirm.isPending}
      disabled={adding ? busy || !target : !ready}
      onPress={adding ? create : runTest}
    />
  );

  return (
    <SettingsPage title={t("dashboards.newWidget.title")} bottom={bottom}>
      <WidgetCard
        big={sized === "l"}
        widget={{
          title: titleValue,
          kind: draft?.kind ?? kind,
          spec: draft?.spec ?? null,
          status: draft?.status ?? "ok",
          agentId: agentId ?? "",
          refreshedAt: draft?.refreshedAt ?? null,
          schedule,
          w: 2,
          h: layout.h,
        }}
        head={head}
        above={above}
        body={body}
        footer={null}
      />
      {phase === "ok" && draft ? (
        <Text variant="caption" tone="faint" style={styles.caption}>
          {t("dashboards.newWidget.tested", {
            when: draft.refreshedAt ? widgetWords.ago(draft.refreshedAt) : "",
          })}
        </Text>
      ) : null}
      {agents.length === 0 && !dir.loading ? <GroupedFooter>{t("dashboards.newWidget.noAgents")}</GroupedFooter> : null}

      {/* What the card doesn't show, one row each: who looks after it and its format stay while it builds. */}
      <View style={styles.gap} />
      <Locked when={busy}>
        <GroupedList>
          <GroupedRow
            key="who"
            {...(agentId ? { leading: <AgentFace agentId={agentId} size={30} live={false} /> } : {})}
            label={t("dashboards.newWidget.who")}
            value={look.name || t("dashboards.newWidget.theAgent")}
            chevron
            disabled={agents.length === 0 || phase === "testing"}
            onPress={openAgents}
          />
          <GroupedRow
            key="format"
            label={t("dashboards.newWidget.format")}
            value={t(`widgets.kinds.${format}`)}
            menu
            disabled={phase === "testing"}
            onPress={openFormats}
          />
          <SizeRow key="size" value={sized} onChange={setSize} />
          <GroupedRow
            key="updates"
            label={t("dashboards.newWidget.updates")}
            value={t(`widgets.schedules.${schedule}`)}
            menu
            onPress={openSchedules}
          />
          <GroupedRow
            key="alert"
            label={t("widgets.alert.label")}
            labelLines={2}
            toggle={alert}
            onPress={() => setAlert((v) => !v)}
          />
          {alert ? (
            <GroupedField key="condition" label={t("widgets.alert.condition")}>
              <TextInput
                value={condition}
                onChangeText={setCondition}
                placeholder={t("widgets.alert.placeholder")}
                placeholderTextColor={c.faint}
                accessibilityLabel={t("widgets.alert.condition")}
                accessibilityHint={t("widgets.alert.hint")}
                maxLength={CONDITION_MAX}
                returnKeyType="done"
                style={[styles.conditionInput, { color: c.ink }]}
              />
            </GroupedField>
          ) : null}
          {/* Only when there is a choice: with My Home alone, nothing to pick. */}
          {destinations.length > 1 ? (
            <GroupedRow
              key="destination"
              label={t("dashboards.newWidget.destination")}
              value={where}
              chevron
              onPress={openDestinations}
            />
          ) : null}
        </GroupedList>
      </Locked>
    </SettingsPage>
  );
}

/** The size as a row of the list: its name, and P · M · G at its end. */
function SizeRow({ value, onChange }: { value: WidgetSize; onChange: (size: WidgetSize) => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.sizeRow}>
      <Text variant="body" numberOfLines={1} style={styles.grow}>
        {t("widgets.sizes.label")}
      </Text>
      <View style={styles.sizeChoice}>
        <Segmented
          wide
          items={WIDGET_SIZES.map((s) => ({ key: s, label: t(`widgets.sizes.${s}`) }))}
          value={value}
          onChange={(k) => onChange(k as WidgetSize)}
        />
      </View>
    </View>
  );
}

/**
 * Under a build: how long it has taken, Stop at the row's end, and past a while one quiet line that it is still at
 * it (not while its run waits: the sweep says what for). Its own component, so only it redraws each second.
 */
function BuildClock({ since, onStop, waiting }: { since: number; onStop: () => void; waiting: boolean }) {
  const { t } = useTranslation();
  const elapsed = Math.max(0, useNow(1000) - since);
  return (
    <View style={styles.gap8}>
      {!waiting && elapsed >= WIDGET_STILL_MS ? (
        <Animated.View entering={FadeIn.duration(200)}>
          <Text variant="caption" tone="faint">
            {t("dashboards.newWidget.stillWorking")}
          </Text>
        </Animated.View>
      ) : null}
      <View style={styles.buildFoot}>
        <Text variant="footnote" tone="muted" accessibilityRole="timer" style={LIST_TIME}>
          {taskClock(elapsed)}
        </Text>
        <Button size="sm" variant="secondary" label={t("dashboards.newWidget.stop")} onPress={onStop} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
  titleInput: { flex: 1, minWidth: 0, paddingVertical: 4, ...fieldText("footnote", "600") },
  okBadge: { width: 22, height: 22, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  ask: { minHeight: 56, paddingTop: 4, paddingBottom: 2, ...systemText("body", "500") },
  suggestions: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  suggestionWrap: { maxWidth: "100%" },
  suggestion: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 30,
    maxWidth: "100%",
    paddingHorizontal: 10,
    borderRadius: 15,
  },
  asked: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0, paddingVertical: 4 },
  staleData: { opacity: 0.38 },
  failed: { gap: 10, alignItems: "flex-start" },
  failedLine: { flexDirection: "row", alignItems: "flex-start", gap: 8, alignSelf: "stretch" },
  conditionInput: { flex: 1, minWidth: 0, paddingVertical: 12, ...fieldText("callout") },
  sizeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
    paddingVertical: 6,
  },
  sizeChoice: { width: SIZE_CHOICE },
  buildFoot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  caption: { textAlign: "center", paddingTop: 8 },
  semibold: { fontWeight: "600", flexShrink: 1 },
  shrink: { flexShrink: 1, minWidth: 0 },
  grow: { flex: 1, minWidth: 0 },
  gap: { height: 20 },
  pressed: { opacity: 0.6 },
  gap8: { gap: 8 },
  gap10: { gap: 10 },
});
