import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { INLINE, SAFE_URL } from "@agenteschat/ui/markdown";
import {
  addRunStep,
  buildRunContext,
  CONFIDENTIAL_STUB,
  createConnectorToolSource,
  createRoutine,
  createToolGateway,
  createWebToolSource,
  deliverNoticeToRun,
  markThreadConfidential,
  messageLink,
  messageView,
  moveToBackground,
  runRoutineNow,
  sealStragglers,
  type ToolContext,
  workBrief,
} from "../src";
import { inertLinks } from "../src/format";
import { renderSteered } from "../src/live-steer";
import { closeWorlds } from "./autonomy/harness";
import { CANARY, VAULT_HOST, type VaultWorld, vaultWorld } from "./confidential-fixtures";

// ADR 0190: a server the operator vouches for marks a tool result as confidential. The run that read it goes on
// reading and answers under the message that asked it, and outside that thread no reader of a message is given the
// thread's words. Fixtures only (no real model): what is checked is what the engine stores and hands on.

afterEach(closeWorlds);

const READ = { name: "vault_read_record", input: { id: "r1" } };

const steps = (w: VaultWorld, handle = "kai") => w.runs(handle).then((runs) => w.steps(runs.map((r) => r.id)));
const sealedThreads = (w: VaultWorld) => w.db.select().from(schema.confidentialThreads);

describe("the mark", () => {
  test("from a listed server: the step carries it, the model reads the text, the reply goes under the message that asked and carries it", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      script: { kai: [{ calls: [READ] }, { text: "The customer wrote it twice." }] },
    });
    const asked = await w.say("@kai what does record r1 say?");
    await w.settle();

    const result = (await steps(w)).find((s) => s.kind === "tool_result" && s.data.name === READ.name);
    expect(result?.data.data).toMatchObject({ confidential: true, outside: true });
    // Its own model was handed the words.
    expect(w.turnsOf("kai").join("\n")).toContain(CANARY);

    const [reply] = await w.posts("kai");
    expect(reply?.threadId).toBe(asked.id);
    expect(reply?.meta.confidential).toBe(true);
    expect(await sealedThreads(w)).toEqual([
      expect.objectContaining({ rootMessageId: asked.id, channelId: w.channelId, connectionIds: [w.connectionId] }),
    ]);
  });

  test("the thread is sealed from its root: a message's body is the stub for whatever reads it, and whole for the people who read the conversation", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      script: { kai: [{ calls: [READ] }, { text: `It says ${CANARY}: see https://example.com/?q=${CANARY}` }] },
    });
    const asked = await w.say("@kai here is what they pasted: the invoice came twice. Read record r1.");
    await w.settle();

    const rows = await w.stored();
    const root = rows.find((m) => m.id === asked.id);
    const reply = rows.find((m) => m.authorType === "agent");
    // The root was written before any mark: sealed with the rest.
    expect(root?.body).toBe(CONFIDENTIAL_STUB);
    expect(root?.meta.confidential).toBe(true);
    expect(reply?.body).toBe(CONFIDENTIAL_STUB);
    for (const m of [root, reply])
      expect(JSON.stringify({ ...m, meta: { ...m?.meta, sealedBody: "" } })).not.toContain("invoice");
    // People read the words, and never get the seal's own copy beside them.
    const seen = rows.map(messageView);
    expect(seen.find((m) => m.id === asked.id)?.body).toContain("the invoice came twice");
    expect(seen.find((m) => m.id === reply?.id)?.body).toContain(`It says ${CANARY}`);
    expect(JSON.stringify(seen.map((m) => m.meta))).not.toContain("sealedBody");
    // An address the run wrote is no link in any app.
    expect(seen.find((m) => m.id === reply?.id)?.body).toBe(`It says ${CANARY}: see example.com/?q=${CANARY}`);
  });

  test("the same key from a server the operator did not list changes nothing", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      listed: false,
      script: { kai: [{ calls: [READ] }, { text: "The customer wrote it twice." }] },
    });
    const asked = await w.say("@kai what does record r1 say?");
    await w.settle();

    const result = (await steps(w)).find((s) => s.kind === "tool_result" && s.data.name === READ.name);
    expect(result?.data.data).not.toHaveProperty("confidential");
    const rows = await w.stored();
    // As before: the reply in the main timeline, every body as written, no mark anywhere.
    expect(rows.map((m) => [m.threadId, m.body])).toEqual([
      [null, "@kai what does record r1 say?"],
      [null, "The customer wrote it twice."],
    ]);
    expect(rows.find((m) => m.id === asked.id)?.meta).toEqual({});
    expect(JSON.stringify(rows)).not.toMatch(/confidential|sealedBody/);
    expect(await sealedThreads(w)).toEqual([]);
  });

  test("a run that reads no confidential result answers where it always did, and its messages are stored as written", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      script: { kai: [{ calls: [{ name: "vault_list_records", input: {} }] }, { text: "Two records." }] },
    });
    await w.say("@kai which records are there?");
    await w.settle();
    const rows = await w.stored();
    expect(rows.map((m) => [m.threadId, m.body])).toEqual([
      [null, "@kai which records are there?"],
      [null, "Two records."],
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/confidential|sealedBody/);
    expect(await sealedThreads(w)).toEqual([]);
  });
});

