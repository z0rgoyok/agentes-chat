import { afterEach, describe, expect, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import {
  type AgentRun,
  createAgent,
  endWork,
  getIssue,
  insertMessage,
  movableRun,
  onConsultedRunFinished,
  planStepOf,
  postWorkUpdate,
  recoverStaleRuns,
  type ToolContext,
  workEligible,
  workView,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  await f?.close();
  f = undefined as unknown as Fixture;
});

const addAgent = (name: string) =>
  createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name, handle: name.toLowerCase(), role: "Operations", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );

/** A run of @dev in #general on the person's message: the conversation the hand-off reports to. */
async function devRun(body: string) {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body,
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      stretchId: trigger.id,
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

const ctxOf = (run: AgentRun): ToolContext => ({
  db: f.db,
  orgId: run.orgId,
  agentId: run.agentId,
  runId: run.id,
  channelId: run.channelId,
  threadRootId: run.threadRootId,
  triggerMessageId: run.triggerMessageId,
});

const tell = (run: AgentRun, agent: string, message: string, more: Record<string, unknown> = {}) => {
  if (!f.tools) throw new Error("no tools");
  return f.tools.invoke(ctxOf(run), {
    toolUseId: `tu_${crypto.randomUUID()}`,
    name: "tell_agent",
    input: { agent, message, ...more },
  });
};

const consultations = () =>
  f.db
    .select()
    .from(schema.agentConsultations)
    .orderBy(asc(schema.agentConsultations.createdAt), asc(schema.agentConsultations.id));
const works = () => f.db.select().from(schema.agentWorks).orderBy(asc(schema.agentWorks.createdAt));
const runOf = async (id: string | null | undefined) => {
  const [run] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, id ?? ""));
  if (!run) throw new Error("no run");
  return run;
};

/** Atlas's run ends with `body` as its report (`meta.workEnd`, as the executor posts it), then its hooks run. */
async function reports(run: AgentRun, body: string) {
  const said = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: run.channelId,
    author: { type: "agent", agentId: run.agentId, runId: run.id, hop: run.hop },
    body,
    meta: { workEnd: { id: run.workId, status: "done" } },
  });
  await f.db
    .update(schema.agentRuns)
    .set({ status: "done", replyMessageId: said.id })
    .where(eq(schema.agentRuns.id, run.id));
  const ended = await runOf(run.id);
  await endWork({ db: f.db, pubsub: f.pubsub }, ended, "done");
  await onConsultedRunFinished({ db: f.db, pubsub: f.pubsub, judge: f.context.judge }, ended, "done");
  return said;
}

