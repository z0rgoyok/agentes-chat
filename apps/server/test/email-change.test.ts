import { afterEach, describe, expect, test } from "bun:test";
import { eq, like, schema } from "@agenteschat/db";
import { undoEmailChange } from "@agenteschat/engine";
import {
  type Browser,
  browser,
  createTestServer,
  fakeGoogle,
  GOOGLE_ENV,
  googleSignIn,
  lastCode,
  signUp,
  type TestServer,
} from "./harness";

/*
 * A new address for an account, made safe (ADR 0088 §2, addendum 2026-11-13): one door, the code sent to the current
 * address or a fresh sign-in, then the link to the new one, and "This wasn't me" for the old one.
 */

let t: TestServer;
afterEach(async () => {
  await t?.close();
});

const userOf = async (email: string) =>
  (await t.db.select().from(schema.users).where(eq(schema.users.email, email)))[0];
/** Signs up, then confirms the address as its link would: only a confirmed address is told, held and given an undo. */
async function signUpConfirmed(b: Browser, email: string) {
  await signUp(b, email);
  await t.db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.email, email));
}
/** The person signed in a while ago: past the 10 minutes when a sign-in stands in for the code. */
async function signedInLongAgo(email: string) {
  const user = await userOf(email);
  await t.db
    .update(schema.sessions)
    .set({ createdAt: new Date(Date.now() - 20 * 60_000) })
    .where(eq(schema.sessions.userId, user?.id ?? ""));
}
const change = (b: Browser, body: { newEmail: string; code?: string }) => b("/api/app/account/email", { json: body });
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
/** The emails sent to `to`, oldest first. */
const mailTo = (to: string) => t.email.sent.filter((m) => m.to.includes(to));
const linkIn = (text: string, path: string) => {
  const found = new RegExp(`https?://\\S+${path}\\S*`).exec(text)?.[0] ?? "";
  const url = new URL(found);
  return `${url.pathname}${url.search}`;
};
/** The link to `path` in the newest email to `to`. */
async function newestLink(to: string, path: string) {
  await t.drain();
  return linkIn(mailTo(to).at(-1)?.text ?? "", path);
}
/** Someone opens the link in the newest email to `to`: an address the link changes. */
const openLink = async (b: Browser, to: string) => b(await newestLink(to, "/api/auth/verify-email"), { origin: null });
/** The `token` of the link to `path` in the newest email to `to`: "This wasn't me", a new password. */
const tokenIn = async (to: string, path: string) =>
  new URL(`http://x${await newestLink(to, path)}`).searchParams.get("token") ?? "";
/** Where a link that no longer works lands. */
const DEAD_LINK = "/?email_confirmed=1&error=INVALID_TOKEN";
/** A minute after "This wasn't me": a sign-in or reset begun now began after it, past its second of slack. */
const aMinuteAfterTheUndo = () =>
  t.db
    .update(schema.verifications)
    .set({ createdAt: new Date(Date.now() - 60_000) })
    .where(like(schema.verifications.identifier, "email-undone:%"));

