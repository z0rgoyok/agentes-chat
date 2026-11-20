import { PROBLEM_REPORT_MAX_BYTES, redactCommon } from "@agenteschat/adapters";
import { configFacts } from "@agenteschat/config";
import {
  buildProblemReport,
  finishProblemReport,
  isAgentesCloud,
  NotFoundError,
  PROBLEM_NOTE_MAX,
  PROBLEM_REPORT_PLACES,
  problemReportSchema,
  problemReportText,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../../http/errors";
import { recentLogLines } from "../../logger";
import { telemetryFacts } from "../../telemetry";
import { type AppDeps, body, createAppRouter, errors, json, requireSession, security } from "./context";

const tags = ["System"];

const SEND_TIMEOUT_MS = 15_000;
const HOUR = 3600_000;
const SEND_PER_PERSON = { limit: 5, windowMs: HOUR };
const SEND_PER_INSTALL = { limit: 20, windowMs: HOUR };
/** A preview may ask a computer for its part: limited too. */
const PREVIEW_PER_PERSON = { limit: 30, windowMs: HOUR };

const Code = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,63}$/);
// The engine's schema is plain zod: the route takes any object and checks it against that schema itself.
const ProblemReport = z.record(z.string(), z.unknown()).openapi("ProblemReport", {
  description: "Format 1 of the problem report: exactly what Send posts, checked against it.",
});

const PreviewInput = z.object({
  orgId: z.uuid(),
  place: z.enum(PROBLEM_REPORT_PLACES),
  code: Code.nullish(),
  step: Code.nullish(),
  context: z.object({ machineId: z.uuid(), agentId: z.uuid(), runId: z.uuid() }).partial().optional(),
  timings: z.record(z.string(), z.number().int().min(0).max(86_400_000)).optional(),
  facts: z
    .record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()]))
    .optional()
    .openapi({ description: "What the screen measured (a card's state code, its attempt), under `client.`." }),
  client: z
    .object({
      web: z.string().max(40),
      mobile: z.string().max(40),
      browser: z.string().max(40),
      locale: z.string().max(20),
    })
    .partial()
    .optional(),
});

const Preview = z
  .object({
    report: ProblemReport,
    text: z.string().openapi({ description: "The report as the preview shows it and Copy report copies it." }),
    send: z.enum(["on", "off"]).openapi({ description: "`off`: `PROBLEM_REPORT_URL=off`, so only Copy works." }),
    missing: z
      .object({
        computer: z.string().optional(),
        runnerLog: z.enum(["no_answer", "old_app"]).optional(),
        serverLines: z.boolean().optional(),
      })
      .openapi({ description: "Why a log isn't in the report, for the notes above it." }),
  })
  .openapi("ProblemReportPreview");

const SendInput = z.object({
  orgId: z.uuid(),
  report: ProblemReport,
  note: z.string().max(PROBLEM_NOTE_MAX).nullish(),
  replyTo: z.email().max(254).nullish(),
});

/**
 * "Send a report" on a self-hosted server: preview gathers the report, send posts that same report (checked and
 * scrubbed again) to `PROBLEM_REPORT_URL`. 404 on agentes.chat itself, where operators read everything already.
 */
