import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";

/**
 * A sender on an outside chat surface linked to one account (ADR 0187). Ended links are deleted, never kept as
 * revoked. `org_id` is the workspace answering now: checked against membership on every use, since the person may
 * have left it. A `pending` row older than 10 minutes counts as gone when read; there is no sweep.
 */
export const surfaceLinks = pgTable(
  "surface_links",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The surface's id: its lower-cased name. */
    surface: text().notNull(),
    /** The surface's stable, opaque id for the sender, never a phone number or any address that can change hands. */
    externalId: text().notNull(),
    /** What the surface shows of the sender (a number, a handle). Shown only, never looked up by. */
    display: text(),
    profileName: text(),
    status: text().$type<"pending" | "active">().notNull(),
    orgId: uuid().references(() => organizations.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp({ withTimezone: true }),
    lastSeenAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    check("surface_links_status", sql`${t.status} in ('pending', 'active')`),
    uniqueIndex("surface_links_one_per_sender").on(t.surface, t.externalId).where(sql`${t.status} = 'active'`),
    uniqueIndex("surface_links_one_per_account").on(t.userId, t.surface).where(sql`${t.status} = 'active'`),
    index().on(t.userId),
  ],
);

/**
 * What the surface's service should send: a reply of the right hand, or the notice that a link is active. Pulled,
 * never pushed. Closed once (`taken_at`) by the service or by the fallback to an in-app notification, whichever is
 * first. `message_id` has no foreign key: `messages` is partitioned (ADR 0009).
 */
export const surfaceDeliveries = pgTable(
  "surface_deliveries",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Null once the link ended: the row stays so the reply still reaches the person in the app. */
    linkId: uuid().references(() => surfaceLinks.id, { onDelete: "set null" }),
    kind: text().$type<"reply" | "linked">().notNull(),
    messageId: uuid(),
    messageCreatedAt: timestamp({ withTimezone: true }),
    /** The person's surface message the run read last. */
    inReplyTo: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    takenAt: timestamp({ withTimezone: true }),
    outcome: text().$type<"sent" | "unsent" | "fallback" | "dropped">(),
  },
  (t) => [
    check("surface_deliveries_kind", sql`${t.kind} in ('reply', 'linked')`),
    check("surface_deliveries_outcome", sql`${t.outcome} in ('sent', 'unsent', 'fallback', 'dropped')`),
    index("surface_deliveries_open").on(t.createdAt).where(sql`${t.takenAt} is null`),
    // A retried `notifications.message` job finds the reply's row instead of sending it twice.
    uniqueIndex("surface_deliveries_one_per_reply").on(t.messageId).where(sql`${t.kind} = 'reply'`),
  ],
);

/**
 * One row per call to the surface bridge: route, answer and whom it touched, never content. The sender appears only
 * as the first 16 hex characters of the SHA-256 of its id. No foreign keys: the row outlives what it names.
 */
export const surfaceCalls = pgTable(
  "surface_calls",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    method: text().notNull(),
    route: text().notNull(),
    status: integer().notNull(),
    code: text(),
    linkId: uuid(),
    userId: text(),
    orgId: uuid(),
    externalHash: text(),
  },
  (t) => [index().on(t.at)],
);
