import { afterEach, expect, test } from "bun:test";
import { CODEX_FOLDER_PROTOCOL, MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { asc, eq, schema } from "@agenteschat/db";
import { createAnthropicProvider, type ModelRequest } from "@agenteschat/providers";
import {
  addRunStep,
  type Brain,
  type BrainTurn,
  type CodeSetup,
  computerPrompt,
  createJobHandlers,
  drainOutbox,
  grantScopes,
  type MachineStatus,
  postPersonMessage,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * The prompt cache (token-cost plan, items A1–A5): the model sees the same words, laid out so the provider can keep
 * them. API brain: the core tools first with a breakpoint after them, a breakpoint after the last block that changes
 * only with settings, an hour for that prefix. Computer brains: one system text per session, the message once.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** The Anthropic request body a captured request becomes (the transport refuses after reading it: no network). */
async function anthropicBody(request: ModelRequest): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    throw new Error("captured");
  }) as unknown as typeof fetch;
  await createAnthropicProvider({ fetch: fetcher, maxRetries: 0 })
    .stream(request, { apiKey: "k", onDelta: () => {} })
    .catch(() => {});
  return body;
}

test("API brain: core tools first and cached for an hour whatever group loads; the settled system blocks too", async () => {
  let issues = 0;
  f = await setup({
    toolsOnDemand: true,
    issueTools: true,
    contextTools: true,
    judge: (kind, _id, _state, q) =>
      kind === "tool_groups" && JSON.stringify(q.instructions).includes("Issues") ? issues : 0,
    reply: () => ({ chunks: ["ok"] }),
  });
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "issues:read" }]);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
  await drainOutbox(f.db, f.handlers);
  issues = 0.9;
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev quais issues estão abertas?",
  });
  await drainOutbox(f.db, f.handlers);
  const [greeting, asking] = f.provider.calls.map((c) => c.request);
  if (!greeting || !asking) throw new Error("two calls expected");

  // The engine asks for an hour, and marks the tools every run of the agent lists the same.
  expect(greeting.cacheTtl).toBe("1h");
  const stable = (r: ModelRequest) => (r.tools ?? []).filter((t) => t.stable).map((t) => t.name);
  expect(stable(greeting)).toContain("search_context");
  expect(stable(greeting)).not.toContain("find_tools");
  expect(stable(asking)).toEqual(stable(greeting));
  expect((asking.tools ?? []).map((t) => t.name)).toContain("list_issues");
  expect((greeting.tools ?? []).map((t) => t.name)).not.toContain("list_issues");

  // System: none on the rules, one after the organization's block (shared by its agents), one after the last settled
  // block.
  const system = greeting.system as { text: string; cache?: boolean }[];
  const marked = system.flatMap((b, i) => (b.cache ? [i] : []));
  expect(system[0]?.cache).toBeUndefined();
  expect(marked[0]).toBe(1);
  expect(marked).toHaveLength(2);
  expect(system[marked[1] ?? 0]?.text).toStartWith("# What you can do");

  const [a, b] = await Promise.all([anthropicBody(greeting), anthropicBody(asking)]);
  const hour = { type: "ephemeral", ttl: "1h" };
  for (const body of [a, b]) {
    const tools = body.tools as Record<string, unknown>[];
    const at = tools.findIndex((t) => t.cache_control);
    // The stable tools are the start of the list, the breakpoint on the last of them.
    expect(at).toBe(stable(greeting).length - 1);
    expect(tools[at]?.cache_control).toEqual(hour);
    const marks = (body.system as Record<string, unknown>[]).filter((s) => s.cache_control);
    // With history before the trigger (the second run), its end takes the organization's breakpoint (token-trim B8).
    expect(marks.map((s) => s.cache_control)).toEqual(body === a ? [hour, hour] : [hour]);
    // The conversation's automatic breakpoint stays at 5 minutes: 4 in all.
    expect(body.cache_control).toEqual({ type: "ephemeral" });
  }
  // Loading the Issues group changed none of the bytes up to the tools' breakpoint.
  const upTo = (body: Record<string, unknown>) =>
    JSON.stringify((body.tools as unknown[]).slice(0, stable(greeting).length));
  expect(upTo(b)).toBe(upTo(a));
});

