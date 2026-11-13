import { schema } from "@agenteschat/db";
import {
  BILLING_HOLDS,
  OPERATOR_EXPLAIN_AGENTS,
  OPERATOR_EXPLAIN_SKIPS,
  OPERATOR_EXPLAIN_VERDICTS,
  OPERATOR_JOB_ERROR_MAX,
  OPERATOR_RUN_ERROR_MAX,
  OPERATOR_RUN_ERROR_TEXTS,
  OPERATOR_RUN_ERRORS_DAYS,
  OPERATOR_RUN_SHOWN,
  OPERATOR_TOOL_CALL_DAYS,
  OPERATOR_TOOL_CALL_GROUPS,
  OPERATOR_TOOL_CALL_MAX_DAYS,
  OPERATOR_TOOL_OUTCOMES,
  OPERATOR_TRACE_ASKS,
  OPERATOR_TRACE_JOBS,
  OPERATOR_UNANSWERED_DAYS,
  OPERATOR_UNANSWERED_MAX_DAYS,
  OPERATOR_UNANSWERED_OUTCOMES,
  type OperatorRun,
  operatorExplainMessage,
  operatorRunErrors,
  operatorRuns,
  operatorRunTrace,
  operatorTimeline,
  operatorToolCallCounts,
  operatorToolCalls,
  operatorUnanswered,
  operatorUnansweredCounts,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { iso, json, OrgParams } from "../routes/app/context";
import type { OperatorDeps } from "./app";
import { Next, paging, word } from "./lookups";
import { StandingState } from "./standing";

const tags = ["Operator"];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong token"),
  404: errorResponse("Not found"),
};

export const Time = z.string().openapi({ description: "ISO 8601, UTC." });
export const Instant = z.iso.datetime({ offset: true });
export const Count = z.number().int().min(0);

const RunStatus = z.enum(schema.agentRunStatusEnum.enumValues);

const Run = z
  .object({
    id: z.uuid(),
    orgId: z.uuid(),
    agentId: z.uuid(),
    channelId: z.uuid(),
    threadRootId: z.uuid().openapi({ description: "The thread it answers in: its trigger's, or the trigger itself." }),
    triggerMessageId: z.uuid(),
    replyMessageId: z.uuid().nullable(),
    trigger: z.enum(schema.agentRunTriggerEnum.enumValues).openapi({
      description: "`mention`, `dm` (a direct conversation) or `router` (nobody was named and the router picked it).",
    }),
    hop: z.number().int().openapi({ description: "Agents' replies in a row up to its own: 1 answers a person." }),
    background: z.boolean().openapi({ description: "A routine's run: it holds no conversation." }),
    brain: z.string().nullable().openapi({
      description: "What it thinks with: `model` (a provider's API) or a coding CLI. Null before its first turn.",
    }),
    model: z.string().nullable().openapi({ description: "The model of its latest turn; null before one." }),
    turns: Count.openapi({ description: "Model calls so far." }),
    status: RunStatus.openapi({ description: "As stored." }),
    shown: z.enum(OPERATOR_RUN_SHOWN).openapi({
      description:
        "As people read it. `waiting_input` splits into what it waits for: its computer (`waiting_computer`: away, or in line for room), its agent's line of long work (`waiting_line`), its plan's limit or its budget (`waiting_plan`, `waiting_budget`), a provider's outage (`waiting_outage`), or a person (`waiting_input`). `no_reply`: it ended without answering (it passed in silence, or was canceled before it started).",
    }),
    waitCode: z.string().nullable().openapi({
      description:
        "What it last waited on that isn't a person: `busy`, `machine_offline`, `plan_limit`, `budget`, `usage_pause`, `work_queue`, `provider_outage`… Ignore values you don't know.",
    }),
    waitSource: z.string().nullable().openapi({ description: "A long-work pause's: `plan` or `budget`." }),
    waitResetsAt: Time.nullable().openapi({ description: "When the limit it waits on resets, when known." }),
    waitingMachineId: z.uuid().nullable().openapi({ description: "The computer it waits for." }),
    errorCode: z.string().nullable().openapi({
      description:
        "The app's code for `error`: `run.no_ai`, `run.budget_exceeded`, `run.provider_rate_limit`, `run.cli_failed`, `run.canceled`… and `run.failed` for anything unrecognized.",
    }),
    error: z
      .string()
      .nullable()
      .openapi({
        description: `The stored error's first ${OPERATOR_RUN_ERROR_MAX} characters. A canceled run's names who stopped it.`,
      }),
    createdAt: Time,
    startedAt: Time.nullable(),
    finishedAt: Time.nullable(),
    heartbeatAt: Time.nullable().openapi({
      description: "Last sign of life from the worker running it; old on a `running` run means that worker is gone.",
    }),
  })
  .openapi("OperatorRun");

