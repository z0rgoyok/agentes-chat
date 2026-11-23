import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  audienceOfConversation,
  cleanSelection,
  createAgent,
  createArtifact,
  createChannel,
  createLiveFile,
  drainOutbox,
  ensureFileConversation,
  FILE_CONVERSATION_DEPTH,
  ForbiddenError,
  fileConversationOf,
  fileConversationSummaries,
  listMembers,
  liveFileAccess,
  markThreadRead,
  NEW_AGENT_DEFAULTS,
  NotFoundError,
  openFileConversation,
  postPersonMessage,
  requireChannelAccess,
  setFileSharing,
  unreadFileConversations,
  ValidationError,
  withPersonFacts,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { makeLiveFile, personActor } from "./live-fixtures";

/**
 * A live file's conversation (ADR 0199): a `file` channel of its own with one hidden root, read by whoever reads the
 * file, where a mention admits and wakes an agent that may work on the file, and a message may point at what its
 * writer had selected (`meta.liveRef`).
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
      { id: canvas.id, channelId: canvas.channelId, createdBy: canvas.createdBy, inDrive: true },
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

  test("only a live file has one", async () => {
    f = await setup();
    const table = await createArtifact(f.artifactDeps, personActor(f.owner.id), f.org.id, {
      title: "Metas",
      content: { kind: "table", columns: ["mês", "meta"], rows: [["jan", "10"]] },
    });
    const refused = await openFileConversation(f.artifactDeps, f.owner.id, f.org.id, table.id).catch((e) => e);
    expect(refused).toBeInstanceOf(ValidationError);
    expect(refused.code).toBe("artifact.no_conversation");
    await expect(
      openFileConversation(f.artifactDeps, f.owner.id, f.org.id, crypto.randomUUID()),
    ).rejects.toBeInstanceOf(NotFoundError);
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
