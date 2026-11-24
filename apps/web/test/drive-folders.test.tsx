import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import {
  DRIVE_DRAG_TYPE,
  folderAndInside,
  folderOutline,
  folderTrail,
  parseDriveDrag,
} from "@agenteschat/client/lib/drive";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(cleanup);
beforeEach(() => localStorage.removeItem("agentes.drive.view"));

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const names = () => Array.from(document.querySelectorAll(".drive-card .drive-hit")).map((b) => b.textContent);
const folderNames = () => Array.from(document.querySelectorAll(".drive-folder .drive-hit")).map((b) => b.textContent);

async function goDrive(path = "") {
  const api = createFakeApi(seedState(), { seed: true });
  const r = await renderApp(`/org/${ORG_ID}/drive${path}`, { api });
  await settle(8);
  return { ...r, api };
}

/** A folder made through "New" › "New folder". */
async function newFolder(name: string) {
  const trigger = screen().getByRole("button", { name: "Novo" });
  trigger.focus();
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyUp(trigger, { key: "Enter" });
  });
  await settle(2);
  await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Nova pasta" }));
  const dialog = screen().getByRole("dialog");
  await type(within(dialog).getByRole("textbox", { name: "Nome" }), name);
  await click(within(dialog).getByRole("button", { name: "Criar" }));
  await settle(6);
}

/** What a drag of Drive items hands a drop. */
const carrying = (drag: { files: string[]; folders: string[] }) => ({
  dataTransfer: { types: [DRIVE_DRAG_TYPE], getData: () => JSON.stringify(drag), dropEffect: "" },
});

