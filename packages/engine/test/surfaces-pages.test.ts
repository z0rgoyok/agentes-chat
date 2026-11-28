import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  checkPin,
  claimLink,
  confirmLink,
  decideOnSurfacePage,
  emailPinLink,
  insertMessage,
  listSurfaceDeliveries,
  lodiFor,
  mintLinkCode,
  mintPageLink,
  openPersonAgentDm,
  openSurfacePage,
  PAGE_FIRST_OPEN_MS,
  PAGE_OPEN_MS,
  type PageKind,
  PIN_LOCKS_MS,
  pruneSurfaceRows,
  queueSurfaceDelivery,
  removeLink,
  setMySurfacePin,
  setPinFromEmail,
  setSurface,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

const { surfaceDeliveries, surfaceLinks, surfacePageLinks, approvals, agentRuns, outbox, organizationMembers } = schema;

let f: Fixture;
beforeEach(async () => {
  f = await setup({ rightHand: true });
  setSurface({
    id: "example chat",
    name: "Example Chat",
    openUrl: "https://chat.example.com/open?text={text}",
    only: null,
  });
});
afterEach(async () => {
  setSurface(null);
  await f.close();
});

const T0 = new Date();
const at = (ms: number) => () => new Date(T0.getTime() + ms);
const minutes = (n: number) => n * 60_000;

async function linked() {
  const { code } = await mintLinkCode(f.db, f.owner.id, f.org.id);
  const { link } = await claimLink(
    { db: f.db },
    { externalId: "sender-77", display: "+1 555 0100", profileName: null, code },
  );
  await confirmLink({ db: f.db }, f.owner.id, link.id);
  await f.db.delete(surfaceDeliveries);
  return link.id;
}

async function dm() {
  const lodi = await lodiFor(f.db, f.org.id);
  if (!lodi) throw new Error("no right hand");
  return { lodi, channel: await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id) };
}

/** What a surface turn's delete asks: the person alone decides it (`approvers`), as the gateway writes it. */
async function approval(approvers?: (typeof approvals.$inferInsert)["approvers"]) {
  const { lodi, channel } = await dm();
  const [row] = await f.db
    .insert(approvals)
    .values({
      orgId: f.org.id,
      agentId: lodi.id,
      channelId: channel.id,
      threadRootId: crypto.randomUUID(),
      toolUseId: `tu_${crypto.randomUUID()}`,
      tool: "vault_delete",
      scope: "",
      params: { key: "OLD_KEY" },
      actionHash: crypto.randomUUID(),
      title: "Delete the key OLD_KEY",
      detail: '{"key":"OLD_KEY"}',
      approvers: approvers ?? {
        userIds: [f.owner.id],
        label: f.owner.name,
        requestedBy: f.owner.id,
        requesterDecides: true,
        required: true,
      },
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning();
  if (!row) throw new Error("no approval");
  return row;
}

async function page(kind: PageKind = "confirm", targetId?: string) {
  const linkId = await linked();
  const target = targetId ?? (kind === "confirm" ? (await approval()).id : crypto.randomUUID());
  const url = await mintPageLink(f.db, { orgId: f.org.id, linkId, userId: f.owner.id, kind, targetId: target });
  await f.db.update(surfacePageLinks).set({ createdAt: T0 });
  const token = new URL(url).searchParams.get("token") ?? "";
  return { url, token, linkId, targetId: target };
}

/** The owner's address as sign-up leaves it once confirmed: what a link to choose the PIN may go to. */
const verified = () => f.db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, f.owner.id));

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e.code,
  );

