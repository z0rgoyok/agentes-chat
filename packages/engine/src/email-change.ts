import { randomBytes, randomUUID } from "node:crypto";
import { and, type Database, type Executor, eq, gt, gte, inArray, like, lte, ne, or, schema } from "@agenteschat/db";
import { revokeUserApps } from "./apps/revoke";
import { sha256 } from "./crypto";
import { emailLocale, queueEmail } from "./email";
import { ConflictError, NotFoundError } from "./errors";
import { dropPasswordLinks } from "./password-link";

const { users, sessions, verifications, accounts, pushDevices } = schema;

/**
 * A new address for an account (ADR 0088 §2, addendum 2026-11-13). Better Auth's link to the new address makes the
 * change; these rows, in its `verifications`, remember the address it leaves and keep it safe for a week:
 * - `email-change:<userId>` `{ from, to, proven }`: the change the account asked last, until its link makes it. That
 *   link is a token signed for an hour that names both addresses and keeps no state, so only this row lets it work,
 *   once (`changeAsked`). `proven`: the account had confirmed `from`, or its code was just typed.
 * - `email-held:<sha256(address)>` `{ userId }`: a proven address the account is leaving or just left. While no account
 *   has it, nobody signs up with it and no other account takes it, so "This wasn't me" can always put it back.
 * - `email-undo:<sha256(token)>` `{ userId, from, to, since }`: "This wasn't me", emailed to the address the account
 *   left; `since` is when the change was asked.
 * - `email-undone:<userId>`: "This wasn't me" just ran, for the sign-ins already under way then (`undoneSince`).
 */
export const EMAIL_UNDO_DAYS = 7;
/** A change asked outlives its link (an hour, `emailVerification.expiresIn` in apps/server auth.ts). */
const ASKED_MS = 2 * 3_600_000;
const DAY_MS = 86_400_000;
/** As long as a provider's sign-in may take, from its start to its return (Better Auth's state lasts 10 minutes). */
const UNDONE_MS = 10 * 60_000;

const lower = (email: string) => email.trim().toLowerCase();
const askedId = (userId: string) => `email-change:${userId}`;
const heldId = (address: string) => `email-held:${sha256(lower(address))}`;
const undoId = (token: string) => `email-undo:${sha256(token)}`;
const undoneId = (userId: string) => `email-undone:${userId}`;

interface Undo {
  userId: string;
  from: string;
  to: string;
  since: string;
}

function parsed<T extends object>(value: string, keys: (keyof T)[]): T | null {
  try {
    const v = JSON.parse(value) as Record<string, unknown>;
    return keys.every((k) => typeof v[k as string] === "string") ? (v as T) : null;
  } catch {
    return null;
  }
}

async function putRow(tx: Executor, identifier: string, value: object, expiresAt: Date, now: Date) {
  await tx.delete(verifications).where(eq(verifications.identifier, identifier));
  await tx.insert(verifications).values({
    id: randomUUID(),
    identifier,
    value: JSON.stringify(value),
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
}

/** Holds `address` for `userId` until `until`, or longer when it already is. */
async function hold(tx: Executor, address: string, userId: string, until: Date, now: Date) {
  const [row] = await tx
    .select()
    .from(verifications)
    .where(eq(verifications.identifier, heldId(address)));
  if (row && row.expiresAt >= until && parsed<{ userId: string }>(row.value, ["userId"])?.userId === userId) return;
  await putRow(tx, heldId(address), { userId }, until, now);
}

/**
 * Whether `email` is held for an account that is leaving it or just left it (no account has it now), and not for
 * `except`: sign-up refuses it, and so does a change to it.
 */
export async function addressHeld(db: Executor, email: string, options: { except?: string; now?: Date } = {}) {
  const [row] = await db
    .select({ value: verifications.value })
    .from(verifications)
    .where(and(eq(verifications.identifier, heldId(email)), gt(verifications.expiresAt, options.now ?? new Date())));
  const holder = row ? parsed<{ userId: string }>(row.value, ["userId"])?.userId : undefined;
  if (!holder || holder === options.except) return false;
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, lower(email)))
    .limit(1);
  return !owner;
}

