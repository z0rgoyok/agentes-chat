import {
  type AgentStatus,
  type AgentWork,
  type AiStatus,
  agentStatusQuery,
  aiStatusQuery,
  type Channel,
  channelsQuery,
  type MemberPresence,
  type MemberStatus,
  type Person,
  peopleQuery,
  useAgentStatuses,
  useAiStatus,
  useApi,
  usePeople,
} from "@agenteschat/client";
import { WORK_TICK_MS, type WorkLine, workDetail, workLine } from "@agenteschat/client/lib/agent-work";
import { lowerFirst } from "@agenteschat/client/lib/format";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import {
  type AgentFace,
  agentFaceOf,
  agentFaceWord,
  agentPresenceShown,
  agentStatusText,
  agentWhyKey,
  clearsText,
  isOutOfOffice,
  type LIMIT_ICON,
} from "@agenteschat/client/lib/presence";
import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory, useMeId, useNow, useOrgId } from "../shared/hooks";
import { lineText, personLine } from "./logic";

/**
 * Who is how (ADR 0084): people's presence and line (`GET …/people`) and agents' (`GET …/agent-status`, an agent
 * with no AI drawn offline). The lists refetch on `member.status` / `agent.status` (`applyWorkspaceEvent`); the
 * agents' also every 30 seconds while something shows them.
 */
export interface PresenceOf {
  /** A person's presence and line; null while the people load or for someone not in them. */
  person: (userId: string) => { presence: MemberPresence; status: MemberStatus | null } | null;
  /** An agent's presence as drawn, its line in words and its row; null while the statuses load. */
  agent: (agentId: string) => AgentShown | null;
}

export interface AgentShown {
  /** Its face (ADR 0084 addendum): free, at work, waiting on you, out of office or offline. */
  presence: AgentFace;
  /** Its most important work for this person, with where it shows when they read it. */
  work: AgentWork | null;
  /** What it says it does, worded ("🛠️ Deploy da v2"); null: no line. */
  line: { emoji: string | null; icon?: typeof LIMIT_ICON; text: string } | null;
  status: AgentStatus | undefined;
  noAi: boolean;
}

type AiState = AiStatus["agents"][number]["state"];

/** Stands for a list not loaded yet, as a cache key. */
const UNREAD = {};

/** People and agents' statuses by id, once per list (the query cache's arrays, new only when a list changes). */
const peopleMaps = new WeakMap<Person[], ReadonlyMap<string, Person>>();
const statusMaps = new WeakMap<AgentStatus[], ReadonlyMap<string, AgentStatus>>();

function byUserOf(people: Person[]): ReadonlyMap<string, Person> {
  let map = peopleMaps.get(people);
  if (!map) {
    map = new Map(people.map((p) => [p.userId, p]));
    peopleMaps.set(people, map);
  }
  return map;
}

function byAgentOf(statuses: AgentStatus[]): ReadonlyMap<string, AgentStatus> {
  let map = statusMaps.get(statuses);
  if (!map) {
    map = new Map(statuses.map((a) => [a.agentId, a]));
    statusMaps.set(statuses, map);
  }
  return map;
}

function agentShown(
  status: AgentStatus | undefined,
  ai: AiState | undefined,
  t: TFunction,
  language: string,
): AgentShown {
  const { presence, noAi } = agentFaceOf(status, ai);
  // Without an AI it does nothing: no line either.
  const line = !noAi && status?.status ? agentStatusText(t, status.status, language) : null;
  return { presence, work: status?.work ?? null, line, status, noAi };
}

/** One set of lists' `PresenceOf`, with the language it words the lines in. */
interface KeptPresence {
  t: TFunction;
  language: string;
  of: PresenceOf;
}

/**
 * `PresenceOf` by the lists it reads (people, then statuses, then AIs): every face and row asking with the same lists
 * gets the same object, its maps made once. A line is still worded on each call: an out of office one says when it
 * is back relative to now.
 */
const presences = new WeakMap<object, WeakMap<object, WeakMap<object, KeptPresence>>>();

