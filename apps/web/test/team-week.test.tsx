import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentAction, Message, Proposal } from "@agenteschat/client";
import type { TeamWeekCard } from "@agenteschat/client/lib/team-week";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import {
  ADA_ID,
  ATLAS_ID,
  createFakeApi,
  GENERAL_ID,
  LODI_ID,
  ORG_ID,
  seedDm,
  seedState,
  withRightHand,
} from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, settle } from "./render";

afterEach(cleanup);

const card = (over: Partial<TeamWeekCard> = {}): TeamWeekCard => ({
  kind: "team_week",
  forUserId: "u-walter",
  from: "2026-10-30",
  to: "2026-11-06",
  timezone: "America/Sao_Paulo",
  stats: { done: 46, stuck: 3, waiting: 0, spentNanoUsd: 41_000_000_000, budgetNanoUsd: 80_000_000_000 },
  worked: [{ kind: "runs", agentId: ADA_ID, channelId: GENERAL_ID, count: 38 }],
  rows: [
    {
      id: "routine:ada",
      kind: "routine",
      agentId: ADA_ID,
      channelId: "dm",
      dm: true,
      text: "Manda o resumo do dia",
      count: 3,
      hour: 18,
    },
    {
      id: "stalled:t",
      kind: "stalled",
      issueId: "t-10",
      number: 10,
      title: "Skills do time",
      steps: [12, 13, 14],
      onNumber: 11,
      hours: 4,
      agentId: ADA_ID,
    },
  ],
  proposalIds: [],
  done: {},
  dismissedAt: null,
  ...over,
});

/** A settings proposal the card's rows point at (archive an agent, a smaller model). */
const proposal = (id: string, over: Partial<Proposal> = {}): Proposal => ({
  id,
  agentId: ADA_ID,
  proposedByAgentId: LODI_ID,
  target: { type: "agent_settings", agentId: ADA_ID },
  undoActionId: null,
  title: "Change Ada's settings",
  why: "",
  evidence: [],
  before: "",
  after: "",
  status: "pending",
  stale: false,
  canDecide: true,
  decider: { type: "admins" },
  createdAt: new Date().toISOString(),
  decidedBy: null,
  decidedAt: null,
  ...over,
});

function lodiWeek(c: TeamWeekCard, extra: Partial<Message> = {}) {
  const s = withRightHand(seedState());
  const ch = seedDm(s, { type: "agent", id: LODI_ID });
  s.messages = s.messages.filter((m) => m.channelId !== ch);
  s.messages.push({
    id: "m-week",
    channelId: ch,
    threadId: null,
    author: { type: "agent", id: LODI_ID },
    body: "Sua semana da equipe está pronta",
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date().toISOString(),
    meta: { bodyCode: "team_week", bodyParams: { from: c.from, to: c.to }, actionCard: c },
    ...extra,
  } as Message);
  return s;
}

const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
  await settle(4);
};

const checked = (el: HTMLElement) => el.getAttribute("aria-checked") === "true";

