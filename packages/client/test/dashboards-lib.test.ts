import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import { QueryClient } from "@tanstack/react-query";
import i18next from "i18next";
import {
  applyDashboardEvent,
  boardItems,
  busyWidgets,
  createHttpApi,
  type Dashboard,
  type DashboardEditPolicy,
  type DashboardSummary,
  dashboardAccessOf,
  dashboardGroups,
  editorsInput,
  editorsSummary,
  editorsText,
  fitEditRoles,
  keys,
  layoutOf,
  moveItem,
  resizeItem,
  roleSeesBoard,
  toggleEditRole,
  WIDGET_LINE_NOTE_MS,
  type Widget,
  widgetAiReady,
  widgetCardStatus,
  widgetCostLine,
  widgetFailureCause,
  widgetFailureKey,
  widgetFailureText,
  widgetNeedsAi,
  widgetStepWords,
  widgetStoppedForAi,
  widgetWaitFix,
  widgetWaiting,
  widgetWaitOf,
  widgetWaitText,
  withEditRoles,
} from "../src/index";
import { planKeyIntent } from "../src/lib/no-ai";
import { usageWhen } from "../src/lib/plan-usage";

const summary = (over: Partial<DashboardSummary>): DashboardSummary => ({
  id: "d",
  kind: "board",
  title: "Board",
  about: "",
  audience: "workspace",
  roleIds: [],
  editPolicy: "viewers",
  editRoleIds: [],
  pinned: false,
  position: 0,
  owner: null,
  ownerUserId: "nina",
  mine: false,
  widgetCount: 0,
  thumbs: [],
  viewerCount: 3,
  canEdit: true,
  canManage: false,
  proposal: null,
  createdAt: "2026-11-03T10:00:00.000Z",
  updatedAt: "2026-11-03T10:00:00.000Z",
  ...over,
});

const widget = (id: string, position: number, w: 1 | 2 = 1): Widget => ({
  id,
  dashboardId: "d",
  agentId: "theo",
  title: id,
  prompt: "",
  format: "auto",
  kind: "kpi",
  spec: { kind: "kpi", value: 1 },
  sources: [],
  layout: { position, w, h: 1 },
  schedule: "hour",
  alert: { enabled: false, condition: "" },
  status: "ok",
  failure: null,
  wait: null,
  refreshedAt: null,
  nextRunAt: null,
  routineId: null,
  sourceMessageId: null,
  createdBy: null,
  draft: false,
  lastCostUsd: null,
  createdAt: "2026-11-03T10:00:00.000Z",
  updatedAt: "2026-11-03T10:00:00.000Z",
});

describe("dashboard groups", () => {
  test("splits by audience, pinned first, then by position and title; homes stay out", () => {
    const list = [
      summary({ id: "a", title: "Sales", audience: "workspace", position: 2 }),
      summary({ id: "b", title: "Acme today", audience: "workspace", pinned: true, position: 9 }),
      summary({ id: "c", title: "Finance", audience: "roles" }),
      summary({ id: "d", title: "My goals", audience: "private" }),
      summary({ id: "h", kind: "home", title: "", audience: "private" }),
      summary({ id: "e", title: "Product", audience: "workspace", position: 2 }),
    ];
    const groups = dashboardGroups(list);
    expect(groups.workspace.map((d) => d.id)).toEqual(["b", "e", "a"]);
    expect(groups.roles.map((d) => d.id)).toEqual(["c"]);
    expect(groups.mine.map((d) => d.id)).toEqual(["d"]);
  });
});

