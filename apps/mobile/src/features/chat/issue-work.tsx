import { type Message, useIssue } from "@agenteschat/client";
import { type HandedTask, handedTasksOf, type IssueWorkRef, issueTakenOf } from "@agenteschat/client/lib/issues";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Disclosure, EventPill, Icon, MESSAGE_CARD_X, PressScale, Text, TOUCH } from "@/ui";
import { router } from "@/ui/navigation";
import { StateChip } from "../issues/parts";
import { chatHref } from "../links/logic";
import { AgentFace } from "../shared/Face";
import { useColors, useOrgId, useWhen } from "../shared/hooks";
import { useSurface } from "../shared/parts";
import { usePresenceOf } from "../status/hooks";
import { useCardTop, useMessageCardFrame, useQuietInset } from "./look";
import { useRowDirectory, useRowMeId } from "./row-data";

/**
 * "Ask Ada to implement" (as on the web): the root of the work thread in the
 * DM is this card ("Você pediu a issue #24", the title, its live state, "Ver
 * issue"); the agent's instructions never show in the chat.
 */
export function IssueWorkCard({ work, authorId }: { work: IssueWorkRef; authorId: string | null }) {
  const { t } = useTranslation();
  const c = useColors();
  const cardTop = useCardTop();
  const frame = useMessageCardFrame();
  const orgId = useOrgId();
  const meId = useRowMeId();
  const dir = useRowDirectory();
  const issue = useIssue(orgId, work.number);
  const current = issue.data?.id === work.issueId ? issue.data : null;
  const asker = authorId && authorId !== meId ? dir.nameOf({ type: "person", id: authorId }) : "";
  return (
    <PressScale
      onPress={() => router.push(`/issues/${work.number}`)}
      accessibilityRole="button"
      accessibilityLabel={`${t("chat.issueWork.label")}: #${work.number} ${current?.title ?? work.title}`}
      accessibilityHint={t("chat.issueWork.view")}
      // The card's own size: the press area never grows past it.
      fill={false}
      style={[styles.cardBox, frame.style, cardTop]}
      contentStyle={styles.card}
    >
      <View style={styles.head}>
        {/* The icon alone: no tile inside the card. */}
        <Icon name="issue" size={15} color={c.ink2} />
        <Text variant="cardKind" style={styles.grow} numberOfLines={1}>
          {asker ? t("chat.issueWork.askedBy", { name: asker }) : t("chat.issueWork.asked")} #{work.number}
        </Text>
        {current ? <StateChip issue={current} /> : null}
      </View>
      <Text variant="cardTitle" numberOfLines={3}>
        {current?.title ?? work.title}
      </Text>
      <View style={styles.foot}>
        <Text variant="label" tone="ink2">
          {t("chat.issueWork.view")}
        </Text>
        <Disclosure />
      </View>
    </PressScale>
  );
}

/** Where the issue came from: one event pill, "Ada took task #24 · its title", the issue a tap on it away. */
export const IssueTakenLine = memo(function IssueTakenLine({ message, gap }: { message: Message; gap: number }) {
  const { t } = useTranslation();
  const dir = useRowDirectory();
  const when = useWhen();
  const inset = useQuietInset();
  const taken = issueTakenOf(message.meta);
  if (!taken) return null;
  const name = dir.nameOf(message.author);
  return (
    <View style={[styles.line, { paddingLeft: inset, marginTop: gap }]}>
      <EventPill mark="issue" time={when.time(message.createdAt)}>
        {t("chat.issueWork.taken", { name })}{" "}
        <Text
          variant="small"
          tone="ink2"
          style={styles.bold}
          onPress={() => router.push(`/issues/${taken.number}`)}
          accessibilityRole="link"
          suppressHighlighting
        >
          #{taken.number} · {taken.title}
        </Text>
      </EventPill>
    </View>
  );
});

/**
 * The tasks the right hand handed on in this reply (ADR 0137 §13), as on the web: one row each, "#42 Campanha de
 * Natal", its agent and its live state. A tap opens the task's conversation, where the work happens.
 */
export function HandedTaskChips({ message }: { message: Message }) {
  const tasks = handedTasksOf(message.meta);
  if (tasks.length === 0) return null;
  return (
    <View style={styles.chips}>
      {tasks.map((task) => (
        <HandedTaskChip key={task.issueId} task={task} />
      ))}
    </View>
  );
}

function HandedTaskChip({ task }: { task: HandedTask }) {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const orgId = useOrgId();
  const dir = useRowDirectory();
  const issue = useIssue(orgId, task.number);
  const current = issue.data?.id === task.issueId ? issue.data : null;
  const agent = dir.agentById.get(task.agentId);
  // A chip's face lives only while its agent works: still, it costs nothing as the conversation scrolls.
  const working = usePresenceOf().agent(task.agentId)?.presence === "working";
  const title = current?.title ?? task.title;
  return (
    <PressScale
      onPress={() => router.push(chatHref(task.channelId, task.rootId))}
      accessibilityRole="button"
      accessibilityLabel={t("chat.issueWork.chipLabel", { number: task.number, title })}
      // As wide as its words: the press area keeps the chip's size.
      fill={false}
      style={[styles.chipBox, surface]}
      contentStyle={styles.chip}
    >
      <Icon name="issue" size={14} color={c.ink2} />
      {/* A chip as wide as its words: they shrink at the column's edge (a flex: 1 here collapsed them to nothing). */}
      <Text variant="small" tone="ink" style={[styles.fit, styles.bold]} numberOfLines={1}>
        #{task.number} {title}
      </Text>
      {agent ? <AgentFace agentId={agent.id} size={18} live={working} /> : null}
      {current ? <StateChip issue={current} /> : null}
    </PressScale>
  );
}

const styles = StyleSheet.create({
  chips: { gap: 6, marginTop: 6, alignItems: "flex-start" },
  // A chip: its box (the color, the corner) and its one row of words, a finger's 44 tall.
  chipBox: { maxWidth: "100%", borderRadius: 14 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: TOUCH,
    paddingVertical: 6,
    paddingLeft: 12,
    paddingRight: 8,
  },
  fit: { flexShrink: 1, minWidth: 0 },
  // The card's box, as every card in a message, and its content at the cards' padding.
  cardBox: { borderRadius: 20 },
  card: { paddingVertical: 14, paddingHorizontal: MESSAGE_CARD_X, gap: 8 },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  grow: { flex: 1, flexShrink: 1 },
  foot: { flexDirection: "row", alignItems: "center", gap: 4 },
  bold: { fontWeight: "600" },
  // An event pill at the messages' words, left aligned; the list sets its top.
  line: { paddingRight: 16 },
  // The pill's words' size (its sentence sets it; a nested text keeps the variant's own otherwise).
});
