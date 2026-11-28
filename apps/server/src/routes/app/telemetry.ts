import {
  buildTelemetryReport,
  isAgentesCloud,
  NotFoundError,
  pinnedOwner,
  setTelemetryEnabled,
  telemetryState,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { ClientVitalsReport, clientVitals } from "../../client-vitals";
import { telemetryFacts } from "../../telemetry";
import { type AppDeps, body, createAppRouter, errors, json, noContent, requireSession, security } from "./context";

const tags = ["System"];

const Size = z.object({
  cpus: z.number().int(),
  memoryGb: z.number(),
  diskGb: z.number(),
  limit: z
    .object({ cpus: z.number().int(), memoryGb: z.number() })
    .optional()
    .openapi({ description: "What the process may use of the machine, when less (a container's limits)." }),
});
const Load = z
  .object({
    loadAvg: z.number(),
    loadPeak: z.number(),
    memoryAvg: z.number(),
    memoryPeak: z.number(),
    hours: z.number(),
  })
  .nullable();

const BrowserTraffic = z
  .object({
    upMb: z.number().int(),
    downMb: z.number().int(),
    hours: z.number(),
    computers: z.number().int(),
  })
  .nullable()
  .openapi({
    description:
      "What the agents' browsers on these computers sent and received over the last day, in MB (10^6 bytes), as their Chrome counts each request's headers and body, with the `hours` counted on average and how many of them said. Null when none did.",
  });

/** One measure of the apps' speed reports since the last report: how many values, their median and 95th percentile. */
const VitalStat = z.object({ n: z.number().int(), p50: z.number(), p95: z.number() });

const Report = z
  .object({
    report: z.literal(1),
    instance: z.string().openapi({ description: "Random, made at the first start: the report's only id." }),
    version: z.string(),
    edition: z.enum(["selfhost", "cloud"]),
    install: z.enum(["docker", "native", "desktop"]),
    os: z.string(),
    osVersion: z.string().openapi({
      description: "The server's system version as numbers alone (`10.0.19045`, a kernel's `6.8.0`), else `other`.",
    }),
    arch: z.string(),
    uptimeHours: z.number(),
    host: z.object({ size: Size, container: z.boolean(), load: Load }),
    organizations: z.number().int(),
    people: z.object({
      total: z.number().int(),
      active1d: z.number().int(),
      active7d: z.number().int(),
      active30d: z.number().int(),
    }),
    agents: z.number().int(),
    computers: z.array(
      z.object({
        kind: z.enum(["connected", "host", "managed"]),
        os: z.string(),
        arch: z.string(),
        size: Size.nullable(),
        count: z.number().int().openapi({ description: "How many computers are of this kind, system and size." }),
        agents: z.number().int(),
        load: Load,
        browserTraffic: BrowserTraffic,
      }),
    ),
    lastDay: z.object({
      runs: z.number().int(),
      toolCalls: z.number().int(),
      desktopMinutes: z.number().int(),
      terminalMinutes: z.number().int(),
      models: z.array(
        z.object({
          provider: z.string(),
          model: z.string(),
          calls: z.number().int(),
          inputTokens: z.number().int(),
          outputTokens: z.number().int(),
        }),
      ),
      clientVitals: z
        .record(
          z.string(),
          z.object({
            reports: z.number().int(),
            coldStartMs: VitalStat.optional(),
            firstRowsMs: VitalStat.optional(),
            jsLagP95Ms: VitalStat.optional(),
            jsLagMaxMs: VitalStat.optional(),
            heapBytes: VitalStat.optional(),
            webviewBytes: VitalStat.optional(),
            getsPerReturn: VitalStat.optional(),
            reconnects: VitalStat.optional(),
          }),
        )
        .openapi({
          description:
            "How fast the apps ran since the last report, by platform (`ios`, `android`, `web`, the desktop app's `macos`, `windows`, `linux`): how many speed reports, and per measure how many values with their median and 95th percentile.",
        }),
    }),
  })
  .openapi("TelemetryReport");

const Telemetry = z
  .object({
    enabled: z.boolean().openapi({ description: "The owner's switch." }),
    envOff: z
      .boolean()
      .openapi({ description: "`TELEMETRY=off` on the server: nothing is sent, whatever the switch." }),
    report: Report.openapi({ description: "Exactly what the next report sends." }),
  })
  .openapi("ServerTelemetry");

/** The usage report's switch (ADR 0060 §5): only the installation's pinned owner, never on agentes.chat itself. */
export function telemetryRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const app = createAppRouter(deps);
  app.use("/telemetry", requireSession(deps.auth));

  const requireOwner = async (userId: string) => {
    if (isAgentesCloud(config.PUBLIC_URL) || (await pinnedOwner(db)) !== userId) throw new NotFoundError("Not found");
  };
  const view = async () => ({
    enabled: (await telemetryState(db)).enabled,
    envOff: config.TELEMETRY === "off",
    report: await buildTelemetryReport(db, telemetryFacts(config)),
  });

  app.openapi(
    createRoute({
      method: "get",
      path: "/telemetry",
      tags,
      summary: "The usage report's switch, and the next report",
      description:
        "404 for everyone but the installation's owner (its first account, kept once it is gone), and on agentes.chat itself.",
      security,
      responses: { 200: json(Telemetry), 401: errors[401], 404: errors[404] },
    }),
    async (c) => {
      await requireOwner(c.get("user").id);
      return c.json(await view(), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/telemetry",
      tags,
      summary: "Turn the usage report on or off",
      security,
      request: { body: body(z.object({ enabled: z.boolean() })) },
      responses: { 200: json(Telemetry), 401: errors[401], 404: errors[404] },
    }),
    async (c) => {
      await requireOwner(c.get("user").id);
      await setTelemetryEnabled(db, c.req.valid("json").enabled);
      return c.json(await view(), 200);
    },
  );

  /** An app's reports: about one at each start and each return to it, numbers only. */
  const CLIENT_VITALS_PER_USER = { limit: 30, windowMs: 60_000 };
  app.use("/client-vitals", requireSession(deps.auth));
  app.openapi(
    createRoute({
      method: "post",
      path: "/client-vitals",
      tags,
      summary: "How fast an app ran: its cold start, JavaScript stalls, heap and reads per return",
      description:
        "Summed up once a minute into the process's vitals (the operator's `GET /vitals`), with nobody's id. A bounded sample is also kept in `instance_telemetry.client_vitals` until the next usage report, which sends its per-platform summary (ADR 0060 §5); none with `TELEMETRY=off`. Past the per-person limit a report is dropped, still answered 204.",
      security,
      request: { body: body(ClientVitalsReport) },
      responses: { 204: noContent[204], 401: errors[401] },
    }),
    async (c) => {
      const limit = await deps.adapters.rateLimiter.consume(
        `client-vitals:${c.get("user").id}`,
        CLIENT_VITALS_PER_USER,
      );
      if (limit.allowed) clientVitals.add(c.req.valid("json"));
      return c.body(null, 204);
    },
  );

  return app;
}
