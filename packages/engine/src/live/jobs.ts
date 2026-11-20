import { liveTopic, type PubSub } from "@agenteschat/adapters";
import { and, type Executor, eq, isNull, schema } from "@agenteschat/db";
import * as Y from "yjs";
import { type ArtifactAuthor, type ArtifactDeps, isLiveArtifactKind, touchLiveArtifact } from "../artifacts";
import { enqueue, type JobHandlers, type OutboxJob } from "../outbox";
import { idleDecision, LIVE_CHECKPOINTS, writeCheckpoint } from "./checkpoints";
import { liveContentOf, liveExcerpt, liveProblems } from "./preview";
import { docOf, liveDocMeta, loadStored, writeCompacted } from "./store";

/**
 * The outbox jobs that keep live documents small and versioned (ADR 0196 §4, §7, ADR 0005):
 *
 * - `live.compact` folds a document's stored changes into its state (deleted content dropped), refreshes the preview
 *   cards draw, the search text and, at most once a minute, the file's "last edited" in the Drive. Asked once 200
 *   changes or 512 KiB wait, and a minute after the last person leaves the file.
 * - `live.checkpoint` writes a version after a quiet spell: armed by any change (one job per five minutes of changes),
 *   it writes once nothing changed for five minutes, or 30 minutes after the last version when changes never stop;
 *   until then it arms the next look itself.
 *
 * Both work from the database alone, in any process, and are idempotent: one that runs twice finds nothing to do.
 */

export const LIVE_COMPACT_JOB = "live.compact";
export const LIVE_CHECKPOINT_JOB = "live.checkpoint";

export const LIVE_COMPACTION = {
  /** Changes waiting before a compaction is asked. */
  changes: 200,
  /** Bytes of changes waiting before one is asked. */
  bytes: 512 * 1024,
  /** After the last socket on a file leaves. */
  afterLeaveMs: 60_000,
};

/** Asks a compaction of the document as it is at `headSeq` (a later head asks again), now or at `runAt`. */
export async function enqueueCompaction(db: Executor, orgId: string, fileId: string, headSeq: number, runAt?: Date) {
  await enqueue(db, {
    orgId,
    kind: LIVE_COMPACT_JOB,
    payload: { fileId },
    dedupeKey: `${LIVE_COMPACT_JOB}:${fileId}:${headSeq}`,
    ...(runAt ? { runAt } : {}),
    maxAttempts: 4,
  });
}

/** The five-minute window a change made at `at` falls in: one quiet-spell job per window and file. */
export const checkpointWindow = (at: Date) => Math.floor(at.getTime() / LIVE_CHECKPOINTS.quietMs);

/** Arms the quiet-spell check after a change stored at `at` (one per five-minute window and file). */
export async function armIdleCheckpoint(db: Executor, orgId: string, fileId: string, at: Date) {
  await enqueue(db, {
    orgId,
    kind: LIVE_CHECKPOINT_JOB,
    payload: { fileId },
    dedupeKey: `${LIVE_CHECKPOINT_JOB}:${fileId}:${checkpointWindow(at)}`,
    runAt: new Date(at.getTime() + LIVE_CHECKPOINTS.quietMs),
    maxAttempts: 4,
  });
}

/** What compaction and the checkpoint job need: the Drive's deps, pub/sub to tell the processes, a log. */
export interface LiveJobDeps extends ArtifactDeps {
  log?: { warn(message: string, data?: Record<string, unknown>): void };
}

/**
 * Folds every change stored so far into the document's state (one snapshot read, written only if no other compaction
 * moved it since), then refreshes its preview and the file's search text and "last edited". Null for a file with no
 * live document; `compacted` false when there was nothing to fold.
 */
