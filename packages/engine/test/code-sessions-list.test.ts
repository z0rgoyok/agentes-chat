import { afterEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { listCodeSessions } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const MIN = 60_000;

/** A session of the fixture's agent whose conversation holds messages written `minutesAgo`; the last one deleted. */
async function session(fx: Fixture, title: string, minutesAgo: number[], deleteLast = false) {
  const [channel] = await fx.db
    .insert(schema.channels)
    .values({ orgId: fx.org.id, name: title, kind: "code", visibility: "private", createdByUserId: fx.owner.id })
    .returning({ id: schema.channels.id });
  const channelId = channel?.id ?? "";
  await fx.db.insert(schema.channelMembers).values({ orgId: fx.org.id, channelId, userId: fx.owner.id });
  const ids: string[] = [];
  for (const [i, ago] of minutesAgo.entries()) {
    const [m] = await fx.db
      .insert(schema.messages)
      .values({
        orgId: fx.org.id,
        channelId,
        authorType: "person",
        authorUserId: fx.owner.id,
        body: `${title} ${i}`,
        createdAt: new Date(Date.now() - ago * MIN),
        ...(deleteLast && i === minutesAgo.length - 1 ? { deletedAt: new Date() } : {}),
      })
      .returning({ id: schema.messages.id });
    ids.push(m?.id ?? "");
  }
  await fx.db.insert(schema.codeSessions).values({
    orgId: fx.org.id,
    channelId,
    rootMessageId: ids[0] ?? "",
    agentId: fx.agent.id,
    repo: "acme/rockets",
    repoDir: "repos/acme/rockets",
    title,
    createdBy: fx.owner.id,
  });
}

test("each session's last activity is its conversation's newest message left, and the list sorts by it", async () => {
  f = await setup();
  await session(f, "older", [50, 40]);
  await session(f, "newer", [30, 10]);
  await session(f, "deleted", [60, 20, 1], true);
  const list = await listCodeSessions(f.db, f.owner.id, f.org.id);
  const minutesAgo = (iso: string) => Math.round((Date.now() - Date.parse(iso)) / MIN);
  expect(list.map((s) => [s.title, minutesAgo(s.lastAt)])).toEqual([
    ["newer", 10],
    ["deleted", 20],
    ["older", 40],
  ]);
});
