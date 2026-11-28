import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Agent, ApiClient, Connection, MailAccount } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, fakeMailOf, ORG_ID, seedState } from "./fake-api";
import { MAIL_PROVIDERS } from "./fakes/mail";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
/** Opens a select and picks an option. */
const choose = async (combobox: HTMLElement, option: string) => {
  combobox.focus();
  await act(async () => fireEvent.keyDown(combobox, { key: "Enter" }));
  await click(screen().getByRole("option", { name: option }));
  await settle();
};

const FINANCE_ID = "00000000-0000-4000-8000-0000000000f1";
const ROUTINE = "Pagamentos com problema";

/** The workspace with a third agent, and one app just connected. */
function workspace(connector = "stripe") {
  const state = seedState({ connections: [] });
  const ada = state.agents.find((a) => a.id === ADA_ID) as Agent;
  state.agents = [...state.agents, { ...ada, id: FINANCE_ID, name: "Contas", handle: "contas", role: "Financeiro" }];
  state.connections = [
    {
      id: `conn-${connector}`,
      connector,
      label: connector,
      serverUrl: `https://mcp.${connector}.example/`,
      authType: "oauth",
      accountLabel: "acme",
      tokenExpiresAt: null,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    } as Connection,
  ];
  return { state, api: createFakeApi(state) };
}

/** Back from the app's sign-in: the confirmation of connecting it. */
async function connected(api: ApiClient, connector = "stripe") {
  await renderApp(`/org/${ORG_ID}/settings/connectors?connected=${connector}`, { api });
  await settle(8);
  return flow();
}

const made = async (api: ApiClient) => (await api.routines.list(ORG_ID)).filter((r) => r.name === ROUTINE);

