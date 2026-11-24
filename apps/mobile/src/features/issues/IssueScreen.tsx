import {
  type Actor,
  ApiError,
  type Issue,
  type IssuePriority,
  type IssueStatus,
  keys,
  useAiStatus,
  useApi,
  useChannels,
  useDms,
  useIssue,
  useIssueAction,
  useIssueColumns,
  useTaskUnread,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { capitalize, dueLabel, relativeTime } from "@agenteschat/client/lib/format";
import { isGithubLink } from "@agenteschat/client/lib/github-link";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { webUrl } from "@agenteschat/client/lib/guards";
import {
  assigneeNames,
  canDeleteIssue,
  conversationLine,
  deleteIssueText,
  isOpen,
  PRIORITIES,
  STATUSES,
} from "@agenteschat/client/lib/issues";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { shownSteps } from "@agenteschat/client/lib/work";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeIn, LayoutAnimationConfig, LinearTransition } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  Button,
  Disclosure,
  EmptyState,
  GroupedHeader,
  type HeaderMenuItem,
  Icon,
  type IconName,
  LineIcon,
  Locked,
  PixelOrbit,
  PressScale,
  RowPressable,
  SCREEN_X,
  SkeletonList,
  Text,
  useReducedMotion,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { openConnectAi } from "../ai/NoAiCard";
import { MessageText } from "../chat/MessageText";
import { IssueWorkLine, useShareWork } from "../chat/WorkLine";
import { openFile } from "../files/open";
import { chatHref } from "../links/logic";
import { type ActionChoice, chooseAction, confirmAction } from "../settings/parts";
import { Face } from "../shared/Face";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId, useNow, useOrgId, usePullRefresh } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { SheetTitle } from "../shared/PromptForm";
import {
  errorHaptic,
  FocusLive,
  goBack,
  MentionCount,
  PushedHeader,
  successHaptic,
  tapHaptic,
  useSurface,
} from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { TextArea } from "../shared/TextArea";
import { useWhoSeesLabel } from "../shared/WhoSees";
import { IssueActivityFeed } from "./IssueActivity";
import {
  columnOfIssue,
  criteriaProgress,
  DUE_CHOICES,
  dueDateOf,
  issueState,
  minutesSince,
  taskConversationHref,
  workLines,
} from "./logic";
import { AssigneeFace, GithubChip, ProjectDot, PropChip, useColumnLabel, useStepText } from "./parts";
import { firstAgentAdded, openTaskPick, type TaskPick } from "./pick";
import { useStartAgent } from "./useStartAgent";

/**
 * One task (called "tarefa" in the app): its number in the bar, the big title under it (the number said once, in the
 * bar), where it came from, its fields as the web's strip (each opens
 * its picker); the agent's card with its live steps; its conversation; the description, the acceptance criteria
 * (checked here too), what is linked (the source message, Drive files, PRs), its sub-issues and its activity. The bar:
 * the number, Concluir (Reabrir) and "…" (`IssueBar`). While it loads, the rows' shape; gone or out of reach, it says
 * so; a failed load offers to try again.
 */
export function IssueScreen({ number, focusId = null }: { number: number; focusId?: string | null }) {
  return (
    <SheetHostProvider>
      <IssueView number={number} focusId={focusId} />
    </SheetHostProvider>
  );
}

function IssueView({ number, focusId }: { number: number; focusId: string | null }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const issue = useIssue(orgId, number);
  const qc = useQueryClient();
  // Pulling down brings the activity too (comments, events), not only the task.
  const pull = usePullRefresh(() =>
    Promise.all([
      issue.refetch(),
      issue.data ? qc.refetchQueries({ queryKey: keys.issueActivity(orgId, issue.data.id) }) : null,
    ]),
  );
  // Out of reach since it opened (someone changed who sees it): what's on screen goes.
  const i = issue.error instanceof ApiError && issue.error.status === 404 ? undefined : issue.data;
  const openConversation = useOpenConversation();
  // A notice or a link named a message of its conversation: straight there, once.
  const focused = useRef(false);
  useEffect(() => {
    if (!i || !focusId || focused.current) return;
    focused.current = true;
    openConversation(i, focusId);
  }, [i, focusId, openConversation]);
  if (!i) {
    const gone = issue.error instanceof ApiError && issue.error.status === 404;
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <PushedHeader title={`#${number}`} solid={false} />
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.scroll}>
          {gone ? (
            <EmptyState size="page" icon="issue" title={t("issues.notFound")} />
          ) : issue.isError ? (
            <LoadFailed onRetry={() => void issue.refetch()} />
          ) : (
            // Loading: the rows' own shape, never a spinner.
            <SkeletonList rows={3} />
          )}
        </ScrollView>
      </View>
    );
  }
  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <IssueBar issue={i} />
      <FocusLive>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
          contentContainerStyle={styles.scroll}
        >
          <Head issue={i} />
          <WorkCard issue={i} />
          <IssueWorkLine issue={i} style={styles.section} />
          <ConversationRow issue={i} onOpen={() => openConversation(i)} />
          <Description issue={i} />
          <Criteria issue={i} />
          <Linked issue={i} />
          <SubIssues issue={i} />
          <IssueActivityFeed issue={i} />
        </ScrollView>
      </FocusLive>
    </View>
  );
}

