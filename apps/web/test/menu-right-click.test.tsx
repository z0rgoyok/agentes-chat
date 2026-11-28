import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { setMenuLook } from "@/lib/context-menu";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

const win = () => window as { __agentesDesktop?: unknown; __TAURI_INTERNALS__?: unknown };
afterEach(() => {
  cleanup();
  setMenuLook("ours");
  delete win().__agentesDesktop;
  delete win().__TAURI_INTERNALS__;
});

/** Radix opens the account menu on a key or a pointer press, not on a click. */
async function openAccountMenu() {
  const row = screen().getByRole("button", { name: /^Conta: / });
  row.focus();
  await act(async () => {
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyUp(row, { key: "Enter" });
  });
  await settle(2);
  return screen().getAllByRole("menu")[0] as HTMLElement;
}

describe("a right click inside an open menu, in the desktop app", () => {
  test("the menu it opens stays while the mouse moves over the menu under it", async () => {
    win().__agentesDesktop = { version: "0.6.0" };
    win().__TAURI_INTERNALS__ = { invoke: async (cmd: string) => (cmd === "this_mac" ? { orgs: [] } : {}) };
    await renderApp(`/org/${ORG_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const row = within(await openAccountMenu()).getAllByRole("menuitem")[0] as HTMLElement;
    await act(async () => fireEvent.contextMenu(row, { clientX: 10, clientY: 10 }));
    await settle(2);
    expect(document.querySelectorAll(".ac-menu--at")).toHaveLength(1);
    // Radix's rows take focus on a mouse move: that is no way out of the menu opened over them.
    await act(async () => fireEvent.pointerMove(row, { pointerType: "mouse" }));
    await settle(2);
    expect(document.querySelectorAll(".ac-menu--at")).toHaveLength(1);
    // A press elsewhere still closes it.
    await act(async () => fireEvent.pointerDown(document.body, { button: 0 }));
    await settle(2);
    expect(document.querySelectorAll(".ac-menu--at")).toHaveLength(0);
  });
});
