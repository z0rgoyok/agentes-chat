import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, schema, tracingLogger } from "@agenteschat/db";
import {
  addRunStep,
  DEFAULT_AGENT_BUDGET_NANO_USD,
  grantScopes,
  monthStartUtc,
  type ToolSource,
} from "@agenteschat/engine";
import { createLogger } from "../src/logger";
import { createOperatorApp } from "../src/operator/app";
import {
  type Browser,
  browser,
  createTestServer,
  joinByInvitation,
  planOfLast,
  seedOrg,
  signUp,
  type TestServer,
} from "./harness";

/**
 * ADR 0056, runs and conversations: a workspace's runs, one run's trace, a conversation's timeline and why a message
 * did or did not start a run. The history is made the way people make it: messages posted through the app, answered
 * by the agent with the fake provider.
 */

const TOKEN = "operator-test-token-".padEnd(48, "x");
const READ = "operator-read-token-".padEnd(48, "x");
const UNKNOWN = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const HOUR_EACH_WAY = `from=${new Date(Date.now() - 3600_000).toISOString()}&to=${new Date(Date.now() + 3600_000).toISOString()}`;
const ID = expect.stringMatching(/^[0-9a-f-]{36}$/);
const TIME = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

// Everything anyone writes here (people, the model, the tools, their inputs) says "canary": no answer may.
const tools: ToolSource = {
  name: "test-tools",
  tools: async () => [
    {
      name: "lookup",
      description: "Looks something up",
      scope: "test:read",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      describe: (input) => ({ title: `canary-title ${input.q}` }),
      execute: async () => ({ content: "canary-tool-result" }),
    },
    {
      name: "ship",
      description: "Ships it",
      scope: "test:write",
      sensitive: true,
      inputSchema: {
        type: "object",
        properties: { what: { type: "string" }, why: { type: "string" } },
        required: ["what"],
      },
      describe: () => ({ title: "canary-approval-title" }),
      execute: async () => ({ content: "canary-shipped" }),
    },
    {
      name: "acme_get_issue",
      description: "Reads an issue",
      scope: "acme:read",
      connectionId: CONNECTION,
      connectorLabel: "Acme tracker",
      service: "github",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      execute: async () => ({ content: "canary-issue" }),
    },
    // Never granted: a call of it is refused.
    {
      name: "purge",
      description: "Purges it",
      scope: "test:admin",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      execute: async () => ({ content: "canary-purged" }),
    },
  ],
};
const WHY = "canary-why: the person asked for it and nothing else answers this.";
/** A connected app's connection: `acme_get_issue` is its tool. */
const CONNECTION = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";

let t: TestServer;
let owner: Browser;
let member: Browser;
let org: { orgId: string; channelId: string; agentId: string };
let ownerId: string;
/** A GET with this token (null: none); the read-only one unless said. */
let get: (path: string, token?: string | null) => Promise<Response>;
/** The messages posted, by what each is for, and the run each started (if any). */
const sent: Record<"look" | "ask" | "answer" | "plain" | "first" | "second" | "blocked" | "held" | "ship", string> = {
  look: "",
  ask: "",
  answer: "",
  plain: "",
  first: "",
  second: "",
  blocked: "",
  held: "",
  ship: "",
};
const BODY = {
  look: "@dev canary-look this up",
  ask: "@dev canary-ask me first",
  answer: "canary-yes",
  plain: "canary-plain words for whoever",
  first: "@dev canary-first",
  second: "@dev canary-second, before you answer",
  blocked: "@dev @nobodyhere canary-blocked",
  held: "@dev canary-held",
  ship: "@dev canary-ship it",
};

/** Posts in #general; unless `answered` is false, the jobs it queued run (the agent answers). */
async function post(as: Browser, body: string, answered = true) {
  const res = await as(`/api/app/organizations/${org.orgId}/channels/${org.channelId}/messages`, { json: { body } });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  if (answered) await t.drain();
  return id;
}

async function runOf(messageId: string) {
  const [run] = await t.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, messageId));
  if (!run) throw new Error("no run for this message");
  return run;
}

beforeAll(async () => {
  t = await createTestServer({
    env: { OPERATOR_API_TOKEN: TOKEN },
    toolSources: [tools],
    reply: (request) => {
      const last = JSON.stringify(request.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["canary-reply after its tool"] };
      if (last.includes("canary-ship")) {
        return { chunks: [], toolUses: [{ name: "ship", input: { what: "canary-ship-input", why: WHY } }] };
      }
      if (last.includes("canary-ask")) {
        return {
          chunks: [],
          toolUses: [{ name: "ask_user", input: { why: WHY, question: "canary-question?", choices: ["sim", "nao"] } }],
        };
      }
      if (last.includes("canary-look")) {
        return { chunks: [], toolUses: [{ name: "lookup", input: { q: "canary-tool-input" } }] };
      }
      return { chunks: ["canary-reply"] };
    },
  });
  const deps = {
    db: t.db,
    config: t.config,
    version: "test",
    log: createLogger("error"),
    pubsub: t.adapters.pubsub,
    hub: t.engine.machineHub,
  };
  const app = createOperatorApp(deps, TOKEN, READ);
  get = async (path, token = READ) =>
    app.request(`/api/operator/v1${path}`, { headers: token === null ? {} : { authorization: `Bearer ${token}` } });
  const hold = (held: boolean) =>
    app.request(`/api/operator/v1/orgs/${org.orgId}/agents/${org.agentId}/hold`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ held }),
    });
  const audience = (audienceMode: "everyone" | "owner") =>
    t.db.update(schema.agents).set({ audienceMode }).where(eq(schema.agents.id, org.agentId));

  owner = browser(t);
  await signUp(owner, "owner@acme.test");
  org = await seedOrg(owner);
  const [user] = await t.db.select({ id: schema.users.id }).from(schema.users);
  ownerId = user?.id ?? "";
  await grantScopes(t.db, org.orgId, org.agentId, [
    { connectionId: null, scope: "test:read" },
    { connectionId: null, scope: "test:write" },
  ]);

  // A mention answered with a tool; a question the person answers in the conversation; a message naming nobody.
  sent.look = await post(owner, BODY.look);
  sent.ask = await post(owner, BODY.ask);
  sent.answer = await post(owner, BODY.answer);
  sent.plain = await post(owner, BODY.plain);
  // A second message while the agent's run for the first hasn't started: that run takes both.
  sent.first = await post(owner, BODY.first, false);
  sent.second = await post(owner, BODY.second);
  // Someone the agent doesn't answer mentions it, with a handle nobody has.
  member = await joinByInvitation(t, owner, org.orgId, "member@acme.test");
  await audience("owner");
  sent.blocked = await post(member, BODY.blocked);
  await audience("everyone");
  // A run that fails (its agent is on hold), then one left waiting on an approval.
  expect((await hold(true)).status).toBe(200);
  sent.held = await post(owner, BODY.held);
  expect((await hold(false)).status).toBe(200);
  sent.ship = await post(owner, BODY.ship);
});

