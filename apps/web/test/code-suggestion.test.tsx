import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { CodeSuggestion } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * A code session an agent suggested under its reply (ADR 0215 §11): the request card says what it opens and on whose
 * computer, keeps the person's words behind "Ver o pedido", and only the person who asked decides.
 */

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(6);
};

const ASK = "O botão de concluir não salva com o filtro ligado, consegue arrumar?";

function withSuggestion(overrides: Partial<CodeSuggestion> = {}) {
  const state = seedState();
  state.messages.push(
    {
      id: "msg-ask",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-walter" },
      body: ASK,
      mentionedAgentIds: [ADA_ID],
      agentRunId: null,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    },
    {
      id: "msg-suggest",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "Consigo: sugiro uma sessão para mexer numa cópia só dessa mudança.",
      mentionedAgentIds: [],
      agentRunId: "r-suggest",
      meta: {
        codeSuggestion: {
          id: "s-1",
          agentId: ADA_ID,
          repo: "tarefas",
          title: "Tarefa feita volta ao recarregar",
          request: ASK,
          requestMessageId: "msg-ask",
          askerId: "u-walter",
          status: "pending",
          ...overrides,
        } satisfies CodeSuggestion,
      },
      createdAt: new Date().toISOString(),
    },
  );
  return state;
}

async function open(state: ReturnType<typeof seedState>) {
  const api = createFakeApi(state);
  const app = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(8);
  const card = screen().getByRole("group", { name: "Sugestão de sessão de código" });
  return { ...app, card };
}

test("under the reply: what it opens and where, the person's words behind Ver o pedido; Abrir sessão opens it", async () => {
  const state = withSuggestion();
  const { card, router } = await open(state);
  expect(card.textContent).toContain("Sugere uma sessão de código");
  expect(card.textContent).toContain("Tarefa feita volta ao recarregar");
  expect(card.textContent).toContain("tarefas · no computador da Ada");
  expect(card.textContent).not.toContain(ASK);
  await click(within(card).getByRole("button", { name: /Ver o pedido/ }));
  expect(card.textContent).toContain(ASK);
  await click(within(card).getByRole("button", { name: "Abrir sessão" }));
  expect(state.calls.find((c) => c.method === "code.openSuggestion")?.args).toEqual([ORG_ID, "msg-suggest"]);
  expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/code/0193f1a2-7b3c-7d4e-8f90-1a2b3c4d5e6f`);
});

test("Fazer aqui: the card says the work stays here", async () => {
  const state = withSuggestion();
  const { card } = await open(state);
  await click(within(card).getByRole("button", { name: "Fazer aqui" }));
  expect(state.calls.some((c) => c.method === "code.keepHere")).toBe(true);
  expect(card.textContent).toContain("Você preferiu fazer aqui");
  expect(within(card).queryByRole("button", { name: "Abrir sessão" })).toBeNull();
});

test("decided: how it ended, with the way to the session it opened", async () => {
  const state = withSuggestion({
    status: "opened",
    sessionId: "0193f1a2-7b3c-7d4e-8f90-1a2b3c4d5e6f",
    by: "u-walter",
    at: new Date().toISOString(),
  });
  const { card, router } = await open(state);
  expect(card.textContent).toContain("Você abriu a sessão");
  await click(within(card).getByRole("button", { name: "Ver sessão" }));
  expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/code/0193f1a2-7b3c-7d4e-8f90-1a2b3c4d5e6f`);
});

test("someone else's request: who it waits for, and nothing to press", async () => {
  const state = withSuggestion({ askerId: "u-joao" });
  const { card } = await open(state);
  expect(card.textContent).toContain("esperando João");
  expect(within(card).queryByRole("button", { name: "Abrir sessão" })).toBeNull();
  expect(within(card).queryByRole("button", { name: "Fazer aqui" })).toBeNull();
});
