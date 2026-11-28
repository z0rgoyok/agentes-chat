import { randomUUID } from "node:crypto";
import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  count,
  type Database,
  type Executor,
  eq,
  gt,
  isNull,
  like,
  lt,
  lte,
  or,
  schema,
  sql,
} from "@agenteschat/db";
import { decideApproval, getApproval } from "../approvals";
import { randomToken, safeEqual, sha256 } from "../crypto";
import { emailAssistant, emailLocale, queueEmail } from "../email";
import { ConflictError, ForbiddenError, NotFoundError, TooManyError, ValidationError } from "../errors";
import { appPageLink, publicPageLink } from "../message-links";
import { getMembership } from "../organizations";
import { surfaceOn } from "./config";

/**
 * Pages of ours opened from a link sent on the outside chat surface, and the PIN that confirms a sensitive act there
 * (ADR 0226). A link is one page: opened once within `PAGE_FIRST_OPEN_MS`, then open for its kind's time in the
 * browser that opened it. It ends early with the surface link (an unlink, a new password, "This wasn't me", a
 * block), and when the person can no longer see what it shows. The URL is never fetched by the server's own GET:
 * the page posts the token, so a chat app's link preview opens nothing.
 */

const { surfacePageLinks, surfaceLinks, verifications, users } = schema;

export type PageKind = "confirm" | "screen" | "control";

export const PAGE_FIRST_OPEN_MS = 10 * 60_000;
/** How long a page stays open after its first open. */
export const PAGE_OPEN_MS: Record<PageKind, number> = {
  confirm: 60 * 60_000,
  screen: 30 * 60_000,
  control: 15 * 60_000,
};
const PAGE_KEEP_MS = 24 * 3_600_000;
export const PIN_TRIES = 3;
/** Each lock since the last right PIN lasts longer; past the last, every one lasts a day. */
export const PIN_LOCKS_MS = [15 * 60_000, 60 * 60_000, 24 * 3_600_000] as const;
/** A lock that ended this long ago no longer makes the next one longer. */
const PIN_LOCKS_FORGOTTEN_MS = 24 * 3_600_000;
const PIN_RESET_MS = 60 * 60_000;
/** Reset emails a person gets an hour, whichever addresses or pages ask: the per-IP limit alone lets one mail-bomb them. */
const PIN_EMAILS_PER_HOUR = 3;
const PIN_SHAPE = /^\d{6}$/;

type PageRow = typeof surfacePageLinks.$inferSelect;
type LinkRow = typeof surfaceLinks.$inferSelect;
type PageDeps = { db: Database; pubsub: PubSub; now?: () => Date };

const gone = () => new NotFoundError("This link ran out. Ask for it again in the chat.", "surface.page_gone");
const pinResetId = (token: string) => `surface-pin:${sha256(token)}`;
const unset = () =>
  new ConflictError("Set your PIN first, in the app or with a link we email you.", "surface.pin_unset");
const locked = (until: Date) =>
  new TooManyError("Too many wrong PINs. Try again later.", "surface.pin_locked", { until: until.toISOString() });

/** A new page link for the person of `linkId`: its URL, with a token that is shown once and kept only hashed. */
export async function mintPageLink(
  db: Executor,
  input: { orgId: string; linkId: string; userId: string; kind: PageKind; targetId: string },
): Promise<string> {
  const token = randomToken(32);
  await db.insert(surfacePageLinks).values({ ...input, tokenHash: sha256(token) });
  return publicPageLink(`/surface-page?token=${token}`);
}

/**
 * The confirm page of an approval the person decides now; null when it waits on someone else or was already decided,
 * so its card opens the app instead of asking for a PIN that can't decide it.
 */
export async function confirmPageLink(
  db: Database,
  input: { orgId: string; linkId: string; userId: string; approvalId: string },
): Promise<string | null> {
  const decides = await getApproval(db, input.userId, input.orgId, input.approvalId).then(
    (a) => a.canDecide && a.status === "pending",
    () => false,
  );
  if (!decides) return null;
  const { approvalId, ...rest } = input;
  return mintPageLink(db, { ...rest, kind: "confirm", targetId: approvalId });
}

