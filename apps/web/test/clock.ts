import { afterAll, beforeAll, setSystemTime } from "bun:test";

/**
 * A Wednesday at noon on this machine's clock. The calendar's fixtures sit around today, so a calendar test run on
 * another day or hour reaches other screens, and the geometry check (which lays out only the screens that add a new
 * shape) then picks a different set of them. Pinned, every run draws the same week.
 */
export const CALENDAR_NOW = new Date(2026, 10, 18, 12, 0);

/** This file's clock stopped at `CALENDAR_NOW` from here on, dates made at load included; back to real after it. */
export function pinFileClock() {
  setSystemTime(CALENDAR_NOW);
  afterAll(() => setSystemTime());
}

/** The clock stopped at `CALENDAR_NOW` for one `describe`'s tests only. */
export function pinClockInDescribe() {
  beforeAll(() => setSystemTime(CALENDAR_NOW));
  afterAll(() => setSystemTime());
}
