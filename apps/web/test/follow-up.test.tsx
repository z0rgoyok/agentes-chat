import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, type PendingReturn } from "@agenteschat/client";
import { formatTime } from "@agenteschat/client/lib/format";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const inMinutes = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const ret = (over: Partial<PendingReturn> = {}): PendingReturn => ({
  messageId: "l-1",
  agentId: ATLAS_ID,
  channelId: ENG_ID,
  channelKind: "channel",
  channelName: "eng",
  threadId: null,
  at: inMinutes(33),
  about: "rever o deploy de hoje",
  runId: "r-1",
  replyMessageId: "m-reply",
  held: false,
  canCancel: true,
  ...over,
});
/** The channel's own bar (the thread panel has its own). */
const bar = () => document.querySelector(".channel__composer > .ac-typing") as HTMLElement;
const words = () => bar().querySelector(".ac-typing__text")?.textContent ?? "";
const list = () => screen().getByRole("dialog", { name: "Retornos" });

const open = async (state: ReturnType<typeof seedState>, path = `/org/${ORG_ID}/c/${ENG_ID}`) => {
  const r = await renderApp(path, { api: createFakeApi(state) });
  await settle(6);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(3);
  return { ...r, socket };
};

test("a return leaves the conversation: no line in any state, its reply says it and the bar holds it", async () => {
  const state = seedState();
  const line = (id: string, refs: Record<string, string>, minutesAgo: number) => ({
    id,
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent" as const, id: ATLAS_ID },
    body: "Check CI run 42 and give the per-job times.",
    mentionedAgentIds: [],
    agentRunId: null,
    meta: { notice: { kind: "follow_up", text: "Check CI run 42 and give the per-job times.", refs } },
    createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  });
  const at = inMinutes(33);
  state.messages.push(
    line("l-1", { runId: "r-1", at, about: "rever o deploy de hoje", state: "pending" }, 4),
    line("l-0", { runId: "r-0", at, about: "olhar a fila", state: "canceled", canceledBy: "u-joao" }, 3),
    line("l-done", { runId: "r-0", at, about: "ver o CI", state: "done" }, 2),
    line("l-woke", { runId: "r-0", at, about: "ver o CI", wake: "1", followUpId: "l-done" }, 1),
  );
  state.followUps = [ret({ at })];
  await open(state);

  const text = () => document.body.textContent ?? "";
  for (const said of ["volta às", "não volta mais", "voltou", "olhar a fila"]) expect(text()).not.toContain(said);
  expect(screen().queryByRole("button", { name: "Cancelar" })).toBeNull();
  // Nobody works here: the bar rests in the live pill's box, quiet, with who, when and her words.
  expect(bar().dataset.rest).toBe("true");
  expect(bar().dataset.active).toBe("false");
  expect(words()).toBe(`Atlas retorna às ${formatTime("pt-BR", at)} · rever o deploy de hoje`);
  expect(bar().querySelectorAll(".ac-typing__tok").length).toBe(1);
  expect(bar().querySelector(".ac-typing__more")).toBeNull();
});

test("⋯ lists the returns here, the soonest first; × cancels for who may, then the row leaves and the bar shuts", async () => {
  const state = seedState();
  const soon = inMinutes(5);
  const later = inMinutes(33);
  state.followUps = [
    ret({ messageId: "l-1", at: soon, about: "ver o CI" }),
    ret({ messageId: "l-2", at: later }),
    ret({ messageId: "l-3", agentId: ADA_ID, at: inMinutes(50), about: "rever a fila", canCancel: false }),
  ];
  await open(state);

  // The soonest is named, one face per agent, "+2" for the rest.
  expect(words()).toBe(`Atlas retorna às ${formatTime("pt-BR", soon)} · ver o CI`);
  expect(bar().querySelectorAll(".ac-typing__tok").length).toBe(2);
  expect(bar().querySelector(".ac-typing__more")?.textContent).toBe("+2");

  await click(within(bar()).getByRole("button", { name: "Retornos" }));
  await settle(2);
  const rows = () => list().querySelectorAll(".pins-pop__item");
  expect([...rows()].map((r) => r.querySelector(".thread-pop__sub")?.textContent)).toEqual([
    "ver o CI",
    "rever o deploy de hoje",
    "rever a fila",
  ]);
  expect(rows()[0]?.querySelector(".pins-pop__time")?.textContent).toBe(formatTime("pt-BR", soon));
  // Only who may cancel gets the ×: here not Ada's.
  const crosses = within(list()).getAllByRole("button", { name: /^Cancelar o retorno/ });
  expect(crosses.map((b) => b.getAttribute("aria-label"))).toEqual([
    `Cancelar o retorno do Atlas às ${formatTime("pt-BR", soon)}`,
    `Cancelar o retorno do Atlas às ${formatTime("pt-BR", later)}`,
  ]);

  await click(crosses[0] as HTMLElement);
  await settle(3);
  expect(state.calls.filter((c) => c.method === "chat.cancelFollowUp").map((c) => c.args)).toEqual([[ORG_ID, "l-1"]]);
  expect(rows().length).toBe(2);
  // The next one shows.
  expect(words()).toBe(`Atlas retorna às ${formatTime("pt-BR", later)} · rever o deploy de hoje`);

  // A row goes to the reply that said it.
  await click(rows()[0]?.querySelector(".thread-pop__row") as HTMLElement);
  await settle(2);
  expect(screen().queryByRole("dialog", { name: "Retornos" })).toBeNull();

  // The last one may go too (Ada's stays hers to cancel): the bar keeps Ada's.
  await click(within(bar()).getByRole("button", { name: "Retornos" }));
  await settle(2);
  await click(within(list()).getByRole("button", { name: /^Cancelar o retorno/ }));
  await settle(4);
  expect(words()).toContain("rever a fila");
});

