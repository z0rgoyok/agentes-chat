import { and, eq, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { ConflictError, NotFoundError } from "./errors";
import { adminsOf } from "./notification-producers";
import { type NotificationDeps, notify, resolveNotifications } from "./notifications";
import { can, requirePermission } from "./organizations";
import type { RolePermission } from "./permissions";
import { speechOwnerIn } from "./speech-settings";

/**
 * "Pedir a um admin": what a person can't do here themselves, sent to who can as an inbox row (`admin_ask`) that does
 * it, or opens where it's done, in one click.
 * `channel_agent`: add an agent to a channel (after "@" picked one that isn't there); done once it is added.
 * `create_agents`: let the asker create agents (Members, where roles are given).
 * `webhook`: set up a service's webhook for routines (`provider`: github, sentry).
 * `voice`: choose what turns voice into text on this server (Settings › Voice): only its owner can, so only they hear it.
 */
export type AdminAsk =
  | { what: "channel_agent"; channelId: string; agentId: string }
  | { what: "create_agents" }
  | { what: "webhook"; provider: string }
  | { what: "voice" };

/** Who answers each ask, by the permission it needs; `voice` by who owns the server. */
const DECIDES: Record<Exclude<AdminAsk["what"], "voice">, RolePermission> = {
  channel_agent: "manage_channels",
  create_agents: "manage_roles",
  webhook: "manage_connectors",
};

const SERVICE_NAMES: Record<string, string> = { github: "GitHub", sentry: "Sentry" };

export const adminAskKey = (orgId: string, ask: AdminAsk, askerId: string) =>
  ask.what === "channel_agent"
    ? `admin-ask:channel_agent:${ask.channelId}:${ask.agentId}`
    : ask.what === "webhook"
      ? `admin-ask:webhook:${orgId}:${ask.provider}`
      : ask.what === "voice"
        ? `admin-ask:voice:${orgId}`
        : `admin-ask:create_agents:${askerId}`;

/**
 * Sends the ask to everyone who may do it. Refused to someone who may do it themselves (`admin_ask.self`). Asking again
 * merges into the same row (one per channel and agent, per service, per asker), so repeats don't pile up.
 */
export async function askAdmins(deps: NotificationDeps, actorId: string, orgId: string, ask: AdminAsk) {
  const membership = await requirePermission(deps.db, actorId, orgId, "read");
  const voiceOwner = ask.what === "voice" ? await speechOwnerIn(deps.db, orgId) : null;
  const mine = ask.what === "voice" ? voiceOwner?.userId === actorId : can(membership, DECIDES[ask.what]);
  if (mine) throw new ConflictError("You can do this yourself", "admin_ask.self");
  const source: { channelId?: string; agentId?: string; label?: string } = {};
  if (ask.what === "channel_agent") {
    const [channel] = await deps.db
      .select({ name: schema.channels.name })
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.id, ask.channelId),
          eq(schema.channels.orgId, orgId),
          isNull(schema.channels.archivedAt),
        ),
      );
    const [agent] = await deps.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.id, ask.agentId), eq(schema.agents.orgId, orgId)));
    if (!channel || !agent) throw new NotFoundError("Channel or agent not found");
    Object.assign(source, { channelId: ask.channelId, agentId: ask.agentId, label: channel.name });
  }
  const sent = await notify(deps, {
    orgId,
    userIds:
      ask.what === "voice" ? (voiceOwner ? [voiceOwner.userId] : []) : await adminsOf(deps, orgId, DECIDES[ask.what]),
    kind: "admin_ask",
    groupKey: adminAskKey(orgId, ask, actorId),
    waiting: ask.what === "channel_agent",
    actor: { type: "user", id: actorId },
    source,
    latest: {
      reason: ask.what,
      ...(ask.what === "webhook" ? { title: SERVICE_NAMES[ask.provider] ?? ask.provider } : {}),
    },
  });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "admin.ask",
    target: { type: "organization", id: orgId },
    details: { ...ask },
  });
  return { sent: sent.length };
}

/** An agent joined a channel: whoever was asked to add it there is answered. */
export const resolveChannelAgentAsks = (deps: NotificationDeps, orgId: string, channelId: string, agentId: string) =>
  resolveNotifications(deps, orgId, {
    groupKey: adminAskKey(orgId, { what: "channel_agent", channelId, agentId }, ""),
    kind: "admin_ask",
  }).catch(() => 0);
