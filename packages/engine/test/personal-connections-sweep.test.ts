import { afterEach, describe, expect, test } from "bun:test";
import { orgTopic } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addChannelMember,
  agentScopeNames,
  agentStatuses,
  commentIssue,
  connectionViewFor,
  createAgentRuns,
  createChannel,
  createConnectorToolSource,
  createContextToolSource,
  createDashboard,
  createIssue,
  createScheduleToolSource,
  createToolGateway,
  DEFAULT_ROUTER_POLICY,
  DIRECTORY_MAX_TOOLS,
  decideApproval,
  drainOutbox,
  executeRoutineRun,
  followWork,
  getAgentAccess,
  getIssueDetail,
  getRun,
  getWidget,
  insertMessage,
  insertWidget,
  invokeWithChip,
  listApprovals,
  listAudit,
  listConnections,
  listCustomServers,
  listIssues,
  listMessages,
  listNotifications,
  listRoutines,
  listRuns,
  type McpConnect,
  managedWebhookRoutine,
  mcpSessionOver,
  openPersonAgentDm,
  postPersonMessage,
  presentTools,
  publishApproval,
  queueRoutineRun,
  type RoutingInput,
  removeApprovalRule,
  renameConnection,
  routeMessage,
  runWhere,
  saveCustomTools,
  seedToolPins,
  setAgentAccess,
  statusCandidates,
  storeCustomConnection,
  type ToolContext,
  type ToolSource,
  taskManager,
  taskSteps,
  updateRoutine,
} from "../src";
import { addMember, type Fixture, makeAdmin, setup } from "./fixtures";
import { routineDeps, routineRow, routineRunRow } from "./routine-fixtures";

const ACCOUNT = "walter@example.com";
const WHOLE = `CRM (${ACCOUNT})`;

let f: Fixture;
afterEach(() => f?.close());

const depsOf = () => ({ db: f.db, keyWrappers: [f.keyWrapper], publicUrl: "https://chat.example.com" });

/**
 * Walter's own CRM, "CRM (walter@example.com)", on `@dev` (his agent, which answers everyone): a write that runs and
 * a removal that asks. He uses it in his own DM (a full run), in a private channel he shares with Bia (a full run and
 * a card) and from a routine of his. Caio is a plain member in none of those conversations.
 */
