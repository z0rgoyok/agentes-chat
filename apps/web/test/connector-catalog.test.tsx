import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type AccessInput, type ConnectorDef, keys } from "@agenteschat/client";
import { connectedSummary } from "@agenteschat/client/lib/connected";
import { icons } from "@agenteschat/ui";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { TFunction } from "i18next";
import { authKind, searchCatalog } from "@/components/ConnectorCatalog";
import { createI18n } from "@/i18n";
import { setNavigateAway } from "@/lib/navigate";
import {
  backToList,
  connectedNames,
  connectionLine,
  openConnection,
  openService,
  openStore,
  pick,
  rowMenu,
  searchStore,
  service,
} from "./catalog";
import { ADA_ID, ATLAS_ID, CATALOG, createFakeApi, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
/** Settings › Connectors, then "Browse connectors": the store page. */
const open = async (state = seedState({ connections: [] }), api = createFakeApi(state)) => {
  await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
  await settle(8);
  const store = await openStore();
  return { state, store };
};
/** The store page's root (the features, the tabs and the lines, or a service's page). */
const storeRoot = () => document.querySelector(".store") as HTMLElement;
/** The services' lines on the store page, by name (the features on top aren't lines). */
const names = (store: HTMLElement) =>
  [...store.querySelectorAll(".store-rows .store-item__text b")].map((el) => el.textContent);
/** A service's line on the store page. */
const line = (store: HTMLElement, name: string) =>
  [...store.querySelectorAll<HTMLElement>(".store-rows .store-item")].find(
    (li) => li.querySelector(".store-item__text b")?.textContent === name,
  ) as HTMLElement;
/** The store's category tabs. */
const tabs = (store: HTMLElement) => within(store).getByRole("navigation", { name: "Categorias" });
const tabNames = (store: HTMLElement) => [...tabs(store).querySelectorAll("button")].map((b) => b.textContent);
const tab = (store: HTMLElement, name: string) => within(tabs(store)).getByRole("button", { name });
/** "Connect by address" under the store or the list: it opens the connect dialog itself. */
const byAddress = async () => {
  await click(within(storeRoot()).getByRole("button", { name: "Conectar pelo endereço" }));
  await settle(2);
};
/** "Settings" over the store: back to Settings › Connectors. */
const toSettings = async () => {
  await click(within(storeRoot()).getByRole("link", { name: "Configurações" }));
  await settle(8);
};
const pressEsc = (el: Element) => act(async () => fireEvent.keyDown(el, { key: "Escape" }));
/** Whether an icon is drawn as `name` (its shape's first path). */
const drawnAs = (svg: Element | null | undefined, name: keyof typeof icons) =>
  svg?.querySelector("path")?.getAttribute("d") === icons[name].find(([tag]) => tag === "path")?.[1].d;
/** A level's radio in the radiogroup named `group`. */
const levelIn = (inside: HTMLElement, group: string, level: string) =>
  within(within(inside).getByRole("radiogroup", { name: group })).getByRole("radio", { name: level });
/** The level checked in each radiogroup named in `groups` (null when none is). */
const levels = (inside: HTMLElement, groups: string[]) =>
  groups.map(
    (group) =>
      within(within(inside).getByRole("radiogroup", { name: group }))
        .queryAllByRole("radio")
        .find((r) => r.getAttribute("aria-checked") === "true")?.textContent ?? null,
  );
/** A backend whose catalog also lists Asana as the server does today: its vendor hasn't approved agentes.chat yet. */
const withSoonAsana = (state: FakeState) => {
  const api = createFakeApi(state);
  const asana: ConnectorDef = {
    ...(CATALOG.connectors.find((d) => d.id === "linear") as ConnectorDef),
    id: "asana",
    label: "Asana",
    description: "Asana tasks, projects and teams.",
    serverUrl: "https://mcp.asana.com/mcp",
    iconUrl: "/connectors/asana.svg",
    brandColor: "#F06A6A",
    available: false,
    soon: true,
  };
  api.connectors.catalog = async () => ({ ...CATALOG, connectors: [asana, ...CATALOG.connectors] });
  return api;
};
/** As the server leaves a first connection: every agent's, whole. */
const everyAgent = (api: ReturnType<typeof createFakeApi>, connectionId: string) =>
  (api.access as typeof api.access & { connected: (id: string, agents: string[]) => void }).connected(connectionId, [
    ADA_ID,
    ATLAS_ID,
  ]);

describe("the connectors store: one page", () => {
  test("six suggestions as features; a line per service with no tags; tabs by category and search", async () => {
    const { store } = await open();
    // Suggested first (not connected yet, in a fixed order); they leave the lines below.
    expect([...store.querySelectorAll(".store-feats .store-open")].map((b) => b.textContent)).toEqual([
      "Sentry",
      "Notion",
      "Linear",
      "GitHub",
      "Canva",
      "Google Drive",
    ]);
    expect(names(store)).not.toContain("GitHub");
    // A feature's mark in its brand's color (Linear's), on the brand's art.
    const linear = [...store.querySelectorAll(".store-role")].find((r) => r.textContent?.includes("Linear"));
    expect(linear?.querySelector(".connector-icon__mark")?.getAttribute("style")?.toLowerCase()).toContain("#5e6ad2");
    expect(linear?.querySelector(".brand-art canvas")).not.toBeNull();
    // A search lists every service as a line, the featured ones too.
    await searchStore(store, "notion");
    const notion = line(store, "Notion");
    expect(notion.textContent).toContain("Páginas e bancos de dados.");
    // No tags on a line: no category, no "One click".
    expect(notion.querySelectorAll(".ac-chip")).toHaveLength(0);
    expect(notion.textContent).not.toContain("Um clique");
    // No Connect of its own: the whole line opens the service's dialog, an arrow at its end.
    expect(within(notion).queryByRole("button", { name: "Conectar Notion" })).toBeNull();
    expect(within(notion).getByRole("button", { name: "Notion" })).toBeTruthy();
    expect(notion.querySelector(".store-item__chev")).not.toBeNull();
    // The brand icon is a mask of our own file; Notion takes the ink.
    expect(notion.querySelector(".connector-icon__mark")?.getAttribute("style")).toContain("/connectors/notion.svg");
    // Canva's mark keeps its colors: drawn as it is, not as a mask. No icon (Slack here): a monogram.
    await searchStore(store, "canva");
    expect(line(store, "Canva").querySelector("img")?.getAttribute("src")).toBe("/brands/canva.svg");
    await searchStore(store, "slack");
    const slack = line(store, "Slack");
    expect(slack.querySelector(".connector-icon--mono")?.textContent).toBe("S");
    // Not configured on this server: "Coming soon" with a lock, and its dialog can't connect.
    expect([slack.hasAttribute("data-soon"), slack.querySelector(".store-state")?.textContent]).toEqual([
      true,
      "Em breve",
    ]);
    expect(within(slack).queryByRole("button", { name: "Conectar Slack" })).toBeNull();
    const page = await openService(store, "Slack");
    expect(within(page).getByRole("button", { name: "Em breve" }).hasAttribute("disabled")).toBe(true);
    expect(page.textContent).not.toMatch(/MCP/);
    await backToList();
    await searchStore(storeRoot(), "");

    // "Featured", then the categories by name.
    expect(tabNames(storeRoot())).toEqual([
      "Destaques",
      "Automação",
      "Desenvolvimento",
      "Docs",
      "Marketing",
      "Pagamentos",
      "Produto",
      "Suporte",
    ]);
    expect(tab(storeRoot(), "Destaques").getAttribute("aria-pressed")).toBe("true");
    await click(tab(storeRoot(), "Docs"));
    expect(tab(storeRoot(), "Docs").getAttribute("aria-pressed")).toBe("true");
    expect(names(storeRoot())).toEqual(["Google Drive", "Notion"]);
    await searchStore(storeRoot(), "notion");
    expect(names(storeRoot())).toEqual(["Notion"]);
  });

  test("social networks: a category of their own, each line in its brand's mark and color", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    const whatsapp: ConnectorDef = {
      ...(CATALOG.connectors.find((d) => d.id === "drive") as ConnectorDef),
      id: "whatsapp",
      label: "WhatsApp",
      category: "social",
      description: "WhatsApp Business messages and templates.",
      serverUrl: "https://backend.composio.dev/api/v3.1/toolkits/whatsapp",
      iconUrl: "/connectors/whatsapp.svg",
      brandColor: "#25D366",
    };
    api.connectors.catalog = async () => ({ ...CATALOG, connectors: [...CATALOG.connectors, whatsapp] });
    const { store } = await open(state, api);
    expect(tabNames(store).slice(-2)).toEqual(["Redes sociais", "Suporte"]);
    await click(tab(store, "Redes sociais"));
    expect(names(store)).toEqual(["WhatsApp"]);
    const whats = line(store, "WhatsApp");
    expect(whats.textContent).toContain("Mensagens e modelos do WhatsApp Business.");
    const mark = whats.querySelector(".connector-icon__mark")?.getAttribute("style")?.toLowerCase();
    expect([mark?.includes("/connectors/whatsapp.svg"), mark?.includes("#25d366")]).toEqual([true, true]);
  });

  test("under the features, the Data row shows Amplitude, Mixpanel and PostHog alone; See all opens the category", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    const base = CATALOG.connectors.find((d) => d.id === "linear") as ConnectorDef;
    const data = (id: string, label: string): ConnectorDef => ({
      ...base,
      id,
      label,
      category: "data",
      description: `${label} data.`,
      iconUrl: `/connectors/${id}.svg`,
      brandColor: null,
    });
    const extra = [
      data("himetrica", "Himetrica"),
      data("posthog", "PostHog"),
      data("mixpanel", "Mixpanel"),
      data("amplitude", "Amplitude"),
    ];
    api.connectors.catalog = async () => ({ ...CATALOG, connectors: [...CATALOG.connectors, ...extra] });
    const { store } = await open(state, api);
    const row = within(store).getByRole("region", { name: "Dados" });
    expect(names(row)).toEqual(["Amplitude", "Mixpanel", "PostHog"]);
    await click(within(row).getByRole("button", { name: "Ver todos" }));
    expect(tab(storeRoot(), "Dados").getAttribute("aria-pressed")).toBe("true");
    expect(names(storeRoot())).toEqual(["Himetrica", "PostHog", "Mixpanel", "Amplitude"]);
  });

  test("nothing found: one of our agents searching, with the way in by address", async () => {
    const { store } = await open();
    const empty = () => store.querySelector<HTMLElement>(".catalog__empty");
    await searchStore(store, " zzz ");
    // No lines behind it: the empty state carries the way in.
    expect(names(store)).toEqual([]);
    const box = empty() as HTMLElement;
    expect(box.querySelector(".ac-empty__art[aria-hidden='true'] canvas.ac-searchpx")).not.toBeNull();
    expect(box.querySelector(".ac-empty__title")?.textContent).toBe("Nenhum conector com “zzz”");
    expect(box.querySelector(".ac-empty__text")?.textContent).toBe(
      "Você pode conectar qualquer serviço pelo endereço dele.",
    );
    // Its button opens the connect dialog by address, right there.
    await click(within(box).getByRole("button", { name: "Conectar pelo endereço" }));
    await settle(2);
    expect(screen().getByRole("dialog", { name: "Conectar servidor MCP" })).toBeTruthy();
    await pressEsc(screen().getByRole("dialog", { name: "Conectar servidor MCP" }));
    await settle(2);
    // Clearing the search brings the store back, empty state gone.
    await searchStore(store, "");
    expect(empty()).toBeNull();
    expect(names(store).length).toBeGreaterThan(0);
  });

  test("a vendor that hasn't approved agentes.chat yet: greyed, a lock and 'Coming soon', last, and its line opens nothing", async () => {
    const state = seedState({ connections: [] });
    const { store } = await open(state, withSoonAsana(state));
    await click(tab(store, "Produto"));
    // With what can't connect here, last in its category.
    expect(names(store)).toEqual(["Linear", "Asana"]);
    const asana = line(store, "Asana");
    const opens = within(asana).getByRole("button", { name: "Asana, em breve" }) as HTMLButtonElement;
    expect([asana.hasAttribute("data-soon"), opens.disabled]).toEqual([true, true]);
    const state_ = asana.querySelector(".store-state");
    expect(state_?.textContent).toBe("Em breve");
    expect(drawnAs(state_?.querySelector("svg"), "lock")).toBe(true);
    expect(within(asana).queryByRole("button", { name: "Conectar Asana" })).toBeNull();
    await click(opens);
    expect(document.querySelector(".store-dialog")).toBeNull();
    expect(screen().queryAllByRole("dialog")).toEqual([]);
    const starts = ["customConnectors.connect", "connectors.startOAuth", "connectors.connectWithKey"];
    expect(state.calls.filter((c) => starts.includes(c.method))).toEqual([]);
  });

  test("a 'soon' one connected by its address (with a key) is a connection like any other: Connected, no lock, it opens", async () => {
    const state = seedState({ connections: [] });
    const api = withSoonAsana(state);
    await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://mcp.asana.com/mcp",
      label: "Asana",
      apiKey: "asana_key_123456",
      returnTo: "/",
    });
    const { store } = await open(state, api);
    await click(tab(store, "Produto"));
    const asana = line(store, "Asana");
    const opens = within(asana).getByRole("button", { name: "Asana, conectado" }) as HTMLButtonElement;
    expect([opens.disabled, asana.hasAttribute("data-soon")]).toEqual([false, false]);
    expect(asana.querySelector(".store-state")?.textContent).toBe("Conectado");
    // Not sent last with what can't connect: in the catalog's order with the others.
    expect(names(store)).toEqual(["Asana", "Linear"]);
    await click(opens);
    await settle(4);
    expect(
      within(service("Asana")).getByRole("button", { name: "Adicionar outra conta do Asana" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  test("a line opens its service's dialog: what agents could do, what asks, how it connects; its × closes it", async () => {
    const { store } = await open();
    const notion = await openService(store, "Notion");
    expect(notion.textContent).toContain("O que os agentes poderão fazer");
    expect(notion.textContent).toContain("Buscar e ler páginas");
    expect(notion.textContent).toContain("Um clique: você autoriza na página do serviço");
    // The strip: how it connects, who uses it.
    const strip = [...notion.querySelectorAll(".store-strip > div")].map((d) => d.textContent);
    expect(strip).toEqual(["Como conectaUm clique", "Quem usaTodos os agentes"]);
    // What connecting changes, under its own heading.
    expect(within(notion).getByRole("heading", { level: 4, name: "Depois de conectar" })).toBeTruthy();
    expect(notion.textContent).toContain("Ao conectar, todos os agentes podem usar. Dá para ajustar depois.");
    // Its × closes it, the store under it; another line opens its own.
    await backToList();
    expect(document.querySelector(".store-dialog")).toBeNull();
    const github = await openService(storeRoot(), "GitHub");
    // What always asks for approval is marked, and the strip says something asks.
    expect(github.querySelector("[data-asks]")?.textContent).toBe("Por padrão, merge e deploy pedem sua aprovação");
    expect(github.textContent).toContain("Você autoriza na página do serviço, ou usa uma chave de API");
    expect([...github.querySelectorAll(".store-strip > div")].map((d) => d.textContent).at(-1)).toBe(
      "AprovaçãoO que é sensível pede você",
    );
  });

  test("a service's dialog closed, the store is as it was: the search and its lines", async () => {
    const { store } = await open();
    await click(tab(store, "Docs"));
    await openService(store, "Notion");
    await backToList();
    const box = within(storeRoot()).getByRole("searchbox", { name: "Buscar conector" }) as HTMLInputElement;
    expect(box.value).toBe("Notion");
    expect(names(storeRoot())).toEqual(["Notion"]);
    await searchStore(storeRoot(), "");
    expect(tab(storeRoot(), "Docs").getAttribute("aria-pressed")).toBe("true");
    expect(names(storeRoot())).toEqual(["Google Drive", "Notion"]);
  });

  test("the dialog's Connect closes it and starts the flow; a feature opens its dialog, wherever it is pressed", async () => {
    const { store } = await open();
    await pick(store, "Notion");
    expect(screen().getByRole("dialog", { name: "Conectar Notion" })).toBeTruthy();
    expect(document.querySelector(".store-dialog")).toBeNull();
    await click(
      within(screen().getByRole("dialog", { name: "Conectar Notion" })).getByRole("button", { name: "Cancelar" }),
    );
    await settle(2);
    await searchStore(storeRoot(), "");
    // The large feature's See more, and a smaller one by its name (the whole card is that button).
    const hero = storeRoot().querySelector(".store-hero") as HTMLElement;
    const heroName = hero.querySelector(".store-open")?.textContent ?? "";
    await click(within(hero).getByRole("button", { name: `Ver mais sobre ${heroName}` }));
    await settle(4);
    expect(service(heroName).querySelector(".ac-dialog__cover canvas")).not.toBeNull();
    await backToList();
    const card = storeRoot().querySelector(".store-role") as HTMLElement;
    const cardName = card.querySelector(".store-open")?.textContent ?? "";
    await click(card.querySelector(".store-open") as HTMLElement);
    await settle(4);
    expect(service(cardName)).toBeTruthy();
  });

  test("what's connected says Connected; then an MCP server adds an account, a catalog connector signs in again", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.zapier.example/mcp/",
      label: "Zapier",
      returnTo: "/",
    });
    const { store } = await open(state, api);
    // Connected ones aren't suggested.
    expect([...store.querySelectorAll(".store-feats .store-open")].map((b) => b.textContent)).toEqual([
      "Sentry",
      "Notion",
      "Linear",
      "Canva",
      "Google Drive",
      "Stripe",
    ]);
    const github = line(store, "GitHub");
    expect(within(github).getByRole("button", { name: "GitHub, conectado" })).toBeTruthy();
    expect(github.querySelector(".store-state")?.textContent).toBe("Conectado");
    expect(line(store, "Zapier").querySelector(".store-state")?.textContent).toBe("Conectado");
    const detail = await openService(store, "GitHub");
    expect(detail.querySelector(".ac-dialog__desc .store-state")?.textContent).toBe("Conectado");
    // A catalog connector has one account: connected, it signs in again.
    expect(within(detail).getByRole("button", { name: "Reconectar GitHub" }).textContent).toBe("Reconectar");
    await backToList();
    // A server by address takes another account (a preset counts by its address).
    const zapier = await openService(storeRoot(), "Zapier");
    expect(within(zapier).getByRole("button", { name: "Adicionar outra conta do Zapier" }).textContent).toBe(
      "Adicionar outra conta",
    );
    // What is connected is listed in Settings › Connectors.
    await backToList();
    await toSettings();
    expect([...connectedNames()].sort()).toEqual(["GitHub", "Zapier"]);
  });

  test("what connecting does to who uses it: a new service is everyone's, a new sign-in keeps who uses it, another account is everyone's too", async () => {
    const api = createFakeApi(seedState());
    await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.zapier.example/mcp/",
      label: "Zapier",
      returnTo: "/",
    });
    await open(seedState(), api);
    const detail = async (name: string) => {
      const text = (await openService(storeRoot(), name)).textContent;
      await backToList();
      return text;
    };
    const everyone = "Ao conectar, todos os agentes podem usar. Dá para ajustar depois.";
    expect(await detail("Notion")).toContain(everyone);
    expect(await detail("GitHub")).toContain("Substitui o login atual. Quem usa continua igual.");
    expect(await detail("Zapier")).toContain("Cada conta tem quem usa e níveis próprios.");
    const database = await detail("Banco de dados");
    expect(database).toContain("Nenhum agente usa até você escolher.");
    expect(database).toContain("Você escolhe depois");
    expect(database).not.toContain(everyone);

    // A new sign-in for the catalog connector: step 1 says who uses it stays.
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    await click(within(await openService(storeRoot(), "GitHub")).getByRole("button", { name: "Reconectar GitHub" }));
    await settle(2);
    expect(screen().getByRole("dialog", { name: "Reconectar GitHub" })).toBe(flow());
    expect(flow().textContent).toContain("Substitui o login atual. Quem usa continua igual.");
    expect(flow().textContent).not.toContain("todos os agentes podem usar");
    await click(within(flow()).getByRole("button", { name: "Cancelar" }));
    await settle(2);

    // By address: the note follows the address typed (a server already connected takes another account).
    await searchStore(storeRoot(), "");
    await byAddress();
    expect(flow().textContent).toContain("Ao conectar, todos os agentes podem usar. Dá para ajustar depois.");
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), "https://oauth.zapier.example/mcp");
    // No account here was named by its provider, so step 1 can't tell accounts apart and asks for one not yet here.
    expect(flow().textContent).toContain(
      "Entre numa conta que ainda não está conectada, a gente não consegue conferir.",
    );
    expect(flow().textContent).not.toContain("sem agentes");
  });

  test("rules: how it connects, search", () => {
    const byId = (id: string) => CATALOG.connectors.find((d) => d.id === id);
    const kind = (id: string) => {
      const d = byId(id);
      return d ? authKind(d) : null;
    };
    expect([kind("linear"), kind("github"), kind("sentry")]).toEqual(["oneClick", "oauthOrKey", "key"]);
    expect(searchCatalog(CATALOG.connectors, "ciclos").map((d) => d.id)).toEqual(["linear"]);
  });
});

