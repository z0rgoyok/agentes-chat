import { ACCOUNT_KINDS, PLAN_WINDOW_KINDS, PROVIDER_FAILURE_CAUSES } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import {
  AI_ACCOUNT_STATUSES,
  AI_ACCOUNT_WINDOWS_MAX,
  AI_ACCOUNTS_RECENT_FAILURES,
  ANALYTICS_LIST_MAX,
  ANALYTICS_MAX_DAYS,
  ANALYTICS_ROWS_MAX,
  ASK_KINDS,
  ASK_MODELS_MAX,
  ASK_OUTCOMES,
  ASK_TIME_BUCKETS,
  ASK_TIMES_MAX_DAYS,
  BREAKDOWN_KINDS,
  CLI_RUNS_MAX_DAYS,
  CLI_RUNS_ROWS_MAX,
  CONNECTOR_KEY,
  operatorAiAccounts,
  operatorAnalytics,
  operatorAskTimes,
  operatorCliRuns,
  operatorConnectorAnalytics,
  operatorListAiAccounts,
  operatorOrgWorkAnalytics,
  operatorReplyTimes,
  operatorRunTimings,
  operatorStageBreakdown,
  operatorWorkAnalytics,
  REPLY_BRAINS,
  REPLY_TIME_BUCKETS,
  REPLY_TIMES_MAX_DAYS,
  REPLY_WAIT_CAUSES,
  RUN_TIMINGS_FLEET_MAX_DAYS,
  RUN_TIMINGS_MAX_DAYS,
  RUN_TIMINGS_ROWS_MAX,
  SHORT_ASK_CHARS,
  STAGE_BREAKDOWN_FLEET_MAX_DAYS,
  STAGE_BREAKDOWN_MAX_DAYS,
  STAGE_BREAKDOWN_MODELS_MAX,
  STAGE_BREAKDOWN_SLOWEST,
  STAGE_GROUPS,
  WORK_ANALYTICS_HOURLY_DAYS,
  WORK_ANALYTICS_MAX_DAYS,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { errorResponse } from "../http/errors";
import { iso, json, OrgParams } from "../routes/app/context";
import type { OperatorDeps } from "./app";

const tags = ["Operator"];
const errors = {
  400: errorResponse("Invalid request (`analytics.range`: the dates)"),
  401: errorResponse("Missing or wrong token"),
};

const Day = z.string().openapi({ description: "A UTC day, YYYY-MM-DD.", example: "2026-10-31" });
const Count = z.number().int().min(0);
const Via = z.enum(["native", "mcp", "composio"]).openapi("OperatorConnectorVia", {
  description:
    "How the connector's tools reach it: `native` our own code (GitHub's git tools, Postgres, IMAP mailboxes), `mcp` an MCP server (the catalog's, one-click presets, custom servers), `composio` this server's own Composio project (Gmail and Outlook mailboxes), which Composio bills.",
});
const Key = z.string().openapi({
  description:
    "The connector's stable key: a catalog connector's or a one-click preset's id (a custom server on a preset's host takes it too), a custom server's hostname (never its path), `gmail`, `outlook`, an IMAP preset's id or `imap`, `postgres`, or a Composio toolkit's slug.",
});
const Label = z.string().openapi({ description: "Its name in the catalog or the presets, else the key." });
const Counters = {
  calls: Count.openapi({ description: "Tool calls that ran, approved ones included." }),
  errors: Count.openapi({ description: "Calls whose result was an error, or whose tool threw." }),
  approvalsAsked: Count.openapi({ description: "Approval requests its calls created." }),
  approvalsGiven: Count.openapi({ description: "Approved actions that ran." }),
};
const Range = z.object({
  from: z.string().openapi({ description: "The first UTC day, YYYY-MM-DD.", example: "2026-10-01" }),
  to: z.string().openapi({
    description: `The last UTC day, YYYY-MM-DD: at most ${ANALYTICS_MAX_DAYS} days, both counted. Else 400 \`analytics.range\`.`,
    example: "2026-10-31",
  }),
});

const ConnectorUse = z
  .object({
    connector: Key,
    label: Label,
    via: Via,
    ...Counters,
    workspaces: Count.openapi({
      description:
        "Workspaces with at least one call. For `composio`, also those Composio billed without one (an execution or a trigger event).",
    }),
    agents: Count.openapi({ description: "Agents with at least one call." }),
    accounts: Count.openapi({ description: "Accounts connected now (servers, installations, mailboxes, databases)." }),
    accountsAdded: Count.openapi({ description: "Of those, the ones connected in the dates." }),
    executions: Count.openapi({ description: "`composio` only: executions Composio answered, each one billed." }),
    executionFailures: Count.openapi({ description: "Of those, the ones Composio answered as failed." }),
    events: Count.openapi({ description: "`composio` only: trigger events delivered (new mail), each one billed." }),
  })
  .openapi("OperatorConnectorUse");

const ComposioCounts = {
  executions: Count,
  failures: Count,
  events: Count,
};

const Analytics = z
  .object({
    from: Day,
    to: Day,
    since: Day.nullable().openapi({ description: "The first day anything was counted here, null before any." }),
    totals: z.object({
      ...Counters,
      workspaces: Count.openapi({ description: "Workspaces with at least one call of any connector." }),
      agents: Count,
    }),
    days: z
      .array(z.object({ day: Day, via: Via, ...Counters, workspaces: Count }))
      .openapi({ description: "Per UTC day and way, oldest first. A day without calls is left out." }),
    connectors: z.array(ConnectorUse).openapi({
      description: `Per connector and way, most calls first (then executions, events and accounts), at most ${ANALYTICS_ROWS_MAX}. One connected but unused in the dates has zero calls.`,
    }),
    connectorsMore: z.boolean().openapi({ description: "More connectors than were listed." }),
    composio: z.object({
      days: z
        .array(z.object({ day: Day, ...ComposioCounts }))
        .openapi({ description: "What this server asked of its Composio project, per UTC day, oldest first." }),
      month: z
        .object({
          month: z.string().openapi({ description: "The UTC calendar month so far, YYYY-MM.", example: "2026-10" }),
          ...ComposioCounts,
          connections: Count.openapi({
            description:
              "Composio connected accounts made this month (mailboxes), reconnects included: Composio bills each once past the free ones.",
          }),
          orgs: z
            .array(
              z.object({
                orgId: z.uuid(),
                connectors: z
                  .array(z.object({ connector: Key, label: Label }))
                  .openapi({ description: "Its Composio connectors this month: called, billed or connected." }),
                calls: Count.openapi({ description: "Its calls of Composio's tools." }),
                errors: Count,
                ...ComposioCounts,
                connections: Count.openapi({ description: "Its connected accounts made this month." }),
              }),
            )
            .openapi({
              description: `Per workspace with a call or something billed this month, most executions first (then events, calls and connections), at most ${ANALYTICS_ROWS_MAX}.`,
            }),
          orgsMore: z.boolean().openapi({ description: "More workspaces than were listed." }),
        })
        .openapi({ description: "This month whatever the dates: Composio's free allowances are monthly." }),
    }),
    product: z.object({
      days: z
        .array(
          z.object({
            day: Day,
            runs: Count.openapi({ description: "Agent runs that ended." }),
            tasks: Count.openapi({ description: "Tasks on computers that ended." }),
            activeWorkspaces: Count.openapi({ description: "Workspaces where a run or a task ended." }),
            newWorkspaces: Count,
            signUps: Count,
          }),
        )
        .openapi({ description: "From the events feed, oldest first. A day without any is left out." }),
      activeWorkspaces: Count.openapi({ description: "Workspaces where a run or a task ended in the dates." }),
      keptDays: z.number().int().openapi({ description: "Days the events feed keeps: older days read as zero." }),
    }),
  })
  .openapi("OperatorAnalytics");

const ConnectorParams = z.object({
  connector: z
    .string()
    .regex(CONNECTOR_KEY)
    .openapi({ param: { name: "connector", in: "path" }, example: "github" }),
});

const ConnectorAnalytics = z
  .object({
    connector: Key,
    label: Label,
    from: Day,
    to: Day,
    days: z
      .array(
        z.object({
          day: Day,
          via: Via,
          calls: Count,
          errors: Count,
          approvals: Count.openapi({ description: "Approval requests its calls created." }),
          executions: Count,
          events: Count,
        }),
      )
      .openapi({ description: "Per UTC day and way, oldest first. Executions and events are `composio`'s." }),
    tools: z
      .array(
        z.object({
          via: Via,
          tool: z.string().openapi({
            description:
              "The server's own tool name (a catalog connector's or a preset's) or our verb. `other` for a custom server's tools, whose owner names them, and for an unusual name.",
          }),
          calls: Count,
          errors: Count,
          approvals: Count,
          workspaces: Count,
        }),
      )
      .openapi({ description: `Most calls first, at most ${ANALYTICS_LIST_MAX}.` }),
    actions: z
      .array(
        z.object({
          action: z
            .string()
            .openapi({ description: "Composio's action or trigger slug.", example: "GMAIL_FETCH_EMAILS" }),
          ...ComposioCounts,
          workspaces: Count,
        }),
      )
      .openapi({ description: `Most executions first, at most ${ANALYTICS_LIST_MAX}.` }),
    orgs: z
      .array(
        z.object({
          orgId: z.uuid(),
          via: Via,
          calls: Count,
          errors: Count,
          approvals: Count,
          executions: Count,
          events: Count,
          agents: Count,
          accounts: Count.openapi({ description: "Its accounts of this connector connected now." }),
          lastDay: Day.nullable().openapi({ description: "Its last day with a count in the dates." }),
        }),
      )
      .openapi({
        description: `Per workspace and way, most calls first, at most ${ANALYTICS_ROWS_MAX}. One connected but idle in the dates has zero calls.`,
      }),
    orgsMore: z.boolean(),
  })
  .openapi("OperatorConnectorAnalytics");

const WorkRange = z.object({
  from: Range.shape.from,
  to: z.string().openapi({
    description: `The last UTC day, YYYY-MM-DD: at most ${WORK_ANALYTICS_MAX_DAYS} days, both counted. Else 400 \`analytics.range\`.`,
    example: "2026-10-31",
  }),
});
const Turns = z
  .object({
    total: Count.openapi({ description: "Agent turns (runs) created in the bucket." }),
    person: Count.openapi({ description: "Started by a person's message." }),
    agent: Count.openapi({
      description: "Agent to agent: started by another agent's message or answer, or 2+ agent replies deep.",
    }),
    routine: Count.openapi({ description: "Started by a routine (its run, its reminder, its report)." }),
    longWork: Count.openapi({ description: "Long work and other background runs." }),
    followUp: Count.openapi({
      description: "The agent coming back to its own work: a follow-up due, a wait or proposal ended, a check-in.",
    }),
    other: Count.openapi({ description: "Its trigger message is gone." }),
    done: Count,
    canceled: Count,
    active: Count.openapi({ description: "Not ended yet (queued, running, waiting)." }),
    failed: Count,
    computerBusy: Count.openapi({ description: "Failed: no room on its computer for the whole wait." }),
    noAi: Count.openapi({ description: "Failed: no AI to think with (no sign-in, no key, a revoked or wrong key)." }),
    paused: Count.openapi({ description: "Failed: the workspace or agent on hold or paused, or its budget spent." }),
    failedOther: Count,
  })
  .openapi("OperatorWorkTurns");
const Waits = z
  .object({
    waited: Count.openapi({ description: "Turns that waited for room on a computer." }),
    peakWaiting: Count.openapi({ description: "Most turns waiting for room at once (for a row, its own)." }),
    personReplies: Count.openapi({ description: "Person-started turns that replied." }),
    personFailed: Count.openapi({
      description: "Person-started turns that failed: they have no reply, so the reply times leave them out.",
    }),
    replyMedianSec: z.number().int().nullable().openapi({
      description:
        "Median seconds from a person-started turn's creation to its reply; null without one. Work it handed to another agent is not waited for.",
    }),
    replyP90Sec: z.number().int().nullable(),
  })
  .openapi("OperatorWorkWaits");
const Tokens = z
  .object({
    input: z.number().int().min(0).openapi({ description: "Uncached input tokens." }),
    output: z.number().int().min(0),
    cacheRead: z.number().int().min(0),
    cacheWrite: z.number().int().min(0),
    costUsd: z.number().openapi({ description: "What was billed through an API (a plan's tokens are 0)." }),
    apiEquivalentUsd: z.number().openapi({
      description: "Everything at API prices: a plan's tokens priced like the app's plan card (≈ … pela API).",
    }),
  })
  .openapi("OperatorWorkTokens");
const Payer = z.object({
  payer: z.string().openapi({
    description:
      "Who pays: `plan` (a computer brain's plan), `workspace_key` (the workspace's API key), `platform_key` (this server's model key, or a key since removed), `platform` (this server's own services).",
  }),
  ...Tokens.shape,
});
const WorkRow = {
  turns: Turns,
  waits: Waits,
  tokens: Tokens,
  agentShare: z.number().min(0).max(1).openapi({ description: "Agent-to-agent turns over all turns." }),
};
const workSeries = z.array(z.object({ at: z.string(), ...WorkRow, byPayer: z.array(Payer) })).openapi({
  description:
    "Oldest first, by `bucket`: `at` is YYYY-MM-DD, or YYYY-MM-DDTHH (UTC) by hour. A bucket with nothing is left out.",
});
const workTotals = z.object({
  ...WorkRow,
  byPayer: z.array(Payer).openapi({ description: "Most tokens first." }),
  turnsWithUsage: Count.openapi({ description: "Distinct turns that spent tokens in the dates." }),
  perTurn: z
    .object({ input: Count, output: Count, cacheRead: Count, cacheWrite: Count })
    .openapi({ description: "Tokens over `turnsWithUsage`." }),
  waitsByCause: z
    .array(
      z.object({
        cause: z.string().openapi({
          description:
            "`brain_unavailable:<code>` (a wait for its computer: `busy` for room, `machine_offline`, `machine_paused`, …) or `provider_outage`. A wait for room names the gate that held it when it began: `busy:line` (another run ahead), `busy:sign_in` (its plan sign-in at its cap), `busy:spacing` (agents' turns start seconds apart), `busy:memory` (the computer refused it for room); plain `busy` before these were kept. Ignore values you don't know.",
        }),
        waits: Count,
        medianSec: z.number().int().nullable(),
        p90Sec: z.number().int().nullable(),
      }),
    )
    .openapi({
      description:
        "Waits of turns created in the dates, most first: each lasts until the run's next step, its end or now.",
    }),
  computerStarts: z
    .object({
      turns: Count.openapi({ description: "Computer brain turns that said how they started (newer runners)." }),
      warm: Count.openapi({ description: "Of them, on a process already open." }),
      initMedianMs: z.number().int().nullable().openapi({ description: "A new process until it said it was ready." }),
      initP90Ms: z.number().int().nullable(),
      warmFirstEventMedianMs: z.number().int().nullable().openapi({ description: "Turn start to its first event." }),
      warmFirstEventP90Ms: z.number().int().nullable(),
      coldFirstEventMedianMs: z.number().int().nullable(),
      coldFirstEventP90Ms: z.number().int().nullable(),
    })
    .openapi("OperatorWorkComputerStarts"),
  stages: z
    .array(
      z.object({
        stage: z.string().openapi({ description: "`claim`, `context`, `model` (each turn), `persist`, `events`, …" }),
        runs: Count.openapi({ description: "Stages measured (a run has one `model` per turn)." }),
        medianMs: z.number().int().nullable(),
        p90Ms: z.number().int().nullable(),
      }),
    )
    .openapi({ description: "Where the runs' own time went (waits for room excluded), slowest median first." }),
});
const workCommon = {
  from: Day,
  to: Day,
  bucket: z
    .enum(["hour", "day"])
    .openapi({ description: `By hour for ${WORK_ANALYTICS_HOURLY_DAYS} days or fewer, else by day.` }),
  totals: workTotals,
  series: workSeries,
  more: z.boolean().openapi({ description: `More rows than the ${ANALYTICS_ROWS_MAX} listed.` }),
};
const WorkAnalytics = z
  .object({
    ...workCommon,
    workspaces: z
      .array(z.object({ orgId: z.uuid(), ...WorkRow }))
      .openapi({ description: `Most tokens first (then turns), at most ${ANALYTICS_ROWS_MAX}.` }),
  })
  .openapi("OperatorWorkAnalytics");
const OrgWorkAnalytics = z
  .object({
    ...workCommon,
    orgId: z.uuid(),
    agents: z.array(z.object({ agentId: z.uuid(), ...WorkRow })).openapi({
      description: `Most tokens first (then turns), at most ${ANALYTICS_ROWS_MAX}. The workspace's own usage (the router, embeddings) is only in the totals.`,
    }),
  })
  .openapi("OperatorOrgWorkAnalytics");

const TimingsQuery = z.object({
  from: z.string().openapi({
    description: "An ISO 8601 instant: runs created at or after it.",
    example: "2026-10-30T00:00:00Z",
  }),
  to: z.string().openapi({
    description: `An ISO 8601 instant: runs created before it. After \`from\`, at most ${RUN_TIMINGS_FLEET_MAX_DAYS} days apart across workspaces and ${RUN_TIMINGS_MAX_DAYS} with \`orgId\`. Else 400 \`analytics.range\`.`,
    example: "2026-10-31T00:00:00Z",
  }),
  orgId: z.uuid().optional().openapi({ description: "Only this workspace's runs." }),
  agentId: z.uuid().optional().openapi({ description: "Only this agent's runs. Only with `orgId`." }),
  by: z.enum(["brain", "model"]).default("brain").openapi({
    description: "`brain`: a row per brain. `model`: a row per brain and model.",
  }),
});
const CliRunsQuery = z.object({
  from: z
    .string()
    .openapi({ description: "An ISO 8601 instant: runs created at or after it.", example: "2026-11-21T00:00:00Z" }),
  to: z.string().openapi({
    description: `An ISO 8601 instant: runs created before it, after \`from\` and at most ${CLI_RUNS_MAX_DAYS} days apart. Else 400 \`analytics.range\`.`,
    example: "2026-11-22T00:00:00Z",
  }),
});
const CliRuns = z
  .object({
    from: z.string(),
    to: z.string(),
    clis: z
      .array(
        z.object({
          cli: z.string().openapi({
            description:
              "The coding CLI's name: `claude`, `codex`, `cursor`, `opencode`, `grok`, `antigravity`, `devin`.",
          }),
          version: z.string().openapi({
            description: "Its version, as its `--version` gave it on the run's computer.",
            example: "2.1.308",
          }),
          runs: z.number().int().openapi({ description: "Runs that ended, done or failed." }),
          failed: z.number().int().openapi({ description: "Of them, those that failed, whatever the cause." }),
        }),
      )
      .openapi({
        description: `Most runs first, at most ${CLI_RUNS_ROWS_MAX}. Runs on the model brain, or whose computer said no version, aren't counted.`,
      }),
  })
  .openapi("OperatorCliRuns");
const Ms = z.number().int().nullable();
const TimingsGroup = {
  brain: z.string().nullable().openapi({
    description:
      "What the runs thought with: `model` (a provider's API) or a coding CLI. `other`: none the server knows. Null: runs that had no turn yet.",
  }),
  model: z.string().nullable().openapi({
    description: "With `by=model`: the model of the run's latest turn, null when it had none. Else always null.",
  }),
};
const RunTimings = z
  .object({
    from: z.string(),
    to: z.string(),
    by: z.enum(["brain", "model"]),
    runs: Count.openapi({ description: "Runs created in the window, with the filters." }),
    profiled: Count.openapi({ description: "Of them, the ones that kept at least one claim's stages." }),
    stages: z
      .array(
        z.object({
          ...TimingsGroup,
          stage: z.string().openapi({
            description:
              "`claim`, `context`, `model` (each turn), `persist`, `events`, `end`… a step inside a stage after it (`context.build`). `other`: a name not shaped like one the server writes.",
          }),
          count: Count.openapi({ description: "Stages measured, not runs: a run has one `model` per turn." }),
          medianMs: Ms,
          p90Ms: Ms,
          p99Ms: Ms,
          maxMs: Ms,
        }),
      )
      .openapi({
        description: `By brain, then model, then the slowest median first. At most ${RUN_TIMINGS_ROWS_MAX}: the most measured.`,
      }),
    stagesMore: z.boolean().openapi({ description: "More stages than were listed." }),
    computerStarts: z
      .array(
        z.object({
          ...TimingsGroup,
          turns: Count.openapi({ description: "Turns on a computer that said how they started." }),
          warm: Count.openapi({ description: "Of them, on a process already open." }),
          initMedianMs: Ms.openapi({ description: "A new process until it said it was ready." }),
          initP90Ms: Ms,
          initP99Ms: Ms,
          warmFirstEventMedianMs: Ms.openapi({ description: "Turn start to its first event." }),
          warmFirstEventP90Ms: Ms,
          warmFirstEventP99Ms: Ms,
          coldFirstEventMedianMs: Ms,
          coldFirstEventP90Ms: Ms,
          coldFirstEventP99Ms: Ms,
          firstRequestMedianMs: Ms.openapi({
            description: "Turn start to the CLI's first API request (newer runners): before it, the CLI's own work.",
          }),
          firstRequestP90Ms: Ms,
          apiWaitMedianMs: Ms.openapi({
            description: "The CLI's first API request to the API's first streamed message: the network and the API.",
          }),
          apiWaitP90Ms: Ms,
          firstTokenMedianMs: Ms.openapi({
            description: "Turn start to the model API's first streamed message (newer runners).",
          }),
          firstTokenP90Ms: Ms,
          firstAssistantMedianMs: Ms.openapi({ description: "Turn start to the answer's first whole block." }),
          firstAssistantP90Ms: Ms,
          retriedTurns: Count.openapi({ description: "Turns in which the CLI retried an API call." }),
          retries: Count.openapi({ description: "Those retries, all turns together." }),
          retryDelayMs: Count.openapi({ description: "The waits they announced, summed." }),
          thinkingCharsMedian: Ms.openapi({ description: "Characters of a turn's thinking text." }),
          thinkingCharsP90: Ms,
        }),
      )
      .openapi({ description: `By brain, then model. At most ${RUN_TIMINGS_ROWS_MAX}: the ones with most turns.` }),
    coldStarts: z
      .array(
        z.object({
          ...TimingsGroup,
          cause: z.string().openapi({
            description:
              "Why the turn started a new process: `new_session` (a session that never ran there: a new conversation, or a fresh session for an old one), `idle` (its process closed after its idle limit), `cap` (closed for another conversation of the agent), `memory` (closed to make room), `settings` (another launch: folder, permissions, account, sign-in), `warm_mismatch` (a warm start had another system text), `exited`, `closed` (after its last turn: canceled, died, a background turn), `restart` (it ran before, no process left: the runner restarted), `warm_settings` (a warm start had another launch than its turn), `no_launch` (a warm start came before any turn of the agent on that sign-in kept its process there), `unsaid` (an older runner). Ignore values you don't know.",
          }),
          turns: Count,
        }),
      )
      .openapi({
        description: `Cold computer turns by brain, model and cause, most first. At most ${RUN_TIMINGS_ROWS_MAX}.`,
      }),
    waits: z
      .array(
        z.object({
          cause: z.string().openapi({
            description:
              "`brain_unavailable:<code>`, a wait for its computer or a sign-in on it, by its code: `busy` for room, `machine_offline`, `not_logged_in`, … `other`: not shaped like one. A wait for room names the gate that held it when it began: `busy:line` (another run ahead), `busy:sign_in` (its plan sign-in at its cap), `busy:spacing` (agents' turns start seconds apart), `busy:memory` (the computer refused it for room); plain `busy` before these were kept. Ignore values you don't know.",
          }),
          ...TimingsGroup,
          waits: Count,
          runs: Count.openapi({ description: "Distinct runs that waited." }),
          medianSec: Ms,
          p90Sec: Ms,
          p99Sec: Ms,
          totalSec: Ms,
        }),
      )
      .openapi({
        description: `The waits for a computer alone (a provider's outage is not among them). By brain, then model, then most waits first, at most ${RUN_TIMINGS_ROWS_MAX}: the most frequent. Each wait lasts until the run's next step, its end, or the earlier of now and \`to\`.`,
      }),
  })
  .openapi("OperatorRunTimings");

const ReplyTimesQuery = z.object({
  from: z.string().openapi({
    description: "An ISO 8601 instant: runs created at or after it.",
    example: "2026-10-30T00:00:00Z",
  }),
  to: z.string().openapi({
    description: `An ISO 8601 instant: runs created before it, at most ${REPLY_TIMES_MAX_DAYS} days after \`from\`. Else 400 \`analytics.range\`.`,
    example: "2026-10-31T00:00:00Z",
  }),
  bucket: z.enum(REPLY_TIME_BUCKETS).default("day").openapi({ description: "A row per UTC hour or day." }),
});
const At = z
  .string()
  .openapi({ description: "The bucket's start, UTC: `YYYY-MM-DDTHH:00:00Z`.", example: "2026-10-30T00:00:00Z" });
const ReplyMeasures = {
  runs: Count.openapi({ description: "Runs answering a person's message (hop 1), routines' left out." }),
  replied: Count.openapi({
    description:
      "Of them, the ones that put a message in the conversation. The server's notices that it can't answer yet (no AI, a plan at its limit or switched, a computer or provider not answering) aren't one.",
  }),
  p50Ms: Ms.openapi({ description: "From the person's message to the run's first message, of the runs that replied." }),
  p90Ms: Ms,
  p99Ms: Ms,
};
const ReplyTimes = z
  .object({
    from: z.string(),
    to: z.string(),
    bucket: z.enum(REPLY_TIME_BUCKETS),
    replies: z
      .array(
        z.object({
          at: At,
          brain: z.string().openapi({
            description: `The brain by its name (${REPLY_BRAINS.map((b) => `\`${b}\``).join(", ")}; \`model\` is a provider's API, \`other\` no turn yet). \`all\`: every brain.`,
          }),
          trigger: z.enum(["all", ...schema.agentRunTriggerEnum.enumValues]).openapi({
            description: "`dm`, `mention` or `router` (nobody was named). `all`: every trigger.",
          }),
          ...ReplyMeasures,
          short: z
            .object(ReplyMeasures)
            .openapi({ description: `The same, of the asks under ${SHORT_ASK_CHARS} characters.` }),
        }),
      )
      .openapi({
        description:
          "Per bucket a row of every run (`brain` and `trigger` `all`), a row per brain (`trigger` `all`) and a row per trigger (`brain` `all`); buckets with no run are left out.",
      }),
    computerStarts: z
      .array(
        z.object({
          at: At,
          turns: Count.openapi({ description: "Turns on a computer that said how they started." }),
          warm: Count.openapi({ description: "Of them, on a process already open; the rest started cold." }),
          warmFirstEventP50Ms: Ms.openapi({ description: "Turn start to its first event, warm." }),
          warmFirstEventP90Ms: Ms,
          coldFirstEventP50Ms: Ms.openapi({ description: "Turn start to its first event, cold." }),
          coldFirstEventP90Ms: Ms,
        }),
      )
      .openapi({ description: "Of every run but routines'. Buckets with none are left out." }),
    waits: z
      .array(
        z.object({
          at: At,
          cause: z.enum(REPLY_WAIT_CAUSES).openapi({
            description:
              "`room`: its computer had no room yet (`busy`). `offline`: its computer was off or waking (`machine_offline`). `other`: a sign-in, a plan or a CLI.",
          }),
          waits: Count,
          runs: Count.openapi({ description: "Distinct runs that waited." }),
          p50Ms: Ms.openapi({
            description: "Each wait lasts until the run's next step, its end, or the earlier of now and `to`.",
          }),
          p90Ms: Ms,
        }),
      )
      .openapi({ description: "Waits for a computer, of every run but routines'. Buckets with none are left out." }),
  })
  .openapi("OperatorReplyTimes");

