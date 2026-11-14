import { afterEach, expect, test } from "bun:test";
import type { HumanAction, HumanCheck } from "@agenteschat/adapters";
import { ConfigError } from "@agenteschat/config";
import { schema } from "@agenteschat/db";
import { checkHumanCheckAtBoot } from "../src/http/human-check";
import { createHumanPasses } from "../src/http/human-pass";
import { createLogger } from "../src/logger";
import {
  type Browser,
  browser,
  createTestServer,
  fakeCloudflare,
  seedOrg,
  type TestServer,
  TURNSTILE_TEST_TOKEN,
  tokenMadeOn,
  turnstileCheck,
} from "./harness";

/** The landing page's own site (`LANDING_URL`), and the host its widget runs on. */
const LANDING = "https://agentes.example";
const LANDING_HOST = "agentes.example";
/** `PUBLIC_URL`'s host here (the harness's `ORIGIN`). */
const APP_HOST = "localhost";

const turnstile = (fetch: typeof globalThis.fetch) => turnstileCheck(fetch, { LANDING_URL: LANDING });

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});

const codeOf = async (res: Response) => {
  const body = (await res.json()) as { code?: string; error?: { code: string } };
  return body.error?.code ?? body.code;
};
const passing = { "x-captcha-response": TURNSTILE_TEST_TOKEN };
const signUpPassing = (b: Browser, email: string) =>
  b("/api/auth/sign-up/email", {
    json: { email, password: "correct horse battery", name: email.split("@")[0] },
    headers: passing,
  });

/**
 * The guarded calls, each from a fresh browser with the `headers` for its action: one per action, and the partner
 * list's, which takes the waiting list's.
 */
async function guardedCalls(token: string, headers: (action: HumanAction) => Record<string, string>) {
  const call = (action: HumanAction, path: string, json: unknown) =>
    browser(t)(path, { json, headers: headers(action) });
  return {
    "email-lookup": await call("email-lookup", "/api/app/sign-in-options", { email: "owner@example.com" }),
    "sign-in": await call("sign-in", "/api/auth/sign-in/email", {
      email: "owner@example.com",
      password: "correct horse battery",
    }),
    "sign-up": await call("sign-up", "/api/auth/sign-up/email", {
      email: "new@example.com",
      password: "correct horse battery",
      name: "New",
    }),
    "password-reset": await call("password-reset", "/api/auth/request-password-reset", {
      email: "owner@example.com",
      redirectTo: "/reset-password",
    }),
    "ask-code": await call("ask-code", `/api/app/invitations/${token}/code`, { email: "ana@example.com" }),
    waitlist: await call("waitlist", "/api/waitlist", { email: "ana@example.com" }),
    partners: await call("waitlist", "/api/partners/waitlist", {
      email: "ana@example.com",
      name: "Ana",
      whatsapp: "+5511912345678",
    }),
  };
}
/** The same headers on every call. */
const every = (headers: Record<string, string>) => () => headers;
/** On each call, a token made on `host` for its own action. */
const madeOn = (host: string) => (action: HumanAction) => ({ "x-captcha-response": tokenMadeOn(host, action) });
/** Each call's status, or its refusal's code. */
const outcomes = async (calls: Record<string, Response>) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(calls).map(async ([call, res]) => [call, res.ok ? res.status : await codeOf(res)]),
    ),
  );
const THROUGH = {
  "email-lookup": 200,
  "sign-in": 200,
  "sign-up": 200,
  "password-reset": 200,
  "ask-code": 202,
  waitlist: 202,
  partners: 202,
};
const REFUSED = Object.fromEntries(Object.keys(THROUGH).map((call) => [call, "human_check"]));

/** An owner with a workspace and its invitation link, on a server with `check` (none: no keys) and `env`. */
async function start(check?: HumanCheck | null, env: Record<string, string> = { LANDING_URL: LANDING }) {
  t = await createTestServer({ env: { ...env, ALLOW_SIGNUP: "true" }, humanCheck: check });
  const owner = browser(t);
  expect((await signUpPassing(owner, "owner@example.com")).status).toBe(200);
  const { orgId } = await seedOrg(owner);
  const link = (await (await owner(`/api/app/organizations/${orgId}/invite-links`, { json: {} })).json()) as {
    url: string;
  };
  return { owner, token: link.url.split("/invite/")[1] ?? "" };
}

