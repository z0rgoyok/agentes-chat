import type { PlanUsage, PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, inArray, type SQL, schema, sql } from "@agenteschat/db";
import { extraUsageLeft, PLAN_PAUSE, planBinding, planState } from "@agenteschat/ui/plan-state";
import { ACCESS_COLUMNS, type AgentAccessFields, managesRoutinesOf, REACH_COLUMNS } from "./audience";
import { recordAudit } from "./audit";
import { UUID } from "./authority";
import { forgetPlanLimit, storedPlanUsage } from "./brains/select";
import type { BrainKind } from "./brains/types";
import { mayStopRun, runRequester } from "./cancel";
import { ConflictError, ForbiddenError } from "./errors";
import { publishMessageCreated } from "./events";
import { inMillisecondOf } from "./message-place";
import { type Message, messageView } from "./messages";
import { type Membership, requireActiveMembership } from "./organizations";
import { enqueue } from "./outbox";
import { isRightHand } from "./right-hand";
import { missStaleRoutineRun } from "./routine-firing";
import { isTerminal } from "./runs";
import { effectiveAgentBudget, monthStartUtc } from "./usage";

/**
 * A run waiting on usage (the usage-aware design, Phase 1): its plan's limit (`plan_limit`) or its agent's
 * monthly API budget (`budget`). It parks in its own session (`waiting_input`, `waitingForBrain` with this
 * code and no computer) and a timed `agent_run.execute` job resumes it; the gate is checked again on every
 * resume, so a wrong reset time corrects itself.
 */
export const USAGE_WAIT_CODES: ReadonlySet<string> = new Set(["plan_limit", "budget", "usage_pause"]);

/** Re-checks of a limit whose reset nobody said (ms after it was seen), then hourly. */
export const LIMIT_LADDER_MS = [2 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
/** A resumed run starts this long after the reset, and each next one of the same plan this much later. */
export const RESUME_AFTER_MS = 30_000;
export const RESUME_GAP_MS = 60_000;
/**
 * A wait parked again this soon after its last park was woken into the same limit (`steady`): no wake for this long
 * after that park, only its own timer.
 */
export const REPARK_STEADY_MS = 10 * 60_000;
/** A plan still silent about its reset after this long: the agent's owner hears it once. */
export const UNKNOWN_RESET_NOTICE_MS = 24 * 3600_000;

/** How long the `step`th re-check of an unknown reset waits (0-based). */
export const ladderDelay = (step: number) => LIMIT_LADDER_MS[step] ?? 3600_000;

/** When the next month starts (UTC): an agent's budget renews then. */
export const nextMonthStart = (now: number) => {
  const start = monthStartUtc(new Date(now));
  return Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
};

export { planName } from "./brains/types";

/** What groups the runs that wait on the same thing (they resume one after another): a plan's sign-in or a budget. */
export const usageWaitKey = (
  w:
    | { code: "plan_limit"; machineId: string; kind: BrainKind; accountId?: string }
    | { code: "budget"; agentId: string },
) => (w.code === "budget" ? `budget:${w.agentId}` : `plan:${w.machineId}:${w.kind}:${w.accountId ?? "own"}`);

/**
 * A plan's `usageWaitKey` read back: the computer its sign-in is on and, when the sign-in is an account's, that
 * account (null: the computer's own). Null for a budget's key and for anything else.
 */
export function planOfWaitKey(key: unknown): { machineId: string | null; accountId: string | null } | null {
  const [plan, machineId = "", kind, accountId = "", ...more] = typeof key === "string" ? key.split(":") : [];
  if (plan !== "plan" || !kind || !accountId || more.length > 0) return null;
  return { machineId: UUID.test(machineId) ? machineId : null, accountId: UUID.test(accountId) ? accountId : null };
}

/** A run in a usage line: people's conversations (0), then long work (1), then routines (2). */
const lineRank = (r: { background: boolean; workId: string | null }) => (r.background ? 2 : r.workId ? 1 : 0);

/** When a waiting run first paused, across its re-parks (`waitingForBrain.since`; older waits: its start). */
const waitSinceSql = sql<string>`coalesce(${schema.agentRuns.transcript}->'waitingForBrain'->>'since',
  ${schema.agentRuns.transcript}->'usageWait'->>'since',
  (extract(epoch from ${schema.agentRuns.createdAt}) * 1000)::bigint::text)`;

interface LineRow {
  id: string;
  background: boolean;
  workId: string | null;
  since: number;
  createdAt: Date;
  /** The model its plan wait is on ("": the brain's default; null: stored without one, or a budget wait). */
  model?: string | null;
}

/** A plan wait's model, as `LineRow.model`. */
const waitModelSql = sql<string | null>`case when ${schema.agentRuns.transcript}->'waitingForBrain' ? 'model'
  then coalesce(${schema.agentRuns.transcript}->'waitingForBrain'->>'model', '') end`;

/**
 * Two waits on one sign-in wait for the same reset unless they are on different models (a model's own weekly limit):
 * those keep their own head and their own timers.
 */
const sameReset = (a: LineRow, model: string | null | undefined) =>
  a.model == null || model == null || a.model === model;

/** The order of a usage line: by group, then by when each first paused. Parking again never changes a place. */
const inLineOrder = (a: LineRow, b: LineRow) =>
  lineRank(a) - lineRank(b) || a.since - b.since || a.createdAt.getTime() - b.createdAt.getTime();

/** The runs waiting on `key` (a plan's sign-in or a budget), in line order. */
async function lineRows(db: Executor, orgId: string, key: string): Promise<LineRow[]> {
  const { agentRuns } = schema;
  const rows = await db
    .select({
      id: agentRuns.id,
      background: agentRuns.background,
      workId: agentRuns.workId,
      since: waitSinceSql,
      createdAt: agentRuns.createdAt,
      model: waitModelSql,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.status, "waiting_input"),
        sql`${agentRuns.transcript}->'waitingForBrain'->>'waitKey' = ${key}`,
      ),
    )
    .limit(500);
  return rows.map((r) => ({ ...r, since: Number(r.since) })).sort(inLineOrder);
}

/**
 * This run's place in the line of `key` among the runs already waiting there (`inLineOrder`, `since`: when it first
 * paused), whether it heads the waits for its reset (`model`: its plan wait's, as `LineRow.model`), and the runs behind
 * it that wait for that same reset, in order.
 */
export async function usageWaitPlace(
  db: Executor,
  run: { id: string; orgId: string; background: boolean; workId?: string | null; createdAt: Date },
  key: string,
  since: number,
  model?: string | null,
): Promise<{ place: number; head: boolean; behind: string[] }> {
  const others = (await lineRows(db, run.orgId, key)).filter((r) => r.id !== run.id);
  const me: LineRow = { ...run, workId: run.workId ?? null, since };
  const place = others.filter((r) => inLineOrder(r, me) < 0).length;
  const mine = (r: LineRow) => sameReset(r, model);
  return {
    place,
    head: !others.slice(0, place).some(mine),
    behind: others
      .slice(place)
      .filter(mine)
      .map((r) => r.id),
  };
}