describe("one door", () => {
  test("Better Auth's own change-email answers nothing over HTTP, however it's spelled, and update-user refuses it", async () => {
    t = await createTestServer();
    const ana = browser(t);
    await signUp(ana, "ana@example.com");
    for (const path of [
      "/api/auth/change-email",
      "/api/auth/change-email/",
      "/api/auth//change-email",
      "/api/auth/Change-Email",
      "/api/auth/change%2Demail",
      "/api/auth/./change-email",
    ]) {
      const res = await ana(path, { json: { newEmail: "thief@example.com", callbackURL: "/" } });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    const update = await ana("/api/auth/update-user", { json: { email: "thief@example.com" } });
    expect(update.status).toBe(400);
    await t.drain();
    expect(mailTo("thief@example.com")).toEqual([]);
    expect((await userOf("ana@example.com"))?.id).toBeTruthy();
  });

  test("the address it already has is refused before any code goes, and a signed-out request is refused", async () => {
    t = await createTestServer();
    const ana = browser(t);
    await signUp(ana, "ana@example.com");
    const same = await change(ana, { newEmail: "ANA@example.com" });
    expect([same.status, await errorOf(same)]).toEqual([400, "email.same"]);
    const signedOut = await browser(t)("/api/app/account/email", { json: { newEmail: "x@example.com" } });
    expect(signedOut.status).toBe(401);
  });
});

describe("on a server that sends email", () => {
  test("a session that signed in a while ago gets a code at its current address, naming the new one", async () => {
    t = await createTestServer();
    const ana = browser(t);
    await signUpConfirmed(ana, "ana@example.com");
    await signedInLongAgo("ana@example.com");
    const asked = await change(ana, { newEmail: "ana.nova@example.com" });
    expect(asked.status).toBe(202);
    expect(await asked.json()).toEqual({ status: "code", email: "ana@example.com", resendIn: 60 });
    await t.drain();
    const mail = mailTo("ana@example.com").find((m) => /^\d{6} /.test(m.subject));
    expect(mail?.subject).toMatch(/^\d{6} é seu código para mudar seu e-mail$/);
    // Addresses in an email carry hair spaces, so no mail client makes them links.
    expect(mail?.text.replaceAll("\u200a", "")).toContain("ana.nova@example.com");
    expect(mailTo("ana.nova@example.com")).toEqual([]);
    const code = lastCode(t);

    // Without the code, a wrong one, or the code typed for another address: nothing changes, no link goes.
    const again = await change(ana, { newEmail: "ana.nova@example.com" });
    expect([again.status, await errorOf(again)]).toEqual([429, "reauth.code_wait"]);
    const wrong = await change(ana, {
      newEmail: "ana.nova@example.com",
      code: code === "000000" ? "000001" : "000000",
    });
    expect([wrong.status, await errorOf(wrong)]).toEqual([400, "reauth.code_wrong"]);
    const other = await change(ana, { newEmail: "thief@example.com", code });
    expect([other.status, await errorOf(other)]).toEqual([400, "reauth.code_wrong"]);
    await t.drain();
    expect(mailTo("thief@example.com")).toEqual([]);

    // The code for this address: the link goes to it, in a change's words, and the address waits for it.
    const right = await change(ana, { newEmail: "ana.nova@example.com", code });
    expect(right.status).toBe(200);
    expect(await right.json()).toEqual({ status: "sent", email: "ana.nova@example.com" });
    await t.drain();
    expect(mailTo("ana.nova@example.com").at(-1)?.subject).toBe("Confirme seu novo e-mail no agentes.chat");
    expect((await userOf("ana@example.com"))?.id).toBeTruthy();
    // Spent: it proves one change.
    const reused = await change(ana, { newEmail: "ana.nova@example.com", code });
    expect([reused.status, await errorOf(reused)]).toEqual([400, "reauth.code_wrong"]);

    // Opened: the same account under the new address, and the old one is told, with "This wasn't me".
    const before = await userOf("ana@example.com");
    expect((await openLink(browser(t), "ana.nova@example.com")).status).toBe(302);
    const after = await userOf("ana.nova@example.com");
    expect(after?.id).toBe(before?.id ?? "");
    expect(after?.emailVerified).toBe(true);
    await t.drain();
    const notice = mailTo("ana@example.com").at(-1);
    expect(notice?.subject).toBe("O e-mail da sua conta do agentes.chat mudou");
    expect(notice?.text).toContain("Não fui eu");
    expect(notice?.text).toMatch(/\/email-undo\?token=[\w-]{40,}/);
  });

  test("a sign-in in the last 10 minutes stands in for the code", async () => {
    t = await createTestServer();
    const ana = browser(t);
    await signUp(ana, "ana@example.com");
    const sent = await change(ana, { newEmail: "ana.nova@example.com" });
    expect(await sent.json()).toEqual({ status: "sent", email: "ana.nova@example.com" });
    await t.drain();
    expect(mailTo("ana@example.com").some((m) => /^\d{6} /.test(m.subject))).toBe(false);
    expect(mailTo("ana.nova@example.com")).toHaveLength(1);
  });

  test("an address the account never confirmed gets no code, and its mailbox no “This wasn't me” and no hold", async () => {
    t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
    const ana = browser(t);
    await signUp(ana, "ana@example.com");
    await signedInLongAgo("ana@example.com");
    // A code there would tell whoever holds that mailbox the new address: only a fresh sign-in proves it's the person.
    const stale = await change(ana, { newEmail: "ana.nova@example.com" });
    expect([stale.status, await errorOf(stale)]).toEqual([403, "reauth.sign_in"]);
    await t.drain();
    expect(mailTo("ana@example.com").some((m) => /^\d{6} /.test(m.subject))).toBe(false);

    const fresh = browser(t);
    const signIn = { email: "ana@example.com", password: "correct horse battery" };
    expect((await fresh("/api/auth/sign-in/email", { json: signIn })).status).toBe(200);
    const sent = await change(fresh, { newEmail: "ana.nova@example.com" });
    expect(await sent.json()).toEqual({ status: "sent", email: "ana.nova@example.com" });
    await t.drain();
    const told = mailTo("ana@example.com").length;
    expect((await openLink(browser(t), "ana.nova@example.com")).status).toBe(302);
    expect((await userOf("ana.nova@example.com"))?.id).toBeTruthy();
    await t.drain();
    expect(mailTo("ana@example.com")).toHaveLength(told);
    const undos = await t.db
      .select()
      .from(schema.verifications)
      .where(like(schema.verifications.identifier, "email-undo:%"));
    expect(undos).toEqual([]);
    // Whoever holds that mailbox may sign up with it at once.
    const someone = await browser(t)("/api/auth/sign-up/email", {
      json: { email: "ana@example.com", password: "correct horse battery", name: "Someone" },
    });
    expect(someone.status).toBe(200);
  });

  test("“This wasn't me” brings the old address back and ends every session, once, and only by its button", async () => {
    t = await createTestServer();
    const ana = browser(t);
    await signUpConfirmed(ana, "ana@example.com");
    const userId = (await userOf("ana@example.com"))?.id ?? "";
    await change(ana, { newEmail: "thief@example.com" });
    await openLink(browser(t), "thief@example.com");
    const token = await tokenIn("ana@example.com", "/email-undo");
    expect(token).not.toBe("");
    expect(await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId))).not.toEqual([]);

    // Opening the link is the web app's page: no route acts on a GET.
    expect((await browser(t)(`/api/app/email-undo?token=${token}`)).status).toBe(404);
    const undo = await browser(t)("/api/app/email-undo", { json: { token } });
    expect(undo.status).toBe(200);
    expect(await undo.json()).toEqual({ email: "ana@example.com" });
    expect(await userOf("ana@example.com")).toMatchObject({ id: userId, emailVerified: true });
    expect(await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId))).toEqual([]);
    const twice = await browser(t)("/api/app/email-undo", { json: { token } });
    expect([twice.status, await errorOf(twice)]).toEqual([404, "email.undo_gone"]);
  });

  test("a link changes the address once: not after a newer ask, and never again after “This wasn't me”", async () => {
    t = await createTestServer();
    const ana = browser(t);
    await signUpConfirmed(ana, "ana@example.com");
    const userId = (await userOf("ana@example.com"))?.id ?? "";
    await change(ana, { newEmail: "ana.antigo@example.com" });
    const older = await newestLink("ana.antigo@example.com", "/api/auth/verify-email");
    await change(ana, { newEmail: "thief@example.com" });
    const refused = await browser(t)(older, { origin: null });
    expect([refused.status, refused.headers.get("location")]).toEqual([302, DEAD_LINK]);
    expect((await userOf("ana@example.com"))?.id).toBe(userId);

    const link = await newestLink("thief@example.com", "/api/auth/verify-email");
    expect((await browser(t)(link, { origin: null })).status).toBe(302);
    expect((await userOf("thief@example.com"))?.id).toBe(userId);
    const token = await tokenIn("ana@example.com", "/email-undo");
    expect((await browser(t)("/api/app/email-undo", { json: { token } })).status).toBe(200);
    const told = mailTo("ana@example.com").length;

    // The same link again, within its hour: the address stays, nobody signs in, nobody is told.
    const replay = await browser(t)(link, { origin: null });
    expect([replay.status, replay.headers.get("location")]).toEqual([302, DEAD_LINK]);
    expect((await userOf("ana@example.com"))?.id).toBe(userId);
    expect(await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId))).toEqual([]);
    await t.drain();
    expect(mailTo("ana@example.com")).toHaveLength(told);
  });

  test("“This wasn't me” also takes the ways in the other mailbox got: Google by its address, a password, a reset link", async () => {
    t = await createTestServer({ env: GOOGLE_ENV });
    const ana = browser(t);
    await signUpConfirmed(ana, "ana@example.com");
    const userId = (await userOf("ana@example.com"))?.id ?? "";
    await change(ana, { newEmail: "thief@example.com" });
    await openLink(browser(t), "thief@example.com");
    const undoToken = await tokenIn("ana@example.com", "/email-undo");

    // Its holder: Google by that address joins the account, a reset from there sets a password, another one waits.
    const google = await googleSignIn(t, "web", "thief@example.com");
    expect(((await (await google.browser("/api/app/me")).json()) as { user: { id: string } }).user.id).toBe(userId);
    const thief = browser(t);
    const reset = { email: "thief@example.com", redirectTo: "/reset-password" };
    await thief("/api/auth/request-password-reset", { json: reset });
    const first = await tokenIn("thief@example.com", "/reset-password");
    const password = { token: first, newPassword: "the other one's password" };
    expect((await thief("/api/auth/reset-password", { json: password })).status).toBe(200);
    await thief("/api/auth/request-password-reset", { json: reset });
    const waiting = await tokenIn("thief@example.com", "/reset-password");

    expect((await browser(t)("/api/app/email-undo", { json: { token: undoToken } })).status).toBe(200);
    await aMinuteAfterTheUndo();
    const again = await googleSignIn(t, "web", "thief@example.com");
    expect((await again.browser("/api/app/me")).status).toBe(401);
    const signIn = { email: "ana@example.com", password: password.newPassword };
    expect((await browser(t)("/api/auth/sign-in/email", { json: signIn })).status).toBe(401);
    const late = await thief("/api/auth/reset-password", { json: { token: waiting, newPassword: "yet another one" } });
    expect(late.status).toBe(400);

    // "Forgot my password" at the address that came back sets the next one.
    await browser(t)("/api/auth/request-password-reset", { json: { ...reset, email: "ana@example.com" } });
    const mine = { token: await tokenIn("ana@example.com", "/reset-password"), newPassword: "ana's own password" };
    expect((await browser(t)("/api/auth/reset-password", { json: mine })).status).toBe(200);
    const back = await browser(t)("/api/auth/sign-in/email", {
      json: { email: "ana@example.com", password: mine.newPassword },
    });
    expect(back.status).toBe(200);
  });

  test("the old address is held while its undo works: no sign-up, no other account's change", async () => {
    t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
    const ana = browser(t);
    await signUpConfirmed(ana, "ana@example.com");
    await change(ana, { newEmail: "ana.nova@example.com" });
    await openLink(browser(t), "ana.nova@example.com");
    const someone = browser(t);
    const signUpRes = await someone("/api/auth/sign-up/email", {
      json: { email: "ana@example.com", password: "correct horse battery", name: "Someone" },
    });
    expect(signUpRes.status).toBe(403);
    expect(((await signUpRes.json()) as { code: string }).code).toBe("EMAIL_HELD");
    const bia = browser(t);
    await signUp(bia, "bia@example.com");
    const taken = await change(bia, { newEmail: "ana@example.com" });
    expect([taken.status, await errorOf(taken)]).toEqual([409, "email.held"]);
    // Not against the account that left it.
    const back = await change(ana, { newEmail: "ana@example.com" });
    expect(back.status).toBe(200);
  });

  test("“This wasn't me” takes 10 tries per 10 minutes from one address", async () => {
    t = await createTestServer();
    const b = browser(t);
    for (let i = 0; i < 10; i++) {
      const res = await b("/api/app/email-undo", { json: { token: `made-up-token-${i}-xxxxxxxx` } });
      expect(res.status).toBe(404);
    }
    const limited = await b("/api/app/email-undo", { json: { token: "made-up-token-10-xxxxxxxx" } });
    expect([limited.status, await errorOf(limited)]).toEqual([429, "rate_limited"]);
  });
});

