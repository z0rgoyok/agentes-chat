import { afterEach, describe, expect, test } from "bun:test";
import { ACCOUNTS_PROTOCOL } from "@agenteschat/adapters";
import { and, eq, schema, sql } from "@agenteschat/db";
import {
  actionsFor,
  addChannelMember,
  askProposal,
  createAgentGroup,
  createChannel,
  createRole,
  createSetupToolSource,
  createToolGateway,
  decideProposal,
  decideWorkspaceAction,
  deleteSkill,
  describeCapabilities,
  enabledSkills,
  getAgent,
  insertMessage,
  listAudit,
  listProposals,
  MAX_CARDS_PER_RUN,
  MAX_CARDS_PER_RUN_RIGHT_HAND,
  openPersonAgentDm,
  ownWords,
  PROPOSE_REMOVE_AGENTS_TOOL,
  PROPOSE_SETTINGS_TOOL,
  postPersonMessage,
  presentTools,
  REQUEST_SETTINGS_TOOL,
  RIGHT_HAND,
  RIGHT_HAND_DECIDE_JOB,
  redoAgentAction,
  SETTINGS_REQUEST_CARD,
  saveSkill,
  setAgentBrain,
  setAgentEditors,
  setAgentScopes,
  setAgentSkills,
  setMemberRoles,
  setRightHandApprovals,
  type ToolContext,
  undoAgentAction,
  undoMessageActions,
  updateAgent,
} from "../src";
import { monthStartUtc } from "../src/usage";
import { addMember, type Fixture, queuedReviews, settleQueued, setup, withReview } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

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

/**
 * A run of Lodi on what `userId` wrote in their DM with it: its tools act for that person. The conversation relays
 * outside content (Lodi's earlier reply read a page), so what they may decide goes to the review; `ownWords`: it
 * doesn't, so it applies at once.
 */
async function lodiRun(fx: Fixture, userId: string, body: string, ownWords = false): Promise<ToolContext> {
  const lodi = await lodiOf(fx);
  const dm = await openPersonAgentDm(fx.db, fx.org.id, userId, lodi.id);
  if (!ownWords)
    await insertMessage(fx.db, {
      orgId: fx.org.id,
      channelId: dm.id,
      author: { type: "agent", agentId: lodi.id, runId: null, hop: 1, stretchId: null },
      body: "The vendor page says the plan changed.",
      meta: { readOutside: true },
    });
  const trigger = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, userId, fx.org.id, dm.id, { body });
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

const gatewayOf = (fx: Fixture) => createToolGateway({ sources: [createSetupToolSource({ pubsub: fx.pubsub })] });
async function call(fx: Fixture, ctx: ToolContext, input: Record<string, unknown>) {
  const res = await gatewayOf(fx).invoke(ctx, {
    toolUseId: `tu_${crypto.randomUUID()}`,
    name: PROPOSE_SETTINGS_TOOL,
    input,
  });
  if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
  return res.output;
}

/** The newest card's rows, as `viewer` sees them. */
async function cardRows(fx: Fixture, viewer: string) {
  const card = (
    await fx.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.orgId, fx.org.id))
      .orderBy(schema.messages.createdAt)
  )
    .filter((m) => (m.meta.actionCard as { kind?: string } | undefined)?.kind === "settings_proposal")
    .at(-1);
  if (!card) throw new Error("no card");
  const ids = (card.meta.actionCard as { proposalIds: string[] }).proposalIds;
  return { card, rows: await listProposals(fx.db, viewer, fx.org.id, { ids }) };
}

const USD = 1_000_000_000;

