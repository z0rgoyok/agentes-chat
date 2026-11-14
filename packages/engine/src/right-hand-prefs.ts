import { and, type Executor, eq, rowsOf, type SQL, schema, sql } from "@agenteschat/db";
import { NotFoundError } from "./errors";
import { stringsOf, wholeIn } from "./format";
import { maySql } from "./permissions";

/**
 * What each person lets the right hand do for them by itself, kept in `organization_members.team_week`: the day's
 * card, the week's card (administrators), the summary of approvals waiting, reminders of what was agreed, and the
 * suggestions they put away. One reader in code (`lodiPrefsOf`), the same rules in SQL (`lodiPrefsSql`) and one writer
 * (`setLodiPrefs`), which merges, so a key this version does not know survives a save.
 *
 * The column also holds what app builds from before the day's and the week's cards were told apart read and write:
 * `off` (everything stopped), `daily` (the day's card in place of the week's) and `hour` (of whichever comes). Rows
 * saved then are read by those three until their first save here.
 */
export interface LodiPrefs {
  /** "Semana da equipe", an administrator's. */
  weekOff: boolean;
  /** 0 = Sunday … 6 = Saturday. */
  day: number;
  /** 0–23, in the workspace's time zone. */
  weekHour: number;
  /** "Resumo do dia", anyone's. */
  dayOff: boolean;
  /** 0–23, in the person's own time zone (the workspace's when they chose none). */
  dayHour: number;
  /** The summary of approvals waiting on them. */
  digestOff: boolean;
  /** Reminders of what they and the right hand agreed on. */
  remindOff: boolean;
  /**
   * Suggestions this person put away for good, by key (`unanswered:<channelId>`); the newest `MUTED_MAX`. In a patch:
   * the keys to add.
   */
  muted: string[];
}

export const LODI_PREFS_DEFAULTS: LodiPrefs = {
  weekOff: false,
  day: 5,
  weekHour: 17,
  dayOff: false,
  dayHour: 9,
  digestOff: false,
  remindOff: false,
  muted: [],
};

const MUTED_MAX = 200;
/** The hour a card kept when it was chosen with none. */
const LEGACY_HOUR = 17;

/** The same choice as builds from before the two cards read and write it. */
export interface LegacyTeamWeek {
  off: boolean;
  daily: boolean;
  hour: number;
}

export type LodiPrefsPatch = Partial<LodiPrefs & LegacyTeamWeek>;

const whole = (v: unknown, max: number) => wholeIn(v, 0, max);
const flag = (v: unknown) => (typeof v === "boolean" ? v : null);

/**
 * A person's stored choice, whatever it holds, with the defaults for what it lacks. A row from before the two cards
 * keeps exactly what it had: `off` stops both, `daily` is the day's card in place of the week's, and anything else
 * saved then gets no day's card (it was off unless asked for). Only a row that never chose gets today's defaults.
 * `off` was "nothing comes by itself" when it was the only switch, so it also stops the summary of approvals and the
 * reminders until the row says otherwise for each.
 */
export function lodiPrefsOf(raw: unknown): LodiPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const before = flag(r.off) !== null || flag(r.daily) !== null;
  const off = r.off === true;
  const daily = r.daily === true;
  const hour = whole(r.hour, 23);
  return {
    weekOff: flag(r.weekOff) ?? (off || daily),
    day: whole(r.day, 6) ?? LODI_PREFS_DEFAULTS.day,
    weekHour: whole(r.weekHour, 23) ?? (daily ? null : hour) ?? LODI_PREFS_DEFAULTS.weekHour,
    dayOff: flag(r.dayOff) ?? (before ? off || !daily : LODI_PREFS_DEFAULTS.dayOff),
    dayHour: whole(r.dayHour, 23) ?? (daily ? (hour ?? LEGACY_HOUR) : LODI_PREFS_DEFAULTS.dayHour),
    digestOff: flag(r.digestOff) ?? off,
    remindOff: flag(r.remindOff) ?? off,
    muted: stringsOf(r.muted).slice(-MUTED_MAX),
  };
}

