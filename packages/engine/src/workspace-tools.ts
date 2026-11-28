import { holdEvents, type PubSub } from "@agenteschat/adapters";
import { and, eq, isNull, schema, sql } from "@agenteschat/db";
import { type ActionRecord, actWithUndo } from "./agent-actions";
import { currentHandles } from "./agents";
import { invalidateOrg } from "./cache";
import { addChannelMember, channelNameIs, typedChannelName } from "./channels";
import { getChannelCached } from "./context";
import { updateChannel } from "./management";
import { personBehindCall } from "./requester";
import { replyThreadOf } from "./runs";
import { noAgentText } from "./team";
import { closeThread, getThread, updateThread } from "./threads";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

export const ADD_TO_CHANNEL_TOOL = "add_agent_to_channel";
export const SET_CHANNEL_LEAD_TOOL = "set_channel_lead";
export const UPDATE_THREAD_TOOL = "update_thread";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});

/** The person behind this run (`authority.ts`): null for a routine's work and for unattended runs. */
const requesterOf = (ctx: ToolContext): Promise<string | null> => personBehindCall(ctx);

const noRequester: ToolOutput = {
  content: "Only a person's request can change this; nothing was changed.",
  isError: true,
};

type NamedAgent = { id: string; name: string; handle: string };

/** An agent that isn't archived, by its handle (an old one still names it); what to tell the model when none. */
async function agentNamed(ctx: ToolContext, raw: string): Promise<NamedAgent | string> {
  const [handle = ""] = await currentHandles(ctx.db, ctx.orgId, [raw.trim().replace(/^@/, "").toLowerCase()]);
  const [agent] = await ctx.db
    .select({ id: schema.agents.id, name: schema.agents.name, handle: schema.agents.handle })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.orgId, ctx.orgId),
        isNull(schema.agents.archivedAt),
        sql`lower(${schema.agents.handle}) = ${handle}`,
      ),
    );
  return agent ?? (await noAgentText(ctx, [handle]));
}

/**
 * A regular channel that isn't archived, by name, or the run's own conversation when none is given; what to tell the
 * model when it isn't one (`here`: the run's conversation is a DM or a group).
 */
async function channelNamed(
  ctx: ToolContext,
  raw: unknown,
  here: string,
): Promise<{ id: string; name: string } | string> {
  const name = typedChannelName(str(raw));
  const { channels } = schema;
  const [channel] = name
    ? await ctx.db
        .select({ id: channels.id, name: channels.name, kind: channels.kind })
        .from(channels)
        .where(
          and(
            eq(channels.orgId, ctx.orgId),
            channelNameIs(name),
            eq(channels.kind, "channel"),
            isNull(channels.archivedAt),
          ),
        )
    : [await getChannelCached(ctx.db, ctx.orgId, ctx.channelId)];
  if (channel?.kind !== "channel") return name ? `No channel #${name}.` : here;
  return { id: channel.id, name: channel.name };
}

async function inChannel(ctx: ToolContext, channelId: string, agentId: string) {
  const { channelMembers } = schema;
  const [present] = await ctx.db
    .select({ id: channelMembers.id })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.agentId, agentId)));
  return Boolean(present);
}

/**
 * Organizing the workspace for the person who asked (ADR 0037 round 2), with
 * their rights: `add_agent_to_channel`, `set_channel_lead` (ADR 0095, the
 * channel's responsible agent) and `update_thread` (rename, close).
 * Internal and reversible, so no approval: each change is a receipt with
 * Undo on the reply.
 */
