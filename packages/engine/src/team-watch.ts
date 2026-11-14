import { and, type Database, desc, eq, gt, inArray, isNull, lt, rowsOf, type SQL, schema, sql } from "@agenteschat/db";
import { serverText } from "@agenteschat/i18n";
import { formatList } from "@agenteschat/i18n/format";
import type { AppLocale } from "@agenteschat/i18n/locale";
import type { Agent } from "./agents";
import { backgroundAiState } from "./ai-status";
import { postApprovalsDigest } from "./approvals-digest";
import type { JobDeps } from "./jobs";
import {
  inboxVisible,
  type NotificationDeps,
  type NotificationKind,
  type NotificationSource,
  notify,
  remindNotifications,
  resolveNotifications,
  rewriteNotification,
} from "./notifications";
import { can, getMembership, type Membership } from "./organizations";
import { maySql, type RolePermission } from "./permissions";
import { personLocale } from "./requester";
import { defineLodiLane, liveLodiSwitches } from "./right-hand-lane";
import { knownZonesSql, lodiPrefsSql, zoneSql } from "./right-hand-prefs";
import { lodiFor, lodiSwitches, saidKey, saidOnce } from "./right-hand-proactive";
import { lastGoodRun, outsideRoutineFailure, routineResumeKey } from "./routine-ledger";
import { ROUTINE_FATIGUE_LIMIT } from "./routine-state";
import { resumeRoutineBySystem } from "./routines";
import { openOrg } from "./standing";
import { DEFAULT_AGENT_BUDGET_NANO_USD, monthStartUtc } from "./usage";

/**
 * "Cuidar da equipe": the right hand looks for what stops the team and acts. It calls no model.
 *
 * - It fixes what is safe by itself, silently (the audit log says so): a scheduled routine that paused itself as
 *   `failing` for causes outside it is resumed once those passed (`resumeCleared`), and a routine's first failure for
 *   such a cause gets one more try before anyone is told (`routine-ledger.ts`).
 * - It tells the one person who can fix the rest, through "Esperando você" (`team_watch`), once, with the cause and
 *   the one way out: an AI sign-in that ended, an app, a mailbox or a database to reconnect, a budget used up or
 *   about to be, a computer gone while agents wait for it (`tellProblems`).
 * - It reminds a person, once a day and never twice of the same thing, of what they left unread there for hours
 *   (`remindUnread`).
 *
 * What was already old when it first looked (`OLD_NEWS_MS`) is nobody's news: it is neither told nor reminded of, so
 * the day it starts in a workspace is as quiet as any other.
 *
 * The contract with the rest of the server is `teamWatchLane` below: the server reads the jobs, the sweep and the
 * switch from it, so nothing else is wired by hand.
 * - `enqueueTeamWatches` runs on the worker's `rightHand` tick, every 10 minutes, for every workspace at once. It
 *   queues `TEAM_WATCH_JOB` (payload `{}`, the organization on the job) only for open workspaces that have the right
 *   hand, whose `organization_settings.team_watch` is on (no row counts as on) and that have something the job would
 *   act on: every 10 minutes while something is new, every hour while it only stands.
 * - `runTeamWatch` is that job. It reads the switch again and may run twice: every step is once-only by a key. With
 *   the switch off it closes the rows it had open.
 */

export const TEAM_WATCH_JOB = "team_watch.check";

/** What it tells, by cause (`latest.reason`, worded by `notifications.teamWatch.<cause>`). */
export const TEAM_WATCH_CAUSES = [
  "sign_in",
  "connector",
  "mailbox",
  "database",
  "budget_out",
  "budget_low",
  "computer",
] as const;
export type TeamWatchCause = (typeof TEAM_WATCH_CAUSES)[number];

/**
 * A sign-in, an app or a mailbox is told once it stayed wrong this long: a blip tells nobody. Counted from the plan's
 * last turn, and from the last change of an app's or a mailbox's row.
 */
