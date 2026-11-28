import type { Actor, CalendarEvent, CalendarRange, RoutineTarget } from "../api/types";
import { formatTime, uses12h } from "./format";

export { uses12h };

/** "ter, 20 out": a day as the calendar writes it, in the reader's language. */
export const shortDay = (locale: string, d: Date) =>
  new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short" })
    .format(d)
    .replace(/\./g, "")
    .replace(/ de /g, " ");

/** "ter, 20 out, 15:00–15:30": an event's or a proposal's day and times. */
export const slotText = (locale: string, start: string, end: string) =>
  `${shortDay(locale, new Date(start))}, ${formatTime(locale, start)}–${formatTime(locale, end)}`;

export type RsvpStatus = CalendarEvent["rsvp"][number]["status"];

/** The viewer's answer to an event they're invited to; null when they aren't. */
export const myRsvp = (event: Pick<CalendarEvent, "rsvp"> | undefined, userId: string) =>
  event?.rsvp.find((r) => r.type === "person" && r.id === userId)?.status ?? null;

/** Pixels per hour in the day/week grid. */
export const HOUR_PX = 44;
/** Snap for drag-to-create, move and resize. */
export const SNAP_MIN = 15;

export type CalendarView = "day" | "week" | "month" | "agenda";
/** Where an item comes from (its left color). */
export type ItemSource = "person" | "agent" | "reminder" | "deadline";

export interface CalItem {
  key: string;
  kind: "event" | "reminder" | "deadline";
  source: ItemSource;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  recurring: boolean;
  /** The agent behind it (agent events, reminders): its avatar and color. */
  agentId?: string;
  /**
   * Whose it is: who made an event, the agent of a reminder, who has a task due. The calendar opens
   * the item with their face.
   */
  owner?: Actor;
  /** A task due that several have: all of them, `owner` being the first. */
  owners?: Actor[];
  eventId?: string;
  seriesId?: string | null;
  occurrenceStart?: string | null;
  /** A reminder: its id, who set it and whether this person may cancel it. */
  reminderId?: string;
  setBy?: string | null;
  canCancel?: boolean;
  issueId?: string;
  issueNumber?: number;
  people: Actor[];
  description?: string;
  location?: string | null;
  /** A reminder: the conversation it is posted in. */
  target?: RoutineTarget;
}

// ── Dates (local days) ──────────────────────────────────────────────────────

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const addMinutes = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);
/** The same wall-clock time `n` days later (addDays drops the time). */
export const shiftDays = (d: Date, n: number) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());
export function mondayOf(d: Date) {
  return addDays(startOfDay(d), -((d.getDay() + 6) % 7));
}
export const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();
export const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;

/** The days a view shows around `focus`. */
export function viewDays(view: CalendarView, focus: Date, businessOnly = false): Date[] {
  if (view === "day") return [startOfDay(focus)];
  if (view === "week") {
    const monday = mondayOf(focus);
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i)).filter((d) => !businessOnly || !isWeekend(d));
  }
  if (view === "month") {
    const first = new Date(focus.getFullYear(), focus.getMonth(), 1);
    const start = mondayOf(first);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }
  return Array.from({ length: 30 }, (_, i) => addDays(startOfDay(focus), i));
}

/** The range to fetch for a view: [from, to). */
export function viewRange(view: CalendarView, focus: Date): { from: Date; to: Date } {
  if (view === "day") return { from: startOfDay(focus), to: addDays(startOfDay(focus), 1) };
  if (view === "week") return { from: mondayOf(focus), to: addDays(mondayOf(focus), 7) };
  const days = viewDays(view, focus);
  return { from: days[0] as Date, to: addDays(days[days.length - 1] as Date, 1) };
}

/** Moves the focus one step of the view (−1 / +1). */
export function stepFocus(view: CalendarView, focus: Date, dir: number): Date {
  if (view === "day") return addDays(focus, dir);
  if (view === "week") return addDays(focus, 7 * dir);
  if (view === "month") return new Date(focus.getFullYear(), focus.getMonth() + dir, 1);
  return addDays(focus, 30 * dir);
}

/** "12–18 de outubro de 2026", "28 de setembro – 4 de outubro de 2026", "outubro de 2026". */
export function rangeLabel(locale: string, view: CalendarView, days: Date[], focus: Date) {
  if (view === "month") return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(focus);
  const first = days[0] ?? focus;
  const last = days[days.length - 1] ?? focus;
  if (view === "day")
    return new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(
      first,
    );
  try {
    return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).formatRange(first, last);
  } catch {
    const f = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" });
    return `${f.format(first)} – ${f.format(last)}`;
  }
}

