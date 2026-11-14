import { type Message, useExchangeConversation } from "@agenteschat/client";
import { consultLineState, consultOriginKey } from "@agenteschat/client/lib/consult-group";
import { consultSubject } from "@agenteschat/client/lib/consultations";
import { dayLabel, formatTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { buildTimeline } from "@agenteschat/client/lib/timeline";
import { AvatarStack, Button, DayDivider, Dialog, DialogFooter, Icon, PixelSpinner } from "@agenteschat/ui";
import { Fragment, type ReactNode, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { MessageBody } from "@/chat/MessageBody";
import { AgentAvatar } from "@/components/AgentAvatar";
import { consultLineLabel } from "@/components/ConsultGroup";
import { type ChannelActions, ChannelActionsContext } from "@/components/channel-actions";
import { ErrorState, LoadingConversation } from "@/components/Loading";
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
 * question is out.
 */
export function ConsultationDialog({
  channelId,
  channelName,
  consultationId,
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
  // The whole exchange its row stands for: the other questions between the same two agents come in it too.
  const query = useExchangeConversation(org.id, channelId, consultationId);
  const c = query.data?.consultation;
  const list = query.data?.messages;
  const now = useNow(c?.status === "open");
  const items = useMemo(() => buildTimeline(list ?? [], [], []), [list]);
  const asker = c ? dir.agentById.get(c.agentId) : undefined;
  const consulted = c ? dir.agentById.get(c.consultedAgentId) : undefined;
  const from = agentGrammar(asker?.name ?? t("channel.unknownAgent"));
  const to = agentGrammar(consulted?.name ?? t("channel.unknownAgent"));
  const label = t("chat.consultPanel.label", {
    from: from.name,
    to: to.name,
  });
  const subject = consultSubject(c?.question);
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
  for (const item of items) {
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
            {to.name}
          </span>
        }
        subtitle={
          <>
            {subject && <span className="thread-head__subject">{subject}</span>}
            <span className="thread-head__meta">
              <span className="thread-head__where">
                {channelName ? t("chat.consultPanel.where", { channel: channelName }) : t("chat.consultPanel.whereDm")}
              </span>
              {list && list.length > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{t("chat.consultPanel.messages", { count: list.length })}</span>
                </>
              )}
            </span>
          </>
        }
        leading={
          c && (
            <AvatarStack>
              <AgentAvatar agentId={c.agentId} size="sm" name={from.name} state="idle" />
              <AgentAvatar
                agentId={c.consultedAgentId}
                size="sm"
                name={to.name}
                state={state === "working" ? "thinking" : state === "waiting" ? "waiting" : "idle"}
              />
            </AvatarStack>
          )
        }
        closeLabel={t("common.close")}
        width={620}
        className="consult-dialog"
      >
        <section className="channel__messages consult-dialog__list" aria-label={label}>
          {query.isLoading && <LoadingConversation />}
          {query.isError && !query.data && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
          {query.isSuccess && !query.data && <p className="thread-origin">{t("chat.consultPanel.missing")}</p>}
          {c && (
            <p className="thread-origin ac-iconline">
              <Icon name="agent" size={14} />
              <span>
                {t(consultOriginKey(c, Boolean(channelName)), {
                  from: from.name,
                  to: to.name,
                  channel: channelName,
                  time: formatTime(i18n.language, c.createdAt),
                })}
              </span>
            </p>
          )}
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
