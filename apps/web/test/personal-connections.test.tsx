import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { CustomServer, Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { connectionLine, openStore, pick, rowMenu, searchStore } from "./catalog";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, fakeMailOf, NOW, ORG_ID, seedState } from "./fake-api";
import { MAIL_PROVIDERS } from "./fakes/mail";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

type State = ReturnType<typeof seedState>;
type Api = ReturnType<typeof createFakeApi>;

const click = async (el: Element, rounds = 4) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
/** Settings › Connectors: the split, the band, what is connected and the way in by address. */
const section = () => document.querySelector(".store") as HTMLElement;
/** "Connected": one line per connection of the side shown. */
const connectedList = () => screen().queryByRole("region", { name: "Conectados" });
/** "Team | Personal": over the band and the list. */
const ownerTabs = () => screen().getByRole("radiogroup", { name: "Conectores" });
/** "Connect by address", under the list: any MCP server, in the connect dialog. */
const byAddress = () => within(section()).getByRole("button", { name: "Conectar pelo endereço" });
const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
const asMember = (state: State) => {
  const org = state.me?.organizations[0];
  if (org) org.role = "member";
};

/** A server by address connected by `owner` as their own, as the backend keeps it (the fake reads who asks). */
async function personalServer(state: State, api: Api, owner: string, serverUrl: string, label: string) {
  const me = state.me?.user;
  if (!me) throw new Error("no me");
  const was = me.id;
  me.id = owner;
  try {
    const r = await api.customConnectors.connect(ORG_ID, {
      serverUrl,
      label,
      apiKey: "fake-key-0000",
      returnTo: "/",
      personal: true,
    });
    if (r.status !== "connected") throw new Error("not connected");
    return r.server as CustomServer;
  } finally {
    me.id = was;
  }
}
const teamServer = async (api: Api, serverUrl: string, label: string) => {
  const r = await api.customConnectors.connect(ORG_ID, { serverUrl, label, apiKey: "fake-key-0000", returnTo: "/" });
  if (r.status !== "connected") throw new Error("not connected");
  return r.server as CustomServer;
};

const openConnectors = async (api: Api) => {
  await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
  await settle(8);
};

