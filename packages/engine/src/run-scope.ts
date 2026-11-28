import { type SQL, sql } from "@agenteschat/db";
import type { AgentRun } from "./runs";

/**
 * SQL: the run `r` answers in the channel itself (it was asked there), not in
 * a thread, a range thread, a mission's thread or the thread under its trigger
 * (`reply_in_thread`, ADR 0214). A new message in the channel
 * for that agent joins such a run (ADR 0029) instead of starting a second one
 * beside it. Same rule as `replyThreadOf`.
 */
export const inChannelRun = (r: SQL) =>
  sql`(${r}.thread_root_id = ${r}.trigger_message_id and not ${r}.reply_in_thread)`;

/**
 * SQL: a run asked by a message in `channelId` (in the thread `threadId`, null for the main timeline) answers in the
 * thread under that message (`agent_runs.reply_in_thread`, ADR 0214): asked in a regular channel's main timeline
 * while the channel replies in threads. Read once, when the run is created.
 */
export const repliesInThreadSql = (channelId: string, threadId: string | null) =>
  sql<boolean>`(${threadId}::uuid is null and exists (select 1 from channels rc where rc.id = ${channelId}::uuid
    and rc.kind = 'channel' and rc.reply_in_threads))`;

/**
 * Where a run that goes on from `from` answers, `message` being its trigger (the place rule, ADR 0214: Continuar, a
 * restart after "Parar e mandar", a hand-on of what `from` didn't read, "Tentar de novo", Continuar on a stretch's pause
 * card, asks let go while it waits, work that comes back after it ended): in the thread under the message that asked
 * `from` when that one answers there, whatever its channel says now; otherwise where `message` is, as before.
 */
export const placeAfter = (
  from: Pick<AgentRun, "threadRootId" | "replyInThread">,
  message: { id: string; threadId: string | null },
): Pick<AgentRun, "threadRootId" | "replyInThread"> =>
  from.replyInThread
    ? { threadRootId: from.threadRootId, replyInThread: true }
    : { threadRootId: message.threadId ?? message.id, replyInThread: false };

/**
 * SQL: `userId` asked the run `r`: they wrote the message its conversation started from (`thread_root_id`). For a run
 * that answers in the channel itself that is its trigger; for one that answers under a message of the main timeline
 * (ADR 0214) it is that message, however the run went on from it. Under the agent's own first message (ADR 0261) it is
 * who asked for that turn, kept on the message.
 */
export const askedBy = (r: SQL, userId: string | null) =>
  sql`exists (select 1 from messages ja where ja.org_id = ${r}.org_id and ja.id = ${r}.thread_root_id
    and coalesce(ja.author_user_id, ja.meta->'turnThread'->>'askedBy') = ${userId})`;

/** Where a message reaches an agent's runs from (`joinsRun`). */
export type Arrival =
  /** In the thread under `thread`: a reply there, or a message a run hands on into it (`placeAfter`). */
  | { thread: string | SQL }
  /** New in the main timeline, from `userId`. `several`: it calls other agents too. */
  | { main: { userId: string | null; several: boolean | SQL } }
  /** In the main timeline, handed on from a run that answered there (`placeAfter`). */
  | { main: "handed" };

/**
 * SQL: the join rule (ADR 0214 §5). A message that arrives `at` may join the run `r`; each caller adds which states of
 * a run take it. In a thread, the runs of that thread. Handed on in the main timeline, only the runs that answer there
 * (`inChannelRun`). New in the main timeline, those runs too, and a run that answers under a message of the main
 * timeline when `userId` asked it (`askedBy`), however it went on; anyone else's call starts a run under their own.
 * `several`, in a channel that replies in threads: the message joins no run, so every agent it calls answers under it.
 */
export const joinsRun = (r: SQL, at: Arrival): SQL => {
  if ("thread" in at) return sql`(${r}.thread_root_id = ${at.thread}::uuid)`;
  if (at.main === "handed") return inChannelRun(r);
  const { userId, several } = at.main;
  const joins = sql`(${inChannelRun(r)} or (${r}.reply_in_thread and ${askedBy(r, userId)}))`;
  if (several === false) return joins;
  return sql`(${joins} and not (${several === true ? sql`true` : several} and exists (select 1 from channels jc
    where jc.id = ${r}.channel_id and jc.kind = 'channel' and jc.reply_in_threads)))`;
};

/**
 * SQL: the run `r` may take a new message where it is. Background work (ADR 0121) stepped out of the conversation it
 * was asked in: only a work with its own thread (the anchor's) still takes replies there; one asked inside a thread
 * leaves that thread to the agent's other runs.
 */
export const workKeepsThread = (r: SQL) =>
  sql`(${r}.work_id is null or exists (select 1 from agent_works w where w.id = ${r}.work_id and (w.own_thread or w.how = 'handed')))`;

/**
 * SQL: the run `r` may take a new message of `userId`'s where it is. A person who writes to an agent while it works in
 * the background gets an answer now: a running work never takes their message, a reply turn of its own answers it and
 * passes a change on with `steer_work` (ADR 0121 addendum 2026-11-06). Only a work waiting on something a person's
 * message moves (browser help, another agent's answer), never on its computer, line or plan, still takes it, and only
 * from who asked for it: anyone else's runs after the work, as them, so it never acts on the asker's access.
 */
export const workTakesPersonMessage = (r: SQL, userId: string | null) =>
  sql`(${r}.work_id is null or (${r}.status = 'waiting_input' and coalesce(${r}.state, ${r}.transcript)->'waitingForBrain' is null and ${workKeepsThread(r)}
    and exists (select 1 from agent_works w where w.id = ${r}.work_id and w.requested_by_user_id = ${userId})))`;

/**
 * SQL: the run `r` waits on its plan's limit or its budget (a conversation's catch-up): like a run waiting for its
 * computer, it takes every new message of its conversation instead of a second run beside it.
 */
export const waitsOnUsage = (r: SQL) =>
  sql`(${r}.status = 'waiting_input' and coalesce(${r}.state, ${r}.transcript)->'waitingForBrain'->>'code' in ('plan_limit', 'budget'))`;
