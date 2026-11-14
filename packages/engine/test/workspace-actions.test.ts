import { afterEach, describe, expect, test } from "bun:test";
import { channelTopic } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  actionsFor,
  addChannelMember,
  archiveChannel,
  askWorkspaceAction,
  createChannel,
  createCredential,
  createInvitation,
  createJobHandlers,
  createRole,
  createRoutine,
  createScheduleToolSource,
  createSetupToolSource,
  createToolGateway,
  createWikiToolSource,
  decideWorkspaceAction,
  deleteRole,
  drainOutbox,
  getOrgSettings,
  getWorkspaceActionCard,
  insertMessage,
  linkRunActions,
  MAX_ACTIONS_PER_RUN,
  makeDefaultCredential,
  memberRoleIds,
  noticePrefsView,
  OFFER_INVITES_TOOL,
  openPersonAgentDm,
  PROPOSE_MEMBER_CHANGES_TOOL,
  postPersonMessage,
  RIGHT_HAND,
  setMemberRoles,
  setMyStatus,
  setRowHolders,
  suggestPerson,
  type ToolContext,
  type ToolSource,
  undoAgentAction,
  undoMessageActions,
  updateAgent,
  updateRole,
  WORKSPACE_ACTION_TOOL,
  type WorkspaceActionCard,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { giveMail, gmailAccount, mailSetup } from "./mail-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const lodiOf = async (fx: Fixture) => {
  const [lodi] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

/** A run of Lodi on what `userId` wrote in their DM with it; `outside`: their message relays outside content. */
async function lodiRun(fx: Fixture, userId: string, body: string, outside = false): Promise<ToolContext> {
  const lodi = await lodiOf(fx);
  const dm = await openPersonAgentDm(fx.db, fx.org.id, userId, lodi.id);
  const trigger = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, userId, fx.org.id, dm.id, { body });
  if (outside)
    await fx.db
      .update(schema.messages)
      .set({ meta: { readOutside: true } })
      .where(eq(schema.messages.id, trigger.id));
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  if (!run) throw new Error("no run");
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: lodi.id,
    runId: run.id,
    channelId: dm.id,
    threadRootId: run.threadRootId,
    triggerMessageId: trigger.id,
  };
}

const SERVER = { publicUrl: "https://agentes.test" };
const gatewayOf = (fx: Fixture) =>
  createToolGateway({ sources: [createSetupToolSource({ pubsub: fx.pubsub, server: SERVER })] });
async function act(fx: Fixture, ctx: ToolContext, input: Record<string, unknown>) {
  const res = await gatewayOf(fx).invoke(ctx, {
    toolUseId: `tu_${crypto.randomUUID()}`,
    name: WORKSPACE_ACTION_TOOL,
    input,
  });
  if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
  return res.output;
}

/** Lodi's reply to the run, carrying its receipts. */
async function reply(fx: Fixture, ctx: ToolContext) {
  const message = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: ctx.channelId,
    author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: 0 },
    body: "Pronto.",
  });
  await linkRunActions(fx.db, fx.org.id, ctx.runId, message.id);
  return message.id;
}

async function lastCard(fx: Fixture) {
  const rows = await fx.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.orgId, fx.org.id))
    .orderBy(schema.messages.createdAt);
  const m = rows
    .filter((r) => (r.meta.actionCard as { kind?: string } | undefined)?.kind === "workspace_action")
    .at(-1);
  return m ? { id: m.id, card: m.meta.actionCard as WorkspaceActionCard } : null;
}

const roleNamed = async (fx: Fixture, name: string) =>
  (
    await fx.db
      .select()
      .from(schema.orgRoles)
      .where(and(eq(schema.orgRoles.orgId, fx.org.id), eq(schema.orgRoles.name, name)))
  )[0] ?? null;

/** What "no merge or deploy" means: everything a marketing person needs, but not deciding agents' approvals. */
const MARKETING = {
  name: "Marketing",
  color: "rose",
  permissions: ["talk_to_agents", "assign_work", "manage_routines", "edit_wiki", "upload_files"],
};