export async function compactLiveDoc(deps: LiveJobDeps, orgId: string, fileId: string, now = new Date()) {
  const stored = await loadStored(deps.db, orgId, fileId);
  if (!stored) return null;
  const { row } = stored;
  const kind = row.kind;
  if (!isLiveArtifactKind(kind)) return null;
  if (stored.changes.length === 0 && row.preview) return { compacted: false, seq: stored.seq };
  const doc = docOf(stored.state, stored.changes);
  let state: Uint8Array;
  let preview: Record<string, unknown>;
  let excerpt: string;
  try {
    state = Y.encodeStateAsUpdate(doc);
    preview = liveContentOf(doc, kind).preview as unknown as Record<string, unknown>;
    excerpt = liveExcerpt(doc);
    // Counts are checked on every change; the rest of the rules of shape here, where reading the whole is affordable.
    const problems = liveProblems(doc);
    if (problems.length > 0) {
      deps.log?.warn("live file breaks its rules of shape", { orgId, fileId, problems: problems.slice(0, 10) });
    }
  } finally {
    doc.destroy();
  }
  let compacted = false;
  if (stored.changes.length > 0) {
    compacted = await writeCompacted(deps.db, orgId, fileId, {
      from: row.compactedSeq,
      seq: stored.seq,
      state,
      preview,
      at: now,
    });
  } else {
    // Nothing to fold, only a missing preview to draw.
    await deps.db
      .update(schema.liveDocs)
      .set({ preview })
      .where(and(eq(schema.liveDocs.artifactId, fileId), isNull(schema.liveDocs.preview)));
  }
  const by: ArtifactAuthor | null =
    (row.editedByType === "person" || row.editedByType === "agent") && row.editedById
      ? { type: row.editedByType, id: row.editedById }
      : null;
  await touchLiveArtifact(deps, orgId, fileId, { excerpt, editedAt: row.editedAt, by, now });
  return { compacted, seq: stored.seq };
}

/**
 * The quiet-spell check (`live.checkpoint`): a version now, or the next look armed for when the spell would end (its
 * key the job's own, so a job that runs twice arms it once). The version's number, or null.
 */
export async function idleCheckpoint(
  deps: ArtifactDeps,
  orgId: string,
  fileId: string,
  jobId: string,
  now = new Date(),
) {
  const row = await liveDocMeta(deps.db, orgId, fileId);
  if (!row) return null;
  const decision = idleDecision(row, now);
  if (decision.kind === "none") return null;
  if (decision.kind === "wait") {
    await enqueue(deps.db, {
      orgId,
      kind: LIVE_CHECKPOINT_JOB,
      payload: { fileId },
      dedupeKey: `${LIVE_CHECKPOINT_JOB}:${fileId}:after:${jobId}`,
      runAt: decision.at,
      maxAttempts: 4,
    });
    return null;
  }
  return writeCheckpoint(deps, orgId, fileId, { now });
}

/** Tells the processes holding a file that a version was written: their sockets refresh the history. */
export async function announceVersion(pubsub: PubSub | undefined, fileId: string, from: string) {
  await pubsub?.publish(liveTopic(fileId), { type: "live.versions", id: fileId, from }).catch(() => {});
}

/** Both jobs' handlers (registered in `createJobHandlers`). */
export function liveJobHandlers(deps: { artifacts?: ArtifactDeps; pubsub?: PubSub; log?: LiveJobDeps["log"] }) {
  const fileOf = (job: OutboxJob) => {
    const fileId = job.payload.fileId;
    return job.orgId && typeof fileId === "string" ? { orgId: job.orgId, fileId } : null;
  };
  const files = (): LiveJobDeps => {
    if (!deps.artifacts) throw new Error("Files are unavailable");
    return { ...deps.artifacts, pubsub: deps.pubsub ?? deps.artifacts.pubsub, log: deps.log };
  };
  const handlers: JobHandlers = {
    [LIVE_COMPACT_JOB]: async (job) => {
      const at = fileOf(job);
      if (at) await compactLiveDoc(files(), at.orgId, at.fileId);
    },
    [LIVE_CHECKPOINT_JOB]: async (job) => {
      const at = fileOf(job);
      if (!at) return;
      const version = await idleCheckpoint(files(), at.orgId, at.fileId, job.id);
      if (version !== null) await announceVersion(deps.pubsub, at.fileId, "job");
    },
  };
  return handlers;
}
