import { MAIL_PRESETS, type PubSub } from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  desc,
  type Executor,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  rowsOf,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { type ActiveCover, activeCoversFrom, activeCoversTo } from "./approval-covers";
import { resumeHeldRuns, wakeLine } from "./approval-order";
import { addApprovalRules, addRoutineOwnActions, type RememberedKind, rememberedKindOf } from "./approval-rules";
import { queueApprovalsDigest } from "./approvals-digest";
import {
  ACCESS_COLUMNS,
  type AgentOwnerFields,
  agentOwnerIds,
  managesAgent,
  managesAgentSql,
  managesRoutinesOf,
  ownsAgent,
  ownsAgentSql,
  REACH_COLUMNS,
} from "./audience";
import { recordAudit } from "./audit";
import { approvalCardVia } from "./card-via";
import { CONNECTOR_CATALOG } from "./connectors/catalog";
import { toolPrefixOfConnection } from "./connectors/connections";
import { isCustom } from "./connectors/custom";
import { exposedToolName } from "./connectors/mcp";
import { auditLabel } from "./connectors/personal";
import { learnFromRefusal } from "./context/feedback";
import type { MemoryJudging } from "./context/items";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { publishChannelEvent, publishUserEvent } from "./events";
import { type MailPreview, parseMailDetail, withoutReplyPrefix } from "./mail/preview";
import { notifyApproval, notifyNewcomers, resolveApprovalNotifications } from "./notification-producers";
import { can, type Membership, requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { quietEnd, withMootRequest } from "./parked-asks";
import { maySql, type RolePermission } from "./permissions";
import { accountInUse } from "./standing";
import { fileConversationReaderSql, taskReaderSql } from "./task-access";
import { AHEAD_GRACE_MS, type Approval, asksByChoice, isSensitive, readsSqlOnly, routineCall } from "./tools/gateway";
import { canonicalJson } from "./tools/json-schema";
import { REQUEST_PERMISSION_TOOL } from "./tools/permission";
import type { ApprovalOrigin } from "./tools/run-policy";

const {
  approvalCovers,
  approvals,
  organizationMembers,
  channelMembers,
  channels,
  agents,
  agentRuns,
  agentRunSteps,
  connectorConnections,
  customTools,
  issues,
  mailAccounts,
  messages,
  notifications,
  routines,
  users,
} = schema;

/** The email a mail approval would write (a draft, a send, a reply or a forward), as its card shows it. */
export interface ApprovalEmail extends MailPreview {
  verb: "draft" | "send" | "reply" | "forward";
  /** The mailbox it goes through, and its provider's name ("iCloud", "Gmail"; null: unknown). */
  mailbox: string;
  provider: string | null;
}

export interface ApprovalView {
  id: string;
  /** Null for an approval a mission's executor asked (`missionId`). */
  runId: string | null;
  missionId: string | null;
  agentId: string;
  channelId: string;
  /** Where its card is: the thread, or null for the main timeline (asked there). */
  threadId: string | null;
  messageId: string | null;
  tool: string;
  scope: string;
  title: string;
  detail: string;
  params: Record<string, unknown>;
  /** Stable key for the card's title (the tool), and the values it shows: the app words it in the person's language. */
  kind: string;
  titleParams: Record<string, string | number | boolean>;
  status: Approval["status"];
  expiresAt: string;
  createdAt: string;
  decidedByUserId: string | null;
  /** Decided by someone covering this person (ADR 0139): "Aprovado por Bruno, cobrindo Ana". */
  decidedForUserId: string | null;
  decidedAt: string | null;
  /** Canceled because the agent asked for the same action again in a later turn: that newer request. */
  supersededById: string | null;
  reason: string | null;
  /** Whether the person asking may approve or refuse it. */
  canDecide: boolean;
  /** The agent's owner at request time (they and admins may decide). */
  ownerUserId: string | null;
  /** Its owner role at request time instead (ADR 0085, addendum of 2026-11-21): whoever holds it decides. */
  ownerRoleId: string | null;
  /** When the approved action ran (null: not yet, or never). */
  executedAt: string | null;
  /**
   * What the action returned once it ran (raw tool output, short). `notRunAfter`: it didn't run, because the request
   * asked before it on its card (that id) was refused or expired after it was approved (`approval-order.ts`).
   */
  result: { ok: boolean; text: string; notRunAfter?: string } | null;
  /** The connector the action goes through (`github`), and its account (`acme`); null for built-in tools. */
  connector: string | null;
  connectorAccount: string | null;
  /** The email itself (From, To, Subject, text), for mail drafts and sends; null for every other action. */
  email: ApprovalEmail | null;
  /** The agent's required reason (ADR 0053): what it found and why this action, shown on the card. */
  why: string | null;
  /** Asked while nobody watched: by a routine (its name) or an unattended run; null when a person was behind it. */
  origin: ApprovalOrigin | null;
  /** The issue the run works on, when there is one. */
  issue: { id: string; number: number; title: string } | null;
  /** How the run got here: what the agent said at each turn before asking (one approval only). */
  trail?: { text: string; at: string }[];
  /** "Aprovar sempre" is offered: the server's tool and the actions approving for good covers; null: not offered. */
  approveAlways: RememberedKind | null;
  /** Approved ahead: when the routine's run does it by itself (`routineId`); null: it runs once approved. */
  runAt: string | null;
  routineId: string | null;
  /** Approved ahead and not run yet, and the person asking may still withdraw it (`cancelAheadApproval`). */
  canCancel: boolean;
  /**
   * The other runs' requests it runs after once approved (`approval-order.ts`), and whether the person asking may let it
   * run now instead ("Rodar este agora", `runApprovalNow`).
   */
  afterIds: string[];
  canRunNow: boolean;
  /**
   * Asked with `request_approval` (ADR 0126): who decides, in words ("Diretoria", "Ana, Bruno"), and the person
   * whose request it was, who decides it only when `requesterDecides` (an approver by role). Null: any other approval.
   */
  approvers: { label: string; requestedByUserId: string | null; requesterDecides: boolean } | null;
  /**
   * Still waiting, and plain enough to approve along with others in one tap (`routineIds`). The server alone says
   * so: `decideApprovals` with `only: "routine"` decides nothing else.
   */
  routine: boolean;
}

/** What the approval row alone doesn't say: the connector, the issue (and, for one, the trail). */
interface ApprovalContext {
  connector: string | null;
  connectorAccount: string | null;
  email: ApprovalEmail | null;
  issue: { id: string; number: number; title: string } | null;
  trail: { text: string; at: string }[];
  /** A person's own connection: its whole name and account, for that person's eyes alone (`viewsOf`). */
  own?: { userId: string; label: string; account: string | null; stored: string };
}

/** The stored origin (`approvals.origin`), read safely: its card and its notification say it. */
export function approvalOriginOf(value: Approval["origin"]): ApprovalOrigin | null {
  if (value?.kind === "unattended") return { kind: "unattended" };
  if (value?.kind === "routine" && typeof value.routineId === "string") {
    return {
      kind: "routine",
      routineId: value.routineId,
      routineName: typeof value.routineName === "string" ? value.routineName : "",
    };
  }
  return null;
}

/** The longest reason a person gives with a decision. Mirror: `APPROVAL_REASON_MAX` in packages/client approval-card.ts. */
export const APPROVAL_REASON_MAX = 1000;

const resultOf = (a: Approval): ApprovalView["result"] => {
  const r = a.result as { content?: unknown; isError?: unknown; notRunAfter?: unknown } | null;
  if (!r) return null;
  const text = typeof r.content === "string" ? r.content.slice(0, 600) : "";
  return typeof r.notRunAfter === "string"
    ? { ok: false, text, notRunAfter: r.notRunAfter }
    : { ok: r.isError !== true, text };
};

/** How many turns before an approval its details show (the latest), by their narration. */
const TRAIL_TURNS = 12;

/**
 * The narration of the latest `TRAIL_TURNS` turns before each approval's own step (or its run's last turns, when it has
 * none), oldest first. Read backwards from that step on the steps' `(run_id, seq)` key: never every step of a run.
 */
async function approvalTrails(db: Database, ids: string[]) {
  const rows = rowsOf<{ approval_id: string; text: string; at: string | Date }>(
    await db.execute(sql`select a.id as approval_id, t.text, t.at from ${approvals} a
      cross join lateral (select s.data->>'narration' as text, s.created_at as at, s.seq from ${agentRunSteps} s
        where s.run_id = a.run_id and s.kind = 'model_call' and coalesce(s.data->>'narration', '') <> ''
          and s.seq < coalesce((select min(p.seq) from ${agentRunSteps} p where p.run_id = a.run_id
            and p.kind = 'approval' and p.data->>'approvalId' = a.id::text), 2147483647)
        order by s.seq desc limit ${TRAIL_TURNS}) t
      where a.id = any(${`{${ids.join(",")}}`}::uuid[])
      order by a.id, t.seq`),
  );
  const out = new Map<string, ApprovalContext["trail"]>();
  for (const r of rows) {
    const trail = out.get(r.approval_id) ?? [];
    trail.push({ text: r.text, at: new Date(r.at).toISOString() });
    out.set(r.approval_id, trail);
  }
  return out;
}

/** Batched: connections, the runs' issues, and with `trail` the narration up to each approval's step. */
async function approvalContexts(db: Database, rows: Approval[], trail = false): Promise<Map<string, ApprovalContext>> {
  const out = new Map<string, ApprovalContext>();
  if (rows.length === 0) return out;
  // Mission approvals (ADR 0029) have no run.
  const runIds = [...new Set(rows.map((r) => r.runId).filter((id): id is string => !!id))];
  const connectionIds = [...new Set(rows.map((r) => r.connectionId).filter((id): id is string => !!id))];
  const [connections, mailboxes, trails, runs] = await Promise.all([
    connectionIds.length
      ? db
          .select({
            id: connectorConnections.id,
            connector: connectorConnections.connector,
            label: connectorConnections.label,
            account: connectorConnections.accountLabel,
            ownerUserId: connectorConnections.ownerUserId,
          })
          .from(connectorConnections)
          .where(inArray(connectorConnections.id, connectionIds))
      : Promise.resolve([]),
    // A mail tool's connection is the mailbox (ADR 0038).
    connectionIds.length
      ? db
          .select({
            id: mailAccounts.id,
            address: mailAccounts.address,
            provider: mailAccounts.provider,
            preset: mailAccounts.preset,
          })
          .from(mailAccounts)
          .where(inArray(mailAccounts.id, connectionIds))
      : Promise.resolve([]),
    trail && runIds.length
      ? approvalTrails(
          db,
          rows.map((r) => r.id),
        )
      : Promise.resolve(new Map<string, ApprovalContext["trail"]>()),
    runIds.length
      ? db.select({ id: agentRuns.id, issueId: agentRuns.issueId }).from(agentRuns).where(inArray(agentRuns.id, runIds))
      : Promise.resolve([]),
  ]);
  const issueIds = [...new Set(runs.map((r) => r.issueId).filter((id): id is string => !!id))];
  // A card reaches approvers outside its conversation, and its realtime event has no one viewer: a task tied to a DM or
  // a private channel stays off every card.
  const issueRows = issueIds.length
    ? await db
        .select({ id: issues.id, number: issues.number, title: issues.title })
        .from(issues)
        .leftJoin(channels, eq(channels.id, issues.channelId))
        .where(
          and(
            inArray(issues.id, issueIds),
            eq(issues.restricted, false),
            or(isNull(issues.channelId), and(eq(channels.kind, "channel"), eq(channels.visibility, "public"))),
          ),
        )
    : [];
  const connectionOf = new Map(connections.map((c) => [c.id, c]));
  const mailboxOf = new Map(mailboxes.map((m) => [m.id, m]));
  const issueOfRun = new Map(runs.map((r) => [r.id, issueRows.find((i) => i.id === r.issueId) ?? null]));
  for (const row of rows) {
    const connection = row.connectionId ? connectionOf.get(row.connectionId) : undefined;
    const mailbox = row.connectionId ? mailboxOf.get(row.connectionId) : undefined;
    // A person's own connection: its tools named the card as others read it (`auditLabel`), and so does the card.
    const others = connection?.ownerUserId
      ? { ...connection, label: auditLabel({ ...connection, accountLabel: connection.account }), account: null }
      : connection;
    out.set(row.id, {
      connector: connection?.connector ?? (mailbox ? "email" : null),
      connectorAccount: others ? accountNote(others) : (mailbox?.address ?? null),
      ...(connection?.ownerUserId && others
        ? {
            own: {
              userId: connection.ownerUserId,
              label: connection.label,
              account: accountNote(connection),
              stored: others.label,
            },
          }
        : {}),
      email: mailbox ? approvalEmail(row, mailbox) : null,
      issue: row.runId ? (issueOfRun.get(row.runId) ?? null) : null,
      trail: trails.get(row.id) ?? [],
    });
  }
  return out;
}

/**
 * The account an approval card names beside the service. A server by address goes by its connection's name
 * ("Stripe (Acme)"), so only an account that name doesn't say; a catalog connector goes by the catalog's
 * name, so a renamed connection says its own.
 */
function accountNote(c: { connector: string; label: string; account: string | null }) {
  const catalog = CONNECTOR_CATALOG[c.connector];
  if (catalog && c.label !== catalog.label) return c.label;
  return c.account && !c.label.includes(c.account) ? c.account : null;
}

const MAIL_VERBS = ["draft", "send", "reply", "forward"] as const;

/** The provider's name for people: "Gmail", "Outlook", the IMAP preset's ("iCloud"); null for a custom server. */
function mailProviderName(m: { provider: string; preset: string | null }) {
  if (m.provider === "gmail") return "Gmail";
  if (m.provider === "outlook") return "Outlook";
  const preset = m.preset && m.preset !== "custom" ? MAIL_PRESETS.find((p) => p.id === m.preset) : undefined;
  return preset ? preset.label.replace(/\s*\(.*\)$/, "") : null;
}

/**
 * The email a mail approval writes: from its detail (`mailDetail`), else from the call's own values (a draft
 * or a send carry them all). Null for the other mail actions (organizing, deleting).
 */
export function approvalEmail(
  row: Pick<Approval, "tool" | "detail" | "params">,
  mailbox: { address: string; provider: string; preset: string | null },
): ApprovalEmail | null {
  const verb = MAIL_VERBS.find((v) => row.tool.startsWith("mail_") && row.tool.endsWith(`_${v}`));
  if (!verb) return null;
  const preview = parseMailDetail(row.detail) ?? previewFromParams(row.params, mailbox.address, verb);
  return preview ? { ...preview, verb, mailbox: mailbox.address, provider: mailProviderName(mailbox) } : null;
}

function previewFromParams(params: Record<string, unknown>, address: string, verb: ApprovalEmail["verb"]) {
  if (verb !== "draft" && verb !== "send") return null;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const subject = text(params.subject);
  return {
    from: text(params.from) || address,
    to: list(params.to),
    cc: list(params.cc),
    bcc: list(params.bcc),
    subject,
    body: text(params.body),
    original: text(params.in_reply_to) ? { subject: withoutReplyPrefix(subject), from: null } : null,
  } satisfies MailPreview;
}

/**
 * Where each approval's card is: its message's thread (null: the main timeline).
 * `thread_root_id` is the run's conversation, which for a run asked in the main
 * timeline is its trigger, not a thread. No card yet: that conversation.
 */
export async function approvalCardThreads(db: Executor, rows: Pick<Approval, "id" | "messageId" | "threadRootId">[]) {
  const ids = [...new Set(rows.flatMap((r) => (r.messageId ? [r.messageId] : [])))];
  const cards = ids.length
    ? await db.select({ id: messages.id, threadId: messages.threadId }).from(messages).where(inArray(messages.id, ids))
    : [];
  const threadOf = new Map(cards.map((m) => [m.id, m.threadId]));
  return new Map(
    rows.map((r) => {
      const card = r.messageId && threadOf.has(r.messageId) ? r.messageId : null;
      return [r.id, card ? (threadOf.get(card) ?? null) : r.threadRootId] as const;
    }),
  );
}

/**
 * The card an agent's new approval joins instead of posting its own: the one holding a pending request of the same
 * agent in the same conversation (`threadRootId`: a thread, which for a run asked in the main timeline is its
 * trigger, so a reply under it lands on its card), or of the same run. Two top-level messages are two conversations,
 * even in one channel's main timeline: their requests never share a card. Each approval keeps its own row, hash and
 * audit; only the card is shared.
 */
export async function openApprovalCard(
  db: Executor,
  at: {
    orgId: string;
    agentId: string;
    channelId: string;
    threadRootId: string;
    runId: string;
    exceptId: string;
  },
  now = new Date(),
): Promise<string | null> {
  const [open] = await db
    .select({ messageId: approvals.messageId })
    .from(approvals)
    .innerJoin(messages, and(eq(messages.orgId, approvals.orgId), eq(messages.id, approvals.messageId)))
    .where(
      and(
        eq(approvals.orgId, at.orgId),
        eq(approvals.agentId, at.agentId),
        eq(approvals.status, "pending"),
        gt(approvals.expiresAt, now),
        ne(approvals.id, at.exceptId),
        eq(messages.channelId, at.channelId),
        or(eq(approvals.threadRootId, at.threadRootId), eq(approvals.runId, at.runId)),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(asc(approvals.createdAt))
    .limit(1);
  return open?.messageId ?? null;
}

/**
 * The waiting calls among `rows` that go together in one tap (the right hand's digest): `routineCall` by the row, and
 * a tool its own connection still lists as a plain write. A row does not say why its call asked, so the connection
 * has the last word: a tool an admin set to ask every time or turned off, one our rules or the judge would have ask,
 * one marked sensitive (our words, the catalog) or that its server says destroys, and one the connection no longer
 * lists, each stay on their own card whatever their name. SQL proven read-only needs no such word.
 */
export async function routineIds(db: Executor, rows: Approval[]): Promise<Set<string>> {
  const plain = rows.filter((r) => r.status === "pending" && routineCall(r));
  const out = new Set(plain.filter(readsSqlOnly).map((r) => r.id));
  const asked = plain.filter((r) => !out.has(r.id));
  const ids = [...new Set(asked.flatMap((r) => r.connectionId ?? []))];
  if (ids.length === 0) return out;
  const [connections, tools] = await Promise.all([
    db
      .select({
        id: connectorConnections.id,
        connector: connectorConnections.connector,
        label: connectorConnections.label,
        toolPrefix: connectorConnections.toolPrefix,
      })
      .from(connectorConnections)
      .where(and(inArray(connectorConnections.id, ids), isNull(connectorConnections.revokedAt))),
    db
      .select()
      .from(customTools)
      .where(and(inArray(customTools.connectionId, ids), isNull(customTools.removedAt))),
  ]);
  /** A connection and its tool as the agent calls it. */
  const vouched = new Set<string>();
  for (const c of connections) {
    const prefix = toolPrefixOfConnection(c);
    const names = isCustom(c)
      ? tools
          .filter(
            (t) =>
              t.connectionId === c.id &&
              (t.access === "read" || t.access === "write") &&
              t.suggestedAccess !== "approval" &&
              !t.sensitive &&
              t.destructiveHint !== true,
          )
          .map((t) => t.name)
      : Object.entries(CONNECTOR_CATALOG[c.connector]?.tools ?? {})
          .filter(([, tool]) => !tool.sensitive && !tool.ours)
          .map(([name]) => name);
    for (const name of names) vouched.add(`${c.id} ${exposedToolName(prefix, name)}`);
  }
  for (const r of asked) if (vouched.has(`${r.connectionId} ${r.tool}`)) out.add(r.id);
  return out;
}

/**
 * Views with their context (connector, issue); `trail` only when asked (one approval's details). `viewer` reads a card
 * of their own connection with its whole name; anyone else, and a view with no one viewer, as others read it.
 */
async function viewsOf(
  db: Database,
  rows: Approval[],
  canDecide: (row: Approval) => boolean,
  trail = false,
  viewer?: string,
) {
  const [contexts, cardThreads, routine] = await Promise.all([
    approvalContexts(db, rows, trail).catch(() => new Map<string, ApprovalContext>()),
    approvalCardThreads(db, rows).catch(() => new Map<string, string | null>()),
    routineIds(db, rows).catch(() => new Set<string>()),
  ]);
  return rows.map((r) => {
    const {
      trail: steps,
      own,
      ...context
    } = contexts.get(r.id) ?? {
      connector: null,
      connectorAccount: null,
      email: null,
      issue: null,
      trail: [],
    };
    const view = approvalView(r, canDecide(r), routine.has(r.id));
    const threadId = cardThreads.has(r.id) ? (cardThreads.get(r.id) ?? null) : view.threadId;
    if (own && own.userId === viewer) {
      context.connectorAccount = own.account;
      if (view.title.startsWith(`${own.stored}: `)) view.title = own.label + view.title.slice(own.stored.length);
    }
    return { ...view, threadId, ...context, ...(trail ? { trail: steps } : {}) };
  });
}

/** Top-level scalar inputs of an approved action ("pullNumber", "owner", "repo", "environment"…), short. */
export function scalarParams(params: Record<string, unknown>) {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(params ?? {}).slice(0, 20)) {
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 200);
  }
  return out;
}

export const approvalView = (a: Approval, canDecide = false, routine = false): ApprovalView => ({
  id: a.id,
  runId: a.runId,
  missionId: a.missionId ?? null,
  agentId: a.agentId,
  channelId: a.channelId,
  threadId: a.threadRootId,
  messageId: a.messageId,
  tool: a.tool,
  scope: a.scope,
  title: a.title,
  detail: a.detail,
  params: a.params,
  kind: a.tool,
  titleParams: scalarParams(a.params),
  status: a.status,
  expiresAt: a.expiresAt.toISOString(),
  createdAt: a.createdAt.toISOString(),
  decidedByUserId: a.decidedByUserId,
  decidedForUserId: a.decidedForUserId ?? null,
  decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
  supersededById: a.supersededById ?? null,
  reason: a.reason,
  canDecide: canDecide && a.status === "pending",
  ownerUserId: a.ownerUserId,
  ownerRoleId: a.ownerRoleId ?? null,
  executedAt: a.executedAt ? a.executedAt.toISOString() : null,
  result: resultOf(a),
  connector: null,
  connectorAccount: null,
  email: null,
  why: a.why.trim() || null,
  origin: approvalOriginOf(a.origin),
  issue: null,
  approveAlways: alwaysKindOf(a),
  runAt: a.runAt ? a.runAt.toISOString() : null,
  routineId: a.routineId,
  canCancel: canDecide && aheadLive(a) && a.status === "approved",
  afterIds: a.afterIds ?? [],
  canRunNow: canDecide && waitsItsTurn(a),
  approvers: a.approvers
    ? {
        label: a.approvers.label,
        requestedByUserId: a.approvers.requestedBy,
        requesterDecides: a.approvers.requesterDecides,
      }
    : null,
  routine,
});

/** What "Aprovar sempre" would keep for an approval: the kind the gateway offered on it (`rememberKinds`). */
const alwaysKindOf = (a: Pick<Approval, "approveAlways">): RememberedKind | null => rememberedKindOf(a.approveAlways);

/** Approved, not done yet, and asked after another run's requests: it may wait for them (`approval-order.ts`). */
const waitsItsTurn = (a: Pick<Approval, "status" | "executedAt" | "result" | "runAt" | "runId" | "afterIds">) =>
  a.status === "approved" &&
  !a.executedAt &&
  !a.result &&
  !a.runAt &&
  a.runId !== null &&
  (a.afterIds ?? []).length > 0;

/** An approval ahead that may still run: waiting for a person, or approved and not run yet. */
const aheadLive = (a: Pick<Approval, "runAt" | "status" | "executedAt">) =>
  a.runAt !== null && (a.status === "pending" || a.status === "approved") && !a.executedAt;

/**
 * Whether only admins decide it: `request_permission` turns a connector or a built-in on for good, which
 * is an admin's call like the agent's scopes (`setAgentScopes`); the agent's owner decides the others.
 */
export const adminsDecide = (approval: Pick<Approval, "tool">) => approval.tool === REQUEST_PERMISSION_TOOL;

const BROWSER_PROFILE_PREFIX = "browser-profile:";

/**
 * The keys that let someone decide any approval of its kind: `approve_actions`; for `request_permission`, the keys
 * that give the same access on the agent's page (`manage_agents`, and `manage_connectors` for a browser profile),
 * where `manage_agents` counts only on an agent it reaches (`managesAgent`, ADR 0085 addendum of 2026-11-17).
 */
export function decidingKeys(approval: Pick<Approval, "tool"> & Partial<Pick<Approval, "params">>): RolePermission[] {
  if (!adminsDecide(approval)) return ["approve_actions"];
  const permission = approval.params?.permission;
  return typeof permission === "string" && permission.startsWith(BROWSER_PROFILE_PREFIX)
    ? ["manage_agents", "manage_connectors"]
    : ["manage_agents"];
}

/** The agent an access request asks for (`adminsDecide`), as `managesAgent` reads it. */
type AskingAgent = Parameters<typeof managesAgent>[0];

/**
 * Whether `actorId` may decide `approval`: whoever holds its `decidingKeys` (admins; for an access request, only on
 * an agent they manage: `agent`, its agent, `managesAgent`), the agent's owner (`adminsDecide` aside), or for one
 * asked with `request_approval` the people it names instead of the owner (ADR 0126). The person whose request it was
 * never decides it, unless they approve by role (admins, the role it names). One in someone's own mailbox that someone
 * else asked (`required`) only that person decides.
 */
export function decides(
  approval: Pick<Approval, "ownerUserId" | "tool"> & Partial<Pick<Approval, "ownerRoleId" | "approvers" | "params">>,
  actorId: string,
  membership: Pick<Membership, "permissions" | "roleIds"> | null,
  agent: AskingAgent | null,
) {
  const named = approval.approvers;
  if (named?.required) return named.userIds.includes(actorId);
  if (
    decidingKeys(approval).every((key) => can(membership, key)) &&
    (!adminsDecide(approval) || (!!agent && managesAgent(agent, actorId, membership)))
  )
    return true;
  if (named?.requestedBy === actorId && !named.requesterDecides) return false;
  if (adminsDecide(approval)) return false;
  return named?.userIds.length
    ? named.userIds.includes(actorId)
    : ownsAgent(ownerOfApproval(approval), actorId, membership?.roleIds ?? []);
}

/** Who answered for its agent when it asked: a person or a role (`ownsAgent` reads it as an agent's). */
const ownerOfApproval = (
  a: Pick<Approval, "ownerUserId"> & Partial<Pick<Approval, "ownerRoleId">>,
): AgentOwnerFields => ({
  ownerUserId: a.ownerUserId,
  ownerRoleId: a.ownerRoleId ?? null,
});

/** The agents the access requests among `rows` ask for (`adminsDecide`), by id: what `decides` reads of each. */
async function askingAgents(db: Executor, orgId: string, rows: readonly Pick<Approval, "agentId" | "tool">[]) {
  const ids = [...new Set(rows.filter((r) => adminsDecide(r)).map((r) => r.agentId))];
  const found = ids.length
    ? await db
        .select({ id: agents.id, ...REACH_COLUMNS })
        .from(agents)
        .where(and(eq(agents.orgId, orgId), inArray(agents.id, ids)))
    : [];
  return new Map<string, AskingAgent>(found.map((a) => [a.id, a]));
}

/** `decides` as SQL over `approvals` (the sidebar's count). */
export const decidableBySql = (actorId: string) => sql`(case
  when coalesce((${approvals.approvers} ->> 'required')::boolean, false)
    then ${approvals.approvers} -> 'userIds' @> to_jsonb(${actorId}::text)
  when ${approvals.tool} = ${REQUEST_PERMISSION_TOOL}
    then exists (select 1 from ${agents} pa where pa.id = ${approvals.agentId} and pa.org_id = ${approvals.orgId}
        and ${managesAgentSql("pa", sql`${actorId}::text`)})
      and (coalesce(${approvals.params} ->> 'permission', '') not like ${`${BROWSER_PROFILE_PREFIX}%`}
        or ${maySql(approvals.orgId, actorId, "manage_connectors")})
  when ${maySql(approvals.orgId, actorId, "approve_actions")} then true
  when coalesce(${approvals.approvers} ->> 'requestedBy', '') = ${actorId}
    and not coalesce((${approvals.approvers} ->> 'requesterDecides')::boolean, false) then false
  when jsonb_array_length(coalesce(${approvals.approvers} -> 'userIds', '[]'::jsonb)) > 0
    then ${approvals.approvers} -> 'userIds' @> to_jsonb(${actorId}::text)
  else coalesce(${ownsAgentSql("approvals", sql`${actorId}::text`)}, false) end or ${coveredBySql(actorId)})`;

/** `coveredFor` as SQL: someone `actorId` covers now is asked this approval personally (ADR 0139). */
const coveredBySql = (actorId: string) => sql`(not coalesce((${approvals.approvers} ->> 'required')::boolean, false)
  and ${approvals.tool} <> ${REQUEST_PERMISSION_TOOL}
  and ${approvals.requestedByUserId} is distinct from ${actorId}
  and coalesce(${approvals.approvers} ->> 'requestedBy', '') <> ${actorId}
  and exists (select 1 from ${approvalCovers} join ${organizationMembers}
      on ${organizationMembers.orgId} = ${approvalCovers.orgId} and ${organizationMembers.userId} = ${approvalCovers.fromUserId}
    where ${approvalCovers.orgId} = ${approvals.orgId} and ${approvalCovers.toUserId} = ${actorId}
      and (${approvalCovers.endsAt} is null or ${approvalCovers.endsAt} > now())
      and (${approvalCovers.mode} = 'always' or (${organizationMembers.availability} = 'out'
        and (${organizationMembers.statusUntil} is null or ${organizationMembers.statusUntil} > now())))
      and (${approvalCovers.risky} or not ${approvals.highRisk})
      and not (coalesce(${approvals.approvers} ->> 'requestedBy', '') = ${approvalCovers.fromUserId}
        and not coalesce((${approvals.approvers} ->> 'requesterDecides')::boolean, false))
      and (case when jsonb_array_length(coalesce(${approvals.approvers} -> 'userIds', '[]'::jsonb)) > 0
        then ${approvals.approvers} -> 'userIds' @> to_jsonb(${approvalCovers.fromUserId})
        else ${approvals.ownerUserId} is not distinct from ${approvalCovers.fromUserId} end)))`;

type Coverable = Pick<Approval, "ownerUserId" | "tool"> &
  Partial<Pick<Approval, "approvers" | "params" | "requestedByUserId" | "highRisk">>;

/** Whether `userId` is asked this approval personally: as the agent's owner, or named by `request_approval`. */
const askedPersonally = (approval: Coverable, userId: string) => {
  const named = approval.approvers;
  if (named?.requestedBy === userId && !named.requesterDecides) return false;
  return named?.userIds.length ? named.userIds.includes(userId) : approval.ownerUserId === userId;
};

/**
 * The person `actorId` decides this approval for, covering them (ADR 0139), or null: one of `covers` (in force now)
 * makes `actorId` cover someone asked it personally, it isn't `actorId`'s own request, and it is no high-risk action
 * unless that cover takes them. Never a mailbox's action (only its owner decides) nor access for good (admins'),
 * whatever the cover; what someone may decide only through a workspace-wide key isn't theirs to pass on.
 */
export function coveredFor(approval: Coverable, actorId: string, covers: ActiveCover[]): string | null {
  if (approval.approvers?.required || adminsDecide(approval)) return null;
  if (approval.requestedByUserId === actorId || approval.approvers?.requestedBy === actorId) return null;
  const cover = covers.find(
    (c) =>
      c.toUserId === actorId && (c.risky || approval.highRisk === false) && askedPersonally(approval, c.fromUserId),
  );
  return cover?.fromUserId ?? null;
}

type Askable = Pick<Approval, "orgId" | "ownerUserId"> &
  Partial<
    Pick<Approval, "ownerRoleId" | "agentId" | "tool" | "approvers" | "params" | "requestedByUserId" | "highRisk">
  >;

/**
 * The people asked to decide (the card's badge, the live Aprovações list): whoever holds its `decidingKeys` (ADR 0085)
 * and the agent's owner (`adminsDecide` aside); for one asked with `request_approval`, the people it names instead,
 * without the person whose request it was unless they approve by role (ADR 0126). Nobody left: the admins. One that
 * `required` its people: only them. `notified`: who is told (inbox, push, email), `notifiedIds`.
 */
export async function approverIds(db: Database, approval: Askable, notified = false) {
  const keys = decidingKeys({ tool: approval.tool ?? "", params: approval.params ?? {} });
  // An access request's `manage_agents` counts on its own agent only (`managesAgentSql`, ADR 0085 addendum of
  // 2026-11-17): a private agent's request never goes to who merely holds the key.
  const holds = (key: RolePermission) =>
    key === "manage_agents" && approval.agentId
      ? sql`exists (select 1 from ${agents} pa where pa.id = ${approval.agentId} and pa.org_id = ${approval.orgId}
          and ${managesAgentSql("pa", sql`${organizationMembers.userId}`)})`
      : maySql(approval.orgId, organizationMembers.userId, key);
  const members = await db
    .select({
      userId: organizationMembers.userId,
      admin: sql<boolean>`(${sql.join(keys.map(holds), sql` and `)})`,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.orgId, approval.orgId), accountInUse));
  const admins = members.filter((m) => m.admin).map((m) => m.userId);
  const member = new Set(members.map((m) => m.userId));
  const named = approval.approvers;
  if (named?.required) return named.userIds.filter((id) => member.has(id));
  // Its owner, or whoever holds its owner role now (ADR 0085, addendum of 2026-11-21): a role is asked as a person is.
  const owners = adminsDecide({ tool: approval.tool ?? "" })
    ? []
    : (await agentOwnerIds(db, approval.orgId, ownerOfApproval(approval))).filter((id) => member.has(id));
  const ids = new Set(
    named?.userIds.length
      ? named.userIds.filter((id) => member.has(id))
      : [...(notified && owners.length > 0 ? [] : admins), ...owners],
  );
  const requester = named?.requestedBy;
  if (requester && !named.requesterDecides && !admins.includes(requester)) ids.delete(requester);
  // Whoever covers someone asked it personally is asked too (ADR 0139); while that person is out, only them.
  const coverable = { ...approval, tool: approval.tool ?? "" };
  const personal = [...ids].filter((id) => askedPersonally(coverable, id));
  for (const cover of await activeCoversFrom(db, approval.orgId, personal)) {
    if (!member.has(cover.toUserId) || !coveredFor(coverable, cover.toUserId, [cover])) continue;
    ids.add(cover.toUserId);
    if (cover.fromOut) ids.delete(cover.fromUserId);
  }
  return ids.size > 0 ? [...ids] : admins;
}

