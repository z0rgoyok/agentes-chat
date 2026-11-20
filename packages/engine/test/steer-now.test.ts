import { afterEach, describe, expect, test } from "bun:test";
import { channelTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { type ModelRequest, textOf } from "@agenteschat/providers";
import {
  activeRunsIn,
  addChannelMember,
  ConflictError,
  cancelRun,
  continueRun,
  drainOutbox,
  ForbiddenError,
  type Judge,
  type JudgeAnswer,
  listMessages,
  postPersonMessage,
  restartAfterStopAndSend,
  stopChecksSettled,
  type ToolSource,
} from "../src";
import type { Transcript } from "../src/executor";
import { returnToInbox } from "../src/live-steer";
import { stoppedToSend } from "../src/run-inbox";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const ask = (body: string, extra: { threadId?: string; steer?: "now" } = {}) =>
  postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body, ...extra });
const runs = () => f.db.select().from(schema.agentRuns);
const runById = async (id: string) => (await runs()).find((r) => r.id === id);

/** Only a plain "para" is a stop; the triage reads anything else at the next pause. */
const judge: Judge = {
  name: "fake",
  ask: async (request): Promise<Record<string, JudgeAnswer>> =>
    request.kind === "steer_triage"
      ? {
          handling:
            request.state.message === "para"
              ? { choice: "stop", probabilities: { stop: 0.95 } }
              : { choice: "add", probabilities: { add: 0.95 } },
        }
      : {},
};

/** Runs `fn` once, the first time an event of `type` reaches the channel. */
function onFirst(type: string, fn: (event: Record<string, unknown>) => void) {
  let seen = false;
  f.pubsub.subscribe(channelTopic(f.general.id), (event) => {
    if (seen || event.type !== type) return;
    seen = true;
    fn(event as Record<string, unknown>);
  });
}

/** The model holds after its first words until `release()` (the test acts meanwhile). */
function holdFirstCall() {
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { hold, release: () => release() };
}

describe('"Leu": a message sent while it works', () => {
  test("is read at the next step: the channel hears agent.run.read after it is in the conversation", async () => {
    let threadId = "";
    let steeredId = "";
    const slow: ToolSource = {
      name: "slow",
      tools: async () => [
        {
          name: "build",
          description: "Build the project",
          scope: "",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            steeredId = (await ask("usa a branch dev", { threadId })).id;
            return { content: "build ok" };
          },
        },
      ],
    };
    f = await setup({
      toolSources: [slow],
      reply: (_req: ModelRequest, call: number) =>
        call === 1 ? { chunks: ["Compilando."], toolUses: [{ name: "build", input: {} }] } : { chunks: ["Feito."] },
    });
    const events = f.listen(f.general.id);
    const question = await ask("@dev compila");
    threadId = question.id;
    await drainOutbox(f.db, f.handlers);

    const [run] = await runs();
    const types = events.map((e) => e.type);
    const read = events.find((e) => e.type === "agent.run.read");
    // Asked in the channel: the run's events are in the main timeline.
    expect(read).toMatchObject({ runId: run?.id, agentId: f.agent.id, threadId: null, messageIds: [steeredId] });
    expect(types.indexOf("agent.run.steered")).toBeLessThan(types.indexOf("agent.run.read"));
    expect(JSON.stringify(f.provider.calls[1]?.request.messages.at(-1))).toContain("usa a branch dev");
  });
});

