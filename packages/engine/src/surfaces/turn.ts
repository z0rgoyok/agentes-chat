import { and, desc, type Executor, eq, schema } from "@agenteschat/db";
import { ASK_CHOICES_TOOL, SHOW_BLOCK_TOOL, START_POLL_TOOL } from "../blocks";
import { actionLevel, nameWords } from "../connectors/classify";
import { MAX_HANDOFF_LINKS } from "../stretch";
import { ALWAYS_SENSITIVE } from "../tools/gateway";
import type { ToolContext, ToolDefinition } from "../tools/types";
import { surfaceOn } from "./config";
import { surfaceOfRun } from "./deliveries";

/**
 * What a surface turn (ADR 0187) may not do: the person reads it outside the app, where a card can't be answered
 * and nothing they confirm there is checked like a signed-in session.
 */

export type SurfaceRefusalClass =
  | "card"
  | "approval"
  | "sends_deletes_pays"
  | "roles_budgets_money"
  | "routine_elsewhere";

const CARD_TOOLS = new Set([
  SHOW_BLOCK_TOOL,
  START_POLL_TOOL,
  ASK_CHOICES_TOOL,
  "offer_connect_ai",
  "propose_agent",
  "propose_remove_agents",
  "offer_connect_app",
  "offer_invites",
  "offer_approvals",
  "propose_member_changes",
  "offer_open_page",
  "offer_answers",
  "offer_feedback",
  "offer_install_skill",
  "propose_team",
]);

/**
 * Built-ins that act only on the conversation or the agent's own settings, whatever words their names hold. Names, not
 * their modules' constants: those modules import the tool gateway, which imports this one.
 */
const OWN_ONLY = new Set([
  "send_gif",
  "send_sticker",
  "set_reply_style",
  "send_feedback",
  "request_permission",
  "update_plan",
]);

/** Built-ins that change agents, roles, budgets or the workspace with no such word in their names. */
const SETTINGS_TOOLS = new Set(["propose_settings_change", "propose_instruction_change"]);

/** `workspace_action`'s actions that touch only the person themself; `find` alone only looks. */
const OWN_WORKSPACE_ACTIONS = new Set(["set_my_status", "set_notifications", "set_my_timezone"]);

/** Built-ins that start work which runs later, apart from this turn, with the person's standing. */
const DEFERS = new Set(["run_routine_now"]);

const MONEY_AND_ROLES = new Set(
  "role roles member members permission permissions admin budget budgets billing plan subscription invoice payment price wallet".split(
    " ",
  ),
);

/** The first class the call falls in, or null. No database: the run is asked about only for a match. */
export function surfaceRefusalClass(
  tool: Pick<ToolDefinition, "name" | "scope" | "sensitive" | "actions">,
  input: Record<string, unknown>,
): SurfaceRefusalClass | null {
  if (CARD_TOOLS.has(tool.name)) return "card";
  // `unasked` is ignored on purpose: a surface turn never runs these, whoever would have approved them.
  if (
    tool.sensitive === true ||
    ALWAYS_SENSITIVE.test(tool.name) ||
    ALWAYS_SENSITIVE.test(tool.scope) ||
    tool.name === "schedule_action"
  ) {
    return "approval";
  }
  if (OWN_ONLY.has(tool.name)) return null;
  if (SETTINGS_TOOLS.has(tool.name)) return "roles_budgets_money";
  if (tool.name === "workspace_action") {
    const action = typeof input.action === "string" ? input.action : "";
    return action && !OWN_WORKSPACE_ACTIONS.has(action) ? "roles_budgets_money" : null;
  }
  if (DEFERS.has(tool.name) || (tool.name === "schedule_reminder" && input.ask_agent === true)) {
    return "routine_elsewhere";
  }
  // A tool that runs the actions its input names (a connector's executor) is judged by those actions.
  if (tool.actions) {
    const actions = tool.actions(input);
    if (!actions?.length) return "sends_deletes_pays";
    for (const action of actions) {
      if (actionLevel(action) === "sensitive" || ALWAYS_SENSITIVE.test(action)) return "sends_deletes_pays";
      if (nameWords(action).some((w) => MONEY_AND_ROLES.has(w))) return "roles_budgets_money";
    }
  }
  if (actionLevel(tool.name) === "sensitive") return "sends_deletes_pays";
  if (nameWords(tool.name).some((w) => MONEY_AND_ROLES.has(w))) return "roles_budgets_money";
  if (
    (tool.name === "create_routine" || tool.name === "update_routine") &&
    (input.channel !== undefined ||
      input.agent !== undefined ||
      (Array.isArray(input.own_actions) && input.own_actions.length > 0) ||
      (Array.isArray(input.keys) && input.keys.length > 0))
  ) {
    return "routine_elsewhere";
  }
  return null;
}

/**
 * The surface turn behind a run: its own, or the one of the run that asked or told it, up the chain of questions and
 * notes between agents. Work an agent was handed from a surface turn is held to the same refusals.
 */
async function surfaceTurnBehind(db: Executor, orgId: string, runId: string) {
  let current = runId;
  for (let depth = 0; depth <= MAX_HANDOFF_LINKS; depth++) {
    const turn = await surfaceOfRun(db, orgId, current);
    if (turn) return turn;
    const [asker] = await db
      .select({ runId: schema.agentConsultations.askerRunId })
      .from(schema.agentConsultations)
      .where(and(eq(schema.agentConsultations.orgId, orgId), eq(schema.agentConsultations.targetRunId, current)))
      .orderBy(desc(schema.agentConsultations.createdAt))
      .limit(1);
    if (!asker || asker.runId === current) return null;
    current = asker.runId;
  }
  return null;
}

/** The line the model reads instead of the result when a surface turn calls a tool of a refused class; else null. */
export async function surfaceRefusal(
  ctx: ToolContext,
  tool: Pick<ToolDefinition, "name" | "scope" | "sensitive" | "actions">,
  input: Record<string, unknown>,
): Promise<string | null> {
  const surface = surfaceOn();
  if (!surface || !surfaceRefusalClass(tool, input)) return null;
  const turn = await surfaceTurnBehind(ctx.db, ctx.orgId, ctx.runId);
  if (!turn) return null;
  const [person] = await ctx.db
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, turn.userId));
  const who = person?.name ?? "the person";
  return `This can't be done from ${surface.name}: tell ${who} in one line to do it in the agentes.chat app. Don't try another way.`;
}
