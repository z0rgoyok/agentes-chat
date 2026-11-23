import { and, type Database, eq, schema } from "@agenteschat/db";
import { requirePermission } from "./organizations";

const { organizationMembers } = schema;

/**
 * How a person looks at Tarefas in a workspace (`organization_members.issues_view`): a board or a list, grouped by
 * stage, assignee or priority, the order inside each group, what the cards show, the assignee, priority and label
 * filters, which finished tasks show (and whether canceled ones do), whether empty groups show, the groups
 * folded shut, and the widths the person gave the list's columns. It lives on the server so the web, the desktop app and the phone open the screen
 * the same way; the search text is never kept. Mirrors `ISSUES_VIEW_DEFAULT` in packages/client/src/lib/issues-view.ts.
 */
export const ISSUES_LAYOUTS = ["board", "list"] as const;
export type IssuesLayout = (typeof ISSUES_LAYOUTS)[number];
export const ISSUES_GROUPS = ["stage", "assignee", "priority"] as const;
export type IssuesGroup = (typeof ISSUES_GROUPS)[number];
export const ISSUES_SORTS = ["manual", "priority", "due", "updated"] as const;
export type IssuesSort = (typeof ISSUES_SORTS)[number];
/** What a card can show besides its number and title. */
export const ISSUE_CARD_FIELDS = [
  "project",
  "assignee",
  "priority",
  "due",
  "criteria",
  "pullRequest",
  "label",
] as const;
export type IssueCardField = (typeof ISSUE_CARD_FIELDS)[number];
export const ISSUES_VIEW_PRIORITIES = ["high", "normal", "low"] as const;
/** An assignee filter: `agent:<id>`, `person:<id>` or `none` (no assignee). */
export const ISSUES_VIEW_ASSIGNEE = /^(none|agent:[A-Za-z0-9_-]{1,100}|person:[A-Za-z0-9_-]{1,100})$/;
/** More than anyone picks by hand: a row never grows past this. */
export const ISSUES_VIEW_MAX_ASSIGNEES = 50;
/** Which finished tasks show: every one, the ones touched in the last days (the apps count them), or none. */
export const ISSUES_DONE = ["all", "recent", "hidden"] as const;
export type IssuesDone = (typeof ISSUES_DONE)[number];
/** A label filter is a label as tasks hold them; a view keeps a few. */
export const ISSUES_VIEW_LABEL_MAX = 60;
export const ISSUES_VIEW_MAX_LABELS = 20;
/** A folded group: a board column's id, an assignee filter's key or a priority, whatever the view is grouped by. */
export const ISSUES_VIEW_GROUP = /^[A-Za-z0-9:_-]{1,120}$/;
export const ISSUES_VIEW_MAX_COLLAPSED = 100;
/**
 * The list's columns a person can give a width, in pixels: the task's title and one per card field. `base` is the
 * width a column has until someone drags it (the title's is the least it keeps while it takes the room left over);
 * `min` and `max` are how far a drag goes. Mirrors `ISSUE_COLUMN_WIDTHS` in packages/client/src/lib/issues-view.ts.
 */
export const ISSUE_COLUMN_WIDTHS = {
  title: { base: 240, min: 200, max: 960 },
  project: { base: 120, min: 80, max: 320 },
  label: { base: 128, min: 96, max: 320 },
  priority: { base: 104, min: 72, max: 220 },
  due: { base: 104, min: 80, max: 220 },
  criteria: { base: 88, min: 72, max: 220 },
  pullRequest: { base: 116, min: 80, max: 320 },
  assignee: { base: 160, min: 120, max: 360 },
} as const satisfies Record<"title" | IssueCardField, { base: number; min: number; max: number }>;
export type IssueListColumn = keyof typeof ISSUE_COLUMN_WIDTHS;
export const ISSUE_LIST_COLUMNS = Object.keys(ISSUE_COLUMN_WIDTHS) as IssueListColumn[];

/** A type, not an interface: the row's jsonb column takes it as a plain record. */
export type IssuesView = {
  layout: IssuesLayout;
  group: IssuesGroup;
  sort: IssuesSort;
  fields: Record<IssueCardField, boolean>;
  /** Only tasks with one of these assignees (empty: every task). */
  assignees: string[];
  /** Only tasks with one of these priorities (empty: every task). */
  priorities: (typeof ISSUES_VIEW_PRIORITIES)[number][];
  /** Only tasks with one of these labels (empty: every task). */
  labels: string[];
  done: IssuesDone;
  showCanceled: boolean;
  /** Groups with no task on screen take no room. */
  hideEmpty: boolean;
  /** The groups folded to their name and count. */
  collapsed: string[];
  /** The list's columns the person gave a width, in pixels; a column not named has its own. */
  widths: Partial<Record<IssueListColumn, number>>;
};

