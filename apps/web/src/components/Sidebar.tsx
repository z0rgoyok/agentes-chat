import type {
  Agent,
  ApiClient,
  Availability,
  Channel,
  Member,
  SidebarSection as SectionKey,
  SidebarChannelSection,
  SidebarDmShow,
  SidebarItem,
} from "@agenteschat/client";
import {
  agentStateIn,
  agentWorkingIn,
  MISSIONS_WAITING_COUNT,
  runningAgents,
  useAgentStatuses,
  useAiAccounts,
  useAllInvitations,
  useArchivedChannels,
  useAuthConfig,
  useChannels,
  useConnections,
  useDms,
  useMachineOutages,
  useMissionList,
  useNotificationCount,
  useOverview,
  usePrefetchMessages,
  usePrefetchRecent,
  useSetSidebarView,
  useSidebarItems,
  useSidebarView,
  useSkills,
  useTasksUnread,
  useUnreadThreads,
} from "@agenteschat/client";
import { ownsAgentAs } from "@agenteschat/client/lib/agent-owner";
import { WORK_TICK_MS, workLine } from "@agenteschat/client/lib/agent-work";
import {
  audienceChip,
  audienceNames,
  audienceNotice,
  canTalk,
  hiddenAgentIds,
  listsAllAgents,
  managesAgent,
  opensDm,
} from "@agenteschat/client/lib/audience";
import { workspaceNotes } from "@agenteschat/client/lib/deletion";
import { ErrorBoundary } from "@agenteschat/client/lib/error-boundary";
import { formatTime, upperFirst } from "@agenteschat/client/lib/format";
import { waitingAgents } from "@agenteschat/client/lib/outages";
import { can, makesAgents, managesChannel } from "@agenteschat/client/lib/permissions";
import {
  AVAILABILITIES,
  agentFaceWord,
  isOutOfOffice,
  presenceOfAvailability,
  statusEndNote,
} from "@agenteschat/client/lib/presence";
import { type DmListed, dmList } from "@agenteschat/client/lib/recent";
import { isRightHand, rightHandSeenKey } from "@agenteschat/client/lib/right-hand";
import { SERVER_PLACE_ICON } from "@agenteschat/client/lib/server";
import { inSidebarList, offeredTools, sidebarItemOrder, sidebarPlace } from "@agenteschat/client/lib/sidebar-items";
import {
  addSection,
  moveChannelBy,
  moveSectionBy,
  placeInSection,
  removeSection,
  renameSection,
  SIDEBAR_SECTION_NAME_MAX,
  sectionOfChannel,
  sortAgents,
  splitPinned,
} from "@agenteschat/client/lib/sidebar-view";
import { badgeCount, looksUnread } from "@agenteschat/client/lib/unread";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  Avatar,
  Button,
  CountBadge,
  CountChip,
  cx,
  Icon,
  type IconName,
  Kbd,
  Menu,
  MenuCheckboxItem,
  MenuFace,
  MenuHeading,
  MenuItem,
  MenuOverlay,
  MenuOverlayGroup,
  MenuOverlayItem,
  MenuOverlaySeparator,
  MenuRadioGroup,
  MenuSeparator,
  MenuSub,
  modKey,
  OPEN_LAYER,
  OrbitGlyph,
  Popover,
  PresenceBadge,
  ProviderLogo,
  Skeleton,
  SkeletonGroup,
} from "@agenteschat/ui";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import {
  type DragEvent,
  Fragment,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useNewAgent } from "@/components/new-agent/new-agent-context";
import { useArrived } from "@/hooks/useArrived";
import { useDirectory } from "@/hooks/useDirectory";
import { useEverTrue } from "@/hooks/useEverTrue";
import { useInboxWaiting } from "@/hooks/useInboxWaiting";
import { agentLine, availabilityOf, personLine, useAgentPresence, usePersonPresence } from "@/hooks/usePresence";
import { useServerPlace } from "@/hooks/useServerPlace";
import { useSidebarFavorites } from "@/hooks/useSidebarPins";
import { useSignOut } from "@/hooks/useSignOut";
import { useUnreadTitle } from "@/hooks/useUnreadTitle";
import { useWorkspaceGroups } from "@/hooks/useWorkspaceGroups";
import { switchAccount } from "@/lib/accounts";
import { requestAgentPanel } from "@/lib/agent-panel-ask";
import { requestChannelDetails } from "@/lib/channel-details";
import type { MenuEntry } from "@/lib/context-menu";
import { onPhoneAsk, takePhoneAsk, thisMac } from "@/lib/desktop";
import { entityMenu } from "@/lib/entity-menu";
import { keysInTurn, moveStep } from "@/lib/keys";
import { lazyDialog } from "@/lib/lazy-dialog";
import { lookOf } from "@/lib/look";
import { navigateAway } from "@/lib/navigate";
import { useOpenParam } from "@/lib/open-param";
import { markOpen } from "@/lib/perf";
import { ownPlanLines, planNearLimit, planWord } from "@/lib/plan-usage";
import { useScrollEdges } from "@/lib/scroll-edges";
import { rightHandSeen, STORAGE_KEYS, sessionStore, storage, storedStrings } from "@/lib/storage";
import { useToast } from "@/lib/toast";
import { offersNewWorkspace, type WorkspaceGroup } from "@/lib/workspaces";
import type { SettingsSection } from "@/pages/settings-sections";
import { useStreams } from "@/realtime/context";
import { AgentAvatar } from "./AgentAvatar";
import { AgentWorkLine } from "./AgentWorkLine";
import { AgoraButton } from "./Agora";
import { ArchivedChannelsDialog } from "./ArchivedChannelsDialog";
import { FeedbackMark } from "./arrival/FeedbackDialog";
import { MenuEntries } from "./DesktopMenus";
import { useAgentMenu, useChannelMenu, usePersonMenu } from "./entity-menus";
import { GroupFace } from "./GroupFace";
import { useInviteDialog } from "./invite/InviteDialog";
import { arrivalProps, useArrivals } from "./lodi-cursor/arrivals";
import { useRowsDrawIn } from "./lodi-cursor/runner";
import { useNow } from "./missions/MissionBits";
import { COMPACT_QUERY, useMediaQuery, useNavDrawer } from "./NavDrawer";
import { NewChannelDialog } from "./NewChannelDialog";
import { useOrg } from "./org-context";
import { StatusLine } from "./Presence";
import { MyFace, OrgMark } from "./ProfilePhoto";
import { openPalette } from "./palette";
import { sectionName, useSectionOrder } from "./SidebarOrder";
import { SIDEBAR_TOOLS, SidebarSetupDialog, ToolList } from "./SidebarSetup";
import { MenuHorizon, SidebarHorizon, WorkspaceSky } from "./Sky";
import { SetStatusDialog, useSaveStatus } from "./StatusDialog";
import { closeTabletSidebar, NEW_CHANNEL_EVENT, TABLET_QUERY, useSidebarCollapsed } from "./sidebar-state";

// The account's dialogs come when one first opens: every workspace page holds the sidebar, and these bring the profile
// and avatar editors, the look of the chat and the sign-in pages.
const ProfileDialog = lazyDialog(() => import("./AccountSettings").then((m) => m.ProfileDialog));
const EmailDialog = lazyDialog(() => import("./AccountSettings").then((m) => m.EmailDialog));
const AddPasswordDialog = lazyDialog(() => import("./AddPassword").then((m) => m.AddPasswordDialog));
const ChangeAvatarDialog = lazyDialog(() => import("./AvatarBuilder").then((m) => m.ChangeAvatarDialog));
const DeleteAccountDialog = lazyDialog(() => import("./DeleteAccount").then((m) => m.DeleteAccountDialog));
const OpenOnPhoneDialog = lazyDialog(() => import("./OpenOnPhone").then((m) => m.OpenOnPhoneDialog));

/** Sidebar rows loading: an icon (or avatar) and a name bar, at the real row height. */
function SidebarSkeleton({ count, avatar, label }: { count: number; avatar?: boolean; label: string }) {
  return (
    <SkeletonGroup label={label}>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders
        <span key={i} className="sidebar__item sidebar__item--skeleton">
          <Skeleton shape={avatar ? "square" : "block"} width={avatar ? 28 : 16} height={avatar ? 28 : 16} />
          <Skeleton width={[96, 72, 112][i % 3]} />
        </span>
      ))}
    </SkeletonGroup>
  );
}

/** In place of an agent's or a person's row that failed to draw (`ErrorBoundary`): the rest of the sidebar works. */
function UnshownRow() {
  const { t } = useTranslation();
  return (
    <span className="sidebar__item sidebar__item--unshown" title={t("shell.unshown")}>
      <Icon name="alert" />
      <span className="sidebar__item-label">{t("shell.unshown")}</span>
    </span>
  );
}
export const unshownRow = () => <UnshownRow />;

/**
 * On the icon rail every channel would be the same "#": its initials instead ("eng-backend" → "Eb",
 * "general" → "Ge"), so the rail still reads which is which.
 */
export function channelInitials(name: string) {
  const words = name
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((w) => Array.from(w));
  const letters = (words.length > 1 ? [words[0]?.[0], words[1]?.[0]] : (words[0] ?? []).slice(0, 2)).join("");
  return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
}

/**
 * The workspace sidebar. A team's (ADR 0260) is a tool column at its left edge (Ir para…, Início, the tools in sight,
 * Mais; Agora and the collapse at its foot) and the familiar list beside it: Não lidas, Threads, Favoritos, Canais with the
 * person's own sections, Mensagens diretas with people and agents together. A personal workspace (ADR 0159) has the
 * person on top (their menu, the bell and the collapse beside it), Go to… as the list's first row and no foot; what
 * sits in sight changes, never what can be reached.
 */
