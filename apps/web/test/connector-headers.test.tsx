import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, type CustomConnectStart } from "@agenteschat/client";
import { MAX_HEADER_NAME, MAX_REQUEST_HEADERS } from "@agenteschat/client/lib/request-headers";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { backToList, openConnection, openStore, pick } from "./catalog";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle, showIn } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const snapshot = () => (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
/** The request headers' disclosure: the second one, under the key's. */
const disclosure = () => flow().querySelectorAll("details.cflow__more")[1] as HTMLDetailsElement;
const nameField = (n: number) => within(flow()).getByLabelText(`Nome do cabeçalho ${n}`) as HTMLInputElement;
const valueField = (n: number) => within(flow()).getByLabelText(`Valor do cabeçalho ${n}`) as HTMLInputElement;
const add = () => within(flow()).getByRole("button", { name: "Adicionar cabeçalho" }) as HTMLButtonElement;
const header = async (n: number, name: string, value: string) => {
  await type(nameField(n), name);
  await type(valueField(n), value);
};
const connectCalls = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "customConnectors.connect").map((c) => c.args[1] as Record<string, unknown>);
/** What `run` scrolls into sight. There is no layout here: the call is all there is to see. */
async function scrolledBy(run: () => Promise<void>) {
  const shown: Element[] = [];
  const element = Element.prototype as { scrollIntoView?: (this: Element) => void };
  const scroll = element.scrollIntoView;
  element.scrollIntoView = function () {
    shown.push(this);
  };
  try {
    await run();
  } finally {
    element.scrollIntoView = scroll;
  }
  return shown;
}

const ADDRESS = "https://mcp.example.com/mcp";
/** "Connect by address" under the list, with an address and a name typed, the headers open. */
async function openForm(state = seedState(), api = createFakeApi(state)) {
  const app = await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
  await settle(8);
  await click(screen().getByRole("button", { name: "Conectar pelo endereço" }));
  await type(within(flow()).getByLabelText("Endereço do servidor MCP"), ADDRESS);
  await type(within(flow()).getByLabelText("Nome"), "Suporte");
  expect(disclosure().hasAttribute("open")).toBe(false);
  await click(within(flow()).getByText("Cabeçalhos da requisição"));
  return { state, api, app };
}
/** Reconnect on a connection's page (its line opened first when no page is open yet). */
async function reconnectFromPage(name: string) {
  const page = (document.querySelector(".store-page") as HTMLElement | null) ?? (await openConnection(name));
  await click(within(page).getByRole("button", { name: `Reconectar ${name}` }));
  await settle(2);
}
/** Conectores with "Suporte" connected by headers alone, and its Reconnect at hand. */
async function openReconnect(names = ["X-API-Key", "X-Tenant"]) {
  const state = seedState();
  const api = createFakeApi(state);
  const res = await api.customConnectors.connect(ORG_ID, {
    serverUrl: ADDRESS,
    label: "Suporte",
    headers: names.map((name) => ({ name, value: "fake-value" })),
    returnTo: "/",
  });
  if (res.status !== "connected") throw new Error("expected connected");
  state.calls.length = 0;
  const app = await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
  await settle(8);
  const reconnect = () => reconnectFromPage("Suporte");
  return { state, api, app, server: res.server, reconnect };
}