describe("lifetimes: opened once within 10 minutes, then its kind's time in that browser", () => {
  test.each([
    ["confirm", 60],
    ["screen", 30],
    ["control", 15],
  ] as const)("%s: open for %i minutes after its first open", async (kind, open) => {
    expect(PAGE_OPEN_MS[kind]).toBe(minutes(open));
    const { token } = await page(kind);
    const first = await openSurfacePage({ db: f.db, now: at(PAGE_FIRST_OPEN_MS - 1000) }, token, null);
    expect(first.secret).toBeString();
    const opened = PAGE_FIRST_OPEN_MS - 1000;
    expect(first.view.expiresAt).toBe(new Date(T0.getTime() + opened + minutes(open)).toISOString());
    const reopen = (ms: number) => openSurfacePage({ db: f.db, now: at(opened + ms) }, token, first.secret);
    expect((await reopen(minutes(open) - 1000)).secret).toBeNull();
    expect(await codeOf(reopen(minutes(open) + 1000))).toBe("surface.page_gone");
  });

  test("not opened within 10 minutes: gone", async () => {
    const { token } = await page();
    expect(await codeOf(openSurfacePage({ db: f.db, now: at(PAGE_FIRST_OPEN_MS + 1000) }, token, null))).toBe(
      "surface.page_gone",
    );
  });

  test("another browser can't open it once it was opened", async () => {
    const { token } = await page();
    const first = await openSurfacePage({ db: f.db, now: at(0) }, token, null);
    expect(await codeOf(openSurfacePage({ db: f.db, now: at(1000) }, token, null))).toBe("surface.page_elsewhere");
    expect(await codeOf(openSurfacePage({ db: f.db, now: at(1000) }, token, "someone-else"))).toBe(
      "surface.page_elsewhere",
    );
    expect(await codeOf(openSurfacePage({ db: f.db, now: at(1000) }, token, first.secret))).toBe("ok");
  });

  test("ends early when the surface link ends, or the person leaves the workspace", async () => {
    const one = await page();
    const secret = (await openSurfacePage({ db: f.db, now: at(0) }, one.token, null)).secret;
    await removeLink({ db: f.db }, f.owner.id, one.linkId);
    expect(await codeOf(openSurfacePage({ db: f.db, now: at(1000) }, one.token, secret))).toBe("surface.page_gone");

    const two = await page();
    const again = (await openSurfacePage({ db: f.db, now: at(0) }, two.token, null)).secret;
    await f.db
      .delete(organizationMembers)
      .where(and(eq(organizationMembers.orgId, f.org.id), eq(organizationMembers.userId, f.owner.id)));
    expect(await codeOf(openSurfacePage({ db: f.db, now: at(1000) }, two.token, again))).toBe("surface.page_gone");
  });

  test("pruned a day later", async () => {
    await page();
    await f.db.update(surfacePageLinks).set({ createdAt: new Date(Date.now() - 25 * 3_600_000) });
    await pruneSurfaceRows(f.db);
    expect(await f.db.select().from(surfacePageLinks)).toEqual([]);
  });
});

