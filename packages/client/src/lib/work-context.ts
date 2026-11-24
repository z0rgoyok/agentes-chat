import { createContext, useContext } from "react";
import type { OrgSummary } from "../api/types";
import { showsActivity } from "./work";

/**
 * Around a code session's conversation (ADR 0215): the agent's work there is the conversation itself, as in a
 * terminal, whichever brain did it.
 */
export const CodeConversation = createContext(false);

/**
 * Whether an agent's finished work shows here: the person's setting (`showsActivity`), or always in a code session's
 * conversation.
 */
export function useShowsWork(org: Pick<OrgSummary, "showActivity"> | null | undefined): boolean {
  const code = useContext(CodeConversation);
  return code || showsActivity(org);
}