export const TELL_GRACE_MS = 20 * 60_000;
/** A brought computer is told once it has been gone this long with work waiting for it. */
export const OFFLINE_GRACE_MS = 30 * 60_000;
/** The share of a month's budget from which it is "about to end", when the month's pace would end it early. */
export const BUDGET_LOW_RATIO = 0.8;
/** New rows a person gets from it in a day, whatever is wrong. */
export const TEAM_WATCH_DAILY_ROWS = 3;
/** How many things a row names. The rest are counted. */
const MAX_NAMES = 3;
const DAY_MS = 24 * 3600_000;
/** A paused routine is looked at from this long after its pause (an outage needs time to pass) and for a day. */
export const ROUTINE_RESUME_AFTER_MS = 30 * 60_000;
const RESUME_WITHIN_MS = DAY_MS;
/** What began or moved within this long is looked at every 10 minutes. What only stands as it was, every hour. */
const NEW_FOR_MS = DAY_MS;
const WINDOW_MS = 10 * 60_000;
const WINDOWS_AN_HOUR = 6;
/** What waits on a person unread this long is reminded once, in their daytime. */
export const UNANSWERED_MS = 4 * 3600_000;
const DAY_STARTS = 9;
const DAY_ENDS = 18;
/** The asks it reminds of: what blocks an agent until this person answers. */
const REMINDED_KINDS: NotificationKind[] = ["approval", "agent_question", "secret_request"];
/**
 * Something wrong, or an ask left unread, for longer than this before it was ever told or reminded of is left alone.
 * A budget is not read by it: it is told for the month it is in.
 */
export const OLD_NEWS_MS = 7 * DAY_MS;

const {
  agentBudgetPeriods,
  agentRuns,
  agents,
  connectorConnections,
  dbConnections,
  machineAccounts,
  machines,
  mailAccounts,
  notifications,
  organizationSettings,
  outbox,
  routineRuns,
  routines,
} = schema;

/** A budget's month, as `agent_budget_periods.period_start` holds it. */
const periodOf = (now: Date) => monthStartUtc(now).toISOString().slice(0, 10);

// ── The sweep ─────────────────────────────────────────────────────────────────

/** An ask left unread for hours and not reminded yet, over `notifications n`. */
const unreadAsk = (at: SQL) => sql`n.waiting and n.done_at is null and n.read_at is null
  and (n.snoozed_until is null or n.snoozed_until <= ${at})
  and n.kind in (${sql.join(
    REMINDED_KINDS.map((k) => sql`${k}`),
    sql`, `,
  )})
  and n.created_at < (${at} - make_interval(secs => ${UNANSWERED_MS / 1000}))
  and n.created_at > (${at} - make_interval(secs => ${OLD_NEWS_MS / 1000}))
  and n.latest->>'reminder' is null`;

/** The person's own clock (their zone, else the workspace's, else UTC), over `organization_members m` and settings `s`. */
const localClock = (at: SQL) =>
  sql`(${at} at time zone ${zoneSql(sql`m.timezone`, zoneSql(sql`s.timezone`, sql`'UTC'`))})`;
const daytime = (at: SQL) => sql`extract(hour from ${localClock(at)})::int between ${DAY_STARTS} and ${DAY_ENDS - 1}`;
const localDay = (at: SQL) => sql`to_char(${localClock(at)}, 'YYYY-MM-DD')`;
/** `saidOnce` key of a person's one reminder on their local day. */
const remindKey = (userId: string, day: string) => `team_watch.remind:${userId}:${day}`;

/** The share of the month gone, never zero: a budget's pace is what was spent over it. */
const monthShare = (now: Date) => {
  const start = monthStartUtc(now).getTime();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max((now.getTime() - start) / (end - start), 0.001);
};

/**
 * Queues one check for each open workspace that has the right hand, "Cuidar da equipe" on and something the check
 * would act on: an open row of its own (to close once fixed), a problem as `problemsOf` reads it, a routine it may
 * resume, an ask to remind of today. A workspace with something new (`NEW_FOR_MS`) gets one check per 10-minute
 * window. One where everything only stands as it was, one an hour. With the switch off or the right hand gone, one
 * last check while a row of its own is open, to close it. Returns how many it queued.
 */
