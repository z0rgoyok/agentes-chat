import { expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AiAccounts, AiComputer, Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  ADA_ID,
  ATLAS_ID,
  createFakeApi,
  fakeAgentBrain,
  LODI_ID,
  ORG_ID,
  seedDm,
  seedState,
  withRightHand,
} from "./fake-api";
import { renderApp, screen, settle, showIn } from "./render";

/*
 * ADR 0137 §7, amended 2026-11-15: Lodi answers with another AI while its plan can't, with one quiet line under the
 * reply and "Change"; the dialog that picks its AI dims the plans it can't think with, each with why. No Lodi-only
 * button to give it a computer.
 */

const click = async (el: Element) => {
  await act(async () => {
    fireEvent.click(el);
  });
  await settle(4);
};

const LINE = "Answered with Acme OpenAI: Claude Max needs a computer.";

test("the stand-in line under Lodi's reply: a quiet pill with Change, Lodi shown ready, no no-AI card", async () => {
  const state = withRightHand(
    seedState({
      aiStatus: {
        any: true,
        agents: [
          { agentId: LODI_ID, state: "ready" },
          { agentId: ADA_ID, state: "ready" },
          { agentId: ATLAS_ID, state: "ready" },
        ],
      } as never,
    }),
  );
  seedDm(state, { type: "agent", id: LODI_ID });
  const DM = `dm-${LODI_ID}`;
  const at = (ago: number) => new Date(Date.now() - ago).toISOString();
  const said = (id: string, author: Message["author"], body: string, ago: number, meta?: Message["meta"]) =>
    ({
      id,
      channelId: DM,
      threadId: null,
      author,
      body,
      mentionedAgentIds: [],
      createdAt: at(ago),
      meta,
    }) as unknown as Message;
  state.messages.push(
    said(
      "m-ask",
      { type: "person", id: "u-walter" },
      "Can you get Ada and Atlas started on the launch checklist?",
      90_000,
    ),
    said(
      "m-reply",
      { type: "agent", id: LODI_ID },
      "Sure. Ada takes the checklist, Atlas the release notes. I'll tell you here when both are done.",
      60_000,
    ),
    said("m-line", { type: "agent", id: LODI_ID }, LINE, 59_000, {
      bodyCode: "right_hand_stand_in",
      bodyParams: { via: "Acme OpenAI", plan: "Claude Max", why: "needsComputer" },
      noAi: {
        agentId: LODI_ID,
        forUserId: "u-walter",
        reason: "no_computer",
        intent: "task",
        standIn: { via: "Acme OpenAI", plan: "Claude Max", why: "needsComputer" },
        runId: "r-1",
      },
    }),
  );
  const r = await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(state) });
  await settle(8);
  await act(async () => r.sockets.last().open());
  await settle(3);
  await showIn(r.services, "en");
  const pill = document.querySelector(".noai-standin");
  expect(pill?.textContent).toContain(LINE);
  // Neutral, never the waiting request's look, and its words once (no message text above it).
  expect(pill?.classList.contains("ac-eventpill--waiting")).toBe(false);
  expect(screen().getAllByText(LINE)).toHaveLength(1);
  expect(within(pill as HTMLElement).getByRole("button", { name: "Change" })).toBeTruthy();
  expect(document.querySelector(".noai-banner")).toBeNull();
  expect(screen().queryByText(/Give Lodi a computer/)).toBeNull();
  cleanup();
});

const MAC: AiComputer = {
  machineId: "machine_mac",
  name: "MacBook",
  online: true,
  mine: true,
  canAdd: true,
  keys: true,
  brains: { claude_code: true, codex: true },
  own: { claude_code: { plan: "max" } },
};
const LAPTOP: AiComputer = { ...MAC, machineId: "machine_laptop", name: "João's laptop", online: false, own: {} };

test("its AI's dialog dims the plans it can't think with, each with why; admins get Connect a computer", async () => {
  const state = withRightHand(seedState(), { brain: { kind: "claude_code", model: "Sonnet" } });
  const api = createFakeApi(state);
  const team = {
    id: "acc-team",
    kind: "claude_code",
    label: "Claude Team",
    ownerId: state.me?.user.id,
    mine: true,
    status: "active",
    shared: true,
    usedBy: [],
  };
  const away = {
    ...team,
    id: "acc-away",
    label: "Claude Pro",
    ownerId: "u-joao",
    ownerName: "João",
    mine: false,
    machineId: LAPTOP.machineId,
    computer: LAPTOP.name,
    provider: null,
    keyHint: null,
    email: null,
    plan: "pro",
    usage: null,
  };
  api.agents.brain = async (_org, id, scope) =>
    fakeAgentBrain(id, {
      scope: scope ?? "mine",
      brain: "claude_code",
      account: "acc-team",
      accounts: [team as never, away as never],
      onlyOwner: true,
      canUsePlans: true,
      canEdit: true,
      workspaceAi: {
        brain: "claude_code",
        ownerId: null,
        servesYou: true,
        key: { provider: "openai", label: "Acme OpenAI" },
      },
    });
  api.machines.aiAccounts = async () => ({ accounts: [away as never], computers: [MAC, LAPTOP] }) as AiAccounts;
  const { services } = await renderApp(`/org/${ORG_ID}/agents/${LODI_ID}`, { api });
  await settle(8);
  await showIn(services, "en");
  await click(screen().getByRole("button", { name: /^AI for people without their own plan/ }));
  const dialog = screen().getByRole("dialog");
  await click(within(dialog).getByRole("button", { name: /Change account/ }));
  const box = screen().getByRole("dialog");
  expect(within(box).getByText("Can't think for Lodi now")).toBeTruthy();
  // The computer's own sign-in: named by its plan, with why, not pickable.
  expect(
    within(box).getByText("Signed in on MacBook only. Lodi thinks with a plan signed in as an account."),
  ).toBeTruthy();
  // João's plan on his laptop that is away: out of the choice, with why and the workspace's way out.
  expect(within(box).getByText(/João's, on João's laptop, which is away\./)).toBeTruthy();
  expect(within(box).getByRole("link", { name: "Connect a computer" })).toBeTruthy();
  expect(box.querySelectorAll(".arrival-have__row[data-why]")).toHaveLength(2);
  expect(within(box).queryByRole("radio", { name: /Claude Pro/ })).toBeNull();
  expect(within(box).queryByText(/Give Lodi a computer/)).toBeNull();
  cleanup();
});