/**
 * Who is told an approval waits (inbox, its sound, push, email): the agent's responsável alone when it has one (and
 * whoever covers them), or everyone holding its owner role, as its picker promises; the admins only for an agent with
 * neither. Admins still find it in
 * Aprovações and may decide it, silently.
 */
export const notifiedIds = (db: Database, approval: Askable) => approverIds(db, approval, true);

/** People's names as a card says who decides: "Ana, Bruno e Caio" is the app's; here "Ana, Bruno, Caio +2". */
export const namesLabel = (names: string[]) =>
  names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");

/** These people's names, in their order (those gone left out). */
export async function namesOf(db: Executor, ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return ids.map((id) => byId.get(id)).filter((n): n is string => !!n);
}

/** Who decided, as the run that asked reads it: "Bruno (covering Ana)" when they decided in someone's name. */
export async function deciderName(db: Executor, byUserId: string, forUserId: string | null) {
  const [by = "a person", covered] = await Promise.all([
    namesOf(db, [byUserId]).then((n) => n[0]),
    forUserId ? namesOf(db, [forUserId]).then((n) => n[0]) : undefined,
  ]);
  return covered ? `${by} (covering ${covered})` : by;
}

/**
 * The agents changed owner: their approvals still waiting, or approved ahead and not run, are decided against the new
 * owner (a person or a role) from now on (`ownerUserId`/`ownerRoleId`, which `decides` and `approverIds` read), and the
 * inbox follows: the old owner's items go, the new owner's come. A `request_approval` that asked the owner (no one
 * named) says the new names.
 */
