import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, fakeMachinesOf, meWithRole, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * The model picker in a DM's header: one click opens the agent's AIs as tiles and the shown AI's models, a pick saves
 * at once (Desfazer in the toast), and another AI's tile only shows its models until one is picked.
 */

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(6);
};

async function openPicker(state = seedState()) {
  const api = createFakeApi(state);
  await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api });
  await settle(8);
  const header = document.querySelector(".channel__header") as HTMLElement;
  await click(within(header).getByRole("button", { name: "Mudar o modelo de Ada" }));
  const panel = document.querySelector(".mp") as HTMLElement;
  return { state, panel };
}

test("the DM header's button opens the tiles and models; a model of another AI switches only when picked", async () => {
  const { state, panel } = await openPicker();
  expect(panel).toBeTruthy();
  // The tiles: Claude's and ChatGPT's plans on its computer, then the workspace's keys, and connecting one more.
  const tiles = [...panel.querySelectorAll(".mp__tile")].map((b) => b.getAttribute("aria-label"));
  expect(tiles).toContain("Claude");
  expect(tiles).toContain("Conectar uma IA");
  // Showing Claude's models changes nothing yet.
  await click(within(panel).getByRole("button", { name: "Claude" }));
  expect(state.calls.some((c) => c.method === "agents.setBrain")).toBe(false);
  const models = [...panel.querySelectorAll(".mp__model-name")].map((n) => n.textContent);
  expect(models).toEqual(["Automático", "Opus", "Sonnet", "Haiku"]);
  // Automático is marked as the default.
  expect(panel.querySelector(".mp__model-tag")?.textContent).toBe("padrão");
  await click(within(panel).getByRole("option", { name: /Opus/ }));
  const call = state.calls.find((c) => c.method === "agents.setBrain");
  expect(call?.args[2]).toMatchObject({ brain: "claude_code", model: "opus" });
  // Saved and closed, with a way back.
  expect(document.querySelector(".mp")).toBeNull();
  expect(screen().getByRole("button", { name: "Desfazer" })).toBeTruthy();
});

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

test("a reply Automático gave with another model: 'Usar o X em todos' opens the key's dialog on it, 'Escolher modelo' the picker", async () => {
  const state = seedState();
  state.messages.push({
    id: "msg-standin",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body: "Feito.",
    mentionedAgentIds: [],
    agentRunId: "r-standin",
    meta: {
      modelStandIn: {
        plan: "OpenCode Go",
        from: "MiniMax M3",
        to: "GLM-5.3",
        model: "glm-5.3",
        machineId: "machine_1",
        account: "acct_go",
      },
    },
    createdAt: new Date().toISOString(),
  });
  const api = createFakeApi(state);
  fakeMachinesOf.get(api)?.setAiAccounts({
    accounts: [
      {
        id: "acct_go",
        kind: "claude_code",
        label: "OpenCode Go",
        email: null,
        plan: null,
        status: "active",
        ownerId: "u-walter",
        ownerName: "Walter",
        mine: true,
        usedBy: ["Ada"],
        usage: null,
        provider: "opencode",
        keyHint: "AbCd",
        machineId: "machine_1",
        computer: "MacBook",
      },
    ],
    computers: [],
  });
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(8);
  const line = [...document.querySelectorAll(".cn-pill")].find((p) =>
    p.textContent?.includes("Respondi com o GLM-5.3"),
  ) as HTMLElement;
  expect(line).toBeTruthy();
  await click(within(line).getByRole("button", { name: "Usar o GLM-5.3 em todos" }));
  const dialog = screen().getByRole("dialog");
  expect(
    within(dialog)
      .getByRole("radio", { name: /^GLM-5\.3(?! Flash)/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  await act(async () => fireEvent.keyDown(dialog, { key: "Escape" }));
  await settle(4);
  await click(within(line).getByRole("button", { name: "Escolher modelo" }));
  expect(document.querySelector(".mp")).toBeTruthy();
});

test("on an API key with a fixed model the picker's ramp has the three levels the API takes, none chosen yet", async () => {
  const { state, panel } = await openPicker();
  const ramp = within(panel).getByRole("slider", { name: "Esforço" });
  expect(ramp.getAttribute("aria-valuemax")).toBe("3");
  expect(ramp.getAttribute("aria-valuetext")).toBe("Padrão do modelo");
  await act(async () => fireEvent.keyDown(ramp, { key: "ArrowRight" }));
  await settle(6);
  expect(state.calls.find((c) => c.method === "agents.setBrain")?.args[2]).toEqual({ brain: "model", effort: "low" });
});
