import {
  MAX_ACTORS,
  OPERATOR_ACCESS_RULES,
  OPERATOR_ACCESS_TARGETS,
  operatorAccess,
  operatorNotifications,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { iso, json, OrgParams } from "../routes/app/context";
import type { OperatorDeps } from "./app";
import { dated } from "./jobs";
import { Next, paging, word } from "./lookups";
import { Count, Instant, Job, jobJson, Time } from "./runs";

const tags = ["Operator"];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong token"),
  404: errorResponse("Not found"),
};

const NotificationQuery = z.object({
  userId: word().openapi({ description: "Whose: an account's id." }),
  kind: word().optional().openapi({ description: "Only this kind: `mention`, `approval`, `run_failed`…" }),
  from: Instant.optional().openapi({ description: "Created at or after." }),
  to: Instant.optional().openapi({ description: "Created before." }),
  ...paging,
});

const NotificationPage = z
  .object({
    notifications: z.array(
      z.object({
        id: z.uuid(),
        kind: z.string().nullable().openapi({
          description:
            "What it tells of, as the server names it: `mention`, `dm`, `thread_reply`, `agent_reply`, `approval`, `agent_question`, `run_failed`, `routine_failed`…",
        }),
        waiting: z.boolean().openapi({ description: "It holds an agent or a decision until the person acts." }),
        group: z.string().nullable().openapi({
          description: "What its events gather under: while it is unread, a new one of the same group joins it.",
        }),
        count: Count.openapi({ description: "How many events it stands for." }),
        actors: z
          .array(z.object({ type: z.enum(["user", "agent"]), id: z.string() }))
          .openapi({ description: `Who caused it, newest first, at most ${MAX_ACTORS}.` }),
        source: z.record(z.string(), z.string()).openapi({
          description:
            "The ids it points at, by name: `channelId`, `threadId`, `messageId`, `issueId`, `approvalId`, `questionId`, `routineId`, `machineId`, `agentId`, `runId`… Never the title stored beside them.",
        }),
        readAt: Time.nullable(),
        doneAt: Time.nullable().openapi({
          description: "Out of the inbox since: the person's doing (`doneByUser`), or what it waited for ended.",
        }),
        doneByUser: z.boolean(),
        snoozedUntil: Time.nullable(),
        createdAt: Time,
        updatedAt: Time.openapi({ description: "When its latest event joined it." }),
        push: z.array(Job).openapi({
          description:
            "The jobs that sent it to the person's devices, oldest first: its first, and the one held back while the person was looking at the app. `done`: it ran, and reached the devices registered then that still wanted it; `failed`: none took it. Empty: none was queued (no device, the person's choice for this kind, or read before). A reminder's and a snooze's are in `GET /jobs?kind=push.send`.",
        }),
      }),
    ),
    devices: z
      .array(
        z.object({
          platform: z.string().nullable().openapi({ description: "`ios`, `android` or `web` (a browser)." }),
          createdAt: Time,
          lastSeenAt: Time.openapi({ description: "When it last registered: each launch, each page load." }),
        }),
      )
      .openapi({
        description:
          "Where the person's pushes go now, in every workspace of theirs, latest seen first. Never what a push is sent to.",
      }),
    next: Next,
  })
  .openapi("OperatorNotificationPage");

const AccessQuery = z.object({
  userId: word().openapi({ description: "An account's id." }),
  targetKind: z.enum(OPERATOR_ACCESS_TARGETS).openapi({ description: "`computer`: a connected computer." }),
  targetId: z.uuid(),
});

const Access = z
  .object({
    userId: z.string(),
    targetKind: z.enum(OPERATOR_ACCESS_TARGETS),
    targetId: z.uuid(),
    allowed: z.boolean().openapi({
      description:
        "An agent: the person's message starts a run of it. A channel (a direct conversation or a task's too) or a file: they read it. A task: they see it. A computer: their agents may use it.",
    }),
    rule: z.enum(OPERATOR_ACCESS_RULES).openapi({
      description:
        "What decided. Yes: `owner` (the agent's or the computer's), `audience_everyone`, `audience_person` (named in its audience), `audience_role` (holds a role of its audience), `workspace` (for the whole workspace: a task or a file outside any conversation, a workspace's computer nobody owns), `channel_member` (in the channel, or in the one the task or the file is in), `public_channel` (the task or the file is in one), `administrator`, `task_reader` (sees the task whose conversation it is), `shared_everyone`, `shared_person`, `shared_role` (the file's sharing), `granted_once` (a person let their agents use the computer for now). No: `not_a_member` (of the workspace), `account_closed` (blocked, or being deleted), `workspace_suspended`, `gone` (archived, deleted or removed), `no_permission` (no role of theirs lets them talk to agents), `owner_only`, `not_in_audience`, `not_joined` (a public channel they may join), `not_channel_member`, `not_task_reader`, `not_shared`. `unknown`: the server's own check answered, and no rule here explains it.",
    }),
  })
  .openapi("OperatorAccess");

/**
 * One person in a workspace (ADR 0056, its addendum on them): what they were notified of, never a notification's
 * words, and whether they reach an agent, a conversation, a task, a file or a computer. All `GET`.
 */
export function registerOperatorPeople(api: OpenAPIHono, { db }: OperatorDeps) {
  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/notifications",
      tags,
      summary: "One person's notifications in a workspace, newest first, and the pushes that carried them",
      description:
        "What kind each is, whether it was read, done or snoozed, who caused it and the ids it points at. Never its words, nor a title. 404 when the workspace or the account doesn't exist.",
      request: { params: OrgParams, query: NotificationQuery },
      responses: { 200: json(NotificationPage), ...errors },
    }),
    async (c) => {
      const page = await operatorNotifications(db, c.req.valid("param").orgId, dated(c.req.valid("query")));
      if (!page) return apiError(c, 404, "not_found", "No such workspace or account");
      return c.json(
        {
          notifications: page.notifications.map((n) => ({
            ...n,
            readAt: iso(n.readAt),
            doneAt: iso(n.doneAt),
            snoozedUntil: iso(n.snoozedUntil),
            createdAt: n.createdAt.toISOString(),
            updatedAt: n.updatedAt.toISOString(),
            push: n.push.map(jobJson),
          })),
          devices: page.devices.map((d) => ({
            ...d,
            createdAt: d.createdAt.toISOString(),
            lastSeenAt: d.lastSeenAt.toISOString(),
          })),
          next: page.next,
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/access",
      tags,
      summary: "Whether a person reaches an agent, a channel, a task, a file or a computer, and the rule that decides",
      description:
        "As things are now, by the checks the apps themselves go through. 404 when the account doesn't exist, or the workspace has nothing of that kind by that id.",
      request: { params: OrgParams, query: AccessQuery },
      responses: { 200: json(Access), ...errors },
    }),
    async (c) => {
      const found = await operatorAccess(db, c.req.valid("param").orgId, c.req.valid("query"));
      if (!found) return apiError(c, 404, "not_found", "No such account, or nothing of that kind in the workspace");
      return c.json(found, 200);
    },
  );
}
