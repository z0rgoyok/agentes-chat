import {
  type Message,
  type Proposal,
  useActOnTeamWeek,
  useApprovals,
  useCardProposals,
  useChannels,
  useModelLabel,
  useTeamWeekPrefs,
  useWaitingOnMe,
} from "@agenteschat/client";
import { clockAt, formatUsd, joinNames } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { teamWeekOn, teamWeekWhen } from "@agenteschat/client/lib/right-hand-prefs";
import {
  markedAtFirst,
  opensPlace,
  skipsAlone,
  type TeamWeekCard,
  type TeamWeekNames,
  type TeamWeekRow,
  type TeamWeekRowState,
  teamWeekApplyLabel,
  teamWeekCardOf,
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
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, LayoutAnimationConfig } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  Button,
  Disclosure,
  Icon,
  type IconName,
  LineIcon,
  PressScale,
  RowAction,
  Text,
  TOUCH,
  useReducedMotion,
} from "@/ui";
import { router } from "@/ui/navigation";
import { ApplyProposal, UndoProposal } from "../agents/InstructionProposalCard";
import { proposalOutcome } from "../agents/logic";
import { useCardTop, useMessageCardFrame } from "../chat/look";
import { chatHref } from "../links/logic";
import { useFailed } from "../routines/hooks";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { openRightHandSettings } from "./SettingsScreen";

const NANO = 1_000_000_000;
/** An agent's face beside its rows. */
const FACE = 32;
/** The face and its gap: where a group's words start, so each of its marks starts there too. */
const INDENT = FACE + 10;
/** A suggestion's round mark. */
const TICK = 22;
/** How far a row's press reaches into the gaps around it: a finger's target, laid out at the words' height. */
const REACH = 6;
/** A row applied while the card shows fades into its done line (one done before it mounts just shows). */
const DONE_IN = FadeIn.duration(160);

/** One of Lodi's own fixes: a settings proposal its review applies or leaves out (ADR 0219). */
type FixRowData = Extract<TeamWeekRow, { proposalId: string }>;
const isFix = (row: TeamWeekRow): row is FixRowData => "proposalId" in row;

/**
 * Lodi's weekly card (ADR 0137 §9), as on the web: the four numbers two by two, what worked, then what needs doing. A
 * row that opens a place (approvals to decide, what waits on the reader, an agent that stopped) opens it on a tap;
 * Lodi's own fixes (a budget, a channel, a model, archiving an agent) are its review's to apply (ADR 0219), so each
 * says how that went, with Undo; every other suggestion comes marked, under its agent's face, and the card's one
 * button applies the marked ones as whoever taps. "Not now", and the day and hour, changed in Settings › Lodi. The
 * day's card (ADR 0177 §2) is led by what waits on its reader and what is stuck.
 */
export function TeamWeek({ message: m }: { message: Message }) {
  const card = m.author.type === "agent" ? teamWeekCardOf(m.meta) : null;
  // A fix done while the card shows fades into its done line; one done before it mounts just shows.
  return card ? (
    <LayoutAnimationConfig skipEntering>
      <WeekCard message={m} card={card} />
    </LayoutAnimationConfig>
  ) : null;
}

