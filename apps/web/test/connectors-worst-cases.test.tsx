import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { defaultDatabasePolicy } from "@agenteschat/client/lib/databases";
import { cleanup, within } from "@testing-library/react";
import { backToList, connectedNames, openConnection } from "./catalog";
import { ADA_ID, createFakeApi, fakeDatabasesOf, fakeMailOf, ORG_ID, seedState } from "./fake-api";
import { MAIL_PROVIDERS } from "./fakes/mail";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/**
 * Settings → Conectores with what breaks its rows (break-ui): a sign-in that died, a server with a 70-character name
 * whose tools can't be read, a reviewed server with no tool at all, a mailbox with a long address that waits, a whole database server with a prefix, rows
 * nobody uses beside a row all 40 agents use. CI's geometry check lays out every screen these tests reach (the list
 * and a connection's page) at 1280 and 320.
 */
const LONG_SERVER = "Suporte ao cliente das lojas da região sul, do sudeste e do centro-oeste";
const LONG_ADDRESS = "atendimento.financeiro.contas-a-receber@subsidiaria.example.com";

async function open() {
  const state = seedState();
  const ada = state.agents[0];
  if (!ada) throw new Error("no agent");
  for (let n = 3; n <= 40; n++) state.agents.push({ ...ada, id: `agent-${n}`, name: `Agente ${n}` });
  const everyone = state.agents.map((a) => ({ agentId: a.id, level: "read" as const, canDelete: false }));
  const github = state.connections[0];
  if (github) github.status = "needs_reconnect";
  const api = createFakeApi(state);
  const server = await api.customConnectors.connect(ORG_ID, {
    serverUrl: "https://oauth.suporte.example.com",
    label: LONG_SERVER,
    returnTo: "/",
  });
  if (server.status !== "connected") throw new Error("expected connected");
  const list = api.customConnectors.list;
  const empty = await api.customConnectors.connect(ORG_ID, {
    serverUrl: "https://oauth.vazio.example.com",
    label: "Vazio",
    returnTo: "/",
  });
  if (empty.status !== "connected") throw new Error("expected connected");
  api.customConnectors.list = async (orgId) =>
    (await list(orgId)).map((s) =>
      s.label === "Vazio"
        ? { ...s, tools: [], reviewedAt: s.createdAt }
        : { ...s, toolsError: "Streamable HTTP error: upstream timed out" },
    );
  const mail = fakeMailOf.get(api);
  const databases = fakeDatabasesOf.get(api);
  if (!mail || !databases) throw new Error("no fakes");
  mail.providers = structuredClone(MAIL_PROVIDERS);
  const mailbox = {
    provider: "imap" as const,
    via: "imap" as const,
    offActions: [],
    askActions: [],
    aliases: [],
    defaultFrom: null,
    lastError: null,
    preset: "icloud",
    createdAt: new Date(Date.now() - 600_000).toISOString(),
    // Mailboxes left with no person: the team's side holds them with the rest.
    ownerUserId: null,
  };
  mail.accounts = [
    {
      ...mailbox,
      id: "mail-1",
      address: LONG_ADDRESS,
      label: LONG_ADDRESS,
      status: "needs_reconnect",
      agents: everyone,
    },
    { ...mailbox, id: "mail-2", address: "a@example.com", label: "a@example.com", status: "pending", agents: [] },
  ];
  const db = await databases.client.connect(ORG_ID, {
    label: "Clientes",
    url: "postgres://leitura_relatorios_financeiros:pw@db-replica-01.interno.example.com",
    wholeServer: true,
    databasePrefix: "cliente_producao_",
  });
  await databases.client.setAgent(ORG_ID, ADA_ID, db.id, { level: "read", policy: defaultDatabasePolicy() });
  await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
  await settle(8);
}

const lines = () => [...document.querySelectorAll<HTMLElement>(".store-list > .store-item--link")];

