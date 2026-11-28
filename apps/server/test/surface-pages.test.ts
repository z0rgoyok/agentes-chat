import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  claimLink,
  lodiFor,
  mintPageLink,
  openPersonAgentDm,
  setSurface,
  surfaceFromConfig,
} from "@agenteschat/engine";
import { type Browser, browser, createTestServer, signUp, type TestServer } from "./harness";

const BRIDGE = "bridge-test-token-".padEnd(48, "y");

let t: TestServer;
let ana: Browser;
let orgId: string;
let userId: string;
let linkId: string;

beforeAll(async () => {
  t = await createTestServer({
    env: {
      ALLOW_SIGNUP: "true",
      SURFACE_BRIDGE_TOKEN: BRIDGE,
      SURFACE_NAME: "Example Chat",
      SURFACE_OPEN_URL: "https://chat.example.com/open?text={text}",
    },
  });
  setSurface(surfaceFromConfig(t.config));
  ana = browser(t);
  await signUp(ana, "ana@example.com");
  const res = await ana("/api/app/organizations", { json: { name: "Acme", context: "Acme builds rockets." } });
  orgId = ((await res.json()) as { organization: { id: string } }).organization.id;
  const minted = (await (await ana(`/api/app/organizations/${orgId}/surface-link/code`, { json: {} })).json()) as {
    code: string;
  };
  const { link } = await claimLink(
    { db: t.db },
    { externalId: "sender-1", display: "+1 555 0100", profileName: null, code: minted.code },
  );
  const confirmed = await ana(`/api/app/me/surface-links/${link.id}/confirm`, { json: {} });
  expect(confirmed.status).toBe(200);
  linkId = link.id;
  userId = link.userId;
});
afterAll(() => {
  setSurface(null);
  return t.close();
});

