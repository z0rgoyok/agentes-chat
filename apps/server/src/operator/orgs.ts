import { isWorkAreaAnswer, WORK_AREA_ANSWERS } from "@agenteschat/client/lib/work-area";
import { eq, schema } from "@agenteschat/db";
import {
  liveProcesses,
  operatorListOrgs,
  operatorOrg,
  operatorUser,
  PROCESS_LIVE_MS,
  RUN_CLAIM_WINDOW_MS,
  removeOrgLogo,
  runClaimWaits,
  setOrgAccent,
  setOrgLogo,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { body, iso, json, OrgParams } from "../routes/app/context";
import { AccentColor } from "../routes/app/schemas";
import type { OperatorDeps } from "./app";
import { LimitsState, limitsJson, Meters } from "./limits";
import { Standing, StandingState, standingJson, UserParams } from "./standing";

/**
 * A person's place in a workspace, as the operator API has always named it: an owner, someone holding
 * `administrator` (ADR 0085), or a member.
 */
export const Role = z.enum(["owner", "admin", "member"]).openapi("Role");

const tags = ["Operator"];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong token"),
  404: errorResponse("Not found"),
};

const BotCheck = z
  .object({
    state: z.enum(["off", "ok", "unreachable", "secret_refused"]).openapi({
      description:
        "`off` without both Turnstile keys. While `unreachable` (this server can't reach Cloudflare) or `secret_refused` (Cloudflare refuses `TURNSTILE_SECRET_KEY`), every request goes through unchecked.",
    }),
    since: z.iso.datetime({ offset: true }).openapi({ description: "When it took this state." }),
    blocked: z.number().int().min(0).openapi({
      description:
        "Networks refused in the last 10 minutes because their page couldn't load the check (`human_check_blocked`), each counted once: an IPv4 address, or an IPv6 /64. Any client can claim its page couldn't load it, so read it beside `passed`.",
    }),
    passed: z.number().int().min(0).openapi({
      description:
        "Tokens Cloudflare passed in the last 10 minutes. When the widget is down for everyone, `blocked` rises while this falls. Clients claiming it is down don't move it.",
    }),
    testing: z.boolean().openapi({
      description:
        "`TURNSTILE_SECRET_KEY` is one of Cloudflare's test secrets. They refuse real tokens, and the one that passes takes a public dummy token from anyone. Right only on a test server.",
    }),
  })
  .openapi("OperatorBotCheck");

const Health = z
  .object({
    ok: z.literal(true),
    version: z.string(),
    botCheck: BotCheck.openapi({ description: "The bot check before public forms (ADR 0075)." }),
    eventLoopLag: z
      .object({ p50Ms: z.number(), p99Ms: z.number(), maxMs: z.number(), at: z.string() })
      .nullable()
      .openapi({
        description:
          "How late this process ran what was due over its last minute, from the runtime's own sampling (also logged as `event loop lag`). Null: no minute ended yet.",
      }),
  })
  .openapi("OperatorHealth");

const ms = (description: string) => z.number().int().nullable().openapi({ description });

/** One measure across the apps' reports of a minute. */
const ClientVitalStat = z
  .object({ n: z.number().int(), p50: z.number(), p95: z.number(), max: z.number() })
  .openapi("OperatorClientVitalStat");

