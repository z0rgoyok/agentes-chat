import { and, asc, type Database, desc, eq, gte, inArray, lt, schema, sql } from "@agenteschat/db";
import { canTalkTo, speakerOf } from "./audience";
import { decodeCursor } from "./cursor";
import { audienceAllows, machineRule, mayUseDevice } from "./devices";
import { getOrMake } from "./format";
import { jobOf, selectJobs } from "./operator-jobs";
import { codeOf, ms, olderThan, orgExists, type PageQuery, pageOf, UuidCursor, wordOf } from "./operator-paging";
import { can, getMembership, type Membership } from "./organizations";
import { MAX_PUSH_DEVICES } from "./push";
import { readRefusal } from "./standing";
import { artifactCol, channelReaderSql, fileSeenSql, taskSeenSql } from "./task-access";

/**
 * One person in a workspace, for the operator API (ADR 0056): what they were notified of, and whether they reach an
 * agent, a conversation, a task, a file or a computer. Ids, kinds, states, codes and times: never a notification's
 * words. Every field is picked by name, and nothing here writes, because a caller holding only the read token
 * reaches all of it.
 */

const { agents, artifacts, channelMembers, channels, issues, machines, notifications, outbox, pushDevices, users } =
  schema;

// ── Notifications ────────────────────────────────────────────────────────────

const PUSH_JOB = "push.send";

/** The ids a notification's source names (`channelId`, `messageId`, `approvalId`…): never its `label`, a title. */
const idsOf = (source: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(source).flatMap(([name, id]) => {
      const word = /^[a-z][A-Za-z]*Id$/.test(name) ? wordOf(id) : null;
      return word ? [[name, word]] : [];
    }),
  );

export interface OperatorNotificationQuery extends PageQuery {
  userId: string;
  kind?: string;
  /** Created at or after. */
  from?: Date;
  /** Created before. */
  to?: Date;
}

/**
 * One person's notifications in a workspace, newest first, in keyset pages: what kind each is, whether it was read,
 * done or snoozed, who caused it, the ids it points at, and the jobs that pushed it to their devices. With the
 * devices they have now. Never its words (`latest`), nor a title its source carries. Null: no such workspace or
 * account.
 */
export async function operatorNotifications(db: Database, orgId: string, query: OperatorNotificationQuery) {
  const after = query.cursor ? decodeCursor(query.cursor, UuidCursor) : null;
  const [person, known] = await Promise.all([
    db.select({ id: users.id }).from(users).where(eq(users.id, query.userId)),
    orgExists(db, orgId),
  ]);
  if (person.length === 0 || !known) return null;
  const at = ms(notifications.createdAt);
  const [rows, devices] = await Promise.all([
    db
      .select({
        id: notifications.id,
        kind: notifications.kind,
        waiting: notifications.waiting,
        group: notifications.groupKey,
        count: notifications.count,
        actors: notifications.actors,
        // Read for the ids it names alone (`idsOf`).
        source: notifications.source,
        readAt: notifications.readAt,
        doneAt: notifications.doneAt,
        doneByUser: notifications.doneByUser,
        snoozedUntil: notifications.snoozedUntil,
        createdAt: at,
        updatedAt: notifications.updatedAt,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.orgId, orgId),
          eq(notifications.userId, query.userId),
          query.kind ? eq(notifications.kind, query.kind) : undefined,
          query.from ? gte(notifications.createdAt, query.from) : undefined,
          query.to ? lt(notifications.createdAt, query.to) : undefined,
          olderThan(at, notifications.id, after),
        ),
      )
      .orderBy(desc(at), desc(notifications.id))
      .limit(query.limit + 1),
    // Never `token` nor `webKeys`: what a push is sent to.
    db
      .select({
        platform: pushDevices.platform,
        createdAt: pushDevices.createdAt,
        lastSeenAt: pushDevices.lastSeenAt,
      })
      .from(pushDevices)
      .where(eq(pushDevices.userId, query.userId))
      .orderBy(desc(pushDevices.lastSeenAt))
      .limit(MAX_PUSH_DEVICES),
  ]);
  const page = pageOf(rows, query.limit, (n) => [n.createdAt, n.id]);
  // ponytail: a notification's first push and the one held back while its person was looking are found by their
  // exact names, which the index on a job's name serves. A reminder's and a snooze's push are named by a time:
  // `GET /jobs?kind=push.send` lists them.
  const names = page.items.flatMap((n) => [`${PUSH_JOB}:${n.id}`, `${PUSH_JOB}:${n.id}:held`]);
  const sent =
    names.length === 0
      ? []
      : await selectJobs(db).where(inArray(outbox.dedupeKey, names)).orderBy(asc(outbox.createdAt), asc(outbox.id));
  const pushes = new Map<string, ReturnType<typeof jobOf>[]>();
  for (const job of sent) getOrMake(pushes, job.dedupe?.split(":")[1] ?? "", () => []).push(jobOf(job));

  return {
    notifications: page.items.map(({ source, actors, ...n }) => ({
      ...n,
      kind: codeOf(n.kind),
      group: codeOf(n.group),
      actors: actors.flatMap((a) => {
        const id = wordOf(a?.id);
        return id && (a.type === "user" || a.type === "agent") ? [{ type: a.type, id }] : [];
      }),
      source: idsOf(source),
      push: pushes.get(n.id) ?? [],
    })),
    devices: devices.map((d) => ({ ...d, platform: codeOf(d.platform) })),
    next: page.next,
  };
}

