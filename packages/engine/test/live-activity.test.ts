import { afterEach, describe, expect, test } from "bun:test";
import { createFakePushSender, type LiveActivityMessage, PushError } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  createAgent,
  createChannel,
  createJobHandlers,
  drainOutbox,
  LIVE_ACTIVITY_JOB,
  type LiveActivityProps,
  type LiveActivityState,
  liveActivityDoneProps,
  liveActivityFace,
  liveActivityProps,
  liveActivityStateOf,
  notify,
  postPersonMessage,
  refreshLiveActivity,
  registerLiveActivityDevice,
  resolveNotifications,
  runLiveActivityJob,
  unregisterLiveActivityDevice,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import shapes from "./fixtures/live-activity-props.json";

/** The agents at work in a person's iPhone Live Activity (ADR 0210): what it shows, its words, and what is sent. */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const { agentRuns, liveActivityDevices, outbox } = schema;

/** The app's push-to-start token and an activity's own token (hex). */
const START = "a".repeat(160);
const ACTIVITY = "b".repeat(160);
const WIDGETS = "file:///private/var/mobile/Containers/Shared/AppGroup/0A1B2C3D/widgets";

const runs = () => f.db.select().from(agentRuns);
const devices = () => f.db.select().from(liveActivityDevices);

/** A run as its worker holds it: running, beating at `at`. */
async function working(runId: string, at = new Date(), startedAt = at) {
  await f.db.update(agentRuns).set({ status: "running", startedAt, heartbeatAt: at }).where(eq(agentRuns.id, runId));
}

async function agentIn(name: string, channelId = f.general.id) {
  const agent = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name, handle: name.toLowerCase(), role: "Helper", instructions: "Help.", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await addChannelMember(f.db, f.owner.id, f.org.id, channelId, { agentId: agent.id });
  return agent;
}

/** Ana asks @dev in #general; its run is at work. */
async function anaAsksDev() {
  const asked = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev olha os bugs",
  });
  const run = (await runs()).find((r) => r.triggerMessageId === asked.id);
  if (!run) throw new Error("no run");
  await working(run.id);
  return { asked, run };
}

/** An agent asks Ana a question in #general (her inbox's "Esperando você"), at `at`. */
async function asksAna(agentId: string, key: string, text: string, at = new Date()) {
  await notify(
    { db: f.db, pubsub: f.pubsub, now: () => at },
    {
      orgId: f.org.id,
      userIds: [f.owner.id],
      kind: "agent_question",
      groupKey: `agent_question:${key}`,
      waiting: true,
      actor: { type: "agent", id: agentId },
      source: { channelId: f.general.id, label: "general", questionId: key },
      latest: { text },
    },
  );
}

const register = (input: Partial<Parameters<typeof registerLiveActivityDevice>[2]> = {}) =>
  registerLiveActivityDevice(f.db, f.owner.id, {
    installId: "install-1",
    pushToStartToken: START,
    widgetsDir: WIDGETS,
    appId: "chat.agentes.app",
    sandbox: true,
    locale: "pt-BR",
    ...input,
  });

/** The props as ADR 0210 §5 writes them: a request waiting, one agent at work, done. */
const expected = shapes as unknown as Record<"waiting" | "working" | "done", LiveActivityProps>;

const propsOf = (m: LiveActivityMessage | undefined) =>
  JSON.parse(m?.contentState.props ?? "null") as LiveActivityProps;
const seconds = (d: Date) => Math.floor(d.getTime() / 1000);

