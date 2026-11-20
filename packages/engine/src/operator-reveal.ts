import { and, type Database, type Executor, eq, gt, isNull, rowsOf, type SQL, schema, sql } from "@agenteschat/db";
import { othersPersonalTools } from "./agent-audit";
import { requireAgentDetails } from "./audience";
import { recordAudit } from "./audit";
import { readableChannelIds, requireChannelAccess } from "./channels";
import { CONFIDENTIAL_STUB, confidentialThreadSql } from "./confidential";
import { ConflictError, ForbiddenError, NotFoundError, TooManyError, ValidationError } from "./errors";
import { cutText, pgSafeText } from "./format";
import { requireUsageAccess } from "./management";
import { recordContentViewed } from "./operator-events";
import { listedOf, orgExists } from "./operator-paging";
import { inputLines, keptText, taskRunSql } from "./operator-review";
import { runShownSql } from "./operator-runs";
import { getMembership, requirePermission } from "./organizations";
import { ROUTINE_ROOM_PREFIX } from "./routine-brief";
import { getRoutineView } from "./routines";
import { cloudNotice } from "./standing";
import { SUPPORT_SOURCES } from "./support-requests";
import { redactCredentials } from "./tool-detail";
import { neutralizeUntrusted } from "./untrusted";

/**
 * The operator API's reveal door (ADR 0056): one field of one record of what a workspace wrote, read by whoever runs
 * the server, with a stated reason, for one of three purposes. Two are proved by a record of the workspace. A member
 * asked for help (a support request): what that member reads in the app now. A run failed or got stuck (the run):
 * what hangs on that run. Either read is on record, in the operator's feed and in the workspace's own audit log,
 * before any text is read out. The third is a safety review, to investigate suspected abuse: no record of the
 * workspace can prove it, so it is capped for the whole instance, on record in the operator's feed alone, and the
 * operator tells the workspace afterwards (`operatorDisclose`). Credentials are masked before the text is cut.
 */

const {
  agentRuns,
  agentRunSteps,
  agents,
  auditLog,
  channels,
  connectorConnections,
  machineTasks,
  messages,
  operatorEvents,
  organizations,
  routineRuns,
  routines,
  supportRequests,
} = schema;

/** What can be read, closed: each kind of record and the fields of it that hold what someone wrote. */
export const REVEAL_FIELDS = {
  message: ["text"],
  run_step: ["input", "result", "narration", "error"],
  agent: ["instructions"],
  routine: ["name", "instructions"],
  task: ["command", "prompt", "result"],
  channel: ["name"],
  connection: ["label", "host", "last_error"],
  support_request: ["text", "about"],
} as const;
export type RevealKind = keyof typeof REVEAL_FIELDS;
export const REVEAL_KINDS = Object.keys(REVEAL_FIELDS) as [RevealKind, ...RevealKind[]];
export const REVEAL_PURPOSES = ["member_request", "fault", "trust_safety"] as const;
export type RevealPurpose = (typeof REVEAL_PURPOSES)[number];

/** The most characters one read gives; a longer field is read on from `offset`, each read on record. */
export const REVEAL_MAX_CHARS = 2000;
export const REVEAL_REASON_CHARS = { min: 20, max: 200 } as const;
export const REVEAL_OPERATOR_MAX = 200;
/** Days a support request opens what its member reads. */
export const REVEAL_REQUEST_DAYS = 30;
/** Days a run opens what hangs on it: from now, or back from the support request that reported it. */
export const REVEAL_FAULT_DAYS = 14;
/** How long a run must have stood still, with no move that is a person's to make, to count as stuck. */
export const REVEAL_STUCK_MS = 60 * 60_000;
/** The door's own bounds, for an instance with nothing in front of it: calls a minute, and reads of one workspace a day. */
export const REVEAL_PER_MINUTE = { limit: 30, windowMs: 60_000 } as const;
export const REVEAL_PER_WORKSPACE_DAY = 100;
/** Reads a day, on the whole instance, that no workspace is told of at the time (`trust_safety`). */
export const REVEAL_UNTOLD_PER_DAY = 150;
/** A disclosure's bounds: how long a period it may tell of, and how many items. */
export const DISCLOSURE_MAX_DAYS = 90;
export const DISCLOSURE_MAX_COUNT = 10_000;
/** The sentences a reply to a support request can say in core's own words (`operatorReply`). */
export const REPLY_TEMPLATES = ["received", "need_more", "resolved", "handed_over"] as const;
export type ReplyTemplate = (typeof REPLY_TEMPLATES)[number];
/** A reply's bounds: how many one request gets, and how many the instance sends in a day. */
export const REPLIES_PER_REQUEST = 3;
export const REPLIES_PER_DAY = 60;

