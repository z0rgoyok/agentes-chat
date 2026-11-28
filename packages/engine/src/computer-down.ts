import { and, count, type Database, eq, gte, schema, sql } from "@agenteschat/db";
import { getMachineById, type MachineRow, shownMoving, shownOnline } from "./machines";
import { adminsOf } from "./notification-producers";
import { type NotificationDeps, notify, resolveNotifications } from "./notifications";
import { enqueue } from "./outbox";
import { orgStanding, workRefusal } from "./standing";

const { agentRuns, agents, notifications, routineHookCalls, routines } = schema;

/*
 * "Computer down" and "back" (ADR 0241): who configures the workspace hears that a computer its agents work on has
 * been away for a while, and again when it is back, with how long and what waited for it. Never for a computer asleep
 * by design (standby, ADR 0161) or one the operator is moving to another host: those are away by plan. Inbox only:
 * never an email or a push, since nobody has to act on it and it must not read as the computer sleeping.
 */

/** Away this long: the inbox. */
export const DOWN_NOTICE_MS = 10 * 60_000;
/** Back for less than this before it went again: the same outage, told once. */
export const DOWN_JOIN_MS = 30 * 60_000;

/** Due a while after a computer's socket closes (`machine-hub`): says it is down if it still is. */
export const COMPUTER_DOWN_JOB = "machine.down_notice";

export const downGroup = (machineId: string, start: Date) => `computer_down:${machineId}:${start.getTime()}`;
export const backGroup = (machineId: string, start: Date) => `computer_back:${machineId}:${start.getTime()}`;

/**
 * When the outage a computer is in began, from its last closes (newest first): the last close, joined with each one
 * before it the computer came back from for less than `DOWN_JOIN_MS`, never one at or before `after` (the outage a
 * "back" was told for is over). Null: no close after `after`.
 */
export function outageStart(disconnects: schema.MachineDisconnect[], after = 0): Date | null {
  const [first] = disconnects;
  if (!first || Date.parse(first.at) <= after) return null;
  let start = Date.parse(first.at);
  for (let i = 0; i + 1 < disconnects.length; i++) {
    const close = disconnects[i] as schema.MachineDisconnect;
    const before = Date.parse((disconnects[i + 1] as schema.MachineDisconnect).at);
    if (Date.parse(close.at) - Date.parse(close.connectedAt) >= DOWN_JOIN_MS || before <= after) break;
    start = before;
  }
  return new Date(start);
}

/** `outageStart`, past every outage a "back" was already told for. */
async function currentOutage(db: Database, m: MachineRow): Promise<Date | null> {
  let after = 0;
  for (let i = 0; i <= m.disconnects.length; i++) {
    const start = outageStart(m.disconnects, after);
    if (!start) return null;
    const [told] = await db
      .select({ at: sql<Date | null>`max(${notifications.createdAt})`.mapWith(notifications.createdAt) })
      .from(notifications)
      .where(and(eq(notifications.orgId, m.orgId), eq(notifications.groupKey, backGroup(m.id, start))));
    if (!told?.at) return start;
    after = told.at.getTime();
  }
  return null;
}

/** Runs waiting for the computer now, and webhook calls its agents' routines took since `since`. */
async function waitingOn(db: Database, m: MachineRow, since: Date) {
  const [runs] = await db
    .select({ n: count() })
    .from(agentRuns)
    .where(
      and(eq(agentRuns.orgId, m.orgId), eq(agentRuns.status, "waiting_input"), eq(agentRuns.waitingMachineId, m.id)),
    );
  const [calls] = await db
    .select({ n: count() })
    .from(routineHookCalls)
    .innerJoin(routines, eq(routines.id, routineHookCalls.routineId))
    .innerJoin(agents, eq(agents.id, routines.agentId))
    .where(
      and(
        eq(routineHookCalls.orgId, m.orgId),
        eq(routineHookCalls.outcome, "accepted"),
        eq(routineHookCalls.test, false),
        gte(routineHookCalls.createdAt, since),
        eq(agents.machineId, m.id),
      ),
    );
  return { runs: Number(runs?.n ?? 0), calls: Number(calls?.n ?? 0) };
}

