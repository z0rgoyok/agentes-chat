import { afterEach, expect, test } from "bun:test";
import { insertContextItem } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t?.close());

test("memory API advertises actual eligibility and shares an ordinary note as a fact", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const base = {
    orgId,
    agentId,
    kind: "note" as const,
    scopeType: "channel" as const,
    scopeId: channelId,
    channelIds: [channelId],
    content: "Check migrations before publishing.",
    createdByKind: "agent" as const,
    createdById: agentId,
  };
  const note = await insertContextItem(t.db, base);
  const internal = await insertContextItem(t.db, { ...base, scopeType: "agent", scopeId: agentId });
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const list = (await (await api(`/agents/${agentId}/memories`)).json()) as {
    memories: { id: string; canMakeTeam: boolean }[];
  };
  expect(list.memories.find((m) => m.id === note.id)?.canMakeTeam).toBe(true);
  expect(list.memories.find((m) => m.id === internal.id)?.canMakeTeam).toBe(false);
  const refused = await api(`/memories/${internal.id}/team`, { json: {} });
  expect(refused.status).toBe(400);
  expect(JSON.stringify(await refused.json())).toContain("memory.team_unavailable");
  const res = await api(`/memories/${note.id}/team`, { json: {} });
  expect(res.status).toBe(200);
  const result = (await res.json()) as { id: string };
  expect(result).toMatchObject({ kind: "fact", canMakeTeam: false });
  expect(await (await api(`/memories/${note.id}/team`, { json: {} })).json()).toMatchObject({ id: result.id });
});
