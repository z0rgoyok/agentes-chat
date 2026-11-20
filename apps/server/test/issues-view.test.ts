import { afterEach, expect, test } from "bun:test";
import {
  ISSUE_CARD_FIELDS,
  ISSUE_COLUMN_WIDTHS,
  ISSUES_GROUPS,
  ISSUES_SORTS,
  ISSUES_VIEW_DEFAULT,
} from "@agenteschat/engine";
import {
  ISSUES_VIEW_DEFAULT as APP_DEFAULT,
  ISSUE_CARD_FIELDS as APP_FIELDS,
  ISSUES_GROUPS as APP_GROUPS,
  ISSUES_SORTS as APP_SORTS,
  ISSUE_COLUMN_WIDTHS as APP_WIDTHS,
} from "../../../packages/client/src/lib/issues-view";
import { browser, createTestServer, joinByInvitation, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t?.close());

test("Tarefas' view: the engine and the apps know the same parts and start from the same default", () => {
  expect([...APP_FIELDS]).toEqual([...ISSUE_CARD_FIELDS]);
  expect([...APP_GROUPS]).toEqual([...ISSUES_GROUPS]);
  expect([...APP_SORTS]).toEqual([...ISSUES_SORTS]);
  expect(APP_DEFAULT).toEqual(ISSUES_VIEW_DEFAULT);
  // The list's columns: the same ones, each with the same width of its own, least and most.
  expect(APP_WIDTHS).toEqual(ISSUE_COLUMN_WIDTHS);
});

/** A new workspace, set up (one still in its onboarding would come back instead of another). */
async function workspace(b: ReturnType<typeof browser>, name: string) {
  const created = (await (await b("/api/app/organizations", { json: { name } })).json()) as {
    organization: { id: string };
  };
  const orgId = created.organization.id;
  await b(`/api/app/organizations/${orgId}/onboarding`, { method: "PATCH", json: { finished: true } });
  return orgId;
}

const mine = {
  layout: "list",
  group: "assignee",
  sort: "priority",
  fields: {
    project: false,
    assignee: true,
    priority: true,
    due: false,
    criteria: true,
    pullRequest: false,
    label: true,
  },
  assignees: ["none"],
  priorities: ["high"],
  labels: ["bug"],
  done: "recent",
  showCanceled: true,
  hideEmpty: true,
  collapsed: ["high"],
  widths: { title: 420, label: 200 },
};

test("Tarefas' view: each person's own, per workspace, on every device; known parts only", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const orgId = await workspace(owner, "Acme");
  const path = `/api/app/organizations/${orgId}/me/issues-view`;
  const viewOf = async (b = owner, at = path) => ((await (await b(at)).json()) as { view: unknown }).view;

  // Never changed: the default.
  expect(await viewOf()).toEqual(ISSUES_VIEW_DEFAULT);

  const saved = await owner(path, { method: "PUT", json: { view: mine } });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ view: mine });
  expect(await viewOf()).toEqual(mine);

  // A filter twice is kept once; a part the app doesn't know is dropped.
  const twice = { ...mine, assignees: ["none", "none"], extra: 1 };
  expect(await (await owner(path, { method: "PUT", json: { view: twice } })).json()).toEqual({ view: mine });

  // An app from before projects saves its fields without `project`: the cards keep showing it.
  const { project: _project, ...older } = mine.fields;
  const fromOlder = await owner(path, { method: "PUT", json: { view: { ...mine, fields: older } } });
  expect(await fromOlder.json()).toEqual({ view: { ...mine, fields: { ...mine.fields, project: true } } });
  // An app from before the label filter, the finished tasks' choice, the folded groups and the columns' widths saves
  // without them: each goes back to its default.
  const {
    labels: _labels,
    done: _done,
    hideEmpty: _hideEmpty,
    collapsed: _collapsed,
    widths: _widths,
    ...before
  } = mine;
  const fromBefore = await owner(path, { method: "PUT", json: { view: before } });
  expect(await fromBefore.json()).toEqual({
    view: { ...mine, labels: [], done: "all", hideEmpty: false, collapsed: [], widths: {} },
  });
  // A column at its least and at its most is kept; every column can be given one.
  const ends = { title: ISSUE_COLUMN_WIDTHS.title.min, assignee: ISSUE_COLUMN_WIDTHS.assignee.max };
  const atEnds = await owner(path, { method: "PUT", json: { view: { ...mine, widths: ends } } });
  expect(await atEnds.json()).toEqual({ view: { ...mine, widths: ends } });
  const every = Object.fromEntries(Object.entries(ISSUE_COLUMN_WIDTHS).map(([column, w]) => [column, w.base]));
  const withEvery = await owner(path, { method: "PUT", json: { view: { ...mine, widths: every } } });
  expect(await withEvery.json()).toEqual({ view: { ...mine, widths: every } });
  await owner(path, { method: "PUT", json: { view: mine } });

  // A layout, a grouping, an order, a priority, an assignee or a width the app doesn't know, or a part missing:
  // refused, kept.
  const { showCanceled: _, ...partial } = mine;
  for (const bad of [
    { ...mine, layout: "grid" },
    { ...mine, group: "label" },
    { ...mine, sort: "random" },
    { ...mine, priorities: ["urgent"] },
    { ...mine, assignees: ["robot:1"] },
    { ...mine, fields: { ...mine.fields, label: "yes" } },
    // A column the list doesn't have, a width past its column's ends, half a pixel, not a number.
    { ...mine, widths: { number: 80 } },
    { ...mine, widths: { title: ISSUE_COLUMN_WIDTHS.title.min - 1 } },
    { ...mine, widths: { label: ISSUE_COLUMN_WIDTHS.label.max + 1 } },
    { ...mine, widths: { due: 120.5 } },
    { ...mine, widths: { due: "120" } },
    { ...mine, widths: [120] },
    partial,
  ])
    expect((await owner(path, { method: "PUT", json: { view: bad } })).status).toBe(400);
  expect(await viewOf()).toEqual(mine);

  // Someone else in the workspace keeps their own; so does the owner in another workspace.
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  expect(await viewOf(member)).toEqual(ISSUES_VIEW_DEFAULT);
  await member(path, { method: "PUT", json: { view: { ...ISSUES_VIEW_DEFAULT, layout: "list" } } });
  expect(await viewOf()).toEqual(mine);
  const other = await workspace(owner, "Beta");
  expect(await viewOf(owner, `/api/app/organizations/${other}/me/issues-view`)).toEqual(ISSUES_VIEW_DEFAULT);

  // "Voltar ao padrão".
  expect(await (await owner(path, { method: "PUT", json: { view: ISSUES_VIEW_DEFAULT } })).json()).toEqual({
    view: ISSUES_VIEW_DEFAULT,
  });
  expect(await viewOf(member)).toEqual({ ...ISSUES_VIEW_DEFAULT, layout: "list" });

  // Not a member (invited, not in yet): refused.
  await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email: "stranger@example.com" } });
  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com");
  expect((await stranger(path)).status).toBe(403);
  expect((await stranger(path, { method: "PUT", json: { view: mine } })).status).toBe(403);
});
