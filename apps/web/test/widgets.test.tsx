import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Dashboard, DashboardLayoutInput, Widget, WidgetSpec } from "@agenteschat/client";
import { box, place } from "@agenteschat/ui/testing";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  ADA_ID,
  createFakeApi,
  ENG_ID,
  type FakeState,
  fakeDashboardsOf,
  LODI_ID,
  ORG_ID,
  seedState,
  withRightHand,
} from "./fake-api";
import type { FakeDashboards } from "./fakes/dashboards";
import { notification } from "./fakes/notifications";
import { pick } from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const click = (el: Element) => act(async () => fireEvent.click(el));
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const soon = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
/** A refresh's wait as the server sends it. */
const waitOf = (over: Partial<NonNullable<Widget["wait"]>>): Widget["wait"] => ({
  code: "plan_limit",
  source: "plan",
  resetsAt: null,
  scope: null,
  model: null,
  since: null,
  canContinue: false,
  ...over,
});

const SALES: WidgetSpec = {
  kind: "kpi",
  value: 18420,
  prefix: "R$",
  delta: { text: "+12%", up: true },
  note: "vs. ontem até agora",
};
const ORDERS: WidgetSpec = { kind: "bars", labels: ["Novos", "Enviados", "Atrasados"], values: [14, 31, 2] };
const BUILDS: WidgetSpec = { kind: "line", labels: ["1", "2", "3"], values: [6.1, 4.9, 3.9] };

/** My Home with its two tiles and three widgets of Ada's: sales (S), orders (S), builds (M, failed). */
function setup(state: FakeState = seedState()) {
  const api = createFakeApi(state);
  const fake = fakeDashboardsOf.get(api) as FakeDashboards;
  const home = fake.addBoard({
    kind: "home",
    tiles: [
      { key: "waiting", position: 0, w: 2, h: 1 },
      { key: "working", position: 3, w: 2, h: 1 },
    ],
  });
  const sales = fake.addWidget(home.id, {
    agentId: ADA_ID,
    title: "Vendas hoje",
    spec: SALES,
    schedule: "hour",
    refreshedAt: ago(12),
    nextRunAt: soon(40),
    sources: ["Loja", "Planilha de metas"],
    alert: { enabled: true, condition: "cair 20% abaixo de ontem" },
    layout: { position: 1, w: 1, h: 1 },
  });
  const orders = fake.addWidget(home.id, {
    agentId: ADA_ID,
    title: "Pedidos por status",
    spec: ORDERS,
    schedule: "day",
    refreshedAt: ago(90),
    layout: { position: 2, w: 1, h: 1 },
  });
  const builds = fake.addWidget(home.id, {
    agentId: ADA_ID,
    title: "Tempo de build",
    spec: BUILDS,
    schedule: "week",
    layout: { position: 4, w: 2, h: 1 },
  });
  Object.assign(builds, { status: "failed", failure: { code: "no_update", detail: null } });
  return { api, fake, state, home, sales, orders, builds };
}

const open = async (path: string, s = setup()) => {
  const view = await renderApp(path, { api: s.api });
  await settle(8);
  return { ...s, router: view.router, services: view.services };
};

const mural = () => screen().getByRole("region", { name: "Meu Início" });
const order = () => [...mural().querySelectorAll(".wb-cell")].map((c) => c.getAttribute("data-item"));
const widget = (title: string) => within(mural()).getByRole("article", { name: title });
const cellOf = (id: string) => mural().querySelector(`.wb-cell[data-item="${id}"]`) as HTMLElement;
const calls = (state: FakeState, method: string) => state.calls.filter((c) => c.method === method);
const last = (state: FakeState, method: string) => calls(state, method).at(-1)?.args;
const live = () => mural().querySelector("p.ac-visually-hidden[aria-live]")?.textContent ?? "";
/** The click a drop swallows (only on the board) waits a moment for its click; tests send none. */
const pause = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
const gripIn = (title: string) => within(widget(title)).getByRole("button", { name: "Arraste para mover" });

/** happy-dom lays nothing out: the cells in the board's order, 4 a row, 200×160 with 10px between them. */
function layGrid() {
  order().forEach((id, k) => {
    place(cellOf(id ?? ""), box((k % 4) * 210, 300 + Math.floor(k / 4) * 170, 200, 160));
  });
}
const at = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse" });
/** A mouse press on a cell, a move past the slop (it lifts), then on to the point. */
async function dragTo(cell: HTMLElement, x: number, y: number) {
  await act(async () => {
    fireEvent.pointerDown(cell, at(100, 550));
    fireEvent.pointerMove(document, at(110, 560));
    fireEvent.pointerMove(document, at(x, y));
  });
  await settle(2);
}
const press = async (key: string, el: Element = document.activeElement ?? document.body) => {
  await act(async () => fireEvent.keyDown(el, { key }));
  await settle(3);
};
/** Each widget's saved place and size, by id. */
const savedWidgets = (state: FakeState) =>
  (last(state, "dashboards.saveLayout") as [string, string, { widgets: { id: string; position: number }[] }])[2]
    .widgets;

