import type { SignInOptions } from "@agenteschat/client";
import { useRef, useSyncExternalStore } from "react";

/*
 * Sign in and sign up as pushed screens: the e-mail first (`/sign-in`, `/sign-up`), then each step the server's answer
 * asks for on a screen of its own over it, the system's back (the bar's button, the edge swipe) going to the one before.
 * A route can't carry what the steps share (the address answered for, the server's answer with its bot check's pass),
 * so the e-mail's screen keeps it here under an id the steps get in their address, and drops it when it closes.
 */

/** What the e-mail's screen found out, for the steps after it. */
export interface SignInFlow {
  /** Which screen the e-mail was typed on: Entrar, or Criar conta with its welcome. */
  start: "in" | "up";
  /** An early-access link's token (ADR 0078), for the sign-up. */
  access?: string;
  /** The address the steps answer for. */
  email: string;
  /** The server's answer to it: how the account signs in, and the bot check's pass for the next request (ADR 0075). */
  options: SignInOptions | null;
}

/** A step after the e-mail: each is a screen of its own. */
export type SignInStep = "password" | "social" | "noPassword" | "name" | "closed" | "expired" | "forgot";

/** Where each step's screen lives (`app/(auth)/(pages)/sign-in/*`). */
export const SIGN_IN_STEP_PATH: Record<SignInStep, string> = {
  password: "/sign-in/password",
  social: "/sign-in/social",
  noPassword: "/sign-in/no-password",
  name: "/sign-in/name",
  closed: "/sign-in/closed",
  expired: "/sign-in/expired",
  forgot: "/sign-in/forgot",
};

/**
 * A step's address: the flow it belongs to, how many steps stand over the e-mail with it (so "Use another email" goes
 * straight back down to the e-mail), and, for the new password's link, the step it was asked from.
 */
export function signInStepHref(step: SignInStep, flow: string, depth: number, from?: SignInStep) {
  return {
    pathname: SIGN_IN_STEP_PATH[step],
    params: { flow, depth: String(depth), ...(from ? { from } : {}) },
  };
}

/** How many steps stand over the e-mail, read from a step's address (one when it says nothing usable). */
export const stepDepth = (raw: string | string[] | undefined) => {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(n) && n > 0 ? n : 1;
};

const flows = new Map<string, SignInFlow>();
const listeners = new Set<() => void>();
let seq = 0;

function changed() {
  for (const listener of listeners) listener();
}

/** A new flow's id, for an e-mail screen that just opened. */
export const newSignInFlowId = () => `sign-in-${Date.now().toString(36)}-${++seq}`;

/** What the e-mail's screen found out, kept before it pushes the next step. */
export function setSignInFlow(id: string, flow: SignInFlow) {
  flows.set(id, flow);
  changed();
}

/** The e-mail's screen closed: its steps went with it, and so does what they shared. */
export function endSignInFlow(id: string) {
  if (!flows.delete(id)) return;
  changed();
}

export const signInFlowNow = (id: string): SignInFlow | null => flows.get(id) ?? null;

export function useSignInFlow(id: string): SignInFlow | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => flows.get(id) ?? null,
  );
}

/**
 * The flow a step was opened with. It stays what the step shows while the step slides away after the e-mail's screen
 * closed: `opened` says whether there was one as the step opened.
 */
export function useSignInStepFlow(id: string) {
  const live = useSignInFlow(id);
  const last = useRef<SignInFlow | null>(null);
  if (live) last.current = live;
  const opened = useRef(last.current !== null);
  return { flow: last.current, opened: opened.current };
}
