import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, eq, inArray, isNull, lt, ne, schema, sql } from "@agenteschat/db";
import { stopRun } from "./cancel";
import { widgetRoutineHeld } from "./dashboards/refresh-ledger";
import { notifyRoutineStalled, notifyRoutineWaitingPlan } from "./notification-producers";
import { enqueue } from "./outbox";
import { deferEventRun } from "./routine-events";
import { endRoutineRun } from "./routine-ledger";
import { endOpenRoutineRun, pauseRoutine, ROUTINE_CATCH_UP_MS, routineJobAlive } from "./routine-state";
import type { AgentRun } from "./runs";

const { routines, routineRuns, agentRuns, agentRunSteps, machines } = schema;

type RoutineRow = typeof routines.$inferSelect;
type RunRow = typeof routineRuns.$inferSelect;
type AgentRunRow = typeof agentRuns.$inferSelect;
type FiringDeps = { db: Database; pubsub?: PubSub };

/*
 * Firing rules (ADR 0053 §6): the claim, one run at a time per routine, a computer that is away,
 * stopping a routine's work, and pausing the routines of a person who left.
 */

const ACTIVE_RUN: AgentRunRow["status"][] = ["queued", "running", "waiting_approval", "waiting_input"];

/**
 * A routine run that has shown nothing for this long is let go (§6.3): its work stopped in a call that
 * never came back, or it handed off and the turn left over it (its own record) never ended. It must stay above
 * the hub's `BRAIN_IDLE_TIMEOUT_MS` (15 minutes): a computer's turn can be silent that long, and its events
 * don't always write a step, so a live turn is never let go before the hub itself would fail it.
 */
export const ROUTINE_STALL_MS = 20 * 60_000;

/** A working run's last sign of work: its row's change, or its newest step (a tool call, a turn's save). */
const lastWork = sql`greatest(${agentRuns.updatedAt}, coalesce((select max(${agentRunSteps.createdAt}) from ${agentRunSteps} where ${agentRunSteps.runId} = ${agentRuns.id}), ${agentRuns.updatedAt}))`;

/** Whether nothing moved in a run since `now` minus `ROUTINE_STALL_MS` (a timestamp, read as the driver gives it). */
const goneQuiet = (work: unknown, now: Date) => {
  const at = work instanceof Date ? work : typeof work === "string" ? new Date(work) : null;
  return at !== null && !Number.isNaN(at.getTime()) && now.getTime() - at.getTime() >= ROUTINE_STALL_MS;
};

const waitingToStart = (event: unknown) => {
  const e = event as Record<string, unknown> | null;
  return e?.gathered === true || e?.held === true;
};

/**
 * Takes a routine run for its `routine.run` job (§6.1): `queued` → `starting`, atomically, so two
 * workers never start it twice. A retried job takes back the row it claimed but never started (its
 * worker died, or a transient error gave it back). Runs waiting to start (gathered, held) have no
 * job and are never claimed. Null: nothing to do (already started, ended or not found).
 */
export async function claimRoutineRun(db: Database, routineRunId: string): Promise<RunRow | null> {
  const [row] = await db
    .update(routineRuns)
    .set({
      status: "starting",
      // What it waited behind (`queueBehindAgentRoutine`) is no event: the run's context would show it as one.
      event: sql`case when ${routineRuns.event}->>'waitingFor' is null then ${routineRuns.event}
        else nullif(${routineRuns.event} - 'waitingFor', '{}'::jsonb) end`,
    })
    .where(
      and(
        eq(routineRuns.id, routineRunId),
        sql`(${routineRuns.status} = 'queued' or (${routineRuns.status} = 'starting' and ${routineRuns.agentRunId} is null))`,
        sql`coalesce(${routineRuns.event}->>'gathered', '') <> 'true'`,
        sql`coalesce(${routineRuns.event}->>'held', '') <> 'true'`,
      ),
    )
    .returning();
  return row ?? null;
}

/** A transient error after the claim: the row goes back to the queue and the job retries it. */
export async function unclaimRoutineRun(db: Database, routineRunId: string) {
  await db
    .update(routineRuns)
    .set({ status: "queued" })
    .where(and(eq(routineRuns.id, routineRunId), eq(routineRuns.status, "starting"), isNull(routineRuns.agentRunId)));
}

