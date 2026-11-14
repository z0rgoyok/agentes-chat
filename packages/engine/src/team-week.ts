import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  arrayContained,
  type Database,
  desc,
  type Executor,
  eq,
  gte,
  isNull,
  rowsOf,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { modelForTier, modelInfo } from "@agenteschat/providers";
import { listApprovals } from "./approvals";
import { DIGEST_FROM, digestWaitingOn } from "./approvals-digest";
import { editContextItem, howToSql } from "./context/items";
import { LEARN_DEFAULTS } from "./context/learn";
import {
  decideProposal,
  IDLE_MS,
  IDLE_REASON,
  idleAgentSql,
  LIGHT_WORK_REASON,
  NO_CHANNEL_REASON,
  OVER_BUDGET_REASON,
  proposeSettings,
} from "./context/proposals";
import { personAgentDmKey } from "./dms";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { cutText, stringsOf } from "./format";
import { commentIssue } from "./issues";
import { getMessage, postPersonMessage } from "./messages";
import { maySql } from "./permissions";
import { pushStrings } from "./push-messages";
import { taskEndToldSql } from "./right-hand-follow";
import {
  knownZonesSql,
  type LodiPrefs,
  lodiPrefsOf,
  lodiPrefsSql,
  readLodiPrefs,
  setLodiPrefs,
  zoneSql,
} from "./right-hand-prefs";
import { lodiFor, postFromLodi, setCardOnMessage } from "./right-hand-proactive";
import { createRoutine, type RoutineDeps } from "./routines";
import { localDate, nextOccurrence, type ScheduleRule } from "./rrule";
import { runErrorDetail } from "./runs";
import { userVisibleChannels } from "./search";
import { openOrg } from "./standing";
import { channelReaderSql, taskSeenSql } from "./task-access";
import { listWaiting } from "./waiting";

/**
 * "Semana da equipe" (ADR 0137 §9): once a week Lodi posts one card in each admin's DM with it, from what the server
 * already stores (runs, approvals, budgets, channels, unanswered questions, requests repeated by hand, stalled steps),
 * with no model call. Each row is a fix applied as whoever clicks, through the paths the other cards use: a settings
 * proposal (budget, a channel), the approvals list, a routine, a message to Lodi or to a task's conversation.
 * "Resumo do dia" (ADR 0177 §2) is the same card for everyone, about the reader alone: what waits on them, what their
 * agents finished and what is stuck and why, only on a day with something new of theirs. When each comes is the
 * person's own choice (`right-hand-prefs.ts`).
 */

const { agents, contextItems, contextProposals, organizationSettings, outbox } = schema;

export const TEAM_WEEK_JOB = "team_week.post";
/**
 * The day's card is queued under a kind of its own. A server of the version before the two cards has no handler for
 * it, so while both versions run it fails that job instead of reading it as a week's card.
 */
export const TEAM_DAY_JOB = "team_day.post";
export const TEAM_WEEK_CARD = "team_week";
/** The tool through which a person tells Lodi to stop the card or move it. */
export const SET_TEAM_WEEK_TOOL = "set_team_week";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** A slot missed for longer (the server was down) waits for the next week: a Friday card on Sunday is noise. */
const POST_WINDOW_MS = 6 * HOUR_MS;
/** Steps of a task that moved for this long are stalled. */
const STALL_MS = 4 * HOUR_MS;
/** A request typed by hand on this many days of the week is a routine waiting to be made. */
const REPEAT_DAYS = 3;
/** Questions left unanswered in one channel before it is worth an agent. */
const UNANSWERED_MIN = 3;
/** In a team, questions from this many people: one person asking alone is talking to themselves. */
const UNANSWERED_ASKERS = 2;
/** Done runs in `IDLE_MS` before an agent's work is judged light, and how many in ten of them must be. */
const LIGHT_RUNS = 20;
const LIGHT_IN_TEN = 9;
/** A light run: this many model calls and output tokens at most. */
const LIGHT_TURNS = 2;
const LIGHT_TOKENS = 800;
const MAX_ROWS = 6;
const MAX_DAY_ROWS = 5;
/** A run parked on its plan, its budget or its computer for this long is stuck: a shorter wait ends by itself. */
const HELD_MS = 4 * HOUR_MS;
/** How far back a day's card reaches for the one before it, so a day with no card is not lost. */
const DAY_REACH_MS = 3 * DAY_MS;
const STUCK_SHOWN = 3;
/** The runs one day's card reads at most: a person's own in a few days, far under it. */
const DAY_RUNS = 500;
const NANO = 1_000_000_000;

/** "Resumo do dia" or "Semana da equipe". */
export type TeamWeekPeriod = "day" | "week";

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/** What a card looks back on. */
export const teamWeekSpan = (period: TeamWeekPeriod) => (period === "day" ? DAY_MS : WEEK_MS);

/**
 * The latest slot of that card at or before `now`, within one span. `timezone` is the one its hour is in: the
 * person's own for the day's, the workspace's for the week's.
 */
export function lastTeamWeekSlot(
  period: TeamWeekPeriod,
  prefs: Pick<LodiPrefs, "day" | "weekHour" | "dayHour">,
  timezone: string,
  now: Date,
): Date | null {
  const times = [`${String(period === "day" ? prefs.dayHour : prefs.weekHour).padStart(2, "0")}:00`];
  const rule: ScheduleRule =
    period === "day"
      ? { freq: "daily", times, timezone }
      : { freq: "weekly", byWeekday: [WEEKDAYS[prefs.day] as string], times, timezone };
  const at = nextOccurrence(rule, new Date(now.getTime() - teamWeekSpan(period)));
  return at && at.getTime() <= now.getTime() ? at : null;
}

const localHour = (at: Date, timezone: string) =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(at));

/** 0 = Sunday … 6 = Saturday, where `at` falls in that time zone. */
const localWeekday = (at: Date, timezone: string) => new Date(`${localDate(at, timezone)}T00:00:00Z`).getUTCDay();