const DAY_MS = 86_400_000;
const CONTENT_REVIEW_DISCLOSED = "operator.content_review_disclosed";

export interface RevealInput {
  kind: RevealKind;
  id: string;
  /** A run's step: its number in the run's trace. */
  seq?: number;
  field: string;
  offset: number;
  limit: number;
  purpose: RevealPurpose;
  /** The question this read answers, in one line: kept in the operator's feed, never in the workspace's audit log. */
  reason: string;
  /** Who reads, as the caller names them. */
  operator: string;
  assistedByAi: boolean;
  /** The support request: the proof of `member_request`; with `fault`, the report the run's days count back from. */
  requestId?: string;
  /** The run: the proof of `fault`. `trust_safety` names neither: no call may look like it had a proof. */
  runId?: string;
}

export interface Revealed {
  kind: RevealKind;
  id: string;
  field: string;
  text: string;
  /** How long the whole field is, masked as it is given. */
  chars: number;
  offset: number;
  /** Whether text is left after this window: read on from `offset` plus the length of `text`. */
  more: boolean;
}

// An address of a person or of a page: a reason is kept where others read it, and names ids, never people.
const ADDRESS = /[^\s@]@[^\s@][^\s@.]*\.[^\s@]|:\/\/\S|\bwww\.\S/i;
const MORE_THAN_A_LINE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** What a request's shape must also hold, beyond its types. */
function checkShape(input: RevealInput) {
  const refuse = (message: string) => {
    throw new ValidationError(message);
  };
  if (!(REVEAL_FIELDS[input.kind] as readonly string[]).includes(input.field)) {
    refuse(`field: a ${input.kind} has ${REVEAL_FIELDS[input.kind].join(", ")}`);
  }
  if ((input.kind === "run_step") !== (input.seq !== undefined)) refuse("seq: a run's step has one, nothing else does");
  const reason = input.reason.trim();
  if (reason.length < REVEAL_REASON_CHARS.min || MORE_THAN_A_LINE.test(reason) || ADDRESS.test(reason)) {
    refuse("reason: one line of at least 20 characters that says the question, with no email or web address");
  }
  if (input.purpose === "member_request" && (!input.requestId || input.runId)) {
    refuse("requestId: member_request takes the support request, and no run");
  }
  if (input.purpose === "fault" && !input.runId) refuse("runId: fault takes the run");
  if (input.purpose === "trust_safety" && (input.requestId || input.runId)) {
    refuse("requestId, runId: trust_safety takes neither");
  }
}

const refused = (code: string, message: string) => new ForbiddenError(message, `reveal.${code}`);

/** One answer for a record of another workspace, a deleted one and one nobody has. */
export const noSuchRecord = () => new NotFoundError("No such record in this workspace");

/** Who made a support request is still a member the app lets in: not gone, blocked or being deleted. */
export async function requireRequester(db: Executor, orgId: string, userId: string) {
  if (!(await getMembership(db, userId, orgId))) {
    throw refused("requester", "Who asked is no longer a member of this workspace");
  }
}

/** The app's own check, asked as a question: its refusal is a no, anything else it throws is not an answer. */
async function passes(check: () => Promise<unknown>) {
  try {
    await check();
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof NotFoundError) return false;
    throw error;
  }
}

/** The run a fault read rests on, with what decides whether it failed or stands still. */
interface FaultRun {
  id: string;
  agentId: string;
  triggerMessageId: string;
  createdAt: Date;
  /** `failed`, or stuck: more than `REVEAL_STUCK_MS` with no move that is a person's to make. */
  open: boolean;
  failedStep: boolean;
}

