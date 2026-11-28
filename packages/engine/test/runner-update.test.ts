import { describe, expect, test } from "bun:test";
import {
  ACCOUNTS_PROTOCOL,
  BRAIN_PROTOCOL,
  MACHINE_PROTOCOL_VERSION,
  RUNNER_APP_PROTOCOL,
} from "@agenteschat/adapters";
import { accountUnavailable, claudeCodeAvailability } from "../src/brains/claude-code";
import type { MachineStatus } from "../src/machine-hub";
import { RunnerOutdatedError } from "../src/machine-tasks";
import { runByApp, runnerUpdateOf } from "../src/runner-update";

const status = (over: Partial<MachineStatus> = {}): MachineStatus => ({
  id: "m1",
  orgId: "org",
  name: "Workspace",
  online: true,
  execAllowed: true,
  os: "linux",
  protocol: BRAIN_PROTOCOL - 1,
  executors: {},
  ...over,
});
const ACCOUNT = { id: "acc", label: "Claude", status: "active" as const };

const said = (event: unknown) => (event as { message?: string } | null)?.message ?? "";

describe("a computer too old for something says how it gets its update", () => {
  test("the workspace's own computer updates by itself: never the command its runner refuses", () => {
    const managed = status({ kind: "managed" });
    for (const line of [
      said(claudeCodeAvailability(managed)),
      said(accountUnavailable({ ...managed, protocol: ACCOUNTS_PROTOCOL - 1 }, ACCOUNT, "claude_code")),
      new RunnerOutdatedError("Workspace", false, managed).message,
      new RunnerOutdatedError("Workspace", true, managed).message,
    ]) {
      expect(line).toContain("It updates by itself, so try again later.");
      expect(line).not.toContain("agentes-runner update");
    }
  });

  test("a computer set up for all its agents, or this server's own, updates with the install command as root", () => {
    for (const s of [status({ executors: { mode: "system" } }), status({ kind: "host" })]) {
      const line = said(claudeCodeAvailability(s));
      expect(line).toContain("running the install command again, as root");
      expect(line).not.toContain("agentes-runner update");
    }
  });

  test("a connected computer: its owner runs the update command", () => {
    expect(said(claudeCodeAvailability(status({ kind: "connected" })))).toContain(
      "Its owner updates the agentes app there, or runs `agentes-runner update`.",
    );
    expect(new RunnerOutdatedError("MacBook", false, null).message).toContain("`agentes-runner update`");
  });
});

describe("a computer whose runner is behind this server says how to update it, whatever its version label says", () => {
  const box = (over: Partial<Parameters<typeof runnerUpdateOf>[0]> = {}) => ({
    kind: "connected",
    os: "linux",
    protocol: 56,
    executors: {},
    ...over,
  });
  const later = RUNNER_APP_PROTOCOL + 4;

  test("a Linux runner installed from the terminal, from before images reached agents, runs the update command", () => {
    expect(runnerUpdateOf(box())).toBe("command");
    expect(runnerUpdateOf(box({ executors: { mode: "system" } }))).toBe("installer");
    expect(runnerUpdateOf(box({ protocol: RUNNER_APP_PROTOCOL }), later)).toBe("command");
  });

  test("nothing to update: current, the server's or the workspace's own, or run by the app", () => {
    expect(runnerUpdateOf(box({ protocol: MACHINE_PROTOCOL_VERSION }))).toBeNull();
    expect(runnerUpdateOf(box({ kind: "host" }))).toBeNull();
    expect(runnerUpdateOf(box({ kind: "managed" }))).toBeNull();
    expect(runnerUpdateOf(box({ protocol: RUNNER_APP_PROTOCOL, executors: { app: true } }), later)).toBeNull();
  });

  test("a runner from before it said whether the app runs it counts only on Linux, below the app of that time", () => {
    expect(runnerUpdateOf(box({ os: "darwin" }))).toBeNull();
    expect(runnerUpdateOf(box({ os: "windows" }))).toBeNull();
    expect(runnerUpdateOf(box({ protocol: 77 }))).toBeNull();
    expect(runnerUpdateOf(box({ protocol: 76 }))).toBe("command");
  });
});

test("run by the agentes.chat app or installed from the Terminal: as the runner says, else by its system", () => {
  const at = RUNNER_APP_PROTOCOL;
  expect(runByApp({ os: "darwin", protocol: at, executors: { app: true } })).toBe(true);
  expect(runByApp({ os: "linux", protocol: at, executors: {} })).toBe(false);
  expect(runByApp({ os: "darwin", protocol: at, executors: null })).toBe(false);
  // Too old to say: off Linux the app is the likely one.
  expect(runByApp({ os: "windows", protocol: at - 1 })).toBe(true);
  expect(runByApp({ os: "linux", protocol: 40 })).toBe(false);
});