describe("who has access", () => {
  const board = {
    kind: "board" as const,
    audience: "roles" as const,
    roleIds: ["sales"],
    editPolicy: "owner" as const,
    ownerUserId: "nina",
  };
  test("the owner edits; a role holder sees; an admin edits; anyone else doesn't see", () => {
    expect(dashboardAccessOf({ userId: "nina", roleIds: [], admin: false }, board)).toBe("edits");
    expect(dashboardAccessOf({ userId: "lia", roleIds: ["sales"], admin: false }, board)).toBe("sees");
    expect(dashboardAccessOf({ userId: "theo", roleIds: [], admin: true }, board)).toBe("edits");
    expect(dashboardAccessOf({ userId: "ada", roleIds: ["support"], admin: false }, board)).toBe("none");
  });
  test("viewers edit when the board says so; a private board is its owner's alone, admins included", () => {
    const lia = { userId: "lia", roleIds: [], admin: false };
    const theo = { userId: "theo", roleIds: [], admin: true };
    expect(dashboardAccessOf(lia, { ...board, audience: "workspace", editPolicy: "viewers" })).toBe("edits");
    expect(dashboardAccessOf(theo, { ...board, audience: "private" })).toBe("none");
  });
  test("with roles, a holder of an edit role who sees the board edits; one who doesn't see it gets nothing", () => {
    const byRoles = { ...board, roleIds: ["sales", "board"], editPolicy: "roles" as const, editRoleIds: ["board"] };
    expect(dashboardAccessOf({ userId: "lia", roleIds: ["board"], admin: false }, byRoles)).toBe("edits");
    expect(dashboardAccessOf({ userId: "ada", roleIds: ["sales"], admin: false }, byRoles)).toBe("sees");
    // Seeing comes first: an edit role outside the audience gives nothing.
    const outside = { ...byRoles, roleIds: ["sales"], editRoleIds: ["board"] };
    expect(dashboardAccessOf({ userId: "lia", roleIds: ["board"], admin: false }, outside)).toBe("none");
    // On a workspace board any member sees it; only the edit roles' holders edit.
    const everyone = { ...byRoles, audience: "workspace" as const, roleIds: [] };
    expect(dashboardAccessOf({ userId: "ada", roleIds: ["sales"], admin: false }, everyone)).toBe("sees");
    expect(dashboardAccessOf({ userId: "lia", roleIds: ["board"], admin: false }, everyone)).toBe("edits");
  });
});

describe("who edits", () => {
  const draft = {
    audience: "roles" as const,
    roleIds: ["sales", "board"],
    editPolicy: "owner" as DashboardEditPolicy,
    editRoleIds: [] as string[],
  };
  test("a role sees a workspace board, a roles board when it is one of them, never a private one", () => {
    expect(roleSeesBoard({ audience: "workspace", roleIds: [] }, "sales")).toBe(true);
    expect(roleSeesBoard({ audience: "roles", roleIds: ["sales"] }, "sales")).toBe(true);
    expect(roleSeesBoard({ audience: "roles", roleIds: ["sales"] }, "board")).toBe(false);
    expect(roleSeesBoard({ audience: "private", roleIds: [] }, "sales")).toBe(false);
  });
  test("checking roles sets `roles`; unchecking the last one goes back to you and admins", () => {
    const one = toggleEditRole(draft, "sales");
    expect(one).toMatchObject({ editPolicy: "roles", editRoleIds: ["sales"] });
    expect(toggleEditRole(one, "board")).toMatchObject({ editPolicy: "roles", editRoleIds: ["sales", "board"] });
    expect(toggleEditRole(one, "sales")).toMatchObject({ editPolicy: "owner", editRoleIds: [] });
    expect(withEditRoles({ ...draft, editPolicy: "viewers" }, ["board", "board"])).toMatchObject({
      editPolicy: "roles",
      editRoleIds: ["board"],
    });
  });
  test("narrowing who sees drops the edit roles that no longer see it, never widening who edits", () => {
    const picked = withEditRoles(draft, ["sales", "board"]);
    expect(fitEditRoles({ ...picked, roleIds: ["board"] })).toMatchObject({
      editPolicy: "roles",
      editRoleIds: ["board"],
    });
    expect(fitEditRoles({ ...picked, audience: "private" as const, roleIds: [] })).toMatchObject({
      editPolicy: "owner",
      editRoleIds: [],
    });
    const everyone = { ...picked, audience: "workspace" as const, roleIds: [] };
    expect(fitEditRoles(everyone)).toBe(everyone);
    expect(editorsInput({ editPolicy: "viewers", editRoleIds: ["sales"] })).toEqual({
      editPolicy: "viewers",
      editRoleIds: [],
    });
  });
  test("the summary names one or two roles and counts more; gone roles read as you and admins", () => {
    const roles = [
      { id: "sales", name: "Sales" },
      { id: "board", name: "Board" },
      { id: "ops", name: "Ops" },
    ];
    const t = ((key: string, o?: Record<string, unknown>) => `${key}${o ? JSON.stringify(o) : ""}`) as never;
    const text = (editRoleIds: string[], editPolicy: "viewers" | "owner" | "roles" = "roles") =>
      editorsText(t, editorsSummary({ editPolicy, editRoleIds }, roles));
    expect(text([], "viewers")).toBe("dashboards.edit.viewers");
    expect(text([], "owner")).toBe("dashboards.edit.owner");
    expect(text(["board"])).toBe("Board");
    expect(text(["board", "sales"])).toBe('dashboards.edit.twoRoles{"first":"Sales","second":"Board"}');
    expect(text(["ops", "board", "sales"])).toBe('dashboards.edit.manyRoles{"count":3}');
    expect(editorsSummary({ editPolicy: "roles", editRoleIds: ["gone"] }, roles)).toEqual({ kind: "owner" });
  });
});

