import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HumanCheck } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import { enableCaches, listHosts, putHost } from "@agenteschat/engine";
import { createApp } from "../src/app";
import { createLogger } from "../src/logger";
import { createOperatorApp } from "../src/operator/app";
import { personUpgrade } from "../src/realtime/ws";
import { allowedOrigins, requestOriginAllowed } from "../src/routes/app/context";
import {
  type Browser,
  browser,
  createTestServer,
  fakeCloudflare,
  GOOGLE_ENV,
  ORIGIN,
  seedOrg,
  signUp,
  type TestServer,
  turnstileCheck,
} from "./harness";

/** ADR 0194: the same server on extra hostnames, each with its own look before sign-in. */

const HOST = "app.northwind.example";
const HOST_ORIGIN = `https://${HOST}`;
const OTHER = "app.contoso.example";
const OWN_EXTRA = "https://chat.northwind.example";
const TOKEN = "operator-test-token-".padEnd(48, "x");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let t: TestServer | undefined;
afterEach(async () => {
  enableCaches(false);
  await t?.close();
  t = undefined;
});

async function server(env: Record<string, string> = {}, humanCheck?: HumanCheck | null) {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true", OPERATOR_API_TOKEN: TOKEN, ...env }, humanCheck });
  const s = t;
  const blobs = s.adapters.platformBlobs;
  const own = new Set<string>();
  await putHost({ db: s.db, blobs }, own, HOST, {
    name: "Northwind Studio",
    accent: "#7c3aed",
    logo: { contentType: "image/png", base64: PNG.toString("base64") },
  });
  await putHost({ db: s.db, blobs }, own, OTHER, { name: "Contoso", poweredBy: false });
  return s;
}

/** A browser on `host`: every request carries that `Host` and that host's own origin unless told otherwise. */
function on(b: Browser, host: string, origin = `https://${host}`): Browser {
  const request = (path: string, init: Parameters<Browser>[1] = {}) =>
    b(path, { ...init, origin: init.origin === undefined ? origin : init.origin, headers: { host, ...init.headers } });
  return Object.assign(request, { cookie: b.cookie });
}

const codeOf = async (res: Response) =>
  ((await res.json()) as { error?: { code?: string }; code?: string }).error?.code;

const allowed = (s: TestServer, headers: Record<string, string>) =>
  requestOriginAllowed(s.db, allowedOrigins(s.config), new Headers(headers));

test("the origin rule: a registered host's own origin, on a request for that host only", async () => {
  const s = await server();
  expect(await allowed(s, { origin: ORIGIN })).toBe(true);
  expect(await allowed(s, { origin: ORIGIN, host: HOST })).toBe(true);
  expect(await allowed(s, { origin: HOST_ORIGIN, host: HOST })).toBe(true);
  expect(await allowed(s, { origin: HOST_ORIGIN, host: "App.Northwind.Example" })).toBe(true);
  expect(await allowed(s, { origin: HOST_ORIGIN, host: `${HOST}.` })).toBe(true);
  const refusals: Record<string, string>[] = [
    { origin: HOST_ORIGIN },
    { origin: HOST_ORIGIN, host: "localhost:3000" },
    { origin: HOST_ORIGIN, host: OTHER },
    { origin: `https://${OTHER}`, host: HOST },
    { origin: "https://app.unregistered.example", host: "app.unregistered.example" },
    { origin: `http://${HOST}`, host: HOST },
    { origin: `${HOST_ORIGIN}:443`, host: HOST },
    { origin: `${HOST_ORIGIN}:8443`, host: `${HOST}:8443` },
    { origin: HOST_ORIGIN, host: `${HOST}:443` },
    { origin: `${HOST_ORIGIN}.`, host: `${HOST}.` },
    { origin: "https://App.Northwind.Example", host: HOST },
    { origin: HOST_ORIGIN, host: "localhost:3000", "x-forwarded-host": HOST },
    { origin: HOST_ORIGIN, host: "localhost:3000", forwarded: `host=${HOST}` },
  ];
  for (const refused of refusals) {
    expect({ refused, allowed: await allowed(s, refused) }).toEqual({ refused, allowed: false });
  }
  // Without an Origin, the phone app alone, as before.
  expect(await allowed(s, { host: HOST, "x-agentes-client": "mobile" })).toBe(true);
  expect(await allowed(s, { host: HOST })).toBe(false);
});

