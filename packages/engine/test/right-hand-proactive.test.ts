import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, inArray, rowsOf, schema, sql } from "@agenteschat/db";
import {
  createSetupToolSource,
  createToolGateway,
  dueTeamWeeks,
  enqueue,
  enqueueRightHandChecks,
  enqueueTeamWeeks,
  findWorkspaceActions,
  getLodiPrefs,
  getOrgSettings,
  type JobDeps,
  LODI_PREFS_DEFAULTS,
  type LodiLane,
  type LodiPrefs,
  lastTeamWeekSlot,
  legacyTeamWeek,
  liveLodiSwitches,
  lodiFor,
  lodiLaneHandlers,
  lodiLanes,
  lodiPrefsOf,
  lodiPrefsSql,
  lodiPromptBlocks,
  lodiSwitches,
  nearTeamWeeks,
  openPersonAgentDm,
  ownCardsLine,
  patchLodiPrefs,
  postFromLodi,
  postPersonMessage,
  postTeamWeek,
  RIGHT_HAND,
  readLodiPrefs,
  reportLodiLaneErrors,
  rightHandPrompt,
  SET_TEAM_WEEK_TOOL,
  saidKey,
  saidOnce,
  setCardOnMessage,
  setLodiPrefs,
  TEAM_DAY_JOB,
  TEAM_WEEK_JOB,
  updateOrgSettings,
  workspaceAction,
} from "../src";
import { approvalsDigestLane } from "../src/approvals-digest";
import { teamWatchLane } from "../src/team-watch";
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
/** Friday 2026-11-06, 09:00 and 17:00 in São Paulo (UTC-3). */
const NINE = new Date("2026-11-06T12:00:00Z");
const FIVE = new Date("2026-11-06T20:00:00Z");

const lodiOf = async (fx: Fixture) => {
  const [lodi] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

const inZone = (fx: Fixture, timezone = ZONE) =>
  fx.db
    .insert(schema.organizationSettings)
    .values({ orgId: fx.org.id, timezone })
    .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: { timezone } });

const store = (fx: Fixture, userId: string, teamWeek: Record<string, unknown>) =>
  fx.db
    .update(schema.organizationMembers)
    .set({ teamWeek })
    .where(and(eq(schema.organizationMembers.orgId, fx.org.id), eq(schema.organizationMembers.userId, userId)));

const stored = async (fx: Fixture, userId: string) =>
  (
    await fx.db
      .select({ teamWeek: schema.organizationMembers.teamWeek })
      .from(schema.organizationMembers)
      .where(and(eq(schema.organizationMembers.orgId, fx.org.id), eq(schema.organizationMembers.userId, userId)))
  )[0]?.teamWeek;

const cardJobs = async (fx: Fixture) =>
  (
    await fx.db
      .select()
      .from(schema.outbox)
      .where(inArray(schema.outbox.kind, [TEAM_WEEK_JOB, TEAM_DAY_JOB]))
  ).map((j) => j.payload as { userId: string; period: string; slot: string });

/** A lane as it is once its feature is built, for the time of `run`. */
async function built<T>(lane: LodiLane, run: () => Promise<T>): Promise<T> {
  const was = lane.live;
  lane.live = true;
  try {
    return await run();
  } finally {
    lane.live = was;
  }
}

/** What rows saved before the day's and the week's cards were told apart may hold, and a few that never were. */
const SHAPES: Record<string, unknown>[] = [
  {},
  { off: true, day: 5, hour: 17, daily: false },
  { off: false, day: 3, hour: 10, daily: false },
  { off: false, day: 5, hour: 9, daily: true },
  { off: true, day: 5, hour: 9, daily: true },
  { daily: true },
  { off: "yes", day: 9, hour: -1, dayHour: 7.5 },
  { weekOff: true, dayOff: false, dayHour: 7, weekHour: 8, day: 1, off: false, daily: true, hour: 7 },
  { dayOff: true, digestOff: true, remindOff: true },
  { off: true, daily: false, digestOff: false },
  { off: false, daily: false, remindOff: true },
];

