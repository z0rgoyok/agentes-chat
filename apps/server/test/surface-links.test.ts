import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { desc, eq, schema } from "@agenteschat/db";
import { enableOperatorEvents, SURFACE_PREFIX, setSurface, sha256, surfaceFromConfig } from "@agenteschat/engine";
import { createLogger } from "../src/logger";
import { operatorFetch } from "../src/operator/app";
import { type Browser, browser, createTestServer, signUp, type TestServer } from "./harness";

const OPERATOR = "operator-test-token-".padEnd(48, "x");
const BRIDGE = "bridge-test-token-".padEnd(48, "y");

let t: TestServer;
let bridge: NonNullable<ReturnType<typeof operatorFetch>>;
let ana: Browser;
let anaOrg: string;

beforeAll(async () => {
  t = await createTestServer({
    env: {
      ALLOW_SIGNUP: "true",
      OPERATOR_API_TOKEN: OPERATOR,
      SURFACE_BRIDGE_TOKEN: BRIDGE,
      SURFACE_NAME: "Example Chat",
      SURFACE_OPEN_URL: "https://chat.example.com/open?text={text}",
    },
  });
  const fetch = operatorFetch({
    db: t.db,
    config: t.config,
    version: "test",
    log: createLogger("error"),
    surface: t.services,
  });
  if (!fetch) throw new Error("no listener");
  bridge = fetch;
  setSurface(surfaceFromConfig(t.config));
  ana = browser(t);
  await signUp(ana, "ana@example.com");
  anaOrg = await workspace(ana, "Acme");
});
afterAll(() => {
  setSurface(null);
  enableOperatorEvents(false);
  return t.close();
});
beforeEach(() => setSurface(surfaceFromConfig(t.config)));

async function workspace(b: Browser, name: string) {
  const res = await b("/api/app/organizations", { json: { name, context: `${name} builds rockets.` } });
  if (res.status !== 201) throw new Error(`workspace failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { organization: { id: string } }).organization.id;
}

async function call(path: string, json: unknown, token: string | null = BRIDGE) {
  const res = await bridge(
    new Request(`http://127.0.0.1${SURFACE_PREFIX}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(json),
    }),
  );
  const body = (await res.json()) as Record<string, unknown> & { error?: { code: string; params?: unknown } };
  return { status: res.status, code: body.error?.code ?? null, body };
}

const claim = (code: string, externalId = "sender-1001", token: string | null = BRIDGE) =>
  call("/links/claim", { externalId, display: "+1 555 0100", profileName: "Ana A.", code }, token);

async function mint(b: Browser = ana, orgId = anaOrg) {
  const res = await b(`/api/app/organizations/${orgId}/surface-link/code`, { json: {} });
  return {
    status: res.status,
    body: (await res.json()) as { code: string; openUrl: string; error?: { code: string } },
  };
}

const list = async (b: Browser = ana) =>
  (await (await b("/api/app/me/surface-links")).json()) as {
    surface: { name: string } | null;
    allowed: boolean;
    links: { id: string; status: string; display: string | null; profileName: string | null; orgName: string | null }[];
  };

const errorCode = async (res: Response) => ((await res.json()) as { error?: { code: string } }).error?.code;

test("bridge off: the list answers the off shape, every other route surface.off, and auth-config says so", async () => {
  setSurface(null);
  expect(await list()).toEqual({ surface: null, allowed: false, links: [] });
  const minted = await mint();
  expect([minted.status, minted.body.error?.code]).toEqual([404, "surface.off"]);
  const id = Bun.randomUUIDv7();
  for (const res of [
    await ana(`/api/app/me/surface-links/${id}/confirm`, { json: {} }),
    await ana(`/api/app/me/surface-links/${id}`, { method: "DELETE" }),
  ]) {
    expect([res.status, await errorCode(res)]).toEqual([404, "surface.off"]);
  }
  const config = (await (await ana("/api/app/auth-config")).json()) as { surface: boolean };
  expect(config.surface).toBe(false);
  setSurface(surfaceFromConfig(t.config));
  expect(((await (await ana("/api/app/auth-config")).json()) as { surface: boolean }).surface).toBe(true);
});

test("signed out: the routes ask for a session", async () => {
  const stranger = browser(t);
  expect((await stranger("/api/app/me/surface-links")).status).toBe(401);
  expect((await stranger(`/api/app/organizations/${anaOrg}/surface-link/code`, { json: {} })).status).toBe(401);
});

