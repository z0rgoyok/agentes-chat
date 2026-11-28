import {
  archiveChannel,
  CHANNEL_KEYS,
  channelMembersDetail,
  deleteChannel,
  listArchivedChannels,
  listChannelOverrides,
  listPins,
  pinMessage,
  placeChannel,
  removeChannelMember,
  requireChannelAccess,
  setChannelAgentAutoReply,
  setChannelOverride,
  unarchiveChannel,
  unpinMessage,
  updateChannel,
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
import { Channel, Message } from "./schemas";

const tags = ["Channels"];
const ChannelParams = OrgParams.extend({ channelId: z.uuid() });
const PinParams = ChannelParams.extend({ messageId: z.uuid() });
const OverrideTarget = z.object({
  type: z.enum(["role", "person"]),
  id: z.string().min(1).openapi({ description: "A role's id (`everyone`, \"Todos\", too) or a person's user id." }),
});
const ChannelOverride = z
  .object({
    target: OverrideTarget,
    allow: z.array(z.enum(CHANNEL_KEYS)),
    deny: z.array(z.enum(CHANNEL_KEYS)),
  })
  .openapi("ChannelPermissionOverride");
const Pin = z
  .object({
    messageId: z.uuid(),
    channelId: z.uuid(),
    threadId: z.uuid().nullable().openapi({ description: "The message's thread (null: the main timeline)." }),
    pinnedByUserId: z.string().nullable().openapi({ description: "Null when that person was deleted." }),
    pinnedAt: z.string(),
    message: Message,
  })
  .openapi("Pin");

/** Channel management beyond chat (`chat.ts`): membership removal; open subscriptions are revoked at once. */
export function channelRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const opts = { pubsub: adapters.pubsub };

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels/{channelId}/leave",
      tags,
      security,
      summary: "Leave a channel",
      request: { params: ChannelParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      const userId = c.get("user").id;
      await removeChannelMember(db, userId, orgId, channelId, { userId }, opts);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/channels/{channelId}/members/people/{userId}",
      tags,
      security,
      summary: "Remove a person from a channel (creator or admin)",
      request: { params: ChannelParams.extend({ userId: z.string() }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId, userId } = c.req.valid("param");
      await removeChannelMember(db, c.get("user").id, orgId, channelId, { userId }, opts);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/channels/{channelId}/members/agents/{agentId}",
      tags,
      security,
      summary: "Remove an agent from a channel (creator or admin)",
      request: { params: ChannelParams.extend({ agentId: z.uuid() }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId, agentId } = c.req.valid("param");
      await removeChannelMember(db, c.get("user").id, orgId, channelId, { agentId }, opts);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/channels/{channelId}/members/agents/{agentId}",
      tags,
      security,
      summary: "Turn an agent's auto-reply in this channel on or off (creator, admin or the agent's owner)",
      request: {
        params: ChannelParams.extend({ agentId: z.uuid() }),
        body: body(z.object({ autoReply: z.boolean() })),
      },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId, agentId } = c.req.valid("param");
      await setChannelAgentAutoReply(
        db,
        c.get("user").id,
        orgId,
        channelId,
        agentId,
        c.req.valid("json").autoReply,
        opts,
      );
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/channels/{channelId}",
      tags,
      security,
      summary: "Archive a channel (creator or admin)",
      request: { params: ChannelParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      await archiveChannel(db, c.get("user").id, orgId, channelId, opts);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels/{channelId}/delete",
      tags,
      security,
      summary: "Delete a channel for good (owners and admins; never #general)",
      description:
        "Archived and marked deleted at once, its name freed and its routines removed; its messages, threads, files and the agents' memory of it are purged right after.",
      request: {
        params: ChannelParams,
        body: body(
          z.object({ name: z.string().max(81).openapi({ description: "The channel's name, typed to confirm." }) }),
        ),
      },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      await deleteChannel(
        { db, pubsub: adapters.pubsub, hub: deps.extras?.sandbox?.machines?.hub ?? null, mail: adapters.mail },
        c.get("user").id,
        orgId,
        channelId,
        c.req.valid("json").name,
      );
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/archived-channels",
      tags,
      security,
      summary: "Archived channels the caller may bring back (their creator or who manages channels), the latest first",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            channels: z.array(
              z.object({
                id: z.uuid(),
                name: z.string(),
                topic: z.string(),
                visibility: z.enum(["public", "private"]),
                archivedAt: z.string(),
              }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ channels: await listArchivedChannels(db, c.get("user").id, orgId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels/{channelId}/unarchive",
      tags,
      security,
      summary: "Bring an archived channel back as it was (creator or admin): the undo after archiving",
      request: { params: ChannelParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      await unarchiveChannel(db, c.get("user").id, orgId, channelId, opts);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/channels/{channelId}",
      tags,
      security,
      summary:
        "Change name, topic, who may join, whether agents reply in threads or the responsible agent (creator or admin)",
      request: {
        params: ChannelParams,
        body: body(
          z.object({
            name: z.string().min(1).max(80).optional(),
            topic: z.string().max(500).optional(),
            visibility: z.enum(["public", "private"]).optional(),
            audienceRoleIds: z.array(z.uuid()).max(100).optional().openapi({
              description:
                "Private only: people holding one of these roles (departments) also see it and may join (ADR 0125); empty: invite only.",
            }),
            replyInThreads: z.boolean().optional().openapi({
              description:
                "Agents asked in its main timeline answer in the thread under that message (ADR 0214). Runs already working stay where they are. 400 `channel.reply_in_threads` outside a regular channel.",
            }),
            leadAgentId: z.uuid().nullable().optional().openapi({
              description:
                "The agent responsible for the channel, one of its member agents; null: none. What a person says to the room goes to it, and it gets the turn when work it didn't hand off ends there. 400 `channel.lead_channel_only` outside a regular channel, `channel.lead_not_member` for an agent that isn't in it.",
            }),
          }),
        ),
      },
      responses: { 200: json(Channel), ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      const r = await updateChannel(db, c.get("user").id, orgId, channelId, c.req.valid("json"), opts);
      return c.json(
        {
          id: r.id,
          name: r.name,
          topic: r.topic,
          visibility: r.visibility,
          audienceRoleIds: r.audienceRoleIds,
          isMember: true,
          createdByUserId: r.createdByUserId,
          createdAt: r.createdAt.toISOString(),
          groupId: r.groupId,
          position: r.position,
          replyInThreads: r.replyInThreads,
          leadAgentId: r.leadAgentId,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channels/{channelId}/permissions",
      tags,
      security,
      summary: "The channel's exceptions to the workspace's keys, per role or person (ADR 0134; who manages it)",
      request: { params: ChannelParams },
      responses: {
        200: json(z.object({ keys: z.array(z.enum(CHANNEL_KEYS)), overrides: z.array(ChannelOverride) })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      const r = await listChannelOverrides(db, c.get("user").id, orgId, channelId);
      return c.json({ keys: [...r.keys], overrides: r.overrides }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/channels/{channelId}/permissions",
      tags,
      security,
      summary:
        "Set one exception of the channel (ADR 0134); empty allow and deny remove it (204). 403 `channel.permission_forbidden`: a key you don't hold here, a role or person not below you, or yourself",
      request: {
        params: ChannelParams,
        body: body(
          z.object({
            target: OverrideTarget,
            allow: z.array(z.enum(CHANNEL_KEYS)).max(CHANNEL_KEYS.length),
            deny: z.array(z.enum(CHANNEL_KEYS)).max(CHANNEL_KEYS.length),
          }),
        ),
      },
      responses: { 200: json(ChannelOverride), 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      const row = await setChannelOverride(db, c.get("user").id, orgId, channelId, c.req.valid("json"), opts);
      return row ? c.json(row, 200) : c.body(null, 204);
    },
  );

  // Channel categories became sectors (ADR 0240). Phone builds from before still ask for them: none.
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channel-categories",
      tags,
      security,
      deprecated: true,
      summary: "Always empty: channels sit in sectors (`groupId`, `GET …/agent-groups`)",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ categories: z.array(z.object({})).max(0) })), ...errors },
    }),
    (c) => c.json({ categories: [] }, 200),
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/channels/{channelId}/place",
      tags,
      security,
      summary: "Put a channel in a sector, before another channel or at its end (its creator or who manages channels)",
      request: {
        params: ChannelParams,
        body: body(
          z.object({
            groupId: z
              .uuid()
              .nullable()
              .openapi({ description: "Its sector (`agent-groups`); null: under Canais, in none." }),
            beforeChannelId: z.uuid().nullable().optional().openapi({ description: "Absent or null: at the end." }),
          }),
        ),
      },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      await placeChannel(db, c.get("user").id, orgId, channelId, c.req.valid("json"), opts);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channels/{channelId}/roster",
      tags,
      security,
      summary: "Channel members with names (people and agents)",
      request: { params: ChannelParams },
      responses: {
        200: json(
          z.object({
            members: z.array(
              z.object({
                type: z.enum(["person", "agent"]),
                id: z.string(),
                name: z.string(),
                handle: z.string().nullable(),
                autoReply: z.boolean().nullable().openapi({ description: "Agents: answers without a mention here." }),
                joinedAt: z.string(),
              }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      await requireChannelAccess(db, c.get("user").id, orgId, channelId);
      const rows = await channelMembersDetail(db, orgId, channelId);
      return c.json(
        {
          members: rows.map((m) =>
            m.agentId
              ? {
                  type: "agent" as const,
                  id: m.agentId,
                  name: m.agentName ?? "",
                  handle: m.agentHandle,
                  autoReply: m.autoReply,
                  joinedAt: m.joinedAt.toISOString(),
                }
              : {
                  type: "person" as const,
                  id: m.userId ?? "",
                  name: m.userName ?? "",
                  handle: null,
                  autoReply: null,
                  joinedAt: m.joinedAt.toISOString(),
                },
          ),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channels/{channelId}/pins",
      tags,
      security,
      summary: "Pinned messages of a channel or DM, newest pin first",
      request: { params: ChannelParams },
      responses: { 200: json(z.object({ pins: z.array(Pin) })), ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      return c.json({ pins: await listPins(db, c.get("user").id, orgId, channelId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels/{channelId}/pins/{messageId}",
      tags,
      security,
      summary: "Pin a message (anyone who can post here; pinning again keeps the first pin)",
      description:
        "Members of the channel or DM see `message.pinned`. At most 100 pins per conversation (`pins.limit`).",
      request: { params: PinParams },
      responses: { 200: json(Pin), ...errors },
    }),
    async (c) => {
      const { orgId, channelId, messageId } = c.req.valid("param");
      return c.json(await pinMessage({ db, pubsub: opts.pubsub }, c.get("user").id, orgId, channelId, messageId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/channels/{channelId}/pins/{messageId}",
      tags,
      security,
      summary: "Unpin a message (anyone who can post here)",
      description: "Members see `message.unpinned`. Not pinned: nothing changes.",
      request: { params: PinParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId, messageId } = c.req.valid("param");
      await unpinMessage({ db, pubsub: opts.pubsub }, c.get("user").id, orgId, channelId, messageId);
      return c.body(null, 204);
    },
  );

  return app;
}
