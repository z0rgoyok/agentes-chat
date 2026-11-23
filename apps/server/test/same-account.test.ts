import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { browser, createTestServer, joinByInvitation, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

/** `sameAs`: one id for every login of one account (signed in once per agent), the email and key staying its owner's. */

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

const id = (n: number) => `0193abab-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Account = {
  id: string;
  sameAs: string;
  email: string | null;
  keyHint: string | null;
  providerOrgId: string | null;
};
type Call = (path: string, init?: Parameters<ReturnType<typeof browser>>[1]) => Promise<Response>;

async function workspace() {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "walter@example.com");
  const seeded = await seedOrg(owner);
  const as =
    (b: ReturnType<typeof browser>, orgId = seeded.orgId): Call =>
    (path, init) =>
      b(`/api/app/organizations/${orgId}${path}`, init);
  const admin = browser(t);
  await signUp(admin, "ada@example.com");
  await joinByInvitation(t, owner, seeded.orgId, "ada@example.com", { role: "admin", as: admin });
  const member = browser(t);
  await signUp(member, "joao@example.com");
  await joinByInvitation(t, owner, seeded.orgId, "joao@example.com", { role: "member", as: member });
  const outsider = browser(t);
  await signUp(outsider, "bia@example.com");
  const theirs = await seedOrg(outsider);
  const mac = await pairComputer(t, as(owner), { ...RUNNER, exec: true }, { name: "mac" });
  const [walter] = await t.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, "walter@example.com"));
  for (let n = 1; n <= 13; n++) {
    await t.db.insert(schema.machineAccounts).values({
      id: id(n),
      orgId: seeded.orgId,
      machineId: mac.machineId,
      kind: "claude_code",
      label: "Claude",
      plan: "team",
      email: "walter@example.com",
      providerOrgId: "org-acme",
      status: n > 10 ? "signed_out" : "active",
      createdBy: walter?.id ?? "",
      createdAt: new Date(Date.UTC(2026, 10, 1, 12, n)),
    });
  }
  return {
    mac,
    asWalter: as(owner),
    asAda: as(admin),
    asJoao: as(member),
    asBia: as(outsider),
    asBiaOwn: as(outsider, theirs.orgId),
  };
}

const accountsOf = async (res: Response) => {
  expect(res.status).toBe(200);
  return ((await res.json()) as { accounts: Account[] }).accounts;
};
const ordered = async (call: Call) => {
  const res = await call("/ai-accounts/order");
  expect(res.status).toBe(200);
  return ((await res.json()) as { groups: { accounts: Account[] }[] }).groups.flatMap((g) => g.accounts);
};

test("every login of one account carries the oldest's id, for its owner, an admin and a member; only the owner sees its email", async () => {
  const { mac, asWalter, asAda, asJoao } = await workspace();
  const all = Array.from({ length: 13 }, (_, i) => id(i + 1));
  const owners = await accountsOf(await asWalter(`/machines/${mac.machineId}/accounts`));
  expect(owners.map((a) => [a.id, a.sameAs])).toEqual(all.map((a) => [a, id(1)]));
  expect(owners.every((a) => a.email === "walter@example.com" && a.providerOrgId === "org-acme")).toBe(true);

  for (const seen of [
    await accountsOf(await asAda(`/machines/${mac.machineId}/accounts`)),
    await ordered(asAda),
    await ordered(asJoao),
  ]) {
    expect(seen.map((a) => [a.id, a.sameAs])).toEqual(all.map((a) => [a, id(1)]));
    expect(seen.every((a) => a.email === null && a.keyHint === null && a.providerOrgId === null)).toBe(true);
    expect(JSON.stringify(seen)).not.toContain("walter@example.com");
    expect(JSON.stringify(seen)).not.toContain("org-acme");
  }
});

test("a member of another workspace gets none of them, by this workspace's address or by their own", async () => {
  const { mac, asBia, asBiaOwn } = await workspace();
  for (const res of [await asBia(`/machines/${mac.machineId}/accounts`), await asBia("/ai-accounts/order")]) {
    expect(res.status).toBeGreaterThanOrEqual(403);
    expect(res.status).toBeLessThanOrEqual(404);
    expect(await res.text()).not.toContain(id(1));
  }
  const own = await asBiaOwn(`/machines/${mac.machineId}/accounts`);
  expect(own.status).toBe(404);
  expect(await ordered(asBiaOwn)).toEqual([]);
});

test("in the order of use, moving one login of an account signed in once per agent moves the account, all its logins together", async () => {
  const { mac, asWalter } = await workspace();
  const [walter] = await t.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, "walter@example.com"));
  await t.db.insert(schema.machineAccounts).values({
    id: id(50),
    orgId: (await t.db.select().from(schema.machines).where(eq(schema.machines.id, mac.machineId)))[0]?.orgId ?? "",
    machineId: mac.machineId,
    kind: "claude_code",
    label: "Pessoal",
    plan: "max",
    email: "walter.home@example.com",
    status: "active",
    shared: true,
    createdBy: walter?.id ?? "",
    createdAt: new Date(Date.UTC(2026, 10, 1, 13)),
  });
  const team = Array.from({ length: 13 }, (_, i) => id(i + 1));
  // Only a login a run may move to has a place: the thirteen are made for all agents and signed in.
  for (const accountId of team)
    await t.db
      .update(schema.machineAccounts)
      .set({ shared: true, status: "active" })
      .where(eq(schema.machineAccounts.id, accountId));
  const put = async (accountId: string, index: number) => {
    const res = await asWalter(`/ai-accounts/${accountId}/order`, { method: "PUT", json: { index } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { accounts: Account[] }).accounts.map((a) => a.id);
  };
  // The other account first: past all thirteen logins at once, in one step.
  expect(await put(id(50), 0)).toEqual([id(50), ...team]);
  // One login of the thirteen first: every one of them comes along, in their order.
  expect(await put(id(7), 0)).toEqual([...team, id(50)]);
  expect((await ordered(asWalter)).map((a) => a.id)).toEqual([...team, id(50)]);
  // An order where the other account sits among the thirteen: a place counts accounts, the logins come together.
  for (const [i, accountId] of [...team.slice(0, 6), id(50), ...team.slice(6)].entries()) {
    await t.db.update(schema.machineAccounts).set({ useOrder: i }).where(eq(schema.machineAccounts.id, accountId));
  }
  expect(await put(id(50), 1)).toEqual([...team, id(50)]);
  expect(await put(id(50), 0)).toEqual([id(50), ...team]);
});