/**
 * The page behind `token`, live for this browser. Unopened, it opens now for the browser that gets the returned
 * `secret`, once and within `PAGE_FIRST_OPEN_MS`; opened, only `secret` reopens it, until its kind's time is up.
 * `firstOpen: false` refuses an unopened link: only the page's own first load opens it.
 */
async function livePage(
  db: Database,
  token: string,
  secret: string | null,
  at: Date,
  firstOpen: boolean,
): Promise<{ page: PageRow; link: LinkRow; secret: string | null }> {
  if (!surfaceOn()) throw gone();
  const [found] = await db
    .select({ page: surfacePageLinks, link: surfaceLinks })
    .from(surfacePageLinks)
    .innerJoin(surfaceLinks, eq(surfaceLinks.id, surfacePageLinks.linkId))
    .where(eq(surfacePageLinks.tokenHash, sha256(token)));
  if (found?.link.status !== "active" || found.link.orgId !== found.page.orgId) throw gone();
  if (!(await getMembership(db, found.page.userId, found.page.orgId))) throw gone();
  let { page } = found;
  if (!page.openedAt) {
    if (!firstOpen || at.getTime() - page.createdAt.getTime() > PAGE_FIRST_OPEN_MS) throw gone();
    const fresh = randomToken(32);
    const [opened] = await db
      .update(surfacePageLinks)
      .set({ openedAt: at, browserHash: sha256(fresh) })
      .where(and(eq(surfacePageLinks.id, page.id), isNull(surfacePageLinks.openedAt)))
      .returning();
    if (opened) return { page: opened, link: found.link, secret: fresh };
    // Another browser opened it a moment ago.
    const [now] = await db.select().from(surfacePageLinks).where(eq(surfacePageLinks.id, page.id));
    if (!now) throw gone();
    page = now;
  }
  if (!secret || !page.browserHash || !safeEqual(sha256(secret), page.browserHash)) {
    throw new ForbiddenError(
      "This link was opened on another device. Ask for a new one in the chat.",
      "surface.page_elsewhere",
    );
  }
  if (!page.openedAt || at.getTime() - page.openedAt.getTime() > PAGE_OPEN_MS[page.kind]) throw gone();
  return { page, link: found.link, secret: null };
}

export interface SurfacePageView {
  kind: PageKind;
  /** When the page stops opening. */
  expiresAt: string;
  surface: string;
  /** The workspace the page's approval is in, for the app's settings link. */
  orgId: string;
  pin: {
    set: boolean;
    lockedUntil: string | null;
    /** None set and this browser is signed in as the person: approving here chooses it. */
    canChoose: boolean;
    /** The account's address is verified, so a link to choose it can be emailed there. */
    emailVerified: boolean;
  };
  approval: {
    id: string;
    /** The tool and its input, as the app's card words its title in the reader's language. */
    tool: string;
    params: Record<string, unknown>;
    title: string;
    detail: string;
    why: string | null;
    kind: string;
    titleParams: Record<string, string | number | boolean>;
    status: string;
    canDecide: boolean;
    approverLabel: string | null;
  } | null;
}

async function viewOf(
  db: Database,
  page: PageRow,
  link: LinkRow,
  at: Date,
  sessionUserId: string | null,
): Promise<SurfacePageView> {
  let approval: SurfacePageView["approval"] = null;
  if (page.kind === "confirm") {
    // Lost access to it (left the conversation, the workspace's rules changed) ends the page.
    const a = await getApproval(db, page.userId, page.orgId, page.targetId).catch((error: unknown) => {
      if (error instanceof NotFoundError || error instanceof ForbiddenError) throw gone();
      throw error;
    });
    approval = {
      id: a.id,
      tool: a.tool,
      params: a.params,
      title: a.title,
      detail: a.detail,
      why: a.why,
      kind: a.kind,
      titleParams: a.titleParams,
      status: a.status,
      canDecide: a.canDecide,
      approverLabel: a.approvers?.label ?? null,
    };
  }
  const opened = page.openedAt ?? at;
  const lockedUntil = link.pinLockedUntil && link.pinLockedUntil > at ? link.pinLockedUntil.toISOString() : null;
  const [user] = await db.select({ verified: users.emailVerified }).from(users).where(eq(users.id, page.userId));
  return {
    kind: page.kind,
    expiresAt: new Date(opened.getTime() + PAGE_OPEN_MS[page.kind]).toISOString(),
    surface: surfaceOn()?.name ?? "",
    orgId: page.orgId,
    pin: {
      set: link.pinHash !== null,
      lockedUntil,
      canChoose: link.pinHash === null && sessionUserId === page.userId,
      emailVerified: user?.verified === true,
    },
    approval,
  };
}