/**
 * What an older build shows and its one switch stops: `off` only when nothing comes, `daily` when the day's card comes
 * alone (to anyone but an administrator it is the only card), `hour` of the card it then shows.
 */
export function legacyTeamWeek(p: LodiPrefs, admin: boolean): LegacyTeamWeek {
  const daily = !p.dayOff && (p.weekOff || !admin);
  return { off: p.weekOff && p.dayOff, daily, hour: daily ? p.dayHour : p.weekHour };
}

/** `now` after a save: the new fields as sent, and an older build's `off`, `daily` and `hour` as it meant them. */
export function patchLodiPrefs(now: LodiPrefs, patch: LodiPrefsPatch, admin: boolean): LodiPrefs {
  const { off, daily, hour, muted, ...fields } = patch;
  const was = legacyTeamWeek(now, admin);
  const next = { ...now, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
  // Put away for good: a save adds its keys, so one made from an older read of the list drops none.
  if (muted) next.muted = [...new Set([...now.muted, ...muted])];
  // Its one switch stops everything the right hand does for them by itself. Its start brings back the one card that
  // build draws: the rest has no control there, so it never starts by a tap on that screen.
  if (off === true) next.weekOff = next.dayOff = next.digestOff = next.remindOff = true;
  else if (off === false) next[admin ? "weekOff" : "dayOff"] = false;
  if (daily === true) {
    next.weekOff = true;
    next.dayOff = false;
    if (!was.daily) next.dayHour = was.hour;
  } else if (daily === false) {
    next.weekOff = false;
    // Back to the week's card alone, as that build draws it. With both on it only moved the week's day.
    if (was.daily) next.dayOff = true;
  }
  if (typeof hour === "number") next[legacyTeamWeek(next, admin).daily ? "dayHour" : "weekHour"] = hour;
  return lodiPrefsOf(next);
}

const at = (key: string) => `m.team_week->'${key}'`;
const isTrue = (key: string) => `coalesce(${at(key)} = 'true'::jsonb, false)`;
const isFlag = (key: string) => `coalesce(jsonb_typeof(${at(key)}) = 'boolean', false)`;
const wholeSql = (key: string, max: number) =>
  `case when jsonb_typeof(${at(key)}) = 'number' and (${at(key)})::numeric between 0 and ${max}
    and (${at(key)})::numeric = trunc((${at(key)})::numeric) then (${at(key)})::int end`;

/**
 * `lodiPrefsOf` as SQL over `organization_members m`, for sweeps that pick who is due in one statement. A test holds
 * the two together.
 */
export const lodiPrefsSql = {
  weekOff: sql.raw(
    `(case when ${isFlag("weekOff")} then ${isTrue("weekOff")} else ${isTrue("off")} or ${isTrue("daily")} end)`,
  ) as SQL<boolean>,
  dayOff: sql.raw(`(case when ${isFlag("dayOff")} then ${isTrue("dayOff")}
    when ${isFlag("off")} or ${isFlag("daily")} then ${isTrue("off")} or not ${isTrue("daily")}
    else ${LODI_PREFS_DEFAULTS.dayOff} end)`) as SQL<boolean>,
  digestOff: sql.raw(
    `(case when ${isFlag("digestOff")} then ${isTrue("digestOff")} else ${isTrue("off")} end)`,
  ) as SQL<boolean>,
  remindOff: sql.raw(
    `(case when ${isFlag("remindOff")} then ${isTrue("remindOff")} else ${isTrue("off")} end)`,
  ) as SQL<boolean>,
  day: sql.raw(`coalesce(${wholeSql("day", 6)}, ${LODI_PREFS_DEFAULTS.day})`) as SQL<number>,
  weekHour: sql.raw(`coalesce(${wholeSql("weekHour", 23)},
    case when ${isTrue("daily")} then null else ${wholeSql("hour", 23)} end, ${LODI_PREFS_DEFAULTS.weekHour})`) as SQL<number>,
  dayHour: sql.raw(`coalesce(${wholeSql("dayHour", 23)}, case when ${isTrue("daily")}
    then coalesce(${wholeSql("hour", 23)}, ${LEGACY_HOUR}) else ${LODI_PREFS_DEFAULTS.dayHour} end)`) as SQL<number>,
};

/**
 * For a statement that turns stored time zones into local time: `with ${knownZonesSql} …`, then `zoneSql(zone,
 * fallback)` is the zone when Postgres knows it and the fallback otherwise. A zone is checked against the server's
 * own list when it is saved, which may be newer than the database's: unguarded, one such row would fail the whole
 * statement, for every workspace.
 */
export const knownZonesSql = sql`zones as materialized (select lower(name) as name from pg_timezone_names)`;
export const zoneSql = (zone: SQL, fallback: SQL) =>
  sql`(case when lower(${zone}) in (select name from zones) then ${zone} else ${fallback} end)`;

/** A person's choice with what reading it takes: whether they administer, and the two time zones its hours are in. */
export interface LodiPrefsOfMember {
  prefs: LodiPrefs;
  admin: boolean;
  /** The workspace's time zone: `day` and `weekHour` are in it. */
  timezone: string;
  /** The person's own, else the workspace's: `dayHour` is in it. */
  dayTimezone: string;
}

/** `lock`: inside a transaction, the member's row is held until it ends, so a save reads what the last one wrote. */
export async function readLodiPrefs(
  db: Executor,
  orgId: string,
  userId: string,
  lock = false,
): Promise<LodiPrefsOfMember> {
  const [row] = rowsOf<{ team_week: unknown; admin: boolean; tz: string | null; own_tz: string | null }>(
    await db.execute(sql`select m.team_week, s.timezone as tz, m.timezone as own_tz,
        ${maySql(sql`m.org_id`, sql`m.user_id`, "administrator")} as admin
      from organization_members m left join organization_settings s on s.org_id = m.org_id
      where m.org_id = ${orgId} and m.user_id = ${userId}${lock ? sql` for update of m` : sql``}`),
  );
  if (!row) throw new NotFoundError("Not a member of this workspace");
  const timezone = row.tz || "UTC";
  return {
    prefs: lodiPrefsOf(row.team_week),
    admin: row.admin === true,
    timezone,
    dayTimezone: row.own_tz || timezone,
  };
}

/** What the apps read and save: the choice, an older build's view of it and the time zones. */
export type LodiPrefsView = Omit<LodiPrefs, "muted"> & LegacyTeamWeek & { timezone: string; dayTimezone: string };

const viewOf = ({ prefs, admin, timezone, dayTimezone }: LodiPrefsOfMember): LodiPrefsView => {
  const { muted: _, ...shown } = prefs;
  return { ...shown, ...legacyTeamWeek(prefs, admin), timezone, dayTimezone };
};

/** This person's choice as the apps read it. */
export const getLodiPrefs = async (db: Executor, orgId: string, userId: string) =>
  viewOf(await readLodiPrefs(db, orgId, userId));

/**
 * Saves what this person changed, for them only. The row keeps every key it had that is not written here, and gets an
 * older build's three beside the new ones, so a server of the version before reads the same choice. Two saves at
 * once take turns on the row: the second builds on the first.
 */
export async function setLodiPrefs(
  db: Executor,
  orgId: string,
  userId: string,
  patch: LodiPrefsPatch,
): Promise<LodiPrefsView> {
  return db.transaction(async (tx) => {
    const now = await readLodiPrefs(tx, orgId, userId, true);
    const prefs = patchLodiPrefs(now.prefs, patch, now.admin);
    const stored = { ...prefs, ...legacyTeamWeek(prefs, now.admin) };
    await tx
      .update(schema.organizationMembers)
      .set({ teamWeek: sql`${schema.organizationMembers.teamWeek} || ${JSON.stringify(stored)}::jsonb` })
      .where(and(eq(schema.organizationMembers.orgId, orgId), eq(schema.organizationMembers.userId, userId)));
    return viewOf({ ...now, prefs });
  });
}