describe("Drive folders", () => {
  test("make a folder, move a file into it, open it, its path, back up, and an empty folder says so", async () => {
    const { api } = await goDrive();
    await newFolder("Relatórios");
    expect(folderNames()).toEqual(["Relatórios"]);
    expect(screen().getByRole("region", { name: "Pastas" })).toBeTruthy();

    // Select a file, then "Mover" in the selection bar.
    const first = names()[0] ?? "";
    await click(screen().getByRole("checkbox", { name: `Selecionar ${first}` }));
    await click(screen().getByRole("button", { name: "Mover" }));
    const dialog = screen().getByRole("dialog", { name: "Mover 1 item" });
    await click(within(dialog).getByRole("radio", { name: /Relatórios/ }));
    await click(within(dialog).getByRole("button", { name: "Mover para Relatórios" }));
    await settle(6);
    expect(names()).not.toContain(first);

    await click(screen().getByRole("button", { name: "Relatórios" }));
    await settle(6);
    expect(screen().getByRole("heading", { level: 1, name: "Relatórios" })).toBeTruthy();
    const path = screen().getByRole("navigation", { name: "Caminho da pasta" });
    expect(path.textContent).toBe("DriveRelatórios");
    expect(names()).toEqual([first]);

    // Dropped on "Drive" in the path, it goes back to the top level, and the folder is empty.
    const [file] = await api.artifacts.list(ORG_ID, { q: first });
    await act(async () => {
      const crumb = within(path).getByRole("button", { name: "Drive" });
      const drag = carrying({ files: [file?.id ?? ""], folders: [] });
      fireEvent.dragEnter(crumb, drag);
      fireEvent.dragOver(crumb, drag);
      fireEvent.drop(crumb, drag);
    });
    await settle(6);
    expect(screen().getByText("Esta pasta está vazia")).toBeTruthy();

    await click(screen().getByRole("button", { name: "Subir um nível" }));
    await settle(6);
    expect(screen().getByRole("heading", { level: 1, name: "Drive" })).toBeTruthy();
    expect(names()).toContain(first);
  });

  test("rename a folder and delete it with what's inside", async () => {
    await goDrive();
    await newFolder("Rascunhos");
    const more = screen().getByRole("button", { name: "Mais ações de Rascunhos" });
    more.focus();
    await act(async () => {
      fireEvent.keyDown(more, { key: "Enter" });
      fireEvent.keyUp(more, { key: "Enter" });
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Renomear" }));
    const dialog = screen().getByRole("dialog", { name: "Renomear pasta" });
    await type(within(dialog).getByRole("textbox", { name: "Nome" }), "Arquivo morto");
    await click(within(dialog).getByRole("button", { name: "Renomear" }));
    await settle(6);
    expect(folderNames()).toEqual(["Arquivo morto"]);

    const again = screen().getByRole("button", { name: "Mais ações de Arquivo morto" });
    again.focus();
    await act(async () => {
      fireEvent.keyDown(again, { key: "Enter" });
      fireEvent.keyUp(again, { key: "Enter" });
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Excluir pasta" }));
    const confirm = screen().getByRole("dialog", { name: "Excluir “Arquivo morto”?" });
    await click(within(confirm).getByRole("button", { name: "Excluir pasta" }));
    await settle(6);
    expect(folderNames()).toEqual([]);
  });
});

const menu = () => screen().getByRole("menu", { name: "Ações" });
const items = () =>
  within(menu())
    .getAllByRole("menuitem")
    .map((i) => i.textContent);
const rightClick = async (el: Element) => {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
  await act(async () => void el.dispatchEvent(event));
  await settle(2);
  return event;
};

describe("Drive right click", () => {
  test("empty space: new folder and upload; a folder: open, rename, move, delete; a file: its whole menu", async () => {
    await goDrive();
    await newFolder("Relatórios");
    const page = document.querySelector(".drive") as HTMLElement;
    const event = await rightClick(page);
    expect(event.defaultPrevented).toBe(true);
    expect(items()).toEqual(["Nova pasta", "Enviar arquivo"]);
    await act(async () => fireEvent.click(within(menu()).getByRole("menuitem", { name: "Nova pasta" })));
    await settle(2);
    expect(screen().getByRole("dialog", { name: "Nova pasta" })).toBeTruthy();
    await act(async () => fireEvent.keyDown(screen().getByRole("dialog"), { key: "Escape" }));
    await settle(2);

    await rightClick(screen().getByRole("button", { name: "Relatórios" }));
    expect(items()).toEqual(["Abrir", "Renomear", "Mover para…", "Excluir pasta"]);
    // Escape closes it.
    await act(async () => fireEvent.keyDown(menu(), { key: "Escape" }));
    await settle(2);
    expect(screen().queryByRole("menu")).toBeNull();

    const first = names()[0] ?? "";
    await rightClick(screen().getByRole("button", { name: first }));
    for (const item of ["Abrir", "Baixar", "Renomear", "Mover para…", "Mover para a lixeira"]) {
      expect(items()).toContain(item);
    }
  });

  test("Shift+F10 and the menu key open a folder's menu from the keyboard", async () => {
    await goDrive();
    await newFolder("Contratos");
    const name = screen().getByRole("button", { name: "Contratos" });
    name.focus();
    await act(async () => fireEvent.keyDown(name, { key: "F10", shiftKey: true }));
    await settle(2);
    expect(items()).toEqual(["Abrir", "Renomear", "Mover para…", "Excluir pasta"]);
    await act(async () => fireEvent.keyDown(menu(), { key: "Escape" }));
    await settle(2);
    await act(async () => fireEvent.keyDown(name, { key: "ContextMenu" }));
    await settle(2);
    expect(items()).toContain("Mover para…");
  });

  test("on a selection of several, the menu is for all of them: move them, delete them", async () => {
    const { api } = await goDrive();
    await newFolder("Antigos");
    const first = names()[0] ?? "";
    await click(screen().getByRole("checkbox", { name: "Selecionar Antigos" }));
    await click(screen().getByRole("checkbox", { name: `Selecionar ${first}` }));
    await rightClick(screen().getByRole("button", { name: first }));
    expect(within(menu()).getByText("2 selecionados")).toBeTruthy();
    expect(items()).toEqual(["Mover para…", "Excluir"]);
    await act(async () => fireEvent.click(within(menu()).getByRole("menuitem", { name: "Excluir" })));
    await settle(2);
    const confirm = screen().getByRole("dialog", { name: "Excluir 2 itens?" });
    await click(within(confirm).getByRole("button", { name: "Excluir" }));
    await settle(6);
    expect(folderNames()).toEqual([]);
    expect(names()).not.toContain(first);
    expect((await api.artifacts.list(ORG_ID, { q: first })).length).toBe(0);
  });
});

describe("Drive move dialog", () => {
  test("a plain list with a guide line per level, long names and deep nesting included", async () => {
    const api = createFakeApi(seedState(), { seed: true });
    const long = "Propostas comerciais assinadas e contratos de prestação de serviços renovados com aditivos";
    let parent: string | null = null;
    for (let i = 0; i < 8; i++) {
      const f = await api.artifacts.createFolder(ORG_ID, { name: i === 7 ? long : `Nível ${i}`, parentId: parent });
      parent = f.id;
    }
    for (let i = 0; i < 30; i++) await api.artifacts.createFolder(ORG_ID, { name: `Pasta ${i + 1}`, parentId: null });
    await renderApp(`/org/${ORG_ID}/drive`, { api });
    await settle(8);
    const first = names()[0] ?? "";
    await click(screen().getByRole("checkbox", { name: `Selecionar ${first}` }));
    await click(screen().getByRole("button", { name: "Mover" }));
    const dialog = screen().getByRole("dialog", { name: "Mover 1 item" });
    expect(dialog.querySelector(".ac-optlist--list")).toBeTruthy();
    const deepest = within(dialog).getByRole("radio", { name: new RegExp(long) });
    expect(deepest.querySelectorAll(".ac-optrow__guide").length).toBe(8);
    expect(
      within(dialog)
        .getByRole("radio", { name: /^Drive/ })
        .querySelectorAll(".ac-optrow__guide").length,
    ).toBe(0);
    (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
  });
});

describe("Drive list", () => {
  test("folders and files share one grid: checkbox, icon, then the name", async () => {
    localStorage.setItem("agentes.drive.view", "list");
    await goDrive();
    await newFolder("Marketing");
    const rows = Array.from(document.querySelectorAll(".drive-row"));
    expect(rows.some((r) => r.classList.contains("drive-row--folder"))).toBe(true);
    expect(rows.some((r) => !r.classList.contains("drive-row--folder"))).toBe(true);
    for (const row of rows) {
      const [check, name] = Array.from(row.children);
      expect(check?.getAttribute("role")).toBe("checkbox");
      expect(name?.classList.contains("drive-row__name")).toBe(true);
      const [icon, text] = Array.from(name?.children ?? []);
      expect(icon?.className).toBe("drive-row__icon");
      expect(icon?.querySelector("svg")).toBeTruthy();
      expect(text?.querySelector(".drive-row__title")).toBeTruthy();
    }
    expect(document.querySelector(".drive-row .drive-pv")).toBeNull();
    // The head's checkbox selects folders and files alike.
    const head = document.querySelector(".drive-table__head .drive-check");
    if (!head) throw new Error("no head checkbox");
    await click(head);
    const checked = rows.map((r) => r.querySelector(".drive-check")?.getAttribute("data-state"));
    expect(checked.every((st) => st === "checked")).toBe(true);
    expect(screen().getByText(`${rows.length} selecionados`)).toBeTruthy();
  });
});

describe("folder helpers", () => {
  const f = (id: string, parentId: string | null, name = id) => ({
    id,
    name,
    parentId,
    createdBy: { type: "person" as const, id: "u" },
    createdAt: "",
    updatedAt: "",
  });
  const all = [f("a", null), f("b", "a"), f("c", "b"), f("d", null)];
  test("the path, what's inside, the outline", () => {
    expect(folderTrail(all, "c").map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(folderTrail(all, "gone")).toEqual([]);
    expect([...folderAndInside(all, "a")].sort()).toEqual(["a", "b", "c"]);
    expect(folderOutline(all).map((x) => `${x.folder.id}${x.depth}`)).toEqual(["a0", "b1", "c2", "d0"]);
    // A loop in bad data never hangs.
    expect(folderTrail([f("x", "y"), f("y", "x")], "x").length).toBeLessThanOrEqual(3);
  });
  test("a drag's data: ours, or nothing", () => {
    expect(parseDriveDrag('{"files":["1"],"folders":[]}')).toEqual({ files: ["1"], folders: [] });
    expect(parseDriveDrag("not json")).toBeNull();
    expect(parseDriveDrag('{"files":[],"folders":[]}')).toBeNull();
    expect(parseDriveDrag(null)).toBeNull();
  });
});