test("the last return canceled: the bar glides shut", async () => {
  const state = seedState();
  state.followUps = [ret()];
  await open(state);
  await click(within(bar()).getByRole("button", { name: "Retornos" }));
  await settle(2);
  await click(within(list()).getByRole("button", { name: /^Cancelar o retorno/ }));
  await settle(4);
  expect(bar().dataset.rest).toBeUndefined();
  expect(words()).toBe("");
});

test("a cancel the server refuses says why, and the return stays", async () => {
  const state = seedState();
  state.followUps = [ret()];
  // Its owner changed meanwhile: the × was there, the server says no.
  state.followUpCancelError = new ApiError(403, "follow_up.not_yours", "Only the person it is for");
  await open(state);
  await click(within(bar()).getByRole("button", { name: "Retornos" }));
  await settle(2);
  await click(within(list()).getByRole("button", { name: /^Cancelar o retorno/ }));
  await settle(3);
  expect(list().querySelectorAll(".pins-pop__item").length).toBe(1);
  expect(document.body.textContent).toContain(
    "Só a pessoa para quem é o retorno, o dono do agente ou um admin pode cancelar.",
  );
});

test("work comes first: an agent at work here takes the box, and the return comes back after", async () => {
  const state = seedState();
  state.followUps = [ret()];
  const { socket } = await open(state);
  const push = (event: Record<string, unknown>) =>
    act(async () =>
      socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, threadId: null, ...event } }),
    );
  await push({ type: "agent.thinking", runId: "r-ada", agentId: ADA_ID });
  await settle(2);
  expect(bar().dataset.active).toBe("true");
  expect(bar().dataset.rest).toBeUndefined();
  expect(bar().querySelector(".ac-typing__menu")).toBeNull();
  await push({ type: "run.finished", runId: "r-ada", agentId: ADA_ID, status: "done" });
  await settle(3);
  expect(bar().dataset.rest).toBe("true");
});

test("held on an answer: the amber mark for whoever may answer it, no time; the list's row says the same", async () => {
  const state = seedState();
  state.followUps = [ret({ at: inMinutes(-20), held: true })];
  await open(state);
  expect(words()).toBe("Atlas retorna quando você responder");
  expect(bar().querySelector(".rq-wait")).not.toBeNull();
  await click(within(bar()).getByRole("button", { name: "Retornos" }));
  await settle(2);
  expect(list().querySelector(".pins-pop__time .rq-wait")).not.toBeNull();
});

test("a thread's bar holds its own returns; the channel's, its main timeline's", async () => {
  const state = seedState();
  state.messages.push({
    id: "t-1",
    channelId: ENG_ID,
    threadId: "m-1",
    author: { type: "agent", id: ATLAS_ID },
    body: "Daqui a pouco vejo o resultado.",
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  });
  state.followUps = [ret({ threadId: "m-1", about: "no fio" })];
  await open(state, `/org/${ORG_ID}/c/${ENG_ID}?thread=m-1`);
  const panel = screen().getByRole("complementary", { name: "Thread" });
  expect(panel.querySelector(".ac-typing__text")?.textContent).toContain("no fio");
  expect(bar().dataset.rest).toBeUndefined();
});

