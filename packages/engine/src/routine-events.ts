import {
  and,
  type Database,
  desc,
  type Executor,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  schema,
  sql,
} from "@agenteschat/db";
import { cutText } from "./format";
import { enqueue } from "./outbox";
import { routineJobAlive } from "./routine-state";

const { routines, routineRuns, agentRuns, routineHookCalls, routineHooks, agents, machines } = schema;

type RoutineRow = typeof routines.$inferSelect;

/**
 * Events that fire routines (ADR 0053 §6.3, §6.5, §6.8): a routine's events wait in one line, one run
 * at a time, so an event that arrives while one of its runs is queued joins that run's event; while one
 * works, events gather in a waiting run (`event.gathered`, no job yet) that starts when it ends. A
 * webhook routine that groups its calls (ADR 0106, addendum of 2026-11-21) has a line per group
 * (`event.line`): lines run side by side, up to `routineLineCap`, each one run at a time and in order.
 * Emails of a run that failed or was stopped wait in a held run (`event.held`) that the next email
 * starts. An event with a dedupe key (a provider's delivery id, an issue id) never fires a routine twice.
 */

/** At most this many events go into one run (the rest are only counted). */
export const MAX_EVENTS_PER_RUN = 20;

/** An event as a routine run keeps it (`routine_runs.event`). */
export type RoutineEventPayload = Record<string, unknown> & { type: string; summary: string };

/** How an incoming event joins the event of a run that hasn't started yet. */
export type EventMerge = (
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
) => Record<string, unknown>;

const FLAGS = ["gathered", "held", "line", "events", "extra", "dedupeKeys", "summary", "type"];
const one = (e: Record<string, unknown>) => Object.fromEntries(Object.entries(e).filter(([k]) => !FLAGS.includes(k)));
const listOf = (e: Record<string, unknown>) =>
  Array.isArray(e.events) ? (e.events as Record<string, unknown>[]) : [{ summary: String(e.summary ?? ""), ...one(e) }];
const countOf = (e: Record<string, unknown>) => (typeof e.extra === "number" ? e.extra : 0);

/** Events of any kind, merged into one list (newest last, the oldest dropped past the cap) and one summary. */
export const mergeEvents: EventMerge = (current, incoming) => {
  const all = [...listOf(current), ...listOf(incoming)];
  const kept = all.slice(-MAX_EVENTS_PER_RUN);
  const extra = countOf(current) + countOf(incoming) + all.length - kept.length;
  const lines = kept.map((e) => `- ${cutText(String(e.summary ?? ""), 300)}`);
  return {
    type: current.type ?? incoming.type,
    events: kept,
    extra,
    summary: [
      `${kept.length + extra} events since the last run (newest last):`,
      ...lines,
      ...(extra > 0 ? [`(and ${extra} older ones not listed)`] : []),
    ].join("\n"),
  };
};

const flag = (event: unknown, key: "gathered" | "held") =>
  Boolean(event && typeof event === "object" && (event as Record<string, unknown>)[key] === true);

/** The event with its waiting flags set (and its dedupe keys and line kept). */
function withState(
  event: Record<string, unknown>,
  keys: string[],
  state: { gathered?: boolean; held?: boolean; line?: string },
) {
  const { gathered: _g, held: _h, dedupeKeys: _k, line: was, ...rest } = event;
  const line = state.line ?? (typeof was === "string" ? was : "");
  return {
    ...rest,
    ...(keys.length > 0 ? { dedupeKeys: [...new Set(keys)] } : {}),
    ...(line ? { line } : {}),
    ...(state.gathered ? { gathered: true } : {}),
    ...(state.held ? { held: true } : {}),
  };
}

const waitingToStart = (event: unknown) => flag(event, "gathered") || flag(event, "held");

/** A run's line: its group's key, '' for the routine's one line. */
const lineSql = sql<string>`coalesce(${routineRuns.event}->>'line', '')`;
const inLine = (line: string) => sql`${lineSql} = ${line}`;

/** Runs of one webhook routine working at once, at most (its lines). */
export const MAX_LINES = 3;

const keysOf = (event: unknown) =>
  event && typeof event === "object" && Array.isArray((event as Record<string, unknown>).dedupeKeys)
    ? ((event as Record<string, unknown>).dedupeKeys as unknown[]).filter((k): k is string => typeof k === "string")
    : [];