test("Better Auth trusts a registered host's origin on that host's requests only; with no request, today's list", async () => {
  const s = await server();
  const trusted = s.auth.options.trustedOrigins as (request?: Request) => Promise<string[]>;
  const base = await trusted();
  expect(base).toContain(ORIGIN);
  expect(base).not.toContain(HOST_ORIGIN);
  const at = (headers: Record<string, string>) =>
    trusted(new Request("http://localhost/api/auth/sign-in/email", { headers }));
  expect(await at({ host: HOST })).toEqual([...base, HOST_ORIGIN]);
  expect(await at({ host: "localhost:3000" })).toEqual(base);
  expect(await at({ host: OTHER })).toEqual([...base, `https://${OTHER}`]);
  expect(await at({ host: "localhost:3000", "x-forwarded-host": HOST })).toEqual(base);
  expect(await at({ host: "app.unregistered.example" })).toEqual(base);
});

test("by email on a registered host: sign-up, the app's writes, sign-out and sign-in; host-only cookies", async () => {
  const s = await server();
  const there = on(browser(s), HOST);
  const up = await signUp(there, "ana@example.com");
  const cookies = up.headers.getSetCookie();
  expect(cookies.length).toBeGreaterThan(0);
  for (const cookie of cookies) expect(cookie.toLowerCase()).not.toContain("domain=");

  // The app API's CSRF check: that host's origin writes there, nowhere else.
  expect((await there("/api/app/organizations", { json: { name: "Northwind" } })).status).toBe(201);
  const elsewhere = [
    on(there, "localhost:3000", HOST_ORIGIN),
    on(there, OTHER, HOST_ORIGIN),
    on(there, HOST, `http://${HOST}`),
    on(there, HOST, `https://${OTHER}`),
  ];
  for (const b of elsewhere) {
    const res = await b("/api/app/organizations", { json: { name: "X" } });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("bad_origin");
  }

  // The main address holds no session of its own: the browser keeps each host's cookie to that host.
  expect((await browser(s)("/api/app/me")).status).toBe(401);

  const out = await there("/api/auth/sign-out", { json: {} });
  expect(out.status).toBe(200);
  expect((await there("/api/app/me")).status).toBe(401);
  const signIn = await there("/api/auth/sign-in/email", {
    json: { email: "ana@example.com", password: "correct horse battery" },
  });
  expect(signIn.status).toBe(200);
  for (const cookie of signIn.headers.getSetCookie()) expect(cookie.toLowerCase()).not.toContain("domain=");
  expect((await there("/api/app/me")).status).toBe(200);
});

