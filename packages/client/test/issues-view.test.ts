import { expect, test } from "bun:test";
import {
  clampColumnWidth,
  DONE_RECENT_DAYS,
  ISSUE_COLUMN_WIDTHS,
  ISSUES_VIEW_DEFAULT,
  isDefaultIssuesView,
  issueAssigneeKeys,
  issueInView,
  sortIssues,
  withColumnWidth,
  withIssuesView,
} from "../src/lib/issues-view";

const DAY = 86_400_000;
const NOW = Date.parse("2026-03-20T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const task = (
  over: Partial<{ status: string; priority: "high" | "normal" | "low"; labels: string[]; updatedAt: string }>,
) => ({
  status: "todo",
  priority: "normal" as const,
  labels: [] as string[],
  updatedAt: ago(0),
  ...over,
});
const shown = (t: ReturnType<typeof task>, change: Parameters<typeof withIssuesView>[1], who = ["none"]) =>
  issueInView(t, who, withIssuesView(ISSUES_VIEW_DEFAULT, change), NOW);

test("finished tasks: every one, the ones changed in the last days, or none; open ones always", () => {
  const fresh = task({ status: "done", updatedAt: ago(DONE_RECENT_DAYS - 1) });
  const old = task({ status: "done", updatedAt: ago(DONE_RECENT_DAYS + 1) });
  expect([fresh, old].map((t) => shown(t, {}))).toEqual([true, true]);
  expect([fresh, old].map((t) => shown(t, { done: "recent" }))).toEqual([true, false]);
  expect([fresh, old].map((t) => shown(t, { done: "hidden" }))).toEqual([false, false]);
  // An open task untouched for a year is still there to do.
  expect(shown(task({ updatedAt: ago(365) }), { done: "hidden" })).toBe(true);
  // Canceled ones go by their own switch.
  expect(shown(task({ status: "canceled" }), {})).toBe(false);
  expect(shown(task({ status: "canceled" }), { showCanceled: true, done: "hidden" })).toBe(true);
});

test("the filters: one of the assignees, one of the priorities, one of the labels", () => {
  const t = task({ priority: "high", labels: ["bug", "produto"] });
  expect(shown(t, { labels: ["produto", "ops"] })).toBe(true);
  expect(shown(t, { labels: ["ops"] })).toBe(false);
  expect(shown(task({}), { labels: ["ops"] })).toBe(false);
  expect(shown(t, { priorities: ["low"] })).toBe(false);
  expect(shown(t, { assignees: ["agent:a1"] }, ["agent:a1"])).toBe(true);
  expect(shown(t, { assignees: ["agent:a1"] }, ["none"])).toBe(false);
});

test("a task several have matches the assignee filter when one of them does; one nobody has is `none`", () => {
  const two = {
    assignees: [
      { type: "person" as const, id: "u1" },
      { type: "agent" as const, id: "a1" },
    ],
  };
  expect(issueAssigneeKeys(two)).toEqual(["person:u1", "agent:a1"]);
  expect(issueAssigneeKeys({ assignees: [] })).toEqual(["none"]);
  const t = task({});
  expect(shown(t, { assignees: ["agent:a1"] }, issueAssigneeKeys(two))).toBe(true);
  expect(shown(t, { assignees: ["person:u2", "person:u1"] }, issueAssigneeKeys(two))).toBe(true);
  expect(shown(t, { assignees: ["agent:a2"] }, issueAssigneeKeys(two))).toBe(false);
  expect(shown(t, { assignees: ["none"] }, issueAssigneeKeys(two))).toBe(false);
  expect(shown(t, { assignees: ["none", "agent:a2"] }, issueAssigneeKeys({ assignees: [] }))).toBe(true);
});

test("by last change: the newest first", () => {
  const list = [
    { id: "a", priority: "normal" as const, dueDate: null, updatedAt: ago(3) },
    { id: "b", priority: "normal" as const, dueDate: null, updatedAt: ago(1) },
    { id: "c", priority: "normal" as const, dueDate: null, updatedAt: ago(2) },
  ];
  expect(sortIssues(list, "updated").map((i) => i.id)).toEqual(["b", "c", "a"]);
  expect(sortIssues(list, "manual")).toBe(list);
});

test("a view from a server of before a part is whole; any new part makes it not the default", () => {
  const {
    labels: _labels,
    done: _done,
    hideEmpty: _hideEmpty,
    collapsed: _collapsed,
    widths: _widths,
    ...before
  } = ISSUES_VIEW_DEFAULT;
  expect(withIssuesView(before, {})).toEqual(ISSUES_VIEW_DEFAULT);
  expect(isDefaultIssuesView(ISSUES_VIEW_DEFAULT)).toBe(true);
  for (const change of [
    { labels: ["bug"] },
    { done: "recent" as const },
    { hideEmpty: true },
    { collapsed: ["high"] },
    { widths: { label: 200 } },
  ])
    expect(isDefaultIssuesView(withIssuesView(ISSUES_VIEW_DEFAULT, change))).toBe(false);
});

test("a column's width: held between its least and most, and only a changed one is kept", () => {
  const { label, title } = ISSUE_COLUMN_WIDTHS;
  expect(clampColumnWidth("label", 10)).toBe(label.min);
  expect(clampColumnWidth("label", 5000)).toBe(label.max);
  expect(clampColumnWidth("label", 181.4)).toBe(181);
  expect(withColumnWidth({}, "label", 200)).toEqual({ label: 200 });
  expect(withColumnWidth({ label: 200 }, "due", 5000)).toEqual({ label: 200, due: ISSUE_COLUMN_WIDTHS.due.max });
  // Dragged back to its own width, or reset: not kept.
  expect(withColumnWidth({ label: 200, due: 100 }, "label", label.base)).toEqual({ due: 100 });
  expect(withColumnWidth({ label: 200, due: 100 }, "label", null)).toEqual({ due: 100 });
  // The title takes the room left over until it is given a width, so any width given to it is kept.
  expect(withColumnWidth({}, "title", title.base)).toEqual({ title: title.base });
  expect(withColumnWidth({ title: 400 }, "title", null)).toEqual({});
  // The title holds the words: its least is the largest.
  for (const [column, { min }] of Object.entries(ISSUE_COLUMN_WIDTHS))
    if (column !== "title") expect(min).toBeLessThan(title.min);
});