const REVIEW = "Revise o que o agente pode fazer sozinho";
const WAITING = "Os agentes só recebem as ferramentas quando você continuar, nos níveis que sugerimos.";
/** "Ajustar" on the confirmation: on to the detail. */
const adjust = async () => {
  await click(within(screen().getAllByRole("dialog").at(-1) as HTMLElement).getByRole("button", { name: "Ajustar" }));
  await settle(4);
};

describe("the connect flow: conectar → conectado; Ajustar → o que faz → quem pode usar", () => {
  test("a one-click server that asks for a key; tools reviewed by subject; a level per agent", async () => {
    const { state, store } = await open();
    await pick(store, "Linear");
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    expect(flow().textContent).toContain("Conectar Linear");
    const steps = within(flow()).getByRole("list", { name: "Passos" });
    expect(within(steps).getAllByRole("listitem")[0]?.getAttribute("aria-current")).toBe("step");
    expect(flow().textContent).toContain("Ao conectar, todos os agentes podem usar. Dá para ajustar depois.");

    await click(within(flow()).getByRole("button", { name: "Continuar no Linear" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "customConnectors.connect")?.args[1]).toMatchObject({
      serverUrl: "https://mcp.linear.app/mcp",
      label: "Linear",
      returnTo: `/org/${ORG_ID}/settings/connectors`,
    });
    // This server wants a key: the key form opens.
    expect(flow().textContent).toContain("Este servidor não aceita OAuth. Conecte com uma chave de API.");
    await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }));
    expect(flow().textContent).toContain("Cole a chave de API (pelo menos 8 caracteres).");
    await type(within(flow()).getByLabelText("Chave de API"), "lin_api_123456");
    await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }));
    await settle(4);

    // The confirmation: no steps, one sentence. No one gave this server's tools a level yet, and it says so.
    expect(screen().getByRole("dialog", { name: "Linear conectado" })).toBe(flow());
    expect(within(flow()).queryByRole("list", { name: "Passos" })).toBeNull();
    expect(flow().querySelector(".cflow__text")?.textContent).toBe(`${WAITING} 1 ação pede aprovação no chat.`);
    expect(document.body.textContent).not.toContain("Linear conectado.");
    await adjust();

    // Ajustar, step 2: everything comes classified; only the ambiguous tool waits for a decision.
    expect(screen().getByRole("dialog", { name: REVIEW })).toBeTruthy();
    expect(flow().textContent).toContain("Classificamos as 5 ferramentas do Linear.");
    const decide = within(flow()).getByRole("region", { name: "Precisam da sua decisão · 1" });
    expect(decide.textContent).toContain("Fechar chamado");
    expect(decide.textContent).toContain("Sugestão: muda coisas (não apaga nada nem gasta dinheiro)");
    expect(flow().textContent).toContain("Falta 1 decisão. Se continuar, vale a sugestão.");
    expect(within(flow()).queryByRole("region", { name: "Pronto. Tudo revisado." })).toBeNull();
    await click(within(decide).getByRole("button", { name: "Aceitar as sugestões" }));
    expect(within(flow()).queryByRole("region", { name: /Precisam da sua decisão/ })).toBeNull();
    const done = within(flow()).getByRole("region", { name: "Pronto. Tudo revisado." });
    expect(done.textContent).toContain("2 só consultam");
    expect(done.textContent).toContain("1 pede sua aprovação");
    expect(flow().textContent).toContain("Dá para mudar tudo isso depois.");

    // Sensitive: only "Aprovação" or "Desligada".
    await click(within(flow()).getByRole("button", { name: /^Clientes/ }));
    const del = within(flow()).getByRole("radiogroup", { name: "Nível de Apagar cliente" });
    expect(
      within(del)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Aprovação", "Desligada"]);
    await click(within(del).getByRole("radio", { name: "Desligada" }));
    await click(within(flow()).getByRole("button", { name: /^Chamados/ }));
    const create = within(flow()).getByRole("radiogroup", { name: "Nível de Criar chamado" });
    expect(
      within(create)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Consulta", "Muda", "Aprovação", "Desligada"]);
    await click(within(create).getByRole("radio", { name: "Aprovação" }));
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    const saved = state.calls.find((c) => c.method === "customConnectors.saveTools")?.args[2] as {
      tools: { name: string; access: string; confirmed: boolean }[];
    };
    expect(Object.fromEntries(saved.tools.map((x) => [x.name, x.access]))).toEqual({
      list_tickets: "read",
      get_ticket: "read",
      create_ticket: "approval",
      close_ticket: "write",
      delete_customer: "off",
    });
    expect(saved.tools.every((x) => x.confirmed)).toBe(true);

    // Step 3: everyone starts at "Ler e escrever" (the server gave it to every agent); then a level each.
    expect(screen().getByRole("dialog", { name: "Quem pode usar Linear" })).toBeTruthy();
    expect(levels(flow(), ["Nível de todos os agentes", "Nível de Ada", "Nível de Atlas"])).toEqual([
      "Ler e escrever",
      "Ler e escrever",
      "Ler e escrever",
    ]);
    await click(levelIn(flow(), "Nível de todos os agentes", "Ler"));
    await click(levelIn(flow(), "Nível de Ada", "Sem acesso"));
    expect(flow().textContent).toContain("1 ação sempre pede aprovação no chat.");
    await click(within(flow()).getByRole("button", { name: "Liberar" }));
    await settle(8);
    const serverId = state.calls.find((c) => c.method === "customConnectors.saveTools")?.args[1] as string;
    const put = (agentId: string) =>
      state.calls.find((c) => c.method === "access.set" && c.args[1] === agentId)?.args[2] as AccessInput;
    // "Sem acesso": nothing of the server is left.
    expect(put(ADA_ID).connectors[serverId]).toBeUndefined();
    expect(put(ADA_ID).scopes.some((s) => s.connectionId === serverId)).toBe(false);
    // "Ler": its read scope, nothing else; the agent's other grants stay.
    expect(put(ATLAS_ID).connectors[serverId]).toBeUndefined();
    expect(put(ATLAS_ID).scopes).toContainEqual({ connectionId: serverId, scope: `custom:${serverId}:read` });
    expect(put(ATLAS_ID).scopes).toContainEqual({ connectionId: null, scope: "memory:write" });

    // Settings › Connectors lists it: its account, its tools, who uses it; nothing to do, so no state.
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(line(store, "Linear").querySelector(".store-state")?.textContent).toBe("Conectado");
    await toSettings();
    const linear = connectionLine("Linear");
    expect(linear.textContent).toContain("mcp.linear.app");
    expect(linear.textContent).toContain("4 ferramentas");
    expect(linear.textContent).toContain("1 agente");
    expect(linear.querySelector(".store-state")).toBeNull();
  });

  test("a server whose OAuth only lets in apps it approved says so, with its own words, not 'no OAuth', and the key stays the way in", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    const connect = api.customConnectors.connect;
    api.customConnectors.connect = async (orgId, input) =>
      input.apiKey
        ? connect(orgId, input)
        : { status: "needs_key", reason: "not_approved", detail: "invalid_redirect_uri: redirect_uri not allowed" };
    const { store } = await open(state, api);
    await pick(store, "Linear");
    const flow = screen().getByRole("dialog", { name: "Conectar Linear" });
    await click(within(flow).getByRole("button", { name: "Continuar no Linear" }));
    await settle(4);
    // An admin: their own app is the way in, opened with the refusal on top.
    expect(flow.textContent).toContain(
      "Linear só deixa entrar apps que aprovou, e o agentes.chat ainda não foi aprovado. Dá para conectar com um app seu lá.",
    );
    // Under our words, the server's: which one refused and why.
    expect(flow.querySelector(".cflow__said")?.textContent).toBe(
      "O servidor respondeu: invalid_redirect_uri: redirect_uri not allowed",
    );
    expect(flow.textContent).not.toContain("não aceita OAuth");
    const [keyMore, ownMore] = [...flow.querySelectorAll("details.cflow__more")];
    expect(ownMore?.hasAttribute("open")).toBe(true);
    expect(keyMore?.hasAttribute("open")).toBe(false);
    await click(keyMore?.querySelector("summary") as Element);
    await type(within(flow).getByLabelText("Chave de API"), "lin_api_123456");
    await click(within(flow).getByRole("button", { name: "Conectar com a chave" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Linear conectado" })).toBeTruthy();
  });

  test("an admin connects a server that lets in only apps it approved with the workspace's own OAuth app", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    const connect = api.customConnectors.connect;
    let own = false;
    api.customConnectors.connect = async (orgId, input) =>
      own
        ? { status: "oauth", authorizeUrl: "https://auth.example.com/authorize?client_id=1234567890" }
        : input.apiKey
          ? connect(orgId, input)
          : { status: "needs_key", reason: "not_approved" };
    const setOwn = api.customConnectors.setOwnClient;
    api.customConnectors.setOwnClient = async (orgId, input) => {
      own = true;
      return setOwn(orgId, input);
    };
    const left: string[] = [];
    setNavigateAway((url) => left.push(url));
    const { store } = await open(state, api);
    await pick(store, "Linear");
    const flow = screen().getByRole("dialog", { name: "Conectar Linear" });
    await click(within(flow).getByRole("button", { name: "Continuar no Linear" }));
    await settle(6);
    expect(flow.querySelector(".machine-command__code")?.textContent).toBe(
      "https://chat.example.com/api/app/connectors/oauth/callback",
    );
    await click(within(flow).getByRole("button", { name: "Salvar e continuar" }));
    await settle(2);
    expect(flow.textContent).toContain("Cole o ID do cliente do app.");
    await type(within(flow).getByLabelText("ID do cliente"), " 1234567890 ");
    await type(within(flow).getByLabelText("Chave secreta do cliente"), "fake-app-secret");
    await click(within(flow).getByRole("button", { name: "Salvar e continuar" }));
    await settle(6);
    expect(state.calls.filter((c) => c.method === "customConnectors.setOwnClient").map((c) => c.args[1])).toEqual([
      { serverUrl: "https://mcp.linear.app/mcp", clientId: "1234567890", clientSecret: "[redacted]", scopes: "" },
    ]);
    expect(left).toEqual(["https://auth.example.com/authorize?client_id=1234567890"]);
    expect(await api.customConnectors.ownClient(ORG_ID, "https://mcp.linear.app/mcp")).toMatchObject({
      client: { clientId: "1234567890", hasSecret: true },
    });
  });

  test("by address, an admin sees 'Usar seu próprio app OAuth' before typing the address; it asks for an https one, then reads that one", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    const read = api.customConnectors.ownClient;
    const reads: string[] = [];
    api.customConnectors.ownClient = async (orgId, serverUrl) => {
      reads.push(serverUrl);
      return read(orgId, serverUrl);
    };
    await open(state, api);
    await byAddress();
    const flow = screen().getByRole("dialog", { name: "Conectar servidor MCP" });
    const address = within(flow).getByLabelText("Endereço do servidor MCP");
    const ownMore = [...flow.querySelectorAll("details.cflow__more")].find(
      (d) => d.querySelector("summary")?.textContent === "Usar seu próprio app OAuth",
    );
    expect(ownMore).toBeTruthy();
    await click(ownMore?.querySelector("summary") as Element);
    await settle(2);
    expect(ownMore?.textContent).toContain("Primeiro, informe o endereço https do servidor.");
    expect(document.activeElement).toBe(address);
    await type(address, "http://inseguro");
    await settle(2);
    expect(reads).toEqual([]);
    await type(address, "https://oauth.suporte.example.com");
    await settle(4);
    expect(ownMore?.textContent).not.toContain("Primeiro, informe o endereço https do servidor.");
    expect(within(flow).getByLabelText("ID do cliente")).toBeTruthy();
    await type(address, "https://mcp.outro.example.com/mcp");
    await settle(4);
    expect(reads).toEqual(["https://oauth.suporte.example.com", "https://mcp.outro.example.com/mcp"]);
  });

  test("a one-click server the catalog lists without a key (Intercom on the Cloud) offers no API key", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    const intercom: ConnectorDef = {
      ...(CATALOG.connectors.find((d) => d.id === "linear") as ConnectorDef),
      id: "intercom",
      label: "Intercom",
      category: "support",
      description: "Intercom conversations and contacts.",
      serverUrl: "https://mcp.intercom.com/mcp",
      iconUrl: "/connectors/intercom.svg",
      brandColor: null,
      auth: ["oauth"],
    };
    api.connectors.catalog = async () => ({ ...CATALOG, connectors: [intercom, ...CATALOG.connectors] });
    const { store } = await open(state, api);
    await pick(store, "Intercom");
    const flow = screen().getByRole("dialog", { name: "Conectar Intercom" });
    expect(within(flow).getByRole("button", { name: "Continuar no Intercom" })).toBeTruthy();
    expect(flow.textContent).not.toContain("Conectar com uma chave de API");
    expect(within(flow).queryByLabelText("Chave de API")).toBeNull();
  });

  test("'Todos os agentes' is a row like an agent's, on top and raised: it sets every agent, and shows none when they differ", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api: createFakeApi(state) });
    await settle(8);
    await openConnection("GitHub");
    await click(screen().getByRole("button", { name: "Quem usa GitHub" }));
    await settle(4);
    const flow = screen().getByRole("dialog", { name: "Quem pode usar GitHub" });
    const everyone = "Nível de todos os agentes";
    const groups = [everyone, "Nível de Ada", "Nível de Atlas"];
    // Connected before, and nobody uses it yet.
    expect(levels(flow, groups)).toEqual(["Sem acesso", "Sem acesso", "Sem acesso"]);
    const all = within(flow).getByRole("radiogroup", { name: everyone }).closest(".cflow-agent") as HTMLElement;
    expect(all.classList.contains("cflow-agent--all")).toBe(true);
    expect(all.textContent).toContain("Todos os agentes");
    expect(all.textContent).toContain("2 agentes");
    const ada = within(flow).getByRole("radiogroup", { name: "Nível de Ada" });
    expect(all.compareDocumentPosition(ada) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(all.contains(ada)).toBe(false);

    await click(levelIn(flow, everyone, "Ler e escrever"));
    expect(levels(flow, groups)).toEqual(["Ler e escrever", "Ler e escrever", "Ler e escrever"]);
    await click(levelIn(flow, "Nível de Atlas", "Ler"));
    expect(levels(flow, groups)).toEqual([null, "Ler e escrever", "Ler"]);
    await click(within(flow).getByRole("button", { name: "Liberar" }));
    await settle(8);
    const put = (agentId: string) =>
      state.calls.find((c) => c.method === "access.set" && c.args[1] === agentId)?.args[2] as AccessInput;
    // "Ler e escrever": the whole connection (sensitive tools still ask).
    expect(put(ADA_ID).connectors["conn-gh"]).toBe(true);
    expect(put(ATLAS_ID).connectors["conn-gh"]).toBeUndefined();
    expect(put(ATLAS_ID).scopes.filter((g) => g.connectionId === "conn-gh")).toEqual([
      { connectionId: "conn-gh", scope: "github:repo.read" },
    ]);
  });

  test("a new connection: every agent at 'Ler e escrever', read fresh after connecting, so Liberar only confirms", async () => {
    // GitHub is connected: the page already read every agent's access, from before the new server.
    const { state } = await open(seedState());
    await byAddress();
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), "https://oauth.suporte.example.com");
    await type(within(flow()).getByLabelText("Nome"), "Suporte");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    await adjust();
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Quem pode usar Suporte" })).toBeTruthy();
    expect(levels(flow(), ["Nível de todos os agentes", "Nível de Ada", "Nível de Atlas"])).toEqual([
      "Ler e escrever",
      "Ler e escrever",
      "Ler e escrever",
    ]);
    // Sensitive actions still ask, and the dialog says so.
    expect(flow().textContent).toContain("1 ação sempre pede aprovação no chat.");
    await click(within(flow()).getByRole("button", { name: "Liberar" }));
    await settle(8);
    expect(state.calls.filter((c) => c.method === "access.set")).toEqual([]);
    expect(document.body.textContent).toContain("Suporte: 2 agentes podem usar.");
  });

  test("ours with an OAuth app: 'Continuar no GitHub' leaves for GitHub and comes back to Conectores", async () => {
    const left: string[] = [];
    setNavigateAway((url) => left.push(url));
    const { state, store } = await open();
    await pick(store, "GitHub");
    const flow = screen().getByRole("dialog", { name: "Conectar GitHub" });
    // A key is the other way in, folded away.
    expect(within(flow).getByText("Conectar com uma chave de API")).toBeTruthy();
    await click(within(flow).getByRole("button", { name: "Continuar no GitHub" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "connectors.startOAuth")?.args).toEqual([
      ORG_ID,
      "github",
      { returnTo: `/org/${ORG_ID}/settings/connectors`, serverUrl: undefined },
    ]);
    expect(left[0]).toStartWith("https://github.com/login/oauth/authorize");
  });

  test("ours by API key, from the catalog's Conectar: what it does, then who can use it, every agent as the server left it", async () => {
    const { state, store } = await open();
    await pick(store, "GitHub");
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    await click(within(flow()).getByText("Conectar com uma chave de API"));
    await type(within(flow()).getByLabelText("Chave de API"), "ghp_abcdef123456");
    await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "GitHub conectado" })).toBe(flow());
    await adjust();
    expect(screen().getByRole("dialog", { name: "O que GitHub faz" })).toBeTruthy();
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Quem pode usar GitHub" })).toBeTruthy();
    expect(levels(flow(), ["Nível de todos os agentes", "Nível de Ada", "Nível de Atlas"])).toEqual([
      "Ler e escrever",
      "Ler e escrever",
      "Ler e escrever",
    ]);
    await click(levelIn(flow(), "Nível de todos os agentes", "Ler"));
    await click(within(flow()).getByRole("button", { name: "Liberar" }));
    await settle(8);
    const id = state.connections.find((c) => c.connector === "github")?.id ?? "";
    const puts = state.calls.filter((c) => c.method === "access.set");
    expect(puts.map((c) => c.args[1])).toEqual([ADA_ID, ATLAS_ID]);
    for (const put of puts) {
      const input = put.args[2] as AccessInput;
      expect(input.connectors[id]).toBeUndefined();
      expect(input.scopes.filter((s) => s.connectionId === id)).toEqual([
        { connectionId: id, scope: "github:repo.read" },
      ]);
    }
  });

  test("the connection being made never reads as replacing one, though the list has it before the key is answered", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    const send = api.connectors.connectWithKey;
    let answer = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    api.connectors.connectWithKey = async (...args) => {
      const made = await send(...args);
      await answered;
      return made;
    };
    const { services } = await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    await pick(await openStore(), "GitHub");
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    const note = () => flow().querySelector(".ac-dialog__foot-note")?.textContent;
    await click(within(flow()).getByText("Conectar com uma chave de API"));
    await type(within(flow()).getByLabelText("Chave de API"), "ghp_abcdef123456");
    const shown = note();
    expect(shown).toContain("Ao conectar, todos os agentes podem usar.");
    await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }));
    // The list is read again while the key is still being answered.
    await act(async () => services.queryClient.invalidateQueries({ queryKey: keys.connections(ORG_ID) }));
    await settle(4);
    expect(services.queryClient.getQueryData<unknown[]>(keys.connections(ORG_ID))).toHaveLength(1);
    expect(note()).toBe(shown);
    await act(async () => answer());
    await settle(4);
    expect(screen().getByRole("dialog", { name: "GitHub conectado" })).toBe(flow());
  });

  test("back from OAuth (`?connected=github`): what it does (read-only, by scope), then 'Ler' = its read scopes", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    everyAgent(api, "conn-gh");
    await renderApp(`/org/${ORG_ID}/settings/connectors?connected=github`, { api });
    await settle(8);
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    expect(screen().getByRole("dialog", { name: "GitHub conectado" })).toBe(flow());
    await adjust();
    expect(screen().getByRole("dialog", { name: "O que GitHub faz" })).toBeTruthy();
    // Ours are classified by scope: read-only, by subject; each tool shows its level.
    await type(within(flow()).getByRole("searchbox", { name: "Buscar ferramenta" }), "merge");
    const merge = flow().querySelector('[data-row="merge_pull_request"]') as HTMLElement;
    expect(merge.textContent).toContain("Pede sua aprovação");
    expect(merge.getAttribute("title")).toContain("merge_pull_request");
    expect(within(flow()).queryByRole("radiogroup")).toBeNull();
    await type(within(flow()).getByRole("searchbox", { name: "Buscar ferramenta" }), "");
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Quem pode usar GitHub" })).toBeTruthy();
    expect(levels(flow(), ["Nível de todos os agentes", "Nível de Ada", "Nível de Atlas"])).toEqual([
      "Ler e escrever",
      "Ler e escrever",
      "Ler e escrever",
    ]);
    await click(levelIn(flow(), "Nível de Ada", "Ler"));
    await click(within(flow()).getByRole("button", { name: "Liberar" }));
    await settle(8);
    const puts = state.calls.filter((c) => c.method === "access.set");
    expect(puts.map((c) => c.args[1])).toEqual([ADA_ID]);
    const input = puts[0]?.args[2] as AccessInput;
    expect(input.connectors["conn-gh"]).toBeUndefined();
    expect(input.scopes.filter((s) => s.connectionId === "conn-gh")).toEqual([
      { connectionId: "conn-gh", scope: "github:repo.read" },
    ]);
  });

  test("back from OAuth in the desktop app's window, Conectores already loaded: its tools, then who can use it", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    // As the server finishes it.
    api.connectors.completeOAuth = async (orgId, input) => {
      state.calls.push({ method: "connectors.completeOAuth", args: [orgId, input] });
      state.connections.push({
        id: "conn-new",
        connector: "github",
        label: "GitHub",
        serverUrl: "https://api.githubcopilot.com/mcp/",
        authType: "oauth",
        accountLabel: "acme",
        tokenExpiresAt: null,
        createdAt: new Date().toISOString(),
        revokedAt: null,
      });
      everyAgent(api, "conn-new");
      return { connectionId: "conn-new", connector: "github", returnTo: `/org/${ORG_ID}/settings/connectors` };
    };
    const { router } = await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    expect(document.querySelector(".settings__body")?.textContent).toContain("Conecte os apps do seu time");
    // The window moves in the page (no reload): the lists read before the sign-in are still cached.
    await act(async () => router.history.push(`/desktop/connector?org=${ORG_ID}&state=s1&code=c1`));
    await settle(12);
    expect(state.calls.find((c) => c.method === "connectors.completeOAuth")?.args[1]).toEqual({
      state: "s1",
      code: "c1",
    });
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    expect(screen().getByRole("dialog", { name: "GitHub conectado" })).toBe(flow());
    await adjust();
    expect(screen().getByRole("dialog", { name: "O que GitHub faz" })).toBeTruthy();
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Quem pode usar GitHub" })).toBeTruthy();
    expect(levels(flow(), ["Nível de todos os agentes", "Nível de Ada", "Nível de Atlas"])).toEqual([
      "Ler e escrever",
      "Ler e escrever",
      "Ler e escrever",
    ]);
    await click(levelIn(flow(), "Nível de Atlas", "Sem acesso"));
    await click(within(flow()).getByRole("button", { name: "Liberar" }));
    await settle(8);
    const puts = state.calls.filter((c) => c.method === "access.set");
    expect(puts.map((c) => c.args[1])).toEqual([ATLAS_ID]);
    const input = puts[0]?.args[2] as AccessInput;
    expect(input.connectors["conn-new"]).toBeUndefined();
    expect(input.scopes.some((s) => s.connectionId === "conn-new")).toBe(false);
    expect(document.body.textContent).toContain("GitHub: 1 agente pode usar.");
  });

  test("any MCP server by address; back from its OAuth (`?connected=custom:{id}`) the review opens", async () => {
    const { state } = await open();
    await byAddress();
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    expect(screen().getByRole("dialog", { name: "Conectar servidor MCP" })).toBeTruthy();
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), "http://inseguro");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    expect(flow().textContent).toContain("Use um endereço que comece com https://.");
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), "https://oauth.suporte.example.com");
    await type(within(flow()).getByLabelText("Nome"), "Suporte");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "customConnectors.connect")?.args[1]).toMatchObject({
      serverUrl: "https://oauth.suporte.example.com",
      label: "Suporte",
    });
    expect(screen().getByRole("dialog", { name: "Suporte conectado" })).toBe(flow());
    await adjust();
    expect(screen().getByRole("dialog", { name: REVIEW }).textContent).toContain("ferramentas do Suporte");
    cleanup();

    const api = createFakeApi(seedState());
    const res = await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.himetrica.com",
      label: "himetrica",
      returnTo: "/",
    });
    if (res.status !== "connected") throw new Error("expected connected");
    await renderApp(`/org/${ORG_ID}/settings?connected=custom:${res.server.id}`, { api });
    await settle(8);
    expect(screen().getByRole("dialog", { name: "himetrica conectado" })).toBe(flow());
    await adjust();
    expect(screen().getByRole("dialog", { name: REVIEW }).textContent).toContain("ferramentas do himetrica");
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Quem pode usar himetrica" })).toBeTruthy();
    expect(levels(flow(), ["Nível de Ada", "Nível de Atlas"])).toEqual(["Ler e escrever", "Ler e escrever"]);
  });

  test("new tools on a reviewed server: its line asks for review; disconnecting always asks first", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    const res = await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.suporte.example.com",
      label: "Suporte",
      returnTo: "/",
    });
    if (res.status !== "connected") throw new Error("expected connected");
    await api.customConnectors.saveTools(ORG_ID, res.server.id, {
      label: "Suporte",
      tools: res.server.tools.map((x) => ({ name: x.name, access: x.sensitive ? "off" : "read", label: x.name })),
    });
    await api.customConnectors.refresh(ORG_ID, res.server.id);
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    // A server the catalog doesn't list is a line of the same list; what needs the person, in its color, with the
    // button that settles it.
    const suporte = connectionLine("Suporte");
    expect(suporte.querySelector(".store-state[data-s='wait']")?.textContent).toBe("1 ferramenta nova para revisar");
    await click(within(suporte).getByRole("button", { name: "Revisar Suporte" }));
    const review = screen().getByRole("dialog", { name: REVIEW });
    // The new tool comes classified (the server says it only reads), in its subject.
    await type(within(review).getByRole("searchbox", { name: "Buscar ferramenta" }), "exportar");
    const fresh = review.querySelector('[data-row="export_tickets"]') as HTMLElement;
    expect(fresh.textContent).toContain("Exportar chamados");
    await click(within(review).getByRole("button", { name: "Cancelar" }));
    await settle(2);

    // Disconnect ends its page.
    await click(within(await openConnection("Suporte")).getByRole("button", { name: "Desconectar Suporte" }));
    const confirm = screen().getByRole("dialog", { name: "Desconectar Suporte?" });
    // Connected, it was every agent's.
    expect(confirm.textContent).toContain("2 agentes perdem o acesso na hora.");
    await click(within(confirm).getByRole("button", { name: "Desconectar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "customConnectors.disconnect")?.args).toEqual([ORG_ID, res.server.id]);
    // Its page is gone with it: back on the list, which has nothing left.
    expect(document.querySelector(".store-page")).toBeNull();
    expect(connectedNames()).toEqual([]);
    expect(document.querySelector(".settings__body")?.textContent).toContain("Conecte os apps do seu time");
  });

  test("a server by address: Connect by address under the list opens connecting; it joins the same list", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    expect(document.querySelector(".settings__body .ac-pagehead h2")?.textContent).toBe("Conectores e MCPs");
    // No section of its own: one list, and the way in by address under it.
    expect(screen().queryByRole("region", { name: "MCPs" })).toBeNull();
    expect(document.querySelector(".store-foot")?.textContent).toBe(
      "Tem um serviço que não está na loja? Conectar pelo endereço",
    );
    await byAddress();
    const flow = screen().getByRole("dialog", { name: "Conectar servidor MCP" });
    await type(within(flow).getByLabelText("Endereço do servidor MCP"), "https://oauth.suporte.example.com");
    await type(within(flow).getByLabelText("Nome"), "Suporte");
    await click(within(flow).getByRole("button", { name: "Conectar" }));
    await settle(4);
    await click(
      within(screen().getByRole("dialog", { name: "Suporte conectado" })).getByRole("button", { name: "Fechar" }),
    );
    await settle(4);
    expect([...connectedNames()].sort()).toEqual(["GitHub", "Suporte"]);
  });
});

