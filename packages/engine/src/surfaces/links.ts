import { randomBytes, randomUUID } from "node:crypto";
import { type PubSub, type RateLimiter, retryInSeconds } from "@agenteschat/adapters";
import { and, asc, type Database, desc, type Executor, eq, gt, lte, or, type SQL, schema, sql } from "@agenteschat/db";
import { CODE_ALPHABET, newConfirmationCode } from "../codes";
import { sha256 } from "../crypto";
import { emailAssistant, emailLocale, queueEmail } from "../email";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, TooManyError } from "../errors";
import { publishUserEvent } from "../events";
import { recordOperatorEvent } from "../operator-events";
import { getMembership } from "../organizations";
import { personLocale } from "../requester";
import { lodiFor, postFromLodi } from "../right-hand-proactive";
import { surfaceOn } from "./config";

/**
 * Links between a sender on the outside chat surface and an account (ADR 0187): a code minted in the app, typed on
 * the surface and claimed by its service (a `pending` link), then confirmed in the app (`active`). Ended links are
 * deleted. A pending link older than `PENDING_LINK_MS` counts as gone wherever it is read; no job sweeps it.
 */

const { surfaceLinks, surfaceDeliveries, verifications, organizations, users } = schema;

export const LINK_CODE_TTL_MS = 10 * 60_000;
export const PENDING_LINK_MS = 10 * 60_000;
/** How long the "linked" email's "Not you? Unlink it" works. */
export const SURFACE_UNDO_MS = 7 * 24 * 3_600_000;

export type SurfaceLinkRow = typeof surfaceLinks.$inferSelect;
export type SurfaceLinkStatus = "pending" | "active" | "gone";

export interface SurfaceLinkView {
  id: string;
  status: "pending" | "active";
  display: string | null;
  profileName: string | null;
  orgId: string | null;
  orgName: string | null;
  createdAt: string;
  confirmedAt: string | null;
  /** Pending only: when it stops counting. */
  expiresAt: string | null;
}

/** `publicUrl`: where the emails link to; absent or null on a server that sends no email, which sends none. */
type LinkDeps = { db: Database; pubsub?: PubSub; publicUrl?: string | null };

const CODE_LENGTH = 8;
const CODE_SHAPE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);
const codeId = (normalised: string) => `surface-link:${sha256(normalised)}`;
const undoId = (token: string) => `surface-undo:${sha256(token)}`;
const pendingSince = () => new Date(Date.now() - PENDING_LINK_MS);
const pendingExpiry = (createdAt: Date) => new Date(createdAt.getTime() + PENDING_LINK_MS);

/** A typed code as stored: upper-cased, without spaces or dashes, 8 letters of the alphabet; anything else is null. */
export function normalizeLinkCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  return CODE_SHAPE.test(code) ? code : null;
}

/** This server's surface, or `surface.off` (404) when the bridge is off. */
export function requireSurface() {
  const surface = surfaceOn();
  if (!surface) throw new NotFoundError("Outside chat surfaces are off on this server", "surface.off");
  return surface;
}

const changed = (deps: LinkDeps, link: Pick<SurfaceLinkRow, "id" | "orgId" | "userId">, status: SurfaceLinkStatus) =>
  link.orgId
    ? publishUserEvent(deps.pubsub, link.orgId, link.userId, { type: "surface_link.changed", linkId: link.id, status })
    : Promise.resolve();

/** Pending links of the account that no longer count: deleted by its next mint or claim. */
const dropStalePending = (db: Executor, userId: string) =>
  db
    .delete(surfaceLinks)
    .where(
      and(
        eq(surfaceLinks.userId, userId),
        eq(surfaceLinks.status, "pending"),
        lte(surfaceLinks.createdAt, pendingSince()),
      ),
    );

/**
 * A code the person types on the surface to link it to their account, answering in `orgId`. Earlier codes keep
 * working until they expire. `forbidden` when not a member; `surface.no_assistant` when the right hand there may not
 * talk to them.
 */