test("the week's card: its numbers, what worked, the suggestions marked under their agent's face, and the schedule", async () => {
  const s = lodiWeek(card());
  await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(s) });
  await settle(8);
  const group = screen.getByRole("group", { name: "Semana da equipe" });
  expect(group.textContent).toContain("46");
  expect(group.textContent).toContain("tarefas feitas");
  expect(group.textContent).toContain("2 sugestões");
  expect(group.textContent).toContain("trabalhos em #");
  expect(group.textContent).toContain("Os passos #12, #13 e #14 estão parados há 4 h esperando o #11.");
  expect(group.textContent).toContain("Toda sexta às 17:00");
  // Its week is the message's words, in a bubble in a DM, with the card under them: never a line of the card's own.
  const week = screen.getAllByRole("article").find((a) => a.contains(group)) as HTMLElement;
  expect(week.querySelector(".ac-msg__text")?.textContent).toContain("Como foi a semana do time");
  expect(group.textContent).not.toContain("Como foi a semana do time");
  // Both rows are Ada's: one face over them, then a round check each, marked from the start, its title without her
  // name (the face says it).
  const ada = within(group).getByRole("group", { name: "Ada" });
  expect(ada.querySelectorAll(".ac-avatar")).toHaveLength(1);
  const routine = within(ada).getByRole("checkbox", { name: "Rotina todo dia às 18:00" });
  const stalled = within(ada).getByRole("checkbox", { name: "Passos parados em #10 Skills do time" });
  expect(checked(routine) && checked(stalled)).toBe(true);
  // No row has a button of its own: the footer's one applies what is marked, as the person.
  expect(within(group).queryByRole("button", { name: "Criar rotina" })).toBeNull();
  expect(within(group).queryByRole("button", { name: "Liberar em paralelo" })).toBeNull();
  await click(within(group).getByRole("button", { name: "Aplicar as 2" }));
  const sent = s.calls.filter((c) => c.method === "orgs.actOnTeamWeek").map((c) => c.args);
  expect(sent).toHaveLength(2);
  expect(sent[0]).toEqual([ORG_ID, "m-week", { rowId: "routine:ada" }]);
  const freed = sent[1]?.[2] as { rowId: string; text: string };
  expect(freed.rowId).toBe("stalled:t");
  expect(freed.text).toStartWith("@");
  expect(freed.text).toContain("#12, #13 e #14");
});

test("applied rows read how they ended, and a card put away keeps only its numbers", async () => {
  const at = new Date().toISOString();
  const s = lodiWeek(
    card({ done: { "routine:ada": { byUserId: "u-walter", at, routineId: "r1" } }, dismissedAt: null }),
  );
  await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(s) });
  await settle(8);
  const group = screen.getByRole("group", { name: "Semana da equipe" });
  // The routine is made: the ok check where its circle was, its line saying so, nothing left to mark.
  expect(within(group).queryByRole("checkbox", { name: "Rotina todo dia às 18:00" })).toBeNull();
  const made = group.querySelector(".tw__item[data-ended]") as HTMLElement;
  expect(made.querySelector(".tw__ok svg")).toBeTruthy();
  expect(made.querySelector(".tw__line[data-ok]")?.textContent).toBe("Rotina criada");
  expect(group.textContent).toContain("1 sugestão");
  // The other one is still marked, and the button applies it alone.
  expect(within(group).getByRole("button", { name: "Aplicar a sugestão" })).toBeTruthy();
  await click(screen.getByRole("button", { name: "Agora não" }));
  expect(s.calls.find((c) => c.method === "orgs.actOnTeamWeek")?.args).toEqual([ORG_ID, "m-week", { dismiss: true }]);
});

test("the day's card: what is stuck opens where it is from a row with a chevron; what was answered says so", async () => {
  const s = lodiWeek(
    card({
      period: "day",
      stats: { done: 2, stuck: 1, waiting: 1, spentNanoUsd: 0, budgetNanoUsd: 0 },
      rows: [
        { id: "waiting", kind: "waiting", count: 1, ids: ["n-1"], agentId: ADA_ID, since: "2026-11-05T12:41:00Z" },
        {
          id: `stuck:${ADA_ID}`,
          kind: "stuck",
          agentId: ADA_ID,
          channelId: GENERAL_ID,
          dm: false,
          code: "plan",
          count: 1,
          held: true,
        },
      ],
    }),
  );
  const { router } = await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(s) });
  await settle(8);
  const group = screen.getByRole("group", { name: "Resumo do dia" });
  expect(group.textContent).toContain("Precisa de você");
  expect(group.textContent).toContain("O plano chegou ao limite.");
  // Nothing here is a suggestion to mark: no check, no count of them, no "Apply", and no money on a day's card.
  expect(within(group).queryAllByRole("checkbox")).toHaveLength(0);
  expect(group.textContent).not.toContain("sugest");
  expect(within(group).queryByRole("button", { name: /Aplicar/ })).toBeNull();
  expect(group.textContent).not.toContain("no mês");
  // What waited is answered by now (the inbox holds nothing): the ok check and the done line, nothing left to open.
  expect(within(group).queryByRole("button", { name: /coisa espera você/ })).toBeNull();
  const answered = group.querySelector(".tw__go[data-ended]") as HTMLElement;
  expect(answered.textContent).toContain("1 coisa espera você");
  expect(answered.querySelector(".tw__line[data-ok] svg")).toBeTruthy();
  expect(answered.querySelector(".tw__line[data-ok]")?.textContent).toBe("Nada mais esperando");
  expect(answered.querySelector(".tw__chev")).toBeNull();
  // What is stuck is one button over the whole row, the agent's face, its words and a chevron: no button beside them.
  const stuck = within(group).getByRole("button", { name: /parou e espera para continuar/ });
  expect(stuck.querySelector(".ac-avatar")).toBeTruthy();
  expect(stuck.querySelector(".tw__chev")).toBeTruthy();
  expect(within(group).queryByRole("button", { name: "Abrir conversa" })).toBeNull();
  await click(stuck);
  expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
  expect(s.calls.some((c) => c.method === "orgs.actOnTeamWeek")).toBe(false);
});

