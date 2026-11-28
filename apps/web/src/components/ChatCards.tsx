import type { AgentQuestion, MemoryUpdate, Proposal, SecretRequest, SecretToVaultInput } from "@agenteschat/client";
import {
  useApplyProposal,
  useCardProposals,
  useModelLabel,
  useSaveSecretToVault,
  useUndoProposal,
} from "@agenteschat/client";
import { questionWaitsOn } from "@agenteschat/client/lib/agent-questions";
import { formatTime, upperFirst, whenAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { MAX_MESSAGE_LENGTH } from "@agenteschat/client/lib/message-length";
import { messagePath } from "@agenteschat/client/lib/message-links";
import { can } from "@agenteschat/client/lib/permissions";
import {
  appLabel,
  cardHead,
  cardProposalIds,
  firstChange,
  proposalSections,
  proposalTarget,
  proposalTitle,
  proposerOf,
  settingLineText,
} from "@agenteschat/client/lib/proposals";
import { sealSecret, secretAad } from "@agenteschat/client/lib/secret-box";
import {
  latestSecret,
  secretClosedBy,
  secretLabel,
  secretRefusalKey,
  secretValueProblem,
  secretWhere,
} from "@agenteschat/client/lib/secret-requests";
import { secretEndedAt, secretOutcome } from "@agenteschat/client/lib/secret-words";
import { Button, Chip, CodeInput, diffLines, Icon, Input, overLimit, Textarea } from "@agenteschat/ui";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useDirectory } from "@/hooks/useDirectory";
import { useTextLimit } from "@/hooks/useTextLimit";
import { TYPED_VALUES } from "@/i18n";
import { inPlaceClick } from "@/lib/navigate";
import { useToast } from "@/lib/toast";
import { useLive, useLiveStore } from "@/realtime/context";
import { AgentAvatar } from "./AgentAvatar";
import { useOpenAgentPanel } from "./agent-panel-context";
import { SiteIcon } from "./browser/SiteIcon";
import { useOrg } from "./org-context";
import { ProseDiff } from "./ProseDiff";
import {
  type RequestAnswer,
  RequestCard,
  RequestChoices,
  RequestKeys,
  RequestTile,
  showRequest,
  useExpired,
} from "./RequestCard";
import { savesToVault, VaultSaveBlock, type VaultSaveChoice, vaultSaveDefaults } from "./vault/VaultSave";
import "./proposals.css";

/** How long a failed "Save to the Vault" keeps the typed value for Retry (ADR 0144), at most. */
const VAULT_RETRY_MS = 2 * 60_000;

/** The host of a site the request names (`https://host`), or null. */
const hostOf = (site: string | null | undefined) => {
  if (!site) return null;
  try {
    return new URL(site).host || null;
  } catch {
    return null;
  }
};

/**
 * "Memória atualizada" in the chat (`memory.updated`): what the agent
 * remembered, forgot or updated because a person asked, a link to what it
 * knows (its page's Memória tab in the panel beside the conversation), and "Desfazer"
 * (`POST …/memories/{id}/revert`) for who may still undo it. A proposed change shows the proposal inline instead.
 */
export function MemoryChangeCard({ update, agentId }: { update: MemoryUpdate; agentId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const openPanel = useOpenAgentPanel();
  if (update.action === "proposed") {
    const ids = cardProposalIds(update);
    if (ids.length > 1) return <ProposalGroup proposalIds={ids} />;
    return ids[0] ? <InlineProposal proposalId={ids[0]} /> : null;
  }
  const name = dir.anyAgent(agentId)?.name ?? t("channel.unknownAgent");
  const g = agentGrammar(name);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div
      className="ac-approval ac-approval--done ac-memory-card"
      role="group"
      aria-label={t("memoryCard.group", { name })}
    >
      <div className="ac-approval__head ac-tailrow">
        <span className="ac-approval__who">
          <b>{t(`memoryCard.${update.action}`, { name })}</b>
        </span>
        <Chip icon="check" className="ac-tail">
          {t("memoryCard.chip")}
        </Chip>
      </div>
      <p className={update.action === "forgot" ? "ac-approval__title struck" : "ac-approval__title"}>{update.text}</p>
      {update.action === "updated" && update.previousText && (
        <p className="small muted" style={{ margin: 0 }}>
          {t("memoryCard.was", { text: update.previousText })}
        </p>
      )}
      {/* The memory itself, where it is fixed or forgotten. */}
      <div className="ac-approval__actions ac-acts">
        <Button asChild variant="ghost" size="sm">
          <Link
            to="/org/$orgId/agents/$agentId/memory"
            params={{ orgId: org.id, agentId }}
            search={{ item: update.itemId }}
            onClick={openPanel ? (e) => inPlaceClick(e, () => openPanel(agentId, "memory", update.itemId)) : undefined}
          >
            {t("memoryCard.open", g)}
          </Link>
        </Button>
      </div>
    </div>
  );
}