export async function mintLinkCode(db: Database, userId: string, orgId: string) {
  const surface = requireSurface();
  if (!(await getMembership(db, userId, orgId))) throw new ForbiddenError();
  if (!(await lodiFor(db, orgId, userId))) {
    throw new ConflictError("The assistant of this workspace can't talk to you", "surface.no_assistant");
  }
  await dropStalePending(db, userId);
  const code = newConfirmationCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MS);
  await db.insert(verifications).values({
    id: randomUUID(),
    identifier: codeId(normalizeLinkCode(code) ?? code),
    value: JSON.stringify({ userId, orgId }),
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  return { code, openUrl: surface.openUrl.replace("{text}", encodeURIComponent(code)), expiresAt };
}

function codeValue(value: string): { userId: string; orgId: string } | null {
  try {
    const v = JSON.parse(value) as Record<string, unknown>;
    return typeof v.userId === "string" && typeof v.orgId === "string" ? { userId: v.userId, orgId: v.orgId } : null;
  } catch {
    return null;
  }
}

/**
 * A code arrived from a sender on the surface: spent at once, it makes a pending link the person confirms in the app.
 * A wrong, used or expired code is the same `surface.code_gone`. `surface.taken` when the sender is linked to another
 * account, which leaves the code unspent. The caller counts claims before (wrong codes count too).
 */
export async function claimLink(
  deps: LinkDeps,
  input: { externalId: string; display: string | null; profileName: string | null; code: string },
) {
  const surface = requireSurface();
  const normalised = normalizeLinkCode(input.code);
  const link = await deps.db.transaction(async (tx) => {
    // The delete is the single use: a second claim of the same code waits for this one and finds nothing.
    const [row] = normalised
      ? await tx
          .delete(verifications)
          .where(and(eq(verifications.identifier, codeId(normalised)), gt(verifications.expiresAt, new Date())))
          .returning()
      : [];
    const owner = row ? codeValue(row.value) : null;
    if (!owner) throw new NotFoundError("This code is wrong, used or expired", "surface.code_gone");
    const taken = await activeLink(tx, input.externalId);
    // Thrown inside the transaction, so the code is not spent.
    if (taken && taken.userId !== owner.userId) {
      throw new ConflictError("This sender is linked to another account", "surface.taken");
    }
    await dropStalePending(tx, owner.userId);
    const [inserted] = await tx
      .insert(surfaceLinks)
      .values({
        userId: owner.userId,
        surface: surface.id,
        externalId: input.externalId,
        display: input.display,
        profileName: input.profileName,
        status: "pending",
        orgId: owner.orgId,
      })
      .returning();
    if (!inserted) throw new Error("surface link not written");
    return inserted;
  });
  await changed(deps, link, "pending");
  return { link, expiresAt: pendingExpiry(link.createdAt), locale: await personLocale(deps.db, link.userId) };
}

/**
 * The person confirms a pending link in the app: it becomes the account's one active link on the surface, replacing
 * the old one (or moving this sender's link to another workspace), and the service is told to say so (`linked`).
 */
export async function confirmLink(deps: LinkDeps, userId: string, linkId: string): Promise<SurfaceLinkView> {
  const surface = requireSurface();
  const pendingWhere = and(
    eq(surfaceLinks.id, linkId),
    eq(surfaceLinks.userId, userId),
    eq(surfaceLinks.surface, surface.id),
    eq(surfaceLinks.status, "pending"),
    gt(surfaceLinks.createdAt, pendingSince()),
  );
  // The right hand is asked before the transaction: its reads take a `Database`, not the transaction's handle.
  const [first] = await deps.db.select({ orgId: surfaceLinks.orgId }).from(surfaceLinks).where(pendingWhere);
  const assistant = first?.orgId ? await lodiFor(deps.db, first.orgId, userId) : null;
  const confirmed = deps.db.transaction(async (tx) => {
    const [pending] = await tx.select().from(surfaceLinks).where(pendingWhere).for("update");
    if (!pending) throw new NotFoundError("This link is no longer waiting", "surface.link_gone");
    const taken = await activeLink(tx, pending.externalId);
    if (taken && taken.userId !== userId) {
      throw new ConflictError("This sender is linked to another account", "surface.taken");
    }
    if (!pending.orgId || !(await getMembership(tx, userId, pending.orgId))) {
      throw new ConflictError("You are not in this workspace", "surface.no_workspace");
    }
    if (!assistant || assistant.orgId !== pending.orgId) {
      throw new ConflictError("The assistant of this workspace can't talk to you", "surface.no_assistant");
    }
    // The account's old link, which is also this sender's when it only moves to another workspace.
    const replaced = await tx
      .delete(surfaceLinks)
      .where(
        and(eq(surfaceLinks.userId, userId), eq(surfaceLinks.surface, surface.id), eq(surfaceLinks.status, "active")),
      )
      .returning();
    const [active] = await tx
      .update(surfaceLinks)
      .set({ status: "active", confirmedAt: new Date() })
      .where(eq(surfaceLinks.id, pending.id))
      .returning();
    if (!active?.orgId) throw new Error("surface link not confirmed");
    await tx.insert(surfaceDeliveries).values({ orgId: active.orgId, linkId: active.id, kind: "linked" });
    if (deps.publicUrl) await queueLinkedEmail(tx, deps.publicUrl, active);
    return { link: active, replaced };
  });
  // Only the pending row is locked: a confirm racing for the same sender or account loses on the unique index.
  const { link, replaced } = await confirmed.catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError("This sender is linked to another account", "surface.taken");
    throw error;
  });
  for (const old of replaced) await changed(deps, old, "gone");
  await changed(deps, link, "active");
  const [view] = await viewsOf(deps.db, eq(surfaceLinks.id, link.id));
  if (!view) throw new NotFoundError("This link is no longer waiting", "surface.link_gone");
  return view;
}