/** One record of the workspace, found without reading its text. */
interface Found {
  /** It is of a direct conversation. */
  direct: boolean;
  /** A message no agent wrote and that started no run: in a direct conversation, what people said to each other. */
  ofPeople?: boolean;
  /**
   * It holds what a run of a confidential thread read or wrote (ADR 0190): the run's step, a task it started, a task
   * the server started again from that one.
   */
  confidential: boolean;
  /** The field holds text (measured in the database). */
  has: boolean;
  /** Whether this member reads it in the app now. */
  seenBy(userId: string): Promise<boolean>;
  /** Whether it hangs on the run: its step, a message that started it or that it wrote, its agent, its routine, a task it started. */
  ofRun(run: FaultRun): boolean | Promise<boolean>;
  /** A run's step that is the failure itself: an error step, a failed result, or the call whose result failed. */
  failure: boolean;
  /** The field's text. Called only once the read is on record. */
  text(): Promise<string | null>;
}

type Find = (db: Database, orgId: string, input: RevealInput) => Promise<Found | null>;

/**
 * Whether a conversation is a direct one. A routine's own room is stored as one, of its agent alone, and no person
 * reads it: it counts as direct only when its routine reports to a direct conversation, whose words its run is given
 * and writes its report for (the routine's id is read from the room's key, as `routineRoomKey` writes it). A routine
 * that writes a document reports in its creator's own conversation with the agent. What a firing of the routine left
 * there (`firing`: the ids of the messages that may hold the record's own firing) stays direct when that firing
 * reported to one, wherever the routine reports now; a widget's firing reads no conversation.
 * `channelId` and `firing` name their tables: in a subquery a bare column would be the subquery's own.
 */
const directOf = (channelId: string, firing = "null") =>
  sql<boolean>`coalesce((select c.kind = 'dm' and (
      not starts_with(coalesce(c.dm_key, ''), ${ROUTINE_ROOM_PREFIX})
      or coalesce((select rt.target->>'type' in ('dm', 'artifact') or exists (
          select 1 from ${channels} t
          where t.org_id = c.org_id and t.id::text = rt.target->>'channelId' and t.kind = 'dm')
        from ${routines} rt where rt.org_id = c.org_id and rt.id::text = split_part(c.dm_key, '|r:', 2)), true)
      or exists (
        select 1 from ${messages} f
        join ${channels} t on t.org_id = f.org_id and t.kind = 'dm'
          and t.id::text = f.meta->'routineBrief'->'deliverTo'->>'channelId'
        where f.org_id = c.org_id and f.id in (${sql.raw(firing)}) and f.meta->'routineBrief'->'widget' is null))
    from ${channels} c where c.id = ${sql.raw(channelId)}), false)`;
/** The message that fired a run, where a routine's firing keeps what it was told (`meta.routineBrief`). */
const firingOf = (runId: string) => `(select fr.trigger_message_id from agent_runs fr where fr.id = ${runId})`;
/** Whether a record's conversation still stands: one deleted for good keeps its row, and its runs keep their steps. */
const conversationStands = (channelId: string) =>
  sql<boolean>`not exists (
    select 1 from ${channels} c where c.id = ${sql.raw(channelId)} and c.deleted_at is not null)`;
const filled = (column: unknown) => sql<boolean>`coalesce(length(${column}), 0) > 0`;
/** Whether the run aliased `r` is of a confidential thread, as the run review asks it. */
const confidentialRun = confidentialThreadSql(sql`r.org_id`, sql`r.thread_root_id`);
/** Whether a message is of a confidential thread: the one it answers in, or the one it starts. */
const confidentialMessage = confidentialThreadSql(
  sql`${messages.orgId}`,
  sql`coalesce(${messages.threadId}, ${messages.id})`,
);

/** Who the app gives a run's steps to: who may see the agent's runs, and reads the conversation it ran in. */
const readsRunsOf = async (db: Database, orgId: string, userId: string, agentId: string, channelId: string) =>
  (await passes(() => requireUsageAccess(db, userId, orgId, agentId))) &&
  (await readableChannelIds(db, orgId, userId, [channelId])).has(channelId);