export async function repointApprovals(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  agentIds: string[],
  owner: AgentOwnerFields,
) {
  if (agentIds.length === 0) return;
  const { ownerUserId, ownerRoleId } = owner;
  const rows = await deps.db
    .update(approvals)
    .set({ ownerUserId, ownerRoleId })
    .where(
      and(
        eq(approvals.orgId, orgId),
        inArray(approvals.agentId, agentIds),
        sql`(${approvals.ownerUserId} is distinct from ${ownerUserId} or ${approvals.ownerRoleId} is distinct from ${ownerRoleId}::uuid)`,
        or(
          eq(approvals.status, "pending"),
          and(eq(approvals.status, "approved"), isNull(approvals.executedAt), sql`${approvals.runAt} is not null`),
        ),
      ),
    )
    .returning();
  const told = new Set<string>();
  for (const row of rows) {
    if (row.status !== "pending") continue;
    let current = row;
    if (row.approvers && row.approvers.userIds.length === 0) {
      const label = namesLabel(await namesOf(deps.db, await approverIds(deps.db, row)));
      const approvers = { ...row.approvers, label };
      await deps.db.update(approvals).set({ approvers }).where(eq(approvals.id, row.id));
      current = { ...row, approvers };
    }
    await resolveApprovalNotifications(deps, current).catch(() => {});
    // The new owner is told; with none left, the admins.
    await notifyNewcomers(deps, current).catch(() => {});
    for (const id of await notifiedIds(deps.db, current).catch(() => [])) told.add(id);
  }
  await queueApprovalsDigest(deps.db, orgId, [...told]).catch(() => {});
}