/** Cancels the person's pending link or ends their active one. `surface.link_gone` when it isn't theirs (or ran out). */
export async function removeLink(deps: LinkDeps, userId: string, linkId: string): Promise<void> {
  const [gone] = await deps.db
    .delete(surfaceLinks)
    .where(and(eq(surfaceLinks.id, linkId), eq(surfaceLinks.userId, userId)))
    .returning();
  if (!gone || (gone.status === "pending" && gone.createdAt <= pendingSince())) {
    throw new NotFoundError("This link is gone", "surface.link_gone");
  }
  await changed(deps, gone, "gone");
}

/**
 * The surface ends a sender's link: they asked, or their identity there changed. Pending ones go too. `none` when
 * there was no active link, so a second call changes nothing.
 */
export async function unlinkExternal(
  deps: LinkDeps,
  externalId: string,
  reason: "asked" | "identity_changed",
): Promise<"unlinked" | "none"> {
  const surface = requireSurface();
  // The delete and the email commit together, so a retry that finds nothing left has nothing left to send.
  const { gone, active } = await deps.db.transaction(async (tx) => {
    const gone = await tx
      .delete(surfaceLinks)
      .where(and(eq(surfaceLinks.surface, surface.id), eq(surfaceLinks.externalId, externalId)))
      .returning();
    const active = gone.find((l) => l.status === "active");
    // The person didn't ask: they hear it in the app and by email, since the surface no longer reaches them.
    if (active && reason === "identity_changed" && deps.publicUrl) {
      const [user] = await tx
        .select({ email: users.email, locale: users.locale })
        .from(users)
        .where(eq(users.id, active.userId));
      if (user) {
        await queueEmail(tx, {
          orgId: null,
          key: `surface-unlinked:${active.id}`,
          to: [user.email],
          template: {
            assistant: await emailAssistant(tx, active.orgId),
            kind: "surface_unlinked",
            locale: emailLocale(user.locale),
            surface: surface.name,
            display: shownAs(active),
            url: deps.publicUrl,
          },
        });
      }
    }
    return { gone, active };
  });
  for (const link of gone) await changed(deps, link, "gone");
  if (active?.orgId && reason === "identity_changed") {
    // The unlink and its email stand even when this line can't be posted now; a retry would find no link.
    await postFromLodi(deps, active.orgId, active.userId, {
      bodyCode: "surfaceUnlinked",
      bodyParams: { surface: surface.name },
      push: true,
    }).catch(() => null);
  }
  return active ? "unlinked" : "none";
}

