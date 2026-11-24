import type { AgentProposal } from "@agenteschat/client";
import type { Level } from "@agenteschat/client/lib/access-levels";
import type { AiChoice } from "@agenteschat/client/lib/ai-choice";
import { handleForName, type PersonalStarter, ROLE_DEFAULTS, type RoleId } from "@agenteschat/client/lib/new-agent";
import { useSyncExternalStore } from "react";
import { type FullLook, fullLook } from "./edit";
import type { PhoneStep } from "./new-agent";
import { pickStore } from "./pick-store";

/**
 * "Criar agente" as screens on the stack, one per step: the agent being made lives here while they show, as a picker's
 * choice does (`pick-store.ts`), since a route can't carry it. The flow's first screen starts it and ends it when it goes
 * away (made, or left); every step reads and writes the same draft, so the system's back keeps what was typed.
 */
export interface NewAgentDraft {
  /** One per flow: a first screen only ends its own. */
  id: number;
  /** The step the flow started on: the role, who it is (`?what=`) or Revisar (a proposal). */
  entry: PhoneStep;
  /** The proposal it was opened from (ADR 0081), as it was when it opened: once created, the form stays on. */
  from: AgentProposal | null;
  /** A plan account just connected ("Criar um agente com este plano"): it thinks with that one. */
  accountId: string | null;
  /** The channel it was asked for (a channel's Adicionar): it stays picked whatever role is chosen. */
  asked: readonly string[];
  role: RoleId | null;
  /** A personal workspace's starting point (one of the right hand's personal agents), on top of "custom" (ADR 0159 §3). */
  starter: PersonalStarter["id"] | null;
  roleText: string;
  name: string;
  handle: string;
  /** The @ was typed: the name no longer writes it. */
  handleTouched: boolean;
  look: FullLook;
  instructions: string;
  channelIds: ReadonlySet<string>;
  /** A proposal's levels, the reviewer's to change in Revisar; otherwise they come with the role. */
  proposedLevels: Record<string, Level>;
  /** My own mailboxes a proposal asked for, at its level (only a mailbox's owner gives an agent access to it). */
  mailLevels: Record<string, Level>;
  withRoutine: boolean;
  /** Who thinks, chosen in "Quem pensa" (the one AI choice); null: what it starts on (ADR 0094). */
  aiPick: AiChoice | null;
  /** "Conectar uma IA" from Revisar: the choices before it opened, so a plan connected there is the one it thinks with. */
  optionsBefore: ReadonlySet<string> | null;
  /** Made (or the proposal refused): leaving no longer asks. */
  created: boolean;
}

/** What the flow's first screen starts from: its address, and what it read for a proposal. */
export interface NewAgentStart {
  /** An example of the empty Conversas: from scratch, with that text. */
  what: string;
  /** A free name for an agent started from `what`. */
  suggested: string;
  from: AgentProposal | null;
  channelId: string | null;
  accountId: string | null;
  /** A proposal's levels and my mailboxes it asked for, read for whoever reviews it. */
  levels: Record<string, Level>;
  mail: Record<string, Level>;
}

/** The draft a flow starts with: empty on the role, from scratch with `what`, or a proposal's on Revisar. */
export function newAgentDraft(start: NewAgentStart, id: number): NewAgentDraft {
  const proposed = start.from?.params.draft;
  const asked = start.channelId ? [start.channelId] : [];
  return {
    id,
    entry: proposed ? "review" : start.what ? "identity" : "role",
    from: start.from,
    accountId: start.accountId,
    asked,
    role: proposed || start.what ? "custom" : null,
    starter: null,
    roleText: proposed?.role ?? "",
    name: proposed?.name ?? (start.what ? start.suggested : ""),
    handle: proposed?.handle ?? (start.what ? handleForName(start.suggested) : ""),
    handleTouched: Boolean(proposed),
    look: fullLook(proposed?.appearance ?? ROLE_DEFAULTS.custom.look),
    instructions: proposed?.instructions ?? start.what,
    channelIds: new Set(proposed?.channelIds ?? asked),
    proposedLevels: start.levels,
    mailLevels: start.mail,
    withRoutine: Boolean(proposed?.routine),
    aiPick: null,
    optionsBefore: null,
    created: false,
  };
}

/** Something typed or chosen: leaving now asks first. */
export const draftDirty = (d: NewAgentDraft) =>
  !d.created && (d.role !== null || d.name.trim() !== "" || d.instructions.trim() !== "");

const store = pickStore<NewAgentDraft>();
let lastId = 0;
/** The first screen's guard: lets the flow's own leaving go without asking (`useUnsavedGuard`'s `leave`). */
let release: { id: number; go: () => void } | null = null;

export function startNewAgent(start: NewAgentStart): NewAgentDraft {
  lastId += 1;
  const draft = newAgentDraft(start, lastId);
  release = null;
  store.open(draft);
  return draft;
}

/** A step's change to the draft (nothing when no flow is open). */
export function editNewAgent(change: Partial<NewAgentDraft> | ((now: NewAgentDraft) => Partial<NewAgentDraft>)) {
  store.update((now) => ({ ...now, ...(typeof change === "function" ? change(now) : change) }));
}

/** The first screen went away: its flow ends (a newer one stays). */
export function endNewAgent(id: number) {
  if (store.now()?.id !== id) return;
  release = null;
  store.close();
}

/** Kept by the first screen while it shows: how the step that finishes lets the leaving go. */
export function holdNewAgentRelease(id: number, go: () => void) {
  release = { id, go };
}

/** Made, imported or refused: the screens leave without asking, from whichever step it happened on. */
export function finishNewAgent() {
  const now = store.now();
  if (!now) return;
  if (release?.id === now.id) release.go();
  store.update((d) => ({ ...d, created: true }));
}

export const newAgentNow = store.now;

export function useNewAgent(): NewAgentDraft | null {
  return useSyncExternalStore(store.subscribe, store.now);
}