/** What a role or access proposal changes: "Função: Dev → Revisora", or a chip per app turned on or off. */
export function SettingChange({ p }: { p: Proposal }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const modelLabel = useModelLabel();
  if (p.target.type === "agent_role")
    return <span className="proposal-change">{t("proposals.roleLine", { from: p.before, to: p.after })}</span>;
  // The right hand's settings (ADR 0137): "Modelo: Haiku → Sonnet", a line each.
  if (p.target.type === "agent_settings")
    return (
      <span className="proposal-change">
        {(p.settings ?? [])
          .map((l) => {
            const line = settingLineText(t, i18n.language, l, {
              model: (id) => modelLabel(id) ?? id,
              person: (id) => dir.memberById.get(id)?.name,
              channel: () => undefined,
              role: dir.roleName,
            });
            return `${line.field}: ${line.from} → ${line.to}`;
          })
          .join(" · ")}
      </span>
    );
  return (
    <span className="proposal-change proposal-change--apps">
      {(p.access ?? []).map((l) => (
        <Chip key={l.id} icon={l.on ? "plus" : "dash"}>
          {t(l.on ? "proposals.accessOn" : "proposals.accessOff", { app: appLabel(t, l) })}
        </Chip>
      ))}
    </span>
  );
}

export const isText = (p: Proposal) => p.target.type === "agent_instructions" || p.target.type === "org_context";
/** What shows a diff: a text, or a skill's. */
const hasDiff = (p: Proposal) => isText(p) || p.target.type === "skill";

/** Still being weighed by the agent's review (ADR 0219): nothing is applied yet, for a few seconds. */
export const isReviewing = (p: Pick<Proposal, "status" | "stale">) => p.status === "pending" && !p.stale;

/**
 * How a proposal ended, in words (ADR 0219): the agent's review applied it ("Applied by Ada", or automatically for a
 * workspace-wide lesson no agent holds) or left it out, someone put it back, or a person decided it. While the review
 * weighs it, "Reviewing…".
 */
export function proposalOutcome(t: TFunction, p: Proposal, meId: string): string {
  if (p.stale) return t("proposals.stale");
  if (p.status === "pending") return t("proposals.reviewing");
  if (p.status === "undone") {
    if (!p.undoneBy) return t("rightHand.card.undone");
    return p.undoneBy.userId === meId ? t("proposals.undoneByYou") : t("proposals.undoneBy", { name: p.undoneBy.name });
  }
  const agent = p.decidedByAgent ? p.decidedByAgent.name || t("channel.unknownAgent") : null;
  if (p.reviewed) {
    if (p.status === "accepted")
      return agent ? t("proposals.appliedByAgent", agentGrammar(agent)) : t("proposals.appliedAuto");
    return agent ? t("proposals.leftOutBy", agentGrammar(agent)) : t("proposals.leftOut");
  }
  const by = p.decidedBy;
  if (!by) return t(p.status === "accepted" ? "proposals.accepted" : "proposals.refused");
  const mine = by.userId === meId;
  if (p.status === "accepted")
    return mine ? t("rightHand.card.appliedByYou") : t("rightHand.card.appliedBy", { name: by.name });
  return mine ? t("rightHand.card.declinedByYou") : t("rightHand.card.declinedBy", { name: by.name });
}

/** A card's rows in one line: how they ended when they all read the same, else how many were applied. */
export function proposalsOutcome(t: TFunction, rows: Proposal[], meId: string): string {
  const words = [...new Set(rows.map((p) => proposalOutcome(t, p, meId)))];
  if (words.length === 1 && words[0]) return words[0];
  const done = rows.filter((p) => p.status === "accepted" && !p.stale).length;
  return t("proposals.appliedSome", { done, total: rows.length });
}