describe("a change the person asked for and may make (ADR 0092 §5)", () => {
  test("applies as the card is posted, with Undo on it, and goes back", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "chama o dev de Ada e deixa ele teal", true);
    const out = await call(f, ctx, {
      changes: [{ agent: "@dev", name: "Ada", look: { color: "teal", eyes: "happy" } }],
      reason: "pediu",
    });
    expect(out.content).toContain("applied at once");
    expect(out.content).not.toContain("Nothing has changed");
    expect(await getAgent(f.db, f.org.id, f.agent.id)).toMatchObject({
      name: "Ada",
      appearance: { color: "teal", eyes: "happy", accessory: "none" },
    });
    const { card, rows } = await cardRows(f, f.owner.id);
    expect(rows.map((r) => r.status)).toEqual(["accepted", "accepted"]);
    const receipts = (await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? [];
    expect(receipts.map((r) => r.kind)).toEqual(["agent.settings_changed", "agent.settings_changed"]);
    for (const r of receipts) await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, r.id);
    expect(await getAgent(f.db, f.org.id, f.agent.id)).toMatchObject({ name: "Dev", appearance: null });
  });

  test("a row they can't decide stays on the card, and so does an agent's own", async () => {
    f = await setup({ rightHand: true });
    const member = await addMember(f.db, f.org.id, "member", "Bia");
    const ctx = await lodiRun(f, member.id, "sobe o limite do dev", true);
    const out = await call(f, ctx, { changes: [{ agent: "@dev", budget_usd: 20 }], reason: "pediu" });
    expect(out.content).not.toContain("applied at once");
    expect((await cardRows(f, member.id)).rows[0]?.status).toBe("pending");
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.monthlyBudgetNanoUsd).toBeNull();

    const own = await lodiRun(f, f.owner.id, "sobe seu próprio limite", true);
    await call(f, own, { changes: [{ agent: "@lodi", budget_usd: 20 }], reason: "pediu" });
    expect((await cardRows(f, f.owner.id)).rows[0]?.status).toBe("pending");
  });

  test("on a computer the model is its brain's: any name its CLI takes, with Undo", async () => {
    f = await setup({ rightHand: true });
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      name: "MacBook",
      exec: true,
    });
    await f.db.update(schema.agents).set({ brain: "codex", machineId }).where(eq(schema.agents.id, f.agent.id));
    const ctx = await lodiRun(f, f.owner.id, "coloca o dev no Astra", true);
    const refused = await call(f, ctx, { changes: [{ agent: "@dev", model: "GPT-6 Astra" }], reason: "pediu" });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content).toContain("That isn't a model name");
    const out = await call(f, ctx, { changes: [{ agent: "@dev", model: "gpt-6-astra" }], reason: "pediu" });
    expect(out.content).toContain("applied at once");
    expect(await getAgent(f.db, f.org.id, f.agent.id)).toMatchObject({
      brain: "codex",
      brainModel: "gpt-6-astra",
      model: "claude-sonnet-5-5",
    });
    const { card } = await cardRows(f, f.owner.id);
    const [receipt] = (await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? [];
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.brainModel).toBeNull();
  });

  test("another maker's model is refused on a plan that can't run it, and says to change its AI account first", async () => {
    f = await setup({ rightHand: true });
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      name: "MacBook",
      exec: true,
    });
    await f.db.update(schema.agents).set({ brain: "codex", machineId }).where(eq(schema.agents.id, f.agent.id));
    const ctx = await lodiRun(f, f.owner.id, "coloca o dev no Opus", true);
    for (const model of ["claude-opus-5-5", "opus"]) {
      const out = await call(f, ctx, { changes: [{ agent: "@dev", model }], reason: "pediu" });
      expect(out).toMatchObject({ isError: true });
      expect(out.content).toContain("doesn't run on Codex: it needs an AI account of Claude first");
    }
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.brainModel).toBeNull();
  });

  test("another maker's model on Claude Code names that maker, and the workspace's key for it when there is one", async () => {
    f = await setup({ rightHand: true });
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      name: "MacBook",
      exec: true,
    });
    await f.db.update(schema.agents).set({ brain: "claude_code", machineId }).where(eq(schema.agents.id, f.agent.id));
    const ctx = await lodiRun(f, f.owner.id, "coloca o dev no gemini", true);
    const ask = () => call(f, ctx, { changes: [{ agent: "@dev", model: "gemini-4-neon" }], reason: "pediu" });
    const bare = await ask();
    expect(bare).toMatchObject({ isError: true });
    expect(bare.content).toContain("Gemini 4 Neon doesn't run on Claude Code: it needs an AI account of Gemini first");
    expect(bare.content).not.toContain("API key");
    const [key] = await f.db
      .select()
      .from(schema.providerCredentials)
      .where(eq(schema.providerCredentials.orgId, f.org.id));
    if (!key) throw new Error("fixture key");
    await f.db.insert(schema.providerCredentials).values({ ...key, id: crypto.randomUUID(), provider: "gemini" });
    const keyed = await ask();
    expect(keyed.content).toContain("or the workspace's gemini API key, which only its page moves it to");
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.brainModel).toBeNull();
  });

  test("the right hand's model for a person with their own AI changes theirs, never the workspace's: theirs to apply and undo", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      name: "MacBook",
      protocol: ACCOUNTS_PROTOCOL,
      exec: true,
    });
    await f.db
      .update(schema.machines)
      .set({
        pairedByUserId: bia.id,
        executors: { claude: { version: "2.1.318", loggedIn: true }, detectedAt: new Date().toISOString() },
      })
      .where(eq(schema.machines.id, machineId));
    const lodi = await lodiOf(f);
    // Her own DM thinks with her computer's own sign-in: a row with no account.
    await setAgentBrain({ db: f.db }, bia.id, f.org.id, lodi.id, {
      scope: "mine",
      brain: "claude_code",
      account: null,
    });
    const ctx = await lodiRun(f, bia.id, "muda seu modelo pro opus", true);
    await call(f, ctx, { changes: [{ agent: "@lodi", model: "opus" }], reason: "pediu" });
    const { card, rows } = await cardRows(f, bia.id);
    const [row] = rows;
    expect(row?.settings).toEqual([{ field: "model", from: null, to: "opus", person: bia.id }]);
    // Her own AI is hers alone: an admin doesn't decide it for her.
    await expect(decideProposal(f.db, f.owner.id, f.org.id, row?.id ?? "", "accept")).rejects.toThrow();
    await decideProposal(f.db, bia.id, f.org.id, row?.id ?? "", "accept", { pubsub: f.pubsub });
    const own = async () =>
      (await f.db.select().from(schema.rightHandBrains).where(eq(schema.rightHandBrains.userId, bia.id)))[0];
    expect(await own()).toMatchObject({ brain: "claude_code", brainModel: "opus", brainAccountId: null, machineId });
    expect((await lodiOf(f)).brainModel).toBe(lodi.brainModel);
    const [receipt] = (await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? [];
    await expect(
      undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? ""),
    ).rejects.toThrow();
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, receipt?.id ?? "");
    expect((await own())?.brainModel).toBeNull();
  });

  test("the effort is a row of its own, for any agent and the right hand, with Undo", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "faz o dev pensar mais, e você também", true);
    const out = await call(f, ctx, {
      changes: [
        { agent: "@dev", effort: "high" },
        { agent: "@lodi", effort: "low" },
      ],
      reason: "pediu",
    });
    expect(out.content).toContain("applied at once");
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.brainEffort).toBe("high");
    // Its own row waits for a person's click, as any of its own settings.
    const { card, rows } = await cardRows(f, f.owner.id);
    const own = rows.find((r) => r.status === "pending");
    await decideProposal(f.db, f.owner.id, f.org.id, own?.id ?? "", "accept", { pubsub: f.pubsub });
    expect((await lodiOf(f)).brainEffort).toBe("low");
    for (const r of (await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? [])
      await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, r.id);
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.brainEffort).toBeNull();
    const back = await call(f, ctx, { changes: [{ agent: "@dev", effort: "default" }], reason: "pediu" });
    expect(back.content).toContain("already has that effort");
  });

  test("outside content in the conversation leaves it on the card", async () => {
    f = await setup({ rightHand: true });
    const outside = await lodiRun(f, f.owner.id, "coloca o dev no haiku");
    await call(f, outside, { changes: [{ agent: "@dev", model: "claude-haiku-5-5" }], reason: "pediu" });
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.model).toBe("claude-sonnet-5-5");
  });

  test("a run another agent's message started leaves it on the card, whoever is behind that agent", async () => {
    f = await setup({ rightHand: true });
    const relayed = await lodiRun(f, f.owner.id, "coloca o dev no haiku", true);
    const message = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: relayed.channelId,
      author: { type: "agent", agentId: relayed.agentId, runId: relayed.runId, hop: 0 },
      body: "a pedido dele",
    });
    await call(
      f,
      { ...relayed, triggerMessageId: message.id },
      {
        changes: [{ agent: "@dev", model: "claude-haiku-5-5" }],
        reason: "pediu",
      },
    );
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.model).toBe("claude-sonnet-5-5");
  });
});

describe("a request posted with the person's own token (ADR 0250)", () => {
  test("proposes no change to another agent and no removal: someone else's words may be in it", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "coloca o dev no haiku e arquiva ele", true);
    await f.db
      .update(schema.messages)
      .set({ origin: "mcp", meta: { readOutside: true } })
      .where(eq(schema.messages.id, ctx.triggerMessageId));
    const out = await call(f, ctx, { changes: [{ agent: "@dev", model: "claude-haiku-5-5" }], reason: "pediu" });
    expect(out.data?.code).toBe("request.relayed");
    const removal = await gatewayOf(f).invoke(ctx, {
      toolUseId: `tu_${crypto.randomUUID()}`,
      name: PROPOSE_REMOVE_AGENTS_TOOL,
      input: { agents: ["@dev"], reason: "pediu" },
    });
    expect(removal.type === "result" && removal.output.data?.code).toBe("request.relayed");
    expect(await f.db.select().from(schema.contextProposals)).toEqual([]);
    expect(await getAgent(f.db, f.org.id, f.agent.id)).toMatchObject({ model: "claude-sonnet-5-5", archivedAt: null });
  });
});

