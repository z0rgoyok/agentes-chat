import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { NEW_CHANNEL_EVENT } from "@/components/sidebar-state";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, GENERAL_ID, meWithRole, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const INTEGRATIONS = "00000000-0000-4000-8000-0000000000e1";
const ENGINEERING = "00000000-0000-4000-8000-0000000000f1";
const BOARD = "00000000-0000-4000-8000-0000000000f2";

type State = ReturnType<typeof seedState>;
const as = (role: "owner" | "member", state = seedState()) => {
  if (state.me?.organizations[0]) state.me.organizations[0].role = role;
  return state;
};
/**
 * Acme where Ada answers only João, her owner, and is Integrations' only agent; #eng sits in the sector Engenharia, and
 * Diretoria holds only private channels I'm not in (the server leaves them out of my list). I am Walter, with a DM
 * with each agent (Atlas's the latest).
 */
function acme(role: "owner" | "member") {
  const state = as(role);
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.audience = { mode: "owner", userIds: [] };
  state.agentGroups = [
    { id: INTEGRATIONS, name: "Integrations", agentIds: [ADA_ID] },
    { id: ENGINEERING, name: "Engenharia", agentIds: [] },
    { id: BOARD, name: "Diretoria", agentIds: [] },
  ];
  for (const c of state.channels) if (c.id === ENG_ID) c.groupId = ENGINEERING;
  seedDm(state, { type: "agent", id: ADA_ID }, { ago: 2 });
  seedDm(state, { type: "agent", id: ATLAS_ID }, { ago: 1 });
  return state;
}
const go = async (state: State, path = `c/${ENG_ID}`) => {
  await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
};
const nav = () => screen().getByRole("navigation", { name: "Navegação do workspace" });
const sections = () => [...nav().querySelectorAll(".sidebar__section-toggle")].map((b) => b.textContent);
const agentRows = () =>
  [...nav().querySelectorAll("[data-agent-row] .sidebar__item-label")].map((label) => label.textContent);