async function walterUsedHisCrm() {
  let real: ToolSource | null = null;
  const crmTools: ToolSource = { name: "connectors", tools: (ctx) => (real ? real.tools(ctx) : Promise.resolve([])) };
  let prefix = "";
  f = await setup({
    toolSources: [crmTools],
    reply: (request) => {
      const last = JSON.stringify(request.messages.at(-1)?.content ?? "");
      if (last.includes("tool_result") || !prefix) return { chunks: ["Noted."] };
      return {
        chunks: [],
        toolUses: [{ name: `${prefix}_add_note`, input: { email: "carol@example.com", title: "Call back" } }],
      };
    },
  });
  const walter = await addMember(f.db, f.org.id, "member", "walter");
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: walter.id, audienceMode: "everyone" })
    .where(eq(schema.agents.id, f.agent.id));
  const { connection: crm } = await storeCustomConnection(depsOf(), {
    orgId: f.org.id,
    actorId: walter.id,
    serverUrl: "https://crm.example.com/mcp",
    label: "CRM",
    authType: "api_key",
    secret: { apiKey: "FAKE_key_1234", headers: {} },
    owner: walter.id,
  });
  await f.db
    .update(schema.connectorConnections)
    .set({ label: WHOLE, accountLabel: ACCOUNT })
    .where(eq(schema.connectorConnections.id, crm.id));
  for (const [name, access] of [
    ["add_note", "write"],
    ["remove_note", "approval"],
  ] as const)
    await f.db
      .insert(schema.customTools)
      .values({ orgId: f.org.id, connectionId: crm.id, name, access, suggestedAccess: access });
  // His own save of the agent's access: the line names his tools apart.
  await setAgentAccess(f.db, walter.id, f.org.id, f.agent.id, {
    all: false,
    scopes: [],
    connectors: { [crm.id]: true },
    tools: { allow: [{ connectionId: crm.id, name: `${crm.toolPrefix}_add_note` }], deny: [] },
  });
  const connect: McpConnect = async () => {
    const server = new McpServer({ name: "fake-crm", version: "1" });
    for (const name of ["add_note", "remove_note"])
      server.registerTool(
        name,
        { description: `${name} for a contact`, inputSchema: { email: z.string(), title: z.string() } },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      );
    const [client, transport] = InMemoryTransport.createLinkedPair();
    await server.connect(transport);
    return mcpSessionOver(client);
  };
  real = createConnectorToolSource({ ...depsOf(), connect });
  prefix = crm.toolPrefix ?? "";
  // Pinned as its person reviewed them; the server has changed its words since.
  await seedToolPins(
    f.db,
    crm,
    ["add_note", "remove_note"].map((name) => ({ name, description: `Old ${name}`, inputSchema: { type: "object" } })),
  );
  // The person's own review of its tools, as the Conectores screen saves it.
  await saveCustomTools(depsOf(), walter.id, f.org.id, crm.id, {
    label: WHOLE,
    tools: [
      { name: "add_note", access: "write", label: "Add note" },
      { name: "remove_note", access: "approval", label: "Remove note" },
    ],
  });

  const deals = await createChannel(f.db, f.owner.id, f.org.id, { name: "deals", visibility: "private" });
  for (const userId of [walter.id, bia.id]) await addChannelMember(f.db, f.owner.id, f.org.id, deals.id, { userId });
  await addChannelMember(f.db, f.owner.id, f.org.id, deals.id, { agentId: f.agent.id });
  const dm = await openPersonAgentDm(f.db, f.org.id, walter.id, f.agent.id);
  const chips = [...f.listen(deals.id), ...f.listen(dm.id)];
  const dealsEvents = f.listen(deals.id);

  // In his own DM, then in the channel he shares with Bia: full runs.
  const deps = { db: f.db, pubsub: f.pubsub };
  await postPersonMessage(deps, walter.id, f.org.id, dm.id, { body: "Note that Carol wants a call back" });
  await drainOutbox(f.db, f.handlers);
  await postPersonMessage(deps, walter.id, f.org.id, deals.id, { body: "@dev note that Carol wants a call back" });
  await drainOutbox(f.db, f.handlers);

  // A card in the shared channel, from a run he asked there.
  const asked = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: deals.id,
    author: { type: "person", userId: walter.id },
    body: "@dev remove that note",
  });
  const [cardRun] = await f.db.transaction((tx) => createAgentRuns(tx, asked, [f.agent.id], "mention"));
  if (!cardRun) throw new Error("no run");
  const cardCtx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: cardRun.id,
    channelId: deals.id,
    threadRootId: asked.id,
    triggerMessageId: asked.id,
  };
  const gateway = f.tools;
  if (!gateway) throw new Error("no gateway");
  const card = await gateway.invoke(cardCtx, {
    toolUseId: "card",
    name: `${prefix}_remove_note`,
    input: {
      email: "carol@example.com",
      title: "Call back",
      why: "Walter asked me to remove the call-back note about Carol in his own CRM.",
    },
  });
  if (card.type !== "approval") throw new Error(`expected a card, got ${JSON.stringify(card)}`);
  await publishApproval(deps, card.approval, "approval.created");

  // A routine of his, still at work: background, long.
  const brief = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: dm.id,
    author: { type: "person", userId: walter.id },
    body: "Weekly CRM notes",
    meta: {
      routineBrief: {
        routineId: crypto.randomUUID(),
        routineRunId: crypto.randomUUID(),
        name: "Weekly notes",
        creatorUserId: walter.id,
        deliverTo: { channelId: dm.id, threadId: null },
        access: "act",
        report: "when_new",
        trigger: "schedule",
        dueAt: new Date().toISOString(),
      },
      background: true,
    },
  });
  const [routineRun] = await f.db.transaction((tx) =>
    createAgentRuns(tx, brief, [f.agent.id], "mention", { background: true }),
  );
  if (!routineRun) throw new Error("no routine run");
  const longAgo = new Date(Date.now() - 10 * 60_000);
  await f.db
    .update(schema.agentRuns)
    .set({ status: "running", startedAt: longAgo, heartbeatAt: new Date() })
    .where(eq(schema.agentRuns.id, routineRun.id));
  const routineCtx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: routineRun.id,
    channelId: dm.id,
    threadRootId: brief.id,
    triggerMessageId: brief.id,
  };
  const held = await crmTools.tools(routineCtx);
  const addNote = held.find((t) => t.name === `${prefix}_add_note`);
  if (!addNote) throw new Error(`the routine doesn't hold his tool: ${held.map((t) => t.name).join(", ")}`);
  await gateway.invoke(routineCtx, {
    toolUseId: "weekly",
    name: addNote.name,
    input: { email: "carol@example.com", title: "Weekly" },
  });
  await followWork({ db: f.db, pubsub: f.pubsub }, routineCtx, addNote, new Date());
  const [routineRow] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, routineRun.id));
  if (!routineRow) throw new Error("no routine row");
  const candidates = await statusCandidates(f.db, routineRow, held);

  const runIds = (await f.db.select({ id: schema.agentRuns.id }).from(schema.agentRuns)).map((r) => r.id);
  return {
    walter,
    bia,
    caio,
    crm,
    deals,
    dm,
    chips,
    dealsEvents,
    runIds,
    candidates,
    addNote,
    cardId: card.approval.id,
  };
}