export function Sidebar() {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const orgId = org.id;
  const personal = isPersonal(org);
  const dir = useDirectory(orgId);
  // No one else is a member (yet, or while the list loads): a personal workspace then lists no people and no #general.
  const alone = !dir.members.some((m) => m.userId !== me.user.id);
  const channels = useChannels(orgId);
  const overview = useOverview(orgId);
  const [creatingChannel, setCreatingChannel] = useState(false);
  // Archived channels this person may bring back: "Canais arquivados" in Canais' + while there are some.
  const archivedChannels = useArchivedChannels(orgId).data ?? [];
  const [showArchived, setShowArchived] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    const open = () => setCreatingChannel(true);
    window.addEventListener(NEW_CHANNEL_EVENT, open);
    return () => window.removeEventListener(NEW_CHANNEL_EVENT, open);
  }, []);
  // The inbox: bold while something in it is unread (live through `notification.counts`).
  const notificationCount = useNotificationCount(orgId).data;
  const unreadNotifications = notificationCount?.unread ?? 0;
  // Everything that waits on me (ADR 0218): Não lidas' count in a team's list, the inbox's in a personal one.
  const waitingOnMe = useInboxWaiting(orgId);
  // Threads: how many open missions wait for me (the server counts: a decision, a review, a suggestion…).
  const missionList = useMissionList(orgId, MISSIONS_WAITING_COUNT);
  const missionsWaiting = missionList.data?.counts.waitingYou ?? 0;
  // Tarefas: bold (a dot in the column) for a reply I haven't read in a task's conversation, red for a mention of me.
  const { unread: unreadTasks, mentions: taskMentions } = useTasksUnread(orgId);
  // …and whether a thread I follow has a reply I haven't read: the entry lights like an unread channel.
  const unreadThreads = useUnreadThreads(orgId).data ?? 0;
  // The tools, each where I put it (the rest in More); one there "when there's something" while its count is.
  const sidebarItems = useSidebarItems(orgId).data;
  const counts: Partial<Record<SidebarItem, number>> = {
    waiting: waitingOnMe,
    threads: missionsWaiting + unreadThreads,
  };
  // The mode's defaults and order (ADR 0159). Code only where it has anything for me (ADR 0215 §12). A team's column
  // holds every tool but the inbox and Threads, which Não lidas and Threads' row take in the list (ADR 0260).
  const toolOrder = offeredTools(sidebarItemOrder(personal), overview.data?.code, sidebarItems).filter(
    (id) => personal || (id !== "waiting" && id !== "threads"),
  );
  const listed = toolOrder.filter((id) => inSidebarList(sidebarPlace(sidebarItems, id, personal), counts[id] ?? 0));
  const inMore = toolOrder.filter((id) => !listed.includes(id));
  const countOf = (id: SidebarItem) =>
    id === "waiting" && waitingOnMe > 0 ? (
      <CountBadge aria-label={t("notifications.summaryWaiting", { count: waitingOnMe })}>
        {badgeCount(waitingOnMe)}
      </CountBadge>
    ) : id === "threads" && missionsWaiting > 0 ? (
      // Missões is a tab of Threads: the missions waiting for me as a neutral count.
      <CountChip
        className="sidebar__count"
        role="img"
        aria-label={t("shell.missionsWaiting", { count: missionsWaiting })}
      >
        {missionsWaiting}
      </CountChip>
    ) : id === "issues" && taskMentions > 0 ? (
      <UnreadCount count={taskMentions} mentions />
    ) : null;
  // The name is on the row: only the rail, which hides it, says it on hover.
  const railTip = (id: SidebarItem | "home") => (rail ? t(`shell.${id}`) : undefined);
  const toolRow = (id: SidebarItem) => (
    <Link
      key={id}
      to={SIDEBAR_TOOLS[id].to}
      params={{ orgId }}
      className="sidebar__item"
      title={id === "threads" && unreadThreads > 0 ? t("shell.unreadThreads", { count: unreadThreads }) : railTip(id)}
      data-unread={
        (id === "waiting" && unreadNotifications > 0) ||
        (id === "threads" && unreadThreads > 0) ||
        (id === "issues" && unreadTasks > 0)
      }
    >
      <Icon name={SIDEBAR_TOOLS[id].icon} />
      <span className="sidebar__item-label">{t(`shell.${id}`)}</span>
      {countOf(id)}
    </Link>
  );
  // A tile of the column: its name in the tip, a dot for what is unread (ink) or for me (red), said in its label.
  const dotOf = (id: SidebarItem): "you" | "unread" | undefined =>
    (id === "issues" && taskMentions > 0) || (id === "waiting" && waitingOnMe > 0)
      ? "you"
      : (id === "issues" && unreadTasks > 0) || (id === "waiting" && unreadNotifications > 0)
        ? "unread"
        : undefined;
  const toolTile = (id: SidebarItem) => {
    const dot = dotOf(id);
    const name = t(`shell.${id}`);
    return (
      <Link
        key={id}
        to={SIDEBAR_TOOLS[id].to}
        params={{ orgId }}
        className="sidebar__tile"
        aria-label={dot ? t(`sidebarColumn.${dot}`, { name }) : name}
        data-dot={dot}
      >
        <Icon name={SIDEBAR_TOOLS[id].icon} />
      </Link>
    );
  };
  // Agents waiting for an offline computer: "esperando" instead of anything "working".
  const outages = useMachineOutages(orgId);
  const waitingFor = useMemo(() => waitingAgents(outages.data), [outages.data]);
  // The agents' presence and lines (ADR 0084): the one place that polls them; every face reads the same list. Their
  // work for me, workspace-wide (the addendum of 2026-11-13): who works and who waits, wherever it runs.
  const agentStatuses = useAgentStatuses(orgId).data;
  const workKey = (agentStatuses ?? [])
    .flatMap((s) => (s.work ? [`${s.agentId}:${s.work.state}`] : []))
    .sort()
    .join();
  // The tab's title: "(3) agentes.chat", what the sidebar's numbers add up to (agents it doesn't list left out).
  const hiddenAgents = useMemo(() => hiddenAgentIds(org, dir.agents), [org, dir.agents]);
  useUnreadTitle(orgId, hiddenAgents);
  const dms = useDms(orgId);
  const dmChannels = new Set((dms.data ?? []).map((d) => d.channelId));
  // Hover or focus loads the conversation before the click.
  const prefetch = usePrefetchMessages(orgId);
  // …and the unread and latest ones as soon as the workspace opens.
  usePrefetchRecent(orgId);
  // The right hand (ADR 0137): the first of the agents; outside its audience, none.
  const rightHand = dir.agents.find((a) => isRightHand(a) && a.canTalk !== false);
  const dmOf = new Map((dms.data ?? []).map((d) => [d.with.id, d]));
  const rightHandDm = rightHand ? dmOf.get(rightHand.id) : undefined;
  // New agent: one dialog for every way in (ADR 0164); outside the shell (a test's page), the full form.
  const newAgentDialog = useNewAgent();
  const newAgent = () =>
    newAgentDialog ? newAgentDialog.open() : void navigate({ to: "/org/$orgId/agents/new", params: { orgId } });
  const invite = useInviteDialog();
  const sections = useSidebarSections(me.user.id, orgId);
  // Favoritos (ADR 0260): their own part in a team's list; on top of their own lists in a personal workspace.
  const favorites = useSidebarFavorites();
  const { view, setView, pins } = favorites;

  // Who works now: a run this tab hears, or the agents' list (work handed off in two agents' DM too). Who waits on
  // someone or is in line.
  const busyKey = useStreams((st) => [...runningAgents(st)].sort().join());
  const { busy, waits } = useMemo(() => {
    const work = workKey ? workKey.split(",").map((w) => w.split(":") as [string, string]) : [];
    return {
      busy: new Set([
        ...(busyKey ? busyKey.split(",") : []),
        ...work.flatMap(([id, s]) => (s === "working" ? [id] : [])),
      ]),
      waits: new Set(work.flatMap(([id, s]) => (s === "working" ? [] : [id]))),
    };
  }, [busyKey, workKey]);
  // How many of the workspace's agents are working now: the sky at the bottom rises with it.
  const working = dir.agents.filter((a) => busy.has(a.id)).length;
  // Narrow screens: the sidebar is a drawer (id, open state, close on link / swipe).
  const drawer = useNavDrawer();
  // Desktop: the person can shrink the sidebar to its column (a personal workspace's: an icon rail), remembered.
  // Tablets start shrunk and open over the page (`float`).
  const compact = useMediaQuery(COMPACT_QUERY);
  const tablet = useMediaQuery(TABLET_QUERY);
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  const rail = !compact && collapsed;
  const float = tablet && !collapsed;

  // The agents that talk to me (who manages agents may list the rest): each row opens its DM, so "the rest" are the
  // agents whose DM opens for me (`opensDm`), never someone's private agent the key doesn't reach (ADR 0085 addendum
  // of 2026-11-17), which Team still lists. Sectors stay on Equipe (ADR 0260).
  const manages = can(org, "manage_agents");
  const team = dir.agents.filter((a) => !isRightHand(a));
  const arrivedAgents = useArrived(
    team.map((a) => a.id),
    !dir.loading,
  );
  const shownAgents = team.filter((a) => canTalk(a) || (manages && view.showAllAgents && opensDm(a)));
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const quietGeneral = (c: Channel) =>
    c.name === "general" && !looksUnread(c) && !c.mentionCount && !pathname.endsWith(`/c/${c.id}`);
  // The channels the sidebar lists. A personal workspace (ADR 0159) leaves out #general while no one else is in it
  // (unless it is open or something new waits there).
  const listedChannels = (channels.data ?? []).filter(
    (c) => !dmChannels.has(c.id) && !(personal && alone && quietGeneral(c)),
  );
  const isFavorite = (kind: "agent" | "channel" | "person", id: string) => !personal && favorites.isFavorite(kind, id);
  const channelRows = useChannelSections({
    channels: listedChannels.filter((c) => !isFavorite("channel", c.id)),
    loading: channels.isLoading,
    // A personal workspace keeps its favorite conversations on top of its list (ADR 0159), with no sections.
    pinned: personal ? pins.channels : [],
    onPrefetch: prefetch,
  });
  const agentRow = (a: Agent, opts: { line?: boolean; move?: HTMLAttributes<HTMLAnchorElement> } = {}) => {
    const dm = dmOf.get(a.id);
    const unread = dm?.unread ?? 0;
    return (
      <ErrorBoundary
        key={a.id}
        resetKey={a}
        fallback={() => (
          <div className="sidebar__row" data-agent-row={a.id}>
            <UnshownRow />
          </div>
        )}
      >
        <AgentRow
          agent={a}
          arrival={arrivalProps(arrivedAgents, a.id)}
          unread={unread}
          waitingFor={waitingFor.get(a.id)}
          live={busy.has(a.id) || waits.has(a.id) || waitingFor.has(a.id) || unread > 0}
          pinned={personal && pins.agents.includes(a.id)}
          oneLine={opts.line}
          onPrefetch={() => dm && prefetch(dm.channelId)}
          onOpen={() => markOpen(dm?.channelId ?? a.id)}
          drag={opts.move}
        />
      </ErrorBoundary>
    );
  };
  const personRow = (m: Member, move?: HTMLAttributes<HTMLAnchorElement>) => {
    const dm = dmOf.get(m.userId);
    return (
      <ErrorBoundary key={m.userId} resetKey={m} fallback={unshownRow}>
        <PersonRow
          member={m}
          unread={dm?.unread ?? 0}
          onPrefetch={() => dm && prefetch(dm.channelId)}
          onOpen={() => markOpen(dm?.channelId ?? m.userId)}
          rowProps={move}
        />
      </ErrorBoundary>
    );
  };
  // Only the middle scrolls: the workspace card on top and the foot stay put. The active item paints its own
  // background (no sliding pill).
  const navRef = useRef<HTMLDivElement>(null);
  useRowsDrawIn(navRef);
  // The list fades out at an edge only while there is more to scroll past it (no hard cut); re-checked as lists load.
  useScrollEdges(navRef, [channels.data, dms.data, shownAgents.length, dir.members.length, rail]);

  // A tablet's open sidebar folds back on a new page, a width change, Esc (before the page sees it: Esc in a channel
  // would stop an agent; an open menu closes first), a press outside it and focus leaving it (Tab past its end would
  // land on the page under it).
  const sideRef = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page or width closes it
  useEffect(() => closeTabletSidebar(), [pathname, tablet]);
  useEffect(() => {
    if (!float) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector(OPEN_LAYER)) return;
      e.preventDefault();
      // Focus on a row the rail hides would be lost: back to the toggle (the title bar's, in the Mac app).
      if (sideRef.current?.contains(document.activeElement)) {
        document.querySelector<HTMLElement>("[data-sidebar-toggle]")?.focus();
      }
      closeTabletSidebar();
    };
    // Not the title bar's toggle: its click closes it after the press.
    const onOutside = (e: Event) => {
      const t = e.target;
      if (!(t instanceof Element) || sideRef.current?.contains(t) || t.closest("[data-sidebar-toggle]")) return;
      if (!document.querySelector(OPEN_LAYER)) closeTabletSidebar();
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("focusin", onOutside, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("focusin", onOutside, true);
    };
  }, [float]);

  // The open conversation stays in sight: once per navigation (as soon as its row exists), a row
  // hidden past the list's edge is brought to the middle. Later scrolling is the person's.
  const shownFor = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry when the lists load
  useLayoutEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('.sidebar__item[data-status="active"]');
    if (!nav || !active || shownFor.current === pathname) return;
    shownFor.current = pathname;
    const n = nav.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    if (a.top < n.top || a.bottom > n.bottom) nav.scrollTop += a.top - n.top - (nav.clientHeight - a.height) / 2;
  }, [pathname, channels.data, dms.data, shownAgents.length, rail]);

  // A personal workspace's order of its parts (SidebarOrder.tsx); a part with nothing to show leaves no line.
  const sectionOrder = useSectionOrder(orgId, personal);
  const sectionMenu = (id: SectionKey) =>
    entityMenu(() => [{ kind: "header", label: sectionName(t, id, personal) }, ...sectionOrder.entries(id)]);
  // What the headers' + and the sidebar's own menu (right click on its empty space) create, each as far as the role allows.
  const item = (id: string, label: string, icon: IconName, run: () => void): MenuEntry => ({
    kind: "item",
    id,
    label,
    icon,
    run,
  });
  const newChannelItem = can(org, "create_channels")
    ? [item("new-channel", t(modeKey(org, "shell.sidebarMenu.newChannel")), "channel", () => setCreatingChannel(true))]
    : [];
  const archivedItem =
    archivedChannels.length > 0
      ? [item("archived-channels", t("channel.archivedTitle"), "archive", () => setShowArchived(true))]
      : [];
  const createAgentItem = makesAgents(org) ? [item("create-agent", t("shell.createAgent"), "plus", newAgent)] : [];
  // Not while the workspace is being deleted: nothing new joins it.
  const invites = can(org, "invite_people") && !org.deletion && invite !== null;
  // With no channel to list, a personal workspace's group conversations show only for who may create one: the section
  // then holds a "New group conversation" row, the way to the first.
  const channelsShown = !personal || listedChannels.length > 0 || newChannelItem.length > 0;
  // A tool's link keeps the browser's menu, from the mouse and the keyboard alike.
  const spaceEvent = (e: { target: EventTarget }) => !(e.target instanceof Element && e.target.closest("a[href]"));
  const sidebarMenu = entityMenu(() => [
    { kind: "header", label: t("shell.sidebarMenu.title") },
    item("customize", t("shell.customizeSidebar"), "settings", () => setCustomizing(true)),
    { kind: "separator" },
    ...newChannelItem,
    { kind: "separator" },
    ...createAgentItem,
    ...(invites ? [item("invite", t("sidebarDms.invite"), "personAdd", () => invite?.open())] : []),
    item("team", t("shell.team"), "agent", () => void navigate({ to: "/org/$orgId/team", params: { orgId } })),
    ...(personal ? [{ kind: "separator" as const }, sectionOrder.restore] : []),
  ]);
  const channelsPart = channelsShown && (
    <SidebarChannels
      rows={channelRows}
      all={listedChannels}
      loading={channels.isLoading}
      sections={sections}
      onNewChannel={() => setCreatingChannel(true)}
      headProps={personal ? sectionMenu("channels") : undefined}
      addEntries={[...newChannelItem, ...archivedItem]}
    />
  );

  // ── A personal workspace's list (ADR 0159): its tools in sight, its agents and its group conversations ──
  const ownAgents = (() => {
    const { top, rest } = splitPinned(shownAgents, pins.agents, (a) => a.id);
    return { top, rest: sortAgents(rest, view.agentSort, me.user.id, busy) };
  })();
  const personalBlocks: Record<SectionKey, ReactNode> = {
    tools: listed.length > 0 && (
      <div className="sidebar__group sidebar__tools">
        <ToolList items={listed} row={toolRow} />
      </div>
    ),
    channels: channelsPart,
    agents: (dir.loading || rightHand || team.length > 0 || createAgentItem.length > 0) && (
      <div className="sidebar__group sidebar__agents-plain">
        {rightHand && (
          <RightHandRow
            agent={rightHand}
            unread={rightHandDm?.unread ?? 0}
            onPrefetch={() => rightHandDm && prefetch(rightHandDm.channelId)}
            onOpen={() => rightHandDm && markOpen(rightHandDm.channelId)}
          />
        )}
        {dir.loading && team.length === 0 && <SidebarSkeleton count={2} avatar label={t("common.loadingList")} />}
        {ownAgents.top.map((a) => agentRow(a))}
        {ownAgents.top.length > 0 && ownAgents.rest.length > 0 && <hr className="sidebar__pins-end" />}
        {ownAgents.rest.map((a) => agentRow(a))}
        {createAgentItem.length > 0 &&
          (rail ? <CreateAgentTile onOpen={newAgent} /> : <NewAgentRow onOpen={newAgent} />)}
      </div>
    ),
    // A personal workspace lists people only once someone else is a member (a family, ADR 0159).
    people: !alone && (
      <SidebarSection
        id="people"
        label={t("shell.directMessages")}
        sections={sections}
        className="sidebar__section--part"
        headProps={sectionMenu("people")}
      >
        {dir.members.filter((m) => m.userId !== me.user.id).map((m) => personRow(m))}
      </SidebarSection>
    ),
  };

  // ── A team's list (ADR 0260): Não lidas, Threads, Favoritos, Canais, Mensagens diretas ──
  const favoriteDrag = useListDrag(favorites.list, favorites.place, favorites.move);
  const channelById = new Map(listedChannels.map((c) => [c.id, c]));
  const favoriteRows = personal
    ? []
    : favorites.list.flatMap((key) => {
        const f = favorites.parse(key);
        if (!f) return [];
        const move = favoriteDrag.row(key);
        if (f.kind === "agent") {
          const a = dir.agentById.get(f.id);
          return a && (canTalk(a) || opensDm(a)) ? [agentRow(a, { line: true, move })] : [];
        }
        if (f.kind === "person") {
          const m = f.id === me.user.id ? undefined : dir.memberById.get(f.id);
          return m ? [personRow(m, move)] : [];
        }
        const c = channelById.get(f.id);
        return c ? [channelRows.row(c, { favorite: move })] : [];
      });
  // Mensagens diretas: everyone in the workspace and the agents that talk to me, together (`dmList`), less Favoritos.
  const dmPeople: (DmListed & { member?: Member; agent?: Agent })[] = [
    ...(rightHand ? [{ kind: "agent" as const, id: rightHand.id, name: rightHand.name, agent: rightHand }] : []),
    ...shownAgents.map((a) => ({ kind: "agent" as const, id: a.id, name: a.name, agent: a })),
    ...dir.members
      .filter((m) => m.userId !== me.user.id)
      .map((m) => ({ kind: "person" as const, id: m.userId, name: m.name, member: m })),
  ].filter((l) => !isFavorite(l.kind, l.id));
  const dmRows = dmList(dmPeople, dms.data ?? [], {
    show: view.dms ?? "all",
    first: rightHand?.id,
    locale: i18n.language,
  });
  // Invitations not accepted yet, for who invites: the invited address with "Convite enviado" (ADR 0260 §5).
  const pendingInvites =
    useAllInvitations(orgId, invites && !personal).data?.filter((i) => i.status === "pending") ?? [];
  const dmsUnread = dmRows.reduce((n, l) => n + (dmOf.get(l.id)?.unread ?? 0), 0);
  const favoritesUnread = favorites.list.reduce((n, key) => {
    const f = favorites.parse(key);
    if (!f) return n;
    if (f.kind === "channel") return n + (channelById.get(f.id)?.mentionCount ?? 0);
    return n + (dmOf.get(f.id)?.unread ?? 0);
  }, 0);
  // Não lidas: bold while any conversation or the inbox has something new, a red count for what waits for me.
  const anyUnread =
    unreadNotifications > 0 ||
    (dms.data ?? []).some((d) => d.unread > 0) ||
    listedChannels.some((c) => looksUnread(c) || (c.mentionCount ?? 0) > 0);
  const teamList = (
    <>
      <div className="sidebar__block" data-section="tools">
        <div className="sidebar__group sidebar__tools">
          <Link to="/org/$orgId/unreads" params={{ orgId }} className="sidebar__item" data-unread={anyUnread}>
            <Icon name="unreads" />
            <span className="sidebar__item-label">{t("unreads.title")}</span>
            {/* A count of things that wait, in ink: red is for mentions and DMs alone (ADR 0260). */}
            {waitingOnMe > 0 && (
              <CountBadge role="img" aria-label={t("notifications.summaryWaiting", { count: waitingOnMe })}>
                {badgeCount(waitingOnMe)}
              </CountBadge>
            )}
          </Link>
          <Link
            to="/org/$orgId/threads"
            params={{ orgId }}
            className="sidebar__item"
            data-unread={unreadThreads > 0}
            title={unreadThreads > 0 ? t("shell.unreadThreads", { count: unreadThreads }) : undefined}
          >
            <Icon name="thread" />
            <span className="sidebar__item-label">{t("shell.threads")}</span>
            {/* The missions waiting for me (a tab of Threads), as a neutral count. */}
            {missionsWaiting > 0 && (
              <CountChip
                className="sidebar__count"
                role="img"
                aria-label={t("shell.missionsWaiting", { count: missionsWaiting })}
              >
                {missionsWaiting}
              </CountChip>
            )}
          </Link>
        </div>
      </div>
      {favoriteRows.length > 0 && (
        <div className="sidebar__block" data-section="favorites">
          <SidebarSection
            id="favorites"
            label={t("sidebarFavorites.title")}
            sections={sections}
            className="sidebar__section--part"
            summary={favoritesUnread > 0 && <UnreadCount count={favoritesUnread} mentions />}
          >
            {favoriteRows}
          </SidebarSection>
        </div>
      )}
      <div className="sidebar__block" data-section="channels">
        {channelsPart}
      </div>
      <div className="sidebar__block" data-section="people">
        <SidebarSection
          id="people"
          label={t("shell.directMessages")}
          sections={sections}
          className="sidebar__section--part"
          summary={dmsUnread > 0 && <UnreadCount count={dmsUnread} />}
          action={
            <>
              <Menu
                align="end"
                label={t("sidebarDms.options")}
                trigger={
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon="more"
                    className="sidebar__section-add"
                    aria-label={t("sidebarDms.options")}
                  />
                }
              >
                <MenuRadioGroup
                  label={t("sidebarDms.show")}
                  value={view.dms ?? "all"}
                  onValueChange={(v) => setView((now) => ({ ...now, dms: v as SidebarDmShow }))}
                  options={(["all", "recent"] as const).map((value) => ({
                    value,
                    label: t(`sidebarDms.shows.${value}`),
                  }))}
                />
                {manages && (
                  <>
                    <MenuSeparator />
                    <MenuCheckboxItem
                      checked={view.showAllAgents}
                      onCheckedChange={(on) => setView((now) => ({ ...now, showAllAgents: on }))}
                    >
                      {t("sidebarAgents.showAll")}
                    </MenuCheckboxItem>
                  </>
                )}
              </Menu>
              {/* "Nova mensagem" is Ir para…, which finds anyone (people and agents). */}
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon="plus"
                className="sidebar__section-add"
                aria-label={t("shell.sidebarMenu.newMessage")}
                onClick={openPalette}
              />
            </>
          }
        >
          {(dir.loading || dms.isLoading) && dmRows.length === 0 && (
            <SidebarSkeleton count={3} avatar label={t("common.loadingList")} />
          )}
          {dmRows.map((l) =>
            l.agent ? (
              l.agent === rightHand ? (
                <RightHandRow
                  key={l.id}
                  agent={l.agent}
                  line
                  unread={rightHandDm?.unread ?? 0}
                  onPrefetch={() => rightHandDm && prefetch(rightHandDm.channelId)}
                  onOpen={() => rightHandDm && markOpen(rightHandDm.channelId)}
                />
              ) : (
                agentRow(l.agent, { line: true })
              )
            ) : (
              l.member && personRow(l.member)
            ),
          )}
          {pendingInvites.map((i) => (
            <InviteRow key={i.id} email={i.email} />
          ))}
          {invites && <AddRow icon="plus" label={t("sidebarDms.invite")} onClick={() => invite?.open()} />}
          {createAgentItem.length > 0 && <AddRow icon="plus" label={t("sidebarAgents.newAgent")} onClick={newAgent} />}
          {listsAllAgents(org) && team.length > shownAgents.length && (
            <Link to="/org/$orgId/team" params={{ orgId }} className="sidebar__item sidebar__see-all">
              <Icon name="agent" />
              <span className="sidebar__item-label">
                {t("sidebarAgents.more", { count: team.length - shownAgents.length })}
              </span>
            </Link>
          )}
        </SidebarSection>
      </div>
    </>
  );

  // The sidebar's toggle, in one place at every width: the column's foot in a team's, beside the bell in a personal
  // one. In a phone's drawer it closes the drawer.
  const collapseLabel = compact ? t("shell.closeNav") : collapsed ? t("shell.expandNav") : t("shell.collapseNav");
  const collapseProps = {
    variant: "ghost",
    iconOnly: true,
    icon: "sidebar",
    "data-sidebar-toggle": "",
    "aria-label": collapseLabel,
    title: collapseLabel,
    "aria-expanded": compact || !collapsed,
    onClick: compact ? () => drawer?.close({ restoreFocus: true }) : toggleCollapsed,
  } as const;
  // The workspace header's line. Each count with its own plural: one summary string followed the people's, so
  // "1 agentes".
  const summary = overview.data
    ? [
        t("settings.tileState.members", { count: overview.data.people }),
        t("sidebarAgents.count", { count: overview.data.agents }),
      ].join(" · ")
    : null;
  // The column's tiles move the focus with ↑ and ↓ (a vertical toolbar), Home and End to its ends.
  const columnKeys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.shiftKey || e.metaKey || e.ctrlKey) return;
    const tiles = [...e.currentTarget.querySelectorAll<HTMLElement>(".sidebar__tile, .sidebar__col .ac-btn")].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    const at = tiles.indexOf(document.activeElement as HTMLElement);
    const to =
      e.key === "ArrowDown"
        ? at + 1
        : e.key === "ArrowUp"
          ? at - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? -1
              : null;
    if (to === null || at < 0) return;
    e.preventDefault();
    tiles.at(to === -1 ? tiles.length - 1 : Math.min(to, tiles.length - 1))?.focus();
  };

  const main = (
    <>
      <div className="sidebar__top">
        <WorkspaceSky part="side" rail={rail && personal} />
        {personal ? (
          // A personal workspace (ADR 0159): the person on top (their account, settings and workspaces in one menu),
          // Agora, the bell and the collapse beside them. The desktop app's title bar has its own collapse
          // (desktop.css).
          <div className="sidebar__org sidebar__org--person">
            <AccountMenu personal />
            <AgoraButton below={compact} className="sidebar__agora" />
            <Button {...collapseProps} size="sm" className="sidebar__head-collapse" />
          </div>
        ) : (
          <div className="sidebar__org">
            <WorkspaceMenu summary={summary} />
          </div>
        )}
      </div>

      {/* A right click on the space between the rows (not on a row or a header, which have their own) opens the
          sidebar's menu; a link with no menu of its own (a tool) keeps the browser's. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the right click and Shift+F10 of the sidebar's own menu */}
      <div
        className="sidebar__scroll"
        ref={navRef}
        // Its lists show together once the channels, the agents and the DMs are in: no part pushes the next down.
        data-pending={channels.isLoading || dir.loading || dms.isLoading || undefined}
        onKeyDown={(e) => spaceEvent(e) && sidebarMenu.onKeyDown(e)}
        onContextMenu={(e) => spaceEvent(e) && sidebarMenu.onContextMenu(e)}
      >
        {personal
          ? sectionOrder.order
              .filter((id) => personalBlocks[id])
              .map((id) => sectionOrder.block(id, personalBlocks[id], !rail))
          : teamList}
      </div>

      {/* A personal workspace's end (ADR 0159): one More, holding Início, Go to… and every tool not in sight. */}
      {personal && (
        <div className="sidebar__end">
          <MoreTools items={inMore} row={toolRow} countOf={countOf} onCustomize={() => setCustomizing(true)} home />
        </div>
      )}

      <ArchivedChannelsDialog open={showArchived} onClose={() => setShowArchived(false)} />
      <NewChannelDialog open={creatingChannel} onOpenChange={setCreatingChannel} />
      <SidebarSetupDialog open={customizing} onClose={() => setCustomizing(false)} />

      {/* Beta: the way to the feedback form, a row of its own at the bottom, where this server takes it. Not beside
          the person's name, which it would leave no room for; the rail has no room for a row's words. */}
      {!rail && <FeedbackMark />}
      {/* No foot in a personal workspace (ADR 0159): the person, the bell and the collapse are on top. */}
      {!personal && (
        <div className="sidebar__foot">
          <SidebarHorizon working={working} total={dir.agents.length} />
          <div className="sidebar__me">
            <AccountMenu />
          </div>
        </div>
      )}
    </>
  );

  return (
    <nav
      className="sidebar"
      aria-label={t("shell.nav")}
      data-layout={personal ? undefined : "column"}
      data-rail={rail}
      data-float={float || undefined}
      ref={sideRef}
      {...drawer?.navProps}
    >
      {personal ? (
        main
      ) : (
        <>
          {/* The tools (ADR 0260): a vertical toolbar, each tile's name in a tip on its right. */}
          <div
            className="sidebar__col"
            role="toolbar"
            aria-orientation="vertical"
            aria-label={t("sidebarColumn.label")}
            data-tip-side="right"
            onKeyDown={columnKeys}
          >
            <button
              type="button"
              className="sidebar__tile"
              aria-label={t("palette.jump")}
              aria-keyshortcuts="Control+K Meta+K"
              title={`${t("palette.jump")} (${modKey()} K)`}
              onClick={openPalette}
            >
              <Icon name="search" />
            </button>
            <hr className="sidebar__col-line" />
            <Link to="/org/$orgId/home" params={{ orgId }} className="sidebar__tile" aria-label={t("shell.home")}>
              <Icon name="home" />
            </Link>
            <ToolList items={listed} row={toolTile} />
            <MoreTools items={inMore} row={toolTile} countOf={countOf} onCustomize={() => setCustomizing(true)} tile />
            <span className="sidebar__col-gap" />
            <AgoraButton className="sidebar__agora" align="end" />
            <Button {...collapseProps} className="sidebar__collapse" />
          </div>
          <div className="sidebar__main">{main}</div>
        </>
      )}
    </nav>
  );
}