const typeIn = (el: HTMLTextAreaElement, value: string) =>
  act(async () => {
    fireEvent.change(el, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
  });

describe("what a member's sidebar lists", () => {
  test("only the DMs of agents that answer them, and no agent group", async () => {
    await go(acme("member"));
    expect(agentRows()).toEqual(["Atlas"]);
    expect(sections()).not.toContain("Integrations");
    expect(nav().querySelector(".sidebar__lock")).toBeNull();
    // The team's directory stays a click away.
    expect(within(nav()).getByRole("link", { name: "Equipe" })).toBeTruthy();
  });

  test("no sector in the list at all: Canais and Mensagens diretas, sectors stay on Equipe (ADR 0260)", async () => {
    await go(acme("member"));
    expect(sections()).toEqual(["Canais", "Mensagens diretas"]);
  });

  test("@ offers only the agents that answer them", async () => {
    await go(acme("member"));
    const box = screen().getByRole("combobox", { name: /Mensagem para/ }) as HTMLTextAreaElement;
    await typeIn(box, "oi @a");
    const offered = within(screen().getByRole("listbox", { name: "Pessoas e agentes" }))
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    expect(offered.some((n) => n.includes("Atlas"))).toBe(true);
    expect(offered.some((n) => n.includes("Ada"))).toBe(false);
  });

  test("an empty channel's suggestions and its / commands go to an agent that answers them", async () => {
    const state = acme("member");
    state.channelMembers[GENERAL_ID] = [
      { type: "person", id: "u-walter" },
      { type: "agent", id: ADA_ID },
      { type: "agent", id: ATLAS_ID },
    ];
    await go(state, `c/${GENERAL_ID}`);
    const chips = document.querySelector(".channel__suggestions")?.textContent ?? "";
    expect(chips).toContain("@Atlas");
    expect(chips).not.toContain("@Ada");
    const box = screen().getByRole("combobox", { name: /Mensagem para/ }) as HTMLTextAreaElement;
    await typeIn(box, "/");
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    expect(box.value).toBe("@atlas monte um relatório sobre ");
  });

  test("Create channel offers only the agents they may put there: their own, or ones they manage", async () => {
    const picker = async (state: State) => {
      await go(state);
      await act(async () => window.dispatchEvent(new Event(NEW_CHANNEL_EVENT)));
      await settle(3);
      const dialog = screen().getByRole("dialog", { name: "Criar canal" });
      return within(dialog).getByRole("region", { name: "Buscar pessoa ou agente" }).textContent;
    };
    // Atlas answers them, but only João and who manages Atlas put it in a channel (the server's
    // `requirePlacesAgent`); an agent of their own they do.
    expect(await picker(acme("member"))).not.toContain("Atlas");
    cleanup();
    const owning = acme("member");
    const atlas = owning.agents.find((a) => a.id === ATLAS_ID);
    if (atlas) atlas.ownerUserId = "u-walter";
    expect(await picker(owning)).toContain("Atlas");
    cleanup();
    // "Edit agents" reaches the agents that answer them, never Ada, who answers only João (ADR 0085 addendum).
    const keyHolder = acme("member");
    meWithRole(keyHolder, ["manage_agents"]);
    const offered = await picker(keyHolder);
    expect(offered).toContain("Atlas");
    expect(offered).not.toContain("Ada");
  });

  test("Edit agents showing the rest lists only the agents whose DM opens: someone's private agent stays unlisted", async () => {
    const keyHolder = acme("member");
    meWithRole(keyHolder, ["manage_agents"]);
    keyHolder.sidebarView = { agentSort: "workspace", showAllAgents: true, pins: null };
    await go(keyHolder);
    // Ada answers only João: the key doesn't reach her (ADR 0085 addendum), and private means unlisted, so not even
    // Team counts her.
    expect(agentRows()).toEqual(["Atlas"]);
    expect(sections()).not.toContain("Integrations");
    expect(nav().querySelector(".sidebar__see-all")).toBeNull();
    cleanup();
    // With nobody responsible for her, the key reaches her: she shows, locked, and her row opens her DM.
    const ownerless = acme("member");
    meWithRole(ownerless, ["manage_agents"]);
    ownerless.sidebarView = { agentSort: "workspace", showAllAgents: true, pins: null };
    const ada = ownerless.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.ownerUserId = null;
    await go(ownerless);
    expect(agentRows()).toEqual(["Atlas", "Ada"]);
    expect(within(nav()).getByRole("link", { name: /^Ada/ }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/dm/agent/${ADA_ID}`,
    );
  });

  test("owners and admins see the agents that talk to them until they show the rest, no sector either way", async () => {
    await go(acme("owner"));
    expect(sections()).toEqual(["Canais", "Mensagens diretas"]);
    expect(agentRows()).toEqual(["Atlas"]);
    cleanup();
    const state = acme("owner");
    state.sidebarView = { agentSort: "workspace", showAllAgents: true, pins: null };
    await go(state);
    expect(sections()).toEqual(["Canais", "Mensagens diretas"]);
    expect(agentRows()).toEqual(["Atlas", "Ada"]);
    // The lock explains itself: its title says who it talks to.
    const ada = within(nav()).getByRole("link", { name: /^Ada/ });
    expect(within(ada).getByRole("img", { name: "Pessoal" })).toBeTruthy();
  });
});

describe("Equipe, a tile of the tool column", () => {
  const team = () =>
    within(within(nav()).getByRole("toolbar", { name: "Ferramentas" })).getByRole("link", { name: "Equipe" });

  test("among the tools, marked while the page is open", async () => {
    await go(acme("owner"));
    expect(team().getAttribute("href")).toBe(`/org/${ORG_ID}/team`);
    expect(team().getAttribute("data-status")).toBeNull();
    cleanup();
    await go(acme("owner"), "team");
    expect(team().getAttribute("data-status")).toBe("active");
  });

  test("collapsed, the column keeps it with the other tools", async () => {
    await go(acme("owner"));
    const toggle = () => within(nav()).getByRole("button", { name: /barra lateral$/ });
    await act(async () => fireEvent.click(toggle()));
    try {
      expect(nav().getAttribute("data-rail")).toBe("true");
      expect(team()).toBeTruthy();
    } finally {
      // The rail is kept for the whole page, not per render: back to the full sidebar for the other tests.
      await act(async () => fireEvent.click(toggle()));
    }
  });
});

describe("bringing agents from another app, where agents are made", () => {
  const toImport = () => screen().queryByRole("link", { name: "Trazer agentes de outro app" });

  const importButton = () => screen().queryByRole("button", { name: "Trazer agentes de outro app" });

  test("Equipe links to Importar e exportar for who creates agents; Criar agente opens the import in place", async () => {
    await go(as("owner"), "team");
    expect(toImport()?.getAttribute("href")).toBe(`/org/${ORG_ID}/settings/import`);
    cleanup();
    await go(as("owner"), "agents/new");
    expect(importButton()).not.toBeNull();
  });

  test("members, who don't create agents, get neither", async () => {
    await go(as("member"), "team");
    expect(toImport()).toBeNull();
    cleanup();
    await go(as("member"), "agents/new");
    expect(screen().getByText(/Só admins e donos criam agentes/)).toBeTruthy();
    expect(toImport()).toBeNull();
    expect(importButton()).toBeNull();
  });
});

describe("an agent's row", () => {
  test("one line: its name and the IA tag, the role in its title, and the lock alone at the row's end", async () => {
    const state = acme("owner");
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) Object.assign(ada, { role: "Assistente de e-mails e agenda da diretoria", ownerUserId: "u-walter" });
    // Ada answers Walter and João; pinned or not, the role line is the same.
    if (ada) ada.audience = { mode: "people", userIds: ["u-joao"] };
    state.sidebarView = {
      agentSort: "workspace",
      showAllAgents: false,
      pins: { agents: [], channels: [], people: [] },
    };
    await go(state);
    const row = nav().querySelector(`[data-agent-row="${ADA_ID}"] .sidebar__item`);
    expect(row?.querySelector(":scope > .sidebar__item-label")?.textContent).toBe("Ada");
    expect(row?.querySelector(":scope > .sidebar__kind")?.textContent).toBe("IA");
    expect(row?.querySelector(".sidebar__item-role")).toBeNull();
    expect(row?.getAttribute("title")).toContain("Assistente de e-mails e agenda da diretoria");
    // Nothing at the row's end shares the name's line with the role: only the lock.
    const end = row?.querySelector(":scope > .sidebar__item-meta");
    expect(end?.textContent).toBe("");
    expect(end?.querySelector(".sidebar__lock")).not.toBeNull();
  });
});