/**
 * `userId` left the workspace: the actions in their mailboxes and personal connections that may still run (waiting
 * for a person, or approved and not run) never run, and a run waiting on one hears it. In the transaction that
 * removes them; then `publishApproval` each row returned.
 */
export async function cancelMailboxApprovals(tx: Executor, orgId: string, userId: string, actorId: string) {
  const mailboxes = await tx
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(and(eq(mailAccounts.orgId, orgId), eq(mailAccounts.createdByUserId, userId)));
  const connections = await tx
    .select({ id: connectorConnections.id })
    .from(connectorConnections)
    .where(and(eq(connectorConnections.orgId, orgId), eq(connectorConnections.ownerUserId, userId)));
  const theirs = [...mailboxes, ...connections].map((r) => r.id);
  if (theirs.length === 0) return [];
  const rows = await tx
    .update(approvals)
    .set({ status: "canceled", decidedByUserId: actorId, decidedAt: new Date() })
    .where(
      and(
        eq(approvals.orgId, orgId),
        inArray(approvals.connectionId, theirs),
        isNull(approvals.executedAt),
        inArray(approvals.status, ["pending", "approved"]),
      ),
    )
    .returning();
  for (const row of rows) {
    await enqueueResume(tx, row);
    await settleAheadRoutine(tx, row);
    await auditDecision(tx, row, actorId);
  }
  return rows;
}