function presenceOf(
  people: Person[] | undefined,
  statuses: AgentStatus[] | undefined,
  ai: AiStatus | undefined,
  t: TFunction,
  language: string,
): PresenceOf {
  let byStatuses = presences.get(people ?? UNREAD);
  if (!byStatuses) {
    byStatuses = new WeakMap();
    presences.set(people ?? UNREAD, byStatuses);
  }
  let byAi = byStatuses.get(statuses ?? UNREAD);
  if (!byAi) {
    byAi = new WeakMap();
    byStatuses.set(statuses ?? UNREAD, byAi);
  }
  const kept = byAi.get(ai ?? UNREAD);
  if (kept && kept.t === t && kept.language === language) return kept.of;
  const byUser = people ? byUserOf(people) : undefined;
  const byAgent = statuses ? byAgentOf(statuses) : undefined;
  const of: PresenceOf = {
    person: (userId) => {
      const p = byUser?.get(userId);
      return p ? { presence: p.presence, status: p.status } : null;
    },
    agent: (agentId) => (byAgent ? agentShown(byAgent.get(agentId), aiStateOf(ai, agentId), t, language) : null),
  };
  byAi.set(ai ?? UNREAD, { t, language, of });
  return of;
}

export function usePresenceOf(): PresenceOf {
  const orgId = useOrgId();
  const { t, i18n } = useTranslation();
  const people = usePeople(orgId);
  const agents = useAgentStatuses(orgId);
  const ai = useAiStatus(orgId);
  return presenceOf(people.data, agents.data, ai.data, t, i18n.language);
}

/** A person's presence and line (`PresenceOf.person`), drawn again only when theirs change; null while unknown. */
export function usePersonPresence(
  userId: string | null | undefined,
): { presence: MemberPresence; status: MemberStatus | null } | null {
  const api = useApi();
  const orgId = useOrgId();
  const pick = useCallback(
    (people: Person[]) => {
      const p = userId ? byUserOf(people).get(userId) : undefined;
      return p ? { presence: p.presence, status: p.status } : null;
    },
    [userId],
  );
  return useQuery({ ...peopleQuery(api, orgId), select: pick }).data ?? null;
}

/** An agent's face, whether it has no AI, its status row and its work for this person (`PresenceOf.agent`'s). */
export interface AgentPresence {
  presence: AgentFace;
  noAi: boolean;
  status: AgentStatus | undefined;
  work: AgentWork | null;
}

/**
 * An agent's face and status (`PresenceOf.agent`, without the worded line), drawn again only when its own row in the
 * statuses or its AI's state changes; null while the statuses load.
 */
export function useAgentPresence(agentId: string | null | undefined): AgentPresence | null {
  const api = useApi();
  const orgId = useOrgId();
  // A holder, so a loaded list without the agent is told from one not loaded yet (no data at all).
  const pickStatus = useCallback(
    (statuses: AgentStatus[]) => ({ status: agentId ? byAgentOf(statuses).get(agentId) : undefined }),
    [agentId],
  );
  const pickAi = useCallback((ai: AiStatus) => (agentId ? (aiStateOf(ai, agentId) ?? null) : null), [agentId]);
  const row = useQuery({ ...agentStatusQuery(api, orgId), select: pickStatus }).data;
  const ai = useQuery({ ...aiStatusQuery(api, orgId), select: pickAi }).data;
  if (!row) return null;
  const { presence, noAi } = agentFaceOf(row.status, ai);
  return { presence, noAi, status: row.status, work: row.status?.work ?? null };
}

const NO_NAMES: Readonly<Record<string, string>> = {};
const namesOf = (channels: Channel[]): Readonly<Record<string, string>> =>
  Object.fromEntries(channels.map((c) => [c.id, c.name]));

/**
 * The channels' names by id, from the channels' list (`useChannels`' read): a plain object the query keeps while no
 * name changes, so what reads it draws again for a renamed channel, not for each message in one.
 */
export function useChannelNames(): Readonly<Record<string, string>> {
  const api = useApi();
  const orgId = useOrgId();
  return useQuery({ ...channelsQuery(api, orgId), select: namesOf }).data ?? NO_NAMES;
}

/** A channel's name in `useChannelNames`' object (undefined when unknown). */
export const channelNameIn = (names: Readonly<Record<string, string>>, id: string) =>
  Object.hasOwn(names, id) ? names[id] : undefined;

/**
 * An agent's work for this person in a list's words (ADR 0084 addendum of 2026-11-13): "ajudando a Ada · 22 min",
 * "#vendas", "aqui" (in `here`), "esperando você", ticking once a minute; null with none. The web's lists say the same.
 */
