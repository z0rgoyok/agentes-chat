import { afterEach, expect, test } from "bun:test";
import { ACCOUNTS_PROTOCOL, MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { and, eq, inArray, ne, schema } from "@agenteschat/db";
import {
  askWidgetChange,
  createDashboard,
  createWidget,
  decideProposal,
  executeRoutineRun,
  getAgentBrain,
  insertMessage,
  listMachineAccounts,
  MACHINE_CONTROL_TOPIC,
  type MachineStatus,
  machineAgents,
  makeDefaultCredential,
  openPersonAgentDm,
  PLAN_LENT_JOB,
  postPersonMessage,
  RIGHT_HAND,
  refreshWidgetNow,
  releaseMemberAccounts,
  resolveBrain,
  runAuthority,
  setAccountServes,
  setAgentBrain,
  sha256,
  TASK_OFFLINE_GRACE_MS,
  takeBackPlan,
  updateWidget,
} from "../src";
import { agentAiState, backgroundAiState, orgAiStatus, orgHasAi } from "../src/ai-status";
import { rightHandWidgetsReady, widgetAi } from "../src/dashboards/refresh-fire";
import { withPersonalBrain } from "../src/right-hand";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { routineDeps } from "./routine-fixtures";

/*
 * ADR 0137 §11: each person's DM with the team's right hand thinks with that person's own AI (their plan, or one given
 * to them with `use_others_plans`), else with the workspace's; nobody's plan serves someone else unless they allow it.
 */

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const ANAS = "0193eeee-0000-4000-8000-0000000000a1";
const BIAS = "0193eeee-0000-4000-8000-0000000000b1";
const CAIOS = "0193eeee-0000-4000-8000-0000000000c1";

const statusOf = (id: string): MachineStatus => ({
  id,
  orgId: "org",
  name: "Mac",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: MACHINE_PROTOCOL_VERSION,
  executors: { claude: { version: "2.1.318", loggedIn: true }, detectedAt: new Date().toISOString() },
});
const machines = { status: async (id: string) => statusOf(id) };

async function world() {
  const fx = await setup({ rightHand: true });
  f = fx;
  const { machineId } = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
    name: "Mac",
    protocol: ACCOUNTS_PROTOCOL,
    exec: true,
  });
  await fx.db
    .update(schema.machines)
    .set({
      pairedByUserId: null,
      executors: { claude: { version: "2.1.318", loggedIn: true }, detectedAt: new Date().toISOString() },
    })
    .where(eq(schema.machines.id, machineId));
  const bia = await addMember(fx.db, fx.org.id, "member", "bia");
  const caio = await addMember(fx.db, fx.org.id, "admin", "caio");
  const account = (id: string, createdBy: string) =>
    fx.db.insert(schema.machineAccounts).values({
      id,
      orgId: fx.org.id,
      machineId,
      kind: "claude_code",
      label: id,
      status: "active",
      createdBy,
      shared: true,
    });
  await account(ANAS, fx.owner.id);
  await account(BIAS, bia.id);
  await account(CAIOS, caio.id);
  const [lodi] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  // One run per person: a second message in a DM with a run open joins it.
  const opened = new Map<string, { run: typeof schema.agentRuns.$inferSelect; dm: { id: string } }>();
  const runIn = async (userId: string) => {
    let open = opened.get(userId);
    if (!open) {
      const dm = await openPersonAgentDm(fx.db, fx.org.id, userId, lodi.id);
      const m = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, userId, fx.org.id, dm.id, { body: "oi" });
      const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, m.id));
      if (!run) throw new Error("no run");
      open = { run, dm };
      opened.set(userId, open);
    }
    const [agent] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, lodi.id));
    if (!agent) throw new Error("no right hand");
    return resolveBrain({ db: fx.db, machines }, agent, open.run, open.dm.id);
  };
  return { fx, deps: { db: fx.db }, machineId, bia, caio, lodi, runIn };
}

const codeOf = (p: Promise<unknown>) => p.then(() => null).catch((e: { code?: string }) => e.code);

