import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle, showIn } from "./render";

afterEach(() => cleanup());

let services: Parameters<typeof showIn>[0];
const go = async (state = seedState(), api = createFakeApi(state)) => {
  const rendered = await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api });
  await settle(8);
  services = rendered.services;
  return state;
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const section = () => screen().getByRole("region", { name: "Aprovações" });
const updates = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "agents.update").map((c) => c.args[2]);

describe("Aprovações on an agent's page", () => {
  test("one line with the level in sight; its dialog's three choices are one height and a pick saves at once", async () => {
    const state = await go();
    const row = within(section()).getByRole("button", { name: /Aprovações/ });
    // An agent from a server that doesn't say asks for what is risky.
    expect(row.textContent).toBe("AprovaçõesSó o arriscado");
    await click(row);
    const dialog = screen().getByRole("dialog", { name: "Aprovações" });
    expect(dialog.textContent).toContain("Quando Ada pergunta a uma pessoa antes de agir.");
    const options = within(dialog).getAllByRole("radio");
    expect(options.map((o) => o.textContent)).toEqual([
      "Sempre perguntarPergunta antes de mudar qualquer coisa, aqui, no computador ou em um app.",
      "Só o arriscadoPergunta antes de apagar, enviar ou pagar.",
      "Nunca perguntarNão pergunta nada, nem em merge, deploy, pagamentos e rotinas.",
    ]);
    expect(options.map((o) => o.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    // Nothing to confirm with: no footer, only the choices and the way out.
    expect(within(dialog).queryByRole("button", { name: /Salvar|Confirmar|Cancelar/ })).toBeNull();
    await click(options[2] as HTMLElement);
    expect(updates(state)).toEqual([{ approvalsLevel: "never" }]);
    expect(screen().queryByRole("dialog", { name: "Aprovações" })).toBeNull();
    expect(within(section()).getByRole("button", { name: /Aprovações/ }).textContent).toBe("AprovaçõesNunca perguntar");
    // Saved on its own: the page's save bar has nothing to hold.
    expect(screen().queryByRole("region", { name: "Alterações não salvas" })).toBeNull();
  });

  test("the saved level shows on the line and is the one chosen in the dialog", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.approvalsLevel = "always";
    await go(state);
    const row = within(section()).getByRole("button", { name: /Aprovações/ });
    expect(row.textContent).toBe("AprovaçõesSempre perguntar");
    await click(row);
    const dialog = screen().getByRole("dialog", { name: "Aprovações" });
    expect(
      within(dialog)
        .getByRole("radio", { name: /Sempre perguntar/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  test("who can't manage agents reads the level and opens nothing", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go(state);
    expect(within(section()).queryByRole("button")).toBeNull();
    expect(section().textContent).toBe("AprovaçõesSó o arriscado");
  });

  test("a pick shows at once and closes the dialog; a save that fails says so and puts the level back", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    api.agents.update = async () => {
      throw new Error("offline");
    };
    await go(state, api);
    await click(within(section()).getByRole("button", { name: /Aprovações/ }));
    const dialog = screen().getByRole("dialog", { name: "Aprovações" });
    await click(within(dialog).getByRole("radio", { name: /Nunca perguntar/ }));
    expect(screen().queryByRole("dialog", { name: "Aprovações" })).toBeNull();
    // Every failed write says so once, from the app's own handler: the card adds no second toast.
    expect(screen().getAllByText("Algo deu errado. Tente de novo.")).toHaveLength(1);
    expect(within(section()).getByRole("button", { name: /Aprovações/ }).textContent).toBe("AprovaçõesSó o arriscado");
  });

  test("worst case: a 60-character name, an agent that never asks, in German: every word is on the screen", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    const name = "Ada Albuquerque de Vasconcelos e Figueiredo Montenegro Júnior";
    if (ada) Object.assign(ada, { name, approvalsLevel: "never" });
    await go(state);
    await click(within(section()).getByRole("button", { name: /Aprovações/ }));
    await showIn(services, "de");
    const dialog = screen().getByRole("dialog");
    expect(dialog.textContent).toContain(name);
    const options = within(dialog).getAllByRole("radio");
    expect(options.map((o) => o.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    for (const option of options) expect(option.textContent?.length).toBeGreaterThan(20);
  });
});
