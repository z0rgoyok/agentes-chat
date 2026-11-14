import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  closeRoutineRun,
  executeRoutineRun,
  liveLodiSwitches,
  markNotificationDone,
  RIGHT_HAND,
  registerPushDevice,
  remindNotifications,
  renderPush,
  routineFailureEnd,
  runRoutineNow,
  wakeSnoozedNotifications,
} from "../src";
import { APPROVALS_DIGEST_JOB, approvalsDigestLane } from "../src/approvals-digest";
import { OUTSIDE_RUN_ERRORS, outsideRoutineFailure, ROUTINE_RETRY_AFTER_MS } from "../src/routine-ledger";
import {
  enqueueTeamWatches,
  runTeamWatch,
  TEAM_WATCH_DAILY_ROWS,
  TEAM_WATCH_JOB,
  teamWatchLane,
  teamWatchNames,
} from "../src/team-watch";
import { addMember, type Fixture, setup } from "./fixtures";
import {
  agentRunRow,
  channelRoutine,
  fire,
  minutesFromNow,
  notificationsOf,
  routineDeps,
  routineRow,
  routineRunRow,
} from "./routine-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Wednesday 2026-11-11, 15:00 UTC: daytime where nobody chose a time zone, a third of the month gone. */
const NOW = new Date("2026-11-11T15:00:00Z");
const ago = (ms: number, from = NOW) => new Date(from.getTime() - ms);

const lodiOf = async () => {
  const [lodi] = await f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};
const watch = (now = NOW) => runTeamWatch(f.jobDeps, f.org.id, now);
const rows = () => notificationsOf(f, "team_watch");
const checks = async () =>
  (await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, TEAM_WATCH_JOB))).length;
const setSwitch = (teamWatch: boolean) =>
  f.db
    .insert(schema.organizationSettings)
    .values({ orgId: f.org.id, teamWatch })
    .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: { teamWatch } });

const computer = async (values: Partial<typeof schema.machines.$inferInsert> = {}) => {
  const [machine] = await f.db
    .insert(schema.machines)
    .values({ orgId: f.org.id, name: "Mac da Ana", pairedByUserId: f.owner.id, lastSeenAt: ago(2 * HOUR), ...values })
    .returning();
  if (!machine) throw new Error("no machine");
  return machine;
};

/** A plan's sign-in on a computer, thinking for all of its owner's agents there. */
const plan = async (values: Partial<typeof schema.machineAccounts.$inferInsert> = {}) => {
  const machine = await computer({ lastSeenAt: NOW, online: true });
  const id = crypto.randomUUID();
  await f.db.insert(schema.machineAccounts).values({
    id,
    orgId: f.org.id,
    machineId: machine.id,
    kind: "claude_code",
    label: "Trabalho",
    status: "signed_out",
    shared: true,
    createdBy: f.owner.id,
    createdAt: ago(30 * 24 * HOUR),
    lastUsedAt: ago(HOUR),
    updatedAt: ago(HOUR),
    ...values,
  });
  return id;
};

/** A run of `agentId` that failed for `reason`, as its person was told. */
const runFailed = (agentId: string, reason: string, at = ago(30 * MIN)) =>
  f.db.insert(schema.notifications).values({
    orgId: f.org.id,
    userId: f.owner.id,
    kind: "run_failed",
    groupKey: `run_failed:${crypto.randomUUID()}`,
    actors: [{ type: "agent", id: agentId }],
    latest: { reason },
    createdAt: at,
    updatedAt: at,
  });

const database = () =>
  f.db.insert(schema.dbConnections).values({
    orgId: f.org.id,
    label: "Produção",
    host: "db.example.com",
    database: "app",
    username: "reader",
    secretCiphertext: "v1.x.y.z",
    wrappedDataKey: "k",
    kekId: "local:v1",
    status: "needs_reconnect",
    createdByUserId: f.owner.id,
  });

const waitingRun = (machineId: string) =>
  f.db.insert(schema.agentRuns).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    channelId: f.general.id,
    triggerMessageId: crypto.randomUUID(),
    threadRootId: crypto.randomUUID(),
    trigger: "mention",
    hop: 0,
    waitingMachineId: machineId,
  });

const pushes = async () => (await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "push.send"))).length;

const connector = async (label: string, values: Partial<typeof schema.connectorConnections.$inferInsert> = {}) => {
  const [row] = await f.db
    .insert(schema.connectorConnections)
    .values({
      orgId: f.org.id,
      connector: label.toLowerCase(),
      label,
      toolPrefix: label.toLowerCase(),
      serverUrl: `https://${label.toLowerCase()}.example.com/mcp`,
      authType: "none",
      status: "needs_reconnect",
      createdByUserId: f.owner.id,
      updatedAt: ago(HOUR),
      ...values,
    })
    .returning();
  if (!row) throw new Error("no connector");
  return row;
};

const spend = (agentId: string, spentNanoUsd: number, now = NOW) =>
  f.db
    .insert(schema.agentBudgetPeriods)
    .values({ orgId: f.org.id, agentId, periodStart: `${now.toISOString().slice(0, 7)}-01`, spentNanoUsd })
    .onConflictDoUpdate({
      target: [schema.agentBudgetPeriods.agentId, schema.agentBudgetPeriods.periodStart],
      set: { spentNanoUsd },
    });

/** Something waiting on a person in "Esperando você". */
const ask = async (userId: string, at: Date, values: Partial<typeof schema.notifications.$inferInsert> = {}) => {
  const [row] = await f.db
    .insert(schema.notifications)
    .values({
      orgId: f.org.id,
      userId,
      kind: "agent_question",
      waiting: true,
      groupKey: `agent_question:${crypto.randomUUID()}`,
      actors: [{ type: "agent", id: f.agent.id }],
      latest: { text: "Qual das duas?" },
      createdAt: at,
      updatedAt: at,
      ...values,
    })
    .returning();
  if (!row) throw new Error("no notification");
  return row;
};
const reread = async (id: string) => {
  const [row] = await f.db.select().from(schema.notifications).where(eq(schema.notifications.id, id));
  if (!row) throw new Error("no notification");
  return row;
};

