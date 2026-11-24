import type { Edition } from "@agenteschat/modules";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

const HealthResponse = z
  .object({
    status: z.enum(["ok", "degraded", "draining", "overloaded"]),
    version: z.string().openapi({ example: "0.1.0" }),
    edition: z.enum(["selfhost", "cloud"]),
    database: z.enum(["ok", "unreachable"]),
    modules: z.array(z.string()).openapi({ description: "Extra modules loaded by this edition." }),
  })
  .openapi("Health");

const route = createRoute({
  method: "get",
  path: "/health",
  tags: ["System"],
  summary: "Health check",
  description:
    "Liveness and readiness probe. 200 when the database is reachable, 503 otherwise, and 503 (`draining`) once the server is shutting down. While the process turns new sockets and reads away (`LOAD_SHED_*`) the status is `overloaded`: still 200, or 503 with `?load=1` (a proxy's health check across several app processes).",
  request: {
    query: z.object({
      load: z.string().optional().openapi({
        description:
          "Any value: `overloaded` answers 503, so the proxy sends new requests to another process. Never on a single process's check: its only process would be taken out.",
      }),
    }),
  },
  responses: {
    200: { description: "Healthy", content: { "application/json": { schema: HealthResponse } } },
    503: {
      description: "Database unreachable, overloaded, or shutting down",
      content: { "application/json": { schema: HealthResponse } },
    },
  },
});

export interface HealthDeps {
  version: string;
  edition: Edition;
  modules: string[];
  pingDatabase: () => Promise<void>;
  /** True once the server is shutting down (`SHUTDOWN_DELAY_MS`): a proxy's health check stops sending requests here. */
  draining?: () => boolean;
  /** Why the process is overloaded now (`watchLoad`), or null: a proxy's check (`?load=1`) sends new requests elsewhere. */
  overloaded?: () => string | null;
}

async function healthOf(deps: HealthDeps) {
  const database = await deps
    .pingDatabase()
    .then(() => "ok" as const)
    .catch(() => "unreachable" as const);
  const draining = deps.draining?.() === true;
  const status = draining
    ? ("draining" as const)
    : database !== "ok"
      ? ("degraded" as const)
      : deps.overloaded?.()
        ? ("overloaded" as const)
        : ("ok" as const);
  return {
    status,
    version: deps.version,
    edition: deps.edition,
    database,
    modules: deps.modules,
  };
}

export function registerHealth(app: OpenAPIHono, deps: HealthDeps) {
  app.openapi(route, async (c) => {
    const body = await healthOf(deps);
    // Overload often hits every process at once (they share one database) and passes by itself: a container's health
    // check, a deploy's wait and an uptime monitor must not take it for down, nor a proxy take out its only process.
    const up = body.status === "ok" || (body.status === "overloaded" && c.req.valid("query").load === undefined);
    return up ? c.json(body, 200) : c.json(body, 503);
  });
}

/**
 * All the HTTP a worker process answers (`SERVER_ROLE=worker`): `/api/health` as the app does, for its container's
 * health check, and a 404 for anything else.
 */
export function workerHealth(deps: HealthDeps) {
  return async (req: Request) => {
    if (new URL(req.url).pathname !== "/api/health") return new Response("Not found\n", { status: 404 });
    const body = await healthOf(deps);
    return Response.json(body, { status: body.status === "ok" ? 200 : 503 });
  };
}
