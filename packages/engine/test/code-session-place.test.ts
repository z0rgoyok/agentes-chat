import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  bridgeToolsFor,
  CODE_SESSION_HIDDEN_TOOLS,
  codeSessionContext,
  codeSessionFile,
  codeStartOptions,
  createCodeSuggestionToolSource,
  drainOutbox,
  insertMessage,
  orgOverview,
  postPersonMessage,
  resolveBrain,
  SUGGEST_CODE_SESSION_TOOL,
  saveCodeSessionFile,
  type ToolContext,
  updateSandboxSettings,
  worksInSessions,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { connectedComputer, type FakeRunnerOptions, pairMachine, RUNNER } from "./machine-fixtures";

/**
 * A code session is the run's place (ADR 0215 §3): the session's computer and worktree, read once, where a computer
 * brain's turn opens and the engine's code tools work, whichever brain thinks. Who may have a session, and what a
 * session hides from every brain.
 */

setDefaultTimeout(30_000);

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const WORKTREE = ".worktrees/c-1a2b3c4d";

/** Dev's session on acme/app, its worktree on `machineId` (ready unless said), the owner and Dev in it. */
async function session(machineId: string | null, worktreeState: "ready" | "preparing" = "ready") {
  const [channel] = await f.db
    .insert(schema.channels)
    .values({
      orgId: f.org.id,
      name: "code-1a2b3c4d",
      kind: "code",
      visibility: "private",
      createdByUserId: f.owner.id,
    })
    .returning();
  const channelId = channel?.id ?? "";
  const root = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: { type: "person", userId: f.owner.id },
    body: "Code session",
  });
  await f.db.insert(schema.channelMembers).values([
    { orgId: f.org.id, channelId, userId: f.owner.id },
    { orgId: f.org.id, channelId, agentId: f.agent.id, autoReply: true },
  ]);
  await f.db.insert(schema.codeSessions).values({
    orgId: f.org.id,
    channelId,
    rootMessageId: root.id,
    agentId: f.agent.id,
    machineId,
    repo: "acme/app",
    repoDir: "repos/acme/app",
    title: "Fix the login",
    branch: "agentes/dev/fix-login-1a2b",
    worktreePath: WORKTREE,
    worktreeState,
    createdBy: f.owner.id,
  });
  return channelId;
}

/** A run of Dev's over the owner's message in `channelId`, with the tool context its executor gives it. */
async function runIn(channelId: string): Promise<ToolContext> {
  const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId, {
    body: "@dev oi",
  });
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, msg.id));
  if (!run) throw new Error("no run");
  const codeSession = await codeSessionContext(f.db, f.org.id, channelId, f.agent.id);
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: msg.id,
    ...(codeSession ? { codeSession } : {}),
  };
}

/** A run row of Dev's in `channelId`, at work, not run by the engine (its brain plan is read by hand). */
async function runRow(channelId: string) {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: { type: "person", userId: f.owner.id },
    body: "@dev oi",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
      startedAt: new Date(),
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

const pair = async (name: string) =>
  (await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name, ...RUNNER, exec: true })).machineId;

const call = async (ctx: ToolContext, name: string, input: Record<string, unknown>) => {
  const outcome = await f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input });
  if (outcome?.type !== "result") throw new Error(`expected a result, got ${outcome?.type}`);
  return outcome.output;
};

const text = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : undefined);