/**
 * The line pauses together: the waits of `runIds` (in line order) are timed `at(i)`, in one statement. Every pending
 * job of a wait moves (its own timer, a plan-back wake), so none of them asks the plan early.
 */
export async function retimeLine(db: Executor, runIds: string[], at: (i: number) => Date) {
  if (runIds.length === 0) return;
  const { outbox } = schema;
  const times = runIds.map((_, i) => at(i).toISOString());
  await db.execute(sql`update ${outbox} o set next_attempt_at = v.at
    from unnest(${`{${runIds.join(",")}}`}::text[], ${`{${times.join(",")}}`}::timestamptz[]) as v(run_id, at)
    where o.kind = 'agent_run.execute' and o.status = 'pending' and o.payload ? 'wait'
      and o.payload->>'runId' = v.run_id`);
}

/** With an unknown reset only the head re-checks the plan; the others wait this long at most, woken by the head. */
export const LINE_SAFETY_MS = 24 * 3600_000;

/**
 * The head of a line left it without getting through (stopped, archived): with an unknown reset the new head starts
 * the re-checks, or it would sleep on its safety timer.
 */
export async function lineHeadLooks(db: Executor, orgId: string, key: string, now = Date.now()) {
  // The head of each reset the line waits for (one per model with a limit of its own).
  const heads: LineRow[] = [];
  for (const r of await lineRows(db, orgId, key)) if (!heads.some((h) => sameReset(h, r.model))) heads.push(r);
  const { agentRuns } = schema;
  const soon = now + ladderDelay(0);
  for (const head of heads) {
    const [row] = await db
      .select({
        waitId: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'waitId'`,
        resetsAt: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'resetsAt'`,
        until: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'until'`,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, head.id));
    if (!row?.waitId || row.resetsAt || Date.parse(row.until ?? "") <= soon) continue;
    await enqueue(db, {
      orgId,
      kind: "agent_run.execute",
      payload: { runId: head.id, wait: row.waitId },
      dedupeKey: `agent_run.execute:${head.id}:head:${row.waitId}`,
      runAt: new Date(soon),
      maxAttempts: 4,
    });
  }
}

/**
 * A turn on a plan just went through, so the plan has room again: the runs parked on its limit (`plan_limit`, the same
 * `key`) go on now, in `usageWaitPlace`'s order, 60 s apart, instead of each sleeping until its own timer (a later
 * reset reading, an unknown reset's re-checks). Without this a routine's slot could wait well past the reset while a
 * person's reply on the same plan had already gone through. A long-work pause (99%) keeps its timer: a quick reply
 * going through says nothing about its line. One job per wait; the old timed one finds the wait gone and does nothing.
 * Only waits on the same `model` (a model's own weekly limit isn't lifted by another model's turn); a wait stored
 * without one is woken. `room`: a reading of the plan taken `at` has room again (`wakeOnRoom`): every wait on the
 * account's limit that last parked before it, whatever its model, and every long-work pause on that sign-in that the
 * reading puts back under the pause line for its own model (`longWorkHasRoom`). Without the reading's word a pause would
 * sleep on its timer, a reset a day away or, behind the head of an unknown reset, the line's day-long safety timer. A
 * wait that parked again right after a wake (`steady`) isn't woken for `REPARK_STEADY_MS` after that park (a wait behind
 * the head of an unknown reset sleeps on a day's safety timer, so it must still be woken later).
 */
export async function wakePlanWaits(
  db: Executor,
  orgId: string,
  key: string,
  model: string | null,
  now = Date.now(),
  room?: { at: number; usage?: PlanUsage },
): Promise<string[]> {
  const { agentRuns, agents } = schema;
  const fields = {
    id: agentRuns.id,
    background: agentRuns.background,
    workId: agentRuns.workId,
    waitId: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'waitId'`,
    until: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'until'`,
    since: waitSinceSql,
    parkedAt: sql<string | null>`${agentRuns.transcript}->'usageWait'->>'parkedAt'`,
    createdAt: agentRuns.createdAt,
  };
  const parked = (code: SQL) =>
    and(
      eq(agentRuns.orgId, orgId),
      eq(agentRuns.status, "waiting_input"),
      code,
      sql`${agentRuns.transcript}->'waitingForBrain'->>'waitKey' = ${key}`,
      sql`(not (${agentRuns.transcript}->'waitingForBrain' ? 'steady')
        or coalesce((${agentRuns.transcript}->'usageWait'->>'parkedAt')::bigint, 0) < ${now - REPARK_STEADY_MS})`,
      room
        ? sql`not (${agentRuns.transcript}->'waitingForBrain' ? 'scope')`
        : sql`(not (${agentRuns.transcript}->'waitingForBrain' ? 'model') or ${agentRuns.transcript}->'waitingForBrain'->>'model' is not distinct from ${model})`,
    );
  const limits = await db
    .select(fields)
    .from(agentRuns)
    .where(parked(sql`${agentRuns.transcript}->'waitingForBrain'->>'code' = 'plan_limit'`))
    .orderBy(agentRuns.createdAt)
    .limit(100);
  // Pauses have a query of their own, so the ones the reading leaves paused never take the limit waits' places.
  const reading = room?.usage;
  const pauses = reading
    ? (
        await db
          .select({
            ...fields,
            waitModel: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'model'`,
            brainAccountLentBy: runLentBy,
            builtin: agents.builtin,
          })
          .from(agentRuns)
          .innerJoin(agents, eq(agents.id, agentRuns.agentId))
          .where(parked(sql`${agentRuns.transcript}->'waitingForBrain'->>'code' = 'usage_pause'`))
          .orderBy(agentRuns.createdAt)
          .limit(100)
      ).filter((r) => longWorkHasRoom(planReading(reading, r.waitModel, paysExtraUsage(r), now)))
    : [];
  const due = [...limits, ...pauses]
    .map((r) => ({ ...r, since: Number(r.since), parkedAt: Number(r.parkedAt ?? r.since) }))
    .filter((r) => r.waitId && !(Date.parse(r.until ?? "") <= now + RESUME_GAP_MS) && !(room && r.parkedAt >= room.at))
    .sort(inLineOrder);
  for (const [i, r] of due.entries()) {
    await enqueue(db, {
      orgId,
      kind: "agent_run.execute",
      payload: { runId: r.id, wait: r.waitId },
      dedupeKey: `agent_run.execute:${r.id}:${room ? "room_back" : "plan_back"}:${r.waitId}`,
      runAt: new Date(now + i * RESUME_GAP_MS),
      maxAttempts: 4,
    });
  }
  return due.map((r) => r.id);
}

/**
 * A reading of a sign-in's plan (an account, or `accountId` absent: the computer's own) that the runner just reported:
 * with no window full and no refusal, the plan has room again, so the runs parked on its limit go on now
 * (`wakePlanWaits`), instead of waiting for a reset that already happened, and so does the long work it puts back under
 * the pause line.
 */
export async function wakeOnRoom(
  db: Executor,
  orgId: string,
  machineId: string,
  kind: BrainKind,
  accountId: string | undefined,
  usage: PlanUsage,
  now = Date.now(),
): Promise<string[]> {
  const at = Date.parse(usage.at);
  if (!Number.isFinite(at) || planState(usage, now).state === "limited") return [];
  forgetPlanLimit(machineId, kind, accountId);
  const key = usageWaitKey({ code: "plan_limit", machineId, kind, accountId });
  return wakePlanWaits(db, orgId, key, null, now, { at, usage });
}

