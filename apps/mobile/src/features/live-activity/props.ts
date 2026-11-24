/**
 * What the island shows, as the server sends it (ADR 0210): the Live Activity's `props`, a JSON string in the push's
 * `content-state`. Made and worded on the server; the layout (`AgentsActivity`) only draws it.
 */
export interface IslandProps {
  v: 1;
  /** "working": agents at work; "waiting": a request waits for the person; "done": nothing left. */
  tone: "working" | "waiting" | "done";
  /** The first line: an agent's name, "Iris pede aprovação", "2 trabalhando", "Pronto". */
  headline: string;
  /** What stands at the closed island's end instead of the first agent's timer; null: the timer. */
  trailing: string | null;
  /** Up to three, a request waiting first, then the most recent. */
  agents: {
    id: string;
    name: string;
    /** file:// path of its face in the widgets directory, or null. */
    face: string | null;
    /** What it is doing now, or the request in one line. */
    step: string;
    /** Since when (ms since the epoch): the system's timer counts from it. */
    since: number;
    state: "working" | "waiting" | "done";
    /** "#channel", a DM's name or the workspace. */
    where: string;
  }[];
  /** Agents working beyond the three shown. */
  more: number;
  /** Where a tap goes: agenteschat://island?org=…&channel=…[&thread=…][&message=…]. */
  url: string;
}

/** Where a tap on the island lands: the conversation (and its thread, and the message) it points at. */
export interface LiveActivityTarget {
  orgId: string;
  channelId: string;
  threadId: string | null;
  messageId: string | null;
}

/**
 * The island's link, read (`agenteschat://island?org=…&channel=…`, or the same without its scheme as expo-router may
 * hand it over); null for anything else, or one missing its workspace or conversation. By hand: React Native's URL has
 * no `searchParams.get`.
 */
export function liveActivityTargetOf(url: string): LiveActivityTarget | null {
  const match = /^(?:agenteschat:\/\/\/?)?\/?island\/?\?([^#]*)/.exec(url.trim());
  if (!match) return null;
  const query: Record<string, string> = {};
  for (const pair of (match[1] ?? "").split("&")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    try {
      query[decodeURIComponent(pair.slice(0, at))] = decodeURIComponent(pair.slice(at + 1));
    } catch {}
  }
  const orgId = query.org;
  const channelId = query.channel;
  if (!orgId || !channelId) return null;
  return { orgId, channelId, threadId: query.thread || null, messageId: query.message || null };
}

/** Where an agent's face is in the widgets directory: the path the server puts in `face` (ADR 0210). */
export const facePath = (dir: string, agentId: string) => `${dir.replace(/\/+$/, "")}/faces/${agentId}.png`;