/** Opens the task's conversation (ADR 0145), made on first use, at `messageId` when one is named. */
function useOpenConversation() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const api = useApi();
  const toast = useToast();
  return useCallback(
    (i: Issue, messageId?: string | null) => {
      void (async () => {
        try {
          const at = i.conversation ?? (await api.issues.conversation(orgId, i.id));
          router.push(taskConversationHref(at, messageId));
        } catch {
          toast({ title: t("mobile.app.failed"), icon: "x" });
        }
      })();
    },
    [api, orgId, toast, t],
  );
}

/**
 * The task's conversation, one row: who took part, "6 mensagens", "Trabalhando" while an agent is at it, else when
 * it last moved; nobody yet: "Conversar sobre a tarefa". Opens the thread screen; the card gives under the finger as
 * the app's cards do (`PressScale`).
 */
function ConversationRow({ issue, onOpen }: { issue: Issue; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  // Mentions of me there not read yet: red before the chevron, as Conversa on the web.
  const { mentions } = useTaskUnread(useOrgId(), issue.id);
  const line = conversationLine(issue);
  const label = line ? t("issues.conversation.messages", { count: line.count }) : t("issues.conversation.start");
  const state = line?.working
    ? t("threads.status.working")
    : line?.lastAt
      ? relativeTime(t, i18n.language, line.lastAt)
      : null;
  return (
    <PressScale
      fill={false}
      haptic={false}
      accessibilityRole="button"
      accessibilityLabel={[
        t("issues.conversation.title"),
        label,
        state,
        mentions > 0 ? t("shell.unreadMentions", { count: mentions }) : null,
      ]
        .filter(Boolean)
        .join(", ")}
      onPress={onOpen}
      style={[styles.talk, surface]}
      contentStyle={styles.talkIn}
    >
      <Icon name="chat" size={18} color={c.muted} />
      {line ? (
        <View style={styles.faces}>
          {line.people.map((p) => (
            <Face key={`${p.type}:${p.id}`} who={p} size={20} live={false} />
          ))}
        </View>
      ) : null}
      <Text variant="body" style={[styles.bold, styles.grow]} numberOfLines={1}>
        {label}
      </Text>
      {state ? (
        <Text variant="small" tone="muted">
          {state}
        </Text>
      ) : null}
      <MentionCount count={mentions} />
      <Disclosure />
    </PressScale>
  );
}

/**
 * The title (its "#134" is the bar's: never said twice, one under the other), "Criada pelo Atlas a partir do Sentry ·
 * #tech" under it, then its fields as the web's strip, in its order: Coluna, Responsável, Prioridade, Prazo, Quem vê, each opening its picker; its GitHub link.
 */
function Head({ issue: i }: { issue: Issue }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const orgId = useOrgId();
  const channels = useChannels(orgId);
  const channel = i.channelId ? channels.data?.find((x) => x.id === i.channelId) : undefined;
  // Handed from a DM with an agent: that DM, for whoever reads it.
  const dms = useDms(orgId);
  const source = i.source;
  const dm =
    source.type === "agent"
      ? dms.data?.find((d) => d.channelId === source.channelId && d.with.type === "agent")
      : undefined;
  const from =
    i.source.type === "message"
      ? t("mobile.issues.fromMessage")
      : dm
        ? t("issues.fromDmText", { name: dm.with.name })
        : i.source.type === "agent"
          ? t("mobile.issues.fromAgent")
          : i.source.type === "webhook"
            ? t("mobile.issues.fromWebhook", { provider: i.source.provider })
            : null;
  const creator = dir.nameOf(i.createdBy);
  // It starts the line now, under the title.
  const line = capitalize(
    [
      [creator ? t("mobile.issues.createdBy", { name: creator }) : null, from].filter(Boolean).join(" "),
      channel ? `#${channel.name}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    i18n.language,
  );
  const whoSees = useWhoSeesLabel();
  const pickers = useIssuePickers(i);
  const audience = i.audience ?? { mode: "everyone" as const };
  return (
    <View style={styles.head}>
      <Text variant="display2" accessibilityRole="header" style={styles.bigTitle} maxFontSizeMultiplier={1.4}>
        {i.title}
      </Text>
      {line ? (
        <Text variant="small" tone="faint">
          {line}
        </Text>
      ) : null}
      <View style={styles.chips}>
        <PropChip
          label={t("issues.projects.label")}
          value={i.project?.name ?? t("issues.projects.none")}
          leading={<ProjectDot color={i.project?.color} />}
          onPress={pickers.pickProject}
        />
        <PropChip
          label={t("issues.column")}
          value={pickers.column ? pickers.columnLabel(pickers.column) : t(`issues.status.${i.status}`)}
          icon={STAGE_ICON[i.status]}
          onPress={pickers.pickColumn}
        />
        <PropChip
          label={t("issues.form.assignee")}
          value={whoText(t, dir, i) ?? t("issues.noAssignee")}
          {...(i.assignees.length > 1
            ? { leading: <AssigneeFace issue={{ assignees: i.assignees }} size={24} live={false} ring={c.sunken} /> }
            : i.assignees[0]
              ? { leading: <Face who={i.assignees[0]} size={20} live={false} /> }
              : { icon: "person" as const })}
          onPress={pickers.pickAssignee}
        />
        <PropChip
          label={t("issues.form.priority")}
          value={t(`issues.priority.${i.priority}`)}
          icon="flag"
          onPress={pickers.pickPriority}
        />
        <PropChip
          label={t("issues.due")}
          value={i.dueDate ? dueLabel(t, i18n.language, i.dueDate) : t("issues.noDue")}
          icon="clock"
          onPress={pickers.pickDue}
        />
        <PropChip
          label={t("whoSees.label")}
          value={whoSees(audience)}
          icon={audience.mode === "people" ? "lock" : "globe"}
          onPress={pickers.pickWhoSees}
        />
        {i.githubUrl ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={i.githubUrl}
            onPress={() => {
              const url = webUrl(i.githubUrl);
              if (url) void Linking.openURL(url).catch(() => undefined);
            }}
          >
            <GithubChip url={i.githubUrl} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** The stage's mark on the strip's Coluna. */
const STAGE_ICON: Record<IssueStatus, IconName> = {
  todo: "circle",
  in_progress: "clock",
  in_review: "code",
  done: "checkc",
  canceled: "x",
};

/** Pastes, changes or removes the task's GitHub link. */
function GithubLinkForm({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const c = useColors();
  const sheet = useSheet();
  const action = useIssueAction(useOrgId());
  const toast = useToast();
  const [text, setText] = useState(i.githubUrl ?? "");
  const [invalid, setInvalid] = useState(false);
  const save = (githubUrl: string | null) =>
    action.mutate(
      { type: "update", id: i.id, patch: { githubUrl } },
      {
        onSuccess: () => {
          sheet.close();
          toast({ title: t("mobile.issues.changed") });
        },
        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      },
    );
  const submit = () => {
    const url = text.trim();
    if (url && !isGithubLink(url)) return setInvalid(true);
    save(url || null);
  };
  return (
    <>
      <SheetTitle title={t("issues.github.label")} />
      <Locked when={action.isPending}>
        <TextArea
          multiline={false}
          minHeight={44}
          value={text}
          onChangeText={(v) => {
            setText(v);
            setInvalid(false);
          }}
          onSubmitEditing={submit}
          placeholder={t("issues.github.placeholder")}
          accessibilityLabel={t("issues.github.label")}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
      </Locked>
      {invalid ? (
        <Text variant="small" style={{ color: c.warn }}>
          {t("issues.github.invalid")}
        </Text>
      ) : null}
      <Button variant="primary" wide label={t("common.save")} loading={action.isPending} onPress={submit} />
      {i.githubUrl ? (
        <Button
          variant="ghost"
          wide
          label={t("issues.github.remove")}
          disabled={action.isPending}
          onPress={() => save(null)}
        />
      ) : null}
    </>
  );
}

/** The agent's work: its live steps (an orbit on the current one), what it waits for, or that it stopped. */
function WorkCard({ issue: i }: { issue: Issue }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const surface = useSurface();
  const now = useNow(30_000);
  const stepText = useStepText();
  const orgId = useOrgId();
  const action = useIssueAction(orgId);
  const toast = useToast();
  const ai = useAiStatus(orgId);
  const reduced = useReducedMotion();
  const w = i.work;
  if (!w || !isOpen(i)) return null;
  // Stopped because the agent has nothing to think with: say so, and the way out is connecting one.
  const noAi = aiStateOf(ai.data, w.agentId) === "no_ai";
  const agent = dir.agentById.get(w.agentId);
  const name = agent?.name ?? "";
  const color = agentLook(agent).color;
  const state = issueState(i);
  const mins = minutesSince(w.since, now);
  const sub =
    state === "stalled"
      ? t("mobile.issues.stalledSince", { when: relativeTime(t, i18n.language, w.since) })
      : state === "waiting"
        ? t("mobile.issues.waitsYou")
        : mins < 1
          ? t("mobile.issues.justStarted")
          : t("mobile.issues.workingFor", { count: mins });
  // What a person reads: never an engine-only step (the silent `pass`).
  const steps = shownSteps(w.steps);
  const last = steps.at(-1);
  const lines = workLines(t, steps, state === "running", i18n.language);
  return (
    <View style={[styles.work, surface]}>
      <View style={styles.workHead}>
        <Face
          who={{ type: "agent", id: w.agentId }}
          size={24}
          mode={state === "running" ? "run" : state === "stalled" ? "rest" : "idle"}
        />
        <Text variant="body" numberOfLines={1} style={[styles.bold, styles.shrink]}>
          {name}
        </Text>
        <Text variant="body" tone="muted" style={styles.grow} numberOfLines={1}>
          {sub}
        </Text>
      </View>
      {state === "stalled" ? (
        <>
          {last ? (
            <Text variant="small" tone="muted">
              {t("issues.work.lastStep", { step: stepText(last) })}
            </Text>
          ) : null}
          {noAi ? (
            <Text variant="small" tone="muted">
              {t("noAi.agent", agentGrammar(name))}
            </Text>
          ) : w.reason ? (
            <Text variant="small" tone="muted">
              {t(`issues.work.reason.${w.reason}`)}
            </Text>
          ) : null}
          <View>
            {noAi ? (
              <Button
                variant="primary"
                size="sm"
                icon="brain"
                label={t("mobile.ai.connect")}
                onPress={() => openConnectAi({ agentId: w.agentId })}
              />
            ) : (
              <Button
                variant="primary"
                size="sm"
                icon="right"
                label={t("issues.work.continue")}
                disabled={action.isPending}
                onPress={() =>
                  action.mutate(
                    { type: "ask", id: i.id, agentId: w.agentId },
                    {
                      onSuccess: () =>
                        toast({ title: t("issues.work.resumed", agentGrammar(name)), agentId: w.agentId }),
                      onError: (error) => toast({ title: errorText(t, error), icon: "x" }),
                    },
                  )
                }
              />
            )}
          </View>
        </>
      ) : lines.length > 0 ? (
        <View style={styles.steps}>
          {/* A step the agent takes while the person watches fades in; the ones already there don't. */}
          <LayoutAnimationConfig skipEntering>
            {lines.map((l) => (
              <Animated.View
                key={l.key}
                entering={reduced ? undefined : FadeIn.duration(160)}
                layout={reduced ? undefined : LinearTransition.duration(220)}
                style={styles.stepRow}
              >
                {/* On the step's first line: a step that wraps had its mark centred between its lines. */}
                {l.going ? (
                  <LineIcon variant="small" size={12} mark>
                    <PixelOrbit color={color} size={12} />
                  </LineIcon>
                ) : (
                  <LineIcon
                    variant="small"
                    name={l.step.outcome === "refused" ? "x" : "checkc"}
                    size={13}
                    color={c.faint}
                  />
                )}
                <Text variant="small" tone={l.last ? "ink2" : "muted"} style={styles.grow}>
                  {l.text}
                </Text>
              </Animated.View>
            ))}
          </LayoutAnimationConfig>
        </View>
      ) : state === "running" ? (
        <Text variant="small" tone="muted">
          {t("issues.work.starting")}
        </Text>
      ) : null}
    </View>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View>
      <GroupedHeader>{title}</GroupedHeader>
      {children}
    </View>
  );
}

function Description({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  return (
    <Group title={t("issues.description")}>
      <View style={styles.desc}>
        {i.description.trim() ? (
          <MessageText body={i.description} />
        ) : (
          <Text variant="body" tone="faint">
            {t("issues.noDescription")}
          </Text>
        )}
      </View>
    </Group>
  );
}

/** "Critérios de aceite · 0 de 3": a check box per criterion (anyone who can see the issue may check). */
function Criteria({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const orgId = useOrgId();
  const action = useIssueAction(orgId);
  const toast = useToast();
  // The tap shows at once; the issue comes back from the server with it.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  if (i.criteria.length === 0) return null;
  const criteria = i.criteria.map((x) => ({ ...x, done: pending[x.id] ?? x.done }));
  const p = criteriaProgress({ criteria });
  return (
    <Group
      title={`${t("issues.criteria")} · ${t("mobile.issues.criteriaOf", { done: p?.done ?? 0, total: p?.total ?? 0 })}`}
    >
      <View style={[styles.card, surface]}>
        {criteria.map((x, k) => (
          <RowPressable
            key={x.id}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: x.done }}
            accessibilityLabel={x.text}
            onPress={() => {
              tapHaptic();
              const done = !x.done;
              setPending((s) => ({ ...s, [x.id]: done }));
              action.mutate(
                { type: "criterion", id: i.id, criterionId: x.id, done },
                {
                  onSettled: () =>
                    setPending((s) => {
                      const { [x.id]: _, ...rest } = s;
                      return rest;
                    }),
                  onError: () => {
                    errorHaptic();
                    toast({ title: t("mobile.app.failed"), icon: "x" });
                  },
                },
              );
            }}
            style={styles.crit}
          >
            {k > 0 ? <View style={[styles.critLine, { backgroundColor: c.line }]} /> : null}
            <View
              style={[styles.box, x.done ? { backgroundColor: c.ink } : { borderWidth: 1.5, borderColor: c.line2 }]}
            >
              {x.done ? <Icon name="check" size={13} color={c.bg} /> : null}
            </View>
            <Text variant="body" tone={x.done ? "faint" : "ink"} style={[styles.grow, x.done && styles.struck]}>
              {x.text}
            </Text>
            {x.done && x.doneBy?.type === "agent" ? <Face who={x.doneBy} size={18} live={false} /> : null}
          </RowPressable>
        ))}
      </View>
    </Group>
  );
}

/** `remove`: what a held touch (and VoiceOver's actions) offers to take the row off. */
function LinkRow({
  icon,
  label,
  onPress,
  first,
  remove,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  first: boolean;
  remove?: LinkRemove | undefined;
}) {
  const c = useColors();
  return (
    <RowPressable
      hold
      onPress={onPress}
      accessibilityRole="link"
      style={styles.link}
      {...(remove
        ? {
            onLongPress: remove.run,
            accessibilityActions: [{ name: "remove", label: remove.label }],
            onAccessibilityAction: (e) => {
              if (e.nativeEvent.actionName === "remove") remove.run();
            },
          }
        : {})}
    >
      {!first ? <View style={[styles.linkLine, { backgroundColor: c.line }]} /> : null}
      <View style={[styles.tile, { backgroundColor: c.sunken }]}>
        <Icon name={icon} size={16} color={c.muted} />
      </View>
      <Text variant="body" numberOfLines={1} style={styles.grow}>
        {label}
      </Text>
      <Disclosure />
    </RowPressable>
  );
}

interface LinkRemove {
  label: string;
  run: () => void;
}

/**
 * A Drive file held in Ligados: asks, then takes it off the task (an `artifact_unlinked` in its activity), never out
 * of the Drive. Anyone who sees the task may change it, as on the web.
 */
function useRemoveFile(i: Issue) {
  const { t } = useTranslation();
  const action = useIssueAction(useOrgId());
  const toast = useToast();
  return (file: { id: string; title: string }): LinkRemove => ({
    label: t("issues.files.removeShort"),
    run: () => {
      tapHaptic();
      confirmAction({
        title: t("issues.files.remove", { name: file.title }),
        text: t("mobile.issues.removeFileText"),
        action: t("issues.files.removeShort"),
        cancel: t("common.cancel"),
        onConfirm: () =>
          action.mutate(
            { type: "update", id: i.id, patch: { removeFiles: [file.id] } },
            {
              onSuccess: () => toast({ title: t("issues.files.removed", { name: file.title }) }),
              onError: (error) => {
                errorHaptic();
                toast({ title: errorText(t, error), icon: "x" });
              },
            },
          ),
      });
    },
  });
}

/** Ligados: the message it came from, the Drive files (held, one comes off the task), the pull requests. */
function Linked({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const surface = useSurface();
  const orgId = useOrgId();
  const channels = useChannels(orgId);
  const removeFile = useRemoveFile(i);
  const rows: { key: string; icon: IconName; label: string; onPress: () => void; remove?: LinkRemove }[] = [];
  const dms = useDms(orgId);
  const source = i.source;
  const dm =
    source.type === "agent"
      ? dms.data?.find((d) => d.channelId === source.channelId && d.with.type === "agent")
      : undefined;
  if (dm && source.type === "agent") {
    rows.push({
      key: "source",
      icon: "chat",
      label: t("issues.fromDmText", { name: dm.with.name }),
      onPress: () => router.push(chatHref(dm.channelId, null, source.messageId ?? null)),
    });
  }
  if (i.source.type === "message") {
    const { channelId } = i.source;
    const channel = channels.data?.find((x) => x.id === channelId);
    rows.push({
      key: "source",
      icon: "chat",
      label: channel ? t("mobile.issues.linkMessage", { channel: channel.name }) : t("mobile.issues.linkMessagePlain"),
      onPress: () => router.push(chatHref(channelId)),
    });
  }
  for (const a of i.artifacts)
    rows.push({
      key: `a:${a.id}`,
      icon: "doc",
      label: a.title,
      onPress: () => openFile({ id: a.id, title: a.title }),
      remove: removeFile(a),
    });
  for (const pr of i.pullRequests)
    rows.push({
      key: `pr:${pr.number}`,
      icon: "code",
      label: t("issues.pr", { number: pr.number }),
      onPress: () => {
        // Only a web address opens; anything else the issue holds stays inert.
        const url = webUrl(pr.url);
        if (url) void Linking.openURL(url).catch(() => undefined);
      },
    });
  if (rows.length === 0) return null;
  return (
    <Group title={t("issues.links")}>
      <View style={[styles.card, surface]}>
        {rows.map((r, k) => (
          <LinkRow key={r.key} icon={r.icon} label={r.label} onPress={r.onPress} first={k === 0} remove={r.remove} />
        ))}
      </View>
    </Group>
  );
}

function SubIssues({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const surface = useSurface();
  const subs = i.subIssues ?? [];
  if (subs.length === 0) return null;
  return (
    <Group title={t("mobile.issues.subIssues")}>
      <View style={[styles.card, surface]}>
        {subs.map((s, k) => (
          <LinkRow
            key={s.id}
            icon={s.status === "done" ? "checkc" : "circle"}
            label={`#${s.number} ${s.title} · ${t(`issues.status.${s.status}`)}`}
            onPress={() => router.push(`/issues/${s.number}`)}
            first={k === 0}
          />
        ))}
      </View>
    </Group>
  );
}

