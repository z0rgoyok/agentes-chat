import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { SYSTEM } from "@agenteschat/live";
import { addShape } from "@agenteschat/live/canvas";
import { getArtifact, type LiveDocs } from "../src";
import { type Fixture, setup } from "./fixtures";
import { liveDocsFor, makeLiveFile, personActor, setCell } from "./live-fixtures";

/**
 * A live file's preview (ADR 0196 §7) is drawn again from the document a process holds shortly after its changes are
 * stored, not only at a compaction (200 changes, or a minute after the last person leaves): a canvas an agent draws on
 * shows those shapes on its cards within seconds, and the conversation the file lives in hears it.
 */

const PREVIEW_MS = 30;

let f: Fixture;
let docs: LiveDocs;

beforeEach(async () => {
  f = await setup();
  docs = liveDocsFor(f, "a", { timing: { previewMs: PREVIEW_MS } });
});

afterEach(async () => {
  await docs.stop();
  await f.close();
});

type StoredPreview = { shapes?: { type: string; kind?: string }[] } | null;

const storedPreview = async (fileId: string): Promise<StoredPreview> => {
  const [row] = await f.db
    .select({ preview: schema.liveDocs.preview })
    .from(schema.liveDocs)
    .where(eq(schema.liveDocs.artifactId, fileId));
  return (row?.preview ?? null) as StoredPreview;
};

/** Waits for `done` (polling), as a card would for the event. */
async function eventually(done: () => Promise<boolean> | boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await done()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** `count` once it stopped moving for a few spans (what was asked has been drawn and told). */
async function quiet(count: () => number) {
  let last = -1;
  while (last !== count()) {
    last = count();
    await Bun.sleep(PREVIEW_MS * 10);
  }
  return last;
}

const updatesOf = (events: { type: string }[], fileId: string) =>
  events.filter((e) => e.type === "artifact.updated" && (e as { artifact?: { id?: string } }).artifact?.id === fileId);

describe("a live file's preview, drawn again soon after it changes", () => {
  test("an agent's shapes reach the canvas's cards without a compaction, and its conversation hears it", async () => {
    const file = await makeLiveFile(f, "canvas", { title: "Mapa", channelId: f.general.id });
    const events = f.listen(f.general.id);
    expect((await storedPreview(file.id))?.shapes ?? []).toEqual([]);

    await docs.edit(f.org.id, file.id, SYSTEM, (doc) => {
      addShape(doc, { type: "shape", kind: "rect", x: 0, y: 0, w: 200, h: 100 }, SYSTEM);
      addShape(doc, { type: "shape", kind: "ellipse", x: 240, y: 0, w: 120, h: 120 }, SYSTEM);
      addShape(doc, { type: "text", text: "Olá", x: 0, y: 160, w: 200, h: 40 }, SYSTEM);
    });
    await eventually(async () => ((await storedPreview(file.id))?.shapes?.length ?? 0) === 3, "the new preview");

    // What the cards read: the head's preview, with the agent's shapes.
    const head = await getArtifact(f.artifactDeps, personActor(f.owner.id), f.org.id, file.id);
    expect(head.content.kind).toBe("canvas");
    const shapes = (head.content as { preview: { shapes: { type: string; kind?: string }[] } }).preview.shapes;
    expect(shapes.map((s) => s.kind ?? s.type).sort()).toEqual(["ellipse", "rect", "text"]);
    // The conversation the file lives in reads it again.
    await eventually(() => updatesOf(events, file.id).length === 1, "artifact.updated");
    // Still nothing folded: the preview didn't wait for a compaction.
    const [row] = await f.db.select().from(schema.liveDocs).where(eq(schema.liveDocs.artifactId, file.id));
    expect(row?.compactedSeq).toBe(0);
  });

  test("a burst is drawn once, and a change the preview doesn't show is neither written nor told", async () => {
    const file = await makeLiveFile(f, "canvas", { title: "Mapa", channelId: f.general.id });
    const events = f.listen(f.general.id);
    for (let i = 0; i < 5; i++) {
      await docs.edit(f.org.id, file.id, SYSTEM, (doc) =>
        addShape(doc, { type: "shape", kind: "rect", x: i * 220, y: 0, w: 200, h: 100 }, SYSTEM),
      );
    }
    await eventually(async () => ((await storedPreview(file.id))?.shapes?.length ?? 0) === 5, "the burst's preview");
    const told = await quiet(() => updatesOf(events, file.id).length);
    // The five edits came within a span or two: fewer draws than edits.
    expect(told).toBeGreaterThanOrEqual(1);
    expect(told).toBeLessThan(5);

    // Something no card draws: no write, no event.
    // (The document may have been let go and loaded again meanwhile: it knows the stored preview all the same.)
    await docs.edit(f.org.id, file.id, SYSTEM, (doc) => doc.getMap("meta").set("touched", 1));
    expect(await quiet(() => updatesOf(events, file.id).length)).toBe(told);
  });

  test("a spreadsheet's cells reach its cover the same way", async () => {
    const file = await makeLiveFile(f, "spreadsheet", { title: "Custos", channelId: f.general.id });
    await docs.edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, 0, 0, "Café"));
    await eventually(async () => {
      const preview = (await storedPreview(file.id)) as { rows?: string[][] } | null;
      return preview?.rows?.[0]?.[0] === "Café";
    }, "the sheet's preview");
  });
});
