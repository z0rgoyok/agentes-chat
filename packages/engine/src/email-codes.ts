import { randomInt, randomUUID } from "node:crypto";
import type { RateLimiter } from "@agenteschat/adapters";
import { type Database, type Executor, eq, schema, sql } from "@agenteschat/db";
import { sha256 } from "./crypto";
import { type EmailLocale, type EmailTemplate, emailLocale, queueEmail } from "./email";
import { ConflictError, ForbiddenError, TooManyError, ValidationError } from "./errors";
import type { OutboxJob } from "./outbox";

const { users, verifications } = schema;

/**
 * A code emailed to prove something, with the same rules wherever it's used (ADR 0072, ADR 0088): its digits (mirrored
 * in packages/client/src/lib/join-requests.ts), the wait before another, how long it works, its wrong tries, and per
 * address the codes an hour and a day and the wrong tries a day.
 */
export const CODE_LENGTH = 6;
export const CODE_RESEND_SECONDS = 60;
export const CODE_TTL_MS = 10 * 60_000;
export const CODE_TRIES = 5;
export const CODE_LIMITS = { hour: 5, day: 10, wrongDay: 10 };

/** Whose error codes a refusal carries: asking to join (`join.code_wrong`…) or proving it's you (`reauth.code_wrong`…). */
export type CodeFlow = "join" | "reauth";

export const newCode = () => String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");

/** Milliseconds before another code may go out, after one sent at `sentAt`. */
export const codeWaitMs = (sentAt: Date | null | undefined, now: Date) =>
  sentAt ? Math.max(0, sentAt.getTime() + CODE_RESEND_SECONDS * 1000 - now.getTime()) : 0;

/**
 * A typed code (its `hash`) against the one waiting: `right`, a `miss` that counts against it, or refused before
 * comparing: none waiting, its tries used up, or expired.
 */
export function codeVerdict(
  waiting: { hash: string | null; tries: number; expiresAt: Date } | null | undefined,
  hash: string,
  now: Date,
) {
  if (!waiting?.hash) return "none" as const;
  if (waiting.tries >= CODE_TRIES) return "tries" as const;
  if (waiting.expiresAt <= now) return "expired" as const;
  return waiting.hash === hash ? ("right" as const) : ("miss" as const);
}

export function codeRefusal(flow: CodeFlow, why: "wrong" | "expired" | "tries") {
  const code = `${flow}.code_${why}`;
  if (why === "wrong") return new ValidationError("That code isn't right.", code);
  return why === "expired"
    ? new ConflictError("This code expired. Ask for a new one.", code)
    : new ConflictError("Too many tries for this code. Ask for a new one.", code);
}

export const codeWait = (flow: CodeFlow, ms: number) =>
  new TooManyError("A code was just sent. Ask for a new one in a minute.", `${flow}.code_wait`, {
    retryIn: Math.ceil(ms / 1000),
  });

export const codeLimit = (flow: CodeFlow) =>
  new TooManyError("Too many codes for this email. Try again later.", `${flow}.code_limit`);

/** The emails that hold a code, by template kind, with the start of their outbox key (`queueEmail`'s `key`). */
export const CODE_EMAILS: Readonly<Record<string, string>> = {
  join_code: "join-code",
  deletion_code: "deletion-code",
  email_change_code: "email-code",
};

