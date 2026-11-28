import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  desc,
  type Executor,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  schema,
  sql,
} from "@agenteschat/db";
import { type ArtifactDeps, artifactFile } from "../artifacts";
import { markChannelRead } from "../dms";
import { ForbiddenError, NotFoundError } from "../errors";
import { isMediaAfterReply, mediaOf } from "../media";
import { messageLink } from "../message-links";
import { inMillisecondOf, readMarkFor } from "../message-place";
import { fileIdsOf } from "../messages";
import { notifyMessage, quietForPeople } from "../notification-producers";
import { getMembership } from "../organizations";
import { enqueue } from "../outbox";
import { personLocale } from "../requester";
import { RIGHT_HAND } from "../right-hand";
import { lodiFor, postFromLodi } from "../right-hand-proactive";
import { surfaceOn } from "./config";
import { activeLinkOf } from "./links";
import { unreadFor } from "./nudge";
import { confirmPageLink, prunePageLinks } from "./pages";

/**
 * Replies of the right hand that go out on the outside chat surface (ADR 0187) instead of an in-app notification.
 * The surface's service pulls them, sends them and says which it sent. Anything it doesn't take within
 * `SURFACE_FALLBACK_MS`, or says it couldn't send, falls back to the in-app notification. Nothing older than that
 * is listed, so a service back from an outage never sends stale replies.
 */

const { surfaceDeliveries, surfaceLinks, surfaceCalls, messages, agentRuns, agents, channels, channelMembers } = schema;

export const SURFACE_FALLBACK_MS = 5 * 60_000;
export const SURFACE_FALLBACK_JOB = "surface.fallback";
export const SURFACE_DELIVERY_KEEP_MS = 7 * 24 * 3600_000;
const SURFACE_CALL_KEEP_MS = 90 * 24 * 3600_000;

export type DeliveryDeps = { db: Database; pubsub?: PubSub; artifacts?: ArtifactDeps };
type Outcome = "sent" | "unsent" | "fallback" | "dropped";
type CardKind = "question" | "approval" | "secret" | "block" | "poll" | "choices" | "artifact";

export interface SurfaceDeliveryView {
  id: string;
  kind: "reply" | "linked" | "nudge";
  linkId: string;
  externalId: string;
  orgId: string;
  orgName: string;
  locale: string;
  createdAt: string;
  messageId: string | null;
  inReplyTo: string | null;
  text: string;
  files: { id: string; name: string; contentType: string; size: number }[];
  media: { kind: "gif"; id: string; title: string } | { kind: "sticker"; mood: string } | null;
  card: { kind: CardKind; url: string } | null;
  choices: string[] | null;
  /** A nudge's counts as listed (ADR 0234): what waits unread in the workspace, and how much of it blocks someone. */
  nudge: { unread: number; waiting: number } | null;
}

/**
 * Whether the run is a surface turn: the latest person message it read (its trigger, or one steered into it while it
 * worked) came through the bridge. That message, its author and its link; null otherwise.
 */
