import { afterEach, describe, expect, test } from "bun:test";
import { ACCOUNTS_PROTOCOL } from "@agenteschat/adapters";
import { and, eq, schema, sql } from "@agenteschat/db";
import { compareInOrder } from "@agenteschat/providers/plans";
import {
  ACCOUNT_OPENED_JOB,
  accountAudienceAllows,
  accountOrderSql,
  accountRights,
  accountServes,
  accountsServing,
  aiHubView,
  audienceSql,
  createCredential,
  planKeyFallbackOn,
  postPersonMessage,
  replyRefusal,
  setAccountPermissions,
  setAccountServes,
  setPlanKeyFallback,
  widensAccountAudience,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/** One AI accounts module: one rule of who may think with an account, one order of use, and its permissions. */

let f: Fixture;
afterEach(() => {
  const fx: Fixture | undefined = f;
  f = undefined as unknown as Fixture;
  return fx?.close();
});

const WALTERS = "0193abab-0000-4000-8000-0000000000a1";
const ANAS = "0193abab-0000-4000-8000-0000000000a2";
const OWNERS = "0193abab-0000-4000-8000-0000000000a3";

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { code?: string }) => e.code ?? "error",
  );

/** Walter and Ana (members), Carla (an admin) and the workspace's owner, each with a Claude account on one computer. */
async function world() {
  f = await setup();
  const fx = f;
  const { machineId } = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
    name: "MacBook",
    protocol: ACCOUNTS_PROTOCOL,
  });
  const walter = await addMember(fx.db, fx.org.id, "member", "walter");
  const ana = await addMember(fx.db, fx.org.id, "member", "ana");
  const carla = await addMember(fx.db, fx.org.id, "admin", "carla");
  const account = (id: string, createdBy: string, more: Partial<typeof schema.machineAccounts.$inferInsert> = {}) =>
    fx.db.insert(schema.machineAccounts).values({
      id,
      orgId: fx.org.id,
      machineId,
      kind: "claude_code",
      label: `Conta ${id.slice(-2)}`,
      status: "active",
      createdBy,
      shared: true,
      ...more,
    });
  await account(WALTERS, walter.id);
  await account(ANAS, ana.id);
  await account(OWNERS, fx.owner.id);
  const row = async (id: string) => {
    const [r] = await fx.db.select().from(schema.machineAccounts).where(eq(schema.machineAccounts.id, id));
    if (!r) throw new Error("no account");
    return r;
  };
  const deps = { db: fx.db, pubsub: fx.pubsub };
  return { fx, machineId, walter, ana, carla, account, row, deps };
}

