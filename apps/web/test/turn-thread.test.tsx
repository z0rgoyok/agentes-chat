import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/**
 * An agent asked in a channel's main timeline (ADR 0261): its first line stays in the channel, the rest of its turn
 * goes in that line's thread. The channel shows who is replying there, then the thread's one line.
 */

afterEach(() => cleanup());

const push = (socket: { push: (f: unknown) => void }, event: Record<string, unknown>) =>
  act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
const rowOf = (text: string) =>
  screen()
    .queryAllByRole("article")
    .find((a) => a.textContent?.includes(text));

const LINE = "Certo, vou levantar os números do mês.";
const ANSWER = "Novembro até hoje: 42 assinaturas novas, 3 cancelamentos e receita recorrente de R$ 18.400.";

test("its line in the channel, then its work and its answer in the line's thread", async () => {
  const state = seedState();
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);

  const run = { runId: "r-numbers", agentId: ADA_ID };
  await push(socket, { type: "agent.thinking", ...run, threadId: null });
  const line = {
    id: "m-line",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body: LINE,
    mentionedAgentIds: [],
    agentRunId: null,
    meta: { sayNow: { runId: run.runId }, turnThread: { askedBy: "u-joao" } },
    createdAt: new Date().toISOString(),
  } as (typeof state.messages)[number];
  state.messages.push(line);
  await push(socket, { type: "message.created", messageId: line.id, message: line });
  // As the server sends it when the run moves under its line.
  await push(socket, { type: "agent.idle", ...run, threadId: null });
  await push(socket, { type: "agent.thinking", ...run, threadId: line.id });
  await settle(3);

  expect(
    within(rowOf(LINE) as HTMLElement).getByRole("button", { name: /Ada está respondendo na thread/ }).className,
  ).toContain("thread-line");

  const answer = {
    id: "m-answer",
    channelId: ENG_ID,
    threadId: line.id,
    author: { type: "agent", id: ADA_ID },
    body: ANSWER,
    mentionedAgentIds: [],
    agentRunId: run.runId,
    createdAt: new Date().toISOString(),
  } as (typeof state.messages)[number];
  state.messages.push(answer);
  await state.openThread?.(ORG_ID, line.id, answer.createdAt);
  await push(socket, { type: "message.created", messageId: answer.id, message: answer });
  await push(socket, { type: "run.finished", ...run, threadId: line.id, status: "done" });
  await settle(6);

  const row = rowOf(LINE) as HTMLElement;
  expect(within(row).getByRole("button", { name: /1 resposta/ }).className).toContain("thread-line");
  expect(within(row).queryByRole("button", { name: /respondendo na thread/ })).toBeNull();
  expect(rowOf("42 assinaturas novas")).toBeUndefined();
});
