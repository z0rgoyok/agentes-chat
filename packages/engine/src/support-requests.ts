import {
  and,
  type Database,
  desc,
  type Executor,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  or,
  schema,
  sql,
} from "@agenteschat/db";
import { decodeCursor } from "./cursor";
import { recordOperatorEvent } from "./operator-events";
import { listedOf, ms, olderThan, orgExists, type PageQuery, pageOf, UuidCursor, uuidOf } from "./operator-paging";
import { getMembership } from "./organizations";
import type { OutboxJob } from "./outbox";

/*
 * Support requests (ADR 0160, ADR 0056): the record that a member asked whoever runs the server for help. It is what
 * an operator's read of that workspace's content for a member rests on, so only the member's own act writes one (the
 * feedback form, their own send of a report an agent offered) or the operator recording a request that came another
 * way. Never an agent's send: an agent can be steered.
 */

const { supportRequests, messages, outbox } = schema;

export const SUPPORT_SOURCES = ["form", "offer", "email", "operator"] as const;
export type SupportSource = (typeof SUPPORT_SOURCES)[number];
/** The sources the operator records itself, for a request that reached it outside the app. */
export const SUPPORT_OPERATOR_SOURCES = ["email", "operator"] as const;
export const SUPPORT_ABOUT_KINDS = ["message", "agent_message", "card", "other"] as const;
export type SupportAboutKind = (typeof SUPPORT_ABOUT_KINDS)[number];
export const SUPPORT_REF_MAX = 200;
/** What a member wrote, and what the thing they reported says: as much as the feedback form takes of each. */
export const SUPPORT_TEXT_MAX = 4000;
/** Days the words are kept, then the row: the row is the proof of every read made under it. */
export const SUPPORT_WORDS_KEEP_DAYS = 90;
export const SUPPORT_REQUEST_KEEP_DAYS = 365;

// The form's own words for what was right-clicked. Anything else it sends (an element's role, as the browser names
// it) is a word the person's browser chose: it is kept as `other`, and the word nowhere.
const FORM_KINDS = new Map<string, SupportAboutKind>([
  ["message", "message"],
  ["agent message", "agent_message"],
  ["card", "card"],
]);

/** What kind of thing a feedback form says it is about; null when it names nothing. */
export const supportAboutKind = (formKind: string | null | undefined): SupportAboutKind | null =>
  formKind ? (FORM_KINDS.get(formKind) ?? "other") : null;

/** The form's "Message id" fact, when it is the id of a message of this workspace; else null. */
export async function reportedMessageId(db: Executor, orgId: string, facts: readonly [string, string][] | undefined) {
  const id = uuidOf(facts?.find(([label]) => label === "Message id")?.[1]);
  if (!id) return null;
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, id), eq(messages.orgId, orgId)));
  return row?.id ?? null;
}

export interface NewSupportRequest {
  orgId: string;
  userId: string;
  source: SupportSource;
  /** The writer's own id for it: the same one again is the same request. */
  ref?: string | null;
  aboutKind?: SupportAboutKind | null;
  messageId?: string | null;
  text?: string | null;
  about?: string | null;
  /** Whether this server keeps the words (its operator set the reveal token): without it the row holds ids alone. */
  keepWords: boolean;
}

const cut = (text: string | null | undefined) => text?.trim().slice(0, SUPPORT_TEXT_MAX) || null;

/**
 * Records that a member asked for help, in the caller's transaction, and tells the operator's feed
 * (`support.requested`: ids and the source, never a word). The same `ref` from the same source is the same request:
 * its id comes back and nothing is written.
 */
export async function recordSupportRequest(tx: Executor, input: NewSupportRequest) {
  const where = { orgId: input.orgId, source: input.source, ref: input.ref?.slice(0, SUPPORT_REF_MAX) || null };
  const [row] = await tx
    .insert(supportRequests)
    .values({
      ...where,
      userId: input.userId,
      aboutKind: input.aboutKind ?? null,
      messageId: input.messageId ?? null,
      text: input.keepWords ? cut(input.text) : null,
      about: input.keepWords ? cut(input.about) : null,
    })
    .onConflictDoNothing()
    .returning({ id: supportRequests.id });
  if (row) {
    await recordOperatorEvent(tx, {
      type: "support.requested",
      orgId: input.orgId,
      userId: input.userId,
      data: { requestId: row.id, source: input.source },
    });
    return row.id;
  }
  const [known] = where.ref
    ? await tx
        .select({ id: supportRequests.id })
        .from(supportRequests)
        .where(
          and(
            eq(supportRequests.orgId, where.orgId),
            eq(supportRequests.source, where.source),
            eq(supportRequests.ref, where.ref),
          ),
        )
    : [];
  if (!known) throw new Error("support request not stored");
  return known.id;
}

const listed = {
  id: supportRequests.id,
  userId: supportRequests.userId,
  source: supportRequests.source,
  aboutKind: supportRequests.aboutKind,
  messageId: supportRequests.messageId,
  // Measured in the database: the words are never read out to say whether there are any.
  hasWords: sql<boolean>`(${supportRequests.text} is not null or ${supportRequests.about} is not null)`,
  createdAt: ms(supportRequests.createdAt),
};

