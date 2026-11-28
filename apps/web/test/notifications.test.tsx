import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type AgentQuestion, ApiError, type AppNotification } from "@agenteschat/client";
import { type SoundName, setSoundPlayer } from "@agenteschat/client/lib/sounds";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { dispatchPushOpen, pushOpenPath } from "../src/lib/push-open";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, type FakeState, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const key = (el: Element | Window, k: string, extra: KeyboardEventInit = {}) =>
  act(async () => fireEvent.keyDown(el, { key: k, ...extra }));
/** Minutes ago, squeezed into today (same order) when the suite runs soon after midnight. */
const ago = (m: number) => {
  const now = Date.now();
  const sinceMidnight = (now - new Date().setHours(0, 0, 0, 0)) / 60_000 - 1;
  const k = sinceMidnight < 120 ? Math.max(0, sinceMidnight) / 120 : 1;
  return new Date(now - m * k * 60_000).toISOString();
};
/** A row of the list, and the item open beside it (ADR 0218). */
const row = (id: string) => document.querySelector(`.ib-list [data-n="${id}"]`) as HTMLElement;
const read = () => document.querySelector("section.ib-read") as HTMLElement;
const rowIds = () => [...document.querySelectorAll<HTMLElement>(".ib-list [data-n]")].map((r) => r.dataset.n);
/** A click on a row opens it beside the list. */
const open = async (id: string) => {
  await click(row(id));
  await settle(4);
  return read();
};
const menuOf = async (trigger: HTMLElement) => {
  trigger.focus();
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyUp(trigger, { key: "Enter" });
  });
  await settle(2);
  return within(screen().getByRole("menu"));
};
/** The menu beside the title: the filters, "Marcar tudo como lido", "Concluir todas" and the keys. */
const filterMenu = () => menuOf(document.querySelector(".ib-filter") as HTMLElement);
/** The open item's "Ações": Abrir, Feito and Lembrar depois. */
const moreMenu = () => menuOf(read().querySelector(".ib-read__more") as HTMLElement);
const closeMenu = async () => {
  await key(screen().getByRole("menu"), "Escape");
  await settle(2);
};
const pickFilter = async (name: RegExp) => {
  await click((await filterMenu()).getByRole("menuitemradio", { name }));
  await settle(4);
};
const fromFilterMenu = async (name: string) => {
  await click((await filterMenu()).getByRole("menuitem", { name }));
  await settle(4);
};
const fromMoreMenu = async (name: RegExp | string) => {
  await click((await moreMenu()).getByRole("menuitem", { name }));
  await settle(4);
};
const MORE = ["Abrir", "Feito", "Em 1 hora", "Amanhã às 9h", "Próxima semana"];
const moreItems = async () => {
  const items = (await moreMenu()).getAllByRole("menuitem").map((i) => i.querySelector(".ac-menu__label")?.textContent);
  await closeMenu();
  return items;
};
/** Runs on a screen that shows the list or the open item, one at a time (notifications.css). */
const onNarrowScreen = async (run: () => Promise<void>) => {
  const matchMedia = window.matchMedia;
  window.matchMedia = ((query: string) =>
    query === "(max-width: 900px)"
      ? ({ matches: true, media: query } as MediaQueryList)
      : matchMedia.call(window, query)) as typeof window.matchMedia;
  try {
    await run();
  } finally {
    window.matchMedia = matchMedia;
  }
};
/** The inbox's own entry in the sidebar. */
/** The sidebar's way to what waits (ADR 0260): Não lidas, the list's first row. */
const sidebarEntry = () => document.querySelector(`#app-nav a[href="/org/${ORG_ID}/unreads"]`) as HTMLAnchorElement;
/** The fake backend with these notifications and no proposals: these cases are about the notifications. */
const seed = (notifications: AppNotification[], over: Partial<FakeState> = {}) =>
  seedState({ notifications, proposals: [], ...over });
const yesterdayNoon = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12).toISOString();
};

const question: AgentQuestion = {
  id: "q-1",
  agentId: ADA_ID,
  channelId: ENG_ID,
  threadId: "m-1",
  messageId: "m-q",
  text: "Uso o cupom antigo quando o novo falhar, ou bloqueio o checkout?",
  choices: ["Usa o cupom antigo", "Bloqueia o checkout"],
  status: "open",
  answer: null,
  answeredByUserId: null,
};

/** The design's sample inbox, on the fake backend's people and agents. */
function inbox(): AppNotification[] {
  return [
    notification({
      id: "n-q",
      kind: "agent_question",
      waiting: true,
      actors: [{ type: "agent", id: ADA_ID }],
      source: { channelId: ENG_ID, threadId: "m-1", questionId: "q-1" },
      latest: {
        title: question.text,
        text: "O serviço de cupons novo caiu 2 vezes hoje.",
        suggestions: question.choices ?? [],
      },
      createdAt: ago(25),
      updatedAt: ago(25),
    }),
    notification({
      id: "n-thread",
      kind: "thread_reply",
      actors: [
        { type: "user", id: "u-joao" },
        { type: "agent", id: ADA_ID },
      ],
      count: 2,
      source: { channelId: ENG_ID, threadId: "m-1", label: "Login 401" },
      latest: { text: "@walter dá para subir hoje ainda?" },
      updatedAt: ago(9),
    }),
    notification({
      id: "n-rx",
      kind: "reaction",
      actors: [
        { type: "user", id: "u-joao" },
        { type: "agent", id: ATLAS_ID },
      ],
      count: 2,
      source: { channelId: ENG_ID, messageId: "m-1" },
      latest: { emojis: ["🎉", "🚀"], quote: "A 2.4.0 está no ar." },
      updatedAt: ago(118),
    }),
    notification({
      id: "n-routine",
      kind: "routine_failed",
      actors: [{ type: "agent", id: ATLAS_ID }],
      source: { routineId: "r-1", label: "Resumo diário de vendas" },
      latest: { reason: "budget_exceeded", steps: { done: 3, total: 5, failedAt: 4 } },
      readAt: yesterdayNoon(),
      updatedAt: yesterdayNoon(),
    }),
  ];
}

const go = async (state: FakeState = seed(inbox())) => {
  // The "Login 401" thread: Ada's reply there (the seed's channel messages are all top-level).
  state.messages.push({
    id: "m-thread-ada",
    channelId: ENG_ID,
    threadId: "m-1",
    author: { type: "agent", id: ADA_ID },
    body: "Corrigi o refresh: o PR #42 está aberto.",
    mentionedAgentIds: [],
    agentRunId: "r-1",
    createdAt: ago(30),
  });
  state.messages.push({
    id: "m-q",
    channelId: ENG_ID,
    threadId: "m-1",
    author: { type: "agent", id: ADA_ID },
    body: "",
    mentionedAgentIds: [],
    agentRunId: "r-1",
    meta: { question },
    createdAt: ago(25),
  });
  const api = createFakeApi(state);
  const r = await renderApp(`/org/${ORG_ID}/notifications`, { api });
  await settle(8);
  return { ...r, state, api };
};

