import { afterEach, describe, expect, test } from "bun:test";
import { createFakeEmailSender } from "@agenteschat/adapters";
import { eq, like, schema } from "@agenteschat/db";
import {
  ACCOUNT_CONTACT_JOB,
  deleteAccount,
  enableAccountContacts,
  enqueueAccountContact,
  enqueueAccountContacts,
  finishEmailChange,
  joinOrganization,
  purgeWorkspace,
  removeMember,
  restoreAccount,
  saveAccountContact,
  scheduleAccountDeletion,
  setMyLocale,
  setOrgLimits,
  setUserBlocked,
  undoEmailChange,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

const CLOUD = "https://app.agentes.chat";
const NO_LIMITS = {
  members: null,
  membersMax: null,
  payerUserId: null,
  storageBytes: null,
  uploadBytesPerDay: null,
  platformUsdPerMonth: null,
};
const SELF_HOSTED = "https://chat.example.com";
const contacts = createFakeEmailSender();

let f: Fixture;
afterEach(async () => {
  enableAccountContacts(SELF_HOSTED, contacts);
  await f?.close();
});

const jobs = () => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, ACCOUNT_CONTACT_JOB));

/** Runs every queued `account.contact` job against a fresh fake sender, in order, and returns what it saved. */
async function sync() {
  const sender = createFakeEmailSender();
  for (const job of await jobs()) {
    await saveAccountContact(f.db, sender, job.payload as { userId: string; email: string });
  }
  await f.db.delete(schema.outbox).where(eq(schema.outbox.kind, ACCOUNT_CONTACT_JOB));
  return sender.contacts;
}

