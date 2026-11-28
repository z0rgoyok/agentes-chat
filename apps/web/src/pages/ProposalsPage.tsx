import type { Proposal } from "@agenteschat/client";
import { useProposals } from "@agenteschat/client";
import { relativeTime, whenAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { proposalTarget, proposalTitle, proposalWhy, proposerOf } from "@agenteschat/client/lib/proposals";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { Card, CardHeader, cx, diffLines, EmptyState, Icon, type IconName, PageHeader } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import {
  isReviewing,
  isText,
  ProposalAction,
  proposalEndedAt,
  proposalOutcome,
  SettingChange,
} from "@/components/ChatCards";
import { useOrg } from "@/components/org-context";
import { ProseDiff } from "@/components/ProseDiff";
import { useDirectory } from "@/hooks/useDirectory";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import "./approvals.css";

/**
 * What the agents changed (ADR 0219), on the requests' own layout (Requests): the list's rows, newest first, and the
 * one open beside them: how it ended and why, what it changed, and Undo while it may be put back. Nobody decides here.
 */
export function ProposalsPage({ agentId }: { agentId?: string }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const look = useRightHandLook();
  const dir = useDirectory(org.id);
  const proposals = useProposals(org.id);
  const [selected, setSelected] = useState<string | null>(null);
  // A stale row changed nothing and repeats what newer rows say: only the one open here stays, with its note.
  const list = useMemo(
    () =>
      (proposals.data ?? [])
        .filter((p) => !p.stale || p.id === selected)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [proposals.data, selected],
  );

  const preferred = list.find((p) => p.agentId === agentId) ?? list[0];
  const current = list.find((p) => p.id === selected) ?? preferred;
  // Pin the initial choice so a row that changes doesn't jump to another.
  useEffect(() => {
    if (!selected && preferred) setSelected(preferred.id);
  }, [selected, preferred]);

  const backAgent = agentId ? dir.agentById.get(agentId) : undefined;
  const agentName = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  const targetLabel = (p: Proposal) => proposalTarget(t, p, agentName, org);
  const tt = t as unknown as (key: string, options: Record<string, string>) => string;
  const titleOf = (p: Proposal) => proposalTitle(t, p, org, agentName);
  const whereOf = (e: Proposal["evidence"][number]) =>
    e.type ? tt(`proposals.evidence.${e.type}`, { defaultValue: e.where }) : e.where;
  // How it ended and when; still weighed (or overtaken), since when it came.
  const endText = (p: Proposal) => {
    const at = proposalEndedAt(p);
    const outcome = proposalOutcome(t, p, me.user.id);
    if (isReviewing(p) || p.stale || !at) return `${outcome} · ${relativeTime(t, i18n.language, p.createdAt)}`;
    return `${outcome} · ${whenAt(t, i18n.language, at)}`;
  };
  // How a decided one ended, for its row's mark and its outcome card: applied reads as done, the rest plain.
  const applied = (p: Proposal) => p.status === "accepted" && !p.stale;
  const mark = (p: Proposal): IconName => (applied(p) ? "check" : p.status === "undone" ? "undo" : "close");
  const proposer = current ? agentName(proposerOf(current)) : "";

  return (
    <div className="page page--list ap">
      <div className="ap__main">
        {backAgent && (
          <Link
            to="/org/$orgId/agents/$agentId/memory"
            params={{ orgId: org.id, agentId: backAgent.id }}
            className="ac-back"
          >
            <Icon name="chevronLeft" />
            {t("memory.title", agentGrammar(backAgent.name))}
          </Link>
        )}
        <PageHeader title={t("proposals.title")} meta={t(modeKey(org, "proposals.subtitle"), { org: org.name })} />

        {proposals.isSuccess && list.length === 0 && (
          <EmptyState size="page" agent={look} mood="deal" title={t("proposals.emptyTitle")}>
            {t("proposals.empty")}
          </EmptyState>
        )}

        {current && (
          // The requests' own split (approvals.css): the list's rows on the left, what is open beside them.
          <div className="ap-split page-split">
            <nav className="ap-list" data-scroll-restoration-id="proposals-list" aria-label={t("proposals.list")}>
              <div className="ap-list__rows">
                {list.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={cx("ap-li ac-mediarow ac-mediarow--row", p.id === current.id && "is-selected")}
                    aria-current={p.id === current.id ? "true" : undefined}
                    onClick={() => setSelected(p.id)}
                  >
                    <span className="ac-mediarow__face">
                      <AgentAvatar agentId={proposerOf(p)} size="sm" name={agentName(proposerOf(p))} state="idle" />
                    </span>
                    <span className="ac-mediarow__head">
                      <span className="ap-li__line">
                        <b>{titleOf(p)}</b>
                      </span>
                    </span>
                    <span className="ac-mediarow__end">
                      {!isReviewing(p) && (
                        // Its row's mark takes the requests' own state class (a decided request's `is-<phase>`, as
                        // the approvals list marks one): applied reads in the success color, the rest muted.
                        <span
                          className={cx("ap-li__state", `is-${applied(p) ? "done" : "off"}`)}
                          role="img"
                          aria-label={proposalOutcome(t, p, me.user.id)}
                          title={proposalOutcome(t, p, me.user.id)}
                        >
                          <Icon name={mark(p)} size={16} />
                        </span>
                      )}
                    </span>
                    <span className="ac-mediarow__body">
                      <span className="ap-li__meta">
                        <span className="ap-li__where">{agentName(proposerOf(p))}</span>
                        <span className="ap-li__when">{endText(p)}</span>
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </nav>

            <article className="ap-review" data-scroll-restoration-id="proposals-detail" aria-labelledby="prop-title">
              <header className="ap-review__head ac-mediarow">
                <span className="ac-mediarow__face">
                  <AgentAvatar agentId={proposerOf(current)} size="md" name={proposer} state="idle" />
                </span>
                <p className="ap-review__by ac-mediarow__head">
                  <b>{proposer}</b>
                  <span className="ac-mediarow__meta">
                    {[targetLabel(current), relativeTime(t, i18n.language, current.createdAt)].join(" · ")}
                  </span>
                </p>
                <div className="ac-mediarow__body">
                  <h2 id="prop-title" className="ap-review__title">
                    {titleOf(current)}
                  </h2>
                </div>
              </header>

              <div className="ap-review__body">
                {/* How it ended (or that the agent's review is weighing it), the review's why, and Undo. */}
                <Card className={cx("ap-review__card ap-outcome", applied(current) && "ap-outcome--done")}>
                  <CardHeader
                    icon={isReviewing(current) ? "waiting" : mark(current)}
                    title={current.stale ? t("proposals.stale") : endText(current)}
                    subtitle={
                      current.stale
                        ? t(isText(current) ? "proposals.staleNote" : "proposals.staleNoteAgent")
                        : (current.review ?? undefined)
                    }
                    action={<ProposalAction p={current} />}
                  />
                </Card>

                <Card as="section" className="ap-review__card" aria-label={t("proposals.why")}>
                  <CardHeader icon="message" title={t("proposals.why")} />
                  <p className="ap-review__why">{proposalWhy(t, current)}</p>
                  {current.evidence.length > 0 && (
                    <ul className="evidence">
                      {current.evidence.map((e) => (
                        <li key={`${e.where}-${e.what}`} className="ac-iconline">
                          <Icon name="message" size={16} />
                          <span>
                            {whereOf(e)} <span className="muted">· {e.what}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>

                <Card as="section" className="ap-review__card" aria-label={t("proposals.changeLabel")}>
                  <CardHeader icon="edit" title={t("proposals.change", { target: targetLabel(current) })} />
                  {!isText(current) && current.target.type !== "skill" ? (
                    <SettingChange p={current} />
                  ) : (
                    <ProseDiff
                      label={t("proposals.changeLabel")}
                      lines={diffLines(current.before.split("\n"), current.after.split("\n"))}
                    />
                  )}
                </Card>
              </div>
            </article>
          </div>
        )}
      </div>
    </div>
  );
}