const RunQuery = z.object({
  agentId: z.uuid().optional(),
  channelId: z.uuid().optional(),
  threadRootId: z.uuid().optional(),
  status: RunStatus.optional().openapi({ description: "As stored." }),
  errorCode: z.string().trim().min(1).max(100).optional().openapi({
    description: "Only runs whose `errorCode` is this one.",
  }),
  from: Instant.optional().openapi({ description: "Created at or after." }),
  to: Instant.optional().openapi({ description: "Created before." }),
  groupBy: z
    .enum(["error"])
    .optional()
    .openapi({
      description: `Counts by \`errorCode\` instead of runs, over the last ${OPERATOR_RUN_ERRORS_DAYS} days unless \`from\` says. \`limit\` and \`cursor\` don't apply.`,
    }),
  ...paging,
});

const RunPage = z.object({ runs: z.array(Run), next: Next }).openapi("OperatorRunPage");
const RunErrors = z
  .object({
    from: Time,
    to: Time,
    errors: z
      .array(z.object({ errorCode: z.string(), runs: Count, firstAt: Time, lastAt: Time }))
      .openapi({ description: "Most runs first. `firstAt` and `lastAt`: when the first and the last such run began." }),
    more: z.boolean().openapi({
      description: `The range holds over ${OPERATOR_RUN_ERROR_TEXTS} different stored errors: the rarest are left out.`,
    }),
  })
  .openapi("OperatorRunErrors");

const Ask = z
  .object({
    kind: z.enum(["approval", "question", "secret"]).openapi({
      description: "An action to approve, a question to a person, or a secret asked for its computer.",
    }),
    id: z.uuid(),
    runId: z.uuid().nullable(),
    agentId: z.uuid(),
    threadRootId: z.uuid().nullable().openapi({ description: "Null: asked in the conversation's main timeline." }),
    tool: z.string().nullable().openapi({ description: "An approval's: the tool it would run." }),
    status: z.string().openapi({
      description:
        "An approval's `pending`, `approved`, `refused`, `expired` or `canceled`; a question's `open`, `answered`, `expired`, `canceled` or `dismissed`; a secret's `pending`, `delivered`, `declined`, `expired` or `canceled`.",
    }),
    createdAt: Time,
    expiresAt: Time,
    resolvedAt: Time.nullable().openapi({ description: "When it was decided, answered or delivered." }),
    byUserId: z.string().nullable().openapi({ description: "Who decided or answered it." }),
  })
  .openapi("OperatorAsk");

export const Job = z
  .object({
    id: z.uuid(),
    orgId: z
      .uuid()
      .nullable()
      .openapi({ description: "Null: a job of no workspace (an email to someone signing up)." }),
    kind: z.string(),
    status: z.enum(schema.outboxStatusEnum.enumValues),
    attempts: Count,
    maxAttempts: Count,
    nextAttemptAt: Time,
    lockedUntil: Time.nullable().openapi({ description: "While `processing`: its worker's lease." }),
    lockedBy: z.string().nullable().openapi({ description: "The worker that last claimed it." }),
    lastError: z
      .string()
      .nullable()
      .openapi({
        description: `Its first ${OPERATOR_JOB_ERROR_MAX} characters; cleared 30 days after the job ended.`,
      }),
    runId: z.uuid().nullable().openapi({ description: "A run's job (`agent_run.execute`): the run." }),
    cause: z.string().nullable().openapi({
      description:
        "A run's job: why it woke the run (`question`, `approval`, `steer`, `outage`, `room`, `recover`, `requeue`…); null for the job that started it.",
    }),
    createdAt: Time,
    completedAt: Time.nullable(),
  })
  .openapi("OperatorJob");