/**
 * The agent's budget went up (its own, or the workspace's default): the runs that wait for it go on now.
 * One that still doesn't fit parks again quietly. `agentId` null: every agent of the workspace.
 */
export async function resumeBudgetWaits(
  db: Executor,
  orgId: string,
  agentId: string | null,
  now = Date.now(),
): Promise<string[]> {
  const { agentRuns } = schema;
  const found = await db
    .select({
      id: agentRuns.id,
      waitId: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'waitId'`,
      background: agentRuns.background,
      workId: agentRuns.workId,
      since: waitSinceSql,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.status, "waiting_input"),
        ...(agentId ? [eq(agentRuns.agentId, agentId)] : []),
        sql`(${agentRuns.transcript}->'waitingForBrain'->>'code' = 'budget' or (${agentRuns.transcript}->'waitingForBrain'->>'code' = 'usage_pause' and ${agentRuns.transcript}->'waitingForBrain'->>'source' = 'budget'))`,
      ),
    )
    .limit(500);
  // In line order and 60 s apart, as after a reset: the conversations that paused first are answered first.
  const rows = found.map((r) => ({ ...r, since: Number(r.since) })).sort(inLineOrder);
  for (const [i, r] of rows.filter((r) => r.waitId).entries()) {
    await enqueue(db, {
      orgId,
      kind: "agent_run.execute",
      payload: { runId: r.id, wait: r.waitId },
      dedupeKey: `agent_run.execute:${r.id}:budget_raised:${r.waitId}`,
      runAt: new Date(now + i * RESUME_GAP_MS),
      maxAttempts: 4,
    });
  }
  return rows.map((r) => r.id);
}

/**
 * Long work (ADR 0118): what pauses near a limit, while replies to people go on. A routine's run (not Rodar agora, nor
 * a widget's refresh) and a mission's are long by kind; any other once it grew in this claim of the run (a person
 * acting on it starts a new claim, so a fresh allowance): `LONG_WORK.modelCalls` model calls, a computer brain's third
 * turn, or `LONG_WORK.ms` of work with a call made. A run paused once stays long; Continuar agora's override never
 * pauses.
 */
export const LONG_WORK = { modelCalls: 8, computerTurns: 2, ms: 10 * 60_000 } as const;

export function isLongWork(w: {
  routine: boolean;
  mission: boolean;
  pausedBefore: boolean;
  computer: boolean;
  calls: number;
  elapsedMs: number;
}): boolean {
  if (w.routine || w.mission || w.pausedBefore) return true;
  if (w.computer ? w.calls >= LONG_WORK.computerTurns : w.calls >= LONG_WORK.modelCalls) return true;
  return w.calls >= 1 && w.elapsedMs >= LONG_WORK.ms;
}

/** Continuar agora's override still holds: until the window it was pressed on resets (null: until the run ends). */
export const overrideHolds = (o: { until: string | null } | undefined, now = Date.now()) =>
  o !== undefined && (o.until === null || Date.parse(o.until) > now);

/**
 * Where long work on `model` stands under this reading of its plan (the executor's gate and the wakes read it alike):
 * its binding window, and whether it may go on into the plan's paid extra usage (`extraUsage`: `paysExtraUsage`).
 * Null: nothing binds.
 */
export function planReading(
  usage: PlanUsage | null | undefined,
  model: string | null,
  extraUsage: boolean,
  now = Date.now(),
) {
  const top = planBinding(usage, { model, now });
  if (!top) return null;
  return {
    source: "plan" as const,
    used: top.used,
    window: top.kind,
    ...(top.resetsAt ? { resetsAt: top.resetsAt } : {}),
    extra: extraUsage && extraUsageLeft(usage),
  };
}

/**
 * The gate's one rule (ADR 0118): long work goes on when nothing is known, its plan's or budget's reading is under the
 * pause line, or it may go on into the plan's paid extra usage. The executor pauses by it; a reading wakes by it.
 */
export const longWorkHasRoom = (r: { used: number; extra?: boolean } | null) =>
  !r || r.used < PLAN_PAUSE || r.extra === true;

/** The plan's own allowance: past it, long work goes on only into paid extra usage. */
export const PLAN_FULL = 100;

/** Where a paused run's plan was read when it parked, so Continuar agora reads the same window again. */
export interface PlanReadingRef {
  machineId: string;
  accountId?: string;
  model?: string | null;
}

/**
 * Continuar agora's one rule (ADR 0118), the card's and Rotinas' alike, and the gate after a press: a run paused near
 * its plan's limit may go on up to the plan's own allowance (100%), and past it only into paid extra usage the agent
 * may use (`extra`). True: going on now would go past the plan with extra usage off.
 */
export const continuesPastPlan = (r: { source: "plan" | "budget"; used: number; extra?: boolean } | null) =>
  r !== null && r.source === "plan" && !r.extra && r.used >= PLAN_FULL;

/**
 * Long work may go on into the plan's paid extra usage where the plan reports it on (ADR 0118, its 2026-11-15
 * addendum): on the agent's owner's own plan. Never on someone else's plan lent to it, which bills that person, nor
 * for the team's right hand: both started with it off while it was a switch.
 */
export const paysExtraUsage = (agent: { brainAccountLentBy?: string | null; builtin?: string | null }) =>
  !agent.brainAccountLentBy && !isRightHand(agent);

/** Whose plan lent to a run it thinks with (`paysExtraUsage`): the account it moved to's (`AccountMove.lentBy`), else its agent's. */
const runLentBy = sql<string | null>`case when ${schema.agentRuns.transcript} ? 'accountMove'
  then ${schema.agentRuns.transcript}->'accountMove'->>'lentBy' else ${schema.agents.brainAccountLentBy} end`;

/**
 * Why Continuar agora is refused (`continuesPastPlan`), in the words both places use: the agent's long work never
 * uses paid extra usage (`paysExtraUsage`), or the plan has none left (none reported, or that window is used up too).
 */
export const CONTINUE_PAST_PLAN = {
  extra_off:
    "This plan's window is used up and this agent's long work doesn't use the plan's paid extra usage: it picks up after the reset",
  extra_used_up:
    "This plan's window is used up and its paid extra usage is used up or unavailable: it picks up after the reset",
} as const;

export type PastPlanReason = keyof typeof CONTINUE_PAST_PLAN;

/** Where the plan of a run paused at `ref` stands now, as the executor's gate reads it. Null: nothing known. */
export async function pausedPlanReading(
  db: Executor,
  orgId: string,
  kind: BrainKind,
  ref: PlanReadingRef | undefined,
  extraUsage: boolean,
) {
  if (!ref?.machineId) return null;
  const usage = await storedPlanUsage(db, orgId, ref.machineId, kind, ref.accountId).catch(() => null);
  const top = planBinding(usage, { model: ref.model ?? null });
  return top ? { source: "plan" as const, used: top.used, extra: extraUsage && extraUsageLeft(usage) } : null;
}

/** Why Continuar agora on the paused run `runId` would go past its plan without extra usage (`continuesPastPlan`); null: it may go on. */
export async function pauseContinuesPastPlan(
  db: Executor,
  orgId: string,
  runId: string,
): Promise<PastPlanReason | null> {
  const { agentRuns, agents } = schema;
  const [row] = await db
    .select({
      wait: sql<Record<string, unknown> | null>`${agentRuns.transcript}->'waitingForBrain'`,
      brainAccountLentBy: runLentBy,
      builtin: agents.builtin,
    })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId)));
  const wait = row?.wait as { kind?: BrainKind; source?: string; reading?: PlanReadingRef } | null | undefined;
  if (!row || !wait?.kind || wait.source === "budget") return null;
  const extraUsage = paysExtraUsage(row);
  const reading = await pausedPlanReading(db, orgId, wait.kind, wait.reading, extraUsage);
  if (!continuesPastPlan(reading)) return null;
  return extraUsage ? "extra_used_up" : "extra_off";
}

/** Refuses Continuar agora that would go past the plan without extra usage, as `<where>.continue_<reason>`. */
export async function assertMayContinuePause(db: Executor, orgId: string, runId: string, where: "routine" | "run") {
  const reason = await pauseContinuesPastPlan(db, orgId, runId);
  if (reason) throw new ConflictError(CONTINUE_PAST_PLAN[reason], `${where}.continue_${reason}`);
}

/**
 * How much of its monthly budget the agent used this UTC month, in percent: `spent`, and `held` with what its runs
 * reserved for calls in flight (worst-case, released when each call ends).
 */
export async function budgetUsedPercent(
  db: Database,
  agent: { id: string; orgId: string; monthlyBudgetNanoUsd: number | null },
  now = new Date(),
): Promise<{ spent: number; held: number }> {
  const { agentBudgetPeriods } = schema;
  const period = monthStartUtc(now).toISOString().slice(0, 10);
  const [[row], budget] = await Promise.all([
    db
      .select({ spent: agentBudgetPeriods.spentNanoUsd, reserved: agentBudgetPeriods.reservedNanoUsd })
      .from(agentBudgetPeriods)
      .where(and(eq(agentBudgetPeriods.agentId, agent.id), eq(agentBudgetPeriods.periodStart, period))),
    effectiveAgentBudget(db, agent),
  ]);
  const percent = (n: number) => (budget <= 0 ? 0 : Math.floor((n / budget) * 100));
  const spent = row?.spent ?? 0;
  return { spent: percent(spent), held: percent(spent + (row?.reserved ?? 0)) };
}

/** A plan's window in a sentence the engine writes ("of its 5 hours"); the apps word it themselves. */
export const USAGE_WINDOW_WORDS: Record<string, string> = {
  five_hour: "of its 5 hours",
  seven_day: "of its week",
  seven_day_opus: "of its Opus week",
  seven_day_sonnet: "of its Sonnet week",
  monthly: "of its month",
};

/**
 * What a computer brain reads in "# This turn" from 90% of its plan (ADR 0118). `granted`: a person let this work go
 * past the pause line (Continuar agora, or `ignore_usage_limit`).
 */
export function usageNoticeText(
  plan: string,
  r: { used: number; window?: string; resetsAt?: string; extra?: boolean },
  granted = false,
) {
  const window = r.window ? ` ${USAGE_WINDOW_WORDS[r.window] ?? ""}`.trimEnd() : "";
  const resets = r.resetsAt ? ` and resets at ${r.resetsAt}` : "";
  return [
    "# Your plan's usage",
    `Your ${plan} plan is at ${r.used}%${window}${resets}.`,
    r.extra
      ? "Its paid extra usage is on, so long work goes on past the plan's limit and replies to people go on too."
      : granted
        ? "A person told you to go past the pause line for this work. Keep working: only the plan's own limit (100%) stops you."
        : `At ${PLAN_PAUSE}% long work pauses by itself and picks up after the reset, and replies to people go on. Keep working as usual and leave each finished step in a working state. Before you start something big, tell the people it may pause. If a person tells you to ignore the limit or to keep going anyway, call ${IGNORE_LIMIT_TOOL} and go on.`,
  ].join("\n");
}

/** The tool a person's "ignore the limit" in the chat goes through (`grantUsageOverride`). */
export const IGNORE_LIMIT_TOOL = "ignore_usage_limit";

/** Whether a person let this run go past the pause line from the chat (`usageGrant`, on the row or in `t`). */
export async function usageGranted(db: Executor, runId: string, t?: { usageGrant?: unknown }) {
  if (t?.usageGrant) return true;
  const { agentRuns } = schema;
  const [row] = await db
    .select({ granted: sql<boolean>`${agentRuns.transcript} ? 'usageGrant'` })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  return row?.granted === true;
}

/** Whether a routine's run was started by Rodar agora (a person asked for it now), not by its schedule. */
export async function routineRunByHand(db: Executor, runId: string) {
  const { routineRuns } = schema;
  const [row] = await db
    .select({ trigger: routineRuns.trigger })
    .from(routineRuns)
    .where(eq(routineRuns.agentRunId, runId))
    .limit(1);
  return row?.trigger === "manual";
}

/**
 * Whether a routine's run refreshes a widget (ADR 0135 §4): it reads and writes only its widget (`update_widget`), so it
 * isn't long work by kind and goes on until the plan's own limit, as a reply does.
 */
export async function routineRunRefreshesWidget(db: Executor, runId: string) {
  const { routineRuns, routines } = schema;
  const [row] = await db
    .select({ target: sql<string | null>`${routines.target}->>'type'` })
    .from(routineRuns)
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(eq(routineRuns.agentRunId, runId))
    .limit(1);
  return row?.target === "widget";
}

/** `meta.actionCard` of a long-work pause's card (ADR 0118). Only the executor and Continuar agora write it. */
export interface UsagePauseCard {
  kind: "usage_paused";
  /**
   * `ended`: the run ended paused (superseded, failed): nothing left to continue. `canceled`: someone said not to run
   * it ("Don't run it", or any stop while it waited).
   */
  state: "paused" | "continued" | "resumed" | "ended" | "canceled";
  runId: string;
  waitId: string;
  agentId: string;
  /** The person behind the work: with the agent's owner and admins, who may press Continuar agora. */
  forUserId: string | null;
  source: "plan" | "budget";
  percent: number;
  window?: string;
  plan: string;
  resetsAt?: string;
  continuedByUserId: string | null;
  continuedAt: string | null;
}

export const usagePauseCardOf = (meta: Record<string, unknown> | null | undefined): UsagePauseCard | null => {
  const card = meta?.actionCard as Partial<UsagePauseCard> | undefined;
  return card?.kind === "usage_paused" && typeof card.runId === "string" && typeof card.waitId === "string"
    ? (card as UsagePauseCard)
    : null;
};

/** The paused run picked up by itself (the window reset, or room again): its card says so, once. */
export const usageCardResumed = (deps: { db: Database; pubsub?: PubSub }, orgId: string, messageId: string) =>
  setUsageCardState(deps, orgId, messageId, "resumed");

/** Moves a card still `paused` to `state`, once. */
async function setUsageCardState(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  messageId: string,
  state: "resumed" | "ended" | "continued",
  fields: Partial<UsagePauseCard> = {},
) {
  const { messages } = schema;
  const next = JSON.stringify({ ...fields, state });
  const [row] = await deps.db
    .update(messages)
    .set({ meta: sql`jsonb_set(${messages.meta}, '{actionCard}', (${messages.meta}->'actionCard') || ${next}::jsonb)` })
    .where(
      and(
        eq(messages.orgId, orgId),
        eq(messages.id, messageId),
        sql`${messages.meta}->'actionCard'->>'state' = 'paused'`,
      ),
    )
    .returning();
  if (row && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(row));
}

/**
 * Where a run's usage note can be (the messages' partitions): a run that took a note over (`usageNoteHandOn`) started
 * after it, within the longest wait (a month's budget).
 */
const noteSince = (run: { createdAt: Date }) =>
  sql`${schema.messages.createdAt} >= ${new Date(run.createdAt.getTime() - 35 * 24 * 3600_000).toISOString()}::timestamptz`;

/**
 * A run's "I'll answer when it resets" note while it is back at work (`ended`: true) or parked on it again (false):
 * "Don't run it" shows only while it waits, never stopping a live answer or a run already over.
 */
export async function usageWaitNoteEnded(
  deps: { db: Database; pubsub?: PubSub },
  run: { id: string; orgId: string; channelId: string; createdAt: Date },
  ended: boolean,
  /** Parked again: when the limit resets now (null: unknown), so the note's promise stays true. */
  resetsAt?: string | null,
) {
  const { messages } = schema;
  const reset =
    resetsAt === undefined
      ? sql`${messages.meta}`
      : resetsAt === null
        ? sql`${messages.meta} #- '{usageWait,resetsAt}'`
        : sql`jsonb_set(${messages.meta}, '{usageWait,resetsAt}', to_jsonb(${resetsAt}::text))`;
  const rows = await deps.db
    .update(messages)
    .set({
      meta: ended
        ? sql`jsonb_set(${messages.meta}, '{usageWait,ended}', 'true'::jsonb)`
        : sql`(${reset}) #- '{usageWait,ended}'`,
    })
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        noteSince(run),
        sql`${messages.meta}->'usageWait'->>'runId' = ${run.id}`,
        sql`${messages.meta}->'usageWait'->'canceled' is null`,
        ended
          ? sql`${messages.meta}->'usageWait'->'ended' is null`
          : resetsAt === undefined
            ? sql`${messages.meta}->'usageWait'->'ended' is not null`
            : sql`(${messages.meta}->'usageWait'->'ended' is not null
              or ${messages.meta}->'usageWait'->>'resetsAt' is distinct from ${resetsAt}::text)`,
      ),
    )
    .returning();
  if (deps.pubsub) for (const row of rows) await publishMessageCreated(deps.pubsub, messageView(row));
}

