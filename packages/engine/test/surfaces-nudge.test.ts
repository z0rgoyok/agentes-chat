import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  claimLink,
  confirmLink,
  inQuietHours,
  listLinks,
  listSurfaceDeliveries,
  mintLinkCode,
  queueSurfaceNudges,
  setNudge,
  setSurface,
} from "../src";
import { type Fixture, setup } from "./fixtures";

const { surfaceDeliveries, surfaceLinks, notifications, pushDevices, organizationMembers } = schema;

let f: Fixture;
let linkId: string;
beforeEach(async () => {
  f = await setup({ rightHand: true });
  setSurface({
    id: "example chat",
    name: "Example Chat",
    openUrl: "https://chat.example.com/open?text={text}",
    only: null,
  });
  const { code } = await mintLinkCode(f.db, f.owner.id, f.org.id);
  const { link } = await claimLink({ db: f.db }, { externalId: "sender-9", display: null, profileName: null, code });
  await confirmLink({ db: f.db }, f.owner.id, link.id);
  await f.db.delete(surfaceDeliveries);
  linkId = link.id;
  // Wrote through the surface a day ago; the workspace's clock is UTC.
  await f.db
    .update(surfaceLinks)
    .set({ lastSeenAt: hoursAgo(24) })
    .where(eq(surfaceLinks.id, linkId));
  await f.db
    .update(organizationMembers)
    .set({ timezone: "UTC" })
    .where(and(eq(organizationMembers.orgId, f.org.id), eq(organizationMembers.userId, f.owner.id)));
});
afterEach(async () => {
  setSurface(null);
  await f.close();
});

/** 14:00 UTC, outside the default quiet hours (22 to 8). */
const NOON = new Date("2026-11-24T14:00:00Z");
function hoursAgo(h: number, from = new Date()) {
  return new Date(from.getTime() - h * 3_600_000);
}

async function unread(createdAt: Date, over: Partial<typeof notifications.$inferInsert> = {}) {
  await f.db.insert(notifications).values({
    orgId: f.org.id,
    userId: f.owner.id,
    kind: "agent_reply",
    groupKey: `test:${crypto.randomUUID()}`,
    createdAt,
    ...over,
  });
}

const nudges = () => f.db.select().from(surfaceDeliveries).where(eq(surfaceDeliveries.kind, "nudge"));
const seenAt = (at: Date) => f.db.update(surfaceLinks).set({ lastSeenAt: at }).where(eq(surfaceLinks.id, linkId));