/** Create agent as one of the rail's tiles (the full sidebar creates from the Agents header's +). */
/**
 * New agent under the agents (ADR 0159, ADR 0164): a row like theirs, an empty face with a plus where a face would be,
 * so it reads as the next one.
 */
function NewAgentRow({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="sidebar__item sidebar__new-agent" onClick={onOpen}>
      <span className="sidebar__new-agent-face" aria-hidden="true">
        <Icon name="plus" size={16} />
      </span>
      <span className="sidebar__item-label">{t("sidebarAgents.newAgent")}</span>
    </button>
  );
}

function CreateAgentTile({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <Button block variant="ghost" className="sidebar__create" title={t("shell.createAgent")} onClick={onOpen}>
      <Icon name="plus" />
      <span className="sidebar__item-label">{t("shell.createAgent")}</span>
    </Button>
  );
}

/** The fixed parts and one of the person's own channel sections as `section:<id>` (ADR 0260). */
type SectionId = "favorites" | "channels" | "agents" | "people" | `section:${string}`;

/**
 * Which sidebar categories are closed, remembered in this browser for each person in each workspace. One closed by
 * default (`byDefault` false) and opened by the person is kept as `+<id>`.
 */
function useSidebarSections(userId: string, orgId: string) {
  const key = `${STORAGE_KEYS.sidebarSections}.${userId}.${orgId}`;
  const [saved, setSaved] = useState(() => ({ key, closed: new Set(storedStrings(key)) }));
  // The sidebar stays mounted when the workspace changes: that one's own state.
  if (saved.key !== key) setSaved({ key, closed: new Set(storedStrings(key)) });
  const change = (edit: (closed: Set<string>) => void) =>
    setSaved((prev) => {
      const closed = new Set(prev.closed);
      edit(closed);
      storage.set(prev.key, JSON.stringify([...closed]));
      return { key: prev.key, closed };
    });
  const openIn = (closed: Set<string>, id: SectionId, byDefault: boolean) =>
    closed.has(id) ? false : closed.has(`+${id}`) || byDefault;
  const toggle = (id: SectionId, byDefault = true) =>
    change((closed) => {
      const open = openIn(closed, id, byDefault);
      closed.delete(id);
      closed.delete(`+${id}`);
      if (open) closed.add(id);
      else if (!byDefault) closed.add(`+${id}`);
    });
  /** "Fechar todas" / "Abrir todas" for the channel categories and the groups of agents. */
  const setAll = (ids: SectionId[], open: boolean) =>
    change((closed) => {
      for (const id of ids) {
        closed.delete(id);
        closed.delete(`+${id}`);
        closed.add(open ? `+${id}` : id);
      }
    });
  return { isOpen: (id: SectionId, byDefault = true) => openIn(saved.closed, id, byDefault), toggle, setAll };
}