// ── Items ───────────────────────────────────────────────────────────────────

/**
 * Range data → items (events, reminders, issue due dates). The range's routine runs are the Routines page's horizon,
 * never the calendar's: a run is no time anyone keeps (ADR 0053 addendum 2026-11-27).
 */
export function toItems(range: CalendarRange | undefined): CalItem[] {
  if (!range) return [];
  return [
    ...range.events.map((e): CalItem => {
      const agentAuthor = e.createdBy.type === "agent";
      // All-day: the days themselves (`endDate` inclusive), never shifted by a zone.
      const fromDay = (ymd: string) => {
        const [y, m, d] = ymd.split("-").map(Number);
        return new Date(y ?? 2000, (m ?? 1) - 1, d ?? 1);
      };
      const start = e.allDay && e.startDate ? fromDay(e.startDate) : new Date(e.start);
      const end =
        e.allDay && e.endDate
          ? addDays(fromDay(e.endDate), 1)
          : e.allDay
            ? startOfDay(new Date(e.end))
            : new Date(e.end);
      return {
        key: e.occurrenceStart ? `${e.seriesId ?? e.id}@${e.occurrenceStart}` : e.id,
        kind: "event",
        source: agentAuthor ? "agent" : "person",
        title: e.title,
        start,
        end: end > start ? end : addMinutes(start, 30),
        allDay: e.allDay,
        recurring: Boolean(e.rule && e.rule.freq !== "once") || e.recurrence !== "none" || Boolean(e.seriesId),
        agentId: agentAuthor ? e.createdBy.id : undefined,
        owner: e.createdBy,
        eventId: e.id,
        seriesId: e.seriesId ?? null,
        occurrenceStart: e.occurrenceStart ?? null,
        people: e.participants,
        description: e.description,
        location: e.location ?? null,
      };
    }),
    ...(range.reminders ?? []).map(
      (r): CalItem => ({
        key: `reminder-${r.id}`,
        kind: "reminder",
        source: "reminder",
        title: r.message,
        // A moment, not a meeting: a minute long, so one at 23:50 stays on its day; `layoutDay` draws it tall enough to read.
        start: new Date(r.at),
        end: addMinutes(new Date(r.at), 1),
        allDay: false,
        recurring: false,
        agentId: r.agentId,
        owner: { type: "agent", id: r.agentId },
        reminderId: r.id,
        setBy: r.createdBy,
        canCancel: r.canCancel,
        people: [],
        target: { type: "conversation", channelId: r.channelId, threadId: r.threadId, reminder: true },
      }),
    ),
    ...range.deadlines.map((d): CalItem => {
      const [y, m, day] = d.date.split("-").map(Number);
      const start = new Date(y ?? 2000, (m ?? 1) - 1, day ?? 1);
      return {
        key: `deadline-${d.issueId}`,
        kind: "deadline",
        source: "deadline",
        title: d.title,
        start,
        end: addDays(start, 1),
        allDay: true,
        recurring: false,
        issueId: d.issueId,
        issueNumber: d.number,
        owner: d.assignees?.[0],
        owners: d.assignees?.length ? d.assignees : undefined,
        people: [],
      };
    }),
  ];
}

/** Everyone an item counts for: a due task's assignees, else its one owner. */
export const itemOwners = (it: Pick<CalItem, "owner" | "owners">): Actor[] => it.owners ?? (it.owner ? [it.owner] : []);

/** All-day, or crossing midnight: drawn as a bar above the hour grid. */
export const isBarItem = (it: CalItem) =>
  it.allDay || it.end.getTime() - startOfDay(it.start).getTime() > 86_400_000 + 60_000;

/** Whether an item touches a day. */
export const onDay = (it: CalItem, d: Date) => it.start < addDays(startOfDay(d), 1) && it.end > startOfDay(d);

// ── Layout ──────────────────────────────────────────────────────────────────

export interface Placed {
  item: CalItem;
  /** Minutes from midnight (clipped to the day). */
  top: number;
  /** How long it is in minutes. */
  height: number;
  /** Side by side when overlapping: column and how many share the cluster. */
  col: number;
  cols: number;
}

/** Pixels in the day/week grid → minutes. */
const toMinutes = (px: number) => (px / HOUR_PX) * 60;

