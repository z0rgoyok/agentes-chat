import {
  BILLING_HOLDS,
  getOrgLimits,
  instanceStoredBytes,
  publishOrgEvent,
  setBillingHold,
  setOrgLimits,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { body, iso, json, OrgParams } from "../routes/app/context";
import type { OperatorDeps } from "./app";
import { Standing, standingJson } from "./standing";

const tags = ["Operator"];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong token"),
  404: errorResponse("Not found"),
};

export const BillingHold = z.enum(BILLING_HOLDS).openapi("OperatorBillingHold", {
  description:
    "`payment`: no plan yet. `unpaid`: its payment failed. `ended`: its plan ended. Agents stop as with any hold; people still read and write.",
});

const BillingHoldResult = z
  .object({
    applied: z.boolean().openapi({
      description:
        "False when nothing changed: already so, or a hold set through PUT /standing or a suspension is in place, which a billing hold never replaces.",
    }),
    standing: Standing,
  })
  .openapi("OperatorBillingHoldResult");

export const Limits = z
  .object({
    members: z.number().int().min(1).max(100_000).nullable().openapi({
      description:
        "People in it, blocked accounts included; agents, invitations, requests to join and outside collaborators (ADR 0191) never count.",
    }),
    membersMax: z.number().int().min(1).max(100_000).nullable().default(null).openapi({
      description:
        "The most people its plan takes with seats added. Below it, the apps tell whoever manages billing that a full workspace can add a seat; at it, that the plan can change. Null (or left out): not said, and the apps say neither.",
    }),
    payerUserId: z.string().min(1).max(200).nullable().default(null).openapi({
      description:
        "The user id of whoever pays for its plan, the only one who can add seats or change plans. In a full workspace they read that they can add a seat, and anyone else who manages billing reads to ask them, by name while they are in the workspace. Null (or left out): not said, and whoever manages billing reads that they can add a seat.",
    }),
    storageBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().openapi({
      description: "Bytes of files kept on this server's storage; files in the trash and its own bucket don't count.",
    }),
    uploadBytesPerDay: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .openapi({ description: "Bytes written to this server's storage in any 24 hours." }),
    platformUsdPerMonth: z.number().min(0).max(100_000).nullable().openapi({
      description:
        "What the platform's own AI (Jev) may cost for it in a UTC calendar month, in US$. Past it, Jev's judgments go to the workspace's own model and only @mentions start agents.",
    }),
    connectorUsdPerMonth: z.number().min(0).max(100_000).nullable().default(null).openapi({
      description:
        "What vendors that bill this server per call (X) may charge for it in a UTC calendar month, in US$, as estimated from their price lists. A call that could take it past is refused (`connector.capped`), with nothing done. Null (or left out): no limit.",
    }),
  })
  .openapi("OperatorLimits", { description: "Null: no limit. A self-hosted server never sets any." });

export const LimitsState = Limits.extend({
  updatedAt: z.string().nullable().openapi({ description: "When a value last changed; null: never set." }),
}).openapi("OperatorLimitsState");

export const Meters = z
  .object({
    storageBytes: z.number().int().openapi({
      description:
        "Bytes of files kept on this server's storage, files in the trash and the workspace's own bucket left out.",
    }),
    uploadBytes24h: z
      .number()
      .int()
      .openapi({ description: "Bytes written to this server's storage in the last 24 hours." }),
    ownStorage: z
      .boolean()
      .openapi({ description: "New files go to the workspace's own bucket: no storage limit applies." }),
    platformUsdThisMonth: z
      .number()
      .openapi({ description: "Usage billed to the platform (Jev) this UTC calendar month, in US$." }),
    connectorUsdThisMonth: z.number().openapi({
      description:
        "What vendors that bill per call (X) charged for its connector calls this UTC calendar month, in US$.",
    }),
  })
  .openapi("OperatorMeters");