describe("the thread", () => {
  test("what the agent posted before stays in the main timeline; a later run of the thread reads it whole; a run asked elsewhere in the channel reads the stub and answers in the main timeline", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      script: {
        kai: [
          { text: "Hello." },
          { calls: [READ] },
          { text: `The record holds ${CANARY}.` },
          { text: "As I said above." },
          { text: "Nothing about that here." },
        ],
      },
    });
    await w.say("@kai hello");
    await w.settle();
    const asked = await w.say("@kai read record r1");
    await w.settle();
    const [hello, finding] = await w.posts("kai");
    expect([hello?.threadId, hello?.body, hello?.meta.confidential]).toEqual([null, "Hello.", undefined]);
    expect(finding?.threadId).toBe(asked.id);

    // A follow-up under the message that asked: the same thread, read whole by the run the lock holds.
    const before = w.turnsOf("kai").length;
    await w.say("@kai and what did it hold?", { threadId: asked.id });
    await w.settle();
    const inThread = w.turnsOf("kai").slice(before).join("\n");
    expect(inThread).toContain(`The record holds ${CANARY}.`);
    expect(inThread).toContain("and what did it hold?");
    const followUp = (await w.posts("kai")).at(-1);
    expect([followUp?.threadId, followUp?.meta.confidential, followUp?.body]).toEqual([
      asked.id,
      true,
      CONFIDENTIAL_STUB,
    ]);

    // Another top-level message of the same channel: the first thread is among the channel's newest messages.
    const elsewhere = w.turnsOf("kai").length;
    await w.say("@kai what did the other thread find?");
    await w.settle();
    const outside = w.turnsOf("kai").slice(elsewhere).join("\n");
    expect(outside).not.toContain(CANARY);
    expect(outside).not.toContain("and what did it hold?");
    expect(outside).toContain(CONFIDENTIAL_STUB);
    const last = (await w.posts("kai")).at(-1);
    expect([last?.threadId, last?.body, last?.meta.confidential]).toEqual([
      null,
      "Nothing about that here.",
      undefined,
    ]);
  });

  test("a run that reads a message of the thread by its link, or finds it by its words, is given the stub and stays free", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      setup: { contextTools: true },
      script: {
        kai: ({ n }) =>
          n === 1
            ? { calls: [READ] }
            : n === 2
              ? { text: `The record holds ${CANARY}.` }
              : n === 3
                ? {
                    calls: [
                      { name: "read_conversation", input: { message: link } },
                      { name: "search_context", input: { query: CANARY, kinds: ["message"] } },
                    ],
                  }
                : { text: "I can't read that from here." },
      },
    });
    let link = "";
    const asked = await w.say(`@kai read record r1 about ${CANARY}`);
    await w.settle();
    const [finding] = await w.posts("kai");
    link = messageLink(w.org.id, { channelId: w.channelId, threadId: asked.id, id: finding?.id ?? "" });

    await w.say("@kai open that link");
    await w.settle();
    const calls = (await w.calls("kai")).slice(1);
    expect(calls.map((c) => [c.name, c.isError])).toEqual([
      ["read_conversation", false],
      ["search_context", false],
    ]);
    expect(JSON.stringify(calls)).not.toContain(CANARY);
    expect(calls[0]?.result).toContain(CONFIDENTIAL_STUB);
    const last = (await w.posts("kai")).at(-1);
    expect([last?.threadId, last?.meta.confidential]).toEqual([null, undefined]);
    expect(await sealedThreads(w)).toHaveLength(1);
  });

  test("what the server writes for a run of the thread is the thread's too: a follow-up's line and its wake, a poll's result; the runs they wake are locked", async () => {
    const FETCH = { name: "web_fetch", input: { url: `https://example.com/?q=${CANARY}` } };
    let read: number | null = null;
    const w: VaultWorld = await vaultWorld({
      agents: ["kai"],
      setup: {
        blockTools: true,
        toolSources: [
          createWebToolSource({ fetch: async () => new Response("page"), resolveHost: async () => ["93.184.216.34"] }),
        ],
      },
      script: {
        kai: ({ n }) => {
          if (n === 1) return { calls: [READ] };
          read ??= w.judgments.length;
          if (n === 2)
            return {
              calls: [
                { name: "follow_up", input: { minutes: 5, note: `fetch the page for ${CANARY}`, about: "check" } },
                {
                  name: "start_poll",
                  input: { question: `poll ${CANARY}`, options: ["yes", "no"], closes_in_hours: 1 },
                },
              ],
            };
          // Its own last line, then each wake: it tries the web with the word, then says so.
          return n % 2 ? { text: "Noted." } : { calls: [FETCH] };
        },
      },
    });
    const asked = await w.say("@kai read record r1");
    await w.settle();
    const own = w.turnsOf("kai").length;
    await w.advance(10);
    await w.advance(90);

    const rows = await w.stored();
    const kinds = rows.flatMap((m) => (m.meta.notice ? [(m.meta.notice as { kind: string }).kind] : []));
    expect(kinds.sort()).toEqual(["follow_up", "follow_up", "poll_result"]);
    // Every line is under the message that asked, sealed like the rest of the thread.
    for (const m of rows.filter((m) => m.id !== asked.id)) {
      expect([m.threadId, m.meta.confidential, m.body === "" || m.body === CONFIDENTIAL_STUB]).toEqual([
        asked.id,
        true,
        true,
      ]);
    }
    // Each wake is a run of that thread: it reads its note, and the web is closed to it.
    const runs = await w.runs("kai");
    expect(runs.map((r) => r.threadRootId)).toEqual([asked.id, asked.id, asked.id]);
    expect(w.turnsOf("kai").slice(own).join("\n")).toContain(`fetch the page for ${CANARY}`);
    const fetches = (await w.calls("kai")).filter((c) => c.name === "web_fetch");
    expect(fetches.map((c) => c.isError)).toEqual([true, true]);
    // No judge and no index got the note or the poll's question.
    expect(JSON.stringify(w.judgments.slice(read ?? 0))).not.toContain(CANARY);
    expect(JSON.stringify(await w.db.select().from(schema.searchDocuments))).not.toContain(CANARY);
  });

  test("a notice for an ended run of the thread stays in the thread: not where its routine reports, nor where its long work reported", async () => {
    const notice = { kind: "wait_result" as const, text: `The late result says ${CANARY}.` };
    /** Where the notice landed, and the thread of the run it woke. */
    const told = async (w: VaultWorld, run: Parameters<typeof deliverNoticeToRun>[1]) => {
      const { message, runs } = await w.db.transaction((tx) => deliverNoticeToRun(tx, run, notice));
      return { at: [message.channelId, message.threadId], body: message.body, woke: runs.map((r) => r.threadRootId) };
    };

    // A routine's own run reads the record in its room and ends; the routine reports in the scenario's channel.
    const w = await vaultWorld({
      agents: ["kai"],
      script: { kai: ({ n }) => (n === 1 ? { calls: [READ] } : { text: "Read." }) },
    });
    const deps = { db: w.db, pubsub: w.f.pubsub, context: w.f.context };
    const routine = await createRoutine(deps, w.owner.id, w.org.id, {
      name: "Records",
      agentId: w.agents.kai?.id ?? "",
      prompt: "Read record r1.",
      target: { type: "channel", channelId: w.channelId },
      trigger: { type: "schedule", phrase: "todo dia às 8h" },
    });
    await runRoutineNow(deps, w.owner.id, w.org.id, routine.id);
    await w.settle();
    const [own] = await w.runs("kai");
    if (!own) throw new Error("no run");
    expect([own.background, own.status, own.channelId === w.channelId]).toEqual([true, "done", false]);
    expect((await sealedThreads(w)).map((t) => t.rootMessageId)).toEqual([own.threadRootId]);
    expect(await told(w, own)).toEqual({
      at: [own.channelId, own.threadRootId],
      body: CONFIDENTIAL_STUB,
      woke: [own.threadRootId],
    });
    // Nothing was written where the routine reports, which other people and agents read.
    expect(await w.stored()).toEqual([]);

    // A long work with a thread of its own, marked while it ran, then ended: its home is the main timeline.
    const v = await vaultWorld({ agents: ["kai"] });
    await v.say("@kai run the migration");
    await v.db.update(schema.agentRuns).set({ status: "running", startedAt: new Date(), heartbeatAt: new Date() });
    const [started] = await v.runs("kai");
    const moved = await moveToBackground({ db: v.db, pubsub: v.f.pubsub }, started?.id ?? "", {
      how: "agent",
      title: "Migration",
      say: "On it.",
    });
    const [working] = await v.runs("kai");
    if (!moved || !working) throw new Error("not moved");
    expect(working.threadRootId).toBe(moved.anchor.id);
    await v.db.transaction((tx) =>
      markThreadConfidential(tx, { orgId: v.org.id, channelId: v.channelId, rootId: working.threadRootId }),
    );
    await v.db.update(schema.agentRuns).set({ status: "done", finishedAt: new Date() });
    await v.db.update(schema.agentWorks).set({ status: "done", finishedAt: new Date() });
    expect(await told(v, working)).toEqual({
      at: [v.channelId, working.threadRootId],
      body: CONFIDENTIAL_STUB,
      woke: [working.threadRootId],
    });
  });

  test("a marked message outside any confidential thread is the stub for a run asked under it; a thread's words are read back only by what first read them", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      script: { kai: [{ calls: [READ] }, { text: `The record holds ${CANARY}.` }] },
    });
    const asked = await w.say("@kai read record r1");
    await w.settle();
    const agent = w.agents.kai;
    const [finding] = await w.posts("kai");
    if (!agent || !finding) throw new Error("no finding");
    // What a run of a confidential thread wrote in another place: marked, its words kept apart, no thread around it.
    const [card] = await w.db
      .insert(schema.messages)
      .values({
        orgId: w.org.id,
        channelId: w.channelId,
        authorType: "agent",
        authorAgentId: agent.id,
        body: CONFIDENTIAL_STUB,
        meta: { confidential: true, sealedBody: `Is ${CANARY} right?` },
      })
      .returning();
    if (!card) throw new Error("no card");
    const reply = await w.say("what is the status?", { threadId: card.id });
    const [run] = await w.db
      .insert(schema.agentRuns)
      .values({
        orgId: w.org.id,
        agentId: agent.id,
        channelId: w.channelId,
        threadRootId: card.id,
        triggerMessageId: reply.id,
        trigger: "mention",
        hop: 1,
      })
      .returning();
    if (!run) throw new Error("no run");
    const context = await buildRunContext(w.db, run, agent, { maxMessages: 30, unseal: true });
    expect(JSON.stringify(context.messages)).not.toContain(CANARY);
    expect(context.confidential).toBe(false);

    // Messages a run takes while it works: whole for a run of the thread that thinks with what first read it.
    const taken = async (id: string, unseal?: { threadRootId: string; thinksWith: string | undefined }) =>
      (await renderSteered(w.db, w.org.id, [id], unseal ? { unseal } : {})).map((m) => m.text).join("\n");
    const [thread] = await sealedThreads(w);
    expect(thread?.thinksWith).toBe("model:anthropic");
    expect(await taken(finding.id, { threadRootId: asked.id, thinksWith: "model:anthropic" })).toContain(CANARY);
    for (const other of [
      await taken(finding.id, { threadRootId: asked.id, thinksWith: "model:openai" }),
      await taken(finding.id, { threadRootId: asked.id, thinksWith: undefined }),
      await taken(finding.id),
      await taken(card.id, { threadRootId: card.id, thinksWith: "model:anthropic" }),
    ]) {
      expect(other).not.toContain(CANARY);
      expect(other).toContain(CONFIDENTIAL_STUB);
    }
  });
});

