import { afterEach, describe, expect, test } from "bun:test";
import { createFakeComposioClient, createFakeMailConnector } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  acceptCustomSuggestion,
  accountDeletionPlan,
  addChannelMember,
  agentScopesFor,
  agentSourceNames,
  auditLabel,
  CONNECTOR_FORGET_JOB,
  ConflictError,
  type ConnectorDeps,
  type ConnectorTriggerDeps,
  checkAgentDraft,
  checkConnectorTrigger,
  composioUserId,
  connectionFor,
  connectionViewFor,
  connectorScope,
  connectorStates,
  connectorTriggerAllowed,
  createAgent,
  createAgentRuns,
  createApiKeyConnection,
  createConnectorToolSource,
  createJobHandlers,
  createRoutine,
  createToolGateway,
  customScope,
  DEFAULT_ROUTER_POLICY,
  decideApproval,
  deleteAccount,
  duplicateRoutine,
  endOutsideAccess,
  ensureRightHand,
  expireApprovals,
  ForbiddenError,
  getAgentAccess,
  getAgentMail,
  getRun,
  insertMessage,
  insertMessageWithRuns,
  listAgentScopes,
  listApprovalRules,
  listApprovals,
  listAudit,
  listConnections,
  listCustomServers,
  type McpConnect,
  type McpSession,
  mcpSessionOver,
  missingPermissions,
  moveConnectionToTeam,
  NEW_AGENT_DEFAULTS,
  NotFoundError,
  openPersonAgentDm,
  orgOfComposioUser,
  othersLabel,
  pendingConnectors,
  RIGHT_HAND,
  type RoutingInput,
  reconnectTarget,
  recordSupportRequest,
  removeMember,
  renameConnection,
  resolveApps,
  revokeConnection,
  rightHandPrompt,
  routeMessage,
  runChecksForReply,
  setAgentAccess,
  setAgentScopes,
  storeCustomConnection,
  type ToolContext,
  takeConnectionOffAgent,
  takeOverRoutine,
  updateAgent,
  updateOrgSettings,
  updateRoutine,
  ValidationError,
} from "../src";
import { dispatchMentions } from "../src/dispatch";
import { operatorReveal } from "../src/operator-reveal";
import { creatorMayUse } from "../src/personal-use";
import { addMember, type Fixture, SECRET, setup } from "./fixtures";
import { routineDeps } from "./routine-fixtures";

let f: Fixture;
afterEach(() => f?.close());

const depsOf = (fx: Fixture): ConnectorDeps => ({
  db: fx.db,
  keyWrappers: [fx.keyWrapper],
  publicUrl: "https://chat.example.com",
});

/** An in-process MCP server shaped like Linear's: one read and one write. */
function fakeLinear() {
  const calls: string[] = [];
  const connect: McpConnect = async () => {
    const server = new McpServer({ name: "fake-linear", version: "1" });
    server.registerTool("list_issues", { description: "List issues", inputSchema: {} }, async () => {
      calls.push("list_issues");
      return { content: [{ type: "text", text: "ENG-1: fix sign-in" }] };
    });
    server.registerTool(
      "create_issue",
      { description: "Create an issue", inputSchema: { title: z.string() } },
      async () => {
        calls.push("create_issue");
        return { content: [{ type: "text", text: "Created ENG-2" }] };
      },
    );
    const [client, transport] = InMemoryTransport.createLinkedPair();
    await server.connect(transport);
    return mcpSessionOver(client);
  };
  return { connect, calls };
}

/** A run of `agentId` on a message `author` wrote in `channelId` (nobody: an agent's own message woke it). */
async function runOf(agentId: string, author: string | null, channelId = f.general.id): Promise<ToolContext> {
  const message = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: author
      ? { type: "person", userId: author }
      : { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
    body: "list my issues",
  });
  const [run] = await f.db.transaction((tx) => createAgentRuns(tx, message, [agentId], "mention"));
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId,
    runId: run.id,
    channelId,
    threadRootId: message.id,
    triggerMessageId: message.id,
  };
}

/** A routine's run of `agentId`, set up by `creator` (null: a routine nobody set up). */
async function routineRunOf(agentId: string, creator: string | null): Promise<ToolContext> {
  const message = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: creator ?? f.owner.id },
    body: "Check the board",
    meta: {
      routineBrief: {
        routineId: crypto.randomUUID(),
        routineRunId: crypto.randomUUID(),
        name: "Daily check",
        creatorUserId: creator,
        deliverTo: { channelId: f.general.id, threadId: null },
        access: "act",
        report: "when_new",
        trigger: "schedule",
        dueAt: new Date().toISOString(),
      },
      background: true,
    },
  });
  const [run] = await f.db.transaction((tx) =>
    createAgentRuns(tx, message, [agentId], "mention", { background: true }),
  );
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: message.id,
    triggerMessageId: message.id,
  };
}

/** Walter owns `@dev`, which answers only him, and connects his own Linear: it goes on for his agents alone. */
async function walterWithLinear() {
  f = await setup();
  const walter = await addMember(f.db, f.org.id, "member", "walter");
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: walter.id, audienceMode: "owner" })
    .where(eq(schema.agents.id, f.agent.id));
  const [ops] = await f.db
    .insert(schema.agents)
    .values({ orgId: f.org.id, name: "Ops", handle: "ops", model: "claude-sonnet-5-5", ownerUserId: bia.id })
    .returning();
  if (!ops) throw new Error("no agent");
  const mine = await createApiKeyConnection(depsOf(f), walter.id, f.org.id, {
    connector: "linear",
    apiKey: "lin_api_FAKE_walter_1234",
    personal: true,
  });
  const linear = fakeLinear();
  const source = createConnectorToolSource({ ...depsOf(f), connect: linear.connect });
  return { walter, bia, ops, mine, linear, source };
}

const names = async (source: ReturnType<typeof createConnectorToolSource>, ctx: ToolContext) =>
  (await source.tools(ctx)).map((t) => t.name).sort();

test("a personal one-click sign-in has its person's own account id at the hosted adapter", () => {
  const org = "0b9f6a52-8d7e-4f8e-9a3c-2f1d5c6b7a80";
  expect(composioUserId(org)).toBe(`org_${org}`);
  expect(composioUserId(org, "walter_1")).toBe(`org_${org}_u_walter_1`);
  expect(composioUserId(org, "walter_1")).not.toBe(composioUserId(org, "bia_2"));
  // Its executions still count for the workspace.
  expect(orgOfComposioUser(composioUserId(org, "walter_1"))).toBe(org);
});