describe("request headers for a server by address", () => {
  test("closed until asked for; a name and a secret value per row; headers alone connect", async () => {
    const { state } = await openForm();
    expect(disclosure().hasAttribute("open")).toBe(true);
    expect(disclosure().textContent).toContain(
      "Para uma chave que vai em outro cabeçalho, ou um gateway na frente do servidor. A maioria dos servidores não precisa.",
    );
    expect(nameField(1).placeholder).toBe("X-API-Key");
    // A name longer than the server takes can't be typed: its refusal would name no way out.
    expect(nameField(1).maxLength).toBe(MAX_HEADER_NAME);
    expect([valueField(1).type, valueField(1).autocomplete, nameField(1).autocomplete]).toEqual([
      "password",
      "off",
      "off",
    ]);
    await header(1, "X-API-Key", "fake-value");
    await click(add());
    await header(2, "X-Tenant", "acme");
    // A row left blank is no header.
    await click(add());
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(connectCalls(state)).toEqual([
      expect.objectContaining({
        serverUrl: ADDRESS,
        apiKey: undefined,
        headers: [
          { name: "X-API-Key", value: "[redacted]" },
          { name: "X-Tenant", value: "[redacted]" },
        ],
      }),
    ]);
    expect(screen().getByRole("dialog", { name: "Suporte conectado" })).toBe(flow());
  });

  test("with a key the two go together; the headers' own row goes with Remover", async () => {
    const { state } = await openForm();
    await header(1, "X-Tenant", "acme");
    await click(add());
    await header(2, "X-Wrong", "nope");
    await click(within(flow()).getByRole("button", { name: "Remover cabeçalho 2" }));
    expect(within(flow()).queryByLabelText("Nome do cabeçalho 2")).toBeNull();
    await click(within(flow()).getByText("Conectar com uma chave de API"));
    // No key yet: the headers alone would go.
    expect(within(flow()).queryByRole("button", { name: "Conectar com a chave" })).toBeNull();
    await type(within(flow()).getByLabelText("Chave de API"), "test-key-1");
    await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }));
    await settle(4);
    expect(connectCalls(state)).toEqual([
      expect.objectContaining({ apiKey: "[redacted]", headers: [{ name: "X-Tenant", value: "[redacted]" }] }),
    ]);
  });

  test("ten at most: the button that adds one turns off and says why", async () => {
    await openForm();
    for (let n = 2; n <= MAX_REQUEST_HEADERS; n++) {
      expect(add().disabled).toBe(false);
      await click(add());
    }
    expect(nameField(MAX_REQUEST_HEADERS)).toBeTruthy();
    expect(add().disabled).toBe(true);
    expect(disclosure().textContent).toContain(
      "Um servidor aceita no máximo 10 cabeçalhos. Remova um para adicionar outro.",
    );
    expect(add().getAttribute("aria-describedby")).toBe("cflow-headers-full");
    const fourth = within(flow()).getByRole("button", { name: "Remover cabeçalho 4" });
    fourth.focus();
    await click(fourth);
    expect(add().disabled).toBe(false);
    expect(disclosure().textContent).not.toContain("no máximo");
    // The removed row's button is gone: the focus is on the one that adds a row, not lost to the page.
    expect(document.activeElement).toBe(add());
  });

  test("the server's refusal shows on its row, in plain words, once; it goes when the headers change", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const connect = api.customConnectors.connect;
    api.customConnectors.connect = async (orgId, input) => {
      const index = input.headers?.findIndex((h) => h.name.toLowerCase() === "host") ?? -1;
      if (index >= 0)
        throw new ApiError(400, "connector.header_reserved", "Host is set for every request", {
          header: "Host",
          index,
        });
      const empty = input.headers?.findIndex((h) => h.value.trim() === "") ?? -1;
      if (empty >= 0)
        throw new ApiError(400, "connector.header_value", "X-Tenant needs a value", {
          header: "X-Tenant",
          index: empty,
        });
      return connect(orgId, input);
    };
    await openForm(state, api);
    // The first row stays blank: the server's second header is the third row.
    await click(add());
    await header(2, "X-API-Key", "fake-value");
    await click(add());
    await header(3, "Host", "example.com");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    const said = "Host já é enviado em toda requisição e não dá para trocar. Remova este cabeçalho.";
    const rows = () => [...flow().querySelectorAll(".cflow__hrows > li")];
    expect(rows().map((row) => row.querySelector('[role="alert"]')?.textContent ?? null)).toEqual([null, null, said]);
    expect([nameField(3), valueField(3), nameField(2)].map((el) => el.getAttribute("aria-invalid"))).toEqual([
      "true",
      null,
      null,
    ]);
    expect(nameField(3).getAttribute("aria-describedby")).toBe(rows()[2]?.querySelector('[role="alert"]')?.id ?? "");
    // On the row alone: no toast says it again.
    expect(document.body.textContent?.split(said)).toHaveLength(2);
    expect(disclosure().hasAttribute("open")).toBe(true);
    snapshot();

    await header(3, "X-Tenant", "");
    expect(flow().querySelector('[role="alert"]')).toBeNull();
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(rows()[2]?.querySelector('[role="alert"]')?.textContent).toBe(
      "Digite um valor para X-Tenant: até 2.000 caracteres em uma linha, sem acentos nem emojis.",
    );
    expect([nameField(3), valueField(3)].map((el) => el.getAttribute("aria-invalid"))).toEqual([null, "true"]);
  });

  test("a server that asks for a sign-in, or says no: under the rows, with the way out", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const connect = api.customConnectors.connect;
    let refuse = false;
    api.customConnectors.connect = async (orgId, input): Promise<CustomConnectStart> =>
      refuse ? { status: "needs_key" } : connect(orgId, input);
    await openForm(state, api);
    await header(1, "X-API-Key", "fake-value");
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), "https://oauth.example.com/mcp");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    const said =
      "Este servidor pede login, e o login ainda não leva cabeçalhos. Remova os cabeçalhos para entrar, ou conecte com uma chave de API.";
    expect(disclosure().querySelector(':scope > .cflow__headers > [role="alert"]')?.textContent).toBe(said);
    expect(document.body.textContent?.split(said)).toHaveLength(2);

    refuse = true;
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), ADDRESS);
    // Folded away before it is sent: "confira os valores" brings them back in sight.
    await act(async () => {
      disclosure().open = false;
      fireEvent(disclosure(), new Event("toggle"));
    });
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(flow().textContent).toContain(
      "O servidor não aceitou esses cabeçalhos. Confira os valores, ou conecte com uma chave de API.",
    );
    expect(disclosure().hasAttribute("open")).toBe(true);
    expect(flow().textContent).not.toContain("não aceita OAuth");
    // The key's form opened, and without a key the headers still go alone.
    expect(within(flow()).getByRole("button", { name: "Conectar" })).toBeTruthy();
  });

  test("while it connects, every field and button of the headers is off", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    api.customConnectors.connect = () => new Promise(() => {});
    await openForm(state, api);
    await header(1, "X-API-Key", "fake-value");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(2);
    const controls = [
      nameField(1),
      valueField(1),
      add(),
      within(flow()).getByRole("button", { name: "Remover cabeçalho 1" }),
    ];
    expect(controls.map((el) => el.closest("fieldset[disabled]") !== null)).toEqual([true, true, true, true]);
  });

  test("a catalog connector has none", async () => {
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api: createFakeApi(seedState({ connections: [] })) });
    await settle(8);
    await pick(await openStore(), "Linear");
    expect(flow().textContent).toContain("Conectar Linear");
    expect(flow().textContent).not.toContain("Cabeçalhos da requisição");
  });
});