export function problemReportRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const app = createAppRouter(deps);
  app.use("/problem-reports/*", requireSession(deps.auth));
  const notOnCloud = () => {
    if (isAgentesCloud(config.PUBLIC_URL)) throw new NotFoundError("Not found");
  };
  const limited = async (rules: [string, { limit: number; windowMs: number }][]) => {
    const results = await Promise.all(rules.map(([key, rule]) => deps.adapters.rateLimiter.consume(key, rule)));
    const refused = results.filter((r) => !r.allowed);
    if (refused.length === 0) return null;
    return Math.max(1, ...refused.map((r) => Math.ceil((r.resetAt.getTime() - Date.now()) / 1000)));
  };

  app.openapi(
    createRoute({
      method: "post",
      path: "/problem-reports/preview",
      tags,
      summary: "Gather a problem report to show before it's sent",
      description:
        "Reads only. A computer named in `context` is asked for its part (up to 5 s). What's added follows what the person may see: server log lines only for the installation's owner.",
      security,
      request: { body: body(PreviewInput) },
      responses: { 200: json(Preview), 429: errorResponse("Too many previews"), ...errors },
    }),
    async (c) => {
      notOnCloud();
      const input = c.req.valid("json");
      const userId = c.get("user").id;
      const wait = await limited([[`problem-report-preview:${userId}`, PREVIEW_PER_PERSON]]);
      if (wait) return apiError(c, 429, "rate_limited", "Too many reports in a short time", { retryAfterS: wait });
      const facts = telemetryFacts(config);
      const { report, missing } = await buildProblemReport(
        db,
        {
          orgId: input.orgId,
          userId,
          place: input.place,
          code: input.code,
          step: input.step,
          context: input.context,
          timings: input.timings,
          clientFacts: input.facts,
          client: input.client,
        },
        {
          server: { version: facts.version, install: facts.install, os: facts.os, arch: facts.arch },
          config: configFacts(config),
          publicUrl: config.PUBLIC_URL,
          serverLines: recentLogLines,
          hub: deps.extras?.sandbox?.machines?.hub ?? null,
        },
      );
      return c.json(
        {
          report,
          text: problemReportText(report),
          send: config.PROBLEM_REPORT_URL === "off" ? "off" : "on",
          missing,
        } as const,
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/problem-reports/send",
      tags,
      summary: "Send a previewed problem report to agentes.chat",
      description:
        "Posts the report the preview returned, with the person's note and reply address, to `PROBLEM_REPORT_URL`. 409 `off` when that's empty, 429 with `retryAfterS` when too many went, 502 `unreachable` or `refused` when the receiver didn't take it.",
      security,
      request: { body: body(SendInput) },
      responses: {
        200: json(z.object({ id: z.string() })),
        429: errorResponse("Too many reports"),
        502: errorResponse("The receiver didn't take it"),
        ...errors,
      },
    }),
    async (c) => {
      notOnCloud();
      const input = c.req.valid("json");
      const userId = c.get("user").id;
      if (config.PROBLEM_REPORT_URL === "off") return apiError(c, 409, "off", "Sending reports is off on this server");
      const wait = await limited([
        [`problem-report:${userId}`, SEND_PER_PERSON],
        ["problem-report:install", SEND_PER_INSTALL],
      ]);
      if (wait) return apiError(c, 429, "rate_limited", "Too many reports in a short time", { retryAfterS: wait });
      const parsed = problemReportSchema.safeParse(input.report);
      if (!parsed.success) return apiError(c, 400, "bad_request", "That isn't a problem report");
      const report = finishProblemReport(parsed.data, {
        note: input.note,
        replyTo: input.replyTo,
        redact: redactCommon,
      });
      const payload = JSON.stringify(report);
      if (new TextEncoder().encode(payload).length > PROBLEM_REPORT_MAX_BYTES) {
        return apiError(c, 400, "too_large", "The report is too large");
      }
      let res: Response;
      try {
        res = await (deps.extras?.http ?? fetch)(config.PROBLEM_REPORT_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch {
        return apiError(c, 502, "unreachable", "agentes.chat didn't answer");
      }
      if (res.status === 429) {
        const retryAfterS = Math.max(1, Number(res.headers.get("retry-after")) || 60);
        return apiError(c, 429, "rate_limited", "Too many reports in a short time", { retryAfterS });
      }
      const answer = res.ok ? ((await res.json().catch(() => null)) as { id?: unknown } | null) : null;
      if (!res.ok || typeof answer?.id !== "string") {
        return apiError(c, 502, res.status >= 500 ? "unreachable" : "refused", "agentes.chat didn't accept the report");
      }
      deps.log?.info("problem report sent", { id: answer.id, place: report.place });
      return c.json({ id: answer.id }, 200);
    },
  );

  return app;
}
