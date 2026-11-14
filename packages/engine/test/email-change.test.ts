import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryRateLimiter } from "@agenteschat/adapters";
import { eq, like, schema } from "@agenteschat/db";
import {
  addressHeld,
  askEmailChange,
  changeAsked,
  finishEmailChange,
  pruneEmailChanges,
  sendDeletionCode,
  sendProofCode,
  spendDeletionCode,
  spendProofCode,
  undoEmailChange,
  undoneSince,
} from "../src";
import { addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const SERVER = "https://chat.example.com";
/** The real clock: the undo's mark is stamped by it whatever `now` the undo gets, so the rest counts from it too. */
const T0 = Date.now();
const at = (ms = 0) => new Date(T0 + ms);
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The notices to old addresses queued so far, oldest first. */
async function notices() {
  const jobs = await f.db.select().from(schema.outbox).where(like(schema.outbox.dedupeKey, "email:email-changed:%"));
  return jobs
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((job) => job.payload as { to: string[]; template: Record<string, string> });
}
const tokenOf = (notice: { template: Record<string, string> } | undefined) =>
  new URL(notice?.template.url ?? `${SERVER}/`).searchParams.get("token") ?? "";
const emailOf = async (userId: string) =>
  (await f.db.select().from(schema.users).where(eq(schema.users.id, userId)))[0];
/** The error code a call is refused with, or "ok". */
const answer = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e.code ?? String(e),
  );

/** A way the owner signs in, as Better Auth keeps it: a password (`credential`) or a provider. */
const signIn = (providerId: string, createdAt: Date, password: string | null = null) => ({
  id: `${providerId}-${createdAt.getTime()}`,
  accountId: providerId,
  providerId,
  userId: f.owner.id,
  password,
  createdAt,
  updatedAt: createdAt,
});

/**
 * `userId` moves to `to` as Better Auth's link does it, asked at `now` and opened at `opened`; then the notice's token.
 */
async function moveTo(userId: string, to: string, now: Date, opened = now) {
  const user = await emailOf(userId);
  await askEmailChange(f.db, { userId, from: user?.email ?? "", to, proven: true }, now);
  await f.db.update(schema.users).set({ email: to }).where(eq(schema.users.id, userId));
  const told = await finishEmailChange(
    { db: f.db, publicUrl: `${SERVER}/` },
    { ...user, id: userId, email: to },
    opened,
  );
  return { told, token: tokenOf((await notices()).at(-1)) };
}