describe("Reconectar and the server's page", () => {
  test("its page names what is sent, with Reconnect as the way to change it; nothing for a server with none", async () => {
    const { api } = await openReconnect();
    await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.example.com/mcp",
      label: "Outro",
      returnTo: "/",
    });
    cleanup();
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    // On the Account line of the server's page, by name; never a value.
    expect((await openConnection("Suporte")).textContent).toContain(
      "Envia também: X-API-Key e X-Tenant. Para mudar, use Reconectar.",
    );
    expect(document.body.textContent).not.toContain("fake-value");
    await backToList();
    expect((await openConnection("Outro")).textContent).not.toContain("Envia também");
  });

  test("the saved names stay unless new ones are typed: untouched, nothing about headers is sent", async () => {
    const { state, reconnect } = await openReconnect();
    await reconnect();
    expect(screen().getByRole("dialog", { name: "Reconectar Suporte" })).toBe(flow());
    expect(disclosure().hasAttribute("open")).toBe(true);
    expect(disclosure().textContent).toContain(
      "Salvos: X-API-Key e X-Tenant. Continuam, a menos que você digite novos.",
    );
    expect(within(flow()).queryByLabelText("Nome do cabeçalho 1")).toBeNull();
    snapshot();
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(connectCalls(state)).toEqual([expect.objectContaining({ serverUrl: ADDRESS, apiKey: undefined })]);
    expect(connectCalls(state)[0]?.headers).toBeUndefined();
    expect(document.body.textContent).toContain("Suporte reconectado.");
  });

  test("Remover sends none any more, Desfazer keeps them; a typed row replaces them all", async () => {
    const { state, reconnect } = await openReconnect(["X-API-Key"]);
    await reconnect();
    expect(disclosure().textContent).toContain("Salvo: X-API-Key. Continua, a menos que você digite novos.");
    await click(within(disclosure()).getByRole("button", { name: "Remover" }));
    expect(disclosure().textContent).toContain("X-API-Key sai ao reconectar.");
    await click(within(disclosure()).getByRole("button", { name: "Desfazer" }));
    expect(disclosure().textContent).toContain("Salvo: X-API-Key.");
    await click(within(disclosure()).getByRole("button", { name: "Remover" }));
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(connectCalls(state).at(-1)).toMatchObject({ headers: [] });
    // With nothing left to send, this server asks for a key.
    expect(flow().textContent).toContain("Este servidor não aceita OAuth. Conecte com uma chave de API.");

    await click(add());
    await header(1, "X-Token", "fake-value");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(connectCalls(state).at(-1)).toMatchObject({ headers: [{ name: "X-Token", value: "[redacted]" }] });
    // The server's page, open behind the flow, names the new one.
    expect(document.querySelector(".store-page")?.textContent).toContain(
      "Envia também: X-Token. Para mudar, use Reconectar.",
    );
  });

  test("a typed row replaces the saved names: their line says they go, with no link that would keep them", async () => {
    const { state, reconnect } = await openReconnect();
    await reconnect();
    // A row added and left blank is no header: they still stay.
    await click(add());
    expect(disclosure().textContent).toContain("Continuam, a menos que você digite novos.");
    await header(1, "X-Trace", "fake-value");
    expect(disclosure().textContent).toContain("X-API-Key e X-Tenant saem ao reconectar.");
    expect(disclosure().textContent).not.toContain("Continuam");
    for (const name of ["Remover", "Desfazer"]) {
      expect(within(disclosure()).queryByRole("button", { name })).toBeNull();
    }
    snapshot();
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(connectCalls(state).at(-1)).toMatchObject({ headers: [{ name: "X-Trace", value: "[redacted]" }] });
  });

  test("a refusal of a saved header shows under the saved names", async () => {
    const { api, reconnect } = await openReconnect(["Authorization"]);
    api.customConnectors.connect = async () => {
      throw new ApiError(400, "connector.header_and_key", "The key is sent as Authorization", {
        header: "Authorization",
        index: 0,
      });
    };
    await reconnect();
    await click(within(flow()).getByText("Conectar com uma chave de API"));
    await type(within(flow()).getByLabelText("Chave de API"), "test-key-1");
    await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }));
    await settle(4);
    expect(disclosure().querySelector('[role="alert"]')?.textContent).toBe(
      "A chave de API já é enviada como Authorization. Apague a chave ou remova este cabeçalho.",
    );
    // It was read: its line still says it stays. Only saved headers that can't be read stop being said to stay.
    expect(disclosure().textContent).toContain("Salvo: Authorization. Continua, a menos que você digite novos.");
    expect(within(disclosure()).getByRole("button", { name: "Remover" })).toBeTruthy();
  });

  test("removing the headers of an account that has no key, the key's form open and empty: no key is asked for", async () => {
    const { state, reconnect } = await openReconnect(["X-API-Key"]);
    await reconnect();
    await click(within(flow()).getByText("Conectar com uma chave de API"));
    expect(within(flow()).getByLabelText("Chave de API")).toBeTruthy();
    await click(within(disclosure()).getByRole("button", { name: "Remover" }));
    // The key's own button would only answer that a key is missing.
    expect(within(flow()).queryByRole("button", { name: "Conectar com a chave" }) === null).toBe(true);
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(connectCalls(state)).toEqual([expect.objectContaining({ apiKey: undefined, headers: [] })]);
    expect(flow().textContent).not.toContain("Cole a chave de API");
  });

  test("a refusal about saved headers this form never listed still shows, under the rows", async () => {
    // The list the form opened on is older than the account's headers: it knows an account with a key and none.
    const state = seedState();
    const api = createFakeApi(state);
    await api.customConnectors.connect(ORG_ID, {
      serverUrl: ADDRESS,
      label: "Suporte",
      apiKey: "test-key-1",
      returnTo: "/",
    });
    api.customConnectors.connect = async () => {
      throw new ApiError(400, "connector.headers_unreadable", "The saved headers couldn't be read");
    };
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    await reconnectFromPage("Suporte");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(disclosure().hasAttribute("open")).toBe(true);
    expect(disclosure().querySelector('[role="alert"]')?.textContent).toBe(
      "Não deu para ler os cabeçalhos salvos. Digite de novo, ou remova.",
    );
  });

  test("saved headers that can't be read any more: the refusal takes their line, with Remover at its end, and nothing goes unless chosen", async () => {
    const { api, reconnect } = await openReconnect();
    const connect = api.customConnectors.connect;
    // What each request said about headers, the refused ones too.
    const asked: unknown[] = [];
    // As the server does: only a request that would keep the saved ones has to read them.
    api.customConnectors.connect = async (orgId, input) => {
      asked.push(input.headers);
      if (!input.headers) throw new ApiError(400, "connector.headers_unreadable", "The saved headers couldn't be read");
      return connect(orgId, input);
    };
    const conectar = async () => {
      await click(within(flow()).getByRole("button", { name: "Conectar" }));
      await settle(4);
    };
    await reconnect();
    // Folded away before it is sent: the refusal brings them back in sight.
    await act(async () => {
      disclosure().open = false;
      fireEvent(disclosure(), new Event("toggle"));
    });
    const shown = await scrolledBy(conectar);
    const said = "Não deu para ler os cabeçalhos salvos. Digite de novo, ou remova.";
    const alert = () => disclosure().querySelector('.cflow__headers > p > [role="alert"]');
    const link = (name: string) => within(disclosure()).queryByRole("button", { name });
    expect(disclosure().hasAttribute("open")).toBe(true);
    expect(alert()?.textContent).toBe(said);
    // With many rows it would land below what the dialog shows.
    expect(shown.includes(alert() as Element)).toBe(true);
    // Once, in the headers: no toast and no second line says it again.
    expect(document.body.textContent?.split(said)).toHaveLength(2);
    // Nothing says they stay or that they go, and "ou remova" has its control right after it, in its own line.
    expect(disclosure().textContent).not.toMatch(/Salvos?:|Continuam?,|ao reconectar/);
    expect(alert()?.nextElementSibling).toBe(link("Remover"));
    expect(link("Remover")?.className).toContain("ac-link");
    expect(link("Desfazer")).toBeNull();
    expect(add().disabled).toBe(false);
    snapshot();

    // A plain second Conectar is refused again: nothing was removed for the person.
    await conectar();
    expect(asked).toEqual([undefined, undefined]);
    expect(alert()?.textContent).toBe(said);

    // No change brings "Continuam" back. A typed row replaces them, as ever, and without it the refusal is back.
    await click(add());
    expect(alert()?.textContent).toBe(said);
    await header(1, "X-Trace", "fake-value");
    expect(alert()).toBeNull();
    expect(disclosure().textContent).toContain("X-API-Key e X-Tenant saem ao reconectar.");
    expect([link("Remover"), link("Desfazer")]).toEqual([null, null]);
    await click(within(flow()).getByRole("button", { name: "Remover cabeçalho 1" }));
    expect(alert()?.textContent).toBe(said);
    expect(disclosure().textContent).not.toMatch(/Continuam?,/);

    // Remover: they go at Reconectar, and the way back leads to the refusal, never to "Continuam".
    await click(link("Remover") as Element);
    expect(alert()).toBeNull();
    expect(disclosure().textContent).toContain("X-API-Key e X-Tenant saem ao reconectar.");
    snapshot();
    await click(link("Desfazer") as Element);
    expect(alert()?.textContent).toBe(said);
    expect(disclosure().textContent).not.toMatch(/Continuam?,/);
    await click(link("Remover") as Element);
    await conectar();
    expect(asked.at(-1)).toEqual([]);

    // Typed again, they replace the ones that can't be read.
    await click(add());
    await header(1, "X-API-Key", "fake-value");
    await conectar();
    expect(asked.at(-1)).toEqual([{ name: "X-API-Key", value: "fake-value" }]);
    expect(document.body.textContent).toContain("Suporte reconectado.");
  });
});

