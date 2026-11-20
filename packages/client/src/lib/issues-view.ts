import type { IssueCardField, IssueListColumn, IssuePriority, IssuesView } from "../api/types";

/** What a card can show besides its number and title, in the order the screen offers them. */
export const ISSUE_CARD_FIELDS: readonly IssueCardField[] = [
  "project",
  "assignee",
  "priority",
  "due",
  "criteria",
  "pullRequest",
  "label",
];

/** The groups a board or list can be split into, and the orders inside each group. */
export const ISSUES_GROUPS: readonly IssuesView["group"][] = ["stage", "assignee", "priority"];
export const ISSUES_SORTS: readonly IssuesView["sort"][] = ["manual", "priority", "due", "updated"];
/** Which finished tasks show, and how many days back "recent" goes. */
export const ISSUES_DONE: readonly IssuesView["done"][] = ["all", "recent", "hidden"];
export const DONE_RECENT_DAYS = 7;

/**
 * The list's columns a person can give a width, in pixels: the task's title and one per card field. `base` is the
 * width a column has until someone drags it (the title's is the least it keeps while it takes the room left over);
 * `min` and `max` are how far a drag goes (mirrors `ISSUE_COLUMN_WIDTHS`, packages/engine/src/issues-view.ts).
 */
export const ISSUE_COLUMN_WIDTHS: Readonly<Record<IssueListColumn, { base: number; min: number; max: number }>> = {
  title: { base: 240, min: 200, max: 960 },
  project: { base: 120, min: 80, max: 320 },
  label: { base: 128, min: 96, max: 320 },
  priority: { base: 104, min: 72, max: 220 },
  due: { base: 104, min: 80, max: 220 },
  criteria: { base: 88, min: 72, max: 220 },
  pullRequest: { base: 116, min: 80, max: 320 },
  assignee: { base: 160, min: 120, max: 360 },
};

/** A column's width held between its least and most, a whole number of pixels. */
export function clampColumnWidth(column: IssueListColumn, width: number) {
  const { min, max } = ISSUE_COLUMN_WIDTHS[column];
  return Math.min(max, Math.max(min, Math.round(width)));
}

/**
 * The view's widths with `column` at `width` (held between its least and most), or back at its own with `null`. Only
 * the columns a person changed are kept, so one dragged back to its own width is not.
 */
export function withColumnWidth(
  widths: IssuesView["widths"],
  column: IssueListColumn,
  width: number | null,
): IssuesView["widths"] {
  const { [column]: _was, ...rest } = widths;
  if (width === null) return rest;
  const next = clampColumnWidth(column, width);
  // The title has no width of its own to go back to: it takes the room left over until it is given one.
  return column !== "title" && next === ISSUE_COLUMN_WIDTHS[column].base ? rest : { ...rest, [column]: next };
}

/** Priorities from the most to the least urgent: the priority groups and the priority order. */
export const PRIORITY_ORDER: readonly IssuePriority[] = ["high", "normal", "low"];

/**
 * What someone who never changed Tarefas sees: the board by stage, every field, no filter (mirrors
 * `ISSUES_VIEW_DEFAULT`, packages/engine/src/issues-view.ts).
 */
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

/** A change to a view: any of its parts, the fields one by one. */
export type IssuesViewChange = Partial<Omit<IssuesView, "fields">> & { fields?: Partial<IssuesView["fields"]> };

/** `view` with `change` applied; what a server of before a part doesn't send is at its default. */
export const withIssuesView = (view: Partial<IssuesView>, change: IssuesViewChange): IssuesView => ({
  ...ISSUES_VIEW_DEFAULT,
  ...view,
  ...change,
  fields: { ...ISSUES_VIEW_DEFAULT.fields, ...view.fields, ...change.fields },
});

/** Whether the view is the one everybody starts with ("Voltar ao padrão" only shows when it isn't). */
export function isDefaultIssuesView(view: IssuesView) {
  const d = ISSUES_VIEW_DEFAULT;
  return (
    view.layout === d.layout &&
    view.group === d.group &&
    view.sort === d.sort &&
    view.showCanceled === d.showCanceled &&
    view.done === d.done &&
    view.hideEmpty === d.hideEmpty &&
    view.assignees.length === 0 &&
    view.priorities.length === 0 &&
    view.labels.length === 0 &&
    view.collapsed.length === 0 &&
    Object.keys(view.widths).length === 0 &&
    ISSUE_CARD_FIELDS.every((f) => view.fields[f] === d.fields[f])
  );
}

const PRIORITY_RANK: Record<IssuePriority, number> = { high: 0, normal: 1, low: 2 };
/** Without a due date: after every dated one. */
const NO_DUE = "9999-12-31";

/**
 * A group's cards in the view's order: as they are (`manual`, the board's own order), most urgent first, soonest
 * due first, or last changed first. Ties keep the order they came in.
 */
export function sortIssues<T extends { priority: IssuePriority; dueDate: string | null; updatedAt: string }>(
  list: T[],
  sort: IssuesView["sort"],
): T[] {
  if (sort === "updated") return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (sort === "priority") return [...list].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  if (sort === "due") return [...list].sort((a, b) => (a.dueDate ?? NO_DUE).localeCompare(b.dueDate ?? NO_DUE));
  return list;
}

/** A task's assignees as the view's filter and its groups name them: `agent:<id>`, `person:<id>`, or `none` alone. */
export const issueAssigneeKeys = (issue: { assignees: readonly { type: string; id: string }[] }): string[] =>
  issue.assignees.length === 0 ? ["none"] : issue.assignees.map((a) => `${a.type}:${a.id}`);

/**
 * Whether the view shows this task, by its filters and by what it hides: an assignee, a priority or a label filter
 * it doesn't match, a canceled task unless asked, a finished one hidden or (`recent`) last changed more than
 * `DONE_RECENT_DAYS` days ago. `assigneeKeys`: the task's assignees as the filter names them (`issueAssigneeKeys`);
 * one of them matching is enough.
 */
export function issueInView(
  issue: { status: string; priority: IssuePriority; labels: string[]; updatedAt: string },
  assigneeKeys: readonly string[],
  view: IssuesView,
  now = Date.now(),
) {
  if (view.assignees.length > 0 && !assigneeKeys.some((k) => view.assignees.includes(k))) return false;
  if (view.priorities.length > 0 && !view.priorities.includes(issue.priority)) return false;
  if (view.labels.length > 0 && !issue.labels.some((l) => view.labels.includes(l))) return false;
  if (issue.status === "canceled") return view.showCanceled;
  if (issue.status !== "done" || view.done === "all") return true;
  if (view.done === "hidden") return false;
  return now - Date.parse(issue.updatedAt) <= DONE_RECENT_DAYS * 86_400_000;
}
