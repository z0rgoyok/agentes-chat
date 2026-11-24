import type { CodeSuggestion, CodeSuggestionStatus } from "./types";

/** A code session's root message (ADR 0215, `meta.codeSession`): which session its thread is. */
export interface CodeSessionRoot {
  sessionId: string;
  repo: string;
  title: string;
  /** Opened from a suggestion in a conversation (§11): there is a way back to it. */
  fromChat: boolean;
}

/** The session a thread's root stands for, if it is a code session's (its conversation shows it, not the root). */
export function codeSessionOf(meta: unknown): CodeSessionRoot | null {
  if (!meta || typeof meta !== "object") return null;
  const c = (meta as { codeSession?: unknown }).codeSession;
  if (!c || typeof c !== "object") return null;
  const { sessionId, repo, title, from } = c as Record<string, unknown>;
  return typeof sessionId === "string" && typeof repo === "string" && typeof title === "string"
    ? { sessionId, repo, title, fromChat: Boolean(from && typeof from === "object") }
    : null;
}

const STATUSES: readonly CodeSuggestionStatus[] = ["pending", "opening", "opened", "here"];

/** The code session an agent's reply suggests (`meta.codeSuggestion`, ADR 0215 §11), or null. */
export function codeSuggestionOf(meta: unknown): CodeSuggestion | null {
  if (!meta || typeof meta !== "object") return null;
  const s = (meta as { codeSuggestion?: unknown }).codeSuggestion;
  if (!s || typeof s !== "object") return null;
  const v = s as Record<string, unknown>;
  const text = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : "");
  const status = STATUSES.find((x) => x === v.status);
  if (!status || !text("id") || !text("agentId") || !text("repo") || !text("askerId")) return null;
  return {
    id: text("id"),
    agentId: text("agentId"),
    repo: text("repo"),
    title: text("title"),
    request: text("request"),
    requestMessageId: text("requestMessageId"),
    askerId: text("askerId"),
    status,
    ...(text("sessionId") ? { sessionId: text("sessionId") } : {}),
    ...(text("by") ? { by: text("by") } : {}),
    ...(text("at") ? { at: text("at") } : {}),
  };
}
