import type { BlobStoreResolver, PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNotNull, lt, notInArray, or, schema, sql } from "@agenteschat/db";
import { ARTIFACT_TRASH_DAYS } from "./artifacts";
import { UUID } from "./authority";
import { CONFIDENTIAL_KEEP_DAYS, CONFIDENTIAL_STUB, sealStragglers } from "./confidential";
import { publishMessageCreated } from "./events";
import { type Message, messageView } from "./messages";
import { ACTIVE_RUN_STATUSES } from "./run-inbox";
import { dropThreadVoice } from "./voice";

const {
  agentQuestions,
  agentRunSteps,
  agentRuns,
  agentWorks,
  approvals,
  artifacts,
  artifactVersions,
  confidentialThreads,
  contextItems,
  messages,
  threads,
} = schema;

/** `meta.bodyCode` of a message whose words the prune removed: the apps word it (`chat.body.confidential_removed`). */
export const CONFIDENTIAL_REMOVED_CODE = "confidential_removed";

/** What such a message says where an app has no words of its own for the code. */
export const CONFIDENTIAL_REMOVED_TEXT = `Removed: confidential text is kept for ${CONFIDENTIAL_KEEP_DAYS} days.`;

/** The whole meta of a message the prune blanked: nothing it carried before is left. */
const REMOVED_META = {
  confidential: true,
  pruned: true,
  bodyCode: CONFIDENTIAL_REMOVED_CODE,
  bodyParams: { days: CONFIDENTIAL_KEEP_DAYS },
  sealedBody: CONFIDENTIAL_REMOVED_TEXT,
};

const DAY_MS = 86_400_000;

/**
 * The daily prune of confidential threads (ADR 0190). A thread marked more than `CONFIDENTIAL_KEEP_DAYS` ago loses the
 * words of every message it holds, its root and whatever was written since included, and of what its runs reported
 * outside it, with what was attached to them, and the summaries made of it before its mark;
 * a run of it that ended and is older than that loses what it kept of them (its steps, its transcript, its error's
 * text, its questions, its approvals, the blocks and polls it showed). The rows stay. Each blanked message goes to the
 * apps as a message written again in place, so a copy an app kept goes too. Every pass looks at every old thread
 * again: what was added since the last one is blanked then.
 */
