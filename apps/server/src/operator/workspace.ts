import {
  OPERATOR_ASK_KINDS,
  OPERATOR_AUDIT_ACTORS,
  OPERATOR_AUDIT_DAYS,
  OPERATOR_CONNECTION_ERROR_MAX,
  OPERATOR_CONNECTION_KINDS,
  OPERATOR_ROUTINE_RUNS,
  operatorAsks,
  operatorAudit,
  operatorConnections,
  operatorRoutines,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { iso, json, OrgParams } from "../routes/app/context";
import type { OperatorDeps } from "./app";
import { dated } from "./jobs";
import { Next, paging, word } from "./lookups";
import { Count, Instant, Time } from "./runs";

const tags = ["Operator"];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong token"),
  404: errorResponse("Not found"),
};

const ConnectionPage = z
  .object({
    connections: z.array(
      z.object({
        kind: z.enum(OPERATOR_CONNECTION_KINDS).openapi({
          description: "A connected app or server, a mailbox, or a database.",
        }),
        id: z.uuid(),
        connector: z.string().openapi({
          description:
            "The service it is of, as its use is counted (`GET /analytics`): the server's own id for it (`github`, `gmail`, `postgres`…), or for a server connected by address that is none the server knows, its hostname (it has a dot; no id of the server's does) or `custom`.",
        }),
        label: z.string().openapi({
          description:
            "What its workspace calls it: a name a person typed. One nobody named is called by the mailbox's address, the database's host or name, the server's hostname, or the service and the account's name on it.",
        }),
        authType: z.string().nullable().openapi({
          description:
            "How it signs in. A connector's `oauth`, `api_key`, `none` or `github_app`; a mailbox's `composio` or `imap`; null for a database.",
        }),
        status: z.string().openapi({
          description: "`active` or `needs_reconnect`; a mailbox's also `pending` (its sign-in never finished).",
        }),
        lastErrorCode: z.string().nullable().openapi({
          description: "The stored error when it is one word (`account_removed`, `already_connected`…).",
        }),
        lastError: z
          .string()
          .nullable()
          .openapi({ description: `The stored error's first ${OPERATOR_CONNECTION_ERROR_MAX} characters.` }),
        createdAt: Time,
        createdByUserId: z.string().nullable().openapi({ description: "Who connected it." }),
        revokedAt: Time.nullable().openapi({ description: "Removed, or replaced by a newer sign-in." }),
        lastUsedDay: z.string().nullable().openapi({
          description:
            "The last UTC day (`YYYY-MM-DD`) an agent of the workspace called a tool of this service. Counted by service: two accounts of one service share it.",
        }),
        tools: z
          .object({ read: Count, write: Count, approval: Count, off: Count, undecided: Count })
          .nullable()
          .openapi({
            description:
              "A server connected by address: how many of the tools it lists now its workspace set to each level (`approval`: writes that always ask a person; `off`: never offered; `undecided`: not classified yet, so not offered). Null otherwise: the tools are the server's own list for the service.",
          }),
      }),
    ),
    next: Next,
  })
  .openapi("OperatorConnectionPage");

const AuditQuery = z.object({
  action: word().optional().openapi({
    description: "How the action's name starts: `connector.`, `agent.access_changed`, `tool.call`…",
  }),
  actorType: z.enum(OPERATOR_AUDIT_ACTORS).optional(),
  actorId: word().optional().openapi({ description: "A person's or an agent's id." }),
  targetType: word().optional(),
  targetId: word().optional(),
  runId: z.uuid().optional(),
  from: Instant.optional().openapi({
    description: `Recorded at or after. Default: ${OPERATOR_AUDIT_DAYS} days before \`to\`.`,
  }),
  to: Instant.optional().openapi({ description: "Recorded before. Default: now." }),
  ...paging,
});

const AuditPage = z
  .object({
    from: Time,
    to: Time,
    events: z
      .array(
        z.object({
          id: z.uuid(),
          at: Time,
          actorType: z.string().openapi({ description: "`person`, `agent` or `system`." }),
          actorId: z.string().nullable(),
          action: z.string().openapi({
            description:
              "What was done, as the server names it: `connector.connected`, `routine.created`, `agent.access_changed`…, and `tool.call` for a tool an agent called.",
          }),
          targetType: z.string().openapi({ description: "`agent`, `connector`, `routine`, `tool`, `person`…" }),
          targetId: z.string().nullable().openapi({
            description:
              "Its id. A target with no id of its own goes by its name, which its workspace may have written: a tool's (`tool`), a repository's (`repository`, `git_repo`), a wiki folder's path (`wiki_folder`); one of the server's own settings goes by the server's name for it (`instance_secret`). Null when what is stored is longer than one word.",
          }),
          outcome: z.string().nullable().openapi({
            description: "A tool call's: `done`, `failed`, `refused` or `pending` (it waits for a person).",
          }),
          runId: z.uuid().nullable().openapi({ description: "An agent's: the run it happened in." }),
          onBehalfOfUserId: z.string().nullable().openapi({ description: "An agent's: the person behind that run." }),
        }),
      )
      .openapi({ description: "Never an entry's details." }),
    next: Next,
  })
  .openapi("OperatorAuditPage");

