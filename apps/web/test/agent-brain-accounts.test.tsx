import { afterEach, describe, expect, test } from "bun:test";
import type { AgentBrain, AiComputer, MachineAccount, PlanUsage } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { brainDialog, brainRows, brainScreen, done, mainButton, pickRow, toScreen } from "./ai-picker";
import { ADA_ID, ATLAS_ID, createFakeApi, fakeAgentBrain, fakeMachinesOf, NOW, ORG_ID, seedState } from "./fake-api";
import { hintOf, shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

/*
 * "Quem pensa" and the accounts on the agent's computer (ADR 0041, ADR 0059; the dialog of ADR 0032 §5, addendum
 * 2026-11-10): "Trocar de conta" lists every way it can think, the one in use first; a row that needs a sign-in signs
 * this agent in on the computer, then thinks with it; at its limit the dialog opens on the accounts with room. "Mais
 * opções" holds the effort, whom it answers and "Usar em outros agentes" (ADR 0094), which takes what is saved.
 */

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(2);
};
const brainCalls = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args[2]);
const loginArgs = (state: ReturnType<typeof seedState>) =>
  state.calls.find((c) => c.method === "machines.beginAccountLogin")?.args;

async function open(state = seedState(), api = createFakeApi(state)) {
  const { services } = await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api });
  await settle(8);
  return { state, api, services };
}
/** "Como trabalha" under the name: where, who thinks, the browser. */
const sentence = () => screen().getByRole("region", { name: "Como trabalha" });
/** The MacBook's row in the AI accounts: the own sign-ins its runner reported there. */
const reportOwn = (api: ReturnType<typeof createFakeApi>, own: AiComputer["own"]) =>
  fakeMachinesOf.get(api)?.setAiAccounts({
    accounts: [],
    computers: [
      {
        machineId: "machine_1",
        name: "MacBook",
        online: true,
        mine: true,
        canAdd: true,
        keys: true,
        brains: { claude_code: true, codex: true },
        own,
      },
    ],
  });
/** A connected MacBook with Claude Code and Codex; its browser as given. */
const pairMac = (api: ReturnType<typeof createFakeApi>, browser: boolean) =>
  fakeMachinesOf.get(api)?.pair({
    id: "machine_1",
    name: "MacBook",
    os: "darwin",
    access: { folders: [], tools: { claude: true, codex: true, commands: true, browser } },
    browser: { available: browser, version: browser ? "1" : null, chrome: null, reason: null },
  });
/** Presses a sign-in's button (in the dialog's footer), the provider's page opening beside. */
async function signIn(d: HTMLElement, name: string, wait = 8) {
  const realOpen = window.open;
  window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
  try {
    await click(within(d).getByRole("button", { name }));
    await settle(wait);
  } finally {
    window.open = realOpen;
  }
}
/** The rows of "Trocar de conta" but the one in use. */
const others = (d: HTMLElement) => brainRows(d).filter((r) => r.group !== "Em uso");