describe("My Home as a mural (ADR 0135)", () => {
  test("Waiting on you and Working now are fixed tiles among my widgets, in the board's order", async () => {
    const { sales, orders, builds } = await open(`/org/${ORG_ID}/home`);
    expect(order()).toEqual(["waiting", sales.id, orders.id, "working", builds.id]);
    // The tiles keep their own sections' names and bodies.
    expect(within(mural()).getByRole("region", { name: "Esperando você" })).toBeTruthy();
    expect(within(mural()).getByRole("region", { name: "Trabalhando agora" })).toBeTruthy();
    // A widget: its title, its number in the app's bold tabular style, who looks after it, when and how often.
    const card = widget("Vendas hoje");
    expect(card.querySelector(".wk-num")?.textContent).toBe("R$18.420");
    expect(card.querySelector(".wg__foot")?.textContent).toContain("Ada");
    expect(card.querySelector(".wg__foot")?.textContent).toContain("a cada hora");
    // Her face leads the title; the footer only says who and when.
    expect(card.querySelector(".wg__head > .wg__face .ac-avatar")).toBeTruthy();
    expect(card.querySelector(".wg__foot .ac-avatar")).toBeNull();
    expect(card.getAttribute("data-w")).toBe("1");
    // The bars, and the failed one with its reason and Resolve.
    expect(widget("Pedidos por status").querySelectorAll(".wk-bar")).toHaveLength(3);
    const failed = widget("Tempo de build");
    expect(failed.getAttribute("data-state")).toBe("failed");
    expect(failed.textContent).toContain("A última atualização terminou sem dados.");
    // A widget is added from the header's pill (Organize and + Widget, one control): the board has no add tile.
    const pill = within(mural()).getByRole("group", { name: "Meu Início" });
    expect(within(pill).getByRole("button", { name: "Organizar" }).getAttribute("aria-pressed")).toBe("false");
    expect(within(pill).getByRole("button", { name: "Adicionar widget" }).textContent).toBe("Widget");
    expect(within(mural()).getAllByRole("button", { name: "Adicionar widget" })).toHaveLength(1);
    expect(mural().querySelector(".wgrid")?.querySelector("button[aria-label='Adicionar widget']")).toBeNull();
  });

  test("Resolve runs a failed widget again; Update now runs any", async () => {
    const { state, builds, sales } = await open(`/org/${ORG_ID}/home`);
    await click(within(widget("Tempo de build")).getByRole("button", { name: "Resolver" }));
    await settle(3);
    expect(last(state, "dashboards.refreshWidget")).toEqual([ORG_ID, builds.id]);
    expect(widget("Tempo de build").getAttribute("data-state")).toBe("updating");
    await click(within(widget("Vendas hoje")).getByRole("button", { name: "Atualizar agora" }));
    await settle(3);
    expect(last(state, "dashboards.refreshWidget")).toEqual([ORG_ID, sales.id]);
    expect(widget("Vendas hoje").getAttribute("data-state")).toBe("updating");
    // The last data stays under the sweep while it updates.
    expect(widget("Vendas hoje").querySelector(".wk-num")?.textContent).toBe("R$18.420");
  });

  test("a widget stopped after failing in a row says so, then the last failure and that failure's one way out", async () => {
    const stoppedBy = (cause: string, ai: "ready" | "no_ai" = "no_ai") => {
      const s = setup();
      Object.assign(s.builds, { status: "failed", failure: { code: "failing", detail: null, cause } });
      s.state.aiStatus = {
        any: ai === "ready",
        agents: s.state.agents.map((a) =>
          ai === "ready" ? { agentId: a.id, state: ai } : { agentId: a.id, state: ai, reason: "no_key" as const },
        ),
      };
      return s;
    };
    // No AI: Conectar, never Resolver (an update would only fail again).
    const noAi = await open(`/org/${ORG_ID}/home`, stoppedBy("missing_credential"));
    const card = widget("Tempo de build");
    expect(card.textContent).toContain(
      "Parou depois de 5 falhas seguidas. A última: Ada está sem chave ou plano de IA para trabalhar.",
    );
    expect(within(card).queryByRole("button", { name: "Resolver" })).toBeNull();
    expect(calls(noAi.state, "dashboards.refreshWidget")).toEqual([]);
    await click(within(card).getByRole("button", { name: "Conectar" }));
    expect(screen().getByRole("dialog", { name: /Conectar uma IA/ })).toBeTruthy();
    cleanup();

    // An AI is there again: nothing starts it by itself (it stopped), and Resolver does, never Conectar.
    const back = await open(`/org/${ORG_ID}/home`, stoppedBy("missing_credential", "ready"));
    await settle(3);
    const ready = widget("Tempo de build");
    expect(ready.textContent).toContain("Parou depois de 5 falhas seguidas. A última: Ada está sem chave");
    expect(calls(back.state, "dashboards.refreshWidget")).toEqual([]);
    expect(within(ready).queryByRole("button", { name: "Conectar" })).toBeNull();
    await click(within(ready).getByRole("button", { name: "Resolver" }));
    await settle(3);
    expect(last(back.state, "dashboards.refreshWidget")).toEqual([ORG_ID, back.builds.id]);
    cleanup();

    // Any other: trying again.
    const slow = await open(`/org/${ORG_ID}/home`, stoppedBy("timeout"));
    const again = widget("Tempo de build");
    expect(again.textContent).toContain("Parou depois de 5 falhas seguidas. A última: A atualização demorou demais.");
    expect(within(again).queryByRole("button", { name: "Conectar" })).toBeNull();
    await click(within(again).getByRole("button", { name: "Resolver" }));
    await settle(3);
    expect(last(slow.state, "dashboards.refreshWidget")).toEqual([ORG_ID, slow.builds.id]);
  });

  test("a widget whose agent has no AI says why with Conectar (or who can), and builds with no click once it has one", async () => {
    const waitingFor = (ai: "ready" | "no_ai", detail: string | null = null) => {
      const s = setup();
      const visits = s.fake.addWidget(s.home.id, {
        agentId: ADA_ID,
        title: "Visitas",
        spec: null,
        schedule: "manual",
        layout: { position: 5, w: 1, h: 1 },
      });
      Object.assign(visits, { status: "failed", failure: { code: "missing_credential", detail } });
      s.state.aiStatus = {
        any: ai === "ready",
        agents: s.state.agents.map((a) => ({
          agentId: a.id,
          state: ai,
          ...(ai === "no_ai" ? { reason: "no_key" as const } : {}),
        })),
      };
      return { s, visits };
    };
    const none = waitingFor("no_ai");
    const { state } = await open(`/org/${ORG_ID}/home`, none.s);
    const card = widget("Visitas");
    expect(card.textContent).toContain("Ada está sem chave ou plano de IA para trabalhar.");
    expect(card.textContent).toContain("Ada monta o widget assim que uma IA for conectada.");
    expect(within(card).queryByRole("button", { name: "Resolver" })).toBeNull();
    // Nothing is asked of the server while there's no AI: a build would only fail.
    expect(calls(state, "dashboards.refreshWidget")).toEqual([]);
    await click(within(card).getByRole("button", { name: "Conectar" }));
    expect(screen().getByRole("dialog", { name: /Conectar uma IA/ })).toBeTruthy();
    cleanup();

    // Someone who may not connect Ada's AI reads the real cause and who can, in place of a Conectar.
    const member = waitingFor("no_ai", "not_signed_in");
    const mine = member.s.state.me?.organizations[0];
    if (mine) mine.role = "member";
    await open(`/org/${ORG_ID}/home`, member.s);
    const locked = widget("Visitas");
    expect(locked.textContent).toContain("O plano de Ada foi desconectado.");
    expect(locked.textContent).toContain(
      "Quem conecta a IA de Ada: um admin, com uma chave de API, ou João, com o próprio plano.",
    );
    expect(within(locked).queryByRole("button", { name: "Conectar" })).toBeNull();
    cleanup();

    // The build nobody pressed for (`auto`): the server only queues it.
    const back = waitingFor("ready");
    const again = await open(`/org/${ORG_ID}/home`, back.s);
    expect(last(again.state, "dashboards.refreshWidget")).toEqual([ORG_ID, back.visits.id, true]);
    expect(calls(again.state, "dashboards.refreshWidget")).toHaveLength(1);
    expect(widget("Visitas").getAttribute("data-state")).toBe("building");
  });

  test("a widget that starts waiting while the AI status read before still says ready builds only on a newer one", async () => {
    const s = setup();
    const visits = s.fake.addWidget(s.home.id, {
      agentId: ADA_ID,
      title: "Visitas",
      spec: SALES,
      schedule: "hour",
      layout: { position: 5, w: 1, h: 1 },
    });
    const status = (ai: "ready" | "no_ai") => ({
      any: ai === "ready",
      agents: s.state.agents.map((a) => ({
        agentId: a.id,
        state: ai,
        ...(ai === "no_ai" ? { reason: "not_signed_in" as const } : {}),
      })),
    });
    s.state.aiStatus = status("ready");
    const { state, services } = await open(`/org/${ORG_ID}/home`, s);
    // Read a minute ago, while Ada's plan was still signed in.
    const aiKey = ["org", ORG_ID, "credentials", "ai-status"];
    services.queryClient.setQueryData(aiKey, status("ready"), { updatedAt: Date.now() - 60_000 });
    // Her plan signs out, and the next slot holds the widget.
    state.aiStatus = status("no_ai");
    Object.assign(visits, { status: "failed", failure: { code: "missing_credential", detail: "not_signed_in" } });
    await act(() => services.queryClient.invalidateQueries({ queryKey: ["org", ORG_ID, "dashboards"] }));
    await settle(8);
    expect(widget("Visitas").textContent).toContain("O plano de Ada foi desconectado.");
    expect(calls(state, "dashboards.refreshWidget")).toEqual([]);
    // Signed in again: the status read after that builds it, once.
    state.aiStatus = status("ready");
    await act(() => services.queryClient.invalidateQueries({ queryKey: aiKey }));
    await settle(8);
    expect(calls(state, "dashboards.refreshWidget").map((c) => c.args)).toEqual([[ORG_ID, visits.id, true]]);
  });

  test("the right hand's widget on a plan that serves only its owner: Conectar opens on a key, a member reads who can", async () => {
    const onPlan = () => {
      const s = setup(withRightHand(seedState(), { ownerUserId: "u-joao" }));
      const recap = s.fake.addWidget(s.home.id, {
        agentId: LODI_ID,
        title: "Resumo",
        spec: null,
        schedule: "manual",
        layout: { position: 5, w: 1, h: 1 },
      });
      Object.assign(recap, { status: "failed", failure: { code: "missing_credential", detail: "plan_not_shared" } });
      // Ready in a chat with it, never for a build: nobody is behind one.
      s.state.aiStatus = {
        any: true,
        agents: s.state.agents.map((a) => ({
          agentId: a.id,
          state: "ready" as const,
          ...(a.id === LODI_ID ? { background: "no_ai" as const } : {}),
        })),
      };
      return s;
    };
    const { state } = await open(`/org/${ORG_ID}/home`, onPlan());
    const card = widget("Resumo");
    expect(card.textContent).toContain("O plano de Lodi só atende o próprio dono, então não atualiza widgets.");
    expect(calls(state, "dashboards.refreshWidget")).toEqual([]);
    await click(within(card).getByRole("button", { name: "Conectar" }));
    expect(within(screen().getByRole("dialog", { name: /Conectar uma IA/ })).getByLabelText("Cole aqui")).toBeTruthy();
    cleanup();

    // A member's own plan answers only their chats with it, so no Conectar: who can, in its place.
    const member = onPlan();
    const mine = member.state.me?.organizations[0];
    if (mine) mine.role = "member";
    await open(`/org/${ORG_ID}/home`, member);
    const locked = widget("Resumo");
    expect(within(locked).queryByRole("button", { name: "Conectar" })).toBeNull();
    expect(locked.textContent).toContain(
      "Quem conecta a IA de Lodi: um admin, com uma chave de API, ou João, com o próprio plano.",
    );
  });

  test("a refresh that waits says what for and stands still; Update now on it says why it can't go sooner", async () => {
    const s = setup();
    Object.assign(s.sales, { status: "updating", wait: waitOf({ resetsAt: soon(90) }) });
    const { state } = await open(`/org/${ORG_ID}/home`, s);
    const card = widget("Vendas hoje");
    expect(card.getAttribute("data-state")).toBe("ok");
    expect(card.getAttribute("aria-busy")).toBeNull();
    expect(card.querySelector(".wg__wait")?.textContent).toContain("Esperando o plano de Ada renovar");
    // Its data as it was, and no Continue now: only time ends a limit.
    expect(card.querySelector(".wk-num")?.textContent).toBe("R$18.420");
    expect(within(card).queryByRole("button", { name: "Continuar agora" })).toBeNull();
    const update = within(card).getByRole("button", { name: "Atualizar agora" });
    expect(update.hasAttribute("disabled")).toBe(false);
    await click(update);
    await settle(3);
    expect(last(state, "dashboards.refreshWidget")).toEqual([ORG_ID, s.sales.id]);
    const toasts = [...document.querySelectorAll(".ac-toast")].map((t) => t.textContent ?? "");
    expect(toasts.some((t) => t.includes("Esperando o plano de Ada renovar"))).toBe(true);
  });

  test("a refresh paused near its plan's limit: Continue now lets it go on", async () => {
    const s = setup();
    const wait = waitOf({ code: "usage_pause", resetsAt: soon(90), canContinue: true });
    Object.assign(s.sales, { status: "updating", wait });
    const { state } = await open(`/org/${ORG_ID}/home`, s);
    await click(within(widget("Vendas hoje")).getByRole("button", { name: "Continuar agora" }));
    await settle(3);
    expect(last(state, "dashboards.refreshWidget")).toEqual([ORG_ID, s.sales.id]);
    expect(widget("Vendas hoje").getAttribute("data-state")).toBe("updating");
    expect(widget("Vendas hoje").querySelector(".wg__wait")).toBeNull();
  });

  test("Continue now is greyed for an editor who may not continue it, and says who may", async () => {
    const s = setup();
    Object.assign(s.sales, { status: "updating", wait: waitOf({ code: "usage_pause", resetsAt: soon(90) }) });
    const { state } = await open(`/org/${ORG_ID}/home`, s);
    const go = within(widget("Vendas hoje")).getByRole("button", { name: "Continuar agora" });
    expect(go.hasAttribute("disabled")).toBe(true);
    expect(go.getAttribute("title")).toBe("Só quem pediu, o dono do agente ou um admin pode continuar agora");
    await click(go);
    await settle(3);
    expect(last(state, "dashboards.refreshWidget")).toBeUndefined();
  });

  test("a limit of its model alone says what it needs, never the plan's reset, with Change model for an admin", async () => {
    const s = setup();
    const wait = waitOf({ scope: "region", model: "DeepSeek V4 Pro", resetsAt: soon(90) });
    Object.assign(s.sales, { status: "updating", wait });
    await open(`/org/${ORG_ID}/home`, s);
    const line = widget("Vendas hoje").querySelector(".wg__wait");
    expect(line?.textContent).toContain("O DeepSeek V4 Pro precisa da região Global ligada no OpenCode");
    expect(line?.textContent).not.toContain("renovar");
    const change = within(widget("Vendas hoje")).getByRole("link", { name: "Trocar modelo" });
    expect(change.getAttribute("href")).toContain(`/agents/${ADA_ID}`);
    expect(change.getAttribute("href")).toContain("sec=brain");
  });

  test("in line for its computer: at work at first, then, ten minutes in, it says it waits for room", async () => {
    const s = setup();
    Object.assign(s.sales, { status: "updating", wait: waitOf({ code: "busy", source: null, since: ago(2) }) });
    await open(`/org/${ORG_ID}/home`, s);
    expect(widget("Vendas hoje").getAttribute("data-state")).toBe("updating");
    expect(widget("Vendas hoje").querySelector(".wg__wait")).toBeNull();
    cleanup();
    Object.assign(s.sales, { wait: waitOf({ code: "busy", source: null, since: ago(11) }) });
    await open(`/org/${ORG_ID}/home`, s);
    expect(widget("Vendas hoje").getAttribute("data-state")).toBe("ok");
    expect(widget("Vendas hoje").querySelector(".wg__wait")?.textContent).toContain(
      "Esperando vaga no computador de Ada",
    );
  });

  test("Organize: size, grip arrows and drag, each saved at once; Remove takes it off", async () => {
    const { state, home, sales, orders, builds } = await open(`/org/${ORG_ID}/home`);
    await click(within(mural()).getByRole("button", { name: "Organizar" }));
    // The fixed tiles say so; widgets show their size, remove and grip instead of their actions.
    expect(within(mural()).getAllByText("Fixo")).toHaveLength(2);
    expect(within(widget("Vendas hoje")).queryByRole("button", { name: "Atualizar agora" })).toBeNull();

    // S → M.
    await click(within(widget("Vendas hoje")).getByRole("button", { name: "Tamanho: P" }));
    await settle(3);
    const sized = last(state, "dashboards.saveLayout") as [string, string, DashboardLayoutInput];
    expect(sized[1]).toBe(home.id);
    expect(sized[2].widgets.find((w) => w.id === sales.id)).toEqual({ id: sales.id, position: 1, w: 2, h: 1 });
    expect(within(widget("Vendas hoje")).getByRole("button", { name: "Tamanho: M" })).toBeTruthy();

    // The grip's left arrow: before "Waiting on you".
    const grip = within(widget("Vendas hoje")).getByRole("button", { name: "Arraste para mover" });
    await act(async () => fireEvent.keyDown(grip, { key: "ArrowLeft" }));
    await settle(3);
    expect(order()).toEqual([sales.id, "waiting", orders.id, "working", builds.id]);
    const moved = last(state, "dashboards.saveLayout") as [string, string, { tiles?: unknown[] }];
    expect(moved[2].tiles).toEqual([
      { key: "waiting", position: 1, w: 2, h: 1 },
      { key: "working", position: 3, w: 2, h: 1 },
    ]);

    // Dragged with the pointer onto another: a copy lifts, a well with its span (M: 2 wide) marks where it lands,
    // and on the drop it takes that place, saved once.
    layGrid();
    const before = calls(state, "dashboards.saveLayout").length;
    await dragTo(cellOf(builds.id), 520, 380);
    expect(document.querySelector(".wb-ghost")).toBeTruthy();
    expect(cellOf(builds.id).hidden).toBe(true);
    const spot = mural().querySelector("[data-spot]") as HTMLElement;
    expect(spot.getAttribute("data-w")).toBe("2");
    expect([...mural().querySelectorAll(".wgrid > *")].map((c) => c.getAttribute("data-item") ?? "spot")).toEqual([
      sales.id,
      "waiting",
      "spot",
      orders.id,
      "working",
      builds.id,
    ]);
    expect(calls(state, "dashboards.saveLayout")).toHaveLength(before);
    await act(async () => fireEvent.pointerUp(document, at(520, 380)));
    await settle(6);
    expect(document.querySelector(".wb-ghost")).toBeNull();
    expect(mural().querySelector("[data-spot]")).toBeNull();
    expect(order()).toEqual([sales.id, "waiting", builds.id, orders.id, "working"]);
    expect(calls(state, "dashboards.saveLayout")).toHaveLength(before + 1);
    expect(savedWidgets(state).find((w) => w.id === builds.id)?.position).toBe(2);
    await pause(80);

    // Remove asks first (its agent's routine stops, its history goes), then it leaves, and its routine with it.
    await click(within(widget("Pedidos por status")).getByRole("button", { name: "Tirar do Início" }));
    await settle(3);
    const confirm = screen().getByRole("dialog", { name: "Tirar “Pedidos por status”?" });
    expect(confirm.textContent).toContain("A rotina de Ada que o atualiza para");
    expect(calls(state, "dashboards.removeWidget")).toHaveLength(0);
    await click(within(confirm).getByRole("button", { name: "Tirar" }));
    await settle(4);
    expect(last(state, "dashboards.removeWidget")).toEqual([ORG_ID, orders.id]);
    expect(screen().queryByRole("dialog", { name: "Tirar “Pedidos por status”?" })).toBeNull();
    expect(within(mural()).queryByRole("article", { name: "Pedidos por status" })).toBeNull();
    expect(document.body.textContent).toContain("“Pedidos por status” saiu do Início e a rotina de Ada parou");

    await click(within(mural()).getByRole("button", { name: "Pronto" }));
    expect(within(mural()).getByRole("button", { name: "Organizar" })).toBeTruthy();
  });

  test("Remove from a card's menu asks first; Cancel keeps the widget", async () => {
    const { state } = await open(`/org/${ORG_ID}/home`);
    await act(async () =>
      fireEvent.pointerDown(within(widget("Tempo de build")).getByRole("button", { name: "Mais" }), {
        button: 0,
        ctrlKey: false,
      }),
    );
    await settle(2);
    const menu = screen().getByRole("menu", { name: "Mais" });
    await click(within(menu).getByRole("menuitem", { name: "Tirar do Início" }));
    await settle(3);
    const confirm = screen().getByRole("dialog", { name: "Tirar “Tempo de build”?" });
    expect(confirm.textContent).toContain("A rotina de Ada que o atualiza para");
    await click(within(confirm).getByRole("button", { name: "Cancelar" }));
    await settle(3);
    expect(screen().queryByRole("dialog", { name: "Tirar “Tempo de build”?" })).toBeNull();
    expect(calls(state, "dashboards.removeWidget")).toHaveLength(0);
    expect(widget("Tempo de build")).toBeTruthy();
  });

  test("Organize with the keys: Space picks a widget up, the arrows carry it, Enter drops it and saves", async () => {
    const { state, sales, orders, builds } = await open(`/org/${ORG_ID}/home`);
    await click(within(mural()).getByRole("button", { name: "Organizar" }));
    const grip = gripIn("Pedidos por status");
    grip.focus();
    await press(" ", grip);
    expect(cellOf(orders.id).classList.contains("is-picked")).toBe(true);
    expect(live()).toBe("Você pegou “Pedidos por status”. As setas movem, Espaço solta, Esc cancela.");
    const before = calls(state, "dashboards.saveLayout").length;
    await press("ArrowLeft");
    // Carried, not saved yet: before the sales widget, second of five.
    expect(order()).toEqual(["waiting", orders.id, sales.id, "working", builds.id]);
    expect(live()).toBe("“Pedidos por status”: posição 2 de 5.");
    expect(document.activeElement).toBe(gripIn("Pedidos por status"));
    expect(calls(state, "dashboards.saveLayout")).toHaveLength(before);
    await press("Enter");
    expect(live()).toBe("Você soltou “Pedidos por status” na posição 2 de 5.");
    expect(cellOf(orders.id).classList.contains("is-picked")).toBe(false);
    expect(calls(state, "dashboards.saveLayout")).toHaveLength(before + 1);
    expect(savedWidgets(state).find((w) => w.id === orders.id)?.position).toBe(1);
    expect(order()).toEqual(["waiting", orders.id, sales.id, "working", builds.id]);

    // Esc puts it back and saves nothing.
    const sold = gripIn("Vendas hoje");
    sold.focus();
    await press("Enter", sold);
    await press("ArrowRight");
    expect(order()).toEqual(["waiting", orders.id, "working", sales.id, builds.id]);
    await press("Escape");
    expect(live()).toBe("“Vendas hoje” voltou para o lugar.");
    expect(order()).toEqual(["waiting", orders.id, sales.id, "working", builds.id]);
    expect(document.activeElement).toBe(gripIn("Vendas hoje"));
    expect(calls(state, "dashboards.saveLayout")).toHaveLength(before + 1);
  });

  test("Organize: Esc while dragging sends the widget back and saves nothing", async () => {
    const { state, sales, orders, builds } = await open(`/org/${ORG_ID}/home`);
    await click(within(mural()).getByRole("button", { name: "Organizar" }));
    layGrid();
    await dragTo(cellOf(builds.id), 110, 380);
    expect(mural().querySelector("[data-spot]")).toBeTruthy();
    await press("Escape", document.body);
    await settle(4);
    expect(document.querySelector(".wb-ghost")).toBeNull();
    expect(mural().querySelector("[data-spot]")).toBeNull();
    expect(order()).toEqual(["waiting", sales.id, orders.id, "working", builds.id]);
    // The release after Esc drops nothing.
    await act(async () => fireEvent.pointerUp(document, at(110, 380)));
    await settle(4);
    expect(calls(state, "dashboards.saveLayout")).toHaveLength(0);
    // Outside Organize nothing lifts.
    await click(within(mural()).getByRole("button", { name: "Pronto" }));
    await dragTo(cellOf(builds.id), 110, 380);
    expect(document.querySelector(".wb-ghost")).toBeNull();
    await act(async () => fireEvent.pointerUp(document, at(110, 380)));
  });
});

