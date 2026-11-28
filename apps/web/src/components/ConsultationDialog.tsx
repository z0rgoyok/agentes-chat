import { type Message, useConsultations, useExchangeConversation } from "@agenteschat/client";
import {
  type ConsultLineState,
  type ConsultPairItem,
  consultChoiceKey,
  consultChoiceOf,
  consultChoices,
  consultLineState,
  openableConsultation,
} from "@agenteschat/client/lib/consult-group";
import { dayLabel, joinNames, namesText } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { buildTimeline } from "@agenteschat/client/lib/timeline";
import { AvatarStack, Button, DayDivider, Dialog, DialogFooter, Icon, PixelSpinner, Segmented } from "@agenteschat/ui";
import { Fragment, type ReactNode, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageBody } from "@/chat/MessageBody";
import { AgentAvatar } from "@/components/AgentAvatar";
import { consultLineLabel } from "@/components/ConsultGroup";
import { type ChannelActions, ChannelActionsContext } from "@/components/channel-actions";
import { ErrorState, LoadingConversation } from "@/components/Loading";
import { MetaLine } from "@/components/MetaLine";
import { useNow } from "@/components/missions/MissionBits";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";

/**
 * A question an agent asked another from this conversation, opened over it in a dialog ("Theo ⇄ Iris", from its line
 * in the reply's block), as a long message opens whole: the question as it went to the other agent, what that agent
 * wrote, and the cards it posted here (an approval, a question, a secret request), drawn as the conversation draws
 * them (`renderMessage`). Read only: people don't write in the agents' DM; to change course they talk to the agent
 * that asked (`onTalk` puts its handle in the composer). The DM sends this page no events: it reloads while the
 * question is out. Opened from a row of several asked agents (`group`), it is named as the row is ("Theo ⇄ Atlas e
 * mais 1") and offers one choice per agent, saying where each stands, to read each exchange in turn.
 */