describe('"Parar e mandar" (steer: "now")', () => {
  /** A task at work on a computer brain, in a turn that takes no message; `meanwhile` runs while the judge thinks. */
  async function judgedSend(body: string, meanwhile: (runId: string) => Promise<unknown>) {
    f = await setup();
    const question = await ask("@dev analisa os logs");
    const [run] = await runs();
    if (!run) throw new Error("no run");
    await f.db
      .update(schema.agentRuns)
      .set({ status: "running", brain: "claude_code" })
      .where(eq(schema.agentRuns.id, run.id));
    const slow: Judge = {
      name: "slow",
      ask: async (request) => {
        await meanwhile(run.id);
        return judge.ask(request);
      },
    };
    const said = await postPersonMessage({ ...deps(), judge: slow }, f.owner.id, f.org.id, f.general.id, {
      body,
      threadId: question.id,
      steer: "now",
    });
    await stopChecksSettled();
    const [shown] = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: question.id })).filter(
      (m) => m.id === said.id,
    );
    return { run, said, meta: shown?.meta };
  }

  test("a task that parked on its plan while the judge thought keeps its wait", async () => {
    const { run, meta } = await judgedSend("na verdade só os 3 primeiros", (runId) =>
      f.db
        .update(schema.agentRuns)
        .set({ status: "waiting_input", transcript: { waitingForBrain: { code: "plan_limit" } } })
        .where(eq(schema.agentRuns.id, runId)),
    );
    expect((await runById(run.id))?.status).toBe("waiting_input");
    expect(meta?.stoppedRunIds).toBeUndefined();
  });

  test("a task that read the message while the judge thought is not stopped for it", async () => {
    const { run, meta } = await judgedSend("na verdade só os 3 primeiros", (runId) =>
      f.db.update(schema.agentRuns).set({ pendingMessageIds: [] }).where(eq(schema.agentRuns.id, runId)),
    );
    expect((await runById(run.id))?.status).toBe("running");
    expect(meta?.stoppedRunIds).toBeUndefined();
    expect(await runs()).toHaveLength(1);
  });

  test("a plain 'stop' the turn had taken is not handed to a new run when the turn gives it back", async () => {
    const { run, said } = await judgedSend("para", async () => undefined);
    expect((await runById(run.id))?.status).toBe("canceled");
    await returnToInbox(f.db, f.pubsub, run, [said.id]);
    expect(await runs()).toHaveLength(1);
  });

  test("cuts the current model call (not the run): the text so far stays, the message is read at once", async () => {
    const { hold, release } = holdFirstCall();
    f = await setup({
      reply: (_req: ModelRequest, call: number) =>
        call === 1 ? { chunks: ["Começando pelo main. ", "isto nunca chega"], hold } : { chunks: ["Certo, na dev."] },
    });
    const events = f.listen(f.general.id);
    const question = await ask("@dev revisa o PR");
    let steeredId = "";
    onFirst("agent.typing", () => {
      const steer = async () => {
        try {
          steeredId = (await ask("na verdade, usa a branch dev", { threadId: question.id, steer: "now" })).id;
        } finally {
          release();
        }
      };
      void steer();
    });
    await drainOutbox(f.db, f.handlers);

    const [run] = await runs();
    expect(run?.status).toBe("done");
    expect(run?.turns).toBe(2);
    expect(f.provider.calls).toHaveLength(2);
    // The second call has what it wrote before the stop, then the new message.
    const second = f.provider.calls[1]?.request.messages ?? [];
    const assistant = second.filter((m) => m.role === "assistant").map((m) => textOf(m.content));
    expect(assistant).toContain("Começando pelo main.");
    expect(JSON.stringify(second.at(-1))).toContain("na verdade, usa a branch dev");

    expect(events.find((e) => e.type === "agent.run.steered")).toMatchObject({ messageId: steeredId, now: true });
    expect(events.find((e) => e.type === "agent.run.read")).toMatchObject({ messageIds: [steeredId] });
    expect(events.some((e) => e.type === "run.canceled")).toBe(false);
    // The reply is in the main timeline, where it was asked; the message sent to it, in the thread.
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(main.map((m) => m.body)).toEqual(["@dev revisa o PR", "Certo, na dev."]);
    const thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: question.id });
    expect(thread.map((m) => m.body)).toEqual(["@dev revisa o PR", "na verdade, usa a branch dev"]);
    // The cut call's usage is recorded too.
    const usage = await f.db
      .select()
      .from(schema.usageRecords)
      .where(eq(schema.usageRecords.runId, run?.id ?? ""));
    expect(usage).toHaveLength(2);
  });

  test("landing after the steering was taken but before the next call starts: that call reads it", async () => {
    let threadId = "";
    let built = false;
    let steeredId = "";
    // The next turn lists its tools after taking the steering and before the model call: the message
    // lands right in that window.
    const source: ToolSource = {
      name: "slow",
      tools: async () => {
        if (built && !steeredId) steeredId = (await ask("para, usa a dev", { threadId, steer: "now" })).id;
        return [
          {
            name: "build",
            description: "Build the project",
            scope: "",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            async execute() {
              built = true;
              return { content: "build ok" };
            },
          },
        ];
      },
    };
    f = await setup({
      toolSources: [source],
      reply: (_req: ModelRequest, call: number) =>
        call === 1 ? { chunks: ["Compilando."], toolUses: [{ name: "build", input: {} }] } : { chunks: ["Na dev."] },
    });
    const question = await ask("@dev compila");
    threadId = question.id;
    await drainOutbox(f.db, f.handlers);

    expect(steeredId).not.toBe("");
    const [run] = await runs();
    expect(run?.status).toBe("done");
    // No call was spent without it: the second (and last) call already has the message.
    expect(f.provider.calls).toHaveLength(2);
    expect(JSON.stringify(f.provider.calls[1]?.request.messages.at(-1))).toContain("para, usa a dev");
  });

  test("while it is queued (or waits), nothing is cut: it reads the message when it starts", async () => {
    f = await setup({ reply: () => ({ chunks: ["Ok."] }) });
    const question = await ask("@dev prepara o relatório");
    const steer = await ask("inclui setembro", { threadId: question.id, steer: "now" });
    const [queued] = await runs();
    // Reload: the channel's active runs say what it hasn't read yet.
    expect(await activeRunsIn(f.db, f.org.id, f.general.id)).toEqual([
      expect.objectContaining({ runId: queued?.id, pendingMessageIds: [steer.id] }),
    ]);
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(1);
    expect(JSON.stringify(f.provider.calls[0]?.request.messages)).toContain("inclui setembro");
    expect((await runById(queued?.id ?? ""))?.status).toBe("done");
  });
});

