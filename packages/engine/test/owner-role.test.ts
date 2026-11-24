import { afterEach, expect, test } from "bun:test";
import { schema, sql } from "@agenteschat/db";
import {
  agentOwnerIds,
  approverIds,
  canTalkTo,
  createAgent,
  createRole,
  decidableBySql,
  decides,
  deleteRole,
  editsAgent,
  ForbiddenError,
  getAgent,
  getMembership,
  NEW_AGENT_DEFAULTS,
  notifiedIds,
  ownsAgent,
  setMemberRoles,
  speakerOf,
  updateAgent,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

// A role answers for an agent (ADR 0085, addendum of 2026-11-21): whoever holds it at the time is its owner for what is
// asked, told and decided; a person and a role never both.

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** A workspace with Bia and Caio in "Tech", Dani outside it, and the agent handed to "Tech". */
async function techTeam() {
  f = await setup();
  const [bia, caio, dani] = await Promise.all(
    ["bia", "caio", "dani"].map((n) => addMember(f.db, f.org.id, "member", n)),
  );
  if (!bia || !caio || !dani) throw new Error("no members");
  const tech = await createRole(f.db, f.owner.id, f.org.id, { name: "Tech", permissions: ["talk_to_agents"] });
  await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, [tech.id]);
  await setMemberRoles(f.db, f.owner.id, f.org.id, caio.id, [tech.id]);
  const agent = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerRoleId: tech.id });
  return { bia, caio, dani, tech, agent };
}

let n = 0;
/** A request of the agent, kept as the gateway keeps it: who answered for the agent when it asked. */
async function ask(owner: { ownerUserId: string | null; ownerRoleId: string | null }) {
  n += 1;
  const [row] = await f.db
    .insert(schema.approvals)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      toolUseId: `use-${n}`,
      tool: "notes_create_page",
      scope: "notes:write",
      params: {},
      actionHash: `hash-${n}`,
      title: `Create page ${n}`,
      expiresAt: new Date(Date.now() + 3_600_000),
      highRisk: false,
      ...owner,
    })
    .returning();
  if (!row) throw new Error("no approval");
  return row;
}

const membershipOf = async (userId: string) => {
  const m = await getMembership(f.db, userId, f.org.id);
  if (!m) throw new Error("not a member");
  return m;
};

/** Whether `userId` finds the request among those they may decide, as the sidebar's count reads it. */
async function countsFor(userId: string, approvalId: string) {
  const rows = await f.db
    .select({ id: schema.approvals.id })
    .from(schema.approvals)
    .where(sql`${schema.approvals.id} = ${approvalId} and ${decidableBySql(userId)}`);
  return rows.length === 1;
}

test("naming a role clears the person, and whoever holds the role answers for the agent", async () => {
  const { bia, caio, dani, tech, agent } = await techTeam();
  expect(agent.ownerUserId).toBeNull();
  expect(agent.ownerRoleId).toBe(tech.id);
  expect((await agentOwnerIds(f.db, f.org.id, agent)).sort()).toEqual([bia.id, caio.id].sort());

  const asBia = await membershipOf(bia.id);
  const asDani = await membershipOf(dani.id);
  expect(ownsAgent(agent, bia.id, asBia.roleIds)).toBe(true);
  expect(ownsAgent(agent, dani.id, asDani.roleIds)).toBe(false);
  expect(editsAgent(agent, bia.id, asBia)).toBe(true);
  expect(editsAgent(agent, dani.id, asDani)).toBe(false);
});

test("under only its owner, whoever holds the role talks to it and nobody else does", async () => {
  const { bia, dani } = await techTeam();
  const [agent] = await f.db
    .update(schema.agents)
    .set({ audienceMode: "owner" })
    .where(sql`${schema.agents.id} = ${f.agent.id}`)
    .returning();
  if (!agent) throw new Error("no agent");
  expect(canTalkTo(agent, bia.id, speakerOf(await membershipOf(bia.id)))).toBe(true);
  expect(canTalkTo(agent, dani.id, speakerOf(await membershipOf(dani.id)))).toBe(false);
});

test("any holder of the role decides its requests, is told of them, and so does whoever joins it later", async () => {
  const { bia, caio, dani, tech } = await techTeam();
  const request = await ask({ ownerUserId: null, ownerRoleId: tech.id });

  expect(decides(request, bia.id, await membershipOf(bia.id), null)).toBe(true);
  expect(decides(request, dani.id, await membershipOf(dani.id), null)).toBe(false);
  expect(await countsFor(bia.id, request.id)).toBe(true);
  expect(await countsFor(dani.id, request.id)).toBe(false);
  // The role's people are told, not the admins: they still find it in Aprovações.
  expect((await notifiedIds(f.db, request)).sort()).toEqual([bia.id, caio.id].sort());
  expect(await approverIds(f.db, request)).toContain(f.owner.id);

  await setMemberRoles(f.db, f.owner.id, f.org.id, dani.id, [tech.id]);
  expect(decides(request, dani.id, await membershipOf(dani.id), null)).toBe(true);
  expect(await countsFor(dani.id, request.id)).toBe(true);
});

test("a person or a role, never both, and the role must be one of the workspace's own", async () => {
  const { bia, tech } = await techTeam();
  const person = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: bia.id });
  expect(person.ownerUserId).toBe(bia.id);
  expect(person.ownerRoleId).toBeNull();

  await expect(
    updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: bia.id, ownerRoleId: tech.id }),
  ).rejects.toMatchObject({ code: "agent.owner_both" });
  await expect(
    updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerRoleId: crypto.randomUUID() }),
  ).rejects.toMatchObject({ code: "agent.owner_role_unknown" });
});

test("a member makes their own agents: handing a new one to a role is for who manages agents", async () => {
  const { bia, tech } = await techTeam();
  await expect(
    createAgent(f.db, bia.id, f.org.id, { name: "Ops", handle: "ops", ownerRoleId: tech.id }, NEW_AGENT_DEFAULTS),
  ).rejects.toBeInstanceOf(ForbiddenError);
  const made = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ops", handle: "ops", ownerRoleId: tech.id },
    NEW_AGENT_DEFAULTS,
  );
  expect(made.ownerUserId).toBeNull();
  expect(made.ownerRoleId).toBe(tech.id);
});

test("deleting the role leaves the agent with no owner, and its waiting requests go to the admins", async () => {
  const { bia, tech } = await techTeam();
  const request = await ask({ ownerUserId: null, ownerRoleId: tech.id });
  await deleteRole(f.db, f.owner.id, f.org.id, tech.id);

  const agent = await getAgent(f.db, f.org.id, f.agent.id);
  expect(agent?.ownerUserId).toBeNull();
  expect(agent?.ownerRoleId).toBeNull();
  expect(decides(request, bia.id, await membershipOf(bia.id), null)).toBe(false);
  expect(await notifiedIds(f.db, request)).toEqual([f.owner.id]);
});