test("a registered host runs no bot check: no site key, no token, no call to Cloudflare; the main address keeps it", async () => {
  const cloudflare = fakeCloudflare();
  const asked: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push(String(input));
    return cloudflare.fetch(input, init);
  }) as typeof globalThis.fetch;
  const landing = { LANDING_URL: "https://landing.example" };
  const s = await server(landing, turnstileCheck(fetch, landing));
  const config = async (b: Browser) => (await (await b("/api/app/auth-config")).json()) as Record<string, unknown>;
  expect(await config(on(browser(s), HOST))).toMatchObject({ turnstileSiteKey: null });
  expect(await config(browser(s))).toMatchObject({ turnstileSiteKey: "1x00000000000000000000AA" });

  const there = on(browser(s), HOST);
  const account = { email: "ana@example.com", password: "correct horse battery" };
  expect((await there("/api/auth/sign-up/email", { json: { ...account, name: "Ana" } })).status).toBe(200);
  const { orgId } = await seedOrg(there);
  const link = (await (await there(`/api/app/organizations/${orgId}/invite-links`, { json: {} })).json()) as {
    url: string;
  };
  const code = `/api/app/invitations/${link.url.split("/invite/")[1]}/code`;
  const calls = (b: Browser) => ({
    "email-lookup": b("/api/app/sign-in-options", { json: { email: account.email } }),
    "sign-in": b("/api/auth/sign-in/email", { json: account }),
    "sign-up": b("/api/auth/sign-up/email", {
      json: { email: "bo@example.com", password: "correct horse battery", name: "Bo" },
    }),
    "password-reset": b("/api/auth/request-password-reset", {
      json: { email: account.email, redirectTo: "/reset-password" },
    }),
    "ask-code": b(code, { json: { email: "cy@example.com" } }),
  });
  const outcomes = async (b: Browser) =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(calls(b)).map(async ([call, pending]) => {
          const res = await pending;
          const body = (await res.json()) as { code?: string; error?: { code?: string } };
          return [call, res.ok ? res.status : (body.error?.code ?? body.code)];
        }),
      ),
    );
  expect(await outcomes(on(browser(s), HOST))).toEqual({
    "email-lookup": 200,
    "sign-in": 200,
    "sign-up": 200,
    "password-reset": 200,
    "ask-code": 202,
  });
  expect(await outcomes(browser(s))).toEqual({
    "email-lookup": "human_check",
    "sign-in": "human_check",
    "sign-up": "human_check",
    "password-reset": "human_check",
    "ask-code": "human_check",
  });
  // No pass where no check ran: it would stand for the check on the main address.
  const found = await on(browser(s), HOST)("/api/app/sign-in-options", { json: { email: account.email } });
  expect(await found.json()).not.toHaveProperty("pass");
  // The waiting lists' forms are the landing page's: a request for a registered host still needs a token.
  const waitlist = await on(
    browser(s),
    HOST,
    landing.LANDING_URL,
  )("/api/waitlist", { json: { email: "di@example.com" } });
  expect(waitlist.status).toBe(403);
  expect(asked).toEqual([]);
});

test("unchecked tries on registered hosts never spend the main address's: password tries and reset emails", async () => {
  const s = await server();
  await signUp(browser(s), "ana@example.com");
  await s.drain();
  const signIn = (b: Browser, password: string, network: string) =>
    b("/api/auth/sign-in/email", {
      json: { email: "ana@example.com", password },
      headers: { "x-forwarded-for": network },
    });
  const hosts = (i: number) => on(browser(s), i % 2 ? HOST : OTHER);
  // Every registered host shares one count: two hosts don't double the tries. From one network:
  for (let i = 0; i < 10; i++) expect((await signIn(hosts(i), "not the password", "203.0.113.1")).status).toBe(401);
  expect((await signIn(on(browser(s), HOST), "correct horse battery", "203.0.113.1")).status).toBe(429);
  expect((await signIn(browser(s), "correct horse battery", "203.0.113.1")).status).toBe(200);
  // From all networks: four more reach the hosts' fifty.
  for (let n = 2; n <= 5; n++) {
    for (let i = 0; i < 10; i++) {
      expect((await signIn(hosts(i), "not the password", `203.0.113.${n}`)).status).toBe(401);
    }
  }
  expect((await signIn(on(browser(s), HOST), "correct horse battery", "198.51.100.7")).status).toBe(429);
  expect((await signIn(browser(s), "correct horse battery", "198.51.100.7")).status).toBe(200);

  const resets = async (b: Browser, times: number) => {
    const before = s.email.sent.length;
    for (let i = 0; i < times; i++) {
      const res = await b("/api/auth/request-password-reset", {
        json: { email: "ana@example.com", redirectTo: "/reset-password" },
      });
      expect(res.status).toBe(200);
    }
    await s.drain();
    return s.email.sent.length - before;
  };
  expect(await resets(on(browser(s), HOST), 4)).toBe(3);
  expect(await resets(browser(s), 1)).toBe(1);
}, 60_000);

test("registered hosts take fewer email lookups and sign-ups per network, counted apart from the main address's", async () => {
  const s = await server();
  const from = { "x-forwarded-for": "203.0.113.1" };
  const hosts = (i: number) => on(browser(s), i % 2 ? HOST : OTHER);
  const lookup = (b: Browser) => b("/api/app/sign-in-options", { json: { email: "ana@example.com" }, headers: from });
  for (let i = 0; i < 10; i++) expect((await lookup(hosts(i))).status).toBe(200);
  const looked = await lookup(on(browser(s), HOST));
  expect(looked.status).toBe(429);
  expect(Number(looked.headers.get("retry-after"))).toBeGreaterThan(9 * 60);
  expect((await lookup(browser(s))).status).toBe(200);

  const join = (b: Browser, n: number) =>
    b("/api/auth/sign-up/email", {
      json: { email: `new${n}@example.com`, password: "correct horse battery", name: `New ${n}` },
      headers: from,
    });
  for (let n = 0; n < 5; n++) expect((await join(hosts(n), n)).status).toBe(200);
  const refused = await join(on(browser(s), HOST), 5);
  expect(refused.status).toBe(429);
  expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(14 * 60);
  expect((await join(browser(s), 6)).status).toBe(200);
}, 30_000);