test("without the keys: no site key for pages, and every form works without a token", async () => {
  const { token } = await start();
  expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({ turnstileSiteKey: null });
  expect(await outcomes(await guardedCalls(token, every({})))).toEqual(THROUGH);
});

test("with the keys: each guarded form needs a token Cloudflare passes, and nothing else changes", async () => {
  const { token } = await start(turnstile(fakeCloudflare().fetch));
  expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({
    turnstileSiteKey: "1x00000000000000000000AA",
  });

  for (const headers of [{}, { "x-captcha-response": "a-made-up-token" }] as Record<string, string>[]) {
    expect(await outcomes(await guardedCalls(token, every(headers)))).toEqual(REFUSED);
  }
  // Nothing went through: no email, no code, no place on either list, no contact.
  await t.drain();
  expect(t.email.sent.filter((m) => m.to.includes("ana@example.com"))).toEqual([]);
  expect(await t.db.select().from(schema.waitlistEntries)).toEqual([]);
  expect(await t.db.select().from(schema.partnerWaitlistEntries)).toEqual([]);
  expect(t.email.contacts.filter((c) => c.email === "ana@example.com")).toEqual([]);

  expect(await outcomes(await guardedCalls(token, every(passing)))).toEqual(THROUGH);
});

test("the e-mail's lookup answers with a pass that stands for the check at that address's next step, and nowhere else", async () => {
  await start(turnstile(fakeCloudflare().fetch));
  const lookUp = async (email: string, headers: Record<string, string> = passing) =>
    browser(t)("/api/app/sign-in-options", { json: { email }, headers });
  const found = (await (await lookUp("owner@example.com")).json()) as { pass?: string };
  const pass = found.pass ?? "";
  expect(pass).toStartWith("pass.");
  const withPass = { "x-captcha-response": pass };
  const signIn = (email: string, headers: Record<string, string>, password = "correct horse battery") =>
    browser(t)("/api/auth/sign-in/email", { json: { email, password }, headers });
  const outcome = async (res: Response) => (res.ok ? res.status : ((await codeOf(res)) ?? res.status));

  // The password after the e-mail: no second token. The address as typed, in any case.
  expect(await outcome(await signIn("owner@example.com", withPass))).toBe(200);
  expect(await outcome(await signIn("Owner@Example.com", withPass))).toBe(200);
  // A wrong password is the sign-in's own answer, not the check's; the reset link goes with it too.
  expect((await signIn("owner@example.com", withPass, "not the password")).status).toBe(401);
  expect(
    await outcome(
      await browser(t)("/api/auth/request-password-reset", {
        json: { email: "owner@example.com", redirectTo: "/reset-password" },
        headers: withPass,
      }),
    ),
  ).toBe(200);

  // Another address, a lookup, a waiting list, a pass somebody changed: each needs its own token.
  expect(await outcome(await signIn("other@example.com", withPass))).toBe("human_check");
  expect(await outcome(await lookUp("owner@example.com", withPass))).toBe("human_check");
  expect(
    await outcome(await browser(t)("/api/waitlist", { json: { email: "owner@example.com" }, headers: withPass })),
  ).toBe("human_check");
  expect(await outcome(await signIn("owner@example.com", { "x-captcha-response": `${pass}x` }))).toBe("human_check");
  expect(
    await outcome(
      await signIn("owner@example.com", { "x-captcha-response": pass.replace(/^pass\.\d+/, "pass.99999999999999") }),
    ),
  ).toBe("human_check");

  // A few calls and no more: the fifth is its last.
  expect(await outcome(await signIn("owner@example.com", withPass))).toBe(200);
  expect(await outcome(await signIn("owner@example.com", withPass))).toBe("human_check");
  // A token still passes, and a new lookup gives a new pass.
  expect(await outcome(await signIn("owner@example.com", passing))).toBe(200);
});