/**
 * A catch-up the check closed (`catch-up-triage.ts`): its note says why instead of its promise (`usageWait.closed`), with
 * "Responder mesmo assim" for who asked, the agent's owner and admins. Returns the note, for the notices to open.
 */
export async function usageWaitClosed(
  deps: { db: Database; pubsub?: PubSub },
  run: { id: string; orgId: string; channelId: string; createdAt: Date },
  closed: Record<string, unknown>,
): Promise<{ id: string; threadId: string | null } | null> {
  const { messages } = schema;
  const rows = await deps.db
    .update(messages)
    .set({
      meta: sql`jsonb_set(${messages.meta}, '{usageWait}', (${messages.meta}->'usageWait')
        || jsonb_build_object('ended', true, 'closed', ${JSON.stringify(closed)}::jsonb))`,
    })
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        noteSince(run),
        sql`${messages.meta}->'usageWait'->>'runId' = ${run.id}`,
        sql`${messages.meta}->'usageWait'->'canceled' is null`,
        sql`${messages.meta}->'actionCard' is null`,
      ),
    )
    .returning();
  if (deps.pubsub) for (const row of rows) await publishMessageCreated(deps.pubsub, messageView(row));
  return rows[0] ?? null;
}

/**
 * A catch-up ended without a turn (closed by the check): the next one in its line goes now instead of leaving a dead
 * minute. Only while the line drains: a next one timed further than the line's own spacing waits for another reset (a
 * second hit re-timed it) or for its head (an unknown reset), and keeps its time.
 */