/**
 * A part of the sidebar, or one of the person's channel sections, that opens and closes. Closed, it keeps its open
 * page's row in sight (CSS shows only the active item; a section, its unread channels too), and shows `summary` (a
 * count) on its header. On a personal workspace's icon rail the header goes away and every item shows. `drop`: it
 * takes dragged channels.
 */
function SidebarSection({
  id,
  label,
  sections,
  defaultOpen = true,
  summary,
  action,
  drop,
  className,
  headProps,
  toggleProps,
  title,
  children,
}: {
  id: SectionId;
  label: string;
  sections: ReturnType<typeof useSidebarSections>;
  /** Open until the person closes it. */
  defaultOpen?: boolean;
  summary?: ReactNode;
  action?: ReactNode;
  /** It takes a drop: channels dragged into a section, or out of one onto Canais. */
  drop?: HTMLAttributes<HTMLDivElement> & { "data-drop"?: string | boolean };
  className?: string;
  /** A section's header: its right click and the drop of a channel. */
  headProps?: HTMLAttributes<HTMLDivElement>;
  /** On its toggle: a section's Alt+Shift+↑/↓. */
  toggleProps?: HTMLAttributes<HTMLButtonElement> & { "aria-keyshortcuts"?: string };
  /** In place of the toggle: a section's name being typed. */
  title?: ReactNode;
  children: ReactNode;
}) {
  const open = sections.isOpen(id, defaultOpen);
  const bodyId = `sidebar-section-${id.replace(":", "-")}`;
  return (
    <div className={cx("sidebar__group sidebar__section", className)} data-open={open} {...drop}>
      <div className="sidebar__section-head" {...headProps}>
        {title ?? (
          <button
            type="button"
            className="sidebar__section-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => sections.toggle(id, defaultOpen)}
            {...toggleProps}
          >
            <Icon name="chevronDown" size={14} className="sidebar__section-chevron" />
            <span className="sidebar__label">{label}</span>
          </button>
        )}
        {!open && summary}
        {action}
      </div>
      <div id={bodyId} className="sidebar__section-body">
        {children}
      </div>
    </div>
  );
}

/** A part header's +: a menu of what it creates (none of it allowed: no +). */
function SectionAdd({ label, entries }: { label: string; entries: MenuEntry[] }) {
  if (!entries.length) return null;
  return (
    <Menu
      align="end"
      label={label}
      trigger={
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="plus"
          className="sidebar__section-add"
          aria-label={label}
          title={label}
        />
      }
    >
      <MenuEntries entries={entries} />
    </Menu>
  );
}

/** A button over a row's end on hover or focus (`.sidebar__row-acts`), in place of its count or role. */
function RowAction({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      icon={icon}
      className="sidebar__row-menu"
      aria-label={label}
      title={label}
      onClick={onClick}
    />
  );
}

/** Where a dragged row would land: the row it is over and how (`into`: it makes a section with that channel). */
type DropMark = { key: string; where: "before" | "after" | "into" } | null;
const half = (e: DragEvent) => {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2 ? "after" : "before";
};

/**
 * A list the person orders (Favoritos): a row dragged onto another goes before or after it, and Alt+Shift+↑/↓ on a
 * focused one moves it past its neighbour. `row(key)` gives each row's props.
 */
function useListDrag(
  keys: readonly string[],
  place: (key: string, before: string | null) => void,
  move: (key: string, delta: -1 | 1) => void,
) {
  const dragging = useRef<string | null>(null);
  const [mark, setMark] = useState<DropMark>(null);
  const end = () => {
    dragging.current = null;
    setMark(null);
  };
  return {
    row: (key: string) =>
      ({
        draggable: true,
        "aria-keyshortcuts": "Alt+Shift+ArrowUp Alt+Shift+ArrowDown",
        "data-drop": mark?.key === key ? mark.where : undefined,
        onKeyDown: (e: ReactKeyboardEvent) => {
          const step = moveStep(e);
          if (!step) return;
          e.preventDefault();
          move(key, step);
        },
        onDragStart: (e: DragEvent) => {
          dragging.current = key;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("application/x-agentes-favorite", key);
        },
        onDragOver: (e: DragEvent) => {
          const from = dragging.current;
          if (!from || from === key) return;
          e.preventDefault();
          e.stopPropagation();
          const where = half(e);
          if (mark?.key !== key || mark.where !== where) setMark({ key, where });
        },
        onDrop: (e: DragEvent) => {
          const from = dragging.current;
          const m = mark;
          end();
          if (!from || !m) return;
          e.preventDefault();
          e.stopPropagation();
          const i = keys.indexOf(m.key);
          place(from, m.where === "before" ? m.key : (keys[i + 1] ?? null));
        },
        onDragEnd: end,
      }) as HTMLAttributes<HTMLAnchorElement> & { "data-drop"?: string },
  };
}

const SECTION_KEY = "section:";
/** Canais' own key among the drop marks: the channels in no section. */
const LOOSE = "loose";

/**
 * Canais (ADR 0260): the channels in none of the person's sections, in the workspace's order, then each section of
 * theirs with its channels. A channel dragged onto one in none makes a section of both (its name field open); onto a
 * channel in a section or a section's header it moves there; onto Canais' header it goes back. The keyboard's way: the
 * row's menu (Mover para a seção) and Alt+Shift+↑/↓ inside a section, on a section's header among the sections.
 * A personal workspace (ADR 0159) has no sections: its favorite conversations sit on top (`pinned`).
 */