describe("several accounts of one service", () => {
  /** Conectores with Zapier connected twice (the second account "Zapier 2"), and who uses each. */
  const twoAccounts = async (oauthOnly = false) => {
    const state = seedState();
    const api = createFakeApi(state);
    if (oauthOnly) {
      // The catalog lists this server without a key, as it lists Intercom on the Cloud.
      const zapier: ConnectorDef = {
        ...(CATALOG.connectors.find((d) => d.id === "linear") as ConnectorDef),
        id: "zapier",
        label: "Zapier",
        serverUrl: "https://oauth.zapier.example/mcp",
        auth: ["oauth"],
      };
      api.connectors.catalog = async () => ({ ...CATALOG, connectors: [zapier, ...CATALOG.connectors] });
    }
    const connect = async () => {
      const res = await api.customConnectors.connect(ORG_ID, {
        serverUrl: "https://oauth.zapier.example/mcp",
        label: "Zapier",
        returnTo: "/",
      });
      if (res.status !== "connected") throw new Error("expected connected");
      return res.server;
    };
    const first = await connect();
    const second = await connect();
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    return { state, api, first, second };
  };
  const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;

  test("each account is a line with its own name; on its page, only an MCP server's ⋯ adds another account", async () => {
    await twoAccounts();
    expect([...connectedNames()].sort()).toEqual(["GitHub", "Zapier", "Zapier 2"]);
    const zapier = await rowMenu("Zapier 2");
    expect(
      within(zapier)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Renomear", "Adicionar outra conta"]);
    await pressEsc(zapier);
    // Reconnect is the Account line's button, Disconnect ends the page.
    const page = document.querySelector(".store-page") as HTMLElement;
    expect(within(page).getByRole("button", { name: "Reconectar Zapier 2" }).textContent).toBe("Reconectar");
    expect(within(page).getByRole("button", { name: "Desconectar Zapier 2" })).toBeTruthy();
    await backToList();
    const github = await rowMenu("GitHub");
    expect(
      within(github)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Renomear"]);
  });

  test("Reconectar signs that account in again: its id goes along, a toast says it, nothing else to do", async () => {
    const { state, second } = await twoAccounts();
    await click(within(await openConnection("Zapier 2")).getByRole("button", { name: "Reconectar Zapier 2" }));
    expect(screen().getByRole("dialog", { name: "Reconectar Zapier 2" })).toBe(flow());
    expect(flow().textContent).toContain(
      "Entre na mesma conta de antes. A gente não consegue conferir qual é, e quem usa continua igual.",
    );
    await click(within(flow()).getByRole("button", { name: "Continuar no Zapier" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "customConnectors.connect").at(-1)?.args[1]).toMatchObject({
      serverUrl: "https://oauth.zapier.example/mcp",
      connectionId: second.id,
    });
    expect(document.body.textContent).toContain("Zapier 2 reconectado.");
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("an account of a server the catalog lists without a key: neither Reconectar nor another account offers one", async () => {
    await twoAccounts(true);
    await click(within(await openConnection("Zapier 2")).getByRole("button", { name: "Reconectar Zapier 2" }));
    expect(within(flow()).getByRole("button", { name: "Continuar no Zapier" })).toBeTruthy();
    expect(flow().textContent).not.toContain("Conectar com uma chave de API");
    await pressEsc(flow());
    await settle(2);
    await backToList();
    await click(within(await rowMenu("Zapier")).getByRole("menuitem", { name: "Adicionar outra conta" }));
    expect(flow().textContent).not.toContain("Conectar com uma chave de API");
    expect(within(flow()).queryByLabelText("Chave de API")).toBeNull();
  });

  test("another account: every agent's too; Ajustar asks its name first, then its tools, then who uses it", async () => {
    const { state } = await twoAccounts();
    await click(within(await rowMenu("Zapier")).getByRole("menuitem", { name: "Adicionar outra conta" }));
    expect(screen().getByRole("dialog", { name: "Outra conta do Zapier" })).toBe(flow());
    // No account here was named by its provider, so step 1 can't tell accounts apart and asks for one not yet here.
    expect(flow().textContent).toContain(
      "Entre numa conta que ainda não está conectada, a gente não consegue conferir.",
    );
    expect(flow().textContent).not.toContain("sem agentes");
    await click(within(flow()).getByRole("button", { name: "Continuar no Zapier" }));
    await settle(4);
    const sent = state.calls.filter((c) => c.method === "customConnectors.connect").at(-1)?.args[1] as {
      connectionId?: string;
      label?: string;
    };
    expect([sent.connectionId, sent.label]).toEqual([undefined, "Zapier"]);
    expect(screen().getByRole("dialog", { name: "Zapier 3 conectado" })).toBe(flow());
    await adjust();
    // A name the server numbered: asked above its tools, and a name another account has is refused there.
    const name = within(flow()).getByLabelText("Nome desta conta") as HTMLInputElement;
    expect(name.value).toBe("Zapier 3");
    await type(name, "zapier 2");
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    expect(flow().textContent).toContain("Já existe um conector com esse nome.");
    expect(state.calls.some((c) => c.method === "customConnectors.saveTools")).toBe(false);
    await type(name, "Zapier Loja");
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "customConnectors.saveTools")?.args[2]).toMatchObject({
      label: "Zapier Loja",
    });
    expect(screen().getByRole("dialog", { name: "Quem pode usar Zapier Loja" })).toBe(flow());
    expect(levels(flow(), ["Nível de todos os agentes", "Nível de Ada", "Nível de Atlas"])).toEqual([
      "Ler e escrever",
      "Ler e escrever",
      "Ler e escrever",
    ]);
  });

  test("Quem usa is per account, and every account starts as every agent's", async () => {
    await twoAccounts();
    const who = async (name: string) => {
      await click(within(await openConnection(name)).getByRole("button", { name: `Quem usa ${name}` }));
      await settle(4);
      const shown = levels(flow(), ["Nível de Ada", "Nível de Atlas"]);
      await click(within(flow()).getByRole("button", { name: "Voltar" }));
      await click(within(flow()).getByRole("button", { name: "Cancelar" }));
      await settle(2);
      await backToList();
      return shown;
    };
    expect(await who("Zapier")).toEqual(["Ler e escrever", "Ler e escrever"]);
    expect(await who("Zapier 2")).toEqual(["Ler e escrever", "Ler e escrever"]);
  });

  test("Renomear: the new name everywhere, a name another connector has is refused in place", async () => {
    const { state, second } = await twoAccounts();
    await click(within(await rowMenu("Zapier 2")).getByRole("menuitem", { name: "Renomear" }));
    const dialog = screen().getByRole("dialog", { name: "Renomear Zapier 2" });
    const name = within(dialog).getByLabelText("Nome") as HTMLInputElement;
    expect(name.value).toBe("Zapier 2");
    await type(name, "GitHub");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(dialog.textContent).toContain("Já existe um conector com esse nome.");
    await type(name, "Zapier Loja");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(6);
    expect(state.calls.filter((c) => c.method === "connectors.rename").at(-1)?.args).toEqual([
      ORG_ID,
      second.id,
      "Zapier Loja",
    ]);
    expect(document.body.textContent).toContain("Agora se chama Zapier Loja.");
    // Its page takes the new name.
    const page = document.querySelector(".store-page") as HTMLElement;
    expect(page.querySelector(".store-page__title h3")?.textContent).toBe("Zapier Loja");
    expect(within(page).getByRole("button", { name: "Quem usa Zapier Loja" })).toBeTruthy();
  });

  test("back from OAuth, the outcome says what happened: only a new account gets the confirmation", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const res = await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.zapier.example/mcp",
      label: "Zapier",
      returnTo: "/",
    });
    if (res.status !== "connected") throw new Error("expected connected");
    await renderApp(`/org/${ORG_ID}/settings/connectors?connected=custom:${res.server.id}&outcome=reconnected`, {
      api,
    });
    await settle(8);
    expect(document.body.textContent).toContain("Zapier reconectado.");
    expect(screen().queryByRole("dialog")).toBeNull();
  });
});

