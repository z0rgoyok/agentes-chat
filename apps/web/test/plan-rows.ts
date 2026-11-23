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