describe("the sweep", () => {
  /** How many checks an hour of sweeps queues, from `from`. */
  const anHour = async (from: Date) => {
    let queued = 0;
    for (let i = 0; i < 6; i++) queued += await enqueueTeamWatches(f.db, new Date(from.getTime() + i * 10 * MIN));
    return queued;
  };

  test("a healthy workspace gets no check, a problem gets one per window, the switch off none", async () => {
    f = await setup({ rightHand: true });
    expect(teamWatchLane.live).toBe(true);
    expect(liveLodiSwitches()).toContain("teamWatch");
    expect(await enqueueTeamWatches(f.db, NOW)).toBe(0);

    // A blip tells nobody: under the grace there is nothing to look at.
    const slack = await connector("Slack", { updatedAt: ago(5 * MIN) });
    expect(await enqueueTeamWatches(f.db, NOW)).toBe(0);
    await f.db
      .update(schema.connectorConnections)
      .set({ updatedAt: ago(HOUR) })
      .where(eq(schema.connectorConnections.id, slack.id));

    await setSwitch(false);
    expect(await enqueueTeamWatches(f.db, NOW)).toBe(0);
    await setSwitch(true);
    expect(await enqueueTeamWatches(f.db, NOW)).toBe(1);
    expect(await enqueueTeamWatches(f.db, new Date(NOW.getTime() + MIN))).toBe(0);
    expect(await enqueueTeamWatches(f.db, new Date(NOW.getTime() + 10 * MIN))).toBe(1);
    expect(await checks()).toBe(2);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("a workspace without the right hand, or closed, gets none", async () => {
    f = await setup();
    await connector("Slack");
    expect(await enqueueTeamWatches(f.db, NOW)).toBe(0);
    await f.close();

    f = await setup({ rightHand: true });
    await connector("Slack");
    await f.db.update(schema.organizations).set({ standing: "suspended" }).where(eq(schema.organizations.id, f.org.id));
    expect(await enqueueTeamWatches(f.db, NOW)).toBe(0);
    await watch();
    expect(await rows()).toHaveLength(0);
  });

  test("an ask left unread for hours is something to look at only in that person's daytime", async () => {
    f = await setup({ rightHand: true });
    await ask(f.owner.id, ago(5 * HOUR));
    expect(await enqueueTeamWatches(f.db, NOW)).toBe(1);
    // 15:00 UTC is midnight in Tokyo.
    await f.db
      .update(schema.organizationMembers)
      .set({ timezone: "Asia/Tokyo" })
      .where(eq(schema.organizationMembers.userId, f.owner.id));
    expect(await enqueueTeamWatches(f.db, new Date(NOW.getTime() + 10 * MIN))).toBe(0);
  });

  test("what the check would pass over queues nothing: a plan no agent uses, a budget on pace", async () => {
    f = await setup({ rightHand: true, budgetNanoUsd: 10_000_000_000 });
    await plan({ shared: false });
    // 85% on the 29th lasts the month.
    const late = new Date("2026-11-29T15:00:00Z");
    await spend(f.agent.id, 8_500_000_000, late);
    expect(await anHour(late)).toBe(0);
    await watch(late);
    expect(await rows()).toHaveLength(0);
  });

  test("what only stands as it was is looked at once an hour, what is new every 10 minutes", async () => {
    f = await setup({ rightHand: true });
    await connector("Slack");
    await watch();
    expect(await rows()).toHaveLength(1);
    // The day it broke and was told: every window, so its row leaves soon after the fix.
    expect(await anHour(NOW)).toBe(6);
    // Days later, told and still not fixed, or put away: once an hour.
    const later = new Date("2026-11-14T15:00:00Z");
    expect(await anHour(later)).toBe(1);
    const [row] = await rows();
    await markNotificationDone({ db: f.db }, f.owner.id, f.org.id, row?.id ?? "", true);
    expect(await anHour(new Date("2026-11-15T15:00:00Z"))).toBe(1);
  });

  test("a person reminded today, and an approval no longer theirs to decide, queue nothing more", async () => {
    f = await setup({ rightHand: true });
    const member = await addMember(f.db, f.org.id, "member", "caio");
    await ask(f.owner.id, ago(8 * HOUR));
    const [approval] = await f.db
      .insert(schema.approvals)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: crypto.randomUUID(),
        toolUseId: "tool-1",
        tool: "github_merge",
        scope: "github:pr.merge",
        params: { pr: 42 },
        actionHash: "hash",
        title: "Merge PR #42",
        approvers: { required: true, userIds: [f.owner.id], label: "Ana", requestedBy: null, requesterDecides: false },
        expiresAt: new Date(NOW.getTime() + 24 * HOUR),
      })
      .returning();
    // Told to a member who may not decide it (any more).
    const stale = await ask(member.id, ago(8 * HOUR), {
      kind: "approval",
      groupKey: "approval:stale",
      source: { approvalId: approval?.id },
    });
    expect(await enqueueTeamWatches(f.db, NOW)).toBe(1);
    await watch();
    // Marked without a word: it is out of that person's inbox.
    expect((await reread(stale.id)).latest.reminder).toBe(true);
    expect((await reread(stale.id)).updatedAt.getTime()).toBe(stale.updatedAt.getTime());
    // What became old after today's reminder waits for tomorrow, and asks for no check until then.
    await ask(f.owner.id, ago(3.5 * HOUR));
    expect(await anHour(new Date(NOW.getTime() + HOUR))).toBe(0);
    expect(await enqueueTeamWatches(f.db, new Date(NOW.getTime() + 24 * HOUR))).toBe(1);
  });

  test("with the switch turned off, one last check closes the rows it had open", async () => {
    f = await setup({ rightHand: true });
    await connector("Slack");
    await watch();
    expect((await rows())[0]?.doneAt).toBeNull();
    await setSwitch(false);
    expect(await enqueueTeamWatches(f.db, NOW)).toBe(1);
    await watch();
    expect((await rows())[0]?.doneAt).not.toBeNull();
    expect(await enqueueTeamWatches(f.db, new Date(NOW.getTime() + 10 * MIN))).toBe(0);
    // Back on, what was told once is not told again.
    await setSwitch(true);
    await watch(new Date(NOW.getTime() + 20 * MIN));
    expect(await rows()).toHaveLength(1);
  });
});

