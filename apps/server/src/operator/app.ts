import type { BlobStore, HumanCheck, PubSub, RateLimiter } from "@agenteschat/adapters";
import type { Config } from "@agenteschat/config";
import type { Database } from "@agenteschat/db";
import { type MachineHub, type SessionScreening, SURFACE_PREFIX, safeEqual } from "@agenteschat/engine";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { EventLoopLag } from "../event-loop-lag";
import { trustPeer } from "../http/client-ip";
import { apiError, domainErrorResponse, routeOf, validationHook } from "../http/errors";
import type { Logger } from "../logger";
import type { AppDeps } from "../routes/app/context";
import { createSurfaceApp } from "../surface/app";
import { registerOperatorAccess } from "./access";
import { registerOperatorAnalytics } from "./analytics";
import { registerOperatorClaudeAuth } from "./claude-auth";
import { registerOperatorEvents } from "./events";
import { registerOperatorHosts } from "./hosts";
import { registerOperatorJobs } from "./jobs";
import { registerOperatorLimits } from "./limits";
import { registerOperatorLookups } from "./lookups";
import { registerOperatorMachines } from "./machines";
import { registerOperatorOrgs } from "./orgs";
import { registerOperatorOutsideAccess } from "./outside-access";
import { registerOperatorPeople } from "./people";
import { registerOperatorReveal } from "./reveal";
import { registerOperatorRuns } from "./runs";
import { registerOperatorStanding } from "./standing";
import { registerOperatorSupport } from "./support";
import { registerOperatorWorkspace } from "./workspace";

/** Versioned because its caller deploys apart from this server (ADR 0056 §3). */
export const OPERATOR_API_PREFIX = "/api/operator/v1";

export interface OperatorDeps {
  db: Database;
  config: Config;
  version: string;
  log: Logger;
  /** Tells a workspace's members and admins of a change of standing (absent: nobody hears it live). */
  pubsub?: PubSub;
  /** The platform's bucket, where a workspace's and a registered host's logos are kept. */
  blobs?: BlobStore;
  /** Stops a suspended workspace's tasks on its computers. */
  hub?: MachineHub;
  /**
   * The server sends email: a workspace waiting long for its computer is told its owners will be emailed, and
   * early-access invitations and replies to support requests can go out.
   */
  emails?: boolean;
  /** The bot check (ADR 0075), reported by `/health`; absent: `off`. */
  humanCheck?: HumanCheck | null;
  /** This process's last reading of its event loop's delay, reported by `/health`; absent: null. */
  eventLoopLag?: () => EventLoopLag | null;
  /** Counts the reveal door's calls a minute; absent: this process counts its own. */
  rateLimiter?: RateLimiter;
  /** Screened sessions (ADR 0076), read through the review door; absent: none, so every one is a 404. */
  sessions?: Pick<SessionScreening, "segment"> | null;
  /** What the chat surface bridge (ADR 0187) posts and reads with; served only with `SURFACE_BRIDGE_TOKEN`. */
  surface?: AppDeps;
}

/**
 * The operator API (ADR 0056): what the people who run this instance need from their own services,
 * behind a bearer token: `token` for everything but the reveal door, `readToken` for reads alone, `revealToken`
 * for the reveal door alone. Served only by its own listener (`serveOperatorApi`), never by `createApp`.
 */
