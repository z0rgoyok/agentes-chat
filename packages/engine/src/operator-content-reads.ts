import { maskSecretFields } from "@agenteschat/adapters";
import { and, asc, type Database, eq, gt, inArray, isNull, type SQL, schema, sql } from "@agenteschat/db";
import { z } from "zod";
import { recordAudit } from "./audit";
import { confidentialThreadSql } from "./confidential";
import { EXPAND_TOOL, READ_CONVERSATION_TOOL } from "./context/tools";
import { decodeCursor, encodeCursor } from "./cursor";
import { TooManyError, ValidationError } from "./errors";
import { cutText, pgSafeText } from "./format";
import { recordContentViewed } from "./operator-events";
import { micros } from "./operator-paging";
import {
  checkRevealReason,
  noSuchRecord,
  REVEAL_PER_WORKSPACE_DAY,
  revealRefused,
  revealsToday,
} from "./operator-reveal";
import { inputLines, keptText } from "./operator-review";
import { cloudNotice } from "./standing";
import { redactCredentials } from "./tool-detail";
import { neutralizeUntrusted } from "./untrusted";

/**
 * The reveal door's investigation reads (ADR 0056, addendum of 2026-11-21): a conversation's messages, a run's whole
 * transcript, an agent's instructions and settings, read by whoever runs the server to investigate a problem in a
 * workspace, with a reason. Each read is on record before any text is read, in the operator's feed (with the reason,
 * the operator and the case) and in the workspace's own audit log (never the reason). The door's bounds hold: what
 * a confidential thread holds stays in it, and what two people said to each other in a direct conversation is not
 * read. Every text is masked whole before it is cut.
 */

const {
  agentRuns,
  agentRunSteps,
  agents,
  approvalRules,
  auditLog,
  channels,
  messages,
  operatorEvents,
  routineRuns,
  routines,
} = schema;

/** The longest stretch of a conversation one read covers. */
export const CONTENT_READ_MAX_MS = 48 * 3600_000;
/** The most messages or steps one read gives. */
export const CONTENT_READ_MAX_ITEMS = 200;
/** Characters given of each message or step: a longer one says how long it is whole. */
export const CONTENT_ITEM_MAX_CHARS = 4000;
export const CASE_REF_MAX = 64;

export interface InvestigationInput {
  /** The question the read answers, in one line: kept in the operator's feed, never in the workspace's audit log. */
  reason: string;
  /** The operator's own case or ticket id: kept in the operator's feed beside the reason. */
  caseRef?: string;
  /** Who reads, as the caller names them. */
  operator: string;
  assistedByAi: boolean;
}

/** A text as it leaves: credentials masked, hidden characters and envelope markers removed. */
const clean = (raw: string) => neutralizeUntrusted(redactCredentials(raw));

/** `clean`, then cut to `CONTENT_ITEM_MAX_CHARS`, saying how long it is whole. */
function shown(raw: string | null | undefined) {
  if (raw == null) return { text: null, chars: 0, cut: false };
  const whole = clean(raw);
  const text = cutText(whole, CONTENT_ITEM_MAX_CHARS);
  return { text, chars: whole.length, cut: text.length < whole.length };
}

/**
 * The read's record, committed before anything is read: a `content.viewed` event and an audit entry of the
 * workspace. A direct conversation's entry names no conversation, as the door's single reads do: `names` (the ids
 * that point at it) go in the event alone.
 */
async function onRecord(
  db: Database,
  orgId: string,
  input: InvestigationInput,
  read: {
    ref: string;
    field: string;
    direct: boolean;
    target: { type: string; id: string };
    facts?: Record<string, unknown>;
    names: Record<string, unknown>;
  },
) {
  const direct = read.direct ? { direct: true } : {};
  await db.transaction(async (tx) => {
    await recordContentViewed(tx, {
      orgId,
      ref: read.ref,
      reason: pgSafeText(input.reason).trim(),
      operator: pgSafeText(input.operator),
      ...(input.caseRef ? { caseRef: pgSafeText(input.caseRef) } : {}),
      purpose: "investigation",
      field: read.field,
      assistedByAi: input.assistedByAi,
      ...direct,
      ...read.names,
      ...read.facts,
    });
    await recordAudit(tx, {
      orgId,
      actor: { type: "system", id: null },
      action: "operator.content_read",
      target: { type: read.target.type, id: read.direct ? null : read.target.id },
      details: {
        field: read.field,
        purpose: "investigation",
        assistedByAi: input.assistedByAi,
        ...direct,
        ...(read.direct ? {} : read.names),
        ...read.facts,
        ...cloudNotice(),
      },
    });
  });
}