describe("Quem pensa: the account on the computer and the effort (ADR 0041)", () => {
  const work: MachineAccount = {
    id: "acct_work",
    kind: "claude_code",
    label: "Trabalho",
    email: "walt@acme.com",
    plan: "Team",
    status: "active",
    ownerId: "u-walter",
    ownerName: "Walter Nogueira",
    mine: true,
    usedBy: [],
    usage: null,
    provider: null,
    keyHint: null,
  };
  /**
   * Ada thinks with Claude Code on the MacBook, which has the given accounts; `own`: the MacBook's own sign-ins its
   * runner reported, as its row of the AI accounts says them.
   */
  async function onMac(patch: Partial<AgentBrain> = {}, own?: AiComputer["own"]) {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    if (own) reportOwn(api, own);
    api.agents.brain = async () =>
      fakeAgentBrain(ADA_ID, { brain: "claude_code", effectiveModel: "sonnet", accounts: [work], ...patch });
    return open(state, api);
  }

  test("an account made for all of the person's agents there: picked as it is, Also used by Theo, no sign-in, no move", async () => {
    const shared: MachineAccount = {
      ...work,
      id: "acct_all",
      label: "Pessoal",
      email: "walt@pessoal.com",
      plan: "Max",
      usedBy: ["Theo"],
      shared: true,
    };
    const { state } = await onMac({ accounts: [work, shared] });
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    expect(brainRows(d).find((r) => r.title === "Pessoal")?.lines).toEqual([
      "walt@pessoal.com · Max · Também usada por Theo",
    ]);
    await pickRow(d, "Pessoal");
    expect(mainButton(d)?.textContent).toBe("Trocar para Pessoal");
    await click(mainButton(d) as HTMLElement);
    await settle(6);
    expect(within(d).queryByRole("region", { name: "Adicionar conta do Claude" })).toBeNull();
    expect(brainCalls(state).at(-1)).toMatchObject({ account: "acct_all" });
    expect(brainCalls(state).at(-1)).not.toHaveProperty("moveAccount");
    expect(state.calls.find((c) => c.method === "machines.beginAccountLogin")).toBeUndefined();
    expect(brainScreen(d)).toBe("Pronto");
  });

  test("her own login signed out, an account another agent uses: a new login of that account, never hers again", async () => {
    const theo: MachineAccount = {
      ...work,
      id: "acct_theo",
      label: "Pessoal",
      email: "walt@pessoal.com",
      plan: "Max",
      usedBy: ["Theo"],
    };
    const { state } = await onMac({
      account: "acct_work",
      accounts: [{ ...work, status: "signed_out", usedBy: ["Ada"] }, theo],
    });
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    await pickRow(d, "Pessoal");
    await click(mainButton(d) as HTMLElement);
    expect(within(d).getByRole("region", { name: "Adicionar conta do Claude" })).toBeTruthy();
    await signIn(d, "Entrar com Claude");
    expect(loginArgs(state)).toEqual([ORG_ID, "machine_1", "claude_code", { email: "walt@pessoal.com" }]);
  });

  test("ChatGPT like Claude: an account another agent thinks with signs in again for this one, never moved", async () => {
    const theo: MachineAccount = {
      ...work,
      id: "acct_theo",
      kind: "codex",
      label: "Pessoal",
      email: "walt@pessoal.com",
      plan: "Plus",
      usedBy: ["Theo"],
    };
    const { state } = await onMac({ brain: "codex", effectiveModel: "gpt-6-sol", accounts: [theo] });
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    expect(brainRows(d).find((r) => r.title === "Pessoal")?.lines).toEqual([
      "walt@pessoal.com · Plus · Também usada por Theo",
    ]);
    await pickRow(d, "Pessoal");
    expect(mainButton(d)?.textContent).toBe("Fazer login para a Ada");
    await click(mainButton(d) as HTMLElement);
    expect(within(d).getByRole("region", { name: /^Adicionar conta/ })).toBeTruthy();
    expect(brainCalls(state)).toEqual([]);
  });

  test("plan usage, pinned to this account: at the limit it opens on its owner's free accounts with room, never another agent's", async () => {
    const now = new Date().toISOString();
    const full: PlanUsage = {
      windows: [{ kind: "five_hour", usedPercent: 100, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() }],
      limited: true,
      source: "turn",
      at: now,
    };
    const some = (usedPercent: number): PlanUsage => ({
      windows: [{ kind: "five_hour", usedPercent }],
      source: "probe",
      at: now,
    });
    // Automatic names: each goes by its email.
    const roomy: MachineAccount = {
      ...work,
      id: "acct_roomy",
      label: "Claude Team 2",
      email: "walt@reserva.com",
      usage: some(12),
    };
    const busy: MachineAccount = { ...work, id: "acct_busy", label: "Claude Team 3", usedBy: ["Theo"], usage: some(3) };
    const { state } = await onMac({
      account: "acct_work",
      accounts: [{ ...work, usedBy: ["Ada"], usage: full }, roomy, busy],
      accountPinned: true,
    });
    // The work cell says it, where the account is.
    expect(sentence().textContent).toContain("Trabalho · No limite até");
    const d = await brainDialog(/no limite$/);
    expect(brainScreen(d)).toBe("A conta da Ada está no limite");
    // Opening it looks the plans up again.
    expect(state.calls.some((c) => c.method === "machines.refreshAccountUsage")).toBe(true);
    expect(d.textContent).toContain("Trabalho volta");
    expect(brainRows(d).map((r) => [r.group, r.title, r.room])).toEqual([
      ["Com mais folga agora", "walt@reserva.com", "12%"],
    ]);
    expect(within(d).getByRole("button", { name: "Esperar" })).toBeTruthy();
    expect(within(d).queryByRole("button", { name: /^Conectar outra IA/ })).toBeNull();
    expect(mainButton(d)?.textContent).toBe("Usar walt@reserva.com");
    await click(mainButton(d) as HTMLElement);
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "claude_code", account: "acct_roomy" });
    expect(brainScreen(d)).toBe("Pronto");
  });

  test("Só esta conta, under Mais opções with a second account: its ⓘ, saved with Concluir, named on the row", async () => {
    const next: MachineAccount = { ...work, id: "acct_next", label: "Pessoal", shared: true };
    const { state } = await onMac({ account: "acct_work", accounts: [{ ...work, shared: true }, next] });
    const d = await brainDialog();
    await toScreen(d, "Mais opções");
    const pin = within(d).getByRole("switch", { name: "Só esta conta" });
    expect(pin.getAttribute("aria-checked")).toBe("false");
    expect(hintOf("Só esta conta", d).text).toBe("No limite, espera esta conta renovar em vez de seguir na próxima.");
    await click(pin);
    await done(d);
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "claude_code", accountPinned: true });
    // One account alone never moves: no switch.
    cleanup();
    const d2 = await (async () => {
      await onMac({ account: "acct_work", accounts: [work] });
      return brainDialog();
    })();
    expect(d2.querySelector(".bd-moves")).toBeNull();
    await toScreen(d2, "Mais opções");
    expect(within(d2).queryByRole("switch", { name: "Só esta conta" })).toBeNull();
  });

  test("plan usage to someone who isn't the agent's owner: the limit, no offer", async () => {
    const full: PlanUsage = {
      windows: [{ kind: "seven_day", usedPercent: 100 }],
      source: "turn",
      at: new Date().toISOString(),
    };
    const spare: MachineAccount = { ...work, id: "acct_spare", label: "Claude Team 2", usage: null };
    await onMac({
      account: "acct_work",
      accounts: [{ ...work, usedBy: ["Ada"], usage: full }, spare],
      canUsePlans: false,
      canManageAccounts: false,
      accountPinned: true,
    });
    const d = await brainDialog(/no limite$/);
    expect(d.textContent).toContain("Trabalho volta");
    expect(brainRows(d)).toEqual([]);
    expect(mainButton(d)).toBeNull();
    expect(within(d).queryByRole("button", { name: /^Usar Claude/ })).toBeNull();
    expect(within(d).queryByRole("button", { name: /^Conectar outra IA/ })).toBeNull();
    expect(within(d).getByRole("button", { name: "Esperar" })).toBeTruthy();
  });

  test("who may use other people's plans gives Ada a teammate's, named whose it is; one another agent has stays off", async () => {
    const bia: MachineAccount = {
      ...work,
      id: "acct_bia",
      label: "Max da Bia",
      email: null,
      plan: null,
      ownerId: "u-bia",
      ownerName: "Bia Lima",
      mine: false,
    };
    const busy: MachineAccount = {
      ...bia,
      id: "acct_caio",
      label: "Pro do Caio",
      ownerId: "u-caio",
      ownerName: "Caio",
      usedBy: ["Theo"],
    };
    const { state } = await onMac({
      account: null,
      accounts: [bia, busy],
      canUsePlans: false,
      canManageAccounts: false,
      canUseOthersPlans: true,
    });
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    expect(d.textContent).toContain("Os planos que atendem o workspace todo mostram de quem são.");
    // Among the ones with most room, each says whose it is.
    expect(brainRows(d).find((r) => r.title === "Max da Bia")).toMatchObject({ lines: ["De Bia"], off: false });
    // All of them, under their AI, each saying whose it is: the one another agent has can't be picked.
    await click(within(d).getByRole("button", { name: /^Ver as/ }));
    const rows = brainRows(d);
    expect(rows.find((r) => r.title === "Max da Bia")).toMatchObject({
      group: "Claude",
      lines: ["De Bia"],
      off: false,
    });
    expect(rows.find((r) => r.title === "Pro do Caio")).toMatchObject({ lines: ["De Caio"], off: true });
    await pickRow(d, "Max da Bia");
    // Its owner hears of it.
    expect(d.textContent).toContain("Bia recebe um aviso por e-mail.");
    await click(mainButton(d) as HTMLElement);
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ account: "acct_bia" });
  });

  test("signing in again as another account already connected: both addresses said, and Use picks that one for Ada", async () => {
    const pessoal: MachineAccount = { ...work, id: "acct_pessoal", label: "Pessoal", email: "walt@gmail.com" };
    const { state, api } = await onMac({
      account: "acct_work",
      accounts: [{ ...work, status: "signed_out" }, pessoal],
    });
    fakeMachinesOf.get(api)?.endLogin("login_1", {
      state: "failed",
      signedInAs: "walt@gmail.com",
      duplicate: { label: "Pessoal", account: pessoal },
    });
    const d = await brainDialog();
    await toScreen(d, "Entrar de novo");
    const block = within(d).getByRole("region", { name: "Adicionar conta do Claude" });
    await signIn(d, "Entrar com Claude");
    expect(shownText(block)).toContain(
      "O Claude entrou como walt@gmail.com, não como walt@acme.com. Saia na página do Claude e tente de novo.",
    );
    await click(within(block).getByRole("button", { name: "Usar walt@gmail.com" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ account: "acct_pessoal" });
    expect(brainScreen(d)).toBe("Pronto");
  });

  test("the computer's own sign-in, chosen again, is the account the agents share, as the Connect cards name it", async () => {
    const { state } = await onMac({ account: "acct_work" }, { claude_code: { plan: "max" } });
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    await pickRow(d, (r) => r.mark === "claude" && r.group !== "Em uso");
    expect(mainButton(d)?.textContent).toBe("Trocar para A conta que os seus agentes dividem");
    await click(mainButton(d) as HTMLElement);
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "claude_code", account: null });
    expect(d.textContent).toContain("A Ada agora pensa com A conta que os seus agentes dividem.");
  });

  test("the computer's own sign-in is offered only once its runner says it's signed in there", async () => {
    await onMac({ account: "acct_work" });
    let d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    // The MacBook said nothing of Claude Code's own sign-in: no account of its to choose.
    expect(others(d).map((r) => r.title)).toEqual(["Chave padrão do workspace"]);
    cleanup();
    await onMac({ account: "acct_work" }, { claude_code: { plan: "max" } });
    d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    expect(others(d).map((r) => [r.title, r.lines])).toEqual([
      ["A conta que os seus agentes dividem", ["Claude · Max"]],
      ["Chave padrão do workspace", ["Claude · termina em 7f2a"]],
    ]);
  });

  test("ChatGPT on the workspace's computer, which nobody connected: never that computer's account; another AI is Connect's", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    // Even with its Codex reported signed in: on a computer nobody connected, no person signs in at its terminal.
    reportOwn(api, { codex: { usage: { windows: [], source: "probe", at: NOW.toISOString() } } });
    api.agents.brain = async () => fakeAgentBrain(ADA_ID, { ownSignIn: false });
    await open(state, api);
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    expect(d.textContent).not.toMatch(/Conta deste|quem conectou|A conta que os seus agentes dividem/);
    expect(brainRows(d).some((r) => r.mark === "openai")).toBe(false);
    // A plan with nothing there is connected through Connect an AI: this dialog closes for it.
    await click(within(d).getByRole("button", { name: /^Conectar outra IA/ }));
    await settle(4);
    expect(screen().queryByRole("dialog", { name: /^Quem pensa/ })).toBeNull();
    expect(screen().getByRole("dialog")).toBeTruthy();
    // Showing the steps starts nothing.
    expect(state.calls.some((c) => c.method === "machines.beginAccountLogin")).toBe(false);
  });

  test("a computer someone else connected, with no account of hers there: it says who signs a plan in, no empty list", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.pair({
      id: "machine_1",
      name: "MacBook",
      os: "darwin",
      access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: true } },
      browser: { available: true, version: "1", chrome: null, reason: null },
      pairedBy: { id: "u-theo", name: "Theo Lima" },
    });
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    // Ada is Walter's: her plan would be his, and only Theo adds sign-ins on his MacBook.
    api.agents.brain = async () => fakeAgentBrain(ADA_ID, { ownSignIn: false, canManageAccounts: false });
    await open(state, api);
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    expect(d.textContent).toContain("Só Theo conecta um plano no MacBook.");
    // Nothing of a plan to pick there: the key Ada has is all there is.
    expect(others(d)).toEqual([]);
  });

  test("onto a plan brain from the API: what can think there, the computer's own sign-in or a free account, never a plan with nothing there", async () => {
    const plus: MachineAccount = { ...work, id: "acct_plus", kind: "codex", label: "Pessoal", plan: "Plus" };
    const usage = { windows: [], source: "probe" as const, at: NOW.toISOString() };
    const { state } = await onMac({ brain: "model", effectiveModel: null, accounts: [plus] }, { codex: { usage } });
    let d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    // Codex's own sign-in is reported on the MacBook its owner connected: the account the agents share. Claude Code's
    // isn't, and nothing of Claude's is there: no row of Claude's.
    const openai = brainRows(d).filter((r) => r.mark === "openai");
    expect(openai.map((r) => r.title).sort()).toEqual(["A conta que os seus agentes dividem", "Pessoal"]);
    expect(brainRows(d).some((r) => r.mark === "claude" && r.group !== "Em uso")).toBe(false);
    await pickRow(d, (r) => r.mark === "openai" && r.title === "A conta que os seus agentes dividem");
    await click(mainButton(d) as HTMLElement);
    await settle(6);
    // From the API another plan starts on its own default model.
    expect(brainCalls(state).at(-1)).toEqual({ brain: "codex", model: null, account: null });
    cleanup();
    // Without Codex's own sign-in reported, a ChatGPT account of hers that thinks for nobody.
    const second = await onMac({ brain: "model", effectiveModel: null, accounts: [plus] });
    d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    expect(
      brainRows(d)
        .filter((r) => r.mark === "openai")
        .map((r) => r.title),
    ).toEqual(["Pessoal"]);
    await pickRow(d, "Pessoal");
    await click(mainButton(d) as HTMLElement);
    await settle(6);
    expect(brainCalls(second.state).at(-1)).toMatchObject({ brain: "codex", account: "acct_plus" });
  });

  test("at the limit, Esperar closes it and changes nothing", async () => {
    const full: PlanUsage = {
      windows: [{ kind: "five_hour", usedPercent: 100 }],
      limited: true,
      source: "turn",
      at: new Date().toISOString(),
    };
    const { state } = await onMac({ account: "acct_work", accounts: [{ ...work, usedBy: ["Ada"], usage: full }] });
    const d = await brainDialog(/no limite$/);
    expect(d.textContent).toContain("Trabalho volta quando o plano renovar");
    await click(within(d).getByRole("button", { name: "Esperar" }));
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(brainCalls(state)).toEqual([]);
  });
});

