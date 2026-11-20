import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema, sql } from "@agenteschat/db";
import {
  type ArtifactActor,
  addChannelMember,
  audienceOfConversation,
  createAgent,
  createArtifact,
  createRole,
  deleteArtifact,
  duplicateLiveFile,
  ForbiddenError,
  fileReach,
  getArtifact,
  indexSource,
  listArtifacts,
  listDeletedArtifacts,
  liveFileAccess,
  NEW_AGENT_DEFAULTS,
  NotFoundError,
  openDm,
  openFileConversation,
  postPersonMessage,
  requireChannelAccess,
  requireLiveFile,
  searchForUser,
  setFileSharing,
  setMemberRoles,
  withPersonFacts,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { makeLiveFile, personActor } from "./live-fixtures";

/**
 * A file of the Drive itself (no conversation) lives with its maker (ADR 0157, amendment 2026-11-17): made shared
 * with everyone, as every Drive file was; `conversation` is its maker alone (and administrators), `people` adds who it
 * names. Its conversation, search, the trash, the agents and its copies follow.
 */

let f: Fixture;
afterEach(async () => {
  const open = f as Fixture | undefined;
  f = undefined as unknown as Fixture;
  await open?.close();
});

/** Bia made a spreadsheet in the Drive itself; Caio and Duda are other members, the owner an administrator. */
async function world() {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const duda = await addMember(f.db, f.org.id, "member", "duda");
  const sheet = await makeLiveFile(f, "spreadsheet", { title: "Orçamento", actor: personActor(bia.id) });
  /** Whether the person reads the file: listed in their Drive exactly when it opens for them. */
  const reads = async (userId: string, id = sheet.id) => {
    const listed = (await listArtifacts(f.db, personActor(userId), f.org.id)).some((a) => a.id === id);
    const opened = await getArtifact(f.artifactDeps, personActor(userId), f.org.id, id).then(
      () => true,
      (e: unknown) => {
        if (e instanceof NotFoundError) return false;
        throw e;
      },
    );
    expect(listed).toBe(opened);
    return opened;
  };
  const share = (userId: string, sharing: Parameters<typeof setFileSharing>[4]) =>
    setFileSharing(f.artifactDeps, userId, f.org.id, sheet.id, sharing);
  return { bia, caio, duda, sheet, reads, share };
}

describe("a file of the Drive itself (ADR 0157, amendment 2026-11-17)", () => {
  test("made shared with everyone, as every Drive file was; its maker and administrators may change that", async () => {
    const { bia, caio, duda, sheet, reads } = await world();
    expect(sheet.channelId).toBeNull();
    expect(sheet.sharing).toEqual({ mode: "everyone", userIds: [], roleIds: [] });
    for (const id of [bia.id, caio.id, duda.id, f.owner.id]) expect(await reads(id)).toBe(true);
    const canShare = async (userId: string) => (await withPersonFacts(f.db, userId, f.org.id, [sheet]))[0]?.canShare;
    expect(await canShare(bia.id)).toBe(true);
    expect(await canShare(f.owner.id)).toBe(true);
    expect(await canShare(caio.id)).toBe(false);
  });

  test("Só você: its maker and administrators, nobody else, in the Drive, search and the trash", async () => {
    const { bia, caio, sheet, reads, share } = await world();
    const saved = await share(bia.id, { mode: "conversation" });
    expect(saved.sharing).toEqual({ mode: "conversation", userIds: [], roleIds: [] });
    expect(await reads(bia.id)).toBe(true);
    expect(await reads(f.owner.id)).toBe(true);
    expect(await reads(caio.id)).toBe(false);

    const deps = { db: f.db, search: f.search, gateway: f.gateway };
    await indexSource(deps, { orgId: f.org.id, kind: "file", sourceId: sheet.id });
    const found = async (userId: string) =>
      (await searchForUser(deps, userId, f.org.id, { text: "Orçamento", kinds: ["file"] })).some(
        (h) => h.sourceId === sheet.id,
      );
    expect(await found(bia.id)).toBe(true);
    expect(await found(f.owner.id)).toBe(true);
    expect(await found(caio.id)).toBe(false);

    await deleteArtifact(f.artifactDeps, bia.id, f.org.id, sheet.id);
    const trash = async (userId: string) => (await listDeletedArtifacts(f.db, userId, f.org.id)).map((a) => a.id);
    expect(await trash(bia.id)).toContain(sheet.id);
    expect(await trash(f.owner.id)).toContain(sheet.id);
    expect(await trash(caio.id)).not.toContain(sheet.id);
  });

  test("people: its maker, who it names, a role's holders and administrators; everyone opens it again", async () => {
    const { bia, caio, duda, sheet, reads, share } = await world();
    const finance = await createRole(f.db, f.owner.id, f.org.id, { name: "Financeiro", permissions: [] });
    await share(bia.id, { mode: "people", userIds: [caio.id], roleIds: [finance.id] });
    expect(await reads(bia.id)).toBe(true);
    expect(await reads(caio.id)).toBe(true);
    expect(await reads(f.owner.id)).toBe(true);
    expect(await reads(duda.id)).toBe(false);
    await setMemberRoles(f.db, f.owner.id, f.org.id, duda.id, [finance.id]);
    expect(await reads(duda.id)).toBe(true);

    const deps = { db: f.db, search: f.search, gateway: f.gateway };
    await indexSource(deps, { orgId: f.org.id, kind: "file", sourceId: sheet.id });
    const hits = await searchForUser(deps, caio.id, f.org.id, { text: "Orçamento", kinds: ["file"] });
    expect(hits.map((h) => h.sourceId)).toContain(sheet.id);

    await share(bia.id, { mode: "conversation" });
    expect(await reads(caio.id)).toBe(false);
    await share(bia.id, { mode: "everyone" });
    expect(await reads(caio.id)).toBe(true);
  });

  test("who changes it: its maker and administrators; who it was shared with is refused, an outsider not found", async () => {
    const { bia, caio, duda, share } = await world();
    await share(bia.id, { mode: "people", userIds: [caio.id] });
    const refused = await share(caio.id, { mode: "everyone" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ForbiddenError);
    expect((refused as ForbiddenError).code).toBe("artifact.sharing_forbidden");
    await expect(share(duda.id, { mode: "everyone" })).rejects.toBeInstanceOf(NotFoundError);
    // An administrator, who isn't its maker, changes it too.
    expect((await share(f.owner.id, { mode: "conversation" })).sharing.mode).toBe("conversation");
    // Each change is audited like a conversation's file's.
    const rows = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "artifact.sharing_changed"));
    expect(rows.map((r) => [r.actorId, (r.details as { from: string; mode: string }).mode])).toEqual([
      [bia.id, "people"],
      [f.owner.id, "conversation"],
    ]);
  });

  test("its conversation follows: who reads the file reads it, and what is made there is its maker's", async () => {
    const { bia, caio, sheet, share } = await world();
    const at = await openFileConversation(f.artifactDeps, bia.id, f.org.id, sheet.id);
    expect((await requireChannelAccess(f.db, caio.id, f.org.id, at.channelId)).channel.id).toBe(at.channelId);
    expect(await audienceOfConversation(f.db, at.channelId)).toEqual({ mode: "everyone" });

    await share(bia.id, { mode: "conversation" });
    await expect(requireChannelAccess(f.db, caio.id, f.org.id, at.channelId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      postPersonMessage({ db: f.db, pubsub: f.pubsub }, caio.id, f.org.id, at.channelId, {
        body: "oi",
        threadId: at.rootId,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await requireChannelAccess(f.db, f.owner.id, f.org.id, at.channelId)).channel.id).toBe(at.channelId);
    expect(await audienceOfConversation(f.db, at.channelId)).toEqual({ mode: "people", userIds: [bia.id] });

    await share(bia.id, { mode: "people", userIds: [caio.id] });
    expect((await requireChannelAccess(f.db, caio.id, f.org.id, at.channelId)).channel.id).toBe(at.channelId);
  });

  test("an agent: a Drive file only its maker sees is out of its reach, but read for its maker and worked on in its conversation", async () => {
    const { bia, caio, sheet, share } = await world();
    const inGeneral: ArtifactActor = { type: "agent", agentId: f.agent.id, channelId: f.general.id };
    const listed = async (actor: ArtifactActor, requesterUserId: string | null = null) =>
      (await listArtifacts(f.db, actor, f.org.id, { requesterUserId })).some((a) => a.id === sheet.id);
    // Shared with everyone: the workspace's, so every agent's.
    expect(await listed(inGeneral)).toBe(true);
    expect((await liveFileAccess(f.artifactDeps, inGeneral, f.org.id, sheet.id))?.mode).toBe("edit");

    await share(bia.id, { mode: "conversation" });
    expect(await listed(inGeneral, caio.id)).toBe(false);
    expect(await liveFileAccess(f.artifactDeps, inGeneral, f.org.id, sheet.id)).toBeNull();
    await expect(getArtifact(f.artifactDeps, inGeneral, f.org.id, sheet.id)).rejects.toBeInstanceOf(NotFoundError);

    // A run for its maker (her DM with the agent) reads it by id, and doesn't change it there.
    const dm = await openDm(f.db, bia.id, f.org.id, { agentId: f.agent.id });
    const asked = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, dm.id, {
      body: "olha o orçamento",
    });
    // Her message in the DM started the agent's run.
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, asked.id));
    expect(run).toBeTruthy();
    const forBia: ArtifactActor = { type: "agent", agentId: f.agent.id, channelId: dm.id, runId: run?.id };
    expect((await liveFileAccess(f.artifactDeps, forBia, f.org.id, sheet.id))?.mode).toBe("view");
    const change = await requireLiveFile(f.artifactDeps, forBia, f.org.id, sheet.id, { write: true }).catch(
      (e: unknown) => e,
    );
    expect(change).toBeInstanceOf(ForbiddenError);
    expect((change as Error).message).toContain("not shared with the whole workspace");

    // In the file's own conversation, where a person who reads it called it: it works on the file.
    const at = await openFileConversation(f.artifactDeps, bia.id, f.org.id, sheet.id);
    const inItsConversation: ArtifactActor = { type: "agent", agentId: f.agent.id, channelId: at.channelId };
    expect((await liveFileAccess(f.artifactDeps, inItsConversation, f.org.id, sheet.id))?.mode).toBe("edit");
  });

  test("an agent's own Drive file stays in its reach when kept to its maker; another agent's doesn't", async () => {
    f = await setup();
    const inGeneral: ArtifactActor = { type: "agent", agentId: f.agent.id, channelId: f.general.id };
    const notes = await createArtifact(f.artifactDeps, inGeneral, f.org.id, {
      title: "Notas",
      content: { kind: "document", markdown: "# Notas" },
    });
    // In the Drive itself, kept to its maker by an administrator.
    await f.db
      .update(schema.artifacts)
      .set({ channelId: null, share: "conversation" })
      .where(eq(schema.artifacts.id, notes.id));
    expect((await listArtifacts(f.db, inGeneral, f.org.id)).map((a) => a.id)).toContain(notes.id);
    const qa = await createAgent(f.db, f.owner.id, f.org.id, { name: "QA", handle: "qa" }, NEW_AGENT_DEFAULTS);
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: qa.id });
    const qaInGeneral: ArtifactActor = { type: "agent", agentId: qa.id, channelId: f.general.id };
    expect((await listArtifacts(f.db, qaInGeneral, f.org.id)).map((a) => a.id)).not.toContain(notes.id);
    await expect(getArtifact(f.artifactDeps, qaInGeneral, f.org.id, notes.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a copy reaches nobody more: Duplicate keeps a Drive file's sharing", async () => {
    const { bia, caio, sheet, reads, share } = await world();
    await share(bia.id, { mode: "conversation" });
    const copy = await duplicateLiveFile(f.artifactDeps, personActor(bia.id), f.org.id, sheet.id);
    expect(copy.channelId).toBeNull();
    expect(copy.sharing).toEqual({ mode: "conversation", userIds: [], roleIds: [] });
    expect(await reads(caio.id, copy.id)).toBe(false);
    expect(await reads(bia.id, copy.id)).toBe(true);
  });

  test("fileReach tells an agent who sees a Drive file", async () => {
    const { bia, caio, sheet, share } = await world();
    expect(await fileReach(f.db, f.org.id, sheet.id)).toBe(
      "It is in the workspace's shared Drive: everyone in the workspace sees it.",
    );
    await share(bia.id, { mode: "conversation" });
    expect(await fileReach(f.db, f.org.id, sheet.id)).toBe(
      "It is in the Drive, not shared with the whole workspace: only bia and administrators see it.",
    );
    await share(bia.id, { mode: "people", userIds: [caio.id] });
    expect(await fileReach(f.db, f.org.id, sheet.id)).toBe(
      "It is in the Drive, not shared with the whole workspace: only bia, caio and administrators see it.",
    );
  });
});

test("migration 0301: every Drive file so far is shared with everyone, a conversation's file stays its own", async () => {
  f = await setup();
  const drive = await createArtifact(f.artifactDeps, personActor(f.owner.id), f.org.id, {
    title: "Manual",
    content: { kind: "document", markdown: "# Manual" },
  });
  const here = await createArtifact(f.artifactDeps, personActor(f.owner.id), f.org.id, {
    title: "Ata",
    channelId: f.general.id,
    content: { kind: "document", markdown: "# Ata" },
  });
  // As every Drive file was stored before it: the column's default.
  await f.db.update(schema.artifacts).set({ share: "conversation" }).where(eq(schema.artifacts.id, drive.id));
  const text = await Bun.file(new URL("../../db/migrations/0301_drive_files_shared.sql", import.meta.url)).text();
  await f.db.execute(sql.raw(text));
  const rows = await f.db.select({ id: schema.artifacts.id, share: schema.artifacts.share }).from(schema.artifacts);
  expect(rows.find((r) => r.id === drive.id)?.share).toBe("everyone");
  expect(rows.find((r) => r.id === here.id)?.share).toBe("conversation");
});
