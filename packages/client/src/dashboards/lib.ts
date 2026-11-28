import type { TFunction } from "i18next";
import type { AiStatus } from "../api/types";
import { activityVerb, toolActivity } from "../lib/activity";
import { capitalize } from "../lib/format";
import { modelLimitWords, usageWhen } from "../lib/plan-usage";
import { waitFix } from "../lib/usage-pause";
import type {
  DashboardAudience,
  DashboardEditPolicy,
  DashboardKind,
  DashboardLayoutInput,
  DashboardSummary,
  HomeTile,
  Widget,
  WidgetCostEstimate,
  WidgetFailure,
  WidgetSchedule,
  WidgetStatus,
  WidgetStep,
  WidgetWait,
} from "./types";

/**
 * What the web and the phone share about boards (ADR 0135), without React: the list's groups, who has access in
 * Share, a board's order of widgets and tiles, Organize's moves, a failure's and a wait's words and the cost line.
 */

/**
 * A board as the person may change it: as its `canEdit` and `canManage` say, and not at all while the workspace is
 * being deleted (ADR 0088 §7), so no way into a change shows.
 */
export const frozenBoard = <B extends Pick<DashboardSummary, "canEdit" | "canManage">>(
  board: B,
  org: { deletion?: unknown } | null | undefined,
): B => (org?.deletion ? { ...board, canEdit: false, canManage: false } : board);

const byOrder = (a: DashboardSummary, b: DashboardSummary) =>
  Number(b.pinned) - Number(a.pinned) || a.position - b.position || a.title.localeCompare(b.title);

/** The Dashboards list: the workspace's, the viewer's roles', and only theirs; pinned first, then by position. */
export function dashboardGroups(list: readonly DashboardSummary[]): {
  workspace: DashboardSummary[];
  roles: DashboardSummary[];
  mine: DashboardSummary[];
} {
  const boards = list.filter((d) => d.kind === "board").sort(byOrder);
  return {
    workspace: boards.filter((d) => d.audience === "workspace"),
    roles: boards.filter((d) => d.audience === "roles"),
    mine: boards.filter((d) => d.audience === "private"),
  };
}

export type DashboardAccess = "edits" | "sees" | "none";

/**
 * What one person may do on a board with this audience (Share's "Who has access"), by the same rule as the server:
 * its owner edits; admins see every board but private ones and edit what they see; others see a `workspace` board,
 * or a `roles` one when they hold one of its roles, and edit it when `viewers` edit or, with `roles`, when they hold
 * one of its edit roles (seeing comes first).
 */
export function dashboardAccessOf(
  person: { userId: string; roleIds: readonly string[]; admin: boolean },
  board: {
    kind: DashboardKind;
    audience: DashboardAudience;
    roleIds: readonly string[];
    editPolicy: DashboardEditPolicy;
    editRoleIds?: readonly string[];
    ownerUserId: string | null;
  },
): DashboardAccess {
  if (board.ownerUserId === person.userId) return "edits";
  if (board.kind === "home" || board.audience === "private") return "none";
  const sees =
    board.audience === "workspace" || person.admin || board.roleIds.some((id) => person.roleIds.includes(id));
  if (!sees) return "none";
  if (person.admin || board.editPolicy === "viewers") return "edits";
  const byRole = board.editPolicy === "roles" && (board.editRoleIds ?? []).some((id) => person.roleIds.includes(id));
  return byRole ? "edits" : "sees";
}

// ── Who edits ────────────────────────────────────────────────────────────────

/** Who edits a board as New dashboard and Share draft it: the policy and, with `roles`, the roles. */
export interface DashboardEditors {
  editPolicy: DashboardEditPolicy;
  editRoleIds: string[];
}

/**
 * Whether the holders of a role see a board with this audience: only they can edit it through that role (editing
 * isn't seeing, ADR 0135 §8), so "Who edits" offers the others disabled.
 */
export function roleSeesBoard(
  board: { audience: DashboardAudience; roleIds: readonly string[] },
  roleId: string,
): boolean {
  return board.audience === "workspace" || (board.audience === "roles" && board.roleIds.includes(roleId));
}

