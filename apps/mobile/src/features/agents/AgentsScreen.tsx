import {
  type Agent,
  type AgentGroup,
  useAgentGroups,
  useAgentStatuses,
  useAgents,
  useAiStatus,
  useApprovals,
  useDms,
  useFormerAgents,
  useUnarchiveAgent,
  useWorkingRuns,
} from "@agenteschat/client";
import { type WorkLine, workLine, workLineText } from "@agenteschat/client/lib/agent-work";
import { listsAgent } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { waitingComputerByAgent } from "@agenteschat/client/lib/machine-outages";
import { previewBody } from "@agenteschat/client/lib/message-body";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { isOutOfOffice } from "@agenteschat/client/lib/presence";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { Stack, useIsFocused } from "expo-router";
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  LayoutAnimationConfig,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import type { Gaze } from "@/agent/AgentAvatar";
import { STORED } from "@/lib/storage";
import { useOrg } from "@/providers/org";
import {
  type HeaderAction,
  LargeTitleScreen,
  LIST_PREVIEW,
  LineIcon,
  ListRow,
  PixelOrbit,
  SectionHeader,
  SkeletonList,
  SkeletonOver,
  SwipeRow,
  Text,
  useFirstLoad,
  useReducedMotion,
  useToast,
  useWide,
  weights,
} from "@/ui";
import { router } from "@/ui/navigation";
import { withAlpha } from "@/ui/palette";
import { usePlanHold } from "../ai/parts";
import { CollapsibleSection, LandRow, useCollapsedSections } from "../chats/HomeSection";
import { usePins } from "../chats/pins";
import { mayCreate } from "../new/logic";
import { useMachineOutages } from "../outages/queries";
import { chooseAction } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { FirstUse, LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory, useNow, useOrgId, usePullRefresh } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { successHaptic, Tile } from "../shared/parts";
import { useWaitingApprovals, useWorkingNow } from "../shared/queries";
import { useTabHeader } from "../shared/tabHeader";
import { channelNameIn, useChannelNames, usePresenceOf } from "../status/hooks";
import { useTasksToday } from "../task-manager/hooks";
import { useSectorMenu } from "../team/SectorScreen";
import { TeamEntry } from "../team/TeamEntry";
import { AgentsHandoff, AgentsSplit } from "./AgentsSplit";
import { ARRIVAL_LOOK_MS, clearArrived, useArrived } from "./arrival";
import { openAgentDelete } from "./DeleteAgentScreen";
import { agoOf, freeSections, plainRole, type TeamLine, teamLines } from "./logic";
import { agentSplit, useAgentOpener } from "./split";
import { agoShort, workTitle } from "./work";

/** Rows whose agent moves (a long team stays light). */
const LIVE_ROWS = 8;
/** The chosen agent's row beside the list (ADR 0212): the ink this faint over the page, as Conversas' open row. */
const CHOSEN_TINT = 0.08;
/** Said either way: a screen's options merge, so the bar the split hid stays hidden until it is shown again. */
const SPLIT_OPTIONS = { headerShown: false };
const LIST_OPTIONS = { headerShown: true };
/** While Agentes is on screen, how often it asks whether the task manager is there (the manager itself: seconds). */
const TASKS_POLL_MS = 15_000;
/**
 * A row's state line changes in place (a run starts, a request lands): it crosses over, never pops; under 150 ms, as
 * something seen many times a day (animate-expo's gate).
 */
const STATE_IN = FadeIn.duration(140);
/** On the first load the two fixed rows on top arrive first, then the agents in the order they show. */
const LEAD_ROWS = 2;
/** Back from a routine: the body comes back into its sky's frame. */
const FACE_IN = FadeIn.duration(280).easing(Easing.bezier(0.23, 1, 0.32, 1));

