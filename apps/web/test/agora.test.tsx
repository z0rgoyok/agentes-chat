import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentStatus, AgentWork, ManagedTask, PendingReturn, TaskManagerView } from "@agenteschat/client";
import { formatTime } from "@agenteschat/client/lib/format";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { colorOf } from "@/components/Sky";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, type FakeState, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle, showIn } from "./render";

/**
 * Agora (ADR 0128 addendum of 2026-11-14): a button beside "Ir para…" whose glyph says the workspace's state, and its
 * list: what waits on you, who works and what is on hold, one line a row, the row opening its place.
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
/** A row's ⋯ (a kit menu opens on the pointer's press). */
const openMenu = async (row: HTMLElement) => {
  await act(async () =>
    fireEvent.pointerDown(row.querySelector(".agora-row__more") as HTMLElement, { button: 0, ctrlKey: false }),
  );
  await settle(4);
};

const work = (over: Partial<AgentWork> = {}): AgentWork => ({
  state: "working",
  ask: null,
  since: ago(22),
  runId: "r-1",
  channelId: GENERAL_ID,
  channelKind: "channel",
  channelName: "general",
  threadId: null,
  messageId: null,
  forAgentId: null,
  routine: false,
  count: 1,
  ...over,
});
const status = (agentId: string, over: Partial<AgentStatus> = {}): AgentStatus => ({
  agentId,
  presence: "online",
  status: null,
  activeAt: null,
  ...over,
});

const task = (over: Partial<ManagedTask> & Pick<ManagedTask, "runId" | "agentId">): ManagedTask => ({
  channelId: ENG_ID,
  channelKind: "channel",
  channelName: "eng",
  threadId: null,
  status: "running",
  startedAt: ago(22),
  createdAt: ago(22),
  label: null,
  background: false,
  routine: null,
  plan: null,
  requester: { userId: "u-walter", name: "Walter" },
  brain: "model",
  machine: null,
  now: null,
  steps: 1,
  pendingMessageIds: [],
  canStop: true,
  work: { state: "working", since: ago(22), card: null },
  ...over,
});

const followUp = (over: Partial<PendingReturn> = {}): PendingReturn => ({
  messageId: "m-return",
  agentId: ADA_ID,
  channelId: GENERAL_ID,
  channelKind: "channel",
  channelName: "general",
  threadId: null,
  at: inMin(33),
  about: "rever o deploy de hoje",
  runId: "r-return",
  replyMessageId: "m-reply",
  held: false,
  canCancel: true,
  ...over,
});

/**
 * Atlas works on what Ada handed it in a thread of #general; Ada waits on my approval of a PR in #eng and, in a routine,
 * on her plan; a return of hers comes in 33 minutes.
 */
function busy(): TaskManagerView {
  return {
    tasks: [
      task({
        runId: "r-helping",
        agentId: ATLAS_ID,
        channelId: "dm-agents",
        channelKind: "dm",
        channelName: null,
        betweenAgents: true,
        requester: null,
        delegation: {
          agentId: ADA_ID,
          origin: { kind: "person", userId: "u-walter", name: "Walter" },
          from: {
            channelId: GENERAL_ID,
            channelKind: "channel",
            channelName: "general",
            threadId: "t-link",
            messageId: "m-asked",
            label: "Corrigir o link de cancelar",
          },
        },
      }),
      task({
        runId: "r-pr",
        agentId: ADA_ID,
        status: "waiting_approval",
        label: "Revisar o PR #231",
        startedAt: ago(30),
        work: { state: "you", since: ago(3), card: "m-card" },
      }),
      task({
        runId: "r-backup",
        agentId: ADA_ID,
        status: "waiting_input",
        background: true,
        routine: { id: "rt-backup", name: "Backups" },
        requester: null,
        held: "plan",
        canStop: false,
        startedAt: ago(50),
        wait: {
          code: "usage_pause",
          key: "k",
          plan: "Claude",
          model: null,
          scope: null,
          percent: 95,
          window: "week",
          resetsAt: inMin(300),
          since: ago(40),
          canContinue: true,
        },
        work: null,
      }),
    ],
    ended: [],
    hidden: { total: 1, working: 1, byAgent: { [ATLAS_ID]: 1 } },
    computers: [],
    activity: {},
    followUps: [followUp()],
    canceledFollowUps: [],
  };
}

