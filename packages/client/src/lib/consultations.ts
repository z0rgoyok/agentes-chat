import { withoutRelayLine } from "@agenteschat/ui/agent-talk";
import type { TFunction } from "i18next";
import type { ConsultationStatus, MessageConsultation } from "../api/types";
import { plainLine } from "./markdown";
import { formatLineTime } from "./work";

export { CONSULT_SUBJECT_CHARS, consultSubject, withoutRelayLine } from "@agenteschat/ui/agent-talk";

/** How long an agent waits for another one's answer (the server's `CONSULTATION_TTL_MS`). */
export const CONSULTATION_MINUTES = 15;

/**
 * A pair row's time, from the ask to now or to what came back, waits included: the clock while it's out ("6 h"), then
 * "took 6 h".
 */
export function consultTimeText(t: TFunction, locale: string, live: boolean, seconds: number) {
  const time = formatLineTime(locale, seconds * 1000);
  return live ? time : t("chat.consultPair.took", { time });
}

const STATUSES: ReadonlySet<string> = new Set<ConsultationStatus>(["answered", "expired", "failed"]);

/** `meta.consulted` of an agent's reply: the agents it asked before answering (bad entries left out). */
export function consultationsOf(meta: Record<string, unknown> | undefined): MessageConsultation[] {
  const list = meta?.consulted;
  if (!Array.isArray(list)) return [];
  return list.flatMap((v): MessageConsultation[] => {
    if (!v || typeof v !== "object") return [];
    const o = v as Record<string, unknown>;
    if (typeof o.agentId !== "string" || !o.agentId) return [];
    const status = typeof o.status === "string" && STATUSES.has(o.status) ? (o.status as ConsultationStatus) : "failed";
    const answer = status === "answered" && typeof o.answer === "string" && o.answer.trim() ? o.answer : null;
    return [
      {
        agentId: o.agentId,
        consultationId: typeof o.consultationId === "string" ? o.consultationId : `${o.agentId}:${status}`,
        // Answered with nothing to show is told as "couldn't answer".
        status: status === "answered" && !answer ? "failed" : status,
        question: typeof o.question === "string" ? o.question : "",
        answer,
      },
    ];
  });
}

/** Two agents' conversation as people read it: the question and each message without the relay line. */
export function forPeople<C extends { question: string }, M extends { body: string }>(talk: {
  consultation: C;
  messages: M[];
}): { consultation: C; messages: M[] } {
  return {
    ...talk,
    consultation: { ...talk.consultation, question: withoutRelayLine(talk.consultation.question) },
    messages: talk.messages.map((m) => ({ ...m, body: withoutRelayLine(m.body) })),
  };
}

/** One line of an answer for the folded card: no Markdown marks, spaces collapsed. */
export const previewOf = (text: string) => plainLine(withoutRelayLine(text));