describe("who may add, see and change a personal connection", () => {
  test("any member adds one; it goes on for their own agents only; the team's stays for who manages connectors", async () => {
    const { walter, ops, mine } = await walterWithLinear();
    expect(mine.ownerUserId).toBe(walter.id);
    const grants = await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, mine.id));
    expect(grants.map((g) => g.agentId)).toEqual([f.agent.id]);
    expect(grants.map((g) => g.agentId)).not.toContain(ops.id);
    await expect(
      createApiKeyConnection(depsOf(f), walter.id, f.org.id, { connector: "linear", apiKey: "lin_api_FAKE_team_12" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // GitHub stays the team's: its git proxy and repository lists read the workspace's one connection.
    await expect(
      createApiKeyConnection(depsOf(f), walter.id, f.org.id, {
        connector: "github",
        apiKey: "ghp_FAKE_walter_123456",
        personal: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    // The team may have its own Linear beside his: another tool prefix, nothing of his replaced.
    const team = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "linear",
      apiKey: "lin_api_FAKE_team_1234",
    });
    expect(team.ownerUserId).toBeNull();
    expect(team.toolPrefix).not.toBe(mine.toolPrefix);
    const live = (await f.db.select().from(schema.connectorConnections)).filter((c) => !c.revokedAt);
    expect(live.map((c) => c.id).sort()).toEqual([mine.id, team.id].sort());
  });

  test("another member reads nothing of it; who manages connectors sees that it exists and may remove it, never read it", async () => {
    const { walter, bia, mine } = await walterWithLinear();
    expect((await listConnections(f.db, bia.id, f.org.id, { others: true })).map((c) => c.id)).not.toContain(mine.id);
    expect((await listConnections(f.db, walter.id, f.org.id)).map((c) => c.id)).toEqual([mine.id]);
    // The owner manages connectors: with `others` the row comes, as a person's row with no address or account.
    const listed = await listConnections(f.db, f.owner.id, f.org.id, { others: true });
    const row = listed.find((c) => c.id === mine.id);
    if (!row) throw new Error("not listed");
    expect(connectionViewFor(row, f.owner.id)).toMatchObject({
      ownerUserId: walter.id,
      serverUrl: "",
      accountLabel: null,
    });
    expect((await listConnections(f.db, f.owner.id, f.org.id)).map((c) => c.id)).not.toContain(mine.id);
    await expect(connectionFor(f.db, bia.id, f.org.id, mine.id, "read")).rejects.toBeInstanceOf(NotFoundError);
    await expect(connectionFor(f.db, f.owner.id, f.org.id, mine.id, "read")).rejects.toBeInstanceOf(NotFoundError);
    await expect(renameConnection(f.db, f.owner.id, f.org.id, mine.id, "Mine now")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(revokeConnection(f.db, bia.id, f.org.id, mine.id)).rejects.toBeInstanceOf(NotFoundError);
    await revokeConnection(f.db, f.owner.id, f.org.id, mine.id);
    expect(await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, mine.id))).toEqual(
      [],
    );
  });

  test("another workspace finds nothing of it", async () => {
    const { mine } = await walterWithLinear();
    const [other] = await f.db.insert(schema.organizations).values({ name: "Acme" }).returning();
    if (!other) throw new Error("no org");
    await f.db.insert(schema.organizationMembers).values({ orgId: other.id, userId: f.owner.id, role: "owner" });
    await expect(connectionFor(f.db, f.owner.id, other.id, mine.id, "remove")).rejects.toBeInstanceOf(NotFoundError);
    expect(await listConnections(f.db, f.owner.id, other.id, { others: true })).toEqual([]);
  });

  test("only its person renames it; moving it to the team needs them to manage connectors", async () => {
    const { walter, mine } = await walterWithLinear();
    expect((await renameConnection(f.db, walter.id, f.org.id, mine.id, "My Linear")).label).toBe("My Linear");
    await expect(moveConnectionToTeam(f.db, walter.id, f.org.id, mine.id)).rejects.toThrow("manage connectors");
  });
});

describe("a personal connection serves only its own person, as a personal Vault item or skill does", () => {
  test("its person's run gets its tools; a run nobody is behind gets nothing personal", async () => {
    const { walter, source } = await walterWithLinear();
    expect(await names(source, await runOf(f.agent.id, walter.id))).toEqual([
      "linear_create_issue",
      "linear_list_issues",
    ]);
    expect(await names(source, await runOf(f.agent.id, null))).toEqual([]);
  });

  test("a teammate the agent answers directly gets nothing of it, nor does an admin", async () => {
    const { walter, bia, mine, source } = await walterWithLinear();
    // Walter opens `@dev` to everyone: Bia and the owner talk to it, and still nothing of his Linear reaches them.
    await f.db.update(schema.agents).set({ audienceMode: "everyone" }).where(eq(schema.agents.id, f.agent.id));
    expect(await names(source, await runOf(f.agent.id, bia.id))).toEqual([]);
    expect(await names(source, await runOf(f.agent.id, f.owner.id))).toEqual([]);
    // Nor its name among what the run holds.
    const held = await connectorStates(f.db, f.org.id, { oauthApps: {} }, { usable: [], listed: [] }, bia.id);
    expect(held.flatMap((c) => c.connectionIds)).not.toContain(mine.id);
    expect(held.find((c) => c.names.includes("linear"))?.state).toBe("not_connected");
    // His own run acts as his: no card for a plain write, its reads marked as from outside, its cards his.
    const ctx = await runOf(f.agent.id, walter.id);
    const tools = await source.tools(ctx);
    const write = tools.find((t) => t.name === "linear_create_issue");
    const read = tools.find((t) => t.name === "linear_list_issues");
    expect(write).toMatchObject({ sensitive: false, ownerUserId: walter.id });
    expect(read?.readsOutside).toBe(true);
    expect(await write?.approvers?.({}, ctx, walter.id)).toMatchObject({
      ok: true,
      approvers: { userIds: [walter.id] },
    });
  });

  test("the gateway refuses a call into it from a run whose person is not its owner", async () => {
    const { walter, bia, linear, source } = await walterWithLinear();
    await f.db.update(schema.agents).set({ audienceMode: "everyone" }).where(eq(schema.agents.id, f.agent.id));
    // A source that lists his tools to any run, as a bug upstream of the gateway would.
    const his = await source.tools(await runOf(f.agent.id, walter.id));
    const gateway = createToolGateway({ sources: [{ name: "leaky", tools: async () => his }] });
    const call = { toolUseId: "t1", name: "linear_list_issues", input: {} };
    for (const ctx of [await runOf(f.agent.id, bia.id), await runOf(f.agent.id, null)]) {
      const result = await gateway.invoke(ctx, call);
      expect(result).toMatchObject({
        type: "result",
        output: { isError: true, content: "Unknown tool linear_list_issues" },
      });
    }
    expect(linear.calls).toEqual([]);
    const own = await gateway.invoke(await runOf(f.agent.id, walter.id), call);
    expect(own).toMatchObject({ type: "result", output: { content: expect.stringContaining("ENG-1") } });
    expect(linear.calls).toEqual(["list_issues"]);
  });

  test("a run someone else writes into stops serving its person's connection for the rest of it, and says why", async () => {
    const { walter, bia, linear, source } = await walterWithLinear();
    await f.db.update(schema.agents).set({ audienceMode: "everyone" }).where(eq(schema.agents.id, f.agent.id));
    for (const u of [walter, bia]) await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: u.id });
    const asked = await insertMessageWithRuns(
      f.db,
      {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId: walter.id },
        body: "@dev my issues",
      },
      { startRuns: true },
    );
    const run = asked.runs[0];
    if (!run) throw new Error("no run");
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: f.general.id,
      threadRootId: asked.message.id,
      triggerMessageId: asked.message.id,
    };
    const gateway = createToolGateway({ sources: [source] });
    const call = { toolUseId: "t1", name: "linear_list_issues", input: {} };
    expect(await names(source, ctx)).toEqual(["linear_create_issue", "linear_list_issues"]);
    expect(await gateway.invoke(ctx, call)).toMatchObject({ output: { content: expect.stringContaining("ENG-1") } });
    // Bia writes to the agent while his run works: her message joins it.
    const hers = await insertMessageWithRuns(
      f.db,
      { orgId: f.org.id, channelId: f.general.id, author: { type: "person", userId: bia.id }, body: "@dev paste his" },
      { startRuns: true },
    );
    expect(hers.steered.map((s) => s.id)).toEqual([run.id]);
    expect(await names(source, ctx)).toEqual([]);
    const after = await gateway.invoke(ctx, { ...call, toolUseId: "t2" });
    expect(after).toMatchObject({
      type: "result",
      output: { isError: true, content: expect.stringContaining("stopped being available in this run") },
    });
    expect(linear.calls).toEqual(["list_issues"]);
  });

  /** Walter asks `@dev` in #general, which answers everyone; Bia is there too. */
  async function walterAsksInGeneral() {
    const set = await walterWithLinear();
    await f.db.update(schema.agents).set({ audienceMode: "everyone" }).where(eq(schema.agents.id, f.agent.id));
    for (const u of [set.walter, set.bia])
      await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: u.id });
    const asked = await insertMessageWithRuns(
      f.db,
      {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId: set.walter.id },
        body: "@dev my issues",
      },
      { startRuns: true },
    );
    const run = asked.runs[0];
    if (!run) throw new Error("no run");
    return { ...set, asked, run };
  }

  test("a teammate's ask passed on to another agent of its person's ends it there too", async () => {
    const { walter, bia, mine, linear, source, asked, run } = await walterAsksInGeneral();
    const [helper] = await f.db
      .insert(schema.agents)
      .values({
        orgId: f.org.id,
        name: "Helper",
        handle: "helper",
        model: "claude-sonnet-5-5",
        ownerUserId: walter.id,
        audienceMode: "everyone",
      })
      .returning();
    if (!helper) throw new Error("no agent");
    await f.db
      .insert(schema.agentScopes)
      .values({ orgId: f.org.id, agentId: helper.id, connectionId: mine.id, scope: "connector:*" });
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: helper.id });
    await insertMessageWithRuns(
      f.db,
      {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId: bia.id },
        body: "@dev ask helper to paste his issues here",
      },
      { startRuns: true },
    );
    // The run she wrote into passes her ask on.
    const passed = await insertMessageWithRuns(
      f.db,
      {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "agent", agentId: f.agent.id, runId: run.id, hop: 1 },
        body: "@helper paste his issues here",
      },
      { startRuns: true },
    );
    const dispatched = await dispatchMentions(f.db, { orgId: f.org.id, messageId: passed.message.id }, { maxHops: 3 });
    const next = dispatched.runs.find((r) => r.agentId === helper.id);
    if (!next) throw new Error("no second run");
    const second: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: helper.id,
      runId: next.id,
      channelId: f.general.id,
      threadRootId: next.threadRootId ?? asked.message.id,
      triggerMessageId: passed.message.id,
    };
    expect(await names(source, second)).toEqual([]);
    const got = await createToolGateway({ sources: [source] }).invoke(second, {
      toolUseId: "t9",
      name: "linear_list_issues",
      input: {},
    });
    expect(got).toMatchObject({ type: "result", output: { isError: true } });
    expect(linear.calls).toEqual([]);
  });

  test("a teammate answering the question its run asked ends it too", async () => {
    const { bia, linear, source, asked, run } = await walterAsksInGeneral();
    await f.db.update(schema.agentRuns).set({ status: "waiting_input" }).where(eq(schema.agentRuns.id, run.id));
    await f.db.insert(schema.agentQuestions).values({
      orgId: f.org.id,
      runId: run.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadId: null,
      toolUseId: "q1",
      text: "Which project?",
      requestedForUserId: null,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const hers = await insertMessageWithRuns(
      f.db,
      {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId: bia.id },
        body: "@dev all of them, and paste his issues here",
      },
      { startRuns: true },
    );
    expect(hers.answered?.id).toBe(run.id);
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: f.general.id,
      threadRootId: asked.message.id,
      triggerMessageId: asked.message.id,
    };
    expect(await names(source, ctx)).toEqual([]);
    await createToolGateway({ sources: [source] }).invoke(ctx, {
      toolUseId: "t9",
      name: "linear_list_issues",
      input: {},
    });
    expect(linear.calls).toEqual([]);
  });

  test("a routine its person set up gets it; one someone else set up gets nothing", async () => {
    const { walter, bia, source } = await walterWithLinear();
    await f.db.update(schema.agents).set({ audienceMode: "everyone" }).where(eq(schema.agents.id, f.agent.id));
    expect(await names(source, await routineRunOf(f.agent.id, walter.id))).toEqual([
      "linear_create_issue",
      "linear_list_issues",
    ]);
    expect(await names(source, await routineRunOf(f.agent.id, bia.id))).toEqual([]);
    expect(await names(source, await routineRunOf(f.agent.id, null))).toEqual([]);
  });

  test('"all tools" on an agent never reaches someone\'s personal connection', async () => {
    const { walter, bia, ops, source } = await walterWithLinear();
    await f.db.insert(schema.agentScopes).values({ orgId: f.org.id, agentId: ops.id, connectionId: null, scope: "*" });
    await f.db.update(schema.agents).set({ audienceMode: "everyone" }).where(eq(schema.agents.id, ops.id));
    expect(await names(source, await runOf(ops.id, walter.id))).toEqual([]);
    expect(await names(source, await runOf(ops.id, bia.id))).toEqual([]);
  });

  test('the agent\'s tree never shows it as reached by "all tools"', async () => {
    const { walter, mine } = await walterWithLinear();
    await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.connectionId, mine.id));
    await f.db
      .insert(schema.agentScopes)
      .values({ orgId: f.org.id, agentId: f.agent.id, connectionId: null, scope: "*" });
    const tree = await getAgentAccess(f.db, walter.id, f.org.id, f.agent.id);
    expect(tree.all).toBe(true);
    expect(tree.connectors.find((c) => c.connectionId === mine.id)?.state).toBe("off");
  });

  test('its tools obey the agent\'s own grants on it: "all tools" and a read-only grant never give its writes', async () => {
    const { walter, mine, source } = await walterWithLinear();
    await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.connectionId, mine.id));
    await f.db.insert(schema.agentScopes).values([
      { orgId: f.org.id, agentId: f.agent.id, connectionId: null, scope: "*" },
      { orgId: f.org.id, agentId: f.agent.id, connectionId: mine.id, scope: connectorScope("linear", "issues.read") },
    ]);
    expect(await names(source, await runOf(f.agent.id, walter.id))).toEqual(["linear_list_issues"]);
  });

  test("a card waiting on its tool is canceled when its person leaves", async () => {
    const { walter, linear, source } = await walterWithLinear();
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { approvalsLevel: "always" });
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: walter.id });
    const message = await insertMessageWithRuns(
      f.db,
      { orgId: f.org.id, channelId: f.general.id, author: { type: "person", userId: walter.id }, body: "@dev file it" },
      { startRuns: true },
    );
    const run = message.runs[0];
    if (!run) throw new Error("no run");
    const gateway = createToolGateway({ sources: [source] });
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: f.general.id,
      threadRootId: message.message.id,
      triggerMessageId: message.message.id,
    };
    const asked = await gateway.invoke(ctx, {
      toolUseId: "t1",
      name: "linear_create_issue",
      input: { title: "Quarterly plan", why: "Walter asked me to file the quarterly plan in his own Linear today." },
    });
    if (asked.type !== "approval") throw new Error(`expected a card, got ${asked.type}`);
    await removeMember(f.db, f.owner.id, f.org.id, walter.id);
    const [card] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, asked.approval.id));
    expect(card?.status).toBe("canceled");
    expect(linear.calls).toEqual([]);
  });

  test("the right hand uses it only for its owner, in their own DM", async () => {
    const { walter, bia, mine, source } = await walterWithLinear();
    await ensureRightHand(f.db, f.org.id);
    const [lodi] = await f.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
    if (!lodi) throw new Error("no right hand");
    await f.db
      .insert(schema.agentScopes)
      .values({ orgId: f.org.id, agentId: lodi.id, connectionId: mine.id, scope: "connector:*" });
    const dm = await openPersonAgentDm(f.db, f.org.id, walter.id, lodi.id);
    expect(await names(source, await runOf(lodi.id, walter.id, dm.id))).toEqual([
      "linear_create_issue",
      "linear_list_issues",
    ]);
    expect(await names(source, await runOf(lodi.id, walter.id, f.general.id))).toEqual([]);
    const biaDm = await openPersonAgentDm(f.db, f.org.id, bia.id, lodi.id);
    expect(await names(source, await runOf(lodi.id, bia.id, biaDm.id))).toEqual([]);
    // Its snapshot names his connection to him in his DM only, never in a channel, never to Bia.
    await renameConnection(f.db, walter.id, f.org.id, mine.id, "Walter's Linear");
    const snapshot = (personId: string, inDm: boolean) =>
      rightHandPrompt({ db: f.db }, { orgId: f.org.id, agent: lodi, personId, inDm });
    expect(await snapshot(walter.id, true)).toContain("Walter's Linear");
    expect(await snapshot(walter.id, false)).not.toContain("Walter's Linear");
    expect(await snapshot(bia.id, true)).not.toContain("Walter's Linear");
  });

  test("a person who leaves takes their connections with them; the team's keep serving runs", async () => {
    const { walter, mine, source } = await walterWithLinear();
    const team = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "sentry",
      apiKey: "sntrys_FAKE_team_1234",
    });
    await removeMember(f.db, f.owner.id, f.org.id, walter.id);
    const [row] = await f.db
      .select()
      .from(schema.connectorConnections)
      .where(eq(schema.connectorConnections.id, mine.id));
    expect(row?.revokedAt).not.toBeNull();
    expect(await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, mine.id))).toEqual(
      [],
    );
    const still = await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, team.id));
    expect(still.length).toBeGreaterThan(0);
    expect(await names(source, await runOf(f.agent.id, f.owner.id))).toEqual([]);
  });
});