/** The reason's shape and the workspace's reads of the day, the door's single reads among them. */
async function checkRead(db: Database, orgId: string, input: InvestigationInput, now: Date) {
  checkRevealReason(input.reason);
  // ponytail: two reads at the same instant can pass one over the day's count, as the door's single reads can.
  if ((await revealsToday(db, now, eq(operatorEvents.orgId, orgId))) >= REVEAL_PER_WORKSPACE_DAY) {
    throw new TooManyError(
      `This workspace's ${REVEAL_PER_WORKSPACE_DAY} reads of the last 24 hours are used`,
      "reveal.limit_workspace",
    );
  }
}

const standing = (channelId: SQL) =>
  sql<boolean>`exists (select 1 from ${channels} c where c.id = ${channelId} and c.deleted_at is null)`;

export interface ConversationReadInput extends InvestigationInput {
  channelId: string;
  /** A thread: its first message and its replies. Absent: the whole conversation, threads included. */
  threadId?: string;
  from: Date;
  to: Date;
  limit: number;
  cursor?: string;
}

/** A page of messages ends at this key: `[createdAt with its microseconds, id]`. */
const MessageCursor = z.tuple([z.iso.datetime(), z.uuid()]);

export const WITHHELD = ["deleted", "confidential", "direct_conversation"] as const;

/**
 * Messages of one conversation in a window of at most 48 hours, oldest first, with what they say. A deleted one, one
 * of a confidential thread (ADR 0190) and, in a direct conversation, one no agent wrote and that started no run hold
 * no text and say why (`withheld`). One 404 for a conversation of another workspace, a deleted one and nobody's.
 */
