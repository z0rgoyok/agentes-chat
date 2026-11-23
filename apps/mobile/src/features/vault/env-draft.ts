import type { VaultScope } from "@agenteschat/client";
import type { EnvFile } from "@agenteschat/client/lib/vault";

/**
 * "Import .env" is two pushed screens (ADR 0144 §11, one screen per step with the system's back): the file picked or
 * pasted, then its keys reviewed and saved. The keys read on the first step reach the second here, never in a link (a
 * route can't carry them, and they are secrets). The first step opens the draft as it pushes the second; the second
 * takes it as it opens and drops it as it closes, so the values live no longer than the screens that show them.
 */
export interface EnvDraft {
  file: EnvFile;
  /** The Vault tab the import started from: where the keys go unless the person picks the other. */
  scope: VaultScope;
  /** Lets the first step go without asking about its pasted text: the keys are saved, the flow ends. */
  leave: () => void;
}

let current: EnvDraft | null = null;

/** Starts the review; the caller pushes `vaultHref.envReview` next, which takes it as it opens. */
export function openEnvDraft(draft: EnvDraft) {
  current = draft;
}

/** Ends `draft` (the one a screen showed): one opened meanwhile for the next screen stays. */
export function closeEnvDraft(draft: EnvDraft | null) {
  if (draft && current === draft) current = null;
}

export const envDraftNow = (): EnvDraft | null => current;
