import type { Message, Proposal } from "@agenteschat/client";
import {
  keys,
  useActOnTeamWeek,
  useAgentActions,
  useApprovals,
  useCardProposals,
  useChannels,
  useDecideProposal,
  useModelLabel,
  useSetTeamWeekPrefs,
  useTeamWeekPrefs,
  useWaitingOnMe,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { clockAt, formatUsd, joinNames } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { type TeamWeekPeriod, teamWeekOn, teamWeekWhen } from "@agenteschat/client/lib/right-hand-prefs";
import {
  appliesInBulk,
  skipsAlone,
  type TeamWeekCard,
  type TeamWeekNames,
  type TeamWeekPlace,
  type TeamWeekRow,
  type TeamWeekRowState,
  teamWeekDoneText,
  teamWeekRowMessage,
  teamWeekRowPlace,
  teamWeekRowState,
  teamWeekRowText,
  teamWeekTitleKey,
} from "@agenteschat/client/lib/team-week";
import { Button, Icon, Popover } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { WaitMark } from "@/components/RequestCard";
import { CardApproval } from "@/components/RightHandApprovalsCard";
import { TeamWeekSchedule } from "@/components/TeamWeekSchedule";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import "./team-week.css";

const NANO = 1_000_000_000;

/** The names a row's words need, from the reader's directory. */
export function useTeamWeekNames(): TeamWeekNames {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const channels = useChannels(org.id).data ?? [];
  const modelLabel = useModelLabel();
  return {
    agent: (id) => (id ? dir.anyAgent(id)?.name : undefined) ?? t("channel.unknownAgent"),
    handle: (id) => (id ? (dir.anyAgent(id)?.handle ?? null) : null),
    channel: (id) => channels.find((c) => c.id === id)?.name ?? "…",
    usd: (n) => formatUsd(i18n.language, Math.round(n / NANO)),
    join: (names) => joinNames(names, t),
    since: (iso) => clockAt(i18n.language, iso),
    model: (id) => modelLabel(id) ?? id,
  };
}

/**
 * Lodi's weekly card (ADR 0137 §9) in the admin's DM: four numbers, what worked, then a row per fix, each applied as
 * whoever clicks through its own card's path (the settings proposal with Undo, the approvals as the conversation
 * draws them, a routine, a message), "Aplicar as N" for the open ones and the day and hour in the footer. The day's
 * card (ADR 0177 §2) is the same, led by what waits on its reader and what is stuck, each opened where it is.
 */
export function TeamWeekCardView({ message, card }: { message: Message; card: TeamWeekCard }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const names = useTeamWeekNames();
  const proposals = useCardProposals(org.id, card.proposalIds);
  const approvals = useApprovals(org.id);
  const decide = useDecideProposal(org.id);
  const act = useActOnTeamWeek(org.id);
  const waiting = useWaitingOnMe(org.id);
  const navigate = useNavigate();
  const toast = useToast();
  const [applying, setApplying] = useState(false);
  const locale = i18n.language;
  const lodi = dir.agents.find(isRightHand);
  const rows = card.rows.map((row) => ({
    row,
    state: teamWeekRowState(card, row, {
      proposals,
      approvals: approvals.data,
      waiting: waiting.data?.items.map((i) => i.id),
    }),
    text: teamWeekRowText(t, locale, row, names),
  }));
  const open = rows.filter((r) => r.state === "open");
  const bulk = open.filter((r) => appliesInBulk(r.row));
  // What waits or is stuck is opened, not applied: the head counts only what the card suggests.
  const suggested = open.filter((r) => !teamWeekRowPlace(r.row));
  const failed = (e: unknown) => toast.show(errorText(t, e), "error");
  const params = { orgId: org.id };
  const go = (place: TeamWeekPlace) =>
    place.to === "waiting"
      ? navigate({ to: "/org/$orgId/waiting", params })
      : place.to === "task"
        ? navigate({ to: "/org/$orgId/issues/$number", params: { ...params, number: String(place.number) } })
        : place.to === "dm"
          ? navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { ...params, agentId: place.agentId } })
          : navigate({ to: "/org/$orgId/c/$channelId", params: { ...params, channelId: place.channelId } });
  const apply = async (row: TeamWeekRow) => {
    const place = teamWeekRowPlace(row);
    if (place) await go(place);
    else if ("proposalId" in row) await decide.mutateAsync({ id: row.proposalId, decision: "accept" });
    else if (row.kind !== "approvals")
      await act.mutateAsync({
        messageId: message.id,
        act: { rowId: row.id, text: teamWeekRowMessage(t, row, names) },
      });
  };
  const applyAll = async () => {
    setApplying(true);
    try {
      for (const r of bulk) await apply(r.row);
    } catch (e) {
      failed(e);
    } finally {
      setApplying(false);
    }
  };
  const { stats } = card;
  const dismissed = !!card.dismissedAt;
  return (
    // Its week ("Como foi a semana do time, de 28 out. a 3 nov.") is the message's text, above.
    <div className="tw">
      {/* biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset */}
      <div className="rq tw__card" role="group" aria-label={t(teamWeekTitleKey(card))}>
        <div className="rq__head">
          <span className="rq__kind">{t(teamWeekTitleKey(card))}</span>
          {suggested.length > 0 && !dismissed && (
            <span className="rq__state">
              <WaitMark />
              {t("teamWeek.suggestions", { count: suggested.length })}
            </span>
          )}
        </div>
        <div className="tw__stats">
          <Stat value={String(stats.done)} label={t("teamWeek.stat.done")} />
          <Stat value={String(stats.stuck)} label={t("teamWeek.stat.stuck")} warn={stats.stuck > 0} />
          <Stat value={String(stats.waiting)} label={t("teamWeek.stat.waiting")} warn={stats.waiting > 0} />
          {/* The workspace's money: only on an administrator's card. */}
          {stats.budgetNanoUsd > 0 && (
            <Stat
              value={names.usd(stats.spentNanoUsd)}
              label={t("teamWeek.stat.budget", { budget: names.usd(stats.budgetNanoUsd) })}
            />
          )}
        </div>
        {card.worked.length > 0 && (
          <section className="tw__sec">
            <h4 className="tw__sec-t">{t("teamWeek.worked")}</h4>
            <ul className="waitcard__lines tw__worked">
              {card.worked.map((w) => (
                <li key={`${w.kind}:${w.agentId}`} className="ac-iconline">
                  <Icon name="check" size={14} />
                  <span>
                    {w.kind === "runs"
                      ? t("teamWeek.workedRuns", {
                          name: names.agent(w.agentId),
                          count: w.count,
                          channel: names.channel(w.channelId),
                        })
                      : t("teamWeek.workedTasks", { name: names.agent(w.agentId), count: w.count })}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {dismissed ? (
          <p className="tw__dismissed">{t("teamWeek.dismissed")}</p>
        ) : (
          rows.length > 0 && (
            <section className="tw__sec">
              <h4 className="tw__sec-t">{t(card.period === "day" ? "teamWeek.needsYou" : "teamWeek.improve")}</h4>
              <div className="tw__rows">
                {rows.map(({ row, state, text }) => (
                  <FixRow
                    key={row.id}
                    message={message}
                    row={row}
                    state={state}
                    title={text.title}
                    line={text.line}
                    action={text.action}
                    proposal={proposals.find((p) => "proposalId" in row && p.id === row.proposalId)}
                    doneText={teamWeekDoneText(t, row, lodi?.name ?? "Lodi")}
                    onApply={() => apply(row).catch(failed)}
                    onSkip={
                      skipsAlone(row)
                        ? () =>
                            act.mutateAsync({ messageId: message.id, act: { rowId: row.id, skip: true } }).catch(failed)
                        : undefined
                    }
                    busy={applying || act.isPending}
                  />
                ))}
              </div>
            </section>
          )
        )}
        <div className="rq__foot">
          {/* One row to apply has its own button for it: the footer's would only repeat it. */}
          {!dismissed && bulk.length > 1 && (
            <Button
              size="sm"
              variant="primary"
              loading={applying}
              disabled={act.isPending}
              onClick={() => void applyAll()}
            >
              {t("teamWeek.applyAll", { count: bulk.length })}
            </Button>
          )}
          {!dismissed && open.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              disabled={applying}
              loading={act.isPending}
              onClick={() => act.mutate({ messageId: message.id, act: { dismiss: true } }, { onError: failed })}
            >
              {t("teamWeek.notNow")}
            </Button>
          )}
          <span className="rq__end tw__when">
            <TeamWeekWhen period={card.period ?? "week"} />
          </span>
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label, warn = false }: { value: string; label: string; warn?: boolean }) {
  return (
    <div className="tw__stat" data-warn={warn || undefined}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

/** One fix: its face (or icon), what and why, and its button, or how it ended. */
function FixRow({
  message,
  row,
  state,
  title,
  line,
  action,
  proposal,
  doneText,
  onApply,
  onSkip,
  busy,
}: {
  message: Message;
  row: TeamWeekRow;
  state: TeamWeekRowState;
  title: string;
  line: string;
  action: string;
  proposal: Proposal | undefined;
  doneText: string;
  onApply: () => Promise<void>;
  /** "Dispensar": puts this one suggestion away for good. Absent on a row that has none. */
  onSkip?: () => Promise<unknown>;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useAgentActions(org.id, message.channelId);
  const qc = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [showing, setShowing] = useState(false);
  const agentId = "agentId" in row ? row.agentId : null;
  const lead: ReactNode = agentId ? (
    <AgentAvatar agentId={agentId} name={dir.anyAgent(agentId)?.name ?? ""} size="md" />
  ) : (
    <span className="tw__tile" aria-hidden="true">
      <Icon
        name={
          row.kind === "unanswered" || row.kind === "waiting"
            ? "question"
            : row.kind === "stalled"
              ? "issues"
              : row.kind === "howto"
                ? "book"
                : "routines"
        }
        size={16}
      />
    </span>
  );
  const receipt = proposal?.undoActionId ? message.actions?.find((a) => a.id === proposal.undoActionId) : undefined;
  const undoable =
    receipt && !receipt.undoneAt && receipt.undoableUntil && Date.parse(receipt.undoableUntil) > Date.now();
  const side =
    state === "done" ? (
      <>
        <span className="tw__done">
          <Icon name="check" size={14} />
          {receipt?.undoneAt ? t("rightHand.card.undone") : doneText}
        </span>
        {undoable && (
          <Button
            size="sm"
            variant="ghost"
            loading={actions.undo.isPending}
            onClick={() =>
              actions.undo.mutate(receipt.id, {
                onSuccess: () => void qc.invalidateQueries({ queryKey: keys.agents(org.id) }),
                onError: (e) => toast.show(errorText(t, e), "error"),
              })
            }
          >
            {t("teamWeek.undo")}
          </Button>
        )}
      </>
    ) : state === "gone" || state === "skipped" ? (
      <span className="tw__gone">{t(state === "gone" ? "teamWeek.gone" : "teamWeek.skipped")}</span>
    ) : row.kind === "approvals" ? (
      <Button size="sm" onClick={() => setShowing((v) => !v)} aria-expanded={showing}>
        {showing ? t("teamWeek.approvals.hide") : action}
      </Button>
    ) : (
      <>
        <Button
          size="sm"
          loading={pending}
          disabled={busy || skipping}
          onClick={() => {
            setPending(true);
            void onApply().finally(() => setPending(false));
          }}
        >
          {action}
        </Button>
        {onSkip && (
          <Button
            size="sm"
            variant="ghost"
            loading={skipping}
            disabled={busy || pending}
            onClick={() => {
              setSkipping(true);
              void onSkip().finally(() => setSkipping(false));
            }}
          >
            {t("teamWeek.skip")}
          </Button>
        )}
      </>
    );
  return (
    <div className="tw__fix" data-done={state !== "open" || undefined}>
      <div className="tw__fix-row">
        {lead}
        <span className="tw__fix-t">
          <b className="ac-captop">{title}</b>
          <span>{line}</span>
        </span>
        <span className="tw__fix-side">{side}</span>
      </div>
      {showing && row.kind === "approvals" && (
        <div className="tw__approvals">
          {row.approvalIds.map((id) => (
            <CardApproval key={id} id={id} />
          ))}
        </div>
      )}
    </div>
  );
}

/** "Toda sexta às 17:00 · Mudar": when the card it sits on comes to its reader, changed in place, or stopped. */
export function TeamWeekWhen({ period }: { period: TeamWeekPeriod }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const prefs = useTeamWeekPrefs(org.id).data;
  const set = useSetTeamWeekPrefs(org.id);
  const toast = useToast();
  const admin = can(org, "administrator");
  if (!prefs) return null;
  const save = (patch: Parameters<typeof set.mutate>[0]) =>
    set.mutate(patch, { onError: (e) => toast.show(errorText(t, e), "error") });
  const locale = i18n.language;
  // A weekly card kept by someone who no longer administers: the daily one is what they get now.
  const mine = admin ? period : "day";
  return (
    <>
      <span>{teamWeekOn(prefs, mine, admin) ? teamWeekWhen(t, locale, prefs, mine) : t("teamWeek.off")}</span>
      {" · "}
      <Popover
        label={t("teamWeek.schedule.title")}
        side="top"
        align="end"
        trigger={
          <button type="button" className="ac-link tw__change">
            {t("teamWeek.change")}
          </button>
        }
      >
        <div className="tw__schedule">
          <TeamWeekSchedule
            period={mine}
            prefs={prefs}
            admin={admin}
            locale={locale}
            busy={set.isPending}
            onChange={save}
          />
        </div>
      </Popover>
    </>
  );
}
