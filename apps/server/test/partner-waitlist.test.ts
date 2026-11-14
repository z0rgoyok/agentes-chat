import { afterEach, beforeEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { browser, createTestServer, fakeCloudflare, type TestServer, tokenMadeOn, turnstileCheck } from "./harness";

/** The landing page's own site. */
const LANDING = "https://agentes.example";
const PATH = "/api/partners/waitlist";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { LANDING_URL: LANDING } });
});
afterEach(() => t.close());

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

/** The partner page's body: the contact, the number from its country picker (E.164), the other questions. */
const ana = {
  name: " Ana Souza ",
  email: "  Ana@Example.com ",
  whatsapp: "+5511912345678",
  locale: "pt-BR",
  answers: { city: " Recife ", kind: "agency", segments: ["health", "retail"], site: "", consent: "yes" },
};

test("the landing's form joins: the entry, then through the outbox a contact with only partner_ keys, no email", async () => {
  const res = await browser(t)(PATH, { json: ana, origin: LANDING });
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true });
  const rows = await t.db.select().from(schema.partnerWaitlistEntries);
  expect(rows.map((r) => [r.email, r.name, r.whatsapp, r.locale, r.source, r.answers])).toEqual([
    [
      "ana@example.com",
      "Ana Souza",
      "+5511912345678",
      "pt-BR",
      "partners",
      { city: "Recife", kind: "agency", segments: ["health", "retail"], consent: "yes" },
    ],
  ]);
  // Not the product's waiting list, and never inline in the request.
  expect(await t.db.select().from(schema.waitlistEntries)).toEqual([]);
  expect(t.email.contacts).toEqual([]);
  await t.drain();
  expect(t.email.sent).toEqual([]);
  expect(t.email.contacts).toEqual([
    {
      email: "ana@example.com",
      properties: {
        partner_city: "Recife",
        partner_kind: "agency",
        partner_segments: "health, retail",
        partner_consent: "yes",
        partner_waitlist: "joined",
        partner_name: "Ana Souza",
        partner_whatsapp: "+5511912345678",
        partner_locale: "pt-BR",
        partner_source: "partners",
        partner_joined_at: rows[0]?.createdAt.toISOString() ?? "",
        partner_updated_at: rows[0]?.updatedAt.toISOString() ?? "",
      },
    },
  ]);
});

test("the same email again updates the entry and its contact; the first join date stays", async () => {
  const anon = browser(t);
  // As typed on a page without the country picker, then from the picker.
  await anon(PATH, { json: { ...ana, whatsapp: "(11) 91234-5678" } });
  await t.drain();
  const [first] = await t.db.select().from(schema.partnerWaitlistEntries);
  const again = await anon(PATH, {
    json: {
      ...ana,
      email: "ana@example.com",
      whatsapp: "+351912345678",
      locale: "en",
      answers: { kind: "consultant" },
    },
  });
  expect(again.status).toBe(202);
  await t.drain();
  const rows = await t.db.select().from(schema.partnerWaitlistEntries);
  expect(rows.map((r) => [r.whatsapp, r.locale, r.answers, r.createdAt])).toEqual([
    ["+351912345678", "en", { kind: "consultant" }, first?.createdAt as Date],
  ]);
  expect(t.email.contacts.map((c) => c.properties.partner_whatsapp)).toEqual(["(11) 91234-5678", "+351912345678"]);
  expect(t.email.contacts[1]?.properties).toMatchObject({
    partner_kind: "consultant",
    partner_locale: "en",
    partner_joined_at: first?.createdAt.toISOString(),
    partner_updated_at: rows[0]?.updatedAt.toISOString(),
  });
});

