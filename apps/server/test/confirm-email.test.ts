import { afterEach, expect, test } from "bun:test";
import {
  type Browser,
  browser,
  createTestServer,
  GOOGLE_ENV,
  googleSignIn,
  signUp,
  type TestServer,
  unconfirm,
} from "./harness";

/*
 * Sign-up asks for the confirmation link before a first workspace (ADR 0006, addendum 2026-11-22): on a server that
 * sends email, an account in no workspace makes none until its link is opened. Accounts already in one keep working.
 */

let t: TestServer;
afterEach(async () => {
  await t?.close();
});

const asked = async (b: Browser) =>
  ((await (await b("/api/app/me")).json()) as { user: { emailConfirmation: string | null; email: string } }).user;
const makeWorkspace = (b: Browser, name = "Acme") => b("/api/app/organizations", { json: { name, finished: true } });
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
/** The link that confirms `email`, from the newest email to it that carries one. */
async function confirmationLink(email: string) {
  await t.drain();
  const text = t.email.sent.filter((m) => m.to[0] === email && m.text.includes("/verify-email")).at(-1)?.text;
  const link = new URL(/https?:\/\/\S+\/api\/auth\/verify-email\S*/.exec(text ?? "")?.[0] ?? "");
  return `${link.pathname}${link.search}`;
}

test("a new account makes no workspace until it opens its link, which it may ask for again", async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, unconfirmedSignUps: true });
  const ana = browser(t);
  await signUp(ana, "ana@example.com");
  expect(await asked(ana)).toMatchObject({ emailConfirmation: "required" });
  const refused = await makeWorkspace(ana);
  expect([refused.status, await errorOf(refused)]).toEqual([403, "org.create_unconfirmed"]);

  // Another link, rate limited as every confirmation email is (email.test.ts).
  await t.drain();
  const before = t.email.sent.length;
  await Bun.sleep(1000 - (Date.now() % 1000));
  expect((await ana("/api/auth/send-verification-email", { json: { email: "ana@example.com" } })).status).toBe(200);
  await t.drain();
  expect(t.email.sent.length).toBe(before + 1);

  // Opened elsewhere (another device): this session asks again and moves on.
  expect((await browser(t)(await confirmationLink("ana@example.com"), { origin: null })).status).toBe(302);
  expect(await asked(ana)).toMatchObject({ emailConfirmation: null });
  expect((await makeWorkspace(ana)).status).toBe(201);
});

test("a mistyped address is changed in place and the new one gets the link", async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, unconfirmedSignUps: true });
  const ana = browser(t);
  await signUp(ana, "ana@exmaple.com");
  const changed = await ana("/api/app/account/email", { json: { newEmail: "ana@example.com" } });
  expect(await changed.json()).toEqual({ status: "changed", email: "ana@example.com" });
  expect(await asked(ana)).toMatchObject({ email: "ana@example.com", emailConfirmation: "required" });
  expect((await browser(t)(await confirmationLink("ana@example.com"), { origin: null })).status).toBe(302);
  expect((await makeWorkspace(ana)).status).toBe(201);
});

test("an account already in a workspace keeps it working, and may make more, with a reminder", async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  const ana = browser(t);
  await signUp(ana, "ana@example.com");
  const first = await makeWorkspace(ana);
  const { organization } = (await first.json()) as { organization: { id: string } };
  await unconfirm(t, "ana@example.com");
  expect(await asked(ana)).toMatchObject({ emailConfirmation: "reminder" });
  expect((await ana(`/api/app/organizations/${organization.id}/channels`)).status).toBe(200);
  expect((await makeWorkspace(ana, "Acme Labs")).status).toBe(201);
});

test("a provider that verified the address asks nothing", async () => {
  t = await createTestServer({ env: GOOGLE_ENV, unconfirmedSignUps: true });
  const { browser: ana } = await googleSignIn(t, "web", "ana@example.com");
  expect(await asked(ana)).toMatchObject({ emailConfirmation: null });
  expect((await makeWorkspace(ana)).status).toBe(201);
});

test("a server that sends no email can't send the link, and asks for none", async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, emailDelivers: false, unconfirmedSignUps: true });
  const ana = browser(t);
  await signUp(ana, "ana@example.com");
  expect(await asked(ana)).toMatchObject({ emailConfirmation: null });
  expect((await makeWorkspace(ana)).status).toBe(201);
});
