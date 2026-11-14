/**
 * The channel's sky band: on the first visit of a new day to a workspace, the
 * first channel you open greets you and says what its agents did since your
 * last visit. The pure rules; each platform keeps the visits.
 */

/** Greet when the last visit was on another (local) day; never on the very first visit (onboarding does that). */
export function isNewDay(last: number | null, now = new Date()) {
  if (last === null) return false;
  const a = new Date(last);
  return a.getFullYear() !== now.getFullYear() || a.getMonth() !== now.getMonth() || a.getDate() !== now.getDate();
}

/** How long after the person's first press, key or scroll the greeting closes by itself, on the web and the phone. */
export const WELCOME_CLOSE_MS = 8_000;
/** How long it still waits once the pointer, the focus or a finger has left it. */
export const WELCOME_LEAVE_MS = 2_000;

/**
 * The greeting's clock, the web's and the phone's. `close` runs once, `WELCOME_CLOSE_MS` after the first `used()`, never
 * while `held()` (the pointer, the focus or a finger on it), and never sooner than `WELCOME_LEAVE_MS` after the last
 * `left()`: coming back within that waits again. No use, no clock.
 */
export function welcomeClock(close: () => void, held: () => boolean) {
  let clock: ReturnType<typeof setTimeout> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let due = false;
  let free = true;
  let done = false;
  const check = () => {
    if (done || !due || !free || held()) return;
    done = true;
    close();
  };
  return {
    used() {
      if (clock !== undefined) return;
      clock = setTimeout(() => {
        due = true;
        check();
      }, WELCOME_CLOSE_MS);
    },
    left() {
      free = false;
      clearTimeout(grace);
      grace = setTimeout(() => {
        free = true;
        check();
      }, WELCOME_LEAVE_MS);
    },
    /** Whether the person used the page since it showed and it hasn't closed: leaving it now counts as closing it. */
    running: () => clock !== undefined && !done,
    stop() {
      clearTimeout(clock);
      clearTimeout(grace);
    },
  };
}

export type DayPart = "morning" | "afternoon" | "evening";

export const dayPart = (hour: number): DayPart =>
  hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 18 ? "afternoon" : "evening";

/** Agent messages after `since`: who wrote and how many, most active first. */
export function agentActivitySince(
  messages: { author: { type: string; id: string | null }; createdAt: string }[],
  since: number,
): { agentIds: string[]; count: number } {
  const per = new Map<string, number>();
  let count = 0;
  for (const m of messages) {
    if (m.author.type !== "agent" || !m.author.id || new Date(m.createdAt).getTime() <= since) continue;
    per.set(m.author.id, (per.get(m.author.id) ?? 0) + 1);
    count++;
  }
  const agentIds = [...per.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  return { agentIds, count };
}
