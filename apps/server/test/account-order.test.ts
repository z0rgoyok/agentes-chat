import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { browser, createTestServer, joinByInvitation, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

/** ADR 0041 §6: the order of use of a workspace's Claude and ChatGPT accounts, and an agent's "Só esta conta". */

let t: TestServer;
afterEach(() => t.close());

const RUNNER = {
  hostname: "mac",
  os: "darwin",
  arch: "arm64",
  version: "0.9.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
};

const OWNER_A = "0193ffff-0000-4000-8000-00000000a001";
const OWNER_B = "0193ffff-0000-4000-8000-00000000a002";
const JOAO_A = "0193ffff-0000-4000-8000-00000000c001";
const JOAO_ONLY = "0193ffff-0000-4000-8000-00000000c002";
const OWNER_KEY = "0193ffff-0000-4000-8000-00000000a003";
const OWNER_CODEX = "0193ffff-0000-4000-8000-00000000a004";
const OWNER_GEMINI = "0193ffff-0000-4000-8000-00000000a005";

type Group = {
  machineId: string;
  kind: string;
  accounts: { id: string; canMove: boolean; useOrder: number | null; movable: boolean }[];
};

async function workspace() {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "walter@example.com");
  const seeded = await seedOrg(owner);
  const as = (b: ReturnType<typeof browser>) => (path: string, init?: Parameters<typeof owner>[1]) =>
    b(`/api/app/organizations/${seeded.orgId}${path}`, init);
  const admin = browser(t);
  await signUp(admin, "ada@example.com");
  await joinByInvitation(t, owner, seeded.orgId, "ada@example.com", { role: "admin", as: admin });
  const member = browser(t);
  await signUp(member, "joao@example.com");
  await joinByInvitation(t, owner, seeded.orgId, "joao@example.com", { role: "member", as: member });
  const api = as(owner);
  const mac = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "mac" });
  const id = async (email: string) =>
    (await t.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)))[0]?.id ?? "";
  const ownerId = await id("walter@example.com");
  const joaoId = await id("joao@example.com");
  let minute = 0;
  const account = (accountId: string, createdBy: string, more: Partial<typeof schema.machineAccounts.$inferInsert>) =>
    t.db.insert(schema.machineAccounts).values({
      id: accountId,
      orgId: seeded.orgId,
      machineId: mac.machineId,
      kind: "claude_code",
      label: `Conta ${accountId.slice(-4)}`,
      status: "active",
      createdBy,
      shared: true,
      createdAt: new Date(Date.UTC(2026, 10, 1, 12, minute++)),
      ...more,
    });
  await account(OWNER_A, ownerId, {});
  await account(JOAO_A, joaoId, {});
  await account(OWNER_B, ownerId, {});
  await account(JOAO_ONLY, joaoId, { serves: "owner" });
  await account(OWNER_KEY, ownerId, { provider: "zai", authMethod: "api_key" });
  await account(OWNER_CODEX, ownerId, { kind: "codex" });
  await account(OWNER_GEMINI, ownerId, { kind: "antigravity" });
  return { ...seeded, api, asAda: as(admin), asJoao: as(member), mac };
}

const order = async (call: Call) => {
  const res = await call("/ai-accounts/order");
  expect(res.status).toBe(200);
  return ((await res.json()) as { groups: Group[] }).groups;
};
const ids = (g: Group | undefined) => g?.accounts.map((a) => a.id);
type Call = (path: string, init?: Parameters<ReturnType<typeof browser>>[1]) => Promise<Response>;
const move = (call: Call, accountId: string, index: unknown) =>
  call(`/ai-accounts/${accountId}/order`, { method: "PUT", json: { index } });
const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

test("the order of use: by computer and kind, the CLI's own sign-ins only, placed ones first and then the oldest", async () => {
  const { asJoao, mac } = await workspace();
  await t.db.update(schema.machineAccounts).set({ useOrder: 0 }).where(eq(schema.machineAccounts.id, OWNER_B));
  const groups = await order(asJoao);
  // Never a key's account, never Gemini (Google forbids rotating accounts). Owner-only accounts keep their place.
  expect(groups.map((g) => [g.machineId, g.kind])).toEqual([
    [mac.machineId, "claude_code"],
    [mac.machineId, "codex"],
  ]);
  expect(ids(groups[0])).toEqual([OWNER_B, OWNER_A, JOAO_A, JOAO_ONLY]);
  expect(ids(groups[1])).toEqual([OWNER_CODEX]);
  // João moves only his own.
  expect(groups[0]?.accounts.map((a) => a.canMove)).toEqual([false, false, true, true]);
  expect(groups[0]?.accounts[0]?.useOrder).toBe(0);
});

