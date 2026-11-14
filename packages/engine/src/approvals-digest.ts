import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, gt, rowsOf, schema, sql } from "@agenteschat/db";
import { activeCoversTo } from "./approval-covers";
import { adminsDecide, decidableBySql, decidingKeys, notifiedIds } from "./approvals";
import { personAgentDmKey } from "./dms";
import { NotFoundError } from "./errors";
import { stringsOf } from "./format";
import { enqueue } from "./outbox";
import { defineLodiLane } from "./right-hand-lane";
import { readLodiPrefs } from "./right-hand-prefs";
import { lodiFor, postFromLodi, saidOnce, setCardOnMessage } from "./right-hand-proactive";
import { localDate } from "./rrule";
import { accountInUse } from "./standing";
import { REQUEST_PERMISSION_TOOL } from "./tools/permission";

/**
 * "Resumir aprovações esperando": when several approvals wait on one person, the right hand posts one card in their DM
 * that tells the routine ones from the risky ones. It decides nothing and calls no model.
 *
 * - `queueApprovalsDigest` is called for whoever is told about a new approval. The job runs on the next 10-minute
 *   mark at least 10 minutes away, one job a person and mark, so every approval is looked at 10 to 20 minutes after it
 *   came and a person who decides at once gets no card.
 * - `postApprovalsDigest` is that job. Silent when the person turned it off, when `lodiFor` says no and under
 *   `DIGEST_FROM` waiting. It counts what the person was told about and may decide, never what an admin could decide
 *   silently. A card of the last 12 hours that still lists one of them is rewritten where it stands, the one the
 *   right hand posted there when asked what waits included: the same approvals are never on two of its cards.
 *   Otherwise one new message without a push, at most `DIGEST_A_DAY` a day. It answers whether such a card now holds
 *   what waits on the person: the reminder of asks left unread (`team-watch.ts`) leaves approvals to it only then,
 *   and calls it to get one. The day's card lists no approval for who it sums up for (`digestWaitingOn`).
 * - The card is `{ kind: "approvals", forUserId, params: { approvalIds, why: "", digest: true } }`: ids only, so each
 *   reader's app shows what that reader may see. What is routine is the server's word (`ApprovalView.routine`), and
 *   the card's group button decides through `decideApprovals` with `only: "routine"`, as the person who taps.
 */

export const APPROVALS_DIGEST_JOB = "approvals_digest.post";

const { approvals, organizationMembers, users } = schema;

/** How many must wait on one person before the right hand sums them up. */
export const DIGEST_FROM = 3;
const WAIT_MS = 10 * 60_000;
/** A card older than this is left alone: rewriting it would change something nobody is looking at any more. */
const FRESH_MS = 12 * 3600_000;
const DIGEST_A_DAY = 2;
/** What one card lists at most: what "Aprovar tudo" takes in one call. */
const MAX_ON_CARD = 50;

/** Queues the digest's job for these people, on the next 10-minute mark at least 10 minutes from `now`. */
export async function queueApprovalsDigest(db: Executor, orgId: string, userIds: string[], now = new Date()) {
  const runAt = new Date(Math.ceil((now.getTime() + WAIT_MS) / WAIT_MS) * WAIT_MS);
  for (const userId of new Set(userIds)) {
    await enqueue(db, {
      orgId,
      kind: APPROVALS_DIGEST_JOB,
      payload: { userId },
      runAt,
      dedupeKey: `${APPROVALS_DIGEST_JOB}:${orgId}:${userId}:${runAt.toISOString()}`,
      maxAttempts: 4,
    });
  }
}

/**
 * An approval this person can't have been told about, left out before it is read: an agent's own request (nobody
 * named, not access for good) whose owner is someone else still in the workspace. That owner alone is told, or who
 * covers them. It keeps an admin's job to their own agents' approvals instead of the whole workspace's.
 */
const toldSomeoneElse = (userId: string) => sql`(${approvals.approvers} is null
  and ${approvals.tool} <> ${REQUEST_PERMISSION_TOOL}
  and ${approvals.ownerUserId} <> ${userId}
  and exists (select 1 from ${organizationMembers} join ${users} on ${users.id} = ${organizationMembers.userId}
    where ${organizationMembers.orgId} = ${approvals.orgId} and ${organizationMembers.userId} = ${approvals.ownerUserId}
      and ${accountInUse}))`;

