import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ApiClient } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { routineRun } from "./fakes/planning";
import { hintOf, shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

/** ADR 0106: a routine started by a call to its own address, on its page and in the form. */

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

async function open(prepare?: (api: ApiClient) => Promise<unknown>, api: ApiClient = createFakeApi(seedState())) {
  await prepare?.(api);
  await renderApp(`/org/${ORG_ID}/routines`, { api });
  await settle(8);
  return api;
}
const card = (name: string) => screen().getByRole("article", { name });
const details = async (name: string) => {
  await click(within(card(name)).getByRole("button", { name }));
  await settle(6);
  return screen().getByRole("dialog", { name });
};
const webhookRoutine = (api: ApiClient) =>
  api.routines.create(ORG_ID, {
    name: "Pedidos pagos",
    agentId: seedState().agents[0]?.id ?? "",
    prompt: "Confira o pedido que chegou.",
    target: { type: "dm" },
    trigger: { type: "webhook" },
  });

describe("Rotinas: started by a webhook", () => {
  test("Nova rotina › Webhook says what it is, and the routine's page opens on its address once created", async () => {
    // The list asked again after the routine is made never answers: the page opens from what the creation answered.
    const base = createFakeApi(seedState());
    let listing = true;
    const api: ApiClient = {
      ...base,
      routines: {
        ...base.routines,
        list: (orgId) => (listing ? base.routines.list(orgId) : new Promise(() => {})),
      },
    };
    await open(undefined, api);
    await click(screen().getAllByRole("button", { name: "Nova rotina" })[0] as HTMLElement);
    await settle(4);
    const form = screen().getByRole("dialog", { name: "Nova rotina" });
    await type(within(form).getByLabelText("O que fazer"), "Confira o pedido que chegou.");
    await type(within(form).getByLabelText("Nome (opcional)"), "Pedidos pagos");
    await click(within(form).getByRole("radio", { name: "Webhook" }));
    expect(shownText(form)).toContain("A rotina ganha um endereço só dela.");
    expect(shownText(form)).not.toContain("Cada POST que chegar nele");
    expect(hintOf("Endereço", form).text).toContain("Cada POST que chegar nele aciona o agente");
    listing = false;
    await click(within(form).getByRole("button", { name: "Criar rotina" }));
    await settle(10);
    const page = screen().getByRole("dialog", { name: "Pedidos pagos" });
    expect(page.textContent).toContain("Quando o webhook for chamado");
    expect(page.textContent).toContain("Endereço");
    expect(page.textContent).toMatch(/https:\/\/app\.agentes\.test\/api\/hooks\/\S{43}/);
    await click(within(page).getByRole("button", { name: "Fechar detalhes" }));
    expect(card("Pedidos pagos").textContent).toContain("Quando o webhook for chamado");
  });

  test("its page: a signing secret shown once, a new address after a confirmation, Testar and the latest calls", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await open(webhookRoutine, api);
    const page = await details("Pedidos pagos");
    const url = /https:\/\/app\.agentes\.test\/api\/hooks\/\S{43}/;
    const first = page.textContent?.match(url)?.[0];
    expect(page.textContent).toContain("Desligada: o agente recebe qualquer chamada ao endereço.");
    expect(page.textContent).toContain("Nenhuma chamada ainda.");

    await click(within(page).getByRole("button", { name: "Exigir assinatura" }));
    await settle(4);
    expect(page.textContent).toContain("Copie o segredo agora. Ele não aparece de novo.");
    expect(page.textContent).toContain("Ligada: só passam as chamadas assinadas com o segredo.");
    // The example signs its body with the secret just made.
    expect(page.textContent).toMatch(/SECRET='secret_\w+'/);
    expect(page.textContent).toContain("X-Agentes-Signature: sha256=$SIG");

    await click(within(page).getByRole("button", { name: "Gerar novo endereço" }));
    expect(page.textContent).toContain("O endereço atual para de funcionar na hora.");
    await click(within(page).getByRole("button", { name: "Gerar novo endereço" }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "routines.newHookAddress")).toBe(true);
    expect(page.textContent?.match(url)?.[0]).not.toBe(first);
    expect(screen().getByText("Endereço novo. O antigo já não funciona.")).toBeTruthy();

    await click(within(page).getByRole("button", { name: "Testar" }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "routines.testHook")).toBe(true);
    const calls = within(page).getByRole("list", { name: "Últimas chamadas" });
    expect(calls.textContent).toContain("Recebida · 74 bytes · Teste");
  });

  test("its page: the service's own secret, pasted, signs its calls from then on, and is never shown back", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await open(webhookRoutine, api);
    const page = await details("Pedidos pagos");
    await click(within(page).getByRole("button", { name: "Usar o segredo do serviço" }));
    await type(within(page).getByLabelText("Segredo de assinatura do serviço"), "lin_wh_fake_secret");
    await click(within(page).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "routines.newHookSecret" && String(c.args).includes("pasted"))).toBe(
      true,
    );
    expect(page.textContent).toContain("Ligada: só passam as chamadas assinadas com o segredo.");
    expect(page.textContent).not.toContain("lin_wh_fake_secret");
    expect(page.textContent).not.toContain("Copie o segredo agora.");
  });

  test("Execuções: a webhook run's calls open on its line, headers and body as kept", async () => {
    const base = createFakeApi(seedState());
    const at = new Date(Date.now() - 60_000).toISOString();
    const api: ApiClient = {
      ...base,
      routines: {
        ...base.routines,
        runs: async () => [routineRun({ id: "run-1", at, status: "silent", calls: 1 })],
        runCalls: async () => [
          {
            n: 1,
            at,
            method: "POST",
            headers: { "linear-event": "Issue" },
            bytes: 40,
            body: '{"data":{"id":"ISS-1"}}',
            cut: false,
            binary: false,
            test: false,
          },
        ],
      },
    };
    await open(webhookRoutine, api);
    const page = await details("Pedidos pagos");
    await act(async () => fireEvent.mouseDown(within(page).getByRole("tab", { name: /^Execuções/ }), { button: 0 }));
    await settle(4);
    await click(within(page).getByRole("button", { name: "Chamadas (1)" }));
    await settle(4);
    expect(page.textContent).toContain("linear-event: Issue");
    expect(page.textContent).toContain('"id": "ISS-1"');
    expect(within(page).getByRole("button", { name: "Ocultar chamadas" })).toBeTruthy();
  });

  test("its page: the methods the address answers, POST by default, at least one on; GET's example sends a query", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await open(webhookRoutine, api);
    const page = await details("Pedidos pagos");
    expect(page.textContent).toContain("Aceita POST.");
    const pill = (m: string) => within(page).getByRole("checkbox", { name: m });
    expect(pill("POST").getAttribute("aria-checked")).toBe("true");
    expect(pill("POST").hasAttribute("disabled")).toBe(true);
    await click(pill("GET"));
    await settle(6);
    const updates = () => state.calls.filter((c) => c.method === "routines.update").map((c) => c.args[1]);
    expect(updates().at(-1)).toEqual({ trigger: { type: "webhook", methods: ["GET", "POST"] } });
    expect(page.textContent).toContain("Aceita GET, POST.");
    await click(pill("POST"));
    await settle(6);
    expect(updates().at(-1)).toEqual({ trigger: { type: "webhook", methods: ["GET"] } });
    expect(page.textContent).toMatch(/curl 'https:\/\/app\.agentes\.test\/api\/hooks\/\S{43}\?text=hello'/);
  });

  test("its page: Agrupar chamadas por saves a path, says what it does, and emptied puts every call in one line", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await open(webhookRoutine, api);
    const page = await details("Pedidos pagos");
    expect(page.textContent).toContain("Todas as chamadas esperam numa fila só, em ordem.");
    const field = within(page).getByRole("textbox", { name: "Agrupar chamadas por" });
    expect(within(page).queryByRole("button", { name: "Salvar" })).toBeNull();
    await type(field, " conversation.id ");
    await click(within(page).getByRole("button", { name: "Salvar" }));
    await settle(6);
    const updates = () => state.calls.filter((c) => c.method === "routines.update").map((c) => c.args[1]);
    expect(updates().at(-1)).toEqual({ trigger: { type: "webhook", groupBy: "conversation.id" } });
    expect(page.textContent).toContain("Chamadas com o mesmo conversation.id rodam em ordem.");
    await type(field, "");
    await click(within(page).getByRole("button", { name: "Salvar" }));
    await settle(6);
    expect(updates().at(-1)).toEqual({ trigger: { type: "webhook", groupBy: null } });
    expect(page.textContent).toContain("Todas as chamadas esperam numa fila só, em ordem.");
  });

  test("a new secret and turning the signature off say what stops working first", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await open(webhookRoutine, api);
    const page = await details("Pedidos pagos");
    const made = (method: string) => state.calls.filter((c) => c.method === method).length;
    await click(within(page).getByRole("button", { name: "Exigir assinatura" }));
    await settle(4);
    expect(made("routines.newHookSecret")).toBe(1);

    await click(within(page).getByRole("button", { name: "Gerar novo segredo" }));
    expect(page.textContent).toContain("O segredo atual para de valer na hora.");
    expect(made("routines.newHookSecret")).toBe(1);
    await click(within(page).getByRole("button", { name: "Cancelar" }));
    expect(page.textContent).not.toContain("O segredo atual para de valer na hora.");
    await click(within(page).getByRole("button", { name: "Gerar novo segredo" }));
    await click(within(page).getByRole("button", { name: "Gerar novo segredo" }));
    await settle(4);
    expect(made("routines.newHookSecret")).toBe(2);

    await click(within(page).getByRole("button", { name: "Desligar assinatura" }));
    expect(page.textContent).toContain("O agente volta a receber qualquer chamada ao endereço, assinada ou não.");
    expect(made("routines.removeHookSecret")).toBe(0);
    await click(within(page).getByRole("button", { name: "Desligar assinatura" }));
    await settle(4);
    expect(made("routines.removeHookSecret")).toBe(1);
    expect(page.textContent).toContain("Desligada: o agente recebe qualquer chamada ao endereço.");
  });

  test("whoever doesn't manage it never sees its address, on its page or in the menu", async () => {
    const base = createFakeApi(seedState());
    const api: ApiClient = {
      ...base,
      routines: {
        ...base.routines,
        list: async (orgId) =>
          (await base.routines.list(orgId)).map((r) =>
            r.name === "Pedidos pagos"
              ? {
                  ...r,
                  canManage: false,
                  trigger: {
                    type: "webhook" as const,
                    url: null,
                    signed: false,
                    methods: ["POST" as const],
                    groupBy: null,
                  },
                }
              : r,
          ),
      },
    };
    await open(webhookRoutine, api);
    const page = await details("Pedidos pagos");
    expect(page.textContent).toContain("Só quem pode mudar a rotina vê o endereço.");
    expect(within(page).queryByRole("button", { name: "Testar" })).toBeNull();
    expect(page.textContent).not.toContain("/api/hooks/");
  });
});