test("the WebSocket upgrade takes the same rule", async () => {
  const s = await server();
  const there = on(browser(s), HOST);
  await signUp(there, "ana@example.com");
  const { orgId } = await seedOrg(there);
  const upgrade = (headers: Record<string, string>) =>
    personUpgrade(
      { auth: s.auth, db: s.db },
      allowedOrigins(s.config),
      new Request(`http://localhost/api/ws?orgId=${orgId}`, { headers: { cookie: there.cookie(), ...headers } }),
      orgId,
    );
  const opened = await upgrade({ host: HOST, origin: HOST_ORIGIN });
  expect(opened).not.toBeInstanceOf(Response);
  const refusals: Record<string, string>[] = [
    { host: "localhost:3000", origin: HOST_ORIGIN },
    { host: OTHER, origin: HOST_ORIGIN },
    { host: HOST, origin: `http://${HOST}` },
    { host: "localhost:3000", origin: HOST_ORIGIN, "x-forwarded-host": HOST },
  ];
  for (const headers of refusals) {
    const refused = await upgrade(headers);
    expect({ headers, status: refused instanceof Response ? refused.status : 200 }).toEqual({ headers, status: 403 });
  }
});

test("auth-config: unchanged on the main address; on a registered host its look and email alone", async () => {
  const s = await server(GOOGLE_ENV);
  const main = (await (await browser(s)("/api/app/auth-config")).json()) as Record<string, unknown>;
  expect(main.host).toBeNull();
  expect(main.socialProviders).toEqual({ google: true, github: false, apple: false });

  const there = (await (await on(browser(s), HOST)("/api/app/auth-config")).json()) as Record<string, unknown>;
  expect(there.socialProviders).toEqual({ google: false, github: false, apple: false });
  expect(there.host).toEqual({
    name: "Northwind Studio",
    accent: "#7c3aed",
    logoUrl: expect.stringMatching(/^\/api\/host-look\/logo\?v=[0-9a-f]{8}-[0-9a-f]{16}\.png$/),
    poweredBy: true,
  });
  const { host: _main, socialProviders: _a, ...mainRest } = main;
  const { host: _there, socialProviders: _b, ...thereRest } = there;
  expect(thereRest).toEqual(mainRest);
  expect(((await (await on(browser(s), OTHER)("/api/app/auth-config")).json()) as { host: unknown }).host).toEqual({
    name: "Contoso",
    accent: null,
    logoUrl: null,
    poweredBy: false,
  });

  // A provider's sign-in can't start on a registered host, and still starts on the main address.
  const social = (b: Browser) => b("/api/auth/sign-in/social", { json: { provider: "google", callbackURL: "/" } });
  const refused = await social(on(browser(s), HOST));
  expect(refused.status).toBe(404);
  expect(((await refused.json()) as { code: string }).code).toBe("PROVIDER_NOT_FOUND");
  expect((await social(browser(s))).status).toBe(200);
});

