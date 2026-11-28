import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/** I (Walter) am a member; Ada answers only João, her owner: I see her public card. */
const outside = () => {
  const state = seedState();
  if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) {
    ada.ownerUserId = "u-joao";
    ada.audience = { mode: "owner", userIds: [] };
    ada.instructions = "Os preços da tabela 4 são confidenciais.";
    ada.seesDetails = false;
  }
  return state;
};

describe("an agent seen from outside its audience", () => {
  test("its page is the public card: who answers for it, who it answers, where it works, a way to ask", async () => {
    // Answering someone besides João, she isn't private: her card opens.
    const state = outside();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.audience = { mode: "people", userIds: ["u-someone"] };
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api: createFakeApi(state) });
    await settle(8);
    expect(screen().queryByRole("tablist")).toBeNull();
    expect(screen().getByRole("heading", { level: 1, name: "Ada" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("tabela 4");
    expect(document.body.textContent).toContain("João");
    const ask = screen().getByRole("link", { name: "Pedir acesso" });
    expect(ask.getAttribute("href")).toBe(`/org/${ORG_ID}/dm/person/u-joao`);
  });

  test("a teammate's private agent: a plain member's link finds nothing", async () => {
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api: createFakeApi(outside()) });
    await settle(8);
    expect(screen().queryByRole("heading", { level: 1, name: "Ada" })).toBeNull();
    expect(document.body.textContent).toContain("Este agente não existe ou foi arquivado.");
    expect(document.body.textContent).not.toContain("tabela 4");
  });

  test("a teammate's private agent: her message's menu has no Ver perfil for a plain member, who'd find nothing", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(outside()) });
    await settle(8);
    const name = screen()
      .getAllByRole("button", { name: "Perfil de Ada" })
      .find((b) => !b.hasAttribute("aria-hidden"));
    if (!name) throw new Error("no author name for Ada");
    const menuKey = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
    await act(async () => void name.dispatchEvent(menuKey));
    await settle(2);
    const items = within(screen().getByRole("menu", { name: "Ações" }))
      .getAllByRole("menuitem")
      .map((i) => i.textContent);
    expect(items).toContain("Mencionar");
    expect(items).not.toContain("Ver perfil");
  });

  test('with "Editar agentes", a teammate\'s private agent: Equipe lists it locked, its page shows only its facts', async () => {
    const state = outside();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.factsOnly = true;
    await renderApp(`/org/${ORG_ID}/team`, { api: createFakeApi(state) });
    await settle(6);
    const row = screen()
      .getAllByRole("row")
      .find((r) => r.querySelector(".team-who__text b")?.textContent === "Ada") as HTMLElement;
    expect(row.querySelector(".team-private")?.textContent).toBe("Privado");
    expect(within(row).queryByRole("button", { name: /^Mais/ })).toBeNull();
    cleanup();

    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api: createFakeApi(state) });
    await settle(8);
    expect(screen().queryByRole("tablist")).toBeNull();
    expect(document.querySelector(".agp-private")?.textContent).toBe("Privado");
    expect(document.body.textContent).not.toContain("tabela 4");
    const usage = screen().getByRole("region", { name: /^Uso em / });
    const facts = Object.fromEntries(
      [...usage.querySelectorAll(".agp-facts > div")].map((d) => [
        d.querySelector("dt")?.textContent,
        d.querySelector("dd")?.textContent,
      ]),
    );
    // The budget as a share, never money; what thinks for it, and when it last worked.
    expect(facts).toMatchObject({ "Pensa com": "Claude Sonnet 5.5", Execuções: "142", Tokens: "3,1 mi" });
    expect(facts.Orçamento).toMatch(/^\d+% usado$/);
    expect(facts["Última atividade"]).toBeTruthy();
    expect(usage.textContent).not.toContain("$");
    const locked = screen().getByRole("region", { name: "O que ela faz" });
    expect(locked.textContent).toContain("ficam com João");
    const ask = within(locked).getByRole("link", { name: "Pedir a João" });
    expect(ask.getAttribute("href")).toBe(`/org/${ORG_ID}/dm/person/u-joao`);
    // Nothing to change.
    expect(screen().queryByRole("button", { name: /Editar|Arquivar|Orçamento/ })).toBeNull();
  });

  test("Equipe's map card leaves out what it does and opens its public card, which offers to ask for access", async () => {
    // Answering someone besides João, she isn't private: Equipe still lists her.
    const state = outside();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.audience = { mode: "people", userIds: ["u-someone"] };
    await renderApp(`/org/${ORG_ID}/team`, { api: createFakeApi(state) });
    await settle(4);
    await act(async () => fireEvent.click(screen().getByRole("radio", { name: "Mapa" })));
    await settle(2);
    const link = screen().getAllByRole("link", { name: /^Ada/ })[0];
    const card = link?.closest(".team-map__card");
    expect(card).toBeTruthy();
    expect(card?.textContent).not.toContain("tabela 4");
    expect(card?.querySelector(".team-map__does")).toBeNull();
    expect(link?.getAttribute("href")).toBe(`/org/${ORG_ID}/agents/${ADA_ID}`);
  });
});