describe("the PIN", () => {
  const deps = (ms: number) => ({ db: f.db, pubsub: f.pubsub, now: at(ms) });

  test("a page link alone never chooses the PIN: approving waits in the app, refusing needs none", async () => {
    const { token, linkId, targetId } = await page();
    const secret = (await openSurfacePage({ db: f.db, now: at(0) }, token, null)).secret;
    const { view } = await openSurfacePage({ db: f.db, now: at(0) }, token, secret);
    expect(view.pin).toMatchObject({ set: false, canChoose: false });
    expect(await codeOf(decideOnSurfacePage(deps(1000), token, secret, { decision: "approve", pin: "482913" }))).toBe(
      "surface.pin_unset",
    );
    const [row] = await f.db.select().from(surfaceLinks).where(eq(surfaceLinks.id, linkId));
    expect(row?.pinHash).toBeNull();
    expect((await f.db.select().from(approvals).where(eq(approvals.id, targetId)))[0]?.status).toBe("pending");

    const refused = await decideOnSurfacePage(deps(2000), token, secret, { decision: "refuse" });
    expect(refused.approval?.status).toBe("refused");
  });

  test("the bridge's own check never chooses a PIN either", async () => {
    const linkId = await linked();
    const [link] = await f.db.select().from(surfaceLinks).where(eq(surfaceLinks.id, linkId));
    if (!link) throw new Error("no link");
    expect(await codeOf(checkPin(f.db, link, "482913", new Date()))).toBe("surface.pin_unset");
    expect((await f.db.select().from(surfaceLinks))[0]?.pinHash).toBeNull();
  });

  test("signed in here as the person, approving chooses it; signed in as someone else, it doesn't", async () => {
    const { token, linkId, targetId } = await page();
    const other = await addMember(f.db, f.org.id, "member", "Someone Else");
    const secret = (await openSurfacePage({ db: f.db, now: at(0) }, token, null, other.id)).secret;
    expect((await openSurfacePage({ db: f.db, now: at(0) }, token, secret, other.id)).view.pin.canChoose).toBe(false);
    expect(
      await codeOf(decideOnSurfacePage(deps(1000), token, secret, { decision: "approve", pin: "482913" }, other.id)),
    ).toBe("surface.pin_unset");

    expect((await openSurfacePage({ db: f.db, now: at(0) }, token, secret, f.owner.id)).view.pin.canChoose).toBe(true);
    expect(
      await codeOf(decideOnSurfacePage(deps(1000), token, secret, { decision: "approve", pin: "12345" }, f.owner.id)),
    ).toBe("surface.pin_shape");
    const view = await decideOnSurfacePage(
      deps(1000),
      token,
      secret,
      { decision: "approve", pin: "482913" },
      f.owner.id,
    );
    expect(view.approval?.status).toBe("approved");
    expect(view.pin).toMatchObject({ set: true, canChoose: false });
    const [row] = await f.db.select().from(surfaceLinks).where(eq(surfaceLinks.id, linkId));
    expect(row?.pinHash).not.toContain("482913");
    expect(await Bun.password.verify("482913", row?.pinHash ?? "")).toBe(true);
    expect((await f.db.select().from(approvals).where(eq(approvals.id, targetId)))[0]?.decidedByUserId).toBe(
      f.owner.id,
    );
  });

  test("the app chooses it for the person's own active link, replacing any and its lock", async () => {
    const linkId = await linked();
    await f.db
      .update(surfaceLinks)
      .set({ pinHash: "old", pinFailures: 2, pinLockedUntil: new Date(Date.now() + 60_000), pinLockouts: 2 })
      .where(eq(surfaceLinks.id, linkId));
    const other = await addMember(f.db, f.org.id, "member", "Someone Else");
    expect(await codeOf(setMySurfacePin(f.db, other.id, linkId, "482913"))).toBe("surface.link_gone");
    expect(await codeOf(setMySurfacePin(f.db, f.owner.id, linkId, "4829"))).toBe("surface.pin_shape");
    await setMySurfacePin(f.db, f.owner.id, linkId, "482913");
    const [row] = await f.db.select().from(surfaceLinks).where(eq(surfaceLinks.id, linkId));
    expect(await Bun.password.verify("482913", row?.pinHash ?? "")).toBe(true);
    expect([row?.pinFailures, row?.pinLockedUntil, row?.pinLockouts]).toEqual([0, null, 0]);
  });

  test("only the browser that opened the page decides, and not before it opened", async () => {
    const { token } = await page();
    expect(await codeOf(decideOnSurfacePage(deps(0), token, null, { decision: "refuse" }))).toBe("surface.page_gone");
    await openSurfacePage({ db: f.db, now: at(0) }, token, null);
    expect(await codeOf(decideOnSurfacePage(deps(1000), token, "guess", { decision: "refuse" }))).toBe(
      "surface.page_elsewhere",
    );
  });

  test("three wrong ones lock approving: 15 minutes, then an hour, then a day, each with an email", async () => {
    const linkId = await linked();
    await verified();
    await f.db
      .update(surfaceLinks)
      .set({ pinHash: await Bun.password.hash("111111") })
      .where(eq(surfaceLinks.id, linkId));
    const check = async (ms: number, pin: string) => {
      const [link] = await f.db.select().from(surfaceLinks).where(eq(surfaceLinks.id, linkId));
      if (!link) throw new Error("no link");
      return checkPin(f.db, link, pin, at(ms)()).then(
        () => "ok",
        (e: { code: string; params?: Record<string, unknown> }) => [e.code, e.params],
      );
    };
    expect(PIN_LOCKS_MS).toEqual([minutes(15), minutes(60), minutes(24 * 60)]);
    let start = 1000;
    for (const lock of PIN_LOCKS_MS) {
      expect(await check(start, "222222")).toEqual(["surface.pin_wrong", { left: 2 }]);
      expect(await check(start + 1000, "222222")).toEqual(["surface.pin_wrong", { left: 1 }]);
      const until = new Date(T0.getTime() + start + 2000 + lock).toISOString();
      expect(await check(start + 2000, "222222")).toEqual(["surface.pin_locked", { until }]);
      expect(await check(start + 3000, "111111")).toEqual(["surface.pin_locked", { until }]);
      start += 2000 + lock + 1000;
    }
    const mails = await f.db.select().from(outbox).where(eq(outbox.kind, "email.send"));
    const sent = mails.map((m) => (m.payload as { template: { kind: string; step: number; url: string } }).template);
    expect(sent.map((m) => [m.kind, m.step])).toEqual([
      ["surface_pin_locked", 0],
      ["surface_pin_locked", 1],
      ["surface_pin_locked", 2],
    ]);
    expect(sent[0]?.url).toEndWith(`/org/${f.org.id}/settings/notifications`);
    // A right one starts the count over.
    expect(await check(start, "111111")).toBe("ok");
    const [row] = await f.db.select().from(surfaceLinks).where(eq(surfaceLinks.id, linkId));
    expect([row?.pinFailures, row?.pinLockouts]).toEqual([0, 0]);
  });

  test("a lock emails no address that was never verified: an account can take anyone's unconfirmed", async () => {
    const linkId = await linked();
    await f.db
      .update(surfaceLinks)
      .set({ pinHash: await Bun.password.hash("111111"), pinFailures: 2 })
      .where(eq(surfaceLinks.id, linkId));
    const [link] = await f.db.select().from(surfaceLinks).where(eq(surfaceLinks.id, linkId));
    if (!link) throw new Error("no link");
    expect(await codeOf(checkPin(f.db, link, "222222", at(1000)()))).toBe("surface.pin_locked");
    expect(await f.db.select().from(outbox).where(eq(outbox.kind, "email.send"))).toEqual([]);
  });

  test("a lock a day past no longer makes the next one longer", async () => {
    const linkId = await linked();
    await f.db
      .update(surfaceLinks)
      .set({
        pinHash: await Bun.password.hash("111111"),
        pinLockouts: 2,
        pinLockedUntil: new Date(T0.getTime() - minutes(25 * 60)),
      })
      .where(eq(surfaceLinks.id, linkId));
    const wrong = async (ms: number) => {
      const [link] = await f.db.select().from(surfaceLinks).where(eq(surfaceLinks.id, linkId));
      if (!link) throw new Error("no link");
      return codeOf(checkPin(f.db, link, "222222", at(ms)()));
    };
    await wrong(1000);
    await wrong(2000);
    expect(await wrong(3000)).toBe("surface.pin_locked");
    const [row] = await f.db.select().from(surfaceLinks).where(eq(surfaceLinks.id, linkId));
    expect(row?.pinLockedUntil?.getTime()).toBe(T0.getTime() + 3000 + PIN_LOCKS_MS[0]);
  });

  test("tries sent at once still get three before the lock", async () => {
    const { token, linkId } = await page();
    await f.db
      .update(surfaceLinks)
      .set({ pinHash: await Bun.password.hash("111111") })
      .where(eq(surfaceLinks.id, linkId));
    const secret = (await openSurfacePage({ db: f.db, now: at(0) }, token, null)).secret;
    const pins = ["222222", "333333", "444444", "555555", "111111"];
    const codes = await Promise.all(
      pins.map((pin) => codeOf(decideOnSurfacePage(deps(1000), token, secret, { decision: "approve", pin }))),
    );
    expect(codes.filter((c) => c === "surface.pin_wrong").length).toBeLessThanOrEqual(2);
    expect(codes.at(-1)).toBe("surface.pin_locked");
  });

  test("an emailed link chooses it once, replacing a forgotten one and its lock", async () => {
    const { token, linkId } = await page();
    await verified();
    await f.db
      .update(surfaceLinks)
      .set({ pinHash: "old", pinFailures: 2, pinLockedUntil: new Date(Date.now() + 60_000) })
      .where(eq(surfaceLinks.id, linkId));
    const secret = (await openSurfacePage({ db: f.db, now: at(0) }, token, null)).secret;
    expect((await openSurfacePage({ db: f.db, now: at(0) }, token, secret)).view.pin.emailVerified).toBe(true);
    await emailPinLink({ db: f.db, now: at(1000), publicUrl: "https://app.example.com" }, token, secret);
    const [job] = await f.db.select().from(outbox).where(eq(outbox.kind, "email.send"));
    const payload = job?.payload as { template?: { url?: string } } | undefined;
    const url = String(payload?.template?.url);
    expect(url).toStartWith("https://app.example.com/email-undo?kind=surface-pin&token=");
    const reset = new URL(url).searchParams.get("token") ?? "";
    // A PIN of the wrong shape spends nothing.
    expect(await codeOf(setPinFromEmail(f.db, reset, "12345"))).toBe("surface.pin_shape");
    expect(await setPinFromEmail(f.db, reset, "654321")).toEqual({ surface: "Example Chat" });
    const [row] = await f.db.select().from(surfaceLinks).where(eq(surfaceLinks.id, linkId));
    expect(await Bun.password.verify("654321", row?.pinHash ?? "")).toBe(true);
    expect([row?.pinFailures, row?.pinLockedUntil]).toEqual([0, null]);
    expect(await codeOf(setPinFromEmail(f.db, reset, "777777"))).toBe("surface.pin_reset_gone");
  });

  test("an emailed link sent before the account's address changed no longer chooses it", async () => {
    const { token, linkId } = await page();
    await verified();
    const secret = (await openSurfacePage({ db: f.db, now: at(0) }, token, null)).secret;
    await emailPinLink({ db: f.db, now: at(1000), publicUrl: "https://app.example.com" }, token, secret);
    const [job] = await f.db.select().from(outbox).where(eq(outbox.kind, "email.send"));
    const url = String((job?.payload as { template?: { url?: string } } | undefined)?.template?.url);
    const reset = new URL(url).searchParams.get("token") ?? "";
    await f.db.update(schema.users).set({ email: "new@example.com" }).where(eq(schema.users.id, f.owner.id));
    expect(await codeOf(setPinFromEmail(f.db, reset, "654321"))).toBe("surface.pin_reset_gone");
    const [row] = await f.db.select().from(surfaceLinks).where(eq(surfaceLinks.id, linkId));
    expect(row?.pinHash).toBeNull();
  });

  test("no link goes to an address that was never verified", async () => {
    const { token } = await page();
    const secret = (await openSurfacePage({ db: f.db, now: at(0) }, token, null)).secret;
    expect((await openSurfacePage({ db: f.db, now: at(0) }, token, secret)).view.pin.emailVerified).toBe(false);
    expect(
      await codeOf(emailPinLink({ db: f.db, now: at(1000), publicUrl: "https://app.example.com" }, token, secret)),
    ).toBe("surface.email_unverified");
    expect(await f.db.select().from(outbox).where(eq(outbox.kind, "email.send"))).toEqual([]);
  });

  test("three emails an hour for the person, from any address or page", async () => {
    const { token } = await page();
    await verified();
    const secret = (await openSurfacePage({ db: f.db, now: at(0) }, token, null)).secret;
    const ask = (ms: number) =>
      codeOf(emailPinLink({ db: f.db, now: at(ms), publicUrl: "https://app.example.com" }, token, secret));
    expect([await ask(1000), await ask(2000), await ask(3000)]).toEqual(["ok", "ok", "ok"]);
    expect(await ask(4000)).toBe("rate_limited");
    expect(await f.db.select().from(outbox).where(eq(outbox.kind, "email.send"))).toHaveLength(3);
    await f.db.update(schema.verifications).set({ createdAt: new Date(T0.getTime() - minutes(61)) });
    expect(await ask(5000)).toBe("ok");
  });
});

