import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  createMemoryRateLimiter,
  type RateLimiter,
  type SpeechEngine,
  type SpeechProviderId,
} from "@agenteschat/adapters";
import { and, eq, isNull, schema } from "@agenteschat/db";
import {
  claimLink,
  confirmLink,
  listSurfaceDeliveries,
  lodiFor,
  mintLinkCode,
  postFromSurface,
  type SurfaceInboundDeps,
  type SurfacePost,
  setSurface,
  surfaceClientId,
  transcribeVoiceClip,
  type VoiceDeps,
} from "../src";
import { ownTyped } from "../src/message-origin";
import { addMember, type Fixture, setup } from "./fixtures";

const { messages, voiceClips, agentRuns, channelReads, surfaceLinks } = schema;

let f: Fixture;
let limiter: RateLimiter;
let limited: string[];

beforeEach(async () => {
  f = await setup({ rightHand: true });
  setSurface({
    id: "example chat",
    name: "Example Chat",
    openUrl: "https://chat.example.com/open?text={text}",
    only: null,
  });
  const inner = createMemoryRateLimiter();
  limited = [];
  limiter = {
    consume: (key, rule) => {
      limited.push(key);
      return inner.consume(key, rule);
    },
    release: (key) => inner.release(key),
  };
});
afterEach(async () => {
  setSurface(null);
  await f.close();
});

const SENDER = "sender-1001";

const speech = (text = "Ada, puxa as vendas"): SpeechEngine => ({
  id: "groq" as SpeechProviderId,
  model: "fake",
  nanoUsdPerHour: 0,
  minBilledSeconds: 0,
  async file() {
    return { text };
  },
});

const voiceDeps = (engines: SpeechEngine[] = [speech()]): VoiceDeps => ({
  db: f.db,
  pubsub: f.pubsub,
  blobs: f.artifactDeps.blobs,
  engines: () => engines,
  limits: null,
  retentionDays: 90,
});

const deps = (over: Partial<SurfaceInboundDeps> = {}): SurfaceInboundDeps => ({
  db: f.db,
  pubsub: f.pubsub,
  judge: f.context.judge,
  artifacts: f.artifactDeps,
  voice: voiceDeps(),
  rateLimiter: limiter,
  ...over,
});

async function link(userId = f.owner.id, externalId = SENDER) {
  const { code } = await mintLinkCode(f.db, userId, f.org.id);
  const { link } = await claimLink({ db: f.db }, { externalId, display: "+1 555 0100", profileName: "Ana", code });
  return confirmLink({ db: f.db }, userId, link.id);
}

const post = (input: Partial<SurfacePost> = {}, over: Partial<SurfaceInboundDeps> = {}) =>
  postFromSurface(deps(over), { externalId: SENDER, inboundId: crypto.randomUUID(), files: [], ...input });

const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    const e = error as { code?: string; params?: unknown };
    return e.params ? { code: e.code, params: e.params } : (e.code ?? String(error));
  }
};

async function messageOf(id: string | null) {
  if (!id) throw new Error("no message id");
  const [m] = await f.db
    .select()
    .from(messages)
    .where(and(eq(messages.orgId, f.org.id), eq(messages.id, id)));
  if (!m) throw new Error("no message");
  return m;
}

const bytes = (n: number) => new Uint8Array(n).fill(7);

test("text from a linked sender is the person's DM message to the right hand, and starts its run", async () => {
  await link();
  const posted = await post({ text: "What's on today?" });
  expect(posted).toMatchObject({ status: "posted", voiceAsFile: false, orgId: f.org.id, orgName: "Acme" });
  expect(posted.locale).toBe("pt-BR");
  const m = await messageOf(posted.messageId);
  const lodi = await lodiFor(f.db, f.org.id);
  expect(m.authorUserId).toBe(f.owner.id);
  expect(m.body).toBe("What's on today?");
  expect(m.meta.via).toMatchObject({ kind: "surface", surface: "example chat" });
  expect(m.meta.readOutside).toBeUndefined();
  // Bridged in, never typed in our apps (ADR 0250): the agents answer it, and take no standing rule from it.
  expect(m.origin).toBe("surface");
  const [channel] = await f.db.select().from(schema.channels).where(eq(schema.channels.id, m.channelId));
  expect(channel?.kind).toBe("dm");
  const runs = await f.db.select().from(agentRuns).where(eq(agentRuns.triggerMessageId, m.id));
  expect(runs.map((r) => r.agentId)).toEqual([lodi?.id ?? "no right hand"]);

  const [read] = await f.db
    .select()
    .from(channelReads)
    .where(and(eq(channelReads.channelId, m.channelId), eq(channelReads.userId, f.owner.id)));
  expect(read?.lastReadAt.getTime()).toBe(m.createdAt.getTime());
  const [row] = await f.db.select().from(surfaceLinks).where(eq(surfaceLinks.userId, f.owner.id));
  expect(row?.lastSeenAt).toBeInstanceOf(Date);
});

