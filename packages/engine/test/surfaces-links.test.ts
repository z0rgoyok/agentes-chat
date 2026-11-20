import { afterEach, beforeEach, expect, test } from "bun:test";
import { type RealtimeEvent, userTopic } from "@agenteschat/adapters";
import { and, eq, like, schema } from "@agenteschat/db";
import {
  activeLink,
  activeLinkOf,
  claimLink,
  confirmLink,
  createOrganization,
  listLinks,
  mintLinkCode,
  normalizeLinkCode,
  PENDING_LINK_MS,
  removeLink,
  revokeUserApps,
  setSurface,
  setUserBlocked,
  undoSurfaceLink,
  unlinkExternal,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

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

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const SENDER = "sender-1001";

async function codeOf(userId = f.owner.id, orgId = f.org.id) {
  return (await mintLinkCode(f.db, userId, orgId)).code;
}

async function claim(code: string, externalId = SENDER) {
  return claimLink(deps(), { externalId, display: "+1 555 0100", profileName: "Ana A.", code });
}

const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};

const links = (userId = f.owner.id) =>
  f.db.select().from(schema.surfaceLinks).where(eq(schema.surfaceLinks.userId, userId));

test("codes normalise: case, spaces and dashes don't matter; anything else is no code", () => {
  expect(normalizeLinkCode(" kq7m-3xpf ")).toBe("KQ7M3XPF");
  expect(normalizeLinkCode("KQ7M 3XPF")).toBe("KQ7M3XPF");
  expect(normalizeLinkCode("KQ7M3XP")).toBeNull();
  expect(normalizeLinkCode("KQ7M3XP0")).toBeNull();
  expect(normalizeLinkCode("")).toBeNull();
});

test("a minted code opens the surface with it typed, and claims once", async () => {
  const minted = await mintLinkCode(f.db, f.owner.id, f.org.id);
  expect(minted.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(minted.openUrl).toBe(`https://chat.example.com/open?text=${encodeURIComponent(minted.code)}`);
  const events: RealtimeEvent[] = [];
  f.pubsub.subscribe(userTopic(f.org.id, f.owner.id), (e) => events.push(e));
  const claimed = await claim(minted.code.toLowerCase().replace("-", " "));
  expect(claimed.link).toMatchObject({ status: "pending", display: "+1 555 0100", profileName: "Ana A." });
  expect(claimed.locale).toBe("pt-BR");
  expect(claimed.expiresAt.getTime() - claimed.link.createdAt.getTime()).toBe(PENDING_LINK_MS);
  expect(events).toContainEqual({ type: "surface_link.changed", linkId: claimed.link.id, status: "pending" });
  expect(await errorOf(claim(minted.code))).toBe("surface.code_gone");
});

test("wrong, used and expired codes answer the same", async () => {
  const used = await codeOf();
  await claim(used);
  const expired = await codeOf();
  await f.db
    .update(schema.verifications)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(schema.verifications.value, JSON.stringify({ userId: f.owner.id, orgId: f.org.id })));
  for (const code of [used, expired, "AAAA-AAAA", "nonsense!"]) {
    expect(await errorOf(claim(code, "sender-other"))).toBe("surface.code_gone");
  }
});

test("two claims of one code at once make exactly one pending link", async () => {
  const code = await codeOf();
  const answers = await Promise.all([errorOf(claim(code, "sender-a")), errorOf(claim(code, "sender-b"))]);
  expect(answers.sort()).toEqual(["ok", "surface.code_gone"]);
  expect(await links()).toHaveLength(1);
});

test("a pending link older than 10 minutes is gone: not listed, not confirmed, and swept by the next mint", async () => {
  const { link } = await claim(await codeOf());
  expect((await listLinks(f.db, f.owner.id)).map((l) => l.id)).toEqual([link.id]);
  await f.db
    .update(schema.surfaceLinks)
    .set({ createdAt: new Date(Date.now() - PENDING_LINK_MS - 1000) })
    .where(eq(schema.surfaceLinks.id, link.id));
  expect(await listLinks(f.db, f.owner.id)).toEqual([]);
  expect(await errorOf(confirmLink(deps(), f.owner.id, link.id))).toBe("surface.link_gone");
  expect(await errorOf(removeLink(deps(), f.owner.id, link.id))).toBe("surface.link_gone");
  const again = await claim(await codeOf(), "sender-2");
  await f.db
    .update(schema.surfaceLinks)
    .set({ createdAt: new Date(Date.now() - PENDING_LINK_MS - 1000) })
    .where(eq(schema.surfaceLinks.id, again.link.id));
  await codeOf();
  expect(await links()).toEqual([]);
});

