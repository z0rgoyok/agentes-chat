import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { and, asc, eq, schema } from "@agenteschat/db";
import { agentOrigin, SYSTEM } from "@agenteschat/live";
import * as Y from "yjs";
import {
  compactLiveDoc,
  getArtifact,
  idleDecision,
  LIVE_CHECKPOINT_JOB,
  LIVE_COMPACT_JOB,
  LIVE_COMPACTION,
  LIVE_SNAPSHOT_TYPE,
  type LiveDocs,
  processOutbox,
  writeCheckpoint,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { cellValue, liveDocsFor, makeLiveFile, personActor, setCell } from "./live-fixtures";

let f: Fixture;
let docs: LiveDocs;

beforeEach(async () => {
  f = await setup();
  docs = liveDocsFor(f, "a");
});

afterEach(async () => {
  setSystemTime();
  await docs.stop();
  await f.close();
});

const MINUTE = 60_000;

const versionsOf = (fileId: string) =>
  f.db
    .select()
    .from(schema.artifactVersions)
    .where(eq(schema.artifactVersions.artifactId, fileId))
    .orderBy(asc(schema.artifactVersions.version));

const jobsOf = (kind: string) => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, kind));

/** Runs the jobs due by `at` with the clock at `at`, as a worker would then. */
const runJobsAt = (at: Date) => {
  setSystemTime(at);
  return processOutbox(f.db, f.handlers, { workerId: "test", now: at });
};

describe("a live file's versions", () => {
  test("version 1 is a snapshot of its first document; with no version asked, the head comes back", async () => {
    const file = await makeLiveFile(f);
    const [v1] = await versionsOf(file.id);
    expect(v1).toMatchObject({ version: 1, contentType: LIVE_SNAPSHOT_TYPE, authorType: "person" });
    await docs.edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, 0, 0, "Café"));
    // The head's preview comes from the document once it is compacted, version 1's from its snapshot.
    await compactLiveDoc(f.artifactDeps, f.org.id, file.id);
    const head = await getArtifact(f.artifactDeps, personActor(f.owner.id), f.org.id, file.id);
    expect(head.content.kind).toBe("spreadsheet");
    expect(JSON.stringify(head.content)).toContain("Café");
    const first = await getArtifact(f.artifactDeps, personActor(f.owner.id), f.org.id, file.id, 1);
    expect(first.shownVersion).toBe(1);
    expect(JSON.stringify(first.content)).not.toContain("Café");
  });

  test("an agent's batch: the first of its run at once, then at most once a minute; a new run's first again", async () => {
    const file = await makeLiveFile(f);
    const run1 = crypto.randomUUID();
    const t0 = Date.now();
    await docs.edit(f.org.id, file.id, agentOrigin(f.agent.id, run1), (doc) => setCell(doc, 0, 0, 1));
    await docs.edit(f.org.id, file.id, agentOrigin(f.agent.id, run1), (doc) => setCell(doc, 0, 0, 2));
    let versions = await versionsOf(file.id);
    expect(versions.map((v) => [v.version, v.authorType, v.runId])).toEqual([
      [1, "person", null],
      [2, "agent", run1],
    ]);
    // Another run of the same agent: its first batch writes one, so its hand-off finds the file.
    const run2 = crypto.randomUUID();
    await docs.edit(f.org.id, file.id, agentOrigin(f.agent.id, run2), (doc) => setCell(doc, 0, 0, 3));
    versions = await versionsOf(file.id);
    expect(versions.at(-1)).toMatchObject({ version: 3, authorType: "agent", authorId: f.agent.id, runId: run2 });
    // A minute later, the same run writes one again.
    setSystemTime(new Date(t0 + MINUTE + 1000));
    await docs.edit(f.org.id, file.id, agentOrigin(f.agent.id, run2), (doc) => setCell(doc, 0, 0, 4));
    expect((await versionsOf(file.id)).length).toBe(4);
  });

  test("a version saved by hand, with a note; the same snapshot is never written twice", async () => {
    const file = await makeLiveFile(f);
    const author = { type: "person" as const, id: f.owner.id };
    expect(await docs.checkpoint(f.org.id, file.id, { author, force: true })).toBeNull();
    await docs.edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, 1, 1, "x"));
    expect(await docs.checkpoint(f.org.id, file.id, { author, note: "Before the meeting", force: true })).toBe(2);
    expect(await docs.checkpoint(f.org.id, file.id, { author, force: true })).toBeNull();
    const [, v2] = await versionsOf(file.id);
    expect(v2).toMatchObject({ note: "Before the meeting", authorId: f.owner.id });
    // The snapshot is the document: read back, it holds the cell.
    const read = await getArtifact(f.artifactDeps, personActor(f.owner.id), f.org.id, file.id, 2);
    expect(read.content.kind).toBe("spreadsheet");
    // Without `force`, nothing stored since the last version writes nothing either.
    expect(await writeCheckpoint(f.artifactDeps, f.org.id, file.id)).toBeNull();
  });

  test("a file in the trash gets no version", async () => {
    const file = await makeLiveFile(f);
    await docs.edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, 0, 0, "y"));
    await f.db.update(schema.artifacts).set({ deletedAt: new Date() }).where(eq(schema.artifacts.id, file.id));
    expect(await writeCheckpoint(f.artifactDeps, f.org.id, file.id, { force: true })).toBeNull();
  });
});