describe("a run that does not think through the Model Gateway", () => {
  /** A run of the world's agent, started by hand so its brain can be set. */
  async function runOf(w: VaultWorld, brain: string) {
    const asked = await w.say("read record r1");
    const [run] = await w.db
      .insert(schema.agentRuns)
      .values({
        orgId: w.org.id,
        agentId: w.agents.kai?.id ?? "",
        channelId: w.channelId,
        threadRootId: asked.id,
        triggerMessageId: asked.id,
        trigger: "mention",
        hop: 1,
        status: "running",
        brain,
      })
      .returning();
    if (!run) throw new Error("no run");
    const ctx: ToolContext = {
      db: w.db,
      orgId: w.org.id,
      agentId: run.agentId,
      runId: run.id,
      channelId: w.channelId,
      threadRootId: asked.id,
      triggerMessageId: asked.id,
    };
    return { run, ctx, asked };
  }
  const gatewayOf = (w: VaultWorld) =>
    createToolGateway({
      sources: [
        createConnectorToolSource({
          db: w.db,
          keyWrappers: [w.f.keyWrapper],
          publicUrl: "https://chat.example.com",
          resolveHost: async () => ["93.184.216.34"],
          connect: w.vault.connect,
          callerIdentity: new Map([[VAULT_HOST, "test-secret-".padEnd(32, "x")]]),
        }),
      ],
    });

  test("a program on a computer is given the stub for the result, and nothing is marked", async () => {
    const w = await vaultWorld({ agents: ["kai"] });
    const gateway = gatewayOf(w);
    for (const [brain, bridge] of [
      ["claude_code", undefined],
      ["model", { machineId: "m1" }],
    ] as const) {
      const { run, ctx } = await runOf(w, brain);
      const out = await gateway.invoke({ ...ctx, ...(bridge ? { bridge } : {}) }, { toolUseId: "t1", ...READ });
      expect(out).toMatchObject({ type: "result", output: { content: CONFIDENTIAL_STUB } });
      const kept = await w.steps([run.id]);
      expect(JSON.stringify(kept)).not.toContain(CANARY);
      expect(JSON.stringify(kept)).not.toContain('"confidential"');
    }
    expect(await sealedThreads(w)).toEqual([]);
    expect(JSON.stringify(await w.stored())).not.toMatch(/"confidential"|sealedBody/);
  });

  test("a run that thinks with another provider than the thread's first reader is given the stub for a result", async () => {
    const w = await vaultWorld({ agents: ["kai"] });
    const gateway = gatewayOf(w);
    const first = await runOf(w, "model");
    const read = await gateway.invoke({ ...first.ctx, thinksWith: "model:anthropic" }, { toolUseId: "t1", ...READ });
    expect(read).toMatchObject({ type: "result", output: { content: expect.stringContaining(CANARY) } });
    expect((await sealedThreads(w)).map((t) => t.thinksWith)).toEqual(["model:anthropic"]);
    // Runs of the same thread that were already going when it was marked, so nothing ended them before their call.
    const later = async (thinksWith: string) => {
      const asked = await w.past("ana", "and again?", 0, first.asked.id);
      const [run] = await w.db
        .insert(schema.agentRuns)
        .values({ ...first.run, id: crypto.randomUUID(), triggerMessageId: asked.id, createdAt: new Date() })
        .returning();
      if (!run) throw new Error("no run");
      const out = await gateway.invoke({ ...first.ctx, runId: run.id, thinksWith }, { toolUseId: "t2", ...READ });
      return { out, kept: JSON.stringify(await w.steps([run.id])) };
    };
    const other = await later("model:openai");
    expect(other.out).toMatchObject({ type: "result", output: { content: CONFIDENTIAL_STUB } });
    expect(other.kept).not.toContain(CANARY);
    const same = await later("model:anthropic");
    expect(same.out).toMatchObject({ type: "result", output: { content: expect.stringContaining(CANARY) } });
    expect(same.kept).toContain(CANARY);
  });

  test("in a confidential thread its context holds the stub for the thread's own messages too", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      script: { kai: [{ calls: [READ] }, { text: `The record holds ${CANARY}.` }] },
    });
    const asked = await w.say("@kai read record r1");
    await w.settle();
    const reply = await w.say("and then?", { threadId: asked.id });
    const [run] = await w.db
      .insert(schema.agentRuns)
      .values({
        orgId: w.org.id,
        agentId: w.agents.kai?.id ?? "",
        channelId: w.channelId,
        threadRootId: asked.id,
        triggerMessageId: reply.id,
        trigger: "mention",
        hop: 1,
      })
      .returning();
    const agent = w.agents.kai;
    if (!run || !agent) throw new Error("no run");
    const read = async (unseal: boolean) =>
      JSON.stringify((await buildRunContext(w.db, run, agent, { maxMessages: 30, unseal })).messages);
    const sealed = await read(false);
    expect(sealed).not.toContain(CANARY);
    expect(sealed).not.toContain("and then?");
    expect(sealed).toContain(CONFIDENTIAL_STUB);
    const whole = await read(true);
    expect(whole).toContain(`The record holds ${CANARY}.`);
    expect(whole).toContain("and then?");
  });
});