/**
 * The grid's measured heights (px, by key) after a new measure: each only grows, by more than half a pixel; the same
 * map when none did. The layout follows these heights and they follow the layout (`layoutDay`), and it isn't
 * monotonic: a block pushed beside another is drawn narrower, so its title wraps and it grows taller, which can push
 * the next one aside too. With heights allowed to shrink, such a layout flips back and forth on every render, forever.
 */
export function grownHeights(
  heights: ReadonlyMap<string, number>,
  drawn: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  let grown: Map<string, number> | null = null;
  for (const [key, height] of drawn)
    if (height > (heights.get(key) ?? 0) + 0.5) {
      grown ??= new Map(heights);
      grown.set(key, height);
    }
  return grown ?? heights;
}

/** An item as `dayItemsKey` holds it. */
type HeldItem = [key: string, start: number, end: number, title: string];

/**
 * What a day's column holds, as far as its measured heights go: each timed item's key, times and title
 * (`keptHeights`). From what is shown alone, never from what is measured: a key that followed the layout would measure
 * again on every render, and a layout that changes how tall it is drawn would flip forever (`grownHeights`).
 */
export const dayItemsKey = (items: CalItem[], day: Date) =>
  JSON.stringify(
    items
      .filter((it) => !isBarItem(it) && onDay(it, day))
      .map((it): HeldItem => [it.key, it.start.getTime(), it.end.getTime(), it.title]),
  );

/**
 * A day's measured heights once what it holds went from `was` to `now` (`dayItemsKey`). Heights that only grow would
 * keep an item made shorter or renamed as tall as it was, and what it pushed aside beside it, so each cluster with an
 * item that came, went, or has other times or another title, as the day was and as it is, is measured again from
 * nothing. A cluster as `layoutDay` makes one: what starts before the end of what came before, by its times or by how
 * tall it was drawn. Every other item keeps its height, and so its place and its elements: details open on an item
 * elsewhere on the day stay open.
 */
export function keptHeights(
  heights: ReadonlyMap<string, number>,
  was: string,
  now: string,
): ReadonlyMap<string, number> {
  if (was === now) return heights;
  const before = JSON.parse(was) as HeldItem[];
  const after = JSON.parse(now) as HeldItem[];
  const wasIds = new Set(before.map((it) => JSON.stringify(it)));
  const nowIds = new Set(after.map((it) => JSON.stringify(it)));
  // Each item as it was and as it is: the same span twice when it didn't change.
  const spans = [...before, ...after]
    .map((it) => {
      const [key, start, end] = it;
      const id = JSON.stringify(it);
      // Half an hour at the least, as a reminder (`layoutDay`).
      const drawn = Math.max(toMinutes(heights.get(key) ?? 0), 30);
      return { key, start, reach: Math.max(end, start + drawn * 60_000), changed: !wasIds.has(id) || !nowIds.has(id) };
    })
    .sort((a, b) => a.start - b.start);
  const dropped = new Set<string>();
  let cluster: typeof spans = [];
  let reach = Number.NEGATIVE_INFINITY;
  const flush = () => {
    if (cluster.some((span) => span.changed)) for (const { key } of cluster) dropped.add(key);
    cluster = [];
  };
  for (const span of spans) {
    if (span.start >= reach) flush();
    cluster.push(span);
    reach = Math.max(reach, span.reach);
  }
  flush();
  return new Map([...heights].filter(([key]) => !dropped.has(key)));
}

/**
 * Timed items of one day laid out side by side when they overlap: each
 * cluster of overlapping items splits the width into as many columns as it
 * needs (greedy, by start). `heights` (px, by key) are what the page
 * measured: a block whose title wraps past its slot reaches as far as it is
 * drawn, and whatever starts under it goes beside it.
 */