const findMessage: Find = async (db, orgId, { id }) => {
  const where = and(
    eq(messages.id, id),
    eq(messages.orgId, orgId),
    isNull(messages.deletedAt),
    conversationStands('"messages"."channel_id"'),
  );
  const [m] = await db
    .select({
      channelId: messages.channelId,
      agentRunId: messages.agentRunId,
      ofPeople: sql<boolean>`${messages.authorType} = 'person' and not exists (
        select 1 from ${agentRuns} r where r.trigger_message_id = "messages"."id" and r.org_id = "messages"."org_id")`,
      direct: directOf('"messages"."channel_id"', `"messages"."id", ${firingOf('"messages"."agent_run_id"')}`),
      has: filled(messages.body),
    })
    .from(messages)
    .where(where);
  if (!m) return null;
  return {
    ...m,
    // Never refused: of a confidential thread `text` reads the stub, whatever is stored (one written while the
    // thread's mark was being committed keeps its words until `sealStragglers` seals it).
    confidential: false,
    failure: false,
    seenBy: (userId) => passes(() => requireChannelAccess(db, userId, orgId, m.channelId)),
    ofRun: (run) => id === run.triggerMessageId || m.agentRunId === run.id,
    text: async () =>
      (
        await db
          .select({
            text: sql<string>`case when ${confidentialMessage} then ${CONFIDENTIAL_STUB} else ${messages.body} end`,
          })
          .from(messages)
          .where(where)
      )[0]?.text ?? null,
  };
};

/** What a step holds under each field; null where its kind has no such field. */
function stepText(kind: string, data: Record<string, unknown>, field: string): string | null {
  if (field === "input") return kind === "tool_call" ? inputLines(data.input) : null;
  if (field === "result") return kind === "tool_result" ? keptText(data.content) : null;
  if (field === "narration") return kind === "model_call" ? keptText(data.narration) : null;
  if (kind === "tool_result") return data.isError === true ? keptText(data.content) : null;
  return kind === "error" ? [data.reason, data.message].filter(Boolean).map(keptText).join(": ") : null;
}

const findStep: Find = async (db, orgId, { id, seq, field }) => {
  const [s] = rowsOf<{
    agent_id: string;
    channel_id: string;
    direct: boolean;
    confidential: boolean;
    kind: string;
    name: string | null;
    failed: boolean;
    result_failed: boolean;
    narrated: boolean;
  }>(
    await db.execute(sql`select r.agent_id, r.channel_id, s.kind, s.data->>'name' as name,
        ${directOf("r.channel_id", "r.trigger_message_id")} as direct,
        ${confidentialRun} as confidential,
        (s.kind = 'error' or (s.kind = 'tool_result' and s.data->'isError' = 'true'::jsonb)) as failed,
        (s.kind = 'tool_call' and exists (select 1 from ${agentRunSteps} o where o.run_id = s.run_id
          and o.kind = 'tool_result' and o.data->>'toolUseId' = s.data->>'toolUseId'
          and o.data->'isError' = 'true'::jsonb)) as result_failed,
        coalesce(length(s.data->>'narration'), 0) > 0 as narrated
      from ${agentRunSteps} s join ${agentRuns} r on r.id = s.run_id
      where s.run_id = ${id}::uuid and s.seq = ${seq ?? 0} and r.org_id = ${orgId}::uuid
        and ${conversationStands("r.channel_id")}`),
  );
  if (!s) return null;
  const has = { input: s.kind === "tool_call", result: s.kind === "tool_result", narration: s.narrated }[field];
  return {
    direct: s.direct,
    confidential: s.confidential,
    has: has ?? s.failed,
    failure: field === "error" ? s.failed : field === "input" && s.result_failed,
    // A call in someone else's own connection shows them its name alone (`getRun`).
    seenBy: async (userId) =>
      (await readsRunsOf(db, orgId, userId, s.agent_id, s.channel_id)) &&
      !(s.name && (await othersPersonalTools(db, orgId, id, userId)).has(s.name)),
    ofRun: (run) => id === run.id,
    text: async () => {
      const [step] = await db
        .select({ kind: agentRunSteps.kind, data: agentRunSteps.data })
        .from(agentRunSteps)
        .where(and(eq(agentRunSteps.runId, id), eq(agentRunSteps.seq, seq ?? 0)));
      return step ? stepText(step.kind, step.data, field) : null;
    },
  };
};

const findAgent: Find = async (db, orgId, { id }) => {
  const where = and(eq(agents.id, id), eq(agents.orgId, orgId), isNull(agents.deletedAt));
  const [a] = await db
    .select({ has: filled(agents.instructions) })
    .from(agents)
    .where(where);
  if (!a) return null;
  return {
    direct: false,
    confidential: false,
    has: a.has,
    failure: false,
    seenBy: (userId) => passes(() => requireAgentDetails(db, userId, orgId, id)),
    ofRun: (run) => id === run.agentId,
    text: async () => (await db.select({ text: agents.instructions }).from(agents).where(where))[0]?.text ?? null,
  };
};

