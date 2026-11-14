import { expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { Approval } from "../src/index";
import { digestCounts, digestGroups, digestRows } from "../src/lib/approval-card";
import { digestLine } from "../src/lib/approval-words";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-06T12:00:00Z");

const ask = (id: string, over: Partial<Approval> = {}): Approval => ({
  id,
  runId: `run-${id}`,
  agentId: "agent-ada",
  channelId: "c-eng",
  threadId: null,
  messageId: null,
  tool: "notes_create_page",
  scope: "custom:notes:write",
  title: `Create page ${id}`,
  detail: "",
  params: {},
  status: "pending",
  expiresAt: new Date(NOW + HOUR).toISOString(),
  createdAt: new Date(NOW - HOUR).toISOString(),
  decidedByUserId: null,
  decidedAt: null,
  reason: null,
  canDecide: true,
  routine: true,
  ...over,
});

const ids = (list: readonly Approval[]) => list.map((a) => a.id);

test("the routine group is what the server calls routine, still waits and is this person's to decide", () => {
  const items = [
    ask("a"),
    // A harmless name is not enough: only the server's word counts.
    ask("b", { routine: false }),
    ask("c", { routine: undefined }),
    // High risk by every word the app knows, and still the server's word alone decides.
    ask("d", { tool: "merge_pull_request", scope: "github:pr.merge" }),
    ask("e", { canDecide: false }),
    ask("f", { status: "approved" }),
    ask("g", { expiresAt: new Date(NOW - 1).toISOString() }),
    ask("h"),
  ];
  const groups = digestGroups(items, NOW);
  expect(ids(groups.routine)).toEqual(["a", "d", "h"]);
});

test("fewer than two routine ones are no group: each keeps its own card", () => {
  expect(digestGroups([ask("a"), ask("b", { routine: false }), ask("c", { routine: false })], NOW)).toEqual({
    routine: [],
  });
  expect(digestGroups([], NOW)).toEqual({ routine: [] });
});

test("a server that does not tell routine apart gives no group", () => {
  const old = ["a", "b", "c"].map((id) => ask(id, { routine: undefined }));
  expect(digestGroups(old, NOW).routine).toEqual([]);
});

test("the summary's first line counts what waits, and how it splits into routine and the rest", () => {
  const t = i18next.createInstance();
  void t.init({ lng: "pt-BR", fallbackLng: "en", resources, initAsync: false });
  const line = (items: Approval[]) => digestLine(t.t.bind(t) as unknown as TFunction, digestCounts(items, NOW));
  const risky = (id: string) => ask(id, { routine: false });
  expect(digestCounts([ask("a"), ask("b"), ask("c"), risky("d"), risky("e")], NOW)).toEqual({
    waiting: 5,
    routine: 3,
    careful: 2,
  });
  expect(line([ask("a"), ask("b"), ask("c"), risky("d"), risky("e")])).toBe(
    "5 aprovações esperando. 3 de rotina, 2 para olhar com calma.",
  );
  expect(line([ask("a"), ask("b")])).toBe("2 aprovações esperando. Todas de rotina.");
  // One routine request is no group: nothing splits.
  expect(line([ask("a"), risky("b")])).toBe("2 aprovações esperando.");
  expect(line([risky("a")])).toBe("1 aprovação esperando.");
  // Decided or past its deadline, a request no longer waits. With none left, the line goes.
  expect(line([ask("a", { status: "approved" }), ask("b", { expiresAt: new Date(NOW - 1).toISOString() })])).toBe("");
});

test("a routine group's rows: one agent's requests that read the same are one row, the first three show", () => {
  const titleOf = (a: Approval) => a.title;
  const detailOf = (a: Approval) => a.detail;
  const page = (id: string, over: Partial<Approval> = {}) =>
    ask(id, { title: "Create page", detail: `Note ${id}`, ...over });
  // Ten of one kind by one agent: one row with how many. What ten hold is too much to say under it.
  const ten = Array.from({ length: 10 }, (_, i) => page(String(i)));
  expect(digestRows(ten, titleOf, detailOf)).toEqual({
    rows: [{ id: "0", title: "Create page", agentId: "agent-ada", count: 10, detail: "" }],
    hidden: 0,
    folds: false,
  });
  // Up to three are said whole.
  expect(digestRows(ten.slice(0, 3), titleOf, detailOf).rows[0]?.detail).toBe("Note 0, Note 1, Note 2");
  // Another agent's, or another title, keeps its own row.
  const mixed = [page("a"), page("b", { agentId: "agent-theo" }), page("c", { title: "Update page" }), page("d")];
  expect(digestRows(mixed, titleOf, detailOf).rows.map((r) => [r.id, r.count, r.detail])).toEqual([
    ["a", 2, "Note a, Note d"],
    ["b", 1, "Note b"],
    ["c", 1, "Note c"],
  ]);
  // The same thing held twice is said once.
  expect(digestRows([page("a", { detail: "X" }), page("b", { detail: "X" })], titleOf, detailOf).rows[0]?.detail).toBe(
    "X",
  );

  const each = (n: number) => Array.from({ length: n }, (_, i) => page(String(i), { title: `Create page ${i}` }));
  // Four rows all show: a button would hide a single one.
  expect(digestRows(each(4), titleOf, detailOf)).toMatchObject({ hidden: 0, rows: { length: 4 } });
  // Past that, three show and the button counts the requests it holds back. Asked for, they all show.
  const long = [...each(9), page("x", { title: "Create page 8" })];
  const cut = digestRows(long, titleOf, detailOf);
  expect(cut.rows.map((r) => r.title)).toEqual(["Create page 0", "Create page 1", "Create page 2"]);
  expect(cut.hidden).toBe(7);
  // Shown whole it still folds, so it can close again.
  expect(cut.folds).toBe(true);
  expect(digestRows(long, titleOf, detailOf, true)).toMatchObject({ hidden: 0, rows: { length: 9 }, folds: true });
});
