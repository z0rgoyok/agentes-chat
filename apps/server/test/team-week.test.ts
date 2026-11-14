import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  IDLE_REASON,
  liveLodiSwitches,
  openPersonAgentDm,
  proposeSettings,
  RIGHT_HAND,
  readLodiPrefs,
} from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/** Lodi's weekly card (ADR 0137 §9) over HTTP: my own schedule, and a row applied as me, never as someone else. */

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

test("my day and hour or off; a row of my card applied as me, put away, and refused to anyone else", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const ownerId = ((await (await owner("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const { orgId, agentId } = await seedOrg(owner);
  const base = `/api/app/organizations/${orgId}/team-week`;

  expect(await (await owner(base)).json()).toMatchObject({ off: false, day: 5, hour: 17 });
  const moved = await owner(base, { method: "PUT", json: { day: 1, hour: 9 } });
  expect(await moved.json()).toMatchObject({ off: false, day: 1, hour: 9 });
  expect((await owner(base, { method: "PUT", json: { hour: 30 } })).status).toBe(400);

  const [lodi] = await t.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  const dm = await openPersonAgentDm(t.db, orgId, ownerId, lodi.id);
  const card = {
    kind: "team_week",
    forUserId: ownerId,
    from: "2026-10-30",
    to: "2026-11-06",
    timezone: "UTC",
    stats: { done: 3, stuck: 0, waiting: 0, spentNanoUsd: 0, budgetNanoUsd: 0 },
    worked: [],
    rows: [
      {
        id: "routine:x",
        kind: "routine",
        agentId,
        channelId: dm.id,
        dm: true,
        text: "Resumo do dia",
        count: 3,
        hour: 18,
      },
    ],
    proposalIds: [],
    done: {},
    dismissedAt: null,
  };
  const [m] = await t.db
    .insert(schema.messages)
    .values({
      orgId,
      channelId: dm.id,
      authorType: "agent",
      authorAgentId: lodi.id,
      body: "card",
      meta: { actionCard: card },
    })
    .returning();
  const row = `${base}/${m?.id}`;

  const nina = await joinByInvitation(t, owner, orgId, "nina@example.com");
  expect((await nina(row, { json: { dismiss: true } })).status).toBe(403);

  expect((await owner(row, { json: { rowId: "routine:x" } })).status).toBe(204);
  const routines = await t.db.select().from(schema.routines).where(eq(schema.routines.orgId, orgId));
  expect(routines.map((r) => r.prompt)).toEqual(["Resumo do dia"]);
  expect((await owner(row, { json: { rowId: "routine:x" } })).status).toBe(409);
  expect((await owner(row, { json: { dismiss: true } })).status).toBe(204);
  const [after] = await t.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, m?.id ?? ""));
  const saved = after?.meta.actionCard as { dismissedAt: string | null; done: Record<string, unknown> };
  expect(saved.dismissedAt).not.toBeNull();
  expect(Object.keys(saved.done)).toEqual(["routine:x"]);
});

test("builds from before the two cards still read the truth, and their one switch stops everything", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const base = `/api/app/organizations/${orgId}/team-week`;
  const put = async (who: typeof owner, json: Record<string, unknown>) =>
    (await (await who(base, { method: "PUT", json })).json()) as Record<string, unknown>;

  // Nothing stored: both cards on, the daily at 9h, and the switches of the features this server has built.
  expect(await (await owner(base)).json()).toMatchObject({
    weekOff: false,
    dayOff: false,
    dayHour: 9,
    weekHour: 17,
    off: false,
    daily: false,
    hour: 17,
    switches: liveLodiSwitches(),
  });
  // An older build's "Parar de receber" stops both. Its start brings back the card it draws (an admin's weekly),
  // not one it has no control for.
  expect(await put(owner, { off: true })).toMatchObject({ weekOff: true, dayOff: true, off: true });
  expect(await put(owner, { off: false })).toMatchObject({ weekOff: false, dayOff: true, off: false, daily: false });
  // Its "every day": the daily card in place of the weekly, at the hour it showed.
  expect(await put(owner, { daily: true })).toMatchObject({
    weekOff: true,
    dayOff: false,
    dayHour: 17,
    daily: true,
    hour: 17,
  });
  // The new fields move one card each.
  expect(await put(owner, { weekOff: false, dayHour: 8, digestOff: true })).toMatchObject({
    weekOff: false,
    dayOff: false,
    dayHour: 8,
    weekHour: 17,
    digestOff: true,
    daily: false,
  });
  expect((await owner(base, { method: "PUT", json: { dayHour: 24 } })).status).toBe(400);

  // Someone who administers nothing: the daily card is the one an older build shows, and its stop is theirs alone.
  const nina = await joinByInvitation(t, owner, orgId, "nina@example.com");
  expect(await (await nina(base)).json()).toMatchObject({ dayOff: false, daily: true, off: false, hour: 9 });
  expect(await put(nina, { daily: false })).toMatchObject({ dayOff: true, daily: false });
  expect(await put(nina, { daily: true, off: false, hour: 7 })).toMatchObject({
    dayOff: false,
    dayHour: 7,
    daily: true,
  });
  expect(await (await owner(base)).json()).toMatchObject({ dayHour: 8, digestOff: true });
});

