import { describe, expect, test } from "bun:test";
import {
  type CalItem,
  dayEntries,
  dayItemsKey,
  dragRange,
  grownHeights,
  HOUR_PX,
  initialScrollMinutes,
  itemOwners,
  keptHeights,
  layoutBars,
  layoutDay,
  onDay,
  rangeLabel,
  toItems,
  upcomingItems,
  viewDays,
} from "../src/lib/calendar";

const day = new Date(2026, 9, 14);
const at = (h: number, m = 0, d = day) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
const item = (key: string, start: Date, end: Date, allDay = false): CalItem => ({
  key,
  kind: "event",
  source: "person",
  title: key,
  start,
  end,
  allDay,
  recurring: false,
  people: [],
});

const reminder = (key: string, start: Date): CalItem => ({
  ...item(key, start, new Date(start.getTime() + 60_000)),
  kind: "reminder",
  source: "reminder",
});

describe("calendar layout", () => {
  test("a block drawn past its slot (a title that wraps) pushes the next one beside it", () => {
    // 09:00–09:30 drawn 50px tall reaches 10:08: the 09:45 meeting goes beside it.
    const short = item("short", at(9), at(9, 30));
    const next = item("next", at(9, 45), at(10, 15));
    expect(layoutDay([short, next], day).map((p) => p.cols)).toEqual([1, 1]);
    expect(layoutDay([short, next], day, new Map([["short", 50]])).map((p) => [p.col, p.cols])).toEqual([
      [0, 2],
      [1, 2],
    ]);
    // Its own slot stays its slot: only what it reaches into moves.
    expect(layoutDay([short], day, new Map([["short", 50]]))[0]?.height).toBe(30);
  });

  test("measured heights only grow, so a layout that changes how tall it draws settles instead of flipping", () => {
    const heights = new Map([["a", 40]]);
    expect(grownHeights(heights, new Map([["a", 30]]))).toBe(heights);
    expect(grownHeights(heights, new Map([["a", 40.4]]))).toBe(heights);
    expect([
      ...grownHeights(
        heights,
        new Map([
          ["a", 52],
          ["b", 20],
        ]),
      ),
    ]).toEqual([
      ["a", 52],
      ["b", 20],
    ]);
  });

  test("a change on a day measures again the clusters it was in and lands in, and only those", () => {
    // A reminder drawn 44px tall (an hour), a meeting with the one that starts inside it, one in the evening.
    const items = [
      reminder("a", at(7)),
      item("planning", at(14), at(16)),
      item("coffee", at(15), at(15, 30)),
      item("late", at(18), at(19)),
    ];
    const heights = new Map([
      ["a", 44],
      ["planning", 86],
      ["coffee", 60],
      ["late", 42],
    ]);
    const was = dayItemsKey(items, day);
    const after = (key: string, change: Partial<CalItem>) => {
      const changed = items.map((it) => (it.key === key ? { ...it, ...change } : it));
      return keptHeights(heights, was, dayItemsKey(changed, day));
    };
    expect(keptHeights(heights, was, was)).toBe(heights);
    // An hour shorter: the meeting, and the one beside it, which may now go under it.
    expect([...after("planning", { end: at(15) })]).toEqual([
      ["a", 44],
      ["late", 42],
    ]);
    // A reminder renamed: only it.
    expect([...after("a", { title: "Call the bank" })]).toEqual([
      ["planning", 86],
      ["coffee", 60],
      ["late", 42],
    ]);
    // Moved to the evening: where it was, and the meeting it lands beside.
    expect([...after("coffee", { start: at(18, 30), end: at(19) })]).toEqual([["a", 44]]);
  });

  test("a day's rows for the month and the agenda: all day first, then by time", () => {
    const rows = dayEntries(
      [
        reminder("late", at(18, 30)),
        item("lunch", at(12), at(13)),
        item("holiday", at(0), at(0, 0, new Date(2026, 9, 15)), true),
        item("tomorrow", at(9, 0, new Date(2026, 9, 15)), at(10, 0, new Date(2026, 9, 15))),
      ],
      day,
    );
    expect(rows.map((r) => r.key)).toEqual(["holiday", "lunch", "late"]);
  });

  test("a reminder late at night stays on its day, in the grid, tall enough to read", () => {
    const [late] = toItems({
      events: [],
      routines: [],
      deadlines: [],
      proposals: [],
      reminders: [
        {
          id: "r",
          message: "m",
          at: at(23, 50).toISOString(),
          forUserId: "u",
          channelId: "c",
          threadId: null,
          agentId: "a",
          createdBy: "u",
          canCancel: true,
        },
      ],
    });
    const reminder = late as CalItem;
    const next = new Date(2026, 9, 15);
    expect(onDay(reminder, day)).toBe(true);
    expect(onDay(reminder, next)).toBe(false);
    expect(layoutDay([reminder], day).map((p) => [p.top, p.height])).toEqual([[1430, 10]]);
    expect(layoutDay([{ ...reminder, start: at(9), end: at(9, 1) }], day).map((p) => p.height)).toEqual([30]);
  });

  test("each item knows whose it is: who made an event, a reminder's agent, who has a task; no routine run", () => {
    const event = (id: string, createdBy: { type: "person" | "agent"; id: string }) => ({
      id,
      title: id,
      description: "",
      start: at(10).toISOString(),
      end: at(11).toISOString(),
      allDay: false,
      timezone: "UTC",
      recurrence: "none" as const,
      participants: [],
      rsvp: [],
      channelId: null,
      issueId: null,
      createdBy,
    });
    const items = toItems({
      events: [event("by-person", { type: "person", id: "u-ana" }), event("by-agent", { type: "agent", id: "ag-ada" })],
      // The Routines page's horizon: never an item of the calendar.
      routines: [
        { routineId: "r1", name: "Diária", agentId: "ag-atlas", at: at(7).toISOString(), target: { type: "dm" } },
      ],
      reminders: [
        {
          id: "rem",
          message: "m",
          at: at(9).toISOString(),
          forUserId: "u-ana",
          channelId: "c",
          threadId: null,
          agentId: "ag-ada",
          createdBy: "u-ana",
          canCancel: true,
        },
      ],
      deadlines: [
        {
          issueId: "i1",
          number: 128,
          title: "Login",
          date: "2026-10-14",
          assignees: [
            { type: "agent", id: "ag-ada" },
            { type: "person", id: "u1" },
          ],
        },
        { issueId: "i2", number: 129, title: "Nobody", date: "2026-10-14", assignees: [] },
        { issueId: "i3", number: 130, title: "Older server", date: "2026-10-14" },
      ],
      proposals: [],
    });
    expect(items.map((it) => [it.key, it.owner])).toEqual([
      ["by-person", { type: "person", id: "u-ana" }],
      ["by-agent", { type: "agent", id: "ag-ada" }],
      ["reminder-rem", { type: "agent", id: "ag-ada" }],
      ["deadline-i1", { type: "agent", id: "ag-ada" }],
      ["deadline-i2", undefined],
      ["deadline-i3", undefined],
    ]);
    // A task due that several have counts for each of them; any other item, for its one owner.
    const owners = (key: string) => itemOwners(items.find((it) => it.key === key) ?? {});
    expect(owners("deadline-i1")).toEqual([
      { type: "agent", id: "ag-ada" },
      { type: "person", id: "u1" },
    ]);
    expect(owners("deadline-i2")).toEqual([]);
    expect(owners("by-person")).toEqual([{ type: "person", id: "u-ana" }]);
  });

  test("overlapping events sit side by side; a later one gets the full width again", () => {
    const placed = layoutDay(
      [
        item("a", at(9), at(10)),
        item("b", at(9, 30), at(11)),
        item("c", at(10), at(10, 30)),
        item("d", at(14), at(15)),
      ],
      day,
    );
    const by = Object.fromEntries(placed.map((p) => [p.item.key, [p.col, p.cols, p.top, p.height]]));
    expect(by).toEqual({
      a: [0, 2, 540, 60],
      b: [1, 2, 570, 90],
      c: [0, 2, 600, 30],
      d: [0, 1, 840, 60],
    });
  });

  test("all-day and multi-day items become bars in lanes", () => {
    const days = viewDays("week", day);
    const bars = layoutBars(
      [
        item("trip", at(0, 0, days[1] as Date), at(0, 0, days[4] as Date), true),
        item("deadline", at(0, 0, days[2] as Date), at(0, 0, days[3] as Date), true),
        item("late", at(22, 0, days[5] as Date), at(2, 0, days[6] as Date)),
      ],
      days,
    );
    expect(bars.map((b) => [b.item.key, b.from, b.span, b.lane])).toEqual([
      ["trip", 1, 3, 0],
      ["deadline", 2, 1, 1],
      ["late", 5, 2, 0],
    ]);
  });

  test("drag to create: snapped to 15 minutes; a click gives 30 minutes", () => {
    const r = dragRange(day, 9 * HOUR_PX + 5, 10.5 * HOUR_PX + 3);
    expect([r.start.getHours(), r.start.getMinutes(), r.end.getHours(), r.end.getMinutes()]).toEqual([9, 0, 10, 30]);
    const click = dragRange(day, 14 * HOUR_PX, 14 * HOUR_PX);
    expect([click.start.getHours(), click.end.getHours(), click.end.getMinutes()]).toEqual([14, 14, 30]);
  });

  test("the grid opens around 07:00, or a little before an earlier event", () => {
    expect(initialScrollMinutes([], [day])).toBe(7 * 60);
    expect(initialScrollMinutes([item("early", at(6), at(7))], [day])).toBe(5 * 60 + 30);
  });

  test("week of 7 days, or only business days; the header range", () => {
    expect(viewDays("week", day)).toHaveLength(7);
    expect(viewDays("week", day, true).map((d) => d.getDay())).toEqual([1, 2, 3, 4, 5]);
    const week = rangeLabel("pt-BR", "week", viewDays("week", day), day);
    expect(week).toContain("12");
    expect(week).toContain("18");
    expect(week).toContain("2026");
    expect(rangeLabel("pt-BR", "month", [], day)).toBe("outubro de 2026");
  });
});

describe("hour labels", () => {
  test("12-hour locales: 1 AM … 12 PM; 24-hour: 01:00 … 23:00", async () => {
    const { hourLabel, uses12h } = await import("../src/lib/calendar");
    expect(uses12h("en")).toBe(true);
    expect(uses12h("pt-BR")).toBe(false);
    expect([1, 12, 13].map((h) => hourLabel("en", h).replace(/\s/g, " "))).toEqual(["1 AM", "12 PM", "1 PM"]);
    expect([1, 13, 23].map((h) => hourLabel("pt-BR", h))).toEqual(["01:00", "13:00", "23:00"]);
  });
});

describe("upcoming", () => {
  test("Próximos: what comes next from now, in order, never a task's due date", () => {
    const now = at(8, 30);
    const next = upcomingItems(
      [
        item("meet", at(10), at(11)),
        reminder("call", at(9)),
        item("past", at(7), at(8)),
        { ...item("due", at(0), at(0, 0, new Date(2026, 9, 15)), true), kind: "deadline", source: "deadline" },
      ],
      now,
    );
    expect(next.map((it) => it.key)).toEqual(["call", "meet"]);
  });
});