describe("after “This wasn't me”, nothing the other person has or began goes on", () => {
  const sessionsOf = (userId: string) => t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId));
  const providersOf = async (userId: string) =>
    (await t.db.select().from(schema.accounts).where(eq(schema.accounts.userId, userId))).map((a) => a.providerId);
  const undo = (token: string) => browser(t)("/api/app/email-undo", { json: { token } });
  const signIn = (email: string, password: string) =>
    browser(t)("/api/auth/sign-in/email", { json: { email, password } });
  /** Ana's account, moved to thief@ by its link opened in the other person's browser, which that signs in. */
  async function movedToThief(env: Record<string, string> = {}) {
    t = await createTestServer({ env });
    const ana = browser(t);
    await signUpConfirmed(ana, "ana@example.com");
    const userId = (await userOf("ana@example.com"))?.id ?? "";
    await change(ana, { newEmail: "thief@example.com" });
    const thief = browser(t);
    await openLink(thief, "thief@example.com");
    return { ana, thief, userId, undoToken: await tokenIn("ana@example.com", "/email-undo") };
  }
  /** Google's return to `b` for `state`, as thief@. */
  async function backFromGoogle(b: Browser, state: string) {
    const real = globalThis.fetch;
    globalThis.fetch = fakeGoogle("thief@example.com");
    try {
      return await b(`/api/auth/callback/google?code=c0de&state=${state}`, { origin: null });
    } finally {
      globalThis.fetch = real;
    }
  }

  test("their browser is signed out at once: no app, token, phone or provider after it", async () => {
    const { ana, thief, userId, undoToken } = await movedToThief(GOOGLE_ENV);
    const created = await ana("/api/app/organizations", { json: { name: "Acme" } });
    const orgId = ((await created.json()) as { organization: { id: string } }).organization.id;
    expect((await thief("/api/app/me")).status).toBe(200);

    expect((await undo(undoToken)).status).toBe(200);
    expect((await thief("/api/app/me")).status).toBe(401);
    const grant = { name: "Backup", access: "write", expiresInDays: 365 };
    expect((await thief(`/api/app/organizations/${orgId}/tokens`, { json: grant })).status).toBe(401);
    const phone = { platform: "android", token: "fcm-thief-device-token-0000000000", locale: "pt-BR" };
    expect((await thief("/api/app/push/devices", { json: phone })).status).toBe(401);
    const link = await thief("/api/auth/link-social", { json: { provider: "google", callbackURL: "/" } });
    expect(link.status).toBe(401);
    expect(await t.db.select().from(schema.appGrants).where(eq(schema.appGrants.userId, userId))).toEqual([]);
    expect(await t.db.select().from(schema.pushDevices).where(eq(schema.pushDevices.userId, userId))).toEqual([]);
    expect(await providersOf(userId)).toEqual(["credential"]);
  });

  test("the password they knew is cleared, and “Forgot my password” at the address that came back sets the next", async () => {
    t = await createTestServer();
    await signUpConfirmed(browser(t), "ana@example.com");
    // They know it: a fresh sign-in, so the new address needs no code.
    const known = "correct horse battery";
    const thief = browser(t);
    expect(
      (await thief("/api/auth/sign-in/email", { json: { email: "ana@example.com", password: known } })).status,
    ).toBe(200);
    expect(await (await change(thief, { newEmail: "thief@example.com" })).json()).toMatchObject({ status: "sent" });
    await openLink(browser(t), "thief@example.com");
    expect((await undo(await tokenIn("ana@example.com", "/email-undo"))).status).toBe(200);

    await aMinuteAfterTheUndo();
    expect((await signIn("ana@example.com", known)).status).toBe(401);
    const reset = { email: "ana@example.com", redirectTo: "/reset-password" };
    await browser(t)("/api/auth/request-password-reset", { json: reset });
    const next = { token: await tokenIn("ana@example.com", "/reset-password"), newPassword: "ana's own password" };
    expect((await browser(t)("/api/auth/reset-password", { json: next })).status).toBe(200);
    expect((await signIn("ana@example.com", next.newPassword)).status).toBe(200);
  });

  test("a password sign-in under way when it runs gets no session", async () => {
    const { userId, undoToken } = await movedToThief();
    const context = await t.auth.$context;
    const verify = context.password.verify;
    let undone = 0;
    // The sign-in found the account and its password before the undo; its session lands after it.
    context.password.verify = async (input) => {
      context.password.verify = verify;
      undone = (await undo(undoToken)).status;
      return verify(input);
    };
    const racer = browser(t);
    const res = await racer("/api/auth/sign-in/email", {
      json: { email: "thief@example.com", password: "correct horse battery" },
    });
    expect(undone).toBe(200);
    expect(res.status).toBe(401);
    expect(await sessionsOf(userId)).toEqual([]);
    expect((await change(racer, { newEmail: "thief2@example.com" })).status).toBe(401);
  });

  test("a password sign-in under way gets no session, even when the undo's clock read 1.5 s before it began", async () => {
    const { userId, undoToken } = await movedToThief();
    const context = await t.auth.$context;
    const verify = context.password.verify;
    const began = Date.now();
    // A commit that waited, or another replica's clock: the mark counts from when it was written, not from `now`.
    context.password.verify = async (input) => {
      context.password.verify = verify;
      await undoEmailChange(t.db, undoToken, new Date(began - 1500));
      return verify(input);
    };
    const res = await browser(t)("/api/auth/sign-in/email", {
      json: { email: "thief@example.com", password: "correct horse battery" },
    });
    expect(res.status).toBe(401);
    expect(await sessionsOf(userId)).toEqual([]);
  });

  test("a Google sign-in that found the account before it joins nothing and gets no session", async () => {
    const { userId, undoToken } = await movedToThief(GOOGLE_ENV);
    const context = await t.auth.$context;
    const find = context.internalAdapter.findUserByEmail;
    let undone = 0;
    context.internalAdapter.findUserByEmail = async (email, options) => {
      const found = await find(email, options);
      if (email === "thief@example.com" && !undone) undone = (await undo(undoToken)).status;
      return found;
    };
    try {
      const google = await googleSignIn(t, "web", "thief@example.com");
      expect(undone).toBe(200);
      expect(new URL(google.location, "http://x").pathname).toBe("/login");
    } finally {
      context.internalAdapter.findUserByEmail = find;
    }
    expect(await sessionsOf(userId)).toEqual([]);
    expect(await providersOf(userId)).toEqual(["credential"]);
  });

  test("a link to Google asked before it, back from Google after it, joins nothing", async () => {
    const { thief, userId, undoToken } = await movedToThief(GOOGLE_ENV);
    const asked = await thief("/api/auth/link-social", { json: { provider: "google", callbackURL: "/" } });
    expect(asked.status).toBe(200);
    const state = new URL(((await asked.json()) as { url: string }).url).searchParams.get("state") ?? "";
    expect((await undo(undoToken)).status).toBe(200);
    // Google's page took a moment: its return began well after the undo, and needs no session.
    await Bun.sleep(1100);
    await backFromGoogle(thief, state);
    expect(await providersOf(userId)).toEqual(["credential"]);
    const later = await googleSignIn(t, "web", "thief@example.com");
    expect((await later.browser("/api/app/me")).status).toBe(401);
  });

  test("a reset under way when it runs leaves no password", async () => {
    const { thief, undoToken } = await movedToThief();
    await thief("/api/auth/request-password-reset", {
      json: { email: "thief@example.com", redirectTo: "/reset-password" },
    });
    const token = await tokenIn("thief@example.com", "/reset-password");
    const context = await t.auth.$context;
    const update = context.internalAdapter.updatePassword;
    let undone = 0;
    // Its link was spent before the undo dropped it; its new password lands after the undo cleared the old.
    context.internalAdapter.updatePassword = async (userId, password) => {
      context.internalAdapter.updatePassword = update;
      undone = (await undo(undoToken)).status;
      return update(userId, password);
    };
    const res = await thief("/api/auth/reset-password", { json: { token, newPassword: "the other one's password" } });
    expect(undone).toBe(200);
    expect(res.status).toBe(401);
    await aMinuteAfterTheUndo();
    expect((await signIn("ana@example.com", "the other one's password")).status).toBe(401);
  });

  test("a new password under way when it runs is cleared", async () => {
    const { thief, undoToken } = await movedToThief();
    const context = await t.auth.$context;
    const hash = context.password.hash;
    let undone = 0;
    // The request read its session before the undo; its password lands after it.
    context.password.hash = async (password) => {
      context.password.hash = hash;
      undone = (await undo(undoToken)).status;
      return hash(password);
    };
    const res = await thief("/api/app/me/password", { json: { password: "the other one's password" } });
    expect(undone).toBe(200);
    expect(res.status).toBe(401);
    await aMinuteAfterTheUndo();
    expect((await signIn("ana@example.com", "the other one's password")).status).toBe(401);
  });
});

