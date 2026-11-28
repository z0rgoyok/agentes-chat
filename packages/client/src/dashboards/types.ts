/**
 * Dashboards and widgets (ADR 0135) as the API sends them: the server's views
 * (`packages/engine/src/dashboards/types.ts`) and request bodies. `WidgetSpec` mirrors
 * `@agenteschat/ui/widgets/spec` (where it is checked and its helpers live): the web and the phone pass these
 * straight to the renderers, so the two stay the same shape.
 */

export type WidgetKind = "kpi" | "goal" | "bars" | "line" | "list" | "text";
/** What a person asks for: a kind, or `auto` (the agent picks). */
export type WidgetFormat = "auto" | WidgetKind;
/** Every 30 min (the floor), every hour, every day at 08:00, every Monday at 08:00, or only when asked. */
export type WidgetSchedule = "half" | "hour" | "day" | "week" | "manual";
/** S = 1×1, M = 2×1, L = 2×2. */
export type WidgetSize = "s" | "m" | "l";
/** Its first run, data shown, a refresh running (the last data stays), or it failed. */
export type WidgetStatus = "building" | "ok" | "updating" | "failed";

export interface KpiWidgetSpec {
  kind: "kpi";
  value: number;
  prefix?: string;
  suffix?: string;
  /** `up` true = the good direction, whatever the sign. */
  delta?: { text: string; up: boolean };
  note?: string;
  spark?: number[];
  /** One per `spark` number: its date, mostly. */
  sparkLabels?: string[];
}
export interface GoalWidgetSpec {
  kind: "goal";
  pct: number;
  line: string;
  note?: string;
}
export interface BarsWidgetSpec {
  kind: "bars";
  labels: string[];
  values: number[];
  alertIndex?: number;
  unit?: string;
  note?: string;
}
export interface LineWidgetSpec {
  kind: "line";
  labels: string[];
  values: number[];
  unit?: string;
  note?: string;
}
export interface ListWidgetSpec {
  kind: "list";
  rows: { text: string; meta?: string; tone?: "ok" | "warn" }[];
}
export interface TextWidgetSpec {
  kind: "text";
  items: string[];
}
export type WidgetSpec =
  | KpiWidgetSpec
  | GoalWidgetSpec
  | BarsWidgetSpec
  | LineWidgetSpec
  | ListWidgetSpec
  | TextWidgetSpec;

export type DashboardKind = "board" | "home";
/** Every member, whoever holds one of its roles (ADR 0085), or only its owner. */
export type DashboardAudience = "workspace" | "roles" | "private";
/** Whoever sees it, only its owner and admins, or (besides them) whoever sees it and holds one of its edit roles. */
export type DashboardEditPolicy = "viewers" | "owner" | "roles";

export interface HomeTile {
  key: "waiting" | "working";
  position: number;
  w: 1 | 2;
  h: 1 | 2;
}

export interface DashboardOwner {
  kind: "person" | "agent";
  id: string;
  name: string;
}

/** An agent asks to show the board to more people; only the person it asks decides (`canDecide`). */
export interface DashboardProposal {
  audience: "workspace" | "roles";
  roleIds: string[];
  agentId: string;
  why: string;
  at: string;
  canDecide: boolean;
}

