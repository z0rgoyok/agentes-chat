import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, isNotNull, isNull, schema, sql } from "@agenteschat/db";
import { type MachineRow, machineOnline, publishMachineUpdated, shownStandby, TASK_OFFLINE_GRACE_MS } from "./machines";
import { recordWakeWanted } from "./operator-events";
import { enqueue } from "./outbox";

const { machines, agents, agentRuns, machineTasks, machineHolds, browserHandoffs, organizationMembers } = schema;

/**
 * The workspace's own computer asleep when nobody uses it (ADR 0161). The operator puts it in standby
 * (`setMachineStandby`) from what `machineActivity` says, and is asked to wake it (`machine.wake_wanted`) whenever
 * something wants it (`wantMachine`): a run, a person looking at it, a request sent to it. Its runner's hello clears
 * the standby (`machine-hub.ts`).
 */

/** What wants the computer: a run (its turn, or its wait for the computer), a person's view of it, a request to it. */
export type WakeWhy = "run" | "view" | "call";

/** `wanted_at` is written at most this often per computer and server process. */
export const WANTED_WRITE_MS = 30_000;
/** Wanted this recently, it is busy: an open view of the computer asks every few seconds. */
export const WANTED_BUSY_MS = 2 * 60_000;
/** Only runs and tasks created this recently count toward its last use: never a workspace's whole history. */
const ACTIVITY_WINDOW_MS = 7 * 86_400_000;

// ponytail: per process; each replica writes `wanted_at` at most every 30 seconds. A shared table if that ever matters.
const wantedWrites = new Map<string, number>();

const managedRow = (machineId: string) =>
  and(eq(machines.id, machineId), eq(machines.kind, "managed"), isNull(machines.deletedAt));

/**
 * Something wants this computer now: the workspace's own computer keeps when (`wanted_at`), and one in standby asks the
 * operator to wake it (`machine.wake_wanted`). Any other computer: nothing.
 */
export async function wantMachine(db: Database, machineId: string, why: WakeWhy, now = Date.now()) {
  const last = wantedWrites.get(machineId);
  const write = last === undefined || now - last >= WANTED_WRITE_MS;
  if (write) {
    if (wantedWrites.size >= 10_000) wantedWrites.clear();
    wantedWrites.set(machineId, now);
  }
  const columns = { orgId: machines.orgId, standbyAt: machines.standbyAt };
  const [row] = write
    ? await db
        .update(machines)
        .set({ wantedAt: new Date(now) })
        .where(managedRow(machineId))
        .returning(columns)
    : await db.select(columns).from(machines).where(managedRow(machineId));
  if (!row?.standbyAt) return;
  await recordWakeWanted(db, { orgId: row.orgId, machineId, why }, now);
  // The first want since it slept starts the wake's clock (`shownStandby`): past it, the apps hear it is down.
  const [first] = await db
    .update(machines)
    .set({ wakeWantedAt: new Date(now) })
    .where(and(managedRow(machineId), isNotNull(machines.standbyAt), isNull(machines.wakeWantedAt)))
    .returning({ id: machines.id });
  if (first) await checkWakeLater(db, row.orgId, machineId, new Date(now));
}

/** One `machine.wake_overdue` per wake's clock: it is due when the clock runs out. */
const checkWakeLater = (db: Database, orgId: string, machineId: string, wakeWantedAt: Date) =>
  enqueue(db, {
    orgId,
    kind: WAKE_OVERDUE_JOB,
    payload: { machineId },
    dedupeKey: `${WAKE_OVERDUE_JOB}:${machineId}:${wakeWantedAt.getTime()}`,
    runAt: new Date(wakeWantedAt.getTime() + TASK_OFFLINE_GRACE_MS),
  });

export const WAKE_OVERDUE_JOB = "machine.wake_overdue";

/**
 * `machine.wake_overdue`: a computer wanted awake a grace ago. Still asleep, it no longer reads online to people
 * (`shownStandby`), and their apps refetch it (`standby: false`).
 */
export async function wakeOverdue(deps: { db: Database; pubsub?: PubSub }, machineId: string, now = new Date()) {
  const [row] = await deps.db.select().from(machines).where(managedRow(machineId));
  if (!row?.wakeWantedAt || machineOnline(row, now) || shownStandby(row, now)) return;
  await publishMachineUpdated(deps.pubsub, row.orgId, machineId, { standby: false });
}

/**
 * `PUT …/machines/{machineId}/standby`: the operator put the workspace's own computer in standby (`standby_at` keeps
 * the first time), or took it out; its people's apps read it again. Null: the workspace has no such managed computer.
 * The wake's clock (`wake_wanted_at`) survives a standby said again. Taken out while asleep, the computer is starting:
 * it reads waking until its runner's hello clears the clock, or the clock runs out (`shownStandby`).
 */