afterAll(() => t.close());

async function ok<T = Record<string, unknown>>(res: Response) {
  if (res.status !== 200) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
const refusal = async (res: Response) => [res.status, ((await res.json()) as { error: { code: string } }).error.code];

type Run = Record<string, unknown> & { id: string; triggerMessageId: string; status: string; createdAt: string };
type RunPage = { runs: Run[]; next: string | null };
type Step = Record<string, unknown> & { seq: number; kind: string };
type Trace = {
  run: Run;
  steps: Step[];
  stepCount: number;
  asks: Record<string, unknown>[];
  jobs: Record<string, unknown>[];
  moreJobs: boolean;
  usage: Record<string, unknown> & { byModel: Record<string, unknown>[] };
  machine: unknown;
};
type Event = Record<string, unknown> & { type: string; id: string; at: string };
type Timeline = { channelId: string; from: string; to: string; events: Event[]; next: string | null };
type Explained = {
  message: Record<string, unknown>;
  verdict: string;
  skipped: string | null;
  handles: { agentIds: string[]; userIds: string[]; unknown: number };
  agents: (Record<string, unknown> & { agentId: string; run: Run | null; now: Record<string, unknown> })[];
  routing: Record<string, unknown> | null;
  workspace: Record<string, unknown>;
  postedJob: Record<string, unknown> | null;
};

/** The decision stored for the message that names nobody. */
const ROUTED = () => ({
  id: ID,
  messageId: sent.plain,
  at: TIME,
  strategy: "rule:only_agent",
  candidates: [{ agentId: org.agentId, score: 1 }],
  needsAgentScore: 1,
  selectedAgentIds: [org.agentId],
  reasonCodes: ["follow-up"],
  error: "llm: the answer wasn't JSON",
});

const runs = (query = "") => get(`/orgs/${org.orgId}/runs${query}`);
const trace = async (messageId: string, query = "") =>
  ok<Trace>(await get(`/runs/${(await runOf(messageId)).id}/trace${query}`));
const timeline = (query: string) => get(`/orgs/${org.orgId}/timeline?${query}`);
const explain = async (messageId: string) => ok<Explained>(await get(`/messages/${messageId}/explain`));

/** One call of every read here, in each of its forms. */
const everyRead = async () => [
  `/orgs/${org.orgId}/runs?limit=200`,
  `/orgs/${org.orgId}/runs?groupBy=error&from=2026-01-01T00:00:00Z&to=2100-01-01T00:00:00Z`,
  `/orgs/${org.orgId}/tool-calls?limit=200&${HOUR_EACH_WAY}`,
  ...["tool", "agent", "outcome"].map((by) => `/orgs/${org.orgId}/tool-calls?groupBy=${by}&${HOUR_EACH_WAY}`),
  ...Object.values(sent).flatMap((id) => [`/messages/${id}/explain`]),
  ...(
    await t.db
      .select({ id: schema.agentRuns.id, reply: schema.agentRuns.replyMessageId })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.orgId, org.orgId))
  ).flatMap((r) => [`/runs/${r.id}/trace`, ...(r.reply ? [`/messages/${r.reply}/explain`] : [])]),
  // A window that ends "now" would differ between two calls.
  `/orgs/${org.orgId}/timeline?channelId=${org.channelId}&limit=200&${HOUR_EACH_WAY}`,
  `/orgs/${org.orgId}/timeline?messageId=${sent.look}&limit=200`,
];

test("every read answers the read-only token as it does the full one, and nothing without a token", async () => {
  const paths = await everyRead();
  expect(paths.length).toBeGreaterThan(15);
  for (const path of paths) {
    const [read, full, none] = await Promise.all([get(path), get(path, TOKEN), get(path, null)]);
    expect({ path, read: read.status, full: full.status }).toEqual({ path, read: 200, full: 200 });
    expect(await read.json()).toEqual(await full.json());
    expect({ path, answer: await refusal(none) }).toEqual({ path, answer: [401, "unauthorized"] });
  }
});

test("no read carries what anyone wrote, what a tool was given or answered, a credential, or a field named like a secret", async () => {
  // What the history holds, so the check below means something.
  const stored = JSON.stringify([
    await t.db.select({ body: schema.messages.body }).from(schema.messages),
    await t.db.select({ data: schema.agentRunSteps.data }).from(schema.agentRunSteps),
    await t.db.select({ transcript: schema.agentRuns.transcript }).from(schema.agentRuns),
    await t.db.select({ title: schema.approvals.title, why: schema.approvals.why }).from(schema.approvals),
    await t.db.select({ text: schema.agentQuestions.text }).from(schema.agentQuestions),
    await t.db.select({ payload: schema.outbox.payload }).from(schema.outbox),
  ]);
  for (const written of [
    ...Object.values(BODY),
    "canary-reply",
    "canary-tool-input",
    "canary-tool-result",
    "canary-ship-input",
    "canary-approval-title",
    "canary-why",
    "canary-question",
  ]) {
    expect({ written, stored: stored.includes(written) }).toEqual({ written, stored: true });
  }
  for (const path of await everyRead()) {
    const text = await (await get(path)).text();
    for (const hidden of [
      "canary",
      "nobodyhere",
      "sk-ant-api-secret-9876",
      "Acme builds rockets",
      t.config.AGENTES_SECRET,
    ]) {
      expect({ path, hidden, leaked: text.includes(hidden) }).toEqual({ path, hidden, leaked: false });
    }
    expect(text).not.toMatch(/"[^"]*(token|password|secret|hash|cipher|key)[^"]*":/i);
  }
});

