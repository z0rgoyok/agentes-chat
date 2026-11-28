import {
  type AgentAction,
  type AppNotification,
  type CardDelegate,
  type Message,
  type Proposal,
  useActionCard,
  useAgentProposal,
  useCardProposals,
  useChannels,
  useDecideActionCard,
  useModelLabel,
  useRoles,
  type WorkspaceActionCard,
} from "@agenteschat/client";
import {
  actionCardApplyKey,
  actionCardDetail,
  actionCardKey,
  actionCardMark,
  actionCardOf,
  actionCardSaysDone,
  actionCardWords,
  mayApplyCard,
} from "@agenteschat/client/lib/action-cards";
import { delegateLine } from "@agenteschat/client/lib/approval-words";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import { proposalWhy, settingLineText } from "@agenteschat/client/lib/proposals";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, Icon, Text } from "@/ui";
import { ApplyProposal, UndoProposal } from "../agents/InstructionProposalCard";
import { proposalOutcome } from "../agents/logic";
import { AgentProposalView } from "../agents/ProposalCard";
import { useDelegateUndoAction } from "../agents/RightHandDelegate";
import { type AskAnswer, AskButtons, AskCard, AskFoot } from "../chat/asks";
import { useFailed } from "../routines/hooks";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId, useWhen } from "../shared/hooks";

/**
 * The right hand's card of a teammate's settings (ADR 0137), as on the web: a row per agent, each applied or left out
 * by the agent's review (ADR 0219).
 */
export function SettingsProposals({ message: m }: { message: Message }) {
  const { orgId } = useOrg();
  const card = actionCardOf(m.meta);
  const ids = card?.kind === "settings_proposal" ? card.proposalIds : [];
  const rows = useCardProposals(orgId, ids);
  if (m.author.type !== "agent") return null;
  if (card?.kind === "workspace_action")
    return (
      <WorkspaceActionView
        where={{ messageId: m.id, channelId: m.channelId }}
        agentId={m.author.id ?? null}
        card={card}
        actions={m.actions}
      />
    );
  return (
    <>
      {rows.map((p, i) => (
        <SettingsRow
          key={p.id}
          p={p}
          message={m}
          delegate={card?.kind === "settings_proposal" ? card.delegate : null}
          first={i === 0}
        />
      ))}
    </>
  );
}

/**
 * "Ask an admin" in the inbox of whoever may decide it (`change_request`): the same card. A settings row says how its
 * review ended (ADR 0219); a new agent's is created as them from here.
 */
export function ChangeRequestCard({ n }: { n: AppNotification }) {
  if (n.source.action && n.source.messageId)
    return <InboxActionCard messageId={n.source.messageId} agentId={n.source.agentId ?? null} />;
  return <ChangeRequestProposal n={n} />;
}

/** A card of a workspace change sent to this person's inbox: read on its own, decided here as them. */
function InboxActionCard({ messageId, agentId }: { messageId: string; agentId: string | null }) {
  const { orgId } = useOrg();
  const view = useActionCard(orgId, messageId).data;
  if (!view) return null;
  return (
    <WorkspaceActionView
      where={{ messageId: view.messageId, channelId: view.channelId }}
      agentId={agentId}
      card={view.card}
    />
  );
}

function ChangeRequestProposal({ n }: { n: AppNotification }) {
  const { orgId } = useOrg();
  const proposalId = n.source.proposalId;
  const [p] = useCardProposals(orgId, proposalId ? [proposalId] : []);
  const agentCard = useAgentProposal(orgId, proposalId ? null : (n.source.messageId ?? null)).data;
  if (p) return <SettingsRow p={p} />;
  if (!agentCard) return null;
  return (
    <AgentProposalView
      messageId={agentCard.messageId}
      proposerId={agentCard.proposedByAgentId}
      sentAt={n.createdAt}
      card={agentCard}
    />
  );
}

/** A row with no card around it (the history of agents' improvements). */
export const ChangeRequestRow = ({ p }: { p: Proposal }) => <SettingsRow p={p} />;

