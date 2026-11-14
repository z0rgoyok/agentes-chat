import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message, RunConsultation } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { askOf, type PendingAsk } from "@/components/RequestCard";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, LODI_ID, ORG_ID, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const RUN = "r-asked";
const QUESTION = "Como está a curva de juros hoje?";
const ANSWER = "A curva de 2 anos subiu 6 pb desde ontem.";
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

const consultation = (over: Partial<RunConsultation>): RunConsultation => ({
  id: "q1",
  runId: RUN,
  agentId: ADA_ID,
  consultedAgentId: ATLAS_ID,
  consultedRunId: "atlas-run",
  status: "open",
  waiting: null,
  question: QUESTION,
  answer: null,
  createdAt: ago(40),
  answeredAt: null,
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  ...over,
});

/** Ada's reply after asking (its run carries the questions), and the notice an answer came with. */
function withAsk(list: RunConsultation[], notice = false) {
  const state = seedState();
  state.messages.push({
    id: "msg-asked",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body: "Pedi a parte de juros ao Atlas; junto tudo quando chegar.",
    mentionedAgentIds: [],
    agentRunId: RUN,
    meta: {},
    createdAt: ago(45),
  });
  if (notice)
    state.messages.push({
      id: "msg-notice",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: ANSWER,
      mentionedAgentIds: [],
      agentRunId: null,
      meta: {
        notice: {
          kind: "consult_reply",
          text: ANSWER,
          from: "@atlas",
          refs: {
            consultationId: "q1",
            runId: RUN,
            askerAgentId: ADA_ID,
            agentId: ATLAS_ID,
            status: "answered",
            question: QUESTION,
            answer: ANSWER,
          },
        },
      },
      createdAt: ago(5),
    });
  state.consultations = { [ENG_ID]: list };
  return state;
}

/** What Ada and Atlas said for a question, as the dialog loads it (`GET …/consultations/{id}`): in their DM. */
function withTalk(state: ReturnType<typeof seedState>, c: RunConsultation, extra: Message[] = []) {
  const said = (id: string, from: string, body: string, runId: string, at: string): Message => ({
    id,
    channelId: "dm-ada-atlas",
    threadId: null,
    author: { type: "agent", id: from },
    body,
    mentionedAgentIds: [],
    agentRunId: runId,
    meta: {},
    createdAt: at,
  });
  state.consultationConversations = {
    [c.id]: {
      consultation: c,
      messages: [
        said("dm-q", ADA_ID, QUESTION, RUN, ago(40)),
        ...(c.answer ? [said("dm-a", ATLAS_ID, c.answer, "atlas-run", ago(5))] : []),
        ...extra,
      ],
    },
  };
  return state;
}
/** The two agents' conversation, opened over the conversation in the kit's dialog. */
const panel = () => document.querySelector(".ac-dialog.consult-dialog") as HTMLElement | null;
/** Its list's name: "Conversa entre Ada e Atlas". */
const panelLabel = () => panel()?.querySelector(".consult-dialog__list")?.getAttribute("aria-label");

/** The conversation went on after the reply that asked: `count` people's messages, so it sits farther up. */
function talkAfter(state: ReturnType<typeof seedState>, count: number) {
  for (let i = 0; i < count; i++)
    state.messages.push({
      id: `msg-talk-${i}`,
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-joao" },
      body: `Enquanto isso, item ${i + 1}.`,
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: ago(30 - i * 5),
    });
  state.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return state;
}

const open = async (state: ReturnType<typeof seedState>) => {
  const api = createFakeApi(state);
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(3);
  return { ...r, socket, state };
};
const asked = () =>
  screen()
    .getAllByRole("article")
    .find((a) => a.textContent?.includes("Pedi a parte de juros")) as HTMLElement;
/** The pair row ("Ada ⇄ Atlas · 2 min"), right before the reply that asked. */
const row = () => document.querySelector(".consult-pair") as HTMLElement | null;
const rowButton = () => row()?.querySelector("button") as HTMLElement;
const typingBar = () => document.querySelector(".ac-typing") as HTMLElement;
const bar = () => typingBar().querySelector(".ac-typing__text")?.textContent ?? "";
const push = (socket: { push: (f: unknown) => void }, event: Record<string, unknown>) =>
  act(async () =>
    socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, threadId: null, ...event } }),
  );
/** Ada's question going out, live: "Ada está perguntando para Atlas…" on the working line. */
const asking = { type: "agent.consulting", runId: RUN, agentId: ADA_ID, consultedAgentId: ATLAS_ID };

