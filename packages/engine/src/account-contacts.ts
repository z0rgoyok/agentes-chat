import type { EmailSender } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, isNotNull, schema } from "@agenteschat/db";
import { rethrowEmailError } from "./email";
import { enqueue } from "./outbox";
import { isAgentesCloud } from "./telemetry";

const { organizationMembers, organizations, users } = schema;

/**
 * A workspace that pays for its plan: agentes.chat's billing service names a payer only while the subscription is
 * active, trialing or past due (control's `decideBilling`), and clears it otherwise.
 */
const PAYING = isNotNull(organizations.payerUserId);

export const ACCOUNT_CONTACT_JOB = "account.contact";

let enabled = false;

/**
 * On only on agentes.chat Cloud with a provider that keeps contacts: a self-hosted server never sends anything about
 * its accounts, and queues no job.
 */
export function enableAccountContacts(publicUrl: string, email: Pick<EmailSender, "saveContact">) {
  enabled = isAgentesCloud(publicUrl) && Boolean(email.saveContact);
}

/**
 * Job `account.contact`: the account's address goes to the email provider's contacts as it is when the job runs.
 * Called where an account is created, changes language, is blocked or let back, is being deleted or restored, joins
 * or leaves a workspace, or goes for good (before its row is deleted: the job keeps its address). No key: each change
 * syncs once more. `left`: the address it just left, which loses what an account's contact holds.
 */
export async function enqueueAccountContact(db: Executor, userId: string, left?: string) {
  if (!enabled) return;
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  if (!row) return;
  await enqueue(db, { orgId: null, kind: ACCOUNT_CONTACT_JOB, payload: { userId, email: left ?? row.email } });
}

/**
 * Queues `account.contact` for every member of the workspace: its plan started or stopped paying, or it is about to go
 * for good (before its membership rows are deleted).
 */
export async function enqueueMemberContacts(db: Executor, orgId: string) {
  if (!enabled) return;
  const rows = await db
    .select({ userId: users.id, email: users.email })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.orgId, orgId));
  for (const row of rows) await enqueue(db, { orgId: null, kind: ACCOUNT_CONTACT_JOB, payload: row });
}

/**
 * Queues `account.contact` for every account (run at boot: catches up accounts from before contacts were synced).
 * The key is what the contact holds, so a restart with nothing changed is a no-op. Returns how many were queued.
 */
export async function enqueueAccountContacts(db: Database): Promise<number> {
  if (!enabled) return 0;
  const rows = await db.select().from(users);
  const paid = new Set(
    (
      await db
        .selectDistinct({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
        .where(PAYING)
    ).map((m) => m.userId),
  );
  for (const row of rows) {
    const state =
      row.blockedAt || row.deletionDueAt ? "off:none" : `on:${row.locale ?? ""}:${paid.has(row.id) ? "paid" : "none"}`;
    await enqueue(db, {
      orgId: null,
      kind: ACCOUNT_CONTACT_JOB,
      payload: { userId: row.id, email: row.email },
      dedupeKey: `${ACCOUNT_CONTACT_JOB}:${row.id}:${state}`,
    });
  }
  return rows.length;
}

/**
 * Saves the account as a contact in the email provider (MillionSend) with `account_created_at`, `plan` ("paid" while
 * it is a member of a paying workspace, else removed) and, when set, `locale` (left alone when null, so the waiting
 * list's stays). A blocked account, one being deleted or one gone loses `account_created_at` and `plan`, and so does an
 * address the account left (`payload.email`) that no account has now; the contact itself stays, keeping its
 * unsubscribe state. A provider without contacts: nothing.
 */
export async function saveAccountContact(
  db: Database,
  email: EmailSender,
  payload: { userId: string; email: string },
): Promise<void> {
  if (!email.saveContact) return;
  const [row] = await db.select().from(users).where(eq(users.id, payload.userId));
  const gone = { account_created_at: null, plan: null };
  if (row && row.email !== payload.email) {
    const [other] = await db.select({ id: users.id }).from(users).where(eq(users.email, payload.email)).limit(1);
    if (!other) await email.saveContact({ email: payload.email, properties: gone }).catch(rethrowEmailError);
  }
  const paying = row
    ? await db
        .select({ orgId: organizationMembers.orgId })
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
        .where(and(eq(organizationMembers.userId, row.id), PAYING))
        .limit(1)
    : [];
  const contact =
    !row || row.blockedAt || row.deletionDueAt
      ? { email: row?.email ?? payload.email, properties: gone }
      : {
          email: row.email,
          properties: {
            account_created_at: row.createdAt.toISOString(),
            plan: paying.length > 0 ? "paid" : null,
            ...(row.locale ? { locale: row.locale } : {}),
          },
        };
  await email.saveContact(contact).catch(rethrowEmailError);
}
