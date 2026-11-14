import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, isNull, schema } from "@agenteschat/db";
import { serverText } from "@agenteschat/i18n";
import type { AppLocale } from "@agenteschat/i18n/locale";
import type { Agent } from "./agents";
import { canTalkTo, speakerFor } from "./audience";
import { openPersonAgentDm } from "./dms";
import { NotFoundError } from "./errors";
import { publishMessageCreated } from "./events";
import { getMessage, insertMessage, messageView } from "./messages";
import { enqueue } from "./outbox";
import { personLocale } from "./requester";
import { isRightHand } from "./right-hand";
import { closedRefusal, orgStanding } from "./standing";

/**
 * What the right hand does without being asked rests on these: who it may write to, one message in a person's DM
 * with it, a thing said only once, a card rewritten in place and the workspace's two switches. Each feature built on
 * them is a lane (`right-hand-lane.ts`). No model is called from here.
 */

const { agents, messages, organizationSettings, outbox } = schema;

/**
 * The workspace's right hand, or null when it may not act: the workspace is closed to changes, it is archived, or
 * (with `userId`) it may not talk to that person.
 */
export async function lodiFor(db: Database, orgId: string, userId?: string): Promise<Agent | null> {
  if (closedRefusal(await orgStanding(db, orgId))) return null;
  const [lodi] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.builtin, "right_hand"), isNull(agents.archivedAt)));
  if (!lodi || !isRightHand(lodi)) return null;
  if (userId && !canTalkTo(lodi, userId, await speakerFor(db, orgId, userId))) return null;
  return lodi;
}

export interface LodiPost {
  /** How the apps word the message (`chat.body.<bodyCode>` with `bodyParams`), each reader in their language. */
  bodyCode: string;
  bodyParams?: Record<string, unknown>;
  /**
   * The stored text, for pushes and builds that do not know the code. Absent: `chat.body.<bodyCode>` in the person's
   * language.
   */
  body?: (locale: AppLocale) => string;
  /** The rest of `meta` (`actionCard`, `replyChips`). */
  meta?: Record<string, unknown>;
  /** Whether it rings: the inbox row and the push of a new message. False posts quietly. */
  push: boolean;
  /** True when it was already said: asked once more inside the transaction, so two workers post one message. */
  posted?: (tx: Executor, lodiId: string) => Promise<boolean>;
  /** What `lodiFor` just answered the caller for this person, so it is not asked twice. */
  lodi?: Agent;
}

/**
 * One message from the right hand in this person's DM with it. Returns its id, or null when nothing was posted:
 * `lodiFor` says no, or `posted` says it was.
 */
export async function postFromLodi(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  userId: string,
  post: LodiPost,
): Promise<string | null> {
  const { db } = deps;
  const lodi = post.lodi ?? (await lodiFor(db, orgId, userId));
  if (!lodi) return null;
  const locale = await personLocale(db, userId);
  const vars = Object.fromEntries(Object.entries(post.bodyParams ?? {}).map(([k, v]) => [k, String(v)]));
  const body = post.body?.(locale) ?? serverText(locale, `chat.body.${post.bodyCode}`, vars);
  const message = await db.transaction(async (tx) => {
    const dm = await openPersonAgentDm(tx, orgId, userId, lodi.id);
    if (await post.posted?.(tx, lodi.id)) return null;
    const m = await insertMessage(tx, {
      orgId,
      channelId: dm.id,
      author: { type: "agent", agentId: lodi.id, runId: null, hop: 1, stretchId: null },
      body,
      meta: {
        ...post.meta,
        bodyCode: post.bodyCode,
        ...(post.bodyParams ? { bodyParams: post.bodyParams } : {}),
        // Nobody asked for it, so no run says whose it is: the inbox reads it here (`notifyMessage`).
        ...(post.push ? { forUserId: userId } : {}),
      },
    });
    if (post.push)
      await enqueue(tx, {
        orgId,
        kind: "notifications.message",
        payload: { messageId: m.id },
        dedupeKey: `notifications.message:${m.id}`,
        maxAttempts: 4,
      });
    return m;
  });
  if (message && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
  return message?.id ?? null;
}

/**
 * How `saidOnce` stores a key. Dedupe keys are one list for every workspace and every job, so it carries the
 * workspace and a prefix no job uses.
 */
export const saidKey = (orgId: string, key: string) => `right_hand.said:${orgId}:${key}`;

/**
 * True the first time `key` is said in this workspace, false for ever after: a finished outbox row that is never
 * claimed, whose dedupe key is the memory. Its payload is cleared with old jobs, the key stays.
 */
export async function saidOnce(db: Executor, orgId: string, key: string): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .insert(outbox)
    .values({
      orgId,
      kind: "right_hand.said",
      payload: {},
      status: "done",
      nextAttemptAt: now,
      completedAt: now,
      dedupeKey: saidKey(orgId, key),
    })
    .onConflictDoNothing()
    .returning({ id: outbox.id });
  return rows.length > 0;
}

/** Rewrites a message's card (`meta.actionCard`) where it stands and tells who has the conversation open. */
export async function setCardOnMessage(
  deps: { db: Executor; pubsub?: PubSub },
  orgId: string,
  messageId: string,
  card: object,
): Promise<void> {
  const message = await getMessage(deps.db, orgId, messageId);
  if (!message) throw new NotFoundError("Card not found");
  const [updated] = await deps.db
    .update(messages)
    .set({ meta: { ...message.meta, actionCard: card } })
    .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)))
    .returning();
  if (updated && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(updated));
}

/** The workspace's two switches. A workspace that never saved a setting has no row, and both on. */
export async function lodiSwitches(
  db: Executor,
  orgId: string,
): Promise<{ teamWatch: boolean; welcomePeople: boolean }> {
  const [s] = await db
    .select({ teamWatch: organizationSettings.teamWatch, welcomePeople: organizationSettings.welcomePeople })
    .from(organizationSettings)
    .where(eq(organizationSettings.orgId, orgId));
  return { teamWatch: s?.teamWatch ?? true, welcomePeople: s?.welcomePeople ?? true };
}