/** Everything `userId` reads through the engine's own readers, as one text; a refusal reads as nothing. */
async function readAs(userId: string, s: Awaited<ReturnType<typeof walterUsedHisCrm>>) {
  const read = async (what: () => Promise<unknown>) => {
    try {
      return await what();
    } catch {
      return null;
    }
  };
  const tasks = await read(() => taskManager(f.db, userId, f.org.id));
  const out: Record<string, unknown> = {
    statuses: await read(() => agentStatuses(f.db, userId, f.org.id)),
    tasks,
    steps: await Promise.all(s.runIds.map((id) => read(() => taskSteps(f.db, userId, f.org.id, id)))),
    runs: await read(() => listRuns(f.db, userId, f.org.id, { agentId: f.agent.id })),
    traces: await Promise.all(s.runIds.map((id) => read(() => getRun(f.db, userId, f.org.id, id)))),
    audit: await read(() => listAudit(f.db, userId, f.org.id)),
    approvals: await read(() => listApprovals(f.db, userId, f.org.id)),
    notifications: await read(() => listNotifications({ db: f.db }, userId, f.org.id)),
    deals: await read(() => listMessages(f.db, userId, f.org.id, s.deals.id, { includeReplies: true })),
    dm: await read(() => listMessages(f.db, userId, f.org.id, s.dm.id, { includeReplies: true })),
    connections: await read(async () =>
      (await listConnections(f.db, userId, f.org.id, { others: true })).map((c) => connectionViewFor(c, userId)),
    ),
    servers: await read(() => listCustomServers(f.db, userId, f.org.id, { others: true })),
    agentPage: await read(() => getAgentAccess(f.db, userId, f.org.id, f.agent.id, { others: true })),
  };
  return JSON.stringify(out);
}

