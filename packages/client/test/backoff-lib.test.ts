import { describe, expect, test } from "bun:test";
import {
  RECONNECT_CAP_MS,
  reconnectDelay,
  reconnectStep,
  retryAfterFromReason,
  retryAfterReason,
  waitAfterRetryHint,
} from "../src/lib/backoff";

describe("reconnect backoff", () => {
  test("steps double from 1 s and stop at 60 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 50].map((a) => reconnectStep(a))).toEqual([
      1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ]);
    expect(reconnectStep(-3)).toBe(1000);
    expect(reconnectStep(Infinity)).toBe(RECONNECT_CAP_MS);
  });

  test("full jitter: anywhere in [0, step), never the step itself", () => {
    for (const attempt of [0, 3, 9]) {
      const step = reconnectStep(attempt);
      expect(reconnectDelay(attempt, () => 0)).toBe(0);
      expect(reconnectDelay(attempt, () => 0.5)).toBe(step / 2);
      expect(reconnectDelay(attempt, () => 0.999_999)).toBeLessThan(step);
    }
    // Many clients dropped together spread over the whole step, not around one moment.
    const delays = Array.from({ length: 2000 }, () => reconnectDelay(4));
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...delays)).toBeLessThan(16_000);
    expect(delays.filter((d) => d < 8000).length).toBeGreaterThan(800);
    expect(delays.filter((d) => d >= 8000).length).toBeGreaterThan(800);
  });

  test("a server's retry-after: never sooner, spread over as long again or the step", () => {
    expect(waitAfterRetryHint(5000, 1000, () => 0)).toBe(5000);
    expect(waitAfterRetryHint(5000, 1000, () => 0.5)).toBe(7500);
    expect(waitAfterRetryHint(5000, 60_000, () => 0.5)).toBe(35_000);
  });

  test("retry-after in a close reason", () => {
    expect(retryAfterReason(5)).toBe("try again; retry-after=5");
    expect(retryAfterFromReason(retryAfterReason(5, "session unavailable"))).toBe(5000);
    expect(retryAfterFromReason("x; retry-after=99999")).toBe(RECONNECT_CAP_MS);
    expect(retryAfterFromReason("too far behind")).toBeNull();
    expect(retryAfterFromReason("")).toBeNull();
    expect(retryAfterFromReason(undefined)).toBeNull();
  });
});