test("a reset link goes to the main address wherever it was asked; a confirmation back to a host only for its sign-up", async () => {
  const s = await server();
  const owner = browser(s);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  await s.drain();

  const resetLink = async (b: Browser) => {
    const asked = await b("/api/auth/request-password-reset", {
      json: { email: "owner@example.com", redirectTo: "/reset-password" },
    });
    expect(asked.status).toBe(200);
    await s.drain();
    return new URL(/https?:\/\/\S+\/reset-password\S*/.exec(s.email.sent.at(-1)?.text ?? "")?.[0] ?? "").origin;
  };
  // Anyone may ask for any account's reset: a registered host, whose traffic its owner reads, never gets its token.
  expect(await resetLink(on(browser(s), HOST))).toBe(ORIGIN);
  expect(await resetLink(browser(s))).toBe(ORIGIN);

  const confirmation = async (email: string) => {
    await s.drain();
    const text = s.email.sent.filter((m) => m.to[0] === email).at(-1)?.text ?? "";
    return new URL(/https?:\/\/\S+\/api\/auth\/verify-email\S*/.exec(text)?.[0] ?? "").origin;
  };
  await signUp(on(browser(s), HOST), "dani@example.com");
  expect(await confirmation("dani@example.com")).toBe(HOST_ORIGIN);
  // A link is stamped to the second: asked for within the sign-up's, it would be the same email.
  await Bun.sleep(1000 - (Date.now() % 1000));
  const again = await on(browser(s), HOST)("/api/auth/send-verification-email", {
    json: { email: "dani@example.com" },
  });
  expect(again.status).toBe(200);
  expect(await confirmation("dani@example.com")).toBe(ORIGIN);

  const invite = async (b: Browser, email: string) => {
    const res = await b(`/api/app/organizations/${orgId}/invitations`, { json: { email, roleIds: [] } });
    expect(res.status).toBe(201);
    await s.drain();
    const mailed = s.email.sent.find((m) => m.to[0] === email)?.text ?? "";
    return { url: new URL(((await res.json()) as { url: string }).url).origin, mailed };
  };
  const there = await invite(on(owner, HOST), "bia@example.com");
  expect(there.url).toBe(HOST_ORIGIN);
  expect(there.mailed).toContain(`${HOST_ORIGIN}/invite/`);
  expect(there.mailed).not.toContain(`${ORIGIN}/invite/`);
  const main = await invite(owner, "caio@example.com");
  expect(main.url).toBe(ORIGIN);
  expect(main.mailed).toContain(`${ORIGIN}/invite/`);
});

test("the logo route serves the request's own host's logo, never another's", async () => {
  const s = await server();
  const logo = (b: Browser, query = "") => b(`/api/host-look/logo${query}`);
  const mine = await logo(on(browser(s), HOST));
  expect(mine.status).toBe(200);
  expect(mine.headers.get("content-type")).toBe("image/png");
  expect(mine.headers.get("cache-control")).toBe("public, max-age=300");
  expect(new Uint8Array(await mine.arrayBuffer()).subarray(0, 8)).toEqual(new Uint8Array(PNG.subarray(0, 8)));
  // A host without a logo, the main address and an unregistered host: none, whatever the query names.
  expect((await logo(on(browser(s), OTHER), `?host=${HOST}`)).status).toBe(404);
  expect((await logo(browser(s), `?host=${HOST}`)).status).toBe(404);
  expect((await logo(on(browser(s), "app.unregistered.example"))).status).toBe(404);
});

const operatorApp = (s: TestServer, read?: string) =>
  createOperatorApp(
    {
      db: s.db,
      config: s.config,
      version: "test",
      log: createLogger("error"),
      blobs: s.adapters.platformBlobs,
    },
    TOKEN,
    read,
  );

test("a server whose PUBLIC_URL isn't https registers no host: its cookies there would carry no Secure flag", async () => {
  const s = await server();
  const res = await operatorApp(s).request(`/api/operator/v1/hosts/b.northwind.example`, {
    method: "PUT",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "B" }),
  });
  expect([res.status, await codeOf(res)]).toEqual([409, "host.needs_https"]);
  expect((await listHosts(s.db)).map((h) => h.host)).toEqual([OTHER, HOST]);
});