/**
 * The page's first load, or a reload in the browser that opened it. `secret` comes back once, on the first.
 * `sessionUserId`: who this browser is signed in as in the app, if anyone.
 */
export async function openSurfacePage(
  deps: { db: Database; now?: () => Date },
  token: string,
  secret: string | null,
  sessionUserId: string | null = null,
): Promise<{ view: SurfacePageView; secret: string | null }> {
  const at = deps.now?.() ?? new Date();
  const live = await livePage(deps.db, token, secret, at, true);
  return { view: await viewOf(deps.db, live.page, live.link, at, sessionUserId), secret: live.secret };
}

/**
 * Sets the person's PIN from a context that proves it is them: their signed-in session, or the link emailed to their
 * verified address. Never from a page link alone, which anyone holding the chat, or a forwarded message, can open.
 * Clears the tries and locks. `onlyUnset`: keep a PIN chosen meanwhile elsewhere (false when it is set).
 */
export async function setSurfacePin(
  db: Executor,
  where: { linkId: string; userId: string },
  pin: string,
  onlyUnset = false,
): Promise<boolean> {
  if (!PIN_SHAPE.test(pin)) throw new ValidationError("The PIN has six digits", "surface.pin_shape");
  const hash = await Bun.password.hash(pin);
  const [set] = await db
    .update(surfaceLinks)
    .set({ pinHash: hash, pinFailures: 0, pinLockedUntil: null, pinLockouts: 0 })
    .where(
      and(
        eq(surfaceLinks.id, where.linkId),
        eq(surfaceLinks.userId, where.userId),
        eq(surfaceLinks.status, "active"),
        onlyUnset ? isNull(surfaceLinks.pinHash) : undefined,
      ),
    )
    .returning({ id: surfaceLinks.id });
  return set !== undefined;
}

/** The signed-in person sets their PIN in the app (ADR 0226 §3), replacing any. */
export async function setMySurfacePin(db: Database, userId: string, linkId: string, pin: string): Promise<void> {
  if (!(await setSurfacePin(db, { linkId, userId }, pin))) {
    throw new NotFoundError("This link is gone", "surface.link_gone");
  }
}

/**
 * Checks the person's PIN. With none set it refuses (`surface.pin_unset`): only `setSurfacePin` chooses one.
 * `PIN_TRIES` wrong ones in a row lock it, longer each time (`PIN_LOCKS_MS`), and email the person.
 */
