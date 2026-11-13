import { schema } from "@agenteschat/db";
import {
  OPERATOR_JOB_COUNTS,
  OPERATOR_JOB_STUCK_MS,
  OPERATOR_USAGE_DAYS,
  OPERATOR_USAGE_GROUPS,
  OPERATOR_USAGE_MAX_DAYS,
  operatorEmailJobs,
  operatorJobSummary,
  operatorJobs,
  operatorUsage,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { iso, json } from "../routes/app/context";
import type { OperatorDeps } from "./app";
import { Next, paging, word } from "./lookups";
import { Count, Instant, Job, jobJson, Spent, Time } from "./runs";

const tags = ["Operator"];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong token"),
  404: errorResponse("Not found"),
};

const JobStatus = z.enum(schema.outboxStatusEnum.enumValues);

const JobQuery = z.object({
  orgId: z.uuid().optional().openapi({ description: "Only this workspace's. An unknown one has none." }),
  kind: z.string().trim().min(1).max(100).optional().openapi({
    description: "Only this kind: `message.posted`, `agent_run.execute`, `email.send`, `push.send`, `routine.run`…",
  }),
  status: JobStatus.optional(),
  runId: z.uuid().optional().openapi({ description: "Only the jobs that started and woke this run." }),
  stuck: z
    .stringbool()
    .optional()
    .openapi({
      description: `\`true\`: only jobs due for over ${OPERATOR_JOB_STUCK_MS / 60_000} minutes that no worker took, and jobs a worker took whose lease ran out.`,
    }),
  from: Instant.optional().openapi({ description: "Queued at or after." }),
  to: Instant.optional().openapi({ description: "Queued before." }),
  summary: z.stringbool().optional().openapi({
    description: "`true`: counts by kind and status instead of jobs. `limit` and `cursor` don't apply.",
  }),
  ...paging,
});

const JobPage = z.object({ jobs: z.array(Job), next: Next }).openapi("OperatorJobPage");
const JobSummary = z
  .object({
    at: Time.openapi({ description: "When it was counted." }),
    counts: z
      .array(
        z.object({
          kind: z.string(),
          status: JobStatus,
          jobs: Count,
          oldestDueAt: Time.nullable().openapi({
            description: "Of its `pending` jobs already due: since when the oldest waits for a worker.",
          }),
        }),
      )
      .openapi({ description: `By kind, then status; at most ${OPERATOR_JOB_COUNTS}.` }),
    more: z.boolean(),
    oldestDueAt: Time.nullable().openapi({ description: "The oldest of them all; null: nothing waits." }),
    oldestDueSeconds: Count.nullable().openapi({ description: "How long that one has waited." }),
  })
  .openapi("OperatorJobSummary");

const EmailJobQuery = z.object({
  to: word().openapi({ description: "The whole address; any case. Never returned." }),
  ...paging,
});

const EmailJobPage = z
  .object({
    jobs: z.array(
      Job.extend({
        template: z.string().nullable().openapi({
          description: "Which email it sends, as the server names it: `invitation`, `verify_email`, `password_reset`…",
        }),
        errorCode: z.string().nullable().openapi({
          description:
            "A provider's refusal in `lastError`, as its own code: the name it gave (`validation_error`…), else the status (`422`, `429`). Null: no error, or one worded another way.",
        }),
      }),
    ),
    next: Next,
  })
  .openapi("OperatorEmailJobPage");

const UsageQuery = z.object({
  orgId: z.uuid().optional().openapi({ description: "One workspace's. Absent: the whole instance's." }),
  agentId: z.uuid().optional(),
  runId: z.uuid().optional().openapi({ description: "One run's, from when it began unless `from` says." }),
  from: Instant.optional().openapi({
    description: `Recorded at or after. Default: ${OPERATOR_USAGE_DAYS} days before \`to\`.`,
  }),
  to: Instant.optional().openapi({
    description: `Recorded before. Default: now. At most ${OPERATOR_USAGE_MAX_DAYS} days after \`from\`, except for one run.`,
  }),
  groupBy: z.enum(OPERATOR_USAGE_GROUPS).optional().openapi({
    description: "`payer`: who it is billed to. Absent: the total alone.",
  }),
  limit: paging.limit.openapi({ description: "How many groups." }),
});