function WeekCard({ message, card }: { message: Message; card: TeamWeekCard }) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const c = useColors();
  const cardTop = useCardTop();
  const frame = useMessageCardFrame();
  const dir = useDirectory();
  const channels = useChannels(orgId).data ?? [];
  const proposals = useCardProposals(orgId, card.proposalIds);
  const approvals = useApprovals(orgId);
  const act = useActOnTeamWeek(orgId);
  const prefs = useTeamWeekPrefs(orgId).data;
  const waiting = useWaitingOnMe(orgId);
  const admin = can(org, "administrator");
  // A weekly card kept by someone who no longer administers: the daily one is what they get now.
  const period = admin ? (card.period ?? "week") : "day";
  const failed = useFailed();
  const modelLabel = useModelLabel();
  const [applying, setApplying] = useState(false);
  // The reader's changes to the card's first marks, by row id: this card's own state, never saved.
  const [marks, setMarks] = useState<Record<string, boolean>>({});
  const locale = i18n.language;
  const names: TeamWeekNames = {
    agent: (id) => (id ? dir.anyAgent(id)?.name : undefined) ?? t("channel.unknownAgent"),
    handle: (id) => (id ? (dir.anyAgent(id)?.handle ?? null) : null),
    channel: (id) => channels.find((ch) => ch.id === id)?.name ?? "…",
    usd: (n) => formatUsd(locale, Math.round(n / NANO)),
    join: (list) => joinNames(list, t),
    since: (iso) => clockAt(locale, iso),
    model: (id) => modelLabel(id) ?? id,
  };
  const rows = card.rows.map((row) => ({
    row,
    state: teamWeekRowState(card, row, {
      proposals,
      approvals: approvals.data,
      waiting: waiting.data?.items.map((i) => i.id),
    }),
  }));
  const stateOf = new Map(rows.map((r) => [r.row.id, r.state] as const));
  // Lodi's fixes are never the reader's to apply (ADR 0219): what is open is the rest.
  const open = rows.filter((r) => r.state === "open" && !isFix(r.row));
  const isMarked = (row: TeamWeekRow) => marks[row.id] ?? markedAtFirst(row);
  // What the card's one button applies: the open suggestions still marked.
  const marked = open.filter((r) => !opensPlace(r.row) && isMarked(r.row)).map((r) => r.row);
  // What waits or is stuck is opened, not applied: the head counts only what the card suggests.
  const suggested = open.filter((r) => !teamWeekRowPlace(r.row));
  const places = card.rows.filter(opensPlace);
  const groups = teamWeekGroups(card.rows);
  const dismissed = !!card.dismissedAt;
  const lodi = dir.agents.find(isRightHand);
  const lodiName = lodi?.name ?? "Lodi";
  const apply = async (row: TeamWeekRow) => {
    const place = teamWeekRowPlace(row);
    if (place)
      router.push(
        (place.to === "waiting"
          ? "/activity"
          : place.to === "task"
            ? `/issues/${place.number}`
            : chatHref(place.channelId)) as never,
      );
    else if (row.kind === "approvals") {
      const next = row.approvalIds.find((id) => approvals.data?.find((a) => a.id === id)?.status === "pending");
      router.push(`/approval/${next ?? row.approvalIds[0]}` as never);
    } else
      await act.mutateAsync({ messageId: message.id, act: { rowId: row.id, text: teamWeekRowMessage(t, row, names) } });
  };
  const applyAll = async () => {
    setApplying(true);
    try {
      for (const row of marked) await apply(row);
    } catch (e) {
      failed(e);
    } finally {
      setApplying(false);
    }
  };
  const { stats } = card;
  // Flat on the card: three on one line, or two by two with the workspace's money. Amber only for what waits on the
  // person; "stuck" counts the week's failed runs (the server's `failed`), errors, so red.
  const stat = (value: string, label: string, color?: string) => (
    <View key={label} style={[styles.stat, stats.budgetNanoUsd > 0 ? styles.statOfFour : styles.statOfThree]}>
      <Text variant="title" style={[styles.statValue, color ? { color } : null]} numberOfLines={1}>
        {value}
      </Text>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
    </View>
  );
  return (
    // Its week ("How the team's week went, Oct 28 to Nov 3") is the message's text, above.
    <View>
      <View style={[styles.card, frame.style, cardTop]}>
        <View style={styles.head}>
          <Text variant="cardKind">{t(teamWeekTitleKey(card))}</Text>
          {suggested.length > 0 && !dismissed ? (
            <Text variant="footnote" style={[styles.semibold, { color: c.amber }]}>
              {t("teamWeek.suggestions", { count: suggested.length })}
            </Text>
          ) : null}
        </View>
        <View style={styles.stats}>
          {stat(String(stats.done), t("teamWeek.stat.done"))}
          {stat(String(stats.stuck), t("teamWeek.stat.stuck"), stats.stuck > 0 ? c.danger : undefined)}
          {stat(String(stats.waiting), t("teamWeek.stat.waiting"), stats.waiting > 0 ? c.amber : undefined)}
          {/* The workspace's money: only on an administrator's card. */}
          {stats.budgetNanoUsd > 0
            ? stat(names.usd(stats.spentNanoUsd), t("teamWeek.stat.budget", { budget: names.usd(stats.budgetNanoUsd) }))
            : null}
        </View>
        {card.worked.length > 0 ? (
          <View style={styles.section}>
            <Text variant="cardKind">{t("teamWeek.worked")}</Text>
            {card.worked.map((w) => (
              <View key={`${w.kind}:${w.agentId}`} style={styles.line}>
                <LineIcon name="check" size={13} color={c.ok} variant="footnote" />
                <Text variant="footnote" tone="ink" style={styles.fill}>
                  {w.kind === "runs"
                    ? t("teamWeek.workedRuns", {
                        name: names.agent(w.agentId),
                        count: w.count,
                        channel: names.channel(w.channelId),
                      })
                    : t("teamWeek.workedTasks", { name: names.agent(w.agentId), count: w.count })}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        {dismissed ? (
          <Text variant="footnote" tone="muted" style={styles.section}>
            {t("teamWeek.dismissed")}
          </Text>
        ) : rows.length > 0 ? (
          <View style={styles.section}>
            <Text variant="cardKind">{t(card.period === "day" ? "teamWeek.needsYou" : "teamWeek.improve")}</Text>
            {places.map((row, i) => {
              const text = teamWeekRowText(t, locale, row, names);
              return (
                <PlaceRow
                  key={row.id}
                  divider={i > 0}
                  row={row}
                  state={stateOf.get(row.id) ?? "open"}
                  title={text.title}
                  line={text.line}
                  action={text.action}
                  doneText={teamWeekDoneText(t, row, lodiName)}
                  onOpen={() => void apply(row).catch(failed)}
                />
              );
            })}
            {groups.map((group, i) => (
              // A hairline between groups, as between rows that open a place; none inside a group.
              <View
                key={group.agentId ?? group.rows[0]?.id}
                style={[styles.group, places.length + i > 0 && [styles.divided, { borderTopColor: c.line2 }]]}
              >
                {group.agentId ? (
                  <View style={styles.groupHead}>
                    <AgentFace agentId={group.agentId} size={FACE} live={false} />
                    <Text variant="subhead" style={[styles.semibold, styles.fill]}>
                      {teamWeekGroupTitle(t, group, names)}
                    </Text>
                  </View>
                ) : null}
                {group.rows.map((row) => {
                  const text = teamWeekItemText(t, locale, row, names);
                  if (isFix(row))
                    return (
                      <FixRow
                        key={row.id}
                        message={message}
                        row={row}
                        state={stateOf.get(row.id) ?? "open"}
                        lead={!group.agentId}
                        title={text.title}
                        line={text.line}
                        proposal={proposals.find((p) => p.id === row.proposalId)}
                      />
                    );
                  return (
                    <MarkRow
                      key={row.id}
                      row={row}
                      state={stateOf.get(row.id) ?? "open"}
                      lead={!group.agentId}
                      marked={isMarked(row)}
                      title={text.title}
                      line={text.line}
                      doneText={teamWeekDoneText(t, row, lodiName)}
                      applying={applying}
                      busy={applying || act.isPending}
                      onToggle={() => setMarks((m) => ({ ...m, [row.id]: !(m[row.id] ?? markedAtFirst(row)) }))}
                      onSkip={
                        skipsAlone(row)
                          ? () =>
                              act
                                .mutateAsync({ messageId: message.id, act: { rowId: row.id, skip: true } })
                                .catch(failed)
                          : undefined
                      }
                    />
                  );
                })}
              </View>
            ))}
          </View>
        ) : null}
        <View style={[styles.foot, { borderTopColor: c.line2 }]}>
          {/* What the marked rows do, in one tap: gone once nothing open is left marked. */}
          {!dismissed && marked.length > 0 ? (
            <Button
              variant="primary"
              wide
              label={teamWeekApplyLabel(t, marked)}
              loading={applying}
              onPress={() => void applyAll()}
            />
          ) : null}
          {!dismissed && open.length > 0 ? (
            <Button
              variant="ghost"
              wide
              label={t("teamWeek.notNow")}
              disabled={applying}
              onPress={() => act.mutate({ messageId: message.id, act: { dismiss: true } }, { onError: failed })}
            />
          ) : null}
          {prefs ? (
            <Pressable
              accessibilityRole="button"
              onPress={openRightHandSettings}
              hitSlop={{ left: 8, right: 8 }}
              style={({ pressed }) => [styles.when, pressed && styles.pressed]}
            >
              <Text variant="footnote" tone="muted">
                {teamWeekOn(prefs, period, admin) ? teamWeekWhen(t, locale, prefs, period) : t("teamWeek.off")}
                {" · "}
                <Text variant="footnote" tone="ink" style={styles.semibold}>
                  {t("teamWeek.change")}
                </Text>
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/** What leads a row about no agent, where a face would be: its kind's icon. */
const kindIcon = (row: TeamWeekRow): IconName =>
  row.kind === "unanswered" ? "help" : row.kind === "stalled" ? "issue" : "clock";

/**
 * A row that opens where it is (approvals, what waits on the reader, an agent that stopped): one tap on the whole
 * row, a chevron at its end and no button. Once done, the check and what was done in its line's place.
 */
function PlaceRow({
  divider,
  row,
  state,
  title,
  line,
  action,
  doneText,
  onOpen,
}: {
  /** A hairline above it: every row but the section's first. */
  divider: boolean;
  row: TeamWeekRow;
  state: TeamWeekRowState;
  title: string;
  line: string;
  /** Where the tap goes ("Open conversation"), read after the row's words. */
  action: string;
  doneText: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const reduced = useReducedMotion();
  const agentId = "agentId" in row ? row.agentId : null;
  const lead = (
    <View style={styles.lead}>
      {agentId ? (
        <AgentFace agentId={agentId} size={FACE} live={false} />
      ) : (
        // What waits on the reader in amber, as its number above.
        <Icon name={kindIcon(row)} size={18} color={row.kind === "waiting" ? c.amber : c.muted} />
      )}
    </View>
  );
  return (
    // The hairline stays out of the press, so it never scales with it.
    <View style={divider ? [styles.divided, { borderTopColor: c.line2 }] : null}>
      {state === "open" ? (
        <PressScale
          to={0.98}
          fill={false}
          accessibilityRole="button"
          accessibilityLabel={`${title}, ${line}`}
          accessibilityHint={action}
          onPress={onOpen}
          style={styles.placeReach}
          contentStyle={styles.place}
        >
          {lead}
          <View style={styles.fill}>
            <Text variant="subhead" style={styles.semibold}>
              {title}
            </Text>
            <Text variant="footnote" tone="muted">
              {line}
            </Text>
          </View>
          <Disclosure color={c.faint} />
        </PressScale>
      ) : (
        <View style={[styles.placeReach, styles.place]}>
          {lead}
          <View style={styles.fill}>
            <Text variant="subhead" tone="muted" style={styles.semibold}>
              {title}
            </Text>
            {state === "done" ? (
              <Animated.View entering={reduced ? undefined : DONE_IN} style={styles.line}>
                <LineIcon name="check" size={13} color={c.ok} variant="footnote" />
                <Text variant="footnote" tone="ok" style={[styles.semibold, styles.fill]}>
                  {doneText}
                </Text>
              </Animated.View>
            ) : (
              <Text variant="footnote" tone="muted">
                {t(state === "gone" ? "teamWeek.gone" : "teamWeek.skipped")}
              </Text>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

/**
 * A suggestion to mark, under its agent's face: a tap anywhere on the line marks or unmarks it. Unmarked, one that can
 * be put away for good offers Dismiss; applied, it shows what was done.
 */
function MarkRow({
  row,
  state,
  lead,
  marked,
  title,
  line,
  doneText,
  applying,
  busy,
  onToggle,
  onSkip,
}: {
  row: TeamWeekRow;
  state: TeamWeekRowState;
  /** A row about no agent: no face above it, its kind's icon before its mark. */
  lead: boolean;
  marked: boolean;
  title: string;
  line: string;
  doneText: string;
  /** The card's button is applying the marked rows: the marks hold still meanwhile. */
  applying: boolean;
  busy: boolean;
  onToggle: () => void;
  /** Dismiss: puts this one suggestion away for good. Absent on a row that has none. */
  onSkip?: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const reduced = useReducedMotion();
  const [skipping, setSkipping] = useState(false);
  // The face's column, empty under a group's face: every mark starts where the group's words do.
  const indent = (
    <View style={styles.indent}>
      {lead ? <LineIcon name={kindIcon(row)} size={18} color={c.muted} variant="subhead" /> : null}
    </View>
  );
  if (state === "open")
    return (
      <View style={styles.markRow}>
        <PressScale
          to={0.98}
          fill={false}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: marked, disabled: applying }}
          accessibilityLabel={`${title}, ${line}`}
          disabled={applying}
          onPress={onToggle}
          style={styles.fill}
          contentStyle={styles.mark}
        >
          {indent}
          <Tick look={marked ? "on" : "off"} />
          <View style={styles.words}>
            <Text variant="subhead" tone={marked ? "ink" : "muted"}>
              {title}
            </Text>
            <Text variant="footnote" tone="muted">
              {line}
            </Text>
          </View>
        </PressScale>
        {/* Beside the line, not in it: its own target, and its own button for a screen reader. */}
        {!marked && onSkip ? (
          <View style={styles.side}>
            <RowAction
              label={t("teamWeek.skip")}
              disabled={busy || skipping}
              onPress={() => {
                setSkipping(true);
                void onSkip().finally(() => setSkipping(false));
              }}
            />
          </View>
        ) : null}
      </View>
    );
  return (
    <View style={styles.markRow}>
      <View style={[styles.fill, styles.mark]}>
        {indent}
        <Tick look={state === "done" ? "done" : "none"} />
        <View style={styles.words}>
          <Text variant="subhead" tone="muted">
            {title}
          </Text>
          {state === "done" ? (
            <Animated.View entering={reduced ? undefined : DONE_IN}>
              <Text variant="footnote" tone="ok" style={styles.semibold}>
                {doneText}
              </Text>
            </Animated.View>
          ) : (
            <Text variant="footnote" tone="muted">
              {t(state === "gone" ? "teamWeek.gone" : "teamWeek.skipped")}
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}

/**
 * One of Lodi's fixes, under its agent's face: never marked, as its review applies it or leaves it out (ADR 0219).
 * "Reviewing…" for the few seconds before, then how it ended with the review's why, and Undo while the reader may put
 * it back. One put back from its receipt (an older card's Undo) reads undone, with nothing left to undo.
 */
function FixRow({
  message,
  row,
  state,
  lead,
  title,
  line,
  proposal,
}: {
  message: Message;
  row: FixRowData;
  state: TeamWeekRowState;
  /** A row about no agent: no face above it, its kind's icon before its mark. */
  lead: boolean;
  title: string;
  line: string;
  proposal: Proposal | undefined;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const meId = useMeId();
  const reduced = useReducedMotion();
  const receipt = proposal?.undoActionId ? message.actions?.find((a) => a.id === proposal.undoActionId) : undefined;
  const back = Boolean(receipt?.undoneAt);
  const outcome = proposal ? proposalOutcome(t, proposal, meId) : null;
  // Decided by a person, or overtaken, on an older card: it reads as it always did, as on the web.
  const asBefore = Boolean(proposal) && !outcome?.reviewing && !proposal?.reviewed && proposal?.status !== "undone";
  const applied = (asBefore ? state === "done" : Boolean(outcome?.applied)) && !back;
  // Put away before its review (an older card), or not read yet: the card's own words, or the suggestion's line.
  const words =
    state === "skipped"
      ? t("teamWeek.skipped")
      : back
        ? t("rightHand.card.undone")
        : asBefore
          ? t(state === "done" ? "teamWeek.applied" : "teamWeek.gone")
          : (outcome?.words ?? line);
  const why = state === "skipped" || back || asBefore ? null : outcome?.why;
  return (
    <View style={styles.markRow}>
      <View style={[styles.fill, styles.mark]}>
        <View style={styles.indent}>
          {lead ? <LineIcon name={kindIcon(row)} size={18} color={c.muted} variant="subhead" /> : null}
        </View>
        <Tick look={applied ? "done" : "none"} />
        <View style={styles.words}>
          <Text variant="subhead" tone={outcome?.reviewing ? "ink" : "muted"}>
            {title}
          </Text>
          {/* Its own view per state, so the outcome fades in where "Reviewing…" was. */}
          <Animated.View
            key={outcome?.reviewing ? "reviewing" : "ended"}
            entering={reduced || outcome?.reviewing ? undefined : DONE_IN}
          >
            <Text variant="footnote" tone={applied ? "ok" : "muted"} style={applied ? styles.semibold : null}>
              {words}
            </Text>
            {why ? (
              <Text variant="footnote" tone="faint">
                {why}
              </Text>
            ) : null}
          </Animated.View>
        </View>
      </View>
      {proposal?.undoable && !back && state !== "skipped" ? (
        <Animated.View entering={reduced ? undefined : DONE_IN} style={styles.side}>
          <UndoProposal id={proposal.id} row />
        </Animated.View>
      ) : proposal?.applicable && state !== "skipped" ? (
        <View style={styles.side}>
          <ApplyProposal id={proposal.id} row />
        </View>
      ) : null}
    </View>
  );
}

/**
 * A suggestion's mark, round, on its title's first line: filled in ink with the check in the page's color when marked
 * (as a task's criteria), a ring when not, the check in ok once applied, and nothing once it no longer applies.
 */
function Tick({ look }: { look: "on" | "off" | "done" | "none" }) {
  const c = useColors();
  const reduced = useReducedMotion();
  return (
    <LineIcon variant="subhead" size={TICK}>
      {look === "done" ? (
        <Animated.View entering={reduced ? undefined : DONE_IN} style={styles.tick}>
          <Icon name="check" size={16} weight="bold" color={c.ok} />
        </Animated.View>
      ) : (
        <View
          style={[
            styles.tick,
            look === "on" && { backgroundColor: c.ink },
            look === "off" && { borderWidth: 1.5, borderColor: c.faint },
          ]}
        >
          {look === "on" ? <Icon name="check" size={13} weight="bold" color={c.bg} /> : null}
        </View>
      )}
    </LineIcon>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingTop: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderBottomLeftRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  head: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 },
  semibold: { fontWeight: "600" },
  stats: { flexDirection: "row", flexWrap: "wrap", rowGap: 12, columnGap: 8, marginTop: 12 },
  stat: { flexGrow: 1, gap: 2 },
  statOfFour: { flexBasis: "47%" },
  statOfThree: { flexBasis: "30%" },
  statValue: { fontVariant: ["tabular-nums"] },
  section: { marginTop: 16, gap: 8 },
  // An icon on the first line of the words beside it.
  line: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  fill: { flex: 1, minWidth: 0 },
  // 12 above the hairline (with the section's gap) and 12 under it.
  divided: { marginTop: 4, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  // A face (or the kind's icon) centred on the words beside it, 2 above and below as laid out.
  placeReach: { marginVertical: -REACH },
  place: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 2 + REACH },
  lead: { width: FACE, alignItems: "center" },
  group: { gap: 12 },
  // Beside a face the title centres on it.
  groupHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  // Each line's press takes half the gap above and under it: the lines' targets meet, and none moves the words.
  markRow: { flexDirection: "row", alignItems: "flex-start", marginVertical: -REACH },
  mark: { flexDirection: "row", alignItems: "flex-start", paddingVertical: REACH, minHeight: TOUCH },
  indent: { width: INDENT, paddingRight: INDENT - FACE, alignItems: "center" },
  tick: { width: TICK, height: TICK, borderRadius: TICK / 2, alignItems: "center", justifyContent: "center" },
  words: { flex: 1, minWidth: 0, gap: 2, marginLeft: 12 },
  // 12 from the words, and the word on the card's edge: RowAction pads its word 4 each side. Its 32 share the title's
  // middle in the line's padding.
  side: { marginLeft: 8, marginRight: -4 },
  foot: {
    marginTop: 14,
    marginHorizontal: -14,
    paddingTop: 12,
    paddingHorizontal: 14,
    paddingBottom: 14,
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  // A finger's 44 points tall, laid out as the line's 28: 8 above and below reach into the footer's gap and padding.
  when: { alignSelf: "flex-start", minHeight: 44, marginVertical: -8, justifyContent: "center" },
  pressed: { opacity: 0.6 },
});