/** Params that name what an action is about (a message, a recipient, a pull request), besides any `…_id`/`…Id`. */
const TARGET_KEYS = new Set([
  "to",
  "channel",
  "owner",
  "repo",
  "name",
  "number",
  "pullNumber",
  "pull_number",
  "issue_number",
  "path",
  "branch",
  "environment",
]);
const isTargetKey = (key: string) => TARGET_KEYS.has(key) || /(_id|Id)$/.test(key);

/**
 * What an action is about, as one comparable string: its target params, one level into objects (a tool that runs
 * another by name keeps them under `arguments`). Null when it names nothing: such an action is never taken for another.
 */
export function approvalTarget(params: Record<string, unknown>): string | null {
  const target: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (isTargetKey(k)) target[k] = v;
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [ik, iv] of Object.entries(v as Record<string, unknown>))
        if (isTargetKey(ik)) target[`${k}.${ik}`] = iv;
    }
  }
  return Object.keys(target).length > 0 ? canonicalJson(target) : null;
}

/**
 * The agent asked for the same action again in a later run (same tool, connection, card and target), as when it
 * reworded an email it was told to fix: its older requests still waiting on that card (`openApprovalCard` joined them:
 * one conversation) are canceled as replaced by `newer` (`supersededById`). Their runs read that, not a refusal, and may
 * end quietly (`mootRequests`). Two calls of one run, an action prepared ahead and an action naming no target are never
 * replaced. In the transaction that links `newer` to its card; then `publishApproval` each row returned.
 */
export async function supersedeApprovals(tx: Executor, newer: Approval): Promise<Approval[]> {
  const target = approvalTarget(newer.params);
  if (!target || !newer.runId || !newer.messageId || newer.runAt) return [];
  const older = await tx
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.orgId, newer.orgId),
        eq(approvals.agentId, newer.agentId),
        eq(approvals.tool, newer.tool),
        newer.connectionId ? eq(approvals.connectionId, newer.connectionId) : isNull(approvals.connectionId),
        eq(approvals.messageId, newer.messageId),
        eq(approvals.status, "pending"),
        isNull(approvals.runAt),
        ne(approvals.id, newer.id),
        ne(approvals.runId, newer.runId),
        lt(approvals.createdAt, newer.createdAt),
      ),
    );
  const ids = older.filter((r) => approvalTarget(r.params) === target).map((r) => r.id);
  if (ids.length === 0) return [];
  const rows = await tx
    .update(approvals)
    .set({ status: "canceled", supersededById: newer.id, decidedAt: new Date() })
    .where(and(inArray(approvals.id, ids), eq(approvals.status, "pending")))
    .returning();
  for (const row of rows) {
    if (row.runId) await markReplaced(tx, row.runId, row.id);
    await enqueueResume(tx, row);
    await auditDecision(tx, row, null);
  }
  await wakeLine(tx, rows);
  return rows;
}

/** A replaced request's run, still waiting on it, reads that it was replaced and may end without a word. */
async function markReplaced(tx: Executor, runId: string, approvalId: string) {
  const [run] = await tx
    .select({ transcript: agentRuns.transcript })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, ["waiting_approval", "waiting_input"])));
  if (!run) return;
  const text = `Replaced by your newer request for the same action in a later turn: this one was not done and nobody waits on it. If nothing else is left to do or say, ${quietEnd(run)}.`;
  await tx
    .update(agentRuns)
    .set({ transcript: withMootRequest(approvalId, text) })
    .where(eq(agentRuns.id, runId));
}

/** Tells the channel and every approver about an approval (card in the chat, badge on the Approvals screen). */
export async function publishApproval(
  deps: { db: Database; pubsub?: PubSub },
  approval: Approval,
  type: "approval.created" | "approval.decided",
) {
  const [view = approvalView(approval)] = await viewsOf(deps.db, [approval], () => false);
  await publishChannelEvent(deps.pubsub, { type, channelId: approval.channelId, approval: view });
  const deciders = await approverIds(deps.db, approval);
  for (const userId of deciders) {
    const [theirs = view] = approval.approvers?.personal
      ? await viewsOf(deps.db, [approval], () => false, false, userId)
      : [view];
    await publishUserEvent(deps.pubsub, approval.orgId, userId, {
      type,
      approval: {
        ...theirs,
        canDecide: true,
        canCancel: approval.status === "approved" && aheadLive(approval),
        canRunNow: waitsItsTurn(approval),
      },
    });
  }
  // The inbox: waiting for whoever is told (`notifiedIds`); out of it once decided or expired.
  if (type === "approval.created" && approval.status === "pending") {
    const told = await notifiedIds(deps.db, approval);
    await notifyApproval(deps, approval, told).catch(() => {});
    // Several waiting on one of them: the right hand sums them up on one card, a little later.
    await queueApprovalsDigest(deps.db, approval.orgId, told).catch(() => {});
  } else if (type === "approval.decided") {
    await resolveApprovalNotifications(deps, approval).catch(() => {});
  }
}

/** What a decision wakes: the run that asked. */
async function enqueueResume(tx: Executor, row: Pick<Approval, "id" | "orgId" | "runId">) {
  if (row.runId) {
    await enqueue(tx, {
      orgId: row.orgId,
      kind: "agent_run.execute",
      payload: { runId: row.runId },
      dedupeKey: `agent_run.execute:${row.runId}:approval:${row.id}`,
      maxAttempts: 4,
    });
  }
}

/**
 * Approves or refuses a pending approval. Only the agent's owner and org
 * admins may (a `request_permission` one: admins only, `adminsDecide`). The decision and the job that resumes the run commit together;
 * the run then executes exactly the hashed action, or tells the model it was
 * refused (with the reason). `always` ("Aprovar sempre", only where the
 * approval offers it) also keeps its kind for good in the same transaction:
 * the agent's next calls of that kind run without asking; on a routine's card
 * ("Sempre nesta rotina"), that routine's next runs only.
 */
