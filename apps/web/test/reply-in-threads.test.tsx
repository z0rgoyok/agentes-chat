import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** "Agentes respondem em threads" (ADR 0214): the switch in the channel's details, and the channel while they work. */

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const open = async (state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return { socket, state };
};
const push = (socket: { push: (f: unknown) => void }, event: Record<string, unknown>) =>
  act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
const rowOf = (text: string) =>
  screen()
    .queryAllByRole("article")
    .find((a) => a.textContent?.includes(text));

test("the channel's details: a switch that saves replyInThreads", async () => {
  const { state } = await open();
  await click(within(screen().getByRole("main")).getByRole("button", { name: "Configurações do canal" }));
  await settle(3);
  const dialog = screen().getByRole("dialog", { name: "#eng" });
  const toggle = within(dialog).getByRole("switch", { name: "Agentes respondem em threads" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await click(toggle);
  await settle(3);
  expect(state.calls.filter((c) => c.method === "chat.update").map((c) => c.args.at(-1))).toEqual([
    { replyInThreads: true },
  ]);
  expect(
    within(screen().getByRole("dialog", { name: /^#eng/ }))
      .getByRole("switch", { name: "Agentes respondem em threads" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

test("an agent answering in the thread under a message: one line under it says so while it works", async () => {
  const { socket } = await open();
  const asked = rowOf("o login está devolvendo 401");
  expect(asked).toBeTruthy();
  expect(within(asked as HTMLElement).queryByRole("button", { name: /respondendo na thread/ })).toBeNull();

  const run = { threadId: "m-1", runId: "r-thread", agentId: ADA_ID };
  await push(socket, { type: "agent.thinking", ...run });
  await settle(2);
  const line = within(rowOf("o login está devolvendo 401") as HTMLElement).getByRole("button", {
    name: /Ada está respondendo na thread/,
  });
  expect(line.className).toContain("thread-line");
  // Its words live in the thread: none of them in the channel.
  await push(socket, { type: "agent.delta", ...run, seq: 1, text: "Olhando o refresh" });
  await settle();
  expect(rowOf("Olhando o refresh")).toBeUndefined();

  await push(socket, { type: "agent.idle", ...run });
  await settle(2);
  expect(
    within(rowOf("o login está devolvendo 401") as HTMLElement).queryByRole("button", {
      name: /respondendo na thread/,
    }),
  ).toBeNull();
});

test("a run that answers in the channel itself adds no line under the message", async () => {
  const { socket } = await open();
  await push(socket, { type: "agent.thinking", threadId: null, runId: "r-flat", agentId: ADA_ID });
  await settle(2);
  expect(screen().queryAllByRole("button", { name: /respondendo na thread/ })).toEqual([]);
});

test("once its reply is there, the channel shows the thread's one line under the message, never the reply", async () => {
  const state = seedState();
  state.messages.push({
    id: "m-reply",
    channelId: ENG_ID,
    threadId: "m-1",
    author: { type: "agent", id: ADA_ID },
    body: "Achei: o refresh compara segundos com milissegundos.",
    mentionedAgentIds: [],
    agentRunId: "r-thread",
    createdAt: new Date().toISOString(),
  } as (typeof state.messages)[number]);
  const api = createFakeApi(state);
  await (api.threads as never as { openByReply: (org: string, root: string, at: string) => Promise<void> }).openByReply(
    ORG_ID,
    "m-1",
    new Date().toISOString(),
  );
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(8);
  await act(async () => r.sockets.last().open());
  await settle(2);
  await push(r.sockets.last(), { type: "agent.thinking", threadId: "m-1", runId: "r-more", agentId: ADA_ID });
  await settle(2);

  const asked = rowOf("o login está devolvendo 401") as HTMLElement;
  expect(within(asked).getByRole("button", { name: /1 resposta/ }).className).toContain("thread-line");
  expect(within(asked).queryByRole("button", { name: /respondendo na thread/ })).toBeNull();
  expect(rowOf("o refresh compara segundos")).toBeUndefined();
});

/** What the server's active-run list says, on a reload, of Ada's run asked by m-1 (`threadId` is its root). */
const reloaded = (replyInThread: boolean) => {
  const state = seedState();
  state.activeRuns = {
    [ENG_ID]: [
      {
        runId: "r-reload",
        agentId: ADA_ID,
        channelId: ENG_ID,
        status: "running",
        threadId: "m-1",
        triggerMessageId: "m-1",
        replyInThread,
        workingMs: 2000,
        pendingMessageIds: [],
        background: false,
      },
    ],
  };
  return state;
};

test("a reload in a channel that answers in the channel itself: no line says the agent replies in a thread", async () => {
  await open(reloaded(false));
  await settle(4);
  expect(
    screen()
      .queryAllByRole("button", { name: /respondendo na thread/ })
      .map((b) => b.textContent),
  ).toEqual([]);
});

test("a reload while a run answers in the thread under its message: the line is still there", async () => {
  await open(reloaded(true));
  await settle(4);
  expect(
    within(rowOf("o login está devolvendo 401") as HTMLElement).getByRole("button", {
      name: /Ada está respondendo na thread/,
    }),
  ).toBeTruthy();
});

test("the first reply, live: the message's thread line takes the place of the replying line, its words stay in the thread", async () => {
  const { socket, state } = await open();
  const run = { threadId: "m-1", runId: "r-first", agentId: ADA_ID };
  await push(socket, { type: "agent.thinking", ...run });
  await settle(2);
  expect(
    within(rowOf("o login está devolvendo 401") as HTMLElement).getByRole("button", { name: /respondendo na thread/ }),
  ).toBeTruthy();

  // One statement on the server: the reply under m-1 and the thread it opens.
  const reply = {
    id: "m-first-reply",
    channelId: ENG_ID,
    threadId: "m-1",
    author: { type: "agent", id: ADA_ID },
    body: "Achei: o refresh compara segundos com milissegundos.",
    mentionedAgentIds: [],
    agentRunId: "r-first",
    createdAt: new Date().toISOString(),
  } as (typeof state.messages)[number];
  state.messages.push(reply);
  await state.openThread?.(ORG_ID, "m-1", reply.createdAt);
  // As `publishMessageCreated` sends it once committed: the message inline, nothing about its thread.
  await push(socket, { type: "message.created", messageId: reply.id, message: reply });
  await push(socket, { type: "agent.idle", ...run });
  await settle(6);

  const asked = rowOf("o login está devolvendo 401") as HTMLElement;
  expect(within(asked).getByRole("button", { name: /1 resposta/ }).className).toContain("thread-line");
  expect(within(asked).queryByRole("button", { name: /respondendo na thread/ })).toBeNull();
  expect(rowOf("o refresh compara segundos")).toBeUndefined();
});
