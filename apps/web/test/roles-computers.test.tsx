import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { OrgRole } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedRoles, seedState } from "./fake-api";
import { endExit, exitsLast, renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));

/** A workspace with a third role, "Suporte", holding nothing of the computers; its page open on Permissões. */
async function openRole(id: string) {
  const state = seedState();
  const [admin, everyone] = seedRoles() as [OrgRole, OrgRole];
  state.roles = [
    admin,
    { ...admin, id: "role-support", name: "Suporte", position: 1, permissions: [], hoist: false },
    everyone,
  ];
  const api = createFakeApi(state);
  await renderApp(`/org/${ORG_ID}/settings/roles/${id}`, { api });
  await settle(6);
  const saved = () =>
    state.calls
      .filter((c) => c.method === "roles.update")
      .map((c) => (c.args.at(-1) as { permissions: string[] }).permissions);
  const row = () =>
    [...document.querySelectorAll<HTMLElement>(".roles-perm")].find(
      (r) => r.querySelector(".settings-row__label")?.textContent === "Computadores dos agentes",
    ) as HTMLElement;
  const choice = () => within(row()).getByRole("combobox");
  const open = async () => {
    choice().focus();
    await act(async () => fireEvent.keyDown(choice(), { key: "Enter" }));
    await settle(2);
    return screen().getAllByRole("option");
  };
  return { choice, row, open, saved, api, state };
}

describe("the agents' computers on a cargo's page: one choice of five steps", () => {
  test("in two groups, the value said whole; Todos' step carries its chip", async () => {
    const { choice, row, open } = await openRole("role-support");
    expect(choice().textContent).toBe("Computador dos próprios agentes");
    expect(within(row()).getByRole("button", { name: "Todos" })).toBeTruthy();
    const options = await open();
    expect(options.map((o) => o.textContent)).toEqual([
      "Não usa",
      "Navegador",
      "Computador",
      "Navegador",
      "Computador",
    ]);
    expect([...document.querySelectorAll('[role="listbox"] .ac-menu__heading')].map((h) => h.textContent)).toEqual([
      "Próprios agentes",
      "Qualquer agente",
    ]);
  });

  test("a step above Todos' saves the cargo's own key, never the four one by one", async () => {
    const { open, saved } = await openRole("role-support");
    const options = await open();
    await click(options[3] as HTMLElement);
    await settle(4);
    expect(saved().at(-1)).toEqual(["control_browsers"]);
  });

  test("Todos: raising its step saves it; lowering asks which cargos keep the step it had", async () => {
    const { open, saved, state, choice } = await openRole("everyone");
    expect(choice().textContent).toBe("Computador dos próprios agentes");
    let options = await open();
    await click(options[4] as HTMLElement);
    await settle(4);
    expect(
      saved()
        .at(-1)
        ?.filter((k) => /^(own|control)_/.test(k)),
    ).toEqual(["control_computers"]);
    options = await open();
    await click(options[1] as HTMLElement);
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Quem fica com o computador de qualquer agente" });
    expect(dialog.textContent).toContain("Todos passam a ter o navegador dos próprios agentes.");
    expect(state.calls.some((c) => c.method === "roles.setRow")).toBe(false);
  });

  test("Admin may everything: its groups fold into one line, with no step to pick", async () => {
    const { row } = await openRole("role-admin");
    expect(document.querySelector(".roles-adminnote")?.textContent).toBe(
      "Com Administrador, Admin pode tudo, menos o que é só do dono.",
    );
    expect(row()).toBeUndefined();
  });
});

describe("Adicionar pessoas to a cargo", () => {
  test("the ones being added keep their rows, and nobody reads as having it, while it adds and closes", async () => {
    const { api, state } = await openRole("role-support");
    const tab = screen().getByRole("tab", { name: /^Pessoas/ });
    await act(async () => fireEvent.mouseDown(tab));
    await settle(6);
    const setFor = api.roles.setFor;
    let answer = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    api.roles.setFor = async (...args) => {
      const saved = await setFor(...args);
      await answered;
      return saved;
    };
    exitsLast();
    await click(screen().getAllByRole("button", { name: "Adicionar pessoas" })[0] as HTMLElement);
    await settle(2);
    const dialog = screen().getByRole("dialog", { name: "Adicionar a Suporte" });
    const rows = () => [...dialog.querySelectorAll(".roles-pick__row")].map((r) => r.textContent);
    const listed = rows();
    expect(listed.length).toBeGreaterThan(0);
    for (const box of within(dialog).getAllByRole("checkbox")) await click(box);
    await click(within(dialog).getByRole("button", { name: `Adicionar ${listed.length}` }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "roles.setFor")).toBe(true);
    expect(rows()).toEqual(listed);
    expect(dialog.textContent).not.toContain("Todo mundo já tem");
    await act(async () => answer());
    await settle(6);
    expect(dialog.getAttribute("data-state")).toBe("closed");
    expect(rows()).toEqual(listed);
    expect(dialog.textContent).not.toContain("Todo mundo já tem");
    await endExit(dialog);
    expect(dialog.isConnected).toBe(false);
  });
});
