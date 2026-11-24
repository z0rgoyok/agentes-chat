import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Database, eq, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { createPostgresPresence, createPostgresRateLimiter } from "../src";

let db: Database;
let close: () => Promise<void>;
const stops: (() => void)[] = [];
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await close();
});

const presenceOf = (processId: string) => {
  const p = createPostgresPresence(db, processId);
  stops.push(p.stop);
  return p;
};

test("two processes answer the same who's online; a dead process's connections stop counting", async () => {
  const [org] = await db.insert(schema.organizations).values({ name: "Acme" }).returning();
  if (!org) throw new Error("no org");
  const a = presenceOf(crypto.randomUUID());
  const b = presenceOf(crypto.randomUUID());
  await a.connect(org.id, "ana", "c1");
  await b.connect(org.id, "ana", "c2");
  await b.connect(org.id, "bia", "c3");
  expect(await a.online(org.id)).toEqual(["ana", "bia"]);
  // Ana's tab on one process closes: her other one, on the other process, keeps her online.
  await a.disconnect(org.id, "ana", "c1");
  expect(await a.online(org.id)).toEqual(["ana", "bia"]);
  await b.disconnect(org.id, "ana", "c2");
  expect(await a.online(org.id)).toEqual(["bia"]);
  // b died without closing its sockets: its rows, no longer renewed, stop counting.
  await db
    .update(schema.presenceConnections)
    .set({ seenAt: new Date(Date.now() - 5 * 60_000) })
    .where(eq(schema.presenceConnections.connectionId, "c3"));
  expect(await a.online(org.id)).toEqual([]);
});

test("a limit is counted across processes; a socket's own frames are counted where the socket is", async () => {
  const a = createPostgresRateLimiter(db);
  const b = createPostgresRateLimiter(db);
  stops.push(a.stop, b.stop);
  const rule = { limit: 2, windowMs: 60_000 };
  expect((await a.consume("post:ana", rule)).allowed).toBe(true);
  // A try given back frees one, for every process.
  await b.release("post:ana");
  expect((await b.consume("post:ana", rule)).allowed).toBe(true);
  expect((await a.consume("post:ana", rule)).allowed).toBe(true);
  expect(await b.consume("post:ana", rule)).toMatchObject({ allowed: false, remaining: 0 });
  // A window that ended starts again.
  await db.update(schema.rateLimits).set({ resetAt: new Date(Date.now() - 1) });
  expect(await b.consume("post:ana", rule)).toMatchObject({ allowed: true, remaining: 1 });

  for (let i = 0; i < 2; i++) await a.consume("ws:c1", rule);
  expect((await b.consume("ws:c1", rule)).allowed).toBe(true);
  expect(await db.select().from(schema.rateLimits).where(eq(schema.rateLimits.key, "ws:c1"))).toEqual([]);
});
