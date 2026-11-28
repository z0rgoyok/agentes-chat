import { afterEach, describe, expect, test } from "bun:test";
import type { AiAccounts, AiComputer } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { shownText } from "./hint";
import { usageTab } from "./plan-rows";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};

const MAC: AiComputer = {
  machineId: "machine_1",
  name: "MacBook",
  online: true,
  mine: true,
  canAdd: true,
  keys: true,
  brains: { claude_code: true, codex: true },
};
const base = {
  kind: "claude_code" as const,
  plan: null,
  status: "active" as const,
  ownerId: "u-walter",
  ownerName: "Walter",
  mine: true,
  usage: null,
  provider: null,
  keyHint: null,
  machineId: "machine_1",
  computer: "MacBook",
};
const WORK: AiAccounts["accounts"][number] = {
  ...base,
  id: "acct_work",
  label: "Trabalho",
  email: "walt@acme.com",
  plan: "team",
  usedBy: ["Ada"],
  usage: {
    windows: [{ kind: "five_hour", usedPercent: 84, resetsAt: "2099-01-01T15:40:00.000Z" }],
    source: "probe",
    at: new Date().toISOString(),
  },
};
const MINIMAX: AiAccounts["accounts"][number] = {
  ...base,
  id: "acct_mm",
  label: "MiniMax",
  email: null,
  usedBy: [],
  provider: "minimax",
  keyHint: "MnOp",
};

async function page(accounts: AiAccounts["accounts"], role: "owner" | "member" = "owner", computers = [MAC]) {
  const state = seedState();
  if (state.me?.organizations[0]) state.me.organizations[0].role = role;
  const api = createFakeApi(state);
  fakeMachinesOf.get(api)?.setAiAccounts({ accounts, computers });
  // The old address of Contas de IA: it opens IA e uso, where the accounts are now.
  await renderApp(`/org/${ORG_ID}/settings/keys`, { api });
  await settle(6);
  return { state, api };
}

/** Contas de IA's rows: one per account. */
const rows = () => [...document.querySelectorAll(".aa-list .plan-row")] as HTMLElement[];

/** An account opened from its row: its detail. */
async function opened(row: HTMLElement | undefined) {
  await click((row as HTMLElement).querySelector(".plan-row__head") as HTMLElement);
  return screen().getAllByRole("dialog").at(-1) as HTMLElement;
}

/** Its ⋯ opened, as the keys open it. */
async function more(detail: HTMLElement) {
  const button = within(detail).getByRole("button", { name: /^Mais sobre / });
  button.focus();
  await act(async () => {
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyUp(button, { key: "Enter" });
  });
  await settle(2);
}

/** What its ⋯ offers, by name. */
async function action(detail: HTMLElement, name: string) {
  await more(detail);
  return within(screen().getByRole("menu")).getByRole("menuitem", { name });
}

/** Every item its ⋯ offers. */
async function actions(detail: HTMLElement) {
  await more(detail);
  const items = within(screen().getByRole("menu"))
    .getAllByRole("menuitem")
    .map((i) => i.textContent);
  await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
  await settle(2);
  return items;
}