/** The slot never started a run (deleted, paused, the previous one still working…). */
export const skipRoutineRun = (db: Database, routineRunId: string, code: string) =>
  endOpenRoutineRun(db, routineRunId, { status: "skipped", code });

/**
 * Ends an open routine run and, when its agent run still works, stops that run quietly (nothing is
 * posted: a background run never speaks on a stop). The ledger is closed first, so its code wins.
 * A run being started as the caller read the row (no agent run yet) is read again once the ledger
 * closed: when its start won the race, the agent run it got is stopped too.
 */
async function endWithRun(
  deps: FiringDeps,
  rr: Pick<RunRow, "id" | "orgId" | "routineId">,
  seen: AgentRunRow | null,
  end: { status: "canceled" | "superseded" | "missed"; code: string; byUserId?: string | null },
) {
  await endRoutineRun(deps, { orgId: rr.orgId, routineId: rr.routineId, routineRunId: rr.id }, end);
  const ar = seen ?? (await agentRunOfRoutineRun(deps.db, rr.id));
  if (ar && ACTIVE_RUN.includes(ar.status)) {
    const actor = end.byUserId
      ? ({ type: "person", id: end.byUserId } as const)
      : ({ type: "system", reason: `routine_${end.code}` } as const);
    await stopRun(deps, ar.orgId, ar, "dm", actor).catch(() => null);
  }
}

/** The agent run a routine run started, read now. */
async function agentRunOfRoutineRun(db: Database, routineRunId: string): Promise<AgentRunRow | null> {
  const [row] = await db
    .select({ ar: agentRuns })
    .from(routineRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, routineRuns.agentRunId))
    .where(eq(routineRuns.id, routineRunId));
  return row?.ar ?? null;
}

/**
 * A routine's run waits for the agent's computer: its creator and the agent's owner hear it once per
 * outage. An outage lasts until a run of the routine really runs again (it reports, stays silent or
 * fails on its own), whatever the computer does meanwhile: one that is online but can't take the turn
 * (an old runner, its plan's limit, signed out) stays connected, and must not notify every slot.
 */
async function stalled(deps: FiringDeps, routineId: string, orgId: string, machineId: string) {
  const [m] = await deps.db.select({ name: machines.name }).from(machines).where(eq(machines.id, machineId));
  await notifyRoutineStalled(deps, {
    orgId,
    routineId,
    machineId,
    machineName: m?.name ?? "",
    outageKey: await outageKey(deps, routineId),
  }).catch(() => {});
}

/** An outage of a routine lasts until one of its runs really runs again: the last such run names it. */
async function outageKey(deps: FiringDeps, routineId: string) {
  const [ran] = await deps.db
    .select({ id: routineRuns.id })
    .from(routineRuns)
    .where(and(eq(routineRuns.routineId, routineId), inArray(routineRuns.status, ["reported", "silent", "failed"])))
    .orderBy(desc(routineRuns.createdAt))
    .limit(1);
  return ran?.id ?? "none";
}

/** A background run started waiting for its agent's plan to reset: the routine's people hear it once per outage. */
export async function routineRunWaitingForPlan(deps: FiringDeps, run: Pick<AgentRun, "id" | "orgId" | "background">) {
  if (!run.background) return;
  const [rr] = await deps.db
    .select({ routineId: routineRuns.routineId })
    .from(routineRuns)
    .where(and(eq(routineRuns.orgId, run.orgId), eq(routineRuns.agentRunId, run.id)));
  if (!rr) return;
  await notifyRoutineWaitingPlan(deps, {
    orgId: run.orgId,
    routineId: rr.routineId,
    outageKey: await outageKey(deps, rr.routineId),
  }).catch(() => {});
}

/**
 * A background run started waiting for its computer (§6.4; the engine calls this when it parks a
 * background run on `waiting_input` for a machine): the routine's people hear it once per outage.
 */
export async function routineRunWaitingForComputer(
  deps: FiringDeps,
  run: Pick<AgentRun, "id" | "orgId" | "background">,
  machineId: string,
) {
  if (!run.background) return;
  const [rr] = await deps.db
    .select({ routineId: routineRuns.routineId })
    .from(routineRuns)
    .where(and(eq(routineRuns.orgId, run.orgId), eq(routineRuns.agentRunId, run.id)));
  if (rr) await stalled(deps, rr.routineId, run.orgId, machineId);
}