test("while only some may link, others are told allowed: false and can't mint", async () => {
  const bea = browser(t);
  await signUp(bea, "bea@example.com");
  const beaOrg = await workspace(bea, "Beta");
  setSurface({
    id: "example chat",
    name: "Example Chat",
    openUrl: "https://chat.example.com/open?text={text}",
    only: ["ana@example.com"],
  });
  expect((await list(bea)).allowed).toBe(false);
  const refused = await mint(bea, beaOrg);
  expect([refused.status, refused.body.error?.code]).toEqual([403, "surface.not_allowed"]);
  const confirm = await bea(`/api/app/me/surface-links/${Bun.randomUUIDv7()}/confirm`, { json: {} });
  expect([confirm.status, await errorCode(confirm)]).toEqual([403, "surface.not_allowed"]);
  expect(await list()).toMatchObject({ surface: { name: "Example Chat" }, allowed: true });
  expect((await mint()).status).toBe(201);
  // Not a member of the workspace asked for.
  setSurface(surfaceFromConfig(t.config));
  const elsewhere = await mint(bea, anaOrg);
  expect([elsewhere.status, elsewhere.body.error?.code]).toEqual([403, "forbidden"]);
});

test("claim, list, confirm and delete; each claim is audited with the sender only as a hash", async () => {
  const carla = browser(t);
  await signUp(carla, "carla@example.com");
  const org = await workspace(carla, "Carla Co");
  const minted = await mint(carla, org);
  expect(minted.status).toBe(201);
  expect(minted.body.openUrl).toBe(`https://chat.example.com/open?text=${encodeURIComponent(minted.body.code)}`);

  const claimed = await claim(minted.body.code, "sender-carla");
  expect(claimed.status).toBe(201);
  expect(claimed.body).toMatchObject({ status: "pending", locale: "pt-BR" });
  const linkId = String(claimed.body.linkId);
  const [audit] = await t.db.select().from(schema.surfaceCalls).orderBy(desc(schema.surfaceCalls.id)).limit(1);
  expect(audit).toMatchObject({ route: `${SURFACE_PREFIX}/links/claim`, status: 201, linkId, orgId: org });
  expect(audit?.externalHash).toBe(sha256("sender-carla").slice(0, 16));
  expect(JSON.stringify(audit)).not.toContain("sender-carla");

  const again = await claim(minted.body.code, "sender-carla");
  expect([again.status, again.code]).toEqual([404, "surface.code_gone"]);
  const [refused] = await t.db.select().from(schema.surfaceCalls).orderBy(desc(schema.surfaceCalls.id)).limit(1);
  expect(refused).toMatchObject({ status: 404, code: "surface.code_gone" });

  expect((await list(carla)).links).toMatchObject([
    { id: linkId, status: "pending", display: "+1 555 0100", profileName: "Ana A.", orgName: "Carla Co" },
  ]);
  // Another person's link is not theirs to confirm or remove.
  for (const res of [
    await ana(`/api/app/me/surface-links/${linkId}/confirm`, { json: {} }),
    await ana(`/api/app/me/surface-links/${linkId}`, { method: "DELETE" }),
  ]) {
    expect([res.status, await errorCode(res)]).toEqual([404, "surface.link_gone"]);
  }
  const confirmed = await carla(`/api/app/me/surface-links/${linkId}/confirm`, { json: {} });
  expect(confirmed.status).toBe(200);
  expect(await confirmed.json()).toMatchObject({ id: linkId, status: "active", orgId: org });
  const unknown = await carla(`/api/app/me/surface-links/${Bun.randomUUIDv7()}/confirm`, { json: {} });
  expect([unknown.status, await errorCode(unknown)]).toEqual([404, "surface.link_gone"]);

  const taken = await claim((await mint()).body.code, "sender-carla");
  expect([taken.status, taken.code]).toEqual([409, "surface.taken"]);

  expect((await carla(`/api/app/me/surface-links/${linkId}`, { method: "DELETE" })).status).toBe(204);
  expect((await list(carla)).links).toEqual([]);
});

test("unlink through the bridge: unlinked, then none", async () => {
  const minted = await mint();
  const claimed = await claim(minted.body.code, "sender-unlink");
  await ana(`/api/app/me/surface-links/${claimed.body.linkId}/confirm`, { json: {} });
  const first = await call("/links/unlink", { externalId: "sender-unlink", reason: "asked" });
  expect([first.status, first.body]).toEqual([200, { status: "unlinked" }]);
  const second = await call("/links/unlink", { externalId: "sender-unlink", reason: "identity_changed" });
  expect([second.status, second.body]).toEqual([200, { status: "none" }]);
  const bad = await call("/links/unlink", { externalId: "sender-unlink", reason: "bored" });
  expect([bad.status, bad.code]).toEqual([400, "invalid_request"]);
});