describe("what it tells", () => {
  test("a sign-in that ended tells its owner once, in their language, and leaves when it is back", async () => {
    f = await setup({ rightHand: true });
    const admin = await addMember(f.db, f.org.id, "admin", "bia");
    const lodi = await lodiOf();
    const accountId = await plan();
    await watch();
    await watch();
    const [row] = await rows();
    expect(await rows()).toHaveLength(1);
    expect(row).toMatchObject({
      userId: f.owner.id,
      waiting: true,
      count: 1,
      actors: [{ type: "agent", id: lodi.id }],
      source: { accountId },
      latest: {
        reason: "sign_in",
        names: ["Trabalho"],
        text: "O login de Trabalho acabou.",
      },
    });
    // A plan is its owner's alone.
    expect((await rows()).some((r) => r.userId === admin.id)).toBe(false);

    await f.db.update(schema.machineAccounts).set({ status: "active" }).where(eq(schema.machineAccounts.id, accountId));
    await watch(new Date(NOW.getTime() + 10 * MIN));
    expect((await rows())[0]?.doneAt).not.toBeNull();
    expect(f.provider.calls).toHaveLength(0);
  });

  test("put away with Feito, the same problem never returns, and a new one of that cause does", async () => {
    f = await setup({ rightHand: true });
    await connector("Slack");
    await watch();
    const [first] = await rows();
    await markNotificationDone({ db: f.db }, f.owner.id, f.org.id, first?.id ?? "", true);
    await watch(new Date(NOW.getTime() + 10 * MIN));
    await watch(new Date(NOW.getTime() + 26 * HOUR));
    expect(await rows()).toHaveLength(1);

    await connector("Notion", { updatedAt: ago(-25 * HOUR) });
    await watch(new Date(NOW.getTime() + 27 * HOUR));
    const all = await rows();
    expect(all).toHaveLength(2);
    // The new row lists what is wrong now, the one put away included: it is still to reconnect.
    expect(all.find((r) => !r.doneAt)).toMatchObject({ count: 2, latest: { names: ["Slack", "Notion"] } });
  });

  test("several of one cause are one row, rewritten in place as the list changes", async () => {
    f = await setup({ rightHand: true });
    const slack = await connector("Slack", { updatedAt: ago(3 * HOUR) });
    await connector("Notion", { updatedAt: ago(2 * HOUR) });
    await watch();
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({
      count: 2,
      // Two of them: the sentence is said in the plural.
      latest: { text: "Slack e Notion precisam ser reconectados." },
    });

    await connector("Linear", { updatedAt: ago(HOUR) });
    await connector("Sentry", { updatedAt: ago(HOUR) });
    await f.db.update(schema.notifications).set({ readAt: NOW }).where(eq(schema.notifications.kind, "team_watch"));
    await watch(new Date(NOW.getTime() + 10 * MIN));
    const [grown] = await rows();
    expect(await rows()).toHaveLength(1);
    // Something new in it: unread again, with no second row.
    expect(grown).toMatchObject({ count: 4, readAt: null, latest: { names: ["Slack", "Notion", "Linear"] } });
    expect(String(grown?.latest.text)).toContain("Slack, Notion, Linear e mais 1");

    await f.db
      .update(schema.connectorConnections)
      .set({ status: "active" })
      .where(eq(schema.connectorConnections.id, slack.id));
    await watch(new Date(NOW.getTime() + 20 * MIN));
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ count: 3, doneAt: null });
    // A list in the person's language, the ones it does not name counted in words.
    expect(teamWatchNames(["a", "b", "c", "d", "e"], "en")).toBe("a, b, c, and 2 more");
    expect(teamWatchNames(["a", "b"], "pt-BR")).toBe("a e b");
  });

  test("a new problem joins the open row at once, and brings it back unread only once it lasted", async () => {
    f = await setup({ rightHand: true });
    await connector("Slack");
    await watch();
    await f.db.update(schema.notifications).set({ readAt: NOW }).where(eq(schema.notifications.kind, "team_watch"));
    const broke = new Date(NOW.getTime() + 5 * MIN);
    await connector("Notion", { updatedAt: broke });
    await watch(new Date(NOW.getTime() + 10 * MIN));
    expect((await rows())[0]).toMatchObject({ count: 2, latest: { names: ["Slack", "Notion"] } });
    expect((await rows())[0]?.readAt).not.toBeNull();
    await watch(new Date(NOW.getTime() + 30 * MIN));
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ count: 2, readAt: null });
  });

  test("what was wrong for over a week when it first looked is nobody's news: the day it starts tells none of it", async () => {
    f = await setup({ rightHand: true, budgetNanoUsd: 10_000_000_000 });
    const WEEKS = 30 * 24 * HOUR;
    await connector("Slack", { updatedAt: ago(WEEKS) });
    await plan({ lastUsedAt: ago(WEEKS), updatedAt: ago(WEEKS), createdAt: ago(2 * WEEKS) });
    await f.db.insert(schema.mailAccounts).values({
      orgId: f.org.id,
      provider: "imap",
      via: "imap",
      address: "ana@example.com",
      status: "needs_reconnect",
      createdByUserId: f.owner.id,
      updatedAt: ago(WEEKS),
    });
    await watch();
    expect(await rows()).toEqual([]);
    expect(await pushes()).toBe(0);
    // Later looks do not tell it either.
    await watch(new Date(NOW.getTime() + 24 * HOUR));
    expect(await rows()).toEqual([]);

    // A budget used up is of the month it is in: told, whenever the month began.
    await spend(f.agent.id, 10_000_000_000);
    await watch();
    expect((await rows()).map((r) => r.latest.reason)).toEqual(["budget_out"]);

    // Once a row of its cause is open for something new, the old one is listed in it.
    await connector("Notion");
    await watch();
    const apps = (await rows()).find((r) => r.latest.reason === "connector");
    expect(apps).toMatchObject({ count: 2, latest: { names: ["Slack", "Notion"] } });
  });

  test("a connector goes to who connected it while they manage connectors, else to who does", async () => {
    f = await setup({ rightHand: true });
    const member = await addMember(f.db, f.org.id, "member", "caio");
    await connector("Slack", { createdByUserId: member.id });
    await connector("Banco", { createdByUserId: null });
    await watch();
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ userId: f.owner.id, count: 2 });
  });

  test("a mailbox reaches only its owner, and one nobody owns reaches nobody", async () => {
    f = await setup({ rightHand: true });
    const member = await addMember(f.db, f.org.id, "member", "caio");
    await addMember(f.db, f.org.id, "admin", "bia");
    const mailbox = {
      orgId: f.org.id,
      provider: "imap",
      via: "imap",
      status: "needs_reconnect",
      updatedAt: ago(HOUR),
    };
    await f.db.insert(schema.mailAccounts).values([
      { ...mailbox, address: "caio@example.com", createdByUserId: member.id },
      { ...mailbox, address: "suporte@example.com", createdByUserId: null },
    ]);
    await watch();
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ userId: member.id, latest: { reason: "mailbox", names: ["caio@example.com"] } });
  });

  test("a database to reconnect is told to who manages connectors", async () => {
    f = await setup({ rightHand: true });
    await database();
    await watch();
    expect((await rows())[0]).toMatchObject({ userId: f.owner.id, waiting: true, latest: { reason: "database" } });
  });

  test("a budget used up waits on who may raise it. One about to end is a plain row, only on pace to end early", async () => {
    f = await setup({ rightHand: true, budgetNanoUsd: 10_000_000_000 });
    const member = await addMember(f.db, f.org.id, "member", "caio");
    // Its owner may not raise a budget: the workspace's owner hears it.
    await f.db.update(schema.agents).set({ ownerUserId: member.id }).where(eq(schema.agents.id, f.agent.id));
    await spend(f.agent.id, 8_500_000_000);
    await watch();
    const [low] = await rows();
    expect(low).toMatchObject({
      userId: f.owner.id,
      waiting: false,
      source: { agentId: f.agent.id },
      latest: { reason: "budget_low", names: ["Dev"] },
    });

    await f.db.update(schema.agentBudgetPeriods).set({ spentNanoUsd: 10_000_000_000 });
    await watch(new Date(NOW.getTime() + 10 * MIN));
    const all = await rows();
    expect(all.find((r) => r.id === low?.id)?.doneAt).not.toBeNull();
    expect(all.find((r) => !r.doneAt)).toMatchObject({ waiting: true, latest: { reason: "budget_out" } });
    // It raises nothing itself.
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(agent?.monthlyBudgetNanoUsd).toBe(10_000_000_000);
  });

  test("85% of a budget on the 29th tells nobody", async () => {
    f = await setup({ rightHand: true, budgetNanoUsd: 10_000_000_000 });
    const late = new Date("2026-11-29T15:00:00Z");
    await spend(f.agent.id, 8_500_000_000, late);
    await watch(late);
    expect(await rows()).toHaveLength(0);
  });

  test("a brought computer gone with a run waiting is told to who paired it. Idle, or the workspace's own, is not", async () => {
    f = await setup({ rightHand: true });
    const idle = await computer({ name: "Ocioso" });
    const own = await computer({ name: "Da casa", kind: "managed" });
    const mac = await computer();
    await watch();
    expect(await rows()).toHaveLength(0);

    const run = {
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      triggerMessageId: crypto.randomUUID(),
      threadRootId: crypto.randomUUID(),
      trigger: "mention" as const,
      hop: 0,
    };
    await f.db.insert(schema.agentRuns).values([
      { ...run, waitingMachineId: mac.id },
      { ...run, triggerMessageId: crypto.randomUUID(), waitingMachineId: own.id },
    ]);
    expect(idle.id).not.toBe(mac.id);
    await watch();
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      userId: f.owner.id,
      source: { machineId: mac.id },
      latest: { reason: "computer", names: ["Mac da Ana"] },
    });
    // Under half an hour gone tells nobody.
    await f.db.update(schema.notifications).set({ doneAt: NOW }).where(eq(schema.notifications.kind, "team_watch"));
    const blip = await computer({ name: "Piscou", lastSeenAt: ago(10 * MIN) });
    await f.db
      .insert(schema.agentRuns)
      .values({ ...run, triggerMessageId: crypto.randomUUID(), waitingMachineId: blip.id });
    await watch(new Date(NOW.getTime() + MIN));
    expect((await rows()).filter((r) => !r.doneAt)).toHaveLength(0);
  });

  test("what another notice already told the person gets no second row, now or later", async () => {
    f = await setup({ rightHand: true });
    const accountId = await plan();
    await f.db.update(schema.agents).set({ brainAccountId: accountId }).where(eq(schema.agents.id, f.agent.id));
    await runFailed(f.agent.id, "not_logged_in");
    await watch();
    expect(await rows()).toHaveLength(0);
    // That notice gone, the same sign-in is still not told twice.
    await f.db.delete(schema.notifications);
    await watch(new Date(NOW.getTime() + 10 * MIN));
    expect(await rows()).toHaveLength(0);
  });

  test("a routine that failed for want of the sign-in already told it", async () => {
    f = await setup({ rightHand: true });
    const accountId = await plan();
    await f.db.update(schema.agents).set({ brainAccountId: accountId }).where(eq(schema.agents.id, f.agent.id));
    await f.db.insert(schema.notifications).values({
      orgId: f.org.id,
      userId: f.owner.id,
      kind: "routine_failed",
      groupKey: "routine_failed:x",
      actors: [{ type: "agent", id: f.agent.id }],
      latest: { reason: "not_logged_in" },
      createdAt: ago(5 * MIN),
      updatedAt: ago(5 * MIN),
    });
    await watch();
    expect(await rows()).toHaveLength(0);
  });

  test("a budget's end or a computer's absence another notice told is not told again", async () => {
    f = await setup({ rightHand: true, budgetNanoUsd: 10_000_000_000 });
    await spend(f.agent.id, 10_000_000_000);
    const mac = await computer();
    await waitingRun(mac.id);
    const told = { orgId: f.org.id, userId: f.owner.id, createdAt: ago(30 * MIN), updatedAt: ago(30 * MIN) };
    await f.db.insert(schema.notifications).values([
      {
        ...told,
        kind: "routine_failed",
        groupKey: "routine_failed:x",
        actors: [{ type: "agent", id: f.agent.id }],
        latest: { reason: "budget_exceeded" },
      },
      { ...told, kind: "routine_stalled", groupKey: "routine_stalled:x", source: { machineId: mac.id } },
    ]);
    await watch();
    expect(await rows()).toHaveLength(0);
  });

  test("another notice hides only its own thing: another agent's budget, plan or computer is still told", async () => {
    f = await setup({ rightHand: true, budgetNanoUsd: 10_000_000_000 });
    const lodi = await lodiOf();
    // An earlier notice about another agent (the right hand itself), with nothing wrong on it now.
    await runFailed(lodi.id, "budget_exceeded");
    await runFailed(lodi.id, "not_logged_in");
    const other = await computer({ name: "Outro" });
    await f.db.insert(schema.notifications).values({
      orgId: f.org.id,
      userId: f.owner.id,
      kind: "device.waiting",
      groupKey: "device-waiting:x",
      source: { machineId: other.id },
      createdAt: ago(30 * MIN),
      updatedAt: ago(30 * MIN),
    });
    await spend(f.agent.id, 10_000_000_000);
    const accountId = await plan();
    await f.db.update(schema.agents).set({ brainAccountId: accountId }).where(eq(schema.agents.id, f.agent.id));
    const mac = await computer();
    await waitingRun(mac.id);
    await watch();
    expect((await rows()).map((r) => r.latest.reason).sort()).toEqual(["budget_out", "computer", "sign_in"]);
  });

  test("when the other notice comes second, the right hand's own row leaves", async () => {
    f = await setup({ rightHand: true });
    const accountId = await plan();
    await f.db.update(schema.agents).set({ brainAccountId: accountId }).where(eq(schema.agents.id, f.agent.id));
    await watch();
    expect((await rows())[0]?.doneAt).toBeNull();
    await runFailed(f.agent.id, "not_logged_in", new Date(NOW.getTime() + 5 * MIN));
    await watch(new Date(NOW.getTime() + 10 * MIN));
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]?.doneAt).not.toBeNull();
  });

  test("a row stays while its thing is wrong, whatever else moves on it, and is never told twice", async () => {
    f = await setup({ rightHand: true });
    await registerPushDevice(f.db, f.owner.id, {
      token: "ExponentPushToken[ana-phone-0001]",
      platform: "ios",
      locale: "pt-BR",
    });
    const accountId = await plan();
    const slack = await connector("Slack");
    await watch();
    expect(await rows()).toHaveLength(2);
    expect(await pushes()).toBe(2);
    // A usage report of its computer rewrites a plan's row, and a rename an app's: both as wrong as before.
    for (let i = 1; i <= 12; i++) {
      const at = new Date(NOW.getTime() + i * 10 * MIN);
      await f.db.update(schema.machineAccounts).set({ updatedAt: at }).where(eq(schema.machineAccounts.id, accountId));
      if (i === 1)
        await f.db
          .update(schema.connectorConnections)
          .set({ updatedAt: at })
          .where(eq(schema.connectorConnections.id, slack.id));
      await watch(at);
    }
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all.every((r) => r.doneAt === null)).toBe(true);
    expect(await pushes()).toBe(2);

    // Put away while still signed out, the plan's notice does not come back with the next report either.
    const signIn = all.find((r) => r.latest.reason === "sign_in");
    await markNotificationDone({ db: f.db }, f.owner.id, f.org.id, signIn?.id ?? "", true);
    const later = new Date(NOW.getTime() + 3 * HOUR);
    await f.db.update(schema.machineAccounts).set({ updatedAt: later }).where(eq(schema.machineAccounts.id, accountId));
    await watch(new Date(later.getTime() + HOUR));
    expect(await rows()).toHaveLength(2);
    expect(await pushes()).toBe(2);
  });

  test("a plan on a busy computer is told though its row never rests, and again when it ends after working", async () => {
    f = await setup({ rightHand: true });
    // Its row moved a minute ago, its last turn an hour ago.
    const accountId = await plan({ updatedAt: ago(MIN) });
    await watch();
    expect(await rows()).toHaveLength(1);
    // Signed out a moment after a turn: a blip tells nobody yet.
    const again = new Date(NOW.getTime() + 5 * HOUR);
    await f.db
      .update(schema.machineAccounts)
      .set({ status: "active", lastUsedAt: again })
      .where(eq(schema.machineAccounts.id, accountId));
    await watch(again);
    expect((await rows())[0]?.doneAt).not.toBeNull();
    await f.db
      .update(schema.machineAccounts)
      .set({ status: "signed_out" })
      .where(eq(schema.machineAccounts.id, accountId));
    await watch(new Date(again.getTime() + 10 * MIN));
    expect(await rows()).toHaveLength(1);
    await watch(new Date(again.getTime() + 30 * MIN));
    expect(await rows()).toHaveLength(2);
  });

  test("at most three new rows a person a day, the rest told on a later day", async () => {
    f = await setup({ rightHand: true, budgetNanoUsd: 10_000_000_000 });
    await plan();
    await connector("Slack");
    await spend(f.agent.id, 10_000_000_000);
    await database();
    await watch();
    await watch(new Date(NOW.getTime() + 10 * MIN));
    expect(await rows()).toHaveLength(TEAM_WATCH_DAILY_ROWS);
    await watch(new Date(NOW.getTime() + 25 * HOUR));
    expect(await rows()).toHaveLength(4);
  });

  test("with the switch off the job tells nothing", async () => {
    f = await setup({ rightHand: true });
    await connector("Slack");
    await setSwitch(false);
    await watch();
    expect(await rows()).toHaveLength(0);
  });
});