describe("a new address for an account (ADR 0088 §2, addendum 2026-11-13)", () => {
  test("the address it left is told once, in the person's language, with “This wasn't me”", async () => {
    f = await setup();
    const from = f.owner.email;
    // Nothing asked: an update of the account tells nobody.
    expect(await finishEmailChange({ db: f.db, publicUrl: SERVER }, { ...f.owner, locale: "pt-BR" }, at())).toBe(false);
    const { told, token } = await moveTo(f.owner.id, "ana.nova@example.com", at());
    expect(told).toBe(true);
    const [notice] = await notices();
    expect(notice?.to).toEqual([from]);
    expect(notice?.template).toMatchObject({
      kind: "email_changed",
      locale: "pt-BR",
      email: from,
      newEmail: "ana.nova@example.com",
    });
    expect(notice?.template.url).toBe(`${SERVER}/email-undo?token=${token}`);
    expect(token.length).toBeGreaterThanOrEqual(40);
    // Kept as a hash only.
    const rows = await f.db.select().from(schema.verifications);
    expect(rows.some((r) => r.identifier.includes(token) || r.value.includes(token))).toBe(false);
    // Another update of the account (its name) is no change.
    expect(
      await finishEmailChange({ db: f.db, publicUrl: SERVER }, { ...f.owner, email: "ana.nova@example.com" }, at(1)),
    ).toBe(false);
    expect(await notices()).toHaveLength(1);
  });

  test("the address it left is held for it while its undo works: nobody else takes it", async () => {
    f = await setup();
    const from = f.owner.email;
    // Asked, not changed yet: the account still has it, so it's no hold.
    await askEmailChange(f.db, { userId: f.owner.id, from, to: "ana.nova@example.com", proven: true }, at());
    expect(await addressHeld(f.db, from, { now: at() })).toBe(false);
    await moveTo(f.owner.id, "ana.nova@example.com", at());
    expect(await addressHeld(f.db, from, { now: at(1) })).toBe(true);
    expect(await addressHeld(f.db, from.toUpperCase(), { now: at(1) })).toBe(true);
    // Not against the account that left it.
    expect(await addressHeld(f.db, from, { now: at(1), except: f.owner.id })).toBe(false);
    expect(await addressHeld(f.db, from, { now: at(7 * DAY + 1) })).toBe(false);
  });

  test("an address the account never proved is told nothing and held for nobody: its mailbox gets no undo", async () => {
    f = await setup();
    const from = f.owner.email;
    await askEmailChange(f.db, { userId: f.owner.id, from, to: "ana.nova@example.com", proven: false }, at());
    await f.db.update(schema.users).set({ email: "ana.nova@example.com" }).where(eq(schema.users.id, f.owner.id));
    const user = { ...f.owner, email: "ana.nova@example.com" };
    expect(await finishEmailChange({ db: f.db, publicUrl: SERVER }, user, at(1))).toBe(false);
    // The ask is spent all the same; no undo, no hold.
    const ids = (await f.db.select().from(schema.verifications)).map((r) => r.identifier);
    expect(ids.filter((id) => /^email-(change|held|undo):/.test(id))).toEqual([]);
    expect(await notices()).toEqual([]);
    expect(await addressHeld(f.db, from, { now: at(2) })).toBe(false);
  });

  test("a link goes on only for the change its account asked last, within its hour, until it's made", async () => {
    f = await setup();
    const from = f.owner.email;
    const bia = await addUser(f.db, "bia");
    expect(await changeAsked(f.db, from, "b@example.com", at())).toBe(false);
    await askEmailChange(f.db, { userId: f.owner.id, from, to: "b@example.com", proven: true }, at());
    expect(await changeAsked(f.db, from.toUpperCase(), "B@example.com", at(1))).toBe(true);
    // Another new address, or another account's link.
    expect(await changeAsked(f.db, from, "c@example.com", at(1))).toBe(false);
    expect(await changeAsked(f.db, bia.email, "b@example.com", at(1))).toBe(false);
    // A newer ask: the older link goes nowhere.
    await askEmailChange(f.db, { userId: f.owner.id, from, to: "c@example.com", proven: true }, at(2));
    expect(await changeAsked(f.db, from, "b@example.com", at(3))).toBe(false);
    expect(await changeAsked(f.db, from, "c@example.com", at(3))).toBe(true);
    expect(await changeAsked(f.db, from, "c@example.com", at(2 * HOUR + 3))).toBe(false);
    // Made, then undone: the account has `from` again, and the link that made it is spent.
    const { token } = await moveTo(f.owner.id, "c@example.com", at(4));
    expect(await changeAsked(f.db, from, "c@example.com", at(5))).toBe(false);
    await undoEmailChange(f.db, token, at(6));
    expect(await changeAsked(f.db, from, "c@example.com", at(7))).toBe(false);
  });

  test("“This wasn't me”: the address comes back confirmed, every session ends and every app is cut off, once", async () => {
    f = await setup();
    const from = f.owner.email;
    await f.db.insert(schema.accounts).values(signIn("credential", at(-DAY), "old-hash"));
    const { token } = await moveTo(f.owner.id, "thief@example.com", at());
    for (const n of [1, 2]) {
      await f.db.insert(schema.sessions).values({
        id: `s${n}`,
        token: `t${n}`,
        userId: f.owner.id,
        expiresAt: at(DAY),
      });
    }
    const [grant] = await f.db
      .insert(schema.appGrants)
      .values({
        orgId: f.org.id,
        userId: f.owner.id,
        kind: "token",
        displayKind: "token",
        displayName: "Laptop",
        scopes: ["read"],
      })
      .returning();
    await f.db.insert(schema.appTokens).values({
      orgId: f.org.id,
      grantId: grant?.id ?? "",
      kind: "personal",
      tokenHash: "h1",
      familyId: crypto.randomUUID(),
    });
    const undoing = Date.now();
    expect(await undoEmailChange(f.db, token, at(DAY))).toEqual({ email: from });
    expect(await emailOf(f.owner.id)).toMatchObject({ email: from, emailVerified: true });
    expect(await f.db.select().from(schema.sessions).where(eq(schema.sessions.userId, f.owner.id))).toEqual([]);
    const [revoked] = await f.db.select().from(schema.appGrants).where(eq(schema.appGrants.userId, f.owner.id));
    expect(revoked?.revokedAt).not.toBeNull();
    const [tokenRow] = await f.db.select().from(schema.appTokens);
    expect(tokenRow?.revokedAt).not.toBeNull();
    // Once: the same link again, or a made-up one, is gone.
    expect(await answer(undoEmailChange(f.db, token, at(DAY + 1)))).toBe("email.undo_gone");
    expect(await answer(undoEmailChange(f.db, "x".repeat(43), at(DAY + 1)))).toBe("email.undo_gone");
    // Back on the account, the address needs no hold.
    expect(await addressHeld(f.db, from, { now: at(DAY + 1) })).toBe(false);
    // The password from before goes too: whoever knew it would sign in afresh, and ask a new address without the code.
    const [password] = await f.db.select().from(schema.accounts).where(eq(schema.accounts.userId, f.owner.id));
    expect(password?.password).toBeNull();
    // A sign-in under way when it ran lands after it, and is told so; one begun after it isn't. Its mark keeps the
    // moment it was written, not the `now` it was given (a day ahead here).
    expect(await undoneSince(f.db, f.owner.id, undoing - 50)).toBe(true);
    expect(await undoneSince(f.db, f.owner.id, Date.now() + 2000)).toBe(false);
  });

  test("“This wasn't me” also takes every way in the other mailbox got since the change, and keeps the ones from before", async () => {
    f = await setup();
    await f.db.insert(schema.accounts).values([signIn("credential", at(-DAY), "old-hash"), signIn("google", at(-DAY))]);
    // Asked at 0, its link opened at 1.5 s: GitHub joined in between, by the session that asked, goes too.
    const { token } = await moveTo(f.owner.id, "thief@example.com", at(), at(1500));
    // Its holder: GitHub joined by that address, the password reset from there, another reset waiting, a phone.
    await f.db.insert(schema.accounts).values(signIn("github", at(1000)));
    await f.db
      .update(schema.accounts)
      .set({ password: "thief-hash", updatedAt: at(2000) })
      .where(eq(schema.accounts.providerId, "credential"));
    await f.db
      .insert(schema.verifications)
      .values({ id: "r1", identifier: "reset-password:waiting", value: f.owner.id, expiresAt: at(DAY) });
    await f.db
      .insert(schema.pushDevices)
      .values({ userId: f.owner.id, token: "ExponentPushToken[thief]", platform: "ios", locale: "pt-BR" });
    await undoEmailChange(f.db, token, at(3000));
    const left = await f.db.select().from(schema.accounts).where(eq(schema.accounts.userId, f.owner.id));
    // The password row stays, without a password: "Forgot my password" at the address that came back sets the next.
    expect(left.map((a) => `${a.providerId}:${a.password}`).sort()).toEqual(["credential:null", "google:null"]);
    expect(await f.db.select().from(schema.verifications).where(eq(schema.verifications.id, "r1"))).toEqual([]);
    expect(await f.db.select().from(schema.pushDevices)).toEqual([]);
  });

  test("it works for 7 days", async () => {
    f = await setup();
    const { token } = await moveTo(f.owner.id, "ana.nova@example.com", at());
    expect(await answer(undoEmailChange(f.db, token, at(7 * DAY + 1)))).toBe("email.undo_gone");
    expect((await emailOf(f.owner.id))?.email).toBe("ana.nova@example.com");
  });

  test("an older undo voids the newer ones, a newer one never voids the older", async () => {
    f = await setup();
    const a = f.owner.email;
    const first = await moveTo(f.owner.id, "x@example.com", at());
    const second = await moveTo(f.owner.id, "y@example.com", at(1000));
    // Whoever holds x@ (the second's undo) gets x@ back, and a@'s owner still gets a@ back after.
    expect(await undoEmailChange(f.db, second.token, at(2000))).toEqual({ email: "x@example.com" });
    expect(await undoEmailChange(f.db, first.token, at(3000))).toEqual({ email: a });

    const third = await moveTo(f.owner.id, "x@example.com", at(4000));
    const fourth = await moveTo(f.owner.id, "y@example.com", at(5000));
    expect(await undoEmailChange(f.db, third.token, at(6000))).toEqual({ email: a });
    // The later change's undo would hand x@ back: it's gone with it.
    expect(await answer(undoEmailChange(f.db, fourth.token, at(7000)))).toBe("email.undo_gone");
    expect((await emailOf(f.owner.id))?.email).toBe(a);
    expect(await addressHeld(f.db, "x@example.com", { now: at(8000) })).toBe(false);
  });

  test("an address another account has now changes nothing, and the link still works once it's free", async () => {
    f = await setup();
    const a = f.owner.email;
    const bia = await addUser(f.db, "bia");
    const { token } = await moveTo(f.owner.id, "x@example.com", at());
    await f.db.insert(schema.sessions).values({ id: "s1", token: "t1", userId: f.owner.id, expiresAt: at(DAY) });
    await f.db.update(schema.users).set({ email: a }).where(eq(schema.users.id, bia.id));
    expect(await answer(undoEmailChange(f.db, token, at(1000)))).toBe("email.undo_taken");
    expect((await emailOf(f.owner.id))?.email).toBe("x@example.com");
    expect(await f.db.select().from(schema.sessions)).toHaveLength(1);
    await f.db.update(schema.users).set({ email: bia.email }).where(eq(schema.users.id, bia.id));
    expect(await undoEmailChange(f.db, token, at(2000))).toEqual({ email: a });
  });

  test("the code for a new address goes to the current one, and is bound to that address and to nothing else", async () => {
    f = await setup();
    let now = T0;
    const deps = { db: f.db, rateLimiter: createMemoryRateLimiter(() => now) };
    const sent = await sendProofCode(
      deps,
      f.owner.id,
      "email",
      {
        bound: "ana.nova@example.com",
        template: (code, account) => ({
          kind: "email_change_code",
          locale: account.locale,
          code,
          email: account.email,
          newEmail: "ana.nova@example.com",
          support: null,
          url: SERVER,
        }),
      },
      at(),
    );
    expect(sent).toEqual({ email: f.owner.email, resendIn: 60 });
    const [mail] = await f.db.select().from(schema.outbox).where(like(schema.outbox.dedupeKey, "email:email-code:%"));
    const payload = mail?.payload as { to: string[]; template: Record<string, string> };
    expect(payload.to).toEqual([f.owner.email]);
    expect(payload.template).toMatchObject({ kind: "email_change_code", newEmail: "ana.nova@example.com" });
    const code = payload.template.code ?? "";
    // The same digits for another address, or for a deletion, are wrong (and count as wrong tries).
    expect(await answer(spendProofCode(deps, f.owner.id, "email", code, "other@example.com", at(1)))).toBe(
      "reauth.code_wrong",
    );
    expect(await answer(spendDeletionCode(deps, f.owner.id, null, code, at(2)))).toBe("reauth.code_wrong");
    expect(await answer(spendProofCode(deps, f.owner.id, "email", code, "ana.nova@example.com", at(3)))).toBe("ok");
    expect(await answer(spendProofCode(deps, f.owner.id, "email", code, "ana.nova@example.com", at(4)))).toBe(
      "reauth.code_wrong",
    );
    // A deletion's code proves no new address.
    now = T0 + 120_000;
    await sendDeletionCode({ ...deps, emails: { publicUrl: SERVER } }, f.owner.id, null, at(120_000));
    const [deletion] = await f.db
      .select()
      .from(schema.outbox)
      .where(like(schema.outbox.dedupeKey, "email:deletion-code:%"));
    const deletionCode = String((deletion?.payload as { template?: { code?: string } } | undefined)?.template?.code);
    expect(await answer(spendProofCode(deps, f.owner.id, "email", deletionCode, "", at(120_001)))).toBe(
      "reauth.code_wrong",
    );
    expect(await answer(spendDeletionCode(deps, f.owner.id, null, deletionCode, at(120_002)))).toBe("ok");
  });

  test("rows past their end go", async () => {
    f = await setup();
    const undone = await moveTo(f.owner.id, "x@example.com", at());
    await undoEmailChange(f.db, undone.token, at(1000));
    await moveTo(f.owner.id, "ana.nova@example.com", at(2000));
    await askEmailChange(
      f.db,
      { userId: f.owner.id, from: "ana.nova@example.com", to: "ana.outra@example.com", proven: true },
      at(2000),
    );
    const ours = async () =>
      (await f.db.select().from(schema.verifications)).filter((r) =>
        /^email-(change|held|undo|undone):/.test(r.identifier),
      );
    expect((await ours()).map((r) => r.identifier.split(":")[0])).toContain("email-undone");
    await pruneEmailChanges(f.db, at(DAY));
    // The change asked (2 h) and the undo's mark (10 minutes) go; the undo and its hold (7 days) stay.
    expect((await ours()).map((r) => r.identifier.split(":")[0]).sort()).toEqual(["email-held", "email-undo"]);
    await pruneEmailChanges(f.db, at(8 * DAY));
    expect(await ours()).toEqual([]);
  });
});