export async function enqueueTeamWatches(db: Database, now: Date = new Date()): Promise<number> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const ago = (ms: number) => sql`(${at} - make_interval(secs => ${ms / 1000}))`;
  const isNew = (since: SQL) => sql`${since} > ${ago(NEW_FOR_MS)}`;
  const budget = sql`coalesce(a.monthly_budget_nano_usd, s.default_agent_budget_nano_usd,
    ${DEFAULT_AGENT_BUDGET_NANO_USD}::bigint)`;
  const planSince = sql`greatest(ma.created_at, ma.last_used_at, ma.last_success_at)`;
  const lastSeen = sql`coalesce(mc.last_seen_at, mc.updated_at)`;
  const ownRows = sql`notifications n where n.org_id = organizations.id and n.kind = 'team_watch'
    and n.done_at is null`;
  // What there is to look at, each as rows under the workspace, and which of them are new. The conditions are the
  // check's own (`problemsOf`, `resumeCleared`, `remindUnread`): a row here that the check would pass over costs a
  // job each time.
  const reasons: { from: SQL; fresh?: SQL }[] = [
    { from: ownRows, fresh: isNew(sql`n.updated_at`) },
    {
      from: sql`machine_accounts ma where ma.org_id = organizations.id and ma.status = 'signed_out'
        and ma.created_by is not null and ${planSince} < ${ago(TELL_GRACE_MS)}
        and (ma.shared or exists (select 1 from agents a where a.org_id = ma.org_id
          and a.brain_account_id = ma.id and a.archived_at is null))`,
      fresh: isNew(planSince),
    },
    {
      from: sql`connector_connections c where c.org_id = organizations.id and c.status = 'needs_reconnect'
        and c.revoked_at is null and c.updated_at < ${ago(TELL_GRACE_MS)}`,
      fresh: isNew(sql`c.updated_at`),
    },
    {
      from: sql`mail_accounts ml where ml.org_id = organizations.id and ml.status = 'needs_reconnect'
        and ml.revoked_at is null and ml.created_by_user_id is not null and ml.updated_at < ${ago(TELL_GRACE_MS)}`,
      fresh: isNew(sql`ml.updated_at`),
    },
    {
      from: sql`db_connections d where d.org_id = organizations.id and d.status = 'needs_reconnect'
        and d.revoked_at is null`,
      fresh: isNew(sql`d.updated_at`),
    },
    {
      from: sql`machines mc where mc.org_id = organizations.id and mc.kind = 'connected' and mc.deleted_at is null
        and ${lastSeen} < ${ago(OFFLINE_GRACE_MS)}
        and exists (select 1 from agent_runs r where r.waiting_machine_id = mc.id)`,
      fresh: isNew(lastSeen),
    },
    {
      from: sql`agent_budget_periods b join agents a on a.id = b.agent_id
        where b.org_id = organizations.id and b.period_start = ${periodOf(now)}::date and a.archived_at is null
          and ${budget} > 0 and (b.spent_nano_usd >= ${budget}
            or (b.spent_nano_usd >= ${BUDGET_LOW_RATIO}::numeric * ${budget}
              and b.spent_nano_usd > ${monthShare(now)}::float8 * ${budget}))`,
    },
    {
      from: sql`routines rt where rt.org_id = organizations.id and not rt.active and rt.paused_reason = 'failing'
        and rt.trigger_type = 'schedule' and rt.deleted_at is null
        and rt.updated_at < ${ago(ROUTINE_RESUME_AFTER_MS)} and rt.updated_at > ${ago(RESUME_WITHIN_MS)}`,
    },
    {
      // Nobody is reminded twice a day: the key is `saidKey(orgId, remindKey(userId, day))`, as `remindUnread` writes it.
      from: sql`notifications n join organization_members m on m.org_id = n.org_id and m.user_id = n.user_id
        where n.org_id = organizations.id and ${unreadAsk(at)} and ${daytime(at)}
          and not exists (select 1 from outbox ob where ob.dedupe_key = 'right_hand.said:' || n.org_id::text
            || ':team_watch.remind:' || n.user_id || ':' || ${localDay(at)})`,
      fresh: sql`true`,
    },
  ];
  // 2: something new. 1: only what stands. 0: nothing.
  const level = sql`greatest(${sql.join(
    reasons.map(
      (r) => sql`coalesce((select max(case when ${r.fresh ?? sql`false`} then 2 else 1 end) from ${r.from}), 0)`,
    ),
    sql`, `,
  )})`;
  const orgs = rowsOf<{ id: string; level: number }>(
    await db.execute(sql`with ${knownZonesSql}
      select t.id, t.level from (
        select organizations.id, case
          when coalesce(s.team_watch, true) and exists (select 1 from agents a where a.org_id = organizations.id
            and a.builtin = 'right_hand' and a.archived_at is null) then ${level}
          when exists (select 1 from ${ownRows}) then 2
          else 0 end as level
        from organizations
        left join organization_settings s on s.org_id = organizations.id
        where ${openOrg}
      ) t where t.level > 0`),
  );
  if (orgs.length === 0) return 0;
  const window = Math.floor(now.getTime() / WINDOW_MS);
  const queued = await db
    .insert(outbox)
    .values(
      orgs.map((o) => ({
        orgId: o.id,
        kind: TEAM_WATCH_JOB,
        payload: {},
        dedupeKey: `${TEAM_WATCH_JOB}:${o.id}:${Number(o.level) > 1 ? window : window - (window % WINDOWS_AN_HOUR)}`,
        maxAttempts: 3,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: outbox.id });
  return queued.length;
}

// ── The job ───────────────────────────────────────────────────────────────────

/**
 * One look at a workspace: what it may fix, what it tells, what it reminds of. With the switch off or the right hand
 * gone it only closes the rows it had open: nobody is left with a notice that nothing will ever close.
 */
export async function runTeamWatch(deps: JobDeps, orgId: string, now: Date = new Date()): Promise<void> {
  const { db } = deps;
  const inbox: NotificationDeps = { db, pubsub: deps.pubsub, now: () => now };
  const lodi = (await lodiSwitches(db, orgId)).teamWatch ? await lodiFor(db, orgId) : null;
  if (!lodi) {
    const open = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.orgId, orgId), eq(notifications.kind, "team_watch"), isNull(notifications.doneAt)));
    if (open.length) await resolveNotifications(inbox, orgId, { ids: open.map((r) => r.id) });
    return;
  }
  await resumeCleared(deps, orgId, lodi, now);
  await tellProblems(inbox, orgId, lodi, now);
  await remindUnread(inbox, orgId, now);
}

