import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { RealtimeEvent } from "@agenteschat/adapters";
import { and, asc, eq, schema } from "@agenteschat/db";
import {
  absorbToolData,
  addChannelMember,
  CODE_SESSION_HIDDEN_TOOLS,
  type CodeSuggestion,
  codeSessionOf,
  codeSuggestionApplies,
  codeSuggestionOf,
  createCodeSuggestionToolSource,
  getMessage,
  insertMessage,
  keepCodeSuggestionHere,
  openCodeSuggestion,
  SUGGEST_CODE_SESSION_TOOL,
  type ToolContext,
  type ToolSideEffects,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * A code session suggested in the chat (ADR 0215 §11): who gets the tool, what it leaves on the reply, where it refuses,
 * and the person's two answers, "Abrir sessão" and "Fazer aqui".
 */

setDefaultTimeout(30_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const ASK = "O botão de concluir não salva com o filtro ligado, consegue arrumar?";

/** Dev thinks on a computer (Claude Code), as an agent that programs does. */
async function programmer() {
  const [machine] = await f.db.insert(schema.machines).values({ orgId: f.org.id, name: "Mac" }).returning();
  await f.db
    .update(schema.agents)
    .set({ brain: "claude_code", machineId: machine?.id })
    .where(eq(schema.agents.id, f.agent.id));
}

/** A person's request in `channelId` (or an agent's, with `byAgent`), and Dev's run over it, at work. */
async function runOver(channelId: string, options: { byAgent?: boolean; background?: boolean; body?: string } = {}) {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: options.byAgent
      ? { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null }
      : { type: "person", userId: f.owner.id },
    body: options.body ?? ASK,
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
      hop: trigger.hop + 1,
      status: "running",
      startedAt: new Date(),
      background: options.background ?? false,
    })
    .returning();
  if (!run) throw new Error("no run");
  return { run, trigger };
}

const ctxOf = (run: Awaited<ReturnType<typeof runOver>>["run"]): ToolContext => ({
  db: f.db,
  orgId: run.orgId,
  agentId: run.agentId,
  runId: run.id,
  channelId: run.channelId,
  threadRootId: run.threadRootId,
  triggerMessageId: run.triggerMessageId,
  ...(run.background ? { background: true } : {}),
});

/** The tool as a conversation of the main timeline lists it, called from `ctx` (where a stale list may still have it). */
async function suggest(ctx: ToolContext, input: Record<string, unknown>) {
  const [tool] = await createCodeSuggestionToolSource().tools({ ...ctx, channelId: f.general.id, threadRootId: "" });
  if (!tool) throw new Error("the tool isn't listed");
  return tool.execute(input, ctx);
}

const listed = async (ctx: ToolContext) => (await createCodeSuggestionToolSource().tools(ctx)).map((t) => t.name);

/** A channel of kind `code` (a session's conversation), Dev in it. */
async function codeChannel() {
  const [channel] = await f.db
    .insert(schema.channels)
    .values({
      orgId: f.org.id,
      name: "code-1234abcd",
      kind: "code",
      visibility: "private",
      createdByUserId: f.owner.id,
    })
    .returning();
  if (!channel) throw new Error("no channel");
  return channel;
}