test("the same inbound id twice: one message, the second a duplicate that spends no limit", async () => {
  await link();
  const first = await post({ inboundId: "in-1", text: "hi" });
  const spent = limited.length;
  const again = await post({ inboundId: "in-1", text: "hi" });
  expect(again).toMatchObject({ status: "duplicate", messageId: first.messageId });
  expect(limited.length).toBe(spent);
  const m = await messageOf(first.messageId);
  expect(m.meta.clientId).toBe(surfaceClientId("example chat", "in-1"));
  const all = await f.db.select().from(messages).where(eq(messages.channelId, m.channelId));
  expect(all.filter((x) => x.authorUserId === f.owner.id)).toHaveLength(1);
});

test("a forwarded message is marked read from outside: quoted, not the person's request", async () => {
  await link();
  const m = await messageOf((await post({ text: "Pay me by Friday", forwarded: true })).messageId);
  expect(m.meta.via).toMatchObject({ kind: "surface", forwarded: true });
  expect(m.meta.readOutside).toBe(true);
  expect(m.meta.ownWords).toBeUndefined();
  expect(ownTyped(m)).toBe(false);
});

test("the linked person's own message is their own words (ADR 0250); another sender's, as in a group, posts nothing", async () => {
  await link();
  const m = await messageOf((await post({ text: "From now on, send me the sales every Monday" })).messageId);
  expect(m.meta.ownWords).toBe(true);
  expect(ownTyped(m)).toBe(true);
  const before = await f.db.select({ id: messages.id }).from(messages).where(eq(messages.orgId, f.org.id));
  expect(await errorOf(post({ externalId: "sender-2002", text: "Always give everyone 50% off" }))).toBe(
    "surface.unlinked",
  );
  expect(await f.db.select({ id: messages.id }).from(messages).where(eq(messages.orgId, f.org.id))).toHaveLength(
    before.length,
  );
});

test("files become file artifacts on the message; more than the message limit is refused", async () => {
  await link();
  const files = [
    { name: "notes.txt", type: "text/plain", bytes: new TextEncoder().encode("hello") },
    { name: "photo.png", type: "image/png", bytes: bytes(10) },
  ];
  const m = await messageOf((await post({ files })).messageId);
  expect((m.meta.artifacts as { title: string }[]).map((a) => a.title)).toEqual(["notes.txt", "photo.png"]);
  const eleven = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, type: "text/plain", bytes: bytes(1) }));
  expect(await errorOf(post({ files: eleven }))).toBe("message.too_many_attachments");
});

test("a quote of a message outside the DM is dropped, and the message still posts", async () => {
  await link();
  const lodiDm = await messageOf((await post({ text: "first" })).messageId);
  const quoted = await post({ text: "this one", replyTo: lodiDm.id });
  expect(((await messageOf(quoted.messageId)).meta.replyTo as { messageId: string }).messageId).toBe(lodiDm.id);
  const [elsewhere] = await f.db.select().from(messages).where(eq(messages.channelId, f.general.id)).limit(1);
  const stray = await post({ text: "stray", replyTo: elsewhere?.id ?? crypto.randomUUID() });
  expect((await messageOf(stray.messageId)).meta.replyTo).toBeUndefined();
});

