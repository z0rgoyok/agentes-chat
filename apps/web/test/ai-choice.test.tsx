import { afterEach, describe, expect, test } from "bun:test";
import type { AiAccounts, AiComputer, BrainOption } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { brainDialog } from "./ai-picker";
import {
  ADA_ID,
  createFakeApi,
  fakeAgentBrain,
  fakeMachinesOf,
  LODI_ID,
  ORG_ID,
  seedState,
  withRightHand,
} from "./fake-api";
import { hintOf, shownText } from "./hint";
import { openOrder } from "./plan-rows";
import { renderApp, screen, settle } from "./render";

/*
 * The one "Quem pensa" picker (Conta, Modelo, Esforço) and Contas de IA's account detail: one row per account in the
 * picker's groups, the ones that can't think here dimmed with why, each change saved at once; an account's three
 * permissions; the order of use's API-key switch.
 */

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
/** A select opened by its keys: its options. */
async function options(combobox: HTMLElement) {
  combobox.focus();
  await act(async () => fireEvent.keyDown(combobox, { key: "Enter" }));
  await settle(3);
  return screen().getAllByRole("option");
}
/** An option's name: the first line of its row. */
const name = (o: Element) => o.querySelector(".aa-row > span:first-child")?.textContent ?? o.textContent ?? "";
/** The line under an option's name: its plan and whose it is. */
const sub = (o: Element | undefined) => o?.querySelector(".aa-row > .ac-menu__desc");

const MAC: AiComputer = {
  machineId: "machine_1",
  name: "MacBook",
  online: true,
  mine: true,
  canAdd: true,
  keys: true,
  brains: { claude_code: true, codex: true },
};
type Row = AiAccounts["accounts"][number];
const account = (id: string, label: string, over: Partial<Row> = {}): Row => ({
  id,
  kind: "claude_code",
  label,
  email: null,
  plan: "max",
  status: "active",
  ownerId: "u-walter",
  ownerName: "Walter",
  mine: true,
  usedBy: [],
  usage: null,
  provider: null,
  keyHint: null,
  shared: true,
  named: true,
  machineId: "machine_1",
  computer: "MacBook",
  ...over,
});
const WORK = account("acct_work", "Trabalho");
const JOAO = account("acct_joao", "Claude do João", { ownerId: "u-joao", ownerName: "João Silva", mine: false });
const MARINA = account("acct_marina", "Pessoal da Marina", {
  ownerId: "u-marina",
  ownerName: "Marina Ribeiro",
  mine: false,
  serves: "owner",
});

async function agentPage(accounts: Row[]) {
  const state = seedState();
  const api = createFakeApi(state);
  fakeMachinesOf.get(api)?.setAiAccounts({ accounts, computers: [MAC] });
  fakeMachinesOf.get(api)?.pair({ id: "machine_1", name: "MacBook" });
  api.agents.brain = async (_org, id) =>
    fakeAgentBrain(id, {
      brain: "claude_code",
      account: "acct_work",
      effort: "medium",
      accounts: accounts.map((a) => ({ ...a, usable: a.mine || a.serves !== "owner" })),
      computer: { machineId: "machine_1", name: "MacBook", online: true },
      canUsePlans: true,
      canEdit: true,
    });
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api });
  await settle(8);
  return { state, api };
}

