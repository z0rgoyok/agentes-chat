import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Extra hostnames this server answers on besides `PUBLIC_URL`'s, each with the look its pages before sign-in show
 * (ADR 0194). Registered only through the operator API. The server's, not a tenant's, so no `org_id`.
 */
export const hosts = pgTable(
  "hosts",
  {
    /** Lower case, a hostname only (`normalizeHost`). */
    host: text().primaryKey(),
    name: text().notNull(),
    /** `#rrggbb` in lower case; null: the design system's own. */
    accent: text(),
    /** The stored file's key in the platform's bucket; null: the name alone. */
    logo: text(),
    /** The pages before sign-in end with the line naming the software behind them. */
    poweredBy: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("hosts_host", sql`${t.host} = lower(${t.host}) and char_length(${t.host}) <= 253`),
    check("hosts_name", sql`char_length(${t.name}) between 1 and 60`),
    check("hosts_accent", sql`${t.accent} ~ '^#[0-9a-f]{6}$'`),
  ],
);
