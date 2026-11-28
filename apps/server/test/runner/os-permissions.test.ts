import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PermissionNeed } from "@agenteschat/adapters/machine-protocol";
import { fullDiskAccess, PermissionNeeds, permissionOfOutput } from "../../runner/os-permissions";

test("a failed command's output names the macOS permission it lacked; elsewhere, or with none, nothing", () => {
  const mac = (text: string) => permissionOfOutput(text, "darwin", () => false);
  expect(mac("ls: Desktop: Operation not permitted")).toBe("disk");
  expect(mac("cp: /Users/sam/Library/Mail/V10: Operation not permitted\n")).toBe("disk");
  expect(mac("rm: /Applications/Notes Helper.app/Contents/Info.plist: Operation not permitted")).toBe("app_management");
  expect(mac("could not create image from display")).toBe("screen");
  expect(mac("execution error: Not authorized to send Apple events to Finder. (-1743)")).toBe("automation");
  expect(mac("System Events got an error: osascript is not allowed assistive access. (-1719)")).toBe("accessibility");
  expect(mac('System Events got an error: Can’t get window 5 of process "Finder". Invalid index. (-1719)')).toBeNull();
  expect(mac("No such file or directory")).toBeNull();
  expect(mac("")).toBeNull();
  expect(permissionOfOutput("ls: Desktop: Operation not permitted", "linux")).toBeNull();
  expect(permissionOfOutput("could not create image from display", "win32")).toBeNull();
  // With Full Disk Access on, EPERM is SIP, another user's process or a file's owner: no permission fixes it.
  const fda = (text: string) => permissionOfOutput(text, "darwin", () => true);
  expect(fda("kill: kill 1 failed: operation not permitted")).toBeNull();
  expect(fda("rm: /usr/bin/zip: Operation not permitted")).toBeNull();
  expect(fda("rm: /Applications/Notes Helper.app/Contents/Info.plist: Operation not permitted")).toBe("app_management");
});

test("Full Disk Access is read as the app reads it: macOS's privacy database opens", () => {
  const home = mkdtempSync(path.join(tmpdir(), "fda-"));
  try {
    const db = path.join(home, "Library/Application Support/com.apple.TCC");
    mkdirSync(db, { recursive: true });
    writeFileSync(path.join(db, "TCC.db"), "");
    expect(fullDiskAccess(home)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("one wait per permission: the first ask names it, each change is told whole, allowed ends it", () => {
  const told: PermissionNeed[][] = [];
  const needs = new PermissionNeeds(
    (n) => told.push(n),
    () => Date.parse("2026-11-26T18:00:00Z"),
  );
  expect(needs.add("disk", "  ls ~/Desktop ", "a1")).toBe(true);
  expect(needs.add("disk", "cat ~/Documents/x", "a2")).toBe(false);
  expect(needs.add("screen", "x".repeat(500))).toBe(true);
  expect(needs.list()).toEqual([
    { permission: "disk", trigger: "ls ~/Desktop", agentId: "a1", since: "2026-11-26T18:00:00.000Z" },
    { permission: "screen", trigger: "x".repeat(200), since: "2026-11-26T18:00:00.000Z" },
  ]);
  expect(needs.clear("disk")).toBe(true);
  expect(needs.clear("disk")).toBe(false);
  expect(told.map((n) => n.map((x) => x.permission))).toEqual([["disk"], ["disk", "screen"], ["screen"]]);
});
