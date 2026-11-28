import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { mintReferralsLink, openLinkToken, REFERRALS_ORGS, type ReferralsLinkClaims } from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

const SECRET = "test-referrals-link-secret-0000000000000";
const NOW = new Date("2027-01-01T00:00:00Z");
const mint = (userId: string, returnTo?: string, baseUrl = "https://refer.example.com") =>
  mintReferralsLink(f.db, { secret: SECRET, baseUrl, userId, returnTo, now: NOW });

/** The link's token, opened like the referral service opens it. */
function claimsOf(url: string) {
  return openLinkToken(SECRET, new URL(url).searchParams.get("t") ?? "") as ReferralsLinkClaims;
}

describe("mintReferralsLink", () => {
  test("sealed with the secret, for 5 minutes, carrying who the person is and their workspaces", async () => {
    const admin = await addMember(f.db, f.org.id, "admin");
    const member = await addMember(f.db, f.org.id, "member");
    await f.db.update(schema.users).set({ locale: "en" }).where(eq(schema.users.id, member.id));
    const link = await mint(f.owner.id);
    expect(link.url.startsWith("https://refer.example.com/link?t=v2.")).toBe(true);
    expect(link.expiresAt).toEqual(new Date(NOW.getTime() + 300_000));
    const [owner] = await f.db.select().from(schema.users).where(eq(schema.users.id, f.owner.id));
    const claims = claimsOf(link.url);
    expect(claims).toEqual({
      aud: "agentes-referrals",
      jti: expect.any(String),
      iat: NOW.getTime() / 1000,
      exp: NOW.getTime() / 1000 + 300,
      userId: f.owner.id,
      email: owner?.email ?? "",
      name: owner?.name ?? "",
      locale: "pt-BR",
      orgs: [{ id: f.org.id, name: "Acme", role: "owner" }],
      return: "/",
    });
    expect(claimsOf((await mint(f.owner.id)).url).jti).not.toBe(claims.jti);
    expect(claimsOf((await mint(admin.id)).url).orgs).toEqual([{ id: f.org.id, name: "Acme", role: "admin" }]);
    expect(claimsOf((await mint(member.id)).url)).toMatchObject({
      locale: "en",
      orgs: [{ id: f.org.id, name: "Acme", role: "member" }],
    });
  });

  test("leaves out a suspended workspace, keeps one held for payment", async () => {
    const [held] = await f.db
      .insert(schema.organizations)
      .values({ name: "Held", standing: "hold" })
      .returning({ id: schema.organizations.id });
    if (!held) throw new Error("no workspace");
    await f.db.insert(schema.organizationMembers).values({ orgId: held.id, userId: f.owner.id, role: "owner" });
    await f.db.update(schema.organizations).set({ standing: "suspended" }).where(eq(schema.organizations.id, f.org.id));
    expect(claimsOf((await mint(f.owner.id)).url).orgs).toEqual([{ id: held.id, name: "Held", role: "owner" }]);
  });

  test("a person with no workspace gets a link with none", async () => {
    const loner = await addUser(f.db, "loner");
    expect(claimsOf((await mint(loner.id)).url).orgs).toEqual([]);
  });

  test("leaves out a blocked account's memberships and workspaces being deleted, and caps at 50", async () => {
    const blocked = await addMember(f.db, f.org.id, "member", "blocked");
    await f.db.update(schema.users).set({ blockedAt: NOW }).where(eq(schema.users.id, blocked.id));
    expect(claimsOf((await mint(blocked.id)).url).orgs).toEqual([]);

    await f.db.update(schema.organizations).set({ deletionDueAt: NOW }).where(eq(schema.organizations.id, f.org.id));
    expect(claimsOf((await mint(f.owner.id)).url).orgs).toEqual([]);

    const many = await f.db
      .insert(schema.organizations)
      .values(Array.from({ length: REFERRALS_ORGS + 2 }, (_, i) => ({ name: `Team ${i}` })))
      .returning({ id: schema.organizations.id });
    await f.db
      .insert(schema.organizationMembers)
      .values(many.map(({ id }) => ({ orgId: id, userId: f.owner.id, role: "member" as const })));
    const orgs = claimsOf((await mint(f.owner.id)).url).orgs;
    expect(orgs).toHaveLength(REFERRALS_ORGS);
    expect(orgs.some((o) => o.id === f.org.id)).toBe(false);
  });

  test("return: the root or a workspace path in the shape the services accept, else the root", async () => {
    const back = async (returnTo: string | undefined) => claimsOf((await mint(f.owner.id, returnTo)).url).return;
    const org = `/org/${f.org.id}`;
    const channel = `${org}/c/0b6f4c1e-8d2a-4f3b-9c7e-5a1d2e3f4a5b`;
    expect(await back(undefined)).toBe("/");
    expect(await back("/")).toBe("/");
    expect(await back(org)).toBe(org);
    expect(await back(`${channel}?thread=m-1#x`)).toBe(channel);
    for (const junk of [
      "https://evil.example.com/org",
      `//evil.example.com${org}/`,
      "/onboarding",
      `${org}x/c/abc`,
      `${org}/wiki/Café`,
      `${org}/c/a b`,
      "/org/someone-else/c/abc",
    ])
      expect(await back(junk)).toBe("/");
  });

  test("keeps a path in the service's address, with no doubled slash", async () => {
    expect((await mint(f.owner.id, undefined, "https://example.com/refer/")).url).toMatch(
      /^https:\/\/example\.com\/refer\/link\?t=v2\./,
    );
    expect((await mint(f.owner.id, undefined, "https://example.com/refer")).url).toMatch(
      /^https:\/\/example\.com\/refer\/link\?t=v2\./,
    );
  });
});