describe("Conectores: Equipe | Pessoal", () => {
  test("a member opens on Pessoal and adds a server as their own: Para quem locked to Pessoal, and how it ends", async () => {
    const state = seedState({ connections: [] });
    asMember(state);
    const api = createFakeApi(state);
    await openConnectors(api);
    const tabs = ownerTabs();
    expect(
      within(tabs)
        .getByRole("radio", { name: /Pessoal/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(section().textContent).toContain("Conecte suas próprias contas");
    // Every member adds on Personal; the team's side has no way in for them.
    expect(within(section()).getAllByRole("button", { name: "Ver conectores" }).length).toBeGreaterThan(0);
    await click(byAddress());
    const dialog = flow();
    const forWhom = within(dialog).getByRole("radiogroup", { name: "Para quem" });
    expect(within(forWhom).getByRole("radio", { name: "Pessoal" }).getAttribute("aria-checked")).toBe("true");
    expect(within(forWhom).getByRole("radio", { name: "Equipe" }).hasAttribute("disabled")).toBe(true);
    // The chosen one still reads as chosen: only Equipe fades.
    expect(within(forWhom).getByRole("radio", { name: "Pessoal" }).hasAttribute("disabled")).toBe(false);
    expect(forWhom.hasAttribute("aria-disabled")).toBe(false);
    expect(dialog.textContent).toContain("Só quem gerencia conectores adiciona os da equipe.");
    expect(dialog.textContent).toContain("Seus agentes só usam quando você pede.");
    await type(within(dialog).getByLabelText("Endereço do servidor MCP"), "https://mcp.example.com/mcp");
    await click(within(dialog).getByText("Conectar com uma chave de API"));
    await type(within(dialog).getByLabelText("Chave de API"), "fake-key-1234");
    await click(within(dialog).getByRole("button", { name: "Conectar com a chave" }), 6);
    expect(state.calls.find((c) => c.method === "customConnectors.connect")?.args[1]).toMatchObject({
      serverUrl: "https://mcp.example.com/mcp",
      personal: true,
    });
    expect(flow().textContent).toContain("Seus agentes só usam quando você pede.");
    // A server not reviewed yet: Continuar saves the levels suggested for its tools.
    await click(within(flow()).getByRole("button", { name: "Continuar" }), 6);
    expect(within(tabs).getByRole("radio", { name: /Pessoal/ }).textContent).toContain("1");
    expect(within(connectedList() as HTMLElement).getByRole("button", { name: /mcp\.example\.com/ })).toBeTruthy();
    await click(within(tabs).getByRole("radio", { name: /Equipe/ }));
    expect(within(section()).queryByRole("button", { name: "Ver conectores" })).toBeNull();
    expect(within(section()).queryByRole("button", { name: "Conectar pelo endereço" })).toBeNull();
  });

  test("who manages connectors opens on Equipe, connects for the team as before, and may choose Pessoal", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    await openConnectors(api);
    expect(
      within(ownerTabs())
        .getByRole("radio", { name: /Equipe/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await click(byAddress());
    const forWhom = within(flow()).getByRole("radiogroup", { name: "Para quem" });
    expect(within(forWhom).getByRole("radio", { name: "Equipe" }).getAttribute("aria-checked")).toBe("true");
    expect(flow().textContent).toContain("Ao conectar, todos os agentes podem usar.");
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), "https://mcp.example.com/mcp");
    await click(within(flow()).getByText("Conectar com uma chave de API"));
    await type(within(flow()).getByLabelText("Chave de API"), "fake-key-1234");
    await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }), 6);
    const sent = state.calls.find((c) => c.method === "customConnectors.connect")?.args[1] as Record<string, unknown>;
    // The team's: nothing more is sent than before.
    expect("personal" in sent).toBe(false);
  });

  test("others' personal connections: a quiet group for who manages connectors, with only Tirar de um agente and Remover", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    await teamServer(api, "https://team.example.com/mcp", "Equipe MCP");
    const theirs = await personalServer(state, api, "u-joao", "https://crm.example.com/mcp", "CRM do João");
    await openConnectors(api);
    const others = within(section()).getByRole("region", { name: /Pessoais de outras pessoas/ });
    expect(others.textContent).toContain("CRM do João");
    expect(others.textContent).toContain("Pessoal de João");
    // No address, tools or settings of theirs.
    expect(others.textContent).not.toContain("crm.example.com");
    expect(within(others).queryByRole("button", { name: /Ferramentas/ })).toBeNull();
    expect(within(others).queryByRole("button", { name: /Quem usa/ })).toBeNull();
    expect(within(others).queryByRole("button", { name: /Mais ações/ })).toBeNull();
    // Nor in the team's list, nor on Personal.
    expect(connectionLine("Equipe MCP")).toBeTruthy();
    expect(within(connectedList() as HTMLElement).queryByRole("button", { name: /CRM do João/ })).toBeNull();

    await click(within(others).getByRole("button", { name: /CRM do João/ }));
    await click(within(others).getByRole("button", { name: "Tirar de um agente" }));
    const takeOff = screen().getByRole("dialog", { name: "Tirar CRM do João de um agente" });
    await click(within(takeOff).getByRole("button", { name: "Tirar CRM do João de Ada" }), 6);
    expect(state.calls.find((c) => c.method === "connectors.takeOffAgent")?.args).toEqual([ORG_ID, theirs.id, ADA_ID]);
    if (screen().queryByRole("dialog", { name: "Tirar CRM do João de um agente" }))
      await click(
        within(screen().getByRole("dialog", { name: "Tirar CRM do João de um agente" })).getAllByRole("button", {
          name: "Fechar",
        })[0] as HTMLElement,
      );

    await click(within(others).getByRole("button", { name: "Remover CRM do João" }));
    const remove = screen().getByRole("dialog", { name: "Remover CRM do João?" });
    await click(within(remove).getByRole("button", { name: "Remover" }), 6);
    expect(state.calls.find((c) => c.method === "customConnectors.disconnect")?.args).toEqual([ORG_ID, theirs.id]);
  });

  test("a member never sees someone else's personal connection, and gets no others' rows from the server", async () => {
    const state = seedState({ connections: [] });
    asMember(state);
    const api = createFakeApi(state);
    await personalServer(state, api, "u-joao", "https://crm.example.com/mcp", "CRM do João");
    await openConnectors(api);
    expect(screen().queryByRole("region", { name: /Pessoais de outras pessoas/ })).toBeNull();
    expect(document.body.textContent).not.toContain("CRM do João");
  });

  test("the person's own connection moves to the team when they manage connectors", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    state.connections.push({
      id: "conn-sentry-mine",
      connector: "sentry",
      label: "Sentry",
      serverUrl: "https://mcp.sentry.dev/mcp",
      authType: "api_key",
      accountLabel: null,
      tokenExpiresAt: null,
      createdAt: NOW.toISOString(),
      revokedAt: null,
      ownerUserId: "u-walter",
    });
    await openConnectors(api);
    await click(within(ownerTabs()).getByRole("radio", { name: /Pessoal/ }));
    expect(document.body.textContent).toContain("Só você abre estas conexões.");
    // Its page's ⋯ holds Move to team.
    await click(within(await rowMenu("Sentry")).getByRole("menuitem", { name: "Passar para a equipe" }));
    await click(
      within(screen().getByRole("dialog", { name: "Passar Sentry para a equipe?" })).getByRole("button", {
        name: "Passar para a equipe",
      }),
      6,
    );
    expect(state.calls.find((c) => c.method === "connectors.moveToTeam")?.args).toEqual([ORG_ID, "conn-sentry-mine"]);
  });

  test("a mailbox is always its person's: Para quem shows Pessoal, locked, with why", async () => {
    const state = seedState({ connections: [] });
    asMember(state);
    const api = createFakeApi(state);
    const mail = fakeMailOf.get(api);
    if (!mail) throw new Error("no mail fake");
    mail.providers = structuredClone(MAIL_PROVIDERS);
    await openConnectors(api);
    const store = await openStore();
    // GitHub connects for the team only: the store doesn't offer it to who adds their own.
    await searchStore(store, "GitHub");
    expect(within(store).queryByRole("button", { name: "Conectar GitHub" })).toBeNull();
    await pick(store, "iCloud");
    const forWhom = within(flow()).getByRole("radiogroup", { name: "Para quem" });
    expect(within(forWhom).getByRole("radio", { name: "Pessoal" }).getAttribute("aria-checked")).toBe("true");
    expect(flow().textContent).toContain("Uma caixa de email é sempre de quem a conecta.");
  });
});