describe("Quem pensa: a plan with a login per agent, and plans on the Cloud", () => {
  const glm = (id: string, usedBy: string[]): MachineAccount => ({
    id,
    kind: "claude_code",
    label: "GLM Coding",
    email: null,
    plan: null,
    status: "active",
    ownerId: "u-walter",
    ownerName: "Walter Nogueira",
    mine: true,
    usedBy,
    usage: null,
    provider: "zai",
    keyHint: "4f2a",
  });

  test("a coding plan whose logins think for other agents: one more for this one, its key pasted again", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    api.agents.brain = async () =>
      fakeAgentBrain(ADA_ID, {
        brain: "claude_code",
        effectiveModel: "sonnet",
        accounts: [glm("acct_theo", ["Theo"]), glm("acct_lia", ["Lia"])],
      });
    fakeMachinesOf.get(api)?.endLogin("login_1", { state: "done", account: glm("acct_ada", []) });
    await open(state, api);
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    // One row for the account, not one per login: Claude's account choice is Claude's alone.
    const rows = brainRows(d).filter((r) => r.title === "GLM Coding");
    expect(rows.map((r) => [r.lines, r.mark])).toEqual([[["Também usada por Theo e Lia"], "zai"]]);
    await pickRow(d, "GLM Coding");
    expect(mainButton(d)?.textContent).toBe("Fazer login para a Ada");
    await click(mainButton(d) as HTMLElement);
    const block = within(d).getByRole("region", { name: "Conectar GLM Coding" });
    fireEvent.change(within(block).getByLabelText("Chave do GLM Coding"), {
      target: { value: "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp" },
    });
    await click(within(block).getByRole("button", { name: "Enviar ao MacBook" }));
    await settle(8);
    expect(loginArgs(state)).toEqual([ORG_ID, "machine_1", "claude_code", { provider: "zai" }]);
    // Signed in, it thinks with it at once.
    expect(brainCalls(state).at(-1)).toMatchObject({ account: "acct_ada" });
    expect(brainScreen(d)).toBe("Pronto");
  });
});