const AuthMethodOrUnknown = z.enum(["cli_login", "setup_token", "api_key", "unknown"]).openapi("OperatorAiAuthMethod", {
  description:
    "`cli_login`: the CLI's own sign-in, kept by the CLI. `setup_token`: `claude setup-token`'s token, kept by the runner. `api_key`: a pasted key. `unknown`: its computer never said.",
});
const Cause = z.string().openapi({
  description: `What the provider or the runner reported: ${PROVIDER_FAILURE_CAUSES.map((c) => `\`${c}\``).join(", ")}. Ignore values you don't know.`,
});
const AccountCounts = {
  connections: Count.openapi({ description: "Signed in or signed out (sign-ins in progress and removals left out)." }),
  usable: Count.openapi({ description: "Signed in, and its runner's last look was conclusive." }),
  signedOut: Count,
  unknown: Count.openapi({ description: "Its runner's last look at its status was inconclusive." }),
};
const AiAccounts = z
  .object({
    generatedAt: z.string(),
    from: Day,
    to: Day,
    totals: z.object({
      ...AccountCounts,
      inProgress: Count.openapi({ description: "Sign-ins started and not finished." }),
      removing: Count.openapi({ description: "Removed, waiting for their computer to confirm." }),
      workspaces: Count.openapi({ description: "Workspaces with at least one of `connections`." }),
      usedLast24h: Count.openapi({ description: "Of `connections`, used by a turn in the last 24 hours." }),
      usedLast7d: Count,
      apiCredentials: Count.openapi({ description: "Workspaces' model API keys not revoked." }),
      apiCredentialWorkspaces: Count,
      inheritedMachineLogins: Count.openapi({
        description:
          "Computers whose own Claude sign-in (no connection of its own) reports signed in. Counted apart: never in `connections`.",
      }),
    }),
    byDimension: z
      .array(
        z.object({
          provider: z.string().openapi({
            description:
              "`anthropic`, `openai`, `xai`, `google`, `cursor`, `opencode`, a coding plan's id, or an API key's provider.",
          }),
          runtime: z.string().openapi({
            description:
              "`claude_code`, `codex`, `grok`, `antigravity`, `cursor`, `opencode`, `devin`, or `api` (an API key).",
          }),
          authMethod: AuthMethodOrUnknown,
          billing: z.enum(["subscription", "coding_plan", "metered_api", "unknown"]).openapi({
            description:
              "`subscription`: a CLI's sign-in to a plan. `coding_plan`: a coding plan's key. `metered_api`: an API key, billed per token.",
          }),
          ...AccountCounts,
          usedLast7d: Count,
        }),
      )
      .openapi({
        description: "Most connections first. An API key is usable while it isn't revoked; its use isn't counted here.",
      }),
    identity: z
      .object({
        withProviderIdentity: Count.openapi({
          description: "Connections whose email and provider organization are known.",
        }),
        withoutIdentity: Count,
        distinctProviderAccounts: Count.openapi({
          description:
            "Distinct (kind, email, provider organization) among those: one account signed in on several computers counts once.",
        }),
      })
      .openapi({ description: "Never by a key, a token or a label." }),
    failures: z.object({
      from: Day,
      to: Day,
      byCause: z
        .array(
          z.object({
            cause: Cause,
            authMethod: z.string().openapi({ description: "As the failure's event said, `unknown` if it didn't." }),
            attempts: Count.openapi({
              description: "`account.failure` events: at most one per account and cause every 10 minutes.",
            }),
            accounts: Count,
            workspaces: Count,
          }),
        )
        .openapi({ description: `Most attempts first, at most ${ANALYTICS_ROWS_MAX}.` }),
      recent: z
        .array(
          z.object({
            at: z.string(),
            orgId: z.uuid().nullable(),
            machineId: z.string().nullable(),
            accountId: z.string().nullable(),
            kind: z.string().nullable(),
            authMethod: z.string().nullable(),
            cause: Cause.nullable(),
            code: z.string().nullable().openapi({ description: "The runner's stable code, e.g. `not_logged_in`." }),
            runnerVersion: z.string().nullable(),
          }),
        )
        .openapi({ description: `Newest first, at most ${AI_ACCOUNTS_RECENT_FAILURES}.` }),
    }),
    added: z
      .array(z.object({ day: Day, authMethod: AuthMethodOrUnknown, count: Count }))
      .openapi({ description: "Oldest first. A day without any is left out." }),
    addedSource: z.enum(["events", "retained_rows"]).openapi({
      description:
        "`retained_rows`: from the connections still kept, by the day each was made (removed ones are gone).",
    }),
    coverage: z.object({
      eventsSince: z
        .string()
        .nullable()
        .openapi({ description: "The oldest event the feed keeps; failures before it are gone." }),
      notes: z.array(z.string()).openapi({
        description:
          "Fixed codes on what these numbers can't see: `inherited_logins_by_machine`, `api_credentials_no_usage_identity`, `added_from_retained_rows`.",
      }),
    }),
  })
  .openapi("OperatorAiAccounts");

const AiAccountQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
  orgId: z.uuid().optional(),
  kind: z.enum(ACCOUNT_KINDS).optional(),
  authMethod: AuthMethodOrUnknown.optional(),
  status: z.enum(AI_ACCOUNT_STATUSES).optional(),
});
const AiAccountPage = z
  .object({
    accounts: z.array(
      z.object({
        id: z.uuid(),
        orgId: z.uuid(),
        orgName: z.string().openapi({ description: "The workspace's name." }),
        machineId: z.uuid(),
        machineName: z.string(),
        kind: z.string(),
        provider: z.string().nullable().openapi({
          description: "A coding plan's id, `cursor` or `zen` (keys), `enterprise`; null: the CLI's own sign-in.",
        }),
        authMethod: z.string().nullable(),
        label: z.string(),
        plan: z.string().nullable(),
        status: z.string().openapi({ description: AI_ACCOUNT_STATUSES.map((v) => `\`${v}\``).join(", ") }),
        statusUnknown: z.boolean(),
        shared: z.boolean().openapi({ description: "One sign-in thinks for every agent its owner gives it." }),
        ownerId: z.string().nullable(),
        agents: Count.openapi({ description: "Agents set to think with it." }),
        createdAt: z.string(),
        lastUsedAt: z.string().nullable(),
        lastSuccessAt: z.string().nullable(),
        lastFailureCause: Cause.nullable(),
        lastFailureAt: z.string().nullable(),
        usageAt: z.string().nullable().openapi({ description: "When its plan's usage was last read." }),
        usageSource: z.string().nullable().openapi({ description: "`turn` or `probe`." }),
        usage: z
          .object({
            limited: z.boolean().openapi({ description: "The plan refused a request for its limit." }),
            checkedAt: z.string().nullable().openapi({
              description: "When the server last asked its computer to read a plan stuck at its limit again.",
            }),
            windows: z
              .array(
                z.object({
                  kind: z.enum(PLAN_WINDOW_KINDS).openapi({
                    description: "`other`: a window the list has no word for; never the provider's own name for it.",
                  }),
                  usedPercent: z.number().min(0).max(100),
                  resetsAt: z.string().nullable(),
                  at: z.string().nullable().openapi({
                    description:
                      "When this window was last read, where that is before `usageAt`: a later reading that didn't name it kept the older one. Null: at `usageAt`.",
                  }),
                }),
              )
              .openapi({ description: `At most ${AI_ACCOUNT_WINDOWS_MAX}.` }),
          })
          .nullable()
          .openapi({ description: "Its plan's windows as its computer last reported them (`usageAt`); null: none." }),
        runnerVersion: z.string().nullable(),
        protocol: z.number().int(),
      }),
    ),
    next: z.string().nullable(),
  })
  .openapi("OperatorAiAccountPage");