test("another account can't confirm or remove my pending link", async () => {
  const bea = await addMember(f.db, f.org.id, "member", "bea");
  const { link } = await claim(await codeOf());
  expect(await errorOf(confirmLink(deps(), bea.id, link.id))).toBe("surface.link_gone");
  expect(await errorOf(removeLink(deps(), bea.id, link.id))).toBe("surface.link_gone");
  expect(await links()).toHaveLength(1);
});

test("confirm makes the link active, tells the apps, and writes one linked delivery", async () => {
  const { link } = await claim(await codeOf());
  const events: RealtimeEvent[] = [];
  f.pubsub.subscribe(userTopic(f.org.id, f.owner.id), (e) => events.push(e));
  const view = await confirmLink(deps(), f.owner.id, link.id);
  expect(view).toMatchObject({ id: link.id, status: "active", orgId: f.org.id, orgName: "Acme", expiresAt: null });
  expect(view.confirmedAt).not.toBeNull();
  expect(events).toContainEqual({ type: "surface_link.changed", linkId: link.id, status: "active" });
  expect((await activeLink(f.db, SENDER))?.id).toBe(link.id);
  expect((await activeLinkOf(f.db, f.owner.id))?.id).toBe(link.id);
  const deliveries = await f.db.select().from(schema.surfaceDeliveries);
  expect(deliveries.map((d) => [d.kind, d.linkId, d.orgId, d.messageId])).toEqual([
    ["linked", link.id, f.org.id, null],
  ]);
  expect(await errorOf(confirmLink(deps(), f.owner.id, link.id))).toBe("surface.link_gone");
});

test("a sender active for one account: another's claim is taken (code unspent); the owner's second claim moves it", async () => {
  const bea = await addMember(f.db, f.org.id, "member", "bea");
  const first = await claim(await codeOf());
  await confirmLink(deps(), f.owner.id, first.link.id);
  const beaCode = await codeOf(bea.id);
  expect(await errorOf(claim(beaCode))).toBe("surface.taken");
  // Still unspent: the same code works for a sender nobody holds.
  expect(await errorOf(claim(beaCode, "sender-bea"))).toBe("ok");

  const { organization: other } = await createOrganization(f.db, f.owner.id, { name: "Beta", context: "Beta." });
  const second = await claim(await codeOf(f.owner.id, other.id));
  const moved = await confirmLink(deps(), f.owner.id, second.link.id);
  expect(moved).toMatchObject({ status: "active", orgId: other.id, orgName: "Beta" });
  const active = (await links()).filter((l) => l.status === "active");
  expect(active.map((l) => [l.id, l.orgId])).toEqual([[second.link.id, other.id]]);
});

test("confirming a new sender replaces the account's old link", async () => {
  const first = await claim(await codeOf());
  await confirmLink(deps(), f.owner.id, first.link.id);
  const second = await claim(await codeOf(), "sender-new-phone");
  await confirmLink(deps(), f.owner.id, second.link.id);
  const rows = await links();
  expect(rows.map((l) => [l.externalId, l.status])).toEqual([["sender-new-phone", "active"]]);
  expect(await activeLink(f.db, SENDER)).toBeNull();
});

test("confirm checks the workspace again: not a member, or the right hand can't talk to them", async () => {
  const bea = await addMember(f.db, f.org.id, "member", "bea");
  const left = await claim(await codeOf(bea.id), "sender-bea");
  await f.db
    .delete(schema.organizationMembers)
    .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, bea.id)));
  expect(await errorOf(confirmLink(deps(), bea.id, left.link.id))).toBe("surface.no_workspace");

  const pending = await claim(await codeOf());
  await f.db
    .update(schema.agents)
    .set({ archivedAt: new Date() })
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, "right_hand")));
  expect(await errorOf(confirmLink(deps(), f.owner.id, pending.link.id))).toBe("surface.no_assistant");
  expect(await errorOf(mintLinkCode(f.db, f.owner.id, f.org.id))).toBe("surface.no_assistant");
});

