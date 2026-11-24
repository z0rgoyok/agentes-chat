import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, schema, sql } from "@agenteschat/db";
import { requireChannelAccess } from "../channels";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { publishChannelEvent } from "../events";
import { inMillisecondOf } from "../message-place";
import { getMessage } from "../messages";
import { can } from "../organizations";
import { fileOfConversation, isPinned, liveRefOf } from "./conversation";

const { messages, channelMembers } = schema;

/**
 * A comment's "Resolved" (ADR 0208): a message of a picture's, a video's or a PDF's conversation that points at a place
 * there (a pin) is resolved by whoever writes in that conversation, a person or an agent in it. Its pin leaves the
 * file (the apps show it again on request) and the message stays where it was, with who resolved it and when, in
 * `meta.resolved`; `message.resolved` tells the apps.
 */
export interface ResolvedMark {
  by: { type: "person" | "agent"; id: string };
  at: string;
}

/** `meta.resolved` when it reads right; null otherwise. */
export function resolvedOf(meta: Record<string, unknown> | null | undefined): ResolvedMark | null {
  const r = meta?.resolved as Partial<ResolvedMark> | undefined;
  if (!r || typeof r !== "object" || typeof r.at !== "string") return null;
  const by = r.by as Partial<ResolvedMark["by"]> | undefined;
  if (!by || (by.type !== "person" && by.type !== "agent") || typeof by.id !== "string") return null;
  return { by: { type: by.type, id: by.id }, at: r.at };
}

export type ResolveActor = { type: "person"; userId: string } | { type: "agent"; agentId: string };

/**
 * Resolves a comment, or opens it again (`resolved` false). Refused for a message that is no comment with a pin in a
 * file's conversation, and for whoever doesn't write there. Resolving one already resolved keeps the first.
 */
export async function resolveComment(
  deps: { db: Database; pubsub?: PubSub },
  actor: ResolveActor,
  orgId: string,
  messageId: string,
  resolved: boolean,
): Promise<ResolvedMark | null> {
  const { db } = deps;
  const message = await getMessage(db, orgId, messageId);
  if (!message || message.deletedAt) throw new NotFoundError("Message not found");
  if (actor.type === "person") {
    const { membership } = await requireChannelAccess(db, actor.userId, orgId, message.channelId);
    if (!can(membership, "post")) throw new ForbiddenError();
  } else {
    const [member] = await db
      .select({ agentId: channelMembers.agentId })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, message.channelId), eq(channelMembers.agentId, actor.agentId)));
    if (!member) throw new NotFoundError("Message not found");
  }
  const file = await fileOfConversation(db, orgId, message.channelId);
  const ref = liveRefOf(message.meta);
  if (!file || !ref || ref.artifactId !== file.id || !isPinned(ref.selection)) {
    throw new ValidationError("Only a comment with a pin on a file is resolved", "message.not_comment");
  }
  const now = resolvedOf(message.meta);
  if (resolved && now) return now;
  if (!resolved && !now) return null;
  const mark: ResolvedMark | null = resolved
    ? {
        by: actor.type === "person" ? { type: "person", id: actor.userId } : { type: "agent", id: actor.agentId },
        at: new Date().toISOString(),
      }
    : null;
  const where = and(
    eq(messages.orgId, orgId),
    eq(messages.id, messageId),
    inMillisecondOf(messages.createdAt, message.createdAt),
  );
  await db
    .update(messages)
    .set({
      meta: mark
        ? sql`jsonb_set(${messages.meta}, '{resolved}', ${JSON.stringify(mark)}::jsonb)`
        : sql`${messages.meta} - 'resolved'`,
    })
    .where(where);
  await publishChannelEvent(deps.pubsub, {
    type: "message.resolved",
    channelId: message.channelId,
    messageId,
    threadId: message.threadId,
    resolved: mark,
  });
  return mark;
}