// ── Access explained ─────────────────────────────────────────────────────────

export const OPERATOR_ACCESS_TARGETS = ["agent", "channel", "task", "file", "computer"] as const;
type AccessTarget = (typeof OPERATOR_ACCESS_TARGETS)[number];

const ALLOWS = [
  "owner",
  "audience_everyone",
  "audience_person",
  "audience_role",
  "workspace",
  "channel_member",
  "public_channel",
  "administrator",
  "task_reader",
  "shared_everyone",
  "shared_person",
  "shared_role",
  "granted_once",
] as const;
const REFUSES = [
  "not_a_member",
  "account_closed",
  "workspace_suspended",
  "gone",
  "no_permission",
  "owner_only",
  "not_in_audience",
  "not_joined",
  "not_channel_member",
  "not_task_reader",
  "not_shared",
  "unknown",
] as const;
/** Why a person reaches something, then why they don't. */
export const OPERATOR_ACCESS_RULES = [...ALLOWS, ...REFUSES] as const;
type Rule = (typeof OPERATOR_ACCESS_RULES)[number];

const ALLOWING: ReadonlySet<string> = new Set(ALLOWS);

/**
 * `allowed` is the app's own check; `rule` retells that check step by step, to name the step that decided. Where the
 * two disagree the retelling is what's wrong: the answer stays the app's and its rule reads `unknown`.
 */
const answered = (allowed: boolean, rule: Rule) => ({
  allowed,
  rule: ALLOWING.has(rule) === allowed ? rule : ("unknown" as const),
});

type Answer = ReturnType<typeof answered>;
type Member = Membership | null;
/** The answer for one kind of thing; null: the workspace has none by this id. */
type Explain = (
  db: Database,
  orgId: string,
  userId: string,
  id: string,
  member: Member,
  now: Date,
) => Promise<Answer | null>;

const memberOf = (channelId: unknown, userId: string) =>
  sql<boolean>`exists (select 1 from ${channelMembers} cm where cm.channel_id = ${channelId} and cm.user_id = ${userId})`;
const publicChannel = (channelId: unknown) =>
  sql<boolean>`exists (select 1 from ${channels} pc where pc.id = ${channelId} and pc.kind = 'channel'
    and pc.visibility = 'public')`;

