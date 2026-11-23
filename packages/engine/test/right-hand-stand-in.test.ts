import { afterEach, expect, test } from "bun:test";
import { ACCOUNTS_PROTOCOL, MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { and, eq, schema, sql } from "@agenteschat/db";
import {
  type Brain,
  createJobHandlers,
  drainOutbox,
  getAgentBrain,
  type MachineStatus,
  openPersonAgentDm,
  postPersonMessage,
  postStandInLine,
  RIGHT_HAND,
  STAND_IN_LINE,
  servingPlanFor,
  servingPlans,
  setAccountServes,
  setAgentBrain,
  standInWhy,
} from "../src";
import { agentAiState, backgroundAiState } from "../src/ai-status";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/*
 * ADR 0137 §7, amended 2026-11-15: the right hand always has a runnable AI when the workspace has one. A plan signed in
 * on the workspace's own computer wins without anyone choosing it; while its plan can't think, another plan on an
 * online computer or the workspace's key answers, with one line under the reply. With nothing at all, its no-AI card.
 */

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const WALTERS = "0193eeee-0000-4000-8000-0000000000a1";
const HOMES = "0193eeee-0000-4000-8000-0000000000b1";

const statusOf = (id: string, over: Partial<MachineStatus> = {}): MachineStatus => ({
  id,
  orgId: "org",
  name: "MacBook",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: MACHINE_PROTOCOL_VERSION,
  executors: { claude: { version: "2.1.318", loggedIn: true }, detectedAt: new Date().toISOString() },
  ...over,
});

/** Acme with Lodi, Walter's MacBook (he is the owner), João a member, and the fixture's API key ("main"). */
async function world() {
  const fx = await setup({ rightHand: true });
  f = fx;
  const pair = async (name: string) =>
    (await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, { name, protocol: ACCOUNTS_PROTOCOL }))
      .machineId;
  const laptop = await pair("MacBook");
  const joao = await addMember(fx.db, fx.org.id, "member", "joao");
  const account = (id: string, machineId: string, label: string) =>
    fx.db.insert(schema.machineAccounts).values({
      id,
      orgId: fx.org.id,
      machineId,
      kind: "claude_code",
      label,
      status: "active",
      createdBy: fx.owner.id,
      shared: true,
    });
  const lodi = async () => {
    const [row] = await fx.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
    if (!row) throw new Error("no right hand");
    return row;
  };
  const lines = async (channelId: string) =>
    (await fx.db.select().from(schema.messages).where(eq(schema.messages.channelId, channelId))).filter(
      (m) => m.meta.bodyCode === STAND_IN_LINE,
    );
  const cards = async (channelId: string) =>
    (await fx.db.select().from(schema.messages).where(eq(schema.messages.channelId, channelId))).filter(
      (m) => m.meta.bodyCode === "no_ai",
    );
  return { fx, pair, laptop, joao, account, lodi, lines, cards };
}

test("a computer's own sign-in only, plus a key: Lodi answers on the key, shows ready, and says why once in 6h", async () => {
  const { fx, lodi, lines, cards } = await world();
  // Its brain left on a plan with no account behind it: that names no computer, so it can't think there.
  await fx.db
    .update(schema.agents)
    .set({ brain: "claude_code", brainAccountId: null })
    .where(eq(schema.agents.id, (await lodi()).id));
  const agent = await lodi();
  const machines = { status: async (id: string) => statusOf(id) };
  expect(await agentAiState({ db: fx.db, gateway: fx.gateway, machines }, agent, undefined, fx.owner.id)).toMatchObject(
    { state: "ready", standIn: { via: "main", plan: "Claude", code: "no_computer" } },
  );
  let turns = 0;
  const brain: Brain = {
    kind: "claude_code",
    async *run() {
      turns++;
      yield { type: "done", text: "from the plan" };
    },
  };
  const handlers = createJobHandlers({ ...fx.jobDeps, brains: { claude_code: () => brain }, machines });
  const dm = await openPersonAgentDm(fx.db, fx.org.id, fx.owner.id, agent.id);
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, dm.id, { body: "Hi" });
  await drainOutbox(fx.db, handlers);
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, agent.id));
  expect(run).toMatchObject({ status: "done", brain: "model" });
  expect(turns).toBe(0);
  expect(await cards(dm.id)).toEqual([]);
  const said = await lines(dm.id);
  expect(said.map((m) => m.body)).toEqual(["Answered with main: Claude needs a computer."]);
  expect(said[0]?.meta.noAi).toMatchObject({
    agentId: agent.id,
    standIn: { via: "main", plan: "Claude", why: "needsComputer" },
  });
  // The reply itself carries no fallback note: the line says it.
  const reply = (await fx.db.select().from(schema.messages).where(eq(schema.messages.channelId, dm.id))).find(
    (m) => m.authorAgentId === agent.id && !m.meta.bodyCode,
  );
  expect(reply?.meta.brainFallback).toBeUndefined();
  // A second message in the same 6 hours: answered again, no second line.
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, dm.id, { body: "And now?" });
  await drainOutbox(fx.db, handlers);
  expect(await lines(dm.id)).toHaveLength(1);
});