/** Who edits once these roles are picked: `roles` with them, or `owner` (you and admins) when none is left. */
export function withEditRoles<T extends DashboardEditors>(draft: T, roleIds: readonly string[]): T {
  const ids = [...new Set(roleIds)];
  return ids.length > 0
    ? { ...draft, editPolicy: "roles", editRoleIds: ids }
    : { ...draft, editPolicy: "owner", editRoleIds: [] };
}

/** A role checked or unchecked in "Who edits" (checking one while `viewers` or `owner` starts the roles' list). */
export function toggleEditRole<T extends DashboardEditors>(draft: T, roleId: string): T {
  const now = draft.editPolicy === "roles" ? draft.editRoleIds : [];
  return withEditRoles(draft, now.includes(roleId) ? now.filter((id) => id !== roleId) : [...now, roleId]);
}

/**
 * The draft after "Who sees" changed: edit roles whose holders no longer see the board are dropped, and with none
 * left it is edited by you and admins (`owner`), never by more people than before.
 */
export function fitEditRoles<T extends DashboardEditors & { audience: DashboardAudience; roleIds: string[] }>(
  draft: T,
): T {
  if (draft.editPolicy !== "roles") return draft;
  const kept = draft.editRoleIds.filter((id) => roleSeesBoard(draft, id));
  return kept.length === draft.editRoleIds.length ? draft : withEditRoles(draft, kept);
}

/** What New dashboard and Share send for who edits: the roles only with `roles`. */
export function editorsInput(draft: DashboardEditors): DashboardEditors {
  return { editPolicy: draft.editPolicy, editRoleIds: draft.editPolicy === "roles" ? draft.editRoleIds : [] };
}

/** "Who edits" in a few words, as the web's dropdown and the phone's row show it. */
export type EditorsSummary = { kind: "viewers" } | { kind: "owner" } | { kind: "roles"; names: string[] };

/** The summary of who edits; roles gone from the workspace are left out (none left reads as `owner`). */
export function editorsSummary(
  draft: DashboardEditors,
  roles: readonly { id: string; name: string }[],
): EditorsSummary {
  if (draft.editPolicy === "viewers") return { kind: "viewers" };
  const names = roles.filter((r) => draft.editRoleIds.includes(r.id)).map((r) => r.name);
  if (draft.editPolicy !== "roles" || names.length === 0) return { kind: "owner" };
  return { kind: "roles", names };
}

/** The summary as text: "Everyone who sees it", "Only you and admins", "Sales", "Sales and Board" or "3 roles". */
export function editorsText(t: TFunction, summary: EditorsSummary): string {
  if (summary.kind !== "roles") return t(`dashboards.edit.${summary.kind}`);
  const [first = "", second = ""] = summary.names;
  if (summary.names.length === 1) return first;
  if (summary.names.length === 2) return t("dashboards.edit.twoRoles", { first, second });
  return t("dashboards.edit.manyRoles", { count: summary.names.length });
}

/** One cell of a board: a widget, or a home board's fixed tile. */
export type BoardItem =
  | { type: "widget"; id: string; position: number; w: 1 | 2; h: 1 | 2; widget: Widget }
  | { type: "tile"; id: HomeTile["key"]; position: number; w: 1 | 2; h: 1 | 2; tile: HomeTile };

/** A board's widgets and tiles in their order (a tile first on a tie). */
export function boardItems(widgets: readonly Widget[], tiles: readonly HomeTile[] = []): BoardItem[] {
  const items: BoardItem[] = [
    ...tiles.map((tile) => ({
      type: "tile" as const,
      id: tile.key,
      position: tile.position,
      w: tile.w,
      h: tile.h,
      tile,
    })),
    ...widgets.map((widget) => ({
      type: "widget" as const,
      id: widget.id,
      position: widget.layout.position,
      w: widget.layout.w,
      h: widget.layout.h,
      widget,
    })),
  ];
  return items.sort((a, b) => a.position - b.position || (a.type === b.type ? 0 : a.type === "tile" ? -1 : 1));
}

/** `items` with `id` moved to where `targetId` is (before it, or after it when moving down); else the same order. */
export function moveItem<T extends { id: string }>(items: readonly T[], id: string, targetId: string): T[] {
  const from = items.findIndex((x) => x.id === id);
  const to = items.findIndex((x) => x.id === targetId);
  if (from < 0 || to < 0 || from === to) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
}

