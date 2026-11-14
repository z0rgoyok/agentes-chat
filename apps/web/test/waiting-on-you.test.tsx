import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AppNotification } from "@agenteschat/client";
import { cleanup, within } from "@testing-library/react";
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

describe("Esperando você", () => {
  test("the sidebar's entry comes into the list with its count while something waits, and opens the list", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState({ notifications: inbox() })) });
    await settle(8);
    const row = within(nav()).getByRole("link", { name: /Esperando você/ });
    expect(row.getAttribute("href")).toBe(`/org/${ORG_ID}/waiting`);
    expect(row.closest(".sidebar__tools")).toBeTruthy();
    const count = row.querySelector(".ac-count") as HTMLElement;
    expect(count.textContent).toBe("2");
    expect(count.getAttribute("aria-label")).toBe("2 coisas esperando você");
    // A count of things, not the red of a mention.
    expect(count.classList.contains("sidebar__unread")).toBe(false);
  });

  test("nothing waiting: the entry waits in More, and the page says so in one sentence", async () => {
    await renderApp(`/org/${ORG_ID}/waiting`, { api: createFakeApi(seedState({ notifications: [] })) });
    await settle(8);
    expect(nav().querySelector(`.sidebar__tools > a[href="/org/${ORG_ID}/waiting"]`)).toBeNull();
    expect(screen().getByRole("heading", { level: 1, name: "Esperando você" })).toBeTruthy();
    expect(document.querySelector(".nt")?.textContent).toContain("Ninguém está esperando você.");
  });

  test("the page: only what waits, each as its own card with the question whole, no filters and nothing to mark read", async () => {
    await renderApp(`/org/${ORG_ID}/waiting`, { api: createFakeApi(seedState({ notifications: inbox() })) });
    await settle(8);
    const title = screen().getByRole("heading", { level: 1, name: "Esperando você" });
    // What waits is the line under the title, as on the Approvals page: not beside it.
    expect(title.nextElementSibling?.className).toBe("ac-pagehead__meta");
    expect(title.nextElementSibling?.textContent).toContain("2 coisas esperando você");
    expect(document.title).toBe("Esperando você");
    expect(screen().queryByRole("radiogroup", { name: "Filtrar notificações" })).toBeNull();
    expect(screen().queryByRole("button", { name: "Marcar tudo como lido" })).toBeNull();
    const list = screen().getByRole("region", { name: "Esperando você" });
    // The title already says it: no second heading over the cards.
    expect(list.querySelector(".ac-grouphead")).toBeNull();
    expect(list.querySelectorAll("[data-n]")).toHaveLength(2);
    expect(list.textContent).toContain(LONG);
    expect(list.textContent).toContain("Senha do painel");
    expect(document.querySelector(".nt")?.textContent).not.toContain("viu isso?");
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