test("a member gives their own DM with Lodi their plan; everyone else keeps the workspace's", async () => {
  const { fx, deps, machineId, bia, caio, lodi, runIn } = await world();
  const before = await getAgentBrain(deps, bia.id, fx.org.id, lodi.id, "mine");
  expect(before).toMatchObject({
    scope: "mine",
    brain: "model",
    canUsePlans: true,
    workspaceAi: { brain: "model", ownerId: null, servesYou: true },
  });
  // Every plan that serves the workspace (ADR 0059 §3), hers among them.
  expect(before.accounts.map((a) => a.id).sort()).toEqual([ANAS, BIAS, CAIOS].sort());
  const view = await setAgentBrain(deps, bia.id, fx.org.id, lodi.id, {
    scope: "mine",
    brain: "claude_code",
    account: BIAS,
  });
  expect(view).toMatchObject({ scope: "mine", brain: "claude_code", account: BIAS, computer: { machineId } });
  // The workspace's AI didn't move, and members still can't see it.
  const [row] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, lodi.id));
  expect(row).toMatchObject({ brain: "model", brainAccountId: null });
  expect(await codeOf(getAgentBrain(deps, bia.id, fx.org.id, lodi.id, "workspace"))).toBe("agent.not_owner");
  expect(await runIn(bia.id)).toMatchObject({ kind: "claude_code", account: { id: BIAS }, session: { machineId } });
  expect((await runIn(fx.owner.id)).kind).toBe("model");
  // Her computer's frame lends Lodi's user her sign-in.
  const frame = (await machineAgents(fx.db, fx.org.id, machineId)).find((a) => a.id === lodi.id);
  expect(frame?.account).toBe(BIAS);
  // Two people's plans on one computer: its user keeps both.
  await setAgentBrain(deps, caio.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: CAIOS });
  const both = (await machineAgents(fx.db, fx.org.id, machineId)).find((a) => a.id === lodi.id);
  expect([both?.account, ...(both?.accounts ?? [])].sort()).toEqual([BIAS, CAIOS].sort());
  // Back to the workspace's.
  await setAgentBrain(deps, bia.id, fx.org.id, lodi.id, { scope: "mine", brain: "model" });
  expect((await runIn(bia.id)).kind).toBe("model");
  expect((await fx.db.select().from(schema.rightHandBrains)).map((r) => r.userId)).toEqual([caio.id]);
});

test("with no key in the workspace, a person with no AI of their own thinks with a plan that serves them, the roomiest", async () => {
  const { fx, bia, runIn } = await world();
  // The workspace's AI is the model, with no key: before, everyone's DM read "no AI" despite plans being here.
  await fx.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const window = (usedPercent: number) => ({
    windows: [{ kind: "five_hour" as const, usedPercent, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }],
    source: "probe" as const,
    at: new Date().toISOString(),
  });
  await fx.db
    .update(schema.machineAccounts)
    .set({ usage: window(90) })
    .where(eq(schema.machineAccounts.id, ANAS));
  await fx.db
    .update(schema.machineAccounts)
    .set({ usage: window(10) })
    .where(eq(schema.machineAccounts.id, CAIOS));
  await fx.db
    .update(schema.machineAccounts)
    .set({ usage: window(50) })
    .where(eq(schema.machineAccounts.id, BIAS));
  const dani = await addMember(fx.db, fx.org.id, "member", "dani");
  const plan = await runIn(dani.id);
  expect(plan).toMatchObject({ kind: "claude_code", account: { id: CAIOS } });
  expect(plan.unavailable).toBeUndefined();
  // Someone with a plan of their own thinks with it first.
  expect(await runIn(bia.id)).toMatchObject({ account: { id: BIAS } });
  // A login made for one agent that an agent thinks with stays that agent's: the next roomiest answers.
  await fx.db.update(schema.machineAccounts).set({ shared: false }).where(eq(schema.machineAccounts.id, CAIOS));
  await fx.db.update(schema.agents).set({ brainAccountId: CAIOS }).where(eq(schema.agents.id, fx.agent.id));
  const eva = await addMember(fx.db, fx.org.id, "member", "eva");
  expect(await runIn(eva.id)).toMatchObject({ account: { id: BIAS } });
});

test("someone else's plan: any that serves everyone, never one its owner keeps to themselves", async () => {
  const { fx, deps, bia, caio, lodi, runIn } = await world();
  // Ana's plan serves the whole workspace: Bia gives it to her own DM, and nobody needs telling.
  await setAgentBrain(deps, bia.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: ANAS });
  const plan = await runIn(bia.id);
  expect(plan).toMatchObject({ kind: "claude_code", account: { id: ANAS } });
  expect(plan.unavailable).toBeUndefined();
  expect(await fx.db.select().from(schema.outbox).where(eq(schema.outbox.kind, PLAN_LENT_JOB))).toEqual([]);
  // Only the person who connected it chooses who it serves.
  expect(await codeOf(setAccountServes(deps, caio.id, fx.org.id, ANAS, "owner"))).toBe("account.not_owner");
  await fx.db.insert(schema.notifications).values({
    orgId: fx.org.id,
    userId: fx.owner.id,
    kind: "plan_serves",
    groupKey: `plan_serves:${ANAS}`,
    source: { accountId: ANAS },
    latest: { plan: "Claude" },
  });
  // "Só eu": Bia's DM goes back to the workspace's, nobody else may pick it, and Ana's note is done.
  expect(await setAccountServes(deps, fx.owner.id, fx.org.id, ANAS, "owner")).toMatchObject({ serves: "owner" });
  expect(await fx.db.select().from(schema.rightHandBrains)).toEqual([]);
  expect(
    await codeOf(
      setAgentBrain(deps, caio.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: ANAS }),
    ),
  ).toBe("account.not_owner");
  const [note] = await fx.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "plan_serves"));
  expect(note?.doneAt).not.toBeNull();
  expect((await fx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "account.serves"))).length).toBe(
    1,
  );
});