const Usage = z
  .object({
    from: Time,
    to: Time,
    total: z.object(Spent),
    groups: z
      .array(
        z.object({
          group: z.string().nullable().openapi({
            description:
              "What `groupBy` names: an agent's id (null: calls made for the workspace, like routing), a UTC day (`2026-01-31`), the start of a UTC hour, a model, a provider, or who it is billed to.",
          }),
          billedTo: z.string().openapi({
            description:
              "`org` (a provider's API, the workspace's key or the instance's), `platform` (the instance's own services) or `plan` (a coding CLI's plan). One group has a row for each.",
          }),
          ...Spent,
        }),
      )
      .openapi({ description: "Days and hours oldest first; every other group most tokens first." }),
    more: z.boolean().openapi({ description: "There are more groups than `limit`: narrow the dates." }),
  })
  .openapi("OperatorUsage");

export const dated = <T extends { from?: string; to?: string }>({ from, to, ...query }: T) => ({
  ...query,
  from: from ? new Date(from) : undefined,
  to: to ? new Date(to) : undefined,
});

/**
 * Jobs and usage (ADR 0056, its addendum on them): what waits in the queue or failed there, never a job's payload,
 * and what model calls spent. All `GET`.
 */
export function registerOperatorJobs(api: OpenAPIHono, { db }: OperatorDeps) {
  api.openapi(
    createRoute({
      method: "get",
      path: "/jobs",
      tags,
      summary: "The job queue, newest first; or how many jobs of each kind are in each state",
      description:
        "Every workspace's jobs and the ones of none. A job is its kind, its state, its attempts and its last error, never its payload.",
      request: { query: JobQuery },
      responses: { 200: json(z.union([JobPage, JobSummary])), 400: errors[400], 401: errors[401] },
    }),
    async (c) => {
      const { summary, limit, cursor, ...filters } = dated(c.req.valid("query"));
      if (summary) {
        const counted = await operatorJobSummary(db, filters);
        return c.json(
          {
            ...counted,
            at: counted.at.toISOString(),
            counts: counted.counts.map((n) => ({ ...n, oldestDueAt: iso(n.oldestDueAt) })),
            oldestDueAt: iso(counted.oldestDueAt),
          },
          200,
        );
      }
      const page = await operatorJobs(db, { ...filters, limit, cursor });
      return c.json({ jobs: page.jobs.map(jobJson), next: page.next }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/email-jobs",
      tags,
      summary: "The emails queued to one address, newest first: which template, its state and its attempts",
      description:
        "The address is compared inside the server with the ones each `email.send` job is to, and never returned; nor is a subject, a body, a link or a code. An email is sent once its job is `done` (`completedAt`). A finished job keeps its addresses for 30 days and is not found after that; the job of a code to type in is deleted once it is sent or given up.",
      request: { query: EmailJobQuery },
      responses: { 200: json(EmailJobPage), 400: errors[400], 401: errors[401] },
    }),
    async (c) => {
      const page = await operatorEmailJobs(db, c.req.valid("query"));
      const jobs = page.jobs.map(({ template, errorCode, ...job }) => ({ ...jobJson(job), template, errorCode }));
      return c.json({ jobs, next: page.next }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/usage",
      tags,
      summary: "What model calls spent: tokens, cache and cost, in all and by group",
      description:
        "Of the whole instance, a workspace, an agent or one run. 404 when the workspace, agent or run doesn't exist, or isn't in the workspace or of the agent given with it.",
      request: { query: UsageQuery },
      responses: { 200: json(Usage), ...errors },
    }),
    async (c) => {
      const usage = await operatorUsage(db, dated(c.req.valid("query")));
      if (!usage) return apiError(c, 404, "not_found", "No such workspace, agent or run");
      return c.json({ ...usage, from: usage.from.toISOString(), to: usage.to.toISOString() }, 200);
    },
  );
}
