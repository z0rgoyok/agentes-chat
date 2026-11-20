/** What "Nova missão" starts from: where it lives, the goal so far and who should do it. */
export interface NewMissionStart {
  channelId: string;
  /** The thread that becomes its home (else a new thread in the channel). */
  threadId?: string | null;
  goal?: string;
  /** The agent picked at first, when it can do one (the mission's, the conversation's only agent). */
  agentId?: string | null;
  /** The thread on screen: no navigation after creating when the mission lives there. */
  currentThreadId?: string | null;
}

/**
 * "Nova missão" / "Transformar em missão" as a screen pushed over the conversation (a form is a screen, never a sheet),
 * its start in the address: an old link or a missing channel lands on the home.
 */
export function newMissionHref(start: NewMissionStart): string {
  const params = new URLSearchParams({ channelId: start.channelId });
  if (start.threadId) params.set("threadId", start.threadId);
  if (start.goal?.trim()) params.set("goal", start.goal);
  if (start.agentId) params.set("agentId", start.agentId);
  if (start.currentThreadId) params.set("current", start.currentThreadId);
  return `/mission-new?${params.toString()}`;
}
