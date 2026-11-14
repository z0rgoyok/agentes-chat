import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, inArray, schema, sql } from "@agenteschat/db";
import { en, STRINGS } from "@agenteschat/i18n";
import {
  actOnTeamWeek,
  createSetupToolSource,
  createToolGateway,
  decideProposal,
  enqueueTeamWeeks,
  getLodiPrefs,
  IDLE_REASON,
  insertMessage,
  LIGHT_WORK_REASON,
  LODI_PREFS_DEFAULTS,
  lastTeamWeekSlot,
  lodiPrefsOf,
  notify,
  notifyMessage,
  openPersonAgentDm,
  postPersonMessage,
  postTeamWeek,
  RIGHT_HAND,
  readLodiPrefs,
  requestKey,
  SET_TEAM_WEEK_TOOL,
  setLodiPrefs,
  stuckCause,
  TEAM_DAY_JOB,
  TEAM_WEEK_JOB,
  type TeamWeekCard,
  teamWeekCardOf,
  weekKey,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ZONE = "America/Sao_Paulo";
/** Friday 2026-11-06, 17:00 in São Paulo (UTC-3). */
const SLOT = new Date("2026-11-06T20:00:00Z");

const lodiOf = async (fx: Fixture) => {
  const [lodi] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

async function inZone(fx: Fixture) {
  await fx.db
    .insert(schema.organizationSettings)
    .values({ orgId: fx.org.id, timezone: ZONE })
    .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: { timezone: ZONE } });
}

const jobs = (fx: Fixture) =>
  fx.db
    .select()
    .from(schema.outbox)
    .where(inArray(schema.outbox.kind, [TEAM_WEEK_JOB, TEAM_DAY_JOB]));

const run = (fx: Fixture, agentId: string, at: Date, status: "done" | "failed", error?: string) =>
  fx.db.insert(schema.agentRuns).values({
    orgId: fx.org.id,
    agentId,
    channelId: fx.general.id,
    threadRootId: crypto.randomUUID(),
    triggerMessageId: crypto.randomUUID(),
    trigger: "mention",
    hop: 1,
    status,
    error: error ?? null,
    createdAt: at,
  });

/** A run that parked at its budget and has since resumed: only its "budget ran out" note is left. */
const budgetStop = (fx: Fixture, at: Date) =>
  insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: fx.general.id,
    author: { type: "agent", agentId: fx.agent.id, runId: null, hop: 1, stretchId: null },
    body: "My budget for the month ran out.",
    meta: { bodyCode: "budget_wait", usageWait: { code: "budget", runId: crypto.randomUUID() } },
    createdAt: at,
  });

describe("when it comes", () => {
  test("Friday at 17h in the workspace's zone by default; one card per person and week", () => {
    const prefs = lodiPrefsOf({});
    expect(prefs).toMatchObject({ weekOff: false, day: 5, weekHour: 17 });
    expect(lodiPrefsOf({ day: 9, hour: -1, off: "yes" })).toEqual(prefs);
    expect(lastTeamWeekSlot("week", prefs, ZONE, new Date(SLOT.getTime() + HOUR))?.toISOString()).toBe(
      SLOT.toISOString(),
    );
    // Before the slot: last week's.
    expect(lastTeamWeekSlot("week", prefs, ZONE, new Date(SLOT.getTime() - HOUR))?.toISOString()).toBe(
      new Date(SLOT.getTime() - 7 * DAY).toISOString(),
    );
    // Moved to Monday 9h, the same week: the same key, so no second card.
    const monday = lastTeamWeekSlot("week", { ...prefs, day: 1, weekHour: 9 }, ZONE, SLOT);
    expect(monday && weekKey(monday, ZONE)).toBe(weekKey(SLOT, ZONE));
    expect(weekKey(SLOT, ZONE)).toBe("2026-11-02");
  });

  test("requests read the same without accents, mentions or punctuation", () => {
    expect(requestKey("@dev Manda o resumo do dia!")).toBe(requestKey("manda o RESUMO do dia"));
    expect(requestKey("ok")).toBeNull();
  });

  test("queued for admins of a workspace with a team, once, and never when off or before there is a team", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const member = await addMember(f.db, f.org.id, "member", "bia");
    const at = new Date(SLOT.getTime() + HOUR);
    expect(await enqueueTeamWeeks(f.db, at)).toBe(1);
    await enqueueTeamWeeks(f.db, new Date(at.getTime() + HOUR));
    const queued = await jobs(f);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toEqual({ userId: f.owner.id, slot: SLOT.toISOString(), period: "week" });
    expect(queued.some((j) => (j.payload as { userId: string }).userId === member.id)).toBe(false);
    // A slot missed by more than a few hours waits for next week.
    expect(await enqueueTeamWeeks(f.db, new Date(SLOT.getTime() + DAY))).toBe(0);

    await setLodiPrefs(f.db, f.org.id, f.owner.id, { off: true });
    expect(await enqueueTeamWeeks(f.db, new Date(at.getTime() + 7 * DAY))).toBe(0);
    await setLodiPrefs(f.db, f.org.id, f.owner.id, { off: false });
    // No agent but Lodi: no team, no card.
    await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, f.agent.id));
    expect(await enqueueTeamWeeks(f.db, new Date(at.getTime() + 7 * DAY))).toBe(0);
  });
});