describe("its words (ADR 0210 §5)", () => {
  const ORG = "0193a000-0000-7000-8000-0000000000a0";
  const id = (n: number) => `0193a000-0000-7000-8000-00000000000${n}`;
  const dev = {
    kind: "working" as const,
    agentId: id(2),
    agentName: "Dev",
    orgId: ORG,
    where: "#geral",
    channelId: "0193a000-0000-7000-8000-0000000000c2",
    threadId: null,
    messageId: "0193a000-0000-7000-8000-0000000000e2",
    since: 1_799_999_990_000,
    step: { kind: "status" as const, status: "coding", subject: null },
  };
  const waiting: LiveActivityState = {
    items: [
      {
        kind: "approval",
        agentId: id(1),
        agentName: "Iris",
        orgId: ORG,
        where: "#lançamentos",
        channelId: "0193a000-0000-7000-8000-0000000000c1",
        threadId: "0193a000-0000-7000-8000-0000000000d1",
        messageId: "0193a000-0000-7000-8000-0000000000e1",
        since: 1_800_000_000_000,
        step: { kind: "ask", text: "Para publicar a versão 2.4 que você pediu", title: "Deploy v2.4 to production" },
      },
      dev,
      {
        ...dev,
        agentId: id(3),
        agentName: "Lia",
        where: "Acme",
        since: 1_799_999_980_000,
        step: { kind: "own", text: "Revisando o PR #12" },
      },
      { ...dev, agentId: id(4), agentName: "Rui", since: 1_799_999_970_000, step: { kind: "working" } },
    ],
  };

  test("the props are the ADR's shape: a request first, three agents, the rest counted, a link to the first", () => {
    expect(liveActivityProps(waiting, { locale: "pt-BR", widgetsDir: WIDGETS })).toEqual(expected.waiting);
    const one = liveActivityProps({ items: [dev] }, { locale: "pt-BR", widgetsDir: `${WIDGETS}/` });
    expect(one).toEqual(expected.working);
    expect(liveActivityDoneProps(one, "pt-BR")).toEqual(expected.done);
    // Its keys, in the ADR's order.
    expect(Object.keys(one ?? {})).toEqual(["v", "tone", "headline", "trailing", "agents", "more", "url"]);
    expect(Object.keys(one?.agents[0] ?? {})).toEqual(["id", "name", "face", "step", "since", "state", "where"]);
  });

  test("several at work: how many, at the island's end too; in English, an approval names its action", () => {
    const two = { items: [dev, { ...dev, agentId: id(3), agentName: "Lia" }] };
    expect(liveActivityProps(two, { locale: "pt-BR", widgetsDir: WIDGETS })).toMatchObject({
      tone: "working",
      headline: "2 trabalhando",
      trailing: "2 trabalhando",
      more: 0,
    });
    const en = liveActivityProps(waiting, { locale: "en", widgetsDir: WIDGETS });
    expect(en).toMatchObject({ headline: "Iris asks for approval", trailing: "Approve?" });
    expect(en?.agents.map((a) => a.step)).toEqual(["Deploy v2.4 to production", "Coding", "Revisando o PR #12"]);
    // A request with no words of its own (a confidential thread's), and nothing at all.
    const sealed = {
      items: [{ ...waiting.items[0], step: { kind: "ask", text: null, title: null } }],
    } as LiveActivityState;
    expect(liveActivityProps(sealed, { locale: "pt-BR", widgetsDir: WIDGETS })?.agents[0]?.step).toBe(
      "Esperando sua aprovação",
    );
    expect(liveActivityProps({ items: [] }, { locale: "pt-BR", widgetsDir: WIDGETS })).toBeNull();
    expect(liveActivityDoneProps(null, "en")).toMatchObject({ tone: "done", headline: "Done", agents: [], more: 0 });
  });

  test("a face is a file URL in the widgets directory, given as a path or a URL", () => {
    expect(liveActivityFace("/var/mobile/widgets/", "x1")).toBe("file:///var/mobile/widgets/faces/x1.png");
    expect(liveActivityFace("file:///var/mobile/widgets", "x1")).toBe("file:///var/mobile/widgets/faces/x1.png");
    expect(liveActivityFace("/var/My Group/widgets", "x1")).toBe("file:///var/My%20Group/widgets/faces/x1.png");
    expect(liveActivityFace("", "x1")).toBeNull();
  });
});