describe("roles through the right hand", () => {
  test("the owner's marketing role, made and given at once; Desfazer tudo takes both back", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    const ctx = await lodiRun(f, f.owner.id, "cria um cargo de marketing pra Bia, sem merge nem deploy");
    const found = await act(f, ctx, { find: "create a role with permissions" });
    expect(found.content).toContain("create_role");
    expect(found.content).toContain("They may: it applies at once with Undo.");
    const made = await act(f, ctx, { action: "create_role", input: MARKETING, why: "Cargo da Bia" });
    expect(made.content).toContain("Done at once");
    const given = await act(f, ctx, {
      action: "set_member_roles",
      input: { person: "Bia Teste", add_roles: ["marketing"] },
    });
    expect(given.content).toContain("Done at once");
    const role = await roleNamed(f, "Marketing");
    expect(role).toMatchObject({ color: "rose", kind: "custom" });
    expect([...(role?.permissions ?? [])].sort()).toEqual([...MARKETING.permissions].sort());
    expect(role?.permissions).not.toContain("approve_actions");
    expect(await memberRoleIds(f.db, f.org.id, bia.id)).toEqual([role?.id ?? ""]);
    // No card: both were the owner's to decide, in their own words.
    expect(await lastCard(f)).toBeNull();

    const messageId = await reply(f, ctx);
    const receipts = (await actionsFor(f.db, f.org.id, [messageId])).get(messageId) ?? [];
    expect(receipts.map((r) => [r.kind, r.params.action, r.requestedByUserId])).toEqual([
      ["workspace.changed", "create_role", f.owner.id],
      ["workspace.changed", "set_member_roles", f.owner.id],
    ]);
    expect(receipts[1]?.params).toMatchObject({ name: "Bia Teste", change: "+ Marketing" });
    const undone = await undoMessageActions({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, messageId);
    expect(undone.failed).toEqual([]);
    expect(await memberRoleIds(f.db, f.org.id, bia.id)).toEqual([]);
    expect(await roleNamed(f, "Marketing")).toBeNull();
  });

  test("a member who can't manage roles gets a card for an admin, never the role; sent, an admin applies it", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    const admin = await addMember(f.db, f.org.id, "admin", "Caio Admin");
    const ctx = await lodiRun(f, bia.id, "cria um cargo de marketing pra mim");
    const out = await act(f, ctx, { action: "create_role", input: MARKETING, why: "Cargo de marketing" });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("They can't make this change");
    expect(await roleNamed(f, "Marketing")).toBeNull();
    const posted = await lastCard(f);
    expect(posted?.card).toMatchObject({
      kind: "workspace_action",
      forUserId: bia.id,
      state: "pending",
      params: { action: "create_role", needs: "manage_roles", words: { name: "Marketing" } },
    });
    if (!posted) throw new Error("no card");
    const deps = { db: f.db, pubsub: f.pubsub };
    // Her own click is refused by the role screen's own check.
    await expect(decideWorkspaceAction(deps, bia.id, f.org.id, posted.id, "apply")).rejects.toThrow();
    expect(await roleNamed(f, "Marketing")).toBeNull();
    // The admin can't open her DM until she sends it.
    await expect(getWorkspaceActionCard(f.db, admin.id, f.org.id, posted.id)).rejects.toThrow();
    await askWorkspaceAction(deps, bia.id, f.org.id, posted.id);
    const inbox = await f.db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.orgId, f.org.id), eq(schema.notifications.kind, "change_request")));
    expect(inbox.map((n) => n.userId).sort()).toEqual([admin.id, f.owner.id].sort());
    expect(inbox[0]?.source).toMatchObject({ messageId: posted.id, action: "create_role" });
    const card = await decideWorkspaceAction(deps, admin.id, f.org.id, posted.id, "apply");
    expect(card).toMatchObject({ state: "applied", decidedByUserId: admin.id });
    expect(await roleNamed(f, "Marketing")).not.toBeNull();
    await expect(decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply")).rejects.toThrow(
      "already decided",
    );
    // Its receipt is on the card, for the admin to undo.
    const [receipt] = (await actionsFor(f.db, f.org.id, [posted.id])).get(posted.id) ?? [];
    expect(receipt).toMatchObject({ kind: "workspace.changed", requestedByUserId: admin.id });
    await undoAgentAction(deps, admin.id, f.org.id, receipt?.id ?? "");
    expect(await roleNamed(f, "Marketing")).toBeNull();
    const open = await f.db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.orgId, f.org.id), eq(schema.notifications.kind, "change_request")));
    expect(open.every((n) => n.doneAt)).toBe(true);
  });

  test("a key they don't hold is refused by the roles screen's rule: a card, nothing made", async () => {
    f = await setup({ rightHand: true });
    const lead = await addMember(f.db, f.org.id, "member", "Lia Lead");
    const managers = await createRole(f.db, f.owner.id, f.org.id, {
      name: "Gestores",
      permissions: ["manage_roles", "manage_members"],
    });
    await setMemberRoles(f.db, f.owner.id, f.org.id, lead.id, [managers.id]);
    const ctx = await lodiRun(f, lead.id, "cria um cargo que aprova merges");
    const out = await act(f, ctx, {
      action: "create_role",
      input: { name: "Revisores", permissions: ["approve_actions"] },
    });
    expect(out.content).toContain("They can't make this change");
    // In the roles screen's own words.
    expect(out.content).toContain("You can only give what you can do yourself");
    expect(await roleNamed(f, "Revisores")).toBeNull();
    const posted = await lastCard(f);
    expect(posted?.card.params).toMatchObject({ action: "create_role", refused: true });
    // They hold the roles screen's key, but its rule refused them: they send it on.
    await askWorkspaceAction({ db: f.db, pubsub: f.pubsub }, lead.id, f.org.id, posted?.id ?? "");
    // One they hold applies at once.
    expect((await act(f, ctx, { action: "create_role", input: { name: "Apoio" } })).content).toContain("Done at once");
  });

  test("after outside content, even the owner's change waits on its card", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "cria o cargo Marketing", true);
    const out = await act(f, ctx, { action: "create_role", input: MARKETING });
    expect(out.content).toContain("They apply it there");
    expect(await roleNamed(f, "Marketing")).toBeNull();
    const posted = await lastCard(f);
    if (!posted) throw new Error("no card");
    await decideWorkspaceAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, posted.id, "apply");
    expect(await roleNamed(f, "Marketing")).not.toBeNull();
  });

  test("change, move and delete a role, and a channel's exception: the screen's result, its refusal, its Undo", async () => {
    f = await setup({ rightHand: true });
    const deps = { db: f.db, pubsub: f.pubsub };
    const sales = await createRole(f.db, f.owner.id, f.org.id, { name: "Vendas", permissions: ["post"] });
    const ops = await createRole(f.db, f.owner.id, f.org.id, { name: "Operações" });
    const ctx = await lodiRun(f, f.owner.id, "ajusta os cargos");
    const changed = await act(f, ctx, {
      action: "update_role",
      input: { role: "vendas", name: "Comercial", add_permissions: ["edit_wiki"], color: "amber" },
    });
    expect(changed.content).toContain("Done at once");
    expect(await roleNamed(f, "Comercial")).toMatchObject({ color: "amber", permissions: ["post", "edit_wiki"] });
    const moved = await act(f, ctx, { action: "move_role", input: { role: "Operações", above: "Comercial" } });
    expect(moved.content).toContain("Done at once");
    const exception = await act(f, ctx, {
      action: "set_channel_permissions",
      input: { channel: "#general", role: "Operações", deny: ["post"] },
    });
    expect(exception.content).toContain("Done at once");
    const [override] = await f.db
      .select()
      .from(schema.channelPermissionOverrides)
      .where(eq(schema.channelPermissionOverrides.roleId, ops.id));
    expect(override).toMatchObject({ allow: [], deny: ["post"] });
    const order = async () =>
      (
        await f.db
          .select({ id: schema.orgRoles.id, position: schema.orgRoles.position })
          .from(schema.orgRoles)
          .where(and(eq(schema.orgRoles.orgId, f.org.id), eq(schema.orgRoles.kind, "custom")))
      )
        .sort((a, b) => a.position - b.position)
        .map((r) => r.id);
    expect((await order()).indexOf(ops.id)).toBeLessThan((await order()).indexOf(sales.id));
    const messageId = await reply(f, ctx);
    const undone = await undoMessageActions(deps, f.owner.id, f.org.id, messageId);
    expect(undone.failed).toEqual([]);
    expect(await roleNamed(f, "Vendas")).toMatchObject({ color: "graphite", permissions: ["post"] });
    expect((await order()).indexOf(ops.id)).toBeGreaterThan((await order()).indexOf(sales.id));
    expect(
      await f.db
        .select()
        .from(schema.channelPermissionOverrides)
        .where(eq(schema.channelPermissionOverrides.roleId, ops.id)),
    ).toEqual([]);

    // Deleting can't be undone: always a card, even for the owner, and its receipt has no Undo.
    const del = await act(f, ctx, { action: "delete_role", input: { role: "Vendas" } });
    expect(del.content).toContain("Posted a card");
    expect(await roleNamed(f, "Vendas")).not.toBeNull();
    const posted = await lastCard(f);
    if (!posted) throw new Error("no card");
    await decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply");
    expect(await roleNamed(f, "Vendas")).toBeNull();
    const [receipt] = (await actionsFor(f.db, f.org.id, [posted.id])).get(posted.id) ?? [];
    expect(Date.parse(receipt?.undoableUntil ?? "")).toBeLessThanOrEqual(Date.now());

    // A member without the permission: each a card, nothing changes.
    const nina = await addMember(f.db, f.org.id, "member", "Nina Teste");
    const hers = await lodiRun(f, nina.id, "renomeia operações");
    const refused = await act(f, hers, { action: "update_role", input: { role: "Operações", name: "Ops" } });
    expect(refused.content).toContain("They can't make this change");
    expect(await roleNamed(f, "Operações")).not.toBeNull();
  });

  test("who may create channels, everyone and the roles at once: a card that must be read, applied with Undo", async () => {
    f = await setup({ rightHand: true });
    const support = await createRole(f.db, f.owner.id, f.org.id, {
      name: "Suporte",
      permissions: ["create_channels", "post"],
    });
    const finance = await createRole(f.db, f.owner.id, f.org.id, { name: "Financeiro" });
    const admin = await roleNamed(f, "Admin");
    const base = async () =>
      (
        await f.db
          .select()
          .from(schema.orgRoles)
          .where(and(eq(schema.orgRoles.orgId, f.org.id), eq(schema.orgRoles.kind, "everyone")))
      )[0]?.permissions ?? [];
    const ctx = await lodiRun(f, f.owner.id, "só o financeiro cria canais");
    // A step on a key, or a role that isn't there: why, and no card.
    const wrong = await act(f, ctx, {
      action: "set_permission_holders",
      input: { permission: "create_channels", everyone: 2 },
    });
    expect(wrong).toMatchObject({ isError: true, content: expect.stringContaining("Only computers has steps") });
    const gone = await act(f, ctx, {
      action: "set_permission_holders",
      input: { permission: "create_channels", everyone: 0, roles: [{ role: "Vendas", level: 1 }] },
    });
    expect(gone).toMatchObject({ isError: true, content: expect.stringContaining('No role "Vendas"') });
    expect(await lastCard(f)).toBeNull();

    // Even the owner's own words make a card: it changes what everyone may.
    const out = await act(f, ctx, {
      action: "set_permission_holders",
      input: { permission: "create_channels", everyone: 0, roles: [{ role: "financeiro", level: 1 }] },
      why: "Só o Financeiro cria canais",
    });
    expect(out.content).toContain("Posted a card to set_permission_holders");
    expect(await base()).toContain("create_channels");
    const posted = await lastCard(f);
    if (!posted) throw new Error("no card");
    // The Admin role keeps it whatever the card says: the card names it among who may.
    expect(posted.card.params).toMatchObject({
      action: "set_permission_holders",
      needs: "manage_roles",
      input: {
        row: "create_channels",
        everyone: 0,
        roles: [
          { id: admin?.id, name: "Admin", level: 1 },
          { id: finance.id, name: "Financeiro", level: 1 },
        ],
      },
      words: { permission: "create_channels" },
    });
    const deps = { db: f.db, pubsub: f.pubsub };
    // An app that would read it as "a change in the workspace" may not apply it.
    await expect(decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply")).rejects.toMatchObject({
      code: "action_card.update_app",
    });
    await decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply", "set_permission_holders");
    expect(await base()).not.toContain("create_channels");
    expect((await roleNamed(f, "Financeiro"))?.permissions).toEqual(["create_channels"]);
    expect((await roleNamed(f, "Suporte"))?.permissions).toEqual(["post"]);
    const [receipt] = (await actionsFor(f.db, f.org.id, [posted.id])).get(posted.id) ?? [];
    expect(receipt).toMatchObject({
      kind: "workspace.changed",
      params: { action: "set_permission_holders", permission: "create_channels" },
    });
    // Changed again since, Undo refuses and leaves the row as it is.
    const holders = (ids: string[]) =>
      setRowHolders(f.db, f.owner.id, f.org.id, "create_channels", {
        everyone: 0,
        roles: ids.map((id) => ({ id, level: 1 })),
      });
    await holders([finance.id, support.id]);
    await expect(undoAgentAction(deps, f.owner.id, f.org.id, receipt?.id ?? "")).rejects.toMatchObject({
      code: "action.changed_since",
    });
    expect(await base()).not.toContain("create_channels");
    expect((await roleNamed(f, "Suporte"))?.permissions.sort()).toEqual(["create_channels", "post"]);
    // As the card left it again, Undo puts every role back as it was.
    await holders([finance.id]);
    await undoAgentAction(deps, f.owner.id, f.org.id, receipt?.id ?? "");
    expect(await base()).toContain("create_channels");
    expect((await roleNamed(f, "Financeiro"))?.permissions).toEqual([]);
    expect((await roleNamed(f, "Suporte"))?.permissions.sort()).toEqual(["create_channels", "post"]);

    // On the computers' ladder the Admin role stands at the top step.
    await act(f, ctx, {
      action: "set_permission_holders",
      input: { permission: "computers", everyone: 1 },
      why: "Todos usam o navegador dos seus agentes",
    });
    expect((await lastCard(f))?.card.params.input).toMatchObject({
      row: "computers",
      everyone: 1,
      roles: [{ id: admin?.id, name: "Admin", level: 4 }],
    });
  });

  test("a role the card names for holding administrator that no longer does gets nothing from it: the card is read again", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "todos usam o navegador dos seus agentes");
    await act(f, ctx, {
      action: "set_permission_holders",
      input: { permission: "computers", everyone: 1 },
      why: "Todos usam o navegador dos seus agentes",
    });
    const posted = await lastCard(f);
    if (!posted) throw new Error("no card");
    const admin = await roleNamed(f, "Admin");
    await updateRole(f.db, f.owner.id, f.org.id, admin?.id ?? "", { permissions: [] });
    const deps = { db: f.db, pubsub: f.pubsub };
    await expect(
      decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply", "set_permission_holders"),
    ).rejects.toMatchObject({ code: "action_card.changed" });
    expect((await roleNamed(f, "Admin"))?.permissions).toEqual([]);
    expect((await lastCard(f))?.card.params.input).toMatchObject({ roles: [] });
    // Applied as it reads now, Admin still gets nothing.
    await decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply", "set_permission_holders");
    expect((await roleNamed(f, "Admin"))?.permissions).toEqual([]);
  });

  test("wrong or unknown input says why and changes nothing", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "faz algo");
    const unknown = await act(f, ctx, { action: "make_coffee", input: {} });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain('No action "make_coffee"');
    const bad = await act(f, ctx, { action: "create_role", input: { name: "X", permissions: ["fly"] } });
    expect(bad).toMatchObject({ isError: true });
    expect(bad.content).toContain("Wrong input");
    const nobody = await act(f, ctx, { action: "set_member_roles", input: { person: "Zé", add_roles: ["x"] } });
    expect(nobody.content).toBe('No one called "Zé" in this workspace.');
    expect(await lastCard(f)).toBeNull();
  });
});