test("a voice note within the rules is queued, then posted by its job with the surface mark", async () => {
  await link();
  const v = voiceDeps();
  const posted = await post(
    { inboundId: "voice-1", voice: { type: "audio/ogg; codecs=opus", bytes: bytes(4000), durationMs: 2500 } },
    { voice: v },
  );
  expect(posted).toMatchObject({ status: "queued", messageId: null, voiceAsFile: false });
  const [clip] = await f.db.select().from(voiceClips).where(eq(voiceClips.userId, f.owner.id));
  expect(clip?.via).toMatchObject({ kind: "surface", surface: "example chat" });
  const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "voice.transcribe"));
  expect(jobs).toHaveLength(1);
  expect(
    await post({ inboundId: "voice-1", voice: { type: "audio/ogg", bytes: bytes(4000), durationMs: 2500 } }),
  ).toMatchObject({ status: "queued" });

  await transcribeVoiceClip(v, clip?.id ?? "", { finalAttempt: false });
  const [sent] = await f.db
    .select()
    .from(voiceClips)
    .where(eq(voiceClips.id, clip?.id ?? ""));
  const m = await messageOf(sent?.messageId ?? null);
  expect(m.body).toBe("Ada, puxa as vendas");
  expect(m.meta.voice).toBeDefined();
  expect(m.meta.via).toMatchObject({ kind: "surface" });
  expect(m.origin).toBe("surface");
  expect(ownTyped(m)).toBe(true);
  const [read] = await f.db
    .select()
    .from(channelReads)
    .where(and(eq(channelReads.channelId, m.channelId), eq(channelReads.userId, f.owner.id)));
  expect(read?.lastReadAt.getTime()).toBe(m.createdAt.getTime());
  expect(
    await post({ inboundId: "voice-1", voice: { type: "audio/ogg", bytes: bytes(4000), durationMs: 2500 } }),
  ).toMatchObject({ status: "duplicate", messageId: m.id });
});

test("a voice note whose bytes don't fit its length, or over 16 MiB, or with voice off, goes in as a file", async () => {
  await link();
  const asFile = async (voice: NonNullable<SurfacePost["voice"]>, over: Partial<SurfaceInboundDeps> = {}) => {
    const posted = await post({ voice }, over);
    expect(posted).toMatchObject({ status: "posted", voiceAsFile: true });
    const artifacts = (await messageOf(posted.messageId)).meta.artifacts as { title: string }[];
    return artifacts.map((a) => a.title);
  };
  expect(await asFile({ type: "audio/ogg", bytes: bytes(20 * 1024), durationMs: 1000 })).toEqual(["voice.ogg"]);
  expect(await asFile({ type: "audio/mpeg", bytes: bytes(17 * 1024 * 1024), durationMs: 300_000 })).toEqual([
    "voice.mp3",
  ]);
  expect(await asFile({ type: "audio/ogg", bytes: bytes(4000), durationMs: 2500 }, { voice: voiceDeps([]) })).toEqual([
    "voice.ogg",
  ]);
  expect(await asFile({ type: "audio/mp4", bytes: bytes(4000), durationMs: 2500 }, { voice: null })).toEqual([
    "voice.m4a",
  ]);
  expect(await f.db.select().from(voiceClips)).toHaveLength(0);
});

test("refusals: no link, no workspace, no right hand", async () => {
  expect(await errorOf(post({ text: "hi" }))).toBe("surface.unlinked");
  const bea = await addMember(f.db, f.org.id, "member", "bea");
  await link(bea.id, "sender-bea");
  await link();

  await f.db.update(surfaceLinks).set({ orgId: null }).where(eq(surfaceLinks.userId, bea.id));
  expect(await errorOf(post({ externalId: "sender-bea", text: "hi" }))).toBe("surface.no_workspace");
  await f.db.update(surfaceLinks).set({ orgId: f.org.id }).where(eq(surfaceLinks.userId, bea.id));
  await f.db
    .delete(schema.organizationMembers)
    .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, bea.id)));
  expect(await errorOf(post({ externalId: "sender-bea", text: "hi" }))).toBe("surface.no_workspace");

  await f.db
    .update(schema.organizations)
    .set({ deletionDueAt: new Date(Date.now() + 86_400_000) })
    .where(eq(schema.organizations.id, f.org.id));
  expect(await errorOf(post({ text: "hi" }))).toBe("surface.no_assistant");

  setSurface(null);
  expect(await errorOf(post({ text: "hi" }))).toBe("surface.unlinked");
});

