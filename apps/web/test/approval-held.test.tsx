import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/*
 * An approved request still waiting for one its agent was told already waited (ADR 0182, addendum of 2026-11-24): its
 * card names that one with a link and offers what moves it; and the inbox decides every request of one agent at once.
 */

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const asked = (approvalId: string, agentId = ADA_ID) =>
  notification({
    id: `n-${approvalId}`,
    kind: "approval",
    waiting: true,
    actors: [{ type: "agent", id: agentId }],
    source: { approvalId, channelId: ENG_ID },
  });

/** Ada's quote approved, behind her earlier merge still waiting, asked from another conversation on another card. */
function heldState() {
  const state = seedState({ notifications: [asked("ap-first")], proposals: [] });
  const [merge] = state.approvals;
  if (!merge) throw new Error("no approval");
  const base = { ...merge, tool: "crm_send_quote", scope: "custom:crm:write", connector: null, params: {} };
  state.approvals.splice(
    0,
    1,
    {
      ...merge,
      id: "ap-first",
      runId: "run-first",
      messageId: "msg-first",
      createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    },
    {
      ...base,
      id: "ap-later",
      runId: "run-later",
      messageId: "msg-later",
      title: "Orçamento para Caio Lima",
      status: "approved",
      canDecide: false,
      decidedByUserId: "u-walter",
      decidedAt: new Date(Date.now() - 60_000).toISOString(),
      createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      afterIds: ["ap-first"],
      canRunNow: true,
    },
  );
  return state;
}

describe("An approved request waiting for another", () => {
  test("names what it waits for, with Aprovar and Recusar for that one and 'Rodar este agora'", async () => {
    const state = heldState();
    await renderApp(`/org/${ORG_ID}/notifications?approval=ap-later`, { api: createFakeApi(state) });
    await settle(6);
    const held = document.querySelector(".ib-read .ap-held") as HTMLElement;
    // The one it waits for by its title, a link that opens it in place.
    const link = within(held).getByRole("link");
    expect(link.getAttribute("href")).toContain("ap-first");
    expect(held.querySelector(".ap-held__text")?.textContent).toBe(`Esperando ${link.textContent}`);
    expect([...held.querySelectorAll(".ap-held__acts button")].map((b) => b.textContent)).toEqual([
      "Aprovar merge",
      "Recusar",
      "Rodar este agora",
    ]);
    await click(within(held).getByRole("button", { name: "Rodar este agora" }));
    expect(state.calls.find((c) => c.method === "approvals.runNow")?.args).toEqual([ORG_ID, "ap-later"]);
    // Nothing holds it any more: the line goes.
    expect(document.querySelector(".ib-read .ap-held")).toBeNull();
  });

  test("Recusar on the line refuses the request it waits for", async () => {
    const state = heldState();
    await renderApp(`/org/${ORG_ID}/notifications?approval=ap-later`, { api: createFakeApi(state) });
    await settle(6);
    const held = document.querySelector(".ib-read .ap-held") as HTMLElement;
    await click(within(held).getByRole("button", { name: "Recusar" }));
    expect(state.calls.find((c) => c.method === "approvals.refuse")?.args.slice(0, 2)).toEqual([ORG_ID, "ap-first"]);
  });

  test("told about none, or the other one waiting over half an hour: no line", async () => {
    const state = heldState();
    const later = state.approvals.find((a) => a.id === "ap-later");
    if (!later) throw new Error("no approval");
    later.afterIds = [];
    await renderApp(`/org/${ORG_ID}/notifications?approval=ap-later`, { api: createFakeApi(state) });
    await settle(6);
    expect(document.querySelector(".ib-read .rq")).not.toBeNull();
    expect(document.querySelector(".ib-read .ap-held")).toBeNull();
    cleanup();
    const stale = heldState();
    const first = stale.approvals.find((a) => a.id === "ap-first");
    if (!first) throw new Error("no approval");
    first.createdAt = new Date(Date.now() - 31 * 60_000).toISOString();
    await renderApp(`/org/${ORG_ID}/notifications?approval=ap-later`, { api: createFakeApi(stale) });
    await settle(6);
    expect(document.querySelector(".ib-read .rq")).not.toBeNull();
    expect(document.querySelector(".ib-read .ap-held")).toBeNull();
  });
});

describe("The inbox: every request of one agent at once", () => {
  test("'Aprovar todos' and 'Recusar todos' per agent decide exactly that agent's requests", async () => {
    const state = seedState({
      notifications: [asked("ap-a1"), asked("ap-a2"), asked("ap-deploy", ATLAS_ID)],
      proposals: [],
    });
    const [merge] = state.approvals;
    if (!merge) throw new Error("no approval");
    const ask = (id: string, minutes: number) => ({
      ...merge,
      id,
      runId: `run-${id}`,
      messageId: `msg-${id}`,
      tool: "crm_send_quote",
      title: `Orçamento ${id}`,
      createdAt: new Date(Date.now() - minutes * 60_000).toISOString(),
    });
    state.approvals.splice(0, 1, ask("ap-a1", 4), ask("ap-a2", 3));
    await renderApp(`/org/${ORG_ID}/notifications`, { api: createFakeApi(state) });
    await settle(6);
    const waiting = screen().getByRole("region", { name: "Esperando você" });
    const rows = [...waiting.querySelectorAll(".ap-agents__row")] as HTMLElement[];
    // Atlas has one request: its own card decides it.
    expect(rows.map((r) => r.querySelector(".ap-agents__who")?.textContent)).toEqual(["2 pedidos de Ada"]);
    const [ada] = rows;
    if (!ada) throw new Error("no row");
    await click(within(ada).getByRole("button", { name: "Recusar todos" }));
    expect(state.calls.find((c) => c.method === "approvals.decideMany")?.args).toEqual([
      ORG_ID,
      ["ap-a1", "ap-a2"],
      "refuse",
    ]);
  });
});
