import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { changeMemberRole, enableCaches, getMembership, setUserBlocked } from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
  enableCaches();
});
afterEach(async () => {
  enableCaches(false);
  await f.close();
});

const roleOf = async (userId: string) => (await getMembership(f.db, userId, f.org.id))?.role ?? null;
const writeRole = (userId: string, role: "owner" | "member") =>
  f.db
    .update(schema.organizationMembers)
    .set({ role })
    .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, userId)));

test("a cached membership follows a role change and a block at once", async () => {
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  expect(await roleOf(bia.id)).toBe("member");

  await changeMemberRole(f.db, f.owner.id, f.org.id, bia.id, "owner");
  expect(await roleOf(bia.id)).toBe("owner");
  // Cached: a write that skips the engine's writers goes unseen until the entry expires.
  await writeRole(bia.id, "member");
  expect(await roleOf(bia.id)).toBe("owner");

  await setUserBlocked({ db: f.db, pubsub: f.pubsub }, bia.id, { blocked: true, reason: null });
  expect(await roleOf(bia.id)).toBeNull();
});

test("no membership is never kept: someone who just joined is let in at once", async () => {
  const caio = await addUser(f.db, "caio");
  expect(await roleOf(caio.id)).toBeNull();
  await f.db.insert(schema.organizationMembers).values({ orgId: f.org.id, userId: caio.id, role: "member" });
  expect(await roleOf(caio.id)).toBe("member");
});

test("a read inside a transaction that rolls back is not kept", async () => {
  const caio = await addUser(f.db, "caio");
  await f.db
    .transaction(async (tx) => {
      await tx.insert(schema.organizationMembers).values({ orgId: f.org.id, userId: caio.id, role: "member" });
      expect((await getMembership(tx, caio.id, f.org.id))?.role).toBe("member");
      tx.rollback();
    })
    .catch(() => {});
  expect(await roleOf(caio.id)).toBeNull();
});
