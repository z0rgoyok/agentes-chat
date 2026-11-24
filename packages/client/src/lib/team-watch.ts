import type { TFunction } from "i18next";
import type { AgentStatus, AppNotification } from "../api/types";
import { namesText } from "./format";
import { teamWatchOf } from "./notifications";

/**
 * What the right hand found wrong (ADR 0177 §1), in the reader's language: the notice's headline, its names as a list
 * in words ("Slack, Notion e mais 1 precisam ser reconectados."). A cause this build doesn't know keeps the server's
 * own sentence. Null for any other notice.
 */
export function teamWatchLine(t: TFunction, n: Pick<AppNotification, "kind" | "count" | "latest">): string | null {
  const found = teamWatchOf(n);
  if (!found) return null;
  if (!found.key) return found.text;
  const say = t as unknown as (key: string, values: Record<string, unknown>) => string;
  return say(found.key, {
    names: namesText(t, found.names, found.names.length, found.count),
    count: found.count,
    defaultValue: found.text,
  });
}

/** The agents whose work waits on their monthly budget now, as the agents' statuses say: the team-stalled line's. */
export const budgetPausedIds = (statuses: Pick<AgentStatus, "agentId" | "budgetPaused">[] | undefined) =>
  (statuses ?? []).filter((s) => s.budgetPaused).map((s) => s.agentId);

/** The team-stalled line's sentence: who is out of budget, their names as a list in words. */
export function budgetStalledText(t: TFunction, names: string[]) {
  const say = t as unknown as (key: string, values: Record<string, unknown>) => string;
  return say("notifications.teamWatch.budget_out", { names: namesText(t, names, 3), count: names.length });
}
