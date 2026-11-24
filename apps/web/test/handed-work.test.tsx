import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Issue, Message, WorkView } from "@agenteschat/client";
import { cleanup } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle, showIn } from "./render";

afterEach(() => cleanup());

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

/** Ada handed the October sales report to Atlas; it reports where Walter asked. */
const work = (over: Partial<WorkView> = {}): WorkView => ({
  id: "w-handed",
  agentId: ATLAS_ID,
  channelId: ENG_ID,
  title: "October sales report",
  status: "live",
  state: "working",
  how: "handed",
  anchorMessageId: "note-1",
  threadId: null,
  homeThreadId: null,
  runId: "run-atlas",
  requestedByUserId: "u-walter",
  startedAt: ago(2),
  finishedAt: null,
  nextUpdateAt: ago(-8),
  lastUpdate: null,
  question: null,
  plan: [],
  issue: null,
  resultMessageId: null,
  queuePosition: null,
  pausedUntil: null,
  canceledByUserId: null,
  errorCode: null,
  handedBy: { agentId: ADA_ID, consultationId: "c-1" },
  askerRunId: "run-ada",
  planStep: { current: 3, total: 5 },
  result: null,
  ...over,
});

const message = (id: string, body: string, over: Partial<Message> = {}): Message =>
  ({
    id,
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body,
    mentionedAgentIds: [],
    agentRunId: "run-ada",
    createdAt: ago(3),
    ...over,
  }) as Message;

async function chat(view: WorkView) {
  const state = seedState();
  state.messages = state.messages.filter((m) => m.channelId !== ENG_ID);
  state.messages.push(
    message("ask", "Can you get the October sales report ready?", {
      author: { type: "person", id: "u-walter" },
      agentRunId: null,
      createdAt: ago(4),
    }),
  );
  state.messages.push(message("reply", "I've handed this to Atlas.", { handedWorks: [view] }));
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(8);
  await showIn(r.services, "en");
  return document.querySelector(".handed-line") as HTMLElement | null;
}

describe("the handed line under the reply that handed it (F1)", () => {
  test("working: handed to Atlas, the state in the agent's colour, its step and its time, and Stop", async () => {
    const line = await chat(work());
    expect(line?.classList.contains("ac-workline--working")).toBe(true);
    expect(line?.querySelector(".ac-workline__text")?.textContent).toContain(
      "Handed to Atlas · working on it · step\u00a03\u00a0of\u00a05 · 2\u00a0min",
    );
    expect(line?.querySelector(".handed-line__who .ac-avatar")).not.toBeNull();
    // View opens the two agents' talk, as the bar's does.
    expect([...(line?.querySelectorAll(".ac-workline__action") ?? [])].map((b) => b.textContent)).toEqual([
      "View",
      "Stop",
    ]);
    // No task label, no repeated update: the chip above and the messages below say them.
    expect(line?.textContent).not.toContain("Task #");
  });

  test("waiting on the reader: amber, with what it waits for", async () => {
    const asked = { text: "5 people or 12?", messageId: "q-1", requestedForUserId: "u-walter" };
    const line = await chat(work({ state: "waiting_input", question: asked, startedAt: ago(1) }));
    expect(line?.classList.contains("ac-workline--waiting")).toBe(true);
    expect(line?.querySelector(".handed-line__state")?.textContent).toBe("waiting for your answer");
    expect(line?.querySelector(".ac-workline__question")).toBeNull();
  });

  test("done: how long it took, and See the result", async () => {
    const done = work({ status: "done", state: null, startedAt: ago(10), finishedAt: ago(0), resultMessageId: "r-1" });
    const line = await chat(done);
    expect(line?.querySelector(".ac-workline__text")?.textContent).toContain("Handed to Atlas · done in 10\u00a0min");
    expect([...(line?.querySelectorAll(".ac-workline__action") ?? [])].map((b) => b.textContent)).toEqual([
      "See the result",
    ]);
  });
});

describe("handed tasks on the board (F2)", () => {
  const board = async (change: Partial<Issue>) => {
    const api = createFakeApi(seedState());
    const list = api.issues.list;
    api.issues.list = async (orgId, filters) =>
      (await list(orgId, filters)).map((i, k) => (k === 0 ? { ...i, ...change } : i));
    const r = await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(8);
    await showIn(r.services, "en");
    return document.querySelector<HTMLElement>(".ac-factline__fact[data-fact='handed']");
  };

  test("a handed task's card says who handed it, with their face", async () => {
    const fact = await board({ backgroundWork: work() });
    expect(fact?.textContent).toBe("handed by Ada");
    expect(fact?.querySelector(".ac-avatar")).not.toBeNull();
  });

  test("once done, the card carries what came of it", async () => {
    const result = { text: "Draft saved in Drive.", messageId: "r-1" };
    await board({ status: "done", backgroundWork: work({ status: "done", state: null, result }) });
    expect(document.querySelector(".issue-card__result")?.textContent).toBe("Draft saved in Drive.");
  });
});
