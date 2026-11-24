import { type Query, type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useApi } from "../api/context";
import { ApiError } from "../api/http";
import { keys } from "../api/keys";
import { useAiStatusSince } from "../api/queries";
import { type CacheEdit, edit, editWhere, optimistic } from "../lib/optimistic";
import { busyWidgets, widgetAiReady, widgetNeedsAi, widgetStoppedForAi } from "./lib";
import type {
  ConfirmWidgetInput,
  CreateDashboardInput,
  CreateWidgetInput,
  Dashboard,
  DashboardLayoutInput,
  DashboardList,
  DashboardProposalDecision,
  DashboardSummary,
  PinWidgetInput,
  ShareDashboardInput,
  UpdateDashboardInput,
  UpdateWidgetInput,
  Widget,
  WidgetDetail,
  WidgetSchedule,
  WidgetSize,
} from "./types";

/**
 * React Query hooks for boards and widgets (ADR 0135). Every write puts what came back in the cache and refreshes the
 * list; `dashboard.changed` and `dashboard.widget` events (`applyDashboardEvent`) keep everything live. Errors are the
 * caller's to say (`meta.silent`), translated by code.
 */

/** A board came back: the one, the home board when it is it, and the list. */
export function cacheDashboard(qc: QueryClient, orgId: string, board: Dashboard) {
  qc.setQueryData(keys.dashboard(orgId, board.id), board);
  if (board.kind === "home") qc.setQueryData(keys.dashboardHome(orgId), board);
  void qc.invalidateQueries({ queryKey: keys.dashboardList(orgId) });
}

/** A widget came back: put it on its board (wherever that board is cached) and in its detail. */
export function cacheWidget(qc: QueryClient, orgId: string, widget: Widget) {
  const put = (board: Dashboard | undefined) => {
    if (!board) return board;
    const others = board.widgets.filter((w) => w.id !== widget.id);
    // Moved to another board: it leaves this one.
    if (board.id !== widget.dashboardId) {
      return others.length === board.widgets.length ? board : { ...board, widgets: others, widgetCount: others.length };
    }
    const widgets = board.widgets.some((w) => w.id === widget.id)
      ? board.widgets.map((w) => (w.id === widget.id ? widget : w))
      : [...board.widgets, widget];
    return { ...board, widgets, widgetCount: widgets.length };
  };
  for (const [key, board] of qc.getQueriesData<Dashboard>({ queryKey: [...keys.dashboards(orgId), "one"] })) {
    qc.setQueryData(key, put(board));
  }
  qc.setQueryData<Dashboard>(keys.dashboardHome(orgId), (board) => put(board));
  qc.setQueryData<WidgetDetail>(keys.widget(orgId, widget.id), (old) => (old ? { ...old, ...widget } : old));
  void qc.invalidateQueries({ queryKey: keys.dashboardList(orgId) });
}

/** A widget was taken off: out of every cached board, its detail dropped. */
export function dropWidget(qc: QueryClient, orgId: string, widgetId: string) {
  const drop = (board: Dashboard | undefined) => {
    if (!board?.widgets.some((w) => w.id === widgetId)) return board;
    const widgets = board.widgets.filter((w) => w.id !== widgetId);
    return { ...board, widgets, widgetCount: widgets.length };
  };
  for (const [key, board] of qc.getQueriesData<Dashboard>({ queryKey: [...keys.dashboards(orgId), "one"] })) {
    qc.setQueryData(key, drop(board));
  }
  qc.setQueryData<Dashboard>(keys.dashboardHome(orgId), (board) => drop(board));
  qc.removeQueries({ queryKey: keys.widget(orgId, widgetId) });
  void qc.invalidateQueries({ queryKey: keys.dashboardList(orgId) });
}

/**
 * One change to a board made before the server answers, wherever it shows: its own query, the home board when it is
 * it, and its row in the list. The answer (`cacheDashboard`) replaces it.
 */
function boardEdits(
  orgId: string,
  dashboardId: string,
  patch: (board: DashboardSummary) => Partial<DashboardSummary>,
): CacheEdit[] {
  const apply = <B extends DashboardSummary>(board: B): B =>
    board.id === dashboardId ? { ...board, ...patch(board) } : board;
  return [
    edit<Dashboard>(keys.dashboard(orgId, dashboardId), apply),
    // Only when it is that board: a read of another home board isn't cut short.
    editWhere<Dashboard>(
      keys.dashboardHome(orgId),
      (q) => (q.state.data as Dashboard | undefined)?.id === dashboardId,
      apply,
    ),
    edit<DashboardList>(keys.dashboardList(orgId), (list) => ({
      ...list,
      home: list.home ? apply(list.home) : list.home,
      dashboards: list.dashboards.map(apply),
    })),
  ];
}

