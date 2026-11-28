import type { Agent, SurfaceLink, SurfaceLinks } from "@agenteschat/client";
import { formatTimeLeft } from "@agenteschat/client/lib/actions";
import { rightHandName } from "@agenteschat/client/lib/right-hand";
import {
  hourLabel,
  RENEW_BEFORE_MS,
  type SurfaceRow,
  surfaceMarkUrl,
  surfaceViaName,
} from "@agenteschat/client/lib/surface-links";
import { surfaceVia } from "@agenteschat/client/lib/via";
import { formatPhone } from "@agenteschat/i18n/format";
import type { TFunction } from "i18next";

/** Linking the outside chat surface (ADR 0187) on the phone: the row in Notificações and its sheet. */

export type LinkStep = "code" | "confirm" | "linked";

/** The sheet's step: a pending link waits on the person's confirm, whatever else is linked. */
export function linkStep(row: SurfaceRow, linked: boolean): LinkStep {
  if (linked) return "linked";
  return row.kind === "pending" ? "confirm" : "code";
}

/** No code yet, or the shown one is about to run out. */
export const codeIsStale = (deadline: number | null, now: number) =>
  deadline === null || deadline - now <= RENEW_BEFORE_MS;

/** "Valid for 9:41" under the code. */
export const codeLeftText = (t: TFunction, deadline: number, now: number) =>
  t("openOnPhone.validFor", { time: formatTimeLeft(Math.max(0, deadline - now)) });

/**
 * Who the consent line and the sheet name: null only while the agents load. A workspace with no right hand, or agents
 * that failed to load, gets the generic label, and the server's confirm says why when it refuses.
 */
export const linkAssistant = (
  agents: { isPending: boolean; data?: readonly Pick<Agent, "builtin" | "name">[] | undefined },
  fallback: string,
) => (agents.isPending ? null : (rightHandName(agents.data) ?? fallback));

/** A pending link whose 10 minutes ran out on this device's clock; a link removed by "Not me" has not. */
export const linkRanOut = (link: Pick<SurfaceLink, "expiresAt">, now: number) =>
  link.expiresAt !== null && Date.parse(link.expiresAt) <= now;

/** The sender the confirm step names: the number formatted, and the surface's profile name. */
export const surfaceSenderText = (link: Pick<SurfaceLink, "display" | "profileName">) => ({
  display: link.display ? formatPhone(link.display) : null,
  profileName: link.profileName,
});

/**
 * What the row says beside the surface's name: a state under it (`sub`, `below`), what linking does behind its ⓘ
 * (`hint`).
 */
export function surfaceRowText(
  t: TFunction,
  row: Exclude<SurfaceRow, { kind: "hidden" }>,
  assistant: string | null,
): { sub?: string; below?: string; hint?: string; value?: string } {
  if (row.kind === "pending") return { sub: t("surface.row.pending") };
  if (row.kind === "active") {
    const { display, profileName } = row.link;
    return {
      sub: display ? formatPhone(display) : (profileName ?? undefined),
      ...(display && profileName ? { below: profileName } : {}),
      value: t("mobile.surface.on"),
    };
  }
  return { ...(assistant ? { hint: t("surface.row.none", { assistant }) } : {}), value: t("surface.row.link") };
}

/**
 * The tag on a person's message written on the surface, or null. `data`: the links answer, for the surface's name.
 * `mark`: the surface's logo's path, for one written there (a forwarded one keeps the quote glyph).
 */
export function surfaceTagText(
  t: TFunction,
  meta: Record<string, unknown> | null | undefined,
  person: string,
  data: SurfaceLinks | null | undefined,
  locale?: string,
): { label: string; hint: string; mark: string | null } | null {
  const via = surfaceVia(meta);
  if (!via) return null;
  const surface = surfaceViaName(via.surface, data?.surface?.name, locale);
  return via.forwarded
    ? { label: t("surface.forwarded", { surface }), hint: t("surface.forwardedTip", { person, surface }), mark: null }
    : {
        label: t("surface.via", { surface }),
        hint: t("surface.viaTip", { person, surface }),
        mark: surfaceMarkUrl(via.surface),
      };
}

/** The quiet hours as the nudge row shows them: "22:00 to 8:00" on the reader's clock (ADR 0234). */
export const quietHoursText = (t: TFunction, locale: string, nudge: SurfaceLink["nudge"]) =>
  t("surface.nudge.quietRange", { from: hourLabel(locale, nudge.quietFrom), to: hourLabel(locale, nudge.quietTo) });