describe("after a quiet spell", () => {
  test("people's changes arm the check; it writes a version once five minutes passed quietly", async () => {
    const file = await makeLiveFile(f);
    const t0 = Date.now();
    await docs.edit(f.org.id, file.id, { kind: "system", userId: f.owner.id }, (doc) => setCell(doc, 0, 0, "a"));
    const [armed] = await jobsOf(LIVE_CHECKPOINT_JOB);
    expect(armed?.payload).toEqual({ fileId: file.id });
    expect(armed?.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(t0 + 5 * MINUTE - 1000);
    await runJobsAt(new Date(t0 + 6 * MINUTE));
    const versions = await versionsOf(file.id);
    expect(versions.at(-1)).toMatchObject({ version: 2, authorType: "person", authorId: f.owner.id });
    expect(versions.at(-1)?.runId).toBeNull();
  });

  test("while changes go on it looks again later, and writes one after 30 minutes anyway", () => {
    const createdAt = new Date("2026-11-17T10:00:00Z");
    const at = (minutes: number) => new Date(createdAt.getTime() + minutes * MINUTE);
    const row = { headSeq: 9, checkpointSeq: 2, createdAt, checkpointAt: at(0) };
    expect(idleDecision({ ...row, headSeq: 2, editedAt: at(1) }, at(6))).toEqual({ kind: "none" });
    expect(idleDecision({ ...row, editedAt: at(1) }, at(6))).toEqual({ kind: "write" });
    expect(idleDecision({ ...row, editedAt: at(5) }, at(6))).toEqual({ kind: "wait", at: at(10) });
    expect(idleDecision({ ...row, editedAt: at(29) }, at(30))).toEqual({ kind: "write" });
    expect(idleDecision({ ...row, editedAt: at(26) }, at(27))).toEqual({ kind: "wait", at: at(30) });
  });

  test("a check that finds changes still coming arms the next one, which then writes", async () => {
    const file = await makeLiveFile(f);
    const t0 = Date.now();
    await docs.edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, 0, 0, "first"));
    setSystemTime(new Date(t0 + 4 * MINUTE));
    await docs.edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, 0, 0, "second"));
    // At five minutes the file changed a minute ago: no version yet, the next look is armed.
    await runJobsAt(new Date(t0 + 5 * MINUTE + 1000));
    expect((await versionsOf(file.id)).length).toBe(1);
    const looks = await jobsOf(LIVE_CHECKPOINT_JOB);
    expect(looks.some((j) => j.dedupeKey?.includes(":after:"))).toBe(true);
    await runJobsAt(new Date(t0 + 10 * MINUTE));
    expect((await versionsOf(file.id)).length).toBe(2);
    // The server wrote it: its author is whoever changed the file last (the file's maker here).
    expect((await versionsOf(file.id)).at(-1)?.authorId).toBe(f.owner.id);
  });
});

describe("compaction", () => {
  test("enough waiting changes ask for it; it folds them into the state, refreshes the preview and search text", async () => {
    const file = await makeLiveFile(f);
    for (let i = 0; i < LIVE_COMPACTION.changes; i++) {
      await docs.edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, i % 20, 1, `row ${i}`));
    }
    const asked = await jobsOf(LIVE_COMPACT_JOB);
    expect(asked.length).toBeGreaterThan(0);
    await runJobsAt(new Date(Date.now() + 1000));
    const [row] = await f.db.select().from(schema.liveDocs).where(eq(schema.liveDocs.artifactId, file.id));
    expect(row?.compactedSeq).toBe(LIVE_COMPACTION.changes);
    expect(row?.headSeq).toBe(LIVE_COMPACTION.changes);
    const left = await f.db.select().from(schema.liveDocUpdates).where(eq(schema.liveDocUpdates.artifactId, file.id));
    expect(left).toHaveLength(0);
    expect(JSON.stringify(row?.preview)).toContain("row");
    const [artifact] = await f.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, file.id));
    expect(artifact?.excerpt).toContain(`row ${LIVE_COMPACTION.changes - 1}`);
    // The document as stored now is what it was: the state alone holds every change.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(Buffer.from(row?.state ?? "", "base64")));
    expect(cellValue(doc, 19, 1)).toBe(`row ${LIVE_COMPACTION.changes - 1}`);
    doc.destroy();
  });

  test("a change stored after it stays for the next; a process left behind catches up across it", async () => {
    const file = await makeLiveFile(f);
    // Process b holds the file and hears none of its changes: only reading the database brings them.
    const deaf = {
      publish: f.pubsub.publish,
      subscribe: (topic: string, handler: (event: { type: string; [k: string]: unknown }) => void) =>
        f.pubsub.subscribe(topic, (event) => {
          if (event.type !== "live.update") handler(event);
        }),
    };
    const behind = liveDocsFor(f, "b", { pubsub: deaf });
    try {
      (await behind.read(f.org.id, file.id)).doc.destroy();
      await docs.edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, 0, 0, "one"));
      expect(await compactLiveDoc(f.artifactDeps, f.org.id, file.id)).toMatchObject({ compacted: true, seq: 1 });
      await docs.edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, 0, 1, "two"));
      const left = await f.db
        .select()
        .from(schema.liveDocUpdates)
        .where(and(eq(schema.liveDocUpdates.artifactId, file.id)));
      expect(left.map((r) => r.seq)).toEqual([2]);
      // b is at the head it loaded, before the compaction: it reads the whole state again, then what followed.
      const { doc } = await behind.read(f.org.id, file.id);
      expect([cellValue(doc, 0, 0), cellValue(doc, 0, 1)]).toEqual(["one", "two"]);
      doc.destroy();
      await compactLiveDoc(f.artifactDeps, f.org.id, file.id);
      expect(await compactLiveDoc(f.artifactDeps, f.org.id, file.id)).toMatchObject({ compacted: false, seq: 2 });
    } finally {
      await behind.stop();
    }
  });

  test("a file with no live document, or gone, compacts nothing", async () => {
    expect(await compactLiveDoc(f.artifactDeps, f.org.id, crypto.randomUUID())).toBeNull();
  });
});