test("a plan kept to its owner: another person's 'Your AI' names the key that answers them, not nobody", async () => {
  const { fx, laptop, joao, account, lodi } = await world();
  await account(WALTERS, laptop, "Claude Max");
  await setAgentBrain({ db: fx.db }, fx.owner.id, fx.org.id, (await lodi()).id, {
    brain: "claude_code",
    account: WALTERS,
  });
  await setAccountServes({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, WALTERS, "owner");
  const agentId = (await lodi()).id;
  expect(await getAgentBrain({ db: fx.db }, joao.id, fx.org.id, agentId, "mine")).toMatchObject({
    workspaceAi: { brain: "model", servesYou: true, key: { label: "main" } },
  });
  expect(await getAgentBrain({ db: fx.db }, fx.owner.id, fx.org.id, agentId, "mine")).toMatchObject({
    workspaceAi: { brain: "claude_code", ownerId: fx.owner.id, servesYou: true },
  });
});

test("a run that ended with no reply gets no stand-in line", async () => {
  const { fx, lodi, lines } = await world();
  await fx.db
    .update(schema.agents)
    .set({ brain: "claude_code", brainAccountId: null })
    .where(eq(schema.agents.id, (await lodi()).id));
  const agent = await lodi();
  const machines = { status: async (id: string) => statusOf(id) };
  const handlers = createJobHandlers({ ...fx.jobDeps, machines });
  const dm = await openPersonAgentDm(fx.db, fx.org.id, fx.owner.id, agent.id);
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, dm.id, { body: "Hi" });
  await drainOutbox(fx.db, handlers);
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, agent.id));
  if (!run) throw new Error("no run");
  // The reply and its line gone: the same run, as if it had said nothing, posts no line.
  await fx.db.update(schema.messages).set({ deletedAt: new Date() }).where(eq(schema.messages.agentRunId, run.id));
  const standIn = { via: "main", plan: "Claude", code: "no_computer" };
  expect(await postStandInLine({ db: fx.db, pubsub: fx.pubsub }, run, standIn)).toBeNull();
  // With its reply back, the line comes.
  await fx.db
    .update(schema.messages)
    .set({ deletedAt: null })
    .where(and(eq(schema.messages.agentRunId, run.id), sql`${schema.messages.meta}->>'bodyCode' is null`));
  expect(await postStandInLine({ db: fx.db, pubsub: fx.pubsub }, run, standIn)).not.toBeNull();
  expect((await lines(dm.id)).filter((m) => !m.deletedAt)).toHaveLength(1);
});