export async function wakeNextInLine(
  db: Executor,
  orgId: string,
  key: string,
  model: string | null | undefined,
  now = Date.now(),
): Promise<string | null> {
  const rows = await lineRows(db, orgId, key);
  const next = rows.find((r) => sameReset(r, model));
  if (!next) return null;
  const { outbox } = schema;
  const moved = await db
    .update(outbox)
    .set({ nextAttemptAt: new Date(now) })
    .where(
      and(
        eq(outbox.kind, "agent_run.execute"),
        eq(outbox.status, "pending"),
        sql`${outbox.payload} ? 'wait' and ${outbox.payload}->>'runId' = ${next.id}`,
        sql`${outbox.nextAttemptAt} <= ${new Date(now + RESUME_AFTER_MS + RESUME_GAP_MS * (rows.length + 1)).toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: outbox.id });
  return moved.length > 0 ? next.id : null;
}

/** A note cancelled this recently still speaks for its conversation: a new ask there shows only its receipt. */
export const CANCELED_NOTE_QUIET_MS = 15 * 60_000;

/**
 * One "I'll answer when it resets" note per agent, conversation, person and wait. When the agent's word in this
 * conversation (`threadId`: a thread, or null for the main timeline) since it last said anything else holds a note to
 * the same person (`forUserId`: only who asked can stop it) on the same limit (`code`, a reset within a minute of
 * `resetsAt`, or both unknown) whose run isn't back at work, a newly parked turn posts none: a note still waiting
 * takes the turn in (`usageWait.runIds`, its "Don't run it" stops them all) and comes back to be published; one
 * cancelled less than `CANCELED_NOTE_QUIET_MS` ago stays as it is (`note: null`), the turn's receipt says it waits.
 * Null: the turn posts its own note.
 */
export async function joinUsageNote(
  tx: Executor,
  run: { id: string; orgId: string; agentId: string; channelId: string },
  threadId: string | null,
  forUserId: string | null,
  code: string,
  resetsAt: string | undefined,
  now = Date.now(),
): Promise<{ note: Message | null } | null> {
  const { messages } = schema;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`usage-note:${run.agentId}:${run.channelId}:${threadId ?? ""}`}))`,
  );
  // ponytail: looks back 20 messages; a longer run of notes to other people just posts a new note.
  const recent = await tx
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        eq(messages.authorAgentId, run.agentId),
        sql`${messages.threadId} is not distinct from ${threadId}::uuid and ${messages.deletedAt} is null`,
        // "Told it to stop" and the other notices the agent reads aren't its word in the conversation.
        sql`${messages.meta}->'notice' is null`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(20);
  type Wait = {
    code?: string;
    forUserId?: string | null;
    resetsAt?: string;
    ended?: boolean;
    canceled?: boolean;
    canceledAt?: string;
  };
  const waitOf = (m: Message) => (m.meta.actionCard ? undefined : (m.meta.usageWait as Wait | undefined));
  // Its notes to other people in a channel don't end its word to this one; anything else it said does.
  const stop = recent.findIndex((m) => !waitOf(m) || (waitOf(m)?.forUserId ?? null) === forUserId);
  const last = stop < 0 ? undefined : recent[stop];
  const w = last && waitOf(last);
  if (!last || !w || w.code !== code || w.ended) return null;
  const sameReset =
    w.resetsAt && resetsAt
      ? Math.abs(Date.parse(w.resetsAt) - Date.parse(resetsAt)) < 60_000
      : !w.resetsAt && !resetsAt;
  if (!sameReset) return null;
  if (w.canceled) return now - Date.parse(w.canceledAt ?? "") < CANCELED_NOTE_QUIET_MS ? { note: null } : null;
  const [note] = await tx
    .update(messages)
    .set({
      meta: sql`jsonb_set(${messages.meta}, '{usageWait,runIds}',
        coalesce(${messages.meta}->'usageWait'->'runIds', '[]'::jsonb) || to_jsonb(${run.id}::text))`,
    })
    .where(and(eq(messages.id, last.id), inMillisecondOf(messages.createdAt, last.createdAt)))
    .returning();
  return { note: note ?? null };
}

/**
 * A run waiting on its plan or budget was stopped ("Don't run it", or any stop while it waited): what said it would run
 * later says it won't, quietly: its note (`meta.usageWait.canceled`, with when) and its long-work card (`canceled`).
 * Returns the turns its note took in (`joinUsageNote`): "Don't run it" stops them too.
 */
export async function usageWaitCanceled(
  deps: { db: Database; pubsub?: PubSub },
  run: { id: string; orgId: string; channelId: string; createdAt: Date },
): Promise<string[]> {
  const { messages } = schema;
  const card = sql`coalesce(${messages.meta}->'actionCard'->>'kind', '') = 'usage_paused'`;
  const rows = await deps.db
    .update(messages)
    .set({
      meta: sql`case when ${card}
        then jsonb_set(${messages.meta}, '{actionCard,state}', '"canceled"'::jsonb)
        else jsonb_set(${messages.meta}, '{usageWait}', (${messages.meta}->'usageWait')
          || jsonb_build_object('canceled', true, 'canceledAt', ${new Date().toISOString()}::text)) end`,
    })
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        noteSince(run),
        sql`((${card} and ${messages.meta}->'actionCard'->>'runId' = ${run.id} and ${messages.meta}->'actionCard'->>'state' = 'paused')
          or (not ${card} and ${messages.meta}->'usageWait'->>'runId' = ${run.id} and ${messages.meta}->'usageWait'->'canceled' is null))`,
      ),
    )
    .returning();
  if (deps.pubsub) for (const row of rows) await publishMessageCreated(deps.pubsub, messageView(row));
  return rows.flatMap((r) => {
    const ids = (r.meta.usageWait as { runIds?: unknown } | undefined)?.runIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  });
}

