import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  createAgent,
  createAgentRuns,
  drainOutbox,
  executeRun,
  getMessage,
  insertMessage,
  listMessages,
  openDm,
  postPersonMessage,
  publishTyping,
  type ToolSource,
} from "../src";
import * as burst from "../src/burst";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const post = (body: string, threadId?: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, threadId });
const runs = async () =>
  (await f.db.select().from(schema.agentRuns)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

/** A tool that, while it runs, lets the test do something (a person writes in the thread). */
function slowTool(during: () => Promise<unknown>): ToolSource {
  return {
    name: "slow",
    tools: async () => [
      {
        name: "build",
        description: "Build the project",
        scope: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          await during();
          return { content: "build ok" };
        },
      },
    ],
  };
}

describe("mid-round queueing (ADR 0029 section 1)", () => {
  test("a reply in the thread of the message it works on joins that run: no mention, no second run", async () => {
    let threadId = "";
    const requests: string[] = [];
    f = await setup({
      toolSources: [slowTool(() => post("also bump the version", threadId))],
      reply: (req: ModelRequest, call: number) => {
        requests.push(JSON.stringify(req.messages.at(-1)?.content));
        return call === 1
          ? { chunks: ["Building."], toolUses: [{ name: "build", input: {} }] }
          : { chunks: ["Built, version bumped."] };
      },
    });
    const ask = await post("@dev build the project");
    threadId = ask.id;
    await drainOutbox(f.db, f.handlers);
    expect(await runs()).toHaveLength(1);
    expect(f.provider.calls).toHaveLength(2);
    expect(requests[1]).toContain("New message from ana, while you were working");
    expect(requests[1]).toContain("also bump the version");
    // Asked in the channel: it answers in the main timeline.
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(main.at(-1)?.body).toBe("Built, version bumped.");
  });

  test("a new message in the channel calling the agent while it works there joins that run: one agent, not two", async () => {
    const requests: string[] = [];
    f = await setup({
      // While the first answer runs, someone else calls the same agent with a new message in the channel.
      toolSources: [slowTool(() => post("@dev and fix the login too"))],
      reply: (req: ModelRequest, call: number) => {
        requests.push(JSON.stringify(req.messages.at(-1)?.content));
        return call === 1
          ? { chunks: ["Building."], toolUses: [{ name: "build", input: {} }] }
          : { chunks: ["Built, and the login is fixed."] };
      },
    });
    await post("@dev build the project");
    await drainOutbox(f.db, f.handlers);
    expect(await runs()).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("and fix the login too");
  });

  test("a new message in the channel doesn't join a run working in a thread", async () => {
    f = await setup({
      toolSources: [slowTool(() => post("@dev something else"))],
      reply: (_req: ModelRequest, call: number) =>
        call === 1 ? { chunks: ["Building."], toolUses: [{ name: "build", input: {} }] } : { chunks: ["Done."] },
    });
    const root = await post("the release");
    // Asked in the thread: its run answers there, not in the channel.
    await post("@dev build the project", root.id);
    await drainOutbox(f.db, f.handlers);
    expect(await runs()).toHaveLength(2);
  });

  test("after the run ended, a new message to the agent starts a run as usual", async () => {
    f = await setup({ reply: (_req, call) => ({ chunks: [call === 1 ? "First." : "Second."] }) });
    const ask = await post("@dev first thing");
    await drainOutbox(f.db, f.handlers);
    await post("@dev one more thing", ask.id);
    await drainOutbox(f.db, f.handlers);
    const all = await runs();
    expect(all.map((r) => r.status)).toEqual(["done", "done"]);
    expect(all[1]?.threadRootId).toBe(ask.id);
    // Each answers where it was asked: the first in the main timeline, the second in the thread.
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(main.map((m) => m.body)).toEqual(["@dev first thing", "First."]);
    const thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: ask.id });
    expect(thread.map((m) => m.body)).toEqual(["@dev first thing", "@dev one more thing", "Second."]);
  });

  test("a message queued into a run that then fails is not lost: it gets a run of its own", async () => {
    let threadId = "";
    let followUp = "";
    f = await setup({
      reply: (_req: ModelRequest, call: number) => {
        if (call === 1) {
          // Written while the model answers; the answer then fails (a refusal).
          const posting = post("are you there?", threadId).then((m) => {
            followUp = m.id;
          });
          return { chunks: ["Hmm"], hold: posting, stopReason: "refusal" as const };
        }
        return { chunks: ["Yes, here."] };
      },
    });
    const ask = await post("@dev do the risky thing");
    threadId = ask.id;
    await drainOutbox(f.db, f.handlers);
    const all = await runs();
    expect(all.map((r) => r.status)).toEqual(["failed", "done"]);
    expect(all[0]?.error).toBe("model_refused");
    expect(all[0]?.pendingMessageIds).toEqual([]);
    expect(all[1]?.triggerMessageId).toBe(followUp);
    const thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId });
    expect(thread.at(-1)?.body).toBe("Yes, here.");
  });
});