describe("what a person's own connection leaves for everyone else", () => {
  test("no reader gives its account to anyone but its person, and nothing of it to a member outside its conversations", async () => {
    const s = await walterUsedHisCrm();
    // The calls happened, in all three places, and their traces exist.
    const steps = await f.db
      .select()
      .from(schema.agentRunSteps)
      .where(and(eq(schema.agentRunSteps.kind, "tool_call")));
    const calls = steps.filter((r) => String(r.data.name).endsWith("_add_note"));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    // The gateway marks each call in his own connection as his: the readers below go by that mark.
    for (const call of calls) expect(call.data.personal).toBe(true);
    // What everyone who may talk to the agent reads of its work.
    expect(JSON.stringify(s.candidates)).not.toContain("CRM");
    expect(JSON.stringify(s.chips)).not.toContain(ACCOUNT);

    const bia = await readAs(s.bia.id, s);
    const owner = await readAs(f.owner.id, s);
    const caio = await readAs(s.caio.id, s);
    for (const seen of [bia, owner, caio]) expect(seen).not.toContain(ACCOUNT);
    expect(caio.toLowerCase()).not.toContain("crm");
    // Bia reads the shared channel, where he asked: its service by name, no more.
    expect(bia).toContain("CRM");
    // Not trivially empty: the workspace's owner reads the routine's task, now on his tool, and the audit's calls.
    expect(owner).toContain('"tool.call"');
    expect(owner).toContain('"connector":"CRM"');
  });

  test("its person reads it whole on their own rows and their own card", async () => {
    const s = await walterUsedHisCrm();
    expect((await listCustomServers(f.db, s.walter.id, f.org.id)).find((r) => r.id === s.crm.id)?.label).toBe(WHOLE);
    const [his] = (await listApprovals(f.db, s.walter.id, f.org.id)).filter((a) => a.id === s.cardId);
    expect(his?.title).toBe(`${WHOLE}: Remove note`);
    const [hers] = (await listApprovals(f.db, s.bia.id, f.org.id)).filter((a) => a.id === s.cardId);
    expect(hers?.title).toBe("CRM: Remove note");
    expect(JSON.stringify(s.dealsEvents)).not.toContain(ACCOUNT);
    // What leaves the run carries the name others read, also to him.
    expect(s.addNote.connectorLabel).toBe("CRM");
  });

  test("every audit line about it keeps its tools and account for its person alone", async () => {
    const s = await walterUsedHisCrm();
    await renameConnection(f.db, s.walter.id, f.org.id, s.crm.id, `Work CRM (${ACCOUNT})`);
    const [rule] = await f.db
      .insert(schema.approvalRules)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        connectionId: s.crm.id,
        tool: `${s.crm.toolPrefix}_remove_note`,
        createdByUserId: s.walter.id,
      })
      .returning();
    if (!rule) throw new Error("no rule");
    await removeApprovalRule(f.db, s.walter.id, f.org.id, f.agent.id, rule.id);
    await decideApproval({ db: f.db, pubsub: f.pubsub }, s.walter.id, f.org.id, s.cardId, { decision: "refuse" });
    const ABOUT_IT = [
      "agent.access_changed",
      "agent.approval_rule_removed",
      "approval.refused",
      "connector.custom_tools_classified",
      "connector.renamed",
      "connector.tool_changed",
      "connector.tool_definitions_changed",
    ];
    const lines = async (userId: string) =>
      (await listAudit(f.db, userId, f.org.id, { limit: 200 })).rows.filter((r) => ABOUT_IT.includes(r.action));
    const owners = await lines(f.owner.id);
    expect([...new Set(owners.map((r) => r.action))].sort()).toEqual(ABOUT_IT);
    const seen = JSON.stringify(owners);
    expect(seen).not.toContain(ACCOUNT);
    expect(seen).not.toContain("_note");
    expect(seen).not.toContain("Old add_note");
    expect(owners.find((r) => r.action === "connector.renamed")?.details).toMatchObject({ to: "Work CRM" });
    expect(owners.find((r) => r.action === "connector.tool_definitions_changed")?.details).toEqual({
      connection: "CRM",
    });
    // Its person, once they may read the log, reads what they did with it.
    await makeAdmin(f.db, f.org.id, s.walter.id);
    const his = JSON.stringify(await lines(s.walter.id));
    for (const said of [`${s.crm.toolPrefix}_add_note`, "remove_note", "Old add_note"]) expect(his).toContain(said);
  });

  test("the router, whose reason the conversation reads, never names it", async () => {
    const s = await walterUsedHisCrm();
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
      channelId: s.deals.id,
      author: { type: "person", userId: s.bia.id },
      body: "who can look at the notes?",
    });
    await routeMessage(
      { db: f.db, strategy, policy: { ...DEFAULT_ROUTER_POLICY, maxHops: 3 } },
      { orgId: f.org.id, messageId: message.id },
    );
    if (!seen) throw new Error("the router was not asked");
    expect((seen as RoutingInput).candidates.map((c) => c.agentId)).toContain(f.agent.id);
    expect(JSON.stringify((seen as RoutingInput).candidates)).not.toContain("CRM");
  });

  test("the roster names none of its grants, and a routine's trigger on it keeps its filter and error for its readers", async () => {
    const s = await walterUsedHisCrm();
    const scopes = (await agentScopeNames(f.db, f.org.id, [f.agent.id])).map((r) => r.scope);
    expect(scopes.some((scope) => scope.startsWith(`${s.crm.connector}:`))).toBe(false);

    const [routine] = await f.db
      .insert(schema.routines)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        name: "Mail",
        prompt: "Read it",
        target: { type: "dm" },
        triggerType: "event",
        event: "webhook.received",
        createdByUserId: s.walter.id,
      })
      .returning();
    if (!routine) throw new Error("no routine");
    await f.db.insert(schema.routineHooks).values({
      routineId: routine.id,
      orgId: f.org.id,
      keyId: "k1",
      tokenHash: "h1",
      source: {
        connectionId: s.crm.id,
        event: "millionsend.email.received",
        filter: { from: ["boss@example.com"] },
        status: "error",
        lastError: `Refused for ${ACCOUNT}`,
      },
    });
    // The agent changes hands: its new owner manages the routine, as the workspace's owner does.
    const dora = await addMember(f.db, f.org.id, "member", "dora");
    await f.db.update(schema.agents).set({ ownerUserId: dora.id }).where(eq(schema.agents.id, f.agent.id));
    const triggerFor = async (userId: string) =>
      JSON.stringify((await listRoutines(f.db, userId, f.org.id)).find((r) => r.id === routine.id)?.trigger ?? null);
    for (const who of [s.bia.id, s.caio.id, f.owner.id, dora.id]) {
      const read = await triggerFor(who);
      expect(read).not.toContain(ACCOUNT);
      expect(read).not.toContain("boss@example.com");
      expect(read).not.toContain("Refused");
      // The service is read by who manages connectors (the workspace's owner) only: anyone else, a plain webhook's.
      if (who === f.owner.id) expect(read).toContain("millionsend.email.received");
      else expect(read.toLowerCase()).not.toContain("millionsend");
    }
    expect(await triggerFor(s.walter.id)).toContain(ACCOUNT);
    expect(await triggerFor(s.walter.id)).toContain("boss@example.com");
    // The agent's own list, in a run the workspace's owner asked in a shared channel: what the channel may hear.
    const listedFor = async (userId: string) => {
      const asked = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId },
        body: "@dev what are your routines?",
      });
      const [run] = await f.db.transaction((tx) => createAgentRuns(tx, asked, [f.agent.id], "mention"));
      if (!run) throw new Error("no run");
      const ctx: ToolContext = {
        db: f.db,
        orgId: f.org.id,
        agentId: f.agent.id,
        runId: run.id,
        channelId: f.general.id,
        threadRootId: asked.id,
        triggerMessageId: asked.id,
      };
      const tools = await createScheduleToolSource({ pubsub: f.pubsub, context: f.context }).tools(ctx);
      const list = tools.find((t) => t.name === "list_routines");
      return String((await list?.execute({ id: routine.id }, ctx))?.content ?? "");
    };
    const ownersRun = await listedFor(f.owner.id);
    expect(ownersRun).toContain("Mail");
    expect(ownersRun.toLowerCase()).not.toContain("millionsend");
    expect(await listedFor(s.walter.id)).toContain("MillionSend");
    // Only he changes what it waits for: anyone else would save it blank.
    for (const who of [f.owner.id, dora.id])
      await expect(
        updateRoutine(routineDeps(f), who, f.org.id, routine.id, { trigger: { type: "webhook", methods: ["POST"] } }),
      ).rejects.toMatchObject({ code: "routine.connector_not_yours" });
    // Its address fires his routine: nobody else gets it.
    for (const who of [f.owner.id, dora.id])
      await expect(managedWebhookRoutine(f.db, who, f.org.id, routine.id)).rejects.toMatchObject({
        code: "routine.connector_not_yours",
      });
  });

  test("a big connection behind its directory: no line, no listing, no service for anyone else", async () => {
    const s = await walterUsedHisCrm();
    const names = Array.from({ length: DIRECTORY_MAX_TOOLS + 5 }, (_, i) => `read_${i}`);
    await f.db.insert(schema.customTools).values(
      names.map((name) => ({
        orgId: f.org.id,
        connectionId: s.crm.id,
        name,
        access: "read" as const,
        suggestedAccess: "read" as const,
      })),
    );
    const many: McpConnect = async () => {
      const server = new McpServer({ name: "big-crm", version: "1" });
      for (const name of names)
        server.registerTool(
          name,
          { description: `Lists ${name} of a contact`, inputSchema: { q: z.string() } },
          async () => ({
            content: [{ type: "text", text: "ok" }],
          }),
        );
      const [client, transport] = InMemoryTransport.createLinkedPair();
      await server.connect(transport);
      return mcpSessionOver(client);
    };
    const source = createConnectorToolSource({ ...depsOf(), connect: many });
    const asked = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: s.dm.id,
      author: { type: "person", userId: s.walter.id },
      body: "find my notes",
    });
    const [run0] = await f.db.transaction((tx) => createAgentRuns(tx, asked, [f.agent.id], "mention"));
    if (!run0) throw new Error("no run");
    await f.db
      .update(schema.agentRuns)
      .set({ status: "running", startedAt: new Date(Date.now() - 180_000), heartbeatAt: new Date() })
      .where(eq(schema.agentRuns.id, run0.id));
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run0.id,
      channelId: s.dm.id,
      threadRootId: asked.id,
      triggerMessageId: asked.id,
    };
    const granted = await source.tools(ctx);
    const shown = presentTools(granted);
    const find = shown.find((t) => t.name.endsWith("_find_tools"));
    const use = shown.find((t) => t.name.endsWith("_use_tool"));
    expect(find?.ownerUserId).toBe(s.walter.id);
    expect(use?.ownerUserId).toBe(s.walter.id);
    // Tools on demand: their own search lists his tools too.
    expect(presentTools(granted, undefined, []).find((t) => t.name === "find_tools")?.ownerUserId).toBe(s.walter.id);
    if (!find || !use) throw new Error("no directory");
    const gateway = createToolGateway({ sources: [source] });
    const turn = { deps: { db: f.db, pubsub: f.pubsub }, tools: gateway, ctx, where: runWhere(run0), turnTools: shown };
    await invokeWithChip(turn, { id: "find", name: find.name, input: { query: "contact" } });
    await invokeWithChip(turn, { id: "nowhere", name: use.name, input: { tool: "no_such_tool", arguments: {} } });
    await new Promise((r) => setTimeout(r, 100));
    expect(JSON.stringify(await getRun(f.db, s.walter.id, f.org.id, run0.id))).toContain("Lists read_");
    const dora = await addMember(f.db, f.org.id, "member", "dora");
    await f.db.update(schema.agents).set({ ownerUserId: dora.id }).where(eq(schema.agents.id, f.agent.id));
    for (const who of [s.bia.id, s.caio.id, f.owner.id, dora.id]) {
      const line = JSON.stringify((await agentStatuses(f.db, who, f.org.id)).find((a) => a.agentId === f.agent.id));
      expect(line).not.toContain("CRM");
      const trace = JSON.stringify(await getRun(f.db, who, f.org.id, run0.id).catch(() => null));
      expect(trace).not.toContain("Lists read_");
      expect(trace).not.toContain(ACCOUNT);
    }
  });

  test("a workspace task his DM run worked on lists none of his own calls among its work steps", async () => {
    const s = await walterUsedHisCrm();
    const [dmRun] = await f.db
      .select({ id: schema.agentRuns.id })
      .from(schema.agentRuns)
      .innerJoin(schema.messages, eq(schema.messages.id, schema.agentRuns.triggerMessageId))
      .where(and(eq(schema.messages.channelId, s.dm.id), eq(schema.agentRuns.background, false)));
    if (!dmRun) throw new Error("no DM run");
    const dora = await addMember(f.db, f.org.id, "member", "dora");
    await f.db.update(schema.agents).set({ ownerUserId: dora.id }).where(eq(schema.agents.id, f.agent.id));
    const published: unknown[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => published.push(e));
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await createIssue(deps, { type: "person", userId: s.walter.id }, f.org.id, {
      title: "Follow up the leads",
      assignees: [{ type: "agent", id: f.agent.id }],
    });
    // The agent touches the task from his DM's run: the run becomes the task's work.
    await commentIssue(
      deps,
      { type: "agent", agentId: f.agent.id, channelId: s.dm.id, runId: dmRun.id },
      f.org.id,
      issue.id,
      "Done",
    );
    for (const who of [s.caio.id, f.owner.id, dora.id, s.walter.id]) {
      const actor = { type: "person" as const, userId: who };
      const detail = await getIssueDetail(f.db, actor, f.org.id, { id: issue.id });
      expect(detail.work?.runId).toBe(dmRun.id);
      const read = JSON.stringify([detail, await listIssues(f.db, actor, f.org.id)]);
      expect(read).not.toContain("_add_note");
      expect(read.toLowerCase()).not.toContain("crm");
    }
    expect(JSON.stringify(published)).not.toContain("_add_note");
  });

  test("another person's run never reads his own calls among the agent's earlier steps", async () => {
    const s = await walterUsedHisCrm();
    const asked = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: s.deals.id,
      author: { type: "person", userId: s.bia.id },
      body: "@dev how did you note Carol's call back?",
    });
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: s.deals.id,
      threadRootId: asked.id,
      triggerMessageId: asked.id,
    };
    const search = (await createContextToolSource(f.context).tools(ctx)).find((t) => t.name === "search_context");
    if (!search) throw new Error("no search_context");
    const found = await search.execute({ query: "carol call back" }, ctx);
    expect(found.content).not.toContain("_add_note");
    expect(found.content).not.toContain("carol@example.com");
  });

  test("a trace read while his call is still running keeps its input from everyone else", async () => {
    const s = await walterUsedHisCrm();
    await f.db.update(schema.agents).set({ ownerUserId: s.bia.id }).where(eq(schema.agents.id, f.agent.id));
    await f.db.insert(schema.customTools).values({
      orgId: f.org.id,
      connectionId: s.crm.id,
      name: "count_notes",
      access: "read",
      suggestedAccess: "read",
    });
    let answer = () => {};
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const slow: McpConnect = async () => {
      const server = new McpServer({ name: "slow-crm", version: "1" });
      server.registerTool(
        "count_notes",
        { description: "Counts the notes of a contact", inputSchema: { email: z.string() } },
        async () => {
          await held;
          return { content: [{ type: "text", text: "Seven notes for dave@example.com" }] };
        },
      );
      const [client, transport] = InMemoryTransport.createLinkedPair();
      await server.connect(transport);
      return mcpSessionOver(client);
    };
    // He asks in the channel he shares with Bia, who owns the agent and reads its runs.
    const asked = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: s.deals.id,
      author: { type: "person", userId: s.walter.id },
      body: "@dev count Dave's notes",
    });
    const [run] = await f.db.transaction((tx) => createAgentRuns(tx, asked, [f.agent.id], "mention"));
    if (!run) throw new Error("no run");
    await f.db
      .update(schema.agentRuns)
      .set({ status: "running", startedAt: new Date(), heartbeatAt: new Date() })
      .where(eq(schema.agentRuns.id, run.id));
    const gateway = createToolGateway({ sources: [createConnectorToolSource({ ...depsOf(), connect: slow })] });
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: s.deals.id,
      threadRootId: asked.id,
      triggerMessageId: asked.id,
    };
    const call = gateway.invoke(ctx, {
      toolUseId: "slow",
      name: `${s.crm.toolPrefix}_count_notes`,
      input: { email: "dave@example.com" },
    });
    for (let i = 0; i < 100; i++) {
      const [step] = await f.db
        .select({ id: schema.agentRunSteps.id })
        .from(schema.agentRunSteps)
        .where(and(eq(schema.agentRunSteps.runId, run.id), eq(schema.agentRunSteps.kind, "tool_call")));
      if (step) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const trace = async (userId: string) => JSON.stringify(await getRun(f.db, userId, f.org.id, run.id));
    try {
      for (const who of [s.bia.id, f.owner.id]) {
        const during = await trace(who);
        expect(during).toContain("_count_notes");
        expect(during).not.toContain("dave@example.com");
      }
      // He reads the agent's runs once he is an admin: his own call is whole to him.
      await makeAdmin(f.db, f.org.id, s.walter.id);
      expect(await trace(s.walter.id)).toContain("dave@example.com");
    } finally {
      answer();
      await call;
    }
    for (const who of [s.bia.id, f.owner.id]) expect(await trace(who)).not.toContain("dave@example.com");
    expect(await trace(s.walter.id)).toContain("Seven notes for dave@example.com");
  });

  test("a widget refreshing through his own connection reads plain refreshing to anyone else", async () => {
    const s = await walterUsedHisCrm();
    const dash = routineDeps(f);
    const board = await createDashboard(dash, s.walter.id, f.org.id, {
      title: "Contacts",
      audience: "workspace",
      editPolicy: "owner",
    });
    const widget = await insertWidget(dash, {
      orgId: f.org.id,
      dashboardId: board.id,
      agentId: f.agent.id,
      title: "Notes",
      prompt: "How many notes this week",
      format: "kpi",
      schedule: "hour",
      spec: { kind: "kpi", value: 3 },
      createdByUserId: s.walter.id,
    });
    if (!widget.routineId) throw new Error("no routine");
    const queued = await queueRoutineRun({ db: f.db }, await routineRow(f, widget.routineId), new Date(), "manual");
    if (!queued) throw new Error("slot taken");
    await executeRoutineRun(routineDeps(f), queued.id);
    const runId = (await routineRunRow(f, queued.id)).agentRunId ?? "";
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
    if (!run) throw new Error("no refresh run");
    await f.db
      .update(schema.agentRuns)
      .set({ status: "running", startedAt: new Date(), heartbeatAt: new Date() })
      .where(eq(schema.agentRuns.id, runId));
    await f.db
      .update(schema.dashboardWidgets)
      .set({ status: "updating" })
      .where(eq(schema.dashboardWidgets.id, widget.id));
    // The refresh's call into his CRM, held open while everyone looks at the widget.
    let answer = () => {};
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    // A refresh only reads.
    await f.db.insert(schema.customTools).values({
      orgId: f.org.id,
      connectionId: s.crm.id,
      name: "count_notes",
      access: "read",
      suggestedAccess: "read",
    });
    const slow: McpConnect = async () => {
      const server = new McpServer({ name: "slow-crm", version: "1" });
      server.registerTool(
        "count_notes",
        { description: "Counts the notes of a contact", inputSchema: { email: z.string() } },
        async () => {
          await held;
          return { content: [{ type: "text", text: "ok" }] };
        },
      );
      const [client, transport] = InMemoryTransport.createLinkedPair();
      await server.connect(transport);
      return mcpSessionOver(client);
    };
    const gateway = createToolGateway({ sources: [createConnectorToolSource({ ...depsOf(), connect: slow })] });
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId,
      channelId: run.channelId,
      threadRootId: run.threadRootId,
      triggerMessageId: run.triggerMessageId,
    };
    const call = gateway.invoke(ctx, {
      toolUseId: "refresh",
      name: `${s.crm.toolPrefix}_count_notes`,
      input: { email: "carol@example.com" },
    });
    for (let i = 0; i < 100; i++) {
      const [step] = await f.db
        .select({ id: schema.agentRunSteps.id })
        .from(schema.agentRunSteps)
        .where(and(eq(schema.agentRunSteps.runId, runId), eq(schema.agentRunSteps.kind, "tool_call")));
      if (step) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const dora = await addMember(f.db, f.org.id, "member", "dora");
    await f.db.update(schema.agents).set({ ownerUserId: dora.id }).where(eq(schema.agents.id, f.agent.id));
    try {
      for (const who of [s.bia.id, s.caio.id, f.owner.id, dora.id])
        expect((await getWidget(dash, who, f.org.id, widget.id)).step).toBeNull();
      expect((await getWidget(dash, s.walter.id, f.org.id, widget.id)).step).toMatchObject({ connector: "CRM" });
    } finally {
      answer();
      await call;
    }
  });
});