test("the workspace's plan kept to its owner serves only them; the AI status says so per person", async () => {
  const { fx, deps, bia, caio, lodi, runIn } = await world();
  await setAgentBrain(deps, fx.owner.id, fx.org.id, lodi.id, { brain: "claude_code", account: ANAS });
  // Every plan kept to the person who connected it: nothing serves anyone else.
  await setAccountServes(deps, fx.owner.id, fx.org.id, ANAS, "owner");
  await setAccountServes(deps, bia.id, fx.org.id, BIAS, "owner");
  await setAccountServes(deps, caio.id, fx.org.id, CAIOS, "owner");
  expect(await getAgentBrain(deps, bia.id, fx.org.id, lodi.id, "mine")).toMatchObject({
    workspaceAi: { brain: "claude_code", ownerId: fx.owner.id, servesYou: false },
  });
  // Her own plan answers her though she chose none: the workspace's serves only Ana.
  expect(await runIn(bia.id)).toMatchObject({ account: { id: BIAS } });
  const dani = await addMember(fx.db, fx.org.id, "member", "dani");
  const status = { db: fx.db, gateway: fx.gateway, machines };
  const of = async (viewer: string) =>
    (await orgAiStatus(status, fx.org.id, viewer)).agents.find((a) => a.agentId === lodi.id);
  // Background work nobody set up thinks with the workspace's plan, and no person is behind it: that plan takes none
  // of it, whoever looks.
  // Dani has no plan and none serves her: the line names whose the plans are (`plans_not_yours`).
  expect(await of(dani.id)).toMatchObject({
    agentId: lodi.id,
    state: "no_ai",
    reason: "plans_not_yours",
    plan: "Claude",
  });
  expect(await of(fx.owner.id)).toEqual({ agentId: lodi.id, state: "ready", background: "no_ai" });
  // Her own plan answers her whatever the workspace's does; work nobody set up still has none.
  await setAgentBrain(deps, bia.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: BIAS });
  expect(await of(bia.id)).toEqual({ agentId: lodi.id, state: "ready", background: "no_ai" });
  expect((await runIn(bia.id)).unavailable).toBeUndefined();
  // Opened to everyone, the workspace's serves whoever has none, and background work too.
  await setAccountServes(deps, fx.owner.id, fx.org.id, ANAS, "everyone");
  const [agent] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, lodi.id));
  if (!agent) throw new Error("no right hand");
  expect(await agentAiState(status, agent, undefined, dani.id)).toMatchObject({ state: "ready" });
  expect(await of(fx.owner.id)).toEqual({ agentId: lodi.id, state: "ready" });
  expect(await backgroundAiState(status, agent)).toEqual({ state: "ready" });
  // Its computer away, a chat shows it waiting, but its run never waits for it: a build has no AI meanwhile, unless
  // that computer is only asleep (its run wakes it) or just gone (its run waits out the blip).
  const away = (more: Partial<MachineStatus> = {}) => ({
    ...status,
    machines: { status: async (id: string) => ({ ...statusOf(id), online: false, ...more }) },
  });
  expect((await orgAiStatus(away(), fx.org.id, fx.owner.id)).agents.find((a) => a.agentId === lodi.id)).toEqual({
    agentId: lodi.id,
    state: "waiting",
    background: "no_ai",
  });
  expect(await backgroundAiState(away(), agent)).toEqual({ state: "no_ai", reason: "computer_away" });
  expect(await backgroundAiState(away({ standby: true }), agent)).toEqual({ state: "waiting" });
  const seen = (ago: number) => away({ lastSeenAt: new Date(Date.now() - ago).toISOString() });
  expect(await backgroundAiState(seen(5_000), agent)).toEqual({ state: "waiting" });
  expect(await backgroundAiState(seen(TASK_OFFLINE_GRACE_MS + 5_000), agent)).toEqual({
    state: "no_ai",
    reason: "computer_away",
  });
});