describe("messages in a row (ADR 0112)", () => {
  const postIn = (channelId: string, body: string, threadId?: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId, { body, threadId });
  /** Typing here, as the apps send it ("digitando…"). */
  const typing = (channelId = f.general.id, threadId: string | null = null) =>
    publishTyping(f.pubsub, { channelId, threadId, userId: f.owner.id });
  /** Resolves once the run's first model call starts; rejects when it hasn't within `ms`: it waited. */
  const startsWithin = (started: Promise<unknown>, ms: number) =>
    Promise.race([started, Bun.sleep(ms).then(() => Promise.reject(new Error("the first model call waited")))]);
  /**
   * Holds a run just before its first model call until `open()`: `started` resolves once it is there, running. On a
   * loaded machine the rest of the burst could otherwise land after a first call already over.
   */
  const holdBeforeFirstCall = () => {
    let open = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    let reached = () => {};
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const real = burst.waitWhileTyping;
    const spy = spyOn(burst, "waitWhileTyping").mockImplementation(async (...args) => {
      reached();
      await opened;
      return real(...args);
    });
    return { started, open, restore: () => spy.mockRestore() };
  };

  test.each([
    ["a DM", "dm"],
    ["a thread", "thread"],
  ] as const)(
    "in %s: a burst sent before the first model call gets one run and one answer that read all of it",
    async (_l, where) => {
      const requests: string[] = [];
      f = await setup({
        quietMs: 400,
        reply: (req: ModelRequest) => {
          requests.push(JSON.stringify(req.messages.at(-1)?.content));
          return { chunks: ["Bate sim: 42 tarefas nos dois."] };
        },
      });
      const dm = where === "dm" ? (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id : null;
      const root = where === "thread" ? await post("o relatório de ontem") : null;
      const channelId = dm ?? f.general.id;
      await postIn(channelId, dm ? "oi" : "@dev oi", root?.id);
      const hold = holdBeforeFirstCall();
      try {
        const drained = drainOutbox(f.db, f.handlers);
        await hold.started;
        expect((await runs()).map((r) => r.status)).toEqual(["running"]);
        await postIn(channelId, "preciso de uma coisa", root?.id);
        await postIn(channelId, "olha o relatório de ontem e me diz se bate com o quadro", root?.id);
        hold.open();
        await drained;
      } finally {
        hold.restore();
      }
      await drainOutbox(f.db, f.handlers);
      expect(await runs()).toHaveLength(1);
      expect(f.provider.calls).toHaveLength(1);
      // The rest of the burst reads as plain conversation lines, not as news that came in while it worked.
      expect(requests[0]).toContain("[ana]: preciso de uma coisa");
      expect(requests[0]).toContain("[ana]: olha o relatório de ontem");
      expect(requests[0]).not.toContain("while you were working");
      const [run] = await runs();
      expect(run?.pendingMessageIds).toEqual([]);
      expect((run?.transcript as { request?: string } | undefined)?.request).toContain("se bate com o quadro");
    },
    70_000,
  );

  test("a reply that only talked, overtaken by the person before it went out, is rewritten: one answer to all of it", async () => {
    const requests: string[] = [];
    let dm = "";
    f = await setup({
      reply: (req: ModelRequest, call: number) => {
        requests.push(JSON.stringify(req.messages));
        // While it writes its greeting, the person asks for something else.
        return call === 1
          ? {
              chunks: ["Olá! Em que posso ajudar hoje?"],
              hold: postIn(dm, "pesquisa hotéis em Recife para março"),
            }
          : { chunks: ["Claro: para quantas noites?"] };
      },
    });
    dm = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
    await postIn(dm, "olá");
    await drainOutbox(f.db, f.handlers);
    const said = (await listMessages(f.db, f.owner.id, f.org.id, dm))
      .filter((m) => m.author.type === "agent")
      .map((m) => m.body);
    expect(said).toEqual(["Claro: para quantas noites?"]);
    expect(f.provider.calls).toHaveLength(2);
    // The next turn knew its draft went nowhere, and read what overtook it.
    expect(requests[1]).toContain("Your reply was not sent");
    expect(requests[1]).toContain("Em que posso ajudar hoje?");
    expect(requests[1]).toContain("pesquisa hotéis em Recife para março");
    const [run] = await runs();
    expect(run?.status).toBe("done");
    expect((run?.transcript as { overtaken?: number } | undefined)?.overtaken).toBe(1);
  });

  test("a reply after work (a tool called) goes out as it is, and what came meanwhile gets the next one", async () => {
    let dm = "";
    f = await setup({
      toolSources: [slowTool(async () => {})],
      reply: (_req: ModelRequest, call: number) =>
        call === 1
          ? { chunks: [], toolUses: [{ name: "build", input: {} }] }
          : call === 2
            ? { chunks: ["Build ok."], hold: postIn(dm, "e roda os testes também") }
            : { chunks: ["Testes rodando."] },
    });
    dm = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
    await postIn(dm, "builda o projeto");
    await drainOutbox(f.db, f.handlers);
    const said = (await listMessages(f.db, f.owner.id, f.org.id, dm))
      .filter((m) => m.author.type === "agent")
      .map((m) => m.body);
    expect(said).toEqual(["Build ok.", "Testes rodando."]);
  });

  test("a person who keeps writing still gets an answer: at most two rewrites in a row", async () => {
    let dm = "";
    f = await setup({
      reply: (_req: ModelRequest, call: number) =>
        call <= 3 ? { chunks: [`Resposta ${call}.`], hold: postIn(dm, `mais uma ${call}`) } : { chunks: ["Fim."] },
    });
    dm = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
    await postIn(dm, "oi");
    await drainOutbox(f.db, f.handlers);
    const said = (await listMessages(f.db, f.owner.id, f.org.id, dm))
      .filter((m) => m.author.type === "agent")
      .map((m) => m.body);
    // The first two are rewritten; the third goes out, and the fourth answers what overtook it.
    expect(said).toEqual(["Resposta 3.", "Fim."]);
  });

  test("a message to a model-brain run that is still starting never holds the send for a live delivery", async () => {
    f = await setup();
    const dm = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
    await postIn(dm, "oi");
    // Running, but no executor listens yet (it is still building its context).
    await f.db.update(schema.agentRuns).set({ status: "running" });
    const start = Date.now();
    await postIn(dm, "preciso de uma coisa");
    expect(Date.now() - start).toBeLessThan(1500);
    const [run] = await runs();
    expect(run?.pendingMessageIds).toHaveLength(1);
  });

  test("a database error during the typing hold, on the last try: the run fails and stops listening for live messages", async () => {
    f = await setup({ quietMs: 400 });
    await post("@dev oi");
    await typing();
    const [queued] = await runs();
    const open = new Set<object>();
    const subscribe = f.pubsub.subscribe.bind(f.pubsub);
    const subs = spyOn(f.pubsub, "subscribe").mockImplementation((topic, handler) => {
      const off = subscribe(topic, handler);
      if (!topic.startsWith("run-steer:")) return off;
      const key = {};
      open.add(key);
      return () => {
        open.delete(key);
        off();
      };
    });
    const select = f.db.select.bind(f.db);
    const broken = spyOn(f.db, "select").mockImplementation(((fields?: Record<string, unknown>) => {
      if (fields && "latest" in fields) throw new Error("connection reset");
      return select(fields as never);
    }) as typeof f.db.select);
    try {
      await executeRun(f.jobDeps, queued?.id ?? "", { finalAttempt: true });
    } finally {
      broken.mockRestore();
      subs.mockRestore();
    }
    const [run] = await runs();
    expect(run?.status).toBe("failed");
    expect(open.size).toBe(0);
  });

  test("nobody typing: the first model call starts at once, on a mention, a DM or a router's pick", async () => {
    f = await setup({ quietMs: 5000 });
    const dm = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
    const sends = [() => post("@dev oi"), () => postIn(dm, "oi"), () => post("@dev o build quebrou")];
    for (const [i, send] of sends.entries()) {
      await send();
      const run = (await runs()).at(-1);
      // The last as the router starts it.
      if (i === 2)
        await f.db
          .update(schema.agentRuns)
          .set({ trigger: "router" })
          .where(eq(schema.agentRuns.id, run?.id ?? ""));
      const start = Date.now();
      await executeRun(f.jobDeps, run?.id ?? "", { finalAttempt: true });
      expect(Date.now() - start).toBeLessThan(1500);
    }
    expect((await runs()).map((r) => r.status)).toEqual(["done", "done", "done"]);
  });

  test("typing seen: the hold lasts until they send it, at most four windows; none for a connected AI app", async () => {
    f = await setup();
    const log = burst.typingLogFor(f.pubsub);
    const row = async (body: string, meta?: Record<string, unknown>) => {
      const posted = await post(body);
      if (meta) await f.db.update(schema.messages).set({ meta }).where(eq(schema.messages.id, posted.id));
      const m = await getMessage(f.db, f.org.id, posted.id);
      if (!m) throw new Error("not posted");
      return m;
    };
    // No frame heard: no wait, and not a statement.
    const alone = await row("@dev oi");
    const select = spyOn(f.db, "select");
    let start = Date.now();
    await burst.waitWhileTyping(f.db, alone, 2500, log);
    expect(Date.now() - start).toBeLessThan(100);
    expect(select).not.toHaveBeenCalled();
    select.mockRestore();
    // Typing for the message itself, before it was sent, is over with it.
    await typing();
    await Bun.sleep(5);
    const sent = await row("@dev oi");
    start = Date.now();
    await burst.waitWhileTyping(f.db, sent, 2500, log);
    expect(Date.now() - start).toBeLessThan(300);
    // Typing after it holds until their next message lands.
    const more = await row("@dev oi");
    await typing();
    setTimeout(() => void post("preciso de uma coisa"), 600);
    start = Date.now();
    await burst.waitWhileTyping(f.db, more, 2500, log);
    expect(Date.now() - start).toBeGreaterThanOrEqual(550);
    expect(Date.now() - start).toBeLessThan(1200);
    // Still typing, never sent: at most four windows from the message.
    const long = await row("@dev oi");
    await typing();
    const keepTyping = setInterval(() => void typing(), 200);
    await burst.waitWhileTyping(f.db, long, 300, log);
    clearInterval(keepTyping);
    expect(Date.now() - long.createdAt.getTime()).toBeGreaterThanOrEqual(1150);
    expect(Date.now() - long.createdAt.getTime()).toBeLessThan(2000);
    // Sent through a connected AI app (ADR 0119): never held, whatever the frames say.
    const viaApp = await row("@dev oi", { via: { kind: "app", name: "Claude" } });
    await typing();
    start = Date.now();
    await burst.waitWhileTyping(f.db, viaApp, 2500, log);
    expect(Date.now() - start).toBeLessThan(100);
    // Recording a voice message ("gravando áudio…") holds as typing does.
    const voice = await row("@dev oi");
    await publishTyping(f.pubsub, { channelId: f.general.id, threadId: null, userId: f.owner.id, kind: "voice" });
    await burst.waitWhileTyping(f.db, voice, 300, log);
    expect(Date.now() - voice.createdAt.getTime()).toBeGreaterThanOrEqual(1150);
  }, 20_000);

  test("Parar or a shutdown during the typing hold ends it at once", async () => {
    f = await setup();
    const log = burst.typingLogFor(f.pubsub);
    const posted = await post("@dev oi");
    const sent = await getMessage(f.db, f.org.id, posted.id);
    if (!sent) throw new Error("not posted");
    await typing();
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    const start = Date.now();
    await burst.waitWhileTyping(f.db, sent, 5000, log, stop.signal);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test("typing seen when the run starts: its first model call waits for what they send, then reads it at once", async () => {
    const requests: string[] = [];
    let called = () => {};
    const firstCall = new Promise<void>((resolve) => {
      called = resolve;
    });
    f = await setup({
      quietMs: 3000,
      reply: (req: ModelRequest) => {
        called();
        requests.push(JSON.stringify(req.messages));
        return { chunks: ["Bate sim: 42 tarefas nos dois."] };
      },
    });
    const dm = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
    await postIn(dm, "oi");
    await typing(dm);
    const drained = drainOutbox(f.db, f.handlers);
    await Bun.sleep(700);
    expect(f.provider.calls).toHaveLength(0);
    const sentAt = Date.now();
    await postIn(dm, "olha o relatório de ontem e me diz se bate com o quadro");
    await startsWithin(firstCall, 700);
    expect(Date.now() - sentAt).toBeLessThan(700);
    await drained;
    expect(f.provider.calls).toHaveLength(1);
    expect(requests[0]).toContain("se bate com o quadro");
  });

  test("'oi' then 'preciso de X' within a second: one run, one reply that answers X, both read", async () => {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let called = () => {};
    const firstCall = new Promise<void>((resolve) => {
      called = resolve;
    });
    const requests: string[] = [];
    f = await setup({
      quietMs: 2500,
      reply: (req: ModelRequest, call: number) => {
        requests.push(JSON.stringify(req.messages));
        if (call > 1) return { chunks: ["Claro: para quantas noites em Recife?"] };
        called();
        return { chunks: ["Oi! Em que posso ajudar?"], hold: released };
      },
    });
    const dm = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
    const events = f.listen(dm);
    const sentAt = Date.now();
    const hi = await postIn(dm, "oi");
    const drained = drainOutbox(f.db, f.handlers);
    // Nobody typing: it thinks at once on "oi".
    await startsWithin(firstCall, 1000);
    const need = await postIn(dm, "preciso de hotéis em Recife para março");
    expect(Date.now() - sentAt).toBeLessThan(1000);
    release();
    await drained;
    await drainOutbox(f.db, f.handlers);
    expect(await runs()).toHaveLength(1);
    const said = (await listMessages(f.db, f.owner.id, f.org.id, dm)).filter((m) => m.author.type === "agent");
    expect(said.map((m) => m.body)).toEqual(["Claro: para quantas noites em Recife?"]);
    expect(requests.at(-1)).toContain("hotéis em Recife");
    const [run] = await runs();
    expect(run?.triggerMessageId).toBe(hi.id);
    expect(run?.pendingMessageIds).toEqual([]);
    const read = events.filter((e) => e.type === "agent.run.read") as unknown as { messageIds: string[] }[];
    expect(read.flatMap((e) => e.messageIds)).toContain(need.id);
  });

  test("a follow-up after the first model call started is steered into the turn under way", async () => {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let called = () => {};
    const firstCall = new Promise<void>((resolve) => {
      called = resolve;
    });
    const requests: string[] = [];
    f = await setup({
      quietMs: 2500,
      toolSources: [slowTool(async () => {})],
      reply: (req: ModelRequest, call: number) => {
        requests.push(JSON.stringify(req.messages));
        if (call > 1) return { chunks: ["Relatório da semana pronto, com a anterior também."] };
        called();
        return { chunks: ["Vou montar."], toolUses: [{ name: "build", input: {} }], hold: released };
      },
    });
    const dm = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
    await postIn(dm, "monta o relatório desta semana");
    const drained = drainOutbox(f.db, f.handlers);
    await startsWithin(firstCall, 1000);
    await postIn(dm, "ah, e inclui a semana passada também");
    release();
    await drained;
    expect(await runs()).toHaveLength(1);
    expect(f.provider.calls).toHaveLength(2);
    expect(requests[0]).not.toContain("inclui a semana passada");
    expect(requests[1]).toContain("while you were working]: ah, e inclui a semana passada");
  });

  test("a short first reply waits for what the person is still typing, and is rewritten with it", async () => {
    let dm = "";
    f = await setup({
      quietMs: 2500,
      reply: (_req: ModelRequest, call: number) =>
        call === 1
          ? {
              chunks: ["Oi! Em que posso ajudar?"],
              // They start the next message while it writes, and send it a moment after its answer.
              hold: typing(dm).then(() => {
                setTimeout(() => void postIn(dm, "preciso de hotéis em Recife para março"), 400);
              }),
            }
          : { chunks: ["Claro: para quantas noites?"] },
    });
    dm = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
    await postIn(dm, "oi");
    await drainOutbox(f.db, f.handlers);
    const said = (await listMessages(f.db, f.owner.id, f.org.id, dm)).filter((m) => m.author.type === "agent");
    expect(said.map((m) => m.body)).toEqual(["Claro: para quantas noites?"]);
    expect(await runs()).toHaveLength(1);
  });

  test("an update sent while it works joins the run and becomes part of the request the judges hold the reply to", async () => {
    const requests: string[] = [];
    let dmId = "";
    f = await setup({
      toolSources: [slowTool(() => postIn(dmId, "ah, e inclui a semana passada também"))],
      reply: (req: ModelRequest, call: number) => {
        requests.push(JSON.stringify(req.messages.at(-1)?.content));
        return call === 1
          ? { chunks: ["Vou montar."], toolUses: [{ name: "build", input: {} }] }
          : { chunks: ["Pronto, com a semana passada também."] };
      },
    });
    dmId = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
    await postIn(dmId, "monta o relatório desta semana");
    await drainOutbox(f.db, f.handlers);
    expect(await runs()).toHaveLength(1);
    expect(requests[1]).toContain("while you were working]: ah, e inclui a semana passada");
    const [run] = await runs();
    expect((run?.transcript as { request?: string } | undefined)?.request).toContain("inclui a semana passada");
    // Told how to take it: the system prompt says an update changes the work in progress.
    expect(JSON.stringify(f.provider.calls[0]?.request.system)).toContain("updates the task in progress");
  });

  test("a message sent while it writes its answer is never lost: the same run reads it next", async () => {
    let dmId = "";
    const requests: string[] = [];
    f = await setup({
      reply: (req: ModelRequest, call: number) => {
        requests.push(JSON.stringify(req.messages));
        return call === 1
          ? { chunks: ["Feito."], hold: postIn(dmId, "e manda pro canal também") }
          : { chunks: ["Feito, e mandei no canal."] };
      },
    });
    dmId = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
    await postIn(dmId, "fecha o relatório");
    await drainOutbox(f.db, f.handlers);
    expect((await runs()).map((r) => r.status)).toEqual(["done"]);
    // Its reply only talked (no tool called): overtaken, it was rewritten with what came, in one answer.
    expect(requests[1]).toContain("e manda pro canal também");
    expect(requests[1]).toContain('It was: \\"Feito.\\"');
    const dm = await listMessages(f.db, f.owner.id, f.org.id, dmId);
    expect(dm.map((m) => m.body)).toEqual([
      "fecha o relatório",
      "e manda pro canal também",
      "Feito, e mandei no canal.",
    ]);
  });
});

describe("a follow-up for another agent re-routes (ADR 0112)", () => {
  /** Ada next to Dev in #general, and Dev's run the router started on the person's "oi". */
  async function routedToDev(reply?: NonNullable<Parameters<typeof setup>[0]>["reply"]) {
    f = await setup({ quietMs: 2500, ...(reply ? { reply } : {}) });
    const ada = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ada", handle: "ada", role: "Marketing", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ada.id });
    const hi = await post("oi");
    const message = await getMessage(f.db, f.org.id, hi.id);
    if (!message) throw new Error("not posted");
    const [dev] = await createAgentRuns(f.db, message, [f.agent.id], "router");
    if (!dev) throw new Error("no run");
    return { ada, dev };
  }
  const runOf = async (id: string) => (await runs()).find((r) => r.id === id);
  const saidBy = async (agentId: string) =>
    (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).filter(
      (m) => m.author.type === "agent" && m.author.id === agentId,
    );

  test("'oi' the router gave Dev, then '@ada preciso de X': Dev's run stops quietly and Ada answers", async () => {
    const { ada, dev } = await routedToDev();
    await post("@ada preciso do relatório da campanha");
    const toAda = (await runs()).find((r) => r.agentId === ada.id);
    await executeRun(f.jobDeps, toAda?.id ?? "", { finalAttempt: true });
    expect(await runOf(dev.id)).toMatchObject({ status: "canceled", error: "rerouted" });
    expect(await saidBy(f.agent.id)).toEqual([]);
    expect((await saidBy(ada.id)).length).toBe(1);
  });

  test("the router gives the follow-up to Ada (the triage found it isn't Dev's): the same", async () => {
    const { ada, dev } = await routedToDev();
    const posted = await post("a Ada tem o relatório da campanha?");
    const followUp = await getMessage(f.db, f.org.id, posted.id);
    if (!followUp) throw new Error("not posted");
    // Out of Dev's inbox as the triage leaves it (`releaseFromRun`), and routed to Ada.
    await f.db.update(schema.agentRuns).set({ pendingMessageIds: [] }).where(eq(schema.agentRuns.id, dev.id));
    const [toAda] = await createAgentRuns(f.db, followUp, [ada.id], "router");
    await executeRun(f.jobDeps, toAda?.id ?? "", { finalAttempt: true });
    expect(await runOf(dev.id)).toMatchObject({ status: "canceled", error: "rerouted" });
    expect(await saidBy(f.agent.id)).toEqual([]);
  });

  test("Dev already thinking on 'oi': its call is cut and nothing of it is posted", async () => {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let called = () => {};
    const firstCall = new Promise<void>((resolve) => {
      called = resolve;
    });
    const { ada, dev } = await routedToDev((_req, call) => {
      if (call > 1) return { chunks: ["O relatório da campanha está no Drive."] };
      called();
      return { chunks: ["Oi! Em que posso ajudar?"], hold: released };
    });
    const devRun = executeRun(f.jobDeps, dev.id, { finalAttempt: true });
    await firstCall;
    await post("@ada preciso do relatório da campanha");
    const toAda = (await runs()).find((r) => r.agentId === ada.id);
    await executeRun(f.jobDeps, toAda?.id ?? "", { finalAttempt: true });
    release();
    await devRun;
    expect(await runOf(dev.id)).toMatchObject({ status: "canceled", error: "rerouted" });
    expect(await saidBy(f.agent.id)).toEqual([]);
    expect((await saidBy(ada.id)).map((m) => m.body)).toEqual(["O relatório da campanha está no Drive."]);
  });

  test("left alone: a run the person named, one that already spoke, one that reads the follow-up too, and a follow-up long after", async () => {
    const { ada, dev } = await routedToDev();
    const followUp = async (oiSecondsAgo: number, devReadsIt = false) => {
      await f.db
        .update(schema.messages)
        .set({ createdAt: new Date(Date.now() - oiSecondsAgo * 1000) })
        .where(eq(schema.messages.id, dev.triggerMessageId));
      const asked = await post("@ada preciso do relatório da campanha");
      if (devReadsIt)
        await f.db
          .update(schema.agentRuns)
          .set({ pendingMessageIds: [asked.id] })
          .where(eq(schema.agentRuns.id, dev.id));
      const toAda = (await runs()).filter((r) => r.agentId === ada.id).at(-1);
      await executeRun(f.jobDeps, toAda?.id ?? "", { finalAttempt: true });
      return (await runOf(dev.id))?.status;
    };
    // Dev named by the person ("@dev oi"): theirs to keep.
    await f.db.update(schema.agentRuns).set({ trigger: "mention" }).where(eq(schema.agentRuns.id, dev.id));
    expect(await followUp(0)).toBe("queued");
    await f.db.update(schema.agentRuns).set({ trigger: "router" }).where(eq(schema.agentRuns.id, dev.id));
    // Dev already said something on it.
    const said = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: dev.id, hop: 1 },
      body: "Oi!",
    });
    expect(await followUp(0)).toBe("queued");
    await f.db.delete(schema.messages).where(eq(schema.messages.id, said.id));
    // The follow-up joined Dev's inbox too: Dev reads it, so it stays Dev's.
    expect(await followUp(0, true)).toBe("queued");
    await f.db.update(schema.agentRuns).set({ pendingMessageIds: [] }).where(eq(schema.agentRuns.id, dev.id));
    // Ada asked well after "oi": a new request, not a follow-up.
    expect(await followUp(10)).toBe("queued");
    // And the same follow-up right after it: re-routed.
    expect(await followUp(0)).toBe("canceled");
  });
});
