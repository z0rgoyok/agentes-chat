import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** Joining a channel says so (ADR 0090): one quiet pill for everyone, with the newcomer's face. */

afterEach(() => cleanup());

const line = (
  id: string,
  kind: "joined" | "left",
  author: { type: "agent" | "person"; id: string },
  refs: Record<string, string>,
  secondsAgo: number,
) => ({
  id,
  channelId: ENG_ID,
  threadId: null,
  author,
  body: "Written for the agents, never shown",
  mentionedAgentIds: [],
  agentRunId: null,
  meta: { notice: { kind, text: "Written for the agents, never shown", refs } },
  createdAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
});

test("who joined, who added them and who left are lines in the reader's words, the newcomer waving as it arrives", async () => {
  const state = seedState();
  state.messages.push(
    line(
      "m-two",
      "joined",
      { type: "agent", id: ADA_ID },
      { members: `agent:${ADA_ID},agent:${ATLAS_ID}`, by: "u-joao" },
      600,
    ),
    line("m-self", "joined", { type: "person", id: "u-joao" }, { members: "person:u-joao" }, 300),
    line("m-left", "left", { type: "agent", id: ATLAS_ID }, { members: `agent:${ATLAS_ID}` }, 200),
    line("m-now", "joined", { type: "agent", id: ADA_ID }, { members: `agent:${ADA_ID}`, by: "u-joao" }, 1),
  );
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);
  expect(screen().getByText("Ada e Atlas entraram no canal · João adicionou")).toBeTruthy();
  expect(screen().getByText("João entrou no canal")).toBeTruthy();
  expect(screen().getByText("Atlas saiu do canal")).toBeTruthy();
  expect(screen().getByText("Ada entrou no canal · João adicionou")).toBeTruthy();
  expect(document.body.textContent).not.toContain("Written for the agents");
  // The one just in waves (the kit's sticker); an older one shows the still face.
  const pill = (id: string) => document.querySelector(`[data-message-id="${id}"]`) as HTMLElement;
  expect(pill("m-now").querySelector(".ac-eventpill__mark canvas")).toBeTruthy();
  expect(pill("m-now").querySelector(".ac-eventpill__mark .ac-avatar")).toBeNull();
  expect(pill("m-two").querySelector(".ac-eventpill__mark .ac-avatar")).toBeTruthy();
  (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
});
