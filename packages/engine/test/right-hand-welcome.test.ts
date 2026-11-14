import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryRateLimiter } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  acceptInvitation,
  approveJoinRequest,
  askToJoin,
  createInvitation,
  drainOutbox,
  inviteLink,
  joinOrganization,
  liveLodiSwitches,
  type MemberRole,
  openPersonAgentDm,
  postPersonMessage,
  RIGHT_HAND,
  removeMember,
  rightHandPrompt,
  updateOrgSettings,
} from "../src";
import { NEWCOMER_DAYS, newcomerBlock, postWelcome, WELCOME_JOB, welcomeLane } from "../src/right-hand-welcome";
import { addUser, type Fixture, SECRET, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const DAY = 24 * 3_600_000;
const PUBLIC = "https://agentes.test/";

const lodiOf = async (fx: Fixture) => {
  const [lodi] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

/** A person who becomes a member the way an accepted invitation and an approved request both do. */
const join = async (fx: Fixture, name: string, role: MemberRole = "member") => {
  const user = await addUser(fx.db, name);
  await fx.db.transaction((tx) => joinOrganization(tx, fx.org.id, user.id, role));
  return user;
};

const welcomeJobs = (fx: Fixture) => fx.db.select().from(schema.outbox).where(eq(schema.outbox.kind, WELCOME_JOB));

const greet = (fx: Fixture, userId: string) => postWelcome(fx.jobDeps, fx.org.id, { userId });

/** Everything the right hand ever wrote, anywhere. */
const said = async (fx: Fixture) =>
  fx.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.authorAgentId, (await lodiOf(fx)).id));

const rings = (fx: Fixture) =>
  fx.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "notifications.message"));

const joinedAgo = (fx: Fixture, userId: string, days: number) =>
  fx.db
    .update(schema.organizationMembers)
    .set({ createdAt: new Date(Date.now() - days * DAY) })
    .where(and(eq(schema.organizationMembers.orgId, fx.org.id), eq(schema.organizationMembers.userId, userId)));

describe("who is greeted", () => {
  test("a person who joins gets one message in their own DM, in their language, with the areas to tap", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf(f);
    const bia = await join(f, "bia");
    const jobs = await welcomeJobs(f);
    expect(jobs.map((j) => [j.payload, j.dedupeKey])).toEqual([
      [{ userId: bia.id }, `right_hand.welcome:${f.org.id}:${bia.id}`],
    ]);
    // The server's own handler is the lane's job.
    await f.handlers[WELCOME_JOB]?.(jobs[0] as never, {} as never);
    const dm = await openPersonAgentDm(f.db, f.org.id, bia.id, lodi.id);
    const all = await said(f);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      channelId: dm.id,
      body: "Você acabou de entrar na Acme. **Do que você cuida por aqui?** Me conta e eu monto seu primeiro agente com você.",
    });
    expect(all[0]?.meta).toEqual({
      bodyCode: "welcome_member",
      bodyParams: { org: "Acme" },
      forUserId: bia.id,
      replyChips: {
        choices: ["Desenvolvimento", "Marketing", "Vendas", "Finanças", "Operações", "Atendimento"],
        multiple: false,
        step: 1,
        of: 1,
      },
    });
    // It rings as any new message does, and nobody else's conversation got a line.
    expect((await rings(f)).map((j) => j.payload)).toEqual([{ messageId: all[0]?.id }]);
    // The ring reaches the newcomer and nobody else: one row in their inbox, as a message sent to them (nobody
    // asked, so it is no reply), with its own words in their language.
    await drainOutbox(f.db, f.handlers);
    const inbox = await f.db.select().from(schema.notifications);
    expect(inbox.map((n) => [n.userId, n.kind, n.source.messageId])).toEqual([[bia.id, "dm", all[0]?.id]]);
    expect(inbox[0]?.latest).toEqual({
      text: "Você acabou de entrar na Acme. Do que você cuida por aqui? Me conta e eu monto seu primeiro agente com você.",
    });
    expect(await f.db.select({ id: schema.messages.id }).from(schema.messages)).toHaveLength(1);
    // The greeting is stored text: no model was called, and nothing was made for them.
    expect(f.provider.calls).toHaveLength(0);
    expect(await f.db.select().from(schema.agents).where(eq(schema.agents.ownerUserId, bia.id))).toEqual([]);
  });

  test("an accepted invitation queues it, and an English reader reads English", async () => {
    f = await setup({ rightHand: true });
    const { token } = await createInvitation(f.db, f.owner.id, f.org.id, { email: "caio@example.com", secret: SECRET });
    const caio = { id: (await addUser(f.db, "caio")).id, email: "caio@example.com" };
    await f.db.update(schema.users).set({ locale: "en" }).where(eq(schema.users.id, caio.id));
    await acceptInvitation(f.db, caio, token);
    expect((await welcomeJobs(f)).map((j) => j.payload)).toEqual([{ userId: caio.id }]);
    await greet(f, caio.id);
    const [m] = await said(f);
    expect(m?.body).toBe(
      "You just joined Acme. **What do you look after here?** Tell me and I set up your first agent with you.",
    );
    expect(m?.meta).toMatchObject({
      replyChips: { choices: ["Development", "Marketing", "Sales", "Finance", "Operations", "Customer support"] },
    });
  });

  test("an approved request to join queues it once and gives one message", async () => {
    f = await setup({ rightHand: true });
    const deps = { db: f.db, pubsub: f.pubsub, rateLimiter: createMemoryRateLimiter() };
    const { token } = await inviteLink(f.db, SECRET, f.owner.id, f.org.id);
    const dora = await addUser(f.db, "dora");
    await f.db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, dora.id));
    await askToJoin(deps, PUBLIC, { token, user: dora });
    const [asked] = await f.db.select().from(schema.organizationJoinRequests);
    expect(await welcomeJobs(f)).toEqual([]);
    expect(await approveJoinRequest(deps, PUBLIC, f.owner.id, f.org.id, asked?.id ?? "")).toEqual({
      outcome: "joined",
    });
    const jobs = await welcomeJobs(f);
    expect(jobs.map((j) => j.payload)).toEqual([{ userId: dora.id }]);
    await f.handlers[WELCOME_JOB]?.(jobs[0] as never, {} as never);
    await greet(f, dora.id);
    const all = await said(f);
    expect(all.map((m) => m.meta.bodyCode)).toEqual(["welcome_member"]);
    expect(await rings(f)).toHaveLength(1);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("someone whose area the onboarding knows is not asked to tap it again", async () => {
    f = await setup({ rightHand: true });
    const bia = await join(f, "bia");
    await f.db.update(schema.users).set({ workArea: "sales" }).where(eq(schema.users.id, bia.id));
    await greet(f, bia.id);
    const [m] = await said(f);
    expect(m?.meta).toEqual({ bodyCode: "welcome_member", bodyParams: { org: "Acme" }, forUserId: bia.id });
    // Skipped, or "something else": the areas come.
    const caio = await join(f, "caio");
    await f.db.update(schema.users).set({ workArea: "other" }).where(eq(schema.users.id, caio.id));
    await greet(f, caio.id);
    expect((await said(f)).filter((x) => "replyChips" in x.meta)).toHaveLength(1);
  });
});

