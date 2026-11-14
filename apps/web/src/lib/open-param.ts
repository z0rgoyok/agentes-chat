import { type AgentTab, isAgentTab } from "@agenteschat/client/lib/agent-edit";
import { projectFilterOf } from "@agenteschat/client/lib/issue-projects";
import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

/**
 * The item a list page has open in its details dialog, kept in the URL
 * (`?open=…`) so a reload, a shared link or Back reopens it. Replaces the
 * history entry: opening and closing details isn't a page of its own.
 * Numbers (an issue's) go as numbers, so the URL reads `?open=6`.
 * `aliases`: older names the route reads as this one; they go with it.
 */
export function useOpenParam(
  name = "open",
  aliases: readonly string[] = [],
): [string | null, (value: string | number | null) => void] {
  const value = useRouterState({
    select: (s) => {
      const v = (s.location.search as Record<string, unknown>)[name];
      return v === undefined || v === null || v === "" ? null : String(v);
    },
  });
  const navigate = useNavigate();
  const set = useCallback(
    (next: string | number | null) =>
      void navigate({
        to: ".",
        replace: true,
        search: ((prev: Record<string, unknown>) => {
          const out = { ...prev };
          for (const alias of aliases) delete out[alias];
          if (next === null) delete out[name];
          else out[name] = next;
          return out;
        }) as never,
      }),
    [navigate, name, aliases],
  );
  return [value, set];
}

/**
 * `validateSearch` for a page with an open item. A number (an issue's) stays a
 * number: the router JSON-quotes a string that reads as one (`?open=%22131%22`),
 * so a digits-only string becomes a number too. Anything else stays a string.
 */
export function openSearch(search: Record<string, unknown>): { open?: string | number } {
  const v = search.open;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? { open: v } : {};
  if (typeof v !== "string" || !v) return {};
  return /^\d{1,15}$/.test(v) ? { open: Number(v) } : { open: v };
}

/** `validateSearch` for the tasks' pages: the open task, and `m`, a message of its conversation to open at. */
export function taskSearch(search: Record<string, unknown>): { open?: string | number; m?: string } {
  const m = typeof search.m === "string" && search.m ? { m: search.m } : {};
  return { ...openSearch(search), ...m };
}

/** `validateSearch` for the board: a task's, and `project`, the project whose board it is (`none`: tasks with none). */
export function boardSearch(search: Record<string, unknown>): ReturnType<typeof taskSearch> & { project?: string } {
  const project = projectFilterOf(search.project);
  return { ...taskSearch(search), ...(project ? { project } : {}) };
}

/** The thread open in the panel beside a conversation: `reply` puts the focus in its composer, `focus` opens at a message. */
export interface ThreadPanel {
  id: string;
  reply: boolean;
  focus?: string;
}

/** `validateSearch` for a conversation: the thread in its panel, its `reply` and `tm` (the panel's own `?m=`). */
export function threadSearch(search: Record<string, unknown>): { thread?: string; reply?: true; tm?: string } {
  if (typeof search.thread !== "string" || !search.thread) return {};
  return {
    thread: search.thread,
    ...(search.reply === true || search.reply === "true" ? { reply: true as const } : {}),
    ...(typeof search.tm === "string" && search.tm ? { tm: search.tm } : {}),
  };
}

/**
 * The thread in a conversation's panel, kept in the URL (`?thread=…`) so a reload, a shared link and Back and Forward
 * keep it. Unlike `useOpenParam` each change is a history entry, so Back closes what was just opened; `replace` is for
 * a thread found gone, which leaves nothing to come back to. One panel at a time: a thread takes the agent's page out.
 * `enabled` false (a thread view, which holds no panel of its own but shares the URL with the conversation beside it):
 * always empty.
 */
export function useThreadPanel(
  enabled: boolean,
): [ThreadPanel | null, (next: ThreadPanel | null, how?: { replace?: boolean }) => void] {
  const search = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>;
  const router = useRouter();
  const navigate = useNavigate();
  const panel = useMemo<ThreadPanel | null>(() => {
    const { thread, reply, tm } = threadSearch(search);
    return enabled && thread ? { id: thread, reply: Boolean(reply), ...(tm ? { focus: tm } : {}) } : null;
  }, [enabled, search]);
  const set = useCallback(
    (next: ThreadPanel | null, how?: { replace?: boolean }) => {
      if (!enabled) return;
      if (!next && !threadSearch(router.state.location.search as Record<string, unknown>).thread) return;
      void navigate({
        to: ".",
        replace: how?.replace,
        search: ((prev: Record<string, unknown>) => {
          const { thread: _thread, reply: _reply, tm: _tm, ...rest } = prev;
          if (!next) return rest;
          return {
            ...withoutAgentPanel(rest),
            thread: next.id,
            ...(next.reply ? { reply: true } : {}),
            ...(next.focus ? { tm: next.focus } : {}),
          };
        }) as never,
      });
    },
    [enabled, navigate, router],
  );
  return [panel, set];
}

/** The agent's page open in the panel beside a conversation, at one of its tabs (none: Visão geral). */
export interface AgentPanelPlace {
  agentId: string;
  tab?: AgentTab;
}

/** `validateSearch` for a conversation: the agent whose page is in its panel (`agent`) and that page's tab (`agentTab`). */
export function agentPanelSearch(search: Record<string, unknown>): { agent?: string; agentTab?: AgentTab } {
  if (typeof search.agent !== "string" || !search.agent) return {};
  return { agent: search.agent, ...(isAgentTab(search.agentTab) ? { agentTab: search.agentTab } : {}) };
}

function withoutAgentPanel(search: Record<string, unknown>) {
  const { agent: _agent, agentTab: _tab, ...rest } = search;
  return rest;
}

/**
 * The agent's page in a conversation's panel, kept in the URL (`?agent=…&agentTab=…`) as `useThreadPanel` keeps a
 * thread: opening and closing it are history entries, so Back closes it and Back after another page brings it back;
 * `replace` is for a tab picked inside it. Opening it takes the thread out. `enabled` false (a conversation inside a
 * panel, sharing the URL with the one beside it): always empty.
 */
export function useAgentPanel(
  enabled: boolean,
): [AgentPanelPlace | null, (next: AgentPanelPlace | null, how?: { replace?: boolean }) => void] {
  const search = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>;
  const router = useRouter();
  const navigate = useNavigate();
  const place = useMemo<AgentPanelPlace | null>(() => {
    const { agent, agentTab } = agentPanelSearch(search);
    return enabled && agent ? { agentId: agent, ...(agentTab ? { tab: agentTab } : {}) } : null;
  }, [enabled, search]);
  const set = useCallback(
    (next: AgentPanelPlace | null, how?: { replace?: boolean }) => {
      if (!enabled) return;
      if (!next && !agentPanelSearch(router.state.location.search as Record<string, unknown>).agent) return;
      void navigate({
        to: ".",
        replace: how?.replace,
        search: ((prev: Record<string, unknown>) => {
          const rest = withoutAgentPanel(prev);
          if (!next) return rest;
          const { thread: _thread, reply: _reply, tm: _tm, ...others } = rest;
          return {
            ...others,
            agent: next.agentId,
            ...(next.tab && next.tab !== "overview" ? { agentTab: next.tab } : {}),
          };
        }) as never,
      });
    },
    [enabled, navigate, router],
  );
  return [place, set];
}