export function ConsultationDialog({
  channelId,
  channelName,
  consultationId: opened,
  group,
  onClose,
  onTalk,
  onAnswer,
  renderMessage,
}: {
  /** The conversation that asked (its access opens the question). */
  channelId: string;
  /** Its name; null in a DM, where the dialog names no channel. */
  channelName: string | null;
  consultationId: string;
  /** The questions of the row that opened it, when it stands for several agents. */
  group?: readonly ConsultPairItem[];
  onClose: () => void;
  /** "Falar com o Theo": closes the dialog and mentions the agent that asked. */
  onTalk: (handle: string) => void;
  /** "Responder" on a question card: closes the dialog for the conversation's composer. */
  onAnswer: () => void;
  renderMessage: (message: Message, grouped: boolean) => ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  // The row's questions as the conversation's list has them now: an answer arriving shows on its choice.
  const listed = useConsultations(org.id, channelId, Boolean(group && group.length > 1));
  const items = useMemo(
    () => (group ?? []).map((g) => listed.data?.find((c) => c.id === g.id) ?? g),
    [group, listed.data],
  );
  // On the opened agent's own exchange as its asker asked it, so the title and "Falar com" stay on the asker.
  const [pick, setPick] = useState(() =>
    group && group.length > 1
      ? (consultChoiceOf(consultChoices(group, Date.now(), group[0]?.agentId), group, opened)?.opens ?? opened)
      : opened,
  );
  const consultationId = pick;
  // The whole exchange its row stands for: the other questions between the same two agents come in it too.
  const query = useExchangeConversation(org.id, channelId, consultationId);
  const c = query.data?.consultation;
  const list = query.data?.messages;
  const now = useNow(c?.status === "open" || items.some((i) => i.status === "open"));
  const askerOf = items[0]?.agentId;
  const choices = consultChoices(items, now, askerOf).filter((ch) => openableConsultation(ch.opens));
  const several = choices.length > 1;
  const picked = consultChoiceOf(choices, items, pick) ?? choices[0];
  const timeline = useMemo(() => buildTimeline(list ?? [], [], []), [list]);
  // While a chosen exchange loads, the row's asker still names the dialog.
  const asker = dir.agentById.get(c?.agentId ?? askerOf ?? "");
  const consulted = dir.agentById.get(
    c?.consultedAgentId ?? (items.find((i) => i.id === pick) ?? items[0])?.consultedAgentId ?? "",
  );
  const from = agentGrammar(asker?.name ?? t("channel.unknownAgent"));
  const to = agentGrammar(consulted?.name ?? t("channel.unknownAgent"));
  const label = t("chat.consultPanel.label", {
    from: from.name,
    to: to.name,
  });
  const nameOf = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  const state = c ? consultLineState(c, now) : null;
  // The cards keep their buttons (a question answers in its own field); nothing else acts
  // here: no reply, no thread, no quote (the messages live in the agents' DM). Stable: rows don't redraw for it.
  const latest = useRef({ onTalk, onAnswer });
  latest.current = { onTalk, onAnswer };
  const actions = useMemo<ChannelActions>(
    () => ({
      insertMention: (handle) => latest.current.onTalk(handle),
      retry: () => undefined,
      editUnsent: () => undefined,
      resend: () => undefined,
      focusComposer: () => latest.current.onAnswer(),
      channelAgents: [],
    }),
    [],
  );
  // The consulted agent's own words came: its last one is the answer. Left out (its run also answers a question
  // from another conversation), the answer shows on its own.
  const said = list?.some((m) => m.author.id === c?.consultedAgentId && m.channelId !== channelId) ?? false;

  // Read only: to change course, talk to the agent that asked.
  const readOnly = (
    <span className="ac-iconline">
      <Icon name="lock" size={16} />
      <span>
        <b>{t("chat.consultPanel.readOnly")}</b>{" "}
        {t("chat.consultPanel.steer", { name: from.name, context: from.context })}
      </span>
    </span>
  );
  const rows: ReactNode[] = [];
  for (const item of timeline) {
    if (item.kind === "day") rows.push(<DayDivider key={item.key}>{dayLabel(t, i18n.language, item.iso)}</DayDivider>);
    else if (item.kind === "message")
      rows.push(<Fragment key={item.key}>{renderMessage(item.message, item.grouped)}</Fragment>);
  }

  return (
    <ChannelActionsContext.Provider value={actions}>
      <Dialog
        open
        onOpenChange={(open) => !open && onClose()}
        title={
          <span className="consult-title">
            {from.name}
            <Icon name="swap" size={16} label={t("newAgent.and")} inline />
            {several
              ? namesText(
                  t,
                  choices.map((ch) => nameOf(ch.agentId)),
                  1,
                )
              : to.name}
          </span>
        }
        subtitle={
          <MetaLine
            where={
              channelName ? t("chat.consultPanel.where", { channel: channelName }) : t("chat.consultPanel.whereDm")
            }
            parts={list && list.length > 0 ? [t("chat.consultPanel.messages", { count: list.length })] : []}
          />
        }
        leading={
          c && (
            <AvatarStack>
              <AgentAvatar agentId={c.agentId} size="sm" name={from.name} state="idle" />
              {several ? (
                choices
                  .slice(0, 3)
                  .map((ch) => (
                    <AgentAvatar
                      key={ch.agentId}
                      agentId={ch.agentId}
                      size="sm"
                      name={nameOf(ch.agentId)}
                      state={faceState(ch.state)}
                    />
                  ))
              ) : (
                <AgentAvatar agentId={c.consultedAgentId} size="sm" name={to.name} state={faceState(state)} />
              )}
            </AvatarStack>
          )
        }
        closeLabel={t("common.close")}
        width={620}
        className="consult-dialog"
      >
        {several && picked && (
          <Segmented
            size="sm"
            block
            className="consult-dialog__choice"
            label={t("chat.consultPair.labelMany", {
              from: from.name,
              to: joinNames(
                choices.map((ch) => nameOf(ch.agentId)),
                t,
              ),
            })}
            value={picked.agentId}
            onValueChange={(agentId) => setPick(choices.find((ch) => ch.agentId === agentId)?.opens ?? pick)}
            options={choices.map((ch) => ({
              value: ch.agentId,
              mark: <AgentAvatar agentId={ch.agentId} size="xs" name={nameOf(ch.agentId)} state="idle" />,
              label: nameOf(ch.agentId),
              hint: t(consultChoiceKey(ch.state, ch.item)),
            }))}
          />
        )}
        <section
          className="channel__messages consult-dialog__list"
          // Its rows are drawn whole where the browser can't hold the place (layout.css): it never marks them sized.

          aria-label={label}
        >
          {query.isLoading && <LoadingConversation />}
          {query.isError && !query.data && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
          {query.isSuccess && !query.data && <p className="thread-origin">{t("chat.consultPanel.missing")}</p>}
          {rows}
          {c?.status === "answered" && c.answer && !said && (
            <div className="ac-consult__body ac-consult__body--inline consult-answer">
              <small>{t("chat.consultation.answerOf", { name: to.name, context: to.context })}</small>
              <div className="ac-consult__text">
                <MessageBody body={c.answer} resolveMention={dir.mentionName} mentionTone={dir.mentionTone} />
              </div>
            </div>
          )}
          {c && state && state !== "answered" && (
            <p className="cn-line ac-iconline" aria-live="polite">
              {state === "working" ? (
                <PixelSpinner size={14} color={colorOf(consulted)} />
              ) : (
                <Icon
                  name={state === "waiting" || state === "offline" || state === "handedOn" ? "waiting" : "clock"}
                  size={14}
                />
              )}
              <span className="cn-line__text">{consultLineLabel(t, state, c, to)}</span>
            </p>
          )}
        </section>
        <DialogFooter bar note={readOnly}>
          {asker && (
            <Button size="sm" icon="message" onClick={() => onTalk(asker.handle)}>
              {t("chat.consultPanel.talk", { name: from.name, context: from.context })}
            </Button>
          )}
        </DialogFooter>
      </Dialog>
    </ChannelActionsContext.Provider>
  );
}

/** A consulted agent's face by where its question stands: thinking at work, waiting on someone. */
const faceState = (state: ConsultLineState | null) =>
  state === "working" ? "thinking" : state === "waiting" ? "waiting" : "idle";