describe("what it shows", () => {
  test("the runs a person is behind, with the agent's line; someone else's never", async () => {
    f = await setup();
    const { asked, run } = await anaAsksDev();
    // Bia asks @dev in another channel: her run, not Ana's.
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const infra = await createChannel(f.db, f.owner.id, f.org.id, { name: "infra" });
    await addChannelMember(f.db, f.owner.id, f.org.id, infra.id, { userId: bia.id });
    await addChannelMember(f.db, f.owner.id, f.org.id, infra.id, { agentId: f.agent.id });
    const hers = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, infra.id, {
      body: "@dev vê o servidor",
    });
    const biaRun = (await runs()).find((r) => r.triggerMessageId === hers.id);
    if (!biaRun) throw new Error("no run");
    await working(biaRun.id);

    const state = await liveActivityStateOf(f.db, f.owner.id);
    expect(state.items).toEqual([
      {
        kind: "working",
        agentId: f.agent.id,
        agentName: "Dev",
        orgId: f.org.id,
        where: "#general",
        channelId: f.general.id,
        threadId: null,
        messageId: asked.id,
        since: expect.any(Number),
        step: { kind: "working" },
      },
    ]);
    expect((await liveActivityStateOf(f.db, bia.id)).items.map((i) => i.channelId)).toEqual([infra.id]);

    // Its line, once it is this run's.
    await f.db
      .update(schema.agents)
      .set({ statusSource: "auto", statusKind: "browsing", statusRunId: run.id })
      .where(eq(schema.agents.id, f.agent.id));
    const props = liveActivityProps(await liveActivityStateOf(f.db, f.owner.id), {
      locale: "pt-BR",
      widgetsDir: WIDGETS,
    });
    expect(props?.agents[0]?.step).toBe("Navegando na web");

    // Waiting for an answer, then over: what it waits on, then nothing.
    await f.db.update(agentRuns).set({ status: "waiting_input" }).where(eq(agentRuns.id, run.id));
    expect((await liveActivityStateOf(f.db, f.owner.id)).items[0]?.step).toEqual({
      kind: "status",
      status: "waiting_answer",
      subject: null,
    });
    await f.db.update(agentRuns).set({ status: "done" }).where(eq(agentRuns.id, run.id));
    expect((await liveActivityStateOf(f.db, f.owner.id)).items).toEqual([]);
  });

  test("a request waiting goes first and stands for its agent's work; a worker gone quiet doesn't count", async () => {
    f = await setup();
    await anaAsksDev();
    const iris = await agentIn("Iris");
    await asksAna(iris.id, "q1", "Qual ambiente?", new Date(Date.now() - 2000));
    await asksAna(f.agent.id, "q2", "Posso apagar o log?", new Date(Date.now() - 1000));
    const state = await liveActivityStateOf(f.db, f.owner.id);
    // Dev asks too: its question stands for it, newest first.
    expect(state.items.map((i) => [i.agentName, i.kind, i.step])).toEqual([
      ["Dev", "question", { kind: "ask", text: "Posso apagar o log?", title: null }],
      ["Iris", "question", { kind: "ask", text: "Qual ambiente?", title: null }],
    ]);
    // Answered (resolved): it works again.
    await resolveNotifications({ db: f.db }, f.org.id, { groupKey: "agent_question:q2" });
    expect((await liveActivityStateOf(f.db, f.owner.id)).items.map((i) => [i.agentName, i.kind])).toEqual([
      ["Iris", "question"],
      ["Dev", "working"],
    ]);
    // Its worker stopped beating two minutes ago: not at work.
    const [run] = await runs();
    await working(run?.id ?? "", new Date(Date.now() - 120_000));
    expect((await liveActivityStateOf(f.db, f.owner.id)).items.map((i) => i.agentName)).toEqual(["Iris"]);
  });

  test("three agents shown, the others counted", async () => {
    f = await setup();
    for (const name of ["Ada", "Bob", "Cid"]) await agentIn(name);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev @ada @bob @cid olhem os bugs",
    });
    const all = await runs();
    expect(all).toHaveLength(4);
    const base = Date.now() - 60_000;
    for (const [i, r] of all.entries()) await working(r.id, new Date(), new Date(base + i * 1000));
    const props = liveActivityProps(await liveActivityStateOf(f.db, f.owner.id), {
      locale: "pt-BR",
      widgetsDir: WIDGETS,
    });
    expect(props).toMatchObject({ tone: "working", headline: "4 trabalhando", more: 1 });
    expect(props?.agents).toHaveLength(3);
    // The latest first.
    expect(props?.agents.map((a) => a.since)).toEqual([...(props?.agents.map((a) => a.since) ?? [])].sort().reverse());
  });
});

