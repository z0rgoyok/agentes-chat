import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { SYSTEM } from "@agenteschat/live";
import {
  addChannelMember,
  artifactDownload,
  artifactFile,
  createArtifact,
  createChannel,
  createLiveFile,
  deleteArtifact,
  getArtifact,
  getAsset,
  isLiveArtifactKind,
  type LiveDocs,
  listArtifacts,
  liveFileAccess,
  NotFoundError,
  purgeDeletedArtifacts,
  putAsset,
  requireLiveFile,
  restoreArtifact,
  shareArtifact,
  updateArtifact,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { cellValue, liveDocsFor, makeLiveFile, personActor, setCell } from "./live-fixtures";

/** A 1×1 PNG. */
const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);

let f: Fixture;
let docs: LiveDocs;
beforeEach(async () => {
  f = await setup();
  docs = liveDocsFor(f, "a");
});
afterEach(async () => {
  await docs.stop();
  await f.close();
});

const owner = () => personActor(f.owner.id);
const agent = (channelId: string, runId?: string) => ({
  type: "agent" as const,
  agentId: f.agent.id,
  channelId,
  runId: runId ?? null,
});

describe("making one", () => {
  test("each kind, in the Drive or a conversation the person reads, with version 1 and its live document", async () => {
    for (const kind of ["spreadsheet", "slides", "canvas"] as const) {
      const made = await createLiveFile(f.artifactDeps, owner(), f.org.id, { kind, title: ` ${kind} ` });
      expect(made).toMatchObject({ kind, title: kind, version: 1, channelId: null, inDrive: true, untrusted: false });
      const [row] = await f.db.select().from(schema.liveDocs).where(eq(schema.liveDocs.artifactId, made.id));
      expect(row).toMatchObject({ kind, headSeq: 0, compactedSeq: 0 });
      expect(row?.preview).not.toBeNull();
      const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, made.id));
      expect(audit.map((a) => a.action)).toContain("artifact.created");
    }
    const inGeneral = await makeLiveFile(f, "slides", { channelId: f.general.id });
    expect(inGeneral.channelId).toBe(f.general.id);
    const eng = await createChannel(f.db, f.owner.id, f.org.id, { name: "eng", visibility: "private" });
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    await expect(makeLiveFile(f, "canvas", { channelId: eng.id, actor: personActor(ana.id) })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      createLiveFile(f.artifactDeps, owner(), f.org.id, { kind: "table" as never, title: "No" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("an agent's lands in its run's conversation, filled before version 1; a fill past the limits is refused", async () => {
    const made = await createLiveFile(f.artifactDeps, agent(f.general.id, crypto.randomUUID()), f.org.id, {
      kind: "spreadsheet",
      title: "Costs",
      init: (doc) => setCell(doc, 0, 0, "Item"),
    });
    expect(made.channelId).toBe(f.general.id);
    const { doc } = await docs.read(f.org.id, made.id);
    expect(cellValue(doc, 0, 0)).toBe("Item");
    doc.destroy();
    const [v1] = await f.db
      .select()
      .from(schema.artifactVersions)
      .where(eq(schema.artifactVersions.artifactId, made.id));
    expect(v1).toMatchObject({ authorType: "agent", authorId: f.agent.id });
    await expect(
      createLiveFile(f.artifactDeps, owner(), f.org.id, {
        kind: "spreadsheet",
        title: "Too many",
        init: (d) => d.getArray<string>("sheetOrder").push(Array.from({ length: 60 }, (_, i) => `s${i}`)),
      }),
    ).rejects.toMatchObject({ code: "live.too_large" });
  });
});

describe("who opens it, and how", () => {
  test("people read and change what they read; out of reach, another kind or no id at all is nothing", async () => {
    const file = await makeLiveFile(f);
    expect(await liveFileAccess(f.artifactDeps, owner(), f.org.id, file.id)).toMatchObject({
      kind: "spreadsheet",
      mode: "edit",
    });
    const eng = await createChannel(f.db, f.owner.id, f.org.id, { name: "eng", visibility: "private" });
    const hidden = await makeLiveFile(f, "canvas", { channelId: eng.id });
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    expect(await liveFileAccess(f.artifactDeps, personActor(ana.id), f.org.id, hidden.id)).toBeNull();
    expect(await liveFileAccess(f.artifactDeps, personActor(ana.id), f.org.id, file.id)).toMatchObject({
      mode: "edit",
    });
    await addChannelMember(f.db, f.owner.id, f.org.id, eng.id, { userId: ana.id });
    expect(await liveFileAccess(f.artifactDeps, personActor(ana.id), f.org.id, hidden.id)).toMatchObject({
      mode: "edit",
    });
    const table = await createArtifact(f.artifactDeps, owner(), f.org.id, {
      title: "Notes",
      content: { kind: "table", columns: ["a"], rows: [["1"]] },
    });
    expect(await liveFileAccess(f.artifactDeps, owner(), f.org.id, table.id)).toBeNull();
    expect(await liveFileAccess(f.artifactDeps, owner(), f.org.id, "nope")).toBeNull();
    expect(await liveFileAccess(f.artifactDeps, owner(), f.org.id, crypto.randomUUID())).toBeNull();
    const stranger = await addMember(f.db, f.org.id, "member", "zed");
    await f.db.delete(schema.organizationMembers).where(eq(schema.organizationMembers.userId, stranger.id));
    expect(await liveFileAccess(f.artifactDeps, personActor(stranger.id), f.org.id, file.id)).toBeNull();
  });

  test("read-only in the trash and while the workspace is being deleted; restored, it changes again", async () => {
    const file = await makeLiveFile(f);
    await deleteArtifact(f.artifactDeps, f.owner.id, f.org.id, file.id);
    expect(await liveFileAccess(f.artifactDeps, owner(), f.org.id, file.id)).toMatchObject({ mode: "view" });
    await expect(requireLiveFile(f.artifactDeps, owner(), f.org.id, file.id, { write: true })).rejects.toMatchObject({
      code: "live.read_only",
    });
    // Agents don't open files in the trash at all.
    expect(await liveFileAccess(f.artifactDeps, agent(f.general.id), f.org.id, file.id)).toBeNull();
    await restoreArtifact(f.artifactDeps, f.owner.id, f.org.id, file.id);
    expect(await liveFileAccess(f.artifactDeps, owner(), f.org.id, file.id)).toMatchObject({ mode: "edit" });
    await f.db
      .update(schema.organizations)
      .set({ deletionDueAt: new Date(Date.now() + 7 * 86_400_000) })
      .where(eq(schema.organizations.id, f.org.id));
    expect(await liveFileAccess(f.artifactDeps, owner(), f.org.id, file.id)).toMatchObject({ mode: "view" });
  });

  test("an agent changes what it reaches and only reads what its person shows it elsewhere", async () => {
    const inGeneral = await makeLiveFile(f, "spreadsheet", { channelId: f.general.id });
    expect(await liveFileAccess(f.artifactDeps, agent(f.general.id), f.org.id, inGeneral.id)).toMatchObject({
      mode: "edit",
    });
    const eng = await createChannel(f.db, f.owner.id, f.org.id, { name: "eng", visibility: "private" });
    const theirs = await makeLiveFile(f, "spreadsheet", { channelId: eng.id });
    expect(await liveFileAccess(f.artifactDeps, agent(f.general.id), f.org.id, theirs.id)).toBeNull();
    await expect(
      requireLiveFile(f.artifactDeps, agent(f.general.id), f.org.id, theirs.id, { write: true }),
    ).rejects.toThrow(/File not found/);
    // Another kind: told which tools read and change it.
    const table = await createArtifact(f.artifactDeps, owner(), f.org.id, {
      title: "Notes",
      content: { kind: "table", columns: ["a"], rows: [["1"]] },
    });
    await expect(requireLiveFile(f.artifactDeps, agent(f.general.id), f.org.id, table.id)).rejects.toThrow(
      /read_artifact/,
    );
  });
});

describe("the Drive around it", () => {
  test("it is never saved whole: updateArtifact refuses it, naming its own tools", async () => {
    const file = await makeLiveFile(f);
    await expect(
      updateArtifact(f.artifactDeps, owner(), f.org.id, file.id, {
        content: { kind: "document", markdown: "x" },
        baseVersion: 1,
      } as never),
    ).rejects.toMatchObject({ code: "artifact.live_only" });
    await expect(
      createArtifact(f.artifactDeps, owner(), f.org.id, { title: "x", content: { kind: "spreadsheet" } }),
    ).rejects.toMatchObject({ code: "artifact.live_only" });
  });

  test("listed and filtered by kind like any file", async () => {
    const sheet = await makeLiveFile(f);
    const deck = await makeLiveFile(f, "slides", { title: "Pitch" });
    await createArtifact(f.artifactDeps, owner(), f.org.id, {
      title: "Notes",
      content: { kind: "table", columns: ["a"], rows: [["1"]] },
    });
    const live = await listArtifacts(f.db, owner(), f.org.id, { kinds: ["spreadsheet", "slides", "canvas"] });
    expect(live.map((a) => a.id).sort()).toEqual([sheet.id, deck.id].sort());
    const byKind = await listArtifacts(f.db, owner(), f.org.id, { sort: "kind" });
    expect(byKind.map((a) => a.kind)).toEqual(["spreadsheet", "slides", "table"]);
    expect(isLiveArtifactKind("canvas")).toBe(true);
    // A document is a live file too (ADR 0200).
    expect(isLiveArtifactKind("document")).toBe(true);
    expect(isLiveArtifactKind("table")).toBe(false);
  });

  test("shared into another conversation, it is copied whole at its head, pictures and all", async () => {
    const eng = await createChannel(f.db, f.owner.id, f.org.id, { name: "eng", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, eng.id, { agentId: f.agent.id });
    const file = await makeLiveFile(f, "canvas", { channelId: eng.id });
    const picture = await putAsset(f.artifactDeps, owner(), f.org.id, file.id, {
      bytes: PNG,
      contentType: "image/png",
      source: "upload",
    });
    await docs.edit(f.org.id, file.id, SYSTEM, (doc) => doc.getMap("canvas").set("bg", "grid"));
    // The agent, asked in #general by the owner (who reads #eng too), brings it over: a copy for #general's audience.
    const shared = await shareArtifact(f.artifactDeps, agent(f.general.id), f.org.id, file.id, {
      requesterUserId: f.owner.id,
    });
    expect(shared.copied).toBe(true);
    expect(shared.artifact).toMatchObject({ kind: "canvas", channelId: f.general.id });
    const { doc } = await docs.read(f.org.id, shared.artifact.id);
    expect(doc.getMap("canvas").get("bg")).toBe("grid");
    doc.destroy();
    // Its pictures came along under the same ids, so the copied document's shapes still find them.
    const copied = await getAsset(f.artifactDeps, owner(), f.org.id, shared.artifact.id, picture.id);
    expect(copied).toMatchObject({ contentType: "image/png", size: PNG.byteLength });
  });

  test("downloads go through the server, which writes the export; the head's preview reads the document", async () => {
    const file = await makeLiveFile(f, "canvas");
    const link = await artifactDownload(f.artifactDeps, f.owner.id, f.org.id, file.id);
    expect(link.url).toBe(`/api/app/organizations/${f.org.id}/artifacts/${file.id}/file`);
    // Without a writer of Office files on this server, a canvas still downloads as its document's JSON.
    const json = await artifactFile(f.artifactDeps, f.owner.id, f.org.id, file.id, { format: "json" });
    expect(json.contentType).toBe("application/json");
    const sheet = await makeLiveFile(f);
    const detail = await getArtifact(f.artifactDeps, owner(), f.org.id, sheet.id);
    expect(detail.content.kind).toBe("spreadsheet");
    expect(detail.versioned).toBe(true);
  });

  test("thirty days in the trash, its document, changes and pictures go; the row stays", async () => {
    const file = await makeLiveFile(f);
    await docs.edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, 0, 0, "gone soon"));
    await deleteArtifact(f.artifactDeps, f.owner.id, f.org.id, file.id);
    await f.db
      .update(schema.artifacts)
      .set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(schema.artifacts.id, file.id));
    expect(await purgeDeletedArtifacts(f.artifactDeps)).toBeGreaterThan(0);
    expect(await f.db.select().from(schema.liveDocs).where(eq(schema.liveDocs.artifactId, file.id))).toEqual([]);
    expect(
      await f.db.select().from(schema.liveDocUpdates).where(eq(schema.liveDocUpdates.artifactId, file.id)),
    ).toEqual([]);
    expect(await f.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, file.id))).toHaveLength(1);
    // Asked to open it again: nothing there.
    await expect(docs.read(f.org.id, file.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("its search text comes from its whole document", async () => {
    const file = await createLiveFile(f.artifactDeps, owner(), f.org.id, {
      kind: "spreadsheet",
      title: "Budget",
      init: (doc) => setCell(doc, 2, 2, "Quarterly rocket fuel"),
    });
    const [row] = await f.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, file.id));
    expect(row?.excerpt).toContain("Quarterly rocket fuel");
  });
});