describe("the pair row before the reply that asked (ConsultPairRow)", () => {
  test("still out: the two faces, ⇄ and 'perguntando' with its clock, right before the reply, never the question", async () => {
    await open(withAsk([consultation({})]));
    const r = row() as HTMLElement;
    expect(r).not.toBeNull();
    expect(asked().previousElementSibling).toBe(r);
    expect([...r.querySelectorAll(".consult-pair__name")].map((n) => n.textContent)).toEqual(["Ada", "Atlas"]);
    expect(r.querySelectorAll(".ac-avatar")).toHaveLength(2);
    expect(r.querySelector(".consult-pair__word")?.textContent).toBe("perguntando");
    expect(r.querySelector(".consult-pair__time")?.textContent).toMatch(/^\d+ s$/);
    expect(r.querySelector(".consult-pair__row--live")).not.toBeNull();
    expect(r.textContent).not.toContain(QUESTION);
    // The reply under it shows its face and name again (not grouped under the message above).
    expect(asked().classList.contains("ac-msg--grouped")).toBe(false);
  });

  test("several agents fold into one row: stacked faces, 'Atlas e mais 1', the count while out", async () => {
    const state = withAsk([consultation({}), consultation({ id: "q2", consultedAgentId: "agent-iris" })]);
    const atlas = state.agents.find((a) => a.id === ATLAS_ID);
    if (atlas) state.agents.push({ ...atlas, id: "agent-iris", name: "Iris", handle: "iris" });
    await open(state);
    expect(document.querySelectorAll(".consult-pair")).toHaveLength(1);
    const r = row() as HTMLElement;
    expect(r.querySelectorAll(".consult-pair__faces .ac-avatar")).toHaveLength(2);
    expect(r.textContent).toContain("Atlas e mais 1");
    expect(r.querySelector(".consult-pair__word")?.textContent).toBe("0 de 2");
    expect(rowButton().getAttribute("title")).toBe("Conversas de Ada com Atlas e Iris");
  });

  test("long names wrap whole on the row, never cut: one sentence, each face with its name's first word", async () => {
    const state = withAsk([consultation({}), consultation({ id: "q2", consultedAgentId: "agent-iris" })]);
    const ada = state.agents.find((a) => a.id === ADA_ID);
    const atlas = state.agents.find((a) => a.id === ATLAS_ID);
    if (!ada || !atlas) throw new Error("no agents");
    ada.name = "Assistente de Atendimento ao Cliente";
    atlas.name = "Especialista em Faturamento Recorrente";
    state.agents.push({ ...atlas, id: "agent-iris", name: "Iris", handle: "iris" });
    await open(state);
    const r = row() as HTMLElement;
    expect([...r.querySelectorAll(".consult-pair__name")].map((n) => n.textContent)).toEqual([
      "Assistente de Atendimento ao Cliente",
      "Especialista em Faturamento Recorrente e mais 1",
    ]);
    // One sentence: each face keeps its name's first word (`__who`), the · follows the second name's last word.
    const who = [...r.querySelectorAll(".consult-pair__row > .consult-pair__who")];
    expect(who).toHaveLength(2);
    expect(who[0]?.firstElementChild?.matches(".ac-avatar")).toBe(true);
    expect(who[1]?.firstElementChild?.matches(".consult-pair__faces")).toBe(true);
    expect(r.querySelector(".consult-pair__who + .consult-pair__sep")).not.toBeNull();
  });

  test("waiting on a person, for its computer, on what it handed on: a short word in the same slot, quiet", async () => {
    await open(withAsk([consultation({ waiting: "approval" })]));
    expect(row()?.querySelector(".consult-pair__word")?.textContent).toBe("esperando aprovação");
    cleanup();
    await open(withAsk([consultation({ waiting: "computer" })]));
    expect(row()?.querySelector(".consult-pair__word")?.textContent).toBe("esperando o computador");
    // It waits on no one here: the words quiet, the arrows still, no halo (ADR 0095 addendum).
    expect(row()?.querySelector(".consult-pair__row--wait")).not.toBeNull();
    expect(row()?.querySelector(".consult-pair__row--live")).toBeNull();
    cleanup();
    await open(withAsk([consultation({ waiting: "queued" })]));
    expect(row()?.querySelector(".consult-pair__word")?.textContent).toBe("na fila");
  });

  test("work handed off, its part done: 'esperando outros agentes', and the dialog opens it as a request", async () => {
    const c = consultation({ kind: "note", waiting: "agents" });
    await open(withTalk(withAsk([c]), c));
    expect(row()?.querySelector(".consult-pair__word")?.textContent).toBe("esperando outros agentes");
    await act(async () => fireEvent.click(rowButton()));
    await settle(3);
    const side = panel() as HTMLElement;
    expect(side.textContent).toContain("Ada fez um pedido para Atlas em #eng");
    expect(side.textContent).toContain("O Atlas passou uma parte adiante e espera o retorno");
  });

  test("some never answered: '1 de 2 responderam' in the warning tone, the one that didn't dimmed", async () => {
    const state = withAsk([
      consultation({ status: "answered", answer: ANSWER, answeredAt: ago(5) }),
      consultation({
        id: "q2",
        kind: "note",
        consultedAgentId: "agent-iris",
        status: "failed",
        answer: "stopped by a person",
        answeredAt: ago(2),
      }),
    ]);
    const atlas = state.agents.find((a) => a.id === ATLAS_ID);
    if (atlas) state.agents.push({ ...atlas, id: "agent-iris", name: "Iris", handle: "iris" });
    await open(state);
    const r = row() as HTMLElement;
    expect(r.querySelector(".consult-pair__row--bad .consult-pair__word")?.textContent).toBe("1 de 2 responderam");
    expect(r.querySelectorAll(".consult-pair__off")).toHaveLength(1);
    expect(r.querySelector(".consult-pair__time")).toBeNull();
  });

  test("answered: how long it took, no answer in the channel; a click opens the conversation in the dialog", async () => {
    const c = consultation({ status: "answered", answer: ANSWER, answeredAt: ago(5) });
    await open(withTalk(withAsk([c], true), c));
    const r = row() as HTMLElement;
    expect(r.querySelector(".consult-pair__word")).toBeNull();
    expect(r.querySelector(".consult-pair__time")?.textContent).toBe("levou 35 s");
    // The answer shows nowhere in the channel: the `consult_reply` notice folds away (no second row, no line).
    expect(document.querySelectorAll(".consult-pair")).toHaveLength(1);
    expect(document.querySelector("main")?.textContent).not.toContain("subiu 6 pb");
    expect(document.body.textContent).not.toContain("respondeu à pergunta");
    await act(async () => fireEvent.click(rowButton()));
    await settle(3);
    expect(r.querySelector(".consult-pair__detail")).toBeNull();
    const side = panel() as HTMLElement;
    expect(panelLabel()).toBe("Conversa entre Ada e Atlas");
    expect(side.textContent).toContain(QUESTION);
    expect(side.textContent).toContain("subiu 6 pb");
    expect(rowButton().getAttribute("aria-pressed")).toBe("true");
    // Read only: no composer there, a note instead.
    expect(within(side).queryByRole("combobox")).toBeNull();
    expect(side.textContent).toContain("Só leitura.");
  });

  test("still out: the dialog says Atlas works on it; 'Falar com a Ada' closes it and mentions her", async () => {
    const c = consultation({});
    await open(withTalk(withAsk([c]), c));
    await act(async () => fireEvent.click(rowButton()));
    await settle(3);
    const side = panel() as HTMLElement;
    expect(side.textContent).toContain(QUESTION);
    expect(side.textContent).toContain("Atlas está trabalhando");
    await act(async () => fireEvent.click(within(side).getByRole("button", { name: "Falar com a Ada" })));
    await settle(1);
    expect(panel()).toBeNull();
    const box = screen().getByRole("combobox", { name: "Mensagem para #eng" }) as HTMLTextAreaElement;
    expect(box.value).toContain("@ada");
  });

  test("a question card in the dialog answers in place: 'Responder' opens its field there", async () => {
    const c = consultation({ waiting: "input" });
    const asks: Message = {
      id: "msg-atlas-question",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ATLAS_ID },
      body: "Uso a fonte paga?",
      mentionedAgentIds: [],
      agentRunId: "atlas-run",
      meta: {
        question: {
          id: "aq1",
          agentId: ATLAS_ID,
          channelId: ENG_ID,
          threadId: null,
          messageId: "msg-atlas-question",
          runId: "atlas-run",
          text: "Uso a fonte paga para a curva?",
          choices: null,
          status: "open",
          answer: null,
          answeredByUserId: null,
        },
      },
      createdAt: ago(20),
    };
    const { state } = await open(withTalk(withAsk([c]), c, [asks]));
    expect(row()?.querySelector(".consult-pair__word")?.textContent).toBe("esperando uma resposta");
    await act(async () => fireEvent.click(rowButton()));
    await settle(3);
    const side = panel() as HTMLElement;
    expect(side.textContent).toContain("Uso a fonte paga para a curva?");
    await act(async () => fireEvent.click(within(side).getByRole("button", { name: "Responder" })));
    await settle(1);
    const field = within(side).getByRole("textbox", { name: "Sua resposta" });
    expect(document.activeElement === field).toBe(true);
    await act(async () => fireEvent.change(field, { target: { value: "Pode usar" } }));
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    await settle(4);
    // The answer goes to the question itself, from the dialog (the fake keeps the agents' DM elsewhere).
    expect(state.calls.find((call) => call.method === "questions.answer")?.args).toEqual([
      ORG_ID,
      "aq1",
      { text: "Pode usar" },
    ]);
  });

  test("a card the consulted agent posts here says whom it helps, and opens the conversation", async () => {
    const c = consultation({ waiting: "input" });
    const state = withTalk(withAsk([c]), c);
    state.messages.push({
      id: "msg-atlas-asks",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ATLAS_ID },
      body: "Posso usar a fonte paga para a curva?",
      mentionedAgentIds: [],
      agentRunId: "atlas-run",
      meta: {},
      createdAt: ago(20),
    });
    await open(state);
    const card = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("fonte paga")) as HTMLElement;
    expect(card.textContent).toContain("ajudando a Ada");
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Ver conversa" })));
    await settle(3);
    expect(panelLabel()).toBe("Conversa entre Ada e Atlas");
    // Over the conversation, in the kit's modal dialog, as a long message opens whole.
    expect(panel()?.getAttribute("role")).toBe("dialog");
    expect(document.querySelector("aside.thread-panel")).toBeNull();
  });

  test("the answer far below its question: the same pair row where it arrived, opening the conversation", async () => {
    const c = consultation({ status: "answered", answer: ANSWER, answeredAt: ago(5) });
    await open(talkAfter(withTalk(withAsk([c], true), c), 3));
    const rows = [...document.querySelectorAll(".consult-pair")] as HTMLElement[];
    expect(rows).toHaveLength(2);
    const far = rows.find((r) => r.parentElement?.getAttribute("data-message-id") === "msg-notice") as HTMLElement;
    expect([...far.querySelectorAll(".consult-pair__name")].map((n) => n.textContent)).toEqual(["Ada", "Atlas"]);
    expect(far.textContent).not.toContain("subiu 6 pb");
    expect(document.body.textContent).not.toContain("respondeu à pergunta");
    await act(async () => fireEvent.click(far.querySelector("button") as HTMLElement));
    await settle(3);
    // The two agents' conversation over the channel: the question and the whole answer.
    expect(panel()?.textContent).toContain(QUESTION);
    expect(panel()?.textContent).toContain("subiu 6 pb");
  });

  test("an agent @named outside the conversation got it by direct message: the pair row on the reach line, no 'Entregue ao', not twice", async () => {
    const relayed = `[@ada mentioned you in #engenharia, where you aren't a member, so it reaches you here]\n\n${QUESTION}`;
    const c = consultation({ kind: "note", question: relayed });
    const state = withTalk(withAsk([c]), c);
    const ask = state.messages.find((m) => m.id === "msg-asked");
    if (ask)
      ask.meta = { reach: [{ agentId: ATLAS_ID, handle: "atlas", reason: "not_in_channel", consultationId: "q1" }] };
    await open(state);
    expect(document.body.textContent).not.toContain("Entregue ao");
    // The reply's own row leaves it to the reach line: one row for the hand-off.
    expect(document.querySelectorAll(".consult-pair")).toHaveLength(1);
    const reach = screen().getByRole("group", { name: "Quem a mensagem não chamou direto" });
    const r = reach.querySelector(".consult-pair") as HTMLElement;
    expect([...r.querySelectorAll(".consult-pair__name")].map((n) => n.textContent)).toEqual(["Ada", "Atlas"]);
    expect(r.querySelector(".consult-pair__word")?.textContent).toBe("trabalhando");
    await act(async () => fireEvent.click(r.querySelector("button") as HTMLElement));
    await settle(3);
    expect(panelLabel()).toBe("Conversa entre Ada e Atlas");
    expect(panel()?.textContent).not.toContain("mentioned you");
  });

  test("the row offers Adicionar ao canal for a teammate, as a text action; never for the right hand, which joins no channel", async () => {
    const reachOf = (agentId: string, handle: string) => {
      const c = consultation({ kind: "note", consultedAgentId: agentId });
      const state = withRightHand(withTalk(withAsk([c]), c));
      const ask = state.messages.find((m) => m.id === "msg-asked");
      if (ask) ask.meta = { reach: [{ agentId, handle, reason: "not_in_channel", consultationId: "q1" }] };
      return state;
    };
    await open(reachOf(ATLAS_ID, "atlas"));
    const reach = () => screen().getByRole("group", { name: "Quem a mensagem não chamou direto" });
    expect(within(reach()).getByRole("button", { name: "Adicionar ao canal" }).className).toBe("ag-rc__btn");
    cleanup();
    await open(reachOf(LODI_ID, "lodi"));
    expect(reach().querySelector(".consult-pair")).toBeTruthy();
    expect(within(reach()).queryByRole("button", { name: "Adicionar ao canal" })).toBeNull();
  });

  test("a hand-off older than the conversation's list goes back is still the pair row, never 'Entregue ao'", async () => {
    const c = consultation({ kind: "note", status: "answered", answer: ANSWER, answeredAt: ago(5) });
    // The list holds only the latest questions: this one is loaded on its own.
    const state = withTalk(withAsk([]), c);
    const ask = state.messages.find((m) => m.id === "msg-asked");
    if (ask)
      ask.meta = { reach: [{ agentId: ATLAS_ID, handle: "atlas", reason: "not_in_channel", consultationId: "q1" }] };
    await open(state);
    await settle(3);
    expect(document.body.textContent).not.toContain("Entregue ao");
    const reach = screen().getByRole("group", { name: "Quem a mensagem não chamou direto" });
    const r = reach.querySelector(".consult-pair") as HTMLElement;
    expect([...r.querySelectorAll(".consult-pair__name")].map((n) => n.textContent)).toEqual(["Ada", "Atlas"]);
    expect(document.querySelectorAll(".consult-pair")).toHaveLength(1);
  });

  test("without questions the reply has no row before it; the notice draws its own, with no answer in it", async () => {
    await open(withAsk([], true));
    expect(asked().previousElementSibling?.classList.contains("consult-pair")).toBe(false);
    const r = row() as HTMLElement;
    expect(r.parentElement?.getAttribute("data-message-id")).toBe("msg-notice");
    expect(r.textContent).not.toContain("subiu 6 pb");
  });

  test("the reply that asked isn't loaded here: the notice is a pair row that opens the dialog, never in place", async () => {
    const c = consultation({ status: "answered", answer: ANSWER, answeredAt: ago(5) });
    const state = withTalk(withAsk([c], true), c);
    // The asking reply is further up, not paged in: only the notice is here.
    state.messages = state.messages.filter((m) => m.id !== "msg-asked");
    await open(state);
    expect(document.querySelectorAll(".consult-pair")).toHaveLength(1);
    expect(document.querySelector("main")?.textContent).not.toContain("subiu 6 pb");
    await act(async () => fireEvent.click(rowButton()));
    await settle(3);
    expect(row()?.querySelector(".consult-pair__detail")).toBeNull();
    expect(panelLabel()).toBe("Conversa entre Ada e Atlas");
    expect(panel()?.textContent).toContain("subiu 6 pb");
    expect(rowButton().getAttribute("aria-pressed")).toBe("true");
  });

  test("an event reloads the list: the answer coming in turns the same row to its time", async () => {
    const { socket, state } = await open(withAsk([consultation({})]));
    expect(row()?.querySelector(".consult-pair__word")?.textContent).toBe("perguntando");
    state.consultations = {
      [ENG_ID]: [consultation({ status: "answered", answer: ANSWER, answeredAt: ago(1) })],
    };
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: {
          type: "agent.consulted",
          channelId: ENG_ID,
          threadId: null,
          runId: RUN,
          agentId: ADA_ID,
          consultedAgentId: ATLAS_ID,
          status: "answered",
        },
      }),
    );
    await settle(5);
    const r = row() as HTMLElement;
    expect(r.querySelector(".consult-pair__word")).toBeNull();
    expect(r.querySelector(".consult-pair__row--live")).toBeNull();
    expect(r.querySelector(".consult-pair__time")?.textContent).toMatch(/^levou \d+ s$/);
    expect(r.textContent).not.toContain("subiu 6 pb");
  });
});