/**
 * One run at a time per routine (§6.3, §6.4), checked when a slot starts. Earlier runs still open:
 * - queued with a live job, or being started, or working: the slot is `skipped` (`previous_running`);
 * - waiting for the agent's computer: it gives way (`superseded`, `waiting_computer`), the freshest
 *   slot is the one that runs when the computer is back, and the routine's people hear it once;
 * - waiting for a person (an approval, an answer) since before the previous slot: it gives way
 *   (`superseded`; its approvals expire); a newer wait keeps it and the slot is `previous_waiting`;
 * - handed off already: its report is out, so the turn left of it holds nothing, and neither does a
 *   run that stopped moving (`ROUTINE_STALL_MS`: it is let go as `stalled`).
 * An event run never replaces another: it waits for the one working to end (gathered again). It only
 * waits on its own line (`event.line`, ADR 0106's grouped calls): other lines run beside it.
 * Returns null when the run may start, else the code it was skipped with (or `gathered`).
 */
export async function makeWayForRun(
  deps: FiringDeps,
  routine: RoutineRow,
  run: RunRow,
  now = new Date(),
): Promise<string | null> {
  const { db } = deps;
  const event = run.trigger === "event";
  const line = typeof run.event?.line === "string" ? run.event.line : "";
  const earlier = await db
    .select({ rr: routineRuns, ar: agentRuns, alive: routineJobAlive(routineRuns.id), work: lastWork })
    .from(routineRuns)
    .leftJoin(agentRuns, eq(agentRuns.id, routineRuns.agentRunId))
    .where(
      and(
        eq(routineRuns.routineId, routine.id),
        ne(routineRuns.id, run.id),
        inArray(routineRuns.status, ["queued", "starting", "started", "reported"]),
        isNull(routineRuns.finishedAt),
        sql`(${routineRuns.createdAt}, ${routineRuns.id}) < (${run.createdAt.toISOString()}::timestamptz, ${run.id}::uuid)`,
        event ? sql`coalesce(${routineRuns.event}->>'line', '') = ${line}` : undefined,
      ),
    )
    .orderBy(routineRuns.createdAt);
  const blocked = async (code: string) => {
    if (!event) return code;
    await deferEventRun(deps, run);
    return "gathered";
  };
  for (const { rr, ar, alive, work } of earlier) {
    if (rr.status === "queued") {
      // Waiting to start has no job on purpose; a queued run whose job died is the reaper's.
      if (!waitingToStart(rr.event) && alive) return blocked("previous_running");
      continue;
    }
    if (rr.status === "starting") return blocked("previous_running");
    // It already handed off: its report is out, and the turn left of it (its own record) is not the
    // routine's work. Holding the slot on it is how one stuck turn stopped a whole routine.
    if (rr.status === "reported") continue;
    // Its agent run ended and the ledger lags behind: the reaper closes it; it holds nothing.
    if (!ar || !ACTIVE_RUN.includes(ar.status)) continue;
    // Working, but nothing has moved in it for `ROUTINE_STALL_MS`: it is let go and this slot runs.
    if (ar.status === "running" && goneQuiet(work, now)) {
      await endWithRun(deps, rr, ar, { status: "canceled", code: "stalled" });
      continue;
    }
    if (ar.status === "queued" || ar.status === "running") return blocked("previous_running");
    if (event) return blocked("previous_running");
    // Waiting for its plan's limit or its budget: the freshest slot runs once there's room again.
    const usageWait = (ar.transcript as { waitingForBrain?: { code?: string; source?: string } } | null)
      ?.waitingForBrain;
    const usageCode = usageWait?.code === "usage_pause" ? usageWait.source : usageWait?.code;
    if (
      ar.status === "waiting_input" &&
      (usageCode === "plan_limit" || usageCode === "plan" || usageCode === "budget")
    ) {
      await endWithRun(deps, rr, ar, {
        status: "superseded",
        code: usageCode === "budget" ? "waiting_budget" : "waiting_plan",
      });
      continue;
    }
    // In line for room on an online computer: it keeps its place and this slot gives way.
    if (ar.status === "waiting_input" && usageWait?.code === "busy") return blocked("previous_waiting");
    if (ar.status === "waiting_input" && ar.waitingMachineId) {
      await endWithRun(deps, rr, ar, { status: "superseded", code: "waiting_computer" });
      await stalled(deps, routine.id, routine.orgId, ar.waitingMachineId);
      continue;
    }
    // Waiting for a person: since before the slot before this one, it gives way.
    const [previousSlot] = await db
      .select({ at: routineRuns.at })
      .from(routineRuns)
      .where(and(eq(routineRuns.routineId, routine.id), ne(routineRuns.id, run.id), lt(routineRuns.at, run.at)))
      .orderBy(desc(routineRuns.at))
      .limit(1);
    if (previousSlot && ar.updatedAt.getTime() < previousSlot.at.getTime()) {
      await endWithRun(deps, rr, ar, { status: "superseded", code: "superseded" });
      continue;
    }
    return blocked("previous_waiting");
  }
  return null;
}