describe("what it fixes", () => {
  const DOWN = "provider_error: down@Claude: 529 overloaded";
  const ledger = () => ({ db: f.db, pubsub: f.pubsub });
  /** One run of the routine that fails with `error`, as a failed run leaves it. */
  const failRun = async (routineRunId: string, error: string) => {
    const rr = await routineRunRow(f, routineRunId);
    const run = await agentRunRow(f, rr.agentRunId);
    await f.db.update(schema.agentRuns).set({ status: "failed", error }).where(eq(schema.agentRuns.id, run.id));
    await closeRoutineRun(ledger(), run, { status: "failed", ...routineFailureEnd(error) });
  };
  const failOnce = async (routineId: string, minutesAgo: number, error: string) =>
    failRun((await fire(f, routineId, minutesFromNow(-minutesAgo))).id, error);
  const slotIn = (routineId: string, minutes: number) =>
    f.db
      .update(schema.routines)
      .set({ nextRunAt: minutesFromNow(minutes) })
      .where(eq(schema.routines.id, routineId));
  const farSlot = (routineId: string) => slotIn(routineId, 5 * 60);

  test("which failures are outside the routine", () => {
    for (const error of [
      DOWN,
      "provider_error: timeout@Claude: no answer",
      "provider_error: unreachable@Claude: ECONNRESET",
      "provider_error: rate_limit@Claude: 429",
      "gave_up: still down",
      "timeout",
      "runner_error",
      "brain_interrupted: cut",
      "Interrupted by a server restart",
    ])
      expect([error, outsideRoutineFailure("provider_error", error)]).toEqual([error, true]);
    expect(outsideRoutineFailure("lost", null)).toBe(true);
    for (const error of [
      "provider_error: invalid_key@Claude: refused",
      "provider_error: no_credit@Claude: out of credit",
      "budget_exceeded",
      "too_many_tool_calls",
      "empty_reply",
      "agent_archived",
      "no_ai",
      null,
    ])
      expect([error, outsideRoutineFailure("error", error)]).toEqual([error, false]);
    expect(OUTSIDE_RUN_ERRORS.size).toBeGreaterThan(1);
  });

  test("a first outside failure is tried once more before anyone is told, and told when that fails too", async () => {
    f = await setup({ rightHand: true });
    const routine = await channelRoutine(f);
    await farSlot(routine.id);
    await failOnce(routine.id, 30, DOWN);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(0);
    const queued = (await f.db.select().from(schema.routineRuns)).filter((r) => r.status === "queued");
    expect(queued).toHaveLength(1);
    const retry = queued[0];
    const wait = (retry?.at.getTime() ?? 0) - Date.now();
    expect(wait).toBeGreaterThan(ROUTINE_RETRY_AFTER_MS - MIN);
    expect(wait).toBeLessThanOrEqual(ROUTINE_RETRY_AFTER_MS);
    const [job] = await f.db
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.dedupeKey, `routine.run:${retry?.id}`));
    expect(job?.nextAttemptAt.getTime()).toBe(retry?.at.getTime());

    await executeRoutineRun(routineDeps(f), retry?.id ?? "");
    await failRun(retry?.id ?? "", DOWN);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(1);
    // Once between two good runs: the next failures queue nothing and tell nothing more.
    await failOnce(routine.id, 20, DOWN);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(1);
    expect((await f.db.select().from(schema.routineRuns)).filter((r) => r.status === "queued")).toHaveLength(0);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("a failure of the routine's own, a close slot or the switch off is told at once, with no retry", async () => {
    f = await setup({ rightHand: true });
    const own = await channelRoutine(f, { name: "Própria" });
    await farSlot(own.id);
    await failOnce(own.id, 30, "provider_error: invalid_key@Claude: refused");
    const close = await channelRoutine(f, { name: "Perto" });
    await slotIn(close.id, 30);
    await failOnce(close.id, 30, DOWN);
    await setSwitch(false);
    const off = await channelRoutine(f, { name: "Desligada" });
    await farSlot(off.id);
    await failOnce(off.id, 30, DOWN);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(3);
    expect((await f.db.select().from(schema.routineRuns)).filter((r) => r.status === "queued")).toHaveLength(0);
  });

  test("a routine paused for outside causes is resumed once, silently. Paused again, it stays", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf();
    const routine = await channelRoutine(f);
    // Its next slot is close, so the slot itself is the retry and the first failure is told as always.
    await slotIn(routine.id, 30);
    for (const minutesAgo of [50, 40, 30, 20, 10]) await failOnce(routine.id, minutesAgo, DOWN);
    expect(await routineRow(f, routine.id)).toMatchObject({ active: false, pausedReason: "failing" });
    expect(await notificationsOf(f, "routine_paused")).toHaveLength(1);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(1);

    // Too soon after the pause: an outage needs time to pass.
    await watch(new Date(Date.now() + 5 * MIN));
    expect((await routineRow(f, routine.id)).active).toBe(false);

    await watch(new Date(Date.now() + 45 * MIN));
    const resumed = await routineRow(f, routine.id);
    expect(resumed).toMatchObject({ active: true, pausedReason: null, failuresInRow: 0 });
    expect(resumed.nextRunAt).not.toBeNull();
    const audit = (await f.db.select().from(schema.auditLog)).filter((a) => a.action === "routine.resumed");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: "agent", actorId: lodi.id, targetId: routine.id });
    expect((await notificationsOf(f, "routine_paused"))[0]?.doneAt).not.toBeNull();
    // What it fixed is said to nobody.
    expect(await rows()).toHaveLength(0);

    await slotIn(routine.id, 30);
    for (const minutesAgo of [9, 8, 7, 6, 5]) await failOnce(routine.id, minutesAgo, DOWN);
    expect((await routineRow(f, routine.id)).active).toBe(false);
    await watch(new Date(Date.now() + 45 * MIN));
    expect((await routineRow(f, routine.id)).active).toBe(false);
    // The resume did not hold: its first failure says so, once, then the pause.
    expect(await notificationsOf(f, "routine_paused")).toHaveLength(2);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(2);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("after its resume, a routine that fails for its own reasons is told at the first failure, each time", async () => {
    f = await setup({ rightHand: true });
    const routine = await channelRoutine(f);
    await slotIn(routine.id, 30);
    for (const minutesAgo of [50, 40, 30, 20, 10]) await failOnce(routine.id, minutesAgo, DOWN);
    await watch(new Date(Date.now() + 45 * MIN));
    expect((await routineRow(f, routine.id)).active).toBe(true);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(1);

    await slotIn(routine.id, 30);
    await failOnce(routine.id, 9, "provider_error: invalid_key@Claude: refused");
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(2);
    for (const minutesAgo of [8, 7, 6, 5]) await failOnce(routine.id, minutesAgo, "too_many_tool_calls");
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(2);
    // The person turns it back on (what their own resume writes), and it fails again: told again.
    await f.db
      .update(schema.routines)
      .set({ active: true, pausedReason: null, failuresInRow: 0, nextRunAt: minutesFromNow(30) })
      .where(eq(schema.routines.id, routine.id));
    await failOnce(routine.id, 4, "too_many_tool_calls");
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(3);
  });

  test("a failure held for a retry that never ran is told at the streak's next failure, once", async () => {
    f = await setup({ rightHand: true });
    const routine = await channelRoutine(f);
    await farSlot(routine.id);
    await failOnce(routine.id, 30, DOWN);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(0);
    const [retry] = (await f.db.select().from(schema.routineRuns)).filter((r) => r.status === "queued");
    // The workspace is on hold at the retry's time: its slot passes.
    const standing = (to: "active" | "hold") =>
      f.db.update(schema.organizations).set({ standing: to }).where(eq(schema.organizations.id, f.org.id));
    await standing("hold");
    await executeRoutineRun(routineDeps(f), retry?.id ?? "");
    expect((await routineRunRow(f, retry?.id ?? "")).status).toBe("skipped");
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(0);
    await standing("active");
    await failOnce(routine.id, 5, DOWN);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(1);
    await failOnce(routine.id, 4, DOWN);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(1);
  });

  test("Rodar agora while a retry waits runs now, the retry gives way, and its failure tells the held one", async () => {
    f = await setup({ rightHand: true });
    const routine = await channelRoutine(f);
    await farSlot(routine.id);
    await failOnce(routine.id, 30, DOWN);
    const [retry] = (await f.db.select().from(schema.routineRuns)).filter((r) => r.status === "queued");
    await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
    expect(await routineRunRow(f, retry?.id ?? "")).toMatchObject({ status: "superseded", code: "superseded" });
    const [manual] = (await f.db.select().from(schema.routineRuns)).filter((r) => r.status === "queued");
    expect(manual?.trigger).toBe("manual");
    await executeRoutineRun(routineDeps(f), manual?.id ?? "");
    expect((await routineRunRow(f, manual?.id ?? "")).status).toBe("started");
    await failRun(manual?.id ?? "", DOWN);
    expect(await notificationsOf(f, "routine_failed")).toHaveLength(1);
    // The retry's own job finds nothing to run.
    await executeRoutineRun(routineDeps(f), retry?.id ?? "");
    expect((await routineRunRow(f, retry?.id ?? "")).status).toBe("superseded");
    expect(f.provider.calls).toHaveLength(0);
  });

  test("a routine failing for its own reasons, or one paused for another reason, is left paused", async () => {
    f = await setup({ rightHand: true });
    const own = await channelRoutine(f);
    await slotIn(own.id, 30);
    for (const minutesAgo of [50, 40, 30, 20]) await failOnce(own.id, minutesAgo, DOWN);
    await failOnce(own.id, 10, "too_many_tool_calls");
    const left = await channelRoutine(f, { name: "Saiu" });
    await f.db
      .update(schema.routines)
      .set({ active: false, nextRunAt: null, pausedReason: "creator_left" })
      .where(eq(schema.routines.id, left.id));
    await watch(new Date(Date.now() + 45 * MIN));
    expect(await routineRow(f, own.id)).toMatchObject({ active: false, pausedReason: "failing" });
    expect(await routineRow(f, left.id)).toMatchObject({ active: false, pausedReason: "creator_left" });
  });
});