describe("a person's choice", () => {
  test("nothing stored: the day's card at 9h and the week's on Friday at 17h, everything on", () => {
    expect(lodiPrefsOf({})).toEqual(LODI_PREFS_DEFAULTS);
    expect(lodiPrefsOf(null)).toMatchObject({ weekOff: false, dayOff: false, dayHour: 9, weekHour: 17, day: 5 });
    expect(lodiPrefsOf({ off: "yes", day: 9, hour: -1, dayHour: 7.5 })).toEqual(LODI_PREFS_DEFAULTS);
  });

  test("who stopped the card before gets nothing new, and who chose it daily keeps exactly that", () => {
    // Stopped: both stay off, and so does everything that did not exist when "off" was the only switch.
    expect(lodiPrefsOf({ off: true, day: 5, hour: 17, daily: false })).toMatchObject({
      weekOff: true,
      dayOff: true,
      digestOff: true,
      remindOff: true,
    });
    // Until the row says otherwise for one of them.
    expect(lodiPrefsOf({ off: true, daily: false, digestOff: false })).toMatchObject({
      digestOff: false,
      remindOff: true,
    });
    // A card left on then is no word about the rest: it is on.
    expect(lodiPrefsOf({ off: false, day: 3, hour: 10, daily: false })).toMatchObject({
      digestOff: false,
      remindOff: false,
    });
    expect(lodiPrefsOf({ off: true, day: 5, hour: 9, daily: true })).toMatchObject({ weekOff: true, dayOff: true });
    // Daily in place of the week's, at its hour.
    expect(lodiPrefsOf({ off: false, day: 5, hour: 8, daily: true })).toMatchObject({
      weekOff: true,
      dayOff: false,
      dayHour: 8,
      weekHour: 17,
    });
    // Saved for any other reason (the week's day moved): the day's card was off then, and stays off.
    expect(lodiPrefsOf({ off: false, day: 3, hour: 10, daily: false })).toMatchObject({
      weekOff: false,
      dayOff: true,
      day: 3,
      weekHour: 10,
    });
    // The new keys win over the old ones kept beside them.
    expect(lodiPrefsOf({ off: true, daily: false, weekOff: false, dayOff: false })).toMatchObject({
      weekOff: false,
      dayOff: false,
    });
    expect(lodiPrefsOf({ muted: ["a", 3, "b"] }).muted).toEqual(["a", "b"]);
  });

  test("an older build reads the truth and its one switch stops everything", () => {
    const on = LODI_PREFS_DEFAULTS;
    // Both on: an admin's build shows the week's card, anyone else's the day's.
    expect(legacyTeamWeek(on, true)).toEqual({ off: false, daily: false, hour: 17 });
    expect(legacyTeamWeek(on, false)).toEqual({ off: false, daily: true, hour: 9 });
    expect(legacyTeamWeek({ ...on, weekOff: true }, true)).toEqual({ off: false, daily: true, hour: 9 });
    expect(legacyTeamWeek({ ...on, weekOff: true, dayOff: true }, true).off).toBe(true);
    // Its stop: nothing comes by itself any more, the summary of approvals and the reminders included.
    const nothing = { weekOff: true, dayOff: true, digestOff: true, remindOff: true };
    expect(patchLodiPrefs(on, { off: true }, true)).toMatchObject(nothing);
    expect(patchLodiPrefs(on, { off: true }, false)).toMatchObject(nothing);
    // Stopping one card on a newer build stops that card alone.
    expect(patchLodiPrefs(on, { weekOff: true, dayOff: true }, true)).toMatchObject({
      digestOff: false,
      remindOff: false,
    });
    // Its start brings back the one card it draws, never the other: an admin who only had the week's keeps only that.
    const stopped = { ...on, weekOff: true, dayOff: true };
    expect(patchLodiPrefs(stopped, { off: false }, true)).toMatchObject({ weekOff: false, dayOff: true });
    expect(patchLodiPrefs(stopped, { off: false }, false)).toMatchObject({ weekOff: true, dayOff: false });
    expect(legacyTeamWeek(patchLodiPrefs(stopped, { off: false }, true), true)).toMatchObject({
      off: false,
      daily: false,
    });
    // "Every day" in its day select: the day's card alone, at the hour it showed.
    expect(patchLodiPrefs(on, { daily: true }, true)).toMatchObject({ weekOff: true, dayOff: false, dayHour: 17 });
    // Back to a weekday from there: the week's alone, as it draws it.
    const daily = patchLodiPrefs(on, { daily: true }, true);
    expect(patchLodiPrefs(daily, { daily: false, day: 2 }, true)).toMatchObject({
      weekOff: false,
      dayOff: true,
      day: 2,
    });
    // Moving the week's day with both on leaves the day's card alone.
    expect(patchLodiPrefs(on, { daily: false, day: 2 }, true)).toMatchObject({ weekOff: false, dayOff: false, day: 2 });
    // Anyone else's stop and start.
    expect(patchLodiPrefs(on, { daily: false }, false).dayOff).toBe(true);
    expect(patchLodiPrefs({ ...on, dayOff: true }, { daily: true, off: false }, false).dayOff).toBe(false);
    // Its hour is the hour of the card it shows.
    expect(patchLodiPrefs(on, { hour: 8 }, true)).toMatchObject({ weekHour: 8, dayHour: 9 });
    expect(patchLodiPrefs(on, { hour: 8 }, false)).toMatchObject({ weekHour: 17, dayHour: 8 });
    // The new fields change one thing each.
    expect(patchLodiPrefs(on, { dayOff: true }, true)).toEqual({ ...on, dayOff: true });
    expect(patchLodiPrefs(on, { weekHour: 30 as number }, true)).toEqual(on);
  });

  test("the rules in SQL are the rules in code, for every stored shape", async () => {
    f = await setup({ rightHand: true });
    for (const shape of SHAPES) {
      await store(f, f.owner.id, shape);
      const [row] = rowsOf<Record<keyof typeof lodiPrefsSql, unknown>>(
        await f.db.execute(sql`select ${lodiPrefsSql.weekOff} as "weekOff", ${lodiPrefsSql.dayOff} as "dayOff",
            ${lodiPrefsSql.digestOff} as "digestOff", ${lodiPrefsSql.remindOff} as "remindOff",
            ${lodiPrefsSql.day} as "day", ${lodiPrefsSql.weekHour} as "weekHour", ${lodiPrefsSql.dayHour} as "dayHour"
          from organization_members m where m.org_id = ${f.org.id} and m.user_id = ${f.owner.id}`),
      );
      const { muted: _, ...code } = lodiPrefsOf(shape);
      expect({
        shape,
        ...row,
        day: Number(row?.day),
        weekHour: Number(row?.weekHour),
        dayHour: Number(row?.dayHour),
      }).toEqual({ shape, ...code });
    }
  });

  test("a save keeps every other key, unknown ones included, and writes an older build's three beside the new", async () => {
    f = await setup({ rightHand: true });
    await store(f, f.owner.id, { off: false, day: 3, hour: 10, daily: false, somethingLater: { kept: true } });
    const view = await setLodiPrefs(f.db, f.org.id, f.owner.id, { digestOff: true });
    expect(view).toMatchObject({ weekOff: false, dayOff: true, day: 3, weekHour: 10, digestOff: true, off: false });
    expect(view).not.toHaveProperty("muted");
    expect(await stored(f, f.owner.id)).toMatchObject({
      somethingLater: { kept: true },
      digestOff: true,
      weekOff: false,
      dayOff: true,
      weekHour: 10,
      off: false,
      daily: false,
      hour: 10,
    });
    await setLodiPrefs(f.db, f.org.id, f.owner.id, { muted: ["unanswered:1"] });
    expect((await readLodiPrefs(f.db, f.org.id, f.owner.id)).prefs).toMatchObject({
      muted: ["unanswered:1"],
      digestOff: true,
    });
    // What is put away is added to, never replaced.
    await setLodiPrefs(f.db, f.org.id, f.owner.id, { muted: ["unanswered:2", "unanswered:1"] });
    expect((await readLodiPrefs(f.db, f.org.id, f.owner.id)).prefs.muted).toEqual(["unanswered:1", "unanswered:2"]);
    expect(await stored(f, f.owner.id)).toMatchObject({ somethingLater: { kept: true } });
    // Theirs only.
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    expect(await getLodiPrefs(f.db, f.org.id, bia.id)).toMatchObject({ digestOff: false, dayOff: false, daily: true });
    await expect(getLodiPrefs(f.db, f.org.id, "nobody")).rejects.toThrow();
  });

  test("saves made at once all hold: each builds on the one before", async () => {
    f = await setup({ rightHand: true });
    await Promise.all([
      setLodiPrefs(f.db, f.org.id, f.owner.id, { muted: ["unanswered:a"] }),
      setLodiPrefs(f.db, f.org.id, f.owner.id, { muted: ["unanswered:b"], digestOff: true }),
      setLodiPrefs(f.db, f.org.id, f.owner.id, { dayHour: 7 }),
    ]);
    const { prefs } = await readLodiPrefs(f.db, f.org.id, f.owner.id);
    expect([...prefs.muted].sort()).toEqual(["unanswered:a", "unanswered:b"]);
    expect(prefs).toMatchObject({ digestOff: true, dayHour: 7 });
  });

  test("the day's hour is in the person's own time zone, the week's in the workspace's", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    expect(await getLodiPrefs(f.db, f.org.id, f.owner.id)).toMatchObject({ timezone: ZONE, dayTimezone: ZONE });
    await f.db
      .update(schema.organizationMembers)
      .set({ timezone: "Asia/Tokyo" })
      .where(eq(schema.organizationMembers.userId, f.owner.id));
    expect(await getLodiPrefs(f.db, f.org.id, f.owner.id)).toMatchObject({ timezone: ZONE, dayTimezone: "Asia/Tokyo" });
  });
});

