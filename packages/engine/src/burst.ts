import { type PubSub, typingTopic } from "@agenteschat/adapters";
import { and, type Database, eq, gte, isNull, schema, sql } from "@agenteschat/db";
import { TYPING_TTL_MS } from "./events";
import type { Message } from "./messages";

const { messages } = schema;

/** However long a person keeps typing, a run started on their message holds its first model call at most this many `quietMs`. */
export const BURST_MAX_WINDOWS = 4;
/** How often a held run looks whether the person still types, or sent what they typed. */
const TYPING_POLL_MS = 250;

type TypingWhere = { channelId: string; threadId: string | null; userId: string };

/** When each person last typed in each conversation, as this process heard it (`user.typing` on `typingTopic`). */
export interface TypingLog {
  /** The last typing frame's time on this process's clock, or null when none was heard. */
  lastTyped(where: TypingWhere): number | null;
}

const typingKey = (w: TypingWhere) => `${w.channelId}:${w.threadId ?? ""}:${w.userId}`;
const TYPING_KEEP_MS = 60_000;
const logs = new WeakMap<PubSub, TypingLog>();

/**
 * The typing log of a pub/sub, listening from the first call on: called when the handlers are made, so a frame sent
 * while a run reads its context (before its first model call) still counts.
 */
export function typingLogFor(pubsub: PubSub): TypingLog {
  const known = logs.get(pubsub);
  if (known) return known;
  const last = new Map<string, number>();
  pubsub.subscribe(typingTopic, (e) => {
    if (e.type !== "user.typing" || typeof e.channelId !== "string" || typeof e.userId !== "string") return;
    const now = Date.now();
    if (last.size > 10_000) for (const [k, at] of last) if (at < now - TYPING_KEEP_MS) last.delete(k);
    const threadId = typeof e.threadId === "string" ? e.threadId : null;
    last.set(typingKey({ channelId: e.channelId, threadId, userId: e.userId }), now);
  });
  const log: TypingLog = { lastTyped: (w) => last.get(typingKey(w)) ?? null };
  logs.set(pubsub, log);
  return log;
}

/**
 * Whether a message's author can send typing frames: one posted from the web, desktop or phone apps, not through a
 * connected AI app (`meta.via`, ADR 0119), whose next message comes with no typing first.
 */
export const typesInApp = (m: Pick<Message, "meta">) => !m.meta?.via;

/**
 * People split one request over a few messages ("oi" / "preciso de uma coisa"). Nothing waits for that: what they send
 * before a run's first model call is read with it, and what comes after reaches the turn under way (ADR 0112). Only
 * while the apps show the person typing here ("digitando…": a frame since their last message, within
 * `TYPING_TTL_MS`) does a run started on their message hold its first model call, until they send it or stop, at most
 * `BURST_MAX_WINDOWS` × `quietMs` from the trigger. No frame heard: no wait and no statement.
 */
export async function waitWhileTyping(
  db: Database,
  trigger: Pick<Message, "orgId" | "channelId" | "threadId" | "authorUserId" | "createdAt" | "meta">,
  quietMs: number,
  typing: TypingLog,
  signal?: AbortSignal,
): Promise<void> {
  const author = trigger.authorUserId;
  if (!author || quietMs <= 0 || !typesInApp(trigger)) return;
  const where = { channelId: trigger.channelId, threadId: trigger.threadId ?? null, userId: author };
  const heard = () => typing.lastTyped(where);
  const typed = heard();
  if (typed === null || Date.now() - typed >= TYPING_TTL_MS) return;
  // Parar or a shutdown drain ends the wait at once: the run frees its slot instead of sitting it out.
  const aborted = signal
    ? new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    : null;
  const cap = trigger.createdAt.getTime() + quietMs * BURST_MAX_WINDOWS;
  for (;;) {
    if (signal?.aborted) return;
    // Message times come from the database's clock, typing frames from this process's: compared on one of them.
    const [row] = await db
      .select({
        latest: sql<number>`extract(epoch from max(${messages.createdAt})) * 1000`.mapWith(Number),
        now: sql<number>`extract(epoch from clock_timestamp()) * 1000`.mapWith(Number),
      })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, trigger.orgId),
          eq(messages.channelId, trigger.channelId),
          trigger.threadId ? eq(messages.threadId, trigger.threadId) : isNull(messages.threadId),
          eq(messages.authorUserId, author),
          isNull(messages.deletedAt),
          gte(messages.createdAt, trigger.createdAt),
        ),
      );
    if (!row) return;
    const offset = row.now - Date.now();
    const last = (heard() ?? Number.NEGATIVE_INFINITY) + offset;
    // Their message ends the typing that came before it, as the apps show it.
    const until = last < Math.max(trigger.createdAt.getTime(), row.latest || 0) ? 0 : last + TYPING_TTL_MS;
    const wait = Math.min(until, cap) - row.now;
    if (wait <= 0) return;
    const nap = Bun.sleep(Math.min(wait, TYPING_POLL_MS));
    await (aborted ? Promise.race([nap, aborted]) : nap);
  }
}