describe("board layout", () => {
  test("tiles and widgets share one order; a tile comes first on a tie", () => {
    const items = boardItems(
      [widget("w1", 1), widget("w2", 0, 2)],
      [
        { key: "waiting", position: 0, w: 2, h: 1 },
        { key: "working", position: 3, w: 2, h: 1 },
      ],
    );
    expect(items.map((i) => i.id)).toEqual(["waiting", "w2", "w1", "working"]);
  });

  test("moving and resizing, then saving positions 0, 1, 2…", () => {
    const tiles = [{ key: "waiting" as const, position: 5, w: 2 as const, h: 1 as const }];
    const items = boardItems([widget("w1", 0), widget("w2", 1), widget("w3", 2)], tiles);
    const moved = moveItem(items, "waiting", "w1");
    expect(moved.map((i) => i.id)).toEqual(["waiting", "w1", "w2", "w3"]);
    expect(moveItem(items, "w1", "w3").map((i) => i.id)).toEqual(["w2", "w3", "w1", "waiting"]);
    expect(moveItem(items, "w1", "nope")).toEqual(items);
    const resized = resizeItem(moved, "w2", { w: 2, h: 2 });
    expect(layoutOf(resized)).toEqual({
      widgets: [
        { id: "w1", position: 1, w: 1, h: 1 },
        { id: "w2", position: 2, w: 2, h: 2 },
        { id: "w3", position: 3, w: 1, h: 1 },
      ],
      tiles: [{ key: "waiting", position: 0, w: 2, h: 1 }],
    });
    expect(layoutOf(boardItems([widget("w1", 0)]))).toEqual({ widgets: [{ id: "w1", position: 0, w: 1, h: 1 }] });
  });
});

