import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { Agent, AgentBrain, AgentBrainInput, MachineAccount } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  addAccount,
  brainDialog,
  brainLines,
  brainNotes,
  brainScreen,
  done,
  openAccounts,
  pickAccount,
  toScreen,
} from "./ai-picker";
import { ADA_ID, createFakeApi, type FakeState, fakeAgentBrain, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";

import { renderApp, screen, settle } from "./render";

/*
 * "Quem pensa" on its Modelo screen and the Esforço and Velocidade lines of "Mais opções" (ADR 0032 §5, addendum
 * 2026-11-10): the models as rows grouped by maker, Automático first, each saved on its own screen; the effort and the
 * speed saved by "Concluído", only what changed.
 */

afterEach(() => {
  cleanup();
  setSystemTime();
});

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const brainCalls = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args[2]);

async function open(state = seedState(), api = createFakeApi(state)) {
  const { services } = await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api });
  await settle(8);
  return { state, api, services };
}
/** "Como trabalha" under the name: where, who thinks, the browser. */
const sentence = () => screen().getByRole("region", { name: "Como trabalha" });
/** The "Pensa com" cell: what thinks (and its effort), and what pays (on the value's line in the fact sheet). */
const brainCell = () => {
  const cell = within(sentence()).getByRole("button", { name: "Mudar quem pensa" });
  const value = cell.querySelector(".agp-cell__value")?.cloneNode(true) as HTMLElement | undefined;
  value?.querySelector(".agp-cell__sub")?.remove();
  return {
    label: cell.querySelector("small")?.textContent,
    value: value?.textContent,
    sub: cell.querySelector(".agp-cell__sub")?.textContent,
  };
};
/** A connected MacBook with Claude Code and Codex; its browser as given. */
const pairMac = (api: ReturnType<typeof createFakeApi>, browser: boolean) =>
  fakeMachinesOf.get(api)?.pair({
    id: "machine_1",
    name: "MacBook",
    os: "darwin",
    access: { folders: [], tools: { claude: true, codex: true, commands: true, browser } },
    browser: { available: browser, version: browser ? "1" : null, chrome: null, reason: null },
  });
/**
 * Ada's brain as the server gives it, following what each screen saves (a static view would show the old model after
 * a save): what thinks, the model, the account, the effort and the speed.
 */
function follow(api: ReturnType<typeof createFakeApi>, first: AgentBrain) {
  let view = first;
  api.agents.brain = async () => structuredClone(view);
  const setBrain = api.agents.setBrain;
  api.agents.setBrain = async (orgId, agentId, input: AgentBrainInput) => {
    const next = await setBrain(orgId, agentId, input);
    const brain = input.brain ?? view.brain;
    const option = view.options.find((o) => o.kind === brain);
    view = {
      ...view,
      brain,
      ...(input.model !== undefined
        ? { model: input.model, effectiveModel: input.model ?? option?.defaultModel ?? null }
        : {}),
      ...(input.account !== undefined ? { account: input.account } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.speed !== undefined ? { speed: input.speed } : {}),
      ...(input.onlyOwner !== undefined ? { onlyOwner: input.onlyOwner } : {}),
    };
    return next;
  };
}
/** A line of the first screen or of "Mais opções", by its name. */
const lineOf = (d: HTMLElement, label: string) => brainLines(d).find((l) => l.label === label)?.value;

