import {
  keys,
  type Message,
  type MessageConsultation,
  type RunConsultation,
  useConsultationConversation,
} from "@agenteschat/client";
import { handoffAsk } from "@agenteschat/client/lib/agent-work";
import {
  type ConsultLineState,
  type ConsultPairItem,
  consultLineKey,
  consultPair,
  firstOfRun,
  openableConsultation,
  pairItemOf,
} from "@agenteschat/client/lib/consult-group";
import { consultSubject, consultTimeText, withoutRelayLine } from "@agenteschat/client/lib/consultations";
import { namesText } from "@agenteschat/client/lib/format";
import type { agentGrammar } from "@agenteschat/client/lib/grammar";
import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { consultationHref } from "../links/logic";
import { AgentFace } from "../shared/Face";
import { useColors, useNow, useOrgId } from "../shared/hooks";
import { usePresenceOf } from "../status/hooks";
import { rowBodyInset } from "./logic";
import { useRhythm, useRowLook } from "./look";
import { useRowConsults, useRowDirectory } from "./row-data";
import { WaitMark } from "./WaitMark";

/** A question's state in words, on the conversation's screen ("A Iris espera uma aprovação"). */
export const consultLineLabel = (
  t: TFunction,
  state: ConsultLineState,
  c: Pick<RunConsultation, "waiting" | "kind">,
  to: ReturnType<typeof agentGrammar>,
) => t(consultLineKey(state, c), { name: to.name, context: to.context });

/** The open questions' times count by the second; with none out the row's clock barely moves (`useNow`). */
const OPEN_TICK_MS = 1000;
const STILL_TICK_MS = 3_600_000;

const NO_ITEMS: ConsultPairItem[] = [];
const NO_CONSULTED: MessageConsultation[] = [];

const NO_REACHED: ReadonlySet<string> = new Set();

/**
 * The questions a pair row stands for: those of run `runId` on the run's first message here (`messageId`; null: its
 * live turn, which shows them until the run posts), with the rest of their exchange when `runId` asked first
 * (`asExchanges`), and those a reply's `meta.consulted` names that the list doesn't have. `reached`: hand-offs the
 * message's reach lines show (`reachHandoffs`), left out here.
 */
export function useRunConsults(
  runId: string | null | undefined,
  where: Pick<Message, "channelId" | "threadId">,
  messageId: string | null,
  consulted: readonly MessageConsultation[] = NO_CONSULTED,
  reached: ReadonlySet<string> = NO_REACHED,
): ConsultPairItem[] {
  const orgId = useOrgId();
  const qc = useQueryClient();
  // Grouped once for the conversation (`RowConsults.byRun`, `groupsByRun(asExchanges(…))`), not again in every row.
  const list = useRowConsults(where.channelId);
  const group = runId ? list.byRun.get(runId) : undefined;
  const listed = list.byId;
  const loaded =
    group && runId
      ? [
          ...(qc.getQueryData<Message[]>(keys.messages(orgId, where.channelId)) ?? []),
          ...((where.threadId && qc.getQueryData<Message[]>(keys.thread(orgId, where.channelId, where.threadId))) ||
            []),
        ]
      : [];
  const first = group && runId ? firstOfRun(loaded, runId) : null;
  const draws = group !== undefined && (messageId === null ? first === null : !first || first === messageId);
  return useMemo(() => {
    const run = group ?? NO_ITEMS;
    const extra = consulted.filter((c) => !listed.has(c.consultationId)).map(pairItemOf);
    const mine = !draws ? NO_ITEMS : reached.size === 0 ? run : run.filter((c) => !reached.has(c.id));
    return extra.length === 0 ? mine : [...mine, ...extra];
  }, [group, listed, consulted, draws, reached]);
}

/**
 * The conversation's question with this id (a hand-off a reach line shows): from its list, or, older than the list
 * goes back, on its own.
 */
export function useConsultById(channelId: string, id: string | undefined): RunConsultation | null {
  const orgId = useOrgId();
  const list = useRowConsults(channelId);
  const listed = (id && list.byId.get(id)) || null;
  const alone = useConsultationConversation(orgId, channelId, id && list.loaded && !listed ? id : null);
  return listed ?? alone.data?.consultation ?? null;
}

/**
 * The slim row right before a reply whose agent asked other agents first, as on the web (`ConsultGroup.tsx`): the
 * asker's face and name, ⇄, the consulted agent's (several fold into stacked faces, "Atlas e mais 2"), then how long
 * it took, or while it runs "perguntando 42 s", or "não respondeu". Never what they said: a tap opens the two agents'
 * conversation on a screen of its own, read only (`ConsultationScreen`). The same row stands for an answer whose
 * reply is farther up or not here, and for a hand-off by direct message on a reach line (`inline`).
 */
