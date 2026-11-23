import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, like, schema, sql } from "@agenteschat/db";
import {
  type Browser,
  browser,
  createTestServer,
  deletionCode,
  joinByInvitation,
  lastCode,
  seedOrg,
  signUp,
  type TestServer,
} from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

const resetOrg = (b: Browser, orgId: string, json: Record<string, unknown> = {}) =>
  b(`/api/app/organizations/${orgId}/reset`, { json });
const answer = async (res: Response) => [
  res.status,
  ((await res.json().catch(() => ({}))) as { error?: { code?: string } }).error?.code,
];

/** The code that resets `orgId`, emailed and read back as the person does; the last one taken as old. */
async function resetCode(b: Browser, orgId: string) {
  await t.db
    .update(schema.verifications)
    .set({ createdAt: new Date(Date.now() - 120_000) })
    .where(like(schema.verifications.identifier, "deletion-code:%"));
  const sent = await b(`/api/app/organizations/${orgId}/reset/code`, { json: {} });
  if (sent.status !== 202) throw new Error(`reset code: ${sent.status} ${await sent.text()}`);
  await t.drain();
  return lastCode(t);
}

test("an owner resets the workspace with its own code; it starts over with its people", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const ana = await joinByInvitation(t, owner, orgId, "ana@example.com");
  const app = `/api/app/organizations/${orgId}`;
  expect((await owner(`${app}/channels`, { json: { name: "launch" } })).status).toBe(201);
  expect((await owner(`${app}/channels/${channelId}/messages`, { json: { body: "old news" } })).status).toBe(201);

  expect(await answer(await resetOrg(ana, orgId))).toEqual([403, "forbidden"]);
  expect(await answer(await resetOrg(owner, orgId))).toEqual([403, "reauth.code"]);
  // A deletion's code resets nothing.
  const deleting = await deletionCode(t, owner, orgId);
  expect(await answer(await resetOrg(owner, orgId, { code: deleting }))).toEqual([400, "reauth.code_wrong"]);
  const code = await resetCode(owner, orgId);
  expect(t.email.sent.at(-1)?.subject).toContain(code);

  const res = await resetOrg(owner, orgId, { code });
  expect(res.status).toBe(202);
  expect(((await res.json()) as { reset: { startedAt: string } }).reset.startedAt).toBeString();
  await t.drain();

  const channels = await t.db.select().from(schema.channels).where(eq(schema.channels.orgId, orgId));
  expect(channels.map((c) => c.name)).toEqual(["general"]);
  const [org] = await t.db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
  expect([org?.resetRequestedAt, org?.onboardedAt]).toEqual([null, null]);
  const members = await t.db
    .select()
    .from(schema.organizationMembers)
    .where(eq(schema.organizationMembers.orgId, orgId));
  expect(members).toHaveLength(2);
  const audit = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, orgId));
  expect(audit.map((a) => a.action)).toEqual(
    expect.arrayContaining(["organization.reset_requested", "organization.reset"]),
  );
  // Spent: the same code resets nothing again.
  expect(await answer(await resetOrg(owner, orgId, { code }))).toEqual([400, "reauth.code_wrong"]);
});

test("a reset that fails to start doesn't count against the workspace's day", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  await t.db.execute(sql`create function refuse_reset() returns trigger language plpgsql as $$
    begin raise exception 'refused'; end $$`);
  await t.db.execute(sql`create trigger refuse_reset before update of reset_requested_at on organizations
    for each row when (new.reset_requested_at is not null) execute function refuse_reset()`);
  const res = await resetOrg(owner, orgId, { code: await resetCode(owner, orgId) });
  expect(res.status).toBe(500);
  const day = { limit: 1, windowMs: 86_400_000 };
  expect((await t.adapters.rateLimiter.consume(`org-reset:${orgId}`, day)).allowed).toBe(true);
});
