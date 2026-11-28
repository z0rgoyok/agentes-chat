import type { Channel } from "../api/types";

/**
 * A personal workspace's group conversations (ADR 0159, amendment of 2026-11-26), as the apps tell them from a server
 * of any age: a server that lists each channel's agents (`agentIds`) shows a group by its agents and takes its name as
 * written; an older one doesn't, and its groups stay channels with a # and a lower-case name.
 */

/** The agents a group conversation shows as its face: its first ones and how many in all; null from an older server. */
export function groupFaceOf(channel: Pick<Channel, "agentIds" | "agentCount">): {
  agentIds: string[];
  count: number;
} | null {
  if (!channel.agentIds) return null;
  return { agentIds: channel.agentIds, count: Math.max(channel.agentCount ?? 0, channel.agentIds.length) };
}

/** Whether the server keeps a group conversation's name as written: one that lists the channels' agents does. */
export const takesGroupNames = (channels: readonly Pick<Channel, "agentIds">[] | undefined) =>
  Boolean(channels?.some((c) => c.agentIds !== undefined));