const AskTimesQuery = z.object({
  from: z
    .string()
    .openapi({ description: "An ISO 8601 instant: asks made at or after it.", example: "2026-11-19T00:00:00Z" }),
  to: z.string().openapi({
    description: `An ISO 8601 instant: asks made before it, at most ${ASK_TIMES_MAX_DAYS} days after \`from\`. Else 400 \`analytics.range\`.`,
    example: "2026-11-26T00:00:00Z",
  }),
  bucket: z.enum(ASK_TIME_BUCKETS).default("day").openapi({ description: "The series per UTC hour or day." }),
  orgId: z.uuid().optional().openapi({ description: "One workspace's asks; every workspace's without it." }),
});
const AskQuantiles = z.object({ p50Ms: Ms, p90Ms: Ms });
const AskMeasures = {
  asks: Count.openapi({
    description:
      "People's messages that started agents' work, each with all the work it set off (ADR 0254): the hand-offs to other agents and their follow-ups, until a person wrote again.",
  }),
  judged: Count.openapi({
    description: "Of them, the ones whose kind Jev read; the others' kind is what the work did.",
  }),
  index: z.number().int().min(0).max(100).nullable().openapi({
    description:
      "The speed index, 0 to 100: replies within the kind's target, plus half of those within four times it, over the asks that count. A failure, and an ask with no reply past four times its target, count against; no AI or a hold, a stop by a person, a pass by every agent and an ask still within its time don't count. Null: none counted.",
  }),
  satisfied: Count,
  tolerating: Count,
  frustrated: Count,
  firstActivity: AskQuantiles.openapi({ description: "From the person's message to the first tool step or message." }),
  firstReply: AskQuantiles.openapi({
    description:
      "To the work's first message in the conversation; the server's own notices (no AI, a limit) aren't one.",
  }),
  done: AskQuantiles.openapi({ description: "To when its every run ended, and its long work, of the asks done." }),
  outcomes: z
    .object(
      Object.fromEntries(ASK_OUTCOMES.map((o) => [o, Count])) as Record<(typeof ASK_OUTCOMES)[number], typeof Count>,
    )
    .openapi({
      description:
        "`done` with a reply, `failed`, `setup` (no AI, a hold or a spent budget, before any reply), `canceled` by a person, `open` (a run or its long work goes on), `passed` (every agent passed).",
    }),
  multiAgent: Count.openapi({ description: "Asks two or more agents worked on." }),
  runsPerAsk: z.number().nullable(),
  toolsP50: z.number().nullable().openapi({ description: "Our tools' calls per ask, the median." }),
};
const AskGroup = z.object(AskMeasures).openapi("OperatorAskMeasures");
const AskTimes = z
  .object({
    from: z.string(),
    to: z.string(),
    bucket: z.enum(ASK_TIME_BUCKETS),
    orgId: z.uuid().nullable(),
    totals: AskGroup,
    kinds: z
      .array(AskGroup.extend({ kind: z.enum(ASK_KINDS), targetMs: z.number().int() }))
      .openapi({ description: "Every kind, in order, with its target for the first reply." }),
    brains: z.array(AskGroup.extend({ brain: z.string() })).openapi({
      description: "By the brain of the ask's first run (`other`: none yet), most asks first.",
    }),
    models: z.array(AskGroup.extend({ model: z.string() })).openapi({
      description: `By the model of the ask's first run (\`none\`: no usage recorded), most asks first, at most ${ASK_MODELS_MAX}.`,
    }),
    modelsMore: z.boolean(),
    series: z
      .array(AskGroup.extend({ at: At, kind: z.enum(["all", ...ASK_KINDS]) }))
      .openapi({ description: "Per bucket, oldest first: `all`, then each kind that had asks." }),
  })
  .openapi("OperatorAskTimes");

