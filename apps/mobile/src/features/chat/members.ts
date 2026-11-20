/**
 * Where a channel's members are managed: screens pushed over the conversation (managing is a screen, never a sheet:
 * the native back, the edge swipe and the bar's title), each by the channel's id in its address.
 */
export const channelMembersHrefs = {
  /** Who is in the channel, from the conversation's pill or its "…". */
  list: (channelId: string) => `/channel-members?channelId=${encodeURIComponent(channelId)}` as const,
  /** Adding people and agents to it. */
  add: (channelId: string) => `/channel-members-add?channelId=${encodeURIComponent(channelId)}` as const,
  /** One agent in it: how it answers there, and taking it out. */
  agent: (channelId: string, agentId: string) =>
    `/channel-agent?channelId=${encodeURIComponent(channelId)}&agentId=${encodeURIComponent(agentId)}` as const,
};

/** The members' keys (`kind:id`) picked to add, as the server takes them. */
export function addTargets(selected: Iterable<string>): ({ agentId: string } | { userId: string })[] {
  return [...selected].map((key) => {
    const at = key.indexOf(":");
    const kind = key.slice(0, at);
    const id = key.slice(at + 1);
    return kind === "agent" ? { agentId: id } : { userId: id };
  });
}
