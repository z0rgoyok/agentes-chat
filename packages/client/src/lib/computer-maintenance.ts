import type { TFunction } from "i18next";
import type { ComputerMaintenance } from "../api/types";
import { clockAt, durationText } from "./format";

/**
 * What we do to the workspace's own computer (ADR 0257), worded the same on the web, the desktop app and the phone:
 * a short label for its chip, one line with about when it is back, and the details its tip opens (what, why, since
 * when, expected back, what still works). Never sleep: a computer in standby has no maintenance (ADR 0161).
 */

const KINDS = ["moving", "restarting", "updating", "converting", "host_maintenance"] as const;
type Kind = (typeof KINDS)[number] | "other";
const kindOf = (m: ComputerMaintenance): Kind =>
  (KINDS as readonly string[]).includes(m.kind) ? (m.kind as Kind) : "other";

/** A server from before `maintenance` says only `moving`: a move, nothing more known. */
export const LEGACY_MOVE: ComputerMaintenance = { kind: "moving", since: "", eta: null, detail: null, away: true };

/** What a machine, a device, an outage or a line says is done to it: `maintenance`, or a bare `moving` from before it. */
export const maintenanceOf = (x: { maintenance?: ComputerMaintenance | null; moving?: boolean } | null | undefined) =>
  x?.maintenance ?? (x?.moving ? LEGACY_MOVE : null);

/** `t` for a key built from a code: the keys exist, the type can't list them. */
const say = (t: TFunction, key: string, options?: Record<string, unknown>) =>
  (t as unknown as (key: string, options?: Record<string, unknown>) => string)(key, options);

/** "Restarting", "Moving servers": the chip's and the pill's word. */
export const maintenanceShort = (t: TFunction, m: ComputerMaintenance) =>
  say(t, `machines.maintenance.short.${kindOf(m)}`);

/** "Restarting… back in about 2 min", "Copying to a new server… it may be slower meanwhile". */
export function maintenanceLine(t: TFunction, m: ComputerMaintenance, now = new Date()) {
  const copying = m.kind === "moving" && m.detail === "copying";
  const what = say(t, `machines.maintenance.what.${copying ? "copying" : kindOf(m)}`);
  return t("machines.maintenance.line", { what, when: maintenanceWhen(t, m, now) });
}

/** "Acme's computer: Restarting… back in about 2 min". */
export const maintenanceNamed = (t: TFunction, m: ComputerMaintenance, computer: string, now = new Date()) =>
  t("machines.maintenance.named", { computer, line: maintenanceLine(t, m, now) });

/** "back in about 2 min", "back in a few minutes", "it may be slower meanwhile". */
export function maintenanceWhen(t: TFunction, m: ComputerMaintenance, now = new Date()) {
  const left = m.eta ? Date.parse(m.eta) - now.getTime() : null;
  if (!m.away)
    return left !== null && left > 0
      ? t("machines.maintenance.slowerFor", { time: durationText(t, left) })
      : t("machines.maintenance.slower");
  if (left === null) return t("machines.maintenance.backSoon");
  if (left <= 0) return t("machines.maintenance.late");
  return t("machines.maintenance.back", { time: durationText(t, left) });
}

/**
 * The tip's lines: why (in plain words), since when, expected back or done, and what still works meanwhile.
 */
export function maintenanceDetails(t: TFunction, locale: string, m: ComputerMaintenance, now = new Date()) {
  // Away mid-copy, it doesn't work meanwhile: a move, not "copying while it works".
  const step = m.detail === "copying" && m.away ? null : m.detail;
  const why = step === "unresponsive" || step === "copying" || step === "handover" ? step : kindOf(m);
  const eta = m.eta && Date.parse(m.eta) > now.getTime() ? m.eta : null;
  return [
    say(t, `machines.maintenance.why.${why}`),
    ...(m.since ? [t("machines.maintenance.since", { time: clockAt(locale, m.since, now) })] : []),
    ...(eta
      ? [
          t(m.away ? "machines.maintenance.expectedBack" : "machines.maintenance.expectedDone", {
            time: clockAt(locale, eta, now),
          }),
        ]
      : []),
    t(m.away ? "machines.maintenance.meanwhile" : "machines.maintenance.working"),
  ];
}