function useChannelSections({
  channels: all,
  loading,
  pinned,
  onPrefetch,
}: {
  channels: Channel[];
  loading: boolean;
  pinned: readonly string[];
  onPrefetch: (channelId: string) => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const orgId = org.id;
  const navigate = useNavigate();
  const view = useSidebarView(orgId);
  const setView = useSetSidebarView(orgId);
  const personal = isPersonal(org);
  // An administrator reads every channel (ADR 0151): the ones they aren't in wait under one row, not in the list.
  const path = useRouterState({ select: (s) => s.location.pathname });
  const channels = all.filter((c) => !c.seenAsAdmin || path.endsWith(`/c/${c.id}`));
  // New since the list loaded (a team's, someone else's): their rows open their room as they land.
  const arrived = useArrived(
    channels.map((c) => c.id),
    !loading,
  );
  useArrivals();
  const byId = new Map(channels.map((c) => [c.id, c]));
  const saved = personal ? [] : (view.sections ?? []);
  // A section shows the channels the person still sees; one with none left shows nothing.
  const shown = saved
    .map((s) => ({ ...s, channels: s.channelIds.flatMap((id) => byId.get(id) ?? []) }))
    .filter((s) => s.channels.length > 0);
  const sectioned = new Set(shown.flatMap((s) => s.channelIds));
  // The workspace's order (ADR 0080 §3), a channel still in a sector after the ones in none.
  const loose = [
    ...channels.filter((c) => !sectioned.has(c.id) && !c.groupId),
    ...channels.filter((c) => !sectioned.has(c.id) && c.groupId),
  ];
  const save = (change: (now: SidebarChannelSection[]) => SidebarChannelSection[]) =>
    setView((now) => ({ ...now, sections: change(now.sections ?? []) }));
  const sectionOf = (channelId: string) => sectionOfChannel(saved, channelId);
  // The section whose name field is open: a new one, or one being renamed.
  const [renaming, setRenaming] = useState<string | null>(null);
  const create = (channelIds: string[]) => {
    const made = addSection(saved, t("sidebarSections.newName"), channelIds);
    save(() => made.sections);
    setRenaming(made.id);
  };

  // ── Dragging ──
  const drag = useRef<string | null>(null);
  const [mark, setMark] = useState<DropMark>(null);
  const endDrag = () => {
    drag.current = null;
    setMark(null);
  };
  const over = (e: DragEvent, key: string, where: "before" | "after" | "into") => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (mark?.key !== key || mark.where !== where) setMark({ key, where });
  };
  const still = (e: DragEvent) => {
    e.stopPropagation();
    if (mark) setMark(null);
  };
  const overChannel = (e: DragEvent, c: Channel) => {
    const id = drag.current;
    if (!id || personal) return;
    if (id === c.id) return still(e);
    // Onto a channel in none: a new section of both. Onto one in a section: its place there.
    over(e, `channel:${c.id}`, sectionOf(c.id) ? half(e) : "into");
  };
  const into = (e: DragEvent, sectionId: string | null) => {
    const id = drag.current;
    if (!id || personal) return;
    if (sectionOf(id) === sectionId) return still(e);
    over(e, sectionId ? `${SECTION_KEY}${sectionId}` : LOOSE, "into");
  };
  const drop = (e: DragEvent) => {
    const id = drag.current;
    const m = mark;
    endDrag();
    if (!id || !m) return;
    e.preventDefault();
    e.stopPropagation();
    if (m.key === LOOSE) return save((now) => placeInSection(now, id, null));
    if (m.key.startsWith(SECTION_KEY)) return save((now) => placeInSection(now, id, m.key.slice(SECTION_KEY.length)));
    const target = m.key.slice("channel:".length);
    const to = sectionOf(target);
    if (!to) return create([target, id]);
    const list = saved.find((s) => s.id === to)?.channelIds ?? [];
    const next = m.where === "before" ? target : (list[list.indexOf(target) + 1] ?? null);
    if (next === id) return;
    save((now) => placeInSection(now, id, to, next));
  };
  const dropMark = (key: string) => (mark?.key === key ? mark.where : undefined);
  /** A section's header and body, or Canais': a channel dropped there goes to its end (Canais: out of sections). */
  const zone = (sectionId: string | null) => ({
    "data-drop": dropMark(sectionId ? `${SECTION_KEY}${sectionId}` : LOOSE),
    onDragOver: (e: DragEvent<HTMLDivElement>) => into(e, sectionId),
    onDrop: (e: DragEvent<HTMLDivElement>) => drop(e),
  });

  // ── Menus: a channel's right click (lib/entity-menu.ts) with its "Mover para a seção" ──
  const channelEntries = useChannelMenu();
  const sectionEntries = (c: Channel): MenuEntry[] => {
    if (personal) return [];
    const current = sectionOf(c.id);
    return [
      { kind: "separator" },
      ...(saved.length ? [{ kind: "header" as const, label: t("sidebarSections.moveTo") }] : []),
      ...saved.map(
        (s): MenuEntry => ({
          kind: "item",
          id: `section-${s.id}`,
          label: s.name,
          icon: "layers",
          disabled: s.id === current,
          run: () => save((now) => placeInSection(now, c.id, s.id)),
        }),
      ),
      { kind: "item", id: "new-section", label: t("sidebarSections.new"), icon: "plus", run: () => create([c.id]) },
      ...(current
        ? ([
            {
              kind: "item",
              id: "out-of-section",
              label: t("sidebarSections.takeOut"),
              icon: "undo",
              run: () => save((now) => placeInSection(now, c.id, null)),
            },
          ] satisfies MenuEntry[])
        : []),
    ];
  };

  const row = (c: Channel, opts: { top?: boolean; favorite?: HTMLAttributes<HTMLAnchorElement> } = {}) => {
    // The usual marks: something new makes the row bold (a pill on its left edge) with no count; only a mention of me
    // gets the red one. Muted, it rests dim whatever comes, but a mention still shows.
    const unread = looksUnread(c);
    const mentions = c.mentionCount ?? 0;
    const outer = { "data-channel-row": c.id, ...arrivalProps(arrived, c.id) };
    const plain = !managesChannel(c, me.user.id, org);
    const inSection = sectionOf(c.id);
    const moves: HTMLAttributes<HTMLAnchorElement> & { "data-drop"?: string } =
      opts.favorite ??
      (personal || opts.top
        ? {}
        : {
            "data-drop": dropMark(`channel:${c.id}`),
            draggable: true,
            "aria-keyshortcuts": inSection ? "Alt+Shift+ArrowUp Alt+Shift+ArrowDown" : undefined,
            onKeyDown: (e: ReactKeyboardEvent) => {
              const step = moveStep(e);
              if (!step || !inSection) return;
              e.preventDefault();
              save((now) => moveChannelBy(now, c.id, step));
            },
            onDragStart: (e: DragEvent) => {
              drag.current = c.id;
              e.dataTransfer.effectAllowed = "move";
              // Firefox starts a drag only with some data set. Not text, or a text field it's dropped on types the id.
              e.dataTransfer.setData("application/x-agentes-channel", c.id);
            },
            onDragEnd: endDrag,
            onDragOver: (e: DragEvent) => overChannel(e, c),
            onDrop: drop,
          });
    const menu = entityMenu(() => channelEntries(c, opts.favorite ? [] : sectionEntries(c)));
    const link = (
      <Link
        key={c.id}
        to="/org/$orgId/c/$channelId"
        params={{ orgId, channelId: c.id }}
        className={personal ? "sidebar__item sidebar__group-row" : "sidebar__item"}
        title={personal ? c.name : `#${c.name}`}
        {...(plain ? outer : {})}
        data-kind="channel"
        data-unread={unread}
        data-muted={c.muted || undefined}
        {...moves}
        onMouseEnter={() => onPrefetch(c.id)}
        onFocus={() => onPrefetch(c.id)}
        onClick={() => markOpen(c.id)}
        onContextMenu={menu.onContextMenu}
        onKeyDown={keysInTurn(moves.onKeyDown, menu.onKeyDown)}
      >
        {personal ? (
          <GroupFace agentIds={c.agentIds ?? []} count={c.agentCount} />
        ) : (
          <>
            <Icon name="channel" className="sidebar__channel-icon" />
            <span className="sidebar__channel-abbr" aria-hidden="true">
              {channelInitials(c.name)}
            </span>
          </>
        )}
        <span className="sidebar__item-label">{c.name}</span>
        {mentions > 0 ? <UnreadCount count={mentions} mentions /> : opts.top && !unread && <PinnedMark />}
      </Link>
    );
    // On hover or focus, like Discord's invite and settings: who manages the channel adds members or opens its details.
    if (plain) return link;
    const openIt = (ask: "details" | "add") => () => {
      requestChannelDetails(c.id, ask);
      void navigate({ to: "/org/$orgId/c/$channelId", params: { orgId, channelId: c.id } });
    };
    return (
      <div key={c.id} className="sidebar__row" data-unread={unread} data-acts={2} {...outer}>
        {link}
        <span className="sidebar__row-acts">
          <RowAction icon="personAdd" label={t("shell.sidebarMenu.addMembers")} onClick={openIt("add")} />
          <RowAction icon="cog" label={t("shell.sidebarMenu.channelSettings")} onClick={openIt("details")} />
        </span>
      </div>
    );
  };
  /** Canais' own rows: a personal workspace's favorite conversations on top, a thin line, the rest. */
  const looseRows = () => {
    const { top, rest } = splitPinned(loose, pinned, (c) => c.id);
    return [
      ...top.map((c) => row(c, { top: true })),
      ...(top.length && rest.length ? [<hr key="pins-end" className="sidebar__pins-end" />] : []),
      ...rest.map((c) => row(c)),
    ];
  };
  /** A section's header menu: rename, move, delete. */
  const sectionMenu = (s: SidebarChannelSection): MenuEntry[] => {
    const i = saved.findIndex((x) => x.id === s.id);
    return [
      { kind: "header", label: s.name },
      { kind: "item", id: "rename", label: t("sidebarSections.rename"), icon: "edit", run: () => setRenaming(s.id) },
      {
        kind: "item",
        id: "move-up",
        label: t("contextMenu.moveUp"),
        icon: "chevronUp",
        disabled: i <= 0,
        run: () => save((now) => moveSectionBy(now, s.id, -1)),
      },
      {
        kind: "item",
        id: "move-down",
        label: t("contextMenu.moveDown"),
        icon: "chevronDown",
        disabled: i >= saved.length - 1,
        run: () => save((now) => moveSectionBy(now, s.id, 1)),
      },
      { kind: "separator" },
      {
        kind: "item",
        id: "delete",
        label: t("sidebarSections.delete"),
        icon: "trash",
        danger: true,
        run: () => save((now) => removeSection(now, s.id)),
      },
    ];
  };

  return {
    channels,
    others: all.filter((c) => !channels.includes(c)),
    looseRows,
    row,
    loose: zone(null),
    sections: shown.map((s) => ({
      ...s,
      rows: s.channels.map((c) => row(c)),
      unread: s.channels.reduce((n, c) => n + (c.mentionCount ?? 0), 0),
      head: zone(s.id) as HTMLAttributes<HTMLDivElement>,
      menu: () => sectionMenu(s),
      onKeyDown: (e: ReactKeyboardEvent) => {
        const step = moveStep(e);
        if (!step) return;
        e.preventDefault();
        save((now) => moveSectionBy(now, s.id, step));
      },
    })),
    renaming,
    rename: (id: string, name: string | null) => {
      setRenaming(null);
      if (name !== null) save((now) => renameSection(now, id, name));
    },
  };
}

/** A section's name, typed in place on its header: Enter or leaving it keeps it, Esc keeps the one it had. */
function SectionNameField({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      ref={ref}
      className="sidebar__section-name"
      defaultValue={name}
      maxLength={SIDEBAR_SECTION_NAME_MAX}
      aria-label={t("sidebarSections.nameLabel")}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") {
          e.stopPropagation();
          finish(null);
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

/**
 * Canais (ADR 0080, ADR 0260): the channels in none of the person's sections, then each section, closed sections
 * keeping their unread channels and the open one in sight (CSS).
 */
function SidebarChannels({
  rows,
  all,
  loading,
  sections,
  onNewChannel,
  headProps,
  addEntries,
}: {
  rows: ReturnType<typeof useChannelSections>;
  all: Channel[];
  loading: boolean;
  sections: ReturnType<typeof useSidebarSections>;
  onNewChannel: () => void;
  /** A personal workspace's "Canais" header: the part's own menu (its place in the sidebar). */
  headProps?: HTMLAttributes<HTMLDivElement>;
  /** What "Canais"' + creates. */
  addEntries: MenuEntry[];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const mayCreate = can(org, "create_channels");
  const others = rows.others;
  const mentions = rows.channels.reduce((n, c) => n + (c.isMember ? (c.mentionCount ?? 0) : 0), 0);
  return (
    <>
      <SidebarSection
        id="channels"
        // A personal workspace's are its group conversations (ADR 0159).
        label={t(modeKey(org, "shell.channels"))}
        sections={sections}
        className="sidebar__section--part"
        headProps={headProps}
        summary={mentions > 0 && <UnreadCount count={mentions} mentions />}
        action={<SectionAdd label={t(modeKey(org, "shell.sidebarMenu.addToChannels"))} entries={addEntries} />}
        // A channel dragged here leaves its section.
        drop={rows.sections.length > 0 ? rows.loose : undefined}
      >
        {loading && <SidebarSkeleton count={3} label={t("common.loadingList")} />}
        {rows.looseRows()}
        {/* A personal workspace with no group conversation yet (ADR 0159): a row to create the first; after it, the
            header's + does. */}
        {isPersonal(org) && mayCreate && !loading && all.length === 0 && (
          <button type="button" className="sidebar__item sidebar__new-channel" onClick={onNewChannel}>
            <Icon name="plus" className="sidebar__channel-icon" />
            <span className="sidebar__item-label">{t("shell.sidebarMenu.newChannelPersonal")}</span>
          </button>
        )}
        {others.length > 0 && (
          <Menu
            label={t(modeKey(org, "shell.otherChannels"))}
            trigger={
              <button type="button" className="sidebar__item" data-kind="channel">
                <Icon name="lock" />
                <span className="sidebar__item-label">{t(modeKey(org, "shell.otherChannels"))}</span>
                <CountChip className="sidebar__count">{others.length}</CountChip>
              </button>
            }
          >
            {others.map((c) => (
              <MenuItem
                key={c.id}
                icon="lock"
                onSelect={() =>
                  void navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: org.id, channelId: c.id } })
                }
              >
                {c.name}
              </MenuItem>
            ))}
          </Menu>
        )}
      </SidebarSection>
      {rows.sections.map((s) => {
        const id = `section:${s.id}` as const;
        const closedCount = sections.isOpen(id) ? 0 : s.unread;
        return (
          <SidebarSection
            key={s.id}
            id={id}
            label={s.name}
            sections={sections}
            className="sidebar__section--category"
            headProps={{ ...s.head, ...entityMenu(s.menu) }}
            toggleProps={{ onKeyDown: s.onKeyDown, "aria-keyshortcuts": "Alt+Shift+ArrowUp Alt+Shift+ArrowDown" }}
            title={
              rows.renaming === s.id ? (
                <SectionNameField name={s.name} onDone={(name) => rows.rename(s.id, name)} />
              ) : undefined
            }
            action={closedCount > 0 && <UnreadCount count={closedCount} mentions />}
            drop={s.head}
          >
            {s.rows}
          </SidebarSection>
        );
      })}
    </>
  );
}

/** The tools whose line in More has a personal workspace's words (ADR 0159); the others' fit both. */
type PersonalWhat = Exclude<SidebarItem, "routines" | "drive" | "waiting">;
const hasPersonalWhat = (id: SidebarItem): id is PersonalWhat =>
  id !== "routines" && id !== "drive" && id !== "waiting";

/**
 * More: the tools the person keeps out of the list, in a panel beside the sidebar (so nothing below moves), each with a
 * line on what it is for, then "Personalizar a barra lateral". The one opened from it stays in sight under it (CSS
 * shows only the active row).
 */
function MoreTools({
  items,
  row,
  countOf,
  onCustomize,
  home = false,
  tile = false,
}: {
  items: SidebarItem[];
  row: (id: SidebarItem) => ReactNode;
  countOf: (id: SidebarItem) => ReactNode;
  onCustomize: () => void;
  /** At a personal workspace's end (ADR 0159): Início and Go to… open its list, and it opens upward. */
  home?: boolean;
  /** A tile of a team's tool column (ADR 0260). */
  tile?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const personal = isPersonal(org);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        label={t("shell.more")}
        side="right"
        align={home ? "end" : "start"}
        className="sidebar__more-menu"
        trigger={
          tile ? (
            <button ref={trigger} type="button" className="sidebar__tile sidebar__more" aria-label={t("shell.more")}>
              <Icon name="more" />
            </button>
          ) : (
            <button ref={trigger} type="button" className="sidebar__item sidebar__more" title={t("shell.more")}>
              <Icon name="more" />
              <span className="sidebar__item-label">{t("shell.more")}</span>
              <Icon name="chevronRight" size={16} className="sidebar__more-chevron" />
            </button>
          )
        }
      >
        {home && (
          <>
            <Link
              to="/org/$orgId/home"
              params={{ orgId: org.id }}
              className="ac-menu__item sidebar__more-item"
              onClick={() => setOpen(false)}
            >
              <Icon name="home" />
              <span className="ac-menu__label">
                {t("shell.home")}
                <span className="ac-menu__desc">{t("shell.moreWhat.homePersonal")}</span>
              </span>
            </Link>
            <button
              type="button"
              className="ac-menu__item sidebar__more-item"
              onClick={() => {
                setOpen(false);
                openPalette();
              }}
            >
              <Icon name="search" />
              <span className="ac-menu__label">{t("palette.jump")}</span>
              <span className="sidebar__goto-keys" aria-hidden="true">
                <Kbd>{modKey()}</Kbd>
                <Kbd>K</Kbd>
              </span>
            </button>
            <div className="ac-menu__separator" aria-hidden="true" />
          </>
        )}
        {items.map((id) => (
          <Link
            key={id}
            to={SIDEBAR_TOOLS[id].to}
            params={{ orgId: org.id }}
            className="ac-menu__item sidebar__more-item"
            onClick={() => setOpen(false)}
          >
            <Icon name={SIDEBAR_TOOLS[id].icon} />
            <span className="ac-menu__label">
              {t(`shell.${id}`)}
              <span className="ac-menu__desc">
                {t(personal && hasPersonalWhat(id) ? `shell.moreWhat.${id}Personal` : `shell.moreWhat.${id}`)}
              </span>
            </span>
            {countOf(id)}
          </Link>
        ))}
        <div className="ac-menu__separator" aria-hidden="true" />
        <button
          type="button"
          className="ac-menu__item sidebar__more-item"
          onClick={() => {
            setOpen(false);
            // Closing the dialog brings focus back to More, not to this line, gone with the panel.
            trigger.current?.focus();
            onCustomize();
          }}
        >
          <Icon name="settings" />
          <span className="ac-menu__label">{t("shell.customizeSidebar")}</span>
        </button>
      </Popover>
      <div className="sidebar__more-active">{items.map(row)}</div>
    </>
  );
}

