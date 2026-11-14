import {
  actOnTeamWeek,
  getLodiPrefs,
  LODI_SWITCHES,
  liveLodiSwitches,
  type RoutineDeps,
  setLodiPrefs,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  hookConfig,
  json,
  noContent,
  OrgParams,
  requireSession,
  routineConnectorDeps,
  security,
} from "./context";

const tags = ["Right hand"];

const hour = z.number().int().min(0).max(23);
const legacy = "For app builds from before the day's and the week's cards were told apart.";

/** What I let the right hand do for me by itself (`right-hand-prefs.ts`). */
const TeamWeekSaved = z.object({
  weekOff: z.boolean().openapi({ description: "Semana da equipe, an administrator's weekly card, stopped." }),
  day: z.number().int().min(0).max(6).openapi({ description: "The weekly card's day. 0 = Sunday." }),
  weekHour: hour.openapi({ description: "The weekly card's hour, in `timezone`." }),
  dayOff: z.boolean().openapi({ description: "Resumo do dia, everyone's daily card, stopped." }),
  dayHour: hour.openapi({ description: "The daily card's hour, in `dayTimezone`." }),
  digestOff: z.boolean().openapi({ description: "The summary of approvals waiting on me, stopped." }),
  remindOff: z.boolean().openapi({ description: "Reminders of what the right hand and I agreed on, stopped." }),
  off: z.boolean().openapi({
    description: `${legacy} Read: nothing comes. Written true: stops both cards. Written false: starts the one card that build draws (the weekly for an administrator, the daily for anyone else).`,
  }),
  daily: z.boolean().openapi({
    description: `${legacy} Read: the daily card comes alone. Written true: the daily card in place of the weekly.`,
  }),
  hour: hour.openapi({ description: `${legacy} The hour of the card that build shows.` }),
});

const TeamWeekPrefs = TeamWeekSaved.extend({
  timezone: z.string().openapi({ description: "The workspace's time zone, which `day` and `weekHour` are in." }),
  dayTimezone: z.string().openapi({ description: "My own time zone, else the workspace's: `dayHour` is in it." }),
  switches: z.array(z.enum(LODI_SWITCHES)).openapi({
    description:
      "Read only: the other things the right hand does by itself on this server, each with a switch to show. `digest` and `reminders` are mine (`digestOff`, `remindOff`), `teamWatch` and `welcomePeople` the workspace's (its settings).",
  }),
}).openapi("TeamWeekPrefs");

// Each member takes its own keys and no other: a row sent with `dismiss` would otherwise be read as the whole card's.
const TeamWeekAct = z
  .union([
    z
      .object({
        rowId: z.string().min(1).max(200),
        text: z.string().max(2000).optional().openapi({
          description: "`unanswered` and `stalled`: the person's message, in their words.",
        }),
        skip: z.literal(true).optional().openapi({
          description:
            "Puts this one suggestion away and leaves the card: `retire` and `model` are refused for every administrator, `unanswered` is muted for me.",
        }),
      })
      .strict(),
    z.object({ dismiss: z.literal(true) }).strict(),
  ])
  .openapi("TeamWeekAct");

/**
 * What Lodi does for me by itself (ADR 0137 §9): my daily and weekly cards' hours, or off, its other switches of mine,
 * and a row of my card applied as me ("Criar rotina", asking Lodi for an agent, telling a task's agent to go on) or
 * "Agora não".
 */
export function teamWeekRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const routines: RoutineDeps = {
    db,
    pubsub: adapters.pubsub,
    context: deps.extras?.context,
    mail: adapters.mail,
    hooks: hookConfig(deps.config),
    connectors: routineConnectorDeps(deps),
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/team-week",
      tags,
      security,
      summary: "When my daily and weekly cards come, or that they are off",
      request: { params: OrgParams },
      responses: { 200: json(TeamWeekPrefs), ...errors },
    }),
    async (c) =>
      c.json(
        { ...(await getLodiPrefs(db, c.req.valid("param").orgId, c.get("user").id)), switches: liveLodiSwitches() },
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/team-week",
      tags,
      security,
      summary: "Move my daily or weekly card, stop it or start it again",
      request: { params: OrgParams, body: body(TeamWeekSaved.partial()) },
      responses: { 200: json(TeamWeekPrefs), ...errors },
    }),
    async (c) =>
      c.json(
        {
          ...(await setLodiPrefs(db, c.req.valid("param").orgId, c.get("user").id, c.req.valid("json"))),
          switches: liveLodiSwitches(),
        },
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/team-week/{messageId}",
      tags,
      security,
      summary: "Apply a row of my daily or weekly card, put that row away, or put the card away",
      request: { params: OrgParams.extend({ messageId: z.uuid() }), body: body(TeamWeekAct) },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      await actOnTeamWeek(routines, c.get("user").id, orgId, messageId, c.req.valid("json"));
      return c.body(null, 204);
    },
  );

  return app;
}