describe("the two slots", () => {
  const who = { admin: true, timezone: ZONE, dayTimezone: ZONE };
  const on = LODI_PREFS_DEFAULTS;

  test("the day's card every day at its hour, the week's on its day, each within the hours after its slot", () => {
    expect(lastTeamWeekSlot("day", on, ZONE, new Date(NINE.getTime() + HOUR))?.toISOString()).toBe(NINE.toISOString());
    expect(lastTeamWeekSlot("week", on, ZONE, new Date(FIVE.getTime() + HOUR))?.toISOString()).toBe(FIVE.toISOString());
    const thursday = new Date(NINE.getTime() - DAY + HOUR);
    expect(dueTeamWeeks(on, who, thursday).map((d) => d.period)).toEqual(["day"]);
    // Anyone else never gets the week's.
    expect(dueTeamWeeks(on, { ...who, admin: false }, new Date(FIVE.getTime() + HOUR))).toEqual([]);
    // Missed by more than the window: it waits for the next one.
    expect(dueTeamWeeks(on, who, new Date(NINE.getTime() - DAY + 7 * HOUR))).toEqual([]);
    expect(dueTeamWeeks({ ...on, dayOff: true }, who, thursday)).toEqual([]);
  });

  test("on the day the week's card comes an admin gets that one alone", () => {
    expect(dueTeamWeeks(on, who, new Date(NINE.getTime() + HOUR))).toEqual([]);
    expect(dueTeamWeeks(on, who, new Date(FIVE.getTime() + HOUR)).map((d) => d.period)).toEqual(["week"]);
    // With the week's off, or for anyone else, Friday is a day like any other.
    expect(dueTeamWeeks({ ...on, weekOff: true }, who, new Date(NINE.getTime() + HOUR)).map((d) => d.period)).toEqual([
      "day",
    ]);
    expect(dueTeamWeeks(on, { ...who, admin: false }, new Date(NINE.getTime() + HOUR)).map((d) => d.period)).toEqual([
      "day",
    ]);
  });

  test("queued once per person and day and once per admin and week, from one statement", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const thursday = new Date(NINE.getTime() - DAY + HOUR);
    // Thursday 10h: everyone's day.
    expect((await nearTeamWeeks(f.db, thursday)).map((n) => n.user_id).sort()).toEqual([f.owner.id, bia.id].sort());
    expect(await enqueueTeamWeeks(f.db, thursday)).toBe(2);
    // Queued: the statement itself leaves them out for the rest of the day, so a tick reads only who it may queue.
    expect(await nearTeamWeeks(f.db, new Date(thursday.getTime() + HOUR))).toEqual([]);
    expect(await enqueueTeamWeeks(f.db, new Date(thursday.getTime() + HOUR))).toBe(0);
    expect((await cardJobs(f)).map((j) => j.period)).toEqual(["day", "day"]);
    // The day's card has its own kind: a server from before the two cards never reads it as a week's.
    expect(
      (await f.db.select({ kind: schema.outbox.kind }).from(schema.outbox).where(eq(schema.outbox.kind, TEAM_DAY_JOB)))
        .length,
    ).toBe(2);
    expect(f.handlers[TEAM_DAY_JOB]).toBeDefined();
    // Friday 10h: the member's day, and nothing for the admin, whose week comes at 17h.
    expect(await enqueueTeamWeeks(f.db, new Date(NINE.getTime() + HOUR))).toBe(1);
    expect((await cardJobs(f)).filter((j) => j.userId === bia.id)).toHaveLength(2);
    // Friday 18h: the admin's week.
    expect(await enqueueTeamWeeks(f.db, new Date(FIVE.getTime() + HOUR))).toBe(1);
    expect(await nearTeamWeeks(f.db, new Date(FIVE.getTime() + 2 * HOUR))).toEqual([]);
    expect(await enqueueTeamWeeks(f.db, new Date(FIVE.getTime() + 2 * HOUR))).toBe(0);
    const all = await cardJobs(f);
    expect(all.filter((j) => j.userId === f.owner.id).map((j) => j.period)).toEqual(["day", "week"]);
    expect(all.find((j) => j.period === "week")?.slot).toBe(FIVE.toISOString());
  });

  test("who stopped the card before is never queued, and a person's own zone moves their day", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    await store(f, f.owner.id, { off: true, day: 5, hour: 17, daily: false });
    await store(f, bia.id, { off: false, day: 5, hour: 17, daily: false });
    // 09:00 in Tokyo is 21:00 the day before in São Paulo.
    await f.db
      .update(schema.organizationMembers)
      .set({ timezone: "Asia/Tokyo" })
      .where(eq(schema.organizationMembers.userId, caio.id));
    const thursday = new Date(NINE.getTime() - DAY + HOUR);
    expect(await enqueueTeamWeeks(f.db, thursday)).toBe(0);
    expect(await enqueueTeamWeeks(f.db, new Date(FIVE.getTime() + HOUR))).toBe(0);
    const tokyoNine = new Date("2026-11-05T00:00:00Z");
    expect(await enqueueTeamWeeks(f.db, new Date(tokyoNine.getTime() + HOUR))).toBe(1);
    expect(await cardJobs(f)).toEqual([{ userId: caio.id, period: "day", slot: tokyoNine.toISOString() }]);
    // The key the statement looks for is the one the job got, in the person's own zone too.
    expect(await nearTeamWeeks(f.db, new Date(tokyoNine.getTime() + 2 * HOUR))).toEqual([]);
  });

  test("a time zone the database does not know reads as the workspace's, and stops nobody else's card", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await f.db
      .update(schema.organizationMembers)
      .set({ timezone: "Mars/Olympus_Mons" })
      .where(eq(schema.organizationMembers.userId, bia.id));
    const thursday = new Date(NINE.getTime() - DAY + HOUR);
    expect(await enqueueTeamWeeks(f.db, thursday)).toBe(2);
    // Both at 9h in the workspace's zone.
    const slot = new Date(NINE.getTime() - DAY).toISOString();
    expect((await cardJobs(f)).map((j) => j.slot)).toEqual([slot, slot]);
  });

  test("more members than one statement queues are all queued, once", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    const people = Array.from({ length: 1100 }, (_, i) => ({ id: `u_many_${i}`, n: i }));
    await f.db
      .insert(schema.users)
      .values(people.map((p) => ({ id: p.id, name: `P ${p.n}`, email: `p${p.n}@example.com`, locale: "pt-BR" })));
    await f.db
      .insert(schema.organizationMembers)
      .values(people.map((p) => ({ orgId: f.org.id, userId: p.id, role: "member" as const })));
    const thursday = new Date(NINE.getTime() - DAY + HOUR);
    expect(await enqueueTeamWeeks(f.db, thursday)).toBe(1101);
    expect(await enqueueTeamWeeks(f.db, thursday)).toBe(0);
  });

  test("a database failure while reading the member is the job's to retry, and someone who left gets nothing", async () => {
    f = await setup({ rightHand: true });
    const payload = { userId: f.owner.id, slot: NINE.toISOString(), period: "day" };
    const down = {
      execute: async () => {
        throw new Error("database down");
      },
    } as unknown as typeof f.db;
    await expect(postTeamWeek({ db: down }, f.org.id, payload)).rejects.toThrow("database down");
    expect(await postTeamWeek({ db: f.db }, f.org.id, { ...payload, userId: "nobody" })).toBeNull();
  });

  test("no team or no right hand: nobody is queued", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, f.agent.id));
    expect(await enqueueTeamWeeks(f.db, new Date(NINE.getTime() - DAY + HOUR))).toBe(0);
    await f.close();
    f = await setup();
    await inZone(f);
    expect(await enqueueTeamWeeks(f.db, new Date(NINE.getTime() - DAY + HOUR))).toBe(0);
  });
});