describe("IA e uso: the viewer's own accounts", () => {
  test("the old address opens IA e uso; Add account is in the card's head (or its empty state), the same picker as everywhere", async () => {
    const { router } = await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(seedState()) });
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/usage`);
    const plans = screen().getByRole("region", { name: "Contas" });
    // One way to add an account: in the card's head, or in its empty state with nothing at all.
    const connect = within(plans).getByRole("button", { name: "Adicionar conta" });
    expect(connect.closest(".ac-empty, .ac-card__head")).not.toBeNull();
    await act(async () => fireEvent.click(connect));
    await settle(4);
    const dialog = screen().getAllByRole("dialog", { name: "Conectar uma IA" }).at(-1) as HTMLElement;
    expect(within(dialog).getByRole("group", { name: "Qual IA eles vão usar?" })).toBeTruthy();
  });

  test("a member sees their own accounts, one line each, never the workspace's keys; an admin sees both", async () => {
    const member = await page([WORK, MINIMAX], "member");
    // Looking at the plans asks the computers for fresh usage.
    expect(member.state.calls.some((c) => c.method === "machines.refreshAccountUsage")).toBe(true);
    const [work, mm] = rows();
    // One line: its name, its plan, its window closest to the limit.
    const head = work?.querySelector(".plan-row__head") as HTMLElement;
    expect(head.querySelector(".plan-row__title")?.textContent).toBe("Trabalho");
    // The viewer's own: in "Suas contas", its plan alone.
    expect(head.querySelector(".plan-row__owner")?.textContent).toBe("Team");
    expect(head.querySelector(".ac-planmeter__line")?.textContent).toBe("5h 84%");
    expect(within(head).getAllByRole("meter")).toHaveLength(1);
    // A coding plan's key: its maker's mark; opened, its key's end and the way to a new key.
    expect(mm?.querySelector('[data-mark="minimax"]')).not.toBeNull();
    const detail = await opened(mm);
    expect(detail.textContent).toContain("chave …MnOp");
    expect(await action(detail, "Trocar a chave")).toBeTruthy();
    expect(screen().queryByRole("region", { name: "Chaves de API" })).toBeNull();
    cleanup();
    await page([WORK]);
    expect(screen().getByRole("region", { name: "Contas" })).toBeTruthy();
    expect(screen().getByRole("region", { name: "Chaves de API" })).toBeTruthy();
  });

  test("an OpenCode key and a Gemini Enterprise seat each show their maker's logo, never a letter", async () => {
    const zen = {
      ...MINIMAX,
      id: "acct_zen",
      kind: "opencode" as const,
      label: "OpenCode",
      provider: "zen",
      keyHint: "Q7f2",
    };
    const seat = { ...WORK, id: "acct_seat", kind: "antigravity" as const, label: "Gemini", provider: "enterprise" };
    await page([zen, seat], "owner", [{ ...MAC, brains: { ...MAC.brains, opencode: true, antigravity: true } }]);
    const [oc, gemini] = rows();
    expect(oc?.textContent).toContain("OpenCode");
    expect(oc?.querySelector(".ac-brand")?.getAttribute("data-mark")).toBe("opencode");
    expect(gemini?.querySelector(".ac-brand")?.getAttribute("data-mark")).toBe("gemini");
    expect(document.querySelectorAll(".plan-row .ac-brand__initial")).toHaveLength(0);
  });

  test("a signed-out account its computer couldn't check says so, and still signs in again", async () => {
    await page([{ ...WORK, status: "signed_out" as const, statusKnown: false }]);
    const row = await opened(rows()[0]);
    expect(row.textContent).toContain("O computador não conseguiu confirmar o login desta vez.");
    expect(row.textContent).not.toContain("Saiu da conta.");
    expect(await action(row, "Entrar de novo")).toBeTruthy();
  });

  test("Sign in again: the account's own email goes to Claude's sign-in unseen; another account coming back is said, with Try again only", async () => {
    const out = { ...WORK, status: "signed_out" as const };
    const free = { ...WORK, id: "acct_pessoal", label: "Pessoal", email: "walt@gmail.com", usedBy: [], usage: null };
    const { state, api } = await page([out, free]);
    fakeMachinesOf.get(api)?.endLogin("login_1", {
      state: "failed",
      signedInAs: "walt@gmail.com",
      duplicate: { label: "Pessoal", account: free },
    });
    await click(await action(await opened(rows()[0]), "Entrar de novo"));
    const dialog = screen().getAllByRole("dialog", { name: "Trabalho" }).at(-1) as HTMLElement;
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(within(dialog).getByRole("button", { name: "Entrar com Claude" }));
      await settle(8);
    } finally {
      window.open = realOpen;
    }
    expect(state.calls.filter((c) => c.method === "machines.beginAccountLogin").map((c) => c.args[3])).toEqual([
      { accountId: "acct_work", email: "walt@acme.com" },
    ]);
    expect(shownText(dialog)).toContain(
      "O Claude entrou como walt@gmail.com, não como walt@acme.com. Saia na página do Claude e tente de novo.",
    );
    // No agent here to think with the one that came back: nothing to use it for.
    expect(within(dialog).queryByRole("button", { name: /^Usar / })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  });

  test("a sign-in the server refuses says why, not that the computer didn't answer; one it can't explain still does", async () => {
    const out = { ...WORK, status: "signed_out" as const };
    const { api } = await page([out]);
    api.machines.beginAccountLogin = async () => {
      throw new ApiError(409, "account.method_unsupported", "This computer can't connect Claude this way yet.");
    };
    await click(await action(await opened(rows()[0]), "Entrar de novo"));
    const dialog = screen().getAllByRole("dialog", { name: "Trabalho" }).at(-1) as HTMLElement;
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    const signIn = async () => {
      await click(within(dialog).getByRole("button", { name: "Entrar com Claude" }));
      await settle(8);
    };
    try {
      await signIn();
      expect(shownText(dialog)).toContain(
        "Este computador ainda não conecta o Claude desse jeito. Atualize o programa do agentes.chat nele, ou use uma chave de API.",
      );
      expect(shownText(dialog)).not.toContain("não respondeu");
      api.machines.beginAccountLogin = async () => {
        throw new ApiError(409, "account.runner_old", "The runner on MacBook is too old for accounts. Update it.");
      };
      await click(within(dialog).getByRole("button", { name: "Tentar de novo" }));
      await signIn();
      expect(shownText(dialog)).toContain("O app do computador é antigo demais para isso. Atualize e tente de novo.");
      // A code the app has no words for: the computer didn't answer.
      api.machines.beginAccountLogin = async () => {
        throw new ApiError(400, "account.invalid_kind", "Unknown account kind");
      };
      await click(within(dialog).getByRole("button", { name: "Tentar de novo" }));
      await signIn();
      expect(shownText(dialog)).toContain("O MacBook não respondeu. Tente de novo em instantes.");
    } finally {
      window.open = realOpen;
    }
  });

  test("disconnecting names the agent that thinks with it; renaming saves the new name", async () => {
    const { state } = await page([WORK, MINIMAX]);
    await click(await action(await opened(rows()[0]), "Desconectar"));
    const confirm = screen().getAllByRole("dialog", { name: "Desconectar Trabalho?" }).at(-1) as HTMLElement;
    expect(confirm.textContent).toContain(
      "Ada deixa de pensar com ela. O MacBook sai da conta e apaga o que guardava.",
    );
    await click(within(confirm).getByRole("button", { name: "Desconectar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "machines.removeAccount")?.args).toEqual([
      ORG_ID,
      "machine_1",
      "acct_work",
    ]);
    expect(document.body.textContent).toContain("Trabalho desconectada.");
    expect(rows()).toHaveLength(1);

    await click(await action(await opened(rows()[0]), "Renomear"));
    const rename = screen().getAllByRole("dialog", { name: "Renomear MiniMax" }).at(-1) as HTMLElement;
    await act(async () =>
      fireEvent.change(within(rename).getByLabelText("Nome"), { target: { value: "MiniMax do Walt" } }),
    );
    await click(within(rename).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "machines.renameAccount")?.args).toEqual([
      ORG_ID,
      "machine_1",
      "acct_mm",
      "MiniMax do Walt",
    ]);
  });
});

describe("IA e uso: the same account signed in again and again", () => {
  const copy = (id: string, over: Partial<AiAccounts["accounts"][number]> = {}): AiAccounts["accounts"][number] => ({
    ...base,
    kind: "codex",
    id,
    label: "ChatGPT",
    email: "walt@acme.com",
    plan: "plus",
    usedBy: [],
    ...over,
  });

  test("one row, its logins with no agent flagged, and Remover takes only those: the agents keep theirs", async () => {
    const { state } = await page([
      copy("gpt_ada", { usedBy: ["Ada"] }),
      copy("gpt_2", { status: "signed_out" }),
      copy("gpt_3"),
      copy("gpt_4", { status: "signed_out" }),
    ]);
    expect(rows()).toHaveLength(1);
    const row = await opened(rows()[0]);
    expect(row.textContent).toContain("Mais 3 logins desta conta, sem nenhum agente.");
    await click(await action(row, "Remover"));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "machines.removeAccount").map((c) => c.args.slice(1))).toEqual([
      ["machine_1", "gpt_2"],
      ["machine_1", "gpt_3"],
      ["machine_1", "gpt_4"],
    ]);
    expect(screen().getByText("3 logins sem uso removidos.")).toBeTruthy();
  });

  test("none with an agent: the signed-in one stays; a single login is never flagged", async () => {
    await page([copy("gpt_1", { status: "signed_out" }), copy("gpt_2")]);
    expect((await opened(rows()[0])).textContent).toContain("Mais 1 login desta conta, sem nenhum agente.");
    cleanup();
    await page([copy("gpt_1")]);
    const one = await opened(rows()[0]);
    expect(one.textContent).not.toContain("desta conta, sem nenhum agente");
    expect(await actions(one)).toEqual(["Renomear", "Desconectar"]);
  });
});

describe("IA e uso: a plan with a login per agent", () => {
  const usage = (percent: number, at: string) => ({
    windows: [{ kind: "five_hour" as const, usedPercent: percent, resetsAt: "2099-01-01T15:40:00.000Z" }],
    source: "probe" as const,
    at,
  });
  /** One GLM key signed in for Ada, Theo and Lia: three logins, one account. */
  type Row = AiAccounts["accounts"][number];
  const glm = (id: string, agent: string, over: Partial<Row> = {}): Row => ({
    ...MINIMAX,
    id,
    label: "GLM Coding",
    provider: "zai",
    keyHint: "4f2a",
    usedBy: [agent],
    ...over,
  });
  const LOGINS = [
    // Read within the last hours: a reading older than 6 hours shows only its age.
    glm("acct_ada", "Ada", { usage: usage(40, new Date(Date.now() - 2 * 3_600_000).toISOString()) }),
    glm("acct_theo", "Theo", { usage: usage(62, new Date(Date.now() - 3_600_000).toISOString()) }),
    glm("acct_lia", "Lia"),
  ];

  test("one row for the account, one meter from the newest usage; opened, its key's end and what its owner does", async () => {
    await page(LOGINS);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.querySelector(".plan-row__head .ac-planmeter__line")?.textContent).toBe("5h 62%");
    const detail = await opened(rows()[0]);
    expect(detail.textContent).toContain("chave …4f2a");
    expect(await actions(detail)).toEqual(["Renomear", "Trocar a chave", "Usar em todos os agentes", "Desconectar"]);
  });

  test("one login signed out: whose, said under the facts", async () => {
    const [ada, theo, lia] = LOGINS as [Row, Row, Row];
    await page([ada, { ...theo, status: "signed_out" }, lia]);
    expect((await opened(rows()[0])).textContent).toContain("Theo ficou sem login.");
  });

  test("Disconnect takes every login of the account, and the dialog names every agent", async () => {
    const { state } = await page(LOGINS);
    await click(await action(await opened(rows()[0]), "Desconectar"));
    const confirm = screen().getAllByRole("dialog", { name: "Desconectar GLM Coding?" }).at(-1) as HTMLElement;
    expect(confirm.textContent).toContain(
      "Ada, Theo e Lia deixam de pensar com ela. O MacBook sai da conta e apaga o que guardava.",
    );
    await click(within(confirm).getByRole("button", { name: "Desconectar" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "machines.removeAccount").map((c) => c.args[2])).toEqual([
      "acct_ada",
      "acct_theo",
      "acct_lia",
    ]);
  });

  test("two accounts with the same name stay two rows: a name is anyone's to repeat", async () => {
    const other = glm("acct_bo", "Bo", { keyHint: "9z9z" });
    const { state } = await page([...LOGINS, other]);
    expect(rows()).toHaveLength(2);
    const second = await opened(rows()[1]);
    expect(second.textContent).toContain("chave …9z9z");
    await click(await action(second, "Desconectar"));
    await click(
      within(screen().getAllByRole("dialog").at(-1) as HTMLElement).getByRole("button", { name: "Desconectar" }),
    );
    await settle(4);
    expect(state.calls.filter((c) => c.method === "machines.removeAccount").map((c) => c.args[2])).toEqual(["acct_bo"]);
  });

  test("Replace the key: the new key goes to every login of the account, sealed to each", async () => {
    const { state, api } = await page(LOGINS);
    const machines = fakeMachinesOf.get(api);
    for (const [n, l] of LOGINS.entries()) machines?.endLogin(`login_${n + 1}`, { state: "done", account: l });
    await click(await action(await opened(rows()[0]), "Trocar a chave"));
    const dialog = screen().getAllByRole("dialog", { name: "GLM Coding" }).at(-1) as HTMLElement;
    await act(async () =>
      fireEvent.change(within(dialog).getByLabelText("Chave do GLM Coding"), {
        target: { value: "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp" },
      }),
    );
    await click(within(dialog).getByRole("button", { name: "Enviar ao MacBook" }));
    await settle(12);
    expect(state.calls.filter((c) => c.method === "machines.beginAccountLogin").map((c) => c.args[3])).toEqual([
      { accountId: "acct_ada", provider: "zai" },
      { accountId: "acct_theo", provider: "zai" },
      { accountId: "acct_lia", provider: "zai" },
    ]);
    expect(new Set(machines?.logins().map((l) => JSON.stringify(l.box))).size).toBe(3);
    // Each took it: its dialog closes, back on the account.
    expect(screen().queryAllByRole("dialog")).toHaveLength(1);
  });

  test("Replace the key, one login failing: Try again sends the key only to that login", async () => {
    const { state, api } = await page(LOGINS);
    const machines = fakeMachinesOf.get(api);
    const [ada, theo, lia] = LOGINS as [Row, Row, Row];
    machines?.endLogin("login_1", { state: "done", account: ada });
    machines?.endLogin("login_2", { state: "done", account: theo });
    machines?.endLogin("login_3", { state: "failed" });
    machines?.endLogin("login_4", { state: "done", account: lia });
    await click(await action(await opened(rows()[0]), "Trocar a chave"));
    const dialog = screen().getAllByRole("dialog", { name: "GLM Coding" }).at(-1) as HTMLElement;
    const send = async () => {
      await act(async () =>
        fireEvent.change(within(dialog).getByLabelText("Chave do GLM Coding"), {
          target: { value: "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp" },
        }),
      );
      await click(within(dialog).getByRole("button", { name: "Enviar ao MacBook" }));
      await settle(12);
    };
    await send();
    await click(within(dialog).getByRole("button", { name: "Tentar de novo" }));
    await send();
    expect(state.calls.filter((c) => c.method === "machines.beginAccountLogin").map((c) => c.args[3])).toEqual([
      { accountId: "acct_ada", provider: "zai" },
      { accountId: "acct_theo", provider: "zai" },
      { accountId: "acct_lia", provider: "zai" },
      { accountId: "acct_lia", provider: "zai" },
    ]);
    expect(screen().queryAllByRole("dialog")).toHaveLength(1);
  });

  test("an account for all of Walter's agents there: Disconnect says to revoke the token on Claude", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const machines = fakeMachinesOf.get(api);
    machines?.pair({ id: "machine_1", name: "MacBook", mode: "system", agents: [] });
    const all = {
      ...base,
      id: "acct_all",
      label: "Claude",
      email: null,
      usedBy: ["Ada"],
      usedByIds: [ADA_ID],
      shared: true,
    };
    machines?.setAiAccounts({ accounts: [all], computers: [MAC] });
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api });
    await settle(6);
    await click(await action(await opened(rows()[0]), "Desconectar"));
    const dialog = screen().getAllByRole("dialog").at(-1) as HTMLElement;
    expect(dialog.textContent).toContain("Para encerrar também no Claude, revogue nas configurações do Claude.");
  });
});

describe("Remover todos os logins do Grok (issue #319)", () => {
  const grok = (id: string, over: Partial<AiAccounts["accounts"][number]> = {}) =>
    ({
      ...base,
      id,
      kind: "grok" as const,
      label: "Grok",
      email: "walt@acme.com",
      usedBy: [],
      ...over,
    }) as AiAccounts["accounts"][number];

  test("one confirmation takes every Grok login the viewer owns, on every computer, and never someone else's", async () => {
    const { state } = await page([
      grok("acct_g1"),
      grok("acct_g2", { usedBy: ["Ada"] }),
      grok("acct_ada", { ownerId: "u_ada", ownerName: "Ada", mine: false }),
      WORK,
    ]);
    await usageTab();
    await click(screen().getByRole("button", { name: "Remover todos os logins do Grok" }));
    const confirm = screen()
      .getAllByRole("dialog", { name: "Remover todos os 2 logins do Grok?" })
      .at(-1) as HTMLElement;
    expect(confirm.textContent).toContain("Eles deixam de pensar nos agentes deles em MacBook.");
    await click(within(confirm).getByRole("button", { name: "Remover todos os logins do Grok" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "machines.removeAccount").map((c) => c.args[2])).toEqual([
      "acct_g1",
      "acct_g2",
    ]);
    expect(document.body.textContent).toContain("2 logins do Grok removidos.");
  });

  test("with a single Grok login the row's own Desconectar is enough: no batch action", async () => {
    await page([grok("acct_only"), WORK]);
    await usageTab();
    expect(screen().queryByRole("button", { name: "Remover todos os logins do Grok" })).toBeNull();
  });
});
