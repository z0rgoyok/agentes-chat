import { and, asc, type Database, desc, eq, inArray, isNull, type SQL, schema, sql } from "@agenteschat/db";
import { provisioningStatus } from "./machine-provisioning";
import { machineActivity } from "./machine-wake";
import { inStandby, machineOnline } from "./machines";
import { operatorAccountColumns } from "./operator-lookups";
import { codeOf } from "./operator-paging";

/**
 * Computers for the operator API (ADR 0056 §10): whether each is there, what runs on it and what waits for it.
 * Never its token, a connection code, its hostname, its folders or its address, and of a task or of something kept
 * running only how many. Every field is picked by name, and nothing here writes, because a caller holding only the
 * read token reaches all of it.
 */

const { organizations, machines, machineProvisioning, machineAccounts, machineTasks, machineHolds, agentRuns } = schema;

/** How many AI accounts one answer lists across its computers, most recently used first. */
export const OPERATOR_MACHINE_ACCOUNTS = 200;

// In a select list over one table drizzle writes columns without their table, so in a subquery a bare
// "id" would be the subquery's own: the outer computer is named in full.
const MACHINE_ID = sql.raw(`"machines"."id"`);
const MACHINE_ORG = sql.raw(`"machines"."org_id"`);
const counted = (rows: SQL) => sql<number>`(select count(*) from ${rows})`.mapWith(Number);

const machineColumns = {
  id: machines.id,
  orgId: machines.orgId,
  kind: machines.kind,
  name: machines.name,
  online: machines.online,
  lastSeenAt: machines.lastSeenAt,
  runnerVersion: machines.runnerVersion,
  protocol: machines.protocol,
  standbyAt: machines.standbyAt,
  executors: machines.executors,
  deletedAt: machines.deletedAt,
  accountCount: counted(sql`${machineAccounts}
    where ${machineAccounts.orgId} = ${MACHINE_ORG} and ${machineAccounts.machineId} = ${MACHINE_ID}`),
  // An interrupted task is open until its end is final: it may still come back or be resumed.
  openTasks: counted(sql`${machineTasks} where ${machineTasks.machineId} = ${MACHINE_ID}
    and ${machineTasks.endedAt} is null and ${machineTasks.status} in ('queued', 'running', 'interrupted')`),
  holds: counted(sql`${machineHolds} where ${machineHolds.machineId} = ${MACHINE_ID}
    and ${machineHolds.endedAt} is null and (${machineHolds.until} is null or ${machineHolds.until} > now())`),
  waitingRuns: counted(sql`${agentRuns} where ${agentRuns.waitingMachineId} = ${MACHINE_ID}
    and ${agentRuns.status} = 'waiting_input'`),
};

// A version line is what a program printed about itself on someone's computer: returned only when it reads as one.
const VERSION = /^[\w.+() -]{1,80}$/;

/** What the runner found on the computer that says its version (its coding CLIs, its browser), in order of name. */
const executorsOf = (found: object) =>
  Object.entries(found)
    .flatMap(([name, entry]) => {
      const version = entry && typeof entry === "object" ? (entry as { version?: unknown }).version : undefined;
      if (!codeOf(name) || typeof version !== "string") return [];
      return [{ name, version: VERSION.test(version) ? version : null }];
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));

async function machinesWhere(db: Database, where: SQL | undefined) {
  const rows = await db.select(machineColumns).from(machines).where(where).orderBy(asc(machines.createdAt));
  const [first] = rows;
  if (!first) return [];
  const managed = rows.find((m) => m.kind === "managed" && !m.deletedAt);
  const [activity, accounts] = await Promise.all([
    managed ? machineActivity(db, managed) : null,
    db
      .select({ machineId: machineAccounts.machineId, ...operatorAccountColumns, shared: machineAccounts.shared })
      .from(machineAccounts)
      .where(
        and(
          eq(machineAccounts.orgId, first.orgId),
          inArray(
            machineAccounts.machineId,
            rows.map((m) => m.id),
          ),
        ),
      )
      .orderBy(sql`${machineAccounts.lastUsedAt} desc nulls last`, desc(machineAccounts.createdAt))
      .limit(OPERATOR_MACHINE_ACCOUNTS),
  ]);
  return rows.map(({ standbyAt, executors, ...m }) => ({
    ...m,
    managed: m.kind === "managed",
    online: machineOnline(m),
    standby: inStandby({ kind: m.kind, standbyAt }),
    ...(activity && m.id === managed?.id ? activity : { busy: false, lastUsedAt: null }),
    executors: executorsOf(executors),
    accounts: accounts.flatMap(({ machineId, ...account }) => (machineId === m.id ? [account] : [])),
  }));
}

/**
 * The workspace's computers still in it, oldest first, and how far its own one is when a provisioner prepares it
 * (null: nothing said). Each: whether it is there, what its runner found on it, its AI accounts, and how many tasks
 * are open on it, how many things an agent keeps running there and how many runs wait for it; the workspace's own
 * one also with whether it sleeps, is in use and when it last was (ADR 0161). Null: no such workspace.
 */
export async function operatorMachines(db: Database, orgId: string) {
  const [org] = await db
    .select({ createdAt: organizations.createdAt })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org) return null;
  const [listed, said] = await Promise.all([
    machinesWhere(db, and(eq(machines.orgId, orgId), isNull(machines.deletedAt))),
    db.select().from(machineProvisioning).where(eq(machineProvisioning.orgId, orgId)),
  ]);
  return { machines: listed, provisioning: said[0] ? provisioningStatus(said[0], org.createdAt) : null };
}

/** One computer, as `operatorMachines` lists it; a removed one too, since runs outlive it. Null: none with that id. */
export const operatorMachine = async (db: Database, machineId: string) =>
  (await machinesWhere(db, eq(machines.id, machineId)))[0] ?? null;
