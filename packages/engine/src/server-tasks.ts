import { type Database, eq, lt, schema } from "@agenteschat/db";

const { serverTasks } = schema;

/**
 * Runs `task` unless a process already finished it on this database, and records it once it has: a one-off left from
 * an upgrade (a backfill) runs once per database, never at every start of every process, and an installation that
 * upgrades later still gets it. A task that throws, or resolves `false` (nothing it could do yet), runs again at the
 * next start. Two processes may both run it before either records it: such a task stands being run twice.
 */
export async function onceOnDatabase(db: Database, name: string, task: () => Promise<unknown>): Promise<boolean> {
  const key = `once:${name}`;
  const [done] = await db.select({ name: serverTasks.name }).from(serverTasks).where(eq(serverTasks.name, key));
  if (done) return false;
  if ((await task()) === false) return false;
  await db.insert(serverTasks).values({ name: key, ranAt: new Date() }).onConflictDoNothing();
  return true;
}

/**
 * Takes this database's turn of a sweep: true, with its time recorded, when no process started it within `gapMs`. One
 * statement, so of the processes that ask at once only one gets it.
 */
export async function claimSweep(db: Database, name: string, gapMs: number, now = new Date()): Promise<boolean> {
  const rows = await db
    .insert(serverTasks)
    .values({ name: `sweep:${name}`, ranAt: now })
    .onConflictDoUpdate({
      target: serverTasks.name,
      set: { ranAt: now },
      setWhere: lt(serverTasks.ranAt, new Date(now.getTime() - gapMs)),
    })
    .returning({ name: serverTasks.name });
  return rows.length > 0;
}