export const Spent = {
  calls: Count.openapi({ description: "Model calls recorded." }),
  input: Count.openapi({ description: "Uncached input tokens." }),
  output: Count,
  cacheRead: Count,
  cacheWrite: Count,
  costUsd: z.number().openapi({ description: "What was billed through an API (a plan's tokens are 0)." }),
};

const BUILT_IN =
  "The Tool Gateway resolved the name to one of the server's own tools, so the name is the server's own word. False for a connected app's tool (a connector's, a mailbox's, a database's), for a name it could not resolve, and for a call made before the server kept this.";
const REFUSAL = "A call the server refused: `policy`, `noAccess`, `credential` or `repo`.";

const TraceQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(200).openapi({ description: "How many steps." }),
  beforeSeq: z.coerce.number().int().min(1).optional().openapi({
    description: "Only steps before this one: the `seq` of the first step of the page after. Absent: the last ones.",
  }),
});

const Trace = z
  .object({
    run: Run,
    steps: z
      .array(
        z.object({
          seq: z.number().int(),
          kind: z.enum(schema.agentRunStepKindEnum.enumValues),
          at: Time,
          tool: z.string().nullable().openapi({ description: "A tool call's and its result's." }),
          builtIn: z
            .boolean()
            .nullable()
            .openapi({ description: `A tool call's and its result's. ${BUILT_IN}` }),
          connector: z.string().nullable().openapi({ description: "A tool call's: the connection the tool is of." }),
          isError: z.boolean().nullable().openapi({ description: "A tool result's." }),
          refusal: z
            .string()
            .nullable()
            .openapi({ description: `A tool result's. ${REFUSAL}` }),
          code: z.string().nullable().openapi({ description: "An error's, or a tool result's own." }),
          reason: z.string().nullable().openapi({
            description:
              "An error's: `transient`, `provider_outage`, `brain_unavailable`, `usage_wait`, `canceled`, `gave_up`, `recovered`, `interrupted`…",
          }),
          model: z.string().nullable().openapi({ description: "A model call's." }),
          stopReason: z.string().nullable().openapi({ description: "A model call's." }),
          chars: Count.nullable().openapi({
            description: "How long a tool call's input and a tool result's text are, never either of them.",
          }),
          durationMs: Count.nullable().openapi({
            description: "A tool result's: since its call; null when the call is on an earlier page.",
          }),
          messageId: z.uuid().nullable().openapi({ description: "A `message` step's: the reply it posted." }),
          records: z.array(z.string()).openapi({
            description:
              "A `context` step's: the names of what it noted (`autoModel`, `brainFallback`, `passed`, `steeredMessageIds`…), never the notes.",
          }),
        }),
      )
      .openapi({ description: "In order. Never a tool's input or result, a model's words or a prompt." }),
    stepCount: Count.openapi({ description: "How many steps the run has in all." }),
    asks: z.array(Ask).openapi({
      description: `What it asked of people, oldest first, at most ${OPERATOR_TRACE_ASKS} of each kind.`,
    }),
    jobs: z.array(Job).openapi({ description: `Newest first, at most ${OPERATOR_TRACE_JOBS}.` }),
    moreJobs: z.boolean(),
    usage: z.object({
      ...Spent,
      byModel: z.array(
        z.object({
          provider: z.string(),
          model: z.string(),
          billedTo: z.string().openapi({ description: "`org`, `platform` or `plan`." }),
          ...Spent,
        }),
      ),
    }),
    machine: z
      .object({
        id: z.uuid(),
        name: z.string(),
        kind: z.enum(["connected", "host", "managed"]),
        online: z.boolean(),
        lastSeenAt: Time.nullable(),
        from: z.enum(["waiting", "usage", "agent"]).openapi({
          description:
            "How it is known: the computer the run waits for, the one its plan's usage names, or its agent's computer now, which may not be where it ran.",
        }),
      })
      .nullable()
      .openapi({ description: "The computer it is tied to; null: none." }),
  })
  .openapi("OperatorRunTrace");