/** S, M or L as a board's width and height (as the widget spec's `sizeToLayout`). */
const SIZE_LAYOUT: Record<WidgetSize, { w: 1 | 2; h: 1 | 2 }> = {
  s: { w: 1, h: 1 },
  m: { w: 2, h: 1 },
  l: { w: 2, h: 2 },
};

/**
 * One change to a widget made before the server answers, on every cached board that holds it (and only those: a read
 * of another board isn't cut short). `change` answering null (removed), or a widget on another board (moved), takes it
 * off the boards it was on; the answer (`cacheWidget`) puts it on the one it moved to.
 */
function widgetBoardEdits(orgId: string, widgetId: string, change: (widget: Widget) => Widget | null): CacheEdit[] {
  const holds = (q: Query) => Boolean((q.state.data as Dashboard | undefined)?.widgets?.some((w) => w.id === widgetId));
  const onBoard = (board: Dashboard): Dashboard => {
    const at = board.widgets.find((w) => w.id === widgetId);
    if (!at) return board;
    const next = change(at);
    const kept = next && next.dashboardId === board.id ? next : null;
    const widgets = kept
      ? board.widgets.map((w) => (w.id === widgetId ? kept : w))
      : board.widgets.filter((w) => w.id !== widgetId);
    return { ...board, widgets, widgetCount: widgets.length };
  };
  return [
    editWhere<Dashboard>([...keys.dashboards(orgId), "one"], holds, onBoard),
    editWhere<Dashboard>(keys.dashboardHome(orgId), holds, onBoard),
  ];
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** The Dashboards page, the phone's Dashboards list and its row on the home. */
export function useDashboards(orgId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.dashboardList(orgId),
    queryFn: () => api.dashboards.list(orgId),
    enabled,
    staleTime: 30_000,
  });
}

export function useDashboard(orgId: string, dashboardId: string | null | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.dashboard(orgId, dashboardId ?? ""),
    queryFn: () => api.dashboards.get(orgId, dashboardId ?? ""),
    enabled: Boolean(dashboardId),
    staleTime: 30_000,
  });
}

/** My home board (the Home mural, "My Home"), made on first use. */
export function useHomeDashboard(orgId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.dashboardHome(orgId),
    queryFn: () => api.dashboards.home(orgId),
    enabled,
    staleTime: 30_000,
  });
}

/** One widget with its history (the side panel, the phone's widget screen). */
export function useWidget(orgId: string, widgetId: string | null | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.widget(orgId, widgetId ?? ""),
    queryFn: () => api.dashboards.widget(orgId, widgetId ?? ""),
    enabled: Boolean(widgetId),
    staleTime: 15_000,
  });
}

/** How often a draft's preview asks again while its test build works, in case an event was missed. */
export const WIDGET_DRAFT_POLL_MS = 2000;

/**
 * The live view of a widget being tested ("Test" in New widget): the draft, kept fresh by its `dashboard.widget`
 * events (to its creator only) and, while it is `building` or `updating`, asked again every `WIDGET_DRAFT_POLL_MS`.
 * Not while its run waits (`widgetWaiting`): a budget can wait for weeks, and its end is an event. Null id: nothing
 * tested.
 */
export function useWidgetDraft(orgId: string, widgetId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: keys.widget(orgId, widgetId ?? ""),
    queryFn: () => api.dashboards.widget(orgId, widgetId ?? ""),
    enabled: Boolean(widgetId),
    staleTime: 0,
    retry: false,
    refetchInterval: (q) => (q.state.data && busyWidgets([q.state.data]).length > 0 ? WIDGET_DRAFT_POLL_MS : false),
  });
}

/** The cost line of "New widget" for an agent and a schedule. */
export function useWidgetCost(
  orgId: string,
  agentId: string | null | undefined,
  schedule: WidgetSchedule,
  enabled = true,
) {
  const api = useApi();
  return useQuery({
    queryKey: keys.widgetCost(orgId, agentId ?? "", schedule),
    queryFn: () => api.dashboards.widgetCost(orgId, agentId ?? "", schedule),
    enabled: Boolean(agentId) && enabled && schedule !== "manual",
    staleTime: 5 * 60_000,
  });
}

