import { expect, test } from "bun:test";
import { AwakeClock } from "../../runner/awake";

test("awake time skips a sleep: a jump of hours between two looks counts as one tick", () => {
  let now = 1_000;
  const clock = new AwakeClock(() => now, 10_000);
  try {
    now += 10_000;
    expect(clock.read()).toBe(10_000);
    now += 25_000;
    expect(clock.read()).toBe(35_000);
    // The VM was saved to disk for three hours and restored: its clock jumped.
    now += 3 * 3600_000;
    expect(clock.read()).toBe(45_000);
    now += 5_000;
    expect(clock.read()).toBe(50_000);
    // A clock that went back never takes awake time away.
    now -= 60_000;
    expect(clock.read()).toBe(50_000);
  } finally {
    clock.stop();
  }
});