test("worst case: three returns (the cap), two agents, a long name, 80-character words, more than 12 h away", async () => {
  const state = seedState();
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.name = "Assistente de Atendimento Internacional";
  // More than 12 h away and on the next day at any hour the suite runs: at 00:44, 23 h ahead is still today.
  const tomorrow = new Date(Math.max(Date.now() + 13 * 3600_000, new Date().setHours(24, 30, 0, 0))).toISOString();
  const after = (min: number) => new Date(Date.parse(tomorrow) + min * 60_000).toISOString();
  const about = "rever os pedidos de reembolso de outubro e responder quem pediu o valor em dobro";
  state.followUps = [
    ret({ messageId: "w-1", agentId: ADA_ID, at: tomorrow, about }),
    ret({ messageId: "w-2", agentId: ADA_ID, at: after(10) }),
    ret({ messageId: "w-3", at: after(20) }),
  ];
  await open(state);
  // Her 80 characters show whole or not at all: here they are in the box, on the line it hides when they don't fit.
  expect(words()).toBe(
    `Assistente de Atendimento Internacional retorna amanhã às ${formatTime("pt-BR", tomorrow)} · ${about}`,
  );
  expect(bar().querySelector(".ac-typing__more")?.textContent).toBe("+2");
  await click(within(bar()).getByRole("button", { name: "Retornos" }));
  await settle(2);
  expect(list().querySelectorAll(".pins-pop__item").length).toBe(3);
  expect(list().querySelector(".pins-pop__time")?.textContent).toBe(`amanhã ${formatTime("pt-BR", tomorrow)}`);
  expect(list().querySelector(".thread-pop__sub")?.textContent).toBe(about);
});

test("in English, 12-hour time; her words stay in the language she wrote them in", async () => {
  const state = seedState();
  const at = inMinutes(33);
  state.followUps = [ret({ at })];
  const { services } = await open(state);
  await act(async () => {
    await services.i18n.changeLanguage("en");
  });
  await settle(3);
  expect(formatTime("en", at)).toMatch(/[AP]M$/);
  expect(words()).toBe(`Atlas follows up at ${formatTime("en", at)} · rever o deploy de hoje`);
  await click(within(bar()).getByRole("button", { name: "Follow-ups" }));
  await settle(2);
  const crosses = within(screen().getByRole("dialog", { name: "Follow-ups" })).getAllByRole("button", {
    name: /^Cancel Atlas's follow-up/,
  });
  expect(crosses.map((b) => b.getAttribute("aria-label"))).toEqual([
    `Cancel Atlas's follow-up at ${formatTime("en", at)}`,
  ]);
});

test("a mention its message explains leaves the conversation; what stays opens people's words", async () => {
  const state = seedState();
  const said = (id: string, minutesAgo: number, body: string, meta?: Record<string, unknown>) => ({
    id,
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent" as const, id: ATLAS_ID },
    body,
    mentionedAgentIds: [],
    agentRunId: null,
    ...(meta ? { meta } : {}),
    createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  });
  const skipped = (messageId: string, reason: string) => ({
    notice: {
      kind: "wake_skipped",
      text: "@ada wasn't woken by your mention: only certain people may talk to it.",
      refs: { runId: "r2", messageId, agentHandles: "ada", reason },
    },
  });
  state.messages.push(
    said("m-back", 9, "O CI passou, todos os jobs em verde."),
    said("m-named", 8, "@ada confere a loja?", {
      reach: [{ agentId: ADA_ID, handle: "ada", reason: "audience", userId: "u-joao" }],
    }),
    said("m-skip-folded", 8, "@ada wasn't woken", skipped("m-named", "audience")),
    said("m-skip", 7, "@ada wasn't woken", skipped("elsewhere", "callable")),
  );
  // Only some people may talk to Ada: the message that named her says so, with the way to let João in.
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.audience = { mode: "people", userIds: ["u-walter"] };
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);

  const text = () => document.body.textContent ?? "";
  expect(screen().getByRole("button", { name: /Deixar João falar com/ })).toBeTruthy();
  expect(text()).toContain("O CI passou");
  // One line for the mention no message here explains; the other folded into its message's own line.
  expect(screen().getAllByText(/A menção de Atlas não chamou Ada/).length).toBe(1);
  await act(async () => fireEvent.click(screen().getByRole("button", { name: /^Ver$/ })));
  expect(text()).toContain("As configurações de Atlas não deixam chamar Ada");
  expect(text()).not.toContain("wasn't woken");
});