/**
 * Continuar agora's step on a paused run (the card's and Rotinas'): once per wait (a compare-and-set on its wait id
 * with no override yet), it goes on past the pause line until `until` (the window's reset; null: until it ends) and
 * is queued now. Audited as `usage.continued`. False: the run already moved on (a second press, the timed job).
 */
export async function overrideUsagePause(
  tx: Executor,
  p: {
    orgId: string;
    runId: string;
    waitId: string;
    until: string | null;
    userId: string;
    details: Record<string, unknown>;
    channelId?: string | null;
    /** Told in the chat (`grantUsageOverride`): the run keeps going past the line for good (`usageGrant`). */
    grant?: boolean;
  },
): Promise<boolean> {
  const { agentRuns } = schema;
  const override = { until: p.until, by: p.userId };
  const grant = p.grant ? { usageGrant: { by: p.userId, at: new Date().toISOString() } } : {};
  const [moved] = await tx
    .update(agentRuns)
    .set({
      transcript: sql`${agentRuns.transcript} || jsonb_build_object('usagePause',
        coalesce(${agentRuns.transcript}->'usagePause', '{}'::jsonb) || jsonb_build_object('override', ${JSON.stringify(override)}::jsonb))
        || ${JSON.stringify(grant)}::jsonb`,
    })
    .where(
      and(
        eq(agentRuns.orgId, p.orgId),
        eq(agentRuns.id, p.runId),
        eq(agentRuns.status, "waiting_input"),
        sql`${agentRuns.transcript}->'waitingForBrain'->>'waitId' = ${p.waitId}`,
        sql`${agentRuns.transcript}->'usagePause'->'override' is null`,
      ),
    )
    .returning({ id: agentRuns.id });
  if (!moved) return false;
  await enqueue(tx, {
    orgId: p.orgId,
    kind: "agent_run.execute",
    payload: { runId: p.runId, wait: p.waitId },
    dedupeKey: `agent_run.execute:${p.runId}:continue:${p.waitId}`,
    maxAttempts: 4,
  });
  await recordAudit(tx, {
    orgId: p.orgId,
    actor: { type: "person", id: p.userId },
    action: "usage.continued",
    target: { type: "agent_run", id: p.runId },
    details: { ...p.details, until: p.until },
    ...(p.channelId ? { channelId: p.channelId } : {}),
  });
  return true;
}

/**
 * Who may press Continuar agora on a paused run: the card's people (`mayStopRun`) and, for a routine's run, Rotinas'
 * (its creator, whoever manages that agent's routines: `managesRoutinesOf`, ADR 0085 addendum of 2026-11-17). The
 * agent is the run's own, even when its routine moved to another since: `row.agent`, its `ACCESS_COLUMNS` when the
 * caller's select has them (a caller checking many runs passes them), else read here once for both rules.
 */
export async function mayContinuePause(
  db: Executor,
  userId: string,
  membership: Membership,
  row: Parameters<typeof mayStopRun>[3] & {
    routineId: string | null;
    routineCreatorId: string | null;
    agent?: AgentAccessFields;
  },
) {
  if (!row.routineId) return mayStopRun(db, userId, membership, row);
  if (row.routineCreatorId === userId) return true;
  const [agent] = row.agent
    ? [row.agent]
    : await db
        .select(ACCESS_COLUMNS)
        .from(schema.agents)
        .where(and(eq(schema.agents.orgId, row.run.orgId), eq(schema.agents.id, row.run.agentId)));
  if (agent && managesRoutinesOf(agent, userId, membership)) return true;
  return mayStopRun(db, userId, membership, { ...row, agent });
}

/**
 * Continuar agora on several paused runs at once (the task manager's line over them): each goes on as from its card or
 * Rotinas, so a run's pause may be refused alone (`assertMayContinuePause`) while the others go on, and a run's card
 * says who let it go on. Refused for all of them, the first refusal is thrown. Runs that moved on meanwhile are skipped.
 */