describe("an agent's page", () => {
  test("who may change the agent sees another's personal connection while it is on, with no tools, and may only take it off", async () => {
    const { walter, mine } = await walterWithLinear();
    const tree = await getAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, { others: true });
    expect(tree.connectors.find((c) => c.connectionId === mine.id)).toMatchObject({
      ownerUserId: walter.id,
      scopes: [],
    });
    // An app that doesn't know the word never gets it.
    const plain = await getAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id);
    expect(plain.connectors.map((c) => c.connectionId)).not.toContain(mine.id);
    const input = { all: false, connectors: {}, scopes: [], tools: { allow: [], deny: [] } };
    // A save that doesn't name it keeps it; only `false` takes it off.
    await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, input);
    const kept = await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, mine.id));
    expect(kept.length).toBe(1);
    await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, { ...input, connectors: { [mine.id]: false } });
    expect(await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, mine.id))).toEqual(
      [],
    );
    // Nobody but Walter gives it back.
    await expect(
      setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, { ...input, connectors: { [mine.id]: true } }),
    ).rejects.toThrow("Only its person");
    await setAgentAccess(f.db, walter.id, f.org.id, f.agent.id, { ...input, connectors: { [mine.id]: true } });
    expect(
      (await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.connectionId, mine.id))).length,
    ).toBe(1);
  });
});

