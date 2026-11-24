import {
  type Agent,
  type Edition,
  type FormerAgent,
  type Member,
  type OrgRole,
  type RealtimeConnection,
  useAllAgents,
  useAuthConfig,
  useComputerSetup,
  useFormerAgents,
  useMachines,
  useMe,
  useMembers,
  useRoles,
} from "@agenteschat/client";
import { type AgentOwnerLike, ownsAgentAs } from "@agenteschat/client/lib/agent-owner";
import { computerEdition } from "@agenteschat/client/lib/computer";
import { formerById } from "@agenteschat/client/lib/directory";
import { errorText } from "@agenteschat/client/lib/errors";
import { clockHour } from "@agenteschat/client/lib/format";
import { namesComputers } from "@agenteschat/client/lib/machines";
import { NavigationContext } from "expo-router/react-navigation";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState, type AppStateStatus } from "react-native";
import { useOrgId } from "@/providers/org";
import { useRealtime } from "@/providers/realtime";
import { haptics, rememberAgentLooks, useTheme, useToast } from "@/ui";
import { usePane } from "@/ui/pane";
import { agentLook, daysAgo, type PacedClock, pacedClock, whenKind } from "./logic";
import { roleIdsOf } from "./owner";

/** The current organization's id, from its own context: a change of `me` doesn't draw its readers again. */
export { useOrgId };

/**
 * Which words the computers get here: the Cloud's or self-host's (`computerEdition`). The server's
 * `workspaceComputer` until the workspace's setup answers, so it is known from boot; null while neither has said.
 */
export function useEdition(): Edition | null {
  return computerEdition(useComputerSetup(useOrgId()).data, useAuthConfig().data?.workspaceComputer);
}

/** Whether lines about where things run name the computer here (`namesComputers`); false while the list loads. */
export function useNamesComputers(): boolean {
  return namesComputers(useMachines(useOrgId()).data);
}

/** The signed-in person's id (null while it loads). */
export function useMeId(): string | null {
  return useMe().data?.user.id ?? null;
}

/** The signed-in person's @handle in this organization, lower-cased (null while it loads). */
export function useMyHandle(): string | null {
  const meId = useMeId();
  const members = useMembers(useOrgId());
  return members.data?.find((m) => m.userId === meId)?.handle?.toLowerCase() || null;
}

export interface Directory {
  agents: Agent[];
  agentById: Map<string, Agent>;
  /** The team's agent, or one no longer in it (archived or deleted): what it left still names it. */
  anyAgent: (id: string) => Agent | undefined;
  memberById: Map<string, Member>;
  /** People by lower-cased @handle. */
  memberByHandle: Map<string, Member>;
  loading: boolean;
  /** A person's or an agent's name ("" when unknown). */
  nameOf: (who: { type: string; id: string | null } | null | undefined) => string;
}

/** Stands for a list not loaded yet, as a key of `directories` and as the empty list itself. */
const NO_AGENTS: Agent[] = [];
const NO_FORMER: FormerAgent[] = [];
const NO_MEMBERS: Member[] = [];

type DirectoryMaps = Omit<Directory, "loading">;

/** One set of lists' directory: its maps, and the object handed out while they load and once they have. */
interface KeptDirectory {
  maps?: DirectoryMaps;
  loading?: Directory;
  loaded?: Directory;
}

/**
 * Directories by the lists they read (the query cache's arrays, a new one only when a list changes), then by whether
 * they still load. Hundreds of rows and screens ask for one: each set of lists is turned into maps once for all of
 * them, and they all hold the same object.
 */
const directories = new WeakMap<Agent[], WeakMap<FormerAgent[], WeakMap<Member[], KeptDirectory>>>();

/** `agents` is what lists and pickers offer (`listed`); the lookups also resolve an agent unlisted to me. */
function directoryMaps(all: Agent[], former: FormerAgent[], members: Member[]): DirectoryMaps {
  const agents = all.filter((a) => a.listed !== false);
  const agentById = new Map(all.map((a) => [a.id, a]));
  const gone = formerById(former);
  const anyAgent = (id: string) => agentById.get(id) ?? gone.get(id);
  const memberById = new Map(members.map((m) => [m.userId, m]));
  const memberByHandle = new Map(members.filter((m) => m.handle).map((m) => [m.handle.toLowerCase(), m]));
  return {
    agents,
    agentById,
    anyAgent,
    memberById,
    memberByHandle,
    nameOf: (who) => {
      if (!who?.id) return "";
      return who.type === "agent" ? (anyAgent(who.id)?.name ?? "") : (memberById.get(who.id)?.name ?? "");
    },
  };
}