describe("Notificações", () => {
  test("how many are unread is under the title from the first paint, before the list arrives", async () => {
    const state = seed([notification({ id: "n-a", kind: "mention" }), notification({ id: "n-b", kind: "mention" })]);
    const api = createFakeApi(state);
    // The list never answers: only the count the sidebar loads at start is there.
    api.notifications.list = () => new Promise(() => {});
    await renderApp(`/org/${ORG_ID}/notifications`, { api });
    await settle(4);
    const title = screen().getByRole("heading", { level: 1, name: "Caixa de entrada" });
    // The count's line, under the title, with the filter at its end.
    const meta = title.closest(".ib-head")?.querySelector(".ac-pagehead__metaline > .ac-pagehead__meta");
    expect(meta?.textContent).toBe("2 não lidas");
  });

  test("a compact header: the title and Marcar tudo como lido on one row, the count and the filter on the next", async () => {
    await go();
    const head = document.querySelector(".ib-head") as HTMLElement;
    // Two rows, no third one for the filter alone.
    expect([...head.children].map((c) => c.className)).toEqual(["ac-pagehead__row", "ac-pagehead__metaline"]);
    expect(head.querySelector(".ac-pagehead__bar")).toBeNull();
    const titleRow = head.querySelector(".ac-pagehead__row") as HTMLElement;
    expect(titleRow.querySelector("h1")?.textContent).toBe("Caixa de entrada");
    expect(titleRow.querySelector(".ac-pagehead__actions .ib-readall")).not.toBeNull();
    const line = head.querySelector(".ac-pagehead__metaline") as HTMLElement;
    expect(line.firstElementChild?.textContent).toBe("1 coisa esperando você\u00a0· 3 não lidas");
    expect(line.querySelector(".ac-pagehead__metaacts .ib-filter")?.textContent).toBe("Tudo");
    const css = (await Bun.file(new URL("../src/pages/notifications.css", import.meta.url).pathname).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    // The title row wraps as every page's does (the kit's rule); Marcar tudo como lido stays beside it on a phone.
    expect(css).not.toMatch(/\.ib-head \.ac-pagehead__(row|text|bar) \{/);
    expect(css).toMatch(/\.ib-head \.ac-pagehead__actions \{[^}]*flex-basis: auto;/);
  });

  test("another filter keeps the list on screen, dimmed under a running bar, until its notifications land", async () => {
    const { api } = await go();
    const load = api.notifications.list;
    let land = () => {};
    api.notifications.list = (...args) =>
      new Promise((done) => {
        land = () => done(load(...args));
      });
    const menu = await filterMenu();
    await click(menu.getByRole("menuitemradio", { name: /Reações/ }));
    await act(() => new Promise((r) => setTimeout(r, 200)));
    const kept = document.querySelector(".ib-list .ac-refreshing") as HTMLElement;
    expect(kept.getAttribute("aria-busy")).toBe("true");
    expect(kept.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toBe("Carregando…");
    // The filter already says the new one; the rows are the last one's until the new ones come.
    expect(document.querySelector(".ib-filter")?.textContent).toBe("Reações");
    expect(rowIds()).toContain("n-q");
    await act(async () => land());
    await settle(4);
    expect(rowIds()).toEqual(["n-rx"]);
    expect(kept.hasAttribute("aria-busy")).toBe(false);
    expect(kept.querySelector('[role="progressbar"]')).toBeNull();
  });

  test("what waits on top with the first of it open beside the list, the rest by day, the sidebar's entry and the tab title", async () => {
    const { state, router } = await go();
    const title = screen().getByRole("heading", { level: 1, name: "Caixa de entrada" });
    // What waits and how many are unread: one line under the title.
    const meta = title.closest(".ib-head")?.querySelector(".ac-pagehead__metaline > .ac-pagehead__meta");
    expect(meta?.textContent).toBe("1 coisa esperando você\u00a0· 3 não lidas");
    const waiting = screen().getByRole("region", { name: "Esperando você" });
    // The groups' head: the title and how many, nothing else.
    expect(waiting.querySelector(".ac-grouphead")?.textContent).toBe("Esperando você1");
    // A row is who, what they want in one line, what it is about under it and when, with no buttons of its own.
    const q = row("n-q");
    expect(waiting.contains(q)).toBe(true);
    expect(q.tagName).toBe("BUTTON");
    expect(q.querySelector("button, a")).toBeNull();
    expect(q.querySelector(".ib-row__face .ac-avatar")?.getAttribute("data-state")).toBe("waiting");
    expect(q.querySelector(".ib-row__line")?.textContent).toBe("Ada fez uma pergunta");
    expect(q.querySelector(".ib-row__sub")?.textContent).toContain(question.text);
    expect(q.querySelector(".ib-row__end")?.textContent).toMatch(/^(há |agora)/);
    // What waits first opens by itself (ADR 0218): the question as the conversation's request card, stopped until I
    // answer.
    expect(q.getAttribute("aria-current")).toBe("true");
    expect([...document.querySelectorAll<HTMLElement>(".ib-list .is-on")].map((r) => r.dataset.n)).toEqual(["n-q"]);
    const card = read().querySelector(".rq") as HTMLElement;
    expect(card.querySelector(".rq__kind")?.textContent).toContain("Pergunta");
    // Who asks comes first: away from the conversation, the face alone doesn't say it.
    expect(card.querySelector(".rq__kind > .rq__who")?.textContent).toBeTruthy();
    // Waiting for me needs no words on the card (its buttons say it).
    expect(card.querySelector(".rq__state")).toBeNull();
    expect(card.querySelector(".rq__lead")?.textContent).toBe(question.text);
    expect(card.querySelector(".rq__end")?.textContent).toMatch(/^Parada há /);
    expect(within(card).getByRole("button", { name: "Usa o cupom antigo" })).toBeTruthy();
    // Opening by itself reads nothing and goes nowhere.
    expect(state.calls.some((c) => c.method === "notifications.read")).toBe(false);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    const today = screen().getByRole("region", { name: "Hoje" });
    expect(row("n-thread").querySelector(".ib-row__line")?.textContent).toBe("João e Ada responderam em Login 401");
    expect(today.contains(row("n-rx"))).toBe(true);
    expect(row("n-rx").textContent).toContain("reagiram à sua mensagem");
    // A routine's failure in the person's words (its coded reason), never the server's English.
    const routine = row("n-routine");
    expect(screen().getByRole("region", { name: "Ontem" }).contains(routine)).toBe(true);
    expect(routine.querySelector(".ib-row__sub")?.textContent).toContain("O orçamento do mês acabou");
    // The list ends with its last day: no note under it.
    expect(document.querySelector(".ib-list .ac-refreshing")?.lastElementChild?.getAttribute("aria-label")).toBe(
      "Ontem",
    );
    // The sidebar's one entry (no bell): marked while something is unread, counting what waits. The tab counts the
    // unread.
    expect(sidebarEntry().getAttribute("data-unread")).toBe("true");
    expect(sidebarEntry().querySelector(".ac-count")?.getAttribute("aria-label")).toBe("1 coisa esperando você");
    expect(screen().queryByLabelText(/notificações não lidas/)).toBeNull();
    expect(document.title).toBe("(3) Caixa de entrada");
    // Open, an item says its words whole: my own @mention highlighted, and where a stopped run stopped.
    expect((await open("n-thread")).querySelector(".ib-read__say .ac-mention")?.textContent).toBe("@walter");
    expect((await open("n-routine")).textContent).toContain("Parou na etapa 4 de 5");
  });

  test("the filters are a menu under the title, each with its count; picking one changes the list", async () => {
    await go();
    // At the end of the count's line: beside the title, a long filter's name would squeeze it in the narrow column.
    const filter = () => document.querySelector(".ib-head .ac-pagehead__metaline .ib-filter") as HTMLElement;
    expect(filter().textContent).toBe("Tudo");
    expect(document.querySelector(".ac-pagehead__actions .ib-filter")).toBeNull();
    expect(document.querySelector(".ac-pagehead__actions .ib-readall")).not.toBeNull();
    const menu = await filterMenu();
    const names = [/Tudo/, /Menções/, /Esperando você/, /Não lidas/, /Reações/, /Pedidos decididos/, /Concluídas/];
    const radios = names.map((name) => menu.getByRole("menuitemradio", { name }));
    expect(menu.getAllByRole("menuitemradio")).toEqual(radios);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
      "false",
      "false",
      "false",
      "false",
    ]);
    expect(radios[0]?.textContent).toBe("Tudo4");
    expect(radios[3]?.textContent).toBe("Não lidas3");
    // The decided requests and what is done are other lists: no count of the inbox's on them.
    expect(radios[5]?.textContent).toBe("Pedidos decididos");
    expect(radios[6]?.textContent).toBe("Concluídas");
    await click(radios[4] as HTMLElement);
    await settle(4);
    expect(filter().textContent).toBe("Reações");
    expect(screen().queryByRole("region", { name: "Esperando você" })).toBeNull();
    expect(rowIds()).toEqual(["n-rx"]);
    expect(row("n-rx").textContent).toContain("reagiram à sua mensagem");
  });

  test("two lines a row: where it happened and a task's move lead the line under the headline in plain words, no chips", async () => {
    const items = [
      notification({
        id: "n-mention",
        kind: "mention",
        actors: [{ type: "user", id: "u-joao" }],
        source: { channelId: ENG_ID, messageId: "m-1" },
        latest: { text: "@walter dá uma olhada no deploy das 9h?" },
        updatedAt: ago(3),
      }),
      notification({
        id: "n-move",
        kind: "issue_status",
        actors: [{ type: "agent", id: ADA_ID }],
        source: { issueId: "issue-131", issueNumber: 131 },
        latest: { title: "Corrigir o login com Google", statusFrom: "in_progress", statusTo: "in_review" },
        updatedAt: ago(6),
      }),
      notification({
        id: "n-done",
        kind: "mission_finished",
        actors: [{ type: "agent", id: ADA_ID }],
        source: { channelId: ENG_ID, label: "Revisar o PR" },
        latest: { steps: { done: 5, total: 5 } },
        updatedAt: ago(9),
      }),
      ...inbox().filter((n) => n.kind === "reaction"),
    ];
    await go(seed(items));
    expect(document.querySelector(".ib-list .ac-chip")).toBeNull();
    expect(row("n-mention").querySelector(".ib-row__sub")?.textContent).toBe(
      "#eng · @walter dá uma olhada no deploy das 9h?",
    );
    expect(row("n-move").querySelector(".ib-row__sub")?.textContent).toBe(
      "Tarefa #131 · Em andamento → Em revisão · #131 Corrigir o login com Google",
    );
    // A finished run says nothing extra: no step strip, open either.
    expect((await open("n-done")).querySelector(".ib-read__say")?.textContent).toContain("Revisar o PR");
    expect(read().querySelector(".nt-steprow")).toBeNull();
  });

  test("a computer that isn't answering, then back: its name leads, since when or how long, what waited (ADR 0241)", async () => {
    const since = new Date(Date.now() - 50 * 60_000).toISOString();
    const items = [
      notification({
        id: "n-down",
        kind: "computer_down",
        actors: [],
        source: { machineId: "m-ws", label: "Computador do workspace" },
        latest: { since, runs: 3, calls: 7 },
        updatedAt: ago(40),
      }),
      notification({
        id: "n-back",
        kind: "computer_back",
        actors: [],
        source: { machineId: "m-ws", label: "Computador do workspace" },
        latest: { since, runs: 3, calls: 0 },
        createdAt: new Date(Date.parse(since) + 42 * 60_000).toISOString(),
        updatedAt: ago(8),
      }),
    ];
    await go(seed(items));
    expect(row("n-down").textContent).toContain("Computador do workspace não está respondendo");
    expect(row("n-down").querySelector(".ib-row__sub")?.textContent).toMatch(
      /^Computador · Desde \d{1,2}:\d{2} · Esperando: 3 pedidos a agentes e 7 chamadas de webhook/,
    );
    expect(row("n-back").textContent).toContain("Computador do workspace voltou");
    expect(row("n-back").querySelector(".ib-row__sub")?.textContent).toContain(
      "Voltou depois de 42 min · Esperaram: 3 pedidos a agentes",
    );
  });

  test("an approval is the conversation's card: the agent's why, the action in its well, who asked behind Ver detalhes", async () => {
    const asked = notification({
      id: "n-ap",
      kind: "approval",
      waiting: true,
      actors: [{ type: "agent", id: ATLAS_ID }],
      source: { approvalId: "ap-deploy", channelId: ENG_ID },
      latest: {
        title: "Run deploy workflow",
        text: "O erro 500 voltou depois do deploy 2.14.",
        origin: { kind: "routine", routineId: "rt-1", routineName: "Vigiar erros" },
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      createdAt: ago(5),
      updatedAt: ago(5),
    });
    await go(seed([asked]));
    // Its row says how long is left to decide where the others say when, in attention this close to the end.
    const end = row("n-ap").querySelector(".ib-row__end") as HTMLElement;
    expect(end.textContent).toBe("1 h");
    expect(end.classList.contains("is-urgent")).toBe(true);
    const card = read().querySelector(".rq") as HTMLElement;
    expect(card.getAttribute("data-ask-kind")).toBe("approval");
    expect(card.querySelector(".rq__kind")?.textContent).toBe("Atlas · Pede sua aprovação");
    expect(card.querySelector(".rq__well")).toBeTruthy();
    // Decided right here: a deploy takes a hold, and Agora não asks for the reason.
    expect(within(card).getByRole("button", { name: /segure para confirmar/ })).toBeTruthy();
    // Remind me later and Done are the open item's menu, for an approval as for anything else.
    expect(card.querySelector(".nt-tail")).toBeNull();
    expect(await moreItems()).toEqual(MORE);
    // Who decides it and manages agents can change when Atlas asks, right on the item.
    expect(within(card).getByRole("button", { name: "Mudar quando perguntar" })).toBeTruthy();
    await click(within(card).getByRole("button", { name: "Agora não" }));
    expect(card.querySelector("textarea")).toBeTruthy();
  });

  test("Feito leaves at once (optimistic) and Desfazer brings it back", async () => {
    const { state } = await go();
    await open("n-thread");
    await fromMoreMenu(/^Feito/);
    expect(row("n-thread")).toBeNull();
    expect(state.calls.find((c) => c.method === "notifications.done")?.args).toEqual([ORG_ID, "n-thread", true]);
    expect(document.body.textContent).toContain("Marcado como feito");
    // Nobody waits on a thread's notice: the toast is one line.
    expect(document.querySelector(".ac-toast__detail")).toBeNull();
    await click(screen().getByRole("button", { name: "Desfazer" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "notifications.done").at(-1)?.args).toEqual([
      ORG_ID,
      "n-thread",
      false,
    ]);
    expect(row("n-thread")).toBeTruthy();
  });

  test("a refused Feito puts the item back", async () => {
    const { state: s } = await go();
    await open("n-thread");
    s.notifications = s.notifications?.filter((n) => n.id !== "n-thread");
    await fromMoreMenu(/^Feito/);
    await settle(6);
    expect(row("n-thread")).toBeTruthy();
  });

  test("grouped replies read right in the open item; a reply from there goes to the thread", async () => {
    const { state } = await go();
    const item = await open("n-thread");
    // No toggle: what it groups is there.
    expect(within(item).queryByRole("button", { name: /Ver 2 respostas/ })).toBeNull();
    expect(item.querySelector(".nt-reps")?.textContent).toContain("Corrigi o refresh: o PR #42 está aberto.");
    // Opening it marked it read.
    expect(state.calls.find((c) => c.method === "notifications.read")?.args).toEqual([ORG_ID, "n-thread", true]);
    await click(within(item).getByRole("button", { name: "Responder" }));
    const box = within(read()).getByRole("textbox", { name: "Responder na thread" });
    await type(box, "Sobe sim, às 17h.");
    await key(box, "Enter", { metaKey: true });
    await settle(6);
    const post = state.calls.find((c) => c.method === "chat.post");
    expect(post?.args[1]).toBe(ENG_ID);
    expect(post?.args[2]).toMatchObject({ body: "Sobe sim, às 17h.", threadId: "m-1" });
    expect(read().textContent).toContain("Você respondeu: Sobe sim, às 17h.");
  });

  test("in a workspace being deleted, an inline reply says why it takes nothing, and Cancelar closes it", async () => {
    const state = seed(inbox());
    if (!state.me) throw new Error("signed in");
    state.me.organizations = state.me.organizations.map((o) => ({
      ...o,
      deletion: { dueAt: new Date(Date.now() + 6 * 86_400_000).toISOString(), requestedAt: ago(60), requestedBy: null },
    }));
    await go(state);
    const item = await open("n-thread");
    await click(within(item).getByRole("button", { name: "Responder" }));
    expect(within(read()).queryByRole("textbox")).toBeNull();
    expect(within(read()).getByRole("status").textContent).toBe(
      "Você não pode enviar mensagens enquanto este workspace está sendo apagado",
    );
    await click(within(read()).getByRole("button", { name: "Cancelar" }));
    expect(within(read()).queryByRole("status")).toBeNull();
    expect(within(read()).getByRole("button", { name: "Responder" })).toBeTruthy();
  });

  test("grouped task comments read in the open item, from the task's conversation (ADR 0145)", async () => {
    const state = seed([]);
    const api = createFakeApi(state);
    const issue = await api.issues.get(ORG_ID, 131);
    const at = await api.issues.conversation(ORG_ID, issue.id);
    for (const [id, body, m] of [
      ["m-task-1", "Comecei pelo template.", 8],
      ["m-task-2", "Mandei o lembrete pelo WhatsApp.", 5],
    ] as const) {
      state.messages.push({
        id,
        channelId: at.channelId,
        threadId: at.rootId,
        author: { type: "agent", id: ADA_ID },
        body,
        mentionedAgentIds: [],
        agentRunId: null,
        createdAt: ago(m),
      });
    }
    state.notifications = [
      notification({
        id: "n-task",
        kind: "issue_comment",
        actors: [{ type: "agent", id: ADA_ID }],
        count: 2,
        source: { issueId: issue.id, issueNumber: 131, label: issue.title },
        latest: { text: "Mandei o lembrete pelo WhatsApp.", title: issue.title },
        updatedAt: ago(5),
      }),
    ];
    await renderApp(`/org/${ORG_ID}/notifications`, { api });
    await settle(8);
    // The only item: open by itself, its comments with it.
    expect(row("n-task").getAttribute("aria-current")).toBe("true");
    await settle(6);
    const shown = read().querySelector(".nt-reps")?.textContent;
    expect(shown).toContain("Comecei pelo template.");
    expect(shown).toContain("Mandei o lembrete pelo WhatsApp.");
  });

  test("an agent's question: its suggestions are the card's answers, one a line; a pick answers through the question", async () => {
    const { state } = await go();
    // What waits first is open beside the list.
    const list = read().querySelector(".rq__choices") as HTMLElement;
    // Its last line writes another: the reply box opens in the card.
    const lines = [...list.querySelectorAll(".rq__choice")].map((b) => b.textContent);
    expect(lines.at(-1)).toBe("Outra resposta");
    await click(within(list).getByRole("button", { name: "Outra resposta" }));
    expect(within(read()).getByRole("textbox", { name: "Responder à Ada" })).toBeTruthy();
    await click(within(list).getByRole("button", { name: "Usa o cupom antigo" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "questions.answer")?.args).toEqual([
      ORG_ID,
      "q-1",
      { choice: "Usa o cupom antigo" },
    ]);
    expect(document.body.textContent).toContain("Ada recebeu sua resposta");
  });

  test("Atalhos, in the filters' menu: each row does what its key does, on the open item", async () => {
    const { state } = await go();
    // What waits first is open: the keys are on it from the start.
    let menu = await filterMenu();
    expect(menu.getByRole("menuitem", { name: /Marcar como feita/ }).getAttribute("aria-disabled")).toBeNull();
    await click(menu.getByRole("menuitem", { name: /Mover entre as notificações/ }));
    await settle(2);
    expect(row("n-thread").getAttribute("aria-current")).toBe("true");
    expect(read().querySelector(".ib-read__title")?.textContent).toContain("Login 401");
    menu = await filterMenu();
    await click(menu.getByRole("menuitem", { name: /Marcar como feita/ }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "notifications.done")?.args[1]).toBe("n-thread");
  });

  test("keys: J and K move and open what they land on, R starts the reply, E marks done", async () => {
    const { state, router } = await go();
    // From the open item, what waits first.
    await key(window, "j");
    expect((document.activeElement as HTMLElement).dataset.n).toBe("n-thread");
    expect(row("n-thread").getAttribute("aria-current")).toBe("true");
    expect(read().querySelector(".ib-read__title")?.textContent).toContain("Login 401");
    expect(state.calls.find((c) => c.method === "notifications.read")?.args).toEqual([ORG_ID, "n-thread", true]);
    await key(document.activeElement as Element, "k");
    expect((document.activeElement as HTMLElement).dataset.n).toBe("n-q");
    expect(read().querySelector(".rq")?.getAttribute("data-ask-kind")).toBe("question");
    await key(document.activeElement as Element, "j");
    await key(document.activeElement as Element, "r");
    expect(within(read()).getByRole("textbox", { name: "Responder na thread" })).toBeTruthy();
    await key(window, "Escape");
    expect(within(read()).queryByRole("textbox")).toBeNull();
    // Moving and replying never left the inbox.
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    await key(row("n-thread"), "e");
    await settle(4);
    expect(state.calls.find((c) => c.method === "notifications.done")?.args[1]).toBe("n-thread");
    expect(row("n-thread")).toBeNull();
  });

  test("Enter opens the open item where it happened, with the focus on its row or off the list", async () => {
    const { router } = await go();
    await key(window, "j");
    await key(document.body, "Enter");
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    cleanup();

    // J and a click both leave the focus on the row, a button: Enter there opens it too.
    const again = await go();
    await key(window, "j");
    expect((document.activeElement as HTMLElement).dataset.n).toBe("n-thread");
    await key(document.activeElement as Element, "Enter");
    await settle(4);
    expect(again.router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
  });

  test("a body the server wrote reads in the person's language, in the row, open and in the snooze toast", async () => {
    const state = seed([]);
    const api = createFakeApi(state);
    state.notifications = [
      notification({
        id: "n-noai",
        kind: "mention",
        actors: [{ type: "agent", id: ADA_ID }],
        source: { channelId: ENG_ID, label: "engenharia" },
        latest: {
          text: "I can't answer yet: I have no AI connected.",
          meta: { bodyCode: "no_ai", noAi: { reason: "none" } },
        },
        updatedAt: ago(5),
      }),
    ];
    await renderApp(`/org/${ORG_ID}/notifications`, { api });
    await settle(8);
    const said = "Ainda não consigo responder: não tenho uma IA conectada.";
    expect(row("n-noai").textContent).toContain(said);
    expect(read().querySelector(".ib-read__say")?.textContent).toBe(said);
    expect(document.querySelector(".ib")?.textContent).not.toContain("I can't answer");
    await fromMoreMenu(/Amanhã às 9h/);
    expect(document.body.textContent).toContain(said);
    expect(document.body.textContent).not.toContain("I can't answer");
  });

  test("Lembrar depois snoozes until a local time, then Desfazer brings it back (snooze with until null)", async () => {
    const { state } = await go();
    await open("n-rx");
    await fromMoreMenu(/Amanhã às 9h/);
    const until = new Date(String(state.calls.find((c) => c.method === "notifications.snooze")?.args[2]));
    expect(until.getHours()).toBe(9);
    expect(until.getDate()).toBe(new Date(Date.now() + 86_400_000).getDate());
    expect(row("n-rx")).toBeNull();
    await click(screen().getByRole("button", { name: "Desfazer" }));
    await settle(6);
    const calls = state.calls.filter((c) => c.method === "notifications.snooze").map((c) => c.args[2]);
    expect(calls.at(-1)).toBeNull();
    expect(row("n-rx")).not.toBeNull();
  });

  test("Concluir todas keeps what waits on me, and Desfazer brings exactly the rest back", async () => {
    const { state } = await go();
    await fromFilterMenu("Concluir todas");
    expect(state.calls.find((c) => c.method === "notifications.doneAll")?.args).toEqual([ORG_ID, "all"]);
    expect(rowIds()).toEqual(["n-q"]);
    expect(document.body.textContent).toContain("3 movidas para Concluídas");
    await click(screen().getByRole("button", { name: "Desfazer" }));
    await settle(6);
    const undone = state.calls.filter((c) => c.method === "notifications.done");
    expect(undone.map((c) => c.args[1]).sort()).toEqual(["n-routine", "n-rx", "n-thread"]);
    expect(undone.every((c) => c.args[2] === false)).toBe(true);
    expect(row("n-rx")).not.toBeNull();
  });

  test("Concluir todas stays off in Esperando, in Concluídas, and where only what waits on me is left", async () => {
    // The question waits on me (a mention, unread); the reaction is read, so neither filter holds anything else.
    const [q, , rx] = inbox();
    if (!q || !rx) throw new Error("the sample inbox changed");
    await go(seed([q, { ...rx, readAt: ago(5) }]));
    let menu = await filterMenu();
    const off = () => menu.getByRole("menuitem", { name: "Concluir todas" }).getAttribute("aria-disabled");
    expect(off()).toBeNull();
    for (const name of [/Menções/, /Não lidas/, /Esperando/, /Concluídas/]) {
      await click(menu.getByRole("menuitemradio", { name }));
      await settle(4);
      menu = await filterMenu();
      expect(off()).toBe("true");
    }
  });

  test("while Concluir todas runs, its entry and the open item's own actions wait; a failure brings the rows back", async () => {
    const { api } = await go();
    let fail: (e: Error) => void = () => {};
    api.notifications.doneAll = () =>
      new Promise((_, reject) => {
        fail = reject;
      });
    await fromFilterMenu("Concluir todas");
    const clearOff = async () => {
      const off = (await filterMenu()).getByRole("menuitem", { name: "Concluir todas" }).getAttribute("aria-disabled");
      await closeMenu();
      return off;
    };
    const doneOff = async () => {
      const off = (await moreMenu()).getByRole("menuitem", { name: /^Feito/ }).getAttribute("aria-disabled");
      await closeMenu();
      return off;
    };
    expect(await clearOff()).toBe("true");
    // What waits stays, open, with its own actions waiting too.
    expect(row("n-q").getAttribute("aria-current")).toBe("true");
    expect(await doneOff()).toBe("true");
    expect(row("n-rx")).toBeNull();
    await act(async () => fail(new ApiError(502, "http_502", "Bad Gateway")));
    await settle(4);
    expect(row("n-rx")).not.toBeNull();
    expect(document.querySelector(".ac-toast--error")).not.toBeNull();
    await open("n-rx");
    expect(await doneOff()).toBeNull();
  });

  test("opening a row while Concluir todas runs keeps its toast and Desfazer, and its entry off until it ends", async () => {
    const { api, state } = await go();
    const real = api.notifications.doneAll;
    let finish: () => void = () => {};
    api.notifications.doneAll = (orgId, filter) =>
      new Promise((resolve) => {
        finish = () => resolve(real(orgId, filter));
      });
    await fromFilterMenu("Concluir todas");
    // A click on a row marks it read: a second mutation while the clear is under way.
    await open("n-q");
    expect(state.calls.some((c) => c.method === "notifications.read")).toBe(true);
    const menu = await filterMenu();
    expect(menu.getByRole("menuitem", { name: "Concluir todas" }).getAttribute("aria-disabled")).toBe("true");
    await closeMenu();
    await act(async () => finish());
    await settle(4);
    expect(document.body.textContent).toContain("3 movidas para Concluídas");
    expect(screen().getByRole("button", { name: "Desfazer" })).toBeTruthy();
  });

  test("Desfazer brings back what it can: a row deleted meanwhile is just gone, with no error", async () => {
    const { api } = await go();
    await fromFilterMenu("Concluir todas");
    const real = api.notifications.done;
    api.notifications.done = (orgId, id, done) =>
      id === "n-routine" ? Promise.reject(new ApiError(404, "not_found", "Not found")) : real(orgId, id, done);
    await click(screen().getByRole("button", { name: "Desfazer" }));
    await settle(6);
    expect(document.querySelector(".ac-toast--error")).toBeNull();
    expect(row("n-rx")).not.toBeNull();
    expect(row("n-thread")).not.toBeNull();
    expect(row("n-routine")).toBeNull();
  });

  test("what the person brings back (alert false) plays no sound; news does", async () => {
    const { sockets } = await go();
    const heard: SoundName[] = [];
    setSoundPlayer((name) => heard.push(name));
    const socket = sockets.last();
    await act(async () => socket.open());
    const mention = (id: string, alert?: boolean) =>
      act(async () =>
        socket.push({
          type: "event",
          scope: "user",
          event: {
            type: "notification.upserted",
            notification: notification({ id, kind: "mention", actors: [{ type: "user", id: "u-joao" }] }),
            ...(alert === undefined ? {} : { alert }),
          },
        }),
      );
    await mention("n-back", false);
    await settle(2);
    expect(heard).toEqual([]);
    await mention("n-news");
    await settle(2);
    expect(heard).toEqual(["mention"]);
    setSoundPlayer(null);
  });

  test("Marcar tudo como lido, then Desfazer marks the same ones unread", async () => {
    const { state } = await go();
    await fromFilterMenu("Marcar tudo como lido");
    expect(state.calls.find((c) => c.method === "notifications.readAll")?.args).toEqual([ORG_ID, "all"]);
    expect(document.body.textContent).toContain("3 marcadas como lidas");
    expect(document.querySelector(".ac-toast__detail")).toBeNull();
    await click(screen().getByRole("button", { name: "Desfazer" }));
    await settle(6);
    const undone = state.calls.filter((c) => c.method === "notifications.read").map((c) => c.args[1]);
    expect(undone.sort()).toEqual(["n-q", "n-rx", "n-thread"]);
  });

  test("Abrir in the open item goes to the source and marks it read; so do a double click on its row and its menu's Abrir", async () => {
    const { state, router } = await go();
    const item = await open("n-thread");
    await click(within(item).getByRole("button", { name: "Abrir" }));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    expect(state.calls.find((c) => c.method === "notifications.read")?.args).toEqual([ORG_ID, "n-thread", true]);
    cleanup();

    const twice = await go();
    await act(async () => fireEvent.doubleClick(row("n-thread")));
    await settle(4);
    expect(twice.router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    expect(twice.state.calls.find((c) => c.method === "notifications.read")?.args).toEqual([ORG_ID, "n-thread", true]);
    cleanup();

    const menu = await go();
    await open("n-thread");
    await fromMoreMenu(/^Abrir/);
    expect(menu.router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
  });

  test("live: a new notification lands from the WebSocket; a resolved one leaves; the sidebar's entry follows", async () => {
    const { sockets } = await go();
    const socket = sockets.last();
    await act(async () => socket.open());
    await act(async () =>
      socket.push({
        type: "event",
        scope: "user",
        event: {
          type: "notification.upserted",
          notification: notification({
            id: "n-new",
            kind: "dm",
            actors: [{ type: "user", id: "u-joao" }],
            source: { dmId: "dm-1" },
            latest: { text: "Te mandei o contrato, dá uma olhada no item 4?" },
          }),
        },
      }),
    );
    await settle(4);
    expect(row("n-new").textContent).toContain("João mandou uma mensagem");
    expect(sidebarEntry().getAttribute("data-unread")).toBe("true");
    expect(sidebarEntry().querySelector(".ac-count")?.textContent).toBe("1");
    await act(async () =>
      socket.push({ type: "event", scope: "user", event: { type: "notification.removed", id: "n-q" } }),
    );
    await act(async () =>
      socket.push({ type: "event", scope: "user", event: { type: "notification.counts", unread: 0, waiting: 0 } }),
    );
    await settle(4);
    expect(screen().queryByRole("region", { name: "Esperando você" })).toBeNull();
    // Nothing unread and nothing waiting: the entry is plain, with no count.
    expect(sidebarEntry().getAttribute("data-unread")).toBe("false");
    expect(sidebarEntry().querySelector(".ac-count")).toBeNull();
  });

  test("empty: Tudo em dia, one calm screen with no list and no filters", async () => {
    await go(seed([]));
    expect(document.querySelector(".ib-calm .ac-empty--page")?.textContent).toBe(
      "Tudo em diaQuando alguém precisar de você, aparece aqui.",
    );
    expect(document.querySelector(".ib-list")).toBeNull();
    expect(document.querySelector(".ib-filter")).toBeNull();
  });
});

describe("a new computer connected (ADR 0036, admins)", () => {
  test("who connected which computer; Abrir goes to the computer's page", async () => {
    const connected = notification({
      id: "n-machine",
      kind: "machine_connected",
      actors: [{ type: "user", id: "u-joao" }],
      source: { machineId: "m-9", label: "MacBook do João" },
      latest: {},
      updatedAt: ago(3),
    });
    const { router } = await go(seed([connected]));
    expect(row("n-machine").querySelector(".ib-row__line")?.textContent).toBe(
      "João conectou o computador MacBook do João",
    );
    expect(row("n-machine").querySelector(".ib-row__sub")?.textContent).toBe("Computador");
    await click(within(read()).getByRole("button", { name: "Abrir" }));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/devices/m-9`);
  });
});

describe("someone gave an agent the person's plan (ADR 0059 §3)", () => {
  test("who connected it to which agent, and Tirar de volta takes it back from that agent or from all", async () => {
    const lent = notification({
      id: "n-lent",
      kind: "plan_lent",
      actors: [{ type: "user", id: "u-joao" }],
      source: { agentId: ADA_ID, accountId: "acct_wes", label: "Ada" },
      latest: { plan: "Claude" },
      updatedAt: ago(3),
    });
    const { state } = await go(seed([lent]));
    expect(row("n-lent").textContent).toContain("João conectou o seu plano do Claude à\u00a0Ada");
    // Its own actions are on the open item.
    await click(within(read()).getByRole("button", { name: "Tirar de volta" }));
    await settle(4);
    await click(within(read()).getByRole("button", { name: "Tirar de todos os agentes" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "machines.takeBackPlan").map((c) => c.args)).toEqual([
      [ORG_ID, "acct_wes", ADA_ID],
      [ORG_ID, "acct_wes", undefined],
    ]);
    expect(document.body.textContent).toContain("Seu plano voltou");
  });
});

describe("an agent's model left its plan's list", () => {
  test("which model, which plan, what runs now; Escolher outro modelo opens the agent's Quem pensa on its model", async () => {
    const dropped = notification({
      id: "n-dropped",
      kind: "plan_model_dropped",
      actors: [{ type: "agent", id: ADA_ID }],
      source: { agentId: ADA_ID, label: "Ada" },
      latest: { title: "DeepSeek V4.1 Flash", plan: "OpenCode Go", nowModel: "MiniMax M3" },
      updatedAt: ago(3),
    });
    const { router } = await go(seed([dropped]));
    const said =
      "O DeepSeek V4.1 Flash saiu do OpenCode Go. Ada está usando o MiniMax M3 até você escolher outro modelo.";
    expect(row("n-dropped").textContent).toContain(said);
    expect(read().querySelector(".ib-read__title")?.textContent).toBe(said);
    // The open item's button names the way out, in place of a plain Abrir.
    expect(within(read()).queryByRole("button", { name: "Abrir" })).toBeNull();
    await click(within(read()).getByRole("button", { name: "Escolher outro modelo" }));
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/agents/${ADA_ID}`);
    // On the dialog's first screen, where its Modelo is.
    const d = screen().getByRole("dialog", { name: "Quem pensa pela Ada" });
    expect(within(d).getByRole("combobox", { name: "Modelo" })).toBeTruthy();
  });
});

describe("agents that failed for one cause (ADR 0097)", () => {
  const failure = (agentId: string, messageId: string) => ({
    key: `run_failed:${agentId}:${ENG_ID}:${messageId}`,
    agentId,
    channelId: ENG_ID,
    messageId,
    label: "eng",
  });
  test("one row says how many and why; open, it lists each agent, and each goes to its conversation", async () => {
    const grouped = notification({
      id: "n-fails",
      kind: "run_failed",
      count: 2,
      actors: [
        { type: "agent", id: ATLAS_ID },
        { type: "agent", id: ADA_ID },
      ],
      source: { channelId: ENG_ID, messageId: "m-a", agentId: ADA_ID, label: "eng" },
      latest: {
        reason: "not_logged_in",
        plan: "Claude",
        failures: [failure(ADA_ID, "m-a"), failure(ATLAS_ID, "m-b")],
      },
      updatedAt: ago(2),
    });
    const lone = notification({
      id: "n-fail",
      kind: "run_failed",
      actors: [{ type: "agent", id: ADA_ID }],
      source: { channelId: ENG_ID, messageId: "m-c", agentId: ADA_ID, label: "eng" },
      latest: { reason: "budget_exceeded", failures: [failure(ADA_ID, "m-c")] },
      updatedAt: ago(4),
    });
    const { router } = await go(seed([grouped, lone]));
    expect(row("n-fails").querySelector(".nt-what")?.textContent).toBe(
      "2 agentes não conseguiram continuar: a conta do Claude foi desconectada",
    );
    // A lone failure reads as it always did.
    expect(row("n-fail").querySelector(".nt-what")?.textContent).toBe("Ada não conseguiu terminar");
    // Open, the agents it groups are there, with no toggle.
    const item = await open("n-fails");
    expect(within(item).queryByRole("button", { name: "Ver 2 agentes" })).toBeNull();
    const agents = [...item.querySelectorAll(".nt-fails .nt-rep")];
    expect(agents.map((a) => a.textContent)).toEqual(["Ada#eng", "Atlas#eng"]);
    await click(agents[1] as Element);
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
  });
});

describe("what the workspace itself tells: nobody's face, its own", () => {
  test("its computer ready, its standing: an icon where the face goes, and unread in the headline's weight", async () => {
    const ready = notification({ id: "n-ready", kind: "computer_ready", updatedAt: ago(3) });
    const hold = notification({
      id: "n-hold",
      kind: "org_standing",
      latest: { statusTo: "hold" },
      readAt: ago(1),
      updatedAt: ago(2),
    });
    await go(seed([ready, hold]));
    expect(row("n-ready").textContent).toContain("O computador do seu workspace está pronto");
    for (const id of ["n-ready", "n-hold"]) expect(row(id).querySelector(".ib-row__face .nt-sys svg")).toBeTruthy();
    expect(row("n-ready").classList.contains("is-unread")).toBe(true);
    expect(row("n-hold").classList.contains("is-unread")).toBe(false);
    // With nobody to name, a screen reader reads what it tells.
    expect(row("n-ready").getAttribute("aria-label")).toBe("O computador do seu workspace está pronto, não lida");
    expect(row("n-hold").getAttribute("aria-label")).toBe("O workspace está em espera: os agentes estão pausados");
    // Open, the workspace's mark stands where a face would.
    expect((await open("n-hold")).querySelector(".ib-read__face .nt-sys svg")).toBeTruthy();
  });

  test("an unread row carries a dot under its time; Mark all as read is a button in the header while any is unread", async () => {
    const css = await Bun.file(new URL("../src/pages/notifications.css", import.meta.url).pathname).text();
    // The dot is drawn by the row's end (no element of its own).
    expect(css).toMatch(
      /\.ib-row\.is-unread \.ib-row__end::after \{[^}]*border-radius: 50%[^}]*background: var\(--danger\)/,
    );
    const { state } = await go();
    const button = () => document.querySelector<HTMLButtonElement>(".ib-head .ib-readall");
    expect(button()?.getAttribute("aria-label")).toBe("Marcar tudo como lido");
    await click(button() as HTMLElement);
    await settle(4);
    expect(state.calls.find((c) => c.method === "notifications.readAll")?.args).toEqual([ORG_ID, "all"]);
    // Nothing left unread: no row says so, and the button leaves.
    expect(document.querySelector(".ib-list .ib-row.is-unread")).toBeNull();
    expect(button()).toBeNull();
  });

  test("a headline with no name in it carries the unread weight whole, and loses it once read", async () => {
    const css = await Bun.file(new URL("../src/pages/notifications.css", import.meta.url).pathname).text();
    expect(css).toMatch(/\.nt-what:not\(:has\(b\)\) \{[^}]*font-weight: 600/);
    // The inbox's rows (ADR 0218): a read one with nobody's name in its headline is as quiet as any read row.
    expect(css).toMatch(/\.ib-row:not\(\.is-unread\)[^{}]*:not\(:has\(b\)\)[^{}]*\{[^}]*font-weight: 500/);
  });

  test("an agent held on agentes.chat Cloud: its name, then the hold's whole line, never its reason", async () => {
    const held = notification({
      id: "n-held",
      kind: "org_standing",
      source: { agentId: ADA_ID, label: "Ada" },
      latest: { statusTo: "agent_hold", holdKind: "network" },
      updatedAt: ago(2),
    });
    await go(seed([held]));
    expect(row("n-held").querySelector(".nt-what")?.textContent).toBe("Ada está em pausa");
    const line =
      "Este agente está pausado. As nossas regras de rede viram sinais de abuso no tráfego dele (Termos, seção 5). Para contestar, escreva para legal@agentes.chat.";
    expect(row("n-held").querySelector(".ib-row__sub")?.textContent).toBe(line);
    // How to contest it is never cut off: the row keeps one line, the open item says it whole.
    expect(read().querySelector(".ib-read__say")?.textContent).toBe(line);
    const css = await Bun.file(new URL("../src/pages/notifications.css", import.meta.url).pathname).text();
    expect(/\n\.ib-read__say \{([^}]*)\}/.exec(css)?.[1]).not.toMatch(/line-clamp|nowrap|overflow: hidden/);
    expect(row("n-held").querySelector(".ib-row__face .nt-sys svg")).toBeTruthy();
    expect(row("n-held").getAttribute("aria-label")).toBe("Ada está em pausa, não lida");
  });

  test("the workspace held or suspended on agentes.chat Cloud reads as the restriction, never 'review'", async () => {
    const contest = "Para contestar, escreva para legal@agentes.chat.";
    const standing = (id: string, latest: AppNotification["latest"]) =>
      notification({ id, kind: "org_standing", latest, updatedAt: ago(2) });
    await go(
      seed([
        standing("n-review", { statusTo: "hold", text: "review", cloud: true }),
        standing("n-flagged", { statusTo: "hold", text: "review.phishing_impersonation", cloud: true }),
        standing("n-new", { statusTo: "hold", text: "review.something_new", cloud: true }),
        standing("n-hold", { statusTo: "hold", text: "Termos 5: phishing", cloud: true }),
        standing("n-suspended", { statusTo: "suspended", text: "Termos 5: spam", cloud: true }),
        standing("n-self", { statusTo: "hold", text: "review" }),
      ]),
    );
    // Each says its line whole once open.
    const line = async (id: string) => (await open(id)).querySelector(".ib-read__say")?.textContent;
    const review =
      "Pausado para uma análise de segurança, até a nossa equipe olhar o caso. As nossas verificações automáticas detectaram uma atividade que pode violar os nossos Termos (seção 5).";
    expect(await line("n-review")).toBe(`${review} ${contest}`);
    // What the automatic hold flagged, named; a category the app doesn't know reads as plain review.
    expect(await line("n-flagged")).toBe(
      `Pausado para uma análise de segurança, até a nossa equipe olhar o caso. As nossas verificações automáticas detectaram uma atividade que parece envolver phishing ou imitação de uma marca, o que os nossos Termos não permitem (seção 5). ${contest}`,
    );
    expect(await line("n-new")).toBe(`${review} ${contest}`);
    expect(await line("n-hold")).toBe(`Este workspace está em espera: Termos 5: phishing. ${contest}`);
    expect(await line("n-suspended")).toBe(`Este workspace está suspenso: Termos 5: spam. ${contest}`);
    // A self-hosted server: the reason, as it always read.
    expect(await line("n-self")).toBe("review");
  });
});

describe("its computer is ready: what comes next", () => {
  test("no agent has an AI yet: Abrir opens Connect an AI, saying it's ready; with one, the computer's page", async () => {
    const ready = notification({
      id: "n-ready",
      kind: "computer_ready",
      source: { machineId: "m-9" },
      updatedAt: ago(3),
    });
    const noAi = { any: false, agents: [{ agentId: ADA_ID, state: "no_ai" as const, reason: "no_key" as const }] };
    const state = seed([ready], { aiStatus: noAi });
    // Ada is Walter's: a plan of his thinks for her.
    for (const a of state.agents) if (a.id === ADA_ID) a.ownerUserId = "u-walter";
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setSetup({ state: "ready", machineId: "m-9" });
    const brain = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => ({ ...(await brain(orgId, agentId)), ownSignIn: false });
    const { router } = await renderApp(`/org/${ORG_ID}/notifications`, { api });
    await settle(8);
    // The only item is open: its Abrir.
    await click(within(read()).getByRole("button", { name: "Abrir" }));
    await settle(8);
    // Connect for the team; Claude's steps say the computer is ready first.
    const dialog = screen().getByRole("dialog", { name: "Conectar uma IA para o time" });
    await click(within(dialog).getByRole("button", { name: /^Claude/ }));
    await settle(4);
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.textContent).toContain("O computador está pronto.");
    expect((within(dialog).getByRole("button", { name: "Entrar com Claude" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    expect(state.calls.filter((c) => c.method === "notifications.read").map((c) => c.args)).toEqual([
      [ORG_ID, "n-ready", true],
    ]);
    cleanup();

    // An agent thinks already: the computer's page, as before.
    const other = await go(seed([ready]));
    await click(within(read()).getByRole("button", { name: "Abrir" }));
    await settle(4);
    expect(other.router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/devices/m-9`);
  });

  test("a click on its row opens Connect an AI while no agent has one, marking it read once", async () => {
    const ready = () => notification({ id: "n-ready", kind: "computer_ready", source: { machineId: "m-9" } });
    const noAi = { any: false, agents: [{ agentId: ADA_ID, state: "no_ai" as const, reason: "no_key" as const }] };
    const state = seed([ready()], { aiStatus: noAi });
    for (const a of state.agents) if (a.id === ADA_ID) a.ownerUserId = "u-walter";
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setSetup({ state: "ready", machineId: "m-9" });
    const { router } = await renderApp(`/org/${ORG_ID}/notifications`, { api });
    await settle(8);
    await click(row("n-ready"));
    await settle(8);
    // Nobody named: Connect for the team (ADR 0160, addendum), Ada being the one without an AI.
    expect(screen().getByRole("dialog", { name: "Conectar uma IA para o time" })).toBeTruthy();
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    expect(state.calls.filter((c) => c.method === "notifications.read").map((c) => c.args)).toEqual([
      [ORG_ID, "n-ready", true],
    ]);
  });

  test("an agent thinks already: a click opens it beside the list as any row, a double click goes to the computer's page", async () => {
    const ready = () => notification({ id: "n-ready", kind: "computer_ready", source: { machineId: "m-9" } });
    const wide = await go(seed([ready()]));
    await open("n-ready");
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(wide.router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    await act(async () => fireEvent.doubleClick(row("n-ready")));
    await settle(4);
    expect(wide.router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/devices/m-9`);
  });

  test("on a narrow screen a tap shows the item in the list's place, with its menu, Abrir and the way back", async () => {
    await onNarrowScreen(async () => {
      const ready = notification({ id: "n-ready", kind: "computer_ready", source: { machineId: "m-9" } });
      const { router, state } = await go(seed([ready]));
      const page = document.querySelector(".ib") as HTMLElement;
      // Nothing opens by itself: the list stays until the person picks.
      expect(read()).toBeNull();
      expect(page.classList.contains("ib--open")).toBe(false);
      expect(state.calls.some((c) => c.method === "notifications.read")).toBe(false);
      const item = await open("n-ready");
      expect(page.classList.contains("ib--open")).toBe(true);
      expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
      expect(state.calls.filter((c) => c.method === "notifications.read").map((c) => c.args)).toEqual([
        [ORG_ID, "n-ready", true],
      ]);
      // Feito and Lembrar depois stay in reach, in its menu.
      expect(await moreItems()).toEqual(MORE);
      await click(within(item).getByRole("button", { name: "Voltar" }));
      expect(read()).toBeNull();
      expect(page.classList.contains("ib--open")).toBe(false);
      expect(row("n-ready").getAttribute("aria-current")).toBeNull();
      await click(within(await open("n-ready")).getByRole("button", { name: "Abrir" }));
      await settle(4);
      expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/devices/m-9`);
    });
  });

  test("a row is one button: the face, the headline with one line under it, the time at its end", async () => {
    await go();
    const item = row("n-thread");
    expect(item.matches("button.ib-row")).toBe(true);
    expect([...item.children].map((c) => c.className)).toEqual(["ib-row__face", "ib-row__text", "ib-row__end"]);
    expect(item.querySelector(":scope > .ib-row__face .nt-stk")).toBeTruthy();
    expect([...(item.querySelector(".ib-row__text") as HTMLElement).children].map((c) => c.className)).toEqual([
      "ib-row__line nt-what",
      "ib-row__sub",
    ]);
    expect(item.querySelector(".ib-row__end")?.textContent).toBeTruthy();
    const css = (await Bun.file(new URL("../src/pages/notifications.css", import.meta.url).pathname).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const body = (selector: string) =>
      new RegExp(`\\n *${selector.replace(/[.()>:]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    // The face, the words, the time: three columns, the words taking what is left.
    expect(body(".ib-row")).toContain("grid-template-columns: auto minmax(0, 1fr) auto");
    // One line each, cut with an ellipsis: the open item says them whole.
    for (const line of [".ib-row__line", ".ib-row__sub"]) {
      expect(body(line)).toContain("white-space: nowrap");
      expect(body(line)).toContain("text-overflow: ellipsis");
    }
    expect(css).not.toContain(".nt-who");
    // One face size in the list: a person, the workspace's own tile, two faces or two emoji.
    for (const face of [".nt-av24", ".nt-sys", ".nt-stk", ".nt-emo"]) expect(body(face)).toContain("height: 24px");
  });
});

describe("an agent asks for a hand (ADR 0040, ADR 0058)", () => {
  test("in its browser, or on its computer when the request is on its desktop", async () => {
    const ask = (id: string, screen?: "desktop") =>
      notification({
        id,
        kind: "browser_handoff",
        waiting: true,
        actors: [{ type: "agent", id: ADA_ID }],
        source: { channelId: ENG_ID, handoffId: `h-${id}`, ...(screen ? { screen } : {}) },
        latest: { text: "Entrar no painel" },
        updatedAt: ago(2),
      });
    await go(seed([ask("n-browser"), ask("n-desktop", "desktop")]));
    const said = (id: string) => row(id).textContent;
    expect(said("n-browser")).toContain("Ada precisa de você no navegador");
    expect(said("n-browser")).toContain("Navegador");
    expect(said("n-desktop")).toContain("Ada precisa de você no computador");
    expect(said("n-desktop")).toContain("Computador");
    expect(said("n-desktop")).not.toContain("Navegador");
  });

  test("one row: where and what to do under the headline; a click opens it beside the list, Abrir goes to its conversation", async () => {
    const hand = notification({
      id: "n-hand",
      kind: "browser_handoff",
      waiting: true,
      actors: [{ type: "agent", id: ADA_ID }],
      source: { channelId: ENG_ID, handoffId: "h-1" },
      latest: { text: "Entrar no painel", expiresAt: new Date(Date.now() + 18 * 60_000).toISOString() },
      updatedAt: ago(2),
    });
    const { router } = await go(seed([hand]));
    expect(row("n-hand").querySelector(".ib-row__sub")?.textContent).toBe("Navegador · Entrar no painel");
    const item = await open("n-hand");
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    expect(item.querySelector(".ib-read__say")?.textContent).toBe("Entrar no painel");
    await click(within(item).getByRole("button", { name: "Abrir" }));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
  });
});

describe("an agent asks for a secret (ADR 0027)", () => {
  test("one row: who asks, the secret's name and what for; open, Abrir goes to its card's conversation", async () => {
    const ask = notification({
      id: "n-secret",
      kind: "secret_request",
      waiting: true,
      actors: [{ type: "agent", id: ADA_ID }],
      source: { channelId: ENG_ID, messageId: "msg-s" },
      latest: {
        title: "NPM_TOKEN",
        text: "publicar o pacote no npm",
        expiresAt: new Date(Date.now() + 12 * 60_000).toISOString(),
      },
      updatedAt: ago(1),
    });
    const { router } = await go(seed([ask]));
    expect(row("n-secret").querySelector(".nt-what")?.textContent).toBe("Ada pediu um segredo a você");
    expect(row("n-secret").querySelector(".ib-row__sub")?.textContent).toBe(
      "#eng · NPM_TOKEN · publicar o pacote no npm",
    );
    const item = await open("n-secret");
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    expect(item.querySelector(".ib-read__say")?.textContent).toBe("NPM_TOKEN · publicar o pacote no npm");
    await click(within(item).getByRole("button", { name: "Abrir" }));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
  });
});

describe("Esperando você: what only points somewhere opens beside the list, with Abrir", () => {
  const asks = (over: Partial<AppNotification> = {}) =>
    notification({
      id: "n-join",
      kind: "join_request",
      waiting: true,
      source: { label: "Acme" },
      latest: { title: "Felipe Ramos", names: ["Felipe Ramos"] },
      ...over,
    });
  const marina = { title: "Marina Alves", names: ["Marina Alves"] };

  test("its row; open, where it is from, its words and Abrir alone, with Lembrar depois and Feito in its menu", async () => {
    await go(seed([asks(), asks({ id: "n-read", latest: marina, readAt: ago(1) })]));
    const item = row("n-join");
    expect(item.querySelector(".ib-row__line")?.textContent).toBe("Felipe Ramos pede para entrar");
    expect(item.querySelector(".ib-row__sub")?.textContent).toBe("Convites");
    expect(item.querySelector(".ib-row__end")?.textContent).toBe("agora");
    // Unread is the headline's weight; read, not.
    expect(item.classList.contains("is-unread")).toBe(true);
    expect(row("n-read").classList.contains("is-unread")).toBe(false);
    const opened = await open("n-join");
    expect(opened.querySelector(".ib-read__who")?.textContent).toBe("Convites · agora");
    expect(opened.querySelector("h2.ib-read__title")?.textContent).toBe("Felipe Ramos pede para entrar");
    // It only points somewhere: Abrir is its one button, the main one.
    const buttons = within(opened.querySelector(".ib-decide") as HTMLElement).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Abrir"]);
    expect(buttons[0]?.className).toContain("ac-btn--primary");
    expect(await moreItems()).toEqual(MORE);
  });

  test("a screen reader hears who asks to join, and whether it is unread", async () => {
    await go(seed([asks(), asks({ id: "n-read", latest: marina, readAt: ago(1) })]));
    expect(row("n-join").getAttribute("aria-label")).toBe("Felipe Ramos pede para entrar, não lida");
    expect(row("n-read").getAttribute("aria-label")).toBe("Marina Alves pede para entrar");
  });

  test("a click on it opens it beside the list and marks it read; Abrir goes where it is answered", async () => {
    const { state, router } = await go(seed([asks()]));
    const item = await open("n-join");
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    expect(state.calls.find((c) => c.method === "notifications.read")?.args).toEqual([ORG_ID, "n-join", true]);
    await click(within(item).getByRole("button", { name: "Abrir" }));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/invites`);
  });

  test("Lembrar depois and Feito, from the open item's menu, never go where it is answered", async () => {
    const { state, router } = await go(seed([asks(), asks({ id: "n-other", latest: marina })]));
    await open("n-join");
    await fromMoreMenu(/Em 1 hora/);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    const until = new Date(String(state.calls.find((c) => c.method === "notifications.snooze")?.args[2]));
    expect(Math.abs(until.getTime() - Date.now() - 3_600_000)).toBeLessThan(60_000);
    expect(row("n-join")).toBeNull();
    await open("n-other");
    await fromMoreMenu(/^Feito/);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    expect(state.calls.find((c) => c.method === "notifications.done")?.args).toEqual([ORG_ID, "n-other", true]);
    expect(row("n-other")).toBeNull();
  });

  test("every open item has the same menu, a question and an approval as what only points somewhere", async () => {
    const approval = notification({
      id: "n-ap",
      kind: "approval",
      waiting: true,
      actors: [{ type: "agent", id: ATLAS_ID }],
      source: { approvalId: "ap-deploy", channelId: ENG_ID },
      latest: { title: "Run deploy workflow" },
      updatedAt: ago(5),
    });
    await go(seed([...inbox(), approval, asks()]));
    for (const id of ["n-q", "n-ap", "n-join"]) {
      await open(id);
      expect(await moreItems()).toEqual(MORE);
      // Remind me later and Done are not on the cards themselves.
      expect(read().querySelector(".nt-tail")).toBeNull();
    }
  });

  test("its geometry, from the stylesheet: the open item beside the list, one of the two at a time on a narrow screen", async () => {
    const css = (await Bun.file(new URL("../src/pages/notifications.css", import.meta.url).pathname).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const narrow = css.split("\n@media (max-width: 900px) {")[1]?.split("\n}")[0] ?? "";
    /** The body of a rule written at the top level of `sheet` (two-space indented inside a media block). */
    const rule = (selector: string, sheet = css) =>
      new RegExp(`\\n *${selector.replace(/[.()>:*[\]]/g, "\\$&")} \\{([^}]*)\\}`).exec(sheet)?.[1] ?? "";
    const value = (selector: string, prop: string, sheet = css) =>
      new RegExp(`(?:^|[;\\s])${prop}: ([^;]+);`).exec(rule(selector, sheet))?.[1];
    // Side by side, the way back is not needed.
    expect(value(".ib-read__back", "display")).toBe("none");
    // The width the page itself reads (`NARROW`): the list alone, or the open item in its place with the way back.
    expect(value(".ib-read", "display", narrow)).toBe("none");
    expect(value(".ib--open > .ib-list", "display", narrow)).toBe("none");
    expect(value(".ib--open > .ib-read", "display", narrow)).toBe("block");
    expect(value(".ib-read__back", "display", narrow)).toBe("inline-flex");
    // A row clips its lines: its focus ring goes inside.
    expect(value("html:not([data-pointer]) .ib-row:focus-visible", "box-shadow")).toBe("var(--focus-ring-inset)");
  });
});

describe("a click on a browser notification (ADR 0071)", () => {
  test("no tab open: ?open= goes where Abrir goes and marks it read, in place of the inbox", async () => {
    const state = seed(inbox());
    const { router } = await renderApp(`/org/${ORG_ID}/notifications?open=n-thread`, { api: createFakeApi(state) });
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    expect(state.calls.filter((c) => c.method === "notifications.read").map((c) => c.args)).toEqual([
      [ORG_ID, "n-thread", true],
    ]);
  });

  test("no tab open, a routine's trouble: its details over the inbox, without ?open", async () => {
    const state = seed(inbox());
    const api = createFakeApi(state);
    const failed = (await api.routines.list(ORG_ID))[0];
    if (!failed) throw new Error("no routine seeded");
    for (const n of state.notifications ?? []) if (n.id === "n-routine") n.source.routineId = failed.id;
    const { router } = await renderApp(`/org/${ORG_ID}/notifications?open=n-routine`, { api });
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    expect(router.state.location.search).toEqual({});
    expect(screen().getByRole("dialog", { name: failed.name })).toBeTruthy();
  });

  test("one that is gone: the inbox, without ?open", async () => {
    const state = seed(inbox());
    const { router } = await renderApp(`/org/${ORG_ID}/notifications?open=n-gone`, { api: createFakeApi(state) });
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    expect(router.state.location.search).toEqual({});
    expect(row("n-thread")).not.toBeNull();
  });

  test("a tab open in the workspace: it opens there at once, no stop at the inbox", async () => {
    const state = seed(inbox());
    const api = createFakeApi(state);
    // The routine that failed: its details open over the page the person is on.
    const failed = (await api.routines.list(ORG_ID))[0];
    if (!failed) throw new Error("no routine seeded");
    for (const n of state.notifications ?? []) if (n.id === "n-routine") n.source.routineId = failed.id;
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const seen: string[] = [];
    const unsubscribe = router.subscribe("onResolved", (e) => seen.push(e.toLocation.pathname));
    await act(async () =>
      dispatchPushOpen(
        {
          path: pushOpenPath(ORG_ID, "n-routine"),
          data: { orgId: ORG_ID, notificationId: "n-routine", kind: "routine_failed" },
        },
        (path) => router.history.push(path),
      ),
    );
    await settle(8);
    unsubscribe();
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    expect(screen().getByRole("dialog", { name: failed.name })).toBeTruthy();
    expect(seen).not.toContain(`/org/${ORG_ID}/notifications`);
    expect(state.calls.find((c) => c.method === "notifications.read")?.args).toEqual([ORG_ID, "n-routine", true]);
  });
});

describe("catch-ups an agent skipped as already handled (ADR 0136)", () => {
  test("the owner's grouped row opens the agent's queue in place; the asker's names the place once", async () => {
    const skipped = notification({
      id: "n-skip",
      kind: "catch_up_closed",
      actors: [{ type: "agent", id: ATLAS_ID }],
      count: 2,
      source: { channelId: ENG_ID, messageId: "m-note", label: "Atlas" },
      latest: {},
      updatedAt: ago(3),
    });
    const asker = notification({
      id: "n-asker",
      kind: "catch_up_closed_asker",
      actors: [{ type: "agent", id: ATLAS_ID }],
      source: { channelId: ENG_ID, messageId: "m-note", label: "eng" },
      latest: { title: "Ada", reason: "solved" },
      updatedAt: ago(4),
    });
    const state = seed([skipped, asker]);
    const at = new Date().toISOString();
    state.usageQueues = {
      [ATLAS_ID]: {
        agentId: ATLAS_ID,
        reason: "plan",
        plan: "Claude",
        resetsAt: null,
        sharedWith: [],
        rows: [
          {
            runId: "r-q",
            kind: "conversation",
            channelId: ENG_ID,
            threadId: null,
            channelKind: "channel",
            channelName: "eng",
            messageId: "m-q",
            askers: ["u-joao"],
            since: at,
            after: { count: 0, names: [] },
            state: "queued",
            title: null,
            mayStop: true,
          },
        ],
        hidden: 0,
        mayStopAll: true,
        closed: [
          {
            runId: "r-s",
            channelId: ENG_ID,
            threadId: null,
            channelKind: "channel",
            channelName: "eng",
            messageId: "m-note",
            closed: { reason: "solved", who: { name: "Nina" }, askers: ["u-joao"], at },
            continuedRunId: null,
            mayAnswer: true,
          },
        ],
      },
    };
    const { router } = await go(state);
    const owners = row("n-skip");
    expect(owners.textContent).toContain("Atlas retomou e pulou 2 conversas que não precisavam de resposta");
    // Two places: the queue lists each, so no single channel beside it.
    expect(owners.textContent).not.toContain("#eng");
    const askers = row("n-asker");
    expect(askers.textContent?.match(/#eng/g)).toHaveLength(1);
    const before = router.state.location.pathname;
    await click(within(await open("n-skip")).getByRole("button", { name: "Abrir" }));
    await settle(4);
    expect(router.state.location.pathname).toBe(before);
    // Opened from a skip: on what it skipped, the line in line one tap away.
    const dialog = screen().getByRole("dialog");
    expect(dialog.textContent).toContain("Atlas");
    expect(
      within(dialog)
        .getByRole("radio", { name: /Puladas/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(dialog.textContent).toContain("Nina já cuidou disso");
    expect(within(dialog).getByRole("button", { name: "Responder mesmo assim" })).toBeTruthy();
  });
});

describe("one inbox (ADR 0218)", () => {
  const filterName = () => document.querySelector(".ib-filter")?.textContent;
  const approvalNotice = () =>
    notification({
      id: "n-ap",
      kind: "approval",
      waiting: true,
      actors: [{ type: "agent", id: ATLAS_ID }],
      source: { approvalId: "ap-deploy", channelId: ENG_ID },
      latest: { title: "Run deploy workflow" },
      updatedAt: ago(5),
    });
  /** The decided requests in the list, and the card of the one open beside it. */
  const requestIds = () =>
    [...document.querySelectorAll<HTMLElement>(".ib-list .ap-li")].map((r) => r.getAttribute("data-id"));
  const requestRow = (id: string) => document.querySelector(`.ib-list .ap-li[data-id="${id}"]`) as HTMLElement;
  const openCard = () => read().querySelector(".rq") as HTMLElement;
  /** What the open request would run: a decided card names no id. */
  const openDetail = () => openCard().querySelector(".rq__wt small")?.textContent;

  test("the first waiting item opens beside the list, ahead of anything newer; on a narrow screen the list stays", async () => {
    const [q] = inbox();
    if (!q) throw new Error("the sample inbox changed");
    const newer = notification({
      id: "n-newer",
      kind: "mention",
      actors: [{ type: "user", id: "u-joao" }],
      source: { channelId: ENG_ID, messageId: "m-1" },
      latest: { text: "@walter viu o deploy?" },
      updatedAt: ago(1),
    });
    const { state } = await go(seed([newer, q]));
    expect(row("n-q").getAttribute("aria-current")).toBe("true");
    expect(row("n-newer").getAttribute("aria-current")).toBeNull();
    expect(openCard().getAttribute("data-ask-id")).toBe("n-q");
    expect(document.querySelector(".ib")?.classList.contains("ib--open")).toBe(true);
    // Shown, not read: only the person's own click reads it.
    expect(row("n-q").classList.contains("is-unread")).toBe(true);
    expect(state.calls.some((c) => c.method === "notifications.read")).toBe(false);
    cleanup();

    await onNarrowScreen(async () => {
      await go(seed([newer, q]));
      expect(read()).toBeNull();
      expect(document.querySelector(".ib-list .is-on")).toBeNull();
      expect(document.querySelector(".ib")?.classList.contains("ib--open")).toBe(false);
    });
  });

  test("a click on a row opens it beside the list and marks it read, without leaving the inbox", async () => {
    const { state, router } = await go();
    const item = await open("n-thread");
    expect(row("n-thread").getAttribute("aria-current")).toBe("true");
    expect(row("n-q").getAttribute("aria-current")).toBeNull();
    // Who, where and when, then the headline and its words.
    expect(item.querySelector(".ib-read__who")?.textContent).toMatch(/^João · Thread · #eng · /);
    expect(item.querySelector("h2.ib-read__title")?.textContent).toBe("João e Ada responderam em Login 401");
    expect(item.querySelector(".ib-read__say")?.textContent).toContain("@walter dá para subir hoje ainda?");
    expect(state.calls.filter((c) => c.method === "notifications.read").map((c) => c.args)).toEqual([
      [ORG_ID, "n-thread", true],
    ]);
    expect(row("n-thread").classList.contains("is-unread")).toBe(false);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    expect(router.state.location.search).toEqual({});
    // The next click takes its place: one item open at a time.
    expect((await open("n-rx")).querySelector(".ib-read__say")?.textContent).toContain("A 2.4.0 está no ar.");
    expect(document.querySelectorAll("section.ib-read")).toHaveLength(1);
    expect([...document.querySelectorAll<HTMLElement>(".ib-list .is-on")].map((r) => r.dataset.n)).toEqual(["n-rx"]);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
  });

  test("Pedidos decididos lists the requests already decided, the newest first, and opens one with how it ended", async () => {
    const state = seed(inbox());
    const old = state.approvals.find((a) => a.id === "ap-old");
    if (!old) throw new Error("no decided request seeded");
    state.approvals.push({
      ...old,
      id: "ap-later",
      title: "Run cleanup workflow",
      detail: "github.run_workflow · cleanup.yml",
      decidedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await go(state);
    await pickFilter(/Pedidos decididos/);
    expect(filterName()).toBe("Pedidos decididos");
    // The approvals' own list, without the ones still waiting; no notification among them.
    expect(requestIds()).toEqual(["ap-later", "ap-old"]);
    expect(rowIds()).toEqual([]);
    // The newest opens by itself.
    expect(requestRow("ap-later").getAttribute("aria-current")).toBe("true");
    expect(openDetail()).toBe("github.run_workflow · cleanup.yml");
    await click(requestRow("ap-old"));
    await settle(4);
    expect(requestRow("ap-old").getAttribute("aria-current")).toBe("true");
    expect(requestRow("ap-later").getAttribute("aria-current")).toBeNull();
    const card = openCard();
    expect(openDetail()).toBe("github.run_workflow · rollback.yml");
    expect(card.getAttribute("data-ask-kind")).toBe("approval");
    // Decided: who approved it, and nothing left to decide.
    expect(card.classList.contains("rq--ended")).toBe(true);
    expect(card.querySelector(".rq__answer-text")?.textContent).toBe("Aprovado por João");
    expect(card.querySelector("[data-approve]")).toBeNull();
    expect(within(card).queryByRole("button", { name: "Agora não" })).toBeNull();
    // Nothing to mark read or clear there, and no keys.
    const menu = await filterMenu();
    expect(menu.queryByRole("menuitem", { name: "Concluir todas" })).toBeNull();
    expect(menu.queryByRole("menuitem", { name: "Marcar tudo como lido" })).toBeNull();
    // Back on Tudo, the inbox is as it was.
    await click(menu.getByRole("menuitemradio", { name: /Tudo/ }));
    await settle(4);
    expect(requestIds()).toEqual([]);
    expect(row("n-q").getAttribute("aria-current")).toBe("true");
  });

  test("Pedidos decididos with none decided says so", async () => {
    const state = seed(inbox());
    state.approvals = state.approvals.filter((a) => a.status === "pending");
    await go(state);
    await pickFilter(/Pedidos decididos/);
    expect(requestIds()).toEqual([]);
    expect(document.querySelector(".ib-list .ac-empty")?.textContent).toBe("Nenhum pedido decidido ainda.");
    expect(read()).toBeNull();
  });

  test("proposals are never rows, and an older notice that proposals wait is neither listed nor counted (ADR 0219)", async () => {
    const notice = notification({
      id: "n-proposals",
      kind: "proposal_waiting",
      waiting: true,
      actors: [{ type: "agent", id: ADA_ID }],
      latest: { title: "Manter PRs pequenos" },
    });
    // The seed's two proposals, their review still weighing them: nobody decides them.
    const state = seedState({ notifications: [notice, ...inbox()] });
    for (const p of state.proposals) p.canDecide = true;
    await go(state);
    expect(rowIds().some((id) => id?.startsWith("proposal:"))).toBe(false);
    expect(rowIds()).not.toContain("n-proposals");
    // What waits is the question alone, counted once.
    expect(screen().getByRole("region", { name: "Esperando você" }).querySelector(".ac-grouphead")?.textContent).toBe(
      "Esperando você1",
    );
    expect(document.querySelector(".ac-pagehead__meta")?.textContent).toContain("1 coisa esperando você");
    expect(sidebarEntry().querySelector(".ac-count")?.textContent).toBe("1");
    expect(row("n-q").getAttribute("aria-current")).toBe("true");
    await pickFilter(/Esperando você/);
    expect(rowIds()).toEqual(["n-q"]);
  });

  test("what an agent applied itself is one row: who applied how many, the newest change; Abrir opens the history", async () => {
    const applied = notification({
      id: "n-applied",
      kind: "proposal_applied",
      actors: [{ type: "agent", id: ADA_ID }],
      count: 2,
      source: { agentId: ADA_ID, label: "Ada", proposalId: "prop-1" },
      latest: { title: "Atualizar as instruções da Ada" },
      updatedAt: ago(3),
    });
    const { router } = await go(seed([applied]));
    expect(rowIds()).toEqual(["n-applied"]);
    expect(row("n-applied").querySelector(".ib-row__line")?.textContent).toBe("Ada aplicou 2 melhorias");
    expect(row("n-applied").querySelector(".ib-row__sub")?.textContent).toBe(
      "Melhorias dos agentes · Atualizar as instruções da Ada",
    );
    // Nothing to decide: it opens beside the list with the newest change, and Open goes to Agent improvements.
    expect(read().querySelector(".ib-read__say")?.textContent).toContain("Atualizar as instruções da Ada");
    expect(within(read()).queryByRole("button", { name: /^Aceitar/ })).toBeNull();
    await click(within(read()).getByRole("button", { name: "Abrir" }));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/proposals`);
  });

  test("the old pages' addresses land on the inbox: what waits on its filter, a request open by its id", async () => {
    const at = async (path: string) => {
      const { router } = await renderApp(path, { api: createFakeApi(seed([...inbox(), approvalNotice()])) });
      await settle(8);
      return router.state.location;
    };
    const inboxPath = `/org/${ORG_ID}/notifications`;
    let location = await at(`/org/${ORG_ID}/waiting`);
    expect(location.pathname).toBe(inboxPath);
    expect(location.search).toEqual({ filter: "waiting" });
    expect(screen().getByRole("heading", { level: 1, name: "Caixa de entrada" })).toBeTruthy();
    expect(filterName()).toBe("Esperando você");
    expect(rowIds().sort()).toEqual(["n-ap", "n-q"]);
    cleanup();

    // A request still waiting: its item open among everything, ahead of what would open first.
    location = await at(`/org/${ORG_ID}/approvals?open=ap-deploy`);
    expect(location.pathname).toBe(inboxPath);
    expect(location.search).toEqual({ approval: "ap-deploy" });
    expect(filterName()).toBe("Tudo");
    expect([...document.querySelectorAll<HTMLElement>(".ib-list .is-on")].map((r) => r.dataset.n)).toEqual(["n-ap"]);
    expect(openCard().getAttribute("data-ask-id")).toBe("ap-deploy");
    expect(within(openCard()).getByRole("button", { name: /segure para confirmar/ })).toBeTruthy();
    cleanup();

    // One already decided: among the decided requests, open.
    location = await at(`/org/${ORG_ID}/approvals?open=ap-old`);
    expect(location.pathname).toBe(inboxPath);
    expect(filterName()).toBe("Pedidos decididos");
    expect(requestRow("ap-old").getAttribute("aria-current")).toBe("true");
    expect(openDetail()).toBe("github.run_workflow · rollback.yml");
    expect(openCard().querySelector(".rq__answer-text")?.textContent).toBe("Aprovado por João");
    cleanup();

    // The approvals' page with no request named: what waits.
    location = await at(`/org/${ORG_ID}/approvals`);
    expect(location.pathname).toBe(inboxPath);
    expect(location.search).toEqual({ filter: "waiting" });
    expect(filterName()).toBe("Esperando você");
  });
});
