import {
  and,
  type Database,
  type Executor,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  schema,
  sql,
} from "@agenteschat/db";
import { zonedParts } from "../cron";
import { NotFoundError } from "../errors";
import { surfaceOn } from "./config";

/**
 * The unread nudge (ADR 0234): core decides when a linked person hears on the surface that something waits unread in
 * the app, since core holds what is unread and which phones its pushes reach. The service only sends what it is
 * given (a template outside the chat app's reply window), and only when it asks for nudges.
 */

const { surfaceLinks, surfaceDeliveries, notifications, pushDevices, organizationMembers, organizationSettings } =
  schema;

/** At most one nudge a day per person. */
export const NUDGE_GAP_MS = 24 * 3_600_000;
/** Only to people who wrote through the surface this recently. */
export const NUDGE_RECENT_MS = 30 * 24 * 3_600_000;

export interface NudgeSettings {
  on: boolean;
  /** Hours something stays unread before the nudge, 1 to 24. */
  afterHours: number;
  /** No nudge from `quietFrom` until `quietTo` (whole hours, the person's time zone); equal: no quiet hours. */
  quietFrom: number;
  quietTo: number;
}

export const nudgeOf = (link: typeof surfaceLinks.$inferSelect): NudgeSettings => ({
  on: link.nudgeOn,
  afterHours: link.nudgeAfterHours,
  quietFrom: link.quietFrom,
  quietTo: link.quietTo,
});

export function inQuietHours(hour: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** The person changes their nudge on their own active link. `surface.link_gone` when it isn't theirs or active. */
export async function setNudge(
  db: Database,
  userId: string,
  linkId: string,
  input: Partial<NudgeSettings>,
): Promise<NudgeSettings> {
  const changes = {
    ...(input.on !== undefined ? { nudgeOn: input.on } : {}),
    ...(input.afterHours !== undefined ? { nudgeAfterHours: input.afterHours } : {}),
    ...(input.quietFrom !== undefined ? { quietFrom: input.quietFrom } : {}),
    ...(input.quietTo !== undefined ? { quietTo: input.quietTo } : {}),
  };
  const mine = and(eq(surfaceLinks.id, linkId), eq(surfaceLinks.userId, userId), eq(surfaceLinks.status, "active"));
  // Drizzle throws on an update with nothing to set: an empty change reads the settings as they are.
  const [row] =
    Object.keys(changes).length === 0
      ? await db.select().from(surfaceLinks).where(mine)
      : await db.update(surfaceLinks).set(changes).where(mine).returning();
  if (!row) throw new NotFoundError("This link is gone", "surface.link_gone");
  return nudgeOf(row);
}

/** What waits unread for the person in the workspace since before `before`: items, and those that block someone. */
export async function unreadFor(db: Executor, orgId: string, userId: string, before: Date, at = new Date()) {
  const [row] = await db
    .select({
      unread: sql<number>`coalesce(sum(${notifications.count}), 0)::int`,
      waiting: sql<number>`coalesce(sum(${notifications.count}) filter (where ${notifications.waiting}), 0)::int`,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.orgId, orgId),
        eq(notifications.userId, userId),
        isNull(notifications.doneAt),
        isNull(notifications.readAt),
        or(isNull(notifications.snoozedUntil), lte(notifications.snoozedUntil, at)),
        lte(notifications.createdAt, before),
      ),
    );
  return { unread: row?.unread ?? 0, waiting: row?.waiting ?? 0 };
}

/**
 * Queues a nudge for every linked person due one now: nudges on, wrote through the surface in the last 30 days, not
 * nudged in the last day, outside their quiet hours, no phone of theirs taking pushes (a push already reached
 * them), and something unread in the link's workspace for longer than their delay. The claim on `nudged_at` is
 * conditional, so two processes sweeping at once queue one.
 */
export async function queueSurfaceNudges(db: Database, at = new Date()): Promise<number> {
  const surface = surfaceOn();
  if (!surface) return 0;
  const candidates = await db
    .select({
      link: surfaceLinks,
      timezone: sql<string>`coalesce(${organizationMembers.timezone}, ${organizationSettings.timezone}, 'UTC')`,
    })
    .from(surfaceLinks)
    .innerJoin(
      organizationMembers,
      and(eq(organizationMembers.orgId, surfaceLinks.orgId), eq(organizationMembers.userId, surfaceLinks.userId)),
    )
    .leftJoin(organizationSettings, eq(organizationSettings.orgId, surfaceLinks.orgId))
    .where(
      and(
        eq(surfaceLinks.surface, surface.id),
        eq(surfaceLinks.status, "active"),
        eq(surfaceLinks.nudgeOn, true),
        isNotNull(surfaceLinks.orgId),
        gt(surfaceLinks.lastSeenAt, new Date(at.getTime() - NUDGE_RECENT_MS)),
        or(isNull(surfaceLinks.nudgedAt), lte(surfaceLinks.nudgedAt, new Date(at.getTime() - NUDGE_GAP_MS))),
      ),
    );
  let queued = 0;
  for (const { link, timezone } of candidates) {
    const orgId = link.orgId;
    if (!orgId) continue;
    let hour: number;
    try {
      hour = zonedParts(at, timezone).hour;
    } catch {
      hour = zonedParts(at, "UTC").hour;
    }
    if (inQuietHours(hour, link.quietFrom, link.quietTo)) continue;
    const [phone] = await db
      .select({ id: pushDevices.id })
      .from(pushDevices)
      .where(
        and(
          eq(pushDevices.userId, link.userId),
          inArray(pushDevices.platform, ["ios", "android"]),
          gt(pushDevices.lastSeenAt, new Date(at.getTime() - NUDGE_RECENT_MS)),
        ),
      )
      .limit(1);
    if (phone) continue;
    const since = new Date(at.getTime() - link.nudgeAfterHours * 3_600_000);
    if ((await unreadFor(db, orgId, link.userId, since, at)).unread === 0) continue;
    const claimed = await db.transaction(async (tx) => {
      const [mine] = await tx
        .update(surfaceLinks)
        .set({ nudgedAt: at })
        .where(
          and(
            eq(surfaceLinks.id, link.id),
            or(isNull(surfaceLinks.nudgedAt), lte(surfaceLinks.nudgedAt, new Date(at.getTime() - NUDGE_GAP_MS))),
          ),
        )
        .returning({ id: surfaceLinks.id });
      if (!mine) return false;
      await tx.insert(surfaceDeliveries).values({ orgId, linkId: link.id, kind: "nudge", createdAt: at });
      return true;
    });
    if (claimed) queued++;
  }
  return queued;
}
