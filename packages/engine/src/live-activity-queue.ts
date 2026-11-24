import { type Executor, eq, schema } from "@agenteschat/db";
import { caches } from "./cache";
import { enqueue } from "./outbox";

const { liveActivityDevices } = schema;

/**
 * When the Live Activity of a person's agents at work is computed again (ADR 0210): one job kind, coalesced. Apart
 * from the rest of the module (`live-activity.ts`) so the flows that call it (notifications, runs) import nothing of
 * what it reads.
 */
export const LIVE_ACTIVITY_JOB = "live-activity.refresh";

/** A change waits this long before the job reads it, so a burst (a run starting, its line, its first wait) is one push. */
export const LIVE_ACTIVITY_DELAY_MS = 1500;
/** Changes asked within one window of this length share one job. */
const BUCKET_MS = 2000;
const IN_USE = "in-use";

/**
 * Whether any person's phone shows their agents in a Live Activity: a run's change queues nothing on a server where
 * none does. Kept 30 seconds in the server (`caches.liveActivities`), read on each call in tests.
 */
export function liveActivitiesInUse(db: Executor): Promise<boolean> {
  return caches.liveActivities.getOrLoad(IN_USE, async () => {
    const [row] = await db.select({ id: liveActivityDevices.id }).from(liveActivityDevices).limit(1);
    return Boolean(row);
  });
}

/** A phone registered one: every process reads it again (the cache's invalidation reaches them all). */
export function noteLiveActivityInUse() {
  caches.liveActivities.delete(IN_USE);
}

const bucket = (time: number) => Math.floor(time / BUCKET_MS);

/**
 * The person's Live Activity is computed again a moment from now (`LIVE_ACTIVITY_DELAY_MS`), only if one of their
 * phones shows it: their requests waiting moved, they registered a phone. Within a window (`windowMs`), one job.
 */
export async function queueLiveActivity(
  db: Executor,
  userId: string,
  delayMs = LIVE_ACTIVITY_DELAY_MS,
  windowMs = BUCKET_MS,
) {
  const [device] = await db
    .select({ id: liveActivityDevices.id })
    .from(liveActivityDevices)
    .where(eq(liveActivityDevices.userId, userId))
    .limit(1);
  if (!device) return;
  const time = Date.now() + delayMs;
  await enqueue(db, {
    orgId: null,
    kind: LIVE_ACTIVITY_JOB,
    payload: { userId },
    dedupeKey:
      windowMs === BUCKET_MS
        ? `${LIVE_ACTIVITY_JOB}:${userId}:${bucket(time)}`
        : `${LIVE_ACTIVITY_JOB}:${userId}:w${windowMs}:${Math.floor(time / windowMs)}`,
    runAt: new Date(time),
    maxAttempts: 4,
  });
}

/**
 * A run started, moved on (its line, a wait) or ended: the Live Activity of the person behind it is computed again.
 * The job finds who that is (`authority.ts`), so the run's path pays one insert, and nothing on a server where no phone
 * shows one. A routine's background run never shows: nobody is behind it.
 */
export async function queueLiveActivityRun(
  db: Executor,
  run: { id: string; orgId: string; background?: boolean },
  delayMs = LIVE_ACTIVITY_DELAY_MS,
) {
  if (run.background) return;
  if (!(await liveActivitiesInUse(db))) return;
  const time = Date.now() + delayMs;
  await enqueue(db, {
    orgId: run.orgId,
    kind: LIVE_ACTIVITY_JOB,
    payload: { runId: run.id },
    dedupeKey: `${LIVE_ACTIVITY_JOB}:run:${run.id}:${bucket(time)}`,
    runAt: new Date(time),
    maxAttempts: 4,
  });
}