/** A code's email holds the code and the address: its job's row goes once it can't be sent again. */
export async function forgetCodeEmail(db: Executor, job: OutboxJob) {
  const kind = (job.payload.template as { kind?: unknown } | undefined)?.kind;
  if (typeof kind !== "string" || !Object.hasOwn(CODE_EMAILS, kind)) return;
  await db.delete(schema.outbox).where(eq(schema.outbox.id, job.id));
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * What a code emailed to a person's own address proves (ADR 0088 §2): deleting a workspace (`workspace:<id>`) or the
 * account, or a new address for it. One waits per person and purpose, in Better Auth's `verifications`, so a code proves
 * only its own purpose.
 */
export type ProofPurpose = `workspace:${string}` | "account" | "email";

/** Every purpose's rows start with `deletion-code:`, the first purpose's (`pruneDeletionCodes` clears them all). */
const proofCodeId = (userId: string, purpose: ProofPurpose) => `deletion-code:${userId}:${purpose}`;
/** `bound`: what else the code is for (the new address), so the same digits typed for anything else are wrong. */
const proofCodeHash = (id: string, code: string, bound: string) =>
  sha256(bound ? `${id}:${bound}:${code}` : `${id}:${code}`);
/** A person's codes are sent and checked one at a time, whatever they prove: their wrong tries are counted together. */
const lockProofCodes = (tx: Executor, userId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`deletion-code:${userId}`}))`);
/** The account's wrong tries in its day (`CODE_LIMITS.wrongDay`): one `verifications` row, the count till the day ends. */
const wrongTriesId = (userId: string) => `deletion-code:${userId}:wrong`;
async function wrongTries(tx: Executor, userId: string, now: Date) {
  const [row] = await tx
    .select()
    .from(verifications)
    .where(eq(verifications.identifier, wrongTriesId(userId)));
  return row && row.expiresAt > now
    ? { count: Number(row.value), until: row.expiresAt }
    : { count: 0, until: new Date(now.getTime() + DAY_MS) };
}
const triesSpent = async (tx: Executor, userId: string, now: Date) =>
  (await wrongTries(tx, userId, now)).count >= CODE_LIMITS.wrongDay;
async function countWrongTry(tx: Executor, userId: string, now: Date) {
  const id = wrongTriesId(userId);
  const { count, until } = await wrongTries(tx, userId, now);
  await tx.delete(verifications).where(eq(verifications.identifier, id));
  await tx.insert(verifications).values({
    id: randomUUID(),
    identifier: id,
    value: String(count + 1),
    expiresAt: until,
    createdAt: now,
    updatedAt: now,
  });
}
/** A code waiting, in its row's `value`: its hash and wrong tries, never the code. */
type WaitingCode = { hash: string; tries: number };
const waitingCode = (value: string): WaitingCode | null => {
  try {
    const v = JSON.parse(value) as Partial<WaitingCode>;
    return typeof v.hash === "string" && typeof v.tries === "number" ? { hash: v.hash, tries: v.tries } : null;
  } catch {
    return null;
  }
};

/**
 * Emails `userId`'s own address a code for `purpose` (ADR 0088 §2), the email `mail.template` makes in their language,
 * with the rules of every emailed code: it works for 10 minutes, a new one replaces it after 60 s at the soonest, and
 * an account gets `CODE_LIMITS` an hour and a day across every purpose, and none once its wrong tries for the day are
 * spent, since no code would be taken then. `mail.bound`: what else it is for (`spendProofCode` takes the same). Only
 * where the server sends email: the routes check it.
 */
export async function sendProofCode(
  deps: { db: Database; rateLimiter: RateLimiter },
  userId: string,
  purpose: ProofPurpose,
  mail: {
    bound?: string;
    template: (code: string, account: { email: string; locale: EmailLocale }) => EmailTemplate;
  },
  now = new Date(),
) {
  const { db } = deps;
  const [account] = await db
    .select({ email: users.email, locale: users.locale, blockedAt: users.blockedAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!account || account.blockedAt) throw new ForbiddenError();
  const id = proofCodeId(userId, purpose);
  return db.transaction(async (tx) => {
    await lockProofCodes(tx, userId);
    if (await triesSpent(tx, userId, now)) throw codeLimit("reauth");
    const [row] = await tx
      .select({ sentAt: verifications.createdAt })
      .from(verifications)
      .where(eq(verifications.identifier, id));
    const wait = codeWaitMs(row?.sentAt, now);
    if (wait > 0) throw codeWait("reauth", wait);
    // ponytail: counted in the rate limiter (in memory on a self-hosted server), so a restart resets them; count them
    // in the database, as asking to join does, if that ever matters.
    const caps = [
      ["hour", CODE_LIMITS.hour, HOUR_MS],
      ["day", CODE_LIMITS.day, DAY_MS],
    ] as const;
    for (const [span, limit, windowMs] of caps) {
      const spent = await deps.rateLimiter.consume(`deletion-code:${span}:${userId}`, { limit, windowMs });
      if (!spent.allowed) throw codeLimit("reauth");
    }
    const code = newCode();
    await tx.delete(verifications).where(eq(verifications.identifier, id));
    await tx.insert(verifications).values({
      id: randomUUID(),
      identifier: id,
      value: JSON.stringify({ hash: proofCodeHash(id, code, mail.bound ?? ""), tries: 0 } satisfies WaitingCode),
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      createdAt: now,
      updatedAt: now,
    });
    const template = mail.template(code, { email: account.email, locale: emailLocale(account.locale) });
    await queueEmail(tx, {
      orgId: null,
      key: `${CODE_EMAILS[template.kind] ?? "deletion-code"}:${sha256(id)}:${now.getTime()}`,
      to: [account.email],
      template,
      maxAttempts: 3,
      runAt: now,
    });
    return { email: account.email, resendIn: CODE_RESEND_SECONDS };
  });
}

/**
 * Spends `userId`'s code for `purpose` (and `bound`, as it was sent): right, it is used up, so it proves one thing once.
 * A wrong one counts against it (`CODE_TRIES`) and against the account's day (`CODE_LIMITS.wrongDay`): once that is
 * spent, every code is refused unread until the day ends, so a guess past it learns nothing. A code sent for anything
 * else, or to anyone else, is wrong here. Throws `reauth.code_wrong`, `reauth.code_expired`, `reauth.code_tries` or,
 * for the day's, `reauth.code_limit`.
 */
export async function spendProofCode(
  deps: { db: Database },
  userId: string,
  purpose: ProofPurpose,
  code: string,
  bound = "",
  now = new Date(),
) {
  const id = proofCodeId(userId, purpose);
  const refused = await deps.db.transaction(async (tx) => {
    await lockProofCodes(tx, userId);
    if (await triesSpent(tx, userId, now)) return "limit";
    const [row] = await tx.select().from(verifications).where(eq(verifications.identifier, id));
    const waiting = row ? waitingCode(row.value) : null;
    const verdict = codeVerdict(
      waiting && row ? { ...waiting, expiresAt: row.expiresAt } : null,
      proofCodeHash(id, code, bound),
      now,
    );
    if (verdict === "right") {
      await tx.delete(verifications).where(eq(verifications.identifier, id));
      return null;
    }
    if (verdict === "none" || !waiting) return "wrong";
    if (verdict !== "miss") return verdict;
    const tries = waiting.tries + 1;
    await tx
      .update(verifications)
      .set({ value: JSON.stringify({ ...waiting, tries } satisfies WaitingCode), updatedAt: now })
      .where(eq(verifications.identifier, id));
    await countWrongTry(tx, userId, now);
    return tries >= CODE_TRIES ? "tries" : "wrong";
  });
  if (refused === "limit") throw codeLimit("reauth");
  if (refused) throw codeRefusal("reauth", refused);
}
