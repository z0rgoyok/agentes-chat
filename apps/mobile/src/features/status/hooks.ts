import {
  type AgentStatus,
  type AgentWork,
  type MemberPresence,
  type MemberStatus,
  type Person,
  useAgentStatuses,
  useAiStatus,
  useChannels,
  usePeople,
} from "@agenteschat/client";
import { WORK_TICK_MS, type WorkLine, workDetail, workLine } from "@agenteschat/client/lib/agent-work";
import { lowerFirst } from "@agenteschat/client/lib/format";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import {
  type AgentFace,
  agentFaceWord,
  agentPresenceShown,
  agentStatusText,
  clearsText,
  isOutOfOffice,
  type LIMIT_ICON,
} from "@agenteschat/client/lib/presence";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory, useMeId, useNow, useOrgId } from "../shared/hooks";
import { agentWhyKey, lineText, personLine } from "./logic";

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

export function usePresenceOf(): PresenceOf {
  const orgId = useOrgId();
  const { t, i18n } = useTranslation();
  const people = usePeople(orgId);
  const agents = useAgentStatuses(orgId);
  const ai = useAiStatus(orgId);
  return useMemo(() => {
    const byUser = new Map((people.data ?? []).map((p) => [p.userId, p]));
    const byAgent = new Map((agents.data ?? []).map((a) => [a.agentId, a]));
    return {
      person: (userId) => {
        const p = byUser.get(userId);
        return p ? { presence: p.presence, status: p.status } : null;
      },
      agent: (agentId) => {
        if (!agents.data) return null;
        const status = byAgent.get(agentId);
        // At work it has an AI, whatever the AIs' list reads for this person (the right hand's is each person's own).
        const noAi = aiStateOf(ai.data, agentId) === "no_ai" && status?.working !== true;
        const presence = agentPresenceShown(status, !noAi);
        // Without an AI it does nothing: no line either.
        const line = !noAi && status?.status ? agentStatusText(t, status.status, i18n.language) : null;
        return { presence, work: status?.work ?? null, line, status, noAi };
      },
    };
  }, [people.data, agents.data, ai.data, t, i18n.language]);
}

/**
 * An agent's work for this person in a list's words (ADR 0084 addendum of 2026-11-13): "ajudando a Ada · 22 min",
 * "#vendas", "aqui" (in `here`), "esperando você", ticking once a minute; null with none. The web's lists say the same.
 */
export function useAgentWorkLine(agentId: string | null | undefined, here?: string | null): WorkLine | null {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const channels = useChannels(orgId).data;
  const work = usePresenceOf().agent(agentId ?? "")?.work ?? null;
  const now = useNow(WORK_TICK_MS);
  return agentId
    ? workLine(
        t,
        i18n.language,
        work,
        {
          agentName: (id) => dir.agentById.get(id)?.name,
          channelName: (id) => channels?.find((c) => c.id === id)?.name,
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
  const orgId = useOrgId();
  const dir = useDirectory();
  const channels = useChannels(orgId).data;
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
          channelName: (id) => channels?.find((c) => c.id === id)?.name,
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