describe("account contacts", () => {
  test("self-hosted, or a provider without contacts: nothing is queued, at boot or on any change", async () => {
    f = await setup();
    enableAccountContacts(SELF_HOSTED, contacts);
    const ana = await addUser(f.db, "ana");
    await enqueueAccountContact(f.db, ana.id);
    expect(await enqueueAccountContacts(f.db)).toBe(0);
    await setMyLocale(f.db, ana.id, "en");
    await setUserBlocked(f, ana.id, { blocked: true, reason: null });
    expect(await jobs()).toEqual([]);
    enableAccountContacts(CLOUD, { saveContact: undefined });
    await enqueueAccountContact(f.db, ana.id);
    expect(await jobs()).toEqual([]);
  });

  test("a new account saves its creation date and language; a language change syncs again", async () => {
    f = await setup();
    enableAccountContacts(CLOUD, contacts);
    const ana = await addUser(f.db, "ana");
    await enqueueAccountContact(f.db, ana.id);
    const [row] = await f.db.select().from(schema.users).where(eq(schema.users.id, ana.id));
    expect(await sync()).toEqual([
      {
        email: ana.email,
        properties: { account_created_at: row?.createdAt.toISOString() ?? "", plan: null, locale: "pt-BR" },
      },
    ]);

    await setMyLocale(f.db, ana.id, "en");
    expect((await sync()).map((c) => c.properties.locale)).toEqual(["en"]);
  });

  test("no language: locale is left alone", async () => {
    f = await setup();
    enableAccountContacts(CLOUD, contacts);
    const ana = await addUser(f.db, "ana");
    await f.db.update(schema.users).set({ locale: null }).where(eq(schema.users.id, ana.id));
    await enqueueAccountContact(f.db, ana.id);
    expect(Object.keys((await sync())[0]?.properties ?? {})).toEqual(["account_created_at", "plan"]);
  });

  test("blocked, being deleted or gone: account_created_at and plan are cleared; let back or restored, they return", async () => {
    f = await setup();
    enableAccountContacts(CLOUD, contacts);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await setOrgLimits(f.db, f.org.id, { ...NO_LIMITS, payerUserId: f.owner.id });
    await sync();
    const cleared = [{ email: bia.email, properties: { account_created_at: null, plan: null } }];

    await setUserBlocked(f, bia.id, { blocked: true, reason: null });
    expect(await sync()).toEqual(cleared);
    await setUserBlocked(f, bia.id, { blocked: false, reason: null });
    expect((await sync())[0]?.properties.account_created_at).toEqual(expect.any(String));

    const deps = { db: f.db, pubsub: f.pubsub };
    await scheduleAccountDeletion(deps, bia.id);
    expect(await sync()).toEqual(cleared);
    await restoreAccount(deps, bia.id);
    expect((await sync())[0]?.properties).toMatchObject({ account_created_at: expect.any(String), plan: "paid" });

    await deleteAccount(f.db, bia.id, {});
    expect(await f.db.select().from(schema.users).where(eq(schema.users.id, bia.id))).toEqual([]);
    expect(await sync()).toEqual(cleared);
  });

  test("boot catch-up covers every account once; a restart with nothing changed queues nothing new", async () => {
    f = await setup();
    enableAccountContacts(CLOUD, contacts);
    await addUser(f.db, "ana");
    const count = (await f.db.select().from(schema.users)).length;
    expect(await enqueueAccountContacts(f.db)).toBe(count);
    expect(await jobs()).toHaveLength(count);
    await enqueueAccountContacts(f.db);
    expect(await jobs()).toHaveLength(count);
    await f.db
      .update(schema.organizations)
      .set({ payerUserId: f.owner.id })
      .where(eq(schema.organizations.id, f.org.id));
    await enqueueAccountContacts(f.db);
    expect(await jobs()).toHaveLength(count + 1);
  });

  test("plan is paid while the account is in a workspace with a payer: set and cleared by billing and membership", async () => {
    f = await setup();
    enableAccountContacts(CLOUD, contacts);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const planOf = async () => Object.fromEntries((await sync()).map((c) => [c.email, c.properties.plan]));

    await setOrgLimits(f.db, f.org.id, { ...NO_LIMITS, payerUserId: f.owner.id });
    expect(await planOf()).toEqual({ [f.owner.email]: "paid", [bia.email]: "paid" });
    await setOrgLimits(f.db, f.org.id, { ...NO_LIMITS, members: 5, payerUserId: f.owner.id });
    expect(await jobs()).toEqual([]);

    await removeMember(f.db, f.owner.id, f.org.id, bia.id);
    expect(await planOf()).toEqual({ [bia.email]: null });
    await joinOrganization(f.db, f.org.id, bia.id, "member");
    expect(await planOf()).toEqual({ [bia.email]: "paid" });

    await setOrgLimits(f.db, f.org.id, NO_LIMITS);
    expect(await planOf()).toEqual({ [f.owner.email]: null, [bia.email]: null });

    await setOrgLimits(f.db, f.org.id, { ...NO_LIMITS, payerUserId: f.owner.id });
    await sync();
    await f.db
      .update(schema.organizations)
      .set({ deletionDueAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.organizations.id, f.org.id));
    expect(await purgeWorkspace({ db: f.db, pubsub: f.pubsub }, f.org.id)).toBe(true);
    expect(await planOf()).toEqual({ [f.owner.email]: null, [bia.email]: null });
  });

  test("a new address carries the contact over: the one it left loses it, and gets it back with “This wasn't me”", async () => {
    f = await setup();
    enableAccountContacts(CLOUD, contacts);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await setOrgLimits(f.db, f.org.id, { ...NO_LIMITS, payerUserId: f.owner.id });
    await sync();
    const before = bia.email;
    const after = "bia.new@example.com";
    await f.db.insert(schema.verifications).values({
      id: "asked-bia",
      identifier: `email-change:${bia.id}`,
      value: JSON.stringify({ from: before, to: after, proven: true }),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await f.db.update(schema.users).set({ email: after }).where(eq(schema.users.id, bia.id));
    expect(await finishEmailChange({ db: f.db, publicUrl: CLOUD }, { id: bia.id, email: after })).toBe(true);
    const planOf = async () => Object.fromEntries((await sync()).map((c) => [c.email, c.properties.plan]));
    expect(await planOf()).toEqual({ [before]: null, [after]: "paid" });

    const [notice] = await f.db
      .select()
      .from(schema.outbox)
      .where(like(schema.outbox.dedupeKey, "email:email-changed:%"));
    const url = (notice?.payload as { template?: { url: string } } | undefined)?.template?.url ?? CLOUD;
    await undoEmailChange(f.db, new URL(url).searchParams.get("token") ?? "");
    expect(await planOf()).toEqual({ [after]: null, [before]: "paid" });
  });
});