describe("the one rule: who may think with an account", () => {
  test("as before: everyone by default, its owner alone under owner-only, nobody once its owner left", async () => {
    const { fx, walter, ana, deps } = await world();
    expect(await accountServes(fx.db, fx.org.id, WALTERS, ana.id)).toBe(true);
    expect(await accountServes(fx.db, fx.org.id, WALTERS, null)).toBe(true);
    await setAccountServes(deps, walter.id, fx.org.id, WALTERS, "owner");
    expect(await accountServes(fx.db, fx.org.id, WALTERS, walter.id)).toBe(true);
    expect(await accountServes(fx.db, fx.org.id, WALTERS, ana.id)).toBe(false);
    expect(await accountServes(fx.db, fx.org.id, WALTERS, null)).toBe(false);
    // Older apps' "Quem usa" is the same permission.
    expect(
      (await fx.db.select().from(schema.machineAccounts).where(eq(schema.machineAccounts.id, WALTERS)))[0],
    ).toMatchObject({
      serves: "owner",
      useMode: "owner",
    });
    await fx.db
      .delete(schema.organizationMembers)
      .where(and(eq(schema.organizationMembers.orgId, fx.org.id), eq(schema.organizationMembers.userId, walter.id)));
    expect(await accountServes(fx.db, fx.org.id, WALTERS, walter.id)).toBe(false);
  });

  test("administrators, roles and people: each audience takes whom it names, its owner always", async () => {
    const { fx, walter, ana, carla, deps } = await world();
    const may = async (person: string | null) =>
      [...(await accountsServing(fx.db, fx.org.id, person, [WALTERS]))].length === 1;
    await setAccountPermissions(deps, walter.id, fx.org.id, WALTERS, {
      use: { mode: "admins", userIds: [], roleIds: [] },
    });
    expect([await may(walter.id), await may(carla.id), await may(fx.owner.id), await may(ana.id)]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    const [role] = await fx.db.insert(schema.orgRoles).values({ orgId: fx.org.id, name: "Design" }).returning();
    if (!role) throw new Error("no role");
    await fx.db.insert(schema.organizationMemberRoles).values({ orgId: fx.org.id, userId: ana.id, roleId: role.id });
    await setAccountPermissions(deps, walter.id, fx.org.id, WALTERS, {
      use: { mode: "roles", userIds: [], roleIds: [role.id] },
    });
    expect([await may(ana.id), await may(carla.id)]).toEqual([true, false]);
    await setAccountPermissions(deps, walter.id, fx.org.id, WALTERS, {
      use: { mode: "people", userIds: [carla.id], roleIds: [] },
    });
    expect([await may(ana.id), await may(carla.id), await may(null)]).toEqual([false, true, false]);
    // The JS twin reads the same.
    const person = { userId: carla.id, roleIds: [], admin: true };
    expect(accountAudienceAllows({ mode: "people", userIds: [carla.id], roleIds: [] }, person)).toBe(true);
    expect(accountAudienceAllows({ mode: "roles", userIds: [], roleIds: [role.id] }, person)).toBe(false);
    expect(accountAudienceAllows({ mode: "admins", userIds: [], roleIds: [] }, person)).toBe(true);
    expect(accountAudienceAllows({ mode: "owner", userIds: [], roleIds: [] }, person)).toBe(false);
  });

  test("fewer people using it moves their agents and their own AI off it", async () => {
    const { fx, walter, ana, deps } = await world();
    const [anaAgent] = await fx.db
      .insert(schema.agents)
      .values({ orgId: fx.org.id, name: "Atlas", handle: "atlas", model: "claude-sonnet-4-5", ownerUserId: ana.id })
      .returning();
    if (!anaAgent) throw new Error("no agent");
    await fx.db
      .update(schema.agents)
      .set({ brain: "claude_code", brainAccountId: WALTERS })
      .where(eq(schema.agents.id, anaAgent.id));
    const result = await setAccountPermissions(deps, walter.id, fx.org.id, WALTERS, {
      use: { mode: "owner", userIds: [], roleIds: [] },
    });
    expect(result.agentIds).toEqual([anaAgent.id]);
    const [after] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, anaAgent.id));
    expect(after?.brainAccountId).toBeNull();
    const audits = await fx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "account.permissions"));
    expect(audits).toHaveLength(1);
  });
});