describe("words", () => {
  test("a failure code with its own words, or the general one", () => {
    expect(widgetFailureKey("no_update")).toBe("widgets.failure.no_update");
    expect(widgetFailureKey("budget_exceeded")).toBe("widgets.failure.budget_exceeded");
    expect(widgetFailureKey("something_new")).toBe("widgets.failure.error");
    // Waiting for an AI, the reason it was held for: no key keeps the code's words.
    expect(widgetFailureKey("missing_credential", "not_signed_in")).toBe("widgets.needsAi.not_signed_in");
    expect(widgetFailureKey("missing_credential", "cli_missing")).toBe("widgets.needsAi.cli_missing");
    expect(widgetFailureKey("missing_credential", "no_key")).toBe("widgets.failure.missing_credential");
    expect(widgetFailureKey("no_update", "not_signed_in")).toBe("widgets.failure.no_update");
    // The right hand on a plan that serves only its owner, as the hold and as its run say it.
    expect(widgetFailureKey("missing_credential", "plan_not_shared")).toBe("widgets.needsAi.plan_not_shared");
    expect(widgetFailureKey("missing_credential", "plan_unattended")).toBe("widgets.needsAi.plan_not_shared");
    // Its plan away or held: a widget's own words where it has them, else the plan's line.
    expect(widgetFailureKey("missing_credential", "computer_away")).toBe("widgets.failure.waiting_computer");
    expect(widgetFailureKey("missing_credential", "plan_limit")).toBe("widgets.failure.waiting_plan");
    expect(widgetFailureKey("missing_credential", "commands_off")).toBe("noAi.rightHand.commands_off");
    // Nothing a widget doesn't know, nor what any object has.
    expect(widgetFailureKey("missing_credential", "toString")).toBe("widgets.failure.missing_credential");
  });

  test("Connect for a widget waiting on the right hand's plan opens on a key, the one AI its build can use", () => {
    const hand = { builtin: "right_hand" as const, ownerUserId: "u-walter" };
    expect(planKeyIntent(hand, "plan_not_shared")).toEqual({ intent: "api_key" });
    expect(planKeyIntent(hand, "computer_away")).toEqual({ intent: "api_key" });
    // No AI at all, or signed out: the plain dialog, whose plan or key fixes it.
    expect(planKeyIntent(hand, "no_key")).toEqual({});
    expect(planKeyIntent(hand, "not_signed_in")).toEqual({});
    expect(planKeyIntent({ builtin: null, ownerUserId: "u-walter" }, "plan_not_shared")).toEqual({});
  });

  test("a widget whose agent has no AI waits for one, and may build once the AI status says it has one", () => {
    const waiting: Widget = {
      ...widget("w", 0),
      status: "failed",
      failure: { code: "missing_credential", detail: null },
    };
    const failed: Widget = { ...waiting, failure: { code: "no_update", detail: null } };
    expect(widgetNeedsAi(waiting)).toBe(true);
    expect(widgetNeedsAi(failed)).toBe(false);
    expect(widgetNeedsAi({ ...waiting, status: "building" })).toBe(false);
    // Stopped after failing in a row: what the last failure needs.
    const stopped = (cause?: string): Widget => ({
      ...waiting,
      failure: { code: "failing", detail: null, ...(cause ? { cause } : {}) },
    });
    // It waits for nothing (nothing builds it by itself): stopped for the lack of an AI is its own state.
    expect(widgetNeedsAi(stopped("missing_credential"))).toBe(false);
    expect(widgetStoppedForAi(stopped("missing_credential"))).toBe(true);
    expect(widgetStoppedForAi(stopped("timeout"))).toBe(false);
    expect(widgetStoppedForAi(stopped())).toBe(false);
    expect(widgetStoppedForAi(waiting)).toBe(false);
    expect(widgetFailureCause({ code: "failing", detail: null, cause: "failing" }).code).toBe("failing");
    // Its line, as the web and the phone say it: that it stopped, then the last failure's own words.
    const said = i18next.createInstance();
    void said.init({ lng: "pt-BR", resources, initAsync: false });
    expect(widgetFailureText(said.t, stopped("missing_credential").failure, "Lodi")).toBe(
      "Parou depois de 5 falhas seguidas. A última: Lodi está sem chave ou plano de IA para trabalhar.",
    );
    expect(
      widgetFailureText(said.t, { code: "failing", detail: "A loja não respondeu.", cause: "agent_reported" }, "Lodi"),
    ).toBe("Parou depois de 5 falhas seguidas. A última: A loja não respondeu.");
    expect(widgetFailureText(said.t, stopped().failure, "Lodi")).toBe("Falhou várias vezes seguidas e parou.");
    const status = (state: "ready" | "no_ai" | "waiting") => ({ any: true, agents: [{ agentId: "theo", state }] });
    expect(widgetAiReady(waiting, status("ready"))).toBe(true);
    // Its computer away is no missing AI: the build waits for it as any run does.
    expect(widgetAiReady(waiting, status("waiting"))).toBe(true);
    expect(widgetAiReady(waiting, status("no_ai"))).toBe(false);
    // Not known yet, or another agent's: nothing starts.
    expect(widgetAiReady(waiting, undefined)).toBe(false);
    expect(widgetAiReady({ ...waiting, agentId: "ada" }, status("ready"))).toBe(false);
    expect(widgetAiReady(failed, status("ready"))).toBe(false);
    // One stopped for the lack of an AI has one again: Resolve comes back.
    expect(widgetAiReady(stopped("missing_credential"), status("ready"))).toBe(true);
    expect(widgetAiReady(stopped("timeout"), status("ready"))).toBe(false);
    // The right hand's: the server names the widgets whose own people's AI can build them, whatever its state reads.
    expect(widgetAiReady(waiting, { ...status("no_ai"), widgetsReady: ["w"] })).toBe(true);
    expect(widgetAiReady(waiting, { ...status("no_ai"), widgetsReady: ["other"] })).toBe(false);
    // What a build thinks with decides: ready for chat through the fallback is no AI for it, and the right hand
    // shown on someone's own AI may still build on the workspace's.
    const apart = (state: "ready" | "no_ai", background: "ready" | "no_ai") => ({
      any: true,
      agents: [{ agentId: "theo", state, background }],
    });
    expect(widgetAiReady(waiting, apart("ready", "no_ai"))).toBe(false);
    expect(widgetAiReady(waiting, apart("no_ai", "ready"))).toBe(true);
  });

  test("the cost line follows the schedule and who pays", () => {
    const estimate = {
      agentId: "theo",
      schedule: "hour" as const,
      runsPerDay: 24,
      perRunUsd: 0.015,
      perDayUsd: 0.36,
      perWeekUsd: 2.52,
      basis: "history" as const,
      billedTo: "api" as const,
    };
    expect(widgetCostLine("manual", estimate)).toEqual({ kind: "manual" });
    expect(widgetCostLine("hour", estimate)).toEqual({ kind: "day", usd: 0.36 });
    expect(widgetCostLine("week", estimate)).toEqual({ kind: "week", usd: 2.52 });
    expect(widgetCostLine("hour", { ...estimate, billedTo: "plan" })).toEqual({ kind: "plan" });
    expect(widgetCostLine("hour", { ...estimate, perDayUsd: null })).toEqual({ kind: "unknown" });
    expect(widgetCostLine("day", null)).toEqual({ kind: "unknown" });
  });
});