const nav = () => screen().getByRole("navigation", { name: "Navegação do workspace" });
const agora = () => within(nav()).getByRole("button", { name: "Agora" });
const list = (name = "Agora") => screen().getByRole("dialog", { name });
const rowOf = (words: string, name?: string) =>
  within(list(name))
    .getAllByRole("button")
    .find((b) => b.classList.contains("tm-hit") && b.getAttribute("aria-label") === words)
    ?.closest(".agora-row") as HTMLElement;

async function go(state: FakeState) {
  const r = await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(state) });
  await settle(8);
  return r;
}

describe("the button", () => {
  test("between Ir para… and the collapse: the task manager's icon at rest, its tip says nobody works", async () => {
    await go(seedState());
    const row = nav().querySelector(".sidebar__jump-row") as HTMLElement;
    expect([...row.children].map((c) => c.getAttribute("aria-label") ?? c.className)).toEqual([
      "sidebar__jump",
      "Agora",
      "Minimizar barra lateral",
    ]);
    expect(agora().dataset.mark).toBe("idle");
    expect(agora().getAttribute("title")).toBe("Nenhum agente trabalhando agora");
    // No count on it: the bell and "Esperando você" count.
    expect(agora().querySelector(".ac-count, .ac-badge")).toBeNull();
  });

  test("work running: the orbit in the longest-running agent's tones; amber wins once something waits on you", async () => {
    const state = seedState();
    state.agentStatuses = [
      status(ADA_ID, { working: true, work: work({ since: ago(5) }) }),
      status(ATLAS_ID, { working: true, work: work({ since: ago(30) }) }),
    ];
    await go(state);
    expect(agora().dataset.mark).toBe("working");
    const orbit = agora().querySelector("canvas.ac-pixspin") as HTMLElement;
    expect(orbit.dataset.color).toBe(colorOf(state.agents.find((a) => a.id === ATLAS_ID)));
    expect(agora().getAttribute("title")).toBe("2 agentes trabalhando");
    cleanup();

    state.agentStatuses = [
      status(ADA_ID, { work: work({ state: "you", ask: "approval", since: ago(3) }) }),
      status(ATLAS_ID, { working: true, work: work({ since: ago(30) }) }),
    ];
    await go(state);
    expect(agora().dataset.mark).toBe("you");
    expect(agora().querySelector(".rq-wait:not(.rq-wait--still)")).not.toBeNull();
    expect(agora().getAttribute("title")).toBe("1 agente trabalhando\n1 coisa espera você");
    // Screen readers hear the state off the keys' focus too.
    expect(agora().getAttribute("aria-description")).toBe("1 agente trabalhando. 1 coisa espera você");
  });
});

