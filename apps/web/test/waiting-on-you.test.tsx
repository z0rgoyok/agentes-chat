import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AppNotification } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** A question at its worst: no place to break, and long enough to wrap several lines wherever it shows. */
const LONG =
  "Publico em https://loja.example.com/checkout/cupons/2026/novembro/campanha-de-fim-de-ano-com-um-endereco-que-nao-quebra ou espero a revisão de quem cuida do checkout, sabendo que o serviço de cupons novo caiu duas vezes hoje?";

/** Two things waiting on me in #eng whose cards aren't on the loaded timeline, and a mention that waits on nobody. */
function inbox(): AppNotification[] {
  return [
    notification({
      id: "n-old",
      kind: "agent_question",
      waiting: true,
      actors: [{ type: "agent", id: ADA_ID }],
      source: { channelId: ENG_ID, messageId: "m-older-than-loaded", questionId: "q-old" },
      latest: { text: LONG },
      createdAt: ago(300),
      updatedAt: ago(300),
    }),
    notification({
      id: "n-new",
      kind: "secret_request",
      waiting: true,
      actors: [{ type: "agent", id: ATLAS_ID }],
      source: { channelId: ENG_ID, threadId: "m-1", messageId: "m-in-a-thread" },
      latest: { title: "Senha do painel", text: "Para entrar no painel de vendas." },
      createdAt: ago(20),
      updatedAt: ago(20),
    }),
    notification({
      id: "n-mention",
      kind: "mention",
      actors: [{ type: "user", id: "u-joao" }],
      source: { channelId: ENG_ID, messageId: "m-1" },
      latest: { text: "@walter viu isso?" },
      updatedAt: ago(5),
    }),
  ];
}

const nav = () => document.getElementById("app-nav") as HTMLElement;
/** The sidebar's entry for what waits: Não lidas, the list's first row (ADR 0218, ADR 0260). */
const entry = () => within(nav()).getByRole("link", { name: /^Não lidas/ });
const rowIds = () => [...document.querySelectorAll<HTMLElement>(".ib-list [data-n]")].map((r) => r.dataset.n);

describe("Esperando você", () => {
  test("the sidebar's entry is Não lidas, with the count of what waits: the notifications", async () => {
    // Two notifications wait; the seed's two proposals add nothing, as nobody decides them (ADR 0219).
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState({ notifications: inbox() })) });
    await settle(8);
    const row = entry();
    expect(row.getAttribute("href")).toBe(`/org/${ORG_ID}/unreads`);
    expect(row.closest(".sidebar__tools")).toBeTruthy();
    const count = row.querySelector(".ac-count") as HTMLElement;
    expect(count.textContent).toBe("2");
    expect(count.getAttribute("aria-label")).toBe("2 coisas esperando você");
    // A count of things, not the red of a mention.
    expect(count.classList.contains("sidebar__unread")).toBe(false);
    // Marked while something in it is unread.
    expect(row.getAttribute("data-unread")).toBe("true");
    // One entry: no page of its own for what waits.
    expect(nav().querySelector(`a[href="/org/${ORG_ID}/waiting"]`)).toBeNull();
  });

  test("nothing waiting: the entry stays in sight with no count, and the filter says so in one sentence", async () => {
    const state = seedState({ notifications: [], proposals: [] });
    const { router } = await renderApp(`/org/${ORG_ID}/waiting`, { api: createFakeApi(state) });
    await settle(8);
    expect(entry().closest(".sidebar__tools")).toBeTruthy();
    expect(entry().querySelector(".ac-count")).toBeNull();
    expect(entry().getAttribute("data-unread")).toBe("false");
    // The page it once had opens the inbox on what waits.
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    expect(router.state.location.search).toEqual({ filter: "waiting" });
    expect(screen().getByRole("heading", { level: 1, name: "Caixa de entrada" })).toBeTruthy();
    expect(document.querySelector(".ib-filter")?.textContent).toBe("Esperando você");
    expect(document.querySelector(".ib-list .ac-empty")?.textContent).toBe("Ninguém está esperando você.");
  });

  test("the inbox on Esperando você: only what waits, the first open beside the list with the question whole", async () => {
    const state = seedState({ notifications: inbox(), proposals: [] });
    await renderApp(`/org/${ORG_ID}/waiting`, { api: createFakeApi(state) });
    await settle(8);
    const title = screen().getByRole("heading", { level: 1, name: "Caixa de entrada" });
    // What waits is the line under the title.
    const meta = title.closest(".ib-head")?.querySelector(".ac-pagehead__metaline > .ac-pagehead__meta");
    expect(meta?.textContent).toContain("2 coisas esperando você");
    expect(document.querySelector(".ib-filter")?.textContent).toBe("Esperando você");
    const list = screen().getByRole("region", { name: "Esperando você" });
    expect(list.querySelector(".ac-grouphead")?.textContent).toBe("Esperando você2");
    // The mention waits on nobody: it is not here.
    expect(rowIds().sort()).toEqual(["n-new", "n-old"]);
    expect(document.querySelector(".ib")?.textContent).not.toContain("viu isso?");
    expect(list.textContent).toContain("Senha do painel");
    // What waits first is open beside the list. A row keeps one line; open, the question reads whole.
    expect(document.querySelectorAll(".ib-list .is-on")).toHaveLength(1);
    await act(async () => fireEvent.click(document.querySelector('.ib-list [data-n="n-old"]') as HTMLElement));
    await settle(4);
    expect(document.querySelector(".ib-list .is-on")?.getAttribute("data-n")).toBe("n-old");
    expect(document.querySelector("section.ib-read .rq__lead")?.textContent).toBe(LONG);
  });

  test("in the conversation: a quiet line above the composer counts what waits on me there out of the loaded messages, and Ver goes to the oldest", async () => {
    const state = seedState({ notifications: inbox() });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const bar = document.querySelector(".channel__composer .ac-typing") as HTMLElement;
    expect(bar.getAttribute("data-ask")).toBe("true");
    const text = bar.querySelector(".ac-typing__text") as HTMLElement;
    // The count alone: one line can't hold a question whole, and Ver shows it.
    expect(text.textContent).toBe("2 esperando você aqui");
    expect(within(bar).getByRole("button", { name: "Ver" })).toBeTruthy();
    expect(state.calls.some((c) => c.method === "notifications.waiting")).toBe(true);
  });

  test("nothing waits on me here: the line stays out", async () => {
    const elsewhere = inbox().map((n) => ({ ...n, source: { ...n.source, channelId: "another-conversation" } }));
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState({ notifications: elsewhere })) });
    await settle(8);
    expect(document.querySelector(".channel__composer .ac-typing")?.getAttribute("data-ask")).toBeNull();
  });
});
