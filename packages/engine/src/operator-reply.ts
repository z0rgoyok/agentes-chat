import { randomUUID } from "node:crypto";
import { and, type Database, type Executor, eq, gte, type SQL, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { emailLocale, queueEmail } from "./email";
import { stripInvisible } from "./email/inert";
import { ForbiddenError, TooManyError, ValidationError } from "./errors";
import { pgSafeText } from "./format";
import { recordSupportReplied } from "./operator-events";
import {
  noSuchRecord,
  REPLIES_PER_DAY,
  REPLIES_PER_REQUEST,
  type ReplyTemplate,
  requireRequester,
} from "./operator-reveal";
import { cloudNotice } from "./standing";
import { SUPPORT_WORDS_KEEP_DAYS } from "./support-requests";

const { operatorEvents, supportRequests, users } = schema;

const DAY_MS = 86_400_000;

export interface ReplyInput {
  requestId: string;
  /** One of core's own sentences, or `text`: exactly one of the two. */
  template?: ReplyTemplate;
  /** The operator's own words, as plain text. */
  text?: string;
  /** Who answers, as the caller names them. */
  operator: string;
  assistedByAi: boolean;
}

/** How many replies went out since `since`, counted from the events they wrote. */
async function repliesSince(tx: Executor, since: Date, ...only: SQL[]) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(operatorEvents)
    .where(and(eq(operatorEvents.type, "support.replied"), gte(operatorEvents.createdAt, since), ...only));
  return row?.n ?? 0;
}

/**
 * The operator answers a member's support request (ADR 0056) at the address of their account as it is now, in their
 * language: one of core's sentences, or the operator's own words. In order: the reply's shape; the instance's day;
 * the request, in this workspace (one answer for another workspace's and for nobody's); its age; its member, still
 * one; its replies so far; then the record (the operator's feed and the workspace's audit log) and the email's job, in
 * one transaction. A reply reads nothing. Its words are in the email's job alone, until the email is sent or given up
 * (`forgetReplyWords`).
 */
export async function operatorReply(
  db: Database,
  orgId: string,
  input: ReplyInput,
  mail: { publicUrl: string; support: string | null },
  now = new Date(),
) {
  const text = input.text === undefined ? undefined : pgSafeText(input.text).trim();
  if ((input.template === undefined) === (text === undefined)) {
    throw new ValidationError("template or text: a reply is one of them, never both");
  }
  if (text !== undefined && stripInvisible(text) === "") throw new ValidationError("text: it says nothing");
  return db.transaction(async (tx) => {
    // ponytail: two replies at the same instant can pass one over a count; a lock on the instance if it matters.
    if ((await repliesSince(tx, new Date(now.getTime() - DAY_MS))) >= REPLIES_PER_DAY) {
      throw new TooManyError(
        `This server's ${REPLIES_PER_DAY} replies of the last 24 hours are used`,
        "reveal.limit_day",
      );
    }
    // The account's address and language as they are now, whatever they were when it asked.
    const [request] = await tx
      .select({
        id: supportRequests.id,
        userId: supportRequests.userId,
        createdAt: supportRequests.createdAt,
        email: users.email,
        locale: users.locale,
      })
      .from(supportRequests)
      .innerJoin(users, eq(users.id, supportRequests.userId))
      .where(and(eq(supportRequests.id, input.requestId), eq(supportRequests.orgId, orgId)));
    if (!request) throw noSuchRecord();
    if (request.createdAt.getTime() <= now.getTime() - SUPPORT_WORDS_KEEP_DAYS * DAY_MS) {
      throw new ForbiddenError(
        `This request was made over ${SUPPORT_WORDS_KEEP_DAYS} days ago: its words are no longer kept`,
        "reveal.request_old",
      );
    }
    await requireRequester(tx, orgId, request.userId);
    // ponytail: reads the feed from the request's day on, by its time index; an index on the request's id if the
    // feed of 90 days grows too long to scan.
    const replies = await repliesSince(
      tx,
      request.createdAt,
      eq(operatorEvents.orgId, orgId),
      sql`${operatorEvents.data}->>'requestId' = ${request.id}`,
    );
    if (replies >= REPLIES_PER_REQUEST) {
      throw new TooManyError(`This request already has its ${REPLIES_PER_REQUEST} replies`, "reveal.limit_request");
    }

    const said = { template: input.template ?? "text", chars: text?.length ?? 0, assistedByAi: input.assistedByAi };
    await recordSupportReplied(tx, {
      orgId,
      userId: request.userId,
      requestId: request.id,
      ...said,
      operator: pgSafeText(input.operator),
    });
    await recordAudit(tx, {
      orgId,
      actor: { type: "system", id: null },
      action: "operator.support_replied",
      target: { type: "support_request", id: request.id },
      // Who "the operator" is to the workspace's people: the apps name agentes.chat's own support there.
      details: { ...said, ...cloudNotice() },
      onBehalfOfUserId: request.userId,
    });
    // A failed query's error says the values it was given, and this one's hold the reply: whatever logs or reports
    // the failure gets an error without them.
    await queueEmail(tx, {
      orgId,
      key: `support-reply:${randomUUID()}`,
      to: [request.email],
      template: {
        kind: "support_reply",
        locale: emailLocale(request.locale),
        ...(input.template ? { reply: input.template } : { text }),
        assistedByAi: input.assistedByAi,
        support: mail.support,
        url: mail.publicUrl,
      },
    }).catch(() => {
      throw new Error("The reply's email could not be queued");
    });
    return { requestId: request.id, replies: replies + 1 };
  });
}