const findRoutine: Find = async (db, orgId, { id, field }) => {
  const column = field === "name" ? routines.name : routines.prompt;
  const where = and(eq(routines.id, id), eq(routines.orgId, orgId), isNull(routines.deletedAt));
  const [r] = await db
    .select({ has: filled(column) })
    .from(routines)
    .where(where);
  if (!r) return null;
  return {
    direct: false,
    confidential: false,
    has: r.has,
    failure: false,
    // The app shows a routine's name to whoever sees it, and its instructions only to who reads it.
    seenBy: (userId) =>
      passes(async () => {
        const view = await getRoutineView(db, userId, orgId, id);
        if (field !== "name" && view.prompt === null) throw new ForbiddenError();
      }),
    ofRun: async (run) =>
      (
        await db
          .select({ id: routineRuns.id })
          .from(routineRuns)
          .where(and(eq(routineRuns.routineId, id), eq(routineRuns.agentRunId, run.id)))
          .limit(1)
      ).length > 0,
    text: async () => (await db.select({ text: column }).from(routines).where(where))[0]?.text ?? null,
  };
};

const findTask: Find = async (db, orgId, { id, field }) => {
  const column = { command: machineTasks.command, prompt: machineTasks.prompt, result: machineTasks.result }[field];
  if (!column) return null;
  const where = and(
    eq(machineTasks.id, id),
    eq(machineTasks.orgId, orgId),
    conversationStands('"machine_tasks"."channel_id"'),
  );
  const [t] = await db
    .select({
      agentId: machineTasks.agentId,
      channelId: machineTasks.channelId,
      runId: machineTasks.runId,
      direct: directOf('"machine_tasks"."channel_id"', firingOf('"machine_tasks"."run_id"')),
      confidential: sql<boolean>`exists (
        select 1 from ${agentRuns} r where r.id = ${taskRunSql(sql`"machine_tasks"."id"`)} and ${confidentialRun})`,
      has: filled(column),
    })
    .from(machineTasks)
    .where(where);
  if (!t) return null;
  return {
    direct: t.direct,
    confidential: t.confidential,
    has: t.has,
    failure: false,
    // What a task was told to do and what it answered are its run's own words: the app shows them in the run's
    // steps, never on the task's card.
    seenBy: (userId) => readsRunsOf(db, orgId, userId, t.agentId, t.channelId),
    ofRun: (run) => t.runId === run.id,
    text: async () => (await db.select({ text: column }).from(machineTasks).where(where))[0]?.text ?? null,
  };
};

const findChannel: Find = async (db, orgId, { id }) => {
  // A direct conversation's and a task's conversation's stored names are made up by the server: nothing to read.
  const where = and(
    eq(channels.id, id),
    eq(channels.orgId, orgId),
    eq(channels.kind, "channel"),
    isNull(channels.deletedAt),
  );
  const [c] = await db
    .select({ has: filled(channels.name) })
    .from(channels)
    .where(where);
  if (!c) return null;
  return {
    direct: false,
    confidential: false,
    has: c.has,
    failure: false,
    seenBy: (userId) => passes(() => requireChannelAccess(db, userId, orgId, id)),
    ofRun: () => false,
    text: async () => (await db.select({ text: channels.name }).from(channels).where(where))[0]?.text ?? null,
  };
};

/** A server's address as people are shown it: its host, never a path, a query or who signs in. */
function hostOf(serverUrl: string): string | null {
  try {
    return new URL(serverUrl).hostname || null;
  } catch {
    return null;
  }
}

const findConnection: Find = async (db, orgId, { id, field }) => {
  const cc = connectorConnections;
  const column = { label: cc.label, host: cc.serverUrl, last_error: cc.lastError }[field];
  if (!column) return null;
  const where = and(eq(cc.id, id), eq(cc.orgId, orgId), isNull(cc.revokedAt));
  const [c] = await db
    .select({ has: filled(column), owner: cc.ownerUserId })
    .from(cc)
    .where(where);
  if (!c) return null;
  return {
    direct: false,
    confidential: false,
    has: c.has,
    failure: false,
    // A person's own connection is opened by that person alone (ADR 0099 addendum).
    seenBy: async (userId) =>
      c.owner ? c.owner === userId : passes(() => requirePermission(db, userId, orgId, "read")),
    ofRun: () => false,
    text: async () => {
      const text = (await db.select({ text: column }).from(cc).where(where))[0]?.text ?? null;
      return field === "host" && text ? hostOf(text) : text;
    },
  };
};

