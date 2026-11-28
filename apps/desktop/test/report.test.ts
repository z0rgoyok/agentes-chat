import { describe, expect, test } from "bun:test";
import type { RunnerReportParts } from "@agenteschat/adapters/machine-protocol";
import { type CoverParts, computerReport, coverReport, type ReportFacts } from "../src/report/report";

/** The app's own problem reports carry this computer: its system's version, its size, its web view and its opening. */

const NOW = new Date("2026-11-24T18:00:00Z");
const COVER: CoverParts = {
  appVersion: "0.8.18",
  os: "windows",
  arch: "x86_64",
  phase: "notRunning",
  installedVersion: "2026.11.24.1",
  serverVersion: null,
  reach: false,
  usage: true,
  steps: [],
  serverLogTail: "",
};
const ABOUT: ReportFacts = {
  osVersion: "10.0.19045",
  cpus: 8,
  memoryBytes: 16 * 2 ** 30 - 300 * 2 ** 20,
  webviewBytes: 411_700_000,
  openingMs: 6180,
};

describe("the desktop app's problem report", () => {
  test("the cover's says this computer: its Windows build, CPUs, memory, web view and opening", () => {
    const report = coverReport(COVER, ABOUT, [], "en", NOW);
    expect(report.versions).toEqual({
      desktop: "0.8.18",
      server: "2026.11.24.1",
      os: "windows",
      osVersion: "10.0.19045",
      arch: "x86_64",
    });
    expect(report.facts).toMatchObject({ "desktop.cpus": 8, "desktop.memoryGb": 15.5, "desktop.webviewMb": 412 });
    expect(report.timings).toEqual({ opening: 6180 });
  });

  test("what the app couldn't tell stays out, and an app whose Rust is older sends the report without any of it", () => {
    const linux = coverReport(
      { ...COVER, os: "linux" },
      { osVersion: "6.9.1-custom-workstation", cpus: 4, memoryBytes: null, webviewBytes: null, openingMs: null },
      [],
      "en",
      NOW,
    );
    // The kernel's numbers alone: what its build adds after them (a flavour, a name someone gave it) stays home.
    expect(linux.versions.osVersion).toBe("6.9.1");
    expect(linux.facts["desktop.cpus"]).toBe(4);
    expect(linux.facts).not.toHaveProperty("desktop.memoryGb");
    expect(linux.facts).not.toHaveProperty("desktop.webviewMb");
    expect(linux).not.toHaveProperty("timings");

    const older = coverReport(COVER, null, [], "en", NOW);
    expect(older.versions).not.toHaveProperty("osVersion");
    expect(Object.keys(older.facts).filter((k) => /cpus|memory|webview/.test(k))).toEqual([]);
    expect(older).not.toHaveProperty("timings");
    // A version that doesn't start with its numbers, or an opening longer than a day, is left out, never sent.
    const odd = coverReport(COVER, { ...ABOUT, osVersion: "Darwin/25.6", openingMs: 90_000_000 }, [], "en", NOW);
    expect(odd.versions).not.toHaveProperty("osVersion");
    expect(odd).not.toHaveProperty("timings");
  });

  test("Preferences' report for a computer says this computer too", () => {
    const parts = {
      runtime: "bun",
      os: "macos",
      compiled: true,
      managedBy: "app",
      connection: "offline",
      paused: false,
      agents: 2,
      runningNow: 0,
      browser: { state: "ready" },
      executors: { claude: "2.1.0", codex: null, claudeLoggedIn: true },
      tools: { git: true },
      runner: "2026.11.24.1",
      protocol: 79,
      logTail: ["started"],
    } as unknown as RunnerReportParts;
    const report = computerReport(
      parts,
      { version: "0.8.18", os: "macos", arch: "aarch64" },
      { ...ABOUT, osVersion: "15.1", memoryBytes: 32 * 2 ** 30, webviewBytes: 182_400_000 },
      [],
      "en",
      NOW,
    );
    expect(report.versions).toMatchObject({ os: "macos", osVersion: "15.1", runner: "2026.11.24.1" });
    expect(report.facts).toMatchObject({
      "runner.agents": 2,
      "desktop.cpus": 8,
      "desktop.memoryGb": 32,
      "desktop.webviewMb": 182,
    });
    expect(report.timings).toEqual({ opening: 6180 });
  });
});
