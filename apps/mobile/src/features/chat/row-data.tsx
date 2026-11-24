import { type OrgRole, type RunConsultation, useConsultations, useRoles } from "@agenteschat/client";
import { asExchanges, groupsByRun } from "@agenteschat/client/lib/consult-group";
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useOrgMaybe } from "@/providers/org";
import { type Directory, useDirectory, useMeId, useMyHandle, useNamesComputers, useOrgId } from "../shared/hooks";

/**
 * What every row reads alike, read once instead of once per row: the list mounts a row each time it scrolls into view,
 * and each one paid on every mount for the directory (three queries and their maps, four or five times in an agent's
 * row), who I am, my handle, the roles, the computers and the agents' questions.
 *
 * - The workspace's part (`WorkspaceRowData`: the directory, who I am, my handle, the roles, the computers) is read once
 *   for the whole app, under its organization (`AppProviders`), so it stands above every screen and sheet.
 * - A conversation's part (`ConversationRowData`: the questions its agents asked) is read once per conversation, by the
 *   screens that draw its rows (the conversation, a question's own screen).
 *
 * Separate contexts, so what changes often (the questions, read again while one is open) never redraws what only reads
 * the directory (the faces). Each hook only reads its context: one stands above every row of the app.
 *
 * The questions change while one is out (reloaded every 10 s, its progress moving each time): a row reads only its own
 * part of them (`useRowConsultsPart`) and draws again only when that part changes. Read whole through the context,
 * every message row on screen drew again on each reload, a person's message as much as the agent's that asked.
 */

interface RowPeople {
  meId: string | null;
  myHandle: string | null;
  /** The workspace's roles (undefined while they load). */
  roles: OrgRole[] | undefined;
  namesComputers: boolean;
}

export interface RowConsults {
  channelId: string;
  /** The conversation's list (undefined while it loads). */
  list: RunConsultation[] | undefined;
  /** The list answered. */
  loaded: boolean;
  /** Each asking run's questions, an exchange between the same two agents under the run that asked first. */
  byRun: ReadonlyMap<string, RunConsultation[]>;
  byId: ReadonlyMap<string, RunConsultation>;
  /** The question each run answers (its `consultedRunId`): the first one listed. */
  byConsultedRun: ReadonlyMap<string, RunConsultation>;
}

/** Before the workspace is known (and in a test's bare render): nobody yet, as `useDirectory` says while it loads. */
const NO_ONE: Directory = {
  agents: [],
  agentById: new Map(),
  anyAgent: () => undefined,
  memberById: new Map(),
  memberByHandle: new Map(),
  loading: true,
  nameOf: () => "",
};
const NO_PEOPLE: RowPeople = { meId: null, myHandle: null, roles: undefined, namesComputers: false };

const RowDirectoryContext = createContext<Directory>(NO_ONE);
const RowPeopleContext = createContext<RowPeople>(NO_PEOPLE);
/** The conversation's questions as a store: each row follows its own part of them (`useRowConsultsPart`). */
interface ConsultsStore {
  get: () => RowConsults | null;
  /** The latest, taken while the conversation draws, so a row mounting in the same pass reads it already. */
  put: (next: RowConsults) => void;
  /** Tells the rows once the new questions are in (after the pass that took them). */
  tell: () => void;
  subscribe: (listener: () => void) => () => void;
}