const BreakdownQuery = z.object({
  from: z
    .string()
    .openapi({ description: "An ISO 8601 instant: runs created at or after it.", example: "2026-11-25T00:00:00Z" }),
  to: z.string().openapi({
    description: `An ISO 8601 instant: runs created before it. After \`from\`, at most ${STAGE_BREAKDOWN_FLEET_MAX_DAYS} days apart across workspaces and ${STAGE_BREAKDOWN_MAX_DAYS} with \`orgId\`. Else 400 \`analytics.range\`.`,
    example: "2026-11-26T00:00:00Z",
  }),
  orgId: z.uuid().optional().openapi({ description: "Only this workspace's runs." }),
});
const StageGroup = z.enum(STAGE_GROUPS).openapi("OperatorStageGroup", {
  description:
    "Where a run's time went, in the order a turn reaches it: `waits` for a computer (room or any other), `context` (the router's pick, the claim, the context built), `pre_turn_sync` (the agent's checkouts updated before a computer turn), `cli_init` (a new CLI process until ready), `cli_first_byte` (ready to the model API's first streamed message), `model_write` (the model writing, and an API model's whole turn), `tools`, `finish` (the turn's checks, saving, events).",
});
const BreakdownQuantiles = z.object({ p50Ms: Ms, p90Ms: Ms });
const BreakdownMeasures = z
  .object({
    runs: Count.openapi({ description: "Runs created in the window that kept a stage profile." }),
    total: BreakdownQuantiles.openapi({ description: "A run's time in all its claims (waits between them aside)." }),
    groups: z
      .array(
        BreakdownQuantiles.extend({
          group: StageGroup,
          runs: Count.openapi({ description: "Of the runs, those that spent time in it." }),
        }),
      )
      .openapi({ description: "Every group, in order: the median and p90 of the runs that spent time in it." }),
  })
  .openapi("OperatorStageBreakdownMeasures");
