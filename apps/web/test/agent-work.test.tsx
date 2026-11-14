import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentStatus, AgentWork, Message, ThreadInfo } from "@agenteschat/client";
import { formatTime } from "@agenteschat/client/lib/format";
import { act, cleanup, within } from "@testing-library/react";
import { DESKTOP_QUERY } from "@/components/NavDrawer";
import {
  ADA_ID,
  ATLAS_ID,
  createFakeApi,
  ENG_ID,
  type FakeState,
  GENERAL_ID,
  NOW,
  ORG_ID,
  seedDm,
  seedState,
} from "./fake-api";
import { renderApp, screen, settle } from "./render";

/**
 * An agent's work, workspace-wide (ADR 0084 addendum of 2026-11-13): its face, its line in the sidebar and the members
 * column, the Agentes count and a thread's chip say who works, for whom or where, what waits on you, and how long.
 */

let media: { mockRestore: () => void } | null = null;
afterEach(() => {
  cleanup();
  media?.mockRestore();
  media = null;
  localStorage.clear();
});

const desktop = () => {
  media = spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: q === DESKTOP_QUERY,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
};

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const work = (over: Partial<AgentWork> = {}): AgentWork => ({
  state: "working",
  ask: null,
  since: ago(22),
  runId: "run-1",
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
const status = (agentId: string, over: Partial<AgentStatus>): AgentStatus => ({
  agentId,
  presence: "online",
  status: null,
  activeAt: null,
  ...over,
});

const nav = () => screen().getByRole("navigation", { name: "Navegação do workspace" });
const agentRow = (id: string) => nav().querySelector(`[data-agent-row="${id}"]`) as HTMLElement;

describe("the sidebar's agents", () => {
  test("whom it helps and how long, its orbit, a blue face, and Agentes counts it; amber for what waits on you", async () => {
    const state = seedState();
    state.agentStatuses = [
      status(ATLAS_ID, { presence: "busy", working: true, work: work({ forAgentId: ADA_ID }) }),
      status(ADA_ID, { work: work({ state: "you", ask: "approval", since: ago(3), channelId: ENG_ID }) }),
    ];
    await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const atlas = agentRow(ATLAS_ID);
    expect(atlas.querySelector(".work-line")?.textContent).toBe("ajudando a Ada · 22 min");
    expect(atlas.querySelector(".work-line")?.getAttribute("data-tone")).toBe("working");
    // Its role gives the slot up: the row keeps its height.
    expect(atlas.querySelector(".sidebar__item-role.ac-tag")).toBeNull();
    expect(atlas.querySelector(".sidebar__item-label .ac-pixspin")).toBeTruthy();
    expect(atlas.querySelector(".ac-presence")?.getAttribute("data-presence")).toBe("working");
    // Never red "Ocupado": the badge's words say what it does.
    expect(atlas.querySelector(".ac-avatar__badge")?.getAttribute("title")).toBe("Trabalhando");
    expect(atlas.querySelector(".sidebar__item")?.getAttribute("title")).toContain(
      "Ajudando a Ada · #general · 22 min",
    );
    const ada = agentRow(ADA_ID);
    expect(ada.querySelector(".work-line")?.textContent).toBe("esperando você · 3 min");
    expect(ada.querySelector(".work-line")?.getAttribute("data-tone")).toBe("you");
    expect(ada.querySelector(".ac-presence")?.getAttribute("data-presence")).toBe("waiting");
    const head = within(nav()).getByRole("button", { name: "Agentes" }).closest(".sidebar__section-head");
    expect(head?.querySelector(".sidebar__section-working")?.textContent).toBe("1 trabalhando");
  });

  test("an agent free again reads Disponível, never amber Ausente; its role comes back", async () => {
    const state = seedState();
    state.agentStatuses = [status(ATLAS_ID, { presence: "away", activeAt: ago(120) })];
    await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const atlas = agentRow(ATLAS_ID);
    expect(atlas.querySelector(".ac-presence")?.getAttribute("data-presence")).toBe("online");
    expect(atlas.querySelector(".ac-avatar__badge")?.getAttribute("title")).toBe("Disponível");
    expect(atlas.querySelector(".work-line")).toBeNull();
    expect(atlas.querySelector(".sidebar__item-role.ac-tag")?.textContent).toBe("Ops");
  });
});

describe("a return it set (ADR 0037 addendum)", () => {
  test("free with a return: 'retorno às 00:32' in the quiet tone, its face Disponível, where in its title", async () => {
    const state = seedState();
    const at = new Date(Date.now() + 33 * 60_000).toISOString();
    state.agentStatuses = [
      status(ATLAS_ID, { work: work({ state: "later", at, since: at, count: 0 }) }),
      // Out of office says why first: a return comes after it.
      status(ADA_ID, {
        presence: "out",
        status: {
          by: "wait",
          kind: "out_of_plan",
          text: null,
          subject: null,
          emoji: null,
          until: new Date(Date.now() + 3 * 3600_000).toISOString(),
        },
        work: work({ state: "later", at, since: at, count: 0 }),
      }),
    ];
    await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const atlas = agentRow(ATLAS_ID);
    expect(atlas.querySelector(".work-line")?.textContent).toBe(`retorno às ${formatTime("pt-BR", at)}`);
    expect(atlas.querySelector(".work-line")?.getAttribute("data-tone")).toBe("neutral");
    expect(atlas.querySelector(".ac-presence")?.getAttribute("data-presence")).toBe("online");
    expect(atlas.querySelector(".sidebar__item-label .ac-pixspin")).toBeNull();
    expect(atlas.querySelector(".sidebar__item")?.getAttribute("title")).toContain(
      `Retorno às ${formatTime("pt-BR", at)} · #general`,
    );
    expect(agentRow(ADA_ID).querySelector(".work-line")).toBeNull();
  });
});

describe("the worst case (break-ui, measured by CI's geometry step)", () => {
  test("long names, an unread count beside the line, an hour and a half: one line that gives up its time first", async () => {
    desktop();
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    const atlas = state.agents.find((a) => a.id === ATLAS_ID);
    if (!ada || !atlas) throw new Error("no agents");
    ada.name = "Assistente de Atendimento ao Cliente Internacional";
    atlas.name = "Especialista em Faturamento Recorrente";
    seedDm(state, { type: "agent", id: ATLAS_ID }, { unread: 12 });
    state.agentStatuses = [
      status(ATLAS_ID, { presence: "busy", working: true, work: work({ forAgentId: ADA_ID, since: ago(95) }) }),
      status(ADA_ID, { work: work({ state: "approval", since: ago(61), channelId: ENG_ID }) }),
    ];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const line = agentRow(ATLAS_ID).querySelector(".work-line") as HTMLElement;
    // The happy-dom has no layout: the whole line, which a narrow row trades for its short form.
    expect(line.textContent).toBe("ajudando o Assistente de Atendimento ao Cliente Internacional · 1,6 h");
    expect(agentRow(ATLAS_ID).querySelector(".ac-count, .sidebar__unread, [class*='unread']")).toBeTruthy();
    expect(agentRow(ADA_ID).querySelector(".work-line")?.textContent).toBe("esperando aprovação · 1 h");
  });
});

describe("two blues on small faces", () => {
  test("at work (three dots) beside out of office (the arrow, asleep): each keeps its own mark", async () => {
    const state = seedState();
    state.agentStatuses = [
      status(ATLAS_ID, { presence: "busy", working: true, work: work({ forAgentId: ADA_ID }) }),
      status(ADA_ID, {
        presence: "out",
        status: {
          by: "auto",
          text: null,
          kind: "out_of_plan",
          subject: null,
          emoji: null,
          until: new Date(Date.now() + 3 * 3600_000).toISOString(),
        },
      }),
    ];
    await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(state) });
    await settle(8);
    expect(agentRow(ATLAS_ID).querySelector(".ac-presence")?.getAttribute("data-presence")).toBe("working");
    expect(agentRow(ADA_ID).querySelector(".ac-presence")?.getAttribute("data-presence")).toBe("out");
    // Out of office keeps its own line: why, and when it is back.
    expect(agentRow(ADA_ID).querySelector(".sidebar__item-role")?.textContent).toContain("Sem limite");
  });
});