describe("work handed to another agent reports where the person asked (F1)", () => {
  test("tell_agent makes the run it starts a handed work, reporting in the person's conversation", async () => {
    f = await setup({ askAgent: true });
    const atlas = await addAgent("Atlas");
    const dev = await devRun("@dev get the October sales report ready");
    await tell(dev, "@atlas", "Build the October sales report.\nOrders and refunds.");
    const [c] = await consultations();
    const [w] = await works();
    const run = await runOf(c?.targetRunId);
    expect(w).toMatchObject({
      how: "handed",
      agentId: atlas.id,
      channelId: f.general.id,
      handedThreadId: null,
      consultationId: c?.id,
      anchorMessageId: c?.messageId,
      requestedByUserId: f.owner.id,
      title: "Build the October sales report.",
      status: "live",
    });
    expect(run.workId).toBe(w?.id ?? "");
    const view = await workView(f.db, f.org.id, w?.id ?? "");
    expect(view).toMatchObject({
      how: "handed",
      channelId: f.general.id,
      homeThreadId: null,
      askerRunId: dev.id,
      handedBy: { agentId: f.agent.id, consultationId: c?.id },
    });
    // Its card on the board, made by the agent that handed it, from where the person asked.
    const issue = await getIssue(f.db, { type: "person", userId: f.owner.id }, f.org.id, { id: w?.issueId ?? "" });
    expect(issue).toMatchObject({
      assignees: [{ type: "agent", id: atlas.id }],
      createdBy: { type: "agent", id: f.agent.id },
      source: { type: "agent", agentId: f.agent.id, channelId: f.general.id, messageId: dev.triggerMessageId },
    });
    expect(issue.backgroundWork?.handedBy?.agentId).toBe(f.agent.id);
  });

  test("the agent that handed it is told the person follows the work there, and that it isn't woken to relay it", async () => {
    f = await setup({ askAgent: true });
    await addAgent("Atlas");
    const dev = await devRun("@dev get the report ready");
    const out = await tell(dev, "@atlas", "Build the October sales report.");
    expect(out).toMatchObject({
      output: { content: expect.stringContaining("you are not woken to relay what comes of it") },
    });
  });

  test("a run a note only joined never becomes a handed work, even through work_in_background", async () => {
    f = await setup({ askAgent: true });
    await addAgent("Atlas");
    const dev = await devRun("@dev get the report ready");
    await tell(dev, "@atlas", "Build the October sales report.");
    const [c] = await consultations();
    const run = await runOf(c?.targetRunId);
    // As if the run had started on something else and this note joined it.
    expect(await workEligible(f.db, { ...run, workId: null, triggerMessageId: dev.triggerMessageId })).toBe(false);
  });

  test("a note that joins a run already at work makes no second work", async () => {
    f = await setup({ askAgent: true });
    await addAgent("Atlas");
    const dev = await devRun("@dev tell atlas");
    await tell(dev, "@atlas", "First part.");
    await tell(dev, "@atlas", "Second part.");
    const [first, second] = await consultations();
    expect(second?.targetRunId).toBe(first?.targetRunId ?? "");
    expect(await works()).toHaveLength(1);
  });

  test("a second note that joins the work rides on it: the sender is told so, and neither note wakes it", async () => {
    f = await setup({ askAgent: true });
    await addAgent("Atlas");
    const dev = await devRun("@dev tell atlas");
    await tell(dev, "@atlas", "Build the October sales report.");
    const out = await tell(dev, "@atlas", "Add the refunds too.");
    expect(out).toMatchObject({
      output: { content: expect.stringContaining("you are not woken to relay what comes of it") },
    });
    const [c] = await consultations();
    // Its run read the second note at its next step.
    await f.db
      .update(schema.agentRuns)
      .set({ pendingMessageIds: [] })
      .where(eq(schema.agentRuns.id, c?.targetRunId ?? ""));
    await reports(await runOf(c?.targetRunId), "Report saved in Drive, refunds included.");
    expect((await consultations()).map((r) => r.status)).toEqual(["answered", "answered"]);
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs.filter((r) => r.agentId === f.agent.id)).toHaveLength(1);
  });

  test("a delegate lost in a restart posts its end home before the sender hears it, so the sender isn't woken", async () => {
    f = await setup({ askAgent: true });
    const atlas = await addAgent("Atlas");
    const dev = await devRun("@dev get the report ready");
    await tell(dev, "@atlas", "Build the October sales report.");
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, dev.id));
    const [c] = await consultations();
    const long = new Date(Date.now() - 10 * 60_000);
    await f.db
      .update(schema.agentRuns)
      .set({ status: "running", startedAt: long, heartbeatAt: long })
      .where(eq(schema.agentRuns.id, c?.targetRunId ?? ""));
    // Its job went with its worker.
    await f.db.update(schema.outbox).set({ status: "done" }).where(eq(schema.outbox.kind, "agent_run.execute"));
    expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).failed).toEqual([c?.targetRunId ?? ""]);
    const [w] = await works();
    const [end] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, w?.resultMessageId ?? ""));
    expect(end).toMatchObject({ channelId: f.general.id, authorAgentId: atlas.id });
    expect((await consultations())[0]?.status).toBe("failed");
    const notice = (await f.db.select().from(schema.messages)).find(
      (m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "consult_reply",
    );
    expect((notice?.meta.notice as { refs?: { wake?: string } } | undefined)?.refs).toMatchObject({ status: "failed" });
    expect((notice?.meta.notice as { refs?: { wake?: string } } | undefined)?.refs?.wake).toBeUndefined();
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs.filter((r) => r.agentId === f.agent.id)).toHaveLength(1);
  });

  test("the delegate may post updates: they land in the person's conversation as its own", async () => {
    f = await setup({ askAgent: true });
    const atlas = await addAgent("Atlas");
    const dev = await devRun("@dev get the report ready");
    await tell(dev, "@atlas", "Build the October sales report.");
    const [c] = await consultations();
    const run = await runOf(c?.targetRunId);
    // Already its work: no second move, and the run counts as one people follow.
    expect(await workEligible(f.db, { ...run, workId: null })).toBe(true);
    expect(await movableRun(f.db, run)).toBe(false);
    const out = await postWorkUpdate({ db: f.db, pubsub: f.pubsub }, run.id, {
      text: "Pulled 1,284 October orders from the store.",
      plan: [
        { id: "s1", text: "Pull orders", state: "done" },
        { id: "s2", text: "Match refunds", state: "doing" },
      ],
    });
    if (!out.ok) throw new Error(out.reason);
    expect(out.message).toMatchObject({
      channelId: f.general.id,
      threadId: null,
      authorAgentId: atlas.id,
      agentRunId: run.id,
    });
    expect((await workView(f.db, f.org.id, out.work.id))?.planStep).toEqual({ current: 2, total: 2 });
  });

  test("its report is copied home, which becomes the result; the card goes to Done with its first line", async () => {
    f = await setup({ askAgent: true });
    await addAgent("Atlas");
    const dev = await devRun("@dev get the report ready");
    await tell(dev, "@atlas", "Build the October sales report.");
    const [c] = await consultations();
    const run = await runOf(c?.targetRunId);
    await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, run.id));
    const issueId = (await works())[0]?.issueId ?? "";
    expect((await getIssue(f.db, { type: "person", userId: f.owner.id }, f.org.id, { id: issueId })).status).toBe(
      "in_progress",
    );
    const said = await reports(await runOf(run.id), "Report saved in Drive.\n\nTwo totals need checking.");
    const [w] = await works();
    const [copy] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, w?.resultMessageId ?? ""));
    expect(copy).toMatchObject({ channelId: f.general.id, body: said.body, agentRunId: run.id });
    expect(copy?.meta.handedReport).toEqual({ fromMessageId: said.id });
    const issue = await getIssue(f.db, { type: "person", userId: f.owner.id }, f.org.id, { id: issueId });
    expect(issue.status).toBe("done");
    expect(issue.backgroundWork?.result).toEqual({ text: "Report saved in Drive.", messageId: copy?.id ?? "" });
    // Nothing woke the agent that handed it to relay it.
    expect((await f.db.select().from(schema.agentRuns)).filter((r) => r.agentId === f.agent.id)).toHaveLength(1);
  });

  test("a stop posts its end where the person asked", async () => {
    f = await setup({ askAgent: true });
    await addAgent("Atlas");
    const dev = await devRun("@dev get the report ready");
    await tell(dev, "@atlas", "Build the October sales report.");
    const [c] = await consultations();
    await f.db
      .update(schema.agentRuns)
      .set({ status: "canceled" })
      .where(eq(schema.agentRuns.id, c?.targetRunId ?? ""));
    await endWork({ db: f.db, pubsub: f.pubsub }, await runOf(c?.targetRunId), "canceled");
    const [w] = await works();
    const [end] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, w?.resultMessageId ?? ""));
    expect(end).toMatchObject({ channelId: f.general.id, threadId: null });
    expect(end?.meta.workEnd).toMatchObject({ status: "canceled" });
  });
});

describe("where its plan is", () => {
  test("the first step not done, never past the last", () => {
    const steps = (states: ("todo" | "doing" | "done")[]) =>
      states.map((state, i) => ({ id: `s${i}`, text: `Step ${i}`, state }));
    expect(planStepOf(steps(["done", "done", "doing", "todo", "todo"]))).toEqual({ current: 3, total: 5 });
    expect(planStepOf(steps(["done", "done"]))).toEqual({ current: 2, total: 2 });
    expect(planStepOf([])).toBeNull();
  });
});