test("a decision on its card wakes it for the person behind the card's run, on that person's own plan", async () => {
  const { fx, deps, bia, lodi: helper } = await world();
  // The workspace's AI is the owner's plan, for the owner alone; the member has a plan of her own.
  await setAgentBrain(deps, fx.owner.id, fx.org.id, helper.id, { brain: "claude_code", account: ANAS });
  await setAgentBrain(deps, bia.id, fx.org.id, helper.id, { scope: "mine", brain: "claude_code", account: BIAS });
  const dm = await openPersonAgentDm(fx.db, fx.org.id, bia.id, helper.id);
  const asked = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, bia.id, fx.org.id, dm.id, {
    body: "anota no contexto que respondemos em inglês",
  });
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, asked.id));
  if (!run) throw new Error("no run");
  // Its run proposed a change to the workspace's context there, showed the card and ended.
  const [org] = await fx.db.select().from(schema.organizations).where(eq(schema.organizations.id, fx.org.id));
  const context = org?.context ?? "";
  const [proposal] = await fx.db
    .insert(schema.contextProposals)
    .values({
      orgId: fx.org.id,
      target: "org_context",
      proposedByAgentId: helper.id,
      requestedByUserId: bia.id,
      baseHash: sha256(context),
      proposedText: `${context}\n- Respondemos em inglês.`,
      diff: "+- Respondemos em inglês.",
      rationale: "Pedido no DM.",
    })
    .returning();
  if (!proposal) throw new Error("no proposal");
  await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: dm.id,
    author: { type: "agent", agentId: helper.id, runId: run.id, hop: run.hop },
    body: "Propus.",
    meta: { memoryUpdates: [{ action: "proposed", proposalId: proposal.id, proposalIds: [proposal.id], text: "x" }] },
  });
  await fx.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, run.id));
  await decideProposal(fx.db, fx.owner.id, fx.org.id, proposal.id, "accept", { pubsub: fx.pubsub });
  const [next] = await fx.db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.agentId, helper.id), ne(schema.agentRuns.id, run.id)));
  if (!next) throw new Error("it wasn't told");
  expect(await runAuthority(fx.db, next)).toEqual({ kind: "person", personId: bia.id });
  const [agent] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, helper.id));
  if (!agent) throw new Error("no right hand");
  const plan = await resolveBrain({ db: fx.db, machines }, agent, next, dm.id);
  expect(plan).toMatchObject({ kind: "claude_code", account: { id: BIAS } });
  expect(plan.unavailable).toBeUndefined();
});

test("a person's plan on Lodi is an AI of the workspace, though Lodi's own row has none", async () => {
  const { fx, deps, bia, lodi } = await world();
  const status = { db: fx.db, gateway: { hasModelCredential: async () => false }, machines };
  expect(await orgHasAi(status, fx.org.id)).toBe(false);
  await setAgentBrain(deps, bia.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: BIAS });
  expect(await orgHasAi(status, fx.org.id)).toBe(true);
});

test("a plan taken back from a person's Lodi tells the computers, so its user lets the sign-in go", async () => {
  const { fx, deps, caio, lodi } = await world();
  await setAgentBrain(deps, caio.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: ANAS });
  const heard: unknown[] = [];
  fx.pubsub.subscribe(MACHINE_CONTROL_TOPIC, (e) => heard.push(e));
  await takeBackPlan({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, ANAS);
  expect(heard).toContainEqual({ type: "machine.agents", orgId: fx.org.id });
});

test("the plans page names Lodi, and a plan that goes takes people's Lodi back to the workspace's at once", async () => {
  const { fx, deps, machineId, bia, lodi, runIn } = await world();
  await setAgentBrain(deps, bia.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: BIAS });
  const views = await listMachineAccounts(deps, fx.org.id, machineId, bia.id);
  expect(views.find((a) => a.id === BIAS)?.usedBy).toEqual([lodi.name]);
  // Its row stays until the computer's runner has removed the sign-in, which may be away.
  await releaseMemberAccounts(fx.db, bia.id, fx.org.id);
  expect((await runIn(bia.id)).kind).toBe("model");
});

test("a login made for one agent moves to a person's Lodi only when they say so, and to one agent only", async () => {
  const { fx, deps, machineId, bia, lodi } = await world();
  await fx.db.update(schema.machineAccounts).set({ shared: false }).where(eq(schema.machineAccounts.id, BIAS));
  await fx.db
    .update(schema.agents)
    .set({ brain: "claude_code", brainAccountId: BIAS, machineId, ownerUserId: bia.id })
    .where(eq(schema.agents.id, fx.agent.id));
  const input = { scope: "mine", brain: "claude_code", account: BIAS };
  expect(await codeOf(setAgentBrain(deps, bia.id, fx.org.id, lodi.id, input))).toBe("account.in_use");
  await setAgentBrain(deps, bia.id, fx.org.id, lodi.id, { ...input, moveAccount: true });
  const [agent] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, fx.agent.id));
  expect(agent?.brainAccountId).toBeNull();
  // Back to an agent: it leaves her Lodi, which goes back to the workspace's.
  await setAgentBrain(deps, bia.id, fx.org.id, fx.agent.id, { brain: "claude_code", account: BIAS });
  expect((await getAgentBrain(deps, bia.id, fx.org.id, lodi.id, "mine")).account).toBeNull();
});

test("chosen, reloaded, read: a workspace key shows as the workspace's AI, and each person's own stays theirs", async () => {
  const { fx, deps, lodi } = await world();
  // What the dialogs do for a key (`rightHandOnKey`): no own plan, the workspace on its model, the key pinned.
  await setAgentBrain(deps, fx.owner.id, fx.org.id, lodi.id, { brain: "model", scope: "mine" });
  await setAgentBrain(deps, fx.owner.id, fx.org.id, lodi.id, { brain: "model", scope: "workspace" });
  await fx.db.update(schema.agents).set({ credentialId: fx.credential.id }).where(eq(schema.agents.id, lodi.id));
  const mine = await getAgentBrain(deps, fx.owner.id, fx.org.id, lodi.id, "mine");
  const workspace = await getAgentBrain(deps, fx.owner.id, fx.org.id, lodi.id, "workspace");
  const key = { provider: "anthropic", label: fx.credential.label };
  expect(mine).toMatchObject({ brain: "model", scope: "mine", workspaceAi: { brain: "model", key } });
  expect(workspace).toMatchObject({ brain: "model", scope: "workspace", workspaceAi: { brain: "model", key } });
});