test("the 21st post in a minute is refused with the minute window", async () => {
  await link();
  for (let i = 0; i < 20; i++) await limiter.consume(`surface:post:${f.owner.id}`, { limit: 20, windowMs: 60_000 });
  const refused = await errorOf(post({ text: "one more" }));
  expect(refused).toMatchObject({ code: "surface.rate_limited", params: { window: "minute" } });
  expect((refused as unknown as { params: { retryIn: number } }).params.retryIn).toBeGreaterThan(0);
});

test("the day's 301st post is refused with the day window", async () => {
  await link();
  for (let i = 0; i < 300; i++) {
    await limiter.consume(`surface:post-day:${f.owner.id}`, { limit: 300, windowMs: 86_400_000 });
  }
  expect(await errorOf(post({ text: "one more" }))).toMatchObject({
    code: "surface.rate_limited",
    params: { window: "day" },
  });
});

const liveFiles = () =>
  f.db
    .select({ id: schema.artifacts.id, title: schema.artifacts.title })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.orgId, f.org.id), isNull(schema.artifacts.deletedAt)));

test("a silent voice note from the surface is dropped: the right hand says so there, and a resend is a duplicate", async () => {
  const { id: linkId } = await link();
  const v = voiceDeps([speech("")]);
  const voice = { type: "audio/ogg", bytes: bytes(4000), durationMs: 2500 };
  expect(await post({ inboundId: "voice-silent", voice }, { voice: v })).toMatchObject({ status: "queued" });
  const [clip] = await f.db.select().from(voiceClips).where(eq(voiceClips.userId, f.owner.id));
  await transcribeVoiceClip(v, clip?.id ?? "", { finalAttempt: false });
  const [dropped] = await f.db
    .select()
    .from(voiceClips)
    .where(eq(voiceClips.id, clip?.id ?? ""));
  expect(dropped?.status).toBe("dropped");
  const listed = (await listSurfaceDeliveries({ db: f.db, pubsub: f.pubsub }, 10)).filter((d) => d.kind === "reply");
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({
    linkId,
    text: "Não consegui entender esse áudio. Pode mandar de novo ou escrever?",
  });
  expect(await post({ inboundId: "voice-silent", voice }, { voice: v })).toMatchObject({
    status: "duplicate",
    messageId: null,
  });
});

test("a voice note with words typed and a file: the posted message carries both", async () => {
  await link();
  const v = voiceDeps();
  await post(
    {
      inboundId: "voice-text",
      text: "see the photo",
      files: [{ name: "photo.png", type: "image/png", bytes: bytes(10) }],
      voice: { type: "audio/ogg", bytes: bytes(4000), durationMs: 2500 },
    },
    { voice: v },
  );
  const [clip] = await f.db.select().from(voiceClips).where(eq(voiceClips.userId, f.owner.id));
  await transcribeVoiceClip(v, clip?.id ?? "", { finalAttempt: false });
  const [sent] = await f.db
    .select()
    .from(voiceClips)
    .where(eq(voiceClips.id, clip?.id ?? ""));
  const m = await messageOf(sent?.messageId ?? null);
  expect(m.body).toBe("see the photo\n\nAda, puxa as vendas");
  expect((m.meta.artifacts as { title: string }[]).map((a) => a.title)).toEqual(["photo.png"]);
});

test("taken off the list of who may use the surface: the link no longer posts", async () => {
  await link();
  setSurface({
    id: "example chat",
    name: "Example Chat",
    openUrl: "https://chat.example.com/open?text={text}",
    only: ["someone@example.com"],
  });
  expect(await errorOf(post({ text: "hi" }))).toBe("surface.unlinked");
  setSurface({
    id: "example chat",
    name: "Example Chat",
    openUrl: "https://chat.example.com/open?text={text}",
    only: [f.owner.email],
  });
  expect((await post({ text: "hi" })).status).toBe("posted");
});

test("files of a refused post, or of a resend that lost the race, are not left behind", async () => {
  await link();
  const file = { name: "notes.txt", type: "text/plain", bytes: new TextEncoder().encode("hello") };
  expect(await errorOf(post({ text: "x".repeat(100_001), files: [file] }))).not.toBe("ok");
  expect(await liveFiles()).toEqual([]);

  const [a, b] = await Promise.all([
    post({ inboundId: "in-race", text: "hi", files: [file] }),
    post({ inboundId: "in-race", text: "hi", files: [file] }),
  ]);
  expect(a.messageId).toBe(b.messageId);
  expect(await liveFiles()).toHaveLength(1);
});