describe("what others may know of it", () => {
  test("a member who neither manages nor owns the agent gets nothing of another's on it, even asking for others'", async () => {
    const { bia, mine } = await walterWithLinear();
    const tree = await getAgentAccess(f.db, bia.id, f.org.id, f.agent.id, { others: true });
    expect(tree.connectors.map((c) => c.connectionId)).not.toContain(mine.id);
    // The grant rows say nothing of it to her either; who manages connectors still sees them.
    expect((await listAgentScopes(f.db, f.org.id, f.agent.id)).some((r) => r.connectionId === mine.id)).toBe(true);
    expect((await agentScopesFor(f.db, bia.id, f.org.id, f.agent.id)).map((r) => r.connectionId)).not.toContain(
      mine.id,
    );
    expect((await agentScopesFor(f.db, f.owner.id, f.org.id, f.agent.id)).map((r) => r.connectionId)).toContain(
      mine.id,
    );
  });

  test("a name is free unless the team or the person already uses it, so it never tells of someone else's", async () => {
    const { walter, bia, mine } = await walterWithLinear();
    await renameConnection(f.db, walter.id, f.org.id, mine.id, "Linear (walter@example.com)");
    const hers = await createApiKeyConnection(depsOf(f), bia.id, f.org.id, {
      connector: "sentry",
      apiKey: "sntrys_FAKE_bia_123456",
      personal: true,
    });
    const renamed = await renameConnection(f.db, bia.id, f.org.id, hers.id, "Linear (walter@example.com)");
    expect(renamed.label).toBe("Linear (walter@example.com)");
    // The team's own Linear takes its plain name beside his.
    const team = await createApiKeyConnection(depsOf(f), f.owner.id, f.org.id, {
      connector: "linear",
      apiKey: "lin_api_FAKE_team_1234",
    });
    expect(team.label).toBe("Linear");
  });

  test("what a run holds counts the team's and its person's own, never someone else's", async () => {
    const { walter, bia } = await walterWithLinear();
    const catalog = { oauthApps: {} };
    const linear = (person: string | null) =>
      connectorStates(f.db, f.org.id, catalog, { usable: [], listed: [] }, person).then((all) =>
        all.find((c) => c.names.includes("linear")),
      );
    // Held and not listed: nothing is said of it for Walter. For Bia it isn't connected at all.
    expect(await linear(walter.id)).toBeUndefined();
    expect((await linear(bia.id))?.state).not.toBeUndefined();
    expect((await linear(null))?.state).not.toBeUndefined();
  });

  test("an agent's 'Aprovar sempre' rules on a person's own connection are listed to that person only", async () => {
    const { walter, bia, mine } = await walterWithLinear();
    await f.db.insert(schema.approvalRules).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      connectionId: mine.id,
      tool: "create_issue",
      createdByUserId: walter.id,
    });
    const tools = async (who: string) => (await listApprovalRules(f.db, who, f.org.id, f.agent.id)).map((r) => r.tool);
    expect(await tools(walter.id)).toEqual(["create_issue"]);
    expect(await tools(bia.id)).toEqual([]);
    expect(await tools(f.owner.id)).toEqual([]);
  });

  test("widget suggestions never name a person's own connection", async () => {
    const { mine } = await walterWithLinear();
    expect(await agentSourceNames(f.db, f.org.id, f.agent.id)).not.toContain(mine.label);
  });

  test("an agent's mailboxes: one's own and ownerless ones; someone else's only while held, to who may take it off, with no rules", async () => {
    const { walter, bia } = await walterWithLinear();
    const [box] = await f.db
      .insert(schema.mailAccounts)
      .values({
        orgId: f.org.id,
        provider: "imap",
        via: "imap",
        address: "walter@example.com",
        status: "active",
        createdByUserId: walter.id,
      })
      .returning();
    if (!box) throw new Error("no mailbox");
    await f.db
      .insert(schema.agentScopes)
      .values({ orgId: f.org.id, agentId: f.agent.id, connectionId: box.id, scope: "mail:read" });
    await f.db.insert(schema.mailAgentPolicies).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      accountId: box.id,
      folders: ["INBOX"],
      senders: [],
      allowedRecipients: ["ada@example.com"],
      windowDays: null,
      dailySendCap: 10,
      sendWithoutAsking: false,
    });
    expect((await getAgentMail(f.db, bia.id, f.org.id, f.agent.id)).map((m) => m.accountId)).not.toContain(box.id);
    const seen = (await getAgentMail(f.db, f.owner.id, f.org.id, f.agent.id)).find((m) => m.accountId === box.id);
    expect(seen?.level).toBe("read");
    expect(seen?.policy.allowedRecipients).toEqual([]);
    expect(
      (await getAgentMail(f.db, walter.id, f.org.id, f.agent.id)).find((m) => m.accountId === box.id)?.policy,
    ).toMatchObject({ allowedRecipients: ["ada@example.com"] });
  });
});

describe("routines that wait on a person's connection", () => {
  async function millionSendOf(ownerId: string, agentId: string) {
    const [ms] = await f.db
      .insert(schema.connectorConnections)
      .values({
        orgId: f.org.id,
        connector: "custom:ms1",
        label: "MillionSend",
        serverUrl: "https://api.millionsend.com/mcp",
        authType: "api_key",
        toolPrefix: "millionsend",
        ownerUserId: ownerId,
        createdByUserId: ownerId,
      })
      .returning();
    if (!ms) throw new Error("no row");
    await f.db
      .insert(schema.agentScopes)
      .values({ orgId: f.org.id, agentId, connectionId: ms.id, scope: customScope(ms.id, "read") });
    return ms;
  }
  const event = "millionsend.email.received" as const;

  test("on the right hand, only its owner's own routine takes its events", async () => {
    const { walter, bia } = await walterWithLinear();
    await ensureRightHand(f.db, f.org.id);
    const [lodi] = await f.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
    if (!lodi) throw new Error("no right hand");
    const ms = await millionSendOf(walter.id, lodi.id);
    const input = { connectionId: ms.id, event };
    await expect(checkConnectorTrigger(f.db, f.org.id, lodi.id, input, bia.id)).rejects.toBeInstanceOf(ValidationError);
    expect((await checkConnectorTrigger(f.db, f.org.id, lodi.id, input, walter.id)).id).toBe(ms.id);
  });

  test("on another agent, only its owner's own routine, and only while they are a member", async () => {
    const { walter, bia } = await walterWithLinear();
    const ms = await millionSendOf(walter.id, f.agent.id);
    const input = { connectionId: ms.id, event };
    // `@dev` answers everyone: someone it answers still isn't its owner.
    await f.db.update(schema.agents).set({ audienceMode: "everyone" }).where(eq(schema.agents.id, f.agent.id));
    await expect(checkConnectorTrigger(f.db, f.org.id, f.agent.id, input, bia.id)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await checkConnectorTrigger(f.db, f.org.id, f.agent.id, input, walter.id)).id).toBe(ms.id);
    const routineBy = async (creator: string) => {
      const [routine] = await f.db
        .insert(schema.routines)
        .values({
          orgId: f.org.id,
          agentId: f.agent.id,
          name: "Mail",
          prompt: "Read it",
          target: { type: "dm" },
          triggerType: "webhook",
          createdByUserId: creator,
        })
        .returning();
      if (!routine) throw new Error("no routine");
      return routine;
    };
    const hers = await routineBy(bia.id);
    const his = await routineBy(walter.id);
    expect(await connectorTriggerAllowed(f.db, f.org.id, hers.id, { ...input, filter: {} })).toBe(false);
    expect(await connectorTriggerAllowed(f.db, f.org.id, his.id, { ...input, filter: {} })).toBe(true);
    await removeMember(f.db, f.owner.id, f.org.id, walter.id);
    expect(await connectorTriggerAllowed(f.db, f.org.id, his.id, { ...input, filter: {} })).toBe(false);
  });

  test("someone else's copy stays off: turning it on is refused and registers nothing", async () => {
    const { walter } = await walterWithLinear();
    await f.db.update(schema.agents).set({ audienceMode: "everyone" }).where(eq(schema.agents.id, f.agent.id));
    const ms = await millionSendOf(walter.id, f.agent.id);
    let made = 0;
    const session: McpSession = {
      listTools: async () => [],
      callTool: async (name) => {
        if (name !== "create_webhook") return { content: "{}", isError: false };
        made += 1;
        return { content: JSON.stringify({ id: `0193ffff-0000-4000-8000-00000000000${made}` }), isError: false };
      },
      close: async () => {},
    };
    const hooks = { publicUrl: "https://agentes.test", secret: SECRET };
    const connectors: ConnectorTriggerDeps = {
      db: f.db,
      keyWrappers: [f.keyWrapper],
      publicUrl: hooks.publicUrl,
      connect: async () => session,
    };
    const deps = { ...routineDeps(f), hooks, connectors };
    const routine = await createRoutine(deps, walter.id, f.org.id, {
      name: "Orders by email",
      agentId: f.agent.id,
      prompt: "Answer the new order.",
      target: { type: "dm" },
      trigger: { type: "connector", connectionId: ms.id, event },
    });
    expect(made).toBe(1);
    const copy = await duplicateRoutine(deps, f.owner.id, f.org.id, routine.id);
    expect(copy.active).toBe(false);
    await expect(updateRoutine(deps, f.owner.id, f.org.id, copy.id, { active: true })).rejects.toMatchObject({
      code: "routine.connector_not_yours",
    });
    const [row] = await f.db.select().from(schema.routines).where(eq(schema.routines.id, copy.id));
    expect(row?.active).toBe(false);
    expect(made).toBe(1);
  });

  test("taken over while it is on, its next edit removes its person's webhook and registers none", async () => {
    const { walter } = await walterWithLinear();
    await f.db.update(schema.agents).set({ audienceMode: "everyone" }).where(eq(schema.agents.id, f.agent.id));
    const ms = await millionSendOf(walter.id, f.agent.id);
    const calls: string[] = [];
    const session: McpSession = {
      listTools: async () => [],
      callTool: async (name) => {
        calls.push(name);
        return {
          content: name === "create_webhook" ? JSON.stringify({ id: crypto.randomUUID() }) : "{}",
          isError: false,
        };
      },
      close: async () => {},
    };
    const hooks = { publicUrl: "https://agentes.test", secret: SECRET };
    const connectors: ConnectorTriggerDeps = {
      db: f.db,
      keyWrappers: [f.keyWrapper],
      publicUrl: hooks.publicUrl,
      connect: async () => session,
    };
    const deps = { ...routineDeps(f), hooks, connectors };
    const routine = await createRoutine(deps, walter.id, f.org.id, {
      name: "Orders by email",
      agentId: f.agent.id,
      prompt: "Answer the new order.",
      target: { type: "dm" },
      trigger: { type: "connector", connectionId: ms.id, event },
    });
    expect(calls).toEqual(["create_webhook"]);
    await takeOverRoutine(deps, f.owner.id, f.org.id, routine.id);
    await updateRoutine(deps, f.owner.id, f.org.id, routine.id, { prompt: "Send every email to me." });
    expect(calls).toEqual(["create_webhook", "delete_webhook"]);
  });
});