test("with no key pinned, the page names the key its calls take: the default, not the newest", async () => {
  const { fx, deps, lodi } = await world();
  await fx.db.update(schema.agents).set({ credentialId: null }).where(eq(schema.agents.id, lodi.id));
  await fx.db.insert(schema.providerCredentials).values({
    ...(await keyRow(fx)),
    label: "Newer",
    createdAt: new Date(Date.now() + 60_000),
  });
  await makeDefaultCredential(fx.db, fx.owner.id, fx.org.id, fx.credential.id);
  const mine = await getAgentBrain(deps, fx.owner.id, fx.org.id, lodi.id, "mine");
  expect(mine.workspaceAi?.key?.label).toBe(fx.credential.label);
});

test("with no key anywhere, the workspace's AI says so instead of naming one", async () => {
  const { fx, deps, lodi } = await world();
  await fx.db.delete(schema.providerCredentials).where(eq(schema.providerCredentials.orgId, fx.org.id));
  const mine = await getAgentBrain(deps, fx.owner.id, fx.org.id, lodi.id, "mine");
  expect(mine.workspaceAi?.key).toBeNull();
});

/** Another key of the same provider, copied from the fixture's. */
async function keyRow(fx: Awaited<ReturnType<typeof world>>["fx"]) {
  const [row] = await fx.db
    .select()
    .from(schema.providerCredentials)
    .where(eq(schema.providerCredentials.id, fx.credential.id));
  if (!row) throw new Error("fixture key");
  return { ...row, id: crypto.randomUUID() };
}