/**
 * Agentes: the team in Conversas' rows, who needs you first. The task manager (ADR 0128) is a fixed row under the
 * title, saying how many work and how many wait; then three sections with names that never change: "Esperando você"
 * (the exact request and since when), "Trabalhando" (what each one is on, with the pixel orbit) and "Equipe" (its role
 * in plain words), split by the workspace's departments when it has some. Each row says its state as text in the
 * state's color (amber only for what waits on you; no badges, no dots), one fact per line, and the face is the state
 * too: running at work, asleep without an AI or while its computer is away. Tapping an agent opens its profile; the
 * bar's "+" creates one; an archived agent restores with a swipe. On a large screen (ADR 0212: the iPhone Duo's inner
 * display) the profile opens beside the list instead (`AgentsSplit`), each pane with its own bar: the tab's bar would
 * stand over both. A compact window shows the list alone, as before.
 */
export function AgentsScreen() {
  const wide = useWide();
  return (
    <>
      <Stack.Screen options={wide ? SPLIT_OPTIONS : LIST_OPTIONS} />
      <AgentsHandoff wide={wide} />
      {wide ? <AgentsSplit list={<AgentsList />} /> : <AgentsList />}
    </>
  );
}

/** Agentes' list (see `AgentsScreen`). */
function AgentsList() {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const header = useTabHeader();
  const orgId = useOrgId();
  const org = useOrg().org;
  // The directory's own read: a list that didn't load says so and asks again, never "create your first agent".
  const directory = useAgents(orgId);
  // One clock for every row's "4 min ago", read once here: a timer in each row woke the list row by row.
  const now = useNow();
  const runs = useWorkingRuns(orgId);
  const dms = useDms(orgId);
  const approvals = useApprovals(orgId);
  const work = useWorkingNow();
  const asking = useWaitingApprovals();
  const outages = useMachineOutages();
  const groups = useAgentGroups(orgId);
  const offline = useMemo(() => waitingComputerByAgent(outages.outages), [outages.outages]);
  // At work by its work for me, also where I don't read (the web's sidebar counts those too).
  const statuses = useAgentStatuses(orgId).data;
  const atWork = useMemo(
    () =>
      new Map(
        (statuses ?? []).flatMap((s) =>
          s.work?.state === "working" && !s.work.routine ? [[s.agentId, s.work.since] as const] : [],
        ),
      ),
    [statuses],
  );
  const agents = useMemo(() => dir.agents.filter((a) => listsAgent(org, a)), [dir.agents, org]);
  // The same lines while nothing they come from changes: the rows below are memoized on what each line holds.
  const { waiting, working, free } = useMemo(
    () => teamLines(agents, work, dms.data ?? [], asking, offline, atWork),
    [agents, work, dms.data, asking, offline, atWork],
  );
  const busy = waiting.length + working.length;
  // A routine's run works in the background, in no conversation (never "Trabalhando"): the agent is out on it.
  const onRoutine = useMemo(() => {
    const out = new Map<string, string>();
    for (const r of runs.data ?? []) {
      if (!r.background) continue;
      const at = r.startedAt ?? r.createdAt;
      const before = out.get(r.agentId);
      if (!before || at < before) out.set(r.agentId, at);
    }
    return out;
  }, [runs.data]);
  // Rows in the order they show, so the others know which way to look at a newcomer.
  const pins = usePins();
  const order = useMemo(
    () => [
      ...waiting.map((l) => l.agent.id),
      ...working.map((l) => l.agent.id),
      ...freeSections(free, groups.data ?? [], pins.pins.agents).flatMap((s) => s.lines.map((l) => l.agent.id)),
    ],
    [waiting, working, free, groups.data, pins.pins.agents],
  );
  // Beside the list (ADR 0212) the first agent's page shows while none is chosen; before the frame is shown, so the
  // pane doesn't say "nothing open" first.
  const opener = useAgentOpener();
  const firstId = order[0] ?? null;
  useLayoutEffect(() => {
    if (opener) agentSplit.offer(opener.orgId, firstId);
  }, [opener, firstId]);
  const greeting = useGreeting(order);
  const gazeOf = (id: string): Gaze | undefined => {
    if (!greeting || id === greeting) return undefined;
    return order.indexOf(id) < order.indexOf(greeting) ? "down" : "up";
  };
  // Each agent's presence, AI and work for me, read once here for every row and handed down as plain values: a row
  // draws again only when its own change.
  const presence = usePresenceOf();
  const ai = useAiStatus(orgId).data;
  // On a billing hold an AI comes after the plan: no "Sem IA" on a team just made.
  const held = usePlanHold(orgId, org) !== null;
  const channelNames = useChannelNames();
  const keptWork = useRef(new Map<string, WorkLine>());
  const rowOf = (l: TeamLine): RowProps => {
    const id = l.agent.id;
    const shown = presence.agent(id);
    // Its work for me, workspace-wide (ADR 0084 addendum): whom it helps or where, in the web lists' words; the line
    // of before while its words stay, so the row isn't drawn again for the clock alone.
    const line = workLine(
      t,
      i18n.language,
      shown?.work ?? null,
      { agentName: (x) => dir.agentById.get(x)?.name, channelName: (x) => channelNameIn(channelNames, x) },
      now,
    );
    const before = keptWork.current.get(id);
    const kept = line && before && sameWorkLine(before, line) ? before : line;
    if (kept) keptWork.current.set(id, kept);
    else keptWork.current.delete(id);
    const worksForMe = shown?.work?.state === "working" && !shown.work.routine;
    const routine = onRoutine.get(id);
    // Only a row that says how long (it asks, works or is out on a routine) follows the clock; the rest stay drawn.
    const ticks = l.approval !== null || l.work !== null || worksForMe || routine !== undefined;
    return {
      ...lineProps(l),
      atWork: worksForMe,
      aiMissing: !held && aiStateOf(ai, id) === "no_ai",
      outOfOffice: isOutOfOffice(shown?.status?.status),
      statusText: shown?.line?.text ?? null,
      workLine: kept,
      routine,
      now: ticks ? now : 0,
    };
  };
  const pull = usePullRefresh(() =>
    Promise.allSettled([
      directory.refetch(),
      runs.refetch(),
      dms.refetch(),
      approvals.refetch(),
      outages.refetch(),
      groups.refetch(),
    ]),
  );
  const total = agents.length;
  // The team's first load: its rows arrive over the stand-ins (a refetch plays nothing).
  const load = useFirstLoad(dir.loading);
  // Archived agents have no profile: who manages each one brings it back, or deletes it for good (ADR 0082), from here;
  // the server's `canManage` on it (ADR 0085 addendum of 2026-11-17), so someone's private agent stays out of reach.
  const archived = (useFormerAgents(orgId).data ?? []).filter((a) => a.canManage === true && !a.deleted);
  const restore = useUnarchiveAgent(orgId);
  const toast = useToast();
  const c = useColors();
  const restoreOne = (a: (typeof archived)[number]) =>
    restore.mutate(a.id, {
      onSuccess: () => {
        successHaptic();
        toast({ title: t("team.restored", agentGrammar(a.name)), icon: "check" });
      },
      onError: (error) => toast({ title: errorText(t, error), icon: "x" }),
    });
  const archivedActions = (a: (typeof archived)[number]) =>
    chooseAction(
      a.name,
      [
        { icon: "undo", label: t("team.restore"), onPress: () => restoreOne(a) },
        {
          icon: "trash",
          label: t("agentPage.delete.button"),
          destructive: true,
          onPress: () => openAgentDelete(a.id),
        },
      ],
      t("common.cancel"),
    );
  // A server without the task manager shows no way into it.
  const tasks = useTasksToday({ pollMs: TASKS_POLL_MS });
  const showsManager = total > 0 && !(tasks.isError && !tasks.data);
  // The bar's "+" does what the empty page's button does: a new agent, never the generic New.
  const creates = mayCreate(org, "agent");
  const actions: HeaderAction[] = creates
    ? [{ icon: "plus", sf: "plus", label: t("mobile.agents.create"), onPress: () => router.push("/new-agent") }]
    : header.actions;
  return (
    <LargeTitleScreen title={t("mobile.agents.title")} left={header.left} actions={actions} pull={pull}>
      {/* The rows' shape while the team loads, fading away over the rows as they come in one after the other; a team
          that didn't load is not an empty one. */}
      {load.skeleton ? (
        <SkeletonOver leaving={load.landing}>
          <SkeletonList rows={4} />
        </SkeletonOver>
      ) : null}
      {dir.loading ? null : directory.isError && !directory.data ? (
        <LoadFailed onRetry={() => void directory.refetch()} />
      ) : dir.agents.length === 0 ? (
        <FirstUse
          place="agents"
          acts={mayCreate(org, "agent")}
          label={t("mobile.homeNow.first.create")}
          onPress={() => router.push("/new-agent")}
        />
      ) : total === 0 ? (
        <FirstUse place="agentsForYou" acts={false} />
      ) : null}
      {showsManager ? (
        <LandRow land={load.landing}>
          <ManagerRow working={working.length} waiting={waiting.length} onPress={() => router.push("/task-manager")} />
        </LandRow>
      ) : null}
      {/* Equipe's org chart and channels (ADR 0148). A personal workspace (ADR 0159) keeps it as the last row of You ›
          Work: one person's agents rarely need an org chart in sight. */}
      {total > 0 && !isPersonal(org) ? (
        <LandRow land={load.landing} index={1}>
          <TeamEntry divider={showsManager} />
        </LandRow>
      ) : null}
      <LayoutAnimationConfig skipEntering>
        {waiting.length > 0 ? (
          <>
            <SectionHeader title={t("mobile.intentAgents.waitingSection")} count={waiting.length} />
            {waiting.map((l, i) => (
              <LandRow key={l.agent.id} land={load.landing} index={LEAD_ROWS + i}>
                <AgentRow {...rowOf(l)} divider={i > 0} live={i < LIVE_ROWS} gaze={gazeOf(l.agent.id)} />
              </LandRow>
            ))}
          </>
        ) : null}
        {working.length > 0 ? (
          <>
            <SectionHeader title={t("mobile.agents.workingSection")} count={working.length} />
            {working.map((l, i) => (
              <LandRow key={l.agent.id} land={load.landing} index={LEAD_ROWS + waiting.length + i}>
                <AgentRow
                  {...rowOf(l)}
                  divider={i > 0}
                  live={waiting.length + i < LIVE_ROWS}
                  gaze={gazeOf(l.agent.id)}
                />
              </LandRow>
            ))}
          </>
        ) : null}
        {free.length > 0 && !groups.isPending ? (
          <FreeSections
            free={free}
            groups={groups.data ?? []}
            pinned={pins.pins.agents}
            before={busy}
            greeting={greeting}
            gazeOf={gazeOf}
            rowOf={rowOf}
            land={load.landing}
            landFrom={LEAD_ROWS}
          />
        ) : null}
        {archived.length > 0 ? (
          // Under the departments: it travels with them when one closes or opens.
          <LandRow moves>
            <SectionHeader title={t("team.archived")} count={archived.length} />
            {archived.map((a, i) => (
              <SwipeRow
                key={a.id}
                left={{
                  label: t("team.restore"),
                  icon: "undo",
                  color: c.agent,
                  ink: c.onAgent,
                  onAction: () => restoreOne(a),
                }}
              >
                {/* The swipe's pane shows under the row, so the row is opaque. */}
                <View style={{ backgroundColor: c.bg }}>
                  <ListRow
                    onPress={() => archivedActions(a)}
                    accessibilityRole="button"
                    accessibilityLabel={[a.name, t("mobile.agents.state.archived")].join(", ")}
                    accessibilityActions={[{ name: "restore", label: t("team.restore") }]}
                    onAccessibilityAction={() => restoreOne(a)}
                    divider={i > 0}
                    leading={<AgentFace agentId={a.id} size={52} mode="rest" live={false} />}
                    title={a.name}
                    sub={
                      <Text variant="small" tone="faint" numberOfLines={1} style={LIST_PREVIEW}>
                        {t("mobile.agents.state.archived")}
                      </Text>
                    }
                  />
                </View>
              </SwipeRow>
            ))}
          </LandRow>
        ) : null}
      </LayoutAnimationConfig>
    </LargeTitleScreen>
  );
}

