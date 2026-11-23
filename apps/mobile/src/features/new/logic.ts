import type { Agent } from "@agenteschat/client";
import { can, makesAgents } from "@agenteschat/client/lib/permissions";
import type { ConversationRow } from "../chats/logic";
import { matches } from "../search/logic";

/**
 * The pure part of "New" (the "+" of the tabs): the agents in its row, who its search finds, what its "Create" list
 * offers, and the name suggested for a new agent.
 */

/**
 * The agents in "New"'s row, the one you talked to last first: agents with a direct conversation, newest first, then
 * the rest by name. Agents that don't talk to you are left out.
 */
export function askTargets(agents: readonly Agent[], rows: readonly ConversationRow[]): Agent[] {
  const talkable = agents.filter((a) => a.canTalk !== false);
  const lastAt = new Map<string, string>();
  for (const r of rows) {
    if (r.kind !== "dm" || r.with.type !== "agent" || !r.at) continue;
    const prev = lastAt.get(r.with.id);
    if (!prev || r.at > prev) lastAt.set(r.with.id, r.at);
  }
  return [...talkable].sort((a, b) => {
    const ta = lastAt.get(a.id);
    const tb = lastAt.get(b.id);
    if (ta && tb) return tb.localeCompare(ta);
    if (ta) return -1;
    if (tb) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Who a conversation can start with, for the words typed ("Chat with…", in "New" and in its own sheet): the agents
 * that talk to you (by name, role or handle) and the other people (by name), each by name. No words: everyone.
 */
export function chatMatches<P extends { userId: string; name: string }>(
  q: string,
  agents: readonly Agent[],
  people: Iterable<P>,
  meId: string | null | undefined,
): { agents: Agent[]; people: P[] } {
  return {
    agents: agents
      .filter((a) => a.canTalk !== false && matches(q, a.name, a.role, a.handle))
      .sort((a, b) => a.name.localeCompare(b.name)),
    people: [...people]
      .filter((p) => p.userId !== meId && matches(q, p.name))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * What "New" offers to start, in its order; `invite` is a list of its own at the end. A conversation is not here:
 * the search on top already starts one.
 */
export type CreateItem =
  | "agent"
  | "channel"
  | "task"
  | "routine"
  | "wiki"
  | "spreadsheet"
  | "slides"
  | "canvas"
  | "invite";

const CREATE_ORDER: readonly CreateItem[] = [
  "agent",
  "channel",
  "task",
  "routine",
  "wiki",
  "spreadsheet",
  "slides",
  "canvas",
  "invite",
];

/**
 * Whether this person may start `item`, as the server checks it (ADR 0085): an agent (`create_agents`, and none while
 * the workspace is being deleted, as on the web), a channel (`create_channels`), a task (`post`), a routine (some agent
 * they may make one for, `createsRoutines`: the agents' `createsRoutinesFor`, who set up its routines, which "Create
 * routines" gives only where it reaches, and whom it answers, since a routine asks it on its creator's behalf; ADR 0085
 * addendum of 2026-11-17), a wiki page (`edit_wiki`), a spreadsheet, a presentation or a canvas in the Drive
 * (`upload_files`, as any file there, ADR 0196) and invitations (`invite_people`).
 */
export function mayCreate(
  org: { permissions?: readonly string[]; deletion?: unknown } | null | undefined,
  item: CreateItem,
  { createsRoutines = false }: { createsRoutines?: boolean } = {},
): boolean {
  const allowed: Record<CreateItem, boolean> = {
    agent: makesAgents(org),
    channel: can(org, "create_channels"),
    task: can(org, "post"),
    routine: createsRoutines,
    wiki: can(org, "edit_wiki"),
    spreadsheet: can(org, "upload_files"),
    slides: can(org, "upload_files"),
    canvas: can(org, "upload_files"),
    invite: can(org, "invite_people"),
  };
  return allowed[item];
}

/** What this person may start from "New". */
export function createItems(
  org: { permissions?: readonly string[]; deletion?: unknown } | null | undefined,
  { createsRoutines }: { createsRoutines: boolean },
): CreateItem[] {
  return CREATE_ORDER.filter((item) => mayCreate(org, item, { createsRoutines }));
}

/** Names offered for a new agent (short, friendly, easy to call). */
export const AGENT_NAMES = ["Lu", "Nina", "Theo", "Iris", "Ada", "Otto", "Clara", "Bento", "Dora", "Rui"] as const;

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();

/** The name suggested for a new agent: the first of `pool` nobody uses yet, else the first with a number. */
export function suggestAgentName(taken: readonly string[], pool: readonly string[] = AGENT_NAMES): string {
  const used = new Set(taken.map(fold));
  const free = pool.find((n) => !used.has(fold(n)));
  if (free) return free;
  const base = pool[0] ?? "Agente";
  for (let i = 2; ; i++) if (!used.has(fold(`${base} ${i}`))) return `${base} ${i}`;
}