const ToolOutcome = z.enum(OPERATOR_TOOL_OUTCOMES);

const ToolCallQuery = z.object({
  agentId: z.uuid().optional(),
  runId: z.uuid().optional().openapi({
    description: "One run's calls: from when it began unless `from` says, however long ago.",
  }),
  tool: word().optional().openapi({ description: "Part of a tool's name; any case, matched literally." }),
  outcome: ToolOutcome.optional(),
  from: Instant.optional().openapi({
    description: `Called at or after. Default: ${OPERATOR_TOOL_CALL_DAYS} days before \`to\`.`,
  }),
  to: Instant.optional().openapi({
    description: `Called before. Default: now. At most ${OPERATOR_TOOL_CALL_MAX_DAYS} days after \`from\`.`,
  }),
  groupBy: z.enum(OPERATOR_TOOL_CALL_GROUPS).optional().openapi({
    description: "Counts by tool, by agent or by outcome instead of calls. `limit` is how many groups; no `cursor`.",
  }),
  ...paging,
});

const ToolCall = z
  .object({
    at: Time,
    runId: z.uuid(),
    agentId: z.uuid(),
    seq: z.number().int().openapi({ description: "The call's step in its run's trace." }),
    tool: z.string().nullable(),
    builtIn: z.boolean().openapi({ description: BUILT_IN }),
    connector: z
      .string()
      .nullable()
      .openapi({ description: "The connection the tool is of, as its workspace named it." }),
    connectorKind: z.string().nullable().openapi({
      description:
        "The service a connected app's tool works in, from the server's catalog (`github`, `gmail`, `postgres`…); null for a server connected by address and for the server's own tools.",
    }),
    outcome: ToolOutcome.openapi({
      description:
        "`ok`; `error` (the tool failed, or the server turned the call down in words alone); `refused` (see `refusal`); `pending` (no result yet: it waits for a person, still runs, or was cut off).",
    }),
    refusal: z.string().nullable().openapi({ description: REFUSAL }),
    code: z.string().nullable().openapi({ description: "The result's own code, when it has one." }),
    durationMs: Count.nullable().openapi({ description: "From the call to its result." }),
    inputChars: Count.openapi({ description: "How long its input is: the input is never returned." }),
    resultChars: Count.nullable().openapi({ description: "How long its result is: the result is never returned." }),
  })
  .openapi("OperatorToolCall");

const ToolCallPage = z
  .object({ from: Time, to: Time, calls: z.array(ToolCall), next: Next })
  .openapi("OperatorToolCallPage");
const ToolCallCounts = z
  .object({
    from: Time,
    to: Time,
    groups: z
      .array(
        z.object({
          group: z.string().nullable().openapi({ description: "The tool's name, the agent's id or the outcome." }),
          builtIn: z.boolean().nullable().openapi({
            description: "By tool: some call of that name in the range was of the server's own tool. Null otherwise.",
          }),
          calls: Count,
          errors: Count,
          refused: Count,
          pending: Count,
        }),
      )
      .openapi({ description: "Most calls first." }),
    more: z.boolean().openapi({ description: "There are more groups than `limit`: narrow the dates or the filters." }),
  })
  .openapi("OperatorToolCallCounts");

const RunParams = z.object({ runId: z.uuid().openapi({ param: { name: "runId", in: "path" } }) });
const MessageParams = z.object({ messageId: z.uuid().openapi({ param: { name: "messageId", in: "path" } }) });

