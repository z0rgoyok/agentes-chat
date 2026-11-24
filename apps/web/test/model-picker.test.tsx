import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, meWithRole, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

/*
 * The model picker in a DM's header: one click opens the agent's AIs and the shown AI's models, a pick saves at once
 * (Desfazer in the toast), and another AI only shows its models until one is picked.
 */

afterEach(() => cleanup());

test("who can't change it reads what it thinks with, with nothing to press", async () => {
  const state = seedState();
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.ownerUserId = "someone_else";
  meWithRole(state, []);
  const api = createFakeApi(state);
  await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api });
  await settle(8);
  const header = document.querySelector(".channel__header") as HTMLElement;
  expect(within(header).queryByRole("button", { name: "Mudar o modelo de Ada" })).toBeNull();
  expect(header.querySelector(".mp-label")?.textContent).toBeTruthy();
});