/**
 * The task's bar: its number, then two of the system's bar buttons (our icon buttons on Android): Concluir (Reabrir
 * once it's done), and "…" with what else changes it, the system's own menu on iOS and the same choices in the app's
 * menu on Android (`HeaderAction.menu`). The fields that have many choices open their pushed picker from there, as from
 * the head's strip.
 */
function IssueBar({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const finish = useFinish(i);
  const items = useIssueMenu(i);
  const more = t("mobile.issues.more");
  return (
    <PushedHeader
      title={`#${i.number}`}
      solid={false}
      // Concluir (Reabrir) is the bar's word, the "…" beside it.
      action={{ label: finish.label, disabled: finish.pending, onPress: finish.run }}
      actions={[
        {
          icon: "more",
          sf: "ellipsis",
          label: more,
          menu: items,
          onPress: () =>
            chooseAction(
              more,
              items.map((m) => ({
                label: m.label,
                icon: m.icon,
                ...(m.destructive ? { destructive: true } : {}),
                onPress: m.onPress,
              })),
              t("common.cancel"),
            ),
        },
      ]}
    />
  );
}

/** Concluir / Reabrir: done with a success tap and a toast, or why it failed. */
function useFinish(i: Issue) {
  const { t } = useTranslation();
  const action = useIssueAction(useOrgId());
  const toast = useToast();
  const open = isOpen(i);
  const status: IssueStatus = open ? "done" : "todo";
  const run = () =>
    action.mutate(
      { type: "update", id: i.id, patch: { status } },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t(open ? "mobile.issues.finished" : "mobile.issues.reopened", { number: i.number }) });
        },
        onError: () => {
          errorHaptic();
          toast({ title: t("mobile.app.failed"), icon: "x" });
        },
      },
    );
  return { open, label: t(open ? "mobile.issues.finish" : "mobile.issues.reopen"), pending: action.isPending, run };
}