export async function surfaceOfRun(
  db: Executor,
  orgId: string,
  runId: string,
): Promise<{ userId: string; messageId: string; linkId: string } | null> {
  const [run] = await db
    .select({ channelId: agentRuns.channelId, createdAt: agentRuns.createdAt, triggerId: agentRuns.triggerMessageId })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId)));
  if (!run) return null;
  const read = { id: messages.id, createdAt: messages.createdAt, userId: messages.authorUserId, meta: messages.meta };
  const personal = and(eq(messages.orgId, orgId), eq(messages.authorType, "person"), isNull(messages.deletedAt));
  const [trigger] = await db
    .select(read)
    .from(messages)
    .where(and(personal, eq(messages.id, run.triggerId)));
  // Bounded by the run's start, so the partitioned table reads only the months it may be in (ADR 0009).
  const [steered] = await db
    .select(read)
    .from(messages)
    .where(
      and(
        personal,
        eq(messages.channelId, run.channelId),
        gte(messages.createdAt, run.createdAt),
        sql`${messages.meta} -> 'steeredRunIds' ? ${runId}`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const latest = [trigger, steered]
    .filter((m) => m !== undefined)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const via = latest?.meta.via as { kind?: unknown; linkId?: unknown } | undefined;
  if (!latest?.userId || via?.kind !== "surface" || typeof via.linkId !== "string") return null;
  return { userId: latest.userId, messageId: latest.id, linkId: via.linkId };
}

/**
 * Called by the message's `notifications.message` job: a reply of the right hand to a surface turn, in the linked
 * person's DM with it, becomes a delivery (and its fallback job) instead of an in-app notification. False, with
 * nothing written, for anything else.
 */
export async function queueSurfaceDelivery(db: Database, orgId: string, messageId: string): Promise<boolean> {
  if (!surfaceOn()) return false;
  const [message] = await db
    .select({
      id: messages.id,
      createdAt: messages.createdAt,
      channelId: messages.channelId,
      runId: messages.agentRunId,
      meta: messages.meta,
      builtin: agents.builtin,
      channelKind: channels.kind,
    })
    .from(messages)
    .innerJoin(agents, eq(agents.id, messages.authorAgentId))
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(
      and(
        eq(messages.orgId, orgId),
        eq(messages.id, messageId),
        eq(messages.authorType, "agent"),
        isNull(messages.deletedAt),
      ),
    );
  if (!message?.runId || message.builtin !== RIGHT_HAND || message.channelKind !== "dm") return false;
  if (quietForPeople(message.meta) || isMediaAfterReply(message.meta)) return false;
  const turn = await surfaceOfRun(db, orgId, message.runId);
  if (!turn) return false;
  const [member] = await db
    .select({ id: channelMembers.id })
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.orgId, orgId),
        eq(channelMembers.channelId, message.channelId),
        eq(channelMembers.userId, turn.userId),
      ),
    );
  if (!member) return false;
  const link = await activeLinkOf(db, turn.userId);
  if (!link || link.orgId !== orgId) return false;
  await db.transaction((tx) => insertReply(tx, { orgId, linkId: link.id, message, inReplyTo: turn.messageId }));
  return true;
}

/** A reply's delivery and its fallback job. Nothing when the message already has one (a retried job). */
async function insertReply(
  tx: Executor,
  input: { orgId: string; linkId: string; message: { id: string; createdAt: Date }; inReplyTo: string | null },
) {
  const [row] = await tx
    .insert(surfaceDeliveries)
    .values({
      orgId: input.orgId,
      linkId: input.linkId,
      kind: "reply",
      messageId: input.message.id,
      messageCreatedAt: input.message.createdAt,
      inReplyTo: input.inReplyTo,
    })
    .onConflictDoNothing({
      target: surfaceDeliveries.messageId,
      where: sql`${surfaceDeliveries.kind} = 'reply'`,
    })
    .returning({ id: surfaceDeliveries.id });
  if (!row) return;
  await enqueue(tx, {
    orgId: input.orgId,
    kind: SURFACE_FALLBACK_JOB,
    payload: { deliveryId: row.id },
    runAt: new Date(Date.now() + SURFACE_FALLBACK_MS),
    dedupeKey: `surface.fallback:${row.id}`,
  });
}

/**
 * A voice note from the surface that its job dropped (no words, or refused): no message and no run follow, so the
 * right hand says so in the person's language and the line goes back out on the surface.
 */
export async function tellSurfaceVoiceDropped(
  deps: { db: Database; pubsub?: PubSub },
  clip: { orgId: string; userId: string; via: Record<string, unknown> },
): Promise<void> {
  const surface = surfaceOn();
  if (!surface || clip.via.kind !== "surface") return;
  const link = await activeLinkOf(deps.db, clip.userId);
  if (!link || link.orgId !== clip.orgId || link.id !== clip.via.linkId) return;
  const id = await postFromLodi(deps, clip.orgId, clip.userId, { bodyCode: "surfaceVoiceDropped", push: false });
  if (!id) return;
  const [message] = await deps.db
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.orgId, clip.orgId), eq(messages.id, id)));
  if (message) await insertReply(deps.db, { orgId: clip.orgId, linkId: link.id, message, inReplyTo: null });
}