describe("the confirmation that ends connecting", () => {
  const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
  const sentence = () => flow().querySelector(".cflow__text")?.textContent;
  const buttons = () =>
    [...flow().querySelectorAll(".ac-dialog__foot button")].map((b) => (b as HTMLButtonElement).textContent);
  const connection = (connector: string, label: string) => ({
    id: `conn-${connector}`,
    connector,
    label,
    serverUrl: "https://mcp.example.com/mcp",
    authType: "api_key" as const,
    accountLabel: null,
    tokenExpiresAt: null,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  });

  test("ours: everyone can use it and how many actions ask; Pronto closes and nothing is saved", async () => {
    const { state, store } = await open();
    await pick(store, "GitHub");
    await click(within(flow()).getByText("Conectar com uma chave de API"));
    await type(within(flow()).getByLabelText("Chave de API"), "ghp_abcdef123456");
    await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "GitHub conectado" })).toBe(flow());
    expect(sentence()).toBe("Todos os agentes podem usar. 1 ação pede aprovação no chat.");
    expect(buttons()).toEqual(["Ajustar", "Pronto"]);
    await click(within(flow()).getByRole("button", { name: "Pronto" }));
    await settle(4);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(state.calls.filter((c) => c.method === "access.set" || c.method === "customConnectors.saveTools")).toEqual(
      [],
    );
    // Its detail stays one click away: its line in Settings › Connectors opens its page.
    await toSettings();
    expect(within(await openConnection("GitHub")).getByRole("button", { name: "Quem usa GitHub" })).toBeTruthy();
  });

  test("nothing asks: the sentence stops at who can use it, never '0 ações'", async () => {
    const state = seedState({ connections: [connection("sentry", "Sentry")] });
    await renderApp(`/org/${ORG_ID}/settings/connectors?connected=sentry`, { api: createFakeApi(state) });
    await settle(8);
    expect(screen().getByRole("dialog", { name: "Sentry conectado" })).toBe(flow());
    expect(sentence()).toBe("Todos os agentes podem usar.");
  });

  test("a server whose tools have no level yet: it says so, and Continuar saves the suggested ones", async () => {
    const { state } = await open();
    await byAddress();
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), "https://oauth.suporte.example.com");
    await type(within(flow()).getByLabelText("Nome"), "Suporte");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(sentence()).toBe(`${WAITING} 1 ação pede aprovação no chat.`);
    expect(buttons()).toEqual(["Ajustar", "Continuar"]);
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    expect(screen().queryByRole("dialog")).toBeNull();
    const saved = state.calls.find((c) => c.method === "customConnectors.saveTools")?.args[2] as {
      tools: { name: string; access: string; confirmed: boolean }[];
    };
    expect(Object.fromEntries(saved.tools.map((x) => [x.name, x.access]))).toEqual({
      list_tickets: "read",
      get_ticket: "read",
      create_ticket: "write",
      close_ticket: "write",
      delete_customer: "approval",
    });
    // The one its name couldn't decide keeps waiting for a person, at our suggestion meanwhile.
    expect(saved.tools.filter((x) => !x.confirmed).map((x) => x.name)).toEqual(["close_ticket"]);
    expect(state.calls.filter((c) => c.method === "access.set")).toEqual([]);
  });

  test("a server whose tools already have their levels: Pronto, with what asks counted from them", async () => {
    const api = createFakeApi(seedState());
    const res = await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.suporte.example.com",
      label: "Suporte",
      returnTo: "/",
    });
    if (res.status !== "connected") throw new Error("expected connected");
    await api.customConnectors.saveTools(ORG_ID, res.server.id, {
      label: "Suporte",
      tools: res.server.tools.map((x) => ({
        name: x.name,
        access: x.readOnlyHint ? "read" : "approval",
        label: x.name,
      })),
    });
    await renderApp(`/org/${ORG_ID}/settings/connectors?connected=custom:${res.server.id}`, { api });
    await settle(8);
    expect(sentence()).toBe("Todos os agentes podem usar. 3 ações pedem aprovação no chat.");
    expect(buttons()).toEqual(["Ajustar", "Pronto"]);
  });

  test("a name longer than a connection can take: whole in the title, the two buttons still there", async () => {
    const long = "Atendimento e Suporte ao Cliente da Loja de Departamentos Internacional Example (Produção 2)";
    expect(long.length).toBeGreaterThan(80);
    await open();
    await byAddress();
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), "https://oauth.suporte.example.com");
    await type(within(flow()).getByLabelText("Nome"), long);
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: `${long} conectado` })).toBe(flow());
    expect(buttons()).toEqual(["Ajustar", "Continuar"]);
  });

  test("the sentence in both languages: one action, many, none", () => {
    const of = (lng: "pt-BR" | "en", sensitive: number) =>
      connectedSummary(createI18n(lng).t as TFunction, {
        server: null,
        pending: 0,
        def: {
          ...(CATALOG.connectors.find((d) => d.id === "github") as ConnectorDef),
          tools: Array.from({ length: 3 }, (_, i) => ({
            name: `tool_${i}`,
            scope: "github:x",
            sensitive: i < sensitive,
          })),
        },
      });
    expect([0, 1, 2].map((n) => of("pt-BR", n))).toEqual([
      "Todos os agentes podem usar.",
      "Todos os agentes podem usar. 1 ação pede aprovação no chat.",
      "Todos os agentes podem usar. 2 ações pedem aprovação no chat.",
    ]);
    expect([0, 1, 2].map((n) => of("en", n))).toEqual([
      "Every agent can use it.",
      "Every agent can use it. 1 action asks for approval in the chat.",
      "Every agent can use it. 2 actions ask for approval in the chat.",
    ]);
  });
});

