import { afterEach, expect, setSystemTime, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  answerQuestion,
  type Brain,
  type BrainEvent,
  type BrainPlan,
  type BrainTurn,
  clearPlanLimits,
  createAgent,
  createJobHandlers,
  createRoutine,
  drainOutbox,
  executeToolForRun,
  insertMessage,
  listMessages,
  listRuns,
  type MachineStatus,
  openPersonAgentDm,
  pauseContinuesPastPlan,
  postPersonMessage,
  RESUME_AFTER_MS,
  runRoutineNow,
  STAND_IN_LINE,
  setAccountServes,
  setAgentBrain,
  setPlanKeyFallback,
  thinkingAgent,
  usageQueue,
} from "../src";
import { type AccountSwitch, movedAccountPlan, nextAccountPlan } from "../src/spill";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/** ADR 0041 §6: at its plan's limit a run goes on with the next account of the workspace's order. */

let f: Fixture;
afterEach(() => {
  clearPlanLimits();
  const fx: Fixture | undefined = f;
  f = undefined as unknown as Fixture;
  return fx?.close();
});

const OWN1 = "0193eeee-0000-4000-8000-00000000a001";
const OWN2 = "0193eeee-0000-4000-8000-00000000a002";
const OWN3 = "0193eeee-0000-4000-8000-00000000a003";
const WALTER_ALL = "0193eeee-0000-4000-8000-00000000b001";
const WALTER_ONLY = "0193eeee-0000-4000-8000-00000000b002";
const WALTER_SOLO = "0193eeee-0000-4000-8000-00000000b003";

const later = (ms: number) => new Date(Date.now() + ms);
const iso = (ms: number) => later(ms).toISOString();
const reading = (used: number, resetsAt = iso(3600_000)) => ({
  windows: [{ kind: "five_hour", usedPercent: used, resetsAt }],
  source: "turn",
  at: new Date().toISOString(),
});

const statusOf = (id: string, online = true): MachineStatus => ({
  id,
  orgId: "org",
  name: "MacBook",
  online,
  execAllowed: true,
  os: "darwin",
  protocol: MACHINE_PROTOCOL_VERSION,
  executors: { claude: { version: "2.1.318", loggedIn: true }, detectedAt: new Date().toISOString() },
});

/** The agent on Claude Code with its owner's account `OWN1`, on a computer where Walter connected accounts too. */
async function world(over: Partial<typeof schema.agents.$inferInsert> = {}, options: Parameters<typeof setup>[0] = {}) {
  f = await setup(options);
  const fx = f;
  const deps = { db: fx.db, pubsub: fx.pubsub, publicUrl: "https://agentes.chat" };
  const { machineId } = await pairMachine(deps, fx.owner.id, fx.org.id, {
    name: "MacBook",
    hostname: "mac",
    os: "darwin",
    arch: "arm64",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/Users/w/agentes",
    exec: true,
  });
  const walter = await addMember(fx.db, fx.org.id, "member", "walter");
  const account = async (
    id: string,
    createdBy: string,
    more: Partial<typeof schema.machineAccounts.$inferInsert> = {},
  ) => {
    await fx.db.insert(schema.machineAccounts).values({
      id,
      orgId: fx.org.id,
      machineId,
      kind: "claude_code",
      label: `Conta ${id.slice(-4)}`,
      status: "active",
      createdBy,
      shared: true,
      ...more,
    });
  };
  await account(OWN1, fx.owner.id);
  await fx.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", brainModel: "sonnet", brainAccountId: OWN1, ...over })
    .where(eq(schema.agents.id, fx.agent.id));
  const usage = (id: string, used: number, resetsAt?: string) =>
    fx.db
      .update(schema.machineAccounts)
      .set({ usage: reading(used, resetsAt) as never })
      .where(eq(schema.machineAccounts.id, id));
  return { fx, machineId, walter, account, usage };
}

function scripted(script: (n: number, turn: BrainTurn) => BrainEvent[]) {
  const seen: BrainTurn[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      const n = seen.length;
      seen.push({ ...turn, system: "", messages: [] });
      yield* script(n, turn);
    },
  };
  return { brain, seen };
}

const handlersWith = (fx: Fixture, brain: Brain, online = true) =>
  createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id, online) },
    planLimitGraceMs: 50,
  });

const ask = (fx: Fixture, body = "@dev oi") =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body });

const notes = async (fx: Fixture, code: string) =>
  (await listMessages(fx.db, fx.owner.id, fx.org.id, fx.general.id)).filter((m) => m.meta.bodyCode === code);

const runs = (fx: Fixture) => fx.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);

type Moved = {
  accountMove?: { from: string; to: string; lentBy?: string; tried: string[] };
  accountSwitch?: AccountSwitch;
};
const moveOf = (run: { transcript: unknown } | undefined) => (run?.transcript as Moved | undefined)?.accountMove;
const switchOf = (run: { transcript: unknown } | undefined) => (run?.transcript as Moved | undefined)?.accountSwitch;
/** A move is quiet in the chat: no line of the run ever says it. */
const movedLines = async (fx: Fixture) =>
  (await listMessages(fx.db, fx.owner.id, fx.org.id, fx.general.id)).filter((m) =>
    String(m.meta.bodyCode ?? "").startsWith("plan_account_moved"),
  );

const agentRow = async (fx: Fixture) =>
  (await fx.db.select().from(schema.agents).where(eq(schema.agents.id, fx.agent.id)))[0];

const answers: BrainEvent[] = [
  { type: "usage", input: 100, output: 10, source: "plan", model: "sonnet" },
  { type: "done", text: "Feito." },
];

test("an account at its limit before the turn: the next account of its owner answers, once said, the agent's own unchanged", async () => {
  const { fx, account, usage } = await world();
  await account(OWN2, fx.owner.id);
  await usage(OWN1, 100);
  const { brain, seen } = scripted(() => answers);
  await ask(fx);
  await drainOutbox(fx.db, handlersWith(fx, brain));

  expect(seen.map((t) => t.account?.id)).toEqual([OWN2]);
  // A fresh session there: the one before lives in the other account's folder.
  expect(seen[0]?.session?.resume).toBe(false);
  const [run] = await runs(fx);
  expect(run?.status).toBe("done");
  expect(moveOf(run)).toEqual({ from: OWN1, to: OWN2, tried: [OWN1, OWN2] });
  expect(switchOf(run)).toEqual({
    from: { id: OWN1, name: "Conta a001" },
    to: { id: OWN2, name: "Conta a002" },
    cause: "limit",
  });
  expect(await movedLines(fx)).toHaveLength(0);
  const said = await listMessages(fx.db, fx.owner.id, fx.org.id, fx.general.id);
  // Only the reply is the run's message: the apps keep its working row until then.
  expect(said.filter((m) => m.agentRunId === run?.id).map((m) => m.body)).toEqual(["Feito."]);
  // Atividade and the run's details say it.
  const [listed] = await listRuns(fx.db, fx.owner.id, fx.org.id, { runId: run?.id ?? "" });
  expect(listed?.accountSwitch).toEqual(switchOf(run) ?? null);
  // The move belongs to the run: the agent still thinks with its own account.
  expect((await agentRow(fx))?.brainAccountId).toBe(OWN1);
  // The account that did the work is the one its usage names.
  const records = await fx.db
    .select()
    .from(schema.usageRecords)
    .where(eq(schema.usageRecords.runId, run?.id ?? ""));
  expect(records.map((r) => r.brainAccountId)).toEqual([OWN2]);

  // Its own account back with room: the next run starts there again, with no line.
  await usage(OWN1, 10);
  clearPlanLimits();
  await ask(fx, "@dev e agora?");
  await drainOutbox(fx.db, handlersWith(fx, brain));
  expect(seen.map((t) => t.account?.id)).toEqual([OWN2, OWN1]);
  expect(switchOf((await runs(fx))[1])).toBeUndefined();
});