describe("permissions: who changes what, and who hears about it", () => {
  test("Gerenciar is its owner's; Usar em agentes whoever manages it; Atender todos its owner or an admin", async () => {
    const { fx, walter, ana, carla, deps } = await world();
    const set = (who: string, input: Parameters<typeof setAccountPermissions>[4]) =>
      codeOf(setAccountPermissions(deps, who, fx.org.id, WALTERS, input));
    const everyone = { mode: "everyone", userIds: [], roleIds: [] };
    const owner = { mode: "owner", userIds: [], roleIds: [] };
    expect(await set(carla.id, { manage: everyone })).toBe("account.permission_forbidden");
    expect(await set(ana.id, { use: owner })).toBe("account.permission_forbidden");
    expect(await set(ana.id, { reply: everyone })).toBe("account.permission_forbidden");
    // Carla manages it by default (Você e administradores) and may let everyone be answered on it: Walter hears of it.
    expect(await set(carla.id, { reply: everyone })).toBeNull();
    const jobs = await fx.db.select().from(schema.outbox).where(eq(schema.outbox.kind, ACCOUNT_OPENED_JOB));
    expect(jobs.map((j) => j.payload)).toEqual([
      { accountId: WALTERS, actorId: carla.id, right: "reply", from: owner, to: everyone },
    ]);
    // Narrowing tells nobody; its owner's own changes neither.
    expect(await set(carla.id, { reply: owner })).toBeNull();
    expect(await set(walter.id, { reply: everyone, manage: owner })).toBeNull();
    expect(await fx.db.select().from(schema.outbox).where(eq(schema.outbox.kind, ACCOUNT_OPENED_JOB))).toHaveLength(1);
    // Gerenciar "Só você": Carla no longer manages it, but still chooses whom it answers as an admin.
    expect(await set(carla.id, { use: owner })).toBe("account.permission_forbidden");
    expect(await set(carla.id, { reply: owner })).toBeNull();
    expect(await set(walter.id, { use: { mode: "roles", userIds: [], roleIds: [crypto.randomUUID()] } })).toBe(
      "account.invalid_permission",
    );
  });

  test("the rights each viewer reads, with why an account isn't theirs to use", async () => {
    const { fx, walter, ana, carla, row, deps } = await world();
    await setAccountPermissions(deps, walter.id, fx.org.id, WALTERS, {
      use: { mode: "owner", userIds: [], roleIds: [] },
    });
    const r = await row(WALTERS);
    expect(accountRights(r, { userId: walter.id, roleIds: [], admin: false }, true)).toEqual({
      canManage: true,
      canSetManage: true,
      canUse: true,
      canReplyAll: true,
    });
    expect(accountRights(r, { userId: ana.id, roleIds: [], admin: false }, true)).toEqual({
      canManage: false,
      canSetManage: false,
      canUse: false,
      useReason: "owner_only",
      canReplyAll: false,
    });
    expect(accountRights(r, { userId: carla.id, roleIds: [], admin: true }, true)).toMatchObject({
      canManage: true,
      canSetManage: false,
      canReplyAll: true,
    });
    expect(
      accountRights({ ...r, status: "signed_out" }, { userId: walter.id, roleIds: [], admin: false }, true),
    ).toMatchObject({
      canUse: false,
      useReason: "signed_out",
    });
    expect(accountRights(r, { userId: walter.id, roleIds: [], admin: false }, false)).toMatchObject({
      useReason: "owner_left",
    });
    // The hub lists every account, whoever connected it, with those rights; its email stays its owner's.
    await fx.db
      .update(schema.machineAccounts)
      .set({ email: "walter@example.com" })
      .where(eq(schema.machineAccounts.id, WALTERS));
    const key = await createCredential(fx.db, fx.keyWrapper, fx.owner.id, fx.org.id, {
      provider: "openai",
      label: "Team key",
      apiKey: "sk-proj-test-key-12345678",
    });
    const hub = await aiHubView(fx.db, ana.id, fx.org.id);
    expect(hub.accounts.map((a) => a.id).sort()).toEqual([WALTERS, ANAS, OWNERS].sort());
    const walters = hub.accounts.find((a) => a.id === WALTERS);
    expect(walters).toMatchObject({ email: null, rights: { canUse: false, useReason: "owner_only" } });
    expect(walters?.permissions.use.mode).toBe("owner");
    expect(hub).toMatchObject({ keyFallback: false, canConfigure: false, canManageKeys: false });
    // Every member sees the workspace's keys; their ends and users stay with whoever manages keys.
    expect(hub.keys.find((k) => k.id === key.id)).toMatchObject({ provider: "openai", label: "Team key" });
    expect(hub.keys.every((k) => k.keyHint === "")).toBe(true);
    const owners = await aiHubView(fx.db, fx.owner.id, fx.org.id);
    expect(owners.canManageKeys).toBe(true);
    expect(key.keyHint).not.toBe("");
    expect(owners.keys.find((k) => k.id === key.id)?.keyHint).toBe(key.keyHint);
  });

  test("widening is told apart from narrowing", () => {
    const a = (mode: "owner" | "admins" | "roles" | "people" | "everyone", ids: string[] = []) => ({
      mode,
      userIds: mode === "people" ? ids : [],
      roleIds: mode === "roles" ? ids : [],
    });
    expect(widensAccountAudience(a("owner"), a("everyone"))).toBe(true);
    expect(widensAccountAudience(a("everyone"), a("admins"))).toBe(false);
    expect(widensAccountAudience(a("people", ["x"]), a("people", ["x", "y"]))).toBe(true);
    expect(widensAccountAudience(a("people", ["x", "y"]), a("people", ["x"]))).toBe(false);
    expect(widensAccountAudience(a("admins"), a("admins"))).toBe(false);
    expect(widensAccountAudience(a("admins"), a("owner"))).toBe(false);
  });
});