describe("a widget's side panel", () => {
  test("big, how it updates, its history; the schedule changes there, a change goes to its agent", async () => {
    const s = setup();
    s.fake.history.set(s.sales.id, [
      {
        id: "u2",
        at: ago(12),
        status: "ok",
        summary: "R$ 18.420 · +12%",
        alert: "pico de pedidos no app",
        failureCode: null,
        change: null,
        costUsd: 0.01,
      },
      {
        id: "u1",
        at: ago(72),
        status: "failed",
        summary: "",
        alert: null,
        failureCode: "no_update",
        change: null,
        costUsd: null,
      },
      {
        id: "u0",
        at: ago(132),
        status: "failed",
        summary: "A fonte **não** respondeu",
        alert: null,
        failureCode: "agent_reported",
        change: null,
        costUsd: null,
      },
    ]);
    const { state, router, sales } = await open(`/org/${ORG_ID}/home`, s);
    await click(within(widget("Vendas hoje")).getByRole("button", { name: "Vendas hoje" }));
    await settle(4);
    expect((router.state.location.search as { widget?: string }).widget).toBe(sales.id);
    const panel = screen().getByRole("dialog", { name: "Vendas hoje" });
    expect(panel.textContent).toContain("Ada cuida deste widget");
    expect(panel.textContent).toContain("A fonte não respondeu");
    expect(within(panel).getByRole("article", { name: "Vendas hoje" }).querySelector(".wk-num")?.textContent).toBe(
      "R$18.420",
    );
    const how = within(panel).getByRole("region", { name: "Como atualiza" });
    expect(how.textContent).toContain("A cada hora");
    expect(how.textContent).toContain("Rotina de Ada · próxima");
    expect(how.textContent).toContain("Avisar se cair 20% abaixo de ontem");
    expect(how.textContent).toContain("Loja · Planilha de metas");
    const history = within(within(panel).getByRole("region", { name: "Últimas atualizações" })).getAllByRole(
      "listitem",
    );
    expect(history[0]?.textContent).toContain("R$ 18.420 · +12%");
    expect(history[0]?.textContent).toContain("avisou: pico de pedidos no app");
    expect(history[1]?.textContent).toContain("A última atualização terminou sem dados.");

    await pick(within(how).getByRole("combobox", { name: "Mudar quando atualiza" }), "Todo dia · 8h");
    expect(last(state, "dashboards.updateWidget")).toEqual([ORG_ID, sales.id, { schedule: "day" }]);

    const ask = within(panel).getByRole("textbox", { name: "Pedir mudança" });
    await act(async () => fireEvent.change(ask, { target: { value: "Separa por canal" } }));
    await act(async () => fireEvent.keyDown(ask, { key: "Enter" }));
    await settle(3);
    expect(last(state, "dashboards.askWidgetChange")).toEqual([ORG_ID, sales.id, "Separa por canal"]);
    expect(document.body.textContent).toContain("Ada está refazendo o widget.");

    // Closed: the address forgets it.
    await click(within(panel).getByRole("button", { name: "Fechar" }));
    await settle(2);
    expect((router.state.location.search as { widget?: string }).widget).toBeUndefined();
  });

  test("its title is renamed in place: Enter saves, Esc cancels and keeps the panel open", async () => {
    const s = setup();
    const { state } = await open(`/org/${ORG_ID}/home?widget=${s.sales.id}`, s);
    const panel = screen().getByRole("dialog", { name: "Vendas hoje" });
    await click(within(panel).getByRole("button", { name: "Renomear" }));
    const field = within(panel).getByRole("textbox", { name: "Título do widget" }) as HTMLInputElement;
    expect(field.value).toBe("Vendas hoje");
    await act(async () => fireEvent.change(field, { target: { value: "Vendas do dia" } }));
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    await settle(4);
    expect(last(state, "dashboards.updateWidget")).toEqual([ORG_ID, s.sales.id, { title: "Vendas do dia" }]);
    expect(within(panel).queryByRole("textbox", { name: "Título do widget" })).toBeNull();
    expect(screen().getByRole("dialog", { name: "Vendas do dia" })).toBeTruthy();

    // A press on the title opens the field too; Esc leaves it as it was.
    await click(panel.querySelector(".wd__title") as HTMLElement);
    const again = within(panel).getByRole("textbox", { name: "Título do widget" });
    await act(async () => fireEvent.change(again, { target: { value: "Outra coisa" } }));
    await act(async () => fireEvent.keyDown(again, { key: "Escape" }));
    await settle(4);
    expect(calls(state, "dashboards.updateWidget")).toHaveLength(1);
    expect(screen().getByRole("dialog", { name: "Vendas do dia" })).toBeTruthy();
  });

  test("a widget its agent hasn't named yet shows its format's name, never the ask", async () => {
    const s = setup();
    s.fake.addWidget(s.home.id, {
      agentId: ADA_ID,
      title: "ultimas visitas no site",
      prompt: "ultimas visitas no site",
      format: "line",
      layout: { position: 5, w: 2, h: 1 },
    });
    await open(`/org/${ORG_ID}/home`, s);
    expect(within(mural()).queryByRole("article", { name: "ultimas visitas no site" })).toBeNull();
    expect(within(mural()).getByRole("article", { name: "Linha" }).getAttribute("data-state")).toBe("building");
  });

  test("opened by its address; Remove takes it off My Home and closes", async () => {
    const s = setup();
    const { state } = await open(`/org/${ORG_ID}/home?widget=${s.orders.id}`, s);
    const panel = screen().getByRole("dialog", { name: "Pedidos por status" });
    await click(within(panel).getByRole("button", { name: "Tirar do Início" }));
    await settle(3);
    expect(calls(state, "dashboards.removeWidget")).toHaveLength(0);
    const confirm = screen().getByRole("dialog", { name: "Tirar “Pedidos por status”?" });
    await click(within(confirm).getByRole("button", { name: "Tirar" }));
    await settle(4);
    expect(last(state, "dashboards.removeWidget")).toEqual([ORG_ID, s.orders.id]);
    expect(screen().queryByRole("dialog", { name: "Tirar “Pedidos por status”?" })).toBeNull();
    expect(screen().queryByRole("dialog", { name: "Pedidos por status" })).toBeNull();
  });
});

