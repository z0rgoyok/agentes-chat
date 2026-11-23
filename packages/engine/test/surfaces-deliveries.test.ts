import { afterEach, beforeEach, expect, test } from "bun:test";
import { createMemoryRateLimiter } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  claimLink,
  confirmLink,
  createArtifact,
  createFileArtifact,
  deliveryFile,
  drainOutbox,
  fallBack,
  insertMessage,
  listDms,
  listSurfaceDeliveries,
  lodiFor,
  markChannelRead,
  mintLinkCode,
  openPersonAgentDm,
  postFromSurface,
  pruneSurfaceRows,
  queueSurfaceDelivery,
  readMarkFor,
  removeLink,
  SURFACE_FALLBACK_JOB,
  setSurface,
  surfaceOfRun,
  takeDeliveries,
  tellSurfaceVoiceDropped,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

const { surfaceDeliveries, notifications, outbox, channelReads, agentRuns, messages } = schema;

let f: Fixture;
beforeEach(async () => {
  f = await setup({ rightHand: true });
  setSurface({
    id: "example chat",
    name: "Example Chat",
    openUrl: "https://chat.example.com/open?text={text}",
    only: null,
  });
});
afterEach(async () => {
  setSurface(null);
  await f.close();
});

const SENDER = "sender-3003";
const deps = () => ({ db: f.db, pubsub: f.pubsub, artifacts: f.artifactDeps });

async function link(userId = f.owner.id, externalId = SENDER) {
  const { code } = await mintLinkCode(f.db, userId, f.org.id);
  const { link } = await claimLink({ db: f.db }, { externalId, display: "+1 555 0100", profileName: "Ana", code });
  const view = await confirmLink({ db: f.db }, userId, link.id);
  // The "linked" notice is not under test here.
  await f.db.delete(surfaceDeliveries);
  return view;
}

async function lodi() {
  const agent = await lodiFor(f.db, f.org.id);
  if (!agent) throw new Error("no right hand");
  return agent;
}

async function dmOf(userId = f.owner.id) {
  return openPersonAgentDm(f.db, f.org.id, userId, (await lodi()).id);
}

/** A person's message in their DM with the right hand: through the surface (with its link's mark) or the app. */
async function said(body: string, options: { via?: string; userId?: string; meta?: Record<string, unknown> } = {}) {
  const userId = options.userId ?? f.owner.id;
  const dm = await dmOf(userId);
  return insertMessage(f.db, {
    orgId: f.org.id,
    channelId: dm.id,
    author: { type: "person", userId },
    body,
    meta: {
      ...(options.via ? { via: { kind: "surface", surface: "example chat", linkId: options.via } } : {}),
      ...options.meta,
    },
  });
}

/** An ended run of the right hand on `trigger`. */
async function runOn(trigger: { id: string; channelId: string }) {
  const [run] = await f.db
    .insert(agentRuns)
    .values({
      orgId: f.org.id,
      agentId: (await lodi()).id,
      channelId: trigger.channelId,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "dm",
      hop: 1,
      status: "done",
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

/** The right hand's reply in that run, where it was asked unless `channelId` says otherwise. */
async function reply(
  run: { id: string; channelId: string },
  body: string,
  meta: Record<string, unknown> = {},
  channelId = run.channelId,
) {
  return insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: { type: "agent", agentId: (await lodi()).id, runId: run.id, hop: 1 },
    body,
    meta,
  });
}

const notificationsOf = (userId = f.owner.id) =>
  f.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.orgId, f.org.id), eq(notifications.userId, userId)));
const deliveries = () => f.db.select().from(surfaceDeliveries);
const runHook = (messageId: string) =>
  f.handlers["notifications.message"]?.(
    {
      id: crypto.randomUUID(),
      orgId: f.org.id,
      kind: "notifications.message",
      payload: { messageId },
      attempts: 1,
      maxAttempts: 8,
    } as never,
    { finalAttempt: false },
  );

const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};

