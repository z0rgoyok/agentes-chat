import { afterEach, describe, expect, test } from "bun:test";
import { orgTopic, type RealtimeEvent } from "@agenteschat/adapters";
import { and, asc, eq, rowsOf, schema, sql } from "@agenteschat/db";
import {
  type AgentInput,
  agentEditorIds,
  agentManagerIds,
  archiveAgent,
  createAgent,
  createAgentGroup,
  createOrganization,
  createRole,
  createRoutine,
  deleteAgent,
  deleteAgentGroup,
  deleteRole,
  editAgent,
  editorsOf,
  editsAgent,
  editsAgentSql,
  ForbiddenError,
  getMembership,
  getRoutineView,
  getTeam,
  keysReach,
  keysReachSql,
  listAgentGroups,
  listFormerAgents,
  listRoutines,
  managesAgent,
  managesAgentSql,
  managesRoutinesOf,
  managesRoutinesSql,
  NotFoundError,
  orgOverview,
  RIGHT_HAND,
  removeMember,
  requireAgentDetails,
  seesAgentDetails,
  seesAgentDetailsSql,
  setAgentAudience,
  setAgentEditors,
  setMemberRoles,
  setReportsTo,
  setWorkspaceApprovalsLevel,
  unarchiveAgent,
  updateAgent,
  updateRoutine,
  ValidationError,
} from "../src";
import { addMember, addUser, everyoneWithout, type Fixture, setup } from "./fixtures";

/**
 * "Who can edit" (ADR 0085, addendum of 2026-11-17): an agent's owner, who manages it and the people and roles it names
 * edit how it works (instructions, role, skills, routines) and see it; "Edit agents" and "Create routines" reach only
 * the agents whose audience takes the person and the ones nobody owns, owners and administrators every agent; what
 * gives an agent more stays with who manages it.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const MODEL = { model: "claude-sonnet-5-5" };

/**
 * Acme's people besides Ana, its owner: Walt is an administrator; Lia, Leo and Lara hold "Edit agents" (Leads), Lia
 * also Suporte; Rui and Rita hold "Create routines" (Ops), Rui also Suporte; Eva holds nothing (named as an editor by
 * the tests), Rafa holds Revisores (a role named as an editor); Bia owns the agents the tests make. Zed is no member.
 */
async function world(options: { rightHand?: boolean } = {}) {
  f = await setup(options);
  const role = (name: string, permissions: string[] = []) =>
    createRole(f.db, f.owner.id, f.org.id, { name, permissions });
  const roles = {
    leads: await role("Leads", ["manage_agents"]),
    ops: await role("Ops", ["manage_routines"]),
    support: await role("Suporte"),
    reviewers: await role("Revisores"),
  };
  const member = async (name: string, roleIds: string[]) => {
    const user = await addMember(f.db, f.org.id, "member", name);
    if (roleIds.length > 0) await setMemberRoles(f.db, f.owner.id, f.org.id, user.id, roleIds);
    return user;
  };
  return {
    roles,
    walt: await addMember(f.db, f.org.id, "admin", "walt"),
    lia: await member("lia", [roles.leads.id, roles.support.id]),
    leo: await member("leo", [roles.leads.id]),
    lara: await member("lara", [roles.leads.id]),
    rui: await member("rui", [roles.ops.id, roles.support.id]),
    rita: await member("rita", [roles.ops.id]),
    eva: await member("eva", []),
    rafa: await member("rafa", [roles.reviewers.id]),
    bia: await member("bia", []),
    zed: await addUser(f.db, "zed"),
  };
}
type World = Awaited<ReturnType<typeof world>>;

/** An agent `ownerUserId` owns (none: nobody's), made by the workspace's owner; it answers everyone. */
const agentOf = (ownerUserId: string | null, name: string, extra: Partial<AgentInput> = {}) =>
  createAgent(f.db, f.owner.id, f.org.id, { name, handle: name.toLowerCase(), ownerUserId, ...extra }, MODEL);

