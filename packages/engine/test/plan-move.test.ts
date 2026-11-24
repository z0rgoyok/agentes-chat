import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  createOrganization,
  enableOperatorEvents,
  listMemberships,
  requestPlanMove,
  scheduleDeletion,
  setBillingHold,
  setOrgLimits,
} from "../src";
import { addMember, type Fixture, makeAdmin, setup } from "./fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
  enableOperatorEvents(true);
});
afterEach(async () => {
  enableOperatorEvents(false);
  await f.close();
});

const NO_LIMITS = {
  members: null,
  membersMax: null,
  storageBytes: null,
  uploadBytesPerDay: null,
  platformUsdPerMonth: null,
};
const refused = (call: Promise<unknown>) =>
  call.then(
    () => null,
    (error: { code?: string }) => error.code ?? String(error),
  );
const moves = () =>
  f.db.select().from(schema.operatorEvents).where(eq(schema.operatorEvents.type, "organization.plan_move_requested"));

test("its payer moves a plan to another workspace they manage billing in, one with no plan in force", async () => {
  const paid = f.org.id;
  await setOrgLimits(f.db, paid, { ...NO_LIMITS, payerUserId: f.owner.id });
  const other = (await createOrganization(f.db, f.owner.id, { name: "Other" })).organization.id;
  const active = (await createOrganization(f.db, f.owner.id, { name: "Active" })).organization.id;
  await setBillingHold({ db: f.db }, other, "payment");
  expect((await listMemberships(f.db, f.owner.id)).map((m) => [m.orgName, m.paysPlan])).toEqual([
    ["Acme", true],
    ["Other", false],
    ["Active", false],
  ]);

  // Not the payer, the same workspace, and into one whose plan is in force: refused, nothing told.
  const admin = await addMember(f.db, paid, "admin", "Ana");
  await f.db.insert(schema.organizationMembers).values({ orgId: other, userId: admin.id, role: "member" });
  await makeAdmin(f.db, other, admin.id);
  expect(await refused(requestPlanMove(f.db, { userId: admin.id, orgId: paid, to: other }))).toBe(
    "plan_move.not_payer",
  );
  expect(await refused(requestPlanMove(f.db, { userId: f.owner.id, orgId: paid, to: paid }))).toBe("plan_move.same");
  expect(await refused(requestPlanMove(f.db, { userId: f.owner.id, orgId: paid, to: active }))).toBe(
    "plan_move.target_has_plan",
  );
  expect(await moves()).toEqual([]);

  // Being deleted, the workspace it leaves still moves its plan; one being deleted takes none.
  await scheduleDeletion({ db: f.db, pubsub: f.pubsub }, f.owner.id, paid, "owner");
  await requestPlanMove(f.db, { userId: f.owner.id, orgId: paid, to: other });
  expect(await moves()).toMatchObject([{ orgId: paid, userId: f.owner.id, data: { to: other } }]);
  const audit = await f.db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, "billing.plan_move_requested"));
  expect(audit).toMatchObject([{ orgId: paid, actorId: f.owner.id }]);

  await setBillingHold({ db: f.db }, active, "payment");
  await scheduleDeletion({ db: f.db, pubsub: f.pubsub }, f.owner.id, active, "owner");
  expect(await refused(requestPlanMove(f.db, { userId: f.owner.id, orgId: paid, to: active }))).toBe(
    "plan_move.target_deleting",
  );
});