test("the bridge refuses a wrong token, the operator token and unknown fields", async () => {
  const code = (await mint()).body.code;
  for (const token of [null, "w".repeat(48), OPERATOR]) {
    const res = await claim(code, "sender-refused", token);
    expect([res.status, res.code]).toEqual([401, "unauthorized"]);
  }
  const extra = await call("/links/claim", {
    externalId: "sender-refused",
    display: null,
    profileName: null,
    code,
    userId: "someone",
  });
  expect([extra.status, extra.code]).toEqual([400, "invalid_request"]);
  // Refused before reaching the code: it still works.
  expect((await claim(code, "sender-refused")).status).toBe(201);
});

test("the 11th code in an hour is refused", async () => {
  const dan = browser(t);
  await signUp(dan, "dan@example.com");
  const org = await workspace(dan, "Dan Co");
  for (let i = 0; i < 10; i++) expect((await mint(dan, org)).status).toBe(201);
  const over = await mint(dan, org);
  expect([over.status, over.body.error?.code]).toEqual([429, "rate_limited"]);
});

test("a sender gets 5 claims an hour, wrong codes included", async () => {
  for (let i = 0; i < 5; i++) expect((await claim("AAAA-AAAA", "sender-guess")).code).toBe("surface.code_gone");
  const over = await claim((await mint()).body.code, "sender-guess");
  expect([over.status, over.code]).toEqual([429, "surface.claim_limit"]);
  expect((over.body.error?.params as { retryIn?: number } | undefined)?.retryIn).toBeGreaterThan(0);
});

test("the linked email's undo: public, once, then surface.undo_gone; 429 past 10 tries in 10 minutes", async () => {
  const eve = browser(t);
  await signUp(eve, "eve@example.com");
  const org = await workspace(eve, "Eve Co");
  const claimed = await claim((await mint(eve, org)).body.code, "sender-eve");
  expect((await eve(`/api/app/me/surface-links/${claimed.body.linkId}/confirm`, { json: {} })).status).toBe(200);
  const jobs = await t.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "email.send"));
  const sent = jobs
    .map((j) => j.payload as { to: string[]; template: { kind: string; url?: string } })
    .filter((p) => p.template.kind === "surface_linked" && p.to.includes("eve@example.com"));
  expect(sent).toHaveLength(1);
  const url = new URL(sent[0]?.template.url ?? "");
  expect(url.pathname).toBe("/email-undo");
  expect(url.searchParams.get("kind")).toBe("surface");
  const token = url.searchParams.get("token") ?? "";

  const stranger = browser(t);
  const undo = (value: string) => stranger("/api/app/surface-undo", { json: { token: value } });
  const first = await undo(token);
  expect([first.status, await first.json()]).toEqual([
    200,
    { unlinked: true, surface: "Example Chat", display: "+1 555 0100" },
  ]);
  expect((await list(eve)).links).toEqual([]);
  const again = await undo(token);
  expect([again.status, await errorCode(again)]).toEqual([404, "surface.undo_gone"]);
  for (let i = 0; i < 8; i++) expect((await undo(`wrong-token-${i}`.padEnd(32, "0"))).status).toBe(404);
  const over = await undo(token);
  expect([over.status, await errorCode(over)]).toEqual([429, "rate_limited"]);
});

test("one sender's refused claims don't spend the cap shared by every sender", async () => {
  for (let i = 0; i < 130; i++) {
    const res = await claim("AAAA-AAAA", "sender-flood");
    expect(res.code).toBe(i < 5 ? "surface.code_gone" : "surface.claim_limit");
  }
  expect((await claim((await mint()).body.code, "sender-after-flood")).status).toBe(201);
});

// Last: it spends the claims cap across all senders for the rest of the file.
test("past 120 claims an hour across senders: surface.busy, and one operator event", async () => {
  enableOperatorEvents();
  await t.db.delete(schema.operatorEvents);
  let busy = 0;
  for (let i = 0; i < 130; i++) {
    const res = await claim("AAAA-AAAA", `sender-many-${i}`);
    if (res.code === "surface.busy") busy++;
  }
  expect(busy).toBeGreaterThan(0);
  const events = await t.db
    .select()
    .from(schema.operatorEvents)
    .where(eq(schema.operatorEvents.type, "surface.cap_reached"));
  expect(events.map((e) => e.data)).toEqual([{ cap: "claims" }]);
});
