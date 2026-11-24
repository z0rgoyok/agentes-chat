import { afterEach, expect, jest, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, render } from "@testing-library/react";
import { useNow } from "../src";

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  Reflect.deleteProperty(document, "hidden");
});

// Fake timers: on a busy runner a real 10 ms interval fires an unknown number of times, or none, between two looks.
// The clock moves with them, and each millisecond is its own act, so React doesn't fold the ticks into one draw.
const wait = async (ms: number) => {
  for (let i = 0; i < ms; i++)
    await act(() => {
      jest.setSystemTime(Date.now() + 1);
      jest.advanceTimersByTime(1);
    });
};

test("a clock doesn't move while the page is hidden, and reads the time again once it shows", async () => {
  let draws = 0;
  function Clock() {
    useNow(10);
    draws++;
    return null;
  }
  jest.useFakeTimers();
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  render(<Clock />);
  const first = draws;
  await wait(80);
  expect(draws).toBe(first);
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(draws).toBe(first + 1);
  await wait(80);
  expect(draws).toBeGreaterThan(first + 2);
});