describe("the routine an app brings, at the end of connecting it (ADR 0242)", () => {
  test("on, with the first agent that may run it; Done makes it in my DM and starts it, and Undo takes it back", async () => {
    const { api } = workspace();
    const dialog = await connected(api);
    expect(within(dialog).getByText(ROUTINE)).toBeTruthy();
    expect(dialog.textContent).toContain("Ada confere recusas, reembolsos e contestações e te manda no privado.");
    const on = within(dialog).getByRole("switch", { name: `Criar a rotina ${ROUTINE}` });
    expect(on.getAttribute("aria-checked")).toBe("true");
    expect(within(dialog).getByRole("combobox", { name: "Quem faz" }).textContent).toContain("Ada");
    expect(within(dialog).getByRole("combobox", { name: "Quando" }).textContent).toContain("De segunda a sexta");

    await click(within(dialog).getByRole("button", { name: "Pronto" }));
    await settle(8);
    const [routine, ...more] = await made(api);
    expect(more).toHaveLength(0);
    expect(routine).toMatchObject({
      agentId: ADA_ID,
      target: { type: "dm" },
      report: "when_new",
      state: "running",
    });
    expect(routine?.trigger.type).toBe("schedule");
    expect(document.body.textContent).toContain(`Rotina criada: ${ROUTINE}`);
    expect(document.body.textContent).toContain("Ada já começou: o primeiro resumo chega no seu privado.");

    await click(screen().getByRole("button", { name: "Desfazer" }));
    await settle(6);
    expect(await made(api)).toHaveLength(0);
    expect(document.body.textContent).toContain("Rotina desfeita");
  });

  test("while the routines come, its line loads in place and Done waits; then both are there", async () => {
    const { api } = workspace();
    const list = api.routines.list;
    let arrive = () => {};
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    api.routines.list = async (orgId) => {
      await arrived;
      return list(orgId);
    };
    const dialog = await connected(api);
    // What it is, at once; who and when as their shapes; Done held.
    expect(within(dialog).getByText(ROUTINE)).toBeTruthy();
    expect(within(dialog).getByRole("status", { name: "Preparando a rotina…" })).toBeTruthy();
    expect(within(dialog).queryByRole("combobox", { name: "Quem faz" })).toBeNull();
    expect((within(dialog).getByRole("button", { name: "Pronto" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => arrive());
    await settle(6);
    expect(within(dialog).queryByRole("status", { name: "Preparando a rotina…" })).toBeNull();
    expect(within(dialog).getByRole("combobox", { name: "Quem faz" }).textContent).toContain("Ada");
    expect((within(dialog).getByRole("button", { name: "Pronto" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("another agent and another time, picked on the spot", async () => {
    const { api } = workspace();
    const dialog = await connected(api);
    await choose(within(dialog).getByRole("combobox", { name: "Quem faz" }), "Contas");
    expect(dialog.textContent).toContain("Contas confere recusas");
    await choose(within(dialog).getByRole("combobox", { name: "Quando" }), "Todos os dias, às 08:00");
    await click(within(dialog).getByRole("button", { name: "Pronto" }));
    await settle(8);
    const [routine] = await made(api);
    expect(routine?.agentId).toBe(FINANCE_ID);
    expect(JSON.stringify(routine?.trigger)).toContain("08:00");
  });

  test("switched off, Pronto only closes", async () => {
    const { api } = workspace();
    const dialog = await connected(api);
    await click(within(dialog).getByRole("switch", { name: `Criar a rotina ${ROUTINE}` }));
    expect(within(dialog).queryByRole("combobox", { name: "Quem faz" })).toBeNull();
    await click(within(dialog).getByRole("button", { name: "Pronto" }));
    await settle(8);
    expect(await made(api)).toHaveLength(0);
  });

  test("never offered twice: a routine of that name is already there", async () => {
    const { api } = workspace();
    await api.routines.create(ORG_ID, {
      name: ROUTINE,
      agentId: ADA_ID,
      prompt: "Olhe os pagamentos.",
      target: { type: "dm" },
      trigger: { type: "schedule", phrase: "toda segunda às 9h" },
    });
    const dialog = await connected(api);
    expect(within(dialog).queryByRole("switch")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Pronto" })).toBeTruthy();
  });

  test("an app that brings no routine ends as before", async () => {
    const { api } = workspace("notion");
    const before = (await api.routines.list(ORG_ID)).length;
    const dialog = await connected(api, "notion");
    expect(within(dialog).queryByRole("switch")).toBeNull();
    await click(within(dialog).getByRole("button", { name: "Pronto" }));
    await settle(6);
    expect(await api.routines.list(ORG_ID)).toHaveLength(before);
  });
});

describe("a mailbox's routine, where its readers are chosen", () => {
  function mailbox() {
    const { state, api } = workspace();
    state.connections = [];
    const mail = fakeMailOf.get(api);
    if (!mail) throw new Error("no mail fake");
    mail.providers = structuredClone(MAIL_PROVIDERS);
    mail.accounts = [
      {
        id: "mail-1",
        provider: "gmail",
        via: "composio",
        preset: null,
        address: "vendas@acme.example",
        offActions: [],
        askActions: [],
        aliases: [],
        defaultFrom: null,
        label: "vendas@acme.example",
        status: "active",
        lastError: null,
        createdAt: new Date().toISOString(),
        ownerUserId: state.me?.user.id ?? null,
        agents: [],
      } as MailAccount,
    ];
    return { state, api };
  }

  test("nobody reads it yet: off, saying what to do; one reader makes it theirs, made with the access", async () => {
    const { api } = mailbox();
    await renderApp(`/org/${ORG_ID}/settings/connectors?mail=connected&account=mail-1`, { api });
    await settle(8);
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    const who = screen().getByRole("dialog", { name: "Quem pode usar vendas@acme.example" });
    const routineSwitch = () => within(who).getByRole("switch", { name: "Criar a rotina Emails que pedem resposta" });
    expect(routineSwitch().getAttribute("aria-checked")).toBe("false");
    expect(routineSwitch().hasAttribute("disabled")).toBe(true);
    expect(who.textContent).toContain("Dê acesso a um agente acima e ele cuida disso para você.");

    await click(
      within(within(who).getByRole("radiogroup", { name: "Nível de Ada" })).getByRole("radio", { name: "Ler" }),
    );
    expect(routineSwitch().getAttribute("aria-checked")).toBe("true");
    expect(who.textContent).toContain(
      "Ada lê seus emails e te manda no privado o que precisa de resposta, já com rascunho.",
    );
    // Only who reads it may run it.
    const agents = within(who).getByRole("combobox", { name: "Quem faz" });
    expect(agents.textContent).toContain("Ada");

    await click(within(who).getByRole("button", { name: "Continuar" }));
    await settle(8);
    const [routine] = (await api.routines.list(ORG_ID)).filter((r) => r.name === "Emails que pedem resposta");
    expect(routine).toMatchObject({ agentId: ADA_ID, target: { type: "dm" } });
    expect(routine?.prompt).toContain("Só a caixa vendas@acme.example.");
  });
});
