import { retryInSeconds } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import {
  ARTIFACT_LIMITS,
  activeLink,
  attachmentDisposition,
  claimLink,
  deliveryFile,
  listSurfaceDeliveries,
  MAX_MESSAGE_ATTACHMENTS,
  MAX_MESSAGE_LENGTH,
  postFromSurface,
  SURFACE_PREFIX,
  safeEqual,
  sha256,
  TooManyError,
  takeDeliveries,
  takeSurfaceCap,
  unlinkExternal,
} from "@agenteschat/engine";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { apiError, domainErrorResponse, errorResponse, routeOf, validationHook } from "../http/errors";
import { type AppDeps, json } from "../routes/app/context";

/** Whom a bridge call touched, filled by its route as it learns it; written to `surface_calls` after the answer. */
export interface SurfaceAudit {
  linkId?: string;
  userId?: string;
  orgId?: string;
  externalId?: string;
}

export type SurfaceEnv = { Variables: { audit: SurfaceAudit } };

const tags = ["Surface"];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong bridge token"),
};

const CLAIMS_PER_SENDER = { limit: 5, windowMs: 3_600_000 };

const ExternalId = z.string().min(1).max(128).openapi({
  description:
    "The surface's stable, opaque id for the sender. Never a phone number or any address that can change hands.",
});

const Claim = z
  .object({
    externalId: ExternalId,
    display: z
      .string()
      .max(64)
      .nullable()
      .openapi({ description: "What the surface shows of the sender (a number, a handle). Shown only." }),
    profileName: z.string().max(64).nullable().openapi({ description: "The sender's own name there. Untrusted." }),
    code: z.string().min(1).max(32).openapi({ description: "As typed: case, spaces and dashes don't matter." }),
  })
  .strict()
  .openapi("SurfaceClaim");

const Claimed = z
  .object({
    status: z.literal("pending"),
    linkId: z.uuid(),
    expiresAt: z.string().openapi({ description: "The person confirms in the app before this." }),
    locale: z.string().openapi({ description: "The account's app language, for the service's own words." }),
  })
  .openapi("SurfaceClaimed");

const Unlink = z
  .object({ externalId: ExternalId, reason: z.enum(["asked", "identity_changed"]) })
  .strict()
  .openapi("SurfaceUnlink");

/** The whole multipart body of `POST /messages`. */
const MESSAGE_MAX_BYTES = 100 * 1024 * 1024;

const Binary = z.any().openapi({ type: "string", format: "binary" });
const Post = z
  .object({
    externalId: ExternalId,
    inboundId: z.string().min(1).max(256).openapi({
      description: "The surface's own message id (for grouped media, the first one's): a resend posts nothing new.",
    }),
    text: z.string().max(MAX_MESSAGE_LENGTH).optional(),
    forwarded: z
      .literal("true")
      .optional()
      .openapi({ description: "Forwarded from another chat: the agent reads it as quoted text, not a request." }),
    replyTo: z
      .uuid()
      .optional()
      .openapi({ description: "One of our message ids the sender quoted; ignored outside the DM." }),
    files: z
      .any()
      .optional()
      .openapi({
        type: "array",
        items: { type: "string", format: "binary" },
        description: `Repeated, at most ${MAX_MESSAGE_ATTACHMENTS}, each with a file name and at most 50 MB.`,
      }),
    voice: Binary.optional().openapi({ description: "One voice note, never with `files`." }),
    voiceDurationMs: z.coerce.number().int().positive().optional().openapi({ description: "Required with `voice`." }),
  })
  .strict()
  .openapi("SurfaceMessage");

const Posted = z
  .object({
    status: z.enum(["posted", "duplicate", "queued"]).openapi({
      description: "`queued`: a voice note, posted when its words are ready.",
    }),
    messageId: z.uuid().nullable(),
    voiceAsFile: z.boolean().openapi({ description: "The voice note went in as a file." }),
    orgId: z.uuid(),
    orgName: z.string(),
    locale: z.string(),
  })
  .openapi("SurfacePosted");

const Ids = z.array(z.uuid()).max(100);
const Taken = z
  .object({
    sent: Ids.openapi({ description: "Sent on the surface: the person's DM reads as read up to each reply." }),
    unsent: Ids.openapi({ description: "Couldn't be sent: the person is notified in the app instead." }),
  })
  .strict()
  .refine((t) => t.sent.length + t.unsent.length > 0, "Send at least one id")
  .refine((t) => !t.sent.some((id) => t.unsent.includes(id)), "An id is either sent or unsent")
  .openapi("SurfaceTaken");

