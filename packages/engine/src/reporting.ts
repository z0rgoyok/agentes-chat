import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, isNull, schema } from "@agenteschat/db";
import { managesAgent } from "./audience";
import { recordAudit } from "./audit";
import { invalidateOrg } from "./cache";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishAgentsChanged } from "./events";
import { requirePermission } from "./organizations";
import { forgetTeam } from "./team";

const { agents } = schema;

/**
 * "Responde a" (ADR 0148 addendum): an agent's line to the agent it reports to. It says where news goes by default and
 * who may always call whom (`inLine`); it grants nothing. Lodi stays out of it at either end: it reaches what each
 * person reaches already.
 */

/** Agents in one line, top to bottom: Lodi, then this many, then a specialist fit `MAX_CONSULTATION_CHAIN`. */
export const MAX_LINE_DEPTH = 3;

export interface ReportsToChange {
  agentId: string;
  reportsToAgentId: string | null;
}

interface LineRow {
  id: string;
  builtin: string | null;
  reportsToAgentId: string | null;
}

/**
 * Why `agentId` can't report to `to` given the lines in `rows` (null: it can). Refused: itself, Lodi at either end, an
 * agent not here, a loop, or a line deeper than `MAX_LINE_DEPTH` agents.
 */
export function lineRefusal(rows: ReadonlyMap<string, LineRow>, agentId: string, to: string | null): string | null {
  const agent = rows.get(agentId);
  if (!agent) return "That agent isn't in this workspace.";
  if (agent.builtin) return "The right hand reports to nobody: it works with each person directly.";
  if (to === null) return null;
  if (to === agentId) return "An agent can't report to itself.";
  const sup = rows.get(to);
  if (!sup) return "That supervisor isn't an agent of this workspace.";
  if (sup.builtin) return "Nobody reports to the right hand: it already reaches everyone each person reaches.";
  const above: string[] = [];
  for (let at: string | null = to; at; at = rows.get(at)?.reportsToAgentId ?? null) {
    if (at === agentId) return "That would make a loop: the supervisor already reports to this agent.";
    if (above.includes(at)) break;
    above.push(at);
  }
  const below = (id: string, seen: Set<string>): number => {
    let deepest = 0;
    for (const r of rows.values())
      if (r.reportsToAgentId === id && !seen.has(r.id))
        deepest = Math.max(deepest, below(r.id, new Set([...seen, r.id])));
    return deepest + 1;
  };
  if (above.length + below(agentId, new Set([agentId])) > MAX_LINE_DEPTH)
    return `A line holds at most ${MAX_LINE_DEPTH} agents, top to bottom.`;
  return null;
}

async function lineRows(db: Executor, orgId: string) {
  const rows = await db
    .select({ id: agents.id, builtin: agents.builtin, reportsToAgentId: agents.reportsToAgentId })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Why a line can't be set now, read from the database (the settings card's check). */
export async function reportsToRefusal(db: Executor, orgId: string, agentId: string, to: string | null) {
  return lineRefusal(await lineRows(db, orgId), agentId, to);
}

/**
 * Sets who each agent reports to, in order, as `actorId` (who manages each of them and each agent they put one under,
 * `managesAgent`), at once: each change is checked against the lines as the ones before it left them, and all apply
 * or none. Returns what they were, for Desfazer (the same call with `previous`). A setor's "Supervisor" is one call
 * with its agents.
 */
export async function setReportsTo(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  orgId: string,
  changes: ReportsToChange[],
): Promise<{ previous: ReportsToChange[] }> {
  const membership = await requirePermission(deps.db, actorId, orgId, "manage_agents");
  if (changes.length === 0) return { previous: [] };
  // Each agent whose line changes must be one this person manages (ADR 0085 addendum of 2026-11-17): the key alone
  // doesn't reach someone's private agent. Its new supervisor too, below: a line changes that agent as well.
  const ids = [...new Set(changes.map((c) => c.agentId))];
  const supervisorIds = changes.flatMap((c) => (c.reportsToAgentId ? [c.reportsToAgentId] : []));
  const reached = await deps.db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), inArray(agents.id, [...new Set([...ids, ...supervisorIds])])));
  for (const id of ids) {
    const agent = reached.find((a) => a.id === id);
    if (!agent) throw new NotFoundError("Agent not found");
    if (!managesAgent(agent, actorId, membership))
      throw new ForbiddenError("Only who manages the agent changes its line");
  }
  const previous = await deps.db.transaction(async (tx) => {
    const rows = await lineRows(tx, orgId);
    const before: ReportsToChange[] = [];
    for (const c of changes) {
      const row = rows.get(c.agentId);
      if (!row) throw new NotFoundError("Agent not found");
      const why = lineRefusal(rows, c.agentId, c.reportsToAgentId);
      if (why) throw new ValidationError(why, "agent.reports_to");
      if (row.reportsToAgentId === c.reportsToAgentId) continue;
      // Putting an agent under another changes that one too: its brakes no longer keep it from calling its new report
      // (`inLine`), its "# Your line" tells it to hand them work and it gets team_status. So only who manages the
      // supervisor puts others under it (ADR 0085 addendum of 2026-11-17); one that isn't here was refused just above.
      const supervisor = c.reportsToAgentId ? reached.find((a) => a.id === c.reportsToAgentId) : undefined;
      if (c.reportsToAgentId && !(supervisor && managesAgent(supervisor, actorId, membership)))
        throw new ForbiddenError("Only who manages an agent puts others under it");
      if (!before.some((b) => b.agentId === c.agentId))
        before.push({ agentId: c.agentId, reportsToAgentId: row.reportsToAgentId });
      rows.set(c.agentId, { ...row, reportsToAgentId: c.reportsToAgentId });
      await tx
        .update(agents)
        .set({ reportsToAgentId: c.reportsToAgentId, updatedAt: new Date() })
        .where(and(eq(agents.orgId, orgId), eq(agents.id, c.agentId)));
      await recordAudit(tx, {
        orgId,
        actor: { type: "person", id: actorId },
        action: "agent.reports_to_changed",
        target: { type: "agent", id: c.agentId },
        details: { from: row.reportsToAgentId, to: c.reportsToAgentId },
      });
    }
    return before;
  });
  if (previous.length > 0) {
    forgetTeam(orgId);
    invalidateOrg(orgId);
    await publishAgentsChanged(deps.pubsub, orgId);
  }
  return { previous };
}

/**
 * "# Your line" for an agent's context: who it reports to and who reports to it, always, past the team's cut
 * (`TEAM_IN_PROMPT`). Empty for an agent in no line, so most prompts don't grow.
 */
export function linePrompt(
  team: readonly { id: string; handle: string; role: string; reportsToAgentId?: string | null }[],
  selfId: string,
) {
  const self = team.find((a) => a.id === selfId);
  if (!self) return "";
  const up = self.reportsToAgentId ? team.find((a) => a.id === self.reportsToAgentId) : undefined;
  const reports = team.filter((a) => a.reportsToAgentId === selfId);
  if (!up && reports.length === 0) return "";
  const who = (a: { handle: string; role: string }) => `@${a.handle}${a.role ? ` (${a.role})` : ""}`;
  return [
    "# Your line",
    up
      ? `You report to ${who(up)}: tell it what it should know of your work, and when work stalls with nobody to ask (a routine), ask it with ask_agent.`
      : "",
    reports.length
      ? `These agents report to you: ${reports.map(who).join(", ")}. You may always ask them or hand them work; team_status shows what they are doing.`
      : "",
    "It says who to tell, never what anyone may do: approvals stay with people.",
  ]
    .filter(Boolean)
    .join("\n");
}
