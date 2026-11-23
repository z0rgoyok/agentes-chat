import { afterEach, describe, expect, test } from "bun:test";
import { channelTopic } from "@agenteschat/adapters";
import { countQueries, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  addChannelMember,
  ConflictError,
  cancelRun,
  createAgent,
  createRole,
  drainOutbox,
  ForbiddenError,
  listMessages,
  mayStopRun,
  OrgDeletingError,
  postPersonMessage,
  REACH_COLUMNS,
  requireActiveMembership,
  SYSTEM_STOP_REASONS,
  type SystemStopReason,
  setMemberRoles,
  standingText,
  stopChecksSettled,
  stopError,
  stopOf,
  stopOrgWork,
  type ToolSource,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { connectedComputer } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const runOf = async () => (await f.db.select().from(schema.agentRuns))[0];
const deps = () => ({ db: f.db, pubsub: f.pubsub });
const ask = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });

/** Runs `fn` once, the first time an event of `type` reaches the channel. */
function onFirst(type: string, fn: (event: Record<string, unknown>) => void) {
  let seen = false;
  f.pubsub.subscribe(channelTopic(f.general.id), (event) => {
    if (seen || event.type !== type) return;
    seen = true;
    fn(event as Record<string, unknown>);
  });
}

describe("canceling a run", () => {
  test("while streaming: the stream stops, the text so far is kept with who stopped it, usage recorded", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    f = await setup({
      reply: (_req: ModelRequest, call: number) =>
        call === 1 ? { chunks: ["Começando a análise. ", "Isto nunca chega."], hold } : { chunks: ["não deveria"] },
    });
    const events = f.listen(f.general.id);
    await ask("@dev analisa os logs");
    onFirst("agent.typing", (e) => {
      void cancelRun(deps(), f.owner.id, f.org.id, String(e.runId)).finally(release);
    });
    await drainOutbox(f.db, f.handlers);

    const run = await runOf();
    expect(run?.status).toBe("canceled");
    expect(f.provider.calls).toHaveLength(1);
    // Asked in the channel: the stopped reply is in the main timeline.
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(main.at(-1)?.body).toBe("Começando a análise.\n\n_Stopped by ana._");
    expect(main.at(-1)?.meta).toMatchObject({ canceled: { byUserId: f.owner.id } });

    const usage = await f.db
      .select()
      .from(schema.usageRecords)
      .where(eq(schema.usageRecords.runId, run?.id ?? ""));
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ partial: true, agentId: f.agent.id });

    const types = events.map((e) => e.type);
    expect(types).toContain("run.canceled");
    expect(events.find((e) => e.type === "run.finished")).toMatchObject({ status: "canceled" });
    const [audit] = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "run.canceled"));
    expect(audit).toMatchObject({ actorId: f.owner.id, targetId: run?.id });
  });

  test("during a tool call: running code is killed, no further model call, its working text stays out of the chat", async () => {
    f = await setup({
      machines: true,
      reply: (_req: ModelRequest, call: number) =>
        call === 1
          ? {
              chunks: ["Vou compilar."],
              toolUses: [{ name: "run_code", input: { language: "bash", code: "make all" } }],
            }
          : { chunks: ["não deveria"] },
    });
    // Stopped while the command runs on the computer (it never ends by itself): the runner is told to kill it.
    const { runner } = await connectedComputer(f, {
      exec: () => {
        void runOf().then((r) => cancelRun(deps(), f.owner.id, f.org.id, r?.id ?? ""));
        return "hang";
      },
    });
    await ask("@dev compila");
    const started = Date.now();
    await drainOutbox(f.db, f.handlers);
    expect(Date.now() - started).toBeLessThan(4000);

    expect((await runOf())?.status).toBe("canceled");
    expect(runner.sent.some((s) => s.type === "cancel")).toBe(true);
    expect(f.provider.calls).toHaveLength(1);
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(main.at(-1)?.body).toBe("_Stopped by ana._");
    // Still in the run's activity.
    const [called] = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.kind, "model_call"));
    expect(called?.data).toMatchObject({ narration: "Vou compilar." });
  });

  test("while queued: it never starts and its job is dropped", async () => {
    f = await setup();
    const events = f.listen(f.general.id);
    await ask("@dev oi");
    const run = await runOf();
    expect(run?.status).toBe("queued");
    const result = await cancelRun(deps(), f.owner.id, f.org.id, run?.id ?? "");
    expect(result).toMatchObject({ status: "canceled", previousStatus: "queued" });
    const jobs = (await f.db.select().from(schema.outbox)).filter((j) => j.kind === "agent_run.execute");
    expect(jobs.filter((j) => j.status === "pending")).toEqual([]);
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(0);
    expect((await runOf())?.status).toBe("canceled");
    expect(stopOf((await runOf())?.error)).toEqual({ by: "person", userId: f.owner.id, agentId: null, reason: null });
    expect(events.find((e) => e.type === "run.finished")).toMatchObject({ status: "canceled" });
    // It never answered: "didn't reply", live and after a reload.
    expect(events.find((e) => e.type === "message.handled")).toMatchObject({ status: "canceled", passed: true });
    const [listed] = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(listed?.receipts?.handled[0]).toMatchObject({ status: "canceled", passed: true });
  });

  test("permissions: the person who asked, the agent's owner or admins; finished runs can't be canceled", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, f.general.id, { body: "@dev oi" });
    const run = await runOf();
    await expect(cancelRun(deps(), caio.id, f.org.id, run?.id ?? "")).rejects.toBeInstanceOf(ForbiddenError);
    expect((await cancelRun(deps(), bia.id, f.org.id, run?.id ?? "")).status).toBe("canceled");
    await expect(cancelRun(deps(), f.owner.id, f.org.id, run?.id ?? "")).rejects.toMatchObject({
      code: "run_finished",
    });
    await expect(cancelRun(deps(), f.owner.id, f.org.id, run?.id ?? "")).rejects.toBeInstanceOf(ConflictError);

    // The agent's owner (not an admin) may stop its runs too.
    const hers = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Bot", handle: "bot", ownerUserId: caio.id },
      { model: "claude-sonnet-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: hers.id });
    await ask("@bot oi");
    const [other] = (await f.db.select().from(schema.agentRuns)).filter((r) => r.agentId === hers.id);
    expect((await cancelRun(deps(), caio.id, f.org.id, other?.id ?? "")).status).toBe("canceled");
  });

  test("'Edit agents' stops the runs of an agent whose audience takes them, never a private agent's", async () => {
    f = await setup();
    const keys = await createRole(f.db, f.owner.id, f.org.id, { name: "Agentes", permissions: ["manage_agents"] });
    const lia = await addMember(f.db, f.org.id, "member", "lia");
    await setMemberRoles(f.db, f.owner.id, f.org.id, lia.id, [keys.id]);
    // Ana's @dev, kept to her: the key alone doesn't reach it (ADR 0085 addendum of 2026-11-17).
    const audience = (mode: "owner" | "everyone") =>
      f.db.update(schema.agents).set({ audienceMode: mode }).where(eq(schema.agents.id, f.agent.id));
    await audience("owner");
    await ask("@dev oi");
    const run = await runOf();
    if (!run) throw new Error("no run");
    await expect(cancelRun(deps(), lia.id, f.org.id, run.id)).rejects.toMatchObject({ code: "run.cancel_forbidden" });

    await audience("everyone");
    // Given the run's agent, as a list of runs passes it, the rule reads nothing for it; else only its reach.
    const membership = await requireActiveMembership(f.db, lia.id, f.org.id);
    const row = { run, requester: f.owner.id, ownerUserId: f.owner.id };
    const [agent] = await f.db.select(REACH_COLUMNS).from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(await countQueries(() => mayStopRun(f.db, lia.id, membership, { ...row, agent }))).toEqual({
      result: true,
      queries: 0,
    });
    expect(await countQueries(() => mayStopRun(f.db, lia.id, membership, row))).toEqual({ result: true, queries: 1 });
    expect((await cancelRun(deps(), lia.id, f.org.id, run.id)).status).toBe("canceled");
  });
});