test("only accounts a run may move to have a place: a one-agent login and a signed-out one come last, out of the moves", async () => {
  const { api } = await workspace();
  await t.db
    .update(schema.machineAccounts)
    .set({ shared: false, useOrder: 0 })
    .where(eq(schema.machineAccounts.id, OWNER_A));
  await t.db.update(schema.machineAccounts).set({ status: "signed_out" }).where(eq(schema.machineAccounts.id, JOAO_A));
  const [claude] = await order(api);
  expect(ids(claude)).toEqual([OWNER_B, JOAO_ONLY, OWNER_A, JOAO_A]);
  expect(claude?.accounts.map((a) => a.movable)).toEqual([true, true, false, false]);
  // A move counts only the placed ones, and an account with no place isn't one to move.
  const moved = await move(api, JOAO_ONLY, 0);
  expect(moved.status).toBe(200);
  expect(ids((await moved.json()) as Group)).toEqual([JOAO_ONLY, OWNER_B, OWNER_A, JOAO_A]);
  expect((await move(api, OWNER_A, 0)).status).toBe(404);
});

test("moving an account: its owner or an admin, the others keep their order; anyone else is refused in words", async () => {
  const { api, asAda, asJoao } = await workspace();
  // João puts his own account first.
  const first = await move(asJoao, JOAO_A, 0);
  expect(first.status).toBe(200);
  expect(ids((await first.json()) as Group)).toEqual([JOAO_A, OWNER_A, OWNER_B, JOAO_ONLY]);
  const stored = await t.db
    .select({ id: schema.machineAccounts.id, useOrder: schema.machineAccounts.useOrder })
    .from(schema.machineAccounts)
    .where(eq(schema.machineAccounts.kind, "claude_code"));
  expect(Object.fromEntries(stored.map((r) => [r.id, r.useOrder]))).toMatchObject({
    [JOAO_A]: 0,
    [OWNER_A]: 1,
    [OWNER_B]: 2,
    [JOAO_ONLY]: 3,
  });

  // Someone else's account: refused, nothing moves.
  const refused = await move(asJoao, OWNER_B, 0);
  expect(refused.status).toBe(403);
  expect(await code(refused)).toBe("account.order_forbidden");
  expect(ids((await order(asJoao))[0])).toEqual([JOAO_A, OWNER_A, OWNER_B, JOAO_ONLY]);

  // An admin moves anyone's; past the end is last.
  const last = await move(asAda, JOAO_A, 99);
  expect(last.status).toBe(200);
  expect(ids((await last.json()) as Group)).toEqual([OWNER_A, OWNER_B, JOAO_ONLY, JOAO_A]);
  expect(ids((await order(api))[0])).toEqual([OWNER_A, OWNER_B, JOAO_ONLY, JOAO_A]);

  // A key's account has no place in the order; a place is a whole number from 0.
  expect((await move(api, OWNER_KEY, 0)).status).toBe(404);
  expect((await move(api, OWNER_A, -1)).status).toBe(400);
  expect((await move(api, OWNER_A, 1.5)).status).toBe(400);
  const audit = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "account.order"));
  expect(audit).toHaveLength(2);
});

test("Só esta conta: off by default, kept by the agent, shown in its brain view", async () => {
  const { api, asJoao, agentId } = await workspace();
  const brain = async () => (await (await api(`/agents/${agentId}/brain`)).json()) as { accountPinned: boolean };
  expect((await brain()).accountPinned).toBe(false);
  const put = await api(`/agents/${agentId}/brain`, { method: "PUT", json: { accountPinned: true } });
  expect(put.status).toBe(200);
  expect(((await put.json()) as { accountPinned: boolean }).accountPinned).toBe(true);
  expect((await brain()).accountPinned).toBe(true);
  const [row] = await t.db
    .select({ pinned: schema.agents.brainAccountPinned })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId));
  expect(row?.pinned).toBe(true);
  // Omitted, it stays; only someone who may change the agent's AI changes it.
  expect((await api(`/agents/${agentId}/brain`, { method: "PUT", json: { effort: "high" } })).status).toBe(200);
  expect((await brain()).accountPinned).toBe(true);
  expect((await asJoao(`/agents/${agentId}/brain`, { method: "PUT", json: { accountPinned: false } })).status).toBe(
    403,
  );
  expect((await api(`/agents/${agentId}/brain`, { method: "PUT", json: { accountPinned: "yes" } })).status).toBe(400);
});

test("the OpenAPI document lists the order's routes", async () => {
  t = await createTestServer();
  const doc = (await (await t.app.request("/api/openapi.json")).json()) as { paths: Record<string, unknown> };
  expect(Object.keys(doc.paths)).toContain("/app/organizations/{orgId}/ai-accounts/order");
  expect(Object.keys(doc.paths)).toContain("/app/organizations/{orgId}/ai-accounts/{accountId}/order");
});