const findSupportRequest: Find = async (db, orgId, { id, field, requestId }) => {
  const column = field === "about" ? supportRequests.about : supportRequests.text;
  const where = and(eq(supportRequests.id, id), eq(supportRequests.orgId, orgId));
  const [r] = await db
    .select({ has: filled(column) })
    .from(supportRequests)
    .where(where);
  if (!r) return null;
  return {
    direct: false,
    confidential: false,
    has: r.has,
    failure: false,
    // Its own request opens it, and no other member's does.
    seenBy: async () => id === requestId,
    ofRun: () => false,
    text: async () => (await db.select({ text: column }).from(supportRequests).where(where))[0]?.text ?? null,
  };
};

const FIND: Record<RevealKind, Find> = {
  message: findMessage,
  run_step: findStep,
  agent: findAgent,
  routine: findRoutine,
  task: findTask,
  channel: findChannel,
  connection: findConnection,
  support_request: findSupportRequest,
};

/** A support request of this workspace young enough to open anything, or null. */
async function openRequest(db: Database, orgId: string, requestId: string, now: Date) {
  const [request] = await db
    .select({
      id: supportRequests.id,
      userId: supportRequests.userId,
      source: supportRequests.source,
      createdAt: supportRequests.createdAt,
    })
    .from(supportRequests)
    .where(
      and(
        eq(supportRequests.id, requestId),
        eq(supportRequests.orgId, orgId),
        gt(supportRequests.createdAt, new Date(now.getTime() - REVEAL_REQUEST_DAYS * DAY_MS)),
      ),
    );
  if (!request) throw refused("no_request", "No support request of this workspace by this id in the last 30 days");
  return request;
}

// Waiting on something nobody in the workspace is asked to move: its computer, its agent's line of long work, its
// plan, its budget, a provider's outage. A run that waits for a person's answer or approval is that person's to move.
const STANDS_STILL = new Set([
  "queued",
  "running",
  "waiting_computer",
  "waiting_line",
  "waiting_plan",
  "waiting_budget",
  "waiting_outage",
]);

async function faultRun(db: Database, orgId: string, runId: string, now: Date): Promise<FaultRun | null> {
  const [run] = await db
    .select({
      id: agentRuns.id,
      agentId: agentRuns.agentId,
      triggerMessageId: agentRuns.triggerMessageId,
      status: agentRuns.status,
      shown: runShownSql,
      createdAt: agentRuns.createdAt,
      startedAt: agentRuns.startedAt,
      workingSince: agentRuns.workingSince,
      updatedAt: agentRuns.updatedAt,
      failedStep: sql<boolean>`exists (select 1 from ${agentRunSteps} where ${agentRunSteps.runId} = agent_runs.id
        and (${agentRunSteps.kind} = 'error'
          or (${agentRunSteps.kind} = 'tool_result' and ${agentRunSteps.data}->'isError' = 'true'::jsonb)))`,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));
  if (!run) return null;
  // Since when it stands as it does: a queued run since it was made, a working one since its work now began (it
  // counts again from each thing it posts), a waiting one since its row last moved.
  const since =
    run.status === "queued"
      ? run.createdAt
      : run.status === "running"
        ? (run.workingSince ?? run.startedAt ?? run.createdAt)
        : run.updatedAt;
  const stuck = STANDS_STILL.has(run.shown) && now.getTime() - since.getTime() > REVEAL_STUCK_MS;
  return { ...run, open: run.status === "failed" || stuck };
}

