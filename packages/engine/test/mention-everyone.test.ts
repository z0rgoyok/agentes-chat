import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { mentionsEveryone } from "@agenteschat/i18n/everyone";
import {
  addChannelMember,
  answersForEveryone,
  createAgent,
  type createFakeJudge,
  createRole,
  drainOutbox,
  insertMessage,
  type Judge,
  listMembers,
  listNotifications,
  openDm,
  postPersonMessage,
  receiptsFor,
  replyPolicyFor,
  setAgentAudience,
  setMemberRoles,
  WHY_ANSWER_FOR_EVERYONE,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });

/**
 * #general: Ana (owner), Bia and Caio (members), `@dev` (answers anyone), `@ops` (answers only Caio, its owner) and
 * Lodi; `@fora` is outside it.
 */
async function world() {
  f = await setup({ rightHand: true, reply: () => ({ chunks: ["ok"] }) });
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  await listMembers(f.db, f.org.id);
  for (const u of [bia, caio]) await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: u.id });
  const model = { model: "claude-sonnet-5-5" };
  const ops = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ops", handle: "ops", ownerUserId: caio.id },
    model,
  );
  await setAgentAudience(f.db, f.owner.id, f.org.id, ops.id, { mode: "owner", userIds: [] });
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ops.id });
  const fora = await createAgent(f.db, f.owner.id, f.org.id, { name: "Fora", handle: "fora" }, model);
  const [lodi] = await f.db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, "right_hand")));
  if (!lodi) throw new Error("no right hand");
  await f.db
    .insert(schema.channelMembers)
    .values({ orgId: f.org.id, channelId: f.general.id, agentId: lodi.id })
    .onConflictDoNothing();
  return { bia, caio, ops, fora, lodi };
}

const runsOf = (messageId: string) =>
  f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, messageId));