/** How long a scheduled run waits behind another routine of its agent before it starts anyway. */
export const AGENT_QUEUE_MS = 30 * 60_000;
/** How often a run waiting behind another routine of its agent looks again. */
export const AGENT_QUEUE_POLL_MS = 60_000;

/**
 * One routine of an agent at a time on schedule: a scheduled run whose agent is working on another routine's run
 * goes back in line (`queued`, `event.waitingFor` names that routine for Rotinas) and looks again every
 * `AGENT_QUEUE_POLL_MS`, for at most `AGENT_QUEUE_MS` after its slot; then it starts beside it. Two runs of one
 * agent at once shared its computer and its temp files. A manual or event run never waits here. Returns whether it
 * went back in line.
 */
export async function queueBehindAgentRoutine(
  deps: FiringDeps,
  routine: Pick<RoutineRow, "id" | "orgId" | "agentId">,
  run: Pick<RunRow, "id" | "orgId" | "trigger" | "at">,
  now = new Date(),
): Promise<boolean> {
  if (run.trigger !== "schedule" || now.getTime() - run.at.getTime() >= AGENT_QUEUE_MS) return false;
  const [busy] = await deps.db
    .select({ name: routines.name })
    .from(routineRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, routineRuns.agentRunId))
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(
      and(
        eq(routineRuns.orgId, run.orgId),
        eq(routineRuns.status, "started"),
        isNull(routineRuns.finishedAt),
        ne(routineRuns.routineId, routine.id),
        eq(agentRuns.agentId, routine.agentId),
        inArray(agentRuns.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (!busy) return false;
  return deps.db.transaction(async (tx) => {
    const [back] = await tx
      .update(routineRuns)
      .set({
        status: "queued",
        event: sql`coalesce(${routineRuns.event}, '{}'::jsonb) || jsonb_build_object('waitingFor', ${busy.name}::text)`,
      })
      .where(and(eq(routineRuns.id, run.id), eq(routineRuns.status, "starting"), isNull(routineRuns.agentRunId)))
      .returning({ id: routineRuns.id });
    if (!back) return false;
    await enqueue(tx, {
      orgId: run.orgId,
      kind: "routine.run",
      payload: { routineRunId: run.id },
      dedupeKey: `routine.run:${run.id}:after:${now.getTime()}`,
      runAt: new Date(now.getTime() + AGENT_QUEUE_POLL_MS),
      maxAttempts: 3,
    });
    return true;
  });
}

/**
 * The sweep's side of the same rule (§6.3): a routine run left working with nothing moving is let go
 * (`canceled`, `stalled`) even when no new slot wants its place, so its slot, the run strip and the
 * routine's card end it instead of showing it running for a turn that never comes back. A run that
 * already reported keeps that as its ending (the ledger keeps `reported` whatever ends it after).
 * Returns how many it released.
 */
export async function releaseStalledRoutineRuns(deps: FiringDeps, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - ROUTINE_STALL_MS);
  const rows = await deps.db
    .select({ rr: routineRuns, ar: agentRuns })
    .from(routineRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, routineRuns.agentRunId))
    .where(
      and(
        inArray(routineRuns.status, ["started", "reported"]),
        isNull(routineRuns.finishedAt),
        eq(agentRuns.status, "running"),
        sql`${lastWork} < ${before.toISOString()}::timestamptz`,
      ),
    )
    .limit(100);
  for (const { rr, ar } of rows) {
    await endWithRun(deps, rr, ar, { status: "canceled", code: "stalled" }).catch(() => {});
  }
  return rows.length;
}