export async function decideApproval(
  /** `memory`: how the lesson from a refusal is judged (context/items.ts `MemoryJudging`). */
  deps: { db: Database; pubsub: PubSub; now?: () => Date; memory?: MemoryJudging },
  actorId: string,
  orgId: string,
  approvalId: string,
  /** `via`: the card message it was decided from (the audit's "via", `approvalCardVia`). */
  input: { decision: "approve" | "refuse"; reason?: string; always?: boolean; via?: string },
): Promise<ApprovalView> {
  const { db } = deps;
  const at = deps.now?.() ?? new Date();
  const [current] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, approvalId), eq(approvals.orgId, orgId)));
  if (!current) throw new NotFoundError("Approval not found");
  const membership = await requirePermission(db, actorId, current.orgId, "read");
  const asking = await askingAgents(db, orgId, [current]);
  const direct = decides(current, actorId, membership, asking.get(current.agentId) ?? null);
  const forUserId = direct ? null : coveredFor(current, actorId, await activeCoversTo(db, orgId, actorId, at));
  if (!direct && !forUserId) {
    throw new ForbiddenError(
      current.approvers?.required
        ? `Only ${current.approvers.label} can decide this: it's their mailbox`
        : current.approvers?.requestedBy === actorId
          ? "You asked for this: someone else approves it"
          : adminsDecide(current)
            ? "Only an admin who manages agents can give an agent new access"
            : current.approvers?.userIds.length
              ? `Only ${current.approvers.label} or an admin can decide this`
              : "Only the agent's owner or an admin can decide this",
    );
  }
  const via = await approvalCardVia(db, orgId, input.via, approvalId);
  const kind = input.always ? alwaysKindOf(current) : null;
  // Approving for good outlives the cover and changes the agent for everyone: never in someone else's name. A card
  // that names who decides (someone's own mailbox) is kept for good by them alone: an admin's rule would take their
  // say away on every later call.
  const namedElsewhere = current.approvers ? !current.approvers.userIds.includes(actorId) : false;
  if (input.always && (input.decision !== "approve" || !kind || forUserId || namedElsewhere)) {
    throw new ConflictError("This request can't be approved for good", "approval.always_unavailable");
  }

  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(approvals).where(eq(approvals.id, approvalId)).for("update");
    if (row?.status !== "pending") return { error: "This request was already decided" as const };
    const expired = row.expiresAt <= at;
    const [updated] = await tx
      .update(approvals)
      .set(
        expired
          ? { status: "expired" }
          : {
              status: input.decision === "approve" ? "approved" : "refused",
              decidedByUserId: actorId,
              decidedForUserId: forUserId,
              decidedAt: at,
              reason: input.reason?.trim().slice(0, APPROVAL_REASON_MAX) || null,
            },
      )
      .where(eq(approvals.id, approvalId))
      .returning();
    await enqueueResume(tx, row);
    const always = !expired && kind ? { connectionId: row.connectionId, ...kind } : null;
    if (always) {
      // The agent changed hands since it asked: what its old owner approves for good is dropped with the handover
      // (`dropAgentRules`), so they make none now. Locked, so a handover running now waits for this rule and drops it.
      const [agent] = await tx
        .select({ ownerUserId: agents.ownerUserId, ownerRoleId: agents.ownerRoleId })
        .from(agents)
        .where(eq(agents.id, row.agentId))
        .for("share");
      const changedHands =
        agent?.ownerUserId !== row.ownerUserId || (agent?.ownerRoleId ?? null) !== (row.ownerRoleId ?? null);
      if (
        !can(membership, "approve_actions") &&
        changedHands &&
        !(agent && ownsAgent(agent, actorId, membership?.roleIds ?? []))
      ) {
        throw new ConflictError("This request can't be approved for good", "approval.always_unavailable");
      }
      if (!always.routineId) {
        await addApprovalRules(tx, { orgId, agentId: row.agentId, connectionId: always.connectionId }, always, actorId);
      } else if (
        !(await addRoutineOwnActions(
          tx,
          { orgId, agentId: row.agentId, routineId: always.routineId },
          always.actions,
          actorId,
        ))
      ) {
        throw new ConflictError("This request can't be approved for good", "approval.always_unavailable");
      }
    }
    if (updated?.status === "refused") await settleAheadRoutine(tx, updated);
    if (updated) await auditDecision(tx, updated, expired ? null : actorId, always, via);
    // Not approved: what the agent asked after it on its card no longer waits for it. An approved one wakes them once
    // its run has done it (`approval-order.ts`).
    if (updated && updated.status !== "approved") await wakeLine(tx, [updated]);
    return expired ? { error: "This request has expired" as const, row: updated } : { row: updated };
  });
  if (outcome.row) await publishApproval(deps, outcome.row, "approval.decided");
  if (outcome.error || !outcome.row) throw new ConflictError(outcome.error ?? "approval vanished");
  // A refusal (with its reason) becomes an outcome and a lesson for the agent.
  if (outcome.row.status === "refused") await learnFromRefusal(deps, outcome.row).catch(() => null);
  // The person who decided may decide it: an action they approved ahead, they may still withdraw.
  const [view = approvalView(outcome.row, true)] = await viewsOf(db, [outcome.row], () => true, false, actorId);
  return view;
}

/**
 * "Aprovar tudo" / "Agora não para todos" on a card: decides exactly these approvals (the items the card listed
 * when the person clicked, never one that joined since), each its own row, decision and audit. Only the items
 * this person may decide are decided (`decides`, per item); the rest come back in `skipped`. Each run that
 * asked resumes once, after all of its items here are decided in the same transaction. `only: "routine"` (the right
 * hand's digest) decides the plain ones among them (`routineIds`) and leaves every other waiting, in `skipped` too.
 */
export async function decideApprovals(
  deps: { db: Database; pubsub: PubSub; now?: () => Date; memory?: MemoryJudging },
  actorId: string,
  orgId: string,
  input: { ids: string[]; decision: "approve" | "refuse"; reason?: string; via?: string; only?: "routine" },
): Promise<{ approvals: ApprovalView[]; skipped: string[] }> {
  const { db } = deps;
  const at = deps.now?.() ?? new Date();
  const ids = [...new Set(input.ids)];
  const vias = new Map<string, string | null>();
  if (input.via) for (const id of ids) vias.set(id, await approvalCardVia(db, orgId, input.via, id));
  const membership = await requirePermission(db, actorId, orgId, "read");
  const covers = await activeCoversTo(db, orgId, actorId, at);
  // The agents of the access requests among them, once their rows are read (`decides`).
  let asking = new Map<string, AskingAgent>();
  const direct = (r: Approval) => decides(r, actorId, membership, asking.get(r.agentId) ?? null);
  const forUserOf = (r: Approval) => (direct(r) ? null : coveredFor(r, actorId, covers));
  const allowed = (r: Approval) => direct(r) || forUserOf(r) !== null;
  /** Some still wait and none is this person's to decide. */
  let theirs = false;
  const decided = await db.transaction(async (tx) => {
    const rows = ids.length
      ? await tx
          .select()
          .from(approvals)
          .where(and(eq(approvals.orgId, orgId), inArray(approvals.id, ids), eq(approvals.status, "pending")))
          .orderBy(asc(approvals.createdAt))
          .for("update")
      : [];
    const out: Approval[] = [];
    const resumed = new Set<string>();
    asking = await askingAgents(tx, orgId, rows);
    const mine = rows.filter(allowed);
    theirs = rows.length > 0 && mine.length === 0;
    const routine = input.only ? await routineIds(tx, mine) : null;
    for (const row of routine ? mine.filter((r) => routine.has(r.id)) : mine) {
      const expired = row.expiresAt <= at;
      const [updated] = await tx
        .update(approvals)
        .set(
          expired
            ? { status: "expired" }
            : {
                status: input.decision === "approve" ? "approved" : "refused",
                decidedByUserId: actorId,
                decidedForUserId: forUserOf(row),
                decidedAt: at,
                reason: input.reason?.trim().slice(0, APPROVAL_REASON_MAX) || null,
              },
        )
        .where(eq(approvals.id, row.id))
        .returning();
      if (!updated) continue;
      await auditDecision(tx, updated, expired ? null : actorId, null, vias.get(row.id) ?? null);
      if (updated.status === "refused") await settleAheadRoutine(tx, updated);
      if (!row.runId || !resumed.has(row.runId)) await enqueueResume(tx, row);
      if (row.runId) resumed.add(row.runId);
      out.push(updated);
    }
    await wakeLine(
      tx,
      out.filter((r) => r.status !== "approved"),
    );
    return out;
  });
  if (theirs) throw new ForbiddenError("Only the agent's owner or an admin can decide this");
  for (const row of decided) await publishApproval(deps, row, "approval.decided");
  for (const row of decided) {
    if (row.status === "refused") await learnFromRefusal(deps, row).catch(() => null);
  }
  const done = new Set(decided.map((r) => r.id));
  return {
    approvals: await viewsOf(db, decided, () => false, false, actorId),
    skipped: ids.filter((id) => !done.has(id)),
  };
}

/**
 * "Rodar este agora": an approved action waiting its turn behind another run's requests (`approval-order.ts`) runs
 * without waiting for them, with the rest of its run's actions still to do. Whoever may decide it may (`decides`, or a
 * cover). Its run wakes at once; the audit keeps who and what it no longer waited for.
 */
export async function runApprovalNow(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  orgId: string,
  approvalId: string,
): Promise<ApprovalView> {
  const { db } = deps;
  const [current] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, approvalId), eq(approvals.orgId, orgId)));
  if (!current) throw new NotFoundError("Approval not found");
  const membership = await requirePermission(db, actorId, orgId, "read");
  const asking = await askingAgents(db, orgId, [current]);
  const direct = decides(current, actorId, membership, asking.get(current.agentId) ?? null);
  if (!direct && !coveredFor(current, actorId, await activeCoversTo(db, orgId, actorId))) {
    throw new ForbiddenError("Only the agent's owner or an admin can decide this");
  }
  const runId = current.runId;
  if (!runId || !waitsItsTurn(current)) {
    throw new ConflictError("This request isn't waiting for another one", "approval.not_waiting");
  }
  const rows = await db.transaction(async (tx) => {
    const freed = await tx
      .update(approvals)
      .set({ afterIds: [] })
      .where(
        and(
          eq(approvals.runId, runId),
          eq(approvals.status, "approved"),
          isNull(approvals.executedAt),
          isNull(approvals.result),
          isNull(approvals.runAt),
          sql`cardinality(${approvals.afterIds}) > 0`,
        ),
      )
      .returning();
    await enqueue(tx, {
      orgId,
      kind: "agent_run.execute",
      payload: { runId },
      dedupeKey: `agent_run.execute:${runId}:run-now:${approvalId}`,
      maxAttempts: 4,
    });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "approval.run_now",
      target: { type: "approval", id: current.id },
      details: {
        tool: current.tool,
        agentId: current.agentId,
        title: current.title,
        after: current.afterIds,
      },
      runId,
      channelId: current.channelId,
    });
    return freed;
  });
  for (const row of rows) await publishApproval(deps, row, "approval.decided").catch(() => {});
  const fresh = rows.find((r) => r.id === current.id) ?? { ...current, afterIds: [] };
  const [view = approvalView(fresh, true)] = await viewsOf(db, [fresh], () => true, false, actorId);
  return view;
}

