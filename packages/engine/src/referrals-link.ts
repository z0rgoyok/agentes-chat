import { randomUUID } from "node:crypto";
import { type Database, eq, schema } from "@agenteschat/db";
import { appLocale } from "@agenteschat/i18n/locale";
import { BILLING_LINK_SECONDS, linkReturnPath, linkUrl, sealLinkToken } from "./billing-link";
import { can, listMemberships, type UserLocale } from "./organizations";
import { closedRefusal } from "./standing";

export interface ReferralsLinkClaims {
  aud: "agentes-referrals";
  /** Single use on the referral service's side. */
  jti: string;
  /** Seconds. */
  iat: number;
  exp: number;
  userId: string;
  email: string;
  name: string;
  locale: UserLocale;
  /**
   * The workspaces the person is in, at most `REFERRALS_ORGS`; none suspended or being deleted, as the billing link
   * refuses a suspended one. A billing hold stays in: paying is how it ends. A blocked account has none.
   */
  orgs: { id: string; name: string; role: "owner" | "admin" | "member" }[];
  /** The path in this app the referral service sends the person back to (`linkReturnPath`, or `/`). */
  return: string;
}

export const REFERRALS_ORGS = 50;

/**
 * A sealed link to the referral service (ADR 0192), the person's own: no workspace's permission is needed. Owner and
 * admin are decided as the billing link decides them (owner, else `manage_billing`).
 */
export async function mintReferralsLink(
  db: Database,
  input: { secret: string; baseUrl: string; userId: string; returnTo?: string; now?: Date },
): Promise<{ url: string; expiresAt: Date }> {
  const { userId } = input;
  const [[user], memberships] = await Promise.all([
    db
      .select({ email: schema.users.email, name: schema.users.name, locale: schema.users.locale })
      .from(schema.users)
      .where(eq(schema.users.id, userId)),
    listMemberships(db, userId),
  ]);
  if (!user) throw new Error("referrals link: the account is gone");
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const exp = iat + BILLING_LINK_SECONDS;
  const claims: ReferralsLinkClaims = {
    aud: "agentes-referrals",
    jti: randomUUID(),
    iat,
    exp,
    userId,
    email: user.email,
    name: user.name,
    locale: appLocale([user.locale], true) ?? "en",
    orgs: memberships
      .filter((m) => !closedRefusal(m.standing))
      .slice(0, REFERRALS_ORGS)
      .map((m) => ({
        id: m.orgId,
        name: m.orgName,
        role: m.role === "owner" ? "owner" : can(m, "manage_billing") ? "admin" : "member",
      })),
    return: linkReturnPath(input.returnTo) ?? "/",
  };
  return { url: linkUrl(input.baseUrl, sealLinkToken(input.secret, claims)), expiresAt: new Date(exp * 1000) };
}