describe("what it reminds of", () => {
  test("one reminder a day for everything left unread, never the same thing twice", async () => {
    f = await setup({ rightHand: true });
    const oldest = await ask(f.owner.id, ago(8 * HOUR));
    const other = await ask(f.owner.id, ago(5 * HOUR), { kind: "secret_request", groupKey: "secret:1" });
    const read = await ask(f.owner.id, ago(6 * HOUR), { readAt: ago(HOUR) });
    const recent = await ask(f.owner.id, ago(HOUR));
    await watch();
    expect((await reread(oldest.id)).latest).toMatchObject({ reminder: true, still: 2 });
    expect((await reread(oldest.id)).updatedAt.getTime()).toBe(NOW.getTime());
    // Reminded with the first one: marked, not moved, so no second push.
    expect((await reread(other.id)).latest.reminder).toBe(true);
    expect((await reread(other.id)).updatedAt.getTime()).toBe(other.updatedAt.getTime());
    expect((await reread(read.id)).latest.reminder).toBeUndefined();
    expect((await reread(read.id)).readAt).not.toBeNull();
    expect((await reread(recent.id)).latest.reminder).toBeUndefined();

    // Later the same day what became old waits for tomorrow, and yesterday's are not said again.
    const later = new Date(NOW.getTime() + 3.5 * HOUR);
    await watch(later);
    expect((await reread(recent.id)).latest.reminder).toBeUndefined();
    const tomorrow = new Date(NOW.getTime() + 24 * HOUR);
    await watch(tomorrow);
    expect((await reread(recent.id)).latest).toMatchObject({ reminder: true, still: 1 });
    expect((await reread(oldest.id)).updatedAt.getTime()).toBe(NOW.getTime());
    expect(f.provider.calls).toHaveLength(0);
  });

  test("nothing at night in the person's own time zone", async () => {
    f = await setup({ rightHand: true });
    await f.db
      .update(schema.organizationMembers)
      .set({ timezone: "Asia/Tokyo" })
      .where(eq(schema.organizationMembers.userId, f.owner.id));
    const row = await ask(f.owner.id, ago(8 * HOUR));
    await watch();
    expect((await reread(row.id)).latest.reminder).toBeUndefined();
    // 01:00 UTC is 10:00 in Tokyo.
    await watch(new Date("2026-11-12T01:00:00Z"));
    expect((await reread(row.id)).latest.reminder).toBe(true);
  });

  test("one push a day, to the person alone, and only for what they have not read", async () => {
    f = await setup({ rightHand: true });
    const admin = await addMember(f.db, f.org.id, "admin", "bia");
    for (const user of [f.owner, admin])
      await registerPushDevice(f.db, user.id, {
        token: `ExponentPushToken[${user.id.slice(0, 8)}-phone-01]`,
        platform: "ios",
        locale: "pt-BR",
      });
    // One ask told to both: the owner left it unread, the admin read it.
    const mine = await ask(f.owner.id, ago(8 * HOUR), { groupKey: "agent_question:shared" });
    const theirs = await ask(admin.id, ago(8 * HOUR), { groupKey: "agent_question:shared", readAt: ago(HOUR) });
    await ask(f.owner.id, ago(6 * HOUR));
    await ask(f.owner.id, ago(5 * HOUR));
    await watch();
    await watch(new Date(NOW.getTime() + 10 * MIN));
    await watch(new Date(NOW.getTime() + 2 * HOUR));
    expect(await pushes()).toBe(1);
    expect((await reread(mine.id)).latest).toMatchObject({ reminder: true, still: 3 });
    expect((await reread(theirs.id)).readAt).not.toBeNull();
    expect((await reread(theirs.id)).latest.reminder).toBeUndefined();

    // The helper itself: with `to`, a group's rows of other people and read rows stay as they are.
    const again = await remindNotifications(
      { db: f.db, pubsub: f.pubsub, now: () => NOW },
      f.org.id,
      "agent_question:shared",
      { reminder: true },
      "test",
      [admin.id],
    );
    expect(again).toBe(0);
    expect(await pushes()).toBe(1);
  });

  /** Approvals waiting on `userId` since before anything summed them up, each with its row in their inbox. */
  const oldApprovals = async (userId: string, count = 3) => {
    const approvals = await f.db
      .insert(schema.approvals)
      .values(
        Array.from({ length: count }, (_, i) => i + 1).map((n) => ({
          orgId: f.org.id,
          agentId: f.agent.id,
          channelId: f.general.id,
          threadRootId: crypto.randomUUID(),
          toolUseId: `tool-${userId}-${n}`,
          tool: "github_merge",
          scope: "github:pr.merge",
          params: { pr: n },
          actionHash: `hash-${userId}-${n}`,
          title: `Merge PR #${n}`,
          ownerUserId: userId,
          expiresAt: new Date(NOW.getTime() + 24 * HOUR),
        })),
      )
      .returning();
    const asked = [];
    for (const [i, a] of approvals.entries())
      asked.push(
        await ask(userId, ago((8 - i) * HOUR), {
          kind: "approval",
          groupKey: `approval:${a.id}`,
          source: { approvalId: a.id },
        }),
      );
    return { approvals, asked };
  };
  const digestJobs = async () =>
    (await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, APPROVALS_DIGEST_JOB))).length;
  const lodiSaid = async () =>
    f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.authorAgentId, (await lodiOf()).id));

  test("approvals nobody summed up yet get their digest card from the reminder, and no ring. The rest is still reminded", async () => {
    f = await setup({ rightHand: true });
    const { approvals, asked } = await oldApprovals(f.owner.id);
    const question = await ask(f.owner.id, ago(5 * HOUR));
    // They came before the digest existed: no job of it was ever queued for this person.
    expect(await digestJobs()).toBe(0);
    await watch();
    const [card, ...more] = await lodiSaid();
    expect(more).toEqual([]);
    expect(card?.meta.actionCard).toMatchObject({
      kind: "approvals",
      forUserId: f.owner.id,
      params: { approvalIds: approvals.map((a) => a.id), digest: true },
    });
    for (const a of asked) {
      const row = await reread(a.id);
      expect(row.latest.reminder).toBe(true);
      expect(row.latest.still).toBeUndefined();
      expect(row.updatedAt.getTime()).toBe(a.updatedAt.getTime());
    }
    expect((await reread(question.id)).latest).toMatchObject({ reminder: true, still: 1 });
    // The lane is as it was for whatever runs next.
    expect(approvalsDigestLane.live).toBe(true);
    // The next looks add no second card.
    await watch(new Date(NOW.getTime() + 24 * HOUR));
    expect(await lodiSaid()).toHaveLength(1);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("with no digest card to yield to, approvals are reminded like any other ask", async () => {
    f = await setup({ rightHand: true });
    await registerPushDevice(f.db, f.owner.id, {
      token: `ExponentPushToken[${f.owner.id.slice(0, 8)}-phone-01]`,
      platform: "ios",
      locale: "pt-BR",
    });
    // The right hand may not write to this person: its digest never comes for them.
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await f.db
      .update(schema.agents)
      .set({ audienceMode: "owner", ownerUserId: f.owner.id })
      .where(eq(schema.agents.id, (await lodiOf()).id));
    const theirs = await oldApprovals(bia.id);
    // Two waiting: under what the digest sums up.
    const few = (await oldApprovals(f.owner.id, 2)).asked;
    await watch();
    expect(await lodiSaid()).toEqual([]);
    expect((await reread(theirs.asked[0]?.id ?? "")).latest).toMatchObject({ reminder: true, still: 3 });
    expect((await reread(theirs.asked[0]?.id ?? "")).updatedAt.getTime()).toBe(NOW.getTime());
    expect((await reread(theirs.asked[1]?.id ?? "")).latest.reminder).toBe(true);
    expect((await reread(few[0]?.id ?? "")).latest).toMatchObject({ reminder: true, still: 2 });
    expect(await pushes()).toBe(1);
  });

  test("an ask older than a week when it is first looked at is left alone: no reminder on the day it starts", async () => {
    f = await setup({ rightHand: true });
    const old = await ask(f.owner.id, ago(30 * 24 * HOUR));
    expect(await enqueueTeamWatches(f.db, NOW)).toBe(0);
    await watch();
    expect((await reread(old.id)).latest.reminder).toBeUndefined();
    // One of this week beside it is reminded alone, and counts alone.
    const week = await ask(f.owner.id, ago(3 * 24 * HOUR));
    expect(await enqueueTeamWatches(f.db, NOW)).toBe(1);
    await watch();
    expect((await reread(week.id)).latest).toMatchObject({ reminder: true, still: 1 });
    expect((await reread(old.id)).latest.reminder).toBeUndefined();
  });

  test("a reminded item snoozed and back says its own line, not that day's count", async () => {
    f = await setup({ rightHand: true });
    const row = await ask(f.owner.id, ago(8 * HOUR));
    await ask(f.owner.id, ago(6 * HOUR));
    await watch();
    expect((await reread(row.id)).latest.still).toBe(2);
    await f.db
      .update(schema.notifications)
      .set({ snoozedUntil: new Date(Date.now() - MIN) })
      .where(eq(schema.notifications.id, row.id));
    await wakeSnoozedNotifications({ db: f.db, pubsub: f.pubsub });
    const woke = await reread(row.id);
    expect(woke.latest.still).toBeUndefined();
    expect(woke.latest.reminder).toBe(true);
  });

  test("a reminder's push says how many things wait, and a notice's push is its whole sentence", () => {
    const reminder = renderPush("en", {
      kind: "agent_question",
      waiting: true,
      actorName: "Dev",
      actorType: "agent",
      text: "Which one?",
      still: 3,
    });
    expect(reminder.title).toBe("3 things still wait on you");
    expect(reminder.body).toContain("Dev");
    expect(renderPush("pt-BR", { kind: "agent_question", waiting: true, still: 1 }).title).toBe(
      "1 coisa ainda espera você",
    );
    expect(
      renderPush("en", {
        kind: "team_watch",
        waiting: true,
        actorName: "Lodi",
        actorType: "agent",
        text: "The sign-in for Work ended.",
      }),
    ).toEqual({ title: "Lodi", body: "The sign-in for Work ended." });
  });
});
