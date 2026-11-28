import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle, showIn } from "./render";

/** "Mudar quando perguntar" on a waiting approval, and Settings → Aprovações (ADR 0173, addendum 2026-11-15). */

afterEach(() => cleanup());

type State = ReturnType<typeof seedState>;
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const calls = (state: State, method: string) => state.calls.filter((c) => c.method === method).map((c) => c.args);
/** Every agent follows the workspace but Atlas, at its own "Sempre perguntar". */
const following = (state = seedState()) => {
  for (const a of state.agents) Object.assign(a, { approvalsLevel: "risky", approvalsLevelOwn: false });
  const atlas = state.agents.find((a) => a.id !== ADA_ID);
  if (atlas) Object.assign(atlas, { approvalsLevel: "always", approvalsLevelOwn: true });
  return state;
};
const card = () => screen().getByRole("group", { name: "Pedido de aprovação" });
const openChoices = async (where: HTMLElement) => {
  await click(within(where).getByRole("button", { name: "Mudar quando perguntar" }));
  return screen().getByRole("dialog", { name: "Aprovações" });
};

describe("Mudar quando perguntar", () => {
  test("on the card in the conversation: the agent's three choices in place, a choice approves nothing, Desfazer", async () => {
    const state = following();
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(4);
    // A quiet link on its own line under the decision.
    const link = within(card()).getByRole("button", { name: "Mudar quando perguntar" });
    expect(link.closest(".rq__under")).toBeTruthy();
    const dialog = await openChoices(card());
    expect(dialog.textContent).toContain("Quando Ada pergunta a uma pessoa antes de agir.");
    expect(
      within(dialog)
        .getAllByRole("radio")
        .map((r) => r.getAttribute("aria-checked")),
    ).toEqual(["false", "true", "false"]);
    expect(within(dialog).getByRole("checkbox", { name: "Para todos os agentes do workspace" })).toBeTruthy();
    await click(within(dialog).getByRole("radio", { name: /Nunca perguntar/ }));
    expect(calls(state, "agents.update")).toEqual([[ORG_ID, ADA_ID, { approvalsLevel: "never" }]]);
    expect(calls(state, "approvals.approve")).toEqual([]);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    expect(screen().queryByRole("dialog", { name: "Aprovações" })).toBeNull();
    const toast = screen().getByRole("status");
    expect(toast.textContent).toContain("Ada agora: Nunca perguntar.");
    // Desfazer at the end of the toast's words: Ada follows the workspace again.
    await click(within(toast).getByRole("button", { name: "Desfazer" }));
    expect(calls(state, "agents.update").at(-1)).toEqual([ORG_ID, ADA_ID, { approvalsLevel: null }]);
    expect(state.agents.find((a) => a.id === ADA_ID)).toMatchObject({
      approvalsLevel: "risky",
      approvalsLevelOwn: false,
    });
  });

  test("for every agent: the workspace's level and every own choice cleared, Desfazer brings both back", async () => {
    const state = following();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(4);
    const dialog = await openChoices(card());
    await click(within(dialog).getByRole("checkbox", { name: "Para todos os agentes do workspace" }));
    await click(within(dialog).getByRole("radio", { name: /Nunca perguntar/ }));
    expect(calls(state, "orgs.setApprovalsLevel")).toEqual([[ORG_ID, { level: "never", everyAgent: true }]]);
    expect(state.agents.every((a) => a.approvalsLevel === "never" && a.approvalsLevelOwn === false)).toBe(true);
    const toast = screen().getByRole("status");
    expect(toast.textContent).toContain("Todos os agentes agora: Nunca perguntar.");
    await click(within(toast).getByRole("button", { name: "Desfazer" }));
    const atlas = state.agents.find((a) => a.id !== ADA_ID);
    expect(calls(state, "orgs.setApprovalsLevel").at(-1)).toEqual([ORG_ID, { level: "risky", everyAgent: undefined }]);
    expect(atlas).toMatchObject({ approvalsLevel: "always", approvalsLevelOwn: true });
    expect(state.agents.find((a) => a.id === ADA_ID)).toMatchObject({
      approvalsLevel: "risky",
      approvalsLevelOwn: false,
    });
  });

  test("for every agent, the agent's own level saves too, and the box starts unticked each time", async () => {
    const state = following();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(4);
    let dialog = await openChoices(card());
    const box = () => within(dialog).getByRole("checkbox", { name: "Para todos os agentes do workspace" });
    await click(box());
    // Ticked, no level is chosen: Ada's own "Só o arriscado" is a choice like the others.
    expect(
      within(dialog)
        .getAllByRole("radio")
        .map((r) => r.getAttribute("aria-checked")),
    ).toEqual(["false", "false", "false"]);
    await click(within(dialog).getByRole("radio", { name: /Só o arriscado/ }));
    expect(calls(state, "orgs.setApprovalsLevel")).toEqual([[ORG_ID, { level: "risky", everyAgent: true }]]);
    expect(state.agents.find((a) => a.id !== ADA_ID)).toMatchObject({
      approvalsLevel: "risky",
      approvalsLevelOwn: false,
    });
    dialog = await openChoices(card());
    expect(box().getAttribute("aria-checked")).toBe("false");
  });

  test("who may decide the request but not set the agent's level sees no link", async () => {
    const state = following();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    for (const a of state.approvals) a.canDecide = true;
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(4);
    expect(within(card()).queryByRole("button", { name: "Mudar quando perguntar" })).toBeNull();
    expect(card().querySelector(".rq__under")).toBeNull();
  });

  test("in the inbox: under the open request's decision, as on its card in the conversation", async () => {
    const state = following(
      seedState({
        notifications: [
          notification({
            id: "n-merge",
            kind: "approval",
            waiting: true,
            actors: [{ type: "agent", id: ADA_ID }],
            source: { approvalId: "ap-merge", channelId: ENG_ID },
          }),
        ],
      }),
    );
    await renderApp(`/org/${ORG_ID}/notifications`, { api: createFakeApi(state) });
    await settle(4);
    const open = document.querySelector(".ib-read .rq") as HTMLElement;
    expect(open.querySelector("[data-approve]")?.getAttribute("data-approve")).toBe("ap-merge");
    expect(within(open).getByRole("button", { name: "Mudar quando perguntar" }).closest(".rq__under")).toBeTruthy();
    const dialog = await openChoices(open);
    await click(within(dialog).getByRole("radio", { name: /Sempre perguntar/ }));
    expect(calls(state, "agents.update")).toEqual([[ORG_ID, ADA_ID, { approvalsLevel: "always" }]]);
  });

  test("worst case: a 60-character name in German at the largest text, every word on the screen", async () => {
    const state = following();
    const name = "Ada Albuquerque de Vasconcelos e Figueiredo Montenegro Júnior";
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.name = name;
    const { services } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(4);
    const ask = card();
    document.documentElement.style.fontSize = "24px";
    await showIn(services, "de");
    await click(ask.querySelector(".rq__under button") as HTMLElement);
    const dialog = screen().getByRole("dialog");
    expect(dialog.textContent).toContain(name);
    expect(within(dialog).getAllByRole("radio")).toHaveLength(3);
    document.documentElement.style.fontSize = "";
  });
});

