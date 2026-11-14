import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq, schema } from "@agenteschat/db";
import {
  CALLER_META_KEY,
  type ConnectorDeps,
  connectCustomServer,
  createApiKeyConnection,
  createConnectorToolSource,
  createToolGateway,
  postPersonMessage,
  saveCustomTools,
} from "../src";
import { fakeGithubMcp } from "./fake-mcp";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const SERVER = "https://tools.example.com/mcp";
const SECRET = "test-secret-".padEnd(32, "x");
const NOW = new Date("2026-03-04T05:06:07Z");
const INPUT = { owner: "acme", repo: "app", pullNumber: 42 };

type FakeMcp = ReturnType<typeof fakeGithubMcp>;

const depsOf = (fx: Fixture, mcp: FakeMcp): ConnectorDeps => ({
  db: fx.db,
  keyWrappers: [fx.keyWrapper],
  publicUrl: "https://chat.example.com",
  resolveHost: async () => ["93.184.216.34"],
  connect: mcp.connect,
});

/** The fake server connected by address, with one tool agents may call; the connection's id. */
async function connectTools(fx: Fixture, deps: ConnectorDeps) {
  const started = await connectCustomServer(deps, fx.owner.id, fx.org.id, {
    serverUrl: SERVER,
    apiKey: "test-key",
    label: "Tools",
  });
  if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
  await saveCustomTools(deps, fx.owner.id, fx.org.id, started.server.id, {
    label: "Tools",
    tools: [{ name: "pull_request_read", access: "read", label: "Read a pull request" }],
  });
  return started.server.id;
}

/** A run of the fixture's agent that the owner's message started; `background`: a routine's, with nobody behind it. */
async function runContext(fx: Fixture, background = false) {
  const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "x",
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      background,
    })
    .returning();
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run?.id ?? "",
    channelId: fx.general.id,
    threadRootId: msg.id,
    triggerMessageId: msg.id,
  };
}

const toolCalls = (mcp: FakeMcp) => mcp.requests.filter((r) => r.method === "tools/call");
const statementOf = (request: FakeMcp["requests"][number]) =>
  (request.params?._meta as Record<string, unknown> | undefined)?.[CALLER_META_KEY];

/** A statement's header and claims when `secret` signed it, else null. */
function verified(statement: unknown, secret: string) {
  const [header = "", payload = "", signature] = typeof statement === "string" ? statement.split(".") : [];
  if (createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url") !== signature) return null;
  const json = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;
  return { header: json(header), claims: json(payload) };
}

test("a listed host: each tool call carries a statement signed with its secret that names the caller; the handshake and the listing carry none", async () => {
  f = await setup();
  const mcp = fakeGithubMcp();
  const deps = depsOf(f, mcp);
  const conn = await connectTools(f, deps);
  const source = createConnectorToolSource({
    ...deps,
    now: () => NOW,
    callerIdentity: new Map([["tools.example.com", SECRET]]),
  });
  const gateway = createToolGateway({ sources: [source] });
  const ctx = await runContext(f);
  for (const toolUseId of ["t1", "t2"]) {
    expect(await gateway.invoke(ctx, { toolUseId, name: "tools_pull_request_read", input: INPUT })).toMatchObject({
      type: "result",
    });
  }
  // The statement travels beside the arguments, never in them.
  expect(mcp.calls).toEqual([
    { tool: "pull_request_read", args: INPUT },
    { tool: "pull_request_read", args: INPUT },
  ]);

  const statements = toolCalls(mcp).map(statementOf);
  const [first, second] = statements.map((s) => verified(s, SECRET));
  const iat = NOW.getTime() / 1000;
  expect(first?.header).toEqual({ alg: "HS256", typ: "JWT" });
  expect(first?.claims).toEqual({
    iss: "https://chat.example.com",
    aud: "tools.example.com",
    org: f.org.id,
    agent: f.agent.id,
    run: ctx.runId,
    conn,
    user: f.owner.id,
    iat,
    exp: iat + 60,
    jti: expect.stringMatching(/^[0-9a-f-]{36}$/),
  });
  expect(second?.claims.jti).not.toBe(first?.claims.jti);
  expect(verified(statements[0], "other-secret-".padEnd(32, "x"))).toBeNull();

  const others = mcp.requests.filter((r) => r.method !== "tools/call");
  expect(others.map((r) => r.method)).toEqual(expect.arrayContaining(["initialize", "tools/list"]));
  expect(JSON.stringify(others)).not.toContain(CALLER_META_KEY);

  // Neither the statement nor its secret is kept with the run or in the audit log.
  const kept = JSON.stringify([
    await f.db.select().from(schema.agentRunSteps),
    await f.db.select().from(schema.auditLog),
  ]);
  expect(kept).toContain("tools_pull_request_read");
  for (const statement of statements) expect(kept).not.toContain(String(statement));
  expect(kept).not.toContain(SECRET);
});

test("a run nobody is behind names no person, and a call outside any run names no run either", async () => {
  f = await setup();
  const mcp = fakeGithubMcp();
  const deps = depsOf(f, mcp);
  await connectTools(f, deps);
  const source = createConnectorToolSource({ ...deps, callerIdentity: new Map([["tools.example.com", SECRET]]) });
  const ctx = await runContext(f, true);
  const tool = (await source.tools(ctx)).find((t) => t.name === "tools_pull_request_read");
  await tool?.execute(INPUT, ctx);
  await tool?.execute(INPUT, { ...ctx, runId: "" });

  const [routine, noRun] = toolCalls(mcp).map((r) => verified(statementOf(r), SECRET)?.claims);
  expect(routine).toMatchObject({ org: f.org.id, agent: f.agent.id, run: ctx.runId });
  expect(routine).not.toHaveProperty("user");
  expect(noRun).toMatchObject({ org: f.org.id, agent: f.agent.id });
  expect(noRun).not.toHaveProperty("run");
  expect(noRun).not.toHaveProperty("user");
});

test("nothing for a host that isn't listed, a listed one on another port or over http, or a catalog connector", async () => {
  f = await setup();
  const mcp = fakeGithubMcp();
  const deps = depsOf(f, mcp);
  const conn = await connectTools(f, deps);
  await createApiKeyConnection(deps, f.owner.id, f.org.id, { connector: "github", apiKey: "test-key" });
  const ctx = await runContext(f);
  /** What one call of `name` carried as its statement, with these hosts listed. */
  const statementWith = async (hosts: string[], name = "tools_pull_request_read") => {
    const source = createConnectorToolSource({ ...deps, callerIdentity: new Map(hosts.map((h) => [h, SECRET])) });
    const tool = (await source.tools(ctx)).find((t) => t.name === name);
    if (!tool) throw new Error(`${name} isn't offered`);
    mcp.requests.length = 0;
    await tool.execute(INPUT, ctx);
    return toolCalls(mcp).map(statementOf);
  };

  expect(await statementWith(["tools.example.com"])).toEqual([expect.any(String)]);
  expect(await statementWith([])).toEqual([undefined]);
  // A host is listed by its whole name: neither its parent domain nor a neighbour covers it.
  expect(await statementWith(["example.com", "other.example.com", "tools.example.com.evil.example"])).toEqual([
    undefined,
  ]);
  expect(await statementWith(["api.githubcopilot.com"], "github_pull_request_read")).toEqual([undefined]);
  for (const serverUrl of ["https://tools.example.com:8443/mcp", "http://tools.example.com/mcp"]) {
    await f.db.update(schema.connectorConnections).set({ serverUrl }).where(eq(schema.connectorConnections.id, conn));
    expect(await statementWith(["tools.example.com"])).toEqual([undefined]);
  }
});
