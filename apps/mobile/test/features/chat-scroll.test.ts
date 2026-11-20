import { describe, expect, test } from "bun:test";
import { createDockHeight } from "../../src/features/chat/dock-height";
import {
  appendedKeys,
  bandAim,
  lastSeenKey,
  type Place,
  placeCorrection,
  type ScrollRow,
  unseenBelow,
} from "../../src/features/chat/scroll";

describe("the dock's height", () => {
  test("tells who reads it when it changes, and only then", () => {
    const dock = createDockHeight();
    let told = 0;
    const stop = dock.subscribe(() => told++);
    expect(dock.get()).toBe(0);
    dock.set(96);
    dock.set(96);
    expect(dock.get()).toBe(96);
    expect(told).toBe(1);
    dock.set(130);
    expect(told).toBe(2);
    stop();
    dock.set(96);
    expect(told).toBe(2);
    expect(dock.get()).toBe(96);
  });
});

describe("appendedKeys", () => {
  test("new rows at the bottom", () => {
    expect(appendedKeys(["a", "b"], ["a", "b", "c", "d"])).toEqual(["c", "d"]);
  });
  test("an older page prepended above is not new at the bottom", () => {
    expect(appendedKeys(["c", "d"], ["a", "b", "c", "d"])).toEqual([]);
  });
  test("prepend and append together: only the bottom ones", () => {
    expect(appendedKeys(["c"], ["a", "c", "e"])).toEqual(["e"]);
  });
  test("first load and a replaced list give nothing", () => {
    expect(appendedKeys([], ["a", "b"])).toEqual([]);
    expect(appendedKeys(["x"], ["a", "b"])).toEqual([]);
  });
  test("the last row swapped for another: the new one is new", () => {
    expect(appendedKeys(["a", "card-1"], ["a", "m2"])).toEqual(["m2"]);
  });
});

const row = (key: string, kind: ScrollRow["kind"] = "message", mine = false, who?: string): ScrollRow => ({
  key,
  kind,
  mine,
  ...(who ? { who } : {}),
});

describe("what arrived below", () => {
  test("the last message row is where the person read up to", () => {
    expect(lastSeenKey([row("day", "other"), row("a"), row("card-1", "other")])).toBe("a");
    expect(lastSeenKey([row("day", "other")])).toBeNull();
  });
  test("new messages from others after the seen one, and who wrote them", () => {
    const rows = [
      row("a"),
      row("day2", "other"),
      row("b", "message", false, "person:marina"),
      row("mine", "message", true, "person:me"),
      row("c", "message", false, "agent:ada"),
      row("d", "message", false, "person:marina"),
    ];
    expect(unseenBelow(rows, "a")).toEqual({
      messages: 3,
      firstKey: "b",
      authors: ["person:marina", "agent:ada"],
      working: [],
      mentionsMe: false,
    });
    expect(unseenBelow(rows, "c").messages).toBe(1);
    expect(unseenBelow(rows, "c").firstKey).toBe("d");
  });
  test("an agent at work has no row: nothing below counts until its reply is posted", () => {
    const u = unseenBelow([row("a"), row("card-1", "other", false, "agent:theo")], "a");
    expect(u.messages).toBe(0);
    expect(u.firstKey).toBeNull();
  });
  test("a new message that mentions me turns the round button's count red; one I already saw doesn't", () => {
    const called = { ...row("b", "message", false, "person:marina"), mentionsMe: true };
    expect(unseenBelow([row("a"), called, row("c")], "a").mentionsMe).toBe(true);
    expect(unseenBelow([row("a"), called, row("c")], "b").mentionsMe).toBe(false);
  });
  test("my own messages never count", () => {
    expect(unseenBelow([row("a"), row("mine", "message", true)], "a").firstKey).toBeNull();
  });
  test("nothing seen yet, or the seen row is gone: nothing counts", () => {
    expect(unseenBelow([row("a"), row("b")], null).messages).toBe(0);
    expect(unseenBelow([row("a"), row("b")], "zz").firstKey).toBeNull();
  });
  test("a message posted since I was at the end but placed above what I saw last is new too; the line goes before it", () => {
    // Ids sort in the order the server posted them. At the end "b" (v2) was the newest; "r" (v3) was posted later
    // with an earlier place (`PLACE_KEPT_MS`).
    const said = (key: string, id: string, who?: string) => ({ ...row(key, "message", false, who), id });
    const rows = [said("a", "v1"), said("r", "v3", "agent:ada"), said("b", "v2", "person:marina")];
    expect(unseenBelow(rows, "b", "v2")).toEqual({
      messages: 1,
      firstKey: "r",
      authors: ["agent:ada"],
      working: [],
      mentionsMe: false,
    });
    // One posted before I left the end isn't new, wherever it sits.
    const old = [said("a", "v1"), said("r", "v0", "agent:ada"), said("b", "v2", "person:marina")];
    expect(unseenBelow(old, "b", "v2").firstKey).toBeNull();
  });
});

