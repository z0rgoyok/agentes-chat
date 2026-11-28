import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { channels } from "./chat";
import { organizations } from "./tenancy";

/**
 * Integration apps (ADR 0251): a program a workspace's admin connects (a support bot relaying a Discord or WhatsApp
 * conversation, a form, a monitor) that posts in chosen channels as itself, never as a person, with its own token on
 * the public API and `/mcp`. Its messages are `author_type = 'app'` with `meta.app` set by the server.
 */
export const integrationApps = pgTable(
  "integration_apps",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** One of `ROLE_COLORS`: its avatar is its initial on this color. */
    color: text().notNull().default("graphite"),
    /** sha256 of its token (`agi_…`, shown once). Null: revoked, the app can't call until a new token is made. */
    tokenHash: text().unique(),
    /** The token's last four characters, to tell which one is in use. */
    tokenHint: text(),
    tokenCreatedAt: timestamp({ withTimezone: true }),
    /** Where agents' replies in its channels are POSTed (Standard Webhooks signature). Null: it polls. */
    webhookUrl: text(),
    /** The signing secret (`whsec_…`), sealed with the workspace's key. */
    webhookSecretCiphertext: text(),
    webhookWrappedDataKey: text(),
    webhookKekId: text(),
    /** The last delivery's outcome, for the settings page. */
    webhookLastAt: timestamp({ withTimezone: true }),
    webhookLastError: text(),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Bumped at most once a minute. */
    lastUsedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.orgId), check("integration_apps_name", sql`char_length(${t.name}) between 1 and 64`)],
);

/** The channels an app reads (agents' replies come back to it) and, with `can_post`, posts in. */
export const integrationAppChannels = pgTable(
  "integration_app_channels",
  {
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appId: uuid()
      .notNull()
      .references(() => integrationApps.id, { onDelete: "cascade" }),
    channelId: uuid().notNull(),
    canPost: boolean().notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.channelId] }),
    foreignKey({ columns: [t.orgId, t.channelId], foreignColumns: [channels.orgId, channels.id] }).onDelete("cascade"),
    // An agent's message looks up the apps that read its channel (the webhook's outbox row).
    index().on(t.channelId),
  ],
);