/** A small pin at a pinned row's end, in place of its hover buttons. */
function PinnedMark() {
  const { t } = useTranslation();
  return (
    <span className="sidebar__item-meta sidebar__pinned" role="img" aria-label={t("sidebarFavorites.marked")}>
      <Icon name="pin" size={14} />
    </span>
  );
}

/**
 * An agent's row (its row is its DM). While it works its face moves and wears the orbit, and nothing else on the row
 * changes (ADR 0260 §7): what it is on, for whom and how long is in the row's title, workspace-wide (its work for me,
 * ADR 0084 addendum of 2026-11-13). `oneLine`: one line in Mensagens diretas and Favoritos, its name and a quiet "IA"; a
 * personal workspace's list keeps its role or work under the name. `drag`: its place among the favorites.
 * `live`: it works, waits or wrote to me.
 */
function AgentRow({
  agent: a,
  arrival,
  unread,
  waitingFor,
  live,
  pinned,
  oneLine = false,
  onPrefetch,
  onOpen,
  drag,
}: {
  agent: Agent;
  /** Its marks while it lands in the sidebar (`arrivalProps`). */
  arrival?: ReturnType<typeof arrivalProps>;
  unread: number;
  /** The offline computer it waits for (its brain runs there). */
  waitingFor?: string;
  live?: boolean;
  pinned?: boolean;
  oneLine?: boolean;
  onPrefetch: () => void;
  onOpen: () => void;
  drag?: HTMLAttributes<HTMLAnchorElement>;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const state = useStreams((st) => agentStateIn(st, a.id));
  const workingIn = useStreams((st) => agentWorkingIn(st, a.id));
  // Its presence from its work and its line (ADR 0084): the badge on its face, both in the row's title (no emoji in
  // the list: the line shows where the agent is opened).
  const shown = useAgentPresence(a.id);
  const work = shown?.work ?? null;
  // At work: a run this tab hears, or its work for me anywhere (work handed off in two agents' DM too).
  const busy = (state !== "idle" && !waitingFor) || work?.state === "working";
  const chip = audienceChip(t, a);
  // Background work's minutes move with the anchor's line, every half minute; its work's every minute.
  const clock = useNow(shown?.line?.kind === "work" || work !== null, work ? WORK_TICK_MS : 30_000);
  const word = shown ? agentFaceWord(t, shown.presence) : null;
  const line = agentLine(t, shown?.line ?? null, i18n.language);
  const dir = useDirectory(org.id);
  const channelList = useChannels(org.id).data;
  const here = workingIn ? channelList?.find((c) => c.id === workingIn)?.name : undefined;
  const channelName = (id: string) => channelList?.find((c) => c.id === id)?.name;
  const out = shown?.presence === "out" && line ? line.text : null;
  // Under its name: for whom or where it works, what it waits on, and for how long; a return it set comes after why it
  // is out.
  const doing =
    work?.state === "later" && out
      ? null
      : workLine(t, i18n.language, work, { agentName: (id) => dir.agentById.get(id)?.name, channelName }, clock);
  const navigate = useNavigate();
  const agentEntries = useAgentMenu();
  const rowMenu = entityMenu(() => agentEntries(a));
  // Its owner and who manages it (ADR 0085 addendum of 2026-11-17): its settings on hover, like a channel's.
  const edits = managesAgent(a) || ownsAgentAs(a, me.user.id, dir.rolesOf(me.user.id));
  // Listed for who manages it though it doesn't talk to them (its DM opens, `opensDm`): the line says who it talks to.
  const locked = !canTalk(a);
  const names = locked ? audienceNames(a, (id) => dir.memberById.get(id)?.name, dir.roleName) : [];
  // Working: its face wears the orbit (what it is on is in the row's title), so the row never changes height; the
  // orbit says it, so the face's "working" badge steps aside.
  const working = busy || shown?.line?.kind === "work" || shown?.presence === "working";
  const now = busy
    ? here
      ? t("sidebarAgents.workingIn", { channel: here })
      : state !== "idle"
        ? t(`sky.busy.${state}`)
        : agentFaceWord(t, "working")
    : working
      ? line?.text
      : undefined;
  // Under the name, one line of one height: its work (waiting on me, working, a wait, in line), why it is out, a return
  // it set, who it talks to when that is limited, else its role (the agent's fixed label) as a tag.
  const under =
    out ??
    (locked
      ? names.length > 1
        ? t("sidebarAgents.talksOnlyMore", { name: names[0], count: names.length - 1 })
        : names[0]
          ? t("sidebarAgents.talksOnly", { name: names[0] })
          : chip
      : a.role);
  // Its title: who it is over what it does, whole ("Working · helping Ada · #sales · 22 min", "Back at 00:32 · #sales"):
  // the line under the name only says the status.
  const place =
    (work?.forAgentId || work?.state === "later") && work.channelId
      ? (work.channelName ?? channelName(work.channelId))
      : undefined;
  const doingTitle = doing
    ? [upperFirst(doing.text, i18n.language), doing.place, place && `#${place}`, doing.time].filter(Boolean).join(" · ")
    : null;
  const title = doingTitle
    ? `${[a.name, a.role].filter(Boolean).join(" · ")}\n${doingTitle}`
    : [a.name, a.role, now ?? word, line?.text].filter(Boolean).join(" · ");
  const roleTag = !locked && !out;
  // One line has no room under the name: who it talks to, or why it is out, goes in its title.
  const rowTitle = oneLine && under && under !== a.role ? `${title}\n${under}` : title;
  const face = (
    <AgentAvatar
      agentId={a.id}
      name={a.name}
      size="sm"
      presence={working && shown?.presence === "working" ? null : (shown?.presence ?? null)}
      presenceLabel={word ?? undefined}
      asleep={isOutOfOffice(shown?.line)}
      {...(waitingFor ? { state: "idle" as const, expression: "closed" as const } : {})}
    />
  );
  return (
    <div
      className="sidebar__row"
      data-agent-row={a.id}
      data-live={live || undefined}
      data-acts={edits ? 1 : undefined}
      {...arrival}
    >
      <Link
        onContextMenu={rowMenu.onContextMenu}
        to="/org/$orgId/dm/agent/$agentId"
        params={{ orgId: org.id, agentId: a.id }}
        className="sidebar__item"
        title={rowTitle}
        onMouseEnter={onPrefetch}
        onFocus={onPrefetch}
        onClick={onOpen}
        data-unread={unread > 0}
        data-busy={busy}
        data-presence={shown?.presence}
        {...drag}
        onKeyDown={keysInTurn(drag?.onKeyDown, rowMenu.onKeyDown)}
      >
        {working ? <OrbitGlyph appearance={lookOf(a)}>{face}</OrbitGlyph> : face}
        {oneLine ? (
          <>
            <span className="sidebar__item-label">{a.name}</span>
            <span className="sidebar__kind ac-tag" title={t("sidebarDms.agentTip")}>
              {t("sidebarDms.agentTag")}
            </span>
            {working && now && <span className="ac-visually-hidden">{now}</span>}
          </>
        ) : (
          <span className="sidebar__item-text">
            <span className={doing || under ? "sidebar__item-label ac-captop" : "sidebar__item-label"}>{a.name}</span>
            {/* What it is on, for screen readers, after its name (the orbit before it says it to the eye). */}
            {working && (state === "idle" && doingTitle ? doingTitle : now) && (
              <span className="ac-visually-hidden">{state === "idle" && doingTitle ? doingTitle : now}</span>
            )}
            {doing ? (
              <AgentWorkLine line={doing} className="sidebar__item-role" />
            ) : (
              under && <span className={cx("sidebar__item-role", roleTag && "ac-tag")}>{under}</span>
            )}
          </span>
        )}
        {unread > 0 ? (
          <UnreadCount count={unread} />
        ) : waitingFor && !doing ? (
          <span className="sidebar__item-meta sidebar__waiting" title={t("outage.sidebar.tip", { name: waitingFor })}>
            <Icon name="waiting" size={14} />
            {t("outage.sidebar.waiting")}
          </span>
        ) : pinned ? (
          <PinnedMark />
        ) : (
          chip && (
            <span className="sidebar__item-meta sidebar__item-meta--audience">
              <span
                className="sidebar__lock"
                role="img"
                aria-label={chip}
                title={audienceNotice(t, a, (id) => dir.memberById.get(id)?.name, dir.roleName) || chip}
              >
                <Icon name="lock" size={14} />
              </span>
            </span>
          )
        )}
      </Link>
      {edits && (
        <span className="sidebar__row-acts">
          <RowAction
            icon="cog"
            label={t("shell.sidebarMenu.agentSettings", { name: a.name })}
            onClick={() => {
              if (requestAgentPanel(a.id, "settings")) return;
              onOpen();
              void navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: org.id, agentId: a.id } });
            }}
          />
        </span>
      )}
    </div>
  );
}

/**
 * The team's right hand (ADR 0137), always the first row of Agents, a plain row like any agent's: its face, its name
 * over its label as a tag ("your right hand"), a one-time "New" until its DM first opens (in this browser), and its
 * DM's unread count. It opens the
 * person's DM with it. Never sorted, pinned, dragged or hidden; a closed AGENTES still shows it.
 */
