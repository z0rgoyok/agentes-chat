import { afterEach, expect, test } from "bun:test";
import { and, type Database, eq, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import {
  createOrganization,
  ForbiddenError,
  ISSUE_COLUMN_WIDTHS,
  ISSUE_LIST_COLUMNS,
  ISSUES_VIEW_DEFAULT,
  ISSUES_VIEW_LABEL_MAX,
  ISSUES_VIEW_MAX_ASSIGNEES,
  issuesViewOf,
  myIssuesView,
  setMyIssuesView,
} from "../src";
import { addMember, addUser } from "./fixtures";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const full = {
  layout: "list",
  group: "assignee",
  sort: "due",
  fields: {
    project: false,
    assignee: true,
    priority: false,
    due: true,
    criteria: false,
    pullRequest: true,
    label: false,
  },
  assignees: ["agent:3f0c2a9e-1b7d-4c55-9e0a-2d4b6f8a1c3e", "person:u_ana", "none"],
  priorities: ["high", "low"],
  labels: ["bug", "produto"],
  done: "recent",
  showCanceled: true,
  hideEmpty: true,
  collapsed: ["3f0c2a9e-1b7d-4c55-9e0a-2d4b6f8a1c3e", "person:u_ana", "low"],
  widths: { title: 420, assignee: 240 },
};

test("a view from what a row holds: nothing stored, or not an object, is the default", () => {
  for (const raw of [undefined, null, "board", 3, [], {}]) expect(issuesViewOf(raw)).toEqual(ISSUES_VIEW_DEFAULT);
  expect(issuesViewOf(full)).toEqual(full as never);
});

test("only known keys and values stay; each unknown one is its default, filters once each", () => {
  const view = issuesViewOf({
    layout: "grid",
    group: "stage",
    sort: "random",
    fields: { assignee: false, due: "no", extra: true },
    assignees: ["agent:a1", "agent:a1", "person:u1", "none", "robot:x", 3, "agent:", "person:u 1"],
    priorities: ["low", "urgent", "high", "low"],
    showCanceled: "yes",
    search: "login",
  });
  expect(view).toEqual({
    ...ISSUES_VIEW_DEFAULT,
    fields: { ...ISSUES_VIEW_DEFAULT.fields, assignee: false },
    assignees: ["agent:a1", "person:u1", "none"],
    // Most urgent first, whatever order they came in.
    priorities: ["high", "low"],
  });
  // The label filter, the finished tasks shown, the empty groups and the folded groups: the same care.
  expect(
    issuesViewOf({
      labels: [" bug ", "bug", "", 3, "x".repeat(ISSUES_VIEW_LABEL_MAX + 1), "produto"],
      done: "last-week",
      hideEmpty: "yes",
      collapsed: ["high", "high", "agent:a1", "a b", 7, ""],
    }),
  ).toEqual({ ...ISSUES_VIEW_DEFAULT, labels: ["bug", "produto"], collapsed: ["high", "agent:a1"] });
  expect(issuesViewOf({ sort: "updated", done: "hidden", hideEmpty: true })).toEqual({
    ...ISSUES_VIEW_DEFAULT,
    sort: "updated",
    done: "hidden",
    hideEmpty: true,
  });
  // The search is never part of a view.
  expect(Object.keys(view)).not.toContain("search");
  const many = Array.from({ length: ISSUES_VIEW_MAX_ASSIGNEES + 10 }, (_, i) => `person:u${i}`);
  expect(issuesViewOf({ assignees: many }).assignees).toHaveLength(ISSUES_VIEW_MAX_ASSIGNEES);
});

test("the list's column widths: known columns only, whole pixels between each column's least and most", () => {
  const { title, label, due } = ISSUE_COLUMN_WIDTHS;
  expect(
    issuesViewOf({
      widths: {
        title: title.max + 500,
        label: label.min - 40,
        due: 131.6,
        priority: "wide",
        criteria: Number.NaN,
        assignee: null,
        number: 80,
        talk: 90,
      },
    }).widths,
  ).toEqual({ title: title.max, label: label.min, due: 132 });
  expect(due.min).toBeLessThan(132);
  // Not a record of widths: none kept.
  for (const raw of [undefined, null, [200, 300], "wide", 300])
    expect(issuesViewOf({ widths: raw }).widths).toEqual({});
  // Every column has a width of its own inside its ends, and the title, which holds the words, the largest least.
  for (const column of ISSUE_LIST_COLUMNS) {
    const { base, min, max } = ISSUE_COLUMN_WIDTHS[column];
    expect(min).toBeLessThanOrEqual(base);
    expect(base).toBeLessThanOrEqual(max);
    if (column !== "title") expect(min).toBeLessThan(title.min);
  }
});

test("each person's own, per workspace, kept clean; not a member: refused", async () => {
  const t = await createTestDatabase();
  close = t.close;
  const db: Database = t.db;
  const owner = await addUser(db, "ana");
  const { organization: org } = await createOrganization(db, owner.id, { name: "Acme" });
  const { organization: other } = await createOrganization(db, owner.id, { name: "Beta" });
  const member = await addMember(db, org.id, "member", "bia");

  expect(await myIssuesView(db, org.id, owner.id)).toEqual(ISSUES_VIEW_DEFAULT);
  expect(await setMyIssuesView(db, org.id, owner.id, { ...full, extra: 1, assignees: ["none", "none"] })).toEqual({
    ...full,
    assignees: ["none"],
  } as never);
  expect(await myIssuesView(db, org.id, owner.id)).toEqual({ ...full, assignees: ["none"] } as never);
  // What the row holds is the clean view.
  const [row] = await db
    .select({ view: schema.organizationMembers.issuesView })
    .from(schema.organizationMembers)
    .where(and(eq(schema.organizationMembers.orgId, org.id), eq(schema.organizationMembers.userId, owner.id)));
  expect(row?.view).toEqual({ ...full, assignees: ["none"] });

  // Someone else in the workspace keeps their own; so does the owner in another workspace.
  expect(await myIssuesView(db, org.id, member.id)).toEqual(ISSUES_VIEW_DEFAULT);
  expect(await myIssuesView(db, other.id, owner.id)).toEqual(ISSUES_VIEW_DEFAULT);

  const stranger = await addUser(db, "caio");
  await expect(myIssuesView(db, org.id, stranger.id)).rejects.toBeInstanceOf(ForbiddenError);
  await expect(setMyIssuesView(db, org.id, stranger.id, full)).rejects.toBeInstanceOf(ForbiddenError);
});
