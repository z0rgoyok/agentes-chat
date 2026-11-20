import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import { listMachineAccounts } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/** One account signed in once per agent is many logins: `sameAs` names it the same for each, whoever looks. */

let f: Fixture;
afterEach(() => {
  const fx: Fixture | undefined = f;
  f = undefined as unknown as Fixture;
  return fx?.close();
});

const id = (n: number) => `0193eeee-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function world() {
  f = await setup();
  const fx = f;
  const deps = { db: fx.db, pubsub: fx.pubsub, publicUrl: "https://agentes.chat" };
  const { machineId } = await pairMachine(deps, fx.owner.id, fx.org.id, {
    name: "MacBook",
    hostname: "mac",
    os: "darwin",
    arch: "arm64",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/Users/w/agentes",
    exec: true,
  });
  const walter = await addMember(fx.db, fx.org.id, "member", "walter");
  const member = await addMember(fx.db, fx.org.id, "member", "bia");
  const at = Date.parse("2026-11-01T10:00:00Z");
  const login = (n: number, createdBy: string, more: Partial<typeof schema.machineAccounts.$inferInsert> = {}) =>
    fx.db.insert(schema.machineAccounts).values({
      id: id(n),
      orgId: fx.org.id,
      machineId,
      kind: "claude_code",
      label: "Claude",
      plan: "team",
      status: "active",
      createdBy,
      createdAt: new Date(at + n * 1000),
      ...more,
    });
  return { fx, machineId, walter, member, login };
}

test("thirteen logins of one account share one id for its owner, an admin and a member; nothing else of it leaks", async () => {
  const { fx, machineId, walter, member, login } = await world();
  for (let n = 1; n <= 13; n++) {
    await login(n, walter.id, {
      email: n === 5 ? "Walter@Example.com" : "walter@example.com",
      providerOrgId: "org-acme",
      status: n > 10 ? "signed_out" : "active",
    });
  }
  // The same email in another of Claude's organizations is another account; so is another email, or none known.
  await login(20, walter.id, { email: "walter@example.com", providerOrgId: "org-other" });
  await login(21, walter.id, { email: "walter.home@example.com" });
  await login(22, walter.id, {});
  // Another person's login of the same email is theirs.
  await login(23, fx.owner.id, { email: "walter@example.com" });
  // Key accounts: the same key's end is one account; another end, another.
  await login(30, walter.id, { provider: "zai", keyHint: "Ab12", plan: null });
  await login(31, walter.id, { provider: "zai", keyHint: "Ab12", plan: null });
  await login(32, walter.id, { provider: "zai", keyHint: "Zz99", plan: null });

  const expected = (n: number) => id(n <= 13 ? 1 : n === 31 ? 30 : n);
  for (const viewer of [walter.id, fx.owner.id, member.id]) {
    const views = await listMachineAccounts({ db: fx.db }, fx.org.id, machineId, viewer);
    expect(views.map((v) => [v.id, v.sameAs])).toEqual(
      [...Array.from({ length: 13 }, (_, i) => i + 1), 20, 21, 22, 23, 30, 31, 32].map((n) => [id(n), expected(n)]),
    );
    for (const v of views.filter((a) => !a.mine)) {
      expect([v.email, v.keyHint, v.providerOrgId]).toEqual([null, null, null]);
    }
  }
  const owners = await listMachineAccounts({ db: fx.db }, fx.org.id, machineId, walter.id);
  expect(owners.find((v) => v.id === id(5))?.email).toBe("Walter@Example.com");
});

test("a login nothing tells apart, or whose oldest login was removed, names itself or the oldest still listed", async () => {
  const { fx, machineId, walter, login } = await world();
  await login(1, walter.id, { email: "walter@example.com", status: "removing" });
  await login(2, walter.id, { email: "walter@example.com" });
  await login(3, walter.id, { email: "walter@example.com" });
  await login(4, walter.id, {});
  const views = await listMachineAccounts({ db: fx.db }, fx.org.id, machineId, fx.owner.id);
  expect(views.map((v) => [v.id, v.sameAs])).toEqual([
    [id(2), id(2)],
    [id(3), id(2)],
    [id(4), id(4)],
  ]);
});

test("one account signed in by the CLI and by a setup token is one; two accounts of one person on one plan stay two", async () => {
  const { fx, machineId, walter, member, login } = await world();
  await login(1, walter.id, { email: "walter@example.com", authMethod: "cli_login", status: "signed_out" });
  await login(2, walter.id, { email: "walter@example.com", authMethod: "setup_token", shared: true });
  await login(3, walter.id, { email: "walter.ops@example.com", authMethod: "cli_login" });
  const views = await listMachineAccounts({ db: fx.db }, fx.org.id, machineId, member.id);
  expect(views.map((v) => [v.id, v.sameAs])).toEqual([
    [id(1), id(1)],
    [id(2), id(1)],
    [id(3), id(3)],
  ]);
});
