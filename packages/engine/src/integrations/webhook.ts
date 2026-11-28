import { createHmac } from "node:crypto";
import { type KeyWrapper, OutboundAddressError } from "@agenteschat/adapters";
import { and, type Database, eq, schema } from "@agenteschat/db";
import { PermanentJobError } from "../outbox";
import { webhookSecretOf } from "./apps";
import { appMessageById } from "./traffic";

const { integrationApps, integrationAppChannels } = schema;

export interface WebhookDeliveryDeps {
  db: Database;
  keyWrappers: KeyWrapper[];
  /** `outboundFetch()` in the server: the address checked and pinned at every request (SSRF). */
  fetch: typeof fetch;
}

const TIMEOUT_MS = 10_000;

/**
 * Standard Webhooks headers (standardwebhooks.com): `webhook-signature` is `v1,` and the base64 HMAC-SHA256 of
 * `{id}.{timestamp}.{body}` with the secret's bytes (the part after `whsec_`, base64-decoded).
 */
export function signWebhook(secret: string, id: string, body: string, nowMs = Date.now()) {
  const timestamp = String(Math.floor(nowMs / 1000));
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` };
}

/**
 * Sends an agent's message to an app's webhook (job `integration_app.deliver`, queued by the message's own insert):
 * still its channel, still a token and an address, the message still readable. A 2xx is delivered; a network failure,
 * a 408, a 429 or a 5xx is tried again by the outbox with its backoff; any other answer is final. The outcome is kept
 * on the app for its settings page. Nothing the endpoint answers is read.
 */
export async function deliverToApp(deps: WebhookDeliveryDeps, orgId: string, appId: string, messageId: string) {
  const [app] = await deps.db
    .select()
    .from(integrationApps)
    .where(and(eq(integrationApps.orgId, orgId), eq(integrationApps.id, appId)));
  if (!app?.webhookUrl || !app.tokenHash) return;
  const message = await appMessageById(deps.db, orgId, messageId);
  if (!message) return;
  const [still] = await deps.db
    .select({ id: integrationAppChannels.channelId })
    .from(integrationAppChannels)
    .where(and(eq(integrationAppChannels.appId, appId), eq(integrationAppChannels.channelId, message.channel_id)));
  if (!still) return;
  const secret = await webhookSecretOf(deps.keyWrappers, app);
  if (!secret) return;
  const body = JSON.stringify({ type: "message.created", app_id: appId, message });
  const record = (error: string | null) =>
    deps.db
      .update(integrationApps)
      .set({ webhookLastAt: new Date(), webhookLastError: error })
      .where(eq(integrationApps.id, appId));
  let status: number;
  try {
    const res = await deps.fetch(app.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...signWebhook(secret, `${appId}:${messageId}`, body) },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    await res.body?.cancel().catch(() => {});
  } catch (error) {
    const why = error instanceof OutboundAddressError ? "address_refused" : "network";
    await record(why);
    if (why === "address_refused") throw new PermanentJobError("webhook address refused");
    throw error;
  }
  if (status >= 200 && status < 300) return record(null);
  await record(`http_${status}`);
  if (status === 408 || status === 429 || status >= 500) throw new Error(`webhook answered ${status}`);
  throw new PermanentJobError(`webhook answered ${status}`);
}