test("a widget's build thinks with its creator's AI, else its routine's creator's, else the workspace's", async () => {
  const { fx, deps, bia, caio, lodi } = await world();
  // The workspace's plan serves only its owner; Bia and Caio each chose their own.
  await setAgentBrain(deps, fx.owner.id, fx.org.id, lodi.id, { brain: "claude_code", account: ANAS });
  await setAgentBrain(deps, bia.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: BIAS });
  await setAgentBrain(deps, caio.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: CAIOS });
  const dash = { db: fx.db, pubsub: fx.pubsub, context: fx.context };
  const board = await createDashboard(dash, bia.id, fx.org.id, {
    title: "Loja",
    audience: "workspace",
    editPolicy: "owner",
  });
  const made = await createWidget(dash, bia.id, fx.org.id, board.id, {
    agentId: lodi.id,
    prompt: "Pedidos de hoje",
    format: "auto",
    schedule: "hour",
  });
  const widget = async (set: Partial<typeof schema.dashboardWidgets.$inferInsert> = {}) => {
    const [row] = await fx.db
      .update(schema.dashboardWidgets)
      .set({ updatedAt: new Date(), ...set })
      .where(eq(schema.dashboardWidgets.id, made.id))
      .returning();
    if (!row) throw new Error("no widget");
    return row;
  };
  const ai = { ...dash, ai: { gateway: fx.gateway, machines } };
  const [on] = await fx.db.select().from(schema.dashboards).where(eq(schema.dashboards.id, board.id));
  if (!on) throw new Error("no board");
  /** Whose AI a build of the widget would think with now, or why none. */
  const pick = async (row: Parameters<typeof widgetAi>[1]) => {
    const got = await widgetAi(ai, row, on);
    return got?.noAi?.reason ?? got?.person ?? "workspace";
  };

  // Its build's run: nobody is behind it, and it thinks with Bia's plan, who made the widget.
  const [queued] = await fx.db.select().from(schema.routineRuns);
  await executeRoutineRun(routineDeps(fx), queued?.id ?? "");
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.background, true));
  if (!run) throw new Error("no build run");
  const authority = await runAuthority(fx.db, run);
  expect(authority).toMatchObject({ personId: null, brief: { aiUserId: bia.id } });
  const [agent] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, lodi.id));
  if (!agent) throw new Error("no right hand");
  const build = () => resolveBrain({ db: fx.db, machines }, agent, run, run.channelId);
  expect(await build()).toMatchObject({ kind: "claude_code", account: { id: BIAS } });
  expect((await build()).unavailable).toBeUndefined();
  expect(await pick(await widget())).toBe(bia.id);
  // The widget's creator comes before its routine's. A run keeps who its firing picked.
  expect(await pick(await widget({ createdByUserId: caio.id }))).toBe(caio.id);
  expect(await build()).toMatchObject({ account: { id: BIAS } });
  // A brief that picked nobody (one written before firings did) reads the rows: the widget's creator, then the routine's.
  const [brief] = await fx.db.select().from(schema.messages).where(eq(schema.messages.id, run.triggerMessageId));
  if (!brief) throw new Error("no brief");
  const { aiUserId: _picked, ...unpicked } = brief.meta.routineBrief as Record<string, unknown>;
  await fx.db
    .update(schema.messages)
    .set({ meta: { ...brief.meta, routineBrief: unpicked } })
    .where(eq(schema.messages.id, run.triggerMessageId));
  expect(await build()).toMatchObject({ account: { id: CAIOS } });
  // A widget that names nobody: its routine's creator (Bia).
  expect(await pick(await widget({ createdByUserId: null }))).toBe(bia.id);
  expect(await build()).toMatchObject({ account: { id: BIAS } });

  // Neither has an AI of their own (none chosen, their plans signed out): the workspace's, kept to its plan's owner,
  // which answers nobody else.
  await setAccountServes(deps, fx.owner.id, fx.org.id, ANAS, "owner");
  await fx.db.delete(schema.rightHandBrains).where(ne(schema.rightHandBrains.userId, fx.owner.id));
  await fx.db
    .update(schema.machineAccounts)
    .set({ status: "signed_out" })
    .where(inArray(schema.machineAccounts.id, [BIAS, CAIOS]));
  // Bia, the first of its people, hears whose the plan is.
  expect(await pick(await widget())).toBe("plans_not_yours");
  expect((await build()).unavailable).toMatchObject({ code: "plan_not_shared" });
  expect(await pick(await widget({ createdByUserId: fx.owner.id }))).toBe(fx.owner.id);
  expect((await build()).unavailable).toBeUndefined();
  // Nobody at all: the workspace's AI as any work nobody asked for gets it. The apps hear which widgets can build.
  const nobody = { ...(await widget({ createdByUserId: null })), routineId: null };
  expect(await pick(nobody)).toBe("plan_not_shared");
  await widget({ createdByUserId: caio.id, status: "failed", failureCode: "missing_credential" });
  await fx.db.update(schema.routines).set({ createdByUserId: caio.id });
  expect(await rightHandWidgetsReady(ai, fx.org.id, fx.owner.id)).toEqual([]);
  await widget({ createdByUserId: fx.owner.id });
  expect(await rightHandWidgetsReady(ai, fx.org.id, fx.owner.id)).toEqual([made.id]);
  // Only on a board the viewer sees.
  await fx.db.update(schema.dashboards).set({ audience: "private" }).where(eq(schema.dashboards.id, board.id));
  expect(await rightHandWidgetsReady(ai, fx.org.id, fx.owner.id)).toEqual([]);
  await fx.db.update(schema.dashboards).set({ audience: "workspace" }).where(eq(schema.dashboards.id, board.id));
  await fx.db.update(schema.routines).set({ createdByUserId: bia.id });
  await widget({ createdByUserId: null, status: "ok", failureCode: null });
  await setAccountServes(deps, fx.owner.id, fx.org.id, ANAS, "everyone");
  expect(await pick(nobody)).toBe("workspace");
  expect(await pick(await widget())).toBe(bia.id);
  expect(await build()).toMatchObject({ kind: "claude_code", account: { id: ANAS } });
});

/** A shared board anyone edits, with a widget of Lodi's that `maker` made, and what its firings pick. */
async function sharedWidget(w: Awaited<ReturnType<typeof world>>, maker: string) {
  const { fx, lodi } = w;
  const dash = { db: fx.db, pubsub: fx.pubsub, context: fx.context, ai: { gateway: fx.gateway, machines } };
  const board = await createDashboard(dash, maker, fx.org.id, {
    title: "Loja",
    audience: "workspace",
    editPolicy: "viewers",
  });
  const made = await createWidget(dash, maker, fx.org.id, board.id, {
    agentId: lodi.id,
    prompt: "Pedidos de hoje",
    format: "auto",
    schedule: "hour",
  });
  /** Fires what is queued, and reads whose AI the newest build thinks with: its brief's pick, and its account. */
  const build = async () => {
    const queued = await fx.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.status, "queued"));
    for (const q of queued) await executeRoutineRun({ ...routineDeps(fx), ai: dash.ai }, q.id);
    const runs = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.background, true));
    const run = runs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!run) throw new Error("no build run");
    const [agent] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, lodi.id));
    if (!agent) throw new Error("no right hand");
    const plan = await resolveBrain({ db: fx.db, machines }, agent, run, run.channelId);
    const authority = await runAuthority(fx.db, run);
    return {
      run,
      agent,
      pick: authority.kind === "routine" ? authority.brief?.aiUserId : undefined,
      account: "account" in plan ? plan.account?.id : undefined,
      unavailable: plan.unavailable?.code,
    };
  };
  /** Ends the build under way, so another may start. */
  const end = async () => {
    await fx.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.background, true));
    await fx.db.update(schema.routineRuns).set({ status: "reported", finishedAt: new Date() });
    await fx.db.update(schema.dashboardWidgets).set({ status: "ok" }).where(eq(schema.dashboardWidgets.id, made.id));
  };
  const row = async () => {
    const [r] = await fx.db.select().from(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.id, made.id));
    if (!r) throw new Error("no widget");
    return r;
  };
  return { dash, board, made, build, end, row };
}