test("the operator's routes: auth, shapes, refusals, and the cache dropped on a write", async () => {
  const s = await server({ EXTRA_TRUSTED_ORIGINS: OWN_EXTRA, PUBLIC_URL: "https://chat.example.com" });
  enableCaches(true);
  const READ = "operator-read-token-".padEnd(48, "x");
  const app = operatorApp(s, READ);
  const call = (method: string, path: string, json?: unknown, token: string | null = TOKEN) =>
    app.request(`/api/operator/v1${path}`, {
      method,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(json === undefined ? {} : { "content-type": "application/json" }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  const refusal = async (res: Response) => [res.status, await codeOf(res)];

  expect(await refusal(await call("GET", "/hosts", undefined, null))).toEqual([401, "unauthorized"]);
  expect(await refusal(await call("PUT", "/hosts/a.northwind.example", { name: "A" }, READ))).toEqual([
    403,
    "forbidden",
  ]);
  const listed = (await (await call("GET", "/hosts", undefined, READ)).json()) as { hosts: Record<string, unknown>[] };
  expect(listed.hosts.map((h) => h.host)).toEqual([OTHER, HOST]);
  expect(listed.hosts[1]).toEqual({
    host: HOST,
    name: "Northwind Studio",
    accent: "#7c3aed",
    logo: true,
    poweredBy: true,
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
  });

  // Read once through the cache, then replaced here: the next read sees it at once.
  const look = async () =>
    ((await (await on(browser(s), HOST)("/api/app/auth-config")).json()) as { host: { name: string } }).host;
  expect((await look()).name).toBe("Northwind Studio");
  const put = await call("PUT", `/hosts/${HOST}`, { name: "Northwind", accent: "#0F766E" });
  expect(put.status).toBe(200);
  expect(await put.json()).toMatchObject({ host: HOST, name: "Northwind", accent: "#0f766e", logo: true });
  expect(await look()).toMatchObject({ name: "Northwind", accent: "#0f766e" });
  expect(await (await call("PUT", `/hosts/${HOST}`, { name: "Northwind", logo: null })).json()).toMatchObject({
    logo: false,
    accent: "#0f766e",
    poweredBy: true,
  });
  // The powered-by line: off, kept off when left out, on again; a new host has it.
  expect(await (await call("PUT", `/hosts/${HOST}`, { name: "Northwind", poweredBy: false })).json()).toMatchObject({
    poweredBy: false,
  });
  expect(await look()).toMatchObject({ poweredBy: false });
  expect(await (await call("PUT", `/hosts/${HOST}`, { name: "Northwind" })).json()).toMatchObject({
    poweredBy: false,
    accent: "#0f766e",
  });
  expect(await (await call("PUT", `/hosts/${HOST}`, { name: "Northwind", poweredBy: true })).json()).toMatchObject({
    poweredBy: true,
  });
  expect(await (await call("PUT", "/hosts/new.northwind.example", { name: "New" })).json()).toMatchObject({
    poweredBy: true,
  });
  expect(
    (
      (await (await call("GET", "/hosts", undefined, READ)).json()) as { hosts: { host: string; poweredBy: boolean }[] }
    ).hosts.find((h) => h.host === OTHER)?.poweredBy,
  ).toBe(false);
  await call("DELETE", "/hosts/new.northwind.example");

  for (const [host, code] of [
    ["localhost", "host.invalid"],
    ["app.northwind.example:443", "host.invalid"],
    ["203.0.113.7", "host.invalid"],
    ["chat.northwind.example", "host.own"],
    ["Chat.Northwind.Example.", "host.own"],
  ] as const) {
    expect({ host, r: await refusal(await call("PUT", `/hosts/${encodeURIComponent(host)}`, { name: "N" })) }).toEqual({
      host,
      r: [400, code],
    });
  }
  for (const bad of [
    { name: "" },
    { name: "x".repeat(61) },
    { name: "N", accent: "purple" },
    { name: "N", poweredBy: "no" },
  ]) {
    expect({ bad, status: (await call("PUT", "/hosts/b.northwind.example", bad)).status }).toEqual({
      bad,
      status: 400,
    });
  }
  await s.db
    .insert(schema.hosts)
    .values(Array.from({ length: 998 }, (_, i) => ({ host: `h${i}.northwind.example`, name: `H${i}` })));
  expect(await refusal(await call("PUT", "/hosts/one-more.northwind.example", { name: "N" }))).toEqual([
    409,
    "host.too_many",
  ]);

  expect((await call("DELETE", `/hosts/${HOST}`)).status).toBe(204);
  expect(await look()).toBeNull();
  expect(await refusal(await call("DELETE", `/hosts/${HOST}`))).toEqual([404, "not_found"]);
});

/** The app with a WEB_DIR holding the real index.html; the directory goes when the test does. */
function withWeb(s: TestServer) {
  const index = readFileSync(join(import.meta.dir, "../../web/index.html"), "utf8");
  const web = mkdtempSync(join(tmpdir(), "agentes-web-"));
  webDirs.push(web);
  writeFileSync(join(web, "index.html"), index);
  mkdirSync(join(web, "assets"));
  writeFileSync(join(web, "assets", "index-4f2a.js"), "export {};");
  writeFileSync(join(web, "screen.html"), SCREEN);
  const app = createApp({
    edition: "cloud",
    version: "test",
    modules: [],
    pingDatabase: async () => {},
    services: { db: s.db, auth: s.auth, config: s.config, adapters: s.adapters },
    webDir: web,
  });
  return { index, get: (path: string, host: string) => app.request(path, { headers: { host } }) };
}
const webDirs: string[] = [];
afterEach(() => {
  for (const dir of webDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the app's page says it is on a registered host, so its boot hides the product's mark", async () => {
  const s = await server();
  const { index, get } = withWeb(s);
  expect(index).toContain("[data-host] .boot img { display: none; }");
  const page = async (path: string, host: string) => {
    const res = await get(path, host);
    expect(res.status).toBe(200);
    return res.text();
  };
  for (const path of ["/", "/login", "/invite/abc"]) {
    expect(await page(path, HOST)).toStartWith('<!doctype html>\n<html data-host lang="en"');
    expect(await page(path, "localhost:3000")).toBe(index);
  }
});

const UNKNOWN = "app.unregistered.example";
const SCREEN = '<!doctype html>\n<html lang="en"><body>screen</body></html>';

test("a hostname neither the server's own nor registered: the app's page is a 404 marked data-unknown-host", async () => {
  const s = await server({ PUBLIC_URL: "https://chat.example.com", EXTRA_TRUSTED_ORIGINS: OWN_EXTRA });
  const { index, get } = withWeb(s);
  for (const path of ["/", "/login", "/invite/abc", "/index.html"]) {
    const res = await get(path, UNKNOWN);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res.text()).toStartWith('<!doctype html>\n<html data-unknown-host lang="en"');
  }
  expect((await get("/", "App.Unregistered.Example.")).status).toBe(404);
  // The server's own names, an IP, a single label and a name with a port: the page as before.
  for (const host of ["chat.example.com", "chat.northwind.example", "203.0.113.7", "localhost", `${UNKNOWN}:8443`]) {
    const res = await get("/login", host);
    expect({ host, status: res.status, cache: res.headers.get("cache-control") }).toEqual({
      host,
      status: 200,
      cache: "no-cache",
    });
    expect(await res.text()).toBe(index);
  }
  // A registered host: its own mark, never both.
  const there = await (await get("/login", HOST)).text();
  expect(there).toStartWith('<!doctype html>\n<html data-host lang="en"');
  expect(there).not.toContain("data-unknown-host");
  // Everything but the app's page is untouched there.
  const health = await get("/api/health", UNKNOWN);
  expect(health.status).toBe(200);
  expect(health.headers.get("content-type")).toContain("application/json");
  const asset = await get("/assets/index-4f2a.js", UNKNOWN);
  expect(asset.status).toBe(200);
  expect(await asset.text()).toBe("export {};");
  expect((await get("/assets/gone-1234.js", UNKNOWN)).status).toBe(404);
  const other = await get("/screen.html", UNKNOWN);
  expect(other.status).toBe(200);
  expect(await other.text()).toBe(SCREEN);
});

test("without the operator API no hostname is unknown: the page as before, whatever Host the proxy sends", async () => {
  const s = await server({ OPERATOR_API_TOKEN: "" });
  expect(s.config.OPERATOR_API_TOKEN).toBeFalsy();
  const { index, get } = withWeb(s);
  const res = await get("/", UNKNOWN);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe(index);
});

test("a hostname registered after its first look shows as registered once the write drops the cache", async () => {
  const s = await server();
  enableCaches(true);
  const { get } = withWeb(s);
  expect((await get("/", UNKNOWN)).status).toBe(404);
  expect((await get("/", UNKNOWN)).status).toBe(404);
  await putHost({ db: s.db, blobs: s.adapters.platformBlobs }, new Set(), UNKNOWN, { name: "Fabrikam" });
  const res = await get("/", UNKNOWN);
  expect(res.status).toBe(200);
  expect(await res.text()).toStartWith('<!doctype html>\n<html data-host lang="en"');
});