test("its account thinking for all the runs it takes at once: a fresh run goes on with the next one with a free slot, else waits", async () => {
  const { fx, machineId, account } = await world();
  await account(OWN2, fx.owner.id);
  // Another agent's runs think on the accounts.
  const ops = await createAgent(
    fx.db,
    fx.owner.id,
    fx.org.id,
    { name: "Ops", handle: "ops", role: "Infra", instructions: "", credentialId: fx.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const working = async (key: string) => {
    const id = Bun.randomUUIDv7();
    await fx.db.insert(schema.agentRuns).values({
      id,
      orgId: fx.org.id,
      agentId: ops.id,
      channelId: fx.general.id,
      threadRootId: id,
      triggerMessageId: id,
      trigger: "mention",
      hop: 2,
      status: "running",
      heartbeatAt: new Date(),
      transcript: { roomAsk: { machineId, at: Date.now() - 60_000, signIn: key } },
    });
  };
  await working(OWN1);
  const { brain, seen } = scripted(() => answers);
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    signInConcurrency: 1,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await ask(fx);
  await drainOutbox(fx.db, handlers);
  expect(seen.map((t) => t.account?.id)).toEqual([OWN2]);
  const first = (await runs(fx)).find((r) => r.agentId === fx.agent.id);
  expect(first?.status).toBe("done");
  expect(switchOf(first)?.cause).toBe("busy");
  expect(await movedLines(fx)).toHaveLength(0);

  // Both busy: it waits for its own, with no move.
  await working(OWN2);
  await ask(fx, "@dev de novo");
  await drainOutbox(fx.db, handlers);
  expect(seen).toHaveLength(1);
  const waiting = (await runs(fx)).find((r) => r.agentId === fx.agent.id && r.id !== first?.id);
  expect(waiting?.status).toBe("waiting_input");
  expect(waiting?.transcript).toMatchObject({ waitingForBrain: { code: "busy" }, signInWait: { key: OWN1 } });
  expect(moveOf(waiting)).toBeUndefined();
});

test("its account busy, the next one at its pause line: the run waits for its own rather than move there", async () => {
  const { fx, machineId, account, usage } = await world();
  await account(OWN2, fx.owner.id);
  await usage(OWN2, 99);
  const ops = await createAgent(
    fx.db,
    fx.owner.id,
    fx.org.id,
    { name: "Ops", handle: "ops", role: "Infra", instructions: "", credentialId: fx.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const id = Bun.randomUUIDv7();
  await fx.db.insert(schema.agentRuns).values({
    id,
    orgId: fx.org.id,
    agentId: ops.id,
    channelId: fx.general.id,
    threadRootId: id,
    triggerMessageId: id,
    trigger: "mention",
    hop: 2,
    status: "running",
    heartbeatAt: new Date(),
    transcript: { roomAsk: { machineId, at: Date.now() - 60_000, signIn: OWN1 } },
  });
  const { brain, seen } = scripted(() => answers);
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    signInConcurrency: 1,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await ask(fx);
  await drainOutbox(fx.db, handlers);
  expect(seen).toHaveLength(0);
  const waiting = (await runs(fx)).find((r) => r.agentId === fx.agent.id);
  expect(waiting?.transcript).toMatchObject({ waitingForBrain: { code: "busy" }, signInWait: { key: OWN1 } });
  expect(moveOf(waiting)).toBeUndefined();
});

test("a run for someone besides the agent's owner goes on only with an account whose Atender todos takes them", async () => {
  const { fx, machineId, walter, account, usage } = await world();
  await account(WALTER_ALL, walter.id, { useOrder: 0 });
  await account(OWN2, fx.owner.id, { useOrder: 1, replyMode: "everyone" });
  await usage(OWN1, 100);
  const agent = await agentRow(fx);
  if (!agent) throw new Error("no agent");
  const plan: BrainPlan = {
    kind: "claude_code",
    model: "sonnet",
    session: { id: "s1", resume: true, machineId, cwd: "" },
    account: { id: OWN1, label: "Conta a001", status: "active" },
  };
  const deps = { db: fx.db, machines: { status: async (id: string) => statusOf(id) } };
  // The agent's owner asks: Walter's account answers them by its place.
  expect((await nextAccountPlan(deps, agent, plan, [OWN1, OWN2])).plan?.account?.id).toBe(WALTER_ALL);
  // Walter asks someone else's agent: his own account answers only the agent's owner, so it is passed over.
  const asked = await nextAccountPlan(deps, agent, plan, [OWN1], { asker: walter.id });
  expect(asked.plan?.account?.id).toBe(OWN2);
  expect(await nextAccountPlan(deps, agent, plan, [OWN1, OWN2], { asker: walter.id })).toMatchObject({ plan: null });
  expect(await movedAccountPlan(deps, agent, plan, WALTER_ALL, null, walter.id)).toBeNull();
  expect(await movedAccountPlan(deps, agent, plan, OWN2, null, walter.id)).not.toBeNull();
});

test("the order: the owner's own accounts first, then others that serve everyone by their place; never an owner-only one", async () => {
  const { fx, machineId, walter, account, usage } = await world();
  await account(WALTER_ONLY, walter.id, { serves: "owner", useMode: "owner", useOrder: 0 });
  await account(WALTER_ALL, walter.id, { useOrder: 1 });
  await account(WALTER_SOLO, walter.id, { shared: false, useOrder: 0 });
  await account(OWN2, fx.owner.id, { useOrder: 7 });
  await account(OWN3, fx.owner.id, { useOrder: 3 });
  // A login for one agent that another agent thinks with is that agent's.
  await fx.db.insert(schema.agents).values({
    orgId: fx.org.id,
    name: "Atlas",
    handle: "atlas",
    model: "claude-sonnet-4-5",
    machineId,
    brain: "claude_code",
    brainAccountId: WALTER_SOLO,
  });
  await usage(OWN1, 100);
  const agent = await agentRow(fx);
  if (!agent) throw new Error("no agent");
  const plan: BrainPlan = {
    kind: "claude_code",
    model: "sonnet",
    session: { id: "s1", resume: true, machineId, cwd: "" },
    account: { id: OWN1, label: "Conta a001", status: "active" },
  };
  const deps = { db: fx.db, machines: { status: async (id: string) => statusOf(id) } };
  const order: string[] = [];
  let tried = [OWN1];
  for (;;) {
    const next = await nextAccountPlan(deps, agent, plan, tried);
    if (!next.plan?.account) {
      // The four it went through count as the chain, with its own account's reset.
      expect(next).toMatchObject({ plan: null, chain: 4, resetsAt: expect.any(String) });
      break;
    }
    order.push(next.plan.account.id);
    if (next.plan.account.id === WALTER_ALL) expect(next.lentBy).toBe(walter.id);
    else expect(next.lentBy).toBeNull();
    // A fresh session on the same computer.
    expect(next.plan.session).toMatchObject({ machineId, resume: false });
    expect(next.plan.session?.id).not.toBe("s1");
    tried = [...tried, next.plan.account.id];
  }
  expect(order).toEqual([OWN3, OWN2, WALTER_ALL]);

  // Pinned to its own account ("Só esta conta"): it never moves.
  expect(await nextAccountPlan(deps, { ...agent, brainAccountPinned: true }, plan, [OWN1])).toEqual({
    plan: null,
    chain: 0,
  });
  // Antigravity's accounts never rotate (Google forbids it); a key account isn't a subscription.
  expect(await nextAccountPlan(deps, agent, { ...plan, kind: "antigravity" }, [OWN1])).toEqual({
    plan: null,
    chain: 0,
  });
  expect(await nextAccountPlan(deps, agent, { ...plan, kind: "grok" }, [OWN1])).toEqual({ plan: null, chain: 0 });
  expect(
    await nextAccountPlan(
      deps,
      agent,
      { ...plan, account: { id: OWN1, label: "Conta a001", status: "active", provider: "zai" } },
      [OWN1],
    ),
  ).toEqual({ plan: null, chain: 0 });
});

test("Codex accounts go on within Codex; another login of the same seat is never the next", async () => {
  const { fx, machineId, account } = await world();
  await fx.db
    .update(schema.machineAccounts)
    .set({ kind: "codex", email: "joao@example.com" })
    .where(eq(schema.machineAccounts.id, OWN1));
  await account(OWN2, fx.owner.id, { kind: "codex", email: "JOAO@example.com" });
  await account(OWN3, fx.owner.id, { kind: "codex", email: "ada@example.com" });
  await account(WALTER_ALL, fx.owner.id, { email: "walter@example.com" });
  const agent = await agentRow(fx);
  if (!agent) throw new Error("no agent");
  const plan: BrainPlan = {
    kind: "codex",
    session: { id: "s1", resume: true, machineId, cwd: "" },
    account: { id: OWN1, label: "Conta a001", status: "active" },
  };
  const status = async (id: string): Promise<MachineStatus> => ({
    ...statusOf(id),
    executors: { codex: { version: "0.200.0" }, detectedAt: new Date().toISOString() },
  });
  const next = await nextAccountPlan({ db: fx.db, machines: { status } }, agent, plan, [OWN1]);
  expect(next.plan?.account?.id).toBe(OWN3);
});

test("an account whose usage is unknown is tried; refused, the next one answers, with one line", async () => {
  const { fx, account, usage } = await world();
  await account(OWN2, fx.owner.id);
  await account(OWN3, fx.owner.id);
  await usage(OWN1, 100);
  const { brain, seen } = scripted((n) =>
    n === 0 ? [{ type: "error", code: "plan_limit", message: "You've hit your limit", worked: false }] : answers,
  );
  await ask(fx);
  await drainOutbox(fx.db, handlersWith(fx, brain));
  expect(seen.map((t) => t.account?.id)).toEqual([OWN2, OWN3]);
  // Each in a session of its own.
  expect(seen[1]?.session?.id).not.toBe(seen[0]?.session?.id);
  const [run] = await runs(fx);
  expect(run?.status).toBe("done");
  expect(moveOf(run)).toEqual({ from: OWN1, to: OWN3, tried: [OWN1, OWN2, OWN3] });
  // The first account it left, the last it moved to.
  expect(switchOf(run)).toMatchObject({ from: { id: OWN1 }, to: { id: OWN3 } });
  expect(await movedLines(fx)).toHaveLength(0);
});

test("every account refusing: each is tried once, then the run waits for the plan, never in a loop", async () => {
  const { fx, account, usage } = await world();
  await account(OWN2, fx.owner.id);
  await account(OWN3, fx.owner.id);
  await usage(OWN1, 100);
  const { brain, seen } = scripted(() => [
    { type: "error", code: "plan_limit", message: "You've hit your limit", worked: false },
  ]);
  await ask(fx);
  await drainOutbox(fx.db, handlersWith(fx, brain));
  expect(seen.map((t) => t.account?.id)).toEqual([OWN2, OWN3]);
  const [run] = await runs(fx);
  expect(run?.status).toBe("waiting_input");
  const [all] = await notes(fx, "plan_limit_all_wait");
  expect(all?.meta.bodyParams).toMatchObject({ accounts: "3", plan: "Claude" });
  // Its next claim starts on its own account again.
  expect(moveOf(run)).toBeUndefined();
});

test("every account at its limit: the run waits until the first of them resets, and says how many", async () => {
  const { fx, walter, account, usage } = await world();
  await account(OWN2, fx.owner.id);
  await account(WALTER_ALL, walter.id);
  const first = iso(3600_000);
  await usage(OWN1, 100, iso(3 * 3600_000));
  await usage(OWN2, 100, iso(2 * 3600_000));
  await usage(WALTER_ALL, 100, first);
  const { brain, seen } = scripted(() => answers);
  await ask(fx);
  await drainOutbox(fx.db, handlersWith(fx, brain));
  expect(seen).toHaveLength(0);
  const [run] = await runs(fx);
  expect(run?.status).toBe("waiting_input");
  const wait = (
    run?.transcript as { waitingForBrain?: { code: string; resetsAt?: string; until?: string } } | undefined
  )?.waitingForBrain;
  expect(wait).toMatchObject({ code: "plan_limit", resetsAt: first });
  expect(Date.parse(wait?.until ?? "")).toBe(Date.parse(first) + RESUME_AFTER_MS);
  const [all, ...more] = await notes(fx, "plan_limit_all_wait");
  expect(more).toHaveLength(0);
  expect(all?.meta.bodyParams).toMatchObject({ accounts: "3", plan: "Claude" });
  expect(all?.meta.usageWait).toMatchObject({ resetsAt: first });
  expect(await movedLines(fx)).toHaveLength(0);
  // The agent's line says the whole order waits, until the first reset.
  expect(await usageQueue(fx.db, fx.owner.id, fx.org.id, fx.agent.id)).toMatchObject({
    reason: "plan",
    chain: 3,
    resetsAt: first,
  });
});

test("every account at its limit with Continuar com a chave de API on: the workspace's key answers instead of waiting", async () => {
  const { fx, walter, account, usage } = await world();
  await account(WALTER_ALL, walter.id);
  await usage(OWN1, 100);
  await usage(WALTER_ALL, 100);
  await setPlanKeyFallback(fx.db, fx.owner.id, fx.org.id, true);
  const { brain, seen } = scripted(() => answers);
  await ask(fx);
  await drainOutbox(fx.db, handlersWith(fx, brain));
  expect(seen).toHaveLength(0);
  const [run] = await runs(fx);
  expect(run).toMatchObject({ status: "done", brain: "model" });
  expect(await notes(fx, "plan_limit_all_wait")).toHaveLength(0);
  // The move is the run's: the agent keeps its own account as its first choice.
  expect((await agentRow(fx))?.brainAccountId).toBe(OWN1);
});

test("an agent pinned to its account waits for it, as before", async () => {
  const { fx, account, usage } = await world({ brainAccountPinned: true });
  await account(OWN2, fx.owner.id);
  await usage(OWN1, 100);
  const { brain, seen } = scripted(() => answers);
  await ask(fx);
  await drainOutbox(fx.db, handlersWith(fx, brain));
  expect(seen).toHaveLength(0);
  expect((await runs(fx))[0]?.status).toBe("waiting_input");
  expect(await notes(fx, "plan_limit_wait")).toHaveLength(1);
  expect(await movedLines(fx)).toHaveLength(0);
});

test("signed out or its computer away: never a reason to move", async () => {
  const { fx, account } = await world();
  await account(OWN2, fx.owner.id);
  await fx.db.update(schema.machineAccounts).set({ status: "signed_out" }).where(eq(schema.machineAccounts.id, OWN1));
  const { brain, seen } = scripted(() => answers);
  await ask(fx);
  await drainOutbox(fx.db, handlersWith(fx, brain));
  expect(seen).toHaveLength(0);
  const [signedOut] = await runs(fx);
  expect(moveOf(signedOut)).toBeUndefined();
  expect(signedOut?.status).toBe("failed");

  await fx.db.update(schema.machineAccounts).set({ status: "active" }).where(eq(schema.machineAccounts.id, OWN1));
  await ask(fx, "@dev de novo");
  await drainOutbox(fx.db, handlersWith(fx, brain, false));
  expect(seen).toHaveLength(0);
  const [, offline] = await runs(fx);
  expect(offline?.status).toBe("waiting_input");
  expect(moveOf(offline)).toBeUndefined();
});

test("a provider failure on the turn never moves: the run fails on its own account", async () => {
  const { fx, account } = await world();
  await account(OWN2, fx.owner.id);
  const { brain, seen } = scripted(() => [{ type: "error", code: "cli_failed", message: "boom", retryable: false }]);
  await ask(fx);
  await drainOutbox(fx.db, handlersWith(fx, brain));
  expect(seen.map((t) => t.account?.id)).toEqual([OWN1]);
  expect(moveOf((await runs(fx))[0])).toBeUndefined();
});

for (const [cause, failure] of [
  ["an outage that may pass", { code: "claude_failed", message: "Overloaded", retryable: true }],
  ["a sign-in that ended", { code: "not_logged_in", message: "Please run /login", retryable: false }],
  ["its computer dropping", { code: "machine_offline", message: "The computer is offline.", retryable: true }],
] as const) {
  test(`${cause}, found on the turn, never moves the run, though another account of its owner has room`, async () => {
    const { fx, account } = await world();
    // Both have answered before: a sign-in that never worked ends at once on its own.
    await fx.db
      .update(schema.machineAccounts)
      .set({ lastSuccessAt: new Date() })
      .where(eq(schema.machineAccounts.id, OWN1));
    await account(OWN2, fx.owner.id, { lastSuccessAt: new Date() });
    const { brain, seen } = scripted(() => [{ type: "error", ...failure }]);
    await ask(fx);
    await drainOutbox(fx.db, handlersWith(fx, brain)).catch(() => {});
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((t) => t.account?.id !== OWN1)).toEqual([]);
    const [run] = await runs(fx);
    expect(moveOf(run)).toBeUndefined();
    expect(await movedLines(fx)).toHaveLength(0);
  });
}

test("a turn the plan cut after it worked waits on its own account: a fresh session couldn't see what it did", async () => {
  const { fx, account } = await world();
  await account(OWN2, fx.owner.id);
  const { brain, seen } = scripted((n) =>
    n === 0
      ? [
          {
            type: "tool_call",
            id: "c1",
            name: "Bash",
            input: { command: "git push origin main" },
            executed: { content: "ok" },
          },
          { type: "limit", resetsAt: iso(3600_000) },
          { type: "error", code: "plan_limit", message: "You've hit your limit", worked: true },
        ]
      : answers,
  );
  await ask(fx);
  const handlers = handlersWith(fx, brain);
  await drainOutbox(fx.db, handlers);
  expect(seen.map((t) => t.account?.id)).toEqual([OWN1]);
  const [run] = await runs(fx);
  expect(run?.status).toBe("waiting_input");
  expect(moveOf(run)).toBeUndefined();
  expect(await notes(fx, "plan_limit_cut")).toHaveLength(1);

  // After the reset it finishes there, in the same session.
  clearPlanLimits();
  await drainOutbox(fx.db, handlers, { now: later(3600_000 + RESUME_AFTER_MS + 1000) });
  expect(seen.map((t) => t.account?.id)).toEqual([OWN1, OWN1]);
  expect(seen[1]?.session?.id).toBe(seen[0]?.session?.id ?? "");
});

test("a run that moved resumes on the account it moved to, in its session there", async () => {
  const { fx, account, usage } = await world();
  await account(OWN2, fx.owner.id);
  await usage(OWN1, 100, iso(5 * 3600_000));
  // On the next account the plan cuts the turn after it worked: it waits there, for that account.
  const { brain, seen } = scripted((n) =>
    n === 0
      ? [
          { type: "usage", input: 100, output: 10, source: "plan", model: "sonnet" },
          { type: "tool_call", id: "c1", name: "Bash", input: { command: "ls" }, executed: { content: "ok" } },
          { type: "limit", resetsAt: iso(3600_000) },
          { type: "error", code: "plan_limit", message: "You've hit your limit", worked: true },
        ]
      : answers,
  );
  await ask(fx);
  const handlers = handlersWith(fx, brain);
  await drainOutbox(fx.db, handlers);
  const [parked] = await runs(fx);
  expect(parked?.status).toBe("waiting_input");
  expect(moveOf(parked)?.to).toBe(OWN2);
  // Its line names the account it waits on: the one it moved to, not the agent's own.
  expect(await usageQueue(fx.db, fx.owner.id, fx.org.id, fx.agent.id)).toMatchObject({
    reason: "plan",
    account: { id: OWN2, label: "Conta a002" },
    chain: null,
  });

  clearPlanLimits();
  await drainOutbox(fx.db, handlers, { now: later(3600_000 + RESUME_AFTER_MS + 1000) });
  expect(seen.map((t) => t.account?.id)).toEqual([OWN2, OWN2]);
  expect(seen[1]?.session).toMatchObject({ id: seen[0]?.session?.id, resume: true });
  expect((await runs(fx))[0]?.status).toBe("done");
  expect(switchOf((await runs(fx))[0])).toMatchObject({ from: { id: OWN1 }, to: { id: OWN2 } });
  expect(await movedLines(fx)).toHaveLength(0);
  expect((await agentRow(fx))?.brainAccountId).toBe(OWN1);
});

test("the next run in a conversation back on its own account starts a fresh session: the other account's folder holds the last one", async () => {
  const { fx, account, usage } = await world();
  await account(OWN2, fx.owner.id);
  await usage(OWN1, 100);
  const { brain, seen } = scripted(() => answers);
  const dm = await openPersonAgentDm(fx.db, fx.org.id, fx.owner.id, fx.agent.id);
  const say = (body: string) =>
    postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, dm.id, { body });
  await say("oi");
  await drainOutbox(fx.db, handlersWith(fx, brain));
  await usage(OWN1, 10);
  clearPlanLimits();
  await say("e agora?");
  await drainOutbox(fx.db, handlersWith(fx, brain));
  expect(seen.map((t) => t.account?.id)).toEqual([OWN2, OWN1]);
  expect(seen[1]?.session?.resume).toBe(false);
  expect(seen[1]?.session?.id).not.toBe(seen[0]?.session?.id ?? "");
});

/** A brain whose first turn runs `git push` and then asks the person a question: the run waits for the answer. */
function pushesThenAsks(fx: Fixture, machineId: string) {
  const seen: BrainTurn[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      seen.push({ ...turn, system: "", messages: [] });
      if (seen.length > 1) {
        yield* answers;
        return;
      }
      yield { type: "usage", input: 100, output: 10, source: "plan", model: "sonnet" };
      yield { type: "tool_call", id: "c1", name: "Bash", input: { command: "git push" }, executed: { content: "ok" } };
      const call = {
        id: "ask-1",
        name: "ask_user",
        input: { why: "I need a person's answer before I go on: this decides what I change next.", question: "Sigo?" },
      };
      const where = { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId };
      yield {
        type: "tool_call",
        id: "ask-1",
        name: "ask_user",
        input: {},
        executed: await executeToolForRun(fx.jobDeps, where, call),
      };
      yield { type: "done", text: "" };
    },
  };
  return { brain, seen };
}

const answerTheQuestion = async (fx: Fixture) => {
  const [q] = await fx.db.select().from(schema.agentQuestions);
  await answerQuestion({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, q?.id ?? "", { text: "sim" });
};

const turnPrompt = async (fx: Fixture) =>
  ((await runs(fx))[0]?.transcript as { turnPrompt?: string } | undefined)?.turnPrompt ?? "";

test("a moved run that waited on a person goes back to its own account once it reset, told what it already ran", async () => {
  const { fx, machineId, account, usage } = await world({}, { askUser: true });
  await account(OWN2, fx.owner.id);
  await usage(OWN1, 100);
  const { brain, seen } = pushesThenAsks(fx, machineId);
  await ask(fx);
  const handlers = handlersWith(fx, brain);
  await drainOutbox(fx.db, handlers);
  const [parked] = await runs(fx);
  expect(parked?.status).toBe("waiting_input");
  expect(moveOf(parked)?.to).toBe(OWN2);

  // Meanwhile the account it moved to is at its limit and its own reset: its own takes it, not a wait for the other.
  await usage(OWN2, 100, iso(5 * 3600_000));
  await usage(OWN1, 10);
  clearPlanLimits();
  await answerTheQuestion(fx);
  await drainOutbox(fx.db, handlers);
  expect(seen.map((t) => t.account?.id)).toEqual([OWN2, OWN1]);
  const [done] = await runs(fx);
  expect(done?.status).toBe("done");
  expect(moveOf(done)).toBeUndefined();
  expect(await turnPrompt(fx)).toContain("Already done in this run, do not repeat: ");
  expect(await turnPrompt(fx)).toContain("git push");
});

test("every account limited after the run worked: when its own resets, the fresh session there is told what it ran", async () => {
  const { fx, machineId, account, usage } = await world({}, { askUser: true });
  await account(OWN2, fx.owner.id);
  await usage(OWN1, 100);
  const { brain, seen } = pushesThenAsks(fx, machineId);
  await ask(fx);
  const handlers = handlersWith(fx, brain);
  await drainOutbox(fx.db, handlers);
  await usage(OWN2, 100, iso(3 * 3600_000));
  await usage(OWN1, 100, iso(3600_000));
  clearPlanLimits();
  await answerTheQuestion(fx);
  await drainOutbox(fx.db, handlers);
  const [parked] = await runs(fx);
  expect(parked?.status).toBe("waiting_input");
  expect(moveOf(parked)).toBeUndefined();

  await usage(OWN1, 10);
  clearPlanLimits();
  await drainOutbox(fx.db, handlers, { now: later(3600_000 + RESUME_AFTER_MS + 1000) });
  expect(seen.map((t) => t.account?.id)).toEqual([OWN2, OWN1]);
  expect(seen[1]?.session?.resume).toBe(false);
  expect(await turnPrompt(fx)).toContain("git push");
});

test("the teammate's account a run waits on stops serving it: the run wakes on its own account, told what it ran", async () => {
  const { fx, walter, account, usage } = await world();
  await account(WALTER_ALL, walter.id);
  await usage(OWN1, 100, iso(5 * 3600_000));
  const { brain, seen } = scripted((n) =>
    n === 0
      ? [
          { type: "usage", input: 100, output: 10, source: "plan", model: "sonnet" },
          { type: "tool_call", id: "c1", name: "Bash", input: { command: "git push" }, executed: { content: "ok" } },
          { type: "limit", resetsAt: iso(5 * 24 * 3600_000) },
          { type: "error", code: "plan_limit", message: "You've hit your limit", worked: true },
        ]
      : answers,
  );
  await ask(fx);
  const handlers = handlersWith(fx, brain);
  await drainOutbox(fx.db, handlers);
  expect(moveOf((await runs(fx))[0])).toMatchObject({ to: WALTER_ALL, lentBy: walter.id });
  // Two people's accounts often share a label: the details name whose it is.
  expect(switchOf((await runs(fx))[0])).toEqual({
    from: { id: OWN1, name: "Conta a001" },
    to: { id: WALTER_ALL, name: `Conta b001 (${walter.name})` },
    cause: "limit",
  });

  await usage(OWN1, 10);
  clearPlanLimits();
  await setAccountServes({ db: fx.db, pubsub: fx.pubsub }, walter.id, fx.org.id, WALTER_ALL, "owner");
  // Woken now, not at the end of that account's week.
  await drainOutbox(fx.db, handlers);
  expect(seen.map((t) => t.account?.id)).toEqual([WALTER_ALL, OWN1]);
  const [done] = await runs(fx);
  expect(done?.status).toBe("done");
  expect(moveOf(done)).toBeUndefined();
  expect(await turnPrompt(fx)).toContain("do not repeat: Bash (git push)");
});

test("its own account signed out while a moved run waits on a person: the account it moved to goes on with it", async () => {
  const { fx, machineId, account, usage } = await world({}, { askUser: true });
  await account(OWN2, fx.owner.id);
  await usage(OWN1, 100);
  const { brain, seen } = pushesThenAsks(fx, machineId);
  await ask(fx);
  const handlers = handlersWith(fx, brain);
  await drainOutbox(fx.db, handlers);
  expect(moveOf((await runs(fx))[0])?.to).toBe(OWN2);
  await usage(OWN1, 10);
  clearPlanLimits();
  await fx.db.update(schema.machineAccounts).set({ status: "signed_out" }).where(eq(schema.machineAccounts.id, OWN1));
  await answerTheQuestion(fx);
  await drainOutbox(fx.db, handlers);
  expect(seen.map((t) => t.account?.id)).toEqual([OWN2, OWN2]);
  const [done] = await runs(fx);
  expect(done?.status).toBe("done");
});

test("the account a run moved to stops serving it while it waits on a person: its own account goes on, told what it ran", async () => {
  const { fx, machineId, walter, account, usage } = await world({}, { askUser: true });
  await account(WALTER_ALL, walter.id);
  await usage(OWN1, 100);
  const { brain, seen } = pushesThenAsks(fx, machineId);
  await ask(fx);
  const handlers = handlersWith(fx, brain);
  await drainOutbox(fx.db, handlers);
  expect(moveOf((await runs(fx))[0])?.to).toBe(WALTER_ALL);
  await usage(OWN1, 10);
  clearPlanLimits();
  await setAccountServes({ db: fx.db, pubsub: fx.pubsub }, walter.id, fx.org.id, WALTER_ALL, "owner");
  await answerTheQuestion(fx);
  await drainOutbox(fx.db, handlers);
  expect(seen.map((t) => t.account?.id)).toEqual([WALTER_ALL, OWN1]);
  expect(seen[1]?.session?.resume).toBe(false);
  expect(await turnPrompt(fx)).toContain("Already done in this run, do not repeat: ");
});

test("only logins shared between agents take a run, never a one-agent login; its own takes it back whatever its sharing", async () => {
  const { fx, machineId, account, usage } = await world();
  await account(OWN2, fx.owner.id, { shared: false });
  await account(OWN3, fx.owner.id);
  await usage(OWN1, 100);
  await fx.db.update(schema.machineAccounts).set({ shared: false }).where(eq(schema.machineAccounts.id, OWN1));
  const agent = await agentRow(fx);
  if (!agent) throw new Error("no agent");
  const deps = { db: fx.db, machines: { status: async (id: string) => statusOf(id) } };
  const on = (id: string): BrainPlan => ({
    kind: "claude_code",
    model: "sonnet",
    session: { id: "s1", resume: true, machineId, cwd: "" },
    account: { id, label: id, status: "active" },
  });
  const next = await nextAccountPlan(deps, agent, on(OWN1), [OWN1], { own: OWN1 });
  expect(next.plan?.account?.id).toBe(OWN3);
  await usage(OWN1, 10);
  await usage(OWN3, 100);
  const back = await nextAccountPlan(deps, agent, on(OWN3), [OWN3], { own: OWN1 });
  expect(back.plan?.account?.id).toBe(OWN1);
  // On resume a one-agent login no longer takes the run either.
  expect(await movedAccountPlan(deps, agent, on(OWN1), OWN2)).toBeNull();
});

test("long work past the line on its owner's plan goes on with a free account before paying for extra usage", async () => {
  const { fx, account, usage } = await world();
  await account(OWN2, fx.owner.id);
  await usage(OWN2, 10);
  const extraOpen = {
    ...reading(99),
    windows: [...reading(99).windows, { kind: "other", label: "Extra usage", usedPercent: 10 }],
  };
  await fx.db
    .update(schema.machineAccounts)
    .set({ usage: extraOpen as never })
    .where(eq(schema.machineAccounts.id, OWN1));
  const { brain, seen } = scripted(() => answers);
  await scheduledSlot(fx);
  await drainOutbox(fx.db, handlersWith(fx, brain));
  expect(seen.map((t) => t.account?.id)).toEqual([OWN2]);
  expect(moveOf((await runs(fx))[0])).toMatchObject({ from: OWN1, to: OWN2 });
});

/** A scheduled slot of a routine: long work by kind. */
async function scheduledSlot(fx: Fixture) {
  const deps = { db: fx.db, pubsub: fx.pubsub, context: fx.context };
  const routine = await createRoutine(deps, fx.owner.id, fx.org.id, {
    name: "Deploys",
    agentId: fx.agent.id,
    prompt: "Check the deploys.",
    target: { type: "channel", channelId: fx.general.id },
    trigger: { type: "schedule", phrase: "todo dia às 8h" },
  });
  await runRoutineNow(deps, fx.owner.id, fx.org.id, routine.id);
  await fx.db
    .update(schema.routineRuns)
    .set({ trigger: "schedule" })
    .where(eq(schema.routineRuns.routineId, routine.id));
}

test("long work at the pause line goes on with the next account under it, quietly, and pauses on the last", async () => {
  const { fx, walter, account, usage } = await world();
  await account(OWN2, fx.owner.id);
  await account(WALTER_ALL, walter.id);
  await usage(OWN1, 99);
  await usage(OWN2, 99);
  await usage(WALTER_ALL, 40);
  const { brain, seen } = scripted(() => answers);
  await scheduledSlot(fx);
  await drainOutbox(fx.db, handlersWith(fx, brain));
  expect(seen.map((t) => t.account?.id)).toEqual([WALTER_ALL]);
  const [run] = await runs(fx);
  expect(run?.status).toBe("done");
  // Someone else's plan is lent to the run: its long work never spends that plan's paid extra usage.
  expect(moveOf(run)).toMatchObject({ to: WALTER_ALL, lentBy: walter.id });
  // A routine's run says nothing in the conversation.
  expect(await movedLines(fx)).toHaveLength(0);

  // Every account over the line: it pauses on its own.
  await usage(WALTER_ALL, 99);
  await scheduledSlot(fx);
  await drainOutbox(fx.db, handlersWith(fx, brain));
  expect(seen).toHaveLength(1);
  const [, paused] = await runs(fx);
  expect((paused?.transcript as { waitingForBrain?: { code: string } } | undefined)?.waitingForBrain?.code).toBe(
    "usage_pause",
  );
  expect(moveOf(paused)).toBeUndefined();
});

test("a paused run on a teammate's account it moved to never goes on into that plan's paid extra usage", async () => {
  const { fx, walter, account, usage } = await world();
  await account(WALTER_ALL, walter.id);
  await usage(OWN1, 99);
  await usage(WALTER_ALL, 99);
  const { brain } = scripted(() => answers);
  await scheduledSlot(fx);
  await drainOutbox(fx.db, handlersWith(fx, brain));
  const [run] = await runs(fx);
  if (!run) throw new Error("no run");
  // The plan's window used up, its extra usage still open: the agent's owner's own plan may go on into it.
  const full = {
    ...reading(100),
    windows: [...reading(100).windows, { kind: "other", label: "Extra usage", usedPercent: 10 }],
  };
  await fx.db
    .update(schema.machineAccounts)
    .set({ usage: full as never })
    .where(eq(schema.machineAccounts.id, OWN1));
  expect(await pauseContinuesPastPlan(fx.db, fx.org.id, run.id)).toBeNull();
  // The same wait on the account it moved to, Walter's: lent, so it may not.
  const t = run.transcript as Record<string, unknown>;
  await fx.db
    .update(schema.agentRuns)
    .set({
      transcript: { ...t, accountMove: { from: OWN1, to: WALTER_ALL, lentBy: walter.id, tried: [OWN1, WALTER_ALL] } },
    })
    .where(eq(schema.agentRuns.id, run.id));
  expect(await pauseContinuesPastPlan(fx.db, fx.org.id, run.id)).toBe("extra_off");
});

test("long work at its own account's limit never moves onto an account past the pause line: it waits for its own", async () => {
  const { fx, walter, account, usage } = await world();
  await account(WALTER_ALL, walter.id);
  await usage(OWN1, 100, iso(5 * 3600_000));
  const pastLine = {
    ...reading(99),
    windows: [...reading(99).windows, { kind: "other", label: "Extra usage", usedPercent: 10 }],
  };
  await fx.db
    .update(schema.machineAccounts)
    .set({ usage: pastLine as never })
    .where(eq(schema.machineAccounts.id, WALTER_ALL));
  const { brain, seen } = scripted(() => answers);
  await scheduledSlot(fx);
  await drainOutbox(fx.db, handlersWith(fx, brain));
  expect(seen).toHaveLength(0);
  const [run] = await runs(fx);
  const waiting = (run?.transcript as { waitingForBrain?: { code: string; waitKey?: string } } | undefined)
    ?.waitingForBrain;
  expect(waiting?.code).toBe("plan_limit");
  expect(waiting?.waitKey).toContain(OWN1);
  expect(moveOf(run)).toBeUndefined();
});

/** A follow-through judge that sends a turn ending in "vou seguir" on to the next turn. */
const goesOn = {
  judge: (kind: string, _id: string, state: Record<string, unknown>) =>
    kind === "follow_through" ? (String(state.reply).includes("vou seguir") ? "continue" : "done") : undefined,
};

/**
 * Each of its first `turns` turns runs a step, puts the account it ran on at 99% of its week (`extra`: with that plan's
 * paid extra usage open), then says it goes on.
 */
function fillsTheWeek(fx: Fixture, turns = 1, extra = false) {
  const seen: BrainTurn[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      seen.push({ ...turn, system: "", messages: [] });
      if (seen.length > turns) {
        yield* answers;
        return;
      }
      await fx.db
        .update(schema.machineAccounts)
        .set({
          usage: {
            windows: [
              { kind: "seven_day", usedPercent: 99, resetsAt: iso(5 * 24 * 3600_000) },
              ...(extra ? [{ kind: "other", label: "Extra usage", usedPercent: 10 }] : []),
            ],
            source: "turn",
            at: new Date().toISOString(),
          } as never,
        })
        .where(eq(schema.machineAccounts.id, turn.account?.id ?? ""));
      const step = `step ${seen.length}`;
      yield { type: "usage", input: 100, output: 10, source: "plan", model: "sonnet" };
      yield { type: "tool_call", id: step, name: "Bash", input: { command: step }, executed: { content: "ok" } };
      yield { type: "done", text: `Fiz o ${step}, vou seguir.` };
    },
  };
  return { brain, seen };
}

test("long work moved onto a teammate's account that reaches the line there goes back into its own plan's extra usage", async () => {
  const { fx, walter, account, usage } = await world({}, goesOn);
  await account(WALTER_ALL, walter.id);
  await usage(WALTER_ALL, 40);
  const extraOpen = {
    ...reading(99, iso(3 * 3600_000)),
    windows: [...reading(99, iso(3 * 3600_000)).windows, { kind: "other", label: "Extra usage", usedPercent: 10 }],
  };
  await fx.db
    .update(schema.machineAccounts)
    .set({ usage: extraOpen as never })
    .where(eq(schema.machineAccounts.id, OWN1));
  const { brain, seen } = fillsTheWeek(fx);
  await scheduledSlot(fx);
  await drainOutbox(fx.db, handlersWith(fx, brain));
  // A free account first, then its owner's paid extra usage, never a wait on the teammate's week.
  expect(seen.map((t) => t.account?.id)).toEqual([WALTER_ALL, OWN1]);
  const [run] = await runs(fx);
  expect(run?.status).toBe("done");
  expect(moveOf(run)).toBeUndefined();
});

test("long work moved onto a teammate's account that reaches the line there waits for its own account's earlier reset", async () => {
  const { fx, walter, account, usage } = await world({}, goesOn);
  await account(WALTER_ALL, walter.id);
  await usage(WALTER_ALL, 40);
  await usage(OWN1, 99, iso(3 * 3600_000));
  const { brain, seen } = fillsTheWeek(fx);
  await scheduledSlot(fx);
  await drainOutbox(fx.db, handlersWith(fx, brain));
  expect(seen.map((t) => t.account?.id)).toEqual([WALTER_ALL]);
  const [run] = await runs(fx);
  const waiting = (run?.transcript as { waitingForBrain?: { code: string; until?: string } } | undefined)
    ?.waitingForBrain;
  expect(waiting?.code).toBe("usage_pause");
  // Its next claim starts on its own account, at its own reset, not at the end of the teammate's week.
  expect(moveOf(run)).toBeUndefined();
  expect(Date.parse(waiting?.until ?? "")).toBeLessThan(Date.now() + 4 * 3600_000);
});

test("long work on a teammate's account it moved to stops at that plan's line, though its paid extra usage is open", async () => {
  const { fx, walter, account, usage } = await world({}, goesOn);
  await account(WALTER_ALL, walter.id);
  await usage(WALTER_ALL, 40);
  await usage(OWN1, 99, iso(3 * 3600_000));
  const { brain, seen } = fillsTheWeek(fx, 1, true);
  await scheduledSlot(fx);
  await drainOutbox(fx.db, handlersWith(fx, brain));
  // One turn on Walter's account, then a wait: never a second turn there on Walter's paid extra usage.
  expect(seen.map((t) => t.account?.id)).toEqual([WALTER_ALL]);
  const [run] = await runs(fx);
  expect((run?.transcript as { waitingForBrain?: { code: string } } | undefined)?.waitingForBrain?.code).toBe(
    "usage_pause",
  );
});

test("a run that moves twice in one claim: each fresh session is told what the run already ran", async () => {
  const { fx, account } = await world({}, goesOn);
  await account(OWN2, fx.owner.id);
  await account(OWN3, fx.owner.id);
  const refused: BrainEvent[] = [
    { type: "error", code: "plan_limit", message: "You've hit your limit", worked: false },
  ];
  const works = (command: string): BrainEvent[] => [
    { type: "usage", input: 100, output: 10, source: "plan", model: "sonnet" },
    { type: "tool_call", id: command, name: "Bash", input: { command }, executed: { content: "ok" } },
    { type: "done", text: `Rodei ${command}, vou seguir.` },
  ];
  const turns = [works("git push"), refused, works("git tag"), refused];
  const { brain, seen } = scripted((n) => turns[n] ?? answers);
  await ask(fx);
  await drainOutbox(fx.db, handlersWith(fx, brain));
  expect(seen.map((t) => t.account?.id)).toEqual([OWN1, OWN1, OWN2, OWN2, OWN3]);
  expect((await runs(fx))[0]?.status).toBe("done");
  const last = await turnPrompt(fx);
  expect(last).toContain("Already done in this run, do not repeat: ");
  expect(last).toContain("Bash(git tag)");
  // Told once, not once per move.
  expect(last.split("Already done in this run").length).toBe(2);
});

test("the first turn on the account a run moved to refused for room: the next claim's fresh session is still told what ran", async () => {
  const { fx, account } = await world({}, goesOn);
  await account(OWN2, fx.owner.id);
  const turns: BrainEvent[][] = [
    [
      { type: "usage", input: 100, output: 10, source: "plan", model: "sonnet" },
      { type: "tool_call", id: "c1", name: "Bash", input: { command: "git push" }, executed: { content: "ok" } },
      { type: "done", text: "Rodei git push, vou seguir." },
    ],
    [{ type: "error", code: "plan_limit", message: "You've hit your limit", worked: false }],
    [{ type: "error", code: "busy", message: "No room for another turn", retryable: true }],
  ];
  const { brain, seen } = scripted((n) => turns[n] ?? answers);
  await ask(fx);
  const handlers = handlersWith(fx, brain);
  await drainOutbox(fx.db, handlers);
  expect(seen.map((t) => t.account?.id)).toEqual([OWN1, OWN1, OWN2]);
  await drainOutbox(fx.db, handlers, { now: later(60_000) });
  expect(seen.map((t) => t.account?.id)).toEqual([OWN1, OWN1, OWN2, OWN2]);
  expect(seen[3]?.session?.resume).toBe(false);
  expect(await turnPrompt(fx)).toContain("Already done in this run, do not repeat: Bash(git push)");
});

test("the switch keeps the first account the run left, also when it moves again after every account was limited", async () => {
  const { fx, account, usage } = await world();
  await account(OWN2, fx.owner.id);
  await usage(OWN1, 100, iso(3600_000));
  await usage(OWN2, 10);
  const refused: BrainEvent[] = [
    { type: "error", code: "plan_limit", message: "You've hit your limit", worked: false },
  ];
  const { brain, seen } = scripted((n) => (n === 0 ? refused : answers));
  await ask(fx);
  const handlers = handlersWith(fx, brain);
  await drainOutbox(fx.db, handlers);
  const [parked] = await runs(fx);
  expect(moveOf(parked)).toBeUndefined();
  expect(switchOf(parked)).toMatchObject({ from: { id: OWN1 }, to: { id: OWN2 } });

  // Its own account still at its limit when it wakes: it moves again, without a second line.
  await usage(OWN1, 100, iso(5 * 3600_000));
  clearPlanLimits();
  await drainOutbox(fx.db, handlers, { now: later(3600_000 + RESUME_AFTER_MS + 1000) });
  expect(seen.map((t) => t.account?.id)).toEqual([OWN2, OWN2]);
  expect((await runs(fx))[0]?.status).toBe("done");
  expect(switchOf((await runs(fx))[0])).toMatchObject({ from: { id: OWN1 }, to: { id: OWN2 } });
  expect(await movedLines(fx)).toHaveLength(0);
});

test("long work at the pause line of a teammate's account records the switch, naming whose account it leaves and whose it takes", async () => {
  const { fx, walter, account, usage } = await world({}, goesOn);
  await account(WALTER_ALL, walter.id);
  await fx.db
    .update(schema.agents)
    .set({ brainAccountId: WALTER_ALL, brainAccountLentBy: walter.id })
    .where(eq(schema.agents.id, fx.agent.id));
  await usage(WALTER_ALL, 40);
  await usage(OWN1, 40);
  const { brain, seen } = fillsTheWeek(fx);
  // Ten minutes and more of work by its first turn's end: a conversation's run is long work from there.
  const long: Brain = {
    kind: "claude_code",
    async *run(turn, io) {
      yield* brain.run(turn, io);
      if (seen.length === 1) setSystemTime(later(11 * 60_000));
    },
  };
  try {
    await ask(fx);
    await drainOutbox(fx.db, handlersWith(fx, long));
  } finally {
    setSystemTime();
  }
  expect(seen.map((t) => t.account?.id)).toEqual([WALTER_ALL, OWN1]);
  expect(switchOf((await runs(fx))[0])).toEqual({
    from: { id: WALTER_ALL, name: `Conta b001 (${walter.name})` },
    to: { id: OWN1, name: "Conta a001" },
    cause: "line",
  });
  expect(await movedLines(fx)).toHaveLength(0);
});

test("long work on a plan lent to its agent never goes back into that plan's paid extra usage from the account it moved to", async () => {
  const { fx, walter, account, usage } = await world({}, goesOn);
  await account(WALTER_ALL, walter.id);
  await fx.db
    .update(schema.agents)
    .set({ brainAccountId: WALTER_ALL, brainAccountLentBy: walter.id })
    .where(eq(schema.agents.id, fx.agent.id));
  const extraOpen = {
    ...reading(99, iso(3 * 3600_000)),
    windows: [...reading(99, iso(3 * 3600_000)).windows, { kind: "other", label: "Extra usage", usedPercent: 10 }],
  };
  await fx.db
    .update(schema.machineAccounts)
    .set({ usage: extraOpen as never })
    .where(eq(schema.machineAccounts.id, WALTER_ALL));
  await usage(OWN1, 40);
  const { brain, seen } = fillsTheWeek(fx);
  await scheduledSlot(fx);
  await drainOutbox(fx.db, handlersWith(fx, brain));
  expect(seen.map((t) => t.account?.id)).toEqual([OWN1]);
  const [run] = await runs(fx);
  const waiting = (
    run?.transcript as { waitingForBrain?: { code: string; until?: string; waitKey?: string } } | undefined
  )?.waitingForBrain;
  expect(waiting?.code).toBe("usage_pause");
  // Never taken back to the lent plan for its extra usage: it pauses where it ran, until that plan's earlier reset.
  expect(waiting?.waitKey).toContain(OWN1);
  expect(moveOf(run)).toBeUndefined();
  expect(Date.parse(waiting?.until ?? "")).toBeLessThan(Date.now() + 4 * 3600_000);
});

test("long work whose turn the plan cut on the account it moved to stays there at the pause line: only that session may finish it", async () => {
  const { fx, account, usage } = await world();
  await account(OWN2, fx.owner.id);
  await usage(OWN1, 100, iso(5 * 3600_000));
  const { brain, seen } = scripted((n) =>
    n === 0
      ? [
          { type: "usage", input: 100, output: 10, source: "plan", model: "sonnet" },
          { type: "tool_call", id: "c1", name: "Bash", input: { command: "ls" }, executed: { content: "ok" } },
          { type: "limit", resetsAt: iso(3600_000) },
          { type: "error", code: "plan_limit", message: "You've hit your limit", worked: true },
        ]
      : answers,
  );
  await scheduledSlot(fx);
  const handlers = handlersWith(fx, brain);
  await drainOutbox(fx.db, handlers);
  expect(moveOf((await runs(fx))[0])?.to).toBe(OWN2);

  // Its five hours reset, its week past the pause line: it waits there, in its session there.
  await fx.db
    .update(schema.machineAccounts)
    .set({
      usage: {
        windows: [{ kind: "seven_day", usedPercent: 99, resetsAt: iso(5 * 24 * 3600_000) }],
        source: "turn",
        at: new Date().toISOString(),
      } as never,
    })
    .where(eq(schema.machineAccounts.id, OWN2));
  clearPlanLimits();
  await drainOutbox(fx.db, handlers, { now: later(3600_000 + RESUME_AFTER_MS + 1000) });
  expect(seen.map((t) => t.account?.id)).toEqual([OWN2]);
  const [run] = await runs(fx);
  expect((run?.transcript as { waitingForBrain?: { code: string } } | undefined)?.waitingForBrain?.code).toBe(
    "usage_pause",
  );
  expect(moveOf(run)?.to).toBe(OWN2);
  expect(run?.brainSessionId).toBe(seen[0]?.session?.id ?? "");
});

test("a run refused by the account it just moved to moves again with one note, never two stacked", async () => {
  const { fx, account } = await world({}, goesOn);
  await account(OWN2, fx.owner.id);
  await account(OWN3, fx.owner.id);
  const refused: BrainEvent[] = [
    { type: "error", code: "plan_limit", message: "You've hit your limit", worked: false },
  ];
  const turns: BrainEvent[][] = [
    [
      { type: "usage", input: 100, output: 10, source: "plan", model: "sonnet" },
      { type: "tool_call", id: "c1", name: "Bash", input: { command: "git push" }, executed: { content: "ok" } },
      { type: "done", text: "Rodei git push, vou seguir." },
    ],
    refused,
    refused,
  ];
  const { brain, seen } = scripted((n) => turns[n] ?? answers);
  await ask(fx);
  await drainOutbox(fx.db, handlersWith(fx, brain));
  expect(seen.map((t) => t.account?.id)).toEqual([OWN1, OWN1, OWN2, OWN3]);
  const last = await turnPrompt(fx);
  expect(last).toContain("Already done in this run, do not repeat: Bash(git push)");
  expect(last.split("Already done in this run").length).toBe(2);
});

test("long work that would go into its owner's paid extra usage records the switch when it goes on with a free account", async () => {
  const { fx, account, usage } = await world({}, goesOn);
  await account(OWN2, fx.owner.id);
  await usage(OWN2, 40);
  const extraOpen = {
    ...reading(99),
    windows: [...reading(99).windows, { kind: "other", label: "Extra usage", usedPercent: 10 }],
  };
  await fx.db
    .update(schema.machineAccounts)
    .set({ usage: extraOpen as never })
    .where(eq(schema.machineAccounts.id, OWN1));
  const { brain, seen } = scripted((n) =>
    n === 0
      ? [
          { type: "usage", input: 100, output: 10, source: "plan", model: "sonnet" },
          { type: "tool_call", id: "c1", name: "Bash", input: { command: "make" }, executed: { content: "ok" } },
          { type: "done", text: "Rodei make, vou seguir." },
        ]
      : answers,
  );
  // Ten minutes and more of work by its first turn's end: a conversation's run is long work from there.
  const long: Brain = {
    kind: "claude_code",
    async *run(turn, io) {
      yield* brain.run(turn, io);
      if (seen.length === 1) setSystemTime(later(11 * 60_000));
    },
  };
  try {
    await ask(fx);
    await drainOutbox(fx.db, handlersWith(fx, long));
  } finally {
    setSystemTime();
  }
  expect(seen.map((t) => t.account?.id)).toEqual([OWN1, OWN2]);
  expect(switchOf((await runs(fx))[0])).toEqual({
    from: { id: OWN1, name: "Conta a001" },
    to: { id: OWN2, name: "Conta a002" },
    cause: "extra",
  });
  expect(await movedLines(fx)).toHaveLength(0);
});

test("a budget wait never moves an account", async () => {
  f = await setup({ budgetNanoUsd: 0, reply: () => ({ chunks: ["pela API"] }) });
  await ask(f);
  await drainOutbox(f.db, f.handlers);
  const [run] = await runs(f);
  expect((run?.transcript as { waitingForBrain?: { code: string } } | undefined)?.waitingForBrain?.code).toBe("budget");
  expect(moveOf(run)).toBeUndefined();
  expect(await movedLines(f)).toHaveLength(0);
});

test("work another agent handed it at its plan's limit goes on with the next account; its report still goes home", async () => {
  const { fx, account, usage } = await world({}, { askAgent: true });
  await account(OWN2, fx.owner.id);
  await usage(OWN1, 100);
  const atlas = await createAgent(
    fx.db,
    fx.owner.id,
    fx.org.id,
    { name: "Atlas", handle: "atlas", role: "Operations", credentialId: fx.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const trigger = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: fx.general.id,
    author: { type: "person", userId: fx.owner.id },
    body: "@atlas get the October report ready",
  });
  const [asker] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: atlas.id,
      channelId: fx.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      stretchId: trigger.id,
      status: "done",
    })
    .returning();
  if (!asker || !fx.tools) throw new Error("no run");
  await fx.tools.invoke(
    {
      db: fx.db,
      orgId: fx.org.id,
      agentId: atlas.id,
      runId: asker.id,
      channelId: fx.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
    },
    { toolUseId: "tu_handed", name: "tell_agent", input: { agent: "@dev", message: "Build the October report." } },
  );
  const { brain, seen } = scripted(() => answers);
  await drainOutbox(fx.db, handlersWith(fx, brain));

  expect(seen.map((t) => t.account?.id)).toEqual([OWN2]);
  const run = (await runs(fx)).find((r) => r.agentId === fx.agent.id);
  expect(run?.status).toBe("done");
  expect(moveOf(run)).toMatchObject({ from: OWN1, to: OWN2 });
  const [work] = await fx.db.select().from(schema.agentWorks);
  expect(work).toMatchObject({ how: "handed", status: "done" });
  const [home] = await fx.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, work?.resultMessageId ?? ""));
  expect(home).toMatchObject({ channelId: fx.general.id, body: "Feito.", agentRunId: run?.id });
});

