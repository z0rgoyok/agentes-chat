import { createHash } from "node:crypto";
import { and, desc, type Executor, eq, isNull, schema, sql } from "@agenteschat/db";
import { serverText } from "@agenteschat/i18n";
import * as Y from "yjs";
import {
  type ArtifactActor,
  type ArtifactAuthor,
  type ArtifactDeps,
  insertVersion,
  isLiveArtifactKind,
} from "../artifacts";
import { ConflictError } from "../errors";
import { personLocale } from "../requester";
import { LIVE_SNAPSHOT_TYPE, liveExcerpt } from "./preview";
import { docOf, type LiveDocRow, loadStored } from "./store";

/**
 * Versions of a live file are checkpoints (ADR 0196 §7): the whole Yjs state as one blob
 * (`application/vnd.agentes.live`), written through `insertVersion` like any version, so the history, `?version=n`,
 * storage accounting, the trash and every rule that reads a version's run keep working. They are written when the
 * file is made; when an agent's batch of changes lands (the first of each run at once, then at most once a minute per
 * agent and file); after five quiet minutes of changes, at most every 30 minutes while they go on; when someone saves
 * one with a name; and when one is restored. A snapshot equal to the latest version is never written again.
 */

export const LIVE_CHECKPOINTS = {
  /** An agent's batches: at most one version a minute per agent and file (its run's first always). */
  agentMs: 60_000,
  /** People's changes: a version once the file has been quiet this long. */
  quietMs: 5 * 60_000,
  /** ...or this long after the last version, when the changes never stop. */
  everyMs: 30 * 60_000,
};

const { artifacts, artifactVersions, liveDocs } = schema;

const sha256Hex = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");

/** What a checkpoint is written with. */
export interface CheckpointOptions {
  /** Whose version it is; absent: whoever made the file's last change (else whoever last changed the file). */
  author?: ArtifactAuthor | null;
  /** The agent's run, for an agent's version (absent: the last change's, when the version is that agent's). */
  runId?: string | null;
  /** Its name (a version saved by hand, a restore). */
  note?: string | null;
  /**
   * Write it even when no change was stored since the last one (a version saved by hand, a restore). A snapshot equal
   * to the latest version is still never written twice.
   */
  force?: boolean;
  now?: Date;
}

/** The author of a version written without one: the last change's, else the file's last editor. */
function authorFor(options: CheckpointOptions, row: LiveDocRow, a: typeof artifacts.$inferSelect) {
  if (options.author) {
    const runId = options.author.type === "agent" ? (options.runId ?? null) : null;
    return { author: options.author, runId };
  }
  if ((row.editedByType === "person" || row.editedByType === "agent") && row.editedById) {
    const runId = row.editedByType === "agent" ? (options.runId ?? row.editedRunId) : null;
    return { author: { type: row.editedByType, id: row.editedById } as ArtifactAuthor, runId };
  }
  return { author: { type: a.updatedByType, id: a.updatedById } as ArtifactAuthor, runId: null };
}

/** An author as `insertVersion` takes it: only its type, id and run are read. */
const actorOf = (author: ArtifactAuthor, runId: string | null, channelId: string | null): ArtifactActor =>
  author.type === "person"
    ? { type: "person", userId: author.id }
    : { type: "agent", agentId: author.id, channelId: channelId ?? "", runId };

/**
 * Writes a version of the live file as it is stored now (the caller stored what it held first), unless nothing
 * changed since the last one (`force` aside) or the snapshot equals the latest version. Its number, or null when none
 * was written (also for a file in the trash or gone). Two processes writing at once: the second looks again.
 */
