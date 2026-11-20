import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import path from "node:path";
import type { Issue, IssuesView } from "@agenteschat/client";
import { ISSUE_COLUMN_WIDTHS, ISSUES_VIEW_DEFAULT } from "@agenteschat/client/lib/issues-view";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { atRule, declarations, topLevel } from "./built-css";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const listView = (over: Partial<IssuesView> = {}): IssuesView => ({
  ...structuredClone(ISSUES_VIEW_DEFAULT),
  layout: "list",
  ...over,
});
/** Tarefas as a list, the fake's tasks changed by `change` as the server would send them. */
const go = async (view = listView(), change: (i: Issue) => Issue = (i) => i) => {
  const state = seedState({ issuesView: view });
  const api = createFakeApi(state);
  const list = api.issues.list;
  api.issues.list = async (orgId, filters) => (await list(orgId, filters)).map(change);
  await renderApp(`/org/${ORG_ID}/issues`, { api });
  await settle(8);
  return { state, api };
};
const table = () => document.querySelector<HTMLElement>(".issue-table") as HTMLElement;
const columns = () =>
  [...table().querySelectorAll(".issue-table__head > [data-column]")].map((c) => c.getAttribute("data-column"));
const grip = (column: string) => screen().getByRole("separator", { name: `Redimensionar a coluna ${column}` });
const track = (column: string) => table().style.getPropertyValue(`--col-${column}`);
const pointer = (x: number, pointerType = "mouse") => ({
  pointerId: 1,
  pointerType,
  button: 0,
  buttons: 1,
  clientX: x,
  clientY: 10,
});
/** A drag of a column's handle from 500 to `to` on the screen, let go unless `hold`. */
const dragTo = async (el: Element, to: number, { hold = false, pointerType = "mouse" } = {}) => {
  await act(async () => fireEvent.pointerDown(el, pointer(500, pointerType)));
  await act(async () => fireEvent.pointerMove(el, pointer(to, pointerType)));
  if (!hold) await act(async () => fireEvent.pointerUp(el, pointer(to, pointerType)));
  await settle(3);
};
const key = async (el: Element, k: string) => {
  await act(async () => fireEvent.keyDown(el, { key: k }));
  await settle(3);
};
const { label, title, due } = ISSUE_COLUMN_WIDTHS;

