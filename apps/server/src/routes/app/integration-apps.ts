import {
  createIntegrationApp,
  deleteIntegrationApp,
  INTEGRATION_LIMITS,
  listIntegrationApps,
  revokeIntegrationToken,
  rotateIntegrationToken,
  rotateWebhookSecret,
  updateIntegrationApp,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";

const App = z
  .object({
    id: z.string(),
    name: z.string(),
    color: z.string(),
    channels: z.array(z.object({ channelId: z.string(), canPost: z.boolean() })),
    tokenHint: z.string().nullable().openapi({ description: "The live token's last four characters; null: revoked." }),
    tokenCreatedAt: z.string().nullable(),
    webhookUrl: z.string().nullable(),
    webhookLastAt: z.string().nullable(),
    webhookLastError: z
      .string()
      .nullable()
      .openapi({ description: "`http_<status>`, `network` or `address_refused`." }),
    createdByUserId: z.string().nullable(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
  })
  .openapi("IntegrationApp");

const Channels = z
  .array(z.object({ channelId: z.uuid(), canPost: z.boolean() }))
  .max(INTEGRATION_LIMITS.channelsPerApp);

const Fields = z.object({
  name: z.string().min(1).max(INTEGRATION_LIMITS.name),
  color: z.string().max(20).optional(),
  channels: Channels,
  webhookUrl: z.string().max(INTEGRATION_LIMITS.webhookUrl).nullable().optional(),
});

/** Shown once: the token (`agi_…`) and the webhook's signing secret (`whsec_…`) are never readable again. */
const Secrets = z.object({
  app: App,
  token: z.string().optional(),
  webhookSecret: z.string().nullable().optional(),
});

/** Settings › Integrations (ADR 0251): who may `manage_connectors` makes, changes and revokes integration apps. */
export function integrationAppRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const d = {
    db: deps.db,
    keyWrappers: [deps.adapters.keyWrapper, ...deps.adapters.legacyKeyWrappers],
    resolveHost: deps.extras?.resolveHost,
  };
  const AppParams = OrgParams.extend({ appId: z.uuid() });
  const tags = ["Integration apps"];

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/integration-apps",
      tags,
      security,
      summary: "The workspace's integration apps",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ apps: z.array(App) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ apps: await listIntegrationApps(deps.db, c.get("user").id, orgId) }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/integration-apps",
      tags,
      security,
      summary: "Connect an integration app: its token (and its webhook's secret) are shown once",
      request: { params: OrgParams, body: body(Fields) },
      responses: { 201: json(Secrets), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await createIntegrationApp(d, c.get("user").id, orgId, c.req.valid("json")), 201);
    },
  );
  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/integration-apps/{appId}",
      tags,
      security,
      summary: "Change an app's name, color, channels or webhook (a new webhook's secret is shown once)",
      request: { params: AppParams, body: body(Fields.partial()) },
      responses: { 200: json(Secrets), ...errors },
    }),
    async (c) => {
      const { orgId, appId } = c.req.valid("param");
      return c.json(await updateIntegrationApp(d, c.get("user").id, orgId, appId, c.req.valid("json")), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/integration-apps/{appId}/token",
      tags,
      security,
      summary: "A new token for the app (the old one stops at once), shown once",
      request: { params: AppParams },
      responses: { 200: json(Secrets), ...errors },
    }),
    async (c) => {
      const { orgId, appId } = c.req.valid("param");
      return c.json(await rotateIntegrationToken(d, c.get("user").id, orgId, appId), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/integration-apps/{appId}/token",
      tags,
      security,
      summary: "Revoke the app's token: it can't post or read until a new one is made",
      request: { params: AppParams },
      responses: { 200: json(z.object({ app: App })), ...errors },
    }),
    async (c) => {
      const { orgId, appId } = c.req.valid("param");
      return c.json({ app: await revokeIntegrationToken(d, c.get("user").id, orgId, appId) }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/integration-apps/{appId}/webhook-secret",
      tags,
      security,
      summary: "A new signing secret for the app's webhook, shown once",
      request: { params: AppParams },
      responses: { 200: json(Secrets), ...errors },
    }),
    async (c) => {
      const { orgId, appId } = c.req.valid("param");
      return c.json(await rotateWebhookSecret(d, c.get("user").id, orgId, appId), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/integration-apps/{appId}",
      tags,
      security,
      summary: "Remove an integration app (its messages stay)",
      request: { params: AppParams },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const { orgId, appId } = c.req.valid("param");
      await deleteIntegrationApp(d, c.get("user").id, orgId, appId);
      return c.body(null, 204);
    },
  );
  return app;
}