describe("Conectores, worst case", () => {
  test("every connection is one line of the same parts; only what needs the person says so, with its fix", async () => {
    await open();
    expect(lines().length).toBe(6);
    for (const line of lines()) {
      // The line's open button, then the fix or who uses it, then the chevron to its page.
      const [first, middle, last] = [...line.children];
      expect(first?.matches("button.store-item__open")).toBe(true);
      expect(middle?.matches(".ac-btn, .store-who")).toBe(true);
      expect(last?.matches(".ac-icon.store-item__chev")).toBe(true);
      expect(line.children.length).toBe(3);
    }
    // What needs the person comes first, each in its own words; what works says nothing about it.
    expect(connectedNames()).toEqual(["iCloud", "iCloud", "GitHub", LONG_SERVER, "Clientes", "Vazio"]);
    expect(lines().map((l) => l.querySelector(".store-item__text .store-state")?.textContent ?? null)).toEqual([
      "Precisa reconectar",
      "Conectando",
      "Precisa reconectar",
      "Sem ferramentas agora",
      null,
      null,
    ]);
    expect(LONG_SERVER.length).toBeGreaterThanOrEqual(70);
    // A dead sign-in has its fix on the line; a state nobody can fix from here has who uses it instead.
    expect(lines().map((l) => l.querySelector(":scope > .ac-btn")?.textContent ?? null)).toEqual([
      "Reconectar",
      null,
      "Reconectar",
      null,
      null,
      null,
    ]);
    for (const line of lines().filter((l) => l.querySelector(":scope > .store-who")))
      expect(line.querySelector(".store-who")?.textContent).toMatch(/^(\d+ agentes?|Nenhum agente ainda)$/);
    // Nothing of a page is on the list: no who uses it, no disconnect.
    expect(screen().queryByRole("button", { name: /^(Quem usa|Desconectar) / })).toBeNull();
  });

  test("a connection's page says its account whole and offers each change on its own line", async () => {
    await open();
    // Forty agents use the first mailbox: three faces, and the line says they all do.
    let page = await openConnection("iCloud");
    expect(page.querySelector(".store-page__title p")?.textContent).toContain("Precisa reconectar");
    const lineTexts = () =>
      [...page.querySelectorAll(".store-list--lines > .store-item")].map((l) => l.querySelector("b")?.textContent);
    expect(lineTexts()).toEqual(["Quem usa", "Ferramentas", "Endereços", "Conta"]);
    const who = page.querySelector(".store-list--lines > .store-item") as HTMLElement;
    expect(who.querySelector("small")?.textContent).toBe("Todos os 40 agentes usam.");
    expect(who.querySelectorAll(".ac-avatar").length).toBe(3);
    expect(page.textContent).toContain(`Conectado como ${LONG_ADDRESS}`);
    // The head says what's wrong; the fix is the Account line's own button (no second one in the head); Disconnect
    // ends the page.
    expect(page.querySelectorAll(".store-page__head > .ac-btn")).toHaveLength(0);
    expect([...page.querySelectorAll(".store-list--lines .ac-btn")].map((b) => b.textContent)).toEqual([
      "Alterar",
      "Ver",
      "Alterar",
      "Reconectar",
    ]);
    expect(within(page).getByRole("button", { name: `Desconectar ${LONG_ADDRESS}` })).toBeTruthy();

    await backToList();
    page = await openConnection("Clientes");
    expect(page.textContent).toContain("leitura_relatorios_financeiros@db-replica-01.interno.example.com");

    await backToList();
    page = await openConnection("Vazio");
    expect(page.textContent).toContain("0 ferramentas");

    await backToList();
    page = await openConnection(LONG_SERVER);
    expect(page.querySelector(".store-page__title h3")?.textContent).toBe(LONG_SERVER);
    expect(page.querySelector(".store-page__title p")?.textContent).toContain("Sem ferramentas agora");
  });
});