test("a pass counts for ten minutes, from the network it was given to", () => {
  let now = 1_000_000;
  const passes = createHumanPasses("a-secret", () => now);
  const at = { action: "sign-in" as const, email: "ana@example.com", network: "203.0.113.7" };
  const pass = passes.issue("ana@example.com", "203.0.113.7");
  expect(passes.accepts(pass, { ...at, network: "198.51.100.9" })).toBe(false);
  expect(passes.accepts(pass, { ...at, action: "email-lookup" })).toBe(false);
  expect(passes.accepts(pass, { ...at, action: "ask-code" })).toBe(false);
  expect(createHumanPasses("another-secret", () => now).accepts(pass, at)).toBe(false);
  expect(passes.accepts(pass, at)).toBe(true);
  now += 10 * 60_000 - 1;
  expect(passes.accepts(pass, { ...at, action: "sign-up" })).toBe(true);
  now += 1;
  expect(passes.accepts(pass, at)).toBe(false);
});

test("a token made on the landing page counts for its waiting lists only; one made on any other host, for nothing", async () => {
  const { token } = await start(turnstile(fakeCloudflare().fetch));
  expect(await outcomes(await guardedCalls(token, madeOn(LANDING_HOST)))).toEqual({
    ...REFUSED,
    waitlist: 202,
    partners: 202,
  });
  for (const host of ["elsewhere.example", `${LANDING_HOST}.evil.example`, `app.${LANDING_HOST}`]) {
    expect(await outcomes(await guardedCalls(token, madeOn(host)))).toEqual(REFUSED);
  }
  expect(await outcomes(await guardedCalls(token, madeOn(APP_HOST)))).toEqual(THROUGH);

  // As the landing page sends it: from its own origin, reading each answer through CORS, a refusal too.
  for (const [action, outcome] of [
    ["sign-in", "human_check"],
    ["waitlist", 202],
  ] as const) {
    const res = await browser(t)("/api/waitlist", {
      json: { email: "bia@example.com" },
      origin: LANDING,
      headers: madeOn(LANDING_HOST)(action),
    });
    const cors = res.headers.get("access-control-allow-origin");
    expect({ action, outcome: res.ok ? res.status : await codeOf(res), cors }).toEqual({
      action,
      outcome,
      cors: LANDING,
    });
  }
});

test("without LANDING_URL, only a token made on PUBLIC_URL's host counts, and there is no waiting list to join", async () => {
  const check = turnstileCheck(fakeCloudflare().fetch);
  const { token } = await start(check, {});
  const noLists = { waitlist: "not_found", partners: "not_found" };
  expect(await outcomes(await guardedCalls(token, madeOn(LANDING_HOST)))).toEqual({ ...REFUSED, ...noLists });
  expect(await outcomes(await guardedCalls(token, madeOn(APP_HOST)))).toEqual({ ...THROUGH, ...noLists });
  // The waiting list's own action, asked of the check itself.
  expect(await check?.verify(tokenMadeOn(LANDING_HOST, "waitlist"), "waitlist", "203.0.113.7")).toBe("human_check");
  expect(await check?.verify(tokenMadeOn(APP_HOST, "waitlist"), "waitlist", "203.0.113.7")).toBeNull();
});

test("sign-up's refusal by the check says so by its code, not as a closed sign-up", async () => {
  t = await createTestServer({ humanCheck: turnstile(fakeCloudflare().fetch) });
  // The first account; then sign-up is closed (ALLOW_SIGNUP off).
  expect((await signUpPassing(browser(t), "owner@example.com")).status).toBe(200);
  const res = await browser(t)("/api/auth/sign-up/email", {
    json: { email: "stranger@example.com", password: "correct horse battery", name: "S" },
  });
  expect(res.status).toBe(403);
  const body = (await res.json()) as { code: string; message: string };
  expect(body.code).toBe("human_check");
  expect(body.message).not.toContain("Sign-up is closed");
});