describe("an agent that doesn't answer an admin", () => {
  /** I (Walter) own the workspace; Ada is João's, kept to the Suporte role I don't hold. */
  const keptOut = () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) {
      ada.ownerUserId = "u-joao";
      ada.audience = { mode: "people", userIds: [], roleIds: ["r-suporte"] };
      ada.canTalk = false;
      ada.seesDetails = true;
    }
    return state;
  };

  test("its conversation opens, says why the composer is off, and lets me in", async () => {
    const state = keptOut();
    await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const allow = screen().getByRole("button", { name: /Quero falar com/ });
    await act(async () => fireEvent.click(allow));
    await settle(2);
    const update = state.calls.find((c) => c.method === "agents.update");
    expect(update?.args[2]).toEqual({
      audience: { mode: "people", userIds: ["u-walter"], roleIds: ["r-suporte"] },
      mailLossSeen: [],
    });
  });

  test("letting me in when she holds João's mailbox asks first, naming whose access goes, and Cancel keeps it", async () => {
    const state = keptOut();
    state.mailLoss = {
      [ADA_ID]: [{ accountId: "mb-joao", address: "joao@acme.com", ownerUserId: "u-joao", ownerName: "João" }],
    };
    await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const allow = screen().getByRole("button", { name: /Quero falar com/ });
    await act(async () => fireEvent.click(allow));
    await settle(2);
    const ask = screen().getByRole("dialog", { name: "Tirar o acesso à caixa de email?" });
    expect(ask.textContent).toContain("Ada tem acesso à caixa de email de João.");
    await act(async () => fireEvent.click(within(ask).getByRole("button", { name: "Cancelar" })));
    await settle(2);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(state.calls.some((c) => c.method === "agents.update")).toBe(false);

    await act(async () => fireEvent.click(allow));
    await settle(2);
    const again = screen().getByRole("dialog", { name: "Tirar o acesso à caixa de email?" });
    await act(async () => fireEvent.click(within(again).getByRole("button", { name: "Continuar" })));
    await settle(2);
    expect(state.calls.filter((c) => c.method === "agents.update")).toHaveLength(1);
  });

  test("a mailbox given while I'm asked: the save is refused and I'm asked again, naming both", async () => {
    const state = keptOut();
    const box = (id: string, ownerName: string) => ({
      accountId: id,
      address: `${id}@acme.com`,
      ownerUserId: `u-${id}`,
      ownerName,
    });
    state.mailLoss = { [ADA_ID]: [box("joao", "João")] };
    await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(state) });
    await settle(8);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: /Quero falar com/ })));
    await settle(2);
    state.mailLoss = { [ADA_ID]: [box("joao", "João"), box("bia", "Bia")] };
    const ask = screen().getByRole("dialog", { name: "Tirar o acesso à caixa de email?" });
    await act(async () => fireEvent.click(within(ask).getByRole("button", { name: "Continuar" })));
    await settle(4);
    const again = screen().getByRole("dialog", { name: "Tirar o acesso à caixa de email?" });
    expect(again.textContent).toContain("de João e Bia.");
    await act(async () => fireEvent.click(within(again).getByRole("button", { name: "Continuar" })));
    await settle(2);
    const updates = state.calls.filter((c) => c.method === "agents.update");
    expect(updates.map((c) => (c.args[2] as { mailLossSeen?: string[] }).mailLossSeen)).toEqual([
      ["joao"],
      ["joao", "bia"],
    ]);
    expect(state.agents.find((a) => a.id === ADA_ID)?.audience?.userIds).toContain("u-walter");
  });

  test("on João's Claude plan one question says it uses his plan and he gets an email, and the mailbox it loses", async () => {
    const state = keptOut();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.brain = { kind: "claude_code", account: "Claude Max" } as NonNullable<typeof ada.brain>;
    state.mailLoss = {
      [ADA_ID]: [{ accountId: "mb-joao", address: "joao@acme.com", ownerUserId: "u-joao", ownerName: "João" }],
    };
    await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(state) });
    await settle(8);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: /Quero falar com/ })));
    await settle(2);
    const ask = screen().getByRole("dialog", { name: "Usar o plano de João?" });
    expect(ask.textContent).toContain(
      "As conversas com Ada vão usar o plano do Claude de João e os limites dele. João vai receber um email avisando.",
    );
    expect(ask.textContent).toContain("Ada tem acesso à caixa de email de João.");
    expect(state.calls.some((c) => c.method === "agents.update")).toBe(false);
    await act(async () => fireEvent.click(within(ask).getByRole("button", { name: "Continuar" })));
    await settle(2);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(state.calls.filter((c) => c.method === "agents.update")).toHaveLength(1);
  });
});