describe("a board's notices in Waiting on you", () => {
  /** Ada built "Black Friday" for me and asks to publish it; the sales widget alerted; the build one stopped. */
  function noticed() {
    const s = setup();
    const board: Dashboard = s.fake.addBoard({
      title: "Black Friday",
      ownerUserId: "u-walter",
      proposal: {
        audience: "workspace",
        roleIds: [],
        agentId: ADA_ID,
        why: "O time comercial acompanha isso",
        at: ago(20),
        canDecide: true,
      },
    });
    s.state.notifications = [
      notification({
        id: "n-proposal",
        kind: "dashboard_proposal",
        waiting: true,
        actors: [{ type: "agent", id: ADA_ID }],
        source: { dashboardId: board.id, agentId: ADA_ID, label: "Black Friday" },
        latest: { statusTo: "workspace", text: "O time comercial acompanha isso" },
        updatedAt: ago(20),
      }),
      notification({
        id: "n-alert",
        kind: "widget_alert",
        waiting: true,
        actors: [{ type: "agent", id: ADA_ID }],
        source: { dashboardId: s.home.id, widgetId: s.sales.id, agentId: ADA_ID, label: "Vendas hoje" },
        latest: { text: "As vendas caíram 24% abaixo de ontem." },
        updatedAt: ago(5),
      }),
      notification({
        id: "n-failed",
        kind: "widget_failed",
        actors: [{ type: "agent", id: ADA_ID }],
        source: { dashboardId: s.home.id, widgetId: s.builds.id, agentId: ADA_ID, label: "Tempo de build" },
        latest: { reason: "no_update" },
        updatedAt: ago(30),
      }),
    ];
    return { ...s, board };
  }

  test("each with what can be done right there: Publish or Keep only for me, Open widget, Resolve", async () => {
    const s = noticed();
    const { state, router } = await open(`/org/${ORG_ID}/home`, s);
    const waiting = within(mural()).getByRole("region", { name: "Esperando você" });
    const rows = within(waiting).getAllByRole("listitem");
    const text = rows.map((r) => r.textContent ?? "");
    const proposal = rows[text.findIndex((x) => x.includes("Ada quer publicar um painel"))] as HTMLElement;
    expect(proposal.textContent).toContain("“Black Friday” para todo o workspace · hoje só você vê");
    const alert = rows[text.findIndex((x) => x.includes("Ada avisou sobre “Vendas hoje”"))] as HTMLElement;
    expect(alert.textContent).toContain("As vendas caíram 24% abaixo de ontem.");
    const failed = rows[
      text.findIndex((x) => x.includes("Ada não conseguiu atualizar “Tempo de build”"))
    ] as HTMLElement;
    expect(failed.textContent).toContain("A última atualização terminou sem dados.");

    await click(within(proposal).getByRole("button", { name: "Manter só para mim" }));
    await settle(3);
    expect(last(state, "dashboards.decideProposal")).toEqual([ORG_ID, s.board.id, "keep"]);
    expect(document.body.textContent).toContain("Só você vê “Black Friday”");

    await click(within(failed).getByRole("button", { name: "Resolver" }));
    await settle(3);
    expect(last(state, "dashboards.refreshWidget")).toEqual([ORG_ID, s.builds.id]);

    // One action at the row's end, as on every other row: Resolve on a failure; on an alert the row itself opens
    // the widget ("Open widget" at its end), on Home (it is on my home board).
    expect(within(failed).getAllByRole("button")).toHaveLength(2);
    expect(within(alert).getAllByRole("button")).toHaveLength(1);
    expect(alert.querySelector(".home-row__act")?.textContent).toBe("Abrir widget");
    await click(within(alert).getByRole("button"));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/home`);
    expect((router.state.location.search as { widget?: string }).widget).toBe(s.sales.id);
    expect(screen().getByRole("dialog", { name: "Vendas hoje" })).toBeTruthy();
    expect(state.calls).toContainEqual({ method: "notifications.read", args: [ORG_ID, "n-alert", true] });
  });

  test("in the inbox too: where it is from on its row, and the request decided in the open item", async () => {
    const s = noticed();
    const { state } = await open(`/org/${ORG_ID}/notifications`, s);
    const row = document.querySelector('[data-n="n-proposal"]') as HTMLElement;
    expect(row.textContent).toContain("Ada quer publicar um painel");
    expect(row.textContent).toContain("Painel");
    // A row has no buttons (ADR 0218): the open item, beside the list, decides.
    const failed = document.querySelector('[data-n="n-failed"]') as HTMLElement;
    expect(failed.textContent).toContain("A última atualização terminou sem dados.");
    await click(failed);
    const read = () => document.querySelector(".ib-read") as HTMLElement;
    expect(within(read()).getByRole("button", { name: "Resolver" })).toBeTruthy();
    await click(row);
    await click(within(read()).getByRole("button", { name: "Publicar para o workspace" }));
    await settle(3);
    expect(last(state, "dashboards.decideProposal")).toEqual([ORG_ID, s.board.id, "publish"]);
  });
});

describe("Pin from the chat", () => {
  const CHART = JSON.stringify({
    type: "bar",
    title: "Pedidos por canal",
    labels: ["Site", "App", "WhatsApp"],
    series: [{ name: "Pedidos", values: [41, 26, 9] }],
  });

  test("an agent's chart goes to My Home as a widget, with its data, kept updated when asked", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-chart",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: `Aqui os pedidos:\n\n\`\`\`chart\n${CHART}\n\`\`\``,
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: ago(3),
    });
    const s = setup(state);
    s.fake.pinnable = [
      {
        messageId: "m-chart",
        channelId: ENG_ID,
        threadId: null,
        agentId: ADA_ID,
        at: ago(3),
        block: CHART,
        title: "Pedidos por canal",
        spec: { kind: "bars", labels: ["Site", "App", "WhatsApp"], values: [41, 26, 9] },
        place: { kind: "channel", name: "eng" },
      },
    ];
    await open(`/org/${ORG_ID}/c/${ENG_ID}`, s);
    const chart = document.querySelector(".chart-card") as HTMLElement;
    await click(within(chart).getByRole("button", { name: "Fixar num painel" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Fixar num painel" });
    // The chart as it will look: bars with its numbers, Ada's.
    expect([...dialog.querySelectorAll(".wk-bar__v")].map((v) => v.textContent)).toEqual(["41", "26", "9"]);
    await click(within(dialog).getByRole("switch", { name: "Manter atualizado" }));
    expect(dialog.textContent).toContain("Ada refaz todo dia às 8h");
    await click(within(dialog).getByRole("button", { name: "Fixar" }));
    await settle(4);
    const pinned = last(state, "dashboards.pinWidget");
    expect(pinned).toEqual([ORG_ID, s.home.id, { messageId: "m-chart", block: CHART, schedule: "day", size: "m" }]);
    expect(document.body.textContent).toContain("Fixado em Meu Início · Ada refaz todo dia às 8h");
    const added = s.fake.boards.find((b) => b.id === s.home.id)?.widgets.find((w: Widget) => w.sourceMessageId);
    expect(added?.title).toBe("Pedidos por canal");
  });
});