describe("what it says", () => {
  const post = (fx: Fixture, userId: string, extra: Partial<Parameters<typeof postFromLodi>[3]> = {}) =>
    postFromLodi({ db: fx.db, pubsub: fx.pubsub }, fx.org.id, userId, {
      bodyCode: "action_approvals",
      push: false,
      ...extra,
    });

  test("one message in the person's DM, in their language, ringing only when asked to", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf(f);
    await f.db.update(schema.users).set({ locale: "pt-BR" }).where(eq(schema.users.id, f.owner.id));
    const id = await post(f, f.owner.id, { meta: { actionCard: { kind: "approvals" } }, bodyParams: { n: 3 } });
    const [m] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, id as string));
    const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id);
    expect(m).toMatchObject({ channelId: dm.id, authorAgentId: lodi.id, body: "Aprovações esperando você" });
    expect(m?.meta).toMatchObject({
      bodyCode: "action_approvals",
      bodyParams: { n: 3 },
      actionCard: { kind: "approvals" },
    });
    const rings = () => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "notifications.message"));
    expect(await rings()).toHaveLength(0);
    const loud = await post(f, f.owner.id, { push: true, body: () => "Its own words" });
    expect((await rings()).map((j) => j.payload)).toEqual([{ messageId: loud }]);
    const [second] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, loud as string));
    expect(second?.body).toBe("Its own words");
  });

  test("said once: two workers post one message", async () => {
    f = await setup({ rightHand: true });
    const posted = async (
      tx: Parameters<NonNullable<Parameters<typeof postFromLodi>[3]["posted"]>>[0],
      lodiId: string,
    ) =>
      (
        await tx
          .select({ id: schema.messages.id })
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.authorAgentId, lodiId),
              sql`${schema.messages.meta}->>'bodyCode' = 'action_approvals'`,
            ),
          )
      ).length > 0;
    expect(await post(f, f.owner.id, { posted })).not.toBeNull();
    expect(await post(f, f.owner.id, { posted })).toBeNull();
  });

  test("nothing in a closed workspace, with it archived, or to someone it may not talk to", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    expect((await lodiFor(f.db, f.org.id, bia.id))?.id).toBe(lodi.id);
    // Only its owner's roles may talk to it: a member outside them hears nothing.
    await f.db
      .update(schema.agents)
      .set({ audienceMode: "owner", ownerUserId: f.owner.id })
      .where(eq(schema.agents.id, lodi.id));
    expect(await lodiFor(f.db, f.org.id, bia.id)).toBeNull();
    expect(await post(f, bia.id)).toBeNull();
    expect(await lodiFor(f.db, f.org.id)).not.toBeNull();
    await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, lodi.id));
    expect(await lodiFor(f.db, f.org.id)).toBeNull();
    expect(await post(f, f.owner.id)).toBeNull();
    await f.db.update(schema.agents).set({ archivedAt: null }).where(eq(schema.agents.id, lodi.id));
    await f.db
      .update(schema.organizations)
      .set({ deletionDueAt: new Date(Date.now() + 7 * DAY) })
      .where(eq(schema.organizations.id, f.org.id));
    expect(await lodiFor(f.db, f.org.id, f.owner.id)).toBeNull();
    expect(await post(f, f.owner.id)).toBeNull();
    expect(await f.db.select().from(schema.messages).where(eq(schema.messages.authorAgentId, lodi.id))).toEqual([]);
  });

  test("saidOnce is true the first time and false for ever after", async () => {
    f = await setup({ rightHand: true });
    expect(await saidOnce(f.db, f.org.id, "team_watch.resume:r1")).toBe(true);
    expect(await saidOnce(f.db, f.org.id, "team_watch.resume:r1")).toBe(false);
    expect(await saidOnce(f.db, f.org.id, "team_watch.resume:r2")).toBe(true);
    // Never claimed as a job, and kept under the workspace and a prefix of its own: the same words said in another
    // workspace, or used as a job's key, meet nothing.
    const [row] = await f.db
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.dedupeKey, saidKey(f.org.id, "team_watch.resume:r1")));
    expect(row?.status).toBe("done");
    expect(saidKey("other-org", "team_watch.resume:r1")).not.toBe(saidKey(f.org.id, "team_watch.resume:r1"));
    await enqueue(f.db, { orgId: f.org.id, kind: "fake.job", payload: {}, dedupeKey: "team_watch.resume:r1" });
    expect(await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "fake.job"))).toHaveLength(1);
  });

  test("a card is rewritten where it stands", async () => {
    f = await setup({ rightHand: true });
    const id = (await post(f, f.owner.id, { meta: { actionCard: { kind: "approvals", n: 1 }, kept: true } })) as string;
    await setCardOnMessage({ db: f.db, pubsub: f.pubsub }, f.org.id, id, { kind: "approvals", n: 2 });
    const [m] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, id));
    expect(m?.meta).toMatchObject({
      actionCard: { kind: "approvals", n: 2 },
      kept: true,
      bodyCode: "action_approvals",
    });
    await expect(
      setCardOnMessage({ db: f.db }, f.org.id, crypto.randomUUID(), { kind: "approvals" }),
    ).rejects.toThrow();
  });
});