/**
 * The task manager's row, fixed under the title: its tile, its name and how the team stands now ("1 trabalhando ·
 * 1 espera você"), a chevron since it opens a screen. The row highlights as the system's lists do.
 */
function ManagerRow({ working, waiting, onPress }: { working: number; waiting: number; onPress: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const line =
    [
      working > 0 ? t("taskManager.working", { count: working }) : null,
      waiting > 0 ? t("taskManager.waiting", { count: waiting }) : null,
    ]
      .filter(Boolean)
      .join(" · ") || t("mobile.agents.managerQuiet");
  return (
    <ListRow
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[t("taskManager.title"), line].join(", ")}
      leading={<Tile icon="list" size={52} />}
      title={t("taskManager.title")}
      sub={
        <Text variant="small" style={[LIST_PREVIEW, { color: waiting > 0 ? c.amber : c.muted }]} numberOfLines={1}>
          {line}
        </Text>
      }
      subLines={1}
      chevron
    />
  );
}

/**
 * The free agents: "Equipe" (the ones in no department, "Sem setor" once there are departments), then each
 * department, which collapses (remembered on this phone, for every workspace). Mounted once the groups are in, so
 * the team doesn't show whole and then split.
 */
function FreeSections({
  free,
  groups,
  pinned,
  before,
  greeting,
  gazeOf,
  rowOf,
  land,
  landFrom,
}: {
  free: TeamLine[];
  groups: AgentGroup[];
  /** The agents pinned on top ("Fixar no topo"), the screen's `usePins`. */
  pinned: string[];
  before: number;
  greeting: string | null;
  gazeOf: (id: string) => Gaze | undefined;
  /** A row's props from its line, as the screen reads them for every row. */
  rowOf: (l: TeamLine) => RowProps;
  /** The list's first load: the rows arrive (`LandRow`), counted from `landFrom` plus the rows before them. */
  land: boolean;
  landFrom: number;
}) {
  const { t } = useTranslation();
  // A personal workspace's free agents are its person's, not a team (ADR 0159).
  const { org } = useOrg();
  const { collapsed, toggle } = useCollapsedSections<string>(STORED.agentGroupsCollapsed, null);
  const sectorMenu = useSectorMenu();
  const manages = can(org, "manage_agents");
  let shown = before;
  return (
    <>
      {freeSections(free, groups, pinned).map(({ group, lines, pinnedCount }) => {
        const first = shown;
        shown += lines.length;
        const rows = lines.map((l, i) => (
          <LandRow key={l.agent.id} land={land} index={landFrom + first + i}>
            <AgentRow
              {...rowOf(l)}
              divider={i > 0}
              // The newcomer and the ones looking at it move while it arrives, wherever they sit in the list.
              live={first + i < LIVE_ROWS || greeting !== null}
              pinned={i < pinnedCount}
              arriving={greeting === l.agent.id}
              gaze={gazeOf(l.agent.id)}
            />
          </LandRow>
        ));
        return group ? (
          <CollapsibleSection
            key={group.id}
            title={group.name}
            count={lines.length}
            collapsed={collapsed.includes(group.id)}
            onToggle={() => toggle(group.id)}
            {...(manages
              ? { menu: { label: t("agentGroups.options", { name: group.name }), onPress: () => sectorMenu(group) } }
              : {})}
          >
            {rows}
          </CollapsibleSection>
        ) : (
          <Fragment key="free">
            <SectionHeader
              title={
                groups.length > 0 ? t("mobile.agents.noGroupSection") : t(modeKey(org, "mobile.agents.teamSection"))
              }
              count={lines.length}
            />
            {rows}
          </Fragment>
        );
      })}
    </>
  );
}

