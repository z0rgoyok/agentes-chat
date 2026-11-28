import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/** A channel's responsible agent (ADR 0095): one of its agents, read with the channel, changed as its topic is. */

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Conferi."] }) });
});
afterEach(() => t.close());

type ChannelJson = { id: string; leadAgentId?: string | null };

test("PATCH sets leadAgentId to one of the channel's agents and the list carries it; null takes it back", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId, credentialId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const listed = async (as = api) =>
    ((await (await as("/channels")).json()) as { channels: ChannelJson[] }).channels.find((c) => c.id === channelId);
  const setLead = (leadAgentId: string | null, as = api) =>
    as(`/channels/${channelId}`, { method: "PATCH", json: { leadAgentId } });

  expect((await listed())?.leadAgentId).toBeNull();
  const set = await setLead(agentId);
  expect(set.status).toBe(200);
  expect(((await set.json()) as ChannelJson).leadAgentId).toBe(agentId);
  expect((await listed())?.leadAgentId).toBe(agentId);

  // An agent of the workspace that isn't in the channel can't be responsible for it.
  const made = await api("/agents", { json: { name: "Infra", handle: "infra", credentialId } });
  expect(made.status).toBe(201);
  const infra = (await made.json()) as { id: string };
  const outside = await setLead(infra.id);
  expect(outside.status).toBe(400);
  expect(await outside.json()).toMatchObject({ error: { code: "channel.lead_not_member" } });
  expect((await listed())?.leadAgentId).toBe(agentId);

  // A member who didn't create the channel and isn't an admin can't change it, as with its topic.
  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const asMember = (path: string, init?: Parameters<typeof member>[1]) =>
    member(`/api/app/organizations/${orgId}${path}`, init);
  expect((await setLead(null, asMember)).status).toBe(403);
  expect((await listed(asMember))?.leadAgentId).toBe(agentId);

  const cleared = await setLead(null);
  expect(cleared.status).toBe(200);
  expect(((await cleared.json()) as ChannelJson).leadAgentId).toBeNull();
  expect((await listed())?.leadAgentId).toBeNull();
});