const Delivery = z
  .object({
    id: z.uuid(),
    kind: z
      .enum(["reply", "linked"])
      .openapi({ description: "`linked`: say in your own words that the link is active." }),
    linkId: z.uuid(),
    externalId: z.string(),
    orgId: z.uuid(),
    orgName: z.string(),
    locale: z.string().openapi({ description: "The account's app language, for the service's own words." }),
    createdAt: z.string(),
    messageId: z.uuid().nullable().openapi({ description: "The right hand's message; null for `linked`." }),
    inReplyTo: z.uuid().nullable().openapi({ description: "The person's surface message the run read last." }),
    text: z.string().openapi({ description: "The message's Markdown as stored." }),
    files: z.array(
      z.object({ id: z.uuid(), name: z.string(), contentType: z.string(), size: z.number().int() }).openapi({
        description: "Read the bytes from `GET /files/{artifactId}?delivery={id}`.",
      }),
    ),
    media: z
      .union([
        z.object({ kind: z.literal("gif"), id: z.string(), title: z.string() }),
        z.object({ kind: z.literal("sticker"), mood: z.string() }),
      ])
      .nullable(),
    card: z
      .object({
        kind: z.enum(["question", "approval", "secret", "block", "poll", "choices", "artifact"]),
        url: z.string().openapi({ description: "Where the card opens in the app." }),
      })
      .nullable(),
    choices: z.array(z.string()).nullable().openapi({ description: "A question's choices, to list in words." }),
  })
  .openapi("SurfaceDelivery");

const Health = z
  .object({
    ok: z.literal(true),
    surface: z.string().openapi({ description: "This server's `SURFACE_NAME`." }),
    version: z.string(),
  })
  .openapi("SurfaceHealth");

