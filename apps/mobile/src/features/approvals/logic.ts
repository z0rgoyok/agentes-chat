import type { Approval } from "@agenteschat/client";
import { approvalCards } from "@agenteschat/client/lib/approval-card";
import { approvalWhy } from "@agenteschat/client/lib/approval-origin";
import { type ApprovalEffect, approvalEffects, approvalTarget } from "@agenteschat/client/lib/approval-review";
import { approvalValues } from "@agenteschat/client/lib/approval-words";
import { plainLine } from "@agenteschat/client/lib/markdown";
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import type { Fact } from "@/ui/FactStrip";
import type { IconName } from "@/ui/Icon";
import { genderOf } from "../shared/logic";

/**
 * A request an agent makes before a sensitive action: how risky it is (high
 * risk takes a hold, never a tap), the facts the sheet lists, and the order
 * of what waits on you.
 */

// The verb, the risk and the chips are the web's own rules (`@agenteschat/client/lib/approval-kind`).
export {
  type ApprovalAction,
  type ApprovalTrait,
  approvalAction,
  approvalRisk,
  approvalTraits,
  approveAlwaysOffered,
} from "@agenteschat/client/lib/approval-kind";
export { approveAlwaysHint, approveAlwaysLabel } from "@agenteschat/client/lib/approval-words";

/**
 * The toast after "Aprovar sempre": the agent won't ask for this again, and where to undo it (its profile). With
 * `routine` ("Sempre nesta rotina"): that routine won't, and the place is its settings.
 */
export function approveAlwaysToast(t: TFunction, name: string, routine?: string | null) {
  if (routine) {
    return { title: t("approval.always.doneRoutine", { routine }), subtitle: t("approval.always.undoRoutine") };
  }
  return { title: t("approval.always.done", { name }), subtitle: t(`mobile.approval.alwaysUndo${genderOf(name)}`) };
}

/** Waiting on you: pending ones you may decide, in the order the agents asked (the web's `approvalCards` order). */
export function waitingApprovals(list: Approval[], now = Date.now()): Approval[] {
  return approvalCards(
    list.filter((a) => a.status === "pending" && a.canDecide && new Date(a.expiresAt).getTime() > now),
  ).flat();
}

/**
 * The details table of a request: where it goes
 * (`via`: the connector and its account) first, then the exact values it runs with, in words and one level
 * into objects (the web's `approvalValues`: a tool run by name shows its arguments, not `name`). Only what
 * the request carries; nothing is made up. `label: null` is the "Por onde" row (its label is translated).
 * `long`: every value whole (the request's sheet); else values over 60 characters stay out (cards).
 */
export function approvalTable(
  a: Pick<Approval, "params" | "connector" | "connectorAccount" | "email">,
  max = 3,
  connectorName: (id: string) => string = (id) => id,
  long = false,
): { label: string | null; value: string }[] {
  const via = a.connector ? [connectorName(a.connector), a.connectorAccount].filter(Boolean).join(" · ") : "";
  const rows: { label: string | null; value: string }[] = via ? [{ label: null, value: via }] : [];
  for (const [label, value] of approvalValues(a, { max, long })) rows.push({ label, value });
  return rows.slice(0, max);
}

/** What the agent said right before asking: its `why`, else the last turn of the trail. */
export function approvalSaid(a: Pick<Approval, "why" | "trail">): string | null {
  const last = a.trail?.at(-1)?.text;
  return approvalWhy(a) || (last ? plainLine(last) : "") || null;
}

const EFFECT_ICON: Record<ApprovalEffect, IconName> = {
  external: "send",
  production: "cloud",
  unsent: "archive",
  readsOnly: "eye",
};

/**
 * A request's facts strip, as the web's review (ADR 0218, addendum 2026-11-24): where it acts (the app, then the repository, channel or account),
 * what it does to the outside, and the role that answers for it. Its deadline is the fuse's line above the title, and
 * who decides it or how it ended is the line at the screen's foot: each said once.
 */
export function requestFacts(
  t: TFunction,
  a: Approval,
  o: { source: string; mark: ReactNode; role?: string | undefined; personal?: boolean },
): Fact[] {
  const { effect } = approvalEffects(a);
  const account = a.email ? a.email.provider : (a.connectorAccount ?? null);
  const where = [o.source, approvalTarget(a) ?? account].filter(Boolean).join(" · ");
  return [
    { key: "where", icon: o.mark, label: t("approvals.review.where"), value: where },
    ...(effect
      ? [
          {
            key: "effect",
            icon: EFFECT_ICON[effect],
            label: t("approvals.review.effect"),
            // What leaves a personal workspace (ADR 0159) leaves its person's workspace, not a company.
            value:
              effect === "external" && o.personal
                ? t("mobile.approval.trait.externalPersonal")
                : t(`approvals.review.effects.${effect}`),
            ...(effect === "production" ? { tone: "waiting" as const } : {}),
          },
        ]
      : []),
    ...(a.status === "pending" && o.role
      ? [
          {
            key: "decides",
            icon: "person",
            label: t("approvals.review.decides"),
            value: t("approvals.review.decidesRole", { role: o.role }),
          },
        ]
      : []),
  ];
}