describe("Quem pensa: a coding plan's models", () => {
  /** One of Walter's key accounts of `provider` on the MacBook. */
  const planKey = (provider: string | null, over: Partial<MachineAccount> = {}): MachineAccount => ({
    id: "acct_plan",
    kind: "claude_code",
    label: "Plano",
    email: null,
    plan: null,
    status: "active",
    ownerId: "u-walter",
    ownerName: "Walter Nogueira",
    mine: true,
    usedBy: ["Ada"],
    usage: null,
    provider,
    keyHint: "4f2a",
    ...over,
  });
  /** Ada thinks with Claude Code on the MacBook, with Walter's key account of `provider`. */
  async function onPlan(
    provider: string,
    patch: Partial<AgentBrain> = {},
    over: Partial<MachineAccount> = {},
    planModels?: FakeState["planModels"],
  ) {
    const state = seedState();
    if (planModels) state.planModels = planModels;
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    const accounts = patch.accounts ?? [planKey(provider, over)];
    // The Conta field lists the accounts on the MacBook.
    fakeMachinesOf.get(api)?.setAiAccounts({
      accounts: accounts.map((a) => ({ ...a, machineId: "machine_1", computer: "MacBook" })),
      computers: [
        {
          machineId: "machine_1",
          name: "MacBook",
          online: true,
          mine: true,
          canAdd: true,
          keys: true,
          brains: { claude_code: true, codex: true },
        },
      ],
    });
    follow(
      api,
      fakeAgentBrain(ADA_ID, {
        brain: "claude_code",
        effectiveModel: "sonnet",
        account: "acct_plan",
        accounts,
        ...patch,
      }),
    );
    await open(state, api);
    return { state, api };
  }

  test("the agent's model at a limit of its own: said under the plan's meters, which show the account's room", async () => {
    const at = new Date().toISOString();
    const until = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await onPlan(
      "opencode",
      { effectiveModel: "deepseek-v4.1-flash" },
      {
        usage: {
          windows: [{ kind: "five_hour", usedPercent: 0 }],
          source: "probe",
          at,
          models: { "deepseek-v4.1-flash": { at, until } },
        },
      },
    );
    const d = await brainDialog();
    expect(d.textContent).toContain("O DeepSeek V4.1 Flash chegou ao limite dele neste plano e renova ");
    expect(d.textContent).toContain("Os outros modelos do plano seguem funcionando.");
  });

  test("an API key shows no quota line under its account: its use is spend against a budget", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    api.agents.brain = async () => fakeAgentBrain(ADA_ID, { brain: "model", effectiveModel: null });
    await open(state, api);
    const d = await brainDialog();
    expect(d.querySelector(".plan-models__none")).toBeNull();
    expect(d.querySelector(".plan-model")).toBeNull();
  });

  test("a coding plan's keys are accounts of its own; another plan starts on its own model, one more key keeps it", async () => {
    const { state } = await onPlan("opencode", {
      model: "deepseek-v4.1-flash",
      effectiveModel: "deepseek-v4.1-flash",
      accounts: [
        planKey("opencode"),
        planKey("opencode", { id: "acct_oc2", label: "Plano 2", usedBy: [], keyHint: "9f3c" }),
        // Someone else's key: the server says it can't think for Ada.
        planKey("zai", { id: "acct_theirs", mine: false, usedBy: [], keyHint: "1b2c", usable: false }),
        planKey(null, { id: "acct_claude", label: "Pessoal", keyHint: null, plan: "Max", usedBy: [] }),
      ],
    });
    const d = await brainDialog();
    const rows = await openAccounts(d);
    // The key in use with its plan's mark, checked; the viewer's other key of that plan and Claude account; someone
    // else's key there, dimmed; the workspace's key.
    expect(rows.map((r) => [r.group, r.title, r.mark, r.checked, r.off])).toEqual([
      ["Suas contas", "Plano", "opencode", true, false],
      ["Suas contas", "Plano 2", "opencode", false, false],
      ["Suas contas", "Pessoal", "claude", false, false],
      ["Do time", "Plano", "zai", false, true],
      ["Chaves de API", "Claude da Acme", "claude", false, false],
    ]);
    // One more key of the same plan: the model it has stays.
    await pickAccount(d, "Plano 2");
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "claude_code", account: "acct_oc2" });
    // Claude: another plan, on its own default model.
    await done(d);
    const again = await brainDialog();
    await pickAccount(again, "Pessoal");
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "claude_code", model: null, account: "acct_claude" });
  });
  test("a plan's key made for all of its owner's agents there is picked as it is, though another agent thinks with it", async () => {
    const { state } = await onPlan("opencode", {
      account: null,
      accounts: [planKey("opencode", { id: "acct_oc", usedBy: ["Theo"], shared: true })],
    });
    const d = await brainDialog();
    await pickAccount(d, (r) => r.mark === "opencode");
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ brain: "claude_code", account: "acct_oc" });
    expect(brainCalls(state).at(-1)).not.toHaveProperty("moveAccount");
    expect(brainScreen(d)).toBe("Quem pensa pela Ada");
    expect(brainNotes(d).join(" ")).toContain("A Ada agora pensa com Plano.");
  });
  test("Adicionar conta: a screen of this dialog, an API key through Connect for this agent; an admin adds only a key", async () => {
    await onPlan("opencode");
    let d = await brainDialog();
    await addAccount(d);
    expect(brainScreen(d)).toBe("Adicionar conta");
    expect(within(d).getByRole("button", { name: /^Claude/ })).toBeTruthy();
    await toScreen(d, "Chave de API");
    await settle(6);
    expect(screen().queryByRole("dialog", { name: /^Quem pensa|^Adicionar conta/ })).toBeNull();
    expect(screen().getByRole("dialog")).toBeTruthy();
    cleanup();
    // Someone else's agent: a plan is its owner's to add, a key the workspace's.
    await onPlan("opencode", { canUsePlans: false, canManageAccounts: false });
    d = await brainDialog();
    await addAccount(d);
    expect(within(d).queryByRole("button", { name: /^Claude/ })).toBeNull();
    expect(within(d).getByRole("button", { name: /^Chave de API/ })).toBeTruthy();
  });
  test("an admin moves its owner's agent off the owner's coding plan, onto the owner's other plans or the API", async () => {
    await onPlan("opencode", { canUsePlans: false, canManageAccounts: false }, { mine: false });
    const d = await brainDialog();
    // The owner's plan, the computer's own sign-ins and the workspace's key: none of them off.
    const rows = await openAccounts(d);
    expect(rows.map((r) => [r.title, r.mark, r.off])).toEqual([
      ["Plano", "opencode", false],
      ["Conta deste MacBook", "claude", false],
      ["Conta deste MacBook", "openai", false],
      ["Claude da Acme", "claude", false],
    ]);
    expect(d.textContent).not.toContain("Só João troca");
  });
});