/** `fault`: the run failed or stands still, in its days, and the record hangs on it. Returns what the record names. */
async function checkFault(db: Database, orgId: string, input: RevealInput, found: Found, now: Date) {
  const request = input.requestId ? await openRequest(db, orgId, input.requestId, now) : null;
  const run = await faultRun(db, orgId, input.runId ?? "", now);
  const days = REVEAL_FAULT_DAYS * DAY_MS;
  const age = (until: Date) => until.getTime() - (run?.createdAt.getTime() ?? 0);
  // A member's report must not outlive the run it is about: the days count back from a report made after the run.
  // One made before it is about something else, and moves nothing.
  const reported = request ? age(request.createdAt) : -1;
  const inDays = run && (age(now) <= days || (reported >= 0 && reported <= days));
  if (!run || !inDays || !(run.open || run.failedStep)) {
    throw refused("no_fault", "No run of this workspace by this id failed or got stuck in its 14 days");
  }
  const itsOwn = await found.ofRun(run);
  // A run that went on past one failure opens that failure, never the rest of itself.
  if (!itsOwn || !(run.open || found.failure)) {
    throw refused("not_the_fault", "This is not something the failed or stuck run is about");
  }
  if (found.direct) throw refused("direct_conversation", "A direct conversation is not read to diagnose a run");
  return { member: null, facts: { runId: run.id, ...(request ? { requestId: request.id } : {}) } };
}

/** `member_request`: the request is this workspace's and young, its member is still one, and reads the record now. */
async function checkMemberRequest(db: Database, orgId: string, input: RevealInput, found: Found, now: Date) {
  const request = await openRequest(db, orgId, input.requestId ?? "", now);
  await requireRequester(db, orgId, request.userId);
  if (!(await found.seenBy(request.userId))) {
    throw refused("not_visible", "Who asked can't read this in the app");
  }
  const source = listedOf(SUPPORT_SOURCES, request.source);
  return { member: request.userId, facts: { requestId: request.id, ...(source ? { source } : {}) } };
}

/**
 * `trust_safety`: no record of the workspace proves an abuse investigation, so none is asked for. Whether the operator
 * had cause is its own service's to answer for. What no such read opens: what people said to each other in a direct
 * conversation, and a support request's words, which open to that request alone.
 */
function checkSafety(input: RevealInput, found: Found) {
  if (input.kind === "support_request") {
    throw refused("not_visible", "A support request's words open to that request alone");
  }
  if (found.direct && found.ofPeople) {
    throw refused("direct_conversation", "What people said to each other in a direct conversation is not read");
  }
  return { member: null, facts: {} };
}

/** How many reads the door gave in the last day, counted from the events they wrote: `of` a workspace, or a purpose. */
async function readsToday(db: Database, now: Date, of: SQL) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(operatorEvents)
    .where(
      and(
        eq(operatorEvents.type, "content.viewed"),
        gt(operatorEvents.createdAt, new Date(now.getTime() - DAY_MS)),
        sql`${operatorEvents.data}->>'ref' like 'reveal:%'`,
        of,
      ),
    );
  return row?.n ?? 0;
}

/**
 * Reads one field of one record of a workspace for its operator. In order: the request's shape; the workspace's
 * day, and for a safety review the instance's; the record, in this workspace and not deleted (one answer for another
 * workspace's and for nobody's); the purpose's check; whether a confidential thread keeps it (ADR 0190); the record
 * of the read, committed; and only then the text, masked whole and cut.
 */