test("a surface message's reply from the right hand is one delivery, with no in-app notification or push", async () => {
  await link();
  const posted = await postFromSurface(
    {
      db: f.db,
      pubsub: f.pubsub,
      judge: f.context.judge,
      artifacts: f.artifactDeps,
      voice: null,
      rateLimiter: createMemoryRateLimiter(),
    },
    { externalId: SENDER, inboundId: "in-1", text: "What's on today?", files: [] },
  );
  await drainOutbox(f.db, f.handlers);
  const rows = await deliveries();
  expect(rows).toHaveLength(1);
  const [row] = rows;
  expect(row).toMatchObject({ kind: "reply", inReplyTo: posted.messageId, takenAt: null });
  const [answer] = await f.db
    .select()
    .from(messages)
    .where(and(eq(messages.orgId, f.org.id), eq(messages.id, row?.messageId ?? "")));
  expect(answer?.authorAgentId).toBe((await lodi()).id);
  expect((await notificationsOf()).filter((n) => n.kind === "agent_reply")).toEqual([]);
  expect(await f.db.select().from(outbox).where(eq(outbox.kind, "push.send"))).toEqual([]);
  const [job] = await f.db.select().from(outbox).where(eq(outbox.kind, SURFACE_FALLBACK_JOB));
  expect(job?.dedupeKey).toBe(`surface.fallback:${row?.id}`);
  expect((job?.nextAttemptAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(4 * 60_000);
});

test("the turn follows the latest person message the run read: a steered surface message counts, and the reverse", async () => {
  const { id: linkId } = await link();
  const fromApp = await said("from the app");
  const appRun = await runOn(fromApp);
  const steered = await said("and from the surface", { via: linkId, meta: { steeredRunIds: [appRun.id] } });
  expect(await surfaceOfRun(f.db, f.org.id, appRun.id)).toEqual({
    userId: f.owner.id,
    messageId: steered.id,
    linkId,
  });
  expect(await queueSurfaceDelivery(f.db, f.org.id, (await reply(appRun, "Done.")).id)).toBe(true);

  const fromSurface = await said("from the surface", { via: linkId });
  const surfaceRun = await runOn(fromSurface);
  await said("then from the app", { meta: { steeredRunIds: [surfaceRun.id] } });
  expect(await surfaceOfRun(f.db, f.org.id, surfaceRun.id)).toBeNull();
  const answer = await reply(surfaceRun, "Sure.");
  await runHook(answer.id);
  expect(await deliveries()).toHaveLength(1);
  expect((await notificationsOf()).map((n) => n.kind)).toContain("agent_reply");
});

test("progress lines, quiet notices and replies outside the DM are never delivered, nor notified as replies", async () => {
  const { id: linkId } = await link();
  const run = await runOn(await said("check the build", { via: linkId }));
  const progress = await reply(run, "Still on it", { workUpdate: { id: crypto.randomUUID(), seq: 1 } });
  const quiet = await reply(run, "Stopped", { notice: { kind: "run_stopped" } });
  for (const m of [progress, quiet]) {
    expect(await queueSurfaceDelivery(f.db, f.org.id, m.id)).toBe(false);
    await runHook(m.id);
  }
  expect(await notificationsOf()).toEqual([]);
  const inChannel = await reply(run, "Posted in general", {}, f.general.id);
  expect(await queueSurfaceDelivery(f.db, f.org.id, inChannel.id)).toBe(false);
  expect(await deliveries()).toEqual([]);
});

test("unlinked before the hook, or with the bridge off: the usual notification", async () => {
  const view = await link();
  const run = await runOn(await said("hi", { via: view.id }));
  await removeLink({ db: f.db }, f.owner.id, view.id);
  await runHook((await reply(run, "Hello")).id);
  expect(await deliveries()).toEqual([]);
  expect((await notificationsOf()).map((n) => n.kind)).toEqual(["agent_reply"]);

  const again = await link();
  const second = await runOn(await said("hi again", { via: again.id }));
  setSurface(null);
  expect(await queueSurfaceDelivery(f.db, f.org.id, (await reply(second, "Hello again")).id)).toBe(false);
});

test("the listed view: text, files, a GIF, a question's card with its choices, an approval's card, the quoted message", async () => {
  const { id: linkId } = await link();
  const asked = await said("send me the report", { via: linkId });
  const run = await runOn(asked);
  const dm = await dmOf();
  const file = await createFileArtifact(f.artifactDeps, { type: "person", userId: f.owner.id }, f.org.id, {
    title: "report.pdf",
    name: "report.pdf",
    bytes: new TextEncoder().encode("%PDF-1.4 example"),
    contentType: "application/pdf",
    channelId: dm.id,
  });
  const withFile = await reply(run, "Here it is.", {
    artifacts: [{ id: file.id, version: 1, title: "report.pdf" }],
    media: { kind: "gif", provider: "giphy", id: "gif-1", title: "Wave", width: 10, height: 10 },
  });
  const [question] = await f.db
    .insert(schema.agentQuestions)
    .values({
      orgId: f.org.id,
      runId: run.id,
      agentId: (await lodi()).id,
      channelId: dm.id,
      toolUseId: "tool-1",
      text: "Which format?",
      choices: ["PDF", "Sheet"],
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning();
  const asking = await reply(run, "Which format?", { questionId: question?.id });
  const approving = await reply(run, "May I send it to Bea?", { approvalId: crypto.randomUUID() });
  for (const m of [withFile, asking, approving]) expect(await queueSurfaceDelivery(f.db, f.org.id, m.id)).toBe(true);

  const listed = await listSurfaceDeliveries(deps(), 50);
  expect(listed.map((d) => d.messageId)).toEqual([withFile.id, asking.id, approving.id]);
  expect(listed[0]).toMatchObject({
    kind: "reply",
    linkId,
    externalId: SENDER,
    orgId: f.org.id,
    orgName: "Acme",
    locale: "pt-BR",
    inReplyTo: asked.id,
    text: "Here it is.",
    files: [{ id: file.id, name: "report.pdf", contentType: "application/pdf", size: 16 }],
    media: { kind: "gif", id: "gif-1", title: "Wave" },
    card: null,
    choices: null,
  });
  expect(listed[1]?.card?.kind).toBe("question");
  expect(listed[1]?.card?.url).toContain(`m=${asking.id}`);
  expect(listed[1]?.choices).toEqual(["PDF", "Sheet"]);
  expect(listed[2]?.card?.kind).toBe("approval");
  expect(await listSurfaceDeliveries(deps(), 1)).toHaveLength(1);
});

test("listed after the link ended: closed as fallback and notified in the app; after the person left: dropped", async () => {
  const view = await link();
  const run = await runOn(await said("hi", { via: view.id }));
  await queueSurfaceDelivery(f.db, f.org.id, (await reply(run, "Hello")).id);
  await removeLink({ db: f.db }, f.owner.id, view.id);
  expect(await listSurfaceDeliveries(deps(), 50)).toEqual([]);
  expect((await deliveries()).map((d) => d.outcome)).toEqual(["fallback"]);
  expect((await notificationsOf()).map((n) => n.kind)).toEqual(["agent_reply"]);

  const bea = await addMember(f.db, f.org.id, "member", "bea");
  const beaLink = await link(bea.id, "sender-bea");
  const beaRun = await runOn(await said("oi", { via: beaLink.id, userId: bea.id }));
  await queueSurfaceDelivery(f.db, f.org.id, (await reply(beaRun, "Oi")).id);
  await f.db
    .delete(schema.organizationMembers)
    .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, bea.id)));
  expect(await listSurfaceDeliveries(deps(), 50)).toEqual([]);
  expect((await deliveries()).map((d) => d.outcome)).toEqual(["dropped"]);
  expect(await notificationsOf(bea.id)).toEqual([]);
});

test("taken: sent marks the DM read up to the reply, unsent notifies in the app, the same ids again are late", async () => {
  const { id: linkId } = await link();
  const run = await runOn(await said("two things", { via: linkId }));
  const first = await reply(run, "First");
  const second = await reply(run, "Second");
  await queueSurfaceDelivery(f.db, f.org.id, first.id);
  await queueSurfaceDelivery(f.db, f.org.id, second.id);
  const [a, b] = (await listSurfaceDeliveries(deps(), 50)).map((d) => d.id);
  if (!a || !b) throw new Error("not listed");

  expect(await takeDeliveries(deps(), { sent: [a], unsent: [b] })).toEqual({ sent: 1, unsent: 1, late: [] });
  const [read] = await f.db
    .select()
    .from(channelReads)
    .where(and(eq(channelReads.channelId, first.channelId), eq(channelReads.userId, f.owner.id)));
  expect(read?.lastReadAt.getTime()).toBe(readMarkFor(first).getTime());
  expect((await notificationsOf()).map((n) => n.kind)).toEqual(["agent_reply"]);
  expect(await takeDeliveries(deps(), { sent: [a], unsent: [b] })).toEqual({ sent: 0, unsent: 0, late: [a, b] });
  expect(await listSurfaceDeliveries(deps(), 50)).toEqual([]);
});

const unreadOf = async (channelId: string) =>
  (await listDms(f.db, f.owner.id, f.org.id)).find((d) => d.channelId === channelId)?.unread;

/** Takes the delivery of `message` as sent. */
async function sent(message: { id: string }) {
  await queueSurfaceDelivery(f.db, f.org.id, message.id);
  const row = (await deliveries()).find((d) => d.messageId === message.id);
  if (!row) throw new Error("not queued");
  await takeDeliveries(deps(), { sent: [row.id], unsent: [] });
}

test("a sent reply reads as read in the app, and the agent's next message still counts", async () => {
  const { id: linkId } = await link();
  const run = await runOn(await said("hi", { via: linkId }));
  const answer = await reply(run, "Hello");
  expect(await unreadOf(answer.channelId)).toBe(1);
  await sent(answer);
  expect(await unreadOf(answer.channelId)).toBe(0);
  // A message from the reply's own millisecond would read under the mark, which is one past it.
  await Bun.sleep(2);
  await reply(run, "One more thing");
  expect(await unreadOf(answer.channelId)).toBe(1);
});

test("what the agent posted after the reply but before the reply was sent still counts", async () => {
  const { id: linkId } = await link();
  const run = await runOn(await said("hi", { via: linkId }));
  const answer = await reply(run, "Hello");
  await Bun.sleep(2);
  await reply(run, "One more thing");
  await sent(answer);
  expect(await unreadOf(answer.channelId)).toBe(1);
});

test("a sent reply that kept an earlier place than its post reads as read", async () => {
  const { id: linkId } = await link();
  const run = await runOn(await said("hi", { via: linkId }));
  const answer = await reply(run, "Hello");
  const placed = new Date(answer.createdAt.getTime() - 2 * 60_000);
  await f.db.update(messages).set({ createdAt: placed }).where(eq(messages.id, answer.id));
  expect(await unreadOf(answer.channelId)).toBe(1);
  await sent({ id: answer.id });
  expect(await unreadOf(answer.channelId)).toBe(0);
});

test("a sent reply never moves the read mark back", async () => {
  const { id: linkId } = await link();
  const run = await runOn(await said("hi", { via: linkId }));
  const answer = await reply(run, "Hello");
  await queueSurfaceDelivery(f.db, f.org.id, answer.id);
  const later = new Date(answer.createdAt.getTime() + 60_000);
  await markChannelRead(f.db, f.owner.id, f.org.id, answer.channelId, later);
  const [row] = await deliveries();
  await takeDeliveries(deps(), { sent: [row?.id ?? ""], unsent: [] });
  const [read] = await f.db
    .select()
    .from(channelReads)
    .where(and(eq(channelReads.channelId, answer.channelId), eq(channelReads.userId, f.owner.id)));
  expect(read?.lastReadAt.getTime()).toBe(later.getTime());
});

test("the fallback job notifies once; a later taken is late, and after a taken the job does nothing", async () => {
  const { id: linkId } = await link();
  const run = await runOn(await said("hi", { via: linkId }));
  await queueSurfaceDelivery(f.db, f.org.id, (await reply(run, "One")).id);
  await queueSurfaceDelivery(f.db, f.org.id, (await reply(run, "Two")).id);
  const [one, two] = (await deliveries()).map((d) => d.id);
  if (!one || !two) throw new Error("no deliveries");

  await fallBack(deps(), one);
  expect((await notificationsOf()).map((n) => [n.kind, n.count])).toEqual([["agent_reply", 1]]);
  expect(await takeDeliveries(deps(), { sent: [one], unsent: [] })).toEqual({ sent: 0, unsent: 0, late: [one] });

  await takeDeliveries(deps(), { sent: [two], unsent: [] });
  await fallBack(deps(), two);
  expect((await notificationsOf()).map((n) => [n.kind, n.count])).toEqual([["agent_reply", 1]]);
  expect((await deliveries()).map((d) => d.outcome).sort()).toEqual(["fallback", "sent"]);
});

test("rows older than five minutes are not listed, and pruning keeps a week of deliveries", async () => {
  const { id: linkId } = await link();
  const run = await runOn(await said("hi", { via: linkId }));
  await queueSurfaceDelivery(f.db, f.org.id, (await reply(run, "Hello")).id);
  await f.db.update(surfaceDeliveries).set({ createdAt: new Date(Date.now() - 6 * 60_000) });
  expect(await listSurfaceDeliveries(deps(), 50)).toEqual([]);
  expect(await pruneSurfaceRows(f.db)).toBe(0);
  await f.db.update(surfaceDeliveries).set({ createdAt: new Date(Date.now() - 8 * 24 * 3600_000) });
  expect(await pruneSurfaceRows(f.db)).toBe(1);
});

test("a file's bytes only for a file of that delivery's reply", async () => {
  const { id: linkId } = await link();
  const run = await runOn(await said("the file", { via: linkId }));
  const dm = await dmOf();
  const store = (name: string) =>
    createFileArtifact(f.artifactDeps, { type: "person", userId: f.owner.id }, f.org.id, {
      title: name,
      name,
      bytes: new TextEncoder().encode(`bytes of ${name}`),
      contentType: "text/plain",
      channelId: dm.id,
    });
  const mine = await store("notes.txt");
  const other = await store("other.txt");
  await queueSurfaceDelivery(
    f.db,
    f.org.id,
    (await reply(run, "Here", { artifacts: [{ id: mine.id, version: 1, title: "notes.txt" }] })).id,
  );
  const [row] = await deliveries();
  const file = await deliveryFile(deps(), row?.id ?? "", mine.id);
  expect(new TextDecoder().decode(file.body)).toBe("bytes of notes.txt");
  expect(file).toMatchObject({ name: "notes.txt", size: 18 });
  expect(await errorOf(deliveryFile(deps(), row?.id ?? "", other.id))).toBe("surface.file_gone");
  expect(await errorOf(deliveryFile(deps(), crypto.randomUUID(), mine.id))).toBe("surface.file_gone");
  await removeLink({ db: f.db }, f.owner.id, linkId);
  expect(await errorOf(deliveryFile(deps(), row?.id ?? "", mine.id))).toBe("surface.file_gone");
});

test("the notifications.message job run twice for one reply makes one delivery and one fallback job", async () => {
  const { id: linkId } = await link();
  const run = await runOn(await said("what's on today?", { via: linkId }));
  const answer = await reply(run, "Two meetings.");
  await runHook(answer.id);
  await runHook(answer.id);
  expect(await deliveries()).toHaveLength(1);
  expect(await f.db.select().from(outbox).where(eq(outbox.kind, SURFACE_FALLBACK_JOB))).toHaveLength(1);
  expect((await notificationsOf()).filter((n) => n.kind === "agent_reply")).toEqual([]);
});

test("a reply carrying a document has a card that opens it in the app", async () => {
  const { id: linkId } = await link();
  const run = await runOn(await said("the weekly report, please", { via: linkId }));
  const dm = await dmOf();
  const doc = await createArtifact(
    f.artifactDeps,
    { type: "agent", agentId: (await lodi()).id, channelId: dm.id },
    f.org.id,
    { title: "Weekly report", content: { kind: "document", markdown: "All good." } },
  );
  const answer = await reply(run, "Here is the report.", { artifacts: [{ id: doc.id, version: 1, title: doc.title }] });
  expect(await queueSurfaceDelivery(f.db, f.org.id, answer.id)).toBe(true);
  const [listed] = await listSurfaceDeliveries(deps(), 10);
  expect(listed).toMatchObject({ text: "Here is the report.", files: [] });
  expect(listed?.card?.kind).toBe("artifact");
  expect(listed?.card?.url).toContain(`m=${answer.id}`);
});

test("a dropped voice note from the surface: the right hand says so in the person's language, delivered there", async () => {
  const { id: linkId } = await link();
  await tellSurfaceVoiceDropped(deps(), {
    orgId: f.org.id,
    userId: f.owner.id,
    via: { kind: "surface", surface: "example chat", linkId },
  });
  const [listed] = await listSurfaceDeliveries(deps(), 10);
  expect(listed).toMatchObject({ kind: "reply", linkId, inReplyTo: null });
  expect(listed?.text).toBe("Não consegui entender esse áudio. Pode mandar de novo ou escrever?");
  // Another link's clip, or one with no link now, tells nobody on the surface.
  await tellSurfaceVoiceDropped(deps(), {
    orgId: f.org.id,
    userId: f.owner.id,
    via: { kind: "surface", surface: "example chat", linkId: crypto.randomUUID() },
  });
  expect(await deliveries()).toHaveLength(1);
});
