import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AiAccounts, Run } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/* A run that went on with another account: quiet in the chat, said in Atividade with each account as a pill and its card. */

afterEach(() => cleanup());

const account = (over: Partial<AiAccounts["accounts"][number]>): AiAccounts["accounts"][number] => ({
  id: "acct_x",
  kind: "claude_code",
  label: "Claude",
  named: true,
  email: null,
  plan: "max",
  status: "active",
  ownerId: "u-walter",
  ownerName: "Walter",
  mine: false,
  usedBy: [],
  usage: null,
  provider: null,
  keyHint: null,
  machineId: "machine_1",
  computer: "MacBook",
  ...over,
});

const switched: Run = {
  id: "run-switch",
  agentId: ADA_ID,
  channelId: ENG_ID,
  threadId: "m-1",
  trigger: "mention",
  status: "done",
  error: null,
  what: "resume o canal",
  turns: 2,
  inputTokens: 100,
  outputTokens: 10,
  createdAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  accountSwitch: {
    from: { id: "acct_mine", name: "Claude" },
    to: { id: "acct_walter", name: "Claude (Walter)" },
    cause: "limit",
  },
};

test("Atividade says which account the run went on with, each a pill whose card says whose it is and where", async () => {
  const state = seedState();
  state.runs.push(switched);
  const api = createFakeApi(state);
  fakeMachinesOf.get(api)?.setAiAccounts({
    accounts: [
      account({ id: "acct_mine", ownerId: "u-joao", ownerName: "João", mine: true }),
      account({
        id: "acct_walter",
        usage: {
          windows: [{ kind: "five_hour", usedPercent: 30, resetsAt: "2099-01-01T15:40:00.000Z" }],
          source: "turn",
          at: new Date().toISOString(),
        },
      }),
    ],
    computers: [
      {
        machineId: "machine_1",
        name: "MacBook",
        online: true,
        mine: true,
        canAdd: true,
        keys: true,
        brains: { claude_code: true, codex: true },
      },
    ],
  });
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=activity`, { api });
  await settle(8);
  const runs = screen().getByRole("region", { name: "Execuções" });
  const row = within(runs).getByText("resume o canal").closest("li") as HTMLElement;
  expect(row.textContent).toContain("Seguiu na conta Claude (Walter) porque a conta Claude chegou ao limite");
  const pill = within(row).getByRole("button", { name: "Conta Claude (Walter)" });
  // The maker's mark leads the pill.
  expect(pill.querySelector(".ac-brand")).toBeTruthy();
  await act(async () => fireEvent.click(pill));
  await settle(4);
  const card = screen().getByRole("dialog", { name: "Sobre a conta Claude (Walter)" });
  expect(card.textContent).toContain("Conta de Walter · No computador MacBook");
  expect(card.textContent).toContain("30%");
  await act(async () => fireEvent.keyDown(card, { key: "Escape" }));
  await settle(2);
  await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Conta Claude" })));
  await settle(4);
  expect(screen().getByRole("dialog", { name: "Sobre a conta Claude" }).textContent).toContain("Sua conta");
});

test("an account gone from the workspace keeps the name it went by, and its card says it is gone", async () => {
  const state = seedState();
  // The worst case: names long enough to wrap in the row and in the card.
  const long = "Conta-Compartilhada-Da-Equipe-De-Operações-Internacionais (Walter Montgomery-Schwarzenegger)";
  state.runs.push({
    ...switched,
    accountSwitch: { from: { id: "acct_mine", name: "Claude" }, to: { id: "acct_gone", name: long }, cause: "limit" },
  });
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=activity`, { api: createFakeApi(state) });
  await settle(8);
  const pill = screen().getByRole("button", { name: `Conta ${long}` });
  expect(pill.querySelector(".ac-brand")).toBeNull();
  await act(async () => fireEvent.click(pill));
  await settle(4);
  expect(screen().getByRole("dialog", { name: `Sobre a conta ${long}` }).textContent).toContain(
    "Esta conta não está mais no workspace.",
  );
});

test("in the chat, only the run's details say it: no line in the conversation, the switch at the top of its opened tools", async () => {
  const state = seedState();
  const org = state.me?.organizations[0];
  if (org) org.showActivity = true;
  state.runs.push(switched);
  state.runSteps = {
    "run-switch": [
      { seq: 1, kind: "tool_call", data: { name: "run_code", toolUseId: "c1" }, createdAt: new Date().toISOString() },
      { seq: 2, kind: "tool_result", data: { toolUseId: "c1", content: "ok" }, createdAt: new Date().toISOString() },
    ],
  };
  state.messages = [
    {
      id: "m-reply",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "Pronto, resumi o canal.",
      mentionedAgentIds: [],
      agentRunId: "run-switch",
      createdAt: new Date().toISOString(),
      meta: { work: { steps: 2, calls: [{ name: "run_code", n: 2 }], durationMs: 5000 } },
    },
  ];
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(8);
  await act(async () => r.sockets.last().open());
  await settle(2);
  expect(document.body.textContent).not.toContain("chegou ao limite");
  const block = document.querySelector(".ac-tools") as HTMLElement;
  await act(async () => fireEvent.click(within(block).getAllByRole("button")[0] as HTMLElement));
  await settle(6);
  expect(block.textContent).toContain("Seguiu na conta Claude (Walter) porque a conta Claude chegou ao limite");
  expect(within(block).getByRole("button", { name: "Conta Claude (Walter)" })).toBeTruthy();
});