function RightHandRow({
  agent: a,
  unread,
  line = false,
  onPrefetch,
  onOpen,
}: {
  agent: Agent;
  unread: number;
  /** One line, as Mensagens diretas' rows (ADR 0260): its label as the tag after the name. */
  line?: boolean;
  onPrefetch: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const fresh = rightHandSeen.useFresh(rightHandSeenKey(me.user.id, org.id));
  const shown = useAgentPresence(a.id);
  const label = t("rightHand.label");
  return (
    <Link
      to="/org/$orgId/dm/agent/$agentId"
      params={{ orgId: org.id, agentId: a.id }}
      className="sidebar__item"
      title={`${a.name} · ${label}`}
      onMouseEnter={onPrefetch}
      onFocus={onPrefetch}
      onClick={onOpen}
      data-unread={unread > 0}
      data-right-hand=""
    >
      <AgentAvatar agentId={a.id} name={a.name} size="sm" presence={shown?.presence ?? null} />
      {line ? (
        <>
          <span className="sidebar__item-label">{a.name}</span>
          <span className="sidebar__kind ac-tag">{label}</span>
        </>
      ) : (
        <span className="sidebar__item-text">
          <span className="sidebar__item-label ac-captop">{a.name}</span>
          <span className="sidebar__item-role ac-tag">{label}</span>
        </span>
      )}
      {unread > 0 ? (
        <UnreadCount count={unread} />
      ) : (
        fresh && (
          <span className="sidebar__item-meta sidebar__new">
            <span className="sidebar__new-dot" aria-hidden="true" />
            {t("rightHand.newDot")}
          </span>
        )
      )}
    </Link>
  );
}

/** A person under "Mensagens diretas": their face with its presence badge, the name; their line in the title (ADR 0084). */
function PersonRow({
  member: m,
  unread,
  onPrefetch,
  onOpen,
  rowProps,
}: {
  member: Member;
  unread: number;
  onPrefetch: () => void;
  onOpen: () => void;
  /** Its place among the favorites: dragging and Alt+Shift+↑/↓. */
  rowProps?: HTMLAttributes<HTMLAnchorElement>;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const shown = usePersonPresence(m.userId);
  const word = shown ? t(`presence.${shown.presence}`) : null;
  const line = shown?.status ? personLine(shown.status) : null;
  const personEntries = usePersonMenu();
  const menu = entityMenu(() => personEntries(m));
  return (
    <Link
      onContextMenu={menu.onContextMenu}
      to="/org/$orgId/dm/person/$userId"
      params={{ orgId: org.id, userId: m.userId }}
      className="sidebar__item"
      title={[m.name, word, line?.text].filter(Boolean).join(" · ")}
      data-unread={unread > 0}
      data-presence={shown?.presence}
      onMouseEnter={onPrefetch}
      onFocus={onPrefetch}
      onClick={onOpen}
      {...rowProps}
      onKeyDown={keysInTurn(rowProps?.onKeyDown, menu.onKeyDown)}
    >
      <Avatar
        name={m.name}
        size="sm"
        imageUrl={m.image}
        presence={shown?.presence ?? null}
        presenceLabel={word ?? undefined}
      />
      <span className="sidebar__item-label">{m.name}</span>
      {unread > 0 && <UnreadCount count={unread} />}
    </Link>
  );
}

/** An invitation not accepted yet (ADR 0260 §5): the invited address, a quiet "Convite enviado", no conversation yet. */
function InviteRow({ email }: { email: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <Link
      to="/org/$orgId/settings/$section"
      params={{ orgId: org.id, section: "members" }}
      className="sidebar__item sidebar__invite"
      title={t("sidebarDms.invitedTip", { email })}
    >
      <Avatar name={email} size="sm" />
      <span className="sidebar__item-label">{email}</span>
      <span className="sidebar__kind ac-tag">{t("sidebarDms.invited")}</span>
    </Link>
  );
}

/** Convidar pessoas, Novo agente: a row like the people's, an empty face with a plus where a face would be. */
function AddRow({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button type="button" className="sidebar__item sidebar__new-agent" onClick={onClick}>
      <span className="sidebar__new-agent-face" aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <span className="sidebar__item-label">{label}</span>
    </button>
  );
}

/**
 * The number on a row: in red what calls on me (a DM's unread messages, mentions of me in a channel), as Discord
 * counts; a channel's other unread messages in the kit's neutral count (`quiet`).
 */
function UnreadCount({
  count,
  mentions = false,
  quiet = false,
}: {
  count: number;
  mentions?: boolean;
  quiet?: boolean;
}) {
  const { t } = useTranslation();
  const props = {
    role: "img",
    "aria-label": t(mentions ? "shell.unreadMentions" : "shell.unread", { count }),
    children: badgeCount(count),
  };
  return quiet ? (
    <CountChip className="sidebar__unread sidebar__unread--quiet" {...props} />
  ) : (
    <CountBadge className="sidebar__unread" {...props} />
  );
}

/**
 * The account button: your face with your presence badge; under the name, your line (or how you appear). It opens a
 * menu right above it: you on top (face, name, @ and how you appear, your line in a well, a plan near its limit), then
 * your status (how you appear, or what you're up to), your profile, your settings (Configurações › Sua conta) and
 * signing out. The face on top changes your photo, as Editar perfil's Trocar foto does. Deleting the account starts at
 * the bottom of Sua conta, not here beside Sair, where a slip would open it. It and adding a password keep their
 * dialogs here, in the address (`?account=delete`, `?account=password`) on any page: adding a password may ask for a
 * sign-in again, which comes back.
 *
 * In a personal workspace (`personal`, ADR 0159) it is the sidebar's top row (face, name and ▾, no foot) and its menu,
 * opening down, also holds what the workspace menu held for one person: Your account, Settings and the person's
 * workspaces. Mounted once either way: the dialogs live here.
 */
/** Mints the person's link to the referral service and leaves for it (ADR 0192), as `useOpenBilling` does. */
function useOpenReferrals() {
  const { t } = useTranslation();
  const api = useApi();
  const toast = useToast();
  const here = useRouterState({ select: (s) => s.location.pathname });
  return useMutation({
    mutationFn: () => api.account.referralsLink(here),
    onSuccess: ({ url }) => navigateAway(url),
    onError: () => toast.show(t("referrals.failed"), "error"),
    meta: { silent: true },
  });
}

function AccountMenu({ personal = false }: { personal?: boolean }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const compact = useMediaQuery(COMPACT_QUERY);
  const saveStatus = useSaveStatus();
  const [profile, setProfile] = useState(false);
  const [photo, setPhoto] = useState(false);
  const [phone, setPhone] = useState(false);
  const [account, setAccount] = useOpenParam("account");
  const [statusOpen, setStatusOpen] = useState(false);
  const mounted = {
    profile: useEverTrue(profile),
    photo: useEverTrue(photo),
    phone: useEverTrue(phone),
    email: useEverTrue(account === "email"),
    password: useEverTrue(account === "password"),
    delete: useEverTrue(account === "delete"),
  };
  // The app's "Show QR code" for this server (Preferences › Servers).
  useEffect(() => {
    if (takePhoneAsk()) setPhone(true);
    return onPhoneAsk(() => {
      takePhoneAsk();
      setPhone(true);
    });
  }, []);
  // Forgot password › Continue on this Mac (ADR 0158): signed in now, the new password it came for.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the account menu mounts
  useEffect(() => {
    if (sessionStore.get(STORAGE_KEYS.newPasswordAsk) !== "1") return;
    sessionStore.remove(STORAGE_KEYS.newPasswordAsk);
    setAccount("password");
  }, []);
  const handle = dir.memberById.get(me.user.id)?.handle;
  // How you appear to yourself, read as the members column reads it (hidden stays hidden), and your line.
  const shown = usePersonPresence(me.user.id);
  const picked = shown?.person.availability;
  const presence = shown?.presence ?? null;
  const presenceWord = presence ? t(`presence.${presence}`) : undefined;
  const availability = picked ?? availabilityOf(shown?.presence);
  const line = shown?.status ? personLine(shown.status) : null;
  // Under your name: your line, or how you appear (Online, Ocupado, Ausente, Oculto) when you wrote none (ADR 0084).
  const who = [me.user.name, line?.text ?? presenceWord].filter(Boolean).join(" · ");
  const under = Boolean(line || presenceWord);

  const { signOut } = useSignOut();
  const referrals = useAuthConfig().data?.referralsUrl;
  const openReferrals = useOpenReferrals();
  const openSettings = (section?: SettingsSection) =>
    void (section
      ? navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section } })
      : navigate({ to: "/org/$orgId/settings", params: { orgId: org.id } }));
  // A dialog opens once the menu is gone and focus is back on this row, so closing the dialog lands here too.
  const afterMenu = useRef<(() => void) | null>(null);
  const openAfter = (open: () => void) => () => {
    afterMenu.current = open;
  };
  // How you appear, then what you're up to: the dialog, with your line in it when you wrote one (it shows on top).
  const statusChoices = (
    <>
      <MenuRadioGroup
        label={t("presence.appearAs")}
        value={availability}
        onValueChange={(v) => v !== availability && saveStatus({ availability: v as Availability })}
        options={AVAILABILITIES.map((a) => ({
          value: a,
          label: t(`presence.${presenceOfAvailability(a)}`),
          leading: <PresenceBadge presence={presenceOfAvailability(a)} size="lg" ring={false} />,
        }))}
      />
      <MenuSeparator />
      <MenuItem icon="message" onSelect={openAfter(() => setStatusOpen(true))}>
        {t("presence.placeholder")}
      </MenuItem>
    </>
  );

  return (
    <>
      <Menu
        side={personal ? "bottom" : "top"}
        className="profile-menu"
        onClosed={() => {
          afterMenu.current?.();
          afterMenu.current = null;
        }}
        trigger={
          personal ? (
            // On top, as the workspace's header is in a team's: the face (how you appear on it) and the name.
            <button
              type="button"
              className="sidebar__org-button sidebar__org-button--me"
              aria-label={`${t("shell.account")}: ${who}`}
              title={who}
            >
              <MyFace size="sm" presence={presence} presenceLabel={presenceWord} />
              <span className="sidebar__org-text">
                <span className="sidebar__org-name">{me.user.name}</span>
              </span>
              <Icon name="chevronDown" size={16} />
            </button>
          ) : (
            <button
              type="button"
              // The face stands beside the lines under it (your status line): the name's capitals at its top. A name
              // alone (while how you appear loads) centres on it.
              className={cx("sidebar__user", under && "ac-faceline")}
              aria-label={`${t("shell.account")}: ${who}`}
              title={who}
            >
              <MyFace size="sm" presence={presence} presenceLabel={presenceWord} />
              <span className="sidebar__user-text">
                <span className={cx("sidebar__user-name", under && "ac-captop")}>{me.user.name}</span>
                {line ? (
                  <StatusLine emoji={line.emoji} text={line.text} className="sidebar__user-line" />
                ) : (
                  presenceWord && <StatusLine text={presenceWord} className="sidebar__user-line" />
                )}
              </span>
            </button>
          )
        }
      >
        <div className="profile-card__head profile-menu__head">
          <MenuFace label={t("photo.change")} onSelect={openAfter(() => setPhoto(true))}>
            <MyFace size="lg" presence={presence} presenceLabel={presenceWord} />
          </MenuFace>
          <span className="list-col">
            <span className="profile-card__name ac-captop">{me.user.name}</span>
            <span className="small muted">{[handle && `@${handle}`, presenceWord].filter(Boolean).join(" · ")}</span>
          </span>
        </div>
        {line && shown?.status && (
          <div className="profile-card__status profile-menu__line">
            <span className="profile-card__status-emoji" aria-hidden="true">
              {line.emoji}
            </span>
            <span>
              {line.text}
              <small>{statusEndNote(t, i18n.language, shown.status.until, true)}</small>
            </span>
          </div>
        )}
        <PlanNearLimitItem />
        <MenuSeparator />
        {/* A phone has no room beside the menu for another one: there the choices are in it. */}
        {compact ? (
          <>
            {statusChoices}
            <MenuSeparator />
          </>
        ) : (
          <MenuSub icon="smile" label={t("presence.setStatus")}>
            {statusChoices}
          </MenuSub>
        )}
        <MenuItem icon="edit" onSelect={openAfter(() => setProfile(true))}>
          {t("shell.editProfile")}
        </MenuItem>
        {personal && (
          <MenuItem icon="person" onSelect={() => openSettings("account")}>
            {t("settings.section.account")}
          </MenuItem>
        )}
        {/* In a personal workspace: every section, what a team's workspace menu opens. In a team's: Your account. */}
        <MenuItem icon="settings" onSelect={() => openSettings(personal ? undefined : "account")}>
          {t("shell.settings")}
        </MenuItem>
        {referrals && (
          <MenuItem icon="coin" disabled={openReferrals.isPending} onSelect={() => openReferrals.mutate()}>
            {t("referrals.open")}
          </MenuItem>
        )}
        {import.meta.env.DEV && (
          <MenuItem icon="grid" onSelect={() => void navigate({ to: "/dev/gallery" })}>
            {t("shell.gallery")}
          </MenuItem>
        )}
        {personal && (
          <>
            <MenuSeparator />
            <MenuWorkspaces />
          </>
        )}
        <MenuSeparator />
        <MenuItem icon="arrowRight" danger onSelect={() => void signOut()}>
          {t("auth.signOut")}
        </MenuItem>
      </Menu>
      <SetStatusDialog open={statusOpen} onClose={() => setStatusOpen(false)} />
      <Suspense fallback={null}>
        {mounted.profile && <ProfileDialog focus={profile ? "name" : null} onClose={() => setProfile(false)} />}
        {mounted.photo && <ChangeAvatarDialog open={photo} onClose={() => setPhoto(false)} />}
        {mounted.phone && <OpenOnPhoneDialog open={phone} onClose={() => setPhone(false)} />}
        {mounted.email && <EmailDialog open={account === "email"} onClose={() => setAccount(null)} />}
        {mounted.password && <AddPasswordDialog open={account === "password"} onClose={() => setAccount(null)} />}
        {mounted.delete && <DeleteAccountDialog open={account === "delete"} onClose={() => setAccount(null)} />}
      </Suspense>
    </>
  );
}

/**
 * A workspace in your lists of them (ADR 0159): a personal one of yours is you, by your photo and your name, as its
 * sidebar shows you; with more than one, your photo and each one's own name (the same name on each would tell them
 * apart by nothing). Its line (`sub`) says it is personal where the full menu shows your role in a team's, so its row
 * is the same two lines as theirs. Any other (a team's, or a personal one shared with you, whose face would be someone
 * else's) by its mark and its name.
 */
function useWorkspaceLook() {
  const { t } = useTranslation();
  const { me } = useOrg();
  const mine = (id: string) => {
    const o = me.organizations.find((m) => m.id === id);
    return o !== undefined && isPersonal(o) && o.role === "owner";
  };
  const several = me.organizations.filter((o) => mine(o.id)).length > 1;
  return (
    o: { id: string; name: string; logo?: string | null; accent?: string | null },
    face: "sm" | "md",
    mark: number,
  ) =>
    mine(o.id)
      ? {
          leading: <Avatar kind="person" name={me.user.name} imageUrl={me.user.image} size={face} />,
          name: several ? o.name : me.user.name,
          sub: t("settings.mode.personal"),
          personal: true,
        }
      : {
          // Each workspace in its own accent: the engine's `sky` is the active one's.
          leading: <OrgMark logo={o.logo} accent={o.accent ?? null} size={mark} />,
          name: o.name,
          sub: null,
          personal: false,
        };
}

/**
 * Your workspaces in the account menu of a personal workspace (ADR 0159): the workspace menu's list, then New
 * workspace when the person may make one. In the desktop app (ADR 0154) by server, then Add workspace; New workspace
 * (it makes one here) sits under this server's workspaces only on a server of one's own, since on agentes.chat Add
 * workspace makes one (`offersNewWorkspace`). Mounted only while the menu is open: the counts load then. One line a
 * row (no role, no "Personal" under it): one person's own workspaces.
 */
function MenuWorkspaces() {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const look = useWorkspaceLook();
  const notes = workspaceNotes(t, i18n.language, me.organizations);
  const groups = useWorkspaceGroups({ orgs: me.organizations, currentOrgId: org.id });
  const api = useApi();
  const navigate = useNavigate();
  const go = (orgId: string) => void navigate({ to: "/org/$orgId", params: { orgId } });
  const newWorkspace = offersNewWorkspace(me.user.canCreateWorkspace, groups) && (
    <MenuItem icon="plus" onSelect={() => void navigate({ to: "/onboarding" })}>
      {t("shell.newWorkspace")}
    </MenuItem>
  );
  const addAccount = (
    <MenuItem
      icon="plus"
      description={t("shell.addAccountHint")}
      onSelect={() => void navigate({ to: "/login", search: { add: true } })}
    >
      {t("shell.addAccount")}
    </MenuItem>
  );
  if (groups)
    return (
      <>
        <MenuHeading>{t("shell.yourWorkspaces")}</MenuHeading>
        {groups.map((g) => (
          <Fragment key={groupKey(g)}>
            {groups.length > 1 && <MenuHeading>{groupTitle(t, g)}</MenuHeading>}
            {accountAlone(g) && (
              <MenuItem
                leading={<Avatar kind="person" name={g.account.name} size="sm" />}
                onSelect={() => void switchAccount(api, g.account.userId).catch(() => {})}
              >
                {g.account.name}
              </MenuItem>
            )}
            {g.rows.map((o) => {
              const shown = g.here ? look(o, "sm", 20) : look({ ...o, id: "" }, "sm", 20);
              return (
                <MenuItem
                  key={o.id}
                  leading={shown.leading}
                  description={(g.here && notes.get(o.id)) || undefined}
                  hint={
                    o.current ? t("shell.youAreHere") : o.unread > 0 ? <CountChip>{o.unread}</CountChip> : undefined
                  }
                  onSelect={() => {
                    if (g.here) {
                      if (!o.current) go(o.id);
                    } else openElsewhere(api, g, o.id);
                  }}
                >
                  {shown.name}
                </MenuItem>
              );
            })}
            {g.here && newWorkspace}
          </Fragment>
        ))}
        {groups.some((g) => g.desktop) && (
          <MenuItem
            icon="plus"
            description={t("shell.addWorkspaceHint")}
            onSelect={() => void thisMac.addWorkspace().catch(() => {})}
          >
            {t("shell.addWorkspace")}
          </MenuItem>
        )}
        {addAccount}
      </>
    );
  return (
    <>
      <MenuHeading>{t("shell.yourWorkspaces")}</MenuHeading>
      {me.organizations.map((o) => {
        const shown = look(o, "sm", 20);
        return (
          <MenuItem
            key={o.id}
            leading={shown.leading}
            description={notes.get(o.id)}
            hint={o.id === org.id ? t("shell.youAreHere") : undefined}
            onSelect={() => o.id !== org.id && go(o.id)}
          >
            {shown.name}
          </MenuItem>
        );
      })}
      {newWorkspace}
      {addAccount}
    </>
  );
}

