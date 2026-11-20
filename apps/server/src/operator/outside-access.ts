import {
  endOutsideAccess,
  JOIN_NOTE_MAX,
  listOutsideAccess,
  OUTSIDE_OF_MAX,
  requestOutsideAccess,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { body, json, OrgParams } from "../routes/app/context";
import type { OperatorDeps } from "./app";
import { UserParams } from "./standing";

const tags = ["Operator"];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong token"),
  404: errorResponse("Not found"),
};
const refused = { 409: errorResponse("Refused as the workspace stands") };

const OUTSIDE_OF = "Who the person works for, shown beside their name in the workspace.";

const OutsideAccessState = z.enum(["pending", "member"]).openapi("OperatorOutsideAccessState", {
  description:
    "`pending`: a request waits for someone in the workspace who may invite people to approve or deny it. `member`: they are in, as an outside collaborator.",
});

const OutsideAccessInput = z.object({
  userId: z.string().min(1).max(200).openapi({ description: "The account to let in. It must exist." }),
  outsideOf: z.string().trim().min(1).max(OUTSIDE_OF_MAX).openapi({ description: OUTSIDE_OF }),
  note: z.string().trim().max(JOIN_NOTE_MAX).optional().openapi({
    description: "Shown with the request to the people who answer it, in the app only.",
  }),
});

const OutsidePeople = z
  .object({
    people: z.array(
      z.object({
        userId: z.string(),
        outsideOf: z.string().openapi({ description: OUTSIDE_OF }),
        state: OutsideAccessState,
        since: z.string().openapi({ description: "When the request was filed (`pending`) or they got in (`member`)." }),
      }),
    ),
  })
  .openapi("OperatorOutsidePeople");

const OutsideParams = OrgParams.extend(UserParams.shape);

/**
 * Outside collaborators (ADR 0191): people working for a workspace from outside it, who never count toward its limit
 * of people. Only this API asks for one; the workspace answers the request and removes them like anyone.
 */
export function registerOperatorOutsideAccess(api: OpenAPIHono, { db, pubsub, config }: OperatorDeps) {
  api.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/outside-access",
      tags,
      summary: "Ask a workspace to let an account in as an outside collaborator",
      description:
        "Files a request to join that whoever may invite people in the workspace approves or denies like any other, told the same way. Approved, the account joins at once and never counts toward the `members` limit, even in a full workspace. Asking again while the request waits changes nothing. 409 `join.member` when the account is already in the workspace, `join.waiting` while another request to join waits for its address, `join.full` while 50 outside requests already wait in the workspace (counted apart from the asks through its invitation links), `outside_access.account_closed` when the account is blocked or waiting for its deletion (one that becomes so while its request waits has the request closed when someone approves it, with `outside_access.ended`). The events feed tells the answer: `outside_access.granted` or `outside_access.denied`, and `outside_access.ended` when they leave or are removed, or when the request is over unanswered (run out, told by a daily sweep, or gone with the account), each with `data.userId`.",
      request: { params: OrgParams, body: body(OutsideAccessInput) },
      responses: { 200: json(z.object({ state: OutsideAccessState })), ...errors, ...refused },
    }),
    async (c) => {
      await requestOutsideAccess(
        { db, pubsub, publicUrl: config.PUBLIC_URL },
        { orgId: c.req.valid("param").orgId, ...c.req.valid("json") },
      );
      return c.json({ state: "pending" as const }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/outside-access",
      tags,
      summary: "A workspace's outside collaborators, waiting and in",
      description: "The requests still waiting for an answer, then the people in, each oldest first.",
      request: { params: OrgParams },
      responses: { 200: json(OutsidePeople), ...errors },
    }),
    async (c) => {
      const people = await listOutsideAccess(db, c.req.valid("param").orgId);
      if (!people) return apiError(c, 404, "not_found", "No workspace with this id");
      return c.json({ people: people.map((p) => ({ ...p, since: p.since.toISOString() })) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/outside-access/{userId}",
      tags,
      summary: "End an account's outside access to a workspace",
      description:
        "Closes its request still waiting, or removes the outside collaborator as anyone removed from a workspace is. With neither, nothing changes. 409 `outside_access.member` for an ordinary member, before anything changes: only someone in the workspace removes one.",
      request: { params: OutsideParams },
      responses: { 200: json(z.object({ state: z.literal("none") })), ...errors, ...refused },
    }),
    async (c) => {
      const { orgId, userId } = c.req.valid("param");
      await endOutsideAccess({ db, pubsub }, orgId, userId);
      return c.json({ state: "none" as const }, 200);
    },
  );
}
