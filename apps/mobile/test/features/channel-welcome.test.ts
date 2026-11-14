import { afterEach, expect, jest, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WELCOME_CLOSE_MS, WELCOME_LEAVE_MS, welcomeClock } from "@agenteschat/client/lib/welcome";

const source = (path: string) => readFileSync(join(import.meta.dir, "../../src/features/chat", path), "utf8");

afterEach(() => jest.useRealTimers());

test("the day's greeting goes by itself 8 s after the first touch elsewhere, never under a finger, unfelt", () => {
  // No renderer for the phone's components in these tests: what only the source can say is read from it.
  expect([WELCOME_CLOSE_MS, WELCOME_LEAVE_MS]).toEqual([8_000, 2_000]);
  const chat = source("ChatScreen.tsx");
  // Any touch on the conversation's screen: a scroll, the box, a message, the bar.
  expect(chat).toContain("onTouchStart={touched ? undefined : () => setTouched(true)}");
  expect(chat).toContain("touched={touched}");
  const welcome = source("ChannelWelcome.tsx");
  // Only the day's greeting: a newcomer's welcome stays until they close it.
  expect(welcome).toContain("const autoCloses = Boolean(me) && greets && messages !== undefined && touched;");
  // The web's clock, held by a finger on the card, told when it lifts.
  expect(welcome).toContain("() => held.current,");
  expect(welcome).toContain("run.used();");
  // Its own touches are reading it; a finger on it holds it.
  expect(welcome).toContain("e.stopPropagation();");
  expect(welcome).toContain("held.current = true;");
  expect(welcome).toContain("clock.current?.left();");
  expect(welcome).toContain("onTouchEnd={lift}");
  expect(welcome).toContain("onTouchCancel={lift}");
  // Leaving the channel once the clock runs counts as closed.
  expect(welcome).toContain("if (run.running()) greeting.closed = true;");
  // It leaves the way it came, with no haptic of its own.
  expect(welcome).toContain("() => away.current(false),");
  expect(welcome).toContain("if (felt) haptics.light();");
});

test("its clock: nothing before a touch, 8 s after one, held by a finger, gone 2 s after the finger lifts", () => {
  jest.useFakeTimers();
  let finger = false;
  let closed = 0;
  const clock = welcomeClock(
    () => closed++,
    () => finger,
  );
  jest.advanceTimersByTime(60_000);
  expect([closed, clock.running()]).toEqual([0, false]);
  clock.used();
  // A finger on the card when the 8 s come: it stays while the finger does.
  jest.advanceTimersByTime(7_000);
  finger = true;
  jest.advanceTimersByTime(5_000);
  expect(closed).toBe(0);
  // Lifted, it waits 2 s; the finger back within them holds it again.
  finger = false;
  clock.left();
  jest.advanceTimersByTime(1_900);
  finger = true;
  jest.advanceTimersByTime(5_000);
  expect(closed).toBe(0);
  finger = false;
  clock.left();
  jest.advanceTimersByTime(1_900);
  expect(closed).toBe(0);
  jest.advanceTimersByTime(100);
  expect([closed, clock.running()]).toEqual([1, false]);
  // Once, whatever comes after.
  clock.used();
  clock.left();
  jest.advanceTimersByTime(60_000);
  expect(closed).toBe(1);
});

test("a finger lifted before the 8 s: it goes at 8 s, or 2 s after the lift when that comes later", () => {
  jest.useFakeTimers();
  for (const [liftAt, closesAt] of [
    [3_000, 8_000],
    [7_000, 9_000],
  ] as const) {
    let closed = 0;
    let finger = true;
    const clock = welcomeClock(
      () => closed++,
      () => finger,
    );
    clock.used();
    jest.advanceTimersByTime(liftAt);
    finger = false;
    clock.left();
    jest.advanceTimersByTime(closesAt - liftAt - 1);
    expect([liftAt, closed]).toEqual([liftAt, 0]);
    jest.advanceTimersByTime(1);
    expect([liftAt, closed]).toEqual([liftAt, 1]);
  }
});
