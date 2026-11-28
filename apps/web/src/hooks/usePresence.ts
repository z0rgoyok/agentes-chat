import type {
  AgentStatus,
  AgentStatusLine,
  AgentWork,
  AiStatus,
  Availability,
  MemberPresence,
  MemberStatus,
  Person,
} from "@agenteschat/client";
import { agentStateIn, agentWorkingIn, keys, useApi } from "@agenteschat/client";
import { agentWork } from "@agenteschat/client/lib/agent-work";
import { type AgentFace, agentFaceOf, agentStatusText, isAgentOff, liveLine } from "@agenteschat/client/lib/presence";
import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useCallback, useMemo } from "react";
import { useOrg } from "@/components/org-context";
import { useStreams } from "@/realtime/context";

/*
 * Presence and written status (ADR 0084) for one person or one agent, read from the lists every screen shares
 * (`…/people`, `…/agent-status`, `…/ai-status`). Each face picks its own row (`select`), so a change elsewhere
 * redraws only the faces it touches. Only the sidebar polls the agents' list (`useAgentStatuses`): every face doing it
 * would fetch it once per face.
 */

/** The line's emoji when its author picked none. */
export const STATUS_EMOJI = "💬";

/** What you picked, from how you appear to yourself, when the server didn't say (`Person.availability`). */
export const availabilityOf = (presence: MemberPresence | undefined): Availability =>
  presence === "away" || presence === "busy" || presence === "out" || presence === "hidden" ? presence : "auto";

/** A person's line as its emoji and words. */
export const personLine = (status: MemberStatus) => ({ emoji: status.emoji || STATUS_EMOJI, text: status.text });

/**
 * How a person appears, with me here: this tab is open, so a list read before my socket connected (`offline`) doesn't
 * leave me offline until the next read, my row and badge jumping groups once it comes. What I picked (away, busy, out,
 * hidden) stays as the list says.
 */
const hereIfMe = (userId: string, meId: string, presence: MemberPresence): MemberPresence =>
  userId === meId && presence === "offline" ? "online" : presence;

export interface PersonPresence {
  presence: MemberPresence;
  status: MemberStatus | null;
  person: Person;
}

/** A person's presence and line; null while the people load or for someone not in the workspace. */
export function usePersonPresence(userId: string | null | undefined): PersonPresence | null {
  const { org, me } = useOrg();
  const api = useApi();
  const pick = useCallback((list: Person[]) => list.find((p) => p.userId === userId) ?? null, [userId]);
  const person = useQuery({
    queryKey: keys.people(org.id),
    queryFn: () => api.orgs.people(org.id),
    staleTime: 30_000,
    enabled: Boolean(userId),
    select: pick,
  }).data;
  if (!userId || !person) return null;
  return { presence: hereIfMe(userId, me.user.id, person.presence), status: liveLine(person.status), person };
}

const usePeople = () => {
  const { org } = useOrg();
  const api = useApi();
  return { queryKey: keys.people(org.id), queryFn: () => api.orgs.people(org.id), staleTime: 30_000 };
};

/** Everyone's presence in the workspace by user id (empty while the people load). */
export function usePresences(): Map<string, MemberPresence> {
  const meId = useOrg().me.user.id;
  const select = useCallback(
    (list: Person[]) => new Map(list.map((p) => [p.userId, hereIfMe(p.userId, meId, p.presence)])),
    [meId],
  );
  return useQuery({ ...usePeople(), select }).data ?? EMPTY_PRESENCES;
}

/** Whether `usePresences` has its people yet (or failed): before, everyone reads offline. */
export const usePresencesLoaded = () => !useQuery(usePeople()).isPending;
const EMPTY_PRESENCES = new Map<string, MemberPresence>();

export interface AgentShown {
  /** Its face (ADR 0084 addendum): free, at work, waiting on you, out of office or offline. */
  presence: AgentFace;
  line: AgentStatusLine | null;
  /** Its most important work for this person, a run this tab hears at work included (`agentWork`). */
  work: AgentWork | null;
  /** Its last run's end (now while one is going); null = it never worked. */
  activeAt: string | null;
  /** No AI to think with: drawn offline (ADR 0084 §3). */
  noAi: boolean;
}

