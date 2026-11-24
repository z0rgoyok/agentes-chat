import type { ConnectIntent } from "@agenteschat/client";
import { useApi } from "@agenteschat/client";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { stepPermissions } from "@agenteschat/client/lib/home";
import { type AiChoice, mayConnectAi, type PlanChoice } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { createContext, type ReactNode, Suspense, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConnectStart } from "@/components/devices/ConnectDialog";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { lazyDialog } from "@/lib/lazy-dialog";
import { useOpenParam } from "@/lib/open-param";
import { useToast } from "@/lib/toast";

/*
 * "Conectar uma IA" (ADR 0061) as the workspace's shell holds it: who may connect, the request and its provider. The
 * dialog itself (`ConnectAi.tsx`, with every plan's steps and the phone and computer pairing) comes when it opens.
 */

const LazyConnectAiDialog = lazyDialog(() => import("./ConnectAi").then((m) => m.ConnectAiDialog));
const LazyConnectDialog = lazyDialog(() => import("./devices/ConnectDialog").then((m) => m.ConnectDialog));

export interface ConnectAiRequest {
  /** The step the message asked for (Jev); `any`, `task` or none: the first step. */
  intent?: ConnectIntent;
  /** The plan it opens on, over `intent`: a card's Sign in again, on the agent's own plan (a coding plan's too). */
  plan?: PlanChoice;
  /** With `api_key`: the provider it named. */
  provider?: string;
  /** The agent to connect: the dialog is for it alone. */
  agentId?: string;
  /** The agents to choose from (an agent's card names them); `agentId` is chosen first. */
  agentIds?: string[];
  /** The no-AI card or the person's message: once connected, it is answered ("Responder agora"). */
  from?: string;
  /** A key pasted in the composer. */
  apiKey?: string;
  /** Opened by itself (Jev), not by a click: never over a dialog already open. */
  auto?: boolean;
  /** Opened because the workspace's computer just got ready (its email, its notification): a plan's panel says so. */
  ready?: boolean;
  /**
   * Opened from the create-agent step for an agent of the person's own still being made: a plan signs in for the
   * agents they create (as with no agent yet), never for one they have.
   */
  forNewAgent?: boolean;
  /** Opened over a form still being filled in (Criar agente's steps): a Settings page opens in a new tab. */
  overDraft?: boolean;
  /**
   * Opened right after the onboarding (ADR 0160): the team stands asleep beside the choices, which are cards in
   * words, and wakes as the sky turns to day once an AI is connected. The plans' own steps are the same.
   */
  arrival?: boolean;
  /**
   * Opened from the agent's own conversation (the notice over the composer, its setup card), for an agent of the
   * person's with no AI: the sky over a narrow dialog, what they already have to pick from first, and for every agent
   * of theirs with no AI unless they narrow it to this one (ADR 0160, addendum).
   */
  chat?: boolean;
  /**
   * The card already picked (the onboarding's AI step, ADR 0162): the narrow dialog, for the team or for one agent,
   * opens on that choice's steps, a key's too. Unlike `plan` (sign in again) and `intent: "api_key"` (a key asked
   * for), which keep the plain dialog.
   */
  start?: AiChoice;
  /**
   * What was connected here, each time something is (a plan, a key, an account the person already had): the
   * onboarding's AI step names it, which may not be the card it opened on, since Back leads to every other choice.
   */
  onConnected?: (choice: AiChoice) => void;
  /** Opened from another dialog that closed for it ("Conectar outra IA"): its first screen's Back opens that one again. */
  onBack?: () => void;
}

/** How "Responder agora" went for a message, in this tab. */
export type AnswerState = "pending" | "answering" | "still_missing";

export interface ConnectAi {
  open(request: ConnectAiRequest): void;
  /** "Responder agora" (`from`: the no-AI card or the person's message). */
  answer(from: string): Promise<void>;
  answered: Record<string, AnswerState>;
}

const ConnectAiContext = createContext<ConnectAi | null>(null);

/** Null outside the workspace shell (an isolated page in a test): no Connect there. */
export const useConnectAi = () => useContext(ConnectAiContext);

/**
 * Whether this person has an AI to connect: the workspace's key, a plan for an agent they have or may make, or their
 * own for the right hand. Yes until the agents are known, so nobody reads "who connects it" for a moment.
 */
export function useMayConnectAi() {
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  return (
    dir.loading ||
    stepPermissions(org, me.user.id, dir.agents).connectAi ||
    can(org, "create_agents") ||
    mayConnectAi(rightHandOf(dir.agents), me.user.id, org)
  );
}

export function ConnectAiProvider({
  children,
  poll,
  settingUp = false,
}: {
  children: ReactNode;
  /**
   * Where no socket keeps them current (the onboarding, ADR 0162): how often the dialog reads the AI status, the
   * computers and the plans' state again while it is open.
   */
  poll?: number;
  /**
   * On the onboarding: the workspace's pages don't open until it ends (the org route sends them back to it), so the
   * dialog offers no way out to one (Computers, the keys), saying what comes after instead.
   */
  settingUp?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  // Each opening is its own dialog (`n`): what was chosen in another one doesn't carry over.
  const [request, setRequest] = useState<(ConnectAiRequest & { n: number }) | null>(null);
  const [answered, setAnswered] = useState<Record<string, AnswerState>>({});
  const open = useCallback((next: ConnectAiRequest) => {
    setRequest((current) => (current && next.auto ? current : { ...next, n: (current?.n ?? 0) + 1 }));
  }, []);
  // A link that asks for it (the computer ready email's "Connect your AI"): open once, then drop it from the address.
  const [asked, clearAsked] = useOpenParam("connect");
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per link
  useEffect(() => {
    if (asked !== "ai") return;
    open({ ready: true });
    clearAsked(null);
  }, [asked]);
  const answer = useCallback(
    async (from: string) => {
      setAnswered((a) => ({ ...a, [from]: "pending" }));
      try {
        await api.chat.answerNow(org.id, from);
        setAnswered((a) => ({ ...a, [from]: "answering" }));
      } catch (error) {
        const missing = errorCode(error) === "ai.still_missing";
        setAnswered((a) => {
          const { [from]: _pending, ...rest } = a;
          return missing ? { ...rest, [from]: "still_missing" } : rest;
        });
        if (!missing) toast.show(errorText(t, error), "error");
      }
    },
    [api, org.id, toast, t],
  );
  const value = useMemo(() => ({ open, answer, answered }), [open, answer, answered]);
  // A computer connected from a plan's panel, over this dialog: once it pairs, the panel signs the plan in there.
  const [pairing, setPairing] = useState(false);
  return (
    <ConnectAiContext.Provider value={value}>
      {children}
      <Suspense fallback={null}>
        {request && (
          <LazyConnectAiDialog
            key={request.n}
            request={request}
            poll={poll ?? false}
            settingUp={settingUp}
            onClose={() => setRequest(null)}
            onConnected={(choice) => {
              if (request.from) void answer(request.from);
              request.onConnected?.(choice);
            }}
            onPairComputer={() => setPairing(true)}
          />
        )}
        {pairing && <LazyConnectDialog start={PAIR_START} onClose={() => setPairing(false)} />}
      </Suspense>
    </ConnectAiContext.Provider>
  );
}

const PAIR_START: ConnectStart = { step: "choose" };
