import { act, fireEvent, within } from "@testing-library/react";
import { screen, settle } from "./render";

/** The connectors store's page (`/connectors`), or a connection's page in Settings: the region on screen. */
const storeRoot = () => document.querySelector(".store") as HTMLElement;

/**
 * "Browse connectors" in Settings › Connectors (the band over the list, or the empty state's button): the store, a
 * page of its own. Returns its root, so `within(store)` reaches its search, tabs and lines.
 */
export async function openStore() {
  const browse = screen().getAllByRole("button", { name: "Ver conectores" })[0] as HTMLElement;
  await act(async () => fireEvent.click(browse));
  await settle(6);
  return storeRoot();
}

/** Types into the store's search: only the services that match stay, each with its own Connect. */
export async function searchStore(store: HTMLElement, query: string) {
  const box = within(store).getByRole("searchbox", { name: "Buscar conector" });
  await act(async () => fireEvent.change(box, { target: { value: query } }));
  await settle(2);
}

/** A service's dialog in the store (its line or feature pressed), named by its title. */
export const service = (name: string) => {
  const box = document.querySelector(".store-dialog") as HTMLElement | null;
  // The title's words, after its mark (a monogram is letters too).
  if (!box || box.querySelector(".ac-dialog__title .cflow__title > :last-child")?.textContent !== name)
    throw new Error(`no dialog for ${name} on screen`);
  return box;
};

/** Opens a service's dialog from the store: searched for, then its line pressed. */
export async function openService(store: HTMLElement, name: string) {
  await searchStore(store, name);
  const line = [...store.querySelectorAll(".store-item__open")].find(
    (el) => el.querySelector(".store-item__text b")?.textContent === name,
  ) as HTMLElement | undefined;
  if (!line) throw new Error(`no line for ${name} in the store`);
  await act(async () => fireEvent.click(line));
  await settle(4);
  return service(name);
}

/**
 * Picks a service in the store (searched for, so any service is in reach): its line opens its dialog, whose Connect
 * closes it and starts the connect flow.
 */
export async function pick(store: HTMLElement, name: string) {
  const box = await openService(store, name);
  await act(async () => fireEvent.click(within(box).getByRole("button", { name: `Conectar ${name}` })));
  await settle(4);
}

/** The connections listed in Settings › Connectors, by their names (what needs a person comes first). */
export const connectedNames = () =>
  [...document.querySelectorAll(".store-list .store-item--link .store-item__text b")].map((b) => b.textContent);

/** A connection's line in Settings › Connectors (the first whose name is `name`). */
export const connectionLine = (name: string) => {
  const line = [...document.querySelectorAll(".store-item--link")].find(
    (li) => li.querySelector(".store-item__text b")?.textContent === name,
  ) as HTMLElement | undefined;
  if (!line) throw new Error(`no connection named ${name} listed`);
  return line;
};

/**
 * Opens a connection's page from its line in Settings › Connectors: who uses it, tools, account and the rest, each
 * with its button. Returns the page.
 */
export async function openConnection(name: string) {
  const open = connectionLine(name).querySelector(".store-item__open") as HTMLElement;
  await act(async () => fireEvent.click(open));
  await settle(4);
  return storeRoot().querySelector(".store-page") as HTMLElement;
}

/** Back to the list: a service's dialog in the store closes (its ×); "Connectors" over a connection's page goes back. */
export async function backToList() {
  const box = document.querySelector(".store-dialog") as HTMLElement | null;
  const back = box
    ? within(box).getByRole("button", { name: "Fechar" })
    : within(storeRoot()).getByRole("button", { name: "Conectores" });
  await act(async () => fireEvent.click(back));
  await settle(4);
}

/** A connection's ⋯ on its page (Radix opens a menu from the keyboard here): its menu (Rename, another account…). */
export async function rowMenu(name: string) {
  await openConnection(name);
  const button = screen().getByRole("button", { name: `Mais ações de ${name}` });
  button.focus();
  await act(async () => {
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyUp(button, { key: "Enter" });
  });
  await settle(2);
  return screen().getByRole("menu");
}