describe("the card", () => {
  async function busyWeek(fx: Fixture) {
    await inZone(fx);
    const lodi = await lodiOf(fx);
    const day = (n: number) => new Date(SLOT.getTime() - n * DAY);
    for (let i = 0; i < 4; i++) await run(fx, fx.agent.id, day(1), "done");
    await run(fx, fx.agent.id, day(2), "failed", "provider_error");
    await budgetStop(fx, day(2));
    // An agent made last week and put in no channel.
    const [lia] = await fx.db
      .insert(schema.agents)
      .values({
        orgId: fx.org.id,
        name: "Lia",
        handle: "lia",
        role: "Research",
        instructions: "",
        model: "claude-sonnet-5-5",
        ownerUserId: fx.owner.id,
        createdAt: day(5),
      })
      .returning();
    // Three questions nobody answered in #general, from two people.
    const asker = await addMember(fx.db, fx.org.id, "member", "nina");
    for (const n of [2, 3, 4])
      await insertMessage(fx.db, {
        orgId: fx.org.id,
        channelId: fx.general.id,
        author: { type: "person", userId: n === 4 ? asker.id : fx.owner.id },
        body: `Alguém sabe emitir nota fiscal ${n}?`,
        createdAt: day(n),
      });
    // The same request typed to Dev in their DM on three days, around 18h.
    const dm = await openPersonAgentDm(fx.db, fx.org.id, fx.owner.id, fx.agent.id);
    for (const n of [1, 2, 3])
      await insertMessage(fx.db, {
        orgId: fx.org.id,
        channelId: dm.id,
        author: { type: "person", userId: fx.owner.id },
        body: n === 1 ? "Manda o resumo do dia, por favor" : "manda o resumo do dia por favor!",
        createdAt: new Date(day(n).getTime() + HOUR),
      });
    // A plan whose steps 2 and 3 wait while step 1 is in review.
    const [parent] = await fx.db
      .insert(schema.issues)
      .values({
        orgId: fx.org.id,
        number: 10,
        title: "Skills do time",
        assigneeType: "agent",
        assigneeId: fx.agent.id,
        createdByType: "person",
        createdById: fx.owner.id,
      })
      .returning();
    const step = (number: number, status: "todo" | "in_review") => ({
      orgId: fx.org.id,
      number,
      title: `Bloco ${number - 10}`,
      status,
      parentIssueId: parent?.id,
      createdByType: "person",
      createdById: fx.owner.id,
      updatedAt: new Date(SLOT.getTime() - 5 * HOUR),
    });
    await fx.db.insert(schema.issues).values([step(11, "in_review"), step(12, "todo"), step(13, "todo")]);
    return { lodi, lia, dm, parent };
  }

  const cardOf = async (fx: Fixture, messageId: string) => {
    const [m] = await fx.db.select().from(schema.messages).where(eq(schema.messages.id, messageId));
    const card = teamWeekCardOf(m?.meta);
    if (!m || !card) throw new Error("no card");
    return { m, card };
  };

  test("posted in the admin's DM with Lodi from stored data, each fix a row, once a week", async () => {
    f = await setup({ rightHand: true });
    const { lodi, lia, parent } = await busyWeek(f);
    const id = await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, {
      userId: f.owner.id,
      slot: SLOT.toISOString(),
    });
    expect(id).not.toBeNull();
    const { m, card } = await cardOf(f, id as string);
    expect(m.authorAgentId).toBe(lodi.id);
    // Written in the person's language: the push and the conversation list read it.
    expect(m.body).toBe("Sua semana da equipe está pronta");
    expect(m.meta.bodyCode).toBe("team_week");
    expect(card.from).toBe("2026-10-30");
    expect(card.to).toBe("2026-11-06");
    expect(card.stats.done).toBe(4);
    expect(card.stats.stuck).toBe(1);
    expect(card.worked).toEqual([{ kind: "runs", agentId: f.agent.id, channelId: f.general.id, count: 4 }]);
    const kinds = card.rows.map((r) => r.kind);
    expect(kinds).toEqual(["budget", "channel", "unanswered", "routine", "stalled"]);
    const budget = card.rows.find((r) => r.kind === "budget");
    expect(budget).toMatchObject({ agentId: f.agent.id, from: 50_000_000_000, to: 75_000_000_000, stops: 1 });
    expect(card.rows.find((r) => r.kind === "channel")).toMatchObject({ agentId: lia?.id, channelId: f.general.id });
    expect(card.rows.find((r) => r.kind === "unanswered")).toMatchObject({ channelId: f.general.id, count: 3 });
    expect(card.rows.find((r) => r.kind === "routine")).toMatchObject({
      agentId: f.agent.id,
      dm: true,
      hour: 18,
      count: 3,
    });
    expect(card.rows.find((r) => r.kind === "stalled")).toMatchObject({
      issueId: parent?.id,
      steps: [12, 13],
      onNumber: 11,
      hours: 5,
      agentId: f.agent.id,
    });
    expect(card.proposalIds).toHaveLength(2);
    // The job runs twice after a lease expiry: one card.
    expect(
      await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, { userId: f.owner.id, slot: SLOT.toISOString() }),
    ).toBeNull();
    // Notified as a message it sent them: nobody asked, so it is no reply.
    const [notice] = await f.db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.kind, "notifications.message"), sql`${schema.outbox.payload}->>'messageId' = ${id}`));
    expect(notice).toBeDefined();
    await notifyMessage({ db: f.db, pubsub: f.pubsub }, f.org.id, id as string);
    const inbox = await f.db.select().from(schema.notifications).where(eq(schema.notifications.userId, f.owner.id));
    expect(inbox.map((n) => [n.kind, n.latest.text])).toContainEqual(["dm", "Sua semana da equipe está pronta"]);
  });

  test("a personal workspace's card says the week is the person's own (ADR 0159)", async () => {
    f = await setup({ rightHand: true });
    await busyWeek(f);
    await f.db
      .update(schema.organizationSettings)
      .set({ mode: "personal" })
      .where(eq(schema.organizationSettings.orgId, f.org.id));
    const id = await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, {
      userId: f.owner.id,
      slot: SLOT.toISOString(),
    });
    const { m } = await cardOf(f, id as string);
    expect(m.body).toBe("Sua semana está pronta");
  });

  test("a quiet week says nothing, and a member never gets the week's", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    expect(
      await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, { userId: f.owner.id, slot: SLOT.toISOString() }),
    ).toBeNull();
    const member = await addMember(f.db, f.org.id, "member", "bia");
    await run(f, f.agent.id, new Date(SLOT.getTime() - DAY), "done");
    expect(
      await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, {
        userId: member.id,
        slot: SLOT.toISOString(),
        period: "week",
      }),
    ).toBeNull();
  });

  test("a busy week whose workspace began being deleted since it was queued posts nothing", async () => {
    f = await setup({ rightHand: true });
    await busyWeek(f);
    await f.db
      .update(schema.organizations)
      .set({ deletionDueAt: new Date(Date.now() + 7 * DAY) })
      .where(eq(schema.organizations.id, f.org.id));
    expect(
      await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, { userId: f.owner.id, slot: SLOT.toISOString() }),
    ).toBeNull();
  });

  test("rows apply as whoever clicks: the budget with Undo on the card, a routine, Lodi asked, the task's agent told", async () => {
    f = await setup({ rightHand: true });
    const { lodi, dm, parent } = await busyWeek(f);
    const id = (await postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, {
      userId: f.owner.id,
      slot: SLOT.toISOString(),
    })) as string;
    const { card } = await cardOf(f, id);
    const row = (kind: TeamWeekCard["rows"][number]["kind"]) => {
      const r = card.rows.find((x) => x.kind === kind);
      if (!r) throw new Error(`no ${kind}`);
      return r;
    };

    // The budget, through the settings card's own path: applied, with its receipt (Undo) on this message.
    const budget = row("budget") as Extract<TeamWeekCard["rows"][number], { kind: "budget" }>;
    await decideProposal(f.db, f.owner.id, f.org.id, budget.proposalId, "accept", { pubsub: f.pubsub });
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(agent?.monthlyBudgetNanoUsd).toBe(75_000_000_000);
    const [receipt] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.messageId, id));
    expect(receipt?.kind).toBe("agent.settings_changed");
    expect(receipt?.runId).toBeNull();

    // A daily routine at the hour it was asked, posting in the DM it was asked in.
    const deps = { db: f.db, pubsub: f.pubsub };
    const done = await actOnTeamWeek(deps, f.owner.id, f.org.id, id, { rowId: row("routine").id });
    const routineId = done.done[row("routine").id]?.routineId;
    const [routine] = await f.db
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.id, routineId ?? ""));
    expect(routine).toMatchObject({ agentId: f.agent.id, target: { type: "dm" }, report: "always" });
    expect(routine?.rule).toMatchObject({ freq: "daily", times: ["18:00"], timezone: ZONE });
    await expect(actOnTeamWeek(deps, f.owner.id, f.org.id, id, { rowId: row("routine").id })).rejects.toThrow();

    // Lodi asked for an agent, as the person, in their DM with it.
    await actOnTeamWeek(deps, f.owner.id, f.org.id, id, {
      rowId: row("unanswered").id,
      text: "Proponha um agente para as perguntas de #general.",
    });
    const lodiDm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id);
    const asked = await f.db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.channelId, lodiDm.id), eq(schema.messages.authorUserId, f.owner.id)));
    expect(asked.map((m) => m.body)).toEqual(["Proponha um agente para as perguntas de #general."]);

    // The stalled task's agent told to go on, in the task's conversation.
    await actOnTeamWeek(deps, f.owner.id, f.org.id, id, {
      rowId: row("stalled").id,
      text: "@dev os passos #12 e #13 não precisam esperar o #11.",
    });
    const [task] = await f.db
      .select()
      .from(schema.issues)
      .where(eq(schema.issues.id, parent?.id ?? ""));
    const said = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.channelId, task?.conversationChannelId ?? ""));
    expect(said.some((m) => m.body.startsWith("@dev os passos"))).toBe(true);

    // Rows with their own card aren't applied here; nobody else acts on the card; "Agora não" puts it away.
    await expect(actOnTeamWeek(deps, f.owner.id, f.org.id, id, { rowId: row("channel").id })).rejects.toThrow();
    const other = await addMember(f.db, f.org.id, "admin", "caio");
    await expect(actOnTeamWeek(deps, other.id, f.org.id, id, { dismiss: true })).rejects.toThrow();
    expect((await actOnTeamWeek(deps, f.owner.id, f.org.id, id, { dismiss: true })).dismissedAt).not.toBeNull();
    expect(dm.id).not.toBe(lodiDm.id);
  });

  test("next week's fix replaces last week's open one: its Undo lands on the card it was applied from", async () => {
    f = await setup({ rightHand: true });
    await busyWeek(f);
    const post = (slot: Date) =>
      postTeamWeek({ db: f.db, pubsub: f.pubsub }, f.org.id, { userId: f.owner.id, slot: slot.toISOString() });
    const first = (await post(SLOT)) as string;
    const next = new Date(SLOT.getTime() + 7 * DAY);
    await budgetStop(f, new Date(next.getTime() - DAY));
    const second = (await post(next)) as string;
    const budgetOf = async (id: string) => {
      const r = (await cardOf(f, id)).card.rows.find((x) => x.kind === "budget");
      if (r?.kind !== "budget") throw new Error("no budget row");
      return r;
    };
    const [old, fresh] = [await budgetOf(first), await budgetOf(second)];
    expect(fresh.proposalId).not.toBe(old.proposalId);
    const [was] = await f.db
      .select()
      .from(schema.contextProposals)
      .where(eq(schema.contextProposals.id, old.proposalId));
    expect(was?.status).toBe("stale");
    await decideProposal(f.db, f.owner.id, f.org.id, fresh.proposalId, "accept", { pubsub: f.pubsub });
    const [receipt] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.messageId, second));
    expect(receipt?.kind).toBe("agent.settings_changed");
  });

  test("telling Lodi to stop it: set_team_week, for the person behind the run", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf(f);
    const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id);
    const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
      body: "para de mandar o resumo da semana",
    });
    const [r] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
    const gateway = createToolGateway({ sources: [createSetupToolSource({ pubsub: f.pubsub })] });
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: lodi.id,
      runId: r?.id ?? "",
      channelId: dm.id,
      threadRootId: r?.threadRootId ?? trigger.id,
      triggerMessageId: trigger.id,
    };
    const res = await gateway.invoke(ctx, { toolUseId: "tu_1", name: SET_TEAM_WEEK_TOOL, input: { off: true } });
    expect(res.type).toBe("result");
    expect((await getLodiPrefs(f.db, f.org.id, f.owner.id)).off).toBe(true);
    await gateway.invoke(ctx, {
      toolUseId: "tu_2",
      name: SET_TEAM_WEEK_TOOL,
      input: { card: "week", off: false, day: "monday", hour: 9 },
    });
    expect(await getLodiPrefs(f.db, f.org.id, f.owner.id)).toMatchObject({
      off: false,
      weekOff: false,
      dayOff: true,
      day: 1,
      weekHour: 9,
    });
  });
});