export function createWorkspaceToolSource(deps: { pubsub?: PubSub }): ToolSource {
  const tools: ToolDefinition[] = [
    {
      name: ADD_TO_CHANNEL_TOOL,
      description:
        "Add an agent (by handle, e.g. @lia) to a channel (by name; default: this one) when the person asks or the work needs it there. Works with the rights of the person who asked (the channel's creator or an admin, and the agent's owner or an admin). No permission needed: the person sees it with Undo.",
      scope: "",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", minLength: 1, maxLength: 100 },
          channel: { type: "string", maxLength: 100, description: "Channel name, with or without #" },
          auto_reply: {
            type: "boolean",
            description: "It may answer there without being mentioned (default true)",
          },
        },
        required: ["agent"],
        additionalProperties: false,
      },
      describe: (input) => ({ title: `Add ${str(input.agent)} to #${str(input.channel).replace(/^#/, "") || "here"}` }),
      async execute(input, ctx) {
        try {
          const requester = await requesterOf(ctx);
          if (!requester) return noRequester;
          const agent = await agentNamed(ctx, str(input.agent));
          if (typeof agent === "string") return { content: agent, isError: true };
          const channel = await channelNamed(ctx, input.channel, "Agents join channels, not this conversation.");
          if (typeof channel === "string") return { content: channel, isError: true };
          if (await inChannel(ctx, channel.id, agent.id))
            return { content: `@${agent.handle} is already in #${channel.name}.` };
          const autoReply = input.auto_reply !== false;
          const events = holdEvents(deps.pubsub);
          await actWithUndo(
            ctx,
            (db) => addChannelMember(db, requester, ctx.orgId, channel.id, { agentId: agent.id, autoReply }, events),
            () => ({
              kind: "channel.agent_added",
              target: { type: "channel", id: channel.id, title: channel.name },
              params: { agentId: agent.id, agentName: agent.name, agentHandle: agent.handle, channel: channel.name },
              before: null,
              after: { agentId: agent.id, autoReply },
            }),
          );
          // Cleared inside the transaction too: a run reading in between may have cached the channel as it was.
          invalidateOrg(ctx.orgId);
          await events.flush();
          return { content: `Added @${agent.handle} to #${channel.name}.` };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: SET_CHANNEL_LEAD_TOOL,
      description:
        "Make an agent (by handle; default: you) the one responsible for a channel (by name; default: this one) when a person asks: it answers what people say to the room for the team, and gets the turn when work another agent did for a person ends there. One per channel: it takes the place of the current one. `responsible: false` leaves the channel with none (naming `agent`, only if that one is responsible). The agent must be in the channel: add it first with add_agent_to_channel. Works with the rights of the person who asked (who may change the channel). No permission needed: the person sees it with Undo.",
      scope: "",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", maxLength: 100, description: "Its handle, e.g. @lia (default: you)" },
          channel: { type: "string", maxLength: 100, description: "Channel name, with or without #" },
          responsible: {
            type: "boolean",
            description: "false: the channel has no responsible agent anymore (default true)",
          },
        },
        additionalProperties: false,
      },
      describe: (input) => {
        const where = `#${str(input.channel).replace(/^#/, "") || "here"}`;
        if (input.responsible === false) return { title: `Leave ${where} with no responsible agent` };
        return { title: `Make ${str(input.agent) || "yourself"} responsible for ${where}` };
      },
      async execute(input, ctx) {
        try {
          const requester = await requesterOf(ctx);
          if (!requester) return noRequester;
          const channel = await channelNamed(
            ctx,
            input.channel,
            "Only a channel has a responsible agent, not this conversation.",
          );
          if (typeof channel === "string") return { content: channel, isError: true };
          const responsible = input.responsible !== false;
          const named = str(input.agent).trim();
          const { agents, channels } = schema;
          let agent: NamedAgent | null = null;
          if (named) {
            const found = await agentNamed(ctx, named);
            if (typeof found === "string") return { content: found, isError: true };
            agent = found;
          } else if (responsible) {
            const [self] = await ctx.db
              .select({ id: agents.id, name: agents.name, handle: agents.handle })
              .from(agents)
              .where(and(eq(agents.orgId, ctx.orgId), eq(agents.id, ctx.agentId)));
            if (!self) return { content: "You are not an agent of this workspace.", isError: true };
            agent = self;
          }
          // Read where it is written, never from the per-process cache: the lead may have changed a moment ago.
          const [row] = await ctx.db
            .select({ leadAgentId: channels.leadAgentId })
            .from(channels)
            .where(and(eq(channels.orgId, ctx.orgId), eq(channels.id, channel.id)));
          const current = row?.leadAgentId ?? null;
          const [previous] = current
            ? await ctx.db
                .select({ id: agents.id, name: agents.name, handle: agents.handle })
                .from(agents)
                .where(and(eq(agents.orgId, ctx.orgId), eq(agents.id, current)))
            : [];
          let next: NamedAgent | null;
          if (responsible) {
            if (!agent) return { content: "Say which agent.", isError: true };
            if (current === agent.id)
              return { content: `@${agent.handle} already is responsible for #${channel.name}.` };
            if (!(await inChannel(ctx, channel.id, agent.id))) {
              return {
                content: `@${agent.handle} isn't in #${channel.name}: add it first with add_agent_to_channel.`,
                isError: true,
              };
            }
            next = agent;
          } else {
            if (!current) return { content: `#${channel.name} has no responsible agent.` };
            if (agent && agent.id !== current) {
              const who = previous ? `@${previous.handle}` : "another agent";
              return { content: `${who} is responsible for #${channel.name}, not @${agent.handle}; nothing changed.` };
            }
            next = null;
          }
          const self = next?.id === ctx.agentId;
          const events = holdEvents(deps.pubsub);
          await actWithUndo(
            ctx,
            (db) => updateChannel(db, requester, ctx.orgId, channel.id, { leadAgentId: next?.id ?? null }, events),
            () => ({
              kind: "channel.lead_changed",
              target: { type: "channel", id: channel.id, title: channel.name },
              params: {
                channel: channel.name,
                agentId: next?.id ?? null,
                agentName: next?.name ?? null,
                agentHandle: next?.handle ?? null,
                self,
                previousAgentId: previous?.id ?? null,
                previousAgentName: previous?.name ?? null,
              },
              before: { leadAgentId: current },
              after: { leadAgentId: next?.id ?? null },
            }),
          );
          // Cleared inside the transaction too: a run reading in between may have cached the channel as it was.
          invalidateOrg(ctx.orgId);
          await events.flush();
          if (!next) return { content: `#${channel.name} has no responsible agent now.` };
          const instead = previous ? `, in place of @${previous.handle}` : "";
          return {
            content: self
              ? `You are now responsible for #${channel.name}${instead}.`
              : `@${next.handle} is now responsible for #${channel.name}${instead}.`,
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: UPDATE_THREAD_TOOL,
      description:
        "Rename this thread (`title`) or close it (`close: true`, when its work is done) for the person who asked, with their rights. No permission needed: the person sees it with Undo.",
      scope: "",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          close: { type: "boolean" },
        },
        additionalProperties: false,
      },
      describe: (input) => ({ title: input.close ? "Close this thread" : `Rename this thread to ${str(input.title)}` }),
      async execute(input, ctx) {
        try {
          const requester = await requesterOf(ctx);
          if (!requester) return noRequester;
          const title = str(input.title).trim();
          if (!title && input.close !== true) return { content: "Give a new `title` or `close: true`.", isError: true };
          if (replyThreadOf(ctx) === null) {
            return { content: "This conversation is not a thread.", isError: true };
          }
          const rootId = ctx.threadRootId;
          const done: string[] = [];
          await actWithUndo(
            ctx,
            async (db) => {
              const threadDeps = { db, pubsub: deps.pubsub };
              const before = await getThread(db, requester, ctx.orgId, rootId);
              const records: ActionRecord[] = [];
              if (title && title !== before.title) {
                const after = await updateThread(threadDeps, requester, ctx.orgId, rootId, { title });
                records.push({
                  kind: "thread.renamed",
                  target: { type: "thread", id: rootId, title: after.title ?? title },
                  params: { from: before.title ?? before.rootText, to: after.title ?? title },
                  before: { title: before.title },
                  after: { title: after.title },
                });
                done.push(`renamed to "${after.title ?? title}"`);
              }
              if (input.close === true && before.state === "open") {
                const after = await closeThread(threadDeps, requester, ctx.orgId, rootId);
                records.push({
                  kind: "thread.closed",
                  target: { type: "thread", id: rootId, title: after.title ?? after.rootText },
                  params: { title: after.title ?? after.rootText },
                  before: { state: before.state },
                  after: { state: "closed" },
                });
                done.push("closed");
              }
              return records;
            },
            (records) => records,
          );
          return { content: done.length ? `Thread ${done.join(" and ")}.` : "Nothing to change." };
        } catch (error) {
          return failed(error);
        }
      },
    },
  ];
  return { name: "workspace", tools: async () => tools };
}