/** The approvals waiting that this person was told about and may decide, oldest first: what the digest sums up. */
export async function digestWaitingOn(db: Database, orgId: string, userId: string, now: Date): Promise<string[]> {
  // Someone who covers another person is told about that person's too: nothing is left out for them. Read on the
  // clock `notifiedIds` reads its covers on.
  const covers = (await activeCoversTo(db, orgId, userId)).length > 0;
  const rows = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.orgId, orgId),
        eq(approvals.status, "pending"),
        gt(approvals.expiresAt, now),
        decidableBySql(userId),
        covers ? undefined : sql`not ${toldSomeoneElse(userId)}`,
      ),
    )
    .orderBy(asc(approvals.createdAt))
    .limit(200);
  // Who is told depends on these alone, and most of a person's approvals share them.
  const toldOf = new Map<string, Promise<string[]>>();
  const mine: string[] = [];
  for (const row of rows) {
    const key = JSON.stringify([
      decidingKeys(row),
      adminsDecide(row),
      row.ownerUserId,
      row.approvers,
      row.requestedByUserId,
      row.highRisk,
    ]);
    const told = toldOf.get(key) ?? notifiedIds(db, row);
    toldOf.set(key, told);
    if ((await told).includes(userId)) mine.push(row.id);
  }
  return mine.slice(0, MAX_ON_CARD);
}

/**
 * The right hand's latest approvals card for this person in their DM with it since `since`, its own digest or the one
 * it posted there when asked: its message, the approvals it lists and the line it gave.
 */
async function lastCard(db: Executor, orgId: string, lodiId: string, userId: string, since: Date) {
  const [row] = rowsOf<{ id: string; ids: unknown; why: unknown }>(
    await db.execute(sql`select id, meta->'actionCard'->'params'->'approvalIds' as ids,
        meta->'actionCard'->'params'->>'why' as why from messages
      where org_id = ${orgId} and author_agent_id = ${lodiId} and created_at > ${since.toISOString()}::timestamptz
        and channel_id = (select id from channels where org_id = ${orgId}
          and dm_key = ${personAgentDmKey(userId, lodiId)})
        and deleted_at is null and meta->'actionCard'->>'kind' = 'approvals'
        and meta->'actionCard'->>'forUserId' = ${userId}
      order by created_at desc limit 1`),
  );
  return row ? { id: row.id, ids: stringsOf(row.ids), why: typeof row.why === "string" ? row.why : "" } : null;
}

const cardOf = (userId: string, approvalIds: string[], why = "") => ({
  kind: "approvals",
  forUserId: userId,
  params: { approvalIds, why, digest: true },
});

/** The job. True when a card of the last hours holds what waits on the person once it ends. */
export async function postApprovalsDigest(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  payload: Record<string, unknown>,
  now = new Date(),
): Promise<boolean> {
  const { db } = deps;
  const userId = typeof payload.userId === "string" ? payload.userId : "";
  if (!userId) return false;
  // Someone who left since the job was queued has nothing waiting.
  const member = await readLodiPrefs(db, orgId, userId).catch((error) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!member || member.prefs.digestOff) return false;
  const lodi = await lodiFor(db, orgId, userId);
  if (!lodi) return false;
  const waiting = await digestWaitingOn(db, orgId, userId, now);
  if (waiting.length < DIGEST_FROM) return false;

  const fresh = (tx: Executor) => lastCard(tx, orgId, lodi.id, userId, new Date(now.getTime() - FRESH_MS));
  const open = (card: { ids: string[] } | null) => card?.ids.some((id) => waiting.includes(id)) === true;
  const last = await fresh(db);
  if (last && open(last)) {
    // What was decided on it keeps its line: the card grows by what came since. Past what one card holds, the
    // decided leave first, oldest first, never one still waiting (`waiting` is no longer than a card).
    const all = [...last.ids, ...waiting.filter((id) => !last.ids.includes(id))];
    const settled = all.filter((id) => !waiting.includes(id));
    const dropped = new Set(settled.slice(0, Math.max(0, all.length - MAX_ON_CARD)));
    const ids = all.filter((id) => !dropped.has(id));
    if (ids.join() !== last.ids.join()) await setCardOnMessage(deps, orgId, last.id, cardOf(userId, ids, last.why));
    return true;
  }
  const day = localDate(now, member.dayTimezone);
  /** Takes one of the day's places, inside the post's transaction: a post that fails gives it back. */
  const placeLeft = async (tx: Executor) => {
    for (let n = 1; n <= DIGEST_A_DAY; n++)
      if (await saidOnce(tx, orgId, `approvals_digest.day:${userId}:${day}:${n}`)) return true;
    return false;
  };
  const posted = await postFromLodi(deps, orgId, userId, {
    bodyCode: "action_approvals",
    meta: { actionCard: cardOf(userId, waiting) },
    push: false,
    // Another worker posted it meanwhile, or the day's messages are spent. The member's row is locked first, so two
    // workers post one after the other and the second sees the first one's card.
    posted: async (tx) => {
      await readLodiPrefs(tx, orgId, userId, true);
      return open(await fresh(tx)) || !(await placeLeft(tx));
    },
    lodi,
  });
  // Not posted: another worker's card holds them, or the day's places are spent and none does.
  return posted !== null || open(await fresh(db));
}

export const approvalsDigestLane = defineLodiLane({
  switch: "digest",
  live: true,
  jobs: { [APPROVALS_DIGEST_JOB]: postApprovalsDigest },
});