/** What a row's second line says, so a change of state crosses over in place (the key) while the row stays. */
type RowState = "asks" | "works" | "routine" | "away" | "noAi" | "out" | "waits" | "free";

/**
 * What a row shows of its line (`TeamLine`), as values a memoized row compares one by one: the agent, its work and a
 * preview's meta are the queries' own objects, the same until they change; the rest are plain values. A line built
 * again with the same contents re-renders no row.
 */
interface RowLine {
  agent: Agent;
  work: TeamLine["work"];
  /** The request it asks you first, when it waits on you. */
  approvalTitle: string | null;
  waitingCount: number;
  at: string | null;
  preview: string | null;
  previewMeta: TeamLine["previewMeta"];
  previewMedia: TeamLine["previewMedia"];
  computer: string | undefined;
}

const lineProps = (l: TeamLine): RowLine => ({
  agent: l.agent,
  work: l.work,
  approvalTitle: l.approval ? l.approval.title : null,
  waitingCount: l.waitingCount,
  at: l.at,
  preview: l.preview,
  previewMeta: l.previewMeta,
  previewMedia: l.previewMedia,
  computer: l.computer,
});

/** What a row shows of its agent's presence (`usePresenceOf`) and its work for me, as the screen reads them. */
interface RowPresence {
  /** At work for me, also where I don't read: its face is at work, so is its row. */
  atWork: boolean;
  /** No AI to think with (never on a billing hold: an AI comes after the plan). */
  aiMissing: boolean;
  /** Out of office (its plan or budget ran out, ADR 0084): its line says when it is back. */
  outOfOffice: boolean;
  /** Its line in words; null: none. */
  statusText: string | null;
  /** Its work for me, workspace-wide, in the web lists' words (`workLine`); null: none. */
  workLine: WorkLine | null;
}

