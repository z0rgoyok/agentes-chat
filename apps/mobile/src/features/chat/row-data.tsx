import { type OrgRole, type RunConsultation, useConsultations, useRoles } from "@agenteschat/client";
import { asExchanges, groupsByRun } from "@agenteschat/client/lib/consult-group";
import { createContext, type ReactNode, useContext, useLayoutEffect, useMemo, useState } from "react";
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
const RowConsultsContext = createContext<RowConsults | null>(null);

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
  return <RowConsultsContext.Provider value={consults}>{children}</RowConsultsContext.Provider>;
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

/** Nothing asked here, nothing read: a row outside its conversation's screen. */
const noConsults = (channelId: string): RowConsults => consultsOf(channelId, undefined, false);

/** The questions agents asked from conversation `channelId`, as its screen read them (`ConversationRowData`). */
export function useRowConsults(channelId: string): RowConsults {
  const shared = useContext(RowConsultsContext);
  return useMemo(() => (shared?.channelId === channelId ? shared : noConsults(channelId)), [shared, channelId]);
}