describe("the stop judge never holds the send", () => {
  test("steered goes out at once; a stop is judged after the response and then cancels", async () => {
    let judged: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      judged = resolve;
    });
    const judge: Judge = {
      name: "slow",
      async ask(request): Promise<Record<string, JudgeAnswer>> {
        await gate;
        return request.kind === "steer_triage" ? { handling: { choice: "stop", probabilities: { stop: 0.95 } } } : {};
      },
    };
    f = await setup();
    const events = f.listen(f.general.id);
    const question = await ask("@dev compila");
    const stop = await postPersonMessage({ ...deps(), judge }, f.owner.id, f.org.id, f.general.id, {
      body: "para",
      threadId: question.id,
    });
    // The post returned with the judge still thinking: the app already knows it went into the task.
    const steered = events.filter((e) => e.type === "agent.run.steered");
    expect(steered).toEqual([expect.objectContaining({ messageId: stop.id })]);
    expect(steered[0]?.stop).toBeUndefined();
    expect((await runs())[0]?.status).toBe("queued");

    judged();
    await stopChecksSettled();
    expect((await runs())[0]?.status).toBe("canceled");
    expect(events.filter((e) => e.type === "agent.run.steered").at(-1)).toMatchObject({
      messageId: stop.id,
      stop: true,
    });
    expect(events.some((e) => e.type === "run.canceled")).toBe(true);
  });
});