/** Who has a task, as a short list of names; nobody: nothing. */
const whoText = (t: TFunction, dir: { nameOf: (who: Actor) => string }, i: Pick<Issue, "assignees">) =>
  i.assignees.length > 0
    ? assigneeNames(
        t,
        i.assignees.map((a) => dir.nameOf(a)),
      )
    : null;

/**
 * What changes a task's fields: its project, its column (or its stage while the board's columns load), who does it
 * (several, each tap saved at once; the first agent it gets is asked and starts) and who sees it on their own pushed
 * screens; its priority and its due date, short fixed lists, in the app's menu of choices. The head's strip and "…"
 * share them.
 */
function useIssuePickers(i: Issue) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const action = useIssueAction(orgId);
  const start = useStartAgent();
  const columns = useIssueColumns(orgId);
  const columnLabel = useColumnLabel();
  const toast = useToast();
  const failed = () => toast({ title: t("mobile.app.failed"), icon: "x" });
  const update = (patch: Parameters<typeof action.mutate>[0], done?: string) =>
    action.mutate(patch, {
      onSuccess: () => toast({ title: done ?? t("mobile.issues.changed") }),
      onError: failed,
    });
  // One tap on the who picker, saved at once (ADR 0188). The first agent the task gets is asked and starts on it, the
  // others it has staying, as a single pick always did; with an agent on it already, another one only gets the task.
  // A save that fails says so and rejects, which takes the tap back on the picker; an agent that couldn't start stays
  // the task's (`useStartAgent` says why), so that tap stays.
  const assign = (next: Actor[], was: Actor[]) => {
    const starter = firstAgentAdded(was, next);
    if (starter) return start.run({ ...i, assignees: was }, starter.id, { done: t("mobile.issues.changed") });
    return action.mutateAsync({ type: "update", id: i.id, patch: { assignees: next } }).catch((error: unknown) => {
      failed();
      throw error;
    });
  };
  const pickOn = (pick: TaskPick) => {
    openTaskPick(pick);
    router.push("/issues/pick");
  };
  const choose = (title: string, options: ActionChoice[]) => chooseAction(title, options, t("common.cancel"));
  const board = columns.data ?? [];
  const column = columnOfIssue(i, board);
  return {
    column,
    columnLabel,
    // Columns not loaded (or failed): the stages, as before the board had columns.
    pickColumn: () =>
      board.length > 0
        ? pickOn({
            what: "column",
            value: column?.id ?? null,
            apply: (c) => {
              if (c.id === column?.id) return;
              update(
                { type: "update", id: i.id, patch: { columnId: c.id } },
                t("mobile.issues.moved", { number: i.number, column: columnLabel(c) }),
              );
            },
          })
        : choose(
            t("issues.column"),
            STATUSES.map((s) => ({
              label: t(`issues.status.${s}`),
              checked: s === i.status,
              onPress: () => update({ type: "update", id: i.id, patch: { status: s } }),
            })),
          ),
    pickAssignee: () => pickOn({ what: "who", value: i.assignees, apply: assign }),
    pickProject: () =>
      pickOn({
        what: "project",
        value: i.project ?? null,
        apply: (projectId) => {
          if (projectId !== (i.project?.id ?? null)) update({ type: "update", id: i.id, patch: { projectId } });
        },
      }),
    pickPriority: () =>
      choose(
        t("issues.form.priority"),
        PRIORITIES.map((p: IssuePriority) => ({
          label: t(`issues.priority.${p}`),
          checked: p === i.priority,
          onPress: () => update({ type: "update", id: i.id, patch: { priority: p } }),
        })),
      ),
    pickDue: () =>
      choose(
        t("issues.due"),
        DUE_CHOICES.map((d) => ({
          label: t(`mobile.issues.form.dueChoice.${d}`),
          checked: dueDateOf(d) === i.dueDate,
          onPress: () => update({ type: "update", id: i.id, patch: { dueDate: dueDateOf(d) } }),
        })),
      ),
    pickWhoSees: () => router.push({ pathname: "/who-sees", params: { number: i.number } }),
  };
}

