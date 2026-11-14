import { afterEach, beforeEach, expect, test } from "bun:test";
import { ROLE_PERMISSIONS } from "@agenteschat/engine";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

type Workspace = { id: string; role: string; permissions: string[]; rank: number | null };
type Role = { id: string; kind: string; name: string; permissions: string[]; editable: boolean; givable: boolean };

const userIdOf = async (b: Browser) => ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;

/** The owner's workspace and Ana, a member invited with no role but the base one. */
async function start() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const ana = await joinByInvitation(t, owner, orgId, "ana@example.com");
  const api = (b: Browser, path: string, init?: Parameters<Browser>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);
  const workspace = async (b: Browser) => (await (await api(b, "")).json()) as Workspace;
  const roles = async (b: Browser) => ((await (await api(b, "/roles")).json()) as { roles: Role[] }).roles;
  return { owner, ana, orgId, ownerId: await userIdOf(owner), anaId: await userIdOf(ana), api, workspace, roles };
}

test("GET /me: an owner may do everything; a member what the base role gives", async () => {
  const { owner, ana, orgId } = await start();
  const here = async (b: Browser) => {
    const { organizations } = (await (await b("/api/app/me")).json()) as { organizations: Workspace[] };
    return organizations.find((o) => o.id === orgId);
  };
  const owners = await here(owner);
  expect(owners).toMatchObject({ role: "owner", rank: null });
  expect([...(owners?.permissions ?? [])].sort()).toEqual(["read", "manage_owners", ...ROLE_PERMISSIONS].sort());
  const members = await here(ana);
  expect(members).toMatchObject({ role: "member", rank: null });
  expect([...(members?.permissions ?? [])].sort()).toEqual([
    "assign_work",
    "create_channels",
    "edit_wiki",
    "own_browsers",
    "own_computers",
    "pair_computers",
    "post",
    "read",
    "talk_to_agents",
    "upload_files",
  ]);
});

test("an owner creates a role and gives it to a member, whose permissions grow; people show who holds it", async () => {
  const { owner, ana, anaId, api, workspace } = await start();
  const created = await api(owner, "/roles", {
    json: { name: "Finance", color: "amber", permissions: ["view_usage", "manage_billing"] },
  });
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  expect((await workspace(ana)).permissions).not.toContain("view_usage");

  const given = await api(owner, `/members/${anaId}/roles`, { method: "PUT", json: { roleIds: [id] } });
  expect(given.status).toBe(200);
  expect(await given.json()).toEqual({ roleIds: [id] });
  const after = await workspace(ana);
  expect(after).toMatchObject({ role: "member", rank: 1 });
  expect(after.permissions).toEqual(expect.arrayContaining(["view_usage", "manage_billing", "post", "read"]));
  // What the role gives, nothing more.
  expect(after.permissions).not.toContain("manage_roles");
  expect(after.permissions).not.toContain("administrator");

  const { people } = (await (await api(owner, "/people")).json()) as {
    people: { userId: string; roleIds: string[] }[];
  };
  expect(people.map((p) => (p.userId === anaId ? ["ana", p.roleIds] : ["owner", p.roleIds]))).toEqual([
    ["owner", []],
    ["ana", [id]],
  ]);
});

test("a member who may not manage roles nor people can't create a role or give one", async () => {
  const { ana, ownerId, api, roles } = await start();
  const refused = await api(ana, "/roles", { json: { name: "Mine", permissions: ["post"] } });
  expect(refused.status).toBe(403);
  const admin = (await roles(ana)).find((r) => r.permissions.includes("administrator"));
  const given = await api(ana, `/members/${ownerId}/roles`, { method: "PUT", json: { roleIds: [admin?.id] } });
  expect(given.status).toBe(403);
  expect((await roles(ana)).map((r) => r.name)).toEqual(["Admin", "everyone"]);
});

test("every member reads the roles; only who stands above a role may change it or give it", async () => {
  const { owner, ana, api, roles } = await start();
  const { id } = (await (
    await api(owner, "/roles", { json: { name: "Support", permissions: ["manage_routines"] } })
  ).json()) as { id: string };
  const asOwner = await roles(owner);
  expect(asOwner.map((r) => [r.kind, r.name])).toEqual([
    ["custom", "Admin"],
    ["custom", "Support"],
    ["everyone", "everyone"],
  ]);
  expect(asOwner.find((r) => r.id === id)).toMatchObject({ permissions: ["manage_routines"], editable: true });
  expect(asOwner.every((r) => r.editable)).toBe(true);
  // The base role is everyone's already: nobody gives it.
  expect(asOwner.map((r) => r.givable)).toEqual([true, true, false]);
  const asAna = await roles(ana);
  expect(asAna.find((r) => r.id === id)).toMatchObject({ name: "Support", editable: false, givable: false });
  expect(asAna.some((r) => r.editable || r.givable)).toBe(false);
});