describe("silence", () => {
  test("once per person and workspace: not on a second run of the job, not on a rejoin", async () => {
    f = await setup({ rightHand: true });
    const bia = await join(f, "bia");
    // Two runs started together, then a retry after both ended.
    await Promise.all([greet(f, bia.id), greet(f, bia.id)]);
    await greet(f, bia.id);
    expect(await said(f)).toHaveLength(1);
    expect(await rings(f)).toHaveLength(1);
    // Already a member: joining again queues nothing.
    await f.db.transaction((tx) => joinOrganization(tx, f.org.id, bia.id, "member"));
    expect(await welcomeJobs(f)).toHaveLength(1);
    // Removed and back: the key was spent for good.
    await removeMember(f.db, f.owner.id, f.org.id, bia.id);
    await f.db.transaction((tx) => joinOrganization(tx, f.org.id, bia.id, "member"));
    expect(await welcomeJobs(f)).toHaveLength(1);
    await greet(f, bia.id);
    expect(await said(f)).toHaveLength(1);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("never the workspace's creator, nor any owner", async () => {
    f = await setup({ rightHand: true });
    expect(await welcomeJobs(f)).toEqual([]);
    // Nor an owner invited later, with the first-run checklist there or not.
    const dora = await join(f, "dora", "owner");
    await greet(f, dora.id);
    const lodi = await lodiOf(f);
    expect(lodi.setup).not.toBeNull();
    await f.db.update(schema.agents).set({ setup: null }).where(eq(schema.agents.id, lodi.id));
    const enzo = await join(f, "enzo", "owner");
    await greet(f, enzo.id);
    expect(await said(f)).toEqual([]);
    expect(await rings(f)).toEqual([]);
  });

  test("none with the workspace's switch off, and none later for who was missed", async () => {
    f = await setup({ rightHand: true });
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { welcomePeople: false });
    const bia = await join(f, "bia");
    await greet(f, bia.id);
    expect(await said(f)).toEqual([]);
    // Turned on again: the job that ran is done, and nothing queues another.
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { welcomePeople: true });
    await f.db.transaction((tx) => joinOrganization(tx, f.org.id, bia.id, "member"));
    expect(await welcomeJobs(f)).toHaveLength(1);
  });

  test("none when they wrote first", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf(f);
    const bia = await join(f, "bia");
    const dm = await openPersonAgentDm(f.db, f.org.id, bia.id, lodi.id);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, dm.id, { body: "oi" });
    await greet(f, bia.id);
    expect(await said(f)).toEqual([]);
  });

  test("none on a hold, in a closed workspace, for someone who left or someone it may not talk to", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf(f);
    const org = (set: Partial<typeof schema.organizations.$inferInsert>) =>
      f.db.update(schema.organizations).set(set).where(eq(schema.organizations.id, f.org.id));
    const bia = await join(f, "bia");
    // Nothing answers on a hold: no promise of an agent.
    await org({ standing: "hold", standingReason: "payment", standingNotice: "shown" });
    await greet(f, bia.id);
    await org({ standing: "active", standingReason: null, deletionDueAt: new Date(Date.now() + 7 * DAY) });
    await greet(f, bia.id);
    await org({ deletionDueAt: null });
    // Only its owner's roles may talk to it.
    await f.db
      .update(schema.agents)
      .set({ audienceMode: "owner", ownerUserId: f.owner.id })
      .where(eq(schema.agents.id, lodi.id));
    await greet(f, bia.id);
    await f.db.update(schema.agents).set({ audienceMode: "everyone" }).where(eq(schema.agents.id, lodi.id));
    const caio = await join(f, "caio");
    await removeMember(f.db, f.owner.id, f.org.id, caio.id);
    await greet(f, caio.id);
    await postWelcome(f.jobDeps, f.org.id, {});
    expect(await said(f)).toEqual([]);
    expect(await rings(f)).toEqual([]);
    expect(f.provider.calls).toHaveLength(0);
    // The same person, once nothing stands in the way.
    await greet(f, bia.id);
    expect(await said(f)).toHaveLength(1);
  });
});