const AskQuery = z.object({
  kind: z.enum(OPERATOR_ASK_KINDS).optional(),
  open: z.stringbool().optional().openapi({
    description: "`true`: only the ones still waiting. `false`: only the ones that ended.",
  }),
  agentId: z.uuid().optional().openapi({ description: "The agent that asked." }),
  runId: z.uuid().optional().openapi({ description: "The run that asked." }),
  from: Instant.optional().openapi({ description: "Asked at or after." }),
  to: Instant.optional().openapi({ description: "Asked before." }),
  ...paging,
});

const AskPage = z
  .object({
    asks: z.array(
      z
        .object({
          kind: z.enum(OPERATOR_ASK_KINDS).openapi({
            description:
              "An action to approve, a question to a person, a secret asked for its computer, a person's turn on its screen (`handoff`), or another agent consulted.",
          }),
          id: z.uuid(),
          status: z.string().openapi({
            description:
              "As stored. An approval's `pending`, `approved`, `refused`, `expired` or `canceled`; a question's `open`, `answered`, `expired`, `canceled` or `dismissed`; a secret's `pending`, `delivered`, `declined`, `expired` or `canceled`; a hand-off's `pending` (nobody opened it), `active` (a person in control), `done`, `failed`, `expired`, `cancelled` or `withdrawn`; a consultation's `open`, `answered`, `expired` or `failed`.",
          }),
          agentId: z.uuid().openapi({ description: "The agent that asked; a hand-off's: whose screen it is." }),
          runId: z.uuid().nullable().openapi({ description: "The run that asked." }),
          channelId: z.uuid().nullable().openapi({
            description:
              "The conversation it was asked in; a consultation's: the two agents' own. Null for a hand-off.",
          }),
          threadRootId: z.uuid().nullable(),
          messageId: z.uuid().nullable().openapi({ description: "The message that shows it." }),
          tool: z.string().nullable().openapi({ description: "An approval's: the tool it would run." }),
          variant: z.string().nullable().openapi({
            description:
              "A hand-off's `ask` (the agent asked for a person) or `takeover` (a person took its screen unasked); a consultation's `question` or `note` (work handed to the other agent).",
          }),
          forUserIds: z.array(z.string()).openapi({
            description:
              "Whom it is asked of. An approval's: the people it names, else its agent's owner (whoever may approve actions in the workspace decides it too). The one person a question, a secret or a hand-off is for; empty for a question anyone in its conversation may answer.",
          }),
          forAgentId: z.uuid().nullable().openapi({ description: "A consultation's: the agent consulted." }),
          answerRunId: z.uuid().nullable().openapi({ description: "A consultation's: the other agent's run." }),
          byUserId: z.string().nullable().openapi({
            description: "Who decided or answered it; a hand-off's: who took control.",
          }),
          createdAt: Time,
          expiresAt: Time,
          resolvedAt: Time.nullable().openapi({
            description: "When it was decided, answered or delivered, or the person's turn ended.",
          }),
        })
        .openapi("OperatorWorkspaceAsk"),
    ),
    next: Next,
  })
  .openapi("OperatorAskPage");

const RoutineQuery = z.object({ agentId: z.uuid().optional(), ...paging });

const RoutinePage = z
  .object({
    routines: z.array(
      z.object({
        id: z.uuid(),
        agentId: z.uuid(),
        triggerType: z.string().openapi({
          description: "`schedule`, `once` (one time, at `nextRunAt`) or `event`.",
        }),
        cron: z.string().nullable().openapi({
          description:
            "A schedule's, as stored, in `timezone`. Null for a schedule only its stored rule can say (the last business day of a month…): `nextRunAt` still tells when.",
        }),
        timezone: z.string().nullable(),
        event: z.string().nullable().openapi({
          description:
            "The event that fires it: `issue.created`, `github.pr_opened`, `email.received`, `webhook.received`…",
        }),
        active: z.boolean().openapi({ description: "On. Off: paused by a person, or by itself (`pausedReason`)." }),
        pausedReason: z.string().nullable().openapi({ description: "Why it paused itself, as a code." }),
        target: z
          .object({
            type: z.string().nullable().openapi({
              description:
                "`channel`, `dm` (its creator's conversation with the agent), `artifact` (a file), `conversation` (where it was asked for) or `widget`.",
            }),
            channelId: z.uuid().nullable(),
            threadRootId: z.uuid().nullable(),
          })
          .openapi({ description: "Where it delivers." }),
        nextRunAt: Time.nullable(),
        lastRunAt: Time.nullable(),
        createdByUserId: z.string().nullable().openapi({ description: "Its runs act for this person." }),
        createdAt: Time,
        deletedAt: Time.nullable().openapi({ description: "Deleted: it never fires again, its firings stay." }),
        runs: z
          .array(
            z.object({
              id: z.uuid(),
              at: Time.openapi({ description: "The slot it fired for, or when it was fired by hand or by an event." }),
              trigger: z.string().openapi({ description: "`schedule`, `manual` or `event`." }),
              status: z.string().openapi({
                description:
                  "`queued`, `starting`, `started`, then how it ended: `reported`, `silent` (nothing new), `failed`, `canceled`, `superseded` (the next slot replaced it while it waited), `missed`, or `skipped` (the slot started no run).",
              }),
              code: z.string().nullable().openapi({ description: "Why it was skipped, missed, failed or stopped." }),
              runId: z.uuid().nullable().openapi({ description: "The run it started." }),
              messageId: z.uuid().nullable().openapi({ description: "The message where people saw its result." }),
              finishedAt: Time.nullable(),
            }),
          )
          .openapi({ description: `Its latest firings, newest first, at most ${OPERATOR_ROUTINE_RUNS}.` }),
      }),
    ),
    next: Next,
  })
  .openapi("OperatorRoutinePage");

