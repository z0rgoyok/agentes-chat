import { and, type Executor, eq, inArray, rowsOf, type SQL, schema, sql } from "@agenteschat/db";
import { TtlCache } from "./cache";
import { enqueue } from "./outbox";

const { agentRuns, confidentialThreads, contextItems, messages, notifications, searchDocuments } = schema;

/**
 * Confidential results (ADR 0190). A server the operator vouches for (`MCP_CALLER_IDENTITY`) marks a tool result as
 * confidential; the thread of the run that read it becomes a confidential thread (`confidential_threads`), from its
 * root. In such a thread:
 *
 * - every message is sealed: `messages.body` holds `CONFIDENTIAL_STUB` and the words live in `meta.sealedBody`, so
 *   whatever reads a message's body (another run's context, search, a summary, a notification) gets the stub
 *   without knowing about any of this. Only the people's view (`messageView`) and a model-brain run of that same
 *   thread (`buildRunContext`) read the words back (`unsealed`);
 * - a run sends nothing elsewhere (the Tool Gateway's lock) and answers in the thread.
 */

/** The key of a tool result's `_meta` that marks it confidential, when its server is one the operator listed. */
export const CONFIDENTIAL_META_KEY = "chat.agentes/confidential";

/** What stands in a confidential text's place for whoever may not read it. */
export const CONFIDENTIAL_STUB = "[confidential: readable only in its own thread]";

/** A confidential result or run, as a line about it says (a judge's tried lines, recent actions). */
export const CONFIDENTIAL_NOT_SHOWN = "(confidential, not shown)";

/** The refusal code of a tool a run may not call after it read a confidential result. Final for the turn's judge. */
export const CONFIDENTIAL_OUTBOUND = "confidential.outbound";

/**
 * A run's error when what thinks for it is not what first read its confidential thread: the same run on another brain
 * or provider (its transcript holds the words), or another agent's run there. Either would hand the words on.
 */
export const CONFIDENTIAL_AI_CHANGED =
  "This conversation holds confidential text, which stays with the AI that first read it. This agent thinks with another one now, so it stopped here. Ask again in a new message.";

/**
 * How long a confidential thread's words are kept.
 * ponytail: a constant; a setting when an operator needs another number.
 */
export const CONFIDENTIAL_KEEP_DAYS = 60;

/** SQL: the thread rooted at `root` is confidential. */
export const confidentialThreadSql = (orgId: SQL, root: SQL): SQL =>
  sql`exists (select 1 from ${confidentialThreads} ct where ct.org_id = ${orgId} and ct.root_message_id = ${root})`;

/** A confidential thread as its row says: what thought for the run that marked it; null when it is not one. */
export async function confidentialThread(
  db: Executor,
  orgId: string,
  rootId: string,
): Promise<{ thinksWith: string | null } | null> {
  const [row] = await db
    .select({ thinksWith: confidentialThreads.thinksWith })
    .from(confidentialThreads)
    .where(and(eq(confidentialThreads.orgId, orgId), eq(confidentialThreads.rootMessageId, rootId)));
  return row ?? null;
}

export const threadIsConfidential = async (db: Executor, orgId: string, rootId: string): Promise<boolean> =>
  (await confidentialThread(db, orgId, rootId)) !== null;

/**
 * Whether what thinks for a run (`ToolContext.thinksWith`) is what a confidential thread's words stay with: one
 * provider reads them, so another agent named there, or the same one after its model changed, is handed the stub.
 */
export const thinksAsThread = (thread: { thinksWith: string | null }, thinksWith: string | undefined): boolean =>
  thread.thinksWith === null || thread.thinksWith === thinksWith;

/** Which of these threads (by root message) are confidential. */
export async function confidentialRoots(db: Executor, rootIds: string[]): Promise<Set<string>> {
  if (rootIds.length === 0) return new Set();
  const rows = await db
    .select({ id: confidentialThreads.rootMessageId })
    .from(confidentialThreads)
    .where(inArray(confidentialThreads.rootMessageId, rootIds));
  return new Set(rows.map((r) => r.id));
}