export async function writeCheckpoint(
  deps: ArtifactDeps,
  orgId: string,
  fileId: string,
  options: CheckpointOptions = {},
): Promise<number | null> {
  const at = options.now ?? new Date();
  for (let attempt = 0; ; attempt++) {
    const stored = await loadStored(deps.db, orgId, fileId);
    if (!stored) return null;
    const { row } = stored;
    if (!options.force && row.headSeq <= row.checkpointSeq) return null;
    const [a] = await deps.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.id, fileId), eq(artifacts.orgId, orgId), isNull(artifacts.deletedAt)));
    if (!a || !isLiveArtifactKind(a.kind)) return null;
    const doc = docOf(stored.state, stored.changes);
    let body: Uint8Array;
    let excerpt: string;
    try {
      body = Y.encodeStateAsUpdate(doc);
      excerpt = liveExcerpt(doc);
    } finally {
      doc.destroy();
    }
    // What this version covers: changes up to the head it was read at (a later checkpoint never moves it back).
    const mark = (tx: Executor) =>
      tx
        .update(liveDocs)
        .set({ checkpointAt: at, checkpointSeq: sql`greatest(${liveDocs.checkpointSeq}, ${stored.seq})` })
        .where(eq(liveDocs.artifactId, fileId))
        .then(() => undefined);
    const [latest] = await deps.db
      .select({ sha256: artifactVersions.sha256 })
      .from(artifactVersions)
      .where(and(eq(artifactVersions.artifactId, fileId), eq(artifactVersions.version, a.currentVersion)));
    if (latest?.sha256 === sha256Hex(body)) {
      await mark(deps.db);
      return null;
    }
    const { author, runId } = authorFor(options, row, a);
    try {
      const { version } = await insertVersion(deps, actorOf(author, runId, a.channelId), orgId, a, {
        stored: { body, contentType: LIVE_SNAPSHOT_TYPE },
        excerpt,
        note: options.note ?? null,
        inTx: mark,
      });
      return version;
    } catch (error) {
      // Someone wrote a version meanwhile (`insertVersion`'s optimistic check): look again. Storage refusals go up.
      if (error instanceof ConflictError && error.code === "conflict" && attempt < 2) continue;
      throw error;
    }
  }
}

/**
 * Whether an agent's batch writes a version now (ADR 0196 §7): the first of its run in this file always (so the
 * hand-off cards and every rule that reads a version's run see the file), then at most once a `agentMs` per agent.
 */
export async function agentCheckpointDue(
  db: Executor,
  fileId: string,
  agentId: string,
  runId: string | null,
  now: Date,
): Promise<boolean> {
  const [last] = await db
    .select({ runId: artifactVersions.runId, createdAt: artifactVersions.createdAt })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.artifactId, fileId),
        eq(artifactVersions.authorType, "agent"),
        eq(artifactVersions.authorId, agentId),
      ),
    )
    .orderBy(desc(artifactVersions.version))
    .limit(1);
  if (!last) return true;
  if ((last.runId ?? null) !== (runId ?? null)) return true;
  return now.getTime() - last.createdAt.getTime() >= LIVE_CHECKPOINTS.agentMs;
}

/**
 * What a quiet-spell check decides (job `live.checkpoint`): `write` a version now (quiet long enough, or none for
 * `everyMs`), `wait` until `at` (changes still coming), or `none` (nothing changed since the last version).
 */
export function idleDecision(
  row: Pick<LiveDocRow, "headSeq" | "checkpointSeq" | "editedAt" | "checkpointAt" | "createdAt">,
  now: Date,
): { kind: "none" } | { kind: "write" } | { kind: "wait"; at: Date } {
  if (row.headSeq <= row.checkpointSeq) return { kind: "none" };
  const edited = (row.editedAt ?? row.createdAt).getTime();
  const last = (row.checkpointAt ?? row.createdAt).getTime();
  const t = now.getTime();
  // A second of slack: the job is due five minutes after a change and may start a hair before.
  if (t - edited >= LIVE_CHECKPOINTS.quietMs - 1000 || t - last >= LIVE_CHECKPOINTS.everyMs) return { kind: "write" };
  return { kind: "wait", at: new Date(Math.min(edited + LIVE_CHECKPOINTS.quietMs, last + LIVE_CHECKPOINTS.everyMs)) };
}

/** The note of a version a restore writes, in the language of whoever restored it: "Restored version 3". */
export async function restoredNote(db: Executor, author: ArtifactAuthor, version: number) {
  const locale = await personLocale(db, author.type === "person" ? author.id : null);
  return serverText(locale, "live.defaults.restored", { version: String(version) });
}