describe("Settings → Aprovações", () => {
  const row = () => screen().getByText("Aprovações", { selector: ".settings-row__label" }).closest(".settings-row");

  test("the workspace's level, its three choices, how many agents keep their own; agents follow it", async () => {
    const state = following();
    await renderApp(`/org/${ORG_ID}/settings/general`, { api: createFakeApi(state) });
    await settle(6);
    const line = row() as HTMLElement;
    expect(line.textContent).toContain("Só o arriscado");
    expect(within(line).getByRole("button", { name: /Sobre Aprovações/ })).toBeTruthy();
    await click(within(line).getByRole("button", { name: "Mudar" }));
    const dialog = screen().getByRole("dialog", { name: "Aprovações" });
    expect(dialog.textContent).toContain("Quando os agentes perguntam a uma pessoa antes de agir.");
    expect(dialog.textContent).toContain("1 agente tem a própria escolha e não muda.");
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    await click(within(dialog).getByRole("radio", { name: /Nunca perguntar/ }));
    expect(calls(state, "orgs.setApprovalsLevel")).toEqual([[ORG_ID, { level: "never" }]]);
    expect(state.agents.find((a) => a.id === ADA_ID)?.approvalsLevel).toBe("never");
    expect(state.agents.find((a) => a.id !== ADA_ID)?.approvalsLevel).toBe("always");
    expect((row() as HTMLElement).textContent).toContain("Nunca perguntar");
  });

  test("a member doesn't see it", async () => {
    const state = following();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await renderApp(`/org/${ORG_ID}/settings/general`, { api: createFakeApi(state) });
    await settle(6);
    expect(screen().queryByText("Aprovações", { selector: ".settings-row__label" })).toBeNull();
  });

  test("an agent's own row says it follows the workspace until someone picks its own choice", async () => {
    const state = following();
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api: createFakeApi(state) });
    await settle(8);
    const section = screen().getByRole("region", { name: "Aprovações" });
    expect(within(section).getByRole("button", { name: /Aprovações/ }).textContent).toBe(
      "AprovaçõesSó o arriscado · do workspace",
    );
    // Under the name, never beside it: in a narrow column the longer words would push the chevron to its own line.
    expect(document.getElementById("agent-approvals-level-status")?.textContent).toBe("Só o arriscado · do workspace");
    expect(section.querySelector(".settings-row__value")).toBeNull();
    await click(within(section).getByRole("button", { name: /Aprovações/ }));
    await click(within(screen().getByRole("dialog", { name: "Aprovações" })).getByRole("radio", { name: /Nunca/ }));
    expect(within(section).getByRole("button", { name: /Aprovações/ }).textContent).toBe("AprovaçõesNunca perguntar");
  });
});