export async function pruneConfidential(
  deps: { db: Database; pubsub?: PubSub; blobs?: BlobStoreResolver },
  now = new Date(),
): Promise<{ sealed: number; messages: number; runs: number }> {
  const { db } = deps;
  const result = { sealed: await sealStragglers(db), messages: 0, runs: 0 };
  const cutoff = new Date(now.getTime() - CONFIDENTIAL_KEEP_DAYS * DAY_MS);
  const old = await db.select().from(confidentialThreads).where(lt(confidentialThreads.markedAt, cutoff));
  for (const thread of old) {
    const ofThread = and(eq(agentRuns.orgId, thread.orgId), eq(agentRuns.threadRootId, thread.rootMessageId));
    const blanked = await db.transaction(async (tx) => {
      // What a run of the thread wrote outside it is sealed like the thread's own messages and goes with them: its
      // long work's report where the work was asked, or the copy of it where the work was handed from. Found by the
      // run's and the work's own pointers: no index of `messages` leads from a run to what it wrote.
      const reports = (
        await tx
          .select({ reply: agentRuns.replyMessageId, result: agentWorks.resultMessageId })
          .from(agentRuns)
          .leftJoin(agentWorks, and(eq(agentWorks.orgId, agentRuns.orgId), eq(agentWorks.id, agentRuns.workId)))
          .where(ofThread)
      ).flatMap((r) => [r.reply, r.result].filter((id): id is string => id !== null));
      const inThread = and(
        eq(messages.orgId, thread.orgId),
        or(
          and(
            eq(messages.channelId, thread.channelId),
            or(eq(messages.id, thread.rootMessageId), eq(messages.threadId, thread.rootMessageId)),
          ),
          reports.length > 0
            ? and(inArray(messages.id, reports), sql`${messages.meta}->>'confidential' = 'true'`)
            : undefined,
        ),
      );
      const kept = and(inThread, sql`coalesce(${messages.meta}->>'pruned', '') <> 'true'`);
      // Read before the words go: what its messages carried as files.
      const attached = (await tx.select({ meta: messages.meta }).from(messages).where(kept)).flatMap((m) =>
        (Array.isArray(m.meta.artifacts) ? (m.meta.artifacts as { id?: unknown }[]) : []).flatMap((a) =>
          typeof a?.id === "string" && UUID.test(a.id) ? [a.id] : [],
        ),
      );
      const rows: Message[] = await tx
        .update(messages)
        .set({ body: CONFIDENTIAL_STUB, meta: REMOVED_META })
        .where(kept)
        .returning();
      await tx
        .update(threads)
        .set({ title: null })
        .where(
          and(
            eq(threads.orgId, thread.orgId),
            eq(threads.rootMessageId, thread.rootMessageId),
            isNotNull(threads.title),
          ),
        );
      // A summary of the thread made before its mark, which the mark archived (out of the index since), and every
      // older version of it.
      await tx
        .delete(contextItems)
        .where(
          and(
            eq(contextItems.orgId, thread.orgId),
            eq(contextItems.scopeType, "thread"),
            eq(contextItems.scopeId, thread.rootMessageId),
            eq(contextItems.kind, "thread_summary"),
          ),
        );
      // A tombstone older than the trash keeps: out of the trash and of restore, and the purge of deleted files
      // takes every version's contents.
      const files = await tx
        .update(artifacts)
        .set({ title: "", excerpt: "", deletedAt: new Date(now.getTime() - ARTIFACT_TRASH_DAYS * DAY_MS - 1000) })
        .where(
          and(
            eq(artifacts.orgId, thread.orgId),
            or(
              eq(artifacts.threadId, thread.rootMessageId),
              attached.length > 0 ? inArray(artifacts.id, attached) : undefined,
            ),
            sql`(${artifacts.deletedAt} is null or ${artifacts.title} <> '' or ${artifacts.excerpt} <> '')`,
          ),
        )
        .returning({ id: artifacts.id });
      if (files.length > 0) {
        await tx
          .update(artifactVersions)
          .set({ fileName: null, note: null })
          .where(
            inArray(
              artifactVersions.artifactId,
              files.map((f) => f.id),
            ),
          );
      }
      const runs = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            ofThread,
            lt(agentRuns.createdAt, cutoff),
            // A run still at work reads its own transcript: it is blanked by the pass after it ends.
            notInArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
            sql`(${agentRuns.transcript} is not null or position(':' in coalesce(${agentRuns.error}, '')) > 0
              or exists (select 1 from ${agentRunSteps} s where s.run_id = ${agentRuns.id} and not (s.data ? 'pruned')))`,
          ),
        );
      const runIds = runs.map((r) => r.id);
      if (runIds.length > 0) {
        // What a step says of its call stays (the tool, how it ended, its code): what it read or wrote goes.
        await tx
          .update(agentRunSteps)
          .set({
            data: sql`jsonb_strip_nulls(jsonb_build_object('pruned', true, 'toolUseId', ${agentRunSteps.data}->'toolUseId',
              'name', ${agentRunSteps.data}->'name', 'isError', ${agentRunSteps.data}->'isError',
              'data', jsonb_build_object('code', ${agentRunSteps.data}->'data'->'code',
                'confidential', ${agentRunSteps.data}->'data'->'confidential',
                'outside', ${agentRunSteps.data}->'data'->'outside')))`,
          })
          .where(inArray(agentRunSteps.runId, runIds));
        await tx
          .update(agentRuns)
          .set({
            transcript: null,
            // Its code is the server's own word; what follows the colon may be another program's.
            error: sql`case when ${agentRuns.error} ~ '^[a-z_]+(:|$)' then split_part(${agentRuns.error}, ':', 1) end`,
          })
          .where(inArray(agentRuns.id, runIds));
        await tx
          .update(agentQuestions)
          .set({ text: "", choices: null, answer: null })
          .where(inArray(agentQuestions.runId, runIds));
        await tx
          .update(approvals)
          .set({ title: "", detail: "", why: "", params: {}, reason: null, result: null })
          .where(inArray(approvals.runId, runIds));
      }
      result.runs += runIds.length;
      return rows;
    });
    await dropThreadVoice({ db, blobs: deps.blobs }, thread);
    result.messages += blanked.length;
    if (deps.pubsub) for (const row of blanked) await publishMessageCreated(deps.pubsub, messageView(row));
  }
  return result;
}
