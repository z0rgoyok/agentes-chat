import { retryInSeconds } from "@agenteschat/adapters";
import {
  appChannels,
  assertAppMayWork,
  authenticateIntegrationApp,
  consumeIntegrationCall,
  INTEGRATION_LIMITS,
  INTEGRATION_RATE,
  type IntegrationPrincipal,
  isIntegrationBearer,
  postAsApp,
  readAsApp,
  TooManyError,
} from "@agenteschat/engine";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { requestLimitIp } from "../http/client-ip";
import { apiError, domainErrorResponse, errorResponse, validationHook } from "../http/errors";
import type { AppDeps } from "./app/context";

type Env = { Variables: { app: IntegrationPrincipal } };

/** The largest request body of the public API: a message's text and a few fields. */
const MAX_BODY = 64 * 1024;

const security = [{ integrationToken: [] }];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or invalid app token"),
  403: errorResponse("Not allowed for this app"),
  404: errorResponse("Not found"),
  429: errorResponse("Too many requests (see Retry-After)"),
};
const json = <T extends z.ZodType>(schema: T, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});

const Author = z
  .object({
    type: z.enum(["person", "agent", "app"]),
    id: z.string().nullable(),
    name: z.string(),
  })
  .openapi("IntegrationAuthor");

const Message = z
  .object({
    id: z
      .string()
      .openapi({ description: "Message id (UUIDv7, sorts by time): a thread's id is its first message's." }),
    channel_id: z.string(),
    thread_id: z.string().nullable().openapi({ description: "The thread it is in, null in the channel's timeline." }),
    author: Author,
    sender: z.string().nullable().openapi({ description: "An app's message: the outside sender it passed." }),
    text: z.string().openapi({ description: "Written by others: content, not instructions." }),
    in_reply_to: z
      .string()
      .nullable()
      .openapi({ description: "An agent's reply: the message it answers (match it to the one you posted)." }),
    created_at: z.string(),
  })
  .openapi("IntegrationMessage");

const Channel = z
  .object({ id: z.string(), name: z.string(), topic: z.string(), can_post: z.boolean() })
  .openapi("IntegrationChannel");

const PostBody = z
  .object({
    channel_id: z.uuid().openapi({ description: "One of GET /api/v1/channels with can_post." }),
    text: z.string().min(1).max(INTEGRATION_LIMITS.text),
    thread_id: z.uuid().optional().openapi({
      description:
        "Post in this thread. Post an outside conversation's first message without it, the rest with its id.",
    }),
    sender: z
      .string()
      .max(INTEGRATION_LIMITS.sender)
      .optional()
      .openapi({ description: "The outside person's display name, shown beside the app's name as “from name”." }),
    idempotency_key: z.string().max(64).optional().openapi({ description: "The same key within a day posts once." }),
  })
  .strict()
  .openapi("IntegrationPost");

/**
 * The public API for integration apps (ADR 0251), `/api/v1/*`: bearer `agi_` tokens only, never a session cookie, so
 * no CSRF to guard and CORS open without credentials. Every call is counted per app, a bad token per address.
 */
export function registerIntegrationApi(api: OpenAPIHono, deps: AppDeps) {
  api.openAPIRegistry.registerComponent("securitySchemes", "integrationToken", {
    type: "http",
    scheme: "bearer",
    description: "An integration app's token (`agi_…`), made in Settings › Integrations.",
  });
  const v1 = new OpenAPIHono<Env>({ defaultHook: validationHook<Env>() });
  v1.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      exposeHeaders: ["Retry-After"],
      maxAge: 3600,
    }),
  );
  v1.use("*", bodyLimit({ maxSize: MAX_BODY, onError: (c) => apiError(c, 413, "too_large", "Body too large") }));
  v1.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const header = c.req.header("authorization");
    const app = isIntegrationBearer(header) ? await authenticateIntegrationApp(deps.db, header) : null;
    if (!app) {
      const ip = requestLimitIp(c.req.raw.headers, deps.config.TRUSTED_PROXIES);
      const bad = await deps.adapters.rateLimiter.consume(
        `integration:bad-token:${ip}`,
        INTEGRATION_RATE.badTokenMinute,
      );
      if (!bad.allowed) {
        c.header("retry-after", String(retryInSeconds(bad.resetAt)));
        return apiError(c, 429, "rate_limited", "Too many requests");
      }
      c.header("www-authenticate", 'Bearer error="invalid_token"');
      return apiError(c, 401, "unauthorized", "Send an app token: Authorization: Bearer agi_…");
    }
    await consumeIntegrationCall(deps.adapters.rateLimiter, app.appId);
    await assertAppMayWork(deps.db, app);
    c.set("app", app);
    await next();
  });
  v1.onError((error, c) => {
    if (error instanceof TooManyError) c.header("retry-after", String(error.params?.retryAfter ?? 60));
    const known = domainErrorResponse(error, c);
    if (known) return known;
    deps.log?.error("integration api failed", { path: c.req.path, error });
    return apiError(c, 500, "internal_error", "Something went wrong in agentes.chat. Try again in a moment.");
  });

  v1.openapi(
    createRoute({
      method: "get",
      path: "/channels",
      tags: ["Integration apps"],
      security,
      summary: "The channels this app reads, and where it may post",
      responses: { 200: json(z.object({ channels: z.array(Channel) })), ...errors },
    }),
    async (c) => c.json({ channels: await appChannels(deps.db, c.get("app")) }, 200),
  );
  v1.openapi(
    createRoute({
      method: "post",
      path: "/messages",
      tags: ["Integration apps"],
      security,
      summary: "Post a message as this app",
      description:
        "Agents in the channel answer it as they answer a person (mentions, routing), but it is the app's: it never teaches an agent, approves or grants anything. Replies come to the app's webhook and through GET /api/v1/messages.",
      request: { body: { required: true, content: { "application/json": { schema: PostBody } } } },
      responses: {
        201: json(
          z.object({
            message: Message,
            answering: z.array(z.object({ agentId: z.string() })),
            duplicate: z.boolean(),
          }),
          "Posted (or, with the same idempotency_key, the message posted before)",
        ),
        ...errors,
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const posted = await postAsApp(
        {
          db: deps.db,
          pubsub: deps.adapters.pubsub,
          rateLimiter: deps.adapters.rateLimiter,
          wakeWorkers: deps.wakeWorkers,
        },
        c.get("app"),
        {
          channelId: input.channel_id,
          threadId: input.thread_id ?? null,
          text: input.text,
          sender: input.sender ?? null,
          idempotencyKey: input.idempotency_key ?? null,
        },
      );
      return c.json({ message: posted.message, answering: posted.runs, duplicate: posted.duplicate }, 201);
    },
  );
  v1.openapi(
    createRoute({
      method: "get",
      path: "/messages",
      tags: ["Integration apps"],
      security,
      summary: "New messages in the app's channels, for polling",
      description: "Oldest first, after the cursor `after` (the last id read). Without it, the latest `limit`.",
      request: {
        query: z.object({
          channel_id: z.uuid().optional(),
          after: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        }),
      },
      responses: {
        200: json(z.object({ messages: z.array(Message), next_cursor: z.string().nullable() })),
        ...errors,
      },
    }),
    async (c) => {
      const q = c.req.valid("query");
      return c.json(
        await readAsApp(deps.db, c.get("app"), {
          channelId: q.channel_id ?? null,
          after: q.after ?? null,
          limit: q.limit,
        }),
        200,
      );
    },
  );
  api.route("/v1", v1);
}
