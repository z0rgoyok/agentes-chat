import type { PubSub, RateLimiter } from "@agenteschat/adapters";
import { retryInSeconds } from "@agenteschat/adapters";
import { and, asc, type Database, eq, gt, inArray, isNull, schema, sql } from "@agenteschat/db";
import { ForbiddenError, NotFoundError, TooManyError, ValidationError } from "../errors";
import { publishChannelEvent, publishMessageCreated } from "../events";
import { insertMessageWithRuns, messageView } from "../messages";
import { standingRefusal } from "../standing";
import { cleanName, INTEGRATION_LIMITS, type IntegrationPrincipal } from "./apps";
import { appAuthorOf } from "./author";

const { agents, channels, messages, users } = schema;

/**
 * Limits of an integration app's own calls (ADR 0251), on top of its token: everything it calls, and what it posts.
 * Per app, so one busy relay never slows another.
 */
export const INTEGRATION_RATE = {
  callsMinute: { limit: 120, windowMs: 60_000 },
  callsDay: { limit: 10_000, windowMs: 86_400_000 },
  postsMinute: { limit: 30, windowMs: 60_000 },
  postsDay: { limit: 2_000, windowMs: 86_400_000 },
  /** Calls with a token that names no app, per address. */
  badTokenMinute: { limit: 30, windowMs: 60_000 },
} as const;

export interface TrafficDeps {
  db: Database;
  pubsub: PubSub;
  rateLimiter: RateLimiter;
  /** Wakes the in-process workers after a post (the agent starts sooner than at the next poll). */
  wakeWorkers?: () => void;
}

/** Counts one call of the app against `rules` (keys `integration:<what>:<app>`); throws `rate_limited` past them. */
export async function consumeIntegration(
  limiter: RateLimiter,
  appId: string,
  rules: readonly (readonly [string, { limit: number; windowMs: number }])[],
) {
  for (const [what, rule] of rules) {
    const r = await limiter.consume(`integration:${what}:${appId}`, rule);
    if (!r.allowed) {
      throw new TooManyError("Too many requests from this app", "rate_limited", {
        retryAfter: retryInSeconds(r.resetAt),
      });
    }
  }
}

/** Counts one request of the app (the public API's and `/mcp`'s), per minute and per day. */
export const consumeIntegrationCall = (limiter: RateLimiter, appId: string) =>
  consumeIntegration(limiter, appId, [
    ["m", INTEGRATION_RATE.callsMinute],
    ["d", INTEGRATION_RATE.callsDay],
  ]);

/** Nothing is read or posted while the workspace is paused, suspended or being deleted. */
export async function assertAppMayWork(db: Database, p: IntegrationPrincipal) {
  const refusal = await standingRefusal(db, p.orgId);
  if (refusal) throw refusal;
}

export interface AppChannel {
  id: string;
  name: string;
  topic: string;
  can_post: boolean;
}

/** The channels the app was given, by name. */
export async function appChannels(db: Database, p: IntegrationPrincipal): Promise<AppChannel[]> {
  const ids = [...p.channels.keys()];
  if (!ids.length) return [];
  const rows = await db
    .select({ id: channels.id, name: channels.name, topic: channels.topic })
    .from(channels)
    .where(and(eq(channels.orgId, p.orgId), inArray(channels.id, ids), isNull(channels.archivedAt)))
    .orderBy(asc(channels.name));
  return rows.map((r) => ({ ...r, can_post: p.channels.get(r.id)?.canPost === true }));
}

const HIDDEN_TEXT = /(?![\n\t])[\p{Cc}\p{Cf}]/gu;

export interface AppPostInput {
  channelId: string;
  /** A top-level message of that channel: the reply goes in its thread. */
  threadId?: string | null;
  text: string;
  /** The outside person's display name, shown beside the app's name as "from name". */
  sender?: string | null;
  /** The same key from the same app within a day posts once (a retry after a lost answer). */
  idempotencyKey?: string | null;
}

export interface AppMessage {
  id: string;
  channel_id: string;
  thread_id: string | null;
  author: { type: "person" | "agent" | "app"; id: string | null; name: string };
  /** For an app's own messages: the outside sender it passed. */
  sender: string | null;
  text: string;
  /** The message an agent's reply answers (its run's trigger), when it is one. */
  in_reply_to: string | null;
  created_at: string;
}

