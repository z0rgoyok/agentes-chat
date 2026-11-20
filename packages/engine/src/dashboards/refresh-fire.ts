import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, isNotNull, isNull, or, schema, sql } from "@agenteschat/db";
import { getAgent } from "../agents";
import { type AiStatusDeps, backgroundAiState, rightHandWorkAi } from "../ai-status";
import type { ModelScope } from "../brains/select";
import { getMembership, type Membership } from "../organizations";
import { isRightHand, ownAiPerson, RIGHT_HAND } from "../right-hand";
import { waitModel } from "../task-manager";
import { mayContinuePause } from "../usage-pause";
import { dashboardRights, viewerOf } from "./access";
import { publishWidgetChanged, widgetEvent } from "./events";
import { holdWidgetForAi } from "./refresh-ledger";
import type { DashboardRow, WidgetStatus, WidgetWaitView } from "./types";

const { agentRuns, agents, dashboards, dashboardWidgets, routineRuns, routines } = schema;

/*
 * A widget routine as it fires (ADR 0135 §4, ADR 0053 §6): its widget and board must still be there, its creator
 * must still see the board, and its agent must have an AI to think with; then the widget shows it is being redone,
 * and what its run waits on, if anything. Kept apart from `refresh.ts` so `routines.ts` and the executor read it
 * without an import cycle.
 */

/** A widget's refresh run that waits, with what it waits on and who may let a pause go on (`mayContinueWidgetWait`). */
export interface WidgetRunWait extends WidgetWaitView {
  runId: string;
  waitId: string | null;
  orgId: string;
  agentId: string;
  triggerMessageId: string;
  ownerUserId: string | null;
  routineId: string;
  routineCreatorId: string | null;
}

const USAGE_CODES: readonly string[] = ["plan_limit", "budget", "usage_pause"];
const SCOPES: readonly string[] = ["model", "region", "off", "inactive"];

/**
 * What the open refresh runs of these widget routines wait on, by routine (none: at work, or not open). One query. The
 * head of a computer's line asking it for room (`running` with its computer kept) still waits for room.
 */