function directoryOf(agents: Agent[], former: FormerAgent[], members: Member[], loading: boolean): Directory {
  let byFormer = directories.get(agents);
  if (!byFormer) {
    byFormer = new WeakMap();
    directories.set(agents, byFormer);
  }
  let byMembers = byFormer.get(former);
  if (!byMembers) {
    byMembers = new WeakMap();
    byFormer.set(former, byMembers);
  }
  let kept = byMembers.get(members);
  if (!kept) {
    kept = {};
    byMembers.set(members, kept);
  }
  const maps = kept.maps ?? directoryMaps(agents, former, members);
  kept.maps = maps;
  const made = (loading ? kept.loading : kept.loaded) ?? { ...maps, loading };
  if (loading) kept.loading = made;
  else kept.loaded = made;
  return made;
}

/** Agents and people of the organization, by id: one object for every caller while the lists stay the same. */
export function useDirectory(): Directory {
  const orgId = useOrgId();
  const agents = useAllAgents(orgId);
  const former = useFormerAgents(orgId);
  const members = useMembers(orgId);
  return directoryOf(
    agents.data ?? NO_AGENTS,
    former.data ?? NO_FORMER,
    members.data ?? NO_MEMBERS,
    agents.isLoading || members.isLoading,
  );
}

/** The signed-in person's roles (their member row's), for `ownsAgentAs`; none while they load. */
export function useMyRoleIds(): readonly string[] {
  return roleIdsOf(useDirectory().memberById, useMeId());
}

/**
 * Whether I answer for an agent: its owner, or holding the role that answers for it (the server's `ownsAgent`, ADR
 * 0085, addendum of 2026-11-21).
 */
export function useOwnsAgent() {
  const meId = useMeId();
  const roleIds = useMyRoleIds();
  return useCallback(
    (a: AgentOwnerLike | null | undefined) => Boolean(a && meId && ownsAgentAs(a, meId, roleIds)),
    [meId, roleIds],
  );
}

/** The workspace's roles, for the name and mark of a role that answers for an agent (undefined while they load). */
export function useOwnerRoles(): OrgRole[] | undefined {
  return useRoles(useOrgId()).data?.roles;
}

/** Toasts and other places that only know an agent's id draw it from these looks (once, at the app's root). */
export function useRememberAgentLooks() {
  const agents = useAllAgents(useOrgId());
  useEffect(() => {
    if (agents.data) rememberAgentLooks(agents.data.map((a) => ({ id: a.id, ...agentLook(a) })));
  }, [agents.data]);
}

/** The organization's WebSocket (null without one; stopped while the app is in the background). */
export function useConnection(): RealtimeConnection | null {
  return useRealtime().connection;
}

/** Theme colors by token name (`bg`, `raised`, `sunken`, `line`, `ink`, `muted`, `faint`, `agent`, `danger`…). */
export function useColors() {
  return useTheme().colors;
}

/** The formats `useWhen` writes times in, for one language. */
interface WhenFormats {
  time: Intl.DateTimeFormat;
  weekday: Intl.DateTimeFormat;
  date: Intl.DateTimeFormat;
  day: Intl.DateTimeFormat;
}

/**
 * Made once per language and kept: a format is costly to build (it reads the language's data), and every row of a
 * list asks for its time through `useWhen`.
 */
const whenFormats = new Map<string, WhenFormats>();

function whenFormatsOf(locale: string): WhenFormats {
  let formats = whenFormats.get(locale);
  if (!formats) {
    formats = {
      time: new Intl.DateTimeFormat(locale, { hour: clockHour(locale), minute: "2-digit" }),
      weekday: new Intl.DateTimeFormat(locale, { weekday: "short" }),
      date: new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }),
      day: new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" }),
    };
    whenFormats.set(locale, formats);
  }
  return formats;
}

/** Times as the lists say them: "9:41" today, "Ontem", "seg", "12 out". */
export function useWhen() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || "en";
  return useMemo(() => {
    const formats = whenFormatsOf(locale);
    const time = (iso: string) => formats.time.format(new Date(iso));
    const short = (iso: string) => {
      switch (whenKind(iso)) {
        case "time":
          return time(iso);
        case "yesterday":
          return t("mobile.time.yesterday");
        case "weekday":
          return formats.weekday.format(new Date(iso)).replace(".", "");
        case "date":
          return formats.date.format(new Date(iso)).replace(".", "");
      }
    };
    const day = (iso: string) => {
      const d = daysAgo(iso);
      if (d <= 0) return t("mobile.time.today");
      if (d === 1) return t("mobile.time.yesterday");
      return formats.day.format(new Date(iso));
    };
    return { time, short, day, locale };
  }, [t, locale]);
}

/** Whether the app is in use: not in the background, nor behind the system's app switcher or control center. */
const inUse = (state: AppStateStatus | null) => state !== "background" && state !== "inactive";