test("a number that can't be a WhatsApp number is refused as invalid_whatsapp, and nothing is kept", async () => {
  const anon = browser(t);
  // Too few digits, words, past E.164's 15 digits, blank.
  for (const whatsapp of ["+55 11 912", "call me 11912345678", "+5511912345678901", "  "]) {
    // From the landing's form, which reads the code through CORS to word it itself.
    const res = await anon(PATH, { json: { ...ana, whatsapp }, origin: LANDING });
    const cors = res.headers.get("access-control-allow-origin");
    expect({ whatsapp, status: res.status, code: await errorCode(res), cors }).toEqual({
      whatsapp,
      status: 400,
      code: "invalid_whatsapp",
      cors: LANDING,
    });
  }
  expect(await t.db.select().from(schema.partnerWaitlistEntries)).toEqual([]);
});

test("too many attempts from one address are throttled, apart from the product's list", async () => {
  const anon = browser(t);
  const headers = { "x-forwarded-for": "203.0.113.7" };
  for (let i = 0; i < 10; i++) {
    expect((await anon(PATH, { json: { ...ana, email: `p${i}@example.com` }, headers })).status).toBe(202);
  }
  const limited = await anon(PATH, { json: { ...ana, email: "p10@example.com" }, headers });
  expect(limited.status).toBe(429);
  expect(await errorCode(limited)).toBe("rate_limited");
  expect((await anon("/api/waitlist", { json: { email: "q@example.com" }, headers })).status).toBe(202);
  const other = await anon(PATH, {
    json: { ...ana, email: "r@example.com" },
    headers: { "x-forwarded-for": "198.51.100.2" },
  });
  expect(other.status).toBe(202);
});

test("the landing's origin passes its preflight and joins through CORS; any other origin is refused", async () => {
  const preflight = (origin: string) =>
    t.app.request(PATH, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-captcha-response",
      },
    });
  const landing = await preflight(LANDING);
  expect(landing.status).toBe(204);
  expect(landing.headers.get("access-control-allow-origin")).toBe(LANDING);
  // JSON, and the bot check's token when this server has one; never cookies.
  expect(landing.headers.get("access-control-allow-headers")).toBe("content-type,x-captcha-response");
  expect(landing.headers.get("access-control-allow-credentials")).toBeNull();
  expect((await preflight("https://evil.example")).headers.get("access-control-allow-origin")).toBeNull();

  const anon = browser(t);
  const joined = await anon(PATH, { json: ana, origin: LANDING });
  expect(joined.status).toBe(202);
  expect(joined.headers.get("access-control-allow-origin")).toBe(LANDING);
  for (const origin of ["https://evil.example", null]) {
    const res = await anon(PATH, { json: { ...ana, email: "bia@example.com" }, origin });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("bad_origin");
  }
  expect((await t.db.select().from(schema.partnerWaitlistEntries)).map((r) => r.email)).toEqual(["ana@example.com"]);
});

test("with the bot check, a token the landing page made for the list joins; one made elsewhere or for a sign-in keeps nothing", async () => {
  await t.close();
  t = await createTestServer({
    env: { LANDING_URL: LANDING },
    humanCheck: turnstileCheck(fakeCloudflare().fetch, { LANDING_URL: LANDING }),
  });
  const join = (token: string, email: string) =>
    browser(t)(PATH, { json: { ...ana, email }, origin: LANDING, headers: { "x-captcha-response": token } });
  for (const token of [tokenMadeOn("elsewhere.example", "waitlist"), tokenMadeOn("agentes.example", "sign-in")]) {
    const res = await join(token, "bia@example.com");
    // The page reads the refusal through CORS, to try once more.
    const cors = res.headers.get("access-control-allow-origin");
    expect({ status: res.status, code: await errorCode(res), cors }).toEqual({
      status: 403,
      code: "human_check",
      cors: LANDING,
    });
  }
  expect((await join(tokenMadeOn("agentes.example", "waitlist"), "ana@example.com")).status).toBe(202);
  await t.drain();
  expect((await t.db.select().from(schema.partnerWaitlistEntries)).map((r) => r.email)).toEqual(["ana@example.com"]);
  expect(t.email.contacts.map((c) => c.email)).toEqual(["ana@example.com"]);
});