/**
 * "Not you? Unlink it" from the "linked" email, through the undo page: once, within `SURFACE_UNDO_MS`, it ends that
 * link if it is still active. `surface.undo_gone` when used or run out.
 */
export async function undoSurfaceLink(
  deps: LinkDeps,
  token: string,
): Promise<{ unlinked: boolean; surface: string; display: string | null }> {
  // The delete is the single use: a second one at the same moment waits for this one and finds nothing.
  const [row] = await deps.db
    .delete(verifications)
    .where(eq(verifications.identifier, undoId(token)))
    .returning();
  const undo = row && row.expiresAt > new Date() ? undoValue(row.value) : null;
  if (!undo) throw new NotFoundError("This link expired or was already used", "surface.undo_gone");
  const gone = await deps.db
    .delete(surfaceLinks)
    .where(
      and(eq(surfaceLinks.id, undo.linkId), eq(surfaceLinks.userId, undo.userId), eq(surfaceLinks.status, "active")),
    )
    .returning();
  for (const link of gone) await changed(deps, link, "gone");
  // What the email named, kept with the token: the link may have ended before the undo.
  return { unlinked: gone.length > 0, surface: surfaceOn()?.name ?? "", display: undo.display };
}

function undoValue(value: string): { userId: string; linkId: string; display: string | null } | null {
  try {
    const v = JSON.parse(value) as Record<string, unknown>;
    return typeof v.userId === "string" && typeof v.linkId === "string"
      ? { userId: v.userId, linkId: v.linkId, display: typeof v.display === "string" ? v.display : null }
      : null;
  } catch {
    return null;
  }
}

/** How the emails name the sender: what the surface shows of them. */
const shownAs = (link: SurfaceLinkRow) => link.display ?? link.profileName ?? link.externalId;

/** The "linked" email with its single-use undo token, in the confirming transaction. */
async function queueLinkedEmail(tx: Executor, publicUrl: string, link: SurfaceLinkRow) {
  const surface = requireSurface();
  const [row] = await tx
    .select({ email: users.email, locale: users.locale, orgName: organizations.name })
    .from(users)
    .innerJoin(organizations, eq(organizations.id, link.orgId ?? ""))
    .where(eq(users.id, link.userId));
  if (!row) return;
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  await tx.insert(verifications).values({
    id: randomUUID(),
    identifier: undoId(token),
    value: JSON.stringify({ userId: link.userId, linkId: link.id, display: shownAs(link) }),
    expiresAt: new Date(now.getTime() + SURFACE_UNDO_MS),
    createdAt: now,
    updatedAt: now,
  });
  await queueEmail(tx, {
    orgId: null,
    key: `surface-linked:${sha256(token)}`,
    to: [row.email],
    template: {
      assistant: await emailAssistant(tx, link.orgId),
      kind: "surface_linked",
      locale: emailLocale(row.locale),
      surface: surface.name,
      display: shownAs(link),
      orgName: row.orgName,
      url: `${publicUrl.replace(/\/$/, "")}/email-undo?kind=surface&token=${token}`,
    },
  });
}

/**
 * Every link of the account, on every surface: what cuts off its AI apps (a new password, "This wasn't me") and a
 * block cut these off too. Inside the caller's transaction; the apps are told by the sign-out that comes with it.
 */