/** Whether the person's message starts a run of the agent (`canTalkTo`). */
const agentAccess: Explain = async (db, orgId, userId, agentId, member) => {
  const [a] = await db
    .select({
      audienceMode: agents.audienceMode,
      audienceUserIds: agents.audienceUserIds,
      audienceRoleIds: agents.audienceRoleIds,
      ownerUserId: agents.ownerUserId,
      consultable: agents.consultable,
      brain: agents.brain,
      archivedAt: agents.archivedAt,
    })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
  if (!a) return null;
  const speaker = speakerOf(member);
  const rule: Rule = a.archivedAt
    ? "gone"
    : a.ownerUserId === userId
      ? "owner"
      : !speaker.talks
        ? "no_permission"
        : a.audienceMode === "everyone"
          ? "audience_everyone"
          : a.audienceMode === "owner"
            ? "owner_only"
            : a.audienceUserIds.includes(userId)
              ? "audience_person"
              : a.audienceRoleIds.some((id) => speaker.roleIds.includes(id))
                ? "audience_role"
                : "not_in_audience";
  return answered(!a.archivedAt && canTalkTo(a, userId, speaker), rule);
};

/** Whether the person reads the conversation (`requireChannelAccess`). */
const channelAccess: Explain = async (db, orgId, userId, channelId, member) => {
  const id = sql`${channelId}::uuid`;
  const [c] = await db
    .select({
      kind: channels.kind,
      visibility: channels.visibility,
      archivedAt: channels.archivedAt,
      inIt: memberOf(id, userId),
      reads: sql<boolean>`${channelReaderSql(id, sql`${userId}::text`)}`,
    })
    .from(channels)
    .where(and(eq(channels.orgId, orgId), eq(channels.id, channelId)));
  if (!c) return null;
  const rule: Rule = c.archivedAt
    ? "gone"
    : c.kind === "task"
      ? c.reads
        ? "task_reader"
        : "not_task_reader"
      : c.inIt
        ? "channel_member"
        : c.kind === "channel" && can(member, "administrator")
          ? "administrator"
          : c.kind === "channel" && c.visibility === "public"
            ? "not_joined"
            : "not_channel_member";
  return answered(!c.archivedAt && c.reads, rule);
};

/** Whether the person sees the task (`taskSeenSql`). */
const taskAccess: Explain = async (db, orgId, userId, taskId, member) => {
  const where = sql.raw(`"issues"."channel_id"`);
  const [t] = await db
    .select({
      restricted: issues.restricted,
      audienceUserIds: issues.audienceUserIds,
      channelId: issues.channelId,
      inChannel: memberOf(where, userId),
      publicChannel: publicChannel(where),
      sees: sql<boolean>`${taskSeenSql("issues", sql`${userId}::text`)}`,
    })
    .from(issues)
    .where(and(eq(issues.orgId, orgId), eq(issues.id, taskId)));
  if (!t) return null;
  const admin = can(member, "administrator");
  const rule: Rule = t.restricted
    ? t.audienceUserIds.includes(userId)
      ? "audience_person"
      : admin
        ? "administrator"
        : "not_in_audience"
    : !t.channelId
      ? "workspace"
      : admin
        ? "administrator"
        : t.inChannel
          ? "channel_member"
          : t.publicChannel
            ? "public_channel"
            : "not_channel_member";
  return answered(t.sees, rule);
};

/** Whether the person reads the file (`fileSeenSql`). */
const fileAccess: Explain = async (db, orgId, userId, fileId, member) => {
  const where = artifactCol("channel_id");
  const user = sql`${userId}::text`;
  const [f] = await db
    .select({
      channelId: artifacts.channelId,
      share: artifacts.share,
      shareUserIds: artifacts.shareUserIds,
      shareRoleIds: artifacts.shareRoleIds,
      deletedAt: artifacts.deletedAt,
      inChannel: memberOf(where, userId),
      publicChannel: publicChannel(where),
      channelKind: sql<string | null>`(select fc.kind::text from ${channels} fc where fc.id = ${where})`,
      readsChannel: sql<boolean>`${channelReaderSql(where, user)}`,
      sees: sql<boolean>`${fileSeenSql(user)}`,
    })
    .from(artifacts)
    .where(and(eq(artifacts.orgId, orgId), eq(artifacts.id, fileId)));
  if (!f) return null;
  const listed = f.share === "people";
  // An administrator reads every channel's files, never a direct conversation's, and every file shared by a list.
  const admin = can(member, "administrator") && (f.channelKind === "channel" || listed);
  const rule: Rule = f.deletedAt
    ? "gone"
    : !f.channelId
      ? "workspace"
      : f.share === "everyone"
        ? "shared_everyone"
        : listed && f.shareUserIds.includes(userId)
          ? "shared_person"
          : f.inChannel
            ? "channel_member"
            : f.publicChannel
              ? "public_channel"
              : f.channelKind === "task" && f.readsChannel
                ? "task_reader"
                : admin
                  ? "administrator"
                  : listed && f.shareRoleIds.some((id) => member?.roleIds.includes(id))
                    ? "shared_role"
                    : "not_shared";
  return answered(!f.deletedAt && f.sees, rule);
};