/**
 * A request body as the provider caches it: the tools, the system blocks, then every block of every message, each
 * without its `cache_control` (a moving marker is no change), and where the markers were.
 */
function cachedPositions(body: Record<string, unknown>) {
  const out: { text: string; mark: boolean }[] = [];
  const push = (block: Record<string, unknown>) => {
    const { cache_control, ...rest } = block;
    out.push({ text: JSON.stringify(rest), mark: cache_control !== undefined });
  };
  for (const t of (body.tools as Record<string, unknown>[]) ?? []) push(t);
  for (const b of (body.system as Record<string, unknown>[]) ?? []) push(b);
  for (const m of (body.messages as { content: string | Record<string, unknown>[] }[]) ?? []) {
    for (const b of typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content) push(b);
  }
  return out;
}

/** Where the last `cache_control` marker of a request's blocks is, -1 without one. */
const lastMark = (positions: { mark: boolean }[]) => positions.map((p) => p.mark).lastIndexOf(true);

test("API brain: each call reads the one before it from the cache, also when the next message needs fewer tools", async () => {
  f = await setup({
    toolsOnDemand: true,
    issueTools: true,
    contextTools: true,
    judge: (kind, _id, state, q) =>
      kind === "tool_groups" && String(state.message).includes("issues") && JSON.stringify(q).includes("Issues")
        ? 0.9
        : 0,
    reply: (request) =>
      JSON.stringify(request.messages.at(-1)).includes("quais issues")
        ? { chunks: [], toolUses: [{ name: "list_issues", input: {} }] }
        : { chunks: ["Nenhuma aberta."] },
  });
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "issues:read" }]);
  // One run with a tool loop that needs the issues, then two that don't: a thanks and a greeting.
  for (const body of ["@dev quais issues estão abertas?", "@dev valeu", "@dev e o resto, tudo certo?"]) {
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
    await drainOutbox(f.db, f.handlers);
  }
  const bodies = await Promise.all(f.provider.calls.map((c) => anthropicBody(c.request)));
  expect(bodies).toHaveLength(4);
  for (let k = 1; k < bodies.length; k++) {
    const before = cachedPositions(bodies[k - 1] as Record<string, unknown>);
    const after = cachedPositions(bodies[k] as Record<string, unknown>);
    // In the tool loop the automatic breakpoint ends the previous request: all of it is read back. Between runs, up
    // to its last marked block (the trigger, after the history): what follows was this run's alone.
    const sameRun = k === 1;
    const end = sameRun ? before.length : lastMark(before) + 1;
    expect(after.slice(0, end).map((p) => p.text)).toEqual(before.slice(0, end).map((p) => p.text));
  }
  // The second run's trigger carries a breakpoint, after the first run's exchange: the third run reads it back.
  const [second, third] = [bodies[2], bodies[3]].map((b) => lastMark(cachedPositions(b as Record<string, unknown>)));
  expect(third).toBeGreaterThan(second ?? 0);
});

test("computer brain: one system text per session, recent work and where it starts read per turn, the message once", async () => {
  f = await setup();
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "MacBook",
    hostname: "mac",
    os: "darwin",
    arch: "arm64",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/Users/w/agentes",
    exec: true,
  });
  await f.db
    .update(schema.agents)
    .set({ machineId: paired.machineId, brain: "claude_code" })
    .where(eq(schema.agents.id, f.agent.id));
  const status = (id: string): MachineStatus => ({
    id,
    orgId: f.org.id,
    name: "MacBook",
    online: true,
    execAllowed: true,
    os: "darwin",
    protocol: MACHINE_PROTOCOL_VERSION,
    executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
  });
  const seen: { prompt: string; system: string; turn: BrainTurn }[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      seen.push({ prompt: computerPrompt(turn), system: turn.system, turn });
      yield { type: "usage", input: 40, output: 5, source: "plan", model: "claude-sonnet-5-5" };
      yield { type: "done", text: "ok" };
    },
  };
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => status(id) },
  });
  const question = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev oi",
  });
  await drainOutbox(f.db, handlers);
  // What the first run did shows in the next run's "# Recent actions".
  const [first] = await f.db.select().from(schema.agentRuns).orderBy(asc(schema.agentRuns.createdAt));
  if (!first) throw new Error("no run");
  await addRunStep(f.db, first, "tool_result", { name: "list_issues", content: "3 open issues", isError: false });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev e agora?",
    threadId: question.id,
  });
  await drainOutbox(f.db, handlers);

  expect(seen).toHaveLength(2);
  const [one, two] = seen;
  // The same system text on both turns: a resumed session keeps its cached history.
  expect(two?.turn.session?.resume).toBe(true);
  expect(two?.system).toBe(one?.system as string);
  expect(two?.system).not.toContain("# Recent actions");
  expect(two?.prompt).toContain("## Recent actions in this thread\nWhat the agents already did here");
  expect(two?.prompt).toContain("@dev list_issues → 3 open issues (ok)");
  // Found for the trigger: the end of "# This turn", where "You start in …" goes before.
  expect((two?.turn as { thisTurnFound?: string } | undefined)?.thisTurnFound ?? "").toStartWith(
    "## Recent actions in this thread",
  );
  // The person's message once, with its author ("[Owner]: @dev oi" used to come again after "Now answer this").
  expect(one?.prompt.match(/@dev oi/g)).toHaveLength(1);
  expect(two?.prompt.match(/e agora\?/g)).toHaveLength(1);
  expect(two?.prompt).toMatch(/Now answer this:\n\n\[[^\]]+\]: @dev e agora\?$|\n\n\[[^\]]+\]: @dev e agora\?$/);
});