describe("the workspace's switches", () => {
  test("on with no settings row, saved by who configures the workspace only", async () => {
    f = await setup({ rightHand: true });
    await f.db.delete(schema.organizationSettings).where(eq(schema.organizationSettings.orgId, f.org.id));
    expect(await lodiSwitches(f.db, f.org.id)).toEqual({ teamWatch: true, welcomePeople: true });
    expect(await getOrgSettings(f.db, f.owner.id, f.org.id)).toMatchObject({ teamWatch: true, welcomePeople: true });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await expect(updateOrgSettings(f.db, bia.id, f.org.id, { teamWatch: false })).rejects.toThrow();
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { teamWatch: false });
    expect(await lodiSwitches(f.db, f.org.id)).toEqual({ teamWatch: false, welcomePeople: true });
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { welcomePeople: false, teamWatch: true });
    expect(await lodiSwitches(f.db, f.org.id)).toEqual({ teamWatch: true, welcomePeople: false });
  });
});

describe("lanes", () => {
  const calls: string[] = [];
  const fake: LodiLane = {
    switch: "teamWatch",
    live: true,
    jobs: {
      "fake.check": async (_deps, orgId, payload) => {
        calls.push(`job:${orgId}:${String(payload.n)}`);
      },
    },
    sweep: async (_db, now) => {
      calls.push(`sweep:${now.toISOString()}`);
      return 3;
    },
    promptBlock: async (_db, ctx) => `# Fake\nFor ${ctx.personId}.`,
  };
  const quiet: LodiLane = { switch: "digest", live: false, jobs: {}, promptBlock: async () => "" };

  test("every lane that ships is wired and does nothing until it is built", async () => {
    f = await setup({ rightHand: true });
    const lanes = lodiLanes();
    expect(lanes.map((l) => l.switch).sort()).toEqual(["digest", "reminders", "teamWatch", "welcomePeople"]);
    expect(liveLodiSwitches()).toEqual(lanes.filter((l) => l.live).map((l) => l.switch));
    const handlers = lodiLaneHandlers({ db: f.db } as JobDeps);
    const kinds = ["approvals_digest.post", "right_hand.task_check", "right_hand.welcome", "team_watch.check"];
    expect(Object.keys(handlers)).toEqual(expect.arrayContaining(kinds));
    // And the server's own handlers carry every lane's.
    expect(Object.keys(f.handlers)).toEqual(expect.arrayContaining(Object.keys(handlers)));
    // A lane that is not built yet: no message, no job, no prompt, no model call.
    for (const lane of lanes.filter((l) => !l.live)) {
      const before = await f.db.select({ id: schema.outbox.id }).from(schema.outbox);
      for (const kind of Object.keys(lane.jobs))
        await handlers[kind]?.({ kind, orgId: f.org.id, payload: { userId: f.owner.id } } as never, {} as never);
      expect(await lane.sweep?.(f.db, new Date())).toBe(lane.sweep ? 0 : undefined);
      expect(await lane.promptBlock?.(f.db, { orgId: f.org.id, agentId: "a", personId: f.owner.id })).toBe(
        lane.promptBlock ? "" : undefined,
      );
      expect(await f.db.select({ id: schema.outbox.id }).from(schema.outbox)).toEqual(before);
    }
    expect(await f.db.select({ id: schema.messages.id }).from(schema.messages)).toEqual([]);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("a lane's jobs get their handler, with the job's organization and payload", async () => {
    f = await setup({ rightHand: true });
    calls.length = 0;
    const handlers = lodiLaneHandlers({ db: f.db } as JobDeps, [fake, quiet]);
    expect(Object.keys(handlers)).toEqual(["fake.check"]);
    await handlers["fake.check"]?.({ kind: "fake.check", orgId: f.org.id, payload: { n: 7 } } as never, {} as never);
    expect(calls).toEqual([`job:${f.org.id}:7`]);
    await expect(
      handlers["fake.check"]?.({ kind: "fake.check", orgId: null, payload: {} } as never, {} as never),
    ).rejects.toThrow("needs an organization");
  });

  test("the worker's sweep runs the cards and every lane's, and one failing does not hold the others", async () => {
    f = await setup({ rightHand: true });
    await inZone(f);
    calls.length = 0;
    const now = new Date(NINE.getTime() - DAY + HOUR);
    // The owner's day card and the lane's three.
    expect(await enqueueRightHandChecks(f.db, now, [fake, quiet])).toBe(4);
    expect(calls).toEqual([`sweep:${now.toISOString()}`]);
    const broken: LodiLane = {
      ...quiet,
      sweep: async () => {
        throw new Error("lane down");
      },
    };
    calls.length = 0;
    // The day before: another day card is due, and it is queued though a lane threw.
    await expect(enqueueRightHandChecks(f.db, new Date(now.getTime() - DAY), [broken, fake])).rejects.toThrow(
      "lane down",
    );
    expect(calls).toHaveLength(1);
    expect(await cardJobs(f)).toHaveLength(2);
  });

  test("a lane's block joins the prompt in the right hand's DM only, and its switch shows once it is live", async () => {
    f = await setup({ rightHand: true });
    const ctx = { orgId: f.org.id, agentId: "a", personId: f.owner.id };
    expect(await lodiPromptBlocks(f.db, ctx, [fake, quiet])).toEqual([`# Fake\nFor ${f.owner.id}.`]);
    expect(liveLodiSwitches([fake, quiet])).toEqual(["teamWatch"]);
    const lodi = await lodiOf(f);
    const prompt = (inDm: boolean, lanes?: LodiLane[]) =>
      rightHandPrompt({ db: f.db }, { orgId: f.org.id, agent: lodi, personId: f.owner.id, inDm, lanes });
    const dm = await prompt(true);
    expect(dm).toContain("'Resumo do dia'");
    expect(dm).toContain("set_team_week");
    expect(dm).not.toContain("# Fake");
    expect(await prompt(false)).toContain("set_team_week");
    // A lane's block is in the prompt of its DM with the person, and nowhere else.
    const digest: LodiLane = { ...quiet, live: true };
    const withFake = await prompt(true, [fake, digest]);
    expect(withFake).toContain(`# Fake\nFor ${f.owner.id}.`);
    expect(withFake).toContain("your summary of approvals waiting on them");
    expect(dm.includes("your summary of approvals waiting on them")).toBe(liveLodiSwitches().includes("digest"));
    expect(await prompt(false, [fake, digest])).not.toContain("# Fake");
  });

  test("a lane whose block fails is left out and reported, and the right hand still answers", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf(f);
    const told: string[] = [];
    reportLodiLaneErrors((lane, error) => told.push(`${lane}:${String(error)}`));
    try {
      const broken: LodiLane = {
        ...quiet,
        promptBlock: async () => {
          throw new Error("lane down");
        },
      };
      const text = await rightHandPrompt(
        { db: f.db },
        { orgId: f.org.id, agent: lodi, personId: f.owner.id, inDm: true, lanes: [broken, fake] },
      );
      expect(text).toContain("# Fake");
      expect(text).toContain("# Where you are");
      expect(told).toEqual(["digest:Error: lane down"]);
    } finally {
      reportLodiLaneErrors(() => {});
    }
  });

  test("the prompt and the tools name a switch only once its feature is built", async () => {
    expect(ownCardsLine(false, [])).not.toContain("approvals");
    expect(ownCardsLine(false, [])).toContain("admins also get your weekly");
    expect(ownCardsLine(true, ["digest", "reminders"])).toContain(
      "or to turn your summary of approvals waiting on them or your reminders of what you two agreed on off or on",
    );
    f = await setup({ rightHand: true });
    // Not built: `update_workspace` takes no switch and says nothing of them.
    const action = workspaceAction("update_workspace");
    const live = liveLodiSwitches();
    expect(Object.keys((action?.input.properties ?? {}) as object).includes("team_watch")).toBe(
      live.includes("teamWatch"),
    );
    expect(action?.does.includes("greets")).toBe(live.includes("welcomePeople"));
    expect(
      (await findWorkspaceActions({ db: f.db, orgId: f.org.id } as never, f.owner.id, "workspace name")).length,
    ).toBeGreaterThan(0);
  });
});

describe("a built lane's switch", () => {
  test("update_workspace takes the workspace's switch, saves it and undoes it", async () => {
    f = await setup({ rightHand: true });
    const deps = { db: f.db, pubsub: f.pubsub } as never;
    const action = workspaceAction("update_workspace");
    if (!action?.revert) throw new Error("no update_workspace");
    await built(teamWatchLane, async () => {
      expect(Object.keys((action.input.properties ?? {}) as object)).toContain("team_watch");
      expect(action.does).toContain("watches for what stops the team");
      const done = await action.run(deps, f.owner.id, f.org.id, { team_watch: false });
      expect(done).toMatchObject({ before: { teamWatch: true }, after: { teamWatch: false } });
      expect(await lodiSwitches(f.db, f.org.id)).toEqual({ teamWatch: false, welcomePeople: true });
      const row = { orgId: f.org.id, before: done.before, after: done.after } as never;
      await action.revert?.(deps, f.owner.id, row, "undo", () => new Error("changed since"));
      expect(await lodiSwitches(f.db, f.org.id)).toEqual({ teamWatch: true, welcomePeople: true });
    });
    // Not built: the same input changes nothing it knows.
    if (!teamWatchLane.live)
      await expect(action.run(deps, f.owner.id, f.org.id, { team_watch: false })).rejects.toThrow();
  });
});

describe("asked of the right hand", () => {
  async function tool(fx: Fixture, userId: string) {
    const lodi = await lodiOf(fx);
    const dm = await openPersonAgentDm(fx.db, fx.org.id, userId, lodi.id);
    const trigger = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, userId, fx.org.id, dm.id, {
      body: "muda o horário do resumo",
    });
    const [r] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
    const gateway = createToolGateway({ sources: [createSetupToolSource({ pubsub: fx.pubsub })] });
    const ctx = {
      db: fx.db,
      orgId: fx.org.id,
      agentId: lodi.id,
      runId: r?.id ?? "",
      channelId: dm.id,
      threadRootId: r?.threadRootId ?? trigger.id,
      triggerMessageId: trigger.id,
    };
    let n = 0;
    return async (input: Record<string, unknown>) => {
      const res = await gateway.invoke(ctx, { toolUseId: `tu_${++n}`, name: SET_TEAM_WEEK_TOOL, input });
      if (res.type !== "result") throw new Error(res.type);
      return res.output as { content: string; isError?: boolean };
    };
  }
  const prefs = async (fx: Fixture, userId: string): Promise<LodiPrefs> =>
    (await readLodiPrefs(fx.db, fx.org.id, userId)).prefs;

  test("set_team_week stops, starts and moves each card for the person behind the run", async () => {
    f = await setup({ rightHand: true });
    const call = await tool(f, f.owner.id);
    expect((await call({ card: "day", off: true })).content).toContain("Daily summary: off.");
    expect(await prefs(f, f.owner.id)).toMatchObject({ dayOff: true, weekOff: false });
    await call({ card: "week", day: "monday", hour: 9 });
    expect(await prefs(f, f.owner.id)).toMatchObject({ dayOff: true, weekOff: false, day: 1, weekHour: 9 });
    await call({ off: true });
    expect(await prefs(f, f.owner.id)).toMatchObject({ dayOff: true, weekOff: true });
    const back = await call({ card: "day", off: false, hour: 8 });
    expect(back.content).toContain("Daily summary: every day at 8:00");
    expect(back.content).toContain("Weekly card: off.");
    expect(await prefs(f, f.owner.id)).toMatchObject({ dayOff: false, dayHour: 8, weekOff: true, weekHour: 9 });
    // An hour with no card named is not guessed for someone who gets both.
    expect((await call({ hour: 7 })).isError).toBe(true);
    expect(await prefs(f, f.owner.id)).toMatchObject({ dayHour: 8, weekHour: 9 });
  });

  test("set_team_week flips a person's own switch once its lane is built, and says what it left", async () => {
    f = await setup({ rightHand: true });
    await built(approvalsDigestLane, async () => {
      const call = await tool(f, f.owner.id);
      const off = await call({ digest: false });
      expect(off.content).toContain("Summary of approvals waiting: off.");
      expect(await prefs(f, f.owner.id)).toMatchObject({ digestOff: true, dayOff: false, weekOff: false });
      expect((await call({ digest: true })).content).toContain("Summary of approvals waiting: on.");
      expect(await prefs(f, f.owner.id)).toMatchObject({ digestOff: false });
    });
    // Not built: asked the same, it turns nothing off.
    if (!approvalsDigestLane.live) {
      await (await tool(f, f.owner.id))({ digest: false });
      expect(await prefs(f, f.owner.id)).toMatchObject({ digestOff: false });
    }
  });

  test("anyone else only has the day's card", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const call = await tool(f, bia.id);
    const moved = await call({ hour: 7 });
    expect(moved.content).toContain("Daily summary: every day at 7:00");
    expect(moved.content).not.toContain("Weekly card");
    expect(await prefs(f, bia.id)).toMatchObject({ dayOff: false, dayHour: 7, weekHour: 17 });
    expect((await call({ card: "week", off: true })).isError).toBe(true);
    await call({ off: true });
    expect(await prefs(f, bia.id)).toMatchObject({ dayOff: true, weekOff: false });
  });
});