test("the workspace's own computer comes first, then a computer online, then the person's own, then room", async () => {
  const { fx, laptop, joao, account } = await world();
  // The always-on computer: a managed one that connected (`workspaceHomeId`).
  const [home] = await fx.db
    .insert(schema.machines)
    .values({ orgId: fx.org.id, name: "Acme computer", kind: "managed", tokenHash: "fake-token-hash-home" })
    .returning({ id: schema.machines.id });
  if (!home) throw new Error("no home");
  await account(WALTERS, laptop, "Claude Max");
  await account(HOMES, home.id, "Claude Team");
  const order = async (person: string | null) => (await servingPlans(fx.db, fx.org.id, person)).map((p) => p.id);
  expect(await order(fx.owner.id)).toEqual([HOMES, WALTERS]);
  expect(await order(null)).toEqual([HOMES, WALTERS]);
  // Without a home, the one online comes before Walter's own offline one.
  await fx.db.update(schema.machines).set({ kind: "connected" }).where(eq(schema.machines.id, home.id));
  await fx.db
    .update(schema.machines)
    .set({ online: true, lastSeenAt: new Date() })
    .where(eq(schema.machines.id, home.id));
  expect(await order(fx.owner.id)).toEqual([HOMES, WALTERS]);
  // A key-less workspace AI: João's DM thinks with the first of them without anyone choosing it.
  await fx.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  expect(await servingPlanFor(fx.db, { orgId: fx.org.id, brain: "model", credentialId: null }, joao.id)).toMatchObject({
    brainAccountId: HOMES,
  });
});

test("a plan on a laptop that is away: the chat and its routines answer on the key, the chat says why", async () => {
  const { fx, laptop, account, lodi, lines } = await world();
  await account(WALTERS, laptop, "Claude Max");
  await setAgentBrain({ db: fx.db }, fx.owner.id, fx.org.id, (await lodi()).id, {
    brain: "claude_code",
    account: WALTERS,
  });
  await setAgentBrain({ db: fx.db }, fx.owner.id, fx.org.id, (await lodi()).id, { onlyOwner: false });
  const agent = await lodi();
  const machines = {
    status: async (id: string) => statusOf(id, { online: false, lastSeenAt: new Date(0).toISOString() }),
  };
  const deps = { db: fx.db, gateway: fx.gateway, machines };
  expect(await agentAiState(deps, agent, undefined, fx.owner.id)).toMatchObject({
    state: "ready",
    standIn: { via: "main", plan: "Claude Max", code: "machine_offline" },
  });
  expect(await backgroundAiState(deps, agent)).toMatchObject({ state: "ready", standIn: { via: "main" } });
  const brain: Brain = {
    kind: "claude_code",
    async *run() {
      yield { type: "done", text: "from the plan" };
    },
  };
  const handlers = createJobHandlers({ ...fx.jobDeps, brains: { claude_code: () => brain }, machines });
  const dm = await openPersonAgentDm(fx.db, fx.org.id, fx.owner.id, agent.id);
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, dm.id, { body: "Hi" });
  await drainOutbox(fx.db, handlers);
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, agent.id));
  expect(run).toMatchObject({ status: "done", brain: "model" });
  expect((await lines(dm.id)).map((m) => m.body)).toEqual([
    "Answered with main: the computer Claude Max is on is away.",
  ]);
});

test("a computer gone a moment ago (a restart) is waited for: its own plan answers, nothing stands in", async () => {
  const { fx, laptop, account, lodi, lines } = await world();
  await account(WALTERS, laptop, "Claude Max");
  await setAgentBrain({ db: fx.db }, fx.owner.id, fx.org.id, (await lodi()).id, {
    brain: "claude_code",
    account: WALTERS,
  });
  const agent = await lodi();
  // Away for the run's first look (a server restart), back a moment later.
  let backAt = 0;
  const machines = {
    status: async (id: string) => {
      if (!backAt) backAt = Date.now() + 600;
      return Date.now() < backAt
        ? statusOf(id, { online: false, lastSeenAt: new Date(Date.now() - 5_000).toISOString() })
        : statusOf(id);
    },
  };
  const brain: Brain = {
    kind: "claude_code",
    async *run() {
      yield { type: "done", text: "from the plan" };
    },
  };
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines,
    computerBlipWaitMs: 2_000,
  });
  const dm = await openPersonAgentDm(fx.db, fx.org.id, fx.owner.id, agent.id);
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, dm.id, { body: "Hi" });
  await drainOutbox(fx.db, handlers);
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, agent.id));
  expect(run).toMatchObject({ status: "done", brain: "claude_code" });
  expect(await lines(dm.id)).toEqual([]);
});