const selectListed = (db: Executor) => db.select(listed).from(supportRequests);
type Listed = Awaited<ReturnType<typeof selectListed>>[number];

// A word leaves only when the list written here holds it: anything else in its place reads as absent.
const requestOf = ({ source, aboutKind, ...row }: Listed) => ({
  ...row,
  source: listedOf(SUPPORT_SOURCES, source),
  aboutKind: listedOf(SUPPORT_ABOUT_KINDS, aboutKind),
});

export type OperatorSupportRequest = ReturnType<typeof requestOf>;

/**
 * A workspace's support requests, newest first: who asked, how it arrived, when, what kind of thing was reported and
 * which message, and whether its words are kept. Never the words. Null: no such workspace.
 */
export async function operatorSupportRequests(db: Database, orgId: string, query: PageQuery) {
  const after = query.cursor ? decodeCursor(query.cursor, UuidCursor) : null;
  if (!(await orgExists(db, orgId))) return null;
  const rows = await selectListed(db)
    .where(and(eq(supportRequests.orgId, orgId), olderThan(listed.createdAt, supportRequests.id, after)))
    .orderBy(desc(listed.createdAt), desc(supportRequests.id))
    .limit(query.limit + 1);
  const page = pageOf(rows, query.limit, (r) => [r.createdAt, r.id]);
  return { requests: page.items.map(requestOf), next: page.next };
}

/**
 * The operator records that a member asked for help another way (a mail, a call). The account must be a member the
 * app would let in now (not blocked, not being deleted), else null. The same `ref` again answers the first request.
 */
export async function operatorRecordSupportRequest(
  db: Database,
  orgId: string,
  input: { userId: string; source: (typeof SUPPORT_OPERATOR_SOURCES)[number]; ref: string; text?: string },
  keepWords: boolean,
): Promise<OperatorSupportRequest | null> {
  if (!(await getMembership(db, input.userId, orgId))) return null;
  return db.transaction(async (tx) => {
    const id = await recordSupportRequest(tx, { orgId, ...input, keepWords });
    const [row] = await selectListed(tx).where(eq(supportRequests.id, id));
    if (!row) throw new Error("support request not stored");
    return requestOf(row);
  });
}

/**
 * How far back the daily sweep looks for a reply's finished job: the sweep runs once a day and a job ends within
 * hours of being made, so two days reach every job the sweep before ran too early for.
 */
const REPLY_SWEEP_DAYS = 2;

/**
 * The operator's own words in a reply to a request (`operatorReply`) leave the reply's email job once the email is
 * sent or given up: the job keeps whom it went to and how it ended, as any email's does, never what it said. With no
 * `job`: every finished one made in the last `REPLY_SWEEP_DAYS`, for a job whose worker died before it got here.
 */
export async function forgetReplyWords(db: Executor, job?: OutboxJob, now = new Date()) {
  if (job && (job.payload.template as { kind?: unknown } | undefined)?.kind !== "support_reply") return;
  // ponytail: without a job, one daily read of those days' jobs by their time index; an index on the email's kind if
  // they grow too long to scan.
  await db
    .update(outbox)
    .set({ payload: sql`${outbox.payload} #- '{template,text}'` })
    .where(
      and(
        job
          ? eq(outbox.id, job.id)
          : and(
              inArray(outbox.status, ["done", "failed"]),
              gt(outbox.createdAt, new Date(now.getTime() - REPLY_SWEEP_DAYS * 86_400_000)),
            ),
        eq(outbox.kind, "email.send"),
        sql`${outbox.payload}#>>'{template,kind}' = 'support_reply'`,
        sql`${outbox.payload}#>'{template,text}' is not null`,
      ),
    );
}

/**
 * The daily sweep: a request's words go after `SUPPORT_WORDS_KEEP_DAYS`, the row after `SUPPORT_REQUEST_KEEP_DAYS`,
 * and a reply's words its job still holds though it finished (`forgetReplyWords`). Returns how many requests of each.
 */
export async function sweepSupportRequests(db: Executor, now = new Date()) {
  const before = (days: number) => new Date(now.getTime() - days * 86_400_000);
  await forgetReplyWords(db, undefined, now);
  const deleted = await db
    .delete(supportRequests)
    .where(lt(supportRequests.createdAt, before(SUPPORT_REQUEST_KEEP_DAYS)))
    .returning({ id: supportRequests.id });
  const blanked = await db
    .update(supportRequests)
    .set({ text: null, about: null })
    .where(
      and(
        lt(supportRequests.createdAt, before(SUPPORT_WORDS_KEEP_DAYS)),
        or(isNotNull(supportRequests.text), isNotNull(supportRequests.about)),
      ),
    )
    .returning({ id: supportRequests.id });
  return { blanked: blanked.length, deleted: deleted.length };
}