/** Ends a test run so the person's next message starts another (a DM holds one run at a time). */
const finish = (fx: Fixture, ctx: ToolContext) =>
  fx.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, ctx.runId));

const statusOf = async (fx: Fixture, userId: string) =>
  (
    await fx.db
      .select({ availability: schema.organizationMembers.availability, text: schema.organizationMembers.statusText })
      .from(schema.organizationMembers)
      .where(and(eq(schema.organizationMembers.orgId, fx.org.id), eq(schema.organizationMembers.userId, userId)))
  )[0];

describe("the rest of the app through the right hand", () => {
  test("their own status: anyone sets theirs at once, and Desfazer puts it back", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    const ctx = await lodiRun(f, bia.id, "estou em reunião até as 15h");
    const out = await act(f, ctx, { action: "set_my_status", input: { availability: "busy", text: "Em reunião" } });
    expect(out.content).toContain("Done at once");
    expect(await statusOf(f, bia.id)).toEqual({ availability: "busy", text: "Em reunião" });
    const messageId = await reply(f, ctx);
    const [receipt] = (await actionsFor(f.db, f.org.id, [messageId])).get(messageId) ?? [];
    expect(receipt?.params).toMatchObject({ action: "set_my_status", what: "Em reunião", availability: "busy" });
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, receipt?.id ?? "");
    expect(await statusOf(f, bia.id)).toEqual({ availability: "auto", text: null });
  });

  test("Desfazer of their status once the old line's time ran out leaves no line, as the screen would", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    const soon = new Date(Date.now() + 60_000).toISOString();
    await setMyStatus({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, { status: { text: "Almoço", until: soon } });
    const ctx = await lodiRun(f, bia.id, "estou em reunião");
    expect((await act(f, ctx, { action: "set_my_status", input: { text: "Em reunião" } })).content).toContain(
      "Done at once",
    );
    const [receipt] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.runId, ctx.runId));
    // The lunch line's time passes before Desfazer.
    const before = receipt?.before as { status: Record<string, unknown> };
    const past = new Date(Date.now() - 1000).toISOString();
    await f.db
      .update(schema.agentActions)
      .set({ before: { ...before, status: { ...before.status, until: past } } })
      .where(eq(schema.agentActions.id, receipt?.id ?? ""));
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, receipt?.id ?? "");
    expect(await statusOf(f, bia.id)).toEqual({ availability: "auto", text: null });
  });

  test("their notifications and time zone, and an invitation's roles: at once, each undone", async () => {
    f = await setup({ rightHand: true });
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    const ctx = await lodiRun(f, bia.id, "não quero mais notificação de reação, e estou em Lisboa");
    const reactions = async () =>
      (await noticePrefsView(f.db, f.org.id, bia.id)).categories.find((c) => c.id === "reactions")?.on;
    const start = await reactions();
    for (const [action, input] of [
      ["set_notifications", { category: "reactions", on: !start }],
      ["set_my_timezone", { timezone: "Europe/Lisbon" }],
    ] as const)
      expect((await act(f, ctx, { action, input })).content).toContain("Done at once");
    const zone = async () =>
      (
        await f.db
          .select({ timezone: schema.organizationMembers.timezone })
          .from(schema.organizationMembers)
          .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, bia.id)))
      )[0]?.timezone;
    expect(await reactions()).toBe(!start);
    expect(await zone()).toBe("Europe/Lisbon");
    const messageId = await reply(f, ctx);
    expect((await undoMessageActions(deps, bia.id, f.org.id, messageId)).failed).toEqual([]);
    expect(await reactions()).toBe(start);
    expect(await zone()).toBeNull();

    await createRole(f.db, f.owner.id, f.org.id, { name: "Vendas" });
    await createInvitation(f.db, f.owner.id, f.org.id, { email: "convidada@example.com" });
    const roles = async () =>
      (
        await f.db
          .select({ roleIds: schema.organizationInvitations.roleIds })
          .from(schema.organizationInvitations)
          .where(eq(schema.organizationInvitations.orgId, f.org.id))
      )[0]?.roleIds;
    const mine = await lodiRun(f, f.owner.id, "o convite dela entra em Vendas");
    const out = await act(f, mine, {
      action: "set_invitation_roles",
      input: { email: "convidada@example.com", add_roles: ["vendas"] },
    });
    expect(out.content).toContain("Done at once");
    expect(await roles()).toHaveLength(1);
    const [receipt] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.runId, mine.runId));
    await undoAgentAction(deps, f.owner.id, f.org.id, receipt?.id ?? "");
    expect(await roles()).toEqual([]);
  });

  test("a channel renamed, its people changed and archived at once, all undone; its deletion is a card", async () => {
    f = await setup({ rightHand: true });
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    const launch = await createChannel(f.db, f.owner.id, f.org.id, { name: "lancamento", topic: "" });
    const ctx = await lodiRun(f, f.owner.id, "arruma o canal de lançamento");
    for (const [action, input] of [
      ["update_channel", { channel: "#lancamento", name: "lancamento-q4", topic: "Campanha do Q4" }],
      ["channel_people", { channel: "lancamento-q4", add: ["Bia Teste"] }],
      ["archive_channel", { channel: "lancamento-q4" }],
    ] as const)
      expect((await act(f, ctx, { action, input })).content).toContain("Done at once");
    const row = async () => (await f.db.select().from(schema.channels).where(eq(schema.channels.id, launch.id)))[0];
    expect(await row()).toMatchObject({ name: "lancamento-q4", topic: "Campanha do Q4" });
    expect((await row())?.archivedAt).not.toBeNull();
    const seated = async () =>
      (await f.db.select().from(schema.channelMembers).where(eq(schema.channelMembers.channelId, launch.id))).map(
        (m) => m.userId,
      );
    expect(await seated()).toContain(bia.id);
    const messageId = await reply(f, ctx);
    expect((await undoMessageActions(deps, f.owner.id, f.org.id, messageId)).failed).toEqual([]);
    expect(await row()).toMatchObject({ name: "lancamento", topic: "", archivedAt: null });
    expect(await seated()).not.toContain(bia.id);
    await finish(f, ctx);

    // Bia doesn't manage it: a card, nothing changes.
    const hers = await lodiRun(f, bia.id, "renomeia o canal");
    await addChannelMember(f.db, f.owner.id, f.org.id, launch.id, { userId: bia.id });
    const refused = await act(f, hers, { action: "update_channel", input: { channel: "lancamento", name: "meu" } });
    expect(refused.content).toContain("They can't make this change");
    expect((await row())?.name).toBe("lancamento");

    const del = await act(f, await lodiRun(f, f.owner.id, "apaga o canal"), {
      action: "delete_channel",
      input: { channel: "lancamento" },
    });
    expect(del.content).toContain("Posted a card");
    expect((await row())?.deletedAt).toBeNull();
    const posted = await lastCard(f);
    if (!posted) throw new Error("no card");
    await decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply");
    expect((await row())?.deletedAt).not.toBeNull();
  });

  test("an invitation canceled at once by who may invite; a member gets a card", async () => {
    f = await setup({ rightHand: true });
    await createInvitation(f.db, f.owner.id, f.org.id, { email: "convidada@example.com" });
    const pending = async () =>
      (
        await f.db
          .select()
          .from(schema.organizationInvitations)
          .where(eq(schema.organizationInvitations.orgId, f.org.id))
      ).length;
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    const hers = await act(f, await lodiRun(f, bia.id, "cancela o convite"), {
      action: "revoke_invitation",
      input: { email: "convidada@example.com" },
    });
    expect(hers.content).toContain("They can't make this change");
    expect(await pending()).toBe(1);
    const ctx = await lodiRun(f, f.owner.id, "cancela o convite");
    // What can't be undone is never offered with Undo, neither in find nor once done.
    expect((await act(f, ctx, { find: "cancel a pending invitation" })).content).toContain(
      "revoke_invitation: Cancel a pending invitation to the workspace: its link stops working. They may: it applies at once and can't be undone.",
    );
    const out = await act(f, ctx, { action: "revoke_invitation", input: { email: "Convidada@example.com" } });
    expect(out.content).toContain("Done at once (it can't be undone)");
    expect(await pending()).toBe(0);
  });

  test("an invitation sent again at once; a request to join decided on a card, let in or turned down", async () => {
    f = await setup({ rightHand: true });
    const deps = { db: f.db, pubsub: f.pubsub, server: SERVER };
    const invited = await createInvitation(f.db, f.owner.id, f.org.id, { email: "convidada@example.com" });
    await f.db
      .update(schema.organizationInvitations)
      .set({ expiresAt: new Date(Date.now() + 3_600_000) })
      .where(eq(schema.organizationInvitations.email, "convidada@example.com"));
    const ctx = await lodiRun(f, f.owner.id, "reenvia o convite");
    const again = await act(f, ctx, { action: "resend_invitation", input: { email: "convidada@example.com" } });
    expect(again.content).toContain("Done at once");
    const [row] = await f.db
      .select()
      .from(schema.organizationInvitations)
      .where(eq(schema.organizationInvitations.email, "convidada@example.com"));
    expect((row?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(6 * 86_400_000);
    expect(invited).toBeTruthy();
    await finish(f, ctx);

    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    await suggestPerson(deps, bia.id, f.org.id, { email: "nova@example.com" });
    await suggestPerson(deps, bia.id, f.org.id, { email: "outra@example.com" });
    const hers = await act(f, await lodiRun(f, bia.id, "deixa a nova entrar"), {
      action: "decide_join_request",
      input: { email: "nova@example.com", approve: true },
    });
    expect(hers.content).toContain("They can't make this change");
    const status = async (email: string) =>
      (
        await f.db
          .select({ status: schema.organizationJoinRequests.status })
          .from(schema.organizationJoinRequests)
          .where(eq(schema.organizationJoinRequests.email, email))
      )[0]?.status;
    const mine = await lodiRun(f, f.owner.id, "deixa a nova entrar e recusa a outra");
    for (const [email, approve] of [
      ["nova@example.com", true],
      ["outra@example.com", false],
    ] as const) {
      const out = await act(f, mine, { action: "decide_join_request", input: { email, approve, reason: "Não agora" } });
      expect(out.content).toContain("Posted a card");
      expect(await status(email)).toBe("pending");
      const posted = await lastCard(f);
      if (!posted) throw new Error("no card");
      await decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply");
    }
    expect(await status("nova@example.com")).toBe("approved");
    expect(await status("outra@example.com")).toBe("denied");
  });

  test("stopping an agent's work as the person who may; the right hand never stops itself", async () => {
    f = await setup({ rightHand: true });
    const asked = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev faz o relatório",
    });
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, asked.id));
    if (!run) throw new Error("no run");
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    const caio = await addMember(f.db, f.org.id, "member", "Caio Teste");
    const hers = await act(f, await lodiRun(f, bia.id, "para o dev"), {
      action: "stop_work",
      input: { agent: "@dev" },
    });
    expect(hers.content).toContain("They can't make this change");
    const status = async () => (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id)))[0];
    expect((await status())?.status).toBe("queued");
    // Sent on, a card no key opens goes to the owners: no other member reads it out of her DM.
    const sent = await lastCard(f);
    if (!sent) throw new Error("no card");
    await askWorkspaceAction({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, sent.id);
    await expect(getWorkspaceActionCard(f.db, caio.id, f.org.id, sent.id)).rejects.toThrow();
    await expect(decideWorkspaceAction({ db: f.db }, caio.id, f.org.id, sent.id, "apply")).rejects.toThrow();
    expect((await getWorkspaceActionCard(f.db, f.owner.id, f.org.id, sent.id)).card.askedAt).toBeTruthy();
    const ctx = await lodiRun(f, f.owner.id, "para o dev");
    expect((await act(f, ctx, { action: "stop_work", input: { agent: "@dev", reason: "Já fiz" } })).content).toContain(
      "Done at once",
    );
    expect((await status())?.status).toBe("canceled");
    const self = await act(f, ctx, { action: "stop_work", input: { agent: "@lodi" } });
    expect(self).toMatchObject({ isError: true, content: "That is you: say so, and stop nothing." });
    const none = await act(f, ctx, { action: "continue_work", input: { agent: "@dev" } });
    expect(none.isError).toBe(true);
  });

  test("the workspace's name and time zone at once, undone; the action check always on a card", async () => {
    f = await setup({ rightHand: true });
    const deps = { db: f.db, pubsub: f.pubsub };
    const before = await getOrgSettings(f.db, f.owner.id, f.org.id);
    const ctx = await lodiRun(f, f.owner.id, "muda o nome do workspace");
    const out = await act(f, ctx, {
      action: "update_workspace",
      input: { name: "Acme Teste", timezone: "America/Sao_Paulo" },
    });
    expect(out.content).toContain("Done at once");
    expect(await getOrgSettings(f.db, f.owner.id, f.org.id)).toMatchObject({
      name: "Acme Teste",
      timezone: "America/Sao_Paulo",
    });
    const check = await act(f, ctx, { action: "set_action_check", input: { on: false } });
    expect(check.content).toContain("Posted a card");
    expect((await getOrgSettings(f.db, f.owner.id, f.org.id)).actionCheck).toBe(true);
    const posted = await lastCard(f);
    if (!posted) throw new Error("no card");
    await decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply");
    expect((await getOrgSettings(f.db, f.owner.id, f.org.id)).actionCheck).toBe(false);
    const messageId = await reply(f, ctx);
    expect((await undoMessageActions(deps, f.owner.id, f.org.id, messageId)).failed).toEqual([]);
    expect(await getOrgSettings(f.db, f.owner.id, f.org.id)).toMatchObject({
      name: before.name,
      timezone: before.timezone,
    });
    const [receipt] = (await actionsFor(f.db, f.org.id, [posted.id])).get(posted.id) ?? [];
    await undoAgentAction(deps, f.owner.id, f.org.id, receipt?.id ?? "");
    expect((await getOrgSettings(f.db, f.owner.id, f.org.id)).actionCheck).toBe(true);
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    const hers = await act(f, await lodiRun(f, bia.id, "muda o fuso"), {
      action: "update_workspace",
      input: { timezone: "Europe/Lisbon" },
    });
    expect(hers.content).toContain("They can't make this change");
  });

  test("another agent's routine: deleted for who may manage it, with Undo", async () => {
    f = await setup({ rightHand: true });
    const routine = await createRoutine({ db: f.db, pubsub: f.pubsub, context: f.context }, f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Resuma o dia.",
      target: { type: "channel", channelId: f.general.id },
      trigger: { type: "schedule", phrase: "dias úteis às 9h" },
    });
    const ctx = await lodiRun(f, f.owner.id, "apaga a rotina do dev");
    const gateway = createToolGateway({
      sources: [createScheduleToolSource({ pubsub: f.pubsub, context: f.context })],
    });
    const res = await gateway.invoke(ctx, {
      toolUseId: `tu_${crypto.randomUUID()}`,
      name: "delete_routine",
      input: { id: routine.id },
    });
    if (res.type !== "result") throw new Error(res.type);
    expect(res.output.isError).toBeFalsy();
    const deletedAt = async () =>
      (await f.db.select().from(schema.routines).where(eq(schema.routines.id, routine.id)))[0]?.deletedAt;
    expect(await deletedAt()).not.toBeNull();
    const [receipt] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.runId, ctx.runId));
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    expect(await deletedAt()).toBeNull();
  });

  test("a wiki page written as itself at the person's request, with Undo; never for who can't edit the wiki", async () => {
    f = await setup({ rightHand: true });
    const wiki = createToolGateway({ sources: [createWikiToolSource({ pubsub: f.pubsub, search: f.context })] });
    const write = async (ctx: ToolContext) => {
      const res = await wiki.invoke(ctx, {
        toolUseId: `tu_${crypto.randomUUID()}`,
        name: "create_wiki_page",
        input: { title: "Onboarding de marketing", body: "Primeiros passos." },
      });
      if (res.type !== "result") throw new Error(res.type);
      return res.output;
    };
    const pages = async () => await f.db.select().from(schema.wikiPages).where(eq(schema.wikiPages.orgId, f.org.id));
    const ctx = await lodiRun(f, f.owner.id, "documenta o onboarding de marketing na wiki");
    expect((await write(ctx)).isError).toBeFalsy();
    expect((await pages()).filter((p) => !p.deletedAt)).toHaveLength(1);
    const [receipt] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.runId, ctx.runId));
    expect(receipt?.kind).toBe("wiki.page_created");
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    expect((await pages()).filter((p) => !p.deletedAt)).toHaveLength(0);

    const [everyone] = await f.db
      .select()
      .from(schema.orgRoles)
      .where(and(eq(schema.orgRoles.orgId, f.org.id), eq(schema.orgRoles.kind, "everyone")));
    await updateRole(f.db, f.owner.id, f.org.id, everyone?.id ?? "", {
      permissions: (everyone?.permissions ?? []).filter((k) => k !== "edit_wiki"),
    });
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    expect((await write(await lodiRun(f, bia.id, "documenta isso na wiki"))).isError).toBe(true);
    expect((await pages()).filter((p) => !p.deletedAt)).toHaveLength(0);
  });
});

