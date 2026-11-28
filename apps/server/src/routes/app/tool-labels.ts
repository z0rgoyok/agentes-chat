import { getMembership, TOOL_LABEL_KEY, TOOL_LABELS_MAX, toolLabelWords } from "@agenteschat/engine";
import { LOCALE_CODES } from "@agenteschat/i18n/locale";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../../http/errors";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

/** Asks one person's apps may make: a few per conversation opened, never a script's worth of model calls. */
export const TOOL_LABEL_ASKS_PER_PERSON = { limit: 30, windowMs: 60_000 };

/**
 * Connector tools' names in the reader's language, for the work lines of a conversation ("Consultou o Stripe · Listar
 * contas disponíveis"). The app asks only for names its own catalog has no words for, and shows their English words
 * until the answer comes.
 */
export function toolLabelRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/tool-labels",
      tags: ["Chat"],
      security,
      summary: "Connector tools' names in a language, written once by the workspace's cheap model and kept",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            locale: z.enum(LOCALE_CODES),
            keys: z
              .array(z.string().max(100).regex(TOOL_LABEL_KEY))
              .min(1)
              .max(TOOL_LABELS_MAX)
              .openapi({ description: "Tool names as the app's catalog keys them (`list_available_accounts`)." }),
          }),
        ),
      },
      responses: {
        200: json(
          z.object({
            labels: z
              .record(z.string(), z.string())
              .openapi({ description: "The words by key; a key left out keeps its English words." }),
          }),
        ),
        ...errors,
        429: errorResponse("Too many requests"),
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { locale, keys } = c.req.valid("json");
      const user = c.get("user");
      if (!(await getMembership(deps.db, user.id, orgId))) {
        return apiError(c, 403, "forbidden", "You are not a member of this organization");
      }
      const context = deps.extras?.context;
      if (!context) return c.json({ labels: {} }, 200);
      if (!(await deps.adapters.rateLimiter.consume(`tool-labels:${user.id}`, TOOL_LABEL_ASKS_PER_PERSON)).allowed) {
        return apiError(c, 429, "rate_limited", "Slow down");
      }
      return c.json({ labels: await toolLabelWords(context, orgId, locale, keys) }, 200);
    },
  );

  return app;
}
