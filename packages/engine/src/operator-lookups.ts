import {
  and,
  asc,
  count,
  type Database,
  desc,
  eq,
  inArray,
  isNull,
  or,
  rowsOf,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { modelInfo } from "@agenteschat/providers";
import { parseFileLink, parseMessageLink } from "@agenteschat/tokens/message-links";
import { z } from "zod";
import { UUID } from "./authority";
import { decodeCursor } from "./cursor";
import { ValidationError } from "./errors";
import { machineOnline } from "./machines";
import { operatorRole } from "./operator";
import { ms, orgExists, type PageQuery, pageOf, UuidCursor } from "./operator-paging";

/**
 * Lookups of the operator API (ADR 0056): accounts, a workspace's people, channels and agents, and what a pasted
 * reference names. Who and what, never what anyone wrote, and never a credential, token or hash: every field is
 * picked by name. Nothing here writes, because a caller holding only the read token reaches all of it.
 */

const {
  organizations,
  organizationMembers,
  organizationInvitations,
  organizationJoinRequests,
  users,
  sessions,
  agents,
  channels,
  channelMembers,
  messages,
  agentRuns,
  issues,
  artifacts,
  machines,
  machineAccounts,
  providerCredentials,
  agentSkills,
  skills,
  routines,
  contextItems,
} = schema;

const asDate = (v: string | Date) => new Date(v);

/** A page of accounts ends at this key: `[createdAt (ms), id]`. An account's id is not a uuid. */
const UserCursor = z.tuple([z.iso.datetime(), z.string().min(1).max(200)]);

// ── Accounts ─────────────────────────────────────────────────────────────────

/** How many of an account's workspaces a search lists, oldest membership first; `orgCount` says how many it has. */
export const OPERATOR_USER_ORGS = 20;

export interface OperatorUserQuery extends PageQuery {
  /** The whole address; any case. */
  email?: string;
  /** Part of an address or of a name; any case, matched literally. */
  q?: string;
}

// In a select list over one table drizzle writes columns without their table, so in a subquery a bare
// "id" would be the subquery's own: the outer row is named in full.
const USER_ID = sql.raw(`"users"."id"`);

/** Accounts by their address, or by part of an address or of a name: newest first, in keyset pages. */
export async function operatorFindUsers(db: Database, query: OperatorUserQuery) {
  const after = query.cursor ? decodeCursor(query.cursor, UserCursor) : null;
  const email = query.email?.trim().toLowerCase();
  const q = query.q?.trim();
  const createdAt = ms(users.createdAt);
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      emailVerified: users.emailVerified,
      createdAt,
      blockedAt: users.blockedAt,
      blockedReason: users.blockedReason,
      deletionDueAt: users.deletionDueAt,
      lastSignInAt: sql<Date | null>`(select max(${sessions.createdAt}) from ${sessions}
        where ${sessions.userId} = ${USER_ID})`.mapWith(asDate),
    })
    .from(users)
    .where(
      and(
        email ? eq(users.email, email) : undefined,
        q
          ? sql`(strpos(lower(${users.email}), lower(${q}::text)) > 0
              or strpos(lower(${users.name}), lower(${q}::text)) > 0)`
          : undefined,
        after ? sql`(${createdAt}, ${users.id}) < (${after[0]}::timestamptz, ${after[1]}::text)` : undefined,
      ),
    )
    .orderBy(desc(createdAt), desc(users.id))
    .limit(query.limit + 1);
  const page = pageOf(rows, query.limit, (u) => [u.createdAt, u.id]);
  const ids = page.items.map((u) => u.id);
  // One account can be in every workspace of the instance: each one's list is cut in the database.
  const memberships =
    ids.length === 0
      ? []
      : rowsOf<{
          userId: string;
          orgId: string;
          name: string;
          role: "owner" | "admin" | "member";
          total: string | number;
        }>(
          await db.execute(sql`
            select m.user_id as "userId", m.org_id as "orgId", o.name as "name", m.total as "total",
              ${operatorRole(sql`m.org_id`, sql`m.user_id`, sql`m.role`)} as "role"
            from (
              select om.org_id, om.user_id, om.role,
                row_number() over (partition by om.user_id order by om.created_at, om.org_id) as n,
                count(*) over (partition by om.user_id) as total
              from ${organizationMembers} om
              where ${inArray(sql`om.user_id`, ids)}
            ) m
            join ${organizations} o on o.id = m.org_id
            where m.n <= ${OPERATOR_USER_ORGS}
            order by m.user_id, m.n`),
        );
  return {
    users: page.items.map((u) => {
      const own = memberships.filter((m) => m.userId === u.id);
      return {
        ...u,
        orgs: own.map(({ orgId, name, role }) => ({ orgId, name, role })),
        orgCount: Number(own[0]?.total ?? 0),
      };
    }),
    next: page.next,
  };
}

