import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ATLAS_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** Channels in sectors (ADR 0240): picked as a channel is made; the sidebar shows none of them (ADR 0260). */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

type State = ReturnType<typeof seedState>;
const SUPPORT = "00000000-0000-4000-8000-0000000000f1";
const SALES = "00000000-0000-4000-8000-0000000000f2";
const DESIGN_ID = "00000000-0000-4000-8000-0000000000c3";
const ALERTS_ID = "00000000-0000-4000-8000-0000000000c4";

/**
 * Acme with the sectors Suporte (Atlas; #eng, #design and #alerts, 2 unread) and Vendas (no agent, no channel); #general
 * in none. Atlas wrote to me: 3 unread in our DM.
 */
function acme(): State {
  const state = seedState();
  state.agentGroups = [
    { id: SUPPORT, name: "Suporte", agentIds: [ATLAS_ID], color: "teal", icon: "chat" },
    { id: SALES, name: "Vendas", agentIds: [], color: "amber", icon: "person" },
  ];
  const eng = state.channels.find((c) => c.id === ENG_ID);
  if (!eng) throw new Error("no #eng");
  eng.groupId = SUPPORT;
  state.channels.push(
    { ...eng, id: DESIGN_ID, name: "design" },
    { ...eng, id: ALERTS_ID, name: "alerts", unreadCount: 2 },
  );
  seedDm(state, { type: "agent", id: ATLAS_ID }, { unread: 3 });
  return state;
}
const go = async (state: State = acme(), { api = createFakeApi(state), channel = GENERAL_ID } = {}) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${channel}`, { api });
  await settle(8);
  return { ...r, state };
};
const nav = () => screen().getByRole("navigation", { name: "Navegação do workspace" });
/** A channel's row, in sight or not (a hidden one has no accessible name to find it by). */
const channel = (name: string) => {
  const row = nav().querySelector(`a.sidebar__item[title="#${name}"]`);
  if (!row) throw new Error(`no #${name} in the sidebar`);
  return row;
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
describe("the sidebar (ADR 0260)", () => {
  test("no sector shows in it: every channel is in Canais, a sector's too", async () => {
    await go();
    expect(within(nav()).queryByRole("button", { name: "Suporte" })).toBeNull();
    expect(within(nav()).queryByRole("button", { name: "Vendas" })).toBeNull();
    for (const name of ["general", "eng", "design", "alerts"]) expect(channel(name)).toBeTruthy();
  });
});

describe("Criar canal", () => {
  test("picks the sector the channel starts in", async () => {
    const { state } = await go();
    const plus = within(nav()).getByRole("button", { name: "Novo canal" });
    await act(async () => {
      fireEvent.keyDown(plus, { key: "Enter" });
      fireEvent.keyUp(plus, { key: "Enter" });
    });
    await settle(2);
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Novo canal" }));
    const dialog = screen().getByRole("dialog", { name: "Criar canal" });
    await act(async () => fireEvent.change(within(dialog).getByLabelText("Nome"), { target: { value: "vendas" } }));
    const picker = within(dialog).getByRole("combobox", { name: "Setor" });
    picker.focus();
    await act(async () => fireEvent.keyDown(picker, { key: "Enter" }));
    await click(screen().getByRole("option", { name: "Vendas" }));
    await click(within(dialog).getByRole("button", { name: "Criar #vendas" }));
    await settle(6);
    const made = state.calls.filter((c) => c.method === "chat.createChannel").map((c) => c.args[1]);
    expect(made).toEqual([expect.objectContaining({ name: "vendas", groupId: SALES })]);
  });
});
