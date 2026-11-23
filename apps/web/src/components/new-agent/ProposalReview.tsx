import type { AgentProposalCard, Channel, ProposedRoutine } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, Dialog, DialogBody, DialogFooter, Icon } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { proposedRoutineWhen } from "@/lib/recurrence";

/*
 * "Edit first" on an agent's proposal (ADR 0081, ADR 0164): the new agent's card filled in with the draft, and in the
 * list's place the proposal itself: who proposed it and why, what the person changed (each with Undo), the first task
 * that goes to its chat, and what is left for after it is created (an AI, the apps it needs that aren't connected).
 */

/** The proposal a new agent's dialog reviews: its card as the conversation shows it, read again while it is open. */
export interface ProposalReview {
  /** Its card's message. */
  messageId: string;
  card: AgentProposalCard;
  /** The agent that proposed it (its face beside the reason), and its name. */
  proposerId: string | null;
  proposerName: string;
  /** What "Create and try it" puts in the composer of the person's DM with it: only for the person it was written for. */
  firstTask?: string;
}

/** One thing the person changed from the proposal, with its way back. */
export interface ProposalChange {
  key: string;
  icon: ReactNode;
  label: string;
  /** What it is now ("saiu", "Lê → Lê e escreve"); empty when the label says it all. */
  change: string;
  undo: () => void;
}

/** What is left for after the agent is created, a line each: its chat's checklist asks for them. */
export interface ProposalLater {
  key: string;
  icon: ReactNode;
  text: string;
}