test("the workspace's two switches are saved by who configures it, and read by everyone", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const settings = `/api/app/organizations/${orgId}/settings`;
  expect(await (await owner(settings)).json()).toMatchObject({ teamWatch: true, welcomePeople: true });
  const saved = await owner(settings, { method: "PATCH", json: { teamWatch: false } });
  expect(await saved.json()).toMatchObject({ teamWatch: false, welcomePeople: true });
  const nina = await joinByInvitation(t, owner, orgId, "nina@example.com");
  expect(await (await nina(settings)).json()).toMatchObject({ teamWatch: false });
  expect((await nina(settings, { method: "PATCH", json: { welcomePeople: false } })).status).toBe(403);
});

test("one suggestion put away alone is not the card put away, and its proposal says why in words every build has", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const ownerId = ((await (await owner("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const { orgId, agentId, channelId: generalChannelId } = await seedOrg(owner);
  const base = `/api/app/organizations/${orgId}`;
  const [lodi] = await t.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  const dm = await openPersonAgentDm(t.db, orgId, ownerId, lodi.id);
  const { proposals } = await proposeSettings(
    { db: t.db },
    {
      orgId,
      agentId: lodi.id,
      targets: [{ agentId, lines: [{ field: "archive", to: true }] }],
      rationale: IDLE_REASON,
      requesterId: ownerId,
    },
  );
  const proposalId = proposals[0]?.id ?? "";
  const unanswered = `unanswered:${generalChannelId}`;
  const card = {
    kind: "team_week",
    forUserId: ownerId,
    period: "week",
    from: "2026-10-30",
    to: "2026-11-06",
    timezone: "UTC",
    stats: { done: 0, stuck: 0, waiting: 0, spentNanoUsd: 0, budgetNanoUsd: 0 },
    worked: [],
    rows: [{ id: unanswered, kind: "unanswered", channelId: generalChannelId, count: 4 }],
    moreRows: [
      { id: `retire:${agentId}`, kind: "retire", agentId, proposalId },
      { id: "waiting", kind: "waiting", count: 1, ids: ["n1"], agentId: null, since: "2026-11-05T12:00:00Z" },
    ],
    proposalIds: [proposalId],
    done: {},
    dismissedAt: null,
  };
  const [m] = await t.db
    .insert(schema.messages)
    .values({
      orgId,
      channelId: dm.id,
      authorType: "agent",
      authorAgentId: lodi.id,
      body: "card",
      meta: { actionCard: card },
    })
    .returning();
  const row = `${base}/team-week/${m?.id}`;
  const saved = async () => {
    const [after] = await t.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, m?.id ?? ""));
    return after?.meta.actionCard as {
      dismissedAt: string | null;
      done: Record<string, unknown>;
      skipped: Record<string, unknown>;
    };
  };

  // The proposal, read by its requester: its code, and the sentence for a build that has no words for the code.
  const listed = (await (await owner(`${base}/proposals?ids=${proposalId}`)).json()) as {
    proposals: { whyCode: string; why: string; canDecide: boolean }[];
  };
  expect(listed.proposals[0]).toMatchObject({ whyCode: "idle", why: IDLE_REASON, canDecide: true });

  // A row sent with the card's own word is refused whole: it is never read as "Agora não".
  expect((await owner(row, { json: { rowId: unanswered, dismiss: true } })).status).toBe(400);
  expect((await owner(row, { json: { dismiss: true, skip: true } })).status).toBe(400);
  expect((await saved()).dismissedAt).toBeNull();
  // Another person skips nothing here. A row of a later kind is found, and what only opens a screen is not applied.
  const nina = await joinByInvitation(t, owner, orgId, "nina@example.com");
  expect((await nina(row, { json: { rowId: unanswered, skip: true } })).status).toBe(403);
  expect((await owner(row, { json: { rowId: "waiting" } })).status).toBe(400);
  expect((await owner(row, { json: { rowId: "waiting", skip: true } })).status).toBe(400);

  expect((await owner(row, { json: { rowId: unanswered, skip: true } })).status).toBe(204);
  expect((await readLodiPrefs(t.db, orgId, ownerId)).prefs.muted).toEqual([unanswered]);
  expect((await owner(row, { json: { rowId: `retire:${agentId}`, skip: true } })).status).toBe(204);
  const [refused] = await t.db.select().from(schema.contextProposals).where(eq(schema.contextProposals.id, proposalId));
  expect(refused).toMatchObject({ status: "rejected", decidedByUserId: ownerId });
  const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  expect(agent?.archivedAt).toBeNull();
  const after = await saved();
  expect(after.dismissedAt).toBeNull();
  // Put away is kept apart from applied: a build from before reads any row in `done` as applied ("Asked Lodi").
  expect(Object.keys(after.skipped).sort()).toEqual([`retire:${agentId}`, unanswered].sort());
  expect(after.done).toEqual({});
  // And it is not applied afterwards, from a build that still draws its button.
  expect((await owner(row, { json: { rowId: unanswered, text: "An agent for #general, please" } })).status).toBe(409);
  // What I muted is not a setting of the screen: the prefs the apps read do not list it.
  expect(await (await owner(`${base}/team-week`)).json()).not.toHaveProperty("muted");
});