/** A card of the catalog posted straight in a channel, as the right hand posts one (`agentId`: its author). */
async function postCard(fx: Fixture, channelId: string, agentId: string, card: Omit<WorkspaceActionCard, "kind">) {
  const message = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId,
    author: { type: "agent", agentId, runId: null, hop: 0, stretchId: null },
    body: `Proposed ${card.params.action}`,
    meta: { actionCard: { kind: "workspace_action", ...card } },
  });
  return message.id;
}

const pending = { state: "pending", decidedByUserId: null, decidedAt: null } as const;

describe("what Desfazer, the card and the people card keep to", () => {
  test("a private channel made public gets its roles' audience back with Desfazer", async () => {
    f = await setup({ rightHand: true });
    const sales = await createRole(f.db, f.owner.id, f.org.id, { name: "Vendas" });
    const room = await createChannel(f.db, f.owner.id, f.org.id, {
      name: "vendas",
      visibility: "private",
      audienceRoleIds: [sales.id],
    });
    const ctx = await lodiRun(f, f.owner.id, "abre o canal vendas pra todo mundo");
    const out = await act(f, ctx, { action: "update_channel", input: { channel: "vendas", private: false } });
    expect(out.content).toContain("Done at once, with Undo");
    const row = async () => (await f.db.select().from(schema.channels).where(eq(schema.channels.id, room.id)))[0];
    expect(await row()).toMatchObject({ visibility: "public", audienceRoleIds: [] });
    const messageId = await reply(f, ctx);
    expect((await undoMessageActions({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, messageId)).failed).toEqual(
      [],
    );
    expect(await row()).toMatchObject({ visibility: "private", audienceRoleIds: [sales.id] });
  });

  test("a new role's Desfazer waits while a channel's exception holds it; Desfazer tudo takes both back", async () => {
    f = await setup({ rightHand: true });
    const deps = { db: f.db, pubsub: f.pubsub };
    const ctx = await lodiRun(f, f.owner.id, "cria o cargo Site, que só lê o general");
    expect((await act(f, ctx, { action: "create_role", input: { name: "Site" } })).content).toContain("Done at once");
    const exception = await act(f, ctx, {
      action: "set_channel_permissions",
      input: { channel: "general", role: "Site", deny: ["post"] },
    });
    expect(exception.content).toContain("Done at once");
    const messageId = await reply(f, ctx);
    const [made] = (await actionsFor(f.db, f.org.id, [messageId])).get(messageId) ?? [];
    expect(made?.params.action).toBe("create_role");
    // Deleting it now would take the exception with it.
    await expect(undoAgentAction(deps, f.owner.id, f.org.id, made?.id ?? "")).rejects.toThrow("changed");
    expect(await roleNamed(f, "Site")).not.toBeNull();
    expect((await undoMessageActions(deps, f.owner.id, f.org.id, messageId)).failed).toEqual([]);
    expect(await roleNamed(f, "Site")).toBeNull();
  });

  test("bringing a channel back names only one the person could see in the list", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "segredo", visibility: "private" });
    await archiveChannel(f.db, f.owner.id, f.org.id, secret.id);
    const back = { action: "archive_channel", input: { channel: "segredo", back: true } };
    const hers = await act(f, await lodiRun(f, bia.id, "traz o segredo de volta"), back);
    expect(hers).toMatchObject({ isError: true, content: "No archived channel #segredo." });
    expect(await lastCard(f)).toBeNull();
    expect((await act(f, await lodiRun(f, f.owner.id, "traz o segredo de volta"), back)).content).toContain(
      "Done at once",
    );
  });

  test("continuing an agent finds its stopped run, past an ordinary answer it gave since", async () => {
    const look: ToolSource = {
      name: "work",
      tools: async () => [
        {
          name: "look",
          description: "Look at the open pull requests",
          scope: "context:read",
          inputSchema: { type: "object", properties: {} },
          execute: async () => ({ content: "3 PRs open" }),
        },
      ],
    };
    f = await setup({
      rightHand: true,
      toolSources: [look],
      // Three steps of looking (its step limit), then plain answers.
      reply: (_req, n) => (n <= 3 ? { chunks: [], toolUses: [{ name: "look", input: {} }] } : { chunks: ["Oi!"] }),
    });
    const handlers = createJobHandlers({ ...f.jobDeps, maxToolTurns: 3 });
    const ask = (body: string) =>
      postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
    const devRuns = () =>
      f.db
        .select()
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.agentId, f.agent.id))
        .orderBy(schema.agentRuns.createdAt);
    await ask("@dev revisa os PRs");
    await drainOutbox(f.db, handlers);
    const [capped] = await devRuns();
    const [stopped] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, capped?.replyMessageId ?? crypto.randomUUID()));
    expect(stopped?.meta.bodyCode).toBe("step_limit");
    await ask("@dev oi");
    await drainOutbox(f.db, handlers);
    expect((await devRuns()).map((r) => r.status)).toEqual(["done", "done"]);
    const out = await act(f, await lodiRun(f, f.owner.id, "deixa o dev continuar"), {
      action: "continue_work",
      input: { agent: "@dev" },
    });
    expect(out.content).toContain("Done at once (it can't be undone)");
    const [, , next] = await devRuns();
    expect(next?.triggerMessageId).toBe(stopped?.id ?? "");
  });

  test("refused at Aplicar by the screen's own rule, the card of the person it was for sends it on instead", async () => {
    f = await setup({ rightHand: true });
    const deps = { db: f.db, pubsub: f.pubsub };
    const lia = await addMember(f.db, f.org.id, "member", "Lia Lead");
    // Made first, so it ranks above the managers' role.
    await createRole(f.db, f.owner.id, f.org.id, { name: "Diretoria" });
    const managers = await createRole(f.db, f.owner.id, f.org.id, {
      name: "Gestores",
      permissions: ["manage_roles", "manage_members"],
    });
    await setMemberRoles(f.db, f.owner.id, f.org.id, lia.id, [managers.id]);
    const out = await act(f, await lodiRun(f, lia.id, "apaga o cargo Diretoria"), {
      action: "delete_role",
      input: { role: "Diretoria" },
    });
    expect(out.content).toContain("They apply it there");
    const posted = await lastCard(f);
    if (!posted) throw new Error("no card");
    await expect(decideWorkspaceAction(deps, lia.id, f.org.id, posted.id, "apply")).rejects.toThrow(
      "Only someone above this role changes it",
    );
    expect((await lastCard(f))?.card).toMatchObject({ state: "pending", params: { refused: true } });
    await askWorkspaceAction(deps, lia.id, f.org.id, posted.id);
    await decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply");
    expect(await roleNamed(f, "Diretoria")).toBeNull();
  });

  test("a card of their own status is theirs to apply: anyone else's click is refused", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf(f);
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    // A channel both read, as when it answers someone there.
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    const id = await postCard(f, f.general.id, lodi.id, {
      forUserId: bia.id,
      params: {
        action: "set_my_status",
        input: { availability: "busy" },
        words: { what: "", availability: "busy" },
        needs: null,
        why: "",
        self: true,
      },
      ...pending,
    });
    const deps = { db: f.db, pubsub: f.pubsub };
    await expect(decideWorkspaceAction(deps, f.owner.id, f.org.id, id, "apply")).rejects.toThrow(
      "Only the person it was for applies it",
    );
    expect((await statusOf(f, f.owner.id))?.availability).toBe("auto");
    await expect(askWorkspaceAction(deps, bia.id, f.org.id, id)).rejects.toThrow("You can apply it yourself");
    await decideWorkspaceAction(deps, bia.id, f.org.id, id, "apply");
    expect((await statusOf(f, bia.id))?.availability).toBe("busy");
  });

  test("the people card's roles given at once count toward the turn's cap", async () => {
    f = await setup({ rightHand: true });
    const nina = await addMember(f.db, f.org.id, "member", "Nina Teste");
    await createRole(f.db, f.owner.id, f.org.id, { name: "Vendas" });
    const ctx = await lodiRun(f, f.owner.id, "Nina entra em Vendas");
    await f.db.insert(schema.agentActions).values(
      Array.from({ length: MAX_ACTIONS_PER_RUN }, () => ({
        orgId: f.org.id,
        runId: ctx.runId,
        agentId: ctx.agentId,
        channelId: ctx.channelId,
        kind: "workspace.changed",
        targetType: "person",
        targetId: nina.id,
        undoableUntil: new Date(),
      })),
    );
    const res = await gatewayOf(f).invoke(ctx, {
      toolUseId: `tu_${crypto.randomUUID()}`,
      name: PROPOSE_MEMBER_CHANGES_TOOL,
      input: { changes: [{ person: "Nina Teste", add_roles: ["Vendas"] }], why: "Nina em Vendas" },
    });
    if (res.type !== "result") throw new Error(res.type);
    expect(res.output.content).not.toContain("Applied at once");
    expect(res.output.content).toContain("Posted the card");
    expect(await memberRoleIds(f.db, f.org.id, nina.id)).toEqual([]);
  });

  test("a channel deleted from its card takes its mail routines' triggers along, as its screen does", async () => {
    const m = await mailSetup();
    f = m.f;
    const gmail = await gmailAccount(m);
    await giveMail(m, gmail.accountId, "read");
    const support = await createChannel(f.db, f.owner.id, f.org.id, { name: "suporte" });
    await addChannelMember(f.db, f.owner.id, f.org.id, support.id, { agentId: f.agent.id });
    await createRoutine({ db: f.db, pubsub: f.pubsub, mail: m.mail }, f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Triage support mail",
      target: { type: "channel", channelId: support.id },
      trigger: { type: "email", accountId: gmail.accountId, folder: "INBOX", filter: {} },
    });
    const [watch] = await f.db.select().from(schema.mailWatches);
    expect(watch?.externalTriggerId).toBeTruthy();
    const id = await postCard(f, f.general.id, f.agent.id, {
      forUserId: f.owner.id,
      params: {
        action: "delete_channel",
        input: { channelId: support.id },
        words: { channel: "suporte" },
        needs: "manage_channels",
        why: "",
      },
      ...pending,
    });
    await decideWorkspaceAction({ db: f.db, pubsub: f.pubsub, mail: m.mail }, f.owner.id, f.org.id, id, "apply");
    expect(m.composio.state.deletedTriggers).toEqual([watch?.externalTriggerId ?? ""]);
  });
});

