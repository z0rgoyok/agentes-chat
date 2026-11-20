import { and, asc, type Database, type Executor, eq, gt, lte, schema, sql } from "@agenteschat/db";
import * as Y from "yjs";
import { UUID } from "../authority";
import { NotFoundError } from "../errors";

/**
 * Where a live file's document is kept (ADR 0196 §4): `live_docs` holds the state as of its last compaction and the
 * number of its newest change; `live_doc_updates` the changes after that, one row per merged batch. Nothing here knows
 * a document's kind or who may read it: callers checked that (`liveFileAccess`).
 *
 * A read of the state and the changes after it is one snapshot (`repeatable read`): a compaction committing between
 * two separate reads would fold away changes the second read then no longer finds.
 */

const { liveDocs, liveDocUpdates } = schema;

export type LiveDocRow = typeof liveDocs.$inferSelect;

/** Who made a stored change: a person, an agent (with its run) or the server itself (a restore, an image job). */
export interface LiveChangeActor {
  type: "person" | "agent" | "system";
  id: string | null;
  runId?: string | null;
}

/** One stored change, decoded. */
export interface StoredChange {
  seq: number;
  update: Uint8Array;
  bytes: number;
  actorType: string;
  actorId: string | null;
  runId: string | null;
  createdAt: Date;
}

/** Bytes as the base64 text the columns hold. */
export const toB64 = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
export const fromB64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

const valid = (orgId: string, fileId: string) => UUID.test(orgId) && UUID.test(fileId);

const changeOf = (row: typeof liveDocUpdates.$inferSelect): StoredChange => ({
  seq: row.seq,
  update: fromB64(row.update),
  bytes: row.bytes,
  actorType: row.actorType,
  actorId: row.actorId,
  runId: row.runId,
  createdAt: row.createdAt,
});