export async function operatorReveal(
  db: Database,
  orgId: string,
  input: RevealInput,
  now = new Date(),
): Promise<Revealed> {
  checkShape(input);
  // ponytail: two reads at the same instant can pass one over the day's count; a lock on the workspace if it matters.
  if ((await readsToday(db, now, eq(operatorEvents.orgId, orgId))) >= REVEAL_PER_WORKSPACE_DAY) {
    throw new TooManyError(
      `This workspace's ${REVEAL_PER_WORKSPACE_DAY} reads of the last 24 hours are used`,
      "reveal.limit_workspace",
    );
  }
  // ponytail: two such reads at one instant can pass one over the day's count; a lock on the instance if it matters.
  const untold = sql`${operatorEvents.data}->>'purpose' = 'trust_safety'`;
  if (input.purpose === "trust_safety" && (await readsToday(db, now, untold)) >= REVEAL_UNTOLD_PER_DAY) {
    throw new TooManyError(
      `This server's ${REVEAL_UNTOLD_PER_DAY} reads for a safety review in the last 24 hours are used: each frees 24 hours after it was made`,
      "reveal.limit_untold",
    );
  }
  const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgId));
  const found = org ? await FIND[input.kind](db, orgId, input) : null;
  const anError = input.field === "error" || input.field === "last_error";
  if (found && !found.has && anError) {
    throw new ConflictError("Nothing failed there: it holds no error", "reveal.no_error");
  }
  if (!found?.has) throw noSuchRecord();

  const { member, facts } =
    input.purpose === "fault"
      ? await checkFault(db, orgId, input, found, now)
      : input.purpose === "member_request"
        ? await checkMemberRequest(db, orgId, input, found, now)
        : checkSafety(input, found);
  // Told only to a caller whose proof holds, as a direct conversation is.
  if (found.confidential) {
    throw refused("confidential", "What a run of a confidential thread holds is read only in that thread");
  }

  const { kind, id, seq, field, offset, limit, purpose, assistedByAi } = input;
  await db.transaction(async (tx) => {
    await recordContentViewed(tx, {
      orgId,
      ref: `reveal:${kind}:${id}${seq === undefined ? "" : `:${seq}`}`,
      reason: pgSafeText(input.reason).trim(),
      operator: pgSafeText(input.operator),
      purpose,
      field,
      assistedByAi,
      ...facts,
    });
    // A safety review tells the workspace nothing at the time: its operator discloses it afterwards.
    if (purpose === "trust_safety") return;
    await recordAudit(tx, {
      orgId,
      actor: { type: "system", id: null },
      action: "operator.content_read",
      // Administrators read every audit entry: of two other people's conversation it says a read was made and at
      // whose request, never which message.
      target: { type: kind, id: found.direct ? null : id },
      details: {
        field,
        ...(found.direct ? { direct: true } : seq === undefined ? {} : { seq }),
        offset,
        limit,
        purpose,
        assistedByAi,
        ...facts,
        // Who "the operator" is to the workspace's people: the apps name agentes.chat's own support there.
        ...cloudNotice(),
      },
      onBehalfOfUserId: member,
    });
  });

  const whole = neutralizeUntrusted(redactCredentials((await found.text()) ?? ""));
  const rest = whole.slice(offset);
  // A window of one that would stop before a pair gives the pair: the next read starts past what this one gave.
  const text = cutText(rest, limit) || rest.slice(0, 2);
  return { kind, id, field, text, chars: whole.length, offset, more: offset + text.length < whole.length };
}

export interface DisclosureInput {
  from: Date;
  to: Date;
  /** How many items were read: a whole number from 1 to `DISCLOSURE_MAX_COUNT`, which the route's schema holds it to. */
  count: number;
}

/**
 * An operator that read content to investigate suspected abuse tells the workspace afterwards that it did: one entry
 * in the workspace's audit log, with the period and how many items, and nothing else. The count is the operator's
 * word: nothing here checks it against what was read. The same period again answers the entry first written and
 * writes nothing, so a call that timed out can be sent again. Null: no such workspace.
 */
export async function operatorDisclose(db: Database, orgId: string, input: DisclosureInput, now = new Date()) {
  const [from, to] = [input.from.getTime(), input.to.getTime()];
  // A minute's grace: the caller's clock may run ahead of this server's.
  if (!(from < to) || to > now.getTime() + 60_000 || to - from > DISCLOSURE_MAX_DAYS * DAY_MS) {
    throw new ValidationError(
      `from, to: a period that has ended, from before to, of at most ${DISCLOSURE_MAX_DAYS} days`,
    );
  }
  if (!(await orgExists(db, orgId))) return null;
  const period = { from: input.from.toISOString(), to: input.to.toISOString() };
  return db.transaction(async (tx) => {
    // One at a time per workspace: a call sent again while the first is still being written finds its entry.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`content-review:${orgId}`}))`);
    const [first] = await tx
      .select({ count: sql<number>`(${auditLog.details}->>'count')::int` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, orgId),
          eq(auditLog.actorType, "system"),
          isNull(auditLog.actorId),
          eq(auditLog.action, CONTENT_REVIEW_DISCLOSED),
          sql`${auditLog.details}->>'from' = ${period.from}`,
          sql`${auditLog.details}->>'to' = ${period.to}`,
        ),
      )
      .limit(1);
    if (first) return { ...period, count: first.count };
    await recordAudit(tx, {
      orgId,
      actor: { type: "system", id: null },
      action: CONTENT_REVIEW_DISCLOSED,
      target: { type: "organization", id: null },
      // Who "the operator" is to the workspace's people: the apps name agentes.chat's own support there.
      details: { ...period, count: input.count, ...cloudNotice() },
    });
    return { ...period, count: input.count };
  });
}
