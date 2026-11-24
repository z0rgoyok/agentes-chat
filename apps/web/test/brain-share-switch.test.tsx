import { afterEach, describe, expect, test } from "bun:test";
import type { AgentBrain } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, fakeAgentBrain, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * "Atende outras pessoas" (ADR 0059 §5): an agent on its owner's plan answers only them until they turn it on, with
 * nothing to accept. Under the switch, a line saying whom it answers in that state and on which plan, and behind its ⓘ
 * what the plan's terms say. An admin who doesn't own it gets the same switch, its line naming whose plan it is, and
 * widens or narrows it in "Quem pode falar" too. In "Quem pensa" it is on the "More options" screen, saved by "Done"
 * (ADR 0032 §5, addendum 2026-11-10).
 */

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(2);
};

/**
 * Ada on the MacBook with the given brain view; Walter (me) owns her unless `mine` is false (then João does).
 * `ownPlan`: the plan of the MacBook's own sign-in, as its row of the AI accounts says it. `en`: the page in English.
 */
async function ada(
  patch: Partial<AgentBrain>,
  { mine = true, tab = "", provider = "", ownPlan = "", en = false, people = false } = {},
) {
  const state = seedState();
  const agent = state.agents.find((a) => a.id === ADA_ID);
  if (agent) {
    agent.ownerUserId = mine ? "u-walter" : "u-joao";
    // Its owner's plan thinks for it (`account`): the MacBook's own sign-in.
    agent.brain = {
      kind: patch.brain ?? "claude_code",
      model: "Sonnet",
      account: "Claude Max",
      ...(provider ? { provider } : {}),
    };
    agent.audience = { mode: people ? "people" : patch.onlyOwner === false ? "everyone" : "owner", userIds: [] };
  }
  const api = createFakeApi(state);
  fakeMachinesOf.get(api)?.pair({
    id: "machine_1",
    name: "MacBook",
    os: "darwin",
    access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: true } },
    browser: { available: true, version: "1", chrome: null, reason: null },
  });
  await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
  if (ownPlan) {
    fakeMachinesOf.get(api)?.setAiAccounts({
      accounts: [],
      computers: [
        {
          machineId: "machine_1",
          name: "MacBook",
          online: true,
          mine: true,
          canAdd: true,
          keys: true,
          brains: { claude_code: true, codex: true },
          own: { claude_code: { plan: ownPlan } },
        },
      ],
    });
  }
  let view = fakeAgentBrain(ADA_ID, {
    brain: "claude_code",
    effectiveModel: "sonnet",
    onlyOwner: true,
    canUsePlans: mine,
    ...patch,
  });
  api.agents.brain = async () => structuredClone(view);
  // The view follows what is saved, as the server's does: what thinks, its account, whom it answers; the agent's row
  // says what thinks too.
  const setBrain = api.agents.setBrain;
  api.agents.setBrain = async (orgId, agentId, input) => {
    const next = await setBrain(orgId, agentId, input);
    if (agent?.brain) agent.brain = { ...agent.brain, kind: next.brain };
    view = {
      ...view,
      brain: next.brain,
      onlyOwner: next.onlyOwner,
      ...(input.account !== undefined ? { account: input.account } : {}),
    };
    return next;
  };
  const { services } = await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}${tab}`, { api });
  await settle(8);
  if (en) {
    await act(async () => {
      await services.i18n.changeLanguage("en");
    });
    await settle(3);
  }
  return state;
}

describe("Quem pode falar, on a plan", () => {
  const audience = () => screen().getByRole("radiogroup", { name: "Quem pode falar com a Ada" });
  const save = () =>
    click(
      within(screen().getByRole("region", { name: "Alterações não salvas" })).getByRole("button", { name: /^Salvar/ }),
    );

  test("its owner widens it with nothing to accept", async () => {
    const state = await ada({}, { tab: "?tab=settings&sec=audience" });
    await click(within(audience()).getByRole("radio", { name: /^Todos do workspace/ }));
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(
      within(audience())
        .getByRole("radio", { name: /^Todos do workspace/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await save();
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.update")?.args[2]).toEqual({
      audience: { mode: "everyone", userIds: [], roleIds: [], consultable: true },
    });
  });

  test("an admin who doesn't own it lets more people in too, with nothing to accept", async () => {
    await ada({}, { mine: false, tab: "?tab=settings&sec=audience" });
    await click(within(audience()).getByRole("radio", { name: /^Todos do workspace/ }));
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(
      within(audience())
        .getByRole("radio", { name: /^Todos do workspace/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(document.body.textContent).not.toContain("Só João pode deixar outras pessoas falarem com ela.");
  });
});
