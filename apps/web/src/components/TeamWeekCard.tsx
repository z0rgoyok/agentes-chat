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
import { isRightHand, RIGHT_HAND_DEFAULT } from "@agenteschat/client/lib/right-hand";
import { type TeamWeekPeriod, teamWeekOn, teamWeekWhen } from "@agenteschat/client/lib/right-hand-prefs";
import {
  markedAtFirst,
  opensPlace,
  skipsAlone,
  type TeamWeekCard,
  type TeamWeekNames,
  type TeamWeekPlace,
  type TeamWeekRow,
  type TeamWeekRowState,
  teamWeekApplyLabel,
  teamWeekDoneText,
  teamWeekGroups,
  teamWeekGroupTitle,
  teamWeekItemText,
  teamWeekRowMessage,
  teamWeekRowPlace,
  teamWeekRowState,
  teamWeekRowText,
  teamWeekTitleKey,
} from "@agenteschat/client/lib/team-week";
import { Button, Checkbox, Icon, type IconName, Popover } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useId, useState } from "react";
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
 * Lodi's weekly card (ADR 0137 §9) in the admin's DM: four numbers and what worked, then its rows. A row that opens a
 * place (approvals, what waits on its reader, an agent that stopped) is one tap with a chevron. Every other row is a
 * suggestion, marked as the card shows (archiving an agent starts unmarked) and grouped under its agent's face; the
 * footer's one button applies the marked ones, each as whoever clicks through its own card's path (a settings proposal
 * with Undo, a routine, a message), and the day and hour sit at its end. The day's card (ADR 0177 §2) is the same, led
 * by what waits on its reader and what is stuck.
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
  // Only the marks the reader changed, never saved: every other row keeps the mark it showed with.
  const [marks, setMarks] = useState<Record<string, boolean>>({});
  const locale = i18n.language;
  const lodi = dir.agents.find(isRightHand);
  const live = { proposals, approvals: approvals.data, waiting: waiting.data?.items.map((i) => i.id) };
  const states = new Map(card.rows.map((row) => [row.id, teamWeekRowState(card, row, live)]));
  const stateOf = (row: TeamWeekRow) => states.get(row.id) ?? "open";
  const isMarked = (row: TeamWeekRow) => marks[row.id] ?? markedAtFirst(row);
  const open = card.rows.filter((row) => stateOf(row) === "open");
  // What waits or is stuck is opened, not applied: the head counts only what the card suggests.
  const suggested = open.filter((row) => !teamWeekRowPlace(row));
  const marked = open.filter((row) => !opensPlace(row) && isMarked(row));
  const failed = (e: unknown) => toast.show(errorText(t, e), "error");
  const doneText = (row: TeamWeekRow) => teamWeekDoneText(t, row, lodi?.name ?? RIGHT_HAND_DEFAULT.name);
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
    if ("proposalId" in row) await decide.mutateAsync({ id: row.proposalId, decision: "accept" });
    else
      await act.mutateAsync({
        messageId: message.id,
        act: { rowId: row.id, text: teamWeekRowMessage(t, row, names) },
      });
  };
  const applyMarked = async () => {
    setApplying(true);
    try {
      for (const row of marked) await apply(row);
    } catch (e) {
      failed(e);
    } finally {
      setApplying(false);
    }
  };
  const skip = (row: TeamWeekRow) =>
    act.mutateAsync({ messageId: message.id, act: { rowId: row.id, skip: true } }).catch(failed);
  const { stats } = card;
  const dismissed = !!card.dismissedAt;
  return (
    // Its week ("How the team's week went, Oct 28 to Nov 3") is the message's text, above.
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
          card.rows.length > 0 && (
            <section className="tw__sec">
              <h4 className="tw__sec-t">{t(card.period === "day" ? "teamWeek.needsYou" : "teamWeek.improve")}</h4>
              <div className="tw__list">
                {card.rows.filter(opensPlace).map((row) => {
                  const text = teamWeekRowText(t, locale, row, names);
                  const place = teamWeekRowPlace(row);
                  return (
                    <PlaceRow
                      key={row.id}
                      row={row}
                      state={stateOf(row)}
                      title={text.title}
                      line={text.line}
                      doneText={doneText(row)}
                      onOpen={() => {
                        if (place) void go(place);
                      }}
                    />
                  );
                })}
                {teamWeekGroups(card.rows).map((group) => (
                  <MarkGroup
                    key={group.agentId ?? group.rows[0]?.id}
                    agentId={group.agentId}
                    title={teamWeekGroupTitle(t, group, names)}
                  >
                    {group.rows.map((row) => {
                      const text = teamWeekItemText(t, locale, row, names);
                      const item = (
                        <MarkRow
                          key={row.id}
                          message={message}
                          state={stateOf(row)}
                          title={text.title}
                          line={text.line}
                          marked={isMarked(row)}
                          onMark={(on) => setMarks((m) => ({ ...m, [row.id]: on }))}
                          proposal={proposals.find((p) => "proposalId" in row && p.id === row.proposalId)}
                          doneText={doneText(row)}
                          onSkip={skipsAlone(row) ? () => skip(row) : undefined}
                          applying={applying}
                          busy={applying || act.isPending}
                        />
                      );
                      // A row about no agent has no face over it: the kind's icon in the face's place.
                      return group.agentId ? (
                        item
                      ) : (
                        <div key={row.id} className="tw__alone">
                          <KindIcon row={row} />
                          {item}
                        </div>
                      );
                    })}
                  </MarkGroup>
                ))}
              </div>
            </section>
          )
        )}
        <div className="rq__foot ac-tailrow">
          {!dismissed && marked.length > 0 && (
            <Button
              size="sm"
              variant="primary"
              loading={applying}
              disabled={act.isPending}
              onClick={() => void applyMarked()}
            >
              {teamWeekApplyLabel(t, marked)}
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
          <span className="rq__end ac-tail tw__when">
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

const kindIcon = (row: TeamWeekRow): IconName =>
  row.kind === "unanswered" || row.kind === "waiting"
    ? "question"
    : row.kind === "stalled"
      ? "issues"
      : row.kind === "howto"
        ? "book"
        : "routines";

/** The kind's icon where a row about no agent has no face: loose, in the face's room. */
function KindIcon({ row }: { row: TeamWeekRow }) {
  return (
    <span className="tw__kind" data-kind={row.kind} aria-hidden="true">
      <Icon name={kindIcon(row)} size={16} />
    </span>
  );
}

/**
 * A row that opens a place: the face (or the kind's icon), the title and its line beside it, a chevron; the whole row
 * is the button. Approvals open under it, as the conversation draws them; the rest go where they wait. Done, it says so
 * in the line and opens nothing.
 */
function PlaceRow({
  row,
  state,
  title,
  line,
  doneText,
  onOpen,
}: {
  row: TeamWeekRow;
  state: TeamWeekRowState;
  title: string;
  line: string;
  doneText: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [showing, setShowing] = useState(false);
  const list = useId();
  const agentId = "agentId" in row ? row.agentId : null;
  const lead = agentId ? (
    <AgentAvatar agentId={agentId} name={dir.anyAgent(agentId)?.name ?? ""} size="sm" />
  ) : (
    <KindIcon row={row} />
  );
  if (state !== "open")
    return (
      <div className="tw__go" data-ended="">
        {lead}
        <span className="tw__text">
          <span className="tw__title">{title}</span>
          {state === "done" ? (
            <span className="tw__line ac-iconline" data-ok="">
              <Icon name="check" size={14} />
              <span>{doneText}</span>
            </span>
          ) : (
            <span className="tw__line">{t(state === "gone" ? "teamWeek.gone" : "teamWeek.skipped")}</span>
          )}
        </span>
      </div>
    );
  const asks = row.kind === "approvals" ? row.approvalIds : null;
  return (
    <>
      <button
        type="button"
        className="tw__go"
        aria-expanded={asks ? showing : undefined}
        aria-controls={asks && showing ? list : undefined}
        onClick={asks ? () => setShowing((v) => !v) : onOpen}
      >
        {lead}
        <span className="tw__text">
          <span className="tw__title">{title}</span>
          <span className="tw__line">{line}</span>
        </span>
        <Icon name="chevronRight" size={16} className="tw__chev" />
      </button>
      {asks && showing && (
        <div id={list} className="tw__approvals">
          {asks.map((id) => (
            <CardApproval key={id} id={id} />
          ))}
        </div>
      )}
    </>
  );
}

/** One agent's suggestions under its face and what to call them; a row about no agent stands alone, with no head. */
function MarkGroup({
  agentId,
  title,
  children,
}: {
  agentId: string | null;
  title: string | null;
  children: ReactNode;
}) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const head = useId();
  if (!agentId || !title) return <div className="tw__group">{children}</div>;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of checkboxes inside a card, not a form's fieldset
    <div className="tw__group" role="group" aria-labelledby={head}>
      <div className="tw__head">
        <AgentAvatar agentId={agentId} name={dir.anyAgent(agentId)?.name ?? ""} size="sm" />
        <span id={head} className="tw__head-t">
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

/**
 * One suggestion: its round check, then its title over its line, the whole line its label. Unmarked, one the reader
 * can put away for good says "Dismiss" at its end. Ended, the check (or its room) and how it ended, with Undo
 * while its receipt allows.
 */
function MarkRow({
  message,
  state,
  title,
  line,
  marked,
  onMark,
  proposal,
  doneText,
  onSkip,
  applying,
  busy,
}: {
  message: Message;
  state: TeamWeekRowState;
  title: string;
  line: string;
  marked: boolean;
  onMark: (on: boolean) => void;
  proposal: Proposal | undefined;
  doneText: string;
  /** "Dismiss": puts this one suggestion away for good. Absent on a row that has none. */
  onSkip?: () => Promise<unknown>;
  /** The footer's button is applying the marked rows: the marks hold still meanwhile. */
  applying: boolean;
  /** Anything the card sends is on its way: "Dismiss" waits for it. */
  busy: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const actions = useAgentActions(org.id, message.channelId);
  const qc = useQueryClient();
  const toast = useToast();
  const [skipping, setSkipping] = useState(false);
  const id = useId();
  if (state === "open")
    return (
      <div className="tw__item" data-off={marked ? undefined : ""}>
        <label htmlFor={id} className="tw__mark">
          <Checkbox
            id={id}
            className="tw__check"
            checked={marked}
            onCheckedChange={onMark}
            disabled={applying}
            aria-label={title}
            aria-describedby={`${id}-line`}
          />
          <span className="tw__text">
            <span className="tw__title">{title}</span>
            <span id={`${id}-line`} className="tw__line">
              {line}
            </span>
          </span>
        </label>
        {!marked && onSkip && (
          <Button
            variant="link"
            className="tw__end"
            loading={skipping}
            disabled={busy}
            onClick={() => {
              setSkipping(true);
              void onSkip().finally(() => setSkipping(false));
            }}
          >
            {t("teamWeek.skip")}
          </Button>
        )}
      </div>
    );
  const receipt = proposal?.undoActionId ? message.actions?.find((a) => a.id === proposal.undoActionId) : undefined;
  const undoable =
    receipt && !receipt.undoneAt && receipt.undoableUntil && Date.parse(receipt.undoableUntil) > Date.now();
  return (
    <div className="tw__item" data-ended="">
      <div className="tw__mark">
        <span className="tw__ok">{state === "done" && <Icon name="check" size={16} />}</span>
        <span className="tw__text">
          <span className="tw__title">{title}</span>
          {state === "done" ? (
            <span className="tw__line" data-ok="">
              {receipt?.undoneAt ? t("rightHand.card.undone") : doneText}
            </span>
          ) : (
            <span className="tw__line">{t(state === "gone" ? "teamWeek.gone" : "teamWeek.skipped")}</span>
          )}
        </span>
      </div>
      {undoable && (
        <Button
          variant="link"
          className="tw__end"
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
    </div>
  );
}

/** "Every Friday at 5:00 PM · Change": when the card it sits on comes to its reader, changed in place, or stopped. */
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
