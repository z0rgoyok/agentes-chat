import { type Agent, type Approval, type Member, useApprovalsDeciding } from "@agenteschat/client";
import {
  approvalLine,
  approvalRuns,
  approveAllScope,
  approveAlwaysAlso,
  approveAlwaysOn,
  cardDeadline,
  itemOwnWords,
  type LinePlace,
  runKeys,
} from "@agenteschat/client/lib/approval-card";
import { aheadPhase } from "@agenteschat/client/lib/approval-kind";
import { approvalOriginShort, approvalWords } from "@agenteschat/client/lib/approval-origin";
import {
  aheadEndLine,
  approvalAskLine,
  approvalDetail,
  approvalGroupWaitsFor,
  approvalLetter,
  approvalLetterTo,
  approvalTitle,
  approvalWaitsFor,
  decisionOutcome,
  requesterDecidesLine,
} from "@agenteschat/client/lib/approval-words";
import { formatTime, nextLabel, whenAt } from "@agenteschat/client/lib/format";
import { Button } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AheadLine, ApproveAlways, CancelAhead } from "@/components/ApprovalItem";
import { useOrg } from "@/components/org-context";
import { inlineWords } from "@/lib/markdown";
import {
  ApproveAll,
  ApproveButton,
  approveAllPartial,
  ConnectorMark,
  ExactAction,
  expiryText,
  RefuseBox,
} from "@/pages/ApprovalsPage";
import { type RequestAnswer, RequestCard, RequestFuse, useExpired } from "./RequestCard";

/** The whole time a request has (24 h when the row doesn't say): the fuse burns down over it. */
const DAY_MS = 24 * 3_600_000;

/**
 * An approval waiting in the conversation, as a request card: the agent's words, what will happen drawn as an
 * attachment's cover (an email as it will go out), the exact action on its line with the app's
 * mark, "Ver o e-mail" / "Ver detalhes" opening it whole in the preview's place (with where it came from), then Approve
 * (held for high risk), "Aprovar sempre" where offered (what it covers on a line under the buttons) and "Agora não"
 * (which asks why, kept as a lesson), in one row under the text, and the fuse to its expiry. Who can't decide sees who it waits for.
 * Decided, expired or canceled, it is the same card: who decided and when where the buttons were.
 */