const appUseListeners = new Set<(state: AppStateStatus) => void>();
let appUseSub: { remove(): void } | null = null;

/** Tells `listener` the app's new state as it changes; one system listener for every clock. */
function onAppUse(listener: (state: AppStateStatus) => void): () => void {
  appUseListeners.add(listener);
  appUseSub ??= AppState.addEventListener("change", (state) => {
    for (const l of appUseListeners) l(state);
  });
  return () => {
    appUseListeners.delete(listener);
    if (appUseListeners.size === 0) {
      appUseSub?.remove();
      appUseSub = null;
    }
  };
}

/**
 * The current time, refreshed every `ms` (fuses, "expira em", clocks). A new `ms` reads it afresh in the render that
 * asks for it (`pacedClock`), so that render never shows the old pace's time. It stops while its screen is hidden (a
 * screen pushed over it, a tab not shown) and while the app is away, and reads the time again when it shows: every
 * tab is mounted at launch and a covered screen is never frozen, so a hidden clock would keep drawing at its pace.
 */
export function useNow(ms = 30_000): number {
  const [clock, setClock] = useState<PacedClock>(() => ({ every: ms, now: Date.now() }));
  const paced = pacedClock(clock, ms, Date.now());
  if (paced !== clock) setClock(paced);
  // The screen's navigation, read without following its state; none outside a screen (it then runs while in use).
  const navigation = useContext(NavigationContext);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let shown = navigation?.isFocused() ?? true;
    const read = () => setClock({ every: ms, now: Date.now() });
    // `again`: coming back, the time kept is old; on mount it was just read.
    // React Native types `currentState` as a plain string; it is one of the statuses.
    const follow = (again: boolean, app: AppStateStatus | null = AppState.currentState as AppStateStatus) => {
      const run = shown && inUse(app);
      if (run && !timer) {
        if (again) read();
        timer = setInterval(read, ms);
      } else if (!run && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    follow(false);
    const offApp = onAppUse((state) => follow(true, state));
    const offFocus = navigation?.addListener("focus", () => {
      shown = true;
      follow(true);
    });
    const offBlur = navigation?.addListener("blur", () => {
      shown = false;
      follow(true);
    });
    return () => {
      offApp();
      offFocus?.();
      offBlur?.();
      if (timer) clearInterval(timer);
    };
  }, [ms, navigation]);
  return paced.now;
}

/** The longest a screen waits for its push to end before what moves on it starts anyway. */
const PUSH_END_MAX_MS = 900;

/** The one stack event `usePushEnded` reads (the native stack's `transitionEnd`, which the plain context type omits). */
type TransitionEvents = { addListener(event: "transitionEnd", listener: () => void): () => void };

/**
 * False until the screen's push has ended (its stack's `transitionEnd`): what moves on it (a sky, a living face) starts
 * then, so the slide has the threads to itself. A screen shown without a slide, or outside a stack, starts after
 * `PUSH_END_MAX_MS` at the latest; one in a split's pane (ADR 0212), which nothing slides in, at once.
 */
export function usePushEnded(): boolean {
  const navigation = useContext(NavigationContext) as unknown as TransitionEvents | undefined;
  const inPane = usePane() !== null;
  const [ended, setEnded] = useState(inPane);
  useEffect(() => {
    if (ended) return;
    const end = () => setEnded(true);
    const timer = setTimeout(end, PUSH_END_MAX_MS);
    const off = navigation?.addListener("transitionEnd", end);
    return () => {
      clearTimeout(timer);
      off?.();
    };
  }, [ended, navigation]);
  return ended;
}

/**
 * Pull to refresh that spins only for the person's own pull. Driving `RefreshControl` from a query's
 * `isRefetching` made every background refetch (realtime, polling, focus) start the spinner from code,
 * and on iOS that moves the scroll view by the spinner's height without counting the native header's
 * inset: the content slid up under the large title.
 */
export function usePullRefresh(refetch: () => Promise<unknown>): { refreshing: boolean; onRefresh: () => void } {
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(refetch);
  useEffect(() => {
    latest.current = refetch;
  });
  const onRefresh = useCallback(() => {
    // One light tap on the frame the pull catches (the spinner locks in), as the system's own lists do: the release
    // is felt as well as seen.
    haptics.light();
    setRefreshing(true);
    void Promise.resolve()
      .then(() => latest.current())
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  }, []);
  return { refreshing, onRefresh };
}

/** A failed request's toast: its reason in the person's words (`errorText`), never a bare "try again". */
export function useErrorToast() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  return useCallback(
    (error: unknown) => toast({ title: errorText(t, error, i18n.language), icon: "x" }),
    [t, i18n.language, toast],
  );
}
