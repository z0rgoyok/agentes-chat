import {
  and,
  count,
  type Database,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { connectorKeyOf } from "./connector-usage";
import { CUSTOM_PREFIX } from "./connectors/custom";
import { decodeCursor, encodeCursor } from "./cursor";
import { ValidationError } from "./errors";
import { getOrMake, stringsOf } from "./format";
import {
  codeOf,
  errorText,
  mergedPage,
  micros,
  ms,
  olderThan,
  orgExists,
  type PageQuery,
  pageOf,
  UuidCursor,
  uuidOf,
  wordOf,
} from "./operator-paging";

/**
 * What a workspace connected, what its audit log recorded, what its agents asked and what its routines did, for the
 * operator API (ADR 0056). Ids, labels, states, codes and times: never a credential, an audit entry's details, what
 * was asked or answered, nor a routine's instructions. Every field is picked by name, and nothing here writes,
 * because a caller holding only the read token reaches all of it.
 */

const {
  agentConsultations,
  agentQuestions,
  approvals,
  auditLog,
  browserHandoffs,
  connectorConnections,
  connectorUsageDays,
  customTools,
  dbConnections,
  mailAccounts,
  routineRuns,
  routines,
  secretRequests,
} = schema;

// ── Connections ──────────────────────────────────────────────────────────────

export const OPERATOR_CONNECTION_KINDS = ["connector", "mailbox", "database"] as const;
/** How much of a connection's last error an answer carries. */
export const OPERATOR_CONNECTION_ERROR_MAX = 300;

interface Connection {
  kind: (typeof OPERATOR_CONNECTION_KINDS)[number];
  id: string;
  /** The key its use is counted under (`connectorKeyOf`). */
  connector: string;
  /** A server connected by address: its tools are the ones its workspace classified. */
  classified: boolean;
  label: string;
  authType: string | null;
  status: string;
  lastError: string | null;
  createdAt: Date;
  createdByUserId: string | null;
  revokedAt: Date | null;
}

/** How an admin classified a server's tools; one not classified yet, or classified as nothing known, is undecided. */
const TOOL_LEVELS = ["read", "write", "approval", "off"] as const;
const noTools = () => ({ read: 0, write: 0, approval: 0, off: 0, undecided: 0 });

/**
 * What a workspace connected for its agents, removed ones too, newest first, in keyset pages: connected apps and
 * servers, mailboxes and databases. Each with the service it is of, its label, its state and the start of its last
 * error. Never a credential, and of where it is no more than a server's hostname (`connector`): no path, no
 * mailbox's address, no database's host. A label is what its workspace calls it, though, and one nobody named is
 * called by just that: the mailbox's address, the database's host or name, the server's hostname, or the service
 * and the account's name. Null: no such workspace.
 */
export async function operatorConnections(db: Database, orgId: string, query: PageQuery) {
  const after = query.cursor ? decodeCursor(query.cursor, UuidCursor) : null;
  if (!(await orgExists(db, orgId))) return null;
  const more = query.limit + 1;
  const cc = connectorConnections;
  const [connectorAt, mailboxAt, databaseAt] = [
    ms(cc.createdAt),
    ms(mailAccounts.createdAt),
    ms(dbConnections.createdAt),
  ];
  const [connectors, mailboxes, databases] = await Promise.all([
    db
      .select({
        id: cc.id,
        connector: cc.connector,
        // Read for the service's key alone: a server connected by address is told by its host, never its path.
        serverUrl: cc.serverUrl,
        label: cc.label,
        authType: cc.authType,
        status: cc.status,
        lastError: cc.lastError,
        createdAt: connectorAt,
        createdByUserId: cc.createdByUserId,
        revokedAt: cc.revokedAt,
      })
      .from(cc)
      .where(and(eq(cc.orgId, orgId), olderThan(connectorAt, cc.id, after)))
      .orderBy(desc(connectorAt), desc(cc.id))
      .limit(more),
    db
      .select({
        id: mailAccounts.id,
        provider: mailAccounts.provider,
        via: mailAccounts.via,
        preset: mailAccounts.preset,
        label: mailAccounts.label,
        status: mailAccounts.status,
        lastError: mailAccounts.lastError,
        createdAt: mailboxAt,
        createdByUserId: mailAccounts.createdByUserId,
        revokedAt: mailAccounts.revokedAt,
      })
      .from(mailAccounts)
      .where(and(eq(mailAccounts.orgId, orgId), olderThan(mailboxAt, mailAccounts.id, after)))
      .orderBy(desc(mailboxAt), desc(mailAccounts.id))
      .limit(more),
    db
      .select({
        id: dbConnections.id,
        label: dbConnections.label,
        status: dbConnections.status,
        lastError: dbConnections.lastError,
        createdAt: databaseAt,
        createdByUserId: dbConnections.createdByUserId,
        revokedAt: dbConnections.revokedAt,
      })
      .from(dbConnections)
      .where(and(eq(dbConnections.orgId, orgId), olderThan(databaseAt, dbConnections.id, after)))
      .orderBy(desc(databaseAt), desc(dbConnections.id))
      .limit(more),
  ]);
  const page = mergedPage<Connection>(
    [
      connectors.map(({ connector, serverUrl, ...c }) => ({
        ...c,
        kind: "connector",
        connector: connectorKeyOf({ connector, serverUrl }),
        classified: connector.startsWith(CUSTOM_PREFIX),
      })),
      mailboxes.map(({ provider, via, preset, ...m }) => ({
        ...m,
        kind: "mailbox",
        connector: connectorKeyOf({ provider, via, preset }),
        classified: false,
        authType: via,
      })),
      databases.map((d) => ({ ...d, kind: "database", connector: "postgres", classified: false, authType: null })),
    ],
    query.limit,
  );

  const classified = page.items.filter((c) => c.classified).map((c) => c.id);
  const keys = [...new Set(page.items.map((c) => c.connector))];
  const [levels, used] = await Promise.all([
    classified.length === 0
      ? []
      : db
          .select({ connectionId: customTools.connectionId, access: customTools.access, tools: count() })
          .from(customTools)
          .where(and(inArray(customTools.connectionId, classified), isNull(customTools.removedAt)))
          .groupBy(customTools.connectionId, customTools.access),
    keys.length === 0
      ? []
      : db
          .select({ connector: connectorUsageDays.connector, day: sql<string>`max(${connectorUsageDays.day})::text` })
          .from(connectorUsageDays)
          .where(
            and(
              eq(connectorUsageDays.orgId, orgId),
              inArray(connectorUsageDays.connector, keys),
              gt(connectorUsageDays.calls, 0),
            ),
          )
          .groupBy(connectorUsageDays.connector),
  ]);
  const tools = new Map<string, ReturnType<typeof noTools>>();
  for (const { connectionId, access, tools: n } of levels) {
    const level = TOOL_LEVELS.find((l) => l === access) ?? "undecided";
    getOrMake(tools, connectionId, noTools)[level] += n;
  }
  const lastUsed = new Map(used.map((u) => [u.connector, u.day]));

  return {
    connections: page.items.map(({ classified: own, lastError, ...c }) => ({
      ...c,
      lastErrorCode: codeOf(lastError),
      lastError: errorText(lastError, OPERATOR_CONNECTION_ERROR_MAX),
      lastUsedDay: lastUsed.get(c.connector) ?? null,
      tools: own ? (tools.get(c.id) ?? noTools()) : null,
    })),
    next: page.next,
  };
}

// ── The audit log ────────────────────────────────────────────────────────────

/** How far back the audit log is read when no start is given. */
export const OPERATOR_AUDIT_DAYS = 30;
export const OPERATOR_AUDIT_ACTORS = ["person", "agent", "system"] as const;

export interface OperatorAuditQuery extends PageQuery {
  /** How the action's name starts: `connector.`, `tool.call`… */
  action?: string;
  actorType?: (typeof OPERATOR_AUDIT_ACTORS)[number];
  actorId?: string;
  targetType?: string;
  targetId?: string;
  runId?: string;
  /** Recorded at or after. */
  from?: Date;
  /** Recorded before. */
  to?: Date;
}

/**
 * A workspace's audit log in a range of dates, newest first, in keyset pages: who did what to what, and how an
 * agent's tool call ended. Never an entry's `details`, which hold a tool's input and what a change was made of.
 * The range is the last 30 days unless said. Null: no such workspace.
 */
export async function operatorAudit(db: Database, orgId: string, query: OperatorAuditQuery, now = new Date()) {
  const after = query.cursor ? decodeCursor(query.cursor, UuidCursor) : null;
  if (!(await orgExists(db, orgId))) return null;
  const to = query.to ?? now;
  const from = query.from ?? new Date(to.getTime() - OPERATOR_AUDIT_DAYS * 86_400_000);
  if (from >= to) throw new ValidationError("from must be before to");
  // Ordered and continued by the stored time itself: the log is every tool call, and its index is on that column.
  const rows = await db
    .select({
      id: auditLog.id,
      at: auditLog.createdAt,
      storedAt: micros(auditLog.createdAt),
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      outcome: sql<string | null>`${auditLog.outcome}`,
      runId: auditLog.runId,
      onBehalfOfUserId: auditLog.onBehalfOfUserId,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.orgId, orgId),
        gte(auditLog.createdAt, from),
        lt(auditLog.createdAt, to),
        query.action ? sql`starts_with(${auditLog.action}, ${query.action})` : undefined,
        query.actorType ? eq(auditLog.actorType, query.actorType) : undefined,
        query.actorId ? eq(auditLog.actorId, query.actorId) : undefined,
        query.targetType ? eq(auditLog.targetType, query.targetType) : undefined,
        query.targetId ? eq(auditLog.targetId, query.targetId) : undefined,
        query.runId ? eq(auditLog.runId, query.runId) : undefined,
        olderThan(auditLog.createdAt, auditLog.id, after),
      ),
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    from,
    to,
    // A target is told by its id, or, having none, by the name its workspace knows it by: a tool, a repository
    // (`repository`, `git_repo`), a wiki folder's path. Anything longer than a word in its place reads as absent.
    events: page.map(({ storedAt, ...e }) => ({ ...e, targetId: wordOf(e.targetId), outcome: codeOf(e.outcome) })),
    next: last && rows.length > query.limit ? encodeCursor([last.storedAt, last.id]) : null,
  };
}

