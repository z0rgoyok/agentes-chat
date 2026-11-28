import { afterEach, describe, expect, test } from "bun:test";
import type { AgentBrain, MachineAccount } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { addAccount, brainDialog, brainNotes, openAccounts, pickAccount } from "./ai-picker";
import { ADA_ID, ATLAS_ID, createFakeApi, fakeAgentBrain, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { shownText } from "./hint";
import { renderApp, settle } from "./render";

/*
 * "Quem pensa" with other people's agents and accounts (ADR 0032 §5, addenda 2026-11-10 and 2026-11-24; ADR 0059 §3):
 * an admin on someone else's agent picks among that owner's accounts and the workspace's keys, never signs one in
 * there; after a switch, "Trocar também" moves the others on the account it left, each by the server's own rules, and
 * one it refuses is named.
 */

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};

const account = (patch: Partial<MachineAccount> & Pick<MachineAccount, "id" | "label">): MachineAccount => ({
  kind: "claude_code",
  email: `${patch.id}@acme.com`,
  plan: "max",
  status: "active",
  ownerId: "u-walter",
  ownerName: "Walter",
  mine: true,
  usedBy: [],
  usage: null,
  provider: null,
  keyHint: null,
  ...patch,
});

/** Ada on the MacBook, thinking with `view`'s account; `owner`: who owns Ada and Atlas. */
async function ada(view: Partial<AgentBrain>, owner = "u-walter") {
  const state = seedState();
  for (const a of state.agents)
    if (a.id === ADA_ID || a.id === ATLAS_ID) {
      a.ownerUserId = owner;
      a.brain = { kind: "claude_code", model: "Sonnet", account: "Claude Max" };
    }
  const api = createFakeApi(state);
  fakeMachinesOf.get(api)?.pair({ id: "machine_1", name: "MacBook", os: "darwin" });
  await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
  // The Conta field lists the accounts on the MacBook.
  fakeMachinesOf.get(api)?.setAiAccounts({
    accounts: (view.accounts ?? []).map((a) => ({ ...a, machineId: "machine_1", computer: "MacBook" })),
    computers: [
      {
        machineId: "machine_1",
        name: "MacBook",
        online: true,
        mine: owner === "u-walter",
        canAdd: true,
        keys: true,
        brains: { claude_code: true, codex: true },
      },
    ],
  });
  const brain = fakeAgentBrain(ADA_ID, { brain: "claude_code", effectiveModel: "sonnet", onlyOwner: true, ...view });
  api.agents.brain = async (_orgId, agentId) => structuredClone({ ...brain, agentId });
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api });
  await settle(8);
  return { state, api };
}

describe("an admin on someone else's agent", () => {
  test("picks among the owner's accounts it may use and the keys; locked ones stay off, nothing to sign in", async () => {
    const theirs = account({
      id: "acct_joao",
      label: "Claude Max",
      ownerId: "u-joao",
      ownerName: "João Silva",
      mine: false,
      usedBy: ["Ada"],
    });
    // João's to give: the server says it can't think for Ada.
    const other = account({
      id: "acct_joao2",
      label: "Claude Pro",
      ownerId: "u-joao",
      ownerName: "João Silva",
      mine: false,
      usable: false,
    });
    const admin = { canUsePlans: false, canManageAccounts: false, ownSignIn: false };
    await ada({ account: "acct_joao", accounts: [theirs, other], ...admin }, "u-joao");
    const d = await brainDialog("Quem pensa pela Ada");
    // Whose accounts these are, said on the first screen.
    expect(shownText(d)).toContain("Só contas de João");
    // The one in use; João's other account, saying whose it is, not to be picked; the workspace's key.
    const rows = await openAccounts(d);
    expect(rows.map((r) => [r.group, r.title, r.checked, r.off])).toEqual([
      ["Do time", "Claude Max", true, false],
      ["Do time", "Claude Pro", false, true],
      ["Chaves de API", "Claude da Acme", false, false],
    ]);
    expect(rows[1]?.sub).toBe("Max · de João");
    // Adding one here is a key's only: a plan's sign-in is the owner's (ADR 0160, addendum).
    await addAccount(d);
    expect(within(d).queryByRole("button", { name: /^(Claude|ChatGPT|Gemini)/ })).toBeNull();
    expect(within(d).getByRole("button", { name: /^Chave de API/ })).toBeTruthy();
    expect(within(d).queryByRole("button", { name: /^Entrar/ })).toBeNull();
  });
});

describe("Todos nesta conta", () => {
  test("Trocar também: each other agent on the account it left moves by the server's rules; one it refuses keeps its account and is named", async () => {
    const shared = account({
      id: "acct_team",
      label: "Claude Max",
      shared: true,
      usedBy: ["Ada", "Atlas"],
      usedByIds: [ADA_ID, ATLAS_ID],
    });
    const next = account({ id: "acct_next", label: "Claude Team", email: "next@acme.com", plan: "team", shared: true });
    const { state, api } = await ada({ account: "acct_team", accounts: [shared, next] });
    const setBrain = api.agents.setBrain;
    const asked: unknown[] = [];
    api.agents.setBrain = async (orgId, agentId, input) => {
      if (agentId !== ATLAS_ID) return setBrain(orgId, agentId, input);
      asked.push(input);
      throw new ApiError(409, "agent.brain_refused", "Not on this account");
    };
    const d = await brainDialog("Quem pensa pela Ada");
    await pickAccount(d, "next@acme.com");
    await settle(6);
    // Ada moves at once; Atlas, still on the account she left, is offered on the line under it.
    expect(state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args[1])).toEqual([ADA_ID]);
    expect(asked).toEqual([]);
    expect(brainNotes(d).join(" ")).toContain("Atlas também pensa com");
    await click(within(d).getByRole("button", { name: "Trocar também" }));
    await settle(6);
    // Atlas was asked for the account alone (the model it has stays its own) and refused: said by name.
    expect(asked).toEqual([{ brain: "claude_code", account: "acct_next" }]);
    expect(shownText(d)).toContain("Atlas ficou com a conta de antes.");
    expect(within(d).queryByRole("button", { name: "Trocar também" })).toBeNull();
  });
});
