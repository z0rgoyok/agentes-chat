import { CUSTOM_PROVIDER } from "@agenteschat/client/lib/endpoints";
import type { ExistingSignIn } from "@agenteschat/client/lib/no-ai";
import { type ProviderId, providerGuess } from "@agenteschat/client/lib/providers";
import { useSyncExternalStore } from "react";
import type { FlowView } from "./logic";

/*
 * "Conectar uma IA" is one pushed screen per page (the two ways, the plans, a plan's page, the API key's, the key's
 * makers), the system's back going one page back. What its pages share lives here, one entry per flow, as the agent
 * picker shares its pick (`dashboards/agent-pick.ts`): a route can't carry it. The first page starts the flow from
 * its address and ends it when it leaves the stack, which takes every page of the flow over it along.
 */

/** What the flow was opened for: the address of its first page (`openConnectAi`, a notification's link). */
export interface ConnectAiAsk {
  /** The message answered once the agent has an AI. */
  from?: string;
  /** The key's maker a message named. */
  provider?: string;
  /** The agent to connect. */
  agentId?: string;
  /** The step a message asked for (a plan or a key). */
  intent?: string;
  /** The plan's page it opens on (Sign in again). */
  plan?: string;
  /** Claude's hint: one more login of the account with this email, or the login signed in again. */
  email?: string;
  /** "1": opened because the workspace's computer just got ready. */
  ready?: string;
  /** "1": from the create-agent step, for the agent being made. */
  forNew?: string;
  /** With `plan`: one of the person's logins signed in again on that plan's page. */
  again?: string;
}

const ASK_KEYS = ["from", "provider", "agentId", "intent", "plan", "email", "ready", "forNew", "again"] as const;

/** The ask in a page's address, its empty and repeated values left out. */
export function askOf(params: Partial<Record<string, string | string[]>>): ConnectAiAsk {
  const ask: ConnectAiAsk = {};
  for (const key of ASK_KEYS) {
    const value = params[key];
    if (typeof value === "string" && value) ask[key] = value;
  }
  return ask;
}

/** The API key being typed on the key's page, and whose it is (chosen on the makers' page). */
export interface KeyDraft {
  provider: ProviderId;
  /** "Outro provedor" (ADR 0146): the workspace's own endpoint, its own form. */
  custom: boolean;
  text: string;
}

export interface ConnectAiFlow {
  ask: ConnectAiAsk;
  /** The agents a plan or something the person had was connected for here: they think with it before the AI status says so. */
  linked: string[];
  /** The agent a plan is for, once picked; else each plan page starts on the first agent with no AI. */
  pickedAgent: string | null;
  /** A row of what the person already has asked for one more sign-in of its account, on its plan's page. */
  login: ExistingSignIn | null;
  /** A plan's page waited for the computer: once it's ready, every plan's page says so. */
  waited: boolean;
  key: KeyDraft;
}

const flows = new Map<string, ConnectAiFlow>();
const listeners = new Set<() => void>();
let made = 0;

function emit() {
  for (const listener of listeners) listener();
}

/** A key the chat caught, for the next flow's key page: never in its address, which would carry the secret. */
let handedKey = "";

/** The next flow opens with `key` typed on its key's page (`openConnectAi` with the intent `api_key` follows). */
export function handKeyToConnectAi(key: string) {
  handedKey = key;
}

/** A new flow for its first page, the key's maker the ask named (or guessed); returns its id. */
export function startConnectAi(ask: ConnectAiAsk): string {
  made += 1;
  const id = `connect-${made}`;
  const text = handedKey;
  handedKey = "";
  flows.set(id, {
    ask,
    linked: [],
    pickedAgent: null,
    login: null,
    waited: false,
    key: { provider: providerGuess(text || undefined, ask.provider), custom: ask.provider === CUSTOM_PROVIDER, text },
  });
  return id;
}

/** Changes what the pages share; nothing once the flow has ended. */
export function patchConnectAi(
  id: string,
  patch: Partial<ConnectAiFlow> | ((now: ConnectAiFlow) => Partial<ConnectAiFlow>),
) {
  const now = flows.get(id);
  if (!now) return;
  flows.set(id, { ...now, ...(typeof patch === "function" ? patch(now) : patch) });
  emit();
}

/** The flow left the stack (its first page went): what it shared goes. */
export function endConnectAi(id: string) {
  if (flows.delete(id)) emit();
}

export const connectAiNow = (id: string): ConnectAiFlow | null => flows.get(id) ?? null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useConnectAi(id: string): ConnectAiFlow | null {
  return useSyncExternalStore(subscribe, () => flows.get(id) ?? null);
}

/** A page past the first is pushed over the one before: `depth` counts the flow's pages under the back stack. */
export type PushedPage = Exclude<FlowView, { page: "home" }>;

/** The address of a page pushed inside the flow `id`, `depth` pages deep (the first page is 1). */
export const connectAiHref = (id: string, depth: number, view: PushedPage) =>
  `/connect-ai/${view.page}?s=${encodeURIComponent(id)}&d=${depth}${view.page === "plan" ? `&choice=${view.choice}` : ""}`;