/** The Monday of the local week `at` falls in: one card per person per week, whatever day they move it to. */
export function weekKey(at: Date, timezone: string) {
  const day = new Date(`${localDate(at, timezone)}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

/** One job per person and day, and one per person and week: the key a second enqueue of the same card runs into. */
export const teamWeekJobKey = (orgId: string, userId: string, period: TeamWeekPeriod, slot: Date, timezone: string) =>
  `${TEAM_WEEK_JOB}:${orgId}:${userId}:${period === "day" ? `day:${localDate(slot, timezone)}` : weekKey(slot, timezone)}`;

/**
 * The cards of one person whose slot just passed. The week's is an administrator's. The day's is anyone's, in their
 * own time zone, and is left out on the day the week's card comes: the next day's reaches back over it.
 */
export function dueTeamWeeks(
  prefs: LodiPrefs,
  who: { admin: boolean; timezone: string; dayTimezone: string },
  now: Date,
): { period: TeamWeekPeriod; slot: Date; timezone: string }[] {
  const fresh = (slot: Date | null): slot is Date => !!slot && now.getTime() - slot.getTime() <= POST_WINDOW_MS;
  const weekly = who.admin && !prefs.weekOff;
  const due: ReturnType<typeof dueTeamWeeks> = [];
  const week = weekly ? lastTeamWeekSlot("week", prefs, who.timezone, now) : null;
  if (fresh(week)) due.push({ period: "week", slot: week, timezone: who.timezone });
  const day = prefs.dayOff ? null : lastTeamWeekSlot("day", prefs, who.dayTimezone, now);
  if (fresh(day) && !(weekly && localWeekday(day, who.timezone) === prefs.day))
    due.push({ period: "day", slot: day, timezone: who.dayTimezone });
  return due;
}

// --- The card ------------------------------------------------------------------------------------------------

export type TeamWeekRow =
  /** Approvals of one agent waiting for this person: "Ver e aprovar" opens them on the card. */
  | { id: string; kind: "approvals"; agentId: string; approvalIds: string[]; since: string }
  /** It stopped at its monthly budget: a settings proposal to raise it, applied with Undo. */
  | { id: string; kind: "budget"; agentId: string; proposalId: string; stops: number; from: number; to: number }
  /** In no channel, so nobody talked to it: a settings proposal to add it to one. */
  | { id: string; kind: "channel"; agentId: string; proposalId: string; channelId: string }
  /** People's questions nobody answered in a channel: Lodi is asked for an agent for them. */
  | { id: string; kind: "unanswered"; channelId: string; count: number }
  /** The same request typed on several days: a daily routine at the hour it was asked. */
  | {
      id: string;
      kind: "routine";
      agentId: string;
      /** Where it was asked: a channel, or the person's DM with the agent (`dm`). */
      channelId: string;
      dm: boolean;
      text: string;
      count: number;
      hour: number;
    }
  /**
   * A how-to of the person's own agent reused past the bar that no person vouched for yet (ADR 0167): "Virar skill?"
   * confirms it (`editContextItem` confirmed), and the day's pass makes it a skill.
   */
  | { id: string; kind: "howto"; agentId: string; itemId: string; title: string; uses: number }
  /** Steps of a task waiting on another step for hours: its agent is told to go on with them in parallel. */
  | {
      id: string;
      kind: "stalled";
      issueId: string;
      number: number;
      title: string;
      steps: number[];
      onNumber: number;
      hours: number;
      agentId: string | null;
    };

/** Why a run stopped, as the few causes a card words: never the run's own text. */
export type StuckCause = "budget" | "plan" | "computer" | "key" | "ai" | "other";

/**
 * Rows of kinds added after the first app builds. They travel in `moreRows`, which those builds never read: a kind
 * they do not know would break their card.
 */
export type TeamWeekMoreRow =
  /**
   * What waits on this person besides approvals ("Esperando você"): how many, every inbox row counted (the oldest
   * first, for the apps to tell when none is left) and who asked first. No question's text: the list itself shows it.
   */
  | { id: string; kind: "waiting"; count: number; ids: string[]; agentId: string | null; since: string }
  /**
   * Runs of one agent in one conversation that failed, or that wait (`held`) on a plan, a budget or a computer: the
   * cause and where to open it. `dm`: the reader's own DM with the agent. `issueNumber`: a task's conversation.
   */
  | {
      id: string;
      kind: "stuck";
      agentId: string;
      channelId: string;
      dm: boolean;
      issueNumber?: number;
      code: StuckCause;
      count: number;
      held: boolean;
    }
  /**
   * An agent with no run in four weeks, no routine and no open task: a settings proposal to archive it. Counted over
   * all its runs, private conversations included, so it names no conversation.
   */
  | { id: string; kind: "retire"; agentId: string; proposalId: string }
  /**
   * An agent on a large model whose work is light: a settings proposal for the next model down (`from`, `to`: what
   * the proposal's line holds). Counted like `retire`.
   */
  | { id: string; kind: "model"; agentId: string; proposalId: string; from: string; to: string };

export type TeamWeekHighlight =
  | { kind: "runs"; agentId: string; channelId: string; count: number }
  | { kind: "tasks"; agentId: string; count: number };

export interface TeamWeekCard {
  kind: typeof TEAM_WEEK_CARD;
  forUserId: string;
  /** "Resumo do dia" (`day`) or the week's (absent on cards from before it). */
  period?: "day" | "week";
  /** The slot it was posted for (absent on cards from before it): what a retry of its job finds. */
  slot?: string;
  /** The week's first and last day, `YYYY-MM-DD` in the workspace's time zone. */
  from: string;
  to: string;
  timezone: string;
  stats: { done: number; stuck: number; waiting: number; spentNanoUsd: number; budgetNanoUsd: number };
  worked: TeamWeekHighlight[];
  rows: TeamWeekRow[];
  moreRows?: TeamWeekMoreRow[];
  /**
   * A day's card: what on it was still open when it went out (inbox rows waiting, runs held, its other rows). The
   * next day's card says nothing when it would only say these again.
   */
  seen?: string[];
  /** The settings proposals on its rows: their receipts (Undo) live on this message. */
  proposalIds: string[];
  /** Rows applied here (the routine made, the message sent), by row id. */
  done: Record<string, { byUserId: string; at: string; routineId?: string }>;
  /**
   * Rows put away alone, by row id. Never in `done`: app builds from before a row could be put away read any entry
   * there as applied.
   */
  skipped?: Record<string, { byUserId: string; at: string }>;
  /** "Agora não". */
  dismissedAt: string | null;
}

export function teamWeekCardOf(meta: Record<string, unknown> | null | undefined): TeamWeekCard | null {
  const c = meta?.actionCard as Partial<TeamWeekCard> | undefined;
  return c?.kind === TEAM_WEEK_CARD && typeof c.forUserId === "string" && Array.isArray(c.rows)
    ? (c as TeamWeekCard)
    : null;
}

interface Window {
  orgId: string;
  userId: string;
  rightHandId: string;
  start: Date;
  end: Date;
  timezone: string;
  /**
   * An administrator's card counts the whole team's runs and the workspace's spend; anyone else's only runs where they
   * read and no money (absent: an administrator's).
   */
  admin?: boolean;
  /** Suggestions this person put away for good (`LodiPrefs.muted`). */
  muted?: string[];
}

/** A card as it is built, before anyone acts on it. */
type BuiltCard = Omit<TeamWeekCard, "done" | "dismissedAt">;

/** Lowercase words without accents, mentions or punctuation: how two requests are told the same. */
export function requestKey(body: string) {
  const words = body
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/@[\w.-]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  return words.length >= 2 ? words.slice(0, 6).join(" ") : null;
}

/** The week's card for this person, or null when there is nothing to say (or no team yet). */
export async function buildTeamWeek(db: Database, w: Window): Promise<BuiltCard | null> {
  const start = w.start.toISOString();
  const end = w.end.toISOString();
  const team = rowsOf<TeamAgent>(
    await db.execute(sql`select id, created_at, monthly_budget_nano_usd as budget, brain, model, brain_model
      from agents where org_id = ${w.orgId} and builtin is null and archived_at is null and deleted_at is null
      order by created_at`),
  );
  if (team.length === 0) return null;
  const teamIds = new Set(team.map((a) => a.id));
  const [settings] = await db
    .select({ budget: organizationSettings.defaultAgentBudgetNanoUsd, mode: organizationSettings.mode })
    .from(organizationSettings)
    .where(eq(organizationSettings.orgId, w.orgId));
  const defaultBudget = Number(settings?.budget ?? 50 * NANO);
  const [lodi] = await db
    .select({ budget: agents.monthlyBudgetNanoUsd })
    .from(agents)
    .where(eq(agents.id, w.rightHandId));
  const budgetOf = (b: number | string | null | undefined) => (b == null ? defaultBudget : Number(b));
  const visible = sql`(c.visibility = 'public' or exists (select 1 from channel_members vm
    where vm.channel_id = c.id and vm.user_id = ${w.userId})
    or (c.kind = 'channel' and ${maySql(w.orgId, sql`${w.userId}::text`, "administrator")}))`;
  const teamRuns = sql`r.org_id = ${w.orgId} and r.created_at >= ${start}::timestamptz and r.created_at < ${end}::timestamptz
    and r.agent_id in (select id from agents where org_id = ${w.orgId} and builtin is null)`;
  const admin = w.admin !== false;

  const [counts] = rowsOf<{ done: number | string; failed: number | string }>(
    await db.execute(sql`select count(*) filter (where r.status = 'done') as done,
      count(*) filter (where r.status = 'failed') as failed from agent_runs r
      ${admin ? sql`` : sql`join channels c on c.id = r.channel_id`}
      where ${teamRuns} ${admin ? sql`` : sql`and ${visible}`}`),
  );
  const monthStart = new Date(Date.UTC(w.end.getUTCFullYear(), w.end.getUTCMonth(), 1)).toISOString();
  const [spent] = rowsOf<{ n: number | string | null }>(
    await db.execute(sql`select coalesce(sum(cost_nano_usd), 0) as n from usage_records
      where org_id = ${w.orgId} and created_at >= ${monthStart}::timestamptz`),
  );

  // Funcionou: the agents that did the most where this person can read, and tasks agents closed.
  const busiest = rowsOf<{ agent_id: string; channel_id: string; n: number | string }>(
    await db.execute(sql`select r.agent_id, r.channel_id, count(*) as n from agent_runs r
      join channels c on c.id = r.channel_id and c.kind = 'channel' and c.archived_at is null
      where ${teamRuns} and r.status = 'done' and ${visible}
      group by r.agent_id, r.channel_id order by n desc limit 2`),
  );
  const closed = rowsOf<{ agent_id: string; n: number | string }>(
    await db.execute(sql`select assignee_id as agent_id, count(*) as n from issues
      where org_id = ${w.orgId} and assignee_type = 'agent' and ${closedByAgentSql("issues", start, end)}
        and ${taskSeenSql("issues", sql`${w.userId}::text`)}
      group by assignee_id order by n desc limit 1`),
  );
  const worked: TeamWeekHighlight[] = [
    ...busiest
      .filter((b) => Number(b.n) >= 3)
      .map((b) => ({ kind: "runs" as const, agentId: b.agent_id, channelId: b.channel_id, count: Number(b.n) })),
    ...closed
      .filter((c) => teamIds.has(c.agent_id) && Number(c.n) >= 2)
      .map((c) => ({ kind: "tasks" as const, agentId: c.agent_id, count: Number(c.n) })),
  ];

  const rows: TeamWeekRow[] = [];
  const proposalIds: string[] = [];

  // Waiting for this person: one row per agent, the longest waiting first.
  const waiting = (await listApprovals(db, w.userId, w.orgId, { status: "pending", limit: 200 })).filter(
    (a) => a.canDecide,
  );
  rows.push(...approvalRows(waiting));

  // Stopped at the budget: raise it by half (whole dollars), through the settings card's own proposal. A run at the
  // budget parks (its `budget_wait` note; still waiting: `waitingForBrain`, cleared on resume) rather than failing.
  const stops = rowsOf<{ agent_id: string; n: number | string }>(
    await db.execute(sql`select agent_id, count(distinct run_id) as n from (
        select r.agent_id, r.id::text as run_id from agent_runs r
        where ${teamRuns} and (r.error = 'budget_exceeded' or (r.status = 'waiting_input'
          and r.transcript->'waitingForBrain'->>'code' = 'budget'))
        union all
        select m.author_agent_id, coalesce(m.meta->'usageWait'->>'runId', m.id::text) from messages m
        where m.org_id = ${w.orgId} and m.created_at >= ${start}::timestamptz and m.created_at < ${end}::timestamptz
          and m.meta->>'bodyCode' = 'budget_wait'
          and m.author_agent_id in (select id from agents where org_id = ${w.orgId} and builtin is null)
      ) s group by agent_id order by n desc limit 2`),
  );
  // A budget is the workspace's money: only an administrator's card offers to raise it.
  for (const s of admin ? stops : []) {
    const agent = team.find((a) => a.id === s.agent_id);
    if (!agent) continue;
    const from = budgetOf(agent.budget);
    const to = Math.max(Math.ceil((from * 1.5) / NANO), Math.ceil(from / NANO) + 5) * NANO;
    const id = await settingsProposal(db, w, s.agent_id, { field: "budget", to }, OVER_BUDGET_REASON);
    if (id) {
      rows.push({
        id: `budget:${s.agent_id}`,
        kind: "budget",
        agentId: s.agent_id,
        proposalId: id,
        stops: Number(s.n),
        from,
        to,
      });
      proposalIds.push(id);
    }
  }

  // In no channel for a day or more: #general (else the oldest public channel).
  const lonely = rowsOf<{ id: string }>(
    await db.execute(sql`select a.id from agents a
      where a.org_id = ${w.orgId} and a.builtin is null and a.archived_at is null and a.deleted_at is null
        and a.created_at < ${new Date(w.end.getTime() - 24 * HOUR_MS).toISOString()}::timestamptz
        and not exists (select 1 from channel_members cm join channels c on c.id = cm.channel_id
          and c.kind = 'channel' and c.archived_at is null and c.deleted_at is null where cm.agent_id = a.id)
      order by a.created_at limit 2`),
  );
  const [home] = lonely.length
    ? rowsOf<{ id: string }>(
        await db.execute(sql`select id from channels where org_id = ${w.orgId} and kind = 'channel'
          and visibility = 'public' and archived_at is null and deleted_at is null
          order by (name = 'general') desc, created_at limit 1`),
      )
    : [];
  const homeId = home?.id;
  for (const a of homeId ? lonely : []) {
    if (!homeId) break;
    const id = await settingsProposal(
      db,
      w,
      a.id,
      { field: "channel_add", channelId: homeId, to: true },
      NO_CHANNEL_REASON,
    );
    if (id) {
      rows.push({ id: `channel:${a.id}`, kind: "channel", agentId: a.id, proposalId: id, channelId: homeId });
      proposalIds.push(id);
    }
  }

  // What this person's last four weeks of cards already suggested: one left alone comes back after that, not before.
  const lately = await suggestedLately(db, w);
  const quiet = [...(w.muted ?? []), ...lately].flatMap((k) => (k.startsWith("unanswered:") ? [k.slice(11)] : []));
  // People's questions nobody answered within a day, where this person can read: the channel with the most. In a
  // team it takes more than one person asking.
  const askers = settings?.mode === "personal" ? 1 : UNANSWERED_ASKERS;
  const [unanswered] = rowsOf<{ channel_id: string; n: number | string }>(
    await db.execute(sql`select q.channel_id, count(*) as n from messages q
      join channels c on c.id = q.channel_id and c.kind = 'channel' and c.archived_at is null and c.deleted_at is null
      where q.org_id = ${w.orgId} and q.author_type = 'person' and q.deleted_at is null
        and q.created_at >= ${start}::timestamptz
        and q.created_at < ${new Date(w.end.getTime() - 2 * HOUR_MS).toISOString()}::timestamptz
        and position('?' in q.body) > 0 and ${visible}
        and q.channel_id::text <> all(${`{${quiet.join(",")}}`}::text[])
        and not exists (select 1 from messages a where a.org_id = q.org_id and a.channel_id = q.channel_id
          and a.deleted_at is null and a.created_at > q.created_at and a.created_at < q.created_at + interval '1 day'
          and a.author_user_id is distinct from q.author_user_id
          and ((q.thread_id is null and (a.thread_id = q.id
                or (a.thread_id is null and a.created_at < q.created_at + interval '30 minutes')))
            or (q.thread_id is not null and a.thread_id = q.thread_id)))
      group by q.channel_id having count(*) >= ${UNANSWERED_MIN}
        and count(distinct q.author_user_id) >= ${askers} order by n desc limit 1`),
  );
  if (unanswered)
    rows.push({
      id: `unanswered:${unanswered.channel_id}`,
      kind: "unanswered",
      channelId: unanswered.channel_id,
      count: Number(unanswered.n),
    });

  const repeat = await repeatedRequest(db, w, teamIds);
  if (repeat) rows.push(repeat);

  const stalled = await stalledSteps(db, w);
  if (stalled) rows.push(stalled);
  rows.push(...(await provenHowTos(db, w)));

  const stats = {
    done: Number(counts?.done ?? 0),
    stuck: Number(counts?.failed ?? 0),
    waiting: waiting.length,
    // The workspace's money is the administrators' to read.
    spentNanoUsd: admin ? Number(spent?.n ?? 0) : 0,
    budgetNanoUsd: admin ? team.reduce((sum, a) => sum + budgetOf(a.budget), budgetOf(lodi?.budget)) : 0,
  };
  if (stats.done === 0 && stats.stuck === 0 && rows.length === 0) return null;
  // What only an administrator decides, and only their card offers. Asked after the card is known to go out: a
  // suggestion rides a card, it never posts one, and no proposal is made for a card nobody gets.
  const moreRows = admin ? await suggestions(db, w, team, lately) : [];
  proposalIds.push(...moreRows.map((r) => r.proposalId));
  return {
    kind: TEAM_WEEK_CARD,
    forUserId: w.userId,
    from: localDate(w.start, w.timezone),
    to: localDate(new Date(w.end.getTime() - 1), w.timezone),
    timezone: w.timezone,
    stats,
    worked,
    rows: rows.slice(0, MAX_ROWS),
    ...(moreRows.length ? { moreRows } : {}),
    proposalIds,
  };
}

interface TeamAgent {
  id: string;
  created_at: string | Date;
  budget: number | string | null;
  brain: string;
  model: string;
  brain_model: string | null;
}

/**
 * The row ids on this person's weekly cards of the last four weeks, by the slot each was posted for (a card from
 * before cards kept it: by when it was posted), less a few hours so the card four weeks back is outside.
 */
async function suggestedLately(db: Database, w: Window): Promise<Set<string>> {
  const cards = rowsOf<{ card: { rows?: unknown; moreRows?: unknown } | null }>(
    await db.execute(sql`select meta->'actionCard' as card from messages
      where org_id = ${w.orgId} and author_agent_id = ${w.rightHandId}
        and channel_id = (select id from channels where org_id = ${w.orgId}
          and dm_key = ${personAgentDmKey(w.userId, w.rightHandId)})
        and coalesce(meta->'actionCard'->>'slot', ${isoSql(sql`created_at`)})
          >= ${new Date(w.end.getTime() - IDLE_MS + POST_WINDOW_MS).toISOString()}
        and meta->'actionCard'->>'kind' = ${TEAM_WEEK_CARD}
        and coalesce(meta->'actionCard'->>'period', 'week') = 'week'`),
  );
  const ids = new Set<string>();
  for (const { card } of cards)
    for (const list of [card?.rows, card?.moreRows])
      for (const r of Array.isArray(list) ? list : []) if (typeof r?.id === "string") ids.add(r.id);
  return ids;
}

/** The model one size down from a large one, for the brain it thinks with. Null: not large, or nothing in between. */
function smallerModel(a: TeamAgent): { from: string; to: string } | null {
  // Claude Code names its models by size.
  if (a.brain === "claude_code") return a.brain_model === "opus" ? { from: "opus", to: "sonnet" } : null;
  const info = a.brain === "model" ? modelInfo(a.model) : undefined;
  if (info?.tier !== "large") return null;
  const to = modelForTier(info.provider, "medium");
  return to && modelInfo(to)?.tier === "medium" ? { from: a.model, to } : null;
}

/**
 * At most one agent to archive and one to move a model down, each a settings proposal of this reader's. An agent is
 * left out for good once anyone decided the same suggestion about it (refused, or applied and perhaps undone), and
 * for four weeks after this reader's card last offered it. While a suggestion from those weeks' cards is still
 * undecided, no other agent is offered the same: suggestions left alone do not pile up as proposals waiting.
 *
 * Both count every run of the agent, private conversations included: the rows say an agent and nothing more.
 */
async function suggestions(
  db: Database,
  w: Window,
  team: TeamAgent[],
  lately: Set<string>,
): Promise<Extract<TeamWeekMoreRow, { proposalId: string }>[]> {
  const since = new Date(w.end.getTime() - IDLE_MS).toISOString();
  const end = w.end.toISOString();
  const decided = new Set(
    rowsOf<{ agent_id: string; rationale: string }>(
      await db.execute(sql`select agent_id, rationale from context_proposals
        where org_id = ${w.orgId} and proposed_by_agent_id = ${w.rightHandId} and target = 'agent_settings'
          and status in ('accepted', 'rejected') and rationale in (${IDLE_REASON}, ${LIGHT_WORK_REASON})`),
    ).map((p) => `${p.rationale}:${p.agent_id}`),
  );
  const open = (kind: "retire" | "model", reason: string) =>
    team.filter((a) => !lately.has(`${kind}:${a.id}`) && !decided.has(`${reason}:${a.id}`));
  const waits = (kind: "retire" | "model", reason: string) =>
    team.some((a) => lately.has(`${kind}:${a.id}`) && !decided.has(`${reason}:${a.id}`));
  const out: Extract<TeamWeekMoreRow, { proposalId: string }>[] = [];

  const large = (waits("model", LIGHT_WORK_REASON) ? [] : open("model", LIGHT_WORK_REASON)).flatMap((a) => {
    const step = smallerModel(a);
    return step ? [{ id: a.id, ...step }] : [];
  });
  const light = large.length
    ? rowsOf<{ agent_id: string }>(
        await db.execute(sql`select r.agent_id from agent_runs r
          left join (select run_id, sum(output_tokens) as tokens from usage_records
            where org_id = ${w.orgId} and agent_id = any(${`{${large.map((a) => a.id).join(",")}}`}::uuid[])
              and created_at >= ${since}::timestamptz group by run_id) u on u.run_id = r.id
          where r.org_id = ${w.orgId} and r.agent_id = any(${`{${large.map((a) => a.id).join(",")}}`}::uuid[])
            and r.status = 'done' and r.created_at >= ${since}::timestamptz and r.created_at < ${end}::timestamptz
          group by r.agent_id
          having count(*) >= ${LIGHT_RUNS} and 10 * count(*) filter (where r.turns <= ${LIGHT_TURNS}
            and u.tokens <= ${LIGHT_TOKENS}) >= ${LIGHT_IN_TEN} * count(*)`),
      ).map((r) => r.agent_id)
    : [];
  for (const a of large.filter((x) => light.includes(x.id))) {
    const id = await settingsProposal(db, w, a.id, { field: "model", to: a.to }, LIGHT_WORK_REASON);
    if (!id) continue;
    out.push({ id: `model:${a.id}`, kind: "model", agentId: a.id, proposalId: id, from: a.from, to: a.to });
    break;
  }

  const old = (waits("retire", IDLE_REASON) ? [] : open("retire", IDLE_REASON)).filter(
    (a) => new Date(a.created_at).getTime() < w.end.getTime() - IDLE_MS,
  );
  const idle = old.length
    ? rowsOf<{ id: string }>(
        await db.execute(sql`select a.id from agents a
          where a.org_id = ${w.orgId} and a.id = any(${`{${old.map((a) => a.id).join(",")}}`}::uuid[])
            and ${idleAgentSql(new Date(w.end.getTime() - IDLE_MS))}
          order by a.created_at`),
      )
    : [];
  for (const a of idle) {
    // One just offered a smaller model is working: it is not the one to archive.
    if (out.some((r) => r.agentId === a.id)) continue;
    const id = await settingsProposal(db, w, a.id, { field: "archive", to: true }, IDLE_REASON);
    if (!id) continue;
    out.push({ id: `retire:${a.id}`, kind: "retire", agentId: a.id, proposalId: id });
    break;
  }
  return out;
}

/**
 * A task (`alias`) an agent moved to done between two moments: its last change of status in them is an agent's, to
 * done. Not when it was last touched: a person closing it, or a comment on a closed task, is no agent's work.
 */
const closedByAgentSql = (alias: string, start: string, end: string) => {
  const t = sql.raw(alias);
  return sql`(${t}.status = 'done' and ${t}.updated_at >= ${start}::timestamptz
    and (select e.author_type = 'agent' and e.data->>'to' = 'done' from issue_activity e
      where e.issue_id = ${t}.id and e.event = 'status_changed'
        and e.created_at >= ${start}::timestamptz and e.created_at < ${end}::timestamptz
      order by e.created_at desc limit 1))`;
};

const oldest = (list: { createdAt: string }[]) => list.map((a) => a.createdAt).sort()[0] ?? "";

/** A timestamp as `toISOString` writes it, to compare with the moments kept as text in a card. */
const isoSql = (at: SQL) => sql`to_char(${at} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** Approvals waiting for one person, a row per agent, the longest waiting first. */
function approvalRows(waiting: { id: string; agentId: string; createdAt: string }[]): TeamWeekRow[] {
  const byAgent = new Map<string, typeof waiting>();
  for (const a of waiting) byAgent.set(a.agentId, [...(byAgent.get(a.agentId) ?? []), a]);
  return [...byAgent]
    .sort((a, b) => oldest(a[1]).localeCompare(oldest(b[1])))
    .slice(0, 2)
    .map(([agentId, list]) => ({
      id: `approvals:${agentId}`,
      kind: "approvals" as const,
      agentId,
      approvalIds: list.slice(0, 10).map((a) => a.id),
      since: oldest(list),
    }));
}

const STUCK_COMPUTER = /^run\.(computer_|cli_|account_missing|windows_sandbox|brain_unavailable)/;
const STUCK_KEY = /^run\.(provider_(account|no_credit|invalid_key|no_access)|missing_credential|credential_|no_ai)/;
const STUCK_AI = /^run\.(provider_|empty_reply|model_refused|brain_interrupted)/;

/** The waits that are a computer away, full or without a session. Any other wait is not the computer's doing. */
const WAIT_COMPUTER = new Set(["machine_offline", "machine_dropped", "no_session", "no_computer", "busy"]);

/**
 * Why a run stopped: what it waits on (`wait`, its `waitingForBrain` code, and `source`, whose limit paused a long
 * work), else its stored error. Null for a run a person stopped or a restart cut, where nothing is wrong with the
 * agent. A wait with no cause of its own here (a paused computer, a plan its owner did not share) is `other`: the
 * conversation says which.
 */
export function stuckCause(run: {
  error?: string | null;
  wait?: string | null;
  source?: string | null;
}): StuckCause | null {
  const { wait } = run;
  if (wait) {
    if (wait === "budget" || (wait === "usage_pause" && run.source === "budget")) return "budget";
    if (wait === "plan_limit" || wait === "usage_pause") return "plan";
    if (wait === "not_logged_in") return "key";
    return WAIT_COMPUTER.has(wait) ? "computer" : "other";
  }
  const code = runErrorDetail(run.error)?.errorCode ?? "";
  if (code === "run.canceled" || code === "run.interrupted") return null;
  if (code === "run.budget_exceeded") return "budget";
  if (STUCK_COMPUTER.test(code)) return "computer";
  if (STUCK_KEY.test(code)) return "key";
  return STUCK_AI.test(code) ? "ai" : "other";
}

const isMoreRow = (r: TeamWeekRow | TeamWeekMoreRow): r is TeamWeekMoreRow =>
  r.kind === "waiting" || r.kind === "stuck";

/**
 * The day's card for this person and whether it rings, or null when nothing on it is both theirs and new (or there is
 * no team yet). Theirs: what waits on them, runs they asked for or of an agent they own, tasks they made, their
 * agents' how-tos. New: not on the card before (`seen`), or ended inside this card's window. Work that finished posts
 * it only when the person did not ask for it themselves (the answer reached them where they asked), and it rings only
 * for a run newly held: what waits on them rang when it was asked, and a failure when it happened. Approvals are left
 * to the summary of approvals (`digest`) for who gets one: they are on that card, never on both. The whole workspace's
 * work never posts it, an administrator's included, and every run is read through a conversation the person reads. A task whose end the right hand was already told for them
 * (`taskEndToldSql`) is not counted: that end is said in their DM, once.
 *
 * A run is the person's when they wrote the message that started it or the first message of its thread, which is one
 * statement for all of them. Work an agent passed to another outside that thread is left to its owner's card.
 */
export async function buildTeamDay(
  db: Database,
  w: Window & { seen?: string[]; digest?: boolean },
): Promise<{ card: BuiltCard; push: boolean } | null> {
  const [team] = rowsOf(
    await db.execute(sql`select 1 from agents where org_id = ${w.orgId} and builtin is null
      and archived_at is null and deleted_at is null limit 1`),
  );
  if (!team) return null;
  const start = w.start.toISOString();
  const end = w.end.toISOString();
  const user = sql`${w.userId}::text`;
  const seen = new Set(w.seen ?? []);
  // A run counts on the day it ended, not the day it began: one still working at the slot is on the next card. Read
  // through the index on when runs began, so only one that began at most `DAY_REACH_MS` before the window: a run
  // that worked for longer is on no card.
  const ended = sql`coalesce(r.finished_at, r.updated_at)`;
  const theirAsk = sql`exists (select 1 from messages am where am.org_id = r.org_id
    and am.id in (r.trigger_message_id, r.thread_root_id) and am.author_user_id = ${w.userId})`;

  const runs = rowsOf<{
    id: string;
    agent_id: string;
    channel_id: string;
    status: "done" | "failed" | "waiting_input";
    error: string | null;
    wait: string | null;
    source: string | null;
    kind: string;
    dm_key: string | null;
    issue_number: number | null;
    asked: boolean;
  }>(
    await db.execute(sql`select r.id, r.agent_id, r.channel_id, r.status, r.error,
        r.transcript->'waitingForBrain'->>'code' as wait, r.transcript->'waitingForBrain'->>'source' as source,
        c.kind, c.dm_key, (select i.number from issues i where i.conversation_channel_id = c.id) as issue_number,
        ${theirAsk} as asked
      from agent_runs r join channels c on c.id = r.channel_id
      where r.org_id = ${w.orgId}
        and r.agent_id in (select id from agents where org_id = ${w.orgId} and builtin is null)
        and ((r.status in ('done', 'failed')
            and r.created_at >= ${new Date(w.start.getTime() - DAY_REACH_MS).toISOString()}::timestamptz
            and ${ended} >= ${start}::timestamptz and ${ended} < ${end}::timestamptz)
          or (r.status = 'waiting_input'
            and coalesce(r.transcript->'waitingForBrain'->>'code', 'work_queue') <> 'work_queue'
            and coalesce(case when jsonb_typeof(r.transcript->'waitingForBrain'->'since') = 'number'
                then (r.transcript->'waitingForBrain'->>'since')::numeric end,
              extract(epoch from r.updated_at) * 1000) <= ${w.end.getTime() - HELD_MS}))
        and ((c.kind = 'channel' and c.visibility = 'public') or ${channelReaderSql(sql`c.id`, user)})
        and (exists (select 1 from agents oa where oa.id = r.agent_id and oa.owner_user_id = ${w.userId})
          or ${theirAsk})
      order by ${ended} desc limit ${DAY_RUNS}`),
  );
  let finished = 0;
  // Finished work the person has not read yet: their agent's, for someone or something else. What they asked for
  // themselves answered them where they asked.
  let unread = 0;
  const doneIn = new Map<string, { agentId: string; channelId: string; count: number }>();
  const stuckIn = new Map<
    string,
    { run: (typeof runs)[number]; failed: number; cause: StuckCause; held: string[]; heldCause: StuckCause }
  >();
  // The first to end first: a good run after a failed one in the same conversation means the agent is working there
  // again.
  for (const r of runs.reverse()) {
    // A DM that is not the person's own with this agent has no page of its own to open: it stays off their card.
    if (r.kind === "dm" && r.dm_key !== personAgentDmKey(w.userId, r.agent_id)) continue;
    const key = `${r.agent_id}:${r.channel_id}`;
    const at = stuckIn.get(key) ?? { run: r, failed: 0, cause: "other", held: [], heldCause: "other" };
    if (r.status === "done") {
      finished++;
      if (!r.asked) unread++;
      at.failed = 0;
      if (r.kind === "channel")
        doneIn.set(key, {
          agentId: r.agent_id,
          channelId: r.channel_id,
          count: (doneIn.get(key)?.count ?? 0) + 1,
        });
    } else {
      const cause = stuckCause(r.status === "failed" ? { error: r.error } : { wait: r.wait, source: r.source });
      if (!cause) continue;
      if (r.status === "failed") {
        at.failed++;
        at.cause = cause;
      } else {
        at.held.push(r.id);
        at.heldCause = cause;
      }
    }
    stuckIn.set(key, at);
  }
  const stuck = [...stuckIn.values()].filter((s) => s.failed > 0 || s.held.length > 0);
  const heldKeys = stuck.flatMap((s) => s.held.map((id) => `run:${id}`));
  const stuckRows: TeamWeekMoreRow[] = stuck
    .sort((a, b) => b.held.length - a.held.length || b.failed - a.failed)
    .slice(0, STUCK_SHOWN)
    .map((s) => ({
      id: `stuck:${s.run.agent_id}:${s.run.channel_id}`,
      kind: "stuck" as const,
      agentId: s.run.agent_id,
      channelId: s.run.channel_id,
      dm: s.run.kind === "dm",
      ...(s.run.issue_number != null ? { issueNumber: Number(s.run.issue_number) } : {}),
      code: s.held.length > 0 ? s.heldCause : s.cause,
      count: s.failed + s.held.length,
      held: s.held.length > 0,
    }));

  const closed = rowsOf<{ agent_id: string; n: number | string }>(
    await db.execute(sql`select assignee_id as agent_id, count(*) as n from issues
      where org_id = ${w.orgId} and assignee_type = 'agent'
        and created_by_type = 'person' and created_by_id = ${w.userId}
        and ${taskSeenSql("issues", user)}
        and ${closedByAgentSql("issues", start, end)}
        and not ${taskEndToldSql(
          sql`issues.id`,
          sql`(select id from channels where org_id = ${w.orgId}
            and dm_key = ${personAgentDmKey(w.userId, w.rightHandId)})`,
          start,
        )}
      group by assignee_id order by n desc limit 1`),
  );
  const worked: TeamWeekHighlight[] = [
    ...[...doneIn.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 2)
      .map((d) => ({ kind: "runs" as const, ...d })),
    ...closed.map((c) => ({ kind: "tasks" as const, agentId: c.agent_id, count: Number(c.n) })),
  ];

  // What waits on them is their inbox's own list. Approvals keep their rows, for the agents that list says ask.
  const waiting = await listWaiting({ db }, w.userId, w.orgId);
  const asked = waiting.items.filter((i) => i.kind !== "approval");
  const asking = new Set(
    waiting.items.flatMap((i) => (i.kind === "approval" && i.asker?.type === "agent" ? [i.asker.id] : [])),
  );
  const approvals = asking.size
    ? (await listApprovals(db, w.userId, w.orgId, { status: "pending", limit: 200 })).filter(
        (a) => a.canDecide && asking.has(a.agentId),
      )
    : [];
  const first = asked[0];
  const waitingRow: TeamWeekMoreRow[] = first
    ? [
        {
          id: "waiting",
          kind: "waiting",
          count: asked.length,
          ids: asked.map((i) => i.id),
          agentId: asked.find((i) => i.asker?.type === "agent")?.asker?.id ?? null,
          since: first.since,
        },
      ]
    : [];

  const stalled = await stalledSteps(db, w, true);
  const rest: TeamWeekRow[] = [...(await provenHowTos(db, w)), ...(stalled ? [stalled] : [])];

  // Enough approvals for the summary of approvals, by its own count: that card lists them, and decides them.
  const digested =
    w.digest === true &&
    approvals.length >= DIGEST_FROM &&
    (await digestWaitingOn(db, w.orgId, w.userId, new Date())).length >= DIGEST_FROM;
  const newWaiting = waiting.items.some((i) => !seen.has(i.id) && !(digested && i.kind === "approval"));
  const newHeld = heldKeys.some((k) => !seen.has(k));
  const failed = stuck.some((s) => s.failed > 0);
  if (unread === 0 && closed.length === 0 && !newWaiting && !newHeld && !failed && rest.every((r) => seen.has(r.id)))
    return null;
  const shown = [...approvalRows(digested ? [] : approvals), ...waitingRow, ...stuckRows, ...rest].slice(
    0,
    MAX_DAY_ROWS,
  );
  return {
    card: {
      kind: TEAM_WEEK_CARD,
      forUserId: w.userId,
      from: localDate(w.start, w.timezone),
      to: localDate(new Date(w.end.getTime() - 1), w.timezone),
      timezone: w.timezone,
      stats: {
        done: finished,
        stuck: stuck.reduce((n, s) => n + s.failed + s.held.length, 0),
        waiting: waiting.count,
        spentNanoUsd: 0,
        budgetNanoUsd: 0,
      },
      worked,
      rows: shown.filter((r): r is TeamWeekRow => !isMoreRow(r)),
      moreRows: shown.filter(isMoreRow),
      seen: [...waiting.items.map((i) => i.id), ...heldKeys, ...rest.map((r) => r.id)],
      proposalIds: [],
    },
    // It rings for a run held that was not said before: nothing told its person yet. What waits on them rang when it
    // was asked and is reminded of by the team watch, a run that failed told its person when it did (their inbox),
    // and what only finished is read when they come: none of those rings again.
    push: newHeld,
  };
}

/**
 * A fresh settings proposal by Lodi for this person; null when the line can't be made or this person can't decide it
 * (the card only offers what its reader applies). The same fix still open on an earlier week's card goes stale there:
 * a decision records its receipt (Undo) on the oldest card that lists the proposal, and last week's amount may be
 * outdated. Proposals Lodi made in a conversation stay as they are.
 */
async function settingsProposal(
  db: Database,
  w: Window,
  agentId: string,
  line: { field: "budget" | "channel_add" | "model" | "archive"; to: unknown; channelId?: string },
  rationale: string,
) {
  const { field } = line;
  await db.execute(sql`update context_proposals p set status = 'stale', decided_at = now()
    where p.org_id = ${w.orgId} and p.agent_id = ${agentId} and p.proposed_by_agent_id = ${w.rightHandId}
      and p.requested_by_user_id = ${w.userId} and p.status = 'pending' and p.target = 'agent_settings'
      and p.settings @> ${JSON.stringify([{ field }])}::jsonb
      and exists (select 1 from messages m where m.org_id = p.org_id and m.author_agent_id = p.proposed_by_agent_id
        and m.meta->'actionCard'->>'kind' = ${TEAM_WEEK_CARD}
        and m.meta->'actionCard'->'proposalIds' @> jsonb_build_array(p.id::text))`);
  const { proposals } = await proposeSettings(
    { db },
    {
      orgId: w.orgId,
      agentId: w.rightHandId,
      targets: [{ agentId, lines: [line] }],
      rationale,
      requesterId: w.userId,
    },
  );
  const [p] = proposals;
  if (p && !p.canDecide) {
    // Not on the card: a row nobody sees would only pile up, one a day on a "Resumo do dia".
    await db.delete(contextProposals).where(eq(contextProposals.id, p.id));
    return null;
  }
  return p?.id ?? null;
}

/** The same request this person typed to one agent on `REPEAT_DAYS` days or more, with no routine doing it. */
async function repeatedRequest(db: Database, w: Window, teamIds: Set<string>): Promise<TeamWeekRow | null> {
  const sent = rowsOf<{
    body: string;
    created_at: string | Date;
    channel_id: string;
    kind: string;
    dm_key: string | null;
    mentioned: string[] | string | null;
  }>(
    await db.execute(sql`select m.body, m.created_at, m.channel_id, c.kind, c.dm_key, m.mentioned_agent_ids as mentioned
      from messages m join channels c on c.id = m.channel_id
      where m.org_id = ${w.orgId} and m.author_user_id = ${w.userId} and m.deleted_at is null and m.thread_id is null
        and m.created_at >= ${w.start.toISOString()}::timestamptz and m.created_at < ${w.end.toISOString()}::timestamptz
        and c.archived_at is null and (c.kind = 'dm' or (c.kind = 'channel' and cardinality(m.mentioned_agent_ids) = 1))
      order by m.created_at desc limit 500`),
  );
  const groups = new Map<
    string,
    { agentId: string; channelId: string; dm: boolean; text: string; days: Set<string>; hours: number[] }
  >();
  for (const m of sent) {
    const mentioned = typeof m.mentioned === "string" ? m.mentioned.replace(/[{}]/g, "").split(",") : m.mentioned;
    const agentId =
      m.kind === "dm"
        ? (m.dm_key
            ?.split("|")
            .find((p) => p.startsWith("a:"))
            ?.slice(2) ?? null)
        : (mentioned?.[0] ?? null);
    if (!agentId || !teamIds.has(agentId) || (m.kind === "dm" && !m.dm_key?.includes(`u:${w.userId}`))) continue;
    const key = requestKey(m.body);
    if (!key) continue;
    const at = new Date(m.created_at);
    const id = `${agentId}|${m.channel_id}|${key}`;
    const g = groups.get(id) ?? {
      agentId,
      channelId: m.channel_id,
      dm: m.kind === "dm",
      // Newest first: the latest wording.
      text: m.body.replace(/\s+/g, " ").trim().slice(0, 300),
      days: new Set<string>(),
      hours: [],
    };
    g.days.add(localDate(at, w.timezone));
    g.hours.push(localHour(at, w.timezone));
    groups.set(id, g);
  }
  const best = [...groups.values()]
    .filter((g) => g.days.size >= REPEAT_DAYS)
    .sort((a, b) => b.days.size - a.days.size)[0];
  if (!best) return null;
  const made = rowsOf<{ prompt: string }>(
    await db.execute(sql`select prompt from routines where org_id = ${w.orgId} and agent_id = ${best.agentId}`),
  );
  const key = requestKey(best.text);
  if (made.some((r) => requestKey(r.prompt) === key)) return null;
  return {
    id: `routine:${best.agentId}:${best.channelId}`,
    kind: "routine",
    agentId: best.agentId,
    channelId: best.channelId,
    dm: best.dm,
    text: best.text,
    count: best.days.size,
    hour: mode(best.hours),
  };
}

const mode = (list: number[]) => {
  const n = new Map<number, number>();
  for (const x of list) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 9;
};

/**
 * A task whose steps wait for hours while another step is in progress or in review (a reviewer rejecting step 1
 * while steps 2 to 4 wait on it): the one stalled the longest. `own`: only a task this person made.
 */
async function stalledSteps(db: Database, w: Window, own = false): Promise<TeamWeekRow | null> {
  const [s] = rowsOf<{
    id: string;
    number: number;
    title: string;
    assignee_type: string | null;
    assignee_id: string | null;
    steps: number[] | string;
    on_number: number | null;
    on_agent: string | null;
    moved: string | Date;
  }>(
    await db.execute(sql`select p.id, p.number, p.title, p.assignee_type, p.assignee_id,
        array_agg(s.number order by s.number) filter (where s.status = 'todo') as steps,
        (array_agg(s.number order by s.number) filter (where s.status in ('in_progress', 'in_review') or s.blocked is not null))[1] as on_number,
        (array_agg(s.assignee_id order by s.number) filter (where s.assignee_type = 'agent' and (s.status in ('in_progress', 'in_review') or s.blocked is not null)))[1] as on_agent,
        max(s.updated_at) as moved
      from issues p join issues s on s.parent_issue_id = p.id and s.org_id = p.org_id
        and ${taskSeenSql("s", sql`${w.userId}::text`)}
      where p.org_id = ${w.orgId} and p.status not in ('done', 'canceled')
        and ${taskSeenSql("p", sql`${w.userId}::text`)}
        ${own ? sql`and p.created_by_type = 'person' and p.created_by_id = ${w.userId}` : sql``}
      group by p.id
      having count(*) filter (where s.status = 'todo') >= 2
        and count(*) filter (where s.status in ('in_progress', 'in_review') or s.blocked is not null) >= 1
        and max(s.updated_at) < ${new Date(w.end.getTime() - STALL_MS).toISOString()}::timestamptz
      order by max(s.updated_at) limit 1`),
  );
  if (!s || s.on_number == null) return null;
  const steps = typeof s.steps === "string" ? s.steps.replace(/[{}]/g, "").split(",").map(Number) : s.steps;
  return {
    id: `stalled:${s.id}`,
    kind: "stalled",
    issueId: s.id,
    number: s.number,
    title: s.title.slice(0, 120),
    steps,
    onNumber: s.on_number,
    hours: Math.floor((w.end.getTime() - new Date(s.moved).getTime()) / HOUR_MS),
    agentId: s.assignee_type === "agent" ? s.assignee_id : s.on_agent,
  };
}

/** How many proven how-tos one card offers to make skills, at most. */
const HOWTOS_SHOWN = 3;

/**
 * The person's own agents' how-tos reused at least `LEARN_DEFAULTS.skillAfter` times that are still untrusted, so the
 * day's pass can't make them skills (ADR 0167), the most reused first. Only what was learned where this person reads,
 * as their agent's memory page lists it (`listAgentMemoryRows`): one worked out in someone else's DM or in a private
 * channel they are not in stays there, its title included.
 */
async function provenHowTos(db: Database, w: Window): Promise<TeamWeekRow[]> {
  const visible = await userVisibleChannels(db, w.orgId, w.userId);
  const rows = await db
    .select({
      id: contextItems.id,
      agentId: contextItems.agentId,
      title: contextItems.title,
      content: contextItems.content,
      uses: contextItems.recurrence,
    })
    .from(contextItems)
    .innerJoin(agents, eq(agents.id, contextItems.agentId))
    .where(
      and(
        eq(contextItems.orgId, w.orgId),
        eq(agents.ownerUserId, w.userId),
        isNull(agents.archivedAt),
        eq(contextItems.status, "active"),
        isNull(contextItems.supersededBy),
        howToSql(),
        // Someone in no conversation yet reads only what is tied to none.
        visible.length
          ? arrayContained(contextItems.channelIds, visible)
          : sql`cardinality(${contextItems.channelIds}) = 0`,
        eq(contextItems.trust, "low"),
        eq(contextItems.disputed, false),
        gte(contextItems.recurrence, LEARN_DEFAULTS.skillAfter),
      ),
    )
    .orderBy(desc(contextItems.recurrence))
    .limit(HOWTOS_SHOWN);
  return rows.map((r) => ({
    id: `howto:${r.id}`,
    kind: "howto" as const,
    agentId: r.agentId ?? "",
    itemId: r.id,
    title: cutText(r.title || r.content, 120),
    uses: r.uses,
  }));
}

// --- When it goes out ------------------------------------------------------------------------------------------

/** How many jobs one insert carries: well under the statement's limit of parameters. */
const ENQUEUE_BATCH = 1000;

interface NearTeamWeek {
  org_id: string;
  user_id: string;
  team_week: unknown;
  tz: string;
  day_tz: string;
  admin: boolean;
}

/**
 * The members a card may be due for at `now`, in open workspaces with a team and Lodi: who is within the hours after
 * their slot and has no job for that card yet (the dedupe keys of `teamWeekJobKey`, rebuilt here, each looked up by the
 * unique index). So a member comes back on the tick after their slot and not again that day, and a tick reads only
 * who it may queue. Who administers is asked only for those, on the day a week's card may be due.
 */
export async function nearTeamWeeks(db: Database, now: Date): Promise<NearTeamWeek[]> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const window = POST_WINDOW_MS / HOUR_MS;
  const tz = sql`z.tz`;
  const dayTz = sql`z.day_tz`;
  const hoursSince = (hour: unknown, zone: unknown) =>
    sql`((extract(hour from ${at} at time zone ${zone})::int - ${hour} + 24) % 24)`;
  // The slot on that zone's clock: its date is the one in the day's key, its week's Monday the one in the week's.
  const slotClock = (hour: unknown, zone: unknown) =>
    sql`((${at} at time zone ${zone}) - make_interval(hours => ${hoursSince(hour, zone)}))`;
  const queued = (key: unknown) =>
    sql`exists (select 1 from outbox o
      where o.dedupe_key = ${TEAM_WEEK_JOB}::text || ':' || m.org_id::text || ':' || m.user_id::text || ':' || ${key})`;
  const dayKey = sql`'day:' || to_char(${slotClock(lodiPrefsSql.dayHour, dayTz)}, 'YYYY-MM-DD')`;
  const weekKeySql = sql`to_char(date_trunc('week', ${slotClock(lodiPrefsSql.weekHour, tz)}), 'YYYY-MM-DD')`;
  const weekday = (moment: unknown) => sql`extract(dow from ${moment} at time zone ${tz})::int`;
  const weekly = sql`(not ${lodiPrefsSql.weekOff}
    and ${lodiPrefsSql.day} in (${weekday(at)}, ${weekday(sql`(${at} - make_interval(hours => ${window}))`)}))`;
  return rowsOf<NearTeamWeek>(
    await db.execute(sql`with ${knownZonesSql}
      select org_id, user_id, team_week, tz, day_tz, admin from (
        select near.*, case when near.weekly
          then ${maySql(sql`near.org_id`, sql`near.user_id`, "administrator")} else false end as admin
        from (
          select m.org_id, m.user_id, m.team_week, ${tz} as tz, ${dayTz} as day_tz, ${weekly} as weekly,
            not ${lodiPrefsSql.dayOff} and ${hoursSince(lodiPrefsSql.dayHour, dayTz)} <= ${window}
              and not ${queued(dayKey)} as day_near,
            ${weekly} and ${hoursSince(lodiPrefsSql.weekHour, tz)} <= ${window}
              and not ${queued(weekKeySql)} as week_near
          from organization_members m
          join organizations on organizations.id = m.org_id and ${openOrg}
          left join organization_settings s on s.org_id = m.org_id
          cross join lateral (select ${zoneSql(sql`s.timezone`, sql`'UTC'`)} as tz,
            ${zoneSql(sql`m.timezone`, zoneSql(sql`s.timezone`, sql`'UTC'`))} as day_tz) z
          where exists (select 1 from agents a where a.org_id = m.org_id and a.builtin is null
              and a.archived_at is null and a.deleted_at is null)
            and exists (select 1 from agents a where a.org_id = m.org_id and a.builtin = 'right_hand')
        ) near where day_near or week_near
      ) due where day_near or (admin and week_near)`),
  );
}

/**
 * Queues the cards whose slot just passed: the day's for everyone who has it on, the week's for administrators
 * (dedupe: one per person and day, one per person and week). Returns how many it queued.
 *
 * Every member of every workspace has the day's card on unless they stopped it, so the statement picks who may be due
 * (`nearTeamWeeks`), the exact slot is worked out here for those alone, and they are queued a batch per statement.
 */
export async function enqueueTeamWeeks(db: Database, now = new Date()) {
  const jobs = (await nearTeamWeeks(db, now)).flatMap((d) =>
    dueTeamWeeks(lodiPrefsOf(d.team_week), { admin: d.admin, timezone: d.tz, dayTimezone: d.day_tz }, now).map(
      ({ period, slot, timezone }) => ({
        orgId: d.org_id,
        kind: period === "day" ? TEAM_DAY_JOB : TEAM_WEEK_JOB,
        payload: { userId: d.user_id, slot: slot.toISOString(), period },
        dedupeKey: teamWeekJobKey(d.org_id, d.user_id, period, slot, timezone),
        maxAttempts: 4,
      }),
    ),
  );
  let queued = 0;
  for (let i = 0; i < jobs.length; i += ENQUEUE_BATCH) {
    const rows = await db
      .insert(outbox)
      .values(jobs.slice(i, i + ENQUEUE_BATCH))
      .onConflictDoNothing()
      .returning({ id: outbox.id });
    queued += rows.length;
  }
  return queued;
}

/**
 * The job: builds this person's card and posts it in their DM with Lodi. Returns the message id, or null (none in a
 * workspace closed to changes since it was queued).
 */
export async function postTeamWeek(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  payload: { userId?: unknown; slot?: unknown; period?: unknown },
) {
  const { db } = deps;
  const userId = typeof payload.userId === "string" ? payload.userId : null;
  const slot = typeof payload.slot === "string" ? new Date(payload.slot) : null;
  if (!userId || !slot || Number.isNaN(slot.getTime())) return null;
  // Someone who left gets none. Any other failure is the job's to retry: ending here would spend the day's key.
  const member = await readLodiPrefs(db, orgId, userId).catch((error) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!member) return null;
  const { prefs, admin } = member;
  // A job queued before cards named their period carries none: the one card that person then got.
  const period: TeamWeekPeriod =
    payload.period === "day" || payload.period === "week" ? payload.period : admin && !prefs.weekOff ? "week" : "day";
  if (period === "week" ? !admin || prefs.weekOff : prefs.dayOff) return null;
  const lodi = await lodiFor(db, orgId, userId);
  if (!lodi) return null;
  const timezone = period === "day" ? member.dayTimezone : member.timezone;
  const span = new Date(slot.getTime() - teamWeekSpan(period));
  // In their DM with Lodi alone, where every card of theirs is: not every message Lodi wrote in the workspace.
  const mine = sql`channel_id = (select id from channels where org_id = ${orgId}
      and dm_key = ${personAgentDmKey(userId, lodi.id)})
    and meta->'actionCard'->>'kind' = ${TEAM_WEEK_CARD} and meta->'actionCard'->>'forUserId' = ${userId}
    and author_agent_id = ${lodi.id} and coalesce(meta->'actionCard'->>'period', 'week') = ${period}`;
  // By its slot. A card from before cards kept one is found by its first day, which was the slot's then.
  const posted = async (tx: Executor) =>
    rowsOf<{ id: string }>(
      await tx.execute(sql`select id from messages where org_id = ${orgId} and ${mine}
        and coalesce(meta->'actionCard'->>'slot' = ${slot.toISOString()},
          meta->'actionCard'->>'from' = ${localDate(span, timezone)}) limit 1`),
    ).length > 0;
  // A retry after the card went out builds nothing: building again would stale the proposals that card shows.
  if (await posted(db)) return null;
  const w = { orgId, userId, rightHandId: lodi.id, start: span, end: slot, timezone, admin, muted: prefs.muted };
  let built: { card: BuiltCard; push: boolean } | null;
  if (period === "day") {
    // The day's card goes on from the one before it, so a day that posted none is not lost, and repeats nothing of it.
    const [last] = rowsOf<{ card: { slot?: unknown; seen?: unknown } | null; created_at: string | Date }>(
      await db.execute(sql`select meta->'actionCard' as card, created_at from messages
        where org_id = ${orgId} and ${mine} order by created_at desc limit 1`),
    );
    const before = last ? new Date(typeof last.card?.slot === "string" ? last.card.slot : last.created_at) : null;
    const start =
      before && before.getTime() < slot.getTime()
        ? new Date(Math.max(before.getTime(), slot.getTime() - DAY_REACH_MS))
        : span;
    built = await buildTeamDay(db, { ...w, start, seen: stringsOf(last?.card?.seen), digest: !prefs.digestOff });
  } else {
    const week = await buildTeamWeek(db, w);
    built = week && { card: week, push: true };
  }
  if (!built) return null;
  const card: TeamWeekCard = { ...built.card, period, slot: slot.toISOString(), done: {}, dismissedAt: null };
  const [settings] = await db
    .select({ mode: organizationSettings.mode })
    .from(organizationSettings)
    .where(eq(organizationSettings.orgId, orgId));
  // A personal workspace's week is the person's own with their agents (ADR 0159), not a team's.
  const week = settings?.mode === "personal" ? "teamWeekReadyPersonal" : "teamWeekReady";
  return postFromLodi(deps, orgId, userId, {
    bodyCode: TEAM_WEEK_CARD,
    bodyParams: { from: card.from, to: card.to, ...(period === "day" ? { period } : {}) },
    // Only this person reads it: the push and the conversation list say it in their language.
    body: (locale) => pushStrings(locale)[period === "day" ? "teamDayReady" : week],
    meta: { actionCard: card },
    push: built.push,
    posted,
    lodi,
  });
}

// --- What a person does with it --------------------------------------------------------------------------------

/**
 * A row applied from the card as `actorId` (only the person it is for: it lives in their DM), or "Agora não"
 * (`dismiss`). Settings and approvals rows go through their own paths; here the routine is made, Lodi is asked for an
 * agent, or the task's agent is told to go on (`text`: the person's own words, in their language). Returns the card.
 *
 * `skip` puts one suggestion away and leaves the card: archiving an agent or a smaller model is refused as the person
 * (who must be able to decide it), which ends it for every administrator, and unanswered questions in a channel are
 * muted for this person alone.
 */
export async function actOnTeamWeek(
  deps: RoutineDeps,
  actorId: string,
  orgId: string,
  messageId: string,
  input: { dismiss: true } | { rowId: string; text?: string; skip?: true },
): Promise<TeamWeekCard> {
  const { db } = deps;
  const message = await getMessage(db, orgId, messageId);
  const card = message ? teamWeekCardOf(message.meta) : null;
  if (!message || !card) throw new NotFoundError("Card not found");
  if (card.forUserId !== actorId) throw new ForbiddenError("This card is someone else's");
  const next: TeamWeekCard = { ...card, done: { ...(card.done ?? {}) } };
  if ("dismiss" in input) next.dismissedAt = new Date().toISOString();
  else {
    const row = [...card.rows, ...(card.moreRows ?? [])].find((r) => r.id === input.rowId);
    if (!row) throw new NotFoundError("Row not found");
    // Put away, it is not applied either: a build from before still draws its button.
    if (next.done[row.id] || card.skipped?.[row.id]) throw new ConflictError("Already done", "team_week.done");
    const text = input.text?.trim().slice(0, 2000) ?? "";
    const stamp = { byUserId: actorId, at: new Date().toISOString() };
    const done: TeamWeekCard["done"][string] = { ...stamp };
    if (input.skip) {
      if (row.kind === "retire" || row.kind === "model") {
        await decideProposal(db, actorId, orgId, row.proposalId, "reject", { pubsub: deps.pubsub });
        // The copies on other administrators' cards: nobody is asked again what one of them refused.
        await db.execute(sql`update context_proposals set status = 'stale', decided_at = now()
          where org_id = ${orgId} and agent_id = ${row.agentId} and target = 'agent_settings' and status = 'pending'
            and proposed_by_agent_id = ${message.authorAgentId}
            and rationale = ${row.kind === "retire" ? IDLE_REASON : LIGHT_WORK_REASON}`);
      } else if (row.kind === "unanswered") await setLodiPrefs(db, orgId, actorId, { muted: [row.id] });
      else throw new ValidationError("This row is not put away alone", "team_week.no_skip");
      next.skipped = { ...card.skipped, [row.id]: stamp };
    } else if (row.kind === "routine") {
      const routine = await createRoutine(deps, actorId, orgId, {
        agentId: row.agentId,
        prompt: row.text,
        name: row.text.slice(0, 60),
        target: row.dm ? { type: "dm" } : { type: "channel", channelId: row.channelId },
        trigger: {
          type: "schedule",
          rule: { freq: "daily", times: [`${String(row.hour).padStart(2, "0")}:00`], timezone: card.timezone },
        },
        report: "always",
      });
      done.routineId = routine.id;
    } else if (row.kind === "unanswered") {
      if (!text) throw new ValidationError("Say what to ask");
      await postPersonMessage({ db, pubsub: deps.pubsub }, actorId, orgId, message.channelId, { body: text });
    } else if (row.kind === "stalled") {
      if (!text) throw new ValidationError("Say what to tell its agent");
      await commentIssue({ db, pubsub: deps.pubsub }, { type: "person", userId: actorId }, orgId, row.issueId, text);
    } else if (row.kind === "howto") {
      // The person vouches for it (ADR 0167): trusted and verified, the day's pass makes it the agent's skill.
      await editContextItem(db, actorId, orgId, row.itemId, { confirmed: true });
    } else throw new ValidationError("This row is applied on its own card", "team_week.own_path");
    if (!input.skip) next.done[row.id] = done;
  }
  await setCardOnMessage(deps, orgId, messageId, next);
  return next;
}
