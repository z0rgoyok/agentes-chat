import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, fakeAgentBrain, LODI_ID, ORG_ID, seedDm, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/**
 * ADR 0137 §11: "Sua IA" is every person's, the workspace's AI is the admins', and every row of Lodi's settings has the
 * same structure. Its page opens docked beside its conversation, like a thread, with nothing dimmed.
 */

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const planOf = (ownerId: string | undefined) =>
  ({
    id: "acc-ana",
    kind: "claude_code",
    label: "Trabalho",
    ownerId,
    mine: true,
    status: "active",
    shared: true,
    usedBy: [],
  }) as never;

const groups = () => [...document.querySelectorAll(".rh-group .ac-grouphead__title")].map((h) => h.textContent);
const row = (name: RegExp) => screen().getByRole("button", { name });

test("Lodi's old settings address opens Lodi's page: three groups, the face opens the look, the fallback AI is one row that opens", async () => {
  const state = withRightHand(seedState(), { brain: { kind: "claude_code", model: "Sonnet" } });
  const api = createFakeApi(state);
  let onPlan = true;
  api.agents.brain = async (_org, id, scope) =>
    fakeAgentBrain(id, {
      scope: scope ?? "mine",
      brain: onPlan ? "claude_code" : "model",
      ...(onPlan ? { account: "acc-ana" } : {}),
      accounts: [planOf(state.me?.user.id)],
      onlyOwner: true,
      canUsePlans: true,
      canEdit: true,
      workspaceAi: {
        brain: "model",
        ownerId: null,
        servesYou: true,
        key: { provider: "openai", label: "OpenAI da Acme" },
      },
    });
  const sent: unknown[] = [];
  api.agents.setBrain = async (_org, id, input) => {
    sent.push(input);
    onPlan = false;
    const lodi = state.agents.find((a) => a.id === id);
    if (lodi) lodi.brain = undefined;
    return fakeAgentBrain(id);
  };
  const { router } = await renderApp(`/org/${ORG_ID}/settings/right_hand`, { api });
  await settle(8);
  expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/agents/${LODI_ID}`);
  expect(groups()).toEqual(["Só para você", "O que o Lodi faz por conta própria", "Para todo o workspace· só admins"]);
  expect(screen().queryByRole("button", { name: "Mudar visual" })).toBeNull();
  // Each card stops and starts with the switch at its row's end, its selects in a group named after it: no button
  // of words beside them.
  expect(screen().queryByRole("button", { name: "Parar de receber" })).toBeNull();
  for (const name of ["Resumo do dia", "Semana da equipe"]) {
    const selects = screen().getByRole("group", { name });
    expect(within(selects.closest(".settings-row") as HTMLElement).getByRole("switch", { name })).toBeTruthy();
  }
  await act(async () => fireEvent.click(screen().getByRole("button", { name: "Mudar o visual do Lodi" })));
  await settle(4);
  expect(screen().getByRole("dialog", { name: "Mudar visual" })).toBeTruthy();
  await act(async () => fireEvent.click(screen().getByRole("button", { name: "Cancelar" })));
  await settle(2);
  // The value is under the row's name, the chevron at its end: no button of its own, nothing floating right.
  const ai = row(/^IA de quem não tem plano próprio/);
  expect(ai.matches(".settings-row--open")).toBe(true);
  expect(ai.querySelector(".settings-row__status")?.textContent).toBe("Plano Trabalho · Sonnet");
  expect(ai.querySelector(".settings-row__status .ac-provider-logo, .settings-row__status svg")).toBeTruthy();
  expect(ai.querySelector(".settings-row__chevron")).toBeTruthy();
  expect(ai.querySelector(".settings-row__value")).toBeNull();
  expect(screen().queryByRole("button", { name: "Usar uma chave de API" })).toBeNull();
  // Who a plan serves is its owner's choice in IA e uso (ADR 0059 §3): no lending switch here.
  expect(screen().queryByRole("switch", { name: /Emprestar/ })).toBeNull();
  // The row opens the choice in place, and choosing there changes the row.
  await act(async () => fireEvent.click(ai));
  await settle(4);
  // Drawn as any agent's "Who thinks": the account in use first, the others behind "Switch account".
  const dialog = screen().getByRole("dialog", { name: "Quem pensa pelo Lodi no workspace" });
  expect(dialog.querySelector(".bd-use .arrival-have__row")?.textContent).toContain("Trabalho");
  expect(dialog.textContent).toContain("Vale para quem não tem plano próprio.");
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Trocar de conta" })));
  await settle(4);
  const switching = screen().getByRole("dialog", { name: "Trocar a conta do Lodi" });
  // The plan in use under "In use", the key in its own group: each once.
  expect(within(switching).getAllByRole("radio")).toHaveLength(2);
  await act(async () => fireEvent.click(within(switching).getByRole("radio", { name: /Chave de API|OpenAI da Acme/ })));
  await settle(2);
  await act(async () => fireEvent.click(within(switching).getByRole("button", { name: /^Trocar para / })));
  await settle(8);
  expect(sent).toEqual([{ scope: "workspace", brain: "model" }]);
  // Back on the first screen for the key's model. Closed, the row behind it says the new value.
  await act(async () => fireEvent.click(within(screen().getByRole("dialog")).getByRole("button", { name: "Fechar" })));
  await settle(4);
  expect(row(/^IA de quem não tem plano próprio/).querySelector(".settings-row__status")?.textContent).toBe(
    "OpenAI da Acme · Automático",
  );
});

test("a member's Lodi page has nothing of the workspace's: Sua IA is one row that opens, and connects their plan from its dialog", async () => {
  const state = withRightHand(seedState());
  const me = state.me?.organizations[0];
  if (me) me.role = "member";
  const api = createFakeApi(state);
  api.agents.brain = async (_org, id) =>
    fakeAgentBrain(id, {
      scope: "mine",
      brain: "model",
      accounts: [],
      canUsePlans: true,
      workspaceAi: { brain: "claude_code", ownerId: "u-ana", servesYou: false },
    });
  await renderApp(`/org/${ORG_ID}/agents/${LODI_ID}`, { api });
  await settle(8);
  expect(groups()).toEqual(["Só para você", "O que o Lodi faz por conta própria"]);
  expect(screen().queryByText("Nome e visual")).toBeNull();
  expect(screen().queryByText("Quem pode usar")).toBeNull();
  const mine = row(/^Sua IA/);
  expect(mine.querySelector(".settings-row__status")?.textContent).toBe("Ninguém te responde aqui ainda");
  expect(screen().queryByRole("button", { name: "Conectar meu plano" })).toBeNull();
  await act(async () => fireEvent.click(mine));
  await settle(4);
  const dialog = screen().getByRole("dialog", { name: "Quem pensa pelo Lodi para você" });
  // Who it is for: the footer's line.
  expect(dialog.textContent).toContain("Vale só para a sua conversa com o Lodi.");
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Conectar meu plano" })));
  await settle(6);
  expect(screen().queryByRole("dialog", { name: "Quem pensa pelo Lodi para você" })).toBeNull();
  expect(screen().getByRole("dialog", { name: /Lodi/ })).toBeTruthy();
});

test("Sua IA on a plan of mine: the dialog goes back to the workspace's AI, and the row says so", async () => {
  const state = withRightHand(seedState());
  const api = createFakeApi(state);
  const key = { provider: "openai", label: "OpenAI da Acme" };
  let own = true;
  api.agents.brain = async (_org, id, scope) =>
    fakeAgentBrain(id, {
      scope: scope ?? "mine",
      brain: own && scope !== "workspace" ? "claude_code" : "model",
      ...(own && scope !== "workspace" ? { account: "acc-ana" } : {}),
      accounts: [planOf(state.me?.user.id)],
      canUsePlans: true,
      workspaceAi: { brain: "model", ownerId: null, servesYou: true, key },
    });
  const sent: unknown[] = [];
  api.agents.setBrain = async (_org, id, input) => {
    sent.push(input);
    own = false;
    return fakeAgentBrain(id);
  };
  await renderApp(`/org/${ORG_ID}/agents/${LODI_ID}`, { api });
  await settle(8);
  expect(row(/^Sua IA/).querySelector(".settings-row__status")?.textContent).toBe("Trabalho · seu plano · Sonnet");
  await act(async () => fireEvent.click(row(/^Sua IA/)));
  await settle(4);
  const dialog = screen().getByRole("dialog", { name: "Quem pensa pelo Lodi para você" });
  // The plan in use as the account, then each way out as a line that leads somewhere: nothing to pick among them.
  const inUse = dialog.querySelector(".bd-use .arrival-have__row");
  expect(inUse?.textContent).toContain("Trabalho");
  expect(inUse?.textContent).toContain("seu plano");
  expect(within(dialog).queryAllByRole("radio")).toHaveLength(0);
  expect(within(dialog).getByRole("button", { name: "Conectar outra IA" })).toBeTruthy();
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Usar a do workspace" })));
  await settle(8);
  expect(sent).toEqual([{ scope: "mine", brain: "model" }]);
  expect(screen().queryByRole("dialog", { name: "Quem pensa pelo Lodi para você" })).toBeNull();
  expect(row(/^Sua IA/).querySelector(".settings-row__status")?.textContent).toBe(
    "OpenAI da Acme · chave do workspace",
  );
});

test("a plan's model is a line that opens its list, in Sua IA and in the workspace's AI: picked, then used", async () => {
  const state = withRightHand(seedState(), { brain: { kind: "claude_code", model: "Sonnet" } });
  const api = createFakeApi(state);
  const model: Record<string, string | null> = { mine: null, workspace: null };
  api.agents.brain = async (_org, id, scope) =>
    fakeAgentBrain(id, {
      scope: scope ?? "mine",
      brain: "claude_code",
      account: "acc-ana",
      effectiveModel: model[scope ?? "mine"] ?? null,
      accounts: [planOf(state.me?.user.id)],
      canUsePlans: true,
      canEdit: true,
    });
  const sent: { scope?: string; model?: string | null }[] = [];
  api.agents.setBrain = async (_org, id, input) => {
    sent.push(input);
    model[input.scope ?? "mine"] = input.model ?? null;
    return fakeAgentBrain(id);
  };
  await renderApp(`/org/${ORG_ID}/agents/${LODI_ID}`, { api });
  await settle(8);
  for (const [name, scope, before] of [
    [/^Sua IA/, "mine", "Trabalho · seu plano · Sonnet"],
    [/^IA de quem não tem plano próprio/, "workspace", "Plano Trabalho · Sonnet"],
  ] as const) {
    expect(row(name).querySelector(".settings-row__status")?.textContent).toBe(before);
    await act(async () => fireEvent.click(row(name)));
    await settle(4);
    const dialog = screen().getByRole("dialog");
    // A line under the account in use, as on any agent's: it opens the plan's models.
    const line = within(dialog).getByRole("button", { name: /^Modelo/ });
    expect(line.closest(".bd-lines")).toBeTruthy();
    expect(line.textContent).toContain("Sonnet");
    await act(async () => fireEvent.click(line));
    await settle(3);
    await act(async () => fireEvent.click(within(screen().getByRole("dialog")).getByRole("radio", { name: /^Opus/ })));
    await settle(2);
    await act(async () =>
      fireEvent.click(within(screen().getByRole("dialog")).getByRole("button", { name: /^Usar Opus/ })),
    );
    await settle(8);
    expect(sent.at(-1)).toEqual({ scope, model: "opus" });
    // Back on the first screen with the new model on its line, and the row behind it says it.
    expect(within(screen().getByRole("dialog")).getByRole("button", { name: /^Modelo/ }).textContent).toContain("Opus");
    await act(async () =>
      fireEvent.click(within(screen().getByRole("dialog")).getByRole("button", { name: "Fechar" })),
    );
    await settle(4);
    expect(row(name).querySelector(".settings-row__status")?.textContent).toBe(before.replace("Sonnet", "Opus"));
  }
});

test("Poderes do workspace is one row for everyone that opens what only Lodi does", async () => {
  const state = withRightHand(seedState());
  const me = state.me?.organizations[0];
  if (me) me.role = "member";
  await renderApp(`/org/${ORG_ID}/agents/${LODI_ID}`, { api: createFakeApi(state) });
  await settle(8);
  const powers = row(/^Poderes do workspace/);
  expect(powers.matches(".settings-row--open")).toBe(true);
  await act(async () => fireEvent.click(powers));
  await settle(4);
  const dialog = screen().getByRole("dialog", { name: "Poderes do workspace" });
  expect([...dialog.querySelectorAll(".rh-powers li")].map((li) => li.textContent)).toEqual([
    "Monta e muda o time inteiro por cards que uma pessoa aplica: agentes, pessoas e ajustes do workspace",
    "Roda e apaga rotinas de qualquer agente que você pode gerenciar",
    "Na sua conversa, lê o Drive, a wiki e as tarefas que você pode ver",
    "Responde a um @ em qualquer canal sem ser membro",
  ]);
});

test("Lodi's page has three tabs: its settings, what it may use on the agent page's own access tab, and what it keeps for the viewer", async () => {
  const state = withRightHand(seedState());
  await renderApp(`/org/${ORG_ID}/agents/${LODI_ID}`, { api: createFakeApi(state) });
  await settle(8);
  const tabs = () => within(screen().getByRole("tablist", { name: "Seções do Lodi" })).getAllByRole("tab");
  expect(tabs().map((tab) => tab.textContent)).toEqual(["Configurações", "Ferramentas e acesso", "Memória"]);
  expect(tabs()[0]?.getAttribute("aria-selected")).toBe("true");
  expect(row(/^Poderes do workspace/)).toBeTruthy();
  cleanup();
  await renderApp(`/org/${ORG_ID}/agents/${LODI_ID}?tab=access`, { api: createFakeApi(state) });
  await settle(8);
  expect(tabs()[1]?.getAttribute("aria-selected")).toBe("true");
  // The same cards as any agent's: its apps, mailboxes and skills. Its settings are the other tab.
  for (const id of ["ac-connectors", "ac-builtin", "ac-skills"]) expect(document.getElementById(id)).toBeTruthy();
  expect(screen().queryByRole("button", { name: /^Poderes do workspace/ })).toBeNull();
  // No sky, tabs of an agent's own work or archive: it is part of the workspace.
  expect(document.querySelector(".agp-hero")).toBeNull();
  cleanup();
  // What it keeps for the viewer, and the rules they gave it, on the agent page's own memory tab.
  await renderApp(`/org/${ORG_ID}/agents/${LODI_ID}?tab=memory`, { api: createFakeApi(state) });
  await settle(8);
  expect(tabs()[2]?.getAttribute("aria-selected")).toBe("true");
  expect(document.getElementById("mem-known")).toBeTruthy();
});

test("the worst case keeps its shape: a very long account and owner name stay under the row's name, whole", async () => {
  const state = withRightHand(seedState(), { brain: { kind: "claude_code", model: "Sonnet" } });
  const long = "Assinatura corporativa compartilhada do time de operações e atendimento da América Latina";
  const owner = state.members.find((m) => m.userId !== state.me?.user.id);
  if (owner) owner.name = "Maximiliana-Bernardette Albuquerque";
  const api = createFakeApi(state);
  api.agents.brain = async (_org, id, scope) =>
    fakeAgentBrain(id, {
      scope: scope ?? "mine",
      brain: "claude_code",
      account: "acc-ana",
      accounts: [{ ...(planOf(owner?.userId) as object), label: long, mine: false } as never],
      onlyOwner: false,
      canUsePlans: true,
      canEdit: true,
    });
  await renderApp(`/org/${ORG_ID}/agents/${LODI_ID}`, { api });
  await settle(8);
  const ai = row(/^IA de quem não tem plano próprio/);
  const value = ai.querySelector(".settings-row__status .rh-value") as HTMLElement;
  expect(value.textContent).toBe(`Plano ${long} · conta de Maximiliana-Bernardette · Sonnet`);
  // Under the name, in the words' column: never a second column squeezing the name, never cut.
  expect(value.closest(".settings-row__text")).toBeTruthy();
  const css = await Bun.file(new URL("../src/layout.css", import.meta.url).pathname).text();
  const rule = css.split("\n.rh-value {")[1]?.split("}")[0] ?? "";
  expect(rule).toContain("overflow-wrap: anywhere");
  expect(rule).not.toMatch(/ellipsis|nowrap/);
});

test("Quem pode usar sits one card gap under its head, with no margin of its own", async () => {
  const state = withRightHand(seedState());
  await renderApp(`/org/${ORG_ID}/agents/${LODI_ID}`, { api: createFakeApi(state) });
  await settle(8);
  const card = document.getElementById("rh-audience")?.closest(".ac-card") as HTMLElement;
  expect(card.querySelector(".ac-card__head")?.nextElementSibling?.querySelector('[role="radiogroup"]')).toBeTruthy();
  expect(await Bun.file(new URL("../src/layout.css", import.meta.url).pathname).text()).not.toContain(
    "rh-set__audience",
  );
});

describe("the agent's page beside its conversation", () => {
  const openPanel = async () => {
    const state = withRightHand(seedState());
    seedDm(state, { type: "agent", id: LODI_ID });
    await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const opener = document.querySelector(".dm-who__hit") as HTMLElement;
    opener.focus();
    await act(async () => fireEvent.click(opener));
    await settle(6);
    return opener;
  };
  const panel = () => document.querySelector(".thread-panel--wide") as HTMLElement | null;

  test("floats over a scrim, takes the focus, and gives it back on Esc", async () => {
    const opener = await openPanel();
    const side = panel() as HTMLElement;
    expect(side.previousElementSibling?.classList.contains("thread-panel__scrim")).toBe(true);
    expect(side.contains(document.activeElement)).toBe(true);
    expect(opener.getAttribute("aria-expanded")).toBe("true");
    await act(async () => fireEvent.keyDown(side, { key: "Escape" }));
    await settle(3);
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test("its × and its opener again close it", async () => {
    const opener = await openPanel();
    await act(async () =>
      fireEvent.click(within(panel() as HTMLElement).getAllByRole("button", { name: "Fechar" })[0] as HTMLElement),
    );
    await settle(3);
    expect(panel()).toBeNull();
    await act(async () => fireEvent.click(opener));
    await settle(4);
    expect(panel()).toBeTruthy();
    await act(async () => fireEvent.click(opener));
    await settle(4);
    expect(panel()).toBeNull();
  });
});
