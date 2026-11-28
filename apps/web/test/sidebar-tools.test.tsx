import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError } from "@agenteschat/client";
import { act, cleanup, createEvent, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

type State = ReturnType<typeof seedState>;
const go = async (state: State = seedState()) => {
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(8);
  return state;
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
// The page behind an open dialog is hidden from roles: the sidebar by its element.
const nav = () => document.getElementById("app-nav") as HTMLElement;
/** The column's tiles (ADR 0260), by name: a tile says it in its label, before what its dot means. */
const rows = () =>
  [...nav().querySelectorAll(".sidebar__col > a.sidebar__tile")].map(
    (l) => l.getAttribute("aria-label")?.split(",")[0],
  );
/** The tools in the column, in order (More keeps the rest), under Início, which always heads it. */
const listed = () => rows().slice(1);
const openMore = async () => {
  await click(within(nav()).getByRole("button", { name: "Mais" }));
  return screen().getByRole("dialog", { name: "Mais" });
};
/** What More lists, each tool's name before its line on what it is for. */
const inMore = (more: HTMLElement) =>
  within(more)
    .getAllByRole("link")
    .map((l) => l.querySelector(".ac-menu__label")?.firstChild?.textContent);
const openSetup = async () => {
  await click(within(await openMore()).getByRole("button", { name: "Personalizar a barra lateral" }));
  return screen().getByRole("dialog", { name: "Personalizar a barra lateral" });
};
const choose = (dialog: HTMLElement, tool: string, place: string) =>
  click(within(within(dialog).getByRole("radiogroup", { name: tool })).getByRole("radio", { name: place }));
const chosen = (dialog: HTMLElement, tool: string) =>
  within(within(dialog).getByRole("radiogroup", { name: tool }))
    .getAllByRole("radio")
    .find((r) => r.getAttribute("aria-checked") === "true")?.textContent;
/** What each choice sent: the tool and its place (null: back on its default), or `{}` for Restaurar o padrão. */
const sent = (state: State) =>
  state.calls
    .filter((c) => c.method === "orgs.setSidebarItem" || c.method === "orgs.setSidebarItems")
    .map((c) => c.args.slice(1));
const noneWaiting = (over: Parameters<typeof seedState>[0] = {}) => {
  const state = seedState(over);
  for (const a of state.approvals) a.status = "approved";
  for (const p of state.proposals) p.status = "accepted";
  return state;
};

describe("the tools on top", () => {
  test("the tools are a column of tiles: each drags (a click on its grip opens nothing), Início stays first", async () => {
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const before = router.state.location.pathname;
    const column = within(nav()).getByRole("toolbar", { name: "Ferramentas" });
    expect(column.getAttribute("aria-orientation")).toBe("vertical");
    const tasks = within(column).getByRole("link", { name: /^Tarefas/ });
    expect(tasks.getAttribute("draggable")).toBe("true");
    const grip = tasks.querySelector(".sidebar__tool-grip") as HTMLElement;
    await click(grip);
    expect(router.state.location.pathname).toBe(before);
    const home = within(column).getByRole("link", { name: "Início" });
    expect(home.getAttribute("draggable")).toBeNull();
    // No grip of a part: a team's list keeps its fixed order (ADR 0260).
    expect(within(nav()).queryByRole("button", { name: /seção Ferramentas/ })).toBeNull();
  });

  test("a tile is named by its label, its tip on its right; collapsing keeps the column and hides the list", async () => {
    await go();
    const column = within(nav()).getByRole("toolbar", { name: "Ferramentas" });
    expect(column.getAttribute("data-tip-side")).toBe("right");
    const tile = within(column).getByRole("link", { name: /^Tarefas/ });
    expect(tile.querySelector(".sidebar__item-label")).toBeNull();
    expect(within(column).getByRole("button", { name: "Ir para…" }).getAttribute("aria-keyshortcuts")).toContain(
      "Control+K",
    );
    await click(within(nav()).getByRole("button", { name: "Minimizar barra lateral" }));
    expect(nav().getAttribute("data-rail")).toBe("true");
    expect(within(nav()).getByRole("toolbar", { name: "Ferramentas" })).toBeTruthy();
    await click(within(nav()).getByRole("button", { name: "Expandir barra lateral" }));
  });

  test("↑ and ↓ move between the column's tiles, Home and End to its ends", async () => {
    await go();
    const column = within(nav()).getByRole("toolbar", { name: "Ferramentas" });
    const search = within(column).getByRole("button", { name: "Ir para…" });
    search.focus();
    await act(async () => fireEvent.keyDown(search, { key: "ArrowDown" }));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Início");
    await act(async () => fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" }));
    expect(document.activeElement?.getAttribute("data-sidebar-toggle")).toBe("");
  });

  test("by default Tarefas, Drive and Equipe; the rest in More, then Personalizar; the inbox and Threads in neither", async () => {
    await go();
    expect(rows()[0]).toBe("Início");
    expect(rows()).not.toContain("Painéis");
    expect(listed()).toEqual(["Tarefas", "Drive", "Equipe"]);
    const more = await openMore();
    expect(inMore(more)).toEqual([
      "Melhorias dos agentes",
      "Wiki",
      "Rotinas",
      "Calendário",
      "Skills",
      "Painéis",
      "Gerenciador de tarefas",
    ]);
    expect(
      within(more)
        .getByRole("link", { name: /Painéis/ })
        .getAttribute("href"),
    ).toBe(`/org/${ORG_ID}/dashboards`);
    expect(
      within(more)
        .getByRole("link", { name: /Gerenciador de tarefas/ })
        .getAttribute("href"),
    ).toBe(`/org/${ORG_ID}/task-manager`);
    expect(within(more).getByRole("button", { name: "Personalizar a barra lateral" })).toBeTruthy();
    cleanup();
    // Não lidas and Threads are the list's first rows (ADR 0260), whatever waits.
    await go(noneWaiting());
    expect(listed()).toEqual(["Tarefas", "Drive", "Equipe"]);
  });

  test("Personalizar: each choice moves the tool at once and is saved for me; Restaurar o padrão undoes them", async () => {
    const state = await go(noneWaiting());
    const dialog = await openSetup();
    expect(chosen(dialog, "Wiki")).toBe("Em Mais");
    // The inbox and Threads aren't the column's: Não lidas and Threads head the list (ADR 0260).
    expect(within(dialog).queryByRole("radiogroup", { name: "Caixa de entrada" })).toBeNull();
    expect(within(dialog).queryByRole("radiogroup", { name: "Threads" })).toBeNull();
    const offered = (tool: string) =>
      within(within(dialog).getByRole("radiogroup", { name: tool }))
        .getAllByRole("radio")
        .map((r) => r.textContent);
    // Approvals is no longer a tool (ADR 0218): the inbox lists them.
    expect(within(dialog).queryByRole("radiogroup", { name: "Aprovações" })).toBeNull();
    expect(offered("Wiki")).toEqual(["Sempre", "Em Mais"]);
    const reset = within(dialog).getByRole("button", { name: "Restaurar o padrão" }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);

    await choose(dialog, "Wiki", "Sempre");
    expect(listed()).toEqual(["Tarefas", "Wiki", "Drive", "Equipe"]);
    await choose(dialog, "Drive", "Em Mais");
    await choose(dialog, "Melhorias dos agentes", "Sempre");
    expect(listed()).toEqual(["Melhorias dos agentes", "Tarefas", "Wiki", "Equipe"]);
    // One tool each time: what another device chose meanwhile stays.
    expect(sent(state)).toEqual([
      ["wiki", "always"],
      ["drive", "more"],
      ["proposals", "always"],
    ]);
    expect(state.sidebarItems).toEqual({ wiki: "always", drive: "more", proposals: "always" });
    // Back on its default: the tool leaves the saved choices.
    await choose(dialog, "Drive", "Sempre");
    expect(sent(state).at(-1)).toEqual(["drive", null]);
    expect(state.sidebarItems).toEqual({ wiki: "always", proposals: "always" });

    expect(reset.disabled).toBe(false);
    await click(reset);
    expect(listed()).toEqual(["Tarefas", "Drive", "Equipe"]);
    expect(sent(state).at(-1)).toEqual([{}]);
    expect(chosen(dialog, "Wiki")).toBe("Em Mais");
  });

  test("another device moved a tool after this one loaded: Personalizar shows it, and a choice here keeps it", async () => {
    const state = await go(noneWaiting());
    state.sidebarItems = { wiki: "always" };
    const dialog = await openSetup();
    expect(chosen(dialog, "Wiki")).toBe("Sempre");
    expect(listed()).toEqual(["Tarefas", "Wiki", "Drive", "Equipe"]);
    await choose(dialog, "Drive", "Em Mais");
    expect(state.sidebarItems).toEqual({ wiki: "always", drive: "more" });
    expect(listed()).toEqual(["Tarefas", "Wiki", "Equipe"]);
  });

  test("Painéis and the task manager are tools like the rest: Sempre brings them into the list, each line one row", async () => {
    const state = await go(noneWaiting());
    const dialog = await openSetup();
    expect([...dialog.querySelectorAll(".sidebar-setup__name")].map((n) => n.textContent)).toEqual(
      expect.arrayContaining(["Painéis", "Gerenciador de tarefas"]),
    );
    expect(chosen(dialog, "Gerenciador de tarefas")).toBe("Em Mais");
    await choose(dialog, "Gerenciador de tarefas", "Sempre");
    await choose(dialog, "Painéis", "Sempre");
    expect(sent(state)).toContainEqual(["taskManager", "always"]);
    expect(sent(state)).toContainEqual(["dashboards", "always"]);
    expect(listed()).toEqual(expect.arrayContaining(["Painéis", "Gerenciador de tarefas"]));
    expect(dialog.querySelector(".ac-dialog__foot-note")).toBeNull();
  });

  test("Código only where it has anything for me (an agent that programs, or a session of mine), or where I put it", async () => {
    const setupNames = (dialog: HTMLElement) =>
      [...dialog.querySelectorAll(".sidebar-setup__name")].map((n) => n.textContent);
    await go(noneWaiting());
    expect(inMore(await openMore())).not.toContain("Código");
    cleanup();
    await go(noneWaiting());
    expect(setupNames(await openSetup())).not.toContain("Código");
    cleanup();

    const coding = noneWaiting();
    coding.codeWork = true;
    await go(coding);
    const more = await openMore();
    expect(inMore(more)).toContain("Código");
    expect(
      within(more)
        .getByRole("link", { name: /Código/ })
        .getAttribute("href"),
    ).toBe(`/org/${ORG_ID}/code`);
    cleanup();
    await go(coding);
    expect(setupNames(await openSetup())).toContain("Código");
    cleanup();

    // Put in the list by the person: it stays there, whatever the workspace has.
    const pinned = noneWaiting();
    pinned.sidebarItems = { code: "always" };
    await go(pinned);
    expect(listed()).toContain("Código");
  });

  test("the choices couldn't be read: a choice here moves only its tool, and the server's answer shows the rest", async () => {
    const state = noneWaiting();
    state.sidebarItems = { wiki: "always", routines: "always" };
    const api = createFakeApi(state);
    api.orgs.sidebarItems = async () => {
      throw new ApiError(500, "internal", "Não deu");
    };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const dialog = await openSetup();
    expect(chosen(dialog, "Wiki")).toBe("Em Mais");
    await choose(dialog, "Drive", "Em Mais");
    expect(state.sidebarItems).toEqual({ wiki: "always", routines: "always", drive: "more" });
    expect(chosen(dialog, "Wiki")).toBe("Sempre");
    expect(listed()).toEqual(["Tarefas", "Wiki", "Rotinas", "Equipe"]);
  });

  test("proposals add nothing to Não lidas' count, and their tile has none: it can't wait for something (ADR 0219)", async () => {
    const waiting = () => {
      const state = noneWaiting();
      for (const p of state.proposals) Object.assign(p, { status: "pending", canDecide: true });
      return state;
    };
    await go(waiting());
    const row = (name: string) =>
      [...nav().querySelectorAll(".sidebar__col > a.sidebar__tile")].find(
        (a) => a.getAttribute("aria-label")?.split(",")[0] === name,
      );
    expect(listed()).toEqual(["Tarefas", "Drive", "Equipe"]);
    expect(
      within(nav())
        .getByRole("link", { name: /^Não lidas/ })
        .querySelector(".ac-count"),
    ).toBeNull();
    const dialog = await openSetup();
    const offered = within(within(dialog).getByRole("radiogroup", { name: "Melhorias dos agentes" }))
      .getAllByRole("radio")
      .map((r) => r.textContent);
    expect(offered).toEqual(["Sempre", "Em Mais"]);
    cleanup();
    // In the list when a person puts it there: the history, with no count.
    await go({ ...waiting(), sidebarItems: { proposals: "always" } });
    expect(listed()).toEqual(["Melhorias dos agentes", "Tarefas", "Drive", "Equipe"]);
    expect(row("Melhorias dos agentes")?.getAttribute("data-dot")).toBeNull();
    expect(row("Melhorias dos agentes")?.getAttribute("href")).toBe(`/org/${ORG_ID}/proposals`);
  });

  test("the choices are the server's: the same sidebar on every device", async () => {
    await go(seedState({ sidebarItems: { drive: "more", routines: "always", waiting: "more" } }));
    expect(listed()).toEqual(["Tarefas", "Rotinas", "Equipe"]);
    expect(inMore(await openMore())).toEqual([
      "Melhorias dos agentes",
      "Wiki",
      "Drive",
      "Calendário",
      "Skills",
      "Painéis",
      "Gerenciador de tarefas",
    ]);
  });

  test("the server refuses: the tool goes back where it was", async () => {
    const state = seedState();
    state.sidebarItemsError = new ApiError(500, "internal", "Não deu");
    await go(state);
    const dialog = await openSetup();
    await choose(dialog, "Wiki", "Sempre");
    await settle(3);
    expect(listed()).toEqual(["Tarefas", "Drive", "Equipe"]);
    expect(chosen(dialog, "Wiki")).toBe("Em Mais");
  });

  test("two choices in a row, both refused: the sidebar ends as the server keeps it", async () => {
    const state = seedState();
    state.sidebarItemsError = new ApiError(500, "internal", "Não deu");
    const api = createFakeApi(state);
    const refuse = api.orgs.setSidebarItem;
    let release = () => {};
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    api.orgs.setSidebarItem = async (orgId, item, place) => {
      if (calls++ === 0) await first;
      return refuse(orgId, item, place);
    };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const dialog = await openSetup();
    await choose(dialog, "Wiki", "Sempre");
    // The second waits for the first, and shows at once.
    await choose(dialog, "Drive", "Em Mais");
    expect(listed()).toEqual(["Tarefas", "Wiki", "Equipe"]);
    await act(async () => release());
    await settle(6);
    expect(calls).toBe(2);
    expect(listed()).toEqual(["Tarefas", "Drive", "Equipe"]);
    expect(chosen(dialog, "Wiki")).toBe("Em Mais");
  });

  describe("one by one, in my order", () => {
    const toolOrder = (state: State) =>
      state.calls.filter((c) => c.method === "orgs.setSidebarToolOrder").map((c) => c.args[1]);
    const tool = (name: string) =>
      [...nav().querySelectorAll(".sidebar__col > a.sidebar__tile")].find(
        (a) => a.getAttribute("aria-label")?.split(",")[0] === name,
      ) as HTMLElement;
    const dataTransfer = { setData: () => {}, getData: () => "", effectAllowed: "", dropEffect: "" };

    test("the server's order: the same list on every device", async () => {
      await go(
        seedState({
          sidebarToolOrder: ["drive", "issues", "waiting", "threads", "wiki", "routines", "calendar"],
        }),
      );
      expect(listed()).toEqual(["Drive", "Tarefas", "Equipe"]);
    });

    test("Alt+Shift+↑/↓ moves a tool past its neighbour in the list, over the ones in More, and saves it", async () => {
      const state = await go(seedState({ sidebarItems: { wiki: "more" } }));
      expect(listed()).toEqual(["Tarefas", "Drive", "Equipe"]);
      await act(async () => fireEvent.keyDown(tool("Drive"), { key: "ArrowUp", altKey: true, shiftKey: true }));
      await settle(3);
      // Wiki waits in More between Tarefas and Drive: one press is one step in the column.
      expect(listed()).toEqual(["Drive", "Tarefas", "Equipe"]);
      expect(toolOrder(state)).toEqual([
        [
          "waiting",
          "proposals",
          "threads",
          "drive",
          "issues",
          "wiki",
          "routines",
          "calendar",
          "team",
          "skills",
          "dashboards",
          "code",
          "taskManager",
        ],
      ]);
      expect(tool("Drive").getAttribute("aria-keyshortcuts")).toBe("Alt+Shift+ArrowUp Alt+Shift+ArrowDown");
      // At the top, up does nothing; an arrow alone moves the focus in the column.
      await act(async () => fireEvent.keyDown(tool("Drive"), { key: "ArrowUp", altKey: true, shiftKey: true }));
      await act(async () => fireEvent.keyDown(tool("Tarefas"), { key: "ArrowDown" }));
      await settle(3);
      expect(toolOrder(state)).toHaveLength(1);
    });

    test("a tool dragged onto another goes before or after it, and saves it", async () => {
      const state = await go();
      await act(async () => fireEvent.dragStart(tool("Drive"), { dataTransfer }));
      const over = createEvent.dragOver(tool("Tarefas"), { dataTransfer });
      // happy-dom's DragEvent is a plain Event: no clientY from the init (a 0-tall box: 0 is its top half).
      Object.defineProperty(over, "clientY", { value: 0 });
      await act(async () => fireEvent(tool("Tarefas"), over));
      expect(tool("Tarefas").getAttribute("data-drop")).toBe("before");
      await act(async () => fireEvent.drop(tool("Tarefas"), { dataTransfer }));
      await settle(3);
      expect(listed()).toEqual(["Drive", "Tarefas", "Equipe"]);
      expect(tool("Tarefas").getAttribute("data-drop")).toBeNull();

      await act(async () => fireEvent.keyDown(tool("Drive"), { key: "ArrowDown", altKey: true, shiftKey: true }));
      await settle(3);
      expect(listed()).toEqual(["Tarefas", "Drive", "Equipe"]);
      // Moved down, its node is re-inserted: the focus comes back to it.
      expect(document.activeElement === tool("Drive")).toBe(true);
      // Wiki stays where the steps left it, in More: the order is Drive's own spot now, not the default's.
      expect(toolOrder(state).at(-1)).toEqual([
        "waiting",
        "proposals",
        "threads",
        "issues",
        "drive",
        "wiki",
        "routines",
        "calendar",
        "team",
        "skills",
        "dashboards",
        "code",
        "taskManager",
      ]);
    });

    test("Personalizar lists the tools in my order, with Mover para cima / para baixo; Restaurar o padrão resets it", async () => {
      const state = await go(noneWaiting());
      const dialog = await openSetup();
      const names = () =>
        [...dialog.querySelectorAll(".sidebar-setup__row .sidebar-setup__name")].map((n) => n.textContent);
      expect(names().slice(0, 3)).toEqual(["Melhorias dos agentes", "Tarefas", "Wiki"]);
      expect(
        (within(dialog).getByRole("button", { name: "Mover para cima: Melhorias dos agentes" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      await click(within(dialog).getByRole("button", { name: "Mover para cima: Drive" }));
      await click(within(dialog).getByRole("button", { name: "Mover para cima: Drive" }));
      expect(names().slice(0, 4)).toEqual(["Melhorias dos agentes", "Drive", "Tarefas", "Wiki"]);
      // At the top its up arrow turns off: the focus goes to the row's down arrow, not out of the dialog.
      for (let i = 0; i < 2; i++) await click(within(dialog).getByRole("button", { name: "Mover para cima: Drive" }));
      expect(document.activeElement === within(dialog).getByRole("button", { name: "Mover para baixo: Drive" })).toBe(
        true,
      );
      await click(within(dialog).getByRole("button", { name: "Mover para baixo: Drive" }));
      expect(listed()).toEqual(["Drive", "Tarefas", "Equipe"]);
      const reset = within(dialog).getByRole("button", { name: "Restaurar o padrão" }) as HTMLButtonElement;
      expect(reset.disabled).toBe(false);
      await click(reset);
      expect(listed()).toEqual(["Tarefas", "Drive", "Equipe"]);
      expect(toolOrder(state).at(-1)).toBeNull();
      expect(state.sidebarToolOrder).toBeUndefined();
    });
  });
});

describe("the sidebar's parts", () => {
  test("the fixed order, each part in a block of its own; sectors show nowhere in the list (ADR 0260)", async () => {
    const state = seedState();
    const engineering = "00000000-0000-4000-8000-0000000000f1";
    state.agentGroups = [...(state.agentGroups ?? []), { id: engineering, name: "Engenharia", agentIds: [] }];
    for (const c of state.channels) if (c.id === ENG_ID) c.groupId = engineering;
    await go(state);
    const blocks = [...nav().querySelectorAll(".sidebar__scroll > .sidebar__block")].map((b) =>
      b.getAttribute("data-section"),
    );
    // No Favoritos until there is one: Walter made no agent of his own to start it with.
    expect(blocks).toEqual(["tools", "channels", "people"]);
    expect(within(nav()).queryByRole("button", { name: "Engenharia" })).toBeNull();
    expect(within(nav()).queryByRole("button", { name: "Agentes" })).toBeNull();
    // #eng, in a sector, is one of Canais' channels.
    const canais = within(nav()).getByRole("button", { name: "Canais" }).closest(".sidebar__section") as HTMLElement;
    expect(within(canais).getByRole("link", { name: /eng/ })).toBeTruthy();
    expect(nav().querySelector(".ac-rolemark")).toBeNull();
  });
});
