/** How long a new file's page may take to open and still select its title. */
const JUST_CREATED_MS = 60_000;

/**
 * Files just made from "New" (ADR 0196 §9): their page opens with the title selected, ready to be named. A module of
 * its own so the Drive's New menu marks a file without loading the page's code.
 */
const justCreated = new Set<string>();

export function markJustCreated(id: string) {
  justCreated.add(id);
  setTimeout(() => justCreated.delete(id), JUST_CREATED_MS);
}

/** Whether the file was just made here (its title is still the placeholder). */
export const wasJustCreated = (id: string) => justCreated.has(id);

/** The title was taken (selected for naming): a reload or a second visit leaves it be. */
export const forgetJustCreated = (id: string) => justCreated.delete(id);