test("a page that couldn't make a token: blocked while Cloudflare answers this server, through while it doesn't", async () => {
  const cf = fakeCloudflare();
  const { token } = await start(turnstile(cf.fetch));
  const ask = (headers: Record<string, string>) =>
    browser(t)(`/api/app/invitations/${token}/code`, { json: { email: "ana@example.com" }, headers });

  const blocked = await ask({ "x-captcha-response": "unavailable:300010" });
  expect(blocked.status).toBe(403);
  expect(await blocked.json()).toEqual({
    error: { code: "human_check_blocked", message: "The bot check didn't load. Try another browser or network." },
  });
  expect(t.adapters.humanCheck?.status()).toMatchObject({ state: "ok", blocked: 1 });
  // Counted once per network: two addresses of one IPv6 /64, asking twice each, are one more.
  for (const ip of ["2001:db8:1:2::1", "2001:db8:1:2::2", "2001:db8:1:2::1", "2001:db8:1:2::2"]) {
    expect((await ask({ "x-captcha-response": "unavailable", "x-forwarded-for": ip })).status).toBe(403);
  }
  expect(t.adapters.humanCheck?.status()).toMatchObject({ state: "ok", blocked: 2 });

  // Cloudflare goes down for this server too (probed now rather than a minute later).
  cf.state.up = false;
  expect(await t.adapters.humanCheck?.probe()).toBe("unreachable");
  expect((await ask({ "x-captcha-response": "unavailable" })).status).toBe(202);
  // A real token goes through as well: nobody is locked out by Cloudflare's outage (here the code just went out).
  expect(await codeOf(await ask(passing))).toBe("join.code_wait");
});

test("at boot, a secret Cloudflare refuses stops the server; Cloudflare out of reach doesn't, nor a test secret, which warns", async () => {
  const lines: string[] = [];
  const log = {
    ...createLogger("error"),
    error: (m: string) => lines.push(m),
    warn: (m: string) => lines.push(m),
    info: (m: string) => lines.push(m),
  };
  await expect(checkHumanCheckAtBoot(null, log)).resolves.toBeUndefined();
  expect(lines).toEqual([]);

  const cf = fakeCloudflare();
  cf.state.secretRefused = true;
  const refused = checkHumanCheckAtBoot(turnstile(cf.fetch), log);
  await expect(refused).rejects.toBeInstanceOf(ConfigError);
  await expect(refused).rejects.toThrow(/TURNSTILE_SECRET_KEY/);

  cf.state.secretRefused = false;
  cf.state.up = false;
  await expect(checkHumanCheckAtBoot(turnstile(cf.fetch), log)).resolves.toBeUndefined();
  expect(lines.at(-1)).toContain("Cloudflare can't be reached");
  cf.state.up = true;
  // Cloudflare's always-passing test secret takes even the dummy token.
  await checkHumanCheckAtBoot(turnstile(cf.fetch), log);
  expect(lines.at(-1)).toContain("TURNSTILE_SECRET_KEY is one of Cloudflare's test secrets. They refuse real tokens");
  cf.state.testSecret = false;
  await checkHumanCheckAtBoot(turnstile(cf.fetch), log);
  expect(lines.at(-1)).toContain("bot check on");
});

test("refused bots don't spend a link's codes: a person asking through it still gets one", async () => {
  const { token } = await start(turnstile(fakeCloudflare().fetch));
  const ask = (ip: string, headers: Record<string, string> = {}) =>
    browser(t)(`/api/app/invitations/${token}/code`, {
      json: { email: `${ip}@example.com` },
      headers: { "x-forwarded-for": ip, ...headers },
    });
  // As many tokenless asks as the link allows in an hour, from 4 addresses within their own limit.
  for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"]) {
    for (let i = 0; i < 10; i++) expect(await codeOf(await ask(ip))).toBe("human_check");
  }
  expect((await ask("203.0.113.50", passing)).status).toBe(202);
});

test("an IPv6 network is one address for the limits: its /64 shares one count", async () => {
  const { owner } = await start();
  const lookup = (ip: string) =>
    owner("/api/app/sign-in-options", { json: { email: "owner@example.com" }, headers: { "x-forwarded-for": ip } });
  for (let i = 1; i <= 30; i++) expect((await lookup(`2001:db8:1:2::${i.toString(16)}`)).status).toBe(200);
  expect((await lookup("2001:db8:1:2:ffff:ffff:ffff:ffff")).status).toBe(429);
  expect((await lookup("2001:db8:1:3::1")).status).toBe(200);
});