describe('"Continuar" after a stop', () => {
  /** A run stopped by Ana while it wrote: its reply has the text so far. */
  async function stoppedRun() {
    const { hold, release } = holdFirstCall();
    f = await setup({
      reply: (_req: ModelRequest, call: number) => {
        if (call > 1) return { chunks: ["Terminei a análise."] };
        return { chunks: ["Analisando o log. ", "nunca chega"], hold };
      },
    });
    const question = await ask("@dev analisa os logs");
    onFirst("agent.typing", (e) => {
      void cancelRun(deps(), f.owner.id, f.org.id, String(e.runId)).finally(release);
    });
    await drainOutbox(f.db, f.handlers);
    const [stopped] = await runs();
    return { question, stopped: stopped as NonNullable<typeof stopped> };
  }

  test("a new run picks up from the stopped one's conversation; the stopped reply says it continued", async () => {
    const { stopped } = await stoppedRun();
    expect(stopped.status).toBe("canceled");
    const events = f.listen(f.general.id);

    const { runId } = await continueRun(deps(), f.owner.id, f.org.id, stopped.id);
    const next = await runById(runId);
    expect(next).toMatchObject({
      agentId: f.agent.id,
      channelId: f.general.id,
      // The stopped reply is in the main timeline: the new run answers there too.
      threadRootId: stopped.replyMessageId,
      triggerMessageId: stopped.replyMessageId,
      status: "queued",
    });
    const before = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const reply = before.find((m) => m.id === stopped.replyMessageId);
    expect(reply?.meta.canceled).toMatchObject({ byUserId: f.owner.id, continuedRunId: runId });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "run.continued",
        runId: stopped.id,
        newRunId: runId,
        messageId: stopped.replyMessageId,
        threadId: null,
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: "agent.thinking", runId }));

    // Once per stopped reply.
    await expect(continueRun(deps(), f.owner.id, f.org.id, stopped.id)).rejects.toMatchObject({
      code: "run.not_continuable",
    });

    await drainOutbox(f.db, f.handlers);
    expect((await runById(runId))?.status).toBe("done");
    // It reads what it wrote before the stop, then who asked it to go on.
    // (The provider keeps a copy of each request: the transcript grows after the call.)
    const sent = f.provider.calls[1]?.request.messages ?? [];
    expect(sent.filter((m) => m.role === "assistant").map((m) => textOf(m.content))).toEqual(["Analisando o log."]);
    expect(textOf(sent.at(-1)?.content ?? "")).toContain("[ana asked you to continue from where you stopped.]");
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(main.at(-1)?.body).toBe("Terminei a análise.");
  });

  test("'Parar e mandar' to a computer brain: stopping it starts it again from that message", async () => {
    const { question, stopped } = await stoppedRun();
    // Ana's message went into the task and is still unread when the stop lands.
    const said = await ask("na verdade só os 3 primeiros", { threadId: question.id, steer: "now" });
    expect(said.meta.steerNow).toBe(true);
    await f.db
      .update(schema.agentRuns)
      .set({ pendingMessageIds: [said.id] })
      .where(eq(schema.agentRuns.id, stopped.id));
    // The stopped reply is in the main timeline (asked there).
    const reply = { id: stopped.replyMessageId as string, threadId: null };
    const transcript = stopped.transcript as unknown as Transcript;

    // A model brain read it mid-task already: nothing to restart.
    expect(await restartAfterStopAndSend(deps(), stopped.id, reply, transcript)).toBeNull();

    // The run thought with Claude Code (its own brain, ADR 0053 §10: the run's, not the agent's setting).
    await f.db.update(schema.agentRuns).set({ brain: "claude_code" }).where(eq(schema.agentRuns.id, stopped.id));
    const events = f.listen(f.general.id);
    const runId = await restartAfterStopAndSend(deps(), stopped.id, reply, transcript);
    expect(runId).toBeString();
    const next = await runById(runId as string);
    expect(next).toMatchObject({ agentId: f.agent.id, triggerMessageId: said.id, threadRootId: question.id });
    const t = next?.transcript as unknown as Transcript;
    expect(t.continued?.prompt).toBe("[ana stopped you to say this:]\n\nna verdade só os 3 primeiros");
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(main.find((m) => m.id === reply.id)?.meta.canceled).toMatchObject({ continuedRunId: runId });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "run.continued", runId: stopped.id, newRunId: runId }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "agent.run.read", runId: stopped.id, messageIds: [said.id] }),
    );
    // Once: the message is now a run's trigger.
    expect(await restartAfterStopAndSend(deps(), stopped.id, reply, transcript)).toBeNull();
  });

  test("'Parar e mandar' that stops a computer brain's task says no stop anywhere: it sent a message", async () => {
    const { hold, release } = holdFirstCall();
    f = await setup({
      reply: (_req: ModelRequest, call: number) =>
        call > 1 ? { chunks: ["Certo, só os 3."] } : { chunks: ["Analisando o log. ", "nunca chega"], hold },
    });
    const question = await ask("@dev analisa os logs");
    const events = f.listen(f.general.id);
    let saidId = "";
    onFirst("agent.typing", (e) => {
      const send = async () => {
        try {
          // The run thinks with Claude Code, in a turn that takes no message: the send stops the task.
          await f.db
            .update(schema.agentRuns)
            .set({ brain: "claude_code" })
            .where(eq(schema.agentRuns.id, String(e.runId)));
          // As the server does it: the judge says first that this is no plain "stop", then the task stops.
          const said = await postPersonMessage({ ...deps(), judge }, f.owner.id, f.org.id, f.general.id, {
            body: "na verdade só os 3 primeiros",
            threadId: question.id,
            steer: "now",
          });
          saidId = said.id;
          await stopChecksSettled();
        } finally {
          release();
        }
      };
      void send();
    });
    await drainOutbox(f.db, f.handlers);

    const all = await runs();
    const stopped = all.find((r) => r.triggerMessageId === question.id);
    const next = all.find((r) => r.triggerMessageId === saidId);
    expect(stopped).toMatchObject({ status: "canceled", error: `canceled_by:${f.owner.id}` });
    expect(next?.status).toBe("done");
    const shown = [
      ...(await listMessages(f.db, f.owner.id, f.org.id, f.general.id)),
      ...(await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: question.id })),
    ];
    // The message says which task it stopped; nothing says a person stopped the agent, and no notice tells it so.
    expect(shown.find((m) => m.id === saidId)?.meta.stoppedRunIds).toEqual([stopped?.id]);
    expect(shown.filter((m) => m.meta.canceled || m.meta.notice)).toEqual([]);
    expect(shown.some((m) => m.body.includes("Stopped"))).toBe(false);
    // What it wrote before the send stays, as a message like any other, and it answers the new one.
    const written = shown.find((m) => m.agentRunId === stopped?.id);
    expect(written?.body).toBe("Analisando o log.");
    // Placed before the message that cut it: after it, the cut text would read as the answer.
    const at = (id: string | undefined) => new Date(shown.find((m) => m.id === id)?.createdAt ?? 0).getTime();
    expect(at(written?.id)).toBeLessThan(at(saidId));
    expect(shown.some((m) => m.agentRunId === next?.id && m.body === "Certo, só os 3.")).toBe(true);
    expect(events.some((e) => e.type === "run.continued")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "agent.run.read", runId: stopped?.id, messageIds: [saidId] }),
    );
  });

  test("one message that stops two tasks marks both: neither says a stop", async () => {
    f = await setup();
    await ask("@dev analisa os logs");
    const other = await ask("e o PR");
    const said = await ask("na verdade só os 3 primeiros");
    const [one] = await runs();
    if (!one) throw new Error("no run");
    // Another task at work in the same channel (another agent's, in life), which the same message went into.
    const [two] = await f.db
      .insert(schema.agentRuns)
      .values({ ...one, id: Bun.randomUUIDv7(), triggerMessageId: other.id, threadRootId: other.id })
      .returning();
    if (!two) throw new Error("no second run");
    await cancelRun(deps(), f.owner.id, f.org.id, one.id, { sendMessageId: said.id });
    await cancelRun(deps(), f.owner.id, f.org.id, two.id, { sendMessageId: said.id });
    expect((await stoppedToSend(f.db, one))?.id).toBe(said.id);
    expect((await stoppedToSend(f.db, two))?.id).toBe(said.id);
    // A task stopped for itself is no such stop.
    await ask("@dev compila");
    const three = (await runs()).find((r) => r.id !== one.id && r.id !== two.id && r.status === "queued");
    if (!three) throw new Error("third run expected");
    await cancelRun(deps(), f.owner.id, f.org.id, three.id);
    expect(await stoppedToSend(f.db, three)).toBeNull();
  });

  test("a message the stopped turn gave back is kept for the restart, never handed to a run that knows nothing", async () => {
    f = await setup();
    const question = await ask("@dev analisa os logs");
    const [run] = await runs();
    if (!run) throw new Error("no run");
    await f.db
      .update(schema.agentRuns)
      .set({ status: "running", brain: "claude_code" })
      .where(eq(schema.agentRuns.id, run.id));
    const said = await ask("na verdade só os 3 primeiros", { threadId: question.id, steer: "now" });
    expect((await runById(run.id))?.status).toBe("canceled");
    // The turn had taken the inbox when the stop landed, and gives the message back unread.
    await f.db.update(schema.agentRuns).set({ pendingMessageIds: [] }).where(eq(schema.agentRuns.id, run.id));
    await returnToInbox(f.db, f.pubsub, run, [said.id]);
    expect(await runs()).toHaveLength(1);
    expect((await runById(run.id))?.pendingMessageIds).toEqual([said.id]);
    // Its worker then starts it again from that message, with what the stopped run knows.
    const transcript = { system: "", messages: [], postedUpTo: 0, postedCount: 0 } as unknown as Transcript;
    const next = await restartAfterStopAndSend(deps(), run.id, { id: null, threadId: null }, transcript);
    expect((await runById(next as string))?.triggerMessageId).toBe(said.id);
  });

  test("a message the turn read as the stop landed still gets its answer: the restart starts from it", async () => {
    const { question, stopped } = await stoppedRun();
    const said = await ask("na verdade só os 3 primeiros", { threadId: question.id, steer: "now" });
    await f.db
      .update(schema.agentRuns)
      .set({ brain: "claude_code", pendingMessageIds: [] })
      .where(eq(schema.agentRuns.id, stopped.id));
    const transcript = stopped.transcript as unknown as Transcript;
    const reply = { id: null, threadId: null };
    // Gone from the inbox and not known as read: another run has it.
    expect(await restartAfterStopAndSend(deps(), stopped.id, reply, transcript)).toBeNull();
    const runId = await restartAfterStopAndSend(deps(), stopped.id, { ...reply, read: said.id }, transcript);
    expect((await runById(runId as string))?.triggerMessageId).toBe(said.id);
  });

  test("a plain 'stop' sent with 'Parar e mandar' to a computer brain is a stop: it says so and starts nothing", async () => {
    const { hold, release } = holdFirstCall();
    f = await setup({
      reply: (_req: ModelRequest, call: number) =>
        call > 1 ? { chunks: ["Certo."] } : { chunks: ["Analisando o log. ", "nunca chega"], hold },
    });
    const question = await ask("@dev analisa os logs");
    let saidId = "";
    onFirst("agent.typing", (e) => {
      const send = async () => {
        try {
          await f.db
            .update(schema.agentRuns)
            .set({ brain: "claude_code" })
            .where(eq(schema.agentRuns.id, String(e.runId)));
          const said = await postPersonMessage({ ...deps(), judge }, f.owner.id, f.org.id, f.general.id, {
            body: "para",
            threadId: question.id,
            steer: "now",
          });
          saidId = said.id;
          await stopChecksSettled();
        } finally {
          release();
        }
      };
      void send();
    });
    await drainOutbox(f.db, f.handlers);

    const all = await runs();
    expect(all.find((r) => r.triggerMessageId === question.id)?.status).toBe("canceled");
    expect(all.some((r) => r.triggerMessageId === saidId)).toBe(false);
    const shown = [
      ...(await listMessages(f.db, f.owner.id, f.org.id, f.general.id)),
      ...(await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: question.id })),
    ];
    expect(shown.find((m) => m.id === saidId)?.meta.stoppedRunIds).toBeUndefined();
    expect(shown.find((m) => m.meta.canceled)?.meta.canceled).toMatchObject({ byUserId: f.owner.id });
  });

  test("the stop button still says who stopped it, with the notice the agent reads", async () => {
    const { stopped } = await stoppedRun();
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const reply = main.find((m) => m.id === stopped.replyMessageId);
    expect(reply?.meta.canceled).toMatchObject({ byUserId: f.owner.id, text: "Analisando o log." });
    expect(reply?.body).toContain("_Stopped by");
    expect(main.some((m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "run_stopped")).toBe(true);
  });

  test("permissions and 409s: same people as stopping it; busy agent; never a run nobody stopped", async () => {
    const { question, stopped } = await stoppedRun();
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: caio.id });
    await expect(continueRun(deps(), caio.id, f.org.id, stopped.id)).rejects.toBeInstanceOf(ForbiddenError);

    // The agent already works in that conversation: not now.
    await ask("@dev e o deploy?", { threadId: question.id });
    const busy = (await runs()).find((r) => r.id !== stopped.id);
    await expect(continueRun(deps(), f.owner.id, f.org.id, stopped.id)).rejects.toMatchObject({
      code: "run.agent_busy",
    });
    // Stopped while queued: nothing was written, nothing to continue.
    await cancelRun(deps(), f.owner.id, f.org.id, busy?.id ?? "");
    await expect(continueRun(deps(), f.owner.id, f.org.id, busy?.id ?? "")).rejects.toBeInstanceOf(ConflictError);
    await expect(continueRun(deps(), f.owner.id, f.org.id, busy?.id ?? "")).rejects.toMatchObject({
      code: "run.not_continuable",
    });

    // Free again: the owner continues it.
    expect((await continueRun(deps(), f.owner.id, f.org.id, stopped.id)).runId).toBeString();
  });
});