/** A group's key in "Your workspaces": a server has one group per account (ADR 0183). */
const groupKey = (g: WorkspaceGroup) => `${g.server} ${g.account?.userId ?? ""}`;

/**
 * A group's line in "Your workspaces" as words: its server in the desktop app (ADR 0154), and whose account it is
 * where a server has several (ADR 0183); outside the app there is one server, so the account alone.
 */
function groupTitle(t: TFunction, g: WorkspaceGroup): string {
  if (!g.desktop) return g.account?.email ?? g.name;
  const server = g.cloud ? g.name : `${g.name} · ${t("shell.yourServer")}`;
  return g.several && g.account ? `${server} · ${g.account.email}` : server;
}

/** Another account of this browser with no workspace yet: its own row is the way to it. */
const accountAlone = (g: WorkspaceGroup): g is WorkspaceGroup & { account: NonNullable<WorkspaceGroup["account"]> } =>
  g.sameServer && !g.here && g.account !== null && g.rows.length === 0;

/**
 * Opens a workspace that isn't the open account's: another account of this browser on this server (the browser moves
 * to it, ADR 0183), or another server of the desktop app (the window goes there, as the account it belongs to).
 */
function openElsewhere(api: ApiClient, g: WorkspaceGroup, orgId: string) {
  if (g.sameServer && g.account) void switchAccount(api, g.account.userId, `/org/${orgId}`).catch(() => {});
  else void thisMac.openWorkspace(g.server, orgId, g.account?.userId).catch(() => {});
}

/**
 * In the account menu, the one of your plans near or at its limit (from `PLAN_ALMOST`, 80%: "Quase no limite"), at
 * its limit first: its maker's mark, its name and its state, opening Configurações › Uso. Nothing otherwise. Your
 * accounts are read, and their usage looked up again (it comes back as `machine.updated`), when the menu opens.
 */
function PlanNearLimitItem() {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const plan = planNearLimit(ownPlanLines(t, useAiAccounts(org.id).data, dir.agents, me.user.id));
  useEffect(() => {
    void api.machines.refreshAccountUsage(org.id).catch(() => undefined);
  }, [api, org.id]);
  if (!plan) return null;
  return (
    <MenuItem
      leading={<ProviderLogo id={plan.logo} size="xs" />}
      hint={planWord(t, i18n.language, plan.usage)}
      onSelect={() =>
        void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section: "usage" } })
      }
    >
      <span className="profile-menu__plan">{plan.name}</span>
    </MenuItem>
  );
}

/**
 * The workspace header ("Acme · 2 membros · 3 agentes") opens the workspace's
 * full-screen menu: invite, members, connectors,
 * agents' access, skills and settings as far as the role allows, then the
 * other workspaces to switch to.
 */
function WorkspaceMenu({ summary }: { summary: string | null }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const place = useServerPlace();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="sidebar__org-button"
        aria-haspopup="dialog"
        aria-label={t("shell.workspaceMenuOf", { name: org.name })}
        onClick={() => setOpen(true)}
      >
        <OrgMark logo={org.logo} className="sidebar__org-mark" />
        <span className="sidebar__org-text">
          <span className="sidebar__org-name">{org.name}</span>
          {(place || summary) && (
            <span className="sidebar__org-line">
              {/* Where it lives, before its counts: the Cloud, this computer or one's own server. */}
              {place && (
                <span className="sidebar__org-where">
                  <Icon name={SERVER_PLACE_ICON[place]} size={14} />
                  {t(`hosting.badge.${place}`)}
                </span>
              )}
              {summary && <span className="sidebar__org-meta">{summary}</span>}
            </span>
          )}
        </span>
        <Icon name="chevronDown" size={16} />
      </button>
      <MenuOverlay
        open={open}
        onOpenChange={setOpen}
        anchor={trigger}
        closeLabel={t("common.close")}
        backdrop={<MenuHorizon />}
        mark={<OrgMark logo={org.logo} size={82} />}
        title={org.name}
        meta={
          <>
            {summary}
            {/* The agents the summary counts: the right hand isn't one of them, so no face beside "0 agents". */}
            {dir.agents.some((a) => !isRightHand(a)) && (
              <span className="sidebar__menu-crew">
                {dir.agents
                  .filter((a) => !isRightHand(a))
                  .slice(0, 4)
                  .map((a) => (
                    <AgentAvatar key={a.id} agent={a} name={a.name} size="xs" />
                  ))}
              </span>
            )}
          </>
        }
      >
        <WorkspaceMenuOptions onDone={() => setOpen(false)} />
      </MenuOverlay>
    </>
  );
}

/** The workspace menu's options (mounted only while open: the counts load then). */
function WorkspaceMenuOptions({ onDone }: { onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const look = useWorkspaceLook();
  const notes = workspaceNotes(t, i18n.language, me.organizations);
  const groups = useWorkspaceGroups({ orgs: me.organizations, currentOrgId: org.id });
  const api = useApi();
  const navigate = useNavigate();
  const overview = useOverview(org.id);
  const managesAgents = can(org, "manage_agents");
  const connections = useConnections(org.id);
  const skills = useSkills(org.id);
  const invite = useInviteDialog();
  const go = (section?: SettingsSection) => () => {
    onDone();
    void (section
      ? navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section } })
      : navigate({ to: "/org/$orgId/settings", params: { orgId: org.id } }));
  };
  // The workspace's invite dialog (ADR 0090), over the page this menu was opened on.
  const inviteNow = () => {
    if (invite) {
      onDone();
      invite.open();
    } else go("members")();
  };
  const newWorkspace = offersNewWorkspace(me.user.canCreateWorkspace, groups) && (
    <MenuOverlayItem
      icon="plus"
      onSelect={() => {
        onDone();
        void navigate({ to: "/onboarding" });
      }}
    >
      {t("shell.newWorkspace")}
    </MenuOverlayItem>
  );
  const addAccount = (
    <MenuOverlayItem
      icon="plus"
      description={t("shell.addAccountHint")}
      onSelect={() => {
        onDone();
        void navigate({ to: "/login", search: { add: true } });
      }}
    >
      {t("shell.addAccount")}
    </MenuOverlayItem>
  );
  let key = 0;
  const next = () => String(++key);
  return (
    <>
      <MenuOverlayGroup label={t("shell.workspaceMenuOf", { name: org.name })}>
        {can(org, "invite_people") && (
          <MenuOverlayItem icon="plus" shortcut={next()} description={t("shell.inviteHint")} onSelect={inviteNow}>
            {t("shell.invite")}
          </MenuOverlayItem>
        )}
        <MenuOverlayItem icon="members" shortcut={next()} count={overview.data?.people} onSelect={go("members")}>
          {t("shell.members")}
        </MenuOverlayItem>
        <MenuOverlayItem
          icon="plug"
          shortcut={next()}
          count={connections.data?.length || undefined}
          onSelect={go("connectors")}
        >
          {t("settings.section.connectors")}
        </MenuOverlayItem>
        {managesAgents && (
          <MenuOverlayItem icon="agent" shortcut={next()} onSelect={go("access")}>
            {t("settings.section.access")}
          </MenuOverlayItem>
        )}
        <MenuOverlayItem icon="book" shortcut={next()} count={skills.data?.length || undefined} onSelect={go("skills")}>
          {t("settings.section.skills")}
        </MenuOverlayItem>
        <MenuOverlayItem icon="settings" shortcut={next()} onSelect={go()}>
          {t("shell.workspaceSettings")}
        </MenuOverlayItem>
      </MenuOverlayGroup>
      <MenuOverlayGroup heading={t("shell.yourWorkspaces")}>
        {groups ? (
          <>
            {/* The desktop app (ADR 0154): every server's workspaces, by server, each with its unread count. */}
            {groups.map((g) => (
              <Fragment key={groupKey(g)}>
                {groups.length > 1 && !g.desktop && (
                  // Outside the app there is one server: each group is one of the browser's accounts (ADR 0183).
                  <span className="sidebar__menu-server">{g.account?.email ?? g.name}</span>
                )}
                {groups.length > 1 && g.desktop && (
                  <span className="sidebar__menu-server" data-state={g.state}>
                    <Icon name={g.cloud ? "cloud" : g.thisComputer ? "computer" : "globe"} size={14} />
                    {g.thisComputer ? t("shell.serverHere") : g.name}
                    {g.several && g.account && <em>· {g.account.email}</em>}
                    {/* Its state as words in the line, never a pill (ADR 0158): stopped, offline since, signed out. */}
                    {g.state === "offline" ? (
                      <em className="sidebar__menu-server-state">
                        ·{" "}
                        {g.thisComputer
                          ? t("shell.serverStopped")
                          : t("shell.serverOffline", {
                              time: formatTime(i18n.language, new Date(g.offlineSince ?? Date.now()).toISOString()),
                            })}
                      </em>
                    ) : g.state === "signedOut" ? (
                      <>
                        <em className="sidebar__menu-server-state">· {t("shell.serverSignedOut")} ·</em>
                        <button
                          type="button"
                          className="ac-link"
                          onClick={() => {
                            onDone();
                            void thisMac.openServer(g.server).catch(() => thisMac.otherServer().catch(() => {}));
                          }}
                        >
                          {t("shell.serverSignIn")}
                        </button>
                      </>
                    ) : (
                      !g.cloud && !g.thisComputer && <em>· {t("shell.yourServer")}</em>
                    )}
                  </span>
                )}
                {accountAlone(g) && (
                  <MenuOverlayItem
                    leading={<Avatar kind="person" name={g.account.name} size="md" />}
                    onSelect={() => {
                      onDone();
                      void switchAccount(api, g.account.userId).catch(() => {});
                    }}
                  >
                    {g.account.name}
                  </MenuOverlayItem>
                )}
                {g.rows.map((o) => {
                  const here = g.here ? me.organizations.find((m) => m.id === o.id) : undefined;
                  const shown = look(here ? o : { ...o, id: "" }, "md", 32);
                  return (
                    <MenuOverlayItem
                      key={o.id}
                      leading={
                        // A server not answering: its last workspaces, dimmed.
                        <span className={g.state === "offline" ? "sidebar__menu-dim" : undefined}>{shown.leading}</span>
                      }
                      description={
                        here
                          ? [shown.personal ? shown.sub : t(`roles.${here.role}`), notes.get(o.id)]
                              .filter(Boolean)
                              .join(" · ") || undefined
                          : undefined
                      }
                      current={o.current}
                      hint={
                        o.current ? t("shell.youAreHere") : o.unread > 0 ? <CountChip>{o.unread}</CountChip> : undefined
                      }
                      onSelect={() => {
                        onDone();
                        if (!g.here) openElsewhere(api, g, o.id);
                        else if (!o.current) void navigate({ to: "/org/$orgId", params: { orgId: o.id } });
                      }}
                    >
                      {shown.name}
                    </MenuOverlayItem>
                  );
                })}
                {g.here && newWorkspace}
              </Fragment>
            ))}
            <MenuOverlaySeparator />
            {groups.some((g) => g.desktop) && (
              <MenuOverlayItem
                icon="plus"
                description={t("shell.addWorkspaceHint")}
                onSelect={() => {
                  onDone();
                  void thisMac.addWorkspace().catch(() => {});
                }}
              >
                {t("shell.addWorkspace")}
              </MenuOverlayItem>
            )}
            {addAccount}
          </>
        ) : (
          <>
            {me.organizations.map((o) => {
              const shown = look(o, "md", 32);
              return (
                <MenuOverlayItem
                  key={o.id}
                  leading={shown.leading}
                  description={
                    [shown.personal ? shown.sub : t(`roles.${o.role}`), notes.get(o.id)].filter(Boolean).join(" · ") ||
                    undefined
                  }
                  current={o.id === org.id}
                  hint={o.id === org.id ? t("shell.youAreHere") : undefined}
                  onSelect={() => {
                    onDone();
                    if (o.id !== org.id) void navigate({ to: "/org/$orgId", params: { orgId: o.id } });
                  }}
                >
                  {shown.name}
                </MenuOverlayItem>
              );
            })}
            <MenuOverlaySeparator />
            {newWorkspace}
            {addAccount}
          </>
        )}
      </MenuOverlayGroup>
    </>
  );
}
