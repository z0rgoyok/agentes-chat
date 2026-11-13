import {
  OPERATOR_AGENT_CHANNELS,
  OPERATOR_CHANNEL_KINDS,
  OPERATOR_MATCH_KINDS,
  OPERATOR_MEMBER_ASKS,
  OPERATOR_REF_FORMS,
  OPERATOR_RESOLVE_MAX,
  OPERATOR_USER_ORGS,
  operatorAgent,
  operatorAgents,
  operatorChannels,
  operatorFindUsers,
  operatorMembers,
  operatorResolve,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { iso, json, OrgParams } from "../routes/app/context";
import type { OperatorDeps } from "./app";
import { Role } from "./orgs";

const tags = ["Operator"];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong token"),
  404: errorResponse("Not found"),
};

export const paging = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
};
export const Next = z.string().nullable().openapi({ description: "`cursor` for the next page; null on the last one." });

// Postgres takes no NUL in text: refused here, it is a 400 and not a failed query.
export const word = () =>
  z
    .string()
    .trim()
    .min(1)
    .max(320)
    .refine((v) => !v.includes("\0"), "Invalid character");

const UserQuery = z.object({
  email: word().optional().openapi({ description: "The whole address; any case." }),
  q: word().optional().openapi({ description: "Part of an address or of a name; any case, matched literally." }),
  ...paging,
});

const UserPage = z
  .object({
    users: z.array(
      z.object({
        id: z.string(),
        email: z.string(),
        name: z.string(),
        emailVerified: z.boolean(),
        createdAt: z.string(),
        blockedAt: z
          .string()
          .nullable()
          .openapi({ description: "Since when it is blocked (`PUT /users/{userId}/block`)." }),
        blockedReason: z.string().nullable(),
        deletionDueAt: z
          .string()
          .nullable()
          .openapi({ description: "The person deleted it: gone for good then. Null: not being deleted." }),
        lastSignInAt: z.string().nullable().openapi({
          description: "When its newest session on record began. Signing out deletes a session, so null says little.",
        }),
        orgs: z.array(z.object({ orgId: z.uuid(), name: z.string(), role: Role })).openapi({
          description: `Its workspaces, oldest membership first, at most ${OPERATOR_USER_ORGS}.`,
        }),
        orgCount: z.number().int().openapi({ description: "How many workspaces it is in." }),
      }),
    ),
    next: Next,
  })
  .openapi("OperatorUserPage");

const ResolveQuery = z.object({
  ref: z.string().trim().min(1).max(2000).openapi({
    description:
      "A message's or a file's link (a path, or a full address), `@handle` of an agent or a person, `#channel`, a task's number (`12` or `#12`), an id, the first 8 characters of an id, or an account's id.",
  }),
  orgId: z.uuid().optional().openapi({
    description:
      "Look only in this workspace. Required for a handle, a channel, a task's number and the start of an id; a link names its own.",
  }),
});

const Resolved = z
  .object({
    form: z.enum(OPERATOR_REF_FORMS).openapi({
      description: "How `ref` was read. With no match: nothing by that handle, number or id here.",
    }),
    matches: z
      .array(
        z.object({
          kind: z.enum(OPERATOR_MATCH_KINDS).openapi({
            description:
              "`user`: an account (by its id) or a member (by handle). `dm`: a direct conversation. `task_conversation`: the channel a task's conversation is in. `file`: a file in the Drive. `computer`: a connected computer. `ai_account`: a sign-in to an AI plan on a computer.",
          }),
          id: z.string(),
          orgId: z.uuid().nullable().openapi({ description: "Null only for an account found by its id." }),
          name: z.string().nullable().openapi({
            description:
              "A workspace's, a person's, an agent's, a channel's or a computer's. Never a task's or a file's.",
          }),
          handle: z.string().nullable().openapi({ description: "An agent's, or a member's in that workspace." }),
          email: z.string().nullable(),
          channelId: z.uuid().nullable().openapi({
            description: "Where a message, a run or a file is; a task's conversation, once it has one.",
          }),
          threadRootId: z.uuid().nullable().openapi({
            description: "The thread a reply, a run or a file is in; null for a message outside any thread.",
          }),
          agentId: z.uuid().nullable().openapi({ description: "A run's agent; a message's author when an agent." }),
          runId: z.uuid().nullable().openapi({ description: "The run that wrote a message." }),
          number: z.number().int().nullable().openapi({ description: "A task's." }),
          version: z.number().int().nullable().openapi({
            description: "A file's: the one its link names, else its current one.",
          }),
          createdAt: z.string(),
        }),
      )
      .openapi({ description: `At most ${OPERATOR_RESOLVE_MAX}. The start of an id can match several things.` }),
  })
  .openapi("OperatorResolved");