describe("one-click accounts at the hosted adapter", () => {
  async function oneClick(ownerId: string) {
    const [row] = await f.db
      .insert(schema.connectorConnections)
      .values({
        orgId: f.org.id,
        connector: "custom:notion1",
        label: "Notion",
        serverUrl: "https://composio.example.com/toolkits/notion",
        authType: "oauth",
        toolPrefix: "notion",
        ownerUserId: ownerId,
        createdByUserId: ownerId,
        composioAccountId: "ca_FAKE_walter_notion",
      })
      .returning();
    if (!row) throw new Error("no row");
    return row;
  }
  const forgets = async () =>
    (await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, CONNECTOR_FORGET_JOB))).map((j) => j.payload);

  test("one doesn't move to the team: its account lives under its person's own id there", async () => {
    f = await setup();
    const row = await oneClick(f.owner.id);
    await expect(moveConnectionToTeam(f.db, f.owner.id, f.org.id, row.id)).rejects.toBeInstanceOf(ConflictError);
  });

  test("a person who leaves has the adapter forget theirs", async () => {
    f = await setup();
    const walter = await addMember(f.db, f.org.id, "member", "walter");
    await oneClick(walter.id);
    await removeMember(f.db, f.owner.id, f.org.id, walter.id);
    expect(await forgets()).toEqual([{ accountIds: ["ca_FAKE_walter_notion"] }]);
    const composio = createFakeComposioClient();
    const handlers = createJobHandlers({
      ...f.jobDeps,
      mail: { composio: { client: composio.client, connector: createFakeMailConnector().connector }, imap: null },
    });
    const [job] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, CONNECTOR_FORGET_JOB));
    if (!job) throw new Error("no job");
    await handlers[CONNECTOR_FORGET_JOB]?.(job, { finalAttempt: false });
    expect(composio.state.deletedAccounts).toEqual(["ca_FAKE_walter_notion"]);
  });

  test("a deleted account's connections are revoked and audited, and the adapter forgets them", async () => {
    f = await setup();
    const walter = await addMember(f.db, f.org.id, "member", "walter");
    const row = await oneClick(walter.id);
    await deleteAccount(f.db, walter.id, {});
    const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, row.id));
    expect(audit.map((a) => a.action)).toContain("connector.disconnected");
    expect(await forgets()).toEqual([{ accountIds: ["ca_FAKE_walter_notion"] }]);
  });
});

describe("a call in it, as admins and the agent's owner read it", () => {
  test("a card it opens is its person's alone to list and decide, even asked in their own DM", async () => {
    const { walter, bia, source } = await walterWithLinear();
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { approvalsLevel: "always" });
    const dm = await openPersonAgentDm(f.db, f.org.id, walter.id, f.agent.id);
    const gateway = createToolGateway({ sources: [source] });
    const result = await gateway.invoke(await runOf(f.agent.id, walter.id, dm.id), {
      toolUseId: "t1",
      name: "linear_create_issue",
      input: { title: "Private: salary review", why: "Walter asked me to file this in his own Linear." },
    });
    if (result.type !== "approval") throw new Error(`expected a card, got ${result.type}`);
    expect(await listApprovals(f.db, f.owner.id, f.org.id)).toEqual([]);
    expect(await listApprovals(f.db, bia.id, f.org.id)).toEqual([]);
    const [his] = await listApprovals(f.db, walter.id, f.org.id);
    expect(his).toMatchObject({ id: result.approval.id, canDecide: true });
    await expect(
      decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, result.approval.id, { decision: "approve" }),
    ).rejects.toThrow();
    const done = await decideApproval({ db: f.db, pubsub: f.pubsub }, walter.id, f.org.id, result.approval.id, {
      decision: "refuse",
    });
    expect(done.status).toBe("refused");
    expect(await listApprovals(f.db, f.owner.id, f.org.id, { status: "decided" })).toEqual([]);
  });

  test("the audit log and the run's trace keep only that it happened, for anyone but its person", async () => {
    const { walter, source } = await walterWithLinear();
    // Walter owns the agent and asks in #general, which the workspace's owner reads too.
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: walter.id });
    const ctx = await runOf(f.agent.id, walter.id);
    const gateway = createToolGateway({ sources: [source] });
    const input = { title: "Salary review for Bia" };
    await gateway.invoke(ctx, { toolUseId: "t1", name: "linear_create_issue", input });
    await f.db.insert(schema.agentRunSteps).values([
      {
        orgId: f.org.id,
        runId: ctx.runId,
        seq: 901,
        kind: "tool_call",
        data: { toolUseId: "t1", name: "linear_create_issue", input },
      },
      {
        orgId: f.org.id,
        runId: ctx.runId,
        seq: 902,
        kind: "tool_result",
        data: { toolUseId: "t1", name: "linear_create_issue", isError: false, content: "Created ENG-2" },
      },
    ]);
    const call = async (who: string) =>
      (await listAudit(f.db, who, f.org.id)).rows.find((r) => r.target.id === "linear_create_issue");
    // Recorded whole: only the reading hides it.
    const [written] = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "tool.call"));
    expect(written?.details).toMatchObject({ personalOf: walter.id, input });
    expect((await call(f.owner.id))?.details.input).toEqual({});

    const trace = async (who: string) => JSON.stringify((await getRun(f.db, who, f.org.id, ctx.runId)).steps);
    const admins = await trace(f.owner.id);
    expect(admins).toContain("linear_create_issue");
    expect(admins).not.toContain("Salary review");
    expect(admins).not.toContain("ENG-2");
    expect(await trace(walter.id)).toContain("ENG-2");
  });

  test("an approved card's action keeps its input for its person alone too", async () => {
    const { walter, source, linear } = await walterWithLinear();
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { approvalsLevel: "always" });
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: walter.id });
    const ctx = await runOf(f.agent.id, walter.id);
    const gateway = createToolGateway({ sources: [source] });
    const asked = await gateway.invoke(ctx, {
      toolUseId: "t1",
      name: "linear_create_issue",
      input: { title: "Salary review for Bia", why: "Walter asked me to file this in his own Linear." },
    });
    if (asked.type !== "approval") throw new Error(`expected a card, got ${asked.type}`);
    await decideApproval({ db: f.db, pubsub: f.pubsub }, walter.id, f.org.id, asked.approval.id, {
      decision: "approve",
    });
    const [card] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, asked.approval.id));
    if (!card) throw new Error("no approval row");
    await gateway.executeApproved(ctx, card);
    expect(linear.calls).toEqual(["create_issue"]);
    const rows = (await listAudit(f.db, f.owner.id, f.org.id)).rows.filter(
      (r) => r.target.id === "linear_create_issue",
    );
    expect(rows.map((r) => r.outcome).sort()).toEqual(["done", "pending"]);
    expect(JSON.stringify(rows)).not.toContain("Salary review");
    const [done] = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.outcome, "done"));
    expect(done?.details).toMatchObject({ personalOf: walter.id, input: { title: "Salary review for Bia" } });
  });
});

