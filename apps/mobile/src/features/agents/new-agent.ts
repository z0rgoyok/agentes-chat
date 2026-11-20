import { lowerFirst } from "@agenteschat/client/lib/format";
import { IMPORT_CARDS, type ImportCard } from "@agenteschat/client/lib/import/flow";
import { handleProblem, type RoleId } from "@agenteschat/client/lib/new-agent";

/**
 * "Criar agente" on the phone, the pure part: the web's steps that fit a thumb (where it works, its
 * model and budget start at the workspace's defaults and change on its page), and what keeps each one
 * from going on (the same rules as the web's `stepErrors`).
 */

export const NEW_AGENT_PHONE_STEPS = ["role", "identity", "instructions", "review"] as const;
export type PhoneStep = (typeof NEW_AGENT_PHONE_STEPS)[number];

export interface PhoneDraft {
  role: RoleId | null;
  name: string;
  handle: string;
  /** Handles already used, by agents or people. */
  taken: Set<string>;
}

/** How many source apps the import row shows, their logos overlapping. */
export const IMPORT_MARKS = 3;

/** The import row's tile: the first source apps that have a logo of their own, in the import's order. */
export const importMarkCards = <C extends ImportCard>(hasLogo: (card: ImportCard) => card is C): C[] =>
  IMPORT_CARDS.filter(hasLogo).slice(0, IMPORT_MARKS);

/** Whether a step can't go on yet. */
export function stepBlocked(step: PhoneStep, d: PhoneDraft): boolean {
  if (step === "role") return !d.role;
  if (step === "identity") return !d.name.trim() || handleProblem(d.handle, d.taken) !== null;
  return false;
}

/** The first step that can't go on (-1 when it can be created). */
export const firstBlockedStep = (d: PhoneDraft) => NEW_AGENT_PHONE_STEPS.findIndex((s) => stepBlocked(s, d));

/**
 * Each step is a screen of its own on the stack (the system's back goes to the one before). The flow's first screen is
 * `/new-agent`: the role, or the step it starts on (`?what=` starts on who it is, `?proposal=` on Revisar). These are
 * the steps pushed over it.
 */
export const NEW_AGENT_STEP_HREF = {
  role: "/new-agent/role",
  identity: "/new-agent/identity",
  instructions: "/new-agent/instructions",
  review: "/new-agent/review",
} as const satisfies Record<PhoneStep, string>;

/** The step that comes after `step` (none after Revisar). */
export const nextStep = (step: PhoneStep): PhoneStep | null =>
  NEW_AGENT_PHONE_STEPS[NEW_AGENT_PHONE_STEPS.indexOf(step) + 1] ?? null;

/**
 * A step opened from Revisar to change it: pushed over Revisar, back to it when done. `tried`: Criar found it can't go
 * on yet, so it opens saying why.
 */
export const changeHref = (step: PhoneStep, tried = false) =>
  `${NEW_AGENT_STEP_HREF[step]}?change=1${tried ? "&tried=1" : ""}`;

/**
 * Where a step stands in its flow, for the bar's subtitle ("2 of 4"): counted from the step the flow started on, so a
 * flow that starts on who it is counts three. A flow that starts on Revisar (a proposal) has no steps to count.
 */
export function stepOf(entry: PhoneStep, step: PhoneStep): { step: number; total: number } | null {
  const steps = NEW_AGENT_PHONE_STEPS.slice(NEW_AGENT_PHONE_STEPS.indexOf(entry));
  const at = steps.indexOf(step);
  return steps.length < 2 || at < 0 ? null : { step: at + 1, total: steps.length };
}

/** The stack's names of the flow's screens (expo-router's: the folder, then the file). */
const FLOW_ROUTE = "new-agent/";
const FLOW_FIRST = "new-agent/index";

/**
 * How many of the flow's screens are on top of the stack, so finishing leaves all of them at once: from the top down
 * to its first screen (or the first screen that isn't the flow's, for an import opened on its own). A flow under it
 * stays.
 */
export function flowDepth(routeNames: readonly string[]): number {
  let depth = 0;
  for (let i = routeNames.length - 1; i >= 0; i--) {
    const name = routeNames[i] ?? "";
    if (!name.startsWith(FLOW_ROUTE)) break;
    depth++;
    if (name === FLOW_FIRST) break;
  }
  return depth;
}

/**
 * A preset's line under its name: what it does, then who it starts as ("Codes, reviews PRs and investigates bugs ·
 * starts as Ada"). Each description is a sentence of its own in every language, so its closing stop goes before
 * the "·", and the part after it starts in lower case, unless it starts with the agent's name ("Adaとして開始").
 */
export function roleLine(desc: string, startsAs: string, name: string, locale?: string): string {
  const after = startsAs.startsWith(name) ? startsAs : lowerFirst(startsAs, locale);
  return `${desc.replace(/[.。．]\s*$/u, "")} · ${after}`;
}