// ── Fixes ─────────────────────────────────────────────────────────────────────

/**
 * Scheduled routines that paused themselves as `failing`: one whose last failures were all for causes outside it
 * (`outsideRoutineFailure`) and whose agent can think now is resumed, once between two good runs. A routine that
 * fails for its own reasons, or pauses again after this, stays paused: its pause notice already told its people.
 */
async function resumeCleared(deps: JobDeps, orgId: string, lodi: Agent, now: Date): Promise<number> {
  const { db } = deps;
  const paused = await db
    .select({ id: routines.id, agentId: routines.agentId })
    .from(routines)
    .where(
      and(
        eq(routines.orgId, orgId),
        eq(routines.active, false),
        eq(routines.pausedReason, "failing"),
        eq(routines.triggerType, "schedule"),
        isNull(routines.deletedAt),
        lt(routines.updatedAt, new Date(now.getTime() - ROUTINE_RESUME_AFTER_MS)),
        gt(routines.updatedAt, new Date(now.getTime() - RESUME_WITHIN_MS)),
      ),
    );
  let resumed = 0;
  for (const r of paused) {
    const lastGood = await lastGoodRun(db, r.id);
    const failures = await db
      .select({ code: routineRuns.code, error: agentRuns.error })
      .from(routineRuns)
      .leftJoin(agentRuns, eq(agentRuns.id, routineRuns.agentRunId))
      .where(
        and(
          eq(routineRuns.routineId, r.id),
          eq(routineRuns.status, "failed"),
          gt(routineRuns.finishedAt, new Date(lastGood)),
        ),
      )
      .orderBy(desc(routineRuns.finishedAt))
      .limit(ROUTINE_FATIGUE_LIMIT);
    if (failures.length < ROUTINE_FATIGUE_LIMIT || !failures.every((f) => outsideRoutineFailure(f.code, f.error)))
      continue;
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, r.agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt)));
    if (!agent) continue;
    const ai = await backgroundAiState({ db, gateway: deps.gateway, machines: deps.machines ?? null }, agent);
    // Not passed yet: looked at again on the next check, for a day.
    if (ai.state !== "ready") continue;
    if (!(await saidOnce(db, orgId, routineResumeKey(r.id, lastGood)))) continue;
    if (await resumeRoutineBySystem(deps, orgId, r.id, { type: "agent", id: lodi.id })) resumed++;
  }
  return resumed;
}

// ── Tells ─────────────────────────────────────────────────────────────────────

/** One thing wrong: what it is, which time it is wrong (`episode`), and who may fix it. */
interface Problem {
  cause: TeamWatchCause;
  id: string;
  name: string;
  /**
   * The same thing wrong again later is another episode, told again. Read from what a write that leaves it as wrong
   * as it was cannot move, wherever its row keeps such a time.
   */
  episode: string;
  since: Date;
  /**
   * Wrong for long enough to tell, and not for so long that it is old news. One that is not opens no row and brings
   * none back unread.
   */
  ripe: boolean;
  /** Whose it is to fix, when they still may (`needs`). Else the first person who may `orElse`, else nobody. */
  to: string | null;
  needs?: RolePermission;
  orElse?: RolePermission;
  /** Another kind's notice that says the same of this very thing (`saidElsewhere`). */
  elsewhere?: SQL;
}

/** A notice that names the agent: its actor, or one of the runs a `run_failed` row stands for. */
const namesAgent = (agentId: SQL | string) => sql`(${notifications.actors} @> jsonb_build_array(
    jsonb_build_object('type', 'agent', 'id', ${agentId}::text))
  or ${notifications.latest}->'failures' @> jsonb_build_array(jsonb_build_object('agentId', ${agentId}::text)))`;