export async function setMachineStandby(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  machineId: string,
  standby: boolean,
) {
  const [row] = await deps.db
    .update(machines)
    .set(
      standby
        ? {
            standbyAt: sql`coalesce(${machines.standbyAt}, now())`,
            wakeWantedAt: sql`case when ${machines.standbyAt} is null then null else ${machines.wakeWantedAt} end`,
          }
        : {
            standbyAt: null,
            // Asleep (in standby, its runner gone): it is starting now.
            wakeWantedAt: sql`case when ${machines.standbyAt} is not null and not ${machines.online}
              then coalesce(${machines.wakeWantedAt}, now()) else ${machines.wakeWantedAt} end`,
          },
    )
    .where(and(eq(machines.orgId, orgId), managedRow(machineId)))
    .returning();
  if (!row) return null;
  if (!standby && row.wakeWantedAt) await checkWakeLater(deps.db, orgId, machineId, row.wakeWantedAt);
  // What people see: still waking (or asleep), or not.
  await publishMachineUpdated(deps.pubsub, orgId, machineId, { standby: shownStandby(row) });
  return { standby };
}

/**
 * Whether the workspace's own computer is in use now (`busy`) and when it last was (`lastUsedAt`), for the operator to
 * decide when it sleeps. Busy: a run of the workspace queued or running, a run waiting for this computer, a task
 * running on it, something an agent keeps running on it (a live hold, ADR 0176), someone in control of one of its
 * agents' screens, or someone wanting it in the last `WANTED_BUSY_MS`.
 * Last used: the latest of the workspace's runs and this computer's tasks (of the last 7 days), `wanted_at`, and its
 * people's last visit. One query.
 */
export async function machineActivity(
  db: Database,
  machine: Pick<MachineRow, "id" | "orgId">,
  now = new Date(),
): Promise<{ busy: boolean; lastUsedAt: Date | null }> {
  const { id, orgId } = machine;
  const since = sql`${new Date(now.getTime() - ACTIVITY_WINDOW_MS).toISOString()}::timestamptz`;
  const nowAt = sql`${now.toISOString()}::timestamptz`;
  // A null never reaches a decoder: the type says it may still come back.
  const at = (v: string | Date): Date | null => new Date(v);
  const [row] = await db
    .select({
      wantedAt: machines.wantedAt,
      working: sql<boolean>`exists (select 1 from ${agentRuns}
          where ${agentRuns.orgId} = ${orgId} and ${agentRuns.status} in ('queued', 'running'))
        or exists (select 1 from ${agentRuns}
          where ${agentRuns.waitingMachineId} = ${id} and ${agentRuns.status} = 'waiting_input')
        or exists (select 1 from ${machineTasks}
          where ${machineTasks.machineId} = ${id} and ${machineTasks.status} = 'running')
        or exists (select 1 from ${machineHolds}
          where ${machineHolds.machineId} = ${id} and ${machineHolds.endedAt} is null
            and (${machineHolds.until} is null or ${machineHolds.until} > ${nowAt}))
        or exists (select 1 from ${browserHandoffs}
          where ${browserHandoffs.orgId} = ${orgId} and ${browserHandoffs.machineId} = ${id}
            and ${browserHandoffs.status} = 'active')`,
      // Agent by agent, on the (org_id, agent_id, created_at) indexes.
      runAt: sql<Date | null>`(select max(coalesce(r.finished_at, r.updated_at)) from ${agents} a
        join ${agentRuns} r on r.org_id = a.org_id and r.agent_id = a.id and r.created_at > ${since}
        where a.org_id = ${orgId})`.mapWith(at),
      taskAt: sql<Date | null>`(select max(t.updated_at) from ${agents} a
        join ${machineTasks} t on t.org_id = a.org_id and t.agent_id = a.id and t.created_at > ${since}
        where a.org_id = ${orgId} and t.machine_id = ${id})`.mapWith(at),
      seenAt: sql<Date | null>`(select max(${organizationMembers.lastSeenAt}) from ${organizationMembers}
        where ${organizationMembers.orgId} = ${orgId})`.mapWith(at),
    })
    .from(machines)
    .where(eq(machines.id, id));
  if (!row) return { busy: false, lastUsedAt: null };
  const wanted = row.wantedAt !== null && now.getTime() - row.wantedAt.getTime() < WANTED_BUSY_MS;
  const times = [row.runAt, row.taskAt, row.wantedAt, row.seenAt].filter((d): d is Date => d !== null);
  return {
    busy: row.working || wanted,
    lastUsedAt: times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null,
  };
}