const IDEMPOTENCY_MS = 86_400_000;

/**
 * Posts as the app (ADR 0251): its channel with `canPost`, text up to `INTEGRATION_LIMITS.text`, hidden characters
 * out. Agents answer as for a person's message (mentions, the router, runs), but nobody is behind it: the run keeps a
 * routine's bounds for outside text, and nothing in it teaches or grants (`ownTyped`). Returns the message and the
 * agents that started on it.
 */
export async function postAsApp(deps: TrafficDeps, p: IntegrationPrincipal, input: AppPostInput) {
  if (!p.channels.get(input.channelId)?.canPost) {
    throw new ForbiddenError("This app can't post in that channel", "integration.channel_post");
  }
  const text = input.text.replace(HIDDEN_TEXT, "").trim();
  if (!text) throw new ValidationError("The message is empty", "message.empty");
  if (text.length > INTEGRATION_LIMITS.text) {
    throw new ValidationError(`At most ${INTEGRATION_LIMITS.text} characters`, "message.too_long", {
      max: INTEGRATION_LIMITS.text,
    });
  }
  const sender = input.sender ? cleanName(input.sender, INTEGRATION_LIMITS.sender) || null : null;
  const key = input.idempotencyKey?.trim().slice(0, 64) || null;
  if (key) {
    const [already] = await deps.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.orgId, p.orgId),
          eq(messages.channelId, input.channelId),
          eq(messages.authorType, "app"),
          gt(messages.createdAt, new Date(Date.now() - IDEMPOTENCY_MS)),
          sql`${messages.meta} -> 'app' ->> 'id' = ${p.appId}::text`,
          sql`${messages.meta} -> 'app' ->> 'key' = ${key}::text`,
        ),
      )
      .limit(1);
    // ponytail: two posts with one key at the same instant can both land; a unique row per key if that shows up.
    if (already)
      return { message: await toAppMessage(deps.db, already), runs: [] as { agentId: string }[], duplicate: true };
  }
  await consumeIntegration(deps.rateLimiter, p.appId, [
    ["pm", INTEGRATION_RATE.postsMinute],
    ["pd", INTEGRATION_RATE.postsDay],
  ]);
  const { message, runs, steered } = await insertMessageWithRuns(
    deps.db,
    {
      orgId: p.orgId,
      channelId: input.channelId,
      threadId: input.threadId ?? null,
      author: { type: "app", appId: p.appId },
      body: text,
      origin: "integration",
      // Outside text (ADR 0117): what reads it treats it as such, and so does the run it starts (`fedByRoutine`).
      meta: {
        app: { id: p.appId, name: p.name, color: p.color, ...(sender ? { sender } : {}), ...(key ? { key } : {}) },
        readOutside: true,
      },
    },
    { startRuns: true },
  );
  const view = messageView(message);
  await publishMessageCreated(deps.pubsub, view);
  const answering = [
    ...runs.map((r) => ({ agentId: r.agentId, runId: r.id })),
    ...steered.map((s) => ({ agentId: s.agentId, runId: s.id })),
  ];
  if (answering.length > 0) {
    await publishChannelEvent(deps.pubsub, {
      type: "message.routed",
      channelId: input.channelId,
      messageId: message.id,
      seenBy: [...new Set([...message.mentionedAgentIds, ...answering.map((r) => r.agentId)])],
      pickedBy: answering.map((r) => r.agentId),
      runs: answering,
      strategy: "mention",
    });
  }
  for (const run of runs) {
    await publishChannelEvent(deps.pubsub, {
      type: "agent.thinking",
      channelId: input.channelId,
      threadId: run.replyInThread ? message.id : message.threadId,
      agentId: run.agentId,
      runId: run.id,
    });
  }
  deps.wakeWorkers?.();
  return {
    message: await toAppMessage(deps.db, message),
    runs: answering.map((r) => ({ agentId: r.agentId })),
    duplicate: false,
  };
}

type StoredMessage = typeof messages.$inferSelect;

/** A message as an app reads it: plain text, the author's name, what it answers. */
async function toAppMessage(db: Database, m: StoredMessage): Promise<AppMessage> {
  return (await toAppMessages(db, m.orgId, [m]))[0] as AppMessage;
}