describe("dashboards API", () => {
  test("calls the routes of the contract", async () => {
    const calls: { url: string; method: string; body: string | null }[] = [];
    const api = createHttpApi({
      fetch: async (url, init) => {
        calls.push({ url, method: init.method ?? "GET", body: (init.body as string | undefined) ?? null });
        const body = url.endsWith("/widget-pinnable?limit=5") ? { blocks: [] } : {};
        return new Response(init.method === "DELETE" ? null : JSON.stringify(body), {
          status: init.method === "DELETE" ? 204 : 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const org = "/api/app/organizations/o1";
    await api.dashboards.list("o1");
    await api.dashboards.home("o1");
    await api.dashboards.share("o1", "d1", {
      audience: "roles",
      roleIds: ["r1"],
      editPolicy: "roles",
      editRoleIds: ["r1"],
    });
    await api.dashboards.saveLayout("o1", "d1", { widgets: [{ id: "w1", position: 0, w: 2, h: 1 }] });
    await api.dashboards.decideProposal("o1", "d1", "publish");
    await api.dashboards.pinWidget("o1", "d1", { messageId: "m1", block: "{}", schedule: "manual" });
    await api.dashboards.refreshWidget("o1", "w1");
    await api.dashboards.askWidgetChange("o1", "w1", "split by channel");
    await api.dashboards.removeWidget("o1", "w1");
    await api.dashboards.widgetCost("o1", "a1", "hour");
    expect(await api.dashboards.pinnableBlocks("o1", 5)).toEqual([]);
    expect(calls.map((c) => `${c.method} ${c.url.replace(org, "")}`)).toEqual([
      "GET /dashboards",
      "GET /dashboards/home",
      "PUT /dashboards/d1/share",
      "PUT /dashboards/d1/layout",
      "POST /dashboards/d1/proposal",
      "POST /dashboards/d1/widgets/pin",
      "POST /widgets/w1/refresh",
      "POST /widgets/w1/change",
      "DELETE /widgets/w1",
      "GET /widget-cost?agentId=a1&schedule=hour",
      "GET /widget-pinnable?limit=5",
    ]);
    expect(calls[4]?.body).toBe('{"decision":"publish"}');
    expect(calls[7]?.body).toBe('{"text":"split by channel"}');
  });

  test("Test and Create widget (ADR 0135 §16)", async () => {
    const calls: { url: string; method: string; body: string | null }[] = [];
    const api = createHttpApi({
      fetch: async (url, init) => {
        calls.push({ url, method: init.method ?? "GET", body: (init.body as string | undefined) ?? null });
        return new Response(JSON.stringify(widget("w1", 0)), {
          status: url.endsWith("/test") ? 202 : 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const ask = { agentId: "a1", prompt: "Site visits", format: "auto" as const, schedule: "hour" as const };
    expect((await api.dashboards.testWidget("o1", "d1", ask)).id).toBe("w1");
    const confirm = {
      dashboardId: "d2",
      title: "Visits",
      size: "s" as const,
      schedule: "day" as const,
      alert: { enabled: false, condition: "" },
    };
    await api.dashboards.confirmWidget("o1", "w1", confirm);
    expect(calls.map((c) => `${c.method} ${c.url.replace("/api/app/organizations/o1", "")}`)).toEqual([
      "POST /dashboards/d1/widgets/test",
      "POST /widgets/w1/confirm",
    ]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual(ask);
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual(confirm);
  });
});

describe("dashboard events", () => {
  test("a draft's event refreshes its live view (Test in New widget)", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.widget("o1", "w9"), { ...widget("w9", 0), draft: true, status: "building" });
    const event = { type: "dashboard.widget", orgId: "o1", dashboardId: "d1", widgetId: "w9", status: "ok" };
    expect(applyDashboardEvent(qc, "o1", event as { type: string })).toBe(true);
    expect(qc.getQueryState(keys.widget("o1", "w9"))?.isInvalidated).toBe(true);
  });

  test("refetch what the event touches; other events pass", () => {
    const qc = new QueryClient();
    const board = { id: "d1", widgets: [] } as unknown as Dashboard;
    qc.setQueryData(keys.dashboard("o1", "d1"), board);
    qc.setQueryData(keys.widget("o1", "w1"), { id: "w1" });
    expect(applyDashboardEvent(qc, "o1", { type: "message.created" })).toBe(false);
    expect(
      applyDashboardEvent(qc, "o1", {
        type: "dashboard.widget",
        orgId: "o1",
        dashboardId: "d1",
        widgetId: "w1",
        status: "removed",
      } as { type: string }),
    ).toBe(true);
    expect(qc.getQueryState(keys.dashboard("o1", "d1"))?.isInvalidated).toBe(true);
    expect(qc.getQueryData(keys.widget("o1", "w1"))).toBeUndefined();
    const deleted = { type: "dashboard.changed", dashboardId: "d1", deleted: true } as { type: string };
    expect(applyDashboardEvent(qc, "o1", deleted)).toBe(true);
    expect(qc.getQueryData(keys.dashboard("o1", "d1"))).toBeUndefined();
  });
});

describe("a build's step line", () => {
  // The keys as the app would say them, so the test reads which words each call gets.
  const t = ((key: string, values?: { app?: string }) => (values?.app ? `${key}(${values.app})` : key)) as never;
  const step = (tool: string, connector: string | null = null) => ({ tool, connector, service: null, at: "" });

  test("a connected app by its name, our own tools by what they do, thinking between calls", () => {
    expect(widgetStepWords(t, null)).toBe("dashboards.newWidget.thinking");
    expect(widgetStepWords(t, undefined)).toBe("dashboards.newWidget.thinking");
    expect(widgetStepWords(t, step("stripe_list_subscriptions", "Stripe"))).toBe("Chat.activity.consulting(Stripe)");
    expect(widgetStepWords(t, step("web_search"))).toBe("Chat.activity.searchingWeb");
    expect(widgetStepWords(t, step("permission_prompt"))).toBe("Chat.activity.runningCommandAny");
    expect(widgetStepWords(t, step("update_widget"))).toBe("dashboards.newWidget.finishing");
  });
});

describe("a refresh that waits (ADR 0135 §6)", () => {
  const resetsAt = "2026-11-12T16:00:00.000Z";
  const now = new Date("2026-11-12T12:00:00.000Z");
  const base = { source: null, resetsAt: null, scope: null, model: null, since: null, canContinue: false } as const;
  const plan = { ...base, code: "plan_limit", source: "plan", resetsAt } as const;
  const busy = (wait: Widget["wait"]): Widget => ({ ...widget("w", 0), status: "updating", wait });
  const t = (() => {
    const instance = i18next.createInstance();
    void instance.init({ lng: "en", fallbackLng: "en", resources, initAsync: false });
    return instance.t;
  })();

  test("it holds while its reset is ahead or unknown, and its card stands still meanwhile", () => {
    expect(widgetWaiting(busy(plan), now.getTime())).toEqual(plan);
    expect(widgetCardStatus(busy(plan), now.getTime())).toBe("ok");
    expect(widgetWaiting(busy({ ...plan, resetsAt: null }), now.getTime())?.code).toBe("plan_limit");
    // Past its reset it is about to go on: at work again.
    expect(widgetWaiting(busy(plan), Date.parse(resetsAt) + 1)).toBeNull();
    expect(widgetCardStatus(busy(plan), Date.parse(resetsAt) + 1)).toBe("updating");
    // Done, or nothing waits: no wait.
    expect(widgetWaiting({ ...busy(plan), status: "ok" }, now.getTime())).toBeNull();
    expect(widgetWaiting(busy(null), now.getTime())).toBeNull();
    expect(widgetCardStatus(busy(null), now.getTime())).toBe("updating");
  });

  test("room on its computer is a wait only once it lasted as long as the chat's note waits", () => {
    const since = (ms: number) =>
      ({ ...base, code: "busy", since: new Date(now.getTime() - ms).toISOString() }) as const;
    expect(widgetWaiting(busy(since(WIDGET_LINE_NOTE_MS - 1)), now.getTime())).toBeNull();
    expect(widgetWaiting(busy(since(WIDGET_LINE_NOTE_MS)), now.getTime())?.code).toBe("busy");
    expect(widgetWaiting(busy({ ...base, code: "busy" }), now.getTime())).toBeNull();
  });

  test("a waiting widget isn't busy: nothing polls it while it waits", () => {
    const waiting = { ...busy(plan), id: "a" };
    const working = { ...busy(null), id: "b" };
    const inLine = { ...busy({ ...base, code: "busy", since: now.toISOString() }), id: "c" };
    expect(busyWidgets([waiting, working, inLine], now.getTime()).map((w) => w.id)).toEqual(["b", "c"]);
    expect(busyWidgets([waiting], Date.parse(resetsAt) + 1).map((w) => w.id)).toEqual(["a"]);
  });

  test("a wait as the server sends it, read safely", () => {
    expect(widgetWaitOf({ code: "budget", source: "budget", resetsAt, agentName: "Theo" })).toEqual({
      ...base,
      code: "budget",
      source: "budget",
      resetsAt,
    });
    expect(widgetWaitOf({ code: "plan_limit", source: "plan", scope: "region", model: "DeepSeek V4 Pro" })).toEqual({
      ...base,
      code: "plan_limit",
      source: "plan",
      scope: "region",
      model: "DeepSeek V4 Pro",
    });
    expect(widgetWaitOf({ code: "outage", resetsAt, scope: "nonsense", canContinue: "yes" })).toEqual({
      ...base,
      code: "outage",
      resetsAt,
    });
    expect(widgetWaitOf({ code: "work_queue" })).toBeNull();
    expect(widgetWaitOf(null)).toBeNull();
  });

  test("in the reader's words: what it waits for, and when it picks up", () => {
    const when = usageWhen(t, "en", resetsAt, now);
    expect(widgetWaitText(t, "en", plan, "Theo", now)).toBe(`Waiting for Theo's plan to reset ${when}`);
    expect(widgetWaitText(t, "en", { ...plan, code: "usage_pause", source: "budget" }, "Theo", now)).toBe(
      `Waiting for Theo's budget to renew ${when}`,
    );
    expect(widgetWaitText(t, "en", { ...plan, resetsAt: null }, "Theo", now)).toBe("Waiting for Theo's plan to reset");
    // A budget with no reset is other runs holding it, not the month.
    expect(widgetWaitText(t, "en", { ...base, code: "budget", source: "budget" }, "Theo", now)).toBe(
      "Waiting a moment for Theo's budget",
    );
    expect(widgetWaitText(t, "en", { ...base, code: "computer" }, "Theo", now)).toBe("Waiting for Theo's computer");
    expect(widgetWaitText(t, "en", { ...base, code: "busy" }, "Theo", now)).toBe("Waiting for room on Theo's computer");
    expect(widgetWaitText(t, "en", { ...base, code: "outage", resetsAt }, "Theo", now)).toBe(
      `Waiting for Theo's AI to answer, next try ${when}`,
    );
  });

  test("a limit of its model alone reads as that model's, as the brain card says it, never as the plan's", () => {
    const own = (scope: "model" | "region" | "off" | "inactive", reset: string | null = null) => ({
      ...plan,
      scope,
      model: "DeepSeek V4 Pro",
      resetsAt: reset,
    });
    expect(widgetWaitText(t, "en", own("region"), "Theo", now)).toBe(
      "DeepSeek V4 Pro needs the Global region turned on in OpenCode (Settings\u00a0›\u00a0Privacy). The plan's other models keep working.",
    );
    expect(widgetWaitText(t, "en", own("off"), "Theo", now)).toStartWith(
      "OpenCode refused DeepSeek V4 Pro with this key",
    );
    expect(widgetWaitText(t, "en", own("inactive"), "Theo", now)).toStartWith("OpenCode Go isn't active");
    expect(widgetWaitText(t, "en", own("model", resetsAt), "Theo", now)).toBe(
      `DeepSeek V4 Pro hit its own limit on this plan and resets ${usageWhen(t, "en", resetsAt, now)}. The plan's other models keep working.`,
    );
    expect(widgetWaitText(t, "en", own("model"), "Theo", now)).toBe(
      "DeepSeek V4 Pro hit its own limit on this plan. The plan's other models keep working.",
    );
  });

  test("its way out, for who may take it: a budget for admins, a model for its owner and admins, its computer", () => {
    const admin = { admin: true, owner: false };
    const owner = { admin: false, owner: true };
    const member = { admin: false, owner: false };
    const month = { ...base, code: "budget", source: "budget", resetsAt } as const;
    expect(widgetWaitFix(month, admin)).toBe("raiseBudget");
    expect(widgetWaitFix(month, owner)).toBeNull();
    // Other runs hold it for a moment: no raise needed.
    expect(widgetWaitFix({ ...month, resetsAt: null }, admin)).toBeNull();
    const region = { ...plan, scope: "region", model: "DeepSeek V4 Pro" } as const;
    expect(widgetWaitFix(region, owner)).toBe("changeModel");
    expect(widgetWaitFix(region, member)).toBeNull();
    // Only time ends the plan's own limit.
    expect(widgetWaitFix(plan, admin)).toBeNull();
    expect(widgetWaitFix({ ...base, code: "computer" }, member)).toBe("openComputer");
    expect(widgetWaitFix({ ...base, code: "busy" }, member)).toBe("openComputer");
    expect(widgetWaitFix({ ...base, code: "outage", resetsAt }, admin)).toBeNull();
  });
});