const messageFacts = {
  id: z.uuid(),
  at: Time,
  threadRootId: z.uuid().nullable().openapi({ description: "The thread it replies in; null outside any." }),
  authorType: z.enum(schema.authorTypeEnum.enumValues),
  authorUserId: z.string().nullable(),
  authorAgentId: z.uuid().nullable(),
  runId: z.uuid().nullable().openapi({ description: "The run that wrote it." }),
  hop: z.number().int(),
  length: Count.openapi({ description: "How many characters it has: its text is never returned." }),
  mentionedAgentIds: z.array(z.uuid()),
  mentionedUserIds: z.array(z.string()),
  flags: z.array(z.string()).openapi({
    description:
      "The names of what the server attached to it (`steeredRunIds`, `answersQuestionId`, `replyTo`, `artifacts`, `notice`, `noAi`, `actionCard`…), never what they hold.",
  }),
  edited: z.boolean(),
  deleted: z.boolean(),
};

const routingFacts = {
  id: z.uuid(),
  messageId: z.uuid(),
  at: Time,
  strategy: z.string().openapi({
    description:
      "Who decided: a router's step (`jev`, `llm:<model>`, `rule:<name>`), `none` (no step could read it), `no_ai`, `plan_hold`, a mention's judge (`addressees-…`, `mention-…`) or `reach`.",
  }),
  candidates: z.array(z.object({ agentId: z.uuid(), score: z.number() })),
  needsAgentScore: z.number().nullable(),
  selectedAgentIds: z.array(z.uuid()),
  reasonCodes: z.array(z.string()).openapi({
    description:
      "The router's own marks on the pick (`follow-up`, `default`, `alone`, `talking to`, `for people`, `held back`…), never a model's words about the message.",
  }),
  error: z
    .string()
    .nullable()
    .openapi({
      description: `\`no_ai\`, \`platform_cap\`, or the steps that failed before one decided, cut to ${OPERATOR_JOB_ERROR_MAX} characters.`,
    }),
};

const TimelineQuery = z.object({
  channelId: z.uuid().optional().openapi({ description: "The conversation. Or `messageId`: one of the two." }),
  messageId: z.uuid().optional().openapi({ description: "A message: its conversation, around when it was written." }),
  from: Instant.optional().openapi({
    description: "Default: 6 hours before `to`; with `messageId`, 3 hours before the message.",
  }),
  to: Instant.optional().openapi({
    description: "Default: now; with `messageId`, 3 hours after the message. At most 48 hours after `from`.",
  }),
  ...paging,
});

const Timeline = z
  .object({
    channelId: z.uuid(),
    from: Time,
    to: Time,
    events: z
      .array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("message"), ...messageFacts }),
          z.object({ type: z.literal("routing"), ...routingFacts }),
          z.object({ type: z.literal("run"), at: Time, ...Run.shape }),
          z.object({ type: z.literal("ask"), at: Time, ...Ask.shape }),
        ]),
      )
      .openapi({ description: "Oldest first. A run and an ask are listed when they began." }),
    next: Next,
  })
  .openapi("OperatorTimeline");

