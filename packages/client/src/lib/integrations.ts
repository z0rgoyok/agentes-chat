import type { TFunction } from "i18next";
import type { IntegrationApp } from "../api/types";
import { relativeTime } from "./format";
import { webSettingsUrl } from "./server";

/** Mirror of `INTEGRATION_LIMITS` (packages/engine/src/integrations/apps.ts). */
export const INTEGRATION_NAME_MAX = 64;
export const INTEGRATION_CHANNELS_MAX = 50;

/** Where an integration app calls (ADR 0251): the public API and the MCP endpoint, on this server. */
export const integrationAddresses = (serverUrl: string) => {
  const base = serverUrl.replace(/\/$/, "");
  return { api: `${base}/api/v1`, mcp: `${base}/mcp` };
};

/** An app's line under its name: its token, its channels, when it was used, and a failing webhook. */
export function integrationFacts(t: TFunction, locale: string, app: IntegrationApp, now = new Date()) {
  return [
    app.tokenHint ? t("integrations.facts.token", { hint: app.tokenHint }) : t("integrations.facts.noToken"),
    t("integrations.facts.channels", { count: app.channels.length }),
    app.lastUsedAt ? t("apps.usedAt", { when: relativeTime(t, locale, app.lastUsedAt, now) }) : t("apps.neverUsed"),
    app.webhookLastError ? t("integrations.facts.webhookFailed", { why: app.webhookLastError }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Settings › Integrations on the web, where an app is made and its channels picked (the phone links there). */
export const integrationsSettingsUrl = (serverUrl: string, orgId: string) =>
  webSettingsUrl(serverUrl, orgId, "integrations");