describe("suggestions on the week's card", () => {
  const WEEK = 7 * DAY;
  const cardOf = async (fx: Fixture, messageId: string) => {
    const [m] = await fx.db.select().from(schema.messages).where(eq(schema.messages.id, messageId));
    const card = teamWeekCardOf(m?.meta);
    if (!m || !card) throw new Error("no card");
    return card;
  };
  const post = (fx: Fixture, userId: string, slot: Date) =>
    postTeamWeek({ db: fx.db, pubsub: fx.pubsub }, fx.org.id, { userId, slot: slot.toISOString(), period: "week" });
  /** An agent made well before the card's four weeks. */
  const agent = async (fx: Fixture, name: string, model = "claude-sonnet-5-5", days = 60) => {
    const [a] = await fx.db
      .insert(schema.agents)
      .values({
        orgId: fx.org.id,
        name,
        handle: name.toLowerCase(),
        role: "Research",
        instructions: "",
        model,
        ownerUserId: fx.owner.id,
        createdAt: new Date(SLOT.getTime() - days * DAY),
      })
      .returning();
    if (!a) throw new Error("no agent");
    // In a channel, so the card has no other row for it.
    await fx.db.insert(schema.channelMembers).values({ orgId: fx.org.id, channelId: fx.general.id, agentId: a.id });
    return a;
  };
  /** Work in the week before `slot`, so its card goes out: a suggestion rides a card, it never posts one. */
  const busy = (fx: Fixture, slot: Date) => run(fx, fx.agent.id, new Date(slot.getTime() - HOUR), "done");
  /** `n` done runs of an agent in the card's last days, each with its model calls and output tokens. */
  const worked = async (fx: Fixture, agentId: string, n: number, turns: number, tokens: number, slot = SLOT) => {
    for (let i = 0; i < n; i++) {
      const [r] = await fx.db
        .insert(schema.agentRuns)
        .values({
          orgId: fx.org.id,
          agentId,
          channelId: fx.general.id,
          threadRootId: crypto.randomUUID(),
          triggerMessageId: crypto.randomUUID(),
          trigger: "mention",
          hop: 1,
          status: "done",
          turns,
          createdAt: new Date(slot.getTime() - (i + 1) * HOUR),
        })
        .returning();
      await fx.db.insert(schema.usageRecords).values({
        orgId: fx.org.id,
        agentId,
        runId: r?.id,
        provider: "anthropic",
        model: "claude-opus-5-5",
        requestedModel: "claude-opus-5-5",
        inputTokens: 1000,
        outputTokens: tokens,
        costNanoUsd: 1,
        createdAt: new Date(slot.getTime() - (i + 1) * HOUR),
      });
    }
  };
  const proposal = async (fx: Fixture, id: string) =>
    (await fx.db.select().from(schema.contextProposals).where(eq(schema.contextProposals.id, id)))[0];

  test("an idle agent is offered for archiving, one with a routine or an open task is not", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const ivo = await agent(f, "Ivo");
    const rita = await agent(f, "Rita");
    const tito = await agent(f, "Tito");
    await f.db.insert(schema.routines).values({
      orgId: f.org.id,
      agentId: rita.id,
      name: "Daily",
      prompt: "Check the inbox",
      target: { type: "dm" },
      triggerType: "schedule",
    });
    await f.db.insert(schema.issues).values({
      orgId: f.org.id,
      number: 20,
      title: "Write the report",
      assigneeType: "agent",
      assigneeId: tito.id,
      createdByType: "person",
      createdById: f.owner.id,
    });
    // Dev was made days ago: too new to be called idle.
    await busy(f, SLOT);
    const id = (await post(f, f.owner.id, SLOT)) as string;
    const card = await cardOf(f, id);
    expect(card.rows).toEqual([]);
    expect(card.moreRows).toEqual([
      { id: `retire:${ivo.id}`, kind: "retire", agentId: ivo.id, proposalId: expect.any(String) },
    ]);
    const row = card.moreRows?.[0] as { proposalId: string };
    expect(card.proposalIds).toEqual([row.proposalId]);
    expect(await proposal(f, row.proposalId)).toMatchObject({
      agentId: ivo.id,
      rationale: IDLE_REASON,
      requestedByUserId: f.owner.id,
      settings: [{ field: "archive", from: false, to: true }],
    });
    // One tap, as the administrator who taps, with its receipt (Undo) on the card. No model was called for any of it.
    await decideProposal(f.db, f.owner.id, f.org.id, row.proposalId, "accept", { pubsub: f.pubsub });
    const [gone] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, ivo.id));
    expect(gone?.archivedAt).not.toBeNull();
    const [receipt] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.messageId, id));
    expect(receipt?.kind).toBe("agent.settings_changed");
    expect(f.provider.calls).toHaveLength(0);
    // A member's card, and anyone's daily one, never offer it.
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    expect(await post(f, bia.id, SLOT)).toBeNull();
  });

  test("an offer to archive is not applied once the agent went back to work", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const ivo = await agent(f, "Ivo");
    await busy(f, SLOT);
    const id = (await post(f, f.owner.id, SLOT)) as string;
    const row = (await cardOf(f, id)).moreRows?.[0] as { proposalId: string };
    expect(await proposal(f, row.proposalId)).toMatchObject({ agentId: ivo.id, rationale: IDLE_REASON });
    // Days after the card, someone puts it to work. The card still reads "has not worked in four weeks".
    await run(f, ivo.id, new Date(), "done");
    await expect(
      decideProposal(f.db, f.owner.id, f.org.id, row.proposalId, "accept", { pubsub: f.pubsub }),
    ).rejects.toThrow("changed since");
    expect((await proposal(f, row.proposalId))?.status).toBe("stale");
    const [still] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, ivo.id));
    expect(still?.archivedAt).toBeNull();
    expect(await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.messageId, id))).toEqual([]);
  });

  test("an agent on a large model with light work is offered the next one down, never the smallest", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const light = await agent(f, "Opa", "claude-opus-5-5");
    const heavy = await agent(f, "Hugo", "claude-opus-5-5");
    const few = await agent(f, "Fia", "claude-opus-5-5");
    const medium = await agent(f, "Mia");
    await worked(f, light.id, 19, 1, 300);
    // Two of 21 are long: still nine in ten light.
    await worked(f, light.id, 2, 6, 5000);
    await worked(f, heavy.id, 20, 5, 4000);
    await worked(f, few.id, 5, 1, 100);
    await worked(f, medium.id, 20, 1, 100);
    const card = await cardOf(f, (await post(f, f.owner.id, SLOT)) as string);
    const rows = card.moreRows ?? [];
    expect(rows).toEqual([
      {
        id: `model:${light.id}`,
        kind: "model",
        agentId: light.id,
        proposalId: expect.any(String),
        from: "claude-opus-5-5",
        to: "claude-sonnet-5-5",
      },
    ]);
    const row = rows[0] as { proposalId: string };
    expect(await proposal(f, row.proposalId)).toMatchObject({
      rationale: LIGHT_WORK_REASON,
      settings: [{ field: "model", from: "claude-opus-5-5", to: "claude-sonnet-5-5" }],
    });
    await decideProposal(f.db, f.owner.id, f.org.id, row.proposalId, "accept", { pubsub: f.pubsub });
    const [now] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, light.id));
    expect(now?.model).toBe("claude-sonnet-5-5");
    // On the middle model it is offered nothing smaller, however light its work.
    const later = new Date(SLOT.getTime() + 5 * WEEK);
    await worked(f, light.id, 25, 1, 100, later);
    const next = (await post(f, f.owner.id, later)) as string;
    expect((await cardOf(f, next)).moreRows?.some((r) => r.kind === "model")).toBeFalsy();
    expect(f.provider.calls).toHaveLength(0);
  });

  test("put away, it never returns for any administrator. Left alone, it returns after four weeks", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const ivo = await agent(f, "Ivo");
    const caio = await addMember(f.db, f.org.id, "admin", "caio");
    const deps = { db: f.db, pubsub: f.pubsub };
    /** The card of a week with work in it, and the agent it offers to archive. */
    const offered = async (userId: string, slot: Date) => {
      await busy(f, slot);
      const id = (await post(f, userId, slot)) as string;
      const row = (await cardOf(f, id)).moreRows?.[0];
      return { id, row: row?.kind === "retire" ? row : undefined };
    };

    // The oldest idle agent, on each administrator's card, each with a proposal of their own.
    const mine = await offered(f.owner.id, SLOT);
    const theirs = await offered(caio.id, SLOT);
    expect(mine.row?.agentId).toBe(ivo.id);
    expect(theirs.row?.agentId).toBe(ivo.id);
    expect(theirs.row?.proposalId).not.toBe(mine.row?.proposalId);
    // A week with nothing else to say posts no card for it. Left alone, it is not on the next cards either.
    expect(await post(f, f.owner.id, new Date(SLOT.getTime() + WEEK))).toBeNull();
    expect((await offered(f.owner.id, new Date(SLOT.getTime() + 2 * WEEK))).row).toBeUndefined();
    expect((await offered(f.owner.id, new Date(SLOT.getTime() + 3 * WEEK))).row).toBeUndefined();
    // Four weeks on it is offered once more, with a fresh proposal: the old one can't be applied any longer.
    const again = await offered(f.owner.id, new Date(SLOT.getTime() + 4 * WEEK));
    expect(again.row?.agentId).toBe(ivo.id);
    expect(again.row?.proposalId).not.toBe(mine.row?.proposalId);
    expect((await proposal(f, mine.row?.proposalId ?? ""))?.status).toBe("stale");

    // "Dispensar": refused as the person, the other administrator's copy closed, the row marked on the card.
    const card = await actOnTeamWeek(deps, f.owner.id, f.org.id, again.id, { rowId: `retire:${ivo.id}`, skip: true });
    // Kept apart from what was applied: a build from before reads any row in `done` as applied.
    expect(card.skipped?.[`retire:${ivo.id}`]).toMatchObject({ byUserId: f.owner.id });
    expect(card.done).toEqual({});
    expect(card.dismissedAt).toBeNull();
    expect((await proposal(f, again.row?.proposalId ?? ""))?.status).toBe("rejected");
    expect((await proposal(f, theirs.row?.proposalId ?? ""))?.status).toBe("stale");
    await expect(
      actOnTeamWeek(deps, f.owner.id, f.org.id, again.id, { rowId: `retire:${ivo.id}`, skip: true }),
    ).rejects.toThrow();
    // For good, and for both of them: the next idle agent takes its place, Ivo never does.
    const lia = await agent(f, "Lia", undefined, 50);
    const later = await offered(caio.id, new Date(SLOT.getTime() + 8 * WEEK));
    expect(later.row?.agentId).toBe(lia.id);
    const muchLater = await offered(f.owner.id, new Date(SLOT.getTime() + 12 * WEEK));
    expect(muchLater.row?.agentId).toBe(lia.id);
    const [kept] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, ivo.id));
    expect(kept?.archivedAt).toBeNull();
    expect(f.provider.calls).toHaveLength(0);
  });

  test("a dormant workspace gets no card, and one suggestion left alone holds the next agent back", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const ivo = await agent(f, "Ivo", undefined, 90);
    const rita = await agent(f, "Rita", undefined, 80);
    await agent(f, "Tito", undefined, 70);
    const week = (n: number) => new Date(SLOT.getTime() + n * WEEK);
    // Three idle agents and nothing else, week after week: no card, no ring, and no proposal left waiting.
    for (const n of [0, 1, 2]) expect(await post(f, f.owner.id, week(n))).toBeNull();
    expect(await f.db.select().from(schema.contextProposals)).toEqual([]);
    const offered = async (n: number) => {
      await busy(f, week(n));
      const row = (await cardOf(f, (await post(f, f.owner.id, week(n))) as string)).moreRows?.[0];
      return row?.kind === "retire" ? row : undefined;
    };
    // With work to report, the oldest is offered. While that one waits, no other agent is: one proposal, not three.
    const first = await offered(3);
    expect(first?.agentId).toBe(ivo.id);
    expect(await offered(4)).toBeUndefined();
    expect(await offered(5)).toBeUndefined();
    const pending = () =>
      f.db.select().from(schema.contextProposals).where(eq(schema.contextProposals.status, "pending"));
    expect(await pending()).toHaveLength(1);
    // Decided, the next one takes its place.
    await decideProposal(f.db, f.owner.id, f.org.id, first?.proposalId ?? "", "accept", { pubsub: f.pubsub });
    expect((await offered(6))?.agentId).toBe(rita.id);
    expect(await pending()).toHaveLength(1);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("unanswered questions: two askers in a team, muted per person, and only some rows are put away alone", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const caio = await addMember(f.db, f.org.id, "admin", "caio");
    const ask = (userId: string, n: number, slot = SLOT) =>
      insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId },
        body: `Does anyone know how to file invoice ${n}?`,
        createdAt: new Date(slot.getTime() - n * DAY),
      });
    const unanswered = async (userId: string, slot: Date) => {
      const id = await post(f, userId, slot);
      return {
        id: id as string,
        row: id ? (await cardOf(f, id)).rows.find((r) => r.kind === "unanswered") : undefined,
      };
    };
    // One person asking three times is not a team's unanswered questions.
    for (const n of [1, 2, 3]) await ask(f.owner.id, n);
    expect((await unanswered(f.owner.id, SLOT)).row).toBeUndefined();
    // In a personal workspace it is: the person's own questions are all there is.
    await f.db
      .update(schema.organizationSettings)
      .set({ mode: "personal" })
      .where(eq(schema.organizationSettings.orgId, f.org.id));
    expect((await unanswered(caio.id, SLOT)).row).toMatchObject({ channelId: f.general.id, count: 3 });
    await f.db
      .update(schema.organizationSettings)
      .set({ mode: "team" })
      .where(eq(schema.organizationSettings.orgId, f.org.id));

    // A second asker, four weeks later: both administrators get the row.
    const month = new Date(SLOT.getTime() + 4 * WEEK);
    for (const n of [1, 2]) await ask(f.owner.id, n, month);
    await ask(caio.id, 3, month);
    const mine = await unanswered(f.owner.id, month);
    expect(mine.row).toMatchObject({ id: `unanswered:${f.general.id}`, count: 3 });
    const deps = { db: f.db, pubsub: f.pubsub };
    // "Dispensar" mutes that channel for me. Lodi is not asked anything.
    const card = await actOnTeamWeek(deps, f.owner.id, f.org.id, mine.id, { rowId: mine.row?.id ?? "", skip: true });
    expect(card.skipped?.[mine.row?.id ?? ""]).toMatchObject({ byUserId: f.owner.id });
    expect(card.done).toEqual({});
    // Put away, it is not applied from a build that still draws its button.
    await expect(
      actOnTeamWeek(deps, f.owner.id, f.org.id, mine.id, { rowId: mine.row?.id ?? "", text: "An agent, please" }),
    ).rejects.toThrow("Already done");
    expect((await readLodiPrefs(f.db, f.org.id, f.owner.id)).prefs.muted).toEqual([`unanswered:${f.general.id}`]);
    expect(await f.db.select().from(schema.messages).where(eq(schema.messages.authorUserId, f.owner.id))).toHaveLength(
      5,
    );
    // Months later the questions go on: never again for me, still for the other administrator.
    const later = new Date(SLOT.getTime() + 12 * WEEK);
    for (const n of [1, 2]) await ask(f.owner.id, n, later);
    await ask(caio.id, 3, later);
    expect((await unanswered(f.owner.id, later)).row).toBeUndefined();
    const theirs = await unanswered(caio.id, later);
    expect(theirs.row).toMatchObject({ channelId: f.general.id });
    // Left alone by them, it is not on their next week's card either.
    const after = new Date(later.getTime() + WEEK);
    for (const n of [1, 2]) await ask(f.owner.id, n, after);
    await ask(caio.id, 3, after);
    expect((await unanswered(caio.id, after)).row).toBeUndefined();
  });

  test("a row that applies a fix is not put away alone, and nobody skips a row of someone else's card", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const ivo = await agent(f, "Ivo");
    await budgetStop(f, new Date(SLOT.getTime() - DAY));
    const id = (await post(f, f.owner.id, SLOT)) as string;
    const card = await cardOf(f, id);
    const deps = { db: f.db, pubsub: f.pubsub };
    const budget = card.rows.find((r) => r.kind === "budget");
    await expect(
      actOnTeamWeek(deps, f.owner.id, f.org.id, id, { rowId: budget?.id ?? "", skip: true }),
    ).rejects.toThrow("not put away alone");
    const caio = await addMember(f.db, f.org.id, "admin", "caio");
    await expect(actOnTeamWeek(deps, caio.id, f.org.id, id, { rowId: `retire:${ivo.id}`, skip: true })).rejects.toThrow(
      "someone else's",
    );
    // Archiving is never applied from here: it goes through its proposal, as whoever decides it.
    await expect(actOnTeamWeek(deps, f.owner.id, f.org.id, id, { rowId: `retire:${ivo.id}` })).rejects.toThrow(
      "its own card",
    );
    const [kept] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, ivo.id));
    expect(kept?.archivedAt).toBeNull();
  });
});