export function ConsultPairRow({
  askerId,
  channelId,
  items,
  inline = false,
  gap,
}: {
  askerId: string;
  /** The conversation that asked: the screen opens from it. */
  channelId: string;
  items: readonly ConsultPairItem[];
  /** Inside a message (its reach lines): it reaches past the row's body to the conversation's width. */
  inline?: boolean;
  /** Under what shows above it (a turn's, or a part's under another quiet line). Inline: its margin above. */
  gap?: number;
}) {
  const { t, i18n } = useTranslation();
  const rhythm = useRhythm();
  const inset = rowBodyInset(useRowLook());
  const dir = useRowDirectory();
  const c = useColors();
  const live = items.some((x) => x.status === "open");
  const now = useNow(live ? OPEN_TICK_MS : STILL_TICK_MS);
  // The hand-off's run waits on me (its agent's work for me, ADR 0084 addendum): the row says so in amber, as on
  // the web.
  const presence = usePresenceOf();
  const only = items.length === 1 && items[0]?.status === "open" ? items[0] : undefined;
  const mine = only ? handoffAsk(presence.agent(only.consultedAgentId)?.work, only.consultedRunId) : null;
  const pair = consultPair(items, now, askerId, mine);
  if (!pair) return null;
  // Blue at work, amber when it waits on me, quiet when it waits on someone else, the warning for what went unanswered.
  const tone =
    pair.tone === "live" ? c.agent : pair.tone === "bad" ? c.warn : pair.tone === "you" ? c.amberInk : c.muted;
  const nameOf = (id: string) => dir.agentById.get(id)?.name ?? t("mobile.chat.someone");
  const from = nameOf(askerId);
  const names = pair.faces.map((f) => nameOf(f.agentId));
  const to = names.length === 1 ? (names[0] ?? "") : namesText(t, names, 1);
  // What the question a tap opens is about, between the names and how it went, as on the web.
  const opened = items.find((x) => x.id === pair.opens) ?? items[0];
  const subject = consultSubject(opened?.question);
  // The whole question, which the row's one line cuts: for screen readers here, on the screen a tap opens.
  const question = withoutRelayLine(opened?.question ?? "").trim();
  // An old reply's question with no id of its own has no conversation to open.
  const opens = openableConsultation(pair.opens);
  // A row of several opens on all of them: the screen offers each agent's exchange.
  const ids = items.map((x) => x.id);
  return (
    <View
      style={[
        styles.line,
        inline
          ? {
              marginLeft: LINE_INSET - inset.left,
              marginRight: LINE_INSET - inset.right,
              // Between turns, as the list's own line: the turn's gap on both sides, of which the body's part is one.
              marginTop: gap ?? rhythm.turn - rhythm.part,
              marginBottom: rhythm.turn - rhythm.part,
            }
          : { marginTop: gap ?? rhythm.turn, paddingHorizontal: LINE_INSET },
      ]}
    >
      <View style={[styles.rule, { backgroundColor: c.line }]} />
      <Pressable
        onPress={() => {
          if (opens) router.push(consultationHref(opens, channelId, ids));
        }}
        disabled={!opens}
        accessibilityRole="button"
        accessibilityHint={question || undefined}
        // A 28-point row: 8 above and below gives it the 44-point target.
        hitSlop={{ top: 8, bottom: 8 }}
        style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.plate }]}
      >
        <AgentFace agentId={askerId} size={FACE} live={false} />
        <Text variant="footnote" tone="ink2" numberOfLines={1} style={styles.name}>
          {from}
        </Text>
        {pair.tone === "you" ? (
          <View style={styles.mark}>
            <WaitMark size={8} />
          </View>
        ) : (
          <Icon name="swap" size={13} color={pair.tone === "live" ? c.agent : c.faint} />
        )}
        <View style={styles.faces}>
          {pair.faces.slice(0, 3).map((f, i) => (
            <View key={f.agentId} style={[i > 0 && [styles.stacked, { borderColor: c.bg }], f.off && styles.off]}>
              <AgentFace
                agentId={f.agentId}
                size={FACE}
                live={false}
                mode={pair.tone === "live" && !f.off ? "think" : "idle"}
              />
            </View>
          ))}
        </View>
        <Text variant="footnote" tone="ink2" numberOfLines={1} style={styles.name}>
          {to}
        </Text>
        {/* The subject carries its own ·: when it has no room left, the dot goes with it. */}
        {subject ? (
          <Text variant="footnote" tone="faint" numberOfLines={1} style={styles.subject}>
            {`· ${subject}`}
          </Text>
        ) : null}
        {pair.word || pair.seconds !== null ? (
          <Text variant="footnote" tone="faint">
            ·
          </Text>
        ) : null}
        {pair.word ? (
          <Text variant="footnote" style={[styles.word, { color: tone }]}>
            {t(pair.word.key, pair.word.values)}
          </Text>
        ) : null}
        {pair.seconds !== null ? (
          <Text variant="footnote" tone="faint" style={styles.time}>
            {consultTimeText(t, i18n.language, live, pair.seconds)}
          </Text>
        ) : null}
      </Pressable>
      <View style={[styles.rule, { backgroundColor: c.line }]} />
    </View>
  );
}

/** The pair's faces. */
const FACE = 18;
/** The row's room at each end, where its press lights. */
const ROW_INSET = 8;
/** The line's ends, the conversation's "Novas" line's. */
const LINE_INSET = 16;

const styles = StyleSheet.create({
  // Across the conversation, the two agents on its middle: a line, as the day and "Novas" are.
  line: { flexDirection: "row", alignItems: "center" },
  rule: { flex: 1, minWidth: 16, height: StyleSheet.hairlineWidth },
  // Always one line: the subject gives way first ("…"), the names only once it has none left, the word and time never.
  row: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    columnGap: 6,
    minHeight: 28,
    paddingHorizontal: ROW_INSET,
    borderRadius: 10,
    flexShrink: 1,
  },
  // The names give way only once the subject has none left: its share of any shrink dwarfs theirs.
  name: { fontWeight: "600", flexShrink: 1 },
  subject: { flexShrink: 100000 },
  faces: { flexDirection: "row", alignItems: "center" },
  stacked: { marginLeft: -6, borderLeftWidth: 1.5, borderRadius: 6 },
  off: { opacity: 0.45 },
  word: { fontWeight: "600", flexShrink: 0 },
  // The wait mark in the arrows' 13-point place, so the names don't move.
  mark: { width: 13, height: 13, alignItems: "center", justifyContent: "center" },
  time: { fontVariant: ["tabular-nums"], flexShrink: 0 },
});