test("Lodi goes on only with the person's own accounts that may answer them", async () => {
  f = await setup({ rightHand: true });
  const fx = f;
  const { machineId } = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
    name: "Mac",
    protocol: MACHINE_PROTOCOL_VERSION,
    exec: true,
  });
  const ada = await addMember(fx.db, fx.org.id, "member", "ada");
  const add = (id: string, createdBy: string, serves = "everyone") =>
    fx.db.insert(schema.machineAccounts).values({
      id,
      orgId: fx.org.id,
      machineId,
      kind: "claude_code",
      label: id.slice(-4),
      status: "active",
      createdBy,
      shared: true,
      serves,
    });
  await add(OWN1, ada.id);
  await add(OWN2, ada.id, "owner");
  await add(WALTER_ALL, fx.owner.id);
  await fx.db.insert(schema.rightHandBrains).values({
    orgId: fx.org.id,
    userId: ada.id,
    brain: "claude_code",
    brainModel: null,
    brainAccountId: OWN1,
  });
  const [lodi] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, "right_hand")));
  if (!lodi) throw new Error("no right hand");
  const plan: BrainPlan = {
    kind: "claude_code",
    session: { id: "s1", resume: true, machineId, cwd: "" },
    account: { id: OWN1, label: "a001", status: "active" },
  };
  const deps = { db: fx.db, machines: { status: async (id: string) => statusOf(id) } };
  // In Ada's own DM: her other account, even one that serves only her, never the owner's that serves everyone.
  const forAda = await thinkingAgent(fx.db, lodi, ada.id);
  const next = await nextAccountPlan(deps, forAda, plan, [OWN1], { forPerson: ada.id });
  expect(next.plan?.account?.id).toBe(OWN2);
  expect(await nextAccountPlan(deps, forAda, plan, [OWN1, OWN2], { forPerson: ada.id })).toMatchObject({
    plan: null,
  });
  // Ada's plan answering someone else: never one that serves only her.
  expect(await nextAccountPlan(deps, forAda, plan, [OWN1], { forPerson: fx.owner.id })).toMatchObject({ plan: null });
  // Nor on resume, after a move made in her DM.
  expect((await movedAccountPlan(deps, forAda, plan, OWN2, ada.id))?.account?.id).toBe(OWN2);
  expect(await movedAccountPlan(deps, forAda, plan, OWN2, fx.owner.id)).toBeNull();

  // On the workspace's plan, which isn't hers, it waits: never on to that plan owner's other accounts.
  await add(OWN3, fx.owner.id);
  const onTeamPlan = { ...lodi, ownerUserId: fx.owner.id };
  const teamPlan: BrainPlan = { ...plan, account: { id: WALTER_ALL, label: "b001", status: "active" } };
  expect(await nextAccountPlan(deps, onTeamPlan, teamPlan, [WALTER_ALL], { forPerson: ada.id })).toMatchObject({
    plan: null,
  });
  expect(await movedAccountPlan(deps, onTeamPlan, teamPlan, OWN3, ada.id)).toBeNull();
  // Its plan's owner answered: those are their own accounts.
  expect(
    (await nextAccountPlan(deps, onTeamPlan, teamPlan, [WALTER_ALL], { forPerson: fx.owner.id })).plan?.account?.id,
  ).toBe(OWN3);
});

