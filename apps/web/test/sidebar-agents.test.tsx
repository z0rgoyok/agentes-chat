import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, createEvent, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/**
 * A team's list (ADR 0260): the agents that talk to me sit in Mensagens diretas with the people, one line each; Favoritos
 * holds people, agents and channels by name, in my order; Canais has my own sections, made by dragging a channel onto
 * another, or from a channel's menu.
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const sheet of document.querySelectorAll("style[data-layout]")) sheet.remove();
});

type State = ReturnType<typeof seedState>;
const asMember = (state: State) => {
  if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
  return state;
};
const go = async (state: State = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const nav = () => screen().getByRole("navigation", { name: "Navegação do workspace" });
const head = (name: string) =>
  within(nav()).getByRole("button", { name }).closest(".sidebar__section-head") as HTMLElement;
const section = (name: string) => head(name).closest(".sidebar__section") as HTMLElement;
const rowsIn = (el: HTMLElement) =>
  [...el.querySelectorAll("[data-agent-row] .sidebar__item-label")].map((l) => l.textContent);
/** Every row's name in a part, people, agents and channels. */
const namesIn = (el: HTMLElement) =>
  [...el.querySelectorAll("a.sidebar__item .sidebar__item-label")].map((l) => l.textContent);
const channel = (name: string) => nav().querySelector(`a.sidebar__item[title="#${name}"]`) as HTMLElement;
const viewWith = (state: State, over: Partial<NonNullable<State["sidebarView"]>>) => {
  state.sidebarView = { agentSort: "workspace", showAllAgents: false, pins: null, ...over };
  return state;
};
const dataTransfer = () => {
  const data = new Map<string, string>();
  return {
    setData: (k: string, v: string) => data.set(k, v),
    getData: (k: string) => data.get(k) ?? "",
    effectAllowed: "",
    dropEffect: "",
  };
};
/** Drags `from` onto `to`, over its top half (happy-dom lays nothing out: a 0-tall box, 0 is its top). */
const drag = async (from: HTMLElement, to: HTMLElement) => {
  const dt = dataTransfer();
  await act(async () => fireEvent.dragStart(from, { dataTransfer: dt }));
  const over = createEvent.dragOver(to, { dataTransfer: dt });
  Object.defineProperty(over, "clientY", { value: 0 });
  await act(async () => fireEvent(to, over));
  await act(async () => fireEvent.drop(to, { dataTransfer: dt }));
  await settle(4);
};
const RANDOM = "00000000-0000-4000-8000-0000000000c9";
const SEO = "00000000-0000-4000-8000-0000000000ca";
const withChannels = (state: State = seedState()) => {
  for (const [id, name] of [
    [RANDOM, "random"],
    [SEO, "seo"],
  ] as const)
    state.channels.push({
      id,
      name,
      topic: "",
      visibility: "public",
      isMember: true,
      createdAt: new Date().toISOString(),
    });
  return state;
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const items = () =>
  within(screen().getByRole("menu", { name: "Ações" }))
    .getAllByRole("menuitem")
    .map((i) => i.textContent);
const rightClick = async (el: Element) => {
  await act(async () => void el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  await settle(2);
};
const pick = (name: string) =>
  click(within(screen().getByRole("menu", { name: "Ações" })).getByRole("menuitem", { name }));
const openMenu = async (label: string) => {
  const button = within(nav()).getByRole("button", { name: label });
  await act(async () => {
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyUp(button, { key: "Enter" });
  });
  await settle(2);
  return screen().getByRole("menu", { name: label });
};
const views = (state: State) => state.calls.filter((c) => c.method === "orgs.setSidebarView").map((c) => c.args[1]);
const withLayout = async () => {
  const sheet = document.createElement("style");
  sheet.dataset.layout = "";
  sheet.textContent = await Bun.file(join(import.meta.dir, "../src/layout.css")).text();
  document.head.append(sheet);
};
const shown = (el: Element) => {
  for (let e: Element | null = el; e; e = e.parentElement)
    if (window.getComputedStyle(e).display === "none") return false;
  return true;
};

describe("agents in Mensagens diretas", () => {
  test("an agent at work shows it in its face alone: the orbit, no light behind its row (ADR 0260 §7)", async () => {
    const state = seedState();
    seedDm(state, { type: "agent", id: ATLAS_ID }, { ago: 1, unread: 2 });
    const r = await go(state);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await act(async () =>
      socket.push({
        type: "event",
        channelId: GENERAL_ID,
        event: {
          channelId: GENERAL_ID,
          type: "agent.run",
          threadId: null,
          runId: "r-1",
          agentId: ATLAS_ID,
          status: "running",
        },
      }),
    );
    await settle(4);
    const atlas = nav().querySelector(`[data-agent-row="${ATLAS_ID}"]`) as HTMLElement;
    expect(atlas.querySelector(".ac-orbit > .ac-avatar")).not.toBeNull();
    expect(atlas.querySelector(".ac-visually-hidden")?.textContent).toBe("trabalhando em #general");
    expect(atlas.querySelector(".sidebar__trail, .sidebar__glow, .sidebar__busy")).toBeNull();
    expect((atlas.querySelector("a.sidebar__item") as HTMLElement).getAttribute("style")).toBeNull();
    // One line: its name and the quiet tag, no role under it (the role is in its title).
    expect(atlas.querySelector(".sidebar__item-role")).toBeNull();
    expect(atlas.querySelector(".sidebar__kind")?.textContent).toBe("IA");
    expect(atlas.querySelector("a")?.getAttribute("title")).toContain("Ops");
  });

  test("an owner lists the agents that don't talk to them from the part's ⋯; a member has no such choice", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.audience = { mode: "owner", userIds: [] };
    await go(state);
    expect(rowsIn(section("Mensagens diretas"))).toEqual(["Atlas"]);
    expect(within(nav()).getByRole("link", { name: "Mais 1 agente na Equipe" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/team`,
    );
    const menu = await openMenu("Opções de Mensagens diretas");
    await click(within(menu).getByRole("menuitemcheckbox", { name: "Mostrar agentes que não falam comigo" }));
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);
    expect(rowsIn(section("Mensagens diretas"))).toEqual(["Ada", "Atlas"]);
    expect(views(state).at(-1)).toMatchObject({ showAllAgents: true });
    cleanup();
    await go(asMember(seedState()));
    const theirs = await openMenu("Opções de Mensagens diretas");
    expect(within(theirs).queryByRole("menuitemcheckbox")).toBeNull();
  });

  test("Só conversas recentes keeps who I talked to, saved for me; Todos do workspace brings everyone back", async () => {
    const state = seedState();
    seedDm(state, { type: "agent", id: ADA_ID }, { ago: 5 });
    await go(state);
    expect(namesIn(section("Mensagens diretas"))).toEqual(["Ada", "Atlas", "João"]);
    const menu = await openMenu("Opções de Mensagens diretas");
    await click(within(menu).getByRole("menuitemradio", { name: "Só conversas recentes" }));
    expect(namesIn(section("Mensagens diretas"))).toEqual(["Ada"]);
    expect(views(state).at(-1)).toMatchObject({ dms: "recent" });
  });

  test("an invitation not accepted yet shows its address with Convite enviado, for who invites", async () => {
    const state = seedState();
    state.invitations = [
      {
        id: "inv-1",
        email: "paulo@example.com",
        role: "member",
        status: "pending",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      } as State["invitations"][number],
    ];
    await go(state);
    const invite = within(section("Mensagens diretas")).getByRole("link", { name: /paulo@example.com/ });
    expect(invite.querySelector(".sidebar__kind")?.textContent).toBe("Convite enviado");
    cleanup();
    await go(asMember(state));
    expect(within(section("Mensagens diretas")).queryByRole("link", { name: /paulo@example.com/ })).toBeNull();
  });
});

describe("Favoritos", () => {
  test("day one: my own agents, by name, and out of Mensagens diretas", async () => {
    const state = seedState();
    const atlas = state.agents.find((a) => a.id === ATLAS_ID);
    if (atlas) atlas.ownerUserId = "u-walter";
    await go(state);
    expect(namesIn(section("Favoritos"))).toEqual(["Atlas"]);
    expect(rowsIn(section("Mensagens diretas"))).toEqual(["Ada"]);
    expect(views(state)).toEqual([]);
  });

  test("the pins of before become Favoritos: the agents, the people, then the channels, each in their order", async () => {
    await go(viewWith(seedState(), { pins: { agents: [ATLAS_ID], channels: [ENG_ID], people: ["u-joao"] } }));
    expect(namesIn(section("Favoritos"))).toEqual(["Atlas", "João", "eng"]);
    expect(within(section("Canais")).queryByRole("link", { name: /^eng/ })).toBeNull();
    expect(namesIn(section("Mensagens diretas"))).toEqual(["Ada"]);
  });

  test("Adicionar aos favoritos from a row's menu puts it at Favoritos' end; Tirar dos favoritos takes it back", async () => {
    const { state } = await go(viewWith(seedState(), { favorites: [`agent:${ATLAS_ID}`] }));
    await rightClick(channel("eng"));
    await pick("Adicionar aos favoritos");
    expect(namesIn(section("Favoritos"))).toEqual(["Atlas", "eng"]);
    expect(views(state).at(-1)).toMatchObject({ favorites: [`agent:${ATLAS_ID}`, `channel:${ENG_ID}`] });
    await rightClick(within(section("Mensagens diretas")).getByRole("link", { name: /João/ }));
    await pick("Adicionar aos favoritos");
    expect(namesIn(section("Favoritos"))).toEqual(["Atlas", "eng", "João"]);
    await rightClick(channel("eng"));
    await pick("Tirar dos favoritos");
    expect(namesIn(section("Favoritos"))).toEqual(["Atlas", "João"]);
    expect(within(section("Canais")).getByRole("link", { name: /^eng/ })).toBeTruthy();
  });

  test("Alt+Shift+↑/↓ and dragging reorder them, saved for me", async () => {
    const { state } = await go(
      viewWith(seedState(), { favorites: [`agent:${ATLAS_ID}`, `person:u-joao`, `channel:${ENG_ID}`] }),
    );
    await act(async () => fireEvent.keyDown(channel("eng"), { key: "ArrowUp", altKey: true, shiftKey: true }));
    await settle(3);
    expect(namesIn(section("Favoritos"))).toEqual(["Atlas", "eng", "João"]);
    expect(channel("eng").getAttribute("aria-keyshortcuts")).toBe("Alt+Shift+ArrowUp Alt+Shift+ArrowDown");
    const joao = within(section("Favoritos")).getByRole("link", { name: /João/ });
    const atlas = within(section("Favoritos")).getByRole("link", { name: /^Atlas/ });
    await drag(joao, atlas);
    expect(namesIn(section("Favoritos"))).toEqual(["João", "Atlas", "eng"]);
    expect(views(state).at(-1)).toMatchObject({
      favorites: ["person:u-joao", `agent:${ATLAS_ID}`, `channel:${ENG_ID}`],
    });
  });

  test("a favorite of something gone holds no place; Favoritos full says so and adds nothing", async () => {
    const gone = Array.from(
      { length: 50 },
      (_, i) => `agent:00000000-0000-4000-8000-0000000${String(i).padStart(5, "0")}`,
    );
    const { state } = await go(viewWith(seedState(), { favorites: gone.slice(0, 49).concat([`agent:${ATLAS_ID}`]) }));
    expect(namesIn(section("Favoritos"))).toEqual(["Atlas"]);
    await rightClick(channel("eng"));
    await pick("Adicionar aos favoritos");
    expect(namesIn(section("Favoritos"))).toEqual(["Atlas", "eng"]);
    expect(views(state)).toHaveLength(1);
  });
});

describe("my own sections in Canais", () => {
  const sectionNames = () =>
    [...nav().querySelectorAll(".sidebar__section--category .sidebar__section-toggle")].map((b) => b.textContent);

  test("a channel dragged onto one in no section makes a section of both, its name field open; Enter names it", async () => {
    const { state } = await go(withChannels());
    expect(sectionNames()).toEqual([]);
    await drag(channel("seo"), channel("random"));
    const field = within(nav()).getByRole("textbox", { name: "Nome da seção" }) as HTMLInputElement;
    expect(field.value).toBe("Nova seção");
    expect(document.activeElement === field).toBe(true);
    await act(async () => {
      fireEvent.change(field, { target: { value: "Marketing" } });
      fireEvent.keyDown(field, { key: "Enter" });
    });
    await settle(3);
    expect(sectionNames()).toEqual(["Marketing"]);
    expect(namesIn(section("Marketing"))).toEqual(["random", "seo"]);
    expect(within(section("Canais")).queryByRole("link", { name: /^seo/ })).toBeNull();
    const saved = views(state).at(-1) as { sections: { name: string; channelIds: string[] }[] };
    expect(saved.sections.map((x) => [x.name, x.channelIds])).toEqual([["Marketing", [RANDOM, SEO]]]);
  });

  test("the keyboard's way: Mover para a seção, Nova seção, Alt+Shift+↑/↓, and Tirar da seção; an empty one goes", async () => {
    const { state } = await go(
      viewWith(withChannels(), { sections: [{ id: "s1", name: "Marketing", channelIds: [RANDOM, SEO] }] }),
    );
    await rightClick(channel("eng"));
    expect(items()).toEqual(expect.arrayContaining(["Marketing", "Nova seção"]));
    await pick("Marketing");
    expect(namesIn(section("Marketing"))).toEqual(["random", "seo", "eng"]);
    await act(async () => fireEvent.keyDown(channel("eng"), { key: "ArrowUp", altKey: true, shiftKey: true }));
    await settle(3);
    expect(namesIn(section("Marketing"))).toEqual(["random", "eng", "seo"]);
    for (const name of ["random", "eng", "seo"]) {
      await rightClick(channel(name));
      await pick("Tirar da seção");
    }
    expect(sectionNames()).toEqual([]);
    expect(views(state).at(-1)).toMatchObject({ sections: [] });
  });

  test("a section's menu renames, moves and deletes it; its channels go back to Canais", async () => {
    await go(
      viewWith(withChannels(), {
        sections: [
          { id: "s1", name: "Marketing", channelIds: [SEO] },
          { id: "s2", name: "Plataforma", channelIds: [ENG_ID] },
        ],
      }),
    );
    await rightClick(head("Plataforma"));
    await pick("Mover para cima");
    expect(sectionNames()).toEqual(["Plataforma", "Marketing"]);
    await act(async () =>
      fireEvent.keyDown(within(nav()).getByRole("button", { name: "Plataforma" }), {
        key: "ArrowDown",
        altKey: true,
        shiftKey: true,
      }),
    );
    await settle(3);
    expect(sectionNames()).toEqual(["Marketing", "Plataforma"]);
    await rightClick(head("Marketing"));
    await pick("Renomear seção");
    const field = within(nav()).getByRole("textbox", { name: "Nome da seção" });
    await act(async () => {
      fireEvent.change(field, { target: { value: "Go-to-market" } });
      fireEvent.blur(field);
    });
    await settle(3);
    expect(sectionNames()).toEqual(["Go-to-market", "Plataforma"]);
    await rightClick(head("Go-to-market"));
    await pick("Excluir seção");
    expect(sectionNames()).toEqual(["Plataforma"]);
    expect(within(section("Canais")).getByRole("link", { name: /^seo/ })).toBeTruthy();
  });

  test("closed, a section keeps its unread channels in sight and counts its mentions", async () => {
    await withLayout();
    const state = viewWith(withChannels(), { sections: [{ id: "s1", name: "Marketing", channelIds: [RANDOM, SEO] }] });
    for (const c of state.channels) if (c.id === SEO) Object.assign(c, { unreadCount: 3, mentionCount: 1 });
    await go(state);
    await click(within(nav()).getByRole("button", { name: "Marketing" }));
    expect(shown(channel("seo"))).toBe(true);
    expect(shown(channel("random"))).toBe(false);
    expect(within(head("Marketing")).getByRole("img", { name: "1 menção a você" })).toBeTruthy();
  });
});

describe("the worst case (break-ui, measured by CI's geometry step)", () => {
  test("long names, a long section, a long invited address, 99+ counts: one line each, the tag and count kept", async () => {
    const state = withChannels();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.name = "Assistente de Atendimento ao Cliente Internacional";
    const joao = state.members.find((m) => m.userId === "u-joao");
    if (joao) joao.name = "Maria Eduarda Albuquerque de Vasconcelos Figueiredo";
    for (const c of state.channels)
      if (c.id === SEO)
        Object.assign(c, { name: "planejamento-estrategico-de-conteudo-2027", unreadCount: 140, mentionCount: 120 });
    seedDm(state, { type: "person", id: "u-joao" }, { ago: 1, unread: 250 });
    state.invitations = [
      {
        id: "inv-1",
        email: "pessoa.com.um.endereco.muito.longo.para.quebrar.a.linha@example.com",
        role: "member",
        status: "pending",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      } as State["invitations"][number],
    ];
    viewWith(state, {
      favorites: [`agent:${ADA_ID}`],
      sections: [{ id: "s1", name: "Lançamento da versão três com parceiros", channelIds: [SEO, RANDOM] }],
    });
    await go(state);
    const joaoRow = within(section("Mensagens diretas")).getByRole("link", { name: /Maria Eduarda/ });
    expect(joaoRow.querySelector(".sidebar__unread")?.textContent).toBe("99+");
    const adaRow = within(section("Favoritos")).getByRole("link", { name: /^Assistente/ });
    expect(adaRow.querySelector(".sidebar__kind")?.textContent).toBe("IA");
    expect(channel("planejamento-estrategico-de-conteudo-2027").querySelector(".sidebar__unread")?.textContent).toBe(
      "99+",
    );
    expect(head("Lançamento da versão três com parceiros")).toBeTruthy();
  });
});
