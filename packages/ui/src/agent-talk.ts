import { plainLines } from "./markdown";
import { clipText } from "./widgets/spec";

/**
 * The bracketed line the server opens a mention it relays to an agent outside the conversation with ("[@ada
 * mentioned you in #general, where you aren't a member, so it reaches you here]"): written for the agent, never
 * shown to people.
 */
const RELAY_LINE = /^\s*\[@[^\]\n]* mentioned you in [^\]\n]*so it reaches you here[^\]\n]*\]\s*/;

/** An agents' message as people read it: without the relay line the server wrote for the agent (`RELAY_LINE`). */
export const withoutRelayLine = (text: string) => text.replace(RELAY_LINE, "");

/** The most a question's subject holds: one line of a row, wrapped on a narrow one. */
export const CONSULT_SUBJECT_CHARS = 120;

/**
 * What a question between two agents is about, as one line of a row ("Investigate duplicate notifications."): the
 * first sentence of its first line of prose, without the relay line or Markdown, at most `CONSULT_SUBJECT_CHARS`
 * (`clipText`). Agents often write a question as "Context:" and a list, with no full stop, so the first sentence alone
 * could be the whole question. Empty when there is no question to take it from.
 */
export function consultSubject(question: string | null | undefined): string {
  const line = plainLines(withoutRelayLine(question ?? ""))[0] ?? "";
  const end = line.search(/[.!?…](?:\s|$)/);
  return clipText(end === -1 ? line : line.slice(0, end + 1), CONSULT_SUBJECT_CHARS);
}