/** The error code of an answer, read from its JSON body; null for a success or a body that isn't one of ours. */
async function errorCode(res: Response): Promise<string | null> {
  if (res.status < 400) return null;
  try {
    const body = (await res.clone().json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

/**
 * The bridge for an outside chat surface (ADR 0187): what a separate service calls to carry linked people's
 * messages to and from their DM with the right hand, behind its own bearer token. Served only by the operator
 * listener (`operatorFetch`), never by `createApp`.
 */
export function createSurfaceApp(deps: AppDeps, token: string, version: string) {
  const api = new OpenAPIHono<SurfaceEnv>({ defaultHook: validationHook() });
  api.openAPIRegistry.registerComponent("securitySchemes", "surface", {
    type: "http",
    scheme: "bearer",
    description:
      "This server's `SURFACE_BRIDGE_TOKEN`. It opens only these routes; the operator API's tokens are refused here.",
  });
  // First, so refused and unknown calls are recorded too. After the answer, errors included; never the body.
  api.use("*", async (c, next) => {
    const audit: SurfaceAudit = {};
    c.set("audit", audit);
    try {
      await next();
    } finally {
      const status = c.res?.status ?? 500;
      try {
        await deps.db.insert(schema.surfaceCalls).values({
          method: c.req.method,
          route: routeOf(c),
          status,
          code: c.res ? await errorCode(c.res) : null,
          linkId: audit.linkId ?? null,
          userId: audit.userId ?? null,
          orgId: audit.orgId ?? null,
          externalHash: audit.externalId ? sha256(audit.externalId).slice(0, 16) : null,
        });
      } catch (error) {
        deps.log?.warn("surface call not recorded", { error, route: routeOf(c), status });
      }
    }
  });
  // Every path under the prefix, unknown ones and the document included, so nothing answers without it.
  api.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!safeEqual(given, token)) return apiError(c, 401, "unauthorized", "Missing or wrong bridge token");
    await next();
  });

  api.openapi(
    createRoute({
      method: "get",
      path: "/health",
      tags,
      summary: "Whether the bridge answers, and for which surface",
      responses: { 200: json(Health), 401: errors[401] },
    }),
    (c) => c.json({ ok: true as const, surface: deps.config.SURFACE_NAME ?? "", version }, 200),
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/links/claim",
      tags,
      summary: "A link code typed on the surface: a pending link the person confirms in the app",
      description:
        "Never makes a link active. Wrong, used and expired codes all answer `surface.code_gone`; each try counts against the sender's 5 an hour.",
      request: { body: { required: true, content: { "application/json": { schema: Claim } } } },
      responses: {
        201: json(Claimed),
        ...errors,
        404: errorResponse("Wrong, used or expired code (`surface.code_gone`)"),
        409: errorResponse("The sender is linked to another account (`surface.taken`)"),
        429: errorResponse("`surface.claim_limit` (this sender) or `surface.busy` (all senders), with `retryIn`"),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const audit = c.get("audit");
      audit.externalId = input.externalId;
      // The sender's own limit first, so one sender's refused tries never spend the cap shared by everyone.
      const tries = await deps.adapters.rateLimiter.consume(
        `surface:claim:${sha256(input.externalId)}`,
        CLAIMS_PER_SENDER,
      );
      if (!tries.allowed) {
        throw new TooManyError("Too many codes from this sender", "surface.claim_limit", {
          retryIn: retryInSeconds(tries.resetAt),
        });
      }
      await takeSurfaceCap({ db: deps.db, rateLimiter: deps.adapters.rateLimiter, warn: deps.log?.warn }, "claims");
      const { link, expiresAt, locale } = await claimLink({ db: deps.db, pubsub: deps.adapters.pubsub }, input);
      Object.assign(audit, { linkId: link.id, userId: link.userId, orgId: link.orgId ?? undefined });
      return c.json({ status: "pending" as const, linkId: link.id, expiresAt: expiresAt.toISOString(), locale }, 201);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/links/unlink",
      tags,
      summary: "End a sender's link: they asked, or their identity on the surface changed",
      description: "Pending links of the sender go too. A second call answers `none`.",
      request: { body: { required: true, content: { "application/json": { schema: Unlink } } } },
      responses: {
        200: json(z.object({ status: z.enum(["unlinked", "none"]) }).openapi("SurfaceUnlinked")),
        ...errors,
      },
    }),
    async (c) => {
      const { externalId, reason } = c.req.valid("json");
      const audit = c.get("audit");
      audit.externalId = externalId;
      const link = await activeLink(deps.db, externalId);
      if (link) Object.assign(audit, { linkId: link.id, userId: link.userId, orgId: link.orgId ?? undefined });
      const status = await unlinkExternal(
        {
          db: deps.db,
          pubsub: deps.adapters.pubsub,
          publicUrl: deps.adapters.email.delivers === true ? deps.config.PUBLIC_URL : null,
        },
        externalId,
        reason,
      );
      deps.wakeWorkers?.();
      return c.json({ status }, 200);
    },
  );

  api.use(
    "/messages",
    bodyLimit({
      maxSize: MESSAGE_MAX_BYTES,
      onError: (c) => apiError(c, 413, "surface.too_large", "The message is over 100 MiB"),
    }),
  );
  api.openapi(
    createRoute({
      method: "post",
      path: "/messages",
      tags,
      summary: "A linked sender's message, posted as them in their DM with the workspace's right hand",
      description:
        "At least one of `text`, `files`, `voice`. A voice note that isn't one core takes (type, size, bytes over 8 KB a second of its length, voice off) goes in as a file named `voice.<ext>`. The DM is marked read up to the message.",
      request: { body: { required: true, content: { "multipart/form-data": { schema: Post } } } },
      responses: {
        201: json(Posted),
        ...errors,
        404: errorResponse("No active link for this sender (`surface.unlinked`)"),
        409: errorResponse("`surface.no_workspace` or `surface.no_assistant`"),
        413: errorResponse("Over 100 MiB, or a file over 50 MB (`surface.too_large`)"),
        429: errorResponse("`surface.rate_limited` (this person, with `retryIn` and `window`) or `surface.busy`"),
      },
    }),
    async (c) => {
      const form = c.req.valid("form");
      const audit = c.get("audit");
      audit.externalId = form.externalId;
      const files: unknown[] = [form.files ?? []].flat();
      const voice: unknown = form.voice;
      const bad = (message: string) => apiError(c, 400, "invalid_request", message);
      if (!files.every((f): f is File => f instanceof File) || (voice !== undefined && !(voice instanceof File))) {
        return bad("files and voice are file parts");
      }
      if (files.length > MAX_MESSAGE_ATTACHMENTS) return bad(`At most ${MAX_MESSAGE_ATTACHMENTS} files`);
      if (voice && files.length > 0) return bad("A voice note goes alone, without files");
      if (voice && form.voiceDurationMs === undefined) return bad("voiceDurationMs is required with voice");
      if (!form.text && files.length === 0 && !voice) return bad("Send text, files or a voice note");
      if (files.some((f) => f.size > ARTIFACT_LIMITS.fileBytes)) {
        return apiError(c, 413, "surface.too_large", "A file is over 50 MB");
      }
      const link = await activeLink(deps.db, form.externalId);
      if (link) Object.assign(audit, { linkId: link.id, userId: link.userId, orgId: link.orgId ?? undefined });
      const artifacts = deps.extras?.artifacts;
      if (!artifacts) throw new Error("file storage is not configured");
      const posted = await postFromSurface(
        {
          db: deps.db,
          pubsub: deps.adapters.pubsub,
          judge: deps.extras?.context?.judge,
          talker: deps.extras?.talker,
          gifs: deps.adapters.gifs,
          artifacts,
          voice: deps.extras?.voice ?? null,
          rateLimiter: deps.adapters.rateLimiter,
          warn: deps.log?.warn,
        },
        {
          externalId: form.externalId,
          inboundId: form.inboundId,
          text: form.text ?? null,
          forwarded: form.forwarded === "true",
          replyTo: form.replyTo ?? null,
          files: await Promise.all(
            files.map(async (f) => ({ name: f.name, type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) })),
          ),
          voice:
            voice instanceof File
              ? {
                  type: voice.type,
                  bytes: new Uint8Array(await voice.arrayBuffer()),
                  durationMs: form.voiceDurationMs ?? 0,
                }
              : null,
        },
      );
      deps.wakeWorkers?.();
      return c.json(posted, 201);
    },
  );

  const deliveryDeps = () => ({ db: deps.db, pubsub: deps.adapters.pubsub, artifacts: deps.extras?.artifacts });

  api.openapi(
    createRoute({
      method: "get",
      path: "/deliveries",
      tags,
      summary: "What to send now: replies of the right hand to linked people, and links just made",
      description:
        "Oldest first, only rows not yet taken and younger than 5 minutes: anything older already reached the person in the app. Close each with `POST /deliveries/taken`.",
      request: { query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }) },
      responses: { 200: json(z.object({ deliveries: z.array(Delivery) }).openapi("SurfaceDeliveries")), ...errors },
    }),
    async (c) => {
      const { limit } = c.req.valid("query");
      return c.json({ deliveries: await listSurfaceDeliveries(deliveryDeps(), limit) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/deliveries/taken",
      tags,
      summary: "Close listed deliveries: sent on the surface, or not",
      description:
        "Idempotent: ids closed before (by an earlier call, or by the fall back to the app after 5 minutes) come back in `late` and change nothing.",
      request: { body: { required: true, content: { "application/json": { schema: Taken } } } },
      responses: {
        200: json(
          z
            .object({ sent: z.number().int(), unsent: z.number().int(), late: z.array(z.uuid()) })
            .openapi("SurfaceTakenAnswer"),
        ),
        ...errors,
      },
    }),
    async (c) => c.json(await takeDeliveries(deliveryDeps(), c.req.valid("json")), 200),
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/files/{artifactId}",
      tags,
      summary: "The bytes of one file of a delivery's reply",
      request: { params: z.object({ artifactId: z.uuid() }), query: z.object({ delivery: z.uuid() }) },
      responses: {
        200: {
          description: "The file, as an attachment",
          content: { "application/octet-stream": { schema: Binary } },
        },
        ...errors,
        404: errorResponse("Unknown delivery, a file not on its message, or bytes gone (`surface.file_gone`)"),
      },
    }),
    async (c) => {
      const { artifactId } = c.req.valid("param");
      const { delivery } = c.req.valid("query");
      const file = await deliveryFile(deliveryDeps(), delivery, artifactId);
      Object.assign(c.get("audit"), {
        linkId: file.audit.linkId ?? undefined,
        userId: file.audit.userId,
        orgId: file.audit.orgId,
      });
      return new Response(file.body, {
        status: 200,
        headers: {
          "content-type": file.contentType,
          "content-length": String(file.size),
          "content-disposition": attachmentDisposition(file.name),
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store, no-transform",
        },
      });
    },
  );

  api.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "agentes.chat chat surface bridge",
      version,
      description:
        "For the separate service that carries linked people's messages between an outside chat surface and their DM with the workspace's right hand (ADR 0187). Every call is recorded (route, answer, whom it touched; never content).",
    },
    servers: [{ url: SURFACE_PREFIX }],
    security: [{ surface: [] }],
  });

  const app = new OpenAPIHono();
  app.onError((error, c) => {
    const mapped = domainErrorResponse(error, c);
    if (mapped) return mapped;
    deps.log?.error("unhandled error", {
      method: c.req.method,
      path: c.req.path,
      route: routeOf(c),
      status: 500,
      error,
      stack: error.stack,
    });
    return apiError(c, 500, "internal_error", "Something went wrong on our side");
  });
  app.route(SURFACE_PREFIX, api);
  app.notFound((c) => apiError(c, 404, "not_found", "Route not found"));
  return app;
}
