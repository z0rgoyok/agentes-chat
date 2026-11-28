import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { TeamProposalCard } from "@agenteschat/client";
import { madeByImport } from "@agenteschat/client/lib/import/flow";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { arrivalProps, arrivals, droppedCount } from "@/components/lodi-cursor/arrivals";
import { type CursorStep, findRows, inSight, playLodi, RUN } from "@/components/lodi-cursor/runner";
import { createFakeApi, LODI_ID, ORG_ID, seedDm, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** Lodi's cursor: after Criar o time it builds the sidebar from what was made, for the person who clicked. */

afterEach(() => {
  cleanup();
  arrivals.reset();
  document.body.innerHTML = "";
});

const CARD: TeamProposalCard = {
  kind: "team_proposal",
  forUserId: "u-walter",
  params: {
    lead: "2 agentes, cada um no seu canal.",
    agents: [
      {
        name: "Iara",
        handle: "iara",
        role: "Atendimento",
        line: "Responde os clientes.",
        instructions: "Atendimento",
        appearance: null,
        channel: "atendimento",
        routines: [],
        firstTask: "Responder a última mensagem",
      },
      {
        name: "Ada",
        handle: "ada2",
        role: "Dev",
        line: "Corrige os bugs.",
        instructions: "Dev",
        appearance: null,
        channel: "eng",
        routines: [],
        firstTask: "Olhar o último bug",
      },
    ],
    newChannels: ["atendimento"],
    skills: [],
    weekly: null,
    approvals: "",
    invite: [],
  },
  state: "pending",
  decidedByUserId: null,
  decidedAt: null,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** A sidebar row as the cursor reads it, at a place on the screen. */
function row(kind: "channel" | "agent", id: string, name: string, top: number) {
  const el = document.createElement("div");
  el.dataset[kind === "channel" ? "channelRow" : "agentRow"] = id;
  el.innerHTML = `<a class="sidebar__item"><span class="sidebar__item-label">${name}</span></a>`;
  const box = { left: 16, top, width: 200, height: 32, right: 216, bottom: top + 32, x: 16, y: top } as DOMRect;
  el.getBoundingClientRect = () => box;
  (el.querySelector(".sidebar__item-label") as HTMLElement).getBoundingClientRect = () => box;
  return el;
}
function button(top: number) {
  const el = document.createElement("button");
  el.getBoundingClientRect = () => ({ left: 220, top, width: 24, height: 24, right: 244, bottom: top + 24 }) as DOMRect;
  return el;
}

describe("after Criar o time", () => {
  test("Pular sits beside Desfazer while the team lands, the hold banner waits, and Esc lands every row", async () => {
    const state = withRightHand(seedState({ agents: [] }));
    state.members = state.members.slice(0, 1);
    const channelId = seedDm(state, { type: "agent", id: LODI_ID }, { ago: 10, body: "Oi" });
    state.messages.push({
      id: "m-team",
      channelId,
      threadId: null,
      author: { type: "agent", id: LODI_ID },
      mentionedAgentIds: [],
      body: "Proposed a team: Iara, Ada.",
      agentRunId: null,
      meta: { bodyCode: "team_proposal", bodyParams: { names: "Iara, Ada" }, actionCard: structuredClone(CARD) },
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(state) });
    await settle(10);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Criar o time" })));
    await settle(12);
    const made = state.agents.filter((a) => a.name === "Iara" || a.name === "Ada").map((a) => a.id);
    expect(made).toHaveLength(2);
    expect(arrivals.get().busy).toBe(true);
    expect(screen().getByRole("button", { name: "Desfazer" })).toBeTruthy();
    expect(screen().getByRole("button", { name: "Pular" })).toBeTruthy();
    // The new agents' rows are in the sidebar, marked as arriving.
    for (const id of made) expect(document.querySelector(`[data-agent-row="${id}"][data-arriving]`)).toBeTruthy();
    // The layer over the window never takes a click.
    expect(document.querySelector(".lodi-cursor")?.getAttribute("aria-hidden")).toBe("true");
    await sleep(RUN.settleMs + 50);
    await act(async () => fireEvent.keyDown(window, { key: "Escape" }));
    await sleep(50);
    await settle(4);
    expect(arrivals.get().busy).toBe(false);
    expect(document.querySelector("[data-lodi]")).toBeNull();
    expect(screen().queryByRole("button", { name: "Pular" })).toBeNull();
  });
});

// The script's rows stay out of the page: a bare row has none of the sidebar around it, and the layout check would read
// it as a screen.
describe("the script", () => {
  test("it presses each section's +, types each channel, drops each agent in, then goes back", async () => {
    const nav = document.createElement("nav");
    const channel = row("channel", "c1", "vendas", 100);
    const agent = row("agent", "a1", "Iara", 300);
    nav.append(channel, agent);
    const steps: CursorStep[] = [];
    const start = { x: 600, y: 500 };
    const play = playLodi(
      { step: (s) => steps.push(s) },
      start,
      [
        { add: button(60), rows: findRows(nav, "channel", ["c1"]) },
        { add: button(260), rows: findRows(nav, "agent", ["a1"]) },
      ],
      new AbortController().signal,
    );
    // Until the cursor brings them, the rows wait.
    expect(channel.dataset.lodi).toBe("pending");
    expect(agent.dataset.lodi).toBe("pending");
    await play;
    expect(steps.map((s) => [Math.round(s.y), s.presses ?? 0])).toEqual([
      [72, 1],
      [116, 0],
      [272, 1],
      [316, 0],
      [500, 0],
    ]);
    expect(channel.dataset.lodi).toBeUndefined();
    expect(agent.dataset.lodi).toBeUndefined();
    expect(nav.querySelector(".lodi-typing")).toBeNull();
  });

  test("stopped (Pular, Esc), every row lands at once and the cursor stays where it is", async () => {
    const nav = document.createElement("nav");
    nav.append(
      row("channel", "c1", "vendas", 100),
      row("channel", "c2", "suporte", 140),
      row("agent", "a1", "Iara", 300),
    );
    const stop = new AbortController();
    const steps: CursorStep[] = [];
    const play = playLodi(
      { step: (s) => steps.push(s) },
      { x: 600, y: 500 },
      [
        { add: button(60), rows: findRows(nav, "channel", ["c1", "c2"]) },
        { add: button(260), rows: findRows(nav, "agent", ["a1"]) },
      ],
      stop.signal,
    );
    setTimeout(() => stop.abort(), 50);
    await play;
    expect(nav.querySelector("[data-lodi]")).toBeNull();
    expect(nav.querySelector(".lodi-typing")).toBeNull();
    expect(steps).toHaveLength(1);
  });

  test("it aims only at rows in sight: none in the rail, under a dialog or scrolled away", () => {
    const nav = document.createElement("nav");
    const scroll = document.createElement("div");
    scroll.className = "sidebar__scroll";
    scroll.getBoundingClientRect = () =>
      ({ top: 0, bottom: 400, left: 0, right: 240, width: 240, height: 400 }) as DOMRect;
    const near = row("agent", "a1", "Iara", 100);
    const far = row("agent", "a2", "Ada", 600);
    scroll.append(near, far);
    nav.append(scroll);
    expect(inSight(nav, findRows(nav, "agent", ["a1"]))).toBe(true);
    expect(inSight(nav, findRows(nav, "agent", ["a1", "a2"]))).toBe(false);
    const dialog = document.createElement("div");
    dialog.className = "ac-dialog";
    dialog.dataset.state = "open";
    document.body.append(dialog);
    expect(inSight(nav, findRows(nav, "agent", ["a1"]))).toBe(false);
    dialog.remove();
    const rail = document.createElement("aside");
    rail.dataset.rail = "true";
    rail.append(nav);
    expect(inSight(nav, findRows(nav, "agent", ["a1"]))).toBe(false);
  });
});

describe("arrivals", () => {
  test("what the cursor shows opens together; anyone else's rows open one after another", () => {
    arrivals.add({ channelIds: ["c1"], agentIds: ["a1"] });
    const arrived = new Map([
      ["c1", 0],
      ["a1", 1],
      ["x", 2],
    ]);
    const delay = (id: string) =>
      (arrivalProps(arrived, id).style as Record<string, string> | undefined)?.["--arrive-delay"];
    expect(delay("a1")).toBe("0ms");
    expect(delay("x")).toBe("800ms");
    expect(arrivalProps(arrived, "nope")).toEqual({});
  });

  test("Pular after a bunch went into the closed menu counts each row once", () => {
    arrivals.dropIntoDrawer({ channelIds: ["c1", "c2"] });
    arrivals.dropIntoDrawer({ channelIds: ["c1", "c2"], agentIds: ["a1"] });
    expect(droppedCount(arrivals.get().inDrawer)).toBe(3);
  });

  test("a hold banner already up stays while the team lands; one that wasn't waits", () => {
    const banner = document.createElement("div");
    banner.className = "hold-banner";
    document.body.append(banner);
    arrivals.add({ channelIds: [], agentIds: ["a1"] });
    expect(arrivals.get()).toMatchObject({ busy: true, bannerUp: true });
    arrivals.done();
    banner.remove();
    arrivals.add({ channelIds: [], agentIds: ["a2"] });
    expect(arrivals.get()).toMatchObject({ busy: true, bannerUp: false });
  });

  test("an import hands over only what it made, in order", () => {
    expect(
      madeByImport([
        { kind: "channel", action: "create", targetId: "c1" },
        { kind: "channel", action: "update", targetId: "c2" },
        { kind: "agent", action: "create", targetId: "a1" },
        { kind: "agent", action: "skip" },
      ] as unknown as Parameters<typeof madeByImport>[0]),
    ).toEqual({ channelIds: ["c1"], agentIds: ["a1"] });
  });
});