test("PUT …/permissions/{row}: everyone and the roles in one call, for who manages roles; a row that isn't one is 400", async () => {
  const { owner, ana, anaId, api, workspace, roles } = await start();
  const created = (await (await api(owner, "/roles", { json: { name: "Finance" } })).json()) as { id: string };
  const set = (b: Browser, row: string, json: unknown) => api(b, `/permissions/${row}`, { method: "PUT", json });
  // Ana doesn't manage roles: refused, nothing changes.
  expect((await set(ana, "create_channels", { everyone: 0, roles: [] })).status).toBe(403);
  expect((await workspace(ana)).permissions).toContain("create_channels");
  for (const row of ["administrator", "own_computers", "nope"])
    expect((await set(owner, row, { everyone: 0, roles: [] })).status).toBe(400);
  expect((await set(owner, "computers", { everyone: 5, roles: [] })).status).toBe(400);
  expect((await set(owner, "post", { everyone: 2, roles: [] })).status).toBe(400);

  const saved = await set(owner, "create_channels", { everyone: 0, roles: [{ id: created.id, level: 1 }] });
  expect(saved.status).toBe(200);
  // It answers with the roles, as `GET …/roles` does.
  const after = ((await saved.json()) as { roles: Role[] }).roles;
  expect(after.find((r) => r.id === created.id)?.permissions).toEqual(["create_channels"]);
  expect(after.find((r) => r.kind === "everyone")?.permissions).not.toContain("create_channels");
  expect((await workspace(ana)).permissions).not.toContain("create_channels");
  await api(owner, `/members/${anaId}/roles`, { method: "PUT", json: { roleIds: [created.id] } });
  expect((await workspace(ana)).permissions).toContain("create_channels");
  // The computers' ladder: step 3 is any agent's browser, with their own agents' whole computer below it.
  expect((await set(owner, "computers", { everyone: 0, roles: [{ id: created.id, level: 3 }] })).status).toBe(200);
  expect((await roles(owner)).find((r) => r.id === created.id)?.permissions.sort()).toEqual([
    "control_browsers",
    "create_channels",
  ]);
  expect((await workspace(ana)).permissions).toEqual(expect.arrayContaining(["control_browsers", "own_computers"]));
  expect((await workspace(ana)).permissions).not.toContain("control_computers");
});

test("PUT …/permissions/{row} as someone who manages roles: never their own role or one above, never a key they lack", async () => {
  const { owner, ana, anaId, api, roles } = await start();
  const create = async (json: unknown) => ((await (await api(owner, "/roles", { json })).json()) as { id: string }).id;
  const leads = await create({ name: "Leads", permissions: ["manage_roles", "create_channels"] });
  const devs = await create({ name: "Devs" });
  await api(owner, `/members/${anaId}/roles`, { method: "PUT", json: { roleIds: [leads] } });
  const set = (json: unknown, row = "create_channels") => api(ana, `/permissions/${row}`, { method: "PUT", json });
  // Her own role is above her: listing it at another level is refused, and nothing changes.
  const own = await set({ everyone: 1, roles: [{ id: leads, level: 0 }] });
  expect(own.status).toBe(403);
  expect(await own.json()).toMatchObject({ error: { code: "role.above_you" } });
  // A key she doesn't hold, given or taken away from everyone.
  const lacks = await set({ everyone: 0, roles: [{ id: devs, level: 1 }] }, "view_usage");
  expect(lacks.status).toBe(403);
  expect(await lacks.json()).toMatchObject({ error: { code: "role.grant_forbidden" } });
  // What she holds, on the roles below her: Devs gets it, everyone loses it, her own role keeps it.
  expect((await set({ everyone: 0, roles: [{ id: devs, level: 1 }] })).status).toBe(200);
  const now = await roles(owner);
  expect(now.find((r) => r.id === devs)?.permissions).toEqual(["create_channels"]);
  expect(now.find((r) => r.id === leads)?.permissions.sort()).toEqual(["create_channels", "manage_roles"]);
  expect(now.find((r) => r.kind === "everyone")?.permissions).not.toContain("create_channels");
});

test("GET …/roles carries each role's reach; POST …/roles copies one with `copyFrom`", async () => {
  const { owner, ana, api, roles } = await start();
  const { id } = (await (await api(owner, "/roles", { json: { name: "Support", color: "teal" } })).json()) as {
    id: string;
  };
  const channel = (await (
    await api(owner, "/channels", { json: { name: "support", visibility: "private", audienceRoleIds: [id] } })
  ).json()) as { id: string };
  type Reach = Role & { channelIds: string[]; hiddenChannels: number; agentIds: string[] };
  const support = async (b: Browser) => ((await roles(b)) as Reach[]).find((r) => r.id === id);
  expect(await support(owner)).toMatchObject({ channelIds: [channel.id], hiddenChannels: 0, agentIds: [] });
  // Ana doesn't hold it: the channel is counted for her, never named.
  expect(await support(ana)).toMatchObject({ channelIds: [], hiddenChannels: 1 });
  const everyone = ((await roles(ana)) as Reach[]).find((r) => r.kind === "everyone");
  expect(everyone?.channelIds).toHaveLength(1);

  const copied = await api(owner, "/roles", { json: { name: "Support 2", copyFrom: id } });
  expect(copied.status).toBe(201);
  const copy = ((await roles(owner)) as Reach[]).find((r) => r.name === "Support 2");
  expect(copy).toMatchObject({ color: "teal", channelIds: [channel.id] });
  // Ana can't copy: she doesn't manage roles.
  expect((await api(ana, "/roles", { json: { name: "Mine", copyFrom: id } })).status).toBe(403);
});

test("POST …/roles/{roleId}/members/preview: for who may give the role; nothing to lose answers empty", async () => {
  const { owner, ana, anaId, ownerId, api } = await start();
  const { id } = (await (await api(owner, "/roles", { json: { name: "Support" } })).json()) as { id: string };
  const preview = (b: Browser, userIds: string[]) => api(b, `/roles/${id}/members/preview`, { json: { userIds } });
  const res = await preview(owner, [anaId]);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ mailboxes: [] });
  expect((await preview(ana, [ownerId])).status).toBe(403);
  // Seen and given, with nothing to lose: the role is given.
  const given = await api(owner, `/members/${anaId}/roles`, {
    method: "PUT",
    json: { roleIds: [id], mailLossSeen: [] },
  });
  expect(given.status).toBe(200);
});