const StorageTotal = z
  .object({
    storageBytes: z.number().int().openapi({
      description:
        "The sum of `meters.storageBytes` over the workspaces that keep their files on this server's storage.",
    }),
    workspaces: z
      .number()
      .int()
      .openapi({ description: "How many workspaces it is the sum of: those with at least one byte counted." }),
    ownStorageWorkspaces: z.number().int().openapi({
      description: "How many workspaces keep their files in a bucket of their own (`meters.ownStorage`): left out.",
    }),
  })
  .openapi("OperatorStorageTotal");

/** The limits in the API's shape. */
export const limitsJson = ({ updatedAt, ...limits }: z.infer<typeof Limits> & { updatedAt: Date | null }) => ({
  ...limits,
  updatedAt: iso(updatedAt),
});

/**
 * Billing holds and limits (ADR 0079): what a billing service applies, knowing plans this server never does. With
 * them, the storage meter summed for the whole instance.
 */
export function registerOperatorLimits(api: OpenAPIHono, { db, pubsub, hub }: OperatorDeps) {
  api.openapi(
    createRoute({
      method: "put",
      path: "/orgs/{orgId}/billing-hold",
      tags,
      summary: "Put a billing hold on a workspace, change its code, or lift it",
      description:
        "A billing hold is a hold with one of these codes as its reason and the notice `shown`: the workspace reads it in its own words, and owners and admins get the way to fix it. It never replaces nor lifts a hold set through PUT /standing or a suspension (`applied: false`); one of those replaces it, so set it again once that is lifted. Its owners and admins are notified when the state changes.",
      request: { params: OrgParams, body: body(z.object({ hold: BillingHold.nullable() })) },
      responses: { 200: json(BillingHoldResult), ...errors },
    }),
    async (c) => {
      const done = await setBillingHold({ db, pubsub, hub }, c.req.valid("param").orgId, c.req.valid("json").hold);
      if (!done) return apiError(c, 404, "not_found", "No workspace with this id");
      return c.json({ applied: done.applied, standing: standingJson(done.standing) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/orgs/{orgId}/limits",
      tags,
      summary: "Set a workspace's limits",
      description:
        "All at once. Enforced where each is used: joining and inviting (`org.members_full`), every file written to this server's storage (`storage.full`, `storage.daily_full`), the platform's AI (within a minute), each paid connector call (`connector.capped`). Lowering one takes nothing away: people stay, files stay, only what is new is refused. Allowed whatever the workspace's standing. Setting what is already set changes nothing, `updatedAt` included.",
      request: { params: OrgParams, body: body(Limits) },
      responses: { 200: json(LimitsState), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const before = await getOrgLimits(db, orgId);
      const limits = await setOrgLimits(db, orgId, c.req.valid("json"));
      if (!limits) return apiError(c, 404, "not_found", "No workspace with this id");
      // A new plan shows in the apps within seconds. The billing service sets the same limits on every pass, which
      // leaves `updatedAt` as it was: only a change is news.
      if (limits.updatedAt?.getTime() !== before.updatedAt?.getTime()) {
        await publishOrgEvent(pubsub, { type: "org.broadcast", orgId, event: { type: "org.limits", orgId } });
      }
      return c.json(limitsJson(limits), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/storage",
      tags,
      summary: "The bytes of files the whole instance keeps on this server's storage",
      description:
        "A workspace's `meters.storageBytes` (`GET /orgs/{orgId}`), summed over every workspace whose new files go to this server's storage: each version kept of the Drive's files, the skills' stored files, the voice recordings still kept and live files' pictures and documents, by the size each recorded when it was written. Left out: files in the trash, and a workspace that keeps its files in a bucket of its own, with whatever it still has on this server. Every file's row is read to answer it, and a read that runs too long ends in an error.",
      responses: { 200: json(StorageTotal), 401: errors[401] },
    }),
    async (c) => c.json(await instanceStoredBytes(db), 200),
  );
}
