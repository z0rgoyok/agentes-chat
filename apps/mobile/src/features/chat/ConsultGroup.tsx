import {
  keys,
  type Message,
  type MessageConsultation,
  type RunConsultation,
  useChannelName,
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
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { Icon, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { consultationHref } from "../links/logic";
import { AgentFace } from "../shared/Face";
import { useColors, useNow, useOrgId } from "../shared/hooks";
import { usePresenceOf } from "../status/hooks";
import { sameItems, useRowConsultsPart, useRowDirectory } from "./row-data";
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
  // Only this run's questions, and which of the ones it names the list has: the row draws again when those change, not
  // on every reload of the conversation's questions (a row with no run follows nothing).
  const group = useRowConsultsPart(where.channelId, (list) => (runId ? list.byRun.get(runId) : undefined), sameItems);
  const listed = useRowConsultsPart(where.channelId, (list) =>
    consulted.map((c) => (list.byId.has(c.consultationId) ? "1" : "0")).join(""),
  );
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
    const extra = consulted.filter((_, i) => listed[i] !== "1").map(pairItemOf);
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
  // That question alone (and whether the list came): the line draws again only when it changes.
  const listed = useRowConsultsPart(channelId, (list) => (id && list.byId.get(id)) || null);
  const loaded = useRowConsultsPart(channelId, (list) => list.loaded);
  const alone = useConsultationConversation(orgId, channelId, id && loaded && !listed ? id : null);
  return listed ?? alone.data?.consultation ?? null;
}

/** Past this width the row has room for the subject, as the web's (`.consult-pair` at 420). */
const SUBJECT_ROOM = 420;

/**
 * The slim row right before a reply whose agent asked other agents first (`ask_agent`) or handed them work
 * (`tell_agent`), as the web's `ConsultPairRow`: between two hairlines, centered, the asker's face and name, ⇄, the
 * consulted agent's (several fold into stacked faces, "Atlas e mais 2"), then how it went ("· levou 58 s",
 * "· perguntando 12 s" in blue) and a chevron. A tap opens the two agents' conversation, read only
 * (`ConsultationScreen`). The question's subject shows only where there is room for it (a phone's width has none), as
 * the web's. The same row stands for an answer whose reply is farther up or not here, and for a hand-off on a reach
 * line. `handed`: another agent's request in the DM of the agent it went to (`handOffOf`): "Atlas pediu à Ada" in
 * place of ⇄, "por você", nothing about its state until it ends, and where the person asked ("em #eng").
 */
export function ConsultPairRow({
  askerId,
  channelId,
  items,
  handed = false,
  askedIn = null,
}: {
  askerId: string;
  channelId: string;
  items: readonly ConsultPairItem[];
  handed?: boolean;
  askedIn?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const dir = useRowDirectory();
  const c = useColors();
  const roomy = useWindowDimensions().width > SUBJECT_ROOM;
  const live = items.some((x) => x.status === "open");
  const now = useNow(live ? OPEN_TICK_MS : STILL_TICK_MS);
  const presence = usePresenceOf();
  const where = useChannelName(useOrgId(), askedIn);
  const only = items.length === 1 && items[0]?.status === "open" ? items[0] : undefined;
  const mine = only ? handoffAsk(presence.agent(only.consultedAgentId)?.work, only.consultedRunId) : null;
  const found = consultPair(items, now, askerId, handed ? null : mine);
  if (!found) return null;
  const pair = handed && live ? { ...found, word: null, seconds: null, tone: null } : found;
  const wordTone =
    pair.tone === "live" ? c.agent : pair.tone === "bad" ? c.warn : pair.tone === "you" ? c.amberInk : c.muted;
  const nameOf = (id: string) => dir.agentById.get(id)?.name ?? t("mobile.chat.someone");
  const from = nameOf(askerId);
  const names = pair.faces.map((f) => nameOf(f.agentId));
  const to = names.length === 1 ? (names[0] ?? "") : namesText(t, names, 1);
  const opened = items.find((x) => x.id === pair.opens) ?? items[0];
  const subject = [
    handed || roomy ? consultSubject(opened?.question) : null,
    handed && where ? t("chat.consultPair.askedIn", { channel: `#${where}` }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const question = withoutRelayLine(opened?.question ?? "").trim();
  const opens = openableConsultation(pair.opens);
  const ids = items.map((x) => x.id);
  const word = pair.word ? t(pair.word.key, pair.word.values) : null;
  const time = pair.seconds !== null ? consultTimeText(t, i18n.language, live, pair.seconds) : null;
  const how = [word, time].filter(Boolean).join(" · ");
  // A hand-off on a phone's width shows what was asked instead: "por você" and the time give way, as the web's.
  const tight = handed && !roomy;
  const shownTime = tight ? null : time;
  return (
    <View style={row.line}>
      <View style={[row.rule, { backgroundColor: c.line }]} />
      <Pressable
        onPress={() => {
          if (opens) router.push(consultationHref(opens, channelId, ids));
        }}
        disabled={!opens}
        accessibilityRole="button"
        accessibilityLabel={[
          handed
            ? `${from} ${t("chat.consultPair.askedHere", { context: agentGrammar(to).context })} ${to} ${t("chat.consultPair.forYou")}`
            : t("mobile.chat.pairAsked", { from }),
          handed ? null : to,
          how,
          subject,
        ]
          .filter(Boolean)
          .join(", ")}
        accessibilityHint={question || undefined}
        style={({ pressed }) => [row.row, pressed && { backgroundColor: c.plate }]}
      >
        <AgentFace agentId={askerId} size={PAIR_FACE} live={false} mode="idle" />
        <Text variant="footnote" tone="ink2" numberOfLines={1} style={row.name}>
          {from}
        </Text>
        {handed ? (
          <Text variant="footnote" tone="muted" numberOfLines={1} style={row.whole}>
            {t("chat.consultPair.askedHere", { context: agentGrammar(to).context })}
          </Text>
        ) : pair.tone === "you" ? (
          <View style={row.swap}>
            <WaitMark size={8} />
          </View>
        ) : (
          <Icon name="swap" size={15} color={pair.tone === "live" ? c.agent : c.faint} />
        )}
        <View style={row.faces}>
          {pair.faces.slice(0, 3).map((f, i) => (
            <View key={f.agentId} style={[i > 0 && [row.stacked, { borderColor: c.bg }], f.off && row.off]}>
              <AgentFace
                agentId={f.agentId}
                size={PAIR_FACE}
                live={false}
                mode={pair.tone === "live" && !f.off ? "think" : "idle"}
              />
            </View>
          ))}
        </View>
        <Text variant="footnote" tone="ink2" numberOfLines={1} style={row.name}>
          {to}
        </Text>
        {handed && !tight ? (
          <Text variant="footnote" tone="muted" numberOfLines={1} style={row.whole}>
            {t("chat.consultPair.forYou")}
          </Text>
        ) : null}
        {subject ? (
          <Text variant="footnote" tone="muted" numberOfLines={1} style={row.subject}>
            <Text variant="footnote" tone="faint">
              {"· "}
            </Text>
            {subject}
          </Text>
        ) : null}
        {word || shownTime ? (
          <Text variant="footnote" tone="faint" numberOfLines={1} style={row.whole}>
            {"· "}
            {word ? (
              <Text variant="footnote" style={[{ color: wordTone }, pair.tone && row.word]}>
                {word}
              </Text>
            ) : null}
            {word && shownTime ? " " : null}
            {shownTime ? (
              <Text variant="footnote" tone="faint" style={row.time}>
                {shownTime}
              </Text>
            ) : null}
          </Text>
        ) : null}
        {opens ? (
          <View style={row.chev}>
            <Icon name="right" size={14} color={c.faint} />
          </View>
        ) : null}
      </Pressable>
      <View style={[row.rule, { backgroundColor: c.line }]} />
    </View>
  );
}

/** The row's faces, the web's `xs`. */
const PAIR_FACE = 18;
/** The row's room at both ends, the chevron in the right one: the agents stay on the middle whether it shows or not. */
const PAIR_PAD = 20;

const row = StyleSheet.create({
  line: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16 },
  // The hairlines at both sides, 16 at the least.
  rule: { flexGrow: 1, flexBasis: 16, minWidth: 16, height: StyleSheet.hairlineWidth },
  row: {
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 26,
    paddingVertical: 4,
    paddingHorizontal: PAIR_PAD,
    borderRadius: 8,
  },
  // The names give way only once the subject has none left.
  name: { fontWeight: "600", flexShrink: 1 },
  whole: { flexShrink: 0 },
  subject: { flexShrink: 1000, minWidth: 0 },
  word: { fontWeight: "600" },
  time: { fontVariant: ["tabular-nums"] },
  // The wait mark in the arrows' 15 slot, so the names don't move.
  swap: { width: 15, alignItems: "center", justifyContent: "center" },
  faces: { flexDirection: "row", alignItems: "center", marginRight: -2 },
  stacked: { marginLeft: -5, borderLeftWidth: 1.5, borderRadius: 5 },
  off: { opacity: 0.45 },
  chev: { position: "absolute", right: 3, top: 0, bottom: 0, justifyContent: "center" },
});