describe("suggest_code_session", () => {
  test("listed only for an agent that programs on a computer, in a run a person can answer", async () => {
    f = await setup();
    const { run } = await runOver(f.general.id);
    expect(await createCodeSuggestionToolSource().tools(ctxOf(run))).toEqual([]);
    await programmer();
    expect((await createCodeSuggestionToolSource().tools(ctxOf(run))).map((t) => t.name)).toEqual([
      SUGGEST_CODE_SESSION_TOOL,
    ]);
    expect(await createCodeSuggestionToolSource().tools({ ...ctxOf(run), background: true })).toEqual([]);
    // In a session the gateway hides it from every brain, and the prompt never speaks of it there.
    expect(CODE_SESSION_HIDDEN_TOOLS.has(SUGGEST_CODE_SESSION_TOOL)).toBe(true);
    expect(await codeSuggestionApplies(f.db, run)).toBe(true);
    const inSession = await runOver((await codeChannel()).id);
    expect(await codeSuggestionApplies(f.db, inSession.run)).toBe(false);
  });

  test("the reply carries the project, a title and the person's own words, for them to decide", async () => {
    f = await setup();
    await programmer();
    const { run, trigger } = await runOver(f.general.id);
    const out = await suggest(ctxOf(run), { project: "tarefas/", title: "  Tarefa feita volta   ao recarregar " });
    expect(out.isError).toBeFalsy();
    const suggestion = codeSuggestionOf({ codeSuggestion: out.data?.codeSuggestion });
    expect(suggestion).toMatchObject({
      agentId: f.agent.id,
      repo: "tarefas",
      title: "Tarefa feita volta ao recarregar",
      request: ASK,
      requestMessageId: trigger.id,
      askerId: f.owner.id,
      status: "pending",
    });
    // It rides on the run's next reply: the executor's side effects keep the newest one.
    const t: ToolSideEffects = {};
    absorbToolData(t, out.data);
    expect(t.codeSuggestion?.id).toBe(suggestion?.id);
    // No title: the request's first sentence.
    const untitled = await suggest(ctxOf(run), { project: "tarefas", title: "" });
    expect(codeSuggestionOf({ codeSuggestion: untitled.data?.codeSuggestion })?.title).toBe(
      "O botão de concluir não salva com o filtro ligado, consegue arrumar",
    );
  });

  test("refused in a session, to another agent's message, and for what isn't a project", async () => {
    f = await setup();
    await programmer();
    const session = await runOver((await codeChannel()).id);
    expect(await listed(ctxOf(session.run))).toEqual([]);
    expect((await suggest(ctxOf(session.run), { project: "tarefas", title: "X" })).isError).toBe(true);
    const fromAgent = await runOver(f.general.id, { byAgent: true });
    expect((await suggest(ctxOf(fromAgent.run), { project: "tarefas", title: "X" })).isError).toBe(true);
    const { run } = await runOver(f.general.id);
    for (const project of ["../etc", "../..", "a b", ".hidden"]) {
      const bad = await suggest(ctxOf(run), { project, title: "X" });
      expect(bad.isError).toBe(true);
      expect(bad.data?.codeSuggestion).toBeUndefined();
    }
  });

  test("never in a task's conversation or a mission's thread: the change is made there, as before", async () => {
    f = await setup();
    await programmer();
    const [task] = await f.db
      .insert(schema.channels)
      .values({
        orgId: f.org.id,
        name: "task-1234abcd",
        kind: "task",
        visibility: "private",
        createdByUserId: f.owner.id,
      })
      .returning();
    const inTask = await runOver(task?.id ?? "");
    expect(await codeSuggestionApplies(f.db, inTask.run)).toBe(false);
    expect(await listed(ctxOf(inTask.run))).toEqual([]);
    const fromTask = await suggest(ctxOf(inTask.run), { project: "tarefas", title: "X" });
    expect(fromTask.isError).toBe(true);
    expect(fromTask.content).toContain("do the change here");

    const inMission = await runOver(f.general.id);
    await f.db.insert(schema.missions).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: inMission.run.threadRootId as string,
      ownerId: f.owner.id,
      title: "Filtro das tarefas",
      goal: "Concluir salva com o filtro ligado",
      mainSessionId: crypto.randomUUID(),
    });
    expect(await codeSuggestionApplies(f.db, inMission.run)).toBe(false);
    expect(await listed(ctxOf(inMission.run))).toEqual([]);
    expect((await suggest(ctxOf(inMission.run), { project: "tarefas", title: "X" })).isError).toBe(true);
    // The same request in the channel, outside the mission: suggested.
    expect(await codeSuggestionApplies(f.db, (await runOver(f.general.id)).run)).toBe(true);
  });
});

