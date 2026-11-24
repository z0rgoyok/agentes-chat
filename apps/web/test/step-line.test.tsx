import { afterEach, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

afterEach(() => {
  cleanup();
  setSystemTime();
});

/** The bar's words for an agent at work. */
const barStep = () => document.querySelector(".ac-typing__step")?.textContent ?? null;

test("the bar says the agent's own words for its step once the turn is past a few seconds, and drops them with the answer", async () => {
  const start = new Date(2026, 10, 6, 20, 17, 0);
  setSystemTime(start);
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  const ev = (event: Record<string, unknown>) =>
    act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
  const ids = { threadId: null, runId: "r-live", agentId: ADA_ID };
  await ev({ type: "agent.run", ...ids, status: "running" });
  await ev({ type: "agent.step", ...ids, tool: "Read", said: "Vou ler o painel de tarefas do app" });
  await settle(2);
  // A quick turn shows nothing new.
  expect(barStep()).toBe("pensando…");

  setSystemTime(new Date(start.getTime() + 26_000));
  await act(async () => new Promise((done) => setTimeout(done, 1100)));
  await settle(2);
  expect(barStep()).toBe("“Vou ler o painel de tarefas do app”");

  await ev({ type: "agent.typing", ...ids });
  await settle(3);
  // Its answer is on its way: the words go, the bar says it writes (the answer shows whole once posted).
  expect(barStep()).toBe("escrevendo…");
});

test("the bar says what the agent is about to do as soon as the server writes it, until its own line comes", async () => {
  const start = new Date(2026, 10, 6, 20, 17, 0);
  setSystemTime(start);
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  const ev = (event: Record<string, unknown>) =>
    act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
  const ids = { threadId: null, runId: "r-live", agentId: ADA_ID };
  await ev({ type: "agent.run", ...ids, status: "running" });
  await ev({ type: "agent.typing", ...ids });
  await settle(2);
  expect(barStep()).toBe("escrevendo…");

  await ev({ type: "agent.intent", ...ids, text: "Procurando o e-mail do dono do workspace" });
  await settle(2);
  expect(barStep()).toBe("procurando o e-mail do dono do workspace…");
  (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();

  await ev({
    type: "message.created",
    message: {
      id: "m-said",
      channelId: ENG_ID,
      threadId: null,
      agentRunId: null,
      author: { type: "agent", id: ADA_ID },
      body: "Vou procurar na lista de membros e já te digo.",
      mentionedAgentIds: [],
      meta: { sayNow: { runId: "r-live" } },
      createdAt: new Date(start.getTime() + 3000).toISOString(),
    },
  });
  await settle(2);
  expect(barStep()).toBe("escrevendo…");
});