describe("Conectores: the split covers the band and the list", () => {
  test("Pessoal with only a server by address: its note shows, no empty state says there is nothing", async () => {
    const state = seedState({ connections: [] });
    asMember(state);
    const api = createFakeApi(state);
    await personalServer(state, api, "u-walter", "https://notes.example.com/mcp", "Minhas notas");
    await openConnectors(api);
    expect(within(ownerTabs()).getByRole("radio", { name: /Pessoal/ }).textContent).toContain("1");
    expect(document.body.textContent).toContain("Só você abre estas conexões.");
    expect(section().textContent).not.toContain("Conecte suas próprias contas");
    // The tabs sit over the list they split.
    expect(
      ownerTabs().compareDocumentPosition(connectedList() as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("others' personal connections stay a short group: five rows, the rest behind Ver todas", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    for (let i = 1; i <= 7; i++)
      await personalServer(state, api, "u-joao", `https://crm${i}.example.com/mcp`, `CRM ${i} do João`);
    await openConnectors(api);
    const others = screen().getByRole("region", { name: /Pessoais de outras pessoas/ });
    expect(others.textContent).toContain("Pessoais de outras pessoas · 7");
    expect(within(others).getAllByRole("button", { name: /^CRM \d do João/ })).toHaveLength(5);
    await click(within(others).getByRole("button", { name: "Ver todas as 7" }));
    expect(within(others).getAllByRole("button", { name: /^CRM \d do João/ })).toHaveLength(7);
    // And folds back the way it opened.
    await click(within(others).getByRole("button", { name: "Mostrar menos" }));
    expect(within(others).getAllByRole("button", { name: /^CRM \d do João/ })).toHaveLength(5);
  });

  test("Pessoal: one's mailboxes are a group of their own with their own rule; the note is over the connections", async () => {
    const state = seedState({ connections: [] });
    asMember(state);
    const api = createFakeApi(state);
    const mail = fakeMailOf.get(api);
    if (!mail) throw new Error("no mail fake");
    mail.accounts = [
      {
        id: "mail-1",
        provider: "imap",
        via: "imap",
        address: "walter@example.com",
        offActions: [],
        askActions: [],
        aliases: [],
        defaultFrom: null,
        label: "Trabalho",
        status: "active",
        lastError: null,
        preset: "icloud",
        createdAt: NOW.toISOString(),
        ownerUserId: state.me?.user.id ?? null,
        agents: [],
      },
    ];
    await openConnectors(api);
    const box = screen().getByRole("region", { name: "Suas caixas de email" });
    expect(box.textContent).toContain("Quando outra pessoa pede algo que precisa de aprovação, quem aprova é você.");
    expect(box.textContent).toContain("walter@example.com");
    // Not in the connections' list: nothing but a mailbox, so there's none.
    expect(connectedList()).toBeNull();
    // Nothing but a mailbox: the connections' note has nothing under it, so it isn't there.
    expect(document.body.textContent).not.toContain("Só você abre estas conexões.");
    cleanup();
    await personalServer(state, api, state.me?.user.id ?? "", "https://notes.example.com/mcp", "Minhas notas");
    await openConnectors(api);
    expect(document.body.textContent).toContain("Só você abre estas conexões.");
    const note = document.querySelector(".connected-note");
    const mailCard = screen().getByRole("region", { name: "Suas caixas de email" });
    // The note comes after the mailboxes, right over the connections.
    expect(note && mailCard.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("an agent's page: the team's connections, then the viewer's own, and others' only to turn off", () => {
  test("own personal one with its badge and ⓘ; another person's with Desligar alone", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    await teamServer(api, "https://team.example.com/mcp", "Equipe MCP");
    const mine = await personalServer(state, api, "u-walter", "https://notes.example.com/mcp", "Minhas notas");
    (api.access as unknown as { connected: (id: string, agents: string[]) => void }).connected(mine.id, [ADA_ID]);
    const theirs = await personalServer(state, api, "u-joao", "https://crm.example.com/mcp", "CRM do João");
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api });
    await settle(8);
    const list = screen().getByRole("list", { name: "Conectores" });
    const names = [...list.querySelectorAll(".level-row__name")].map((el) => el.textContent ?? "");
    const at = (n: string) => names.findIndex((x) => x.includes(n));
    expect(at("Equipe MCP")).toBeLessThan(at("Minhas notas"));
    expect(at("Minhas notas")).toBeLessThan(at("CRM do João"));
    const own = list.querySelectorAll(".level-row")[at("Minhas notas")] as HTMLElement;
    expect(own.textContent).toContain("Pessoal");
    expect(within(own).getByRole("button", { name: "Sobre Minhas notas" })).toBeTruthy();
    expect(own.textContent).toContain("Só funciona quando você pede.");
    const other = list.querySelectorAll(".level-row")[at("CRM do João")] as HTMLElement;
    expect(other.textContent).toContain("Pessoal de João");
    expect(within(other).queryByRole("radiogroup")).toBeNull();
    await click(within(other).getByRole("button", { name: "Desligar CRM do João neste agente" }), 6);
    expect(state.calls.find((c) => c.method === "connectors.takeOffAgent")?.args).toEqual([ORG_ID, theirs.id, ADA_ID]);
    expect(screen().getByRole("list", { name: "Conectores" }).textContent).not.toContain("CRM do João");
  });

  test("another person's connection shows with no team connection at all, follows the search and counts as on", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    await personalServer(state, api, "u-joao", "https://crm.example.com/mcp", "CRM do João");
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api });
    await settle(8);
    const list = screen().getByRole("list", { name: "Conectores" });
    expect(list.textContent).toContain("CRM do João");
    // It is on (the agent holds it): "Com acesso" keeps it.
    await click(
      within(screen().getByRole("radiogroup", { name: /Filtrar|Mostrar/ })).getByRole("radio", { name: /Com acesso/ }),
    );
    expect(screen().getByRole("list", { name: "Conectores" }).textContent).toContain("CRM do João");
    await type(screen().getByRole("searchbox", { name: /Buscar/ }), "zzz");
    await settle(2);
    expect(screen().queryByRole("list", { name: "Conectores" })?.textContent ?? "").not.toContain("CRM do João");
  });

  test("a member who doesn't own the agent sees no one else's personal connection on it", async () => {
    const state = seedState({ connections: [] });
    asMember(state);
    const api = createFakeApi(state);
    await teamServer(api, "https://team.example.com/mcp", "Equipe MCP");
    await personalServer(state, api, "u-joao", "https://crm.example.com/mcp", "CRM do João");
    await renderApp(`/org/${ORG_ID}/agents/${ATLAS_ID}?tab=access`, { api });
    await settle(8);
    expect(document.body.textContent).not.toContain("CRM do João");
    expect(state.calls.some((c) => c.method === "connectors.takeOffAgent")).toBe(false);
  });
});

describe("an agent's card to connect an app", () => {
  test("a member connects it as their own; GitHub stays with who manages connectors", async () => {
    const state = seedState({ connections: [] });
    asMember(state);
    const offer = (id: string, params: Record<string, unknown>, minute: number): Message => ({
      id,
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ATLAS_ID },
      body: "server text",
      mentionedAgentIds: [],
      agentRunId: `r-${id}`,
      meta: { bodyCode: "action_connect_app", actionCard: { kind: "connect_app", forUserId: "u-walter", params } },
      createdAt: new Date(NOW.getTime() + minute * 60_000).toISOString(),
    });
    state.messages.push(
      offer("c-mcp", { url: "https://mcp.example.com/mcp", why: "Para ler o CRM." }, 0),
      offer("c-gh", { connector: "github", why: "Para ler o código." }, 1),
    );
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const rowOf = (title: string) =>
      screen()
        .getAllByRole("article")
        .find((a) => a.querySelector(".rq-open, .rq-done")?.textContent?.includes(title)) as HTMLElement;
    expect(within(rowOf("Conectar GitHub")).queryByRole("button", { name: "Conectar" })).toBeNull();
    expect(rowOf("Conectar GitHub").textContent).toContain("Um admin conecta");
    await click(within(rowOf("Conectar mcp.example.com")).getByRole("button", { name: "Conectar" }), 6);
    const forWhom = within(flow()).getByRole("radiogroup", { name: "Para quem" });
    expect(within(forWhom).getByRole("radio", { name: "Pessoal" }).getAttribute("aria-checked")).toBe("true");
  });
});