describe("@todos (a mention of everyone)", () => {
  test("any language's word, as a mention, not inside a word or an email", () => {
    for (const body of ["@todos reunião às 15h", "oi @everyone", "@Alle bitte", "(@tous)", "@全員 確認して", "@все"])
      expect(mentionsEveryone(body)).toBe(true);
    for (const body of ["a@todos.com", "@todosx", "@всем", "todos", "@todo"])
      expect(mentionsEveryone(body)).toBe(false);
  });

  test("an owner's @todos mentions every person and wakes every agent that answers them here, never Lodi", async () => {
    const { bia, caio, ops, fora, lodi } = await world();
    const m = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "@todos reunião às 15h" });
    expect(m.meta).toMatchObject({ mentionsEveryone: true, everyoneAgentIds: [f.agent.id] });
    expect(new Set(m.mentionedUserIds)).toEqual(new Set([bia.id, caio.id]));
    // `@ops` answers only Caio and `@fora` isn't here; Lodi is never one of everyone.
    expect(m.mentionedAgentIds).toEqual([f.agent.id]);
    for (const id of [ops.id, fora.id, lodi.id]) expect(m.mentionedAgentIds).not.toContain(id);
    // No "won't answer you" notice for agents nobody named.
    expect(m.notices ?? []).toEqual([]);
    const [run] = await runsOf(m.id);
    expect(run).toMatchObject({ agentId: f.agent.id, trigger: "mention", hop: 1 });
    // Not named, so it may stay quiet like an agent the router brought in.
    expect(replyPolicyFor(run as NonNullable<typeof run>, { authorType: "person", meta: m.meta }).mayPass).toBe(true);
    await drainOutbox(f.db, f.handlers);
    for (const u of [bia, caio]) {
      const { items } = await listNotifications(deps(), u.id, f.org.id);
      expect(items.map((n) => n.kind)).toContain("mention");
    }
  });

  test("named too, an agent must answer; its run follows Caio's reach when he writes it", async () => {
    const { caio, ops } = await world();
    await f.db
      .update(schema.organizationMembers)
      .set({ role: "owner" })
      .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, caio.id)));
    const m = await postPersonMessage(deps(), caio.id, f.org.id, f.general.id, { body: "@everyone @dev olha isso" });
    expect(m.meta).toMatchObject({ mentionsEveryone: true, everyoneAgentIds: [ops.id] });
    expect(new Set(m.mentionedAgentIds)).toEqual(new Set([f.agent.id, ops.id]));
    const runs = await runsOf(m.id);
    expect(runs.map((r) => r.agentId).sort()).toEqual([f.agent.id, ops.id].sort());
    const dev = runs.find((r) => r.agentId === f.agent.id);
    expect(replyPolicyFor(dev as NonNullable<typeof dev>, { authorType: "person", meta: m.meta }).mayPass).toBe(false);
  });

  test("without `mention_everyone` it stays plain text, until a role gives it", async () => {
    const { bia } = await world();
    const plain = await postPersonMessage(deps(), bia.id, f.org.id, f.general.id, { body: "@todos bom dia" });
    expect(plain.meta.mentionsEveryone).toBeUndefined();
    expect(plain.mentionedUserIds).toEqual([]);
    expect(plain.mentionedAgentIds).toEqual([]);
    expect(await runsOf(plain.id)).toEqual([]);

    const role = await createRole(f.db, f.owner.id, f.org.id, { name: "Avisos", permissions: ["mention_everyone"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, [role.id]);
    const loud = await postPersonMessage(deps(), bia.id, f.org.id, f.general.id, { body: "@todos bom dia" });
    expect(loud.meta.mentionsEveryone).toBe(true);
    expect(loud.mentionedUserIds).toContain(f.owner.id);
    expect(loud.mentionedAgentIds).toEqual([f.agent.id]);
  });

  test("an agent never mentions everyone, and a message's meta can't claim it", async () => {
    await world();
    const said = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
      body: "@todos terminei",
      meta: { mentionsEveryone: true, everyoneAgentIds: [f.agent.id] },
    });
    expect(said.meta.mentionsEveryone).toBeUndefined();
    expect(said.meta.everyoneAgentIds).toBeUndefined();
    expect(said.mentionedUserIds).toEqual([]);
    expect(said.mentionedAgentIds).toEqual([]);
  });

  test("leaves out a held agent and what each agent asked; someone also named is mentioned once", async () => {
    const { bia } = await world();
    const asked = await postPersonMessage(deps(), bia.id, f.org.id, f.general.id, { body: "@dev qual branch?" });
    const [askRun] = await runsOf(asked.id);
    if (!askRun) throw new Error("no run");
    const [question] = await f.db
      .insert(schema.agentQuestions)
      .values({
        orgId: f.org.id,
        runId: askRun.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        toolUseId: "ask-1",
        text: "Qual branch?",
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning();
    const held = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Held", handle: "held" },
      { model: "claude-sonnet-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: held.id });
    await f.db.update(schema.agents).set({ operatorHoldAt: new Date() }).where(eq(schema.agents.id, held.id));

    const m = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "@todos @bia reunião" });
    expect(m.mentionedAgentIds).not.toContain(held.id);
    expect(m.mentionedUserIds.filter((id) => id === bia.id)).toHaveLength(1);
    const [still] = await f.db
      .select({ status: schema.agentQuestions.status })
      .from(schema.agentQuestions)
      .where(eq(schema.agentQuestions.id, (question as NonNullable<typeof question>).id));
    expect(still?.status).toBe("open");
    await drainOutbox(f.db, f.handlers);
    const { items } = await listNotifications(deps(), bia.id, f.org.id);
    expect(items.filter((n) => n.kind === "mention")).toHaveLength(1);
  });

  test("in a DM it does nothing", async () => {
    await world();
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const m = await postPersonMessage(deps(), f.owner.id, f.org.id, dm.id, { body: "@todos oi" });
    expect(m.meta.mentionsEveryone).toBeUndefined();
    expect(m.mentionedAgentIds).toEqual([]);
  });
});