describe("a change of department", () => {
  test("the right hand proposes it, the review applies it as who manages agents, and Undo puts the agent back", async () => {
    f = await setup({ rightHand: true, reply: withReview({ apply: true, why: "O Dev atende vendas agora." }) });
    await createAgentGroup({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Vendas" });
    const groups = await createAgentGroup({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      name: "Operações",
      agentIds: [f.agent.id],
    });
    const idOf = (name: string) => groups.find((g) => g.name === name)?.id;
    const bia = await addMember(f.db, f.org.id, "member", "Bia Rocha");
    const ctx = await lodiRun(f, bia.id, "coloca o dev no setor de Vendas");
    // The sector's name however it was typed: the card keeps it as the workspace writes it.
    const out = await call(f, ctx, { changes: [{ agent: "@dev", group: "vendas" }], reason: "pediu" });
    expect(out.content).toContain("it goes through a quick review that applies each row in a moment if it makes sense");
    const [row] = (await cardRows(f, bia.id)).rows;
    expect(row).toMatchObject({ status: "pending", canDecide: false });
    // The card speaks the sectors' names, not their ids.
    expect(row?.settings).toEqual([{ field: "group", from: "Operações", to: "Vendas" }]);
    // Who can't decide it doesn't apply it; the review weighs it as a change she can't make.
    await expect(decideProposal(f.db, bia.id, f.org.id, row?.id ?? "", "accept")).rejects.toThrow();
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.groupId).toBe(idOf("Operações"));
    expect(await queuedReviews(f)).toEqual([{ ids: [row?.id ?? ""], origin: "asked_other" }]);
    expect((await settleQueued(f)).applied).toEqual([row?.id ?? ""]);
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.groupId).toBe(idOf("Vendas"));
    const { card } = await cardRows(f, f.owner.id);
    const [receipt] = (await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? [];
    expect(receipt).toMatchObject({
      kind: "agent.settings_changed",
      target: { type: "agent", id: f.agent.id },
    });
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.groupId).toBe(idOf("Operações"));
  });

  test('a department that isn\'t there is refused, and "none" takes the agent out of every department', async () => {
    f = await setup({ rightHand: true });
    const [vendas] = await createAgentGroup({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      name: "Vendas",
      agentIds: [f.agent.id],
    });
    const ctx = await lodiRun(f, f.owner.id, "coloca o dev em Marketing", true);
    const refused = await call(f, ctx, { changes: [{ agent: "@dev", group: "Marketing" }], reason: "pediu" });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content).toContain('no department called "Marketing" here');
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.groupId).toBe(vendas?.id);

    const out = await call(f, ctx, { changes: [{ agent: "@dev", group: "none" }], reason: "pediu" });
    expect(out.content).toContain("applied at once");
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.groupId).toBeNull();
  });

  test("a name two departments share is refused, on the card and when it is accepted, never moved to one of them", async () => {
    f = await setup({ rightHand: true });
    const deps = { db: f.db, pubsub: f.pubsub };
    await createAgentGroup(deps, f.owner.id, f.org.id, { name: "Vendas", agentIds: [f.agent.id] });
    const suporte = (await createAgentGroup(deps, f.owner.id, f.org.id, { name: "Suporte" })).find(
      (g) => g.name === "Suporte",
    );
    const bia = await addMember(f.db, f.org.id, "member", "Bia Rocha");
    const ctx = await lodiRun(f, bia.id, "coloca o dev no Suporte");
    await call(f, ctx, { changes: [{ agent: "@dev", group: "Suporte" }], reason: "pediu" });
    const [row] = (await cardRows(f, bia.id)).rows;
    expect(row?.settings).toEqual([{ field: "group", from: "Vendas", to: "Suporte" }]);
    await askProposal(deps, bia.id, f.org.id, row?.id ?? "");
    // A second "Suporte" made while the card waits: accepting it can't tell which one was meant.
    await createAgentGroup(deps, f.owner.id, f.org.id, { name: "Suporte" });
    await expect(decideProposal(f.db, f.owner.id, f.org.id, row?.id ?? "", "accept", deps)).rejects.toMatchObject({
      code: "agent_group.ambiguous",
    });
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.groupId).not.toBe(suporte?.id);

    const owner = await lodiRun(f, f.owner.id, "coloca o dev no Suporte", true);
    const refused = await call(f, owner, { changes: [{ agent: "@dev", group: "Suporte" }], reason: "pediu" });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content).toContain('two departments are called "Suporte"');
  });
});