describe("Quem pensa: Automático", () => {});

describe("Velocidade (ADR 0149)", () => {
  async function onChatGpt(patch: Partial<AgentBrain> = {}, line?: Partial<NonNullable<Agent["brain"]>>) {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada && line) ada.brain = { kind: "codex", model: "GPT-6 Sol", ...line };
    follow(api, fakeAgentBrain(ADA_ID, { brain: "codex", effectiveModel: "gpt-6-sol", onlyOwner: true, ...patch }));
    return open(state, api);
  }
  const speed = (d: HTMLElement) => within(d).queryByRole("radiogroup", { name: "Velocidade" });
  /** "Quem pensa", on "Mais opções" with Velocidade open. */
  const speedOpen = async () => {
    const d = await brainDialog();
    await toScreen(d, "Mais opções");
    await toScreen(d, "Velocidade");
    return d;
  };

  test("Padrão left alone sends nothing; a saved Rápida shows chosen", async () => {
    const { state } = await onChatGpt({ speed: "fast" });
    const d = await speedOpen();
    expect(
      within(speed(d) as HTMLElement)
        .getByRole("radio", { name: "Rápida" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await done(d);
    await settle(4);
    expect(brainCalls(state)).toEqual([]);
    expect(brainScreen(d)).toBe("Quem pensa pela Ada");
  });

  test("no control on a model without it or on Claude; a saved Rápida stays saved, and nothing says it", async () => {
    const first = await onChatGpt({ effectiveModel: "gpt-5.5", model: "gpt-5.5", speed: "fast" });
    expect(brainCell().value).not.toContain("Rápida");
    let d = await brainDialog();
    await toScreen(d, "Mais opções");
    expect(lineOf(d, "Velocidade")).toBeUndefined();
    expect(speed(d)).toBeNull();
    await done(d);
    await settle(4);
    expect(brainCalls(first.state)).toEqual([]);
    cleanup();
    await onChatGpt({ brain: "claude_code", effectiveModel: "sonnet" });
    d = await brainDialog();
    expect(lineOf(d, "Mais opções")).not.toContain("velocidade");
    await toScreen(d, "Mais opções");
    expect(lineOf(d, "Velocidade")).toBeUndefined();
    expect(speed(d)).toBeNull();
  });

  test("a save that fails says so and leaves the choice in the open dialog", async () => {
    const { api } = await onChatGpt();
    api.agents.setBrain = async () => {
      throw new Error("offline");
    };
    const d = await speedOpen();
    await click(within(speed(d) as HTMLElement).getByRole("radio", { name: "Rápida" }));
    await done(d);
    await settle(6);
    expect(screen().getByText("Não deu para salvar. Tente de novo.")).toBeTruthy();
    expect(brainScreen(d)).toBe("Mais opções da Ada");
    expect(screen().getByRole("dialog", { name: "Mais opções da Ada" })).toBe(d);
    expect(lineOf(d, "Velocidade")).toBe("Rápida");
  });
});