test("the same sender linked again keeps the PIN; another sender of the account starts without one", async () => {
  const first = await linked();
  await f.db.update(surfaceLinks).set({ pinHash: "kept" }).where(eq(surfaceLinks.id, first));
  await linked();
  expect((await f.db.select().from(surfaceLinks))[0]?.pinHash).toBe("kept");
  const { code } = await mintLinkCode(f.db, f.owner.id, f.org.id);
  const { link } = await claimLink(
    { db: f.db },
    { externalId: "sender-88", display: "+1 555 0101", profileName: null, code },
  );
  await confirmLink({ db: f.db }, f.owner.id, link.id);
  expect((await f.db.select().from(surfaceLinks))[0]?.pinHash).toBeNull();
});

async function surfaceTurn() {
  await linked();
  const { lodi, channel } = await dm();
  const ask = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: channel.id,
    author: { type: "person", userId: f.owner.id },
    body: "apaga a chave antiga",
    meta: {
      via: { kind: "surface", surface: "example chat", linkId: (await f.db.select().from(surfaceLinks))[0]?.id },
    },
  });
  const [run] = await f.db
    .insert(agentRuns)
    .values({
      orgId: f.org.id,
      agentId: lodi.id,
      channelId: channel.id,
      threadRootId: ask.id,
      triggerMessageId: ask.id,
      trigger: "dm",
      hop: 1,
      status: "waiting_approval",
    })
    .returning();
  return { lodi, channel, run };
}