/**
 * The computer of a waiting routine run is back (§6.4): a run whose slot is more than 12 hours old
 * no longer runs; it is `missed` (`stale`) and its agent run ends quietly. Returns whether it was.
 */
export async function missStaleRoutineRun(
  deps: FiringDeps,
  agentRunId: string,
  now = new Date(),
  /** Why it came too late: its computer (`stale`), or its plan or budget (`waiting_plan_late`, `waiting_budget_late`). */
  code = "stale",
): Promise<boolean> {
  const [row] = await deps.db
    .select({ rr: routineRuns, ar: agentRuns })
    .from(routineRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, routineRuns.agentRunId))
    .where(
      and(
        eq(routineRuns.agentRunId, agentRunId),
        inArray(routineRuns.status, ["started", "reported"]),
        isNull(routineRuns.finishedAt),
      ),
    );
  if (!row?.ar.background || row.rr.at.getTime() > now.getTime() - ROUTINE_CATCH_UP_MS) return false;
  await endWithRun(deps, row.rr, row.ar, { status: "missed", code });
  return true;
}

/**
 * Stops a routine's work in progress (§6.7): its open runs end `canceled` with `code` (`stopped`,
 * `paused`, `deleted`, `creator_left`; `byUserId`: who stopped it) and their agent runs are canceled
 * quietly. Runs waiting to start for its events are canceled too (their emails wait for the next
 * run); emails held for the next email stay. Returns how many runs it stopped.
 */
export async function haltRoutineRuns(
  deps: FiringDeps,
  orgId: string,
  routineId: string,
  end: { code: string; byUserId?: string | null },
): Promise<number> {
  const open = await deps.db
    .select({ rr: routineRuns, ar: agentRuns })
    .from(routineRuns)
    .leftJoin(agentRuns, eq(agentRuns.id, routineRuns.agentRunId))
    .where(
      and(
        eq(routineRuns.orgId, orgId),
        eq(routineRuns.routineId, routineId),
        inArray(routineRuns.status, ["queued", "starting", "started", "reported"]),
        isNull(routineRuns.finishedAt),
      ),
    )
    // Not yet started first: a run gathered behind the one stopped never starts from its ending.
    .orderBy(sql`${routineRuns.agentRunId} is not null`, routineRuns.createdAt);
  let stopped = 0;
  for (const { rr, ar } of open) {
    const event = rr.event as Record<string, unknown> | null;
    if (rr.status === "queued" && event?.held === true) continue;
    // A run that handed off and ended is the reaper's; one that still works is stopped.
    if (rr.status === "reported" && (!ar || !ACTIVE_RUN.includes(ar.status))) continue;
    await endWithRun(deps, rr, ar, { status: "canceled", code: end.code, byUserId: end.byUserId ?? null });
    stopped++;
  }
  return stopped;
}

/**
 * A person left the organization (§6.2): their routines pause at once (`creator_left`, the agent's
 * owner hears it and can take them over) and their work in progress stops. An agent was archived: its
 * routines pause the same way (`agent_archived`), so the list says it at once, not at their next slot.
 */
export async function pauseRoutinesOf(
  deps: FiringDeps,
  orgId: string,
  of: { creatorUserId: string } | { agentId: string },
): Promise<number> {
  const [whose, reason] =
    "agentId" in of
      ? [eq(routines.agentId, of.agentId), "agent_archived" as const]
      : [eq(routines.createdByUserId, of.creatorUserId), "creator_left" as const];
  const rows = await deps.db
    .select()
    .from(routines)
    .where(and(eq(routines.orgId, orgId), whose, eq(routines.active, true), isNull(routines.deletedAt)));
  for (const r of rows) {
    await pauseRoutine(deps, r, reason);
    await haltRoutineRuns(deps, orgId, r.id, { code: reason });
    // A widget's routine says it on its widget now, not at its next Resolve (ADR 0135 §6).
    if ((r.target as { type?: unknown } | null)?.type === "widget") {
      await widgetRoutineHeld(deps, r, reason).catch(() => {});
    }
  }
  return rows.length;
}