describe("who or what stopped a run, from its error", () => {
  const system = (reason: SystemStopReason): ReturnType<typeof stopOf> => ({
    by: "system",
    userId: null,
    agentId: null,
    reason,
  });

  test("a person, the agent that stopped it at their word, or the system with a listed reason", () => {
    const agentId = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
    expect(stopOf(stopError({ type: "person", id: "user-1" }))).toEqual({
      by: "person",
      userId: "user-1",
      agentId: null,
      reason: null,
    });
    expect(stopOf(stopError({ type: "person", id: "user-1", agentId }))).toEqual({
      by: "agent",
      userId: "user-1",
      agentId,
      reason: null,
    });
    for (const reason of SYSTEM_STOP_REASONS) {
      expect(stopOf(stopError({ type: "system", reason }))).toEqual(system(reason));
    }
    // A closed workspace's stop holds the refusal's sentence, with a reason someone may have written: never returned.
    const closed = (state: "hold" | "suspended", reason: string | null) =>
      stopOf(standingText({ state, reason, notice: reason ? "shown" : "silent" }));
    expect(closed("hold", null)).toEqual(system("workspace_paused"));
    expect(closed("hold", "Lena wrote this reason")).toEqual(system("workspace_paused"));
    expect(closed("suspended", null)).toEqual(system("workspace_suspended"));
    expect(closed("suspended", "Lena wrote this reason")).toEqual(system("workspace_suspended"));
    expect(stopOf(new OrgDeletingError(null).message)).toEqual(system("workspace_deleting"));
    // A reason the list doesn't hold, and anything else in its place.
    for (const unknown of ["routine_some_new_code", "mission_some_new_reason", "Lena wrote this"]) {
      expect(stopOf(unknown)).toEqual(system("other"));
    }
    // An older row's stop by a mission with nobody behind it is no person's.
    expect(stopOf("canceled_by:mission")).toEqual(system("other"));
    // No error kept: nothing says who stopped it.
    for (const none of ["", null, undefined]) expect(stopOf(none)).toBeNull();
  });

  test("a workspace put on hold stops its runs, and each says so", async () => {
    f = await setup();
    await ask("@dev oi");
    const said = standingText({ state: "hold", reason: "Lena wrote this reason", notice: "shown" });
    await stopOrgWork(deps(), f.org.id, said);
    const run = await runOf();
    expect([run?.status, run?.error]).toEqual(["canceled", said]);
    expect(stopOf(run?.error)).toEqual(system("workspace_paused"));
    const [audited] = (await f.db.select().from(schema.auditLog)).filter((a) => a.action === "run.canceled");
    expect(audited).toMatchObject({
      actorType: "system",
      details: { agentId: f.agent.id, from: "queued", reason: said },
    });
  });
});

