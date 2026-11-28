import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  connectVaultSource,
  createVaultItem,
  deleteVaultItems,
  importVaultCsv,
  listVault,
  setVaultItemsAccess,
  type VaultAccess,
} from "../src";
import { SOURCE_TOKEN, type VaultFixture, vaultSetup } from "./vault-fixtures";

/**
 * Many Vault items at once (ADR 0144): one access for all the chosen ones, or deleting them. Only what the person
 * manages changes; the rest is counted in `kept`, never refused as a whole.
 */

let v: VaultFixture;
afterEach(async () => {
  const current = v;
  v = undefined as unknown as VaultFixture;
  await current?.f.close();
});

const access = (over: Partial<VaultAccess>): VaultAccess => ({
  everyone: false,
  roleIds: [],
  userIds: [],
  allAgents: false,
  agentIds: [],
  ...over,
});

/** A passwords file of `n` team logins, imported by Carla (who manages credentials). */
async function importTeamLogins(n: number) {
  const csv = ["url,username,password", ...Array.from({ length: n }, (_, i) => `https://s${i}.example.com,ops,p-${i}`)];
  await importVaultCsv(v.deps, v.carla.id, v.f.org.id, { csv: csv.join("\n"), scope: "team", dryRun: false });
  return (await listVault(v.deps, v.carla.id, v.f.org.id)).items.filter((i) => i.scope === "team");
}

const seenBy = async (userId: string) => (await listVault(v.deps, userId, v.f.org.id)).items.map((i) => i.title);

describe("one access for many items", () => {
  test("an import shared with everyone, restricted to one role and one agent in one call", async () => {
    v = await vaultSetup();
    const team = await importTeamLogins(3);
    expect(await seenBy(v.dora.id)).toHaveLength(3);

    const restricted = access({ roleIds: [v.supportRoleId], agentIds: [v.dev.id] });
    const ids = team.map((i) => i.id);
    expect(await setVaultItemsAccess(v.deps, v.carla.id, v.f.org.id, ids, restricted)).toEqual({ changed: 3, kept: 0 });
    // Dora is in no role: she no longer sees them. Bruno, in Support, does.
    expect(await seenBy(v.dora.id)).toEqual([]);
    expect(await seenBy(v.bruno.id)).toHaveLength(3);
    const after = (await listVault(v.deps, v.carla.id, v.f.org.id)).items;
    expect(after.every((i) => i.access.everyone === false && i.access.agentIds.join() === v.dev.id)).toBe(true);

    const [audit, ...more] = await v.f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, v.f.org.id), eq(schema.auditLog.action, "vault.items_changed")));
    expect(more).toEqual([]);
    expect(audit?.details).toMatchObject({ fields: ["access"], count: 3 });
    const edits = await v.f.db.select().from(schema.vaultUses).where(eq(schema.vaultUses.action, "edit"));
    expect(edits).toHaveLength(3);
  });

  test("only what the person manages changes: the rest is counted as kept", async () => {
    v = await vaultSetup();
    const [team] = await importTeamLogins(1);
    const mine = await createVaultItem(v.deps, v.bruno.id, v.f.org.id, {
      kind: "key",
      scope: "personal",
      title: "Mine",
      keyName: "BRUNO_KEY",
      secret: "fake-bruno-key-0000",
    });
    const ids = [team?.id ?? "", mine.id, "00000000-0000-4000-8000-000000000000", "not-an-id"];
    // Bruno doesn't manage the team's: only his own item changes, and a personal one takes only the agents.
    expect(
      await setVaultItemsAccess(v.deps, v.bruno.id, v.f.org.id, ids, access({ everyone: true, agentIds: [v.dev.id] })),
    ).toEqual({ changed: 1, kept: 3 });
    const bruno = (await listVault(v.deps, v.bruno.id, v.f.org.id)).items;
    expect(bruno.find((i) => i.id === mine.id)?.access).toEqual(access({ agentIds: [v.dev.id] }));
    expect(bruno.find((i) => i.id === team?.id)?.access.agentIds).toEqual([]);
    // Another workspace's agent is refused, as for one item.
    await expect(
      setVaultItemsAccess(v.deps, v.carla.id, v.f.org.id, [team?.id ?? ""], access({ agentIds: [mine.id] })),
    ).rejects.toMatchObject({ code: "vault.agents_invalid" });
  });

  test("a password manager's item stops following its connection, as one changed alone does", async () => {
    v = await vaultSetup();
    v.source.items = [
      { ref: "item-1", kind: "login", title: "GitHub", websites: [{ url: "https://github.com", match: "exact" }] },
    ];
    await connectVaultSource(v.deps, v.carla.id, v.f.org.id, {
      kind: "fakepass",
      scope: "team",
      input: { token: SOURCE_TOKEN },
    });
    const [external] = await v.f.db.select().from(schema.vaultItems);
    expect(external?.accessFromConnection).toBe(true);
    await setVaultItemsAccess(v.deps, v.carla.id, v.f.org.id, [external?.id ?? ""], access({ userIds: [v.dora.id] }));
    const [row] = await v.f.db.select().from(schema.vaultItems);
    expect(row).toMatchObject({ accessFromConnection: false, audienceEveryone: false, audienceUserIds: [v.dora.id] });
  });
});

describe("deleting many items", () => {
  test("the chosen ones go; a password manager's still there and others' stay, counted as kept", async () => {
    v = await vaultSetup();
    const team = await importTeamLogins(2);
    v.source.items = [
      { ref: "item-1", kind: "login", title: "GitHub", websites: [{ url: "https://github.com", match: "exact" }] },
    ];
    await connectVaultSource(v.deps, v.carla.id, v.f.org.id, {
      kind: "fakepass",
      scope: "team",
      input: { token: SOURCE_TOKEN },
    });
    const external = (await listVault(v.deps, v.carla.id, v.f.org.id)).items.find((i) => i.title === "GitHub");
    const ids = [...team.map((i) => i.id), external?.id ?? ""];

    // Bruno manages none of them.
    expect(await deleteVaultItems(v.deps, v.bruno.id, v.f.org.id, ids)).toEqual({ deleted: 0, kept: 3 });
    expect(await deleteVaultItems(v.deps, v.carla.id, v.f.org.id, ids)).toEqual({ deleted: 2, kept: 1 });
    expect(await seenBy(v.carla.id)).toEqual(["GitHub"]);
    const [audit] = await v.f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, v.f.org.id), eq(schema.auditLog.action, "vault.items_deleted")));
    expect(audit?.details).toMatchObject({ count: 2 });
  });
});