describe("Tarefas' list as a table", () => {
  test("every column turned on in Display shows, whether or not a task has it; one turned off takes no room", async () => {
    // No task with a project, a label, a priority, a date, criteria, a pull request or an assignee.
    const bare = (i: Issue): Issue => ({
      ...i,
      project: null,
      labels: [],
      priority: "normal",
      dueDate: null,
      criteria: [],
      pullRequests: [],
      githubUrl: null,
      assignees: [],
    });
    await go(listView(), bare);
    expect(columns()).toEqual(["title", "project", "label", "priority", "due", "criteria", "pullRequest", "assignee"]);
    // Each at its own width, the title taking the room left over; a hairline starts each column after the title.
    expect(track("title")).toBe(`minmax(${title.base}px, 1fr)`);
    expect(track("fill")).toBe("0px");
    expect(track("label")).toBe(`${label.base}px`);
    expect(track("assignee")).toBe(`${ISSUE_COLUMN_WIDTHS.assignee.base}px`);
    expect([...table().querySelectorAll(".issue-table__rule")].map((r) => r.getAttribute("data-column"))).toEqual(
      columns().slice(1),
    );
    cleanup();

    const fields = { ...ISSUES_VIEW_DEFAULT.fields, due: false, pullRequest: false };
    await go(listView({ fields }));
    expect(columns()).toEqual(["title", "project", "label", "priority", "criteria", "assignee"]);
    expect(track("due")).toBe("0px");
    expect(track("pullRequest")).toBe("0px");
    expect(screen().queryByRole("separator", { name: "Redimensionar a coluna Prazo" })).toBeNull();
  });

  test("a group is a band across the table: its fold button, name and count, its rows right under it", async () => {
    const { state } = await go();
    const todo = screen().getByRole("region", { name: "A fazer" });
    const band = todo.querySelector(":scope > .ac-grouphead") as HTMLElement;
    expect(within(band).getByRole("button", { name: "Recolher A fazer" })).toBeTruthy();
    const count = Number(band.querySelector("[data-count]")?.textContent);
    expect(within(todo).getAllByRole("link", { name: /^#\d+/ })).toHaveLength(count);
    await act(async () => fireEvent.click(within(band).getByRole("button", { name: "Recolher A fazer" })));
    await settle(3);
    expect(state.issuesView?.collapsed).toHaveLength(1);
    const folded = screen().getByRole("region", { name: "A fazer" });
    expect(within(folded).queryAllByRole("link", { name: /^#\d+/ })).toHaveLength(0);
    expect(folded.querySelector("[data-count]")?.textContent).toBe(String(count));
  });

  test("dragging a column name's end sizes the column: the table follows, the view keeps it once let go", async () => {
    const { state } = await go();
    const el = grip("Rótulo");
    expect(el.getAttribute("aria-orientation")).toBe("vertical");
    expect(el.getAttribute("tabindex")).toBe("0");
    expect(el.getAttribute("aria-valuenow")).toBe(String(label.base));
    expect(el.getAttribute("aria-valuemin")).toBe(String(label.min));
    expect(el.getAttribute("aria-valuemax")).toBe(String(label.max));
    const guide = table().querySelector(".issue-table__guide") as HTMLElement;
    expect(guide.hidden).toBe(true);

    // While it moves: the column follows and a line runs down the table at its end; nothing is saved yet.
    await dragTo(el, 560, { hold: true });
    expect(track("label")).toBe(`${label.base + 60}px`);
    expect(guide.hidden).toBe(false);
    expect(guide.style.gridColumn).toBe("label / priority");
    expect(el.getAttribute("aria-valuenow")).toBe(String(label.base + 60));
    expect(state.calls.filter((c) => c.method === "orgs.setIssuesView")).toHaveLength(0);
    await act(async () => fireEvent.pointerMove(el, pointer(540)));
    expect(state.calls.filter((c) => c.method === "orgs.setIssuesView")).toHaveLength(0);

    // Let go: saved once, with the grouping and the filters.
    await act(async () => fireEvent.pointerUp(el, pointer(540)));
    await settle(3);
    expect(state.calls.filter((c) => c.method === "orgs.setIssuesView")).toHaveLength(1);
    expect(state.issuesView).toEqual(listView({ widths: { label: label.base + 40 } }));
    expect(track("label")).toBe(`${label.base + 40}px`);
    expect(guide.hidden).toBe(true);
    expect(grip("Rótulo").getAttribute("aria-valuenow")).toBe(String(label.base + 40));

    // A finger drags it the same way.
    await dragTo(grip("Prazo"), 520, { pointerType: "touch" });
    expect(state.issuesView?.widths).toEqual({ label: label.base + 40, due: due.base + 20 });
  });

  test("a column stops at its least and its most; the title's least is the largest", async () => {
    const { state } = await go();
    await dragTo(grip("Rótulo"), -2000);
    expect(state.issuesView?.widths).toEqual({ label: label.min });
    await dragTo(grip("Rótulo"), 9000);
    expect(state.issuesView?.widths).toEqual({ label: label.max });
    // The title takes the room left over until it is dragged: from then on it has a width, the room left over
    // stays after the last column and a hairline closes that column.
    await dragTo(grip("Tarefa"), -2000);
    expect(state.issuesView?.widths).toEqual({ label: label.max, title: title.min });
    expect(title.min).toBeGreaterThan(label.min);
    expect(track("title")).toBe(`${title.min}px`);
    expect(track("fill")).toBe("minmax(0, 1fr)");
    expect(table().querySelector('.issue-table__rule[data-column="fill"]')).toBeTruthy();
  });

  test("dragged back to its own width, or a drag given up, keeps nothing", async () => {
    const { state } = await go(listView({ widths: { label: 200 } }));
    const saves = () => state.calls.filter((c) => c.method === "orgs.setIssuesView").length;
    expect(track("label")).toBe("200px");
    // The browser takes the pointer away (a call comes in, the window loses it): the column goes back.
    const el = grip("Rótulo");
    await act(async () => fireEvent.pointerDown(el, pointer(500)));
    await act(async () => fireEvent.pointerMove(el, pointer(580)));
    expect(track("label")).toBe("280px");
    await act(async () => fireEvent.pointerCancel(el, pointer(580)));
    await settle(3);
    expect(track("label")).toBe("200px");
    expect(el.getAttribute("aria-valuenow")).toBe("200");
    expect(saves()).toBe(0);
    // A press with no move saves nothing.
    await dragTo(el, 500);
    expect(saves()).toBe(0);
    // Back to the column's own width: no longer among the changed ones.
    await dragTo(grip("Rótulo"), 500 - (200 - label.base));
    expect(state.issuesView?.widths).toEqual({});
    expect(track("label")).toBe(`${label.base}px`);
  });

  test("a double click on a column name's end gives the column its own width back", async () => {
    const { state } = await go(listView({ widths: { label: 240, title: 400 } }));
    expect(track("label")).toBe("240px");
    await act(async () => fireEvent.doubleClick(grip("Rótulo")));
    await settle(3);
    expect(state.issuesView?.widths).toEqual({ title: 400 });
    expect(track("label")).toBe(`${label.base}px`);
    // The title takes the room left over again.
    await act(async () => fireEvent.doubleClick(grip("Tarefa")));
    await settle(3);
    expect(state.issuesView?.widths).toEqual({});
    expect(track("title")).toBe(`minmax(${title.base}px, 1fr)`);
    expect(track("fill")).toBe("0px");
  });

  test("with the keyboard: the arrows move a column's end a step, Home and End to its ends, Enter back to its own", async () => {
    const { state } = await go();
    const el = () => grip("Rótulo");
    el().focus();
    await key(el(), "ArrowRight");
    expect(state.issuesView?.widths).toEqual({ label: label.base + 16 });
    await key(el(), "ArrowRight");
    await key(el(), "ArrowLeft");
    await key(el(), "ArrowLeft");
    await key(el(), "ArrowLeft");
    expect(state.issuesView?.widths).toEqual({ label: label.base - 16 });
    expect(el().getAttribute("aria-valuenow")).toBe(String(label.base - 16));
    await key(el(), "Home");
    expect(state.issuesView?.widths).toEqual({ label: label.min });
    await key(el(), "ArrowLeft");
    expect(state.issuesView?.widths).toEqual({ label: label.min });
    await key(el(), "End");
    expect(state.issuesView?.widths).toEqual({ label: label.max });
    await key(el(), "Enter");
    expect(state.issuesView?.widths).toEqual({});
    // Any other key is not the handle's.
    const other = fireEvent.keyDown(el(), { key: "a" });
    expect(other).toBe(true);
  });

  test("the handle is its own control: a press on it orders nothing, opens nothing and picks no row up", async () => {
    const { state } = await go();
    const el = grip("Prioridade");
    // The press is taken (no text selected, nothing started under it) and its click orders nothing.
    let allowed = true;
    await act(async () => {
      allowed = fireEvent.pointerDown(el, pointer(500));
    });
    expect(allowed).toBe(false);
    await act(async () => fireEvent.pointerUp(el, pointer(500)));
    await act(async () => fireEvent.click(el));
    await settle(3);
    expect(state.issuesView?.sort ?? "manual").toBe("manual");
    expect(document.body.classList.contains("issues-dragging")).toBe(false);
    expect(document.querySelector(".issue-ghost")).toBeNull();
    // Another mouse button is not a drag.
    await act(async () => fireEvent.pointerDown(el, { ...pointer(500), button: 2 }));
    await act(async () => fireEvent.pointerMove(el, pointer(600)));
    expect(track("priority")).toBe(`${ISSUE_COLUMN_WIDTHS.priority.base}px`);
    // The column's name still orders the list.
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Prioridade", pressed: false })));
    await settle(3);
    expect(state.issuesView?.sort).toBe("priority");
  });

  test('"Back to default" in Display gives every column its own width back', async () => {
    const { state } = await go(listView({ layout: "board", widths: { label: 240 } }));
    await act(async () => fireEvent.click(screen().getByRole("button", { name: /^Exibição: / })));
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "Exibição" });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Voltar ao padrão" })));
    await settle(3);
    expect(state.issuesView).toEqual(ISSUES_VIEW_DEFAULT);
  });
});

describe("the table's CSS", () => {
  const ROOT = path.join(import.meta.dir, "../../..");
  const sheet = () => Bun.file(path.join(ROOT, "apps/web/src/pages/issues.css")).text();
  const last = (pairs: (readonly [string, string])[], property: string) => pairs.findLast(([p]) => p === property)?.[1];
  const wide = async () => atRule(await sheet(), "@media (min-width: 721px)");

  test("flat: no card around a group's rows, a hairline under each row, a quiet hover", async () => {
    const css = await sheet();
    const top = topLevel(css);
    for (const p of ["border-radius", "box-shadow", "background", "overflow"])
      expect([p, last(declarations(top, ".issue-list"), p)]).toEqual([p, undefined]);
    expect(last(declarations(top, ".issues-group__col"), "border-radius")).toBeUndefined();
    const table = await wide();
    expect(last(declarations(table, ".issue-table .issue-list > li[data-slot]"), "border-bottom")).toBe(
      "1px solid var(--line)",
    );
    expect(last(declarations(top, ".issue-list__row:hover"), "background")).toBe(
      "color-mix(in srgb, var(--ink) 4%, transparent)",
    );
    // The groups stand with no gap between them, each one's band on its rows.
    expect(last(declarations(table, ".issue-table"), "gap")).toBe("0");
    expect(last(declarations(table, ".issue-table .ac-grouphead"), "margin")).toBe("0");
  });

  test("the column names stay at the top of a box that scrolls both ways, filled so no row shows through", async () => {
    const table = await wide();
    // A box that scrolled sideways only would hold the names still against itself: it scrolls both ways.
    const wrap = declarations(table, ".issue-tablewrap");
    expect(last(wrap, "overflow-x")).toBe("auto");
    expect(last(wrap, "overflow-y")).toBe("auto");
    // Where the page scrolls, the table is shorter than the window, so its names always have a top to stay at.
    expect(last(wrap, "max-height")).toBe("calc(100dvh - 160px)");
    const filling = atRule(await sheet(), "@media (min-width: 941px) and (min-height: 560px)");
    expect(last(declarations(filling, ".issue-tablewrap"), "max-height")).toBe("none");
    const head = declarations(table, ".issue-table__head");
    expect(last(head, "position")).toBe("sticky");
    expect(last(head, "top")).toBe("0");
    expect(last(head, "border-block")).toBe("1px solid var(--line)");
    // Mixed onto the page's own surface: nothing clear in it.
    expect(last(head, "background")).toBe("color-mix(in srgb, var(--ink) 3%, var(--surface))");
    // Over the groups' bands, which go under it; the bands over the columns' hairlines and the line of a drag.
    const band = declarations(table, ".issue-table .ac-grouphead");
    expect(last(band, "background")).toBe("color-mix(in srgb, var(--ink) 5%, var(--surface))");
    expect(last(band, "border-bottom")).toBe("1px solid var(--line)");
    expect(last(band, "z-index")).toBe("var(--z-lifted)");
    expect(last(head, "z-index")).toBe("calc(var(--z-lifted) + 1)");
    const lines = declarations(table, ".issue-table > :is(.issue-table__rule, .issue-table__guide)");
    expect(last(lines, "z-index")).toBe("var(--z-raised)");
    expect(last(lines, "inset-block")).toBe("0");
    expect(last(lines, "pointer-events")).toBe("none");
    // The line of a drag is ink, never the agents' color.
    expect(last(declarations(table, ".issue-table > .issue-table__guide"), "background")).toBe("var(--ink)");
  });

  test("columns keep their widths: the title on one line ending in “…”, every cell cut inside its column", async () => {
    const table = await wide();
    const grid = last(declarations(table, ".issue-table"), "grid-template-columns") ?? "";
    for (const column of Object.keys(ISSUE_COLUMN_WIDTHS)) expect(grid).toContain(`[${column}] var(--col-${column})`);
    expect(grid).toContain("[fill] var(--col-fill)");
    const titleCell = declarations(table, ".issue-table .issue-list__title");
    expect(last(titleCell, "white-space")).toBe("nowrap");
    expect(last(titleCell, "text-overflow")).toBe("ellipsis");
    expect(last(titleCell, "overflow")).toBe("hidden");
    // A long title never widens its column.
    expect(last(titleCell, "width")).toBe("0");
    const fact = declarations(table, ".issue-table .issue-card__facts > .ac-factline__fact");
    expect(last(fact, "white-space")).toBe("nowrap");
    expect(last(fact, "text-overflow")).toBe("ellipsis");
    expect(last(fact, "overflow")).toBe("hidden");
    expect(last(fact, "max-width")).toBe("calc(100% - 20px)");
  });

  test("the handle takes a finger's drag for itself, shows its focus, and nothing in the table is a literal color", async () => {
    const css = await sheet();
    const top = topLevel(css);
    const handle = declarations(top, ".issue-table__grip");
    expect(last(handle, "touch-action")).toBe("none");
    expect(last(handle, "cursor")).toBe("col-resize");
    expect(last(declarations(top, "html:not([data-pointer]) .issue-table__grip:focus-visible"), "box-shadow")).toBe(
      "var(--focus-ring)",
    );
    // Wider and always drawn where there is no hover to find it by.
    expect(last(declarations(atRule(css, "@media (hover: none)"), ".issue-table__grip"), "width")).toBe("20px");
    const list = css.slice(css.indexOf("/* ── List ─"), css.indexOf("/* ── Moving cards"));
    expect(list.length).toBeGreaterThan(2000);
    expect(list.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|!important|var\(--agent\)/gi)).toBeNull();
  });
});