/**
 * What breaks the form and the row (break-ui): ten headers, each name as long as one may be (64 characters, one
 * unbroken word), a refusal that names one, and the same in English. CI's geometry check lays these out at 1280, 390
 * and 320.
 */
describe("worst cases", () => {
  const LONG = Array.from({ length: MAX_REQUEST_HEADERS }, (_, i) =>
    `X-${String(i).padStart(2, "0")}-${"GatewayTenantRoutingKey".repeat(3)}`.slice(0, 64),
  );

  test("ten rows, the longest names, a refusal that names one", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    api.customConnectors.connect = async (_orgId, input) => {
      throw new ApiError(400, "connector.header_twice", "It is there twice", {
        header: input.headers?.at(-1)?.name ?? "",
        index: (input.headers?.length ?? 1) - 1,
      });
    };
    const { app } = await openForm(state, api);
    for (const [i, name] of LONG.entries()) {
      if (i > 0) await click(add());
      await header(i + 1, name, "v".repeat(2000));
    }
    await click(within(flow()).getByText("Conectar com uma chave de API"));
    const shown = await scrolledBy(async () => {
      await click(within(flow()).getByRole("button", { name: "Conectar" }));
      await settle(4);
    });
    expect(flow().querySelectorAll(".cflow__hrows > li")).toHaveLength(MAX_REQUEST_HEADERS);
    const alert = flow().querySelector('.cflow__hrows > li:last-child [role="alert"]');
    expect(alert?.textContent).toBe(`${LONG.at(-1)} está na lista duas vezes. Remova um deles.`);
    // Under ten rows it is below what the dialog shows: the refused row's own words are brought into sight.
    expect(shown.includes(alert as Element)).toBe(true);
    snapshot();
    await showIn(app.services, "en");
    expect(flow().textContent).toContain("A server takes at most 10 headers. Remove one to add another.");
    expect(flow().querySelector('.cflow__hrows [role="alert"]')?.textContent).toBe(
      `${LONG.at(-1)} is in the list twice. Remove one of them.`,
    );
  });

  test("Reconectar with ten long names that can't be read any more", async () => {
    const { app, api, reconnect } = await openReconnect(LONG);
    api.customConnectors.connect = async () => {
      throw new ApiError(400, "connector.headers_unreadable", "The saved headers couldn't be read");
    };
    await reconnect();
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    const alert = () => disclosure().querySelector('.cflow__headers > p > [role="alert"]');
    expect(alert()?.textContent).toBe("Não deu para ler os cabeçalhos salvos. Digite de novo, ou remova.");
    snapshot();
    await showIn(app.services, "en");
    expect(alert()?.textContent).toBe("The saved headers couldn't be read. Type them again, or remove them.");
    expect(alert()?.nextElementSibling?.textContent).toBe("Remove");
  });

  test("Reconectar and the page of a server with ten long names, removed and not", async () => {
    const { app, reconnect } = await openReconnect(LONG);
    await openConnection("Suporte");
    snapshot();
    await reconnect();
    expect(disclosure().textContent).toContain(LONG.at(-1) as string);
    snapshot();
    await click(within(disclosure()).getByRole("button", { name: "Remover" }));
    snapshot();
    await showIn(app.services, "en");
    expect(disclosure().textContent).toContain("will be removed when you reconnect.");
  });
});