// ── A workspace's people ─────────────────────────────────────────────────────

/** How many invitations and how many join requests the people's read lists, newest first. */
export const OPERATOR_MEMBER_ASKS = 200;

/**
 * A workspace's members in the order they joined, in keyset pages, with its invitations not accepted yet (expired
 * ones too) and its join requests on record, each without its link's or its claim's hash and without anyone's
 * note. Null: no such workspace.
 */
export async function operatorMembers(db: Database, orgId: string, query: PageQuery) {
  const after = query.cursor ? decodeCursor(query.cursor, UserCursor) : null;
  if (!(await orgExists(db, orgId))) return null;
  const joinedAt = ms(organizationMembers.createdAt);
  const [rows, invitations, joinRequests] = await Promise.all([
    db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        handle: organizationMembers.handle,
        role: operatorRole(orgId, organizationMembers.userId),
        joinedAt,
        lastSeenAt: organizationMembers.lastSeenAt,
        blockedAt: users.blockedAt,
        deletionDueAt: users.deletionDueAt,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          after
            ? sql`(${joinedAt}, ${organizationMembers.userId}) > (${after[0]}::timestamptz, ${after[1]}::text)`
            : undefined,
        ),
      )
      .orderBy(asc(joinedAt), asc(organizationMembers.userId))
      .limit(query.limit + 1),
    db
      .select({
        id: organizationInvitations.id,
        email: organizationInvitations.email,
        role: organizationInvitations.role,
        invitedByUserId: organizationInvitations.invitedByUserId,
        createdAt: organizationInvitations.createdAt,
        expiresAt: organizationInvitations.expiresAt,
      })
      .from(organizationInvitations)
      .where(and(eq(organizationInvitations.orgId, orgId), isNull(organizationInvitations.acceptedAt)))
      .orderBy(desc(organizationInvitations.createdAt), desc(organizationInvitations.id))
      .limit(OPERATOR_MEMBER_ASKS),
    db
      .select({
        id: organizationJoinRequests.id,
        email: organizationJoinRequests.email,
        name: organizationJoinRequests.name,
        userId: organizationJoinRequests.userId,
        status: organizationJoinRequests.status,
        verifiedAt: organizationJoinRequests.verifiedAt,
        createdAt: organizationJoinRequests.createdAt,
        expiresAt: organizationJoinRequests.expiresAt,
        decidedAt: organizationJoinRequests.decidedAt,
        decidedByUserId: organizationJoinRequests.decidedByUserId,
        invitationId: organizationJoinRequests.invitationId,
      })
      .from(organizationJoinRequests)
      .where(eq(organizationJoinRequests.orgId, orgId))
      .orderBy(desc(organizationJoinRequests.createdAt), desc(organizationJoinRequests.id))
      .limit(OPERATOR_MEMBER_ASKS),
  ]);
  const page = pageOf(rows, query.limit, (m) => [m.joinedAt, m.userId]);
  return { members: page.items, next: page.next, invitations, joinRequests };
}

// ── A workspace's channels ───────────────────────────────────────────────────

export const OPERATOR_CHANNEL_KINDS = ["channel", "dm", "task"] as const;

const CHANNEL_ID = sql.raw(`"channels"."id"`);

/**
 * A workspace's channels, direct conversations and tasks' conversations, newest first, in keyset pages: how many
 * people and agents are in each, never what was said there. Null: no such workspace.
 */