/** An agent's presence as the apps draw it and its line; null while the list loads. */
export function useAgentPresence(agentId: string | null | undefined): AgentShown | null {
  const { org } = useOrg();
  const api = useApi();
  const on = Boolean(agentId) && org.id.length > 0;
  const pickStatus = useCallback((list: AgentStatus[]) => list.find((s) => s.agentId === agentId) ?? null, [agentId]);
  const pickAi = useCallback(
    (status: AiStatus) => status.agents.find((a) => a.agentId === agentId)?.state ?? null,
    [agentId],
  );
  const status = useQuery({
    queryKey: keys.agentStatus(org.id),
    queryFn: () => api.agents.statuses(org.id),
    staleTime: 15_000,
    enabled: on,
    select: pickStatus,
  }).data;
  const ai = useQuery({
    queryKey: keys.aiStatus(org.id),
    queryFn: () => api.agents.aiStatus(org.id),
    staleTime: 30_000,
    enabled: on,
    select: pickAi,
  }).data;
  // A run of its this tab hears: at work before the list's next read says so.
  const workingIn = useStreams((s) =>
    agentId && agentStateIn(s, agentId) !== "idle" ? agentWorkingIn(s, agentId) : null,
  );
  if (!on || status === undefined) return null;
  const { presence, noAi } = agentFaceOf(status ?? undefined, ai, workingIn !== null);
  return {
    presence,
    line: noAi ? null : liveLine(status?.status),
    work: agentWork(status, workingIn ? { channelId: workingIn } : null),
    activeAt: status?.activeAt ?? null,
    noAi,
  };
}

const workingIdsOf = (list: AgentStatus[]) =>
  list
    .filter((s) => s.work?.state === "working")
    .map((s) => s.agentId)
    .sort()
    .join(",");

/** The agents at work, workspace-wide (their work for this person, ADR 0084 addendum), from the list every face reads. */
export function useAgentsWorking(): ReadonlySet<string> {
  const { org } = useOrg();
  const api = useApi();
  const key =
    useQuery({
      queryKey: keys.agentStatus(org.id),
      queryFn: () => api.agents.statuses(org.id),
      staleTime: 15_000,
      enabled: org.id.length > 0,
      select: workingIdsOf,
    }).data ?? "";
  return useMemo(() => new Set(key ? key.split(",") : []), [key]);
}

// Plain objects of only what the face reads: the query keeps the same one while those don't change (structural
// sharing skips Maps), so a poll that moves only `activeAt` doesn't redraw the whole list.
const facesById = (list: AgentStatus[]) =>
  Object.fromEntries(list.map((s) => [s.agentId, { presence: s.presence, working: s.working }]));
const aisById = (status: AiStatus) => Object.fromEntries(status.agents.map((a) => [a.agentId, a.state]));

/**
 * Whether an agent is off now (`isAgentOff`: out of office, held, or no AI) by the rule its face is drawn by
 * (`agentFaceOf`), so a list that groups by it never disagrees with its row. `working`: a run of its this tab hears.
 * Nobody is off while the list loads.
 */
export function useAgentOff(): (agentId: string, working: boolean) => boolean {
  const { org } = useOrg();
  const api = useApi();
  const on = org.id.length > 0;
  const statuses = useQuery({
    queryKey: keys.agentStatus(org.id),
    queryFn: () => api.agents.statuses(org.id),
    staleTime: 15_000,
    enabled: on,
    select: facesById,
  }).data;
  const ais = useQuery({
    queryKey: keys.aiStatus(org.id),
    queryFn: () => api.agents.aiStatus(org.id),
    staleTime: 30_000,
    enabled: on,
    select: aisById,
  }).data;
  return (agentId, working) =>
    statuses !== undefined && isAgentOff(agentFaceOf(statuses[agentId], ais?.[agentId], working).presence);
}

const linesOf = (list: AgentStatus[]) => new Map(list.map((s) => [s.agentId, liveLine(s.status)]));
const NO_LINES: ReadonlyMap<string, AgentStatusLine | null> = new Map();

/** Every agent's line by id (ADR 0084), from the list every face reads, with no poll of its own. */
export function useAgentLines(): ReadonlyMap<string, AgentStatusLine | null> {
  const { org } = useOrg();
  const api = useApi();
  return (
    useQuery({
      queryKey: keys.agentStatus(org.id),
      queryFn: () => api.agents.statuses(org.id),
      staleTime: 15_000,
      enabled: org.id.length > 0,
      select: linesOf,
    }).data ?? NO_LINES
  );
}

/** An agent's line in words with its emoji, or null; `locale` words when an agent out of office is back. */
export const agentLine = (t: TFunction, line: AgentStatusLine | null, locale?: string) =>
  line ? agentStatusText(t, line, locale) : null;