describe("while they are new", () => {
  const block = (fx: Fixture, personId: string) =>
    newcomerBlock(fx.db, { orgId: fx.org.id, agentId: "lodi", personId });

  test("its prompt says so in their DM: one agent, their own area, nobody else's data", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf(f);
    const bia = await join(f, "bia");
    const caio = await join(f, "caio");
    await f.db.update(schema.users).set({ workArea: "finance" }).where(eq(schema.users.id, caio.id));
    await joinedAgo(f, bia.id, 5);
    const text = await block(f, bia.id);
    expect(text).toContain("# Someone new");
    expect(text).toContain("propose_agent");
    expect(text).toContain("offer_connect_ai");
    expect(text).not.toContain("Finance");
    expect(await block(f, caio.id)).toContain("They work in Finance.");
    const prompt = (inDm: boolean) =>
      rightHandPrompt({ db: f.db }, { orgId: f.org.id, agent: lodi, personId: bia.id, inDm });
    expect(await prompt(true)).toContain("# Someone new");
    expect(await prompt(false)).not.toContain("# Someone new");
    expect(f.provider.calls).toHaveLength(0);
  });

  test("gone once they have an agent, after 30 days, for an owner and with the switch off", async () => {
    f = await setup({ rightHand: true });
    const bia = await join(f, "bia");
    await joinedAgo(f, bia.id, NEWCOMER_DAYS + 1);
    expect(await block(f, bia.id)).toBe("");
    await joinedAgo(f, bia.id, NEWCOMER_DAYS - 1);
    expect(await block(f, bia.id)).not.toBe("");
    // The creator, new as the workspace is, builds the first team instead.
    expect(await block(f, f.owner.id)).toBe("");
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { welcomePeople: false });
    expect(await block(f, bia.id)).toBe("");
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { welcomePeople: true });
    expect(await block(f, bia.id)).not.toBe("");
    await f.db.update(schema.agents).set({ ownerUserId: bia.id }).where(eq(schema.agents.id, f.agent.id));
    expect(await block(f, bia.id)).toBe("");
    // Not a member at all.
    expect(await block(f, (await addUser(f.db, "eva")).id)).toBe("");
  });
});

test("the lane is built: its switch shows and its job is the server's", async () => {
  f = await setup({ rightHand: true });
  expect(welcomeLane.live).toBe(true);
  expect(liveLodiSwitches()).toContain("welcomePeople");
  expect(Object.keys(welcomeLane.jobs)).toEqual([WELCOME_JOB]);
  expect(welcomeLane.sweep).toBeUndefined();
  expect(Object.keys(f.handlers)).toContain(WELCOME_JOB);
});
