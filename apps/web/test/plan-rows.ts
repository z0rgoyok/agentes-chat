import { act, fireEvent, within } from "@testing-library/react";
import { screen, settle } from "./render";

/** A usage list row's columns as one line ("Ada · 30% · 4,5 mi tokens"): its cells' words, joined. */
export const shareRow = (row: Element) =>
  [...row.children]
    .map((cell) => cell.textContent?.replaceAll(" ", " "))
    .filter(Boolean)
    .join(" · ");

/** A usage list's label, without the window's name over its shares column. */
export const shareLabel = (label: Element) => label.firstElementChild?.textContent;

/** Opens an account's "Detalhes" (a native `<details>`) as a click on its summary would. */
export function openDetails(within: Element) {
  const details = within.querySelector("details.plan-details") as HTMLDetailsElement;
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
}

/** IA e uso opens on Contas de IA: the usage views are the Uso tab's. */
export async function usageTab() {
  await act(async () => fireEvent.mouseDown(screen().getByRole("tab", { name: "Uso" }), { button: 0 }));
  await settle(4);
}

/** "Ordem de uso" from Contas de IA's card: its dialog. */
export async function openOrder() {
  const card = screen().getByRole("region", { name: "Contas" });
  await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Ordem de uso" })));
  await settle(4);
  return screen().getByRole("dialog", { name: "Ordem de uso" });
}
