import { type PendingReturn, useCancelFollowUp } from "@agenteschat/client";
import { markedPieces, markInk } from "@agenteschat/client/lib/activity";
import { returnClock, returnFaces, returnSentence, returnWhen } from "@agenteschat/client/lib/agent-work";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, Icon, Popover, useNow } from "@agenteschat/ui";
import { type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { useChannelActions } from "@/components/channel-actions";
import { useOrg } from "@/components/org-context";
import { WaitMark } from "@/components/RequestCard";
import { useDirectory } from "@/hooks/useDirectory";
import { useFitStep } from "@/hooks/useFitStep";
import { useToast } from "@/lib/toast";
import "./threads/threads.css";

/**
 * The bar above the composer at rest (ADR 0037 addendum of 2026-11-13): while nobody works here and a return waits,
 * the live pill's box holds it, bare: up to three faces (one per agent), the clock (the amber wait mark when it waits on
 * the reader's answer), "Ada retorna às 00:32", " · " and her words, "+1", then ⋯ with the list. Her words stay whole
 * or leave the line with their " · " (CSS: they wrap onto a line the box hides); where even the sentence doesn't fit it
 * says the name and the time ("Ada 00:32"), and only then does the name end in "…": the time always shows. Never a
 * second line: work takes the same box.
 */
export function ReturnLine({
  returns,
  channelId,
  canAnswer,
}: {
  /** The returns here, the soonest first (`returnsHere`). */
  returns: PendingReturn[];
  channelId: string;
  /** The reader may answer here: a return held on an answer is theirs to free. */
  canAnswer: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  // "amanhã às 09:00" turns into "às 09:00" 12 h before.
  const now = useNow(60_000);
  const text = useRef<HTMLSpanElement>(null);
  const first = returns[0];
  const name = first ? (dir.anyAgent(first.agentId)?.name ?? t("channel.unknownAgent")) : "";
  const sentence = first ? returnSentence(t, i18n.language, first, markInk(name), { canAnswer, now }) : "";
  const step = useFitStep(text, 2, `${sentence}|${first?.about ?? ""}`, ".ac-typing__said > b");
  if (!first) return null;
  const words =
    step === 1 && !first.held
      ? returnSentence(t, i18n.language, first, markInk(name), { canAnswer, now, short: true })
      : sentence;
  return (
    <>
      <span className="ac-typing__avatars" aria-hidden="true">
        {returnFaces(returns).map((id) => (
          <span key={id} className="ac-typing__tok">
            <AgentAvatar agentId={id} size="xs" name={dir.anyAgent(id)?.name ?? ""} state="idle" />
          </span>
        ))}
      </span>
      {first.held && canAnswer ? <WaitMark /> : <Icon name="clock" size={14} className="ac-typing__rest-mark" />}
      <span ref={text} className="ac-typing__text ac-typing__rest">
        {/* The name gives way, never the time after it. A new sentence fades in. */}
        <span key={words} className="ac-typing__said">
          {markedPieces(words).map((p, i) =>
            // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence, in order
            p.bold ? <b key={i}>{p.text}</b> : <span key={i}>{p.text}</span>,
          )}
        </span>
        {step === 0 && !first.held && first.about && (
          <span className="ac-typing__about">
            <span className="ac-typing__about-dot"> · </span>
            {first.about}
          </span>
        )}
      </span>
      {returns.length > 1 && (
        <span className="ac-typing__more">{t("ask.bar.more", { count: returns.length - 1 })}</span>
      )}
      <ReturnsPopover returns={returns} channelId={channelId} canAnswer={canAnswer} now={now}>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="more"
          className="ac-typing__menu"
          aria-label={t("followUps.title")}
          title={t("followUps.title")}
        />
      </ReturnsPopover>
    </>
  );
}

/**
 * "Retornos": every return here, the soonest first, as the pins' list builds its rows (`thread-pop pins-pop`): her
 * face, her name with the time at the line's end (the wait mark when it waits on an answer), her words whole under them.
 * A row goes to the reply that said it, lit; the × cancels, for who may (`canCancel`), with no confirm: its spinner
 * while it goes, then the row leaves.
 */
function ReturnsPopover({
  returns,
  channelId,
  canAnswer,
  now,
  children,
}: {
  returns: PendingReturn[];
  channelId: string;
  canAnswer: boolean;
  now: number;
  children: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useChannelActions();
  const toast = useToast();
  const cancel = useCancelFollowUp(org.id);
  const [open, setOpen] = useState(false);
  const [going, setGoing] = useState<ReadonlySet<string>>(() => new Set());
  const mark = (id: string, on: boolean) =>
    setGoing((was) => {
      const next = new Set(was);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <Popover
      open={open && returns.length > 0}
      onOpenChange={setOpen}
      side="top"
      align="end"
      className="thread-pop pins-pop returns-pop"
      label={t("followUps.title")}
      trigger={children}
    >
      <div className="thread-pop__head">
        <b>{t("followUps.title")}</b>
        <small>{returns.length}</small>
      </div>
      <div className="thread-pop__list">
        {returns.map((r) => {
          const name = dir.anyAgent(r.agentId)?.name ?? t("channel.unknownAgent");
          const g = agentGrammar(name);
          const busy = going.has(r.messageId);
          const reply = r.replyMessageId;
          const row = (
            <>
              <span className="ac-mediarow__face">
                <ActorAvatar actor={{ type: "agent", id: r.agentId }} name={name} />
              </span>
              <span className="ac-mediarow__head thread-pop__name">
                <b>{name}</b>
              </span>
              <small className="ac-mediarow__end pins-pop__time">
                {r.held ? <WaitMark still={!canAnswer} /> : returnClock(t, i18n.language, r.at, now)}
              </small>
              <small className="ac-mediarow__body thread-pop__sub returns-pop__about">{r.about}</small>
            </>
          );
          return (
            <div key={r.messageId} className="pins-pop__item">
              {reply ? (
                <button
                  type="button"
                  className="thread-pop__row ac-mediarow"
                  title={t("followUps.see")}
                  onClick={() => {
                    setOpen(false);
                    actions?.jumpTo?.(reply);
                  }}
                >
                  {row}
                </button>
              ) : (
                <div className="thread-pop__row ac-mediarow returns-pop__still">{row}</div>
              )}
              {r.canCancel && (
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon="close"
                  aria-label={t("followUps.cancelOf", {
                    name: g.name,
                    context: g.context,
                    when: returnWhen(t, i18n.language, r.at, now),
                  })}
                  title={t("followUps.cancel")}
                  loading={busy}
                  onClick={() => {
                    mark(r.messageId, true);
                    cancel.mutate(
                      { channelId, messageId: r.messageId },
                      {
                        onError: (error) => toast.show(errorText(t, error), "error"),
                        onSettled: () => mark(r.messageId, false),
                      },
                    );
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </Popover>
  );
}