/** `items` with one resized. */
export function resizeItem<T extends { id: string; w: 1 | 2; h: 1 | 2 }>(
  items: readonly T[],
  id: string,
  size: { w: 1 | 2; h: 1 | 2 },
): T[] {
  return items.map((x) => (x.id === id ? { ...x, w: size.w, h: size.h } : x));
}

/** What "Done" in Organize saves: positions 0, 1, 2… in the order shown, and each size. */
export function layoutOf(items: readonly BoardItem[]): DashboardLayoutInput {
  const widgets: DashboardLayoutInput["widgets"] = [];
  const tiles: HomeTile[] = [];
  items.forEach((item, position) => {
    if (item.type === "tile") tiles.push({ key: item.id, position, w: item.w, h: item.h });
    else widgets.push({ id: item.id, position, w: item.w, h: item.h });
  });
  return tiles.length ? { widgets, tiles } : { widgets };
}

/** Failure codes with words of their own under `widgets.failure.*`; any other reads as `error`. */
export const WIDGET_FAILURE_CODES = [
  "agent_reported",
  "no_update",
  "error",
  "budget_exceeded",
  "waiting_computer",
  "waiting_plan",
  "waiting_budget",
  "creator_left",
  "creator_no_access",
  "agent_archived",
  "audience",
  "failing",
  "stopped",
  "missing_credential",
  "timeout",
  "invalid_data",
] as const;
export type WidgetFailureCode = (typeof WIDGET_FAILURE_CODES)[number];

/**
 * Why a widget's agent has no AI for its build (`missing_credential`'s detail, `AgentAi.reason`) in words: a widget's
 * own, else the right hand's plan line (that plan never waits, so its computer away or its limit is no AI either,
 * ADR 0137 §7). `no_key`, and any other, keep the code's words.
 */
const NEEDS_AI_WORDS = {
  not_signed_in: "widgets.needsAi.not_signed_in",
  no_computer: "widgets.needsAi.no_computer",
  cli_missing: "widgets.needsAi.cli_missing",
  plan_not_shared: "widgets.needsAi.plan_not_shared",
  // Its run's word for the same: no person is behind a build.
  plan_unattended: "widgets.needsAi.plan_not_shared",
  // Whoever set it up has no plan that serves them: for a build, the same plan kept to its owner.
  plans_not_yours: "widgets.needsAi.plan_not_shared",
  computer_away: "widgets.failure.waiting_computer",
  plan_limit: "widgets.failure.waiting_plan",
  model_limit: "widgets.failure.waiting_plan",
  commands_off: "noAi.rightHand.commands_off",
  runner_outdated: "noAi.rightHand.runner_outdated",
  computer_failed: "noAi.rightHand.computer_failed",
  cli_failed: "noAi.rightHand.cli_failed",
  plan_tools: "noAi.rightHand.plan_tools",
} as const;

/**
 * The key of a failure's words: `widgets.failure.*` by its code, or the reason a widget waits for an AI (`detail`,
 * `NEEDS_AI_WORDS`). `agent_reported` shows the agent's own words instead.
 */
export function widgetFailureKey(code: string, detail?: string | null) {
  if (code === "missing_credential" && detail && Object.hasOwn(NEEDS_AI_WORDS, detail))
    return NEEDS_AI_WORDS[detail as keyof typeof NEEDS_AI_WORDS];
  const known = (WIDGET_FAILURE_CODES as readonly string[]).includes(code) ? (code as WidgetFailureCode) : "error";
  return `widgets.failure.${known}` as const;
}

/** What a failure is about: for a widget that stopped after failing in a row, the last of those failures. */
export const widgetFailureCause = (f: WidgetFailure): WidgetFailure =>
  f.code === "failing" && f.cause && f.cause !== "failing" ? { code: f.cause, detail: f.detail } : f;

/**
 * Why a widget stopped updating, in the reader's words (the agent's own when it said why). One that stopped after
 * failing in a row says so, then the last failure's words.
 */
