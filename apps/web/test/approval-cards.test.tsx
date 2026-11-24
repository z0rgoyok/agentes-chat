import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/* Requests are decided in the inbox, on the conversation's own card open beside the list (ADR 0218). */

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
/** A request waiting on me: its notification, the inbox's row. */
const asked = (approvalId: string, agentId = ADA_ID) =>
  notification({
    id: `n-${approvalId}`,
    kind: "approval",
    waiting: true,
    actors: [{ type: "agent", id: agentId }],
    source: { approvalId, channelId: ENG_ID },
  });
/** The fake backend's state with these requests waiting in my inbox, and no proposal among them. */
const inbox = (...items: ReturnType<typeof asked>[]) => seedState({ notifications: items, proposals: [] });
const row = (approvalId: string) => document.querySelector(`.ib-row[data-n="n-${approvalId}"]`) as HTMLElement;
/** The request open beside the list. */
const card = () => document.querySelector(".ib-read .rq") as HTMLElement;
const title = () => card().querySelector(".rq__well b")?.textContent;
const ids = (el: Element) => [...el.querySelectorAll("[data-approve]")].map((b) => b.getAttribute("data-approve"));

describe("The inbox: requests sharing a card", () => {
  test("come together on one card with 'Approve all', which decides exactly them", async () => {
    const state = inbox(asked("ap-g1"), asked("ap-deploy", ATLAS_ID));
    const [merge] = state.approvals;
    if (!merge) throw new Error("no approval");
    const goal = (id: string, month: string, minutes: number) => ({
      ...merge,
      id,
      tool: "goal_upsert",
      title: `Meta de ${month}`,
      detail: `panel.goal_upsert · month=${month}`,
      params: { month },
      createdAt: new Date(Date.now() - minutes * 60_000).toISOString(),
    });
    state.approvals.splice(0, 1, goal("ap-g1", "2026-11", 3), goal("ap-g2", "2026-12", 2));
    await renderApp(`/org/${ORG_ID}/notifications`, { api: createFakeApi(state) });
    await settle(4);
    // The request without a card stands alone, on a card of its own.
    await click(row("ap-deploy"));
    expect(card().getAttribute("data-ask-id")).toBe("ap-deploy");
    expect(card().querySelector(".rq__items")).toBeNull();
    await click(row("ap-g1"));
    const group = card();
    expect(group.querySelector(".rq__lead")?.textContent).toBe("Preciso do seu ok para seguir com estes 2:");
    // Each request a row of the card, with its values and its own decision.
    const items = [...group.querySelectorAll(".rq__items > .rq__item")];
    expect(items.map((li) => ids(li))).toEqual([["ap-g1"], ["ap-g2"]]);
    expect(items.map((li) => li.querySelector(".rq__wt small")?.textContent)).toEqual([
      "panel.goal_upsert · month=2026-11",
      "panel.goal_upsert · month=2026-12",
    ]);
    // Its two buttons over them all are one group, in the card's footer.
    const foot = group.querySelector(".rq__foot") as HTMLElement;
    expect([...foot.querySelectorAll(":scope > button")].map((b) => b.textContent)).toEqual([
      "Aprovar tudo",
      "Agora não para todos",
    ]);
    await click(within(foot).getByRole("button", { name: "Aprovar tudo" }));
    expect(state.calls.find((c) => c.method === "approvals.decideMany")?.args).toEqual([
      ORG_ID,
      ["ap-g1", "ap-g2"],
      "approve",
    ]);
    expect(state.approvals.filter((a) => a.id.startsWith("ap-g")).map((a) => a.status)).toEqual([
      "approved",
      "approved",
    ]);
  });

  test("waiting requests of one kind in a row: one run, 'Approve all', unfolding into each", async () => {
    const state = inbox(asked("ap-s1"));
    const [merge] = state.approvals;
    if (!merge) throw new Error("no approval");
    const sql = (id: string, query: string, minutes: number) => ({
      ...merge,
      id,
      tool: "supabase_execute_sql",
      title: "Supabase: Execute sql",
      detail: `execute_sql · query=${query}`,
      params: { query },
      createdAt: new Date(Date.now() - minutes * 60_000).toISOString(),
    });
    state.approvals.splice(0, 1, sql("ap-s1", "select 1", 4), sql("ap-s2", "select 2", 3), sql("ap-s3", "select 3", 2));
    await renderApp(`/org/${ORG_ID}/notifications`, { api: createFakeApi(state) });
    await settle(4);
    const run = card();
    expect(title()).toMatch(/^3 pedidos de Ada para /);
    // The card is the run: its requests folded, none with a button of its own.
    expect(run.querySelector(".rq__items")).toBeNull();
    expect(ids(run)).toEqual(["all-ap-s1"]);
    await click(within(run).getByRole("button", { name: "Ver cada um" }));
    expect(within(run).getByRole("button", { name: "Ver cada um" }).getAttribute("aria-expanded")).toBe("true");
    expect(ids(card().querySelector(".rq__items") as HTMLElement)).toEqual(["ap-s1", "ap-s2", "ap-s3"]);
    // Deciding its first request alone keeps the rest unfolded: a run of two now, under the decided one.
    await click(card().querySelector('[data-approve="ap-s1"]') as HTMLElement);
    expect(state.calls.find((c) => c.method === "approvals.approve")?.args.slice(0, 2)).toEqual([ORG_ID, "ap-s1"]);
    expect(ids(card().querySelector(".rq__run .rq__items") as HTMLElement)).toEqual(["ap-s2", "ap-s3"]);
    await click(within(card()).getByRole("button", { name: "Aprovar todos" }));
    expect(state.calls.find((c) => c.method === "approvals.decideMany")?.args).toEqual([
      ORG_ID,
      ["ap-s2", "ap-s3"],
      "approve",
    ]);
  });
});