describe("the settings card", () => {
  test("every agent that sets the team up has it, and the right hand's run may post 10 cards (3 for the others)", async () => {
    f = await setup({ rightHand: true });
    expect([MAX_CARDS_PER_RUN, MAX_CARDS_PER_RUN_RIGHT_HAND]).toEqual([3, 10]);
    const ctx = await lodiRun(f, f.owner.id, "coloca o dev no haiku");
    expect((await gatewayOf(f).granted(ctx)).map((t) => t.name)).toContain(PROPOSE_SETTINGS_TOOL);
    const dev = { ...ctx, agentId: f.agent.id };
    // Another agent proposes too, and the right hand may decide its card for the person (ADR 0139).
    expect((await gatewayOf(f).granted(dev)).map((t) => t.name)).toContain(PROPOSE_SETTINGS_TOOL);
    for (let i = 0; i < 10; i++) {
      const out = await call(f, ctx, { changes: [{ agent: "@dev", budget_usd: i + 1 }], reason: "mais folga" });
      expect(out.isError).toBeFalsy();
    }
    const out = await call(f, ctx, { changes: [{ agent: "@dev", budget_usd: 50 }], reason: "mais folga" });
    expect(out).toMatchObject({ isError: true, content: "You already offered 10 cards in this turn." });
  });

  test("each row applies as whoever clicks, with Undo on the card and `via` in the audit", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf(f);
    const ctx = await lodiRun(f, f.owner.id, "coloca o dev no haiku e sobe o limite dele pra US$ 20");
    const out = await call(f, ctx, {
      changes: [{ agent: "@dev", model: "claude-haiku-5-5", budget_usd: 20 }],
      reason: "mais barato e com folga",
    });
    expect(out.isError).toBeFalsy();
    // Outside content in the conversation: not applied at once, it goes to the review, which knows that.
    expect(out.content).toContain("it goes through a quick review that applies each row in a moment if it makes sense");
    const { card, rows } = await cardRows(f, f.owner.id);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(await queuedReviews(f)).toEqual([{ ids: [row?.id ?? ""], origin: "outside" }]);
    expect(row).toMatchObject({
      target: "agent_settings",
      agentId: f.agent.id,
      requestedByUserId: f.owner.id,
      canDecide: true,
      settings: [
        { field: "model", from: "claude-sonnet-5-5", to: "claude-haiku-5-5" },
        { field: "budget", from: null, to: 20 * USD },
      ],
    });
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.model).toBe("claude-sonnet-5-5");

    await decideProposal(f.db, f.owner.id, f.org.id, row?.id ?? "", "accept", { pubsub: f.pubsub });
    expect(await getAgent(f.db, f.org.id, f.agent.id)).toMatchObject({
      model: "claude-haiku-5-5",
      monthlyBudgetNanoUsd: 20 * USD,
    });
    const [receipt] = (await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? [];
    expect(receipt).toMatchObject({
      kind: "agent.settings_changed",
      agentId: lodi.id,
      requestedByUserId: f.owner.id,
      target: { type: "agent", id: f.agent.id, title: "Dev" },
    });
    const [audit] = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "proposal.accepted")));
    expect(audit?.details).toMatchObject({ via: lodi.id, target: "agent_settings" });
    // "Ver o que o Lodi fez": what was applied from its cards, with the person as the actor.
    const viaLodi = await listAudit(f.db, f.owner.id, f.org.id, { via: lodi.id });
    expect(viaLodi.rows.map((r) => [r.action, r.actor.id])).toContainEqual(["proposal.accepted", f.owner.id]);
    expect((await listAudit(f.db, f.owner.id, f.org.id, { via: f.agent.id })).rows).toEqual([]);

    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    expect(await getAgent(f.db, f.org.id, f.agent.id)).toMatchObject({
      model: "claude-sonnet-5-5",
      monthlyBudgetNanoUsd: null,
    });
  });

  test("a row is out of date once the agent changed, and Undo stops once someone changed it since", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "sobe o limite do dev");
    await call(f, ctx, { changes: [{ agent: "@dev", budget_usd: 20 }], reason: "folga" });
    const [stale] = (await cardRows(f, f.owner.id)).rows;
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { monthlyBudgetNanoUsd: 5 * USD });
    expect(decideProposal(f.db, f.owner.id, f.org.id, stale?.id ?? "", "accept")).rejects.toThrow(/changed since/);
    expect((await listProposals(f.db, f.owner.id, f.org.id, { ids: [stale?.id ?? ""] }))[0]?.status).toBe("stale");

    await call(f, ctx, { changes: [{ agent: "@dev", budget_usd: 20 }], reason: "folga" });
    const { card, rows } = await cardRows(f, f.owner.id);
    await decideProposal(f.db, f.owner.id, f.org.id, rows[0]?.id ?? "", "accept");
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { monthlyBudgetNanoUsd: 30 * USD });
    const [receipt] = (await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? [];
    expect(undoAgentAction({ db: f.db }, f.owner.id, f.org.id, receipt?.id ?? "")).rejects.toThrow(/changed after/);
  });

  test("a member's row goes to the review; sent on, it reaches only who manages agents; the click is read then", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia Rocha");
    const admin = await addMember(f.db, f.org.id, "admin", "Theo");
    const ctx = await lodiRun(f, bia.id, "troca o modelo do dev pra um melhor");
    const out = await call(f, ctx, { changes: [{ agent: "@dev", model: "claude-opus-5-5" }], reason: "melhor" });
    expect(out.content).toContain("it goes through a quick review that applies each row in a moment if it makes sense");
    const [row] = (await cardRows(f, bia.id)).rows;
    expect(row).toMatchObject({ canDecide: false, askedAt: null });
    expect(await queuedReviews(f)).toEqual([{ ids: [row?.id ?? ""], origin: "asked_other" }]);
    expect(decideProposal(f.db, bia.id, f.org.id, row?.id ?? "", "accept")).rejects.toThrow();
    const inbox = async () =>
      (
        await f.db
          .select({ userId: schema.notifications.userId, doneAt: schema.notifications.doneAt })
          .from(schema.notifications)
          .where(and(eq(schema.notifications.orgId, f.org.id), eq(schema.notifications.kind, "change_request")))
      ).sort((a, b) => a.userId.localeCompare(b.userId));
    expect(await inbox()).toEqual([]);
    // Unsent, nobody else hears of it: not listed for an admin, and not theirs to apply.
    expect((await listProposals(f.db, f.owner.id, f.org.id, { status: "pending" })).some((p) => p.id === row?.id)).toBe(
      false,
    );
    expect(decideProposal(f.db, f.owner.id, f.org.id, row?.id ?? "", "accept")).rejects.toThrow();
    // Only the person who asked sends it, once.
    expect(askProposal({ db: f.db }, admin.id, f.org.id, row?.id ?? "")).rejects.toThrow(/Only the person who asked/);
    await askProposal({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, row?.id ?? "");
    expect(askProposal({ db: f.db }, bia.id, f.org.id, row?.id ?? "")).rejects.toThrow(/already sent/);
    expect((await inbox()).map((n) => n.userId).sort()).toEqual([admin.id, f.owner.id].sort());
    expect(
      (await listProposals(f.db, f.owner.id, f.org.id, { status: "pending" })).find((p) => p.id === row?.id),
    ).toMatchObject({ canDecide: true });
    // Theo lost the right to manage agents before clicking: the click is refused.
    await f.db.delete(schema.organizationMemberRoles).where(eq(schema.organizationMemberRoles.userId, admin.id));
    expect(decideProposal(f.db, admin.id, f.org.id, row?.id ?? "", "accept")).rejects.toThrow();
    await decideProposal(f.db, f.owner.id, f.org.id, row?.id ?? "", "accept");
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.model).toBe("claude-opus-5-5");
    expect((await inbox()).every((n) => n.doneAt !== null)).toBe(true);
  });

  test("an AI account is decided by its owner alone, who must own the agent", async () => {
    f = await setup({ rightHand: true });
    const caio = await addMember(f.db, f.org.id, "member", "Caio Mendes");
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, caio.id, f.org.id, {
      name: "MacBook",
      exec: true,
    });
    await f.db.insert(schema.machineAccounts).values({
      id: "0193aaaa-0000-4000-8000-000000000011",
      orgId: f.org.id,
      machineId,
      kind: "claude_code",
      label: "Claude do Caio",
      status: "active",
      createdBy: caio.id,
    });
    const ctx = await lodiRun(f, f.owner.id, "põe o dev no Claude do Caio");
    const refused = await call(f, ctx, { changes: [{ agent: "@dev", ai_account: "Claude do Caio" }], reason: "plano" });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content).toContain("its owner must own the agent first");
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: caio.id });
    await call(f, ctx, { changes: [{ agent: "@dev", ai_account: "Claude do Caio" }], reason: "plano" });
    const [row] = (await cardRows(f, f.owner.id)).rows;
    expect(row?.canDecide).toBe(false);
    // Unsent, the account's owner doesn't hear of it yet.
    expect(await listProposals(f.db, caio.id, f.org.id, { ids: [row?.id ?? ""] })).toEqual([]);
    await askProposal({ db: f.db }, f.owner.id, f.org.id, row?.id ?? "");
    expect((await listProposals(f.db, caio.id, f.org.id, { ids: [row?.id ?? ""] }))[0]?.canDecide).toBe(true);
    const asked = await f.db
      .select({ userId: schema.notifications.userId })
      .from(schema.notifications)
      .where(eq(schema.notifications.kind, "change_request"));
    expect(asked.map((n) => n.userId)).toEqual([caio.id]);
  });

  test("archive, its Undo, and channels; never the right hand itself", async () => {
    f = await setup({ rightHand: true });
    const design = await createChannel(f.db, f.owner.id, f.org.id, { name: "design" });
    const ctx = await lodiRun(f, f.owner.id, "tira o dev do general, põe no design só quando chamado, e arquiva");
    const self = await call(f, ctx, { changes: [{ agent: "@lodi", archive: true }], reason: "nao" });
    expect(self).toMatchObject({ isError: true });
    expect(self.content).toContain("You can't change your own archive");
    await call(f, ctx, {
      changes: [
        {
          agent: "@dev",
          leave: ["general"],
          join: ["design"],
          replies: [{ channel: "design", without_mention: false }],
          archive: true,
        },
      ],
      reason: "reorganizar",
    });
    const { card, rows } = await cardRows(f, f.owner.id);
    // Channels and archiving are decided under different rules: two rows on one card.
    expect(rows.map((r) => r.settings?.map((l) => l.field))).toEqual(
      expect.arrayContaining([["channel_add", "channel_remove"], ["archive"]]),
    );
    expect(rows.find((r) => r.settings?.[0]?.field === "channel_add")?.settings).toEqual([
      { field: "channel_add", channelId: design.id, from: null, to: false, label: { to: "#design" } },
      { field: "channel_remove", channelId: f.general.id, from: true, to: null, label: { to: "#general" } },
    ]);
    for (const r of rows) await decideProposal(f.db, f.owner.id, f.org.id, r.id, "accept");
    const seats = await f.db
      .select({ channelId: schema.channelMembers.channelId })
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.agentId, f.agent.id));
    expect(seats.map((s) => s.channelId)).toEqual([design.id]);
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.archivedAt).not.toBeNull();
    const archived = ((await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? []).find((a) =>
      (a.params.fields as string[]).includes("archive"),
    );
    await undoAgentAction({ db: f.db }, f.owner.id, f.org.id, archived?.id ?? "");
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.archivedAt).toBeNull();
  });
});

