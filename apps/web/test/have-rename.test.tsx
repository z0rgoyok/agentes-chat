import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { type HaveItem, HaveRow, haveMark } from "@/components/arrival/ConnectHave";
import { createI18n } from "@/i18n";

afterEach(() => cleanup());

/** One of the person's accounts in Connect an AI's list, with the pencil that names it. */
function row(save: (name: string) => Promise<unknown>) {
  const item: HaveItem = {
    id: "acct_work",
    title: "Trabalho",
    about: "walt@example.com · Team",
    whose: "Suas",
    group: { key: "mine", label: "Suas" },
    mark: haveMark("anthropic"),
    usage: null,
    rename: { value: "Trabalho", placeholder: "walt@example.com", save },
  };
  return render(
    <I18nextProvider i18n={createI18n("pt-BR")}>
      <HaveRow item={item} checked={false} still />
    </I18nextProvider>,
  );
}

test("an account's name renamed where it stands: its maker on the small tile, no box, no Save; Esc goes back, Enter saves", async () => {
  const saved: string[] = [];
  const { container } = row(async (name) => {
    saved.push(name);
  });
  const view = within(container);
  // The maker's logo on its small tile, as AI e uso shows it.
  expect(container.querySelector(".arrival-have__row > .ac-brand.ac-brand--sm")).not.toBeNull();
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Mudar o nome de Trabalho" })));
  const field = view.getByRole("textbox", { name: "Nome da conta" }) as HTMLInputElement;
  expect(field.classList.contains("ac-inlinename")).toBe(true);
  expect(field.closest(".arrival-have__head")).not.toBeNull();
  expect(field.value).toBe("Trabalho");
  expect(view.queryByRole("button", { name: "Salvar" })).toBeNull();
  fireEvent.change(field, { target: { value: "Escritório" } });
  await act(async () => fireEvent.keyDown(field, { key: "Escape" }));
  expect(view.queryByRole("textbox", { name: "Nome da conta" })).toBeNull();
  expect(saved).toEqual([]);
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Mudar o nome de Trabalho" })));
  const again = view.getByRole("textbox", { name: "Nome da conta" });
  fireEvent.change(again, { target: { value: "Escritório " } });
  await act(async () => fireEvent.keyDown(again, { key: "Enter" }));
  expect(saved).toEqual(["Escritório"]);
  expect(view.queryByRole("textbox", { name: "Nome da conta" })).toBeNull();
});