const BreakdownKind = z.enum(BREAKDOWN_KINDS).openapi({
  description:
    "The kind of the run's ask (ADR 0254: Jev's read, else what the work did), `agent` (another agent's message started it) or `background` (a routine or long work).",
});
const StageBreakdown = z
  .object({
    from: z.string(),
    to: z.string(),
    orgId: z.uuid().nullable(),
    groups: z.array(StageGroup),
    totals: BreakdownMeasures,
    days: z.array(BreakdownMeasures.extend({ day: Day })).openapi({ description: "Per UTC day, oldest first." }),
    kinds: z
      .array(BreakdownMeasures.extend({ kind: BreakdownKind }))
      .openapi({ description: "Each kind that had runs, in order." }),
    brains: z
      .array(BreakdownMeasures.extend({ brain: z.string() }))
      .openapi({ description: "Most runs first; `other`: none the server knows." }),
    models: z.array(BreakdownMeasures.extend({ model: z.string() })).openapi({
      description: `The model of the run's first turn (\`none\`: no usage recorded, \`custom\`: a workspace's own endpoint), most runs first, at most ${STAGE_BREAKDOWN_MODELS_MAX}.`,
    }),
    modelsMore: z.boolean(),
    slowest: z
      .array(
        z.object({
          runId: z.uuid(),
          orgId: z.uuid(),
          agentId: z.uuid(),
          createdAt: z.string(),
          brain: z.string(),
          model: z.string().nullable(),
          kind: BreakdownKind,
          totalMs: Count,
          groups: z.object(
            Object.fromEntries(STAGE_GROUPS.map((g) => [g, Count])) as Record<
              (typeof STAGE_GROUPS)[number],
              typeof Count
            >,
          ),
        }),
      )
      .openapi({
        description: `The ${STAGE_BREAKDOWN_SLOWEST} runs that took longest, slowest first: each one's waterfall is in its trace.`,
      }),
  })
  .openapi("OperatorStageBreakdown");