describe("sending (job live-activity.refresh)", () => {
  test("starts once with the system's alert, updates the activity it gets back, says done and ends it", async () => {
    f = await setup();
    const push = createFakePushSender();
    let now = new Date();
    const deps = { db: f.db, push, now: () => now };
    const later = async (ms: number) => {
      now = new Date(now.getTime() + ms);
      for (const r of await runs()) if (r.status === "running") await working(r.id, now, r.startedAt ?? now);
    };
    expect(await register()).toBe(true);
    // Nothing at work: nothing sent.
    expect(await refreshLiveActivity(deps, f.owner.id)).toEqual({ sent: 0 });
    const { run } = await anaAsksDev();

    // No activity yet: a push-to-start, two refreshes at once sending it once.
    await Promise.all([refreshLiveActivity(deps, f.owner.id), refreshLiveActivity(deps, f.owner.id)]);
    expect(push.liveActivities).toHaveLength(1);
    const start = push.liveActivities[0];
    expect(start).toMatchObject({
      to: START,
      event: "start",
      contentState: { name: "AgentsActivity" },
      timestamp: seconds(now),
      staleDate: seconds(now) + 600,
      alert: { title: "Dev", body: "Trabalhando · #general" },
      attributesType: "LiveActivityAttributes",
      inputPushToken: true,
      priority: 10,
      apns: { topic: "chat.agentes.app", sandbox: true },
    });
    expect(typeof start?.contentState.props).toBe("string");
    const started = propsOf(start);
    expect(started).toMatchObject({ v: 1, tone: "working", headline: "Dev", trailing: null, more: 0 });
    expect(start?.attributes).toEqual({ url: started.url });
    expect(started.url).toBe(
      `agenteschat://island?org=${f.org.id}&channel=${f.general.id}&message=${run.triggerMessageId}`,
    );
    expect(started.agents[0]?.face).toBe(`${WIDGETS}/faces/${f.agent.id}.png`);
    expect((await devices())[0]?.startedAt?.getTime()).toBe(now.getTime());

    // Its token hasn't come back: no second start within ten minutes.
    await later(60_000);
    await refreshLiveActivity(deps, f.owner.id);
    expect(push.liveActivities).toHaveLength(1);

    // The app hands the activity's token over: it gets the content at once, then only what changes.
    await register({ activity: { id: "act-1", token: ACTIVITY } });
    expect((await devices())[0]?.startedAt).toBeNull();
    await refreshLiveActivity(deps, f.owner.id);
    expect(push.liveActivities.at(-1)).toMatchObject({
      to: ACTIVITY,
      event: "update",
      priority: 5,
      staleDate: seconds(now) + 1800,
    });
    expect(push.liveActivities.at(-1)?.alert).toBeUndefined();
    await later(1000);
    await refreshLiveActivity(deps, f.owner.id);
    expect(push.liveActivities).toHaveLength(2);

    // A new line within five seconds waits for the next refresh, which is queued.
    await f.db
      .update(schema.agents)
      .set({ statusSource: "auto", statusKind: "coding", statusRunId: run.id })
      .where(eq(schema.agents.id, f.agent.id));
    await f.db.delete(outbox);
    await later(1000);
    await refreshLiveActivity(deps, f.owner.id);
    expect(push.liveActivities).toHaveLength(2);
    const queued = await f.db.select().from(outbox).where(eq(outbox.kind, LIVE_ACTIVITY_JOB));
    expect(queued.map((j) => j.payload)).toEqual([{ userId: f.owner.id }]);
    await later(4000);
    await refreshLiveActivity(deps, f.owner.id);
    expect(propsOf(push.liveActivities.at(-1)).agents[0]?.step).toBe("Programando");

    // A question for Ana changes the tone: sent at once, now.
    const iris = await agentIn("Iris");
    await asksAna(iris.id, "q1", "Qual ambiente?");
    await later(500);
    await refreshLiveActivity(deps, f.owner.id);
    expect(push.liveActivities).toHaveLength(4);
    expect(push.liveActivities.at(-1)?.priority).toBe(10);
    expect(propsOf(push.liveActivities.at(-1))).toMatchObject({
      tone: "waiting",
      headline: "Iris tem uma pergunta",
      trailing: "Responder?",
    });

    // Answered and the run over: "done", then the end, and the activity is forgotten.
    await resolveNotifications({ db: f.db }, f.org.id, { groupKey: "agent_question:q1" });
    await f.db.update(agentRuns).set({ status: "done" }).where(eq(agentRuns.id, run.id));
    await later(10_000);
    await refreshLiveActivity(deps, f.owner.id);
    const [done, end] = push.liveActivities.slice(-2);
    expect(done).toMatchObject({ to: ACTIVITY, event: "update", priority: 10 });
    expect(end).toMatchObject({ to: ACTIVITY, event: "end", priority: 10, dismissalDate: seconds(now) + 240 });
    expect(propsOf(end)).toMatchObject({ tone: "done", headline: "Pronto", more: 0 });
    expect(propsOf(end).agents.map((a) => [a.name, a.state, a.step])).toEqual([
      ["Iris", "done", "Pronto"],
      ["Dev", "done", "Pronto"],
    ]);
    expect(propsOf(done)).toEqual(propsOf(end));
    expect(await devices()).toMatchObject([{ activityId: null, activityToken: null, lastSent: null }]);
    await refreshLiveActivity(deps, f.owner.id);
    expect(push.liveActivities).toHaveLength(6);
  });

  test("with no activity token past ten minutes, it starts again", async () => {
    f = await setup();
    const push = createFakePushSender();
    let now = new Date();
    const deps = { db: f.db, push, now: () => now };
    await register();
    const { run } = await anaAsksDev();
    await refreshLiveActivity(deps, f.owner.id);
    now = new Date(now.getTime() + 11 * 60_000);
    await working(run.id, now);
    await refreshLiveActivity(deps, f.owner.id);
    expect(push.liveActivities.map((m) => m.event)).toEqual(["start", "start"]);
  });

  test("a token Apple says is gone is dropped; a failure that may pass is retried with nothing marked sent", async () => {
    f = await setup();
    const push = createFakePushSender();
    const deps = { db: f.db, push };
    await register({ activity: { id: "act-1", token: ACTIVITY } });
    await anaAsksDev();

    push.failing.add(ACTIVITY);
    const error = await refreshLiveActivity(deps, f.owner.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PushError);
    expect((error as PushError).retryable).toBe(true);
    expect(await devices()).toMatchObject([{ activityToken: ACTIVITY, lastSent: null, lastSentAt: null }]);
    push.failing.clear();
    await refreshLiveActivity(deps, f.owner.id);
    expect(push.liveActivities.map((m) => m.to)).toEqual([ACTIVITY]);

    // The activity ended on the phone (410): forgotten, so the next change starts one again.
    push.unregistered.add(ACTIVITY);
    await f.db.update(liveActivityDevices).set({ lastSent: null });
    await refreshLiveActivity(deps, f.owner.id);
    expect(await devices()).toMatchObject([{ activityId: null, activityToken: null, pushToStartToken: START }]);
    // The app can't be started with its token any more: that one goes too.
    push.unregistered.add(START);
    await refreshLiveActivity(deps, f.owner.id);
    expect(await devices()).toMatchObject([{ activityToken: null, pushToStartToken: null }]);
  });

  test("a server that sends no iPhone push sends none and marks nothing", async () => {
    f = await setup();
    await register();
    await anaAsksDev();
    expect(await refreshLiveActivity({ db: f.db, push: null }, f.owner.id)).toBeNull();
    expect(await devices()).toMatchObject([{ startedAt: null, lastSent: null }]);
  });
});

