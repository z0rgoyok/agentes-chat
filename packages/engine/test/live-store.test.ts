import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import * as Y from "yjs";
import { appendChanges, liveDocMeta, readSince, updateInserts, writeCompacted } from "../src/live/store";
import { type Fixture, setup } from "./fixtures";
import { makeLiveFile } from "./live-fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(async () => {
  await f.close();
});

/** A Yjs update setting `key` in a map: what a change from an app looks like. */
function change(key: string, value: string) {
  const doc = new Y.Doc();
  doc.getMap("m").set(key, value);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

describe("where a live document is kept", () => {
  test("changes are numbered in order under the row, and the last one's author is kept on it", async () => {
    const file = await makeLiveFile(f);
    const at = new Date();
    const runId = crypto.randomUUID();
    let armed: number[] = [];
    const first = await appendChanges(
      f.db,
      f.org.id,
      file.id,
      [
        { update: change("a", "1"), actor: { type: "person", id: f.owner.id } },
        { update: change("b", "2"), actor: { type: "agent", id: f.agent.id, runId } },
      ],
      at,
      {
        inTx: async (_tx, appended) => {
          armed = appended.seqs;
        },
      },
    );
    expect(first).toEqual({ seqs: [1, 2], headSeq: 2, compactedSeq: 0 });
    expect(armed).toEqual([1, 2]);
    const second = await appendChanges(
      f.db,
      f.org.id,
      file.id,
      [{ update: change("c", "3"), actor: { type: "system", id: null, runId: "not-a-run" } }],
      at,
    );
    expect(second.seqs).toEqual([3]);
    const [row] = await f.db.select().from(schema.liveDocs).where(eq(schema.liveDocs.artifactId, file.id));
    expect(row).toMatchObject({ headSeq: 3, editedByType: "system", editedById: null, editedRunId: null });
    const rows = await f.db.select().from(schema.liveDocUpdates).where(eq(schema.liveDocUpdates.artifactId, file.id));
    expect(rows.find((r) => r.seq === 2)).toMatchObject({ actorType: "agent", actorId: f.agent.id, runId });
    // Nothing for a file without a live document, or of another workspace.
    await expect(
      appendChanges(
        f.db,
        crypto.randomUUID(),
        file.id,
        [{ update: change("x", "y"), actor: { type: "system", id: null } }],
        at,
      ),
    ).rejects.toMatchObject({ code: "artifact.not_found" });
  });

  test("a compaction folds what it read; one that started from a stale state writes nothing", async () => {
    const file = await makeLiveFile(f);
    const at = new Date();
    await appendChanges(
      f.db,
      f.org.id,
      file.id,
      [{ update: change("a", "1"), actor: { type: "system", id: null } }],
      at,
    );
    await appendChanges(
      f.db,
      f.org.id,
      file.id,
      [{ update: change("b", "2"), actor: { type: "system", id: null } }],
      at,
    );
    const merged = Y.mergeUpdates([change("a", "1"), change("b", "2")]);
    expect(await writeCompacted(f.db, f.org.id, file.id, { from: 0, seq: 1, state: merged, preview: null, at })).toBe(
      true,
    );
    // Another compaction read the document before this one wrote: it no longer matches, and writes nothing.
    expect(await writeCompacted(f.db, f.org.id, file.id, { from: 0, seq: 2, state: merged, preview: null, at })).toBe(
      false,
    );
    // Past the head, or nothing to fold: nothing either.
    expect(await writeCompacted(f.db, f.org.id, file.id, { from: 1, seq: 9, state: merged, preview: null, at })).toBe(
      false,
    );
    // A process at change 0 is behind the compaction: it gets the whole state and the change after it.
    const behind = await readSince(f.db, f.org.id, file.id, 0);
    expect(behind?.state).not.toBeNull();
    expect(Y.decodeUpdate(behind?.state ?? new Uint8Array()).structs.length).toBeGreaterThan(0);
    expect(behind?.changes.map((c) => c.seq)).toEqual([2]);
    expect(behind?.head).toBe(2);
    // One at the head lacks nothing, and the check reads where the changes stand, never the whole document.
    const current = await readSince(f.db, f.org.id, file.id, 2);
    expect(current).toMatchObject({ state: null, changes: [], head: 2 });
    expect(current?.row).toEqual({ headSeq: 2, compactedSeq: 1 });
    // The row without its state: what decides a version or draws a card.
    const meta = await liveDocMeta(f.db, f.org.id, file.id);
    expect(meta).toMatchObject({ headSeq: 2, compactedSeq: 1 });
    expect(meta).not.toHaveProperty("state");
    expect(await liveDocMeta(f.db, f.org.id, crypto.randomUUID())).toBeNull();
    expect(await readSince(f.db, f.org.id, crypto.randomUUID(), 0)).toBeNull();
  });

  test("a change that only deletes inserts nothing; unreadable bytes count as inserting", () => {
    const doc = new Y.Doc();
    doc.getMap("m").set("a", "1");
    const before = Y.encodeStateVector(doc);
    doc.getMap("m").delete("a");
    expect(updateInserts(Y.encodeStateAsUpdate(doc, before))).toBe(false);
    expect(updateInserts(change("b", "2"))).toBe(true);
    expect(updateInserts(new Uint8Array([255, 255, 255]))).toBe(true);
    doc.destroy();
  });
});