const Vitals = z
  .object({
    at: z.string(),
    processes: z
      .array(
        z.object({
          id: z.uuid(),
          role: z.string().openapi({ description: "`SERVER_ROLE`: `all` (the app and jobs) or `worker`." }),
          version: z.string(),
          startedAt: z.string(),
          seenAt: z.string().openapi({ description: "When it last wrote these, about once a minute." }),
          rssBytes: z.number().int(),
          heapUsedBytes: z.number().int(),
          heapTotalBytes: z.number().int(),
          eventLoopP99Ms: z.number().nullable().openapi({
            description: "How late its event loop ran what was due over its last minute; null before one ended.",
          }),
          eventLoopMaxMs: z.number().nullable(),
          heapSnapshot: z
            .object({ at: z.string(), file: z.string() })
            .nullable()
            .openapi({ description: "The heap snapshot it wrote (`HEAP_SNAPSHOT_MB`), in `HEAP_SNAPSHOT_DIR`." }),
          routes: z
            .array(
              z.object({
                route: z.string().openapi({ description: "Method and route as registered, ids left out." }),
                count: z.number().int(),
                p95Ms: z.number().int(),
                maxMs: z.number().int(),
                totalMs: z.number().int(),
              }),
            )
            .openapi({
              description:
                "The HTTP routes that took it the most time over its last minute, the most first. Empty for a worker.",
            }),
          clientVitals: z
            .record(
              z.string(),
              z.object({
                reports: z.number().int(),
                coldStartMs: ClientVitalStat.optional(),
                firstRowsMs: ClientVitalStat.optional(),
                jsLagP95Ms: ClientVitalStat.optional(),
                jsLagMaxMs: ClientVitalStat.optional(),
                heapBytes: ClientVitalStat.optional(),
                getsPerReturn: ClientVitalStat.optional(),
                reconnects: ClientVitalStat.optional(),
              }),
            )
            .nullable()
            .openapi({
              description:
                "What the apps that reported to it over its last minute measured, by platform (`ios`, `android`, `web`): cold start to the first frame and to the first rows, JavaScript stalls, heap, reads after each return to the app, socket reconnects. Null: no report.",
            }),
        }),
      )
      .openapi({
        description: `Every process on this database that wrote its vitals in the last ${PROCESS_LIVE_MS / 60_000} minutes (the app's and every worker's), the newest first.`,
      }),
    runClaims: z
      .object({
        windowSeconds: z.number().int(),
        runs: z.number().int().openapi({ description: "Runs claimed in the window plus runs still waiting." }),
        queued: z.number().int().openapi({ description: "Runs still waiting for a worker." }),
        p50Ms: ms("Of `runs`: how long each waited from its creation to its claim, or until now if still waiting."),
        p95Ms: ms("The same, 95th percentile. Null: no run."),
        oldestQueuedMs: ms("How long the run waiting longest has waited. Null: none waits."),
      })
      .openapi({
        description: `How long agents' runs for people wait for a worker (routines' background runs, which wait behind them by design, left out): those claimed in the last ${RUN_CLAIM_WINDOW_MS / 60_000} minutes and those still waiting (created in the last hour). Growing while every process looks idle: jobs aren't being claimed.`,
      }),
  })
  .openapi("OperatorVitals");

const OrgSummary = z
  .object({
    id: z.uuid(),
    name: z.string(),
    createdAt: z.string(),
    standing: StandingState,
    members: z
      .number()
      .int()
      .openapi({ description: "The people its `members` limit counts: no outside collaborators." }),
    agents: z.number().int().openapi({ description: "Not archived." }),
  })
  .openapi("OperatorOrgSummary");

const OrgPage = z
  .object({
    orgs: z.array(OrgSummary),
    next: z.string().nullable().openapi({ description: "`cursor` for the next page; null on the last one." }),
  })
  .openapi("OperatorOrgPage");

