import { afterEach, describe, expect, test } from "bun:test";
import { channelTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { fakeImagePng } from "@agenteschat/providers/testing";
import {
  addChannelMember,
  audienceOfConversation,
  COMMENT_ON_FILE,
  cleanSelection,
  createAgent,
  createArtifact,
  createChannel,
  createCommentToolSource,
  createFakeJudge,
  createFileArtifact,
  createLiveFile,
  drainOutbox,
  ensureFileConversation,
  FILE_CONVERSATION_DEPTH,
  ForbiddenError,
  fileConversationOf,
  fileConversationSummaries,
  isMediaConversation,
  isPinned,
  type LiveAskSelection,
  LOOK_AT_COMMENT,
  listMembers,
  liveFileAccess,
  liveRefOf,
  MARK_PICTURE_BYTES,
  markThreadRead,
  markWords,
  NEW_AGENT_DEFAULTS,
  NotFoundError,
  openFileConversation,
  postPersonMessage,
  putMarkPicture,
  RESOLVE_COMMENT,
  requireChannelAccess,
  resolveComment,
  resolvedOf,
  setFileSharing,
  type ToolContext,
  type ToolOutput,
  type ToolSource,
  unreadFileConversations,
  ValidationError,
  withPersonFacts,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { makeLiveFile, personActor } from "./live-fixtures";

/**
 * A live file's conversation (ADR 0199): a `file` channel of its own with one hidden root, read by whoever reads the
 * file, where a mention admits and wakes an agent that may work on the file, and a message may point at what its
 * writer had selected (`meta.liveRef`). Pictures, videos and PDFs have one too (ADR 0208), where a comment points at a
 * place in the file (a pin), is resolved, and is seen, made and resolved by the agent with its own tools.
 */

let f: Fixture;
afterEach(async () => {
  // Each database is closed once: a test without one leaves the last one alone.
  const open = f as Fixture | undefined;
  f = undefined as unknown as Fixture;
  await open?.close();
});

const repliesIn = async (channelId: string) =>
  (await f.db.select().from(schema.messages).where(eq(schema.messages.channelId, channelId)))
    .filter((m) => m.threadId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
const runsIn = (channelId: string) =>
  f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.channelId, channelId));
const membersOf = (channelId: string) =>
  f.db.select().from(schema.channelMembers).where(eq(schema.channelMembers.channelId, channelId));
const metaOf = async (messageId: string) =>
  (await f.db.select().from(schema.messages).where(eq(schema.messages.id, messageId)))[0]?.meta ?? null;
const typesOf = (events: unknown[], type: string) => events.filter((e) => (e as { type?: string }).type === type);

/** Uploaded files (ADR 0208), told by their type (the name's extension gives it). */
const PNG = fakeImagePng("logo");
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const PDF = new TextEncoder().encode("%PDF-1.7 not really");
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** A file the workspace owner drops in a conversation (#general unless said). */
const upload = (name: string, bytes: Uint8Array, input: { title?: string; channelId?: string } = {}) =>
  createFileArtifact(f.artifactDeps, personActor(f.owner.id), f.org.id, {
    title: input.title ?? name,
    name,
    bytes,
    channelId: input.channelId ?? f.general.id,
  });

describe("a live file's conversation (ADR 0199)", () => {
  test("made once on first use with the maker agent in it; a mention wakes the agent with the file in focus", async () => {
    f = await setup({ reply: () => ({ chunks: ["Fiz duas variações ao lado."] }) });
    const deps = { db: f.db, pubsub: f.pubsub };
    const byDev = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id, threadId: null };
    const canvas = await createLiveFile(f.artifactDeps, byDev, f.org.id, { kind: "canvas", title: "Campanha" });
    const at = await openFileConversation(f.artifactDeps, f.owner.id, f.org.id, canvas.id);
    expect(await openFileConversation(f.artifactDeps, f.owner.id, f.org.id, canvas.id)).toEqual(at);
    expect(await ensureFileConversation(f.db, canvas.id)).toEqual(at);

    const [channel] = await f.db.select().from(schema.channels).where(eq(schema.channels.id, at.channelId));
    expect(channel).toMatchObject({ kind: "file", visibility: "private" });
    const [root] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, at.rootId));
    expect(fileConversationOf(root?.meta)).toEqual({ artifactId: canvas.id, kind: "canvas", title: "Campanha" });
    expect(root).toMatchObject({ authorType: "agent", authorAgentId: f.agent.id, threadId: null });
    // The agent that made it is there from the start; no person ever is.
    expect((await membersOf(at.channelId)).map((m) => [m.agentId, m.userId])).toEqual([[f.agent.id, null]]);

    // The chat's own send, in the thread, pointing at what was selected on the canvas.
    const asked = await postPersonMessage(deps, f.owner.id, f.org.id, at.channelId, {
      body: "@dev faz variações desta",
      threadId: at.rootId,
      liveRef: {
        artifactId: canvas.id,
        selection: { label: "1 imagem", shapes: ["img_1"], point: { x: 1.26, y: -4 } },
      },
    });
    const ref = {
      artifactId: canvas.id,
      kind: "canvas",
      title: "Campanha",
      selection: { label: "1 imagem", shapes: ["img_1"], point: { x: 1.3, y: -4 } },
    };
    expect(asked.meta.liveRef).toEqual(ref);
    expect(asked.liveRef).toEqual(ref);
    expect(asked.mentionedAgentIds).toEqual([f.agent.id]);
    const [run] = await runsIn(at.channelId);
    expect(run).toMatchObject({ agentId: f.agent.id, threadRootId: at.rootId });

    await drainOutbox(f.db, f.handlers);
    expect((await repliesIn(at.channelId)).map((m) => [m.authorType, m.body])).toEqual([
      ["person", "@dev faz variações desta"],
      ["agent", "Fiz duas variações ao lado."],
    ]);
    // The run knew the file in focus, that it made it, and what the message pointed at.
    const request = JSON.stringify(f.provider.calls.at(-1)?.request);
    expect(request).toContain('This conversation: the canvas \\"Campanha\\"');
    expect(request).toContain("which you made");
    expect(request).toContain(`about what they selected in the canvas \\"Campanha\\" (artifact ${canvas.id})`);
    expect(request).toContain("a comment pinned at x 1.3, y -4");

    // Its run reaches the file to change it, as everyone in it watches.
    const actor = { type: "agent" as const, agentId: f.agent.id, channelId: at.channelId, threadId: at.rootId };
    expect((await liveFileAccess(f.artifactDeps, actor, f.org.id, canvas.id))?.mode).toBe("edit");

    // What the file's page reads first: its conversation's count, who took part, nobody at work now.
    const summary = (await fileConversationSummaries(f.db, f.org.id, [canvas.id])).get(canvas.id);
    expect(summary).toMatchObject({ channelId: at.channelId, rootId: at.rootId, count: 2, working: false });
    expect(summary?.participants).toEqual([
      { type: "person", id: f.owner.id },
      { type: "agent", id: f.agent.id },
    ]);
    const [withFacts] = await withPersonFacts(f.db, f.owner.id, f.org.id, [
      {
        id: canvas.id,
        channelId: canvas.channelId,
        createdBy: canvas.createdBy,
        inDrive: true,
        access: canvas.access,
        canEdit: canvas.canEdit,
      },
    ]);
    expect(withFacts?.conversation).toMatchObject({ count: 2, channelId: at.channelId });
  });

  test("read by whoever reads the file: a private channel's file stays its members'; sharing opens it", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secreto", visibility: "private" });
    const sheet = await makeLiveFile(f, "spreadsheet", { title: "Salários", channelId: secret.id });
    const at = await openFileConversation(f.artifactDeps, f.owner.id, f.org.id, sheet.id);

    // Bia doesn't read the file: no conversation, by any way in.
    await expect(openFileConversation(f.artifactDeps, bia.id, f.org.id, sheet.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(requireChannelAccess(f.db, bia.id, f.org.id, at.channelId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      postPersonMessage(deps, bia.id, f.org.id, at.channelId, { body: "oi", threadId: at.rootId }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Who the conversation is for: the people where the file lives.
    expect(await audienceOfConversation(f.db, at.channelId)).toEqual({ mode: "people", userIds: [f.owner.id] });

    // Shared with the whole workspace: she reads it and writes there, never as a member of it.
    await setFileSharing(f.artifactDeps, f.owner.id, f.org.id, sheet.id, { mode: "everyone" });
    expect((await requireChannelAccess(f.db, bia.id, f.org.id, at.channelId)).channel.id).toBe(at.channelId);
    expect(await openFileConversation(f.artifactDeps, bia.id, f.org.id, sheet.id)).toEqual(at);
    await postPersonMessage(deps, bia.id, f.org.id, at.channelId, { body: "Vi aqui", threadId: at.rootId });
    expect((await membersOf(at.channelId)).filter((m) => m.userId)).toEqual([]);
    expect(await audienceOfConversation(f.db, at.channelId)).toEqual({ mode: "everyone" });

    // In the trash, nobody reads it until it comes back.
    await f.db.update(schema.artifacts).set({ deletedAt: new Date() }).where(eq(schema.artifacts.id, sheet.id));
    await expect(requireChannelAccess(f.db, bia.id, f.org.id, at.channelId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(openFileConversation(f.artifactDeps, f.owner.id, f.org.id, sheet.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  test("a live file, a picture, a video or a PDF has one; a table or any other file has none", async () => {
    f = await setup();
    const table = await createArtifact(f.artifactDeps, personActor(f.owner.id), f.org.id, {
      title: "Metas",
      content: { kind: "table", columns: ["mês", "meta"], rows: [["jan", "10"]] },
    });
    const notes = await upload("notas.txt", new TextEncoder().encode("lista de compras"));
    for (const id of [table.id, notes.id]) {
      const refused = await openFileConversation(f.artifactDeps, f.owner.id, f.org.id, id).catch((e) => e);
      expect(refused).toBeInstanceOf(ValidationError);
      expect(refused.code).toBe("artifact.no_conversation");
    }
    expect((await ensureFileConversation(f.db, notes.id).catch((e) => e)).code).toBe("artifact.no_conversation");

    // A picture, a video and a PDF (ADR 0208), told by their type: the root says which.
    for (const [name, bytes, kind] of [
      ["logo.png", PNG, "image"],
      ["demo.mp4", MP4, "video"],
      ["contrato.pdf", PDF, "pdf"],
    ] as const) {
      const file = await upload(name, bytes);
      const at = await openFileConversation(f.artifactDeps, f.owner.id, f.org.id, file.id);
      expect(await openFileConversation(f.artifactDeps, f.owner.id, f.org.id, file.id)).toEqual(at);
      const [root] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, at.rootId));
      expect(fileConversationOf(root?.meta)).toEqual({ artifactId: file.id, kind, title: name });
      expect(root).toMatchObject({ authorType: "person", authorUserId: f.owner.id, threadId: null });
      // A person uploaded it: no agent is there until one is named.
      expect(await membersOf(at.channelId)).toEqual([]);
      expect(await isMediaConversation(f.db, f.org.id, at.channelId)).toBe(true);
    }

    // In the trash, or no such file: not found.
    const old = await upload("antigo.png", fakeImagePng("old"));
    await f.db.update(schema.artifacts).set({ deletedAt: new Date() }).where(eq(schema.artifacts.id, old.id));
    for (const id of [old.id, crypto.randomUUID()]) {
      await expect(openFileConversation(f.artifactDeps, f.owner.id, f.org.id, id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    }
  });

  test("a mention admits only an agent that may work on the file; the file's people read what it says", async () => {
    f = await setup({ reply: () => ({ chunks: ["Conferi."] }) });
    const deps = { db: f.db, pubsub: f.pubsub };
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secreto", visibility: "private" });
    const deck = await makeLiveFile(f, "slides", { title: "Pitch", channelId: secret.id });
    const at = await openFileConversation(f.artifactDeps, f.owner.id, f.org.id, deck.id);
    const qa = await createAgent(f.db, f.owner.id, f.org.id, { name: "QA", handle: "qa" }, NEW_AGENT_DEFAULTS);

    // Neither @dev (in #general only) nor @qa is in #secreto: the mention reaches nobody.
    await postPersonMessage(deps, f.owner.id, f.org.id, at.channelId, { body: "@qa @dev olhem", threadId: at.rootId });
    expect(await runsIn(at.channelId)).toEqual([]);
    expect(await membersOf(at.channelId)).toEqual([]);

    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: qa.id });
    await postPersonMessage(deps, f.owner.id, f.org.id, at.channelId, { body: "@qa e agora?", threadId: at.rootId });
    expect((await runsIn(at.channelId)).map((r) => r.agentId)).toEqual([qa.id]);
    expect((await membersOf(at.channelId)).map((m) => m.agentId)).toEqual([qa.id]);
  });

  test("a message points only at its own conversation's file", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const sheet = await makeLiveFile(f, "spreadsheet", { title: "Custos", channelId: f.general.id });
    const other = await makeLiveFile(f, "spreadsheet", { title: "Receitas", channelId: f.general.id });
    const at = await openFileConversation(f.artifactDeps, f.owner.id, f.org.id, sheet.id);
    const send = (channelId: string, artifactId: string, threadId: string | null = null) =>
      postPersonMessage(deps, f.owner.id, f.org.id, channelId, {
        body: "Revisa",
        threadId,
        liveRef: { artifactId, selection: { label: "C2:D6 em Custos", sheet: "s1", range: "C2:D6" } },
      }).catch((e) => e);
    for (const refused of [await send(at.channelId, other.id, at.rootId), await send(f.general.id, sheet.id)]) {
      expect(refused).toBeInstanceOf(ValidationError);
      expect(refused.code).toBe("message.live_ref");
    }
    const sent = await send(at.channelId, sheet.id, at.rootId);
    expect(sent.liveRef).toEqual({
      artifactId: sheet.id,
      kind: "spreadsheet",
      title: "Custos",
      selection: { label: "C2:D6 em Custos", sheet: "s1", range: "C2:D6" },
    });
  });

  test("a mention there is unread for whoever reads the file until they read it, and notifies them there", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    await listMembers(f.db, f.org.id); // assigns their handles
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secreto", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { userId: bia.id });
    const doc = await makeLiveFile(f, "canvas", { title: "Moodboard", channelId: secret.id });
    const at = await openFileConversation(f.artifactDeps, f.owner.id, f.org.id, doc.id);

    // Nobody in a file's channel is a member: who reads the file and is named is mentioned all the same.
    const asked = await postPersonMessage(deps, f.owner.id, f.org.id, at.channelId, {
      body: "@bia e @caio, conferem?",
      threadId: at.rootId,
    });
    expect(asked.mentionedUserIds).toEqual([bia.id]); // caio isn't in #secreto
    expect(await unreadFileConversations(f.db, bia.id, f.org.id)).toEqual([
      { artifactId: doc.id, unread: 1, mentions: 1 },
    ]);
    expect(await unreadFileConversations(f.db, caio.id, f.org.id)).toEqual([]);
    // My own message is never unread for me; the file's maker follows its conversation (its root is theirs).
    expect(await unreadFileConversations(f.db, f.owner.id, f.org.id)).toEqual([]);
    await drainOutbox(f.db, f.handlers);
    const [mention] = await f.db.select().from(schema.notifications).where(eq(schema.notifications.userId, bia.id));
    expect(mention).toMatchObject({ kind: "mention" });
    expect(mention?.source).toMatchObject({
      artifactId: doc.id,
      channelId: at.channelId,
      threadId: at.rootId,
      messageId: asked.id,
      label: "Moodboard",
    });
    expect(await f.db.select().from(schema.notifications).where(eq(schema.notifications.userId, caio.id))).toEqual([]);

    // A plain reply after: Bia doesn't follow the conversation, so only the mention counts; the maker hears it.
    const reply = await postPersonMessage(deps, bia.id, f.org.id, at.channelId, {
      body: "Confiro hoje",
      threadId: at.rootId,
    });
    expect(await unreadFileConversations(f.db, f.owner.id, f.org.id)).toEqual([
      { artifactId: doc.id, unread: 1, mentions: 0 },
    ]);
    await drainOutbox(f.db, f.handlers);
    const [told] = await f.db.select().from(schema.notifications).where(eq(schema.notifications.userId, f.owner.id));
    expect(told).toMatchObject({ kind: "thread_reply" });
    expect(told?.source).toMatchObject({ artifactId: doc.id, messageId: reply.id });

    // Read there, it's gone.
    await markThreadRead(deps, bia.id, f.org.id, at.rootId);
    expect(await unreadFileConversations(f.db, bia.id, f.org.id)).toEqual([]);
  });
});

test("the selection keeps only what the apps describe: points, quotes and blocks too", () => {
  expect(
    cleanSelection({
      label: "Sobre o trecho selecionado",
      point: { x: Number.NaN, y: 2 },
      text: `  ${"palavra ".repeat(60)}`,
      block: "b_12",
    }),
  ).toEqual({ label: "Sobre o trecho selecionado", text: "palavra ".repeat(25).trim(), block: "b_12" });
  expect(cleanSelection({ label: "Pin", point: { x: 10.04, y: 1e9 }, block: "not a block" })).toEqual({ label: "Pin" });
  expect(cleanSelection({ label: "Pin", point: { x: 10.04, y: -3.55 } })).toEqual({
    label: "Pin",
    point: { x: 10, y: -3.5 },
  });
  expect(FILE_CONVERSATION_DEPTH).toBeGreaterThan(0);
});

test("a mark keeps to the file: a point or an area inside it, a moment, a page, a version and two pictures", () => {
  const crop = crypto.randomUUID();
  expect(
    cleanSelection({
      label: "3",
      mark: { x: 0.123456, y: 0.5, w: 0.9, h: 0.25 },
      time: 12.345,
      page: 2,
      version: 4,
      crop: crop.toUpperCase(),
      frame: "not an id",
    }),
  ).toEqual({ label: "3", mark: { x: 0.1235, y: 0.5, w: 0.8765, h: 0.25 }, time: 12.3, page: 2, version: 4, crop });
  // A side of zero, or one missing, makes a point; a place off the file is no mark.
  expect(cleanSelection({ label: "1", mark: { x: 0.3, y: 0.4, w: 0, h: 0.2 } })?.mark).toEqual({ x: 0.3, y: 0.4 });
  expect(cleanSelection({ label: "1", mark: { x: 0.3, y: 0.4, w: 0.2 } })?.mark).toEqual({ x: 0.3, y: 0.4 });
  expect(cleanSelection({ label: "1", mark: { x: 1.2, y: 0.4 }, time: -1, page: 0, version: 0 })).toEqual({
    label: "1",
  });
  expect(
    cleanSelection({ label: "1", mark: { x: Number.NaN, y: 0 }, time: 86_401, page: 2.5, version: 1.5, crop: "x" }),
  ).toEqual({ label: "1" });
  expect(cleanSelection({ label: "1", time: 0 })).toEqual({ label: "1", time: 0 });

  // A pin is a place: a mark, a moment or a page; the pictures alone are none.
  expect(isPinned({ label: "1", time: 0 })).toBe(true);
  expect(isPinned({ label: "1", page: 3 })).toBe(true);
  expect(isPinned({ label: "1", mark: { x: 0, y: 0 } })).toBe(true);
  expect(isPinned({ label: "1", crop, frame: crop })).toBe(false);
  expect(isPinned(undefined)).toBe(false);

  // As the agent reads it.
  expect(markWords("image", { label: "1", mark: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, version: 2 })).toBe(
    "an area of the picture from 10% to 40% across and 20% to 60% down, on version 2",
  );
  expect(markWords("video", { label: "2", time: 3725, mark: { x: 0.5, y: 0.25 } })).toBe(
    "the moment 1:02:05, a point of the frame at 50% across and 25% down",
  );
  expect(markWords("pdf", { label: "3", page: 7, mark: { x: 0, y: 0.5, w: 1, h: 0.5 } })).toBe(
    "page 7, an area of the page from 0% to 100% across and 50% to 100% down",
  );
});

describe("comments on a picture, a video or a PDF (ADR 0208)", () => {
  test("a comment pinned on a picture tells the agent where it points and how to see it", async () => {
    f = await setup({ reply: () => ({ chunks: ["Está cortado, sim."] }) });
    const deps = { db: f.db, pubsub: f.pubsub };
    const logo = await upload("logo.png", PNG, { title: "Logo" });
    const at = await openFileConversation(f.artifactDeps, f.owner.id, f.org.id, logo.id);
    const crop = crypto.randomUUID();

    const asked = await postPersonMessage(deps, f.owner.id, f.org.id, at.channelId, {
      body: "@dev esse canto está cortado?",
      threadId: at.rootId,
      liveRef: {
        artifactId: logo.id,
        selection: { label: "1", mark: { x: 0.25, y: 0.5 }, version: 1, crop: crop.toUpperCase() },
      },
    });
    expect(asked.liveRef).toEqual({
      artifactId: logo.id,
      kind: "image",
      title: "Logo",
      selection: { label: "1", mark: { x: 0.25, y: 0.5 }, version: 1, crop },
    });
    // @dev is in #general, where the picture lives: named, it joins the conversation.
    expect(asked.mentionedAgentIds).toEqual([f.agent.id]);
    expect((await membersOf(at.channelId)).map((m) => m.agentId)).toEqual([f.agent.id]);

    await drainOutbox(f.db, f.handlers);
    expect((await repliesIn(at.channelId)).map((m) => [m.authorType, m.body])).toEqual([
      ["person", "@dev esse canto está cortado?"],
      ["agent", "Está cortado, sim."],
    ]);
    const request = JSON.stringify(f.provider.calls.at(-1)?.request);
    expect(request).toContain('This conversation: the image \\"Logo\\"');
    expect(request).toContain("comment_on_file");
    expect(request).toContain(
      `about what they selected in the image \\"Logo\\" (artifact ${logo.id}): a point of the picture at 25% across and 50% down, on version 1)`,
    );
    expect(request).toContain(`call look_at_comment with comment \\"${crop}\\"`);
  });

  test("a comment tells the conversation the file was posted in, so its card there counts it", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const logo = await upload("logo.png", PNG, { title: "Logo" });
    const at = await openFileConversation(f.artifactDeps, f.owner.id, f.org.id, logo.id);
    const heard: unknown[] = [];
    f.pubsub.subscribe(channelTopic(f.general.id), (event) => {
      heard.push(event);
    });

    await postPersonMessage(deps, f.owner.id, f.org.id, at.channelId, { body: "Looks good.", threadId: at.rootId });
    await drainOutbox(f.db, f.handlers);

    const updates = typesOf(heard, "artifact.updated") as { artifact: { id: string } }[];
    expect(updates.map((e) => e.artifact.id)).toEqual([logo.id]);
    // A message anywhere else announces no file.
    heard.length = 0;
    await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "Good morning." });
    await drainOutbox(f.db, f.handlers);
    expect(typesOf(heard, "artifact.updated")).toEqual([]);
  });

  test("a comment with a pin is resolved by who writes there, once, and opened again; nothing else is", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secreto", visibility: "private" });
    const logo = await upload("logo.png", PNG, { channelId: secret.id });
    const at = await openFileConversation(f.artifactDeps, f.owner.id, f.org.id, logo.id);
    const events = f.listen(at.channelId);
    const say = (body: string, selection?: LiveAskSelection) =>
      postPersonMessage(deps, f.owner.id, f.org.id, at.channelId, {
        body,
        threadId: at.rootId,
        ...(selection ? { liveRef: { artifactId: logo.id, selection } } : {}),
      });
    const pinned = await say("O canto está cortado", { label: "1", mark: { x: 0.9, y: 0.1 }, version: 1 });
    const plain = await say("Valeu");
    const whole = await say("No geral está bom", { label: "Logo" });
    const owner = { type: "person", userId: f.owner.id } as const;

    const first = await resolveComment(deps, owner, f.org.id, pinned.id, true);
    expect(first).toEqual({ by: { type: "person", id: f.owner.id }, at: expect.any(String) });
    expect(resolvedOf(await metaOf(pinned.id))).toEqual(first);
    // Again: the first stays, who and when.
    expect(await resolveComment(deps, owner, f.org.id, pinned.id, true)).toEqual(first);
    // Opened again: gone from the message, which stays as it was.
    expect(await resolveComment(deps, owner, f.org.id, pinned.id, false)).toBeNull();
    const reopened = await metaOf(pinned.id);
    expect(reopened?.resolved).toBeUndefined();
    expect(liveRefOf(reopened)?.selection).toEqual({ label: "1", mark: { x: 0.9, y: 0.1 }, version: 1 });
    expect(await resolveComment(deps, owner, f.org.id, pinned.id, false)).toBeNull();
    // Only a change reaches the apps.
    const told = { type: "message.resolved", channelId: at.channelId, messageId: pinned.id, threadId: at.rootId };
    expect(typesOf(events, "message.resolved")).toEqual([
      { ...told, resolved: first },
      { ...told, resolved: null },
    ]);

    // A message with no pin, the root, one pointing at the whole file, one outside a file's conversation: no comment.
    const elsewhere = await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "oi" });
    for (const id of [plain.id, whole.id, at.rootId, elsewhere.id]) {
      const refused = await resolveComment(deps, owner, f.org.id, id, true).catch((e) => e);
      expect(refused).toBeInstanceOf(ValidationError);
      expect(refused.code).toBe("message.not_comment");
    }
    // Who doesn't write there: a person who doesn't read the file, an agent not in its conversation.
    await expect(openFileConversation(f.artifactDeps, bia.id, f.org.id, logo.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      resolveComment(deps, { type: "person", userId: bia.id }, f.org.id, pinned.id, true),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      resolveComment(deps, { type: "agent", agentId: f.agent.id }, f.org.id, pinned.id, true),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(resolveComment(deps, owner, f.org.id, crypto.randomUUID(), true)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(resolvedOf(await metaOf(pinned.id))).toBeNull();
    expect(typesOf(events, "message.resolved")).toHaveLength(2);
  });
});

describe("an agent's tools on a picture's, a video's or a PDF's comments (ADR 0208)", () => {
  let source: ToolSource | null = null;
  /** Where the judge sees a target on the picture; null: it doesn't (the fake judge's zero box, nothing there). */
  let found: { box: { top: number; bottom: number; left: number; right: number }; confidence: number } | null = null;
  const judge = createFakeJudge((kind, id) =>
    kind === "comment_locate" && found ? (id === "present" ? 1 : found) : undefined,
  );
  const lazy: ToolSource = { name: "file-comments", tools: async (ctx) => (source ? source.tools(ctx) : []) };
  afterEach(() => {
    source = null;
    found = null;
  });

  async function withTools() {
    f = await setup({ toolSources: [lazy] });
    source = createCommentToolSource({ artifacts: f.artifactDeps, pubsub: f.pubsub, judge });
  }

  /** A person's message naming @dev in a file's conversation, and the run it starts there, running. */
  async function mention(
    at: { channelId: string; rootId: string },
    body: string,
    liveRef?: { artifactId: string; selection: LiveAskSelection },
  ) {
    const asked = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, at.channelId, {
      body,
      threadId: at.rootId,
      ...(liveRef ? { liveRef } : {}),
    });
    const [run] = await f.db
      .update(schema.agentRuns)
      .set({ status: "running" })
      .where(eq(schema.agentRuns.triggerMessageId, asked.id))
      .returning();
    if (!run) throw new Error("no run");
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: run.agentId,
      runId: run.id,
      channelId: run.channelId,
      threadRootId: run.threadRootId,
      triggerMessageId: run.triggerMessageId,
    };
    return { asked, ctx };
  }

  async function call(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolOutput> {
    const r = await f.tools?.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
    if (r?.type !== "result") throw new Error(`expected a result, got ${r?.type}`);
    return r.output;
  }

  async function ok(ctx: ToolContext, name: string, input: Record<string, unknown>) {
    const out = await call(ctx, name, input);
    if (out.isError) throw new Error(`${name} failed: ${out.content}`);
    return out;
  }

  /** The message `comment_on_file` posted. */
  const postedOf = (out: ToolOutput) => {
    const sent = out.data?.mediaSent as { messageId: string } | undefined;
    if (!sent) throw new Error("nothing posted");
    return sent.messageId;
  };

  test("listed only in a picture's, a video's or a PDF's own conversation, for a run there", async () => {
    await withTools();
    const logo = await upload("logo.png", PNG);
    const board = await makeLiveFile(f, "canvas", { title: "Quadro", channelId: f.general.id });
    const pictureAt = await openFileConversation(f.artifactDeps, f.owner.id, f.org.id, logo.id);
    const boardAt = await openFileConversation(f.artifactDeps, f.owner.id, f.org.id, board.id);
    const listed = async (channelId: string, runId: string = crypto.randomUUID()) => {
      const ctx: ToolContext = {
        db: f.db,
        orgId: f.org.id,
        agentId: f.agent.id,
        runId,
        channelId,
        threadRootId: crypto.randomUUID(),
        triggerMessageId: crypto.randomUUID(),
      };
      return (await (source as ToolSource).tools(ctx)).map((t) => t.name);
    };
    expect(await listed(pictureAt.channelId)).toEqual([LOOK_AT_COMMENT, COMMENT_ON_FILE, RESOLVE_COMMENT]);
    expect(await listed(pictureAt.channelId, "")).toEqual([]);
    expect(await listed(boardAt.channelId)).toEqual([]);
    expect(await listed(f.general.id)).toEqual([]);
    expect(await isMediaConversation(f.db, f.org.id, boardAt.channelId)).toBe(false);
    expect(await isMediaConversation(f.db, f.org.id, f.general.id)).toBe(false);
    // In the trash: none.
    await f.db.update(schema.artifacts).set({ deletedAt: new Date() }).where(eq(schema.artifacts.id, logo.id));
    expect(await listed(pictureAt.channelId)).toEqual([]);
    expect(await isMediaConversation(f.db, f.org.id, pictureAt.channelId)).toBe(false);
  });

  test("look_at_comment shows the pictures the app took of a comment's place, by its number or a picture's id", async () => {
    await withTools();
    const logo = await upload("logo.png", PNG, { title: "Logo" });
    const at = await openFileConversation(f.artifactDeps, f.owner.id, f.org.id, logo.id);
    const CROP = fakeImagePng("crop");
    const FRAME = fakeImagePng("frame", "16:9");
    const by = personActor(f.owner.id);
    const crop = await putMarkPicture(f.artifactDeps, by, f.org.id, logo.id, CROP);
    const frame = await putMarkPicture(f.artifactDeps, by, f.org.id, logo.id, FRAME);
    expect(crop).toMatchObject({ contentType: "image/png", size: CROP.byteLength });

    // Only a small PNG, JPEG or WebP, of a picture, a video or a PDF its writer reads.
    const big = new Uint8Array(MARK_PICTURE_BYTES + 1);
    big.set(CROP);
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
    for (const bytes of [new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), gif, big]) {
      const refused = await putMarkPicture(f.artifactDeps, by, f.org.id, logo.id, bytes).catch((e) => e);
      expect(refused).toBeInstanceOf(ValidationError);
      expect(refused.code).toBe("live.asset_type");
    }
    const notes = await upload("notas.txt", new TextEncoder().encode("lista"));
    await expect(putMarkPicture(f.artifactDeps, by, f.org.id, notes.id, CROP)).rejects.toBeInstanceOf(NotFoundError);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secreto", visibility: "private" });
    const hidden = await upload("rascunho.png", fakeImagePng("draft"), { channelId: secret.id });
    await expect(putMarkPicture(f.artifactDeps, personActor(bia.id), f.org.id, hidden.id, CROP)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const { ctx } = await mention(at, "@dev o logo está borrado aqui?", {
      artifactId: logo.id,
      selection: {
        label: "1",
        mark: { x: 0.25, y: 0.5, w: 0.2, h: 0.1 },
        version: 1,
        crop: crop.id,
        frame: frame.id,
      },
    });
    const out = await ok(ctx, LOOK_AT_COMMENT, { comment: "1" });
    expect(out.images).toEqual([
      { mediaType: "image/png", data: base64(CROP) },
      { mediaType: "image/png", data: base64(FRAME) },
    ]);
    expect(out.content).toContain(
      "Comment 1, by a person: an area of the picture from 25% to 45% across and 50% to 60% down, on version 1.",
    );
    expect(out.content).toContain("The first picture is what they marked; the second, the whole with the mark drawn.");
    expect(out.content).toContain("o logo está borrado aqui?");
    // The id the message's line gives finds it too.
    expect((await ok(ctx, LOOK_AT_COMMENT, { comment: crop.id })).images).toHaveLength(2);
    expect(await call(ctx, LOOK_AT_COMMENT, { comment: "2" })).toMatchObject({
      isError: true,
      content: "No such comment here. The comments with a pin are numbered 1 to 1.",
    });
  });

  test("comment_on_file posts the agent's words with the next pin, where it says or where the judge sees it", async () => {
    await withTools();
    const logo = await upload("logo.png", PNG, { title: "Logo" });
    const at = await openFileConversation(f.artifactDeps, f.owner.id, f.org.id, logo.id);
    const { ctx } = await mention(at, "@dev marca o que precisa mudar", {
      artifactId: logo.id,
      selection: { label: "1", mark: { x: 0.5, y: 0.5 }, version: 1 },
    });
    const events = f.listen(at.channelId);

    // An area by its place, kept inside the picture as a person's mark is; a moment or a page means nothing here.
    const area = await ok(ctx, COMMENT_ON_FILE, {
      text: "O contraste cai aqui",
      x: 0.8,
      y: 0.5,
      w: 0.5,
      h: 0.2,
      time: 3,
      page: 2,
    });
    expect(area.content).toBe(
      "Posted as comment 2 (an area of the picture from 80% to 100% across and 50% to 70% down, on version 1). If you have nothing to add, end your turn with an empty reply.",
    );
    expect(area.data?.mediaSent).toMatchObject({ kind: "comment" });
    const [row] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, postedOf(area)));
    expect(row).toMatchObject({
      authorType: "agent",
      authorAgentId: f.agent.id,
      threadId: at.rootId,
      body: "O contraste cai aqui",
    });
    expect(row?.meta.liveRef).toEqual({
      artifactId: logo.id,
      kind: "image",
      title: "Logo",
      selection: { label: "2", mark: { x: 0.8, y: 0.5, w: 0.2, h: 0.2 }, version: 1 },
    });
    expect(typesOf(events, "message.created").map((e) => (e as { messageId: string }).messageId)).toEqual([
      postedOf(area),
    ]);

    // A point; a target the judge doesn't see falls back to the place given, and alone it is refused.
    const point = await ok(ctx, COMMENT_ON_FILE, { text: "E aqui", target: "o sol", x: 0.1, y: 0.2 });
    expect(point.content).toStartWith(
      "Posted as comment 3 (a point of the picture at 10% across and 20% down, on version 1).",
    );
    const missed = await call(ctx, COMMENT_ON_FILE, { text: "E o sol?", target: "o sol" });
    expect(missed.isError).toBe(true);
    expect(missed.content).toStartWith('Couldn\'t find "o sol" on the picture.');
    expect(await call(ctx, COMMENT_ON_FILE, { text: "Em algum lugar" })).toMatchObject({
      isError: true,
      content: "Say where: `target`, or `x` and `y`.",
    });

    // Where the judge sees it on the picture itself.
    found = { box: { left: 0.1, top: 0.2, right: 0.5, bottom: 0.6 }, confidence: 0.9 };
    const located = await ok(ctx, COMMENT_ON_FILE, { text: "O sol está estourado", target: "o sol" });
    expect(judge.calls.at(-1)).toMatchObject({ kind: "comment_locate", state: { target: "o sol" } });
    expect((await metaOf(postedOf(located)))?.liveRef).toMatchObject({
      selection: { label: "4", mark: { x: 0.1, y: 0.2, w: 0.4, h: 0.4 }, version: 1 },
    });
  });

  test("resolve_comment resolves a comment by its number, and opens it again", async () => {
    await withTools();
    const logo = await upload("logo.png", PNG, { title: "Logo" });
    const at = await openFileConversation(f.artifactDeps, f.owner.id, f.org.id, logo.id);
    const { asked, ctx } = await mention(at, "@dev tira esse texto", {
      artifactId: logo.id,
      selection: { label: "1", mark: { x: 0.2, y: 0.3, w: 0.1, h: 0.1 }, version: 1 },
    });
    const events = f.listen(at.channelId);

    expect((await ok(ctx, RESOLVE_COMMENT, { comment: "1" })).content).toBe("Comment 1 is resolved.");
    expect(resolvedOf(await metaOf(asked.id))).toEqual({
      by: { type: "agent", id: f.agent.id },
      at: expect.any(String),
    });
    expect((await ok(ctx, LOOK_AT_COMMENT, { comment: "1" })).content).toStartWith(
      "Comment 1 (resolved), by a person:",
    );
    expect((await ok(ctx, RESOLVE_COMMENT, { comment: "#1", resolved: false })).content).toBe(
      "Comment 1 is open again.",
    );
    expect(resolvedOf(await metaOf(asked.id))).toBeNull();
    expect(typesOf(events, "message.resolved")).toHaveLength(2);
    expect(await call(ctx, RESOLVE_COMMENT, { comment: "5" })).toMatchObject({
      isError: true,
      content: "No such comment here (1 to 1).",
    });
  });

  test("on a video a comment points at a moment, on a PDF at a page", async () => {
    await withTools();
    const clip = await upload("demo.mp4", MP4, { title: "Demo" });
    const onClip = (
      await mention(await openFileConversation(f.artifactDeps, f.owner.id, f.org.id, clip.id), "@dev revisa o vídeo")
    ).ctx;
    expect(await call(onClip, COMMENT_ON_FILE, { text: "Aqui" })).toMatchObject({
      isError: true,
      content: "Say the moment (`time`, in seconds).",
    });
    const cut = await ok(onClip, COMMENT_ON_FILE, { text: "Corta aqui", time: 12.34, x: 0.5, y: 0.25, page: 3 });
    expect(cut.content).toStartWith(
      "Posted as comment 1 (the moment 0:12, a point of the frame at 50% across and 25% down, on version 1).",
    );
    expect(liveRefOf(await metaOf(postedOf(cut)))).toEqual({
      artifactId: clip.id,
      kind: "video",
      title: "Demo",
      selection: { label: "1", mark: { x: 0.5, y: 0.25 }, time: 12.3, version: 1 },
    });

    const contract = await upload("contrato.pdf", PDF, { title: "Contrato" });
    const onPdf = (
      await mention(
        await openFileConversation(f.artifactDeps, f.owner.id, f.org.id, contract.id),
        "@dev confere o contrato",
      )
    ).ctx;
    expect(await call(onPdf, COMMENT_ON_FILE, { text: "Aqui", time: 4 })).toMatchObject({
      isError: true,
      content: "Say the page (`page`).",
    });
    const signed = await ok(onPdf, COMMENT_ON_FILE, { text: "Falta a assinatura", page: 2 });
    expect(signed.content).toStartWith("Posted as comment 1 (page 2, on version 1).");
    expect(liveRefOf(await metaOf(postedOf(signed)))).toEqual({
      artifactId: contract.id,
      kind: "pdf",
      title: "Contrato",
      selection: { label: "1", page: 2, version: 1 },
    });
  });
});