test("minting: only a member, and only with the surface on", async () => {
  const { organization: other } = await createOrganization(f.db, (await addMember(f.db, f.org.id, "member")).id, {
    name: "Elsewhere",
    context: "",
  });
  expect(await errorOf(mintLinkCode(f.db, f.owner.id, other.id))).toBe("forbidden");
  setSurface(null);
  expect(await errorOf(mintLinkCode(f.db, f.owner.id, f.org.id))).toBe("surface.off");
  expect(await listLinks(f.db, f.owner.id)).toEqual([]);
});

test("removing: cancels a pending link and ends an active one", async () => {
  const pending = await claim(await codeOf());
  await removeLink(deps(), f.owner.id, pending.link.id);
  expect(await links()).toEqual([]);
  const active = await claim(await codeOf());
  await confirmLink(deps(), f.owner.id, active.link.id);
  const events: RealtimeEvent[] = [];
  f.pubsub.subscribe(userTopic(f.org.id, f.owner.id), (e) => events.push(e));
  await removeLink(deps(), f.owner.id, active.link.id);
  expect(await links()).toEqual([]);
  expect(events).toContainEqual({ type: "surface_link.changed", linkId: active.link.id, status: "gone" });
});

test("unlinkExternal ends the sender's link and its pending ones; twice is none", async () => {
  const active = await claim(await codeOf());
  await confirmLink(deps(), f.owner.id, active.link.id);
  await claim(await codeOf());
  expect(await unlinkExternal(deps(), SENDER, "asked")).toBe("unlinked");
  expect(await links()).toEqual([]);
  expect(await unlinkExternal(deps(), SENDER, "identity_changed")).toBe("none");
});

test("a new password and a block leave no link; unblocking brings none back", async () => {
  const one = await claim(await codeOf());
  await confirmLink(deps(), f.owner.id, one.link.id);
  await revokeUserApps(f.db, f.owner.id);
  expect(await links()).toEqual([]);

  const two = await claim(await codeOf());
  await confirmLink(deps(), f.owner.id, two.link.id);
  await claim(await codeOf(), "sender-pending");
  await setUserBlocked(deps(), f.owner.id, { blocked: true, reason: "test" });
  expect(await links()).toEqual([]);
  await setUserBlocked(deps(), f.owner.id, { blocked: false, reason: null });
  expect(await links()).toEqual([]);
});

const emails = async (kind: string) =>
  (await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "email.send")))
    .map((j) => j.payload as { key: string; to: string[]; template: Record<string, unknown> & { kind: string } })
    .filter((p) => p.template.kind === kind);
const mailing = () => ({ ...deps(), publicUrl: "https://chat.example.com/" });

test("confirm emails the account once that the surface was linked, with a single-use undo", async () => {
  const { link } = await claim(await codeOf());
  await confirmLink(mailing(), f.owner.id, link.id);
  const [sent, ...more] = await emails("surface_linked");
  expect(more).toEqual([]);
  expect(sent?.to).toEqual([f.owner.email]);
  expect(sent?.template).toMatchObject({
    surface: "Example Chat",
    display: "+1 555 0100",
    orgName: "Acme",
    locale: "pt-BR",
  });
  const url = new URL(String(sent?.template.url));
  expect(`${url.origin}${url.pathname}`).toBe("https://chat.example.com/email-undo");
  expect(url.searchParams.get("kind")).toBe("surface");
  const token = url.searchParams.get("token") ?? "";
  expect(token.length).toBeGreaterThanOrEqual(40);
  // The workspace assistant's own look, for the picture.
  expect(sent?.template.assistant).toEqual({ color: "teal", eyes: "happy", accessory: "headset" });

  const events: RealtimeEvent[] = [];
  f.pubsub.subscribe(userTopic(f.org.id, f.owner.id), (e) => events.push(e));
  expect(await undoSurfaceLink(deps(), token)).toEqual({
    unlinked: true,
    surface: "Example Chat",
    display: "+1 555 0100",
  });
  expect(await links()).toEqual([]);
  expect(events).toContainEqual({ type: "surface_link.changed", linkId: link.id, status: "gone" });
  expect(await errorOf(undoSurfaceLink(deps(), token))).toBe("surface.undo_gone");
  expect(await errorOf(undoSurfaceLink(deps(), "not-a-token-at-all-0000"))).toBe("surface.undo_gone");
});

