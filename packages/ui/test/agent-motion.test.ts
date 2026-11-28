import { expect, test } from "bun:test";
import { agentMotion } from "../src/agent/live";

const on = (over: Partial<Parameters<typeof agentMotion>[1]> = {}) => ({
  sight: "present" as const,
  reduced: false,
  reacting: false,
  gazing: false,
  hovered: false,
  ...over,
});

test("present: an agent at work or waiting moves at the full rate; one at rest or asleep stands still", () => {
  expect(agentMotion("thinking", on())).toBe("full");
  expect(agentMotion("writing", on())).toBe("full");
  expect(agentMotion("waiting", on())).toBe("full");
  expect(agentMotion("idle", on())).toBe("still");
  expect(agentMotion("sleeping", on())).toBe("still");
});

test("a face playing or the gaze moves an agent at rest at the full rate; the pointer on it, at rest's", () => {
  expect(agentMotion("idle", on({ reacting: true }))).toBe("full");
  expect(agentMotion("idle", on({ gazing: true }))).toBe("full");
  expect(agentMotion("idle", on({ hovered: true }))).toBe("rest");
  expect(agentMotion("sleeping", on({ hovered: true }))).toBe("rest");
});

test("idle: only an agent at work moves; one waiting on someone who isn't there stands still", () => {
  expect(agentMotion("thinking", on({ sight: "idle" }))).toBe("full");
  expect(agentMotion("writing", on({ sight: "idle" }))).toBe("full");
  expect(agentMotion("waiting", on({ sight: "idle" }))).toBe("still");
  expect(agentMotion("idle", on({ sight: "idle", hovered: true, reacting: true }))).toBe("still");
});

test("nobody looking, or reduced motion: nothing moves", () => {
  for (const sight of ["away", "hidden"] as const)
    for (const state of ["thinking", "writing", "waiting", "idle"] as const)
      expect(agentMotion(state, on({ sight, hovered: true, reacting: true }))).toBe("still");
  expect(agentMotion("writing", on({ reduced: true }))).toBe("still");
});