/** The agent on a paired computer with `brain`, the computer reporting `protocol`. */
async function onComputer(brain: "claude_code" | "codex", protocol: number) {
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "MacBook",
    hostname: "mac",
    os: "darwin",
    arch: "arm64",
    version: "0.8.0",
    protocol,
    workspace: "/Users/w/agentes",
    exec: true,
  });
  await f.db.update(schema.agents).set({ machineId: paired.machineId, brain }).where(eq(schema.agents.id, f.agent.id));
  return (id: string): MachineStatus => ({
    id,
    orgId: f.org.id,
    name: "MacBook",
    online: true,
    execAllowed: true,
    os: "darwin",
    protocol,
    executors: {
      claude: { version: "2.1.300", loggedIn: true },
      codex: { version: "codex-cli 0.163.0" },
      detectedAt: new Date().toISOString(),
    },
  });
}

test("the quiet window's checkouts sync is the turn's own, its start picked again from what came in meanwhile", async () => {
  f = await setup({ quietMs: 300 });
  const status = await onComputer("claude_code", MACHINE_PROTOCOL_VERSION);
  const codes: (CodeSetup | null | undefined)[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      codes.push(await turn.code);
      yield { type: "done", text: "ok" };
    },
  };
  let syncs = 0;
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => status(id) },
    prepareCode: async () => {
      // The person adds a line while the checkouts sync, naming the other repository.
      if (++syncs === 1)
        await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
          body: "é no billing-api",
        });
      return {
        cwd: "repos/acme/web-app",
        prompt: "# Your code",
        start: "You start in repos/acme/web-app.",
        pick: {
          present: [
            { repo: "acme/web-app", dir: "repos/acme/web-app" },
            { repo: "acme/billing-api", dir: "repos/acme/billing-api" },
          ],
          primary: "acme/web-app",
        },
      };
    },
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev o deploy quebrou",
  });
  await drainOutbox(f.db, handlers);
  expect(syncs).toBe(1);
  expect(codes).toHaveLength(1);
  expect(codes[0]?.cwd).toBe("repos/acme/billing-api");
  expect(codes[0]?.start).toBe("You start in repos/acme/billing-api.");
  expect(codes[0]?.prompt).toBe("# Your code");
});

test("no early checkouts sync for Codex on a runner that never uses its checkouts", async () => {
  f = await setup({ quietMs: 50 });
  const status = await onComputer("codex", CODEX_FOLDER_PROTOCOL - 1);
  let ran = 0;
  const brain: Brain = {
    kind: "codex",
    async *run() {
      ran++;
      yield { type: "done", text: "ok" };
    },
  };
  let syncs = 0;
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { codex: () => brain },
    machines: { status: async (id) => status(id) },
    prepareCode: async () => {
      syncs++;
      return null;
    },
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
  await drainOutbox(f.db, handlers);
  expect(ran).toBe(1);
  expect(syncs).toBe(0);
});
