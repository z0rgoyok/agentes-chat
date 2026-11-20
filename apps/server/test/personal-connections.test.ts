import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

interface Row {
  id: string;
  ownerUserId: string | null;
  serverUrl: string;
  label: string;
  agentIds?: string[];
}

const KEY = "lin_api_FAKE_walter_secret_1234";

/** Acme with its owner (who manages connectors), and Walter and Bia, members; Walter connects his own Linear. */
async function walterWithLinear() {
  // A stranger signs up for a workspace of their own too.
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const walter = await joinByInvitation(t, owner, orgId, "walter@example.com");
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const base = `/api/app/organizations/${orgId}/connectors`;
  const created = await walter(base, { json: { connector: "linear", apiKey: KEY, personal: true } });
  expect(created.status).toBe(201);
  const mine = (await created.json()) as Row;
  return { owner, walter, bia, orgId, agentId, base, mine };
}

const list = async (who: ReturnType<typeof browser>, url: string) =>
  ((await (await who(url)).json()) as { connections: Row[] }).connections;

test("a member connects their own; another member never sees it; who manages connectors sees a bare row only when asking", async () => {
  const { owner, walter, bia, base, mine } = await walterWithLinear();
  expect(mine.ownerUserId).not.toBeNull();
  // The team's needs managing connectors; GitHub connects for the team only.
  expect((await walter(base, { json: { connector: "linear", apiKey: "lin_api_FAKE_team_12345" } })).status).toBe(403);
  expect(
    (await walter(base, { json: { connector: "github", apiKey: "ghp_FAKE_walter_123456", personal: true } })).status,
  ).toBe(400);

  expect((await list(walter, base)).map((c) => c.id)).toEqual([mine.id]);
  expect((await list(bia, `${base}?others=1`)).map((c) => c.id)).toEqual([]);
  // An app that doesn't ask for others' rows (an older phone build) never gets one.
  expect((await list(owner, base)).map((c) => c.id)).toEqual([]);
  const bare = await (await owner(`${base}?others=1`)).text();
  expect(bare).not.toContain(KEY);
  const [row] = (JSON.parse(bare) as { connections: Row[] }).connections;
  expect(row).toMatchObject({ id: mine.id, ownerUserId: mine.ownerUserId, serverUrl: "" });
  expect(row?.agentIds).toEqual([]);
  expect(await (await walter(base)).text()).not.toContain(KEY);
});

test("only its person renames it; another member can't remove it; who manages connectors removes it", async () => {
  const { owner, walter, bia, base, mine } = await walterWithLinear();
  expect((await owner(`${base}/${mine.id}`, { method: "PATCH", json: { label: "Mine" } })).status).toBe(404);
  const renamed = await walter(`${base}/${mine.id}`, { method: "PATCH", json: { label: "My Linear" } });
  expect(((await renamed.json()) as Row).label).toBe("My Linear");
  // Moving it to the team takes managing connectors too.
  expect((await walter(`${base}/${mine.id}`, { method: "PATCH", json: { personal: false } })).status).toBe(403);
  expect((await bia(`${base}/${mine.id}`, { method: "DELETE" })).status).toBe(404);
  expect((await owner(`${base}/${mine.id}`, { method: "DELETE" })).status).toBe(204);
  expect(await list(walter, base)).toEqual([]);
});

test("another workspace finds nothing of it", async () => {
  const { mine, orgId } = await walterWithLinear();
  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com");
  const { orgId: theirs } = await seedOrg(stranger);
  expect(theirs).not.toBe(orgId);
  const base = `/api/app/organizations/${theirs}/connectors`;
  expect((await stranger(`${base}/${mine.id}`, { method: "DELETE" })).status).toBe(404);
  expect((await stranger(`${base}/${mine.id}`, { method: "PATCH", json: { label: "x" } })).status).toBe(404);
  expect(await list(stranger, `${base}?others=1`)).toEqual([]);
  // Nor through Acme's address: they aren't a member there.
  expect((await stranger(`/api/app/organizations/${orgId}/connectors/${mine.id}`, { method: "DELETE" })).status).toBe(
    403,
  );
});

test("an agent's page: nobody but its person gives a personal connection to an agent, and it isn't on one it never got", async () => {
  const { owner, walter, bia, orgId, agentId, base, mine } = await walterWithLinear();
  const access = `/api/app/organizations/${orgId}/agents/${agentId}/access`;
  // Walter doesn't own the team's agent, so he can't change its access at all.
  const off = { all: false, connectors: {}, scopes: [], tools: { allow: [], deny: [] } };
  expect((await walter(access, { method: "PUT", json: { ...off, connectors: { [mine.id]: true } } })).status).toBe(403);
  // The owner may not give it either: only its person does.
  expect((await owner(access, { method: "PUT", json: { ...off, connectors: { [mine.id]: true } } })).status).toBe(403);
  const tree = (await (await owner(`${access}?others=1`)).json()) as { connectors: { connectionId: string }[] };
  expect(tree.connectors.map((c) => c.connectionId)).not.toContain(mine.id);
  // "Tirar de um agente": who manages connectors may; a member who may not reads it as missing.
  expect((await bia(`${base}/${mine.id}/agents/${agentId}`, { method: "DELETE" })).status).toBe(404);
  expect((await owner(`${base}/${mine.id}/agents/${agentId}`, { method: "DELETE" })).status).toBe(204);
});