describe("Resumo do dia", () => {
  /** Friday 2026-11-06, 09:00 in São Paulo (UTC-3). */
  const NINE = new Date("2026-11-06T12:00:00Z");
  const cardOf = async (fx: Fixture, messageId: string) => {
    const [m] = await fx.db.select().from(schema.messages).where(eq(schema.messages.id, messageId));
    const card = teamWeekCardOf(m?.meta);
    if (!m || !card) throw new Error("no card");
    return { m, card };
  };

  test("every day at its hour, over the last day, for everyone; one card per person and day", async () => {
    const prefs = lodiPrefsOf({ daily: true, hour: 9 });
    expect(prefs).toMatchObject({ dayOff: false, dayHour: 9, weekOff: true });
    expect(lastTeamWeekSlot("day", prefs, ZONE, new Date(NINE.getTime() + HOUR))?.toISOString()).toBe(
      NINE.toISOString(),
    );
    expect(lastTeamWeekSlot("day", prefs, ZONE, new Date(NINE.getTime() - HOUR))?.toISOString()).toBe(
      new Date(NINE.getTime() - DAY).toISOString(),
    );

    f = await setup({ rightHand: true });
    await inZone(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await setLodiPrefs(f.db, f.org.id, f.owner.id, { off: true });
    // On for anyone who never chose.
    expect(await enqueueTeamWeeks(f.db, new Date(NINE.getTime() + HOUR))).toBe(1);
    await enqueueTeamWeeks(f.db, new Date(NINE.getTime() + 2 * HOUR));
    expect(await jobs(f)).toHaveLength(1);
    expect(await enqueueTeamWeeks(f.db, new Date(NINE.getTime() + DAY + HOUR))).toBe(1);
    expect((await jobs(f)).map((j) => j.payload)).toEqual([
      { userId: bia.id, slot: NINE.toISOString(), period: "day" },
      { userId: bia.id, slot: new Date(NINE.getTime() + DAY).toISOString(), period: "day" },
    ]);
    await setLodiPrefs(f.db, f.org.id, bia.id, { dayOff: true });
    expect(await enqueueTeamWeeks(f.db, new Date(NINE.getTime() + 2 * DAY + HOUR))).toBe(0);
  });

  /** `userId` asks `agentId` in a conversation and the run it starts ends as `status`. */
  const ask = async (
    fx: Fixture,
    userId: string,
    at: Date,
    status: "done" | "failed" | "waiting_input" | "running",
    over: { channelId?: string; agentId?: string; error?: string; transcript?: Record<string, unknown> } = {},
  ) => {
    const channelId = over.channelId ?? fx.general.id;
    const m = await insertMessage(fx.db, {
      orgId: fx.org.id,
      channelId,
      author: { type: "person", userId },
      body: "@dev faz isso",
      createdAt: at,
    });
    const [r] = await fx.db
      .insert(schema.agentRuns)
      .values({
        orgId: fx.org.id,
        agentId: over.agentId ?? fx.agent.id,
        channelId,
        threadRootId: m.id,
        triggerMessageId: m.id,
        trigger: "mention",
        hop: 1,
        status,
        error: over.error ?? null,
        transcript: over.transcript ?? null,
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    return r?.id ?? "";
  };
  const waits = (fx: Fixture, userId: string, key: string) =>
    notify(
      { db: fx.db, pubsub: fx.pubsub },
      {
        orgId: fx.org.id,
        userIds: [userId],
        kind: "agent_question",
        groupKey: key,
        waiting: true,
        actor: { type: "agent", id: fx.agent.id },
        source: {},
        latest: { text: "Which plan do I use?" },
      },
    );
  const post = (fx: Fixture, userId: string, slot: Date) =>
    postTeamWeek({ db: fx.db, pubsub: fx.pubsub }, fx.org.id, { userId, slot: slot.toISOString(), period: "day" });
  const rings = async (fx: Fixture, messageId: string) =>
    (
      await fx.db
        .select()
        .from(schema.outbox)
        .where(
          and(
            eq(schema.outbox.kind, "notifications.message"),
            sql`${schema.outbox.payload}->>'messageId' = ${messageId}`,
          ),
        )
    ).length > 0;
  /** The row kinds app builds from before `moreRows` word: any other in `rows` would break their card. */
  const FIRST_KINDS = ["approvals", "howto", "budget", "channel", "unanswered", "routine", "stalled"];

  test("what waits on the person, what they asked for that finished, and what is stuck with its cause", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await ask(f, bia.id, new Date(NINE.getTime() - 5 * HOUR), "done");
    await ask(f, bia.id, new Date(NINE.getTime() - 3 * HOUR), "failed", {
      error: "provider_error: down@Claude: the upstream said something private",
    });
    // A day earlier than the card's, and other people's work in the same channel: outside it.
    await ask(f, bia.id, new Date(NINE.getTime() - 2 * DAY), "done");
    await run(f, f.agent.id, new Date(NINE.getTime() - 2 * HOUR), "done");
    await run(f, f.agent.id, new Date(NINE.getTime() - 2 * HOUR), "failed", "stuck");
    await waits(f, bia.id, "question:1");

    const id = await post(f, bia.id, NINE);
    expect(id).not.toBeNull();
    const { m, card } = await cardOf(f, id as string);
    expect(m.body).toBe("Seu resumo do dia está pronto");
    expect(card).toMatchObject({ period: "day", slot: NINE.toISOString(), from: "2026-11-05", to: "2026-11-06" });
    expect(card.stats).toEqual({ done: 1, stuck: 1, waiting: 1, spentNanoUsd: 0, budgetNanoUsd: 0 });
    expect(card.worked).toEqual([{ kind: "runs", agentId: f.agent.id, channelId: f.general.id, count: 1 }]);
    expect(card.moreRows).toEqual([
      {
        id: "waiting",
        kind: "waiting",
        count: 1,
        ids: [expect.any(String)],
        agentId: f.agent.id,
        since: expect.any(String),
      },
      {
        id: `stuck:${f.agent.id}:${f.general.id}`,
        kind: "stuck",
        agentId: f.agent.id,
        channelId: f.general.id,
        dm: false,
        code: "ai",
        count: 1,
        held: false,
      },
    ]);
    // A cause, never what the run or the question said.
    expect(JSON.stringify(card)).not.toContain("private");
    expect(JSON.stringify(card)).not.toContain("Which plan");
    // A build from before reads `rows` alone, and finds only kinds it words.
    expect(card.rows.every((r) => FIRST_KINDS.includes(r.kind))).toBe(true);
    // The question rang when it was asked and the failure when it happened: the card is read when they come.
    expect(await rings(f, id as string)).toBe(false);
    // A retry of the same job posts no second card, and none of it called a model.
    expect(await post(f, bia.id, NINE)).toBeNull();
    expect(f.provider.calls).toHaveLength(0);
  });

  test("a team busy with other people's asks posts nothing to the 30 who asked for none of it", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const people = [];
    for (let i = 0; i < 30; i++) people.push(await addMember(f.db, f.org.id, "member", `p${i}`));
    for (let i = 0; i < 12; i++) await ask(f, f.owner.id, new Date(NINE.getTime() - (i + 1) * HOUR), "done");
    await ask(f, f.owner.id, new Date(NINE.getTime() - HOUR), "failed", { error: "stuck" });
    for (const p of people) expect(await post(f, p.id, NINE)).toBeNull();
    const cards = await f.db
      .select()
      .from(schema.messages)
      .where(sql`${schema.messages.meta}->'actionCard'->>'kind' = 'team_week'`);
    expect(cards).toEqual([]);
    expect(f.provider.calls).toHaveLength(0);
    // What a person asked for answered them where they asked: it finishing is no card of its own.
    const [bia] = people;
    await ask(f, bia?.id ?? "", new Date(NINE.getTime() - HOUR), "done");
    expect(await post(f, bia?.id ?? "", NINE)).toBeNull();
    // Turned off, nothing either, whatever happened.
    await waits(f, bia?.id ?? "", "question:1");
    await setLodiPrefs(f.db, f.org.id, bia?.id ?? "", { dayOff: true });
    expect(await post(f, bia?.id ?? "", NINE)).toBeNull();
  });

  test("said once: the same waiting items and held runs the next day post nothing, a new one does", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await waits(f, bia.id, "question:1");
    // `since` as a parked run stores it: a number of milliseconds.
    const held = await ask(f, bia.id, new Date(NINE.getTime() - 6 * HOUR), "waiting_input", {
      transcript: { waitingForBrain: { code: "plan_limit", since: NINE.getTime() - 6 * HOUR } },
    });
    // Parked a moment ago, on a budget or on a plan: it may go on by itself, so it is not called stuck.
    await ask(f, bia.id, new Date(NINE.getTime() - HOUR), "waiting_input", {
      transcript: { waitingForBrain: { code: "budget", since: NINE.getTime() - HOUR } },
    });
    await ask(f, bia.id, new Date(NINE.getTime() - 5 * 60_000), "waiting_input", {
      transcript: { waitingForBrain: { code: "plan_limit", since: NINE.getTime() - 5 * 60_000 } },
    });
    const first = (await post(f, bia.id, NINE)) as string;
    const one = (await cardOf(f, first)).card;
    expect(one.moreRows?.map((r) => [r.kind, r.kind === "stuck" && [r.code, r.held, r.count]])).toEqual([
      ["waiting", false],
      ["stuck", ["plan", true, 1]],
    ]);
    expect(one.seen).toContain(`run:${held}`);
    expect(await rings(f, first)).toBe(true);

    // The day after: all of it is still there, none of it new.
    const day = (n: number) => new Date(NINE.getTime() + n * DAY);
    await f.db
      .delete(schema.agentRuns)
      .where(sql`(${schema.agentRuns.transcript}->'waitingForBrain'->>'since')::bigint > ${NINE.getTime() - 2 * HOUR}`);
    expect(await post(f, bia.id, day(1))).toBeNull();
    // Her agent finished something for someone else: a card, with what still waits on it, and no ring for what was
    // already said.
    const [lia] = await f.db
      .insert(schema.agents)
      .values({
        orgId: f.org.id,
        name: "Lia",
        handle: "lia",
        role: "Research",
        instructions: "",
        model: "claude-sonnet-5-5",
        ownerUserId: bia.id,
      })
      .returning();
    await ask(f, f.owner.id, new Date(day(2).getTime() - HOUR), "done", { agentId: lia?.id });
    const second = (await post(f, bia.id, day(2))) as string;
    const two = (await cardOf(f, second)).card;
    // It goes on from the last card, so the day that posted none is inside it.
    expect(two.from).toBe("2026-11-06");
    expect(two.stats).toMatchObject({ done: 1, waiting: 1 });
    expect(two.moreRows?.map((r) => r.kind)).toEqual(["waiting", "stuck"]);
    expect(await rings(f, second)).toBe(false);
    // Asked the same day's job again after its window moved: still one card.
    expect(await post(f, bia.id, day(2))).toBeNull();
    // A new thing waiting is on a new card, which does not ring: its own notice did.
    await waits(f, bia.id, "question:2");
    const third = (await post(f, bia.id, day(3))) as string;
    expect((await cardOf(f, third)).card.moreRows?.[0]).toMatchObject({ kind: "waiting", count: 2 });
    expect(await rings(f, third)).toBe(false);
    // A run newly held told nobody yet: that rings.
    await ask(f, bia.id, new Date(day(4).getTime() - 6 * HOUR), "waiting_input", {
      transcript: { waitingForBrain: { code: "not_logged_in", since: day(4).getTime() - 6 * HOUR } },
    });
    expect(await rings(f, (await post(f, bia.id, day(4))) as string)).toBe(true);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("a run counts on the day it ended, and one that failed posts without ringing again", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const day = (n: number) => new Date(NINE.getTime() + n * DAY);
    // Asked at 8:40 and still working at 9:00: nothing to say yet.
    const id = await ask(f, bia.id, new Date(NINE.getTime() - 20 * 60_000), "running");
    expect(await post(f, bia.id, NINE)).toBeNull();
    // It fails at 10:00, after the slot. The next day's card has it, though it began before that card's window.
    const at = new Date(NINE.getTime() + HOUR);
    await f.db
      .update(schema.agentRuns)
      .set({ status: "failed", error: "stuck", finishedAt: at, updatedAt: at })
      .where(eq(schema.agentRuns.id, id));
    const next = (await post(f, bia.id, day(1))) as string;
    const { card } = await cardOf(f, next);
    expect(card.stats).toMatchObject({ done: 0, stuck: 1 });
    expect(card.moreRows).toEqual([expect.objectContaining({ kind: "stuck", code: "other", count: 1, held: false })]);
    // Its person heard of the failure when it happened (their inbox): the card does not ring for it again.
    expect(await rings(f, next)).toBe(false);
    // And it is on that one card only.
    expect(await post(f, bia.id, day(2))).toBeNull();
    expect(f.provider.calls).toHaveLength(0);
  });

  test("a task is an agent's work only when an agent closed it, and only on the day it did", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const day = (n: number) => new Date(NINE.getTime() + n * DAY);
    /** Bia's task, given to Dev and closed at `at` by `by`. */
    const closed = async (number: number, at: Date, by: { type: "person" | "agent"; id: string }) => {
      const [issue] = await f.db
        .insert(schema.issues)
        .values({
          orgId: f.org.id,
          number,
          title: "Write the report",
          status: "done",
          assigneeType: "agent",
          assigneeId: f.agent.id,
          createdByType: "person",
          createdById: bia.id,
          updatedAt: at,
        })
        .returning();
      await f.db.insert(schema.issueActivity).values({
        orgId: f.org.id,
        issueId: issue?.id ?? "",
        kind: "event",
        authorType: by.type,
        authorId: by.id,
        text: "changed the status to Done",
        event: "status_changed",
        data: { from: "in_progress", to: "done" },
        createdAt: at,
      });
      return issue?.id ?? "";
    };
    // She closes her own task: nobody's news.
    await closed(31, new Date(NINE.getTime() - 2 * HOUR), { type: "person", id: bia.id });
    expect(await post(f, bia.id, NINE)).toBeNull();
    // Dev closes another: said once, quietly.
    const task = await closed(32, new Date(day(1).getTime() - 2 * HOUR), { type: "agent", id: f.agent.id });
    const id = (await post(f, bia.id, day(1))) as string;
    expect((await cardOf(f, id)).card.worked).toEqual([{ kind: "tasks", agentId: f.agent.id, count: 1 }]);
    expect(await rings(f, id)).toBe(false);
    // A comment on it days later touches the task and closes nothing.
    await f.db
      .update(schema.issues)
      .set({ updatedAt: new Date(day(2).getTime() - HOUR) })
      .where(eq(schema.issues.id, task));
    expect(await post(f, bia.id, day(2))).toBeNull();
  });

  test("a task its maker no longer sees is not counted for them", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const at = new Date(NINE.getTime() - 2 * HOUR);
    // Bia made it, then its audience was narrowed to someone else. Dev closed it.
    const [issue] = await f.db
      .insert(schema.issues)
      .values({
        orgId: f.org.id,
        number: 41,
        title: "Write the report",
        status: "done",
        assigneeType: "agent",
        assigneeId: f.agent.id,
        createdByType: "person",
        createdById: bia.id,
        restricted: true,
        audienceUserIds: [f.owner.id],
        updatedAt: at,
      })
      .returning();
    await f.db.insert(schema.issueActivity).values({
      orgId: f.org.id,
      issueId: issue?.id ?? "",
      kind: "event",
      authorType: "agent",
      authorId: f.agent.id,
      text: "changed the status to Done",
      event: "status_changed",
      data: { from: "in_progress", to: "done" },
      createdAt: at,
    });
    expect(await post(f, bia.id, NINE)).toBeNull();
    // Shown to her again, it is her agent's work of the day.
    await f.db.update(schema.issues).set({ restricted: false, audienceUserIds: [] });
    const id = (await post(f, bia.id, NINE)) as string;
    expect((await cardOf(f, id)).card.worked).toEqual([{ kind: "tasks", agentId: f.agent.id, count: 1 }]);
  });

  test("what a run waits on is named for what it is, and every waiting item is on the row", async () => {
    expect(stuckCause({ wait: "budget" })).toBe("budget");
    expect(stuckCause({ wait: "usage_pause", source: "budget" })).toBe("budget");
    expect(stuckCause({ wait: "usage_pause", source: "plan" })).toBe("plan");
    expect(stuckCause({ wait: "plan_limit" })).toBe("plan");
    expect(stuckCause({ wait: "not_logged_in" })).toBe("key");
    for (const wait of ["machine_offline", "machine_dropped", "no_session", "no_computer", "busy"])
      expect([wait, stuckCause({ wait })]).toEqual([wait, "computer"]);
    // A paused computer, a plan its owner did not share: neither the computer failing nor a limit reached.
    for (const wait of ["machine_paused", "plan_not_shared", "plan_not_owner", "plan_unattended", "tool_off"])
      expect([wait, stuckCause({ wait })]).toEqual([wait, "other"]);

    f = await setup({ rightHand: true });
    await inZone(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    // A long work paused on the agent's budget is a budget's wait, read from the run as it is stored.
    await ask(f, bia.id, new Date(NINE.getTime() - 6 * HOUR), "waiting_input", {
      transcript: { waitingForBrain: { code: "usage_pause", source: "budget", since: NINE.getTime() - 6 * HOUR } },
    });
    for (let i = 0; i < 25; i++) await waits(f, bia.id, `question:${i}`);
    const { card } = await cardOf(f, (await post(f, bia.id, NINE)) as string);
    const [waiting, stuck] = card.moreRows ?? [];
    expect(stuck).toMatchObject({ kind: "stuck", code: "budget", held: true });
    // All 25: the apps say "nothing left waiting" only when none of them waits any longer.
    expect(waiting).toMatchObject({ kind: "waiting", count: 25 });
    expect(waiting?.kind === "waiting" && waiting.ids).toHaveLength(25);
  });

  test("only where the reader reads: a private channel they are not in, and someone else's DM, stay off", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    // Bia's own agent works in a private channel she is not in, for someone else.
    const [mine] = await f.db
      .insert(schema.agents)
      .values({
        orgId: f.org.id,
        name: "Lia",
        handle: "lia",
        role: "Research",
        instructions: "",
        model: "claude-sonnet-5-5",
        ownerUserId: bia.id,
      })
      .returning();
    const [hidden] = await f.db
      .insert(schema.channels)
      .values({ orgId: f.org.id, name: "diretoria", kind: "channel", visibility: "private" })
      .returning();
    await ask(f, f.owner.id, new Date(NINE.getTime() - HOUR), "failed", {
      channelId: hidden?.id,
      agentId: mine?.id,
      error: "stuck",
    });
    expect(await post(f, bia.id, NINE)).toBeNull();

    // The owner administers and owns Dev. Dev failing in Bia's DM with it is hers to read, not theirs.
    const dm = await openPersonAgentDm(f.db, f.org.id, bia.id, f.agent.id);
    await ask(f, bia.id, new Date(NINE.getTime() - HOUR), "failed", { channelId: dm.id, error: "stuck" });
    const own = (await cardOf(f, (await post(f, f.owner.id, NINE)) as string)).card;
    // The private channel is an administrator's to read, the DM is not. No money on a day's card, and no budget row.
    expect(own.moreRows).toEqual([
      expect.objectContaining({ kind: "stuck", channelId: hidden?.id, agentId: mine?.id }),
    ]);
    expect(own.stats).toMatchObject({ stuck: 1, spentNanoUsd: 0, budgetNanoUsd: 0 });
    expect(await f.db.select().from(schema.contextProposals)).toEqual([]);
    const hers = (await cardOf(f, (await post(f, bia.id, NINE)) as string)).card;
    expect(hers.moreRows).toEqual([
      expect.objectContaining({ kind: "stuck", channelId: dm.id, dm: true, code: "other", count: 1 }),
    ]);
  });

  test("a how-to learned in someone else's DM or a private channel is on no card of the agent's owner", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const [lia] = await f.db
      .insert(schema.agents)
      .values({
        orgId: f.org.id,
        name: "Lia",
        handle: "lia",
        role: "Research",
        instructions: "",
        model: "claude-sonnet-5-5",
        ownerUserId: bia.id,
      })
      .returning();
    const [hidden] = await f.db
      .insert(schema.channels)
      .values({ orgId: f.org.id, name: "diretoria", kind: "channel", visibility: "private" })
      .returning();
    // Someone else uses Bia's agent in their own DM with it.
    const theirs = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lia?.id ?? "");
    const hers = await openPersonAgentDm(f.db, f.org.id, bia.id, lia?.id ?? "");
    const howTo = (title: string, channelIds: string[]) =>
      f.db
        .insert(schema.contextItems)
        .values({
          orgId: f.org.id,
          agentId: lia?.id,
          kind: "note",
          scopeType: "agent",
          scopeId: lia?.id,
          subjectKey: "howto close the month",
          title,
          content: title,
          channelIds,
          trust: "low",
          recurrence: 5,
        })
        .returning();
    await howTo("Payroll: the board's salary table", [theirs.id]);
    await howTo("Layoff list steps", [hidden?.id ?? ""]);
    // Nothing of hers to say: the two alone post no card, and neither title leaves where it was learned.
    expect(await post(f, bia.id, NINE)).toBeNull();

    const [own] = await howTo("Export the report", [hers.id]);
    const [anywhere] = await howTo("Name the files", []);
    const { card } = await cardOf(f, (await post(f, bia.id, NINE)) as string);
    expect(card.rows.flatMap((r) => (r.kind === "howto" ? [r.itemId] : [])).sort()).toEqual(
      [own?.id ?? "", anywhere?.id ?? ""].sort(),
    );
    expect(JSON.stringify(card)).not.toContain("Payroll");
    expect(JSON.stringify(card)).not.toContain("Layoff");
  });

  test("three approvals or more are on the summary of approvals alone, for who has it on", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const approvals = await f.db
      .insert(schema.approvals)
      .values(
        [1, 2, 3].map((n) => ({
          orgId: f.org.id,
          agentId: f.agent.id,
          channelId: f.general.id,
          threadRootId: crypto.randomUUID(),
          toolUseId: `tool-${n}`,
          tool: "github_merge",
          scope: "github:pr.merge",
          params: { pr: n },
          actionHash: `hash-${n}`,
          title: `Merge PR #${n}`,
          ownerUserId: f.owner.id,
          expiresAt: new Date(Date.now() + DAY),
        })),
      )
      .returning();
    for (const a of approvals)
      await notify(
        { db: f.db, pubsub: f.pubsub },
        {
          orgId: f.org.id,
          userIds: [f.owner.id],
          kind: "approval",
          groupKey: `approval:${a.id}`,
          waiting: true,
          actor: { type: "agent", id: f.agent.id },
          source: { approvalId: a.id },
          latest: { title: a.title },
        },
      );
    // The summary holds them: the day's card would only say them again, so it says nothing.
    expect(await post(f, f.owner.id, NINE)).toBeNull();
    // Who turned the summary off reads them on the day's card, as before.
    await setLodiPrefs(f.db, f.org.id, f.owner.id, { digestOff: true });
    const off = await cardOf(f, (await post(f, f.owner.id, NINE)) as string);
    expect(off.card.rows.filter((r) => r.kind === "approvals")).toEqual([
      expect.objectContaining({ agentId: f.agent.id, approvalIds: expect.arrayContaining(approvals.map((a) => a.id)) }),
    ]);
    // On again, with something else to say: the card comes without their rows, and still counts them as waiting.
    await setLodiPrefs(f.db, f.org.id, f.owner.id, { digestOff: false });
    await waits(f, f.owner.id, "question:1");
    const { card } = await cardOf(f, (await post(f, f.owner.id, new Date(NINE.getTime() + DAY))) as string);
    expect(card.rows.filter((r) => r.kind === "approvals")).toEqual([]);
    expect(card.moreRows?.map((r) => r.kind)).toEqual(["waiting"]);
    expect(card.stats.waiting).toBe(4);
  });

  test("asked of Lodi: set_team_week moves it for the person behind the run", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const lodi = await lodiOf(f);
    const dm = await openPersonAgentDm(f.db, f.org.id, bia.id, lodi.id);
    const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, dm.id, {
      body: "me manda isso todo dia às 9h",
    });
    const [r] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
    const gateway = createToolGateway({ sources: [createSetupToolSource({ pubsub: f.pubsub })] });
    const res = await gateway.invoke(
      {
        db: f.db,
        orgId: f.org.id,
        agentId: lodi.id,
        runId: r?.id ?? "",
        channelId: dm.id,
        threadRootId: r?.threadRootId ?? trigger.id,
        triggerMessageId: trigger.id,
      },
      { toolUseId: "tu_1", name: SET_TEAM_WEEK_TOOL, input: { card: "day", hour: 8 } },
    );
    if (res.type !== "result") throw new Error(res.type);
    expect((res.output as { content: string }).content).toContain("Daily summary: every day at 8:00");
    expect(await getLodiPrefs(f.db, f.org.id, bia.id)).toMatchObject({
      dayOff: false,
      dayHour: 8,
      daily: true,
      hour: 8,
    });
  });
});

test("what Lodi posts unasked is on by default and named on its page in every language", () => {
  expect(LODI_PREFS_DEFAULTS).toMatchObject({ weekOff: false, dayOff: false });
  for (const [code, strings] of Object.entries(STRINGS)) {
    const words = strings as { teamWeek?: { settings?: { label?: string; dayLabel?: string } } };
    const labels = [
      words.teamWeek?.settings?.label ?? en.teamWeek.settings.label,
      words.teamWeek?.settings?.dayLabel ?? en.teamWeek.settings.dayLabel,
    ];
    expect({ code, named: labels.every(Boolean) }).toEqual({ code, named: true });
  }
});