describe("Quem pensa: the one picker", () => {
  test("Conta lists the viewer's, then the team's, then the workspace's keys; one only its owner uses is dimmed, saying so", async () => {
    await agentPage([WORK, JOAO, MARINA]);
    const d = await brainDialog();
    const conta = within(d).getByRole("combobox", { name: "Conta" });
    // Closed: the account in use by its name and plan, one line.
    expect(conta.querySelector(".aa-opt__name")?.textContent).toBe("Trabalho");
    expect(conta.querySelector(".aa-meta__plan")?.textContent).toBe("Max");
    const rows = await options(conta);
    // Ada works on no computer yet: ChatGPT is the MacBook's, the agent moving there with it.
    expect(rows.map(name)).toEqual(["Trabalho", "ChatGPT", "Claude do João", "Pessoal da Marina", "Claude da Acme"]);
    expect(sub(rows[1])?.textContent).toBe("Vai para o MacBook");
    expect(
      [...screen().getAllByRole("group")]
        .filter((g) => g.closest(".ac-tz__list"))
        .map((g) => g.getAttribute("aria-label")),
    ).toEqual(["Suas contas", "Do time", "Chaves de API"]);
    const marina = rows[3] as HTMLElement;
    expect(marina.getAttribute("aria-disabled")).toBe("true");
    expect(marina.querySelector(".aa-room")?.textContent).toBe("Só Marina usa");
    // Two lines: the name over its plan and whose it is.
    expect(sub(rows[2])?.textContent).toBe("Max · de João");
    // The one in use: its plate and a check at its end.
    expect(rows[0]?.getAttribute("aria-selected")).toBe("true");
    expect(rows.map((o) => o.querySelector(".ac-tz__check")?.childElementCount ?? 0)).toEqual([1, 0, 0, 0, 0]);
    // Under the list, whatever is typed: Adicionar conta and Gerenciar contas.
    expect(screen().getByRole("button", { name: /^Adicionar conta/ })).toBeTruthy();
    expect(screen().getByRole("button", { name: "Gerenciar contas" })).toBeTruthy();
  });

  test("an API agent opens with its dedicated account and model; effort changes only that agent", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const originalDetail = api.agents.detail;
    api.agents.detail = async (org, id) => ({
      ...(await originalDetail(org, id)),
      credentialId: "dedicated",
      model: "claude-opus-5-5",
    });
    const credential = state.credentials[0];
    if (!credential) throw new Error("fixture credential");
    state.credentials.push({ ...credential, id: "dedicated", label: "Dedicated API" });
    api.agents.brain = async (_org, id) =>
      fakeAgentBrain(id, { brain: "model", account: null, model: null, effort: "medium", canEdit: true });
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api });
    await settle(8);
    const d = await brainDialog();
    expect(within(d).getByRole("combobox", { name: "Conta" }).textContent).toContain("Dedicated API");
    expect(within(d).getByRole("combobox", { name: "Modelo" }).textContent).toContain("Opus");
    const high = (await options(within(d).getByRole("combobox", { name: "Esforço" }))).find((o) =>
      o.textContent?.startsWith("Alto"),
    );
    if (!high) throw new Error("high effort option");
    await click(high);
    await settle(6);
    expect(state.calls.filter((c) => c.method === "agents.update").map((c) => c.args)).toEqual([
      [ORG_ID, ADA_ID, { credentialId: "dedicated", model: "claude-opus-5-5" }],
    ]);
    expect(state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args)).toEqual([
      [ORG_ID, ADA_ID, { brain: "model", effort: "high" }],
    ]);
    expect(state.calls.some((c) => c.method === "agents.applySetup")).toBe(false);
  });

  test("the search finds an account by its owner's name; no match says so", async () => {
    await agentPage([WORK, JOAO, MARINA]);
    const d = await brainDialog();
    await options(within(d).getByRole("combobox", { name: "Conta" }));
    const search = screen().getByRole("combobox", { name: "Buscar por nome, IA, plano ou dono" });
    await act(async () => fireEvent.change(search, { target: { value: "joão" } }));
    await settle(2);
    expect(screen().getAllByRole("option").map(name)).toEqual(["Claude do João"]);
    await act(async () => fireEvent.change(search, { target: { value: "ninguém" } }));
    await settle(2);
    expect(screen().queryAllByRole("option")).toHaveLength(0);
    expect(screen().getByText("Nenhuma conta encontrada.")).toBeTruthy();
  });

  test("Modelo and Esforço side by side, each saved as it is picked; Automático picks the effort too", async () => {
    const { state } = await agentPage([WORK]);
    const d = await brainDialog();
    const pair = d.querySelector(".aa-pair") as HTMLElement;
    expect(
      within(pair)
        .getAllByRole("combobox")
        .map((c) => c.getAttribute("aria-labelledby") !== null),
    ).toHaveLength(2);
    const opus = (await options(within(pair).getByRole("combobox", { name: "Modelo" }))).find((o) =>
      /^Opus/.test(o.textContent ?? ""),
    );
    await click(opus as Element);
    await settle(6);
    const sent = state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args[2]);
    expect(sent.at(-1)).toMatchObject({ brain: "claude_code", account: "acct_work", model: "opus" });
    const auto = (await options(within(pair).getByRole("combobox", { name: "Modelo" }))).find(
      (o) => o.textContent === "Automático",
    );
    await click(auto as Element);
    await settle(6);
    expect(
      state.calls
        .filter((c) => c.method === "agents.setBrain")
        .map((c) => c.args[2])
        .at(-1),
    ).toMatchObject({ model: "auto", effort: "auto" });
  });

  test("Codex on a Windows computer without MXC: what its own sandbox holds there, behind Conta's ⓘ", async () => {
    const gpt = account("acct_gpt", "ChatGPT do trabalho", { kind: "codex", plan: "plus", provider: "openai" });
    const open = async (sandbox?: "partial") => {
      cleanup();
      const state = seedState();
      const api = createFakeApi(state);
      fakeMachinesOf.get(api)?.setAiAccounts({ accounts: [gpt], computers: [MAC] });
      fakeMachinesOf.get(api)?.pair({ id: "machine_1", name: "MacBook" });
      api.agents.brain = async (_org, id) => {
        const view = fakeAgentBrain(id, {
          brain: "codex",
          account: "acct_gpt",
          accounts: [{ ...gpt, usable: true }],
          computer: { machineId: "machine_1", name: "MacBook", online: true },
          canUsePlans: true,
          canEdit: true,
        });
        const options = view.options.map((o) => (o.kind === "codex" && sandbox ? { ...o, sandbox } : o));
        return { ...view, options, machines: view.machines.map((m) => ({ ...m, options })) };
      };
      await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api });
      await settle(8);
      return brainDialog();
    };
    const d = await open("partial");
    expect(hintOf("Conta", d).text).toBe(
      "Neste Windows, os comandos do Codex só escrevem nas pastas dos agentes, mas a internet fica bloqueada só em parte para eles. O Windows\u00a011\u00a024H2 ou mais novo, com as atualizações em dia, bloqueia por completo.",
    );
    expect(shownText(d)).not.toContain("Neste Windows");
    // MXC there, or not known yet: nothing new.
    const mxc = await open();
    expect(within(mxc).queryByRole("button", { name: "Sobre Conta" })).toBeNull();
  });

  test("Lodi on a ChatGPT plan of that computer: no ⓘ by Conta, since its turns run no commands", async () => {
    const gpt = account("acct_gpt", "ChatGPT do trabalho", { kind: "codex", plan: "plus", provider: "openai" });
    const state = withRightHand(seedState());
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setAiAccounts({ accounts: [gpt], computers: [MAC] });
    fakeMachinesOf.get(api)?.pair({ id: "machine_1", name: "MacBook" });
    // What the computer says for any agent there: Lodi's options come from that list too.
    const partial = (o: BrainOption): BrainOption => (o.kind === "codex" ? { ...o, sandbox: "partial" } : o);
    const options = fakeAgentBrain(LODI_ID).options.map(partial);
    state.brainMachines = [{ machineId: "machine_1", name: "MacBook", online: true, options }];
    api.agents.brain = async (_org, id, scope) => ({
      ...fakeAgentBrain(id, {
        scope: scope ?? "mine",
        brain: "codex",
        account: "acct_gpt",
        accounts: [{ ...gpt, usable: true }],
        computer: { machineId: "machine_1", name: "MacBook", online: true },
        canUsePlans: true,
        canEdit: true,
        workspaceAi: { brain: "model", ownerId: null, servesYou: true },
      }),
      options,
    });
    await renderApp(`/org/${ORG_ID}/agents/${LODI_ID}`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: /^Sua IA/ }));
    const dialog = screen().getByRole("dialog", { name: "Quem pensa pelo Lodi para você" });
    expect(within(dialog).getByRole("combobox", { name: "Conta" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Sobre Conta" })).toBeNull();
  });

  test("a long name ends in an ellipsis on its line, whole in its tooltip", async () => {
    const long = account("acct_long", "Conta compartilhada do time de engenharia de dados e plataforma", {
      ownerName: "Maria Fernanda Albuquerque Cavalcanti",
      ownerId: "u-maria",
      mine: false,
    });
    await agentPage([WORK, long]);
    const d = await brainDialog();
    const rows = await options(within(d).getByRole("combobox", { name: "Conta" }));
    const row = rows.find((o) => name(o).startsWith("Conta compartilhada")) as HTMLElement;
    expect(row.querySelector(".aa-row > span:first-child")?.getAttribute("title")).toBe(
      "Conta compartilhada do time de engenharia de dados e plataforma",
    );
    expect(sub(row)?.getAttribute("title")).toBe("Max · de Maria");
  });
});