export async function operatorChannels(
  db: Database,
  orgId: string,
  query: PageQuery & { kind?: (typeof OPERATOR_CHANNEL_KINDS)[number] },
) {
  const after = query.cursor ? decodeCursor(query.cursor, UuidCursor) : null;
  if (!(await orgExists(db, orgId))) return null;
  const createdAt = ms(channels.createdAt);
  const rows = await db
    .select({
      id: channels.id,
      name: channels.name,
      kind: channels.kind,
      visibility: channels.visibility,
      people: sql<number>`(select count(*) from ${channelMembers}
        where ${channelMembers.channelId} = ${CHANNEL_ID} and ${channelMembers.userId} is not null)`.mapWith(Number),
      agents: sql<number>`(select count(*) from ${channelMembers}
        where ${channelMembers.channelId} = ${CHANNEL_ID} and ${channelMembers.agentId} is not null)`.mapWith(Number),
      createdAt,
      archivedAt: channels.archivedAt,
      deletedAt: channels.deletedAt,
    })
    .from(channels)
    .where(
      and(
        eq(channels.orgId, orgId),
        query.kind ? eq(channels.kind, query.kind) : undefined,
        after ? sql`(${createdAt}, ${channels.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(createdAt), desc(channels.id))
    .limit(query.limit + 1);
  const page = pageOf(rows, query.limit, (c) => [c.createdAt, c.id]);
  return { channels: page.items, next: page.next };
}

// ── A workspace's agents ─────────────────────────────────────────────────────

/** How many of an agent's channels its read lists, by name. */
export const OPERATOR_AGENT_CHANNELS = 200;

const agentColumns = {
  id: agents.id,
  orgId: agents.orgId,
  name: agents.name,
  handle: agents.handle,
  builtin: agents.builtin,
  ownerUserId: agents.ownerUserId,
  brain: agents.brain,
  model: agents.model,
  brainModel: agents.brainModel,
  credentialId: agents.credentialId,
  accountId: agents.brainAccountId,
  machineId: agents.machineId,
  approvalsLevel: agents.approvalsLevel,
  audienceMode: agents.audienceMode,
  heldAt: agents.operatorHoldAt,
  holdReason: agents.operatorHoldReason,
  createdAt: ms(agents.createdAt),
  archivedAt: agents.archivedAt,
  deletedAt: agents.deletedAt,
};

const withHold = <T extends { heldAt: Date | null; holdReason: string | null }>({
  heldAt,
  holdReason,
  ...agent
}: T) => ({
  ...agent,
  hold: heldAt ? { heldAt, reason: holdReason } : null,
});

/**
 * A workspace's agents, newest first, in keyset pages: archived and deleted ones too, since their runs outlive
 * them. Null: no such workspace.
 */
export async function operatorAgents(db: Database, orgId: string, query: PageQuery) {
  const after = query.cursor ? decodeCursor(query.cursor, UuidCursor) : null;
  if (!(await orgExists(db, orgId))) return null;
  const rows = await db
    .select(agentColumns)
    .from(agents)
    .where(
      and(
        eq(agents.orgId, orgId),
        after
          ? sql`(${agentColumns.createdAt}, ${agents.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(agentColumns.createdAt), desc(agents.id))
    .limit(query.limit + 1);
  const page = pageOf(rows, query.limit, (a) => [a.createdAt, a.id]);
  return { agents: page.items.map(withHold), next: page.next };
}

/** An AI account as the operator reads it: how it signs in and whether it works, never its email, label or key hint. */
export const operatorAccountColumns = {
  id: machineAccounts.id,
  kind: machineAccounts.kind,
  provider: machineAccounts.provider,
  authMethod: machineAccounts.authMethod,
  plan: machineAccounts.plan,
  status: machineAccounts.status,
  statusUnknown: machineAccounts.statusUnknown,
  lastSuccessAt: machineAccounts.lastSuccessAt,
  lastFailureCause: machineAccounts.lastFailureCause,
  lastFailureAt: machineAccounts.lastFailureAt,
};

/**
 * One agent: who thinks for it and with which key or sign-in, its computer, the channels it is in, and how many
 * skills, routines and memories it has. Never its instructions nor the text of any of those. Null: no such agent.
 */
export async function operatorAgent(db: Database, agentId: string) {
  const [agent] = await db
    .select({ ...agentColumns, previousHandles: agents.previousHandles, fallback: agents.brainFallback })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!agent) return null;
  const { orgId } = agent;
  const [credentials, accounts, computers, inChannels, skillCount, routineCount, memoryCount] = await Promise.all([
    agent.credentialId
      ? db
          .select({
            id: providerCredentials.id,
            provider: providerCredentials.provider,
            revokedAt: providerCredentials.revokedAt,
          })
          .from(providerCredentials)
          .where(and(eq(providerCredentials.orgId, orgId), eq(providerCredentials.id, agent.credentialId)))
      : [],
    agent.accountId
      ? db
          .select(operatorAccountColumns)
          .from(machineAccounts)
          .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, agent.accountId)))
      : [],
    agent.machineId
      ? db
          .select({
            id: machines.id,
            name: machines.name,
            kind: machines.kind,
            online: machines.online,
            lastSeenAt: machines.lastSeenAt,
            deletedAt: machines.deletedAt,
          })
          .from(machines)
          .where(and(eq(machines.orgId, orgId), eq(machines.id, agent.machineId)))
      : [],
    db
      .select({ id: channels.id, name: channels.name, autoReply: channelMembers.autoReply })
      .from(channelMembers)
      .innerJoin(channels, and(eq(channels.orgId, channelMembers.orgId), eq(channels.id, channelMembers.channelId)))
      .where(and(eq(channelMembers.agentId, agentId), eq(channels.kind, "channel"), isNull(channels.deletedAt)))
      .orderBy(asc(channels.name))
      .limit(OPERATOR_AGENT_CHANNELS),
    db
      .select({ n: count() })
      .from(agentSkills)
      .innerJoin(skills, eq(skills.id, agentSkills.skillId))
      .where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.enabled, true), isNull(skills.deletedAt))),
    db
      .select({ n: count() })
      .from(routines)
      .where(and(eq(routines.agentId, agentId), isNull(routines.deletedAt))),
    db
      .select({ n: count() })
      .from(contextItems)
      .where(and(eq(contextItems.agentId, agentId), eq(contextItems.status, "active"))),
  ]);
  const credential = credentials[0] ?? null;
  const machine = computers[0];
  return {
    ...withHold(agent),
    provider: credential?.provider ?? modelInfo(agent.model)?.provider ?? null,
    credential,
    account: accounts[0] ?? null,
    machine: machine
      ? {
          id: machine.id,
          name: machine.name,
          kind: machine.kind,
          online: machineOnline(machine),
          lastSeenAt: machine.lastSeenAt,
        }
      : null,
    channels: inChannels,
    counts: {
      skills: skillCount[0]?.n ?? 0,
      routines: routineCount[0]?.n ?? 0,
      memories: memoryCount[0]?.n ?? 0,
    },
  };
}