const Explained = z
  .object({
    message: z.object({
      ...messageFacts,
      orgId: z.uuid(),
      channelId: z.uuid(),
      channelKind: z.string().nullable().openapi({ description: "`channel`, `dm` or `task`." }),
    }),
    verdict: z.enum(OPERATOR_EXPLAIN_VERDICTS).openapi({
      description:
        "`run`: it started a run (see `agents`). `joined`: a run already at work took it. `answered_question`: it answered an agent's question, which resumed that run. `mission_suggestion`: a suggestion in a mission's thread, for its owner to decide. `kept_on_hold`: kept until the workspace has a plan. `no_ai`: the workspace had no AI connected. `platform_cap`: the workspace used up its AI for the month. `blocked`: the agents it mentions don't answer its author. `referenced_only`: it mentions agents only as part of a request to someone else. `nobody_picked`: the router picked nobody. `picked_not_started`: a decision picked agents and no run of theirs took it (held by a limit on agents' own work, kept for a later look, or the agent gone since). `job_pending`, `job_failed`: the job that routes it hasn't run, or failed. `not_routed`: nothing was decided for it (see `skipped`).",
    }),
    skipped: z.enum(OPERATOR_EXPLAIN_SKIPS).nullable().openapi({
      description:
        "With `not_routed`, why, worked out as things are now (the router's own exits aren't stored): `workspace_deleting`, `workspace_paused`, `never_queued` (it never went to routing: a GIF alone, an agent's message past the hop where others chime in), `direct_conversation` (never routed: its agent answers), `hop_limit`, `no_candidates` (no agent here answers unnamed messages from this person), or `unknown`.",
    }),
    handles: z
      .object({
        agentIds: z.array(z.uuid()).openapi({ description: "Agents whose handle, or a former one, it writes." }),
        userIds: z.array(z.string()).openapi({ description: "Members whose handle it writes." }),
        unknown: Count.openapi({ description: "`@words` that name nobody in the workspace: how many, never which." }),
      })
      .openapi({ description: "The `@handles` read in its text now." }),
    agents: z
      .array(
        z.object({
          agentId: z.uuid(),
          name: z.string(),
          handle: z.string(),
          named: z.boolean().openapi({ description: "Its handle is written in the message." }),
          mentioned: z.boolean().openapi({
            description: "Stored as mentioned: it was active and in the conversation when the message was written.",
          }),
          referenced: z.boolean().openapi({
            description: "Mentioned only as part of a request to another agent: no run, by design.",
          }),
          candidate: z.boolean().openapi({ description: "The routing decision weighed it." }),
          score: z.number().nullable(),
          selected: z.boolean().openapi({ description: "The routing decision picked it." }),
          outcome: z.enum(["run", "joined", "answered_question", "none"]),
          run: Run.nullable().openapi({ description: "The run that answers the message for this agent." }),
          now: z
            .object({
              archived: z.boolean(),
              held: z.boolean().openapi({ description: "On the operator's hold." }),
              inChannel: z.boolean(),
              autoReply: z.boolean().nullable().openapi({
                description: "It may answer messages here that don't mention it; null: not a member.",
              }),
              mayTalk: z.boolean().nullable().openapi({
                description: "The author may talk to it here; null when an agent wrote the message.",
              }),
              overBudget: z.boolean().openapi({ description: "Its monthly budget is spent." }),
            })
            .openapi({ description: "As things are now, not as they were when the message was written." }),
        }),
      )
      .openapi({
        description: `The agents the message concerns, then the conversation's others, at most ${OPERATOR_EXPLAIN_AGENTS}.`,
      }),
    routing: z.object(routingFacts).nullable().openapi({ description: "Null: no decision was stored for it." }),
    workspace: z
      .object({
        standing: StandingState,
        billingHold: z.enum(BILLING_HOLDS).nullable().openapi({
          description: "A hold a billing service set: no plan yet, a failed payment, or a plan that ended.",
        }),
        deleting: z.boolean(),
      })
      .openapi({ description: "As it is now." }),
    postedJob: Job.nullable().openapi({
      description: "The job that routes the message (`message.posted`); null: it was never queued.",
    }),
  })
  .openapi("OperatorMessageExplained");

const UnansweredOutcome = z.enum(OPERATOR_UNANSWERED_OUTCOMES);

const UnansweredQuery = z.object({
  channelId: z.uuid().optional().openapi({ description: "Only this conversation's." }),
  outcome: UnansweredOutcome.optional(),
  from: Instant.optional().openapi({
    description: `Written at or after. Default: ${OPERATOR_UNANSWERED_DAYS} day before \`to\`.`,
  }),
  to: Instant.optional().openapi({
    description: `Written before. Default: now. At most ${OPERATOR_UNANSWERED_MAX_DAYS} days after \`from\`.`,
  }),
  summary: z.stringbool().optional().openapi({
    description: "`true`: counts by outcome instead of messages. `limit` and `cursor` don't apply.",
  }),
  ...paging,
});

const UNANSWERED =
  "Why no run answered it, as `GET /messages/{messageId}/explain` tells it (its `verdict`) from what is stored.";