/** What the agent reads and its suggestions ("New widget"). */
export function useWidgetSuggestions(orgId: string, agentId: string | null | undefined, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.widgetSuggestions(orgId, agentId ?? ""),
    queryFn: () => api.dashboards.widgetSuggestions(orgId, agentId ?? ""),
    enabled: Boolean(agentId) && enabled,
    staleTime: 60 * 60_000,
  });
}

/** "Pin from chat": the charts agents sent where I read. */
export function usePinnableBlocks(orgId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.widgetPinnable(orgId),
    queryFn: () => api.dashboards.pinnableBlocks(orgId),
    enabled,
    staleTime: 30_000,
  });
}

// ── Boards ───────────────────────────────────────────────────────────────────

/**
 * "Use on Home" / "Stop using on Home" (ADR 0135 §18): Início shows the board (null: my own home again). The list
 * holds the choice, so it changes there at once.
 */
export function useSetHomeDashboard(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (dashboardId: string | null) => api.dashboards.setHome(orgId, dashboardId),
    ...optimistic(qc, (dashboardId: string | null) => [
      edit<DashboardList>(keys.dashboardList(orgId), (list) => ({ ...list, homeDashboardId: dashboardId })),
    ]),
    onSuccess: ({ homeDashboardId }) => {
      qc.setQueryData<DashboardList>(keys.dashboardList(orgId), (list) => (list ? { ...list, homeDashboardId } : list));
      void qc.invalidateQueries({ queryKey: keys.dashboardList(orgId) });
    },
  });
}

/**
 * What Início shows (ADR 0135 §18): the board chosen for it while I still see it, else my own home board. `chosen`
 * is the board (null on my own home); `loading` until the list (and the chosen board) came.
 */
export function useHomeBoard(orgId: string, enabled = true) {
  const list = useDashboards(orgId, enabled);
  const chosenId = list.data?.homeDashboardId ?? null;
  const chosen = useDashboard(orgId, enabled ? chosenId : null);
  const own = useHomeDashboard(orgId, enabled);
  return {
    chosenId,
    /** The chosen board's title from the list, before the board itself came. */
    chosenTitle: list.data?.dashboards.find((d) => d.id === chosenId)?.title ?? null,
    chosen: chosenId ? (chosen.data ?? null) : null,
    own: own.data ?? null,
    board: chosenId ? (chosen.data ?? null) : (own.data ?? null),
    loading: list.isPending || (chosenId ? chosen.isPending : own.isPending),
    refetch: async () => {
      await Promise.all([list.refetch(), own.refetch(), ...(chosenId ? [chosen.refetch()] : [])]);
    },
  };
}

export function useCreateDashboard(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (input: CreateDashboardInput) => api.dashboards.create(orgId, input),
    onSuccess: (board) => cacheDashboard(qc, orgId, board),
  });
}

export function useUpdateDashboard(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ dashboardId, ...patch }: UpdateDashboardInput & { dashboardId: string }) =>
      api.dashboards.update(orgId, dashboardId, patch),
    // A rename or a pin shows at once; the answer replaces it.
    ...optimistic(qc, ({ dashboardId, title, about, pinned }: UpdateDashboardInput & { dashboardId: string }) =>
      boardEdits(orgId, dashboardId, () => ({
        ...(title !== undefined ? { title } : {}),
        ...(about !== undefined ? { about } : {}),
        ...(pinned !== undefined ? { pinned } : {}),
      })),
    ),
    onSuccess: (board) => cacheDashboard(qc, orgId, board),
  });
}

export function useShareDashboard(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ dashboardId, ...input }: ShareDashboardInput & { dashboardId: string }) =>
      api.dashboards.share(orgId, dashboardId, input),
    // Who sees it shows at once; what that lets each viewer do comes with the answer.
    ...optimistic(qc, ({ dashboardId, ...input }: ShareDashboardInput & { dashboardId: string }) =>
      boardEdits(orgId, dashboardId, () => ({
        audience: input.audience,
        roleIds: input.roleIds,
        editPolicy: input.editPolicy,
        ...(input.editRoleIds !== undefined ? { editRoleIds: input.editRoleIds } : {}),
      })),
    ),
    onSuccess: (board) => cacheDashboard(qc, orgId, board),
  });
}