describe("a made-up change link", () => {
  test("addresses that aren't text land where a dead link does", async () => {
    t = await createTestServer();
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const claims of [
      { email: { toString: 1 }, updateTo: "x@example.com" },
      { email: [{ toString: 1 }], updateTo: "x@example.com" },
      { email: "ana@example.com", updateTo: { toString: 1 } },
    ]) {
      const token = `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}.x`;
      const res = await browser(t)(`/api/auth/verify-email?token=${token}`, { origin: null });
      expect({ claims, at: [res.status, res.headers.get("location")] }).toEqual({ claims, at: [302, DEAD_LINK] });
    }
  });
});

describe("on a server that sends no email", () => {
  test("the address changes at once, as before, with no code and nobody told", async () => {
    t = await createTestServer({ emailDelivers: false, env: { ALLOW_SIGNUP: "true" } });
    const ana = browser(t);
    await signUp(ana, "ana@example.com");
    await signedInLongAgo("ana@example.com");
    const res = await change(ana, { newEmail: "ana.nova@example.com" });
    expect(await res.json()).toEqual({ status: "changed", email: "ana.nova@example.com" });
    expect((await userOf("ana.nova@example.com"))?.id).toBeTruthy();
    await t.drain();
    expect(t.email.sent).toEqual([]);

    // Another account's address: said, since nothing changed.
    const bia = browser(t);
    await signUp(bia, "bia@example.com");
    const taken = await change(bia, { newEmail: "ana.nova@example.com" });
    expect([taken.status, await errorOf(taken)]).toEqual([409, "email.taken"]);
    // An address a sign-in provider confirmed needs email to change.
    await t.db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.email, "bia@example.com"));
    const confirmed = await change(bia, { newEmail: "bia.nova@example.com" });
    expect([confirmed.status, await errorOf(confirmed)]).toEqual([409, "email.no_mail"]);
  });
});