const Members = z
  .object({
    members: z
      .array(
        z.object({
          userId: z.string(),
          email: z.string(),
          name: z.string(),
          handle: z.string().nullable().openapi({ description: "`@ana` in this workspace; null until given one." }),
          role: Role,
          joinedAt: z.string(),
          lastSeenAt: z.string().nullable().openapi({ description: "Last time they had this workspace open." }),
          blockedAt: z.string().nullable().openapi({ description: "Blocked accounts are members of nothing." }),
          deletionDueAt: z.string().nullable().openapi({
            description: "The person deleted their account: until it goes, it reads as no member.",
          }),
        }),
      )
      .openapi({ description: "In the order they joined." }),
    next: Next,
    invitations: z
      .array(
        z.object({
          id: z.uuid(),
          email: z.string(),
          role: z.enum(["owner", "member"]),
          invitedByUserId: z.string().nullable(),
          createdAt: z.string(),
          expiresAt: z.string().openapi({ description: "Past: it expired without being accepted." }),
        }),
      )
      .openapi({
        description: `Not accepted, expired ones too, newest first, at most ${OPERATOR_MEMBER_ASKS}, on every page. Never the link.`,
      }),
    joinRequests: z
      .array(
        z.object({
          id: z.uuid(),
          email: z.string(),
          name: z.string(),
          userId: z.string().nullable().openapi({ description: "The account that asked, when signed in." }),
          status: z.enum(["pending", "approved", "denied", "closed"]).openapi({
            description: "`pending` past `expiresAt` is an expired request.",
          }),
          verifiedAt: z.string().nullable().openapi({ description: "When the person proved the address." }),
          createdAt: z.string(),
          expiresAt: z.string(),
          decidedAt: z.string().nullable(),
          decidedByUserId: z.string().nullable(),
          invitationId: z.uuid().nullable().openapi({
            description: "The invitation an approval sent, when the address wasn't proven.",
          }),
        }),
      )
      .openapi({
        description: `Newest first, at most ${OPERATOR_MEMBER_ASKS}, on every page; answered and expired ones are deleted after 90 days. Never the person's note.`,
      }),
  })
  .openapi("OperatorMembers");

const ChannelQuery = z.object({
  kind: z.enum(OPERATOR_CHANNEL_KINDS).optional().openapi({
    description: "`channel`, `dm` (a direct conversation) or `task` (a task's conversation). Absent: all of them.",
  }),
  ...paging,
});

const ChannelPage = z
  .object({
    channels: z.array(
      z.object({
        id: z.uuid(),
        name: z.string().openapi({ description: "A channel's name. A direct or a task's conversation's is made up." }),
        kind: z.string().openapi({ description: "`channel`, `dm` or `task`." }),
        visibility: z.enum(["public", "private"]),
        people: z.number().int().openapi({ description: "People in it." }),
        agents: z.number().int().openapi({ description: "Agents in it." }),
        createdAt: z.string(),
        archivedAt: z.string().nullable(),
        deletedAt: z.string().nullable().openapi({
          description: "Deleted: its contents are gone, the row stays for its runs and usage.",
        }),
      }),
    ),
    next: Next,
  })
  .openapi("OperatorChannelPage");

const Hold = z
  .object({ heldAt: z.string(), reason: z.string().nullable() })
  .nullable()
  .openapi({ description: "The operator's hold on it (`PUT /orgs/{orgId}/agents/{agentId}/hold`); null when none." });

