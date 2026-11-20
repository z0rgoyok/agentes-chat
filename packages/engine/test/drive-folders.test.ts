import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  createArtifact,
  createChannel,
  createFolder,
  deleteFolder,
  drainOutbox,
  ForbiddenError,
  getArtifact,
  grantScopes,
  listArtifacts,
  listFolders,
  moveArtifacts,
  NotFoundError,
  postPersonMessage,
  renameArtifact,
  restoreArtifact,
  type ToolContext,
  updateFolder,
  ValidationError,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const DRIVE = ["drive:read", "drive:write"].map((scope) => ({ connectionId: null, scope }));
const me = () => ({ type: "person" as const, userId: f.owner.id });
const doc = (title: string, channelId: string | null = null, folderId: string | null = null) =>
  createArtifact(f.artifactDeps, me(), f.org.id, {
    title,
    channelId,
    folderId,
    content: { kind: "document", markdown: `# ${title}` },
  });
const titles = (list: { title: string }[]) => list.map((a) => a.title).sort();

describe("Drive folders", () => {
  test("a file goes in a folder, the top level lists only what's outside, and search looks everywhere", async () => {
    f = await setup();
    const reports = await createFolder(f.artifactDeps, me(), f.org.id, { name: "Reports" });
    const inside = await doc("March", null, reports.id);
    await doc("Loose");
    expect(inside.folderId).toBe(reports.id);
    const list = (folderId?: string | null, q?: string) =>
      listArtifacts(f.db, me(), f.org.id, { ...(folderId !== undefined ? { folderId } : {}), q });
    expect(titles(await list(null))).toEqual(["Loose"]);
    expect(titles(await list(reports.id))).toEqual(["March"]);
    expect(titles(await list(undefined, "March"))).toEqual(["March"]);
  });

  test("rename, nest, move files back and forth; a folder never goes inside itself", async () => {
    f = await setup();
    const a = await createFolder(f.artifactDeps, me(), f.org.id, { name: "A / B  " });
    expect(a.name).toBe("A - B");
    const b = await createFolder(f.artifactDeps, me(), f.org.id, { name: "Inner", parentId: a.id });
    await expect(updateFolder(f.artifactDeps, f.owner.id, f.org.id, a.id, { parentId: b.id })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(updateFolder(f.artifactDeps, f.owner.id, f.org.id, a.id, { parentId: a.id })).rejects.toBeInstanceOf(
      ValidationError,
    );
    const renamed = await updateFolder(f.artifactDeps, f.owner.id, f.org.id, b.id, { name: "Deep", parentId: null });
    expect(renamed).toMatchObject({ name: "Deep", parentId: null });

    const file = await doc("Plan");
    expect(await moveArtifacts(f.artifactDeps, me(), f.org.id, [file.id], b.id)).toBe(1);
    expect((await getArtifact(f.artifactDeps, me(), f.org.id, file.id)).folderId).toBe(b.id);
    expect(await moveArtifacts(f.artifactDeps, me(), f.org.id, [file.id], b.id)).toBe(0);
    await moveArtifacts(f.artifactDeps, me(), f.org.id, [file.id], null);
    expect((await getArtifact(f.artifactDeps, me(), f.org.id, file.id)).folderId).toBeNull();

    const titled = await renameArtifact(f.artifactDeps, me(), f.org.id, file.id, "  Plan v2 ");
    expect(titled).toMatchObject({ title: "Plan v2", version: 1 });
  });

  test("deleting a folder trashes what I may delete, moves up the rest, and restored files come back at the top", async () => {
    f = await setup();
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    const bobActor = { type: "person" as const, userId: bob.id };
    const outer = await createFolder(f.artifactDeps, bobActor, f.org.id, { name: "Outer" });
    const folder = await createFolder(f.artifactDeps, bobActor, f.org.id, { name: "Team", parentId: outer.id });
    const sub = await createFolder(f.artifactDeps, bobActor, f.org.id, { name: "Sub", parentId: folder.id });
    const mine = await createArtifact(f.artifactDeps, bobActor, f.org.id, {
      title: "Bob's",
      folderId: sub.id,
      content: { kind: "document", markdown: "x" },
    });
    // The owner's file, in a private channel Bob doesn't read: Bob neither sees it nor may delete it.
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    const theirs = await doc("Owner's", secret.id, sub.id);

    expect(await deleteFolder(f.artifactDeps, bob.id, f.org.id, folder.id)).toEqual({ trashed: 1, kept: 1 });
    expect((await listFolders(f.db, me(), f.org.id)).map((x) => x.name)).toEqual(["Outer"]);
    expect((await getArtifact(f.artifactDeps, me(), f.org.id, theirs.id)).folderId).toBe(outer.id);
    await expect(getArtifact(f.artifactDeps, bobActor, f.org.id, mine.id)).rejects.toBeInstanceOf(NotFoundError);
    await restoreArtifact(f.artifactDeps, bob.id, f.org.id, mine.id);
    expect((await getArtifact(f.artifactDeps, bobActor, f.org.id, mine.id)).folderId).toBeNull();
  });

  test("a folder never shows a file to anyone more", async () => {
    f = await setup();
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    const shared = await createFolder(f.artifactDeps, me(), f.org.id, { name: "Shared" });
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    await doc("Private plan", secret.id, shared.id);
    await doc("Open plan", null, shared.id);
    const bobActor = { type: "person" as const, userId: bob.id };
    expect((await listFolders(f.db, bobActor, f.org.id)).map((x) => x.name)).toEqual(["Shared"]);
    expect(titles(await listArtifacts(f.db, bobActor, f.org.id, { folderId: shared.id }))).toEqual(["Open plan"]);
  });

  test("someone outside the workspace can't arrange its Drive", async () => {
    f = await setup();
    const stranger = await addUser(f.db, "stranger");
    const file = await doc("Plan");
    const actor = { type: "person" as const, userId: stranger.id };
    await expect(createFolder(f.artifactDeps, actor, f.org.id, { name: "X" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(moveArtifacts(f.artifactDeps, actor, f.org.id, [file.id], null)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe("agents' folders", () => {
  test("create_artifact with a folder path makes the folders and files it there; list_artifacts filters by it", async () => {
    f = await setup({ artifactTools: true });
    await grantScopes(f.db, f.org.id, f.agent.id, DRIVE);
    const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev oi",
    });
    await drainOutbox(f.db, f.handlers);
    const [run] = await f.db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.agentId, f.agent.id), eq(schema.agentRuns.triggerMessageId, trigger.id)));
    if (!run) throw new Error("no run");
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: run.agentId,
      runId: run.id,
      channelId: run.channelId,
      threadRootId: run.threadRootId,
      triggerMessageId: run.triggerMessageId,
      background: run.background,
    };
    const call = async (name: string, input: Record<string, unknown>) => {
      const outcome = await f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input });
      if (outcome?.type !== "result") throw new Error(`expected a result, got ${outcome?.type}`);
      return outcome.output;
    };

    const saved = await call("create_artifact", {
      title: "Q1",
      kind: "document",
      markdown: "# Q1",
      folder: "Reports/2026",
    });
    expect(saved.content).toContain('It is in the Drive folder "Reports/2026".');
    const again = await call("create_artifact", {
      title: "Q2",
      kind: "document",
      markdown: "# Q2",
      folder: "reports/2026",
    });
    expect(again.content).toContain('"Reports/2026"');
    const folders = await listFolders(f.db, me(), f.org.id);
    expect(folders.map((x) => x.name).sort()).toEqual(["2026", "Reports"]);
    const year = folders.find((x) => x.name === "2026");
    expect(titles(await listArtifacts(f.db, me(), f.org.id, { folderId: year?.id ?? "" }))).toEqual(["Q1", "Q2"]);

    const listed = await call("list_artifacts", { folder: "Reports/2026" });
    expect(listed.content).toContain('in folder "Reports/2026"');
    expect((await call("list_artifacts", { folder: "Nowhere" })).content).toBe('No Drive folder "Nowhere".');
    expect((await listFolders(f.db, me(), f.org.id)).length).toBe(2);

    // update_artifact with only a folder moves the file.
    const id = /artifact ([0-9a-f-]{36})/.exec(String(saved.content))?.[1] ?? "";
    const moved = await call("update_artifact", { artifact_id: id, note: "file it", folder: "Archive" });
    expect(moved.content).toContain('"Archive"');
  });

  test("an agent may not move a file of a conversation it isn't in", async () => {
    f = await setup({ artifactTools: true });
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    const file = await doc("Hidden", secret.id);
    const actor = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
    await expect(moveArtifacts(f.artifactDeps, actor, f.org.id, [file.id], null)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getArtifact(f.artifactDeps, me(), f.org.id, file.id)).folderId).toBeNull();
  });
});