describe("Atender todos", () => {
  test("someone else's message reaches an agent on a plan only while the account answers them", async () => {
    const { fx, walter, ana, carla, deps } = await world();
    await fx.db
      .update(schema.agents)
      .set({ brain: "claude_code", brainAccountId: WALTERS, ownerUserId: walter.id, audienceMode: "everyone" })
      .where(eq(schema.agents.id, fx.agent.id));
    const reaches = async (userId: string) => {
      const [r] = await fx.db
        .select({ ok: audienceSql("agents", sql`${userId}::text`) })
        .from(schema.agents)
        .where(eq(schema.agents.id, fx.agent.id));
      return r?.ok;
    };
    // New accounts answer only their agents' owners.
    expect([await reaches(walter.id), await reaches(ana.id), await reaches(carla.id)]).toEqual([true, false, false]);
    await setAccountPermissions(deps, walter.id, fx.org.id, WALTERS, {
      reply: { mode: "admins", userIds: [], roleIds: [] },
    });
    expect([await reaches(ana.id), await reaches(carla.id)]).toEqual([false, true]);
    await setAccountPermissions(deps, walter.id, fx.org.id, WALTERS, {
      reply: { mode: "everyone", userIds: [], roleIds: [] },
    });
    expect([await reaches(ana.id), await reaches(carla.id)]).toEqual([true, true]);
    // On the API the account's switch no longer counts.
    await setAccountPermissions(deps, walter.id, fx.org.id, WALTERS, {
      reply: { mode: "owner", userIds: [], roleIds: [] },
    });
    await fx.db.update(schema.agents).set({ brain: "model" }).where(eq(schema.agents.id, fx.agent.id));
    expect(await reaches(ana.id)).toBe(true);
  });

  test("a run for someone else on a plan that answers only the agent's owner is refused at its start", async () => {
    const { fx, walter, deps } = await world();
    const agent = { orgId: fx.org.id, name: "Dev", ownerUserId: walter.id };
    // The workspace's owner asks; the agent is Walter's.
    const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
      body: "x",
    });
    const [run] = await fx.db
      .insert(schema.agentRuns)
      .values({
        orgId: fx.org.id,
        agentId: fx.agent.id,
        channelId: fx.general.id,
        threadRootId: msg.id,
        triggerMessageId: msg.id,
        trigger: "mention",
        hop: 1,
      })
      .returning();
    if (!run) throw new Error("no run");
    expect((await replyRefusal(fx.db, agent, WALTERS, run))?.code).toBe("plan_not_shared");
    expect(await replyRefusal(fx.db, { ...agent, ownerUserId: fx.owner.id }, WALTERS, run)).toBeNull();
    await setAccountPermissions(deps, walter.id, fx.org.id, WALTERS, {
      reply: { mode: "admins", userIds: [], roleIds: [] },
    });
    expect(await replyRefusal(fx.db, agent, WALTERS, run)).toBeNull();
  });
});

describe("the one order of use", () => {
  test("the person's own first, then by place, the unplaced after, oldest first: SQL and its JS twin agree", async () => {
    const { fx, walter } = await world();
    await fx.db.update(schema.machineAccounts).set({ useOrder: 1 }).where(eq(schema.machineAccounts.id, ANAS));
    await fx.db.update(schema.machineAccounts).set({ useOrder: 0 }).where(eq(schema.machineAccounts.id, OWNERS));
    const rows = await fx.db
      .select({
        id: schema.machineAccounts.id,
        ownerId: schema.machineAccounts.createdBy,
        useOrder: schema.machineAccounts.useOrder,
      })
      .from(schema.machineAccounts)
      .where(eq(schema.machineAccounts.orgId, fx.org.id))
      .orderBy(...accountOrderSql(walter.id));
    expect(rows.map((r) => r.id)).toEqual([WALTERS, OWNERS, ANAS]);
    const byAge = [...rows].sort(
      (a, b) => [WALTERS, ANAS, OWNERS].indexOf(a.id) - [WALTERS, ANAS, OWNERS].indexOf(b.id),
    );
    expect(byAge.sort(compareInOrder(walter.id)).map((r) => r.id)).toEqual([WALTERS, OWNERS, ANAS]);
    expect([...byAge].sort(compareInOrder(null)).map((r) => r.id)).toEqual([OWNERS, ANAS, WALTERS]);
  });
});

describe("Continuar com a chave de API", () => {
  test("off by default; admins turn it on, audited", async () => {
    const { fx, ana } = await world();
    expect(await planKeyFallbackOn(fx.db, fx.org.id)).toBe(false);
    expect(await codeOf(setPlanKeyFallback(fx.db, ana.id, fx.org.id, true))).not.toBeNull();
    expect(await setPlanKeyFallback(fx.db, fx.owner.id, fx.org.id, true)).toBe(true);
    expect(await planKeyFallbackOn(fx.db, fx.org.id)).toBe(true);
    const audits = await fx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "ai.key_fallback"));
    expect(audits.map((a) => a.details)).toEqual([{ on: true }]);
  });
});