export function createOperatorApp(deps: OperatorDeps, token: string, readToken?: string, revealToken?: string) {
  const api = new OpenAPIHono({ defaultHook: validationHook() });
  api.openAPIRegistry.registerComponent("securitySchemes", "operator", {
    type: "http",
    scheme: "bearer",
    description:
      "This server's `OPERATOR_API_TOKEN`. Or its `OPERATOR_API_READ_TOKEN`, accepted only for `GET` and `HEAD` and never under `/review/`: anything else answers 403 `forbidden`. Under `/reveal/` neither is accepted: only `OPERATOR_API_REVEAL_TOKEN` is, for `POST` alone, and it is refused (403) everywhere else. On a server that didn't set it, every path under `/reveal/` answers 403.",
  });
  const forbidden = (c: Context, message: string) => apiError(c, 403, "forbidden", message);
  // Every path under the prefix, unknown ones and the document included, so nothing answers without it.
  api.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const under = (door: string) => c.req.path.startsWith(`${OPERATOR_API_PREFIX}/${door}/`);
    // The reveal door has one key and the other two never open it: the token that suspends workspaces and the one
    // that fills dashboards must not also read what people wrote. Closed (no key set), it says so to anyone.
    if (under("reveal")) {
      if (!revealToken) return forbidden(c, "This server's reveal door is closed");
      if (safeEqual(given, revealToken)) {
        return c.req.method === "POST" ? next() : forbidden(c, "The reveal token only posts");
      }
      const known = safeEqual(given, token) || (!!readToken && safeEqual(given, readToken));
      return known
        ? forbidden(c, "Only the reveal token opens this")
        : apiError(c, 401, "unauthorized", "Missing or wrong operator token");
    }
    if (safeEqual(given, token)) return next();
    if (revealToken && safeEqual(given, revealToken)) return forbidden(c, "The reveal token can't do this");
    if (!readToken || !safeEqual(given, readToken)) {
      return apiError(c, 401, "unauthorized", "Missing or wrong operator token");
    }
    // Decided here by method and path, never per route: a GET added later is readable with this token
    // from the start, so no GET outside the review blocks may change anything or return content.
    const reads = c.req.method === "GET" || c.req.method === "HEAD";
    if (!reads || under("review")) return forbidden(c, "The read-only operator token can't do this");
    await next();
  });
  registerOperatorOrgs(api, deps);
  registerOperatorStanding(api, deps);
  registerOperatorLimits(api, deps);
  registerOperatorOutsideAccess(api, deps);
  registerOperatorEvents(api, deps);
  registerOperatorMachines(api, deps);
  registerOperatorAccess(api, deps);
  registerOperatorAnalytics(api, deps);
  registerOperatorClaudeAuth(api, deps);
  registerOperatorLookups(api, deps);
  registerOperatorRuns(api, deps);
  registerOperatorJobs(api, deps);
  registerOperatorWorkspace(api, deps);
  registerOperatorPeople(api, deps);
  registerOperatorSupport(api, deps);
  registerOperatorReveal(api, deps);
  registerOperatorHosts(api, deps);
  api.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "agentes.chat operator API",
      version: deps.version,
      description:
        "Each server process's memory and event loop delay and how long runs wait to be claimed, workspace and account lookups, what a run did and why a message started one or none, what a workspace connected, recorded, asked and scheduled, what a person was notified of and reaches, the messages no run answered, the job queue, the emails queued to an address and what model calls spent, the times a member asked for help, one piece of what a workspace wrote read with a reason and a member's support request answered by email (the reveal door), a workspace told afterwards that its content was read to investigate suspected abuse, workspace standing, billing holds and limits (ADR 0079), a workspace's logo and accent color (ADR 0193), the extra hostnames this server answers on with their look (ADR 0194), outside collaborators (ADR 0191), the events feed and review blocks, the workspaces' computers from an external provisioner, who may sign up (the waiting list and early-access invitations, ADR 0078), how new Claude sign-ins for all agents are made (ADR 0150), and how connectors are used (ADR 0103), for the people who run this instance (ADR 0056).",
    },
    servers: [{ url: OPERATOR_API_PREFIX }],
    security: [{ operator: [] }],
  });

  const app = new OpenAPIHono();
  app.onError((error, c) => {
    const mapped = domainErrorResponse(error, c);
    if (mapped) return mapped;
    deps.log.error("unhandled error", {
      method: c.req.method,
      path: c.req.path,
      route: routeOf(c),
      status: 500,
      orgId: c.req.param("orgId"),
      error,
      stack: error.stack,
    });
    return apiError(c, 500, "internal_error", "Something went wrong on our side");
  });
  app.route(OPERATOR_API_PREFIX, api);
  app.notFound((c) => apiError(c, 404, "not_found", "Route not found"));
  return app;
}

/**
 * What the operator listener answers: `/api/surface/v1` goes to the chat surface bridge and everything else to the
 * operator API, each only with its own token set (absent: 404). Null when neither token is set.
 */
export function operatorFetch(deps: OperatorDeps): ((req: Request) => Response | Promise<Response>) | null {
  const { OPERATOR_API_TOKEN: token, SURFACE_BRIDGE_TOKEN: bridgeToken } = deps.config;
  if (!token && !bridgeToken) return null;
  const { OPERATOR_API_READ_TOKEN, OPERATOR_API_REVEAL_TOKEN } = deps.config;
  const operator = token ? createOperatorApp(deps, token, OPERATOR_API_READ_TOKEN, OPERATOR_API_REVEAL_TOKEN) : null;
  const surface = bridgeToken && deps.surface ? createSurfaceApp(deps.surface, bridgeToken, deps.version) : null;
  const missing = () => Response.json({ error: { code: "not_found", message: "Route not found" } }, { status: 404 });
  return (req) => {
    const { pathname } = new URL(req.url);
    const bridge = pathname === SURFACE_PREFIX || pathname.startsWith(`${SURFACE_PREFIX}/`);
    const app = bridge ? surface : operator;
    return app ? app.fetch(req) : missing();
  };
}

/** The operator listener, only when `OPERATOR_API_TOKEN` or `SURFACE_BRIDGE_TOKEN` is set: without both nothing listens. */
export function serveOperatorApi(deps: OperatorDeps, port = deps.config.OPERATOR_API_PORT) {
  const fetch = operatorFetch(deps);
  if (!fetch) return null;
  // The bridge takes a message with its files and a voice note: up to 100 MiB, and room for the multipart framing.
  return Bun.serve({
    hostname: deps.config.HOST,
    port,
    fetch: (req, srv) => {
      trustPeer(req.headers, srv.requestIP(req)?.address, deps.config.TRUSTED_PROXIES);
      return fetch(req);
    },
    maxRequestBodySize: 101 * 1024 * 1024,
  });
}