test("a creator whose own AI can't think: the build takes the next AI that can, never none while one exists", async () => {
  const w = await world();
  const { fx, deps, bia, caio, lodi } = w;
  // The workspace's plan answers everyone; Bia chose her own, which is signed out.
  await setAgentBrain(deps, fx.owner.id, fx.org.id, lodi.id, { brain: "claude_code", account: ANAS });
  await setAgentBrain(deps, bia.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: BIAS });
  await fx.db.update(schema.machineAccounts).set({ status: "signed_out" }).where(eq(schema.machineAccounts.id, BIAS));
  const { build, end, made } = await sharedWidget(w, bia.id);
  expect(await build()).toMatchObject({ pick: null, account: ANAS, unavailable: undefined });
  await end();
  // The workspace's plan serves only its owner, and nobody else has an AI that thinks: a widget of Caio's whose routine
  // is the owner's builds for the owner, whom that plan answers.
  await fx.db.delete(schema.rightHandBrains).where(ne(schema.rightHandBrains.userId, fx.owner.id));
  await fx.db.update(schema.machineAccounts).set({ status: "signed_out" }).where(eq(schema.machineAccounts.id, CAIOS));
  await setAccountServes(deps, fx.owner.id, fx.org.id, ANAS, "owner");
  await fx.db.update(schema.dashboardWidgets).set({ createdByUserId: caio.id });
  await fx.db.update(schema.routines).set({ createdByUserId: fx.owner.id });
  await refreshWidgetNow(await sharedDeps(w), fx.owner.id, fx.org.id, made.id);
  expect(await build()).toMatchObject({ pick: fx.owner.id, account: ANAS, unavailable: undefined });
});

const sharedDeps = async (w: Awaited<ReturnType<typeof world>>) => ({
  db: w.fx.db,
  pubsub: w.fx.pubsub,
  context: w.fx.context,
  ai: { gateway: w.fx.gateway, machines },
});

test("a creator who left: whoever presses Atualizar agora takes the routine over, and the build thinks with their AI", async () => {
  const w = await world();
  const { fx, deps, bia, caio, lodi } = w;
  await setAgentBrain(deps, bia.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: BIAS });
  await setAgentBrain(deps, caio.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: CAIOS });
  const { dash, build, end, made } = await sharedWidget(w, bia.id);
  expect(await build()).toMatchObject({ pick: bia.id, account: BIAS });
  await end();
  await fx.db.delete(schema.organizationMembers).where(eq(schema.organizationMembers.userId, bia.id));
  // The workspace has no AI of its own: only Caio's can build it, once the routine is his.
  await refreshWidgetNow(dash, caio.id, fx.org.id, made.id);
  expect(await build()).toMatchObject({ pick: caio.id, account: CAIOS, unavailable: undefined });
});

test("another editor's words never spend the creator's plan: a change asks, and new instructions build, on their own AI", async () => {
  const w = await world();
  const { fx, deps, bia, caio, lodi } = w;
  await setAgentBrain(deps, bia.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: BIAS });
  await setAgentBrain(deps, caio.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: CAIOS });
  const { dash, board, build, end, made, row } = await sharedWidget(w, bia.id);
  expect(await build()).toMatchObject({ pick: bia.id, account: BIAS });
  await end();
  // Caio asks for a change: that run is his words, on his AI. The widget stays Bia's.
  await askWidgetChange(dash, caio.id, fx.org.id, made.id, "Mostre só os pagos");
  expect(await build()).toMatchObject({ pick: caio.id, account: CAIOS });
  expect((await row()).createdByUserId).toBe(bia.id);
  await end();
  // Her own Atualizar agora, and anyone's of her instructions, stays on hers.
  await refreshWidgetNow(dash, caio.id, fx.org.id, made.id);
  expect(await build()).toMatchObject({ pick: bia.id, account: BIAS });
  await end();
  // He rewrites its instructions: the widget is his from then on.
  await updateWidget(dash, caio.id, fx.org.id, made.id, { prompt: "Pedidos pagos de hoje" });
  expect((await row()).createdByUserId).toBe(caio.id);
  await refreshWidgetNow(dash, bia.id, fx.org.id, made.id);
  expect(await build()).toMatchObject({ pick: caio.id, account: CAIOS });
  await end();
  // A person who no longer sees its board pays for none of it: the board turns private to Bia, the routine's creator.
  await fx.db
    .update(schema.dashboards)
    .set({ audience: "private", ownerUserId: bia.id })
    .where(eq(schema.dashboards.id, board.id));
  const [on] = await fx.db.select().from(schema.dashboards).where(eq(schema.dashboards.id, board.id));
  if (!on) throw new Error("no board");
  expect((await widgetAi(dash, await row(), on))?.person).toBe(bia.id);
});