describe("the session's place", () => {
  test("its own agent works in the worktree while it is ready on the computer it uses; anyone else in their folder", async () => {
    f = await setup();
    const mac = await pair("Mac");
    const box = await pair("Box");
    await f.db.update(schema.agents).set({ machineId: mac }).where(eq(schema.agents.id, f.agent.id));
    const channelId = await session(mac);
    const here = () => codeSessionContext(f.db, f.org.id, channelId, f.agent.id);
    expect(await here()).toEqual({ place: { machineId: mac, cwd: WORKTREE } });
    // An agent called in is in the session, with no place: it works in its own folder.
    expect(await codeSessionContext(f.db, f.org.id, channelId, crypto.randomUUID())).toEqual({ place: null });
    // Moved to another computer since: nothing goes to the one it left.
    await f.db.update(schema.agents).set({ machineId: box }).where(eq(schema.agents.id, f.agent.id));
    expect((await here())?.place).toBeNull();
    expect((await here())?.unavailable).toContain("a computer you no longer use");
    await f.db.update(schema.agents).set({ machineId: mac }).where(eq(schema.agents.id, f.agent.id));
    // Still being prepared, or gone: no place, and the agent reads why.
    await f.db.update(schema.codeSessions).set({ worktreeState: "preparing" });
    expect((await here())?.unavailable).toContain("still being prepared");
    await f.db.update(schema.codeSessions).set({ worktreeState: "removed" });
    expect((await here())?.unavailable).toContain("is gone");
    await f.db.update(schema.codeSessions).set({ worktreeState: "ready", archivedAt: new Date() });
    expect((await here())?.unavailable).toContain("is gone");
    // Any other conversation: no session at all.
    expect(await codeSessionContext(f.db, f.org.id, f.general.id, f.agent.id)).toBeNull();
  });

  test("a computer brain's turn opens in the worktree, on the session's computer", async () => {
    f = await setup();
    const mac = await pair("Mac");
    await f.db
      .update(schema.agents)
      .set({ machineId: mac, brain: "claude_code" })
      .where(eq(schema.agents.id, f.agent.id));
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    if (!agent) throw new Error("no agent");
    const channelId = await session(mac);
    const run = await runRow(channelId);
    const codeSession = await codeSessionContext(f.db, f.org.id, channelId, f.agent.id);
    const plan = await resolveBrain({ db: f.db }, agent, run, run.threadRootId, { codeSession });
    expect(plan.session).toMatchObject({ machineId: mac, cwd: WORKTREE, codeSession: true });
    // With no session, the same agent's turn starts in its own folder.
    const chat = await resolveBrain({ db: f.db }, agent, await runRow(f.general.id), f.general.id);
    expect(chat.session).toMatchObject({ machineId: mac, cwd: "" });
    expect(chat.session?.codeSession).toBeUndefined();
  });
});

describe("who can have a session", () => {
  test("a computer brain on a computer, Run code or not; no computer, no session", async () => {
    f = await setup();
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    if (!agent) throw new Error("no agent");
    const mac = await pair("Mac");
    expect(await worksInSessions(f.db, { ...agent, brain: "codex", machineId: mac })).toBe(true);
    expect(await worksInSessions(f.db, { ...agent, brain: "opencode", machineId: mac })).toBe(true);
    expect(await worksInSessions(f.db, { ...agent, brain: "cursor", machineId: null })).toBe(false);
    // Through the API with no Run code: nothing to work in the worktree with.
    expect(await worksInSessions(f.db, { ...agent, brain: "model", machineId: mac })).toBe(false);
  });

  test("an API agent with Run code on a computer: Code offers it, it starts sessions and suggests them", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    await connectedComputer(f);
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: "r",
      channelId: f.general.id,
      threadRootId: "",
      background: false,
    } as ToolContext;
    expect((await orgOverview(f.db, f.owner.id, f.org.id)).code).toBe(true);
    expect((await codeStartOptions(f.db, f.owner.id, f.org.id)).agents.map((a) => a.agentId)).toEqual([f.agent.id]);
    expect((await createCodeSuggestionToolSource().tools(ctx)).map((t) => t.name)).toEqual([SUGGEST_CODE_SESSION_TOOL]);

    // Run code denied: no session.
    await f.db.insert(schema.agentScopes).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      connectionId: null,
      scope: "deny:run_code",
    });
    expect((await codeStartOptions(f.db, f.owner.id, f.org.id)).agents).toEqual([]);
    expect((await createCodeSuggestionToolSource().tools(ctx)).map((t) => t.name)).toEqual([]);
  });

  test("the workspace's code environment off: no session for an API agent", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    await connectedComputer(f);
    await updateSandboxSettings(f.db, f.owner.id, f.org.id, { enabled: false });
    expect((await orgOverview(f.db, f.owner.id, f.org.id)).code).toBe(false);
    expect((await codeStartOptions(f.db, f.owner.id, f.org.id)).agents).toEqual([]);
  });
});

