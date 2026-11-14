import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  AREA_PERMISSIONS,
  acceptInvitation,
  CHANNEL_OVERRIDES_MAX,
  can,
  createAgent,
  createChannel,
  createInvitation,
  createRole,
  deleteRole,
  ForbiddenError,
  getMembership,
  listChannels,
  listRoles,
  openDm,
  PERMISSION_ROWS,
  reorderRoles,
  requirePermission,
  setChannelOverride,
  setMemberRoles,
  setRowHolders,
  updateRole,
} from "../src";
import { addMember, adminRoleId, type Fixture, makeAdmin, setup } from "./fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

const everyoneOf = async () => {
  const { roles } = await listRoles(f.db, f.owner.id, f.org.id);
  const base = roles.find((r) => r.kind === "everyone");
  if (!base) throw new Error("no base role");
  return base;
};

describe("resolving permissions", () => {
  test("a new workspace has its base role and an Admin; the owner may everything", async () => {
    const { roles } = await listRoles(f.db, f.owner.id, f.org.id);
    expect(roles.map((r) => [r.kind, r.name])).toEqual([
      ["custom", "Admin"],
      ["everyone", "everyone"],
    ]);
    // The Admin is listed apart in the members column; the base role never is.
    expect(roles.map((r) => r.hoist)).toEqual([true, false]);
    const owner = await getMembership(f.db, f.owner.id, f.org.id);
    for (const k of [...AREA_PERMISSIONS, "administrator", "manage_owners", "read"] as const)
      expect(can(owner, k)).toBe(true);
  });

  test("a member may what the base role gives, and an admin everything but ownership", async () => {
    const member = await getMembership(f.db, (await addMember(f.db, f.org.id, "member")).id, f.org.id);
    expect(can(member, "post")).toBe(true);
    expect(can(member, "talk_to_agents")).toBe(true);
    expect(can(member, "manage_agents")).toBe(false);
    expect(can(member, "manage_owners")).toBe(false);
    const admin = await getMembership(f.db, (await addMember(f.db, f.org.id, "admin")).id, f.org.id);
    expect(can(admin, "manage_roles")).toBe(true);
    expect(can(admin, "approve_actions")).toBe(true);
    expect(can(admin, "manage_owners")).toBe(false);
    expect(admin?.rank).toBe(0);
  });

  test("roles add up, and changing the base role changes every member", async () => {
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    const finance = await createRole(f.db, f.owner.id, f.org.id, { name: "Finance", permissions: ["view_usage"] });
    const support = await createRole(f.db, f.owner.id, f.org.id, { name: "Support", permissions: ["manage_routines"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, ana.id, [finance.id, support.id]);
    const both = await getMembership(f.db, ana.id, f.org.id);
    expect(can(both, "view_usage") && can(both, "manage_routines")).toBe(true);
    expect(both?.rank).toBe(1);
    const base = await everyoneOf();
    await updateRole(f.db, f.owner.id, f.org.id, base.id, {
      permissions: base.permissions.filter((k) => k !== "talk_to_agents"),
    });
    expect(can(await getMembership(f.db, ana.id, f.org.id), "talk_to_agents")).toBe(false);
  });

  test("the base role never holds administrator", async () => {
    const base = await everyoneOf();
    await updateRole(f.db, f.owner.id, f.org.id, base.id, { permissions: [...base.permissions, "administrator"] });
    expect((await everyoneOf()).permissions).not.toContain("administrator");
  });
});

describe("hierarchy", () => {
  test("someone who manages roles only changes the ones below their own", async () => {
    const lead = await addMember(f.db, f.org.id, "member", "lead");
    const leads = await createRole(f.db, f.owner.id, f.org.id, {
      name: "Leads",
      permissions: ["manage_roles", "manage_members", "view_usage"],
    });
    const devs = await createRole(f.db, f.owner.id, f.org.id, { name: "Devs" });
    await setMemberRoles(f.db, f.owner.id, f.org.id, lead.id, [leads.id]);
    // Their own role and Admin (above) are out of reach; Devs (below) isn't.
    await expect(updateRole(f.db, lead.id, f.org.id, leads.id, { name: "Bosses" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const admin = await adminRoleId(f.db, f.org.id);
    await expect(deleteRole(f.db, lead.id, f.org.id, admin)).rejects.toBeInstanceOf(ForbiddenError);
    await updateRole(f.db, lead.id, f.org.id, devs.id, { name: "Developers" });
    const { roles } = await listRoles(f.db, lead.id, f.org.id);
    expect(roles.find((r) => r.id === devs.id)).toMatchObject({ name: "Developers", editable: true });
    expect(roles.find((r) => r.id === leads.id)?.editable).toBe(false);
  });

  test("nobody gives what they can't do", async () => {
    const lead = await addMember(f.db, f.org.id, "member", "lead");
    const leads = await createRole(f.db, f.owner.id, f.org.id, { name: "Leads", permissions: ["manage_roles"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, lead.id, [leads.id]);
    await expect(
      createRole(f.db, lead.id, f.org.id, { name: "Spenders", permissions: ["view_usage"] }),
    ).rejects.toMatchObject({ code: "role.grant_forbidden" });
    // A key they hold themselves is fine.
    await createRole(f.db, lead.id, f.org.id, { name: "Helpers", permissions: ["post"] });
  });

  test("a stored role with a retired key still loads, grants nothing for it and saves", async () => {
    const support = await createRole(f.db, f.owner.id, f.org.id, { name: "Support", permissions: ["post"] });
    await f.db
      .update(schema.orgRoles)
      .set({ permissions: ["post", "use_others_plans"] })
      .where(eq(schema.orgRoles.id, support.id));
    const admin = await addMember(f.db, f.org.id, "admin", "ada");
    const member = await addMember(f.db, f.org.id, "member", "max");
    await setMemberRoles(f.db, f.owner.id, f.org.id, member.id, [support.id]);
    const { roles } = await listRoles(f.db, admin.id, f.org.id);
    expect(roles.find((r) => r.id === support.id)).toMatchObject({ permissions: ["post"], editable: true });
    const membership = await getMembership(f.db, member.id, f.org.id);
    expect([...(membership?.permissions ?? [])]).not.toContain("use_others_plans");
    await updateRole(f.db, admin.id, f.org.id, support.id, { permissions: ["post", "edit_wiki"] });
    const [saved] = await f.db.select().from(schema.orgRoles).where(eq(schema.orgRoles.id, support.id));
    expect(saved?.permissions.sort()).toEqual(["edit_wiki", "post"]);
  });

  test("roles go only to people below, and only roles below one's own", async () => {
    const lead = await addMember(f.db, f.org.id, "member", "lead");
    const boss = await addMember(f.db, f.org.id, "admin", "boss");
    const dev = await addMember(f.db, f.org.id, "member", "dev");
    const leads = await createRole(f.db, f.owner.id, f.org.id, { name: "Leads", permissions: ["manage_members"] });
    const devs = await createRole(f.db, f.owner.id, f.org.id, { name: "Devs" });
    await setMemberRoles(f.db, f.owner.id, f.org.id, lead.id, [leads.id]);
    await setMemberRoles(f.db, lead.id, f.org.id, dev.id, [devs.id]);
    await expect(setMemberRoles(f.db, lead.id, f.org.id, boss.id, [])).rejects.toBeInstanceOf(ForbiddenError);
    const admin = await adminRoleId(f.db, f.org.id);
    await expect(setMemberRoles(f.db, lead.id, f.org.id, dev.id, [devs.id, admin])).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test("nobody hands themselves a role with keys they don't hold", async () => {
    const lead = await addMember(f.db, f.org.id, "member", "lead");
    const leads = await createRole(f.db, f.owner.id, f.org.id, { name: "Leads", permissions: ["manage_members"] });
    const finance = await createRole(f.db, f.owner.id, f.org.id, { name: "Finance", permissions: ["view_usage"] });
    const helpers = await createRole(f.db, f.owner.id, f.org.id, { name: "Helpers", permissions: ["post"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, lead.id, [leads.id]);
    await expect(setMemberRoles(f.db, lead.id, f.org.id, lead.id, [leads.id, finance.id])).rejects.toMatchObject({
      code: "role.grant_forbidden",
    });
    // A role whose keys they hold is fine, and it shows as one they may give.
    await setMemberRoles(f.db, lead.id, f.org.id, lead.id, [leads.id, helpers.id]);
    const { roles } = await listRoles(f.db, lead.id, f.org.id);
    expect(roles.find((r) => r.id === finance.id)?.givable).toBe(false);
    expect(roles.find((r) => r.id === helpers.id)?.givable).toBe(true);
  });

  test("an owner's roles only owners change", async () => {
    const boss = await addMember(f.db, f.org.id, "admin", "boss");
    await expect(setMemberRoles(f.db, boss.id, f.org.id, f.owner.id, [])).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("the order moves only roles below the actor's own", async () => {
    const lead = await addMember(f.db, f.org.id, "member", "lead");
    const leads = await createRole(f.db, f.owner.id, f.org.id, { name: "Leads", permissions: ["manage_roles"] });
    const a = await createRole(f.db, f.owner.id, f.org.id, { name: "A" });
    const b = await createRole(f.db, f.owner.id, f.org.id, { name: "B" });
    await setMemberRoles(f.db, f.owner.id, f.org.id, lead.id, [leads.id]);
    const admin = await adminRoleId(f.db, f.org.id);
    await reorderRoles(f.db, lead.id, f.org.id, [admin, leads.id, b.id, a.id]);
    await expect(reorderRoles(f.db, lead.id, f.org.id, [leads.id, admin, a.id, b.id])).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const { roles } = await listRoles(f.db, f.owner.id, f.org.id);
    expect(roles.filter((r) => r.kind === "custom").map((r) => r.name)).toEqual(["Admin", "Leads", "B", "A"]);
  });
});

describe("where the keys land", () => {
  test("talking to agents is a key: without it a person can't open a DM with an agent", async () => {
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    const base = await everyoneOf();
    await updateRole(f.db, f.owner.id, f.org.id, base.id, {
      permissions: base.permissions.filter((k) => k !== "talk_to_agents"),
    });
    await expect(openDm(f.db, ana.id, f.org.id, { agentId: f.agent.id })).rejects.toBeInstanceOf(ForbiddenError);
    // The base role back on: they can.
    await updateRole(f.db, f.owner.id, f.org.id, base.id, { permissions: base.permissions });
    expect(await openDm(f.db, ana.id, f.org.id, { agentId: f.agent.id })).toBeTruthy();
  });

  test("invitations carry roles, and only roles below the sender", async () => {
    const devs = await createRole(f.db, f.owner.id, f.org.id, { name: "Devs" });
    const { invitation, token } = await createInvitation(f.db, f.owner.id, f.org.id, {
      email: "new@example.com",
      roleIds: [devs.id],
    });
    expect(invitation.roleIds).toEqual([devs.id]);
    const [user] = await f.db
      .insert(schema.users)
      .values({ id: "user_new", name: "New", email: "new@example.com" })
      .returning();
    if (!user) throw new Error("no user");
    await acceptInvitation(f.db, { id: user.id, email: user.email }, token);
    const held = await f.db
      .select({ roleId: schema.organizationMemberRoles.roleId })
      .from(schema.organizationMemberRoles)
      .where(
        and(eq(schema.organizationMemberRoles.orgId, f.org.id), eq(schema.organizationMemberRoles.userId, user.id)),
      );
    expect(held.map((r) => r.roleId)).toEqual([devs.id]);

    const lead = await addMember(f.db, f.org.id, "member", "lead");
    const leads = await createRole(f.db, f.owner.id, f.org.id, { name: "Leads", permissions: ["invite_people"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, lead.id, [leads.id]);
    await makeAdmin(f.db, f.org.id, f.owner.id);
    const admin = await adminRoleId(f.db, f.org.id);
    await expect(
      createInvitation(f.db, lead.id, f.org.id, { email: "x@example.com", roleIds: [admin] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("creating agents makes your own: someone else, or nobody, as its owner takes editing any agent", async () => {
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    const makers = await createRole(f.db, f.owner.id, f.org.id, { name: "Makers", permissions: ["create_agents"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, ana.id, [makers.id]);
    const make = (handle: string, owner?: { ownerUserId: string | null }) =>
      createAgent(f.db, ana.id, f.org.id, { name: handle, handle, ...owner }, { model: "claude-haiku-5-5" });
    for (const ownerUserId of [f.owner.id, null]) {
      await expect(make("iris", { ownerUserId })).rejects.toBeInstanceOf(ForbiddenError);
    }
    // Refused before anything is made: the @ stays free.
    const iris = await f.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.handle, "iris")));
    expect(iris).toEqual([]);
    expect((await make("iris", { ownerUserId: ana.id })).ownerUserId).toBe(ana.id);
    expect((await make("lia")).ownerUserId).toBe(ana.id);
    const leads = await createRole(f.db, f.owner.id, f.org.id, {
      name: "Leads",
      permissions: ["create_agents", "manage_agents"],
    });
    await setMemberRoles(f.db, f.owner.id, f.org.id, ana.id, [leads.id]);
    expect((await make("otto", { ownerUserId: f.owner.id })).ownerUserId).toBe(f.owner.id);
    expect((await make("dora", { ownerUserId: null })).ownerUserId).toBeNull();
  });

  test("approving actions follows the key, not a role's name", async () => {
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    await expect(requirePermission(f.db, ana.id, f.org.id, "approve_actions")).rejects.toBeInstanceOf(ForbiddenError);
    const approvers = await createRole(f.db, f.owner.id, f.org.id, {
      name: "Approvers",
      permissions: ["approve_actions"],
    });
    await setMemberRoles(f.db, f.owner.id, f.org.id, ana.id, [approvers.id]);
    await requirePermission(f.db, ana.id, f.org.id, "approve_actions");
  });
});

describe("who holds a row, Todos and the roles in one call (ADR 0085 addendum of 2026-11-13)", () => {
  const roleOf = async (id: string) => (await listRoles(f.db, f.owner.id, f.org.id)).roles.find((r) => r.id === id);
  const audit = () =>
    f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "role.permission_set")));

  test("turning off what everyone has keeps it for the ticked roles; every other role it may change loses it", async () => {
    const admin = await adminRoleId(f.db, f.org.id);
    const finance = await createRole(f.db, f.owner.id, f.org.id, { name: "Financeiro" });
    const support = await createRole(f.db, f.owner.id, f.org.id, {
      name: "Suporte",
      permissions: ["create_channels", "post"],
    });
    const carla = await addMember(f.db, f.org.id, "member", "carla");
    const davi = await addMember(f.db, f.org.id, "member", "davi");
    await setMemberRoles(f.db, f.owner.id, f.org.id, carla.id, [finance.id]);
    await setMemberRoles(f.db, f.owner.id, f.org.id, davi.id, [support.id]);
    const { before, after } = await setRowHolders(f.db, f.owner.id, f.org.id, "create_channels", {
      everyone: 0,
      roles: [{ id: finance.id, level: 1 }],
    });
    expect(before).toEqual({ everyone: 1, roles: { [admin]: 0, [finance.id]: 0, [support.id]: 1 } });
    expect(after).toEqual({ everyone: 0, roles: { [admin]: 0, [finance.id]: 1, [support.id]: 0 } });
    expect((await everyoneOf()).permissions).not.toContain("create_channels");
    expect((await roleOf(finance.id))?.permissions).toEqual(["create_channels"]);
    // Only the row moved: Suporte keeps what else it had.
    expect((await roleOf(support.id))?.permissions).toEqual(["post"]);
    expect(can(await getMembership(f.db, carla.id, f.org.id), "create_channels")).toBe(true);
    expect(can(await getMembership(f.db, davi.id, f.org.id), "create_channels")).toBe(false);
    // Administrador is never written: it may everything anyway, and its own keys come back when it goes off.
    expect((await roleOf(admin))?.permissions).toEqual(["administrator"]);
    const [row] = await audit();
    expect(row).toMatchObject({ actorId: f.owner.id, targetType: "organization", targetId: f.org.id });
    expect(row?.details).toEqual({
      row: "create_channels",
      everyone: [1, 0],
      roles: [
        { id: finance.id, name: "Financeiro", before: 0, after: 1 },
        { id: support.id, name: "Suporte", before: 1, after: 0 },
      ],
    });
    // The same call again changes nothing and records nothing.
    await setRowHolders(f.db, f.owner.id, f.org.id, "create_channels", {
      everyone: 0,
      roles: [{ id: finance.id, level: 1 }],
    });
    expect(await audit()).toHaveLength(1);
  });

  test("only who manages roles, never above their own rank, and only keys they hold", async () => {
    const lead = await addMember(f.db, f.org.id, "member", "lead");
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    const leads = await createRole(f.db, f.owner.id, f.org.id, {
      name: "Leads",
      permissions: ["manage_roles", "create_channels"],
    });
    const devs = await createRole(f.db, f.owner.id, f.org.id, { name: "Devs" });
    await setMemberRoles(f.db, f.owner.id, f.org.id, lead.id, [leads.id]);
    // A member without manage_roles changes nothing.
    await expect(
      setRowHolders(f.db, ana.id, f.org.id, "create_channels", { everyone: 0, roles: [] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Their own role is above them: listing it at another level is refused, whole. Admin, above too, may
    // everything: it is never written, whatever is sent.
    await expect(
      setRowHolders(f.db, lead.id, f.org.id, "post", { everyone: 0, roles: [{ id: leads.id, level: 1 }] }),
    ).rejects.toMatchObject({ code: "role.above_you" });
    expect((await everyoneOf()).permissions).toContain("post");
    const admin = await adminRoleId(f.db, f.org.id);
    await setRowHolders(f.db, lead.id, f.org.id, "post", { everyone: 1, roles: [{ id: admin, level: 1 }] });
    expect((await roleOf(admin))?.permissions).toEqual(["administrator"]);
    // A key they don't hold, given or taken, is refused (`view_usage`), on Todos as on a role below.
    await expect(
      setRowHolders(f.db, lead.id, f.org.id, "view_usage", { everyone: 0, roles: [{ id: devs.id, level: 1 }] }),
    ).rejects.toMatchObject({ code: "role.grant_forbidden" });
    await expect(
      setRowHolders(f.db, lead.id, f.org.id, "view_usage", { everyone: 1, roles: [] }),
    ).rejects.toMatchObject({ code: "role.grant_forbidden" });
    // What they hold: Todos loses it, Devs gets it, and their own role (above them) keeps it untouched.
    await setRowHolders(f.db, lead.id, f.org.id, "create_channels", {
      everyone: 0,
      roles: [{ id: devs.id, level: 1 }],
    });
    expect((await roleOf(devs.id))?.permissions).toEqual(["create_channels"]);
    expect((await roleOf(leads.id))?.permissions.sort()).toEqual(["create_channels", "manage_roles"]);
    expect((await everyoneOf()).permissions).not.toContain("create_channels");
    expect(await audit()).toHaveLength(1);
  });

  test("a row is a key or the computers, never administrator; levels and roles are checked first", async () => {
    expect(PERMISSION_ROWS).toContain("computers");
    expect(PERMISSION_ROWS).not.toContain("administrator");
    for (const key of ["own_browsers", "own_computers", "control_browsers", "control_computers"])
      expect(PERMISSION_ROWS).not.toContain(key);
    const devs = await createRole(f.db, f.owner.id, f.org.id, { name: "Devs" });
    const set = (row: string, next: Parameters<typeof setRowHolders>[4]) =>
      setRowHolders(f.db, f.owner.id, f.org.id, row, next);
    for (const row of ["administrator", "own_computers", "nope"])
      await expect(set(row, { everyone: 0, roles: [] })).rejects.toMatchObject({ code: "role.row_unknown" });
    await expect(set("post", { everyone: 2, roles: [] })).rejects.toMatchObject({ code: "role.level_invalid" });
    await expect(set("computers", { everyone: 5, roles: [] })).rejects.toMatchObject({ code: "role.level_invalid" });
    // `everyone` goes in `everyone`, and a role gone is refused before anything changes.
    const base = await everyoneOf();
    for (const id of [base.id, crypto.randomUUID()])
      await expect(
        set("post", {
          everyone: 0,
          roles: [
            { id: devs.id, level: 1 },
            { id, level: 1 },
          ],
        }),
      ).rejects.toMatchObject({ code: "role.unknown" });
    expect((await everyoneOf()).permissions).toContain("post");
    expect(await audit()).toEqual([]);
  });

  test("the computers are one ladder: lowering everyone raises the ticked roles to the step it had", async () => {
    const support = await createRole(f.db, f.owner.id, f.org.id, { name: "Suporte" });
    const ops = await createRole(f.db, f.owner.id, f.org.id, { name: "Ops", permissions: ["control_computers"] });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, [support.id]);
    // A new workspace's Todos is on step 2, their own agents' whole computer.
    const { before } = await setRowHolders(f.db, f.owner.id, f.org.id, "computers", {
      everyone: 1,
      roles: [
        { id: support.id, level: 2 },
        { id: ops.id, level: 4 },
      ],
    });
    expect(before).toMatchObject({ everyone: 2, roles: { [support.id]: 0, [ops.id]: 4 } });
    const base = await everyoneOf();
    expect(base.permissions).toContain("own_browsers");
    expect(base.permissions).not.toContain("own_computers");
    expect((await roleOf(support.id))?.permissions).toEqual(["own_computers"]);
    expect((await roleOf(ops.id))?.permissions).toEqual(["control_computers"]);
    expect(can(await getMembership(f.db, bia.id, f.org.id), "own_computers")).toBe(true);
    // Step 3, any agent's browser, holds one key and gives every step below it.
    await setRowHolders(f.db, f.owner.id, f.org.id, "computers", {
      everyone: 1,
      roles: [{ id: support.id, level: 3 }],
    });
    expect((await roleOf(support.id))?.permissions).toEqual(["control_browsers"]);
    const now = await getMembership(f.db, bia.id, f.org.id);
    expect(["control_browsers", "own_computers", "own_browsers"].every((k) => can(now, k as never))).toBe(true);
    expect(can(now, "control_computers")).toBe(false);
    // Ops wasn't listed: it lost its step.
    expect((await roleOf(ops.id))?.permissions).toEqual([]);
  });

  test("every agent's browser also gives their own agents' whole computer (the ladder's one new line)", async () => {
    const base = await everyoneOf();
    await updateRole(f.db, f.owner.id, f.org.id, base.id, {
      permissions: base.permissions.filter((k) => k !== "own_computers"),
    });
    const browsers = await createRole(f.db, f.owner.id, f.org.id, {
      name: "Navegadores",
      permissions: ["control_browsers"],
    });
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    expect(can(await getMembership(f.db, caio.id, f.org.id), "own_computers")).toBe(false);
    await setMemberRoles(f.db, f.owner.id, f.org.id, caio.id, [browsers.id]);
    const theirs = await getMembership(f.db, caio.id, f.org.id);
    expect(can(theirs, "own_computers")).toBe(true);
    expect(can(theirs, "control_computers")).toBe(false);
  });
});

describe("what a role reaches, on the read", () => {
  test("its channels the reader sees, the ones they don't counted, and the agents it talks to", async () => {
    const support = await createRole(f.db, f.owner.id, f.org.id, { name: "Suporte" });
    const finance = await createRole(f.db, f.owner.id, f.org.id, { name: "Financeiro" });
    const room = await createChannel(f.db, f.owner.id, f.org.id, {
      name: "suporte",
      visibility: "private",
      audienceRoleIds: [support.id],
    });
    const closed = await createChannel(f.db, f.owner.id, f.org.id, {
      name: "diretoria",
      visibility: "private",
      audienceRoleIds: [finance.id, support.id],
    });
    await createChannel(f.db, f.owner.id, f.org.id, { name: "segredo", visibility: "private" });
    await f.db
      .update(schema.agents)
      .set({ audienceMode: "people", audienceRoleIds: [support.id] })
      .where(eq(schema.agents.id, f.agent.id));
    const lia = await addMember(f.db, f.org.id, "member", "lia");
    await setMemberRoles(f.db, f.owner.id, f.org.id, lia.id, [support.id]);
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    const of = async (userId: string, id: string) =>
      (await listRoles(f.db, userId, f.org.id)).roles.find((r) => r.id === id);
    const both = [closed.id, room.id].sort();
    // The owner sees every channel.
    const owners = await of(f.owner.id, support.id);
    expect(owners).toMatchObject({ hiddenChannels: 0, agentIds: [f.agent.id] });
    expect([...(owners?.channelIds ?? [])].sort()).toEqual(both);
    // Lia holds Suporte: she sees both. Caio holds nothing: they're counted for him, never named.
    expect([...((await of(lia.id, support.id))?.channelIds ?? [])].sort()).toEqual(both);
    expect(await of(caio.id, support.id)).toMatchObject({ channelIds: [], hiddenChannels: 2, agentIds: [f.agent.id] });
    expect(await of(caio.id, finance.id)).toMatchObject({ channelIds: [], hiddenChannels: 1, agentIds: [] });
    // Todos: every public channel, and the agents that answer everyone (none now).
    const base = (await listRoles(f.db, caio.id, f.org.id)).roles.find((r) => r.kind === "everyone");
    expect(base).toMatchObject({ channelIds: [f.general.id], hiddenChannels: 0, agentIds: [] });
    // An agent archived drops out.
    await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, f.agent.id));
    expect((await of(caio.id, support.id))?.agentIds).toEqual([]);
  });

  test("the right hand is everyone's: never counted among Todos' agents", async () => {
    await f.close();
    f = await setup({ rightHand: true });
    const base = (await listRoles(f.db, f.owner.id, f.org.id)).roles.find((r) => r.kind === "everyone");
    expect(base?.agentIds).toEqual([f.agent.id]);
  });
});

describe("Duplicar copies the role's reach", () => {
  test("the copy joins its channels and agents, and nobody reaches anything new until someone gets it", async () => {
    const support = await createRole(f.db, f.owner.id, f.org.id, {
      name: "Suporte",
      color: "teal",
      icon: "flag",
      permissions: ["manage_routines"],
      hoist: true,
    });
    const room = await createChannel(f.db, f.owner.id, f.org.id, {
      name: "suporte",
      visibility: "private",
      audienceRoleIds: [support.id],
    });
    await f.db
      .update(schema.agents)
      .set({ audienceMode: "people", audienceRoleIds: [support.id] })
      .where(eq(schema.agents.id, f.agent.id));
    const copy = await createRole(f.db, f.owner.id, f.org.id, { name: "Suporte 2", copyFrom: support.id });
    expect(copy).toMatchObject({ color: "teal", icon: "flag", permissions: ["manage_routines"], hoist: true });
    const view = (await listRoles(f.db, f.owner.id, f.org.id)).roles.find((r) => r.id === copy.id);
    expect(view).toMatchObject({ channelIds: [room.id], agentIds: [f.agent.id] });
    const [created] = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "role.created"), eq(schema.auditLog.targetId, copy.id)));
    expect(created?.details).toMatchObject({
      copiedFrom: { id: support.id, name: "Suporte" },
      channelIds: [room.id],
      agentIds: [f.agent.id],
    });
    const lia = await addMember(f.db, f.org.id, "member", "lia");
    expect((await listChannels(f.db, lia.id, f.org.id)).map((c) => c.name)).not.toContain("suporte");
    await setMemberRoles(f.db, f.owner.id, f.org.id, lia.id, [copy.id]);
    expect((await listChannels(f.db, lia.id, f.org.id)).map((c) => c.name)).toContain("suporte");
    // What the body says wins over the source.
    const other = await createRole(f.db, f.owner.id, f.org.id, { name: "Outro", color: "rose", copyFrom: support.id });
    expect(other).toMatchObject({ color: "rose", icon: "flag" });
  });

  test("the copy keeps the source's channel exceptions, and stays out of a channel with no room for one more", async () => {
    const leads = await createRole(f.db, f.owner.id, f.org.id, {
      name: "Leads",
      permissions: ["manage_roles", "manage_members"],
    });
    const support = await createRole(f.db, f.owner.id, f.org.id, { name: "Suporte" });
    const lead = await addMember(f.db, f.org.id, "member", "lead");
    const mia = await addMember(f.db, f.org.id, "member", "mia");
    const pia = await addMember(f.db, f.org.id, "member", "pia");
    await setMemberRoles(f.db, f.owner.id, f.org.id, lead.id, [leads.id]);
    await setMemberRoles(f.db, f.owner.id, f.org.id, mia.id, [support.id]);
    const limited = (name: string) =>
      createChannel(f.db, f.owner.id, f.org.id, { name, visibility: "private", audienceRoleIds: [support.id] });
    const avisos = await limited("avisos");
    const cheio = await limited("cheio");
    // Suporte reads both and never writes there.
    for (const c of [avisos, cheio])
      await setChannelOverride(f.db, f.owner.id, f.org.id, c.id, {
        target: { type: "role", id: support.id },
        allow: [],
        deny: ["post"],
      });
    // #cheio holds as many exceptions as a channel may.
    const extra = Array.from({ length: CHANNEL_OVERRIDES_MAX - 1 }, (_, i) => ({
      id: `user_extra_${i}`,
      name: `Extra ${i}`,
      email: `extra-${i}@example.com`,
      locale: "pt-BR",
    }));
    await f.db.insert(schema.users).values(extra);
    await f.db
      .insert(schema.organizationMembers)
      .values(extra.map((p) => ({ orgId: f.org.id, userId: p.id, role: "member" as const })));
    await f.db
      .insert(schema.channelPermissionOverrides)
      .values(extra.map((p) => ({ orgId: f.org.id, channelId: cheio.id, userId: p.id, deny: ["post"] })));
    // A lead who doesn't manage these channels duplicates Suporte and gives the copy to Pia.
    const copy = await createRole(f.db, lead.id, f.org.id, { name: "Suporte 2", copyFrom: support.id });
    await setMemberRoles(f.db, lead.id, f.org.id, pia.id, [copy.id]);
    const seen = async (userId: string, channelId: string) =>
      (await listChannels(f.db, userId, f.org.id)).find((c) => c.id === channelId);
    expect((await seen(mia.id, avisos.id))?.can.post).toBe(false);
    expect((await seen(pia.id, avisos.id))?.can.post).toBe(false);
    expect(await seen(mia.id, cheio.id)).toBeDefined();
    expect(await seen(pia.id, cheio.id)).toBeUndefined();
    const [created] = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "role.created"), eq(schema.auditLog.targetId, copy.id)));
    expect(created?.details).toMatchObject({
      channelIds: [avisos.id],
      exceptions: [{ channelId: avisos.id, allow: [], deny: ["post"] }],
    });
  });

  test("only a role below the actor whose keys they all hold", async () => {
    const lead = await addMember(f.db, f.org.id, "member", "lead");
    const leads = await createRole(f.db, f.owner.id, f.org.id, {
      name: "Leads",
      permissions: ["manage_roles", "post"],
    });
    const spenders = await createRole(f.db, f.owner.id, f.org.id, { name: "Gastos", permissions: ["view_usage"] });
    const helpers = await createRole(f.db, f.owner.id, f.org.id, { name: "Ajuda", permissions: ["post"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, lead.id, [leads.id]);
    const copy = (copyFrom: string) => createRole(f.db, lead.id, f.org.id, { name: "Cópia", copyFrom });
    await expect(copy(leads.id)).rejects.toMatchObject({ code: "role.above_you" });
    await expect(copy(spenders.id)).rejects.toMatchObject({ code: "role.grant_forbidden" });
    const base = await everyoneOf();
    for (const id of [base.id, crypto.randomUUID()])
      await expect(copy(id)).rejects.toMatchObject({ code: "role.unknown" });
    expect((await copy(helpers.id)).permissions).toEqual(["post"]);
  });
});
