import { afterEach, beforeEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { highRisk } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(async () => {
  await t.close();
});

/** A connected app whose `create_page` an admin left as a plain write. */
const APP = "00000000-0000-4000-8000-00000000c001";

test("approvals API: each says whether it is routine, and `only` decides the routine ones alone", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const [me] = await t.db.select().from(schema.users);
  const ask = async (tool: string, scope: string, connectionId: string | null) => {
    const [row] = await t.db
      .insert(schema.approvals)
      .values({
        orgId,
        agentId,
        channelId,
        threadRootId: crypto.randomUUID(),
        toolUseId: crypto.randomUUID(),
        tool,
        scope,
        connectionId,
        params: {},
        actionHash: crypto.randomUUID(),
        title: tool,
        ownerUserId: me?.id ?? null,
        expiresAt: new Date(Date.now() + 3_600_000),
        highRisk: highRisk(tool, scope),
      })
      .returning();
    return row?.id ?? "";
  };
  await t.db.insert(schema.connectorConnections).values({
    id: APP,
    orgId,
    connector: "custom:notes",
    label: "Notes",
    toolPrefix: "notes",
    serverUrl: "https://notes.example.com/mcp",
    authType: "none",
  });
  await t.db.insert(schema.customTools).values([
    { orgId, connectionId: APP, name: "create_page", access: "write", suggestedAccess: "write" },
    { orgId, connectionId: APP, name: "rename_page", access: "approval", suggestedAccess: "write" },
  ]);
  const page = await ask("notes_create_page", `custom:${APP}:write`, APP);
  // A harmless name an admin set to ask every time: the connection's word, not the name's.
  const asks = await ask("notes_rename_page", `custom:${APP}:write`, APP);
  const merge = await ask("merge_pull_request", "github:pr.merge", APP);
  const command = await ask("run_code", "sandbox:run", null);

  const list = (await (await owner(`/api/app/organizations/${orgId}/approvals?status=pending`)).json()) as {
    approvals: { id: string; routine: boolean }[];
  };
  expect(Object.fromEntries(list.approvals.map((a) => [a.id, a.routine]))).toEqual({
    [page]: true,
    [asks]: false,
    [merge]: false,
    [command]: false,
  });

  const decide = (only: string) =>
    owner(`/api/app/organizations/${orgId}/approvals/decide`, {
      json: { ids: [page, asks, merge, command], decision: "approve", only },
    });
  expect((await decide("everything")).status).toBe(400);
  const res = await decide("routine");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { approvals: { id: string; status: string }[]; skipped: string[] };
  expect(body.approvals.map((a) => [a.id, a.status])).toEqual([[page, "approved"]]);
  expect([...body.skipped].sort()).toEqual([asks, merge, command].sort());
  const rows = await t.db.select().from(schema.approvals);
  expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
    [page]: "approved",
    [asks]: "pending",
    [merge]: "pending",
    [command]: "pending",
  });
});

test("the digest's switch shows on the right hand's page", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const prefs = (await (await owner(`/api/app/organizations/${orgId}/team-week`)).json()) as { switches: string[] };
  expect(prefs.switches).toContain("digest");
});
