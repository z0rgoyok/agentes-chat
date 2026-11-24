import { and, type Database, eq, gt, lt, schema } from "@agenteschat/db";

/**
 * Who is online in an organization. In memory for one process (`createMemoryPresence`, the built-in database's), in
 * Postgres where several processes may each hold some of the open apps (`createPostgresPresence`).
 */
export interface Presence {
  connect(orgId: string, userId: string, connectionId: string): Promise<void>;
  disconnect(orgId: string, userId: string, connectionId: string): Promise<void>;
  /** User ids with at least one open connection. */
  online(orgId: string): Promise<string[]>;
}

export function createMemoryPresence(): Presence {
  const orgs = new Map<string, Map<string, Set<string>>>();
  return {
    async connect(orgId, userId, connectionId) {
      const users = orgs.get(orgId) ?? new Map<string, Set<string>>();
      orgs.set(orgId, users);
      const conns = users.get(userId) ?? new Set<string>();
      users.set(userId, conns);
      conns.add(connectionId);
    },
    async disconnect(orgId, userId, connectionId) {
      const conns = orgs.get(orgId)?.get(userId);
      conns?.delete(connectionId);
      if (conns?.size === 0) orgs.get(orgId)?.delete(userId);
    },
    async online(orgId) {
      return [...(orgs.get(orgId)?.keys() ?? [])].sort();
    },
  };
}

/** How often a process renews its connections' rows (`createPostgresPresence`). */
export const PRESENCE_BEAT_MS = 30_000;
/** A row not renewed for this long is a dead process's: it no longer counts. */
const PRESENCE_STALE_MS = 3 * PRESENCE_BEAT_MS;
/** Rows not renewed for this long are deleted at a beat. */
const PRESENCE_GONE_MS = 10 * 60_000;

/**
 * Presence shared by every server process on one Postgres (`presence_connections`): each process writes its own
 * connections and renews them every `PRESENCE_BEAT_MS`, so `online` answers the same from each, and a person with the
 * app open on one process isn't sent pushes by another. `stop` ends the renewals (shutdown).
 */
export function createPostgresPresence(
  db: Database,
  processId: string = crypto.randomUUID(),
): Presence & { stop(): void } {
  const { presenceConnections: rows } = schema;
  const beat = async () => {
    await db.update(rows).set({ seenAt: new Date() }).where(eq(rows.processId, processId));
    await db.delete(rows).where(lt(rows.seenAt, new Date(Date.now() - PRESENCE_GONE_MS)));
  };
  const timer = setInterval(() => void beat().catch(() => {}), PRESENCE_BEAT_MS);
  timer.unref?.();
  return {
    async connect(orgId, userId, connectionId) {
      await db
        .insert(rows)
        .values({ connectionId, orgId, userId, processId })
        .onConflictDoUpdate({ target: rows.connectionId, set: { seenAt: new Date(), processId } });
    },
    async disconnect(_orgId, _userId, connectionId) {
      await db.delete(rows).where(eq(rows.connectionId, connectionId));
    },
    async online(orgId) {
      const found = await db
        .selectDistinct({ userId: rows.userId })
        .from(rows)
        .where(and(eq(rows.orgId, orgId), gt(rows.seenAt, new Date(Date.now() - PRESENCE_STALE_MS))));
      return found.map((r) => r.userId).sort();
    },
    stop: () => clearInterval(timer),
  };
}