export function useDeleteDashboard(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (dashboardId: string) => api.dashboards.remove(orgId, dashboardId),
    // Out of the list at once (and off Início when it was shown there); a refusal puts it back.
    ...optimistic(qc, (dashboardId: string) => [
      edit<DashboardList>(keys.dashboardList(orgId), (list) => ({
        ...list,
        dashboards: list.dashboards.filter((d) => d.id !== dashboardId),
        homeDashboardId: list.homeDashboardId === dashboardId ? null : list.homeDashboardId,
      })),
    ]),
    onSuccess: (_, dashboardId) => {
      qc.removeQueries({ queryKey: keys.dashboard(orgId, dashboardId) });
      void qc.invalidateQueries({ queryKey: keys.dashboardList(orgId) });
    },
  });
}

/**
 * "Organize": the new order and sizes show at once (`optimistic`), the server's answer replaces them, and a failure
 * puts the board back as it was.
 */
export function useSaveLayout(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ dashboardId, ...input }: DashboardLayoutInput & { dashboardId: string; home?: boolean }) =>
      api.dashboards.saveLayout(orgId, dashboardId, { widgets: input.widgets, tiles: input.tiles }),
    ...optimistic(
      qc,
      ({ dashboardId, home, widgets, tiles }: DashboardLayoutInput & { dashboardId: string; home?: boolean }) => {
        const at = new Map(widgets.map((w) => [w.id, w]));
        return [
          edit<Dashboard>(home ? keys.dashboardHome(orgId) : keys.dashboard(orgId, dashboardId), (board) => ({
            ...board,
            widgets: board.widgets.map((w) => {
              const next = at.get(w.id);
              return next ? { ...w, layout: { position: next.position, w: next.w, h: next.h } } : w;
            }),
            tiles: tiles ?? board.tiles,
          })),
        ];
      },
    ),
    onSuccess: (board) => cacheDashboard(qc, orgId, board),
  });
}

/** Publish or Keep only for me, on an agent's request. */
export function useDecideDashboardProposal(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ dashboardId, decision }: { dashboardId: string; decision: DashboardProposalDecision }) =>
      api.dashboards.decideProposal(orgId, dashboardId, decision),
    // The request goes at once; published, the board shows the audience it asked for.
    ...optimistic(qc, ({ dashboardId, decision }: { dashboardId: string; decision: DashboardProposalDecision }) =>
      boardEdits(orgId, dashboardId, (board) =>
        decision === "publish" && board.proposal
          ? { audience: board.proposal.audience, roleIds: board.proposal.roleIds, proposal: null }
          : { proposal: null },
      ),
    ),
    onSuccess: (board) => cacheDashboard(qc, orgId, board),
  });
}

// ── Widgets ──────────────────────────────────────────────────────────────────

export function useCreateWidget(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ dashboardId, ...input }: CreateWidgetInput & { dashboardId: string }) =>
      api.dashboards.createWidget(orgId, dashboardId, input),
    onSuccess: (widget) => cacheWidget(qc, orgId, widget),
  });
}

/**
 * "Test" in New widget: a draft built at once with real data (`{ dashboardId, ...CreateWidgetInput }`). It lands on
 * no board, so only its own query is seeded; drop it with `useRemoveWidget` when the dialog closes or tests again.
 */
export function useTestWidget(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ dashboardId, ...input }: CreateWidgetInput & { dashboardId: string }) =>
      api.dashboards.testWidget(orgId, dashboardId, input),
    onSuccess: (draft) => {
      void qc.invalidateQueries({ queryKey: keys.widget(orgId, draft.id) });
    },
  });
}

/** "Create widget" after a test that worked (`{ widgetId, ...ConfirmWidgetInput }`): it goes first on that board. */
export function useConfirmWidget(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ widgetId, ...input }: ConfirmWidgetInput & { widgetId: string }) =>
      api.dashboards.confirmWidget(orgId, widgetId, input),
    onSuccess: (widget) => {
      cacheWidget(qc, orgId, widget);
      void qc.invalidateQueries({ queryKey: keys.dashboard(orgId, widget.dashboardId) });
      void qc.invalidateQueries({ queryKey: keys.dashboardHome(orgId) });
    },
  });
}

