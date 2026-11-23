import { referralsLinkSecret } from "@agenteschat/config";
import { mintReferralsLink } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../../http/errors";
import { type AppDeps, body, createAppRouter, errors, json, requireSession, security } from "./context";

/** Links minted per person an hour: each opens the referral service once, on a click. */
const LINKS_PER_HOUR = { limit: 30, windowMs: 3600_000 };

/**
 * The person's way to the referral service (ADR 0192): this server knows nothing of the program, only a link that
 * opens the service signed in as them.
 */
export function referralRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const app = createAppRouter(deps);
  app.use("/referrals-link", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "post",
      path: "/referrals-link",
      tags: ["Referrals"],
      security,
      summary: "A signed link to the referral service",
      description:
        "Opens the referral service signed in as you, for 5 minutes and once. Any signed-in person, with or without a workspace. 404 `referrals.off` when this server has no referral service.",
      request: {
        body: body(
          z.object({
            returnTo: z.string().max(500).optional().openapi({
              description:
                "The page it was opened from (`/` or a workspace's path, `/org/{orgId}/…`): the referral service sends the person back there, its search and hash dropped. Anything else counts as `/`.",
            }),
          }),
        ),
      },
      responses: {
        200: json(z.object({ url: z.string(), expiresAt: z.string() })),
        429: errorResponse("Too many links (`rate_limited`)"),
        ...errors,
      },
    }),
    async (c) => {
      const secret = referralsLinkSecret(config);
      if (!config.REFERRALS_URL || !secret)
        return apiError(c, 404, "referrals.off", "This server has no referral service");
      const userId = c.get("user").id;
      if (!(await deps.adapters.rateLimiter.consume(`referrals-link:${userId}`, LINKS_PER_HOUR)).allowed)
        return apiError(c, 429, "rate_limited", "Too many links. Try again later.");
      const link = await mintReferralsLink(db, {
        secret,
        baseUrl: config.REFERRALS_URL,
        userId,
        returnTo: c.req.valid("json").returnTo,
      });
      return c.json({ url: link.url, expiresAt: link.expiresAt.toISOString() }, 200);
    },
  );

  return app;
}