const OrgQuery = z.object({
  q: z
    .string()
    .max(320)
    .optional()
    .openapi({ description: "An org id, part of its name, or part of a member's email; any case." }),
  createdAfter: z.iso.datetime({ offset: true }).optional(),
  standing: StandingState.optional().openapi({ description: "Only the workspaces in this standing." }),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

const Org = z
  .object({
    id: z.uuid(),
    name: z.string(),
    createdAt: z.string(),
    standing: Standing,
    admins: z
      .array(
        z.object({
          userId: z.string(),
          email: z.string(),
          name: z.string(),
          role: Role,
          createdAt: z.string().openapi({ description: "When the account was created." }),
          lastSeenAt: z.string().nullable().openapi({ description: "Last time they had this workspace open." }),
        }),
      )
      .openapi({ description: "Owners and admins, owners first." }),
    counts: z.object({
      members: z
        .number()
        .int()
        .openapi({ description: "The people its `members` limit counts: no outside collaborators (ADR 0191)." }),
      agents: z.number().int().openapi({ description: "Not archived." }),
      channels: z.number().int().openapi({ description: "Channels, not archived; no direct messages." }),
      machines: z.number().int().openapi({ description: "Connected computers." }),
      invitations: z.number().int().openapi({ description: "Pending: neither accepted nor expired." }),
    }),
    limits: LimitsState,
    meters: Meters,
    deletion: z
      .object({
        dueAt: z.string().openapi({ description: "When it is deleted for good, unless a hold keeps it longer." }),
        requestedAt: z.string().nullable(),
        requestedBy: z.string().nullable().openapi({ description: "Who asked; null once their account is gone." }),
      })
      .nullable()
      .openapi({
        description:
          "Its deletion, asked by an owner or with its only member's account: closed until `dueAt`. Null when it isn't being deleted.",
      }),
    deletionHold: z
      .object({
        heldAt: z.string(),
        reason: z.string().nullable(),
      })
      .nullable()
      .openapi({ description: "The operator's deletion hold (`PUT /orgs/{orgId}/deletion-hold`); null when none." }),
  })
  .openapi("OperatorOrg");

const User = z
  .object({
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
    workArea: z.enum(WORK_AREA_ANSWERS).nullable().openapi({
      description:
        "The person's own area, asked once during the onboarding: `dev`, `marketing`, `sales`, `finance`, `ops`, `support`, `other`, or `skipped`; null until asked (or for an account from before the question).",
    }),
    orgs: z.array(
      z.object({
        orgId: z.uuid(),
        name: z.string(),
        role: Role,
        joinedAt: z.string(),
        lastSeenAt: z.string().nullable(),
      }),
    ),
    sessions: z
      .array(z.object({ ip: z.string().nullable(), userAgent: z.string().nullable(), createdAt: z.string() }))
      .openapi({ description: "Its 10 newest sessions on record, newest first. Signing out deletes a session." }),
  })
  .openapi("OperatorUser");

const Look = z
  .object({
    accent: AccentColor.nullable()
      .optional()
      .openapi({ description: "Its accent color; null: the default. Left out: left as it is." }),
    logo: z
      .object({
        contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
        base64: z.string().min(1).max(3_000_000).openapi({ description: "The image's bytes in base64, up to 2 MB." }),
      })
      .nullable()
      .optional()
      .openapi({
        description:
          "Its logo, square (the apps show it at 512×512 at most); checked by its bytes, metadata removed. Null: back to the agent mark. Left out: left as it is.",
      }),
  })
  .openapi("OperatorLook");

const LookState = z
  .object({
    accent: AccentColor.nullable(),
    logo: z
      .string()
      .nullable()
      .openapi({ description: "Where its members' apps load the logo; null: the agent mark." }),
  })
  .openapi("OperatorLookState");

export function registerOperatorOrgs(
  api: OpenAPIHono,
  { db, version, humanCheck, eventLoopLag, pubsub, blobs }: OperatorDeps,
) {
  const started = new Date();
  api.openapi(
    createRoute({
      method: "get",
      path: "/health",
      tags,
      summary: "The token works and this server answers, with its bot check's state",
      responses: { 200: json(Health), 401: errors[401] },
    }),
    (c) => {
      const check = humanCheck?.status() ?? {
        state: "off" as const,
        since: started,
        blocked: 0,
        passed: 0,
        testing: false,
      };
      return c.json(
        {
          ok: true as const,
          version,
          botCheck: { ...check, since: check.since.toISOString() },
          eventLoopLag: eventLoopLag?.() ?? null,
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/vitals",
      tags,
      summary: "Each server process's memory and event loop delay, and how long runs wait to be claimed",
      responses: { 200: json(Vitals), 401: errors[401] },
    }),
    async (c) => {
      const now = new Date();
      const [processes, claims] = await Promise.all([liveProcesses(db, now), runClaimWaits(db, now)]);
      return c.json(
        {
          at: now.toISOString(),
          processes: processes.map((p) => ({
            id: p.id,
            role: p.role,
            version: p.version,
            startedAt: p.startedAt.toISOString(),
            seenAt: p.seenAt.toISOString(),
            rssBytes: p.rssBytes,
            heapUsedBytes: p.heapUsedBytes,
            heapTotalBytes: p.heapTotalBytes,
            eventLoopP99Ms: p.eventLoopP99Ms,
            eventLoopMaxMs: p.eventLoopMaxMs,
            heapSnapshot:
              p.heapSnapshotAt && p.heapSnapshotFile
                ? { at: p.heapSnapshotAt.toISOString(), file: p.heapSnapshotFile }
                : null,
            routes: p.routes ?? [],
            clientVitals: p.clientVitals ?? null,
          })),
          runClaims: claims,
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs",
      tags,
      summary: "Find workspaces, newest first",
      request: { query: OrgQuery },
      responses: { 200: json(OrgPage), 400: errors[400], 401: errors[401] },
    }),
    async (c) => {
      const { createdAfter, ...query } = c.req.valid("query");
      const page = await operatorListOrgs(db, {
        ...query,
        createdAfter: createdAfter ? new Date(createdAfter) : undefined,
      });
      return c.json({ ...page, orgs: page.orgs.map((o) => ({ ...o, createdAt: o.createdAt.toISOString() })) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}",
      tags,
      summary: "One workspace: its owners and admins, how much is in it, and its limits with what it uses",
      request: { params: OrgParams },
      responses: { 200: json(Org), ...errors },
    }),
    async (c) => {
      const org = await operatorOrg(db, c.req.valid("param").orgId);
      if (!org) return apiError(c, 404, "not_found", "No workspace with this id");
      return c.json(
        {
          ...org,
          createdAt: org.createdAt.toISOString(),
          standing: standingJson(org.standing),
          limits: limitsJson(org.limits),
          deletion: org.deletion && {
            dueAt: org.deletion.dueAt.toISOString(),
            requestedAt: iso(org.deletion.requestedAt),
            requestedBy: org.deletion.requestedBy,
          },
          deletionHold: org.deletionHold && {
            heldAt: org.deletionHold.heldAt.toISOString(),
            reason: org.deletionHold.reason,
          },
          admins: org.admins.map((a) => ({
            ...a,
            createdAt: a.createdAt.toISOString(),
            lastSeenAt: iso(a.lastSeenAt),
          })),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/orgs/{orgId}/look",
      tags,
      summary: "Set a workspace's logo and accent color (ADR 0193)",
      description:
        "What its members see in their apps, at once: a hosted service can give several workspaces one look. Recorded in the workspace's audit as done by the system, as when its admins change them in Settings, who can still change them afterwards. A logo that isn't a JPEG, PNG or WebP of up to 2 MB is refused (`logo.type`, `logo.too_large`, `logo.not_base64`, `logo.empty`) and nothing changes.",
      request: { params: OrgParams, body: body(Look) },
      responses: { 200: json(LookState), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { accent, logo } = c.req.valid("json");
      const look = async () =>
        (
          await db
            .select({ accent: schema.organizations.accent, logo: schema.organizations.logo })
            .from(schema.organizations)
            .where(eq(schema.organizations.id, orgId))
        )[0];
      if (!(await look())) return apiError(c, 404, "not_found", "No workspace with this id");
      if (logo !== undefined) {
        if (!blobs) throw new Error("the operator API needs the platform's blob store to set a logo");
        if (logo) await setOrgLogo({ db, blobs, pubsub }, null, orgId, { imageBase64: logo.base64, ...logo });
        else await removeOrgLogo({ db, blobs, pubsub }, null, orgId);
      }
      if (accent !== undefined) await setOrgAccent({ db, pubsub }, null, orgId, accent);
      const after = await look();
      return c.json({ accent: after?.accent ?? null, logo: after?.logo ?? null }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/users/{userId}",
      tags,
      summary: "One account: its workspaces and newest sessions",
      request: { params: UserParams },
      responses: { 200: json(User), ...errors },
    }),
    async (c) => {
      const user = await operatorUser(db, c.req.valid("param").userId);
      if (!user) return apiError(c, 404, "not_found", "No account with this id");
      return c.json(
        {
          ...user,
          createdAt: user.createdAt.toISOString(),
          blockedAt: iso(user.blockedAt),
          workArea: isWorkAreaAnswer(user.workArea) ? user.workArea : null,
          orgs: user.orgs.map((o) => ({ ...o, joinedAt: o.joinedAt.toISOString(), lastSeenAt: iso(o.lastSeenAt) })),
          sessions: user.sessions.map((s) => ({ ...s, createdAt: s.createdAt.toISOString() })),
        },
        200,
      );
    },
  );
}