export function registerOperatorAnalytics(api: OpenAPIHono, { db }: OperatorDeps) {
  api.openapi(
    createRoute({
      method: "get",
      path: "/analytics",
      tags,
      summary: "How connectors and the product are used, in counts",
      description:
        "Counted on every server, by UTC day (ADR 0103). Only counts, keys and ids: no connection label, URL path, tool input, address or anyone's name.",
      request: { query: Range },
      responses: { 200: json(Analytics), 400: errors[400], 401: errors[401] },
    }),
    async (c) => c.json(await operatorAnalytics(db, c.req.valid("query")), 200),
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/analytics/connectors/{connector}",
      tags,
      summary: "One connector's use: per day, tool, Composio action and workspace",
      description: "An unknown connector answers with empty lists.",
      request: { params: ConnectorParams, query: Range },
      responses: { 200: json(ConnectorAnalytics), 400: errors[400], 401: errors[401] },
    }),
    async (c) =>
      c.json(await operatorConnectorAnalytics(db, c.req.valid("param").connector, c.req.valid("query")), 200),
  );

  const workDescription =
    "Turns and waits count runs created in the dates, tokens the usage recorded in them. Counts and ids only: no message, no name.";
  api.openapi(
    createRoute({
      method: "get",
      path: "/analytics/work",
      tags,
      summary: "Agent work and tokens across workspaces: per day (or hour) and per workspace",
      description: workDescription,
      request: { query: WorkRange },
      responses: { 200: json(WorkAnalytics), 400: errors[400], 401: errors[401] },
    }),
    async (c) => c.json(await operatorWorkAnalytics(db, c.req.valid("query")), 200),
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/analytics/work/orgs/{orgId}",
      tags,
      summary: "One workspace's agent work and tokens: per day (or hour) and per agent",
      description: `${workDescription} An unknown workspace answers with zeros.`,
      request: { params: OrgParams, query: WorkRange },
      responses: { 200: json(OrgWorkAnalytics), 400: errors[400], 401: errors[401] },
    }),
    async (c) => c.json(await operatorOrgWorkAnalytics(db, c.req.valid("param").orgId, c.req.valid("query")), 200),
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/analytics/run-timings",
      tags,
      summary: "Where the runs' time went: each stage, how computer turns started and the waits, per brain or model",
      description: `Of the runs created in the window: ${RUN_TIMINGS_FLEET_MAX_DAYS} days at most across workspaces, ${RUN_TIMINGS_MAX_DAYS} in one (\`orgId\`). Counts, times and the server's own words only: no message, no name. An unknown workspace answers with zeros.`,
      request: { query: TimingsQuery },
      responses: { 200: json(RunTimings), 400: errors[400], 401: errors[401] },
    }),
    async (c) => c.json(await operatorRunTimings(db, c.req.valid("query")), 200),
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/analytics/stage-breakdown",
      tags,
      summary: "Where the time goes: each run's time by stage group, per day, kind of ask, brain and model",
      description: `Of the runs created in the window that kept a stage profile: ${STAGE_BREAKDOWN_FLEET_MAX_DAYS} days at most across workspaces, ${STAGE_BREAKDOWN_MAX_DAYS} in one (\`orgId\`). Counts, times, ids and the server's own words only: no message, no name.`,
      request: { query: BreakdownQuery },
      responses: { 200: json(StageBreakdown), 400: errors[400], 401: errors[401] },
    }),
    async (c) => c.json(await operatorStageBreakdown(db, c.req.valid("query")), 200),
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/cli-runs",
      tags,
      summary: "Runs that ended, by the coding CLI and version they thought with, and how many failed",
      description:
        "Of the runs created in the window, across workspaces: what a rollout of a CLI's new build compares with the build before. Counts and versions only.",
      request: { query: CliRunsQuery },
      responses: { 200: json(CliRuns), 400: errors[400], 401: errors[401] },
    }),
    async (c) => c.json(await operatorCliRuns(db, c.req.valid("query")), 200),
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/analytics/reply-times",
      tags,
      summary: "How long people waited for agents' replies, per hour or day, across workspaces",
      description: `Of the runs created in the window, ${REPLY_TIMES_MAX_DAYS} days at most: the time from a person's message to the agent's first message in the conversation, by brain and by trigger, all asks and short ones; how computer turns started; the waits for a computer. Counts and times only: no message, no name.`,
      request: { query: ReplyTimesQuery },
      responses: { 200: json(ReplyTimes), 400: errors[400], 401: errors[401] },
    }),
    async (c) => c.json(await operatorReplyTimes(db, c.req.valid("query")), 200),
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/analytics/asks",
      tags,
      summary: "Time per task: how long people's asks took, by kind, with a speed index",
      description: `Of the asks people made in the window, ${ASK_TIMES_MAX_DAYS} days at most, across workspaces or in one: Jev's read of each one's kind (or what its work did), the time to the first activity, the first reply and done, and how they ended. Counts and times only: no message, no name.`,
      request: { query: AskTimesQuery },
      responses: { 200: json(AskTimes), 400: errors[400], 401: errors[401] },
    }),
    async (c) => c.json(await operatorAskTimes(db, c.req.valid("query")), 200),
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/analytics/ai-accounts",
      tags,
      summary: "The AI accounts people connected: how they sign in, who bills them, how they fail",
      description:
        "Connections now, whatever the dates; failures from the events feed in the dates. Counts, ids and codes only: no email, key hint, token or provider organization id.",
      request: { query: Range },
      responses: { 200: json(AiAccounts), 400: errors[400], 401: errors[401] },
    }),
    async (c) => c.json(await operatorAiAccounts(db, c.req.valid("query")), 200),
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/ai-accounts",
      tags,
      summary: "AI accounts on the workspaces' computers, newest first",
      description: "Keyset pages: an account added while paging never shifts a page. No email, key hint or token.",
      request: { query: AiAccountQuery },
      responses: { 200: json(AiAccountPage), 400: errorResponse("Invalid request"), 401: errors[401] },
    }),
    async (c) => {
      const page = await operatorListAiAccounts(db, c.req.valid("query"));
      const accounts = page.accounts.map((a) => ({
        ...a,
        createdAt: a.createdAt.toISOString(),
        lastUsedAt: iso(a.lastUsedAt),
        lastSuccessAt: iso(a.lastSuccessAt),
        lastFailureAt: iso(a.lastFailureAt),
      }));
      return c.json({ accounts, next: page.next }, 200);
    },
  );
}
