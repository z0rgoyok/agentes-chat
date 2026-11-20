import { index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";

/**
 * A picture or a video a person adds to their feedback (ADR 0160). Its bytes are in the platform's blob store under
 * `feedback/{id}`. Uploaded, it lasts an hour; sent with a feedback, thirty days, behind a link only the email
 * carries (`tokenHash`). It belongs to the person: a workspace (`orgId`) is only where they were when they sent it.
 */
export const feedbackFiles = pgTable(
  "feedback_files",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid().references(() => organizations.id, { onDelete: "set null" }),
    name: text().notNull(),
    /** What its first bytes say it is, never what the upload claimed. */
    contentType: text().notNull(),
    size: integer().notNull(),
    /** SHA-256 of the link's token, set when the feedback is sent. */
    tokenHash: text().unique(),
    sentAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId)],
);

/**
 * A member asked whoever runs the server for help (ADR 0160): the proof that they did. Their workspace, their
 * account, how the request arrived, and two facts about what they reported. What they wrote (`text`) and what the
 * thing they reported says (`about`) are kept only on a server whose operator set `OPERATOR_API_REVEAL_TOKEN`, for 90
 * days; the row itself goes after a year.
 */
export const supportRequests = pgTable(
  "support_requests",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `form`, `offer` (a report an agent offered, sent by the person), `email` or `operator` (recorded by the operator). */
    source: text().notNull(),
    /** The writer's own id for it: sent again, it is one request. */
    ref: text(),
    /** What kind of thing was reported: `message`, `agent_message`, `card` or `other`; null when nothing was chosen. */
    aboutKind: text(),
    /** The reported message, when it is one of this workspace's. No foreign key: `messages` is partitioned. */
    messageId: uuid(),
    text: text(),
    about: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId, t.createdAt), index().on(t.userId), unique().on(t.orgId, t.source, t.ref)],
);
