import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, isNull, like, not, schema } from "@agenteschat/db";
import { resolveNotifications } from "./notifications";
import { budgetPeriodOf } from "./usage";

/**
 * The `budget_paused` rows (`budget-pause.ts`) and what ends them. Apart from it so the agents' and workspace's settings
 * close them without loading the run's modules.
 */

const { agents, notifications } = schema;

/** One row per agent, month and budget: raised and paused again is news again. */
export const budgetPausedGroup = (agentId: string, period: string, budget: number) =>
  `budget_paused:${agentId}:${period}:${budget}`;
const agentPrefix = (agentId: string) => `budget_paused:${agentId}:`;

/** The agents' budgets changed: their `budget_paused` rows are done (one that still pauses tells again, as news). */
export async function resolveBudgetPaused(deps: { db: Database; pubsub?: PubSub }, orgId: string, agentIds: string[]) {
  for (const id of agentIds) await resolveNotifications(deps, orgId, { groupKeyPrefix: agentPrefix(id) });
}

/** The agents on the workspace's default budget, whose rows a change of that default ends. */
export async function resolveDefaultBudgetPaused(deps: { db: Database; pubsub?: PubSub }, orgId: string) {
  const onDefault = await deps.db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.monthlyBudgetNanoUsd)));
  await resolveBudgetPaused(
    deps,
    orgId,
    onDefault.map((a) => a.id),
  );
}

/** Back at work after a budget wait: rows of an earlier month are done (the budget renewed). */
export async function resolveEarlierBudgetPaused(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  agentId: string,
) {
  const old = await deps.db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.orgId, orgId),
        isNull(notifications.doneAt),
        like(notifications.groupKey, `${agentPrefix(agentId)}%`),
        not(like(notifications.groupKey, `${agentPrefix(agentId)}${budgetPeriodOf(new Date())}:%`)),
      ),
    );
  if (old.length) await resolveNotifications(deps, orgId, { ids: old.map((r) => r.id) });
}