describe("Contas de IA: an account's permissions and the order's switch", () => {
  async function hub(accounts: Row[]) {
    const state = seedState();
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setAiAccounts({ accounts, computers: [MAC] });
    await renderApp(`/org/${ORG_ID}/settings/usage`, { api });
    await settle(6);
    return { state, api };
  }
  const open = async (title: string) => {
    const row = [...document.querySelectorAll(".aa-list .plan-row")].find(
      (r) => r.querySelector(".plan-row__title")?.textContent === title,
    );
    await click(row?.querySelector(".plan-row__head") as Element);
    return screen().getByRole("dialog", { name: title });
  };

  test("its limits, then Gerenciar, Usar em agentes and Atender todos, each with its line, ⓘ and choice", async () => {
    await hub([WORK, JOAO]);
    const d = await open("Trabalho");
    expect(within(d).getByRole("heading", { name: "Limites" })).toBeTruthy();
    expect(within(d).getByRole("heading", { name: "Permissões" })).toBeTruthy();
    const choices = ["Gerenciar", "Usar em agentes", "Atender todos"].map((n) =>
      within(d).getByRole("combobox", { name: n }),
    );
    expect(choices.map((c) => c.textContent)).toEqual(["Você e administradores", "Todos", "Só o dono do agente"]);
    expect(choices.map((c) => c.hasAttribute("disabled"))).toEqual([false, false, false]);
    for (const n of ["Gerenciar", "Usar em agentes", "Atender todos"])
      expect(within(d).getByRole("button", { name: `Sobre ${n}` })).toBeTruthy();
    expect(d.textContent).toContain("Renomear, entrar de novo, excluir");
    // Someone else's: in sight, nothing to change.
    await click(within(d).getByRole("button", { name: "Fechar" }));
    const his = await open("Claude do João");
    expect(
      ["Gerenciar", "Usar em agentes", "Atender todos"].map((n) =>
        within(his).getByRole("combobox", { name: n }).hasAttribute("disabled"),
      ),
    ).toEqual([true, true, true]);
    expect(within(his).getByRole("combobox", { name: "Gerenciar" }).textContent).toBe("João e administradores");
  });

  test("Pessoas… asks whom, and saves those people", async () => {
    const { state } = await hub([WORK]);
    const d = await open("Trabalho");
    const use = within(d).getByRole("combobox", { name: "Usar em agentes" });
    await click((await options(use)).find((o) => o.textContent === "Pessoas…") as Element);
    const pick = screen().getByRole("dialog", { name: "Usar em agentes" });
    const boxes = within(pick).getAllByRole("checkbox");
    await click(boxes[0] as Element);
    await click(within(pick).getByRole("button", { name: "Salvar" }));
    await settle(4);
    const saved = state.calls.find((c) => c.method === "machines.setAccountPermissions")?.args;
    expect(saved?.[1]).toBe("acct_work");
    expect(saved?.[2]).toMatchObject({ use: { mode: "people", roleIds: [] } });
    expect((saved?.[2] as { use: { userIds: string[] } } | undefined)?.use.userIds).toHaveLength(1);
  });

  test("Ordem de uso: the API-key switch is off by default and saves at once", async () => {
    const { state } = await hub([WORK, account("acct_two", "Reserva", { useOrder: 1 })]);
    const order = await openOrder();
    const fallback = within(order).getByRole("switch", {
      name: "Continuar com a chave de API quando todos os planos estiverem no limite",
    });
    expect(fallback.getAttribute("aria-checked")).toBe("false");
    await click(fallback);
    await settle(4);
    expect(state.calls.filter((c) => c.method === "machines.setKeyFallback").map((c) => c.args[1])).toEqual([true]);
  });
});
