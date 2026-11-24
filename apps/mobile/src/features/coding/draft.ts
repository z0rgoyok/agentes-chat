import { pickStore } from "../agents/pick-store";

/**
 * A new session's choices while its form and "Where to work" are open (ADR 0215, real navigation: each its own
 * pushed screen). The form opens it, the pick screen changes `repo` in it and goes back.
 */
export interface CodeDraft {
  agentId: string | null;
  repo: string;
  /** The agent's repositories, its local projects used before, and whether its list allows any `owner/name`. */
  repos: string[];
  locals: string[];
  any: boolean;
}

export const codeDraft = pickStore<CodeDraft>();