/**
 * The runs this process knows to answer in a confidential thread: told by the executor when it claims one and by the
 * Tool Gateway on every call. What reads a run's words from memory, not from a message (the small judge's asks, a
 * turn's learning), asks here, at no query: such a reader runs in the process that runs the run. Once true it stays
 * true for the run.
 */
const sealedRuns = new TtlCache<true>(24 * 3600_000, 20_000);

export const noteConfidentialRun = (runId: string) => sealedRuns.set(runId, true);

export const isConfidentialRun = (runId: string | null | undefined) => Boolean(runId && sealedRuns.get(runId));

export interface RunConfidentiality {
  /** What the run thinks with (`agent_runs.brain`); null before its first turn. */
  brain: string | null;
  /** The connections whose results marked the run's thread; null while the thread is not confidential. */
  connectionIds: string[] | null;
  /** What thought for the run that marked the thread (`thinksAsThread`); null when unknown or not confidential. */
  thinksWith: string | null;
}

/** A run's thread as the confidential mark sees it, with the brain it thinks with; null when the run is gone. */
export async function runConfidentiality(
  db: Executor,
  orgId: string,
  runId: string,
): Promise<RunConfidentiality | null> {
  const [row] = await db
    .select({
      brain: agentRuns.brain,
      connectionIds: confidentialThreads.connectionIds,
      thinksWith: confidentialThreads.thinksWith,
    })
    .from(agentRuns)
    .leftJoin(
      confidentialThreads,
      and(
        eq(confidentialThreads.orgId, agentRuns.orgId),
        eq(confidentialThreads.rootMessageId, agentRuns.threadRootId),
      ),
    )
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId)));
  if (row?.connectionIds) noteConfidentialRun(runId);
  return row ?? null;
}

/**
 * Seals the messages of confidential threads that `which` picks (on `messages m`, `confidential_threads ct`): the body
 * becomes the stub and its words move to `meta.sealedBody`. Also a message already marked whose body was written again
 * since (a note the server rewords in place). Returns the ids it sealed.
 */
async function sealMessages(tx: Executor, which: SQL): Promise<string[]> {
  const sealed = rowsOf<{ id: string; org_id: string }>(
    await tx.execute(sql`update ${messages} m
      set body = case when m.body = '' then '' else ${CONFIDENTIAL_STUB} end,
        meta = m.meta || jsonb_build_object('confidential', true)
          || case when m.body in ('', ${CONFIDENTIAL_STUB}) then '{}'::jsonb
            else jsonb_build_object('sealedBody', m.body) end
      from ${confidentialThreads} ct
      where m.org_id = ct.org_id and m.channel_id = ct.channel_id
        and (m.id = ct.root_message_id or m.thread_id = ct.root_message_id)
        and (coalesce(m.meta->>'confidential', '') <> 'true' or m.body not in ('', ${CONFIDENTIAL_STUB}))
        and ${which}
      returning m.id, m.org_id`),
  );
  const ids = sealed.map((m) => m.id);
  if (ids.length === 0) return ids;
  // Out of the index with the seal, not after it: a search must not match words the thread no longer shows. The job
  // does the same for an index kept elsewhere (its builder answers nothing for a sealed message).
  await tx
    .delete(searchDocuments)
    .where(
      and(eq(searchDocuments.kind, "message"), sql`${searchDocuments.sourceId} = any(${`{${ids.join(",")}}`}::uuid[])`),
    );
  for (const m of sealed) {
    await enqueue(tx, { orgId: m.org_id, kind: "search.index", payload: { kind: "message", sourceId: m.id } });
  }
  return ids;
}

/**
 * Makes a thread confidential, in the caller's transaction (with the step that carries the mark): its row, with the
 * connection that marked it and what thought for the run that read it (the first mark's stays), and on the first mark
 * every message already there is sealed, the root included (it may hold what a person pasted before any mark), and
 * leaves the search index.
 */
