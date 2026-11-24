import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  activeRunsIn,
  createAgent,
  createJobHandlers,
  ELSEWHERE_SURE,
  type Judge,
  type JudgeAnswer,
  type JudgeRequest,
  type OutboxJob,
  openDm,
  postPersonMessage,
  type RouterStrategy,
  STEER_SURE,
  type SteerHandling,
  steerHandling,
  stopChecksSettled,
  type TalkerInput,
  talkerPolicy,
} from "../src";
import { RUN_INTERRUPT_TOPIC } from "../src/cancel";
import { markTriage, releaseInbox, stoppedToSend, TRIAGE_GRACE_MS, takeInbox, unreadNow } from "../src/run-inbox";
import { type AgentRun, addRunStep } from "../src/runs";
import { ROUTE_RELEASED_JOB } from "../src/steering";
import { answerSteering, type Fixture, setup } from "./fixtures";

/**
 * The triage of a message a person sends an agent while it works for them (ADR 0112 addendum): one judgment says how
 * the agent takes it, and the engine does that: a stop, a correction now, a separate request after the task, a quick
 * reply at once, or the next pause as before.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** The ways the triage was offered in a request it got. */
const offered = (request: JudgeRequest | undefined) =>
  Object.keys((request?.questions.handling as { criteria?: Record<string, string> } | undefined)?.criteria ?? {});

/** A judge that answers the triage with `answer` and records what it was asked. */
function asking(answer: JudgeAnswer | undefined) {
  const seen: JudgeRequest[] = [];
  const judge: Judge = {
    name: "fake",
    ask: async (request): Promise<Record<string, JudgeAnswer>> => {
      seen.push(request);
      return answer ? { handling: answer } : {};
    },
  };
  return { judge, seen };
}

describe("steerHandling", () => {
  const input = { orgId: "o", text: "não é outubro, é setembro", agentName: "Dev", task: "Relatório de outubro" };

  test("the way the judge is sure of, with what the agent works on", async () => {
    const sure = asking({ choice: "interrupt", probabilities: { interrupt: 0.82, add: 0.18 } });
    expect(await steerHandling(sure.judge, input)).toBe("interrupt");
    expect(sure.seen[0]).toMatchObject({
      kind: "steer_triage",
      state: { agent: "Dev", task_in_progress: "Relatório de outubro", message: "não é outubro, é setembro" },
    });
    const question = sure.seen[0]?.questions.handling as { type: string; criteria: Record<string, string> };
    expect(question.type).toBe("choice");
    expect(Object.keys(question.criteria)).toEqual(["stop", "interrupt", "add", "answer", "queue"]);
  });

  test("anything it isn't sure of, or doesn't say, is read at the next pause, as before", async () => {
    const unsure = asking({ choice: "queue", probabilities: { queue: STEER_SURE - 0.01, add: 0.41 } });
    expect(await steerHandling(unsure.judge, input)).toBe("add");
    expect(await steerHandling(asking(undefined).judge, input)).toBe("add");
    expect(await steerHandling(asking({ choice: "dance", probabilities: { dance: 1 } }).judge, input)).toBe("add");
  });

  test("in a channel others share it may be for someone else, taken so only when the judge is quite sure", async () => {
    const shared = { ...input, text: "Maria, viu o e-mail do cliente?", shared: { fromAsker: true } };
    const sure = asking({ choice: "elsewhere", probabilities: { elsewhere: ELSEWHERE_SURE + 0.05, add: 0.2 } });
    expect(await steerHandling(sure.judge, shared)).toBe("elsewhere");
    expect(offered(sure.seen[0])).toEqual(["stop", "interrupt", "add", "answer", "queue", "elsewhere"]);
    expect(sure.seen[0]?.state).toMatchObject({ written_by: "the person who asked for the task" });
    // Sure enough for any other way, not for this one: a follow-up of theirs the agent never reads costs more.
    const unsure = asking({ choice: "elsewhere", probabilities: { elsewhere: ELSEWHERE_SURE - 0.05, add: 0.3 } });
    expect(await steerHandling(unsure.judge, shared)).toBe("add");
    // Where it isn't asked (a DM, a message @mentioning the agent), an answer naming it is no answer.
    const unasked = asking({ choice: "elsewhere", probabilities: { elsewhere: 0.99 } });
    expect(await steerHandling(unasked.judge, input)).toBe("add");
    expect(offered(unasked.seen[0])).not.toContain("elsewhere");
  });

  test("without the task it says the agent is at work; nothing written asks nothing", async () => {
    const bare = asking({ choice: "stop", probabilities: { stop: 0.9 } });
    expect(await steerHandling(bare.judge, { ...input, text: "para", task: null })).toBe("stop");
    expect(bare.seen[0]?.state).toEqual({ agent: "Dev", agent_is_working_on_a_task: true, message: "para" });
    const none = asking({ choice: "stop", probabilities: { stop: 1 } });
    expect(await steerHandling(none.judge, { ...input, text: "  " })).toBe("add");
    expect(none.seen).toHaveLength(0);
  });
});