/** Why a request no longer asks, for `releaseUnasked`: the agent's level, or the tool's. */
const RELEASED = {
  agent: "your approvals level changed: you no longer ask before this",
  tool: "this tool no longer asks for approval",
} as const;

/**
 * The agents' or a connection's tools changed so that requests still waiting would no longer ask (an agent set to
 * "Nunca perguntar", a tool moved off "Pede sua aprovação"): each is canceled, nothing is done, and its run wakes and
 * reads that it may call it again, now without a card. Never auto-approved: the agent redoes the call as things are
 * now. `agentIds`: runs' requests of those agents, if they now never ask, except a tool whose job is asking.
 * `connectionId`: a person's runs' requests of those tools (`tools`, under the connection's `prefix`) whose agent asks
 * only for what is marked to ask, except one sensitive by its name.
 */
export async function releaseUnasked(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  orgId: string,
  which: { agentIds: string[] } | { connectionId: string; prefix: string; tools: string[] },
): Promise<Approval[]> {
  const byAgent = "agentIds" in which;
  const tools = byAgent ? [] : which.tools.map((t) => exposedToolName(which.prefix, t));
  if (byAgent ? which.agentIds.length === 0 : which.tools.length === 0) return [];
  const rows = await deps.db.transaction(async (tx) => {
    const waiting = await tx
      .select({ approval: approvals })
      .from(approvals)
      .innerJoin(agents, and(eq(agents.orgId, approvals.orgId), eq(agents.id, approvals.agentId)))
      .where(
        and(
          eq(approvals.orgId, orgId),
          eq(approvals.status, "pending"),
          isNotNull(approvals.runId),
          byAgent
            ? and(inArray(approvals.agentId, which.agentIds), eq(agents.approvalsLevel, "never"))
            : and(
                eq(approvals.connectionId, which.connectionId),
                inArray(approvals.tool, tools),
                isNull(approvals.origin),
                eq(agents.approvalsLevel, "risky"),
              ),
        ),
      );
    const free = waiting
      .map((r) => r.approval)
      .filter((a) => {
        const tool = { name: a.tool, scope: a.scope, connectionId: a.connectionId };
        return byAgent ? !asksByChoice(tool) : !isSensitive({ ...tool, sensitive: false });
      })
      .map((a) => a.id);
    if (free.length === 0) return [];
    const canceled = await tx
      .update(approvals)
      .set({ status: "canceled", decidedByUserId: actorId, decidedAt: new Date() })
      .where(and(inArray(approvals.id, free), eq(approvals.status, "pending")))
      .returning();
    const why = byAgent ? RELEASED.agent : RELEASED.tool;
    for (const row of canceled) {
      if (row.runId) {
        await tx
          .update(agentRuns)
          .set({
            transcript: withMootRequest(
              row.id,
              `Not done, and nobody needs to approve it any more: ${why}. If it still makes sense, call it again now; it runs without asking.`,
            ),
          })
          .where(and(eq(agentRuns.id, row.runId), inArray(agentRuns.status, ["waiting_approval", "waiting_input"])));
      }
      await enqueueResume(tx, row);
      await settleAheadRoutine(tx, row);
      await auditDecision(tx, row, actorId);
    }
    await wakeLine(tx, canceled);
    return canceled;
  });
  for (const row of rows) await publishApproval(deps, row, "approval.decided").catch(() => {});
  return rows;
}

/**
 * An approval's ending in the audit log: the person who approved or refused it, or the system when it
 * expired unanswered. The action it then ran is the agent's own row (`tool.call`, agent-audit.ts). A card of a
 * person's own connection names it as others do (`auditLabel`), its current name when it was renamed since; anyone
 * else reads only that name and the agent (`listAudit`).
 */
async function auditDecision(
  tx: Executor,
  row: Approval,
  personId: string | null,
  always: (RememberedKind & { connectionId: string | null }) | null = null,
  via: string | null = null,
) {
  const [c] = row.connectionId
    ? await tx
        .select({
          label: connectorConnections.label,
          accountLabel: connectorConnections.accountLabel,
          ownerUserId: connectorConnections.ownerUserId,
        })
        .from(connectorConnections)
        .where(eq(connectorConnections.id, row.connectionId))
    : [];
  // A card opened before its connection was renamed starts with a name no longer known: the tool stands for the rest.
  const title =
    !c?.ownerUserId || row.title.startsWith(`${auditLabel(c)}: `) ? row.title : `${auditLabel(c)}: ${row.tool}`;
  return recordAudit(tx, {
    orgId: row.orgId,
    actor: personId ? { type: "person", id: personId } : { type: "system", id: null },
    action: `approval.${row.status}`,
    target: { type: "approval", id: row.id },
    details: {
      tool: row.tool,
      agentId: row.agentId,
      title,
      ...(row.reason ? { reason: row.reason } : {}),
      ...(always ? { always } : {}),
      ...(via ? { via } : {}),
      ...(c?.ownerUserId ? { label: auditLabel(c), personalOf: c.ownerUserId } : {}),
    },
    runId: row.runId,
    channelId: row.channelId,
    onBehalfOfUserId: personId ? row.decidedForUserId : null,
  });
}

/**
 * Marks pending approvals past their deadline as expired and resumes their runs (worker, every minute), and actions
 * approved ahead that didn't run by their time and grace (a routine paused or moved, a run too late): from then on
 * their run asks a person again.
 */
export async function expireApprovals(deps: { db: Database; pubsub: PubSub }, now = new Date()) {
  const expired = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(approvals)
      .set({ status: "expired" })
      .where(and(eq(approvals.status, "pending"), lt(approvals.expiresAt, now)))
      .returning();
    for (const row of rows) {
      await enqueueResume(tx, row);
      await auditDecision(tx, row, null);
    }
    await wakeLine(tx, rows);
    const lapsed = await tx
      .update(approvals)
      .set({ status: "expired" })
      .where(
        and(
          eq(approvals.status, "approved"),
          isNull(approvals.executedAt),
          lt(approvals.runAt, new Date(now.getTime() - AHEAD_GRACE_MS)),
        ),
      )
      .returning();
    for (const row of lapsed) await auditDecision(tx, row, null);
    return [...rows, ...lapsed];
  });
  for (const row of expired) await publishApproval(deps, row, "approval.decided");
  await resolveStaleApprovalNotifications(deps).catch(() => {});
  // The same minute's safety net for runs waiting their turn behind a request whose run ended (`approval-order.ts`).
  await resumeHeldRuns(deps.db, now).catch(() => 0);
  return expired.length;
}

/**
 * An approval's notification left waiting after the request closed (a row canceled in place before each close told
 * the inbox, a crash between the close and the inbox): out of the inbox, or on to the card's next request still
 * waiting, so no conversation says a request waits when Approvals has none.
 */
export async function resolveStaleApprovalNotifications(deps: { db: Database; pubsub?: PubSub }) {
  const stale = await deps.db
    .selectDistinct({ id: approvals.id, orgId: approvals.orgId, messageId: approvals.messageId })
    .from(notifications)
    .innerJoin(
      approvals,
      and(
        eq(approvals.orgId, notifications.orgId),
        sql`${notifications.source}->>'approvalId' = ${approvals.id}::text`,
      ),
    )
    .where(
      and(
        eq(notifications.kind, "approval"),
        eq(notifications.waiting, true),
        isNull(notifications.doneAt),
        ne(approvals.status, "pending"),
      ),
    );
  for (const row of stale) await resolveApprovalNotifications(deps, row);
  return stale.length;
}

/**
 * A one-off whose every action approved ahead was refused or withdrawn has nothing left to do at its time: it no
 * longer fires. A recurring routine keeps its schedule.
 */
async function settleAheadRoutine(tx: Executor, row: Pick<Approval, "orgId" | "routineId">) {
  if (!row.routineId) return;
  await tx
    .update(routines)
    .set({ active: false, nextRunAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(routines.orgId, row.orgId),
        eq(routines.id, row.routineId),
        eq(routines.triggerType, "once"),
        eq(routines.active, true),
        sql`not exists (select 1 from ${approvals} a where a.routine_id = ${row.routineId}
          and a.executed_at is null and a.status in ('pending', 'approved'))`,
      ),
    );
}

/**
 * Withdraws the actions approved ahead `where` picks that may still run (waiting for a person, or approved and not
 * run): they never run, a run still waiting on one hears it was canceled, and their cards update. `settle`: their
 * one-offs stop too (`settleAheadRoutine`).
 */
