import { createContext, useContext } from "react";
import { isSafeId } from "../shared/logic";
import { createSplitStore, type SplitStore } from "../shared/split-store";

/**
 * Agentes in two panes (ADR 0212: the iPhone Duo's inner display, a large screen): the agent whose page stands beside
 * the list, kept per workspace (`split-store.ts`). With none chosen, the list's first agent is offered: its page shows,
 * but closing the device goes back to the list, never pushing a page the person didn't open. Pure but for the store and
 * its hooks, so the tests run it.
 */

/** The agent whose page stands beside Agentes' list, by its id. */
export const agentSplit: SplitStore<string> = createSplitStore((id: string) => id);

/** The Agents tab's name in the tabs' navigator (`(tabs)/_layout.tsx`). */
export const AGENTS_TAB = "agents";

/** How Agentes' list opens an agent's page while the split shows: beside it, in its pane, rather than pushed. */
export interface AgentOpener {
  orgId: string;
  open: (agentId: string) => void;
}

/** Given by the split around its list; none elsewhere, where an agent's page is pushed as always. */
export const AgentOpenerContext = createContext<AgentOpener | null>(null);

export const useAgentOpener = () => useContext(AgentOpenerContext);

/**
 * The agent's page pushed over the tabs when it is what shows: the main stack's `agent/[id]` route on top, as
 * expo-router's `useSegments` and `useGlobalSearchParams` give it. Null for anything else.
 */
export function pushedAgentOf(
  segments: readonly string[],
  params: Readonly<Record<string, string | string[] | undefined>>,
): string | null {
  const n = segments.length;
  if (n < 3 || segments[n - 1] !== "[id]" || segments[n - 2] !== "agent" || segments[n - 3] !== "(main)") return null;
  const { id } = params;
  return isSafeId(id) ? id : null;
}

/** The agent's page as the split pushes it when the device closes (`app/(app)/(main)/agent/[id].tsx`). */
export const agentHref = (id: string) => `/agent/${id}`;