describe("who gets a nudge, decided by core", () => {
  test("something unread for longer than the delay: one nudge, then none for a day", async () => {
    await seenAt(hoursAgo(24, NOON));
    await unread(hoursAgo(5, NOON));
    expect(await queueSurfaceNudges(f.db, NOON)).toBe(1);
    expect(await queueSurfaceNudges(f.db, new Date(NOON.getTime() + 23 * 3_600_000))).toBe(0);
    expect(await nudges()).toHaveLength(1);
    expect(await queueSurfaceNudges(f.db, new Date(NOON.getTime() + 25 * 3_600_000))).toBe(1);
  });

  test("not yet past the person's delay, or read, done or snoozed: nothing", async () => {
    await seenAt(hoursAgo(24, NOON));
    await unread(hoursAgo(3, NOON));
    await unread(hoursAgo(6, NOON), { readAt: NOON });
    await unread(hoursAgo(6, NOON), { doneAt: NOON });
    await unread(hoursAgo(6, NOON), { snoozedUntil: new Date(NOON.getTime() + 3_600_000) });
    expect(await queueSurfaceNudges(f.db, NOON)).toBe(0);
    await setNudge(f.db, f.owner.id, linkId, { afterHours: 2 });
    expect(await queueSurfaceNudges(f.db, NOON)).toBe(1);
  });

  test("quiet hours in the person's time zone, turned off, silent for 30 days, a phone that takes pushes", async () => {
    await seenAt(hoursAgo(24, NOON));
    await unread(hoursAgo(6, NOON));
    // 14:00 UTC is 23:00 in Tokyo.
    await f.db
      .update(organizationMembers)
      .set({ timezone: "Asia/Tokyo" })
      .where(eq(organizationMembers.userId, f.owner.id));
    expect(await queueSurfaceNudges(f.db, NOON)).toBe(0);
    await setNudge(f.db, f.owner.id, linkId, { quietFrom: 0, quietTo: 7 });
    await setNudge(f.db, f.owner.id, linkId, { on: false });
    expect(await queueSurfaceNudges(f.db, NOON)).toBe(0);
    await setNudge(f.db, f.owner.id, linkId, { on: true });
    await seenAt(hoursAgo(31 * 24, NOON));
    expect(await queueSurfaceNudges(f.db, NOON)).toBe(0);
    await seenAt(hoursAgo(24, NOON));
    await f.db
      .insert(pushDevices)
      .values({ userId: f.owner.id, token: "phone-1", platform: "ios", locale: "en", lastSeenAt: NOON });
    expect(await queueSurfaceNudges(f.db, NOON)).toBe(0);
    await f.db.delete(pushDevices);
    expect(await queueSurfaceNudges(f.db, NOON)).toBe(1);
  });

  test("quiet hours across midnight, within a day, and none", () => {
    expect([23, 2, 7, 8, 12].map((h) => inQuietHours(h, 22, 8))).toEqual([true, true, true, false, false]);
    expect([12, 13, 14].map((h) => inQuietHours(h, 13, 14))).toEqual([false, true, false]);
    expect(inQuietHours(3, 5, 5)).toBe(false);
  });
});

describe("what the service sees", () => {
  // These queue at the real clock, which may fall in the default quiet hours.
  beforeEach(() => setNudge(f.db, f.owner.id, linkId, { quietFrom: 0, quietTo: 0 }));

  test("only a service that asks lists nudges, with the counts as they are", async () => {
    await unread(hoursAgo(6));
    await unread(hoursAgo(6), { waiting: true, count: 2 });
    expect(await queueSurfaceNudges(f.db, new Date())).toBe(1);
    // An older service can't read the kind: it never sees one.
    expect(await listSurfaceDeliveries({ db: f.db }, 10)).toEqual([]);
    const [nudge] = await listSurfaceDeliveries({ db: f.db }, 10, { nudges: true });
    expect([nudge?.kind, nudge?.nudge, nudge?.orgName]).toEqual(["nudge", { unread: 3, waiting: 2 }, f.org.name]);
  });

  test("everything read before it is listed: dropped, not sent", async () => {
    await unread(hoursAgo(6));
    await queueSurfaceNudges(f.db, new Date());
    await f.db.update(notifications).set({ readAt: new Date() });
    expect(await listSurfaceDeliveries({ db: f.db }, 10, { nudges: true })).toEqual([]);
    expect((await nudges())[0]?.outcome).toBe("dropped");
  });
});

test("the person's settings: defaults on the link view, changed on their own active link only", async () => {
  expect((await listLinks(f.db, f.owner.id))[0]?.nudge).toEqual({ on: true, afterHours: 4, quietFrom: 22, quietTo: 8 });
  expect(await setNudge(f.db, f.owner.id, linkId, { afterHours: 8, quietFrom: 21 })).toEqual({
    on: true,
    afterHours: 8,
    quietFrom: 21,
    quietTo: 8,
  });
  expect(await setNudge(f.db, f.owner.id, linkId, {})).toMatchObject({ afterHours: 8, quietFrom: 21 });
  await expect(setNudge(f.db, "someone-else", linkId, {})).rejects.toMatchObject({ code: "surface.link_gone" });
  const other = await f.db.select().from(surfaceLinks);
  expect(other).toHaveLength(1);
  await expect(setNudge(f.db, "someone-else", linkId, { on: false })).rejects.toMatchObject({
    code: "surface.link_gone",
  });
});
