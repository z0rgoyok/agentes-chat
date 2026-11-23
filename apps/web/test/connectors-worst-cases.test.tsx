import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { defaultDatabasePolicy } from "@agenteschat/client/lib/databases";
import { cleanup } from "@testing-library/react";
import { openConnected } from "./catalog";
import { ADA_ID, createFakeApi, fakeDatabasesOf, fakeMailOf, ORG_ID, seedState } from "./fake-api";
import { MAIL_PROVIDERS } from "./fakes/mail";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/**
 * Settings → Conectores with what breaks its rows (break-ui): a sign-in that died, a server with a 70-character name
 * whose tools can't be read, a reviewed server with no tool at all, a mailbox with a long address that waits, a whole database server with a prefix, rows
 * nobody uses beside a row all 40 agents use. CI's geometry check lays out every screen these tests reach, closed and
 * open, at 1280 and 320.
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

const lines = () => [...document.querySelectorAll<HTMLElement>(".connected-row > button")];

describe("Conectores, worst case", () => {
  test("closed, every row is one line of the same parts, and what needs the person is a pill on it", async () => {
    await open();
    expect(lines().length).toBe(6);
    for (const line of lines()) {
      expect(line.getAttribute("aria-expanded")).toBe("false");
      expect([...line.children].map((c) => c.getAttribute("class"))).toEqual([
        "ac-mediarow__face",
        "ac-mediarow__head",
        "ac-mediarow__end ac-mediarow__end--wrap",
        "ac-icon ac-foldrow__chevron",
      ]);
      expect(line.querySelectorAll(".list-title > .ac-chip").length).toBeGreaterThan(0);
      expect(line.querySelector(".connected-row__who")?.textContent).toMatch(
        /^(\d+ de \d+ agentes|Nenhum agente ainda)$/,
      );
    }
    expect(lines().map((l) => l.querySelector(".list-title")?.textContent)).toEqual([
      "iCloudPrecisa reconectar",
      "iCloudConectando",
      "ClientesAtivoSó lê",
      "GitHubPrecisa reconectar",
      `${LONG_SERVER}Sem ferramentas agora`,
      "VazioAtivo",
    ]);
    expect(LONG_SERVER.length).toBeGreaterThanOrEqual(70);
    // Forty agents use the first: five faces, and the count says the rest.
    expect(lines()[0]?.querySelector(".connected-row__who")?.textContent).toBe("40 de 40 agentes");
    expect(lines()[0]?.querySelectorAll(".connected-row__who .ac-avatar").length).toBe(5);
    // Nothing of the inside is in reach: no action, no account.
    expect(screen().queryByRole("button", { name: /^(Quem usa|Reconectar|Desconectar) / })).toBeNull();
  });

  test("open, each row says its account whole and offers its actions in one row", async () => {
    await open();
    await openConnected();
    const rows = [...document.querySelectorAll<HTMLElement>(".connected-row")];
    expect(rows.map((r) => r.matches(".ac-foldrow--open"))).toEqual([true, true, true, true, true, true]);
    expect(rows[5]?.querySelector(".connected-row__text")?.textContent).toContain("0 ferramentas");
    expect(rows[0]?.querySelector(".connected-row__text")?.textContent).toContain(`Conectado como ${LONG_ADDRESS}`);
    expect(rows[2]?.querySelector(".connected-row__text")?.textContent).toContain(
      "leitura_relatorios_financeiros@db-replica-01.interno.example.com",
    );
    for (const row of rows) expect(row.querySelectorAll(".ac-foldrow__more > .ac-acts").length).toBe(1);
    // The fix is the one plated button, first; the rest are bare words.
    expect([...(rows[0]?.querySelectorAll(".ac-acts > button") ?? [])].map((b) => b.textContent)).toEqual([
      "Reconectar",
      "Quem usa",
      "Ferramentas",
      "Endereços",
      "Desconectar",
    ]);
    expect([...(rows[0]?.querySelectorAll(".ac-acts > .ac-btn") ?? [])].map((b) => b.textContent)).toEqual([
      "Reconectar",
    ]);
    expect(rows[0]?.querySelectorAll(".ac-acts > .ac-link--action").length).toBe(4);
  });
});