describe("the list", () => {
  test("what waits on you, who works, what's on hold: one line a row, its words whole in its tip", async () => {
    // Its return's own time, read back: one taken again later can fall in the next minute.
    const view = busy();
    const state = seedState({ taskManager: view });
    await go(state);
    await click(agora());
    const heads = within(list())
      .getAllByRole("heading")
      .map((h) => h.textContent);
    expect(heads).toEqual(["Esperando você1", "Trabalhando1", "Em espera2"]);

    const helping = rowOf("Atlas ajudando a Ada");
    expect(helping.querySelector(".tm-hit small")?.textContent).toBe("#general › Corrigir o link de cancelar");
    expect(helping.querySelector(".agora-row__time")?.textContent).toBe("22 min");
    // Ada's face beside her name, as in Atlas's message header.
    expect(helping.querySelector(".agora-row__phrase .ac-who")).not.toBeNull();

    const yours = rowOf("Ada esperando você");
    expect(yours.dataset.state).toBe("you");
    expect(yours.querySelector(".tm-hit small")?.textContent).toBe("#eng › Revisar o PR #231");
    expect(yours.querySelector(".agora-row__time")?.textContent).toBe("3 min");

    expect(rowOf("Ada esperando o plano").querySelector(".tm-hit small")?.textContent).toBe("Rotina «Backups»");
    const back = rowOf(`Ada retorno às ${formatTime("pt-BR", view.followUps?.[0]?.at ?? "")}`);
    expect(back.querySelector(".tm-hit small")?.textContent).toBe("#general › rever o deploy de hoje");
    // A return says when it comes, not for how long.
    expect(back.querySelector(".agora-row__time")?.textContent).toBe("");

    // Every row one line: what it cuts is whole in its tip, never a native title.
    const hit = helping.querySelector(".tm-hit") as HTMLElement;
    expect(hit.getAttribute("title")).toBeNull();
    expect(hit.getAttribute("aria-description")).toContain("#general › Corrigir o link de cancelar");

    // The work the reader may not see, counted; then the task manager.
    expect(within(list()).getByText("Mais 1 tarefa em conversas que você não vê.")).toBeTruthy();
    expect(within(list()).getByRole("link", { name: "Abrir o gerenciador" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/task-manager`,
    );
  });

  test("a row opens its place: a hand-off at the reply that handed it, a wait on you at its card", async () => {
    const state = seedState({ taskManager: busy() });
    const { router } = await go(state);
    await click(agora());
    await click(rowOf("Atlas ajudando a Ada").querySelector(".tm-hit") as HTMLElement);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/threads/t-link`);
    expect(router.state.location.search).toEqual({ m: "m-asked" });
    expect(screen().queryByRole("dialog", { name: "Agora" })).toBeNull();

    await click(agora());
    await click(rowOf("Ada esperando você").querySelector(".tm-hit") as HTMLElement);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    expect(router.state.location.search).toMatchObject({ m: "m-card" });
  });

  test("⋯: Ver passos, Continuar agora, Cancelar retorno; Parar asks in the row, then reads parando… and does nothing", async () => {
    // Its return's own time, read back: one taken again later can fall in the next minute.
    const view = busy();
    const state = seedState({ taskManager: view });
    const { router } = await go(state);
    await click(agora());

    const menuOf = async (row: HTMLElement) => {
      await openMenu(row);
      return within(screen().getByRole("menu"))
        .getAllByRole("menuitem")
        .map((i) => i.textContent);
    };
    expect(await menuOf(rowOf("Ada esperando o plano"))).toEqual(["Ver passos", "Continuar agora"]);
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Continuar agora" }));
    expect(state.calls.some((c) => c.method === "working.continueTasks")).toBe(true);

    expect(await menuOf(rowOf(`Ada retorno às ${formatTime("pt-BR", view.followUps?.[0]?.at ?? "")}`))).toEqual([
      "Cancelar retorno",
    ]);
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Cancelar retorno" }));
    expect(state.calls.some((c) => c.method === "chat.cancelFollowUp" && c.args[1] === "m-return")).toBe(true);

    expect(await menuOf(rowOf("Atlas ajudando a Ada"))).toEqual(["Ver passos", "Parar"]);
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Parar" }));
    const ask = within(list()).getByRole("alertdialog", { name: "Parar a tarefa de Atlas?" });
    // Work Ada handed it: she is told, and won't ask again on her own.
    expect(ask.textContent).toContain("Se parar, Ada fica sabendo que você parou");
    act(() => {
      fireEvent.click(within(ask).getByRole("button", { name: "Parar" }));
    });
    const stopping = rowOf("Atlas parando…");
    expect(stopping.dataset.held).toBeDefined();
    expect((stopping.querySelector(".tm-hit") as HTMLButtonElement).disabled).toBe(true);
    await settle(6);
    expect(state.calls.some((c) => c.method === "agents.cancelRun" && c.args[1] === "r-helping")).toBe(true);

    await openMenu(rowOf("Ada esperando você"));
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Ver passos" }));
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/task-manager`);
    expect(router.state.location.search).toMatchObject({ task: "r-pr" });
  });

  test("nothing on: it says so, and the task manager is one click away", async () => {
    await go(
      seedState({
        taskManager: {
          tasks: [],
          ended: [],
          hidden: { total: 0, working: 0, byAgent: {} },
          computers: [],
          activity: {},
        },
      }),
    );
    await click(agora());
    expect(within(list()).getByText("Nenhum agente trabalhando agora.")).toBeTruthy();
    expect(within(list()).queryAllByRole("heading")).toEqual([]);
  });

  test("work only where the reader can't list it: never 'nobody works' under an orbiting button", async () => {
    const state = seedState({
      taskManager: {
        tasks: [],
        ended: [],
        hidden: { total: 1, working: 1, byAgent: { [ATLAS_ID]: 1 } },
        computers: [],
        activity: {},
      },
    });
    // At work in a teammate's DM with it: everyone sees the bare state.
    state.agentStatuses = [status(ATLAS_ID, { working: true, work: work({ channelId: null, channelName: null }) })];
    await go(state);
    expect(agora().dataset.mark).toBe("working");
    await click(agora());
    expect(within(list()).queryByText("Nenhum agente trabalhando agora.")).toBeNull();
    expect(within(list()).getByText("Mais 1 tarefa em conversas que você não vê.")).toBeTruthy();
  });

  test("what else waits on you leads to Esperando você, with the sidebar's count", async () => {
    // A request to join and nothing of the agents': the button is amber, and the list says why.
    const state = seedState({
      taskManager: { tasks: [], ended: [], hidden: { total: 0, working: 0, byAgent: {} }, computers: [], activity: {} },
    });
    state.notifications = [notification({ id: "n-join", kind: "join_request", waiting: true })];
    const { router } = await go(state);
    expect(agora().dataset.mark).toBe("you");
    await click(agora());
    expect(within(list()).queryByText("Nenhum agente trabalhando agora.")).toBeNull();
    const line = within(list()).getByRole("link", { name: "1 coisa espera você" });
    expect(line.getAttribute("href")).toBe(`/org/${ORG_ID}/waiting`);
    expect(line.closest(".agora-row")?.querySelector(".rq-wait--still")).not.toBeNull();
    await click(line);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/waiting`);
    expect(screen().queryByRole("dialog", { name: "Agora" })).toBeNull();
    cleanup();

    // Ada's approval waits on me among three things: under her row, the line counts them all, as the sidebar does.
    const more = seedState({ taskManager: busy() });
    more.notifications = ["n-approval", "n-join", "n-proposal"].map((id) =>
      notification({ id, kind: id === "n-join" ? "join_request" : "approval", waiting: true }),
    );
    await go(more);
    await click(agora());
    const you = within(list()).getByRole("region", { name: "Esperando você" });
    expect(
      within(you)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([expect.stringContaining("Ada"), "As 3 coisas que esperam você"]);
    cleanup();

    // Only its own row's card waits: nothing more to lead to.
    const one = seedState({ taskManager: busy() });
    one.notifications = [
      notification({ id: "n-approval", kind: "approval", waiting: true, source: { messageId: "m-card" } }),
    ];
    await go(one);
    await click(agora());
    expect(within(list()).queryByRole("link", { name: /esperam? você/ })).toBeNull();
    cleanup();

    // An admin decides two approvals whose inbox items only the agents' responsável gets, and a request to join waits
    // too: two rows, one inbox item, and the line still leads to it.
    const admin = seedState({
      taskManager: {
        ...busy(),
        tasks: [
          task({
            runId: "r-pr",
            agentId: ADA_ID,
            status: "waiting_approval",
            label: "Revisar o PR #231",
            startedAt: ago(30),
            work: { state: "you", since: ago(3), card: "m-card" },
          }),
          task({
            runId: "r-deploy",
            agentId: ATLAS_ID,
            status: "waiting_approval",
            label: "Publicar a versão nova",
            startedAt: ago(20),
            work: { state: "you", since: ago(2), card: "m-card-2" },
          }),
        ],
        hidden: { total: 0, working: 0, byAgent: {} },
        followUps: [],
      },
    });
    admin.notifications = [notification({ id: "n-join", kind: "join_request", waiting: true })];
    await go(admin);
    await click(agora());
    const mine = within(list()).getByRole("region", { name: "Esperando você" });
    expect(within(mine).getAllByRole("listitem")).toHaveLength(3);
    expect(within(mine).getByRole("link", { name: "1 coisa espera você" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/waiting`,
    );
  });

  test("worst case: long names, long titles, many rows, in English with 12-hour times", async () => {
    const state = seedState({ taskManager: busy() });
    const long = "Bartolomeu Constantino de Albuquerque e Vasconcelos";
    for (const a of state.agents) if (a.id === ATLAS_ID) a.name = long;
    const view = state.taskManager as TaskManagerView;
    for (let i = 0; i < 9; i++)
      view.tasks.push(
        task({
          runId: `r-more-${i}`,
          agentId: i % 2 ? ADA_ID : ATLAS_ID,
          label: "Atualizar as capturas de tela da vitrine e revisar as notas de todas as versões deste trimestre",
          startedAt: ago(90 + i),
          work: { state: i % 3 ? "working" : "queued", since: ago(90 + i), card: null },
        }),
      );
    // Ada helps the one with the long name: what she does keeps its words, cut at its end only past the line.
    view.tasks.push(
      task({
        runId: "r-helps-long",
        agentId: ADA_ID,
        channelId: "dm-agents-2",
        channelKind: "dm",
        channelName: null,
        betweenAgents: true,
        delegation: {
          agentId: ATLAS_ID,
          origin: { kind: "agent" },
          from: {
            channelId: ENG_ID,
            channelKind: "channel",
            channelName: "eng",
            threadId: "t-long",
            messageId: null,
            label: "Revisar a página de preços com o time de vendas",
          },
        },
      }),
    );
    const r = await go(state);
    await click(agora());
    expect(rowOf(`${long} ajudando a Ada`)).toBeTruthy();
    expect(rowOf(`Ada ajudando o ${long}`)).toBeTruthy();
    // A short name stays whole beside a long phrase: the phrase ends in "…" first ("Ada ajudando o Bartolomeu Co…").
    const css = readFileSync(join(import.meta.dir, "../src/components/agora.css"), "utf8");
    expect(css).toContain(".agora-row__who > b:not([data-long]) {\n  flex: none;\n}");
    expect(css).toContain(".agora-row__who:has(> b:not([data-long])) > .agora-row__phrase {\n  flex: 0 1 auto;");
    await showIn(r.services, "en");
    await settle(4);
    expect(within(list("Now")).getAllByRole("heading")[0]?.textContent).toBe("Waiting for you1");
    expect(rowOf(`Ada follow-up at ${formatTime("en", view.followUps?.[0]?.at ?? "")}`, "Now")).toBeTruthy();
  });
});

describe("the rail and the Mac app", () => {
  test("its box is the collapse's: 32 beside ⌘K, the rail's 40px tile, 40 under a finger; the title bar keeps ⌘K centred", () => {
    const css = readFileSync(join(import.meta.dir, "../src/layout.css"), "utf8");
    expect(css).toContain(":is(.sidebar__collapse, .sidebar__agora).ac-btn {");
    expect(css).toContain('.sidebar[data-rail="true"] :is(.sidebar__collapse, .sidebar__agora).ac-btn {');
    expect(css).toContain('.sidebar:not([data-rail="true"]) :is(.sidebar__collapse, .sidebar__agora).ac-btn {');
    const desktop = readFileSync(join(import.meta.dir, "../src/desktop.css"), "utf8");
    expect(desktop).toContain("--titlebar-end: calc(var(--control-h-sm) + 12px);");
    expect(desktop).toContain(".sidebar__org--person .sidebar__agora");
  });

  test("the rail: Agora is a tile under ⌘K, the toggle under it", async () => {
    await go(seedState());
    await click(within(nav()).getByRole("button", { name: "Minimizar barra lateral" }));
    try {
      expect(nav().dataset.rail).toBe("true");
      const row = nav().querySelector(".sidebar__jump-row") as HTMLElement;
      expect([...row.children].map((c) => c.getAttribute("aria-label") ?? c.className)).toEqual([
        "sidebar__jump",
        "Agora",
        "Expandir barra lateral",
      ]);
    } finally {
      await click(within(nav()).getByRole("button", { name: "Expandir barra lateral" }));
    }
  });

  test("in the Mac app, Agora sits at the title bar's end", async () => {
    const w = window as { __agentesDesktop?: unknown; __TAURI_INTERNALS__?: unknown };
    w.__agentesDesktop = { version: "0.6.0" };
    w.__TAURI_INTERNALS__ = { invoke: async (cmd: string) => (cmd === "this_mac" ? { orgs: [] } : {}) };
    try {
      await go(seedState());
      const bar = document.querySelector("header.titlebar") as HTMLElement;
      expect(bar.lastElementChild?.getAttribute("aria-label")).toBe("Agora");
    } finally {
      delete w.__agentesDesktop;
      delete w.__TAURI_INTERNALS__;
    }
  });
});