export async function widgetRunWaits(db: Executor, routineIds: readonly string[]): Promise<Map<string, WidgetRunWait>> {
  const out = new Map<string, WidgetRunWait>();
  if (routineIds.length === 0) return out;
  const wait = (field: string) =>
    sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>${sql.raw(`'${field}'`)}`;
  const rows = await db
    .select({
      routineId: routineRuns.routineId,
      routineCreatorId: routines.createdByUserId,
      runId: agentRuns.id,
      orgId: agentRuns.orgId,
      agentId: agentRuns.agentId,
      triggerMessageId: agentRuns.triggerMessageId,
      ownerUserId: agents.ownerUserId,
      status: agentRuns.status,
      machineId: agentRuns.waitingMachineId,
      code: wait("code"),
      source: wait("source"),
      resetsAt: wait("resetsAt"),
      waitId: wait("waitId"),
      scope: wait("scope"),
      plan: wait("plan"),
      model: wait("model"),
      roomSince: sql<string | null>`${agentRuns.transcript}->>'roomWaitSince'`,
      outageAt: sql<string | null>`${agentRuns.transcript}->'outage'->>'at'`,
    })
    .from(routineRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, routineRuns.agentRunId))
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(
      and(
        inArray(routineRuns.routineId, [...routineIds]),
        isNull(routineRuns.finishedAt),
        or(
          eq(agentRuns.status, "waiting_input"),
          and(eq(agentRuns.status, "running"), isNotNull(agentRuns.waitingMachineId)),
        ),
      ),
    );
  const at = (ms: string | null) => (ms && Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : null);
  for (const r of rows) {
    const usage = r.status === "waiting_input" && USAGE_CODES.includes(r.code ?? "");
    const scope = usage && r.code === "plan_limit" && SCOPES.includes(r.scope ?? "") ? (r.scope as ModelScope) : null;
    const base = { source: null, resetsAt: null, scope: null, model: null, since: null, canContinue: false };
    const view: WidgetWaitView | null = usage
      ? {
          ...base,
          code: r.code as "plan_limit" | "budget" | "usage_pause",
          source: r.code === "budget" || (r.code === "usage_pause" && r.source === "budget") ? "budget" : "plan",
          resetsAt: r.resetsAt,
          scope,
          model: scope ? waitModel({ scope, model: r.model, ...(r.plan ? { plan: r.plan } : {}) }) : null,
        }
      : r.machineId
        ? r.status === "running" || r.code === "busy"
          ? { ...base, code: "busy", since: at(r.roomSince) }
          : { ...base, code: "computer" }
        : !r.code && at(r.outageAt)
          ? { ...base, code: "outage", resetsAt: at(r.outageAt) }
          : null;
    if (view)
      out.set(r.routineId, {
        ...view,
        runId: r.runId,
        waitId: r.waitId,
        orgId: r.orgId,
        agentId: r.agentId,
        triggerMessageId: r.triggerMessageId,
        ownerUserId: r.ownerUserId,
        routineId: r.routineId,
        routineCreatorId: r.routineCreatorId,
      });
  }
  return out;
}

/** Whether `userId` may press Continue now on a widget's paused refresh: Continuar agora's people (`mayContinuePause`). */
export const mayContinueWidgetWait = (db: Executor, userId: string, membership: Membership, wait: WidgetRunWait) =>
  mayContinuePause(db, userId, membership, {
    run: { orgId: wait.orgId, agentId: wait.agentId, triggerMessageId: wait.triggerMessageId },
    // A routine's run is asked by its brief, its creator's: `mayStopRun` reads that message itself.
    requester: null,
    ownerUserId: wait.ownerUserId,
    routineId: wait.routineId,
    routineCreatorId: wait.routineCreatorId,
  });

/**
 * A widget's refresh run started or stopped waiting (its plan, its budget, its computer, its AI provider): the widget's
 * viewers read it again, so it says what holds it, or that it updates. Any other background run: nothing.
 */
export async function widgetRunWaitChanged(
  deps: { db: Database; pubsub?: PubSub },
  run: { id: string; orgId: string; background: boolean },
) {
  if (!run.background || !deps.pubsub) return;
  const [row] = await deps.db
    .select({ widget: dashboardWidgets, board: dashboards })
    .from(routineRuns)
    .innerJoin(dashboardWidgets, eq(dashboardWidgets.routineId, routineRuns.routineId))
    .innerJoin(dashboards, eq(dashboards.id, dashboardWidgets.dashboardId))
    .where(and(eq(routineRuns.orgId, run.orgId), eq(routineRuns.agentRunId, run.id)));
  if (!row) return;
  await publishWidgetChanged(deps.pubsub, row.board, widgetEvent(row.widget, row.widget.status as WidgetStatus));
}

/** A person's change request, as the routine run carries it (`routine_runs.event`). */
export const WIDGET_CHANGE_EVENT = "widget.change";

/**
 * Whether a routine run is a person's ask on a widget ("Ask for a change"): like a manual run, it goes ahead while a
 * person keeps the widget's routine paused on purpose (ADR 0135 §6); only the schedule waits.
 */
export function isWidgetChangeRun(run: { event?: Record<string, unknown> | null }): boolean {
  return run.event?.type === WIDGET_CHANGE_EVENT;
}

type FiringDeps = { db: Database; pubsub?: PubSub; ai?: Omit<AiStatusDeps, "db"> };

/** Who set a widget's work up, beyond its own row: `asker` of a change request, the creator its routine has now. */
type WidgetWorkPeople = { asker?: string | null; routineCreator?: string | null };

/**
 * The widget's agent and whether it has an AI to think with for its build (`noAi`: why, `AgentAi.reason`, null while
 * it has one or nothing can tell: no `ai`). A build is background work (`backgroundAiState`), as the run's own check
 * reads it. The right hand's thinks for a person (`person`, ADR 0137 §11): who asks this change, then who made the
 * widget or last wrote its instructions, then its routine's creator, the first of them still seeing its board whose
 * AI can think (`rightHandWorkAi`), else the workspace's for nobody (null). Null: no agent to build it.
 */
export async function widgetAi(
  deps: FiringDeps,
  widget: { orgId: string; agentId: string; createdByUserId: string | null; routineId: string | null },
  board: DashboardRow,
  who: WidgetWorkPeople = {},
) {
  const agent = await getAgent(deps.db, widget.orgId, widget.agentId);
  if (!agent || agent.archivedAt) return null;
  const ai = deps.ai ? { ...deps.ai, db: deps.db } : null;
  if (!isRightHand(agent)) {
    const state = ai ? await backgroundAiState(ai, agent) : null;
    return { agent, noAi: state?.state === "no_ai" ? { reason: state.reason ?? null } : null };
  }
  const [routine] =
    who.routineCreator === undefined && widget.routineId
      ? await deps.db
          .select({ creator: routines.createdByUserId })
          .from(routines)
          .where(and(eq(routines.orgId, widget.orgId), eq(routines.id, widget.routineId)))
      : [];
  const people: string[] = [];
  for (const id of new Set([who.asker, widget.createdByUserId, who.routineCreator ?? routine?.creator])) {
    const membership = id ? await getMembership(deps.db, id, widget.orgId) : null;
    if (id && membership && dashboardRights(board, viewerOf(membership, id)).see) people.push(id);
  }
  if (!ai) return { agent, person: await ownAiPerson(deps.db, widget.orgId, people), noAi: null };
  const picked = await rightHandWorkAi(ai, agent, people);
  return {
    agent,
    person: picked.person,
    noAi: picked.ai.state === "no_ai" ? { reason: picked.ai.reason ?? null } : null,
  };
}

/**
 * The right hand's widgets on boards `viewerId` sees that wait for an AI, or stopped after failing in a row, whose
 * build has one now (`widgetAi`): the apps start the waiting ones and offer Resolve on the stopped ones. Whose AI its
 * build thinks with is each widget's own people's, so the agent's state alone can't say it.
 */
export async function rightHandWidgetsReady(deps: FiringDeps, orgId: string, viewerId: string): Promise<string[]> {
  const membership = deps.ai ? await getMembership(deps.db, viewerId, orgId) : null;
  if (!membership) return [];
  const rows = await deps.db
    .select({ widget: dashboardWidgets, board: dashboards })
    .from(dashboardWidgets)
    .innerJoin(dashboards, eq(dashboards.id, dashboardWidgets.dashboardId))
    .innerJoin(agents, eq(agents.id, dashboardWidgets.agentId))
    .where(
      and(
        eq(dashboardWidgets.orgId, orgId),
        eq(dashboardWidgets.status, "failed"),
        inArray(dashboardWidgets.failureCode, ["missing_credential", "failing"]),
        eq(agents.builtin, RIGHT_HAND),
        isNull(dashboards.deletedAt),
      ),
    );
  const viewer = viewerOf(membership, viewerId);
  const ready: string[] = [];
  for (const { widget, board } of rows) {
    if (!dashboardRights(board, viewer).see) continue;
    const ai = await widgetAi(deps, widget, board);
    if (ai && !ai.noAi) ready.push(widget.id);
  }
  return ready;
}

export type WidgetFiring =
  /** `aiUserId`: whose AI the right hand's build thinks with (`widgetAi`), for its brief. */
  | { widget: { widgetId: string; dashboardId: string }; aiUserId?: string | null }
  /** The widget or its board is gone, or its agent has no AI (the widget says so, `holdWidgetForAi`): the slot passes. */
  | { skip: "deleted" | "no_ai" }
  /** Its creator no longer sees the board: the routine pauses, the widget says why. */
  | { pause: "creator_no_access" };

/**
 * Whether a widget routine's slot runs, for its creator (`creatorId`, whose `membership` it is). `asker`: who asked
 * the change this run carries.
 */
export async function widgetFiring(
  deps: FiringDeps,
  orgId: string,
  target: { widgetId: string; dashboardId: string },
  creatorId: string,
  membership: Membership,
  asker?: string | null,
): Promise<WidgetFiring> {
  const [row] = await deps.db
    .select({ widget: dashboardWidgets, board: dashboards })
    .from(dashboardWidgets)
    .innerJoin(dashboards, eq(dashboards.id, dashboardWidgets.dashboardId))
    .where(and(eq(dashboardWidgets.orgId, orgId), eq(dashboardWidgets.id, target.widgetId)));
  if (!row || row.board.deletedAt) return { skip: "deleted" };
  if (!dashboardRights(row.board, viewerOf(membership, creatorId)).see) return { pause: "creator_no_access" };
  const ai = await widgetAi(deps, row.widget, row.board, { asker, routineCreator: creatorId });
  if (ai?.noAi) {
    await holdWidgetForAi(deps, row.widget, row.board, ai.noAi.reason);
    return { skip: "no_ai" };
  }
  return {
    widget: { widgetId: row.widget.id, dashboardId: row.widget.dashboardId },
    ...(ai && "person" in ai ? { aiUserId: ai.person } : {}),
  };
}

/** The refresh starts: the widget is `updating` (its last data stays on screen), or `building` while it has none. */
export async function widgetRunStarting(deps: { db: Database; pubsub?: PubSub }, orgId: string, widgetId: string) {
  const [row] = await deps.db
    .update(dashboardWidgets)
    .set({
      status: sql`case when ${dashboardWidgets.spec} is null then 'building' else 'updating' end`,
      updatedAt: new Date(),
    })
    .where(and(eq(dashboardWidgets.orgId, orgId), eq(dashboardWidgets.id, widgetId)))
    .returning({
      id: dashboardWidgets.id,
      status: dashboardWidgets.status,
      dashboardId: dashboardWidgets.dashboardId,
      draft: dashboardWidgets.draft,
      createdByUserId: dashboardWidgets.createdByUserId,
    });
  if (!row) return;
  const [board] = await deps.db.select().from(dashboards).where(eq(dashboards.id, row.dashboardId));
  if (board) {
    await publishWidgetChanged(deps.pubsub, board, widgetEvent(row, row.status as WidgetStatus)).catch(() => {});
  }
}