const install = (fx: Fixture, name: string) =>
  saveSkill({ db: fx.db, blobs: fx.artifactDeps.blobs }, fx.owner.id, fx.org.id, {
    name,
    description: `Trabalha com ${name}.`,
    body: "1. Abra o arquivo.",
    metadata: {},
    source: "manual",
  });
const skillsOf = async (fx: Fixture) => (await enabledSkills(fx.db, fx.org.id, fx.agent.id)).map((k) => k.name);
/** What the agent that posted a card was told once its rows were decided. */
const notices = async (fx: Fixture) =>
  (await fx.db.select().from(schema.messages).where(eq(schema.messages.orgId, fx.org.id)))
    .map((m) => m.meta.notice as { kind?: string; text?: string } | undefined)
    .filter((n) => n?.kind === "proposal_result")
    .map((n) => n?.text ?? "");
/** Who "Pedir a um admin" reached. */
const askedOf = async (fx: Fixture) =>
  (
    await fx.db
      .select({ userId: schema.notifications.userId })
      .from(schema.notifications)
      .where(and(eq(schema.notifications.orgId, fx.org.id), eq(schema.notifications.kind, "change_request")))
  ).map((n) => n.userId);

describe("an agent's skills on the card, as on its page", () => {
  test("given and taken at once for who may, by name, with Undo putting them back", async () => {
    f = await setup({ rightHand: true });
    const excel = await install(f, "excel");
    const pdf = await install(f, "pdf");
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: pdf.id, enabled: true }]);
    const ctx = await lodiRun(f, f.owner.id, "dá a skill de Excel pro dev e tira a de pdf", true);
    const out = await call(f, ctx, {
      changes: [{ agent: "@dev", add_skills: ["Excel"], remove_skills: ["pdf"] }],
      reason: "pediu",
    });
    expect(out.content).toContain("applied at once");
    expect(await skillsOf(f)).toEqual(["excel"]);
    const { card, rows } = await cardRows(f, f.owner.id);
    expect(rows.map((r) => [r.status, r.settings])).toEqual([
      [
        "accepted",
        [
          { field: "skill", skillId: excel.id, from: false, to: true, label: { to: "excel" } },
          { field: "skill", skillId: pdf.id, from: true, to: false, label: { to: "pdf" } },
        ],
      ],
    ]);
    const [receipt] = (await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? [];
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    expect(await skillsOf(f)).toEqual(["pdf"]);
  });

  test("who edits the agent decides it, as on its page: its owner applies it, anyone else's row goes to the review or, sent on, to who edits it", async () => {
    f = await setup({ rightHand: true });
    await install(f, "excel");
    await install(f, "pdf");
    const bia = await addMember(f.db, f.org.id, "member", "Bia Rocha");
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: bia.id });
    // Its owner edits how it works (ADR 0085 addendum of 2026-11-17): in her own words, it goes on at once.
    const hers = await lodiRun(f, bia.id, "coloca a skill excel no dev", true);
    const applied = await call(f, hers, { changes: [{ agent: "@dev", add_skills: ["excel"] }], reason: "pediu" });
    expect(applied.content).toContain("applied at once");
    expect(await skillsOf(f)).toEqual(["excel"]);

    const caio = await addMember(f.db, f.org.id, "member", "Caio Mendes");
    const asked = await lodiRun(f, caio.id, "coloca a skill pdf no dev", true);
    const out = await call(f, asked, { changes: [{ agent: "@dev", add_skills: ["pdf"] }], reason: "pediu" });
    expect(out.content).toContain("it goes through a quick review that applies each row in a moment if it makes sense");
    const [row] = (await cardRows(f, caio.id)).rows;
    expect(row).toMatchObject({ status: "pending", canDecide: false });
    expect(await queuedReviews(f)).toEqual([{ ids: [row?.id ?? ""], origin: "asked_other" }]);
    await expect(decideProposal(f.db, caio.id, f.org.id, row?.id ?? "", "accept")).rejects.toThrow();
    expect(await skillsOf(f)).toEqual(["excel"]);
    // Whom its "Who can edit" names decides it too, and is asked with its owner and the workspace's owner.
    const bruno = await addMember(f.db, f.org.id, "member", "Bruno Lima");
    await setAgentEditors(f.db, bia.id, f.org.id, f.agent.id, { userIds: [bruno.id], roleIds: [] });
    await askProposal({ db: f.db, pubsub: f.pubsub }, caio.id, f.org.id, row?.id ?? "");
    expect((await askedOf(f)).sort()).toEqual([f.owner.id, bia.id, bruno.id].sort());
    await decideProposal(f.db, bruno.id, f.org.id, row?.id ?? "", "accept", { pubsub: f.pubsub });
    expect((await skillsOf(f)).sort()).toEqual(["excel", "pdf"]);
  });

  test("clear refusals: a skill not installed, one it already has, one removed since", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "dá a skill excel pro dev");
    const none = await call(f, ctx, { changes: [{ agent: "@dev", add_skills: ["excel"] }], reason: "pediu" });
    expect(none).toMatchObject({ isError: true });
    expect(none.content).toContain("No skill is installed here yet");
    const excel = await install(f, "excel");
    await install(f, "pdf");
    const unknown = await call(f, ctx, { changes: [{ agent: "@dev", add_skills: ["planilhas"] }], reason: "pediu" });
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown.content).toStartWith("No skill planilhas. Skills here: excel, pdf. One not installed yet:");
    const taken = await call(f, ctx, { changes: [{ agent: "@dev", remove_skills: ["excel"] }], reason: "pediu" });
    expect(taken).toMatchObject({ isError: true });
    expect(taken.content).toContain("@dev doesn't have the skill excel.");

    // Outside content read: it waits on the card, and goes out of date once the skill is removed.
    await call(f, ctx, { changes: [{ agent: "@dev", add_skills: ["excel"] }], reason: "pediu" });
    const [row] = (await cardRows(f, f.owner.id)).rows;
    expect(row?.status).toBe("pending");
    await deleteSkill(f.db, f.owner.id, f.org.id, excel.id);
    await expect(decideProposal(f.db, f.owner.id, f.org.id, row?.id ?? "", "accept")).rejects.toThrow(/changed since/);
    expect(await skillsOf(f)).toEqual([]);
  });

  test("the right hand's own skill is a row like any agent's own: never applied at once, the review applies it", async () => {
    f = await setup({ rightHand: true, reply: withReview({ apply: true, why: "Ele lê PDFs para a equipe." }) });
    const pdf = await install(f, "pdf");
    const ctx = await lodiRun(f, f.owner.id, "liga a skill pdf pra você", true);
    const own = await call(f, ctx, { changes: [{ agent: "@lodi", add_skills: ["pdf"] }], reason: "pediu" });
    expect(own.isError).toBeFalsy();
    expect(own.content).not.toContain("applied at once");
    expect(own.content).toContain("it goes through a quick review that applies each row in a moment if it makes sense");
    const [row] = (await cardRows(f, f.owner.id)).rows;
    expect(row).toMatchObject({ status: "pending", agentId: ctx.agentId });
    expect(await enabledSkills(f.db, f.org.id, ctx.agentId)).toEqual([]);
    expect(await queuedReviews(f)).toEqual([{ ids: [row?.id ?? ""], origin: "asked" }]);
    await settleQueued(f);
    expect((await enabledSkills(f.db, f.org.id, ctx.agentId)).map((k) => k.id)).toEqual([pdf.id]);
  });

  test("a name finds its own skill before one that differs only by a hyphen", async () => {
    f = await setup({ rightHand: true });
    await install(f, "pdf-tools");
    const plain = await install(f, "pdftools");
    const ctx = await lodiRun(f, f.owner.id, "dá a skill pdftools pro dev");
    await call(f, ctx, { changes: [{ agent: "@dev", add_skills: ["pdftools"] }], reason: "pediu" });
    expect((await cardRows(f, f.owner.id)).rows[0]?.settings).toMatchObject([{ field: "skill", skillId: plain.id }]);
  });

  test("the proposer hears each skill on or off by its name", async () => {
    f = await setup({ rightHand: true });
    const pdf = await install(f, "pdf");
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: pdf.id, enabled: true }]);
    const ctx = await lodiRun(f, f.owner.id, "tira a skill pdf do dev");
    await call(f, ctx, { changes: [{ agent: "@dev", remove_skills: ["pdf"] }], reason: "pediu" });
    const [row] = (await cardRows(f, f.owner.id)).rows;
    await decideProposal(f.db, f.owner.id, f.org.id, row?.id ?? "", "accept", { pubsub: f.pubsub });
    expect(await skillsOf(f)).toEqual([]);
    const [notice] = await notices(f);
    expect(notice).toContain(`@dev's settings: skill "pdf" off.`);
  });

  test("who edits the changed agent undoes a skill applied from the right hand's card; the right hand's rights don't count", async () => {
    f = await setup({ rightHand: true });
    await install(f, "pdf");
    // @dev is Caio's: he edits it, so its skill rows are his to decide and to undo (ADR 0085 addendum of
    // 2026-11-17), though the right hand wrote the card and its receipt names the right hand as who acted.
    const caio = await addMember(f.db, f.org.id, "member", "Caio Mendes");
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: caio.id });
    const ctx = await lodiRun(f, caio.id, "liga a skill pdf no dev");
    await call(f, ctx, { changes: [{ agent: "@dev", add_skills: ["pdf"] }], reason: "pediu" });
    const { card, rows } = await cardRows(f, caio.id);
    await decideProposal(f.db, caio.id, f.org.id, rows[0]?.id ?? "", "accept", { pubsub: f.pubsub });
    expect(await skillsOf(f)).toEqual(["pdf"]);
    const [receipt] = (await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? [];
    expect(receipt).toMatchObject({
      kind: "agent.settings_changed",
      agentId: ctx.agentId,
      target: { type: "agent", id: f.agent.id },
    });
    const undo = { db: f.db, pubsub: f.pubsub };
    const bruno = await addMember(f.db, f.org.id, "member", "Bruno Lima");
    await expect(undoAgentAction(undo, bruno.id, f.org.id, receipt?.id ?? "")).rejects.toMatchObject({
      code: "action.skills_admins",
    });
    await undoAgentAction(undo, caio.id, f.org.id, receipt?.id ?? "");
    expect(await skillsOf(f)).toEqual([]);
  });
});

