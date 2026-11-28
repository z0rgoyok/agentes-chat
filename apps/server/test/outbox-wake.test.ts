import { afterAll, beforeAll, expect, test } from "bun:test";
import { createPostgresPubSub, type PubSub } from "@agenteschat/adapters";
import { type Database, eq, schema } from "@agenteschat/db";
import { createTestDatabase, pgliteNotifier } from "@agenteschat/db/testing";
import { enqueue } from "@agenteschat/engine";
import { WAKE_TOPIC } from "../src/workers";

let db: Database;
let close: () => Promise<void>;
let pubsub: PubSub;
let wakes = 0;
beforeAll(async () => {
  const ctx = await createTestDatabase();
  if (!ctx.pglite) throw new Error("needs PGlite");
  db = ctx.db;
  pubsub = await createPostgresPubSub(pgliteNotifier(ctx.pglite));
  pubsub.subscribe(WAKE_TOPIC, () => void wakes++);
  close = async () => {
    await pubsub.close?.();
    await ctx.close();
  };
});
afterAll(async () => {
  await close();
});

const heard = async () => {
  await new Promise((r) => setTimeout(r, 50));
  const n = wakes;
  wakes = 0;
  return n;
};

test("a job due now wakes the workers once its transaction commits, once however many it queued", async () => {
  await db.transaction(async (tx) => {
    await enqueue(tx, { orgId: null, kind: "test.now", payload: { n: 1 } });
    await enqueue(tx, { orgId: null, kind: "test.now", payload: { n: 2 } });
    expect(await heard()).toBe(0);
  });
  expect(await heard()).toBe(1);
});

test("a job for later wakes nobody until it is made due now", async () => {
  await enqueue(db, { orgId: null, kind: "test.later", payload: {}, runAt: new Date(Date.now() + 60_000) });
  expect(await heard()).toBe(0);
  await db.update(schema.outbox).set({ nextAttemptAt: new Date() }).where(eq(schema.outbox.kind, "test.later"));
  expect(await heard()).toBe(1);
});

test("a job taken or finished wakes nobody", async () => {
  await db
    .update(schema.outbox)
    .set({ status: "processing", nextAttemptAt: new Date() })
    .where(eq(schema.outbox.kind, "test.now"));
  await db.update(schema.outbox).set({ status: "done" }).where(eq(schema.outbox.kind, "test.later"));
  expect(await heard()).toBe(0);
});
