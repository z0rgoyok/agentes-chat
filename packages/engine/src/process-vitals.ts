import { and, type Database, desc, eq, gt, lt, schema, sql } from "@agenteschat/db";

const { serverProcesses, agentRuns } = schema;

export type ProcessVitals = typeof serverProcesses.$inferInsert;

/** A process that wrote nothing for this long is gone: its row is pruned. */
const PROCESS_ROW_KEEP_MS = 86_400_000;
/** The processes `GET /vitals` lists: those that wrote within this long. */
export const PROCESS_LIVE_MS = 5 * 60_000;
/** The runs whose claim `runClaimWaits` measures: claimed within this long, or still waiting for one. */
export const RUN_CLAIM_WINDOW_MS = 5 * 60_000;
/** A run waiting longer than this is no longer counted: one left behind, not today's load. */
const RUN_CLAIM_HORIZON_MS = 60 * 60_000;

/** This process's vitals, its row made or updated; rows of processes gone a day go with it. */
export async function recordProcessVitals(db: Database, vitals: ProcessVitals, now = new Date()) {
  const { id: _id, startedAt: _startedAt, ...changed } = vitals;
  await db.insert(serverProcesses).values(vitals).onConflictDoUpdate({ target: serverProcesses.id, set: changed });
  await db.delete(serverProcesses).where(lt(serverProcesses.seenAt, new Date(now.getTime() - PROCESS_ROW_KEEP_MS)));
}

/**
 * How long people's runs waited for a worker to claim them: each run claimed in the last `RUN_CLAIM_WINDOW_MS` from its creation
 * to its start, and each run still queued from its creation to now, so a stall that claims nothing shows at once
 * instead of only once its runs are finally claimed.
 */
export async function runClaimWaits(db: Database, now = new Date()) {
  const windowStart = new Date(now.getTime() - RUN_CLAIM_WINDOW_MS);
  const horizon = new Date(now.getTime() - RUN_CLAIM_HORIZON_MS);
  const waited = sql`extract(epoch from (coalesce(${agentRuns.startedAt}, ${now.toISOString()}::timestamptz) - ${agentRuns.createdAt})) * 1000`;
  const [row] = await db
    .select({
      runs: sql<number>`count(*)::int`,
      queued: sql<number>`(count(*) filter (where ${agentRuns.status} = 'queued'))::int`,
      p50Ms: sql<number | null>`percentile_cont(0.5) within group (order by ${waited})`,
      p95Ms: sql<number | null>`percentile_cont(0.95) within group (order by ${waited})`,
      oldestQueuedMs: sql<number | null>`max(${waited}) filter (where ${agentRuns.status} = 'queued')`,
    })
    .from(agentRuns)
    .where(
      // Background runs (routines) wait behind people's by design (ADR 0053 §10), minutes at a busy hour: left out.
      sql`${agentRuns.createdAt} > ${horizon.toISOString()}::timestamptz and not ${agentRuns.background} and (${agentRuns.startedAt} > ${windowStart.toISOString()}::timestamptz
        or (${agentRuns.status} = 'queued' and ${agentRuns.startedAt} is null))`,
    );
  const round = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : Math.round(Number(ms)));
  return {
    windowSeconds: RUN_CLAIM_WINDOW_MS / 1000,
    runs: row?.runs ?? 0,
    queued: row?.queued ?? 0,
    p50Ms: round(row?.p50Ms),
    p95Ms: round(row?.p95Ms),
    oldestQueuedMs: round(row?.oldestQueuedMs),
  };
}

/** The processes that wrote their vitals in the last `PROCESS_LIVE_MS`, the latest first. */
export function liveProcesses(db: Database, now = new Date()) {
  return db
    .select()
    .from(serverProcesses)
    .where(gt(serverProcesses.seenAt, new Date(now.getTime() - PROCESS_LIVE_MS)))
    .orderBy(desc(serverProcesses.startedAt));
}

/**
 * Whether a worker (`SERVER_ROLE=worker`) wrote its vitals in the last `PROCESS_LIVE_MS`: while one runs, it does the
 * database's sweeps and boot work, and the app processes leave them to it.
 */
export async function workerLive(db: Database, now = new Date()) {
  const [row] = await db
    .select({ id: serverProcesses.id })
    .from(serverProcesses)
    .where(
      and(eq(serverProcesses.role, "worker"), gt(serverProcesses.seenAt, new Date(now.getTime() - PROCESS_LIVE_MS))),
    )
    .limit(1);
  return Boolean(row);
}