describe("an agent asks for its own settings on the same card (request_settings_change)", () => {
  /** A run of @dev on what `userId` wrote to it in #general, in their own words unless it relays outside content. */
  async function devRun(fx: Fixture, userId: string, body: string, outside = false): Promise<ToolContext> {
    // Outside content: the channel already relays a page an agent read.
    if (outside)
      await insertMessage(fx.db, {
        orgId: fx.org.id,
        channelId: fx.general.id,
        author: { type: "agent", agentId: fx.agent.id, runId: null, hop: 1, stretchId: null },
        body: "The vendor page says the plan changed.",
        meta: { readOutside: true },
      });
    const trigger = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, userId, fx.org.id, fx.general.id, {
      body: `@dev ${body}`,
    });
    const [run] = await fx.db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.triggerMessageId, trigger.id), eq(schema.agentRuns.agentId, fx.agent.id)));
    if (!run) throw new Error("no run");
    return {
      db: fx.db,
      orgId: fx.org.id,
      agentId: fx.agent.id,
      runId: run.id,
      channelId: fx.general.id,
      threadRootId: run.threadRootId,
      triggerMessageId: trigger.id,
    };
  }
  async function ask(fx: Fixture, ctx: ToolContext, input: Record<string, unknown>) {
    const res = await gatewayOf(fx).invoke(ctx, {
      toolUseId: `tu_${crypto.randomUUID()}`,
      name: REQUEST_SETTINGS_TOOL,
      input,
    });
    if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
    return res.output;
  }

  test("every agent but the right hand holds it in any run, without the setup tools, and is told to ask with it", async () => {
    f = await setup({ rightHand: true });
    const ctx = await devRun(f, f.owner.id, "liga a skill excel pra você");
    await setAgentScopes(f.db, f.owner.id, f.org.id, f.agent.id, [{ connectionId: null, scope: "skills:read" }]);
    const granted = await gatewayOf(f).granted(ctx);
    expect(granted.map((t) => t.name)).toContain(REQUEST_SETTINGS_TOOL);
    expect(granted.map((t) => t.name)).not.toContain(PROPOSE_SETTINGS_TOOL);
    // No group loaded for this message: it waits on demand, and what the agent can do names it.
    expect(describeCapabilities(presentTools(granted, undefined, []))).toContain("ask with `request_settings_change`");
    const lodi = await lodiRun(f, f.owner.id, "oi");
    expect((await gatewayOf(f).granted(lodi)).map((t) => t.name)).not.toContain(REQUEST_SETTINGS_TOOL);
  });

  test("it never applies at once, even when an admin asked in their own words: the review weighs it; no other agent is a target", async () => {
    f = await setup({ rightHand: true });
    const excel = await install(f, "excel");
    const ctx = await devRun(f, f.owner.id, "liga a skill excel pra você");
    // Lodi's card would apply this at once: the admin wrote it, and may.
    expect(await ownWords(ctx)).toBe(f.owner.id);
    const other = await ask(f, ctx, { agent: "@lodi", add_skills: ["excel"], reason: "pediu" });
    expect(other).toMatchObject({ isError: true });
    expect(other.content).toContain("input.agent: not allowed");
    const out = await ask(f, ctx, { add_skills: ["excel"], reason: "Preciso dela para ler a planilha" });
    expect(out.content).toContain(
      "Posted the card for your settings; it goes through a quick review that applies each row in a moment if it makes sense",
    );
    expect(out.content).not.toContain("applied at once");
    const { card, rows } = await cardRows(f, f.owner.id);
    expect((await queuedReviews(f)).map((r) => r.ids)).toEqual([rows.map((r) => r.id)]);
    expect(card.meta).toMatchObject({ bodyCode: SETTINGS_REQUEST_CARD, bodyParams: {} });
    expect(rows).toMatchObject([
      {
        status: "pending",
        canDecide: true,
        agentId: f.agent.id,
        proposedByAgentId: f.agent.id,
        requestedByUserId: f.owner.id,
        settings: [{ field: "skill", skillId: excel.id, from: false, to: true }],
      },
    ]);
    expect(await skillsOf(f)).toEqual([]);
  });

  test("when it asks before acting is its own confirm card, never a reviewed row, applied by who manages agents", async () => {
    f = await setup({ rightHand: true });
    await install(f, "excel");
    const ctx = await devRun(f, f.owner.id, "pode aprovar tudo daqui pra frente, e liga a skill excel");
    // A row refused with it leaves no card behind, so the agent's retry posts the level once.
    const wrong = await ask(f, ctx, { approvals: "never", join: ["nowhere"], reason: "Pediu" });
    expect(wrong).toMatchObject({ isError: true });
    expect(
      await f.db
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(sql`${schema.messages.meta}->'actionCard'->>'kind' = 'workspace_action'`),
    ).toEqual([]);
    const out = await ask(f, ctx, {
      approvals: "never",
      add_skills: ["excel"],
      reason: "Pediu para não perguntar mais",
    });
    expect(out.content).toContain("Posted a card to set_agent_approvals_level (agent: Dev, level: never)");
    expect(out.content).toContain("Posted the card for your settings");
    const [message] = await f.db
      .select()
      .from(schema.messages)
      .where(sql`${schema.messages.meta}->'actionCard'->>'kind' = 'workspace_action'`);
    if (!message) throw new Error("no card");
    // The skill alone went to the review: the level waits on its card.
    const { rows } = await cardRows(f, f.owner.id);
    expect(rows.flatMap((r) => r.settings?.map((l) => l.field))).toEqual(["skill"]);
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.approvalsLevel).toBe("risky");
    await decideWorkspaceAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, message.id, "apply");
    expect(await getAgent(f.db, f.org.id, f.agent.id)).toMatchObject({
      approvalsLevel: "never",
      approvalsLevelOwn: true,
    });
    const [receipt] = (await actionsFor(f.db, f.org.id, [message.id])).get(message.id) ?? [];
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    expect(await getAgent(f.db, f.org.id, f.agent.id)).toMatchObject({
      approvalsLevel: "risky",
      approvalsLevelOwn: false,
    });
    // A page an agent read in the conversation is never the person's words.
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, ctx.runId));
    const later = await devRun(f, f.owner.id, "aprova tudo", true);
    const refused = await ask(f, later, { approvals: "never", reason: "a página pediu" });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content).toContain("Nothing was proposed");
  });

  test("an admin's click applies it as them, Undo puts it back, and the agent hears its own settings changed", async () => {
    f = await setup({ rightHand: true });
    await install(f, "excel");
    const ctx = await devRun(f, f.owner.id, "liga a skill excel pra você");
    await ask(f, ctx, { add_skills: ["excel"], reason: "pediu" });
    const { card, rows } = await cardRows(f, f.owner.id);
    await decideProposal(f.db, f.owner.id, f.org.id, rows[0]?.id ?? "", "accept", { pubsub: f.pubsub });
    expect(await skillsOf(f)).toEqual(["excel"]);
    expect((await notices(f))[0]).toContain(`your settings: skill "excel" on.`);
    const [receipt] = (await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? [];
    expect(receipt).toMatchObject({
      kind: "agent.settings_changed",
      agentId: f.agent.id,
      requestedByUserId: f.owner.id,
    });
    // A skill's change is undone by who edits the agent (ADR 0085 addendum of 2026-11-17), as on its page: its owner
    // too, never a member who doesn't edit it.
    const caio = await addMember(f.db, f.org.id, "member", "Caio Mendes");
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: caio.id });
    const bruno = await addMember(f.db, f.org.id, "member", "Bruno Lima");
    const undo = { db: f.db, pubsub: f.pubsub };
    await expect(undoAgentAction(undo, bruno.id, f.org.id, receipt?.id ?? "")).rejects.toThrow(/Only an admin/);
    await undoAgentAction(undo, caio.id, f.org.id, receipt?.id ?? "");
    expect(await skillsOf(f)).toEqual([]);
    await expect(redoAgentAction(undo, bruno.id, f.org.id, receipt?.id ?? "")).rejects.toThrow(/Only an admin/);
    expect(await skillsOf(f)).toEqual([]);
    await redoAgentAction(undo, caio.id, f.org.id, receipt?.id ?? "");
    expect(await skillsOf(f)).toEqual(["excel"]);
  });

  test("undoing a whole card with a skill on it: nothing for who applied it but no longer edits the agent, all of it for its owner", async () => {
    f = await setup({ rightHand: true });
    await install(f, "excel");
    const design = await createChannel(f.db, f.owner.id, f.org.id, { name: "design" });
    // Caio owns @dev: he asks for both and applies both himself.
    const caio = await addMember(f.db, f.org.id, "member", "Caio Mendes");
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: caio.id });
    for (const channel of [f.general, design])
      await addChannelMember(f.db, f.owner.id, f.org.id, channel.id, { userId: caio.id });
    const ctx = await devRun(f, caio.id, "liga a skill excel e entra no design");
    await ask(f, ctx, { add_skills: ["excel"], join: ["design"], reason: "pediu" });
    const { card, rows } = await cardRows(f, caio.id);
    // The skill's row first: undoing the card starts from the newest receipt, the channel's, which who applied it may
    // undo.
    const skillRow = rows.find((r) => r.settings?.[0]?.field === "skill");
    const seatRow = rows.find((r) => r.settings?.[0]?.field === "channel_add");
    for (const r of [skillRow, seatRow]) await decideProposal(f.db, caio.id, f.org.id, r?.id ?? "", "accept");
    const seated = async () =>
      (
        await f.db
          .select({ id: schema.channelMembers.id })
          .from(schema.channelMembers)
          .where(and(eq(schema.channelMembers.channelId, design.id), eq(schema.channelMembers.agentId, f.agent.id)))
      ).length;
    expect([await seated(), await skillsOf(f)]).toEqual([1, ["excel"]]);
    // @dev goes to Bruno: the channel's receipt is still Caio's to undo, the skill's only who edits it now's (ADR 0085
    // addendum of 2026-11-17), so none is undone.
    const bruno = await addMember(f.db, f.org.id, "member", "Bruno Lima");
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: bruno.id });
    const undo = { db: f.db, pubsub: f.pubsub };
    await expect(undoMessageActions(undo, caio.id, f.org.id, card.id)).rejects.toMatchObject({
      code: "action.skills_admins",
    });
    expect(await seated()).toBe(1);
    expect(await skillsOf(f)).toEqual(["excel"]);
    // Its owner now, in #design, edits it: every row goes back.
    await addChannelMember(f.db, f.owner.id, f.org.id, design.id, { userId: bruno.id });
    expect((await undoMessageActions(undo, bruno.id, f.org.id, card.id)).failed).toEqual([]);
    expect(await seated()).toBe(0);
    expect(await skillsOf(f)).toEqual([]);
  });

  test("a member who can't decide it: it goes to the review, and sent on it reaches who edits the agent, its owner included", async () => {
    f = await setup({ rightHand: true });
    await install(f, "excel");
    const bia = await addMember(f.db, f.org.id, "member", "Bia Rocha");
    // Who edits it decides its skills (ADR 0085 addendum of 2026-11-17): its owner, and whoever holds a role its "Who
    // can edit" names.
    const caio = await addMember(f.db, f.org.id, "member", "Caio Mendes");
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: caio.id });
    const reviewers = await createRole(f.db, f.owner.id, f.org.id, { name: "Revisores" });
    const bruno = await addMember(f.db, f.org.id, "member", "Bruno Lima");
    await setMemberRoles(f.db, f.owner.id, f.org.id, bruno.id, [reviewers.id]);
    await setAgentEditors(f.db, caio.id, f.org.id, f.agent.id, { userIds: [], roleIds: [reviewers.id] });
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    const ctx = await devRun(f, bia.id, "liga a skill excel pra você");
    const out = await ask(f, ctx, { add_skills: ["excel"], reason: "pediu" });
    expect(out.content).toContain("it goes through a quick review that applies each row in a moment if it makes sense");
    const [row] = (await cardRows(f, bia.id)).rows;
    expect(row).toMatchObject({ status: "pending", canDecide: false, askedAt: null, requestedByUserId: bia.id });
    expect((await queuedReviews(f)).map((r) => r.ids)).toEqual([[row?.id ?? ""]]);
    await expect(decideProposal(f.db, bia.id, f.org.id, row?.id ?? "", "accept")).rejects.toThrow();
    await askProposal({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, row?.id ?? "");
    expect((await askedOf(f)).sort()).toEqual([f.owner.id, caio.id, bruno.id].sort());
    await decideProposal(f.db, bruno.id, f.org.id, row?.id ?? "", "accept", { pubsub: f.pubsub });
    expect(await skillsOf(f)).toEqual(["excel"]);
  });

  test("the right hand doesn't look at settings cards for the person: the review settles them", async () => {
    f = await setup({ rightHand: true });
    await install(f, "excel");
    await setRightHandApprovals({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { enabled: true });
    const looks = async () =>
      (
        await f.db
          .select({ id: schema.outbox.id })
          .from(schema.outbox)
          .where(and(eq(schema.outbox.orgId, f.org.id), eq(schema.outbox.kind, RIGHT_HAND_DECIDE_JOB)))
      ).length;
    const ctx = await devRun(f, f.owner.id, "liga a skill excel pra você e sobe o limite do lodi", true);
    await ask(f, ctx, { add_skills: ["excel"], reason: "pediu" });
    await call(f, ctx, { changes: [{ agent: "@lodi", budget_usd: 20 }], reason: "pediu" });
    expect(await looks()).toBe(0);
    expect(await queuedReviews(f)).toHaveLength(2);
  });

  test("a skill on and off at once is refused, and a long list of skills is cut short", async () => {
    f = await setup({ rightHand: true });
    for (let i = 0; i < 25; i++) await install(f, `skill-${String(i).padStart(2, "0")}`);
    const ctx = await devRun(f, f.owner.id, "liga e desliga a skill-00 pra você");
    const both = await ask(f, ctx, { add_skills: ["skill-00"], remove_skills: ["skill-00"], reason: "pediu" });
    expect(both).toMatchObject({
      isError: true,
      content: "Each skill goes on or off, not both: skill-00 is in add_skills and remove_skills.",
    });
    const unknown = await ask(f, ctx, { add_skills: ["planilhas"], reason: "pediu" });
    expect(unknown.content).toContain("skill-19, +5 more.");
    expect(unknown.content).not.toContain("skill-20");
  });

  /** What @dev spent this month, as the gateway counts it. */
  const spent = (fx: Fixture, usd: number) =>
    fx.db
      .insert(schema.agentBudgetPeriods)
      .values({
        orgId: fx.org.id,
        agentId: fx.agent.id,
        periodStart: monthStartUtc(new Date()).toISOString().slice(0, 10),
        spentNanoUsd: usd * USD,
      })
      .onConflictDoUpdate({
        target: [schema.agentBudgetPeriods.agentId, schema.agentBudgetPeriods.periodStart],
        set: { spentNanoUsd: usd * USD },
      });

  test("a budget of 0 or at or below the month's spend is refused, unless it is a cut the card says pauses at once", async () => {
    f = await setup({ rightHand: true });
    await spent(f, 10);
    const ctx = await devRun(f, f.owner.id, "ajusta seu orçamento");
    for (const budget_usd of [0, 5, 10]) {
      const out = await ask(f, ctx, { budget_usd, reason: "pediu" });
      expect(out).toMatchObject({ isError: true });
      expect(out.content).toContain("so it would stop at once");
      expect(out.content).toContain("budget_cut: true");
    }
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.monthlyBudgetNanoUsd).toBeNull();
    await ask(f, ctx, { budget_usd: 5, budget_cut: true, reason: "pediu para parar" });
    expect((await cardRows(f, f.owner.id)).rows[0]?.settings).toEqual([
      { field: "budget", from: null, to: 5 * USD, pausesNow: true },
    ]);
    await ask(f, ctx, { budget_usd: 30, budget_cut: true, reason: "mais folga" });
    expect((await cardRows(f, f.owner.id)).rows[0]?.settings).toEqual([{ field: "budget", from: null, to: 30 * USD }]);
  });

  test("a card goes stale once its budget would stop the agent or its value changed, and never applies", async () => {
    f = await setup({ rightHand: true });
    await spent(f, 10);
    const ctx = await devRun(f, f.owner.id, "ajusta seu orçamento");
    await ask(f, ctx, { budget_usd: 20, reason: "mais folga" });
    const first = (await cardRows(f, f.owner.id)).rows[0];
    expect(first).toMatchObject({ status: "pending", canDecide: true });
    // The month's spend went past it while the card waited.
    await spent(f, 25);
    expect((await cardRows(f, f.owner.id)).rows[0]).toMatchObject({ status: "stale", canDecide: false });
    await expect(
      decideProposal(f.db, f.owner.id, f.org.id, first?.id ?? "", "accept", { pubsub: f.pubsub }),
    ).rejects.toThrow(/changed since/);
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.monthlyBudgetNanoUsd).toBeNull();
    await ask(f, ctx, { budget_usd: 60, reason: "mais folga" });
    const second = (await cardRows(f, f.owner.id)).rows[0];
    // Someone set it on its page meanwhile: the card's "from" is no longer what it has.
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { monthlyBudgetNanoUsd: 80 * USD });
    expect((await cardRows(f, f.owner.id)).rows[0]).toMatchObject({ status: "stale" });
    await expect(
      decideProposal(f.db, f.owner.id, f.org.id, second?.id ?? "", "accept", { pubsub: f.pubsub }),
    ).rejects.toThrow(/changed since/);
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.monthlyBudgetNanoUsd).toBe(80 * USD);
  });

  test("a reason that names another agent is refused and points to propose_settings_change", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf(f);
    const ctx = await devRun(f, f.owner.id, "sobe o orçamento");
    for (const reason of [`${lodi.name} ficou sem orçamento`, `@${lodi.handle} precisa de mais`]) {
      const out = await ask(f, ctx, { budget_usd: 90, reason });
      expect(out).toMatchObject({ isError: true });
      expect(out.content).toContain(PROPOSE_SETTINGS_TOOL);
    }
    // Its own name beside the other's: it is about its own settings.
    const own = await ask(f, ctx, {
      budget_usd: 90,
      reason: `Dev precisa de mais para revisar o que ${lodi.name} pede`,
    });
    expect(own.isError).toBeFalsy();
    expect((await cardRows(f, f.owner.id)).rows[0]?.settings).toEqual([{ field: "budget", from: null, to: 90 * USD }]);
  });
});