describe("the engine's code tools in the session", () => {
  test("files are the worktree's, named from it, never above it; commands run there; outside nothing changes", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    const execs: Parameters<NonNullable<FakeRunnerOptions["exec"]>>[0][] = [];
    const { paired, runner } = await connectedComputer(f, {
      exec: (req) => {
        execs.push(req);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });
    const inSession = await runIn(await session(paired.machineId));
    expect(inSession.codeSession?.place).toEqual({ machineId: paired.machineId, cwd: WORKTREE });

    const wrote = await call(inSession, "write_file", { path: "src/login.ts", content: "const a = 1;\n" });
    expect(wrote.content).toBe("Wrote src/login.ts (13 bytes).");
    expect(text(runner.files.get(`${WORKTREE}/src/login.ts`))).toBe("const a = 1;\n");
    const read = await call(inSession, "read_file", { path: "src/login.ts" });
    expect(read.content).toStartWith("src/login.ts (13 bytes;");
    expect(read.content).toContain("const a = 1;");
    expect((await call(inSession, "read_file", { path: "src/none.ts" })).content).toBe("No file src/none.ts.");
    expect((await call(inSession, "write_file", { path: "../escape.ts", content: "x" })).isError).toBe(true);
    expect((await call(inSession, "write_file", { path: "", content: "x" })).isError).toBe(true);
    // A path given from the agent's folder is the same file, never the worktree inside itself.
    const again = await call(inSession, "write_file", { path: `${WORKTREE}/src/login.ts`, content: "const b = 2;\n" });
    expect(again.content).toBe("Wrote src/login.ts (13 bytes).");
    expect(text(runner.files.get(`${WORKTREE}/src/login.ts`))).toBe("const b = 2;\n");
    // Listed as the agent passes them back: from the worktree.
    const listed = await call(inSession, "list_files", { path: "src" });
    expect(listed.content).toContain("src/login.ts (13 bytes)");
    expect(listed.content).not.toContain(WORKTREE);

    await call(inSession, "run_code", { language: "bash", code: "git status" });
    const ran = execs.at(-1);
    expect(ran?.cwd).toBe(WORKTREE);
    expect(ran?.command).toMatch(/^bash \.\.\/\.\.\/\.agentes\/run-\d+\.sh$/);

    const outside = await runIn(f.general.id);
    expect(outside.codeSession).toBeUndefined();
    await call(outside, "run_code", { language: "bash", code: "ls" });
    expect(execs.at(-1)?.cwd).toBeUndefined();
    expect(execs.at(-1)?.command).toMatch(/^bash \.agentes\/run-\d+\.sh$/);
    expect((await call(outside, "write_file", { path: "notes.md", content: "x" })).content).toBe(
      "Wrote notes.md (1 bytes).",
    );
    expect(runner.files.has("notes.md")).toBe(true);
  });

  test("with no worktree there, the tools refuse instead of working in the agent's own folder", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    const execs: Parameters<NonNullable<FakeRunnerOptions["exec"]>>[0][] = [];
    const { paired, runner } = await connectedComputer(f, {
      exec: (req) => {
        execs.push(req);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });
    const channelId = await session(paired.machineId, "preparing");
    const ctx = await runIn(channelId);
    expect(ctx.codeSession?.place).toBeNull();
    const ran = await call(ctx, "run_code", { language: "bash", code: "rm -rf dist" });
    expect(ran.isError).toBe(true);
    expect(ran.content).toContain("still being prepared");
    expect(execs).toEqual([]);
    expect((await call(ctx, "write_file", { path: "src/a.ts", content: "x" })).isError).toBe(true);
    expect(runner.files.has("src/a.ts")).toBe(false);
  });

  test("what makes no sense in a session is hidden from every brain, through the gateway and the bridge", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    const { paired } = await connectedComputer(f);
    const inSession = await runIn(await session(paired.machineId));
    const outside = await runIn(f.general.id);
    const names = async (ctx: ToolContext) => ((await f.tools?.list(ctx)) ?? []).map((t) => t.name);
    expect(await names(outside)).toEqual(expect.arrayContaining(["upload_file", "export_file"]));
    const here = await names(inSession);
    expect(here).toContain("run_code");
    expect(here.filter((n) => CODE_SESSION_HIDDEN_TOOLS.has(n))).toEqual([]);
    expect((await call(inSession, "upload_file", { path: "shot.png" })).isError).toBe(true);
    // A computer brain's calls come through the bridge, which finds the session from the run itself.
    const bridged = await bridgeToolsFor(
      { db: f.db, pubsub: f.pubsub, tools: f.tools },
      { orgId: f.org.id, agentId: f.agent.id, runId: inSession.runId, machineId: paired.machineId },
    );
    expect(bridged.map((t) => t.name).filter((n) => CODE_SESSION_HIDDEN_TOOLS.has(n))).toEqual([]);
    expect(bridged.map((t) => t.name)).toContain("run_code");
  });
});