describe("@todos judged once: one answer for the room, one each, or none", () => {
  /** `@dev` (the fixture's) and `@ana`, both answering anyone in #general; the judge answers `shape` with `best`. */
  async function room(shape: string | undefined, best = "ana") {
    f = await setup({
      reply: () => ({ chunks: ["Anotado para o time."] }),
      judge: (kind, id) => (kind === "everyone_shape" ? (id === "answer" ? shape : best) : undefined),
    });
    const ana = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ana", handle: "ana" },
      { model: "claude-sonnet-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ana.id });
    return { ana, deps: { db: f.db, pubsub: f.pubsub, judge: f.context.judge as Judge } };
  }
  const decisionOf = async (messageId: string) =>
    (await f.db.select().from(schema.routingDecisions).where(eq(schema.routingDecisions.messageId, messageId)))[0];

  test("one: only the best placed agent runs and owes the answer, for the team; the other only reads it", async () => {
    const { ana, deps } = await room("one");
    const m = await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, {
      body: "@todos regra para todos: nada de nome real de cliente em issue pública",
    });
    expect(m.meta).toMatchObject({ everyoneShape: { answer: "one", by: ana.id }, referencedAgentIds: [f.agent.id] });
    // Both are mentioned (they read it), one runs.
    expect(new Set(m.mentionedAgentIds)).toEqual(new Set([f.agent.id, ana.id]));
    const runs = await runsOf(m.id);
    expect(runs.map((r) => r.agentId)).toEqual([ana.id]);
    const run = runs[0] as NonNullable<(typeof runs)[0]>;
    expect(answersForEveryone(run, m)).toBe(true);
    expect(replyPolicyFor(run, { authorType: "person", meta: m.meta }).mayPass).toBe(false);
    expect(await decisionOf(m.id)).toMatchObject({ strategy: "everyone-fake", selectedAgentIds: [ana.id] });
    // Its receipt: both saw it, the other only referenced.
    const [stored] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, m.id));
    const receipt = (await receiptsFor(f.db, f.org.id, [stored as NonNullable<typeof stored>])).get(m.id);
    expect(new Set(receipt?.seenBy)).toEqual(new Set([f.agent.id, ana.id]));
    expect(receipt?.referenced).toEqual([f.agent.id]);
    // The run is told it answers for everyone, and that a rule goes to the team.
    await drainOutbox(f.db, f.handlers);
    expect(JSON.stringify(f.provider.calls.map((c) => c.request))).toContain(
      JSON.stringify(WHY_ANSWER_FOR_EVERYONE).slice(1, 60),
    );
  });

  test("each: every agent may answer for itself, as before", async () => {
    const { ana, deps } = await room("each");
    const m = await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "@todos digam seus nomes" });
    expect(m.meta.everyoneShape).toEqual({ answer: "each" });
    expect(m.meta.referencedAgentIds).toBeUndefined();
    const runs = await runsOf(m.id);
    expect(runs.map((r) => r.agentId).sort()).toEqual([f.agent.id, ana.id].sort());
    for (const r of runs) expect(replyPolicyFor(r, { authorType: "person", meta: m.meta }).mayPass).toBe(true);
  });

  test("none: an announcement wakes nobody, and nobody routes it again", async () => {
    const { ana, deps } = await room("none");
    const m = await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "@todos reunião às 15h" });
    expect(m.meta.everyoneShape).toEqual({ answer: "none" });
    expect(new Set(m.meta.referencedAgentIds as string[])).toEqual(new Set([f.agent.id, ana.id]));
    expect(await runsOf(m.id)).toEqual([]);
    await drainOutbox(f.db, f.handlers);
    expect(await runsOf(m.id)).toEqual([]);
  });

  test("a judge that fails or can't say: only the agent here first answers, never all of them", async () => {
    const { ana, deps } = await room(undefined, "none_of_them");
    const quiet = await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "@todos alguém viu?" });
    expect(quiet.meta.everyoneShape).toEqual({ answer: "one", by: f.agent.id });
    expect((await runsOf(quiet.id)).map((r) => r.agentId)).toEqual([f.agent.id]);

    const failing: Judge = {
      name: "down",
      ask: async () => {
        throw new Error("judge down");
      },
    };
    const m = await postPersonMessage({ ...deps, judge: failing }, f.owner.id, f.org.id, f.general.id, {
      body: "@todos qual é a senha do wifi?",
    });
    // Dev's run from the first one is still queued, so this goes into it; Ana stays out.
    expect(m.meta).toMatchObject({ everyoneShape: { answer: "one", by: f.agent.id }, referencedAgentIds: [ana.id] });
    expect(await decisionOf(m.id)).toMatchObject({ strategy: "everyone-down", error: "judge down" });
  });

  test("one, with an agent named too: the named one answers and the rest only read it", async () => {
    const { ana, deps } = await room("one", "ana");
    const m = await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "@todos @dev vê isso" });
    expect(m.meta.everyoneShape).toEqual({ answer: "one" });
    expect(m.meta.referencedAgentIds).toEqual([ana.id]);
    expect((await runsOf(m.id)).map((r) => r.agentId)).toEqual([f.agent.id]);
  });

  test("two agents named and everyone: both judgments are asked together, not one after the other", async () => {
    const { deps } = await room("one");
    const theo = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Theo", handle: "theo" },
      { model: "claude-sonnet-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: theo.id });
    const kinds: string[] = [];
    let open = 0;
    let most = 0;
    const slow: Judge = {
      name: "slow",
      ask: async (req) => {
        kinds.push(req.kind);
        most = Math.max(most, ++open);
        await Bun.sleep(100);
        open--;
        throw new Error("judge down");
      },
    };
    await postPersonMessage({ ...deps, judge: slow }, f.owner.id, f.org.id, f.general.id, {
      body: "@todos @dev @ana vejam isso",
    });
    expect(kinds).toHaveLength(2);
    expect(most).toBe(2);
  });

  test("the judge is asked once, with every agent it would wake", async () => {
    const { deps } = await room("one");
    const judge = deps.judge as ReturnType<typeof createFakeJudge>;
    await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "@todos regra nova" });
    const asked = judge.calls.filter((c) => c.kind === "everyone_shape");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.state.agents_here).toEqual(["@dev", "@ana"]);
  });
});