export async function checkPin(db: Executor, link: LinkRow, pin: string, at: Date): Promise<void> {
  if (link.pinLockedUntil && link.pinLockedUntil > at) throw locked(link.pinLockedUntil);
  if (!PIN_SHAPE.test(pin)) throw new ValidationError("The PIN has six digits", "surface.pin_shape");
  if (!link.pinHash) throw unset();
  // The try is taken before the slow check, so tries sent at once can't run past the lock.
  const [tried] = await db
    .update(surfaceLinks)
    .set({ pinFailures: sql`${surfaceLinks.pinFailures} + 1` })
    .where(
      and(
        eq(surfaceLinks.id, link.id),
        lt(surfaceLinks.pinFailures, PIN_TRIES),
        or(isNull(surfaceLinks.pinLockedUntil), lte(surfaceLinks.pinLockedUntil, at)),
      ),
    )
    .returning();
  if (!tried) {
    const [now] = await db.select().from(surfaceLinks).where(eq(surfaceLinks.id, link.id));
    // Locked a moment ago by a try sent at the same time.
    throw locked(
      now?.pinLockedUntil && now.pinLockedUntil > at ? now.pinLockedUntil : new Date(at.getTime() + PIN_LOCKS_MS[0]),
    );
  }
  if (!tried.pinHash) throw unset();
  if (await Bun.password.verify(pin, tried.pinHash)) {
    await db.update(surfaceLinks).set({ pinFailures: 0, pinLockouts: 0 }).where(eq(surfaceLinks.id, link.id));
    return;
  }
  const failures = tried.pinFailures;
  if (failures >= PIN_TRIES) {
    const lastEnded = tried.pinLockedUntil?.getTime() ?? 0;
    const before = at.getTime() - lastEnded > PIN_LOCKS_FORGOTTEN_MS ? 0 : tried.pinLockouts;
    const step = Math.min(before, PIN_LOCKS_MS.length - 1) as 0 | 1 | 2;
    const until = new Date(at.getTime() + PIN_LOCKS_MS[step]);
    await db
      .update(surfaceLinks)
      .set({ pinFailures: 0, pinLockedUntil: until, pinLockouts: before + 1 })
      .where(eq(surfaceLinks.id, link.id));
    await emailPinLocked(db, tried, step, until);
    throw locked(until);
  }
  throw new ForbiddenError("Wrong PIN", "surface.pin_wrong", { left: PIN_TRIES - failures });
}

/**
 * Tells the person their PIN locked, for how long, and the way out if it wasn't them: unlinking in the app. Only to a
 * verified address: an account can take anyone's address unconfirmed, and its owner can lock its own PIN at will.
 */
async function emailPinLocked(db: Executor, link: LinkRow, step: 0 | 1 | 2, until: Date): Promise<void> {
  const surface = surfaceOn();
  const [user] = await db
    .select({ email: users.email, locale: users.locale, verified: users.emailVerified })
    .from(users)
    .where(eq(users.id, link.userId));
  if (!surface || !user?.verified) return;
  const orgId = link.orgId;
  await queueEmail(db, {
    orgId: null,
    key: `surface-pin-locked:${link.id}:${until.getTime()}`,
    to: [user.email],
    template: {
      ...(orgId ? { assistant: await emailAssistant(db, orgId) } : {}),
      kind: "surface_pin_locked",
      locale: emailLocale(user.locale),
      surface: surface.name,
      step,
      url: orgId ? appPageLink(orgId, "/settings/notifications") : publicPageLink("/"),
    },
  });
}

/**
 * The person decides the page's approval: approving takes their PIN, refusing doesn't. With none set, approving
 * chooses it only when this browser is signed in as the person (`sessionUserId`); otherwise `surface.pin_unset`, and
 * the approval waits in the app. Who may decide is `decideApproval`'s answer, as in the app.
 */
export async function decideOnSurfacePage(
  deps: PageDeps,
  token: string,
  secret: string | null,
  input: { decision: "approve" | "refuse"; pin?: string },
  sessionUserId: string | null = null,
): Promise<SurfacePageView> {
  const at = deps.now?.() ?? new Date();
  const { page, link } = await livePage(deps.db, token, secret, at, false);
  if (page.kind !== "confirm") throw gone();
  if (input.decision === "approve") {
    const pin = input.pin ?? "";
    const chose =
      !link.pinHash &&
      sessionUserId === page.userId &&
      (await setSurfacePin(deps.db, { linkId: link.id, userId: page.userId }, pin, true));
    if (!chose) {
      // Chosen meanwhile elsewhere: this try is checked against it.
      const [now] = link.pinHash
        ? [link]
        : await deps.db.select().from(surfaceLinks).where(eq(surfaceLinks.id, link.id));
      await checkPin(deps.db, now ?? link, pin, at);
    }
  }
  await decideApproval(deps, page.userId, page.orgId, page.targetId, { decision: input.decision });
  const [after] = await deps.db.select().from(surfaceLinks).where(eq(surfaceLinks.id, link.id));
  return viewOf(deps.db, page, after ?? link, at, sessionUserId);
}