test("another plan online stands in before the key, and thinks on its own computer", async () => {
  const { fx, pair, laptop, account, lodi, lines } = await world();
  const office = await pair("Office");
  await account(WALTERS, laptop, "Claude Max");
  await account(HOMES, office, "Claude Team");
  await setAgentBrain({ db: fx.db }, fx.owner.id, fx.org.id, (await lodi()).id, {
    brain: "claude_code",
    account: WALTERS,
  });
  const agent = await lodi();
  await fx.db
    .update(schema.machines)
    .set({ online: true, lastSeenAt: new Date() })
    .where(eq(schema.machines.id, office));
  const machines = {
    status: async (id: string) =>
      statusOf(id, id === office ? {} : { online: false, lastSeenAt: new Date(0).toISOString() }),
  };
  const thought: string[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      thought.push(turn.session?.machineId ?? "");
      yield { type: "done", text: "from the team plan" };
    },
  };
  const handlers = createJobHandlers({ ...fx.jobDeps, brains: { claude_code: () => brain }, machines });
  const dm = await openPersonAgentDm(fx.db, fx.org.id, fx.owner.id, agent.id);
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, dm.id, { body: "Hi" });
  await drainOutbox(fx.db, handlers);
  expect(thought).toEqual([office]);
  expect((await lines(dm.id)).map((m) => m.body)).toEqual([
    "Answered with Claude Team: the computer Claude Max is on is away.",
  ]);
});

test("its plan's CLI failing mid-turn: the key takes the turn over, with its line", async () => {
  const { fx, laptop, account, lodi, lines, cards } = await world();
  await account(WALTERS, laptop, "Claude Max");
  await setAgentBrain({ db: fx.db }, fx.owner.id, fx.org.id, (await lodi()).id, {
    brain: "claude_code",
    account: WALTERS,
  });
  const agent = await lodi();
  const brain: Brain = {
    kind: "claude_code",
    async *run() {
      yield {
        type: "error",
        code: "claude_failed",
        message: "Claude Code ended without an answer (exit 1)",
        retryable: true,
      };
    },
  };
  const machines = { status: async (id: string) => statusOf(id) };
  const handlers = createJobHandlers({ ...fx.jobDeps, brains: { claude_code: () => brain }, machines });
  const dm = await openPersonAgentDm(fx.db, fx.org.id, fx.owner.id, agent.id);
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, dm.id, { body: "Hi" });
  await drainOutbox(fx.db, handlers);
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, agent.id));
  expect(run).toMatchObject({ status: "done", brain: "model" });
  expect(await cards(dm.id)).toEqual([]);
  expect((await lines(dm.id)).map((m) => m.meta.noAi)).toMatchObject([{ standIn: { why: "cant" } }]);
});

test("no computer and no key: the no-AI card stays, and nothing stands in", async () => {
  const { fx, lodi, cards, lines } = await world();
  await fx.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const agent = await lodi();
  const machines = { status: async (id: string) => statusOf(id) };
  expect(await agentAiState({ db: fx.db, gateway: fx.gateway, machines }, agent, undefined, fx.owner.id)).toMatchObject(
    { state: "no_ai", reason: "no_key" },
  );
  const handlers = createJobHandlers({ ...fx.jobDeps, machines });
  const dm = await openPersonAgentDm(fx.db, fx.org.id, fx.owner.id, agent.id);
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, dm.id, { body: "Hi" });
  await drainOutbox(fx.db, handlers);
  expect(await cards(dm.id)).toHaveLength(1);
  expect(await lines(dm.id)).toEqual([]);
});

test("the line's reason follows the plan's code", () => {
  expect(standInWhy("no_computer")).toBe("needsComputer");
  expect(standInWhy("not_logged_in")).toBe("needsComputer");
  expect(standInWhy("machine_offline")).toBe("away");
  expect(standInWhy("plan_limit")).toBe("limit");
  expect(standInWhy("plan_unattended")).toBe("notShared");
  expect(standInWhy("runner_outdated")).toBe("cant");
});