describe("the seal", () => {
  test("a thread's messages leave the search index in the transaction that marks it, before any job runs", async () => {
    const w = await vaultWorld({ agents: ["kai"], script: { kai: [{ text: "Noted." }] } });
    const asked = await w.say(`@kai note this: ${CANARY}`);
    await w.settle();
    const indexed = async () => JSON.stringify(await w.db.select().from(schema.searchDocuments));
    expect(await indexed()).toContain(CANARY);
    await w.db.transaction((tx) =>
      markThreadConfidential(tx, { orgId: w.org.id, channelId: w.channelId, rootId: asked.id }),
    );
    expect(await indexed()).not.toContain(CANARY);
  });

  test("a note the server rewords in place shows its new text, and a message the mark missed is sealed by the sweep", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      script: { kai: [{ calls: [READ] }, { text: `The record holds ${CANARY}.` }] },
    });
    const asked = await w.say("@kai read record r1");
    await w.settle();
    const [reply] = await w.posts("kai");
    const row = async (id: string) => {
      const found = (await w.stored()).find((m) => m.id === id);
      if (!found) throw new Error(`no message ${id}`);
      return found;
    };
    // The server writes a note's body again (a wait that ended).
    await w.db
      .update(schema.messages)
      .set({ body: "The provider answers again." })
      .where(eq(schema.messages.id, reply?.id ?? ""));
    expect(messageView(await row(reply?.id ?? "")).body).toBe("The provider answers again.");
    // Written while the mark was being committed: stored as typed.
    const [late] = await w.db
      .insert(schema.messages)
      .values({
        orgId: w.org.id,
        channelId: w.channelId,
        threadId: asked.id,
        authorType: "person",
        authorUserId: w.owner.id,
        body: "typed during the mark",
      })
      .returning();
    expect(await sealStragglers(w.db)).toBe(2);
    for (const [id, words] of [
      [reply?.id ?? "", "The provider answers again."],
      [late?.id ?? "", "typed during the mark"],
    ] as const) {
      const sealed = await row(id);
      expect([sealed.body, sealed.meta.confidential, messageView(sealed).body]).toEqual([
        CONFIDENTIAL_STUB,
        true,
        words,
      ]);
    }
    expect(await sealStragglers(w.db)).toBe(0);
  });

  test("a run of a confidential thread is not moved to the background: it answers in its thread", async () => {
    const w = await vaultWorld({
      agents: ["kai"],
      script: {
        kai: [
          { calls: [READ] },
          {
            calls: [
              { name: "ask_user", input: { question: "Go on?", why: "Only the person can say whether to go on." } },
            ],
          },
        ],
      },
    });
    await w.say("@kai read record r1 and ask me");
    await w.settle();
    const [run] = await w.runs("kai");
    expect(run?.status).toBe("waiting_input");
    expect(await moveToBackground({ db: w.db }, run?.id ?? "", { how: "auto", title: "Reading" })).toBeNull();
    expect((await w.runs("kai"))[0]?.workId).toBeNull();
  });

  test("a long work already going when it read the result: what it said between its calls is not handed to the agent's other runs", async () => {
    const w = await vaultWorld({ agents: ["kai"] });
    await w.say("@kai run the migration");
    const [started] = await w.runs("kai");
    if (!started) throw new Error("no run");
    await w.db.update(schema.agentRuns).set({ status: "running", startedAt: new Date(), heartbeatAt: new Date() });
    const moved = await moveToBackground({ db: w.db, pubsub: w.f.pubsub }, started.id, {
      how: "agent",
      title: "Migration",
      say: "On it.",
    });
    const [working] = await w.runs("kai");
    if (!moved || !working) throw new Error("not moved");
    await addRunStep(w.db, working, "model_call", { narration: `The record says ${CANARY}.` });
    const other = { orgId: w.org.id, agentId: working.agentId, channelId: w.channelId, id: crypto.randomUUID() };
    // Before any mark, as always.
    expect(await workBrief(w.db, other)).toContain(CANARY);
    await w.db.transaction((tx) =>
      markThreadConfidential(tx, { orgId: w.org.id, channelId: w.channelId, rootId: working.threadRootId }),
    );
    const brief = await workBrief(w.db, other);
    expect(brief).toContain(`work_id ${moved.work.id}`);
    expect(brief).not.toContain(CANARY);
  });
});