test("Lodi on its person's plan at the limit goes on with their next account instead of its no-AI line", async () => {
  f = await setup({ rightHand: true });
  const fx = f;
  const { machineId } = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
    name: "Mac",
    protocol: MACHINE_PROTOCOL_VERSION,
    exec: true,
  });
  for (const id of [OWN1, OWN2])
    await fx.db.insert(schema.machineAccounts).values({
      id,
      orgId: fx.org.id,
      machineId,
      kind: "claude_code",
      label: id.slice(-4),
      status: "active",
      createdBy: fx.owner.id,
      shared: true,
      ...(id === OWN1 ? { usage: reading(100) as never } : {}),
    });
  const [lodi] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, "right_hand")));
  if (!lodi) throw new Error("no right hand");
  await setAgentBrain({ db: fx.db }, fx.owner.id, fx.org.id, lodi.id, { brain: "claude_code", account: OWN1 });
  const { brain, seen } = scripted(() => answers);
  const dm = await openPersonAgentDm(fx.db, fx.org.id, fx.owner.id, lodi.id);
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, dm.id, { body: "oi" });
  await drainOutbox(fx.db, handlersWith(fx, brain));
  expect(seen.map((t) => t.account?.id)).toEqual([OWN2]);
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, lodi.id));
  expect(run?.status).toBe("done");
  expect(moveOf(run)).toMatchObject({ from: OWN1, to: OWN2 });
  // The move went first: nothing stood in for its plan.
  const said = await listMessages(fx.db, fx.owner.id, fx.org.id, dm.id);
  expect(said.filter((m) => m.meta.bodyCode === STAND_IN_LINE)).toEqual([]);
});