/**
 * "Email me a link" (no PIN yet) or "Forgot your PIN?": an email to the account's verified address with a link to a
 * page that chooses the PIN, once, within an hour.
 */
export async function emailPinLink(
  deps: { db: Database; now?: () => Date; publicUrl: string },
  token: string,
  secret: string | null,
): Promise<void> {
  const at = deps.now?.() ?? new Date();
  const { link } = await livePage(deps.db, token, secret, at, false);
  const surface = surfaceOn();
  if (!surface) throw gone();
  const reset = randomToken(32);
  await deps.db.transaction(async (tx) => {
    const [user] = await tx
      .select({ email: users.email, locale: users.locale, verified: users.emailVerified })
      .from(users)
      .where(eq(users.id, link.userId));
    if (!user) throw gone();
    // The address it goes to: a link sent before the account's address changed no longer chooses the PIN.
    const value = JSON.stringify({ userId: link.userId, linkId: link.id, email: user.email });
    const [sent] = await tx
      .select({ n: count() })
      .from(verifications)
      .where(
        and(
          like(verifications.identifier, "surface-pin:%"),
          eq(verifications.value, value),
          gt(verifications.createdAt, new Date(at.getTime() - PIN_RESET_MS)),
        ),
      );
    if ((sent?.n ?? 0) >= PIN_EMAILS_PER_HOUR) throw new TooManyError("Too many reset emails. Try again later.");
    if (!user.verified) {
      throw new ForbiddenError(
        "Your email address isn't verified. Set your PIN in the app.",
        "surface.email_unverified",
      );
    }
    await tx.insert(verifications).values({
      id: randomUUID(),
      identifier: pinResetId(reset),
      value,
      expiresAt: new Date(at.getTime() + PIN_RESET_MS),
      createdAt: at,
      updatedAt: at,
    });
    await queueEmail(tx, {
      orgId: null,
      key: `surface-pin:${sha256(reset)}`,
      to: [user.email],
      template: {
        assistant: await emailAssistant(tx, link.orgId),
        kind: "surface_pin_reset",
        locale: emailLocale(user.locale),
        surface: surface.name,
        url: `${deps.publicUrl.replace(/\/$/, "")}/email-undo?kind=surface-pin&token=${reset}`,
      },
    });
  });
}

/**
 * The emailed link's page: once, within an hour, `pin` becomes the PIN (replacing any, and clearing its lock). The
 * PIN's shape is checked before the link is spent.
 */
export async function setPinFromEmail(db: Database, token: string, pin: string): Promise<{ surface: string }> {
  if (!PIN_SHAPE.test(pin)) throw new ValidationError("The PIN has six digits", "surface.pin_shape");
  const [row] = await db
    .delete(verifications)
    .where(eq(verifications.identifier, pinResetId(token)))
    .returning();
  let value: { userId?: unknown; linkId?: unknown; email?: unknown } = {};
  try {
    value = row && row.expiresAt > new Date() ? (JSON.parse(row.value) as typeof value) : {};
  } catch {}
  const [user] =
    typeof value.userId === "string"
      ? await db
          .select({ email: users.email, verified: users.emailVerified })
          .from(users)
          .where(eq(users.id, value.userId))
      : [];
  if (
    typeof value.userId !== "string" ||
    typeof value.linkId !== "string" ||
    !user?.verified ||
    user.email !== value.email
  ) {
    throw new NotFoundError("This link expired or was already used", "surface.pin_reset_gone");
  }
  if (!(await setSurfacePin(db, { linkId: value.linkId, userId: value.userId }, pin))) {
    throw new NotFoundError("This link expired or was already used", "surface.pin_reset_gone");
  }
  return { surface: surfaceOn()?.name ?? "" };
}

/** Page links a day old: none of them opens anymore. */
export async function prunePageLinks(db: Executor): Promise<number> {
  const gone = await db
    .delete(surfacePageLinks)
    .where(lt(surfacePageLinks.createdAt, new Date(Date.now() - PAGE_KEEP_MS)))
    .returning({ id: surfacePageLinks.id });
  return gone.length;
}