type Closed = Pick<
  typeof surfaceDeliveries.$inferSelect,
  "id" | "orgId" | "linkId" | "kind" | "messageId" | "messageCreatedAt"
>;

/** Closes open rows once: the service and the fallback job may race, and only the first wins. */
async function close(db: Executor, ids: string[], outcome: Outcome): Promise<Closed[]> {
  if (ids.length === 0) return [];
  return db
    .update(surfaceDeliveries)
    .set({ takenAt: new Date(), outcome })
    .where(and(inArray(surfaceDeliveries.id, ids), isNull(surfaceDeliveries.takenAt)))
    .returning({
      id: surfaceDeliveries.id,
      orgId: surfaceDeliveries.orgId,
      linkId: surfaceDeliveries.linkId,
      kind: surfaceDeliveries.kind,
      messageId: surfaceDeliveries.messageId,
      messageCreatedAt: surfaceDeliveries.messageCreatedAt,
    });
}

/** The person hears of the reply in the app, as if there were no surface. A `linked` row has nothing to tell. */
async function notifyInApp(deps: DeliveryDeps, rows: Closed[]) {
  for (const row of rows) {
    if (row.kind === "reply" && row.messageId) {
      await notifyMessage({ db: deps.db, pubsub: deps.pubsub }, row.orgId, row.messageId);
    }
  }
}

/** The surface showed the reply: the DM reads as read up to it, never moving the mark back. */
async function markSent(deps: DeliveryDeps, rows: Closed[]) {
  for (const row of rows) {
    if (row.kind !== "reply" || !row.messageId || !row.messageCreatedAt || !row.linkId) continue;
    const [place] = await deps.db
      .select({ channelId: messages.channelId, userId: surfaceLinks.userId, readAt: schema.channelReads.lastReadAt })
      .from(messages)
      .innerJoin(surfaceLinks, eq(surfaceLinks.id, row.linkId))
      .leftJoin(
        schema.channelReads,
        and(eq(schema.channelReads.channelId, messages.channelId), eq(schema.channelReads.userId, surfaceLinks.userId)),
      )
      .where(
        and(
          eq(messages.orgId, row.orgId),
          eq(messages.id, row.messageId),
          inMillisecondOf(messages.createdAt, row.messageCreatedAt),
        ),
      );
    const mark = readMarkFor({ id: row.messageId, createdAt: row.messageCreatedAt });
    if (!place || (place.readAt && place.readAt >= mark)) continue;
    try {
      await markChannelRead(deps.db, place.userId, row.orgId, place.channelId, mark, deps.pubsub);
    } catch (error) {
      // No longer in the DM: there is no mark to move.
      if (!(error instanceof NotFoundError)) throw error;
    }
  }
}

const openSince = () => new Date(Date.now() - SURFACE_FALLBACK_MS);

/**
 * What the service should send now, oldest first: open rows younger than `SURFACE_FALLBACK_MS`. Each is checked
 * again: a link that ended falls back to the app; a person no longer in the workspace, or a right hand that may no
 * longer talk to them, drops it.
 */