test("Lodi at its person's limit with no other account of theirs: a plan that serves everyone stands in, with its line", async () => {
  // ADR 0137 §7 (amended 2026-11-15) over ADR 0041 §6 for the right hand: it moves only onto the person's accounts, and
  // with none it is answered by what can think for them rather than failing on its no-AI line.
  f = await setup({ rightHand: true });
  const fx = f;
  const { machineId } = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
    name: "Mac",
    protocol: MACHINE_PROTOCOL_VERSION,
    exec: true,
  });
  const ada = await addMember(fx.db, fx.org.id, "member", "ada");
  const add = (id: string, createdBy: string, more: Partial<typeof schema.machineAccounts.$inferInsert> = {}) =>
    fx.db.insert(schema.machineAccounts).values({
      id,
      orgId: fx.org.id,
      machineId,
      kind: "claude_code",
      label: id.slice(-4),
      status: "active",
      createdBy,
      shared: true,
      ...more,
    });
  await add(OWN1, ada.id, { usage: reading(100) as never });
  await add(WALTER_ALL, fx.owner.id);
  await fx.db.insert(schema.rightHandBrains).values({
    orgId: fx.org.id,
    userId: ada.id,
    brain: "claude_code",
    brainModel: null,
    brainAccountId: OWN1,
  });
  const [lodi] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, "right_hand")));
  if (!lodi) throw new Error("no right hand");
  const { brain, seen } = scripted(() => answers);
  const dm = await openPersonAgentDm(fx.db, fx.org.id, ada.id, lodi.id);
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, ada.id, fx.org.id, dm.id, { body: "oi" });
  await drainOutbox(fx.db, handlersWith(fx, brain));
  expect(seen.map((t) => t.account?.id)).toEqual([WALTER_ALL]);
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, lodi.id));
  expect(run?.status).toBe("done");
  // Not a move: the run never went on along the order, so nothing of it counts as lent to it.
  expect(moveOf(run)).toBeUndefined();
  const said = await listMessages(fx.db, ada.id, fx.org.id, dm.id);
  expect(said.filter((m) => m.meta.bodyCode === "plan_account_moved")).toEqual([]);
  expect(said.filter((m) => m.meta.bodyCode === STAND_IN_LINE).map((m) => m.body)).toEqual([
    "Answered with b001: a001 reached its limit.",
  ]);
});

