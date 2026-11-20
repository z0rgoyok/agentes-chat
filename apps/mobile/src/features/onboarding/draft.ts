import type { WorkspaceMode } from "@agenteschat/client";
import type { RailStep } from "@agenteschat/client/lib/onboarding";
import type { BusinessType } from "@agenteschat/client/lib/team-plan";
import { useSyncExternalStore } from "react";

/*
 * The first run's answers while its steps are pushed one over the other (ADR 0162; each step a screen of its own on
 * the native stack, the system's back going to the step before): what the steps share lives here, since a route
 * carries no callback and a step popped and pushed again starts fresh. The root layout opens it as it pushes the first
 * page (`openOnboarding`); the first page ends it as it leaves the stack (`endOnboarding`), whether the workspace
 * opened or the person went back where they came from. Pure (no React Native imports), so it is unit-tested.
 */

/** The first page's address. */
export const ONBOARDING_ROUTE = "/onboarding";

/** The first page's param: it is the app's start, so there is nothing under it to go back to. */
export const ROOT_PARAM = "root";

/** Whether the first page's params say it is the app's start. */
export const isRootPage = (params: unknown): boolean =>
  typeof params === "object" && params !== null && (params as Record<string, unknown>)[ROOT_PARAM] === "1";

/** The steps pushed over the first page, each its own screen (the phone's rail: the web's own steps aside). */
export const PUSHED_STEPS = ["name", "business", "team", "plan"] as const satisfies readonly RailStep[];
export type PushedStep = (typeof PUSHED_STEPS)[number];

/** Whether a route param names a step the phone pushes. */
export const isPushedStep = (value: unknown): value is PushedStep =>
  typeof value === "string" && (PUSHED_STEPS as readonly string[]).includes(value);

/** A pushed step's address. */
export const stepHref = (step: PushedStep) => `${ONBOARDING_ROUTE}/${step}`;

/**
 * The steps to push after `from` to reach `to` (the step the workspace's data says), in order: a visit left at the
 * team's step resumes with the name's and what it does under it, so the system's back walks them as on the first
 * visit. Nothing when `to` is not further on, or is a step the phone doesn't push.
 */
export function stepsBetween(steps: readonly RailStep[], from: RailStep, to: RailStep | "open"): PushedStep[] {
  const start = steps.indexOf(from);
  const end = to === "open" ? -1 : steps.indexOf(to);
  if (start < 0 || end <= start) return [];
  return steps.slice(start + 1, end + 1).filter(isPushedStep);
}

/** The step after `step` on the rail, if the phone pushes one. */
export function nextStep(steps: readonly RailStep[], step: RailStep): PushedStep | null {
  const next = steps[steps.indexOf(step) + 1];
  return isPushedStep(next) ? next : null;
}

export interface OnboardingDraft {
  /** Which flow this is: a page ends only its own. */
  id: number;
  /** The workspace the person is still in meanwhile (Add workspace, ADR 0154): its name; null on a first run. */
  another: string | null;
  /** The first page's back: what leaving for where the person came from does; null when it is the app's start. */
  leave: (() => void) | null;
  /** The workspace made on the name's step, until `me` lists it. */
  created: { orgId: string; generalChannelId: string } | null;
  /** What it is for (ADR 0159), the first question's answer. */
  purpose: WorkspaceMode | null;
  /** The name being typed. */
  name: string;
  /** The name a work address suggested ("" for none), worked out once. */
  suggested: string | null;
  /** The zone picked on the name's step, if one was. */
  zone: string | null;
  /** What the business step picked in this visit, and the template the team step picked. */
  business: BusinessType | null;
  template: string | null;
  /** The earlier steps were pushed under the one a visit left off at (once per flow). */
  resumed: boolean;
  /** The workspace opened by itself once everything was answered (once, until Try again). */
  autoOpened: boolean;
  /** The workspace is opening: the pages leave with it, never back to where the flow was opened from. */
  finishing: boolean;
}

let current: OnboardingDraft | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function set(next: OnboardingDraft | null) {
  current = next;
  for (const listener of listeners) listener();
}

/** Starts the first run's answers; the root layout pushes the first page next. */
export function openOnboarding(start: Pick<OnboardingDraft, "another" | "leave">): OnboardingDraft {
  const draft: OnboardingDraft = {
    id: ++seq,
    ...start,
    created: null,
    purpose: null,
    name: "",
    suggested: null,
    zone: null,
    business: null,
    template: null,
    resumed: false,
    autoOpened: false,
    finishing: false,
  };
  set(draft);
  return draft;
}

/** Changes the answers of the flow on screen (nothing once it has ended). */
export function updateOnboarding(patch: Partial<Omit<OnboardingDraft, "id">>) {
  if (current) set({ ...current, ...patch });
}

/**
 * Ends flow `id` (the one a first page showed) and says what it was then: a flow opened meanwhile for the next first
 * run (the person back from it and in again before the page slid away) stays.
 */
export function endOnboarding(id: number): OnboardingDraft | null {
  const ended = current?.id === id ? current : null;
  if (ended) set(null);
  return ended;
}

export const onboardingNow = (): OnboardingDraft | null => current;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The answers, for the steps. */
export function useOnboardingDraft(): OnboardingDraft | null {
  return useSyncExternalStore(subscribe, () => current);
}

/**
 * Which flow is open and whether its workspace is opening, for the root layout: it follows only these, never each
 * answer typed on a step.
 */
export function useOnboardingFlow(): { id: number | null; finishing: boolean } {
  const id = useSyncExternalStore(subscribe, () => current?.id ?? null);
  const finishing = useSyncExternalStore(subscribe, () => current?.finishing === true);
  return { id, finishing };
}