const agentFields = {
  id: z.uuid(),
  orgId: z.uuid(),
  name: z.string(),
  handle: z.string().openapi({ description: "`deleted-<id>` once deleted." }),
  builtin: z
    .string()
    .nullable()
    .openapi({ description: "`right_hand`: the one the product ships. Null: made by people." }),
  ownerUserId: z.string().nullable(),
  brain: z.string().openapi({
    description:
      "Who thinks for it: `model` (a provider's API), or a coding CLI on its computer (`claude_code`, `codex`…).",
  }),
  model: z.string().openapi({ description: "The API's model: what `model` thinks with, and a CLI's fallback." }),
  brainModel: z.string().nullable().openapi({ description: "The CLI's model; null: its default." }),
  credentialId: z.uuid().nullable().openapi({
    description: "The workspace's provider credential the API bills to; null: the platform's, where there is one.",
  }),
  accountId: z.uuid().nullable().openapi({
    description: "The AI account its CLI runs with (`GET /ai-accounts`); null: the computer's own sign-in.",
  }),
  machineId: z.uuid().nullable().openapi({ description: "Its computer." }),
  approvalsLevel: z.string().openapi({ description: "How much it asks before acting: `always`, `risky` or `never`." }),
  audienceMode: z.string().openapi({ description: "Who can talk to it: `everyone`, `people` or `owner`." }),
  hold: Hold,
  createdAt: z.string(),
  archivedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
};

/** An AI account without its email, its label or a hint of its key. */
export const accountFacts = {
  id: z.uuid(),
  kind: z.string().openapi({ description: "The CLI it signs in to: `claude_code`, `codex`…" }),
  provider: z.string().nullable().openapi({ description: "A coding plan's id; null: the CLI's own sign-in." }),
  authMethod: z.string().nullable(),
  plan: z.string().nullable(),
  status: z.string().openapi({ description: "`active`, `signed_out`, `signing_in` or `removing`." }),
  statusUnknown: z.boolean().openapi({ description: "Its runner's last look at `status` was inconclusive." }),
  lastSuccessAt: z.string().nullable(),
  lastFailureCause: z.string().nullable(),
  lastFailureAt: z.string().nullable(),
};

const AgentPage = z.object({ agents: z.array(z.object(agentFields)), next: Next }).openapi("OperatorAgentPage");

const Agent = z
  .object({
    ...agentFields,
    previousHandles: z.array(z.string()).openapi({ description: "Handles it had before a rename, oldest first." }),
    fallback: z.boolean().openapi({ description: "When its CLI can't answer, it answers through the API." }),
    provider: z.string().nullable().openapi({
      description: "The API's provider: its credential's, else the model's own; null when neither says.",
    }),
    credential: z
      .object({ id: z.uuid(), provider: z.string(), revokedAt: z.string().nullable() })
      .nullable()
      .openapi({ description: "`credentialId`'s: never the credential itself nor a hint of it." }),
    account: z
      .object(accountFacts)
      .nullable()
      .openapi({ description: "`accountId`'s. No email or label: `GET /ai-accounts` has the label." }),
    machine: z
      .object({
        id: z.uuid(),
        name: z.string(),
        kind: z.enum(["connected", "host", "managed"]),
        online: z.boolean(),
        lastSeenAt: z.string().nullable(),
      })
      .nullable(),
    channels: z
      .array(
        z.object({
          id: z.uuid(),
          name: z.string(),
          autoReply: z.boolean().openapi({
            description: "It may answer messages that don't mention it there. Off: only when mentioned.",
          }),
        }),
      )
      .openapi({
        description: `The channels it is in, by name, at most ${OPERATOR_AGENT_CHANNELS}. No direct or task conversations.`,
      }),
    counts: z.object({
      skills: z.number().int().openapi({ description: "Skills turned on for it." }),
      routines: z.number().int().openapi({ description: "Its routines not deleted, paused ones too." }),
      memories: z.number().int().openapi({ description: "Its own memories in use." }),
    }),
  })
  .openapi("OperatorAgent");

const AgentParams = z.object({ agentId: z.uuid().openapi({ param: { name: "agentId", in: "path" } }) });

type AgentRow = NonNullable<Awaited<ReturnType<typeof operatorAgents>>>["agents"][number];
const agentJson = <T extends AgentRow>(a: T) => ({
  ...a,
  hold: a.hold && { heldAt: a.hold.heldAt.toISOString(), reason: a.hold.reason },
  createdAt: a.createdAt.toISOString(),
  archivedAt: iso(a.archivedAt),
  deletedAt: iso(a.deletedAt),
});