describe("cards that must be read: inviting people and removing an API key", () => {
  const SERVER_DEPS = (fx: Fixture) => ({ db: fx.db, pubsub: fx.pubsub, server: SERVER });
  const invitations = (fx: Fixture) =>
    fx.db.select().from(schema.organizationInvitations).where(eq(schema.organizationInvitations.orgId, fx.org.id));
  const emailJobs = async (fx: Fixture) =>
    (await fx.db.select().from(schema.outbox).where(eq(schema.outbox.orgId, fx.org.id))).filter(
      (j) => j.kind === "email.send",
    );
  const jobKinds = async (fx: Fixture) =>
    (await fx.db.select().from(schema.outbox).where(eq(schema.outbox.orgId, fx.org.id))).map((j) => j.kind).sort();
  const cardNow = async (fx: Fixture, id: string) =>
    (await fx.db.select().from(schema.messages).where(eq(schema.messages.id, id)))[0]?.meta
      .actionCard as WorkspaceActionCard;
  const inbox = (fx: Fixture) =>
    fx.db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.orgId, fx.org.id), eq(schema.notifications.kind, "change_request")));
  const keys = (fx: Fixture) =>
    fx.db.select().from(schema.providerCredentials).where(eq(schema.providerCredentials.orgId, fx.org.id));

  test("an invite is a card with every address and role even in the owner's own words; one tap sends them as the clicker, once", async () => {
    f = await setup({ rightHand: true });
    const vendas = await createRole(f.db, f.owner.id, f.org.id, { name: "Vendas" });
    const ctx = await lodiRun(f, f.owner.id, "convida a ana e a bia como Vendas");
    expect((await act(f, ctx, { find: "invite people by email" })).content).toContain(
      "invite_people: Invite people to the workspace by email",
    );
    const out = await act(f, ctx, {
      action: "invite_people",
      input: { emails: ["Ana@Example.com", "bia@example.com", "ana@example.com"], roles: ["vendas", "everyone"] },
      why: "As duas novas vendedoras",
    });
    expect(out.content).toContain("Posted a card to invite_people");
    expect(out.content).toContain("They apply it there. Nothing has changed yet.");
    // Nothing went anywhere before the tap: no invitation, no email, no inbox row.
    expect(await invitations(f)).toEqual([]);
    expect(await emailJobs(f)).toEqual([]);
    expect(await inbox(f)).toEqual([]);
    const posted = await lastCard(f);
    if (!posted) throw new Error("no card");
    expect(posted.card).toMatchObject({
      forUserId: f.owner.id,
      state: "pending",
      params: {
        action: "invite_people",
        needs: "invite_people",
        input: { emails: ["ana@example.com", "bia@example.com"], roleIds: [vendas.id], roleNames: ["Vendas"] },
        words: { emails: "ana@example.com, bia@example.com", roles: "Vendas" },
        why: "As duas novas vendedoras",
      },
    });
    const deps = SERVER_DEPS(f);
    // An app that would show "a change in the workspace" may not apply it.
    for (const knows of [undefined, "create_role"]) {
      await expect(decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply", knows)).rejects.toMatchObject({
        code: "action_card.update_app",
      });
    }
    expect(await invitations(f)).toEqual([]);
    expect((await cardNow(f, posted.id)).state).toBe("pending");
    // Two taps at once apply it once.
    const taps = await Promise.allSettled([
      decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply", "invite_people"),
      decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply", "invite_people"),
    ]);
    expect(taps.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const sent = await invitations(f);
    expect(sent.map((i) => i.email).sort()).toEqual(["ana@example.com", "bia@example.com"]);
    for (const i of sent) expect(i).toMatchObject({ invitedByUserId: f.owner.id, roleIds: [vendas.id] });
    expect(await emailJobs(f)).toHaveLength(2);
    const card = await cardNow(f, posted.id);
    expect(card).toMatchObject({ state: "applied", decidedByUserId: f.owner.id });
    expect(card.params.words).toMatchObject({ invited: "ana@example.com, bia@example.com" });
    // Its receipt says who was invited, and nothing undoes an email that went out.
    const [receipt] = (await actionsFor(f.db, f.org.id, [posted.id])).get(posted.id) ?? [];
    expect(receipt).toMatchObject({
      kind: "workspace.changed",
      requestedByUserId: f.owner.id,
      params: { action: "invite_people", invited: "ana@example.com, bia@example.com" },
    });
    expect(Date.parse(String(receipt?.undoableUntil))).toBeLessThanOrEqual(Date.now());
    // The card, its refusals and its tap ask no model anything.
    expect(f.provider.calls).toHaveLength(0);
  });

  test("Lodi's offer_invites posts that card, and it is the turn's one ask", async () => {
    f = await setup({ rightHand: true });
    await createRole(f.db, f.owner.id, f.org.id, { name: "Vendas" });
    const ctx = await lodiRun(f, f.owner.id, "convida a ana");
    const offer = async (emails: string[]) => {
      const res = await gatewayOf(f).invoke(ctx, {
        toolUseId: `tu_${crypto.randomUUID()}`,
        name: OFFER_INVITES_TOOL,
        input: { emails, roles: ["Vendas"], why: "A nova vendedora" },
      });
      if (res.type !== "result") throw new Error(res.type);
      return res.output;
    };
    const out = await offer(["ana@example.com"]);
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("Posted the invite card (emails: ana@example.com, roles: Vendas)");
    expect((await lastCard(f))?.card.params).toMatchObject({
      action: "invite_people",
      words: { emails: "ana@example.com", roles: "Vendas" },
      why: "A nova vendedora",
    });
    // A second card that waits on the person in the same turn is held back, by either way to it.
    expect((await offer(["bia@example.com"])).content).toContain("one thing at a time");
    const again = await act(f, ctx, { action: "invite_people", input: { emails: ["bia@example.com"] } });
    expect(again.content).toContain("one thing at a time");
    expect(await invitations(f)).toEqual([]);
    // A role that isn't one, or an address that isn't one, posts nothing.
    await finish(f, ctx);
    const next = await lodiRun(f, f.owner.id, "convida mais gente");
    const wrong = await act(f, next, {
      action: "invite_people",
      input: { emails: ["caio@example.com"], roles: ["Nada"] },
    });
    expect(wrong).toMatchObject({ isError: true, content: expect.stringContaining('No role "Nada"') });
    const bad = await act(f, next, { action: "invite_people", input: { emails: ["caio arroba example"] } });
    expect(bad).toMatchObject({ isError: true, content: "Not an email address: caio arroba example." });
  });

  test("nothing without a person behind the run: no card, no invitation, no inbox row", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "convida a ana");
    await f.db.update(schema.agentRuns).set({ background: true }).where(eq(schema.agentRuns.id, ctx.runId));
    // A routine's run may not even call the tools.
    const out = await act(f, ctx, { action: "invite_people", input: { emails: ["ana@example.com"] } });
    expect(out.isError).toBe(true);
    const offered = await gatewayOf(f).invoke(ctx, {
      toolUseId: `tu_${crypto.randomUUID()}`,
      name: OFFER_INVITES_TOOL,
      input: { emails: ["ana@example.com"], why: "x" },
    });
    expect(offered).toMatchObject({ output: { isError: true } });
    expect(await lastCard(f)).toBeNull();
    expect(await invitations(f)).toEqual([]);
    expect(await emailJobs(f)).toEqual([]);
    expect(await inbox(f)).toEqual([]);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("a member who can't invite asks for an admin role: sent on with who asked and every role, applied only by who may give it", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    const caio = await addMember(f.db, f.org.id, "member", "Caio Convida");
    // Caio may invite, but holds no role above Admin and not its keys.
    const leads = await createRole(f.db, f.owner.id, f.org.id, { name: "Leads", permissions: ["invite_people"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, caio.id, [leads.id]);
    const admin = await roleNamed(f, "Admin");
    const deps = SERVER_DEPS(f);
    const runs = async () => (await f.db.select().from(schema.agentRuns)).length;
    // She learns nothing of who is here already: her card names the owner's address like any other.
    const [owner] = await f.db.select().from(schema.users).where(eq(schema.users.id, f.owner.id));
    const ctx = await lodiRun(f, bia.id, "convida a nova chefe como admin");
    const out = await act(f, ctx, {
      action: "invite_people",
      input: { emails: ["chefe@example.com", owner?.email ?? ""], roles: ["Admin"] },
      why: "A nova chefe",
    });
    expect(out.content).toContain("They can't make this change");
    expect(out.content).not.toContain("already");
    const posted = await lastCard(f);
    if (!posted) throw new Error("no card");
    const [runsBefore, jobsBefore] = [await runs(), await jobKinds(f)];
    // Her own tap is refused by the invite screen's own check, and the card then sends it on.
    await expect(
      decideWorkspaceAction(deps, bia.id, f.org.id, posted.id, "apply", "invite_people"),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
    expect((await cardNow(f, posted.id)).params.refused).toBe(true);
    // Nobody else reads her conversation with Lodi until she sends the card.
    await expect(getWorkspaceActionCard(f.db, caio.id, f.org.id, posted.id)).rejects.toThrow();
    expect(await inbox(f)).toEqual([]);
    await askWorkspaceAction(deps, bia.id, f.org.id, posted.id);
    const rows = await inbox(f);
    expect(rows.map((n) => n.userId).sort()).toEqual([caio.id, f.owner.id].sort());
    for (const n of rows) {
      expect(n.actors).toEqual([{ type: "user", id: bia.id }]);
      expect(n.source).toMatchObject({ messageId: posted.id, action: "invite_people" });
      expect((n.latest as { text: string }).text).toBe(`A nova chefe: chefe@example.com, ${owner?.email} · Admin`);
    }
    // Sending it twice tells nobody twice.
    await expect(askWorkspaceAction(deps, bia.id, f.org.id, posted.id)).rejects.toMatchObject({
      code: "action_card.asked",
    });
    expect(await inbox(f)).toHaveLength(2);
    // Caio may invite, but not hand out a role above his own: refused, nobody invited.
    await expect(
      decideWorkspaceAction(deps, caio.id, f.org.id, posted.id, "apply", "invite_people"),
    ).rejects.toMatchObject({ code: "role.above_you" });
    expect(await invitations(f)).toEqual([]);
    expect(await emailJobs(f)).toEqual([]);
    // The owner may: sent as the owner, the member's address left out and said so.
    const card = await decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply", "invite_people");
    expect(card).toMatchObject({ state: "applied", decidedByUserId: f.owner.id });
    expect(card.params.words).toMatchObject({ invited: "chefe@example.com", already_member: owner?.email });
    expect(await invitations(f)).toMatchObject([
      { email: "chefe@example.com", invitedByUserId: f.owner.id, roleIds: [admin?.id] },
    ]);
    expect(await emailJobs(f)).toHaveLength(1);
    expect((await inbox(f)).every((n) => n.doneAt)).toBe(true);
    // Sending it on, the refusals and the tap ask no model anything: no run, and no job but the one email.
    expect(f.provider.calls).toHaveLength(0);
    expect(await runs()).toBe(runsBefore);
    expect(await jobKinds(f)).toEqual([...jobsBefore, "email.send"].sort());
  });

  test("an address that already held an invitation is told to whoever applied it, never to the conversation", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    await createInvitation(f.db, f.owner.id, f.org.id, { email: "segredo@example.com" });
    const ctx = await lodiRun(f, bia.id, "convida as duas");
    const out = await act(f, ctx, {
      action: "invite_people",
      input: { emails: ["segredo@example.com", "nova@example.com"] },
    });
    expect(out.content).not.toContain("already");
    const posted = await lastCard(f);
    if (!posted) throw new Error("no card");
    const deps = SERVER_DEPS(f);
    await expect(decideWorkspaceAction(deps, bia.id, f.org.id, posted.id, "apply", "invite_people")).rejects.toThrow();
    await askWorkspaceAction(deps, bia.id, f.org.id, posted.id);
    const announced: unknown[] = [];
    const stop = f.pubsub.subscribe(channelTopic(ctx.channelId), (e) => void announced.push(e));
    // The owner, who may invite, reads it in the answer to the tap.
    const mine = await decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply", "invite_people");
    stop();
    expect(mine.params.words).toMatchObject({ invited: "nova@example.com", already_invited: "segredo@example.com" });
    // Bia, and anyone else who reads the conversation, reads who was invited and no more.
    const hers = (await getWorkspaceActionCard(f.db, bia.id, f.org.id, posted.id)).card.params.words;
    expect(hers).toMatchObject({ invited: "nova@example.com" });
    expect(hers).not.toHaveProperty("already_invited");
    const [receipt] = (await actionsFor(f.db, f.org.id, [posted.id])).get(posted.id) ?? [];
    expect(receipt?.params).not.toHaveProperty("already_invited");
    expect(announced.length).toBeGreaterThan(0);
    expect(JSON.stringify(announced)).not.toContain("already_invited");
  });

  test("a workspace on hold at the tap says so and leaves the card as it was: applied once the hold lifts", async () => {
    f = await setup({ rightHand: true });
    await act(f, await lodiRun(f, f.owner.id, "convida a ana"), {
      action: "invite_people",
      input: { emails: ["ana@example.com"] },
    });
    const posted = await lastCard(f);
    if (!posted) throw new Error("no card");
    const deps = SERVER_DEPS(f);
    const stand = (standing: "hold" | "active") =>
      f.db
        .update(schema.organizations)
        .set({ standing, standingReason: standing === "hold" ? "payment" : null })
        .where(eq(schema.organizations.id, f.org.id));
    await stand("hold");
    await expect(
      decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply", "invite_people"),
    ).rejects.toMatchObject({ code: "org.paused" });
    // Not a refusal of the person: the card doesn't turn into one that can only be sent on.
    const held = await cardNow(f, posted.id);
    expect(held.state).toBe("pending");
    expect(held.params.refused).toBeUndefined();
    await stand("active");
    await expect(askWorkspaceAction(deps, f.owner.id, f.org.id, posted.id)).rejects.toMatchObject({
      code: "action_card.yours",
    });
    expect(await decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply", "invite_people")).toMatchObject({
      state: "applied",
    });
    expect((await invitations(f)).map((i) => i.email)).toEqual(["ana@example.com"]);
  });

  test("a full workspace at the tap invites nobody and leaves the card to apply once there is room", async () => {
    f = await setup({ rightHand: true });
    await act(f, await lodiRun(f, f.owner.id, "convida a ana"), {
      action: "invite_people",
      input: { emails: ["ana@example.com"] },
    });
    const posted = await lastCard(f);
    if (!posted) throw new Error("no card");
    await f.db.update(schema.organizations).set({ limitMembers: 1 }).where(eq(schema.organizations.id, f.org.id));
    await expect(
      decideWorkspaceAction(SERVER_DEPS(f), f.owner.id, f.org.id, posted.id, "apply", "invite_people"),
    ).rejects.toMatchObject({ code: "org.members_full" });
    const card = await cardNow(f, posted.id);
    expect(card.state).toBe("pending");
    expect(card.params.refused).toBeUndefined();
    expect(await invitations(f)).toEqual([]);
    expect(await emailJobs(f)).toEqual([]);
  });

  test("a role renamed or deleted since the card was posted: the tap is refused and the card says it as it is now", async () => {
    f = await setup({ rightHand: true });
    const estagio = await createRole(f.db, f.owner.id, f.org.id, { name: "Estagio" });
    const vendas = await createRole(f.db, f.owner.id, f.org.id, { name: "Vendas" });
    await act(f, await lodiRun(f, f.owner.id, "convida a ana como Estagio e Vendas"), {
      action: "invite_people",
      input: { emails: ["ana@example.com"], roles: ["Estagio", "Vendas"] },
    });
    const posted = await lastCard(f);
    if (!posted) throw new Error("no card");
    const deps = SERVER_DEPS(f);
    const tap = () => decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply", "invite_people");
    // Renamed and given the billing key: no longer the role the card names.
    await updateRole(f.db, f.owner.id, f.org.id, estagio.id, {
      name: "Financeiro",
      permissions: ["manage_billing"],
    });
    await expect(tap()).rejects.toMatchObject({ code: "action_card.changed" });
    expect(await invitations(f)).toEqual([]);
    expect(await emailJobs(f)).toEqual([]);
    expect(await cardNow(f, posted.id)).toMatchObject({
      state: "pending",
      params: {
        input: { emails: ["ana@example.com"], roleIds: [estagio.id, vendas.id], roleNames: ["Financeiro", "Vendas"] },
        words: { emails: "ana@example.com", roles: "Financeiro, Vendas" },
      },
    });
    // A role deleted leaves the card too.
    await deleteRole(f.db, f.owner.id, f.org.id, vendas.id);
    await expect(tap()).rejects.toMatchObject({ code: "action_card.changed" });
    expect((await cardNow(f, posted.id)).params).toMatchObject({
      input: { roleIds: [estagio.id], roleNames: ["Financeiro"] },
      words: { roles: "Financeiro" },
    });
    // Read again as it is, it applies.
    expect(await tap()).toMatchObject({ state: "applied" });
    expect(await invitations(f)).toMatchObject([{ email: "ana@example.com", roleIds: [estagio.id] }]);
  });

  test("an address the invite screen would refuse never reaches a card, and one found at the tap is named", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "convida");
    const out = await act(f, ctx, { action: "invite_people", input: { emails: ["a[1]@example.com"] } });
    expect(out).toMatchObject({ isError: true, content: "Not an email address: a[1]@example.com." });
    expect(await lastCard(f)).toBeNull();
    // A card that holds one all the same says the real cause at the tap, not "already here".
    const id = await postCard(f, ctx.channelId, ctx.agentId, {
      ...pending,
      forUserId: f.owner.id,
      params: {
        action: "invite_people",
        input: { emails: ["a[1]@example.com"], roleIds: [], roleNames: [] },
        words: { emails: "a[1]@example.com", roles: "" },
        needs: "invite_people",
        why: "",
      },
    });
    await expect(
      decideWorkspaceAction(SERVER_DEPS(f), f.owner.id, f.org.id, id, "apply", "invite_people"),
    ).rejects.toMatchObject({ code: "invalid_email", message: expect.stringContaining("a[1]@example.com") });
    expect((await cardNow(f, id)).state).toBe("pending");
    expect(await invitations(f)).toEqual([]);
  });

  test("who may invite hears at once who is already here; with nobody new at the tap, the card says so and stays", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await createInvitation(f.db, f.owner.id, f.org.id, { email: "convidada@example.com" });
    const [biaRow] = await f.db.select().from(schema.users).where(eq(schema.users.id, bia.id));
    const mine = await act(f, await lodiRun(f, f.owner.id, "convida a bia e a convidada"), {
      action: "invite_people",
      input: { emails: [biaRow?.email ?? "", "convidada@example.com", "nova@example.com"] },
    });
    expect(mine.isError).toBe(true);
    expect(mine.content).toContain(`already in the workspace: ${biaRow?.email}`);
    expect(mine.content).toContain("already invited (resend_invitation sends it again): convidada@example.com");
    expect(await lastCard(f)).toBeNull();
    // Bia can't invite, so her card goes up as asked and the tap finds nobody new.
    const hers = await act(f, await lodiRun(f, bia.id, "convida a convidada"), {
      action: "invite_people",
      input: { emails: ["convidada@example.com"] },
    });
    expect(hers.content).toContain("Posted a card");
    const posted = await lastCard(f);
    if (!posted) throw new Error("no card");
    const deps = SERVER_DEPS(f);
    await askWorkspaceAction(deps, bia.id, f.org.id, posted.id);
    await expect(
      decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply", "invite_people"),
    ).rejects.toMatchObject({ code: "action_card.nobody_new" });
    expect((await cardNow(f, posted.id)).state).toBe("pending");
    expect(await invitations(f)).toHaveLength(1);
    expect(await emailJobs(f)).toEqual([]);
    // Dismissed by who may, it is over.
    expect(await decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "dismiss")).toMatchObject({
      state: "dismissed",
    });
  });

  test("an API key is removed from its card by who manages keys, never while an agent thinks with it", async () => {
    f = await setup({ rightHand: true });
    // The workspace's own key stays its default: agents on Automatic think with that one, not with the new key.
    const [own] = await keys(f);
    await makeDefaultCredential(f.db, f.owner.id, f.org.id, own?.id ?? "");
    const has = async () => (await keys(f)).some((k) => k.label === "Chave antiga");
    const key = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
      provider: "deepseek",
      label: "Chave antiga",
      apiKey: "sk-test-key-not-real-0001",
    });
    const deps = SERVER_DEPS(f);
    const ask = async (userId: string, input: Record<string, unknown> = { key: "chave antiga" }) => {
      const ctx = await lodiRun(f, userId, "remove a chave antiga");
      const out = await act(f, ctx, { action: "remove_ai_key", input, why: "Não usamos mais" });
      await finish(f, ctx);
      return out;
    };
    // A member who doesn't manage keys gets no card, and no key's name.
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    const hers = await ask(bia.id);
    expect(hers.isError).toBe(true);
    expect(hers.content).toContain("their roles don't let them manage AI keys");
    expect(hers.content).not.toContain("Chave antiga");
    // In use: refused before any card, naming who thinks with it.
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { credentialId: key.id });
    const used = await ask(f.owner.id);
    expect(used.isError).toBe(true);
    expect(used.content).toContain(`${f.agent.name} still thinks with Chave antiga (DeepSeek)`);
    expect(await lastCard(f)).toBeNull();
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { credentialId: null });
    // A name that is no key says which there are, and where a plan's sign-in is removed.
    const none = await ask(f.owner.id, { key: "Claude Max" });
    expect(none.content).toContain('No API key "Claude Max". Keys here: ');
    expect(none.content).toContain("Chave antiga (DeepSeek)");
    expect(none.content).toContain("offer_open_page ai_accounts");
    // Free: a card, by its label or its provider, and nothing removed yet.
    const out = await ask(f.owner.id, { key: "DeepSeek" });
    expect(out.content).toContain("Posted a card to remove_ai_key (name: Chave antiga, provider: DeepSeek)");
    const posted = await lastCard(f);
    if (!posted) throw new Error("no card");
    expect(posted.card.params).toMatchObject({
      action: "remove_ai_key",
      needs: "manage_credentials",
      input: { credentialId: key.id, name: "Chave antiga" },
      words: { name: "Chave antiga", provider: "DeepSeek" },
    });
    expect(await has()).toBe(true);
    await expect(decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply")).rejects.toMatchObject({
      code: "action_card.update_app",
    });
    // An agent came to think with it since: the tap is refused as its screen would.
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { credentialId: key.id });
    await expect(
      decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply", "remove_ai_key"),
    ).rejects.toMatchObject({ code: "credential.in_use", params: { agents: f.agent.name } });
    expect(await has()).toBe(true);
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { credentialId: null });
    // The key was replaced and renamed under the same id since: the card names a key that is not this one any more.
    // The tap is refused, nothing is removed, and the card reads the new name before anyone taps again.
    await f.db
      .update(schema.providerCredentials)
      .set({ label: "Produção" })
      .where(eq(schema.providerCredentials.id, key.id));
    await expect(
      decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply", "remove_ai_key"),
    ).rejects.toMatchObject({ code: "action_card.changed" });
    expect(await keys(f)).toHaveLength(2);
    expect(await cardNow(f, posted.id)).toMatchObject({
      state: "pending",
      params: { input: { credentialId: key.id, name: "Produção" }, words: { name: "Produção", provider: "DeepSeek" } },
    });
    const card = await decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply", "remove_ai_key");
    expect(card).toMatchObject({ state: "applied", decidedByUserId: f.owner.id });
    expect(await has()).toBe(false);
    expect(await keys(f)).toHaveLength(1);
    const [receipt] = (await actionsFor(f.db, f.org.id, [posted.id])).get(posted.id) ?? [];
    expect(receipt?.params).toMatchObject({ action: "remove_ai_key", name: "Produção", provider: "DeepSeek" });
    await expect(
      decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply", "remove_ai_key"),
    ).rejects.toThrow("already decided");
    expect(f.provider.calls).toHaveLength(0);
  });

  test("a key's name stays out of a conversation others read", async () => {
    f = await setup({ rightHand: true });
    await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
      provider: "deepseek",
      label: "Chave antiga",
      apiKey: "sk-test-key-not-real-0002",
    });
    const ctx = await lodiRun(f, f.owner.id, "remove a chave antiga");
    const out = await act(
      f,
      { ...ctx, channelId: f.general.id },
      { action: "remove_ai_key", input: { key: "Chave antiga" } },
    );
    expect(out.isError).toBe(true);
    expect(out.content).toContain("a key's name stays out of conversations others read");
    expect(await lastCard(f)).toBeNull();
    expect(await keys(f)).toHaveLength(2);
  });
});