describe("The inbox: the request beside the list", () => {
  /** The seed's first request as a GitHub comment whose server title is only the tool's name. */
  function withComment() {
    const state = inbox(asked("ap-merge"), asked("ap-deploy", ATLAS_ID));
    const merge = state.approvals.find((a) => a.id === "ap-merge");
    if (!merge) throw new Error("no approval");
    Object.assign(merge, {
      tool: "add_issue_comment",
      scope: "github:issues.write",
      title: "GitHub: add_issue_comment",
      detail: "add_issue_comment · acme/loja · issue 45",
      connector: "github",
      params: { owner: "acme", repo: "loja", issue_number: 45, body: "Os testes passaram. Pode revisar?" },
    });
    return state;
  }

  test("one row per request; the selected one opens beside it with its action in words and the decision", async () => {
    const state = withComment();
    await renderApp(`/org/${ORG_ID}/notifications`, { api: createFakeApi(state) });
    await settle(6);
    const list = screen().getByRole("region", { name: "Esperando você" });
    expect(list.contains(row("ap-merge"))).toBe(true);
    expect(list.contains(row("ap-deploy"))).toBe(true);
    await click(row("ap-merge"));
    expect(row("ap-merge").getAttribute("aria-current")).toBe("true");
    expect(row("ap-deploy").getAttribute("aria-current")).toBeNull();
    expect(card().getAttribute("data-ask-id")).toBe("ap-merge");
    expect(card().querySelector(".rq__kind")?.textContent).toBe("Ada · Pede sua aprovação");
    // The server's title was only the tool's name: the tool in words, and the comment it will publish under it.
    expect(title()).toBe("Comentar numa issue");
    expect(card().querySelector(".rq__wt small")?.textContent).toContain("Os testes passaram. Pode revisar?");
    // Its foot holds the decision and how long is left, with no line of words among the buttons.
    const foot = card().querySelector(".rq__foot") as HTMLElement;
    expect(foot.querySelector(":scope > p")).toBeNull();
    expect([...foot.querySelectorAll(":scope > button")].map((b) => b.textContent)).toEqual(["Aprovar", "Agora não"]);
    expect(foot.querySelector(".rq__end")?.textContent).toMatch(/para decidir$/);
    await click(foot.querySelector('[data-approve="ap-merge"]') as HTMLElement);
    expect(state.calls.find((c) => c.method === "approvals.approve")?.args).toEqual([ORG_ID, "ap-merge", undefined]);
  });

  test("J and K walk the requests; Escape in the reason backs out of refusing", async () => {
    await renderApp(`/org/${ORG_ID}/notifications`, { api: createFakeApi(withComment()) });
    await settle(6);
    const key = async (target: Element, k: string) => {
      await act(async () => fireEvent.keyDown(target, { key: k }));
      await settle(4);
    };
    const rows = [...document.querySelectorAll<HTMLElement>(".ib-list .ib-row")];
    const [first, second] = rows.map((r) => (r.dataset.n ?? "").replace(/^n-/, ""));
    if (!first || !second) throw new Error("two requests");
    // Nothing chosen: the first row is open.
    expect(card().getAttribute("data-ask-id")).toBe(first);
    await key(document.body, "j");
    expect(card().getAttribute("data-ask-id")).toBe(second);
    expect(document.activeElement).toBe(row(second));
    expect(row(second).getAttribute("aria-current")).toBe("true");
    await key(document.body, "k");
    expect(card().getAttribute("data-ask-id")).toBe(first);
    await click(row("ap-merge"));
    await click(within(card()).getByRole("button", { name: "Agora não" }));
    const reason = within(card()).getByLabelText("Por que não?");
    // Escape inside the reason backs out of refusing.
    await key(reason, "Escape");
    expect(within(card()).queryByLabelText("Por que não?")).toBeNull();
    expect(card().querySelector('[data-approve="ap-merge"]')).not.toBeNull();
  });
});