test("the fast reply answers a quick question or a separate request at once, even from a task that reads soon", () => {
  const at = new Date("2026-11-18T12:00:00Z");
  const base = {
    run: { status: "running" as const, background: false, startedAt: new Date(at.getTime() - 5_000) },
    brain: "model",
    message: { body: "tá funcionando?", createdAt: at },
    waited: null,
    lastActivityAt: new Date(at.getTime() - 2_000),
    lastReplyAt: null,
    now: at,
  };
  expect(talkerPolicy(base)).toBe("reads_soon");
  expect(talkerPolicy({ ...base, handling: "add" })).toBe("reads_soon");
  expect(talkerPolicy({ ...base, handling: "answer" })).toBeNull();
  expect(talkerPolicy({ ...base, handling: "queue" })).toBeNull();
  // Still one fast reply per run in its window, and never for background work.
  expect(talkerPolicy({ ...base, handling: "answer", lastReplyAt: new Date(at.getTime() - 5_000) })).toBe(
    "rate_limited",
  );
  expect(talkerPolicy({ ...base, run: { ...base.run, background: true }, handling: "answer" })).toBe("background");
});

test("the fast reply leaves a message the agent answers itself, with its own line on the way", () => {
  const now = new Date("2026-11-24T12:00:00Z");
  const before = new Date(now.getTime() - 60_000);
  const busy = {
    run: { status: "running" as const, background: false, startedAt: before, createdAt: before },
    brain: "claude_code",
    message: { body: "não é outubro, é setembro", createdAt: now },
    waited: null,
    lastActivityAt: before,
    lastReplyAt: null,
    now,
  };
  expect(talkerPolicy(busy)).toBeNull();
  expect(talkerPolicy({ ...busy, ownLine: true })).toBe("own_line");
});