export async function unlinkAllFor(db: Executor, userId: string): Promise<void> {
  await db.delete(surfaceLinks).where(eq(surfaceLinks.userId, userId));
}

async function viewsOf(db: Executor, where: SQL | undefined): Promise<SurfaceLinkView[]> {
  const rows = await db
    .select({ link: surfaceLinks, orgName: organizations.name })
    .from(surfaceLinks)
    .leftJoin(organizations, eq(organizations.id, surfaceLinks.orgId))
    .where(and(where, or(eq(surfaceLinks.status, "active"), gt(surfaceLinks.createdAt, pendingSince()))))
    .orderBy(asc(sql`${surfaceLinks.status} = 'pending'`), desc(surfaceLinks.createdAt));
  return rows.map(({ link, orgName }) => ({
    id: link.id,
    status: link.status,
    display: link.display,
    profileName: link.profileName,
    orgId: link.orgId,
    orgName: link.orgId ? orgName : null,
    createdAt: link.createdAt.toISOString(),
    confirmedAt: link.confirmedAt?.toISOString() ?? null,
    expiresAt: link.status === "pending" ? pendingExpiry(link.createdAt).toISOString() : null,
  }));
}

/** The account's links on this server's surface: active first, then pending ones that still count. */
export async function listLinks(db: Database, userId: string): Promise<SurfaceLinkView[]> {
  const surface = surfaceOn();
  if (!surface) return [];
  return viewsOf(db, and(eq(surfaceLinks.userId, userId), eq(surfaceLinks.surface, surface.id)));
}

/** The sender's active link on this server's surface. */
export async function activeLink(db: Executor, externalId: string): Promise<SurfaceLinkRow | null> {
  const surface = surfaceOn();
  if (!surface) return null;
  const [row] = await db
    .select()
    .from(surfaceLinks)
    .where(
      and(
        eq(surfaceLinks.surface, surface.id),
        eq(surfaceLinks.externalId, externalId),
        eq(surfaceLinks.status, "active"),
      ),
    );
  return row ?? null;
}

/** The account's active link on this server's surface. */
export async function activeLinkOf(db: Executor, userId: string): Promise<SurfaceLinkRow | null> {
  const surface = surfaceOn();
  if (!surface) return null;
  const [row] = await db
    .select()
    .from(surfaceLinks)
    .where(
      and(eq(surfaceLinks.surface, surface.id), eq(surfaceLinks.userId, userId), eq(surfaceLinks.status, "active")),
    );
  return row ?? null;
}

/** Caps across every sender on the surface (ADR 0187): past one, the bridge answers `surface.busy`. */
export const SURFACE_CAPS = {
  claims: { limit: 120, windowMs: 3_600_000 },
  posts: { limit: 600, windowMs: 60_000 },
} as const;
const ALERT_EVERY = { limit: 1, windowMs: 3_600_000 };

/**
 * Counts one call against a cap across every sender. Past it, operators get one `surface.cap_reached` event an hour
 * (and `warn`), and the call is refused with `surface.busy`.
 */
export async function takeSurfaceCap(
  deps: { db: Executor; rateLimiter: RateLimiter; warn?: (message: string, data: Record<string, unknown>) => void },
  cap: keyof typeof SURFACE_CAPS,
) {
  const taken = await deps.rateLimiter.consume(`surface:all:${cap}`, SURFACE_CAPS[cap]);
  if (taken.allowed) return;
  if ((await deps.rateLimiter.consume(`surface:alert:${cap}`, ALERT_EVERY)).allowed) {
    await recordOperatorEvent(deps.db, { type: "surface.cap_reached", data: { cap } });
    deps.warn?.("surface cap reached", { cap });
  }
  throw new TooManyError("The surface bridge is busy", "surface.busy", { retryIn: retryInSeconds(taken.resetAt) });
}