describe("Usar em outros agentes (ADR 0094)", () => {
  const LIA_ID = "00000000-0000-4000-8000-0000000000a9";

  async function withOthers(tweak?: (api: ReturnType<typeof createFakeApi>) => void) {
    const state = seedState();
    const [, atlas] = state.agents;
    if (!atlas) throw new Error("no Atlas");
    state.agents.push({ ...atlas, id: LIA_ID, name: "Lia", handle: "lia" });
    state.setupResults = { [LIA_ID]: { status: "skipped", reason: "other_computer", params: { computer: "PC" } } };
    const api = createFakeApi(state);
    tweak?.(api);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    reportOwn(api, { claude_code: { plan: "max" } });
    await open(state, api);
    return state;
  }
  const copyCalls = (state: ReturnType<typeof seedState>) =>
    state.calls.filter((c) => c.method === "agents.applySetup").map((c) => c.args[1]);
  /** A fake whose agents keep the key they were given, as the server does (its own answers the default key). */
  const withKeys = (state: ReturnType<typeof seedState>) => {
    const api = createFakeApi(state);
    const keys = new Map<string, string | null>();
    const { detail, update } = api.agents;
    api.agents.detail = async (orgId, agentId) => {
      const d = await detail(orgId, agentId);
      return keys.has(agentId) ? { ...d, credentialId: keys.get(agentId) ?? null } : d;
    };
    api.agents.update = async (orgId, agentId, input) => {
      if (input.credentialId !== undefined) keys.set(agentId, input.credentialId);
      return update(orgId, agentId, input);
    };
    return api;
  };

  /** Ada switched onto the MacBook's own Claude sign-in (the dialog closed after), so that is what is saved. */
  async function onClaude() {
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    await pickRow(d, (r) => r.mark === "claude" && r.group !== "Em uso");
    await click(mainButton(d) as HTMLElement);
    await settle(6);
    await done(d);
    await settle(4);
  }
  /** "Mais opções", then its "Usar em outros agentes": the dialog over "Quem pensa". */
  async function copyDialog(d: HTMLElement) {
    await toScreen(d, "Mais opções");
    await toScreen(d, "Usar em outros agentes");
    await settle(4);
    return screen().getByRole("dialog", { name: "Usar em outros agentes" });
  }

  test("Todos says how many can take it only once the preview says so", async () => {
    let arrive = () => {};
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    await withOthers((api) => {
      const apply = api.agents.applySetup;
      api.agents.applySetup = async (orgId, input) => {
        await arrived;
        return apply(orgId, input);
      };
    });
    await onClaude();
    const c = await copyDialog(await brainDialog());
    expect(within(c).queryByRole("checkbox", { name: /^Todos/ })).toBeNull();
    expect(c.textContent).not.toContain("0 agente");
    arrive();
    await settle(4);
    expect(c.textContent).toContain("1 agente pode usar");
  });

  test("the API's model and key go too, for an admin; nothing to pick when nobody can take it", async () => {
    const state = seedState();
    state.credentials.push({
      id: "cred-2",
      provider: "anthropic",
      label: "Claude do time",
      keyHint: "9b1c",
      createdAt: NOW.toISOString(),
      revokedAt: null,
    });
    state.setupResults = { [ATLAS_ID]: { status: "same" } };
    await open(state, withKeys(state));
    let d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    await pickRow(d, "Claude do time");
    await click(mainButton(d) as HTMLElement);
    await settle(6);
    await done(d);
    await settle(4);
    d = await brainDialog();
    const c = await copyDialog(d);
    expect(copyCalls(state)[0]).toEqual({
      setup: { brain: "model", model: "claude-sonnet-5-5", key: "cred-2", contextTokens: null },
      agentIds: [ADA_ID, ATLAS_ID],
      preview: true,
    });
    expect(
      within(c)
        .getByRole("checkbox", { name: /^Atlas/ })
        .closest("label")?.textContent,
    ).toContain("Já pensa assim");
    expect(c.textContent).toContain("Nenhum outro agente pode usar agora.");
    expect(c.textContent).not.toContain("0 agente");
    expect(
      within(c)
        .getByRole("checkbox", { name: /^Todos/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  // On the workspace's default key the agent's saved key is the picker's placeholder: the copy sends null, the way the
  // server reads "each agent on the workspace's default key".
  test("on the workspace's default key the copy sends key null, never the picker's placeholder", async () => {
    const state = seedState();
    state.setupResults = { [ATLAS_ID]: { status: "same" } };
    await open(state);
    await copyDialog(await brainDialog());
    expect(copyCalls(state)[0]).toMatchObject({ setup: { brain: "model", key: null }, preview: true });
  });

  test("not offered while it thinks with nothing yet: a plan with no sign-in on its computer", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    // Claude Code with no account and no sign-in of the MacBook's to think with: the plan itself, nothing to copy.
    api.agents.brain = async () =>
      fakeAgentBrain(ADA_ID, { brain: "claude_code", effectiveModel: "sonnet", account: null, ownSignIn: false });
    await open(state, api);
    const d = await brainDialog();
    await toScreen(d, "Mais opções");
    expect(within(d).queryByRole("button", { name: /^Usar em outros agentes/ })).toBeNull();
  });
});