export async function listSurfaceDeliveries(
  deps: DeliveryDeps,
  limit: number,
  /** Nudges go only to a service that asks for them: an older one can't read their kind. */
  options: { nudges?: boolean } = {},
): Promise<SurfaceDeliveryView[]> {
  const { db } = deps;
  if (!surfaceOn()) return [];
  const rows = await db
    .select({ row: surfaceDeliveries, link: surfaceLinks })
    .from(surfaceDeliveries)
    .leftJoin(surfaceLinks, eq(surfaceLinks.id, surfaceDeliveries.linkId))
    .where(
      and(
        isNull(surfaceDeliveries.takenAt),
        gt(surfaceDeliveries.createdAt, openSince()),
        options.nudges ? undefined : ne(surfaceDeliveries.kind, "nudge"),
      ),
    )
    .orderBy(asc(surfaceDeliveries.createdAt))
    .limit(limit);
  const out: SurfaceDeliveryView[] = [];
  for (const { row, link } of rows) {
    if (link?.status !== "active" || link.orgId !== row.orgId) {
      await notifyInApp(deps, await close(db, [row.id], "fallback"));
      continue;
    }
    const membership = await getMembership(db, link.userId, row.orgId);
    const message = row.messageId ? await messageOf(db, row.orgId, row.messageId, row.messageCreatedAt) : null;
    const gone = row.kind === "reply" && (!message || message.deletedAt);
    if (!membership || gone || !(await lodiFor(db, row.orgId, link.userId))) {
      await close(db, [row.id], "dropped");
      continue;
    }
    const base = {
      id: row.id,
      kind: row.kind,
      linkId: link.id,
      externalId: link.externalId,
      orgId: row.orgId,
      orgName: membership.orgName,
      locale: await personLocale(db, link.userId),
      createdAt: row.createdAt.toISOString(),
      inReplyTo: row.inReplyTo,
    };
    if (row.kind === "nudge") {
      const counts = await unreadFor(db, row.orgId, link.userId, new Date());
      if (counts.unread === 0) {
        await close(db, [row.id], "dropped");
        continue;
      }
      out.push({ ...base, ...NO_CONTENT, nudge: counts });
      continue;
    }
    out.push(message ? { ...base, ...(await contentOf(db, row.orgId, message, link)) } : { ...base, ...NO_CONTENT });
  }
  return out;
}

const NO_CONTENT = { messageId: null, text: "", files: [], media: null, card: null, choices: null, nudge: null };

async function messageOf(db: Executor, orgId: string, id: string, createdAt: Date | null) {
  const [m] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        eq(messages.id, id),
        createdAt ? inMillisecondOf(messages.createdAt, createdAt) : undefined,
      ),
    );
  return m ?? null;
}

type StoredMessage = NonNullable<Awaited<ReturnType<typeof messageOf>>>;

/**
 * A reply as the service sends it: its words, its files, its GIF or sticker, and where its card opens in the app. An
 * approval's card the person decides opens instead a page of its own, where they decide it with their PIN (ADR 0226):
 * minted each time it is listed, so a delivery listed twice carries two links, each good for one browser.
 */
async function contentOf(db: Database, orgId: string, m: StoredMessage, link: { id: string; userId: string }) {
  const { artifacts, artifactVersions, agentQuestions } = schema;
  const ids = fileIdsOf(m.meta);
  const attached = ids.length
    ? await db
        .select({
          id: artifacts.id,
          kind: artifacts.kind,
          name: artifactVersions.fileName,
          title: artifacts.title,
          contentType: artifactVersions.contentType,
          size: artifactVersions.size,
        })
        .from(artifacts)
        .innerJoin(
          artifactVersions,
          and(eq(artifactVersions.artifactId, artifacts.id), eq(artifactVersions.version, artifacts.currentVersion)),
        )
        .where(and(eq(artifacts.orgId, orgId), inArray(artifacts.id, ids), isNull(artifacts.deletedAt)))
    : [];
  const files = ids.flatMap((id) => {
    const a = attached.find((x) => x.id === id && x.kind === "file");
    return a ? [{ id: a.id, name: a.name ?? a.title, contentType: a.contentType, size: a.size }] : [];
  });
  const media = mediaOf(m.meta);
  const meta = m.meta;
  const cardKind: CardKind | null = meta.questionId
    ? "question"
    : meta.approvalId
      ? "approval"
      : meta.secretRequestId
        ? "secret"
        : ((attached.find((a) => a.kind === "block" || a.kind === "poll" || a.kind === "choices")?.kind as
            | CardKind
            | undefined) ??
          // A document, table, diff or the like has no bytes to send: the person opens it in the app.
          (attached.some((a) => a.kind !== "file") ? "artifact" : null));
  const [question] =
    typeof meta.questionId === "string"
      ? await db
          .select({ choices: agentQuestions.choices })
          .from(agentQuestions)
          .where(and(eq(agentQuestions.orgId, orgId), eq(agentQuestions.id, meta.questionId)))
      : [];
  return {
    messageId: m.id,
    text: m.body,
    files,
    media: media
      ? media.kind === "gif"
        ? { kind: "gif" as const, id: media.id, title: media.title }
        : { kind: "sticker" as const, mood: media.mood }
      : null,
    card: cardKind
      ? {
          kind: cardKind,
          url:
            (cardKind === "approval" &&
              typeof meta.approvalId === "string" &&
              (await confirmPageLink(db, {
                orgId,
                linkId: link.id,
                userId: link.userId,
                approvalId: meta.approvalId,
              }))) ||
            messageLink(orgId, m),
        }
      : null,
    choices: question?.choices?.length ? question.choices : null,
    nudge: null,
  };
}