/**
 * Notices of other kinds that already tell a person the same thing about the same object: with such a row of theirs
 * since the problem began, the right hand keeps none of its own. Each names its object, so one agent's notice never
 * hides another's problem.
 */
const saidElsewhere = {
  /** A run, a routine or a widget that could not go on for want of a sign-in, of an agent that thinks with this plan. */
  signIn: (orgId: string, accountId: string) =>
    sql`(${notifications.kind} in ('run_failed', 'routine_failed', 'widget_failed')
      and ${notifications.latest}->>'reason' = 'not_logged_in'
      and exists (select 1 from agents a where a.org_id = ${orgId} and a.brain_account_id = ${accountId}
        and ${namesAgent(sql`a.id`)}))`,
  budget: (agentId: string) =>
    sql`(${notifications.kind} in ('run_failed', 'routine_failed', 'widget_failed')
      and ${notifications.latest}->>'reason' = 'budget_exceeded' and ${namesAgent(agentId)})`,
  computer: (orgId: string, machineId: string) =>
    sql`((${notifications.kind} in ('routine_stalled', 'device.waiting')
        and ${notifications.source}->>'machineId' = ${machineId})
      or (${notifications.kind} = 'run_failed' and ${notifications.latest}->>'reason' = 'machine_offline'
        and exists (select 1 from agents a where a.org_id = ${orgId} and a.machine_id = ${machineId}
          and ${namesAgent(sql`a.id`)})))`,
};

