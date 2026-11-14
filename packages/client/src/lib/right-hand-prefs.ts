import type { TFunction } from "i18next";
import { hourText } from "./team-week";

/**
 * What a person lets the right hand do for them by itself: its daily card ("Resumo do dia"), its weekly card
 * ("Semana da equipe", an administrator's), the summary of approvals waiting and reminders of what they agreed on.
 * Mirrors packages/engine/src/right-hand-prefs.ts.
 */

/** The right hand's other switches, shown only where the server lists them (`LodiPrefs.switches`). */
export type LodiSwitch = "digest" | "reminders" | "teamWatch" | "welcomePeople";

export interface LodiPrefs {
  weekOff: boolean;
  /** The weekly card's day. 0 = Sunday. */
  day: number;
  /** In the workspace's time zone (`timezone`). */
  weekHour: number;
  dayOff: boolean;
  /** In the person's own time zone (`dayTimezone`). */
  dayHour: number;
  digestOff: boolean;
  remindOff: boolean;
  timezone: string;
  dayTimezone: string;
  /** The switches whose feature the server has. None from an older server. */
  switches: LodiSwitch[];
  /** The server is from before the two cards were told apart: it keeps one card and is saved with `legacyPatch`. */
  legacy?: boolean;
}

export type LodiPrefsPatch = Partial<Omit<LodiPrefs, "timezone" | "dayTimezone" | "switches" | "legacy">>;

/** What a server from before the two cards takes: one switch, the daily card in place of the weekly, one hour. */
export interface LegacyPrefsPatch {
  off?: boolean;
  daily?: boolean;
  day?: number;
  hour?: number;
}

/** The daily card or the weekly one. */
export type TeamWeekPeriod = "day" | "week";

/**
 * The server's answer as the apps read it. A server from before the two cards were told apart answers `off`, `daily`
 * and one `hour`: off stops both, daily is the daily card in place of the weekly.
 */
export function lodiPrefsOf(raw: unknown): LodiPrefs {
  const r = (raw ?? {}) as Partial<LodiPrefs> & { off?: boolean; daily?: boolean; hour?: number };
  const timezone = r.timezone ?? "UTC";
  return {
    weekOff: r.weekOff ?? (r.off === true || r.daily === true),
    day: r.day ?? 5,
    weekHour: r.weekHour ?? r.hour ?? 17,
    dayOff: r.dayOff ?? (r.off === true || r.daily !== true),
    dayHour: r.dayHour ?? r.hour ?? 9,
    digestOff: r.digestOff === true,
    remindOff: r.remindOff === true,
    timezone,
    dayTimezone: r.dayTimezone ?? timezone,
    switches: Array.isArray(r.switches) ? r.switches : [],
    ...(r.weekOff === undefined ? { legacy: true } : {}),
  };
}

/**
 * A save as a server from before the two cards takes it. That server would drop the new fields and answer as if it
 * had saved, so a switch would snap back with no error. It keeps one card: stopping either stops it, starting one
 * picks which comes, and its one hour is of that card.
 */
export function legacyPatch(patch: LodiPrefsPatch): LegacyPrefsPatch {
  const hour = patch.dayHour ?? patch.weekHour;
  return {
    ...(patch.day === undefined ? {} : { day: patch.day }),
    ...(hour === undefined ? {} : { hour }),
    ...(patch.weekOff === true || patch.dayOff === true
      ? { off: true }
      : patch.dayOff === false
        ? { off: false, daily: true }
        : patch.weekOff === false
          ? { off: false, daily: false }
          : {}),
  };
}

/** Whether that card comes to this person: the daily to anyone who has it on, the weekly to administrators. */
export const teamWeekOn = (prefs: Pick<LodiPrefs, "weekOff" | "dayOff">, period: TeamWeekPeriod, admin: boolean) =>
  period === "day" ? !prefs.dayOff : admin && !prefs.weekOff;

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

type Say = (key: string, options?: Record<string, unknown>) => string;

/** "Toda sexta às 17:00" for the weekly card, "Todo dia às 9:00" for the daily, in the reader's language. */
export function teamWeekWhen(
  t: TFunction,
  locale: string,
  prefs: Pick<LodiPrefs, "day" | "weekHour" | "dayHour">,
  period: TeamWeekPeriod,
) {
  const day = period === "day" ? "day" : (DAYS[prefs.day] ?? "fri");
  const hour = period === "day" ? prefs.dayHour : prefs.weekHour;
  return (t as unknown as Say)(`teamWeek.every.${day}`, { time: hourText(locale, hour) });
}