export interface DashboardSummary {
  id: string;
  kind: DashboardKind;
  /** Empty for a home board: show "My Home". */
  title: string;
  about: string;
  audience: DashboardAudience;
  roleIds: string[];
  editPolicy: DashboardEditPolicy;
  /** With `editPolicy` `roles`: the roles whose holders edit it when they see it (absent reads as none). */
  editRoleIds?: string[];
  pinned: boolean;
  position: number;
  owner: DashboardOwner | null;
  ownerUserId: string | null;
  mine: boolean;
  widgetCount: number;
  /** Its first widgets for the thumbnail: whose tones and how wide. */
  thumbs: { agentId: string; w: 1 | 2 }[];
  viewerCount: number;
  canEdit: boolean;
  /** Share, delete, pin. */
  canManage: boolean;
  proposal: DashboardProposal | null;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardList {
  /** Null until the home board was first opened. */
  home: DashboardSummary | null;
  dashboards: DashboardSummary[];
  /** The board Início shows instead of my own home (one of `dashboards`, "Use on Home"); null = my own. */
  homeDashboardId: string | null;
}

export interface WidgetFailure {
  /** `agent_reported` (show `detail` as is), `no_update`, `error`, or a routine's code (`budget_exceeded`…). */
  code: string;
  detail: string | null;
  /** With `failing` (it stopped after failing in a row): the code of the last of those failures (`detail` is its). */
  cause?: string;
}

/**
 * What a widget's refresh run waits on: paused near its plan's or budget's limit (`usage_pause`: Update now lets it go
 * on), at that limit (`plan_limit`, `budget`), for its computer to be back (`computer`) or to have room (`busy`), or for
 * its AI provider (`outage`). `source`: whose limit (null for the others). `resetsAt`: when it picks up by itself, an
 * outage's next try (null: not known; a budget's: other runs hold it for a moment). `scope` and `model`: a plan's limit
 * on its model alone, and that model's name. `since`: when a `busy` one began waiting for room. `canContinue`: the
 * viewer may let a pause go on.
 */
export interface WidgetWait {
  code: "usage_pause" | "plan_limit" | "budget" | "computer" | "busy" | "outage";
  source: "plan" | "budget" | null;
  resetsAt: string | null;
  scope: "model" | "region" | "off" | "inactive" | null;
  model: string | null;
  since: string | null;
  canContinue: boolean;
}

export interface Widget {
  id: string;
  dashboardId: string;
  agentId: string;
  title: string;
  prompt: string;
  format: WidgetFormat;
  kind: WidgetKind | null;
  spec: WidgetSpec | null;
  sources: string[];
  layout: { position: number; w: 1 | 2; h: 1 | 2 };
  schedule: WidgetSchedule;
  alert: { enabled: boolean; condition: string };
  status: WidgetStatus;
  failure: WidgetFailure | null;
  /** While it is `building` or `updating`: what its run waits on (`widgetWaiting` reads it). */
  wait: WidgetWait | null;
  refreshedAt: string | null;
  nextRunAt: string | null;
  routineId: string | null;
  sourceMessageId: string | null;
  createdBy: { kind: "person" | "agent"; id: string } | null;
  /** A test not created yet ("Test" in New widget): only its creator sees it, on no board. */
  draft: boolean;
  /** What its latest update cost ("This test cost $0.01"); null on a plan, or before it is known. */
  lastCostUsd: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Dashboard extends DashboardSummary {
  widgets: Widget[];
  /** Home only. */
  tiles: HomeTile[];
}

export interface WidgetUpdate {
  id: string;
  at: string;
  status: "ok" | "failed";
  summary: string;
  alert: string | null;
  failureCode: string | null;
  change: string | null;
  costUsd: number | null;
}

/** The tool call a widget's build is in (`widgetStepWords` says it): the live chip's fields, never its input. */
export interface WidgetStep {
  tool: string;
  connector: string | null;
  service: string | null;
  at: string;
}

export interface WidgetDetail extends Widget {
  dashboard: { id: string; kind: DashboardKind; title: string };
  canEdit: boolean;
  /** While it builds or updates: the call its run is in; null between calls. Absent from an older server. */
  step?: WidgetStep | null;
  /** Newest first. */
  history: WidgetUpdate[];
}

export interface WidgetCostEstimate {
  agentId: string;
  schedule: WidgetSchedule;
  runsPerDay: number;
  perRunUsd: number | null;
  perDayUsd: number | null;
  perWeekUsd: number | null;
  basis: "history" | "model" | "none";
  billedTo: "api" | "plan";
}

export interface WidgetSuggestion {
  title: string;
  prompt: string;
  kind: WidgetKind;
  alert: string;
}

export interface WidgetSuggestions {
  agentId: string;
  sources: string[];
  suggestions: WidgetSuggestion[];
}

export interface PinnableBlock {
  messageId: string;
  channelId: string;
  threadId: string | null;
  agentId: string;
  at: string;
  block: string;
  title: string;
  spec: WidgetSpec;
  place: { kind: "channel" | "dm" | "thread"; name: string | null };
}

// ── Requests ─────────────────────────────────────────────────────────────────

export interface CreateDashboardInput {
  title: string;
  about?: string;
  audience: DashboardAudience;
  roleIds?: string[];
  editPolicy: DashboardEditPolicy;
  /** With `editPolicy` `roles`. */
  editRoleIds?: string[];
}

export interface UpdateDashboardInput {
  title?: string;
  about?: string;
  pinned?: boolean;
}

export interface ShareDashboardInput {
  audience: DashboardAudience;
  roleIds: string[];
  editPolicy: DashboardEditPolicy;
  /** With `editPolicy` `roles`. */
  editRoleIds?: string[];
}

export interface DashboardLayoutInput {
  widgets: { id: string; position: number; w: 1 | 2; h: 1 | 2 }[];
  tiles?: HomeTile[];
}

/** "Create widget" after a test: the board it goes on (first) and how it updates. */
export interface ConfirmWidgetInput {
  dashboardId: string;
  /** The person's title (kept from then on); absent: the one its agent wrote on the test. */
  title?: string;
  size: WidgetSize;
  schedule: WidgetSchedule;
  alert: { enabled: boolean; condition: string };
}

export interface CreateWidgetInput {
  agentId: string;
  prompt: string;
  title?: string;
  format: WidgetFormat;
  schedule: WidgetSchedule;
  alert?: { enabled: boolean; condition: string };
  size?: WidgetSize;
}

export interface PinWidgetInput {
  messageId: string;
  block: string;
  schedule: WidgetSchedule;
  size?: WidgetSize;
  title?: string;
}

export interface UpdateWidgetInput {
  title?: string;
  prompt?: string;
  schedule?: WidgetSchedule;
  alert?: { enabled: boolean; condition: string };
  size?: WidgetSize;
  dashboardId?: string;
}

export type DashboardProposalDecision = "publish" | "keep";