/** What someone who never changed the screen sees: today's board by stage, every field, no filter. */
export const ISSUES_VIEW_DEFAULT: IssuesView = {
  layout: "board",
  group: "stage",
  sort: "manual",
  fields: { project: true, assignee: true, priority: true, due: true, criteria: true, pullRequest: true, label: true },
  assignees: [],
  priorities: [],
  labels: [],
  done: "all",
  showCanceled: false,
  hideEmpty: false,
  collapsed: [],
  widths: {},
};

const pick = <T extends string>(list: readonly T[], value: unknown, fallback: T): T =>
  typeof value === "string" && (list as readonly string[]).includes(value) ? (value as T) : fallback;

const record = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

/**
 * The widths a view keeps: known columns only, each a whole number of pixels held between its column's least and
 * most; anything that is not a number is dropped.
 */
function widthsOf(raw: unknown): IssuesView["widths"] {
  const given = record(raw);
  const widths: IssuesView["widths"] = {};
  for (const column of ISSUE_LIST_COLUMNS) {
    const value = given[column];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const { min, max } = ISSUE_COLUMN_WIDTHS[column];
    widths[column] = Math.min(max, Math.max(min, Math.round(value)));
  }
  return widths;
}

/**
 * A view from what a row (or a request) holds: known keys with known values only, each missing or unknown one at its
 * default, filters without repeats. What is stored is never trusted as is.
 */
export function issuesViewOf(raw: unknown): IssuesView {
  const v = record(raw);
  const fields = record(v.fields);
  const assignees = Array.isArray(v.assignees) ? v.assignees : [];
  const priorities = Array.isArray(v.priorities) ? v.priorities : [];
  const labels = Array.isArray(v.labels) ? v.labels : [];
  const collapsed = Array.isArray(v.collapsed) ? v.collapsed : [];
  return {
    layout: pick(ISSUES_LAYOUTS, v.layout, ISSUES_VIEW_DEFAULT.layout),
    group: pick(ISSUES_GROUPS, v.group, ISSUES_VIEW_DEFAULT.group),
    sort: pick(ISSUES_SORTS, v.sort, ISSUES_VIEW_DEFAULT.sort),
    fields: Object.fromEntries(
      ISSUE_CARD_FIELDS.map((f) => [f, typeof fields[f] === "boolean" ? fields[f] : ISSUES_VIEW_DEFAULT.fields[f]]),
    ) as IssuesView["fields"],
    assignees: [
      ...new Set(assignees.filter((a): a is string => typeof a === "string" && ISSUES_VIEW_ASSIGNEE.test(a))),
    ].slice(0, ISSUES_VIEW_MAX_ASSIGNEES),
    priorities: ISSUES_VIEW_PRIORITIES.filter((p) => priorities.includes(p)),
    labels: [
      ...new Set(
        labels
          .filter((l): l is string => typeof l === "string")
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && l.length <= ISSUES_VIEW_LABEL_MAX),
      ),
    ].slice(0, ISSUES_VIEW_MAX_LABELS),
    done: pick(ISSUES_DONE, v.done, ISSUES_VIEW_DEFAULT.done),
    showCanceled: typeof v.showCanceled === "boolean" ? v.showCanceled : ISSUES_VIEW_DEFAULT.showCanceled,
    hideEmpty: typeof v.hideEmpty === "boolean" ? v.hideEmpty : ISSUES_VIEW_DEFAULT.hideEmpty,
    collapsed: [
      ...new Set(collapsed.filter((g): g is string => typeof g === "string" && ISSUES_VIEW_GROUP.test(g))),
    ].slice(0, ISSUES_VIEW_MAX_COLLAPSED),
    widths: widthsOf(v.widths),
  };
}

const mine = (orgId: string, userId: string) =>
  and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId));

/** How the person left Tarefas in this workspace (the default when they never changed it). */
export async function myIssuesView(db: Database, orgId: string, userId: string): Promise<IssuesView> {
  await requirePermission(db, userId, orgId, "read");
  const [row] = await db
    .select({ view: organizationMembers.issuesView })
    .from(organizationMembers)
    .where(mine(orgId, userId));
  return issuesViewOf(row?.view);
}

/** Saves how the person looks at Tarefas in this workspace, cleaned first; answers with what was kept. */
export async function setMyIssuesView(db: Database, orgId: string, userId: string, view: unknown): Promise<IssuesView> {
  await requirePermission(db, userId, orgId, "read");
  const clean = issuesViewOf(view);
  await db.update(organizationMembers).set({ issuesView: clean }).where(mine(orgId, userId));
  return clean;
}