test("runs: newest first with what each waits for or failed with; filters, pages and counts by error", async () => {
  const page = await ok<RunPage>(await runs());
  expect(page.next).toBeNull();
  expect(page.runs.map((r) => [r.triggerMessageId, r.trigger, r.status, r.shown, r.errorCode])).toEqual([
    [sent.ship, "mention", "waiting_approval", "waiting_approval", null],
    [sent.held, "mention", "failed", "failed", "run.agent_paused"],
    [sent.first, "mention", "done", "done", null],
    [sent.plain, "router", "done", "done", null],
    [sent.ask, "mention", "done", "done", null],
    [sent.look, "mention", "done", "done", null],
  ]);
  const look = page.runs.at(-1);
  expect(look).toEqual({
    id: ID,
    orgId: org.orgId,
    agentId: org.agentId,
    channelId: org.channelId,
    threadRootId: sent.look,
    triggerMessageId: sent.look,
    replyMessageId: ID,
    trigger: "mention",
    hop: 1,
    background: false,
    brain: "model",
    model: "claude-sonnet-5-5",
    turns: 2,
    status: "done",
    shown: "done",
    waitCode: null,
    waitSource: null,
    waitResetsAt: null,
    waitingMachineId: null,
    errorCode: null,
    error: null,
    createdAt: TIME,
    startedAt: TIME,
    finishedAt: TIME,
    heartbeatAt: TIME,
  });
  expect(page.runs[1]).toMatchObject({ error: "This agent is paused for now.", model: null, turns: 0 });

  const ids = async (query: string) => (await ok<RunPage>(await runs(query))).runs.map((r) => r.triggerMessageId);
  expect(await ids("?status=failed")).toEqual([sent.held]);
  expect(await ids("?errorCode=run.agent_paused")).toEqual([sent.held]);
  expect(await ids("?errorCode=run.no_ai")).toEqual([]);
  expect(await ids(`?threadRootId=${sent.ask}`)).toEqual([sent.ask]);
  expect(await ids(`?agentId=${org.agentId}&channelId=${org.channelId}&status=done`)).toHaveLength(4);
  expect(await ids(`?agentId=${UNKNOWN}`)).toEqual([]);
  const from = encodeURIComponent(String(page.runs[3]?.createdAt));
  expect(await ids(`?from=${from}`)).toEqual([sent.ship, sent.held, sent.first, sent.plain]);
  expect(await ids(`?to=${from}`)).toEqual([sent.ask, sent.look]);

  // Every run exactly once, two at a time.
  const paged: string[] = [];
  let cursor: string | null = null;
  do {
    const part: RunPage = await ok<RunPage>(await runs(`?limit=2${cursor ? `&cursor=${cursor}` : ""}`));
    expect(part.runs.length).toBeLessThanOrEqual(2);
    paged.push(...part.runs.map((r) => r.id));
    cursor = part.next;
  } while (cursor);
  expect(paged).toEqual(page.runs.map((r) => r.id));

  expect(await ok(await runs("?groupBy=error"))).toEqual({
    from: TIME,
    to: TIME,
    errors: [{ errorCode: "run.agent_paused", runs: 1, firstAt: TIME, lastAt: TIME }],
    more: false,
  });
  expect(await ok(await runs("?groupBy=error&to=2020-01-01T00:00:00Z"))).toMatchObject({ errors: [] });

  expect(await refusal(await get(`/orgs/${UNKNOWN}/runs`))).toEqual([404, "not_found"]);
  expect(await refusal(await get(`/orgs/${UNKNOWN}/runs?groupBy=error`))).toEqual([404, "not_found"]);
  expect(await refusal(await runs("?cursor=nope"))).toEqual([400, "invalid_cursor"]);
  for (const bad of ["?status=asleep", "?limit=0", "?limit=201", "?from=yesterday", "?groupBy=agent", "?agentId=7"]) {
    expect({ bad, status: (await runs(bad)).status }).toEqual({ bad, status: 400 });
  }
});

