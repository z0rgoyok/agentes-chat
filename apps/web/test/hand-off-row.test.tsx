import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message, RunConsultation, WorkView } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

afterEach(() => cleanup());

const QUESTION = "Relatório de vendas de outubro: total por região e o que mudou desde setembro.";
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

/** Atlas's request to Ada for me, as its row lands in my DM with Ada (`hand_off`), open or settled. */
function withHandOff(status: "open" | "answered" | "failed", question = QUESTION) {
  const state = seedState();
  const channelId = seedDm(
    state,
    { type: "agent", id: ADA_ID },
    { ago: 30, body: "Bom dia. Hoje cuido das métricas." },
  );
  const refs: Record<string, string> = {
    consultationId: "c-handed",
    askerAgentId: ATLAS_ID,
    agentId: ADA_ID,
    askedIn: ENG_ID,
    kind: "note",
    status,
    question,
    createdAt: ago(240),
    ...(status === "open" ? {} : { answeredAt: ago(60) }),
  };
  const row: Message = {
    id: "m-handed",
    channelId,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body: "atlas: x",
    mentionedAgentIds: [],
    agentRunId: null,
    meta: { notice: { kind: "hand_off", text: `"${question}"`, from: "@atlas", refs } },
    createdAt: ago(240),
  };
  state.messages.push(row);
  const consultation: RunConsultation = {
    id: "c-handed",
    kind: "note",
    runId: "r-atlas",
    agentId: ATLAS_ID,
    consultedAgentId: ADA_ID,
    consultedRunId: "r-ada",
    status: status === "open" ? "open" : status,
    waiting: null,
    question,
    answer: status === "answered" ? "Pronto. Está no Drive em Vendas/Outubro." : null,
    createdAt: ago(240),
    answeredAt: status === "open" ? null : ago(60),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
  state.consultationConversations = {
    "c-handed": {
      consultation,
      messages: [
        {
          id: "dm-note",
          channelId: "dm-atlas-ada",
          threadId: null,
          author: { type: "agent", id: ATLAS_ID },
          body: question,
          mentionedAgentIds: [],
          agentRunId: "r-atlas",
          meta: {},
          createdAt: ago(240),
        },
      ],
    },
  };
  return state;
}

const open = async (state: ReturnType<typeof seedState>) => {
  const api = createFakeApi(state);
  const r = await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api });
  await settle(5);
  await act(async () => r.sockets.last().open());
  await settle(3);
  return r;
};
const row = () => document.querySelector(".consult-pair__row") as HTMLElement | null;

describe("another agent's request in my DM with the agent it went to", () => {
  test("one quiet row: who asked whom for me, what and where, then how long it took; a click opens the exchange", async () => {
    await open(withHandOff("answered"));
    expect(row()?.textContent).toContain("Atlas");
    expect(row()?.querySelector(".consult-pair__asked")?.textContent).toBe("pediu à");
    expect(row()?.querySelector(".consult-pair__for")?.textContent).toBe("por você");
    expect(row()?.querySelector(".consult-pair__where")?.textContent).toContain("em #eng");
    expect(row()?.textContent).toContain("Relatório de vendas de outubro");
    expect(row()?.textContent).toContain("levou 3 min");
    // Keeps its subject on a phone-wide line, where other pair rows drop theirs (layout.css).
    expect(row()?.className).toContain("consult-pair__row--handed");
    await act(async () => fireEvent.click(row() as HTMLElement));
    await settle(3);
    const dialog = document.querySelector(".ac-dialog.consult-dialog");
    expect(dialog?.textContent).toContain("Atlas");
    expect(dialog?.textContent).toContain("Só leitura.");
    (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
  });

  test("while it is out, the row says nothing about its state", async () => {
    await open(withHandOff("open"));
    expect(row()?.textContent).toContain("Relatório de vendas de outubro");
    expect(row()?.textContent).not.toContain("trabalhando");
    expect(row()?.querySelector(".consult-pair__time")).toBeNull();
    expect(row()?.className).not.toContain("consult-pair__row--live");
  });

  test("one that couldn't finish says so", async () => {
    await open(withHandOff("failed"));
    expect(row()?.textContent).toContain("não terminou");
  });

  test("a long request: its subject, as every pair row names one (the whole request opens with the exchange)", async () => {
    const long = `${"Consolidar as vendas de todas as regiões ".repeat(4)}fim`;
    await open(withHandOff("answered", long));
    expect(row()?.textContent).toContain("Consolidar as vendas de todas as regiões");
    expect(row()?.textContent).toContain("levou 3 min");
    (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
  });

  test("beside a handed line in the same DM: each hand-off drawn once, neither hiding the other", async () => {
    const state = withHandOff("answered");
    const channelId = `dm-${ADA_ID}`;
    // Later I asked Ada here and she handed it on to Atlas: that work reports here, under her reply.
    const handed: WorkView = {
      id: "w-on",
      agentId: ATLAS_ID,
      channelId,
      title: "Gráfico por região",
      status: "live",
      state: "working",
      how: "handed",
      anchorMessageId: "note-on",
      threadId: null,
      homeThreadId: null,
      runId: "r-atlas-on",
      requestedByUserId: "u-walter",
      startedAt: ago(30),
      finishedAt: null,
      nextUpdateAt: ago(-480),
      lastUpdate: null,
      question: null,
      plan: [],
      issue: null,
      resultMessageId: null,
      queuePosition: null,
      pausedUntil: null,
      canceledByUserId: null,
      errorCode: null,
      handedBy: { agentId: ADA_ID, consultationId: "c-on" },
      askerRunId: "r-ada-here",
      planStep: null,
      result: null,
    };
    state.messages.push({
      id: "m-ada-here",
      channelId,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "Passei o gráfico para o Atlas.",
      mentionedAgentIds: [],
      agentRunId: "r-ada-here",
      meta: {},
      handedWorks: [handed],
      createdAt: ago(40),
    } as Message);
    await open(state);
    const rows = [...document.querySelectorAll(".consult-pair__row")];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector(".consult-pair__asked")).not.toBeNull();
    expect(document.querySelectorAll(".handed-line")).toHaveLength(1);
  });
});