async function confirmPage() {
  const lodi = await lodiFor(t.db, orgId, userId);
  if (!lodi) throw new Error("no right hand");
  const dm = await openPersonAgentDm(t.db, orgId, userId, lodi.id);
  const [approval] = await t.db
    .insert(schema.approvals)
    .values({
      orgId,
      agentId: lodi.id,
      channelId: dm.id,
      threadRootId: crypto.randomUUID(),
      toolUseId: `tu_${crypto.randomUUID()}`,
      tool: "vault_delete",
      scope: "",
      params: {},
      actionHash: crypto.randomUUID(),
      title: "Delete the key OLD_KEY",
      detail: "{}",
      approvers: { userIds: [userId], label: "Ana", requestedBy: userId, requesterDecides: true },
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning();
  if (!approval) throw new Error("no approval");
  const url = await mintPageLink(t.db, { orgId, linkId, userId, kind: "confirm", targetId: approval.id });
  return { token: new URL(url).searchParams.get("token") ?? "", approvalId: approval.id };
}

const codeOf = async (res: Response) => ((await res.json()) as { error?: { code: string } }).error?.code;

test("the first browser to open the page keeps it; another browser can't", async () => {
  const { token } = await confirmPage();
  const phone = browser(t);
  const opened = await phone("/api/app/surface-page/open", { json: { token } });
  expect(opened.status).toBe(200);
  const cookie = opened.headers.getSetCookie().find((c) => c.startsWith("surface_page_")) ?? "";
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Path=/api/app/surface-page");
  expect(cookie).toContain("SameSite=Strict");
  expect(((await opened.json()) as { approval: { title: string; canDecide: boolean } }).approval).toMatchObject({
    title: "Delete the key OLD_KEY",
    canDecide: true,
  });
  const other = browser(t);
  const elsewhere = await other("/api/app/surface-page/open", { json: { token } });
  expect([elsewhere.status, await codeOf(elsewhere)]).toEqual([403, "surface.page_elsewhere"]);
  expect((await phone("/api/app/surface-page/open", { json: { token } })).status).toBe(200);
});

test("a page link alone never chooses the PIN; signed in as the person, the page does", async () => {
  const first = await confirmPage();
  const phone = browser(t);
  const opened = await phone("/api/app/surface-page/open", { json: { token: first.token } });
  expect(((await opened.json()) as { pin: object }).pin).toMatchObject({ set: false, canChoose: false });
  const unset = await phone("/api/app/surface-page/decide", {
    json: { token: first.token, decision: "approve", pin: "907312" },
  });
  expect([unset.status, await codeOf(unset)]).toEqual([409, "surface.pin_unset"]);
  const [waiting] = await t.db.select().from(schema.approvals).where(eq(schema.approvals.id, first.approvalId));
  expect(waiting?.status).toBe("pending");
  expect((await t.db.select().from(schema.surfaceLinks).where(eq(schema.surfaceLinks.id, linkId)))[0]?.pinHash).toBe(
    null,
  );

  const signedIn = await confirmPage();
  const page = await ana("/api/app/surface-page/open", { json: { token: signedIn.token } });
  expect(((await page.json()) as { pin: object }).pin).toMatchObject({ set: false, canChoose: true });
  const bad = await ana("/api/app/surface-page/decide", { json: { token: signedIn.token, decision: "approve" } });
  expect([bad.status, await codeOf(bad)]).toEqual([400, "surface.pin_shape"]);
  const ok = await ana("/api/app/surface-page/decide", {
    json: { token: signedIn.token, decision: "approve", pin: "907312" },
  });
  expect(ok.status).toBe(200);
  const [row] = await t.db.select().from(schema.approvals).where(eq(schema.approvals.id, signedIn.approvalId));
  expect(row?.status).toBe("approved");

  const next = await confirmPage();
  await phone("/api/app/surface-page/open", { json: { token: next.token } });
  const wrong = await phone("/api/app/surface-page/decide", {
    json: { token: next.token, decision: "approve", pin: "000000" },
  });
  expect([wrong.status, await codeOf(wrong)]).toEqual([403, "surface.pin_wrong"]);
  const right = await phone("/api/app/surface-page/decide", {
    json: { token: next.token, decision: "approve", pin: "907312" },
  });
  expect(right.status).toBe(200);
});

test("the app chooses the PIN for my own link, signed in, 10 an account per 10 minutes", async () => {
  expect(
    (await browser(t)(`/api/app/me/surface-links/${linkId}/pin`, { method: "PUT", json: { pin: "123456" } })).status,
  ).toBe(401);
  const shape = await ana(`/api/app/me/surface-links/${linkId}/pin`, { method: "PUT", json: { pin: "12345" } });
  expect(shape.status).toBe(400);
  expect(
    (await ana(`/api/app/me/surface-links/${linkId}/pin`, { method: "PUT", json: { pin: "246810" } })).status,
  ).toBe(204);
  const links = (await (await ana("/api/app/me/surface-links")).json()) as { links: { pinSet: boolean }[] };
  expect(links.links[0]?.pinSet).toBe(true);
  const [row] = await t.db.select().from(schema.surfaceLinks).where(eq(schema.surfaceLinks.id, linkId));
  expect(await Bun.password.verify("246810", row?.pinHash ?? "")).toBe(true);
  const statuses: number[] = [];
  for (let i = 0; i < 10; i++) {
    statuses.push(
      (await ana(`/api/app/me/surface-links/${linkId}/pin`, { method: "PUT", json: { pin: "246810" } })).status,
    );
  }
  expect(statuses.at(-1)).toBe(429);
});

test("a link to choose the PIN: emailed only from the browser that opened the page", async () => {
  const { token } = await confirmPage();
  const phone = browser(t);
  expect((await phone("/api/app/surface-page/pin-email", { json: { token } })).status).toBe(404);
  await phone("/api/app/surface-page/open", { json: { token } });
  expect((await phone("/api/app/surface-page/pin-email", { json: { token } })).status).toBe(204);
  const gone = await browser(t)("/api/app/surface-pin", { json: { token: "x".repeat(40), pin: "135790" } });
  expect([gone.status, await codeOf(gone)]).toEqual([404, "surface.pin_reset_gone"]);
});

test("choosing the PIN from the emailed link: 10 tries per 10 minutes per address", async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 10; i++) {
    statuses.push(
      (await browser(t)("/api/app/surface-pin", { json: { token: "y".repeat(40), pin: "135790" } })).status,
    );
  }
  expect(statuses.at(-1)).toBe(429);
});