// ── What agents asked ────────────────────────────────────────────────────────

export const OPERATOR_ASK_KINDS = ["approval", "question", "secret", "handoff", "consultation"] as const;
type AskKind = (typeof OPERATOR_ASK_KINDS)[number];

/** The states in which an ask of each kind still waits. */
const WAITING: Record<AskKind, string[]> = {
  approval: ["pending"],
  question: ["open"],
  secret: ["pending"],
  handoff: ["pending", "active"],
  consultation: ["open"],
};

interface Ask {
  kind: AskKind;
  id: string;
  status: string;
  agentId: string;
  runId: string | null;
  channelId: string | null;
  threadRootId: string | null;
  messageId: string | null;
  tool: string | null;
  variant: string | null;
  forUserIds: string[];
  forAgentId: string | null;
  answerRunId: string | null;
  byUserId: string | null;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt: Date | null;
}

/** What only some kinds of ask have. */
const NOT_ITS_KIND = {
  runId: null,
  channelId: null,
  threadRootId: null,
  messageId: null,
  tool: null,
  variant: null,
  forAgentId: null,
  answerRunId: null,
  byUserId: null,
};

export interface OperatorAskQuery extends PageQuery {
  kind?: AskKind;
  /** Only the ones still waiting, or only the ones that ended. */
  open?: boolean;
  /** The agent that asked. */
  agentId?: string;
  /** The run that asked. */
  runId?: string;
  /** Asked at or after. */
  from?: Date;
  /** Asked before. */
  to?: Date;
}