export function widgetFailureText(t: TFunction, failure: WidgetFailure | null, name: string): string {
  if (!failure) return t("widgets.failure.error");
  const last = widgetFailureCause(failure);
  if (last !== failure) return t("widgets.failure.failingLast", { cause: widgetFailureText(t, last, name) });
  if (failure.code === "agent_reported" && failure.detail) return failure.detail;
  const key = widgetFailureKey(failure.code === "agent_reported" ? "error" : failure.code, failure.detail);
  return t(key, { name, detail: failure.detail ?? "" });
}

/**
 * The widget waits for its agent to have an AI (ADR 0135 §20): no build starts until then, so its way out is
 * connecting one (it builds by itself after), never Resolve. The server's `widgetNeedsAi`.
 */
export const widgetNeedsAi = (w: Pick<Widget, "status" | "failure">) =>
  w.status === "failed" && w.failure?.code === "missing_credential";

/**
 * The widget stopped after failing in a row for the lack of an AI: nothing starts it again by itself, so its way out
 * is connecting one while there is none, then Resolve (`useWidgetLacksAi`).
 */
export const widgetStoppedForAi = (w: Pick<Widget, "status" | "failure">) =>
  w.status === "failed" && w.failure?.code === "failing" && w.failure.cause === "missing_credential";

/**
 * A widget waiting for an AI, or stopped for the lack of one, whose build has one now: the server says so for the
 * right hand's (the AI status's `widgetsReady`: whose AI its build thinks with is its own people's), and for any
 * agent's its state for background work does (`background`, else `state`). Its computer away is no missing AI: the
 * build waits for it as any run does.
 */
export function widgetAiReady(w: Pick<Widget, "id" | "status" | "failure" | "agentId">, status: AiStatus | undefined) {
  if (!widgetNeedsAi(w) && !widgetStoppedForAi(w)) return false;
  if (status?.widgetsReady?.includes(w.id)) return true;
  const agent = status?.agents.find((a) => a.agentId === w.agentId);
  const state = agent?.background ?? agent?.state;
  return state !== undefined && state !== "no_ai";
}

/** The cost line of "New widget": a day, a week, only when asked, on a plan, or nothing known. */
export type WidgetCostLine =
  | { kind: "day"; usd: number }
  | { kind: "week"; usd: number }
  | { kind: "manual" }
  | { kind: "plan" }
  | { kind: "unknown" };

export function widgetCostLine(
  schedule: WidgetSchedule,
  estimate: WidgetCostEstimate | null | undefined,
): WidgetCostLine {
  if (schedule === "manual") return { kind: "manual" };
  if (!estimate) return { kind: "unknown" };
  if (estimate.billedTo === "plan") return { kind: "plan" };
  const usd = schedule === "week" ? estimate.perWeekUsd : estimate.perDayUsd;
  if (usd === null) return { kind: "unknown" };
  return schedule === "week" ? { kind: "week", usd } : { kind: "day", usd };
}

/** The widgets of a board at work: updating or being built (a sweep on each), and not standing still on a wait. */
export const busyWidgets = (widgets: readonly Widget[], now = Date.now()) =>
  widgets.filter((w) => (w.status === "updating" || w.status === "building") && !widgetWaiting(w, now));

/** Waiting for room on its computer is said only past this long (the engine's `COMPUTER_QUEUE_NOTE_MS`). */
export const WIDGET_LINE_NOTE_MS = 10 * 60_000;

/**
 * What holds a widget's refresh (`Widget.wait`) while it still does: its reset (an outage's next try) ahead, or not
 * known. Past its reset it is about to go on, so the apps show it at work again, as they do for room on its computer
 * until it waited `WIDGET_LINE_NOTE_MS`. Null: nothing waits.
 */
export function widgetWaiting(w: Pick<Widget, "status" | "wait">, now = Date.now()): WidgetWait | null {
  const wait = w.wait;
  if (!wait || (w.status !== "building" && w.status !== "updating")) return null;
  if (wait.code === "busy") return wait.since && now - Date.parse(wait.since) >= WIDGET_LINE_NOTE_MS ? wait : null;
  return wait.resetsAt && Date.parse(wait.resetsAt) <= now ? null : wait;
}