/**
 * A change from `from` to `to` was asked, before its link goes: only that link may make it (`changeAsked`), a link
 * asked before it no longer does. When `proven` (the account had confirmed `from`, or typed the code sent there), its
 * notice goes to `from`, which is held meanwhile. An address never proven gets neither: whoever holds that mailbox
 * would get the account through "This wasn't me".
 */
export async function askEmailChange(
  db: Database,
  input: { userId: string; from: string; to: string; proven: boolean },
  now = new Date(),
) {
  const until = new Date(now.getTime() + ASKED_MS);
  await db.transaction(async (tx) => {
    const asked = { from: lower(input.from), to: lower(input.to), proven: input.proven };
    await putRow(tx, askedId(input.userId), asked, until, now);
    if (input.proven) await hold(tx, input.from, input.userId, until, now);
  });
}

/**
 * Whether Better Auth's link from `from` to `to` is the change the account at `from` asked last and hasn't made yet.
 * Checked before the link runs (apps/server auth.ts): without it, the link would work again for its hour after "This
 * wasn't me" put `from` back, or after a newer ask, and move the account telling nobody.
 */
export async function changeAsked(db: Executor, from: string, to: string, now = new Date()) {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, lower(from)))
    .limit(1);
  if (!user) return false;
  const [row] = await db
    .select({ value: verifications.value })
    .from(verifications)
    .where(and(eq(verifications.identifier, askedId(user.id)), gt(verifications.expiresAt, now)));
  const asked = row ? parsed<{ from: string; to: string }>(row.value, ["from", "to"]) : null;
  return asked?.from === lower(from) && asked.to === lower(to);
}

/**
 * The account `user` now has its address, after a change asked here (`askEmailChange`): the address it left, when
 * proven, gets the notice, in the person's language, with "This wasn't me" (`undoEmailChange`) for 7 days, and stays
 * held as long. One never proven, or anything else that updates the account: false.
 */
export async function finishEmailChange(
  deps: { db: Database; publicUrl: string },
  user: { id: string; email: string; locale?: string | null },
  now = new Date(),
) {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(verifications)
      .where(and(eq(verifications.identifier, askedId(user.id)), gt(verifications.expiresAt, now)));
    const asked = row ? parsed<{ from: string; proven?: unknown }>(row.value, ["from"]) : null;
    const from = asked?.from;
    if (!row || !from || from === lower(user.email)) return false;
    await tx.delete(verifications).where(eq(verifications.identifier, askedId(user.id)));
    if (asked?.proven !== true) return false;
    const token = randomBytes(32).toString("base64url");
    const until = new Date(now.getTime() + EMAIL_UNDO_DAYS * DAY_MS);
    const undo: Undo = { userId: user.id, from, to: lower(user.email), since: row.createdAt.toISOString() };
    await putRow(tx, undoId(token), undo, until, now);
    await hold(tx, from, user.id, until, now);
    await queueEmail(tx, {
      orgId: null,
      key: `email-changed:${sha256(token)}`,
      to: [from],
      template: {
        kind: "email_changed",
        locale: emailLocale(user.locale),
        email: from,
        newEmail: lower(user.email),
        url: `${deps.publicUrl.replace(/\/$/, "")}/email-undo?token=${token}`,
      },
    });
    return true;
  });
}

/**
 * "This wasn't me": the account the token was sent for gets the address back (confirmed: its mailbox opened the link),
 * every session ends and every AI app and token it let in is cut off, as a new password does, and so does every way in
 * the other mailbox got since the change was asked, and the password. Once, within 7 days: it also voids the newer ones
 * of that account (a later change's undo would hand the address back to whoever made it), and keeps the older ones.
 * Throws `email.undo_gone` (used, run out, or the account is gone) and `email.undo_taken` (another account has the
 * address: nothing changes, and the link still works).
 */
