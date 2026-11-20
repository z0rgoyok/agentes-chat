import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { createChannel, insertMessage, listMessages } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/** A link to a message opens it at any distance: the page around it by id, then pages forward from there. */

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

const start = Date.now() - 86_400_000;
/** `n` top-level messages in #general, one a second, oldest first. */
async function said(n: number) {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const m = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: `m${i}`,
      createdAt: new Date(start + i * 1000),
    });
    out.push(m.id);
  }
  return out;
}
const read = async (options: Parameters<typeof listMessages>[4], userId = f.owner.id) =>
  (await listMessages(f.db, userId, f.org.id, f.general.id, options)).map((m) => m.body);

test("around: the target in the middle of its page, however far back it is", async () => {
  const ids = await said(30);
  // Far older than the latest page of 10.
  expect(await read({ limit: 10 })).toEqual(Array.from({ length: 10 }, (_, i) => `m${20 + i}`));
  expect(await read({ around: ids[3], limit: 6 })).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"]);
  expect(await read({ around: ids[12], limit: 6 })).toEqual(["m9", "m10", "m11", "m12", "m13", "m14"]);
  // At either end, the page is what there is.
  expect(await read({ around: ids[0], limit: 6 })).toEqual(["m0", "m1", "m2"]);
  expect(await read({ around: ids[29], limit: 6 })).toEqual(["m26", "m27", "m28", "m29"]);
});

test("after: the oldest page past a time, oldest first, reaching the latest", async () => {
  await said(12);
  expect(await read({ after: new Date(start + 2000), limit: 3 })).toEqual(["m3", "m4", "m5"]);
  expect(await read({ after: new Date(start + 9000), limit: 5 })).toEqual(["m10", "m11"]);
});

test("around a deleted message, one in another channel or a thread's reply: not found", async () => {
  const ids = await said(3);
  const gone = ids[1] as string;
  await f.db.update(schema.messages).set({ deletedAt: new Date() }).where(eq(schema.messages.id, gone));
  await expect(read({ around: gone })).rejects.toThrow("Message not found");
  const other = await createChannel(f.db, f.owner.id, f.org.id, { name: "outro" });
  const there = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: other.id,
    author: { type: "person", userId: f.owner.id },
    body: "lá",
  });
  await expect(read({ around: there.id })).rejects.toThrow("Message not found");
  const reply = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    threadId: ids[0],
    author: { type: "person", userId: f.owner.id },
    body: "resposta",
  });
  await expect(read({ around: reply.id })).rejects.toThrow("Message not found");
});

test("around a message of a channel the person can't read: refused like any read of it", async () => {
  const ids = await said(2);
  const outsider = await addMember(f.db, f.org.id, "member", "fora");
  const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secreto", visibility: "private" });
  await expect(listMessages(f.db, outsider.id, f.org.id, secret.id, { around: ids[0] as string })).rejects.toThrow();
});