/** The status a widget's card draws: one whose refresh waits (`widgetWaiting`) stands still, its data as it was. */
export const widgetCardStatus = (w: Pick<Widget, "status" | "wait">, now = Date.now()): WidgetStatus =>
  widgetWaiting(w, now) ? "ok" : w.status;

const WAIT_CODES: readonly string[] = ["usage_pause", "plan_limit", "budget", "computer", "busy", "outage"];
const WAIT_SCOPES: readonly string[] = ["model", "region", "off", "inactive"];
const textOf = (v: unknown) => (typeof v === "string" && v ? v : null);

/** A wait as the server sends it (`Widget.wait`, the params of a `widget.waiting` refusal); null when it isn't one. */
export function widgetWaitOf(raw: unknown): WidgetWait | null {
  const w = raw as Partial<Record<keyof WidgetWait, unknown>> | null | undefined;
  if (!w || typeof w.code !== "string" || !WAIT_CODES.includes(w.code)) return null;
  return {
    code: w.code as WidgetWait["code"],
    source: w.source === "plan" || w.source === "budget" ? w.source : null,
    resetsAt: textOf(w.resetsAt),
    scope: typeof w.scope === "string" && WAIT_SCOPES.includes(w.scope) ? (w.scope as WidgetWait["scope"]) : null,
    model: textOf(w.model),
    since: textOf(w.since),
    canContinue: w.canContinue === true,
  };
}

/**
 * A wait in the reader's words, on the widget and when Update now can't go sooner: "Waiting for Theo's plan to reset
 * at 13:00", "Waiting for Theo's budget to renew on December 1", its model's own limit as the brain card says it,
 * "Waiting for room on Theo's computer", "Waiting for Theo's AI to answer, next try at 13:05".
 */
export function widgetWaitText(t: TFunction, locale: string, wait: WidgetWait, name: string, now = new Date()) {
  const when = (iso: string) => usageWhen(t, locale, iso, now);
  if (wait.code === "computer") return t("widgets.wait.computer", { name });
  if (wait.code === "busy") return t("widgets.wait.busy", { name });
  if (wait.code === "outage")
    return wait.resetsAt
      ? t("widgets.wait.provider", { name, when: when(wait.resetsAt) })
      : t("presence.agent.provider_down");
  if (wait.scope && wait.model) {
    const { scope } = wait;
    const until = wait.resetsAt ? Date.parse(wait.resetsAt) : null;
    const limit = { until, region: scope === "region", off: scope === "off", inactive: scope === "inactive" };
    return modelLimitWords(t, locale, limit, wait.model, now);
  }
  const budget = wait.source === "budget";
  if (!wait.resetsAt) return t(budget ? "widgets.wait.budgetSoon" : "widgets.wait.planUnknown", { name });
  return t(budget ? "widgets.wait.budget" : "widgets.wait.plan", { name, when: when(wait.resetsAt) });
}

/**
 * The one thing that ends a widget's wait sooner, for who may do it (`waitFix`): a higher budget (admins), another model
 * for one at a limit of its own (its owner, admins), or its computer opened. Null: only time ends it.
 */
export function widgetWaitFix(wait: WidgetWait, who: { admin: boolean; owner: boolean }) {
  if (wait.code === "computer" || wait.code === "busy") return "openComputer" as const;
  const on =
    wait.code === "budget" && wait.resetsAt ? "budget" : wait.code === "plan_limit" && wait.scope ? "model" : null;
  return waitFix(on, who);
}

/** A build that takes longer than this says it is still at it. */
export const WIDGET_STILL_MS = 45_000;

/**
 * The building card's step line, in the chat's own words for a call ("Consultando o Stripe", "Pesquisando na web"),
 * never a tool's name; "Pensando" between calls, and its own words for the call that hands the data in.
 */
export function widgetStepWords(t: TFunction, step: WidgetStep | null | undefined, locale?: string): string {
  if (!step?.tool) return t("dashboards.newWidget.thinking");
  if (step.tool === "update_widget" && !step.connector) return t("dashboards.newWidget.finishing");
  const activity = toolActivity(step.tool, step.connector, null, { service: step.service });
  return capitalize(activityVerb(t, activity), locale);
}