export function usePinWidget(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ dashboardId, ...input }: PinWidgetInput & { dashboardId: string }) =>
      api.dashboards.pinWidget(orgId, dashboardId, input),
    onSuccess: (widget) => cacheWidget(qc, orgId, widget),
  });
}

export function useUpdateWidget(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ widgetId, ...patch }: UpdateWidgetInput & { widgetId: string }) =>
      api.dashboards.updateWidget(orgId, widgetId, patch),
    // Its name, schedule, alert, size or board show at once; what a new prompt makes comes with the answer.
    ...optimistic(qc, ({ widgetId, ...patch }: UpdateWidgetInput & { widgetId: string }) => {
      const change = (w: Widget): Widget => ({
        ...w,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
        ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
        ...(patch.alert !== undefined ? { alert: patch.alert } : {}),
        ...(patch.size !== undefined ? { layout: { ...w.layout, ...SIZE_LAYOUT[patch.size] } } : {}),
        ...(patch.dashboardId !== undefined ? { dashboardId: patch.dashboardId } : {}),
      });
      return [
        ...widgetBoardEdits(orgId, widgetId, change),
        edit<WidgetDetail>(keys.widget(orgId, widgetId), (detail) => ({ ...detail, ...change(detail) })),
      ];
    }),
    onSuccess: (widget) => cacheWidget(qc, orgId, widget),
  });
}

export function useRemoveWidget(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (widgetId: string) => api.dashboards.removeWidget(orgId, widgetId),
    // Off every board at once; a refusal puts it back where it was.
    ...optimistic(qc, (widgetId: string) => widgetBoardEdits(orgId, widgetId, () => null)),
    onSuccess: (_, widgetId) => dropWidget(qc, orgId, widgetId),
  });
}

/** "Update now" and "Resolve". */
export function useRefreshWidget(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (widgetId: string) => api.dashboards.refreshWidget(orgId, widgetId),
    onSuccess: (widget) => cacheWidget(qc, orgId, widget),
  });
}

/** Widgets this app started once their agent had an AI: each only once, so a status the server disagrees with can't loop. */
const builtOnceAi = new Set<string>();

/**
 * A widget waiting for an AI (`widgetNeedsAi`) starts building once its agent has one for background work, connected
 * from wherever, on any screen showing it to someone who may update it (ADR 0135 §20), by a status read after it
 * started waiting (`useAiStatusSince`). Nobody pressed for it (`auto`): it only queues, and the server checks again;
 * still no AI there (`widget.needs_ai`), a later status may try once more.
 */
export function useBuildOnceAi(orgId: string, widget: Widget | null | undefined, canEdit: boolean) {
  const api = useApi();
  const qc = useQueryClient();
  const status = useAiStatusSince(orgId, Boolean(canEdit && widget && widgetNeedsAi(widget)));
  const id = canEdit && widget && widgetNeedsAi(widget) && widgetAiReady(widget, status) ? widget.id : null;
  useEffect(() => {
    if (!id || builtOnceAi.has(id)) return;
    builtOnceAi.add(id);
    api.dashboards.refreshWidget(orgId, id, true).then(
      (built) => cacheWidget(qc, orgId, built),
      (e: unknown) => {
        if (e instanceof ApiError && e.code === "widget.needs_ai") builtOnceAi.delete(id);
      },
    );
  }, [id, api, qc, orgId]);
}

/**
 * Whether a failed widget's way out is connecting an AI, never Resolve: one waiting for an AI, or one that stopped for
 * the lack of one while its build still has none (the AI status read since, `widgetAiReady`). Once it has, Resolve
 * starts it again.
 */
export function useWidgetLacksAi(orgId: string, widget: Widget | null | undefined): boolean {
  const stopped = Boolean(widget && widgetStoppedForAi(widget));
  const status = useAiStatusSince(orgId, stopped);
  return Boolean(widget && (widgetNeedsAi(widget) || (stopped && !widgetAiReady(widget, status))));
}

/** "Ask for a change" (the widget panel's composer). */
export function useAskWidgetChange(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ widgetId, text }: { widgetId: string; text: string }) =>
      api.dashboards.askWidgetChange(orgId, widgetId, text),
    onSuccess: (widget) => {
      cacheWidget(qc, orgId, widget);
      void qc.invalidateQueries({ queryKey: keys.widget(orgId, widget.id) });
    },
  });
}