describe("a server whose tools can't be read", () => {
  test("Connectors says so on the line: a dead sign-in 'Needs reconnecting' with Reconnect; tools unread, 'No tools right now'", async () => {
    const state = seedState();
    const github = state.connections[0];
    if (github) github.status = "needs_reconnect";
    const api = createFakeApi(state);
    // A long name: the chip beside it still fits the row at any width.
    const label = "Suporte ao cliente das lojas da região sul e do centro-oeste";
    const res = await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.suporte.example.com",
      label,
      returnTo: "/",
    });
    if (res.status !== "connected") throw new Error("expected connected");
    const list = api.customConnectors.list;
    api.customConnectors.list = async (orgId) =>
      (await list(orgId)).map((s) => ({ ...s, toolsError: "Streamable HTTP error: upstream timed out" }));
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    const stateOf = (name: string) => connectionLine(name).querySelector(".store-item__text .store-state")?.textContent;
    // What needs the person comes first, its state in its color under the name.
    expect(connectedNames()).toEqual(["GitHub", label]);
    expect(stateOf("GitHub")).toBe("Precisa reconectar");
    expect(within(connectionLine("GitHub")).getByRole("button", { name: "Reconectar GitHub" }).textContent).toBe(
      "Reconectar",
    );
    // Tools unread: said, with nothing the person could press for it.
    expect(stateOf(label)).toBe("Sem ferramentas agora");
    expect(within(connectionLine(label)).queryByRole("button", { name: /Reconectar|Revisar/ })).toBeNull();
  });

  test("the review says why with Tentar de novo, not '0 ferramentas'; a working retry lists them", async () => {
    const api = createFakeApi(seedState({ connections: [] }));
    const res = await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.suporte.example.com",
      label: "Suporte",
      returnTo: "/",
    });
    if (res.status !== "connected") throw new Error("expected connected");
    const reason = "Streamable HTTP error: Error POSTing to endpoint: upstream timed out";
    const list = api.customConnectors.list;
    let broken = true;
    api.customConnectors.list = async (orgId) =>
      (await list(orgId)).map((s) => (broken ? { ...s, tools: [], toolsError: reason } : s));
    const refresh = api.customConnectors.refresh;
    api.customConnectors.refresh = async (orgId, id) => {
      broken = false;
      return refresh(orgId, id);
    };
    await renderApp(`/org/${ORG_ID}/settings?connected=custom:${res.server.id}`, { api });
    await settle(8);
    // The confirmation says it too, under who can use it.
    const done = screen().getByRole("dialog", { name: "Suporte conectado" });
    expect(done.querySelector(".cflow__text")?.textContent).toBe("Todos os agentes podem usar.");
    expect(within(done).getByRole("alert").textContent).toBe(`Não deu para ler as ferramentas do conector: ${reason}`);
    await adjust();
    const review = () => screen().getByRole("dialog", { name: REVIEW });
    expect(within(review()).getByRole("alert").textContent).toBe(
      `Não deu para ler as ferramentas do conector: ${reason}`,
    );
    expect(review().textContent).not.toContain("Classificamos");
    expect(review().textContent).not.toContain("O servidor não ofereceu nenhuma ferramenta.");
    await click(within(review()).getByRole("button", { name: "Tentar de novo" }));
    await settle(4);
    expect(within(review()).queryByRole("alert")).toBeNull();
    // The fake finds one tool more on a refresh.
    expect(review().textContent).toContain("Classificamos as 6 ferramentas do Suporte.");
  });
});