export function layoutDay(items: CalItem[], day: Date, heights: ReadonlyMap<string, number> = new Map()): Placed[] {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = dayStart + 86_400_000;
  const timed = items
    .filter((it) => !isBarItem(it) && onDay(it, day))
    .map((item) => {
      const s = Math.max(item.start.getTime(), dayStart);
      const e = Math.min(Math.max(item.end.getTime(), s + (item.kind === "reminder" ? 30 : 15) * 60_000), dayEnd);
      const drawn = s + toMinutes(heights.get(item.key) ?? 0) * 60_000;
      return { item, s, e, reach: Math.min(Math.max(e, drawn), dayEnd) };
    })
    .sort((a, b) => a.s - b.s || b.reach - a.reach);
  const out: Placed[] = [];
  let cluster: ((typeof timed)[number] & { col: number })[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1));
    for (const c of cluster)
      out.push({ item: c.item, top: (c.s - dayStart) / 60_000, height: (c.e - c.s) / 60_000, col: c.col, cols });
    cluster = [];
  };
  for (const t of timed) {
    if (cluster.length > 0 && t.s >= clusterEnd) flush();
    const colEnds: number[] = [];
    for (const c of cluster) colEnds[c.col] = Math.max(colEnds[c.col] ?? 0, c.reach);
    let col = colEnds.findIndex((end) => end <= t.s);
    if (col < 0) col = colEnds.length;
    cluster.push({ ...t, col });
    clusterEnd = Math.max(clusterEnd, t.reach);
  }
  if (cluster.length > 0) flush();
  return out;
}

/** A row of a day in the month and the agenda. */
export interface DayEntry {
  key: string;
  item: CalItem;
  at: Date;
}

/** One day's items as one list of rows: all day first, then by time. */
export function dayEntries(items: CalItem[], day: Date): DayEntry[] {
  return items
    .filter((it) => onDay(it, day))
    .map((item): DayEntry => ({ key: item.key, item, at: item.start }))
    .sort((a, b) => Number(b.item.allDay) - Number(a.item.allDay) || a.at.getTime() - b.at.getTime());
}

export interface Bar {
  item: CalItem;
  /** First visible day index and how many days it covers. */
  from: number;
  span: number;
  lane: number;
}

/** All-day and multi-day items as bars over the visible days, stacked in lanes. */
export function layoutBars(items: CalItem[], days: Date[]): Bar[] {
  const bars: Bar[] = [];
  const lanes: number[][] = [];
  const sorted = items.filter(isBarItem).sort((a, b) => a.start.getTime() - b.start.getTime());
  for (const item of sorted) {
    const idx = days.map((d, i) => (onDay(item, d) ? i : -1)).filter((i) => i >= 0);
    if (idx.length === 0) continue;
    const from = idx[0] as number;
    const span = (idx[idx.length - 1] as number) - from + 1;
    let lane = lanes.findIndex((used) => used.every((u) => u < from || u >= from + span));
    if (lane < 0) {
      lane = lanes.length;
      lanes.push([]);
    }
    for (let i = from; i < from + span; i++) lanes[lane]?.push(i);
    bars.push({ item, from, span, lane });
  }
  return bars;
}

/** A y offset in the grid (px) → minutes from midnight, snapped. */
export function yToMinutes(y: number, hourPx = HOUR_PX, snap = SNAP_MIN) {
  const min = (Math.max(0, y) / hourPx) * 60;
  return Math.min(24 * 60, Math.round(min / snap) * snap);
}

/**
 * A drag in a day column (from y0 to y1, px) → the new event's time range.
 * A click without a drag gives 30 minutes from where it was clicked.
 */
export function dragRange(day: Date, y0: number, y1: number, hourPx = HOUR_PX) {
  const a = yToMinutes(Math.min(y0, y1), hourPx);
  const b = yToMinutes(Math.max(y0, y1), hourPx);
  const startMin = Math.min(a, 24 * 60 - SNAP_MIN * 2);
  const endMin = b - a < SNAP_MIN ? startMin + 30 : b;
  const base = startOfDay(day);
  return { start: addMinutes(base, startMin), end: addMinutes(base, Math.min(endMin, 24 * 60)) };
}

/** Where the week opens: around 07:00, or a little before the first timed item. */
export function initialScrollMinutes(items: CalItem[], days: Date[]) {
  const firsts = days.flatMap((d) => layoutDay(items, d).map((p) => p.top));
  if (firsts.length === 0) return 7 * 60;
  return Math.max(0, Math.min(7 * 60, Math.min(...firsts) - 30));
}

/** The next `n` items from `now` (for "Próximos"). */
export function upcomingItems(items: CalItem[], now: Date, n = 5) {
  return items
    .filter((it) => it.kind !== "deadline" && it.end > now)
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, n);
}

/** The grid's hour label: "1 AM" … "12 PM" in 12-hour locales, "01:00" … "23:00" otherwise. */
export function hourLabel(locale: string, h: number) {
  if (uses12h(locale)) return new Intl.DateTimeFormat(locale, { hour: "numeric" }).format(new Date(2000, 0, 1, h));
  return `${String(h).padStart(2, "0")}:00`;
}