/** A row's props from its line, as the screen reads them for every row (`rowOf`). */
interface RowProps extends RowLine, RowPresence {
  /** Since when it is out on a routine (its background run), when it is. */
  routine: string | undefined;
  /** The screen's clock, one for every row; 0 for a row that says no time (it isn't drawn again for it). */
  now: number;
}

const sameWorkLine = (a: WorkLine, b: WorkLine) =>
  a.text === b.text && a.short === b.short && a.time === b.time && a.tone === b.tone;

/**
 * One agent: its living body at 52 (running at work, asleep when it can't work), its name, the time at the right
 * (how long since it asked or started; when you last talked, free), then its state as text: what waits on you in
 * amber, what it is on with the orbit, its computer away or no AI in the quiet color, what its work waits on (the
 * clock, or amber for your answer) with how long, else its role in plain words. Pinned ones come first, with no mark.
 */
const AgentRow = memo(function AgentRow({
  agent: a,
  work: w,
  approvalTitle,
  waitingCount,
  at,
  preview,
  previewMeta,
  previewMedia,
  computer,
  atWork,
  aiMissing,
  outOfOffice,
  statusText,
  workLine: work,
  now,
  divider,
  live,
  pinned = false,
  arriving = false,
  gaze,
  routine,
}: RowProps & {
  divider: boolean;
  live: boolean;
  /** On top of the free ones ("Fixar no topo"): said to screen readers; the order shows it. */
  pinned?: boolean;
  /** Just created on this phone: its row comes in once, the others looking at it. */
  arriving?: boolean;
  /** Where its face looks while a newcomer arrives (up or down at the newcomer's row). */
  gaze?: Gaze | undefined;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const reduced = useReducedMotion();
  // Beside the list (ADR 0212) a press opens its page there, and the row stays lit while that page shows.
  const opener = useAgentOpener();
  const chosen = agentSplit.useIsShown(opener?.orgId ?? null, a.id);
  const approval = approvalTitle !== null;
  // At work also where I don't read: its face is at work, so is its row.
  const works = Boolean(w) || atWork;
  const onRoutineNow = !approval && !works && routine !== undefined;
  const noAi = !approval && !works && !onRoutineNow && computer === undefined && aiMissing;
  // Out of office (its plan or budget ran out, ADR 0084): the server's line says when it is back.
  const out = !approval && !works && !onRoutineNow && computer === undefined && !noAi && outOfOffice;
  // Its work waits (on someone's approval or answer, its computer, in line) or asks me: said in its role's place.
  const waits = work && work.tone !== "working" ? work : null;
  const busy = approval || works;
  const state: RowState = approval
    ? "asks"
    : works
      ? "works"
      : onRoutineNow
        ? "routine"
        : computer !== undefined
          ? "away"
          : noAi
            ? "noAi"
            : out
              ? "out"
              : waits
                ? "waits"
                : "free";
  // One meta per row: how long since it asked or started; a free agent's row needs none.
  const time = at && busy ? agoShort(t, agoOf(at, now)) : null;
  const entrance = useArrival(arriving, reduced);
  const role =
    plainRole(a.instructions) ??
    (a.role.trim() ||
      (preview || previewMedia ? previewBody(t, preview ?? "", previewMeta ?? null, previewMedia) : ""));
  const asks =
    approvalTitle !== null
      ? waitingCount > 1
        ? t("mobile.intentAgents.waitingMore", { title: approvalTitle, count: waitingCount - 1 })
        : approvalTitle
      : "";
  const said =
    state === "asks"
      ? t("mobile.intentAgents.waitingLabel", { name: a.name })
      : state === "works"
        ? t("mobile.agents.workingLabel", { name: a.name })
        : state === "away"
          ? t("mobile.outage.rowWaitingLabel", { name: a.name, computer })
          : state === "routine"
            ? [a.name, t("mobile.agents.state.routineShort")].join(", ")
            : a.name;
  const sub = (
    <Animated.View key={state} entering={reduced ? undefined : STATE_IN} style={styles.state}>
      {state === "asks" ? (
        <Text variant="small" tone="ink2" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          <Text variant="small" style={[LIST_PREVIEW, styles.medium, { color: c.amber }]}>
            {t("mobile.agents.state.waitsYou")}
          </Text>
          {` · ${asks}`}
        </Text>
      ) : state === "works" ? (
        <>
          <PixelOrbit color={agentLook(a).color} size={16} />
          <Text variant="small" tone="ink2" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
            {work?.tone === "working" || !w ? work?.text : (statusText ?? workTitle(t, w))}
          </Text>
        </>
      ) : state === "waits" && waits ? (
        <>
          {waits.tone === "neutral" ? (
            <LineIcon name="clock" size={15} color={c.faint} variant="small" text={LIST_PREVIEW} />
          ) : null}
          <Text variant="small" tone="muted" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
            <Text
              variant="small"
              tone="muted"
              style={[LIST_PREVIEW, styles.medium, waits.tone === "you" ? { color: c.amber } : null]}
            >
              {waits.text}
            </Text>
            {waits.time ? ` · ${waits.time}` : ""}
          </Text>
        </>
      ) : state === "routine" && routine ? (
        <Text variant="small" tone="faint" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          {t("mobile.agents.state.routine", { time: agoShort(t, agoOf(routine, now)) })}
        </Text>
      ) : state === "away" ? (
        <Text variant="small" tone="faint" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          {t("mobile.outage.rowWaiting", { computer })}
        </Text>
      ) : state === "noAi" ? (
        <Text variant="small" tone="faint" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          {t("mobile.agents.state.noAi")}
          {" · "}
          <Text variant="small" tone="ink2" style={[LIST_PREVIEW, styles.semibold]}>
            {t("mobile.agents.state.connect")}
          </Text>
        </Text>
      ) : state === "out" && statusText !== null ? (
        <Text variant="small" tone="faint" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          {statusText}
        </Text>
      ) : role ? (
        <Text variant="small" tone="muted" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          {role}
        </Text>
      ) : null}
    </Animated.View>
  );
  return (
    // Only the newcomer's row carries a style; the rest stay plain views.
    <Animated.View style={arriving ? entrance : undefined}>
      <ListRow
        onPress={() => (opener ? opener.open(a.id) : router.push(`/agent/${a.id}`))}
        opens={!opener}
        {...(chosen ? { background: withAlpha(c.ink, CHOSEN_TINT), accessibilityState: { selected: true } } : {})}
        accessibilityRole="button"
        accessibilityLabel={[
          said,
          pinned ? t("sidebarPins.pinned") : null,
          a.role.trim() || null,
          time,
          state === "waits" && waits ? workLineText(waits) : state === "away" ? null : role,
        ]
          .filter(Boolean)
          .join(", ")}
        divider={divider}
        leading={
          state === "routine" ? (
            // Out on its routine: the frame keeps its sky and waits for it.
            <AgentFace agentId={a.id} size={52} live={false} bodyless />
          ) : (
            <Animated.View key="here" entering={reduced ? undefined : FACE_IN}>
              <AgentFace
                agentId={a.id}
                size={52}
                mode={
                  state === "works" ? "run" : state === "away" || state === "noAi" || state === "out" ? "rest" : "idle"
                }
                live={live}
                gaze={gaze}
                {...(arriving ? { expression: "happy" as const } : {})}
              />
            </Animated.View>
          )
        }
        title={a.name}
        time={time}
        // An agent with no role and nothing on has no second line, never an empty one.
        sub={(state === "free" || (state === "out" && statusText === null)) && !role ? null : sub}
      />
    </Animated.View>
  );
});

/**
 * The agent just created here, while Agentes is on screen: it is greeted once (its row comes in, the others look at it
 * for `ARRIVAL_LOOK_MS`), then the list is the list again. Null when there is no one to greet.
 */
function useGreeting(order: readonly string[]): string | null {
  const arrived = useArrived();
  const focused = useIsFocused();
  const [greeting, setGreeting] = useState<string | null>(null);
  const listed = arrived !== null && order.includes(arrived);
  useEffect(() => {
    if (!focused || !listed || !arrived) return;
    clearArrived(arrived);
    setGreeting(arrived);
  }, [focused, listed, arrived]);
  useEffect(() => {
    if (!greeting) return;
    const done = setTimeout(() => setGreeting(null), ARRIVAL_LOOK_MS);
    return () => clearTimeout(done);
  }, [greeting]);
  return greeting;
}

/**
 * A newcomer's row coming in: from a little below and a touch small, settling on a spring without overshoot (a rare
 * moment, but no finger threw it: nothing to bounce from). Reduced motion: it only fades in. Every other row: no style
 * at all.
 */
function useArrival(arriving: boolean, reduced: boolean) {
  const shown = useSharedValue(1);
  useEffect(() => {
    if (!arriving) return;
    shown.set(0);
    shown.set(
      reduced ? withTiming(1, { duration: 200 }) : withDelay(120, withSpring(1, { duration: 400, dampingRatio: 1 })),
    );
  }, [arriving, reduced, shown]);
  return useAnimatedStyle(() => {
    const v = shown.get();
    return reduced
      ? { opacity: v }
      : {
          opacity: Math.min(1, v * 1.6),
          transform: [{ translateY: (1 - v) * 16 }, { scale: 0.96 + 0.04 * v }],
        };
  });
}

const styles = StyleSheet.create({
  // The orbit sits on the line's left, 8 before the words, as the state's mark.
  state: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
  medium: { fontWeight: weights.medium },
  semibold: { fontWeight: weights.semibold },
  shrink: { flexShrink: 1 },
});