async function toAppMessages(db: Database, orgId: string, list: StoredMessage[]): Promise<AppMessage[]> {
  const agentIds = [...new Set(list.flatMap((m) => (m.authorAgentId ? [m.authorAgentId] : [])))];
  const userIds = [...new Set(list.flatMap((m) => (m.authorUserId ? [m.authorUserId] : [])))];
  const runIds = [...new Set(list.flatMap((m) => (m.agentRunId ? [m.agentRunId] : [])))];
  const [agentRows, userRows, runRows] = await Promise.all([
    agentIds.length
      ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
      : [],
    userIds.length ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [],
    runIds.length
      ? db
          .select({ id: schema.agentRuns.id, trigger: schema.agentRuns.triggerMessageId })
          .from(schema.agentRuns)
          .where(and(eq(schema.agentRuns.orgId, orgId), inArray(schema.agentRuns.id, runIds)))
      : [],
  ]);
  const agentName = new Map(agentRows.map((r) => [r.id, r.name]));
  const userName = new Map(userRows.map((r) => [r.id, r.name]));
  const trigger = new Map(runRows.map((r) => [r.id, r.trigger]));
  return list.map((m) => {
    const app = appAuthorOf(m.meta);
    const type = m.authorType;
    const id = type === "app" ? (app?.id ?? null) : type === "person" ? m.authorUserId : m.authorAgentId;
    const name =
      type === "app"
        ? (app?.name ?? "")
        : type === "person"
          ? (userName.get(m.authorUserId ?? "") ?? "")
          : (agentName.get(m.authorAgentId ?? "") ?? "");
    return {
      id: m.id,
      channel_id: m.channelId,
      thread_id: m.threadId,
      author: { type, id, name },
      sender: type === "app" ? (app?.sender ?? null) : null,
      text: m.body,
      in_reply_to: m.agentRunId ? (trigger.get(m.agentRunId) ?? null) : null,
      created_at: m.createdAt.toISOString(),
    };
  });
}

/** What a list may not show an app: a notice for an agent, a confidential thread's words, a deleted message. */
const readable = sql`${messages.deletedAt} is null and ${messages.meta} -> 'notice' is null
  and coalesce(${messages.meta} ->> 'confidential', '') <> 'true' and ${messages.body} <> ''`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * New messages in the app's channels (or one of them), oldest first, after the message id `after` (a poll's cursor:
 * the last id it read). Without `after`, the latest `limit`. `next_cursor` is the last id returned.
 */
export async function readAsApp(
  db: Database,
  p: IntegrationPrincipal,
  input: { channelId?: string | null; after?: string | null; limit?: number },
) {
  if (input.channelId && !p.channels.has(input.channelId)) {
    throw new NotFoundError("This app doesn't read that channel", "integration.channel_read");
  }
  if (input.after && !UUID.test(input.after))
    throw new ValidationError("after must be a message id", "integration.cursor");
  const ids = input.channelId ? [input.channelId] : [...p.channels.keys()];
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  if (!ids.length) return { messages: [] as AppMessage[], next_cursor: input.after ?? null };
  const where = and(eq(messages.orgId, p.orgId), inArray(messages.channelId, ids), readable);
  let rows: StoredMessage[];
  if (input.after) {
    // Ids are UUIDv7: in the order they were written, so "after this id" is what came since (the time bound keeps
    // the scan on the partitions since then).
    const since = new Date(Number.parseInt(input.after.replace(/-/g, "").slice(0, 12), 16) - 60_000);
    rows = await db
      .select()
      .from(messages)
      .where(and(where, gt(messages.id, input.after), gt(messages.createdAt, since)))
      .orderBy(asc(messages.id))
      .limit(limit);
  } else {
    rows = (await db.select().from(messages).where(where).orderBy(sql`${messages.id} desc`).limit(limit)).reverse();
  }
  const list = await toAppMessages(db, p.orgId, rows);
  return { messages: list, next_cursor: list.at(-1)?.id ?? input.after ?? null };
}

/** One message as the app reads it (the webhook's body), or null when it may not. */
export async function appMessageById(db: Database, orgId: string, messageId: string) {
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId), readable));
  return row ? toAppMessage(db, row) : null;
}