test("a run a routine's report woke thinks with the AI its firing picked", async () => {
  const w = await world();
  const { fx, deps, bia, lodi } = w;
  await setAgentBrain(deps, bia.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: BIAS });
  const { build } = await sharedWidget(w, bia.id);
  const { run, agent } = await build();
  // A run nobody is behind, whose chain roots in the routine's build: an agent's message from it woke this one.
  const said = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: run.channelId,
    author: { type: "agent", agentId: lodi.id, runId: run.id, hop: run.hop },
    body: "Pronto.",
  });
  const [woken] = await fx.db
    .insert(schema.agentRuns)
    .values({ ...run, id: crypto.randomUUID(), background: false, triggerMessageId: said.id })
    .returning();
  if (!woken) throw new Error("no run");
  expect(await runAuthority(fx.db, woken)).toMatchObject({ kind: "unattended", reason: "routine" });
  expect(await resolveBrain({ db: fx.db, machines }, agent, woken, woken.channelId)).toMatchObject({
    account: { id: BIAS },
  });
});

test("the model saved on the right hand reaches the turn when the person's own AI names none", async () => {
  const { fx, deps, bia, lodi, runIn } = await world();
  // Bia picked a plan for her own DM and left the model to the right hand, saved for the same brain.
  await fx.db.insert(schema.rightHandBrains).values({
    orgId: fx.org.id,
    userId: bia.id,
    brain: "claude_code",
    brainModel: null,
    brainAccountId: BIAS,
  });
  await fx.db.update(schema.machineAccounts).set({ provider: "opencode" }).where(eq(schema.machineAccounts.id, BIAS));
  await fx.db
    .update(schema.agents)
    .set({ brain: "claude_code", brainModel: "deepseek-v4.1-flash", brainAccountId: BIAS })
    .where(eq(schema.agents.id, lodi.id));
  expect(await runIn(bia.id)).toMatchObject({
    kind: "claude_code",
    model: "deepseek-v4.1-flash",
    account: { id: BIAS },
  });
  // Her own settings show the model her DM runs.
  expect(await getAgentBrain(deps, bia.id, fx.org.id, lodi.id, "mine")).toMatchObject({
    scope: "mine",
    model: "deepseek-v4.1-flash",
    effectiveModel: "deepseek-v4.1-flash",
  });
});

test("the right hand's API model doesn't follow the person to their own plan", async () => {
  const { fx, deps, bia, lodi, runIn } = await world();
  // The right hand as seeded: the API brain with `auto`. Bia's own plan names no model.
  await fx.db.insert(schema.rightHandBrains).values({
    orgId: fx.org.id,
    userId: bia.id,
    brain: "claude_code",
    brainModel: null,
    brainAccountId: BIAS,
  });
  await fx.db.update(schema.agents).set({ brain: "model", brainModel: "auto" }).where(eq(schema.agents.id, lodi.id));
  expect(await runIn(bia.id)).toMatchObject({ kind: "claude_code", model: "sonnet", account: { id: BIAS } });
  expect(await getAgentBrain(deps, bia.id, fx.org.id, lodi.id, "mine")).toMatchObject({
    model: null,
    effectiveModel: "sonnet",
  });
});

test("a model saved for one computer brain doesn't follow the person to another", async () => {
  const { fx, bia, lodi } = await world();
  // Bia's own DM runs Codex; the right hand is stored on Claude Code with a Claude model. An Opus is no Codex model.
  await fx.db.insert(schema.rightHandBrains).values({
    orgId: fx.org.id,
    userId: bia.id,
    brain: "codex",
    brainModel: null,
    brainAccountId: BIAS,
  });
  await fx.db
    .update(schema.agents)
    .set({ brain: "claude_code", brainModel: "claude-opus-5-5", brainAccountId: BIAS })
    .where(eq(schema.agents.id, lodi.id));
  const [stored] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, lodi.id));
  if (!stored) throw new Error("no right hand");
  const { agent } = await withPersonalBrain(fx.db, stored, bia.id);
  expect(agent.brain).toBe("codex");
  expect(agent.brainModel).toBeNull();
});

test("a model the person chose for their own DM wins over the right hand's", async () => {
  const { fx, bia, lodi, runIn } = await world();
  await fx.db.insert(schema.rightHandBrains).values({
    orgId: fx.org.id,
    userId: bia.id,
    brain: "claude_code",
    brainModel: "glm-5.3",
    brainAccountId: BIAS,
  });
  await fx.db.update(schema.machineAccounts).set({ provider: "opencode" }).where(eq(schema.machineAccounts.id, BIAS));
  await fx.db
    .update(schema.agents)
    .set({ brain: "claude_code", brainModel: "deepseek-v4.1-flash", brainAccountId: BIAS })
    .where(eq(schema.agents.id, lodi.id));
  expect((await runIn(bia.id)).model).toBe("glm-5.3");
});
