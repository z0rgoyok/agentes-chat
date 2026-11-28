import { formatList } from "@agenteschat/i18n/format";
import type { TFunction } from "i18next";
import type { AppNotification } from "../api/types";
import { formatTime } from "./format";
import { workDuration } from "./long-work";

/** A computer that isn't answering, or is back (ADR 0241): the inbox's kinds. */
export const isComputerOutage = (n: Pick<AppNotification, "kind">) =>
  n.kind === "computer_down" || n.kind === "computer_back";

/**
 * Under a computer outage's headline, web and phone alike: since when (down) or for how long it was away (back), then
 * what waits or waited for it ("Since 14:05 · Waiting: 3 agent runs, 7 webhook calls"). Empty for any other kind.
 */
export function computerOutageLine(
  t: TFunction,
  n: Pick<AppNotification, "kind" | "latest" | "createdAt">,
  locale: string,
): string {
  if (!isComputerOutage(n)) return "";
  const { since, runs = 0, calls = 0 } = n.latest;
  const back = n.kind === "computer_back";
  const when = since
    ? back
      ? t("machines.outage.backAfter", { away: workDuration(t, Date.parse(n.createdAt) - Date.parse(since)) })
      : t("machines.outage.since", { time: formatTime(locale, since) })
    : "";
  const what = [
    ...(runs > 0 ? [t("machines.outage.runs", { count: runs })] : []),
    ...(calls > 0 ? [t("machines.outage.calls", { count: calls })] : []),
  ];
  const waits = what.length
    ? t(back ? "machines.outage.waited" : "machines.outage.waiting", { what: formatList(locale, what) })
    : "";
  return [when, waits].filter(Boolean).join(" · ");
}