describe("a person's own server by address", () => {
  const ADDRESS = "https://crm.example.com/mcp/fake-path-token";

  async function walterWithCrm() {
    const { walter, bia } = await walterWithLinear();
    const { connection } = await storeCustomConnection(depsOf(f), {
      orgId: f.org.id,
      actorId: walter.id,
      serverUrl: ADDRESS,
      label: "Walter CRM",
      authType: "api_key",
      secret: { apiKey: "crm_FAKE_key_1234", headers: { "X-Fake-Team": "fake-team" } },
      owner: walter.id,
    });
    await f.db.insert(schema.customTools).values({
      orgId: f.org.id,
      connectionId: connection.id,
      name: "list_deals",
      access: "read",
      suggestedAccess: "read",
    });
    return { walter, bia, crm: connection };
  }

  test("only its person lists it whole; who manages connectors gets a bare row only when asking; others nothing", async () => {
    const { walter, bia, crm } = await walterWithCrm();
    const [his] = await listCustomServers(f.db, walter.id, f.org.id);
    expect(his).toMatchObject({ id: crm.id, serverUrl: ADDRESS, headerNames: ["X-Fake-Team"] });
    expect(his?.tools.map((t) => t.name)).toEqual(["list_deals"]);
    expect(await listCustomServers(f.db, bia.id, f.org.id, { others: true })).toEqual([]);
    expect(await listCustomServers(f.db, f.owner.id, f.org.id)).toEqual([]);
    const bare = await listCustomServers(f.db, f.owner.id, f.org.id, { others: true });
    expect(bare).toEqual([
      expect.objectContaining({ id: crm.id, serverUrl: "", headerNames: [], tools: [], accountLabel: null }),
    ]);
    expect(JSON.stringify(bare)).not.toContain("fake-");
  });

  test("the audit log keeps its address and account from anyone but its person, reconnected too", async () => {
    const { walter, crm } = await walterWithCrm();
    await storeCustomConnection(depsOf(f), {
      orgId: f.org.id,
      actorId: walter.id,
      serverUrl: ADDRESS,
      label: "Walter CRM",
      authType: "api_key",
      secret: { apiKey: "crm_FAKE_key_5678", headers: { "X-Fake-Team": "fake-team" } },
      connectionId: crm.id,
      owner: walter.id,
    });
    const rows = (await listAudit(f.db, f.owner.id, f.org.id)).rows;
    for (const action of ["connector.custom_connected", "connector.custom_reconnected"]) {
      const row = rows.find((r) => r.action === action);
      expect(row?.details).toMatchObject({ label: "Walter CRM", serverUrl: "", account: null, personal: true });
    }
  });

  test("a name that kept its account goes by the service alone for anyone but its person", async () => {
    const { walter, mine } = await walterWithLinear();
    const { connection } = await storeCustomConnection(depsOf(f), {
      orgId: f.org.id,
      actorId: walter.id,
      serverUrl: "https://crm.example.com/mcp",
      label: "CRM",
      authType: "oauth",
      secret: null,
      composio: { accountId: "ca_FAKE_walter_crm", name: "walter@example.com" },
      owner: walter.id,
    });
    expect(connection.label).toBe("CRM (walter@example.com)");
    const [bare] = await listCustomServers(f.db, f.owner.id, f.org.id, { others: true });
    expect(bare).toMatchObject({ id: connection.id, label: "CRM", serverUrl: "", accountLabel: null });
    const [row] = (await listAudit(f.db, f.owner.id, f.org.id)).rows.filter(
      (r) => r.action === "connector.custom_connected",
    );
    expect(row?.details).toMatchObject({ label: "CRM", serverUrl: "", account: null, personal: true });
    // A catalog connection's default name holds its account too.
    await f.db
      .update(schema.connectorConnections)
      .set({ label: "Linear (walter@example.com)", accountLabel: "walter@example.com" })
      .where(eq(schema.connectorConnections.connector, "linear"));
    const viewed = (await listConnections(f.db, f.owner.id, f.org.id, { others: true })).map((c) =>
      connectionViewFor(c, f.owner.id),
    );
    expect(viewed.map((c) => c.label)).toContain("Linear");
    expect(JSON.stringify(viewed)).not.toContain("walter@example.com");
    const tree = await getAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, { others: true });
    expect(JSON.stringify(tree)).not.toContain("walter@example.com");
    // Its person still reads the whole name.
    const [his] = await listCustomServers(f.db, walter.id, f.org.id);
    expect(his?.label).toBe("CRM (walter@example.com)");
    // Every audit line about one: its grants at connect, taken off an agent, removed, a rename's "from".
    await takeConnectionOffAgent(f.db, f.owner.id, f.org.id, connection.id, f.agent.id);
    await revokeConnection(f.db, f.owner.id, f.org.id, mine.id);
    await renameConnection(f.db, walter.id, f.org.id, connection.id, "Sales CRM");
    const lines = (await listAudit(f.db, f.owner.id, f.org.id)).rows;
    expect(lines.map((r) => r.action)).toEqual(
      expect.arrayContaining(["agent.access_changed", "connector.renamed", "connector.disconnected"]),
    );
    expect(JSON.stringify(lines)).not.toContain("walter@example.com");
  });

  test("accepting its suggestions offers only its person's own agents", async () => {
    const { walter, crm } = await walterWithCrm();
    await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.connectionId, crm.id));
    const { agentsWithoutAccess } = await acceptCustomSuggestion(depsOf(f), walter.id, f.org.id, crm.id);
    expect(agentsWithoutAccess.map((a) => a.id)).toEqual([f.agent.id]);
  });

  test("Reconectar finds only its person's own", async () => {
    const { walter, bia, crm } = await walterWithCrm();
    await expect(reconnectTarget(f.db, f.org.id, crm.id, ADDRESS, null)).rejects.toBeInstanceOf(NotFoundError);
    await expect(reconnectTarget(f.db, f.org.id, crm.id, ADDRESS, bia.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await reconnectTarget(f.db, f.org.id, crm.id, ADDRESS, walter.id)).id).toBe(crm.id);
  });
});

