import { SCREEN_KINDS } from "@agenteschat/adapters";
import {
  cancelHandoff,
  claimHandoff,
  finishHandoff,
  getHandoff,
  type HandoffDeps,
  handoffViewFor,
  openHandoffOf,
  openPageInControl,
  PAGE_MOVES,
  requireBrowserAccess,
  requireBrowserControl,
  SHARED_SEAT,
  startTakeover,
  stopAgentBrowser,
  ValidationError,
  viewerSeat,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Agent browser"];

export const BrowserHandoff = z
  .object({
    id: z.uuid(),
    agentId: z.uuid(),
    runId: z.uuid().nullable(),
    machineId: z.uuid(),
    screen: z.enum(SCREEN_KINDS).openapi({ description: "Which of the agent's screens: one open handoff per screen." }),
    kind: z.enum(["ask", "takeover"]),
    instructions: z.string(),
    status: z.enum(["pending", "active", "done", "failed", "expired", "cancelled", "withdrawn"]),
    requestedForUserId: z.string().nullable(),
    controllerUserId: z.string().nullable(),
    seat: z.literal(SHARED_SEAT).optional().openapi({
      description: "On the workspace's built-in agent: the handoff is of its shared place, not of a person's own.",
    }),
    note: z.string().nullable(),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
    resolvedAt: z.string().nullable(),
  })
  .openapi("BrowserHandoff");

const HandoffParams = OrgParams.extend({ handoffId: z.uuid() });
const AgentParams = OrgParams.extend({ agentId: z.uuid() });

/** `?seat=shared`: on the right hand, its shared seat (ADR 0175) instead of the asker's own. */
export const SeatQuery = z.object({ seat: z.literal(SHARED_SEAT).optional() });
export const SEAT_NOTE =
  "`seat=shared`: on the workspace's built-in agent, its shared place on the workspace's computer instead of this person's own, for whoever may reach an agent's computer. It means nothing for any other agent.";

/** Where the person in control sends the page: an address they typed, or the address bar's arrows and reload. */
export const PageTarget = z.union([
  z.object({ url: z.string().min(1).max(2048) }),
  z.object({ go: z.enum(PAGE_MOVES) }),
]);
export const pageTarget = (b: z.infer<typeof PageTarget>) => ("go" in b ? { go: b.go } : b.url);

/**
 * A person's turn on one of an agent's screens (ADR 0040 §6). The agent asks
 * (`browser_ask_person`: a card, "Waiting for you", a push); the person
 * takes control on the live view, then presses Done or Couldn't and the
 * agent goes on. Someone watching can also take over and hand back. The
 * browser's live view itself is on `/api/ws` (`browser.watch`). A handoff's
 * own routes (`…/browser/handoffs/{handoffId}/…`) serve every screen.
 */
export function browserRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const handoffDeps: HandoffDeps = deps.extras?.browserLive?.handoffDeps ?? { db, pubsub: adapters.pubsub };
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/browser/handoffs/{handoffId}",
      tags,
      security,
      summary: "A person's turn in an agent's browser",
      request: { params: HandoffParams },
      responses: { 200: json(BrowserHandoff), ...errors },
    }),
    async (c) => {
      const { orgId, handoffId } = c.req.valid("param");
      return c.json(await getHandoff(db, c.get("user").id, orgId, handoffId), 200);
    },
  );

  for (const screen of SCREEN_KINDS) {
    app.openapi(
      createRoute({
        method: "get",
        path: `/organizations/{orgId}/agents/{agentId}/${screen}/handoff`,
        tags,
        security,
        summary: `The open handoff of an agent's ${screen} (who is in control), if any`,
        description: SEAT_NOTE,
        request: { params: AgentParams, query: SeatQuery },
        responses: { 200: json(z.object({ handoff: BrowserHandoff.nullable() })), ...errors },
      }),
      async (c) => {
        const { orgId, agentId } = c.req.valid("param");
        const userId = c.get("user").id;
        const shared = c.req.valid("query").seat === SHARED_SEAT;
        await requireBrowserAccess(db, userId, orgId, agentId, undefined, screen, shared);
        // Whoever asks: on the right hand each person reads only their own seat's, or the shared one's (ADR 0175).
        const open = await openHandoffOf(db, orgId, agentId, screen, viewerSeat({ userId, shared }));
        return c.json({ handoff: open ? await handoffViewFor(db, open) : null }, 200);
      },
    );

    app.openapi(
      createRoute({
        method: "get",
        path: `/organizations/{orgId}/agents/{agentId}/${screen}/control`,
        tags,
        security,
        summary: `Whether this person may drive the agent's ${screen} (take over, open, type); watching needs less`,
        description: SEAT_NOTE,
        request: { params: AgentParams, query: SeatQuery },
        responses: { 200: json(z.object({ canControl: z.boolean() })), ...errors },
      }),
      async (c) => {
        const { orgId, agentId } = c.req.valid("param");
        const userId = c.get("user").id;
        const shared = c.req.valid("query").seat === SHARED_SEAT;
        await requireBrowserAccess(db, userId, orgId, agentId, undefined, screen, shared);
        const canControl = await requireBrowserControl(db, userId, orgId, agentId, undefined, screen, shared).then(
          () => true,
          () => false,
        );
        return c.json({ canControl }, 200);
      },
    );

    app.openapi(
      createRoute({
        method: "post",
        path: `/organizations/{orgId}/agents/{agentId}/${screen}/takeover`,
        tags,
        security,
        summary: `Take over an agent's ${screen} while watching; it waits until handed back`,
        description:
          "`runId`: the agent's run whose card it was taken from; the take over is bound to it (its card stays in that conversation). `seat: \"shared\"`: on the workspace's built-in agent, its shared place instead of this person's own.",
        request: {
          params: AgentParams,
          body: body(z.object({ runId: z.uuid().optional(), seat: z.literal(SHARED_SEAT).optional() })),
        },
        responses: { 200: json(BrowserHandoff), ...errors },
      }),
      async (c) => {
        const { orgId, agentId } = c.req.valid("param");
        const { runId, seat } = c.req.valid("json");
        const userId = c.get("user").id;
        const shared = seat === SHARED_SEAT;
        return c.json(await startTakeover(handoffDeps, userId, orgId, agentId, runId ?? null, screen, shared), 200);
      },
    );
  }

  // Only the browser stops: the agent's screen stays on (ADR 0058 §1).
  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agents/{agentId}/browser/stop",
      tags,
      security,
      summary: "Close the agent's browser now (its logins stay); its next browser call opens a fresh one",
      description: SEAT_NOTE,
      request: { params: AgentParams, query: SeatQuery },
      responses: { 204: { description: "Stopped" }, ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const hub = deps.extras?.sandbox?.machines?.hub;
      const shared = c.req.valid("query").seat === SHARED_SEAT;
      await stopAgentBrowser(db, hub, c.get("user").id, orgId, agentId, adapters.pubsub, shared);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agents/{agentId}/browser/restart",
      tags,
      security,
      summary: "Restart the agent's browser on the page it showed (its logins stay); every live view gets it again",
      description:
        "Try again on a view whose page never came. Only who may drive the agent's browser (403 otherwise): someone who only watches watches again instead. Answers once the browser closed; it opens again in the background.",
      request: { params: AgentParams },
      responses: { 204: { description: "Closed, opening again" }, ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const live = deps.extras?.browserLive;
      if (!live) throw new ValidationError("Connected computers are not available on this server");
      await live.restart(c.get("user").id, orgId, agentId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/browser/handoffs/{handoffId}/control",
      tags,
      security,
      summary: "Take control of an agent's request (one person at a time)",
      request: { params: HandoffParams },
      responses: { 200: json(BrowserHandoff), ...errors },
    }),
    async (c) => {
      const { orgId, handoffId } = c.req.valid("param");
      return c.json(await claimHandoff(handoffDeps, c.get("user").id, orgId, handoffId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/browser/handoffs/{handoffId}/done",
      tags,
      security,
      summary: "Done (or hand back a take over): the agent reads the page again and goes on",
      description: "`note`: what the person wants the agent to know; it reads it as their own words.",
      request: { params: HandoffParams, body: body(z.object({ note: z.string().max(1000).optional() })) },
      responses: { 200: json(BrowserHandoff), ...errors },
    }),
    async (c) => {
      const { orgId, handoffId } = c.req.valid("param");
      const { note } = c.req.valid("json");
      return c.json(
        await finishHandoff(handoffDeps, c.get("user").id, orgId, handoffId, { result: "done", note }),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/browser/handoffs/{handoffId}/failed",
      tags,
      security,
      summary: "Couldn't do it, with an optional note the agent reads",
      request: { params: HandoffParams, body: body(z.object({ note: z.string().max(1000).optional() })) },
      responses: { 200: json(BrowserHandoff), ...errors },
    }),
    async (c) => {
      const { orgId, handoffId } = c.req.valid("param");
      const { note } = c.req.valid("json");
      return c.json(
        await finishHandoff(handoffDeps, c.get("user").id, orgId, handoffId, { result: "failed", note }),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/browser/handoffs/{handoffId}/cancel",
      tags,
      security,
      summary: "Cancel an agent's request; it goes on without it",
      request: { params: HandoffParams },
      responses: { 200: json(BrowserHandoff), ...errors },
    }),
    async (c) => {
      const { orgId, handoffId } = c.req.valid("param");
      return c.json(await cancelHandoff(handoffDeps, c.get("user").id, orgId, handoffId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agents/{agentId}/browser/open",
      tags,
      security,
      summary:
        "Open a site in the agent's browser (the person in control), or go back, forward or reload; a closed browser opens",
      description:
        "Only the person in control (409 `browser.not_in_control` otherwise), and only while the agent may use its browser (`browser:use`) and its computer serves it (403 otherwise). `url`: http(s), a bare host gets https (anything else is 400 `browser.bad_address`); or `go`: the address bar's arrows and reload. A site outside the agent's list is 403 `browser.not_allowed`; a page that fails to load is 400 `browser.open_failed`.",
      request: { params: AgentParams, body: body(PageTarget) },
      responses: { 204: { description: "Opened" }, ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const to = pageTarget(c.req.valid("json"));
      await openPageInControl(handoffDeps, deps.extras?.sandbox?.machines?.hub, c.get("user").id, orgId, agentId, to);
      return c.body(null, 204);
    },
  );

  return app;
}