describe("a person edits a file of the session", () => {
  /** A computer whose worktree holds `src/a.ts` at `rev`; `dist/out.js` is ignored by git. */
  async function editing(rev: string) {
    f = await setup({ machines: true });
    const { paired, runner } = await connectedComputer(f, {
      exec: (req) => {
        if (req.command.includes("'dist/out.js'")) return { exitCode: 0, stdout: "ignored\n", stderr: "" };
        return { exitCode: 0, stdout: `ok 12 ${rev}\nexport const a = 1;\n`, stderr: "" };
      },
    });
    const channelId = await session(paired.machineId);
    const [row] = await f.db.select().from(schema.codeSessions).where(eq(schema.codeSessions.channelId, channelId));
    const deps = { db: f.db, pubsub: f.pubsub, hub: f.machineHub };
    const save = (input: { path: string; content: string; rev: string; overwrite?: boolean }) =>
      saveCodeSessionFile(deps, f.owner.id, f.org.id, row?.id ?? "", input);
    const written = (path: string) => {
      const data = runner.files.get(`${WORKTREE}/${path}`);
      return data ? new TextDecoder().decode(data) : null;
    };
    return { deps, row, save, written };
  }

  test("the file as read comes with what it holds, and a save from it lands in the worktree as the agent", async () => {
    const { deps, row, save, written } = await editing("abc123");
    const read = await codeSessionFile(deps, f.owner.id, f.org.id, row?.id ?? "", "src/a.ts");
    expect(read).toMatchObject({ state: "ok", rev: "abc123", content: "export const a = 1;\n" });
    const saved = await save({ path: "src/a.ts", content: "export const a = 2;\r\n", rev: read.rev });
    expect(written("src/a.ts")).toBe("export const a = 2;\r\n");
    expect(saved.state).toBe("ok");
  });

  test("a file that changed since it was opened is refused, unless the person says theirs wins", async () => {
    const { save, written } = await editing("newer");
    await expect(save({ path: "src/a.ts", content: "mine", rev: "older" })).rejects.toMatchObject({
      code: "code_session.file_changed",
    });
    expect(written("src/a.ts")).toBeNull();
    await save({ path: "src/a.ts", content: "mine", rev: "older", overwrite: true });
    expect(written("src/a.ts")).toBe("mine");
  });

  test("never a `.env` file, one git ignores, a path out of the worktree, or for someone outside the session", async () => {
    const { deps, row, save, written } = await editing("abc123");
    const locked = { code: "code_session.file_locked" };
    const outsider = await addMember(f.db, f.org.id, "member", "Rafa");
    await expect(save({ path: ".env.local", content: "KEY=1", rev: "abc123" })).rejects.toMatchObject(locked);
    await expect(save({ path: "dist/out.js", content: "x", rev: "abc123" })).rejects.toMatchObject(locked);
    await expect(save({ path: "../a.ts", content: "x", rev: "abc123" })).rejects.toMatchObject({
      code: "code_session.file_path",
    });
    await expect(save({ path: ".git/config", content: "x", rev: "abc123" })).rejects.toMatchObject({
      code: "code_session.file_path",
    });
    await expect(
      saveCodeSessionFile(deps, outsider.id, f.org.id, row?.id ?? "", {
        path: "src/a.ts",
        content: "x",
        rev: "abc123",
      }),
    ).rejects.toThrow();
    expect(written("src/a.ts")).toBeNull();
    expect(written(".env.local")).toBeNull();
  });
});