/** Everything wrong in the workspace now, from stored rows only. */
async function problemsOf(db: Database, orgId: string, now: Date): Promise<Problem[]> {
  const stale = new Date(now.getTime() - TELL_GRACE_MS);
  const recent = (since: Date) => since.getTime() > now.getTime() - OLD_NEWS_MS;
  const out: Problem[] = [];
  const at = (d: Date) => String(d.getTime());

  // A plan's sign-in ended while an agent thinks with it: only whose plan it is hears it. Since its last turn, not
  // since its row last moved: every usage report of its computer rewrites the row of a plan that is still signed out.
  const accounts = await db
    .select({
      id: machineAccounts.id,
      name: machineAccounts.label,
      by: machineAccounts.createdBy,
      createdAt: machineAccounts.createdAt,
      usedAt: machineAccounts.lastUsedAt,
      workedAt: machineAccounts.lastSuccessAt,
    })
    .from(machineAccounts)
    .where(
      and(
        eq(machineAccounts.orgId, orgId),
        eq(machineAccounts.status, "signed_out"),
        sql`(${machineAccounts.shared} or exists (select 1 from agents a where a.org_id = ${orgId}
          and a.brain_account_id = ${machineAccounts.id} and a.archived_at is null))`,
      ),
    );
  for (const a of accounts) {
    const since = new Date(Math.max(a.createdAt.getTime(), a.usedAt?.getTime() ?? 0, a.workedAt?.getTime() ?? 0));
    out.push({
      cause: "sign_in",
      id: a.id,
      name: a.name,
      episode: at(since),
      since,
      ripe: since < stale && recent(since),
      to: a.by,
      elsewhere: saidElsewhere.signIn(orgId, a.id),
    });
  }

  // An app or a mailbox keeps no time of when it broke: its row's last change stands for it. A rename of one that
  // still needs reconnecting reads as a new episode.
  const connectors = await db
    .select({
      id: connectorConnections.id,
      name: connectorConnections.label,
      by: connectorConnections.createdByUserId,
      since: connectorConnections.updatedAt,
    })
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.orgId, orgId),
        eq(connectorConnections.status, "needs_reconnect"),
        isNull(connectorConnections.revokedAt),
      ),
    );
  for (const c of connectors)
    out.push({
      cause: "connector",
      ...c,
      episode: at(c.since),
      ripe: c.since < stale && recent(c.since),
      to: c.by,
      needs: "manage_connectors",
      orElse: "manage_connectors",
    });

  // A mailbox is its owner's alone: nobody else hears of it, not even its address.
  const mailboxes = await db
    .select({
      id: mailAccounts.id,
      address: mailAccounts.address,
      label: mailAccounts.label,
      by: mailAccounts.createdByUserId,
      since: mailAccounts.updatedAt,
    })
    .from(mailAccounts)
    .where(
      and(eq(mailAccounts.orgId, orgId), eq(mailAccounts.status, "needs_reconnect"), isNull(mailAccounts.revokedAt)),
    );
  for (const m of mailboxes)
    out.push({
      cause: "mailbox",
      id: m.id,
      name: m.address || m.label,
      episode: at(m.since),
      since: m.since,
      ripe: m.since < stale && recent(m.since),
      to: m.by,
    });

  // A refused password does not heal by itself, and its row keeps no time of the refusal: told at the next look.
  const databases = await db
    .select({
      id: dbConnections.id,
      name: dbConnections.label,
      by: dbConnections.createdByUserId,
      since: dbConnections.updatedAt,
    })
    .from(dbConnections)
    .where(
      and(eq(dbConnections.orgId, orgId), eq(dbConnections.status, "needs_reconnect"), isNull(dbConnections.revokedAt)),
    );
  for (const d of databases)
    out.push({
      cause: "database",
      ...d,
      episode: at(d.since),
      ripe: recent(d.since),
      to: d.by,
      needs: "manage_connectors",
      orElse: "manage_connectors",
    });

  // A month's budget used up stops the agent. One at 80% is told only when the month's pace would end it early.
  const period = periodOf(now);
  const elapsed = monthShare(now);
  const [settings] = await db
    .select({ budget: organizationSettings.defaultAgentBudgetNanoUsd })
    .from(organizationSettings)
    .where(eq(organizationSettings.orgId, orgId));
  const spends = await db
    .select({
      id: agents.id,
      name: agents.name,
      owner: agents.ownerUserId,
      budget: agents.monthlyBudgetNanoUsd,
      spent: agentBudgetPeriods.spentNanoUsd,
    })
    .from(agentBudgetPeriods)
    .innerJoin(agents, eq(agents.id, agentBudgetPeriods.agentId))
    .where(
      and(eq(agentBudgetPeriods.orgId, orgId), eq(agentBudgetPeriods.periodStart, period), isNull(agents.archivedAt)),
    );
  for (const a of spends) {
    const budget = a.budget ?? settings?.budget ?? DEFAULT_AGENT_BUDGET_NANO_USD;
    if (budget <= 0 || a.spent < BUDGET_LOW_RATIO * budget) continue;
    const usedUp = a.spent >= budget;
    if (!usedUp && a.spent / elapsed <= budget) continue;
    out.push({
      cause: usedUp ? "budget_out" : "budget_low",
      id: a.id,
      name: a.name,
      // Raised and used up again in the same month is told again.
      episode: `${period}:${budget}`,
      since: monthStartUtc(now),
      ripe: true,
      to: a.owner,
      needs: "manage_agents",
      orElse: "manage_agents",
      ...(usedUp ? { elsewhere: saidElsewhere.budget(a.id) } : {}),
    });
  }

  // A computer a person brought, gone while runs wait for it. The workspace's own computers are the operator's.
  const offline = await db
    .select({
      id: machines.id,
      name: machines.name,
      by: machines.pairedByUserId,
      seen: machines.lastSeenAt,
      at: machines.updatedAt,
    })
    .from(machines)
    .where(
      and(
        eq(machines.orgId, orgId),
        eq(machines.kind, "connected"),
        isNull(machines.deletedAt),
        sql`coalesce(${machines.lastSeenAt}, ${machines.updatedAt}) < ${new Date(now.getTime() - OFFLINE_GRACE_MS).toISOString()}::timestamptz`,
        sql`exists (select 1 from agent_runs r where r.waiting_machine_id = ${machines.id})`,
      ),
    );
  for (const m of offline) {
    const since = m.seen ?? m.at;
    out.push({
      cause: "computer",
      id: m.id,
      name: m.name,
      episode: at(since),
      since,
      ripe: recent(since),
      to: m.by,
      orElse: "configure",
      elsewhere: saidElsewhere.computer(orgId, m.id),
    });
  }
  return out;
}

const toldKey = (userId: string, p: Problem) => `team_watch.told:${userId}:${p.cause}:${p.id}:${p.episode}`;

/** The names a row's sentence says, as a list in the person's language: the first ones, then how many more. */
export const teamWatchNames = (names: readonly string[], locale: AppLocale) =>
  formatList(locale, [
    ...names.slice(0, MAX_NAMES),
    ...(names.length > MAX_NAMES
      ? [serverText(locale, "notifications.namesMore", { count: String(names.length - MAX_NAMES) })]
      : []),
  ]);

/**
 * Tells each problem to the one person who can fix it: one open row per person and cause, listing all of that cause
 * that is theirs, rewritten in place as the list changes and done only once nothing of it is wrong any more (a
 * problem stays listed for as long as its own status says so, whatever else moved on its row). A new row comes only
 * for a problem wrong for long enough that this person was never told (`toldKey`), so one put away with "Feito" does
 * not return, and at most `TEAM_WATCH_DAILY_ROWS` new rows a person a day. What another notice of theirs says of the
 * same thing (`saidElsewhere`) is left to that notice, whichever came first.
 */