describe("one active run per agent and conversation", () => {
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

  test("a message during a tool call goes to the next model call, with no second run", async () => {
    let threadId = "";
    const requests: string[] = [];
    f = await setup({
      toolSources: [
        slowTool(() =>
          postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
            body: "usa a branch dev, por favor",
            threadId,
          }),
        ),
      ],
      reply: (req: ModelRequest, call: number) => {
        requests.push(JSON.stringify(req.messages.at(-1)?.content));
        return call === 1
          ? { chunks: ["Compilando."], toolUses: [{ name: "build", input: {} }] }
          : { chunks: ["Feito, na branch dev."] };
      },
    });
    const events = f.listen(f.general.id);
    const question = await ask("@dev compila o projeto");
    threadId = question.id;
    await drainOutbox(f.db, f.handlers);

    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("done");
    expect(requests[1]).toContain("New message from ana");
    expect(requests[1]).toContain("usa a branch dev, por favor");
    expect(requests[1]).toContain("build ok");
    expect(events.find((e) => e.type === "agent.run.steered")).toMatchObject({ runId: runs[0]?.id });
    // The reply is in the main timeline, where it was asked; the message sent to it, in the thread.
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(main.map((m) => m.body)).toEqual(["@dev compila o projeto", "Feito, na branch dev."]);
    const thread = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: question.id });
    expect(thread.map((m) => m.body)).toEqual(["@dev compila o projeto", "usa a branch dev, por favor"]);
  });

  test("coalescing: a second message while queued joins the same run", async () => {
    const requests: string[] = [];
    f = await setup({
      reply: (req: ModelRequest) => {
        requests.push(JSON.stringify(req.messages));
        return { chunks: ["Certo."] };
      },
    });
    const question = await ask("@dev prepara o relatório");
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev inclui os números de setembro",
      threadId: question.id,
    });
    expect(await f.db.select().from(schema.agentRuns)).toHaveLength(1);
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(1);
    expect(requests[0]).toContain("inclui os números de setembro");
    expect((await runOf())?.pendingMessageIds).toEqual([]);
  });

  test('a stop ("para", as the judge hears it) while it works cancels the task instead of starting another', async () => {
    let threadId = "";
    f = await setup({
      judge: (kind, _id, state) => (kind === "steer_triage" ? (state.message === "para" ? "stop" : undefined) : 0),
      toolSources: [
        slowTool(async () => {
          await postPersonMessage(
            { db: f.db, pubsub: f.pubsub, judge: f.context.judge },
            f.owner.id,
            f.org.id,
            f.general.id,
            {
              body: "para",
              threadId,
            },
          );
          // The stop is judged after the post returns (the send never waits for it).
          await stopChecksSettled();
        }),
      ],
      reply: (_req: ModelRequest, call: number) =>
        call === 1 ? { chunks: [], toolUses: [{ name: "build", input: {} }] } : { chunks: ["não deveria"] },
    });
    const question = await ask("@dev compila");
    threadId = question.id;
    await drainOutbox(f.db, f.handlers);
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("canceled");
    expect(f.provider.calls).toHaveLength(1);
  });
});