const UnansweredPage = z
  .object({
    from: Time,
    to: Time,
    messages: z.array(
      z.object({
        id: z.uuid(),
        at: Time,
        channelId: z.uuid(),
        threadRootId: z.uuid().nullable().openapi({ description: "The thread it replies in; null outside any." }),
        authorUserId: z.string().nullable(),
        outcome: UnansweredOutcome.openapi({ description: UNANSWERED }),
        strategy: z.string().nullable().openapi({
          description: "Who decided its routing, as the timeline names it; null: no decision was stored for it.",
        }),
      }),
    ),
    next: Next,
  })
  .openapi("OperatorUnansweredPage");
const UnansweredCounts = z
  .object({
    from: Time,
    to: Time,
    counts: z
      .array(z.object({ outcome: UnansweredOutcome.openapi({ description: UNANSWERED }), messages: Count }))
      .openapi({ description: "Most messages first." }),
  })
  .openapi("OperatorUnansweredCounts");

const runJson = (run: OperatorRun) => ({
  ...run,
  waitResetsAt: iso(run.waitResetsAt),
  createdAt: run.createdAt.toISOString(),
  startedAt: iso(run.startedAt),
  finishedAt: iso(run.finishedAt),
  heartbeatAt: iso(run.heartbeatAt),
});

type Found<T extends (...args: never[]) => unknown> = NonNullable<Awaited<ReturnType<T>>>;

const askJson = (ask: Found<typeof operatorRunTrace>["asks"][number]) => ({
  ...ask,
  createdAt: ask.createdAt.toISOString(),
  expiresAt: ask.expiresAt.toISOString(),
  resolvedAt: iso(ask.resolvedAt),
});

export const jobJson = (job: Found<typeof operatorRunTrace>["jobs"][number]) => ({
  ...job,
  nextAttemptAt: job.nextAttemptAt.toISOString(),
  lockedUntil: iso(job.lockedUntil),
  createdAt: job.createdAt.toISOString(),
  completedAt: iso(job.completedAt),
});

const at = <T extends { at: Date }>(row: T) => ({ ...row, at: row.at.toISOString() });

/**
 * Runs and conversations (ADR 0056, its addendum on them): what a run did and why a message did or did not start
 * one, never what was said, sent to a tool or answered by it. All `GET`.
 */