describe("the members column", () => {
  test("its work here reads 'aqui', with how long, before its role", async () => {
    desktop();
    const state = seedState();
    state.agentStatuses = [
      status(ATLAS_ID, { working: true, work: work({ channelId: ENG_ID, channelName: "eng", since: ago(5) }) }),
    ];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const side = screen().getByRole("complementary", { name: "Membros de #eng" });
    const atlas = [...side.querySelectorAll<HTMLElement>(".members-side__row")].find(
      (r) => r.querySelector(".members-side__label")?.textContent === "Atlas",
    );
    expect(atlas?.querySelector(".work-line")?.textContent).toBe("aqui · 5 min");
    expect(atlas?.querySelector(".members-side__name .ac-pixspin")).toBeTruthy();
  });
});

describe("a thread's chip", () => {
  const replied = (state: FakeState) => {
    const at = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
    state.messages.push({
      id: "t-1",
      channelId: ENG_ID,
      threadId: "m-1",
      author: { type: "agent", id: ADA_ID },
      body: "vou pedir ao Atlas",
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: at(30),
      meta: {},
    } as Message);
    return state;
  };
  const withThread = async (over: Partial<ThreadInfo>) => {
    const state = replied(seedState());
    const api = createFakeApi(state);
    // "Responder" opened it: its replies live in the panel and the channel shows its line.
    await state.openThread?.(ORG_ID, "m-1", new Date(NOW.getTime() - 31 * 60_000).toISOString());
    const patch = (list: ThreadInfo[]) => list.map((t) => (t.id === "m-1" ? { ...t, ...over } : t));
    const inChannel = api.threads.inChannel.bind(api.threads);
    api.threads.inChannel = async (...args: Parameters<typeof inChannel>) => {
      const r = await inChannel(...args);
      return { ...r, threads: patch(r.threads) };
    };
    return api;
  };
  const chip = () => screen().getByRole("main").querySelector(".thread-line") as HTMLElement;

  test("the Threads page says the chip's state: a run in line reads Na fila, never Trabalhando", async () => {
    const state = replied(seedState());
    const api = createFakeApi(state);
    await state.openThread?.(ORG_ID, "m-1", new Date(NOW.getTime() - 31 * 60_000).toISOString());
    // The worst case beside it (break-ui, measured by CI's geometry step): the longest wait word on a thread at work.
    await state.openThread?.(ORG_ID, "m-2", new Date(NOW.getTime() - 30 * 60_000).toISOString());
    const waits = { "m-1": "queued", "m-2": "computer" } as const;
    const list = api.threads.list.bind(api.threads);
    api.threads.list = async (...args: Parameters<typeof list>) => {
      const r = await list(...args);
      return {
        ...r,
        threads: r.threads.map((t) =>
          t.id === "m-1" || t.id === "m-2" ? { ...t, working: true, wait: waits[t.id] } : t,
        ),
      };
    };
    await renderApp(`/org/${ORG_ID}/threads`, { api });
    await settle(8);
    const tags = [...screen().getByRole("main").querySelectorAll(".ac-chip")].map((c) => c.textContent);
    expect(tags).toContain("Na fila");
    expect(tags).toContain("Esperando o computador");
    expect(tags).not.toContain("Trabalhando");
    // Its column holds the longest state whole, never "Esperando o computa…" (es "Esperando su computadora" is 184px).
    const css = await Bun.file(new URL("../src/pages/threads.css", import.meta.url)).text();
    const tag = Number(/\.thread-row__end \{[^}]*grid-template-columns: (\d+)px/.exec(css)?.[1]);
    expect(tag).toBeGreaterThanOrEqual(184);
  });

  test("a return to come: 'Retorno às 00:32' with the quiet clock, its time in its words, no second clock", async () => {
    const at = new Date(Date.now() + 33 * 60_000).toISOString();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: await withThread({ laterAt: at }) });
    await settle(8);
    const state = chip().querySelector(".thread-line__state") as HTMLElement;
    expect(state.textContent).toBe(`Retorno às ${formatTime("pt-BR", at)}`);
    expect(state.classList.contains("thread-line__state--neutral")).toBe(true);
    expect(state.querySelector(".thread-line__clock")).toBeTruthy();
    // No last reply's time beside it; on a phone-wide window, where its words go to screen readers, its time alone.
    expect(chip().querySelector(".thread-line__when:not(.thread-line__later-at)")).toBeNull();
    const narrow = chip().querySelector(".thread-line__later-at");
    expect(narrow?.getAttribute("aria-hidden")).toBe("true");
    expect(narrow?.textContent).toBe(`·${formatTime("pt-BR", at)}`);
    const css = await Bun.file(new URL("../src/components/threads/threads.css", import.meta.url)).text();
    expect(css).toMatch(/@media \(min-width: 421px\) \{\s*\.thread-line__later-at \{\s*display: none;/);
  });

  test("one state, with how long it has held in place of the last reply's time", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, {
      api: await withThread({ working: true, since: ago(22), worker: ATLAS_ID }),
    });
    await settle(8);
    const state = chip().querySelector(".thread-line__state") as HTMLElement;
    expect(state.textContent).toBe("Trabalhando");
    expect(state.classList.contains("thread-line__state--working")).toBe(true);
    expect(state.querySelector(".ac-pixspin")).toBeTruthy();
    expect(chip().querySelector(".thread-line__held")?.textContent).toBe("22 min");
    expect(chip().querySelector("time")).toBeNull();
  });

  test("a hand-off's news reloads it: once approved, the chip says it works again", async () => {
    let over: Partial<ThreadInfo> = { working: false, wait: "approval", since: ago(25) };
    const state = replied(seedState());
    const api = createFakeApi(state);
    await state.openThread?.(ORG_ID, "m-1", new Date(NOW.getTime() - 31 * 60_000).toISOString());
    const inChannel = api.threads.inChannel.bind(api.threads);
    api.threads.inChannel = async (...args: Parameters<typeof inChannel>) => {
      const r = await inChannel(...args);
      return { ...r, threads: r.threads.map((t) => (t.id === "m-1" ? { ...t, ...over } : t)) };
    };
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(8);
    const word = () => chip().querySelector(".thread-line__state")?.textContent;
    expect(word()).toBe("Esperando aprovação");
    // Atlas works on in the agents' DM, where nothing is posted here: the hand-off's own event says it moved.
    over = { working: true, wait: null, since: ago(1), worker: ATLAS_ID };
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: { type: "agent.consultation", channelId: ENG_ID, threadId: "m-1", runId: "r-ada", consultationId: "q1" },
      }),
    );
    await settle(8);
    expect(word()).toBe("Trabalhando");
  });

  test("what its work waits on, quiet with the clock; what waits on you, amber with the still mark", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, {
      api: await withThread({ working: false, wait: "approval", since: ago(3) }),
    });
    await settle(8);
    let state = chip().querySelector(".thread-line__state") as HTMLElement;
    expect(state.textContent).toBe("Esperando aprovação");
    expect(state.classList.contains("thread-line__state--neutral")).toBe(true);
    cleanup();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, {
      api: await withThread({ needsYou: true, working: true, since: ago(3) }),
    });
    await settle(8);
    state = chip().querySelector(".thread-line__state") as HTMLElement;
    expect(state.textContent).toBe("Esperando você");
    expect(state.querySelector(".rq-wait--still")).toBeTruthy();
    expect(chip().querySelector(".thread-line__held")?.textContent).toBe("3 min");
  });
});