/** When it ended: put back, else decided. */
export const proposalEndedAt = (p: Pick<Proposal, "undoneAt" | "decidedAt">) => p.undoneAt ?? p.decidedAt;

/**
 * The one action on a decided change, for whoever may make it: "Undo" on one that was applied (ADR 0219), put back as
 * them; "Apply anyway" on one the review left out, applied as them. The row then reads undone or applied by them. A
 * failure (it changed since) is the app's toast in their words. Nothing when neither applies.
 */
export function ProposalAction({
  p,
  variant = "ghost",
  className,
}: {
  p: Proposal;
  variant?: "ghost" | "link";
  className?: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const undo = useUndoProposal(org.id);
  const apply = useApplyProposal(org.id);
  const act = p.undoable ? undo : p.applicable ? apply : null;
  if (!act) return null;
  return (
    <Button
      size="sm"
      variant={variant}
      className={className}
      loading={act.isPending}
      disabled={undo.isPending || apply.isPending}
      onClick={() => act.mutate(p.id)}
    >
      {t(p.undoable ? "proposals.undo" : "proposals.applyAnyway")}
    </Button>
  );
}

/**
 * A change an agent proposed in the chat (`message.meta.proposalId`, or a card of one), and how it ended: nobody
 * decides it here (ADR 0219). While the agent's review weighs it the header says so; then the footer says whether it
 * was applied or left out, and why, with Undo while it may be put back. The change is behind "See the change".
 */
export function InlineProposal({ proposalId }: { proposalId: string }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const [p] = useCardProposals(org.id, [proposalId]);
  if (!p) return null;
  const agentName = (id: string) => dir.anyAgent(id)?.name ?? t("channel.unknownAgent");
  const name = agentName(proposerOf(p));
  // Written to follow "propõe ·", lowercase in most languages: a title starts with a capital.
  const target = upperFirst(proposalTarget(t, p, agentName, org), i18n.language);
  const reviewing = isReviewing(p);
  const diff = (
    <ProseDiff label={t("proposals.changeLabel")} lines={diffLines(p.before.split("\n"), p.after.split("\n"))} />
  );

  // A request card, the change behind "See the change". Decided, or overtaken by a newer text, it is the same card: how
  // it ended in its footer.
  const before = new Set(p.before.split("\n"));
  const firstNew = hasDiff(p)
    ? p.after
        .split("\n")
        .find((line) => line.trim() && !before.has(line))
        ?.trim()
    : undefined;
  return (
    <RequestCard
      id={p.id}
      kind="proposal"
      agent={dir.anyAgent(proposerOf(p))}
      label={t("inlineProposal.group", { name })}
      mine={false}
      waitingFor={reviewing ? t("proposals.reviewing") : undefined}
      answer={reviewing ? undefined : proposalAnswer(t, i18n.language, [p], me.user.id)}
      lead={proposalTitle(t, p, org, agentName)}
      object={{
        logo: (
          <RequestTile>
            <Icon name={p.target.type === "agent_access" ? "layers" : "file"} size={16} />
          </RequestTile>
        ),
        title: target,
        detail: p.target.type === "agent_role" ? t("proposals.roleLine", { from: p.before, to: p.after }) : firstNew,
        ...(hasDiff(p) ? { more: t("ask.seeChange") } : {}),
      }}
      details={
        hasDiff(p) ? (
          <>
            {diff}
            <div className="ac-acts">
              <ProposalsLink agentId={p.agentId} />
            </div>
          </>
        ) : undefined
      }
      // A new role reads in the well; the apps are chips, under it. Neither has anything to open.
      body={
        p.target.type === "agent_access" ? (
          <div className="rq__field">
            <SettingChange p={p} />
          </div>
        ) : undefined
      }
      what={target}
    />
  );
}

/**
 * How a card of proposals ended, for its footer: how its rows ended, when the last one did and, for a card of one, the
 * review's why under it and Undo (a card of several says those on each row).
 */
function proposalAnswer(t: TFunction, locale: string, rows: Proposal[], meId: string): RequestAnswer {
  // A row overtaken by a newer text was never decided.
  const at = rows
    .flatMap((p) => proposalEndedAt(p) ?? [])
    .sort()
    .at(-1);
  const only = rows.length === 1 ? rows[0] : undefined;
  return {
    done: rows.some((p) => p.status === "accepted" && !p.stale),
    text: proposalsOutcome(t, rows, meId),
    note: only?.review ?? undefined,
    time: at ? whenAt(t, locale, at) : undefined,
    action: only ? <ProposalAction p={only} /> : undefined,
  };
}

function ProposalsLink({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <Button asChild variant="ghost" size="sm">
      <Link to="/org/$orgId/proposals" params={{ orgId: org.id }} search={{ agent: agentId }}>
        {t("inlineProposal.open")}
      </Link>
    </Button>
  );
}

/**
 * One change proposed for several agents (or several changes for one): each change shown once, then a row per agent
 * and kind of change saying how it ended (ADR 0219): while the agent's review weighs them, the header says so; then
 * each row applied or left out, its why under it, and Undo on the ones that may be put back.
 */
export function ProposalGroup({ proposalIds }: { proposalIds: string[] }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const rows = useCardProposals(org.id, proposalIds);
  const [first] = rows;
  if (!first) return null;
  const agentName = (id: string) => dir.anyAgent(id)?.name ?? t("channel.unknownAgent");
  const proposer = agentName(proposerOf(first));
  const head = cardHead(t, rows, proposer, agentName, org);
  const agents = new Set(rows.map((p) => p.agentId)).size;

  const label = t("inlineProposal.groupMany", { name: proposer, count: agents });
  const who = <Trans i18nKey={head.key} values={head.values} components={{ b: <b /> }} {...TYPED_VALUES} />;
  const rowList = (list: Proposal[]) => (
    <ul className="proposal-rows">
      {list.map((p) => {
        const name = p.target.type === "org_context" ? org.name : agentName(p.agentId);
        return (
          <li key={p.id} className="proposal-row ac-mediarow ac-mediarow--row">
            <span className="ac-mediarow__face">
              {p.target.type === "org_context" ? (
                <Icon name="layers" size={20} />
              ) : (
                <AgentAvatar agentId={p.agentId} size="sm" name={name} />
              )}
            </span>
            <span className="ac-mediarow__head">
              <b className="proposal-row__name">{name}</b>
            </span>
            <span className="ac-mediarow__end">
              <span className="proposal-row__status">{proposalOutcome(t, p, me.user.id)}</span>
              <ProposalAction p={p} />
            </span>
            {(!isText(p) || p.review) && (
              <span className="ac-mediarow__body">
                {!isText(p) && <SettingChange p={p} />}
                {p.review && <span className="proposal-change proposal-row__why">{p.review}</span>}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
  const groups = proposalSections(rows);

  // A request card like every other, the rows under its change. Decided, the same card: each row says how it ended,
  // and the footer how the card did and when.
  const reviewing = rows.some(isReviewing);
  const tt = t as unknown as (key: string, options: Record<string, unknown>) => string;
  const texts = groups.flatMap((g) => (g.kind === "text" && g.lines.length > 0 ? [g] : []));
  const firstLine = firstChange(texts[0]?.lines);
  return (
    <RequestCard
      id={first.id}
      kind="proposal"
      agent={dir.anyAgent(proposerOf(first))}
      label={label}
      mine={false}
      waitingFor={reviewing ? t("proposals.reviewing") : undefined}
      answer={reviewing ? undefined : proposalAnswer(t, i18n.language, rows, me.user.id)}
      lead={who}
      object={
        firstLine
          ? {
              logo: (
                <RequestTile>
                  <Icon name="file" size={16} />
                </RequestTile>
              ),
              title: firstLine.text,
              more: t("ask.seeChange"),
            }
          : undefined
      }
      details={
        texts.length > 0 ? (
          <>
            {texts.map((g) => (
              <ProseDiff key={g.rows[0]?.id} label={t("proposals.changeLabel")} lines={g.lines} />
            ))}
            <div className="ac-acts">
              <ProposalsLink agentId={first.agentId} />
            </div>
          </>
        ) : undefined
      }
      body={rowList(groups.flatMap((g) => g.rows))}
      what={tt(head.key, head.values).replace(/<\/?b>/g, "")}
    />
  );
}

/**
 * An agent's question (`ask_user`): neutral card in the thread with the
 * choices as a list, one a line with its number key, and "Outra resposta" (or
 * "Responder" without choices) opening a field in the card. The field answers this question wherever the card shows (a thread
 * in the panel, a consultation, a channel whose composer posts elsewhere), so
 * it never depends on which composer is on screen.
 */
export function QuestionCard({ question, asker }: { question: AgentQuestion; asker?: string }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const dir = useDirectory(org.id);
  const live = useLiveStore();
  const fresh = useLive((s) => s.questions[question.id]);
  const current = fresh?.status === "open" && question.status !== "open" ? question : (fresh ?? question);
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const limit = useTextLimit(MAX_MESSAGE_LENGTH, "choices.tooLongFix");
  const tooLong = overLimit(text, limit);
  const reopen = useRef<HTMLButtonElement>(null);
  // Refused because it ended (someone answered, its run stopped): the card closes here, even if no event came.
  const [ended, setEnded] = useState(false);
  // `base`: the question as it was before this answer showed.
  const refused = (
    err: unknown,
    fallback: "question.failed" | "question.skipFailed",
    base: AgentQuestion = current,
  ) => {
    if ((err as { status?: number }).status !== 409) return setError(t(fallback));
    setText("");
    setEnded(true);
    live.answered({ ...base, status: "answered", answer: null, answeredByUserId: null });
  };
  // The card shows the answer (or the skip) at once; a refusal opens the question again, said on the card.
  const settle = (patch: Pick<AgentQuestion, "answer"> & Partial<AgentQuestion>) => {
    setError(null);
    const before = current;
    live.answered({
      ...current,
      ...patch,
      status: "answered",
      answeredByUserId: me.user.id,
      answeredAt: new Date().toISOString(),
    });
    return { before };
  };
  const answer = useMutation({
    mutationFn: (input: { choice: string } | { text: string }) => api.questions.answer(org.id, question.id, input),
    // Errors are explained on the card.
    meta: { silent: true },
    onMutate: (input) => settle({ answer: "choice" in input ? input.choice : input.text }),
    onSuccess: (res, input) =>
      live.answered({ ...res, answer: res.answer ?? ("choice" in input ? input.choice : input.text) }),
    onError: (err, _input, context) => {
      if (context) live.answered(context.before);
      refused(err, "question.failed", context?.before);
    },
  });
  const skip = useMutation({
    mutationFn: () => api.questions.dismiss(org.id, question.id),
    meta: { silent: true },
    onMutate: () => settle({ answer: null, dismissed: true }),
    onSuccess: (res) => live.answered(res),
    onError: (err, _input, context) => {
      if (context) live.answered(context.before);
      refused(err, "question.skipFailed", context?.before);
    },
  });
  const busy = answer.isPending || skip.isPending;
  const agent = dir.anyAgent(question.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const done = current.status === "answered";
  const who = current.answeredByUserId === me.user.id ? null : dir.memberById.get(current.answeredByUserId ?? "")?.name;
  // Answered, or closed with no answer (its run stopped, it expired): the same card, the question still its words,
  // and who answered what, and when, where the choices and the footer were.
  const answerText = current.answer ?? "";
  const how: RequestAnswer | undefined = done
    ? {
        done: current.answer !== null && !current.withdrawn && !current.dismissed,
        text: current.withdrawn ? (
          t("question.withdrawn", agentGrammar(name))
        ) : current.dismissed ? (
          who ? (
            t("question.dismissed", { name: who })
          ) : (
            t("question.dismissedByYou")
          )
        ) : current.answer === null ? (
          t(ended ? "question.alreadyAnswered" : "question.closed")
        ) : who ? (
          <Trans
            i18nKey="question.answered"
            values={{ name: who, answer: answerText }}
            components={{ b: <b /> }}
            {...TYPED_VALUES}
          />
        ) : (
          <Trans
            i18nKey="question.answeredByYou"
            values={{ answer: answerText }}
            components={{ b: <b /> }}
            {...TYPED_VALUES}
          />
        ),
        time: current.answeredAt ? whenAt(t, i18n.language, current.answeredAt) : undefined,
      }
    : undefined;
  // Open: a request card, the choices a list in its body, each with its number key, and "Outra resposta" the list's
  // last line, opening a field to write one. For someone else, it says who it waits for and nothing else.
  const mine = !done && questionWaitsOn(current, me.user.id);
  const choices = current.choices ?? [];
  const send = () => {
    if (text.trim() && !tooLong && !busy) answer.mutate({ text: text.trim() });
  };
  const pick = (choice: string | undefined) => {
    if (choice !== undefined && !busy) answer.mutate({ choice });
  };
  const picking = (choice: string) =>
    answer.isPending && "choice" in answer.variables && answer.variables.choice === choice;
  const errorLine = error ? (
    <p className="rq__error" role="alert">
      {error}
    </p>
  ) : null;
  const field = writing && (
    <div className="rq__field">
      <Textarea
        rows={2}
        autoGrow
        autoFocus
        value={text}
        limit={limit}
        placeholder={t("question.placeholder")}
        aria-label={t("question.placeholder")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
    </div>
  );
  return (
    <RequestCard
      id={question.id}
      kind="question"
      agent={agent}
      asker={asker}
      runId={question.runId ?? null}
      label={t("question.group", { agent: name })}
      mine={mine}
      waitingFor={t("ask.waitingFor", {
        name: dir.memberById.get(current.requestedForUserId ?? "")?.name ?? t("channel.unknownPerson"),
      })}
      lead={current.text}
      answer={how}
      body={
        (mine && choices.length > 0) || (mine && field) || errorLine ? (
          <>
            {mine && choices.length > 0 && (
              <RequestChoices
                choices={choices.map((label) => ({ label, busy: picking(label) }))}
                onPick={(i) => pick(choices[i])}
                disabled={busy}
                other={
                  writing ? undefined : { label: t("ask.otherAnswer"), onClick: () => setWriting(true), ref: reopen }
                }
              />
            )}
            {mine && field}
            {errorLine}
          </>
        ) : undefined
      }
      actions={
        mine &&
        (writing ? (
          <>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={
                !text.trim() || tooLong || skip.isPending || (answer.isPending && !("text" in answer.variables))
              }
              loading={answer.isPending && "text" in answer.variables}
            >
              {t("channel.send")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setWriting(false);
                setText("");
                setError(null);
                // The button leaves with the field: focus goes back to the one that opened it.
                requestAnimationFrame(() => reopen.current?.focus());
              }}
            >
              {t("common.cancel")}
            </Button>
          </>
        ) : choices.length > 1 ? (
          <RequestKeys count={choices.length} />
        ) : choices.length === 0 ? (
          <Button ref={reopen} variant="primary" size="sm" onClick={() => setWriting(true)}>
            {t("question.answer")}
          </Button>
        ) : undefined)
      }
      end={
        mine && (
          <Button variant="ghost" size="sm" disabled={busy} loading={skip.isPending} onClick={() => skip.mutate()}>
            {t("question.skip")}
          </Button>
        )
      }
      what={current.text}
      onSubmit={writing ? send : undefined}
      locked={busy}
    />
  );
}

/**
 * An agent asks for a secret for its computer (`request_secret`, ADR 0027).
 * Only the person asked sees the field; the value is sealed here, in the
 * browser, to the key the computer made, so it never reaches our server, the
 * chat or the agent. Everyone else sees who was asked.
 */
export function SecretCard({
  request,
  runId = null,
}: {
  request: SecretRequest;
  /** The run that asked (its message's). */
  runId?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const live = useLiveStore();
  const current = latestSecret(
    useLive((s) => s.secrets[request.id]),
    request,
  );
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  // "Save to the Vault" (ADR 0144): a site's password or a variable, saved after it went to the computer.
  const [keep, setKeep] = useState<VaultSaveChoice>(() => vaultSaveDefaults(request));
  // How the save went: saved, failed (Retry while the value is kept), or dropped (failed, and the value is gone).
  const [vaultSave, setVaultSave] = useState<"saved" | "failed" | "dropped" | null>(null);
  const store = useSaveSecretToVault(org.id);
  // A save that failed keeps what it sent, for Retry, while the card is on screen and for two minutes at most. The
  // mutations themselves forget the typed value as soon as they end (`reset`, `gcTime: 0`).
  const retryable = useRef<SecretToVaultInput | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      retryable.current = null;
      clearTimeout(retryTimer.current);
    },
    [],
  );
  const codeDigits = current.codeDigits ?? null;
  const agent = dir.anyAgent(request.agentId);
  const agentName = agent?.name ?? t("channel.unknownAgent");
  const mine = current.requestedForUserId === me.user.id;
  const person = dir.memberById.get(current.requestedForUserId)?.name ?? t("channel.unknownPerson");
  // Past its deadline it closes as expired, even before the server's event says so.
  const expired = useExpired(current.status === "pending" ? current.expiresAt : null);
  const pending = current.status === "pending" && !expired;
  // It ended (an event, its deadline, a refusal): what was typed goes with the field.
  useEffect(() => {
    if (!pending) setValue("");
  }, [pending]);
  // Refused: the computer can't take it now and the card goes on, or the request ended and the card says how.
  const failed = async (err: unknown) => {
    const away = secretRefusalKey(err);
    if (away) return setError(t(away, { agent: agentName, time: formatTime(i18n.language, current.expiresAt) }));
    if ((err as { status?: number }).status !== 409) return setError(t("secret.failed", { agent: agentName }));
    const fresh = await api.secrets.get(org.id, current.id).catch(() => null);
    const closed = secretClosedBy(err, current, fresh);
    if (closed) return live.secretAnswered(closed);
    if (fresh) live.secretAnswered(fresh);
    setError(t(fresh ? "secret.changed" : "secret.failed", { agent: agentName }));
  };
  // The newer card, when this conversation shows it; else where it is.
  const showNewer = async () => {
    const id = current.supersededBy;
    if (!id) return;
    if (document.querySelector(`[data-ask-id="${id}"]`)) return showRequest(document.body, id, true);
    const newer = await api.secrets.get(org.id, id).catch(() => null);
    if (newer?.messageId) {
      await navigate({ href: messagePath(org.id, { ...newer, id: newer.messageId }) });
    }
  };
  const forgetRetry = () => {
    retryable.current = null;
    clearTimeout(retryTimer.current);
  };
  // Delivered but not saved: the value went where it was asked, so the toast says only the Vault failed, and retries.
  function saveToVault(input: SecretToVaultInput) {
    store.mutate(
      { ...input, requestId: current.id },
      {
        onSuccess: () => {
          forgetRetry();
          setVaultSave("saved");
        },
        onError: () => {
          if (!retryable.current) {
            retryable.current = input;
            retryTimer.current = setTimeout(() => {
              forgetRetry();
              setVaultSave((v) => (v === "failed" ? "dropped" : v));
            }, VAULT_RETRY_MS);
          }
          setVaultSave("failed");
          toast.show(t("vault.card.notSaved"), "warning", { label: t("common.retry"), run: retrySave });
        },
        onSettled: () => store.reset(),
      },
    );
  }
  function retrySave() {
    if (retryable.current) saveToVault(retryable.current);
  }
  const deliver = useMutation({
    meta: { silent: true },
    gcTime: 0,
    mutationFn: async ({ text }: { text: string; choice: VaultSaveChoice | null }) => {
      if (!current.publicKey) throw Object.assign(new Error("closed"), { status: 409 });
      const aad = secretAad({ requestId: current.id, orgId: org.id, name: current.name, target: current.target });
      return api.secrets.deliver(org.id, current.id, await sealSecret(current.publicKey, text, aad));
    },
    onMutate: () => setError(null),
    onSuccess: (res, { text, choice }) => {
      setValue("");
      live.secretAnswered(res);
      if (choice)
        saveToVault({
          value: text,
          // A site's username always goes: empty means none, even when the agent suggested one (ADR 0144 §6).
          ...(current.target.kind === "site" ? { username: choice.username.trim() } : {}),
          scope: choice.scope,
          allAgents: choice.allAgents,
          agentIds: choice.allAgents ? [] : choice.agentIds,
        });
    },
    onError: failed,
  });
  const decline = useMutation({
    meta: { silent: true },
    mutationFn: () => api.secrets.decline(org.id, current.id),
    onMutate: () => setError(null),
    onSuccess: (res) => live.secretAnswered(res),
    onError: failed,
  });
  const savable = mine && savesToVault(current);
  const submit = () => {
    const problem = secretValueProblem(value);
    if (problem) return setError(t(problem));
    if (codeDigits && value.length !== codeDigits) return setError(t("vault.card.codeShort", { count: codeDigits }));
    // Sent (or refused): the typed value leaves the mutation at once.
    deliver.mutate({ text: value, choice: savable && keep.on ? keep : null }, { onSettled: () => deliver.reset() });
  };
  const where = secretWhere(t, current, agentName);
  const label = secretLabel(t, current, agentName);
  const until = t("secret.until", { time: formatTime(i18n.language, current.expiresAt) });
  // A request card; only the person asked gets the field (the whole card is its form). Closed, the same card: how it
  // ended and when where the field and the buttons were, never its value.
  const ended = secretEndedAt(current);
  const how: RequestAnswer | undefined = pending
    ? undefined
    : {
        done: current.status === "delivered",
        text: (
          <>
            {secretOutcome(t, current, mine, person, agentName)}
            {vaultSave === "saved" && ` · ${t("vault.card.saved")}`}
          </>
        ),
        time: ended ? whenAt(t, i18n.language, ended) : undefined,
        action: current.supersededBy ? (
          <Button size="sm" variant="ghost" onClick={() => void showNewer()}>
            {t("secret.seeNewer")}
          </Button>
        ) : undefined,
      };
  const host = hostOf(current.site);
  return (
    <>
      <RequestCard
        id={current.id}
        kind="secret"
        agent={agent}
        runId={runId}
        label={t("secret.group", { agent: agentName })}
        mine={mine}
        waitingFor={t("ask.waitingFor", { name: person })}
        answer={how}
        lead={current.purpose}
        object={{
          logo: <RequestTile>{host ? <SiteIcon host={host} /> : <Icon name="lock" size={16} />}</RequestTile>,
          title: label,
          detail: current.username
            ? t("common.joinSentences", { a: where, b: t("secret.account", { username: current.username }) })
            : where,
        }}
        body={
          mine && pending ? (
            <>
              <div className="rq__field">
                {codeDigits ? (
                  // A verification code (ADR 0144): one box per digit, typed by the agent's browser, never saved.
                  <CodeInput
                    length={codeDigits}
                    value={value}
                    onChange={setValue}
                    label={label}
                    boxLabel={(n, total) => t("vault.card.codeBox", { n, total })}
                    invalid={Boolean(error)}
                    disabled={deliver.isPending}
                  />
                ) : (
                  <Input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={value}
                    placeholder={t("secret.placeholder")}
                    aria-label={label}
                    invalid={Boolean(error)}
                    onChange={(e) => setValue(e.target.value)}
                    data-1p-ignore
                  />
                )}
              </div>
              {error ? (
                <p className="rq__error" role="alert">
                  {error}
                </p>
              ) : (
                <p className="rq__note ac-iconline">
                  <Icon name="lock" size={14} />
                  <span>
                    {codeDigits && host ? t("vault.card.codeWhere", { agent: agentName, host }) : t("secret.private")}
                  </span>
                </p>
              )}
              {savable && (
                <VaultSaveBlock
                  request={current}
                  value={keep}
                  onChange={setKeep}
                  canManageTeam={can(org, "manage_credentials")}
                  disabled={deliver.isPending}
                />
              )}
            </>
          ) : undefined
        }
        actions={
          mine && pending ? (
            <>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={deliver.isPending}
                disabled={decline.isPending}
              >
                {t("secret.send")}
              </Button>
              <Button
                type="button"
                size="sm"
                loading={decline.isPending}
                disabled={deliver.isPending}
                onClick={() => decline.mutate()}
              >
                {t("secret.decline")}
              </Button>
            </>
          ) : undefined
        }
        end={until}
        what={label}
        onSubmit={mine && pending ? submit : undefined}
        locked={deliver.isPending || decline.isPending}
      />
      {(vaultSave === "failed" || vaultSave === "dropped") && (
        <div className="vlt-save__failed">
          <p className="rq__note ac-iconline">
            <Icon name="alert" size={14} />
            <span>{t("vault.card.notSaved")}</span>
          </p>
          {vaultSave === "failed" && (
            <Button size="sm" variant="ghost" loading={store.isPending} onClick={retrySave}>
              {t("common.retry")}
            </Button>
          )}
        </div>
      )}
      {!pending && error && (
        <p className="rq__error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