/**
 * The service's word on what it listed: `sent` marks the DM read up to each reply, `unsent` falls back to the in-app
 * notification. Ids closed before (by an earlier call or the fallback) come back in `late` and change nothing.
 */
export async function takeDeliveries(
  deps: DeliveryDeps,
  input: { sent: string[]; unsent: string[] },
): Promise<{ sent: number; unsent: number; late: string[] }> {
  const sent = await close(deps.db, input.sent, "sent");
  const unsent = await close(deps.db, input.unsent, "unsent");
  await markSent(deps, sent);
  await notifyInApp(deps, unsent);
  const closed = new Set([...sent, ...unsent].map((r) => r.id));
  return {
    sent: sent.length,
    unsent: unsent.length,
    late: [...input.sent, ...input.unsent].filter((id) => !closed.has(id)),
  };
}

/** Job `surface.fallback`: not taken in time, so the person hears of it in the app. A row already closed is left. */
export async function fallBack(deps: DeliveryDeps, deliveryId: string): Promise<void> {
  await notifyInApp(deps, await close(deps.db, [deliveryId], "fallback"));
}

/**
 * The bytes of one file of a delivery's reply, read as the linked person. `surface.file_gone` when the delivery is
 * unknown or older than `SURFACE_DELIVERY_KEEP_MS`, its link ended, the file isn't on its message, or the bytes are
 * gone: the same answer for each.
 */
export async function deliveryFile(deps: DeliveryDeps, deliveryId: string, artifactId: string) {
  const gone = () => new NotFoundError("This file is not available", "surface.file_gone");
  if (!deps.artifacts || !surfaceOn()) throw gone();
  const [found] = await deps.db
    .select({ row: surfaceDeliveries, userId: surfaceLinks.userId })
    .from(surfaceDeliveries)
    .innerJoin(surfaceLinks, eq(surfaceLinks.id, surfaceDeliveries.linkId))
    .where(
      and(
        eq(surfaceDeliveries.id, deliveryId),
        eq(surfaceDeliveries.kind, "reply"),
        isNotNull(surfaceDeliveries.messageId),
        gt(surfaceDeliveries.createdAt, new Date(Date.now() - SURFACE_DELIVERY_KEEP_MS)),
      ),
    );
  const row = found?.row;
  const message = row?.messageId ? await messageOf(deps.db, row.orgId, row.messageId, row.messageCreatedAt) : null;
  if (!found || !row || !message || message.deletedAt || !fileIdsOf(message.meta).includes(artifactId)) throw gone();
  try {
    const file = await artifactFile(deps.artifacts, found.userId, row.orgId, artifactId);
    return {
      body: file.body,
      contentType: file.contentType,
      size: file.body.byteLength,
      name: file.filename,
      audit: { linkId: row.linkId, userId: found.userId, orgId: row.orgId },
    };
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) throw gone();
    throw error;
  }
}

/** Deliveries after `SURFACE_DELIVERY_KEEP_MS`, bridge call records after 90 days. Returns the rows deleted. */
export async function pruneSurfaceRows(db: Executor): Promise<number> {
  const now = Date.now();
  const deliveries = await db
    .delete(surfaceDeliveries)
    .where(lt(surfaceDeliveries.createdAt, new Date(now - SURFACE_DELIVERY_KEEP_MS)))
    .returning({ id: surfaceDeliveries.id });
  const calls = await db
    .delete(surfaceCalls)
    .where(lt(surfaceCalls.at, new Date(now - SURFACE_CALL_KEEP_MS)))
    .returning({ id: surfaceCalls.id });
  return deliveries.length + calls.length + (await prunePageLinks(db));
}