export async function operatorConversationRead(
  db: Database,
  orgId: string,
  input: ConversationReadInput,
  now = new Date(),
) {
  const { channelId, threadId, from, to, limit } = input;
  if (!(from < to)) throw new ValidationError("from must be before to");
  if (to.getTime() - from.getTime() > CONTENT_READ_MAX_MS) {
    throw new ValidationError("from and to are 48 hours apart at most");
  }
  const after = input.cursor ? decodeCursor(input.cursor, MessageCursor) : null;
  await checkRead(db, orgId, input, now);
  const [channel] = await db
    .select({ kind: channels.kind })
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId), isNull(channels.deletedAt)));
  if (!channel) throw noSuchRecord();
  const direct = channel.kind === "dm";

  await onRecord(db, orgId, input, {
    ref: `reveal:conversation:${channelId}${threadId ? `:${threadId}` : ""}`,
    field: "messages",
    direct,
    target: { type: "conversation", id: channelId },
    names: { channelId, ...(threadId ? { threadId } : {}), ...(after ? { after: after[1] } : {}) },
    facts: { from: from.toISOString(), to: to.toISOString() },
  });

  const ofPeople = sql<boolean>`${messages.authorType} = 'person' and not exists (
    select 1 from ${agentRuns} r where r.trigger_message_id = ${messages.id} and r.org_id = ${messages.orgId})`;
  const confidential = confidentialThreadSql(
    sql`${messages.orgId}`,
    sql`coalesce(${messages.threadId}, ${messages.id})`,
  );
  const withheld = sql<(typeof WITHHELD)[number] | null>`case
    when ${messages.deletedAt} is not null then 'deleted'
    when ${confidential} then 'confidential'
    ${direct ? sql`when ${ofPeople} then 'direct_conversation'` : sql``} end`;
  const rows = await db
    .select({
      id: messages.id,
      createdAt: messages.createdAt,
      storedAt: micros(messages.createdAt),
      threadId: messages.threadId,
      authorType: messages.authorType,
      authorUserId: messages.authorUserId,
      authorAgentId: messages.authorAgentId,
      agentRunId: messages.agentRunId,
      editedAt: messages.editedAt,
      withheld,
      body: sql<string | null>`case when ${withheld} is null then ${messages.body} end`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        eq(messages.channelId, channelId),
        // On the stored time itself, never an expression of it: `messages` is partitioned by it.
        sql`${messages.createdAt} >= ${from.toISOString()}::timestamptz`,
        sql`${messages.createdAt} < ${to.toISOString()}::timestamptz`,
        threadId ? sql`(${messages.id} = ${threadId}::uuid or ${messages.threadId} = ${threadId}::uuid)` : undefined,
        after
          ? sql`(${messages.createdAt}, ${messages.id}) > (${after[0]}::timestamptz, ${after[1]}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(limit + 1);
  const page = rows
    .slice(0, limit)
    .map(({ body, storedAt, ...m }) => ({ ...m, ...shown(body), after: encodeCursor([storedAt, m.id]) }));
  return {
    channelId,
    direct,
    from,
    to,
    messages: page,
    next: rows.length > limit ? (page.at(-1)?.after ?? null) : null,
  };
}

export interface RunTranscriptInput extends InvestigationInput {
  runId: string;
  /** Steps after this one; 0: from the first. */
  afterSeq: number;
  limit: number;
}

/**
 * The tools whose result is what was said in a conversation (a stretch of one, a search of the workspace's, a
 * thread's summary, an earlier call's result whole): in a direct conversation's run, what people said to each other.
 */
const READS_CONVERSATIONS: ReadonlySet<string> = new Set([
  READ_CONVERSATION_TOOL,
  "search_context",
  "get_summary",
  EXPAND_TOOL,
]);

/** What a step says, as text: what the model wrote, a call's input, a result, an error, a message the run posted. */
function stepText(kind: string, data: Record<string, unknown>, posted: Map<string, string | null>): string | null {
  switch (kind) {
    case "model_call":
      return data.narration ? keptText(data.narration) : null;
    case "tool_call":
      return inputLines(data.input);
    case "tool_result":
      return keptText(data.content);
    case "error":
      return [data.reason, data.message].filter(Boolean).map(keptText).join(": ") || null;
    case "message":
      return typeof data.messageId === "string" ? (posted.get(data.messageId) ?? null) : null;
    default:
      return keptText(data);
  }
}

/**
 * One run's transcript, step by step from `afterSeq`: what the model wrote between calls, each tool call's input and
 * its result, errors, the messages it posted, and what started it. In a direct conversation's run, a result of a tool
 * that reads conversations holds no text (`withheld`), as the conversation's own read keeps what people said to each
 * other. A run of a confidential thread is refused (403 `reveal.confidential`). One 404 for a run of another workspace, of a deleted conversation and nobody's.
 */
export async function operatorRunTranscript(db: Database, orgId: string, input: RunTranscriptInput, now = new Date()) {
  await checkRead(db, orgId, input, now);
  const [run] = await db
    .select({
      id: agentRuns.id,
      agentId: agentRuns.agentId,
      channelId: agentRuns.channelId,
      threadRootId: agentRuns.threadRootId,
      triggerMessageId: agentRuns.triggerMessageId,
      trigger: agentRuns.trigger,
      status: agentRuns.status,
      createdAt: agentRuns.createdAt,
      finishedAt: agentRuns.finishedAt,
      direct: sql<boolean>`exists (select 1 from ${channels} c where c.id = ${agentRuns.channelId} and c.kind = 'dm')`,
      confidential: confidentialThreadSql(sql`${agentRuns.orgId}`, sql`${agentRuns.threadRootId}`).mapWith(Boolean),
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.orgId, orgId), standing(sql`${agentRuns.channelId}`)));
  if (!run) throw noSuchRecord();
  if (run.confidential) {
    throw revealRefused("confidential", "What a run of a confidential thread holds is read only in that thread");
  }

  await onRecord(db, orgId, input, {
    ref: `reveal:run:${run.id}`,
    field: "transcript",
    direct: run.direct,
    target: { type: "run_step", id: run.id },
    names: { runId: run.id },
    facts: input.afterSeq > 0 ? { afterSeq: input.afterSeq } : {},
  });

  const steps = await db
    .select({ seq: agentRunSteps.seq, kind: agentRunSteps.kind, data: agentRunSteps.data, at: agentRunSteps.createdAt })
    .from(agentRunSteps)
    .where(and(eq(agentRunSteps.runId, run.id), gt(agentRunSteps.seq, input.afterSeq)))
    .orderBy(asc(agentRunSteps.seq))
    .limit(input.limit + 1);
  const page = steps.slice(0, input.limit);
  const ids = [
    run.triggerMessageId,
    ...page.flatMap((s) => (s.kind === "message" && typeof s.data.messageId === "string" ? [s.data.messageId] : [])),
  ];
  const bodies = await db
    .select({ id: messages.id, body: messages.body, deletedAt: messages.deletedAt })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), inArray(messages.id, ids)));
  const posted = new Map(bodies.map((m) => [m.id, m.deletedAt ? null : m.body]));
  const name = (s: (typeof page)[number]) =>
    typeof s.data.name === "string" ? s.data.name : typeof s.data.model === "string" ? s.data.model : null;
  const { direct, confidential: _confidential, ...about } = run;
  return {
    run: about,
    request: shown(posted.get(run.triggerMessageId)),
    steps: page.map((s) => {
      const withheld: "direct_conversation" | null =
        direct && s.kind === "tool_result" && READS_CONVERSATIONS.has(name(s) ?? "") ? "direct_conversation" : null;
      return {
        seq: s.seq,
        kind: s.kind,
        at: s.at,
        name: name(s),
        toolUseId: typeof s.data.toolUseId === "string" ? s.data.toolUseId : null,
        isError: s.kind === "tool_result" ? s.data.isError === true : null,
        withheld,
        ...shown(withheld ? null : stepText(s.kind, s.data, posted)),
      };
    }),
    nextSeq: steps.length > input.limit ? (page.at(-1)?.seq ?? null) : null,
  };
}

/** A value of an agent's settings as it leaves: every string in it `clean`, a secret-named field's whole. */
const masked = (value: unknown) => maskSecretFields(value ?? null, clean);

/** An agent's instructions and settings, as its page sets them. One 404 for another workspace's, a deleted one and nobody's. */
export async function operatorAgentSettings(
  db: Database,
  orgId: string,
  input: InvestigationInput & { agentId: string },
  now = new Date(),
) {
  await checkRead(db, orgId, input, now);
  const where = and(eq(agents.id, input.agentId), eq(agents.orgId, orgId), isNull(agents.deletedAt));
  const [found] = await db.select({ id: agents.id }).from(agents).where(where);
  if (!found) throw noSuchRecord();
  await onRecord(db, orgId, input, {
    ref: `reveal:agent:${found.id}`,
    field: "settings",
    direct: false,
    target: { type: "agent", id: found.id },
    names: { agentId: found.id },
  });
  const [a] = await db
    .select({
      id: agents.id,
      name: agents.name,
      handle: agents.handle,
      role: agents.role,
      instructions: agents.instructions,
      model: agents.model,
      brain: agents.brain,
      brainModel: agents.brainModel,
      brainEffort: agents.brainEffort,
      approvalsLevel: agents.approvalsLevel,
      audienceMode: agents.audienceMode,
      consultable: agents.consultable,
      autonomyBrakes: agents.autonomyBrakes,
      mergeRepos: agents.mergeRepos,
      browserAllowedDomains: agents.browserAllowedDomains,
      setup: agents.setup,
      updatedAt: agents.updatedAt,
    })
    .from(agents)
    .where(where);
  if (!a) throw noSuchRecord();
  const { instructions, autonomyBrakes, mergeRepos, browserAllowedDomains, setup, ...rest } = a;
  return {
    ...rest,
    role: masked(rest.role) as string,
    instructions: clean(instructions),
    autonomyBrakes: masked(autonomyBrakes) as Record<string, unknown>,
    mergeRepos: masked(mergeRepos) as string[],
    browserAllowedDomains: masked(browserAllowedDomains) as string[] | null,
    setup: masked(setup) as Record<string, unknown> | null,
  };
}

/** One call a webhook routine's run carries, as it was kept (`routine_runs.event.calls`). */
interface KeptCall {
  at?: unknown;
  method?: unknown;
  headers?: unknown;
  bytes?: unknown;
  body?: unknown;
  cut?: unknown;
  binary?: unknown;
  test?: unknown;
}

/**
 * The calls a webhook routine's run carries, as they were kept (their headers and body excerpts, ADR 0106), each body
 * from `offset`, `CONTENT_ITEM_MAX_CHARS` of it at most. One 404 for another workspace's run, a deleted routine's and
 * nobody's.
 */
export async function operatorRoutineRunCalls(
  db: Database,
  orgId: string,
  input: InvestigationInput & { routineRunId: string; offset: number },
  now = new Date(),
) {
  await checkRead(db, orgId, input, now);
  const where = and(eq(routineRuns.id, input.routineRunId), eq(routineRuns.orgId, orgId));
  const [found] = await db
    .select({ id: routineRuns.id, routineId: routineRuns.routineId })
    .from(routineRuns)
    .innerJoin(routines, and(eq(routines.id, routineRuns.routineId), isNull(routines.deletedAt)))
    .where(where);
  if (!found) throw noSuchRecord();
  await onRecord(db, orgId, input, {
    ref: `reveal:routine_run:${found.id}`,
    field: "calls",
    direct: false,
    target: { type: "routine", id: found.routineId },
    names: { routineId: found.routineId, routineRunId: found.id },
  });
  const [run] = await db
    .select({
      status: routineRuns.status,
      agentRunId: routineRuns.agentRunId,
      at: routineRuns.at,
      event: routineRuns.event,
    })
    .from(routineRuns)
    .where(where);
  if (!run) throw noSuchRecord();
  const kept = Array.isArray(run.event?.calls) ? (run.event.calls as KeptCall[]) : [];
  return {
    id: found.id,
    routineId: found.routineId,
    agentRunId: run.agentRunId,
    status: run.status,
    at: run.at,
    calls: kept.map((c, i) => {
      const whole = clean(typeof c.body === "string" ? c.body : "");
      const text = cutText(whole.slice(input.offset), CONTENT_ITEM_MAX_CHARS);
      return {
        n: i + 1,
        at: typeof c.at === "string" ? c.at : null,
        method: typeof c.method === "string" ? c.method : "POST",
        headers: masked(c.headers && typeof c.headers === "object" ? c.headers : {}) as Record<string, string>,
        bytes: typeof c.bytes === "number" ? c.bytes : 0,
        keptCut: c.cut === true,
        binary: c.binary === true,
        test: c.test === true,
        text,
        chars: whole.length,
        more: input.offset + text.length < whole.length,
      };
    }),
  };
}

/**
 * An agent's "Aprovar sempre" rules, and with `runId` the tool calls of that run of the agent that a rule let run
 * (their `approvalRules`, ADR 0015). A rule's action may hold what a call named (a command's kind, a SQL read's
 * target): masked as any text the door gives. One 404 for another workspace's agent, a deleted one and nobody's.
 */
export async function operatorApprovalRules(
  db: Database,
  orgId: string,
  input: InvestigationInput & { agentId: string; runId?: string },
  now = new Date(),
) {
  await checkRead(db, orgId, input, now);
  const [found] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.orgId, orgId), isNull(agents.deletedAt)));
  if (!found) throw noSuchRecord();
  await onRecord(db, orgId, input, {
    ref: `reveal:agent:${found.id}`,
    field: "approval_rules",
    direct: false,
    target: { type: "agent", id: found.id },
    names: { agentId: found.id, ...(input.runId ? { runId: input.runId } : {}) },
  });
  const rules = await db
    .select({
      id: approvalRules.id,
      connectionId: approvalRules.connectionId,
      tool: approvalRules.tool,
      action: approvalRules.action,
      createdByUserId: approvalRules.createdByUserId,
      createdAt: approvalRules.createdAt,
    })
    .from(approvalRules)
    .where(and(eq(approvalRules.orgId, orgId), eq(approvalRules.agentId, found.id)))
    .orderBy(asc(approvalRules.createdAt), asc(approvalRules.id));
  const calls = input.runId
    ? await db
        .select({
          id: auditLog.id,
          at: auditLog.createdAt,
          tool: auditLog.targetId,
          outcome: auditLog.outcome,
          details: auditLog.details,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.orgId, orgId),
            eq(auditLog.actorType, "agent"),
            eq(auditLog.actorId, found.id),
            eq(auditLog.runId, input.runId),
            eq(auditLog.action, "tool.call"),
            sql`${auditLog.details} ? 'approvalRules'`,
          ),
        )
        .orderBy(asc(auditLog.createdAt), asc(auditLog.id))
        .limit(CONTENT_READ_MAX_ITEMS)
    : [];
  return {
    agentId: found.id,
    rules: rules.map((r) => ({ ...r, tool: clean(r.tool), action: clean(r.action) })),
    calls: calls.map(({ details, ...c }) => ({
      ...c,
      tool: c.tool === null ? null : clean(c.tool),
      approvalRules: Array.isArray(details.approvalRules) ? (details.approvalRules as string[]) : [],
    })),
  };
}