export function useAgentWorkLine(agentId: string | null | undefined, here?: string | null): WorkLine | null {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const channels = useChannelNames();
  const work = useAgentPresence(agentId)?.work ?? null;
  const now = useNow(WORK_TICK_MS);
  return agentId
    ? workLine(
        t,
        i18n.language,
        work,
        {
          agentName: (id) => dir.agentById.get(id)?.name,
          channelName: (id) => channelNameIn(channels, id),
          here: here ?? null,
        },
        now,
      )
    : null;
}

/** Your own row in the people: your presence as you see it (hidden stays hidden) and your line. */
export function useMyPerson(): Person | undefined {
  const orgId = useOrgId();
  const meId = useMeId();
  const people = usePeople(orgId);
  return meId ? people.data?.find((p) => p.userId === meId) : undefined;
}

/**
 * The quiet line of a DM's pill (ADR 0084): an agent's presence and what it does (its line, else `doing` from its
 * live run, else `rest`: its role); a person's line with when it clears, else their presence. Undefined while
 * their presence is unknown (`rest` then, for an agent).
 */
export function useDmStatusLine(
  who: { type: string; id: string } | null,
  doing: string | null | undefined,
  rest: string | undefined,
): string | undefined {
  const { t, i18n } = useTranslation();
  const of = usePresenceOf();
  if (!who) return undefined;
  if (who.type === "agent") {
    const a = of.agent(who.id);
    if (!a) return doing ?? rest;
    // Its run here is at work before the list's next read says so.
    const presence = doing ? agentPresenceShown(a.status, true, true) : a.presence;
    return [agentFaceWord(t, presence), a.line ? lineText(a.line) : (doing ?? rest)].filter(Boolean).join(" · ");
  }
  const p = of.person(who.id);
  if (!p) return undefined;
  return p.status ? personLine(t, i18n.language || "en", p.status) : t(`presence.${p.presence}`);
}

export interface AgentProfileStatus {
  presence: AgentFace;
  /** "Trabalhando · ajudando a Ada", "Esperando você · sua aprovação", "Disponível". */
  line: string;
  /** Its line in full, with who wrote it; null: none. */
  card: { emoji: string | null; icon?: typeof LIMIT_ICON; text: string; note: string } | null;
  /** Out of office with conversations waiting for it (ADR 0118): how many, its queue's way in. */
  waiting: number;
}

/**
 * An agent's presence on its profile (ADR 0084 and its addendum): the badge's face, a line with why ("Trabalhando ·
 * ajudando a Ada", "Esperando você · sua aprovação", "Disponível", "Offline · Sem IA conectada") and its status for the
 * card: the line, and who wrote it (its own, with when it clears) or that it is what it does now. Null while the
 * statuses load.
 */
export function useAgentProfileStatus(agentId: string, name: string): AgentProfileStatus | null {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const channels = useChannelNames();
  const shown = usePresenceOf().agent(agentId);
  if (!shown) return null;
  const key = agentWhyKey(shown.presence, shown.noAi);
  const why = key
    ? t(`presence.agentWhy.${key}`)
    : workDetail(
        t,
        shown.work,
        {
          agentName: (id) => dir.agentById.get(id)?.name,
          channelName: (id) => channelNameIn(channels, id),
        },
        i18n.language,
      );
  const own = shown.status?.status;
  const until = own?.until ?? null;
  const note = !own
    ? ""
    : own.by !== "self"
      ? t("presence.byAuto")
      : until
        ? t("mobile.status.bySelfUntil", {
            name,
            when: lowerFirst(clearsText(t, i18n.language || "en", until), i18n.language),
          })
        : t("presence.bySelf", { name });
  return {
    presence: shown.presence,
    line: [agentFaceWord(t, shown.presence), why].filter(Boolean).join(" · "),
    card: shown.line ? { ...shown.line, note } : null,
    waiting: own && isOutOfOffice(own) ? (own.count ?? 0) : 0,
  };
}

/** A person's or an agent's presence in a word ("Ocupado"); undefined while unknown or without `who`. */
export function usePresenceWord(who: { type: string; id: string } | null): string | undefined {
  const { t } = useTranslation();
  const of = usePresenceOf();
  if (!who) return undefined;
  if (who.type === "agent") {
    const face = of.agent(who.id)?.presence;
    return face ? agentFaceWord(t, face) : undefined;
  }
  const presence = of.person(who.id)?.presence;
  return presence ? t(`presence.${presence}`) : undefined;
}