describe("placeCorrection", () => {
  const list = (scroll: number, distanceFromEnd = 500, positions: Record<string, number> = {}) => ({
    scroll,
    distanceFromEnd,
    positionOf: (key: string) => positions[key],
  });
  const reading: Place = { end: false, scroll: 1200, key: "m7", position: 1100 };

  test("a place still on screen needs nothing, a drift under the slack included", () => {
    expect(placeCorrection(reading, list(1200, 500, { m7: 1100 }))).toBeNull();
    expect(placeCorrection(reading, list(1230, 500, { m7: 1100 }))).toBeNull();
  });
  test("a jump toward older messages or toward the end is put back", () => {
    expect(placeCorrection(reading, list(0, 2000, { m7: 1100 }))).toBe(1200);
    expect(placeCorrection(reading, list(2400, 0, { m7: 1100 }))).toBe(1200);
  });
  test("rows above that grew move the place with its row", () => {
    // An older page loaded above: the row is 600 lower, and the list moved with it.
    expect(placeCorrection(reading, list(1800, 500, { m7: 1700 }))).toBeNull();
    // It didn't: the row is put back where it was on screen.
    expect(placeCorrection(reading, list(1200, 500, { m7: 1700 }))).toBe(1800);
  });
  test("without its row, the scroll it had", () => {
    expect(placeCorrection(reading, list(300))).toBe(1200);
    expect(placeCorrection({ end: false, scroll: 800, key: null, position: null }, list(300))).toBe(800);
  });
  test("at the end, it goes back to the end only when the list left it", () => {
    expect(placeCorrection({ end: true }, list(900, 0))).toBeNull();
    expect(placeCorrection({ end: true }, list(900, 30))).toBeNull();
    expect(placeCorrection({ end: true }, list(0, 900))).toBe("end");
  });
});

describe("bandAim", () => {
  // A list 800 tall whose top 110 runs under the floating bar, with 100 of dock (and keyboard) at its foot: the room
  // rows show in is 590 tall, from 110 to 700.
  const LIST = 800;
  const DOCK = 100;
  const room = { band: LIST - 110 - DOCK, top: 110 };
  // Where Legend List puts a row's top in its frame for `scrollToIndex` (`calculateOffsetWithOffsetPosition`): the
  // offset, then the share of what is left beside the row over the dock.
  const rowTop = (aim: { viewPosition: number; viewOffset: number }, size: number) =>
    aim.viewOffset + aim.viewPosition * (LIST - DOCK - size);

  test("a row sent to the top lands under the bar, not behind it", () => {
    const aim = bandAim({ ...room, viewPosition: 0, size: 60, tall: "start" });
    expect(aim).toEqual({ viewPosition: 0, viewOffset: 110 });
    expect(rowTop(aim, 60)).toBe(110);
  });
  test("centred in the room, not in the list's whole height", () => {
    const aim = bandAim({ ...room, viewPosition: 0.5, size: 60, tall: "end" });
    expect(rowTop(aim, 60) + 30).toBe(110 + room.band / 2);
  });
  test("its end on the dock takes no offset", () => {
    const aim = bandAim({ ...room, viewPosition: 1, size: 60, tall: "end" });
    expect(aim).toEqual({ viewPosition: 1, viewOffset: 0 });
    expect(rowTop(aim, 60) + 60).toBe(LIST - DOCK);
  });
  test("a row taller than the room shows its start under the bar, or its end on the dock", () => {
    const start = bandAim({ ...room, viewPosition: 0.5, size: 650, tall: "start" });
    expect(rowTop(start, 650)).toBe(110);
    const end = bandAim({ ...room, viewPosition: 0.5, size: 650, tall: "end" });
    expect(rowTop(end, 650) + 650).toBe(LIST - DOCK);
  });
  test("a row not measured yet gets the list's fallback: a tall one shows its start under the bar or its end on the dock", () => {
    const start = bandAim({ ...room, viewPosition: 0.4, size: undefined, tall: "start" });
    expect(start).toEqual({ viewPosition: 0.4, viewOffset: 110, viewPositionFallback: "start" });
    // Short, it lands in the room; taller than the list, the fallback puts its start under the bar (the offset).
    expect(rowTop(start, 60)).toBeGreaterThanOrEqual(110);
    expect(rowTop({ viewPosition: 0, viewOffset: start.viewOffset }, 900)).toBe(110);
    // "Ver" on the requests: no offset, so the fallback's end lands on the dock, never under it.
    const end = bandAim({ ...room, viewPosition: 0.5, size: undefined, tall: "end" });
    expect(end).toEqual({ viewPosition: 0.5, viewOffset: 0, viewPositionFallback: "end" });
    expect(rowTop({ viewPosition: 1, viewOffset: end.viewOffset }, 900) + 900).toBe(LIST - DOCK);
    // Short, its end (the request's card) stays over the dock.
    expect(rowTop(end, 400) + 400).toBeLessThanOrEqual(LIST - DOCK);
  });
  test("under a pinned card the list starts below the bar: no offset", () => {
    expect(bandAim({ band: 500, top: 0, viewPosition: 0, size: 60, tall: "start" })).toEqual({
      viewPosition: 0,
      viewOffset: 0,
    });
  });
});