/**
 * What a workspace's agents asked, newest first, in keyset pages, in one list: actions to approve, questions to
 * people, secrets for a computer, a person's turn on an agent's screen, and one agent consulting another. Each with
 * its state, who asked, whom it is asked of, who answered and its times. Never an approval's title, parameters or
 * reason, a question's or a consultation's text or answer, what a secret is for, nor what a person was asked to do
 * on a screen. Null: no such workspace.
 */
export async function operatorAsks(db: Database, orgId: string, query: OperatorAskQuery) {
  const after = query.cursor ? decodeCursor(query.cursor, UuidCursor) : null;
  if (!(await orgExists(db, orgId))) return null;
  const more = query.limit + 1;
  type Asked = { orgId: unknown; id: unknown; createdAt: unknown; status: unknown };
  /** Where a kind's rows are in the page asked for, and their time as it orders them. */
  const asked = (kind: AskKind, t: Asked, agent: unknown, run: unknown) => {
    const at = ms(t.createdAt);
    const waiting = sql`${t.status}::text in (${sql.join(
      WAITING[kind].map((s) => sql`${s}`),
      sql`, `,
    )})`;
    const where = and(
      sql`${t.orgId} = ${orgId}::uuid`,
      query.agentId ? sql`${agent} = ${query.agentId}::uuid` : undefined,
      query.runId ? sql`${run} = ${query.runId}::uuid` : undefined,
      query.open === undefined ? undefined : query.open ? waiting : sql`not ${waiting}`,
      query.from ? sql`${t.createdAt} >= ${query.from.toISOString()}::timestamptz` : undefined,
      query.to ? sql`${t.createdAt} < ${query.to.toISOString()}::timestamptz` : undefined,
      olderThan(at, t.id, after),
    );
    return { at, where, wanted: !query.kind || query.kind === kind };
  };
  const approval = asked("approval", approvals, approvals.agentId, approvals.runId);
  const question = asked("question", agentQuestions, agentQuestions.agentId, agentQuestions.runId);
  const secret = asked("secret", secretRequests, secretRequests.agentId, secretRequests.runId);
  const handoff = asked("handoff", browserHandoffs, browserHandoffs.agentId, browserHandoffs.runId);
  const consultation = asked(
    "consultation",
    agentConsultations,
    agentConsultations.askerAgentId,
    agentConsultations.askerRunId,
  );
  const text = (column: unknown) => sql<string>`${column}::text`;
  const [toApprove, questions, secrets, handoffs, consultations] = await Promise.all([
    !approval.wanted
      ? []
      : db
          .select({
            id: approvals.id,
            status: text(approvals.status),
            agentId: approvals.agentId,
            runId: approvals.runId,
            channelId: approvals.channelId,
            threadRootId: approvals.threadRootId,
            messageId: approvals.messageId,
            tool: approvals.tool,
            approvers: approvals.approvers,
            ownerUserId: approvals.ownerUserId,
            byUserId: approvals.decidedByUserId,
            createdAt: approval.at,
            expiresAt: approvals.expiresAt,
            resolvedAt: approvals.decidedAt,
          })
          .from(approvals)
          .where(approval.where)
          .orderBy(desc(approval.at), desc(approvals.id))
          .limit(more),
    !question.wanted
      ? []
      : db
          .select({
            id: agentQuestions.id,
            status: text(agentQuestions.status),
            agentId: agentQuestions.agentId,
            runId: agentQuestions.runId,
            channelId: agentQuestions.channelId,
            threadRootId: agentQuestions.threadId,
            messageId: agentQuestions.messageId,
            forUserId: agentQuestions.requestedForUserId,
            byUserId: agentQuestions.answeredByUserId,
            createdAt: question.at,
            expiresAt: agentQuestions.expiresAt,
            resolvedAt: agentQuestions.answeredAt,
          })
          .from(agentQuestions)
          .where(question.where)
          .orderBy(desc(question.at), desc(agentQuestions.id))
          .limit(more),
    !secret.wanted
      ? []
      : db
          .select({
            id: secretRequests.id,
            status: text(secretRequests.status),
            agentId: secretRequests.agentId,
            runId: secretRequests.runId,
            channelId: secretRequests.channelId,
            threadRootId: secretRequests.threadId,
            messageId: secretRequests.messageId,
            forUserId: secretRequests.requestedForUserId,
            createdAt: secret.at,
            expiresAt: secretRequests.expiresAt,
            resolvedAt: secretRequests.deliveredAt,
          })
          .from(secretRequests)
          .where(secret.where)
          .orderBy(desc(secret.at), desc(secretRequests.id))
          .limit(more),
    !handoff.wanted
      ? []
      : db
          .select({
            id: browserHandoffs.id,
            status: text(browserHandoffs.status),
            agentId: browserHandoffs.agentId,
            runId: browserHandoffs.runId,
            variant: text(browserHandoffs.kind),
            forUserId: browserHandoffs.requestedForUserId,
            byUserId: browserHandoffs.controllerUserId,
            createdAt: handoff.at,
            expiresAt: browserHandoffs.expiresAt,
            resolvedAt: browserHandoffs.resolvedAt,
          })
          .from(browserHandoffs)
          .where(handoff.where)
          .orderBy(desc(handoff.at), desc(browserHandoffs.id))
          .limit(more),
    !consultation.wanted
      ? []
      : db
          .select({
            id: agentConsultations.id,
            status: text(agentConsultations.status),
            agentId: agentConsultations.askerAgentId,
            runId: agentConsultations.askerRunId,
            channelId: agentConsultations.channelId,
            messageId: agentConsultations.messageId,
            variant: text(agentConsultations.kind),
            forAgentId: agentConsultations.targetAgentId,
            answerRunId: agentConsultations.targetRunId,
            createdAt: consultation.at,
            expiresAt: agentConsultations.expiresAt,
            resolvedAt: agentConsultations.answeredAt,
          })
          .from(agentConsultations)
          .where(consultation.where)
          .orderBy(desc(consultation.at), desc(agentConsultations.id))
          .limit(more),
  ]);
  const one = (userId: string | null) => (userId ? [userId] : []);
  const page = mergedPage<Ask>(
    [
      toApprove.map(({ approvers, ownerUserId, tool, ...row }) => {
        // The people an approval names decide it; with none named, its agent's owner is who it is asked of.
        const named = stringsOf(approvers?.userIds).flatMap((id) => wordOf(id) ?? []);
        return {
          ...NOT_ITS_KIND,
          ...row,
          kind: "approval",
          tool: codeOf(tool),
          forUserIds: named.length > 0 ? named : one(ownerUserId),
        };
      }),
      questions.map(({ forUserId, ...row }) => ({
        ...NOT_ITS_KIND,
        ...row,
        kind: "question",
        forUserIds: one(forUserId),
      })),
      secrets.map(({ forUserId, ...row }) => ({ ...NOT_ITS_KIND, ...row, kind: "secret", forUserIds: one(forUserId) })),
      handoffs.map(({ forUserId, variant, ...row }) => ({
        ...NOT_ITS_KIND,
        ...row,
        kind: "handoff",
        variant: codeOf(variant),
        forUserIds: one(forUserId),
      })),
      consultations.map((row) => ({ ...NOT_ITS_KIND, ...row, kind: "consultation", forUserIds: [] })),
    ],
    query.limit,
  );
  return { asks: page.items, next: page.next };
}

