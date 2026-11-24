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
import { Icon, Text, useTheme } from "@/ui";
import { router } from "@/ui/navigation";
import { withAlpha } from "@/ui/palette";
import { RADIUS } from "@/ui/radius";
import { consultationHref } from "../links/logic";
import { AgentFace } from "../shared/Face";
import { useColors, useNow, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { usePresenceOf } from "../status/hooks";
import { nameInk } from "./logic";
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

/**
 * The questions a reply's agent asked other agents first, quoted at the top of the reply (as a reply quotes a
 * message): the consulted agent's face and its name in its color with how it went ("· levou 58 s", "· perguntando
 * 12 s" in blue), the question's subject in up to two lines, and a chevron, on a plate a step off the bubble (no
 * colored bar at its left edge); a tap opens the two agents' conversation,
 * read only (`ConsultationScreen`). Several asked: the first agent's color and face, "Atlas e mais 2". `alone`: with no
 * reply to sit in (an answer farther up, a hand-off on a reach line), the quote stands on its own and says who asked
 * ("Theo perguntou").
 */
export function ConsultQuote({
  askerId,
  channelId,
  items,
  alone = false,
}: {
  askerId: string;
  channelId: string;
  items: readonly ConsultPairItem[];
  alone?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const dir = useRowDirectory();
  const c = useColors();
  const { scheme } = useTheme();
  const live = items.some((x) => x.status === "open");
  const now = useNow(live ? OPEN_TICK_MS : STILL_TICK_MS);
  const presence = usePresenceOf();
  const only = items.length === 1 && items[0]?.status === "open" ? items[0] : undefined;
  const mine = only ? handoffAsk(presence.agent(only.consultedAgentId)?.work, only.consultedRunId) : null;
  const pair = consultPair(items, now, askerId, mine);
  if (!pair) return null;
  const tone =
    pair.tone === "live" ? c.agent : pair.tone === "bad" ? c.warn : pair.tone === "you" ? c.amberInk : c.faint;
  const nameOf = (id: string) => dir.agentById.get(id)?.name ?? t("mobile.chat.someone");
  const firstId = pair.faces[0]?.agentId ?? askerId;
  const color = agentLook(dir.agentById.get(firstId)).color;
  const ink = nameInk(color, scheme === "dark");
  const names = pair.faces.map((f) => nameOf(f.agentId));
  const to = names.length === 1 ? (names[0] ?? "") : namesText(t, names, 1);
  const opened = items.find((x) => x.id === pair.opens) ?? items[0];
  const subject = consultSubject(opened?.question);
  const question = withoutRelayLine(opened?.question ?? "").trim();
  const opens = openableConsultation(pair.opens);
  const ids = items.map((x) => x.id);
  const how = [
    pair.word ? t(pair.word.key, pair.word.values) : null,
    pair.seconds !== null ? consultTimeText(t, i18n.language, live, pair.seconds) : null,
  ]
    .filter(Boolean)
    // Two facts, told apart as every line's: "1 of 2 · 2.1 h".
    .join(" · ");
  return (
    <Pressable
      onPress={() => {
        if (opens) router.push(consultationHref(opens, channelId, ids));
      }}
      disabled={!opens}
      accessibilityRole="button"
      accessibilityLabel={[alone ? t("mobile.chat.pairAsked", { from: nameOf(askerId) }) : null, to, how, subject]
        .filter(Boolean)
        .join(", ")}
      accessibilityHint={question || undefined}
      style={({ pressed }) => [
        quote.box,
        { backgroundColor: withAlpha(c.ink, pressed ? 0.09 : 0.05) },
        alone && quote.alone,
      ]}
    >
      <View style={quote.inner}>
        <View style={quote.head}>
          {alone ? (
            <>
              <Text variant="small" tone="ink2" numberOfLines={1} style={quote.asker}>
                {nameOf(askerId)}
              </Text>
              {pair.tone === "you" ? (
                <WaitMark size={8} />
              ) : (
                <Icon name="swap" size={12} color={pair.tone === "live" ? c.agent : c.faint} />
              )}
            </>
          ) : null}
          <View style={quote.faces}>
            {pair.faces.slice(0, 3).map((f, i) => (
              <View key={f.agentId} style={[i > 0 && [quote.stacked, { borderColor: c.bg }], f.off && quote.off]}>
                <AgentFace
                  agentId={f.agentId}
                  size={QUOTE_FACE}
                  live={false}
                  mode={pair.tone === "live" && !f.off ? "think" : "idle"}
                />
              </View>
            ))}
          </View>
          <Text variant="small" numberOfLines={1} style={[quote.name, { color: ink }]}>
            {to}
          </Text>
          {how ? (
            <Text variant="footnote" numberOfLines={1} style={[quote.how, { color: tone }]}>
              {`· ${how}`}
            </Text>
          ) : null}
        </View>
        {subject ? (
          <Text variant="footnote" tone="muted" numberOfLines={2}>
            {subject}
          </Text>
        ) : null}
      </View>
      {opens ? <Icon name="right" size={15} color={c.faint} /> : null}
    </Pressable>
  );
}

/** The quote's faces. */
const QUOTE_FACE = 16;

const quote = StyleSheet.create({
  // The words' column, a step off the bubble's own fill, the chevron at its right.
  box: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 2,
    marginBottom: 8,
    // The plates' room and the scale's item corner, as a quote in the words.
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 10,
    borderRadius: RADIUS.md,
    overflow: "hidden",
  },
  // On its own (no reply here): as wide as a bubble's words, under the conversation's quiet lines' inset.
  alone: { marginTop: 0, marginBottom: 0, alignSelf: "flex-start", maxWidth: "100%" },
  inner: { flex: 1, minWidth: 0, gap: 1 },
  head: { flexDirection: "row", alignItems: "center", gap: 5 },
  asker: { fontWeight: "600", flexShrink: 1 },
  faces: { flexDirection: "row", alignItems: "center" },
  stacked: { marginLeft: -5, borderLeftWidth: 1.5, borderRadius: 5 },
  off: { opacity: 0.45 },
  name: { fontWeight: "600", flexShrink: 1 },
  how: { flexShrink: 0 },
});