describe("what the team's paths never name nor hand out", () => {
  test("cards, offers, prompts and the router's labels leave it out", async () => {
    const { walter, ops, mine } = await walterWithLinear();
    await renameConnection(f.db, walter.id, f.org.id, mine.id, "Walter Linear");
    expect((await resolveApps(f.db, f.org.id, ["Walter Linear", "linear"])).unknown).toEqual([
      "Walter Linear",
      "linear",
    ]);
    // Asked by its person, the names are still not given, and the refusal can say why; asked by anyone else, nothing
    // says the connection exists.
    const byWalter = await resolveApps(f.db, f.org.id, ["Walter Linear", `connector:${mine.id}`], walter.id);
    expect(byWalter.found.size).toBe(0);
    expect(byWalter.personal).toEqual(["Walter Linear", `connector:${mine.id}`]);
    expect(byWalter.choices.join()).not.toContain(mine.id);
    expect((await resolveApps(f.db, f.org.id, ["Walter Linear"], f.owner.id)).personal).toEqual([]);
    expect(await pendingConnectors(f.db, f.org.id, new Set())).toEqual([]);
    const missing = await missingPermissions({ db: f.db, orgId: f.org.id, agentId: ops.id });
    expect(missing.map((m) => m.connectionId)).not.toContain(mine.id);
    // propose_agent tells the agent what it may name; an unknown channel makes it say all of it.
    await expect(
      checkAgentDraft(
        { db: f.db },
        { orgId: f.org.id, channelId: f.general.id, personId: f.owner.id },
        { name: "Helper", handle: "helper", instructions: "Help", channels: ["nowhere"] },
      ),
    ).rejects.toThrow(/Connected apps: none\./);

    await f.db.insert(schema.agentScopes).values({ orgId: f.org.id, agentId: ops.id, connectionId: null, scope: "*" });
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ops.id });
    let seen: RoutingInput | null = null;
    const strategy = {
      name: "capture",
      decide: async (input: RoutingInput) => {
        seen = input;
        return { agents: [] };
      },
    };
    const message = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "who can look at the board?",
    });
    const routed = await routeMessage(
      { db: f.db, strategy, policy: { ...DEFAULT_ROUTER_POLICY, maxHops: 3 } },
      { orgId: f.org.id, messageId: message.id },
    );
    if (!seen) throw new Error(`the router was not asked: ${JSON.stringify(routed)}`);
    expect(JSON.stringify((seen as RoutingInput).candidates)).not.toContain("Walter Linear");
  });

  test("nobody else grants it on an agent, and a new agent with every app doesn't get it", async () => {
    const { walter, mine, ops } = await walterWithLinear();
    await expect(
      setAgentScopes(f.db, f.owner.id, f.org.id, ops.id, [{ connectionId: mine.id, scope: "connector:*" }]),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { mode: "personal" });
    const fresh = await createAgent(f.db, f.owner.id, f.org.id, { name: "Fresh", handle: "fresh" }, NEW_AGENT_DEFAULTS);
    const grants = await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.agentId, fresh.id));
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.map((g) => g.connectionId)).not.toContain(mine.id);
    // An agent made in its person's name holds it at once (a known limit of the decision record).
    const his = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Helper", handle: "helper", ownerUserId: walter.id },
      NEW_AGENT_DEFAULTS,
    );
    const held = await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.agentId, his.id));
    expect(held.map((g) => g.connectionId)).toContain(mine.id);
  });

  test("a person's own connections go with their account; only its member person's routines take its events", async () => {
    const { walter, mine } = await walterWithLinear();
    const plan = await accountDeletionPlan(f.db, walter.id);
    expect(plan.staysBehind.filter((s) => s.kind === "connection")).toEqual([]);
    expect(await creatorMayUse(f.db, f.org.id, walter.id, walter.id)).toBe(true);
    // Their membership gone (without the revoke that leaving does), nothing of theirs serves a routine.
    await f.db
      .delete(schema.organizationMembers)
      .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, walter.id)));
    expect(mine.ownerUserId).toBe(walter.id);
    expect(await creatorMayUse(f.db, f.org.id, walter.id, walter.id)).toBe(false);
  });
});

describe("outside collaborators and the operator's reveal door", () => {
  test("an outside collaborator gets what a member gets of one: their own serves them, someone else's nothing", async () => {
    const { walter, bia, source } = await walterWithLinear();
    await f.db
      .update(schema.organizationMembers)
      .set({ outsideOf: "Example Consulting" })
      .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, bia.id)));
    expect(await names(source, await runOf(f.agent.id, bia.id))).toEqual([]);
    expect(await listConnections(f.db, bia.id, f.org.id, { others: true })).toEqual([]);
    expect(await names(source, await runOf(f.agent.id, walter.id))).toContain("linear_create_issue");
    // The operator ending their access takes their own connection, as leaving does.
    const own = await createApiKeyConnection(depsOf(f), bia.id, f.org.id, {
      connector: "sentry",
      apiKey: "sntrys_FAKE_bia_1234",
      personal: true,
    });
    expect(await endOutsideAccess({ db: f.db, pubsub: f.pubsub }, f.org.id, bia.id)).toMatchObject({ removed: true });
    const [row] = await f.db
      .select()
      .from(schema.connectorConnections)
      .where(eq(schema.connectorConnections.id, own.id));
    expect(row?.revokedAt).not.toBeNull();
  });

  test("another member's request for help opens nothing of a person's connection nor of a call in it", async () => {
    const { walter, bia, mine, source } = await walterWithLinear();
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: walter.id });
    await f.db
      .update(schema.connectorConnections)
      .set({ label: "Linear (walter@example.com)", lastError: "walter@example.com: token expired" })
      .where(eq(schema.connectorConnections.id, mine.id));
    const ctx = await runOf(f.agent.id, walter.id);
    const input = { title: "Salary review for Bia" };
    await createToolGateway({ sources: [source] }).invoke(ctx, { toolUseId: "t1", name: "linear_create_issue", input });
    await f.db.insert(schema.agentRunSteps).values({
      orgId: f.org.id,
      runId: ctx.runId,
      seq: 901,
      kind: "tool_call",
      data: { toolUseId: "t1", name: "linear_create_issue", input },
    });
    const read = async (who: string, kind: "connection" | "run_step", field: string) => {
      const requestId = await recordSupportRequest(f.db, {
        orgId: f.org.id,
        userId: who,
        source: "form",
        keepWords: false,
      });
      return operatorReveal(f.db, f.org.id, {
        kind,
        id: kind === "connection" ? mine.id : ctx.runId,
        ...(kind === "run_step" ? { seq: 901 } : {}),
        field,
        offset: 0,
        limit: 200,
        purpose: "member_request",
        reason: "The member says this keeps failing for them",
        operator: "Ops on call",
        assistedByAi: false,
        requestId,
      });
    };
    for (const [kind, field] of [
      ["connection", "label"],
      ["connection", "last_error"],
      ["run_step", "input"],
    ] as const) {
      await expect(read(bia.id, kind, field)).rejects.toMatchObject({ code: "reveal.not_visible" });
      await expect(read(f.owner.id, kind, field)).rejects.toMatchObject({ code: "reveal.not_visible" });
    }
    expect((await read(walter.id, "connection", "label")).text).toBe("Linear (walter@example.com)");
    expect((await read(walter.id, "run_step", "input")).text).toContain("Salary review");
  });
});