export function registerOperatorRuns(api: OpenAPIHono, { db, config }: OperatorDeps) {
  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/runs",
      tags,
      summary: "A workspace's runs, newest first; or how many ended with each error",
      request: { params: OrgParams, query: RunQuery },
      responses: { 200: json(z.union([RunPage, RunErrors])), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { groupBy, from, to, ...query } = c.req.valid("query");
      const range = { ...query, from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined };
      if (groupBy) {
        const counted = await operatorRunErrors(db, orgId, range);
        if (!counted) return apiError(c, 404, "not_found", "No workspace with this id");
        return c.json(
          {
            from: counted.from.toISOString(),
            to: counted.to.toISOString(),
            errors: counted.errors.map((e) => ({
              ...e,
              firstAt: e.firstAt.toISOString(),
              lastAt: e.lastAt.toISOString(),
            })),
            more: counted.more,
          },
          200,
        );
      }
      const page = await operatorRuns(db, orgId, range);
      if (!page) return apiError(c, 404, "not_found", "No workspace with this id");
      return c.json({ runs: page.runs.map(runJson), next: page.next }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/runs/{runId}/trace",
      tags,
      summary: "One run from start to end: its steps, what it asked, its jobs, what it spent and its computer",
      description:
        "Which tool each step called, whether it is the server's own, whether it failed and how big its input and result were, never either of them. The steps page back from the end with `beforeSeq`.",
      request: { params: RunParams, query: TraceQuery },
      responses: { 200: json(Trace), ...errors },
    }),
    async (c) => {
      const trace = await operatorRunTrace(db, c.req.valid("param").runId, c.req.valid("query"));
      if (!trace) return apiError(c, 404, "not_found", "No run with this id");
      const { machine } = trace;
      return c.json(
        {
          ...trace,
          run: runJson(trace.run),
          steps: trace.steps.map(at),
          asks: trace.asks.map(askJson),
          jobs: trace.jobs.map(jobJson),
          machine: machine && { ...machine, lastSeenAt: iso(machine.lastSeenAt) },
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/tool-calls",
      tags,
      summary: "The tools a workspace's agents called, newest first; or how many, by tool, agent or outcome",
      description:
        "Which tool, whether it is the server's own, how the call ended and how long it took, with how long its input and its result are, never either of them.",
      request: { params: OrgParams, query: ToolCallQuery },
      responses: { 200: json(z.union([ToolCallPage, ToolCallCounts])), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { groupBy, from, to, ...query } = c.req.valid("query");
      const range = { ...query, from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined };
      const found = groupBy
        ? await operatorToolCallCounts(db, orgId, { ...range, groupBy })
        : await operatorToolCalls(db, orgId, range);
      if (!found) return apiError(c, 404, "not_found", "No such workspace, or no such run in it");
      const dates = { from: found.from.toISOString(), to: found.to.toISOString() };
      return c.json(
        "groups" in found
          ? { ...dates, groups: found.groups, more: found.more }
          : { ...dates, calls: found.calls.map(at), next: found.next },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/timeline",
      tags,
      summary: "What happened in one conversation, in order: messages, routing decisions, runs and what agents asked",
      description:
        "A message is who wrote it, when, how long it is and whom it mentions, never what it says. `channelId` or `messageId` is required.",
      request: { params: OrgParams, query: TimelineQuery },
      responses: { 200: json(Timeline), ...errors },
    }),
    async (c) => {
      const { from, to, ...query } = c.req.valid("query");
      const found = await operatorTimeline(db, c.req.valid("param").orgId, {
        ...query,
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
      });
      if (!found) return apiError(c, 404, "not_found", "No such workspace, conversation or message");
      return c.json(
        {
          channelId: found.channelId,
          from: found.from.toISOString(),
          to: found.to.toISOString(),
          events: found.events.map((e) =>
            e.type === "run" ? at({ ...e, ...runJson(e) }) : e.type === "ask" ? at({ ...e, ...askJson(e) }) : at(e),
          ),
          next: found.next,
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/messages/{messageId}/explain",
      tags,
      summary: "Why a message did or did not start a run",
      description:
        "From what is stored: the runs it started, joined or resumed, the routing decision, the agents it names and the job that routes it. What isn't stored is worked out as things are now and kept apart (`now`, `skipped`, `workspace`).",
      request: { params: MessageParams },
      responses: { 200: json(Explained), ...errors },
    }),
    async (c) => {
      const found = await operatorExplainMessage(db, c.req.valid("param").messageId, {
        maxHops: config.AGENT_MAX_HOPS,
      });
      if (!found) return apiError(c, 404, "not_found", "No message with this id");
      return c.json(
        {
          ...found,
          message: at(found.message),
          agents: found.agents.map((a) => ({ ...a, run: a.run && runJson(a.run) })),
          routing: found.routing && at(found.routing),
          postedJob: found.postedJob && jobJson(found.postedJob),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/unanswered",
      tags,
      summary: "People's messages no run answered, newest first; or how many, by why",
      description:
        "A person's message that started no run, was taken by none already at work and answered no agent's question, with why. A message people wrote to each other is one too (`not_routed`, or `nobody_picked`). Never what a message says.",
      request: { params: OrgParams, query: UnansweredQuery },
      responses: { 200: json(z.union([UnansweredPage, UnansweredCounts])), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { summary, from, to, limit, cursor, ...filters } = c.req.valid("query");
      const range = { ...filters, from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined };
      const found = summary
        ? await operatorUnansweredCounts(db, orgId, range)
        : await operatorUnanswered(db, orgId, { ...range, limit, cursor });
      if (!found) return apiError(c, 404, "not_found", "No workspace with this id");
      const dates = { from: found.from.toISOString(), to: found.to.toISOString() };
      return c.json(
        "counts" in found
          ? { ...dates, counts: found.counts }
          : { ...dates, messages: found.messages.map(at), next: found.next },
        200,
      );
    },
  );
}