test("an approval's card in a surface reply opens its own page, not the app", async () => {
  const { lodi, channel, run } = await surfaceTurn();
  const asked = await approval();
  const card = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: channel.id,
    author: { type: "agent", agentId: lodi.id, runId: run?.id ?? "", hop: 1 },
    body: "Approval request: Delete the key OLD_KEY",
    meta: { approvalId: asked.id },
  });
  expect(await queueSurfaceDelivery(f.db, f.org.id, card.id)).toBe(true);
  const [listed] = await listSurfaceDeliveries({ db: f.db }, 10);
  expect(listed?.card?.kind).toBe("approval");
  expect(listed?.card?.url).toMatch(/\/surface-page\?token=[\w-]{40,}$/);
  const [minted] = await f.db.select().from(surfacePageLinks);
  expect([minted?.kind, minted?.targetId]).toEqual(["confirm", asked.id]);
});

test("an approval someone else decides opens the app: a PIN there couldn't decide it", async () => {
  const { lodi, channel, run } = await surfaceTurn();
  const other = await addMember(f.db, f.org.id, "member", "Approver");
  const asked = await approval({
    userIds: [other.id],
    label: "Approver",
    requestedBy: f.owner.id,
    requesterDecides: false,
    required: true,
  });
  const card = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: channel.id,
    author: { type: "agent", agentId: lodi.id, runId: run?.id ?? "", hop: 1 },
    body: "Approval request: Delete the key OLD_KEY",
    meta: { approvalId: asked.id },
  });
  expect(await queueSurfaceDelivery(f.db, f.org.id, card.id)).toBe(true);
  const [listed] = await listSurfaceDeliveries({ db: f.db }, 10);
  expect(listed?.card?.kind).toBe("approval");
  expect(listed?.card?.url).not.toContain("/surface-page");
  expect(await f.db.select().from(surfacePageLinks)).toEqual([]);
});
