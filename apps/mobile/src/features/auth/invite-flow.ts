import type { InvitationPreview } from "@agenteschat/client";
import { useRef, useSyncExternalStore } from "react";
import type { Asked } from "./invite-steps";

/*
 * An invitation's steps as pushed screens, signed out (ADR 0090): its first screen is the link's own
 * (`/invite/<token>`), and each step after it a screen pushed over it (`/invite/<token>/<step>`), the system's back
 * going to the one before. A route can't carry what the steps share (the address typed, the code that proved it, the
 * name for the new password) nor how they hand back to the first screen (it joins, or waits for an answer), so the
 * first screen keeps it here under the invitation's token while it is open.
 */

/** An email invitation, signed out: a new address's name, then its password on a screen of its own (ADR 0090 §6). */
export interface EmailInviteFlow {
  kind: "email";
  preview: InvitationPreview;
  /** The proof on the link opened from its own email. */
  mail?: string;
  /** The name typed on the first screen, for the new password's. */
  name: string;
  /** The new password's screen found the name typed as the password: said on the name's screen, back under it. */
  nameError: string | null;
  /** Signed in on a screen over the first: once the session comes and the first is on top again, it joins. */
  joinOnSession: boolean;
  /** A sign-in starts on a step: the invitation's screen keeps these screens up while the session arrives. */
  onSigningIn: () => void;
}

/** Asking through a link, signed out where email goes out: the e-mail, its code, then the person (ADR 0090 §1). */
export interface LinkInviteFlow {
  kind: "link";
  preview: InvitationPreview;
  /** The address typed on the first screen. */
  email: string;
  /** The code that proved an address: another address starts over. */
  proof: { email: string; code: string } | null;
  /** The code last sent, and when another may go. */
  sent: { to: string; resendAt: number } | null;
  /** An address past its hourly or daily cap: each press would be a sure refusal that still spends the link's budget. */
  capped: string | null;
  /** A step over the first sent the person back to the e-mail with this (the proof ran out). */
  emailError: string | null;
  /** Asked, with a key to wait with: the first screen becomes the wait. */
  onAsked: (asked: Asked) => void;
}

export type InviteFlow = EmailInviteFlow | LinkInviteFlow;

const flows = new Map<string, InviteFlow>();
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

/** The first screen opened (or changed what it shares). */
export function setInviteFlow(token: string, flow: InviteFlow) {
  flows.set(token, flow);
  changed();
}

/** A step changed part of what an email invitation's screens share. */
export function updateEmailInvite(token: string, patch: Partial<Omit<EmailInviteFlow, "kind">>) {
  const flow = flows.get(token);
  if (flow?.kind !== "email") return;
  flows.set(token, { ...flow, ...patch });
  changed();
}

/** A step changed part of what a link's screens share. */
export function updateLinkInvite(token: string, patch: Partial<Omit<LinkInviteFlow, "kind">>) {
  const flow = flows.get(token);
  if (flow?.kind !== "link") return;
  flows.set(token, { ...flow, ...patch });
  changed();
}

/** The first screen closed, or became another (the wait, the account's own answer): its steps go with it. */
export function endInviteFlow(token: string) {
  if (!flows.delete(token)) return;
  changed();
}

export const inviteFlowNow = (token: string): InviteFlow | null => flows.get(token) ?? null;

export function useInviteFlow(token: string): InviteFlow | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => flows.get(token) ?? null,
  );
}

/**
 * The flow a step was opened with, of its kind. It stays what the step shows while the step slides away after its
 * first screen became another (a request that now waits): `opened` says whether there was one as the step opened.
 */
export function useInviteStepFlow<K extends InviteFlow["kind"]>(token: string, kind: K) {
  const live = useInviteFlow(token);
  const last = useRef<Extract<InviteFlow, { kind: K }> | null>(null);
  if (live?.kind === kind) last.current = live as Extract<InviteFlow, { kind: K }>;
  const opened = useRef(last.current !== null);
  return { flow: last.current, opened: opened.current };
}