describe("a message sent while the agent works", () => {
  const deps = () => ({ db: f.db, pubsub: f.pubsub });
  const runs = () => f.db.select().from(schema.agentRuns);
  const runById = async (id: string) => (await runs()).find((r) => r.id === id);

  /** The triage as the judge says it, by the message's words (anything else: nothing said). */
  const triage = (by: Record<string, SteerHandling>): Judge => ({
    name: "fake",
    ask: async (request): Promise<Record<string, JudgeAnswer>> => {
      const way = request.kind === "steer_triage" ? by[String(request.state.message)] : undefined;
      return way ? { handling: { choice: way, probabilities: { [way]: 0.9 } } } : {};
    },
  });

  /**
   * The agent at work on a person's request (`brain`: what it thinks with); its thread takes what they send next.
   * `tool`: the tool its turn already called (`null`: none, it has only talked so far).
   */
  async function working(brain: "model" | "claude_code" = "model", tool: string | null = "run_code") {
    f = await setup();
    const question = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, {
      body: "@dev monta o relatório de outubro",
    });
    const [run] = await runs();
    if (!run) throw new Error("no run");
    await f.db
      .update(schema.agentRuns)
      .set({ status: "running", ...(brain === "model" ? {} : { brain }) })
      .where(eq(schema.agentRuns.id, run.id));
    if (tool) await addRunStep(f.db, run, "tool_call", { toolUseId: "c-1", name: tool, input: {} });
    return { run, threadId: question.id };
  }

  /** Sends `body` into the agent's thread with this judge (and a talker that records what it is handed). */
  async function send(threadId: string, body: string, judge: Judge) {
    const talked: TalkerInput[] = [];
    const sent = await postPersonMessage(
      { ...deps(), judge, talker: { consider: async (input) => void talked.push(input) } },
      f.owner.id,
      f.org.id,
      f.general.id,
      { body, threadId },
    );
    await stopChecksSettled();
    return { sent, talked };
  }

  test('"para" stops the task', async () => {
    const { run, threadId } = await working();
    await send(threadId, "para", triage({ para: "stop" }));
    expect((await runById(run.id))?.status).toBe("canceled");
  });

  test("a correction cuts the model call for it", async () => {
    const { run, threadId } = await working();
    const cut: unknown[] = [];
    f.pubsub.subscribe(RUN_INTERRUPT_TOPIC, (event) => void cut.push(event));
    const { sent } = await send(
      threadId,
      "não é outubro, é setembro",
      triage({ "não é outubro, é setembro": "interrupt" }),
    );
    expect(cut).toEqual([{ type: "run.interrupt", runId: run.id, messageId: sent.id }]);
    expect((await runById(run.id))?.pendingMessageIds).toContain(sent.id);
  });

  test("a quick question gets the fast reply at once; the task still reads it at its next pause", async () => {
    const { run, threadId } = await working();
    const { sent, talked } = await send(threadId, "tá funcionando?", triage({ "tá funcionando?": "answer" }));
    expect(talked.map((t) => [t.message.id, t.handling])).toEqual([[sent.id, "answer"]]);
    expect((await runById(run.id))?.pendingMessageIds).toContain(sent.id);
  });

  test("a separate request waits for the task's end, then gets a run of its own", async () => {
    const { run, threadId } = await working();
    const body = "depois vê por que o deploy de ontem falhou";
    const { sent, talked } = await send(threadId, body, triage({ [body]: "queue" }));
    const held = (await runById(run.id)) as AgentRun;
    expect(held.pendingMessageIds).not.toContain(sent.id);
    expect(held.afterMessageIds).toEqual([sent.id]);
    // What the apps read on load still counts it unread: a reload never says the agent read it.
    const listed = (await activeRunsIn(f.db, f.org.id, f.general.id)).find((r) => r.runId === run.id);
    expect(listed?.pendingMessageIds).toContain(sent.id);
    // The task's next step never reads it; the fast reply hears it comes after the task.
    expect(await takeInbox(f.db, run.id)).toEqual([]);
    expect(talked.map((t) => t.handling)).toEqual(["queue"]);
    // The task ends: the request goes on to a run of its own.
    await f.db
      .update(schema.agentRuns)
      .set({ status: "done", finishedAt: new Date() })
      .where(eq(schema.agentRuns.id, run.id));
    const handed = await releaseInbox(f.db, f.pubsub, held, { reason: "done" });
    expect(handed?.messageIds).toEqual([sent.id]);
    expect(handed?.runId).not.toBe(run.id);
    expect((await runById(run.id))?.afterMessageIds).toEqual([]);
  });

  test("while the run has only talked, a quick question or another request is part of what it answers", async () => {
    // Its line before slow work (`say_now`, ADR 0207) is talk too.
    for (const tool of [null, "react", "say_now"]) {
      const { run, threadId } = await working("model", tool);
      const question = await send(threadId, "tá funcionando?", triage({ "tá funcionando?": "answer" }));
      const request = await send(
        threadId,
        "e pesquisa hotéis em Recife",
        triage({ "e pesquisa hotéis em Recife": "queue" }),
      );
      const kept = (await runById(run.id)) as AgentRun;
      // Both read with its next step, nothing left for after it, and nothing answering in its place.
      expect(kept.pendingMessageIds).toEqual([question.sent.id, request.sent.id]);
      expect(kept.afterMessageIds).toEqual([]);
      expect([...question.talked, ...request.talked]).toEqual([]);
      await f.close();
    }
    f = undefined as unknown as Fixture;
  });

  test("anything else is read at the next pause, as before", async () => {
    const { run, threadId } = await working();
    const { sent, talked } = await send(threadId, "inclui o gráfico por região", triage({}));
    expect((await runById(run.id))?.pendingMessageIds).toContain(sent.id);
    expect((await runById(run.id))?.afterMessageIds).toEqual([]);
    expect(talked.map((t) => t.handling)).toEqual(["add"]);
  });

  test("what the triage said stays on the run's trail; a correction or an addition it was sure of is the agent's own to answer", async () => {
    const { run, threadId } = await working();
    const judge = triage({ "não é outubro, é setembro": "interrupt", "tá funcionando?": "answer" });
    const fixed = await send(threadId, "não é outubro, é setembro", judge);
    const asked = await send(threadId, "tá funcionando?", judge);
    const unsure = await send(threadId, "inclui o gráfico por região", judge);
    const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, run.id));
    const noted = steps.filter((s) => s.kind === "context" && s.data.steerTriage !== undefined).map((s) => s.data);
    expect(noted).toEqual([
      // People read this thread as it goes: the agent says in a line of its own how it takes the correction.
      { steerTriage: { messageId: fixed.sent.id, sure: true, line: true }, reason: "interrupt" },
      { steerTriage: { messageId: asked.sent.id, sure: true, line: false }, reason: "answer" },
      // Read at the next pause only because the judge said nothing: no line for it.
      { steerTriage: { messageId: unsure.sent.id, sure: false, line: false }, reason: "add" },
    ]);
    // Nothing speaks for the agent about the message it answers itself.
    expect(fixed.talked.map((t) => t.ownLine)).toEqual([true]);
    expect(asked.talked.map((t) => t.ownLine)).toEqual([false]);
    expect(unsure.talked.map((t) => t.ownLine)).toEqual([false]);
  });

  test("in a channel, a line for someone else never reaches the task: the router decides who answers it", async () => {
    const { run, threadId } = await working();
    const events = f.listen(f.general.id);
    const body = "Maria, você viu o e-mail do cliente?";
    const { sent, talked } = await send(threadId, body, triage({ [body]: "elsewhere" }));
    const kept = (await runById(run.id)) as AgentRun;
    expect(kept.pendingMessageIds).not.toContain(sent.id);
    expect(kept.afterMessageIds).toEqual([]);
    expect(await takeInbox(f.db, run.id)).toEqual([]);
    // Nothing says it went into the task any more (a reload's receipts), and its triage is over.
    const [stored] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, sent.id));
    expect(stored?.meta.steeredRunIds).toBeUndefined();
    expect(stored?.meta.triage).toBeUndefined();
    // Nothing answers it for the agent, and the app hears it isn't the agent's.
    expect(talked).toEqual([]);
    expect(events.filter((e) => e.type === "agent.run.released")).toEqual([
      expect.objectContaining({
        type: "agent.run.released",
        channelId: f.general.id,
        agentId: f.agent.id,
        runId: run.id,
        messageId: sent.id,
      }),
    ]);
    // The router decides who answers it, as for any message nobody mentioned (here: nobody).
    const asked: unknown[] = [];
    const strategy: RouterStrategy = {
      name: "jev",
      async decide(decision) {
        asked.push(decision);
        return { agents: [] };
      },
    };
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", strategy },
    });
    const [job] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, ROUTE_RELEASED_JOB));
    expect(job?.payload).toEqual({ messageId: sent.id, agentId: f.agent.id });
    await handlers[ROUTE_RELEASED_JOB]?.(job as OutboxJob, { finalAttempt: false });
    // Never back to the agent it left (the router leans toward the agent the person was just talking to): it isn't
    // even a candidate, and here, its only agent gone, nobody is.
    for (const decision of asked as { candidates: { agentId: string }[] }[])
      expect(decision.candidates.map((c) => c.agentId)).not.toContain(f.agent.id);
    expect(events.some((e) => e.type === "message.routed" && e.messageId === sent.id)).toBe(true);
    expect((await runById(run.id))?.pendingMessageIds).not.toContain(sent.id);
    expect((await runById(run.id))?.status).toBe("running");
  });

  test("for someone else: only an agent the message speaks to answers it, never the best placed nor one by rule", async () => {
    const { run, threadId } = await working();
    const other = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Sofia", handle: "sofia" },
      {
        model: "claude-sonnet-5-5",
      },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: other.id });
    const body = "Maria, te mandei a proposta por e-mail";
    const { sent } = await send(threadId, body, triage({ [body]: "elsewhere" }));
    // A step that finds an agent best placed to answer (or is unsure, at the bar) while the message speaks to none:
    // the best placed agent, or the "always one" rule, would answer a line meant for someone else.
    const strategy: RouterStrategy = {
      name: "jev",
      decide: async () => ({
        agents: [{ agentId: other.id, score: 0.7 }],
        needsAgent: 0.56,
        best: { agentId: other.id, confidence: 0.66 },
      }),
    };
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", strategy },
    });
    const [job] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, ROUTE_RELEASED_JOB));
    await handlers[ROUTE_RELEASED_JOB]?.(job as OutboxJob, { finalAttempt: false });
    const [decision] = await f.db
      .select()
      .from(schema.routingDecisions)
      .where(eq(schema.routingDecisions.messageId, sent.id));
    expect(decision?.selectedAgentIds).toEqual([]);
    expect((await runs()).filter((r) => r.agentId === other.id)).toEqual([]);
    expect((await runById(run.id))?.pendingMessageIds).not.toContain(sent.id);
    // A line that speaks to another agent by name is that agent's.
    const toSofia = "Sofia, vê esse erro de login quando puder";
    const named = await send(threadId, toSofia, triage({ [toSofia]: "elsewhere" }));
    const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, ROUTE_RELEASED_JOB));
    const next = jobs.find((j) => j.payload.messageId === named.sent.id);
    await handlers[ROUTE_RELEASED_JOB]?.(next as OutboxJob, { finalAttempt: false });
    const [routed] = await f.db
      .select()
      .from(schema.routingDecisions)
      .where(eq(schema.routingDecisions.messageId, named.sent.id));
    expect(routed?.selectedAgentIds).toEqual([other.id]);
  });

  test("a line for the agent, or one the judge isn't sure of, stays in the task as before", async () => {
    const { run, threadId } = await working();
    const body = "Maria, depois confere o que o Dev achou";
    const unsure: Judge = {
      name: "fake",
      ask: async () => ({ handling: { choice: "elsewhere", probabilities: { elsewhere: ELSEWHERE_SURE - 0.1 } } }),
    };
    const { sent } = await send(threadId, body, unsure);
    expect((await runById(run.id))?.pendingMessageIds).toContain(sent.id);
    const [stored] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, sent.id));
    expect(stored?.meta.steeredRunIds).toEqual([run.id]);
    expect(stored?.meta.triage).toBeUndefined();
  });

  test("where it can only be for the agent, the judge is never asked whether it is for someone else", async () => {
    // A message @mentioning the agent, in the channel.
    const { run, threadId } = await working();
    const mention = asking({ choice: "elsewhere", probabilities: { elsewhere: 0.99 } });
    const { sent } = await send(threadId, "@dev a Maria já mandou o arquivo?", mention.judge);
    expect((await runById(run.id))?.pendingMessageIds).toContain(sent.id);
    expect(offered(mention.seen[0])).toContain("add");
    expect(offered(mention.seen[0])).not.toContain("elsewhere");
    // A DM with the agent.
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    await postPersonMessage(deps(), f.owner.id, f.org.id, dm.id, { body: "monta o relatório de outubro" });
    const dmRun = (await runs()).find((r) => r.channelId === dm.id);
    if (!dmRun) throw new Error("no run");
    await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, dmRun.id));
    const inDm = asking({ choice: "elsewhere", probabilities: { elsewhere: 0.99 } });
    const sentInDm = await postPersonMessage({ ...deps(), judge: inDm.judge }, f.owner.id, f.org.id, dm.id, {
      body: "Maria, viu isso?",
    });
    await stopChecksSettled();
    expect((await runById(dmRun.id))?.pendingMessageIds).toContain(sentInDm.id);
    expect(offered(inDm.seen[0])).toContain("add");
    expect(offered(inDm.seen[0])).not.toContain("elsewhere");
  });

  test("the run waits a moment for a message under triage, never past the grace, and not at all without one", async () => {
    const { run, threadId } = await working();
    const { sent } = await send(threadId, "inclui o gráfico por região", triage({}));
    let start = Date.now();
    expect(await unreadNow(f.db, run.id, { awaitTriage: true })).toEqual([sent.id]);
    expect(Date.now() - start).toBeLessThan(TRIAGE_GRACE_MS / 2);
    const message = { id: sent.id, orgId: f.org.id, createdAt: new Date(sent.createdAt) };
    await markTriage(f.db, message, true);
    setTimeout(() => void markTriage(f.db, message, false), 300);
    start = Date.now();
    expect(await takeInbox(f.db, run.id, { awaitTriage: true })).toEqual([sent.id]);
    const waited = Date.now() - start;
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThan(TRIAGE_GRACE_MS + 500);
  });

  test("a computer brain never gets a line for someone else in its turn", async () => {
    const { run, threadId } = await working("claude_code");
    const delivered: string[] = [];
    const live = answerSteering(f, (await runById(run.id)) as AgentRun, {
      take: async () => {
        const ids = await takeInbox(f.db, run.id);
        delivered.push(...ids);
        return ids;
      },
    });
    try {
      const body = "João, me manda o link da reunião?";
      const { sent } = await send(threadId, body, triage({ [body]: "elsewhere" }));
      expect(delivered).not.toContain(sent.id);
      expect((await runById(run.id))?.pendingMessageIds).not.toContain(sent.id);
    } finally {
      live.close();
    }
  });

  test("a computer brain never gets a separate request in its turn: it waits for the task's end", async () => {
    const { run, threadId } = await working("claude_code");
    const live = answerSteering(f, (await runById(run.id)) as AgentRun);
    try {
      const body = "quando terminar, traduz pra inglês";
      const { sent } = await send(threadId, body, triage({ [body]: "queue" }));
      expect((await runById(run.id))?.afterMessageIds).toEqual([sent.id]);
    } finally {
      live.close();
    }
  });

  test("a correction to a computer brain whose turn can't take it now stops the task to start again from it", async () => {
    const { run, threadId } = await working("claude_code");
    const live = answerSteering(f, (await runById(run.id)) as AgentRun);
    try {
      const body = "espera, é a branch main";
      const { sent } = await send(threadId, body, triage({ [body]: "interrupt" }));
      const stopped = (await runById(run.id)) as AgentRun;
      expect(stopped.status).toBe("canceled");
      expect((await stoppedToSend(f.db, stopped))?.id).toBe(sent.id);
    } finally {
      live.close();
    }
  });
});