/**
 * "…": talk about it, its column, priority, who does it (the first agent it gets is asked and starts), its GitHub
 * link, who sees it, showing the agent's work to everyone, stopping the agent, canceling and deleting it, as the web
 * allows. Each item's icon in our set (Android's list) and the matching SF Symbol (iOS's menu).
 */
function useIssueMenu(i: Issue): HeaderMenuItem[] {
  const { t } = useTranslation();
  const sheet = useSheet();
  const orgId = useOrgId();
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory();
  const meId = useMeId();
  const { org } = useOrg();
  const action = useIssueAction(orgId);
  const toast = useToast();
  const openConversation = useOpenConversation();
  const shareWork = useShareWork(i);
  const pickers = useIssuePickers(i);
  const stop = useMutation({
    mutationFn: (runId: string) => api.agents.cancelRun(orgId, runId),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.issues(orgId) }),
  });
  const failed = () => toast({ title: t("mobile.app.failed"), icon: "x" });
  const w = i.work;
  const items: HeaderMenuItem[] = [
    {
      label: t("mobile.issues.talk"),
      icon: "chat",
      sf: "bubble.left.and.bubble.right",
      onPress: () => openConversation(i),
    },
    {
      label: t("mobile.issues.actions.status"),
      icon: "circle",
      sf: "rectangle.split.3x1",
      onPress: pickers.pickColumn,
    },
    { label: t("mobile.issues.actions.priority"), icon: "flag", sf: "flag", onPress: pickers.pickPriority },
    {
      label: t("mobile.issues.actions.assignee"),
      icon: "agent",
      sf: "person.crop.circle",
      onPress: pickers.pickAssignee,
    },
    {
      label: t("issues.github.label"),
      icon: "link",
      sf: "link",
      onPress: () => sheet.open(<GithubLinkForm issue={i} />),
    },
    {
      label: t("whoSees.label"),
      icon: i.audience?.mode === "people" ? "lock" : "globe",
      sf: "eye",
      onPress: pickers.pickWhoSees,
    },
  ];
  // Mostrar para todos lives here, not as a fourth action on the work's card (one row of actions there).
  if (shareWork)
    items.push({
      label: t("work.shareEveryone"),
      icon: "globe",
      sf: "globe",
      onPress: () => {
        if (!shareWork.pending) shareWork.share();
      },
    });
  if (w?.state === "running" && w.runId) {
    const runId = w.runId;
    items.push({
      label: t("issues.work.stop"),
      icon: "pause",
      sf: "stop.circle",
      onPress: () => stop.mutate(runId, { onError: failed }),
    });
  }
  if (isOpen(i))
    items.push({
      label: t("mobile.issues.actions.cancel"),
      icon: "x",
      sf: "xmark.circle",
      destructive: true,
      onPress: () =>
        action.mutate(
          { type: "update", id: i.id, patch: { status: "canceled" } },
          {
            onSuccess: () => toast({ title: t("mobile.issues.actions.canceled", { number: i.number }) }),
            onError: failed,
          },
        ),
    });
  if (canDeleteIssue(org, i, meId))
    items.push({
      label: t("issues.delete.action"),
      icon: "trash",
      sf: "trash",
      destructive: true,
      onPress: () => {
        const working = i.work && i.work.state !== "stalled" ? dir.nameOf({ type: "agent", id: i.work.agentId }) : null;
        confirmAction({
          title: t("issues.delete.title", { number: i.number }),
          text: deleteIssueText(t, i, working),
          action: t("issues.delete.confirm"),
          cancel: t("common.cancel"),
          onConfirm: () =>
            action.mutate(
              { type: "delete", id: i.id },
              {
                onSuccess: () => {
                  toast({ title: t("issues.delete.done", { number: i.number }) });
                  // Opened from a link with nothing under it: Tarefas, never a dead end.
                  goBack("/issues");
                },
                onError: failed,
              },
            ),
        });
      },
    });
  return items;
}