/**
 * What a workspace connected, recorded, asked and scheduled (ADR 0056, its addendum on them): states, codes and
 * times, never a credential, an audit entry's details, what was asked or answered, nor a routine's instructions.
 * All `GET`.
 */
export function registerOperatorWorkspace(api: OpenAPIHono, { db }: OperatorDeps) {
  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/connections",
      tags,
      summary: "What a workspace connected for its agents: apps and servers, mailboxes and databases, newest first",
      description:
        "Removed ones too. Never a credential. No field says where one is, past the hostname of a server connected by address (`connector`): not a server's path, a mailbox's address or a database's host. Only `label` may, for a connection nobody named.",
      request: { params: OrgParams, query: z.object(paging) },
      responses: { 200: json(ConnectionPage), ...errors },
    }),
    async (c) => {
      const page = await operatorConnections(db, c.req.valid("param").orgId, c.req.valid("query"));
      if (!page) return apiError(c, 404, "not_found", "No workspace with this id");
      const listed = page.connections.map((k) => ({
        ...k,
        createdAt: k.createdAt.toISOString(),
        revokedAt: iso(k.revokedAt),
      }));
      return c.json({ connections: listed, next: page.next }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/audit",
      tags,
      summary: "A workspace's audit log, newest first: who did what to what, never an entry's details",
      description:
        "What people changed and what agents did, every entry as stored and without its details: those hold a tool's input and what a change was made of. A tool that writes an entry of its own beside its `tool.call` shows as two.",
      request: { params: OrgParams, query: AuditQuery },
      responses: { 200: json(AuditPage), ...errors },
    }),
    async (c) => {
      const found = await operatorAudit(db, c.req.valid("param").orgId, dated(c.req.valid("query")));
      if (!found) return apiError(c, 404, "not_found", "No workspace with this id");
      return c.json(
        {
          from: found.from.toISOString(),
          to: found.to.toISOString(),
          events: found.events.map((e) => ({ ...e, at: e.at.toISOString() })),
          next: found.next,
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/asks",
      tags,
      summary:
        "What a workspace's agents asked, newest first: approvals, questions, secrets, screens and consultations",
      description:
        "Who asked, whom, how it stands and when, never what was asked or answered: no approval's title or parameters, no question's or consultation's text, no secret's name or purpose.",
      request: { params: OrgParams, query: AskQuery },
      responses: { 200: json(AskPage), ...errors },
    }),
    async (c) => {
      const page = await operatorAsks(db, c.req.valid("param").orgId, dated(c.req.valid("query")));
      if (!page) return apiError(c, 404, "not_found", "No workspace with this id");
      const listed = page.asks.map((a) => ({
        ...a,
        createdAt: a.createdAt.toISOString(),
        expiresAt: a.expiresAt.toISOString(),
        resolvedAt: iso(a.resolvedAt),
      }));
      return c.json({ asks: listed, next: page.next }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/routines",
      tags,
      summary: "A workspace's routines, deleted ones too, newest first, each with its latest firings",
      description:
        "When each runs, whether it is on, where it delivers and how its latest firings ended. Never its instructions, nor what a firing reported. Never its name either: one nobody named is called by its instructions' first line.",
      request: { params: OrgParams, query: RoutineQuery },
      responses: { 200: json(RoutinePage), ...errors },
    }),
    async (c) => {
      const page = await operatorRoutines(db, c.req.valid("param").orgId, c.req.valid("query"));
      if (!page) return apiError(c, 404, "not_found", "No workspace with this id");
      const listed = page.routines.map((r) => ({
        ...r,
        nextRunAt: iso(r.nextRunAt),
        lastRunAt: iso(r.lastRunAt),
        createdAt: r.createdAt.toISOString(),
        deletedAt: iso(r.deletedAt),
        runs: r.runs.map((run) => ({ ...run, at: run.at.toISOString(), finishedAt: iso(run.finishedAt) })),
      }));
      return c.json({ routines: listed, next: page.next }, 200);
    },
  );
}