/** Lookups (ADR 0056, its addendum on lookups): who and what, never what anyone wrote. All `GET`. */
export function registerOperatorLookups(api: OpenAPIHono, { db }: OperatorDeps) {
  api.openapi(
    createRoute({
      method: "get",
      path: "/users",
      tags,
      summary: "Find accounts by their address, or by part of an address or of a name, newest first",
      description: "`email` or `q` is required; with both, an account matches both.",
      request: { query: UserQuery },
      responses: { 200: json(UserPage), 400: errors[400], 401: errors[401] },
    }),
    async (c) => {
      const query = c.req.valid("query");
      if (!query.email && !query.q) return apiError(c, 400, "invalid_request", "email or q is required");
      const page = await operatorFindUsers(db, query);
      const found = page.users.map((u) => ({
        ...u,
        createdAt: u.createdAt.toISOString(),
        blockedAt: iso(u.blockedAt),
        deletionDueAt: iso(u.deletionDueAt),
        lastSignInAt: iso(u.lastSignInAt),
      }));
      return c.json({ users: found, next: page.next }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/resolve",
      tags,
      summary: "What a link, a handle, a channel, a task's number or an id names, and its ids",
      description:
        "For what a report quotes: answers what each thing is and where it lives, so the other reads can be called with ids. A reference that reads as none of the forms is a 400.",
      request: { query: ResolveQuery },
      responses: { 200: json(Resolved), 400: errors[400], 401: errors[401] },
    }),
    async (c) => {
      const { form, matches } = await operatorResolve(db, c.req.valid("query"));
      return c.json({ form, matches: matches.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/members",
      tags,
      summary: "A workspace's people: its members, its invitations not accepted and its join requests",
      request: { params: OrgParams, query: z.object(paging) },
      responses: { 200: json(Members), ...errors },
    }),
    async (c) => {
      const found = await operatorMembers(db, c.req.valid("param").orgId, c.req.valid("query"));
      if (!found) return apiError(c, 404, "not_found", "No workspace with this id");
      return c.json(
        {
          members: found.members.map((m) => ({
            ...m,
            joinedAt: m.joinedAt.toISOString(),
            lastSeenAt: iso(m.lastSeenAt),
            blockedAt: iso(m.blockedAt),
            deletionDueAt: iso(m.deletionDueAt),
          })),
          next: found.next,
          invitations: found.invitations.map((i) => ({
            ...i,
            createdAt: i.createdAt.toISOString(),
            expiresAt: i.expiresAt.toISOString(),
          })),
          joinRequests: found.joinRequests.map((r) => ({
            ...r,
            verifiedAt: iso(r.verifiedAt),
            createdAt: r.createdAt.toISOString(),
            expiresAt: r.expiresAt.toISOString(),
            decidedAt: iso(r.decidedAt),
          })),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/channels",
      tags,
      summary: "A workspace's channels and conversations with how many are in each, newest first",
      request: { params: OrgParams, query: ChannelQuery },
      responses: { 200: json(ChannelPage), ...errors },
    }),
    async (c) => {
      const page = await operatorChannels(db, c.req.valid("param").orgId, c.req.valid("query"));
      if (!page) return apiError(c, 404, "not_found", "No workspace with this id");
      const listed = page.channels.map((ch) => ({
        ...ch,
        createdAt: ch.createdAt.toISOString(),
        archivedAt: iso(ch.archivedAt),
        deletedAt: iso(ch.deletedAt),
      }));
      return c.json({ channels: listed, next: page.next }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/agents",
      tags,
      summary: "A workspace's agents, archived and deleted ones too, newest first",
      request: { params: OrgParams, query: z.object(paging) },
      responses: { 200: json(AgentPage), ...errors },
    }),
    async (c) => {
      const page = await operatorAgents(db, c.req.valid("param").orgId, c.req.valid("query"));
      if (!page) return apiError(c, 404, "not_found", "No workspace with this id");
      return c.json({ agents: page.agents.map(agentJson), next: page.next }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/agents/{agentId}",
      tags,
      summary: "One agent: who thinks for it, its computer, its channels, and how much it has",
      description: "Never its instructions, nor the text of a skill, a routine or a memory.",
      request: { params: AgentParams },
      responses: { 200: json(Agent), ...errors },
    }),
    async (c) => {
      const agent = await operatorAgent(db, c.req.valid("param").agentId);
      if (!agent) return apiError(c, 404, "not_found", "No agent with this id");
      const { credential, account, machine } = agent;
      return c.json(
        {
          ...agentJson(agent),
          credential: credential && { ...credential, revokedAt: iso(credential.revokedAt) },
          account: account && {
            ...account,
            lastSuccessAt: iso(account.lastSuccessAt),
            lastFailureAt: iso(account.lastFailureAt),
          },
          machine: machine && { ...machine, lastSeenAt: iso(machine.lastSeenAt) },
        },
        200,
      );
    },
  );
}