export function ApprovalAsk({
  approval: row,
  agent,
  members,
  who,
  tail,
  summary = false,
}: {
  approval: Approval;
  agent: Agent | undefined;
  members: Map<string, Member>;
  /** Who asks, before the kind (Notificações: the card stands away from its conversation). */
  who?: ReactNode;
  /** After the fuse at the footer's end (the notifications' Remind me later and Done). */
  tail?: ReactNode;
  /** One of a summary's cards: the line over them says what they are, so it has no header and no asking line. */
  summary?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const deciding = useApprovalsDeciding(org.id, [row.id]);
  // Past its deadline it has expired, even before the server's event says so.
  const expired = useExpired(row.status === "pending" ? row.expiresAt : null);
  const approval: Approval = expired && row.status === "pending" ? { ...row, status: "expired" } : row;
  const pending = approval.status === "pending";
  const [refusing, setRefusing] = useState(false);
  const why = approvalWords(approval);
  const origin = approvalOriginShort(approval);
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const span = Math.max(1, new Date(approval.expiresAt).getTime() - new Date(approval.createdAt).getTime() || DAY_MS);
  const left = Math.max(0, new Date(approval.expiresAt).getTime() - Date.now()) / span;
  const owner = agent?.ownerUserId ? members.get(agent.ownerUserId) : undefined;
  const waits = approvalWaitsFor(approval, owner?.name);
  const requester = requesterDecidesLine(t, approval);
  const title = approvalTitle(t, approval);
  const email = approval.email;
  const previewed = Boolean(email || approvalLetter(approval));
  // What the preview already shows isn't said again on the action's line. A connector's detail is its raw call
  // (`tool · key=value`): its values in words instead, the call under "Ver detalhes".
  const detail = previewed ? undefined : approvalDetail(approval, i18n.language) || undefined;
  return (
    <RequestCard
      id={approval.id}
      kind="approval"
      agent={agent}
      runId={approval.runId}
      who={who}
      label={t(
        pending
          ? "approval.group"
          : approval.status === "approved"
            ? "approval.groupDone"
            : approval.status === "expired"
              ? "approval.groupExpired"
              : approval.status === "canceled"
                ? "approval.groupCanceled"
                : "approval.groupRefused",
      )}
      mine={approval.canDecide}
      waitingFor={waits ? t("ask.waitingFor", { name: waits }) : t("approval.waitingAdmin")}
      answer={pending ? undefined : approvalAnswer(t, i18n.language, approval, me.user.id, members)}
      lead={why ?? (summary ? undefined : approvalAskLine(t, pending && approval.canDecide))}
      headless={summary}
      preview={previewed ? <ApprovalPreview approval={approval} /> : undefined}
      object={{
        logo: <ConnectorMark approval={approval} />,
        title,
        detail,
        more: email ? t("approval.seeEmail") : t("approval.seeDetails"),
      }}
      details={
        <>
          <ExactAction approval={approval} />
          {origin && <p className="rq__origin">{tt(origin.key, origin.values)}</p>}
          {requester && <p className="rq__origin">{requester}</p>}
          {!pending && approval.reason && (
            <p className="rq__origin">{t("approval.reasonLine", { reason: approval.reason })}</p>
          )}
        </>
      }
      body={<AheadLine approval={approval} className="ap-ask__ahead" />}
      actions={
        !pending || !approval.canDecide ? undefined : refusing ? (
          <RefuseBox approval={approval} agent={agent} onCancel={() => setRefusing(false)} />
        ) : (
          <>
            <ApproveButton approval={approval} />
            <ApproveAlways approval={approval} agent={agent} />
            <Button size="sm" onClick={() => setRefusing(true)}>
              {t("approval.notNow")}
            </Button>
          </>
        )
      }
      end={
        refusing ? (
          tail
        ) : (
          <>
            <RequestFuse left={left} agent={agent} text={expiryText(t, approval)} />
            {tail}
          </>
        )
      }
      what={title}
      locked={deciding}
    />
  );
}

/**
 * How a request ended, for its card's footer: who decided ("Aprovado por você", "Recusado por Ana, cobrindo Bia"),
 * when, when one approved ahead runs or ran, and Cancelar while that can still be withdrawn.
 */
function approvalAnswer(
  t: TFunction,
  locale: string,
  approval: Approval,
  meId: string,
  members: Map<string, Member>,
): RequestAnswer {
  const ahead = aheadPhase(approval);
  // No one decided one that ran out: it expired at its deadline (one approved ahead, at its time).
  const ended =
    approval.decidedAt ??
    (approval.status !== "expired" ? null : ahead === "lapsed" ? approval.runAt : approval.expiresAt);
  const note =
    ahead === "scheduled" && approval.runAt
      ? t("approval.ahead.scheduled", { when: nextLabel(locale, approval.runAt) })
      : ahead === "ran" && approval.executedAt
        ? t("approval.ahead.ran", { when: whenAt(t, locale, approval.executedAt) })
        : aheadEndLine(t, approval);
  return {
    done: approval.status === "approved",
    text: decisionOutcome(t, approval, meId, (id) => members.get(id)?.name),
    time: ended ? whenAt(t, locale, ended) : undefined,
    note: note || undefined,
    action: ahead === "scheduled" && approval.canCancel ? <CancelAhead id={approval.id} /> : undefined,
  };
}

/**
 * What an approval will do, drawn as an attachment's cover: an email as it will go out (its subject, to whom, its
 * words). Only an email: an action's values stay on its line (their names are the tool's own, often English), the
 * whole call under "Ver detalhes".
 */
function ApprovalPreview({ approval }: { approval: Approval }) {
  const { t } = useTranslation();
  const email = approval.email;
  const letter = approvalLetter(approval);
  if (letter) {
    return (
      <div className="rq-mail">
        {letter.subject && <b className="rq-mail__subject">{letter.subject}</b>}
        {approvalLetterTo(t, letter) && <span className="rq-mail__to">{approvalLetterTo(t, letter)}</span>}
        <p className="rq-mail__body">{letter.body}</p>
      </div>
    );
  }
  if (!email) return null;
  return (
    <div className="rq-mail">
      <b className="rq-mail__subject">{email.subject || t("approval.email.noSubject")}</b>
      <span className="rq-mail__to">{email.to.join(", ")}</span>
      {email.body && <p className="rq-mail__body">{email.body}</p>}
    </div>
  );
}

/** "3 pedidos de Ada para Executar sql": a run of requests, said as one. */
const runHead = (t: TFunction, run: Approval[], agent: Agent | undefined) =>
  t("approval.run.head", {
    count: run.length,
    name: agent?.name ?? t("channel.unknownAgent"),
    what: run[0] ? approvalTitle(t, run[0]) : "",
  });

/**
 * Several requests of one agent in one conversation, on one card (the server joins them: `openApprovalCard`).
 * Waiting requests of one kind in a row fold into one run (`approvalRuns`) with "Aprovar todos" and "Ver cada um";
 * a card that is one run is that run, its buttons in the footer. Otherwise each item (or run) is one row: its values
 * and its own buttons at the row's right end, decided ones folded into the list with how they ended, and "Aprovar tudo" /
 * "Agora não para todos" over the ones listed now in the footer, with the earliest deadline's fuse. Someone who may
 * decide only some reads that "Aprovar tudo" covers only those. With every request decided it is the same card, each
 * row saying how it ended, and no footer.
 */
export function ApprovalGroupAsk({
  items,
  agent,
  members,
  who,
  tail,
}: {
  items: Approval[];
  agent: Agent | undefined;
  members: Map<string, Member>;
  /** Who asks, before the kind (Notificações: the card stands away from its conversation). */
  who?: ReactNode;
  /** After the fuse at the footer's end (the notifications' Remind me later and Done). */
  tail?: ReactNode;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const deciding = useApprovalsDeciding(
    org.id,
    items.map((a) => a.id),
  );
  // Which runs are unfolded, by `runKeys`: one stays open while its requests are decided, the card reshaping or not.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const first = items[0];
  if (!first) return null;
  const waiting = items.filter((a) => a.status === "pending");
  const mine = waiting.some((a) => a.canDecide);
  const owner = members.get(first.ownerUserId ?? agent?.ownerUserId ?? "");
  const waits = approvalGroupWaitsFor(items, owner?.name);
  const leadItem = waiting[0] ?? first;
  const why = approvalWords(leadItem);
  const always = approveAlwaysOn(items);
  const deadline = cardDeadline(items);
  const left = deadline ? Math.max(0, new Date(deadline).getTime() - Date.now()) / DAY_MS : 0;
  const partial = approveAllPartial(t, items, waits);
  const runs = approvalRuns(items);
  const keys = runKeys(runs);
  const line = approvalLine(items);
  const [only] = runs;
  const one = runs.length === 1 && only && only.length > 1 ? only : null;
  const isOpen = (key = "") => opened.has(key);
  const setOpen = (key = "", open: boolean) =>
    setOpened((o) => {
      const next = new Set(o);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  const item = (a: Approval, inRun: boolean) => (
    <GroupItem
      key={a.id}
      approval={a}
      lead={leadItem}
      always={!inRun && always.has(a.id)}
      also={approveAlwaysAlso(items, a)}
      place={line.get(a.id)}
      agent={agent}
      members={members}
    />
  );
  return (
    <RequestCard
      id={first.id}
      kind="approval"
      agent={agent}
      runId={first.runId}
      who={who}
      label={t("approval.group")}
      mine={mine}
      ended={waiting.length === 0}
      waitingFor={waits ? t("ask.waitingFor", { name: waits }) : t("approval.waitingAdmin")}
      lead={why ?? approvalAskLine(t, mine, waiting.length || items.length)}
      object={
        one
          ? { logo: <ConnectorMark approval={first} />, title: runHead(t, one, agent), more: t("approval.run.show") }
          : undefined
      }
      open={one ? isOpen(keys[0]) : undefined}
      onOpenChange={one ? (open) => setOpen(keys[0], open) : undefined}
      body={
        <>
          {one ? (
            isOpen(keys[0]) && <ul className="rq__items">{one.map((a) => item(a, true))}</ul>
          ) : (
            <ul className="rq__items">
              {runs.map((run, i) =>
                run.length > 1 && run[0] ? (
                  <RunItem
                    key={keys[i]}
                    run={run}
                    items={items}
                    always={always}
                    agent={agent}
                    open={isOpen(keys[i])}
                    onOpenChange={(open) => setOpen(keys[i], open)}
                  >
                    {run.map((a) => item(a, true))}
                  </RunItem>
                ) : (
                  run[0] && item(run[0], false)
                ),
              )}
            </ul>
          )}
          {partial && <p className="rq__note">{partial}</p>}
        </>
      }
      actions={
        one ? (
          <RunActions run={one} items={items} always={always} agent={agent} />
        ) : approveAllScope(items).ids.length > 1 ? (
          <ApproveAll items={items} />
        ) : undefined
      }
      end={
        deadline || tail ? (
          <>
            {deadline && <RequestFuse left={left} agent={agent} text={expiryText(t, { expiresAt: deadline })} />}
            {tail}
          </>
        ) : undefined
      }
      what={one ? runHead(t, one, agent) : approvalAskLine(t, mine, waiting.length)}
      locked={deciding}
    />
  );
}

/** A run's decision: "Aprovar todos", "Aprovar sempre" where its kind offers it, "Agora não para todos". */
function RunActions({
  run,
  items,
  always,
  agent,
}: {
  run: Approval[];
  items: Approval[];
  always: Set<string>;
  agent: Agent | undefined;
}) {
  const { t } = useTranslation();
  const lead = run.find((a) => always.has(a.id) && a.canDecide);
  return (
    <ApproveAll items={run} label={t("approval.run.approve")}>
      {lead && <ApproveAlways approval={lead} agent={agent} also={approveAlwaysAlso(items, lead)} />}
    </ApproveAll>
  );
}

/** A run among other requests on a card: said as one, its buttons under it, "Ver cada um" unfolding its requests. */
function RunItem({
  run,
  items,
  always,
  agent,
  open,
  onOpenChange,
  children,
}: {
  run: Approval[];
  items: Approval[];
  always: Set<string>;
  agent: Agent | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const first = run[0];
  if (!first) return null;
  return (
    <li className="rq__item rq__run ac-actline" data-status="pending">
      <div className="rq__well">
        <span className="rq__logo">
          <ConnectorMark approval={first} />
        </span>
        <span className="rq__wt">
          <b>{runHead(t, run, agent)}</b>
          <button type="button" className="rq__more" aria-expanded={open} onClick={() => onOpenChange(!open)}>
            {t("approval.run.show")}
          </button>
        </span>
      </div>
      <div className="rq__item-acts">
        <RunActions run={run} items={items} always={always} agent={agent} />
      </div>
      {open && <ul className="rq__items">{children}</ul>}
    </li>
  );
}

/**
 * One request on a shared card, one row: its values (and its own why and origin where they differ from the card's lead)
 * with "Ver detalhes" under them, and its own decision at the row's right end while it waits ("Aprovar sempre" on the
 * first of its kind), or how it ended once decided.
 */
function GroupItem({
  approval,
  lead,
  always,
  also,
  place,
  agent,
  members,
}: {
  approval: Approval;
  lead: Approval;
  always: boolean;
  also: string[];
  /** Where it stands on the card: an approved one runs after what the agent asked before it (`approvalLine`). */
  place: LinePlace | undefined;
  agent: Agent | undefined;
  members: Map<string, Member>;
}) {
  const { t, i18n } = useTranslation();
  const { me } = useOrg();
  const [refusing, setRefusing] = useState(false);
  const [open, setOpen] = useState(false);
  const email = approval.email;
  const detail = email
    ? [email.to.join(", "), email.subject].filter(Boolean).join(" · ")
    : approvalDetail(approval, i18n.language) || undefined;
  const pending = approval.status === "pending";
  const own = itemOwnWords(approval, lead);
  const ahead = aheadPhase(approval);
  const runAt = approval.runAt ? nextLabel(i18n.language, approval.runAt) : "";
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const letter = approvalLetter(approval);
  // Replaced by the agent's newer request for the same action, on the card under it: one quiet line.
  if (approval.status === "canceled" && approval.supersededById) {
    return (
      <li className="rq__item rq__item--done rq__item--replaced ac-actline" data-status={approval.status}>
        <div className="rq__well">
          <span className="rq__logo">
            <ConnectorMark approval={approval} />
          </span>
          <span className="rq__wt">
            <b>{approvalTitle(t, approval)}</b>
            <small>
              {[
                decisionOutcome(t, approval, me.user.id, (id) => members.get(id)?.name),
                approval.decidedAt && formatTime(i18n.language, approval.decidedAt),
              ]
                .filter(Boolean)
                .join(" · ")}
            </small>
          </span>
        </div>
      </li>
    );
  }
  return (
    <li
      className={pending ? "rq__item ac-actline" : "rq__item rq__item--done ac-actline"}
      data-status={approval.status}
    >
      <div className="rq__well">
        <span className="rq__logo">
          <ConnectorMark approval={approval} />
        </span>
        <span className="rq__wt">
          <b>{approvalTitle(t, approval)}</b>
          {detail && <small>{inlineWords(detail, "it-d")}</small>}
          {letter && (
            <span className="rq-letter">
              {letter.subject && <b className="rq-letter__subject">{letter.subject}</b>}
              {approvalLetterTo(t, letter) && <small className="rq-letter__to">{approvalLetterTo(t, letter)}</small>}
              <span className="rq-letter__body">{letter.body}</span>
            </span>
          )}
          {own.why && <small className="rq__item-why">{inlineWords(own.why, "it-w")}</small>}
          {own.origin && <small className="rq__item-why">{tt(own.origin.key, own.origin.values)}</small>}
          {runAt && (ahead === "asking" || ahead === "scheduled") && (
            <small className="rq__item-why">
              {t(ahead === "asking" ? "approval.ahead.line" : "approval.ahead.scheduled", { when: runAt })}
            </small>
          )}
          {/* Under its words: the row's right end holds its decision. */}
          <button type="button" className="rq__more" aria-expanded={open} onClick={() => setOpen(!open)}>
            {email ? t("approval.seeEmail") : t("approval.seeDetails")}
          </button>
        </span>
      </div>
      {pending ? (
        approval.canDecide &&
        !refusing && (
          <div className="rq__item-acts">
            <ApproveButton approval={approval} />
            {always && <ApproveAlways approval={approval} agent={agent} also={also} />}
            <Button size="sm" onClick={() => setRefusing(true)}>
              {t("approval.notNow")}
            </Button>
          </div>
        )
      ) : (
        <p className="rq__item-outcome">
          {decisionOutcome(t, approval, me.user.id, (id) => members.get(id)?.name)}
          {place?.waitsOn
            ? ` · ${t("approval.line.after", {
                // With its place on the card: two requests of one kind ("Criar issue") tell apart by it.
                title: `${approvalTitle(t, place.waitsOn)} (${t("approvals.position", { n: place.waitsOnAt, total: place.count })})`,
              })}`
            : approval.result?.notRunAfter
              ? ` · ${t("approval.line.notRun")}`
              : null}
          {ahead === "scheduled" && approval.canCancel && <CancelAhead id={approval.id} />}
        </p>
      )}
      {open && (
        <div className="rq__details">
          <ExactAction approval={approval} />
        </div>
      )}
      {refusing && <RefuseBox approval={approval} agent={agent} onCancel={() => setRefusing(false)} />}
    </li>
  );
}