/** The addresses the web app would make a link of, by its own inline grammar (`renderInline`). */
function webLinks(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  for (let m = rest.match(INLINE); m && m.index !== undefined; m = rest.match(INLINE)) {
    const href = m[4] ? (m[0].match(/\]\(([^)\s]+)\)$/)?.[1] ?? "") : m[5] ? m[0] : "";
    if (SAFE_URL.test(href)) out.push(href);
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

test("inertLinks: a link keeps its words and an address loses its scheme, in code too", () => {
  expect(inertLinks("see [the report](https://example.com/r?x=1) and https://example.com/a?b=c.")).toBe(
    "see the report and example.com/a?b=c.",
  );
  expect(inertLinks("![](https://example.com/p.png) [](HTTP://example.com/q)")).toBe("example.com/p.png example.com/q");
  expect(inertLinks("run `curl https://example.com` then\n```\nhttps://example.com/x\n```")).toBe(
    "run `curl example.com` then\n```\nexample.com/x\n```",
  );
  expect(inertLinks("no address here, and `handlers[name]` is code")).toBe(
    "no address here, and `handlers[name]` is code",
  );
});

test("inertLinks: what one app reads as code and another as words holds no link for either", () => {
  // A fence in the middle of a line and a lone backtick: code to one grammar, and to the web a code span ("` a `")
  // followed by words.
  const crafted = [
    "Summary ``` a ` b [open the report](https://example.com/?q=WORDS) ```",
    "Summary ``` a ` b https://example.com/?q=WORDS ```",
    "a ` b https://example.com/?q=WORDS",
    "<https://example.com/?q=WORDS>",
    "[the report][r]\n\n[r]: https://example.com/?q=WORDS",
    // What a dropped scheme, or a dropped empty link, would put together.
    "hthttps://tps://example.com/?q=WORDS",
    "[open]https://(mailto:ana@example.com?subject=WORDS)",
    "[open][]()(http:example.com/?q=WORDS)",
    "ftp://example.com/WORDS",
  ];
  // Each is a link on the web as written, or would be one once a scheme is dropped from it.
  expect(crafted.slice(0, 5).map((text) => webLinks(text).length)).toEqual([1, 1, 1, 1, 1]);
  for (const text of crafted) {
    const stored = inertLinks(text);
    expect(stored).not.toContain("](");
    expect(stored).not.toMatch(/:\/\/\S/);
    expect(webLinks(stored)).toEqual([]);
    expect(stored).toContain("WORDS");
  }
  expect(crafted.slice(0, 5).map(inertLinks)).toEqual([
    "Summary ``` a ` b [open the report] (example.com/?q=WORDS) ```",
    "Summary ``` a ` b example.com/?q=WORDS ```",
    "a ` b example.com/?q=WORDS",
    "<example.com/?q=WORDS>",
    "[the report][r]\n\n[r]: example.com/?q=WORDS",
  ]);
});

