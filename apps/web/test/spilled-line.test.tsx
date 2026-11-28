import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { cleanup } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

/* A reply that thought on another computer because the agent's own was full or away says where and why under it. */

afterEach(() => cleanup());

const reply = (id: string, meta: Record<string, unknown>): Message =>
  ({
    id,
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body: id === "r-1" ? "Pronto, resumi o canal." : "Feito.",
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date().toISOString(),
    meta,
  }) as Message;

test("the reply that thought elsewhere says where and why; a reply at home says nothing", async () => {
  const state = seedState();
  state.messages.push(
    reply("r-1", { spilled: { to: "MacBook do Bruno", from: "Computador da Acme", cause: "full" } }),
    reply("r-2", {}),
  );
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(10);
  const text = document.body.textContent ?? "";
  expect(text).toContain("Pensou em MacBook do Bruno: Computador da Acme estava cheio.");
  expect(text.match(/Pensou em/g)).toHaveLength(1);
});