// ── What a reference names ───────────────────────────────────────────────────

/** How many things one reference resolves to at most. */
export const OPERATOR_RESOLVE_MAX = 20;

export const OPERATOR_REF_FORMS = [
  "message_link",
  "file_link",
  "handle",
  "channel_name",
  "task_number",
  "id",
  "id_prefix",
  "user_id",
] as const;

export const OPERATOR_MATCH_KINDS = [
  "workspace",
  "user",
  "agent",
  "channel",
  "dm",
  "task_conversation",
  "message",
  "run",
  "task",
  "file",
  "computer",
  "ai_account",
] as const;

export interface OperatorMatch {
  kind: (typeof OPERATOR_MATCH_KINDS)[number];
  id: string;
  /** Null only for an account found by its id: it belongs to no one workspace. */
  orgId: string | null;
  name: string | null;
  handle: string | null;
  email: string | null;
  channelId: string | null;
  threadRootId: string | null;
  agentId: string | null;
  runId: string | null;
  number: number | null;
  version: number | null;
  createdAt: Date;
}

const NOTHING = {
  orgId: null,
  name: null,
  handle: null,
  email: null,
  channelId: null,
  threadRootId: null,
  agentId: null,
  runId: null,
  number: null,
  version: null,
};
const matchOf =
  (kind: OperatorMatch["kind"]) =>
  (row: Partial<OperatorMatch> & Pick<OperatorMatch, "id" | "createdAt">): OperatorMatch => ({
    ...NOTHING,
    ...row,
    kind,
  });

type Where = SQL | undefined;