describe("the person's answer", () => {
  /** Dev's reply in #general carrying a suggestion for Ana's (the owner's) request. */
  async function suggested() {
    await programmer();
    const { run, trigger } = await runOver(f.general.id);
    const suggestion: CodeSuggestion = {
      id: "s-1",
      agentId: f.agent.id,
      repo: "tarefas",
      title: "Tarefa feita volta ao recarregar",
      request: ASK,
      requestMessageId: trigger.id,
      askerId: f.owner.id,
      status: "pending",
    };
    const reply = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: run.id, hop: 1 },
      body: "Consigo: sugiro uma sessão para mexer numa cópia só dessa mudança.",
      meta: { codeSuggestion: suggestion },
    });
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, run.id));
    return { run, reply };
  }
  const notices = () =>
    f.db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.channelId, f.general.id), eq(schema.messages.authorAgentId, f.agent.id)))
      .orderBy(asc(schema.messages.createdAt))
      .then((rows) =>
        rows.filter((m) => (m.meta as { notice?: { kind?: string } }).notice?.kind === "proposal_result"),
      );
  const cardOf = async (messageId: string) => codeSuggestionOf((await getMessage(f.db, f.org.id, messageId))?.meta);

  test("Fazer aqui: only who asked; the card says it, the agent goes on here; a second answer is refused", async () => {
    f = await setup();
    const { reply } = await suggested();
    const events: RealtimeEvent[] = f.listen(f.general.id);
    const other = await addMember(f.db, f.org.id, "member", "Bia");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: other.id });
    await expect(
      keepCodeSuggestionHere({ db: f.db, pubsub: f.pubsub }, other.id, f.org.id, reply.id),
    ).rejects.toMatchObject({ code: "code_session.suggestion_not_yours" });
    const runsBefore = (await f.db.select().from(schema.agentRuns)).length;
    const kept = await keepCodeSuggestionHere({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, reply.id);
    expect(kept).toMatchObject({ status: "here", by: f.owner.id });
    expect((await cardOf(reply.id))?.status).toBe("here");
    expect(events.some((e) => e.type === "code.suggestion")).toBe(true);
    // Told, and woken to do it here.
    const [told] = await notices();
    expect((told?.meta as { notice?: { text?: string } } | undefined)?.notice?.text).toContain("keep it here");
    expect((await f.db.select().from(schema.agentRuns)).length).toBe(runsBefore + 1);
    await expect(
      keepCodeSuggestionHere({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, reply.id),
    ).rejects.toMatchObject({ code: "code_session.suggestion_gone" });
  });

  test("Abrir sessão: their words start it, with the suggestion's title and the way back here", async () => {
    f = await setup();
    const { reply } = await suggested();
    const posted: string[] = [];
    const deps = {
      db: f.db,
      pubsub: f.pubsub,
      postRequest: async (_channelId: string, _rootId: string, text: string) => void posted.push(text),
    };
    const session = await openCodeSuggestion(deps, f.owner.id, f.org.id, reply.id);
    expect(session.title).toBe("Tarefa feita volta ao recarregar");
    expect(session.repo).toBe("tarefas");
    expect(posted).toEqual([ASK]);
    expect(session.from).toMatchObject({ channelId: f.general.id, messageId: reply.id, kind: "channel" });
    const root = await getMessage(f.db, f.org.id, session.rootId);
    expect(codeSessionOf(root?.meta)?.from).toEqual({ channelId: f.general.id, messageId: reply.id, threadId: null });
    expect(await cardOf(reply.id)).toMatchObject({ status: "opened", sessionId: session.id, by: f.owner.id });
    // Told where the work went, without a run here.
    const [told] = await notices();
    expect((told?.meta as { notice?: { text?: string } } | undefined)?.notice?.text).toContain("in that session");
    await expect(openCodeSuggestion(deps, f.owner.id, f.org.id, reply.id)).rejects.toMatchObject({
      code: "code_session.suggestion_gone",
    });
  });

  test("a session that can't open leaves the suggestion waiting again", async () => {
    f = await setup();
    const { reply } = await suggested();
    // Its computer went away since it suggested.
    await f.db.update(schema.agents).set({ machineId: null }).where(eq(schema.agents.id, f.agent.id));
    const deps = { db: f.db, pubsub: f.pubsub, postRequest: async () => {} };
    await expect(openCodeSuggestion(deps, f.owner.id, f.org.id, reply.id)).rejects.toMatchObject({
      code: "code_session.no_computer",
    });
    expect((await cardOf(reply.id))?.status).toBe("pending");
  });
});
