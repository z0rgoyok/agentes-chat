/**
 * Test fake — integration apps (ADR 0251), same shapes as the server's `…/integration-apps` routes: a token and a
 * webhook secret come back once, only their hint stays.
 */
import type { ApiClient, IntegrationApp, IntegrationAppInput } from "@agenteschat/client";

export interface FakeIntegrationApps {
  client: ApiClient["integrationApps"];
  apps: IntegrationApp[];
}

let n = 0;
const token = () => `agi_fake${String(++n).padStart(39, "0")}`;
const secret = () => `whsec_ZmFrZS1zZWNyZXQtZm9yLXRlc3RzLW9ubHk${n}`;

export function createFakeIntegrationApps(
  log: (method: string, ...args: unknown[]) => void,
  now: () => Date,
): FakeIntegrationApps {
  const fake: FakeIntegrationApps = { apps: [], client: undefined as never };
  const find = (id: string) => {
    const app = fake.apps.find((a) => a.id === id);
    if (!app) throw new Error(`no app ${id}`);
    return app;
  };
  const apply = (app: IntegrationApp, input: Partial<IntegrationAppInput>) => {
    if (input.name !== undefined) app.name = input.name;
    if (input.color) app.color = input.color;
    if (input.channels) app.channels = input.channels;
    if (input.webhookUrl !== undefined) app.webhookUrl = input.webhookUrl;
  };
  fake.client = {
    list: async (orgId) => {
      log("integrationApps.list", orgId);
      return structuredClone(fake.apps);
    },
    create: async (orgId, input) => {
      log("integrationApps.create", orgId, input);
      const value = token();
      const app: IntegrationApp = {
        id: `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`,
        name: input.name,
        color: input.color ?? "graphite",
        channels: input.channels,
        tokenHint: value.slice(-4),
        tokenCreatedAt: now().toISOString(),
        webhookUrl: input.webhookUrl ?? null,
        webhookLastAt: null,
        webhookLastError: null,
        createdByUserId: null,
        createdAt: now().toISOString(),
        lastUsedAt: null,
      };
      fake.apps.unshift(app);
      return { app: structuredClone(app), token: value, webhookSecret: app.webhookUrl ? secret() : null };
    },
    update: async (orgId, appId, input) => {
      log("integrationApps.update", orgId, appId, input);
      const app = find(appId);
      const fresh = !app.webhookUrl && !!input.webhookUrl;
      apply(app, input);
      return { app: structuredClone(app), webhookSecret: fresh ? secret() : null };
    },
    newToken: async (orgId, appId) => {
      log("integrationApps.newToken", orgId, appId);
      const app = find(appId);
      const value = token();
      app.tokenHint = value.slice(-4);
      return { app: structuredClone(app), token: value };
    },
    revokeToken: async (orgId, appId) => {
      log("integrationApps.revokeToken", orgId, appId);
      const app = find(appId);
      app.tokenHint = null;
      return structuredClone(app);
    },
    newWebhookSecret: async (orgId, appId) => {
      log("integrationApps.newWebhookSecret", orgId, appId);
      return { app: structuredClone(find(appId)), webhookSecret: secret() };
    },
    remove: async (orgId, appId) => {
      log("integrationApps.remove", orgId, appId);
      fake.apps = fake.apps.filter((a) => a.id !== appId);
    },
  };
  return fake;
}
