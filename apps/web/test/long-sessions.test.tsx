import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { keys, type Message } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { MESSAGES_KEPT, trimming } from "@/pages/ChannelPage";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

const AFTER_MS = trimming.afterMs;
afterEach(() => {
  trimming.afterMs = AFTER_MS;
  cleanup();
});

/** A busy channel's latest list after a long session: more than the conversation keeps. */
const many = (count: number): Message[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `m-${i}`,
    channelId: ENG_ID,
    threadId: null,
    author: { type: "person", id: "u-joao" },
    body: `linha ${i}`,
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
  }));

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

async function openWith(count: number) {
  trimming.afterMs = 60;
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
  await settle(5);
  const qc = r.services.queryClient;
  const key = keys.messages(ORG_ID, ENG_ID);
  await act(async () => {
    qc.setQueryData(key, many(count));
  });
  return { qc, key };
}

test("pinned to its end a while, a conversation keeps only its newest messages", async () => {
  const { qc, key } = await openWith(MESSAGES_KEPT + 60);
  expect(qc.getQueryData<Message[]>(key)).toHaveLength(MESSAGES_KEPT + 60);
  await wait(200);
  const kept = qc.getQueryData<Message[]>(key) ?? [];
  expect(kept).toHaveLength(MESSAGES_KEPT);
  expect(kept.at(-1)?.id).toBe(`m-${MESSAGES_KEPT + 59}`);
});

test("a few past the ceiling wait for more before a trim: each one draws the conversation again", async () => {
  const { qc, key } = await openWith(MESSAGES_KEPT + 10);
  await wait(200);
  expect(qc.getQueryData<Message[]>(key)).toHaveLength(MESSAGES_KEPT + 10);
});

test("scrolled up, it keeps what the person reads", async () => {
  const { qc, key } = await openWith(MESSAGES_KEPT + 60);
  await act(async () => {
    fireEvent.wheel(screen().getByRole("region", { name: "Mensagens" }), { deltaY: -200 });
  });
  await wait(200);
  expect(qc.getQueryData<Message[]>(key)).toHaveLength(MESSAGES_KEPT + 60);
});