describe("what a call and a card of it leave for others", () => {
  const ACCOUNT = "walter@example.com";

  /** Walter's own CRM and the team's Helpdesk, both by address, both writable by `@dev`, which answers everyone. */
  async function crmAndHelpdesk() {
    const { walter, bia } = await walterWithLinear();
    await f.db.update(schema.agents).set({ audienceMode: "everyone" }).where(eq(schema.agents.id, f.agent.id));
    const store = async (label: string, serverUrl: string, owner: string | null, actorId: string, tool: string) => {
      const { connection } = await storeCustomConnection(depsOf(f), {
        orgId: f.org.id,
        actorId,
        serverUrl,
        label,
        authType: "api_key",
        secret: { apiKey: "FAKE_key_1234", headers: {} },
        owner,
      });
      await f.db.insert(schema.customTools).values({
        orgId: f.org.id,
        connectionId: connection.id,
        name: tool,
        access: "write",
        suggestedAccess: "write",
      });
      await f.db
        .insert(schema.agentScopes)
        .values({ orgId: f.org.id, agentId: f.agent.id, connectionId: connection.id, scope: "connector:*" })
        .onConflictDoNothing();
      return connection;
    };
    const crm = await store("CRM", "https://crm.example.com/mcp", walter.id, walter.id, "add_note");
    const desk = await store("Helpdesk", "https://desk.example.com/mcp", null, f.owner.id, "send_reply");
    const calls: string[] = [];
    const connect: McpConnect = async (connection) => {
      const tool = connection.serverUrl.includes("crm.") ? "add_note" : "send_reply";
      const server = new McpServer({ name: `fake-${tool}`, version: "1" });
      server.registerTool(
        tool,
        { description: "Write about a contact", inputSchema: { email: z.string(), title: z.string() } },
        async () => {
          calls.push(tool);
          return { content: [{ type: "text", text: "ok" }] };
        },
      );
      const [client, transport] = InMemoryTransport.createLinkedPair();
      await server.connect(transport);
      return mcpSessionOver(client);
    };
    const source = createConnectorToolSource({ ...depsOf(f), connect });
    return { walter, bia, crm, desk, calls, gateway: createToolGateway({ sources: [source] }) };
  }

  const dmRun = async (who: string) =>
    runOf(f.agent.id, who, (await openPersonAgentDm(f.db, f.org.id, who, f.agent.id)).id);

  test("a write in a person's own connection is no team action: another's run on the same target hears nothing of it", async () => {
    const { walter, bia, crm, desk, calls, gateway } = await crmAndHelpdesk();
    const his = await dmRun(walter.id);
    const input = { email: "carol@example.com", title: "Offer of 120k for Carol" };
    await gateway.invoke(his, { toolUseId: "t1", name: `${crm.toolPrefix}_add_note`, input });
    expect(calls).toEqual(["add_note"]);
    const hers = await dmRun(bia.id);
    const said = await gateway.invoke(hers, {
      toolUseId: "t2",
      name: `${desk.toolPrefix}_send_reply`,
      input: { email: "carol@example.com", title: "Hello Carol" },
    });
    expect(calls).toEqual(["add_note", "send_reply"]);
    expect(JSON.stringify(said)).not.toContain("120k");
    expect(JSON.stringify(await runChecksForReply(f.db, f.org.id, hers.runId))).not.toContain("120k");
    expect((await f.db.select().from(schema.teamActions)).map((a) => a.tool)).toEqual([
      `${desk.toolPrefix}_send_reply`,
    ]);
  });

  test("a numbered default name keeps its number and loses its account for others", async () => {
    f = await setup();
    expect(othersLabel(`CRM (${ACCOUNT})`, ACCOUNT)).toBe("CRM");
    expect(othersLabel(`CRM (${ACCOUNT}) 2`, ACCOUNT)).toBe("CRM 2");
    expect(othersLabel(`CRM (${ACCOUNT}) 13`, ACCOUNT)).toBe("CRM 13");
    expect(othersLabel("CRM 2", ACCOUNT)).toBe("CRM 2");
    // An account's name with brackets of its own, and one the provider renamed since the name was made.
    expect(othersLabel("Stripe (Example Ltd (Brazil))", "Example Ltd (Brazil)")).toBe("Stripe");
    expect(othersLabel("Stripe (Example Ltd (Brazil)) 2", "Example Ltd (Brazil)")).toBe("Stripe 2");
    expect(othersLabel("CRM (old@example.com)", "new@example.com")).toBe("CRM");
    // Not the default form: nothing in the brackets, words after them, no brackets at all, no account yet.
    for (const kept of ["CRM", "CRM ()", "CRM (x) 2 3", "CRM (x) team", "(x) CRM"])
      expect(othersLabel(kept, ACCOUNT)).toBe(kept);
    expect(othersLabel(`CRM (${ACCOUNT})`, null)).toBe(`CRM (${ACCOUNT})`);
    // A name made to be slow to read is read once, by position.
    const slow = `a (${"a (a".repeat(20_000)}`;
    expect(othersLabel(slow, ACCOUNT)).toBe(slow);
    expect(othersLabel(`${slow})`, ACCOUNT)).toBe("a");
    expect(auditLabel({ label: `CRM (${ACCOUNT}) 2`, accountLabel: ACCOUNT, ownerUserId: "u1" })).toBe("CRM 2");
    expect(auditLabel({ label: `CRM (${ACCOUNT}) 2`, accountLabel: ACCOUNT, ownerUserId: null })).toBe(
      `CRM (${ACCOUNT}) 2`,
    );
  });

  test("a decided card's audit line names the connection as others read it; its person's card keeps the whole name", async () => {
    const { walter, crm, gateway } = await crmAndHelpdesk();
    await f.db
      .update(schema.connectorConnections)
      .set({ label: `CRM (${ACCOUNT})`, accountLabel: ACCOUNT })
      .where(eq(schema.connectorConnections.id, crm.id));
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { approvalsLevel: "always" });
    const deps = { db: f.db, pubsub: f.pubsub };
    const ctx = await dmRun(walter.id);
    const card = async (n: number) => {
      const asked = await gateway.invoke(ctx, {
        toolUseId: `t${n}`,
        name: `${crm.toolPrefix}_add_note`,
        input: { email: `c${n}@example.com`, title: `Note ${n}`, why: "Walter asked me to note this in his own CRM." },
      });
      if (asked.type !== "approval") throw new Error(`expected a card, got ${asked.type}`);
      // Stored as others read it; its person's own list gives it whole.
      expect(asked.approval.title).toStartWith("CRM: ");
      const [his] = (await listApprovals(f.db, walter.id, f.org.id)).filter((a) => a.id === asked.approval.id);
      expect(his?.title).toStartWith(`CRM (${ACCOUNT}): `);
      return asked.approval.id;
    };
    const first = await card(1);
    await decideApproval(deps, walter.id, f.org.id, first, { decision: "approve" });
    const [approved] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, first));
    if (!approved) throw new Error("no approval row");
    await gateway.executeApproved(ctx, approved);
    // What it then did is no team action either.
    expect(await f.db.select().from(schema.teamActions)).toEqual([]);
    await decideApproval(deps, walter.id, f.org.id, await card(2), { decision: "refuse" });
    const third = await card(3);
    await f.db
      .update(schema.approvals)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.approvals.id, third));
    await expireApprovals(deps);
    await card(4);
    // Renamed while a card waits: the card's title holds the old name.
    const fifth = await card(5);
    await renameConnection(f.db, walter.id, f.org.id, crm.id, "Work CRM");
    await decideApproval(deps, walter.id, f.org.id, fifth, { decision: "refuse" });
    await removeMember(f.db, f.owner.id, f.org.id, walter.id);
    const lines = (await listAudit(f.db, f.owner.id, f.org.id)).rows.filter((r) => r.action.startsWith("approval."));
    expect([...new Set(lines.map((r) => r.action))].sort()).toEqual([
      "approval.approved",
      "approval.canceled",
      "approval.expired",
      "approval.refused",
    ]);
    // Anyone but its person reads the connection's name and the agent only.
    for (const r of lines) expect(Object.keys(r.details).sort()).toEqual(["agentId", "label"]);
    for (const r of lines) expect(String(r.details.label)).toMatch(/^(CRM|Work CRM)$/);
    expect(lines.filter((r) => r.details.label === "Work CRM")).toHaveLength(2);
    expect(JSON.stringify(lines)).not.toContain(ACCOUNT);
  });

  test("after a teammate joins, the note names the service alone, and only for a tool this agent holds (a denial is no hold)", async () => {
    const { walter, bia, ops, mine, source } = await walterWithLinear();
    await f.db
      .update(schema.connectorConnections)
      .set({ label: `Linear (${ACCOUNT})`, accountLabel: ACCOUNT })
      .where(eq(schema.connectorConnections.id, mine.id));
    await f.db.update(schema.agents).set({ audienceMode: "everyone" }).where(eq(schema.agents.id, f.agent.id));
    for (const u of [walter, bia]) await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: u.id });
    const post = (userId: string, body: string) =>
      insertMessageWithRuns(
        f.db,
        { orgId: f.org.id, channelId: f.general.id, author: { type: "person", userId }, body },
        { startRuns: true },
      );
    const asked = await post(walter.id, "@dev my issues");
    const run = asked.runs[0];
    if (!run) throw new Error("no run");
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: f.general.id,
      threadRootId: asked.message.id,
      triggerMessageId: asked.message.id,
    };
    await post(bia.id, "@dev paste his");
    const gateway = createToolGateway({ sources: [source] });
    const note = await gateway.invoke(ctx, { toolUseId: "t1", name: "linear_list_issues", input: {} });
    const text = (r: Awaited<ReturnType<typeof gateway.invoke>>) => (r.type === "result" ? `${r.output.content}` : "");
    expect(text(note)).toContain("stopped being available");
    expect(text(note)).toStartWith("Linear is the own connection");
    expect(text(note)).not.toContain(ACCOUNT);
    // Held by another agent, not this one.
    await f.db
      .update(schema.agentScopes)
      .set({ agentId: ops.id })
      .where(and(eq(schema.agentScopes.connectionId, mine.id), eq(schema.agentScopes.agentId, f.agent.id)));
    const unknown = text(await gateway.invoke(ctx, { toolUseId: "t2", name: "linear_list_issues", input: {} }));
    expect(unknown).not.toContain("stopped being available");
    expect(unknown).toContain("Unknown tool");
    // A denial alone is no grant.
    await f.db
      .insert(schema.agentScopes)
      .values({ orgId: f.org.id, agentId: f.agent.id, connectionId: mine.id, scope: "deny:linear_list_issues" });
    const denied = text(await gateway.invoke(ctx, { toolUseId: "t3", name: "linear_list_issues", input: {} }));
    expect(denied).not.toContain("stopped being available");
  });
});