async function tellProblems(deps: NotificationDeps, orgId: string, lodi: Agent, now: Date): Promise<void> {
  const { db } = deps;
  const problems = await problemsOf(db, orgId, now);
  const members = new Map<string, Membership | null>();
  const memberOf = async (userId: string) => {
    if (!members.has(userId)) members.set(userId, await getMembership(db, userId, orgId));
    return members.get(userId) ?? null;
  };
  const firsts = new Map<RolePermission, string | null>();
  const firstWhoMay = async (permission: RolePermission) => {
    if (!firsts.has(permission)) {
      const [row] = rowsOf<{ user_id: string }>(
        await db.execute(sql`select m.user_id from organization_members m where m.org_id = ${orgId}
          and ${maySql(sql`m.org_id`, sql`m.user_id`, permission)}
          order by (m.role = 'owner') desc, m.created_at asc limit 1`),
      );
      firsts.set(permission, row?.user_id ?? null);
    }
    return firsts.get(permission) ?? null;
  };
  const markTold = async (userId: string, list: Problem[]) => {
    for (const p of list) await saidOnce(db, orgId, toldKey(userId, p));
  };

  // Who each problem is told to, by person and cause. One that another notice of theirs already says is that
  // notice's: told for good, and in no row of the right hand's.
  const groups = new Map<string, { userId: string; cause: TeamWatchCause; problems: Problem[] }>();
  for (const p of problems) {
    const own = p.to ? await memberOf(p.to) : null;
    const userId = own && (!p.needs || can(own, p.needs)) ? p.to : p.orElse ? await firstWhoMay(p.orElse) : null;
    if (!userId) continue;
    if (p.elsewhere) {
      const [other] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.orgId, orgId),
            eq(notifications.userId, userId),
            p.elsewhere,
            gt(notifications.createdAt, p.since),
          ),
        )
        .limit(1);
      if (other) {
        await markTold(userId, [p]);
        continue;
      }
    }
    const key = `${userId}:${p.cause}`;
    const group = groups.get(key) ?? { userId, cause: p.cause, problems: [] };
    group.problems.push(p);
    groups.set(key, group);
  }

  const causeOf = (row: { latest: Record<string, unknown> }) => String(row.latest.reason ?? "");
  const open = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.orgId, orgId), eq(notifications.kind, "team_watch"), isNull(notifications.doneAt)));
  // What is no longer wrong, or is another notice's now, leaves by itself.
  const fixed = open.filter((r) => !groups.has(`${r.userId}:${causeOf(r)}`));
  if (fixed.length) await resolveNotifications(deps, orgId, { ids: fixed.map((r) => r.id) });

  for (const g of groups.values()) {
    g.problems.sort((a, b) => a.since.getTime() - b.since.getTime());
    const keys = g.problems.map((p) => saidKey(orgId, toldKey(g.userId, p)));
    const told = new Set(
      (await db.select({ key: outbox.dedupeKey }).from(outbox).where(inArray(outbox.dedupeKey, keys))).map(
        (r) => r.key,
      ),
    );
    const fresh = g.problems.filter((p, i) => p.ripe && !told.has(keys[i] as string));
    const names = g.problems.map((p) => p.name);
    const only = g.problems.length === 1 ? g.problems[0] : undefined;
    const source: NotificationSource = {
      ...(only && g.cause.startsWith("budget_") ? { agentId: only.id } : {}),
      ...(only && g.cause === "computer" ? { machineId: only.id } : {}),
      ...(only && g.cause === "sign_in" ? { accountId: only.id } : {}),
    };
    const locale = await personLocale(db, g.userId);
    const latest = {
      reason: g.cause,
      names: names.slice(0, MAX_NAMES),
      text: serverText(locale, `notifications.teamWatch.${g.cause}`, {
        names: teamWatchNames(names, locale),
        count: String(names.length),
      }),
    };
    const row = open.find((r) => r.userId === g.userId && causeOf(r) === g.cause);
    if (row) {
      // It lists everything of that cause at once, and comes back unread only for what is wrong for long enough.
      if (fresh.length > 0 || row.count !== names.length || row.latest.text !== latest.text)
        await rewriteNotification(deps, row.id, { count: names.length, source, latest, unread: fresh.length > 0 });
      await markTold(g.userId, fresh);
      continue;
    }
    if (fresh.length === 0) continue;
    const [today] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.orgId, orgId),
          eq(notifications.userId, g.userId),
          eq(notifications.kind, "team_watch"),
          gt(notifications.createdAt, new Date(now.getTime() - DAY_MS)),
        ),
      );
    // Over the day's rows: it waits, untold, for a later look.
    if ((today?.n ?? 0) >= TEAM_WATCH_DAILY_ROWS) continue;
    const first = fresh[0] as Problem;
    const [made] = await notify(deps, {
      orgId,
      userIds: [g.userId],
      kind: "team_watch",
      groupKey: `team_watch:${g.cause}:${first.id}:${first.episode}`,
      // A budget about to end stops nothing yet: a plain row, which reaches no device.
      waiting: g.cause !== "budget_low",
      actor: { type: "agent", id: lodi.id },
      source,
      latest,
    });
    if (made && names.length > 1) await rewriteNotification(deps, made.id, { count: names.length, source, latest });
    await markTold(g.userId, fresh);
  }
}