/** Whether the person's agents may use the computer (`mayUseDevice`). */
const computerAccess: Explain = async (db, orgId, userId, machineId, member, now) => {
  const [m] = await db
    .select({
      id: machines.id,
      pairedByUserId: machines.pairedByUserId,
      audienceMode: machines.audienceMode,
      audienceUserIds: machines.audienceUserIds,
      audienceRoleIds: machines.audienceRoleIds,
      belongsToWorkspace: machines.belongsToWorkspace,
      deletedAt: machines.deletedAt,
    })
    .from(machines)
    .where(and(eq(machines.orgId, orgId), eq(machines.id, machineId)));
  if (!m) return null;
  const device = machineRule(m);
  const { audience, ownerUserId } = device;
  const roleIds = member?.roleIds ?? [];
  const allowed = !m.deletedAt && (await mayUseDevice(db, orgId, userId, device, { membership: member, now }));
  const rule: Rule = m.deletedAt
    ? "gone"
    : ownerUserId === userId
      ? "owner"
      : audience.mode === "everyone"
        ? "audience_everyone"
        : audience.mode === "owner" && !ownerUserId && m.belongsToWorkspace
          ? "workspace"
          : audience.userIds.includes(userId)
            ? "audience_person"
            : audience.roleIds.some((id) => roleIds.includes(id))
              ? "audience_role"
              : // The rule itself refuses them: only a person's answer to an agent's request lets them in.
                allowed && !audienceAllows(audience, ownerUserId, { userId, roleIds }, m.belongsToWorkspace)
                ? "granted_once"
                : audience.mode === "owner"
                  ? "owner_only"
                  : "not_in_audience";
  return answered(allowed, rule);
};

const EXPLAINS: Record<AccessTarget, Explain> = {
  agent: agentAccess,
  channel: channelAccess,
  task: taskAccess,
  file: fileAccess,
  computer: computerAccess,
};

export interface OperatorAccessQuery {
  userId: string;
  targetKind: AccessTarget;
  targetId: string;
}

/**
 * Whether a person reaches one thing of a workspace as things are now, and the rule that decides it: talking to an
 * agent, reading a conversation or a file, seeing a task, their agents using a computer. Someone outside the
 * workspace, an account blocked or being deleted and a suspended workspace reach nothing, whatever the thing's own
 * rule says. Null: no such account, or no such thing in the workspace.
 */
export async function operatorAccess(db: Database, orgId: string, query: OperatorAccessQuery, now = new Date()) {
  const { userId, targetKind, targetId } = query;
  const [[person], member] = await Promise.all([
    db
      .select({ blockedAt: users.blockedAt, deletionDueAt: users.deletionDueAt })
      .from(users)
      .where(eq(users.id, userId)),
    getMembership(db, userId, orgId, { includeBlocked: true }),
  ]);
  if (!person) return null;
  const found = await EXPLAINS[targetKind](db, orgId, userId, targetId, member, now);
  if (!found) return null;
  const kept: Rule | null = !member
    ? "not_a_member"
    : person.blockedAt || person.deletionDueAt
      ? "account_closed"
      : readRefusal(member.standing)
        ? "workspace_suspended"
        : null;
  return { userId, targetKind, targetId, ...(kept ? answered(false, kept) : found) };
}