describe("the working line while the row shows the questions", () => {
  test("the reply that asked is close: its row says it, the line doesn't; the asker's own work stays", async () => {
    const { socket } = await open(withAsk([consultation({})]));
    await push(socket, asking);
    await settle(2);
    expect(row()?.querySelector(".consult-pair__word")?.textContent).toBe("perguntando");
    expect(bar()).toBe("");
    expect(typingBar().getAttribute("data-active")).toBe("false");
    // Ada at work again (another turn): her own line, not the question.
    await push(socket, { type: "agent.thinking", runId: "r-next", agentId: ADA_ID });
    await settle(2);
    expect(bar()).toBe("Ada pensando…");
  });

  test("the asker back at work: no row shows its questions until its reply comes, so the line says them", async () => {
    const { socket } = await open(withAsk([consultation({})]));
    await push(socket, { type: "agent.thinking", runId: RUN, agentId: ADA_ID });
    await push(socket, asking);
    await settle(2);
    expect(row()).toBeNull();
    expect(bar()).toBe("Ada está perguntando para Atlas…");
  });

  test("the reply that asked is farther up: the line still says it (the only sign at the bottom)", async () => {
    const { socket } = await open(talkAfter(withAsk([consultation({})]), 3));
    await push(socket, asking);
    await settle(2);
    expect(bar()).toBe("Ada está perguntando para Atlas…");
    expect(typingBar().querySelector(".ac-typing__clock")).not.toBeNull();
  });
});

