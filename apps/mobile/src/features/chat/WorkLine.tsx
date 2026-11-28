import { type Channel, channelsQuery, type Issue, type Message, useApi, type WorkView } from "@agenteschat/client";
import { managesAgent } from "@agenteschat/client/lib/audience";
import { relativeTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { handedFinished, heldBack } from "@agenteschat/client/lib/issues";
import {
  blockedText,
  handedLine,
  workIsOver,
  workLine,
  workPlanProgress,
  workWaitsOnPerson,
} from "@agenteschat/client/lib/long-work";
import { can } from "@agenteschat/client/lib/permissions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { createContext, type ReactNode, useCallback, useContext } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Pressable, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { useOrg } from "@/providers/org";
import {
  Button,
  haptics,
  Icon,
  IconButton,
  LineIcon,
  MESSAGE_CARD_X,
  PixelOrbit,
  Text,
  textLineOf,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { useFontScale } from "@/ui/text-scale";
import { chatHref, consultationHref } from "../links/logic";
import { useBubblePart } from "../shared/bubble-part";
import { AgentFace } from "../shared/Face";
import { useColors, useNow, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { ownsIn } from "../shared/owner";
import { tapHaptic, useSurface } from "../shared/parts";
import { StatusBadge } from "../shared/StatusBadge";
import { RowPartContext, useCardTop, useMessageCardFrame } from "./look";
import { useRowDirectory, useRowMeId } from "./row-data";

/** The conversation's list scrolls to one of its messages (false: it doesn't show it). */
export const JumpToMessageContext = createContext<((messageId: string) => boolean) | null>(null);

/** A live work's minutes move every half minute; a finished one's line barely needs the clock (`useNow`). */
const LIVE_TICK_MS = 30_000;
const STILL_TICK_MS = 3_600_000;

/** The phone's long-work line (ADR 0121), as the web's WorkLine: how it stands, its last update and its actions. */
function useLine(work: WorkView, inUpdatesThread = false) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const meId = useRowMeId();
  const dir = useRowDirectory();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const live = work.status === "live" || work.status === "queued";
  const now = new Date(useNow(live ? LIVE_TICK_MS : STILL_TICK_MS));
  const agent = dir.agentById.get(work.agentId);
  // As `mayStopRun` decides (who asked, the agent's owner, who manages it); the server has the last word, in a toast.
  const stop = useMutation({
    mutationFn: (runId: string) => api.agents.cancelRun(orgId, runId),
    // A failure's toast, in the failure's tone (the ×), as every refusal in the app.
    onError: () => toast({ title: t("work.stopFailed"), icon: "x" }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", work.channelId] }),
  });
  const context = {
    locale: i18n.language || "pt-BR",
    now,
    meId,
    agentName: agent?.name ?? "",
    nameOf: (id: string) => dir.memberById.get(id)?.name ?? null,
    agentNameOf: (id: string) => dir.anyAgent(id)?.name,
    // Its owner, or one who holds the role that answers for it (ADR 0085, addendum of 2026-11-21).
    canStop: managesAgent(agent) || ownsIn(dir.memberById, meId, agent) || work.requestedByUserId === meId,
    inUpdatesThread,
  };
  const view = workLine(t, work, context);
  return { view, handed: () => handedLine(t, work, context), agentName: agent?.name ?? "", stop, t };
}

/** The work's thread, where its updates are, on the question it waits on. */
const threadHref = (work: WorkView) =>
  chatHref(work.channelId, work.threadId ?? work.anchorMessageId, work.question?.messageId);

/** At most this many actions under the line: one row at the default text size, never a ragged second one. */
const MAX_ACTIONS = 3;

/**
 * The work as a card that matches where it stands. In a message's body, the conversation's own card (as the tool
 * block's, the receipts' and the team checks': a hairline, radius 14, the cut corner) on the body's edges, off the part
 * above by the body's card gap (`useCardTop`). On a task's screen, the screen's card (radius 20 with the cut corner,
 * the raised surface and its lit top), as the work card over it; the screen places it. Its text and the plan under it
 * (`below`) share one column, 14 + mark 16 + 10 = 40 from the card's left edge; its actions are the card's foot in a
 * message (equal buttons under a hairline) and words in that column on a task's screen.
 */
function Line({
  work,
  onThread,
  onSee,
  below,
  inUpdatesThread,
  handed: asHanded,
}: {
  work: WorkView;
  onThread?: () => void;
  /** "Ver" on a hand-off still out: the two agents' talk, as the working line's. */
  onSee?: () => void;
  below?: ReactNode;
  inUpdatesThread?: boolean;
  /** Under the reply that handed it: "Handed to Atlas · working on it · step 3 of 5 · 2 min", Stop or the result. */
  handed?: boolean;
}) {
  const c = useColors();
  const surface = useSurface();
  const part = useBubblePart();
  const cardTop = useCardTop();
  const card = useMessageCardFrame();
  const dir = useRowDirectory();
  const agentColor = agentLook(dir.agentById.get(work.agentId)).color;
  const fontScale = useFontScale();
  const inBody = useContext(RowPartContext) !== null;
  const line = useLine(work, inUpdatesThread);
  const { stop, t } = line;
  const h = asHanded ? line.handed() : null;
  // Handed: no task, thread or repeated question on the line (the chip, the messages and the card below say them).
  const view = h ? { ...line.view, ...h, task: null, threadId: null, question: null, update: null } : line.view;
  const jump = useContext(JumpToMessageContext);
  // An icon per state, never a colored dot: the shape says it without the color.
  const mark =
    view.tone === "done"
      ? { icon: "check" as const, color: c.ok }
      : view.tone === "failed"
        ? { icon: "x" as const, color: c.danger }
        : view.tone === "stopped"
          ? { icon: "pause" as const, color: c.muted }
          : { icon: "clock" as const, color: c.warn };
  // Ver resultado: the report where it was asked, scrolled to when this conversation shows it.
  const seeResult = (messageId: string) => {
    if (!jump?.(messageId)) router.push(chatHref(work.channelId, work.homeThreadId));
  };
  // Priority when more than MAX_ACTIONS apply: stopping, then the result, the task, the thread; shown in reading order.
  const all: (WorkAction & { rank: number })[] = [];
  if (onThread && view.threadId) all.push({ key: "thread", rank: 3, label: t("work.openThread"), onPress: onThread });
  if (onSee) all.push({ key: "see", rank: 1, label: t("run.strip.see"), onPress: onSee });
  if (view.task) {
    const number = view.task.number;
    all.push({ key: "task", rank: 2, label: view.task.label, onPress: () => router.push(`/issues/${number}`) });
  }
  if (view.result) {
    const messageId = view.result.messageId;
    all.push({ key: "result", rank: 1, label: view.result.label, onPress: () => seeResult(messageId) });
  }
  if (view.stop) {
    const runId = view.stop.runId;
    all.push({
      key: "stop",
      rank: 0,
      label: t("work.stop"),
      danger: true,
      disabled: stop.isPending,
      onPress: () => {
        haptics.firm();
        stop.mutate(runId);
      },
    });
  }
  const kept = new Set(
    [...all]
      .sort((a, b) => a.rank - b.rank)
      .slice(0, MAX_ACTIONS)
      .map((a) => a.key),
  );
  const actions = all.filter((a) => kept.has(a.key));
  // The state's words, the handed work's or the work's own, at the given size.
  const said = (variant: "small" | "caption") =>
    h ? (
      <>
        <Trans i18nKey="work.handed.lead" values={{ name: line.agentName }} components={[<Text key="face" />]} />
        {" · "}
        <Text
          variant={variant}
          style={[styles.bold, { color: h.tone === "working" ? c.agent : h.tone === "waiting" ? c.warn : c.ink }]}
        >
          {h.state}
        </Text>
        {h.facts.map((fact) => ` · ${fact}`).join("")}
      </>
    ) : (
      view.text
    );
  const markOf = (variant: "small" | "footnote" | "caption", size: number) =>
    view.tone === "working" ? (
      <LineIcon variant={variant} size={size} mark>
        <PixelOrbit color="sky" size={size - 2} />
      </LineIcon>
    ) : (
      <LineIcon variant={variant} name={mark.icon} size={size} color={mark.color} />
    );
  if (inBody && h) {
    // Handed over, under the reply that handed it: a second bubble of the turn (the message's fill, joined to it; the
    // conversation's card in the other looks) with the agent that took it, "Passado para o Atlas", and under it how it
    // stands in its color with the way to it ("Pronto em 1 min · Ver resultado"). Loose words under the bubble read
    // as small print; the bubble says it is part of what the agent said. "Parar" ends it while it works.
    const go = actions.filter((a) => !a.danger).sort((a, b) => a.rank - b.rank)[0];
    const halt = actions.find((a) => a.danger);
    const g = agentGrammar(line.agentName);
    // Its state as a badge, as the web's line draws it; its facts and the way to it after it.
    const badgeTone =
      view.tone === "done" ? "done" : h.tone === "working" ? "working" : h.tone === "waiting" ? "you" : "neutral";
    const after = [...h.facts, go?.label].filter(Boolean).join(" · ");
    const frame = [styles.handed, card.style];
    return (
      <View style={cardTop}>
        <Pressable
          onPress={go?.onPress}
          disabled={!go}
          accessibilityRole={go ? "button" : "summary"}
          {...(go ? { accessibilityHint: go.label } : {})}
          style={({ pressed }) => [frame, pressed && go && styles.pressed]}
        >
          <AgentFace
            agentId={work.agentId}
            size={HANDED_FACE}
            live={false}
            mode={h.tone === "working" ? "think" : "idle"}
          />
          <View style={styles.handedWords}>
            <Text variant="cardTitle" numberOfLines={1}>
              {t("mobile.chat.handedTo", { name: g.name, context: g.context })}
            </Text>
            <View style={styles.handedState}>
              <StatusBadge text={h.state} tone={badgeTone} color={agentColor} />
              {after ? (
                <Text variant="footnote" numberOfLines={1} style={[styles.shrink, { color: c.muted }]}>
                  {after}
                </Text>
              ) : null}
            </View>
          </View>
          {halt ? (
            // Stop as the kit's round button with the stop square, centred on the bubble's row: a word there took the
            // room the state's words needed and sat off their middle.
            <IconButton icon="stop" small label={halt.label} disabled={halt.disabled} onPress={halt.onPress} />
          ) : go ? (
            <Icon name="right" size={16} color={c.faint} />
          ) : null}
        </Pressable>
      </View>
    );
  }
  if (inBody) {
    // In a message: a quiet line under it, in the conversation's working line's words (a card under the bubble read
    // as a dialog in the chat). The way to the work (its result, its task or its thread) is its words' tap, said after
    // them; "Parar" ends the line after a thin rule, neutral until pressed.
    const go = actions.filter((a) => !a.danger).sort((a, b) => a.rank - b.rank)[0];
    const halt = actions.find((a) => a.danger);
    return (
      <View style={[styles.quiet, part ? styles.quietInBubble : null, cardTop]} accessibilityRole="summary">
        <View style={styles.quietMark}>{markOf("caption", QUIET_MARK)}</View>
        <Pressable
          onPress={go?.onPress}
          disabled={!go}
          accessibilityRole={go ? "button" : undefined}
          {...(go ? { accessibilityHint: go.label } : {})}
          style={({ pressed }) => [styles.quietWords, pressed && styles.pressed]}
        >
          <Text variant="caption" tone="muted">
            {said("caption")}
            {go ? (
              <>
                {" · "}
                <Text variant="caption" style={[styles.bold, { color: c.ink2 }]}>
                  {go.label}
                </Text>
              </>
            ) : null}
          </Text>
          {view.question ? (
            <Text variant="caption" tone="ink" numberOfLines={2}>
              {view.question.text}
            </Text>
          ) : null}
          {view.update ? (
            <Text variant="caption" tone="faint">
              {view.update}
            </Text>
          ) : null}
        </Pressable>
        {halt ? (
          <View style={[styles.quietStop, { height: textLineOf("caption", fontScale).height }]}>
            <View style={[styles.rule, { backgroundColor: c.line }]} />
            <Pressable
              onPress={halt.onPress}
              disabled={halt.disabled}
              accessibilityRole="button"
              accessibilityLabel={halt.label}
              // A caption word: 14 above and under make the 44 a finger needs.
              hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
            >
              {({ pressed }) => (
                <Text
                  variant="caption"
                  style={[styles.bold, { color: halt.disabled ? c.faint : pressed ? c.danger : c.ink }]}
                >
                  {halt.label}
                </Text>
              )}
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  }
  return (
    <View style={[styles.card, surface]} accessibilityRole="summary">
      <View style={styles.line}>
        {/* On the first line's reading middle. */}
        <View style={styles.mark}>{markOf("small", MARK)}</View>
        <View style={styles.body}>
          <Text variant="small" tone="ink2">
            {said("small")}
          </Text>
          {view.question ? (
            <Text variant="small" tone="ink" numberOfLines={2}>
              {view.question.text}
            </Text>
          ) : null}
          {view.update ? (
            <Text variant="small" tone="muted">
              {view.update}
            </Text>
          ) : null}
          {actions.length > 0 ? (
            <View style={styles.actions}>
              {actions.map((a) => (
                <Action key={a.key} action={a} />
              ))}
            </View>
          ) : null}
          {below}
        </View>
      </View>
    </View>
  );
}

/** One of the work's actions: what it says, what it does, and whether it stops the work (`danger`). */
interface WorkAction {
  key: string;
  label: string;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** The status mark beside the line, on its first line's middle; in a message's quiet line, the caption's size. */
const MARK = 16;
const QUIET_MARK = 14;
/** A handed work's bubble: the agent's face, and its state's mark. */
const HANDED_FACE = 32;

/** A state's words opening a line ("pronto em 1 min" → "Pronto em 1 min"). */

/** One action in words, on a task's screen: neutral, the stop in the danger color. */
function Action({ action: a }: { action: WorkAction }) {
  const c = useColors();
  return (
    // 44 tall to the finger; across, no more than the gap to the next action.
    <Pressable
      onPress={a.onPress}
      disabled={a.disabled}
      accessibilityRole="button"
      hitSlop={{ top: 12, bottom: 12, left: 6, right: 6 }}
      style={({ pressed }) => pressed && styles.pressed}
    >
      <Text variant="small" style={[styles.action, { color: a.disabled ? c.faint : a.danger ? c.danger : c.ink }]}>
        {a.label}
      </Text>
    </Pressable>
  );
}

/**
 * Under the agent's "Vou cuidar disso": the work's line. Abrir thread only where nothing else opens it: not under a
 * root whose thread link shows (`threaded`), unless it waits on someone, nor inside that thread, where its updates
 * are the messages under it and the line doesn't repeat the last one.
 */
export function MessageWorkLine({ message, threaded }: { message: Message; threaded?: boolean }) {
  const { thread } = useLocalSearchParams<{ thread?: string }>();
  const work = message.longWork;
  if (!work) return null;
  const inside = thread === (work.threadId ?? work.anchorMessageId);
  const hidden = inside || (threaded && !workWaitsOnPerson(work));
  return (
    <Line work={work} inUpdatesThread={inside} onThread={hidden ? undefined : () => router.push(threadHref(work))} />
  );
}

/** Under the reply of the agent that handed work over: one line per handed work. */
export function HandedWorkLines({ message }: { message: Message }) {
  const works = message.handedWorks ?? [];
  if (works.length === 0) return null;
  return (
    <>
      {works.map((w) => {
        const talk = w.handedBy?.consultationId;
        const onSee = talk && !workIsOver(w) ? () => router.push(consultationHref(talk, message.channelId)) : undefined;
        return <Line key={w.id} work={w} handed onSee={onSee} />;
      })}
    </>
  );
}

/** On a task's screen: the work's line and the agent's plan. */
export function IssueWorkLine({ issue, style }: { issue: Issue; style?: StyleProp<ViewStyle> }) {
  const { t } = useTranslation();
  const c = useColors();
  const work = issue.backgroundWork;
  const blocked = blockedText(t, issue.blocked);
  if (work?.how === "handed")
    return <HandedWork work={work} finished={handedFinished(issue)} style={[styles.block, style]} />;
  if (!work && !blocked) return null;
  const progress = work ? workPlanProgress(work) : null;
  return (
    <View style={[styles.block, style]}>
      {/* A state is its words in the state's color, never a label on a tinted plate. */}
      {blocked ? (
        <Text variant="small" style={[styles.blocked, { color: c.warn }]}>
          {blocked}
        </Text>
      ) : null}
      {work ? (
        <Line
          work={work}
          onThread={() => router.push(threadHref(work))}
          below={
            progress ? (
              <View style={styles.plan}>
                <Text variant="cardKind">
                  {t("work.plan")} · {t("work.planProgress", progress)}
                </Text>
                {work.plan.map((p) => (
                  <View key={p.id} style={styles.step}>
                    <LineIcon
                      name={p.state === "done" ? "check" : p.state === "doing" ? "bolt" : "circle"}
                      size={15}
                      color={p.state === "done" ? c.ok : p.state === "doing" ? c.agent : c.faint}
                      variant="small"
                    />
                    <Text variant="small" tone={p.state === "todo" ? "muted" : "ink2"} style={styles.grow}>
                      {p.text}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null
          }
        />
      ) : null}
    </View>
  );
}

/**
 * A handed task's work on its screen, as the web's box: its line while it works; its question with Answer (full width)
 * when it waits on the reader, which opens the card where it was asked; once done with every criterion met, who finished
 * it, when, who handed it and the first line of what came of it.
 */
function HandedWork({ work, finished, style }: { work: WorkView; finished: boolean; style?: StyleProp<ViewStyle> }) {
  const { t, i18n } = useTranslation();
  const dir = useRowDirectory();
  const surface = useSurface();
  if (work.status === "done") {
    if (!finished) return null;
    const name = dir.anyAgent(work.agentId)?.name ?? t("channel.unknownAgent");
    const by = work.handedBy ? dir.anyAgent(work.handedBy.agentId)?.name : null;
    const when = relativeTime(t, i18n.language, work.finishedAt ?? work.startedAt);
    return (
      <View style={[style, styles.done, surface]}>
        <Text variant="cardTitle">{t("issues.work.finishedTitle", { name })}</Text>
        <Text variant="footnote" tone="muted">
          {by ? t("issues.work.finishedMeta", { when, name: by }) : when}
        </Text>
        {work.result ? (
          <Text variant="small" tone="ink2">
            {work.result.text}
          </Text>
        ) : null}
      </View>
    );
  }
  const asked = work.state === "waiting_input" ? work.question : null;
  return (
    <View style={style}>
      <Line work={work} handed />
      {asked ? (
        <View style={styles.ask}>
          <Text variant="small" tone="ink">
            {asked.text}
          </Text>
          <Button
            variant="primary"
            wide
            label={t("issues.work.answer")}
            onPress={() => router.push(chatHref(work.channelId, work.homeThreadId, asked.messageId))}
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * Mostrar para todos, for the task's "…" menu: a card a DM or a private channel holds back, for who may show it to the
 * whole workspace (who asked for the work, its creator, an admin). Null when it isn't held back or isn't yours to show.
 */
export function useShareWork(issue: Issue): { share: () => void; pending: boolean } | null {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useRowMeId();
  const admin = can(useOrg().org, "manage_agents");
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  // Only whether its conversation holds it back, from the channel list: the list is read again for any message.
  const channelId = issue.channelId;
  const holds = useCallback((all: Channel[]) => heldBack({ channelId }, all), [channelId]);
  const held = useQuery({ ...channelsQuery(api, orgId), select: holds }).data === true;
  const share = useMutation({
    mutationFn: () => api.issues.share(orgId, issue.id),
    onSuccess: () => {
      toast({ title: t("work.shared"), icon: "check" });
      void qc.invalidateQueries({ queryKey: ["org", orgId, "issues"] });
    },
    onError: () => toast({ title: t("work.shareFailed"), icon: "x" }),
  });
  const work = issue.backgroundWork;
  const mayShare =
    !work ||
    work.requestedByUserId === meId ||
    (issue.createdBy.type === "person" && issue.createdBy.id === meId) ||
    admin;
  if (!held || !mayShare) return null;
  return {
    share: () => {
      tapHaptic();
      share.mutate();
    },
    pending: share.isPending,
  };
}

const styles = StyleSheet.create({
  // The app's card: radius 20 with the cut corner.
  card: { borderRadius: 20, borderBottomLeftRadius: 6 },
  // The mark and the words: text at 14 + 16 + 10 = 40 from the card's left edge.
  line: { flexDirection: "row", gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  // In a message: the line under it, as wide as its words, a little under the part above.
  quiet: {
    flexDirection: "row",
    alignItems: "flex-start",
    alignSelf: "flex-start",
    maxWidth: "100%",
    gap: 6,
    paddingTop: 4,
  },
  // Under a bubble: its mark where the bubble's words start.
  quietInBubble: { paddingLeft: 14 },
  // A handed work's bubble: the face, its two lines and the chevron on one row, as wide as the column allows.
  handed: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    alignSelf: "flex-start",
    maxWidth: "100%",
    minWidth: 240,
    paddingVertical: 10,
    paddingHorizontal: MESSAGE_CARD_X,
    // Outside a bubble group, the cards' hairline (the frame takes it off in one).
    borderWidth: StyleSheet.hairlineWidth,
  },
  // As wide as its words (the bubble grows with them up to the column), shrinking only when the column runs out: with
  // no width of its own (`flex: 1`) the bubble stayed at its least and cut the words that had room.
  handedWords: { flexShrink: 1, minWidth: 0, gap: 1 },
  handedState: { flexDirection: "row", alignItems: "center", gap: 4 },
  shrink: { flexShrink: 1 },
  quietMark: { width: QUIET_MARK, alignItems: "center" },
  quietWords: { flexShrink: 1, minWidth: 0, gap: 2 },
  // The rule and "Parar" on the words' first line.
  quietStop: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 2 },
  rule: { width: StyleSheet.hairlineWidth, height: 12 },
  mark: { width: 16, alignItems: "center" },
  body: { flex: 1, minWidth: 0, gap: 4 },
  actions: { flexDirection: "row", flexWrap: "wrap", columnGap: 16, rowGap: 4, marginTop: 4 },
  action: { fontWeight: "600" },
  pressed: { opacity: 0.6 },
  block: { gap: 12 },
  blocked: { fontWeight: "600" },
  // Under the actions, on the card's text column.
  plan: { gap: 6, marginTop: 8 },
  step: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  done: { gap: 4, padding: 14, borderRadius: 20 },
  ask: { gap: 10, marginTop: 10 },
});