test("Lodi's long work on its person's other account it moved to stops at that plan's line, though its paid extra usage is open", async () => {
  f = await setup({ rightHand: true, ...goesOn });
  const fx = f;
  const { machineId } = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
    name: "Mac",
    protocol: MACHINE_PROTOCOL_VERSION,
    exec: true,
  });
  for (const id of [OWN1, OWN2])
    await fx.db.insert(schema.machineAccounts).values({
      id,
      orgId: fx.org.id,
      machineId,
      kind: "claude_code",
      label: id.slice(-4),
      status: "active",
      createdBy: fx.owner.id,
      shared: true,
      usage: reading(id === OWN1 ? 99 : 40, iso(3 * 3600_000)) as never,
    });
  const [lodi] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, "right_hand")));
  if (!lodi) throw new Error("no right hand");
  await setAgentBrain({ db: fx.db }, fx.owner.id, fx.org.id, lodi.id, { brain: "claude_code", account: OWN1 });
  await fx.db.insert(schema.channelMembers).values({ orgId: fx.org.id, channelId: fx.general.id, agentId: lodi.id });
  const { brain, seen } = fillsTheWeek(fx, 1, true);
  const deps = { db: fx.db, pubsub: fx.pubsub, context: fx.context };
  const routine = await createRoutine(deps, fx.owner.id, fx.org.id, {
    name: "Deploys",
    agentId: lodi.id,
    prompt: "Check the deploys.",
    target: { type: "channel", channelId: fx.general.id },
    trigger: { type: "schedule", phrase: "todo dia às 8h" },
  });
  await runRoutineNow(deps, fx.owner.id, fx.org.id, routine.id);
  await fx.db
    .update(schema.routineRuns)
    .set({ trigger: "schedule" })
    .where(eq(schema.routineRuns.routineId, routine.id));
  await drainOutbox(fx.db, handlersWith(fx, brain));
  // Its person's own account, yet the right hand's long work never spends paid extra usage: one turn, then a wait.
  expect(seen.map((t) => t.account?.id)).toEqual([OWN2]);
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, lodi.id));
  expect((run?.transcript as { waitingForBrain?: { code: string } } | undefined)?.waitingForBrain?.code).toBe(
    "usage_pause",
  );
});