export async function undoEmailChange(db: Database, token: string, now = new Date()) {
  return db.transaction(async (tx) => {
    // The delete is the single use: a second one at the same moment waits for this one and finds nothing.
    const [row] = await tx
      .delete(verifications)
      .where(eq(verifications.identifier, undoId(token)))
      .returning();
    const undo = row && row.expiresAt > now ? parsed<Undo>(row.value, ["userId", "from", "to", "since"]) : null;
    if (!row || !undo) throw new NotFoundError("This link expired or was already used", "email.undo_gone");
    const [taken] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, undo.from), ne(users.id, undo.userId)))
      .limit(1);
    if (taken) {
      throw new ConflictError("Another account has this address now", "email.undo_taken", { email: undo.from });
    }
    const back = await tx
      .update(users)
      .set({ email: undo.from, emailVerified: true, updatedAt: now })
      .where(eq(users.id, undo.userId))
      .returning({ id: users.id });
    if (back.length === 0) throw new NotFoundError("This link expired or was already used", "email.undo_gone");
    // ponytail: every live undo of the server read to find this account's; a userId in the identifier if they pile up.
    const newer = (await tx.select().from(verifications).where(like(verifications.identifier, "email-undo:%"))).filter(
      (r) => r.createdAt >= row.createdAt && parsed<Undo>(r.value, ["userId", "from", "to"])?.userId === undo.userId,
    );
    const released = [undo.from, ...newer.flatMap((r) => parsed<Undo>(r.value, ["from"])?.from ?? [])];
    await tx.delete(verifications).where(
      or(
        eq(verifications.identifier, askedId(undo.userId)),
        inArray(verifications.identifier, released.map(heldId)),
        ...(newer.length > 0
          ? [
              inArray(
                verifications.id,
                newer.map((r) => r.id),
              ),
            ]
          : []),
      ),
    );
    await tx.delete(sessions).where(eq(sessions.userId, undo.userId));
    // Whoever holds the other mailbox would sign straight back in: through a provider its address joined to the
    // account once confirmed (Better Auth links by a confirmed address), with a password they set, reset or already
    // knew (the likeliest way in, since a fresh sign-in asks a new address without the code), or with a reset link
    // still waiting. The sign-ins made since the change was asked go, and the password is cleared, so "Forgot my
    // password" at this address sets the next one. Phones hear no more pushes until they sign in again.
    await tx
      .delete(accounts)
      .where(and(eq(accounts.userId, undo.userId), gte(accounts.createdAt, new Date(undo.since))));
    await clearPassword(tx, undo.userId, now);
    await dropPasswordLinks(tx, undo.userId);
    await tx.delete(pushDevices).where(eq(pushDevices.userId, undo.userId));
    await revokeUserApps(tx, undo.userId, "email_change_undone");
    // Stamped when written, just before the commit, not with `now`: a sign-in that began while this ran read the
    // account as it was, and `undoneSince` must find the mark no older than that start.
    const markedAt = new Date();
    await putRow(tx, undoneId(undo.userId), {}, new Date(markedAt.getTime() + UNDONE_MS), markedAt);
    return { email: undo.from };
  });
}

/** The account's password goes. Its row stays, so the sign-in page offers "Forgot my password", whose reset fills it. */
export async function clearPassword(db: Executor, userId: string, now = new Date()) {
  await db
    .update(accounts)
    .set({ password: null, updatedAt: now })
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")));
}

/** Clocks differ a little between replicas, and an undo commits a moment after its rows are stamped. */
const CLOCK_SLACK_MS = 1000;

/**
 * Whether "This wasn't me" ran for `userId` since a request that began at `startedAt` (ms). That request read the
 * account as it was before, so the session, sign-in method or password it makes lands after the undo, and the caller
 * takes it back (apps/server auth.ts).
 */
export async function undoneSince(db: Executor, userId: string, startedAt: number) {
  const [row] = await db
    .select({ id: verifications.id })
    .from(verifications)
    .where(
      and(
        eq(verifications.identifier, undoneId(userId)),
        gte(verifications.createdAt, new Date(startedAt - CLOCK_SLACK_MS)),
      ),
    );
  return row !== undefined;
}

/** Changes asked, holds and undos past their end: their rows go (the hourly `deletions` tick). */
export async function pruneEmailChanges(db: Database, now = new Date()) {
  await db
    .delete(verifications)
    .where(
      and(
        or(
          like(verifications.identifier, "email-change:%"),
          like(verifications.identifier, "email-held:%"),
          like(verifications.identifier, "email-undo:%"),
          like(verifications.identifier, "email-undone:%"),
        ),
        lte(verifications.expiresAt, now),
      ),
    );
}
