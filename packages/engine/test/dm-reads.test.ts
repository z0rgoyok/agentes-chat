import { afterEach, describe, expect, test } from "bun:test";
import { dmReads, listDms, listMembers, markChannelRead, markThreadRead, openDm, postPersonMessage } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

describe('"Visto" in a DM between people', () => {
  test("reading the DM tells the other one; each sees only the others' reads", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const dm = await openDm(f.db, f.owner.id, f.org.id, { userId: bia.id });
    const events = f.listen(dm.id);
    expect(await dmReads(f.db, f.owner.id, f.org.id, dm.id)).toEqual([]);

    const at = new Date("2026-10-20T11:50:00.000Z");
    await markChannelRead(f.db, bia.id, f.org.id, dm.id, at, f.pubsub);
    expect(events).toContainEqual({
      type: "channel.read",
      channelId: dm.id,
      userId: bia.id,
      lastReadAt: at.toISOString(),
    });
    expect(await dmReads(f.db, f.owner.id, f.org.id, dm.id)).toEqual([
      { userId: bia.id, lastReadAt: at.toISOString() },
    ]);
    // Bia doesn't get her own read back.
    expect(await dmReads(f.db, bia.id, f.org.id, dm.id)).toEqual([]);
  });

  test("a channel never says who read what", async () => {
    f = await setup();
    const events = f.listen(f.general.id);
    await markChannelRead(f.db, f.owner.id, f.org.id, f.general.id, new Date(), f.pubsub);
    expect(events.filter((e) => e.type === "channel.read")).toEqual([]);
    expect(await dmReads(f.db, f.owner.id, f.org.id, f.general.id)).toEqual([]);
  });
});

describe("a DM's first visit (the right hand's wave, ADR 0137 §6)", () => {
  test("never read by me until I first read it, whatever the other one does", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const dm = await openDm(f.db, f.owner.id, f.org.id, { userId: bia.id });
    const everRead = async (userId: string) =>
      (await listDms(f.db, userId, f.org.id)).find((d) => d.channelId === dm.id)?.everRead;
    expect(await everRead(f.owner.id)).toBe(false);
    await markChannelRead(f.db, bia.id, f.org.id, dm.id);
    expect(await everRead(f.owner.id)).toBe(false);
    expect(await everRead(bia.id)).toBe(true);
    await markChannelRead(f.db, f.owner.id, f.org.id, dm.id);
    expect(await everRead(f.owner.id)).toBe(true);
  });
});

describe("a DM's unread count and its threads", () => {
  const deps = () => ({ db: f.db, pubsub: f.pubsub });
  const post = (userId: string, channelId: string, body: string, threadId?: string) =>
    postPersonMessage(deps(), userId, f.org.id, channelId, { body, ...(threadId ? { threadId } : {}) });
  /** PGlite counts whole milliseconds: what comes next lands after a read. */
  const nextMillisecond = () => Bun.sleep(2);
  async function withBia() {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await listMembers(f.db, f.org.id); // assigns handles: "@bia" resolves
    const dm = await openDm(f.db, f.owner.id, f.org.id, { userId: bia.id });
    const unread = async (userId: string) =>
      (await listDms(f.db, userId, f.org.id)).find((d) => d.channelId === dm.id)?.unread;
    const read = async (userId: string) => {
      await markChannelRead(f.db, userId, f.org.id, dm.id);
      await nextMillisecond();
    };
    return { bia, dm, unread, read };
  }

  test("a reply in a thread I started counts until I read the thread", async () => {
    const { bia, dm, unread, read } = await withBia();
    const root = await post(bia.id, dm.id, "Release checklist");
    await read(bia.id);
    await post(f.owner.id, dm.id, "first reply", root.id);
    await post(f.owner.id, dm.id, "second reply", root.id);
    expect(await unread(bia.id)).toBe(2);
    // The one who wrote them has only Bia's first message to read.
    expect(await unread(f.owner.id)).toBe(1);
    await read(f.owner.id);
    expect(await unread(f.owner.id)).toBe(0);

    await markThreadRead(deps(), bia.id, f.org.id, root.id);
    expect(await unread(bia.id)).toBe(0);
    await nextMillisecond();
    await post(f.owner.id, dm.id, "third reply", root.id);
    expect(await unread(bia.id)).toBe(1);
  });

  test("a reply in a thread I wrote in counts too", async () => {
    const { bia, dm, unread, read } = await withBia();
    const root = await post(f.owner.id, dm.id, "Ana's topic");
    await post(bia.id, dm.id, "my answer", root.id);
    await read(bia.id);
    await post(f.owner.id, dm.id, "a reply", root.id);
    expect(await unread(bia.id)).toBe(1);
    await markThreadRead(deps(), bia.id, f.org.id, root.id);
    expect(await unread(bia.id)).toBe(0);
  });

  test("a reply in a thread I don't follow counts only when it mentions me", async () => {
    const { bia, dm, unread, read } = await withBia();
    const root = await post(f.owner.id, dm.id, "Ana's topic");
    await read(bia.id);
    await post(f.owner.id, dm.id, "just a reply", root.id);
    expect(await unread(bia.id)).toBe(0);
    await post(f.owner.id, dm.id, "@bia can you check?", root.id);
    expect(await unread(bia.id)).toBe(1);
    await markThreadRead(deps(), bia.id, f.org.id, root.id);
    expect(await unread(bia.id)).toBe(0);
  });

  test("reading the DM clears a followed thread's reply from its count as well", async () => {
    const { bia, dm, unread, read } = await withBia();
    const root = await post(bia.id, dm.id, "Release checklist");
    await read(bia.id);
    await post(f.owner.id, dm.id, "a reply", root.id);
    expect(await unread(bia.id)).toBe(1);
    await read(bia.id);
    expect(await unread(bia.id)).toBe(0);
  });

  test("a message of the DM itself counts as before; reading the DM clears it, reading a thread doesn't", async () => {
    const { bia, dm, unread, read } = await withBia();
    const root = await post(bia.id, dm.id, "Release checklist");
    await read(bia.id);
    await post(f.owner.id, dm.id, "hello");
    await post(f.owner.id, dm.id, "are you there?");
    expect(await unread(bia.id)).toBe(2);
    await markThreadRead(deps(), bia.id, f.org.id, root.id);
    expect(await unread(bia.id)).toBe(2);
    await read(bia.id);
    expect(await unread(bia.id)).toBe(0);
  });
});