const lockRoutine = (tx: Executor, routineId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`routine-event:${routineId}`}, 0))`);

/** The job that runs a routine run (one per row). */
export const enqueueRoutineJob = (tx: Executor, row: { id: string; orgId: string }) =>
  enqueue(tx, {
    orgId: row.orgId,
    kind: "routine.run",
    payload: { routineRunId: row.id },
    dedupeKey: `routine.run:${row.id}`,
    maxAttempts: 3,
  });

/**
 * How many runs of a routine may work at once: one, unless it is a webhook routine grouping its calls; then as
 * many as its agent's computer takes at once (`maxTasks`), at most `MAX_LINES`.
 */
export async function routineLineCap(db: Executor, routineId: string): Promise<number> {
  const [row] = await db
    .select({ maxTasks: sql<number | null>`(${machines.size}->>'maxTasks')::int` })
    .from(routineHooks)
    .innerJoin(routines, eq(routines.id, routineHooks.routineId))
    .innerJoin(agents, eq(agents.id, routines.agentId))
    .leftJoin(machines, eq(machines.id, agents.machineId))
    .where(and(eq(routineHooks.routineId, routineId), isNotNull(routineHooks.groupBy)));
  if (!row) return 1;
  return Math.max(1, Math.min(MAX_LINES, row.maxTasks ?? MAX_LINES));
}

/**
 * The lines of this routine's runs working or about to (one entry per run): being started, started with
 * its agent run still active, or queued with its job alive.
 */
async function inFlightLines(db: Executor, routineId: string): Promise<string[]> {
  const rows = await db
    .select({ line: lineSql })
    .from(routineRuns)
    .leftJoin(agentRuns, eq(agentRuns.id, routineRuns.agentRunId))
    .where(
      and(
        eq(routineRuns.routineId, routineId),
        isNull(routineRuns.finishedAt),
        or(
          eq(routineRuns.status, "starting"),
          and(
            inArray(routineRuns.status, ["started", "reported"]),
            inArray(agentRuns.status, ["queued", "running", "waiting_approval", "waiting_input"]),
          ),
          and(eq(routineRuns.status, "queued"), routineJobAlive(routineRuns.id)),
        ),
      ),
    );
  return rows.map((r) => r.line);
}

/** A run of this routine is working or about to (`inFlightLines`). */
export async function routineInFlight(db: Executor, routineId: string): Promise<boolean> {
  return (await inFlightLines(db, routineId)).length > 0;
}

/**
 * Starts the gathered runs that may start now (§6.3): the oldest of each line with nothing working,
 * while the routine is under its cap. Returns the runs started. The caller holds the routine's lock.
 */
async function startWaiting(tx: Executor, routineId: string): Promise<string[]> {
  const cap = await routineLineCap(tx, routineId);
  const busy = await inFlightLines(tx, routineId);
  if (busy.length >= cap) return [];
  const gathered = await tx
    .select({ id: routineRuns.id, orgId: routineRuns.orgId, line: lineSql })
    .from(routineRuns)
    .where(
      and(
        eq(routineRuns.routineId, routineId),
        eq(routineRuns.status, "queued"),
        sql`${routineRuns.event}->>'gathered' = 'true'`,
      ),
    )
    .orderBy(routineRuns.createdAt, routineRuns.id)
    .for("update");
  const started: string[] = [];
  for (const g of gathered) {
    if (busy.length >= cap) break;
    if (busy.includes(g.line)) continue;
    busy.push(g.line);
    await tx
      .update(routineRuns)
      .set({ event: sql`${routineRuns.event} - 'gathered'` })
      .where(eq(routineRuns.id, g.id));
    await enqueueRoutineJob(tx, g);
    started.push(g.id);
  }
  return started;
}

/**
 * Inserts a routine run at `at` (moved by a millisecond when that slot is taken: `(routine_id, at)` is unique).
 * `createdAt`: its place in its line, when it takes back an earlier run's.
 */
async function insertRun(
  tx: Executor,
  routine: Pick<RoutineRow, "id" | "orgId">,
  values: { at: Date; trigger: string; event: Record<string, unknown>; dedupeKey: string | null; createdAt?: Date },
) {
  for (let i = 0; i < 5; i++) {
    const [row] = await tx
      .insert(routineRuns)
      .values({
        orgId: routine.orgId,
        routineId: routine.id,
        at: new Date(values.at.getTime() + i),
        trigger: values.trigger,
        event: values.event,
        dedupeKey: values.dedupeKey,
        ...(values.createdAt ? { createdAt: values.createdAt } : {}),
      })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    // The same dedupe key won meanwhile: nothing to add.
    if (values.dedupeKey) {
      const [seen] = await tx
        .select({ id: routineRuns.id })
        .from(routineRuns)
        .where(and(eq(routineRuns.routineId, routine.id), eq(routineRuns.dedupeKey, values.dedupeKey)));
      if (seen) return null;
    }
  }
  return null;
}

/** What became of an event: a new run, joined to a queued one, gathered for after the one working, or a repeat. */
export type EventOutcome = "queued" | "merged" | "gathered" | "duplicate";

/**
 * An event for a routine (§6.3, §6.5): a repeat of an event it already got is dropped; else it joins
 * the newest run of its line that hasn't started (queued with its job alive, gathered, or held emails,
 * which a new event wakes) unless that run is `full`, so events keep their order; else a new run
 * waits in the line. Then whatever may start does (`startWaiting`). `line`: the event's group
 * ('' or left out: the routine's one line). `runId`: the routine run it went into.
 */
export async function queueEventRun(
  deps: { db: Database },
  routine: Pick<RoutineRow, "id" | "orgId">,
  input: {
    event: RoutineEventPayload;
    dedupeKey?: string | null;
    merge?: EventMerge;
    at?: Date;
    line?: string;
    /** A run's event can take no more (the next event waits in a run of its own, behind it). */
    full?: (event: Record<string, unknown>) => boolean;
  },
): Promise<{ outcome: EventOutcome; runId: string | null }> {
  const merge = input.merge ?? mergeEvents;
  const key = input.dedupeKey ?? null;
  const line = input.line ?? "";
  return deps.db.transaction(async (tx) => {
    await lockRoutine(tx, routine.id);
    if (key) {
      const [seen] = await tx
        .select({ id: routineRuns.id })
        .from(routineRuns)
        .where(
          and(
            eq(routineRuns.routineId, routine.id),
            or(
              eq(routineRuns.dedupeKey, key),
              sql`${routineRuns.event}->'dedupeKeys' @> jsonb_build_array(${key}::text)`,
            ),
          ),
        )
        .limit(1);
      if (seen) return { outcome: "duplicate" as const, runId: seen.id };
    }
    const queuedInLine = and(eq(routineRuns.routineId, routine.id), eq(routineRuns.status, "queued"), inLine(line));
    await tx
      .update(routineRuns)
      .set({ event: sql`(${routineRuns.event} - 'held') || '{"gathered": true}'::jsonb` })
      .where(and(queuedInLine, sql`${routineRuns.event}->>'held' = 'true'`));
    const waiting = await tx
      .select({ id: routineRuns.id, event: routineRuns.event, alive: routineJobAlive(routineRuns.id) })
      .from(routineRuns)
      .where(queuedInLine)
      .orderBy(desc(routineRuns.createdAt), desc(routineRuns.id))
      .for("update");
    const newest = waiting.find((w) => w.alive || waitingToStart(w.event));
    let runId: string;
    if (newest && !input.full?.(newest.event ?? {})) {
      const current = newest.event ?? {};
      const pending = waitingToStart(current);
      const keys = [...keysOf(current), ...(key ? [key] : [])];
      await tx
        .update(routineRuns)
        .set({ event: withState(merge(current, input.event), keys, { gathered: pending, line }) })
        .where(eq(routineRuns.id, newest.id));
      if (!pending) return { outcome: "merged" as const, runId: newest.id };
      runId = newest.id;
    } else {
      const row = await insertRun(tx, routine, {
        at: input.at ?? new Date(),
        trigger: "event",
        event: withState(input.event, key ? [key] : [], { gathered: true, line }),
        dedupeKey: key,
      });
      if (!row) return { outcome: "duplicate" as const, runId: null };
      runId = row.id;
    }
    const started = await startWaiting(tx, routine.id);
    return { outcome: started.includes(runId) ? ("queued" as const) : ("gathered" as const), runId };
  });
}

/**
 * Events a run ended without finishing go back to its line (`event.line`), ahead of what came after
 * them (`createdAt`: the ended run's place): gathered, so they start as soon as the line is free, or
 * `held` for the line's next event (a person stopped them). Returns the new run.
 */
export async function requeueEventRun(
  deps: { db: Database },
  routine: Pick<RoutineRow, "id" | "orgId">,
  input: { event: RoutineEventPayload; at: Date; createdAt: Date; held: boolean },
): Promise<string | null> {
  return deps.db.transaction(async (tx) => {
    await lockRoutine(tx, routine.id);
    const row = await insertRun(tx, routine, {
      at: input.at,
      trigger: "event",
      event: withState(input.event, [], input.held ? { held: true } : { gathered: true }),
      dedupeKey: null,
      createdAt: input.createdAt,
    });
    if (row && !input.held) await startWaiting(tx, routine.id);
    return row?.id ?? null;
  });
}

/**
 * Emails of a run that failed or was stopped (§6.8) wait for the next run: they join the run waiting
 * to start, or a held run that the next email starts (never one on its own: a stop is respected).
 */
export async function holdForNextRun(
  deps: { db: Database },
  routine: Pick<RoutineRow, "id" | "orgId">,
  event: RoutineEventPayload,
  merge: EventMerge,
) {
  await deps.db.transaction(async (tx) => {
    await lockRoutine(tx, routine.id);
    const waiting = await tx
      .select({ id: routineRuns.id, event: routineRuns.event, alive: routineJobAlive(routineRuns.id) })
      .from(routineRuns)
      .where(and(eq(routineRuns.routineId, routine.id), eq(routineRuns.status, "queued")))
      .orderBy(desc(routineRuns.createdAt))
      .for("update");
    const target =
      waiting.find((w) => w.alive && !flag(w.event, "gathered") && !flag(w.event, "held")) ??
      waiting.find((w) => flag(w.event, "gathered") || flag(w.event, "held"));
    if (target) {
      const current = target.event ?? {};
      await tx
        .update(routineRuns)
        .set({
          event: withState(merge(current, event), keysOf(current), {
            gathered: flag(current, "gathered"),
            held: flag(current, "held"),
          }),
        })
        .where(eq(routineRuns.id, target.id));
      return;
    }
    await insertRun(tx, routine, {
      at: new Date(),
      trigger: "event",
      event: withState(event, [], { held: true }),
      dedupeKey: null,
    });
  });
}

/**
 * An event run whose job came while another run of the routine works (a manual run started in
 * between): it waits for that one instead (§6.3), as a gathered run of its own. Moved to a new row,
 * since its job's key is spent (`startGatheredRun` gives the new row a job). Returns whether it moved.
 */
export async function deferEventRun(
  deps: { db: Database },
  run: Pick<typeof routineRuns.$inferSelect, "id" | "orgId" | "routineId">,
): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    await lockRoutine(tx, run.routineId);
    const [taken] = await tx
      .delete(routineRuns)
      .where(and(eq(routineRuns.id, run.id), eq(routineRuns.status, "starting"), isNull(routineRuns.agentRunId)))
      .returning();
    if (!taken) return false;
    const event = taken.event ?? {};
    const keys = [...keysOf(event), ...(taken.dedupeKey ? [taken.dedupeKey] : [])];
    const moved = await insertRun(
      tx,
      { id: taken.routineId, orgId: taken.orgId },
      {
        at: taken.at,
        trigger: taken.trigger,
        event: withState(event, keys, { gathered: true }),
        dedupeKey: taken.dedupeKey,
        createdAt: taken.createdAt,
      },
    );
    // The webhook calls it carried point to where it went.
    if (moved) {
      await tx
        .update(routineHookCalls)
        .set({ routineRunId: moved.id })
        .where(and(eq(routineHookCalls.routineId, taken.routineId), eq(routineHookCalls.routineRunId, taken.id)));
    }
    return true;
  });
}

/**
 * A run of the routine ended (§6.3): the runs gathered while it worked start now, as far as its lines
 * and cap let them. Returns whether one started.
 */
export async function startGatheredRun(deps: { db: Database }, routineId: string): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    await lockRoutine(tx, routineId);
    return (await startWaiting(tx, routineId)).length > 0;
  });
}