/** A criterion's check box, a link's tile, and the body's line (iOS) the box centers on. */
const BOX = 20;
const TILE = 30;
const BODY_LINE = 22;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  head: { paddingHorizontal: SCREEN_X, paddingTop: 6, gap: 6, marginBottom: 14 },
  bigTitle: { marginVertical: 4 },
  chips: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  // The screen's cards: on the 16 margin, 12 apart (the conversation's card gap, CHAT_RHYTHM.card), radius 20 with the
  // cut corner. Measured: work card 16 → 16 from the edges, text at 16 + 14 + 24 face + 8 = 62; the work line's card on
  // the same 16 edges, its text at 16 + 40 = 56.
  work: {
    marginHorizontal: 16,
    borderRadius: 20,
    borderBottomLeftRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  section: { marginHorizontal: 16, marginTop: 12 },
  workHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  steps: { gap: 6 },
  stepRow: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  bold: { fontWeight: "600" },
  grow: { flex: 1, minWidth: 0 },
  // A long name gives way to the state after it rather than pushing it off the card.
  shrink: { flexShrink: 1 },
  desc: { paddingHorizontal: SCREEN_X },
  card: { marginHorizontal: 16, borderRadius: 14, overflow: "hidden" },
  crit: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  // Each list's hairline starts at its words: past the box, or the tile, and the row's gap.
  critLine: { position: "absolute", top: 0, left: 14 + BOX + 10, right: 0, height: StyleSheet.hairlineWidth },
  linkLine: { position: "absolute", top: 0, left: 14 + TILE + 10, right: 0, height: StyleSheet.hairlineWidth },
  // Centered on the criterion's first line.
  box: {
    width: BOX,
    height: BOX,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    marginTop: (BODY_LINE - BOX) / 2,
  },
  struck: { textDecorationLine: "line-through" },
  link: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  tile: { width: TILE, height: TILE, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  scroll: { paddingBottom: 40 },
  talk: { marginHorizontal: 16, marginTop: 12, borderRadius: 14 },
  talkIn: { paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  faces: { flexDirection: "row", gap: 2 },
});
