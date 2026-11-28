import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
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
    /**
     * The person's six-digit PIN for confirming a sensitive act from the surface (ADR 0226), hashed. Null until they
     * choose one. It goes with the link, so a new password or an unlink clears it too.
     */
    pinHash: text(),
    pinFailures: integer().notNull().default(0),
    /** Three wrong PINs in a row lock confirming until then. */
    pinLockedUntil: timestamp({ withTimezone: true }),
    /** Locks since the last right PIN: each one lasts longer (15 minutes, an hour, then a day). */
    pinLockouts: integer().notNull().default(0),
    /**
     * The unread nudge (ADR 0234): on, after how many hours unread, never between `quiet_from` and `quiet_to` (whole
     * hours in the person's time zone). The person's own settings; they go with the link.
     */
    nudgeOn: boolean().notNull().default(true),
    nudgeAfterHours: smallint().notNull().default(4),
    quietFrom: smallint().notNull().default(22),
    quietTo: smallint().notNull().default(8),
    /** The last nudge queued: at most one a day. */
    nudgedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    check("surface_links_status", sql`${t.status} in ('pending', 'active')`),
    check(
      "surface_links_nudge",
      sql`${t.nudgeAfterHours} between 1 and 24 and ${t.quietFrom} between 0 and 23 and ${t.quietTo} between 0 and 23`,
    ),
    uniqueIndex("surface_links_one_per_sender").on(t.surface, t.externalId).where(sql`${t.status} = 'active'`),
    uniqueIndex("surface_links_one_per_account").on(t.userId, t.surface).where(sql`${t.status} = 'active'`),
    index().on(t.userId),
  ],
);

/**
 * What the surface's service should send: a reply of the right hand, the notice that a link is active, or a nudge
 * about what waits unread (only to a service that asks for nudges). Pulled,
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
    kind: text().$type<"reply" | "linked" | "nudge">().notNull(),
    messageId: uuid(),
    messageCreatedAt: timestamp({ withTimezone: true }),
    /** The person's surface message the run read last. */
    inReplyTo: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    takenAt: timestamp({ withTimezone: true }),
    outcome: text().$type<"sent" | "unsent" | "fallback" | "dropped">(),
  },
  (t) => [
    check("surface_deliveries_kind", sql`${t.kind} in ('reply', 'linked', 'nudge')`),
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

/**
 * A page of ours opened from a link sent on the surface (ADR 0226): one page, opened once within 10 minutes, then
 * open for its kind's time in that browser alone (`browser_hash`). It ends with its surface link.
 */
export const surfacePageLinks = pgTable(
  "surface_page_links",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    linkId: uuid()
      .notNull()
      .references(() => surfaceLinks.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text().$type<"confirm" | "screen" | "control">().notNull(),
    /** What the page shows: an approval for `confirm`. */
    targetId: uuid().notNull(),
    /** SHA-256 of the token in the URL; the token itself is never kept. */
    tokenHash: text().notNull(),
    /** SHA-256 of the secret the first browser to open it holds in a cookie. */
    browserHash: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    openedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    check("surface_page_links_kind", sql`${t.kind} in ('confirm', 'screen', 'control')`),
    uniqueIndex().on(t.tokenHash),
    index().on(t.linkId),
    index().on(t.createdAt),
  ],
);