function consultsStore(first: RowConsults): ConsultsStore {
  let now = first;
  const listeners = new Set<() => void>();
  return {
    get: () => now,
    put: (next) => {
      now = next;
    },
    tell: () => {
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const RowConsultsStoreContext = createContext<ConsultsStore | null>(null);

export function consultsOf(channelId: string, list: RunConsultation[] | undefined, loaded: boolean): RowConsults {
  const byId = new Map<string, RunConsultation>();
  const byConsultedRun = new Map<string, RunConsultation>();
  for (const c of list ?? []) {
    if (!byId.has(c.id)) byId.set(c.id, c);
    if (c.consultedRunId && !byConsultedRun.has(c.consultedRunId)) byConsultedRun.set(c.consultedRunId, c);
  }
  return { channelId, list, loaded, byRun: groupsByRun(asExchanges(list ?? [])), byId, byConsultedRun };
}

/**
 * Reads what the rows of conversation `channelId` share, once, for everything under it (its list, its sheets). Mounted
 * once per conversation screen, above the sheets it opens.
 */
/**
 * The workspace's part, once for the whole app (`AppProviders`, under the organization). It stands there before any
 * workspace is chosen (signing in, the first launch): nobody until one is, read by `WorkspaceReads`, a leaf that mounts
 * only with a workspace (the reads need one). The app under it keeps its place either way: a workspace coming or going
 * never remounts the screens.
 */
export function WorkspaceRowData({ children }: { children: ReactNode }) {
  const org = useOrgMaybe();
  const [dir, setDir] = useState<Directory>(NO_ONE);
  const [people, setPeople] = useState<RowPeople>(NO_PEOPLE);
  return (
    <RowDirectoryContext.Provider value={dir}>
      <RowPeopleContext.Provider value={people}>
        {org ? <WorkspaceReads key={org.orgId} onDirectory={setDir} onPeople={setPeople} /> : null}
        {children}
      </RowPeopleContext.Provider>
    </RowDirectoryContext.Provider>
  );
}

/** Reads the workspace's directory and people and hands them up, before the frame is drawn; nobody again when it goes. */
function WorkspaceReads({
  onDirectory,
  onPeople,
}: {
  onDirectory: (dir: Directory) => void;
  onPeople: (people: RowPeople) => void;
}) {
  const orgId = useOrgId();
  const dir = useDirectory();
  const meId = useMeId();
  const myHandle = useMyHandle();
  const roles = useRoles(orgId).data?.roles;
  const namesComputers = useNamesComputers();
  const people = useMemo<RowPeople>(
    () => ({ meId, myHandle, roles, namesComputers }),
    [meId, myHandle, roles, namesComputers],
  );
  useLayoutEffect(() => onDirectory(dir), [dir, onDirectory]);
  useLayoutEffect(() => onPeople(people), [people, onPeople]);
  useLayoutEffect(
    () => () => {
      onDirectory(NO_ONE);
      onPeople(NO_PEOPLE);
    },
    [onDirectory, onPeople],
  );
  return null;
}

/** A conversation's part: the questions its agents asked, read once for its rows. */
export function ConversationRowData({ channelId, children }: { channelId: string; children: ReactNode }) {
  const list = useConsultations(useOrgId(), channelId, Boolean(channelId));
  const consults = useMemo(
    () => consultsOf(channelId, list.data, list.isSuccess),
    [channelId, list.data, list.isSuccess],
  );
  const [store] = useState(() => consultsStore(consults));
  // Only the value: idempotent, and a row mounting in this same pass reads it. The rows already drawn are told after.
  store.put(consults);
  // biome-ignore lint/correctness/useExhaustiveDependencies: told again each time the questions are new.
  useLayoutEffect(() => store.tell(), [store, consults]);
  return <RowConsultsStoreContext.Provider value={store}>{children}</RowConsultsStoreContext.Provider>;
}

/** The organization's agents and people (`useDirectory`). */
export const useRowDirectory = (): Directory => useContext(RowDirectoryContext);

/** The signed-in person's id (`useMeId`). */
export const useRowMeId = (): string | null => useContext(RowPeopleContext).meId;

/** My @handle, lower-cased (`useMyHandle`). */
export const useRowMyHandle = (): string | null => useContext(RowPeopleContext).myHandle;

/** The workspace's roles (`useRoles`), undefined while they load. */
export const useRowRoles = (): OrgRole[] | undefined => useContext(RowPeopleContext).roles;

/** Whether lines about where things run name the computer (`useNamesComputers`). */
export const useRowNamesComputers = (): boolean => useContext(RowPeopleContext).namesComputers;

/** Nothing asked here, nothing read: a row outside its conversation's screen (one object per conversation). */
const none = new Map<string, RowConsults>();
const noConsults = (channelId: string): RowConsults => {
  let empty = none.get(channelId);
  if (!empty) {
    empty = consultsOf(channelId, undefined, false);
    none.set(channelId, empty);
  }
  return empty;
};

const noSubscription = () => () => undefined;

/** Two lists with the same items, in order (a run's questions the reload left as they were). */
export const sameItems = <T,>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => Object.is(x, b[i])));

/**
 * A row's own part of the questions asked from conversation `channelId` (`part`): the row draws again only when that
 * part changes (`same`; by identity unless told otherwise), not on every reload of the conversation's questions. The
 * reload keeps the questions that didn't change as they were, so a part made of them holds.
 */
export function useRowConsultsPart<T>(
  channelId: string,
  part: (consults: RowConsults) => T,
  same: (a: T, b: T) => boolean = Object.is,
): T {
  const store = useContext(RowConsultsStoreContext);
  const kept = useRef<{ value: T } | null>(null);
  const read = () => {
    const shared = store?.get();
    const next = part(shared?.channelId === channelId ? shared : noConsults(channelId));
    const was = kept.current;
    if (was && same(was.value, next)) return was.value;
    kept.current = { value: next };
    return next;
  };
  return useSyncExternalStore(store?.subscribe ?? noSubscription, read, read);
}