const findAgents = async (db: Database, where: Where) =>
  (
    await db
      .select({
        id: agents.id,
        orgId: agents.orgId,
        name: agents.name,
        handle: agents.handle,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .where(where)
      .orderBy(asc(agents.id))
      .limit(OPERATOR_RESOLVE_MAX)
  ).map(matchOf("agent"));

const findChannels = async (db: Database, where: Where) =>
  (
    await db
      .select({
        id: channels.id,
        orgId: channels.orgId,
        name: channels.name,
        kind: channels.kind,
        createdAt: channels.createdAt,
      })
      .from(channels)
      .where(where)
      .orderBy(asc(channels.id))
      .limit(OPERATOR_RESOLVE_MAX)
  ).map(({ kind, name, ...row }) =>
    // A direct conversation's name is a digest of who is in it, a task's conversation's is made up: neither is shown.
    kind === "dm"
      ? matchOf("dm")(row)
      : kind === "task"
        ? matchOf("task_conversation")(row)
        : matchOf("channel")({ ...row, name }),
  );

const findMessages = async (db: Database, where: Where) =>
  (
    await db
      .select({
        id: messages.id,
        orgId: messages.orgId,
        channelId: messages.channelId,
        threadRootId: messages.threadId,
        agentId: messages.authorAgentId,
        runId: messages.agentRunId,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(where)
      .orderBy(asc(messages.id))
      .limit(OPERATOR_RESOLVE_MAX)
  ).map(matchOf("message"));

const findRuns = async (db: Database, where: Where) =>
  (
    await db
      .select({
        id: agentRuns.id,
        orgId: agentRuns.orgId,
        agentId: agentRuns.agentId,
        channelId: agentRuns.channelId,
        threadRootId: agentRuns.threadRootId,
        createdAt: agentRuns.createdAt,
      })
      .from(agentRuns)
      .where(where)
      .orderBy(asc(agentRuns.id))
      .limit(OPERATOR_RESOLVE_MAX)
  ).map(matchOf("run"));

const findTasks = async (db: Database, where: Where) =>
  (
    await db
      .select({
        id: issues.id,
        orgId: issues.orgId,
        number: issues.number,
        channelId: issues.conversationChannelId,
        threadRootId: issues.conversationRootId,
        createdAt: issues.createdAt,
      })
      .from(issues)
      .where(where)
      .orderBy(asc(issues.id))
      .limit(OPERATOR_RESOLVE_MAX)
  ).map(matchOf("task"));

const findFiles = async (db: Database, where: Where) =>
  (
    await db
      .select({
        id: artifacts.id,
        orgId: artifacts.orgId,
        channelId: artifacts.channelId,
        threadRootId: artifacts.threadId,
        version: artifacts.currentVersion,
        createdAt: artifacts.createdAt,
      })
      .from(artifacts)
      .where(where)
      .orderBy(asc(artifacts.id))
      .limit(OPERATOR_RESOLVE_MAX)
  ).map(matchOf("file"));

const findComputers = async (db: Database, where: Where) =>
  (
    await db
      .select({ id: machines.id, orgId: machines.orgId, name: machines.name, createdAt: machines.createdAt })
      .from(machines)
      .where(where)
      .orderBy(asc(machines.id))
      .limit(OPERATOR_RESOLVE_MAX)
  ).map(matchOf("computer"));

const findAiAccounts = async (db: Database, where: Where) =>
  (
    await db
      .select({ id: machineAccounts.id, orgId: machineAccounts.orgId, createdAt: machineAccounts.createdAt })
      .from(machineAccounts)
      .where(where)
      .orderBy(asc(machineAccounts.id))
      .limit(OPERATOR_RESOLVE_MAX)
  ).map(matchOf("ai_account"));

/** Everything whose id is in `lo`..`hi` (one id, or the ids starting alike), in `orgId` when given. */
async function findById(db: Database, lo: string, hi: string, orgId: string | undefined): Promise<OperatorMatch[]> {
  const idIn = (id: unknown, org: unknown) =>
    and(sql`${id} between ${lo}::uuid and ${hi}::uuid`, orgId ? sql`${org} = ${orgId}::uuid` : undefined);
  const found = await Promise.all([
    lo === hi && (!orgId || orgId === lo)
      ? db
          .select({
            id: organizations.id,
            orgId: organizations.id,
            name: organizations.name,
            createdAt: organizations.createdAt,
          })
          .from(organizations)
          .where(eq(organizations.id, lo))
          .then((rows) => rows.map(matchOf("workspace")))
      : [],
    findAgents(db, idIn(agents.id, agents.orgId)),
    findChannels(db, idIn(channels.id, channels.orgId)),
    findMessages(db, idIn(messages.id, messages.orgId)),
    findRuns(db, idIn(agentRuns.id, agentRuns.orgId)),
    findTasks(db, idIn(issues.id, issues.orgId)),
    findFiles(db, idIn(artifacts.id, artifacts.orgId)),
    findComputers(db, idIn(machines.id, machines.orgId)),
    findAiAccounts(db, idIn(machineAccounts.id, machineAccounts.orgId)),
  ]);
  return found.flat();
}

async function matchesOf(
  db: Database,
  ref: string,
  orgId: string | undefined,
): Promise<{ form: (typeof OPERATOR_REF_FORMS)[number]; matches: OperatorMatch[] }> {
  const inOrg = () => {
    if (!orgId)
      throw new ValidationError("orgId is required for a handle, a channel, a task's number or part of an id");
    return orgId;
  };
  // A link is read whatever its address: its ids are looked up here, where another server's name nothing.
  const path = ref.replace(/^https?:\/\/[^/?#]+/i, "");
  const message = parseMessageLink(path);
  if (message) {
    const here = !orgId || orgId === message.orgId;
    const where = and(eq(messages.orgId, message.orgId), eq(messages.id, message.messageId));
    return { form: "message_link", matches: here ? await findMessages(db, where) : [] };
  }
  const file = parseFileLink(path);
  if (file) {
    const here = !orgId || orgId === file.orgId;
    const found = here
      ? await findFiles(db, and(eq(artifacts.orgId, file.orgId), eq(artifacts.id, file.artifactId)))
      : [];
    return { form: "file_link", matches: found.map((f) => ({ ...f, version: file.version ?? f.version })) };
  }
  if (/^@[\w-]{1,64}$/.test(ref)) {
    const org = inOrg();
    const handle = ref.slice(1).toLowerCase();
    const [named, people] = await Promise.all([
      findAgents(
        db,
        and(eq(agents.orgId, org), or(eq(agents.handle, handle), sql`${handle} = any(${agents.previousHandles})`)),
      ),
      db
        .select({
          id: users.id,
          orgId: organizationMembers.orgId,
          name: users.name,
          handle: organizationMembers.handle,
          email: users.email,
          createdAt: users.createdAt,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(and(eq(organizationMembers.orgId, org), eq(organizationMembers.handle, handle)))
        .limit(OPERATOR_RESOLVE_MAX),
    ]);
    return { form: "handle", matches: [...named, ...people.map(matchOf("user"))] };
  }
  // Eight digits are read as the start of an id below: no workspace has that many tasks.
  if (/^(#\d{1,9}|\d{1,7})$/.test(ref)) {
    const org = inOrg();
    const number = Number(ref.replace("#", ""));
    const [tasks, named] = await Promise.all([
      findTasks(db, and(eq(issues.orgId, org), eq(issues.number, number))),
      ref.startsWith("#")
        ? findChannels(db, and(eq(channels.orgId, org), eq(channels.kind, "channel"), eq(channels.name, ref.slice(1))))
        : [],
    ]);
    return { form: "task_number", matches: [...tasks, ...named] };
  }
  if (/^#[\w-]{1,80}$/.test(ref)) {
    const name = ref.slice(1).toLowerCase();
    const where = and(eq(channels.orgId, inOrg()), eq(channels.kind, "channel"), eq(channels.name, name));
    return { form: "channel_name", matches: await findChannels(db, where) };
  }
  if (UUID.test(ref)) {
    const id = ref.toLowerCase();
    return { form: "id", matches: await findById(db, id, id, orgId) };
  }
  if (/^[0-9a-f]{8}$/i.test(ref)) {
    const start = ref.toLowerCase();
    const matches = await findById(
      db,
      `${start}-0000-0000-0000-000000000000`,
      `${start}-ffff-ffff-ffff-ffffffffffff`,
      inOrg(),
    );
    return { form: "id_prefix", matches };
  }
  if (/^[\w-]{1,200}$/.test(ref)) {
    const found = await db
      .select({ id: users.id, name: users.name, email: users.email, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, ref));
    return { form: "user_id", matches: found.map(matchOf("user")) };
  }
  throw new ValidationError(
    "ref is none of: a message's or a file's link, an @handle, a #channel, a task's number, an id or the first 8 characters of one, an account's id",
  );
}

/**
 * What a reference names and where it lives: its kind and its ids, with the names an operator tells things apart
 * by, never a task's or a file's title. `form` says how the reference was read, so an empty answer means nothing
 * by that handle, number or id, not a reference misread.
 */
export async function operatorResolve(db: Database, input: { ref: string; orgId?: string }) {
  const { form, matches } = await matchesOf(db, input.ref.trim(), input.orgId);
  return { form, matches: matches.slice(0, OPERATOR_RESOLVE_MAX) };
}