export function ProposalSide({
  review,
  agentName,
  changes,
  later,
  task,
  onTask,
  withWhy = true,
}: {
  review: ProposalReview;
  /** Who proposed it and why; narrow, the dialog's line under its title says it already. */
  withWhy?: boolean;
  /** The agent's name as written on the card now ("" while it has none). */
  agentName: string;
  changes: ProposalChange[];
  later: ProposalLater[];
  task: string;
  onTask: (task: string) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const proposer = review.proposerId ? dir.anyAgent(review.proposerId) : undefined;
  const g = agentGrammar(agentName);
  return (
    <section className="nac-review" aria-label={t("newAgentCard.proposal.side")}>
      {withWhy && (
        <section className="nac-review__sec">
          <span className="nac__label">{t("newAgentCard.proposal.from", agentGrammar(review.proposerName))}</span>
          <div className="nac-review__from">
            <AgentAvatar agent={proposer} name={review.proposerName} size="sm" />
            <p className="nac-review__why">{review.card.params.why}</p>
          </div>
        </section>
      )}
      <section className="nac-review__sec">
        <span className="nac__label">{t("newAgentCard.proposal.changed")}</span>
        {changes.length === 0 ? (
          <p className="nac-review__none">{t("newAgentCard.proposal.changedNone")}</p>
        ) : (
          <ul className="nac-review__list">
            {changes.map((c) => (
              <li key={c.key} className="ac-iconline nac-review__change">
                {c.icon}
                <span className="nac-review__text">
                  <b>{c.label}</b>
                  {c.change ? ` · ${c.change}` : ""}
                </span>
                <button type="button" className="ac-link nac-review__undo" onClick={c.undo}>
                  {t("newAgentCard.proposal.undo")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="nac-review__sec">
        <span className="nac__label">{t("newAgentCard.proposal.firstTask")}</span>
        <span className="nac__how">
          <textarea
            className="nac__instr nac-review__task"
            rows={1}
            value={task}
            maxLength={500}
            placeholder={t("newAgentCard.proposal.firstTaskPlaceholder")}
            aria-label={t("newAgentCard.proposal.firstTask")}
            onChange={(e) => onTask(e.target.value)}
          />
          <Icon name="edit" size={14} className="nac__pen" />
        </span>
        <p className="nac-review__hint">
          {task.trim()
            ? agentName
              ? t("newAgentCard.proposal.firstTaskHint", g)
              : t("newAgentCard.proposal.firstTaskHintBlank")
            : t("newAgentCard.proposal.firstTaskNone")}
        </p>
      </section>
      <section className="nac-review__sec">
        <span className="nac__label">{t("newAgentCard.proposal.after")}</span>
        <ul className="nac-review__list">
          {later.map((l) => (
            <li key={l.key} className="ac-iconline">
              {l.icon}
              <span>{l.text}</span>
            </li>
          ))}
          {later.length === 0 && (
            <li className="ac-iconline">
              <Icon name="check" size={16} />
              <span>
                {agentName ? t("newAgentCard.proposal.afterNone", g) : t("newAgentCard.proposal.afterNoneBlank")}
              </span>
            </li>
          )}
        </ul>
      </section>
    </section>
  );
}

/** A channel on the card ("Trabalha em"): what it is about, what the agent does there, and taking it out. */
export function ChannelDialog({
  channel,
  agentName,
  onRemove,
  onClose,
}: {
  channel: Channel;
  agentName: string;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const g = agentGrammar(agentName);
  const name = `#${channel.name}`;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={name}
      leading={
        <span className="nac-skill__lead">
          <Icon name="channel" size={18} />
        </span>
      }
      description={
        agentName ? t("newAgentCard.proposal.channel.lead", g) : t("newAgentCard.proposal.channel.leadBlank")
      }
      closeLabel={t("common.close")}
      width={460}
      className="nac-app"
    >
      <DialogBody>
        {channel.topic.trim() && <p className="nac-skill__line">{channel.topic.trim()}</p>}
        <p className="nac-app__asks ac-iconline">
          <Icon name="info" size={16} />
          <span>
            {agentName
              ? t("newAgentCard.proposal.channel.does", { ...g, channel: name })
              : t("newAgentCard.proposal.channel.doesBlank", { channel: name })}
          </span>
        </p>
      </DialogBody>
      <DialogFooter
        note={
          <button type="button" className="ac-link" onClick={onRemove}>
            {t("newAgentCard.proposal.channel.remove", { channel: name })}
          </button>
        }
      >
        <Button variant="primary" onClick={onClose}>
          {t("newAgentCard.skill.done")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** The routine the proposal comes with: when it runs and where it reports, what each run does, and taking it out. */
export function RoutineDialog({
  routine,
  where,
  agentName,
  onRemove,
  onClose,
}: {
  routine: ProposedRoutine;
  /** The channel it reports in; null: the person's DM with the agent. */
  where: string | null;
  agentName: string;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const g = agentGrammar(agentName);
  // It opens the sentence: "Every Monday at 9am, in #marketing."
  const said = proposedRoutineWhen(t, i18n.language, routine);
  const when = said.charAt(0).toLocaleUpperCase(i18n.language) + said.slice(1);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={routine.name}
      leading={
        <span className="nac-skill__lead">
          <Icon name="routines" size={18} />
        </span>
      }
      description={
        where
          ? t("newAgentCard.proposal.routine.lead", { when, channel: `#${where}` })
          : t("newAgentCard.proposal.routine.leadDm", { when })
      }
      closeLabel={t("common.close")}
      width={460}
      className="nac-app"
    >
      <DialogBody>
        <blockquote className="nac-skill__body">
          {routine.prompt.length > 400 ? `${routine.prompt.slice(0, 400)}…` : routine.prompt}
        </blockquote>
        <p className="nac-app__asks ac-iconline">
          <Icon name="info" size={16} />
          <span>
            {agentName ? t("newAgentCard.proposal.routine.starts", g) : t("newAgentCard.proposal.routine.startsBlank")}
          </span>
        </p>
      </DialogBody>
      <DialogFooter
        note={
          <button type="button" className="ac-link" onClick={onRemove}>
            {t("newAgentCard.proposal.routine.remove")}
          </button>
        }
      >
        <Button variant="primary" onClick={onClose}>
          {t("newAgentCard.skill.done")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
