import {
  can,
  createLiveImages,
  type ImageRequestView,
  type LiveImages,
  requireActiveMembership,
  requirePermission,
} from "@agenteschat/engine";
import { IMAGE_ASPECTS } from "@agenteschat/providers/images";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../../http/errors";
import { type AppDeps, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Live files"];

/** Try again on pictures one person may ask for in an hour (ADR 0197). */
export const IMAGE_REQUESTS_PER_PERSON = { limit: 30, windowMs: 3600_000 };

const ArtifactParams = OrgParams.extend({ artifactId: z.uuid() });
const Aspect = z.enum(IMAGE_ASPECTS as unknown as [string, ...string[]]);

const ImageModel = z
  .object({
    id: z.string(),
    label: z.string(),
    provider: z
      .string()
      .openapi({ description: "`gemini`, `openai`, `openrouter` or `custom` (the workspace's own)." }),
    aspects: z.array(Aspect),
    maxCount: z.number().int().openapi({ description: "Pictures one request may ask for." }),
    refs: z.boolean().openapi({ description: "It takes pictures to start from (variations, edits)." }),
    pricePerImage: z
      .number()
      .optional()
      .openapi({ description: "What a typical picture costs, in USD: only for people who may see usage." }),
  })
  .openapi("ImageModel");

const ImageRequest = z
  .object({
    requestId: z.uuid(),
    artifactId: z.uuid(),
    status: z.enum(["queued", "running", "done", "failed"]),
    shapeIds: z
      .array(z.string())
      .openapi({ description: "The placeholders on the canvas; the pictures take their ids." }),
    frameId: z.string().nullable().openapi({ description: "The frame they were placed in, named with the prompt." }),
    model: z.string(),
    prompt: z.string(),
    count: z.number().int(),
    aspect: Aspect,
    error: z
      .enum(["no_key", "budget", "limit", "blocked", "provider", "too_many"])
      .nullable()
      .openapi({ description: "Why pictures weren't made (the placeholders say it too, with Try again)." }),
    assetIds: z.array(z.string()).openapi({ description: "The pictures made, as the canvas's assets." }),
  })
  .openapi("ImageRequest");

/** A request as the apps get it: its cost stays with usage, for who may see it. */
const answerOf = (view: ImageRequestView) => {
  const { costNanoUsd: _cost, ...rest } = view;
  return rest;
};

/**
 * Images on canvases (ADR 0197): which image models the workspace can use, and Try again on a request that failed.
 * Pictures are asked for through an agent (`generate_image`, in the canvas's conversation or any other); the canvas
 * shows their placeholders and, when one fails, why, with Try again.
 */
export function imageRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  let made: LiveImages | null = null;
  const images = (): LiveImages => {
    const given = deps.extras?.images;
    if (given) return given;
    const artifacts = deps.extras?.artifacts;
    const live = deps.extras?.live;
    const gateway = deps.extras?.context?.gateway;
    if (!artifacts || !live || !gateway) throw new Error("images are not configured on this server");
    made ??= createLiveImages({ artifacts, live, gateway, wake: deps.wakeWorkers });
    return made;
  };
  const person = (userId: string) => ({ type: "person" as const, userId });
  /** A person who may add files, within their requests an hour; else the answer refusing them. */
  const allowed = async (userId: string, orgId: string) => {
    await requirePermission(db, userId, orgId, "upload_files");
    const limit = await deps.adapters.rateLimiter.consume(`images:${userId}`, IMAGE_REQUESTS_PER_PERSON);
    return limit.allowed;
  };
  const tooMany = "You asked for a lot of images in the last hour. Try again in a little while.";

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/images/models",
      tags,
      security,
      summary: "The image models this workspace can use now, its default first",
      description:
        "Models whose provider has a key here (the workspace's own or the server's). Empty: none, and agents aren't offered `generate_image`.",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ models: z.array(ImageModel) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const membership = await requireActiveMembership(db, c.get("user").id, orgId);
      const models = await images().models(orgId, { prices: can(membership, "view_usage") });
      return c.json({ models }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/artifacts/{artifactId}/images/{requestId}/retry",
      tags,
      security,
      summary: "Try again: a request's failed pictures are made again, now asked by you",
      description:
        "A request still being made, or one that made every picture, comes back as it is. Counts as a request (429 `images.rate`).",
      request: { params: ArtifactParams.extend({ requestId: z.uuid() }) },
      responses: {
        200: json(ImageRequest),
        429: errorResponse("Too many requests for pictures (`images.rate`)"),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, artifactId, requestId } = c.req.valid("param");
      const userId = c.get("user").id;
      if (!(await allowed(userId, orgId))) return apiError(c, 429, "images.rate", tooMany);
      const view = await images().retry(person(userId), orgId, artifactId, requestId);
      return c.json(answerOf(view), 200);
    },
  );

  return app;
}