// ── Reminders ─────────────────────────────────────────────────────────────────

/**
 * One reminder a day for what a person left unread in "Esperando você" for hours (an approval, an agent's question, a
 * secret to give), in their own daytime: the oldest comes back on top and goes to their devices once, saying how many
 * still wait, and every one of them is marked reminded, so none is ever reminded twice. Approvals are left to the
 * digest of approvals only when one of its cards holds them: it is asked to post or grow its card here, so a person
 * it never summed up for (their approvals are older than it, or they turned it on since) gets one, and a person it
 * cannot write to, or whose approvals it does not count, is reminded like anyone else.
 */
async function remindUnread(deps: NotificationDeps, orgId: string, now: Date): Promise<number> {
  const { db } = deps;
  const at = sql`${now.toISOString()}::timestamptz`;
  const people = rowsOf<{ user_id: string; day: string; digest_off: boolean }>(
    await db.execute(sql`with ${knownZonesSql}
      select distinct n.user_id, ${localDay(at)} as day,
        ${lodiPrefsSql.digestOff} as digest_off
      from notifications n
      join organization_members m on m.org_id = n.org_id and m.user_id = n.user_id
      left join organization_settings s on s.org_id = n.org_id
      where n.org_id = ${orgId} and ${unreadAsk(at)} and ${daytime(at)}`),
  );
  let reminded = 0;
  for (const p of people) {
    const mine = and(inboxVisible(orgId, p.user_id, now), eq(notifications.waiting, true));
    const asked = and(
      eq(notifications.waiting, true),
      isNull(notifications.readAt),
      inArray(notifications.kind, REMINDED_KINDS),
      lt(notifications.createdAt, new Date(now.getTime() - UNANSWERED_MS)),
      gt(notifications.createdAt, new Date(now.getTime() - OLD_NEWS_MS)),
      sql`${notifications.latest}->>'reminder' is null`,
    );
    let rows = await db
      .select({ id: notifications.id, kind: notifications.kind, groupKey: notifications.groupKey })
      .from(notifications)
      .where(and(mine, asked))
      .orderBy(notifications.createdAt);
    // Marked as reminded with no push: the digest's, all but the one the reminder brings back, and an approval this
    // person may no longer decide (it is out of their inbox, and unmarked it would be looked at for ever).
    const theirs = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.orgId, orgId),
          eq(notifications.userId, p.user_id),
          eq(notifications.kind, "approval"),
          isNull(notifications.doneAt),
          sql`(${notifications.snoozedUntil} is null or ${notifications.snoozedUntil} <= ${at})`,
          asked,
        ),
      );
    const quiet = theirs.map((r) => r.id).filter((id) => !rows.some((r) => r.id === id));
    if (
      liveLodiSwitches().includes("digest") &&
      !p.digest_off &&
      rows.some((r) => r.kind === "approval") &&
      (await postApprovalsDigest(deps, orgId, { userId: p.user_id }, now))
    ) {
      quiet.push(...rows.filter((r) => r.kind === "approval").map((r) => r.id));
      rows = rows.filter((r) => r.kind !== "approval");
    }
    const first = rows[0];
    const once = first ? await saidOnce(db, orgId, remindKey(p.user_id, p.day)) : false;
    if (once) quiet.push(...rows.slice(1).map((r) => r.id));
    if (quiet.length)
      await db
        .update(notifications)
        .set({ latest: sql`${notifications.latest} || '{"reminder": true}'::jsonb` })
        .where(inArray(notifications.id, quiet));
    if (!first || !once) continue;
    reminded += await remindNotifications(
      deps,
      orgId,
      first.groupKey,
      { reminder: true, still: rows.length },
      `team_watch:${p.day}`,
      [p.user_id],
    );
  }
  return reminded;
}

export const teamWatchLane = defineLodiLane({
  switch: "teamWatch",
  live: true,
  jobs: { [TEAM_WATCH_JOB]: (deps, orgId) => runTeamWatch(deps, orgId) },
  sweep: enqueueTeamWatches,
});