export async function markThreadConfidential(
  tx: Executor,
  thread: {
    orgId: string;
    channelId: string;
    rootId: string;
    connectionId?: string | null;
    thinksWith?: string | null;
  },
): Promise<void> {
  const connection = thread.connectionId ?? null;
  const [row] = rowsOf<{ created: boolean }>(
    await tx.execute(sql`insert into ${confidentialThreads} (org_id, channel_id, root_message_id, connection_ids, thinks_with)
      values (${thread.orgId}::uuid, ${thread.channelId}::uuid, ${thread.rootId}::uuid,
        array_remove(array[${connection}::uuid], null), ${thread.thinksWith ?? null})
      on conflict (org_id, root_message_id) do update set connection_ids =
        case when ${connection}::uuid is null or ${connection}::uuid = any(${confidentialThreads}.connection_ids)
          then ${confidentialThreads}.connection_ids
          else array_append(${confidentialThreads}.connection_ids, ${connection}::uuid) end
      returning (xmax = 0) as created`),
  );
  if (!row?.created) return;
  await sealMessages(tx, sql`ct.org_id = ${thread.orgId}::uuid and ct.root_message_id = ${thread.rootId}::uuid`);
  // What was copied out of the thread before its mark goes with it: a notification's snippet of one of its messages,
  // and a summary of the thread (archived, which takes it out of the index and of what agents are handed).
  await tx
    .update(notifications)
    .set({ latest: sql`${notifications.latest} - 'text' - 'title' - 'quote' - 'suggestions' - 'meta'` })
    .where(
      and(
        eq(notifications.orgId, thread.orgId),
        sql`(${notifications.source}->>'threadId' = ${thread.rootId} or ${notifications.source}->>'messageId' = ${thread.rootId})`,
      ),
    );
  const summaries = await tx
    .update(contextItems)
    .set({ status: "archived" })
    .where(
      and(
        eq(contextItems.orgId, thread.orgId),
        eq(contextItems.kind, "thread_summary"),
        eq(contextItems.scopeType, "thread"),
        eq(contextItems.scopeId, thread.rootId),
        eq(contextItems.status, "active"),
      ),
    )
    .returning({ id: contextItems.id });
  for (const item of summaries) {
    await enqueue(tx, {
      orgId: thread.orgId,
      kind: "search.index",
      payload: { kind: "context_item", sourceId: item.id },
    });
  }
}

/**
 * Seals what the statement that writes a message could not see: a message written while its thread's mark was being
 * committed, and a note the server reworded in place since. Run with the daily prune; returns how many it sealed.
 */
export const sealStragglers = async (db: Executor): Promise<number> => (await sealMessages(db, sql`true`)).length;

type Meta = Record<string, unknown> | null | undefined;

/** A message of a confidential thread, or one a run of such a thread wrote (`meta.confidential`). */
export const isConfidential = (meta: Meta): boolean => meta?.confidential === true;

/**
 * A confidential message as whoever may not read it is handed it: the stub, with nothing of its meta (a card's
 * fields, a file's name and the seal's copy are there). Any other message as it is.
 */
export const stubOf = <M extends { body: string; meta: Record<string, unknown> }>(m: M): M =>
  isConfidential(m.meta) ? { ...m, body: CONFIDENTIAL_STUB, meta: { confidential: true } } : m;

/** A stored message's own words, for the people who may read it: a sealed one's from its seal (`unsealed`). */
export const wordsOf = (body: string, meta: Meta): string => unsealed({ body, meta: meta ?? {} }).body;

/**
 * A sealed message with its words back and nothing of the seal's copy left in its meta: what the people who read the
 * conversation see, and what a model-brain run of the same thread reads. Any other message as it is.
 */
export function unsealed<M extends { body: string; meta: Record<string, unknown> }>(m: M): M {
  const words = m.meta.sealedBody;
  if (typeof words !== "string") return m;
  const { sealedBody: _, ...meta } = m.meta;
  // A body written again since the seal (a note the server rewords in place) is the newer text.
  return { ...m, body: m.body === CONFIDENTIAL_STUB ? words : m.body, meta };
}