// ── Routines ─────────────────────────────────────────────────────────────────

/** How many of a routine's latest firings an answer lists. */
export const OPERATOR_ROUTINE_RUNS = 5;

const ROUTINE_ID = sql.raw(`"routines"."id"`);
// Never `summary` nor `event`: what the run reported, and the call or the message that fired it.
const LAST_RUNS = sql`(select r.id, r.at, r.trigger, r.status, r.code, r.agent_run_id, r.message_id, r.finished_at
  from ${routineRuns} r where r.routine_id = ${ROUTINE_ID}
  order by r.at desc limit ${OPERATOR_ROUTINE_RUNS}) fired`;

/** Five or six fields of digits, names and cron's own signs: anything else in a schedule's place reads as absent. */
const CRON = /^[\w*/,?#-]+(?: [\w*/,?#-]+){4,5}$/;

/**
 * A workspace's routines, deleted ones too, newest first, in keyset pages: whose each is, when it runs (its schedule
 * as stored, or the event that fires it), whether it is on and why it paused itself, where it delivers, and its
 * latest firings with how each ended and the run it started. Never its instructions, the words its schedule was
 * read from, nor what a firing reported. Never its name either: one nobody named is called by its instructions'
 * first line, a reminder always, and nothing stored tells such a name from one a person gave. Null: no such
 * workspace.
 */
export async function operatorRoutines(db: Database, orgId: string, query: PageQuery & { agentId?: string }) {
  const after = query.cursor ? decodeCursor(query.cursor, UuidCursor) : null;
  if (!(await orgExists(db, orgId))) return null;
  const at = ms(routines.createdAt);
  const rows = await db
    .select({
      id: routines.id,
      agentId: routines.agentId,
      triggerType: routines.triggerType,
      cron: routines.cron,
      timezone: routines.timezone,
      event: routines.event,
      active: routines.active,
      pausedReason: routines.pausedReason,
      // Named facts of where it delivers: a reminder's target also says whom it reminds.
      targetType: sql<string | null>`${routines.target}->>'type'`,
      targetChannelId: sql<string | null>`${routines.target}->>'channelId'`,
      targetThreadId: sql<string | null>`${routines.target}->>'threadId'`,
      nextRunAt: routines.nextRunAt,
      lastRunAt: routines.lastRunAt,
      createdByUserId: routines.createdByUserId,
      createdAt: at,
      deletedAt: routines.deletedAt,
    })
    .from(routines)
    .where(
      and(
        eq(routines.orgId, orgId),
        query.agentId ? eq(routines.agentId, query.agentId) : undefined,
        olderThan(at, routines.id, after),
      ),
    )
    .orderBy(desc(at), desc(routines.id))
    .limit(query.limit + 1);
  const page = pageOf(rows, query.limit, (r) => [r.createdAt, r.id]);
  const fired =
    page.items.length === 0
      ? []
      : await db
          .select({
            routineId: routines.id,
            id: sql<string>`fired.id`,
            at: ms(sql`fired.at`),
            trigger: sql<string>`fired.trigger`,
            status: sql<string>`fired.status`,
            code: sql<string | null>`fired.code`,
            runId: sql<string | null>`fired.agent_run_id`,
            messageId: sql<string | null>`fired.message_id`,
            // A null never reaches a decoder: the type says it may still come back.
            finishedAt: ms(sql`fired.finished_at`) as SQL<Date | null>,
          })
          .from(routines)
          .innerJoinLateral(LAST_RUNS, sql`true`)
          .where(
            inArray(
              routines.id,
              page.items.map((r) => r.id),
            ),
          )
          .orderBy(desc(sql`fired.at`));
  const runs = new Map<string, Omit<(typeof fired)[number], "routineId">[]>();
  for (const { routineId, ...run } of fired)
    getOrMake(runs, routineId, () => []).push({ ...run, code: codeOf(run.code) });

  return {
    routines: page.items.map(({ targetType, targetChannelId, targetThreadId, ...r }) => ({
      ...r,
      cron: r.cron && CRON.test(r.cron) ? r.cron : null,
      timezone: wordOf(r.timezone),
      event: codeOf(r.event),
      pausedReason: codeOf(r.pausedReason),
      target: {
        type: codeOf(targetType),
        channelId: uuidOf(targetChannelId),
        threadRootId: uuidOf(targetThreadId),
      },
      runs: runs.get(r.id) ?? [],
    })),
    next: page.next,
  };
}
