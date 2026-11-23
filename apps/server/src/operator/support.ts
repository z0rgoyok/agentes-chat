import {
  operatorRecordSupportRequest,
  operatorSupportRequests,
  SUPPORT_ABOUT_KINDS,
  SUPPORT_OPERATOR_SOURCES,
  SUPPORT_REF_MAX,
  SUPPORT_REQUEST_KEEP_DAYS,
  SUPPORT_SOURCES,
  SUPPORT_TEXT_MAX,
  SUPPORT_WORDS_KEEP_DAYS,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { body, json, OrgParams } from "../routes/app/context";
import type { OperatorDeps } from "./app";
import { Next, paging, word } from "./lookups";
import { Time } from "./runs";

const tags = ["Operator"];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong token"),
  404: errorResponse("Not found"),
};

const SupportRequest = z
  .object({
    id: z.uuid(),
    userId: z.string().openapi({ description: "The account that asked." }),
    source: z.enum(SUPPORT_SOURCES).nullable().openapi({
      description:
        "How it arrived: `form` (the apps' feedback form), `offer` (a report an agent offered, which the person read and sent), `email` or `operator` (recorded by the operator through this API).",
    }),
    aboutKind: z.enum(SUPPORT_ABOUT_KINDS).nullable().openapi({
      description:
        "What kind of thing was reported, from the form's own list; `other` for anything else it named, null when it named nothing or the request came another way.",
    }),
    messageId: z.uuid().nullable().openapi({
      description: "The reported message, when the form named one and it is a message of this workspace.",
    }),
    hasWords: z.boolean().openapi({
      description: `Whether what the member wrote is kept: only on a server with \`OPERATOR_API_REVEAL_TOKEN\`, for ${SUPPORT_WORDS_KEEP_DAYS} days. The words themselves are never in this answer.`,
    }),
    createdAt: Time,
  })
  .openapi("OperatorSupportRequest");

const SupportRequestPage = z
  .object({ requests: z.array(SupportRequest), next: Next })
  .openapi("OperatorSupportRequestPage");

const NewSupportRequest = z.object({
  userId: word().openapi({ description: "The member who asked." }),
  source: z.enum(SUPPORT_OPERATOR_SOURCES).openapi({
    description: "`email`: they wrote from the address of their account. `operator`: recorded by hand.",
  }),
  ref: word()
    .max(SUPPORT_REF_MAX)
    .openapi({ description: "Your own id for it (a mail's id, a record's): sent again, it is the same request." }),
  text: z
    .string()
    .max(SUPPORT_TEXT_MAX)
    .refine((v) => !v.includes("\0"), "Invalid character")
    .optional()
    .openapi({
      description: "What they wrote. Kept only on a server with `OPERATOR_API_REVEAL_TOKEN`; dropped otherwise.",
    }),
});

export function registerOperatorSupport(api: OpenAPIHono, { db, config }: OperatorDeps) {
  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/support-requests",
      tags,
      summary: "The times a workspace's members asked whoever runs the server for help, newest first",
      description: `Who asked, how it arrived, when, what kind of thing they reported and which message: ids and listed words. Never what they wrote. A request is kept ${SUPPORT_REQUEST_KEEP_DAYS} days.`,
      request: { params: OrgParams, query: z.object(paging) },
      responses: { 200: json(SupportRequestPage), ...errors },
    }),
    async (c) => {
      const page = await operatorSupportRequests(db, c.req.valid("param").orgId, c.req.valid("query"));
      if (!page) return apiError(c, 404, "not_found", "No workspace with this id");
      const requests = page.requests.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
      return c.json({ requests, next: page.next }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/support-requests",
      tags,
      summary: "Record that a member asked for help another way",
      description:
        "For a request that reached the operator outside the app (a mail from the address of their account, a call). The account must be a member of the workspace the app would let in now, else 404. The same `source` and `ref` again answer the request first recorded and write nothing.",
      request: { params: OrgParams, body: body(NewSupportRequest) },
      responses: { 200: json(SupportRequest), ...errors },
    }),
    async (c) => {
      const recorded = await operatorRecordSupportRequest(
        db,
        c.req.valid("param").orgId,
        c.req.valid("json"),
        Boolean(config.OPERATOR_API_REVEAL_TOKEN),
      );
      if (!recorded) return apiError(c, 404, "not_found", "No such member in this workspace");
      return c.json({ ...recorded, createdAt: recorded.createdAt.toISOString() }, 200);
    },
  );
}