/**
 * One row: the agent in the well, "Model: Haiku → Sonnet" a line each, and how it ended. Nobody is asked to apply
 * it (ADR 0219): the agent's review applies it or leaves it out a few seconds after, so it reads "Reviewing…" until
 * then, then who did it, the review's why and Undo while the viewer may put it back.
 */
function SettingsRow({
  p,
  message,
  delegate,
  first = true,
}: {
  p: Proposal;
  message?: Message;
  /** The right hand looked at the card for the person it is for (ADR 0139): one decision, Desfazer on the first row. */
  delegate?: CardDelegate | null;
  first?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const c = useColors();
  const modelLabel = useModelLabel();
  const channels = useChannels(orgId).data ?? [];
  const roles = useRoles(orgId).data?.roles ?? [];
  const delegateUndo = useDelegateUndoAction(first ? delegate : null, p.agentId);
  const when = useWhen();
  const agent = dir.anyAgent(p.agentId);
  const proposer = p.proposedByAgentId ?? p.agentId;
  const name = agent?.name ?? t("channel.unknownAgent");
  const g = agentGrammar(name);
  const lines = (p.settings ?? []).map((l) =>
    settingLineText(t, i18n.language, l, {
      model: (id) => modelLabel(id) ?? id,
      person: (id) => dir.memberById.get(id)?.name,
      channel: (id) => channels.find((ch) => ch.id === id)?.name,
      role: (id) => roles.find((r) => r.id === id)?.name,
    }),
  );
  const delegated = delegate
    ? delegateLine(
        t,
        delegate,
        meId ?? null,
        (id) => dir.memberById.get(id)?.name,
        dir.anyAgent(delegate.agentId)?.name ?? "",
      )
    : null;
  const byRightHand = delegated && (delegate?.state === "approved" || delegate?.state === "undone");
  const outcome = proposalOutcome(t, p, meId);

  // Ended: the same card, the lines it changed still there, and who did it, when, why and Undo where a request's
  // decision would be. Put back from its receipt (an older card's Undo) reads undone too, with nothing left to undo.
  let answer: AskAnswer | null = null;
  if (!outcome.reviewing) {
    const receipt = message?.actions?.find((a) => a.id === p.undoActionId);
    const back = Boolean(receipt?.undoneAt);
    const who = byRightHand ? delegated : outcome.words;
    answer = {
      done: outcome.applied && !back && delegate?.state !== "undone",
      words: back ? `${who} · ${t("rightHand.card.undone")}` : (who ?? ""),
      time: outcome.at ? when.short(outcome.at) : undefined,
      note: byRightHand ? delegate?.reason : outcome.why,
      actions: byRightHand ? (
        delegateUndo
      ) : p.undoable && !back ? (
        <UndoProposal id={p.id} />
      ) : p.applicable ? (
        <ApplyProposal id={p.id} />
      ) : null,
    };
  }
  return (
    <AskCard
      id={p.id}
      kind="proposal"
      agentId={proposer}
      waitsFor={outcome.reviewing ? outcome.words : null}
      answer={answer}
      lead={proposalWhy(t, p) || t("proposals.titleSettings", g)}
      well={{
        tile: <AgentFace agentId={p.agentId} size={20} live={false} />,
        title: t("rightHand.card.settings", { name }),
        detail: [agent?.handle ? `@${agent.handle}` : null, agent?.role].filter(Boolean).join(" · "),
      }}
      body={
        lines.length > 0 ? (
          <View style={styles.lines}>
            {first && delegated && !answer ? (
              <Text variant="footnote" tone="muted">
                {delegated}
              </Text>
            ) : null}
            {lines.map((l) => (
              <View
                key={`${l.field}:${l.to}`}
                style={styles.line}
                accessible
                accessibilityLabel={`${l.field}: ${l.from} ${t("rightHand.card.to")} ${l.to}`}
              >
                <Text variant="footnote" tone="muted" style={styles.field}>
                  {l.field}
                </Text>
                <Text variant="footnote" tone="faint" style={styles.from}>
                  {l.from}
                </Text>
                <Icon name="right" size={12} color={c.faint} />
                <Text variant="footnote" tone="ink" style={styles.to}>
                  {l.to}
                </Text>
              </View>
            ))}
          </View>
        ) : undefined
      }
    />
  );
}

/**
 * The right hand's card of a change in the workspace (`workspace_action`), as on the web: what it does in the app's own
 * words, applied as whoever taps with the permissions its screen checks. Decided, one pill with who did it and when.
 */
function WorkspaceActionView({
  where,
  agentId,
  card,
  actions,
}: {
  where: { messageId: string; channelId: string };
  agentId: string | null;
  card: WorkspaceActionCard;
  actions?: AgentAction[];
}) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const failed = useFailed();
  const when = useWhen();
  const decide = useDecideActionCard(orgId, { ...where, action: card.params.action });
  const say = t as unknown as (key: string, values: Record<string, string | number>) => string;
  const sentence = say(actionCardKey(card), actionCardWords(card, t));
  const plain = sentence.replace(/<\/?b>/g, "");
  // The answer to their own tap says more than the card everyone reads (an address that already held an invitation).
  const own = decide.data?.card;
  const detail = actionCardDetail(own?.state === "applied" ? own : card, t, i18n.language);
  const may = mayApplyCard(card, { userId: meId ?? "", may: (key) => can(org, key) });
  const mine = card.forUserId === meId;
  // Whoever applies it for someone else reads who asked, in the conversation and in their inbox.
  const asker = mine ? undefined : dir.memberById.get(card.forUserId)?.name;
  const mark = actionCardMark(card);
  // Decided: the same card, and who did it and when where the buttons were.
  let answer: AskAnswer | null = null;
  if (card.state !== "pending") {
    const receipt = actions?.find((a) => a.kind === "workspace.changed");
    const byMe = card.decidedByUserId === meId;
    const name = dir.memberById.get(card.decidedByUserId ?? "")?.name ?? "";
    const who =
      card.state === "applied"
        ? byMe
          ? t("rightHand.card.appliedByYou")
          : t("rightHand.card.appliedBy", { name })
        : byMe
          ? t("rightHand.card.declinedByYou")
          : t("rightHand.card.declinedBy", { name });
    answer = {
      done: card.state === "applied" && !receipt?.undoneAt,
      words: receipt?.undoneAt ? `${who} · ${t("rightHand.card.undone")}` : who,
      time: card.decidedAt ? when.short(card.decidedAt) : undefined,
    };
  }
  const decision = may ? (
    <AskButtons
      primary={
        <Button
          variant="primary"
          size="card"
          wide
          label={t(actionCardApplyKey(card))}
          disabled={decide.isPending}
          loading={decide.isPending && decide.variables === "apply"}
          onPress={() => decide.mutate("apply", { onError: failed })}
        />
      }
      secondary={
        <Button
          variant="secondary"
          size="card"
          wide
          label={t(mine ? "rightHand.card.dismiss" : "rightHand.card.decline")}
          disabled={decide.isPending}
          onPress={() => decide.mutate("dismiss", { onError: failed })}
        />
      }
    />
  ) : card.askedAt ? (
    <Text variant="small" tone="muted">
      {t("rightHand.card.sentToAny", { when: when.short(card.askedAt) })}
    </Text>
  ) : mine ? (
    <Button
      variant="primary"
      size="card"
      wide
      icon="send"
      label={t("rightHand.action.ask")}
      loading={decide.isPending}
      onPress={() => decide.mutate("ask", { onError: failed })}
    />
  ) : null;
  return (
    <AskCard
      id={where.messageId}
      kind="proposal"
      headless={actionCardSaysDone(card)}
      kindNote={asker ? t("audit.behind.person", { name: asker }) : undefined}
      agentId={agentId ?? ""}
      waitsFor={may ? "you" : t("rightHand.action.only")}
      answer={answer}
      lead={card.params.why || plain}
      well={{
        tile: <Icon name={mark === "channel" ? "hash" : mark} size={16} />,
        title: plain,
        ...(detail ? { detail } : {}),
      }}
      foot={decision ? <AskFoot>{decision}</AskFoot> : undefined}
    />
  );
}

const styles = StyleSheet.create({
  lines: { gap: 6 },
  line: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  field: { fontWeight: "500", minWidth: 96 },
  from: { textDecorationLine: "line-through" },
  to: { fontWeight: "600" },
});