test("what still waits on the person is a row with the agent's face and a chevron that opens what waits", async () => {
  const s = lodiWeek(
    card({
      period: "day",
      stats: { done: 2, stuck: 0, waiting: 1, spentNanoUsd: 0, budgetNanoUsd: 0 },
      rows: [
        { id: "waiting", kind: "waiting", count: 1, ids: ["n-1"], agentId: ADA_ID, since: new Date().toISOString() },
      ],
    }),
  );
  s.notifications = [notification({ id: "n-1", kind: "join_request", waiting: true })];
  const { router } = await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(s) });
  await settle(8);
  const group = screen.getByRole("group", { name: "Resumo do dia" });
  const waits = within(group).getByRole("button", { name: /1 coisa espera você/ });
  expect(waits.querySelector(".ac-avatar")).toBeTruthy();
  expect(waits.querySelector(".tw__chev")).toBeTruthy();
  expect(waits.hasAttribute("aria-expanded")).toBe(false);
  await click(waits);
  expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/waiting`);
});

test("approvals are a row that opens them under it, as the conversation draws them, and closes them again", async () => {
  const s = lodiWeek(
    card({
      rows: [
        {
          id: `approvals:${ADA_ID}`,
          kind: "approvals",
          agentId: ADA_ID,
          approvalIds: ["ap-merge"],
          since: new Date().toISOString(),
        },
        ...card().rows,
      ],
    }),
  );
  await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(s) });
  await settle(8);
  const group = screen.getByRole("group", { name: "Semana da equipe" });
  const asks = within(group).getByRole("button", { name: /1 pedido de Ada espera você/ });
  expect(asks.querySelector(".tw__chev")).toBeTruthy();
  expect(asks.getAttribute("aria-expanded")).toBe("false");
  // Never marked: the footer's button counts only the two suggestions.
  expect(within(group).getByRole("button", { name: "Aplicar as 2" })).toBeTruthy();
  await click(asks);
  expect(asks.getAttribute("aria-expanded")).toBe("true");
  const opened = document.getElementById(asks.getAttribute("aria-controls") ?? "") as HTMLElement;
  expect(opened.querySelector(".rq")).toBeTruthy();
  await click(asks);
  expect(asks.getAttribute("aria-expanded")).toBe("false");
  expect(group.querySelector(".tw__approvals")).toBeNull();
});

test("each agent's suggestions under one face, in the order it first shows; the button says what the marked ones do", async () => {
  const s = lodiWeek(
    card({
      stats: { done: 12, stuck: 0, waiting: 0, spentNanoUsd: 0, budgetNanoUsd: 0 },
      worked: [],
      rows: [
        { id: "howto:1", kind: "howto", agentId: ADA_ID, itemId: "i-1", title: "Montar o relatório semanal", uses: 19 },
        { id: "unanswered:g", kind: "unanswered", channelId: GENERAL_ID, count: 4 },
        { id: "howto:2", kind: "howto", agentId: ADA_ID, itemId: "i-2", title: "Revisar contratos", uses: 12 },
        {
          id: "routine:atlas",
          kind: "routine",
          agentId: ATLAS_ID,
          channelId: "dm",
          dm: true,
          text: "Resumo das vendas",
          count: 2,
          hour: 9,
        },
      ],
    }),
  );
  await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(s) });
  await settle(8);
  const group = screen.getByRole("group", { name: "Semana da equipe" });
  expect(group.textContent).toContain("4 sugestões");
  // Ada's two how-tos join under her face, though a row about no agent came between them; what she learned heads them.
  const ada = within(group).getByRole("group", { name: "Ada aprendeu 2 jeitos de trabalhar" });
  expect(ada.querySelectorAll(".ac-avatar")).toHaveLength(1);
  expect(
    within(ada)
      .getAllByRole("checkbox")
      .map((c) => c.getAttribute("aria-label")),
  ).toEqual(["Montar o relatório semanal", "Revisar contratos"]);
  expect(ada.textContent).toContain("Usado 19×");
  const atlas = within(group).getByRole("group", { name: "Atlas" });
  // The channel's questions are about no agent: no face over them, the kind's icon in its place, the whole title.
  const questions = within(group).getByRole("checkbox", { name: "Um agente para as perguntas de #general" });
  const alone = questions.closest(".tw__alone") as HTMLElement;
  expect(alone.querySelector(".tw__kind svg")).toBeTruthy();
  expect(alone.querySelector(".ac-avatar")).toBeNull();
  const order = [ada, alone, atlas];
  expect(order.every((el, i) => i === 0 || (order[i - 1] as HTMLElement).compareDocumentPosition(el) === 4)).toBe(true);
  // Every one comes marked.
  expect(within(group).getAllByRole("checkbox").every(checked)).toBe(true);
  expect(within(group).getByRole("button", { name: "Aplicar as 4" })).toBeTruthy();
  expect(within(group).queryByRole("button", { name: "Dispensar" })).toBeNull();
  // Unmarked, the questions can be put away for good; a routine unmarked just waits.
  await click(questions);
  expect(checked(questions)).toBe(false);
  expect(within(group).getAllByRole("button", { name: "Dispensar" })).toHaveLength(1);
  expect(within(group).getByRole("button", { name: "Aplicar as 3" })).toBeTruthy();
  await click(within(atlas).getByRole("checkbox", { name: /Rotina todo dia/ }));
  expect(within(group).getAllByRole("button", { name: "Dispensar" })).toHaveLength(1);
  // Only how-tos left marked: the button says what it does to them, and applies those two alone.
  await click(within(group).getByRole("button", { name: "Virar 2 skills" }));
  expect(s.calls.filter((c) => c.method === "orgs.actOnTeamWeek").map((c) => c.args[2])).toEqual([
    { rowId: "howto:1" },
    { rowId: "howto:2" },
  ]);
});

test("archiving starts unmarked and goes only when marked; Dismiss is on an unmarked one that can be put away", async () => {
  const s = lodiWeek(
    card({
      stats: { done: 12, stuck: 0, waiting: 0, spentNanoUsd: 0, budgetNanoUsd: 0 },
      worked: [],
      proposalIds: ["p-retire", "p-model"],
      rows: [
        { id: "unanswered:g", kind: "unanswered", channelId: GENERAL_ID, count: 4 },
        { id: `retire:${ADA_ID}`, kind: "retire", agentId: ADA_ID, proposalId: "p-retire" },
        { id: `model:${ADA_ID}`, kind: "model", agentId: ADA_ID, proposalId: "p-model", from: "big-1", to: "mid-1" },
      ],
      skipped: { "unanswered:g": { byUserId: "u-walter", at: new Date().toISOString() } },
    }),
  );
  s.proposals.push(proposal("p-retire"), proposal("p-model"));
  await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(s) });
  await settle(8);
  const group = screen.getByRole("group", { name: "Semana da equipe" });
  expect(group.textContent).toContain("Sem trabalho há 4 semanas, sem rotina e sem tarefa aberta.");
  expect(group.textContent).toContain("Hoje usa o big-1.");
  // The one already put away says so, with nothing left to mark.
  expect(group.textContent).toContain("Dispensada");
  expect(within(group).queryByRole("checkbox", { name: /perguntas de #general/ })).toBeNull();
  expect(group.textContent).toContain("2 sugestões");
  const ada = within(group).getByRole("group", { name: "Ada" });
  const archive = within(ada).getByRole("checkbox", { name: "Arquivar" });
  const model = within(ada).getByRole("checkbox", { name: "Pode usar o mid-1" });
  expect(checked(archive)).toBe(false);
  expect(checked(model)).toBe(true);
  // Only the unmarked one that can be put away has "Dismiss"; the button applies the model alone.
  expect(within(group).getAllByRole("button", { name: "Dispensar" })).toHaveLength(1);
  expect(within(group).getByRole("button", { name: "Aplicar a sugestão" })).toBeTruthy();
  await click(within(group).getByRole("button", { name: "Dispensar" }));
  expect(s.calls.find((c) => c.method === "orgs.actOnTeamWeek")?.args).toEqual([
    ORG_ID,
    "m-week",
    { rowId: `retire:${ADA_ID}`, skip: true },
  ]);
  // Nothing marked, no button; each unmarked one can be put away.
  await click(model);
  expect(within(group).queryByRole("button", { name: /Aplicar/ })).toBeNull();
  expect(within(group).getAllByRole("button", { name: "Dispensar" })).toHaveLength(2);
  expect(within(group).getByRole("button", { name: "Agora não" })).toBeTruthy();
  // Marked by the reader, archiving is what the button applies, and nothing else.
  await click(archive);
  await click(within(group).getByRole("button", { name: "Aplicar a sugestão" }));
  expect(s.calls.filter((c) => c.method === "proposals.accept").map((c) => c.args[1])).toEqual(["p-retire"]);
});

test("a suggestion applied from the card: the ok check, how it ended, and Undo while its receipt allows", async () => {
  const receipt: AgentAction = {
    id: "act-1",
    kind: "agent.settings_changed",
    agentId: LODI_ID,
    messageId: "m-week",
    requestedByUserId: "u-walter",
    target: { type: "agent", id: ADA_ID, title: "Ada" },
    params: { proposalId: "p-model", agentName: "Ada", fields: ["model"] },
    createdAt: new Date().toISOString(),
    undoableUntil: new Date(Date.now() + 3_600_000).toISOString(),
    undoneAt: null,
    undoneByUserId: null,
    redoneAt: null,
  };
  const s = lodiWeek(
    card({
      proposalIds: ["p-model"],
      rows: [
        { id: `model:${ADA_ID}`, kind: "model", agentId: ADA_ID, proposalId: "p-model", from: "big-1", to: "mid-1" },
      ],
    }),
    { actions: [receipt] },
  );
  s.proposals.push(proposal("p-model", { status: "accepted", undoActionId: "act-1", canDecide: false }));
  await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(s) });
  await settle(8);
  const group = screen.getByRole("group", { name: "Semana da equipe" });
  expect(within(group).queryByRole("checkbox")).toBeNull();
  const applied = group.querySelector(".tw__item[data-ended]") as HTMLElement;
  expect(applied.querySelector(".tw__title")?.textContent).toBe("Pode usar o mid-1");
  expect(applied.querySelector(".tw__ok svg")).toBeTruthy();
  expect(applied.querySelector(".tw__line[data-ok]")?.textContent).toBe("Aplicado");
  // Nothing open is left: no button to apply and no "Not now".
  expect(within(group).queryByRole("button", { name: /Aplicar|Agora não/ })).toBeNull();
  await click(within(applied).getByRole("button", { name: "Desfazer" }));
  expect(s.calls.some((c) => c.method === "actions.undo" && c.args[1] === "act-1")).toBe(true);
});