/** Who configures the workspace, and who connected a computer they brought (it is theirs to turn back on). */
async function recipientsOf(deps: NotificationDeps, m: MachineRow) {
  const admins = await adminsOf(deps, m.orgId, "configure");
  return [...new Set([...admins, ...(m.kind === "connected" && m.pairedByUserId ? [m.pairedByUserId] : [])])];
}

/**
 * Away by plan or by its owner's choice: asleep in standby, away for what we do to it (a move, a restart…: ADR 0257),
 * removed, or its workspace not at work.
 */
async function awayByPlan(db: Database, m: MachineRow, now: Date) {
  if (m.deletedAt || shownOnline(m, now) || shownMoving(m, now)) return true;
  return workRefusal(await orgStanding(db, m.orgId)) !== null;
}

/** Schedules the check of the outage a close may start. */
export async function queueDownChecks(db: Database, orgId: string, machineId: string, closedAt: Date) {
  await enqueue(db, {
    orgId,
    kind: COMPUTER_DOWN_JOB,
    payload: { machineId, stage: "down" },
    dedupeKey: `${COMPUTER_DOWN_JOB}:${machineId}:${closedAt.getTime()}:down`,
    runAt: new Date(closedAt.getTime() + DOWN_NOTICE_MS),
  });
}

/**
 * `machine.down_notice`: the computer is still away and its outage began `DOWN_NOTICE_MS` ago: who configures the
 * workspace hears it (`computer_down`, once per outage). A computer someone brought counts only while work waits for
 * it: one put away for the night is no outage.
 */
export async function noticeComputerDown(deps: NotificationDeps, machineId: string) {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const m = await getMachineById(db, machineId);
  if (!m || (await awayByPlan(db, m, now))) return;
  const start = await currentOutage(db, m);
  if (!start || now.getTime() - start.getTime() < DOWN_NOTICE_MS) return;
  const waiting = await waitingOn(db, m, start);
  if (m.kind === "connected" && waiting.runs === 0) return;
  const userIds = await recipientsOf(deps, m);
  await notify(deps, {
    orgId: m.orgId,
    userIds,
    kind: "computer_down",
    groupKey: downGroup(m.id, start),
    source: { machineId: m.id, label: m.name },
    latest: { title: m.name, since: start.toISOString(), runs: waiting.runs, calls: waiting.calls },
  });
}

/**
 * A computer said hello (`machine-hub`, before its row says it is online): when its outage was told (`computer_down`),
 * the same people hear it is back (`computer_back`), with how long it was away and what waited for it. The "down" row
 * is done.
 */
export async function noticeComputerBack(deps: NotificationDeps, m: MachineRow) {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  // Most hellos follow a blip: nothing to read for one away under the notice's wait.
  const earliest = outageStart(m.disconnects);
  if (!earliest || now.getTime() - earliest.getTime() < DOWN_NOTICE_MS) return;
  const start = await currentOutage(db, m);
  if (!start) return;
  const down = await db
    .select({ userId: notifications.userId })
    .from(notifications)
    .where(and(eq(notifications.orgId, m.orgId), eq(notifications.groupKey, downGroup(m.id, start))));
  if (down.length === 0) return;
  const waiting = await waitingOn(db, m, start);
  const userIds = down.map((d) => d.userId);
  await notify(deps, {
    orgId: m.orgId,
    userIds,
    kind: "computer_back",
    groupKey: backGroup(m.id, start),
    source: { machineId: m.id, label: m.name },
    latest: { title: m.name, since: start.toISOString(), runs: waiting.runs, calls: waiting.calls },
  });
  await resolveNotifications(deps, m.orgId, { groupKey: downGroup(m.id, start) });
}