test("a page of runs reads the stored transcripts of its own rows, in a list and in a timeline", async () => {
  const seen: string[] = [];
  const counts = tracingLogger.logQuery;
  tracingLogger.logQuery = (query = "") => {
    seen.push(query);
    counts();
  };
  try {
    expect((await ok<RunPage>(await runs("?limit=2"))).runs).toHaveLength(2);
    expect((await timeline(`channelId=${org.channelId}&limit=2&${HOUR_EACH_WAY}`)).status).toBe(200);
  } finally {
    tracingLogger.logQuery = counts;
  }
  // A sort works out the columns of every row it is given, so a statement that reads transcripts names its rows.
  const reading = seen.filter((query) => query.includes("transcript"));
  expect(reading).toHaveLength(2);
  for (const query of reading) expect(query).toMatch(/"id" in \(/);
});

test("a run's trace: its steps without their contents, what it asked, its jobs and what it spent", async () => {
  const look = await trace(sent.look);
  expect(look.run).toMatchObject({ triggerMessageId: sent.look, status: "done", turns: 2 });
  const none = {
    tool: null,
    builtIn: null,
    connector: null,
    isError: null,
    refusal: null,
    code: null,
    reason: null,
    model: null,
    stopReason: null,
    chars: null,
    durationMs: null,
    messageId: null,
    records: [],
  };
  const told = look.steps.filter((s) => s.kind !== "context");
  expect(told).toEqual([
    {
      ...none,
      seq: expect.any(Number),
      kind: "model_call",
      at: TIME,
      model: "claude-sonnet-5-5",
      stopReason: "tool_use",
    },
    {
      ...none,
      seq: expect.any(Number),
      kind: "tool_call",
      at: TIME,
      tool: "lookup",
      builtIn: true,
      chars: JSON.stringify({ q: "canary-tool-input" }).length + 1,
    },
    {
      ...none,
      seq: expect.any(Number),
      kind: "tool_result",
      at: TIME,
      tool: "lookup",
      builtIn: true,
      isError: false,
      chars: "canary-tool-result".length,
      durationMs: expect.any(Number),
    },
    {
      ...none,
      seq: expect.any(Number),
      kind: "model_call",
      at: TIME,
      model: "claude-sonnet-5-5",
      stopReason: "end_turn",
    },
    { ...none, seq: expect.any(Number), kind: "message", at: TIME, messageId: look.run.replyMessageId },
  ]);
  // In order, and a context step says what it noted by name only.
  expect(look.steps.map((s) => s.seq)).toEqual(look.steps.map((_, i) => i + 1));
  expect(look.stepCount).toBe(look.steps.length);
  const context = look.steps.find((s) => s.kind === "context");
  expect(context).toMatchObject({ ...none, records: expect.arrayContaining(["model"]) });
  expect(look.asks).toEqual([]);
  expect(look.jobs).toEqual([
    {
      id: ID,
      orgId: org.orgId,
      kind: "agent_run.execute",
      status: "done",
      attempts: 1,
      maxAttempts: 4,
      nextAttemptAt: TIME,
      lockedUntil: null,
      lockedBy: "drain",
      lastError: null,
      runId: look.run.id,
      cause: null,
      createdAt: TIME,
      completedAt: TIME,
    },
  ]);
  expect(look.moreJobs).toBe(false);
  expect(look.usage).toEqual({
    calls: 2,
    input: expect.any(Number),
    output: expect.any(Number),
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: expect.any(Number),
    byModel: [
      {
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        billedTo: "org",
        calls: 2,
        input: expect.any(Number),
        output: expect.any(Number),
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: expect.any(Number),
      },
    ],
  });
  expect(Number(look.usage.input)).toBeGreaterThan(0);
  expect(Number(look.usage.costUsd)).toBeGreaterThan(0);
  expect(look.machine).toBeNull();

  // The steps page back from the end.
  const last = await trace(sent.look, "?limit=2");
  expect(last.steps).toEqual(look.steps.slice(-2));
  expect(last.stepCount).toBe(look.stepCount);
  const before = await trace(sent.look, `?limit=2&beforeSeq=${last.steps[0]?.seq}`);
  expect(before.steps).toEqual(look.steps.slice(-4, -2).map((s) => ({ ...s, durationMs: null })));

  // A question answered in the conversation: the ask, and the job its answer woke the run with.
  const ask = await trace(sent.ask);
  expect(ask.asks).toEqual([
    {
      kind: "question",
      id: ID,
      runId: ask.run.id,
      agentId: org.agentId,
      threadRootId: null,
      tool: null,
      status: "answered",
      createdAt: TIME,
      expiresAt: TIME,
      resolvedAt: TIME,
      byUserId: ownerId,
    },
  ]);
  expect(ask.jobs.map((j) => [j.status, j.cause]).sort()).toEqual([
    ["done", null],
    ["done", "question"],
  ]);
  expect(ask.steps.filter((s) => s.tool).map((s) => [s.kind, s.tool])).toEqual([
    ["tool_call", "ask_user"],
    ["tool_result", "ask_user"],
  ]);

  // Waiting on an approval: the tool it would run, never its title, its parameters or why.
  const ship = await trace(sent.ship);
  expect(ship.run).toMatchObject({ status: "waiting_approval", shown: "waiting_approval", finishedAt: null });
  expect(ship.asks).toEqual([
    {
      kind: "approval",
      id: ID,
      runId: ship.run.id,
      agentId: org.agentId,
      threadRootId: sent.ship,
      tool: "ship",
      status: "pending",
      createdAt: TIME,
      expiresAt: TIME,
      resolvedAt: null,
      byUserId: null,
    },
  ]);
  expect(ship.steps.map((s) => s.kind)).toContain("approval");

  // Failed before any turn: an error step with its reason, and nothing spent.
  const held = await trace(sent.held);
  expect(held.run).toMatchObject({ status: "failed", errorCode: "run.agent_paused" });
  expect(held.steps.filter((s) => s.kind === "error")).toHaveLength(1);
  expect(held.usage).toMatchObject({ calls: 0, input: 0, costUsd: 0, byModel: [] });

  expect(await refusal(await get(`/runs/${UNKNOWN}/trace`))).toEqual([404, "not_found"]);
  for (const bad of ["?limit=0", "?limit=201", "?beforeSeq=0", "?beforeSeq=x"]) {
    const res = await get(`/runs/${look.run.id}/trace${bad}`);
    expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
  }
  expect((await get("/runs/nope/trace")).status).toBe(400);
});

test("tool calls: which tool and whose, how each ended and how big it was; filters, pages and counts", async () => {
  type Call = Record<string, unknown> & { tool: string; at: string };
  type Page = { from: string; to: string; calls: Call[]; next: string | null };
  type Counts = { from: string; to: string; groups: Record<string, unknown>[]; more: boolean };
  const calls = (query = "") => get(`/orgs/${org.orgId}/tool-calls${query}`);
  const told = async (query = "") => (await ok<Page>(await calls(query))).calls.map((c) => c.tool);
  const look = await runOf(sent.look);
  const ship = await runOf(sent.ship);
  const fact = { runId: ID, agentId: org.agentId, at: TIME, seq: expect.any(Number) };
  const own = { ...fact, builtIn: true, connector: null, connectorKind: null, refusal: null, code: null };
  const LOOKUP = {
    ...own,
    runId: look.id,
    tool: "lookup",
    outcome: "ok",
    durationMs: expect.any(Number),
    inputChars: JSON.stringify({ q: "canary-tool-input" }).length + 1,
    resultChars: "canary-tool-result".length,
  };
  const ASK = {
    ...own,
    tool: "ask_user",
    outcome: "ok",
    durationMs: expect.any(Number),
    inputChars: expect.any(Number),
    resultChars: expect.any(Number),
  };
  // Waiting on its approval: no result yet.
  const SHIP = {
    ...own,
    runId: ship.id,
    tool: "ship",
    outcome: "pending",
    durationMs: null,
    inputChars: expect.any(Number),
    resultChars: null,
  };
  const history = await ok<Page>(await calls());
  expect(history.calls).toEqual([SHIP, ASK, LOOKUP]);
  expect(history.next).toBeNull();
  expect(Date.parse(history.to) - Date.parse(history.from)).toBe(7 * 86_400_000);

  // Three more calls through the Tool Gateway, which says what each name was: a name it doesn't know, a connected
  // app's tool, and one of the server's own the agent may not call. In the run still at work: an ended run calls
  // nothing.
  await grantScopes(t.db, org.orgId, org.agentId, [{ connectionId: CONNECTION, scope: "acme:read" }]);
  const ctx = {
    db: t.db,
    orgId: org.orgId,
    agentId: org.agentId,
    runId: ship.id,
    channelId: ship.channelId,
    threadRootId: ship.threadRootId,
    triggerMessageId: ship.triggerMessageId,
  };
  for (const name of ["rm_rf", "acme_get_issue", "purge"]) {
    await t.engine.tools.invoke(ctx, { toolUseId: `call-${name}`, name, input: { q: "canary-gateway-input" } });
  }
  const sized = {
    durationMs: expect.any(Number),
    inputChars: JSON.stringify({ q: "canary-gateway-input" }).length + 1,
  };
  const UNKNOWN_NAME = {
    ...own,
    ...sized,
    runId: ship.id,
    tool: "rm_rf",
    builtIn: false,
    outcome: "error",
    resultChars: "Unknown tool rm_rf".length,
  };
  const CONNECTED = {
    ...own,
    ...sized,
    runId: ship.id,
    tool: "acme_get_issue",
    builtIn: false,
    connector: "Acme tracker",
    connectorKind: "github",
    outcome: "ok",
    resultChars: "canary-issue".length,
  };
  const REFUSED = {
    ...own,
    ...sized,
    runId: ship.id,
    tool: "purge",
    outcome: "refused",
    refusal: "noAccess",
    resultChars: expect.any(Number),
  };
  // A range that ends "now" leaves out a step written in the same millisecond: this one ends later.
  const page = await ok<Page>(await calls(`?${HOUR_EACH_WAY}`));
  expect(page.calls).toEqual([REFUSED, CONNECTED, UNKNOWN_NAME, SHIP, ASK, LOOKUP]);
  expect(JSON.stringify(page)).not.toContain("canary");

  // A run's trace says the same of each step, a result from its call.
  const marked = (await trace(sent.ship)).steps.filter((s) => s.tool).map((s) => [s.kind, s.tool, s.builtIn]);
  expect(marked).toEqual([
    ["tool_call", "ship", true],
    ["tool_call", "rm_rf", false],
    ["tool_result", "rm_rf", false],
    ["tool_call", "acme_get_issue", false],
    ["tool_result", "acme_get_issue", false],
    ["tool_call", "purge", true],
    ["tool_result", "purge", true],
  ]);

  // Filters, alone and together.
  expect(await told("?outcome=refused")).toEqual(["purge"]);
  expect(await told("?outcome=pending")).toEqual(["ship"]);
  expect(await told("?outcome=error")).toEqual(["rm_rf"]);
  expect(await told("?outcome=ok")).toEqual(["acme_get_issue", "ask_user", "lookup"]);
  expect(await told("?tool=ISSUE")).toEqual(["acme_get_issue"]);
  expect(await told("?tool=%25")).toEqual([]);
  expect(await told(`?runId=${ship.id}`)).toEqual(["purge", "acme_get_issue", "rm_rf", "ship"]);
  expect(await told(`?runId=${look.id}&outcome=ok&tool=look`)).toEqual(["lookup"]);
  expect(await told(`?agentId=${org.agentId}`)).toHaveLength(6);
  expect(await told(`?agentId=${UNKNOWN}`)).toEqual([]);
  // The dates are the calls' own.
  const [newest, , third] = page.calls;
  expect(await told(`?from=${third?.at}`)).toEqual(["purge", "acme_get_issue", "rm_rf"]);
  expect(await told(`?to=${newest?.at}`)).toEqual(["acme_get_issue", "rm_rf", "ship", "ask_user", "lookup"]);
  expect(await told("?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z")).toEqual([]);

  // Pages.
  const first = await ok<Page>(await calls("?limit=4"));
  expect(first.calls).toEqual(page.calls.slice(0, 4));
  const rest = await ok<Page>(await calls(`?limit=4&cursor=${first.next}`));
  expect(rest.calls).toEqual(page.calls.slice(4));
  expect(rest.next).toBeNull();

  // Counts instead of calls.
  const by = async (groupBy: string, query = "") => ok<Counts>(await calls(`?groupBy=${groupBy}${query}`));
  const one = { calls: 1, errors: 0, refused: 0, pending: 0 };
  expect((await by("tool")).groups).toEqual([
    { ...one, group: "acme_get_issue", builtIn: false },
    { ...one, group: "ask_user", builtIn: true },
    { ...one, group: "lookup", builtIn: true },
    { ...one, group: "purge", builtIn: true, refused: 1 },
    { ...one, group: "rm_rf", builtIn: false, errors: 1 },
    { ...one, group: "ship", builtIn: true, pending: 1 },
  ]);
  expect(await by("outcome")).toEqual({
    from: TIME,
    to: TIME,
    groups: [
      { group: "ok", builtIn: null, calls: 3, errors: 0, refused: 0, pending: 0 },
      { group: "error", builtIn: null, calls: 1, errors: 1, refused: 0, pending: 0 },
      { group: "pending", builtIn: null, calls: 1, errors: 0, refused: 0, pending: 1 },
      { group: "refused", builtIn: null, calls: 1, errors: 0, refused: 1, pending: 0 },
    ],
    more: false,
  });
  expect((await by("agent")).groups).toEqual([
    { group: org.agentId, builtIn: null, calls: 6, errors: 1, refused: 1, pending: 1 },
  ]);
  expect((await by("agent", `&runId=${look.id}`)).groups).toEqual([
    { group: org.agentId, builtIn: null, calls: 1, errors: 0, refused: 0, pending: 0 },
  ]);
  const cut = await by("tool", "&limit=2");
  expect([cut.groups.map((g) => g.group), cut.more]).toEqual([["acme_get_issue", "ask_user"], true]);

  // A step written before the gateway kept what a name was says nothing of it: not known to be the server's own.
  // Counted by name it is, since another call of that name was.
  await addRunStep(t.db, ship, "tool_call", { toolUseId: "old", name: "lookup", input: {} });
  const [old] = (await ok<Page>(await calls(`?runId=${ship.id}&${HOUR_EACH_WAY}`))).calls;
  expect(old).toMatchObject({ tool: "lookup", builtIn: false, outcome: "pending" });
  expect((await by("tool", `&tool=lookup&${HOUR_EACH_WAY}`)).groups).toEqual([
    { group: "lookup", builtIn: true, calls: 2, errors: 0, refused: 0, pending: 1 },
  ]);

  expect(await refusal(await get(`/orgs/${UNKNOWN}/tool-calls`))).toEqual([404, "not_found"]);
  expect(await refusal(await calls(`?runId=${UNKNOWN}`))).toEqual([404, "not_found"]);
  for (const bad of [
    "?outcome=nope",
    "?groupBy=day",
    "?tool=",
    "?tool=a%00b",
    "?runId=nope",
    "?limit=201",
    "?cursor=nope",
    "?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z",
    "?from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z",
  ]) {
    const res = await calls(bad);
    expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
  }
});

test("a workspace's tool calls are found by its id and their dates, through the index of tool calls alone", async () => {
  const plan = await planOfLast(t, "agent_run_steps", () => get(`/orgs/${org.orgId}/tool-calls`), [
    "enable_bitmapscan",
  ]);
  expect(plan).toMatch(
    /Index Scan using agent_run_steps_tool_calls_idx on agent_run_steps\s+Index Cond: \(\(org_id = .+ AND \(created_at >= .+ AND \(created_at < /,
  );
});

test("a conversation's timeline: messages by who and how long, decisions, runs and asks, in order", async () => {
  const all = await ok<Timeline>(await timeline(`channelId=${org.channelId}&limit=200`));
  expect(Date.parse(all.to) - Date.parse(all.from)).toBe(6 * 3600_000);
  expect({ ...all, events: [] }).toEqual({ channelId: org.channelId, from: TIME, to: TIME, events: [], next: null });
  expect(all.events.map((e) => e.at)).toEqual(all.events.map((e) => e.at).sort());

  // Each message posted, with its length in place of its text.
  const written = all.events.filter((e) => e.type === "message");
  const mine = (id: string) => written.find((e) => e.id === id);
  expect(mine(sent.look)).toEqual({
    type: "message",
    id: sent.look,
    at: TIME,
    threadRootId: null,
    authorType: "person",
    authorUserId: ownerId,
    authorAgentId: null,
    runId: null,
    hop: 0,
    length: BODY.look.length,
    mentionedAgentIds: [org.agentId],
    mentionedUserIds: [],
    flags: expect.any(Array),
    edited: false,
    deleted: false,
  });
  expect(mine(sent.answer)).toMatchObject({ length: BODY.answer.length, flags: ["answersQuestionId"] });
  expect(mine(sent.blocked)).toMatchObject({ length: BODY.blocked.length, mentionedAgentIds: [org.agentId] });
  const look = await runOf(sent.look);
  expect(mine(String(look.replyMessageId))).toMatchObject({
    authorType: "agent",
    authorAgentId: org.agentId,
    runId: look.id,
    threadRootId: null,
    hop: 1,
  });

  // The message that names nobody: the router's model step failed (the fake provider answers no JSON), a rule
  // picked the only agent, and its run started. The decision's own marks, never a step's words.
  expect(all.events.filter((e) => e.type === "routing")).toEqual([{ type: "routing", ...ROUTED() }]);
  const started = all.events.filter((e) => e.type === "run");
  expect(started.map((e) => [e.triggerMessageId, e.shown])).toEqual([
    [sent.look, "done"],
    [sent.ask, "done"],
    [sent.plain, "done"],
    [sent.first, "done"],
    [sent.held, "failed"],
    [sent.ship, "waiting_approval"],
  ]);
  expect<unknown>(started[0]).toEqual({
    ...(await ok<RunPage>(await runs())).runs.at(-1),
    type: "run",
    at: started[0]?.createdAt,
  });
  expect(all.events.filter((e) => e.type === "ask").map((e) => [e.kind, e.status, e.tool])).toEqual([
    ["question", "answered", null],
    ["approval", "pending", "ship"],
  ]);
  // A message comes before the run it starts, though one statement wrote both at one instant; the run before its reply.
  const index = (id: string) => all.events.findIndex((e) => e.id === id);
  for (const run of started) expect(index(String(run.triggerMessageId))).toBeLessThan(index(run.id));
  expect(index(sent.look)).toBeLessThan(index(look.id));
  expect(index(look.id)).toBeLessThan(index(String(look.replyMessageId)));

  // Around a message: the same conversation, 3 hours each way; and every event exactly once, three at a time.
  const around = await ok<Timeline>(await timeline(`messageId=${sent.look}&limit=200`));
  expect(around.events).toEqual(all.events);
  expect(Date.parse(around.to) - Date.parse(around.from)).toBe(6 * 3600_000);
  const paged: Event[] = [];
  let cursor: string | null = null;
  do {
    const part: Timeline = await ok<Timeline>(
      await timeline(`messageId=${sent.look}&limit=3${cursor ? `&cursor=${cursor}` : ""}`),
    );
    expect(part.events.length).toBeLessThanOrEqual(3);
    paged.push(...part.events);
    cursor = part.next;
  } while (cursor);
  expect(paged).toEqual(all.events);

  // The window is the caller's to move.
  const at = encodeURIComponent(String(mine(sent.plain)?.at));
  const since = await ok<Timeline>(await timeline(`channelId=${org.channelId}&from=${at}&limit=200`));
  expect(since.events[0]?.id).toBe(sent.plain);
  const until = await ok<Timeline>(
    await timeline(`channelId=${org.channelId}&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z`),
  );
  expect(until.events).toEqual([]);

  expect(await refusal(await timeline(`channelId=${UNKNOWN}`))).toEqual([404, "not_found"]);
  expect(await refusal(await timeline(`messageId=${UNKNOWN}`))).toEqual([404, "not_found"]);
  expect(await refusal(await get(`/orgs/${UNKNOWN}/timeline?channelId=${org.channelId}`))).toEqual([404, "not_found"]);
  for (const bad of [
    "",
    `channelId=${org.channelId}&messageId=${sent.look}`,
    `channelId=${org.channelId}&from=2026-01-01T00:00:00Z&to=2026-01-03T00:00:01Z`,
    `channelId=${org.channelId}&from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z`,
    `channelId=${org.channelId}&limit=201`,
    "channelId=general",
  ]) {
    expect({ bad, status: (await timeline(bad)).status }).toEqual({ bad, status: 400 });
  }
  expect(await refusal(await timeline(`channelId=${org.channelId}&cursor=nope`))).toEqual([400, "invalid_cursor"]);
});

test("why a message did or did not start a run", async () => {
  const fine = { archived: false, held: false, inChannel: true, autoReply: true, mayTalk: true, overBudget: false };
  const job = { kind: "message.posted", status: "done", cause: null, lastError: null };

  // A mention the agent answered.
  const look = await explain(sent.look);
  expect<unknown>(look).toEqual({
    message: {
      id: sent.look,
      orgId: org.orgId,
      channelId: org.channelId,
      channelKind: "channel",
      at: TIME,
      threadRootId: null,
      authorType: "person",
      authorUserId: ownerId,
      authorAgentId: null,
      runId: null,
      hop: 0,
      length: BODY.look.length,
      mentionedAgentIds: [org.agentId],
      mentionedUserIds: [],
      flags: expect.any(Array),
      edited: false,
      deleted: false,
    },
    verdict: "run",
    skipped: null,
    handles: { agentIds: [org.agentId], userIds: [], unknown: 0 },
    agents: [
      {
        agentId: org.agentId,
        name: "Dev",
        handle: "dev",
        named: true,
        mentioned: true,
        referenced: false,
        candidate: false,
        score: null,
        selected: false,
        outcome: "run",
        run: (await ok<RunPage>(await runs())).runs.at(-1),
        now: fine,
      },
    ],
    routing: null,
    workspace: { standing: "active", billingHold: null, deleting: false },
    postedJob: expect.objectContaining(job),
  });

  // An answer to the agent's question resumes the run that asked.
  const answer = await explain(sent.answer);
  expect(answer).toMatchObject({ verdict: "answered_question", skipped: null, routing: null });
  expect(answer.agents[0]).toMatchObject({ named: false, mentioned: false, outcome: "answered_question" });
  expect(answer.agents[0]?.run?.triggerMessageId).toBe(sent.ask);

  // Naming nobody: the router picked the agent.
  const plain = await explain(sent.plain);
  expect(plain).toMatchObject({ verdict: "run", handles: { agentIds: [], userIds: [], unknown: 0 } });
  expect(plain.routing).toEqual(ROUTED());
  expect(plain.agents[0]).toMatchObject({ named: false, candidate: true, selected: true, outcome: "run" });
  expect(plain.agents[0]?.run).toMatchObject({ trigger: "router", status: "done" });

  // Written while the run for the message before it hadn't started: that run took it, and a step says it read it.
  const second = await explain(sent.second);
  expect(second).toMatchObject({ verdict: "joined", skipped: null, routing: null });
  expect(second.message.flags).toContain("steeredRunIds");
  expect(second.agents[0]).toMatchObject({ named: true, mentioned: true, outcome: "joined" });
  expect(second.agents[0]?.run?.triggerMessageId).toBe(sent.first);
  const read = (await trace(sent.first)).steps.filter((s) => (s.records as string[]).includes("steeredMessageIds"));
  expect(read).toHaveLength(1);

  // Mentioned by someone it didn't answer then: no run. It answers them now, and `now` says so.
  const blocked = await explain(sent.blocked);
  expect(blocked).toMatchObject({ verdict: "blocked", skipped: null, routing: null });
  expect(blocked.handles).toEqual({ agentIds: [org.agentId], userIds: [], unknown: 1 });
  expect(blocked.agents).toEqual([
    expect.objectContaining({ named: true, mentioned: true, outcome: "none", run: null, now: fine }),
  ]);

  // Its agent was on hold: the run it started failed.
  const held = await explain(sent.held);
  expect(held.verdict).toBe("run");
  expect(held.agents[0]?.run).toMatchObject({ status: "failed", errorCode: "run.agent_paused" });

  // An agent's reply starts nothing.
  const reply = await explain(String((await runOf(sent.look)).replyMessageId));
  expect(reply).toMatchObject({
    message: { authorType: "agent", authorAgentId: org.agentId, hop: 1, length: "canary-reply after its tool".length },
    verdict: "not_routed",
    skipped: "unknown",
    routing: null,
  });
  expect(reply.agents[0]).toMatchObject({ outcome: "none", now: { ...fine, mayTalk: null } });

  expect(await refusal(await get(`/messages/${UNKNOWN}/explain`))).toEqual([404, "not_found"]);
  expect((await get("/messages/nope/explain")).status).toBe(400);
});

test("what an explanation works out as things are now: holds, standing, and who the agent answers", async () => {
  const put = (path: string, json: unknown) =>
    createOperatorApp({ db: t.db, config: t.config, version: "test", log: createLogger("error") }, TOKEN).request(
      `/api/operator/v1${path}`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(json),
      },
    );
  const reply = String((await runOf(sent.look)).replyMessageId);
  // An agent without a budget of its own has the workspace's default: spent to it, it is over.
  const spent = {
    orgId: org.orgId,
    agentId: org.agentId,
    periodStart: monthStartUtc(new Date()).toISOString().slice(0, 10),
    spentNanoUsd: DEFAULT_AGENT_BUDGET_NANO_USD,
  };
  await t.db.update(schema.agents).set({ monthlyBudgetNanoUsd: null }).where(eq(schema.agents.id, org.agentId));
  expect((await explain(sent.look)).agents[0]?.now).toMatchObject({ overBudget: false });
  await t.db
    .insert(schema.agentBudgetPeriods)
    .values(spent)
    .onConflictDoUpdate({
      target: [schema.agentBudgetPeriods.agentId, schema.agentBudgetPeriods.periodStart],
      set: { spentNanoUsd: spent.spentNanoUsd },
    });
  expect((await explain(sent.look)).agents[0]?.now).toMatchObject({ overBudget: true });

  await t.db.update(schema.agents).set({ audienceMode: "owner" }).where(eq(schema.agents.id, org.agentId));
  expect((await put(`/orgs/${org.orgId}/agents/${org.agentId}/hold`, { held: true })).status).toBe(200);
  expect((await explain(sent.blocked)).agents[0]?.now).toMatchObject({ held: true, mayTalk: false });
  expect((await explain(sent.look)).agents[0]?.now).toMatchObject({ held: true, mayTalk: true });

  // What a stored decision says of a message nothing answers: its verdict, and its marks without a model's words.
  const decided = async (row: { strategy: string; selectedAgentIds?: string[]; error?: string; reason?: string }) => {
    await t.db.delete(schema.routingDecisions).where(eq(schema.routingDecisions.messageId, reply));
    await t.db.insert(schema.routingDecisions).values({
      orgId: org.orgId,
      channelId: org.channelId,
      messageId: reply,
      candidates: [{ agentId: org.agentId, score: 0.4 }],
      ...row,
    });
    const { verdict, routing, agents } = await explain(reply);
    expect(agents[0]).toMatchObject({ candidate: true, score: 0.4, selected: Boolean(row.selectedAgentIds) });
    return [verdict, routing?.reasonCodes];
  };
  expect(await decided({ strategy: "jev", reason: "follow-up; for people; jev: canary words; default" })).toEqual([
    "nobody_picked",
    ["follow-up", "for people"],
  ]);
  expect(await decided({ strategy: "mention-jev", selectedAgentIds: [org.agentId], reason: "@dev: 0.40" })).toEqual([
    "picked_not_started",
    [],
  ]);
  expect(await decided({ strategy: "no_ai", error: "no_ai" })).toEqual(["no_ai", []]);
  expect(await decided({ strategy: "plan_hold", error: "no_ai" })).toEqual(["kept_on_hold", []]);
  expect(await decided({ strategy: "no_ai", error: "platform_cap" })).toEqual(["platform_cap", []]);
  expect(JSON.stringify(await explain(reply))).not.toContain("canary");
  await t.db.delete(schema.routingDecisions).where(eq(schema.routingDecisions.messageId, reply));

  // The router stops at a billing hold too, but for a person's message in a workspace waiting for its first plan.
  const [bare] = await t.db
    .insert(schema.messages)
    .values({
      orgId: org.orgId,
      channelId: org.channelId,
      authorType: "person",
      authorUserId: ownerId,
      body: "canary-unrouted",
    })
    .returning({ id: schema.messages.id });
  const onHold = async (reason: string, messageId: string) => {
    expect((await put(`/orgs/${org.orgId}/standing`, { state: "hold", reason, notice: "shown" })).status).toBe(200);
    const { verdict, skipped, workspace } = await explain(messageId);
    return [verdict, skipped, workspace.standing, workspace.billingHold];
  };
  expect(await onHold("unpaid", bare?.id ?? "")).toEqual(["not_routed", "workspace_paused", "hold", "unpaid"]);
  expect(await onHold("ended", reply)).toEqual(["not_routed", "workspace_paused", "hold", "ended"]);
  expect(await onHold("payment", reply)).toEqual(["not_routed", "workspace_paused", "hold", "payment"]);
  // The person's message goes on there: the next exit says why nothing was decided (no job ever routed this one).
  expect(await onHold("payment", bare?.id ?? "")).toEqual(["not_routed", "never_queued", "hold", "payment"]);

  const standing = { state: "suspended", reason: "abuse", notice: "silent" };
  expect((await put(`/orgs/${org.orgId}/standing`, standing)).status).toBe(200);
  expect(await explain(reply)).toMatchObject({
    verdict: "not_routed",
    skipped: "workspace_paused",
    workspace: { standing: "suspended", billingHold: null, deleting: false },
  });
  // A run that took a message says so itself, when the message doesn't (the router or an agent sent it there).
  await t.db.update(schema.messages).set({ meta: {} }).where(eq(schema.messages.id, sent.second));
  const second = await explain(sent.second);
  expect(second).toMatchObject({ verdict: "joined", message: { flags: [] } });
  expect(second.agents[0]?.run?.triggerMessageId).toBe(sent.first);
  // What is stored doesn't move: the mention's run is still its answer.
  expect(await explain(sent.look)).toMatchObject({ verdict: "run", skipped: null });
});

test("a run's status as people read it, and what it waits for, from the marks the engine leaves on it", async () => {
  const run = await runOf(sent.ship);
  const shown = async (set: Partial<typeof schema.agentRuns.$inferInsert>) => {
    await t.db.update(schema.agentRuns).set(set).where(eq(schema.agentRuns.id, run.id));
    const { shown, waitCode, waitSource, waitResetsAt, waitingMachineId } = (await trace(sent.ship)).run;
    return { shown, waitCode, waitSource, waitResetsAt, waitingMachineId };
  };
  const waiting = (waitingForBrain: Record<string, unknown>, waitingMachineId: string | null = null) =>
    shown({ status: "waiting_input", waitingMachineId, transcript: { waitingForBrain } });
  const none = { waitCode: null, waitSource: null, waitResetsAt: null, waitingMachineId: null };

  expect(await waiting({ code: "plan_limit", resetsAt: "2026-12-01T00:00:00.000Z" })).toEqual({
    ...none,
    shown: "waiting_plan",
    waitCode: "plan_limit",
    waitResetsAt: "2026-12-01T00:00:00.000Z",
  });
  expect(await waiting({ code: "usage_pause", source: "budget" })).toEqual({
    ...none,
    shown: "waiting_budget",
    waitCode: "usage_pause",
    waitSource: "budget",
  });
  expect(await waiting({ code: "work_queue" })).toEqual({ ...none, shown: "waiting_line", waitCode: "work_queue" });
  expect(await waiting({ code: "busy" }, UNKNOWN)).toEqual({
    ...none,
    shown: "waiting_computer",
    waitCode: "busy",
    waitingMachineId: UNKNOWN,
  });
  expect(await shown({ status: "waiting_input", waitingMachineId: null, transcript: { outage: { n: 1 } } })).toEqual({
    ...none,
    shown: "waiting_outage",
    waitCode: "provider_outage",
  });
  expect(await shown({ status: "waiting_input", transcript: {} })).toEqual({ ...none, shown: "waiting_input" });
  expect(await shown({ status: "canceled", startedAt: null })).toEqual({ ...none, shown: "no_reply" });
  // Only what is shaped like a code or a time comes out of the transcript.
  expect(await waiting({ code: "canary words", source: "canary words", resetsAt: "canary" })).toEqual({
    ...none,
    shown: "waiting_input",
  });
});