test("the undo only ends the link it was sent for, and runs out after 7 days", async () => {
  const first = await claim(await codeOf());
  await confirmLink(mailing(), f.owner.id, first.link.id);
  const firstToken = new URL(String((await emails("surface_linked"))[0]?.template.url)).searchParams.get("token") ?? "";
  // A newer link replaced it: the old email's undo leaves the new one alone.
  const second = await claim(await codeOf(), "sender-new-phone");
  await confirmLink(mailing(), f.owner.id, second.link.id);
  expect(await undoSurfaceLink(deps(), firstToken)).toEqual({
    unlinked: false,
    surface: "Example Chat",
    display: "+1 555 0100",
  });
  expect((await activeLinkOf(f.db, f.owner.id))?.id).toBe(second.link.id);

  const secondToken =
    new URL(String((await emails("surface_linked")).at(-1)?.template.url)).searchParams.get("token") ?? "";
  await f.db
    .update(schema.verifications)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(like(schema.verifications.identifier, "surface-undo:%"));
  expect(await errorOf(undoSurfaceLink(deps(), secondToken))).toBe("surface.undo_gone");
  expect((await activeLinkOf(f.db, f.owner.id))?.id).toBe(second.link.id);
});

test("a server that sends no email queues none, and confirm still works", async () => {
  const { link } = await claim(await codeOf());
  await confirmLink(deps(), f.owner.id, link.id);
  expect(await emails("surface_linked")).toEqual([]);
  expect(
    await f.db.select().from(schema.verifications).where(like(schema.verifications.identifier, "surface-undo:%")),
  ).toEqual([]);
});

test("an identity change emails the account and posts one line in its DM with the right hand; asked does neither", async () => {
  const asked = await claim(await codeOf());
  await confirmLink(mailing(), f.owner.id, asked.link.id);
  await unlinkExternal(mailing(), SENDER, "asked");
  expect(await emails("surface_unlinked")).toEqual([]);

  const changed = await claim(await codeOf());
  await confirmLink(mailing(), f.owner.id, changed.link.id);
  expect(await unlinkExternal(mailing(), SENDER, "identity_changed")).toBe("unlinked");
  expect(await unlinkExternal(mailing(), SENDER, "identity_changed")).toBe("none");
  const [sent, ...more] = await emails("surface_unlinked");
  expect(more).toEqual([]);
  expect(sent).toMatchObject({
    to: [f.owner.email],
    template: { surface: "Example Chat", display: "+1 555 0100", url: "https://chat.example.com/" },
  });
  expect(sent?.template.assistant).toEqual({ color: "teal", eyes: "happy", accessory: "headset" });
  const lines = (await f.db.select().from(schema.messages)).filter((m) => m.meta.bodyCode === "surfaceUnlinked");
  expect(lines).toHaveLength(1);
  expect(lines[0]?.meta.bodyParams).toEqual({ surface: "Example Chat" });
  expect(lines[0]?.body).toBe(
    "Example Chat foi desvinculado porque a identidade mudou. Vincule de novo em Configurações se foi você.",
  );
});

test("two confirms racing for one sender: one links, the other is surface.taken, never an internal error", async () => {
  const bea = await addMember(f.db, f.org.id, "member", "bea");
  const mine = await claim(await codeOf());
  const hers = await claim(await codeOf(bea.id));
  const results = await Promise.allSettled([
    confirmLink(deps(), f.owner.id, mine.link.id),
    confirmLink(deps(), bea.id, hers.link.id),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const refused = results.find((r) => r.status === "rejected");
  expect((refused as PromiseRejectedResult | undefined)?.reason?.code).toBe("surface.taken");
  expect(await f.db.select().from(schema.surfaceLinks).where(eq(schema.surfaceLinks.status, "active"))).toHaveLength(1);
});