describe("the bar above the composer speaks for a hand-off (ADR 0095 addendum)", () => {
  test("work handed off from here: the other agent at work with the hand-off's time, Ver opens their talk", async () => {
    const c = consultation({ kind: "note" });
    const { socket } = await open(withTalk(withAsk([c]), c));
    await push(socket, { ...asking, kind: "note" });
    await settle(2);
    expect(bar()).toBe("Atlas está trabalhando…");
    expect(typingBar().getAttribute("data-consult")).toBe("work");
    // Its time is the lists' clock, never a question's "0:41".
    expect(typingBar().querySelector(".ac-typing__clock")).toBeNull();
    expect(typingBar().querySelector(".ac-typing__elapsed")?.textContent).toMatch(/ s$/);
    // No stop: stopping another agent's work is in their talk, Agora and the task manager.
    expect(typingBar().querySelector("[aria-label^='Parar']")).toBeNull();
    await act(async () => fireEvent.click(within(typingBar()).getByRole("button", { name: "Ver" })));
    await settle(3);
    expect(panel()).not.toBeNull();
  });

  test("waiting on someone else's approval: quiet, with the wait's own clock", async () => {
    const c = consultation({ kind: "note", waiting: "approval", waitingSince: ago(180) });
    const { socket } = await open(withAsk([c]));
    await push(socket, { ...asking, kind: "note" });
    await settle(2);
    expect(bar()).toBe("O Atlas espera uma aprovação…");
    expect(typingBar().getAttribute("data-consult")).toBe("wait");
    expect(typingBar().querySelector(".ac-typing__elapsed")?.textContent).toBe("3 min");
  });

  test("done: the other agent finished and the one who handed it writes", async () => {
    const c = consultation({ kind: "note" });
    const { socket } = await open(withAsk([c]));
    await push(socket, { ...asking, kind: "note" });
    await push(socket, {
      type: "agent.consulted",
      runId: RUN,
      agentId: ADA_ID,
      consultedAgentId: ATLAS_ID,
      status: "answered",
      kind: "note",
    });
    await settle(2);
    expect(bar()).toBe("Atlas terminou. Ada está escrevendo…");
  });
});

describe("whose card waits on you (ADR 0095 addendum)", () => {
  test("a hand-off's own run's card, never another run's of the same agent", () => {
    const other: PendingAsk = { id: "a-other", kind: "approval", agentId: ATLAS_ID, runId: "atlas-2", what: "Deploy" };
    const mine: PendingAsk = { id: "a-mine", kind: "question", agentId: ATLAS_ID, runId: "atlas-run", what: "Qual?" };
    expect(askOf([other, mine], ATLAS_ID, "atlas-run")).toMatchObject({ ask: { id: "a-mine" }, on: "answer" });
    // Atlas asks you from another run while the hand-off works: the hand-off is at work, never amber.
    expect(askOf([other], ATLAS_ID, "atlas-run")).toBeNull();
    // Before the list names the hand-off's run, the agent's card stands for it.
    expect(askOf([other], ATLAS_ID)?.ask.id).toBe("a-other");
  });
});