/** Reads that must agree with each other (the state and the changes after it): one snapshot, nothing written. */
function inOneSnapshot<T>(db: Database, read: (tx: Executor) => Promise<T>): Promise<T> {
  return db.transaction(read, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** A live file's row in this workspace, or null (a malformed id included: Postgres would refuse it). */
export async function liveDocRow(db: Executor, orgId: string, fileId: string): Promise<LiveDocRow | null> {
  if (!valid(orgId, fileId)) return null;
  const [row] = await db
    .select()
    .from(liveDocs)
    .where(and(eq(liveDocs.artifactId, fileId), eq(liveDocs.orgId, orgId)));
  return row ?? null;
}

/** A live file's row without its compacted state. */
export type LiveDocMeta = Omit<LiveDocRow, "state">;

// Every column but `state`, which grows with the document (up to `LIVE_LIMITS.docBytes`, as base64): reads that only
// decide something (is there a document, is a version due, which preview) never carry it. `satisfies` keeps the
// list whole when the table gains a column.
const META_COLUMNS = {
  artifactId: liveDocs.artifactId,
  orgId: liveDocs.orgId,
  kind: liveDocs.kind,
  stateBytes: liveDocs.stateBytes,
  headSeq: liveDocs.headSeq,
  compactedSeq: liveDocs.compactedSeq,
  preview: liveDocs.preview,
  editedAt: liveDocs.editedAt,
  editedByType: liveDocs.editedByType,
  editedById: liveDocs.editedById,
  editedRunId: liveDocs.editedRunId,
  checkpointAt: liveDocs.checkpointAt,
  checkpointSeq: liveDocs.checkpointSeq,
  createdAt: liveDocs.createdAt,
  updatedAt: liveDocs.updatedAt,
} satisfies { [K in keyof LiveDocMeta]: unknown };

/** `liveDocRow` without the state, or null. */
export async function liveDocMeta(db: Executor, orgId: string, fileId: string): Promise<LiveDocMeta | null> {
  if (!valid(orgId, fileId)) return null;
  const [row] = await db
    .select(META_COLUMNS)
    .from(liveDocs)
    .where(and(eq(liveDocs.artifactId, fileId), eq(liveDocs.orgId, orgId)));
  return row ?? null;
}

/** Where a live file's changes stand (its newest, and where its last compaction stopped), or null. */
async function liveDocHead(db: Executor, orgId: string, fileId: string) {
  const [row] = await db
    .select({ headSeq: liveDocs.headSeq, compactedSeq: liveDocs.compactedSeq })
    .from(liveDocs)
    .where(and(eq(liveDocs.artifactId, fileId), eq(liveDocs.orgId, orgId)));
  return row ?? null;
}

/** The compacted state alone, decoded (empty when the row is gone). */
async function compactedState(db: Executor, fileId: string): Promise<Uint8Array> {
  const [row] = await db.select({ state: liveDocs.state }).from(liveDocs).where(eq(liveDocs.artifactId, fileId));
  return row ? fromB64(row.state) : new Uint8Array();
}

/** The changes stored after `after`, in order. */
export async function changesAfter(db: Executor, fileId: string, after: number): Promise<StoredChange[]> {
  const rows = await db
    .select()
    .from(liveDocUpdates)
    .where(and(eq(liveDocUpdates.artifactId, fileId), gt(liveDocUpdates.seq, after)))
    .orderBy(asc(liveDocUpdates.seq));
  return rows.map(changeOf);
}

/** The row, its compacted state and the changes after it (one snapshot): everything the head is made of. */
export async function loadStored(db: Database, orgId: string, fileId: string) {
  if (!valid(orgId, fileId)) return null;
  return inOneSnapshot(db, async (tx) => {
    const row = await liveDocRow(tx, orgId, fileId);
    if (!row) return null;
    const changes = await changesAfter(tx, fileId, row.compactedSeq);
    return { row, state: fromB64(row.state), changes, seq: row.headSeq };
  });
}

/** A document from its compacted state and the changes after it, applied with `origin`. */
export function docOf(state: Uint8Array, changes: readonly { update: Uint8Array }[], origin?: unknown): Y.Doc {
  const doc = new Y.Doc();
  if (state.byteLength > 0) Y.applyUpdate(doc, state, origin);
  for (const change of changes) Y.applyUpdate(doc, change.update, origin);
  return doc;
}

/** The document at its newest stored change (a fresh copy nobody else holds), or null for no such live file. */
export async function loadHeadDoc(db: Database, orgId: string, fileId: string) {
  const stored = await loadStored(db, orgId, fileId);
  if (!stored) return null;
  return { doc: docOf(stored.state, stored.changes), seq: stored.seq, row: stored.row };
}

/** The head as one update (merged without building the document): a first load over HTTP. */
export async function loadHeadState(db: Database, orgId: string, fileId: string) {
  const stored = await loadStored(db, orgId, fileId);
  if (!stored) return null;
  const parts = [stored.state, ...stored.changes.map((c) => c.update)].filter((p) => p.byteLength > 0);
  let state: Uint8Array;
  if (parts.length === 0) state = Y.encodeStateAsUpdate(new Y.Doc());
  else if (parts.length === 1) state = parts[0] as Uint8Array;
  else state = Y.mergeUpdates(parts);
  return { state, seq: stored.seq, row: stored.row };
}

/**
 * What a process that applied everything up to `after` still lacks: the changes after it, or, when a compaction
 * already folded some of those away, the whole state again with the changes after the compaction (applying what a
 * document already has changes nothing). Null when the file has no live document any more.
 */
export async function readSince(db: Database, orgId: string, fileId: string, after: number) {
  if (!valid(orgId, fileId)) return null;
  return inOneSnapshot(db, async (tx) => {
    // The state is read only by a process behind a compaction: the holders' tail check runs every few seconds and
    // must not carry the whole document each time.
    const row = await liveDocHead(tx, orgId, fileId);
    if (!row) return null;
    if (row.headSeq <= after) return { state: null, changes: [] as StoredChange[], head: row.headSeq, row };
    const behind = after < row.compactedSeq;
    const changes = await changesAfter(tx, fileId, behind ? row.compactedSeq : after);
    return { state: behind ? await compactedState(tx, fileId) : null, changes, head: row.headSeq, row };
  });
}

/** How big the document is as stored: its state and the changes after it (what limits and compaction look at). */
export async function storedSize(db: Executor, orgId: string, fileId: string) {
  if (!valid(orgId, fileId)) return null;
  const [row] = await db
    .select({
      headSeq: liveDocs.headSeq,
      compactedSeq: liveDocs.compactedSeq,
      stateBytes: liveDocs.stateBytes,
      tailBytes: sql<string>`coalesce((select sum(${liveDocUpdates.bytes}) from ${liveDocUpdates}
        where ${liveDocUpdates.artifactId} = ${liveDocs.artifactId} and ${liveDocUpdates.seq} > ${liveDocs.compactedSeq}), 0)`,
    })
    .from(liveDocs)
    .where(and(eq(liveDocs.artifactId, fileId), eq(liveDocs.orgId, orgId)));
  if (!row) return null;
  const tailBytes = Number(row.tailBytes);
  return {
    headSeq: row.headSeq,
    compactedSeq: row.compactedSeq,
    stateBytes: row.stateBytes,
    tailBytes,
    bytes: row.stateBytes + tailBytes,
  };
}

/** What `appendChanges` stored. */
export interface Appended {
  /** The numbers the changes got, in order. */
  seqs: number[];
  /** The document's newest change now (the last of `seqs`). */
  headSeq: number;
  /** Where its last compaction stopped: `headSeq - compactedSeq` changes wait to be folded in. */
  compactedSeq: number;
}

const runOf = (actor: LiveChangeActor) => (actor.runId && UUID.test(actor.runId) ? actor.runId : null);

/**
 * Stores changes in order, each with the next number, taken under the document row's lock (one statement raises
 * `head_seq` by all of them, so two processes writing at once never share a number), and who made the last of them.
 * `inTx` runs in the same transaction (a job the change arms). Throws `artifact.not_found` when the file has no live
 * document any more (purged, or its workspace deleted).
 */
export async function appendChanges(
  db: Database,
  orgId: string,
  fileId: string,
  changes: readonly { update: Uint8Array; actor: LiveChangeActor }[],
  at: Date,
  options: { inTx?: (tx: Executor, appended: Appended) => Promise<void> } = {},
): Promise<Appended> {
  if (!valid(orgId, fileId)) throw new NotFoundError("Artifact not found", "artifact.not_found");
  const last = changes.at(-1);
  if (!last) {
    const row = await liveDocHead(db, orgId, fileId);
    if (!row) throw new NotFoundError("Artifact not found", "artifact.not_found");
    return { seqs: [], headSeq: row.headSeq, compactedSeq: row.compactedSeq };
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(liveDocs)
      .set({
        headSeq: sql`${liveDocs.headSeq} + ${changes.length}`,
        editedAt: at,
        editedByType: last.actor.type,
        editedById: last.actor.id,
        editedRunId: runOf(last.actor),
        updatedAt: at,
      })
      .where(and(eq(liveDocs.artifactId, fileId), eq(liveDocs.orgId, orgId)))
      .returning({ headSeq: liveDocs.headSeq, compactedSeq: liveDocs.compactedSeq });
    if (!row) throw new NotFoundError("Artifact not found", "artifact.not_found");
    const first = row.headSeq - changes.length + 1;
    await tx.insert(liveDocUpdates).values(
      changes.map((change, i) => ({
        artifactId: fileId,
        orgId,
        seq: first + i,
        update: toB64(change.update),
        bytes: change.update.byteLength,
        actorType: change.actor.type,
        actorId: change.actor.id,
        runId: runOf(change.actor),
        createdAt: at,
      })),
    );
    const appended: Appended = {
      seqs: changes.map((_, i) => first + i),
      headSeq: row.headSeq,
      compactedSeq: row.compactedSeq,
    };
    await options.inTx?.(tx, appended);
    return appended;
  });
}

/**
 * Folds the changes up to `seq` into the state (a compaction), unless another compaction moved the document since
 * `from` was read: the row is locked, the state and its preview written and the folded changes deleted in one
 * transaction. Changes stored after `seq` stay. False when nothing was written.
 */
export async function writeCompacted(
  db: Database,
  orgId: string,
  fileId: string,
  input: { from: number; seq: number; state: Uint8Array; preview: Record<string, unknown> | null; at: Date },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ compactedSeq: liveDocs.compactedSeq, headSeq: liveDocs.headSeq })
      .from(liveDocs)
      .where(and(eq(liveDocs.artifactId, fileId), eq(liveDocs.orgId, orgId)))
      .for("update");
    if (!row || row.compactedSeq !== input.from || input.seq > row.headSeq || input.seq <= input.from) return false;
    await tx
      .update(liveDocs)
      .set({
        state: toB64(input.state),
        stateBytes: input.state.byteLength,
        compactedSeq: input.seq,
        ...(input.preview ? { preview: input.preview } : {}),
        updatedAt: input.at,
      })
      .where(eq(liveDocs.artifactId, fileId));
    await tx
      .delete(liveDocUpdates)
      .where(and(eq(liveDocUpdates.artifactId, fileId), lte(liveDocUpdates.seq, input.seq)));
    return true;
  });
}

/**
 * Whether an update inserts anything (Yjs structs) rather than only deleting: a document past its limits still takes
 * deletions, so people can bring it back under them. Unreadable bytes count as inserting (refused alike).
 */
export function updateInserts(update: Uint8Array): boolean {
  try {
    return Y.decodeUpdate(update).structs.length > 0;
  } catch {
    return true;
  }
}
