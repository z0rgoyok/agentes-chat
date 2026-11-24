import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/** A channel's "Agents reply in threads" (ADR 0214): read with the channel, changed as its topic is. */

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Conferi."] }) });
});
afterEach(() => t.close());

type ChannelJson = { id: string; name: string; replyInThreads?: boolean };
type MessageJson = { id: string; threadId: string | null; author: { type: string } };

test("the channel's GET and PATCH carry replyInThreads; only who may change its topic changes it", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const listed = async (as = api) =>
    ((await (await as("/channels")).json()) as { channels: ChannelJson[] }).channels.find((c) => c.id === channelId);

  expect((await listed())?.replyInThreads).toBe(false);
  const patched = await api(`/channels/${channelId}`, { method: "PATCH", json: { replyInThreads: true } });
  expect(patched.status).toBe(200);
  expect(((await patched.json()) as ChannelJson).replyInThreads).toBe(true);
  expect((await listed())?.replyInThreads).toBe(true);

  // A member who didn't create the channel and isn't an admin can't change it, as with its topic.
  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const asMember = (path: string, init?: Parameters<typeof member>[1]) =>
    member(`/api/app/organizations/${orgId}${path}`, init);
  const refused = await asMember(`/channels/${channelId}`, { method: "PATCH", json: { replyInThreads: false } });
  expect(refused.status).toBe(403);
  const topicRefused = await asMember(`/channels/${channelId}`, { method: "PATCH", json: { topic: "x" } });
  expect(topicRefused.status).toBe(403);
  expect((await listed(asMember))?.replyInThreads).toBe(true);

  // A channel its creator made: theirs to change.
  const own = (await (await asMember("/channels", { json: { name: "vendas" } })).json()) as ChannelJson;
  expect(own.replyInThreads).toBe(false);
  const mine = await asMember(`/channels/${own.id}`, { method: "PATCH", json: { replyInThreads: true } });
  expect(((await mine.json()) as ChannelJson).replyInThreads).toBe(true);

  // A direct conversation never replies in threads.
  const dm = (await (await api("/dms", { json: { agentId } })).json()) as { channelId: string };
  const inDm = await api(`/channels/${dm.channelId}`, { method: "PATCH", json: { replyInThreads: true } });
  expect(inDm.status).toBe(400);
});

test("a message in the main timeline of such a channel: the agent's reply lands in its thread", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  await api(`/channels/${channelId}`, { method: "PATCH", json: { replyInThreads: true } });

  const asked = (await (
    await api(`/channels/${channelId}/messages`, { json: { body: "@dev confere" } })
  ).json()) as MessageJson;
  await t.drain();
  const read = async (query = "") =>
    ((await (await api(`/channels/${channelId}/messages${query}`)).json()) as { messages: MessageJson[] }).messages;
  expect((await read()).filter((m) => m.author.type === "agent")).toEqual([]);
  const replies = (await read(`?threadId=${asked.id}`)).filter((m) => m.author.type === "agent");
  expect(replies.length).toBeGreaterThan(0);
  expect(replies.every((m) => m.threadId === asked.id)).toBe(true);
});
