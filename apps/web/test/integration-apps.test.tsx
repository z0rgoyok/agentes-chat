import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** Settings › Connectors › Integrations and an integration app's message in the chat (ADR 0251). */

afterEach(() => cleanup());

const copied: string[] = [];
beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (s: string) => void copied.push(s) },
  });
});

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const section = () => within(document.querySelector(".settings__body") as HTMLElement);
const dialog = () => within(screen().getByRole("dialog"));

describe("Configurações › Conectores › Integrações", () => {
  test("a tab of Conectores; connecting an app shows its token once and closes only after Copiar", async () => {
    copied.length = 0;
    const api = createFakeApi(seedState());
    await renderApp(`/org/${ORG_ID}/settings/integrations`, { api });
    await settle(6);
    expect(section().getByRole("tab", { name: "Integrações" }).getAttribute("aria-selected")).toBe("true");
    expect(section().getByText("Nenhum app ainda")).toBeTruthy();
    await click(section().getByRole("button", { name: "Conectar um app" }));
    // Each channel starts with no access, said as such.
    expect(screen().getByRole("dialog").textContent).toContain("Sem acesso");
    await act(async () => fireEvent.change(dialog().getByLabelText("Nome"), { target: { value: "Bot de suporte" } }));
    await click(dialog().getByRole("button", { name: "Conectar" }));
    expect(screen().getByRole("dialog", { name: "Token de Bot de suporte" })).toBeTruthy();
    const done = dialog().getByRole("button", { name: "Já copiei" }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    await click(dialog().getByRole("button", { name: "Copiar token" }));
    expect(copied[0]).toMatch(/^agi_/);
    expect(done.disabled).toBe(false);
    await click(done);
    expect(section().getByText("Bot de suporte")).toBeTruthy();
    expect(document.querySelector(".settings__body")?.textContent).toContain(
      `Token terminado em ${copied[0]?.slice(-4)}`,
    );
    expect(document.querySelector(".settings__body")?.textContent).not.toContain(copied[0] ?? "agi_");
  });
});

describe("a new webhook secret", () => {
  test("asks first: the old one stops checking deliveries the moment a new one is made", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await renderApp(`/org/${ORG_ID}/settings/integrations`, { api });
    await settle(6);
    await click(section().getByRole("button", { name: "Conectar um app" }));
    await act(async () => fireEvent.change(dialog().getByLabelText("Nome"), { target: { value: "Bot de suporte" } }));
    await act(async () =>
      fireEvent.change(dialog().getByPlaceholderText("https://relay.example.com/agentes"), {
        target: { value: "https://relay.example.com/hook" },
      }),
    );
    await click(dialog().getByRole("button", { name: "Conectar" }));
    // The token, then the secret: each shown once.
    for (const copy of ["Copiar token", "Copiar"]) {
      await click(dialog().getByRole("button", { name: copy }));
      await click(dialog().getByRole("button", { name: "Já copiei" }));
    }
    const more = section().getByRole("button", { name: "Ações de Bot de suporte" });
    await act(async () => {
      fireEvent.keyDown(more, { key: "Enter" });
      fireEvent.keyUp(more, { key: "Enter" });
    });
    await settle(2);
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Novo segredo do webhook" }));
    const ask = screen().getByRole("dialog", { name: "Criar um segredo novo do webhook para Bot de suporte?" });
    const made = () => state.calls.filter((c) => c.method === "integrationApps.newWebhookSecret").length;
    expect(made()).toBe(0);
    await click(within(ask).getByRole("button", { name: "Novo segredo do webhook" }));
    expect(made()).toBe(1);
    expect(screen().getByRole("dialog", { name: "Segredo do webhook de Bot de suporte" })).toBeTruthy();
  });
});

describe("an integration app's message", () => {
  test("its name, the App tag and the outside sender, with no profile of a person", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-app",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "app", id: "00000000-0000-4000-9000-000000000001" },
      body: "Meu pedido não chegou.",
      mentionedAgentIds: [],
      agentRunId: null,
      meta: {
        app: { id: "00000000-0000-4000-9000-000000000001", name: "Bot de suporte", color: "teal", sender: "Maria" },
      },
      createdAt: new Date().toISOString(),
    });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    const row = screen().getByText("Meu pedido não chegou.").closest("article, .ac-msg") as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("Bot de suporte");
    expect(row.textContent).toContain("App");
    expect(row.textContent).toContain("de Maria");
    expect(row.textContent).not.toContain("para Maria");
    expect(row.querySelector(".ac-appmark")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /Perfil de Bot de suporte/ })).toBeNull();
  });
});