export async function continuePausedRuns(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  orgId: string,
  runIds: string[],
  options: { grant?: boolean } = {},
): Promise<{ continued: number }> {
  const { db } = deps;
  const { agentRuns, agents, messages, routineRuns, routines } = schema;
  const membership = await requireActiveMembership(db, userId, orgId);
  const rows = await db
    .select({
      run: {
        id: agentRuns.id,
        orgId: agentRuns.orgId,
        agentId: agentRuns.agentId,
        triggerMessageId: agentRuns.triggerMessageId,
      },
      // What `mayContinuePause` reads of each run's agent, read with the runs.
      agent: ACCESS_COLUMNS,
      ownerUserId: agents.ownerUserId,
      requester: runRequester,
      routineId: routines.id,
      routineCreatorId: routines.createdByUserId,
      cardId: sql<string | null>`${agentRuns.transcript}->'usagePause'->>'cardId'`,
      waitId: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'waitId'`,
      source: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'source'`,
      resetsAt: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'resetsAt'`,
    })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .leftJoin(messages, and(eq(messages.id, agentRuns.triggerMessageId), eq(messages.orgId, agentRuns.orgId)))
    .leftJoin(routineRuns, and(eq(routineRuns.agentRunId, agentRuns.id), eq(routineRuns.orgId, agentRuns.orgId)))
    .leftJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        inArray(agentRuns.id, runIds),
        eq(agentRuns.status, "waiting_input"),
        sql`${agentRuns.transcript}->'waitingForBrain'->>'code' = 'usage_pause'`,
      ),
    );
  let continued = 0;
  let refused: unknown = null;
  for (const row of rows) {
    if (!row.waitId) continue;
    try {
      if (!(await mayContinuePause(db, userId, membership, row)))
        throw new ForbiddenError("Only who asked, the agent's owner or an admin can do this", "run.answer_forbidden");
      await assertMayContinuePause(db, orgId, row.run.id, "run");
    } catch (error) {
      refused ??= error;
      continue;
    }
    const { waitId, resetsAt, source } = row;
    const moved = await db.transaction((tx) =>
      overrideUsagePause(tx, {
        orgId,
        runId: row.run.id,
        waitId: waitId as string,
        until: resetsAt,
        userId,
        details: { source: source ?? "plan", ...(options.grant ? { via: "chat" } : {}) },
        ...(options.grant ? { grant: true, until: null } : {}),
      }),
    );
    if (!moved) continue;
    continued++;
    if (row.cardId)
      await setUsageCardState(deps, orgId, row.cardId, "continued", {
        continuedByUserId: userId,
        continuedAt: new Date().toISOString(),
      });
  }
  if (continued === 0 && refused) throw refused;
  return { continued };
}

/**
 * A person told the agent in the chat to ignore its usage limit (`ignore_usage_limit`): the same people as Continuar
 * agora (`mayStopRun` on the run that heard it). That run goes past the pause line for good (`usageGrant`, audited as
 * `usage.continued` with `via: chat`), and so does each of the agent's paused runs the person may continue
 * (`continuePausedRuns`), up to the plan's own allowance. `granted` false: this person may not.
 */
export async function grantUsageOverride(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  orgId: string,
  agentId: string,
  runId: string,
): Promise<{ granted: boolean; continued: number }> {
  const { db } = deps;
  const { agentRuns, agents, messages } = schema;
  const membership = await requireActiveMembership(db, userId, orgId);
  const [row] = await db
    .select({ run: agentRuns, ownerUserId: agents.ownerUserId, requester: runRequester })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .leftJoin(messages, and(eq(messages.id, agentRuns.triggerMessageId), eq(messages.orgId, agentRuns.orgId)))
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId)));
  if (!row || !(await mayStopRun(db, userId, membership, row))) return { granted: false, continued: 0 };
  const grant = { by: userId, at: new Date().toISOString() };
  await db
    .update(agentRuns)
    .set({
      transcript: sql`${agentRuns.transcript} || jsonb_build_object('usageGrant', ${JSON.stringify(grant)}::jsonb)`,
    })
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId)));
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "usage.continued",
    target: { type: "agent_run", id: runId },
    details: { via: "chat", until: null },
    channelId: row.run.channelId,
  });
  const paused = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.agentId, agentId),
        eq(agentRuns.status, "waiting_input"),
        sql`${agentRuns.transcript}->'waitingForBrain'->>'code' = 'usage_pause'`,
      ),
    )
    .limit(100);
  const { continued } =
    paused.length > 0
      ? await continuePausedRuns(
          deps,
          userId,
          orgId,
          paused.map((r) => r.id),
          { grant: true },
        ).catch(() => ({ continued: 0 }))
      : { continued: 0 };
  return { granted: true, continued };
}

/**
 * Continuar agora on a long-work pause's card (`POST …/messages/{id}/answer-now`, ADR 0118): the run goes on now,
 * past the pause line until that window resets (the plan's own limit still stops it). Who asked, the person behind
 * the work, the agent's owner or an admin (`mayStopRun`); everyone else sees it greyed. Once: a second press, or
 * the run already back at work, starts nothing. Audited.
 */
export async function continueUsagePause(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  membership: Membership,
  message: Message,
  card: UsagePauseCard,
): Promise<{ runs: { agentId: string; runId: string }[] }> {
  const { db } = deps;
  const { agentRuns, agents, messages } = schema;
  const [row] = await db
    .select({ run: agentRuns, agent: REACH_COLUMNS, ownerUserId: agents.ownerUserId, requester: runRequester })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .leftJoin(messages, and(eq(messages.id, agentRuns.triggerMessageId), eq(messages.orgId, agentRuns.orgId)))
    .where(and(eq(agentRuns.orgId, message.orgId), eq(agentRuns.id, card.runId)));
  if (!row) return { runs: [] };
  if (!(await mayStopRun(db, userId, membership, row)))
    throw new ForbiddenError("Only who asked, the agent's owner or an admin can do this", "run.answer_forbidden");
  if (card.source !== "budget") await assertMayContinuePause(db, message.orgId, card.runId, "run");
  const until = card.resetsAt ?? null;
  const done = await db.transaction(async (tx) => {
    const moved = await overrideUsagePause(tx, {
      orgId: message.orgId,
      runId: card.runId,
      waitId: card.waitId,
      until,
      userId,
      details: { messageId: message.id, source: card.source, percent: card.percent },
      channelId: message.channelId,
    });
    if (!moved) return null;
    const next: UsagePauseCard = {
      ...card,
      state: "continued",
      continuedByUserId: userId,
      continuedAt: new Date().toISOString(),
    };
    const [updated] = await tx
      .update(messages)
      .set({ meta: sql`jsonb_set(${messages.meta}, '{actionCard}', ${JSON.stringify(next)}::jsonb)` })
      .where(and(eq(messages.orgId, message.orgId), eq(messages.id, message.id)))
      .returning();
    return updated ?? null;
  });
  if (!done) {
    // The run ended while paused: the card says so instead of offering a button that does nothing.
    if (isTerminal(row.run.status)) await setUsageCardState(deps, message.orgId, message.id, "ended");
    return { runs: [] };
  }
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(done));
  return { runs: [{ agentId: card.agentId, runId: card.runId }] };
}

/**
 * A run waiting on its plan or budget left the wait without a person saying not to run it (its turn ran and ended,
 * the system stopped it): its note speaks on for the turns it took in (`joinUsageNote`). The first of them still
 * waiting holds it now, its "Don't run it" back; with none waiting, a stopped run's note says it won't run
 * (`reason`: `archived` for an archived agent) and a finished one's stays as it is.
 */
export async function usageNoteHandOn(
  deps: { db: Database; pubsub?: PubSub },
  run: { id: string; orgId: string; channelId: string; createdAt: Date },
  stop?: { reason?: string },
) {
  const { agentRuns, messages } = schema;
  const notes = await deps.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        noteSince(run),
        sql`${messages.meta}->'usageWait'->>'runId' = ${run.id}`,
        sql`${messages.meta}->'usageWait'->'canceled' is null`,
        sql`${messages.meta}->'actionCard' is null`,
      ),
    );
  for (const note of notes) {
    const joined = (note.meta.usageWait as { runIds?: unknown }).runIds;
    const ids = Array.isArray(joined) ? joined.filter((id): id is string => typeof id === "string") : [];
    const live = ids.length
      ? (
          await deps.db
            .select({ id: agentRuns.id })
            .from(agentRuns)
            .where(and(inArray(agentRuns.id, ids), eq(agentRuns.status, "waiting_input")))
            .orderBy(agentRuns.createdAt)
        ).map((r) => r.id)
      : [];
    const [holder, ...rest] = live;
    const next = holder
      ? sql`((${messages.meta}->'usageWait') - 'ended') || jsonb_build_object('runId', ${holder}::text, 'runIds', ${JSON.stringify(rest)}::jsonb)`
      : stop
        ? sql`(${messages.meta}->'usageWait') || jsonb_build_object('canceled', true, 'canceledAt', ${new Date().toISOString()}::text${stop.reason ? sql`, 'reason', ${stop.reason}::text` : sql``})`
        : null;
    if (!next) continue;
    const [row] = await deps.db
      .update(messages)
      .set({ meta: sql`jsonb_set(${messages.meta}, '{usageWait}', ${next})` })
      .where(and(eq(messages.id, note.id), inMillisecondOf(messages.createdAt, note.createdAt)))
      .returning();
    if (row && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(row));
  }
}

/**
 * An archived agent's catch-ups won't run: each wait on its plan or budget stops now (a system stop, so each note
 * says why, `usageNoteHandOn`) instead of failing at the reset, days later.
 */
export async function stopAgentUsageWaits(deps: { db: Database; pubsub?: PubSub }, orgId: string, agentId: string) {
  const { agentRuns, channels } = schema;
  const { stopRun } = await import("./cancel");
  const rows = await deps.db
    .select({ run: agentRuns, channelKind: channels.kind })
    .from(agentRuns)
    .leftJoin(channels, eq(channels.id, agentRuns.channelId))
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.agentId, agentId),
        eq(agentRuns.status, "waiting_input"),
        sql`${agentRuns.transcript}->'waitingForBrain'->>'code' in ('plan_limit', 'budget', 'usage_pause')`,
      ),
    );
  for (const { run, channelKind } of rows) {
    await stopRun(deps, orgId, run, channelKind, { type: "system", reason: "agent_archived" }).catch(() => null);
  }
}

/**
 * The agent thinks with another AI account or model now: what waited on the old one's limit goes on, in line order,
 * 60 s apart, on the new sign-in (each claim reads the agent's brain again; one still limited parks in its new line).
 * Its computer waits go on too: one for a plan that isn't its owner's ends only with another account, and no
 * reconnect signals that. Not one whose cut-off turn already ran tools (another brain would run them again), nor a
 * routine's whose slot is stale (`missStaleRoutineRun`, as when its computer comes back).
 */
export async function wakeAgentUsageWaits(
  db: Database,
  orgId: string,
  agentId: string,
  options: { pubsub?: PubSub; now?: number; delayMs?: number } = {},
) {
  const { agentRuns } = schema;
  const now = options.now ?? Date.now();
  const start = now + (options.delayMs ?? 0);
  const found = await db
    .select({
      id: agentRuns.id,
      waitId: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'waitId'`,
      code: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'code'`,
      executed: sql<number>`coalesce(jsonb_array_length(${agentRuns.transcript}->'interruptedTurn'->'executed'), 0)`,
      cut: sql<string | null>`${agentRuns.transcript}->'interruptedTurn'->>'cause'`,
      background: agentRuns.background,
      workId: agentRuns.workId,
      since: waitSinceSql,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.agentId, agentId),
        eq(agentRuns.status, "waiting_input"),
        sql`${agentRuns.transcript} ? 'waitingForBrain'`,
      ),
    )
    .limit(500);
  const rows = found
    .filter(
      (r) => r.waitId && (USAGE_WAIT_CODES.has(r.code ?? "") || !turnStaysOnItsComputer(Number(r.executed), r.cut)),
    )
    .map((r) => ({ ...r, since: Number(r.since) }))
    .sort(inLineOrder);
  const woken: string[] = [];
  for (const r of rows) {
    // A usage wait's staleness is the executor's to judge (it names why it came too late).
    if (r.background && !USAGE_WAIT_CODES.has(r.code ?? "")) {
      if (await missStaleRoutineRun({ db, pubsub: options.pubsub }, r.id, new Date(now))) continue;
    }
    await enqueue(db, {
      orgId,
      kind: "agent_run.execute",
      payload: { runId: r.id, wait: r.waitId },
      dedupeKey: `agent_run.execute:${r.id}:switched:${r.waitId}`,
      runAt: new Date(start + woken.length * RESUME_GAP_MS),
      maxAttempts: 4,
    });
    woken.push(r.id);
  }
  return woken;
}

/**
 * A cut-off turn only its own computer may finish: tools already ran in it (another brain would redo them), or the
 * plan cut it after it worked, stored with no executed tools when the runner can't name them (a CLI's own tools).
 */
export const turnStaysOnItsComputer = (executed: number, cause: string | null | undefined) =>
  executed > 0 || cause === "plan_limit";

/**
 * Agents with a run waiting on an account it moved to at its plan's limit (`Transcript.accountMove`): when that account
 * goes or stops serving them, the run is woken (`wakeAgentsBrainWaits`) to go back to its agent's own.
 */
export async function agentsMovedOnto(db: Executor, orgId: string, accountIds: readonly string[]): Promise<string[]> {
  if (accountIds.length === 0) return [];
  const { agentRuns } = schema;
  const rows = await db
    .selectDistinct({ id: agentRuns.agentId })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.status, "waiting_input"),
        inArray(sql`${agentRuns.transcript}->'accountMove'->>'to'`, [...accountIds]),
      ),
    );
  return rows.map((r) => r.id);
}

/** After what these agents think with changed (their AI, account or computer): `wakeAgentUsageWaits` for each. */
export async function wakeAgentsBrainWaits(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  agentIds: string[],
  options: { delayMs?: number } = {},
) {
  for (const id of new Set(agentIds)) {
    await wakeAgentUsageWaits(deps.db, orgId, id, { pubsub: deps.pubsub, ...options }).catch(() => null);
  }
}