async function withdrawAhead(
  deps: { db: Database; pubsub: PubSub },
  where: SQL | undefined,
  actorId: string | null,
  settle: boolean,
) {
  const rows = await deps.db.transaction(async (tx) => {
    const ended = await tx
      .update(approvals)
      .set({ status: "canceled", decidedByUserId: actorId, decidedAt: new Date() })
      .where(
        and(
          where,
          sql`${approvals.runAt} is not null`,
          isNull(approvals.executedAt),
          inArray(approvals.status, ["pending", "approved"]),
        ),
      )
      .returning();
    for (const row of ended) {
      await enqueueResume(tx, row);
      if (settle) await settleAheadRoutine(tx, row);
      await auditDecision(tx, row, actorId);
    }
    return ended;
  });
  for (const row of rows) await publishApproval(deps, row, "approval.decided");
  return rows;
}

/**
 * An action approved ahead that `actorId` may withdraw, still able to run, or why not: of those who see it, whoever
 * may decide it and whoever manages its routine (its creator, the agent's owner, who may manage routines). One they
 * don't see is not found, as on Aprovações.
 */
export async function cancelableAhead(db: Database, actorId: string, orgId: string, approvalId: string) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const [current] = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.id, approvalId),
        eq(approvals.orgId, orgId),
        can(membership, "approve_actions") ? undefined : seenBy(db, orgId, actorId),
      ),
    );
  if (!current) throw new NotFoundError("Approval not found");
  const [routine] = current.routineId
    ? await db
        .select({ createdByUserId: routines.createdByUserId })
        .from(routines)
        .where(and(eq(routines.id, current.routineId), eq(routines.orgId, orgId)))
    : [];
  // Who manages the agent's routines (`managesRoutinesOf`, ADR 0085 addendum of 2026-11-17), not the key alone.
  const owns = ownsAgent(ownerOfApproval(current), actorId, membership?.roleIds ?? []);
  const [agent] =
    owns || routine?.createdByUserId === actorId || can(membership, "approve_actions")
      ? []
      : await db
          .select(ACCESS_COLUMNS)
          .from(agents)
          .where(and(eq(agents.id, current.agentId), eq(agents.orgId, orgId)));
  const may =
    can(membership, "approve_actions") ||
    (!!agent && managesRoutinesOf(agent, actorId, membership)) ||
    owns ||
    routine?.createdByUserId === actorId;
  if (!may) throw new ForbiddenError("Only who may decide it or manage its routine can cancel this");
  if (!current.runAt) throw new ConflictError("Only an action approved ahead can be canceled", "approval.not_ahead");
  if (!aheadLive(current)) throw new ConflictError("This action already ran or ended", "approval.not_cancelable");
  return current;
}

/**
 * Withdraws one action approved ahead before its time (or its request, still waiting): the routine's run won't do
 * it, and a one-off left with nothing to do no longer fires.
 */
export async function cancelAheadApproval(
  deps: { db: Database; pubsub: PubSub },
  actorId: string,
  orgId: string,
  approvalId: string,
): Promise<ApprovalView> {
  const current = await cancelableAhead(deps.db, actorId, orgId, approvalId);
  const [ended] = await withdrawAhead(deps, eq(approvals.id, current.id), actorId, true);
  if (!ended) throw new ConflictError("This action already ran or ended", "approval.not_cancelable");
  const [view = approvalView(ended)] = await viewsOf(deps.db, [ended], () => false, false, actorId);
  return view;
}

/** An action approved ahead (or waiting to be) for one of a routine's runs, as the routine's page lists it. */
export interface RoutineAheadView {
  /** The approval. */
  id: string;
  tool: string;
  scope: string;
  title: string;
  params: Record<string, unknown>;
  status: "pending" | "approved";
  runAt: string;
  /** The person viewing may withdraw it (`cancelAheadApproval`). */
  canCancel: boolean;
}

/**
 * Each routine's actions approved ahead (or waiting to be) that may still run, soonest first: for `viewerId`, those
 * they see on Aprovações (all with `approve_actions`, else `seenBy`); null, the engine itself, all of them.
 */
export async function routinesAhead(
  db: Database,
  orgId: string,
  routineIds: string[],
  viewerId: string | null,
  now = new Date(),
) {
  const out = new Map<string, Omit<RoutineAheadView, "canCancel">[]>();
  if (routineIds.length === 0) return out;
  const rows = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.orgId, orgId),
        inArray(approvals.routineId, routineIds),
        isNull(approvals.executedAt),
        inArray(approvals.status, ["pending", "approved"]),
        gte(approvals.runAt, new Date(now.getTime() - AHEAD_GRACE_MS)),
        viewerId ? or(maySql(orgId, viewerId, "approve_actions"), seenBy(db, orgId, viewerId)) : undefined,
      ),
    )
    .orderBy(approvals.runAt, approvals.createdAt);
  for (const r of rows) {
    if (!r.routineId || !r.runAt) continue;
    const item = {
      id: r.id,
      tool: r.tool,
      scope: r.scope,
      title: r.title,
      params: r.params,
      status: r.status as RoutineAheadView["status"],
      runAt: r.runAt.toISOString(),
    };
    out.set(r.routineId, [...(out.get(r.routineId) ?? []), item]);
  }
  return out;
}

/** A routine's time changed or it was deleted: what was approved ahead for it no longer covers anything. */
export const cancelRoutineAhead = (
  deps: { db: Database; pubsub: PubSub },
  orgId: string,
  routineId: string,
  actorId: string | null,
) => withdrawAhead(deps, and(eq(approvals.orgId, orgId), eq(approvals.routineId, routineId)), actorId, false);

/**
 * The approvals someone sees who doesn't see them all (`approve_actions`): their agents', their conversations', and
 * those asked of them by name or role (`request_approval`).
 */
const seenBy = (db: Database, orgId: string, actorId: string) =>
  or(
    decidableBySql(actorId),
    eq(approvals.decidedByUserId, actorId),
    ownsAgentSql("approvals", sql`${actorId}::text`),
    sql`coalesce(${approvals.approvers} -> 'userIds', '[]'::jsonb) @> to_jsonb(${actorId}::text)`,
    inArray(
      approvals.channelId,
      db
        .select({ id: channelMembers.channelId })
        .from(channelMembers)
        .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.userId, actorId))),
    ),
    // A task's conversation (ADR 0145): people are never its members; whoever sees the task sees its cards. A live
    // file's (ADR 0199): whoever reads the file.
    taskReaderSql(sql`${approvals.channelId}`, sql`${actorId}::text`),
    fileConversationReaderSql(sql`${approvals.channelId}`, sql`${actorId}::text`),
  );

/** One in someone's own connection (`approvers.personal`): only they and who is in its conversation list it. */
const personalSeenBy = (db: Database, orgId: string, actorId: string) =>
  or(
    sql`not coalesce((${approvals.approvers} ->> 'personal')::boolean, false)`,
    sql`${approvals.approvers} -> 'userIds' @> to_jsonb(${actorId}::text)`,
    inArray(
      approvals.channelId,
      db
        .select({ id: channelMembers.channelId })
        .from(channelMembers)
        .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.userId, actorId))),
    ),
  );

/**
 * Approvals a person can see: admins see all; others see those of agents they
 * own and those in channels they belong to. Each carries `canDecide`.
 */
export async function listApprovals(
  db: Database,
  actorId: string,
  orgId: string,
  options: { status?: "pending" | "decided"; agentId?: string; messageId?: string; limit?: number } = {},
): Promise<ApprovalView[]> {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const admin = can(membership, "approve_actions");
  const rows = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.orgId, orgId),
        options.status === "pending"
          ? eq(approvals.status, "pending")
          : options.status === "decided"
            ? ne(approvals.status, "pending")
            : undefined,
        options.agentId ? eq(approvals.agentId, options.agentId) : undefined,
        options.messageId ? eq(approvals.messageId, options.messageId) : undefined,
        admin ? undefined : seenBy(db, orgId, actorId),
        personalSeenBy(db, orgId, actorId),
      ),
    )
    .orderBy(desc(approvals.createdAt))
    .limit(Math.min(options.limit ?? 100, 500));
  const [covers, asking] = await Promise.all([activeCoversTo(db, orgId, actorId), askingAgents(db, orgId, rows)]);
  return viewsOf(
    db,
    rows,
    (r) => decides(r, actorId, membership, asking.get(r.agentId) ?? null) || coveredFor(r, actorId, covers) !== null,
    false,
    actorId,
  );
}

export async function getApproval(db: Database, actorId: string, orgId: string, approvalId: string) {
  const list = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, approvalId), eq(approvals.orgId, orgId)));
  const row = list[0];
  if (!row) throw new NotFoundError("Approval not found");
  const visible = (await listApprovals(db, actorId, orgId, { agentId: row.agentId, limit: 500 })).find(
    (a) => a.id === row.id,
  );
  if (!visible) throw new NotFoundError("Approval not found");
  const [detailed] = await viewsOf(db, [row], () => visible.canDecide, true);
  return { ...visible, trail: detailed?.trail ?? [] };
}

/** Pending approvals per agent, for badges. */
export async function pendingApprovalCounts(db: Database, orgId: string) {
  return db
    .select({ agentId: approvals.agentId, handle: agents.handle, pending: sql<number>`count(*)::int` })
    .from(approvals)
    .innerJoin(agents, eq(agents.id, approvals.agentId))
    .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))
    .groupBy(approvals.agentId, agents.handle);
}
