import { afterEach, describe, expect, test } from "bun:test";
import { openLinkToken } from "@agenteschat/engine";
import { browser, createTestServer, signUp, type TestServer } from "./harness";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const REFERRALS = {
  BILLING_URL: "https://billing.example.com",
  BILLING_LINK_SECRET: "b".repeat(32),
  REFERRALS_URL: "https://refer.example.com",
};
const link = (who: ReturnType<typeof browser>, json: object = {}) => who("/api/app/referrals-link", { json });

describe("the referrals link", () => {
  test("no referral service: 404 referrals.off, and auth-config names none", async () => {
    t = await createTestServer();
    expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({ referralsUrl: null });
    const person = browser(t);
    await signUp(person, "ana@example.com");
    const res = await link(person);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "referrals.off" } });
  });

  test("signed out: 401; signed in with no workspace: a link for 5 minutes back to the root", async () => {
    t = await createTestServer({ env: REFERRALS });
    expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({
      referralsUrl: "https://refer.example.com",
    });
    expect((await link(browser(t))).status).toBe(401);
    const person = browser(t);
    await signUp(person, "ana@example.com");
    const res = await link(person, { returnTo: "https://evil.example.com/" });
    expect(res.status).toBe(200);
    const { url, expiresAt } = (await res.json()) as { url: string; expiresAt: string };
    expect(url).toMatch(/^https:\/\/refer\.example\.com\/link\?t=v2\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    expect(openLinkToken(REFERRALS.BILLING_LINK_SECRET, new URL(url).searchParams.get("t") ?? "")).toMatchObject({
      aud: "agentes-referrals",
      email: "ana@example.com",
      orgs: [],
      return: "/",
    });
  });

  test("30 links an hour per person, then 429", async () => {
    t = await createTestServer({ env: { ...REFERRALS, ALLOW_SIGNUP: "true" } });
    const person = browser(t);
    await signUp(person, "ana@example.com");
    for (let i = 0; i < 30; i++) expect((await link(person)).status).toBe(200);
    const res = await link(person);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: "rate_limited" } });
    const other = browser(t);
    await signUp(other, "bo@example.com");
    expect((await link(other)).status).toBe(200);
  });

  test("its own secret seals it, with no billing service on this server", async () => {
    const secret = "r".repeat(32);
    t = await createTestServer({ env: { REFERRALS_URL: "https://refer.example.com", REFERRALS_LINK_SECRET: secret } });
    const person = browser(t);
    await signUp(person, "ana@example.com");
    const res = await link(person);
    expect(res.status).toBe(200);
    const token = new URL(((await res.json()) as { url: string }).url).searchParams.get("t") ?? "";
    expect(openLinkToken(secret, token)).toMatchObject({ aud: "agentes-referrals" });
    expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({ billingUrl: null });
  });
});
