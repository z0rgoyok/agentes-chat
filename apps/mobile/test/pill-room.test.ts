import { expect, test } from "bun:test";
import { pillRoom } from "../src/features/chat/pill-room";

test("iOS 26: the pill stops before the right buttons' glass group, as measured on a 430-point iPhone", () => {
  // An agent's DM with its tasks counted (a 57-point view), its computer and "…": the group measured 179 points (231 to
  // 410; 177 by the sum), and the pill starts at 84 (20 + 44 + 20). It gets 129 points; the old sum gave it 190, so it
  // ran under the group.
  expect(pillRoom(430, 1, 57, true)).toBe(129);
  // The computer and "…" only, and "…" alone.
  expect(pillRoom(430, 1, 0, true)).toBe(202);
  expect(pillRoom(430, 0, 0, true)).toBe(262);
  // A narrow phone with everything in the bar: never below its face and a few letters.
  expect(pillRoom(375, 1, 57, true)).toBe(96);
});

test("Android and older iOS: our own 44-point buttons side by side, the counted views as wide as they measure", () => {
  expect(pillRoom(400, 1, 0, false)).toBe(204);
  expect(pillRoom(400, 1, 60, false)).toBe(144);
});