/** Kept to its owner: a private agent. */
const keepPrivate = (w: World, agentId: string) =>
  setAgentAudience(f.db, w.bia.id, f.org.id, agentId, { mode: "owner", userIds: [] });

const rowOf = async (agentId: string) => {
  const [row] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  if (!row) throw new Error("no agent");
  return row;
};

describe("the rules in code and in SQL agree", () => {
  test("keys, managing, editing, routines and details: every audience, with an owner or none, editors named or not", async () => {
    const w = await world();
    const people = [f.owner, w.walt, w.lia, w.leo, w.lara, w.rui, w.rita, w.eva, w.rafa, w.bia, w.zed];
    const memberships = new Map(
      await Promise.all(people.map(async (p) => [p.id, await getMembership(f.db, p.id, f.org.id)] as const)),
    );
    let checked = 0;
    for (const ownerUserId of [w.bia.id, null])
      for (const audienceMode of ["everyone", "people", "owner"] as const)
        for (const named of [false, true]) {
          const set = {
            ownerUserId,
            audienceMode,
            audienceUserIds: [w.leo.id],
            audienceRoleIds: [w.roles.support.id],
            editorUserIds: named ? [w.eva.id] : [],
            editorRoleIds: named ? [w.roles.reviewers.id] : [],
          };
          const [row] = await f.db.update(schema.agents).set(set).where(eq(schema.agents.id, f.agent.id)).returning();
          if (!row) throw new Error("no agent");
          for (const person of people) {
            const membership = memberships.get(person.id) ?? null;
            const id = sql`${person.id}::text`;
            // As every use reads them: a filter, or `true` alone (SQL may say null for no).
            const [inSql] = rowsOf<Record<string, boolean>>(
              await f.db.execute(sql`select coalesce(${keysReachSql("a", id)}, false) as keys,
                  coalesce(${managesAgentSql("a", id)}, false) as manages,
                  coalesce(${editsAgentSql("a", id)}, false) as edits,
                  coalesce(${managesRoutinesSql("a", id)}, false) as routines,
                  coalesce(${seesAgentDetailsSql("a", id)}, false) as details
                from agents a where a.id = ${f.agent.id}::uuid`),
            );
            const inCode = {
              keys: keysReach(row, person.id, membership),
              manages: managesAgent(row, person.id, membership),
              edits: editsAgent(row, person.id, membership),
              routines: managesRoutinesOf(row, person.id, membership),
              details: seesAgentDetails(row, person.id, membership),
            };
            // `keysReachSql` reads no membership: it is only ever asked behind one of the workspace's keys.
            if (!membership) inCode.keys = inSql?.keys ?? false;
            expect({ ...set, person: person.name, ...inSql }).toEqual({ ...set, person: person.name, ...inCode });
            checked++;
          }
        }
    expect(checked).toBe(2 * 3 * 2 * 11);
  });

  test("who is told: who manages the agent, and who edits it", async () => {
    const w = await world();
    const ada = await agentOf(w.bia.id, "Ada");
    await setAgentAudience(f.db, w.bia.id, f.org.id, ada.id, {
      mode: "people",
      userIds: [w.leo.id],
      roleIds: [w.roles.support.id],
    });
    await setAgentEditors(f.db, w.bia.id, f.org.id, ada.id, { userIds: [w.eva.id], roleIds: [w.roles.reviewers.id] });
    const managers = [f.owner.id, w.walt.id, w.lia.id, w.leo.id];
    expect((await agentManagerIds(f.db, f.org.id, ada.id)).sort()).toEqual([...managers].sort());
    expect((await agentEditorIds(f.db, f.org.id, ada.id)).sort()).toEqual(
      [...managers, w.bia.id, w.eva.id, w.rafa.id].sort(),
    );
  });
});