test("inertLinks reads a text of nothing but brackets once, and lets no long link by", () => {
  // Each of these made the old pattern start over at every bracket: seconds of the server's one thread.
  const floods = ["[".repeat(100_000), "[a ".repeat(33_000), "[x](y".repeat(20_000), "](".repeat(50_000)];
  const started = performance.now();
  for (const flood of floods) expect(inertLinks(flood)).not.toContain("](");
  expect(performance.now() - started).toBeLessThan(1500);
  // A link whose address is longer than the pattern takes is pulled apart, so no app reads it as one.
  const long = `[open](mailto:ana@example.com?body=${"x".repeat(3000)})`;
  expect(inertLinks(long)).toBe(long.replace("](", "] ("));
  // Words that hold a bracket: the link inside them goes, as an app would have linked it.
  expect(inertLinks("[a [b](https://example.com/c)")).toBe("[a b");
});

test("a workspace's messages are untouched by the seal's statement when no thread is confidential", async () => {
  const w = await vaultWorld({ agents: ["kai"], script: { kai: [{ text: "Hi." }, { text: "In the thread." }] } });
  const top = await w.say("@kai hi");
  await w.settle();
  await w.say("@kai and here?", { threadId: top.id });
  await w.settle();
  const rows = await w.stored();
  expect(rows.map((m) => [m.threadId, m.body, m.meta.confidential])).toEqual([
    [null, "@kai hi", undefined],
    [null, "Hi.", undefined],
    [top.id, "@kai and here?", undefined],
    [top.id, "In the thread.", undefined],
  ]);
  const [agentRow] = await w.db.select().from(schema.messages).where(eq(schema.messages.authorType, "agent"));
  expect(agentRow?.meta).not.toHaveProperty("sealedBody");
});