test("the next account never answered a turn and its CLI fails there: the run ends at once on the CLI's words", async () => {
  const { fx, account, usage } = await world();
  await fx.db
    .update(schema.machineAccounts)
    .set({ lastSuccessAt: new Date() })
    .where(eq(schema.machineAccounts.id, OWN1));
  await usage(OWN1, 100);
  await account(OWN2, fx.owner.id);
  const { brain, seen } = scripted(() => [
    {
      type: "error",
      code: "claude_failed",
      message: "Claude Code exited with code 1: error: unexpected response from the model endpoint",
      retryable: true,
    },
  ]);
  await ask(fx);
  await drainOutbox(fx.db, handlersWith(fx, brain)).catch(() => {});
  expect(seen.map((t) => t.account?.id)).toEqual([OWN2]);
  const [run] = await runs(fx);
  expect(run?.status).toBe("failed");
  expect(run?.error ?? "").toStartWith("cli_failed:");
  expect(moveOf(run)).toMatchObject({ from: OWN1, to: OWN2 });
  // Nothing answered for its plan, and it never waits for its own account's reset.
  expect(fx.provider.calls).toHaveLength(0);
  expect((run?.transcript as { waitingForBrain?: unknown } | undefined)?.waitingForBrain).toBeUndefined();
});