describe("when it is computed again", () => {
  test("a run's start and end and a request for the person queue the job; nothing where no phone shows one", async () => {
    f = await setup();
    const push = createFakePushSender();
    const handlers = createJobHandlers({ ...f.jobDeps, push });
    const jobs = async () =>
      (await f.db.select().from(outbox).where(eq(outbox.kind, LIVE_ACTIVITY_JOB))).map((j) => j.payload);

    // No phone shows one: a run queues nothing.
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
    await drainOutbox(f.db, handlers);
    expect(await jobs()).toEqual([]);

    await register();
    await f.db.delete(outbox).where(eq(outbox.kind, LIVE_ACTIVITY_JOB));
    const asked = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev de novo",
    });
    await drainOutbox(f.db, handlers);
    const run = (await runs()).find((r) => r.triggerMessageId === asked.id);
    expect(run?.status).toBe("done");
    const queued = await jobs();
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.every((p) => p.runId === run?.id || p.userId === f.owner.id)).toBe(true);
    expect(queued.some((p) => p.runId === run?.id)).toBe(true);

    // A question for her queues one by her id.
    await f.db.delete(outbox).where(eq(outbox.kind, LIVE_ACTIVITY_JOB));
    await asksAna(f.agent.id, "q1", "Qual ambiente?");
    expect(await jobs()).toEqual([{ userId: f.owner.id }]);

    // The run's job finds the person behind it; someone else's run reaches nobody's phone.
    await f.db
      .update(agentRuns)
      .set({ status: "running", heartbeatAt: new Date() })
      .where(eq(agentRuns.id, run?.id ?? ""));
    expect(await runLiveActivityJob({ db: f.db, push }, { orgId: f.org.id, payload: { runId: run?.id } })).toEqual({
      sent: 1,
    });
    expect(push.liveActivities.map((m) => m.event)).toEqual(["start"]);
    expect(
      await runLiveActivityJob({ db: f.db, push }, { orgId: f.org.id, payload: { runId: crypto.randomUUID() } }),
    ).toBeNull();
  });

  test("registering keeps the newest ten per person; unregistering takes only one's own", async () => {
    f = await setup();
    const base = Date.now();
    for (let i = 0; i < 12; i++) {
      const input = { installId: `install-${i}`, widgetsDir: WIDGETS, locale: "en" };
      await registerLiveActivityDevice(f.db, f.owner.id, input, new Date(base + i * 1000));
    }
    expect(await devices()).toHaveLength(10);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    expect(await unregisterLiveActivityDevice(f.db, bia.id, "install-11")).toBe(false);
    expect(await unregisterLiveActivityDevice(f.db, f.owner.id, "install-11")).toBe(true);
    expect(
      await f.db
        .select()
        .from(liveActivityDevices)
        .where(and(eq(liveActivityDevices.userId, f.owner.id), eq(liveActivityDevices.installId, "install-11"))),
    ).toEqual([]);
  });
});
