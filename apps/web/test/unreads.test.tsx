import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedDm, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

/**
 * Não lidas (ADR 0260): the list's first row, and one page for everything waiting for the person, the inbox's items
 * that wait or came unread today, then every conversation with unread messages, mentions and DMs first.
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

type State = ReturnType<typeof seedState>;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const go = async (state: State, path = `c/${GENERAL_ID}`) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(10);
  return { ...r, state };
};
const nav = () => document.getElementById("app-nav") as HTMLElement;
const unreadsRow = () => within(nav()).getByRole("link", { name: /^Não lidas/ });
/** Nothing waits and nothing is unread: what each test adds is all there is. */
const calm = () => {
  const state = seedState();
  for (const a of state.approvals) a.status = "approved";
  for (const p of state.proposals) p.status = "accepted";
  return state;
};
/** #eng read an hour ago, with two messages since (one from João, one from Ada) and one before. */
const withUnreadEng = (state: State = calm(), mentions = 0) => {
  for (const c of state.channels)
    if (c.id === ENG_ID) Object.assign(c, { unreadCount: 2, mentionCount: mentions, lastReadAt: ago(90) });
  state.messages = [
    { ...(state.messages[0] as State["messages"][number]), id: "m-old", body: "Bom dia", createdAt: ago(200) },
    {
      ...(state.messages[0] as State["messages"][number]),
      id: "m-new",
      body: "O deploy caiu de novo",
      createdAt: ago(30),
    },
    {
      ...(state.messages[1] as State["messages"][number]),
      id: "m-ada",
      body: "Estou olhando os logs agora",
      createdAt: ago(20),
    },
  ];
  return state;
};

describe("the row on top of the list", () => {
  test("it opens Não lidas, bold while a conversation has something new, a red count for what waits on me", async () => {
    const state = withUnreadEng();
    state.notifications = [notification({ id: "n1", kind: "approval", waiting: true })];
    await go(state);
    expect(unreadsRow().getAttribute("href")).toBe(`/org/${ORG_ID}/unreads`);
    expect(unreadsRow().getAttribute("data-unread")).toBe("true");
    expect(within(unreadsRow()).getByRole("img", { name: "1 coisa esperando você" }).textContent).toBe("1");
    // The inbox has no tile of its own any more: Não lidas holds what waits.
    const column = within(nav()).getByRole("toolbar", { name: "Ferramentas" });
    expect(within(column).queryByRole("link", { name: /Caixa de entrada/ })).toBeNull();
    // Threads is the list's second row.
    expect(
      within(nav())
        .getByRole("link", { name: /^Threads/ })
        .getAttribute("href"),
    ).toBe(`/org/${ORG_ID}/threads`);
  });

  test("nothing new and nothing waiting: the row alone, not bold", async () => {
    await go(calm());
    expect(unreadsRow().getAttribute("data-unread")).toBe("false");
    expect(unreadsRow().textContent).toBe("Não lidas");
  });
});

describe("the page", () => {
  test("what waits for me on top, then each unread conversation with its unread messages only", async () => {
    const state = withUnreadEng();
    state.notifications = [
      notification({ id: "n1", kind: "approval", waiting: true, source: { approvalId: "ap-x" } }),
      notification({ id: "n2", kind: "mention", updatedAt: ago(400 * 60) }),
    ];
    await go(state, "unreads");
    expect(screen().getByRole("heading", { level: 1, name: "Não lidas" })).toBeTruthy();
    const forYou = screen().getByRole("region", { name: /Para você/ });
    // An unread one from yesterday is the inbox's history, not what waits now.
    expect(forYou.querySelectorAll(".ib-row")).toHaveLength(1);
    expect(within(forYou).getByRole("link", { name: "Ver tudo na caixa de entrada" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/notifications`,
    );
    const eng = screen().getByRole("article", { name: "#eng" });
    const said = [...eng.querySelectorAll(".unreads__msg-body")].map((m) => m.textContent);
    expect(said).toEqual(["O deploy caiu de novo", "Estou olhando os logs agora"]);
  });

  test("a mention or a DM comes before a channel that only has news; Marcar como lida and Marcar tudo como lido", async () => {
    const state = withUnreadEng();
    seedDm(state, { type: "agent", id: ADA_ID }, { ago: 300, unread: 1, body: "Terminei o relatório" });
    const { state: s } = await go(state, "unreads");
    const names = () => [...document.querySelectorAll(".unreads__conv")].map((c) => c.getAttribute("aria-label"));
    expect(names()).toEqual(["Ada", "#eng"]);
    const ada = screen().getByRole("article", { name: "Ada" });
    await act(async () => fireEvent.click(within(ada).getByRole("button", { name: "Marcar como lida" })));
    await settle(4);
    expect(s.calls.some((c) => c.method === "dms.markRead" && c.args[1] === `dm-${ADA_ID}`)).toBe(true);
    expect(names()).toEqual(["#eng"]);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Marcar tudo como lido" })));
    await settle(4);
    expect(s.calls.some((c) => c.method === "dms.markRead" && c.args[1] === ENG_ID)).toBe(true);
    expect(screen().getByText("Tudo em dia")).toBeTruthy();
  });

  test("a request opens in the inbox, where it is decided", async () => {
    const state = calm();
    state.notifications = [
      notification({ id: "n1", kind: "approval", waiting: true, source: { approvalId: "ap-merge" } }),
    ];
    const { router } = await go(state, "unreads");
    const forYou = screen().getByRole("region", { name: /Para você/ });
    await act(async () => fireEvent.click(forYou.querySelector(".ib-row") as HTMLElement));
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    expect(router.state.location.search).toMatchObject({ approval: "ap-merge" });
  });

  test("loading shows placeholders, and a list that fails says why with Tentar de novo, never an empty page", async () => {
    const api = createFakeApi(withUnreadEng());
    const load = api.notifications.list;
    api.notifications.list = () => new Promise(() => {});
    await renderApp(`/org/${ORG_ID}/unreads`, { api });
    await settle(6);
    expect(screen().getByRole("status", { name: "Carregando a lista" })).toBeTruthy();
    cleanup();

    api.notifications.list = () => Promise.reject(new Error("offline"));
    await renderApp(`/org/${ORG_ID}/unreads`, { api });
    await settle(30);
    const retry = screen().getByRole("button", { name: "Tentar de novo" });
    expect(screen().queryByRole("status", { name: "Carregando a lista" })).toBeNull();
    api.notifications.list = load;
    await act(async () => fireEvent.click(retry));
    await settle(10);
    expect(screen().queryByRole("button", { name: "Tentar de novo" })).toBeNull();
    expect(screen().getByRole("region", { name: /Conversas/ })).toBeTruthy();
  });
});