describe('"Who can edit" (setAgentEditors)', () => {
  test("its owner names people and roles: the owner and who isn't a member drop out, each once; audited", async () => {
    const w = await world();
    const ada = await agentOf(w.bia.id, "Ada");
    const saved = await setAgentEditors(f.db, w.bia.id, f.org.id, ada.id, {
      userIds: [w.eva.id, w.bia.id, w.eva.id, w.zed.id, "not-a-member"],
      roleIds: [w.roles.reviewers.id, w.roles.reviewers.id],
    });
    expect(editorsOf(saved)).toEqual({ userIds: [w.eva.id], roleIds: [w.roles.reviewers.id] });
    expect(editorsOf(await rowOf(ada.id))).toEqual(editorsOf(saved));
    const audit = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "agent.editors_changed"), eq(schema.auditLog.targetId, ada.id)));
    expect(audit).toMatchObject([
      {
        actorId: w.bia.id,
        details: { from: { userIds: [], roleIds: [] }, to: { userIds: [w.eva.id], roleIds: [w.roles.reviewers.id] } },
      },
    ]);
  });

  test("every role must be one of the workspace's own, never its everyone; nothing is saved otherwise", async () => {
    const w = await world();
    const ada = await agentOf(w.bia.id, "Ada");
    const { organization: other } = await createOrganization(f.db, w.zed.id, { name: "Outra" });
    const theirs = await createRole(f.db, w.zed.id, other.id, { name: "Revisores" });
    const [everyone] = await f.db
      .select({ id: schema.orgRoles.id })
      .from(schema.orgRoles)
      .where(and(eq(schema.orgRoles.orgId, f.org.id), eq(schema.orgRoles.kind, "everyone")));
    if (!everyone) throw new Error("no everyone role");
    for (const roleId of [theirs.id, everyone.id, crypto.randomUUID()])
      await expect(
        setAgentEditors(f.db, w.bia.id, f.org.id, ada.id, {
          userIds: [w.eva.id],
          roleIds: [w.roles.reviewers.id, roleId],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    expect(editorsOf(await rowOf(ada.id))).toEqual({ userIds: [], roleIds: [] });
  });

  test("the team's right hand is the product's: nobody names who edits it", async () => {
    await world({ rightHand: true });
    const [lodi] = await f.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
    if (!lodi) throw new Error("no right hand");
    await expect(
      setAgentEditors(f.db, f.owner.id, f.org.id, lodi.id, { userIds: [], roleIds: [] }),
    ).rejects.toMatchObject({ code: "agent.right_hand_permanent" });
  });

  test("only its owner or who manages it sets it: not who it names, not the key alone on a private agent", async () => {
    const w = await world();
    const ada = await agentOf(w.bia.id, "Ada");
    await setAgentEditors(f.db, w.bia.id, f.org.id, ada.id, { userIds: [w.eva.id], roleIds: [] });
    // Who it names edits how it works, not who edits it.
    await expect(
      setAgentEditors(f.db, w.eva.id, f.org.id, ada.id, { userIds: [w.eva.id, w.rui.id], roleIds: [] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Answering everyone, "Edit agents" reaches it.
    const byLara = await setAgentEditors(f.db, w.lara.id, f.org.id, ada.id, { userIds: [w.rui.id], roleIds: [] });
    expect(editorsOf(byLara).userIds).toEqual([w.rui.id]);
    // Kept to its owner, it doesn't; an administrator still does.
    await keepPrivate(w, ada.id);
    await expect(
      setAgentEditors(f.db, w.lara.id, f.org.id, ada.id, { userIds: [], roleIds: [] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const byWalt = await setAgentEditors(f.db, w.walt.id, f.org.id, ada.id, { userIds: [w.eva.id], roleIds: [] });
    expect(editorsOf(byWalt).userIds).toEqual([w.eva.id]);
    // An archived agent has none to set.
    await archiveAgent(f.db, f.owner.id, f.org.id, ada.id);
    await expect(
      setAgentEditors(f.db, w.bia.id, f.org.id, ada.id, { userIds: [], roleIds: [] }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("who doesn't list every agent lists the ones they edit: in Equipe, its departments and its count", async () => {
    const w = await world();
    const ada = await agentOf(w.bia.id, "Ada");
    await keepPrivate(w, ada.id);
    await createAgentGroup({ db: f.db }, f.owner.id, f.org.id, { name: "Privado", agentIds: [ada.id] });
    await everyoneWithout(f.db, f.org.id, "view_all_agents");
    const listing = async (userId: string) => ({
      team: (await getTeam(f.db, userId, f.org.id)).agents.map((a) => a.name).sort(),
      groups: (await listAgentGroups(f.db, userId, f.org.id)).map((g) => `${g.name}:${g.agentIds.length}`),
      count: (await orgOverview(f.db, userId, f.org.id)).agents,
    });
    // Dev answers everyone; Ada, only Bia.
    expect(await listing(w.eva.id)).toEqual({ team: ["Dev"], groups: [], count: 1 });
    await setAgentEditors(f.db, w.bia.id, f.org.id, ada.id, { userIds: [w.eva.id], roleIds: [] });
    expect(await listing(w.eva.id)).toEqual({ team: ["Ada", "Dev"], groups: ["Privado:1"], count: 2 });
  });
});

describe("one change of an agent, or a new one, is decided whole against the agent as it was", () => {
  test("who manages it leaves themselves out of who talks to it and names themselves in one change (editAgent)", async () => {
    const w = await world();
    const ada = await agentOf(w.bia.id, "Ada");
    const heard: RealtimeEvent[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => heard.push(e));
    // Ada answers everyone, so Lara's "Edit agents" reaches it: every part is hers to make, the last ones included.
    const saved = await editAgent({ db: f.db, pubsub: f.pubsub }, w.lara.id, f.org.id, ada.id, {
      fields: { role: "QA" },
      audience: { mode: "people", userIds: [w.leo.id] },
      editors: { userIds: [w.lara.id], roleIds: [] },
      appearance: { color: "teal", eyes: "happy" },
    });
    const changed = {
      role: "QA",
      audienceMode: "people",
      audienceUserIds: [w.leo.id],
      editorUserIds: [w.lara.id],
      appearance: { color: "teal", eyes: "happy", accessory: "none" },
    };
    expect(saved).toMatchObject(changed);
    expect(await rowOf(ada.id)).toMatchObject(changed);
    // The apps hear it once, after it is saved.
    expect(heard).toEqual([{ type: "org.broadcast", orgId: f.org.id, event: { type: "agents.changed" } }]);
    // From now on she edits it, without managing it.
    const membership = await getMembership(f.db, w.lara.id, f.org.id);
    expect([managesAgent(saved, w.lara.id, membership), editsAgent(saved, w.lara.id, membership)]).toEqual([
      false,
      true,
    ]);
  });

  test("a part the person may not make, or a value refused on the way, saves none of the change", async () => {
    const w = await world();
    const ada = await agentOf(w.bia.id, "Ada");
    await setAgentEditors(f.db, w.bia.id, f.org.id, ada.id, { userIds: [w.eva.id], roleIds: [] });
    const heard: RealtimeEvent[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => heard.push(e));
    const deps = { db: f.db, pubsub: f.pubsub };
    // Eva edits its role, not who edits it: the role she sent with it isn't saved either.
    await expect(
      editAgent(deps, w.eva.id, f.org.id, ada.id, {
        fields: { role: "QA" },
        editors: { userIds: [w.eva.id, w.rui.id], roleIds: [] },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Its owner makes every part, but a role that isn't the workspace's refuses the audience, and with it the rest.
    await expect(
      editAgent(deps, w.bia.id, f.org.id, ada.id, {
        fields: { role: "QA" },
        audience: { mode: "people", userIds: [w.leo.id], roleIds: [crypto.randomUUID()] },
        editors: { userIds: [], roleIds: [] },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    // A change of nothing is who manages it's alone.
    await expect(editAgent(deps, w.eva.id, f.org.id, ada.id, {})).rejects.toBeInstanceOf(ForbiddenError);
    expect(await rowOf(ada.id)).toMatchObject({
      role: "",
      audienceMode: "everyone",
      audienceUserIds: [],
      editorUserIds: [w.eva.id],
    });
    expect(heard).toEqual([]);
  });

  test("its creator gives a new agent who talks to it, who edits it and its look, though the audience leaves them out", async () => {
    const w = await world();
    // Lara holds "Edit agents": she makes Bia an agent that answers Leo, names herself in its list and dresses it.
    const iara = await createAgent(
      f.db,
      w.lara.id,
      f.org.id,
      {
        name: "Iara",
        handle: "iara",
        ownerUserId: w.bia.id,
        audience: { mode: "people", userIds: [w.leo.id] },
        editors: { userIds: [w.lara.id], roleIds: [] },
        appearance: { color: "rose", eyes: "dots" },
      },
      MODEL,
    );
    const made = {
      ownerUserId: w.bia.id,
      audienceMode: "people",
      audienceUserIds: [w.leo.id],
      editorUserIds: [w.lara.id],
      appearance: { color: "rose", eyes: "dots", accessory: "none" },
    };
    expect(iara).toMatchObject(made);
    expect(await rowOf(iara.id)).toMatchObject(made);
    const audit = await f.db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, iara.id))
      .orderBy(asc(schema.auditLog.id));
    expect(audit.map((a) => a.action)).toEqual([
      "agent.created",
      "agent.audience_changed",
      "agent.editors_changed",
      "agent.appearance_changed",
    ]);
    // A value refused on the way makes no agent: its handle stays free.
    await expect(
      createAgent(
        f.db,
        w.lara.id,
        f.org.id,
        {
          name: "Nina",
          handle: "nina",
          ownerUserId: w.bia.id,
          audience: { mode: "people", userIds: [], roleIds: [crypto.randomUUID()] },
          editors: { userIds: [w.lara.id], roleIds: [] },
        },
        MODEL,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    const nina = await f.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.handle, "nina")));
    expect(nina).toEqual([]);
  });
});

describe("who changes what of an agent (updateAgent)", () => {
  test("who it names, by person or by role, changes its instructions and role, nothing that gives it more", async () => {
    const w = await world();
    const ada = await agentOf(w.bia.id, "Ada");
    await setAgentEditors(f.db, w.bia.id, f.org.id, ada.id, { userIds: [w.eva.id], roleIds: [w.roles.reviewers.id] });
    for (const editor of [w.eva, w.rafa]) {
      const changed = await updateAgent(f.db, editor.id, f.org.id, ada.id, {
        instructions: `Responda em português (${editor.name}).`,
        role: `Revisora (${editor.name})`,
      });
      expect(changed).toMatchObject({
        instructions: `Responda em português (${editor.name}).`,
        role: `Revisora (${editor.name})`,
      });
      for (const patch of [
        { monthlyBudgetNanoUsd: 5_000_000_000 },
        { approvalsLevel: "always" as const },
        { ownerUserId: editor.id },
        { model: "auto" },
        { name: "Ada Lima" },
        { role: "QA", monthlyBudgetNanoUsd: 5_000_000_000 },
      ])
        await expect(updateAgent(f.db, editor.id, f.org.id, ada.id, patch)).rejects.toBeInstanceOf(ForbiddenError);
    }
    // Anyone else in the workspace: not even its role.
    await expect(updateAgent(f.db, w.rui.id, f.org.id, ada.id, { role: "QA" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("its owner also picks its model and key, never its budget, how much it asks or who owns it", async () => {
    const w = await world();
    const ada = await agentOf(w.bia.id, "Ada");
    expect(
      await updateAgent(f.db, w.bia.id, f.org.id, ada.id, { instructions: "Seja breve.", role: "QA" }),
    ).toMatchObject({ instructions: "Seja breve.", role: "QA" });
    const keyed = await updateAgent(f.db, w.bia.id, f.org.id, ada.id, { credentialId: f.credential.id });
    expect(keyed.credentialId).toBe(f.credential.id);
    expect((await updateAgent(f.db, w.bia.id, f.org.id, ada.id, { model: "auto" })).model).toBe("auto");
    for (const patch of [
      { monthlyBudgetNanoUsd: 5_000_000_000 },
      { approvalsLevel: "never" as const },
      { ownerUserId: w.eva.id },
    ])
      await expect(updateAgent(f.db, w.bia.id, f.org.id, ada.id, patch)).rejects.toBeInstanceOf(ForbiddenError);
  });

  test('"Edit agents" changes anything of an agent whose audience takes them or nobody owns; an administrator any', async () => {
    const w = await world();
    const ada = await agentOf(w.bia.id, "Ada");
    await setAgentAudience(f.db, w.bia.id, f.org.id, ada.id, {
      mode: "people",
      userIds: [w.leo.id],
      roleIds: [w.roles.support.id],
    });
    // In its audience by name (Leo) or by role (Lia): its budget too.
    const budget = await updateAgent(f.db, w.leo.id, f.org.id, ada.id, { monthlyBudgetNanoUsd: 5_000_000_000 });
    expect(budget.monthlyBudgetNanoUsd).toBe(5_000_000_000);
    expect((await updateAgent(f.db, w.lia.id, f.org.id, ada.id, { name: "Ada Lima" })).name).toBe("Ada Lima");
    // Outside it (Lara): a 403, its role included.
    await expect(updateAgent(f.db, w.lara.id, f.org.id, ada.id, { role: "QA" })).rejects.toBeInstanceOf(ForbiddenError);
    // An administrator outside it: anything.
    const level = await updateAgent(f.db, w.walt.id, f.org.id, ada.id, { approvalsLevel: "always" });
    expect(level.approvalsLevel).toBe("always");
    // Nobody's agent stays someone's to look after.
    await updateAgent(f.db, f.owner.id, f.org.id, ada.id, { ownerUserId: null });
    expect((await updateAgent(f.db, w.lara.id, f.org.id, ada.id, { role: "QA" })).role).toBe("QA");
  });

  test("a new owner leaves its list: they edit it as its owner", async () => {
    const w = await world();
    const ada = await agentOf(w.bia.id, "Ada");
    await setAgentEditors(f.db, w.bia.id, f.org.id, ada.id, { userIds: [w.eva.id, w.rafa.id], roleIds: [] });
    await updateAgent(f.db, f.owner.id, f.org.id, ada.id, { ownerUserId: w.eva.id });
    expect(await rowOf(ada.id)).toMatchObject({ ownerUserId: w.eva.id, editorUserIds: [w.rafa.id] });
  });
});

describe("a private agent is out of reach of the keys alone", () => {
  test("how it works and its routines: not for 'Edit agents' or 'Create routines' outside it; for its editors", async () => {
    const w = await world();
    const ada = await agentOf(w.bia.id, "Ada");
    const deps = { db: f.db, pubsub: f.pubsub, context: f.context };
    const input = {
      name: "Resumo",
      agentId: ada.id,
      prompt: "Resume a semana.",
      target: { type: "dm" as const },
      trigger: { type: "schedule" as const, phrase: "toda segunda às 9h" },
    };
    const routine = await createRoutine(deps, w.bia.id, f.org.id, input);
    // Answering everyone, "Create routines" sets up its routines.
    expect((await listRoutines(f.db, w.rita.id, f.org.id)).find((r) => r.id === routine.id)).toMatchObject({
      canManage: true,
    });
    await keepPrivate(w, ada.id);
    for (const holder of [w.lara, w.rita]) {
      await expect(requireAgentDetails(f.db, holder.id, f.org.id, ada.id)).rejects.toMatchObject({
        code: "agent.details_hidden",
      });
      expect((await listRoutines(f.db, holder.id, f.org.id)).map((r) => r.id)).not.toContain(routine.id);
      await expect(getRoutineView(f.db, holder.id, f.org.id, routine.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(updateRoutine(deps, holder.id, f.org.id, routine.id, { active: false })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(createRoutine(deps, holder.id, f.org.id, input)).rejects.toBeInstanceOf(ForbiddenError);
    }
    // An administrator sees it all and manages its routines.
    expect((await requireAgentDetails(f.db, w.walt.id, f.org.id, ada.id)).id).toBe(ada.id);
    expect((await listRoutines(f.db, w.walt.id, f.org.id)).find((r) => r.id === routine.id)).toMatchObject({
      canManage: true,
    });
    // Who it names sees how it works and manages its routines, still not talking to it.
    await setAgentEditors(f.db, w.bia.id, f.org.id, ada.id, { userIds: [w.lara.id], roleIds: [] });
    expect((await requireAgentDetails(f.db, w.lara.id, f.org.id, ada.id)).id).toBe(ada.id);
    expect((await listRoutines(f.db, w.lara.id, f.org.id)).find((r) => r.id === routine.id)).toMatchObject({
      canManage: true,
    });
    expect((await updateRoutine(deps, w.lara.id, f.org.id, routine.id, { active: false })).active).toBe(false);
  });

  test("a supervisor the person doesn't manage takes nobody under it, nor its own line changes", async () => {
    const w = await world();
    const ada = await agentOf(w.bia.id, "Ada");
    const iara = await agentOf(w.bia.id, "Iara");
    const nina = await agentOf(w.bia.id, "Nina");
    await keepPrivate(w, nina.id);
    for (const change of [
      { agentId: ada.id, reportsToAgentId: nina.id },
      { agentId: nina.id, reportsToAgentId: ada.id },
    ])
      await expect(setReportsTo({ db: f.db }, w.lara.id, f.org.id, [change])).rejects.toBeInstanceOf(ForbiddenError);
    expect([(await rowOf(ada.id)).reportsToAgentId, (await rowOf(nina.id)).reportsToAgentId]).toEqual([null, null]);
    // Two agents she manages, and an administrator with the private one.
    expect(
      await setReportsTo({ db: f.db }, w.lara.id, f.org.id, [{ agentId: ada.id, reportsToAgentId: iara.id }]),
    ).toEqual({ previous: [{ agentId: ada.id, reportsToAgentId: null }] });
    await setReportsTo({ db: f.db }, w.walt.id, f.org.id, [{ agentId: ada.id, reportsToAgentId: nina.id }]);
    expect((await rowOf(ada.id)).reportsToAgentId).toBe(nina.id);
  });

  test("a department goes only with who manages every agent in it, and holds only agents they manage", async () => {
    const w = await world();
    const ada = await agentOf(w.bia.id, "Ada");
    const nina = await agentOf(w.bia.id, "Nina");
    const groups = await createAgentGroup({ db: f.db }, f.owner.id, f.org.id, {
      name: "Suporte",
      agentIds: [ada.id, nina.id],
    });
    const group = groups.find((g) => g.name === "Suporte");
    if (!group) throw new Error("no group");
    await keepPrivate(w, nina.id);
    await expect(deleteAgentGroup({ db: f.db }, w.lara.id, f.org.id, group.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createAgentGroup({ db: f.db }, w.lara.id, f.org.id, { name: "Vendas", agentIds: [nina.id] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await rowOf(nina.id)).groupId).toBe(group.id);
    const left = await deleteAgentGroup({ db: f.db }, w.walt.id, f.org.id, group.id);
    expect(left.map((g) => g.id)).not.toContain(group.id);
  });

  test("the workspace's approvals level is its owners' and administrators' alone", async () => {
    const w = await world();
    await expect(setWorkspaceApprovalsLevel(f.db, w.lara.id, f.org.id, "always")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await setWorkspaceApprovalsLevel(f.db, w.walt.id, f.org.id, "always")).toMatchObject({ level: "always" });
  });

  test("an archived agent says whether the viewer manages it; a deleted one has nobody to", async () => {
    const w = await world();
    const ada = await agentOf(w.bia.id, "Ada");
    const nina = await agentOf(w.bia.id, "Nina");
    await keepPrivate(w, nina.id);
    for (const a of [ada, nina]) await archiveAgent(f.db, f.owner.id, f.org.id, a.id);
    const deps = { db: f.db, pubsub: f.pubsub, hub: f.machineHub };
    // A deleted agent's tombstone names nobody as its editors.
    await setAgentEditors(f.db, f.owner.id, f.org.id, f.agent.id, {
      userIds: [w.eva.id],
      roleIds: [w.roles.reviewers.id],
    });
    await deleteAgent(deps, f.owner.id, f.org.id, f.agent.id);
    expect(editorsOf(await rowOf(f.agent.id))).toEqual({ userIds: [], roleIds: [] });
    const former = async (userId: string) =>
      (await listFormerAgents(f.db, userId, f.org.id)).map((a) => [a.name, a.deleted, a.canManage]);
    expect(await former(w.lara.id)).toEqual([
      ["Dev", true, undefined],
      ["Ada", false, true],
      ["Nina", false, false],
    ]);
    expect(await former(w.walt.id)).toEqual([
      ["Dev", true, undefined],
      ["Ada", false, true],
      ["Nina", false, true],
    ]);
    // Its owner doesn't bring it back or delete it: that is who manages it.
    expect(await former(w.bia.id)).toEqual([
      ["Dev", true, undefined],
      ["Ada", false, false],
      ["Nina", false, false],
    ]);
    await expect(unarchiveAgent(f.db, w.lara.id, f.org.id, nina.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteAgent(deps, w.lara.id, f.org.id, nina.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await rowOf(nina.id)).archivedAt).toBeInstanceOf(Date);
    await unarchiveAgent(f.db, w.lara.id, f.org.id, ada.id);
    expect((await rowOf(ada.id)).archivedAt).toBeNull();
  });
});

describe("the lists keep up with the workspace", () => {
  test("someone leaving drops off every agent's list; whoever takes their agents over leaves it too", async () => {
    const w = await world();
    const ada = await agentOf(w.bia.id, "Ada");
    await setAgentEditors(f.db, w.bia.id, f.org.id, ada.id, { userIds: [w.eva.id, f.owner.id], roleIds: [] });
    await removeMember(f.db, f.owner.id, f.org.id, w.eva.id);
    expect((await rowOf(ada.id)).editorUserIds).toEqual([f.owner.id]);
    // Bia leaves: Ada goes to whoever removes her, an owner, who edits it as its owner now.
    await removeMember(f.db, f.owner.id, f.org.id, w.bia.id);
    expect(await rowOf(ada.id)).toMatchObject({ ownerUserId: f.owner.id, editorUserIds: [] });
  });

  test("who removes someone with only 'Edit agents' doesn't take their agents: the workspace's owner does", async () => {
    const w = await world();
    const people = await createRole(f.db, f.owner.id, f.org.id, {
      name: "Pessoas",
      permissions: ["manage_members", "manage_agents"],
    });
    await setMemberRoles(f.db, f.owner.id, f.org.id, w.lara.id, [people.id]);
    const ada = await agentOf(w.bia.id, "Ada");
    await keepPrivate(w, ada.id);
    await removeMember(f.db, w.lara.id, f.org.id, w.bia.id);
    expect((await rowOf(ada.id)).ownerUserId).toBe(f.owner.id);
  });

  test("a role deleted leaves every agent's list; its copy joins the lists it was on", async () => {
    const w = await world();
    const ada = await agentOf(w.bia.id, "Ada");
    await setAgentEditors(f.db, w.bia.id, f.org.id, ada.id, { userIds: [], roleIds: [w.roles.reviewers.id] });
    const copy = await createRole(f.db, f.owner.id, f.org.id, { name: "Revisores 2", copyFrom: w.roles.reviewers.id });
    expect((await rowOf(ada.id)).editorRoleIds).toEqual([w.roles.reviewers.id, copy.id]);
    // Whoever holds the copy edits it as who holds the role.
    await setMemberRoles(f.db, f.owner.id, f.org.id, w.eva.id, [copy.id]);
    expect((await updateAgent(f.db, w.eva.id, f.org.id, ada.id, { role: "QA" })).role).toBe("QA");
    await deleteRole(f.db, f.owner.id, f.org.id, w.roles.reviewers.id);
    expect((await rowOf(ada.id)).editorRoleIds).toEqual([copy.id]);
    await expect(updateAgent(f.db, w.rafa.id, f.org.id, ada.id, { role: "Dev" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
